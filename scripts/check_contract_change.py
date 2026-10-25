"""Fail when the README's deployment contract changes without a breaking-change marker.

Deployments pin the image by digest and rely on what the "Deployment contract"
section promises: environment variables, limits, UID/GID, port and writable
paths. Once a release exists, any change to that section must be marked as
breaking, either with '!' in the PR title or a 'BREAKING CHANGE:' footer in the
PR body, so release-please's CHANGELOG calls it out.

Before the first release (no version above 0.0.0 in the release-please
manifest), the contract is a draft and a change is only reported. An unreadable
manifest fails the check rather than silently disabling it.

Usage: PR_TITLE=... PR_BODY=... python -I scripts/check_contract_change.py BASE_README HEAD_README MANIFEST
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

HEADING = "## Deployment contract"
BREAKING_TITLE = re.compile(r"[a-z]+(?:\([^)]*\))?!: ")
BREAKING_FOOTER = re.compile(r"^BREAKING[ -]CHANGE: \S", re.MULTILINE)
VERSION = re.compile(r"(\d+)\.(\d+)\.(\d+)")


class ManifestError(Exception):
    pass


def contract_section(readme: str) -> str:
    """The section's body, without the heading; empty when the section is missing."""
    lines: list[str] = []
    inside = False
    for line in readme.splitlines():
        if line.strip() == HEADING:
            inside = True
            continue
        if inside and line.startswith("## "):
            break
        if inside:
            lines.append(line.rstrip())
    return "\n".join(lines).strip()


def released(manifest: Path) -> bool:
    """Whether the release-please manifest records a version above 0.0.0."""
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return False
    except (OSError, ValueError) as exc:
        raise ManifestError(f"cannot read {manifest}: {exc}") from exc
    version = data.get(".") if isinstance(data, dict) else None
    match = VERSION.fullmatch(version) if isinstance(version, str) else None
    if match is None:
        raise ManifestError(f"{manifest} has no 'X.Y.Z' version under '.'")
    return tuple(int(part) for part in match.groups()) > (0, 0, 0)


def marked_breaking(title: str, body: str) -> bool:
    return BREAKING_TITLE.match(title) is not None or BREAKING_FOOTER.search(body) is not None


def read_text(path: Path) -> str:
    # A README missing on the base branch (the very first PR) reads as empty.
    return path.read_text(encoding="utf-8") if path.exists() else ""


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    base, head, manifest = (Path(arg) for arg in argv)
    if contract_section(read_text(base)) == contract_section(read_text(head)):
        print("Deployment contract unchanged.")
        return 0
    try:
        is_released = released(manifest)
    except ManifestError as exc:
        print(f"Deployment contract changed, and the release state is unknown: {exc}", file=sys.stderr)
        return 1
    if not is_released:
        print("Deployment contract changed. No release exists yet, so the draft contract is not enforced.")
        return 0
    if marked_breaking(os.environ.get("PR_TITLE", ""), os.environ.get("PR_BODY", "")):
        print("Deployment contract changed, and the PR is marked as breaking.")
        return 0
    print("The README's deployment contract changed, but the PR is not marked as breaking. "
          "Add '!' after the type in the PR title (for example 'feat!: ...') or a "
          "'BREAKING CHANGE: <what changed>' footer to the PR body.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
