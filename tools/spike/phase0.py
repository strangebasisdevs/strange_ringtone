"""Phase 0 spike: test files for iOS 26's Share -> "Use as Ringtone".

Synthesises a short, copyright-free marimba-style loop, then renders it the way
the core image will (measure with ebur128, apply gain, limit to -1 dBTP, fade,
encode AAC into an ipod/MP4 container). The renders cover the lengths, formats,
names and loudness targets that docs/PLAN.md section 12 (Phase 0) asks about.

Needs a local ffmpeg/ffprobe with the aac and libmp3lame encoders and the
ebur128 and alimiter filters. Usage:

    python -I tools/spike/phase0.py [OUT_DIR]     # default: spike-out/phase0
"""
from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import subprocess
import sys
import tempfile
import wave
import zipfile
from dataclasses import dataclass
from datetime import date
from pathlib import Path

SR = 44100
MASTER_SECONDS = 40.0
FADE_IN = 0.2
FADE_OUT = 1.5
# Below the -1 dBTP target because AAC encoding adds inter-sample overs: at
# -1.0 dBFS the -9 LUFS render measured -0.8 dBTP (docs/PLAN.md section 5.3).
LIMITER_CEILING_DB = -1.5
TOLERANCE_LU = 0.5
MARKER = ".phase0-spike"

# One chord per second: C, Am, F, G. (bass root, arpeggio notes) in Hz.
CHORDS = (
    (130.81, (523.25, 659.25, 783.99, 1046.50)),
    (110.00, (440.00, 523.25, 659.25, 880.00)),
    (87.31, (349.23, 440.00, 523.25, 698.46)),
    (98.00, (392.00, 493.88, 587.33, 783.99)),
)


@dataclass(frozen=True)
class Case:
    case_id: str
    filename: str
    title: str
    seconds: float
    target_lufs: float
    kind: str  # "m4a" or "mp3"; .m4r files are m4a renders saved under that name


CASES = (
    Case("A1", "A1 len 29.9s.m4a", "A1 len 29.9s", 29.9, -14.0, "m4a"),
    Case("A2", "A2 len 30.0s.m4a", "A2 len 30.0s", 30.0, -14.0, "m4a"),
    Case("A3", "A3 len 30.5s.m4a", "A3 len 30.5s", 30.5, -14.0, "m4a"),
    Case("A4", "A4 len 39.9s.m4a", "A4 len 39.9s", 39.9, -14.0, "m4a"),
    Case("A5", "A5 len 29.9s.m4r", "A5 len 29.9s", 29.9, -14.0, "m4a"),
    Case("A6", "A6 len 30.5s.m4r", "A6 len 30.5s", 30.5, -14.0, "m4a"),
    Case("A7", "A7 len 29.9s.mp3", "A7 len 29.9s", 29.9, -14.0, "mp3"),
    # The filename and the title tag disagree on purpose: which one does iOS show?
    Case("B1", "B1 name FILENAME.m4a", "B1 name TITLE-TAG", 20.0, -14.0, "m4a"),
    Case("B2", "B2 name FILENAME.mp3", "B2 name TITLE-TAG", 20.0, -14.0, "mp3"),
    Case("C1", "C1 loud -14 LUFS.m4a", "C1 loud -14 LUFS", 20.0, -14.0, "m4a"),
    Case("C2", "C2 loud -11 LUFS.m4a", "C2 loud -11 LUFS", 20.0, -11.0, "m4a"),
    Case("C3", "C3 loud -9 LUFS.m4a", "C3 loud -9 LUFS", 20.0, -9.0, "m4a"),
)

SUMMARY = re.compile(
    r"Summary:.*?I:\s+(-?\d+(?:\.\d+)?) LUFS.*?Peak:\s+(-?inf|-?\d+(?:\.\d+)?) dBFS",
    re.DOTALL,
)


