// The name of a tone made on the device (core/static/audio/names.js): the
// server's rules (names.py), answered alike by both.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { DEFAULT_NAME, MAX_NAME_POINTS, sanitise, toneName } from "../../core/static/audio/names.js";
import { toneNameHeader } from "../../core/static/audio/request.js";

// The one file tests/test_names.py reads too, so names.py and names.js are
// held to the same answers.
const VECTORS = JSON.parse(readFileSync(new URL("../name_vectors.json", import.meta.url), "utf8")).sanitise;

const point = (code) => String.fromCodePoint(code);
const ZWJ = point(0x200d);
const VS16 = point(0xfe0f);
const GRIN = point(0x1f600);
const BACKSLASH = point(0x5c);
const FORBIDDEN = new Set(["/", BACKSLASH, '"', "*", ":", "<", ">", "?", "|"]);
const ALLOWED_ASCII = new Set("-_()'.,&! ");

test("the constants are the server's", () => {
  assert.equal(DEFAULT_NAME, "ringtone");
  assert.equal(MAX_NAME_POINTS, 40);
});

test("every shared vector comes out as names.py answers it", () => {
  // Guards the file itself: an emptied list would pass everything below.
  assert.ok(VECTORS.length >= 200, `only ${VECTORS.length} vectors`);
  for (const [raw, expected] of VECTORS) {
    assert.equal(sanitise(raw), expected, `sanitise(${JSON.stringify(raw)})`);
  }
});

test("the vectors cover every rule the sanitiser has", () => {
  // A rule with no vector could be dropped from either implementation unseen.
  const raws = VECTORS.map(([raw]) => raw);
  const some = (label, predicate) => assert.ok(raws.some(predicate), `no vector for ${label}`);
  some("a control", (raw) => /\p{Cc}/u.test(raw));
  some("a bidi override", (raw) => raw.includes(point(0x202e)));
  some("a path separator", (raw) => raw.includes("/") && raw.includes(BACKSLASH));
  some("a no-break space", (raw) => raw.includes(point(0xa0)));
  some("a lone surrogate", (raw) => /\p{Cs}/u.test(raw));
  some("private use", (raw) => /\p{Co}/u.test(raw));
  some("a joiner away from an emoji", (raw) => raw === "a" + ZWJ + "b");
  some("a joiner next to an emoji", (raw) => raw === GRIN + ZWJ);
  some("a selector away from an emoji", (raw) => raw === "a" + VS16 + "b");
  some("more than the cap", (raw) => Array.from(raw).length > MAX_NAME_POINTS);
  some("a cut that leaves a joiner", (raw) => Array.from(raw)[MAX_NAME_POINTS - 1] === ZWJ);
  some("a cut that leaves a mark", (raw) => /^\p{M}$/u.test(Array.from(raw)[MAX_NAME_POINTS - 1] ?? ""));
  some("a cut that leaves a space", (raw) => Array.from(raw)[MAX_NAME_POINTS - 1] === " ");
  // Found by a mutation pass: with no such case, "emoji" could widen to any
  // symbol, and the cut could stop at one mark or at nonspacing marks only.
  some("a joiner next to a symbol that is not an emoji", (raw) => raw === "a" + ZWJ + "+");
  some("a cut that leaves a spacing mark", (raw) => /^\p{Mc}$/u.test(Array.from(raw)[MAX_NAME_POINTS - 1] ?? ""));
  some("a cut that leaves an enclosing mark", (raw) => /^\p{Me}$/u.test(Array.from(raw)[MAX_NAME_POINTS - 1] ?? ""));
  some("a cut that leaves two marks", (raw) => {
    const points = Array.from(raw);
    return points.length > MAX_NAME_POINTS && /^\p{M}$/u.test(points[MAX_NAME_POINTS - 1])
      && /^\p{M}$/u.test(points[MAX_NAME_POINTS - 2]) && !/^\p{M}$/u.test(points[0]);
  });
  some("nothing but marks, past the cap", (raw) => Array.from(raw).length > MAX_NAME_POINTS && /^\p{M}+$/u.test(raw));
  some("leading and trailing dots", (raw) => raw.startsWith("  ..") && raw.endsWith("..  "));
  some("something that needs NFC", (raw) => raw.normalize("NFC") !== raw);
  for (let code = 0; code < 128; code += 1) {
    some(`ASCII ${code}`, (raw) => raw === "a" + point(code) + "b");
  }
});

