// The render on the device, up to the encoder (core/static/audio/process.js):
// the server's chain (render.py) on the page's own samples.
import { test } from "node:test";
import assert from "node:assert/strict";

import { fadeGainAt } from "../../core/static/audio/fades.js";
import { limit } from "../../core/static/audio/limiter.js";
import { gainForTarget, integratedLufs } from "../../core/static/audio/loudness.js";
import {
  applyChain, CEILING, CEILING_DB, CORRECTION_THRESHOLD_LU, GAIN_CLAMP_DB, MAX_SECONDS, MIN_SECONDS, missesTarget,
  processSelection, SAMPLE_RATE,
} from "../../core/static/audio/process.js";
import { channelsDiffer, sameChannels, sameSamples } from "./samples.mjs";

const RATE = 44100;
const PLAIN = { fadeIn: 0, fadeOut: 0, normalize: true, targetLufs: -14 };

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

/** A quiet tone with a full-scale click every 10 ms: little loudness, tall peaks. */
function clicks(length) {
  const out = sine(length, 300, 0.02);
  for (let n = 0; n < length; n += 441) out[n] = n % 882 === 0 ? 0.9 : -0.9;
  return out;
}

function square(length, amplitude) {
  return Float32Array.from({ length }, (_, n) => (Math.floor(n / 50) % 2 === 0 ? amplitude : -amplitude));
}

function peakOf(channels) {
  let peak = 0;
  for (const channel of channels) {
    for (let n = 0; n < channel.length; n += 1) peak = Math.max(peak, Math.abs(channel[n]));
  }
  return peak;
}

const copyOf = (channels) => channels.map((channel) => Float32Array.from(channel));

const SIGNALS = {
  "a quiet tone": [sine(3 * RATE, 1000, 0.05), sine(3 * RATE, 1000, 0.05)],
  "quiet noise, mono": [noise(2 * RATE, 0.1, 1)],
  "loud noise": [noise(3 * RATE, 0.9, 2), noise(3 * RATE, 0.9, 3)],
  "clicks over a quiet tone": [clicks(3 * RATE), clicks(3 * RATE)],
  "half a second, exactly": [noise(RATE / 2, 0.3, 4)],
  "a loud start and a quiet rest": [Float32Array.from([...noise(RATE, 0.9, 5), ...noise(2 * RATE, 0.01, 6)])],
};

test("the constants are the render's", () => {
  // tests/test_frontend_js.py holds them to render.py's; this pins the values.
  assert.equal(SAMPLE_RATE, 44100);
  assert.equal(CEILING_DB, -1.5);
  assert.equal(CEILING, 10 ** (-1.5 / 20));
  assert.equal(GAIN_CLAMP_DB, 20);
  assert.equal(CORRECTION_THRESHOLD_LU, 0.5);
  assert.equal(MIN_SECONDS, 0.5);
  assert.equal(MAX_SECONDS, 40);
});

test("a quiet tone is brought to the target in one pass", () => {
  const channels = SIGNALS["a quiet tone"];
  const result = processSelection(channels, RATE, PLAIN);
  const gain = gainForTarget(integratedLufs(channels, RATE), -14);
  assert.equal(result.appliedGainDb, gain);
  assert.ok(gain > 10 && gain < 20, `gain ${gain}`);
  assert.ok(Math.abs(result.measuredLufs - -14) < 0.05, `measured ${result.measuredLufs}`);
  assert.equal(result.duration, 3);
  // Nothing reached the ceiling, so the result is the selection times the gain.
  const factor = 10 ** (gain / 20);
  for (let c = 0; c < 2; c += 1) {
    sameSamples(result.channels[c], Float32Array.from(channels[c], (sample) => sample * factor));
  }
});

