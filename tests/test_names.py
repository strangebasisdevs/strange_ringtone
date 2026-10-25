from __future__ import annotations

import email.message
import re
import unicodedata
import unittest
from pathlib import Path
from urllib.parse import quote, unquote

import helpers  # noqa: F401  (puts core/ on sys.path)
from strange_ringtone import names
from strange_ringtone.http_guard import GuardError
from strange_ringtone.names import (
    DEFAULT_NAME,
    MAX_HEADER_BYTES,
    MAX_NAME_POINTS,
    ascii_fallback,
    content_disposition,
    parse_tone_name,
    sanitise,
)

ZWJ = "\u200d"
VS16 = "\ufe0f"
FAMILY = "\U0001f468\u200d\U0001f469\u200d\U0001f467"  # man ZWJ woman ZWJ girl
HEART = "\u2764\ufe0f"  # red heart with VS16
FORBIDDEN = set('/\\"*:<>?|')


class ConstantsTest(unittest.TestCase):
    def test_pinned_values(self) -> None:
        self.assertEqual((DEFAULT_NAME, MAX_HEADER_BYTES, MAX_NAME_POINTS), ("ringtone", 512, 40))


class ParseToneNameTest(unittest.TestCase):
    def assert_bad(self, values: list[str]) -> None:
        with self.assertRaises(GuardError) as raised:
            parse_tone_name(values)
        self.assertEqual((raised.exception.status, raised.exception.code), (400, "bad_name"))

    def test_missing_header_means_the_default(self) -> None:
        self.assertEqual(parse_tone_name([]), "ringtone")

    def test_empty_header_sanitises_to_the_default(self) -> None:
        self.assertEqual(parse_tone_name([""]), "ringtone")

    def test_exactly_one_header(self) -> None:
        # A proxy and the server might each read a different one of two.
        self.assert_bad(["a", "b"])
        self.assert_bad(["a", "a"])
        self.assert_bad(["", ""])

    def test_percent_encoded_utf8(self) -> None:
        for name in ("My Tone", "Café Crème", "日本語", f"Mum {HEART}", FAMILY, "Rock & Roll (live)!"):
            with self.subTest(name=name):
                self.assertEqual(parse_tone_name([quote(name, safe="")]), name)

    def test_size_limit_is_on_the_raw_header(self) -> None:
        self.assertEqual(parse_tone_name(["a" * MAX_HEADER_BYTES]), "a" * MAX_NAME_POINTS)
        self.assert_bad(["a" * (MAX_HEADER_BYTES + 1)])
        # The encoded form counts, not the decoded one: 171 x %41 is 513 bytes.
        self.assert_bad(["%41" * 171])
        self.assertEqual(parse_tone_name(["%41" * 170 + "AA"]), "A" * MAX_NAME_POINTS)

    def test_only_visible_ascii(self) -> None:
        # http.server decodes header bytes as latin-1, so a raw UTF-8 or latin-1
        # byte arrives as a character >= 0x80.
        for value in ("My Tone", "a\tb", "a\r\nb", "caf\xe9", "\xc3\xa9", "a\x00b", "a\x7fb", "\u00a0"):
            with self.subTest(value=value):
                self.assert_bad([value])

    def test_invalid_utf8_is_refused(self) -> None:
        for value in ("%FF", "%C3", "%C3%28", "%C0%AF", "%ED%A0%80", "%F4%90%80%80", "ok%E2%82"):
            with self.subTest(value=value):
                self.assert_bad([value])

    def test_plus_is_a_plus_sign_not_a_space(self) -> None:
        # unquote, not unquote_plus: '+' decodes to itself and is then dropped
        # by the sanitiser (category Sm), so 'a+b' never turns into 'a b'.
        self.assertEqual(parse_tone_name(["a+b"]), "ab")
        self.assertEqual(parse_tone_name(["a%20b"]), "a b")

    def test_decoded_name_is_sanitised(self) -> None:
        self.assertEqual(parse_tone_name([quote("../../etc/passwd\r\n", safe="")]), "etcpasswd")
        self.assertEqual(parse_tone_name([quote("\u202eabc", safe="")]), "abc")
        self.assertEqual(parse_tone_name(["%0D%0A"]), "ringtone")


