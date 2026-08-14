// §12.70 W4a — THE MANY-EMITTER BASELINE LEDGER.
//
// Records what the screen chain's 4-seat emitter model does as lamp count
// scales past MAX_EMITTERS: per-pass GPU cost (emitterShadowPass, resolve),
// canvas energy, seats vs tree emitter count. This is the baseline every W4
// candidate (per-tile top-K cut first) is judged against — and the record of
// today's failure mode: cost pinned by the 4-seat cap while the un-seated
// lamps' DIRECT light simply never renders (their indirect reaches [J] only
// through W3's tree, behind its hatch).
//
// No PASS/FAIL beyond sanity (built, ticking, tree sees all N): a baseline is
// a recording, not a gate.
//
//   node scripts/run-gi-emitter-scale.mjs      (vite on :5201)
//   LAMPS=4,12 SETTLE=22000 TREE=0|1           (dials; TREE arms the W3 hatch)
//   TILECUT=1 · AB=1 · SEAM=1                  (W4b slice gates, see below)
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { makeEmissiveStormProject } from "./lib/makeEmissiveStormProject.mjs";
import { readLightTree, emitterImportance } from "../src/modules/gi/lightTree.js";

const url = process.argv[2] ?? "http://localhost:5201/";
const LAMPS = (process.env.LAMPS ?? "4,12").split(",").map((s) => Number(s.trim()));
const SETTLE = Number(process.env.SETTLE ?? 22000);
const TREE = process.env.TREE === "1";
// TILECUT=1 (§12.70 W4b slice-i gate): boot with `__giEmitterTileCut`, read
// the tile buffers back, and diff every valid tile's kept SET against the
// CPU's `emitterImportance` ranking at the same reconstructed (P, N).
const TILECUT = process.env.TILECUT === "1";
// AB=1 (§12.70 W4b slice-ii gate): per lamp count, run hatch-OFF then
// hatch-ON in one invocation. Verdicts: N=4 PARITY (tile lists ≡ the global
// seats where sets coincide — energy within 5%) and N=12 RECOVERY (the
// un-seated lamps' direct returns — energy must RISE), plus the slice-i
// set verification re-run with the consumers live.
// SEAM=1 (§12.70 W4b seam imaging): implies AB. Adjacent tiles that keep
// DIFFERENT emitter sets are where the packed shadow texture's channel
// meaning changes mid-filter-kernel — the one place the cut could imprint
// the tile grid on the image. Per arm the rig records per-column/per-row
// luminance + gradient profiles of the canvas; Node folds them at the EXACT
// tile pitch in canvas px (8·canvasW/emitterW — the resolve res cancels) and
// compares against an incommensurate-pitch control fold: a grid-locked
// ripple beats its control, content noise doesn't. Eyes get PNGs: the same
// centre rect from both arms plus a ×6 crop at the most-different boundary
// (red ticks mark the boundary line). Soft gate on the arm-vs-arm excess.
const SEAM = process.env.SEAM === "1";
const AB = process.env.AB === "1" || SEAM;
const OUT = ".gi-shots/emitter-scale";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});

