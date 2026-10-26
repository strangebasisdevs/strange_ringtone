// The initial selection, docs/PLAN.md 7.2 rule 3 (core/static/audio/suggest.js).
import { test } from "node:test";
import assert from "node:assert/strict";

import { suggestSelection } from "../../core/static/audio/suggest.js";

const RATE = 44100;

// Builds a mono signal from [seconds, amplitude] sections of a 440 Hz sine;
// amplitude 0 is digital silence.
function sections(...parts) {
  const total = parts.reduce((sum, [seconds]) => sum + Math.round(seconds * RATE), 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const [seconds, amplitude] of parts) {
    const n = Math.round(seconds * RATE);
    for (let i = 0; i < n; i += 1) {
      out[at + i] = amplitude * Math.sin((2 * Math.PI * 440 * (at + i)) / RATE);
    }
    at += n;
  }
  return out;
}

function near(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} is not within ${tolerance} of ${expected}`);
}

test("the loudest window wins: quiet, loud, quiet", () => {
  const signal = sections([20, 0.01], [15, 0.5], [25, 0.01]);
  const { start, end } = suggestSelection([signal], RATE, 15);
  near(end - start, 15, 1e-9, "length");
  // The loud part is exactly one window long, so the window starts at 20 s;
  // the snap may then move it at most 1 s, into the quiet lead-in.
  assert.ok(start >= 19 && start <= 21, `start ${start}`);
});

test("the start snaps to the quietest 50 ms within 1 s", () => {
  // 100 ms of digital silence at 19.4 s, inside the quiet lead-in: quieter
  // than anything else within a second of the 20 s start.
  const signal = sections([19.4, 0.01], [0.1, 0], [0.5, 0.01], [15, 0.5], [25, 0.01]);
  const { start, end } = suggestSelection([signal], RATE, 15);
  assert.ok(start >= 19.4 && start <= 19.5, `start ${start}`);
  near(end - start, 15, 1e-9, "length");
});

test("a trough more than 1 s away is out of reach", () => {
  const signal = sections([18.5, 0.01], [0.1, 0], [1.4, 0.01], [15, 0.5], [25, 0.01]);
  const { start } = suggestSelection([signal], RATE, 15);
  assert.ok(start >= 19 && start <= 21, `start ${start}`);
});

test("stereo input works and both channels count", () => {
  const loud = sections([20, 0.01], [15, 0.5], [25, 0.01]);
  const flat = sections([60, 0.01]);
  const { start } = suggestSelection([flat, loud], RATE, 15);
  assert.ok(start >= 19 && start <= 21, `start ${start}`);
});

test("a snap that would run past the end slides the window back", () => {
  // The loudest window is the last one (1 s to 31 s); the trough at 1.5 s
  // pulls the start later, and the window then ends at the clip's end with
  // its full length.
  const signal = sections([1, 0.01], [0.5, 0.5], [0.1, 0], [29.4, 0.5]);
  const { start, end } = suggestSelection([signal], RATE, 30);
  near(end, 31, 1e-9, "end");
  near(start, 1, 1e-9, "start");
});

test("a clip no longer than the cap is selected whole", () => {
  const signal = sections([10, 0.5]);
  assert.deepEqual(suggestSelection([signal], RATE, 30), { start: 0, end: 10 });
  const exact = sections([30, 0.5]);
  assert.deepEqual(suggestSelection([exact], RATE, 30), { start: 0, end: 30 });
});

test("a 0.6 s clip still gets a non-empty selection", () => {
  const { start, end } = suggestSelection([sections([0.6, 0.5])], RATE, 30);
  assert.equal(start, 0);
  near(end, 0.6, 1e-9, "end");
});

test("all silence starts at 0 with the cap's length", () => {
  const silent = new Float32Array(RATE * 60);
  assert.deepEqual(suggestSelection([silent], RATE, 30), { start: 0, end: 30 });
  assert.deepEqual(suggestSelection([silent, silent], RATE, 30), { start: 0, end: 30 });
});

test("a cap shorter than the 3 s short-term window still works", () => {
  const signal = sections([5, 0.01], [2, 0.5], [5, 0.01]);
  const { start, end } = suggestSelection([signal], RATE, 2);
  near(end - start, 2, 1e-9, "length");
  assert.ok(start >= 4 && start <= 6, `start ${start}`);
});

test("heatmap and timestamp options are accepted and ignored until milestone 5", () => {
  const signal = sections([20, 0.01], [15, 0.5], [25, 0.01]);
  const plain = suggestSelection([signal], RATE, 15);
  assert.deepEqual(suggestSelection([signal], RATE, 15, { heatmap: [[0, 1, 1]], timestamp: 3 }), plain);
  assert.deepEqual(suggestSelection([signal], RATE, 15, { heatmap: null, timestamp: null }), plain);
});

test("bad arguments are refused", () => {
  const signal = sections([5, 0.5]);
  assert.throws(() => suggestSelection([signal], RATE, 0), RangeError);
  assert.throws(() => suggestSelection([signal], RATE, NaN), RangeError);
  assert.throws(() => suggestSelection([], RATE, 30), RangeError);
});
