// The render on the device, up to the encoder (docs/PLAN.md 15.4): the steps
// the server's ffmpeg chain takes (render.py, plan 5.3), on the selection the
// page already holds.
//
//   measure -> gain -> limiter -> fades -> measure again -> correct once
//
// Here the page's own BS.1770 meter is the authority: there is no ffmpeg to
// defer to. The true peak after encoding is not measured, as on the server;
// the limiter's ceiling is the margin for it.
//
// Pure functions on Float32Array channels: no DOM and no Web Audio, so
// node --test runs them unchanged.
import { fadeGainAt } from "./fades.js";
import { limit } from "./limiter.js";
import { gainForTarget, integratedLufs } from "./loudness.js";

/** The one rate the page decodes to and the encoder is set up for. */
export const SAMPLE_RATE = 44100;
// render.py LIMITER_CEILING_DB: -1.5 dBFS, not -1.0, because AAC encoding
// adds overs between the samples (plan 5.3).
export const CEILING_DB = -1.5;
export const CEILING = 10 ** (CEILING_DB / 20);
/** render.py GAIN_CLAMP_DB. */
export const GAIN_CLAMP_DB = 20;
/** render.py CORRECTION_THRESHOLD_LU. */
export const CORRECTION_THRESHOLD_LU = 0.5;
// wav.py refuses a clip under half a second, and the contract caps
// MAX_CLIP_SECONDS at 40. The page keeps a selection inside its own, smaller
// limits; these are the outer ones, so a bug there can't set a phone to
// processing ten minutes of audio.
export const MIN_SECONDS = 0.5;
export const MAX_SECONDS = 40;
// ffmpeg's ebur128 never reports below its -70 LUFS gate, and loudness.js
// treats a measurement at or below it as -70. Silence is reported the same
// way here, so the loudness shown is always a number.
const SILENCE_LUFS = -70;

function finite(value, name) {
  // As render.py's _finite: a NaN that reached the arithmetic would turn
  // every sample into NaN, which nothing later would catch.
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(`${name} must be a finite number`);
  }
  return value;
}

function checkSelection(channels, sampleRate) {
  if (sampleRate !== SAMPLE_RATE) {
    throw new RangeError(`the selection must be at ${SAMPLE_RATE} Hz`);
  }
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > 2) {
    throw new RangeError("expected 1 or 2 channels");
  }
  const length = channels[0].length;
  for (const channel of channels) {
    if (!(channel instanceof Float32Array) || channel.length !== length) {
      throw new TypeError("channels must be Float32Arrays of equal length");
    }
  }
  if (length < MIN_SECONDS * SAMPLE_RATE) throw new RangeError("the selection is shorter than half a second");
  if (length > MAX_SECONDS * SAMPLE_RATE) throw new RangeError(`the selection is longer than ${MAX_SECONDS} seconds`);
  return length;
}

/**
 * A copy held to the range of the WAV upload: every sample in [-1, 1], and
 * silence where a sample is not a number. The server only ever sees the
 * selection through that file (wav.js clips as it writes), so both ways of
 * rendering start from audio in the same range. The upload is also rounded
 * to 16 bits, and this copy is not.
 */
function inRange(channels) {
  return channels.map((channel) => {
    const out = new Float32Array(channel.length);
    for (let n = 0; n < channel.length; n += 1) {
      const sample = channel[n];
      // The comparisons are false for NaN, which leaves the 0 that is there.
      if (sample >= 1) out[n] = 1;
      else if (sample <= -1) out[n] = -1;
      else if (sample === sample) out[n] = sample;
    }
    return out;
  });
}

function loudness(channels) {
  const lufs = integratedLufs(channels, SAMPLE_RATE);
  return lufs > SILENCE_LUFS ? lufs : SILENCE_LUFS;
}

function clampGain(gainDb) {
  return Math.max(-GAIN_CLAMP_DB, Math.min(GAIN_CLAMP_DB, gainDb));
}

/**
 * Whether a result is far enough from the target for the corrective run:
 * by more than CORRECTION_THRESHOLD_LU, as render.py has it. A miss of
 * exactly the threshold is left alone.
 * @param {number} lufs the loudness of a pass
 * @param {number} target the target loudness
 * @returns {boolean}
 */
export function missesTarget(lufs, target) {
  return Math.abs(lufs - target) > CORRECTION_THRESHOLD_LU;
}

