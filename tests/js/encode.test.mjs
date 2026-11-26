// Encoding on the device (core/static/audio/encode.js), against a fake
// AudioEncoder: what is asked of the encoder, what is done with its answer,
// and that an encoder that fails, stalls or returns the wrong thing fails
// the render instead of making a file.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BITRATES, EncodeError, encodeTone, ENCODE_TIMEOUT_MS, hasEncoder, MAX_SECONDS, SAMPLE_RATE, supportedBitrate,
  SUPPORT_TIMEOUT_MS,
} from "../../core/static/audio/encode.js";
import { sameSamples } from "./samples.mjs";

const RATE = 44100;
const FRAME = 1024;
// One AAC frame in microseconds, as an encoder stamps its chunks.
const FRAME_MICROSECONDS = Math.round((FRAME / RATE) * 1e6);

function ramp(length, seed) {
  // Every sample its own value, so a block out of order or twice shows.
  return Float32Array.from({ length }, (_, n) => ((n * 7 + seed * 13) % 2001) / 1000 - 1);
}

/** The payload the fake encoder gives frame i: sizes differ, and the first byte is never 0xff. */
function payload(i) {
  return Uint8Array.from({ length: 40 + (i % 9) }, (_, j) => (j === 0 ? 0x21 : (i * 31 + j) & 0xff));
}

/** One ADTS frame around a payload: AAC-LC, 44100 Hz, stereo, no CRC. */
function adts(bytes, channels = 2) {
  const length = 7 + bytes.length;
  return Uint8Array.from([
    0xff, 0xf1,
    (1 << 6) | (4 << 2) | 0,
    (channels << 6) | (length >> 11),
    (length >> 3) & 0xff,
    ((length & 7) << 5) | 0x1f,
    0xfc,
    ...bytes,
  ]);
}

/**
 * A stand-in for WebCodecs. By default it behaves like the iPhone in the
 * spike: every rate supported, timestamps from 0, a delay of 2112 samples,
 * one raw frame for every 1024 samples and a padded last one.
 */
function fakeCodecs(options = {}) {
  const {
    supported = (config) => ({ supported: true, config }),
    priming = 2112,
    firstTimestamp = 0,
    wrap = (bytes) => bytes,
    frameCount = null,
    chunkFor = null,
    errorAfterBlocks = null,
    encodeThrowsAt = null,
    flushRejects = false,
    stallFlush = false,
    stallQueue = false,
    stallSupport = false,
  } = options;
  const log = { asked: [], configured: [], blocks: [], audio: [], encoders: [], maxQueue: 0 };

  class AudioData {
    constructor(init) {
      this.init = init;
      this.closed = false;
      log.audio.push(this);
    }

    close() {
      this.closed = true;
    }
  }

  class AudioEncoder {
    static isConfigSupported(config) {
      log.asked.push({ ...config });
      if (stallSupport) return new Promise(() => {});
      const answer = supported(config);
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(answer);
    }

    constructor(init) {
      this.init = init;
      this.state = "unconfigured";
      this.encodeQueueSize = 0;
      this.received = 0;
      this.emitted = 0;
      this.blocks = 0;
      log.encoders.push(this);
    }

    configure(config) {
      assert.equal(this.state, "unconfigured");
      this.state = "configured";
      log.configured.push({ ...config });
    }

    encode(audio) {
      assert.equal(this.state, "configured", "encode on an encoder that is not configured");
      assert.equal(audio.closed, false, "the AudioData was closed before it was encoded");
      if (encodeThrowsAt === this.blocks) throw new TypeError("the fake encoder refuses this block");
      const { data, numberOfFrames, numberOfChannels } = audio.init;
      log.blocks.push({ ...audio.init, data: Float32Array.from(data) });
      assert.equal(data.length, numberOfFrames * numberOfChannels);
      this.blocks += 1;
      this.received += numberOfFrames;
      this.encodeQueueSize += 1;
      log.maxQueue = Math.max(log.maxQueue, this.encodeQueueSize);
      if (stallQueue) return;
      // The work happens later, as a real encoder's does.
      setTimeout(() => {
        if (this.state !== "configured") return;
        this.encodeQueueSize -= 1;
        if (errorAfterBlocks !== null && this.blocks >= errorAfterBlocks) {
          this.state = "closed";
          this.init.error(new Error("the fake encoder broke"));
          return;
        }
        this.emit(Math.floor((priming + this.received) / FRAME));
      }, 0);
    }

    emit(upTo) {
      while (this.emitted < upTo) {
        const i = this.emitted;
        const bytes = wrap(payload(i));
        const chunk = chunkFor !== null ? chunkFor(i, bytes) : {
          byteLength: bytes.length,
          timestamp: firstTimestamp + i * FRAME_MICROSECONDS,
          duration: FRAME_MICROSECONDS,
          type: "key",
          copyTo(target) {
            target.set(bytes);
          },
        };
        this.emitted += 1;
        this.init.output(chunk, {});
      }
    }

    flush() {
      if (stallFlush) return new Promise(() => {});
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          if (flushRejects) {
            this.state = "closed";
            reject(new Error("the fake flush failed"));
            return;
          }
          if (this.state !== "configured") {
            reject(new Error("AbortError"));
            return;
          }
          this.emit(frameCount !== null ? frameCount : Math.ceil((priming + this.received) / FRAME));
          resolve();
        }, 0);
      });
    }

    close() {
      this.state = "closed";
    }
  }

  return { scope: { AudioEncoder, AudioData }, log };
}

const CONTAINERS = new Set(["moov", "trak", "edts", "mdia", "minf", "dinf", "stbl"]);

/** Every box of an MP4 as {path, body}, walking into the plain containers. */
function boxes(bytes, start = 0, end = bytes.length, prefix = "") {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found = [];
  let offset = start;
  while (offset < end) {
    const size = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    assert.ok(size >= 8 && offset + size <= end, `box ${prefix}${type} overruns its parent`);
    found.push({ path: prefix + type, body: bytes.subarray(offset + 8, offset + size) });
    if (CONTAINERS.has(type)) found.push(...boxes(bytes, offset + 8, offset + size, `${prefix}${type}/`));
    offset += size;
  }
  return found;
}

