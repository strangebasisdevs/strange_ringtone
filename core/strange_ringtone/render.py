"""Measure and render a validated WAV with the image's minimal ffmpeg (docs/PLAN.md 5.3).

ffmpeg is the largest attack surface in the core, so every run is fenced in:

- an argument list, never a shell, with a fixed program path; the only value
  from the client that reaches it is the sanitised tone name, as one argv
  element after -metadata;
- the util-linux prlimit binary in front of it on Linux (address space, CPU
  seconds, file size, open files). prlimit execs into ffmpeg, so the PID is
  unchanged. preexec_fn is not used: the stdlib documents it as unsafe in a
  threaded process, and the server is threaded;
- its own session, so on a wall-clock timeout the whole process group dies,
  not only the direct child;
- a job directory the server created, holding only server-chosen names.

The render pass measures its own output with a trailing ebur128, because the
image has no AAC decoder and so can't measure the encoded file afterwards.
"""
from __future__ import annotations

import math
import os
import re
import signal
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

# Fixed paths, never taken from a setting or a request: the binaries the image
# ships (core/Dockerfile).
FFMPEG = "/usr/local/bin/ffmpeg"
PRLIMIT = "/usr/bin/prlimit"

# -1.5 dBFS, not -1.0: Phase 0 measured AAC encoding adding inter-sample overs,
# and -1.5 kept every render at or below -1.3 dBTP (docs/PLAN.md 5.3).
LIMITER_CEILING_DB = -1.5
# alimiter's limit is linear (0.0625 to 1), not dB.
LIMITER_LIMIT = f"{10 ** (LIMITER_CEILING_DB / 20):.4f}"
GAIN_CLAMP_DB = 20.0
CORRECTION_THRESHOLD_LU = 0.5
SAMPLE_RATE = 44100
BITRATE = "256k"
FADE_CURVE = "qsin"

# How long to wait for the pipes to drain after a timeout kill. Bounded so that
# a process that escaped the group kill and still holds a pipe open can't hang
# the request; the tests shorten it.
DRAIN_SECONDS = 5.0

# The summary f_ebur128.c prints when the filter closes. Anchored on
# "Summary:" because every per-frame line also contains "I: ... LUFS", and the
# lines in between are spelled out so a changed format fails the render
# instead of being read loosely. Integrated loudness is never -inf (ebur128
# starts at the -70 LUFS gate), but true peak is -inf for digital silence.
# Each av_log call may carry a "[Parsed_ebur128_N @ 0x...] " prefix.
_PREFIX = r"(?:\[[^\]\n]*\] )?"
_NUMBER = r"-?[0-9]+\.[0-9]"
SUMMARY_RE = re.compile(
    _PREFIX + r"Summary:\n"
    r"\n"
    r"  Integrated loudness:\n"
    rf"    I:\s+({_NUMBER}) LUFS\n"
    rf"    Threshold:\s+(?:{_NUMBER}|-inf) LUFS\n"
    r"\n"
    r"  Loudness range:\n"
    rf"    LRA:\s+{_NUMBER} LU\n"
    rf"    Threshold:\s+(?:{_NUMBER}|-inf) LUFS\n"
    rf"    LRA low:\s+(?:{_NUMBER}|-inf) LUFS\n"
    rf"    LRA high:\s+(?:{_NUMBER}|-inf) LUFS\n"
    r"\n"
    r"  True peak:\n"
    rf"    Peak:\s+({_NUMBER}|-inf) dBFS\n"
)

# Every run starts like this: no stdin, no banner or progress lines, one
# thread, and local files only, whatever the binary was built with.
_COMMON = ["-nostdin", "-hide_banner", "-nostats", "-threads", "1", "-protocol_whitelist", "file"]


class RenderError(Exception):
    """ffmpeg failed. code is render_failed, render_timeout or measure_failed.

    Deliberately carries no ffmpeg output: stderr can quote the tone name and
    paths, and it never leaves this module.
    """

    def __init__(self, code: str) -> None:
        if code not in ("render_failed", "render_timeout", "measure_failed"):
            raise ValueError(f"unknown render error code {code!r}")
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class RenderParams:
    fade_in: float
    fade_out: float
    normalize: bool
    target_lufs: float
    title: str
    duration: float


@dataclass(frozen=True)
class RenderResult:
    duration: float
    measured_lufs: float
    applied_gain_db: float
    output: Path


