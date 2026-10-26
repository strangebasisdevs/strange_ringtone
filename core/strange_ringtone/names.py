"""Tone names: the X-Tone-Name header and the download filename (docs/PLAN.md 5.6).

iOS shows the downloaded file's name as the ringtone's name, so the name the
user typed has to survive as a filename. It is untrusted text that ends up in a
response header and on the user's phone, so it is reduced to an allowlist of
characters rather than escaped: whatever is not positively known to be harmless
in a filename (controls, bidi overrides, path separators, reserved characters)
is dropped.

The name is never part of a filesystem path, a URL or a log line. Results are
stored under random IDs and the name is held in memory only.
"""
from __future__ import annotations

import re
import unicodedata
from urllib.parse import quote, unquote

from .http_guard import GuardError

DEFAULT_NAME = "ringtone"
MAX_HEADER_BYTES = 512
MAX_NAME_POINTS = 40

ZWJ = "‍"
VS16 = "️"
# The only ASCII punctuation a name keeps. Each is harmless in a filename on
# iOS, macOS, Windows and Linux, and none has a meaning in a quoted-string.
PUNCTUATION = frozenset("-_()'.,&!")
# What the raw header may contain: visible ASCII only. A browser's
# encodeURIComponent never produces anything else, and refusing raw bytes
# >= 0x80 means there is no question of which charset the header was meant in.
_HEADER_RE = re.compile(r"[\x21-\x7e]*")
_SPACES_RE = re.compile(" +")
_EXTENSION_RE = re.compile(r"[a-z0-9]{1,8}")


def parse_tone_name(values: list[str]) -> str:
    """Return the sanitised name from every X-Tone-Name header the request carried.

    No header means the default name. More than one is refused, because a proxy
    and this server might each pick a different one; so is an oversized header,
    anything but visible ASCII, and percent-encoding that is not valid UTF-8.
    """
    if not values:
        return DEFAULT_NAME
    if len(values) != 1:
        raise GuardError(400, "bad_name")
    value = values[0]
    # http.server hands header values over as latin-1 text, so one character is
    # one byte here and the length is the header's size in bytes.
    if len(value) > MAX_HEADER_BYTES or not _HEADER_RE.fullmatch(value):
        raise GuardError(400, "bad_name")
    try:
        # unquote, not unquote_plus: encodeURIComponent writes a space as %20,
        # and a literal + is a plus sign.
        decoded = unquote(value, encoding="utf-8", errors="strict")
    except UnicodeDecodeError:
        raise GuardError(400, "bad_name") from None
    return sanitise(decoded)


def _is_emoji(char: str) -> bool:
    return unicodedata.category(char) == "So"


def sanitise(raw: str) -> str:
    """Reduce raw to the characters docs/PLAN.md 5.6 allows; never returns ''."""
    text = unicodedata.normalize("NFC", raw)
    kept: list[str] = []
    for index, char in enumerate(text):
        # ZWJ and VS16 first: VS16 is category Mn and would otherwise pass as a
        # combining mark. Away from an emoji they are invisible characters that
        # can make two names look identical, so they only stay next to one.
        if char in (ZWJ, VS16):
            after = text[index + 1] if index + 1 < len(text) else ""
            if (kept and _is_emoji(kept[-1])) or (after and _is_emoji(after)):
                kept.append(char)
            continue
        category = unicodedata.category(char)
        if category[0] in "LMN" or category == "So" or char in PUNCTUATION:
            kept.append(char)
        elif category == "Zs":
            # No-break, ideographic and other spaces all become a plain space.
            kept.append(" ")
        # Everything else is dropped: controls (CR/LF among them), format
        # characters (bidi overrides, tag characters), surrogates, private use,
        # unassigned code points, path separators and " * : < > ? |.
    name = _trim(_SPACES_RE.sub(" ", "".join(kept)))
    if len(name) > MAX_NAME_POINTS:
        name = name[:MAX_NAME_POINTS]
        # The cut may have split a sequence. A joiner, selector or mark left at
        # the end attaches to nothing, so it goes too.
        while name and (name[-1] in (ZWJ, VS16) or unicodedata.category(name[-1])[0] == "M"):
            name = name[:-1]
        name = _trim(name)
    return name or DEFAULT_NAME


def _trim(name: str) -> str:
    # Leading dots hide a file on Unix-like systems; trailing dots and spaces are
    # stripped by Windows and confuse the extension.
    return name.strip(" .")


def _ascii_safe(char: str) -> bool:
    return char.isascii() and (char.isalnum() or char == " " or char in PUNCTUATION)


def ascii_fallback(name: str) -> str:
    """The name for clients that ignore filename*: accents folded, the rest '_'.

    Only the characters the sanitiser allows in ASCII survive, because NFKD can
    turn a kept symbol into a path separator (U+2100 ACCOUNT OF becomes 'a/c').
    """
    folded = "".join(
        char for char in unicodedata.normalize("NFKD", name) if unicodedata.category(char)[0] != "M"
    )
    fallback = "".join(char if _ascii_safe(char) else "_" for char in folded)
    return fallback or DEFAULT_NAME


def content_disposition(name: str, extension: str) -> str:
    """attachment with an ASCII filename and the UTF-8 name in filename* (RFC 6266, RFC 8187)."""
    # The extension is chosen by the server, never by the client; this keeps it so.
    if not _EXTENSION_RE.fullmatch(extension):
        raise ValueError("bad extension")
    # quote with safe='' leaves only letters, digits and _.-~, all RFC 8187
    # attr-chars, so the value needs no further quoting.
    return (
        f'attachment; filename="{ascii_fallback(name)}.{extension}"; '
        f"filename*=UTF-8''{quote(name, safe='')}.{extension}"
    )
