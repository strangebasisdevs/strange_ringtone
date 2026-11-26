// The M4A writer of a tone made on the device (core/static/audio/m4a.js). A
// wrong box here would read on the phone as "iOS refuses phone-encoded
// tones", so the layout is pinned before anyone tests with it.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AAC_FRAME_SAMPLES, APPLE_PRIMING, audioSpecificConfig, primingSamples, rawFrames, splitAdts, writeM4a,
} from "../../core/static/audio/m4a.js";

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

/** One ADTS frame as adtsFrame makes it, but mono (channel configuration 1). */
function monoAdtsFrame(payload) {
  const frame = adtsFrame(payload);
  frame[3] = (1 << 6) | (frame[3] & 0x3f);
  return frame;
}

test("rawFrames returns raw frames as they are", () => {
  const chunks = [Uint8Array.of(0x21, 0x1b, 0x80), Uint8Array.of(0x21, 0x00), Uint8Array.of(0x20)];
  assert.equal(rawFrames(chunks, 44100, 2), chunks);
  // A lone 0xff byte is too short to be the start of an ADTS frame.
  const short = [Uint8Array.of(0xff), Uint8Array.of(0x21, 0xff, 0xf1)];
  assert.equal(rawFrames(short, 44100, 2), short);
  // 0xff followed by a byte whose layer bits are not 00 is not the syncword.
  const near = [Uint8Array.of(0xff, 0xf3, 0x50), Uint8Array.of(0xff, 0xe1, 0x50), Uint8Array.of(0xfe, 0xf1, 0x50)];
  assert.equal(rawFrames(near, 44100, 2), near);
});

test("rawFrames takes the header off when every chunk is one ADTS frame", () => {
  const payloads = [[0x21, 2, 3], [4, 5, 6, 7, 8], [9]];
  const frames = rawFrames(payloads.map((p) => adtsFrame(p)), 44100, 2);
  assert.deepEqual(frames.map((f) => [...f]), payloads);
  assert.deepEqual(rawFrames([monoAdtsFrame([7, 7])], 44100, 1).map((f) => [...f]), [[7, 7]]);
});

test("rawFrames refuses output that is ADTS in part", () => {
  // Written as it is, such output would go into the file with headers on.
  const adts = [adtsFrame([1, 2, 3]), adtsFrame([4, 5]), adtsFrame([6])];
  const raw = Uint8Array.of(0x21, 0x1b, 0x80, 0x00);
  for (let at = 0; at < 3; at += 1) {
    const chunks = adts.map((frame, i) => (i === at ? raw : frame));
    assert.throws(() => rawFrames(chunks, 44100, 2), /part ADTS and part not/, `raw chunk at ${at}`);
  }
  // One ADTS chunk among raw ones is the same finding from the other side.
  assert.throws(() => rawFrames([raw, raw, adtsFrame([1])], 44100, 2), /part ADTS and part not/);
});

test("rawFrames refuses a chunk that starts like ADTS and is not one whole frame", () => {
  // Two frames in one chunk.
  const double = [Uint8Array.from([...adtsFrame([1]), ...adtsFrame([2])])];
  assert.throws(() => rawFrames(double, 44100, 2), /more than one ADTS frame/);
  // A byte too many after the frame.
  const padded = [adtsFrame([3]), Uint8Array.from([...adtsFrame([1, 2]), 0])];
  assert.throws(() => rawFrames(padded, 44100, 2), /truncated ADTS header/);
  // A length field that runs past the chunk.
  const cut = [adtsFrame([1, 2, 3]).subarray(0, 9)];
  assert.throws(() => rawFrames(cut, 44100, 2), /bad ADTS frame length/);
  // The syncword and nothing else.
  assert.throws(() => rawFrames([Uint8Array.of(0xff, 0xf1)], 44100, 2), /truncated ADTS header/);
});

