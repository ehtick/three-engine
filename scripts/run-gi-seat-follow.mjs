// DO EMITTER SEATS FOLLOW THE CAMERA? (2026-08-13, the "after 3-4 emissives
// the rest do not emit any light" report.)
//
// MAX_EMITTERS = 4 analytic slots used to be ranked by raw emitted power, so
// with >4 similar lamps the same four owned every seat forever no matter
// where the player stood — a lamp right in front of the camera stayed dark
// (field-only, ~17% of the energy). #chooseEmitterSeats now scores by
// APPARENT brightness (power / (1+d²) to the active camera) and
// #checkFingerprint re-asks the seating question each 250ms scan.
//
// Rig: 8 IDENTICAL lamps on a ring (equal colour, equal strength — ties are
// exactly the case sticky seats were built for). Three assertions:
//   A  camera parked by one side of the ring → the 4 seated lamps are the 4
//      nearest to the camera;
//   B  camera jumped to the OPPOSITE side → the seats follow within a few
//      scans;
//   C  camera held still for 6s → zero seat changes (the 1.5× hysteresis
//      must kill flapping).
//
//   node node_modules/vite/bin/vite.js --port 5201 --strictPort
//   node scripts/run-gi-seat-follow.mjs
//
// Env: GEN_ROOT, LAMPS=8, SETTLE=6000, SHOT=<dir>, HEADED=1
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { makeEmissiveStormProject, lampRing } from "./lib/makeEmissiveStormProject.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const GEN_ROOT = (process.env.GEN_ROOT ?? path.resolve("scripts/.gi-seat-follow")).replaceAll("\\", "/");
const LAMPS = Number(process.env.LAMPS ?? 8);
const SETTLE = Number(process.env.SETTLE ?? 6000);
const SHOT = process.env.SHOT ?? ".gi-shots/seat-follow";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await makeEmissiveStormProject(GEN_ROOT, {
  lampCount: LAMPS,
  // Static lamps: seat-following is a CPU ranking question; the mover path
  // would only add adoption noise to the boot.
  lampMobility: "static",
  emitStrength: 8,
  gi: { quality: "high" },
});
const HOMES = lampRing(LAMPS);

const chromePath = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"].find((p) => {
  try { return require("node:fs").existsSync(p); } catch { return false; }
}) ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: process.env.HEADED === "1" ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--window-size=1500,1000", "--force-high-performance-gpu"],
  defaultViewport: { width: 1400, height: 900 },
});
const page = await browser.newPage();
await installTauriShim(page, { projectRoot: GEN_ROOT });

let built = false;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built|bright emitters|reseat/i.test(t)) console.log(`  ${t.slice(0, 185)}`);
  if (/\[gi\] built/.test(t)) built = true;
  if (m.type() === "error" && !/favicon|404/.test(t)) console.log(`  console.error: ${t.slice(0, 200)}`);
});
page.on("pageerror", (e) => {
  const msg = e.message ?? String(e);
  if (!/save_scene/.test(msg)) console.log(`  pageerror: ${msg.slice(0, 200)}`);
});

await page.evaluateOnNewDocument((project) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
}, GEN_ROOT);

console.log(`Opening ${GEN_ROOT} …`);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, GEN_ROOT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });

const call = (op, args = {}) =>
  page.evaluate(async ({ op, args }) => {
    try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
    catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
  }, { op, args });
const must = async (op, args) => {
  const r = await call(op, args);
  if (!r.ok) throw new Error(`${op} failed: ${r.error}`);
  return r.value;
};

for (let i = 0; i < 120; i++) {
  const r = await call("entity.list", {});
  if (r.ok && Array.isArray(r.value) && r.value.length > 0) break;
  await wait(1000);
}
for (let i = 0; i < 240 && !built; i++) await wait(1000);
await wait(SETTLE);