async function runArm(lamps, cutOn = TILECUT) {
  const genRoot = path.resolve(`scripts/.gi-emitter-scale-${lamps}`).replaceAll("\\", "/");
  await makeEmissiveStormProject(genRoot, {
    lampCount: lamps, lampMobility: "static", emitStrength: 8, enclosed: true, gi: { quality: "high" },
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  await installTauriShim(page, {});
  let built = false;
  let seatsLine = "";
  let cutLine = "";
  page.on("console", (m) => {
    const t = m.text();
    if (/\[gi\] built/.test(t)) built = true;
    if (/bright emitters/i.test(t)) seatsLine = t;
    if (/\[gi\] emitter tile cut:/.test(t)) cutLine = t;
  });
  page.on("pageerror", (e) => {
    const msg = e.message ?? String(e);
    if (!/save_scene/.test(msg)) console.log(`  pageerror: ${msg.slice(0, 200)}`);
  });
  await page.evaluateOnNewDocument((project, treeOn, cutOn) => {
    localStorage.setItem("engine.projectRoot.v1", project);
    localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
    globalThis.__editorKeepRendering = true;
    if (treeOn) globalThis.__giSrcLightTree = true;
    if (cutOn) globalThis.__giEmitterTileCut = true;
  }, genRoot, TREE, cutOn);
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
  await page.evaluate((project) => {
    const rows = [...document.querySelectorAll(".hub-recent")];
    const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
    row?.querySelector(".hub-recent-open-btn")?.click();
  }, genRoot);
  for (let i = 0; i < 180 && !built; i++) await wait(1000);
  if (!built) throw new Error(`lamps=${lamps}: never built`);
  await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
  // §12.66 rule: judge frames only from a known pose — and the pose must be
  // INSIDE the room. The first N=12 pose pulled back to z=7.4 "for the wider
  // ring" and exited through the near wall (half = floorSize/2 = 7.05): every
  // ledger number at that pose was the box's EXTERIOR — no emitter light, all
  // receivers back-facing, importance ties collapsing to {0,1,2,3}. The P
  // spread the rig now prints is the instrument that caught it.
  await page.evaluate(async () => {
    await globalThis.__editorApi.call("viewport.setCamera", {
      position: [0, 1.9, 6.2], target: [0, 0.8, -2],
    });
  });
  await wait(SETTLE);

  const prof = await page.evaluate(async () => {
    const api = globalThis.__editorApi;
    const r = await api.call("profile.giPasses", { samples: 40 });
    return r?.value ?? r;
  });
  const shot = await page.evaluate(async (seamOn) => {
    const api = globalThis.__editorApi;
    const ids = await api.call("entity.list", {});
    const anyId = (ids.value ?? ids)?.[0]?.id;
    const engine = api.entities.live(anyId)?.engine;
    return await new Promise((resolve) => {
      let n = 0;
      const off = engine.onPostRender(() => {
        if (++n < 2) return;
        off();
        const src = engine.renderer.domElement;
        const c = document.createElement("canvas");
        c.width = src.width; c.height = src.height;
        const ctx = c.getContext("2d");
        ctx.drawImage(src, 0, 0);
        const x0 = Math.floor(c.width * 0.2), y0 = Math.floor(c.height * 0.2);
        const w = Math.floor(c.width * 0.6), h = Math.floor(c.height * 0.6);
        const d = ctx.getImageData(x0, y0, w, h).data;
        let lum = 0, lumTop = 0, lumBot = 0;
        const rowBytes = w * 4, third = Math.floor(h / 3);
        for (let i = 0; i < d.length; i += 4) {
          const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
          lum += l;
          const row = Math.floor(i / rowBytes);
          if (row < third) lumTop += l;
          else if (row >= h - third) lumBot += l;
        }
        const px3 = third * w;
        // SEAM raw: per-column / per-row mean luminance and mean forward
        // gradient over the same crop. gradCol[x] is the step BETWEEN canvas
        // columns x0+x and x0+x+1 — its global boundary position is x0+x+0.5.
        // The fold/boundary math stays in Node (pitch needs emitterW, which
        // only the ON arm's live handle knows).
        let seam = null;
        if (seamOn) {
          const lums = new Float32Array(w * h);
          for (let p = 0, i = 0; p < lums.length; p++, i += 4) {
            lums[p] = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
          }
          const gradCol = new Array(w).fill(0), gradRow = new Array(h).fill(0);
          const colLum = new Array(w).fill(0), rowLum = new Array(h).fill(0);
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const l = lums[y * w + x];
              colLum[x] += l; rowLum[y] += l;
              if (x + 1 < w) gradCol[x] += Math.abs(lums[y * w + x + 1] - l);
              if (y + 1 < h) gradRow[y] += Math.abs(lums[(y + 1) * w + x] - l);
            }
          }
          for (let x = 0; x < w; x++) { colLum[x] /= h; gradCol[x] /= h; }
          for (let y = 0; y < h; y++) { rowLum[y] /= w; gradRow[y] /= w; }
          seam = { x0, y0, w, h, canvasW: c.width, canvasH: c.height, gradCol, gradRow, colLum, rowLum };
        }
        resolve({
          meanLum: +(lum / (d.length / 4) / 255).toFixed(4),
          lumTop: +(lumTop / px3 / 255).toFixed(4),
          lumBot: +(lumBot / px3 / 255).toFixed(4),
          seam,
          treeLive: globalThis.__giLightTreeLive
            ? { emitters: globalThis.__giLightTreeLive.emitterCount, words: globalThis.__giLightTreeLive.words }
            : null,
        });
      });
    });
  }, SEAM);
  let cut = null;
  if (cutOn) {
    cut = await page.evaluate(async () => {
      const live = globalThis.__giTileCutLive;
      const treeLive = globalThis.__giLightTreeLive;
      if (!live || !treeLive) return { fail: `tileCutLive=${!!live} treeLive=${!!treeLive}` };
      const api = globalThis.__editorApi;
      const ids = await api.call("entity.list", {});
      const anyId = (ids.value ?? ids)?.[0]?.id;
      const engine = api.entities.live(anyId)?.engine;
      const gi = engine?.modules?.get?.("gi")?.system;
      const renderer = engine?.renderer;
      const bits = gi?.state?.volume?.occupancyField?.bitsBuffer;
      if (!bits || !renderer) return { fail: "no bits buffer / renderer" };
      // Whole-buffer reads + slice — the honest read (the W1 gate's
      // duplicate-three trap: an in-page TSL copy kernel renders zeros).
      const pos = Array.from(new Float32Array(await renderer.getArrayBufferAsync(live.posBuf.value)));
      const tileIds = Array.from(new Uint32Array(await renderer.getArrayBufferAsync(live.idBuf.value)));
      const all = new Uint32Array(await renderer.getArrayBufferAsync(bits.value));
      const abs = treeLive.abs >>> 0;
      const words = Array.from(all.subarray(abs, abs + treeLive.words));
      return {
        tilesX: live.tilesX, tilesY: live.tilesY,
        emitterW: live.emitterW ?? live.tilesX * (live.tileSize ?? 8),
        emitterH: live.emitterH ?? live.tilesY * (live.tileSize ?? 8),
        pos, tileIds, words,
      };
    });
  }
  // ── SEAM crops: same centre rect in BOTH arms (deterministic from canvas
  // dims); ON arm adds a ×6 crop at the most-different adjacent-tile boundary
  // (census over the idBuf just read). Captured inside onPostRender — a
  // WebGPU canvas read outside the frame callback is a blank buffer.
  let seamCrops = null, seamCensus = null;
  if (SEAM && shot.seam) {
    const { canvasW, canvasH } = shot.seam;
    const rects = [{
      name: `centre-${lamps}-${cutOn ? "on" : "off"}`,
      x: Math.floor(canvasW * 0.34), y: Math.floor(canvasH * 0.36),
      w: Math.floor(canvasW * 0.22), h: Math.floor(canvasH * 0.22), zoom: 3,
    }];
    if (cutOn && cut && !cut.fail) {
      const EMPTY = 0xffffffff;
      const setOf = (t) => cut.tileIds.slice(t * 4, t * 4 + 4).filter((i) => i !== EMPTY);
      const valid = (t) => cut.pos[t * 8 + 3] > 0.5;
      const symDiff = (a, b) => a.filter((x) => !b.includes(x)).length + b.filter((x) => !a.includes(x)).length;
      let hPairs = 0, hDiffer = 0, hDiffSum = 0, vPairs = 0, vDiffer = 0, vDiffSum = 0, best = null;
      for (let ty = 0; ty < cut.tilesY; ty++) {
        for (let tx = 0; tx < cut.tilesX; tx++) {
          const t = ty * cut.tilesX + tx;
          if (!valid(t)) continue;
          const a = setOf(t);
          if (tx + 1 < cut.tilesX && valid(t + 1)) {
            const d = symDiff(a, setOf(t + 1));
            hPairs++;
            if (d > 0) {
              hDiffer++; hDiffSum += d;
              const cd = Math.hypot(tx + 0.5 - cut.tilesX / 2, ty - cut.tilesY / 2);
              if (!best || d > best.d || (d === best.d && cd < best.cd)) best = { tx, ty, d, cd, dir: "h" };
            }
          }
          if (ty + 1 < cut.tilesY && valid(t + cut.tilesX)) {
            const d = symDiff(a, setOf(t + cut.tilesX));
            vPairs++;
            if (d > 0) { vDiffer++; vDiffSum += d; }
          }
        }
      }
      seamCensus = {
        hPairs, hDiffer, vPairs, vDiffer,
        hMeanDiff: hDiffer ? +(hDiffSum / hDiffer).toFixed(2) : 0,
        vMeanDiff: vDiffer ? +(vDiffSum / vDiffer).toFixed(2) : 0,
        best: best ? `h-boundary tile (${best.tx}|${best.tx + 1},${best.ty}) Δset ${best.d}` : "none differ",
      };
      if (best) {
        const bx = (best.tx + 1) * 8 * canvasW / cut.emitterW;
        const by = (best.ty + 0.5) * 8 * canvasH / cut.emitterH;
        rects.push({
          name: `boundary-${lamps}-on`,
          x: Math.max(0, Math.min(canvasW - 80, Math.round(bx - 40))),
          y: Math.max(0, Math.min(canvasH - 120, Math.round(by - 60))),
          w: 80, h: 120, zoom: 6, tickX: bx,
        });
      }
    }
    seamCrops = await page.evaluate(async (rects) => {
      const api = globalThis.__editorApi;
      const ids = await api.call("entity.list", {});
      const anyId = (ids.value ?? ids)?.[0]?.id;
      const engine = api.entities.live(anyId)?.engine;
      return await new Promise((resolve) => {
        const off = engine.onPostRender(() => {
          off();
          const src = engine.renderer.domElement;
          const out = {};
          for (const r of rects) {
            const c = document.createElement("canvas");
            c.width = r.w * r.zoom; c.height = r.h * r.zoom;
            const ctx = c.getContext("2d");
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
            if (r.tickX != null) {
              const tx = Math.round((r.tickX - r.x) * r.zoom);
              ctx.fillStyle = "#f00";
              ctx.fillRect(tx, 0, 2, 14);
              ctx.fillRect(tx, c.height - 14, 2, 14);
            }
            out[r.name] = c.toDataURL("image/png");
          }
          resolve(out);
        });
      });
    }, rects);
  }
  await page.screenshot({ path: `${OUT}/lamps-${lamps}${TREE ? "-tree" : ""}${cutOn ? "-cut" : ""}.png` });
  await page.close();

  // ── the CPU mirror (§12.70 W4b slice-i gate) ──────────────────────────────
  // Same strict-> semantics as the kernel's insertion: ids ascending, a tie
  // keeps the earlier id — (imp desc, id asc) sort is that exact order. The
  // near-tie band absorbs f32-vs-f64 flips AT THE 4TH-PLACE BOUNDARY only; a
  // wrong word offset or a broken sort has no boundary to hide behind.
  let cutVerdict = null;
  if (cutOn && cut && !cut.fail) {
    const view = readLightTree(Uint32Array.from(cut.words), 0);
    const EMPTY = 0xffffffff;
    const tiles = cut.tilesX * cut.tilesY;
    let structuralBad = 0, validTiles = 0, matched = 0, tieTolerated = 0, hardBad = 0;
    let worst = "";
    for (let t = 0; t < tiles; t++) {
      const ids4 = cut.tileIds.slice(t * 4, t * 4 + 4);
      const nonEmpty = ids4.filter((i) => i !== EMPTY);
      const ascending = nonEmpty.every((v, i, a) => i === 0 || a[i - 1] < v);
      const inRange = nonEmpty.every((i) => i < view.emitterCount);
      const emptiesLast = ids4.slice(nonEmpty.length).every((i) => i === EMPTY);
      if (!ascending || !inRange || !emptiesLast) { structuralBad++; continue; }
      const valid = cut.pos[t * 8 + 3] > 0.5;
      if (!valid) { if (nonEmpty.length) structuralBad++; continue; }
      validTiles++;
      const P = [cut.pos[t * 8], cut.pos[t * 8 + 1], cut.pos[t * 8 + 2]];
      const N = [cut.pos[t * 8 + 4], cut.pos[t * 8 + 5], cut.pos[t * 8 + 6]];
      const imps = [];
      for (let id = 0; id < view.emitterCount; id++) imps.push(emitterImportance(view, id, P, N));
      const rank = imps.map((imp, id) => ({ imp, id })).filter((e) => e.imp > 0)
        .sort((a, b) => b.imp - a.imp || a.id - b.id);
      const cpuSet = rank.slice(0, 4).map((e) => e.id).sort((a, b) => a - b);
      if (cpuSet.length === nonEmpty.length && cpuSet.every((v, i) => v === nonEmpty[i])) { matched++; continue; }
      const cutoff = rank[Math.min(3, rank.length - 1)]?.imp ?? 0;
      const disputed = [
        ...cpuSet.filter((i) => !nonEmpty.includes(i)),
        ...nonEmpty.filter((i) => !cpuSet.includes(i)),
      ];
      const nearTie = disputed.length > 0 && disputed.every(
        (id) => Math.abs(imps[id] - cutoff) <= Math.max(cutoff, 1e-12) * 2e-3,
      );
      if (nearTie) tieTolerated++;
      else {
        hardBad++;
        if (!worst) {
          worst = `tile ${t}: gpu [${nonEmpty}] cpu [${cpuSet}] disputed ` +
            disputed.map((d) => `${d}:${imps[d].toExponential(2)}`).join(" ") +
            ` cutoff ${cutoff.toExponential(2)}`;
        }
      }
    }
    // Which emitters the lists actually USE — 4 unique ids across all tiles
    // means the per-tile ranking degenerated to one global answer (dark
    // records? camera crop?), which is exactly the inert-recovery signature.
    const idHist = new Map();
    for (let t = 0; t < tiles; t++) {
      for (const i of cut.tileIds.slice(t * 4, t * 4 + 4)) {
        if (i !== EMPTY) idHist.set(i, (idHist.get(i) ?? 0) + 1);
      }
    }
    const power = Array.from({ length: view.emitterCount }, (_, i) => +view.emitter(i).power.toFixed(3));
    // P-spread across valid tiles — a collapsed spread means the gbuffer
    // reconstruction is broken and every ranking above is circularly "ok".
    const pmin = [Infinity, Infinity, Infinity], pmax = [-Infinity, -Infinity, -Infinity];
    for (let t = 0; t < tiles; t++) {
      if (cut.pos[t * 8 + 3] <= 0.5) continue;
      for (let k = 0; k < 3; k++) {
        const v = cut.pos[t * 8 + k];
        if (v < pmin[k]) pmin[k] = v;
        if (v > pmax[k]) pmax[k] = v;
      }
    }
    cutVerdict = {
      tiles, validTiles, matched, tieTolerated, hardBad, structuralBad, worst,
      uniqueIds: idHist.size,
      pSpread: pmin.map((v, k) => `${v.toFixed(2)}..${pmax[k].toFixed(2)}`).join(" "),
      idHist: [...idHist.entries()].sort((a, b) => b[1] - a[1]).map(([i, n]) => `${i}:${n}`).join(" "),
      recordPower: power.join(","),
    };
  } else if (cutOn) {
    cutVerdict = { fail: cut?.fail ?? "no readback" };
  }

  const passes = { ...(prof?.screenPassesMs ?? {}), ...(prof?.queueMs ?? {}) };
  const pick = (re) => {
    for (const [k, v] of Object.entries(passes)) if (re.test(k)) return typeof v === "number" ? +v.toFixed(2) : v?.ms ?? v?.avg ?? null;
    return null;
  };
  if (seamCrops) {
    for (const [name, url] of Object.entries(seamCrops)) {
      writeFileSync(`${OUT}/seam-${name}.png`, Buffer.from(url.split(",")[1], "base64"));
    }
  }
  return {
    lamps,
    cutOn,
    emitterShadowMs: pick(/emitterShadow/i),
    resolveMs: pick(/^resolve$|giResolve/i),
    totalMs: prof?.screenTotalMs ?? null,
    meanLum: shot.meanLum,
    lumTop: shot.lumTop,
    lumBot: shot.lumBot,
    seamRaw: shot.seam ?? null,
    seamDims: cut && !cut.fail ? { emitterW: cut.emitterW, emitterH: cut.emitterH } : null,
    seamCensus,
    treeEmitters: shot.treeLive?.emitters ?? -1,
    seatsLine: seatsLine.slice(0, 120),
    cutLine: cutLine.slice(0, 120),
    cutVerdict,
    rawKeys: Object.keys(passes).slice(0, 20),
  };
}

