// TEMP INSTRUMENT (session 31b) — raw vs FINAL direct-shadow channel on the
// user's real project while their MeshScript rotates the cube in edit mode.
// The user's GI-intensity-0 discriminator shows square chunks in the DIRECT
// channel; the raw march measured clean, so this convicts (or clears) the
// presentation chain: bilateral filter -> wide pass x2 -> PCSS disc.
// PRESET_GLOBALS='{"__giShadowWidePass":false}' etc. for the bisect arms.
// Saves scripts/gi-diag-chain-{raw,final}-N.png pairs + a viewport shot.
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const ARM = process.env.ARM ?? "default";
const QUALITY = process.env.QUALITY ?? "";
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
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
await installTauriShim(page, {});
let built = false;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built|light shadows/.test(t)) console.log(`  ${t.slice(0, 160)}`);
  if (/\[gi\] built/.test(t)) built = true;
});
page.on("pageerror", (e) => {
  const msg = e.message ?? String(e);
  if (!/save_scene/.test(msg)) console.log(`  pageerror: ${msg.slice(0, 200)}`);
});
await page.evaluateOnNewDocument((PROJECT, PRESET) => {
  localStorage.setItem("engine.projectRoot.v1", PROJECT);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([PROJECT]));
  for (const [k, v] of Object.entries(PRESET)) globalThis[k] = v;
}, PROJECT, JSON.parse(process.env.PRESET_GLOBALS ?? "{}"));
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 150000 });
for (let i = 0; i < 90 && !built; i++) await wait(1000);
await wait(12000);

const call = (op, args = {}) =>
  page.evaluate(async ({ op, args }) => {
    try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
    catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
  }, { op, args });

// Optional quality override on the GI entity.
if (QUALITY) {
  const ents = (await call("entity.list", {})).value ?? [];
  const gi = ents.find((e) => (e.components ?? []).some((c) => c.type === "global-illumination"));
  if (gi) { await call("component.setProp", { id: gi.id, type: "global-illumination", key: "quality", value: QUALITY }); await wait(12000); }
}

// Find the scripted cube (the mover) and aim the camera like the user's shot.
const ents = (await call("entity.list", {})).value ?? [];
const mover = ents.find((e) => (e.components ?? []).some((c) => c.type === "mesh") && (e.components ?? []).some((c) => c.type === "script"))
  ?? ents.find((e) => e.name === "Mesh")
  ?? ents.find((e) => /cube|mesh/i.test(e.name ?? ""));
const mpos = await page.evaluate((id) => {
  const o = globalThis.__editorApi.entities.live(id)?.object3D;
  return o ? [o.position.x, o.position.y, o.position.z] : null;
}, mover?.id);
console.log(`  mover "${mover?.name}" at ${JSON.stringify(mpos)}`);
if (mpos) {
  await call("viewport.setCamera", {
    position: [mpos[0] + 6.5, mpos[1] + 1.2, mpos[2] + 0.3],
    target: [mpos[0], mpos[1] - 0.8, mpos[2]],
  });
}
await wait(2500);