// A fade as the server would hold it: clamped to the clip and rounded to a
// millisecond (render.py), with toFixed, which is how the page writes a fade
// into the query string (request.js). A zero fade does nothing.
function fadeSeconds(value, duration, name) {
  return Number(Math.min(Math.max(finite(value, name), 0), duration).toFixed(3));
}

/**
 * One pass of the chain at a given gain: gain, limiter, fades, then the
 * loudness of exactly what will be encoded. Exported for the tests;
 * processSelection is the way in, and checks the selection before this.
 * @param {Float32Array[]} channels 1 or 2 channels at 44100 Hz, samples in [-1, 1]
 * @param {number} gainDb the gain to apply, in dB, within the clamp
 * @param {number} fadeIn seconds (0 for none)
 * @param {number} fadeOut seconds (0 for none)
 * @returns {{channels: Float32Array[], lufs: number}} new arrays, as long as the input
 */
export function applyChain(channels, gainDb, fadeIn, fadeOut) {
  const length = channels[0].length;
  const duration = length / SAMPLE_RATE;
  // Within the clamp, the loudest sample is under twelve times the ceiling,
  // which is where the limiter has been measured.
  if (Math.abs(finite(gainDb, "gainDb")) > GAIN_CLAMP_DB) throw new RangeError("the gain is outside the clamp");
  const factor = 10 ** (gainDb / 20);
  const gained = channels.map((channel) => {
    const out = new Float32Array(length);
    for (let n = 0; n < length; n += 1) out[n] = channel[n] * factor;
    return out;
  });
  // The limiter before the fades, as in render.py's filter chain: a fade
  // then shapes the limited sound and can't be undone by the limiter's gain.
  const out = limit(gained, SAMPLE_RATE, CEILING);
  const fin = fadeSeconds(fadeIn, duration, "fadeIn");
  const fout = fadeSeconds(fadeOut, duration, "fadeOut");
  if (fin > 0 || fout > 0) {
    for (let n = 0; n < length; n += 1) {
      const fade = fadeGainAt(n / SAMPLE_RATE, duration, fin, fout);
      if (fade !== 1) {
        for (const channel of out) channel[n] *= fade;
      }
    }
  }
  return { channels: out, lufs: loudness(out) };
}

/**
 * Process a selection into the samples that get encoded.
 *
 * With normalize on, the gain is the target minus the selection's measured
 * loudness, clamped to +-20 dB. The limiter and the fades move the loudness,
 * so the result is measured again; if it misses the target by more than
 * 0.5 LU the chain runs once more from the selection with the error added
 * to the gain. With normalize off the gain is 0 dB and nothing is corrected;
 * the limiter and the fades still apply.
 *
 * @param {Float32Array[]} channels 1 or 2 channels of equal length; not changed
 * @param {number} sampleRate must be 44100
 * @param {{fadeIn: number, fadeOut: number, normalize: boolean, targetLufs: number}} settings
 * @returns {{channels: Float32Array[], duration: number, measuredLufs: number, appliedGainDb: number}}
 *   the processed samples, as long as the selection; the selection's length
 *   in seconds; the loudness of the result; and the gain that was applied
 */
export function processSelection(channels, sampleRate, { fadeIn, fadeOut, normalize, targetLufs }) {
  const length = checkSelection(channels, sampleRate);
  finite(fadeIn, "fadeIn");
  finite(fadeOut, "fadeOut");
  const target = finite(targetLufs, "targetLufs");
  const selection = inRange(channels);
  // Only the value true normalises, as only "true" does in the server's query.
  const normalise = normalize === true;
  // No measurement at all with normalize off: the user asked for the clip as it is.
  let gainDb = normalise ? gainForTarget(integratedLufs(selection, SAMPLE_RATE), target, GAIN_CLAMP_DB) : 0;
  let result = applyChain(selection, gainDb, fadeIn, fadeOut);
  if (normalise && missesTarget(result.lufs, target)) {
    // One more run from the selection with the error added back. A gain
    // already at the clamp can't move, so that run would change nothing.
    const corrected = clampGain(gainDb + (target - result.lufs));
    if (corrected !== gainDb) {
      gainDb = corrected;
      result = applyChain(selection, gainDb, fadeIn, fadeOut);
    }
  }
  return {
    channels: result.channels,
    duration: length / SAMPLE_RATE,
    measuredLufs: result.lufs,
    appliedGainDb: gainDb,
  };
}
