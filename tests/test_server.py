from __future__ import annotations

import contextlib
import http.client
import io
import ipaddress
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from collections.abc import Callable
from pathlib import Path
from typing import Any
from unittest import mock

import helpers  # noqa: F401  (puts core/ on sys.path)
from strange_ringtone import __main__ as entry
from strange_ringtone import config, static
from strange_ringtone import server as server_module
from strange_ringtone.config import Settings
from strange_ringtone.http_guard import GuardError
from strange_ringtone.server import CHUNK_BYTES, Handler, RingtoneServer

ORIGIN = "https://example.internal"
DEADLINE = 5.0

# Written out rather than taken from http_guard, so that dropping or loosening a
# header there fails here too.
SECURITY_HEADERS = [
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
HSTS = "max-age=63072000; includeSubDomains"
LOG_LINE_RE = re.compile(r"[!-~]+ [!-~]+ (?:[0-9]{3}|-) [0-9]+\.[0-9]{3}")


class LogCapture(io.TextIOBase):
    """A stderr stand-in that handler threads can write to concurrently."""

    def __init__(self) -> None:
        super().__init__()
        self._lock = threading.Lock()
        self._parts: list[str] = []

    def write(self, text: str) -> int:
        with self._lock:
            self._parts.append(text)
        return len(text)

    def getvalue(self) -> str:
        with self._lock:
            return "".join(self._parts)

    def lines(self) -> list[str]:
        return self.getvalue().splitlines()


class Response:
    def __init__(self, status: int, headers: http.client.HTTPMessage, body: bytes) -> None:
        self.status = status
        self.headers = headers
        self.body = body

    def json(self) -> Any:
        return json.loads(self.body.decode("utf-8"))


def exchange(port: int, data: bytes, half_close: bool = False, tolerate_reset: bool = False) -> Response | None:
    """Send raw bytes on a fresh loopback connection and parse the reply."""
    method = data.split(b" ", 1)[0].decode("latin-1")
    with socket.create_connection(("127.0.0.1", port), timeout=DEADLINE) as sock:
        sock.sendall(data)
        if half_close:
            sock.shutdown(socket.SHUT_WR)
        response = http.client.HTTPResponse(sock, method=method)
        try:
            response.begin()
            body = response.read()
        except (ConnectionResetError, ConnectionAbortedError, http.client.RemoteDisconnected):
            if tolerate_reset:
                return None
            raise
        finally:
            response.close()
    return Response(response.status, response.headers, body)


def build_request(method: str, path: str, headers: list[tuple[str, str]] | None = None, body: bytes = b"") -> bytes:
    lines = [f"{method} {path} HTTP/1.1", "Host: example.internal"]
    lines += [f"{name}: {value}" for name, value in headers or []]
    return ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1") + body


def wait_for(predicate: Callable[[], bool], what: str) -> None:
    deadline = time.monotonic() + DEADLINE
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out waiting for {what}")
        time.sleep(0.01)


class _TestServer(RingtoneServer):
    # Join the handler threads on close, so no handler is still writing to the
    # scratch directory when the temporary directory is removed.
    block_on_close = True


class _CappedServer(_TestServer):
    MAX_WORKERS = 2


class ServerTestCase(unittest.TestCase):
    server_class: type[RingtoneServer] = _TestServer

    def setUp(self) -> None:
        self.log = LogCapture()
        redirect = contextlib.redirect_stderr(self.log)
        redirect.__enter__()
        self.addCleanup(redirect.__exit__, None, None, None)
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.temp = Path(temp.name)
        # A subdirectory that doesn't exist yet: the server must create it.
        self.scratch = self.temp / "scratch"
        self.start()

    # --- fixtures ---------------------------------------------------------------

    def start(self, render_hook: Callable[[Path, Handler], None] | None = None, **overrides: Any) -> None:
        values: dict[str, Any] = {
            "public_origin": ORIGIN,
            # One second keeps MAX_BODY_BYTES (196096) small enough to send whole.
            "max_clip_seconds": 1,
            # High, so only the rate-limit tests ever meet the limit.
            "rate_limit_renders_per_minute": 1000,
            "scratch_dir": self.scratch,
        }
        values.update(overrides)
        self.settings = Settings(**values)
        self.server = self.server_class(("127.0.0.1", 0), self.settings, render_hook)
        thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        thread.start()
        self.addCleanup(self._stop, self.server, thread)
        self.port = self.server.server_address[1]

    @staticmethod
    def _stop(server: RingtoneServer, thread: threading.Thread) -> None:
        server.shutdown()
        server.server_close()
        thread.join(DEADLINE)

    def request(self, method: str, path: str, headers: list[tuple[str, str]] | None = None,
                body: bytes = b"", **options: Any) -> Response:
        response = exchange(self.port, build_request(method, path, headers, body), **options)
        assert response is not None
        return response

    def render_headers(self, length: int) -> list[tuple[str, str]]:
        return [("Origin", ORIGIN), ("Content-Type", "audio/wav"), ("Content-Length", str(length))]

    def post_render(self, headers: list[tuple[str, str]], body: bytes = b"", path: str = "/api/render") -> Response:
        return self.request("POST", path, headers, body)

    def wait_for_log(self, prefix: str, count: int = 1) -> list[str]:
        def found() -> bool:
            return len([line for line in self.log.lines() if line.startswith(prefix)]) >= count

        wait_for(found, f"a log line starting {prefix!r}")
        return [line for line in self.log.lines() if line.startswith(prefix)]

    def log_has(self, prefix: str) -> bool:
        return any(line.startswith(prefix) for line in self.log.lines())

    # --- assertions ---------------------------------------------------------------

    def assertScratchEmpty(self) -> None:
        # Cleanup runs after the response is written, so give it a moment.
        def empty() -> bool:
            return not any(self.scratch.iterdir())

        try:
            wait_for(empty, "an empty scratch directory")
        except AssertionError:
            pass
        self.assertEqual(sorted(p.name for p in self.scratch.iterdir()), [])

    def assertSecurityHeaders(self, response: Response, hsts: bool = True) -> None:
        for name, value in SECURITY_HEADERS:
            self.assertEqual(response.headers.get_all(name), [value], name)
        if hsts:
            self.assertEqual(response.headers.get_all("Strict-Transport-Security"), [HSTS])
        else:
            self.assertIsNone(response.headers.get_all("Strict-Transport-Security"))
        self.assertEqual(response.headers.get_all("Server"), ["strange_ringtone"])
        self.assertEqual(response.headers.get_all("Connection"), ["close"])
        self.assertEqual(response.headers.get_all("Content-Length"), [str(len(response.body))])
        self.assertFalse([name for name in response.headers if name.lower().startswith("access-control-")])

    def assertJsonError(self, response: Response, status: int, code: str) -> None:
        self.assertEqual(response.status, status, response.body)
        self.assertEqual(response.headers.get("Content-Type"), "application/json")
        self.assertEqual(response.headers.get("Cache-Control"), "no-store")
        self.assertEqual(response.json(), {"error": code})
        self.assertSecurityHeaders(response, hsts=self.settings.public_origin.startswith("https://"))


class HeadersTest(ServerTestCase):
    def test_every_kind_of_response_carries_the_header_set(self) -> None:
        cases: list[tuple[str, bytes, bool]] = [
            ("index", build_request("GET", "/"), False),
            ("static", build_request("GET", "/static/dev/app.js"), False),
            ("healthz", build_request("GET", "/healthz"), False),
            ("404", build_request("GET", "/nope"), False),
            ("405", build_request("POST", "/"), False),
            ("403", build_request("POST", "/api/render", [("Content-Length", "0")]), False),
            ("501 render", build_request("POST", "/api/render", self.render_headers(0)), False),
            ("400 bad request line", b"GET / HTTP/1.0 extra\r\n", True),
            ("400 HTTP/0.9", b"GET /\r\n", True),
            ("405 unknown verb", b"BREW / HTTP/1.0\r\n\r\n", False),
            # Exactly 65537 bytes: the stdlib reads that much, finds no line end,
            # and answers 414 with nothing left unread on the socket.
            ("414", b"GET /" + b"a" * (65537 - 5), False),
        ]
        for label, data, half_close in cases:
            with self.subTest(label):
                response = exchange(self.port, data, half_close=half_close)
                assert response is not None
                self.assertSecurityHeaders(response)

    def test_http_origin_gets_no_hsts(self) -> None:
        self.start(public_origin="http://example.internal")
        for path in ("/", "/healthz", "/nope"):
            with self.subTest(path):
                self.assertSecurityHeaders(self.request("GET", path), hsts=False)

    def test_stdlib_errors_are_json(self) -> None:
        cases = [
            ("bad request line", b"GET / HTTP/1.0 extra\r\n", 400),
            ("HTTP/0.9", b"GET /\r\n", 400),
            ("request line too long", b"GET /" + b"a" * (65537 - 5), 414),
        ]
        for label, data, status in cases:
            with self.subTest(label):
                response = exchange(self.port, data, half_close=True)
                assert response is not None
                self.assertJsonError(response, status, f"http_{status}")
                self.assertNotIn(b"<", response.body)
        self.assertScratchEmpty()

    def test_errors_sent_while_the_version_still_says_0_9_carry_headers(self) -> None:
        # Older stdlib releases call send_error with request_version still at
        # its HTTP/0.9 default, for which http.server writes no headers at all.
        def parse_as_old_stdlib(handler: Handler) -> bool:
            handler.request_version = "HTTP/0.9"
            handler.send_error(400)
            return False

        with mock.patch.object(Handler, "parse_request", parse_as_old_stdlib):
            response = exchange(self.port, b"GET / HTTP/1.0 extra\r\n", half_close=True)
        assert response is not None
        self.assertJsonError(response, 400, "http_400")

    def test_responses_are_http_1_0_and_close(self) -> None:
        with socket.create_connection(("127.0.0.1", self.port), timeout=DEADLINE) as sock:
            sock.sendall(build_request("GET", "/healthz"))
            data = b""
            while chunk := sock.recv(65536):
                data += chunk
        self.assertTrue(data.startswith(b"HTTP/1.0 200 "))


class HealthzTest(ServerTestCase):
    def test_empty_200(self) -> None:
        response = self.request("GET", "/healthz")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.body, b"")
        self.assertEqual(response.headers.get("Content-Length"), "0")
        self.assertEqual(response.headers.get("Cache-Control"), "no-store")
        self.assertIsNone(response.headers.get("Content-Type"))

    def test_query_is_ignored(self) -> None:
        self.assertEqual(self.request("GET", "/healthz?verbose=1").status, 200)

    def test_other_methods(self) -> None:
        response = self.request("POST", "/healthz", [("Content-Length", "0")])
        self.assertJsonError(response, 405, "method_not_allowed")
        self.assertEqual(response.headers.get("Allow"), "GET")


