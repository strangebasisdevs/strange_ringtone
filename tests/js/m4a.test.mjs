// The phone-encode spike's M4A writer (tools/spike/phone_encode/m4a.js). A
// wrong box here would read on the phone as "iOS refuses phone-encoded
// tones", so the layout is pinned before anyone tests with it.
import { test } from "node:test";
import assert from "node:assert/strict";

import { AAC_FRAME_SAMPLES, audioSpecificConfig, splitAdts, writeM4a } from "../../tools/spike/phone_encode/m4a.js";

const CONTAINERS = new Set(["moov", "trak", "edts", "mdia", "minf", "dinf", "stbl"]);

/** Every box in the file as {path, start, body}, walking into the plain containers. */
function walk(bytes, start = 0, end = bytes.length, prefix = "") {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found = [];
  let offset = start;
  while (offset < end) {
    const size = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    assert.ok(size >= 8 && offset + size <= end, `box ${prefix}${type} overruns its parent`);
    const path = prefix + type;
    found.push({ path, start: offset, body: bytes.subarray(offset + 8, offset + size) });
    if (CONTAINERS.has(type)) found.push(...walk(bytes, offset + 8, offset + size, `${path}/`));
    offset += size;
  }
  assert.equal(offset, end);
  return found;
}

function boxAt(boxes, path) {
  const matches = boxes.filter((b) => b.path === path);
  assert.equal(matches.length, 1, `exactly one ${path}`);
  return matches[0];
}

function words(body, from = 0) {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const out = [];
  for (let offset = from; offset + 4 <= body.length; offset += 4) out.push(view.getUint32(offset));
  return out;
}

/** n distinct frames whose sizes differ, so offsets and sizes can't be right by accident. */
function fakeFrames(n) {
  return Array.from({ length: n }, (_, i) => Uint8Array.from({ length: 5 + (i % 7) }, (_, j) => (i * 31 + j) & 0xff));
}

const STBL = "moov/trak/mdia/minf/stbl";

test("the AudioSpecificConfig is AAC-LC with the rate index and channel count", () => {
  assert.deepEqual([...audioSpecificConfig(44100, 2)], [0x12, 0x10]);
  assert.deepEqual([...audioSpecificConfig(48000, 2)], [0x11, 0x90]);
  assert.deepEqual([...audioSpecificConfig(44100, 1)], [0x12, 0x08]);
  assert.throws(() => audioSpecificConfig(44000, 2), RangeError);
  assert.throws(() => audioSpecificConfig(44100, 3), RangeError);
});

test("the file is ftyp M4A, moov, mdat, and mdat holds the frames in order", () => {
  const frames = fakeFrames(100);
  const file = writeM4a({ sampleRate: 44100, channels: 2, frames });
  const boxes = walk(file);
  assert.deepEqual(boxes.filter((b) => !b.path.includes("/")).map((b) => b.path), ["ftyp", "moov", "mdat"]);
  assert.equal(Buffer.from(boxAt(boxes, "ftyp").body).toString("latin1"), "M4A \x00\x00\x02\x00M4A isomiso2");
  assert.deepEqual(Buffer.from(boxAt(boxes, "mdat").body), Buffer.concat(frames));
});

test("the sample tables point at every frame", () => {
  const frames = fakeFrames(100); // 43 + 43 + 14
  const file = writeM4a({ sampleRate: 44100, channels: 2, frames });
  const boxes = walk(file);

  assert.deepEqual(words(boxAt(boxes, `${STBL}/stts`).body), [0, 1, 100, AAC_FRAME_SAMPLES]);
  assert.deepEqual(words(boxAt(boxes, `${STBL}/stsz`).body), [0, 0, 100, ...frames.map((f) => f.length)]);
  assert.deepEqual(words(boxAt(boxes, `${STBL}/stsc`).body), [0, 2, 1, 43, 1, 3, 14, 1]);

  const [, chunkCount, ...offsets] = words(boxAt(boxes, `${STBL}/stco`).body);
  assert.equal(chunkCount, 3);
  assert.equal(offsets[0], boxAt(boxes, "mdat").start + 8);
  [0, 43, 86].forEach((first, chunk) => {
    const frame = frames[first];
    assert.deepEqual([...file.subarray(offsets[chunk], offsets[chunk] + frame.length)], [...frame]);
  });
});