test("the loudness lands within 0.5 LU of the target, or the correction ran, or the gain is at its clamp", () => {
  let corrected = 0;
  let landedFirstTime = 0;
  for (const [name, channels] of Object.entries(SIGNALS)) {
    for (const targetLufs of [-24, -14, -9]) {
      const result = processSelection(channels, RATE, { ...PLAIN, targetLufs, fadeIn: 0.2, fadeOut: 0.4 });
      const first = gainForTarget(integratedLufs(channels, RATE), targetLufs);
      const ran = result.appliedGainDb !== first;
      const landed = Math.abs(result.measuredLufs - targetLufs) <= CORRECTION_THRESHOLD_LU;
      const clamped = Math.abs(result.appliedGainDb) === GAIN_CLAMP_DB;
      assert.ok(landed || ran || clamped, `${name} at ${targetLufs}: ${result.measuredLufs} LUFS, gain ${result.appliedGainDb}`);
      assert.ok(peakOf(result.channels) <= CEILING, `${name} at ${targetLufs}: a sample above the ceiling`);
      assert.ok(Math.abs(result.appliedGainDb) <= GAIN_CLAMP_DB);
      if (ran) corrected += 1;
      if (landed && !ran) landedFirstTime += 1;
    }
  }
  // Both ways through the rule are taken, so neither is tested by absence.
  assert.ok(corrected >= 2, `the correction ran ${corrected} times`);
  assert.ok(landedFirstTime >= 2, `${landedFirstTime} landed without it`);
});

test("the correction is one more run from the selection, with the error added to the gain", () => {
  const channels = SIGNALS["clicks over a quiet tone"];
  const settings = { fadeIn: 0.1, fadeOut: 0.3, normalize: true, targetLufs: -14 };
  const first = gainForTarget(integratedLufs(channels, RATE), -14);
  const firstPass = applyChain(channels, first, 0.1, 0.3);
  // The limiter holds the clicks down, so the first pass is too quiet.
  assert.ok(-14 - firstPass.lufs > CORRECTION_THRESHOLD_LU, `the first pass measures ${firstPass.lufs}`);
  const expectedGain = Math.min(GAIN_CLAMP_DB, first + (-14 - firstPass.lufs));
  const secondPass = applyChain(channels, expectedGain, 0.1, 0.3);

  const result = processSelection(channels, RATE, settings);
  assert.equal(result.appliedGainDb, expectedGain);
  assert.equal(result.measuredLufs, secondPass.lufs, "the loudness shown is the final run's");
  sameChannels(result.channels, secondPass.channels);
  // Once, even where the second run still misses: there is no third.
  assert.notEqual(result.appliedGainDb, first);
});

test("a miss of exactly the threshold or less is left alone", () => {
  // A loud start then near silence: the fades and the limiter move the
  // loudness a little, by less than the threshold.
  const channels = SIGNALS["loud noise"];
  const first = gainForTarget(integratedLufs(channels, RATE), -14);
  const pass = applyChain(channels, first, 0.2, 0.2);
  const miss = Math.abs(pass.lufs - -14);
  assert.ok(miss > 0 && miss <= CORRECTION_THRESHOLD_LU, `the miss is ${miss}`);
  const result = processSelection(channels, RATE, { fadeIn: 0.2, fadeOut: 0.2, normalize: true, targetLufs: -14 });
  assert.equal(result.appliedGainDb, first);
  sameChannels(result.channels, pass.channels);
});

test("silence gets the whole clamp and is reported as -70 LUFS", () => {
  const channels = [new Float32Array(RATE), new Float32Array(RATE)];
  const result = processSelection(channels, RATE, PLAIN);
  assert.equal(result.appliedGainDb, 20);
  assert.equal(result.measuredLufs, -70);
  assert.ok(Number.isFinite(result.measuredLufs));
  assert.equal(peakOf(result.channels), 0);
});

test("the gain is clamped to 20 dB either way, and a clamped gain is not corrected", () => {
  const faint = [noise(2 * RATE, 0.0001, 7)];
  const up = processSelection(faint, RATE, PLAIN);
  assert.equal(up.appliedGainDb, 20);
  assert.ok(-14 - up.measuredLufs > 20, `still ${up.measuredLufs} LUFS: the target is out of reach`);
  sameChannels(up.channels, applyChain(faint, 20, 0, 0).channels);

  const blaring = [square(2 * RATE, 1), square(2 * RATE, 1)];
  const down = processSelection(blaring, RATE, { ...PLAIN, targetLufs: -24 });
  assert.equal(down.appliedGainDb, -20);
  assert.ok(down.measuredLufs - -24 > CORRECTION_THRESHOLD_LU, `still ${down.measuredLufs} LUFS`);
  sameChannels(down.channels, applyChain(blaring, -20, 0, 0).channels);
});

