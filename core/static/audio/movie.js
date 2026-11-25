// A video's sound, taken out of the file in the browser (docs/PLAN.md 4.1).
//
// Safari's decoder does not open the QuickTime movie that an iPhone's Photo
// Library hands a page (WebKit bug 228971), and a video's bytes are mostly
// its picture. So for a movie the page reads the index (the "moov" box),
// copies the audio track's AAC frames out by their byte ranges, and wraps
// them in a plain audio-only M4A, which every browser's decoder opens. The
// picture is never kept, so the page's byte cap counts the sound alone. Where
// sound and picture alternate every few kilobytes, as in most MP4s, a read
// runs on through the picture between two pieces of sound (MAX_GAP_BYTES,
// MAX_SPAN_BYTES) and drops it at once; in a phone's movie the pieces lie
// megabytes apart, and the picture is not read at all. The reads go by where
// the sound lies in the file, not by the order it plays in, so the file's own
// size bounds how many there are, whatever order the index names.
//
// Nothing here decodes audio: the frames pass through untouched, and the
// browser's decoder still judges them. Every number below comes from the
// file, so each one is checked against the bytes that are really there
// before it is used as an offset, a length or a count.

/**
 * The largest index read, in bytes. An hour of video at 60 frames a second
 * has an index of about 5 MB; this bounds what one pick can make the page
 * hold before it knows how long the video is.
 */
export const MAX_INDEX_BYTES = 16 * 1024 * 1024;

/**
 * The most audio frames taken from one track. Ten minutes of AAC at 96 kHz
 * is 56,250 frames, and the length check counts frames, so only a stream
 * that claims a rate far above any real one comes near this. It bounds the
 * tables built from the index however the stream describes itself.
 */
export const MAX_AUDIO_FRAMES = 262144;

/**
 * The most boxes looked at, at the top of the file, on the way to the index.
 * A phone's movie has four (ftyp, wide, mdat, moov), and each costs one small
 * read.
 */
export const MAX_TOP_BOXES = 64;

/**
 * The widest gap between two pieces of sound that one read runs through. An
 * MP4 that alternates sound and picture with every video frame has tens of
 * thousands of pieces in ten minutes; reading each on its own would be that
 * many round trips to the file. Past this, skipping the gap is cheaper.
 */
export const MAX_GAP_BYTES = 64 * 1024;

/**
 * The most one read of sound takes, gaps included, so that a read never adds
 * more than this to what the page holds beside the M4A it is filling. A
 * piece of sound longer than this is read in parts.
 */
export const MAX_SPAN_BYTES = 4 * 1024 * 1024;

/**
 * The most reads of sound. Ten minutes of AAC at 96 kHz with every frame a
 * piece of its own, picture all around it, is under 60,000. Pieces closer
 * than MAX_GAP_BYTES share a read, so a file that needs more than this is
 * gigabytes of pieces set apart on purpose.
 */
export const MAX_SOUND_READS = 65536;

/**
 * The longest decoder configuration (the content of the esds box) taken. It
 * goes into the M4A byte for byte, so it is held to a size; a real one is
 * about 50 bytes.
 */
export const MAX_CONFIG_BYTES = 256;

// The most tracks looked at. A phone's movie has under ten.
const MAX_TRACKS = 32;
// A box header at its longest: size, type and a 64-bit size.
const HEADER_BYTES = 16;
// What a file of this family starts with. Anything else is not one, and is
// left to the decoder after this one small read.
const FIRST_BOXES = new Set(["ftyp", "moov", "mdat", "free", "skip", "wide", "pnot"]);
// The esds object types that are AAC: MPEG-4 Audio, and MPEG-2 AAC Main, LC
// and SSR. An "mp4a" entry can also hold MP3, which an M4A must not.
const AAC_OBJECT_TYPES = new Set([0x40, 0x66, 0x67, 0x68]);
// The kinds of AAC taken, by the audio object type in the stream's own
// configuration: Main, LC, SSR, LTP, and the two names HE-AAC goes by. Each
// of their frames holds 1024 samples, or 960, which the length check counts
// on. The low-delay kinds and xHE-AAC have shorter frames and are left to
// the decoder with the whole file.
const AAC_AUDIO_TYPES = new Set([1, 2, 3, 4, 5, 29]);
const MIN_FRAME_SAMPLES = 960;
const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
// Channels for each AAC channel configuration; 0 leaves it to the stream.
const CHANNELS = [2, 1, 2, 3, 4, 5, 6, 8];

