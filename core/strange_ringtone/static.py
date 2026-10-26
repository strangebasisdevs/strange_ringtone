"""The web app's files, loaded into memory once at startup (docs/PLAN.md 5.1).

Nothing under static/ is read at request time. The routes look names up in a
dict built from a fixed allowlist, so no request path ever reaches the
filesystem: there is no path to traverse, no symlink to follow and no file that
appears later and gets served.
"""
from __future__ import annotations

import html
import re
from pathlib import Path

from strange_ringtone.config import Settings

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

# Name -> Content-Type. Every response sets the type explicitly, and with
# nosniff the browser never guesses one, so a file can only ever run as what it
# is listed as here.
ALLOWED = {
    "index.html": "text/html; charset=utf-8",
    "app.js": "text/javascript; charset=utf-8",
    "style.css": "text/css; charset=utf-8",
}

# index.html is a template rendered once with the settings, and is never
# served raw: GET / serves the rendered copy.
_TEMPLATE = "index.html"
_TOKEN_RE = re.compile(r"\{\{([a-z_]+)\}\}")


class StaticFiles:
    """The allowlisted files as bytes, read at construction and never again."""

    def __init__(self, directory: Path | None = None) -> None:
        # Resolved at call time rather than as a default argument, so tests can
        # point it at a copy they delete afterwards.
        directory = STATIC_DIR if directory is None else directory
        self._files: dict[str, tuple[bytes, str]] = {}
        for name, content_type in ALLOWED.items():
            # A missing file fails startup rather than turning into a 404 later.
            with open(directory / name, "rb") as handle:
                self._files[name] = (handle.read(), content_type)

    def get(self, name: str) -> tuple[bytes, str] | None:
        """(body, Content-Type) for an allowlisted asset, or None."""
        if name == _TEMPLATE:
            return None
        return self._files.get(name)

    def render_index(self, settings: Settings) -> bytes:
        """The index page with the settings in its {{placeholders}}, HTML-escaped."""
        values = {
            "max_clip_seconds": str(settings.max_clip_seconds),
            "default_target_lufs": str(settings.default_target_lufs),
            "fetch_enabled": "true" if settings.fetch_enabled else "false",
            "source_url": settings.source_url,
            "version": settings.version,
            "static_prefix": "/static/" + settings.version,
        }

        def substitute(match: re.Match[str]) -> str:
            key = match.group(1)
            if key not in values:
                # A typo in the template would otherwise ship a literal
                # {{token}} to every visitor; failing here fails startup.
                raise ValueError(f"unknown placeholder in {_TEMPLATE}: {key}")
            # quote=True: every value lands inside a double-quoted attribute,
            # where an unescaped quote would end it and start new markup.
            return html.escape(values[key], quote=True)

        template = self._files[_TEMPLATE][0].decode("utf-8")
        return _TOKEN_RE.sub(substitute, template).encode("utf-8")
