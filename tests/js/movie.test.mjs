// A video's sound, taken out of the file by the page (core/static/audio/movie.js,
// docs/PLAN.md 4.1): what it reads, what it builds, and every bound it holds
// a file to. The movies are made box by box in movie_fixture.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";

import * as movieModule from "../../core/static/audio/movie.js";
import {
  AAC_44K_MONO, ascii, box, concat, dig, esdsPayload, fileOf, movie, someFrames, soundEntry, u32,
} from "./movie_fixture.mjs";

const { movieAudio, MAX_INDEX_BYTES, MAX_AUDIO_FRAMES, MAX_TOP_BOXES, MAX_GAP_BYTES, MAX_SPAN_BYTES } = movieModule;
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const LIMITS = { maxBytes: 64 * MIB, maxSeconds: 600 };
const STBL = ["moov", "trak", "mdia", "minf", "stbl"];
const UNREADABLE = /could not be read/;
const FORMAT = /format this page cannot take out of a video/;

async function take(made, { limits = LIMITS, size = made.size, realSize = size } = {}) {
  const file = fileOf(made.segments, size, { realSize });
  return { result: await movieAudio(file, limits), file };
}

// The reads after the one that fetched the index: the sound's.
function soundReads(file, made) {
  const index = file.reads.findIndex(([start]) => start === made.index.at + 8);
  assert.notEqual(index, -1, "the index was never read");
  return file.reads.slice(index + 1);
}

function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function text(bytes) {
  return String.fromCharCode(...bytes);
}

/** The result is an M4A whose one track holds exactly these frames. */
function assertM4a(result, frames, { timescale = 48000, rate = 48000, channels = 2, esds = esdsPayload() } = {}) {
  assert.notEqual(result, null);
  assert.equal(result.refusal, undefined, result.refusal);
  const { bytes } = result;
  assert.equal(text(bytes.subarray(4, 12)), "ftypM4A ");
  const stsz = viewOf(dig(bytes, [...STBL, "stsz"]));
  assert.deepEqual([stsz.getUint32(4), stsz.getUint32(8)], [0, frames.length]);
  assert.deepEqual(frames.map((_, i) => stsz.getUint32(12 + i * 4)), frames.map((frame) => frame.length));
  // One chunk with every frame, which starts where the index says and runs
  // to the end of the file, inside a box of exactly that size.
  assert.deepEqual([...dig(bytes, [...STBL, "stsc"])], [...u32(0, 1, 1, frames.length, 1)]);
  const stco = viewOf(dig(bytes, [...STBL, "stco"]));
  assert.equal(stco.getUint32(4), 1);
  const offset = stco.getUint32(8);
  const sound = concat(frames);
  assert.deepEqual(bytes.subarray(offset), sound);
  assert.equal(viewOf(bytes).getUint32(offset - 8), 8 + sound.length);
  assert.equal(text(bytes.subarray(offset - 4, offset)), "mdat");
  // The decoder's configuration is the source's own, byte for byte.
  assert.deepEqual(dig(bytes, [...STBL, "stsd", "mp4a", "esds"]), esds);
  const entry = viewOf(dig(bytes, [...STBL, "stsd", "mp4a"]));
  assert.deepEqual([entry.getUint16(16), entry.getUint16(18), entry.getUint32(24)], [channels, 16, rate * 65536]);
  const mdhd = viewOf(dig(bytes, ["moov", "trak", "mdia", "mdhd"]));
  assert.deepEqual([mdhd.getUint32(12), mdhd.getUint32(16)], [timescale, frames.length * 1024]);
  assert.deepEqual([...dig(bytes, [...STBL, "stts"])], [...u32(0, 1, frames.length, 1024)]);
  assert.equal(text(dig(bytes, ["moov", "trak", "mdia", "hdlr"]).subarray(8, 12)), "soun");
  // One track, and nothing of the picture.
  assert.equal(text(bytes).split("trak").length, 2);
}

