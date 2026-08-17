// STATIC-SHADOW-BVH INSTRUMENT (session 33) — why the exact-triangle sun
// shadows on the user's real project have HOLES and cost 35ms.
//
// The GPU traversal (`giStaticBvh8` in dynamicObjects.js) carries two silent
// caps: a 1024-pop guard and a 44-entry stack, and BOTH fail OPEN (a ray that
// gives up reports MISS, i.e. LIT). This instrument runs a LINE-FOR-LINE CPU
// mirror of that shader over the REAL packed words the GPU traverses, with
// real sun rays from real surface points, and answers three questions with
// numbers instead of code reading:
//
//   1. LEAK RATE   — how many rays the caps turn from occluded into lit.
//   2. COST        — mean node pops / triangle tests per ray (the GPU's
//                    per-pixel work, and the A/B for the split strategy).
//   3. DEAD ZONE   — how much shadow the voxel-scale tMin throws away (the
//                    exact arm inherited a bias sized for SAT-bulged voxels).
//
// Run:  node scripts/run-gi-static-bvh-probe.mjs
//       STRATEGY=center node scripts/run-gi-static-bvh-probe.mjs   (shipped arm)
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const STRATEGY = process.env.STRATEGY ?? "sah";
const RAYS = Number(process.env.RAYS) || 4000;
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
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
await installTauriShim(page, {});
let built = false;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built|static shadow bvh|light shadows|dynamic-objects/.test(t)) console.log(`  ${t.slice(0, 200)}`);
  if (/\[gi\] built/.test(t)) built = true;
});
page.on("pageerror", (e) => {
  const msg = e.message ?? String(e);
  if (!/save_scene/.test(msg)) console.log(`  pageerror: ${msg.slice(0, 200)}`);
});
await page.evaluateOnNewDocument((PROJECT, STRATEGY) => {
  localStorage.setItem("engine.projectRoot.v1", PROJECT);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([PROJECT]));
  globalThis.__giStaticBvhStrategy = STRATEGY;
  // GISystem drops its CPU-side copy of the packed BVH after upload unless this
  // is set — it is 125-188 MB of dead heap in a normal session. This probe is
  // the one reader, so it asks for the handle explicitly.
  globalThis.__giKeepStaticBvhPacked = true;
}, PROJECT, STRATEGY);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });
for (let i = 0; i < 120 && !built; i++) await wait(1000);
await wait(6000);

console.log(`\n  arm: ${STRATEGY} splits, ${RAYS} sun rays\n`);