// ── SEAM statistics (Node side) ──────────────────────────────────────────────
// Boundary/interior gradient excess + a pitch-folded high-passed luminance
// profile. Each is computed twice: at the TRUE tile pitch and at an
// incommensurate control pitch (×1.37) — the control is the statistic's own
// noise floor in the same image. A grid-locked seam beats its control at the
// true pitch only; content edges land anywhere and beat neither.
function seamAxisStats(grad, lum, offset, pitch) {
  const one = (p) => {
    const n = grad.length;
    const bset = new Set(), nearSet = new Set();
    for (let k = 1; k * p < offset + n + 2; k++) {
      const li = k * p - offset - 0.5; // gradCol[i] sits at global offset+i+0.5
      if (li < -2 || li > n + 1) continue;
      for (const i of [Math.floor(li), Math.ceil(li)]) {
        if (i >= 0 && i < n && Math.abs(i - li) <= 1.5) bset.add(i);
      }
      for (let i = Math.floor(li) - 3; i <= Math.ceil(li) + 3; i++) {
        if (i >= 0 && i < n) nearSet.add(i);
      }
    }
    let bSum = 0, bN = 0, iSum = 0, iN = 0;
    for (let i = 0; i < n; i++) {
      if (bset.has(i)) { bSum += grad[i]; bN++; }
      else if (!nearSet.has(i)) { iSum += grad[i]; iN++; }
    }
    const ratio = bN && iN ? (bSum / bN) / (iSum / iN) : 1;
    // high-pass the luminance profile (moving mean, win 31) then fold by phase
    const win = 31, half = 15, m = lum.length;
    const hp = new Array(m);
    for (let i = 0; i < m; i++) {
      let s = 0, c = 0;
      for (let j = Math.max(0, i - half); j <= Math.min(m - 1, i + half); j++) { s += lum[j]; c++; }
      hp[i] = lum[i] - s / c;
    }
    const BINS = 16, binSum = new Array(BINS).fill(0), binN = new Array(BINS).fill(0);
    for (let i = 0; i < m; i++) {
      const phase = (((offset + i + 0.5) % p) + p) % p / p;
      const b = Math.min(BINS - 1, Math.floor(phase * BINS));
      binSum[b] += hp[i]; binN[b]++;
    }
    const means = binSum.map((s, b) => (binN[b] ? s / binN[b] : 0));
    return { ratio, foldP2p: Math.max(...means) - Math.min(...means) };
  };
  const t = one(pitch), c = one(pitch * 1.37);
  return { ratio: t.ratio, ratioCtrl: c.ratio, foldP2p: t.foldP2p, foldCtrl: c.foldP2p };
}