function assertRefused(result, pattern, final) {
  assert.notEqual(result, null);
  assert.equal(result.bytes, undefined);
  assert.match(result.refusal, pattern);
  assert.equal(result.final, final);
}

/** The movie with its index's bytes changed in place by `change(bytes, view)`. */
function withIndex(made, change) {
  const moov = made.segments.find((segment) => segment.name === "moov");
  const bytes = moov.bytes.slice();
  change(bytes, new DataView(bytes.buffer));
  return { ...made, segments: made.segments.map((segment) => (segment === moov ? { ...segment, bytes } : segment)) };
}

// Where the last box of this name starts in the index (at its size field).
function lastBox(bytes, name) {
  return text(bytes).lastIndexOf(name) - 4;
}

// --- what it takes out ----------------------------------------------------------------

test("a phone's movie gives its sound as an M4A, and the picture is never read", async () => {
  // ftyp qt, wide, the data with 3 MiB of picture before each piece of
  // sound, and the index last, with QuickTime's version 1 sound description.
  const made = movie({ picture: 3 * MIB });
  const { result, file } = await take(made);
  assertM4a(result, made.sounds[0].frames);
  assert.deepEqual(soundReads(file, made), made.sounds[0].ranges.map(([at, length]) => [at, at + length]));
  // Four headers of 16 bytes, the index, and the sound.
  const read = file.reads.reduce((sum, [start, end]) => sum + end - start, 0);
  assert.equal(read, 4 * 16 + made.index.length - 8 + concat(made.sounds[0].frames).length);
  assert.equal(file.whole, 0, "the file was read whole");
});

test("a video of several gigabytes is no more to read than a small one", async () => {
  const made = movie({ picture: 1.5 * GIB, sounds: [{ co64: true }] });
  assert.ok(made.size > 4 * GIB);
  const { result, file } = await take(made);
  assertM4a(result, made.sounds[0].frames);
  assert.deepEqual(soundReads(file, made), made.sounds[0].ranges.map(([at, length]) => [at, at + length]));
  assert.ok(file.reads.every(([start, end]) => end - start <= made.index.length));
});

test("an MP4 with a picture, its index first and a plain sound description, works the same", async () => {
  const esds = esdsPayload({ longLengths: true });
  const made = movie({ brand: "isom", indexFirst: true, sounds: [{ entry: soundEntry({ esds }) }] });
  const { result } = await take(made);
  assertM4a(result, made.sounds[0].frames, { esds });
});

test("QuickTime's version 2 sound description is read too", async () => {
  const made = movie({ sounds: [{ entry: soundEntry({ version: 2, wave: true }) }] });
  assertM4a((await take(made)).result, made.sounds[0].frames);
});

test("the rate and channels come from the stream's own configuration, and the clock from the track", async () => {
  const esds = esdsPayload({ config: AAC_44K_MONO });
  const made = movie({ sounds: [{ entry: soundEntry({ esds }), timescale: 44100, mdhdVersion: 1 }] });
  assertM4a((await take(made)).result, made.sounds[0].frames, { esds, timescale: 44100, rate: 44100, channels: 1 });
});

test("a QuickTime file with sound alone, and a movie from before ftyp existed, are taken too", async () => {
  const soundOnly = movie({ picture: 0 });
  assertM4a((await take(soundOnly)).result, soundOnly.sounds[0].frames);
  const old = movie({ brand: null });
  assertM4a((await take(old)).result, old.sounds[0].frames);
});

test("the first sound track the page can repackage is the one taken", async () => {
  const spatial = soundEntry({ format: "apac", esds: null });
  const made = movie({ sounds: [{ entry: spatial, frames: someFrames(4, { seed: 9 }) }, {}] });
  assertM4a((await take(made)).result, made.sounds[1].frames);
});