class SanitiseTest(unittest.TestCase):
    def check(self, cases: dict[str, str]) -> None:
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(sanitise(raw), expected)

    def test_nfc(self) -> None:
        self.assertEqual(sanitise("Cafe\u0301"), "Caf\u00e9")
        self.assertEqual(sanitise("\u212b"), "\u00c5")  # ANGSTROM SIGN becomes A WITH RING

    def test_letters_marks_and_digits_in_any_script(self) -> None:
        for name in ("Привет", "日本語", "مرحبا", "नमस्ते", "सीता", "שלום", "Ελληνικά", "한국어", "٣٤٥", "Tone 42"):
            with self.subTest(name=name):
                self.assertEqual(sanitise(name), name)

    def test_spaces(self) -> None:
        self.check({
            "a\u00a0b": "a b",
            "a\u3000b": "a b",
            "a\u2003b": "a b",
            "a\u202fb": "a b",
            "a    b": "a b",
            "a \u00a0\u2009 b": "a b",
            # Line and paragraph separators are Zl/Zp, not Zs: dropped.
            "a\u2028b\u2029c": "abc",
        })

    def test_allowed_punctuation(self) -> None:
        name = "Rock & Roll (live) - it's ok, fine_now!"
        self.assertEqual(sanitise(name + "."), name)

    def test_path_separators_and_reserved_characters(self) -> None:
        self.check({
            "a/b\\c": "abc",
            'a"b*c:d<e>f?g|h': "abcdefgh",
            "../../etc/passwd": "etcpasswd",
            "C:\\Windows\\x": "CWindowsx",
            "a;b=c%d#e$f@g~h^i`j+k[l]m{n}o": "abcdefghijklmno",
        })

    def test_every_other_quote_mark(self) -> None:
        self.check({"\u201cx\u201d": "x", "\u2018x\u2019": "x", "\u00abx\u00bb": "x", "`x`": "x", "\u300cx\u300d": "x"})

    def test_controls(self) -> None:
        self.check({
            "a\r\nb": "ab",
            "a\x00b": "ab",
            "a\tb": "ab",
            "a\x7fb": "ab",
            "a\x85b": "ab",
            "a\x1bb": "ab",
        })

    def test_format_characters_and_bidi_overrides(self) -> None:
        self.check({
            "abc\u202edcba": "abcdcba",
            "\u202dx\u202c": "x",
            "\u2066x\u2069": "x",
            "\u2067x\u2068y": "xy",
            "a\u200eb\u200fc\u061cd": "abcd",
            "a\u200bb": "ab",    # zero-width space
            "\ufeffab": "ab",    # byte order mark
            "a\u00adb": "ab",    # soft hyphen
            "a\u2060b": "ab",    # word joiner
        })

    def test_emoji(self) -> None:
        self.check({
            "\U0001f600": "\U0001f600",
            FAMILY: FAMILY,
            HEART: HEART,
            "\u2764\ufe0f\u200d\U0001f525": "\u2764\ufe0f\u200d\U0001f525",  # heart on fire
            "\U0001f1e9\U0001f1ea": "\U0001f1e9\U0001f1ea",  # regional indicators are So
            # Skin-tone modifiers are Sk and tag characters are Cf; both go (plan 5.6).
            "\U0001f44d\U0001f3fd": "\U0001f44d",
            "\U0001f3f4\U000e0067\U000e0062\U000e0065\U000e006e\U000e0067\U000e007f": "\U0001f3f4",
        })

    def test_zwj_and_vs16_only_next_to_an_emoji(self) -> None:
        self.check({
            "a\u200db": "ab",
            "a\ufe0fb": "ab",
            "\u200d": "ringtone",
            "\ufe0f": "ringtone",
            # Next to an emoji on either side, they stay.
            "\U0001f600\u200d": "\U0001f600\u200d",
            "a\u200d\U0001f600": "a\u200d\U0001f600",
            # A keycap's VS16 follows a digit and precedes a mark, so only the mark stays.
            "1\ufe0f\u20e3": "1\u20e3",
            # The rule looks at the previous kept character, so a dropped one in
            # between does not separate a selector from its emoji.
            "\U0001f600<\ufe0f": "\U0001f600\ufe0f",
            "a<\ufe0f": "a",
        })

    def test_trim_and_collapse(self) -> None:
        self.check({
            "  ..name..  ": "name",
            " . name . ": "name",
            "a  .  b": "a . b",
            "...": "ringtone",
            "   ": "ringtone",
            ". . .": "ringtone",
            "\u3000\u3000": "ringtone",
        })

    def test_empty(self) -> None:
        self.check({"": "ringtone", "<>|": "ringtone", "\r\n": "ringtone", "\ud800": "ringtone"})

    def test_cap_at_40_code_points(self) -> None:
        self.assertEqual(sanitise("a" * 40), "a" * 40)
        self.assertEqual(sanitise("a" * 41), "a" * 40)
        self.assertEqual(sanitise("b" * 100), "b" * 40)
        # The cap counts the result, not the input.
        self.assertEqual(sanitise("<" * 10 + "a" * 40), "a" * 40)

    def test_cut_strips_a_dangling_zwj(self) -> None:
        # 38 letters, then man (39th), ZWJ (40th), woman (41st): the cut leaves the ZWJ.
        self.assertEqual(sanitise("a" * 38 + FAMILY), "a" * 38 + "\U0001f468")
        # A family cut whole stays whole.
        self.assertEqual(sanitise("a" * 35 + FAMILY + "b"), "a" * 35 + FAMILY)

    def test_cut_strips_a_dangling_vs16(self) -> None:
        self.assertEqual(sanitise("a" * 39 + HEART), "a" * 39 + "\u2764")
        self.assertEqual(sanitise("a" * 38 + HEART + ZWJ + "\U0001f525"), "a" * 38 + HEART[0])

    def test_cut_strips_dangling_combining_marks(self) -> None:
        # q has no precomposed accented forms, so NFC leaves the marks separate.
        self.assertEqual(sanitise("a" * 38 + "q\u0301\u0302"), "a" * 38 + "q")
        self.assertEqual(sanitise("q" * 39 + "\u0301\u0302"), "q" * 39)

    def test_cut_then_trims_again(self) -> None:
        self.assertEqual(sanitise("a" * 39 + " b"), "a" * 39)
        self.assertEqual(sanitise("a" * 38 + ". b"), "a" * 38)
        self.assertEqual(sanitise("a" * 38 + " \u0301b"), "a" * 38)

    def test_marks_survive_when_nothing_is_cut(self) -> None:
        # सीता ends in a vowel sign (Mc); stripping it would change the word.
        self.assertEqual(sanitise("सीता"), "सीता")
        self.assertEqual(sanitise("a" * 36 + "सीता"), "a" * 36 + "सीता")

    def test_idempotent(self) -> None:
        for raw in ("  Café\u202e<x>  ", "a" * 38 + FAMILY, "1\ufe0f\u20e3", "\U0001f600\u200d", "...a..."):
            with self.subTest(raw=raw):
                once = sanitise(raw)
                self.assertEqual(sanitise(once), once)

    def test_only_allowed_characters_survive_any_input(self) -> None:
        # Every code point, in chunks, so no category slips through the allowlist.
        allowed_punctuation = set("-_()'.,&! ")
        for start in range(0, 0x110000, 32):
            raw = "".join(chr(code) for code in range(start, min(start + 32, 0x110000)))
            name = sanitise(raw)
            self.assertLessEqual(len(name), MAX_NAME_POINTS)
            self.assertNotEqual(name, "")
            for char in name:
                category = unicodedata.category(char)
                ok = category[0] in "LMN" or category == "So" or char in allowed_punctuation or char in (ZWJ, VS16)
                self.assertTrue(ok, f"U+{ord(char):04X} ({category}) survived")
                self.assertNotIn(char, FORBIDDEN)
                self.assertNotIn(category, ("Cc", "Cs", "Co", "Cn", "Zl", "Zp"))
                if category == "Cf":
                    self.assertEqual(char, ZWJ)
            self.assertFalse(name.startswith((" ", ".")) or name.endswith((" ", ".")), repr(name))