/** What a finished file says about itself. */
function describe(bytes) {
  const all = boxes(bytes);
  const body = (path) => {
    const matches = all.filter((box) => box.path === path);
    assert.equal(matches.length, 1, `exactly one ${path}`);
    return matches[0].body;
  };
  const words = (data) => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return Array.from({ length: Math.floor(data.length / 4) }, (_, i) => view.getUint32(i * 4));
  };
  const stsz = words(body("moov/trak/mdia/minf/stbl/stsz"));
  const elst = words(body("moov/trak/edts/elst"));
  const stsd = body("moov/trak/mdia/minf/stbl/stsd");
  return {
    order: all.filter((box) => !box.path.includes("/")).map((box) => box.path),
    frameSizes: stsz.slice(3),
    frames: stsz[2],
    presented: elst[2],
    priming: elst[3],
    // stsd: version and flags, entry count, then the mp4a entry (size, type,
    // 6 reserved, data reference, 8 more, then the channel count).
    channels: new DataView(stsd.buffer, stsd.byteOffset, stsd.byteLength).getUint16(8 + 8 + 16),
    mdat: body("mdat"),
  };
}

function joined(parts) {
  return Uint8Array.from(parts.flatMap((part) => [...part]));
}

async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return assert.fail("the encode did not fail");
}

test("the rates are the server's first, and the deadlines are finite", () => {
  assert.equal(SAMPLE_RATE, 44100);
  assert.deepEqual([...BITRATES], [256000, 192000, 160000, 128000]);
  assert.ok(Object.isFrozen(BITRATES));
  assert.equal(ENCODE_TIMEOUT_MS, 30000);
  assert.equal(SUPPORT_TIMEOUT_MS, 5000);
});

test("hasEncoder needs both WebCodecs classes", () => {
  const { scope } = fakeCodecs();
  assert.equal(hasEncoder(scope), true);
  assert.equal(hasEncoder({}), false);
  assert.equal(hasEncoder({ AudioEncoder: scope.AudioEncoder }), false);
  assert.equal(hasEncoder({ AudioData: scope.AudioData }), false);
  assert.equal(hasEncoder({ AudioEncoder: {}, AudioData: scope.AudioData }), false);
  assert.equal(hasEncoder({ AudioEncoder: class {}, AudioData: scope.AudioData }), false, "no isConfigSupported");
});

test("the encoder is asked for AAC-LC at 44.1 kHz and a constant rate", async () => {
  const { scope, log } = fakeCodecs();
  assert.equal(await supportedBitrate(2, { scope }), 256000);
  assert.deepEqual(log.asked, [{
    codec: "mp4a.40.2", sampleRate: 44100, numberOfChannels: 2, bitrate: 256000, bitrateMode: "constant",
  }]);
  const mono = fakeCodecs();
  assert.equal(await supportedBitrate(1, { scope: mono.scope }), 256000);
  assert.equal(mono.log.asked[0].numberOfChannels, 1);
});

test("the rates are tried in order, down to the first the encoder takes", async () => {
  for (const [takes, expected, asked] of [
    [[256000, 192000, 160000, 128000], 256000, 1],
    [[192000, 160000, 128000], 192000, 2],
    [[128000, 160000], 160000, 3],
    [[128000], 128000, 4],
    [[], null, 4],
    [[64000], null, 4],
  ]) {
    const { scope, log } = fakeCodecs({ supported: (config) => ({ supported: takes.includes(config.bitrate), config }) });
    assert.equal(await supportedBitrate(2, { scope }), expected, `takes ${takes}`);
    assert.deepEqual(log.asked.map((config) => config.bitrate), BITRATES.slice(0, asked));
    assert.ok(log.asked.every((config) => config.bitrateMode === "constant"));
  }
});

test("only a plain yes counts as support", async () => {
  for (const answer of [{ supported: "true" }, { supported: 1 }, {}, null, undefined, "yes", true]) {
    const { scope } = fakeCodecs({ supported: () => answer });
    assert.equal(await supportedBitrate(2, { scope }), null, JSON.stringify(answer));
  }
});

test("a rate the encoder throws at is skipped, not fatal", async () => {
  const { scope, log } = fakeCodecs({
    supported: (config) => (config.bitrate > 160000 ? new TypeError("unsupported") : { supported: true }),
  });
  assert.equal(await supportedBitrate(2, { scope }), 160000);
  assert.equal(log.asked.length, 3);
});

test("no encoder, or one that never answers, is no support", async () => {
  assert.equal(await supportedBitrate(2, { scope: {} }), null);
  // An encoder with nothing to hand it samples in is no encoder either, and
  // is not asked what it supports.
  const half = fakeCodecs();
  assert.equal(await supportedBitrate(2, { scope: { AudioEncoder: half.scope.AudioEncoder } }), null);
  assert.equal(half.log.asked.length, 0);
  const { scope, log } = fakeCodecs({ stallSupport: true });
  const started = Date.now();
  assert.equal(await supportedBitrate(2, { scope, timeoutMs: 40 }), null);
  assert.ok(Date.now() - started < 2000, "bounded by the deadline");
  assert.equal(log.asked.length, 1, "it is not asked again after it went silent");
  await assert.rejects(supportedBitrate(3, { scope }), RangeError);
  await assert.rejects(supportedBitrate(0, { scope }), RangeError);
});