const result = await page.evaluate(async ({ anchorId, frames }) => {
  const eng = globalThis.__editorApi.entities.live(anchorId)?.engine;
  const sys = eng?.modules?.get("gi")?.system;
  const sb = sys?.state?.screen;
  if (!sb?.targets?.lightShadowRaw || !sb?.targets?.lightShadow) {
    return { fail: `targets missing (raw=${!!sb?.targets?.lightShadowRaw} final=${!!sb?.targets?.lightShadow})` };
  }
  const W = sb.shadowWidth, H = sb.shadowHeight;
  const stride = Math.ceil((W * 4) / 256) * 256;
  const grab = (t) => eng.renderer.backend.copyTextureToBuffer(t, 0, 0, W, H);
  const pngOf = (A) => {
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d");
    const id = ctx.createImageData(W, H);
    for (let y = 0; y < H; y++) {
      const row = y * stride;
      for (let x = 0; x < W; x++) {
        const i = y * W + x, b = A[row + x * 4];
        id.data[i * 4] = b; id.data[i * 4 + 1] = b; id.data[i * 4 + 2] = b; id.data[i * 4 + 3] = 255;
      }
    }
    ctx.putImageData(id, 0, 0);
    return c.toDataURL("image/png");
  };
  // Blockiness of the FINAL vs RAW: count long axis-aligned constant-value
  // step edges (the square-chunk signature) in the mid-tone band.
  const blockiness = (A) => {
    let steps = 0;
    for (let y = 2; y < H - 2; y++) {
      const row = y * stride;
      let run = 0;
      for (let x = 2; x < W - 2; x++) {
        const d = Math.abs(A[row + x * 4] - A[row + (x + 1) * 4]);
        if (d > 60) run++; else { if (run >= 6) steps += run; run = 0; }
      }
    }
    return steps;
  };
  const pairs = [];
  for (let i = 0; i < frames; i++) {
    await new Promise((r) => setTimeout(r, 350));
    const raw = await grab(sb.targets.lightShadowRaw);
    const fin = await grab(sb.targets.lightShadow);
    pairs.push({ raw, fin, bRaw: blockiness(raw), bFin: blockiness(fin) });
  }
  // Keep the worst-final pair + first pair.
  pairs.sort((a, b) => b.bFin - a.bFin);
  const worst = pairs[0];
  return {
    W, H,
    stats: pairs.map((p) => ({ raw: p.bRaw, fin: p.bFin })),
    rawPng: pngOf(worst.raw),
    finPng: pngOf(worst.fin),
  };
}, { anchorId: mover?.id ?? ents[0].id, frames: 6 });

if (result.fail) { console.log(`FAIL: ${result.fail}`); await browser.close(); process.exit(1); }
console.log(`CHAIN ${ARM} ${result.W}x${result.H} blockiness per grab: ${JSON.stringify(result.stats)}`);
writeFileSync(`scripts/gi-diag-chain-raw-${ARM}.png`, Buffer.from(result.rawPng.split(",")[1], "base64"));
writeFileSync(`scripts/gi-diag-chain-final-${ARM}.png`, Buffer.from(result.finPng.split(",")[1], "base64"));
await page.screenshot({ path: `scripts/gi-diag-chain-view-${ARM}.png` });

// TEXTURE DIMS (DIMS=1): actual GPU dims of every shadow-chain target vs
// the screen bundle's shadowWidth/Height — a mismatch means stale targets
// after a resize (sampled stretched = the soft blob).
if (process.env.DIMS === "1") {
  const dims = await page.evaluate(({ anchorId }) => {
    const eng = globalThis.__editorApi.entities.live(anchorId)?.engine;
    const sb = eng.modules.get("gi").system.state.screen;
    const of = (t) => t ? [t.image?.width ?? t.width, t.image?.height ?? t.height] : null;
    return {
      bundle: [sb.shadowWidth, sb.shadowHeight],
      resolve: [sb.width, sb.height],
      raw: of(sb.targets.lightShadowRaw),
      mid: of(sb.targets.lightShadowMid),
      wide: of(sb.targets.lightShadowWide),
      final: of(sb.targets.lightShadow),
      dist: of(sb.targets.lightShadowDist),
      gbufferPos: of(sb.gbuffer?.position),
    };
  }, { anchorId: mover?.id ?? ents[0].id });
  console.log(`DIMS ${JSON.stringify(dims)}`);
}