test("whole chunks need one stsc run, and so does a single short chunk", () => {
  const whole = walk(writeM4a({ sampleRate: 44100, channels: 2, frames: fakeFrames(86) }));
  assert.deepEqual(words(boxAt(whole, `${STBL}/stsc`).body), [0, 1, 1, 43, 1]);
  const short = walk(writeM4a({ sampleRate: 44100, channels: 2, frames: fakeFrames(3) }));
  assert.deepEqual(words(boxAt(short, `${STBL}/stsc`).body), [0, 1, 1, 3, 1]);
  assert.deepEqual(words(boxAt(short, `${STBL}/stco`).body).slice(0, 2), [0, 1]);
});

test("the sample entry carries the channels, the rate and the AudioSpecificConfig", () => {
  const file = writeM4a({ sampleRate: 48000, channels: 1, frames: fakeFrames(10) });
  const stsd = boxAt(walk(file), `${STBL}/stsd`).body;
  const view = new DataView(stsd.buffer, stsd.byteOffset, stsd.byteLength);
  // Version and flags, entry count, then the mp4a box.
  assert.equal(view.getUint32(4), 1);
  assert.equal(view.getUint32(8), stsd.length - 8);
  assert.equal(Buffer.from(stsd.subarray(12, 16)).toString("latin1"), "mp4a");
  const entry = 16;
  assert.equal(view.getUint16(entry + 6), 1); // data reference index
  assert.equal(view.getUint16(entry + 16), 1); // channels
  assert.equal(view.getUint16(entry + 18), 16); // bits per sample
  assert.equal(view.getUint32(entry + 24), 48000 * 65536);
  assert.equal(Buffer.from(stsd.subarray(entry + 32, entry + 36)).toString("latin1"), "esds");
  // The esds payload ends: DecoderSpecificInfo (05, 2 bytes), then SLConfig (06 01 02).
  assert.deepEqual([...stsd.subarray(stsd.length - 7)], [0x05, 0x02, 0x11, 0x88, 0x06, 0x01, 0x02]);
  // ES_Descriptor and DecoderConfigDescriptor lengths cover exactly what follows them.
  const es = entry + 40;
  assert.deepEqual([stsd[es], stsd[es + 1]], [0x03, stsd.length - es - 2]);
  assert.deepEqual([stsd[es + 5], stsd[es + 6], stsd[es + 7], stsd[es + 8]], [0x04, 17, 0x40, 0x15]);
});

test("without priming there is no edit list and the duration is every frame", () => {
  const boxes = walk(writeM4a({ sampleRate: 44100, channels: 2, frames: fakeFrames(50) }));
  assert.equal(boxes.some((b) => b.path.endsWith("elst")), false);
  const media = 50 * AAC_FRAME_SAMPLES;
  assert.deepEqual(words(boxAt(boxes, "moov/mvhd").body).slice(3, 5), [44100, media]);
  assert.equal(words(boxAt(boxes, "moov/trak/tkhd").body)[5], media);
  assert.deepEqual(words(boxAt(boxes, "moov/trak/mdia/mdhd").body).slice(3, 5), [44100, media]);
});