@dataclass(frozen=True)
class Limits:
    """Per-run resource limits, applied by prlimit before ffmpeg starts."""

    # Measured headroom: a 40 s render needs far less, and a demuxer bug that
    # tries to allocate gigabytes fails here instead of taking the host's memory.
    address_space_bytes: int = 512 * 1024 * 1024
    # CPU time, as a backstop to the wall-clock timeout.
    cpu_seconds: int = 20
    # The largest legitimate output is about 1.3 MB; nothing ffmpeg writes may
    # fill the tmpfs.
    file_size_bytes: int = 64 * 1024 * 1024
    open_files: int = 64


@dataclass(frozen=True)
class _Loudness:
    integrated: float
    true_peak: float


def default_prlimit() -> tuple[str, ...] | None:
    """prlimit on Linux, always; nothing where it doesn't exist (Windows development).

    Not conditional on the file being there: on Linux a missing prlimit fails
    every render instead of silently running ffmpeg without limits.
    """
    return (PRLIMIT,) if sys.platform.startswith("linux") else None


def clamp_gain(gain_db: float) -> float:
    return max(-GAIN_CLAMP_DB, min(GAIN_CLAMP_DB, gain_db))


def _finite(value: float, name: str) -> float:
    # A NaN or infinity formatted into a filter string would be a filter
    # argument nobody chose. The server's parser can't produce one; this keeps it so.
    if not math.isfinite(value):
        raise ValueError(f"{name} must be finite")
    return value


def measure_args(input: Path) -> list[str]:
    """Pass 1: integrated loudness and true peak of the upload, nothing written."""
    return [*_COMMON, "-f", "wav", "-i", str(input), "-af", "ebur128=peak=true", "-f", "null", "-"]


def filter_chain(params: RenderParams, gain_db: float) -> str:
    duration = _finite(params.duration, "duration")
    # Each fade is clamped to the clip, and rounded once, here, so the check
    # for zero sees exactly what ffmpeg will be given.
    fade_in = round(min(max(_finite(params.fade_in, "fade_in"), 0.0), duration), 3)
    fade_out = round(min(max(_finite(params.fade_out, "fade_out"), 0.0), duration), 3)
    # level=false: alimiter defaults to level=true, which re-normalises its
    # output and silently undoes the gain. latency=true keeps the clip length
    # exact.
    stages = [
        f"volume={_finite(gain_db, 'gain_db'):.2f}dB",
        f"alimiter=limit={LIMITER_LIMIT}:level=false:latency=true",
    ]
    # A zero fade is left out, not passed as d=0: afade reads d=0 as "use
    # nb_samples", which is a one-second fade nobody asked for.
    if fade_in > 0:
        stages.append(f"afade=t=in:st=0:d={fade_in:.3f}:curve={FADE_CURVE}")
    if fade_out > 0:
        stages.append(f"afade=t=out:st={max(duration - fade_out, 0.0):.3f}:d={fade_out:.3f}:curve={FADE_CURVE}")
    # Last, so it measures exactly what is encoded: after the gain, the
    # limiter and the fades.
    stages.append("ebur128=peak=true")
    return ",".join(stages)


def render_args(input: Path, output: Path, params: RenderParams, gain_db: float) -> list[str]:
    """Pass 2 (and 3): gain, limiter, fades and post-chain measurement, encoded to ipod AAC."""
    return [
        # -y: the corrective pass overwrites out.m4a, and with -nostdin ffmpeg
        # would otherwise refuse instead of asking.
        *_COMMON, "-y", "-f", "wav", "-i", str(input),
        "-af", filter_chain(params, gain_db),
        "-ar", str(SAMPLE_RATE),
        # No metadata from the input, and +bitexact drops the encoder tag, so
        # the title below is the only metadata in the file.
        "-map_metadata", "-1", "-fflags", "+bitexact",
        # One argv element: the sanitised name is never parsed by a shell and
        # can't become an option of its own.
        "-metadata", f"title={params.title}",
        "-c:a", "aac", "-b:a", BITRATE,
        "-movflags", "+faststart",
        "-f", "ipod", str(output),
    ]


def parse_summary(stderr: str) -> _Loudness | None:
    """The one ebur128 summary in stderr, or None when there isn't exactly one."""
    matches = SUMMARY_RE.findall(stderr.replace("\r\n", "\n"))
    if len(matches) != 1:
        return None
    integrated, peak = matches[0]
    return _Loudness(float(integrated), float(peak))


