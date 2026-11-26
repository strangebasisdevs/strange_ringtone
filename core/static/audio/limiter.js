// A look-ahead peak limiter for the render on the device (docs/PLAN.md 15.4).
//
// The server limits with ffmpeg's alimiter. This is not that filter sample
// for sample; it is specified by what it guarantees, and each guarantee has
// a test (tests/js/limiter.test.mjs):
//
//   1. No output sample is above the ceiling.
//   2. Audio that never reaches the ceiling comes out unchanged, bit for bit,
//      and so does everything far enough from a peak.
//   3. The gain it applies never jumps: from one sample to the next it moves
//      by at most 1 / (look-ahead + 1), and it never amplifies.
//
// Both channels get the same gain, so the stereo picture does not move, and
// the output is exactly as long as the input: the whole selection is in
// memory, so "looking ahead" delays nothing.
//
// How. need[n] is the gain sample n needs by itself (the ceiling over its
// peak, or 1). Looking ahead makes that a minimum over the next ATTACK of
// samples, so the gain is already down when a peak arrives; after a peak the
// reduction dies away with the RELEASE time constant; and a moving average
// as long as the look-ahead turns each step down into a ramp. The average at
// n covers only values that were at or below need[n], so it is too.
//
// Pure functions on Float32Array channels: no DOM and no Web Audio, so
// node --test runs them unchanged.

/** The look-ahead, and so the length of the ramp down to a peak. */
export const ATTACK_SECONDS = 0.005;
/** After a peak the reduction falls to 1/e of itself in this time. */
export const RELEASE_SECONDS = 0.05;
// The guarantees are stated for audio, not for any number: a sample rate
// beyond anything audio uses would make the look-ahead as long as memory,
// and a sample more than a million times over the ceiling needs a gain so
// small that "exactly what the peak needs" is lost in rounding.
export const MAX_SAMPLE_RATE = 384000;
const MAX_OVER = 2 ** 20;
// A reduction smaller than this changes no 32-bit float sample: it is less
// than half the distance between any sample and its neighbour. From here the
// release is over and the gain is exactly 1, so the release ends.
const SETTLED = 2 ** -26;

function checkChannels(channels) {
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > 2) {
    throw new RangeError("expected 1 or 2 channels");
  }
  const length = channels[0].length;
  for (const channel of channels) {
    if (!(channel instanceof Float32Array) || channel.length !== length) {
      throw new TypeError("channels must be Float32Arrays of equal length");
    }
  }
  return length;
}

/** The look-ahead in samples at a rate (at least 1). */
export function lookaheadSamples(sampleRate) {
  if (!(Number.isFinite(sampleRate) && sampleRate > 0 && sampleRate <= MAX_SAMPLE_RATE)) {
    throw new RangeError("sample rate out of range");
  }
  return Math.max(1, Math.round(ATTACK_SECONDS * sampleRate));
}

/**
 * How many samples after its last peak the limiter can still be changing
 * the audio: the look-ahead, then the release down to nothing.
 */
export function settleSamples(sampleRate) {
  const release = RELEASE_SECONDS * sampleRate;
  return lookaheadSamples(sampleRate) + Math.ceil(release * Math.log(1 / SETTLED)) + 1;
}

/**
 * The gain the limiter applies to each sample, the same for every channel.
 * Exported for the tests, which hold it to the guarantees above.
 * @param {Float32Array[]} channels 1 or 2 channels of equal length
 * @param {number} sampleRate in Hz
 * @param {number} ceiling the largest sample magnitude allowed, in (0, 1]
 * @returns {Float64Array} one gain in (0, 1] per sample
 * @throws {RangeError} for a sample that is not finite, or more than 2^20
 *   times over the ceiling
 */
