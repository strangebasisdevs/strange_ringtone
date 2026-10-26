"""The page template and the client scripts keep the CSP's promises.

CLAUDE.md (Architecture invariants, Web): no inline script or style, no
third-party origins, and the client writes text with textContent only. The
CSP would block most violations in the browser, but silently: the page would
just break for the user. These checks fail the build instead.

They read the files on disk: the raw index.html template (placeholders and
all, so a value substituted at startup can't hide a problem in the markup) and
every *.js under core/static. Each rule is a small auditor, and each auditor is
tested on a bad sample, so removing or loosening a rule fails a test.
"""
from __future__ import annotations

import html.parser
import posixpath
import re
import unittest
from pathlib import Path

import helpers
from strange_ringtone import static

STATIC_DIR = helpers.ROOT / "core" / "static"
TEMPLATE = STATIC_DIR / "index.html"
PREFIX = "{{static_prefix}}/"
SOURCE_URL = "{{source_url}}"

# Attributes whose value the browser resolves as a URL.
URL_ATTRIBUTES = frozenset({
    "href", "src", "action", "formaction", "poster", "data", "srcset", "background", "cite", "ping",
    "manifest", "icon", "longdesc", "xlink:href",
})
# Elements that load or embed other documents, change where relative URLs
# point, or submit somewhere; the page needs none of them.
FORBIDDEN_ELEMENTS = frozenset({"base", "iframe", "frame", "frameset", "object", "embed", "applet", "form", "portal"})
# Schemes that run code or smuggle content past the allowlist. Whitespace and
# control characters are dropped first, as browsers do inside a scheme.
SCHEME_RE = re.compile(r"(?:javascript|vbscript|data|blob|filesystem):", re.IGNORECASE)
ABSOLUTE_URL_RE = re.compile(r"https?:", re.IGNORECASE)
ID_CALL_RE = re.compile(r"""\bbyId\(\s*["']([^"']+)["']\s*\)""")