class IndexTest(ServerTestCase):
    def page(self) -> str:
        response = self.request("GET", "/")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers.get("Content-Type"), "text/html; charset=utf-8")
        self.assertEqual(response.headers.get("Cache-Control"), "no-store")
        return response.body.decode("utf-8")

    def test_configuration_in_data_attributes(self) -> None:
        self.start(max_clip_seconds=30, default_target_lufs=-9.5, fetch_enabled=True, version="1.2.3",
                   source_url="https://example.internal/source")
        page = self.page()
        self.assertIn(
            '<main id="app" data-max-clip-seconds="30" data-default-target-lufs="-9.5" data-fetch-enabled="true" '
            'data-source-url="https://example.internal/source" data-version="1.2.3" '
            'data-static-prefix="/static/1.2.3">',
            page,
        )
        self.assertIn('<link rel="stylesheet" href="/static/1.2.3/style.css">', page)
        self.assertIn('<script type="module" src="/static/1.2.3/app.js"></script>', page)
        self.assertIn('<a href="https://example.internal/source">Source</a>', page)
        self.assertNotIn("{{", page)

    def test_defaults(self) -> None:
        page = self.page()
        self.assertIn('data-max-clip-seconds="1"', page)
        self.assertIn('data-default-target-lufs="-14.0"', page)
        self.assertIn('data-fetch-enabled="false"', page)
        self.assertIn('data-version="dev"', page)

    def test_values_are_escaped(self) -> None:
        self.start(source_url='https://example.internal/"<x>')
        page = self.page()
        escaped = "https://example.internal/&quot;&lt;x&gt;"
        self.assertIn(f'data-source-url="{escaped}"', page)
        self.assertIn(f'<a href="{escaped}">Source</a>', page)
        self.assertNotIn('"<x>', page)
        self.assertNotIn("<x>", page)

    def test_no_inline_script_or_style(self) -> None:
        # The CSP would block them anyway (style-src 'self' also blocks style
        # attributes); this keeps the page from silently relying on them.
        page = self.page()
        for tag in re.findall(r"<script\b[^>]*>", page):
            self.assertIn(" src=", tag)
        self.assertNotIn("<style", page)
        self.assertNotIn(" style=", page)
        self.assertIsNone(re.search(r"\son[a-z]+\s*=", page))

    def test_page_basics(self) -> None:
        page = self.page()
        self.assertTrue(page.startswith("<!doctype html>"))
        self.assertIn('<html lang="en">', page)
        self.assertIn('<meta name="viewport" content="width=device-width, initial-scale=1">', page)
        self.assertIn("<footer>", page)
        self.assertIn("Version dev", page)

    def test_template_is_never_served_raw(self) -> None:
        for path in ("/index.html", "/static/dev/index.html"):
            with self.subTest(path):
                self.assertJsonError(self.request("GET", path), 404, "not_found")

    def test_unknown_placeholder_fails_startup(self) -> None:
        copy = self.temp / "static"
        shutil.copytree(static.STATIC_DIR, copy)
        (copy / "index.html").write_text("<p>{{nope}}</p>", encoding="utf-8")
        with mock.patch.object(static, "STATIC_DIR", copy):
            with self.assertRaisesRegex(ValueError, "nope"):
                RingtoneServer(("127.0.0.1", 0), self.settings)

    def test_missing_file_fails_startup(self) -> None:
        copy = self.temp / "static"
        shutil.copytree(static.STATIC_DIR, copy)
        (copy / "app.js").unlink()
        with self.assertRaises(FileNotFoundError):
            static.StaticFiles(copy)