// SHADOW-SOURCE ATTRIBUTION (FOCUS=1): the user's close-up state — GI
// intensity as saved (0), camera tight on the cube's floor shadow — with a
// live toggle ladder over the DIRECT-shadow sources. Which toggle deletes
// the soft chunky blob?
if (process.env.FOCUS === "1") {
  const lightEnt = ents.find((e) => (e.components ?? []).some((c) => c.type === "light" && c.props?.kind === "directional"));
  // Aim at the ACTUAL shadow: project the cube center along the live sun
  // direction onto the floor, then frame it from 3m up-sun.
  const aim = await page.evaluate(({ anchorId, mpos }) => {
    const eng = globalThis.__editorApi.entities.live(anchorId)?.engine;
    const slot = eng.modules.get("gi").system.state.lightSlots?.[0];
    const d = slot?.vector?.value; // toward the light
    if (!d || Math.abs(d.y) < 0.05) return null;
    const t = mpos[1] / d.y; // steps down to y=0 along -d
    return { sun: [d.x, d.y, d.z].map((n) => +n.toFixed(3)), shadowP: [mpos[0] - d.x * t, 0, mpos[2] - d.z * t] };
  }, { anchorId: mover?.id ?? ents[0].id, mpos });
  console.log(`  sun/shadow: ${JSON.stringify(aim)}`);
  const sp = aim?.shadowP ?? [mpos[0], 0, mpos[2]];
  await call("viewport.setCamera", {
    position: [sp[0] + 2.2, 2.0, sp[2] + 1.8],
    target: [sp[0], 0.1, sp[2]],
  });
  await wait(2000);
  const shot = async (name) => {
    await wait(2500);
    await page.screenshot({ path: `scripts/gi-diag-focus-${name}.png` });
    console.log(`  focus shot: ${name}`);
  };
  await shot("base");
  // Same-frame raw + final shadow textures at THIS close view.
  {
    const texes = await page.evaluate(async ({ anchorId }) => {
      const eng = globalThis.__editorApi.entities.live(anchorId)?.engine;
      const sb = eng.modules.get("gi").system.state.screen;
      const W = sb.shadowWidth, H = sb.shadowHeight;
      const stride = Math.ceil((W * 4) / 256) * 256;
      const png = (A) => {
        const cv = document.createElement("canvas");
        cv.width = W; cv.height = H;
        const ctx = cv.getContext("2d");
        const id = ctx.createImageData(W, H);
        for (let y = 0; y < H; y++) {
          const row = y * stride;
          for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4, b = A[row + x * 4];
            id.data[i] = b; id.data[i + 1] = b; id.data[i + 2] = b; id.data[i + 3] = 255;
          }
        }
        ctx.putImageData(id, 0, 0);
        return cv.toDataURL("image/png");
      };
      const raw = await eng.renderer.backend.copyTextureToBuffer(sb.targets.lightShadowRaw, 0, 0, W, H);
      const fin = await eng.renderer.backend.copyTextureToBuffer(sb.targets.lightShadow, 0, 0, W, H);
      const mid = sb.targets.lightShadowMid
        ? await eng.renderer.backend.copyTextureToBuffer(sb.targets.lightShadowMid, 0, 0, W, H) : null;
      const wide = sb.targets.lightShadowWide
        ? await eng.renderer.backend.copyTextureToBuffer(sb.targets.lightShadowWide, 0, 0, W, H) : null;
      return { raw: png(raw), fin: png(fin), mid: mid ? png(mid) : null, wide: wide ? png(wide) : null };
    }, { anchorId: mover?.id ?? ents[0].id });
    writeFileSync("scripts/gi-diag-focus-raw.png", Buffer.from(texes.raw.split(",")[1], "base64"));
    writeFileSync("scripts/gi-diag-focus-final.png", Buffer.from(texes.fin.split(",")[1], "base64"));
    if (texes.mid) writeFileSync("scripts/gi-diag-focus-mid.png", Buffer.from(texes.mid.split(",")[1], "base64"));
    if (texes.wide) writeFileSync("scripts/gi-diag-focus-wide.png", Buffer.from(texes.wide.split(",")[1], "base64"));
  }
  // 1. castShadow off — kills the gi channel AND any three map. Blob
  //    survives => not a shadow term at all.
  await call("component.setProp", { id: lightEnt.id, type: "light", key: "castShadow", value: false });
  await shot("noshadow");
  await call("component.setProp", { id: lightEnt.id, type: "light", key: "castShadow", value: true });
  // 2. three's shadow map instead of the gi channel.
  await call("component.setProp", { id: lightEnt.id, type: "light", key: "shadowMode", value: "map" });
  await shot("mapmode");
  await call("component.setProp", { id: lightEnt.id, type: "light", key: "shadowMode", value: "gi" });
  await wait(1500);
  await shot("restored");
}