const rows = [];
const armPlans = [];
for (const lamps of LAMPS) {
  if (AB) armPlans.push([lamps, false], [lamps, true]);
  else armPlans.push([lamps, TILECUT]);
}
for (const [lamps, cutOn] of armPlans) {
  console.log(`── arm lamps=${lamps}${cutOn ? " +tilecut" : ""}${TREE ? " (W3 tree ON)" : ""}`);
  const r = await runArm(lamps, cutOn);
  rows.push(r);
  console.log(`  lamps ${r.lamps}: emitterShadow ${r.emitterShadowMs} ms · resolve ${r.resolveMs} ms · total ${r.totalMs} ms · meanLum ${r.meanLum} · tree ${r.treeEmitters} emitters`);
  if (r.seatsLine) console.log(`  ${r.seatsLine}`);
  if (r.emitterShadowMs == null) console.log(`  ⚠ pass keys seen: ${r.rawKeys.join(", ")}`);
}

console.log("\n== §12.70 W4a BASELINE ==");
for (const r of rows) {
  console.log(`  N=${String(r.lamps).padEnd(3)} emitterShadow ${String(r.emitterShadowMs).padEnd(8)} resolve ${String(r.resolveMs).padEnd(8)} meanLum ${r.meanLum}  (tree sees ${r.treeEmitters}, seats capped at 4)`);
}
const sane = rows.every((r) => r.treeEmitters === r.lamps || r.treeEmitters === -1);
console.log(sane ? "baseline recorded" : "⚠ tree emitter count != lamp count — check candidate filter");

