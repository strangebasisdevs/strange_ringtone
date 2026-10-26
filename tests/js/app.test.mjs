// The trimmer's wiring (core/static/app.js), run against a fake DOM built from
// the real index.html. The pure modules have their own tests; these pin what
// app.js adds on top: the caps it hands them, the loudness controls, the
// render request, the share click and what a render that went stale shows.
import { test } from "node:test";
import assert from "node:assert/strict";

import { integratedLufs } from "../../core/static/audio/loudness.js";
import { loadApp, pickFile, settle, sleep, wavShape } from "./fake_dom.mjs";

const RATE = 44100;
const RESULT_ID = "0123456789abcdef0123456789abcdef";
const DISPOSITION = "attachment; filename=\"Server Name.m4a\"; filename*=UTF-8''Server%20Name.m4a";

// A mono 440 Hz sine in [seconds, amplitude] sections.
function sections(...parts) {
  const total = parts.reduce((sum, [seconds]) => sum + Math.round(seconds * RATE), 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const [seconds, amplitude] of parts) {
    const n = Math.round(seconds * RATE);
    for (let i = 0; i < n; i += 1) out[at + i] = amplitude * Math.sin((2 * Math.PI * 440 * (at + i)) / RATE);
    at += n;
  }
  return out;
}

// 20 s at -8 dB, 20 s loud, 20 s at -8 dB: the loud part is longer than a
// 15 s cap, and the quiet parts are within 10 LU, so they count in a
// whole-file measurement and move it well away from the selection's.
const SONG = sections([20, 0.2], [20, 0.5], [20, 0.2]);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function m4a() {
  return new Response(new Uint8Array([0, 1, 2, 3]), { headers: { "Content-Disposition": DISPOSITION } });
}

// The server, answering at once unless a test holds the result back.
function server(hold = null) {
  return (url) => {
    if (url.startsWith("/api/render?")) {
      return Promise.resolve(json({ result_id: RESULT_ID, duration: 15, measured_lufs: -9.5, applied_gain_db: -4.5 }));
    }
    if (url === `/api/result/${RESULT_ID}.m4a`) return hold === null ? Promise.resolve(m4a()) : hold;
    return Promise.resolve(json({ error: "not_found" }, 404));
  };
}

async function renderNow(page) {
  page.el("render").dispatch("click");
  await settle();
}

function postedFrames(page) {
  const render = page.fetchCalls.find((call) => call.url.startsWith("/api/render?"));
  assert.ok(render, "no render request");
  return wavShape(render.init.body).frames;
}

test("a nudge past the cap pulls the other edge along, and the WAV has exactly the cap's frames", async () => {
  const page = await loadApp({ maxClipSeconds: "15", fetch: server() });
  await pickFile(page, "My Song.mp3", [SONG]);
  const before = page.el("selection-readout").textContent;
  await page.nudge("end", "1");
  const after = page.el("selection-readout").textContent;
  assert.notEqual(after, before);
  assert.match(after, /15\.0 s \(the maximum\)$/);
  await renderNow(page);
  assert.equal(postedFrames(page), 15 * RATE);
});

test("the selection never gets shorter than half a second", async () => {
  const page = await loadApp({ maxClipSeconds: "15", fetch: server() });
  await pickFile(page, "My Song.mp3", [SONG]);
  for (let i = 0; i < 20; i += 1) await page.nudge("end", "-1");
  assert.match(page.el("selection-readout").textContent, /, 0\.5 s$/);
  await renderNow(page);
  assert.equal(postedFrames(page), RATE / 2);
});

test("the meter measures the selection, not the whole file", async () => {
  const page = await loadApp({ maxClipSeconds: "15", fetch: server() });
  await pickFile(page, "My Song.mp3", [SONG]);
  await sleep(300);
  const match = /measures (-?\d+\.\d) LUFS/.exec(page.el("meter-readout").textContent);
  assert.ok(match, page.el("meter-readout").textContent);
  const loudPart = integratedLufs([SONG.subarray(20 * RATE, 35 * RATE)], RATE);
  const wholeFile = integratedLufs([SONG], RATE);
  // The suggestion may start up to 1 s into the quieter lead-in.
  assert.ok(Math.abs(Number(match[1]) - loudPart) <= 0.5, `${match[1]} vs ${loudPart}`);
  assert.ok(Math.abs(wholeFile - loudPart) > 2, "the test signal does not tell the two apart");
});

test("the loudness warning shows only above -11 LUFS with levelling on", async () => {
  const page = await loadApp({ fetch: server() });
  const target = page.el("target");
  const warning = page.el("target-warning");
  assert.equal(warning.hidden, true);
  for (const [value, hidden] of [["-11", true], ["-10.9", false], ["-9", false], ["-14", true]]) {
    target.value = value;
    target.dispatch("input");
    assert.equal(warning.hidden, hidden, `target ${value}`);
  }
  target.value = "-9";
  page.el("normalize").checked = false;
  page.el("normalize").dispatch("input");
  assert.equal(warning.hidden, true, "levelling off");
});

test("Reset puts the slider back on data-default-target-lufs", async () => {
  const page = await loadApp({ defaultTarget: "-16.0", fetch: server() });
  const target = page.el("target");
  assert.equal(target.value, "-16");
  assert.equal(page.el("target-value").textContent, "-16.0 LUFS (baseline)");
  assert.equal(page.el("target-reset").disabled, true);
  target.value = "-12";
  target.dispatch("input");
  assert.equal(page.el("target-reset").disabled, false);
  page.el("target-reset").dispatch("click");
  assert.equal(target.value, "-16");
  assert.equal(page.el("target-value").textContent, "-16.0 LUFS (baseline)");
  assert.equal(page.el("target-reset").disabled, true);
});