class _Page(html.parser.HTMLParser):
    """Every start tag with its attributes, and the text inside script and style."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.elements: list[tuple[str, list[tuple[str, str | None]]]] = []
        self.raw_text: dict[int, str] = {}
        self._open_raw: int | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.elements.append((tag, attrs))
        if tag in ("script", "style"):
            self._open_raw = len(self.elements) - 1
            self.raw_text[self._open_raw] = ""

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.elements.append((tag, attrs))

    def handle_endtag(self, tag: str) -> None:
        if tag in ("script", "style"):
            self._open_raw = None

    def handle_data(self, data: str) -> None:
        if self._open_raw is not None:
            self.raw_text[self._open_raw] += data


def _strip_for_scheme(value: str) -> str:
    return "".join(ch for ch in value if ch > " " and ch != "\x7f")


def _static_key(value: str) -> str | None:
    """The allowlist key a {{static_prefix}}/... reference names, if any."""
    if not value.startswith(PREFIX):
        return None
    return value[len(PREFIX):]


def audit_template(text: str) -> list[str]:
    """Problems with an index.html template; an empty list means it passes."""
    page = _Page()
    page.feed(text)
    page.close()
    problems: list[str] = []
    if ABSOLUTE_URL_RE.search(text):
        # The Source link's URL arrives through {{source_url}}; nothing else
        # on the page may point off-site, the help text included.
        problems.append("an http(s) URL in the template")
    youtube_hidden: bool | None = None
    for index, (tag, attrs) in enumerate(page.elements):
        names = [name for name, _ in attrs]
        values = dict(attrs)
        if tag in FORBIDDEN_ELEMENTS:
            problems.append(f"<{tag}> element")
        if tag == "meta" and "http-equiv" in values:
            problems.append("<meta http-equiv>")
        if tag == "style":
            problems.append("<style> element")
        if tag == "script":
            if page.raw_text.get(index, "").strip():
                problems.append("inline script")
            if values.get("type") != "module":
                problems.append("script without type=module")
            if _static_key(values.get("src") or "") is None:
                problems.append("script src outside {{static_prefix}}/")
        for name in names:
            if name.startswith("on"):
                problems.append(f"event-handler attribute {name}")
            if name == "style":
                problems.append("style attribute")
        for name, value in attrs:
            if value is None:
                continue
            if SCHEME_RE.search(_strip_for_scheme(value)):
                problems.append(f"{name}= with a script or data scheme")
            if name in URL_ATTRIBUTES:
                key = _static_key(value)
                if key is not None:
                    if key not in static.ALLOWED or key == "index.html":
                        problems.append(f"{name}= names {key!r}, which is not served")
                elif not (value == SOURCE_URL and tag == "a" and name == "href"):
                    problems.append(f"{name}={value!r} is neither a static asset nor the Source link")
        if values.get("id") == "youtube":
            youtube_hidden = tag == "section" and "hidden" in names
    if youtube_hidden is None:
        problems.append("no YouTube section")
    elif not youtube_hidden:
        problems.append("the YouTube section is not hidden")
    return problems


def template_ids(text: str) -> list[str]:
    page = _Page()
    page.feed(text)
    page.close()
    return [value for _, attrs in page.elements for name, value in attrs if name == "id" and value is not None]


# Each pattern is a way to turn a string into markup or code, or to load
# something the allowlist doesn't cover. The scan reads comments too, so a
# comment has to name these some other way.
JS_FORBIDDEN = (
    (re.compile(r"\binnerHTML\b"), "innerHTML"),
    (re.compile(r"\bouterHTML\b"), "outerHTML"),
    (re.compile(r"\binsertAdjacentHTML\b"), "insertAdjacentHTML"),
    (re.compile(r"\bcreateContextualFragment\b"), "createContextualFragment"),
    (re.compile(r"\bdocument\s*\.\s*write(?:ln)?\b"), "document.write"),
    (re.compile(r"\beval\s*\("), "eval"),
    (re.compile(r"\bnew\s+Function\b"), "new Function"),
    (re.compile(r"\bFunction\s*\("), "Function()"),
    (re.compile(r"""\bset(?:Timeout|Interval)\s*\(\s*["'`]"""), "a timer with a string body"),
    (re.compile(r"\bsrcdoc\b"), "srcdoc"),
    (re.compile(r"""\bsetAttribute\s*\(\s*["'](?:src|href|style|on[a-z]*)["']""", re.IGNORECASE),
     "setAttribute of src, href, style or a handler"),
    (re.compile(r"\bcreateObjectURL\b"), "createObjectURL (blob: URLs, which the CSP blocks)"),
    (re.compile(r"""["'`]\s*(?:javascript|vbscript|data|blob):""", re.IGNORECASE), "a script, data or blob URL"),
    (re.compile(r"""["'`]https?://""", re.IGNORECASE), "an absolute URL"),
    (re.compile(r"\bimport\s*\("), "dynamic import"),
)
SRC_ASSIGN_RE = re.compile(r"\.src\s*=(?!=)\s*([^;\n]*)")
# Only a literal, same-origin path: "./x" or "/x", never "//host" or a scheme.
SAFE_SRC_RE = re.compile(r"""(["'])(?:\./|/(?!/))[^"'\\:]*\1""")
IMPORT_RE = re.compile(r"""^\s*(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']""",
                       re.MULTILINE)


def audit_js(text: str) -> list[str]:
    """Problems with one script; an empty list means it passes."""
    problems = [label for pattern, label in JS_FORBIDDEN if pattern.search(text)]
    for match in SRC_ASSIGN_RE.finditer(text):
        if not SAFE_SRC_RE.fullmatch(match.group(1).strip()):
            problems.append(f".src = {match.group(1).strip()!r}")
    return problems


def js_imports(text: str) -> list[str]:
    return [match.group(1) or match.group(2) for match in IMPORT_RE.finditer(text)]


def resolve_import(importer: str, specifier: str) -> str | None:
    """The allowlist key a relative import resolves to, or None if it isn't relative."""
    if not specifier.startswith(("./", "../")):
        return None
    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(importer), specifier))
    return None if resolved.startswith("../") else resolved


def js_files() -> dict[str, Path]:
    return {path.relative_to(STATIC_DIR).as_posix(): path for path in sorted(STATIC_DIR.rglob("*.js"))}