const NO_SOUND = "This video has no sound.";
const FORMAT = "This video's sound is in a format this page cannot take out of a video. "
  + "Convert the video to MP4 with AAC sound, or save its sound as an M4A or MP3, then pick that.";
const FRAGMENTS = "This video is stored in fragments, which this page cannot take sound out of. "
  + "Save it again as an ordinary MP4 or MOV, or save its sound as an M4A or MP3, then pick that.";
const UNREADABLE = "This video could not be read. It may be damaged or cut short. Try another file.";
const INDEX_TOO_LARGE = "This file's index is too large for this page to read. Trim the file first, then pick it again.";

// A refusal on its way out of the parser. `final` says the whole file would
// fare no better with the browser's own decoder, so it is not tried.
class Refused extends Error {
  constructor(message, final) {
    super(message);
    this.final = final;
  }
}

function need(condition) {
  if (!condition) throw new Refused(UNREADABLE, false);
}

function fourcc(bytes, at) {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

async function read(file, start, length) {
  const buffer = await file.slice(start, start + length).arrayBuffer();
  // A read that comes back short means the file is not what its size said.
  need(buffer.byteLength === length);
  return new Uint8Array(buffer);
}

/**
 * Walk the top of the file to the index.
 * @returns {Promise<null | {start: number, length: number, quicktime: boolean}>}
 *   where the index's content is, or null for a file that is not of this
 *   family or shows no index
 */
async function findIndex(file, size) {
  let offset = 0;
  let brand = null;
  for (let i = 0; i < MAX_TOP_BOXES; i += 1) {
    if (size - offset < 8) return null;
    const head = await read(file, offset, Math.min(HEADER_BYTES, size - offset));
    const view = viewOf(head);
    const type = fourcc(head, 4);
    if (i === 0 && !FIRST_BOXES.has(type)) return null;
    let length = view.getUint32(0);
    let header = 8;
    if (length === 1) {
      // A 64-bit size, as the picture's box has in a video over 4 GB. One
      // too large for a Number to hold exactly is far past the file's end,
      // which the check below refuses.
      if (head.length < HEADER_BYTES) return null;
      length = view.getUint32(8) * 2 ** 32 + view.getUint32(12);
      header = HEADER_BYTES;
    } else if (length === 0) {
      length = size - offset;
    }
    // A box that ends before its own header does, or after the file does,
    // would send the next read somewhere the file never pointed.
    if (length < header || length > size - offset) return null;
    if (type === "ftyp" && brand === null && head.length >= header + 4) brand = fourcc(head, header);
    if (type === "moov") {
      // No ftyp at all is how QuickTime wrote movies before it had one.
      return { start: offset + header, length: length - header, quicktime: brand === null || brand === "qt  " };
    }
    offset += length;
  }
  return null;
}

/**
 * The boxes in bytes [start, end), one after another. Stops at the first one
 * that does not fit: what the caller needs is then missing, and that is what
 * it reports. A caller that must know whether it saw every box passes
 * `walk`, whose `broken` is set when the walk stopped that way.
 */
function* boxes(bytes, view, start, end, walk = null) {
  let at = start;
  while (end - at >= 8) {
    let length = view.getUint32(at);
    let header = 8;
    if (length === 1) {
      // A 64-bit size needs its sixteen bytes to be there, and inside an
      // index of at most MAX_INDEX_BYTES its high word is zero. One that
      // is not so leaves the size at 1, less than any header, and the
      // check below ends the walk.
      if (end - at >= HEADER_BYTES && view.getUint32(at + 8) === 0) {
        length = view.getUint32(at + 12);
        header = HEADER_BYTES;
      }
    } else if (length === 0) {
      length = end - at;
    }
    if (length < header || length > end - at) {
      if (walk !== null) walk.broken = true;
      return;
    }
    yield { type: fourcc(bytes, at + 4), start: at + header, end: at + length };
    at += length;
  }
}

function child(bytes, view, parent, type) {
  for (const box of boxes(bytes, view, parent.start, parent.end)) {
    if (box.type === type) return box;
  }
  return null;
}

// One MPEG-4 descriptor at `at`: a tag, a length of up to four 7-bit bytes,
// and that much content. Null for one that does not lie inside [at, end).
// That takes the one check at the bottom: a tag at or past `end`, or a
// length cut off by it, leaves the content starting past `end`, whatever
// the bytes read there were (past the index they read as nothing).
function descriptor(bytes, at, end) {
  let size = 0;
  let pos = at + 1;
  for (let i = 0; i < 4; i += 1) {
    const byte = bytes[pos];
    pos += 1;
    size = size * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) break;
  }
  if (size > end - pos) return null;
  return { tag: bytes[at], start: pos, end: pos + size };
}

