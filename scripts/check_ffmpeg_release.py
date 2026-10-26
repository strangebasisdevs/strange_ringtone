"""Fail when FFmpeg has released a newer version than core/ffmpeg/VERSION.

ffmpeg-watch.yml runs this weekly (docs/PLAN.md 9.1). The core image builds a
pinned FFmpeg release from source, and nothing else would notice a security
release: Dependabot does not track source tarballs. A failing scheduled run is
the alert, through GitHub's failure email, so the workflow needs no write
permission.

The tag list comes from `gh api --paginate --slurp` on the FFmpeg/FFmpeg
mirror's matching-refs/tags/n endpoint: an array of pages, each an array of
{"ref": "refs/tags/n9.0.2", ...} objects (a flat array is accepted too).
Release tags are n<major>.<minor>[.<patch>]; anything else, such as n9.0-dev,
is ignored.

Usage: python -I scripts/check_ffmpeg_release.py core/ffmpeg/VERSION tags.json
Exit status: 0 up to date, 1 a newer release exists, 2 unreadable input.
"""
from __future__ import annotations

import json
import re
import sys
from collections.abc import Iterable
from pathlib import Path

Version = tuple[int, int, int]

VERSION_RE = re.compile(r"([0-9]+)\.([0-9]+)(?:\.([0-9]+))?")
TAG_RE = re.compile(r"refs/tags/n([0-9]+)\.([0-9]+)(?:\.([0-9]+))?")
# Larger than any real version component. A tag can be pushed to the mirror by
# anyone with access to it, so a huge digit string must not reach int().
_MAX_DIGITS = 6


class InputError(ValueError):
    """The VERSION file or the tag list cannot be used."""


def _to_version(match: re.Match[str]) -> Version | None:
    parts = [match[1], match[2], match[3] or "0"]
    if any(len(part) > _MAX_DIGITS for part in parts):
        return None
    major, minor, patch = (int(part) for part in parts)
    return major, minor, patch


def parse_version(text: str) -> Version:
    """The pinned version from VERSION's contents; one line, no other text."""
    match = VERSION_RE.fullmatch(text.strip())
    version = _to_version(match) if match else None
    if version is None:
        raise InputError("VERSION must hold a release number such as 9.0.2")
    return version


def _refs(data: object) -> Iterable[object]:
    if not isinstance(data, list):
        raise InputError("the tag list must be a JSON array")
    for item in data:
        # --slurp wraps each page in an outer array.
        if isinstance(item, list):
            yield from item
        else:
            yield item


def release_versions(data: object) -> list[Version]:
    """Every release version named by a tag in the parsed JSON."""
    versions = []
    for ref in _refs(data):
        if not isinstance(ref, dict) or not isinstance(ref.get("ref"), str):
            raise InputError("each tag must be an object with a string 'ref'")
        match = TAG_RE.fullmatch(ref["ref"])
        version = _to_version(match) if match else None
        if version is not None:
            versions.append(version)
    return versions


def show(version: Version) -> str:
    return ".".join(str(part) for part in version)


def check(pinned: Version, versions: list[Version]) -> tuple[int, str]:
    """(exit status, message) for the pinned version against the released ones."""
    if not versions:
        # An empty list means the API call or its parsing broke, not that
        # FFmpeg stopped releasing. Passing would hide that forever.
        return 2, "no FFmpeg release tags found; the tag list is empty or malformed"
    latest = max(versions)
    if latest > pinned:
        return 1, (
            f"FFmpeg {show(latest)} is released, but core/ffmpeg/VERSION pins {show(pinned)}. "
            "Review its release notes, then update VERSION and SHA256SUMS in a PR."
        )
    return 0, f"core/ffmpeg/VERSION pins {show(pinned)}, the latest FFmpeg release."


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: check_ffmpeg_release.py VERSION_FILE TAGS_JSON", file=sys.stderr)
        return 2
    version_file, tags_file = (Path(arg) for arg in argv)
    try:
        pinned = parse_version(version_file.read_text(encoding="utf-8"))
        with open(tags_file, encoding="utf-8") as handle:
            data = json.load(handle)
        versions = release_versions(data)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, InputError) as error:
        print(f"check_ffmpeg_release: {error}", file=sys.stderr)
        return 2
    status, message = check(pinned, versions)
    print(message, file=sys.stderr if status else sys.stdout)
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
