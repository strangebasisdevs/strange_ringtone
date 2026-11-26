// The name of a tone made on the device (docs/PLAN.md 15.4, the rules of 5.6).
//
// iOS shows the file's name as the ringtone's name, so what the user typed
// becomes a file name on their phone. The server's names.py reduces it to an
// allowlist of characters rather than escaping it. Where the page makes the
// tone itself there is no server to do that, so the same rules live here.
// tests/name_vectors.json holds cases both implementations must answer
// alike (tests/test_names.py and tests/js/names.test.mjs read the one file).
//
// One difference no test can remove: which characters are letters, marks,
// numbers and symbols comes from the Unicode tables of whatever runs the
// code. A character added in a newer Unicode version is a letter to a browser
// that knows it and unassigned, so dropped, to a Python that does not. What
// is dropped for safety is the same everywhere: controls, format characters
// (the bidi overrides among them), line separators, surrogates, private use,
// path separators and the reserved ASCII punctuation.
import { toneNameHeader } from "./request.js";

export const DEFAULT_NAME = "ringtone";
export const MAX_NAME_POINTS = 40;

const ZWJ = "\u200d";
const VS16 = "\ufe0f";
// The only ASCII punctuation a name keeps (names.py PUNCTUATION). Each is
// harmless in a file name on iOS, macOS, Windows and Linux.
const PUNCTUATION = new Set("-_()'.,&!");
// General categories L*, M*, N* and So, as names.py keeps them. So is where
// the emoji are.
const KEPT_RE = /^[\p{L}\p{M}\p{N}\p{So}]$/u;
const EMOJI_RE = /^\p{So}$/u;
const MARK_RE = /^\p{M}$/u;
const SPACE_RE = /^\p{Zs}$/u;

function trim(name) {
  // Leading dots hide a file on Unix-like systems; trailing dots and spaces
  // are stripped by Windows and confuse the extension.
  return name.replace(/^[ .]+|[ .]+$/g, "");
}

/**
 * Reduce raw to the characters that section 5.6 of docs/PLAN.md allows.
 * Never returns "".
 * @param {string} raw any text
 * @returns {string} at most MAX_NAME_POINTS code points
 */
export function sanitise(raw) {
  // By code point, as names.py walks a str: a UTF-16 unit is not a character.
  const text = Array.from(String(raw).normalize("NFC"));
  const kept = [];
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    // ZWJ and VS16 first: VS16 is a mark (Mn) and would otherwise pass as
    // one. Away from an emoji they are invisible characters that can make two
    // names look identical, so they only stay next to one.
    if (char === ZWJ || char === VS16) {
      const before = kept.length > 0 ? kept[kept.length - 1] : "";
      const after = i + 1 < text.length ? text[i + 1] : "";
      if (EMOJI_RE.test(before) || EMOJI_RE.test(after)) kept.push(char);
      continue;
    }
    if (KEPT_RE.test(char) || PUNCTUATION.has(char)) {
      kept.push(char);
    } else if (SPACE_RE.test(char)) {
      // No-break, ideographic and other spaces all become a plain space.
      kept.push(" ");
    }
    // Everything else is dropped.
  }
  let name = trim(kept.join("").replace(/ +/g, " "));
  let points = Array.from(name);
  if (points.length > MAX_NAME_POINTS) {
    points = points.slice(0, MAX_NAME_POINTS);
    // The cut may have split a sequence. A joiner, selector or mark left at
    // the end attaches to nothing, so it goes too.
    while (points.length > 0) {
      const last = points[points.length - 1];
      if (last !== ZWJ && last !== VS16 && !MARK_RE.test(last)) break;
      points.pop();
    }
    name = trim(points.join(""));
  }
  return name === "" ? DEFAULT_NAME : name;
}

/**
 * The name a tone made on this device gets from what the user typed: what
 * the server makes of the same text. The text goes through the header the
 * page would have sent (trimmed, NFC, at most 512 bytes when encoded) and is
 * then sanitised, so both ways of rendering name a tone alike.
 * @param {string} typed the name field's value
 * @returns {string} never empty; without an extension
 */
export function toneName(typed) {
  const header = toneNameHeader(typed);
  // No header is what the server answers with its default name.
  if (header === null) return DEFAULT_NAME;
  return sanitise(decodeURIComponent(header));
}
