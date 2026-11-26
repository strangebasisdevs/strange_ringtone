// The device render's limiter (core/static/audio/limiter.js), held to what it
// guarantees (docs/PLAN.md 15.4) on signals built to break each guarantee:
// nothing above the ceiling, nothing changed that was under it, and a gain
// that never jumps.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ATTACK_SECONDS, MAX_SAMPLE_RATE, RELEASE_SECONDS, gainCurve, limit, lookaheadSamples, settleSamples,
} from "../../core/static/audio/limiter.js";
import { sameSamples } from "./samples.mjs";

const RATE = 44100;
// The render's ceiling, -1.5 dBFS.
const CEILING = 10 ** (-1.5 / 20);
const LOOKAHEAD = lookaheadSamples(RATE);
const SETTLE = settleSamples(RATE);
// 0.1 rounds UP to its nearest 32-bit float and 0.7 rounds down: a limiter
// that only rounds its output would pass one of them and exceed the other.
const CEILINGS = [CEILING, 0.1, 0.7, 0.5, 1];

/** A small seeded generator (mulberry32), so every run sees the same noise. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function noise(length, amplitude, seed) {
  const next = random(seed);
  return Float32Array.from({ length }, () => (next() * 2 - 1) * amplitude);
}

function sine(length, frequency, amplitude) {
  return Float32Array.from({ length }, (_, n) => amplitude * Math.sin((2 * Math.PI * frequency * n) / RATE));
}

function constant(length, value) {
  return new Float32Array(length).fill(value);
}

function withPeaks(base, peaks) {
  const out = Float32Array.from(base);
  for (const [index, value] of peaks) out[index] = value;
  return out;
}

/** The largest 32-bit float not above value, found through the bits. */
function floatAtOrBelow(value) {
  const rounded = Math.fround(value);
  if (rounded <= value) return rounded;
  const bits = new Uint32Array(new Float32Array([rounded]).buffer);
  bits[0] -= 1;
  return new Float32Array(bits.buffer)[0];
}

/** What each sample needs by itself: the ceiling over its peak, or 1. */
function needOf(channels, ceiling) {
  return Float64Array.from({ length: channels[0].length }, (_, n) => {
    const peak = Math.max(...channels.map((channel) => Math.abs(channel[n])));
    return peak > ceiling ? ceiling / peak : 1;
  });
}

const N = 3 * RATE;
// Each is built to break something: a peak with no audio before it to ramp
// through, peaks closer together than the look-ahead, a level that never
// comes back under the ceiling, a peak in one channel only.
const HOSTILE = {
  "a peak in the first sample": [withPeaks(constant(2000, 0), [[0, 1]])],
  "a peak in the last sample": [withPeaks(constant(2000, 0.2), [[1999, -1]])],
  "one sample far over": [withPeaks(noise(N, 0.1, 1), [[40000, 8]])],
  "full scale, alternating": [Float32Array.from({ length: 5000 }, (_, n) => (n % 2 === 0 ? 1 : -1))],
  "a step from quiet to loud": [Float32Array.from([...noise(20000, 0.01, 2), ...noise(20000, 3, 3)])],
  "a sine twenty decibels over": [sine(N, 97, 8.4)],
  "a low sine, slower than the release": [sine(N, 11, 2)],
  "two peaks one look-ahead apart": [withPeaks(constant(9000, 0.1), [[4000, 3], [4000 + LOOKAHEAD, -5]])],
  "two peaks just inside the look-ahead": [withPeaks(constant(9000, 0.1), [[4000, 5], [4000 + LOOKAHEAD - 1, 2]])],
  "two peaks just outside the look-ahead": [withPeaks(constant(9000, 0.1), [[4000, 2], [4000 + LOOKAHEAD + 1, 5]])],
  "noise four times too loud": [noise(N, 4, 4), noise(N, 4, 5)],
  "a peak in one channel only": [withPeaks(noise(N, 0.2, 6), [[50000, 6]]), sine(N, 440, 0.3)],
  "a level that keeps rising": [Float32Array.from({ length: N }, (_, n) => (5 * n) / N)],
  "over from end to end, shorter than the look-ahead": [constant(50, 2), constant(50, -1.5)],
  "a single sample": [Float32Array.of(5)],
  "a steady level, three times over": [constant(30000, 3)],
  "the float just above the ceiling": [constant(3000, Math.fround(CEILING) > CEILING
    ? Math.fround(CEILING) : Math.fround(CEILING * (1 + 2 ** -23)))],
  "ten times over, then nothing": [Float32Array.from([...noise(RATE, 10, 7), ...constant(2 * RATE, 0)])],
};