test("an enabled sound track is taken before a disabled one", async () => {
  const made = movie({ sounds: [{ enabled: false, frames: someFrames(4, { seed: 9 }) }, {}] });
  assertM4a((await take(made)).result, made.sounds[1].frames);
  // With none enabled, the first.
  const none = movie({ sounds: [{ enabled: false }, { enabled: false, frames: someFrames(4, { seed: 9 }) }] });
  assertM4a((await take(none)).result, none.sounds[0].frames);
});

test("frames of one size for all, as the index may say it, are cut the same", async () => {
  const frames = someFrames(6, { length: 9 });
  const made = movie({ sounds: [{ frames, tables: { stsz: u32(0, 9, 6) } }] });
  assertM4a((await take(made)).result, frames);
});

// --- how it reads ---------------------------------------------------------------------

test("pieces of sound a small gap apart come in one read; a wider gap is skipped", async () => {
  const near = movie({ picture: MAX_GAP_BYTES });
  const one = await take(near);
  assertM4a(one.result, near.sounds[0].frames);
  const ranges = near.sounds[0].ranges;
  const last = ranges[ranges.length - 1];
  assert.deepEqual(soundReads(one.file, near), [[ranges[0][0], last[0] + last[1]]]);

  const far = movie({ picture: MAX_GAP_BYTES + 1 });
  const each = await take(far);
  assertM4a(each.result, far.sounds[0].frames);
  assert.deepEqual(soundReads(each.file, far), far.sounds[0].ranges.map(([at, length]) => [at, at + length]));
});

test("no read through gaps is longer than MAX_SPAN_BYTES", async () => {
  assert.equal(MAX_SPAN_BYTES, 4 * MIB);
  // A hundred pieces 60 kB apart: 6 MB if it were one read.
  const made = movie({ picture: 60000, sounds: [{ frames: someFrames(300) }] });
  const { result, file } = await take(made);
  assertM4a(result, made.sounds[0].frames);
  const reads = soundReads(file, made);
  assert.equal(reads.length, 2);
  assert.ok(reads.every(([start, end]) => end - start <= MAX_SPAN_BYTES), JSON.stringify(reads));
});

test("pieces that play in another order than they lie in the file are still each read right", async () => {
  const frames = someFrames(6, { length: 9 });
  const laid = movie({ sounds: [{ frames, perChunk: 2 }] });
  const offsets = laid.sounds[0].ranges.map(([at]) => at).reverse();
  const made = movie({ sounds: [{ frames, perChunk: 2, tables: { stco: u32(0, 3, ...offsets) } }] });
  const { result } = await take(made);
  assertM4a(result, [frames[4], frames[5], frames[2], frames[3], frames[0], frames[1]]);
});

// --- what it leaves alone -------------------------------------------------------------

test("a file that is not of the MP4 family costs one read of 16 bytes", async () => {
  const wav = concat([ascii("RIFF"), u32(0x24080000), ascii("WAVEfmt "), new Uint8Array(100)]);
  const file = fileOf([{ name: "wav", at: 0, bytes: wav }], wav.length);
  assert.equal(await movieAudio(file, LIMITS), null);
  assert.deepEqual(file.reads, [[0, 16]]);
});

test("a file whose first box is not one a movie starts with is left alone after one read", async () => {
  // A whole movie behind it, which a walk that went on would find.
  const made = movie();
  const head = made.segments.find((segment) => segment.name === "head");
  const bytes = head.bytes.slice();
  bytes.set(ascii("abcd"), 4);
  const file = fileOf(made.segments.map((segment) => (segment === head ? { ...segment, bytes } : segment)), made.size);
  assert.equal(await movieAudio(file, LIMITS), null);
  assert.deepEqual(file.reads, [[0, 16]]);
});

test("an audio file of the MP4 family is left to the decoder, after its index is read", async () => {
  const made = movie({ brand: "M4A ", picture: 0, sounds: [{ entry: soundEntry() }] });
  const { result, file } = await take(made);
  assert.equal(result, null);
  assert.deepEqual(soundReads(file, made), []);
});