export function gainCurve(channels, sampleRate, ceiling) {
  const length = checkChannels(channels);
  if (!(Number.isFinite(ceiling) && ceiling > 0 && ceiling <= 1)) {
    throw new RangeError("the ceiling must be above 0 and at most 1");
  }
  const lookahead = lookaheadSamples(sampleRate);
  const gain = new Float64Array(length).fill(1);

  // What each sample needs by itself.
  const need = new Float64Array(length);
  const left = channels[0];
  // Mono is its own second channel: the peak of the two is then its own.
  const right = channels.length > 1 ? channels[1] : left;
  let limited = false;
  for (let n = 0; n < length; n += 1) {
    const a = Math.abs(left[n]);
    const b = Math.abs(right[n]);
    // NaN and infinity have no gain that brings them under a ceiling. Their
    // sum is not a finite number whichever channel holds one.
    if (!(a + b < Infinity)) throw new RangeError("samples must be finite");
    const peak = a > b ? a : b;
    if (peak > ceiling * MAX_OVER) throw new RangeError("a sample is more than a million times over the ceiling");
    if (peak > ceiling) {
      need[n] = ceiling / peak;
      limited = true;
    } else {
      need[n] = 1;
    }
  }
  // A shortcut only: the steps below would leave every gain at 1 as well.
  if (!limited) return gain;

  // The limiter starts `lookahead` samples before the audio, so a peak in
  // the first samples finds the gain already down: index j stands for the
  // time k = j - lookahead.
  const envelope = new Float64Array(length + lookahead);
  // ahead[k] = the smallest need in [k, k + lookahead], by a monotonic queue
  // walked from the end: the queue holds sample indices whose needs rise
  // from its head, so its head is the minimum of the window.
  const queue = new Int32Array(length);
  let head = 0;
  let tail = 0;
  for (let k = length - 1; k >= -lookahead; k -= 1) {
    if (k >= 0) {
      while (tail > head && need[queue[tail - 1]] >= need[k]) tail -= 1;
      queue[tail] = k;
      tail += 1;
    }
    while (queue[head] > k + lookahead) head += 1;
    envelope[k + lookahead] = need[queue[head]];
  }

  // The release: down at once (the look-ahead above made room for that),
  // back up with the reduction falling by a fixed factor per sample.
  const keep = Math.exp(-1 / (RELEASE_SECONDS * sampleRate));
  let previous = 1;
  for (let j = 0; j < envelope.length; j += 1) {
    let released = 1 - (1 - previous) * keep;
    if (1 - released < SETTLED) released = 1;
    // Never above what the look-ahead asked for here.
    previous = Math.min(envelope[j], released);
    envelope[j] = previous;
  }

  // The attack: a moving average over [k - lookahead, k], kept as a running
  // sum of the reductions. `reduced` counts the non-zero ones in the window:
  // at zero the sum is set to exactly 0, so rounding never builds up and the
  // gain away from any peak is exactly 1.
  const width = lookahead + 1;
  let sum = 0;
  let reduced = 0;
  for (let j = 0; j < envelope.length; j += 1) {
    const entering = 1 - envelope[j];
    if (entering > 0) {
      sum += entering;
      reduced += 1;
    }
    if (j >= width) {
      const leaving = 1 - envelope[j - width];
      if (leaving > 0) {
        sum -= leaving;
        reduced -= 1;
      }
    }
    if (reduced === 0) sum = 0;
    if (j >= lookahead && sum > 0) {
      gain[j - lookahead] = 1 - sum / width;
    }
  }
  return gain;
}

/** The largest 32-bit float that is not above value. */
function floatAtOrBelow(value) {
  const rounded = Math.fround(value);
  if (rounded <= value) return rounded;
  // Rounded up: step one float down, through the bits.
  const bits = new Uint32Array(new Float32Array([rounded]).buffer);
  bits[0] -= 1;
  return new Float32Array(bits.buffer)[0];
}

/**
 * Limit channels to a ceiling. Returns new arrays; the input is not changed.
 * @param {Float32Array[]} channels 1 or 2 channels of equal length, finite samples
 * @param {number} sampleRate in Hz
 * @param {number} ceiling the largest sample magnitude allowed, in (0, 1]
 * @returns {Float32Array[]} as many channels, as long
 */
export function limit(channels, sampleRate, ceiling) {
  const gain = gainCurve(channels, sampleRate, ceiling);
  // The gain alone keeps every sample under the ceiling in exact arithmetic.
  // Stored as a 32-bit float, a sample at the ceiling can still round to the
  // float just above it, so the last word is a clamp to the float just below.
  // It moves a sample by a rounding error at the most (the tests hold the
  // gain itself to the ceiling), and it leaves a sample that was never above
  // the ceiling as it is.
  const top = floatAtOrBelow(ceiling);
  return channels.map((channel) => {
    const out = new Float32Array(channel.length);
    for (let n = 0; n < channel.length; n += 1) {
      // A gain of exactly 1 changes no bit of a sample, a negative zero included.
      const value = channel[n] * gain[n];
      out[n] = value > top ? top : value < -top ? -top : value;
    }
    return out;
  });
}