test("a tone encodes to a file that presents exactly the samples that went in", async () => {
  const samples = 3 * RATE + 17;
  const channels = [ramp(samples, 1), ramp(samples, 2)];
  const { scope, log } = fakeCodecs();
  const { bytes, bitrate } = await encodeTone(channels, { scope });
  assert.equal(bitrate, 256000);
  assert.ok(bytes instanceof Uint8Array);

  assert.deepEqual(log.configured, [{
    codec: "mp4a.40.2", sampleRate: 44100, numberOfChannels: 2, bitrate: 256000, bitrateMode: "constant",
  }]);

  const file = describe(bytes);
  assert.deepEqual(file.order, ["ftyp", "moov", "mdat"]);
  const frames = Math.ceil((samples + 2112) / FRAME);
  assert.equal(file.frames, frames);
  assert.equal(file.priming, 2112, "Apple's delay is skipped");
  assert.equal(file.presented, samples, "as long as the selection, to the sample");
  assert.equal(file.channels, 2);
  const payloads = Array.from({ length: frames }, (_, i) => payload(i));
  assert.deepEqual(file.frameSizes, payloads.map((frame) => frame.length));
  sameSamples(file.mdat, joined(payloads), "the frames, in order");
});

test("every sample is handed to the encoder once, in order, as planar floats", async () => {
  const samples = 2 * RATE + 333;
  const channels = [ramp(samples, 3), ramp(samples, 4)];
  const { scope, log } = fakeCodecs();
  await encodeTone(channels, { scope });

  let offset = 0;
  for (const block of log.blocks) {
    assert.equal(block.format, "f32-planar");
    assert.equal(block.sampleRate, 44100);
    assert.equal(block.numberOfChannels, 2);
    assert.ok(block.numberOfFrames >= 1 && block.numberOfFrames <= 4096);
    assert.equal(block.timestamp, Math.round((offset / RATE) * 1e6));
    const n = block.numberOfFrames;
    // Planar: the left block, then the right block.
    sameSamples(block.data.subarray(0, n), channels[0].subarray(offset, offset + n), `left at ${offset}`);
    sameSamples(block.data.subarray(n), channels[1].subarray(offset, offset + n), `right at ${offset}`);
    offset += n;
  }
  assert.equal(offset, samples, "all of it, and nothing twice");
  assert.ok(log.audio.length === log.blocks.length && log.audio.every((audio) => audio.closed), "every AudioData is closed");
  assert.equal(log.encoders.length, 1);
  assert.equal(log.encoders[0].state, "closed", "the encoder is closed when it is done");
});

test("the loop lets the encoder catch up instead of queueing the whole tone", async () => {
  const samples = 30 * RATE;
  const { scope, log } = fakeCodecs();
  const { bytes } = await encodeTone([ramp(samples, 5)], { scope });
  assert.ok(log.blocks.length > 300, `${log.blocks.length} blocks`);
  // Nine exactly: the loop waits once more than eight are queued, and the
  // fake takes nothing off its queue while the loop is feeding it.
  assert.equal(log.maxQueue, 9, `${log.maxQueue} blocks were queued at once`);
  assert.equal(describe(bytes).presented, samples);
});

test("a mono selection is encoded as mono", async () => {
  const samples = RATE;
  const { scope, log } = fakeCodecs();
  const { bytes } = await encodeTone([ramp(samples, 6)], { scope });
  assert.equal(log.asked[0].numberOfChannels, 1);
  assert.equal(log.configured[0].numberOfChannels, 1);
  assert.ok(log.blocks.every((block) => block.numberOfChannels === 1 && block.data.length === block.numberOfFrames));
  assert.equal(describe(bytes).channels, 1);
});

test("where 256 kbit/s is refused the next rate is used, and reported", async () => {
  const { scope, log } = fakeCodecs({ supported: (config) => ({ supported: config.bitrate <= 192000 }) });
  const { bitrate } = await encodeTone([ramp(RATE, 7), ramp(RATE, 8)], { scope });
  assert.equal(bitrate, 192000);
  assert.equal(log.configured[0].bitrate, 192000);
  assert.equal(log.configured[0].bitrateMode, "constant");
});

test("a negative first timestamp is the priming", async () => {
  const samples = RATE;
  const { scope } = fakeCodecs({ priming: 1024, firstTimestamp: -FRAME_MICROSECONDS });
  const file = describe((await encodeTone([ramp(samples, 9), ramp(samples, 10)], { scope })).bytes);
  assert.equal(file.priming, 1024);
  assert.equal(file.presented, samples);
});

test("an encoder with no delay has nothing skipped", async () => {
  // Windows' encoder in the spike: timestamps from 0 and only padding to spare.
  const samples = RATE;
  const { scope } = fakeCodecs({ priming: 0 });
  const file = describe((await encodeTone([ramp(samples, 11), ramp(samples, 12)], { scope })).bytes);
  assert.equal(file.frames, Math.ceil(samples / FRAME));
  assert.equal(file.priming, 0);
  assert.equal(file.presented, samples, "the padding of the last frame is not presented");
});

test("ADTS headers are taken off before the frames are written", async () => {
  const samples = RATE;
  const { scope } = fakeCodecs({ wrap: (bytes) => adts(bytes) });
  const file = describe((await encodeTone([ramp(samples, 13), ramp(samples, 14)], { scope })).bytes);
  const payloads = Array.from({ length: file.frames }, (_, i) => payload(i));
  sameSamples(file.mdat, joined(payloads), "raw frames only");
  assert.deepEqual(file.frameSizes, payloads.map((frame) => frame.length));
});

test("ADTS frames in another format than was asked for fail the render", async () => {
  const { scope } = fakeCodecs({ wrap: (bytes) => adts(bytes, 1) });
  const error = await failure(encodeTone([ramp(RATE, 15), ramp(RATE, 16)], { scope }));
  assert.ok(error instanceof EncodeError);
  assert.match(error.message, /could not be encoded/);
});