test("something with no slice, or no size, is not looked at", async () => {
  assert.equal(await movieAudio({ size: 8, arrayBuffer: async () => new ArrayBuffer(8) }, LIMITS), null);
  for (const size of [undefined, Number.NaN, 2 ** 60]) {
    const made = movie();
    const file = fileOf(made.segments, size);
    assert.equal(await movieAudio(file, LIMITS), null, String(size));
    assert.deepEqual(file.reads, [], String(size));
  }
  const tiny = fileOf([{ name: "x", at: 0, bytes: ascii("ftyp") }], 4);
  assert.equal(await movieAudio(tiny, LIMITS), null);
  assert.deepEqual(tiny.reads, []);
});

// --- refusals -------------------------------------------------------------------------

test("a video with no sound track is refused for good", async () => {
  const made = movie({ sounds: [] });
  assertRefused((await take(made)).result, /has no sound/, true);
});

test("sound that is not AAC is refused, and the whole file is still worth a try", async () => {
  const entries = {
    "PCM": soundEntry({ format: "sowt", esds: null }),
    // Protected sound keeps its AAC configuration, and its frames are
    // ciphertext: repackaged as plain AAC they would decode to noise.
    "encrypted sound": soundEntry({ format: "enca" }),
    "MP3 in an mp4a entry": soundEntry({ esds: esdsPayload({ objectType: 0x6b }) }),
    "no esds": soundEntry({ esds: null }),
    "an unknown version": soundEntry({ version: 3 }),
    "a configuration cut short": soundEntry({ esds: esdsPayload({ config: [0x11] }) }),
    "no configuration": soundEntry({ esds: esdsPayload({ config: [] }) }),
    "a reserved rate": soundEntry({ esds: esdsPayload({ config: [0x16, 0x90] }) }),
  };
  for (const [name, entry] of Object.entries(entries)) {
    const made = movie({ sounds: [{ entry }] });
    const { result, file } = await take(made);
    assert.notEqual(result, null, name);
    assert.match(result.refusal, FORMAT, name);
    assert.equal(result.final, false, name);
    assert.deepEqual(soundReads(file, made), [], name);
  }
});

test("a sample description that claims to run past its box is not followed there", async () => {
  const entry = soundEntry();
  new DataView(entry.buffer).setUint32(0, entry.length + 4);
  assertRefused((await take(movie({ sounds: [{ entry }] }))).result, FORMAT, false);
});

test("a descriptor that claims more than its box holds is not followed there", async () => {
  const esds = esdsPayload();
  // The ES descriptor's length, one byte after its tag.
  esds[5] = 0x7f;
  assertRefused((await take(movie({ sounds: [{ entry: soundEntry({ esds }) }] }))).result, FORMAT, false);
});

test("a sample description box that holds none, or is too short to say, is a format refusal", async () => {
  for (const stsd of [concat([u32(0, 0), soundEntry()]), u32(0, 1)]) {
    assertRefused((await take(movie({ sounds: [{ tables: { stsd } }] }))).result, FORMAT, false);
  }
  // The same short box as the last thing in the index, where reading the
  // entry it promises would run off the end.
  const last = movie({ tail: false, sounds: [{ tables: { stsd: u32(0, 1), stts: null, stsc: null, stsz: null, stco: null } }] });
  assertRefused((await take(last)).result, FORMAT, false);
});

test("a track whose frames are in fragments is refused as a format", async () => {
  const made = movie({ sounds: [{ tables: { stts: u32(0, 0), stsz: u32(0, 0, 0) } }] });
  const { result, file } = await take(made);
  assertRefused(result, FORMAT, false);
  assert.deepEqual(soundReads(file, made), []);
});