test("with normalize off the gain is 0 dB and nothing is corrected", () => {
  const channels = SIGNALS["a quiet tone"];
  for (const normalize of [false, undefined, "true", 1, null]) {
    const result = processSelection(channels, RATE, { ...PLAIN, normalize });
    assert.equal(result.appliedGainDb, 0, `normalize ${normalize}`);
    // More than ten LU from the target, and left there.
    assert.equal(result.measuredLufs, integratedLufs(channels, RATE));
    assert.ok(result.measuredLufs < -24, `measured ${result.measuredLufs}`);
    sameChannels(result.channels, channels);
  }
});

test("with normalize off the limiter and the fades still apply", () => {
  const channels = [square(RATE, 1), square(RATE, 1)];
  const result = processSelection(channels, RATE, { fadeIn: 0.25, fadeOut: 0, normalize: false, targetLufs: -14 });
  assert.equal(result.appliedGainDb, 0);
  assert.ok(peakOf(result.channels) <= CEILING);
  assert.ok(peakOf(result.channels) > CEILING * 0.999, "limited to the ceiling, not below it");
  assert.equal(result.channels[0][0], 0, "the fade-in starts from nothing");
  sameChannels(result.channels, applyChain(channels, 0, 0.25, 0).channels);
});

test("the chain is gain, then the limiter, then the fades", () => {
  // Built from the parts, each tested by itself: the gain in 32-bit floats,
  // limiter.js at the render's ceiling, then the quarter sine of fades.js.
  const channels = [noise(2 * RATE, 0.5, 8), noise(2 * RATE, 0.5, 9)];
  const gainDb = 12;
  const fadeIn = 0.5;
  const fadeOut = 1;
  const factor = 10 ** (gainDb / 20);
  const gained = channels.map((channel) => Float32Array.from(channel, (sample) => sample * factor));
  const fade = (n) => fadeGainAt(n / RATE, 2, fadeIn, fadeOut);
  const expected = limit(gained, RATE, CEILING).map((channel) => Float32Array.from(channel, (sample, n) => sample * fade(n)));

  const result = applyChain(channels, gainDb, fadeIn, fadeOut);
  sameChannels(result.channels, expected);
  assert.equal(result.lufs, integratedLufs(expected, RATE), "measured after everything, as what is encoded");

  // The other order is another sound: a limiter after the fades would turn
  // the faded start back up towards the ceiling.
  const faded = gained.map((channel) => Float32Array.from(channel, (sample, n) => sample * fade(n)));
  assert.ok(channelsDiffer(limit(faded, RATE, CEILING), expected));
});

test("the fades are the server's: clamped to the clip, rounded to a millisecond, none at zero", () => {
  const channels = [noise(RATE, 0.3, 10)];
  const run = (fadeIn, fadeOut) => applyChain(channels, 0, fadeIn, fadeOut).channels[0];
  const plain = run(0, 0);
  sameSamples(plain, channels[0], "no fade, no change");
  sameSamples(run(-3, -0.5), plain, "a negative fade is none");
  sameSamples(run(0.0004, 0.0004), plain, "under half a millisecond rounds to none");
  sameSamples(run(0.0006, 0), run(0.001, 0), "rounded to a millisecond");
  assert.ok(channelsDiffer([run(0.001, 0)], [plain]), "a millisecond is a fade");
  sameSamples(run(100, 0), run(1, 0), "a fade longer than the clip is the clip's length");
  sameSamples(run(0, 100), run(0, 1));
  // Clamped first and rounded after, as render.py does: on a clip that is
  // not a whole number of milliseconds, a fade longer than the clip is the
  // clip's length rounded, not the clip's length. (A clip of 1.000159 s:
  // the fade is 1.000 s, and its last 7 samples are past the fade.)
  const odd = [noise(RATE + 7, 0.3, 11)];
  const oddRun = (fadeIn, fadeOut) => applyChain(odd, 0, fadeIn, fadeOut).channels[0];
  sameSamples(oddRun(100, 0), oddRun(1, 0));
  sameSamples(oddRun(0, 100), oddRun(0, 1));
  sameSamples(oddRun(100, 0).subarray(RATE), odd[0].subarray(RATE), "past the fade, untouched");

  const faded = run(0.5, 0.25);
  assert.equal(faded[0], 0);
  assert.equal(faded[RATE / 4], Math.fround(channels[0][RATE / 4] * Math.sin(Math.PI / 4)), "half way up the quarter sine");
  assert.equal(faded[RATE / 2], channels[0][RATE / 2], "the plateau is untouched");
  assert.equal(faded[RATE - 1], Math.fround(channels[0][RATE - 1] * fadeGainAt((RATE - 1) / RATE, 1, 0.5, 0.25)));
  assert.ok(Math.abs(faded[RATE - 1]) < 0.001, "the fade-out ends at nothing");
});

