// ONE-OFF (2026-08-14): the user's Sponza logs `[gi] emitter slot 0 motion
// 0.5-1.0 — pose delta dC≈0.01 dA=0.0000` continuously AT REST, which keeps
// the §12.43 light-track window arming (cap lifted to OFF) and defeats every
// at-rest temporal fix — the residual flicker report. This probe boots the
// REAL project read-only (tauri shim) and answers, with names:
//   1. WHICH mesh/provider sits in each emitter slot;
//   2. what its fitted center actually does over 20s at a parked camera
//      (per-slot dC time series, geometry identity churn);
//   3. whether the static shadow BVH refingerprints/rebuilds while idle
//      (the 262629→262281 tri delta smells like a remeshing text object).
// Delete when the jitter source is fixed.
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
const OUT = ".gi-shots/emitter-jitter";
await mkdir(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
await installTauriShim(page, {});
let built = false;
const giLines = [];
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built/.test(t)) built = true;
  if (/\[gi\] (emitter slot|static shadow bvh|light-track window)/.test(t)) giLines.push(`${new Date().toISOString().slice(11, 23)} ${t}`);
  if (m.type() === "error" && !/favicon|404/.test(t)) console.log(`  console.error: ${t.slice(0, 600)}`);
});
page.on("pageerror", (e) => console.log(`  pageerror: ${String(e.message ?? e).slice(0, 260)}`));
await page.evaluateOnNewDocument((project) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
}, PROJECT);

console.log(`opening ${PROJECT} …`);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
for (let i = 0; i < 240 && !built; i++) await wait(1000);
if (!built) { console.log("FATAL: never built"); await browser.close(); process.exit(1); }
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
const call = (op, args) => page.evaluate(
  async (o, a) => { try { return { ok: true, value: await globalThis.__editorApi.call(o, a) }; } catch (e) { return { ok: false, error: String(e) }; } },
  op, args,
);
// Parked pose, same as the outline repro — comparability + trap 5.
await call("viewport.setCamera", { position: [6.2, 2.09, -0.37], target: [-6, 2, 0] });
console.log("settling out the compile wave…");
await wait(25000);

// ── 1. WHO is seated: names, colors, materials, geometry identity.
const roster = await page.evaluate(() => {
  const api = globalThis.__editorApi;
  const engine = api.entities.live("KT0sShKBX-")?.engine;
  const sys = engine?.modules?.get("gi")?.system;
  if (!sys) return { error: "no gi system" };
  const chain = (o) => { const names = []; for (let n = o; n && names.length < 6; n = n.parent) names.push(n.name || n.type); return names.join(" < "); };
  const infos = (sys._emitterInfos ?? []).map((info, i) => {
    if (!info) return { slot: i, empty: true };
    if (info.provider) return { slot: i, provider: true, shape: (() => { const s = info.provider(); return s ? { c: [s.center.x, s.center.y, s.center.z], r: s.radius } : null; })() };
    const m = info.mesh;
    const mat = Array.isArray(m.material) ? m.material[0] : m.material;
    return {
      slot: i,
      mesh: chain(m),
      meshUuid: m.uuid.slice(0, 8),
      geoUuid: m.geometry?.uuid?.slice(0, 8),
      tris: (m.geometry?.index?.count ?? m.geometry?.attributes?.position?.count ?? 0) / 3,
      visible: m.visible,
      color: [info.r, info.g, info.b].map((v) => +v.toFixed(3)),
      emissiveIntensity: mat?.emissiveIntensity,
      matName: mat?.name,
      matType: mat?.type,
      pos: m.getWorldPosition?.(new (m.position.constructor)())?.toArray?.().map((v) => +v.toFixed(3)),
    };
  });
  const slots = (sys.state?.emitterSlots ?? []).map((s, i) => ({
    slot: i, radius: +s.radius.value.toFixed(4), reff: +s.reff.value.toFixed(4),
    moved: +s.moved.value.toFixed(3), center: s.center.value.toArray().map((v) => +v.toFixed(4)),
  }));
  return { infos, slots, candCount: sys._emitterCands?.length };
});
console.log(`\n=== EMITTER ROSTER ===\n${JSON.stringify(roster, null, 1)}`);

// ── 2. 20s pose watch at ~8Hz, entirely in-page (no round-trip jitter).
console.log("\nsampling slot poses for 20s…");
const series = await page.evaluate(async () => {
  const api = globalThis.__editorApi;
  const engine = api.entities.live("KT0sShKBX-")?.engine;
  const sys = engine?.modules?.get("gi")?.system;
  const slots = sys?.state?.emitterSlots ?? [];
  const infos = () => sys?._emitterInfos ?? [];
  const samples = [];
  const t0 = performance.now();
  await new Promise((done) => {
    const h = setInterval(() => {
      const t = performance.now() - t0;
      samples.push({
        t: Math.round(t),
        slots: slots.map((s, i) => ({
          c: s.center.value.toArray().map((v) => +v.toFixed(5)),
          moved: +s.moved.value.toFixed(3),
          geo: infos()[i]?.mesh?.geometry?.uuid?.slice(0, 8) ?? (infos()[i]?.provider ? "prov" : null),
          mesh: infos()[i]?.mesh?.uuid?.slice(0, 8) ?? null,
        })),
      });
      if (t > 20000) { clearInterval(h); done(); }
    }, 125);
  });
  return samples;
});
// Per-slot summary: dC stats, identity churn.
const n = series.length;
const slotCount = series[0]?.slots.length ?? 0;
console.log(`\n=== 20s POSE WATCH (${n} samples) ===`);
for (let i = 0; i < slotCount; i++) {
  const dCs = [];
  const geos = new Set(); const meshes = new Set();
  let movedMax = 0, movedMean = 0;
  for (let k = 0; k < n; k++) {
    const s = series[k].slots[i];
    geos.add(s.geo); meshes.add(s.mesh);
    movedMax = Math.max(movedMax, s.moved); movedMean += s.moved / n;
    if (k > 0) {
      const p = series[k - 1].slots[i].c;
      dCs.push(Math.hypot(s.c[0] - p[0], s.c[1] - p[1], s.c[2] - p[2]));
    }
  }
  dCs.sort((a, b) => a - b);
  const q = (f) => dCs[Math.min(dCs.length - 1, Math.floor(f * dCs.length))] ?? 0;
  console.log(
    `slot ${i}: dC/sample p50=${q(0.5).toFixed(5)} p90=${q(0.9).toFixed(5)} max=${q(1).toFixed(5)}  ` +
    `moved mean=${movedMean.toFixed(3)} max=${movedMax.toFixed(3)}  geoIds=${[...geos].join(",")}  meshIds=${[...meshes].join(",")}`,
  );
}

// ── 3. What did the console say while we watched?
console.log(`\n=== GI CONSOLE LINES DURING RUN (${giLines.length}) ===`);
for (const l of giLines.slice(-40)) console.log(`  ${l}`);

await page.screenshot({ path: `${OUT}/parked.png` });
console.log(`\nshot → ${OUT}/parked.png`);
await browser.close();
