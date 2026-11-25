// The phone-encode spike's page: synthesise a loop, encode it with the
// browser's AudioEncoder, wrap it with m4a.js, and offer the files to the
// share sheet, with a report of what the encoder did. Nothing is uploaded.
//
// Serve this directory from any HTTPS origin the phone trusts (WebCodecs and
// Web Share both need a secure context); on a desktop, loopback counts:
//
//     python -I -m http.server 8081 --bind 127.0.0.1 --directory tools/spike/phone_encode
import { AAC_FRAME_SAMPLES, audioSpecificConfig, splitAdts, writeM4a } from "./m4a.js";

// The server's renders are 44.1 kHz stereo at 256 kbit/s
// (core/strange_ringtone/render.py), which Phase 0 showed iOS accepts.
const SAMPLE_RATE = 44100;
const CHANNELS = 2;
// The server's rate first. Platform encoders take only some rates (Windows'
// refuses 256 kbit/s), so the report lists which of these this one takes,
// and the tones use the highest.
const BITRATES = [256000, 192000, 160000, 128000];
// Apple's AAC encoder delays its output by 2112 samples (Technical Note
// TN2258). Used only when the encoder's own timestamps don't say.
const APPLE_PRIMING = 2112;
const BLOCK_FRAMES = 4096;
const ENCODE_TIMEOUT_MS = 60000;
// The loop starts after this much silence, so the report can tell where the
// audio begins in a decoded file, whether it comes out late or cut short.
const LEAD_SECONDS = 0.1;
const ONSET_LEVEL = 0.05;

// Named like Phase 0's files: iOS names a tone after its file.
const CASES = [
  { id: "P1", name: "P1 phone 12s", seconds: 12, editList: true },
  { id: "P2", name: "P2 phone 12s plain", seconds: 12, editList: false },
  { id: "P3", name: "P3 phone 30s", seconds: 30, editList: true },
];

// One chord a second, C, Am, F, G: a bass root and four arpeggio notes, in
// Hz. The same copyright-free loop as tools/spike/phase0.py.
const CHORDS = [
  [130.81, [523.25, 659.25, 783.99, 1046.5]],
  [110.0, [440.0, 523.25, 659.25, 880.0]],
  [87.31, [349.23, 440.0, 523.25, 698.46]],
  [98.0, [392.0, 493.88, 587.33, 783.99]],
];

const makeButton = document.getElementById("make");
const statusLine = document.getElementById("status");
const caseList = document.getElementById("cases");
const reportBox = document.getElementById("report");
const copyButton = document.getElementById("copy");
const copiedLine = document.getElementById("copied");

const reportLines = [];
let objectUrls = [];

function log(line = "") {
  reportLines.push(line);
  reportBox.textContent = reportLines.join("\n");
}