test("rawFrames refuses ADTS in another format than was asked for", () => {
  const stereo = [adtsFrame([1, 2, 3]), adtsFrame([4])];
  assert.throws(() => rawFrames(stereo, 48000, 2), /not in the format/);
  assert.throws(() => rawFrames(stereo, 44100, 1), /not in the format/);
  // Every chunk is held to it: a stream that turns mono half way is refused.
  assert.throws(() => rawFrames([adtsFrame([1]), monoAdtsFrame([2])], 44100, 2), /not in the format/);
  assert.throws(() => rawFrames([monoAdtsFrame([2]), adtsFrame([1])], 44100, 2), /not in the format/);
});

test("rawFrames refuses what is not a list of non-empty frames", () => {
  assert.throws(() => rawFrames([], 44100, 2), RangeError);
  assert.throws(() => rawFrames(Uint8Array.of(1), 44100, 2), RangeError);
  assert.throws(() => rawFrames([Uint8Array.of(1), new Uint8Array(0)], 44100, 2), TypeError);
  assert.throws(() => rawFrames([adtsFrame([1]), [1, 2, 3]], 44100, 2), TypeError);
  assert.throws(() => rawFrames([new ArrayBuffer(4)], 44100, 2), TypeError);
});

/** How many frames an encoder with a delay emits for some samples: no fewer, and no whole frame more. */
function framesFor(samples, delay) {
  return Math.ceil((samples + delay) / AAC_FRAME_SAMPLES);
}

test("priming rule 1: a negative first timestamp is the priming", () => {
  const samples = 44100;
  // 2112 samples at 44.1 kHz are 47,891.2 microseconds.
  assert.equal(primingSamples({ firstTimestamp: -47891, sampleRate: 44100, frames: framesFor(samples, 2112), samples }), 2112);
  // One frame of 1024 samples is 23,220 microseconds.
  assert.equal(primingSamples({ firstTimestamp: -23220, sampleRate: 44100, frames: framesFor(samples, 1024), samples }), 1024);
  // The timestamp wins over what the surplus would suggest: 46 frames have
  // 3004 samples to spare, which rule 2 would read as Apple's 2112.
  assert.equal(framesFor(samples, 2048), 46);
  assert.equal(primingSamples({ firstTimestamp: -46440, sampleRate: 44100, frames: 46, samples }), 2048);
  // And over rule 3: 1536 is no whole number of frames.
  assert.equal(primingSamples({ firstTimestamp: -34830, sampleRate: 44100, frames: framesFor(samples, 1536), samples }), 1536);
  assert.equal(primingSamples({ firstTimestamp: -1000000, sampleRate: 48000, frames: framesFor(48000, 48000), samples: 48000 }), 48000);
});

test("priming rule 2: a first timestamp that is not negative and Apple's surplus mean Apple's 2112", () => {
  assert.equal(APPLE_PRIMING, 2112);
  // What the iPhone did in the spike: 12 s in, 519 frames out, 2256 samples
  // more; and 30 s in, 1295 frames out.
  assert.equal(primingSamples({ firstTimestamp: 0, sampleRate: 44100, frames: 519, samples: 529200 }), 2112);
  assert.equal(primingSamples({ firstTimestamp: 0, sampleRate: 44100, frames: 1295, samples: 1323000 }), 2112);
  // Exactly 2112 to spare is enough; one less is not Apple's encoder.
  const frames = 100;
  assert.equal(primingSamples({ firstTimestamp: 0, sampleRate: 44100, frames, samples: frames * 1024 - 2112 }), 2112);
  assert.equal(primingSamples({ firstTimestamp: 0, sampleRate: 44100, frames, samples: frames * 1024 - 2111 }), 2048);
  // A later first timestamp says nothing about a delay either.
  assert.equal(primingSamples({ firstTimestamp: 23220, sampleRate: 44100, frames: 519, samples: 529200 }), 2112);
});

