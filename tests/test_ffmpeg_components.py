"""The design record names every component the ffmpeg allowlist ships.

core/ffmpeg/components.txt is what the in-image tests hold the binary to;
docs/PLAN.md 5.3 is where a reader decides whether the build is minimal. A
component added to the allowlist without a word in the plan would let the
design record understate what the image contains, so this compares the two
outside the image, on every run of the unit tests.
"""
from __future__ import annotations

import re
import unittest

import helpers


def allowlisted_names() -> set[str]:
    text = (helpers.ROOT / "core" / "ffmpeg" / "components.txt").read_text(encoding="utf-8")
    names = set()
    for line in text.splitlines():
        if line.strip() and not line.startswith("#"):
            names.add(line.split()[1])
    return names


def plan_build_section() -> str:
    text = (helpers.ROOT / "docs" / "PLAN.md").read_text(encoding="utf-8")
    return text.split("**Minimal ffmpeg build:**", 1)[1].split("\n### ", 1)[0]


class PlanNamesEveryComponentTest(unittest.TestCase):
    def test_every_allowlisted_component_is_named_in_plan_5_3(self) -> None:
        named = set(re.findall(r"`([a-z0-9_]+)`", plan_build_section()))
        names = allowlisted_names()
        self.assertTrue(names, "components.txt lists nothing")
        self.assertEqual(sorted(names - named), [], "in components.txt but not named in docs/PLAN.md 5.3")


if __name__ == "__main__":
    unittest.main()
