from __future__ import annotations

import contextlib
import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from helpers import load_script

check = load_script("check_contract_change")

README = """# strange_ringtone

## Deployment contract

| Variable | Default |
| --- | --- |
| `PUBLIC_ORIGIN` | required |

## Security

See SECURITY.md.
"""


class SectionTest(unittest.TestCase):
    def test_extracts_only_the_contract_body(self) -> None:
        section = check.contract_section(README)
        self.assertIn("PUBLIC_ORIGIN", section)
        self.assertNotIn("Security", section)
        self.assertNotIn("## Deployment contract", section)

    def test_missing_section_is_empty(self) -> None:
        self.assertEqual(check.contract_section("# Title\n\n## Other\n"), "")

    def test_trailing_whitespace_is_not_a_change(self) -> None:
        self.assertEqual(check.contract_section(README),
                         check.contract_section(README.replace("required |", "required |   ")))


class MarkerTest(unittest.TestCase):
    def test_bang_in_title(self) -> None:
        self.assertTrue(check.marked_breaking("feat!: rename the port variable", ""))
        self.assertTrue(check.marked_breaking("fix(contract)!: lower the body limit", ""))

    def test_footer_in_body(self) -> None:
        self.assertTrue(check.marked_breaking("feat: x", "Why.\n\nBREAKING CHANGE: PORT is now 8081"))
        self.assertTrue(check.marked_breaking("feat: x", "BREAKING-CHANGE: PORT is now 8081"))

    def test_not_marked(self) -> None:
        self.assertFalse(check.marked_breaking("feat: rename the port variable", "mentions breaking change: no"))
        self.assertFalse(check.marked_breaking("feat: x", "BREAKING CHANGE:"))


class MainTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.base = self.dir / "base.md"
        self.head = self.dir / "head.md"
        self.manifest = self.dir / "manifest.json"
        self.base.write_text(README, encoding="utf-8")
        self.head.write_text(README.replace("required", "required, https only"), encoding="utf-8")

    def run_main(self, title: str = "feat: change it", body: str = "") -> int:
        env = {"PR_TITLE": title, "PR_BODY": body}
        with mock.patch.dict(os.environ, env, clear=True), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return check.main([str(self.base), str(self.head), str(self.manifest)])

    def release(self, version: str) -> None:
        self.manifest.write_text(f'{{".": "{version}"}}', encoding="utf-8")

    def test_unchanged_contract_passes_even_after_release(self) -> None:
        self.release("0.1.0")
        self.head.write_text(README.replace("See SECURITY.md.", "See SECURITY.md for details."), encoding="utf-8")
        self.assertEqual(self.run_main(), 0)

    def test_change_before_any_release_is_only_reported(self) -> None:
        self.assertEqual(self.run_main(), 0)  # no manifest at all
        self.release("0.0.0")
        self.assertEqual(self.run_main(), 0)

    def test_unmarked_change_after_release_fails(self) -> None:
        self.release("0.1.0")
        self.assertEqual(self.run_main(), 1)

    def test_marked_change_after_release_passes(self) -> None:
        self.release("1.4.2")
        self.assertEqual(self.run_main(title="feat!: require https origins"), 0)
        self.assertEqual(self.run_main(body="BREAKING CHANGE: http origins are refused"), 0)

    def test_removing_the_section_after_release_counts_as_a_change(self) -> None:
        self.release("0.1.0")
        self.head.write_text("# strange_ringtone\n", encoding="utf-8")
        self.assertEqual(self.run_main(), 1)

    def test_missing_base_readme_reads_as_empty(self) -> None:
        self.base.unlink()
        self.release("0.1.0")
        self.assertEqual(self.run_main(), 1)

    def test_unreadable_manifest_fails_closed(self) -> None:
        for content in ("not json", "[]", '{".": 3}', '{".": "v0.1.0"}', "{}"):
            with self.subTest(content=content):
                self.manifest.write_text(content, encoding="utf-8")
                self.assertEqual(self.run_main(title="feat!: anything"), 1)

    def test_wrong_argument_count(self) -> None:
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(check.main([]), 2)


if __name__ == "__main__":
    unittest.main()