test("priming rule 3: otherwise the whole frames of surplus", () => {
  const at = (surplus) => primingSamples({ firstTimestamp: 0, sampleRate: 44100, frames: 50, samples: 50 * 1024 - surplus });
  assert.equal(at(0), 0, "nothing to spare, nothing to skip");
  assert.equal(at(1), 0);
  assert.equal(at(1023), 0, "only the last frame's padding");
  assert.equal(at(1024), 1024);
  assert.equal(at(2047), 1024);
  assert.equal(at(2048), 2048);
  assert.equal(at(2111), 2048);
  // What the encoder on Windows did in the spike: 517 frames for 12 s, 1292 for 30 s.
  assert.equal(primingSamples({ firstTimestamp: 0, sampleRate: 44100, frames: 517, samples: 529200 }), 0);
  assert.equal(primingSamples({ firstTimestamp: 0, sampleRate: 44100, frames: 1292, samples: 1323000 }), 0);
});

test("the frames are exactly as many as the audio and its delay fill", () => {
  const samples = 44100;
  // Apple's count is taken, and one frame more is not.
  const apple = framesFor(samples, 2112);
  assert.equal(primingSamples({ firstTimestamp: 0, sampleRate: 44100, frames: apple, samples }), 2112);
  assert.throws(() => primingSamples({ firstTimestamp: 0, sampleRate: 44100, frames: apple + 1, samples }), /more frames/);
  assert.throws(() => primingSamples({ firstTimestamp: 0, sampleRate: 44100, frames: apple + 40, samples }), /more frames/);
  // The edge itself: 2112 + 1023 samples to spare is Apple's delay and a
  // padded last frame; 2112 + 1024 is a frame that belongs to nothing.
  const frames = 100;
  assert.equal(primingSamples({ firstTimestamp: 0, sampleRate: 44100, frames, samples: frames * 1024 - 3135 }), 2112);
  assert.throws(() => primingSamples({ firstTimestamp: 0, sampleRate: 44100, frames, samples: frames * 1024 - 3136 }), /more frames/);
  // A stated delay is held to the same count.
  const stated = framesFor(samples, 1024);
  assert.equal(primingSamples({ firstTimestamp: -23220, sampleRate: 44100, frames: stated, samples }), 1024);
  assert.throws(() => primingSamples({ firstTimestamp: -23220, sampleRate: 44100, frames: stated + 1, samples }), /more frames/);
  // A timestamp a hair under zero states a delay of nothing. With Apple's
  // count that is two frames too many, not a delay of 0.
  assert.throws(() => primingSamples({ firstTimestamp: -1, sampleRate: 44100, frames: apple, samples }), /more frames/);
});

test("a lost last frame cannot be told from a shorter delay (a known limit, docs/PLAN.md 15.4)", () => {
  // Rules 2 and 3 read the delay off the count. An Apple-like encoder that
  // dropped its last frame has the count of an encoder with a delay of one
  // frame, and is taken for one. This test states the limit; it is not a
  // wish. A frame lost anywhere else shows in the timestamps (encode.js).
  const samples = 44100;
  const apple = framesFor(samples, 2112);
  assert.equal(primingSamples({ firstTimestamp: 0, sampleRate: 44100, frames: apple - 1, samples }), 1024);
});

test("the priming and the samples always fit in the frames", () => {
  // What comes back goes straight into writeM4a's edit list.
  let accepted = 0;
  for (const firstTimestamp of [0, -23220, -47891]) {
    for (let frames = 1; frames < 40; frames += 1) {
      for (const spare of [0, 1, 500, 1023, 1024, 2111, 2112, 3000, 3135, 3136, 5000]) {
        const samples = frames * AAC_FRAME_SAMPLES - spare;
        if (samples < 1) continue;
        let priming;
        try {
          priming = primingSamples({ firstTimestamp, sampleRate: 44100, frames, samples });
        } catch (error) {
          assert.ok(error instanceof RangeError);
          continue;
        }
        accepted += 1;
        assert.ok(Number.isInteger(priming) && priming >= 0);
        const left = frames * AAC_FRAME_SAMPLES - (priming + samples);
        assert.ok(left >= 0 && left < AAC_FRAME_SAMPLES, `${priming} + ${samples} in ${frames} frames`);
        const file = writeM4a({ sampleRate: 44100, channels: 2, frames: fakeFrames(frames), priming, samples });
        assert.ok(file.length > 0);
      }
    }
  }
  assert.ok(accepted > 300, `only ${accepted} cases were accepted`);
});