@dataclass(frozen=True)
class Result:
    case: Case
    first_pass_lufs: float
    lufs: float
    true_peak: float
    passes: int
    format_duration: float
    stream_duration: float
    size: int


def tool(name: str) -> str:
    path = shutil.which(name)
    if path is None:
        sys.exit(f"{name} not found on PATH")
    return path


def run(argv: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(argv, capture_output=True, text=True, timeout=120, check=True)


def tone(freq: float, seconds: float, decay: float, partials: tuple[tuple[float, float], ...]) -> list[float]:
    """A plucked note: 5 ms attack, exponential decay, 20 ms taper so the tail never clicks."""
    length = round(seconds * SR)
    attack = round(0.005 * SR)
    taper = round(0.02 * SR)
    step = 2 * math.pi * freq / SR
    out = []
    for i in range(length):
        env = math.exp(-i / (decay * SR))
        if i < attack:
            env *= i / attack
        if i > length - taper:
            env *= (length - i) / taper
        out.append(env * sum(amp * math.sin(step * mult * i) for mult, amp in partials))
    return out


def synth_master(path: Path, seconds: float) -> None:
    frames = round(seconds * SR)
    left = [0.0] * frames
    right = [0.0] * frames
    cache: dict[tuple[str, float], list[float]] = {}

    def add(buf: list[float], start_s: float, gain_l: float, gain_r: float) -> None:
        start = round(start_s * SR)
        for i in range(min(len(buf), frames - start)):
            left[start + i] += buf[i] * gain_l
            right[start + i] += buf[i] * gain_r

    for step in range(int(seconds * 4)):
        bar = step // 4
        _, notes = CHORDS[bar % 4]
        # Every second 4-bar phrase runs the arpeggio downwards, so the loop isn't monotonous.
        k = step % 4 if (bar // 4) % 2 == 0 else 3 - step % 4
        freq = notes[k]
        key = ("arp", freq)
        if key not in cache:
            cache[key] = tone(freq, 0.6, 0.18, ((1, 1.0), (2, 0.35), (3, 0.12), (4.2, 0.05)))
        pan = 0.65 if step % 2 == 0 else 0.35
        add(cache[key], step * 0.25, 0.5 * pan, 0.5 * (1 - pan))

    for beat in range(int(seconds * 2)):
        root, _ = CHORDS[(beat // 2) % 4]
        key = ("bass", root)
        if key not in cache:
            cache[key] = tone(root, 1.0, 0.35, ((1, 1.0), (2, 0.25)))
        add(cache[key], beat * 0.5, 0.45 * 0.5, 0.45 * 0.5)

    peak = max(max(abs(v) for v in left), max(abs(v) for v in right))
    scale = 0.5 / peak  # -6 dBFS: leaves room for the gain stage to work in both directions
    samples = bytearray()
    for sample_l, sample_r in zip(left, right, strict=True):
        samples += round(sample_l * scale * 32767).to_bytes(2, "little", signed=True)
        samples += round(sample_r * scale * 32767).to_bytes(2, "little", signed=True)
    with wave.open(str(path), "wb") as out:
        out.setnchannels(2)
        out.setsampwidth(2)
        out.setframerate(SR)
        out.writeframes(bytes(samples))


def trim(master: Path, path: Path, seconds: float) -> None:
    """What the browser will send: the selection as PCM s16le WAV, sample-exact."""
    with wave.open(str(master), "rb") as src:
        data = src.readframes(round(seconds * SR))
    with wave.open(str(path), "wb") as out:
        out.setnchannels(2)
        out.setsampwidth(2)
        out.setframerate(SR)
        out.writeframes(data)


def measure(ffmpeg: str, path: Path) -> tuple[float, float]:
    """Integrated loudness (LUFS) and true peak (dBTP) from ebur128's summary."""
    proc = run([ffmpeg, "-nostdin", "-hide_banner", "-nostats", "-i", str(path),
                "-af", "ebur128=peak=true", "-f", "null", "-"])
    match = SUMMARY.search(proc.stderr)
    if match is None:
        raise RuntimeError(f"no ebur128 summary for {path.name}")
    return float(match.group(1)), float(match.group(2))


def encode(ffmpeg: str, src: Path, out: Path, case: Case, gain_db: float) -> None:
    limit = 10 ** (LIMITER_CEILING_DB / 20)
    chain = ",".join((
        f"volume={gain_db:.2f}dB",
        # level=false: the default re-normalises the output and would undo the gain.
        # latency=true: compensates the lookahead delay so the clip length stays exact.
        f"alimiter=limit={limit:.4f}:level=false:latency=true",
        f"afade=t=in:d={FADE_IN}:curve=qsin",
        f"afade=t=out:st={case.seconds - FADE_OUT:.3f}:d={FADE_OUT}:curve=qsin",
    ))
    if case.kind == "m4a":
        codec = ["-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", "-f", "ipod"]
    else:
        codec = ["-c:a", "libmp3lame", "-b:a", "256k", "-id3v2_version", "3", "-f", "mp3"]
    run([ffmpeg, "-nostdin", "-hide_banner", "-y", "-protocol_whitelist", "file",
         "-f", "wav", "-i", str(src), "-af", chain, "-ar", str(SR),
         "-map_metadata", "-1", "-fflags", "+bitexact", "-metadata", f"title={case.title}",
         *codec, str(out)])


def durations(ffprobe: str, path: Path) -> tuple[float, float]:
    proc = run([ffprobe, "-v", "error", "-show_entries", "format=duration:stream=duration",
                "-of", "json", str(path)])
    info = json.loads(proc.stdout)
    stream = info.get("streams", [{}])[0].get("duration", "nan")
    return float(info["format"]["duration"]), float(stream)


def render(ffmpeg: str, ffprobe: str, master: Path, work: Path, out_dir: Path, case: Case) -> Result:
    src = work / f"{case.case_id}.wav"
    trim(master, src, case.seconds)
    measured, _ = measure(ffmpeg, src)
    gain = case.target_lufs - measured
    # The final name is only applied after encoding, so ffmpeg never sees ".m4r".
    out = work / f"{case.case_id}.{case.kind}"
    first_pass = math.nan
    passes = 0
    for passes in range(1, 4):
        encode(ffmpeg, src, out, case, gain)
        lufs, peak = measure(ffmpeg, out)
        if passes == 1:
            first_pass = lufs
        if abs(lufs - case.target_lufs) <= TOLERANCE_LU:
            break
        gain += case.target_lufs - lufs
    final = out_dir / case.filename
    shutil.copyfile(out, final)
    fmt_dur, stream_dur = durations(ffprobe, final)
    return Result(case, first_pass, lufs, peak, passes, fmt_dur, stream_dur, final.stat().st_size)


def checklist(results: list[Result], ffmpeg_version: str) -> str:
    rows = "\n".join(
        f"{r.case.case_id:<3} {r.case.filename:<24} {r.stream_duration:>7.3f}s {r.lufs:>6.1f} {r.true_peak:>5.1f}"
        f"   offered?___ accepted?___ name shown:________________"
        for r in results
    )
    return f"""strange_ringtone - Phase 0 spike: iOS 26 Share -> "Use as Ringtone"
Generated {date.today().isoformat()} by tools/spike/phase0.py ({ffmpeg_version})
Every file is the same synthetic loop (no copyrighted audio), rendered like the
real app: measured, gain to target loudness, limited at {LIMITER_CEILING_DB} dBFS,
{FADE_IN}s fade-in and {FADE_OUT}s fade-out, AAC 256k (MP3 256k for the .mp3 files).

DO THIS ON AN iOS 26+ PHONE. Write Y / N, or the error text.
  offered?  - Files app: long-press the file -> Share. Is "Use as Ringtone" listed?
  accepted? - Tap it. Did it add the tone, or show an error (copy the wording)?
  name      - Settings -> Sounds & Haptics -> Ringtone: what name is listed?

ID  File                     length    LUFS   dBTP
{rows}

What each group answers
  A1-A4  Where the length limit sits (29.9 / 30.0 / 30.5 / 39.9 s). If A3 fails,
         A4 only confirms it; if A3 passes, A4 tells us whether 40 s is the limit.
  A5-A6  Does a .m4r file get "Use as Ringtone" at all, with the same limit?
  A7     MP3 control (reported working elsewhere).
  B1-B2  Does iOS name the tone after the FILENAME or the TITLE-TAG? (m4a and mp3)
  C1-C3  Loudness. Set the ringer volume once, then preview C1, C2, C3 and a
         built-in tone (e.g. Reflection) in the Ringtone list. Which matches the
         built-in best? Does C3 sound squashed or distorted?

Other sources (try at least A1 and A3 this way). If iOS says "Duplicate
Ringtone", delete the earlier copy first (swipe left in the Ringtone list).
  [ ] Safari download: open the file's link in Safari, download it, open it from
      Safari's downloads list, Share. Is "Use as Ringtone" offered there too?
  [ ] AirDrop from the Mac, then from Files.

Extra checks
  [ ] Does a custom tone also show up under Settings -> Sounds & Haptics -> Text Tone?
  [ ] Loop seam: set A1 as the ringtone, call from the other phone, and listen
      where the loop restarts. Smooth, or a click or jump?
  [ ] Cleanup: can test tones be deleted (swipe left in the Ringtone list)? How?
  [ ] iOS version (Settings -> General -> About): ______
"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("out_dir", nargs="?", type=Path,
                        default=Path(__file__).resolve().parents[2] / "spike-out" / "phase0")
    out_dir: Path = parser.parse_args().out_dir
    ffmpeg, ffprobe = tool("ffmpeg"), tool("ffprobe")
    ffmpeg_version = run([ffmpeg, "-hide_banner", "-version"]).stdout.splitlines()[0]

    # Only ever clear a directory this script created. Empty it rather than
    # removing it: Windows refuses to delete a folder that a shell or Explorer has open.
    if out_dir.exists() and any(out_dir.iterdir()):
        if not (out_dir / MARKER).exists():
            sys.exit(f"{out_dir} is not empty and was not made by this script; refusing to overwrite")
        for child in out_dir.iterdir():
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / MARKER).write_text("generated by tools/spike/phase0.py\n", encoding="utf-8")

    results: list[Result] = []
    with tempfile.TemporaryDirectory(prefix="phase0-") as tmp:
        work = Path(tmp)
        master = work / "master.wav"
        print("synthesising master loop...", flush=True)
        synth_master(master, MASTER_SECONDS)
        for case in CASES:
            result = render(ffmpeg, ffprobe, master, work, out_dir, case)
            results.append(result)
            print(f"{case.case_id}  {case.filename:<24} stream {result.stream_duration:7.3f}s"
                  f"  format {result.format_duration:7.3f}s  {result.lufs:6.1f} LUFS"
                  f" (first pass {result.first_pass_lufs:6.1f}, {result.passes} pass)"
                  f"  {result.true_peak:5.1f} dBTP  {result.size // 1024} KiB", flush=True)

    (out_dir / "CHECKLIST.txt").write_text(checklist(results, ffmpeg_version), encoding="utf-8")
    bundle = out_dir / "phase0-ringtone-spike.zip"
    with zipfile.ZipFile(bundle, "w", compression=zipfile.ZIP_STORED) as zf:
        for name in ["CHECKLIST.txt", *(case.filename for case in CASES)]:
            zf.write(out_dir / name, arcname=f"phase0/{name}")
    print(f"wrote {len(CASES)} files, CHECKLIST.txt and {bundle.name} to {out_dir}")


if __name__ == "__main__":
    main()