test("the look-ahead is 5 ms and the release 50 ms, as the render's limiter is specified", () => {
  assert.equal(ATTACK_SECONDS, 0.005);
  assert.equal(RELEASE_SECONDS, 0.05);
  assert.equal(LOOKAHEAD, 221);
  assert.equal(lookaheadSamples(100), 1, "never less than a sample");
  // The look-ahead, then the release down to less than any float can show.
  assert.equal(SETTLE, LOOKAHEAD + Math.ceil(0.05 * RATE * Math.log(2 ** 26)) + 1);
  assert.ok(SETTLE < RATE, "the limiter lets go within a second");
});

test("guarantee 1: no output sample is above the ceiling", () => {
  for (const ceiling of CEILINGS) {
    for (const [name, channels] of Object.entries(HOSTILE)) {
      const out = limit(channels, RATE, ceiling);
      out.forEach((channel, c) => {
        for (let n = 0; n < channel.length; n += 1) {
          // Compared as the 64-bit number the ceiling is, not as a float.
          if (!(Math.abs(channel[n]) <= ceiling)) {
            assert.fail(`${name}, ceiling ${ceiling}: channel ${c} sample ${n} is ${channel[n]}`);
          }
        }
      });
    }
  }
});

test("guarantee 1 holds because of the gain, not because of a clip", () => {
  // The clamp in limit() would hide a look-ahead that came too late, by
  // clipping. So the gain is held to the ceiling by itself, and the output is
  // held to the gain: the clamp may move a sample by a rounding error only.
  for (const ceiling of CEILINGS) {
    for (const [name, channels] of Object.entries(HOSTILE)) {
      const gain = gainCurve(channels, RATE, ceiling);
      const need = needOf(channels, ceiling);
      const out = limit(channels, RATE, ceiling);
      for (let n = 0; n < gain.length; n += 1) {
        if (!(gain[n] <= need[n] * (1 + 1e-9))) {
          assert.fail(`${name}, ceiling ${ceiling}: the gain at ${n} is ${gain[n]}, the sample needs ${need[n]}`);
        }
        for (let c = 0; c < channels.length; c += 1) {
          const exact = channels[c][n] * gain[n];
          if (!(Math.abs(out[c][n] - exact) <= Math.abs(exact) * 2 ** -22)) {
            assert.fail(`${name}, ceiling ${ceiling}: channel ${c} sample ${n} is ${out[c][n]}, the gain gives ${exact}`);
          }
        }
      }
    }
  }
});

test("guarantee 2: audio that never reaches the ceiling comes out bit for bit", () => {
  const top = floatAtOrBelow(CEILING);
  const cases = {
    "quiet noise": [noise(N, 0.3, 11), noise(N, 0.3, 12)],
    "noise that touches the ceiling exactly": [withPeaks(noise(N, 0.8, 13), [[0, top], [777, -top], [N - 1, top]])],
    "a steady level at the ceiling": [constant(5000, top)],
    "silence": [constant(5000, 0)],
    "negative zero": [constant(100, -0)],
    "mono": [sine(N, 1000, 0.84)],
  };
  for (const [name, channels] of Object.entries(cases)) {
    const out = limit(channels, RATE, CEILING);
    assert.equal(out.length, channels.length, name);
    out.forEach((channel, c) => {
      assert.notEqual(channel, channels[c], `${name}: a new array, not the caller's`);
      // Bit for bit: sameSamples tells -0 from 0.
      sameSamples(channel, channels[c], name);
    });
    assert.ok(gainCurve(channels, RATE, CEILING).every((g) => g === 1), `${name}: the gain is exactly 1`);
  }
});

