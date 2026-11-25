// A video's sound, taken out of the file by the page (core/static/audio/movie.js,
// docs/PLAN.md 4.1): what it reads, what it builds, and every bound it holds
// a file to. The movies are made box by box in movie_fixture.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";

import * as movieModule from "../../core/static/audio/movie.js";
import {
  AAC_44K_MONO, ascii, box, concat, dig, esdsPayload, fileOf, movie, packed, someFrames, soundEntry, u16, u32,
} from "./movie_fixture.mjs";

const {
  movieAudio, MAX_INDEX_BYTES, MAX_AUDIO_FRAMES, MAX_TOP_BOXES, MAX_GAP_BYTES, MAX_SPAN_BYTES, MAX_SOUND_READS,
  MAX_CONFIG_BYTES,
} = movieModule;
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const LIMITS = { maxBytes: 64 * MIB, maxSeconds: 600 };
const STBL = ["moov", "trak", "mdia", "minf", "stbl"];
const UNREADABLE = /could not be read/;
const FORMAT = /format this page cannot take out of a video/;
const FRAGMENTS = /stored in fragments/;
// The box that says a movie has fragments, as the last thing in its index.
const MVEX = box("mvex", box("trex", new Uint8Array(24)));

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

/**
 * The result is an M4A whose one track holds exactly these frames.
 * `rateField` is the entry's own rate field, which holds 16 bits of hertz.
 */
function assertM4a(result, frames, {
  timescale = 48000, rate = 48000, channels = 2, esds = esdsPayload(), rateField = rate * 65536,
} = {}) {
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
  assert.deepEqual([entry.getUint16(16), entry.getUint16(18), entry.getUint32(24)], [channels, 16, rateField]);
  const mdhd = viewOf(dig(bytes, ["moov", "trak", "mdia", "mdhd"]));
  assert.deepEqual([mdhd.getUint32(12), mdhd.getUint32(16)], [timescale, frames.length * 1024]);
  assert.deepEqual([...dig(bytes, [...STBL, "stts"])], [...u32(0, 1, frames.length, 1024)]);
  assert.equal(text(dig(bytes, ["moov", "trak", "mdia", "hdlr"]).subarray(8, 12)), "soun");
  // One track, and nothing of the picture.
  assert.equal(text(bytes).split("trak").length, 2);
}

function assertRefused(result, pattern, final) {
  assert.notEqual(result, null);
  // Not compared with assert.equal: a failure would print the whole M4A.
  assert.ok(result.bytes === undefined, "the sound was taken, not refused");
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

// Where the last box of this name starts in the index (at its size field),
// or the one `fromEnd` boxes of that name before the end.
function lastBox(bytes, name, fromEnd = 1) {
  const all = text(bytes);
  let at = all.length;
  for (let i = 0; i < fromEnd; i += 1) at = all.lastIndexOf(name, at - 1);
  return at - 4;
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
  // Both at once: sound alone, and no ftyp to name a brand. The boxes it
  // does have say nothing of one, whatever bytes follow their headers.
  const oldSound = movie({ brand: null, picture: 0 });
  assertM4a((await take(oldSound)).result, oldSound.sounds[0].frames);
});