class Renderer:
    def __init__(
        self,
        command: tuple[str, ...],
        timeout_seconds: int,
        prlimit: tuple[str, ...] | None = None,
        limits: Limits | None = None,
    ) -> None:
        # Nothing here touches the filesystem: on Windows the production ffmpeg
        # path doesn't exist, and a server must still start for development.
        if not command:
            raise ValueError("command must name a program")
        if timeout_seconds < 1:
            raise ValueError("timeout_seconds must be at least 1")
        self.command = tuple(command)
        self.timeout_seconds = timeout_seconds
        self.prlimit = tuple(prlimit) if prlimit is not None else None
        # CPU seconds default to the wall-clock budget: a run can't use more
        # CPU than it is given time for, with one thread.
        self.limits = limits if limits is not None else Limits(cpu_seconds=timeout_seconds)

    def full_command(self, args: list[str]) -> list[str]:
        """prlimit (when configured), then the ffmpeg command, then args."""
        prefix: list[str] = []
        if self.prlimit is not None:
            limits = self.limits
            prefix = [
                *self.prlimit,
                f"--as={limits.address_space_bytes}",
                f"--cpu={limits.cpu_seconds}",
                f"--fsize={limits.file_size_bytes}",
                f"--nofile={limits.open_files}",
                # Everything after -- is the program and its arguments, never
                # an option of prlimit's.
                "--",
            ]
        return [*prefix, *self.command, *args]

    def render(self, job_dir: Path, params: RenderParams) -> RenderResult:
        """Render job_dir/in.wav to job_dir/out.m4a, or raise RenderError."""
        source = job_dir / "in.wav"
        output = job_dir / "out.m4a"
        try:
            if params.normalize:
                measured = self._run(measure_args(source), job_dir, "measure_failed")
                gain = clamp_gain(params.target_lufs - measured.integrated)
            else:
                # No measure pass at all: the user asked for the clip as it is.
                gain = 0.0
            post = self._render_once(source, output, params, gain, job_dir)
            if params.normalize and abs(post.integrated - params.target_lufs) > CORRECTION_THRESHOLD_LU:
                # The limiter and the fades move the loudness; one more run from
                # the original input with the error added back. A gain already
                # at the clamp can't move, so that run would change nothing.
                corrected = clamp_gain(gain + (params.target_lufs - post.integrated))
                if corrected != gain:
                    gain = corrected
                    post = self._render_once(source, output, params, gain, job_dir)
        except BaseException:
            # A half-written output is never served or left behind.
            _remove(output)
            raise
        return RenderResult(
            duration=params.duration, measured_lufs=post.integrated, applied_gain_db=gain, output=output
        )

    def _render_once(self, source: Path, output: Path, params: RenderParams, gain: float, job_dir: Path) -> _Loudness:
        loudness = self._run(render_args(source, output, params, gain), job_dir, "render_failed")
        if not output.is_file():
            raise RenderError("render_failed")
        return loudness

    def _run(self, args: list[str], job_dir: Path, failure: str) -> _Loudness:
        command = self.full_command(args)
        try:
            # Safe by construction: an argument list with no shell, a program
            # path fixed in code (FFMPEG, PRLIMIT), arguments that are server
            # constants, server-created paths and validated numbers plus the
            # sanitised title as one element, and a wall-clock timeout below.
            # tests/test_render.py pins each of these guards.
            proc = subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=job_dir,
                # Its own session and process group, so a timeout can kill
                # everything ffmpeg (or anything it started) is running.
                start_new_session=True,
            )
        except OSError:
            # Missing binary, missing prlimit, or no resources to start it.
            raise RenderError(failure) from None
        try:
            _stdout, stderr = proc.communicate(timeout=self.timeout_seconds)
        except subprocess.TimeoutExpired:
            _kill_group(proc)
            try:
                # Drain, not wait(): the pipes must be read to EOF to free them,
                # and the bound keeps a survivor holding them from hanging us.
                proc.communicate(timeout=DRAIN_SECONDS)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
            raise RenderError("render_timeout") from None
        except BaseException:
            _kill_group(proc)
            proc.wait()
            raise
        if proc.returncode != 0:
            raise RenderError(failure)
        loudness = parse_summary(stderr.decode("utf-8", errors="replace"))
        if loudness is None:
            raise RenderError(failure)
        return loudness


def _kill_group(proc: subprocess.Popen[bytes]) -> None:
    killpg = getattr(os, "killpg", None)
    if killpg is not None:
        try:
            # start_new_session made the child the leader of a new group whose
            # ID is its PID. Using the PID, not getpgid(), still reaches the
            # group's other members when the leader has already exited.
            killpg(proc.pid, signal.SIGKILL)
            return
        except ProcessLookupError:
            return
        except PermissionError:
            pass
    # Windows has no process groups to signal; TerminateProcess on the child
    # is the best it offers.
    try:
        proc.kill()
    except OSError:
        pass


def _remove(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    except OSError:
        # The job directory is removed by the caller in any case.
        pass
