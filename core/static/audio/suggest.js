// The initial selection: docs/PLAN.md 7.2, rule 3.
//
// Choruses tend to be the loudest part of a song, so the selection goes on the
// MAX_CLIP_SECONDS window with the highest mean short-term loudness, and its
// start then moves to the quietest 50 ms within +-1 s so it does not cut into
// a word. Rules 1 (a t= timestamp) and 2 (YouTube's heatmap) are milestone 5.
//
// Everything is O(N) in the input: one K-weighting pass builds a prefix sum of
// energy per 10 ms (loudness.js), after which every 3 s window and every 50 ms
// RMS is a subtraction, and a second prefix sum over the curve scores every
// candidate window in O(1). A 10-minute file stays fast on a phone.

import { GRANULES_PER_SECOND, SHORT_TERM_SECONDS, energyPrefix, windowCurve } from "./loudness.js";

// Candidate windows start every 100 ms, the short-term curve's hop.
const HOP_GRANULES = GRANULES_PER_SECOND / 10;
// How far the start may move to find a quiet spot, and how long that spot is.
const SNAP_GRANULES = GRANULES_PER_SECOND;
const RMS_GRANULES = GRANULES_PER_SECOND / 20;
// Silence and anything below the absolute gate count as -70 LUFS, so one
// silent gap does not drag a window's mean to -Infinity.
const FLOOR_LUFS = -70;

/**
 * Suggest the initial selection.
 * @param {Float32Array[]} channels 1 or 2 channels of equal length
 * @param {number} sampleRate in Hz
 * @param {number} maxSeconds MAX_CLIP_SECONDS
 * @param {{heatmap?: unknown, timestamp?: unknown}} [options] accepted and
 *   ignored until milestone 5 (rules 1 and 2)
 * @returns {{start: number, end: number}} seconds; end - start is maxSeconds,
 *   or the whole input when it is no longer than that
 */
export function suggestSelection(channels, sampleRate, maxSeconds, options = { heatmap: null, timestamp: null }) {
  // Read in milestone 5; named here so the signature is already final.
  void options;
  if (!(Number.isFinite(maxSeconds) && maxSeconds > 0)) {
    throw new RangeError("maxSeconds must be positive");
  }
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new RangeError("expected 1 or 2 channels");
  }
  const duration = channels[0].length / sampleRate;
  if (duration <= maxSeconds) {
    return { start: 0, end: duration };
  }
  const energy = energyPrefix(channels, sampleRate);
  const { prefix, granule, count } = energy;
  const maxGranules = Math.round(maxSeconds * GRANULES_PER_SECOND);
  // A cap under 3 s gets windows as long as the cap, so every candidate still
  // has at least one loudness value inside it.
  const windowGranules = Math.min(SHORT_TERM_SECONDS * GRANULES_PER_SECOND, maxGranules);
  const curve = windowCurve(energy, windowGranules, HOP_GRANULES);
  if (!curve.some((value) => value > FLOOR_LUFS)) {
    return { start: 0, end: Math.min(maxSeconds, duration) };
  }

  // Rule 3's score: the mean of the hop values inside the window, with
  // -Infinity counted as -70. Equal windows have the same number of values,
  // so comparing sums is comparing means.
  const sums = new Float64Array(curve.length + 1);
  for (let i = 0; i < curve.length; i += 1) {
    sums[i + 1] = sums[i] + Math.max(curve[i], FLOOR_LUFS);
  }
  const perWindow = Math.floor((maxGranules - windowGranules) / HOP_GRANULES) + 1;
  const candidates = Math.max(0, Math.floor((count - maxGranules) / HOP_GRANULES)) + 1;
  let best = 0;
  let bestScore = -Infinity;
  for (let k = 0; k < candidates && k + perWindow <= curve.length; k += 1) {
    const score = sums[k + perWindow] - sums[k];
    // Strictly greater: of equally loud windows the earliest wins.
    if (score > bestScore) {
      bestScore = score;
      best = k;
    }
  }

  const chosen = best * HOP_GRANULES;
  const rms = (at) => {
    // The 50 ms around a candidate cut point, kept inside the input.
    const from = Math.min(Math.max(at - Math.floor(RMS_GRANULES / 2), 0), count - RMS_GRANULES);
    return prefix[from + RMS_GRANULES] - prefix[from];
  };
  let snapped = chosen;
  let quietest = count >= RMS_GRANULES ? rms(chosen) : 0;
  // Outward from the chosen start, earlier side first, strictly lower only:
  // of equally quiet spots the nearest wins (then the earlier one).
  for (let distance = 1; distance <= SNAP_GRANULES && count >= RMS_GRANULES; distance += 1) {
    for (const at of [chosen - distance, chosen + distance]) {
      if (at < 0 || at > count) {
        continue;
      }
      const value = rms(at);
      if (value < quietest) {
        quietest = value;
        snapped = at;
      }
    }
  }

  let start = (snapped * granule) / sampleRate;
  let end = start + maxSeconds;
  if (end > duration) {
    // Moving the start later must not shorten the selection: slide back.
    end = duration;
    start = duration - maxSeconds;
  }
  return { start, end };
}