test("the result is as long as the selection, to the sample, with as many channels", () => {
  for (const length of [RATE / 2, RATE / 2 + 1, 3 * RATE + 1, 30 * RATE, MAX_SECONDS * RATE]) {
    for (const count of [1, 2]) {
      const channels = Array.from({ length: count }, (_, c) => noise(length, 0.9, 20 + c));
      const result = processSelection(channels, RATE, { fadeIn: 0.01, fadeOut: 0.3, normalize: true, targetLufs: -9 });
      assert.equal(result.channels.length, count);
      for (const channel of result.channels) {
        assert.ok(channel instanceof Float32Array);
        assert.equal(channel.length, length);
      }
      assert.equal(result.duration, length / RATE);
      assert.ok(peakOf(result.channels) <= CEILING);
    }
  }
});

test("the selection itself is not changed", () => {
  const channels = [noise(RATE, 2, 30), noise(RATE, 2, 31)];
  channels[0][5] = NaN;
  const before = copyOf(channels);
  const result = processSelection(channels, RATE, { fadeIn: 0.1, fadeOut: 0.1, normalize: true, targetLufs: -14 });
  sameChannels(channels, before);
  for (let c = 0; c < 2; c += 1) assert.notEqual(result.channels[c], channels[c]);
});

test("samples outside the WAV's range are clipped first, and a NaN is silence", () => {
  // The server only ever sees the selection through a 16-bit WAV, which
  // holds nothing outside [-1, 1]. Both ways of rendering start from that.
  const wild = [noise(RATE, 0.5, 32), noise(RATE, 0.5, 33)];
  const tame = copyOf(wild);
  const plant = [[10, 1.5, 1], [20, -3, -1], [30, NaN, 0], [40, Infinity, 1], [50, -Infinity, -1], [60, 1, 1], [70, -1, -1]];
  for (const [index, value, clipped] of plant) {
    wild[1][index] = value;
    tame[1][index] = clipped;
  }
  const settings = { fadeIn: 0, fadeOut: 0.2, normalize: true, targetLufs: -18 };
  const fromWild = processSelection(wild, RATE, settings);
  const fromTame = processSelection(tame, RATE, settings);
  sameChannels(fromWild.channels, fromTame.channels);
  assert.equal(fromWild.measuredLufs, fromTame.measuredLufs);
  assert.equal(fromWild.appliedGainDb, fromTame.appliedGainDb);
  for (const channel of fromWild.channels) {
    assert.ok(channel.every((sample) => Number.isFinite(sample)));
  }
});

test("a selection at another rate is refused", () => {
  const channels = [noise(48000, 0.3, 40)];
  for (const rate of [48000, 22050, 0, NaN, "44100", undefined]) {
    assert.throws(() => processSelection(channels, rate, PLAIN), RangeError, `rate ${rate}`);
  }
});

test("a selection under half a second or over forty is refused", () => {
  const half = RATE / 2;
  assert.throws(() => processSelection([new Float32Array(half - 1)], RATE, PLAIN), RangeError);
  assert.equal(processSelection([new Float32Array(half)], RATE, PLAIN).duration, 0.5);
  assert.throws(() => processSelection([new Float32Array(MAX_SECONDS * RATE + 1)], RATE, PLAIN), RangeError);
  assert.throws(() => processSelection([new Float32Array(0)], RATE, PLAIN), RangeError);
});

