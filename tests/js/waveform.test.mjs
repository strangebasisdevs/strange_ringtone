// Moving the selection's edges (moveEdge in core/static/waveform.js): the cap
// and the minimum hold for every drag and nudge, and an edge pushed past
// either one moves the other edge instead of being stopped.
import { test } from "node:test";
import assert from "node:assert/strict";

import { moveEdge } from "../../core/static/waveform.js";

const LENGTH = 1_000_000;
const MAX = 150_000;
const MIN = 22_050;
const SELECTION = Object.freeze({ start: 100_000, end: 200_000 });

const move = (edge, frame, selection = SELECTION) => moveEdge(selection, edge, frame, LENGTH, MAX, MIN);

test("dragging the start past the cap pulls the end along", () => {
  assert.deepEqual(move("start", 10_000), { start: 10_000, end: 160_000 });
});

test("dragging the end past the cap pulls the start along", () => {
  assert.deepEqual(move("end", 300_000), { start: 150_000, end: 300_000 });
});

test("within the cap only the dragged edge moves", () => {
  assert.deepEqual(move("start", 80_000), { start: 80_000, end: 200_000 });
  assert.deepEqual(move("end", 220_000), { start: 100_000, end: 220_000 });
});

test("pushing an edge closer than the minimum pushes the other edge", () => {
  assert.deepEqual(move("start", 195_000), { start: 195_000, end: 195_000 + MIN });
  assert.deepEqual(move("end", 110_000), { start: 110_000 - MIN, end: 110_000 });
  // Past the other edge altogether.
  assert.deepEqual(move("start", 400_000), { start: 400_000, end: 400_000 + MIN });
  assert.deepEqual(move("end", 50_000), { start: 50_000 - MIN, end: 50_000 });
});

test("edges stay inside the input with room for the minimum", () => {
  assert.deepEqual(move("start", -5), { start: 0, end: 150_000 });
  assert.deepEqual(move("start", LENGTH + 5), { start: LENGTH - MIN, end: LENGTH });
  assert.deepEqual(move("end", LENGTH + 5), { start: LENGTH - MAX, end: LENGTH });
  assert.deepEqual(move("end", -5), { start: 0, end: MIN });
});

test("move shifts the whole selection and keeps its length", () => {
  assert.deepEqual(move("move", 500_000), { start: 500_000, end: 600_000 });
  assert.deepEqual(move("move", -10), { start: 0, end: 100_000 });
  assert.deepEqual(move("move", LENGTH), { start: LENGTH - 100_000, end: LENGTH });
});

test("frames are whole, and an unknown edge changes nothing", () => {
  assert.deepEqual(move("start", 80_000.6), { start: 80_001, end: 200_000 });
  assert.deepEqual(move("middle", 5), { start: 100_000, end: 200_000 });
  // The selection passed in is not modified.
  assert.deepEqual(SELECTION, { start: 100_000, end: 200_000 });
});