function findDescriptor(bytes, start, end, tag) {
  let at = start;
  for (;;) {
    const found = descriptor(bytes, at, end);
    if (found === null) return null;
    if (found.tag === tag) return found;
    at = found.end;
  }
}

/**
 * The sample rate and channel count an esds box declares, or null when it
 * is not AAC of a kind taken (AAC_AUDIO_TYPES) with a readable configuration.
 * For HE-AAC the rate is the core's, which is the one its frames count in.
 */
function audioConfig(bytes, start, end) {
  // Version and flags, then the ES descriptor: an ID, a flags byte and the
  // optional fields those flags announce, then the decoder's configuration.
  // A descriptor too short for what is read from it sends the search for the
  // next one past its end, where descriptor() finds nothing.
  const es = findDescriptor(bytes, start + 4, end, 0x03);
  if (es === null) return null;
  const flags = bytes[es.start + 2];
  let at = es.start + 3;
  if (flags & 0x80) at += 2;
  if (flags & 0x40) {
    // The URL's length is a byte of the file. Past the index there is none,
    // and the place to go on from would not be a number at all.
    if (at >= es.end) return null;
    at += 1 + bytes[at];
  }
  if (flags & 0x20) at += 2;
  const decoder = findDescriptor(bytes, at, es.end, 0x04);
  if (decoder === null) return null;
  if (!AAC_OBJECT_TYPES.has(bytes[decoder.start])) return null;
  // Thirteen bytes of type, buffer size and bitrates come first.
  const info = findDescriptor(bytes, decoder.start + 13, decoder.end, 0x05);
  if (info === null) return null;

  // The AudioSpecificConfig, bit by bit: object type, rate, channels.
  let bit = info.start * 8;
  const limit = info.end * 8;
  const bits = (count) => {
    if (bit + count > limit) return -1;
    let value = 0;
    for (let i = 0; i < count; i += 1, bit += 1) {
      value = value * 2 + ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1);
    }
    return value;
  };
  // An escape to a longer type (31) names none of the kinds taken.
  if (!AAC_AUDIO_TYPES.has(bits(5))) return null;
  const rateIndex = bits(4);
  const rate = rateIndex === 15 ? bits(24) : SAMPLE_RATES[rateIndex];
  // A reserved index has no rate, and bits that ran out are -1. Whole bytes
  // that held the rate hold the four bits of the layout too.
  if (!(rate > 0)) return null;
  return { rate, channels: CHANNELS[bits(4)] ?? 2 };
}

/**
 * What a sound track's sample description says, or null when it is not AAC
 * the page can repackage (PCM, Apple's spatial codec, MP3, AC-3 and so on).
 */
function soundEntry(bytes, view, stbl) {
  const stsd = child(bytes, view, stbl, "stsd");
  if (stsd === null || stsd.end - stsd.start < 16 || view.getUint32(stsd.start + 4) < 1) return null;
  const at = stsd.start + 8;
  const end = at + view.getUint32(at);
  if (end > stsd.end || fourcc(bytes, at + 4) !== "mp4a") return null;
  // The fixed fields differ by version: plain (also every MP4), QuickTime's
  // version 1 with four more numbers, and its version 2 with a longer
  // record. The boxes that matter come after them. For a version this does
  // not know, or an entry shorter than its fields, that is past the entry's
  // end, where the walk below finds nothing.
  const version = end - at >= 18 ? view.getUint16(at + 16) : -1;
  const fixed = [36, 52, 72][version] ?? Infinity;
  let esds = null;
  for (const box of boxes(bytes, view, at + fixed, end)) {
    // QuickTime keeps the esds inside a "wave" box; MP4 has it directly.
    if (box.type === "esds") esds = box;
    if (box.type === "wave") esds = child(bytes, view, box, "esds");
    if (esds !== null) break;
  }
  if (esds === null || esds.end - esds.start > MAX_CONFIG_BYTES) return null;
  const config = audioConfig(bytes, esds.start, esds.end);
  return config === null ? null : { esds: bytes.subarray(esds.start, esds.end), ...config };
}

