from __future__ import annotations

import builtins
import gc
import io
import os
import struct
import tempfile
import unittest
import warnings
import wave
from pathlib import Path
from unittest import mock

import helpers  # noqa: F401  (puts core/ on sys.path)
from corpus import build
from corpus.build import CORPUS_MAX_CLIP_SECONDS, chunk, data_header, fmt_body, riff, silent_wav, valid_wav
from strange_ringtone import wav
from strange_ringtone.wav import CODES, WavError, WavInfo, inspect_wav

MAX = CORPUS_MAX_CLIP_SECONDS


class TempDirTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)

    def write(self, name: str, content: bytes) -> Path:
        path = self.dir / name
        path.write_bytes(content)
        return path

    def assert_refused(self, path: Path, code: str, max_clip_seconds: int = MAX) -> None:
        """inspect_wav refuses with code, closes its handles, and leaves no file behind."""
        before = sorted(self.dir.iterdir())
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always", ResourceWarning)
            with self.assertRaises(WavError) as raised:
                inspect_wav(path, max_clip_seconds)
            gc.collect()
        self.assertEqual(raised.exception.code, code)
        self.assertEqual([w for w in caught if issubclass(w.category, ResourceWarning)], [])
        # The traceback still holds the function's frames. On Windows the file
        # can only be deleted now if every handle on it was closed explicitly.
        os.remove(path)
        self.assertEqual(sorted(self.dir.iterdir()), [p for p in before if p != path])


class WavErrorTest(unittest.TestCase):
    def test_is_a_value_error_with_code(self) -> None:
        error = WavError("bad_rate")
        self.assertIsInstance(error, ValueError)
        self.assertEqual(error.code, "bad_rate")

    def test_unknown_code_is_a_programming_error(self) -> None:
        with self.assertRaises(ValueError):
            WavError("nope")

    def test_pinned_code_set(self) -> None:
        self.assertEqual(CODES, {
            "not_riff", "truncated", "bad_size", "unexpected_chunk", "duplicate_chunk", "missing_chunk",
            "unsupported_format", "bad_bits", "bad_channels", "bad_rate", "bad_block_align", "bad_byte_rate",
            "bad_data_size", "too_short", "too_long", "trailing_data", "wave_mismatch",
        })


