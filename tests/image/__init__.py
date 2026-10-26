"""Tests that run only inside the built core image (docs/PLAN.md 9.2, "Image tests").

They need the image's ffmpeg, its read-only root, its user and its missing
network, so they are worthless anywhere else. The container sets
STRANGE_RINGTONE_IMAGE_TESTS=1 (README, Development); without it, raising
SkipTest here makes the host's `unittest discover -s tests` report this package
as skipped instead of failing on paths that don't exist.

Run inside the container as:
    python -I -m unittest discover -s /tests/image -t /tests -v
The top-level /tests puts tests/ on sys.path, so tests/corpus is importable.
"""
from __future__ import annotations

import os
import sys
import unittest

if os.environ.get("STRANGE_RINGTONE_IMAGE_TESTS") != "1":
    raise unittest.SkipTest("in-image tests; run them in the core image (README, Development)")

# The image's copy of the core, precompiled at build time, rather than the
# checkout's: the point is to test what ships.
APP_CORE = "/app/core"
if APP_CORE not in sys.path:
    sys.path.insert(0, APP_CORE)