/**
 * The index's tracks.
 * @returns {{video: boolean, sounds: object[], partial: boolean, fragments: boolean, broken: boolean}}
 *   whether one is a picture; the sound tracks that play, in the file's
 *   order; whether some track could not be looked at, so that neither "no
 *   sound track" nor "no track is enabled" is known for sure; whether the
 *   index says the movie has fragments; and whether the index breaks off,
 *   so that what it says after the break is not known
 */
function readTracks(bytes, view) {
  let video = false;
  let fragments = false;
  let partial = false;
  let count = 0;
  const walk = { broken: false };
  const sounds = [];
  for (const top of boxes(bytes, view, 0, bytes.length, walk)) {
    if (top.type === "mvex") fragments = true;
    // QuickTime can keep its whole index deflated inside this box, tracks
    // and all. It is not unpacked here, so its tracks were not looked at.
    if (top.type === "cmov") partial = true;
    if (top.type !== "trak") continue;
    count += 1;
    if (count > MAX_TRACKS) {
      // Not looked at. The walk goes on past it all the same: the box that
      // says the movie has fragments can come after the tracks.
      partial = true;
      continue;
    }
    const mdia = child(bytes, view, top, "mdia");
    const hdlr = mdia === null ? null : child(bytes, view, mdia, "hdlr");
    // A track that does not say what it is may be the sound.
    if (hdlr === null || hdlr.end - hdlr.start < 12) {
      partial = true;
      continue;
    }
    const kind = fourcc(bytes, hdlr.start + 8);
    if (kind === "vide") video = true;
    if (kind !== "soun") continue;
    const minf = child(bytes, view, mdia, "minf");
    const stbl = minf === null ? null : child(bytes, view, minf, "stbl");
    const mdhd = child(bytes, view, mdia, "mdhd");
    const tkhd = child(bytes, view, top, "tkhd");
    // Its tables, its clock, and the header whose flags say whether it is
    // enabled: a sound track without one of them could not be looked at.
    if (stbl === null || mdhd === null || tkhd === null || tkhd.end - tkhd.start < 4) {
      partial = true;
      continue;
    }
    // The low flag bit is "enabled".
    sounds.push({ enabled: (bytes[tkhd.start + 3] & 1) === 1, mdhd, stbl });
  }
  // What plays is what is enabled, and only that is taken (the owner's
  // decision, 2026-11-25): a disabled track can be other sound altogether,
  // a commentary or another language. A file that enables no sound track
  // plays its first, and that no track is enabled is known only when every
  // track was looked at: one that could not be may be the one that plays,
  // and then a disabled track is not taken in its place.
  const unseen = partial || walk.broken;
  const playing = sounds.filter((track) => track.enabled);
  return {
    video, sounds: playing.length > 0 || unseen ? playing : sounds, partial: unseen, fragments, broken: walk.broken,
  };
}

/**
 * How many entries a table box declares, once the box is known to be there,
 * to hold its count, and to hold that many entries of `width` bytes. The
 * count sits after four bytes of version and flags, the entries after it.
 */
function entryCount(view, table, width) {
  need(table !== null && table.end - table.start >= 8);
  const count = view.getUint32(table.start + 4);
  need(count <= (table.end - table.start - 8) / width);
  return count;
}

/**
 * Where a track's frames are in the file, from its sample tables.
 * @param {{rate: number, fileSize: number, maxSeconds: number}} given
 *   the stream's sample rate, and the limits
 * @returns {{timescale: number, ticks: number, stts: Uint8Array, sizes: Uint32Array,
 *   ranges: number[][], total: number}} the ranges are [offset, length] in
 *   the file, one per chunk in playing order, and total is their bytes
 */
