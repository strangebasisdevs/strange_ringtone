from __future__ import annotations

import os
import re
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

import helpers  # noqa: F401  (puts core/ on sys.path)
from strange_ringtone.results import RESULT_ID_RE, Result, ResultStore, StoreFull

TTL = 600


class Clock:
    """A clock that moves only when a test moves it."""

    def __init__(self) -> None:
        self.now = 1000.0
        self._lock = threading.Lock()

    def __call__(self) -> float:
        with self._lock:
            return self.now

    def advance(self, seconds: float) -> None:
        with self._lock:
            self.now += seconds


class StoreTestCase(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.temp = Path(temp.name)
        self.directory = self.temp / "results"
        self.clock = Clock()
        self.store = self.make_store()

    def make_store(self, max_results: int = 3) -> ResultStore:
        store = ResultStore(self.directory, TTL, max_results, clock=self.clock)
        self.addCleanup(store.stop)
        return store

    def source(self, content: bytes = b"tone bytes") -> Path:
        fd, name = tempfile.mkstemp(dir=self.temp, suffix=".m4a")
        os.close(fd)
        path = Path(name)
        path.write_bytes(content)
        return path

    def on_disk(self) -> list[str]:
        return sorted(str(p.relative_to(self.directory)).replace(os.sep, "/") for p in self.directory.rglob("*"))


class PutGetTest(StoreTestCase):
    def test_put_moves_the_file_under_a_random_id(self) -> None:
        source = self.source(b"abc")
        result = self.store.put(source, "My Tone")
        self.assertIsInstance(result, Result)
        self.assertRegex(result.result_id, r"^[0-9a-f]{32}$")
        self.assertEqual(result.name, "My Tone")
        self.assertEqual(result.path, self.directory / result.result_id / "tone.m4a")
        self.assertEqual(result.path.read_bytes(), b"abc")
        self.assertFalse(source.exists())
        self.assertEqual(result.created, self.clock())
        self.assertEqual(self.on_disk(), [result.result_id, f"{result.result_id}/tone.m4a"])

    def test_the_name_is_never_on_disk(self) -> None:
        result = self.store.put(self.source(b"\x00" * 16), "SecretToneName")
        for path in self.directory.rglob("*"):
            self.assertNotIn("SecretToneName", path.name)
            if path.is_file():
                self.assertNotIn(b"SecretToneName", path.read_bytes())
        self.assertEqual(self.store.get(result.result_id), result)

    def test_ids_are_distinct_128_bit_hex(self) -> None:
        ids = set()
        for _ in range(3):
            ids.add(self.store.put(self.source(), "x").result_id)
        self.assertEqual(len(ids), 3)
        for result_id in ids:
            self.assertTrue(RESULT_ID_RE.fullmatch(result_id))
            self.assertEqual(len(bytes.fromhex(result_id)), 16)

    def test_get_refuses_malformed_ids_before_any_lookup(self) -> None:
        result = self.store.put(self.source(), "x")
        good = result.result_id
        for bad in (good.upper(), good[:-1], good + "0", f"../{good}", f"{good}/../{good}", f" {good}",
                    f"{good}\n", f"{good}.m4a", "", "0" * 31, ".." + good[2:], good[:16] + "/" + good[17:]):
            with self.subTest(bad=bad):
                self.assertIsNone(self.store.get(bad))
        self.assertIsNone(self.store.get(None))  # type: ignore[arg-type]

    def test_the_index_is_the_authority_not_the_disk(self) -> None:
        # A directory with a valid-looking ID that put() never made is never served.
        planted = "0123456789abcdef0123456789abcdef"
        (self.directory / planted).mkdir()
        (self.directory / planted / "tone.m4a").write_bytes(b"planted")
        self.assertIsNone(self.store.get(planted))

    def test_unknown_id(self) -> None:
        self.assertIsNone(self.store.get("f" * 32))

    def test_the_id_shape_is_checked_before_the_index(self) -> None:
        # Even an index entry under a malformed key is never reached.
        result = self.store.put(self.source(), "x")
        self.store._results["../" + result.result_id] = result
        self.assertIsNone(self.store.get("../" + result.result_id))

    def test_put_never_reuses_an_existing_directory(self) -> None:
        planted = "0123456789abcdef0123456789abcdef"
        (self.directory / planted).mkdir()
        (self.directory / planted / "tone.m4a").write_bytes(b"planted")
        source = self.source(b"new")
        with mock.patch("secrets.token_hex", return_value=planted):
            with self.assertRaises(FileExistsError):
                self.store.put(source, "x")
        self.assertEqual((self.directory / planted / "tone.m4a").read_bytes(), b"planted")
        self.assertEqual(len(self.store), 0)

    def test_an_id_already_in_the_index_is_drawn_again(self) -> None:
        first = self.store.put(self.source(b"one"), "x")
        other = "f" * 32
        with mock.patch("secrets.token_hex", side_effect=[first.result_id, other]):
            second = self.store.put(self.source(b"two"), "y")
        self.assertEqual(second.result_id, other)
        self.assertEqual(first.path.read_bytes(), b"one")

    def test_a_failed_move_leaves_nothing(self) -> None:
        with self.assertRaises(OSError):
            self.store.put(self.temp / "missing.m4a", "x")
        self.assertEqual(self.on_disk(), [])
        self.assertEqual(len(self.store), 0)

    @unittest.skipUnless(hasattr(os, "getuid"), "POSIX permissions")
    def test_directories_are_owner_only(self) -> None:
        result = self.store.put(self.source(), "x")
        self.assertEqual(self.directory.stat().st_mode & 0o777, 0o700)
        self.assertEqual(result.path.parent.stat().st_mode & 0o777, 0o700)


class CapacityTest(StoreTestCase):
    def test_store_full(self) -> None:
        for _ in range(3):
            self.assertFalse(self.store.is_full())
            self.store.put(self.source(), "x")
        self.assertTrue(self.store.is_full())
        source = self.source()
        with self.assertRaises(StoreFull):
            self.store.put(source, "x")
        # The refused file stays where it was, for the caller to clean up.
        self.assertTrue(source.exists())
        self.assertEqual(len(self.store), 3)
        self.assertEqual(len([p for p in self.directory.iterdir()]), 3)

    def test_expiry_frees_room(self) -> None:
        for _ in range(3):
            self.store.put(self.source(), "x")
        self.clock.advance(TTL)
        # is_full sweeps first, so an expired result never blocks a render.
        self.assertFalse(self.store.is_full())
        self.assertEqual(self.on_disk(), [])
        self.store.put(self.source(), "x")

    def test_put_sweeps_before_it_checks_for_room(self) -> None:
        # The server asks is_full() before the render, but the last result can
        # expire during it: put() itself must not count an expired result.
        store = self.make_store(max_results=1)
        old = store.put(self.source(b"old"), "x")
        self.clock.advance(TTL)
        new = store.put(self.source(b"new"), "y")
        self.assertIsNone(store.get(old.result_id))
        self.assertEqual(store.get(new.result_id), new)
        self.assertEqual(len(store), 1)
        self.assertEqual(self.on_disk(), [new.result_id, f"{new.result_id}/tone.m4a"])

    def test_bad_construction(self) -> None:
        for ttl, cap in ((0, 1), (1, 0)):
            with self.subTest(ttl=ttl, cap=cap), self.assertRaises(ValueError):
                ResultStore(self.temp / "other", ttl, cap)


class SweepTest(StoreTestCase):
    def test_a_failed_deletion_is_retried_and_keeps_its_slot(self) -> None:
        # An expired result whose files cannot be removed (an open download on
        # Windows) must stay indexed: forgetting it would free a capacity slot
        # while its bytes still sit on the tmpfs, and nothing would retry.
        store = self.make_store(max_results=1)
        old = store.put(self.source(b"old"), "x")
        self.clock.advance(TTL)
        with mock.patch("strange_ringtone.results.shutil.rmtree", side_effect=PermissionError("busy")):
            self.assertEqual(store.sweep(), 0)
            self.assertEqual(len(store), 1)
            # is_full() sweeps too, and the retry fails the same way.
            self.assertTrue(store.is_full())
            self.assertIsNone(store.get(old.result_id))
            self.assertEqual(self.on_disk(), [old.result_id, f"{old.result_id}/tone.m4a"])
        # Once the deletion goes through, the entry and the slot go with it.
        self.assertEqual(store.sweep(), 1)
        self.assertEqual(len(store), 0)
        self.assertEqual(self.on_disk(), [])

    def test_results_live_exactly_their_ttl(self) -> None:
        first = self.store.put(self.source(), "a")
        self.clock.advance(100)
        second = self.store.put(self.source(), "b")
        self.clock.advance(TTL - 100 - 0.001)
        self.assertEqual(self.store.sweep(), 0)
        self.assertEqual(self.store.get(first.result_id), first)
        self.clock.advance(0.001)
        # Refused at the TTL even before a sweep has run.
        self.assertIsNone(self.store.get(first.result_id))
        self.assertEqual(self.store.sweep(), 1)
        self.assertFalse(first.path.parent.exists())
        self.assertEqual(self.store.get(second.result_id), second)
        self.clock.advance(100)
        self.assertEqual(self.store.sweep(), 1)
        self.assertEqual(self.on_disk(), [])

    def test_download_does_not_shorten_or_extend_the_ttl(self) -> None:
        result = self.store.put(self.source(), "a")
        for _ in range(5):
            self.assertIsNotNone(self.store.get(result.result_id))
        self.clock.advance(TTL)
        self.assertIsNone(self.store.get(result.result_id))

    def test_clear(self) -> None:
        self.store.put(self.source(), "a")
        (self.directory / "stray").write_bytes(b"x")
        (self.directory / "stray-dir").mkdir()
        self.store.clear()
        self.assertEqual(self.on_disk(), [])
        self.assertEqual(len(self.store), 0)
        self.assertTrue(self.directory.is_dir())

    def test_clear_recreates_a_removed_directory(self) -> None:
        self.directory.rmdir()
        self.store.clear()
        self.assertTrue(self.directory.is_dir())
        self.store.put(self.source(), "a")

    def test_sweeper_thread_sweeps_and_stops(self) -> None:
        result = self.store.put(self.source(), "a")
        self.store.start_sweeper(0.01)
        with self.assertRaises(RuntimeError):
            self.store.start_sweeper(0.01)
        self.clock.advance(TTL)
        deadline = time.monotonic() + 5
        while result.path.parent.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertFalse(result.path.parent.exists())
        threads = [t for t in threading.enumerate() if t.name == "result-sweeper"]
        self.assertTrue(threads)
        self.assertTrue(all(t.daemon for t in threads))
        self.store.stop()
        self.assertFalse(any(t.is_alive() for t in threads))
        # Stopped means stopped: a new result is no longer swept by a thread.
        later = self.store.put(self.source(), "b")
        self.clock.advance(TTL)
        time.sleep(0.05)
        self.assertTrue(later.path.exists())
        # stop() twice is harmless.
        self.store.stop()

    def test_sweeper_survives_a_failing_sweep(self) -> None:
        calls: list[int] = []
        real_sweep = self.store.sweep

        def flaky() -> int:
            calls.append(1)
            if len(calls) == 1:
                raise OSError("transient")
            return real_sweep()

        self.store.sweep = flaky  # type: ignore[method-assign]
        self.store.start_sweeper(0.01)
        deadline = time.monotonic() + 5
        while len(calls) < 3 and time.monotonic() < deadline:
            time.sleep(0.01)
        self.store.stop()
        self.assertGreaterEqual(len(calls), 3)

    def test_sweeper_interval_must_be_positive(self) -> None:
        with self.assertRaises(ValueError):
            self.store.start_sweeper(0)

    def test_result_id_pattern(self) -> None:
        self.assertEqual(RESULT_ID_RE.pattern, r"[0-9a-f]{32}")
        self.assertIsNone(re.fullmatch(RESULT_ID_RE, "A" * 32))


if __name__ == "__main__":
    unittest.main()