const report = await page.evaluate(async (RAYS) => {
  // ── locate the GI system + its packed static BVH ──────────────────────────
  let sys = null;
  let engine = null;
  const list = await globalThis.__editorApi.call("entity.list", {});
  for (const e of list ?? []) {
    const live = globalThis.__editorApi.entities.live(e.id);
    const s = live?.engine?.modules?.get("gi")?.system;
    if (s) { sys = s; engine = live.engine; break; }
  }
  if (!sys) return { error: "no gi system" };
  const packed = sys._staticBvhPacked;
  if (!packed) return { error: "no static bvh packed (arm off?)" };
  const occ = sys.state?.volume?.occupancyField;
  const words = packed.words;
  const f32 = new Float32Array(words.buffer, words.byteOffset, words.length);
  const nodeBase = 0;
  const triBase = packed.nodeWords;

  // ── sun direction: the scene's directional light ──────────────────────────
  let sun = null;
  engine?.scene?.traverse?.((o) => {
    if (!sun && o.isDirectionalLight) sun = o;
  });
  let L = [0.4, 0.85, 0.3];
  if (sun) {
    const p = sun.getWorldPosition(new (sun.position.constructor)());
    const t = sun.target ? sun.target.getWorldPosition(new (sun.position.constructor)()) : { x: 0, y: 0, z: 0 };
    const d = [p.x - t.x, p.y - t.y, p.z - t.z];
    const n = Math.hypot(d[0], d[1], d[2]) || 1;
    L = [d[0] / n, d[1] / n, d[2] / n];
  }

  // ── the shipped biases ────────────────────────────────────────────────────
  // occ.voxel is a TSL uniform NODE — the numbers live on `.value` (reading
  // `.x` off the node gives a node, which turns tMin into NaN and makes every
  // slab test pass; the first run of this probe measured exactly that).
  const vx = occ?.voxel?.value;
  const voxMax = vx ? Math.max(vx.x, vx.y, vx.z) : 0;
  if (!(voxMax > 0)) return { error: "no numeric voxel size", voxel: String(occ?.voxel?.value) };
  const lift = voxMax * 1.5;

  // ── CPU mirror of giStaticBvh8 (caps are parameters, mask ignored: the
  //    probe runs with nothing adopted, so every bit is 0) ──────────────────
  const nz = (x) => (Math.abs(x) < 1e-9 ? (x >= 0 ? 1e-9 : -1e-9) : x);
  function trace(ro, rd, tMin, tMax, guardCap, stackCap, anyHit) {
    const stack = new Int32Array(Math.max(stackCap + 8, 64));
    let sp = 0;
    stack[0] = 1;
    let bestT = tMax;
    let found = false;
    const inv = [1 / nz(rd[0]), 1 / nz(rd[1]), 1 / nz(rd[2])];
    let guard = 0;
    let pops = 0;
    let triTests = 0;
    let maxSp = 0;
    let capped = false;
    const ct = new Float64Array(8);
    const cr = new Int32Array(8);
    while (sp >= 0) {
      if (guard > guardCap) { capped = true; break; }
      guard++;
      const nref = stack[sp] >>> 0;
      sp--;
      pops++;
      if (nref === 0) continue;
      if (nref & 0x80000000) {
        const triStart = nref & 0x00ffffff;
        const triCount = (nref >>> 24) & 0x7f;
        for (let j = 0; j < triCount; j++) {
          const tw = triBase + (triStart + j) * 10;
          triTests++;
          const ax = f32[tw], ay = f32[tw + 1], az = f32[tw + 2];
          const bx = f32[tw + 3], by = f32[tw + 4], bz = f32[tw + 5];
          const cx = f32[tw + 6], cy = f32[tw + 7], cz = f32[tw + 8];
          const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
          const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
          const hx = rd[1] * e2z - rd[2] * e2y, hy = rd[2] * e2x - rd[0] * e2z, hz = rd[0] * e2y - rd[1] * e2x;
          const det = e1x * hx + e1y * hy + e1z * hz;
          if (Math.abs(det) < 1e-10) continue;
          const invDet = 1 / det;
          const sx = ro[0] - ax, sy = ro[1] - ay, sz = ro[2] - az;
          const u = (sx * hx + sy * hy + sz * hz) * invDet;
          const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
          const v = (rd[0] * qx + rd[1] * qy + rd[2] * qz) * invDet;
          const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
          if (u >= -1e-4 && v >= -1e-4 && u + v <= 1.0001 && t > tMin && t < bestT) {
            bestT = t;
            found = true;
            if (anyHit) return { t: bestT, found, pops, triTests, maxSp, capped };
          }
        }
        continue;
      }
      const nb = nodeBase + (nref - 1) * 28;
      const ox = f32[nb], oy = f32[nb + 1], oz = f32[nb + 2];
      const ep = words[nb + 3];
      const sx = 2 ** ((ep & 0xff) - 128);
      const sy = 2 ** (((ep >>> 8) & 0xff) - 128);
      const sz = 2 ** (((ep >>> 16) & 0xff) - 128);
      let cn = 0;
      for (let ci = 0; ci < 8; ci++) {
        const cref = words[nb + 4 + ci] >>> 0;
        if (cref === 0) continue;
        const qa = words[nb + 12 + ci * 2] >>> 0;
        const qb = words[nb + 13 + ci * 2] >>> 0;
        const bminx = ox + (qa & 0xff) * sx, bminy = oy + ((qa >>> 8) & 0xff) * sy, bminz = oz + ((qa >>> 16) & 0xff) * sz;
        const bmaxx = ox + ((qa >>> 24) & 0xff) * sx, bmaxy = oy + (qb & 0xff) * sy, bmaxz = oz + ((qb >>> 8) & 0xff) * sz;
        const t0x = (bminx - ro[0]) * inv[0], t1x = (bmaxx - ro[0]) * inv[0];
        const t0y = (bminy - ro[1]) * inv[1], t1y = (bmaxy - ro[1]) * inv[1];
        const t0z = (bminz - ro[2]) * inv[2], t1z = (bmaxz - ro[2]) * inv[2];
        const te = Math.max(Math.min(t0x, t1x), Math.min(t0y, t1y), Math.min(t0z, t1z), tMin);
        const tx = Math.min(Math.max(t0x, t1x), Math.max(t0y, t1y), Math.max(t0z, t1z), bestT);
        if (tx < te) continue;
        ct[cn] = te;
        cr[cn] = cref | 0;
        cn++;
      }
      for (let ai = 1; ai < cn; ai++) {
        const kt = ct[ai], kr = cr[ai];
        let bi = ai - 1;
        while (bi >= 0 && ct[bi] > kt) { ct[bi + 1] = ct[bi]; cr[bi + 1] = cr[bi]; bi--; }
        ct[bi + 1] = kt;
        cr[bi + 1] = kr;
      }
      for (let pi = cn - 1; pi >= 0; pi--) {
        if (sp >= stackCap - 1) { capped = true; break; }
        sp++;
        stack[sp] = cr[pi];
        if (sp > maxSp) maxSp = sp;
      }
    }
    return { t: found ? bestT : -1, found, pops, triTests, maxSp, capped };
  }

  // ── ray set: real surface points, light-facing, lifted like the resolve ───
  let seed = 0x13579bd;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const triCount = packed.triCount;
  // Scene extent, for the ray length and the dead-zone scale.
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let t = 0; t < triCount; t += 7) {
    for (let k = 0; k < 3; k++) {
      const o = triBase + t * 10 + k * 3;
      mnx = Math.min(mnx, f32[o]); mxx = Math.max(mxx, f32[o]);
      mny = Math.min(mny, f32[o + 1]); mxy = Math.max(mxy, f32[o + 1]);
      mnz = Math.min(mnz, f32[o + 2]); mxz = Math.max(mxz, f32[o + 2]);
    }
  }
  const span = Math.hypot(mxx - mnx, mxy - mny, mxz - mnz);

  const rays = [];
  let guardTries = 0;
  while (rays.length < RAYS && guardTries < RAYS * 40) {
    guardTries++;
    const t = Math.min(triCount - 1, Math.floor(rand() * triCount));
    const o = triBase + t * 10;
    const ax = f32[o], ay = f32[o + 1], az = f32[o + 2];
    const bx = f32[o + 3], by = f32[o + 4], bz = f32[o + 5];
    const cx = f32[o + 6], cy = f32[o + 7], cz = f32[o + 8];
    const e1 = [bx - ax, by - ay, bz - az];
    const e2 = [cx - ax, cy - ay, cz - az];
    let nx = e1[1] * e2[2] - e1[2] * e2[1];
    let ny = e1[2] * e2[0] - e1[0] * e2[2];
    let nz2 = e1[0] * e2[1] - e1[1] * e2[0];
    const nl = Math.hypot(nx, ny, nz2);
    if (!(nl > 1e-12)) continue;
    nx /= nl; ny /= nl; nz2 /= nl;
    let d = nx * L[0] + ny * L[1] + nz2 * L[2];
    if (Math.abs(d) < 0.05) continue; // grazing to the sun — the resolve gates these out
    if (d < 0) { nx = -nx; ny = -ny; nz2 = -nz2; d = -d; }
    const P = [(ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3];
    rays.push({ P, N: [nx, ny, nz2] });
  }

  // ── measure ───────────────────────────────────────────────────────────────
  const GUARD = 1024, STACK = 44;
  let leaks = 0, guardCapped = 0, stackCapped = 0, occluded = 0;
  let popSum = 0, popMax = 0, triSum = 0, spMax = 0;
  let deadZone = 0, deadZoneOfOccluded = 0;
  let anyPopSum = 0, anyTriSum = 0;
  const popHist = new Array(12).fill(0);
  const t0 = performance.now();
  for (const r of rays) {
    const ro = [r.P[0] + r.N[0] * lift, r.P[1] + r.N[1] * lift, r.P[2] + r.N[2] * lift];
    const capped = trace(ro, L, voxMax, span, GUARD, STACK, false);
    const truth = trace(ro, L, voxMax, span, 1e9, 4096, false);
    // ANY-HIT arm: what a shadow ray actually needs (visibility, not the
    // nearest surface). Same tree, same order — only the early-out differs.
    const anyHit = trace(ro, L, voxMax, span, 1e9, 4096, true);
    anyPopSum += anyHit.pops;
    anyTriSum += anyHit.triTests;
    popSum += capped.pops;
    triSum += capped.triTests;
    popMax = Math.max(popMax, capped.pops);
    spMax = Math.max(spMax, capped.maxSp);
    popHist[Math.min(11, Math.floor(Math.log2(Math.max(1, capped.pops))))]++;
    if (capped.capped) {
      if (capped.pops > GUARD) guardCapped++; else stackCapped++;
    }
    if (truth.found) {
      occluded++;
      if (!capped.found) leaks++;
    }
    // DEAD ZONE: the same ray with a hair-thin tMin. Origin is already lifted
    // ALONG the light-facing normal and the ray travels away from its own
    // plane (|N·L| > 0.05 filter), so a self-hit is geometrically impossible.
    const near = trace(ro, L, 1e-4, span, 1e9, 4096, true);
    if (near.found && !truth.found) deadZone++;
    if (near.found && near.t < voxMax) deadZoneOfOccluded++;
  }
  const ms = performance.now() - t0;

  // ── tree shape ────────────────────────────────────────────────────────────
  const nodeCount = packed.nodeWords / 28;
  let leafRefs = 0, leafTris = 0, emptySlots = 0;
  for (let n = 0; n < nodeCount; n++) {
    for (let c = 0; c < 8; c++) {
      const ref = words[n * 28 + 4 + c] >>> 0;
      if (ref === 0) { emptySlots++; continue; }
      if (ref & 0x80000000) { leafRefs++; leafTris += (ref >>> 24) & 0x7f; }
    }
  }

  return {
    triCount, nodeCount, leafRefs,
    avgLeafTris: +(leafTris / Math.max(1, leafRefs)).toFixed(2),
    emptySlotPct: +(100 * emptySlots / (nodeCount * 8)).toFixed(1),
    sceneSpan: +span.toFixed(2),
    voxMax: +voxMax.toFixed(4),
    lift: +lift.toFixed(4),
    sunDir: L.map((v) => +v.toFixed(3)),
    rays: rays.length,
    occluded,
    leaks,
    leakPctOfOccluded: +(100 * leaks / Math.max(1, occluded)).toFixed(2),
    guardCapped,
    stackCapped,
    cappedPct: +(100 * (guardCapped + stackCapped) / Math.max(1, rays.length)).toFixed(2),
    meanPops: +(popSum / Math.max(1, rays.length)).toFixed(1),
    meanTriTests: +(triSum / Math.max(1, rays.length)).toFixed(1),
    meanPopsAnyHit: +(anyPopSum / Math.max(1, rays.length)).toFixed(1),
    meanTriTestsAnyHit: +(anyTriSum / Math.max(1, rays.length)).toFixed(1),
    maxPops: popMax,
    maxStackDepth: spMax,
    popHistLog2: popHist,
    deadZoneLostShadows: deadZone,
    deadZonePct: +(100 * deadZone / Math.max(1, rays.length)).toFixed(2),
    nearHitsInsideTMin: deadZoneOfOccluded,
    cpuMs: Math.round(ms),
  };
}, RAYS);

console.log(JSON.stringify(report, null, 2));
await browser.close();