test("a video longer than the limit is refused by its index, before its sound is read", async () => {
  // 28125 frames of 1024 at 48 kHz are 600 s to the tick.
  const over = movie({ sounds: [{ tables: { stts: u32(0, 1, 28126, 1024) } }] });
  const { result, file } = await take(over);
  assertRefused(result, /longer than 10 minutes/, true);
  assert.deepEqual(soundReads(file, over), []);
  // Exactly the limit passes this check (and fails a later one: the tables
  // here do not really hold that many frames).
  const at = movie({ sounds: [{ tables: { stts: u32(0, 1, 28125, 1024) } }] });
  assertRefused((await take(at)).result, UNREADABLE, false);
});

test("sound over the byte cap is refused by its index, before any of it is read", async () => {
  const made = movie();
  const total = concat(made.sounds[0].frames).length;
  const over = await take(made, { limits: { maxBytes: total - 1, maxSeconds: 600 } });
  assertRefused(over.result, /sound is larger than/, true);
  assert.deepEqual(soundReads(over.file, made), []);
  assertM4a((await take(made, { limits: { maxBytes: total, maxSeconds: 600 } })).result, made.sounds[0].frames);

  // With the page's own cap: frames that claim 12 MiB each, three to a
  // chunk, so the second chunk passes it, in a file large enough that both
  // chunks lie inside it.
  const huge = movie({ picture: GIB, sounds: [{ tables: { stsz: u32(0, 12 * MIB, 7) } }] });
  const refused = await take(huge);
  assertRefused(refused.result, /sound is larger than 64 MB/, true);
  assert.deepEqual(soundReads(refused.file, huge), []);
});

// --- bounds on what a file can make the page do ---------------------------------------

test("an index over MAX_INDEX_BYTES is refused before it is read", async () => {
  assert.equal(MAX_INDEX_BYTES, 16 * MIB);
  const ftyp = box("ftyp", ascii("qt  "), u32(0));
  for (const [length, pattern, final] of [
    [MAX_INDEX_BYTES + 1, /index is too large/, false],
    // At the cap it is read: zeros, so a movie with no tracks at all.
    [MAX_INDEX_BYTES, /has no sound/, true],
  ]) {
    const head = concat([ftyp, u32(8 + length), ascii("moov")]);
    const file = fileOf([{ name: "head", at: 0, bytes: head }], head.length + length);
    assertRefused(await movieAudio(file, LIMITS), pattern, final);
    const longest = Math.max(...file.reads.map(([start, end]) => end - start));
    assert.equal(longest, final ? MAX_INDEX_BYTES : 16);
  }
});

test("the index is looked for in the first MAX_TOP_BOXES boxes only", async () => {
  assert.equal(MAX_TOP_BOXES, 64);
  // ftyp, wide, the padding, the data, then the index.
  const within = movie({ before: Array(MAX_TOP_BOXES - 4).fill(box("free")) });
  assertM4a((await take(within)).result, within.sounds[0].frames);
  const past = movie({ before: Array(MAX_TOP_BOXES - 3).fill(box("free")) });
  const { result, file } = await take(past);
  assert.equal(result, null);
  assert.equal(file.reads.length, MAX_TOP_BOXES);
});

test("a top-level box shorter than its own header ends the walk", async () => {
  const bytes = concat([box("ftyp", ascii("qt  "), u32(0)), u32(4), ascii("free"), new Uint8Array(64)]);
  const file = fileOf([{ name: "x", at: 0, bytes }], bytes.length);
  assert.equal(await movieAudio(file, LIMITS), null);
  assert.equal(file.reads.length, 2);
});

test("a 64-bit size cut off by the end of the file ends the walk", async () => {
  const bytes = concat([box("ftyp", ascii("qt  "), u32(0)), u32(1), ascii("mdat"), u32(0)]);
  const file = fileOf([{ name: "x", at: 0, bytes }], bytes.length);
  assert.equal(await movieAudio(file, LIMITS), null);
});

