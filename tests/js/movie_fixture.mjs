// Movies made box by box, for the tests of core/static/audio/movie.js.
//
// movie.js never decodes: it follows the index to the audio frames and copies
// them. So a "frame" here is any run of bytes, and the picture is a hole of a
// given size that holds nothing, which lets a test stand in a video of several
// gigabytes and see exactly which bytes of it were asked for.

export function concat(parts) {
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

export function u32(...values) {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((value, i) => view.setUint32(i * 4, value));
  return out;
}

export function u16(...values) {
  const out = new Uint8Array(values.length * 2);
  const view = new DataView(out.buffer);
  values.forEach((value, i) => view.setUint16(i * 2, value));
  return out;
}

function u64(value) {
  return u32(Math.floor(value / 2 ** 32), value % 2 ** 32);
}

function f64(value) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value);
  return out;
}

export function ascii(text) {
  return Uint8Array.from(text, (character) => character.charCodeAt(0));
}

export function box(type, ...parts) {
  const body = concat(parts);
  return concat([u32(8 + body.length), ascii(type), body]);
}

// AudioSpecificConfigs: AAC-LC, by rate and channels.
export const AAC_48K_STEREO = [0x11, 0x90];
export const AAC_44K_MONO = [0x12, 0x08];

/**
 * The content of an esds box. longLengths writes each descriptor's length in
 * four bytes, as ffmpeg does; the short form is the one byte Apple writes.
 */
export function esdsPayload({ objectType = 0x40, config = AAC_48K_STEREO, longLengths = false } = {}) {
  const sized = (length) => (longLengths ? [0x80, 0x80, 0x80, length] : [length]);
  const info = [0x05, ...sized(config.length), ...config];
  // Object type, stream type, buffer size, the two bitrates, then the config.
  const decoder = [objectType, 0x15, 0, 0, 0, 0, 1, 0xf4, 0, 0, 1, 0xf4, 0, ...info];
  const es = [0, 0, 0, 0x04, ...sized(decoder.length), ...decoder, 0x06, ...sized(1), 0x02];
  return Uint8Array.from([0, 0, 0, 0, 0x03, ...sized(es.length), ...es]);
}

/**
 * One sample description of a sound track.
 * @param {{format?: string, version?: number, wave?: boolean, esds?: Uint8Array | null}} [options]
 *   version 0 is plain (and every MP4), 1 and 2 are QuickTime's; wave puts
 *   the esds inside a "wave" box, as QuickTime does; esds null leaves it out
 */
export function soundEntry({ format = "mp4a", version = 0, wave = false, esds = esdsPayload() } = {}) {
  const parts = [u16(0, 0, 0, 1), u16(version, 0), u32(0), u16(2, 16, version === 0 ? 0 : 0xfffe, 0),
    u32(48000 * 65536)];
  if (version === 1) parts.push(u32(1024, 0, 0, 2));
  if (version === 2) parts.push(u32(72), f64(48000), u32(2, 0x7f000000, 16, 0, 0, 1024));
  if (esds !== null) {
    const inner = box("esds", esds);
    // The wave box ends with an empty terminator.
    parts.push(wave ? box("wave", box("frma", ascii(format)), box("mp4a", u32(0)), inner, u32(8, 0)) : inner);
  }
  return box(format, ...parts);
}

/** `count` frames of different lengths and contents, so a wrong cut shows. */
export function someFrames(count, { length = null, seed = 1 } = {}) {
  return Array.from({ length: count }, (_, i) => {
    const frame = new Uint8Array(length ?? 5 + ((i * 7 + seed) % 11));
    for (let b = 0; b < frame.length; b += 1) frame[b] = (seed * 31 + i * 17 + b * 3) & 0xff;
    return frame;
  });
}

function trackBox({ id, handler, enabled, timescale, duration, mdhdVersion, stbl, mdhd: mdhdContent = null }) {
  let mdhd = mdhdVersion === 1
    ? box("mdhd", u32(0x01000000), u64(0), u64(0), u32(timescale), u64(duration), u16(0, 0))
    : box("mdhd", u32(0, 0, 0, timescale, duration), u16(0, 0));
  if (mdhdContent !== null) mdhd = box("mdhd", mdhdContent);
  return box("trak",
    box("tkhd", u32(enabled ? 0xf : 0xe, 0, 0, id, 0, duration, 0, 0), new Uint8Array(52)),
    box("mdia",
      mdhd,
      // QuickTime names the component's kind before the handler.
      box("hdlr", u32(0), ascii("mhlr"), ascii(handler), u32(0, 0, 0), ascii("\0")),
      box("minf",
        box("smhd", u32(0, 0)),
        // The data handler: a second hdlr, which says nothing about the track.
        box("hdlr", u32(0), ascii("dhlr"), ascii("alis"), u32(0, 0, 0), ascii("\0")),
        box("dinf", box("dref", u32(0, 1), box("url ", u32(1)))),
        stbl)));
}