test("an encoder that returned less audio than it was given is refused", () => {
  // Fewer samples in the frames than went in.
  assert.throws(() => primingSamples({ firstTimestamp: 0, sampleRate: 44100, frames: 10, samples: 10241 }), /less audio/);
  // A timestamp that claims more delay than the frames have room for.
  assert.throws(() => primingSamples({ firstTimestamp: -47891, sampleRate: 44100, frames: 44, samples: 44100 }), /less audio/);
  assert.throws(() => primingSamples({ firstTimestamp: -1e12, sampleRate: 44100, frames: 44, samples: 44000 }), /less audio/);
});

test("primingSamples refuses numbers that are not what they should be", () => {
  const good = { firstTimestamp: 0, sampleRate: 44100, frames: 44, samples: 44100 };
  assert.equal(primingSamples(good), 0);
  for (const firstTimestamp of [NaN, Infinity, -Infinity, undefined, "0"]) {
    assert.throws(() => primingSamples({ ...good, firstTimestamp }), RangeError, `timestamp ${firstTimestamp}`);
  }
  for (const sampleRate of [0, -1, NaN, Infinity, undefined]) {
    assert.throws(() => primingSamples({ ...good, sampleRate }), RangeError, `rate ${sampleRate}`);
  }
  for (const frames of [0, -1, 1.5, NaN, undefined]) {
    assert.throws(() => primingSamples({ ...good, frames }), RangeError, `frames ${frames}`);
  }
  for (const samples of [0, -1, 1.5, NaN, undefined]) {
    assert.throws(() => primingSamples({ ...good, samples }), RangeError, `samples ${samples}`);
  }
});

// The older parts of the writer, field by field: found by a mutation pass
// to have checks that no test held (2026-11-26).
/** An ADTS frame with every field a caller can vary. */
function adtsWith({ profile = 1, rate = 4, channels = 2, crc = false, payload = [1, 2, 3], byte1 = null, tail = 0xfc, lengthField = null, copyrightStart = false } = {}) {
  const header = crc ? 9 : 7;
  const length = lengthField ?? header + payload.length;
  const out = [
    0xff, byte1 ?? (0xf0 | (crc ? 0 : 1)),
    (profile << 6) | (rate << 2) | (channels >> 2),
    ((channels & 3) << 6) | (copyrightStart ? 0x04 : 0) | (length >> 11),
    (length >> 3) & 0xff,
    ((length & 7) << 5) | 0x1f,
    tail,
  ];
  if (crc) out.push(0xaa, 0xbb);
  return Uint8Array.from([...out, ...payload]);
}

const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

test("audioSpecificConfig knows every rate of the table and refuses 0 channels", () => {
  RATES.forEach((hz, index) => {
    assert.deepEqual([...audioSpecificConfig(hz, 2)], [0x10 | (index >> 1), ((index & 1) << 7) | 0x10], `${hz}`);
  });
  for (const channels of [0, 3, 6, 1.5, undefined]) {
    assert.throws(() => audioSpecificConfig(44100, channels), RangeError, `${channels}`);
  }
});

test("splitAdts: the truncation bound is the 7-byte header", () => {
  const frame = adtsWith();
  assert.throws(() => splitAdts(frame.subarray(0, 6)), /truncated/);
  assert.throws(() => splitAdts(frame.subarray(0, 7)), /frame length/);
});

