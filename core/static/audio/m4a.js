// A minimal M4A (MP4 audio) writer for AAC-LC frames: the file of a tone
// made on the device (docs/PLAN.md 15.4), from what the browser's own
// AudioEncoder emits. The phone-encode spike (tools/spike/phone_encode)
// showed that iOS takes a tone in this container for "Use as Ringtone".
//
// The layout copies what the server's ffmpeg writes with `-f ipod
// -movflags +faststart` (core/strange_ringtone/render.py), which Phase 0
// showed iOS accepts: ftyp "M4A ", then moov, then mdat. It leaves out what
// that file has and a player doesn't need: the title tag (iOS names a tone
// after the file) and the roll-recovery sample groups.
//
// The page's other M4A writer, inside movie.js, shares nothing with this
// one: that one copies a video's frames and their config untouched for the
// decoder to read, and this one writes only what our own encoder made.
//
// Pure: no DOM, no WebCodecs, so node:test covers it (tests/js/m4a.test.mjs).

/** Samples in one AAC-LC frame. */
export const AAC_FRAME_SAMPLES = 1024;
/**
 * The delay of Apple's AAC encoder, in samples (Technical Note TN2258). On an
 * iPhone the encoder's timestamps start at 0 and do not say so.
 */
export const APPLE_PRIMING = 2112;

// MPEG-4 Audio's sampling_frequency_index table (ISO/IEC 14496-3).
const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const AAC_LC = 2;
// Frames per chunk: about a second, as common muxers write. One chunk for the
// whole file would be legal too.
const FRAMES_PER_CHUNK = 43;

/**
 * The two-byte AudioSpecificConfig for AAC-LC: 5 bits object type, 4 bits
 * rate index, 4 bits channel configuration, 3 zero bits.
 *
 * Built here, not taken from the encoder: WebKit bug 302253 reports wrong
 * "description" bytes from Safari's AudioEncoder, and for plain AAC-LC the
 * rate and the channel count are all the config says.
 * @param {number} sampleRate
 * @param {number} channels 1 or 2
 * @returns {Uint8Array}
 */
export function audioSpecificConfig(sampleRate, channels) {
  const index = SAMPLE_RATES.indexOf(sampleRate);
  if (index < 0) throw new RangeError(`not an AAC sample rate: ${sampleRate}`);
  if (channels !== 1 && channels !== 2) throw new RangeError(`channels must be 1 or 2, not ${channels}`);
  const bits = (AAC_LC << 11) | (index << 7) | (channels << 3);
  return new Uint8Array([bits >> 8, bits & 0xff]);
}

/**
 * Split an ADTS stream into its raw AAC frames. WebCodecs encoders emit raw
 * frames by default; this is for one that emits ADTS anyway (rawFrames), and
 * for feeding the writer from an `.aac` file when checking it against ffprobe.
 * @param {Uint8Array} bytes
 * @returns {{frames: Uint8Array[], sampleRate: number, channels: number}}
 */
export function splitAdts(bytes) {
  const frames = [];
  let sampleRate = 0;
  let channels = 0;
  let offset = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < 7) throw new Error("truncated ADTS header");
    // Syncword 0xFFF and layer 00; the MPEG version bit and protection_absent vary.
    if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xf6) !== 0xf0) throw new Error("no ADTS syncword");
    const header = (bytes[offset + 1] & 0x01) === 1 ? 7 : 9; // 9 with a CRC
    const profile = bytes[offset + 2] >> 6; // the object type minus one
    const rate = SAMPLE_RATES[(bytes[offset + 2] >> 2) & 0x0f];
    const channelConfig = ((bytes[offset + 2] & 0x01) << 2) | (bytes[offset + 3] >> 6);
    const length = ((bytes[offset + 3] & 0x03) << 11) | (bytes[offset + 4] << 3) | (bytes[offset + 5] >> 5);
    if (profile !== AAC_LC - 1) throw new Error("not AAC-LC");
    if (rate === undefined) throw new Error("reserved ADTS sample rate");
    if ((bytes[offset + 6] & 0x03) !== 0) throw new Error("more than one AAC frame in an ADTS frame");
    if (length <= header || offset + length > bytes.length) throw new Error("bad ADTS frame length");
    if (frames.length > 0 && (rate !== sampleRate || channelConfig !== channels)) {
      throw new Error("the ADTS stream changes format");
    }
    sampleRate = rate;
    channels = channelConfig;
    frames.push(bytes.slice(offset + header, offset + length));
    offset += length;
  }
  if (frames.length === 0) throw new Error("no ADTS frames");
  return { frames, sampleRate, channels };
}