test("the brand is the first ftyp's, and one the bytes read do not show counts as none", async () => {
  // Sound alone, so only a QuickTime brand makes these movies. A second
  // ftyp, naming another brand, changes nothing.
  const twice = movie({ picture: 0, before: [box("ftyp", ascii("isom"), u32(0))] });
  assertM4a((await take(twice)).result, twice.sounds[0].frames);
  // An ftyp with a 64-bit size: its brand lies past the sixteen bytes read
  // of each box, and none is made up from what was not read.
  const long = concat([u32(1), ascii("ftyp"), u32(0, 28), ascii("isom"), u32(0), ascii("isom")]);
  const wide = movie({ brand: null, picture: 0, before: [long] });
  assertM4a((await take(wide)).result, wide.sounds[0].frames);
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

test("a track whose header is missing, or too short to say, does not count as enabled", async () => {
  const other = someFrames(4, { seed: 9 });
  // The first sound track's header box, the second from the end, renamed.
  const missing = withIndex(movie({ sounds: [{ frames: other }, {}] }), (bytes) => {
    bytes.set(ascii("free"), lastBox(bytes, "tkhd", 2) + 4);
  });
  assertM4a((await take(missing)).result, missing.sounds[1].frames);
  // An empty header box: the byte where the flag would be is the next
  // box's, the low byte of its size, and here that byte is odd.
  const empty = movie({ sounds: [{ frames: other, tkhd: new Uint8Array(0), entry: soundEntry() }, {}] });
  const index = empty.segments.find((segment) => segment.name === "moov").bytes;
  assert.equal(index[lastBox(index, "mdia", 2) + 3] & 1, 1, "the fixture no longer puts an odd byte there");
  assertM4a((await take(empty)).result, empty.sounds[1].frames);
});

test("a disabled track is not taken while another plays, though it is the only one the page could take", async () => {
  // What plays is PCM. The AAC beside it is switched off: other sound, for
  // all the file says.
  const made = movie({
    sounds: [{ entry: soundEntry({ format: "sowt", esds: null }) }, { enabled: false, frames: someFrames(4, { seed: 9 }) }],
  });
  const { result, file } = await take(made);
  assertRefused(result, FORMAT, false);
  assert.deepEqual(soundReads(file, made), []);
});

test("a disabled track is not taken while a track the index cannot show may be the one that plays", async () => {
  const other = someFrames(4, { seed: 9 });
  // The sound that plays, then AAC that is switched off. Each change hides
  // the first from the page; the second is still not the video's sound.
  const cases = {
    "the playing track's tables are missing": (bytes) => bytes.set(ascii("free"), lastBox(bytes, "stbl", 2) + 4),
    "the playing track's clock is missing": (bytes) => bytes.set(ascii("free"), lastBox(bytes, "mdhd", 2) + 4),
    // A track has two handler boxes, its own and its data's: the fourth
    // from the end is the first sound track's own.
    "a track does not say what it is": (bytes) => bytes.set(ascii("free"), lastBox(bytes, "hdlr", 4) + 4),
  };
  for (const [name, change] of Object.entries(cases)) {
    const made = withIndex(movie({ sounds: [{}, { enabled: false, frames: other }] }), change);
    const { result, file } = await take(made);
    assert.notEqual(result, null, name);
    assert.ok(result.bytes === undefined, `${name}: the disabled track was taken`);
    assert.match(result.refusal, UNREADABLE, name);
    assert.equal(result.final, false, name);
    assert.deepEqual(soundReads(file, made), [], name);
  }
  // More tracks than are looked at: the disabled one is the 32nd, and the
  // 33rd, which plays, is never seen.
  const many = movie({ extraTracks: 30, sounds: [{ enabled: false, frames: other }, {}] });
  assertRefused((await take(many)).result, UNREADABLE, false);
  // The track that plays comes second, and the header that would say so
  // is missing, or there and empty. The first is switched off: not the
  // video's sound, though it is the only one whose header can be read.
  const hidden = withIndex(movie({ sounds: [{ enabled: false, frames: other }, {}] }), (bytes) => {
    bytes.set(ascii("free"), lastBox(bytes, "tkhd") + 4);
  });
  const mute = movie({ sounds: [{ enabled: false, frames: other }, { tkhd: new Uint8Array(0) }] });
  for (const made of [hidden, mute]) {
    const { result, file } = await take(made);
    assertRefused(result, UNREADABLE, false);
    assert.deepEqual(soundReads(file, made), []);
  }
  // An index that breaks off after the disabled track, at a box shorter
  // than its own header: what came after it is not known.
  const cut = movie({ sounds: [{ enabled: false, frames: other }], tail: concat([u32(4), ascii("free"), u32(0)]) });
  assertRefused((await take(cut)).result, UNREADABLE, false);
});

test("HE-AAC is taken, at the rate its frames count in", async () => {
  // Named outright: type 5, the core's 24 kHz, stereo, then the 48 kHz it
  // plays at and the LC underneath.
  const esds = esdsPayload({ config: packed([5, 5], [6, 4], [2, 4], [3, 4], [2, 5]) });
  const made = movie({ sounds: [{ entry: soundEntry({ esds }) }] });
  assertM4a((await take(made)).result, made.sounds[0].frames, { esds, rate: 24000 });
});

test("a rate written out in the configuration, and one too high for the entry's field, are read", async () => {
  // Index 15, then the rate itself in 24 bits.
  const written = esdsPayload({ config: packed([2, 5], [15, 4], [44100, 24], [1, 4]) });
  const one = movie({ sounds: [{ entry: soundEntry({ esds: written }) }] });
  assertM4a((await take(one)).result, one.sounds[0].frames, { esds: written, rate: 44100, channels: 1 });
  // 96 kHz does not fit the entry's 16 bits; the field is left at zero and
  // the configuration says it.
  const high = esdsPayload({ config: packed([2, 5], [0, 4], [2, 4]) });
  const two = movie({ sounds: [{ entry: soundEntry({ esds: high }) }] });
  assertM4a((await take(two)).result, two.sounds[0].frames, { esds: high, rate: 96000, rateField: 0 });
});

test("the optional fields of the stream's descriptor are stepped over", async () => {
  const cases = {
    "a stream it depends on": [0x80, [0, 1]],
    "a URL": [0x40, [3, 0x61, 0x62, 0x63]],
    "a clock reference": [0x20, [0, 2]],
    "all three": [0xe0, [0, 1, 3, 0x61, 0x62, 0x63, 0, 2]],
  };
  for (const [name, [flags, optional]] of Object.entries(cases)) {
    const esds = esdsPayload({ flags, optional });
    const made = movie({ sounds: [{ entry: soundEntry({ esds }) }] });
    const { result } = await take(made);
    assert.equal(result.refusal, undefined, name);
    assertM4a(result, made.sounds[0].frames, { esds });
  }
});

test("a run of chunks begins at the chunk the index names, not one later", async () => {
  // Eight frames end to end, in chunks of one, one, then two each.
  const frames = someFrames(8);
  const laid = movie({ picture: 0, sounds: [{ frames, perChunk: 1 }] });
  const at = laid.sounds[0].ranges.map(([offset]) => offset);
  const tables = { stsc: u32(0, 2, 1, 1, 1, 3, 2, 1), stco: u32(0, 5, at[0], at[1], at[2], at[4], at[6]) };
  const made = movie({ picture: 0, sounds: [{ frames, perChunk: 1, tables }] });
  assertM4a((await take(made)).result, frames);
});

test("a run of chunks is looked for inside its table only", async () => {
  // Twenty-four chunks of a frame each, in one run. After the table of
  // runs comes the box of frame sizes, twenty bytes long: read as one more
  // run, its first bytes would begin at chunk 20.
  const frames = someFrames(24, { length: 9 });
  const made = movie({ sounds: [{ frames, perChunk: 1, tables: { stsz: u32(0, 9, 24) } }] });
  assertM4a((await take(made)).result, frames);
});

test("a chunk said to hold more frames than the track has is walked to the last frame only", async () => {
  // One run for every chunk, of 4,294,967,295 frames each, and a track of
  // seven frames in one chunk. Walked by what the run says, that is four
  // thousand million steps, a quarter of a minute before anything else.
  const made = movie({ sounds: [{ perChunk: 7, tables: { stsc: u32(0, 1, 1, 0xffffffff, 1) } }] });
  assertM4a((await take(made)).result, made.sounds[0].frames);
});

test("chunks the index lists past the last frame are not looked at", async () => {
  // Three chunks hold the seven frames. Two more are listed, at places far
  // outside the file.
  const at = movie().sounds[0].ranges.map(([offset]) => offset);
  const made = movie({ sounds: [{ tables: { stco: u32(0, 5, ...at, 0xfffffff0, 0xfffffff0) } }] });
  assertM4a((await take(made)).result, made.sounds[0].frames);
});

test("the first decoder configuration in a sample description is the one used", async () => {
  // After the real one, a second that names MP3: were it the one read, the
  // track would be refused.
  const entry = concat([soundEntry(), box("esds", esdsPayload({ objectType: 0x6b }))]);
  new DataView(entry.buffer).setUint32(0, entry.length);
  const made = movie({ sounds: [{ entry }] });
  assertM4a((await take(made)).result, made.sounds[0].frames);
});

test("a box of another kind before the decoder configuration is passed over", async () => {
  // MP4 allows other boxes in a sample description, a bit rate box among
  // them, and nothing says the esds comes first.
  const plain = soundEntry();
  const entry = concat([plain.subarray(0, 36), box("btrt", new Uint8Array(12)), plain.subarray(36)]);
  new DataView(entry.buffer).setUint32(0, entry.length);
  const made = movie({ sounds: [{ entry }] });
  assertM4a((await take(made)).result, made.sounds[0].frames);
});

test("a descriptor of another kind before the one looked for is passed over", async () => {
  // Version and flags, a descriptor with a tag of its own, then the stream
  // descriptor as it always is.
  const real = esdsPayload();
  const esds = concat([real.subarray(0, 4), Uint8Array.from([0x06, 1, 2]), real.subarray(4)]);
  const made = movie({ sounds: [{ entry: soundEntry({ esds }) }] });
  assertM4a((await take(made)).result, made.sounds[0].frames, { esds });
});

test("a channel layout the configuration does not name counts as two channels", async () => {
  // AAC-LC at 48 kHz with layout 12, which the table of layouts ends before.
  const esds = esdsPayload({ config: packed([2, 5], [3, 4], [12, 4]) });
  const made = movie({ sounds: [{ entry: soundEntry({ esds }) }] });
  assertM4a((await take(made)).result, made.sounds[0].frames, { esds, channels: 2 });
});

test("an index that runs to the end of the file, by a size of zero, is read", async () => {
  const made = withIndex(movie(), (bytes, view) => view.setUint32(0, 0));
  assertM4a((await take(made)).result, made.sounds[0].frames);
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

test("no read of sound is longer than MAX_SPAN_BYTES, however the sound lies", async () => {
  const frames = someFrames(3, { length: 1.5 * MIB });
  const sound = concat(frames);
  // One chunk of 4.5 MiB, then three chunks end to end: neither is one read.
  for (const [perChunk, first] of [[3, 4 * MIB], [1, 3 * MIB]]) {
    const made = movie({ picture: 0, sounds: [{ frames, perChunk }] });
    const { result, file } = await take(made);
    assert.equal(result.refusal, undefined);
    assert.deepEqual(result.bytes.subarray(result.bytes.length - sound.length), sound);
    const [start] = made.sounds[0].ranges[0];
    assert.deepEqual(soundReads(file, made), [[start, start + first], [start + first, start + sound.length]]);
  }
});

test("pieces that overlap are read once, and each is cut from that read", async () => {
  // Four frames, three in the first chunk. The second chunk is said to
  // begin one byte into the first, so its frame is a cut of those bytes.
  const frames = someFrames(4);
  const laid = movie({ sounds: [{ frames }] });
  const [[first, length]] = laid.sounds[0].ranges;
  const made = movie({ sounds: [{ frames, tables: { stco: u32(0, 2, first, first + 1) } }] });
  const { result, file } = await take(made);
  const cut = concat(frames.slice(0, 3)).subarray(1, 1 + frames[3].length);
  assertM4a(result, [frames[0], frames[1], frames[2], cut]);
  assert.deepEqual(soundReads(file, made), [[first, first + length]]);
});

test("sound the index names in two places, turn about, is read once for each place", async () => {
  // Read in the order it plays, this would be a read for every frame, and
  // an index can name 262,144 of them in a file of a megabyte.
  const frames = someFrames(2000, { length: 1 });
  const laid = movie({ picture: 100 * 1024, sounds: [{ frames, perChunk: 1 }] });
  const [first, second] = laid.sounds[0].ranges.map(([at]) => at);
  const offsets = frames.map((_, i) => (i % 2 === 0 ? first : second));
  const made = movie({
    picture: 100 * 1024, sounds: [{ frames, perChunk: 1, tables: { stco: u32(0, offsets.length, ...offsets) } }],
  });
  const { result, file } = await take(made);
  assertM4a(result, frames.map((_, i) => frames[i % 2]));
  assert.deepEqual(soundReads(file, made), [[first, first + 1], [second, second + 1]]);
});

test("sound in more pieces than MAX_SOUND_READS reads can fetch is refused before any is read", async () => {
  assert.equal(MAX_SOUND_READS, 65536);
  // A byte of sound after every stretch of picture too wide to read
  // through: a file of over 4 GB. The length limit is out of the way.
  const limits = { maxBytes: 64 * MIB, maxSeconds: 6000 };
  const lay = (count) => {
    const made = movie({
      picture: MAX_GAP_BYTES + 1,
      sounds: [{ frames: someFrames(count, { length: 1 }), perChunk: 1, co64: true }],
    });
    // The sound itself is left as holes: what is counted is the reads.
    const file = fileOf(made.segments.filter((segment) => segment.name !== "sound"), made.size);
    return { made, file };
  };
  const over = lay(MAX_SOUND_READS + 1);
  assertRefused(await movieAudio(over.file, limits), UNREADABLE, false);
  assert.deepEqual(soundReads(over.file, over.made), []);
  const at = lay(MAX_SOUND_READS);
  const taken = await movieAudio(at.file, limits);
  assert.equal(taken.refusal, undefined);
  assert.equal(soundReads(at.file, at.made).length, MAX_SOUND_READS);
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

test("after the first box, one of any kind may lie on the way to the index", async () => {
  const made = movie({ before: [box("uuid", new Uint8Array(20)), box("abcd")] });
  assertM4a((await take(made)).result, made.sounds[0].frames);
});

test("an error of the file's own reading is passed on, not turned into a refusal", async () => {
  const gone = new Error("the file went away");
  const file = { size: 4096, slice: () => ({ arrayBuffer: async () => { throw gone; } }) };
  await assert.rejects(movieAudio(file, LIMITS), (error) => error === gone);
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

test("an index kept compressed is not called a video with no sound", async () => {
  // QuickTime can hold its whole index deflated in a cmov box, and files
  // that old often have no ftyp. The page does not unpack it, so no track
  // was looked at: "no sound" is not known, and the whole file is still
  // worth a try with a decoder that reads such an index.
  for (const brand of ["qt  ", null]) {
    const plain = movie({ brand });
    const moov = plain.segments.find((segment) => segment.name === "moov");
    const packed = box("moov", box("cmov",
      box("dcom", ascii("zlib")),
      box("cmvd", u32(moov.bytes.length), deflateSync(moov.bytes))));
    const made = {
      ...plain,
      size: plain.index.at + packed.length,
      segments: plain.segments.map((segment) => (segment === moov ? { ...segment, bytes: packed } : segment)),
    };
    const { result, file } = await take(made);
    assertRefused(result, UNREADABLE, false);
    assert.deepEqual(soundReads(file, made), [], String(brand));
  }
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
    // Version and flags, then: nothing that is a stream descriptor; one of
    // an ID and flags alone; one whose decoder descriptor ends after its
    // thirteen fixed bytes.
    "no stream descriptor": soundEntry({ esds: Uint8Array.from([0, 0, 0, 0, 0x04, 1, 0]) }),
    "no decoder descriptor": soundEntry({ esds: Uint8Array.from([0, 0, 0, 0, 0x03, 3, 0, 0, 0]) }),
    "no configuration descriptor": soundEntry({
      esds: Uint8Array.from([0, 0, 0, 0, 0x03, 18, 0, 0, 0, 0x04, 13, 0x40, 0x15, 0, 0, 0, 0, 1, 0xf4, 0, 0, 1, 0xf4, 0]),
    }),
    "a reserved rate": soundEntry({ esds: esdsPayload({ config: [0x16, 0x90] }) }),
    // Kinds of AAC with shorter frames, which the length check does not
    // count right: low-delay, and xHE-AAC behind the escape to a longer type.
    "low-delay AAC": soundEntry({ esds: esdsPayload({ config: packed([23, 5], [3, 4], [2, 4]) }) }),
    "xHE-AAC": soundEntry({ esds: esdsPayload({ config: packed([31, 5], [10, 6], [3, 4], [2, 4]) }) }),
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

test("a sound track with no sample description box is a format refusal", async () => {
  const made = withIndex(movie(), (bytes) => bytes.set(ascii("free"), lastBox(bytes, "stsd") + 4));
  assertRefused((await take(made)).result, FORMAT, false);
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

test("a descriptor's length is four bytes at the most, and a fifth is not part of it", async () => {
  // The real configuration, with four bytes that each say "the length goes
  // on" put before its stream descriptor's length. Read on into a fifth,
  // the descriptor would be whole; by the four allowed it is empty.
  const real = esdsPayload();
  const esds = concat([real.subarray(0, 5), Uint8Array.from([0x80, 0x80, 0x80, 0x80]), real.subarray(5)]);
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

test("a movie with fragments is refused as that, however much sound its index holds", async () => {
  // The index's own tables are full: they hold the beginning, and the rest
  // is in the fragments after it. Taken, that beginning would pass for the
  // whole sound, and the whole file would never get its try.
  const begun = movie({ tail: MVEX });
  const { result, file } = await take(begun);
  assertRefused(result, FRAGMENTS, false);
  assert.deepEqual(soundReads(file, begun), []);
  // Nothing in the index's tables, as most writers of fragments leave them.
  const empty = { stts: u32(0, 0), stsz: u32(0, 0, 0) };
  assertRefused((await take(movie({ tail: MVEX, sounds: [{ tables: empty }] }))).result, FRAGMENTS, false);
  // No frames and no word of fragments: a format this does not read.
  assertRefused((await take(movie({ sounds: [{ tables: empty }] }))).result, FORMAT, false);
  // Fragments add no tracks, so with none for sound the answer is final.
  assertRefused((await take(movie({ tail: MVEX, sounds: [] }))).result, /has no sound/, true);
});

test("the box that says a movie has fragments is seen past more tracks than are looked at", async () => {
  // The picture, 30 tracks of metadata, the sound as the 32nd, a 33rd
  // track, and only then the box.
  const made = movie({ extraTracks: 30, sounds: [{}, {}], tail: MVEX });
  const { result, file } = await take(made);
  assertRefused(result, FRAGMENTS, false);
  assert.deepEqual(soundReads(file, made), []);
});

test("a decoder configuration longer than MAX_CONFIG_BYTES is not copied", async () => {
  assert.equal(MAX_CONFIG_BYTES, 256);
  // The real configuration, with nothing after it up to the length.
  const padded = (length) => {
    const esds = new Uint8Array(length);
    esds.set(esdsPayload());
    return esds;
  };
  const at = movie({ sounds: [{ entry: soundEntry({ esds: padded(MAX_CONFIG_BYTES) }) }] });
  assertM4a((await take(at)).result, at.sounds[0].frames, { esds: padded(MAX_CONFIG_BYTES) });
  const over = movie({ sounds: [{ entry: soundEntry({ esds: padded(MAX_CONFIG_BYTES + 1) }) }] });
  assertRefused((await take(over)).result, FORMAT, false);
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

test("frames that play longer than the limit are refused, whatever the index says of their length", async () => {
  // Durations of nothing: by the index's account the sound is no time at
  // all. A frame is at least 960 samples, so 30,000 at 48 kHz are 600 s.
  const lying = (count) => movie({ sounds: [{ tables: { stts: u32(0, 1, count, 0) } }] });
  const over = lying(30001);
  const { result, file } = await take(over);
  assertRefused(result, /longer than 10 minutes/, true);
  assert.deepEqual(soundReads(file, over), []);
  // Exactly the limit passes this check, and fails a later one as above.
  assertRefused((await take(lying(30000))).result, UNREADABLE, false);
});

test("an M4A over the byte cap is refused by the index, before any sound is read", async () => {
  const made = movie();
  const total = concat(made.sounds[0].frames).length;
  // The cap is on what the decoder is handed: the sound and the header
  // built around it.
  const whole = (await take(made)).result.bytes.length;
  assert.ok(whole > total);
  const over = await take(made, { limits: { maxBytes: whole - 1, maxSeconds: 600 } });
  assertRefused(over.result, /sound is larger than/, true);
  assert.deepEqual(soundReads(over.file, made), []);
  assertM4a((await take(made, { limits: { maxBytes: whole, maxSeconds: 600 } })).result, made.sounds[0].frames);

  // With the page's own cap: six frames that claim 12 MiB each, three to a
  // chunk, in a file large enough that both chunks lie inside it.
  const sizes = [...Array(6).fill(12 * MIB), 1];
  const huge = movie({ picture: GIB, sounds: [{ tables: { stsz: u32(0, 0, 7, ...sizes) } }] });
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
  // The sound track's media box is gone with it. No sound track is left,
  // but one track could not be looked at, so the file is not called
  // soundless: the whole of it is still worth a try.
  assertRefused((await take(made)).result, UNREADABLE, false);
});

test("a sound track the index cannot show is not taken for a movie without sound", async () => {
  const cases = {
    "its tables are missing": (bytes) => bytes.set(ascii("free"), lastBox(bytes, "stbl") + 4),
    "the box its tables are in is missing": (bytes) => bytes.set(ascii("free"), lastBox(bytes, "minf") + 4),
    "its clock is missing": (bytes) => bytes.set(ascii("free"), lastBox(bytes, "mdhd") + 4),
    // The header that says whether the track is enabled.
    "its header is missing": (bytes) => bytes.set(ascii("free"), lastBox(bytes, "tkhd") + 4),
    // The handler box of the track's media, not the data handler after it.
    "what it is, is missing": (bytes) => bytes.set(ascii("free"), lastBox(bytes, "hdlr", 2) + 4),
  };
  for (const [name, change] of Object.entries(cases)) {
    const { result } = await take(withIndex(movie(), change));
    assert.notEqual(result, null, name);
    assert.match(result.refusal, UNREADABLE, name);
    assert.equal(result.final, false, name);
  }
});

test("a track too short to say what it is does not borrow the bytes after it", async () => {
  // An audio file, which is left to the decoder. Its last track's handler
  // box ends before the kind, and the bytes after it spell a picture's.
  const short = box("trak", box("mdia", box("hdlr", u32(0), ascii("mhlr"))));
  const made = movie({
    brand: "M4A ", picture: 0, sounds: [{ entry: soundEntry() }], tail: concat([short, ascii("vide"), u32(0)]),
  });
  assert.equal((await take(made)).result, null);
});

test("an index that breaks off gives no sound: the box that says fragments may be at the break or past it", async () => {
  // A movie with fragments, and one damaged byte in the size of the box
  // that says so: it runs past the index, or is shorter than its own
  // header. The tables before it hold the beginning of the sound only.
  const fragmented = movie({ tail: MVEX });
  const grown = withIndex(fragmented, (bytes, view) => {
    const at = lastBox(bytes, "mvex");
    view.setUint32(at, view.getUint32(at) + 256);
  });
  const shrunk = withIndex(fragmented, (bytes, view) => view.setUint32(lastBox(bytes, "mvex"), 4));
  // The break is at a box before it, which hides it.
  const hidden = withIndex(movie({ tail: concat([box("free", new Uint8Array(8)), MVEX]) }), (bytes, view) => {
    view.setUint32(lastBox(bytes, "free"), 4);
  });
  // No such box anywhere: after a break that is not known either.
  const plain = movie({ tail: concat([u32(4), ascii("free"), u32(0)]) });
  for (const made of [grown, shrunk, hidden, plain]) {
    const { result, file } = await take(made);
    assertRefused(result, UNREADABLE, false);
    assert.deepEqual(soundReads(file, made), []);
  }
});

test("a 64-bit size in the last bytes of the index is not read past them", async () => {
  // A size of 1 promises eight more bytes of size, and the index ends.
  // The walk stops there, and an index that breaks off gives no sound.
  const made = movie({ tail: concat([u32(1), ascii("free")]) });
  assertRefused((await take(made)).result, UNREADABLE, false);
});

test("a few bytes left over at the end of the index, too few for a box, are not read as one", async () => {
  const made = movie({ tail: new Uint8Array(3) });
  assertM4a((await take(made)).result, made.sounds[0].frames);
});

test("zeros at the end of the index are a box that runs to its end, not a break in it", async () => {
  // Sixteen of them: a size of zero. After a break, what follows is not
  // known, and a file's only sound track, switched off, would not be taken.
  const made = movie({ sounds: [{ enabled: false }], tail: new Uint8Array(16) });
  assertM4a((await take(made)).result, made.sounds[0].frames);
});

test("a stream descriptor that promises a URL, at the very end of the index, is not read past it", async () => {
  // Version and flags, then a descriptor of an ID and the URL flag alone.
  const esds = Uint8Array.from([0, 0, 0, 0, 0x03, 3, 0, 0, 0x40]);
  const made = movie({ tail: false, sounds: [{ entry: soundEntry({ esds }), entryLast: true }] });
  assertRefused((await take(made)).result, FORMAT, false);
});

test("a sample description too short to say its version, at the very end of the index, is a format refusal", async () => {
  // Sixteen bytes: size, type, six reserved, the data reference. No more.
  const stsd = concat([u32(0, 1), u32(16), ascii("mp4a"), u16(0, 0, 0, 1)]);
  const made = movie({ tail: false, sounds: [{ entryLast: true, tables: { stsd } }] });
  assertRefused((await take(made)).result, FORMAT, false);
});

test("a 64-bit size inside the index is followed only when it is a real one", async () => {
  // The index's first box, 108 bytes, given a 64-bit size in its 16 bytes.
  const sized = (high, low) => withIndex(movie(), (bytes) => {
    bytes.set(concat([u32(1), ascii("free"), u32(high, low)]), 8);
  });
  const real = sized(0, 108);
  assertM4a((await take(real)).result, real.sounds[0].frames);
  // A high word, or a size under the header's own: the walk ends there,
  // before any track, and what it never saw is not called soundless.
  assertRefused((await take(sized(1, 108))).result, UNREADABLE, false);
  assertRefused((await take(sized(0, 0))).result, UNREADABLE, false);
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
  // Past them the sound was never looked at, which is not "no sound".
  assertRefused((await take(movie({ extraTracks: 31 }))).result, UNREADABLE, false);
});

test("more frames than MAX_AUDIO_FRAMES are refused, however short they are said to play", async () => {
  assert.equal(MAX_AUDIO_FRAMES, 262144);
  // The length limit is out of the way: at 48 kHz it would refuse these
  // frames first. A stream that claims a rate in the megahertz gets here.
  const limits = { maxBytes: 64 * MIB, maxSeconds: 6000 };
  const tables = (count) => ({ stts: u32(0, 1, count, 1), stsz: u32(0, 1, count), stsc: u32(0, 1, 1, count, 1) });
  const over = movie({ sounds: [{ frames: someFrames(1, { length: MAX_AUDIO_FRAMES + 1 }), perChunk: 1,
    tables: tables(MAX_AUDIO_FRAMES + 1) }] });
  const { result, file } = await take(over, { limits });
  assertRefused(result, UNREADABLE, false);
  assert.deepEqual(soundReads(file, over), []);
  const at = movie({ sounds: [{ frames: someFrames(1, { length: MAX_AUDIO_FRAMES }), perChunk: 1,
    tables: tables(MAX_AUDIO_FRAMES) }] });
  const taken = (await take(at, { limits })).result;
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
  const [first, second, third] = laid.sounds[0].ranges.map(([at]) => at);
  const sizes = laid.sounds[0].frames.map((frame) => frame.length);
  const cases = {
    "stts claims more runs than it holds": { stts: u32(0, 1000, 7, 1024) },
    "stts has a run of no frames": { stts: u32(0, 2, 7, 1024, 0, 1024) },
    "stsz counts another number of frames than stts": { stsz: u32(0, 0, 8, ...sizes, 5) },
    "stsz is cut short": { stsz: u32(0, 0, 7, ...sizes.slice(0, 6)) },
    // A run's worth of bytes follows the zero, for a reader that never asked.
    "stsc counts no runs": { stsc: u32(0, 0, 1, 3, 1) },
    "stsc claims more runs than it holds": { stsc: u32(0, 5, 1, 3, 1) },
    "stsc names a second sample description": { stsc: u32(0, 1, 1, 3, 2) },
    // An empty chunk first, then the track's three as they are.
    "a chunk that holds no frame": { stsc: u32(0, 3, 1, 0, 1, 2, 3, 1, 4, 1, 1), stco: u32(0, 4, first, first, second, third) },
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
      assert.ok(result.bytes.length <= limits.maxBytes, `round ${round}`);
    } else {
      outcomes.refused += 1;
      assert.equal(typeof result.refusal, "string");
      assert.equal(typeof result.final, "boolean");
    }
  }
  // The changes really reach the parser: both outcomes happen.
  assert.ok(outcomes.sound > 0 && outcomes.refused > 0, JSON.stringify(outcomes));
});
