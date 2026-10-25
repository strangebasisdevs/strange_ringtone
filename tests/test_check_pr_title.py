from __future__ import annotations

import contextlib
import io
import os
import unittest
from unittest import mock

from helpers import load_script

check = load_script("check_pr_title")


class ProblemsTest(unittest.TestCase):
    def test_accepts_conventional_titles(self) -> None:
        for title in (
            "feat: add the render endpoint",
            "fix(render): keep the clip under the cap",
            "feat!: rename PUBLIC_ORIGIN",
            "chore(deps): bump ruff from 0.14.0 to 0.14.1 in /.github/lint",
            "ci(release.yml): pin the attest action",
        ):
            with self.subTest(title=title):
                self.assertEqual(check.problems(title), [])

    def test_refuses_missing_type(self) -> None:
        self.assertTrue(check.problems("Add the render endpoint"))

    def test_refuses_unknown_type(self) -> None:
        self.assertTrue(check.problems("feature: add the render endpoint"))

    def test_refuses_missing_space_after_colon(self) -> None:
        self.assertTrue(check.problems("feat:add the render endpoint"))

    def test_refuses_empty_description(self) -> None:
        self.assertTrue(check.problems("feat: "))

    def test_refuses_uppercase_type(self) -> None:
        self.assertTrue(check.problems("Feat: add the render endpoint"))

    def test_refuses_trailing_period(self) -> None:
        self.assertTrue(check.problems("docs: explain the contract."))

    def test_refuses_surrounding_whitespace(self) -> None:
        self.assertTrue(check.problems(" fix: trim the name"))
        self.assertTrue(check.problems("fix: trim the name "))

    def test_refuses_control_and_bidi_characters(self) -> None:
        # A newline would smuggle a second line into the squash commit's subject;
        # a bidi override would make the title read differently from what it is.
        self.assertTrue(check.problems("fix: trim\nthe name"))
        self.assertTrue(check.problems("fix: trim ‮the name"))

    def test_refuses_overlong_title(self) -> None:
        self.assertTrue(check.problems("fix: " + "x" * check.MAX_LENGTH))


class MainTest(unittest.TestCase):
    def run_main(self, env: dict[str, str]) -> int:
        with mock.patch.dict(os.environ, env, clear=True), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return check.main()

    def test_good_title_passes(self) -> None:
        self.assertEqual(self.run_main({"PR_TITLE": "docs: add SECURITY.md"}), 0)

    def test_bad_title_fails(self) -> None:
        self.assertEqual(self.run_main({"PR_TITLE": "Update stuff"}), 1)

    def test_missing_variable_fails(self) -> None:
        self.assertEqual(self.run_main({}), 2)


if __name__ == "__main__":
    unittest.main()
