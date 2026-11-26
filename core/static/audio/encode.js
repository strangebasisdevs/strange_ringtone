// Encoding the processed selection on the device (docs/PLAN.md 15.4): the
// browser's own AAC encoder (WebCodecs' AudioEncoder), then the file from
// m4a.js. No audio leaves the page.
//
// What the phone-encode spike found, which this is built on (plan 15.2):
//
// - bitrateMode "constant" is what makes the rate asked for. With the
//   default, "variable", an iPhone ignores the number and makes about
//   65 kbit/s whatever is asked.
// - Not every encoder takes 256 kbit/s (Windows' stops at 192), so the rates
//   are tried from the top and the one used is reported.
// - The encoder's own description of its output is not used: m4a.js builds
//   the config bytes from the rate and the channel count.
// - Both encoders measured stamp their chunks one frame apart from 0 and
//   emit exactly as many frames as the audio and their delay fill.
//
// The encoder is somebody else's code running on our samples, so what comes
// back is held to that before it is written into a file: how many chunks,
// how large each, timestamps that follow one another, and a frame count that
// is exactly right for the audio that went in. What goes in is checked too.
// One deadline covers the whole encode, the questions about support included.
//
// What this cannot catch is in m4a.js, at primingSamples: an encoder that
// drops whole frames from the end of its output and still reports success.
//
// The WebCodecs classes are taken from a scope the caller may pass, so the
// tests run all of this in Node against a fake encoder.
import { AAC_FRAME_SAMPLES, primingSamples, rawFrames, writeM4a } from "./m4a.js";

/** The rate the page decodes to; the same as the server's renders. */
export const SAMPLE_RATE = 44100;
/** Bit rates to ask for, in order: the server's 256 kbit/s first. */
export const BITRATES = Object.freeze([256000, 192000, 160000, 128000]);
/**
 * The longest tone that is encoded: the contract's ceiling for
 * MAX_CLIP_SECONDS, as in process.js. A caller that hands over more has a bug.
 */
export const MAX_SECONDS = 40;
/**
 * The whole of encodeTone must finish within this, from its first question
 * to the encoder to the last frame. An iPhone needs about 0.3 s for 30 s of
 * audio.
 */
export const ENCODE_TIMEOUT_MS = 30000;
/** The questions "do you take this config?" must all be answered within this. */
export const SUPPORT_TIMEOUT_MS = 5000;

const CODEC = "mp4a.40.2"; // AAC-LC
// Samples handed to the encoder at a time, and how many such blocks may wait
// in its queue before the loop lets it catch up.
const BLOCK_FRAMES = 4096;
const QUEUE_LIMIT = 8;
// An AAC-LC frame holds at most 6144 bits for each channel, so 1536 bytes
// for two, and an ADTS header adds 9 at the most.
const MAX_CHUNK_BYTES = 1545;
// An encoder emits a frame for every 1024 samples, its delay included, and
// pads the last one. The longest delay seen is 2112 samples; eight frames
// more than the input fills is past any delay worth the name. This bounds
// what is held while the encoder runs; whether the count is exactly right
// is decided afterwards (primingSamples).
const SPARE_FRAMES = 8;
// One frame, in the microseconds chunk timestamps are in.
const FRAME_MICROSECONDS = (AAC_FRAME_SAMPLES / SAMPLE_RATE) * 1e6;

const NO_ENCODER = "This browser cannot make the tone itself: it has no AAC encoder this page can use.";
const FAILED = "The tone could not be encoded. Try again.";
const STALLED = "The encoder stopped answering. Try again.";

/** A failed encode, with a message in plain words for the page to show. */
export class EncodeError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "EncodeError";
  }
}

// A clock that only goes forward: a deadline must not move with the wall clock.
function now() {
  return performance.now();
}

function pause(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** promise, or an EncodeError once ms have passed. The timer never outlives the wait. */
function within(promise, ms) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new EncodeError(STALLED)), Math.max(ms, 0));
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

function configFor(channelCount, bitrate) {
  return {
    codec: CODEC,
    sampleRate: SAMPLE_RATE,
    numberOfChannels: channelCount,
    bitrate,
    // Without this an iPhone ignores the bit rate (plan 15.2).
    bitrateMode: "constant",
  };
}