test("a baseline with more than one decimal is rounded to the slider's step", async () => {
  // The server accepts DEFAULT_TARGET_LUFS=-14.25; the 0.1 LU slider cannot.
  const page = await loadApp({ defaultTarget: "-14.25", fetch: server() });
  const target = page.el("target");
  assert.equal(target.value, "-14.2");
  assert.equal(page.el("target-baseline").value, "-14.2");
  assert.equal(page.el("target-value").textContent, "-14.2 LUFS (baseline)");
  assert.equal(page.el("target-reset").disabled, true);
  assert.equal(Number(page.el("target-marker").style["--at"]), (-14.2 + 24) / 15);
  target.value = "-12";
  target.dispatch("input");
  page.el("target-reset").dispatch("click");
  assert.equal(page.el("target-value").textContent, "-14.2 LUFS (baseline)");
  assert.equal(page.el("target-reset").disabled, true);
});

test("Hear final posts the selection as a Uint8Array WAV with the fixed query and the name header", async () => {
  const page = await loadApp({ maxClipSeconds: "15", fetch: server(), navigator: { canShare: () => true, share: () => Promise.resolve() } });
  await pickFile(page, "My Song.mp3", [SONG]);
  await renderNow(page);
  const [render, result] = page.fetchCalls;
  assert.equal(render.url, "/api/render?fade_in=0.200&fade_out=1.500&normalize=true&target_lufs=-14.0");
  assert.equal(render.init.method, "POST");
  // A fixed body gets a Content-Length; a stream would be sent chunked, which
  // the server refuses.
  assert.ok(render.init.body instanceof Uint8Array);
  assert.equal(render.init.duplex, undefined);
  assert.equal(render.init.credentials, "same-origin");
  assert.deepEqual(render.init.headers, { "Content-Type": "audio/wav", "X-Tone-Name": "My%20Song" });
  assert.equal(result.url, `/api/result/${RESULT_ID}.m4a`);
  assert.equal(page.fetchCalls.length, 2, "the result is fetched once");
  assert.equal(page.el("result-info").hidden, false);
  assert.equal(page.el("result-duration").textContent, "15.00 s");
  assert.equal(page.el("result-lufs").textContent, "-9.5 LUFS");
  assert.equal(page.el("result-gain").textContent, "-4.5 dB");
  assert.equal(page.el("deliver").hidden, false);
  assert.equal(page.el("download-m4r").href, `/api/result/${RESULT_ID}.m4r`);
  assert.equal(page.el("fallback").href, `/api/result/${RESULT_ID}.m4a`);
  assert.equal(page.el("fallback").hidden, true);
  assert.equal(page.el("share").disabled, false);
  assert.equal(page.el("share-status").textContent, "Share sheet: available");
});

test("Get on this iPhone calls navigator.share inside the click, before anything is awaited", async () => {
  const shared = [];
  const navigator = { canShare: () => true, share: (data) => { shared.push(data); return Promise.resolve(); } };
  const page = await loadApp({ maxClipSeconds: "15", fetch: server(), navigator });
  await pickFile(page, "My Song.mp3", [SONG]);
  await renderNow(page);
  page.el("share").dispatch("click");
  // Checked before yielding even once: a call after an await would come later.
  assert.equal(shared.length, 1);
  const [file] = shared[0].files;
  assert.equal(file.name, "Server Name.m4a");
  assert.equal(file.type, "audio/mp4");
  assert.equal(file.size, 4);
});

test("a cancelled share is silent; any other failure reveals the download link", async () => {
  for (const [name, fallbackHidden] of [["AbortError", true], ["NotAllowedError", false]]) {
    const navigator = {
      canShare: () => true,
      share: () => Promise.reject(Object.assign(new Error("share"), { name })),
    };
    const page = await loadApp({ maxClipSeconds: "15", fetch: server(), navigator });
    await pickFile(page, "My Song.mp3", [SONG]);
    await renderNow(page);
    page.el("share").dispatch("click");
    await settle();
    assert.equal(page.el("fallback").hidden, fallbackHidden, name);
    if (!fallbackHidden) assert.match(page.el("share-status").textContent, /failed \(NotAllowedError\)/);
  }
});

test("without a share sheet for the file, the download link stands in", async () => {
  const page = await loadApp({ maxClipSeconds: "15", fetch: server(), navigator: { canShare: () => false, share: () => Promise.resolve() } });
  await pickFile(page, "My Song.mp3", [SONG]);
  await renderNow(page);
  assert.equal(page.el("share").hidden, true);
  assert.equal(page.el("fallback").hidden, false);
  assert.equal(page.el("share-status").textContent, "Share sheet: not available");
});

test("a change while the result downloads leaves no stale numbers on the page", async () => {
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const page = await loadApp({ maxClipSeconds: "15", fetch: server(hold), navigator: { canShare: () => true, share: () => Promise.resolve() } });
  await pickFile(page, "My Song.mp3", [SONG]);
  page.el("render").dispatch("click");
  await settle();
  assert.equal(page.fetchCalls.length, 2, "the result fetch should be in flight");
  page.el("name").value = "Another name";
  page.el("name").dispatch("input");
  release(m4a());
  await settle();
  assert.equal(page.el("render-status").textContent, "Changed while rendering. Tap Hear final to render it again.");
  assert.equal(page.el("result-info").hidden, true);
  assert.equal(page.el("deliver").hidden, true);
});