// Page-side probe: which ring index does each SEATED mesh sit at?
// Identity by world position against the known homes, same trick as the
// emissive-cost rig (mesh names are useless, transforms live on entities).
const installProbe = await page.evaluate(async (homes) => {
  const api = globalThis.__editorApi;
  let sys = null;
  for (const e of (await api.call("entity.list", {})) ?? []) {
    const s = api.entities.live(e.id)?.engine?.modules?.get("gi")?.system;
    if (s) { sys = s; break; }
  }
  if (!sys) return { error: "no gi system" };
  const V = sys.engine?.scene?.position?.constructor;
  globalThis.__seats = {
    sys,
    read() {
      const wp = (o) => o.getWorldPosition(new V());
      return (this.sys._promotedEmitterMeshes ?? []).map((m) => {
        if (!m) return null;
        const p = wp(m);
        let best = -1, bestD = Infinity;
        homes.forEach((h, i) => {
          const d = Math.hypot(p.x - h[0], p.z - h[2]);
          if (d < bestD) { bestD = d; best = i; }
        });
        return best;
      });
    },
  };
  return { ok: true, cands: sys._emitterCands?.length ?? 0 };
}, HOMES);
if (installProbe.error) { console.log(`FATAL: ${installProbe.error}`); await browser.close(); process.exit(1); }
console.log(`candidates past the gate: ${installProbe.cands} (want ${LAMPS})`);

await mkdir(SHOT, { recursive: true });
const readSeats = () => page.evaluate(() => globalThis.__seats.read());
const nearestTo = (pos, n = 4) =>
  HOMES.map((h, i) => ({ i, d: Math.hypot(pos[0] - h[0], pos[2] - h[2]) }))
    .sort((a, b) => a.d - b.d).slice(0, n).map((e) => e.i);
const fmt = (arr) => JSON.stringify(arr);

// Camera poses sit at an ANGULAR OFFSET from a lamp, never dead-on: dead-on
// is mirror-symmetric, the 4th/5th nearest lamps tie exactly, and the seat
// choice at a tie is arbitrary — the first run failed its assertion on
// exactly that (seats {0,1,2,7} vs an equally-correct nearest4 {0,1,7,6}).
// +15° makes every distance strictly ordered.
const camAt = (index) => {
  const a = ((index / LAMPS) * Math.PI * 2 + Math.PI / LAMPS) + (15 * Math.PI) / 180;
  const r = 4.4 * 1.45;
  return [Math.cos(a) * r, 2.2, Math.sin(a) * r];
};

// A — park just outside the ring by lamp 0, looking across.
const camA = camAt(0);
await must("viewport.setCamera", { position: camA, target: [0, 0.8, 0] });
// Give the 250ms scan a few beats plus one reconcile.
await wait(3000);
const seatsA = await readSeats();
const wantA = nearestTo(camA);
const okA = seatsA.every((s) => s !== null && wantA.includes(s));
console.log(`A  camera by lamp 0: seats ${fmt(seatsA)}  nearest4 ${fmt(wantA)}  ${okA ? "PASS" : "FAIL"}`);
await page.screenshot({ path: path.join(SHOT, "a-near-lamp0.png") });

// B — jump to the OPPOSITE side of the ring.
const oppIndex = Math.floor(LAMPS / 2);
const camB = camAt(oppIndex);
await must("viewport.setCamera", { position: camB, target: [0, 0.8, 0] });
await wait(3000);
const seatsB = await readSeats();
const wantB = nearestTo(camB);
const okB = seatsB.every((s) => s !== null && wantB.includes(s));
const moved = fmt([...seatsA].sort()) !== fmt([...seatsB].sort());
console.log(`B  camera by lamp ${oppIndex}: seats ${fmt(seatsB)}  nearest4 ${fmt(wantB)}  followed=${moved}  ${okB && moved ? "PASS" : "FAIL"}`);
await page.screenshot({ path: path.join(SHOT, "b-near-opposite.png") });

// C — hold still: seats must not flap.
let flaps = 0;
let prev = fmt(seatsB);
for (let i = 0; i < 20; i++) {
  await wait(300);
  const now = fmt(await readSeats());
  if (now !== prev) flaps++;
  prev = now;
}
console.log(`C  still camera 6s: seat changes ${flaps}  ${flaps === 0 ? "PASS" : "FAIL"}`);

const verdict = okA && okB && moved && flaps === 0;
console.log(verdict ? "\nSEAT-FOLLOW: ALL PASS" : "\nSEAT-FOLLOW: FAIL");
await writeFile(path.join(SHOT, "result.json"), JSON.stringify({ seatsA, wantA, seatsB, wantB, flaps, verdict }, null, 2));
await browser.close();
process.exit(verdict ? 0 : 1);