class AsciiFallbackTest(unittest.TestCase):
    def test_folds_accents(self) -> None:
        self.assertEqual(ascii_fallback("Café Crème"), "Cafe Creme")
        self.assertEqual(ascii_fallback("Ångström naïve"), "Angstrom naive")
        self.assertEqual(ascii_fallback("\ufb01ne"), "fine")  # fi ligature, via NFKD

    def test_replaces_the_rest(self) -> None:
        self.assertEqual(ascii_fallback("Привет"), "______")
        self.assertEqual(ascii_fallback("Ærø"), "_r_")
        self.assertEqual(ascii_fallback("Mum \U0001f600"), "Mum _")
        name = "Rock & Roll (live) - it's ok, fine_now!"
        self.assertEqual(ascii_fallback(name), name)

    def test_compatibility_forms_cannot_smuggle_separators(self) -> None:
        # U+2100 ACCOUNT OF is So, so the sanitiser keeps it, and NFKD makes it 'a/c'.
        self.assertEqual(sanitise("\u2100"), "\u2100")
        self.assertEqual(ascii_fallback("\u2100"), "a_c")
        self.assertEqual(ascii_fallback("\u2474"), "(1)")  # PARENTHESIZED DIGIT ONE
        self.assertEqual(ascii_fallback("\u00bd"), "1_2")  # VULGAR FRACTION ONE HALF: fraction slash

    def test_never_empty(self) -> None:
        self.assertEqual(sanitise("\u0301"), "\u0301")
        self.assertEqual(ascii_fallback("\u0301"), "ringtone")

    def test_stays_ascii_for_any_sanitised_name(self) -> None:
        safe = re.compile(r"[A-Za-z0-9 \-_()'.,&!]+")
        for start in range(0, 0x110000, 32):
            raw = "".join(chr(code) for code in range(start, min(start + 32, 0x110000)))
            fallback = ascii_fallback(sanitise(raw))
            self.assertTrue(fallback.isascii())
            self.assertRegex(fallback, safe)