class StaticTest(ServerTestCase):
    def test_assets(self) -> None:
        for name, content_type in (("app.js", "text/javascript; charset=utf-8"),
                                   ("style.css", "text/css; charset=utf-8")):
            with self.subTest(name):
                response = self.request("GET", f"/static/dev/{name}")
                self.assertEqual(response.status, 200)
                self.assertEqual(response.headers.get("Content-Type"), content_type)
                self.assertEqual(response.headers.get("Cache-Control"), "public, max-age=31536000, immutable")
                self.assertEqual(response.body, (static.STATIC_DIR / name).read_bytes())

    def test_query_is_ignored(self) -> None:
        self.assertEqual(self.request("GET", "/static/dev/app.js?v=2").status, 200)

    def test_path_tricks_are_not_found(self) -> None:
        paths = [
            "/static/dev/../dev/app.js",
            "/static/dev/./app.js",
            "/static/dev/%2e%2e/dev/app.js",
            "/static/dev/%61pp.js",
            "/static/dev%2Fapp.js",
            "/static/dev%2fapp.js",
            "/static/dev/app%2Ejs",
            "/static/dev\\app.js",
            "/static\\dev\\app.js",
            "/static/dev//app.js",
            "/static/dev/app.js/",
            "/static/dev/app.js%00",
            "/static/dev/app.js.map",
            "/static/DEV/app.js",
            "/static/dev/APP.JS",
            "/static/dev/App.js",
            "/STATIC/dev/app.js",
            "/static/dev/",
            "/static/dev",
            "/static/",
            "/static/app.js",
            "/static/0.0.1/app.js",
            "/static/dev/app.js;x",
            "/core/static/app.js",
            "/strange_ringtone/server.py",
            "http://example.internal/static/dev/app.js",
            "*",
            # The stdlib collapses leading slashes and splits the request line on
            # any whitespace, so these reach the handler as "/static/dev/app.js".
            "//static/dev/app.js",
            "///static/dev/app.js",
            "/static/dev/app.js",
            "/static/dev/app.js ",
            "/static/dev/app.js",
        ]
        for path in paths:
            with self.subTest(path):
                self.assertJsonError(self.request("GET", path), 404, "not_found")
        self.assertScratchEmpty()

    def test_only_the_current_version(self) -> None:
        self.start(version="1.2.3")
        self.assertEqual(self.request("GET", "/static/1.2.3/app.js").status, 200)
        self.assertJsonError(self.request("GET", "/static/dev/app.js"), 404, "not_found")
        self.assertJsonError(self.request("GET", "/static/1.2.4/app.js"), 404, "not_found")

    def test_nothing_is_read_from_disk_at_request_time(self) -> None:
        copy = self.temp / "static"
        shutil.copytree(static.STATIC_DIR, copy)
        originals = {name: (copy / name).read_bytes() for name in static.ALLOWED}
        with mock.patch.object(static, "STATIC_DIR", copy):
            self.start()
        shutil.rmtree(copy)
        self.assertEqual(self.request("GET", "/static/dev/app.js").body, originals["app.js"])
        self.assertEqual(self.request("GET", "/static/dev/style.css").body, originals["style.css"])
        self.assertEqual(self.request("GET", "/").status, 200)

    def test_get_never_returns_the_template_or_unlisted_names(self) -> None:
        files = static.StaticFiles()
        self.assertIsNone(files.get("index.html"))
        self.assertIsNone(files.get("nope.js"))
        self.assertIsNone(files.get("../static/app.js"))
        self.assertIsNotNone(files.get("app.js"))

    def test_routing_never_trusts_a_rewritten_or_double_slash_target(self) -> None:
        # Called directly, so the "//" refusal is pinned even on a stdlib that
        # no longer collapses leading slashes before the handler sees them.
        def route(requestline: str, path: str) -> str | None:
            return Handler._route_path(mock.Mock(requestline=requestline, path=path))

        self.assertEqual(route("GET /static/dev/app.js HTTP/1.1", "/static/dev/app.js"), "/static/dev/app.js")
        self.assertIsNone(route("GET //static/dev/app.js HTTP/1.1", "//static/dev/app.js"))
        self.assertIsNone(route("GET //static/dev/app.js HTTP/1.1", "/static/dev/app.js"))
        self.assertIsNone(route("GET /static/dev/app.js\x0b HTTP/1.1", "/static/dev/app.js"))
        self.assertIsNone(route("GET  /static/dev/app.js HTTP/1.1", "/static/dev/app.js"))


class MethodTest(ServerTestCase):
    def test_wrong_method_on_known_paths(self) -> None:
        cases = [
            ("POST", "/", "GET"),
            ("POST", "/static/dev/app.js", "GET"),
            ("GET", "/api/render", "POST"),
            ("PUT", "/api/render", "POST"),
            ("DELETE", "/api/render", "POST"),
            ("PATCH", "/api/render", "POST"),
            ("OPTIONS", "/api/render", "POST"),
            ("OPTIONS", "/", "GET"),
            # Methods with no handler of their own, which the stdlib answers 501.
            ("TRACE", "/api/render", "POST"),
            ("CONNECT", "/api/render", "POST"),
            ("BREW", "/api/render", "POST"),
            ("get", "/api/render", "POST"),
            ("post", "/api/render", "POST"),
            ("BREW", "/", "GET"),
            ("TRACE", "/static/dev/app.js", "GET"),
        ]
        for method, path, allow in cases:
            with self.subTest(f"{method} {path}"):
                response = self.request(method, path, [("Content-Length", "0")])
                self.assertJsonError(response, 405, "method_not_allowed")
                self.assertEqual(response.headers.get("Allow"), allow)
        self.assertScratchEmpty()

    def test_preflight_is_never_approved(self) -> None:
        response = self.request("OPTIONS", "/api/render", [
            ("Origin", "https://other.example.internal"),
            ("Access-Control-Request-Method", "POST"),
            ("Access-Control-Request-Headers", "content-type"),
        ])
        self.assertJsonError(response, 405, "method_not_allowed")

    def test_head_has_no_body(self) -> None:
        with socket.create_connection(("127.0.0.1", self.port), timeout=DEADLINE) as sock:
            sock.sendall(build_request("HEAD", "/healthz"))
            data = b""
            while chunk := sock.recv(65536):
                data += chunk
        head, _, rest = data.partition(b"\r\n\r\n")
        self.assertTrue(head.startswith(b"HTTP/1.0 405 "))
        self.assertIn(b"\r\nAllow: GET", head)
        self.assertEqual(rest, b"")

    def test_unknown_paths(self) -> None:
        for method in ("GET", "POST", "PUT", "OPTIONS", "TRACE", "BREW"):
            with self.subTest(method):
                self.assertJsonError(self.request(method, "/api/nope", [("Content-Length", "0")]), 404, "not_found")
        self.assertScratchEmpty()


class RenderHook:
    """Records what a render hook saw, then answers 200 (or whatever it's told)."""

    def __init__(self, action: Callable[[Path, Handler], None] | None = None) -> None:
        self.calls: list[tuple[Path, list[str], bytes, bool]] = []
        self.action = action

    def __call__(self, job_dir: Path, handler: Handler) -> None:
        names = sorted(p.name for p in job_dir.iterdir())
        data = (job_dir / "in.wav").read_bytes()
        self.calls.append((job_dir, names, data, job_dir.parent == handler.server.settings.scratch_dir))
        if self.action is not None:
            self.action(job_dir, handler)
        else:
            handler.send_json(200, {"ok": True})


class OriginTest(ServerTestCase):
    BAD = [
        ("missing", []),
        ("duplicated", [ORIGIN, ORIGIN]),
        ("duplicated, one wrong", [ORIGIN, "https://other.example.internal"]),
        ("http scheme", ["http://example.internal"]),
        ("other host", ["https://other.example.internal"]),
        ("subdomain trick", ["https://example.internal.other.example"]),
        ("explicit port", ["https://example.internal:443"]),
        ("other port", ["https://example.internal:8443"]),
        ("trailing slash", ["https://example.internal/"]),
        ("upper-case host", ["https://Example.internal"]),
        ("upper-case scheme", ["HTTPS://example.internal"]),
        ("null", ["null"]),
        ("empty", [""]),
    ]

    def test_bad_origins_are_refused(self) -> None:
        hook = RenderHook()
        self.start(render_hook=hook)
        for label, origins in self.BAD:
            with self.subTest(label):
                headers = [("Origin", value) for value in origins]
                headers += [("Content-Type", "audio/wav"), ("Content-Length", "4")]
                # No body is sent: a refused request is answered before reading it.
                self.assertJsonError(self.post_render(headers), 403, "bad_origin")
                self.assertScratchEmpty()
        self.assertEqual(hook.calls, [])

    def test_exact_origin_passes(self) -> None:
        response = self.post_render(self.render_headers(4), b"RIFF")
        self.assertJsonError(response, 501, "render_unavailable")
        self.assertScratchEmpty()


class ContentTypeTest(ServerTestCase):
    def test_anything_but_audio_wav_is_refused(self) -> None:
        cases = [
            ("missing", []),
            ("duplicated", ["audio/wav", "audio/wav"]),
            ("x-wav", ["audio/x-wav"]),
            ("wave", ["audio/wave"]),
            ("parameter", ["audio/wav; codecs=1"]),
            ("upper case", ["AUDIO/WAV"]),
            ("form", ["application/x-www-form-urlencoded"]),
            ("plain text", ["text/plain"]),
            ("multipart", ["multipart/form-data; boundary=x"]),
            ("octet stream", ["application/octet-stream"]),
            ("json", ["application/json"]),
        ]
        for label, types in cases:
            with self.subTest(label):
                headers = [("Origin", ORIGIN)] + [("Content-Type", value) for value in types]
                headers.append(("Content-Length", "4"))
                self.assertJsonError(self.post_render(headers), 415, "unsupported_media_type")
                self.assertScratchEmpty()


