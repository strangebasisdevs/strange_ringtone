"""Strict validation of an uploaded WAV before ffmpeg sees it (docs/PLAN.md 5.2 step 6).

The browser builds the WAV itself from the trimmed selection, so a legitimate
upload is always the simplest possible file: RIFF/WAVE with one 16-byte PCM
`fmt ` chunk followed by one `data` chunk and nothing else. Anything more
elaborate did not come from our client, so it is refused rather than
interpreted. That keeps ffmpeg's WAV demuxer, the largest attack surface in the
core, away from every input except the one shape we produce.

Two independent parsers must agree: the strict walk below and stdlib `wave`.
A file that one of them reads differently from the other is exactly the kind
of ambiguity a parser-confusion attack relies on.

Only the headers are read. The data chunk is never loaded, so a large upload
costs no memory, and every handle is closed before an error leaves this module
because Windows cannot delete a file that is still open.
"""
from __future__ import annotations

import os
import struct
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

# The stable error codes. The server answers 400 bad_wav (413 too_large for
# too_long) with one of these as the detail, and the tests assert them.
CODES = frozenset({
    "not_riff",            # not RIFF/WAVE at all (also empty, MP3 or MP4 bytes)
    "truncated",           # under 12 bytes, or a chunk header or body runs past EOF
    "bad_size",            # the RIFF size is not the file size minus 8
    "unexpected_chunk",    # any chunk other than fmt then data
    "duplicate_chunk",     # a second fmt or data chunk
    "missing_chunk",       # no fmt or no data chunk
    "unsupported_format",  # format tag other than 1 (PCM), or a fmt chunk that is not 16 bytes
    "bad_bits",            # not 16 bits per sample
    "bad_channels",        # not 1 or 2 channels
    "bad_rate",            # not 44100 or 48000 Hz
    "bad_block_align",     # block align is not channels x 2
    "bad_byte_rate",       # byte rate is not rate x block align
    "bad_data_size",       # data size is not a whole number of frames
    "too_short",           # under 0.5 s
    "too_long",            # more than MAX_CLIP_SECONDS x rate frames
    "trailing_data",       # bytes after the data chunk
    "wave_mismatch",       # stdlib wave refuses the file or reads it differently
})

ALLOWED_CHANNELS = (1, 2)
ALLOWED_RATES = (44100, 48000)
BITS_PER_SAMPLE = 16
SAMPLE_WIDTH = BITS_PER_SAMPLE // 8
WAVE_FORMAT_PCM = 1
# A plain PCM fmt chunk is exactly 16 bytes. WAVE_FORMAT_EXTENSIBLE (40 bytes)
# and the 18-byte variant with a cbSize field are valid WAV, but our client
# never writes them, so accepting them would only widen what reaches ffmpeg.
FMT_SIZE = 16

_RIFF_HEADER = struct.Struct("<4sI4s")
_CHUNK_HEADER = struct.Struct("<4sI")
_FMT = struct.Struct("<HHIIHH")


class WavError(ValueError):
    """The upload is not a WAV we accept. code is one of CODES."""

    def __init__(self, code: str) -> None:
        if code not in CODES:
            raise ValueError(f"unknown WAV error code {code!r}")
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class WavInfo:
    channels: int
    sample_rate: int
    frames: int

    @property
    def seconds(self) -> float:
        return self.frames / self.sample_rate


def inspect_wav(path: Path, max_clip_seconds: int) -> WavInfo:
    """Return the clip's shape, or raise WavError naming the first rule it breaks."""
    # Closed in finally, so the handle is gone before any WavError reaches the caller.
    handle = open(path, "rb")
    try:
        info = _walk(handle, max_clip_seconds)
    finally:
        handle.close()
    _cross_check(path, info)
    return info