/**
 * A movie laid out as a phone lays one out: ftyp, wide, the box with picture
 * and sound in alternating chunks, and the index last.
 *
 * @param {object} [options]
 * @param {string | null} [options.brand] the ftyp's brand; null for no ftyp
 * @param {boolean} [options.indexFirst] put the index before the data
 * @param {number} [options.picture] bytes of each picture chunk, a hole in
 *   the file; 0 for a file with no picture track
 * @param {object[]} [options.sounds] one per sound track: `frames`
 *   (Uint8Array[]), `perChunk`, `entry` (a sample description), `enabled`,
 *   `timescale`, `handler`, `co64`, `mdhdVersion`, `mdhd` (the content of
 *   that box, replacing it), and `tables`, which replaces the content of
 *   stsd, stts, stsc, stsz or stco (or the chunk boxes' name with
 *   `offsetsBox`), or drops stts, stsc, stsz or stco with null
 * @param {number} [options.extraTracks] metadata tracks before the sound
 * @param {Uint8Array[]} [options.before] whole boxes between ftyp and the data
 * @param {boolean} [options.tail] end the index with a udta box, as a phone
 *   does; false leaves the last track's last table at the very end
 * @returns {{size: number, segments: {name: string, at: number, bytes: Uint8Array}[],
 *   sounds: {ranges: number[][], frames: Uint8Array[]}[], pictures: number[][],
 *   index: {at: number, length: number}}} the file as the pieces that hold
 *   bytes; everything between them is a hole
 */
export function movie({
  brand = "qt  ", indexFirst = false, picture = 5000, sounds = [{}], extraTracks = 0, before = [], tail = true,
} = {}) {
  const specs = sounds.map((spec) => ({
    frames: someFrames(7), perChunk: 3, entry: soundEntry({ version: 1, wave: true }), enabled: true,
    timescale: 48000, handler: "soun", co64: false, mdhdVersion: 0, mdhd: null, tables: {}, ...spec,
  }));
  const chunkCount = Math.max(1, ...specs.map((spec) => Math.ceil(spec.frames.length / spec.perChunk)));

  // The data: for each chunk number, the picture's chunk, then each track's.
  const place = (dataStart) => {
    let at = dataStart;
    const pictures = [];
    const placed = specs.map(() => ({ ranges: [], segments: [] }));
    for (let chunk = 0; chunk < chunkCount; chunk += 1) {
      if (picture > 0) {
        pictures.push([at, picture]);
        at += picture;
      }
      specs.forEach((spec, s) => {
        const frames = spec.frames.slice(chunk * spec.perChunk, (chunk + 1) * spec.perChunk);
        if (frames.length === 0) return;
        const bytes = concat(frames);
        placed[s].ranges.push([at, bytes.length]);
        placed[s].segments.push({ name: "sound", at, bytes });
        at += bytes.length;
      });
    }
    return { pictures, placed, end: at };
  };

  const index = (placed, pictures) => {
    const tracks = [];
    let id = 1;
    if (picture > 0) {
      tracks.push(trackBox({
        id, handler: "vide", enabled: true, timescale: 600, duration: 600, mdhdVersion: 0,
        stbl: box("stbl",
          box("stsd", u32(0, 1), box("avc1", new Uint8Array(70))),
          box("stts", u32(0, 1, pictures.length, 20)),
          box("stsc", u32(0, 1, 1, 1, 1)),
          box("stsz", u32(0, picture, pictures.length)),
          box("co64", u32(0, pictures.length), ...pictures.map(([at]) => u64(at)))),
      }));
      id += 1;
    }
    for (let i = 0; i < extraTracks; i += 1) {
      tracks.push(trackBox({
        id, handler: "meta", enabled: true, timescale: 600, duration: 600, mdhdVersion: 0,
        stbl: box("stbl", box("stsd", u32(0, 1), box("mebx", new Uint8Array(8)))),
      }));
      id += 1;
    }
    specs.forEach((spec, s) => {
      const count = spec.frames.length;
      const full = Math.floor(count / spec.perChunk);
      const runs = count % spec.perChunk === 0
        ? [1, spec.perChunk, 1] : [1, spec.perChunk, 1, full + 1, count % spec.perChunk, 1];
      const offsets = placed[s].ranges.map(([at]) => at);
      const defaults = {
        stts: u32(0, 1, count, 1024),
        stsc: u32(0, runs.length / 3, ...runs),
        stsz: u32(0, 0, count, ...spec.frames.map((frame) => frame.length)),
        stco: spec.co64 ? concat([u32(0, offsets.length), ...offsets.map(u64)]) : u32(0, offsets.length, ...offsets),
      };
      const table = (name, type = name) => {
        const content = name in spec.tables ? spec.tables[name] : defaults[name];
        return content === null ? new Uint8Array(0) : box(type, content);
      };
      tracks.push(trackBox({
        id, handler: spec.handler, enabled: spec.enabled, timescale: spec.timescale, duration: count * 1024,
        mdhdVersion: spec.mdhdVersion, mdhd: spec.mdhd,
        stbl: box("stbl",
          "stsd" in spec.tables ? box("stsd", spec.tables.stsd) : box("stsd", u32(0, 1), spec.entry),
          table("stts"), table("stsc"), table("stsz"),
          table("stco", spec.tables.offsetsBox ?? (spec.co64 ? "co64" : "stco"))),
      }));
      id += 1;
    });
    return box("moov", box("mvhd", new Uint8Array(100)), ...tracks, ...(tail ? [box("udta", u32(0))] : []));
  };

  const head = concat([
    ...(brand === null ? [] : [box("ftyp", ascii(brand), u32(0), ascii(brand))]),
    box("wide"),
    ...before,
  ]);
  // The index is as long whatever offsets it holds, so measure it first.
  const measured = place(0);
  const indexLength = index(measured.placed, measured.pictures).length;
  const dataLength = measured.end;
  const large = dataLength + 8 >= 2 ** 32;
  const dataHeader = large ? concat([u32(1), ascii("mdat"), u64(dataLength + 16)]) : concat([u32(dataLength + 8), ascii("mdat")]);
  const dataBoxAt = head.length + (indexFirst ? indexLength : 0);
  const dataStart = dataBoxAt + dataHeader.length;
  const { pictures, placed, end } = place(dataStart);
  const moov = index(placed, pictures);
  const moovAt = indexFirst ? head.length : end;
  const segments = [
    { name: "head", at: 0, bytes: head },
    { name: "mdat", at: dataBoxAt, bytes: dataHeader },
    ...placed.flatMap((track) => track.segments),
    { name: "moov", at: moovAt, bytes: moov },
  ];
  return {
    size: indexFirst ? end : end + moov.length,
    segments,
    sounds: specs.map((spec, s) => ({ ranges: placed[s].ranges, frames: spec.frames })),
    pictures,
    index: { at: moovAt, length: moov.length },
  };
}

