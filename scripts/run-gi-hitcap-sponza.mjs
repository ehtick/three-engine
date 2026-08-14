// ONE-OFF (2026-08-13): price the reflection-hit emitter march on the REAL
// Sponza project, cap-off vs cap-4m (`__giHitEmitterMarchCap`), headless via
// the tauri shim (read-only — entities are created in-page and never saved).
// The storm rig cannot answer this: its room is small, so marches are short
// and the length cap never binds; Sponza's atrium is where the cost lives.
//   node node_modules/vite/bin/vite.js --port 5201 --strictPort
//   CAP=0 node scripts/run-gi-hitcap-sponza.mjs   (arm A: gate only)
//   CAP=4 node scripts/run-gi-hitcap-sponza.mjs   (arm B: gate + 4m cap)
// Delete when §12.56's follow-up lands.
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
const CAP = Number(process.env.CAP ?? 4);
// SCALE overrides __giHitEmitterTraceScale (1e9 = trace nothing at hits =
// fully unshadowed emitter direct in reflections — the cost ceiling arm).
const SCALE = process.env.SCALE ? Number(process.env.SCALE) : null;
const SHOT = process.env.SHOT ?? "";
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
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built/.test(t)) built = true;
  if (/exact reflections|emitter slot|compile wave: materials/.test(t)) console.log(`  ${t.slice(0, 140)}`);
  if (m.type() === "error" && !/favicon|404/.test(t)) console.log(`  console.error: ${t.slice(0, 180)}`);
});
await page.evaluateOnNewDocument((project, cap, scale) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__giHitEmitterMarchCap = cap;
  if (scale != null) globalThis.__giHitEmitterTraceScale = scale;
}, PROJECT, CAP, SCALE);

console.log(`ARM CAP=${CAP} — opening ${PROJECT} …`);
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
// Same pose as the live MCP repro, so numbers compare.
await call("viewport.setCamera", { position: [6.2, 2.09, -0.37], target: [-6, 2, 0] });
console.log("built — settling for the compile wave…");
await wait(25000);

const spheres = [
  { name: "HitCapProbe_A", position: [2, 1.6, -0.3] },
  { name: "HitCapProbe_B", position: [-1.5, 1.2, 1.2] },
  { name: "HitCapProbe_C", position: [-4.5, 2.2, -1.4] },
];
for (const s of spheres) {
  const r = await call("entity.create", {
    name: s.name,
    transform: { position: s.position, scale: [0.4, 0.4, 0.4] },
    components: [{ type: "mesh", props: { geometry: "sphere", material: `${PROJECT}/materials/CannonBall.mat` } }],
  });
  if (!r.ok) console.log(`  entity.create failed: ${r.error}`);
}
console.log("3 emissive spheres in — waiting out the emitter marcher compile…");
await wait(30000);
const prof = await call("profile.giPasses", { samples: 40 });
if (!prof.ok) { console.log(`giPasses failed: ${prof.error}`); await browser.close(); process.exit(1); }
const p = prof.value;
console.log(`\nARM CAP=${CAP}  emitters=${p.emitters}  resolve px ${p.pixels?.resolve?.join("x")}`);
console.log(`  resolve            ${p.screenPassesMs?.resolve}`);
console.log(`  emitterShadowPass  ${p.screenPassesMs?.emitterShadowPass}`);
console.log(`  screenTotalMs      ${p.screenTotalMs}`);
console.log(`  srcTotalMs         ${p.srcProbes?.totalMs}`);
if (SHOT) {
  await wait(4000);
  await page.screenshot({ path: SHOT });
  console.log(`  shot → ${SHOT}`);
}
await browser.close();