/** Whether this browser has the WebCodecs classes the encode needs. */
export function hasEncoder(scope = globalThis) {
  return typeof scope.AudioEncoder === "function" && typeof scope.AudioData === "function"
    && typeof scope.AudioEncoder.isConfigSupported === "function";
}

/**
 * The highest of BITRATES at which this browser's encoder takes AAC-LC at
 * 44.1 kHz and a constant rate, or null when it takes none (or there is no
 * encoder). The page asks this before a file is picked (plan 15.5).
 * @param {number} channelCount 1 or 2
 * @param {{scope?: object, timeoutMs?: number}} [options] timeoutMs is for
 *   all the questions together
 * @returns {Promise<number | null>} bits per second
 */
export async function supportedBitrate(channelCount, { scope = globalThis, timeoutMs = SUPPORT_TIMEOUT_MS } = {}) {
  if (channelCount !== 1 && channelCount !== 2) throw new RangeError("expected 1 or 2 channels");
  if (!hasEncoder(scope)) return null;
  const until = now() + timeoutMs;
  for (const bitrate of BITRATES) {
    let supported = false;
    try {
      const answer = await within(scope.AudioEncoder.isConfigSupported(configFor(channelCount, bitrate)), until - now());
      // Read inside the try: the answer is the encoder's, and reading it can
      // throw like anything else of the encoder's (so does reading nothing
      // at all). Only a plain true is a yes.
      supported = answer.supported === true;
    } catch (error) {
      // An encoder that does not answer at all is no encoder to build on.
      if (error instanceof EncodeError) return null;
      // One that throws at a config does not take it; the next rate may do.
    }
    if (supported) return bitrate;
  }
  return null;
}

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
  if (length < 1) throw new RangeError("there is nothing to encode");
  if (length > MAX_SECONDS * SAMPLE_RATE) throw new RangeError(`more than ${MAX_SECONDS} seconds to encode`);
  for (const channel of channels) {
    for (let n = 0; n < length; n += 1) {
      // What process.js hands over is finite and under its ceiling. Anything
      // else is a caller's bug, and no encoder says what it makes of a NaN.
      if (!(Math.abs(channel[n]) <= 1)) throw new RangeError("samples must be numbers within [-1, 1]");
    }
  }
  return length;
}