test("without an encoder the render fails in plain words, and nothing is started", async () => {
  const none = await failure(encodeTone([ramp(RATE, 17)], { scope: {} }));
  assert.ok(none instanceof EncodeError);
  assert.match(none.message, /no AAC encoder/);

  const { scope, log } = fakeCodecs({ supported: () => ({ supported: false }) });
  const refused = await failure(encodeTone([ramp(RATE, 18)], { scope }));
  assert.ok(refused instanceof EncodeError);
  assert.match(refused.message, /no AAC encoder/);
  assert.equal(log.asked.length, 4, "all four rates were tried");
  assert.equal(log.encoders.length, 0, "no encoder was made");
});

test("an encoder error fails the render and closes the encoder", async () => {
  const { scope, log } = fakeCodecs({ errorAfterBlocks: 3 });
  const error = await failure(encodeTone([ramp(2 * RATE, 19), ramp(2 * RATE, 20)], { scope }));
  assert.ok(error instanceof EncodeError);
  assert.equal(error.name, "EncodeError");
  assert.match(error.message, /could not be encoded/);
  assert.equal(error.cause.message, "the fake encoder broke");
  assert.equal(log.encoders[0].state, "closed");
  assert.ok(log.audio.every((audio) => audio.closed));
});

test("an encode call that throws fails the render, with its AudioData closed", async () => {
  const { scope, log } = fakeCodecs({ encodeThrowsAt: 2 });
  const error = await failure(encodeTone([ramp(2 * RATE, 21)], { scope }));
  assert.ok(error instanceof EncodeError);
  assert.match(error.message, /could not be encoded/);
  assert.equal(log.audio.length, 3);
  assert.ok(log.audio.every((audio) => audio.closed), "the block that was refused is closed too");
  assert.equal(log.encoders[0].state, "closed");
});

test("a flush that rejects fails the render", async () => {
  const { scope, log } = fakeCodecs({ flushRejects: true });
  const error = await failure(encodeTone([ramp(RATE, 22)], { scope }));
  assert.ok(error instanceof EncodeError);
  assert.match(error.message, /could not be encoded/);
  assert.equal(log.encoders[0].state, "closed");
});

test("an encoder that never finishes fails the render at the deadline", async () => {
  const { scope, log } = fakeCodecs({ stallFlush: true });
  const started = Date.now();
  const error = await failure(encodeTone([ramp(RATE, 23)], { scope, timeoutMs: 60 }));
  assert.ok(Date.now() - started < 2000, "bounded by the deadline");
  assert.ok(error instanceof EncodeError);
  assert.match(error.message, /stopped answering/);
  assert.equal(log.encoders[0].state, "closed", "a stalled encoder is closed, not left running");
});

test("an encoder that never takes its queue fails the render at the deadline", async () => {
  const { scope, log } = fakeCodecs({ stallQueue: true });
  const started = Date.now();
  const error = await failure(encodeTone([ramp(10 * RATE, 24)], { scope, timeoutMs: 60 }));
  assert.ok(Date.now() - started < 2000, "bounded by the deadline");
  assert.ok(error instanceof EncodeError);
  assert.match(error.message, /stopped answering/);
  assert.ok(log.blocks.length <= 9, "it stopped feeding a queue that did not move");
  assert.equal(log.encoders[0].state, "closed");
});

test("an encoder that never says what it supports fails the render at the deadline", async () => {
  const { scope, log } = fakeCodecs({ stallSupport: true });
  const started = Date.now();
  const error = await failure(encodeTone([ramp(RATE, 25)], { scope, timeoutMs: 60 }));
  assert.ok(Date.now() - started < 2000, "bounded by the encode's own deadline, not the longer default");
  assert.ok(error instanceof EncodeError);
  assert.equal(log.encoders.length, 0);
});

test("less audio out than went in fails the render", async () => {
  const samples = RATE;
  for (const frameCount of [0, 1, Math.ceil(samples / FRAME) - 1]) {
    const { scope } = fakeCodecs({ priming: 0, frameCount });
    const error = await failure(encodeTone([ramp(samples, 26), ramp(samples, 27)], { scope }));
    assert.ok(error instanceof EncodeError, `${frameCount} frames`);
    assert.match(error.message, /could not be encoded/);
  }
});

test("an encoder that floods the page with frames fails the render", async () => {
  const samples = RATE;
  const fits = Math.ceil(samples / FRAME) + 8;
  // The most frames that are held: an encoder that states a delay of eight
  // frames (8192 samples are 185,760 microseconds) fills exactly that many.
  const most = fakeCodecs({ priming: 8192, firstTimestamp: -185760 });
  const file = describe((await encodeTone([ramp(samples, 28)], { scope: most.scope })).bytes);
  assert.equal(file.frames, fits);
  assert.equal(file.priming, 8192);
  // One frame more is refused as it arrives, and nothing past the bound is copied.
  let copied = 0;
  const flood = fakeCodecs({
    priming: 0,
    frameCount: fits + 5000,
    chunkFor: (i, bytes) => ({
      byteLength: bytes.length,
      timestamp: i * FRAME_MICROSECONDS,
      copyTo(target) {
        copied += 1;
        target.set(bytes);
      },
    }),
  });
  const error = await failure(encodeTone([ramp(samples, 28)], { scope: flood.scope }));
  assert.ok(error instanceof EncodeError);
  assert.match(error.message, /could not be encoded/);
  assert.equal(copied, fits, "frames past the bound are not held");
});