test("with priming the edit list presents exactly the audio's samples", () => {
  const frames = fakeFrames(50);
  const samples = 44100; // one second, of 51200 encoded
  const boxes = walk(writeM4a({ sampleRate: 44100, channels: 2, frames, priming: 2112, samples }));
  const elst = boxAt(boxes, "moov/trak/edts/elst").body;
  // Version and flags, one entry: duration, media time, rate 1.0.
  assert.deepEqual(words(elst), [0, 1, samples, 2112, 0x00010000]);
  assert.deepEqual(words(boxAt(boxes, "moov/mvhd").body).slice(3, 5), [44100, samples]);
  assert.equal(words(boxAt(boxes, "moov/trak/tkhd").body)[5], samples);
  // The media itself is still every frame.
  assert.equal(words(boxAt(boxes, "moov/trak/mdia/mdhd").body)[4], 50 * AAC_FRAME_SAMPLES);
  // edts sits between tkhd and mdia.
  const inTrak = boxes.filter((b) => /^moov\/trak\/[a-z]+$/.test(b.path)).map((b) => b.path.slice(10));
  assert.deepEqual(inTrak, ["tkhd", "edts", "mdia"]);
});

test("priming alone presents the rest of the media", () => {
  const boxes = walk(writeM4a({ sampleRate: 44100, channels: 2, frames: fakeFrames(4), priming: 1024 }));
  assert.deepEqual(words(boxAt(boxes, "moov/trak/edts/elst").body), [0, 1, 3 * 1024, 1024, 0x00010000]);
});

test("input that can't make a valid file is refused", () => {
  const frames = fakeFrames(4);
  const base = { sampleRate: 44100, channels: 2, frames };
  assert.throws(() => writeM4a({ ...base, frames: [] }), RangeError);
  assert.throws(() => writeM4a({ ...base, frames: [new Uint8Array(0)] }), TypeError);
  assert.throws(() => writeM4a({ ...base, frames: [[1, 2, 3]] }), TypeError);
  assert.throws(() => writeM4a({ ...base, sampleRate: 96000 }), RangeError);
  assert.throws(() => writeM4a({ ...base, channels: 6 }), RangeError);
  assert.throws(() => writeM4a({ ...base, priming: 4 * 1024 }), RangeError);
  assert.throws(() => writeM4a({ ...base, priming: 1.5 }), RangeError);
  assert.throws(() => writeM4a({ ...base, priming: 1024, samples: 3 * 1024 + 1 }), RangeError);
  assert.throws(() => writeM4a({ ...base, samples: 0 }), RangeError);
});

/** One ADTS frame around a payload: AAC-LC, 44100 Hz (index 4), stereo, no CRC. */
function adtsFrame(payload) {
  const length = 7 + payload.length;
  return Uint8Array.from([
    0xff, 0xf1,
    (1 << 6) | (4 << 2) | 0, // profile LC, rate index 4, channel config high bit 0
    (2 << 6) | (length >> 11),
    (length >> 3) & 0xff,
    ((length & 7) << 5) | 0x1f,
    0xfc,
    ...payload,
  ]);
}

test("splitAdts returns the raw frames and the stream's format", () => {
  const payloads = [[1, 2, 3], [4, 5, 6, 7, 8], [9]];
  const stream = Uint8Array.from(payloads.flatMap((p) => [...adtsFrame(p)]));
  const { frames, sampleRate, channels } = splitAdts(stream);
  assert.deepEqual(frames.map((f) => [...f]), payloads);
  assert.equal(sampleRate, 44100);
  assert.equal(channels, 2);
});

test("splitAdts refuses what is not a whole ADTS stream", () => {
  const frame = adtsFrame([1, 2, 3]);
  assert.throws(() => splitAdts(new Uint8Array(0)), /no ADTS frames/);
  assert.throws(() => splitAdts(frame.subarray(0, 5)), /truncated/);
  assert.throws(() => splitAdts(frame.subarray(0, 9)), /frame length/);
  assert.throws(() => splitAdts(Uint8Array.from([0x21, ...frame.subarray(1)])), /syncword/);
  // A raw AAC frame is not mistaken for ADTS.
  assert.throws(() => splitAdts(Uint8Array.from([0x21, 0x1b, 0x80, 0, 0, 0, 0, 0])), /syncword/);
});