// The start of every ADTS frame: twelve 1 bits, then the two layer bits,
// which are always 0. A raw AAC frame that began like this would be saying,
// in its first three bits, that it holds nothing at all. (A chunk of one
// byte has no second byte to match, and so is not ADTS.)
function startsLikeAdts(chunk) {
  return chunk[0] === 0xff && (chunk[1] & 0xf6) === 0xf0;
}

/**
 * The encoder's chunks as raw AAC frames. An encoder that wraps every chunk
 * in an ADTS header has the headers taken off, because an MP4 holds raw
 * frames; chunks that are raw already come back as they are.
 *
 * There is no third kind. Where no chunk starts like ADTS, they are raw.
 * Where any does, every chunk must be exactly one ADTS frame of its own
 * length, in the format that was asked for; anything else (some chunks ADTS
 * and some not, two frames in a chunk, a byte too many) is refused, because
 * it would otherwise be written into the file with its headers on.
 * @param {Uint8Array[]} chunks what the encoder emitted, in order
 * @param {number} sampleRate the rate the encoder was set up for
 * @param {number} channels the channel count it was set up for
 * @returns {Uint8Array[]} raw frames
 */
export function rawFrames(chunks, sampleRate, channels) {
  if (!Array.isArray(chunks) || chunks.length === 0) throw new RangeError("no frames");
  let claims = 0;
  for (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array) || chunk.length === 0) {
      throw new TypeError("a frame must be a non-empty Uint8Array");
    }
    if (startsLikeAdts(chunk)) claims += 1;
  }
  if (claims === 0) return chunks;
  if (claims !== chunks.length) throw new Error("the encoder's frames are part ADTS and part not");
  return chunks.map((chunk) => {
    // Throws for a chunk that is not ADTS all the way through.
    const adts = splitAdts(chunk);
    if (adts.frames.length !== 1) throw new Error("more than one ADTS frame in one chunk");
    // The headers state a format too, and one that is not what was asked
    // for would go into a file whose own header says otherwise.
    if (adts.sampleRate !== sampleRate || adts.channels !== channels) {
      throw new Error("the encoder's ADTS frames are not in the format that was asked for");
    }
    return adts.frames[0];
  });
}

/**
 * How many samples of encoder delay ("priming") the frames start with, which
 * the edit list has to skip (docs/PLAN.md 15.2 and 15.4).
 *
 *   1. A first chunk with a negative timestamp says so itself.
 *   2. A first timestamp that is not negative, and at least Apple's 2112
 *      samples more in the frames than went in: Apple's encoder, which
 *      delays by 2112 and stamps its first chunk 0.
 *   3. Otherwise the whole frames of surplus, the usual delay of an encoder
 *      that has less to spare (none, for the one measured on Windows).
 *
 * Then the frames must be exactly as many as the audio and that delay fill:
 * no fewer, and not a whole frame more. Both encoders that were measured
 * (plan 15.2) emit exactly that many.
 *
 * What this cannot see: rules 2 and 3 read the delay off the frame count,
 * so an encoder that loses whole frames from the END of its output looks
 * like one with a shorter delay. The tone then starts up to 48 ms late and
 * ends as much early; its length stays exact. (A frame lost anywhere else
 * shows in the timestamps, which encode.js checks.)
 *
 * @param {object} options
 * @param {number} options.firstTimestamp the first chunk's timestamp, in microseconds
 * @param {number} options.sampleRate in Hz
 * @param {number} options.frames how many frames the encoder emitted
 * @param {number} options.samples how many samples went in
 * @returns {number} whole samples; priming + samples always fits in the frames
 */