test("splitAdts: a header with a CRC is 9 bytes", () => {
  const { frames } = splitAdts(Uint8Array.from([...adtsWith({ crc: true, payload: [7, 8, 9] }), ...adtsWith({ payload: [4] })]));
  assert.deepEqual(frames.map((f) => [...f]), [[7, 8, 9], [4]]);
});

test("splitAdts: every rate index and channel configuration, and the reserved indexes", () => {
  RATES.forEach((hz, index) => assert.equal(splitAdts(adtsWith({ rate: index })).sampleRate, hz));
  for (const rate of [13, 14, 15]) assert.throws(() => splitAdts(adtsWith({ rate })), /reserved/);
  for (let channels = 0; channels < 8; channels += 1) assert.equal(splitAdts(adtsWith({ channels })).channels, channels);
});

test("splitAdts: the length field is 13 bits and nothing around it", () => {
  for (const size of [300, 2100, 6200]) {
    const payload = Array.from({ length: size }, (_, i) => i & 0xff);
    const { frames } = splitAdts(adtsWith({ payload }));
    assert.deepEqual([...frames[0]], payload, `${size}`);
  }
  // The bit beside the length (copyright_identification_start) is not length.
  assert.deepEqual([...splitAdts(adtsWith({ copyrightStart: true })).frames[0]], [1, 2, 3]);
});

test("splitAdts: the syncword, the layer bits and the profile are held to", () => {
  for (const byte1 of [0xf2, 0xf4, 0xe1, 0xf6, 0x71]) {
    assert.throws(() => splitAdts(adtsWith({ byte1 })), /syncword/, byte1.toString(16));
  }
  assert.throws(() => splitAdts(Uint8Array.from([0xfe, ...adtsWith().subarray(1)])), /syncword/);
  // MPEG-2 id bit set is fine.
  assert.deepEqual([...splitAdts(adtsWith({ byte1: 0xf9 })).frames[0]], [1, 2, 3]);
  for (const profile of [0, 2, 3]) assert.throws(() => splitAdts(adtsWith({ profile })), /not AAC-LC/);
});

test("splitAdts: more than one raw block per frame is refused, and so is an empty frame", () => {
  for (const tail of [0xfd, 0xfe, 0xff]) assert.throws(() => splitAdts(adtsWith({ tail })), /more than one/, tail.toString(16));
  assert.throws(() => splitAdts(adtsWith({ payload: [], lengthField: 7 })), /frame length/);
  assert.throws(() => splitAdts(adtsWith({ crc: true, payload: [], lengthField: 9 })), /frame length/);
});

test("splitAdts: a stream that changes rate or channels is refused", () => {
  assert.throws(() => splitAdts(Uint8Array.from([...adtsWith(), ...adtsWith({ rate: 3 })])), /changes format/);
  assert.throws(() => splitAdts(Uint8Array.from([...adtsWith(), ...adtsWith({ channels: 1 })])), /changes format/);
});

test("splitAdts: the frames are copies, not views of the input", () => {
  const stream = adtsWith({ payload: [1, 2, 3] });
  const { frames } = splitAdts(stream);
  stream.fill(0);
  assert.deepEqual([...frames[0]], [1, 2, 3]);
});

test("writeM4a: argument checks that the existing test leaves out", () => {
  const base = { sampleRate: 44100, channels: 2, frames: fakeFrames(4) };
  assert.throws(() => writeM4a({ ...base, frames: new Uint8Array(4) }), RangeError);
  assert.throws(() => writeM4a({ ...base, frames: [] }), /no frames/);
  assert.throws(() => writeM4a({ ...base, priming: -1 }), RangeError);
  assert.throws(() => writeM4a({ ...base, samples: 1.5 }), RangeError);
  assert.throws(() => writeM4a({ ...base, channels: 0 }), RangeError);
});