test("a box inside the index that claims to run past its parent is not followed", async () => {
  const made = withIndex(movie(), (bytes, view) => view.setUint32(lastBox(bytes, "mdia"), 0x7ffffff0));
  // The sound track's media box is gone with it, so no sound track is left.
  assertRefused((await take(made)).result, /has no sound/, true);
});

test("a 64-bit size inside the index is followed only when it is a real one", async () => {
  // The index's first box, 108 bytes, given a 64-bit size in its 16 bytes.
  const sized = (high, low) => withIndex(movie(), (bytes) => {
    bytes.set(concat([u32(1), ascii("free"), u32(high, low)]), 8);
  });
  const real = sized(0, 108);
  assertM4a((await take(real)).result, real.sounds[0].frames);
  // A high word, or a size under the header's own: the walk ends there,
  // before any track.
  assertRefused((await take(sized(1, 108))).result, /has no sound/, true);
  assertRefused((await take(sized(0, 0))).result, /has no sound/, true);
});

test("an index that claims to run past the end of the file is not read", async () => {
  const made = movie();
  const { result, file } = await take(made, { size: made.size - 1 });
  assert.equal(result, null);
  assert.ok(file.reads.every(([start, end]) => end - start <= 16));
});

test("a read that comes back short is a refusal, not sound with a hole in it", async () => {
  const made = movie({ indexFirst: true });
  assertRefused((await take(made, { realSize: made.size - 1 })).result, UNREADABLE, false);
});

test("only the first 32 tracks are looked at", async () => {
  // The picture, the metadata tracks, then the sound.
  const within = movie({ extraTracks: 30 });
  assertM4a((await take(within)).result, within.sounds[0].frames);
  assertRefused((await take(movie({ extraTracks: 31 }))).result, /has no sound/, true);
});

test("more frames than MAX_AUDIO_FRAMES are refused, however short the index says they play", async () => {
  assert.equal(MAX_AUDIO_FRAMES, 262144);
  const tables = (count) => ({ stts: u32(0, 1, count, 1), stsz: u32(0, 1, count), stsc: u32(0, 1, 1, count, 1) });
  const over = movie({ sounds: [{ frames: someFrames(1, { length: MAX_AUDIO_FRAMES + 1 }), perChunk: 1,
    tables: tables(MAX_AUDIO_FRAMES + 1) }] });
  const { result, file } = await take(over);
  assertRefused(result, UNREADABLE, false);
  assert.deepEqual(soundReads(file, over), []);
  const at = movie({ sounds: [{ frames: someFrames(1, { length: MAX_AUDIO_FRAMES }), perChunk: 1,
    tables: tables(MAX_AUDIO_FRAMES) }] });
  const taken = (await take(at)).result;
  assert.equal(taken.refusal, undefined);
  assert.deepEqual(taken.bytes.subarray(taken.bytes.length - MAX_AUDIO_FRAMES), at.sounds[0].frames[0]);
});

test("a length that does not fit the rebuilt header's 32 bits is refused", async () => {
  // 1.3 s by its own clock, so not too long, and 5.6e9 ticks.
  const made = movie({ sounds: [{ timescale: 0xffffffff, tables: { stts: u32(0, 1, 7, 0x30000000) } }] });
  assertRefused((await take(made)).result, UNREADABLE, false);
});

test("a track with no clock is refused as unreadable, not as too long", async () => {
  assertRefused((await take(movie({ sounds: [{ timescale: 0 }] }))).result, UNREADABLE, false);
});

test("a clock box too short for its version is not read past its end", async () => {
  // Version 1 keeps the timescale 20 bytes in; this box has 16.
  const made = movie({ sounds: [{ mdhd: u32(0x01000000, 0, 0, 0) }] });
  assertRefused((await take(made)).result, UNREADABLE, false);
});