let seamPass = true;
if (SEAM) {
  console.log("\n== §12.70 W4b SEAM IMAGING — does the cut imprint the tile grid? ==");
  for (const lamps of LAMPS) {
    const off = rows.find((r) => r.lamps === lamps && !r.cutOn);
    const on = rows.find((r) => r.lamps === lamps && r.cutOn);
    if (!off?.seamRaw || !on?.seamRaw || !on.seamDims) {
      console.log(`  N=${lamps}: seam data incomplete — SKIP (raw off ${!!off?.seamRaw} on ${!!on?.seamRaw} dims ${!!on?.seamDims})`);
      seamPass = false;
      continue;
    }
    if (off.seamRaw.canvasW !== on.seamRaw.canvasW || off.seamRaw.canvasH !== on.seamRaw.canvasH) {
      console.log(`  N=${lamps}: canvas dims differ between arms (${off.seamRaw.canvasW}×${off.seamRaw.canvasH} vs ${on.seamRaw.canvasW}×${on.seamRaw.canvasH}) — stats incomparable`);
      seamPass = false;
      continue;
    }
    const pitchX = 8 * on.seamRaw.canvasW / on.seamDims.emitterW;
    const pitchY = 8 * on.seamRaw.canvasH / on.seamDims.emitterH;
    const ax = (raw) => seamAxisStats(raw.gradCol, raw.colLum, raw.x0, pitchX);
    const ay = (raw) => seamAxisStats(raw.gradRow, raw.rowLum, raw.y0, pitchY);
    const cOff = ax(off.seamRaw), cOn = ax(on.seamRaw);
    const rOff = ay(off.seamRaw), rOn = ay(on.seamRaw);
    const gradX = (cOn.ratio - cOn.ratioCtrl) - (cOff.ratio - cOff.ratioCtrl);
    const gradY = (rOn.ratio - rOn.ratioCtrl) - (rOff.ratio - rOff.ratioCtrl);
    const foldX = (cOn.foldP2p - cOn.foldCtrl) - (cOff.foldP2p - cOff.foldCtrl);
    const foldY = (rOn.foldP2p - rOn.foldCtrl) - (rOff.foldP2p - rOff.foldCtrl);
    if (on.seamCensus) {
      const c = on.seamCensus;
      console.log(`  N=${lamps} census: H boundaries differing ${c.hDiffer}/${c.hPairs} (mean Δset ${c.hMeanDiff}) · V ${c.vDiffer}/${c.vPairs} (${c.vMeanDiff}) · worst ${c.best}`);
    }
    console.log(`  N=${lamps} pitch ${pitchX.toFixed(2)}×${pitchY.toFixed(2)} px`);
    console.log(`    grad boundary/interior X: off ${cOff.ratio.toFixed(3)} (ctrl ${cOff.ratioCtrl.toFixed(3)}) on ${cOn.ratio.toFixed(3)} (ctrl ${cOn.ratioCtrl.toFixed(3)}) → excess ${gradX >= 0 ? "+" : ""}${gradX.toFixed(4)}`);
    console.log(`    grad boundary/interior Y: off ${rOff.ratio.toFixed(3)} (ctrl ${rOff.ratioCtrl.toFixed(3)}) on ${rOn.ratio.toFixed(3)} (ctrl ${rOn.ratioCtrl.toFixed(3)}) → excess ${gradY >= 0 ? "+" : ""}${gradY.toFixed(4)}`);
    console.log(`    fold p2p (luma) X: off ${cOff.foldP2p.toFixed(4)}/${cOff.foldCtrl.toFixed(4)} on ${cOn.foldP2p.toFixed(4)}/${cOn.foldCtrl.toFixed(4)} → Δ ${foldX >= 0 ? "+" : ""}${foldX.toFixed(4)}`);
    console.log(`    fold p2p (luma) Y: off ${rOff.foldP2p.toFixed(4)}/${rOff.foldCtrl.toFixed(4)} on ${rOn.foldP2p.toFixed(4)}/${rOn.foldCtrl.toFixed(4)} → Δ ${foldY >= 0 ? "+" : ""}${foldY.toFixed(4)}`);
    if (lamps > 4) {
      // Only N>4 can have differing adjacent sets; N=4 lists are the full
      // set everywhere, so its numbers are pure statistic-noise calibration.
      const ok = gradX <= 0.05 && gradY <= 0.05 && foldX <= 0.004 && foldY <= 0.004;
      seamPass = seamPass && ok;
      console.log(`    SOFT GATE (grad ≤ +0.05, fold Δ ≤ +0.004): ${ok ? "PASS" : "FAIL — grid-locked imprint, look at the crops"}`);
    }
  }
  console.log(`  crops for eyes: ${OUT}/seam-*.png (centre rect both arms; boundary crop red-ticked)`);
}