test("writeM4a: samples alone make an edit list, and 43 frames are one chunk", () => {
  const boxes = walk(writeM4a({ sampleRate: 44100, channels: 2, frames: fakeFrames(4), samples: 1000 }));
  assert.deepEqual(words(boxAt(boxes, "moov/trak/edts/elst").body), [0, 1, 1000, 0, 0x00010000]);
  const one = walk(writeM4a({ sampleRate: 44100, channels: 2, frames: fakeFrames(43) }));
  assert.deepEqual(words(boxAt(one, `${STBL}/stsc`).body), [0, 1, 1, 43, 1]);
  assert.deepEqual(words(boxAt(one, `${STBL}/stco`).body).slice(0, 2), [0, 1]);
});

test("writeM4a: the esds names the largest frame and the bitrates", () => {
  const frames = [new Uint8Array(300).fill(1), ...fakeFrames(9), new Uint8Array(3).fill(2)];
  // Trimmed: the bitrates describe the frames, not the presented part.
  const file = writeM4a({ sampleRate: 44100, channels: 1, frames, priming: 1024, samples: 5000 });
  const stsd = boxAt(walk(file), `${STBL}/stsd`).body;
  const view = new DataView(stsd.buffer, stsd.byteOffset, stsd.byteLength);
  const es = 16 + 40;
  assert.equal(view.getUint16(es + 2), 0, "ES_ID");
  assert.equal(stsd[es + 4], 0, "ES flags");
  assert.equal((stsd[es + 9] << 16) | (stsd[es + 10] << 8) | stsd[es + 11], 300, "buffer size");
  assert.equal(view.getUint32(es + 12), Math.round((300 * 8 * 44100) / 1024), "peak bitrate");
  const dataBytes = frames.reduce((n, f) => n + f.length, 0);
  assert.equal(view.getUint32(es + 16), Math.round((dataBytes * 8) / ((11 * 1024) / 44100)), "average bitrate");
});

test("writeM4a: the fixed boxes hold what ffmpeg writes", () => {
  const presented = 10 * 1024;
  const boxes = walk(writeM4a({ sampleRate: 44100, channels: 2, frames: fakeFrames(10) }));
  const UNITY = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];
  assert.deepEqual(words(boxAt(boxes, "moov/trak/tkhd").body), [3, 0, 0, 1, 0, presented, 0, 0, 0, 0x01000000, ...UNITY, 0, 0]);
  assert.deepEqual(words(boxAt(boxes, "moov/mvhd").body), [0, 0, 0, 44100, presented, 0x10000, 0x01000000, 0, 0, ...UNITY, 0, 0, 0, 0, 0, 0, 2]);
  assert.deepEqual(words(boxAt(boxes, "moov/trak/mdia/mdhd").body), [0, 0, 0, 44100, presented, 0x55c40000]);
  const hdlr = boxAt(boxes, "moov/trak/mdia/hdlr").body;
  assert.deepEqual(words(hdlr).slice(0, 6), [0, 0, 0x736f756e, 0, 0, 0]);
  assert.equal(Buffer.from(hdlr.subarray(24)).toString("latin1"), "SoundHandler\0");
  assert.deepEqual(words(boxAt(boxes, "moov/trak/mdia/minf/smhd").body), [0, 0]);
  assert.deepEqual(words(boxAt(boxes, "moov/trak/mdia/minf/dinf/dref").body), [0, 1, 12, 0x75726c20, 1]);
  const stsd = boxAt(boxes, `${STBL}/stsd`).body;
  const entry = 16;
  assert.ok(stsd.subarray(entry, entry + 6).every((b) => b === 0));
  assert.ok(stsd.subarray(entry + 8, entry + 16).every((b) => b === 0), "version, revision, vendor");
  assert.deepEqual([...stsd.subarray(entry + 20, entry + 24)], [0, 0, 0, 0], "compression ID, packet size");
  assert.deepEqual([...stsd.subarray(stsd.length - 7)], [0x05, 0x02, 0x12, 0x10, 0x06, 0x01, 0x02]);
});