test("a table too short to hold its own count, at the very end of the index, is refused", async () => {
  // Reading the count would run off the end of the index.
  const offsets = movie({ tail: false, sounds: [{ tables: { stco: u32(0) } }] });
  assertRefused((await take(offsets)).result, UNREADABLE, false);
  const sizes = movie({ tail: false, sounds: [{ tables: { stsz: u32(0, 0), stco: null } }] });
  assertRefused((await take(sizes)).result, UNREADABLE, false);
});

test("tables that disagree, or claim more than their boxes hold, are refused unread", async () => {
  const laid = movie();
  const [first, second] = laid.sounds[0].ranges.map(([at]) => at);
  const sizes = laid.sounds[0].frames.map((frame) => frame.length);
  const cases = {
    "stts claims more runs than it holds": { stts: u32(0, 1000, 7, 1024) },
    "stsz counts another number of frames than stts": { stsz: u32(0, 0, 8, ...sizes, 5) },
    "stsz is cut short": { stsz: u32(0, 0, 7, ...sizes.slice(0, 6)) },
    // A run's worth of bytes follows the zero, for a reader that never asked.
    "stsc counts no runs": { stsc: u32(0, 0, 1, 3, 1) },
    "stsc claims more runs than it holds": { stsc: u32(0, 5, 1, 3, 1) },
    "stsc names a second sample description": { stsc: u32(0, 1, 1, 3, 2) },
    "the chunks hold fewer frames than the track has": { stsc: u32(0, 1, 1, 2, 1) },
    "fewer chunks than the frames need": { stco: u32(0, 2, first, second) },
    "stco claims more chunks than it holds": { stco: u32(0, 3, first, second) },
    "a chunk past the end of the file": { stco: u32(0, 3, first, second, laid.size - 1) },
    "a 64-bit chunk offset far past the end": { stco: u32(0, 3, 0, first, 0, second, 0x00200000, 0), offsetsBox: "co64" },
    "no stts": { stts: null },
    "no stsc": { stsc: null },
    "no stsz": { stsz: null },
    "no chunk offsets": { stco: null },
  };
  for (const [name, tables] of Object.entries(cases)) {
    const made = movie({ sounds: [{ tables }] });
    const { result, file } = await take(made);
    assert.notEqual(result, null, name);
    assert.equal(result.bytes, undefined, name);
    assert.match(result.refusal, UNREADABLE, name);
    assert.equal(result.final, false, name);
    assert.deepEqual(soundReads(file, made), [], name);
  }
});

test("an index with bytes changed at random never throws, and never reads outside the file", async () => {
  const made = movie({ picture: 700 });
  const moov = made.segments.find((segment) => segment.name === "moov");
  const limits = { maxBytes: 4096, maxSeconds: 600 };
  let state = 12345;
  const random = (below) => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state % below;
  };
  const outcomes = { none: 0, sound: 0, refused: 0 };
  for (let round = 0; round < 600; round += 1) {
    const flips = 1 + random(3);
    const changed = withIndex(made, (bytes) => {
      // Past the box's own header, so the walk still finds an index.
      for (let i = 0; i < flips; i += 1) bytes[8 + random(bytes.length - 8)] = random(256);
    });
    const file = fileOf(changed.segments, made.size);
    const result = await movieAudio(file, limits);
    for (const [start, end] of file.reads) {
      assert.ok(start >= 0 && start <= end && end <= made.size, `round ${round}: read [${start}, ${end})`);
    }
    if (result === null) {
      outcomes.none += 1;
    } else if (result.bytes !== undefined) {
      outcomes.sound += 1;
      assert.ok(result.bytes.length <= limits.maxBytes + 4096, `round ${round}`);
    } else {
      outcomes.refused += 1;
      assert.equal(typeof result.refusal, "string");
      assert.equal(typeof result.final, "boolean");
    }
  }
  // The changes really reach the parser: both outcomes happen.
  assert.ok(outcomes.sound > 0 && outcomes.refused > 0, JSON.stringify(outcomes));
});