GOOD_TEMPLATE = (
    "<!doctype html><html><head>"
    '<link rel="stylesheet" href="{{static_prefix}}/style.css">'
    '<script type="module" src="{{static_prefix}}/app.js"></script>'
    "</head><body>"
    '<section id="youtube" hidden></section>'
    '<a href="{{source_url}}">Source</a>'
    "</body></html>"
)


class TemplateAuditTest(unittest.TestCase):
    """The auditor itself: it passes a clean page and catches each violation."""

    def test_good_sample_passes(self) -> None:
        self.assertEqual(audit_template(GOOD_TEMPLATE), [])

    def test_each_violation_is_caught(self) -> None:
        script = '<script type="module" src="{{static_prefix}}/app.js"></script>'
        cases = {
            "inline script": GOOD_TEMPLATE.replace(script, script.replace("></", ">alert(1)</")),
            "classic script": GOOD_TEMPLATE.replace(' type="module"', ""),
            "script elsewhere": GOOD_TEMPLATE.replace("{{static_prefix}}/app.js", "/app.js"),
            "style element": GOOD_TEMPLATE.replace("</head>", "<style>p{}</style></head>"),
            "empty style element": GOOD_TEMPLATE.replace("</head>", "<style></style></head>"),
            "style attribute": GOOD_TEMPLATE.replace("<section", '<section style="color:red"'),
            "handler": GOOD_TEMPLATE.replace("<a ", '<a onclick="x()" '),
            "upper-case handler": GOOD_TEMPLATE.replace("<a ", '<a ONCLICK="x()" '),
            "javascript link": GOOD_TEMPLATE.replace("{{source_url}}", "javascript:x()"),
            "split javascript link": GOOD_TEMPLATE.replace("{{source_url}}", "java\tscript:x()"),
            "data link": GOOD_TEMPLATE.replace("{{source_url}}", "data:text/html,x"),
            "external link": GOOD_TEMPLATE.replace("</body>", '<a href="https://example.internal/">x</a></body>'),
            "external text": GOOD_TEMPLATE.replace("</body>", "<p>see http://example.internal</p></body>"),
            "protocol-relative": GOOD_TEMPLATE.replace("</body>", '<img src="//example.internal/x.png"></body>'),
            "unlisted asset": GOOD_TEMPLATE.replace("style.css", "other.css"),
            "template as asset": GOOD_TEMPLATE.replace("style.css", "index.html"),
            "traversal asset": GOOD_TEMPLATE.replace("style.css", "audio/../style.css"),
            "relative link": GOOD_TEMPLATE.replace("</body>", '<a href="/api/result/x.m4a">x</a></body>'),
            "source placeholder in a script": GOOD_TEMPLATE.replace("{{static_prefix}}/app.js", "{{source_url}}"),
            "base": GOOD_TEMPLATE.replace("<head>", '<head><base href="{{static_prefix}}/style.css">'),
            "iframe": GOOD_TEMPLATE.replace("</body>", "<iframe></iframe></body>"),
            "form": GOOD_TEMPLATE.replace("</body>", "<form></form></body>"),
            "meta refresh": GOOD_TEMPLATE.replace("<head>", '<head><meta http-equiv="refresh" content="0">'),
            "youtube shown": GOOD_TEMPLATE.replace(" hidden>", ">"),
            "youtube missing": GOOD_TEMPLATE.replace(' id="youtube"', ""),
            "youtube not a section": GOOD_TEMPLATE.replace('<section id="youtube" hidden></section>',
                                                            '<div id="youtube" hidden></div>'),
        }
        for label, text in cases.items():
            with self.subTest(label):
                self.assertNotEqual(audit_template(text), [], label)