test("a chunk of an impossible size fails the render before it is copied", async () => {
  for (const size of [0, 1546, 10 * 1024 * 1024, -1, 1.5, NaN, undefined]) {
    let copied = 0;
    const { scope } = fakeCodecs({
      chunkFor: (i, bytes) => ({
        byteLength: i === 2 ? size : bytes.length,
        timestamp: i * FRAME_MICROSECONDS,
        copyTo(target) {
          copied += 1;
          target.set(bytes.subarray(0, target.length));
        },
      }),
    });
    const error = await failure(encodeTone([ramp(RATE, 29)], { scope }));
    assert.ok(error instanceof EncodeError, `size ${size}`);
    assert.equal(copied, 2, `size ${size}: nothing is copied from the bad chunk or after it`);
  }
  // And the encoder is not fed the rest of a tone whose output was refused.
  const long = fakeCodecs({
    chunkFor: (i, bytes) => ({
      byteLength: i === 2 ? 0 : bytes.length,
      timestamp: i * FRAME_MICROSECONDS,
      copyTo(target) {
        target.set(bytes);
      },
    }),
  });
  assert.ok(await failure(encodeTone([ramp(30 * RATE, 29)], { scope: long.scope })) instanceof EncodeError);
  assert.ok(long.log.blocks.length <= 20, `${long.log.blocks.length} of 323 blocks were fed after the refusal`);
  // The largest AAC-LC frame of two channels with an ADTS header is taken.
  const { scope } = fakeCodecs({
    priming: 0,
    chunkFor: (i) => ({
      byteLength: 1545,
      timestamp: i * FRAME_MICROSECONDS,
      copyTo(target) {
        target.fill(0x21);
      },
    }),
  });
  assert.equal(describe((await encodeTone([ramp(RATE, 30)], { scope })).bytes).frameSizes[0], 1545);
});

test("a first timestamp that is not a number fails the render", async () => {
  for (const timestamp of [NaN, undefined, "0", Infinity]) {
    const { scope } = fakeCodecs({
      chunkFor: (i, bytes) => ({
        byteLength: bytes.length,
        timestamp,
        copyTo(target) {
          target.set(bytes);
        },
      }),
    });
    const error = await failure(encodeTone([ramp(RATE, 31)], { scope }));
    assert.ok(error instanceof EncodeError, `timestamp ${timestamp}`);
    assert.match(error.message, /could not be encoded/);
  }
});

test("anything but one or two equal, non-empty Float32Array channels is refused", async () => {
  const { scope, log } = fakeCodecs();
  const good = ramp(RATE, 32);
  await assert.rejects(encodeTone([], { scope }), RangeError);
  await assert.rejects(encodeTone([good, good, good], { scope }), RangeError);
  await assert.rejects(encodeTone(good, { scope }), RangeError);
  await assert.rejects(encodeTone([new Float32Array(0)], { scope }), RangeError);
  await assert.rejects(encodeTone([good, ramp(RATE + 1, 33)], { scope }), TypeError);
  await assert.rejects(encodeTone([Array.from(good)], { scope }), TypeError);
  assert.equal(log.asked.length, 0, "refused before the encoder is asked anything");
});

// Found by a mutation pass (2026-11-26): each of these was a check that could
// be weakened with every test above still passing.

/**
 * For one test, setTimeout notes every delay of a second or more. The
 * deadlines in encode.js are the only timers that long, so a test can read
 * which deadline was set and see whether it was cleared. With `fire`, such a
 * timer goes off at once instead of after its delay, so a test of a stalled
 * encoder does not wait for the deadline it is reading; a number for `fire`
 * does that only to timers at least that long, and leaves the others to run
 * their real course. Timers under a second are real either way.
 */
function watchDeadlines(t, { fire }) {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const watch = { delays: [], open: new Set() };
  globalThis.setTimeout = (callback, ms, ...rest) => {
    if (!(ms >= 1000)) return realSet(callback, ms, ...rest);
    watch.delays.push(ms);
    const id = realSet(() => {
      watch.open.delete(id);
      callback(...rest);
    }, fire === true || (typeof fire === "number" && ms >= fire) ? 0 : ms);
    watch.open.add(id);
    return id;
  };
  globalThis.clearTimeout = (id) => {
    watch.open.delete(id);
    return realClear(id);
  };
  t.after(() => {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
    // A deadline that a broken build left behind must not hold the run open.
    for (const id of watch.open) realClear(id);
  });
  return watch;
}

test("mono ADTS frames are taken off for a mono tone", async () => {
  const { scope } = fakeCodecs({ wrap: (bytes) => adts(bytes, 1) });
  const file = describe((await encodeTone([ramp(RATE, 40)], { scope })).bytes);
  assert.equal(file.channels, 1);
  sameSamples(file.mdat, joined(Array.from({ length: file.frames }, (_, i) => payload(i))), "raw frames only");
});

test("a negative first timestamp that is not a whole frame is still the priming", async () => {
  // 1536 samples: not what rule 2 (2112) or rule 3 (whole frames) would give,
  // so only the first chunk's own timestamp can have said it.
  const { scope } = fakeCodecs({ priming: 1536, firstTimestamp: -34830 });
  const file = describe((await encodeTone([ramp(RATE, 41), ramp(RATE, 42)], { scope })).bytes);
  assert.equal(file.priming, 1536);
  assert.equal(file.presented, RATE);
});

test("a tone one sample past a whole block is fed to its last sample", async () => {
  for (const samples of [4097, 3 * 4096 + 1]) {
    const { scope, log } = fakeCodecs();
    const channel = ramp(samples, 43);
    await encodeTone([channel], { scope });
    assert.equal(log.blocks.reduce((n, block) => n + block.numberOfFrames, 0), samples, `${samples}`);
    const last = log.blocks[log.blocks.length - 1];
    assert.equal(last.numberOfFrames, 1);
    assert.equal(last.data[0], channel[samples - 1]);
  }
});

test("with no scope given, the encoder is the page's own", async (t) => {
  const { scope, log } = fakeCodecs();
  globalThis.AudioEncoder = scope.AudioEncoder;
  globalThis.AudioData = scope.AudioData;
  t.after(() => {
    delete globalThis.AudioEncoder;
    delete globalThis.AudioData;
  });
  assert.equal(hasEncoder(), true);
  assert.equal(await supportedBitrate(2), 256000);
  assert.equal((await encodeTone([ramp(RATE, 44)])).bitrate, 256000);
  assert.equal(log.encoders.length, 1);
});

test("a bare Float32Array is not a list of channels, however short", async () => {
  const { scope } = fakeCodecs();
  await assert.rejects(encodeTone(Float32Array.of(0.1, 0.2), { scope }), RangeError);
  await assert.rejects(encodeTone(Float32Array.of(0.1), { scope }), RangeError);
});