def _walk(handle: BinaryIO, max_clip_seconds: int) -> WavInfo:
    size = os.fstat(handle.fileno()).st_size
    head = handle.read(_RIFF_HEADER.size)
    # Empty input and anything that does not start like RIFF (MP3's ID3 or
    # frame sync, MP4's box header, big-endian RIFX) is simply not ours.
    if not head or not b"RIFF".startswith(head[:4]):
        raise WavError("not_riff")
    if len(head) < _RIFF_HEADER.size:
        raise WavError("truncated")
    # The magic is already known to be RIFF: the check above saw all four bytes.
    _, riff_size, form = _RIFF_HEADER.unpack(head)
    if form != b"WAVE":
        raise WavError("not_riff")
    # The declared size must describe this exact file. A size that lies is how
    # one parser ends up reading bytes another one ignores.
    if riff_size != size - 8:
        raise WavError("bad_size")

    fmt: tuple[int, int, int, int, int, int] | None = None
    data_size: int | None = None
    position = _RIFF_HEADER.size
    while position < size:
        handle.seek(position)
        header = handle.read(_CHUNK_HEADER.size)
        if data_size is not None:
            # After the data chunk only a second fmt or data counts as a chunk;
            # any other byte is trailing data, whatever it looks like.
            if len(header) == _CHUNK_HEADER.size and header[:4] in (b"fmt ", b"data"):
                raise WavError("duplicate_chunk")
            raise WavError("trailing_data")
        if len(header) < _CHUNK_HEADER.size:
            raise WavError("truncated")
        chunk_id, chunk_size = _CHUNK_HEADER.unpack(header)
        if chunk_id == b"fmt ":
            if fmt is not None:
                raise WavError("duplicate_chunk")
        elif chunk_id == b"data":
            if fmt is None:
                # data before fmt: not the order our client writes.
                raise WavError("unexpected_chunk")
        else:
            raise WavError("unexpected_chunk")
        body = position + _CHUNK_HEADER.size
        # RIFF pads odd-sized chunks to an even length; the pad must be in the file too.
        end = body + chunk_size + (chunk_size & 1)
        if end > size:
            raise WavError("truncated")
        if chunk_id == b"fmt ":
            if chunk_size != FMT_SIZE:
                raise WavError("unsupported_format")
            fmt = _FMT.unpack(handle.read(FMT_SIZE))
            _check_fmt(*fmt)
        else:
            # Only the size is used. The samples themselves are never read.
            data_size = chunk_size
        position = end

    # data before fmt was refused above, so a missing fmt always means a missing
    # data chunk too; fmt is named for the type checker.
    if fmt is None or data_size is None:
        raise WavError("missing_chunk")
    _, channels, rate, _, block_align, _ = fmt
    if data_size % block_align:
        raise WavError("bad_data_size")
    frames = data_size // block_align
    if frames < rate // 2:
        raise WavError("too_short")
    # No tolerance: iOS accepted 30.000 s and refused 30.5 s (Phase 0), so one
    # frame over the limit is already too long.
    if frames > max_clip_seconds * rate:
        raise WavError("too_long")
    return WavInfo(channels=channels, sample_rate=rate, frames=frames)


def _check_fmt(tag: int, channels: int, rate: int, byte_rate: int, block_align: int, bits: int) -> None:
    if tag != WAVE_FORMAT_PCM:
        raise WavError("unsupported_format")
    if bits != BITS_PER_SAMPLE:
        raise WavError("bad_bits")
    if channels not in ALLOWED_CHANNELS:
        raise WavError("bad_channels")
    if rate not in ALLOWED_RATES:
        raise WavError("bad_rate")
    if block_align != channels * SAMPLE_WIDTH:
        raise WavError("bad_block_align")
    if byte_rate != rate * block_align:
        raise WavError("bad_byte_rate")


def _cross_check(path: Path, info: WavInfo) -> None:
    """Stdlib wave must open the file and read the same shape the walk did."""
    try:
        with wave.open(str(path), "rb") as reader:
            seen = (reader.getnchannels(), reader.getsampwidth(), reader.getframerate(), reader.getnframes())
    except (wave.Error, EOFError, struct.error, ValueError):
        raise WavError("wave_mismatch") from None
    if seen != (info.channels, SAMPLE_WIDTH, info.sample_rate, info.frames):
        raise WavError("wave_mismatch")
