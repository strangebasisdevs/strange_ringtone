// Decoding the picked file in the browser (docs/PLAN.md 4): the server only
// ever sees the PCM WAV the page builds from the selection, so every codec the
// phone can play works without the core parsing it.

import { movieAudio } from "./movie.js";

/**
 * The longest input accepted, in seconds. A 10-minute stereo clip at 44.1 kHz
 * is already about 210 MB of Float32 plus the decoder's own copy, and the
 * editor works on all of it. The duration is known only once the file is
 * decoded, so this check runs after the decode; MAX_INPUT_BYTES is what runs
 * before it. A small file at a very low bitrate can still decode to more than
 * a tab can hold, and then the tab ends before this check is reached.
 */
export const MAX_INPUT_SECONDS = 600;

/**
 * The largest input accepted, in bytes, checked before the file is read whole
 * or decoded, for a picked file and fetched audio alike. 64 MiB holds 10
 * minutes of lossy compressed audio at any usual bitrate (an MP3 at 320 kbit/s
 * is about 24 MB, YouTube's AAC about 10 MB). Lossless audio may not fit:
 * CD-quality WAV passes it after about six minutes, and FLAC or Apple
 * Lossless (which also comes as .m4a) often before ten, which is why the
 * refusal suggests MP3 or AAC. It bounds what is read into memory, not what
 * decoding makes of it.
 *
 * For a video it counts the sound alone (the owner's decision, 2026-11-24):
 * movie.js reads the index and the audio track, never the picture, and the
 * M4A it builds from them is held to this bound, header included, so a
 * video of any size holds to it. Telling a video from an audio
 * file takes the file's first bytes and, for a file of the MP4 family, its
 * index, which movie.js caps on its own.
 */
export const MAX_INPUT_BYTES = 64 * 1024 * 1024;

/**
 * The shortest input accepted, in seconds: the server refuses a selection
 * under half a second, so shorter input could never become a tone.
 */
export const MIN_INPUT_SECONDS = 0.5;

// A video whose sound came out of it but the decoder would not take.
const VIDEO_SOUND_UNREADABLE = "This browser could not read this video's sound. Convert the video to MP4 "
  + "with AAC sound, or save its sound as an M4A or MP3, then pick that.";

/**
 * Decode an audio file, or a video's sound, to at most two channels at
 * sampleRate.
 *
 * Decoding uses an OfflineAudioContext, not a live AudioContext: no context
 * is created before a user gesture, and iOS's limit on live contexts is left
 * for playback. decodeAudioData resamples to the context's rate. Input with
 * more than two channels (or, defensively, a buffer that came back at another
 * rate) is rendered once more through an OfflineAudioContext of at most two
 * channels, which downmixes it with the standard speaker rules.
 *
 * Throws an Error whose message is meant for the user.
 * @param {Blob} file the picked file
 * @param {number} [sampleRate=44100] the rate to decode to
 * @returns {Promise<{channels: Float32Array[], sampleRate: number, length: number}>}
 */
export async function decodeFile(file, sampleRate = 44100) {
  const Offline = globalThis.OfflineAudioContext;
  if (typeof Offline !== "function") {
    throw new Error("This browser cannot decode audio. Try a recent Safari, Chrome or Firefox.");
  }
  const decode = (bytes) => new Offline(1, 1, sampleRate).decodeAudioData(bytes);
  // A video first: movie.js takes its sound out as a small M4A and never
  // reads the picture, so the byte cap below does not count the picture.
  const movie = await movieAudio(file, { maxBytes: MAX_INPUT_BYTES, maxSeconds: MAX_INPUT_SECONDS });
  // Written so that a size that is missing or not a number does not fit.
  const fits = file.size <= MAX_INPUT_BYTES;
  let decoded = null;
  if (movie !== null) {
    // A refusal stands when the browser's own decoder would fare no better
    // with the whole file, or the file is too large to hand it whole.
    if (movie.refusal !== undefined && (movie.final || !fits)) {
      throw new Error(movie.refusal);
    }
    if (movie.bytes !== undefined) {
      try {
        decoded = await decode(movie.bytes.buffer);
      } catch {
        if (!fits) throw new Error(VIDEO_SOUND_UNREADABLE);
      }
    }
  }
  if (decoded === null) {
    // Before the file is read whole: decoding a file of hundreds of megabytes
    // can end a phone's tab before the duration check below ever runs.
    if (!fits) {
      throw new Error(`This file is larger than ${MAX_INPUT_BYTES / (1024 * 1024)} MB. Trim it first, or save it `
        + "in a smaller format such as MP3 or AAC (M4A), then pick it again.");
    }
    // An audio file, as always. Also a video within the cap whose sound
    // movie.js could not take out: a browser that decodes it whole, as some
    // did before, still does.
    const bytes = await file.arrayBuffer();
    try {
      decoded = await decode(bytes);
    } catch {
      if (movie !== null) throw new Error(movie.refusal ?? VIDEO_SOUND_UNREADABLE);
      throw new Error("This file could not be read as audio. Try another file, such as an MP3, M4A or WAV.");
    }
  }
  if (!(decoded.duration <= MAX_INPUT_SECONDS)) {
    throw new Error(`This file is longer than ${MAX_INPUT_SECONDS / 60} minutes. Trim it first, or pick a shorter file.`);
  }
  if (!(decoded.duration >= MIN_INPUT_SECONDS)) {
    throw new Error("This file is shorter than half a second, which is too short for a ringtone.");
  }
  const count = Math.min(decoded.numberOfChannels, 2);
  let buffer = decoded;
  if (decoded.numberOfChannels > 2 || decoded.sampleRate !== sampleRate) {
    const length = Math.ceil(decoded.duration * sampleRate);
    const context = new Offline(count, length, sampleRate);
    const source = context.createBufferSource();
    source.buffer = decoded;
    source.connect(context.destination);
    source.start(0);
    buffer = await context.startRendering();
  }
  const channels = [];
  for (let c = 0; c < count; c += 1) {
    channels.push(buffer.getChannelData(c));
  }
  return { channels, sampleRate, length: buffer.length };
}