// KIND HISTOGRAM (KINDS=1, needs PRESET_GLOBALS __giShadowKindDebug:"sub"):
// count verdict-kind bytes in the raw over N grabs while the scene script
// rotates the cube — box/fail growth on the REAL project is the conviction
// the synthetic rig could not produce.
if (process.env.KINDS === "1") {
  const kr = await page.evaluate(async ({ anchorId, frames }) => {
    const eng = globalThis.__editorApi.entities.live(anchorId)?.engine;
    const sb = eng.modules.get("gi").system.state.screen;
    const W = sb.shadowWidth, H = sb.shadowHeight;
    const stride = Math.ceil((W * 4) / 256) * 256;
    const series = [];
    let worstPng = null, worstBox = -1;
    for (let i = 0; i < frames; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const A = await eng.renderer.backend.copyTextureToBuffer(sb.targets.lightShadowRaw, 0, 0, W, H);
      const c = { miss: 0, plane: 0, tri: 0, box: 0, fail: 0, none: 0, other: 0 };
      for (let y = 0; y < H; y++) {
        const row = y * stride;
        for (let x = 0; x < W; x++) {
          const b = A[row + x * 4];
          if (b < 16) c.miss++;
          else if (Math.abs(b - 32) <= 8) c.plane++;
          else if (Math.abs(b - 64) <= 8) c.tri++;
          else if (Math.abs(b - 96) <= 8) c.box++;
          else if (b >= 120 && b <= 200) c.fail++;
          else if (b >= 250) c.none++;
          else c.other++;
        }
      }
      series.push(c);
      if (c.box + c.fail > worstBox) {
        worstBox = c.box + c.fail;
        const cv = document.createElement("canvas");
        cv.width = W; cv.height = H;
        const ctx = cv.getContext("2d");
        const id = ctx.createImageData(W, H);
        for (let y = 0; y < H; y++) {
          const row = y * stride;
          for (let x = 0; x < W; x++) {
            const idx = (y * W + x) * 4, b = A[row + x * 4];
            id.data[idx] = b; id.data[idx + 1] = b; id.data[idx + 2] = b; id.data[idx + 3] = 255;
          }
        }
        ctx.putImageData(id, 0, 0);
        worstPng = cv.toDataURL("image/png");
      }
    }
    return { W, H, series, worstPng };
  }, { anchorId: mover?.id ?? ents[0].id, frames: 10 });
  console.log(`KINDS ${JSON.stringify(kr.series)}`);
  if (kr.worstPng) writeFileSync("scripts/gi-diag-kinds-real.png", Buffer.from(kr.worstPng.split(",")[1], "base64"));
}

// CPU GROUND TRUTH (CPUTRACE=1): from lit-strip floor points, march the
// readback bits toward the actual sun on CPU. If CPU says clear while the
// field goes black, the GPU field march is buggy; if CPU says blocked, the
// voxelized world itself seals the light path (conservative bulge closing
// the aperture) and the field is faithful.
if (process.env.CPUTRACE === "1") {
  const trace = await page.evaluate(async ({ anchorId }) => {
    const eng = globalThis.__editorApi.entities.live(anchorId)?.engine;
    const sys = eng.modules.get("gi").system;
    const occF = sys.state.volume.occupancyField;
    const rb = await occF.readbackBits(eng.renderer);
    const slot = sys.state.lightSlots?.[0];
    const dir = slot?.vector?.value; // TOWARD the light
    if (!dir) return { fail: "no light slot" };
    // Sample world points across the visibly lit strip (probe the gbuffer
    // for actually-lit floor pixels? simpler: fixed grid near the mover).
    const pts = [];
    for (let ix = 0; ix < 10; ix++) {
      for (let iz = 0; iz < 6; iz++) {
        pts.push({ x: -8 + ix * 1.2, y: 0.45, z: -1.5 + iz * 0.6 });
      }
    }
    const o = rb.origin, v = rb.voxel;
    const res = rb.res ?? null;
    const results = [];
    for (const p of pts) {
      // CPU DDA at level 0, step half a voxel — conservative sampling.
      const step = Math.min(v.x, v.y, v.z) * 0.5;
      const lift = 0.45;
      let hit = null;
      for (let t = step * 2; t < 80; t += step) {
        const wx = p.x + dir.x * t, wy = p.y + dir.y * t, wz = p.z + dir.z * t;
        const c = rb.voxelOf({ x: wx, y: wy, z: wz });
        if (rb.get(c.x, c.y, c.z, 0)) { hit = { t: +t.toFixed(2), at: [wx, wy, wz].map((n) => +n.toFixed(2)) }; break; }
      }
      results.push(hit);
    }
    const blocked = results.filter(Boolean);
    return {
      dir: [dir.x, dir.y, dir.z].map((n) => +n.toFixed(3)),
      origin: [o.x, o.y, o.z].map((n) => +n.toFixed(2)),
      voxel: [v.x, v.y, v.z].map((n) => +n.toFixed(3)),
      total: results.length,
      blocked: blocked.length,
      sampleHits: blocked.slice(0, 8),
    };
  }, { anchorId: mover?.id ?? ents[0].id });
  console.log(`CPUTRACE ${JSON.stringify(trace)}`);
}

