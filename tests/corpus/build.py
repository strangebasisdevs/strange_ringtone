"""Deterministic generators for the WAV corpus (docs/PLAN.md section 10).

Stdlib only and free of strange_ringtone imports, so the host tests, the server
tests and the in-image tests all build the same files. Long cases are silence
written with bytes(n), which costs no Python loop; only valid_wav() computes
samples, because the real-render test needs a signal with known loudness.

corpus_cases() maps every case that inspect_wav must refuse to its file and the
WavError code it must raise. The two HTTP-level cases (an oversized body and a
body cut off mid-stream) never reach inspect_wav, so they are byte producers
for the server tests instead: oversized_body() and cut_off_body().
"""
from __future__ import annotations

import math
import struct
import sys
from array import array
from pathlib import Path

# The MAX_CLIP_SECONDS the too_long cases are sized against: the default, and
# what the server and image tests run with.
CORPUS_MAX_CLIP_SECONDS = 30

WAVE_FORMAT_PCM = 1
WAVE_FORMAT_ADPCM = 2
WAVE_FORMAT_IEEE_FLOAT = 3
WAVE_FORMAT_EXTENSIBLE = 0xFFFE


def chunk(chunk_id: bytes, body: bytes) -> bytes:
    """One RIFF chunk, padded to an even length as RIFF requires."""
    return struct.pack("<4sI", chunk_id, len(body)) + body + (b"\x00" if len(body) & 1 else b"")