class TemplateTest(unittest.TestCase):
    def setUp(self) -> None:
        with open(TEMPLATE, encoding="utf-8") as handle:
            self.text = handle.read()

    def test_template_passes_the_audit(self) -> None:
        self.assertEqual(audit_template(self.text), [])

    def test_only_module_scripts_from_the_allowlist(self) -> None:
        page = _Page()
        page.feed(self.text)
        scripts = [dict(attrs) for tag, attrs in page.elements if tag == "script"]
        self.assertEqual(scripts, [{"type": "module", "src": "{{static_prefix}}/app.js"}])

    def test_ids_are_unique_and_cover_the_script(self) -> None:
        ids = template_ids(self.text)
        self.assertEqual(len(ids), len(set(ids)), "duplicate id")
        with open(STATIC_DIR / "app.js", encoding="utf-8") as handle:
            wanted = set(ID_CALL_RE.findall(handle.read()))
        self.assertTrue(wanted)
        self.assertEqual(sorted(wanted - set(ids)), [])

    def test_trimmer_controls(self) -> None:
        page = _Page()
        page.feed(self.text)
        by_id = {dict(attrs).get("id"): (tag, dict(attrs)) for tag, attrs in page.elements}
        self.assertEqual(by_id["file"], ("input", {"type": "file", "id": "file", "accept": "audio/*"}))
        self.assertEqual(by_id["waveform"][0], "canvas")
        for slider, value in (("fade-in", "0.2"), ("fade-out", "1.5")):
            self.assertEqual(by_id[slider][1]["min"], "0")
            self.assertEqual(by_id[slider][1]["max"], "5")
            self.assertEqual(by_id[slider][1]["value"], value)
        self.assertIn("checked", by_id["fade-in-on"][1])
        self.assertIn("checked", by_id["fade-out-on"][1])
        self.assertIn("checked", by_id["normalize"][1])
        self.assertEqual((by_id["target"][1]["min"], by_id["target"][1]["max"]), ("-24", "-9"))
        # Shown only when the target goes above -11 LUFS.
        self.assertIn("hidden", by_id["target-warning"][1])
        buttons = [dict(attrs) for tag, attrs in page.elements if tag == "button"]
        nudges = [(attrs["data-edge"], attrs["data-step"]) for attrs in buttons if "data-edge" in attrs]
        self.assertEqual(nudges, [(edge, step) for edge in ("start", "end") for step in ("-1", "-0.1", "0.1", "1")])
        # Nothing on the page submits anywhere.
        self.assertNotIn("form", [tag for tag, _ in page.elements])

    def test_help_text(self) -> None:
        text = re.sub(r"\s+", " ", self.text)
        for phrase in (
            "Use as Ringtone",
            "Safari's downloads list",
            "Duplicate Ringtone",
            "Settings &gt; Sounds &amp; Haptics &gt; Ringtone (or Text Tone), swipe left",
            "If you hear nothing, turn off Silent mode.",
        ):
            self.assertIn(phrase, text)


def css_declarations(text: str, selector: str) -> dict[str, str]:
    """The declarations every rule naming exactly `selector` sets, later ones winning."""
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
    found: dict[str, str] = {}
    for selectors, body in re.findall(r"([^{}]+)\{([^{}]*)\}", text):
        if selector not in (part.strip() for part in selectors.split(",")):
            continue
        for declaration in body.split(";"):
            name, colon, value = declaration.partition(":")
            if colon:
                found[name.strip().lower()] = value.strip().lower()
    return found


class TouchTest(unittest.TestCase):
    """Done criterion 1: the handles can be dragged with a finger on iOS."""

    def test_canvas_takes_the_touch_gestures(self) -> None:
        # Without touch-action: none iOS scrolls or zooms the page while a
        # handle is dragged; without user-select a long press selects it.
        with open(STATIC_DIR / "style.css", encoding="utf-8") as handle:
            rules = css_declarations(handle.read(), "#waveform")
        self.assertEqual(rules.get("touch-action"), "none")
        self.assertEqual(rules.get("user-select"), "none")
        self.assertEqual(rules.get("-webkit-user-select"), "none")

    def test_css_reader(self) -> None:
        css = "/* #waveform { touch-action: auto } */ a, #waveform { touch-action: none } #waveform { color: red; }"
        self.assertEqual(css_declarations(css, "#waveform"), {"touch-action": "none", "color": "red"})
        self.assertEqual(css_declarations("#waveform-x { touch-action: none }", "#waveform"), {})
        self.assertEqual(css_declarations("#waveform { touch-action: none } #waveform { touch-action: auto }",
                                          "#waveform")["touch-action"], "auto")

    def test_handles_have_44px_hit_areas(self) -> None:
        # Apple's minimum touch target; the handles are drawn thinner.
        with open(STATIC_DIR / "waveform.js", encoding="utf-8") as handle:
            text = handle.read()
        match = re.search(r"^const HANDLE_HIT_CSS_PX = (\d+);$", text, re.MULTILINE)
        self.assertIsNotNone(match)
        assert match is not None
        self.assertGreaterEqual(int(match.group(1)), 44)
        self.assertIn("const reach = HANDLE_HIT_CSS_PX / 2;", text)