test("anything but one or two equal Float32Array channels is refused", () => {
  const good = noise(RATE, 0.3, 41);
  assert.throws(() => processSelection([], RATE, PLAIN), RangeError);
  assert.throws(() => processSelection([good, good, good], RATE, PLAIN), RangeError);
  assert.throws(() => processSelection(good, RATE, PLAIN), RangeError);
  assert.throws(() => processSelection([good, noise(RATE + 1, 0.3, 42)], RATE, PLAIN), TypeError);
  assert.throws(() => processSelection([Array.from(good)], RATE, PLAIN), TypeError);
  assert.throws(() => processSelection([Float64Array.from(good)], RATE, PLAIN), TypeError);
});

test("a setting that is not a finite number is refused before anything is computed", () => {
  const channels = [noise(RATE, 0.3, 43)];
  for (const bad of [NaN, Infinity, -Infinity, "0.5", undefined, null]) {
    assert.throws(() => processSelection(channels, RATE, { ...PLAIN, fadeIn: bad }), RangeError, `fadeIn ${bad}`);
    assert.throws(() => processSelection(channels, RATE, { ...PLAIN, fadeOut: bad }), RangeError, `fadeOut ${bad}`);
    assert.throws(() => processSelection(channels, RATE, { ...PLAIN, targetLufs: bad }), RangeError, `target ${bad}`);
    // The target is checked with normalize off too: a page bug shows either way.
    assert.throws(() => processSelection(channels, RATE, { ...PLAIN, normalize: false, targetLufs: bad }), RangeError);
    assert.throws(() => applyChain(channels, bad, 0, 0), RangeError, `gain ${bad}`);
    assert.throws(() => applyChain(channels, 0, bad, 0), RangeError);
    assert.throws(() => applyChain(channels, 0, 0, bad), RangeError);
  }
});

// Found by a mutation pass (2026-11-26): each of these was a check that
// could be weakened with every test above still passing.
test("a fade-out alone fades, and fades round to a millisecond on both ends", () => {
  const channels = [noise(RATE, 0.3, 10)];
  const run = (fadeIn, fadeOut) => applyChain(channels, 0, fadeIn, fadeOut).channels[0];
  const plain = run(0, 0);
  assert.ok(channelsDiffer([run(0, 0.25)], [plain]), "a fade-out with no fade-in is a fade");
  assert.equal(run(0, 0.25)[RATE - 1] === plain[RATE - 1], false);
  sameSamples(run(0, 0.0006), run(0, 0.001), "fade-out rounded to a millisecond, not floored");
  assert.ok(channelsDiffer([run(0, 0.0006)], [plain]));
  // A negative fade beside a real one is none, not a negative length.
  sameSamples(run(-3, 0.25), run(0, 0.25), "negative fade-in");
  sameSamples(run(0.25, -3), run(0.25, 0), "negative fade-out");
});

test("a selection that is a bare Float32Array is a RangeError, however short", () => {
  assert.throws(() => processSelection(Float32Array.of(0.1, 0.2), RATE, { fadeIn: 0, fadeOut: 0, normalize: true, targetLufs: -14 }), RangeError);
});

test("the correction run starts from the clipped selection as well", () => {
  const settings = { fadeIn: 0.1, fadeOut: 0.3, normalize: true, targetLufs: -14 };
  const wild = [clicks(3 * RATE)];
  const tame = [Float32Array.from(wild[0])];
  for (const [index, value, clipped] of [[100000, 4, 1], [100100, -4, -1], [100200, NaN, 0]]) {
    wild[0][index] = value;
    tame[0][index] = clipped;
  }
  const first = gainForTarget(integratedLufs(tame, RATE), -14);
  const pass = applyChain(tame, first, 0.1, 0.3);
  assert.ok(Math.abs(pass.lufs - -14) > 0.5, "this case needs the correction run");
  const fromWild = processSelection(wild, RATE, settings);
  const fromTame = processSelection(tame, RATE, settings);
  assert.notEqual(fromTame.appliedGainDb, first);
  sameChannels(fromWild.channels, fromTame.channels);
  assert.equal(fromWild.appliedGainDb, fromTame.appliedGainDb);
});