test("sanitising twice changes nothing", () => {
  for (const [raw] of VECTORS) {
    const once = sanitise(raw);
    assert.equal(sanitise(once), once, JSON.stringify(raw));
  }
});

test("the cap counts code points, not UTF-16 units", () => {
  // 40 emoji are 80 units: a cut by units would stop at 20, or split one.
  const name = sanitise(GRIN.repeat(41));
  assert.equal(Array.from(name).length, 40);
  assert.equal(name, GRIN.repeat(40));
});

test("only allowed characters survive any input", () => {
  // Every code point, in chunks, by this engine's own Unicode tables: no
  // category slips through the allowlist, whatever the version.
  const refused = /[\p{Cc}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;
  const kept = /^[\p{L}\p{M}\p{N}\p{So}]$/u;
  for (let start = 0; start < 0x110000; start += 32) {
    let raw = "";
    for (let code = start; code < Math.min(start + 32, 0x110000); code += 1) raw += point(code);
    const name = sanitise(raw);
    const points = Array.from(name);
    assert.ok(points.length >= 1 && points.length <= MAX_NAME_POINTS, `length from U+${start.toString(16)}`);
    assert.ok(!refused.test(name), `a refused category survived from U+${start.toString(16)}`);
    for (const char of points) {
      const ok = kept.test(char) || ALLOWED_ASCII.has(char) || char === ZWJ || char === VS16;
      assert.ok(ok, `U+${char.codePointAt(0).toString(16)} survived`);
      assert.ok(!FORBIDDEN.has(char), `forbidden ${JSON.stringify(char)} survived`);
      if (/^\p{Cf}$/u.test(char)) assert.equal(char, ZWJ);
    }
    assert.ok(!/^[ .]|[ .]$/.test(name), `${JSON.stringify(name)} starts or ends with a space or a dot`);
  }
});

test("a name is never a hidden file, a path or empty", () => {
  for (const raw of [".bashrc", "..", "../x", "a/../b", BACKSLASH + BACKSLASH + "host" + BACKSLASH + "share", ""]) {
    const name = sanitise(raw);
    assert.ok(name.length > 0);
    assert.ok(!name.startsWith("."), JSON.stringify(raw));
    assert.ok(!name.includes("/") && !name.includes(BACKSLASH), JSON.stringify(raw));
  }
  assert.equal(sanitise(".."), DEFAULT_NAME);
});

test("something that is not a string is read as its text", () => {
  assert.equal(sanitise(42), "42");
  assert.equal(sanitise(null), "null");
});

test("toneName is what the server makes of the header the page would send", () => {
  for (const [raw, expected] of VECTORS) {
    // The page trims and drops broken surrogates before it encodes; the
    // server then sanitises. For these cases that changes no answer.
    assert.equal(toneName(raw), expected, `toneName(${JSON.stringify(raw)})`);
  }
});

test("toneName gives the default where the page would send no header", () => {
  for (const typed of ["", "   ", undefined, null, 42, point(0xd800)]) {
    assert.equal(toneNameHeader(typed), null, JSON.stringify(typed));
    assert.equal(toneName(typed), DEFAULT_NAME, JSON.stringify(typed));
  }
});

test("toneName reads no further than the 512 bytes the header holds", () => {
  // 600 dropped characters and then letters: the header ends inside the
  // dropped ones, so the server never sees the letters. Sanitising the whole
  // text would keep them, and the two ways of rendering would disagree.
  const typed = "<".repeat(600) + "late";
  assert.equal(sanitise(typed), "late");
  assert.equal(toneName(typed), DEFAULT_NAME);
  // The cut is on whole code points of the encoded form.
  const accents = point(0xe9).repeat(200);
  assert.equal(toneNameHeader(accents).length, 510);
  assert.equal(toneName(accents), point(0xe9).repeat(40));
});