export function primingSamples({ firstTimestamp, sampleRate, frames, samples }) {
  if (!Number.isFinite(firstTimestamp)) throw new RangeError("the first timestamp must be a finite number");
  if (!(Number.isFinite(sampleRate) && sampleRate > 0)) throw new RangeError("sample rate out of range");
  if (!Number.isInteger(frames) || frames < 1) throw new RangeError("frames must be a whole number, at least 1");
  if (!Number.isInteger(samples) || samples < 1) throw new RangeError("samples must be a whole number, at least 1");
  const surplus = frames * AAC_FRAME_SAMPLES - samples;
  let priming;
  if (firstTimestamp < 0) {
    priming = Math.round((-firstTimestamp * sampleRate) / 1e6);
  } else if (surplus >= APPLE_PRIMING) {
    priming = APPLE_PRIMING;
  } else {
    priming = Math.floor(surplus / AAC_FRAME_SAMPLES) * AAC_FRAME_SAMPLES;
  }
  // Fewer samples came out than went in, or the timestamp claims a delay the
  // frames have no room for: an edit list written from that would present
  // audio that is not there.
  if (surplus < 0 || priming > surplus) {
    throw new RangeError("the encoder returned less audio than it was given");
  }
  // A whole frame or more past the audio and its delay: frames that belong
  // to nothing that went in, or a delay none of the rules knows.
  if (surplus - priming >= AAC_FRAME_SAMPLES) {
    throw new RangeError("the encoder returned more frames than the audio fills");
  }
  return priming;
}