class JsAuditTest(unittest.TestCase):
    """The scanner itself: each forbidden construct in a sample is caught."""

    def test_clean_sample_passes(self) -> None:
        sample = (
            'import { x } from "./audio/wav.js";\n'
            'element.textContent = name;\n'
            'input.value = "x";\n'
            'image.src = "./icon.png";\n'
            'link.href = "/api/result/" + id + ".m4r";\n'
            'setTimeout(() => run(), 100);\n'
        )
        self.assertEqual(audit_js(sample), [])

    def test_each_construct_is_caught(self) -> None:
        cases = [
            "element.innerHTML = name;",
            "element.outerHTML = name;",
            'element.insertAdjacentHTML("beforeend", name);',
            "range.createContextualFragment(name);",
            "document.write(name);",
            "document . writeln(name);",
            "eval(code);",
            'const f = new Function("return 1");',
            'const f = Function("return 1");',
            'setTimeout("run()", 10);',
            "setInterval(`run()`, 10);",
            "frame.srcdoc = name;",
            'element.setAttribute("src", url);',
            "element.setAttribute('onclick', code);",
            'element.setAttribute("style", css);',
            "audio.src = URL.createObjectURL(blob);",
            "audio.src = url;",
            'audio.src = "https://example.internal/x.m4a";',
            'audio.src = "//example.internal/x.m4a";',
            'audio.src = "javascript:x()";',
            'link.href = "javascript:x()";',
            'fetch("https://example.internal/api");',
            'const u = "data:text/html,x";',
            'const m = await import("./audio/wav.js");',
        ]
        for sample in cases:
            with self.subTest(sample):
                self.assertNotEqual(audit_js(sample), [], sample)

    def test_imports_are_read(self) -> None:
        sample = 'import { a } from "./a.js";\nimport "./b.js";\nexport { c } from "../c.js";\n'
        self.assertEqual(js_imports(sample), ["./a.js", "./b.js", "../c.js"])
        self.assertEqual(resolve_import("audio/x.js", "../app.js"), "app.js")
        self.assertEqual(resolve_import("app.js", "./audio/wav.js"), "audio/wav.js")
        self.assertIsNone(resolve_import("app.js", "/static/dev/app.js"))
        self.assertIsNone(resolve_import("app.js", "wav"))
        self.assertIsNone(resolve_import("app.js", "../outside.js"))


class JsFilesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.files = js_files()
        self.texts: dict[str, str] = {}
        for name, path in self.files.items():
            with open(path, encoding="utf-8") as handle:
                self.texts[name] = handle.read()

    def test_every_script_passes_the_scan(self) -> None:
        self.assertIn("app.js", self.files)
        for name, text in self.texts.items():
            with self.subTest(name):
                self.assertEqual(audit_js(text), [])

    def test_every_script_is_served(self) -> None:
        # A module that exists but isn't allowlisted would 404 in the browser.
        self.assertEqual(sorted(set(self.files) - set(static.ALLOWED)), [])

    def test_imports_are_relative_and_allowlisted(self) -> None:
        # Relative imports resolve under any VERSION; a bare or absolute
        # specifier would need an import map or reach another origin.
        for name, text in self.texts.items():
            for specifier in js_imports(text):
                with self.subTest(module=name, specifier=specifier):
                    key = resolve_import(name, specifier)
                    self.assertIsNotNone(key, "not a relative import")
                    self.assertIn(key, static.ALLOWED)

    def test_ui_modules_import_the_audio_modules(self) -> None:
        wanted = {"./audio/decode.js", "./audio/loudness.js", "./audio/request.js", "./audio/suggest.js",
                  "./audio/wav.js", "./player.js", "./share.js", "./waveform.js"}
        self.assertEqual(wanted - set(js_imports(self.texts["app.js"])), set())


if __name__ == "__main__":
    unittest.main()
