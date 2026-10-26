"""The whole render flow with the image's real ffmpeg (docs/PLAN.md 5.3, 9.2 and 10).

The unit tests prove the renderer's commands against a stub; only here does
the minimal ffmpeg build show that it accepts them, measures, limits, fades
and encodes, and that every malformed upload is refused before it runs.
"""
from __future__ import annotations

import contextlib
import http.client
import io
import json
import random
import shutil
import struct
import tempfile
import threading
import unittest
import wave
from pathlib import Path
from typing import Any
from urllib.parse import quote

from corpus.build import CORPUS_MAX_CLIP_SECONDS, corpus_cases, valid_wav
from strange_ringtone.config import Settings
from strange_ringtone.names import content_disposition
from strange_ringtone.render import FFMPEG, PRLIMIT, Renderer, RenderParams
from strange_ringtone.server import RingtoneServer

ORIGIN = "https://example.internal"
FIXTURE_SECONDS = 10.0
LOUDNESS_TOLERANCE_LU = 0.5
DURATION_TOLERANCE_SECONDS = 0.010
# The contract sizes the /tmp tmpfs with this many bytes per second of clip
# for every result (docs/PLAN.md 5.7); a larger result could fill it.
RESULT_BYTES_PER_SECOND = 33_000
# The ceiling config.py allows for MAX_CLIP_SECONDS.
LONGEST_CLIP_SECONDS = 40
# Boxes whose payload is a list of child boxes, as far as the checks below
# need to descend.
CONTAINERS = {b"moov", b"trak", b"mdia", b"minf", b"stbl", b"udta", b"edts"}


def boxes(data: bytes, start: int = 0, end: int | None = None) -> list[tuple[bytes, int, int]]:
    """(type, payload start, payload end) for each box in data[start:end]."""
    end = len(data) if end is None else end
    found = []
    position = start
    while position < end:
        if end - position < 8:
            raise AssertionError(f"a box header is cut off at {position}")
        size, kind = struct.unpack(">I4s", data[position:position + 8])
        header = 8
        if size == 1:
            (size,) = struct.unpack(">Q", data[position + 8:position + 16])
            header = 16
        elif size == 0:
            size = end - position
        if size < header or position + size > end:
            raise AssertionError(f"box {kind!r} at {position} has a bad size {size}")
        found.append((kind, position + header, position + size))
        position += size
    return found


def find(data: bytes, path: list[bytes]) -> tuple[int, int]:
    """The payload span of the first box at path, such as [b'moov', b'mvhd']."""
    start, end = 0, len(data)
    for depth, kind in enumerate(path):
        for child, child_start, child_end in boxes(data, start, end):
            if child == kind:
                if depth < len(path) - 1 and kind not in CONTAINERS:
                    raise AssertionError(f"{kind!r} is not a container")
                start, end = child_start, child_end
                break
        else:
            raise AssertionError(f"no {kind!r} box under {path[:depth]}")
    return start, end


def movie_seconds(data: bytes) -> float:
    start, _ = find(data, [b"moov", b"mvhd"])
    version = data[start]
    if version == 1:
        timescale, duration = struct.unpack(">IQ", data[start + 20:start + 32])
    else:
        timescale, duration = struct.unpack(">II", data[start + 12:start + 20])
    return duration / timescale


def sample_entry(data: bytes) -> bytes:
    start, end = find(data, [b"moov", b"trak", b"mdia", b"minf", b"stbl", b"stsd"])
    # A full box (version and flags), then the entry count, then the entries.
    (count,) = struct.unpack(">I", data[start + 4:start + 8])
    entries = boxes(data, start + 8, end)
    if count != 1 or len(entries) != 1:
        raise AssertionError(f"expected one sample entry, found {count}")
    return entries[0][0]


class RealRenderTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = Path(tempfile.mkdtemp(dir="/tmp"))
        self.addCleanup(shutil.rmtree, self.temp, True)
        self.scratch = self.temp / "scratch"
        self.log = io.StringIO()
        redirect = contextlib.redirect_stderr(self.log)
        redirect.__enter__()
        self.addCleanup(redirect.__exit__, None, None, None)
        settings = Settings(
            public_origin=ORIGIN,
            scratch_dir=self.scratch,
            max_clip_seconds=CORPUS_MAX_CLIP_SECONDS,
            rate_limit_renders_per_minute=1000,
        )
        # The production renderer and results store: nothing injected.
        self.server = RingtoneServer(("127.0.0.1", 0), settings)
        thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 10)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.port = self.server.server_address[1]
        self.fixture = valid_wav(self.temp / "fixture.wav", FIXTURE_SECONDS)

    def request(self, method: str, path: str, body: bytes | None = None,
                headers: dict[str, str] | None = None) -> tuple[int, http.client.HTTPMessage, bytes]:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=120)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, response.headers, response.read()
        finally:
            connection.close()

    def render(self, body: bytes, query: str = "", name: str | None = None) -> tuple[int, Any]:
        headers = {"Origin": ORIGIN, "Content-Type": "audio/wav"}
        if name is not None:
            headers["X-Tone-Name"] = quote(name, safe="")
        status, _headers, data = self.request("POST", "/api/render" + query, body, headers)
        return status, json.loads(data)

    def scratch_contents(self) -> list[str]:
        names = [str(p.relative_to(self.scratch)) for p in self.scratch.rglob("*")]
        return sorted(name for name in names if name != "results")

    def test_the_production_renderer_is_fenced_in(self) -> None:
        self.assertEqual(self.server.renderer.command, (FFMPEG,))
        self.assertEqual(self.server.renderer.prlimit, (PRLIMIT,))

    def test_renders_land_on_target(self) -> None:
        body = self.fixture.read_bytes()
        for target in (-14, -11, -9):
            with self.subTest(target=target):
                name = f"Real Tone {target} é"
                status, payload = self.render(body, f"?target_lufs={target}", name)
                self.assertEqual(status, 200, payload)
                self.assertEqual(sorted(payload), ["applied_gain_db", "duration", "measured_lufs", "result_id"])
                self.assertLessEqual(abs(payload["measured_lufs"] - target), LOUDNESS_TOLERANCE_LU, payload)
                self.assertIsInstance(payload["applied_gain_db"], float)
                self.assertLessEqual(abs(payload["duration"] - FIXTURE_SECONDS), DURATION_TOLERANCE_SECONDS)
                self.check_download(payload["result_id"], name)

    def check_download(self, result_id: str, name: str) -> None:
        status, headers, tone = self.request("GET", f"/api/result/{result_id}.m4a")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Content-Type"), "audio/mp4")
        self.assertEqual(headers.get("Content-Disposition"), content_disposition(name, "m4a"))
        self.assertEqual(headers.get("Cache-Control"), "no-store")
        status, headers, ringtone = self.request("GET", f"/api/result/{result_id}.m4r")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Content-Type"), "audio/x-m4r")
        self.assertEqual(ringtone, tone)
        # An ipod MP4: M4A brand, moov before mdat (+faststart), one AAC track.
        top = [kind for kind, _start, _end in boxes(tone)]
        self.assertEqual(top[0], b"ftyp")
        start, _ = find(tone, [b"ftyp"])
        self.assertEqual(tone[start:start + 4], b"M4A ")
        self.assertLess(top.index(b"moov"), top.index(b"mdat"))
        self.assertEqual(sample_entry(tone), b"mp4a")
        # The ipod muxer's edit list hides the encoder's priming samples, so
        # the clip is exactly as long as the upload (iOS refuses 30.5 s).
        self.assertLessEqual(abs(movie_seconds(tone) - FIXTURE_SECONDS), DURATION_TOLERANCE_SECONDS)
        # The sanitised name is the title, and the only metadata.
        moov_start, moov_end = find(tone, [b"moov"])
        self.assertIn(name.encode("utf-8"), tone[moov_start:moov_end])
        self.assertNotIn(b"Lavf", tone)

    def test_without_normalising(self) -> None:
        status, payload = self.render(self.fixture.read_bytes(), "?normalize=false&fade_in=0&fade_out=0")
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["applied_gain_db"], 0.0)
        # The fixture peaks near -20 dBFS: well under any target.
        self.assertLess(payload["measured_lufs"], -14.0)
        self.check_download(payload["result_id"], "ringtone")

    def test_every_corpus_case_is_refused_before_ffmpeg(self) -> None:
        corpus = self.temp / "corpus"
        corpus.mkdir()
        cases = corpus_cases(corpus)
        for case, (path, code) in cases.items():
            with self.subTest(case=case):
                status, payload = self.render(path.read_bytes())
                if code == "too_long":
                    self.assertEqual((status, payload), (413, {"error": "too_large", "detail": "too_long"}))
                else:
                    self.assertEqual((status, payload), (400, {"error": "bad_wav", "detail": code}))
                self.assertEqual(self.scratch_contents(), [])
            # Each case is removed as it goes: the tmpfs is small on purpose.
            path.unlink()
        self.assertEqual(len(self.server.results), 0)

    def test_the_longest_result_fits_the_contract_sizing(self) -> None:
        # Noise uses every bit the encoder may spend, so this is the largest
        # result a MAX_CLIP_SECONDS=40 deployment can hold.
        job = self.temp / "job"
        job.mkdir()
        noise = random.Random(40).randbytes(LONGEST_CLIP_SECONDS * 48000 * 2 * 2)
        with wave.open(str(job / "in.wav"), "wb") as writer:
            writer.setnchannels(2)
            writer.setsampwidth(2)
            writer.setframerate(48000)
            writer.writeframes(noise)
        params = RenderParams(
            fade_in=0.0, fade_out=0.0, normalize=False, target_lufs=-14.0, title="Noise",
            duration=float(LONGEST_CLIP_SECONDS),
        )
        result = Renderer((FFMPEG,), 120, (PRLIMIT,)).render(job, params)
        size = result.output.stat().st_size
        self.assertLessEqual(size, LONGEST_CLIP_SECONDS * RESULT_BYTES_PER_SECOND)

    def test_only_the_result_remains_and_the_sweep_takes_it(self) -> None:
        status, payload = self.render(self.fixture.read_bytes(), name="Swept")
        self.assertEqual(status, 200, payload)
        result_id = payload["result_id"]
        self.assertEqual(self.request("GET", f"/api/result/{result_id}.m4r")[0], 200)
        self.assertEqual(self.scratch_contents(), [f"results/{result_id}", f"results/{result_id}/tone.m4a"])
        # The TTL is up: what the sweeper thread does every few seconds.
        result = self.server.results.get(result_id)
        assert result is not None
        self.server.results.ttl_seconds = 0
        self.server.results.sweep()
        self.assertEqual(self.scratch_contents(), [])
        self.assertEqual(self.request("GET", f"/api/result/{result_id}.m4a")[0], 404)


if __name__ == "__main__":
    unittest.main()