def fmt_body(
    tag: int = WAVE_FORMAT_PCM,
    channels: int = 2,
    rate: int = 44100,
    bits: int = 16,
    block_align: int | None = None,
    byte_rate: int | None = None,
    extra: bytes = b"",
) -> bytes:
    """A fmt chunk body; block align and byte rate default to the consistent values."""
    if block_align is None:
        block_align = channels * ((bits + 7) // 8)
    if byte_rate is None:
        byte_rate = rate * block_align
    return struct.pack("<HHIIHH", tag, channels, rate, byte_rate, block_align, bits) + extra


def data_header(size: int) -> bytes:
    """A data chunk header alone, for data written separately (or not at all)."""
    return struct.pack("<4sI", b"data", size)


def riff(body: bytes, riff_size: int | None = None, form: bytes = b"WAVE", magic: bytes = b"RIFF") -> bytes:
    """The 12-byte RIFF header plus body; riff_size defaults to the honest value."""
    if riff_size is None:
        riff_size = 4 + len(body)
    return struct.pack("<4sI4s", magic, riff_size, form) + body


def pcm_header(data_size: int, rate: int = 44100, channels: int = 2) -> bytes:
    """The 44-byte header of a canonical PCM s16le WAV holding data_size bytes."""
    return riff(chunk(b"fmt ", fmt_body(channels=channels, rate=rate)) + data_header(data_size),
                riff_size=36 + data_size)


def silent_bytes(frames: int, rate: int = 44100, channels: int = 2) -> bytes:
    data_size = frames * channels * 2
    return pcm_header(data_size, rate, channels) + bytes(data_size)


def silent_wav(path: Path, frames: int, rate: int = 44100, channels: int = 2) -> Path:
    """A valid PCM s16le WAV of exactly `frames` frames of silence."""
    path.write_bytes(silent_bytes(frames, rate, channels))
    return path


def valid_wav(
    path: Path,
    seconds: float,
    rate: int = 44100,
    channels: int = 2,
    tone_hz: tuple[float, ...] = (440.0, 880.0),
    amplitude: float = 0.1,
) -> Path:
    """A valid PCM s16le WAV: the tones summed at equal weight, peaking at `amplitude`.

    Every channel carries the same signal. The default is about -20 dBFS peak,
    which the render pipeline can bring to -9 LUFS without the limiter acting.
    """
    frames = round(seconds * rate)
    scale = amplitude * 32767 / len(tone_hz)
    steps = [2 * math.pi * hz / rate for hz in tone_hz]
    mono = array("h", (round(scale * sum(math.sin(step * i) for step in steps)) for i in range(frames)))
    samples = array("h", bytes(2 * frames * channels))
    for channel in range(channels):
        samples[channel::channels] = mono
    # WAV is little-endian whatever the host is.
    if sys.byteorder == "big":
        samples.byteswap()
    data = samples.tobytes()
    path.write_bytes(pcm_header(len(data), rate, channels) + data)
    return path


def _base(frames: int = 44100) -> bytes:
    """A valid one-second stereo 44.1 kHz WAV of silence, the start of most cases."""
    return silent_bytes(frames)


def _cases() -> dict[str, tuple[bytes, str]]:
    stereo_fmt = chunk(b"fmt ", fmt_body())
    second = 44100 * 4
    data = data_header(second) + bytes(second)
    base = _base()
    max_frames_48k = CORPUS_MAX_CLIP_SECONDS * 48000

    def mono_seconds(seconds: int) -> bytes:
        # Mono keeps the long cases under MAX_BODY_BYTES, so through the server
        # they reach inspect_wav instead of the Content-Length check.
        return silent_bytes(seconds * 44100, channels=1)

    def with_fmt(**fields: int) -> bytes:
        return riff(chunk(b"fmt ", fmt_body(**fields)) + data)

    return {
        # Not RIFF at all.
        "empty": (b"", "not_riff"),
        "mp3_id3": (b"ID3\x04\x00\x00\x00\x00\x00\x0a" + bytes(10) + b"\xff\xfb\x90\x64" + bytes(413), "not_riff"),
        "mp3_frame_sync": (b"\xff\xfb\x90\x64" + bytes(413) + b"\xff\xfb\x90\x64" + bytes(413), "not_riff"),
        "mp4_ftyp": (struct.pack(">I4s4sI8s", 24, b"ftyp", b"M4A ", 0, b"M4A isom")
                     + struct.pack(">I4s", 16, b"mdat") + bytes(8), "not_riff"),
        "rifx_big_endian": (b"RIFX" + base[4:], "not_riff"),
        "riff_not_wave": (b"RIFF" + base[4:8] + b"AVI " + base[12:], "not_riff"),
        # Truncated RIFF.
        "truncated_riff": (base[:10], "truncated"),
        "riff_magic_only": (b"RIFF", "truncated"),
        "chunk_header_cut": (riff(stereo_fmt + b"data"), "truncated"),
        "fmt_body_cut": (riff(struct.pack("<4sI", b"fmt ", 16) + bytes(8)), "truncated"),
        "data_size_lies": (riff(stereo_fmt + data_header(second * 2) + bytes(second)), "truncated"),
        # A RIFF size that lies.
        "riff_size_too_big": (riff(stereo_fmt + data, riff_size=36 + second + 1000), "bad_size"),
        "riff_size_too_small": (riff(stereo_fmt + data, riff_size=36), "bad_size"),
        "cut_mid_data": (base[: len(base) // 2], "bad_size"),
        # Chunk order.
        "duplicate_fmt": (riff(stereo_fmt + stereo_fmt + data), "duplicate_chunk"),
        "duplicate_data": (riff(stereo_fmt + data + data), "duplicate_chunk"),
        "fmt_after_data": (riff(stereo_fmt + data + stereo_fmt), "duplicate_chunk"),
        "data_before_fmt": (riff(data + stereo_fmt), "unexpected_chunk"),
        "list_before_data": (riff(stereo_fmt + chunk(b"LIST", b"INFOISFT\x04\x00\x00\x00abc\x00") + data),
                             "unexpected_chunk"),
        "fact_chunk": (riff(stereo_fmt + chunk(b"fact", struct.pack("<I", 44100)) + data), "unexpected_chunk"),
        "list_after_data": (riff(stereo_fmt + data + chunk(b"LIST", b"INFO")), "trailing_data"),
        "trailing_bytes": (riff(stereo_fmt + data + b"\x00\x00"), "trailing_data"),
        "data_size_short": (riff(stereo_fmt + data_header(second - 400) + bytes(second)), "trailing_data"),
        "fmt_only": (riff(stereo_fmt), "missing_chunk"),
        "no_chunks": (riff(b""), "missing_chunk"),
        # Sample formats other than PCM s16le.
        "float32": (with_fmt(tag=WAVE_FORMAT_IEEE_FLOAT, bits=32), "unsupported_format"),
        "adpcm": (riff(chunk(b"fmt ", fmt_body(tag=WAVE_FORMAT_ADPCM, bits=4, block_align=2048, byte_rate=44359,
                                                extra=struct.pack("<HH", 2, 2036)))
                       + data), "unsupported_format"),
        "extensible": (riff(chunk(b"fmt ", fmt_body(tag=WAVE_FORMAT_EXTENSIBLE, extra=struct.pack(
                           "<HHI16s", 22, 16, 3, b"\x01\x00\x00\x00\x00\x00\x10\x00\x80\x00\x00\xaa\x00\x38\x9b\x71")))
                       + data), "unsupported_format"),
        "fmt_18_bytes": (riff(chunk(b"fmt ", fmt_body(extra=b"\x00\x00")) + data), "unsupported_format"),
        "pcm24": (with_fmt(bits=24), "bad_bits"),
        "pcm8": (with_fmt(bits=8), "bad_bits"),
        "pcm32": (with_fmt(bits=32), "bad_bits"),
        "channels8": (with_fmt(channels=8), "bad_channels"),
        "channels0": (with_fmt(channels=0), "bad_channels"),
        "rate22050": (with_fmt(rate=22050), "bad_rate"),
        "rate96000": (with_fmt(rate=96000), "bad_rate"),
        "bad_block_align": (with_fmt(block_align=2), "bad_block_align"),
        "bad_byte_rate": (with_fmt(byte_rate=44100 * 4 + 1), "bad_byte_rate"),
        "partial_frame": (riff(stereo_fmt + data_header(second + 2) + bytes(second + 2)), "bad_data_size"),
        # Durations.
        "zero_frames": (silent_bytes(0), "too_short"),
        "clip_0_1s": (silent_bytes(4410), "too_short"),
        "just_under_half_second": (silent_bytes(22049), "too_short"),
        "long_31s": (mono_seconds(31), "too_long"),
        "long_41s": (mono_seconds(41), "too_long"),
        "max_plus_one_frame": (silent_bytes(max_frames_48k + 1, rate=48000), "too_long"),
    }


def corpus_cases(directory: Path) -> dict[str, tuple[Path, str]]:
    """Write every inspect_wav case into directory: name -> (file, expected WavError code)."""
    cases: dict[str, tuple[Path, str]] = {}
    for name, (content, code) in _cases().items():
        path = directory / f"{name}.wav"
        path.write_bytes(content)
        cases[name] = (path, code)
    return cases


def oversized_body(max_body_bytes: int) -> bytes:
    """A well-formed WAV one byte longer than MAX_BODY_BYTES (413 on Content-Length)."""
    data_size = max_body_bytes + 1 - 44
    return pcm_header(data_size) + bytes(data_size)


def cut_off_body(seconds: int = 1) -> tuple[bytes, int]:
    """(the bytes actually sent, the Content-Length declared): the client stops halfway."""
    whole = silent_bytes(seconds * 44100)
    return whole[: len(whole) // 2], len(whole)