ROUND_TRIP_NAMES = (
    "ringtone",
    "My Tone",
    "Café Crème",
    "Rock & Roll (live) - it's ok, fine_now!",
    "日本語のテスト",
    "नमस्ते",
    FAMILY,
    f"Mum {HEART}",
    "a" * 38 + "\U0001f468",
    "50% off",
)


class ContentDispositionTest(unittest.TestCase):
    def test_exact_format(self) -> None:
        self.assertEqual(
            content_disposition("My Tone", "m4a"),
            "attachment; filename=\"My Tone.m4a\"; filename*=UTF-8''My%20Tone.m4a",
        )
        self.assertEqual(
            content_disposition("Café", "m4r"),
            "attachment; filename=\"Cafe.m4r\"; filename*=UTF-8''Caf%C3%A9.m4r",
        )

    def test_round_trip(self) -> None:
        for raw in ROUND_TRIP_NAMES:
            name = sanitise(raw)
            for extension in ("m4a", "m4r"):
                with self.subTest(name=name, extension=extension):
                    header = content_disposition(name, extension)
                    self.assertTrue(header.isascii())
                    self.assertNotIn("\r", header)
                    self.assertNotIn("\n", header)
                    disposition, plain, star = header.split("; ")
                    self.assertEqual(disposition, "attachment")
                    # The whole header, as a mail parser reads it: filename comes first.
                    message = email.message.Message()
                    message["Content-Disposition"] = header
                    self.assertEqual(message.get_content_disposition(), "attachment")
                    self.assertEqual(message.get_filename(), f"{ascii_fallback(name)}.{extension}")
                    # filename* alone, decoded per RFC 2231/8187 by the parser.
                    star_only = email.message.Message()
                    star_only["Content-Disposition"] = f"attachment; {star}"
                    self.assertEqual(star_only.get_filename(), f"{name}.{extension}")
                    # And decoded by hand.
                    prefix = "filename*=UTF-8''"
                    self.assertTrue(star.startswith(prefix))
                    value = star[len(prefix):]
                    self.assertRegex(value, r"[A-Za-z0-9%._~-]+")
                    self.assertEqual(unquote(value, errors="strict"), f"{name}.{extension}")
                    self.assertEqual(plain, f'filename="{ascii_fallback(name)}.{extension}"')

    def test_unsanitised_input_still_yields_a_safe_header(self) -> None:
        # Defence in depth: the server only passes sanitised names, but the
        # header must not depend on that.
        header = content_disposition('a/b"c\\d;e\r\nX: y', "m4a")
        self.assertEqual(
            header,
            "attachment; filename=\"a_b_c_d_e__X_ y.m4a\"; "
            "filename*=UTF-8''a%2Fb%22c%5Cd%3Be%0D%0AX%3A%20y.m4a",
        )

    def test_extension_is_checked(self) -> None:
        for extension in ("", "M4A", 'm4a"; x', "m4a\r\nSet-Cookie: x", "../x", "toolongext"):
            with self.subTest(extension=extension):
                with self.assertRaises(ValueError):
                    content_disposition("x", extension)


class NoFilesystemUseTest(unittest.TestCase):
    def test_module_does_no_io(self) -> None:
        # The name never becomes a path or a log line: the module has nothing
        # that could open a file or write one.
        source = Path(names.__file__).read_text(encoding="utf-8")
        for word in ("open(", "import os", "pathlib", "shutil", "logging", "print(", "sys.std"):
            self.assertNotIn(word, source)


if __name__ == "__main__":
    unittest.main()