test("a result louder than the target by more than 0.5 LU is turned down", () => {
  // A quiet second part is above the relative gate until the fade-out takes it
  // below, so the second measurement is louder than the first.
  const channels = [Float32Array.from([...noise(RATE, 0.2, 1), ...noise(2 * RATE, 0.06, 2)])];
  const settings = { fadeIn: 0, fadeOut: 2, normalize: true, targetLufs: -14 };
  const first = gainForTarget(integratedLufs(channels, RATE), -14);
  assert.ok(applyChain(channels, first, 0, 2).lufs - -14 > 0.5, "the first pass is too loud");
  const result = processSelection(channels, RATE, settings);
  assert.ok(result.appliedGainDb < first - 0.5, `${result.appliedGainDb} vs ${first}`);
  assert.ok(Math.abs(result.measuredLufs - -14) < 0.05, `${result.measuredLufs}`);
});

// Found by an adversarial review (2026-11-26).

test("the correction threshold is more than 0.5 LU, to either side", () => {
  // Pinned on the comparison itself: audio whose miss is 0.5 exactly, in
  // doubles, cannot be built to order.
  assert.equal(missesTarget(-14.5, -14), false, "exactly the threshold, too quiet");
  assert.equal(missesTarget(-13.5, -14), false, "exactly the threshold, too loud");
  assert.equal(missesTarget(-14.500001, -14), true);
  assert.equal(missesTarget(-13.499999, -14), true);
  assert.equal(missesTarget(-14, -14), false);
  assert.equal(missesTarget(-70, -9), true);
  assert.equal(missesTarget(-9, -24), true);
});

test("a gain outside the clamp is refused by the chain itself", () => {
  const channels = [noise(RATE, 0.3, 50)];
  for (const gainDb of [20.0001, -20.0001, 400, -400]) {
    assert.throws(() => applyChain(channels, gainDb, 0, 0), RangeError, `gain ${gainDb}`);
  }
  assert.ok(peakOf(applyChain(channels, 20, 0, 0).channels) <= CEILING);
  assert.ok(peakOf(applyChain(channels, -20, 0, 0).channels) > 0);
});

test("a fade is rounded as the query string would carry it", () => {
  // The page sends fades with toFixed(3). 0.0045 is a hair under 4.5 ms in
  // binary, so the server is told 0.004; rounding 4.5 up to 5 would make the
  // two ways of rendering fade differently.
  const channels = [noise(RATE, 0.3, 51)];
  const run = (fadeIn, fadeOut) => applyChain(channels, 0, fadeIn, fadeOut).channels[0];
  assert.equal((0.0045).toFixed(3), "0.004");
  sameSamples(run(0.0045, 0), run(0.004, 0), "fade-in");
  sameSamples(run(0, 0.0045), run(0, 0.004), "fade-out");
  assert.ok(channelsDiffer([run(0.004, 0)], [run(0.005, 0)]), "4 ms and 5 ms are different fades");
  for (const value of [0.0015, 0.0125, 0.2675, 1.0005]) {
    sameSamples(run(value, value), run(Number(value.toFixed(3)), Number(value.toFixed(3))), `${value}`);
  }
});

test("the chain corrects past 0.5 LU and not before: a miss of 0.44 is left, one of 0.61 is corrected", () => {
  // Three seconds of noise whose fade-out takes a little loudness away: 0.8 s
  // of it costs 0.44 LU, 1 s costs 0.61. The threshold lies between.
  const channels = [noise(3 * RATE, 0.5, 2), noise(3 * RATE, 0.5, 3)];
  const first = gainForTarget(integratedLufs(channels, RATE), -14);
  const settings = (fadeOut) => ({ fadeIn: 0, fadeOut, normalize: true, targetLufs: -14 });

  const under = applyChain(channels, first, 0, 0.8);
  const miss = Math.abs(under.lufs - -14);
  assert.ok(miss > 0.42 && miss < 0.48, `the miss is ${miss}`);
  const left = processSelection(channels, RATE, settings(0.8));
  assert.equal(left.appliedGainDb, first, "under the threshold: no second run");
  assert.equal(left.measuredLufs, under.lufs);
  sameChannels(left.channels, under.channels);

  const over = applyChain(channels, first, 0, 1);
  assert.ok(Math.abs(over.lufs - -14) > 0.55, `the miss is ${Math.abs(over.lufs - -14)}`);
  const corrected = processSelection(channels, RATE, settings(1));
  assert.equal(corrected.appliedGainDb, first + (-14 - over.lufs));
  assert.ok(Math.abs(corrected.measuredLufs - -14) < Math.abs(over.lufs - -14));
});