test("an encode call that throws is kept as the cause", async () => {
  const { scope } = fakeCodecs({ encodeThrowsAt: 2 });
  const error = await failure(encodeTone([ramp(2 * RATE, 45)], { scope }));
  assert.ok(error instanceof EncodeError);
  assert.ok(error.cause instanceof TypeError);
});

test("an encoder that closes itself without a word fails the render at once", async () => {
  // Its queue never moves, so only its state says that waiting is pointless.
  const { scope } = fakeCodecs({ stallQueue: true });
  class Closing extends scope.AudioEncoder {
    encode(audio) {
      super.encode(audio);
      if (this.blocks >= 9) this.state = "closed";
    }
  }
  const started = Date.now();
  const error = await failure(encodeTone([ramp(10 * RATE, 46)], { scope: { ...scope, AudioEncoder: Closing }, timeoutMs: 20000 }));
  assert.ok(Date.now() - started < 5000, "not at the deadline");
  assert.ok(error instanceof EncodeError);
  assert.match(error.message, /could not be encoded/);
});

test("an encoder that reports an error and stays open fails the render at once", async () => {
  const { scope } = fakeCodecs({ stallQueue: true });
  class Erroring extends scope.AudioEncoder {
    encode(audio) {
      super.encode(audio);
      if (this.blocks >= 9) this.init.error(new Error("boom"));
    }
  }
  const started = Date.now();
  const error = await failure(encodeTone([ramp(10 * RATE, 47)], { scope: { ...scope, AudioEncoder: Erroring }, timeoutMs: 20000 }));
  assert.ok(Date.now() - started < 5000, "not at the deadline");
  assert.ok(error instanceof EncodeError);
  assert.equal(error.cause.message, "boom");
});

test("the error callback's word comes before the flush's rejection", async () => {
  const { scope } = fakeCodecs();
  class FlushError extends scope.AudioEncoder {
    flush() {
      this.init.error(new Error("flush boom"));
      return Promise.reject(new Error("AbortError"));
    }
  }
  const error = await failure(encodeTone([ramp(RATE, 48)], { scope: { ...scope, AudioEncoder: FlushError } }));
  assert.ok(error instanceof EncodeError);
  assert.equal(error.cause.message, "flush boom");
});

test("an encoder that throws when it is closed does not fail a finished encode", async () => {
  const { scope } = fakeCodecs();
  class Stubborn extends scope.AudioEncoder {
    close() {
      super.close();
      throw new Error("InvalidStateError");
    }
  }
  const { bytes } = await encodeTone([ramp(RATE, 49)], { scope: { ...scope, AudioEncoder: Stubborn } });
  assert.equal(describe(bytes).presented, RATE);
});

test("the question about support has its own 5 s deadline, whatever the encode's", async (t) => {
  const watch = watchDeadlines(t, { fire: true });
  const silent = fakeCodecs({ stallSupport: true });
  // By default.
  assert.equal(await supportedBitrate(2, { scope: silent.scope }), null);
  assert.equal(watch.delays.length, 1);
  assert.ok(watch.delays[0] <= SUPPORT_TIMEOUT_MS && watch.delays[0] > SUPPORT_TIMEOUT_MS - 50, `${watch.delays[0]} ms`);
  // And inside an encode with a longer deadline of its own.
  watch.delays.length = 0;
  const error = await failure(encodeTone([ramp(RATE, 50)], { scope: silent.scope, timeoutMs: 60000 }));
  assert.ok(error instanceof EncodeError);
  assert.equal(watch.delays.length, 1);
  assert.ok(watch.delays[0] <= SUPPORT_TIMEOUT_MS && watch.delays[0] > SUPPORT_TIMEOUT_MS - 50, "not the encode's 60 s");
});

test("the encode's deadline covers the whole encode: the flush gets what is left of it", async (t) => {
  const watch = watchDeadlines(t, { fire: true });
  const { scope } = fakeCodecs({ stallFlush: true });
  // Feeding takes at least 300 ms of real time: the queue reads as full until then.
  class Slow extends scope.AudioEncoder {
    set encodeQueueSize(value) {
      this.size = value;
    }

    get encodeQueueSize() {
      this.since ??= Date.now();
      return Date.now() - this.since < 300 ? 9 : 0;
    }
  }
  const error = await failure(encodeTone([ramp(RATE, 51)], { scope: { ...scope, AudioEncoder: Slow }, timeoutMs: 20000 }));
  assert.match(error.message, /stopped answering/);
  // One long timer for the support question's answer, then the flush's.
  assert.equal(watch.delays.length, 2);
  assert.ok(watch.delays[0] <= SUPPORT_TIMEOUT_MS && watch.delays[0] > SUPPORT_TIMEOUT_MS - 50);
  assert.ok(watch.delays[1] <= 20000 - 300, `the flush was given ${watch.delays[1]} ms of a 20,000 ms encode that had used 300`);
  assert.ok(watch.delays[1] > 15000, "and not next to nothing");
});

test("no deadline's timer outlives a finished encode or a finished question", async (t) => {
  const watch = watchDeadlines(t, { fire: false });
  const { scope } = fakeCodecs();
  await encodeTone([ramp(RATE, 52)], { scope, timeoutMs: 20000 });
  assert.ok(watch.delays.length >= 2, "the deadlines were set");
  assert.equal(watch.open.size, 0, "and every one was cleared");
  watch.delays.length = 0;
  assert.equal(await supportedBitrate(2, { scope, timeoutMs: 20000 }), 256000);
  assert.equal(watch.delays.length, 1);
  assert.ok(watch.delays[0] <= 20000 && watch.delays[0] > 19950);
  assert.equal(watch.open.size, 0);
});

// Found by an adversarial review (2026-11-26), each with a reproduction: an
// encoder that lost a frame still got a file, the deadline was not the whole
// call's, and two failures escaped as something other than an EncodeError.