if (AB) {
  console.log("\n== §12.70 W4b SLICE-(ii) GATE — consumers on tile lists ==");
  let pass = seamPass;
  for (const lamps of LAMPS) {
    const off = rows.find((r) => r.lamps === lamps && !r.cutOn);
    const on = rows.find((r) => r.lamps === lamps && r.cutOn);
    if (!off || !on) { pass = false; continue; }
    const ratio = on.meanLum / off.meanLum;
    const v = on.cutVerdict;
    const setsOk = v && !v.fail && v.hardBad === 0 && v.structuralBad === 0;
    if (!setsOk) pass = false;
    if (lamps <= 4) {
      // PARITY: at N ≤ MAX_EMITTERS every tile's list is the full set, so the
      // tile arm must reproduce the seat arm — same estimator, same channels.
      const ok = Math.abs(ratio - 1) <= 0.05;
      pass = pass && ok;
      console.log(`  N=${lamps} PARITY: off ${off.meanLum} on ${on.meanLum} ratio ${ratio.toFixed(3)} — ${ok ? "PASS (within 5%)" : "FAIL"}; sets ${setsOk ? "ok" : "BAD"}`);
    } else {
      // RECOVERY, as a REGIONAL DIFFERENCE: the un-seated lamps live in the
      // crop's FAR (top) third at this pose; the seated lamps own the near
      // (bottom) third. (topΔ − bottomΔ) differences out global exposure /
      // boot drift (which hits both regions equally) and isolates exactly
      // the light the tile arm adds. Heatmap-verified once by eye: the gain
      // is far-wall wash + far-lamp pools, the near floor byte-flat.
      const topD = on.lumTop - off.lumTop;
      const botD = on.lumBot - off.lumBot;
      const stat = topD - botD;
      const ok = stat >= 0.008;
      pass = pass && ok;
      console.log(`  N=${lamps} RECOVERY: topΔ ${topD.toFixed(4)} bottomΔ ${botD.toFixed(4)} → regional gain ${stat.toFixed(4)} — ${ok ? "PASS (≥0.008)" : "FAIL"}; mean off ${off.meanLum} on ${on.meanLum}; sets ${setsOk ? "ok" : "BAD"}`);
    }
    console.log(`    emitterShadow off ${off.emitterShadowMs} on ${on.emitterShadowMs} ms · resolve off ${off.resolveMs} on ${on.resolveMs} ms · boot line ${on.cutLine ? "yes" : "MISSING"}`);
    if (v && !v.fail) console.log(`    lists use ${v.uniqueIds} unique ids [${v.idHist}] · record power [${v.recordPower}]
    P spread ${v.pSpread}`);
    if (!on.cutLine) pass = false;
  }
  console.log(`\nW4b SLICE-(ii): ${pass ? "PASS — the screen follows each pixel's tile" : "FAIL"}`);
  await browser.close();
  process.exit(pass ? 0 : 1);
}
if (TILECUT) {
  console.log("\n== §12.70 W4b SLICE-(i) GATE — tile cut vs CPU ranking ==");
  let pass = true;
  for (const r of rows) {
    const v = r.cutVerdict;
    if (!v || v.fail) {
      console.log(`  N=${r.lamps}: FAIL — ${v?.fail ?? "no verdict"} ${r.cutLine ? "" : "(no boot line either)"}`);
      pass = false;
      continue;
    }
    const ok = v.hardBad === 0 && v.structuralBad === 0 && !!r.cutLine;
    pass = pass && ok;
    console.log(
      `  N=${r.lamps}: ${ok ? "PASS" : "FAIL"} — ${v.tiles} tiles (${v.validTiles} valid): ` +
      `${v.matched} exact, ${v.tieTolerated} near-tie, ${v.hardBad} hard-bad, ${v.structuralBad} structural` +
      (r.cutLine ? "" : " — NO BOOT LINE"),
    );
    if (v.worst) console.log(`     worst: ${v.worst}`);
  }
  console.log(`\nW4b SLICE-(i): ${pass ? "PASS — the cut ranks like the CPU, keyed by id, everywhere" : "FAIL"}`);
  await browser.close();
  process.exit(pass ? 0 : 1);
}
await browser.close();
process.exit(0);