function frameRanges(bytes, view, track, { rate, fileSize, maxSeconds }) {
  const { mdhd, stbl } = track;
  // mdhd: the track's clock. Version 1 has 64-bit times before it. In an
  // empty box the version byte read is not the box's own; the check after
  // it refuses that box wherever the byte sends this.
  const timescaleAt = mdhd.start + (bytes[mdhd.start] === 1 ? 20 : 12);
  need(timescaleAt + 4 <= mdhd.end);
  const timescale = view.getUint32(timescaleAt);
  need(timescale >= 1);

  // stts: how many frames, and how long they play.
  const stts = child(bytes, view, stbl, "stts");
  const runs = entryCount(view, stts, 8);
  let frames = 0;
  let ticks = 0;
  for (let i = 0; i < runs; i += 1) {
    const count = view.getUint32(stts.start + 8 + i * 8);
    // The M4A carries these runs as they are. A run of no frames says
    // nothing, and a file could fill its index with them.
    need(count >= 1);
    frames += count;
    ticks += count * view.getUint32(stts.start + 12 + i * 8);
  }
  // A track with no frames is no sound this can take. (A movie that keeps
  // them in fragments was refused before it got here.)
  if (frames === 0) throw new Refused(FORMAT, false);
  // Before a byte of sound is read. The durations are the index's own
  // account of the length. The decoder goes by the frames, each of at least
  // MIN_FRAME_SAMPLES at the stream's rate, so those are counted too: an
  // index cannot call an hour of frames a second.
  const seconds = Math.max(ticks / timescale, frames * MIN_FRAME_SAMPLES / rate);
  if (!(seconds <= maxSeconds)) {
    throw new Refused(`This video is longer than ${maxSeconds / 60} minutes. `
      + "Trim it first (the Photos app can), or pick a shorter one.", true);
  }
  // Everything below is sized from the frame count.
  need(frames <= MAX_AUDIO_FRAMES);
  // The rebuilt header holds the duration in 32 bits.
  need(ticks <= 0xffffffff);

  // stsz: each frame's size, or one size for all.
  const stsz = child(bytes, view, stbl, "stsz");
  need(stsz !== null && stsz.end - stsz.start >= 12);
  const uniform = view.getUint32(stsz.start + 4);
  need(view.getUint32(stsz.start + 8) === frames);
  const sizes = new Uint32Array(frames);
  if (uniform === 0) {
    need(frames <= (stsz.end - stsz.start - 12) / 4);
    for (let i = 0; i < frames; i += 1) sizes[i] = view.getUint32(stsz.start + 12 + i * 4);
  } else {
    sizes.fill(uniform);
  }

  // stsc: how many frames each chunk holds, as runs of chunks.
  const stsc = child(bytes, view, stbl, "stsc");
  const groups = entryCount(view, stsc, 12);
  // The walk below reads the first run without asking whether there is one.
  need(groups >= 1);

  // stco or co64: where each chunk starts in the file.
  const stco = child(bytes, view, stbl, "stco");
  const offsets = stco ?? child(bytes, view, stbl, "co64");
  const width = stco === null ? 8 : 4;
  const chunks = entryCount(view, offsets, width);

  const ranges = [];
  let total = 0;
  let frame = 0;
  let group = 0;
  for (let chunk = 1; chunk <= chunks && frame < frames; chunk += 1) {
    while (group + 1 < groups && view.getUint32(stsc.start + 8 + (group + 1) * 12) <= chunk) group += 1;
    const perChunk = view.getUint32(stsc.start + 12 + group * 12);
    // A chunk holds at least a frame, so this walk is as long as the track
    // has frames and not as long as a table of empty chunks.
    need(perChunk >= 1);
    // One description for the whole track: the rebuilt file has only one.
    need(view.getUint32(stsc.start + 16 + group * 12) === 1);
    const at = offsets.start + 8 + (chunk - 1) * width;
    let offset = view.getUint32(at);
    if (width === 8) offset = offset * 2 ** 32 + view.getUint32(at + 4);
    let length = 0;
    const last = Math.min(frame + perChunk, frames);
    for (; frame < last; frame += 1) length += sizes[frame];
    // Inside the file, or the read would be of something else, or nothing.
    need(offset <= fileSize - length);
    total += length;
    ranges.push([offset, length]);
  }
  // Every frame the tables count has a place in some chunk.
  need(frame === frames);
  return { timescale, ticks, stts: bytes.subarray(stts.start + 8, stts.start + 8 + runs * 8), sizes, ranges, total };
}