/** A chunk as the fake makes it, with the timestamp of frame `at` and a count of copies. */
function stamped(bytes, at, counter = null) {
  return {
    byteLength: bytes.length,
    timestamp: at,
    copyTo(target) {
      if (counter !== null) counter.copied += 1;
      target.set(bytes);
    },
  };
}

test("a frame lost in the middle shows in the timestamps and fails the render", async () => {
  // From frame 10 on every timestamp is one frame late, as when frame 10
  // never came out. Without the check the file was written, short of audio.
  const counter = { copied: 0 };
  const { scope } = fakeCodecs({
    chunkFor: (i, bytes) => stamped(bytes, (i >= 10 ? i + 1 : i) * FRAME_MICROSECONDS, counter),
  });
  const error = await failure(encodeTone([ramp(RATE, 60), ramp(RATE, 61)], { scope }));
  assert.ok(error instanceof EncodeError);
  assert.match(error.message, /could not be encoded/);
  assert.equal(counter.copied, 10, "nothing is copied from the frame that is out of place, or after it");
});

test("timestamps that repeat, run backwards or are not numbers fail the render", async () => {
  const cases = {
    "a frame twice": (i) => (i >= 5 ? i - 1 : i) * FRAME_MICROSECONDS,
    "backwards": (i) => (i === 7 ? 3 : i) * FRAME_MICROSECONDS,
    "half a frame early": (i) => (i === 4 ? 3.4 : i) * FRAME_MICROSECONDS,
    "NaN later on": (i) => (i === 2 ? NaN : i * FRAME_MICROSECONDS),
    "a string later on": (i) => (i === 2 ? String(i * FRAME_MICROSECONDS) : i * FRAME_MICROSECONDS),
    "infinite": (i) => (i === 0 ? Infinity : i * FRAME_MICROSECONDS),
    "all the same": () => 0,
  };
  for (const [name, timestampOf] of Object.entries(cases)) {
    const { scope } = fakeCodecs({ chunkFor: (i, bytes) => stamped(bytes, timestampOf(i)) });
    const error = await failure(encodeTone([ramp(RATE, 62)], { scope }));
    assert.ok(error instanceof EncodeError, name);
    assert.match(error.message, /could not be encoded/, name);
  }
  // Up to half a frame of jitter is an encoder rounding its own clock.
  const jitter = fakeCodecs({ chunkFor: (i, bytes) => stamped(bytes, Math.floor(i * FRAME_MICROSECONDS) + (i % 2)) });
  assert.equal(describe((await encodeTone([ramp(RATE, 62)], { scope: jitter.scope })).bytes).presented, RATE);
});

test("timestamps may start anywhere, so long as they then run a frame at a time", async () => {
  // What both measured encoders do, to the microsecond: 0, 23219, 46439.
  const real = fakeCodecs({ chunkFor: (i, bytes) => stamped(bytes, Math.floor((i * 1024 * 1e6) / RATE)) });
  assert.equal(describe((await encodeTone([ramp(RATE, 63)], { scope: real.scope })).bytes).priming, 2112);
});

test("a copy that throws inside the output callback fails the render", async () => {
  // Thrown into the encoder it would be lost, and the frame with it.
  const { scope } = fakeCodecs({
    chunkFor: (i, bytes) => ({
      byteLength: bytes.length,
      timestamp: i * FRAME_MICROSECONDS,
      copyTo(target) {
        if (i === 10) throw new Error("copy boom");
        target.set(bytes);
      },
    }),
  });
  const error = await failure(encodeTone([ramp(RATE, 64), ramp(RATE, 65)], { scope }));
  assert.ok(error instanceof EncodeError);
  assert.equal(error.cause.message, "copy boom");
});

test("an Apple-like encoder with a frame too many fails the render", async () => {
  const samples = RATE;
  const right = Math.ceil((samples + 2112) / FRAME);
  const good = fakeCodecs({ frameCount: right });
  assert.equal(describe((await encodeTone([ramp(samples, 66)], { scope: good.scope })).bytes).priming, 2112);
  const { scope } = fakeCodecs({ frameCount: right + 1 });
  const error = await failure(encodeTone([ramp(samples, 66)], { scope }));
  assert.ok(error instanceof EncodeError);
  assert.match(error.cause.message, /more frames than the audio fills/);
});

test("an encoder that cannot be made or set up fails the render as an EncodeError", async () => {
  const { scope } = fakeCodecs();
  class Unmakeable extends scope.AudioEncoder {
    constructor(init) {
      super(init);
      throw new TypeError("no encoder for you");
    }
  }
  const made = await failure(encodeTone([ramp(RATE, 67)], { scope: { ...scope, AudioEncoder: Unmakeable } }));
  assert.ok(made instanceof EncodeError);
  assert.equal(made.cause.message, "no encoder for you");

  class Unconfigurable extends scope.AudioEncoder {
    configure() {
      throw new TypeError("bad config");
    }
  }
  const log = fakeCodecs();
  class Tracked extends Unconfigurable {
    close() {
      log.closed = true;
      super.close();
    }
  }
  const set = await failure(encodeTone([ramp(RATE, 68)], { scope: { ...scope, AudioEncoder: Tracked } }));
  assert.ok(set instanceof EncodeError);
  assert.equal(set.cause.message, "bad config");
  assert.equal(log.closed, true, "the encoder that was made is closed");
});

test("an answer about support that throws when it is read is a no", async () => {
  const { scope, log } = fakeCodecs({
    supported: (config) => ({
      get supported() {
        if (config.bitrate > 160000) throw new TypeError("no peeking");
        return true;
      },
    }),
  });
  assert.equal(await supportedBitrate(2, { scope }), 160000);
  assert.equal(log.asked.length, 3);
  const { bitrate } = await encodeTone([ramp(RATE, 69)], { scope });
  assert.equal(bitrate, 160000);
});

