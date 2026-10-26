from __future__ import annotations

import contextlib
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from helpers import ROOT, load_script

check = load_script("check_ffmpeg_release")


def refs(*names: str) -> list[dict[str, str]]:
    return [{"ref": f"refs/tags/{name}", "object": {"sha": "0" * 40, "type": "commit"}} for name in names]


class ParseVersionTest(unittest.TestCase):
    def test_reads_major_minor_patch(self) -> None:
        self.assertEqual(check.parse_version("9.0.2\n"), (9, 0, 2))

    def test_missing_patch_is_zero(self) -> None:
        self.assertEqual(check.parse_version("9.0"), (9, 0, 0))

    def test_refuses_anything_else(self) -> None:
        for text in ("", "9", "n9.0.2", "9.0.2-dev", "9.0.2 9.0.3", "v9.0", "9.0.x", "1234567.0"):
            with self.subTest(text=text), self.assertRaises(check.InputError):
                check.parse_version(text)

    def test_committed_version_parses(self) -> None:
        # The workflow reads this file; a typo in it must fail here first.
        check.parse_version((ROOT / "core" / "ffmpeg" / "VERSION").read_text(encoding="utf-8"))


class ReleaseVersionsTest(unittest.TestCase):
    def test_reads_slurped_pages(self) -> None:
        data = [refs("n8.1", "n8.1.1"), refs("n9.0.2")]
        self.assertEqual(check.release_versions(data), [(8, 1, 0), (8, 1, 1), (9, 0, 2)])

    def test_reads_a_flat_array(self) -> None:
        self.assertEqual(check.release_versions(refs("n9.0")), [(9, 0, 0)])

    def test_ignores_tags_that_are_not_releases(self) -> None:
        data = refs("n9.0-dev", "n9.1-dev", "n10.0.1-rc1", "N9.9", "n9", "v9.9.9", "n9.9.9.9", "n" + "9" * 7 + ".0")
        self.assertEqual(check.release_versions(data), [])

    def test_refuses_malformed_entries(self) -> None:
        for data in ({"ref": "refs/tags/n9.0"}, [{"name": "n9.0"}], [{"ref": 9}], ["refs/tags/n9.0"]):
            with self.subTest(data=data), self.assertRaises(check.InputError):
                check.release_versions(data)


class CheckTest(unittest.TestCase):
    def test_up_to_date(self) -> None:
        status, _ = check.check((9, 0, 2), [(8, 1, 1), (9, 0, 2), (9, 0, 1)])
        self.assertEqual(status, 0)

    def test_newer_patch_fails_and_names_both(self) -> None:
        status, message = check.check((9, 0, 2), [(9, 0, 2), (9, 0, 3)])
        self.assertEqual(status, 1)
        self.assertIn("9.0.3", message)
        self.assertIn("9.0.2", message)

    def test_newer_minor_without_patch_fails(self) -> None:
        # n9.1 has no patch component; it is still newer than 9.0.2.
        self.assertEqual(check.check((9, 0, 2), [(9, 1, 0)])[0], 1)

    def test_older_branch_release_does_not_fail(self) -> None:
        # A point release of an older branch, tagged after the pinned one.
        self.assertEqual(check.check((9, 0, 2), [(9, 0, 2), (8, 1, 4)])[0], 0)

    def test_no_releases_fails_closed(self) -> None:
        self.assertEqual(check.check((9, 0, 2), [])[0], 2)


class MainTest(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.directory)
        self.version = self.directory / "VERSION"
        self.tags = self.directory / "tags.json"
        self.version.write_text("9.0.2\n", encoding="utf-8")

    def run_main(self, *argv: str) -> tuple[int, str]:
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            status = check.main(list(argv))
        return status, output.getvalue()

    def write_tags(self, data: object) -> None:
        self.tags.write_text(json.dumps(data), encoding="utf-8")

    def test_up_to_date_exits_zero(self) -> None:
        self.write_tags([refs("n9.0.1", "n9.0.2", "n9.1-dev")])
        self.assertEqual(self.run_main(str(self.version), str(self.tags))[0], 0)

    def test_newer_release_exits_one(self) -> None:
        self.write_tags([refs("n9.0.2"), refs("n9.0.3")])
        status, output = self.run_main(str(self.version), str(self.tags))
        self.assertEqual(status, 1)
        self.assertIn("9.0.3", output)

    def test_unreadable_inputs_exit_two(self) -> None:
        self.write_tags([refs("n9.0.2")])
        missing = str(self.directory / "missing")
        broken = self.directory / "broken.json"
        broken.write_text("[{", encoding="utf-8")
        for argv in (
            (missing, str(self.tags)),
            (str(self.version), missing),
            (str(self.version), str(broken)),
            (str(self.version),),
        ):
            with self.subTest(argv=argv):
                self.assertEqual(self.run_main(*argv)[0], 2)

    def test_unparsable_version_exits_two(self) -> None:
        self.version.write_text("latest\n", encoding="utf-8")
        self.write_tags([refs("n9.0.2")])
        self.assertEqual(self.run_main(str(self.version), str(self.tags))[0], 2)

    def test_empty_tag_list_exits_two(self) -> None:
        self.write_tags([[]])
        self.assertEqual(self.run_main(str(self.version), str(self.tags))[0], 2)


if __name__ == "__main__":
    unittest.main()