class AcceptTest(TempDirTest):
    def test_valid_shapes(self) -> None:
        for rate in (44100, 48000):
            for channels in (1, 2):
                with self.subTest(rate=rate, channels=channels):
                    path = valid_wav(self.dir / f"ok-{rate}-{channels}.wav", 1.5, rate=rate, channels=channels)
                    info = inspect_wav(path, MAX)
                    self.assertEqual(info, WavInfo(channels=channels, sample_rate=rate, frames=round(1.5 * rate)))
                    self.assertAlmostEqual(info.seconds, 1.5)

    def test_stdlib_writer_output_is_accepted(self) -> None:
        # What a browser-side writer produces is the canonical 44-byte header;
        # stdlib wave writes the same, so the walk is not tied to our generator.
        path = self.dir / "stdlib.wav"
        with wave.open(str(path), "wb") as writer:
            writer.setnchannels(2)
            writer.setsampwidth(2)
            writer.setframerate(48000)
            writer.writeframes(bytes(48000 * 4))
        self.assertEqual(inspect_wav(path, MAX), WavInfo(2, 48000, 48000))

    def test_exactly_half_a_second_is_accepted_and_one_frame_less_is_not(self) -> None:
        for rate in (44100, 48000):
            with self.subTest(rate=rate):
                ok = silent_wav(self.dir / f"half-{rate}.wav", rate // 2, rate=rate)
                self.assertEqual(inspect_wav(ok, MAX).frames, rate // 2)
                short = silent_wav(self.dir / f"short-{rate}.wav", rate // 2 - 1, rate=rate)
                self.assert_refused(short, "too_short")

    def test_exactly_max_clip_seconds_is_accepted_and_one_frame_more_is_not(self) -> None:
        # No tolerance: iOS took 30.000 s and refused 30.5 s.
        exact = silent_wav(self.dir / "exact.wav", MAX * 48000, rate=48000)
        info = inspect_wav(exact, MAX)
        self.assertEqual(info.frames, MAX * 48000)
        self.assertEqual(info.seconds, MAX)
        os.remove(exact)
        over = silent_wav(self.dir / "over.wav", MAX * 48000 + 1, rate=48000)
        self.assert_refused(over, "too_long")

    def test_max_clip_seconds_is_the_callers(self) -> None:
        path = silent_wav(self.dir / "two.wav", 2 * 44100, channels=1)
        self.assertEqual(inspect_wav(path, 2).frames, 2 * 44100)
        self.assert_refused(path, "too_long", max_clip_seconds=1)

    def test_data_chunk_is_never_read(self) -> None:
        path = silent_wav(self.dir / "big.wav", MAX * 48000, rate=48000)
        reads: list[int] = []
        real_open = builtins.open

        class CountingFile(io.FileIO):
            def read(self, size: int = -1) -> bytes:
                content = super().read(size)
                reads.append(len(content))
                return content

        def counting_open(file, mode="r", *args, **kwargs):
            if mode == "rb" and Path(file) == path:
                return CountingFile(file, "rb")
            return real_open(file, mode, *args, **kwargs)

        with mock.patch.object(wav, "open", counting_open, create=True):
            inspect_wav(path, MAX)
        self.assertTrue(reads)
        # The RIFF header, two chunk headers and the fmt body: 44 bytes of 5.76 MB.
        self.assertLessEqual(sum(reads), 44)


class CorpusTest(TempDirTest):
    def test_every_case_is_refused_with_its_code(self) -> None:
        cases = build.corpus_cases(self.dir)
        self.assertGreaterEqual(len(cases), 40)
        for name, (path, code) in cases.items():
            with self.subTest(case=name):
                self.assertIn(code, CODES)
                self.assert_refused(path, code)
        # Nothing is left behind: assert_refused removed each case's own file.
        self.assertEqual(list(self.dir.iterdir()), [])

    def test_corpus_covers_section_10(self) -> None:
        names = set(build.corpus_cases(self.dir))
        for required in ("truncated_riff", "riff_size_too_big", "duplicate_fmt", "duplicate_data", "float32",
                         "pcm24", "adpcm", "mp3_id3", "mp4_ftyp", "empty", "long_31s", "long_41s",
                         "channels8", "clip_0_1s"):
            self.assertIn(required, names)

    def test_every_code_but_wave_mismatch_has_a_corpus_case(self) -> None:
        # wave_mismatch cannot come from a file the strict walk accepts; its
        # tests below stand in for a stdlib wave that disagrees.
        codes = {code for _, code in build.corpus_cases(self.dir).values()}
        self.assertEqual(codes, CODES - {"wave_mismatch"})

    def test_corpus_is_deterministic(self) -> None:
        first = self.dir / "a"
        second = self.dir / "b"
        first.mkdir()
        second.mkdir()
        one = build.corpus_cases(first)
        two = build.corpus_cases(second)
        for name in one:
            self.assertEqual(one[name][0].read_bytes(), two[name][0].read_bytes(), name)
        self.assertEqual(valid_wav(first / "t.wav", 0.5).read_bytes(), valid_wav(second / "t.wav", 0.5).read_bytes())

    def test_long_cases_fit_under_the_body_limit(self) -> None:
        # So that through the server they reach inspect_wav, not the Content-Length check.
        max_body_bytes = MAX * 48000 * 2 * 2 + 4096
        for name, (path, _) in build.corpus_cases(self.dir).items():
            self.assertLessEqual(path.stat().st_size, max_body_bytes, name)

    def test_http_level_cases(self) -> None:
        max_body_bytes = MAX * 48000 * 2 * 2 + 4096
        self.assertEqual(len(build.oversized_body(max_body_bytes)), max_body_bytes + 1)
        sent, declared = build.cut_off_body()
        self.assertLess(len(sent), declared)
        self.assertEqual(sent[:4], b"RIFF")


class WalkRulesTest(TempDirTest):
    """Each rule of the walk on its own, so removing any one check fails a test."""

    def fmt(self, **fields: int) -> bytes:
        return chunk(b"fmt ", fmt_body(**fields))

    def data(self, size: int = 44100 * 4) -> bytes:
        return data_header(size) + bytes(size)

    def test_riff_size_must_equal_file_size_minus_8(self) -> None:
        body = self.fmt() + self.data()
        for delta in (-1, 1):
            with self.subTest(delta=delta):
                self.assert_refused(self.write("x.wav", riff(body, riff_size=4 + len(body) + delta)), "bad_size")

    def test_wave_form_is_required(self) -> None:
        body = self.fmt() + self.data()
        self.assert_refused(self.write("x.wav", riff(body, form=b"WAVX")), "not_riff")
        self.assert_refused(self.write("y.wav", riff(body, magic=b"RIFX")), "not_riff")

    def test_short_prefixes(self) -> None:
        self.assert_refused(self.write("a.wav", b"RI"), "truncated")
        self.assert_refused(self.write("b.wav", b"RIFF\x04\x00\x00\x00WAV"), "truncated")
        self.assert_refused(self.write("c.wav", b"\x00"), "not_riff")

    def test_odd_chunk_needs_its_pad_byte(self) -> None:
        fmt = self.fmt(channels=1)
        self.assert_refused(self.write("a.wav", riff(fmt + data_header(3) + bytes(3))), "truncated")
        self.assert_refused(self.write("b.wav", riff(fmt + chunk(b"data", bytes(3)))), "bad_data_size")

    def test_fmt_must_be_16_bytes_even_when_pcm(self) -> None:
        for extra in (b"\x00\x00", bytes(24)):
            with self.subTest(size=16 + len(extra)):
                content = riff(chunk(b"fmt ", fmt_body(extra=extra)) + self.data())
                self.assert_refused(self.write("x.wav", content), "unsupported_format")

    def test_fmt_field_checks(self) -> None:
        cases = {
            "unsupported_format": dict(tag=3),
            "bad_bits": dict(bits=12),
            "bad_channels": dict(channels=3),
            "bad_rate": dict(rate=32000),
            "bad_block_align": dict(block_align=8),
            "bad_byte_rate": dict(byte_rate=44100),
        }
        for code, fields in cases.items():
            with self.subTest(code=code):
                self.assert_refused(self.write("x.wav", riff(self.fmt(**fields) + self.data())), code)

    def test_one_fmt_then_one_data_and_nothing_else(self) -> None:
        fmt, data = self.fmt(), self.data()
        cases = {
            "duplicate_chunk": [fmt + fmt + data, fmt + data + data, fmt + data + fmt],
            "unexpected_chunk": [data + fmt, chunk(b"LIST", b"INFO") + fmt + data,
                                 fmt + chunk(b"junk", bytes(4)) + data],
            "trailing_data": [fmt + data + b"\x00\x00", fmt + data + chunk(b"LIST", b"INFO"), fmt + data + bytes(8)],
            "missing_chunk": [fmt, b""],
        }
        for code, bodies in cases.items():
            for index, body in enumerate(bodies):
                with self.subTest(code=code, index=index):
                    self.assert_refused(self.write("x.wav", riff(body)), code)

    def test_chunk_past_end_of_file(self) -> None:
        fmt = self.fmt()
        cases = [
            fmt + data_header(400) + bytes(399),        # data body short by one byte
            struct.pack("<4sI", b"fmt ", 16) + bytes(15),  # fmt body short by one byte
            fmt + b"dat",                               # chunk header cut
        ]
        for index, body in enumerate(cases):
            with self.subTest(index=index):
                self.assert_refused(self.write("x.wav", riff(body)), "truncated")


class WaveCrossCheckTest(TempDirTest):
    """Stdlib wave is a second, independent parser; the two must agree."""

    def setUp(self) -> None:
        super().setUp()
        self.path = valid_wav(self.dir / "ok.wav", 1.0)

    def test_wave_refusing_the_file(self) -> None:
        for error in (wave.Error("no"), EOFError(), struct.error("short")):
            with self.subTest(error=type(error).__name__):
                with mock.patch.object(wav.wave, "open", side_effect=error):
                    self.assert_refused_keep(self.path, "wave_mismatch")

    def test_wave_disagreeing(self) -> None:
        real = (2, 2, 44100, 44100)
        for index in range(4):
            seen = list(real)
            seen[index] += 1
            with self.subTest(field=index):
                with mock.patch.object(wav.wave, "open", return_value=FakeReader(*seen)):
                    self.assert_refused_keep(self.path, "wave_mismatch")
        with mock.patch.object(wav.wave, "open", return_value=FakeReader(*real)):
            self.assertEqual(inspect_wav(self.path, MAX).frames, 44100)

    def assert_refused_keep(self, path: Path, code: str) -> None:
        with self.assertRaises(WavError) as raised:
            inspect_wav(path, MAX)
        self.assertEqual(raised.exception.code, code)


class FakeReader:
    def __init__(self, channels: int, width: int, rate: int, frames: int) -> None:
        self.values = (channels, width, rate, frames)

    def __enter__(self) -> FakeReader:
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def getnchannels(self) -> int:
        return self.values[0]

    def getsampwidth(self) -> int:
        return self.values[1]

    def getframerate(self) -> int:
        return self.values[2]

    def getnframes(self) -> int:
        return self.values[3]


if __name__ == "__main__":
    unittest.main()