/** Run the encoder over the samples until `until`; returns its chunks and the first one's timestamp. */
async function runEncoder(channels, config, scope, until) {
  const count = channels.length;
  const samples = channels[0].length;
  const maxChunks = Math.ceil(samples / AAC_FRAME_SAMPLES) + SPARE_FRAMES;
  const chunks = [];
  let firstTimestamp = null;
  let failure = null;
  const left = () => until - now();
  let encoder = null;
  try {
    encoder = new scope.AudioEncoder({
      output(chunk) {
        if (failure !== null) return;
        try {
          // Bounded before anything is copied: an encoder gone wrong can't
          // make the page hold more than a tone's worth of frames.
          const size = chunk.byteLength;
          if (chunks.length >= maxChunks || !Number.isInteger(size) || size < 1 || size > MAX_CHUNK_BYTES) {
            failure = new EncodeError(FAILED);
            return;
          }
          // Each chunk one frame after the one before. A frame that was
          // lost, repeated or put out of order shows here, and nowhere else.
          const timestamp = chunk.timestamp;
          const expected = chunks.length === 0 ? timestamp : firstTimestamp + chunks.length * FRAME_MICROSECONDS;
          if (typeof timestamp !== "number" || !(Math.abs(timestamp - expected) <= FRAME_MICROSECONDS / 2)) {
            failure = new EncodeError(FAILED);
            return;
          }
          const bytes = new Uint8Array(size);
          chunk.copyTo(bytes);
          if (chunks.length === 0) firstTimestamp = timestamp;
          chunks.push(bytes);
        } catch (error) {
          // Thrown here, it would vanish into the encoder and the frame with
          // it; the file would be written without it.
          failure = new EncodeError(FAILED, { cause: error });
        }
      },
      error(error) {
        if (failure === null) failure = new EncodeError(FAILED, { cause: error });
      },
    });
    encoder.configure(config);
    for (let offset = 0; offset < samples; offset += BLOCK_FRAMES) {
      // At every block, not only while waiting: an encoder that takes its
      // time inside encode() never fills its queue.
      if (left() <= 0) throw new EncodeError(STALLED);
      const frames = Math.min(BLOCK_FRAMES, samples - offset);
      // Planar: one channel's block after the other.
      const data = new Float32Array(frames * count);
      channels.forEach((channel, c) => data.set(channel.subarray(offset, offset + frames), c * frames));
      const audio = new scope.AudioData({
        format: "f32-planar",
        sampleRate: SAMPLE_RATE,
        numberOfFrames: frames,
        numberOfChannels: count,
        timestamp: Math.round((offset / SAMPLE_RATE) * 1e6),
        data,
      });
      try {
        encoder.encode(audio);
      } finally {
        audio.close();
      }
      // Let the encoder catch up, and its output and errors arrive.
      while (failure === null && encoder.state === "configured" && encoder.encodeQueueSize > QUEUE_LIMIT) {
        if (left() <= 0) throw new EncodeError(STALLED);
        await pause(1);
      }
      // Stop feeding an encoder whose output was already refused or that has
      // reported an error. (One that closed itself throws at the next
      // encode or at the flush, which the catch below turns into the same.)
      if (failure !== null) throw failure;
    }
    await within(encoder.flush(), left());
    if (failure !== null) throw failure;
  } catch (error) {
    // The error callback's word first: a flush it broke rejects as well.
    if (failure !== null) throw failure;
    throw error instanceof EncodeError ? error : new EncodeError(FAILED, { cause: error });
  } finally {
    try {
      if (encoder !== null && encoder.state !== "closed") encoder.close();
    } catch {
      // Already closed, or closing itself failed: there is nothing left to free.
    }
  }
  return { chunks, firstTimestamp };
}

/**
 * Encode processed samples to an M4A file, in memory.
 * @param {Float32Array[]} channels 1 or 2 channels at 44100 Hz, as
 *   process.js returns them: at most MAX_SECONDS long, every sample a number
 *   within [-1, 1]
 * @param {{scope?: object, timeoutMs?: number}} [options] timeoutMs is for
 *   the whole call
 * @returns {Promise<{bytes: Uint8Array, bitrate: number}>} the file, and the
 *   bit rate the encoder was asked for (the first of BITRATES it takes)
 * @throws {EncodeError} with a message for the page, when there is no
 *   encoder, it fails, it stops answering, or what it returns is not, as far
 *   as can be told, an encode of what it was given
 * @throws {RangeError | TypeError} when the channels are not what is stated above
 */
export async function encodeTone(channels, { scope = globalThis, timeoutMs = ENCODE_TIMEOUT_MS } = {}) {
  const samples = checkChannels(channels);
  const count = channels.length;
  const until = now() + timeoutMs;
  // The questions have their own, shorter deadline inside the encode's.
  const bitrate = await supportedBitrate(count, { scope, timeoutMs: Math.min(timeoutMs, SUPPORT_TIMEOUT_MS) });
  if (bitrate === null) throw new EncodeError(NO_ENCODER);
  const { chunks, firstTimestamp } = await runEncoder(channels, configFor(count, bitrate), scope, until);
  let bytes;
  try {
    const frames = rawFrames(chunks, SAMPLE_RATE, count);
    const priming = primingSamples({ firstTimestamp, sampleRate: SAMPLE_RATE, frames: frames.length, samples });
    // The edit list skips the priming and presents exactly the samples that
    // went in, so the tone is as long as the selection, to the sample.
    bytes = writeM4a({ sampleRate: SAMPLE_RATE, channels: count, frames, priming, samples });
  } catch (error) {
    // Nothing came out, too little or too much came out, or it is ADTS in
    // part: not a file to hand to anyone.
    throw new EncodeError(FAILED, { cause: error });
  }
  return { bytes, bitrate };
}