class LengthTest(ServerTestCase):
    def base(self) -> list[tuple[str, str]]:
        return [("Origin", ORIGIN), ("Content-Type", "audio/wav")]

    def test_transfer_encoding_is_refused(self) -> None:
        for label, extra in (("chunked", [("Transfer-Encoding", "chunked")]),
                             ("chunked and length", [("Transfer-Encoding", "chunked"), ("Content-Length", "4")]),
                             ("identity", [("Transfer-Encoding", "identity"), ("Content-Length", "4")])):
            with self.subTest(label):
                self.assertJsonError(self.post_render(self.base() + extra), 400, "transfer_encoding")
                self.assertScratchEmpty()

    def test_missing_length(self) -> None:
        self.assertJsonError(self.post_render(self.base()), 411, "length_required")
        self.assertScratchEmpty()

    def test_malformed_lengths(self) -> None:
        for value in ("+4", "-1", "0x4", "4.0", "4,4", "4 ", "four", "²", "4_0"):
            with self.subTest(value):
                self.assertJsonError(self.post_render(self.base() + [("Content-Length", value)]), 400, "bad_length")
                self.assertScratchEmpty()
        duplicated = self.base() + [("Content-Length", "4"), ("Content-Length", "4")]
        self.assertJsonError(self.post_render(duplicated), 400, "bad_length")
        self.assertScratchEmpty()

    def test_too_large(self) -> None:
        # Only the headers are sent: the refusal must come before any body read.
        for value in (str(self.settings.max_body_bytes + 1), "9" * 40):
            with self.subTest(value):
                self.assertJsonError(self.post_render(self.base() + [("Content-Length", value)]), 413, "too_large")
                self.assertScratchEmpty()

    def test_exactly_the_limit_is_accepted(self) -> None:
        hook = RenderHook()
        self.start(render_hook=hook)
        size = self.settings.max_body_bytes
        self.assertEqual(size, 1 * 48000 * 2 * 2 + 4096)
        body = bytes(range(256)) * (size // 256) + b"x" * (size % 256)
        response = self.post_render(self.render_headers(size), body)
        self.assertEqual(response.status, 200)
        self.assertEqual(hook.calls[0][2], body)
        self.wait_for_log("POST /api/render 200")
        self.assertScratchEmpty()


class CheckOrderTest(ServerTestCase):
    def test_path_before_origin(self) -> None:
        self.assertJsonError(self.post_render([("Content-Length", "4")], path="/api/nope"), 404, "not_found")

    def test_aliases_of_the_render_path_are_not_found(self) -> None:
        hook = RenderHook()
        self.start(render_hook=hook)
        for path in ("//api/render", "/api/render", "/api/render "):
            with self.subTest(path):
                self.assertJsonError(self.post_render(self.render_headers(4), b"RIFF", path=path), 404, "not_found")
        self.assertEqual(hook.calls, [])
        self.assertScratchEmpty()

    def test_origin_before_content_type_and_length(self) -> None:
        headers = [("Origin", "https://other.example.internal"), ("Content-Type", "text/plain"),
                   ("Transfer-Encoding", "chunked")]
        self.assertJsonError(self.post_render(headers), 403, "bad_origin")

    def test_content_type_before_length(self) -> None:
        headers = [("Origin", ORIGIN), ("Content-Type", "text/plain"), ("Transfer-Encoding", "chunked")]
        self.assertJsonError(self.post_render(headers), 415, "unsupported_media_type")

    def test_length_checks_before_rate_limit(self) -> None:
        self.start(rate_limit_renders_per_minute=1)
        self.assertJsonError(self.post_render(self.render_headers(4), b"RIFF"), 501, "render_unavailable")
        refusals = [
            ([("Content-Type", "audio/wav"), ("Content-Length", "4")], 403),
            ([("Origin", ORIGIN), ("Content-Type", "text/plain"), ("Content-Length", "4")], 415),
            ([("Origin", ORIGIN), ("Content-Type", "audio/wav"), ("Transfer-Encoding", "chunked")], 400),
            ([("Origin", ORIGIN), ("Content-Type", "audio/wav")], 411),
            ([("Origin", ORIGIN), ("Content-Type", "audio/wav"), ("Content-Length", "99999999")], 413),
        ]
        for headers, status in refusals:
            with self.subTest(status):
                self.assertEqual(self.post_render(headers).status, status)
        self.assertJsonError(self.post_render(self.render_headers(4)), 429, "rate_limited")
        self.assertScratchEmpty()

    def test_refused_requests_do_not_use_up_the_rate_limit(self) -> None:
        self.start(rate_limit_renders_per_minute=1)
        for _ in range(3):
            self.assertEqual(self.post_render([("Content-Length", "4")]).status, 403)
        self.assertJsonError(self.post_render(self.render_headers(4), b"RIFF"), 501, "render_unavailable")
        self.assertScratchEmpty()


class RateLimitTest(ServerTestCase):
    def test_limit_per_client(self) -> None:
        self.start(rate_limit_renders_per_minute=2)
        for _ in range(2):
            self.assertJsonError(self.post_render(self.render_headers(4), b"RIFF"), 501, "render_unavailable")
        response = self.post_render(self.render_headers(4))
        self.assertJsonError(response, 429, "rate_limited")
        retry_after = response.headers.get("Retry-After")
        assert retry_after is not None
        self.assertRegex(retry_after, r"^[0-9]+$")
        self.assertTrue(1 <= int(retry_after) <= 60)
        self.assertScratchEmpty()

    def test_forwarded_for_is_ignored_from_untrusted_peers(self) -> None:
        self.start(rate_limit_renders_per_minute=1)
        first = self.render_headers(4) + [("X-Forwarded-For", "192.0.2.1")]
        second = self.render_headers(4) + [("X-Forwarded-For", "192.0.2.2")]
        self.assertEqual(self.post_render(first, b"RIFF").status, 501)
        # Same socket peer, so the same client whatever the header claims.
        self.assertJsonError(self.post_render(second), 429, "rate_limited")
        self.assertScratchEmpty()

    def test_forwarded_for_is_honoured_from_trusted_proxies(self) -> None:
        self.start(rate_limit_renders_per_minute=1, trusted_proxies=(ipaddress.ip_network("127.0.0.0/8"),))
        first = self.render_headers(4) + [("X-Forwarded-For", "192.0.2.1")]
        second = self.render_headers(4) + [("X-Forwarded-For", "198.51.100.7, 192.0.2.2")]
        self.assertEqual(self.post_render(first, b"RIFF").status, 501)
        self.assertEqual(self.post_render(second, b"RIFF").status, 501)
        # 192.0.2.1 again, now behind a client-written hop on the left.
        again = self.render_headers(4) + [("X-Forwarded-For", "203.0.113.9, 192.0.2.1")]
        self.assertJsonError(self.post_render(again), 429, "rate_limited")
        # Garbage falls back to the peer, which has its own budget.
        garbage = self.render_headers(4) + [("X-Forwarded-For", "not-an-address")]
        self.assertEqual(self.post_render(garbage, b"RIFF").status, 501)
        self.assertEqual(self.post_render(garbage).status, 429)
        self.assertScratchEmpty()


class GateTest(ServerTestCase):
    def test_busy_when_renders_are_in_flight(self) -> None:
        entered = threading.Event()
        release = threading.Event()

        def block(job_dir: Path, handler: Handler) -> None:
            entered.set()
            release.wait(DEADLINE)
            handler.send_json(200, {"ok": True})

        hook = RenderHook(block)
        self.start(render_hook=hook, render_concurrency=1)
        results: list[Response] = []
        first = threading.Thread(target=lambda: results.append(self.post_render(self.render_headers(4), b"RIFF")))
        first.start()
        try:
            self.assertTrue(entered.wait(DEADLINE))
            response = self.post_render(self.render_headers(4), b"RIFF")
            self.assertJsonError(response, 503, "busy")
            self.assertEqual(response.headers.get("Retry-After"), "1")
        finally:
            release.set()
            first.join(DEADLINE)
        self.assertEqual(results[0].status, 200)
        self.assertEqual(len(hook.calls), 1)
        # The slot is free again.
        release.set()
        self.assertEqual(self.post_render(self.render_headers(4), b"RIFF").status, 200)
        self.wait_for_log("POST /api/render 200", count=2)
        self.assertScratchEmpty()

    def test_slot_is_released_after_a_failed_hook(self) -> None:
        def fail(job_dir: Path, handler: Handler) -> None:
            raise RuntimeError("boom")

        hook = RenderHook(fail)
        self.start(render_hook=hook, render_concurrency=1)
        for _ in range(3):
            self.assertJsonError(self.post_render(self.render_headers(4), b"RIFF"), 500, "internal_error")
        self.assertEqual(len(hook.calls), 3)
        self.wait_for_log("POST /api/render 500", count=3)
        self.assertScratchEmpty()

    def test_slot_and_job_directory_are_free_before_the_client_sees_the_answer(self) -> None:
        # A slow cleanup widens the window between the answer and the release
        # of the slot. A client that sends its next request as soon as it has
        # read an answer must never find its own render still holding the slot.
        real_rmtree = shutil.rmtree

        def slow_rmtree(*args: Any, **kwargs: Any) -> None:
            time.sleep(0.2)
            real_rmtree(*args, **kwargs)

        def fail(job_dir: Path, handler: Handler) -> None:
            raise RuntimeError("boom")

        for label, action, status in (("answered", None, 200), ("failed", fail, 500)):
            with self.subTest(label):
                hook = RenderHook(action)
                self.start(render_hook=hook, render_concurrency=1)
                with mock.patch("shutil.rmtree", slow_rmtree):
                    for _ in range(3):
                        response = self.post_render(self.render_headers(4), b"RIFF")
                        self.assertEqual(response.status, status, response.body)
                        self.assertFalse(hook.calls[-1][0].exists())
                self.assertEqual(len(hook.calls), 3)
                self.assertScratchEmpty()

    def test_a_hook_that_fails_halfway_still_gets_a_clean_500(self) -> None:
        def fail_halfway(job_dir: Path, handler: Handler) -> None:
            handler.send_response(200)
            handler.send_header("Content-Type", "audio/mp4")
            raise RuntimeError("boom")

        self.start(render_hook=RenderHook(fail_halfway))
        self.assertJsonError(self.post_render(self.render_headers(4), b"RIFF"), 500, "internal_error")
        self.assertScratchEmpty()


class BodyTest(ServerTestCase):
    def test_default_hook_answers_501(self) -> None:
        response = self.post_render(self.render_headers(4), b"RIFF")
        self.assertJsonError(response, 501, "render_unavailable")
        self.assertEqual(response.body, b'{"error": "render_unavailable"}')
        self.wait_for_log("POST /api/render 501")
        self.assertScratchEmpty()

    def test_hook_gets_in_wav_with_the_exact_bytes(self) -> None:
        hook = RenderHook()
        self.start(render_hook=hook)
        # Several chunks' worth, so the streaming loop runs more than once.
        body = os.urandom(150_000)
        headers = self.render_headers(len(body)) + [("X-Tone-Name", "../../escape")]
        response = self.post_render(headers, body)
        self.assertEqual(response.status, 200)
        self.assertEqual(response.json(), {"ok": True})
        job_dir, names, data, under_scratch = hook.calls[0]
        self.assertEqual(names, ["in.wav"])
        self.assertEqual(data, body)
        self.assertTrue(under_scratch)
        self.assertTrue(job_dir.name.startswith("job-"))
        self.wait_for_log("POST /api/render 200")
        self.assertFalse(job_dir.exists())
        self.assertScratchEmpty()
        self.assertEqual(sorted(p.name for p in self.temp.iterdir()), ["scratch"])

    def test_job_directory_is_removed_when_the_hook_raises(self) -> None:
        def fail(job_dir: Path, handler: Handler) -> None:
            raise RuntimeError("SecretToneName")

        hook = RenderHook(fail)
        self.start(render_hook=hook)
        response = self.post_render(self.render_headers(4), b"RIFF")
        self.assertJsonError(response, 500, "internal_error")
        self.wait_for_log("POST /api/render 500")
        self.assertEqual(len(hook.calls), 1)
        self.assertFalse(hook.calls[0][0].exists())
        self.assertScratchEmpty()
        self.assertNotIn("SecretToneName", self.log.getvalue())
        self.assertNotIn("Traceback", self.log.getvalue())

    def test_hook_guard_errors_pass_through(self) -> None:
        def refuse(job_dir: Path, handler: Handler) -> None:
            raise GuardError(422, "bad_wav")

        self.start(render_hook=RenderHook(refuse))
        self.assertJsonError(self.post_render(self.render_headers(4), b"RIFF"), 422, "bad_wav")
        self.wait_for_log("POST /api/render 422")
        self.assertScratchEmpty()

    def test_body_shorter_than_length_client_closes(self) -> None:
        hook = RenderHook()
        self.start(render_hook=hook)
        with socket.create_connection(("127.0.0.1", self.port), timeout=DEADLINE) as sock:
            sock.sendall(build_request("POST", "/api/render", self.render_headers(1000), b"x" * 10))
        # The client is gone, so there is no reply to read; the log line is
        # written after the cleanup has run.
        self.wait_for_log("POST /api/render 400")
        self.assertEqual(hook.calls, [])
        self.assertScratchEmpty()

    def test_body_shorter_than_length_client_waits(self) -> None:
        hook = RenderHook()
        self.start(render_hook=hook)
        data = build_request("POST", "/api/render", self.render_headers(1000), b"x" * 10)
        response = exchange(self.port, data, half_close=True)
        assert response is not None
        self.assertJsonError(response, 400, "incomplete_body")
        self.assertEqual(hook.calls, [])
        self.wait_for_log("POST /api/render 400")
        self.assertScratchEmpty()

    def test_body_is_streamed_in_bounded_reads(self) -> None:
        reads: list[int] = []
        original_setup = Handler.setup

        class ReadSpy:
            def __init__(self, inner: Any) -> None:
                self._inner = inner

            def read(self, size: int = -1) -> bytes:
                reads.append(size)
                return self._inner.read(size)

            def read1(self, size: int = -1) -> bytes:
                reads.append(size)
                return self._inner.read1(size)

            def __getattr__(self, name: str) -> Any:
                return getattr(self._inner, name)

        def spying_setup(handler: Handler) -> None:
            original_setup(handler)
            handler.rfile = ReadSpy(handler.rfile)

        hook = RenderHook()
        with mock.patch.object(Handler, "setup", spying_setup):
            self.start(render_hook=hook, max_clip_seconds=2)
            body = os.urandom(3 * CHUNK_BYTES + 123)
            response = self.post_render(self.render_headers(len(body)), body)
        self.assertEqual(response.status, 200, response.body)
        self.assertEqual(hook.calls[0][2], body)
        # Never the whole body at once, and never more than one chunk per read.
        self.assertGreaterEqual(len(reads), 4)
        self.assertTrue(all(0 < size <= CHUNK_BYTES for size in reads), reads)
        self.wait_for_log("POST /api/render 200")
        self.assertScratchEmpty()

    def test_handler_has_a_finite_socket_timeout(self) -> None:
        # At this layer the socket timeout is the only thing that ends a
        # stalled body read; test_stalled_body_times_out patches it shorter.
        self.assertIsNotNone(Handler.timeout)
        self.assertGreater(Handler.timeout, 0)
        self.assertLessEqual(Handler.timeout, 60)

    def test_stalled_body_times_out(self) -> None:
        hook = RenderHook()
        with mock.patch.object(Handler, "timeout", 0.3):
            self.start(render_hook=hook)
            with socket.create_connection(("127.0.0.1", self.port), timeout=DEADLINE) as sock:
                sock.sendall(build_request("POST", "/api/render", self.render_headers(1000), b"x" * 10))
                self.wait_for_log("POST /api/render 400")
        self.assertEqual(hook.calls, [])
        self.assertScratchEmpty()

    def test_body_has_a_finite_overall_deadline(self) -> None:
        self.assertGreater(server_module.BODY_DEADLINE_SECONDS, 0)
        self.assertLessEqual(server_module.BODY_DEADLINE_SECONDS, 120)

    def test_trickled_body_loses_its_slot_at_the_deadline(self) -> None:
        # One byte at a time, each well inside the 30 s socket timeout: without
        # an overall deadline this one request holds the only render slot for
        # as long as the client keeps trickling.
        hook = RenderHook()
        with mock.patch.object(server_module, "BODY_DEADLINE_SECONDS", 0.5):
            self.start(render_hook=hook, render_concurrency=1)
            with socket.create_connection(("127.0.0.1", self.port), timeout=DEADLINE) as sock:
                started = time.monotonic()
                sock.sendall(build_request("POST", "/api/render", self.render_headers(1000), b"x"))
                # The client keeps trickling for 4 s, far past the deadline, so
                # only the deadline can end this read early.
                give_up = started + 4
                while time.monotonic() < give_up and not self.log_has("POST /api/render 408"):
                    try:
                        sock.sendall(b"x")
                    except OSError:
                        break
                    time.sleep(0.05)
                self.wait_for_log("POST /api/render 408")
                self.assertLess(time.monotonic() - started, 0.5 + 1.5)
            # The slot is free again for everyone else.
            self.assertEqual(self.post_render(self.render_headers(4), b"RIFF").status, 200)
        self.assertEqual(len(hook.calls), 1)
        self.wait_for_log("POST /api/render 200")
        self.assertScratchEmpty()

    def test_body_deadline_is_checked_before_every_read(self) -> None:
        # Driven by a fake clock, so the order of checks is exact: each read
        # takes 30 s, and the third read would start at the 60 s deadline.
        now = [0.0]
        timeouts: list[float] = []
        reads: list[int] = []

        class Clock:
            @staticmethod
            def monotonic() -> float:
                return now[0]

        class Connection:
            @staticmethod
            def settimeout(value: float) -> None:
                timeouts.append(value)

        class Body:
            @staticmethod
            def read1(size: int) -> bytes:
                reads.append(size)
                now[0] += 30
                return b"x"

            @staticmethod
            def read(size: int = -1) -> bytes:
                # read() loops until it has size bytes, so a trickle of bytes
                # could keep one call alive past the deadline.
                raise AssertionError("read() instead of read1()")

        handler = Handler.__new__(Handler)
        handler.connection = Connection()  # type: ignore[assignment]
        handler.rfile = Body()  # type: ignore[assignment]
        with (
            tempfile.TemporaryDirectory() as temp,
            mock.patch.object(server_module, "time", Clock),
            mock.patch.object(server_module, "BODY_DEADLINE_SECONDS", 60),
        ):
            failure = handler._receive_body(Path(temp) / "in.wav", 1000)
            self.assertEqual(len(list(Path(temp).iterdir())), 1)
        assert failure is not None
        self.assertEqual((failure.status, failure.code), (408, "body_timeout"))
        self.assertEqual(reads, [1000, 999])
        # Every wait was positive and within the deadline, and the per-write
        # timeout is back for the answer.
        self.assertEqual(timeouts, [30, 30, Handler.timeout])

    def test_body_deadline_answers_408(self) -> None:
        hook = RenderHook()
        with mock.patch.object(server_module, "BODY_DEADLINE_SECONDS", 0.3):
            self.start(render_hook=hook)
            data = build_request("POST", "/api/render", self.render_headers(1000), b"x" * 10)
            # The client stops sending but keeps its side open to read the answer.
            response = exchange(self.port, data)
        assert response is not None
        self.assertJsonError(response, 408, "body_timeout")
        self.assertEqual(hook.calls, [])
        self.assertScratchEmpty()

    def test_body_longer_than_length(self) -> None:
        hook = RenderHook()
        self.start(render_hook=hook)
        body = b"a" * 100
        data = build_request("POST", "/api/render", self.render_headers(100), body + b"b" * 50)
        response = exchange(self.port, data, tolerate_reset=True)
        if response is not None:
            self.assertEqual(response.status, 200)
        self.wait_for_log("POST /api/render 200")
        self.assertEqual(hook.calls[0][2], body)
        self.assertScratchEmpty()


class ScratchTest(ServerTestCase):
    def test_startup_creates_and_empties_the_scratch_directory(self) -> None:
        self.assertTrue(self.scratch.is_dir())
        (self.scratch / "stale.wav").write_bytes(b"old")
        (self.scratch / "job-old").mkdir()
        (self.scratch / "job-old" / "in.wav").write_bytes(b"old")
        self.start()
        self.assertScratchEmpty()

    def test_scratch_directory_removed_while_running_answers_500(self) -> None:
        # Not recreated: whatever removed it could have left something in its
        # place, and the checks that make it safe run only at startup.
        hook = RenderHook()
        self.start(render_hook=hook, render_concurrency=1)
        shutil.rmtree(self.scratch)
        for _ in range(2):
            response = self.post_render(self.render_headers(4), b"RIFF")
            self.assertJsonError(response, 500, "internal_error")
        self.assertEqual(hook.calls, [])
        self.assertFalse(self.scratch.exists())
        self.wait_for_log("POST /api/render 500", count=2)
        self.assertNotIn("error while handling a request", self.log.getvalue())
        # The render slot was given back each time.
        self.scratch.mkdir()
        self.assertEqual(self.post_render(self.render_headers(4), b"RIFF").status, 200)
        self.wait_for_log("POST /api/render 200")
        self.assertScratchEmpty()

    def test_missing_parent_is_refused_not_created(self) -> None:
        # Without the /tmp tmpfs the core must not create /tmp on the root
        # filesystem and write uploads there.
        parent = self.temp / "no-tmpfs"
        with self.assertRaisesRegex(RuntimeError, "cannot create the scratch directory"):
            RingtoneServer(("127.0.0.1", 0), Settings(public_origin=ORIGIN, scratch_dir=parent / "scratch"))
        self.assertFalse(parent.exists())

    @unittest.skipUnless(hasattr(os, "getuid"), "POSIX permissions")
    def test_scratch_directory_is_owner_only(self) -> None:
        self.assertEqual(self.scratch.stat().st_mode & 0o777, 0o700)

    @unittest.skipUnless(hasattr(os, "getuid"), "POSIX permissions")
    def test_an_existing_scratch_directory_is_made_owner_only(self) -> None:
        # Created by someone else's umask, or loosened later: startup tightens it.
        os.chmod(self.scratch, 0o777)
        self.start()
        self.assertEqual(self.scratch.stat().st_mode & 0o777, 0o700)

    @unittest.skipUnless(hasattr(os, "getuid"), "POSIX ownership")
    def test_scratch_directory_owned_by_another_user_is_refused(self) -> None:
        other = os.lstat(self.scratch).st_uid + 1
        with mock.patch("os.getuid", return_value=other):
            with self.assertRaisesRegex(RuntimeError, "owned by another user"):
                RingtoneServer(("127.0.0.1", 0), self.settings)

    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks")
    def test_symlinked_scratch_directory_is_refused(self) -> None:
        target = self.temp / "elsewhere"
        target.mkdir()
        link = self.temp / "link"
        try:
            link.symlink_to(target, target_is_directory=True)
        except OSError:
            # Windows allows symlinks only with Developer Mode or elevation.
            self.skipTest("cannot create a symlink here")
        with self.assertRaisesRegex(RuntimeError, "not a plain directory"):
            RingtoneServer(("127.0.0.1", 0), Settings(public_origin=ORIGIN, scratch_dir=link))
        self.assertEqual(list(target.iterdir()), [])


class WorkerCapTest(ServerTestCase):
    server_class = _CappedServer

    def test_connections_past_the_cap_get_503(self) -> None:
        idle = [socket.create_connection(("127.0.0.1", self.port), timeout=DEADLINE) for _ in range(2)]
        try:
            # Accepted in order, so these two hold both workers while they send nothing.
            response = exchange(self.port, b"")
            assert response is not None
            self.assertJsonError(response, 503, "busy")
            self.assertEqual(response.headers.get("Retry-After"), "1")
        finally:
            for sock in idle:
                sock.close()

        def healthy() -> bool:
            response = exchange(self.port, build_request("GET", "/healthz"))
            return response is not None and response.status == 200

        wait_for(healthy, "the workers to be released")


class LogTest(ServerTestCase):
    def test_line_format_without_query_or_headers(self) -> None:
        response = self.request("GET", "/healthz?tone=SecretQuery", [("X-Tone-Name", "SecretHeader")])
        self.assertEqual(response.status, 200)
        line = self.wait_for_log("GET /healthz ")[0]
        self.assertRegex(line, r"^GET /healthz 200 [0-9]+\.[0-9]{3}$")
        self.assertNotIn("Secret", self.log.getvalue())

    def test_duration_is_measured(self) -> None:
        # A fake clock in the server module only: each reading is 1.25 s
        # after the last, so the one request reads it exactly twice.
        readings = iter(100.0 + 1.25 * n for n in range(1000))

        class Clock:
            @staticmethod
            def monotonic() -> float:
                return next(readings)

        with mock.patch.object(server_module, "time", Clock):
            self.assertEqual(self.request("GET", "/healthz").status, 200)
            line = self.wait_for_log("GET /healthz ")[0]
        self.assertEqual(line, "GET /healthz 200 1.250")

    def test_fragment_is_not_logged(self) -> None:
        response = self.request("GET", "/healthz#SecretFragment")
        self.assertEqual(response.status, 200)
        self.assertEqual(self.wait_for_log("GET /")[0].rsplit(" ", 1)[0], "GET /healthz 200")
        self.assertNotIn("Secret", self.log.getvalue())

    def test_a_connection_without_a_request_logs_nothing(self) -> None:
        socket.create_connection(("127.0.0.1", self.port), timeout=DEADLINE).close()
        self.assertEqual(self.request("GET", "/healthz").status, 200)
        # Stopping joins every handler thread, so the empty connection's
        # handler has finished, and logged whatever it was going to.
        self.server.shutdown()
        self.server.server_close()
        self.assertEqual([line.rsplit(" ", 1)[0] for line in self.log.lines()], ["GET /healthz 200"])

    def test_render_request_logs_nothing_private(self) -> None:
        headers = self.render_headers(10) + [("X-Tone-Name", "SecretHeader"), ("User-Agent", "SecretAgent")]
        response = self.post_render(headers, b"SecretBody")
        self.assertEqual(response.status, 501)
        self.request("POST", "/api/render?name=SecretQuery&fade_in=1", [("Content-Length", "0")])
        lines = self.wait_for_log("POST /api/render ", count=2)
        # Each line is written after its response, so their order can vary.
        self.assertEqual(sorted(line.rsplit(" ", 1)[0] for line in lines),
                         ["POST /api/render 403", "POST /api/render 501"])
        for line in lines:
            self.assertRegex(line, r"^POST /api/render [0-9]{3} [0-9]+\.[0-9]{3}$")
        log = self.log.getvalue()
        self.assertNotIn("Secret", log)
        self.assertNotIn("127.0.0.1", log)
        for line in self.log.lines():
            self.assertRegex(line, LOG_LINE_RE)

    def test_control_characters_and_long_paths(self) -> None:
        self.request("GET", "/x\x1b[31mred")
        self.request("GET", "/" + "a" * 5000)
        lines = self.wait_for_log("GET /", count=2)
        self.assertNotIn("\x1b", self.log.getvalue())
        self.assertTrue(any(line.startswith("GET /x_[31mred 404 ") for line in lines))
        long_line = next(line for line in lines if line.startswith("GET /aaa"))
        self.assertEqual(long_line.split(" ")[1], "/" + "a" * 199)

    def test_unexpected_errors_log_one_line_without_a_traceback(self) -> None:
        def explode(handler: Handler) -> None:
            raise RuntimeError("SecretDetail")

        with mock.patch.object(Handler, "do_GET", explode):
            self.assertIsNone(exchange(self.port, build_request("GET", "/"), tolerate_reset=True))
            wait_for(lambda: "error while handling a request" in self.log.getvalue(), "the error line")
        self.assertIn("error while handling a request: RuntimeError\n", self.log.getvalue())
        self.assertNotIn("Traceback", self.log.getvalue())
        self.assertNotIn("SecretDetail", self.log.getvalue())

    def test_stdlib_errors_log_one_line_without_the_request_line(self) -> None:
        exchange(self.port, b"GET /?SecretQuery HTTP/1.0 extra\r\n", half_close=True)
        line = self.wait_for_log("- ")[0]
        self.assertRegex(line, r"^- - 400 [0-9]+\.[0-9]{3}$")
        self.assertNotIn("Secret", self.log.getvalue())

    def test_refused_methods_log_one_line_without_the_query(self) -> None:
        exchange(self.port, b"BREW /?SecretQuery HTTP/1.0\r\n\r\n")
        line = self.wait_for_log("BREW ")[0]
        self.assertRegex(line, r"^BREW / 405 [0-9]+\.[0-9]{3}$")
        self.assertNotIn("Secret", self.log.getvalue())


class MainTest(unittest.TestCase):
    CONTRACT = ("PUBLIC_ORIGIN", "TRUSTED_PROXIES", "MAX_CLIP_SECONDS", "DEFAULT_TARGET_LUFS",
                "RENDER_TIMEOUT_SECONDS", "RENDER_CONCURRENCY", "RATE_LIMIT_RENDERS_PER_MINUTE",
                "RESULT_TTL_SECONDS", "MAX_RESULTS", "FETCH_ENABLED", "SOURCE_URL", "VERSION")

    def run_main(self, **variables: str) -> subprocess.CompletedProcess[str]:
        # Keep the rest of the environment: Windows needs SYSTEMROOT to start Python.
        env = {name: value for name, value in os.environ.items() if name not in self.CONTRACT}
        env.update(variables)
        # The documented command, -I included: an exit code of 2 shows that the
        # package was found and main() ran. Every case here is a configuration
        # that must refuse to start, so the server never binds. --bind keeps it
        # on loopback if one ever didn't.
        return subprocess.run(
            [sys.executable, "-I", str(helpers.CORE), "--bind", "127.0.0.1"],
            cwd=helpers.ROOT, env=env, capture_output=True, text=True, timeout=60,
        )

    def test_docs_name_the_command_run_here(self) -> None:
        # Under -I a checkout can't run `python -I -m strange_ringtone` (see
        # core/__main__.py), so the README and the plan must name the form
        # that these tests run, or a reader follows a command that never starts.
        readme = (helpers.ROOT / "README.md").read_text(encoding="utf-8")
        plan = (helpers.ROOT / "docs" / "PLAN.md").read_text(encoding="utf-8")
        self.assertIn("python -I core --bind 127.0.0.1", readme)
        self.assertIn("python -I core [--bind HOST]", plan)

    def test_missing_public_origin_refuses_to_start(self) -> None:
        result = self.run_main()
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("PUBLIC_ORIGIN", result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_invalid_public_origin_refuses_to_start(self) -> None:
        result = self.run_main(PUBLIC_ORIGIN="not an origin")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("PUBLIC_ORIGIN", result.stderr)

    def test_invalid_optional_setting_refuses_to_start(self) -> None:
        result = self.run_main(PUBLIC_ORIGIN=ORIGIN, MAX_CLIP_SECONDS="41")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("MAX_CLIP_SECONDS", result.stderr)


class EntryPointTest(unittest.TestCase):
    """main() up to the point where it would serve, with RingtoneServer replaced."""

    def setUp(self) -> None:
        previous = signal.getsignal(signal.SIGTERM)
        self.addCleanup(signal.signal, signal.SIGTERM, previous)
        self.addresses: list[tuple[str, int]] = []
        self.error: BaseException | None = None
        test = self

        class FakeServer:
            def __init__(self, address: tuple[str, int], settings: Settings) -> None:
                test.addresses.append(address)
                if test.error is not None:
                    raise test.error

            def serve_forever(self) -> None:
                pass

            def server_close(self) -> None:
                pass

        env = {name: value for name, value in os.environ.items() if name not in MainTest.CONTRACT}
        env["PUBLIC_ORIGIN"] = ORIGIN
        for patcher in (mock.patch.dict(os.environ, env, clear=True),
                        mock.patch.object(entry, "RingtoneServer", FakeServer)):
            patcher.start()
            self.addCleanup(patcher.stop)

    def run_main(self, argv: list[str]) -> tuple[int, str]:
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            try:
                code = entry.main(argv)
            except SystemExit as exit_:
                code = exit_.code if isinstance(exit_.code, int) else 1
        return code, stderr.getvalue()

    def test_contract_port(self) -> None:
        # Part of the deployment contract: changing it is a breaking change.
        self.assertEqual(entry.PORT, 8080)

    def test_default_bind_is_all_addresses_on_8080(self) -> None:
        # The container passes no --bind. Only the address tuple is checked;
        # nothing is bound.
        code, _ = self.run_main([])
        self.assertEqual(code, 0)
        self.assertEqual(self.addresses, [("0.0.0.0", 8080)])

    def test_bind_takes_ip_literals(self) -> None:
        for value, expected in (("127.0.0.1", "127.0.0.1"), ("::1", "::1"), ("0:0::1", "::1")):
            with self.subTest(value=value):
                self.addresses.clear()
                code, _ = self.run_main(["--bind", value])
                self.assertEqual(code, 0)
                self.assertEqual(self.addresses, [(expected, 8080)])

    def test_bind_refuses_host_names_before_any_lookup(self) -> None:
        # A host name would reach getaddrinfo, a DNS query the core never makes.
        with mock.patch("socket.getaddrinfo", side_effect=AssertionError("getaddrinfo called")):
            for value in ("localhost", "nonexistent.example.invalid", "127.0.0.1 ", "fe80::1%eth0", "", "1"):
                with self.subTest(value=value):
                    code, stderr = self.run_main(["--bind", value])
                    self.assertEqual(code, 2)
                    self.assertIn("--bind", stderr)
                    self.assertNotIn("Traceback", stderr)
        self.assertEqual(self.addresses, [])

    def test_startup_failures_refuse_cleanly(self) -> None:
        # The scratch checks raise RuntimeError, a busy port OSError and a
        # broken page template ValueError: each is one line and exit code 1.
        for error in (RuntimeError("scratch directory is owned by another user"),
                      OSError("address in use"), ValueError("bad template")):
            with self.subTest(error=type(error).__name__):
                self.error = error
                code, stderr = self.run_main(["--bind", "127.0.0.1"])
                self.assertEqual(code, 1)
                self.assertIn("strange_ringtone: cannot start: ", stderr)
                self.assertNotIn("Traceback", stderr)

    def test_unusable_scratch_directory_refuses_cleanly(self) -> None:
        # The real server this time, with the default scratch path moved under
        # a directory that doesn't exist, as in a container without the tmpfs.
        with tempfile.TemporaryDirectory() as temp:
            missing = Path(temp) / "no-tmpfs" / "strange_ringtone"
            with (
                mock.patch.object(entry, "RingtoneServer", RingtoneServer),
                mock.patch.object(config, "_WINDOWS", False),
                mock.patch.object(config, "SCRATCH_DIR", missing),
            ):
                code, stderr = self.run_main(["--bind", "127.0.0.1"])
            self.assertFalse(missing.parent.exists())
        self.assertEqual(code, 1)
        self.assertIn("cannot create the scratch directory", stderr)
        self.assertNotIn("Traceback", stderr)


class SigtermTest(unittest.TestCase):
    """As PID 1 in a container, a process with no SIGTERM handler ignores the signal."""

    def setUp(self) -> None:
        previous = signal.getsignal(signal.SIGTERM)
        self.addCleanup(signal.signal, signal.SIGTERM, previous)

    def test_sigterm_unwinds_serve_forever_and_closes_the_server(self) -> None:
        closed: list[bool] = []

        class FakeServer:
            def __init__(self, address: tuple[str, int], settings: Settings) -> None:
                pass

            def serve_forever(self) -> None:
                # What the interpreter does when the signal arrives.
                handler = signal.getsignal(signal.SIGTERM)
                assert callable(handler), handler
                handler(signal.SIGTERM, None)

            def server_close(self) -> None:
                closed.append(True)

        env = {name: value for name, value in os.environ.items() if name not in MainTest.CONTRACT}
        env["PUBLIC_ORIGIN"] = ORIGIN
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch.object(entry, "RingtoneServer", FakeServer), \
                contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as raised:
                entry.main(["--bind", "127.0.0.1"])
        self.assertEqual(raised.exception.code, 0)
        self.assertEqual(closed, [True])

    @unittest.skipIf(sys.platform == "win32", "Windows has no catchable SIGTERM between processes")
    def test_sigterm_stops_a_running_server_promptly(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            env = {name: value for name, value in os.environ.items() if name not in MainTest.CONTRACT}
            env.update(PUBLIC_ORIGIN=ORIGIN)
            # Port 0 instead of the contract's 8080, so a busy port or a second
            # test run can't collide, and a scratch directory of the test's own
            # instead of the shared /tmp one; everything else is the real main().
            code = ("import pathlib, sys; sys.path.insert(0, sys.argv[1]); "
                    "from strange_ringtone import __main__ as entry, config; entry.PORT = 0; "
                    "config.SCRATCH_DIR = pathlib.Path(sys.argv[2]); "
                    "sys.exit(entry.main(['--bind', '127.0.0.1']))")
            process = subprocess.Popen(
                [sys.executable, "-I", "-c", code, str(helpers.CORE), str(Path(temp) / "scratch")],
                env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
            )
            try:
                assert process.stderr is not None
                line = process.stderr.readline()
                self.assertIn("listening on 127.0.0.1:", line)
                process.send_signal(signal.SIGTERM)
                self.assertEqual(process.wait(timeout=DEADLINE), 0)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
                if process.stderr is not None:
                    process.stderr.close()


class ServerBindTest(unittest.TestCase):
    @unittest.skipUnless(sys.platform == "win32", "SO_REUSEADDR is only unsafe on Windows")
    def test_no_address_reuse_on_windows(self) -> None:
        # There SO_REUSEADDR lets a second process bind the same port and take
        # over its connections.
        self.assertIs(RingtoneServer.allow_reuse_address, False)
        with tempfile.TemporaryDirectory() as temp:
            settings = Settings(public_origin=ORIGIN, scratch_dir=Path(temp) / "scratch")
            server = RingtoneServer(("127.0.0.1", 0), settings)
            try:
                self.assertEqual(server.socket.getsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR), 0)
            finally:
                server.server_close()

    @unittest.skipIf(sys.platform == "win32", "SO_REUSEADDR is only unsafe on Windows")
    def test_address_reuse_elsewhere(self) -> None:
        # On Linux it only lets a restarted container bind again at once.
        self.assertIs(RingtoneServer.allow_reuse_address, True)

    def test_no_reverse_dns_lookup_at_startup(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            settings = Settings(public_origin=ORIGIN, scratch_dir=Path(temp) / "scratch")
            with mock.patch("socket.getfqdn", side_effect=AssertionError("getfqdn called")):
                server = RingtoneServer(("127.0.0.1", 0), settings)
            try:
                self.assertEqual(server.server_name, "127.0.0.1")
                self.assertEqual(server.server_port, server.server_address[1])
            finally:
                server.server_close()


if __name__ == "__main__":
    unittest.main()