// FIELD CELL PROBE (CELLPROBE=1): radiance + surface of known lit-strip
// cells, field shadows ON vs OFF (live uniform). If ON reads ~0 where the
// CPU trace says the sun path is clear, the GPU field shadow march is
// convicted at the exact cells.
if (process.env.CELLPROBE === "1") {
  const probeCells = async (label) => {
    const r = await page.evaluate(async ({ anchorId }) => {
      const eng = globalThis.__editorApi.entities.live(anchorId)?.engine;
      const sys = eng.modules.get("gi").system;
      const vol = sys.state.volume;
      const world = vol.world;
      const res = vol.res;
      const rad = new Float32Array(await eng.renderer.getArrayBufferAsync(vol.radianceBuffer.value));
      const surf = new Float32Array(await eng.renderer.getArrayBufferAsync(vol.surfaceBuffer.value));
      const min = world.min.value ?? world.min;
      const cell = world.cell.value ?? world.cell;
      const out = [];
      for (let ix = 0; ix < 8; ix++) {
        const p = { x: -8 + ix * 1.5, y: 0.05, z: -0.5 };
        const cx = Math.floor((p.x - min.x) / cell.x);
        const cy = Math.floor((p.y - min.y) / cell.y);
        const cz = Math.floor((p.z - min.z) / cell.z);
        // dump EVERY surface cell in the column: y-offset, sw, lum
        const col = [];
        for (let dy = -2; dy <= 2; dy++) {
          const i = ((cz * res.y + cy + dy) * res.x + cx);
          const sw = surf[i * 4 + 3];
          if (sw > 0.35) {
            col.push({
              dy,
              sw: +sw.toFixed(2),
              lum: +(rad[i * 4] * 0.2126 + rad[i * 4 + 1] * 0.7152 + rad[i * 4 + 2] * 0.0722).toFixed(3),
            });
          }
        }
        out.push(col);
      }
      return out;
    }, { anchorId: mover?.id ?? ents[0].id });
    console.log(`CELLPROBE ${label}: ${JSON.stringify(r)}`);
  };
  await probeCells("shadowsON");
  await page.evaluate(() => { globalThis.__giNoFieldShadows = true; });
  await wait(3000);
  await probeCells("shadowsOFF");
  await page.evaluate(() => { globalThis.__giNoFieldShadows = false; });
  await wait(1500);
  await page.screenshot({ path: "scripts/gi-diag-cellprobe-view.png" });
}

// LIVE-TOGGLE ATTRIBUTION (TOGGLES=1): which term paints the big chunky
// blob on the floor? Each state gets a viewport screenshot.
if (process.env.TOGGLES === "1") {
  const giEnt = ents.find((e) => (e.components ?? []).some((c) => c.type === "global-illumination"));
  const viewport = await page.$(".viewport-panel canvas") ?? page;
  const shot = async (name) => {
    await wait(2500);
    await page.screenshot({ path: `scripts/gi-diag-toggle-${name}.png` });
    console.log(`  toggle shot: ${name}`);
  };
  // 1. GI intensity 0 — survives ⇒ direct/burial/AO; dies ⇒ GI resolve term.
  await call("component.setProp", { id: giEnt.id, type: "global-illumination", key: "intensity", value: 0 });
  await shot("gi0");
  await call("component.setProp", { id: giEnt.id, type: "global-illumination", key: "intensity", value: 1 });
  // 2. Field shadows off (live uniform) — dies ⇒ the FIELD sun-shadow term.
  await page.evaluate(() => { globalThis.__giNoFieldShadows = true; });
  await shot("nofieldshadow");
  await page.evaluate(() => { globalThis.__giNoFieldShadows = false; });
  // 3. AO off.
  await call("component.setProp", { id: giEnt.id, type: "global-illumination", key: "aoStrength", value: 0 });
  await shot("noao");
  await call("component.setProp", { id: giEnt.id, type: "global-illumination", key: "aoStrength", value: 0.6 });
}
await browser.close();