test("guarantee 2: away from a peak the audio is untouched, before and after", () => {
  const first = 60000;
  const last = 60100;
  const base = noise(N, 0.3, 21);
  const peaks = [];
  for (let n = first; n <= last; n += 7) peaks.push([n, n % 2 === 0 ? 4 : -6]);
  peaks.push([last, 9]);
  const channels = [withPeaks(base, peaks), noise(N, 0.3, 22)];
  const gain = gainCurve(channels, RATE, CEILING);
  const out = limit(channels, RATE, CEILING);
  for (let n = 0; n < N; n += 1) {
    const far = n < first - LOOKAHEAD || n >= last + SETTLE;
    if (far) {
      if (gain[n] !== 1) assert.fail(`the gain at ${n} is ${gain[n]}, far from any peak`);
      if (!Object.is(out[0][n], channels[0][n]) || !Object.is(out[1][n], channels[1][n])) {
        assert.fail(`sample ${n} changed, far from any peak`);
      }
    }
  }
  // And the limiter did work in between, in both channels: they are linked.
  assert.ok(gain[first] < 0.3 && gain[last] < 0.2);
  assert.notEqual(out[1][first], channels[1][first]);
  // The gain starts down exactly one look-ahead before the first peak.
  assert.equal(gain[first - LOOKAHEAD - 1], 1);
  assert.ok(gain[first - LOOKAHEAD] < 1);
});

test("guarantee 2 survives long limiting: the gain comes back to exactly 1", () => {
  // Ten seconds limited without a break, then quiet. Rounding built up in a
  // running sum would leave the gain a hair off 1 for the rest of the clip.
  const loud = 10 * RATE;
  const channels = [Float32Array.from([...noise(loud, 10, 31), ...noise(2 * RATE, 0.2, 32)])];
  const gain = gainCurve(channels, RATE, CEILING);
  for (let n = loud + SETTLE; n < gain.length; n += 1) {
    if (gain[n] !== 1) assert.fail(`the gain at ${n} is ${gain[n]}`);
  }
  assert.ok(gain[loud - 1] < 0.5);
});

test("guarantee 3: the gain never jumps, never amplifies and is never zero", () => {
  const step = 1 / (LOOKAHEAD + 1);
  for (const ceiling of CEILINGS) {
    for (const [name, channels] of Object.entries(HOSTILE)) {
      const gain = gainCurve(channels, RATE, ceiling);
      assert.equal(gain.length, channels[0].length, name);
      for (let n = 0; n < gain.length; n += 1) {
        if (!(gain[n] > 0 && gain[n] <= 1)) assert.fail(`${name}: the gain at ${n} is ${gain[n]}`);
        if (n > 0 && !(Math.abs(gain[n] - gain[n - 1]) <= step + 1e-12)) {
          assert.fail(`${name}, ceiling ${ceiling}: the gain jumps from ${gain[n - 1]} to ${gain[n]} at ${n}`);
        }
      }
    }
  }
});

test("the gain ramps down over the look-ahead and arrives exactly at the peak", () => {
  const at = 5000;
  const channels = [withPeaks(constant(20000, 0.1), [[at, 4 * CEILING]])];
  const gain = gainCurve(channels, RATE, CEILING);
  const needed = CEILING / Math.fround(4 * CEILING);
  assert.equal(gain[at - LOOKAHEAD - 1], 1, "untouched until one look-ahead before the peak");
  for (let i = 0; i <= LOOKAHEAD; i += 1) {
    // A straight line: one more of the look-ahead's samples sees the peak.
    const expected = 1 - ((i + 1) * (1 - needed)) / (LOOKAHEAD + 1);
    assert.ok(Math.abs(gain[at - LOOKAHEAD + i] - expected) <= 1e-12, `step ${i}: ${gain[at - LOOKAHEAD + i]}`);
  }
  assert.ok(Math.abs(gain[at] - needed) <= 1e-12, "at the peak the gain is what the peak needs");
});