/** The bytes of [start, end) of a file made of these pieces; holes are zeros. */
export function bytesOf(segments, start, end) {
  const out = new Uint8Array(end - start);
  for (const { at, bytes } of segments) {
    const from = Math.max(at, start);
    const to = Math.min(at + bytes.length, end);
    if (from < to) out.set(bytes.subarray(from - at, to - at), from - start);
  }
  return out;
}

/**
 * A stand-in for a picked File over these pieces, which records every read
 * as [start, end). `realSize` makes reads past it come back short, like a
 * file that is smaller than it claims.
 */
export function fileOf(segments, size, { realSize = size } = {}) {
  const reads = [];
  return {
    size,
    reads,
    whole: 0,
    slice(start, end) {
      reads.push([start, end]);
      return { arrayBuffer: async () => bytesOf(segments, start, Math.max(start, Math.min(end, realSize))).buffer };
    },
    async arrayBuffer() {
      this.whole += 1;
      return bytesOf(segments, 0, size).buffer;
    },
  };
}

// Where a box's own boxes begin, for the ones that have fields first.
const FIELDS = { stsd: 8, mp4a: 28 };

/**
 * The content of the box at a path such as ["moov", "trak", "mdia"] in an
 * MP4's bytes: the first box of each name. Null when there is none.
 */
export function dig(bytes, path) {
  let start = 0;
  let end = bytes.length;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const name of path) {
    let found = null;
    for (let at = start; end - at >= 8;) {
      const length = view.getUint32(at);
      if (length < 8 || length > end - at) break;
      if (String.fromCharCode(...bytes.subarray(at + 4, at + 8)) === name) {
        found = [at + 8, at + length];
        break;
      }
      at += length;
    }
    if (found === null) return null;
    [start, end] = found;
    start += FIELDS[name] ?? 0;
  }
  const fields = FIELDS[path[path.length - 1]] ?? 0;
  return bytes.subarray(start - fields, end);
}