function concat(parts) {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u8(...values) {
  return Uint8Array.from(values);
}

function u16(...values) {
  const out = new Uint8Array(values.length * 2);
  const view = new DataView(out.buffer);
  values.forEach((value, i) => view.setUint16(i * 2, value));
  return out;
}

function u32(...values) {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((value, i) => view.setUint32(i * 4, value));
  return out;
}

function ascii(text) {
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

function box(type, ...parts) {
  const body = concat(parts);
  return concat([u32(8 + body.length), ascii(type), body]);
}

function fullBox(type, version, flags, ...parts) {
  return box(type, u32(version * 0x1000000 + flags), ...parts);
}

// An MPEG-4 descriptor with a one-byte length, which every descriptor here fits.
function descriptor(tag, ...parts) {
  const body = concat(parts);
  if (body.length > 127) throw new RangeError("descriptor too long");
  return concat([u8(tag, body.length), body]);
}

const UNITY_MATRIX = u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000);

/**
 * Write an M4A file from raw AAC-LC frames.
 *
 * Every frame decodes to AAC_FRAME_SAMPLES samples. An AAC encoder's output
 * starts with `priming` samples of delay and ends with padding up to a whole
 * frame; with `priming` or `samples` given, an edit list tells the player to
 * present exactly `samples` samples from `priming` on, so the file's duration
 * is the audio's and not the frames'. With neither, no edit list is written
 * and the file plays every sample of every frame.
 *
 * @param {object} options
 * @param {number} options.sampleRate a rate AAC has, at most 65535 (the sample entry holds it in 16 bits)
 * @param {number} options.channels 1 or 2
 * @param {Uint8Array[]} options.frames raw AAC-LC frames (no ADTS header)
 * @param {number} [options.priming=0] samples to skip at the start
 * @param {number} [options.samples] samples to present; the rest by default
 * @returns {Uint8Array}
 */
export function writeM4a({ sampleRate, channels, frames, priming = 0, samples }) {
  const config = audioSpecificConfig(sampleRate, channels);
  // The sample entry stores the rate as 16.16 fixed point.
  if (sampleRate > 0xffff) throw new RangeError(`sample rate too high for an MP4 sample entry: ${sampleRate}`);
  if (!Array.isArray(frames) || frames.length === 0) throw new RangeError("no frames");
  let dataBytes = 0;
  let largest = 0;
  for (const frame of frames) {
    if (!(frame instanceof Uint8Array) || frame.length === 0) throw new TypeError("a frame must be a non-empty Uint8Array");
    dataBytes += frame.length;
    largest = Math.max(largest, frame.length);
  }
  const mediaSamples = frames.length * AAC_FRAME_SAMPLES;
  if (!Number.isInteger(priming) || priming < 0 || priming >= mediaSamples) {
    throw new RangeError(`priming must be a whole number of samples within the audio, not ${priming}`);
  }
  const rest = mediaSamples - priming;
  if (samples !== undefined && (!Number.isInteger(samples) || samples < 1 || samples > rest)) {
    throw new RangeError(`samples must be between 1 and ${rest}, not ${samples}`);
  }
  const presented = samples ?? rest;
  const edited = priming > 0 || presented < mediaSamples;

  // The movie's timescale is the sample rate, so every duration is exact.
  const seconds = mediaSamples / sampleRate;
  const averageBitrate = Math.round((dataBytes * 8) / seconds);
  const peakBitrate = Math.round((largest * 8 * sampleRate) / AAC_FRAME_SAMPLES);

  const chunkCount = Math.ceil(frames.length / FRAMES_PER_CHUNK);
  const lastChunkFrames = frames.length - (chunkCount - 1) * FRAMES_PER_CHUNK;
  // (first chunk, frames per chunk, sample description) runs.
  const chunkRuns = [];
  if (chunkCount > 1) chunkRuns.push(1, FRAMES_PER_CHUNK, 1);
  if (chunkCount === 1 || lastChunkFrames !== FRAMES_PER_CHUNK) chunkRuns.push(chunkCount, lastChunkFrames, 1);

  const ftyp = box("ftyp", ascii("M4A "), u32(512), ascii("M4A "), ascii("isom"), ascii("iso2"));

  const moov = (dataStart) => {
    const chunkOffsets = [];
    let position = dataStart;
    frames.forEach((frame, i) => {
      if (i % FRAMES_PER_CHUNK === 0) chunkOffsets.push(position);
      position += frame.length;
    });

    const esds = fullBox("esds", 0, 0, descriptor(0x03, // ES_Descriptor
      u16(0), u8(0), // ES_ID 0 as stored in a file, no flags
      descriptor(0x04, // DecoderConfigDescriptor
        u8(0x40, 0x15), // MPEG-4 Audio; an audio stream
        u8(largest >> 16, (largest >> 8) & 0xff, largest & 0xff), // decoder buffer size
        u32(peakBitrate, averageBitrate),
        descriptor(0x05, config)), // DecoderSpecificInfo: the AudioSpecificConfig
      descriptor(0x06, u8(0x02)))); // SLConfigDescriptor: MP4's predefined one
    const mp4a = box("mp4a",
      new Uint8Array(6), u16(1), // reserved, data reference 1
      new Uint8Array(8), // version, revision, vendor
      u16(channels, 16, 0, 0), // channels, bits per sample, compression ID, packet size
      u32(sampleRate * 0x10000),
      esds);
    const stbl = box("stbl",
      fullBox("stsd", 0, 0, u32(1), mp4a),
      fullBox("stts", 0, 0, u32(1, frames.length, AAC_FRAME_SAMPLES)),
      fullBox("stsc", 0, 0, u32(chunkRuns.length / 3, ...chunkRuns)),
      fullBox("stsz", 0, 0, u32(0, frames.length, ...frames.map((frame) => frame.length))),
      fullBox("stco", 0, 0, u32(chunkOffsets.length, ...chunkOffsets)));
    const minf = box("minf",
      fullBox("smhd", 0, 0, u16(0, 0)),
      box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1))), // the data is in this file
      stbl);
    const mdia = box("mdia",
      fullBox("mdhd", 0, 0, u32(0, 0, sampleRate, mediaSamples), u16(0x55c4, 0)), // language "und"
      fullBox("hdlr", 0, 0, u32(0), ascii("soun"), new Uint8Array(12), ascii("SoundHandler\0")),
      minf);
    const parts = [
      // Flags 3: enabled and in the movie, as ffmpeg writes them.
      fullBox("tkhd", 0, 3, u32(0, 0, 1, 0, presented, 0, 0), u16(0, 0, 0x0100, 0), UNITY_MATRIX, u32(0, 0)),
    ];
    if (edited) {
      // One edit: `presented` samples of the media from `priming`, at rate 1.
      parts.push(box("edts", fullBox("elst", 0, 0, u32(1, presented, priming), u16(1, 0))));
    }
    parts.push(mdia);
    return box("moov",
      fullBox("mvhd", 0, 0, u32(0, 0, sampleRate, presented, 0x00010000), u16(0x0100, 0), u32(0, 0),
        UNITY_MATRIX, new Uint8Array(24), u32(2)), // next track ID 2
      box("trak", ...parts));
  };

  // moov comes before the audio, so its size decides the audio's offsets;
  // those don't change its size, so the second pass is final.
  const dataStart = ftyp.length + moov(0).length + 8;
  return concat([ftyp, moov(dataStart), u32(8 + dataBytes), ascii("mdat"), ...frames]);
}
