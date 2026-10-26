from __future__ import annotations

import ipaddress
import threading
import time
import unittest

import helpers  # noqa: F401  (puts core/ on sys.path)
from strange_ringtone import http_guard
from strange_ringtone.http_guard import ConcurrencyGate, GuardError, RateLimiter

ORIGIN = "https://ringtones.example.internal"
MAX = 1000


def nets(*cidrs: str) -> tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...]:
    return tuple(ipaddress.ip_network(cidr) for cidr in cidrs)


class FakeClock:
    def __init__(self, now: float = 1000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


class GuardErrorTest(unittest.TestCase):
    def test_attributes(self) -> None:
        error = GuardError(429, "rate_limited", retry_after=7)
        self.assertEqual((error.status, error.code, error.retry_after), (429, "rate_limited", 7))
        self.assertIsNone(GuardError(403, "bad_origin").retry_after)


class SecurityHeadersTest(unittest.TestCase):
    BASE = [
        ("Content-Security-Policy",
         "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; "
         "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"),
        ("X-Content-Type-Options", "nosniff"),
        ("X-Frame-Options", "DENY"),
        ("Referrer-Policy", "same-origin"),
        ("Cross-Origin-Opener-Policy", "same-origin"),
        ("Cross-Origin-Resource-Policy", "same-origin"),
        ("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()"),
    ]
    HSTS = ("Strict-Transport-Security", "max-age=63072000; includeSubDomains")

    def test_csp_is_exact(self) -> None:
        # Written out in full so that loosening any directive (say, adding
        # 'unsafe-inline' or a CDN) fails here.
        self.assertEqual(
            http_guard.CSP,
            "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; "
            "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        )

    def test_https_origin_gets_the_full_set_with_hsts(self) -> None:
        self.assertEqual(sorted(http_guard.security_headers(ORIGIN)), sorted([*self.BASE, self.HSTS]))

    def test_http_origin_gets_the_set_without_hsts(self) -> None:
        self.assertEqual(sorted(http_guard.security_headers("http://ringtones.example.internal")), sorted(self.BASE))

    def test_plan_records_the_exact_hsts_value(self) -> None:
        # HSTS reaches past this app (includeSubDomains, two years), so the
        # value sent must be the one the design record states.
        plan = (helpers.ROOT / "docs" / "PLAN.md").read_text(encoding="utf-8")
        self.assertIn(f"`{self.HSTS[0]}: {self.HSTS[1]}`", plan)

    def test_each_header_appears_once(self) -> None:
        names = [name.lower() for name, _ in http_guard.security_headers(ORIGIN)]
        self.assertEqual(len(names), len(set(names)))


class RequireOriginTest(unittest.TestCase):
    def assert_refused(self, values: list[str]) -> None:
        with self.assertRaises(GuardError) as caught:
            http_guard.require_origin(values, ORIGIN)
        self.assertEqual((caught.exception.status, caught.exception.code), (403, "bad_origin"))

    def test_accepts_exact_origin(self) -> None:
        http_guard.require_origin([ORIGIN], ORIGIN)

    def test_refuses_missing_origin(self) -> None:
        # Fail closed: some clients omit Origin, and a CSRF check that waves
        # those through is no check.
        self.assert_refused([])

    def test_refuses_duplicated_origin(self) -> None:
        # Even two correct copies: a proxy and this server may read different ones.
        self.assert_refused([ORIGIN, ORIGIN])
        self.assert_refused([ORIGIN, "https://evil.example.internal"])
        self.assert_refused(["https://evil.example.internal", ORIGIN])

    def test_refuses_other_origins(self) -> None:
        for value in (
            "https://evil.example.internal",
            "http://ringtones.example.internal",            # different scheme
            "https://ringtones.example.internal:8443",      # different port
            "https://ringtones.example.internal:443",       # never sent by a browser
            "https://ringtones.example.internal/",          # trailing slash
            "HTTPS://RINGTONES.EXAMPLE.INTERNAL",           # case variant
            "https://Ringtones.example.internal",
            "https://ringtones.example.internal.evil.example.internal",  # prefix match
            "https://evil.example.internalhttps://ringtones.example.internal",
            " https://ringtones.example.internal",
            "https://ringtones.example.internal ",
            "null",
            "",
        ):
            with self.subTest(value=value):
                self.assert_refused([value])

    def test_refuses_when_public_origin_is_empty(self) -> None:
        # A misbuilt Settings must not turn "" == "" into an accepted request.
        with self.assertRaises(GuardError):
            http_guard.require_origin([""], "")


class RequireContentTypeTest(unittest.TestCase):
    def test_accepts_exact_type(self) -> None:
        http_guard.require_content_type(["audio/wav"], "audio/wav")
        http_guard.require_content_type([" audio/wav\t"], "audio/wav")

    def test_refuses_other_types(self) -> None:
        # Only audio/wav forces a CORS preflight and is what the browser sends;
        # form types (text/plain, multipart) are exactly what a CSRF page can post.
        for values in (
            [],
            ["audio/wav", "audio/wav"],
            ["audio/wav; codecs=1"],
            ["audio/wav;"],
            ["audio/x-wav"],
            ["audio/wave"],
            ["Audio/WAV"],
            ["audio/mpeg"],
            ["text/plain"],
            ["application/x-www-form-urlencoded"],
            ["multipart/form-data; boundary=x"],
            ["application/json"],
            ["audio/wav\xa0"],
            ["audio/wav,audio/wav"],
            [""],
        ):
            with self.subTest(values=values), self.assertRaises(GuardError) as caught:
                http_guard.require_content_type(values, "audio/wav")
            self.assertEqual((caught.exception.status, caught.exception.code), (415, "unsupported_media_type"))


class BodyLengthTest(unittest.TestCase):
    def assert_refused(self, lengths: list[str], encodings: list[str], status: int, code: str) -> None:
        with self.assertRaises(GuardError) as caught:
            http_guard.body_length(lengths, encodings, MAX)
        self.assertEqual((caught.exception.status, caught.exception.code), (status, code))

    def test_accepts_lengths_up_to_the_limit(self) -> None:
        for value, expected in (("0", 0), ("1", 1), ("999", 999), (str(MAX), MAX), ("0000500", 500)):
            with self.subTest(value=value):
                self.assertEqual(http_guard.body_length([value], [], MAX), expected)

    def test_refuses_transfer_encoding(self) -> None:
        # Smuggling: TE and CL together let a proxy and this server disagree on
        # where the body ends. Any TE is refused, even one that looks harmless.
        for encodings in (["chunked"], ["identity"], [""], ["chunked", "chunked"]):
            with self.subTest(encodings=encodings):
                self.assert_refused(["10"], encodings, 400, "transfer_encoding")
        self.assert_refused([], ["chunked"], 400, "transfer_encoding")

    def test_refuses_missing_length(self) -> None:
        # Without a length the size cap can't apply before reading.
        self.assert_refused([], [], 411, "length_required")

    def test_refuses_several_lengths(self) -> None:
        self.assert_refused(["10", "10"], [], 400, "bad_length")
        self.assert_refused(["10", "20"], [], 400, "bad_length")

    def test_refuses_malformed_lengths(self) -> None:
        # int() accepts several of these; a proxy might read them differently.
        for value in ("+5", "-1", " 5", "5 ", "0x5", "5.0", "1_0", "1e3", "10,10", "", "five", "٥", "５", "5\n"):
            with self.subTest(value=value):
                self.assert_refused([value], [], 400, "bad_length")

    def test_refuses_oversized_bodies(self) -> None:
        for value in (str(MAX + 1), "9" * 50, "1" + "0" * 10_000):
            with self.subTest(value=value[:20]):
                self.assert_refused([value], [], 413, "too_large")


class ClientAddressTest(unittest.TestCase):
    PROXY = nets("192.0.2.0/24", "2001:db8:1::/48")

    def test_untrusted_peer_ignores_forwarded_for(self) -> None:
        # Spoofing: a direct client may write any X-Forwarded-For it likes.
        self.assertEqual(http_guard.client_address("198.51.100.9", ["203.0.113.5"], self.PROXY), "198.51.100.9")
        self.assertEqual(http_guard.client_address("198.51.100.9", ["203.0.113.5"], ()), "198.51.100.9")

    def test_no_trusted_proxies_means_the_peer(self) -> None:
        self.assertEqual(http_guard.client_address("192.0.2.10", ["203.0.113.5"], ()), "192.0.2.10")

    def test_trusted_peer_uses_the_rightmost_untrusted_hop(self) -> None:
        # The client wrote '10.9.9.9' itself; the proxy appended the real address.
        self.assertEqual(http_guard.client_address("192.0.2.10", ["10.9.9.9, 203.0.113.5"], self.PROXY),
                         "203.0.113.5")

    def test_chain_of_trusted_proxies_is_skipped(self) -> None:
        self.assertEqual(
            http_guard.client_address("192.0.2.10", ["10.9.9.9, 203.0.113.5, 192.0.2.20, 192.0.2.30"], self.PROXY),
            "203.0.113.5",
        )

    def test_several_headers_are_concatenated_in_order(self) -> None:
        self.assertEqual(
            http_guard.client_address("192.0.2.10", ["10.9.9.9", "203.0.113.5, 192.0.2.20"], self.PROXY),
            "203.0.113.5",
        )
        self.assertEqual(http_guard.client_address("192.0.2.10", ["203.0.113.5", "198.51.100.1"], self.PROXY),
                         "198.51.100.1")

    def test_earlier_header_is_read_when_the_later_holds_only_trusted_hops(self) -> None:
        # The client is only in the first header: reading the last header alone
        # would find nothing but proxies and fall back to the peer.
        self.assertEqual(
            http_guard.client_address("192.0.2.10", ["198.51.100.7", "192.0.2.20, 192.0.2.30"], self.PROXY),
            "198.51.100.7",
        )

    def test_missing_or_empty_header_falls_back_to_the_peer(self) -> None:
        for values in ([], [""], [" "], [","], [", ,"]):
            with self.subTest(values=values):
                self.assertEqual(http_guard.client_address("192.0.2.10", values, self.PROXY), "192.0.2.10")

    def test_garbage_ends_the_walk_at_the_peer(self) -> None:
        # An untrusted hop right of the garbage is still the client; otherwise
        # the peer is, never a trusted hop and never anything left of the garbage.
        cases = {
            "203.0.113.5, unknown": "192.0.2.10",
            "unknown, 203.0.113.5": "203.0.113.5",
            "203.0.113.5, unknown, 192.0.2.20": "192.0.2.10",
            "203.0.113.5, 300.1.1.1": "192.0.2.10",
            "203.0.113.5, 192.0.2.20:abc": "192.0.2.10",
            "203.0.113.5, [2001:db8::1": "192.0.2.10",
            "203.0.113.5, [2001:db8::1]x": "192.0.2.10",
            "203.0.113.5, [2001:db8::1]:": "192.0.2.10",
            "203.0.113.5, 192.0.2.20:": "192.0.2.10",
            "203.0.113.5,,192.0.2.20": "192.0.2.10",
            "203.0.113.5; 192.0.2.20": "192.0.2.10",
            "\x00": "192.0.2.10",
            "203.0.113.5‮": "192.0.2.10",
        }
        for header, expected in cases.items():
            with self.subTest(header=header):
                self.assertEqual(http_guard.client_address("192.0.2.10", [header], self.PROXY), expected)

    def test_all_trusted_hops_means_the_peer(self) -> None:
        self.assertEqual(http_guard.client_address("192.0.2.10", ["192.0.2.30, 192.0.2.20"], self.PROXY),
                         "192.0.2.10")

    def test_ports_and_bracketed_ipv6(self) -> None:
        cases = {
            "203.0.113.5:4711": "203.0.113.5",
            "[2001:db8:2::5]:4711": "2001:db8:2::5",
            "[2001:db8:2::5]": "2001:db8:2::5",
            "2001:db8:2::5": "2001:db8:2::5",
            "2001:DB8:2:0:0:0:0:5": "2001:db8:2::5",
            "203.0.113.5, [2001:db8:1::7]:443": "203.0.113.5",
        }
        for header, expected in cases.items():
            with self.subTest(header=header):
                self.assertEqual(http_guard.client_address("192.0.2.10", [header], self.PROXY), expected)

    def test_ipv6_peer_behind_trusted_proxy(self) -> None:
        self.assertEqual(http_guard.client_address("2001:db8:1::2", ["203.0.113.5"], self.PROXY), "203.0.113.5")
        self.assertEqual(http_guard.client_address("2001:db8:9::2", ["203.0.113.5"], self.PROXY), "2001:db8:9::2")

    def test_ipv4_mapped_addresses_are_unwrapped(self) -> None:
        # One client must have one rate-limit key, whichever notation it arrives in.
        self.assertEqual(http_guard.client_address("::ffff:198.51.100.9", [], self.PROXY), "198.51.100.9")
        # A mapped peer inside a trusted IPv4 network is trusted too.
        self.assertEqual(http_guard.client_address("::ffff:192.0.2.10", ["203.0.113.5"], self.PROXY), "203.0.113.5")
        self.assertEqual(http_guard.client_address("192.0.2.10", ["[::ffff:203.0.113.5]:1"], self.PROXY),
                         "203.0.113.5")

    def test_addresses_are_canonical(self) -> None:
        self.assertEqual(http_guard.client_address("2001:DB8:9:0::2", [], ()), "2001:db8:9::2")

    def test_unparsable_peer_is_returned_unchanged(self) -> None:
        self.assertEqual(http_guard.client_address("not-an-ip", ["203.0.113.5"], nets("0.0.0.0/0")), "not-an-ip")


class RateLimiterTest(unittest.TestCase):
    def test_allows_up_to_the_limit_then_refuses(self) -> None:
        clock = FakeClock()
        limiter = RateLimiter(3, clock=clock)
        for _ in range(3):
            self.assertEqual(limiter.allow("a"), (True, 0))
            clock.now += 1
        allowed, retry = limiter.allow("a")
        self.assertFalse(allowed)
        # The oldest call was at 1000 and leaves the window at 1060; now is 1003.
        self.assertEqual(retry, 57)

    def test_keys_are_independent(self) -> None:
        limiter = RateLimiter(1, clock=FakeClock())
        self.assertTrue(limiter.allow("a")[0])
        self.assertFalse(limiter.allow("a")[0])
        self.assertTrue(limiter.allow("b")[0])

    def test_window_slides(self) -> None:
        clock = FakeClock()
        limiter = RateLimiter(2, clock=clock)
        limiter.allow("a")            # t=1000
        clock.now = 1030
        limiter.allow("a")            # t=1030
        clock.now = 1059.5
        self.assertEqual(limiter.allow("a"), (False, 1))
        clock.now = 1060              # the first call has left the window
        self.assertEqual(limiter.allow("a"), (True, 0))
        clock.now = 1089
        self.assertEqual(limiter.allow("a"), (False, 1))
        clock.now = 1090
        self.assertEqual(limiter.allow("a"), (True, 0))

    def test_refused_calls_are_not_counted(self) -> None:
        # Otherwise a client hammering the endpoint would lock itself out forever,
        # and its key would grow without bound.
        clock = FakeClock()
        limiter = RateLimiter(1, clock=clock)
        limiter.allow("a")
        for _ in range(100):
            clock.now += 0.5
            limiter.allow("a")
        clock.now = 1060
        self.assertEqual(limiter.allow("a"), (True, 0))

    def test_retry_after_is_at_least_one_and_rounds_up(self) -> None:
        clock = FakeClock()
        limiter = RateLimiter(1, clock=clock)
        limiter.allow("a")
        clock.now = 1059.99
        self.assertEqual(limiter.allow("a"), (False, 1))
        clock.now = 1000.2
        self.assertEqual(limiter.allow("a"), (False, 60))

    def test_idle_keys_are_pruned(self) -> None:
        # Memory stays bounded: many one-off clients must not pile up.
        clock = FakeClock()
        limiter = RateLimiter(5, clock=clock)
        for index in range(100):
            limiter.allow(f"client-{index}")
        self.assertEqual(len(limiter), 100)
        clock.now += 60
        limiter.allow("someone-else")
        self.assertEqual(len(limiter), 1)

    def test_rejects_a_zero_limit(self) -> None:
        with self.assertRaises(ValueError):
            RateLimiter(0)

    def test_is_thread_safe(self) -> None:
        limiter = RateLimiter(50, clock=FakeClock())
        results: list[bool] = []
        lock = threading.Lock()

        def hammer() -> None:
            for _ in range(20):
                allowed, _retry = limiter.allow("shared")
                with lock:
                    results.append(allowed)

        threads = [threading.Thread(target=hammer) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(results.count(True), 50)
        self.assertEqual(len(results), 160)

    def test_check_and_count_happen_under_one_lock(self) -> None:
        # The race the lock prevents sits between "is there room?" and "count
        # this call", which the GIL alone rarely splits. `len(stamps) < limit`
        # calls the subclass's reflected __gt__ first, so this limit hands the
        # GIL to the other threads right inside that window.
        class SlowLimit(int):
            def __gt__(self, other: int) -> bool:
                time.sleep(0.01)
                return int.__gt__(self, other)

        limiter = RateLimiter(SlowLimit(3), clock=FakeClock())
        barrier = threading.Barrier(8)
        results: list[bool] = []

        def call() -> None:
            barrier.wait(5)
            results.append(limiter.allow("shared")[0])

        threads = [threading.Thread(target=call) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(results.count(True), 3)
        self.assertEqual(len(results), 8)

    def test_has_room_answers_like_allow_without_counting(self) -> None:
        # The server asks before the concurrency gate and counts only after
        # it, so a 503 busy never uses up a client's renders.
        clock = FakeClock()
        limiter = RateLimiter(1, clock=clock)
        for _ in range(3):
            self.assertEqual(limiter.has_room("a"), (True, 0))
        # Asking adds no key, so it can't grow the table either.
        self.assertEqual(len(limiter), 0)
        self.assertEqual(limiter.allow("a"), (True, 0))
        clock.now += 10
        self.assertEqual(limiter.has_room("a"), (False, 50))
        self.assertEqual(limiter.allow("a"), (False, 50))
        self.assertEqual(limiter.has_room("b"), (True, 0))


class ConcurrencyGateTest(unittest.TestCase):
    def test_acquire_up_to_the_limit(self) -> None:
        gate = ConcurrencyGate(2)
        self.assertTrue(gate.acquire())
        self.assertTrue(gate.acquire())
        self.assertFalse(gate.acquire())
        gate.release()
        self.assertTrue(gate.acquire())

    def test_acquire_does_not_block(self) -> None:
        gate = ConcurrencyGate(1)
        gate.acquire()
        done = threading.Event()

        def try_acquire() -> None:
            gate.acquire()
            done.set()

        thread = threading.Thread(target=try_acquire, daemon=True)
        thread.start()
        self.assertTrue(done.wait(5), "acquire() blocked instead of refusing")
        thread.join()

    def test_slot_refuses_when_full(self) -> None:
        gate = ConcurrencyGate(1)
        with gate.slot():
            with self.assertRaises(GuardError) as caught, gate.slot():
                self.fail("a second slot was granted")
            error = caught.exception
            self.assertEqual((error.status, error.code, error.retry_after), (503, "busy", 1))
        # The refused attempt did not consume or release anything.
        with gate.slot():
            self.assertFalse(gate.acquire())

    def test_slot_releases_on_error(self) -> None:
        gate = ConcurrencyGate(1)
        with self.assertRaises(RuntimeError), gate.slot():
            raise RuntimeError("render failed")
        self.assertTrue(gate.acquire())

    def test_extra_release_is_an_error(self) -> None:
        # A stray release must not silently raise the cap.
        gate = ConcurrencyGate(1)
        with self.assertRaises(ValueError):
            gate.release()

    def test_rejects_a_zero_limit(self) -> None:
        with self.assertRaises(ValueError):
            ConcurrencyGate(0)


if __name__ == "__main__":
    unittest.main()