test("after a peak the reduction dies away with a 50 ms time constant", () => {
  const at = 5000;
  const channels = [withPeaks(constant(at + SETTLE + 100, 0.1), [[at, 4 * CEILING]])];
  const gain = gainCurve(channels, RATE, CEILING);
  const depth = 1 - CEILING / Math.fround(4 * CEILING);
  const keep = Math.exp(-1 / (RELEASE_SECONDS * RATE));
  for (const after of [0, 1, 100, 2205, 10000]) {
    // The moving average over the look-ahead, of a reduction that falls by
    // `keep` with each sample after the peak.
    let sum = 0;
    for (let i = 0; i <= LOOKAHEAD; i += 1) sum += depth * keep ** (after + i);
    const expected = 1 - sum / (LOOKAHEAD + 1);
    const actual = gain[at + LOOKAHEAD + after];
    assert.ok(Math.abs(actual - expected) <= 1e-12, `${after} samples into the release: ${actual} != ${expected}`);
  }
  // In plain numbers: 50 ms on, about a third of the reduction is left.
  const left = (1 - gain[at + LOOKAHEAD + Math.round(RELEASE_SECONDS * RATE)]) / depth;
  assert.ok(left > 0.3 && left < 0.4, `${left} of the reduction is left after 50 ms`);
  assert.ok(gain[at + SETTLE - 2000] < 1, "still letting go a little before the end of the release");
  assert.equal(gain[at + SETTLE], 1, "and then none at all");
});

test("both channels get the same gain", () => {
  const at = 3000;
  const left = withPeaks(constant(9000, 0.25), [[at, 5]]);
  const right = constant(9000, 0.5);
  const gain = gainCurve([left, right], RATE, CEILING);
  const out = limit([left, right], RATE, CEILING);
  for (let n = at - LOOKAHEAD; n < at + 2000; n += 1) {
    assert.equal(out[1][n], Math.fround(0.5 * gain[n]), `the quiet channel at ${n}`);
    if (n !== at) assert.equal(out[0][n], Math.fround(0.25 * gain[n]), `the loud channel at ${n}`);
  }
  assert.ok(out[1][at] < 0.1, "the quiet channel is turned down with the loud one");
  // The other way round gives the same curve: the peak of the two decides.
  sameSamples(gainCurve([right, left], RATE, CEILING), gain);
});

test("the output is as long as the input, and the input is left alone", () => {
  for (const length of [0, 1, 2, LOOKAHEAD, LOOKAHEAD + 1, 1000, 44101]) {
    const channels = [noise(length, 3, 41), noise(length, 3, 42)];
    const copies = channels.map((channel) => Float32Array.from(channel));
    const out = limit(channels, RATE, CEILING);
    assert.equal(out.length, 2);
    for (let c = 0; c < 2; c += 1) {
      assert.equal(out[c].length, length);
      assert.ok(out[c] instanceof Float32Array);
      sameSamples(channels[c], copies[c], "the caller's samples");
    }
    assert.equal(gainCurve(channels, RATE, CEILING).length, length);
  }
});

test("a sample that is not a finite number is refused, in either channel", () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    const good = constant(100, 0.5);
    const broken = withPeaks(constant(100, 0.5), [[50, bad]]);
    assert.throws(() => limit([broken], RATE, CEILING), RangeError);
    assert.throws(() => limit([broken, good], RATE, CEILING), RangeError);
    assert.throws(() => limit([good, broken], RATE, CEILING), RangeError);
    assert.throws(() => gainCurve([good, broken], RATE, CEILING), RangeError);
  }
});

test("anything but one or two equal Float32Array channels is refused", () => {
  const good = constant(10, 0.1);
  assert.throws(() => limit([], RATE, CEILING), RangeError);
  assert.throws(() => limit([good, good, good], RATE, CEILING), RangeError);
  assert.throws(() => limit(good, RATE, CEILING), RangeError);
  assert.throws(() => limit([good, constant(11, 0.1)], RATE, CEILING), TypeError);
  assert.throws(() => limit([[0.1, 0.2]], RATE, CEILING), TypeError);
  assert.throws(() => limit([new Float64Array(10)], RATE, CEILING), TypeError);
});

test("a ceiling or a rate that makes no sense is refused", () => {
  const good = [constant(10, 0.1)];
  for (const ceiling of [0, -0.5, 1.0001, NaN, Infinity, "0.5", undefined]) {
    assert.throws(() => limit(good, RATE, ceiling), RangeError, `ceiling ${ceiling}`);
  }
  for (const rate of [0, -44100, NaN, Infinity, undefined]) {
    assert.throws(() => limit(good, rate, CEILING), RangeError, `rate ${rate}`);
    assert.throws(() => lookaheadSamples(rate), RangeError, `rate ${rate}`);
  }
});