/**
 * The reads that fetch these ranges of the file, each one stretch of it with
 * the pieces of sound it holds: [offset in the file, length, place in the
 * M4A]. `at` is where the first range goes.
 *
 * The pieces are taken by where they lie in the file, not by the order they
 * play in: an index can name the same two places in turn for every frame,
 * and reading in playing order would then be a read for each frame. Sorted,
 * pieces within MAX_GAP_BYTES of each other share a read of at most
 * MAX_SPAN_BYTES, so the reads number about one for every MAX_GAP_BYTES of
 * the file at the most.
 */
function planReads(ranges, at) {
  const pieces = [];
  for (const [offset, length] of ranges) {
    // Cut to MAX_SPAN_BYTES, so that no read is longer however the sound lies.
    for (let done = 0; done < length; done += MAX_SPAN_BYTES) {
      const part = Math.min(MAX_SPAN_BYTES, length - done);
      pieces.push([offset + done, part, at]);
      at += part;
    }
  }
  pieces.sort((a, b) => a[0] - b[0]);
  const reads = [];
  let current = null;
  for (const piece of pieces) {
    const end = piece[0] + piece[1];
    if (current !== null && piece[0] - current.end <= MAX_GAP_BYTES
        && end - current.start <= MAX_SPAN_BYTES) {
      current.end = Math.max(end, current.end);
      current.pieces.push(piece);
    } else {
      current = { start: piece[0], end, pieces: [piece] };
      reads.push(current);
    }
  }
  return reads;
}

// --- the audio-only M4A ---------------------------------------------------------------

function concat(parts) {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function u32(...values) {
  const out = new Uint8Array(values.length * 4);
  const view = viewOf(out);
  values.forEach((value, i) => view.setUint32(i * 4, value));
  return out;
}

function u16(...values) {
  const out = new Uint8Array(values.length * 2);
  const view = viewOf(out);
  values.forEach((value, i) => view.setUint16(i * 2, value));
  return out;
}

function ascii(text) {
  return Uint8Array.from(text, (character) => character.charCodeAt(0));
}

function box(type, ...parts) {
  let length = 8;
  for (const part of parts) length += part.length;
  return concat([u32(length), ascii(type), ...parts]);
}

// The unity matrix every movie and track header carries.
const MATRIX = u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000);

/**
 * Everything of the M4A before the frames: ftyp, the index and the header of
 * the box the frames go in. The layout is the plainest there is: one track,
 * one chunk, the index first.
 */
function m4aHeader({ esds, rate, channels, timescale, ticks, stts, sizes, total }) {
  const ftyp = box("ftyp", ascii("M4A "), u32(0), ascii("M4A "), ascii("mp42"), ascii("isom"));
  const frames = sizes.length;
  const stsz = new Uint8Array(frames * 4);
  const stszView = viewOf(stsz);
  sizes.forEach((size, i) => stszView.setUint32(i * 4, size));
  const moov = box("moov",
    // Version and flags, two dates, the clock and the length, then normal
    // speed and full volume, and the ID the next track would get.
    box("mvhd", u32(0, 0, 0, timescale, ticks, 0x00010000), u16(0x0100, 0), u32(0, 0), MATRIX,
      u32(0, 0, 0, 0, 0, 0, 2)),
    box("trak",
      // Flags 7: enabled, in the movie, in the preview. Track 1.
      box("tkhd", u32(7, 0, 0, 1, 0, ticks, 0, 0), u16(0, 0, 0x0100, 0), MATRIX, u32(0, 0)),
      box("mdia",
        // 0x55c4 is the language "und".
        box("mdhd", u32(0, 0, 0, timescale, ticks), u16(0x55c4, 0)),
        box("hdlr", u32(0, 0), ascii("soun"), u32(0, 0, 0), ascii("SoundHandler\0")),
        box("minf",
          box("smhd", u32(0, 0)),
          // One reference, flagged "the data is in this file".
          box("dinf", box("dref", u32(0, 1), box("url ", u32(1)))),
          box("stbl",
            box("stsd", u32(0, 1),
              // Six reserved bytes and data reference 1; eight reserved;
              // channels, 16 bits, two reserved fields, the rate as 16.16.
              box("mp4a", u16(0, 0, 0, 1), u32(0, 0), u16(channels, 16, 0, 0), u32(rate <= 0xffff ? rate * 65536 : 0),
                box("esds", esds))),
            box("stts", u32(0, stts.length / 8), stts),
            // One chunk holding every frame, using description 1.
            box("stsc", u32(0, 1, 1, frames, 1)),
            box("stsz", u32(0, 0, frames), stsz),
            box("stco", u32(0, 1, 0)))))));
  const header = concat([ftyp, moov, u32(8 + total), ascii("mdat")]);
  // The one chunk starts where this header ends. Its offset is the index's
  // last four bytes, because stco is the last box in every box around it;
  // written here, the index is built once and not a second time to measure.
  viewOf(header).setUint32(ftyp.length + moov.length - 4, header.length);
  return header;
}