test("the deadline is for the whole call: the questions about support count against it", async (t) => {
  // The 5 s for the question stays real (it is answered long before); the
  // flush's deadline, some 20 s, goes off at once.
  const watch = watchDeadlines(t, { fire: 10000 });
  const { scope } = fakeCodecs({ stallFlush: true });
  // The answer about support takes at least 150 ms of real time.
  class SlowToAnswer extends scope.AudioEncoder {
    static isConfigSupported(config) {
      return new Promise((resolve) => {
        setTimeout(() => resolve({ supported: true, config }), 150);
      });
    }
  }
  const error = await failure(encodeTone([ramp(RATE, 70)], { scope: { ...scope, AudioEncoder: SlowToAnswer }, timeoutMs: 20000 }));
  assert.match(error.message, /stopped answering/);
  const flush = watch.delays[watch.delays.length - 1];
  assert.ok(flush <= 20000 - 150, `the flush was given ${flush} ms of a 20,000 ms call that had used 150`);
  assert.ok(flush > 15000);
});

test("the questions about support share one deadline", async (t) => {
  const watch = watchDeadlines(t, { fire: false });
  const { scope } = fakeCodecs();
  // Four refusals, each after at least 100 ms of real time.
  class SlowToRefuse extends scope.AudioEncoder {
    static isConfigSupported() {
      return new Promise((resolve) => {
        setTimeout(() => resolve({ supported: false }), 100);
      });
    }
  }
  assert.equal(await supportedBitrate(2, { scope: { ...scope, AudioEncoder: SlowToRefuse } }), null);
  assert.equal(watch.delays.length, 4);
  assert.ok(watch.delays[0] <= SUPPORT_TIMEOUT_MS && watch.delays[0] > SUPPORT_TIMEOUT_MS - 50);
  watch.delays.forEach((delay, i) => {
    assert.ok(delay <= SUPPORT_TIMEOUT_MS - i * 100, `question ${i} was given ${delay} ms`);
  });
  assert.equal(watch.open.size, 0);
});

test("an encoder that is slow inside encode() is stopped at the deadline too", async () => {
  // Its queue reads as empty, so the loop never waits; only the clock tells.
  const { scope, log } = fakeCodecs();
  class Busy extends scope.AudioEncoder {
    encode(audio) {
      super.encode(audio);
      this.encodeQueueSize = 0;
      const until = performance.now() + 5;
      while (performance.now() < until);
    }
  }
  const started = Date.now();
  const error = await failure(encodeTone([ramp(30 * RATE, 71)], { scope: { ...scope, AudioEncoder: Busy }, timeoutMs: 80 }));
  assert.ok(error instanceof EncodeError);
  assert.match(error.message, /stopped answering/);
  assert.ok(log.blocks.length < 100, `${log.blocks.length} of 323 blocks were fed past an 80 ms deadline`);
  assert.ok(Date.now() - started < 1500);
  assert.equal(log.encoders[0].state, "closed");
});

test("more than forty seconds, or a sample outside [-1, 1], is refused before the encoder is asked", async () => {
  assert.equal(MAX_SECONDS, 40);
  const { scope, log } = fakeCodecs();
  await assert.rejects(encodeTone([new Float32Array(MAX_SECONDS * RATE + 1)], { scope }), RangeError);
  for (const bad of [NaN, Infinity, -Infinity, 1.0001, -7]) {
    const channel = ramp(RATE, 72);
    channel[500] = bad;
    await assert.rejects(encodeTone([channel], { scope }), RangeError, `sample ${bad}`);
    await assert.rejects(encodeTone([ramp(RATE, 73), channel], { scope }), RangeError, `sample ${bad}, second channel`);
  }
  assert.equal(log.asked.length, 0);
  // Exactly forty seconds of samples at full scale is taken.
  const full = new Float32Array(MAX_SECONDS * RATE).fill(1);
  full[1] = -1;
  assert.equal(describe((await encodeTone([full], { scope })).bytes).presented, MAX_SECONDS * RATE);
});

test("a bad last chunk, arriving as the encoder finishes, fails the render", async () => {
  // The last frame comes out during the flush. If its refusal were lost
  // there, the frames before it would pass for a whole encode with a shorter
  // delay, and a file would be written.
  const samples = RATE;
  const last = Math.ceil((samples + 2112) / FRAME) - 1;
  const cases = {
    "a frame late": (i, bytes) => stamped(bytes, (i === last ? i + 1 : i) * FRAME_MICROSECONDS),
    "too large": (i, bytes) => ({ ...stamped(bytes, i * FRAME_MICROSECONDS), byteLength: i === last ? 5000 : bytes.length }),
    "a copy that throws": (i, bytes) => ({
      byteLength: bytes.length,
      timestamp: i * FRAME_MICROSECONDS,
      copyTo(target) {
        if (i === last) throw new Error("late boom");
        target.set(bytes);
      },
    }),
  };
  for (const [name, chunkFor] of Object.entries(cases)) {
    const { scope, log } = fakeCodecs({ chunkFor });
    const error = await failure(encodeTone([ramp(samples, 80), ramp(samples, 81)], { scope }));
    assert.ok(error instanceof EncodeError, name);
    assert.match(error.message, /could not be encoded/, name);
    assert.equal(log.encoders[0].emitted, last + 1, `${name}: the bad chunk was the last one`);
  }
});

test("the deadline does not move with the wall clock", async (t) => {
  // The wall clock jumps an hour ahead just after the encode starts (a time
  // sync, a daylight change). A deadline read from it would be long past.
  const realNow = Date.now;
  let calls = 0;
  Date.now = () => {
    calls += 1;
    return realNow() + (calls > 1 ? 3600000 : 0);
  };
  t.after(() => {
    Date.now = realNow;
  });
  const { scope } = fakeCodecs();
  const { bytes } = await encodeTone([ramp(RATE, 82)], { scope });
  assert.equal(describe(bytes).presented, RATE);
  assert.equal(await supportedBitrate(2, { scope }), 256000);
});