// Found by a mutation pass (2026-11-26): each of these was a check that
// could be weakened with every test above still passing.
test("the look-ahead rounds to the nearest sample at other rates, and is never 0", () => {
  assert.equal(lookaheadSamples(22050), 110); // 110.25: ceil would say 111
  assert.equal(lookaheadSamples(11025), 55); // 55.125
  assert.equal(lookaheadSamples(48000), 240);
  assert.equal(lookaheadSamples(50), 1); // 0.25 rounds to 0, so the floor of 1 does the work
  assert.equal(lookaheadSamples(1), 1);
});

test("a ceiling that is exactly a float leaves a sample at the ceiling alone", () => {
  // 0.5 and 1 are floats: the clamp must not be one float below them.
  for (const ceiling of [0.5, 1, 0.25]) {
    const channels = [Float32Array.of(ceiling, -ceiling, 0.1)];
    const out = limit(channels, 44100, ceiling);
    sameSamples(out[0], channels[0], `ceiling ${ceiling}`);
  }
});

test("a Float32Array is not a list of channels", () => {
  assert.throws(() => limit(Float32Array.of(0.1, 0.2), 44100, 0.5), RangeError);
  assert.throws(() => limit(Float32Array.of(0.1), 44100, 0.5), RangeError);
});

// Found by an adversarial review (2026-11-26): outside these two bounds the
// guarantees above did not hold as stated, or the limiter took all memory.

test("a sample rate beyond any audio's is refused", () => {
  assert.equal(MAX_SAMPLE_RATE, 384000);
  const good = [constant(10, 0.1)];
  assert.equal(lookaheadSamples(MAX_SAMPLE_RATE), 1920);
  assert.equal(limit(good, MAX_SAMPLE_RATE, CEILING)[0].length, 10);
  for (const rate of [MAX_SAMPLE_RATE + 1, 1e7, 1e12]) {
    assert.throws(() => lookaheadSamples(rate), RangeError, `rate ${rate}`);
    assert.throws(() => limit(good, rate, CEILING), RangeError, `rate ${rate}`);
    assert.throws(() => gainCurve(good, rate, CEILING), RangeError, `rate ${rate}`);
  }
});

test("a sample more than a million times over the ceiling is refused", () => {
  const most = 2 ** 20;
  for (const ceiling of [CEILING, 0.5, 1e-6]) {
    const at = Math.fround(ceiling * most * 0.999);
    const over = Math.fround(ceiling * most * 1.01);
    const taken = [withPeaks(constant(2000, 0), [[1000, at]])];
    const out = limit(taken, RATE, ceiling);
    assert.ok(Math.abs(out[0][1000]) <= ceiling, `ceiling ${ceiling}`);
    for (const channels of [[withPeaks(constant(2000, 0), [[1000, over]])], [constant(2000, 0), withPeaks(constant(2000, 0), [[1000, -over]])]]) {
      assert.throws(() => limit(channels, RATE, ceiling), RangeError, `ceiling ${ceiling}`);
      assert.throws(() => gainCurve(channels, RATE, ceiling), RangeError, `ceiling ${ceiling}`);
    }
  }
});

test("up to that bound the gain is never zero and is what the peak needs", () => {
  // At a ratio of a million the gain is about a millionth, and still what
  // the peak needs to one part in a hundred million; the clamp in limit()
  // takes care of that last part. (Far past the bound, rounding ate the gain
  // whole: the output was silence.)
  const ceiling = 0.5;
  const peak = Math.fround(ceiling * 2 ** 20 * 0.999);
  const channels = [withPeaks(constant(3000, 0.25), [[1500, peak]])];
  const gain = gainCurve(channels, RATE, ceiling);
  const needed = ceiling / peak;
  assert.ok(gain.every((g) => g > 0 && g <= 1));
  assert.ok(Math.abs(gain[1500] / needed - 1) <= 1e-8, `${gain[1500]} against ${needed}`);
  const out = limit(channels, RATE, ceiling);
  assert.ok(out[0].every((sample) => Math.abs(sample) <= ceiling));
  assert.ok(Math.abs(out[0][1500]) > ceiling * 0.999, "the peak is at the ceiling, not below it");
});