function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A copy of an ArrayBuffer or a view, as bytes. */
function toBytes(source) {
  if (source instanceof ArrayBuffer) return new Uint8Array(source.slice(0));
  return new Uint8Array(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
}

/** The loop, stereo, after LEAD_SECONDS of silence, exactly `seconds` long. */
function synthesize(seconds) {
  const total = Math.round(seconds * SAMPLE_RATE);
  const lead = Math.round(LEAD_SECONDS * SAMPLE_RATE);
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  const addNote = (start, frequency, gain, pan) => {
    const length = Math.min(Math.round(0.9 * SAMPLE_RATE), total - start);
    for (let i = 0; i < length; i += 1) {
      const t = i / SAMPLE_RATE;
      const value = gain * Math.exp(-6 * t) * Math.sin(2 * Math.PI * frequency * t);
      left[start + i] += value * (1 - pan);
      right[start + i] += value * pan;
    }
  };
  for (let second = 0; lead + second * SAMPLE_RATE < total; second += 1) {
    const [bass, notes] = CHORDS[second % CHORDS.length];
    const beat = lead + second * SAMPLE_RATE;
    addNote(beat, bass, 0.5, 0.5);
    notes.forEach((frequency, i) => {
      addNote(beat + Math.round(i * 0.25 * SAMPLE_RATE), frequency, 0.4, i % 2 === 0 ? 0.35 : 0.65);
    });
  }
  // A short fade-out, so the tone doesn't end on a click.
  const fade = Math.round(0.3 * SAMPLE_RATE);
  for (let i = 0; i < fade; i += 1) {
    const gain = i / fade;
    left[total - 1 - i] *= gain;
    right[total - 1 - i] *= gain;
  }
  return [left, right];
}

/** The first sample louder than ONSET_LEVEL in any channel, or -1. */
function onset(channels, length) {
  for (let i = 0; i < length; i += 1) {
    for (const channel of channels) {
      if (Math.abs(channel[i]) > ONSET_LEVEL) return i;
    }
  }
  return -1;
}

/** The AAC-LC config with the highest of BITRATES this encoder takes; logs each answer. */
async function pickConfig() {
  let chosen = null;
  for (const bitrate of BITRATES) {
    const config = { codec: "mp4a.40.2", sampleRate: SAMPLE_RATE, numberOfChannels: CHANNELS, bitrate };
    let answer;
    try {
      const support = await AudioEncoder.isConfigSupported(config);
      answer = support.supported ? "supported" : "not supported";
      if (support.supported && chosen === null) chosen = config;
    } catch (error) {
      answer = `throws ${error.name}: ${error.message}`;
    }
    log(`AAC-LC ${SAMPLE_RATE} Hz ${CHANNELS} ch at ${bitrate} bit/s: ${answer}`);
  }
  if (chosen === null) throw new Error("this AudioEncoder takes AAC-LC at none of the bit rates tried");
  log(`using ${chosen.bitrate} bit/s`);
  return chosen;
}

/** Encode planar float PCM to AAC-LC. Returns what the encoder emitted. */
async function encode(pcm, config) {
  const frames = [];
  const stamps = [];
  let decoderConfig = null;
  let failure = null;
  const encoder = new AudioEncoder({
    output(chunk, metadata) {
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      frames.push(bytes);
      stamps.push({ timestamp: chunk.timestamp, duration: chunk.duration, type: chunk.type });
      const emitted = metadata && metadata.decoderConfig;
      if (emitted && decoderConfig === null) {
        decoderConfig = {
          codec: emitted.codec,
          sampleRate: emitted.sampleRate,
          numberOfChannels: emitted.numberOfChannels,
          description: emitted.description ? toBytes(emitted.description) : null,
        };
      }
    },
    error(error) {
      failure = error;
    },
  });
  encoder.configure(config);

  const started = performance.now();
  const total = pcm[0].length;
  for (let offset = 0; offset < total; offset += BLOCK_FRAMES) {
    const count = Math.min(BLOCK_FRAMES, total - offset);
    const data = new Float32Array(count * CHANNELS);
    pcm.forEach((channel, c) => data.set(channel.subarray(offset, offset + count), c * count));
    const audio = new AudioData({
      format: "f32-planar",
      sampleRate: SAMPLE_RATE,
      numberOfFrames: count,
      numberOfChannels: CHANNELS,
      timestamp: Math.round((offset / SAMPLE_RATE) * 1e6),
      data,
    });
    encoder.encode(audio);
    audio.close();
    // Let the encoder catch up, and its outputs and errors arrive.
    while (encoder.state === "configured" && encoder.encodeQueueSize > 8) {
      if (performance.now() - started > ENCODE_TIMEOUT_MS) throw new Error("the encoder stopped taking input");
      await sleep(1);
    }
    if (failure) throw failure;
  }
  await Promise.race([
    encoder.flush(),
    sleep(ENCODE_TIMEOUT_MS).then(() => {
      throw new Error("the encoder did not finish");
    }),
  ]);
  if (failure) throw failure;
  encoder.close();
  if (frames.length === 0) throw new Error("the encoder emitted nothing");
  return { frames, stamps, decoderConfig, milliseconds: performance.now() - started };
}

function isAdtsFrame(frame) {
  try {
    return splitAdts(frame).frames.length === 1;
  } catch {
    return false;
  }
}

function describeEncode(encoded, samples) {
  const { frames, stamps, decoderConfig } = encoded;
  const bytes = frames.reduce((sum, frame) => sum + frame.length, 0);
  const mediaSamples = frames.length * AAC_FRAME_SAMPLES;
  log(`  encode time: ${Math.round(encoded.milliseconds)} ms`);
  log(`  input samples: ${samples}; frames out: ${frames.length} (${mediaSamples} samples, `
    + `${mediaSamples - samples} more than the input)`);
  log(`  bytes: ${bytes} (${Math.round((bytes * 8) / (samples / SAMPLE_RATE))} bit/s)`);
  log(`  first chunks (timestamp/duration in microseconds, type): `
    + stamps.slice(0, 3).map((s) => `${s.timestamp}/${s.duration}/${s.type}`).join(", "));
  const last = stamps[stamps.length - 1];
  log(`  last chunk: ${last.timestamp}/${last.duration}/${last.type}`);
  log(`  first frame starts: ${hex(frames[0].subarray(0, 8))}`);
  const expected = audioSpecificConfig(SAMPLE_RATE, CHANNELS);
  if (decoderConfig === null) {
    log("  decoderConfig: none emitted");
  } else {
    const description = decoderConfig.description;
    log(`  decoderConfig: codec ${decoderConfig.codec}, ${decoderConfig.sampleRate} Hz, `
      + `${decoderConfig.numberOfChannels} ch`);
    log(`  description: ${description ? hex(description) : "none"} (expected ${hex(expected)}: `
      + `${description && hex(description) === hex(expected) ? "same" : "DIFFERENT"})`);
  }
}

/** Raw frames and the priming to skip, from what the encoder emitted. */
function interpret(encoded, samples) {
  let frames = encoded.frames;
  if (frames.every(isAdtsFrame)) {
    log("  the encoder emitted ADTS frames; their headers are stripped");
    frames = frames.map((frame) => splitAdts(frame).frames[0]);
  }
  const first = encoded.stamps[0].timestamp;
  const extra = frames.length * AAC_FRAME_SAMPLES - samples;
  let priming;
  if (first < 0) {
    priming = Math.round((-first * SAMPLE_RATE) / 1e6);
    log(`  priming: ${priming} samples, from the first chunk's timestamp`);
  } else if (extra >= APPLE_PRIMING) {
    priming = APPLE_PRIMING;
    log(`  priming: ${priming} samples, ASSUMED (Apple's figure; the timestamps start at ${first})`);
  } else {
    // Fewer spare samples than Apple's delay: another encoder. Whole frames is the usual delay.
    priming = Math.max(0, Math.floor(extra / AAC_FRAME_SAMPLES) * AAC_FRAME_SAMPLES);
    log(`  priming: ${priming} samples, GUESSED from the frame count (not Apple's encoder?)`);
  }
  return { frames, priming };
}

/** Decode a finished file the way the app decodes a picked one, and say where its audio starts. */
async function describeDecode(bytes, originalOnset) {
  try {
    const decoded = await new OfflineAudioContext(CHANNELS, 1, SAMPLE_RATE).decodeAudioData(bytes.buffer.slice(0));
    const channels = [];
    for (let c = 0; c < decoded.numberOfChannels; c += 1) channels.push(decoded.getChannelData(c));
    const start = onset(channels, decoded.length);
    log(`  decoded here: ${decoded.length} samples at ${decoded.sampleRate} Hz, ${decoded.numberOfChannels} ch; `
      + `audio starts at sample ${start} (original: ${originalOnset}, difference ${start - originalOnset})`);
  } catch (error) {
    log(`  decoded here: FAILED, ${error.name}: ${error.message}`);
  }
}

function addCase(spec, bytes, seconds) {
  const file = new File([bytes], `${spec.name}.m4a`, { type: "audio/mp4" });
  const url = URL.createObjectURL(file);
  objectUrls.push(url);

  const item = document.createElement("li");
  const title = document.createElement("strong");
  title.textContent = file.name;
  const facts = document.createElement("div");
  facts.textContent = `${seconds.toFixed(3)} s, ${bytes.length} bytes, `
    + (spec.editList ? "with an edit list" : "no edit list");
  const player = document.createElement("audio");
  player.controls = true;
  player.preload = "metadata";
  player.src = url;
  player.addEventListener("loadedmetadata", () => log(`${spec.id} player: duration ${player.duration}`));
  player.addEventListener("error", () => log(`${spec.id} player: ERROR code ${player.error && player.error.code}`));

  const actions = document.createElement("div");
  actions.className = "actions";
  const share = document.createElement("button");
  share.type = "button";
  share.textContent = `Share ${spec.id}`;
  let canShare = false;
  try {
    canShare = typeof navigator.share === "function" && typeof navigator.canShare === "function"
      && navigator.canShare({ files: [file] });
  } catch {
    canShare = false;
  }
  share.disabled = !canShare;
  share.addEventListener("click", () => {
    // No await before share: WebKit grants it only during the click's own
    // user activation (core/static/share.js).
    navigator.share({ files: [file] }).then(
      () => log(`${spec.id} share: finished without an error`),
      (error) => log(`${spec.id} share: ${error.name}: ${error.message}`),
    );
  });
  const download = document.createElement("a");
  download.className = "download";
  download.href = url;
  download.download = file.name;
  download.textContent = `Download ${spec.id}`;
  actions.append(share, download);
  if (!canShare) {
    const note = document.createElement("span");
    note.textContent = "This browser can't share files.";
    actions.append(note);
  }

  item.append(title, facts, player, actions);
  caseList.append(item);
  log(`  file: ${file.name}, ${bytes.length} bytes, presents ${seconds.toFixed(6)} s, can share: ${canShare}`);
}

async function run() {
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls = [];
  caseList.replaceChildren();
  reportLines.length = 0;
  copiedLine.textContent = "";

  log("Phone encode spike report");
  log(`when: ${new Date().toISOString()}`);
  log(`user agent: ${navigator.userAgent}`);
  log(`secure context: ${globalThis.isSecureContext}`);
  log(`AudioEncoder: ${typeof globalThis.AudioEncoder}; AudioData: ${typeof globalThis.AudioData}`);
  log(`navigator.share: ${typeof navigator.share}; navigator.canShare: ${typeof navigator.canShare}`);
  if (typeof globalThis.AudioEncoder !== "function" || typeof globalThis.AudioData !== "function") {
    throw new Error(globalThis.isSecureContext
      ? "This browser has no AudioEncoder. On an iPhone it needs iOS 26 or later."
      : "This page is not in a secure context, where AudioEncoder doesn't exist. Open it over https.");
  }

  const config = await pickConfig();

  // P1 and P2 are one encode in two containers, so encode once per length.
  const encodes = new Map();
  for (const spec of CASES) {
    const samples = Math.round(spec.seconds * SAMPLE_RATE);
    if (!encodes.has(spec.seconds)) {
      statusLine.textContent = `Encoding ${spec.seconds} s…`;
      // Let the status line paint before the synthesis holds the thread.
      await sleep(20);
      const pcm = synthesize(spec.seconds);
      log("");
      log(`Encode of ${spec.seconds} s:`);
      const encoded = await encode(pcm, config);
      describeEncode(encoded, samples);
      encodes.set(spec.seconds, { ...interpret(encoded, samples), originalOnset: onset(pcm, samples) });
    }
    const { frames, priming, originalOnset } = encodes.get(spec.seconds);
    const mediaSamples = frames.length * AAC_FRAME_SAMPLES;
    log("");
    log(`${spec.id}:`);
    let bytes;
    let presented;
    if (spec.editList) {
      const skipped = Math.min(priming, mediaSamples - 1);
      presented = Math.min(samples, mediaSamples - skipped);
      bytes = writeM4a({ sampleRate: SAMPLE_RATE, channels: CHANNELS, frames, priming: skipped, samples: presented });
      log(`  edit list: skip ${skipped}, present ${presented} of ${mediaSamples} samples`);
    } else {
      presented = mediaSamples;
      bytes = writeM4a({ sampleRate: SAMPLE_RATE, channels: CHANNELS, frames });
      log(`  no edit list: every one of ${mediaSamples} samples`);
    }
    addCase(spec, bytes, presented / SAMPLE_RATE);
    await describeDecode(bytes, originalOnset);
  }
  log("");
  log("Made every file.");
}

makeButton.addEventListener("click", async () => {
  makeButton.disabled = true;
  try {
    await run();
    statusLine.textContent = "Done. Play each tone, then follow the checklist below.";
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    log(`FAILED: ${message}`);
    statusLine.textContent = `Failed. ${message}`;
  } finally {
    makeButton.disabled = false;
  }
});

copyButton.addEventListener("click", () => {
  const text = reportLines.join("\n");
  const selectByHand = () => {
    // No clipboard here: select the report, to copy by hand.
    const range = document.createRange();
    range.selectNodeContents(reportBox);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    copiedLine.textContent = "Selected. Copy it by hand.";
  };
  if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
    selectByHand();
    return;
  }
  navigator.clipboard.writeText(text).then(() => {
    copiedLine.textContent = "Copied.";
  }, selectByHand);
});