/**
 * Take the sound out of a movie, as an audio-only M4A in memory.
 *
 * Reads the first bytes of any file, the index of a file of the MP4 family
 * (at most MAX_INDEX_BYTES), and of a movie the audio track's bytes, with
 * the small gaps read through, in at most MAX_SOUND_READS reads of at most
 * MAX_SPAN_BYTES. A movie is a file of that family with a picture track, or
 * a QuickTime one.
 * @param {Blob} file the picked file
 * @param {{maxBytes: number, maxSeconds: number}} limits the largest M4A
 *   built, in bytes, and the longest sound, in seconds
 * @returns {Promise<null | {bytes: Uint8Array} | {refusal: string, final: boolean}>}
 *   null for a file that is not a movie, which the decoder gets whole as
 *   before; the M4A; or why not, in words for the user. A refusal that is
 *   not final leaves the whole file worth a try with the browser's decoder.
 */
export async function movieAudio(file, { maxBytes, maxSeconds }) {
  const size = file.size;
  if (typeof file.slice !== "function" || !Number.isSafeInteger(size)) return null;
  try {
    const found = await findIndex(file, size);
    if (found === null) return null;
    // Before it is read: the index is held whole, and only then parsed.
    if (found.length > MAX_INDEX_BYTES) throw new Refused(INDEX_TOO_LARGE, false);
    const index = await read(file, found.start, found.length);
    const view = viewOf(index);
    const { video, sounds, partial, fragments, broken } = readTracks(index, view);
    if (!video && !found.quicktime) return null;
    // "No sound" is for good only when every track was looked at. A damaged
    // index hides tracks, and then the whole file is still worth a try.
    if (sounds.length === 0) throw new Refused(partial ? UNREADABLE : NO_SOUND, !partial);
    // A movie with fragments keeps its sound outside this index: all of it,
    // or all but the beginning. The index's own tables can hold that
    // beginning, and an M4A made of them would pass for the whole sound, so
    // nothing is taken, however full the tables are.
    if (fragments) throw new Refused(FRAGMENTS, false);
    // Where the index breaks off, the box that says so may be the one at
    // the break or lie past it, unseen, and the same beginning would be
    // taken for the whole. An index not read to its end gives no sound.
    if (broken) throw new Refused(UNREADABLE, false);
    let track = null;
    let entry = null;
    for (const candidate of sounds) {
      entry = soundEntry(index, view, candidate.stbl);
      if (entry !== null) {
        track = candidate;
        break;
      }
    }
    if (track === null) throw new Refused(FORMAT, false);
    const tables = frameRanges(index, view, track, { rate: entry.rate, fileSize: size, maxSeconds });
    const header = m4aHeader({ ...entry, ...tables });
    // The page's byte cap, on the whole of what the decoder is handed,
    // before any sound is read.
    if (header.length + tables.total > maxBytes) {
      throw new Refused(`This video's sound is larger than ${maxBytes / (1024 * 1024)} MB. `
        + "Trim the video first, then pick it again.", true);
    }
    const reads = planReads(tables.ranges, header.length);
    need(reads.length <= MAX_SOUND_READS);
    const bytes = new Uint8Array(header.length + tables.total);
    bytes.set(header, 0);
    for (const { start, end, pieces } of reads) {
      const span = await read(file, start, end - start);
      for (const [offset, length, at] of pieces) {
        bytes.set(span.subarray(offset - start, offset - start + length), at);
      }
    }
    return { bytes };
  } catch (error) {
    if (error instanceof Refused) return { refusal: error.message, final: error.final };
    // A read the browser itself refused: the caller's to report, as before.
    throw error;
  }
}
