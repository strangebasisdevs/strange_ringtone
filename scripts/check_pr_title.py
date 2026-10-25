"""Fail unless the pull request title is a conventional-commit subject.

Pull requests are squash-merged, so the title becomes the commit subject that
release-please reads to write CHANGELOG.md and pick the next version. The title
arrives in the PR_TITLE environment variable: interpolating it into the
workflow's shell script instead would let a crafted title run commands.

Usage: PR_TITLE='feat: add X' python -I scripts/check_pr_title.py
"""
from __future__ import annotations

import os
import re
import sys
import unicodedata

TYPES = frozenset({
    "build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test",
})
# Long enough for Dependabot's "chore(deps): bump <package> from <a> to <b> in /<dir>".
MAX_LENGTH = 100
SUBJECT = re.compile(
    r"(?P<type>[a-z]+)(?:\((?P<scope>[a-z0-9][a-z0-9._-]*)\))?(?P<breaking>!)?: (?P<description>\S.*)"
)


def problems(title: str) -> list[str]:
    """Every reason the title is not acceptable; empty when it is."""
    errors = []
    if any(unicodedata.category(ch).startswith("C") for ch in title):
        errors.append("contains control or format characters")
    if title != title.strip():
        errors.append("has leading or trailing whitespace")
    if len(title) > MAX_LENGTH:
        errors.append(f"is {len(title)} characters long; the limit is {MAX_LENGTH}")
    match = SUBJECT.fullmatch(title)
    if match is None:
        errors.append("must look like 'type: description' or 'type(scope)!: description'")
        return errors
    if match["type"] not in TYPES:
        errors.append(f"type {match['type']!r} is not one of: {', '.join(sorted(TYPES))}")
    if match["description"].endswith("."):
        errors.append("description ends with a period")
    return errors


def main() -> int:
    title = os.environ.get("PR_TITLE")
    if title is None:
        print("PR_TITLE is not set", file=sys.stderr)
        return 2
    errors = problems(title)
    if errors:
        print(f"PR title {title!r} is not a conventional-commit subject:", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        print("Example: 'fix(render): keep the clip under the cap' ('!' after the type marks a breaking change).",
              file=sys.stderr)
        return 1
    print(f"PR title OK: {title}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
