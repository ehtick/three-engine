// DIAGNOSIS ONLY — reproduces three GI symptoms reported in the user's real
// project (C:\Users\Khudiiash\Documents\GAME, scenes/Main.scene) and prints
// data. No src edits, no scene mutation persisted to disk (the project is
// opened read-only through the Tauri shim — writableRoot is never passed).
//
//   npx vite --port 5234 --strictPort
//   node scripts/run-gi-diagnose-game.mjs [url]
//
// HEADED=1 to watch it run.
//
// Opens the project exactly the way run-playstop-perf.mjs does (the proven
// "open a REAL project through the shim" pattern): openProject() then an
// explicit openScenePath(), driven straight through the store rather than
// clicking through the project hub UI. syncProjectModules() is also called
// explicitly, right after openProject() and before openScenePath() — module
// components (incl. "global-illumination") must register before the scene
// deserializes or they load as inert "missing" data; EditorChrome's own boot
// effect does this too once React reacts to the store change, but calling it
// ourselves removes the race instead of hoping we win it.
//
// A. Scene inventory: the GI entity + its props verbatim, every [gi] console
//    line from startup, mesh/tri census.
// B. Freeze repro: move a mesh sinusoidally for 20s (10s static baseline
//    after), record every frame delta + console lines + renderSuspended.
// C. Shadow ring capture: 3 screenshots at increasing distance on the wall/
//    floor nearest the brightest emissive mesh, plus a 24-point radial
//    luminance profile from directly at the lamp outward.
// D. Reflection check: screenshot a mirror-ish mesh, live-flip
//    exactReflections, rebuild, screenshot again, diff.
import path from "node:path";
import puppeteer from "puppeteer-core";
import sharp from "sharp";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5234/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
const SCENE = "scenes/Main.scene";
const scenePath = path.join(PROJECT, SCENE).replace(/\\/g, "/");
const VIEW_WIDTH = Number(process.env.WIDTH) || 1400;
const VIEW_HEIGHT = Number(process.env.HEIGHT) || 900;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// ALL console lines, timestamped in epoch-ms (Date.now() on the Node side;
// page-side timestamps use performance.timeOrigin + performance.now(), which
// is the same clock, so the two are directly comparable for the ±1500ms
// window lookups section B needs).
// ---------------------------------------------------------------------------
const consoleLog = [];
const pushLog = (type, text) => {
  if (consoleLog.length < 40000) consoleLog.push({ t: Date.now(), type, text: String(text).slice(0, 4000) });
};
const linesNear = (t, windowMs = 1500) =>
  consoleLog
    .filter((e) => Math.abs(e.t - t) <= windowMs)
    .map((e) => `    [${new Date(e.t).toISOString().slice(11, 23)}] ${e.type}: ${e.text}`);

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: VIEW_WIDTH, height: VIEW_HEIGHT, deviceScaleFactor: 1 });
await installTauriShim(page, { verbose: !!process.env.VERBOSE }); // read-only: no writableRoot

page.on("console", (m) => {
  const text = m.text();
  pushLog(m.type(), text);
  if (/\[gi\]/.test(text) || m.type() === "error" || m.type() === "warning") {
    console.log(`  page ${m.type()}: ${text.slice(0, 300)}`);
  }
});
page.on("pageerror", (e) => {
  const text = `pageerror: ${e.stack ?? e.message}`;
  pushLog("pageerror", text);
  console.log(`  ${text}`);
});
page.on("error", (e) => console.log(`PAGE CRASHED: ${e.message}`));

// Vite rewrites imports of files edited since the server started to
// `…?t=<mtime>` — a bare import("/src/…") from the harness would load a
// SECOND copy with its own Engine singleton (see vite-module-duplication.md).
await page.evaluateOnNewDocument(() => {
  globalThis.__importLive = (p) => {
    const prefix = location.origin + p;
    const fetched = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
    return import(/* @vite-ignore */ live ?? p);
  };
});

let browserClosed = false;
const closeOnce = async () => {
  if (browserClosed) return;
  browserClosed = true;
  await browser.close().catch(() => {});
};
const fatal = async (message) => {
  console.log(`\nFATAL: ${message}`);
  await closeOnce();
  process.exit(1);
};

await page.goto(url, { waitUntil: "load", timeout: 60000 }).catch((err) => fatal(`page failed to load ${url}: ${err.message}`));

// --------------------------------------------------------------------- open
console.log(`Opening project ${PROJECT}, scene ${scenePath} ...`);
const opened = await page.evaluate(
  async ({ PROJECT, scenePath }) => {
    try {
      const { useProjectStore } = await globalThis.__importLive("/src/editor/store/projectStore.js");
      await useProjectStore.getState().openProject(PROJECT);
      // Register module components (incl. "global-illumination") BEFORE the
      // scene deserializes — see header comment.
      const { syncProjectModules } = await globalThis.__importLive("/src/editor/modules.js");
      await syncProjectModules();
      const { openScenePath } = await globalThis.__importLive("/src/editor/sceneIO.js");
      await openScenePath(scenePath);
      const { ensureEngine } = await globalThis.__importLive("/src/editor/engineInstance.js");
      const engine = await ensureEngine();
      globalThis.__engine = engine;
      const { THREE } = await globalThis.__importLive("/src/engine/index.js");
      globalThis.__THREE = THREE;
      const { EDITOR_LAYER } = await globalThis.__importLive("/src/engine/editorLayers.js");
      globalThis.__EDITOR_LAYER = EDITOR_LAYER;
      return { ok: true, entities: engine.entities.size, name: engine.sceneName, modules: [...engine.modules.keys()] };
    } catch (err) {
      return { ok: false, error: err?.stack ?? err?.message ?? String(err) };
    }
  },
  { PROJECT, scenePath },
);

if (!opened.ok) await fatal(`project/scene failed to open:\n${opened.error}`);
if (!opened.entities) await fatal(`scene loaded with ZERO entities (name="${opened.name}") — treating as a load failure, not an empty project.`);
console.log(`  opened scene "${opened.name}": ${opened.entities} entities, modules: ${opened.modules.join(", ")}`);

// ------------------------------------------------------------------ settle
const settleEngine = async (label, budgetMs = 60000) => {
  const t = Date.now();
  while (Date.now() - t < budgetMs) {
    await wait(1000);
    const busy = await page.evaluate(() => globalThis.__engine?.renderSuspended === true);
    if (!busy && Date.now() - t > 6000) break;
  }
  console.log(`  settled (${label}) after ${((Date.now() - t) / 1000).toFixed(1)}s`);
};
await settleEngine("initial load");

// Confirm the load actually finished rather than snapshotting mid-stream:
// entity count must be stable across two checks 3s apart.
let stableCount = await page.evaluate(() => globalThis.__engine.entities.size);
await wait(3000);
let recheck = await page.evaluate(() => globalThis.__engine.entities.size);
if (recheck !== stableCount) {
  console.log(`  entity count still changing (${stableCount} -> ${recheck}), waiting longer...`);
  await settleEngine("late loads", 30000);
  stableCount = await page.evaluate(() => globalThis.__engine.entities.size);
}
// A scene whose prefab/model loads haven't even STARTED yet within the
// tight 3s window above reads as "stable" prematurely (observed: a ~10-70
// entity capture vs. this project's real ~130 — async entity/prefab
// creation during openScenePath can still be getting underway when the
// first check lands). One more, longer recheck catches that "stable but
// still early" case before section D goes looking for mirror-ish meshes.
await wait(8000);
const lateRecheck = await page.evaluate(() => globalThis.__engine.entities.size);
if (lateRecheck !== stableCount) {
  console.log(`  entity count grew after the initial stability check (${stableCount} -> ${lateRecheck}) — waiting for it to settle again...`);
  await settleEngine("late loads (second pass)", 30000);
  stableCount = await page.evaluate(() => globalThis.__engine.entities.size);
}
console.log(`  entity count stable at ${stableCount}`);

// Viewport/camera mount late — everything past this point needs both.
for (let i = 0; i < 40; i++) {
  const ready = await page.evaluate(() => !!globalThis.__viewport?.orbit && !!globalThis.__engine?.camera);
  if (ready) break;
  await wait(500);
}
const viewportReady = await page.evaluate(() => !!globalThis.__viewport?.orbit && !!globalThis.__engine?.camera);
console.log(`  viewport ready: ${viewportReady}`);

// =============================================================================
// A. SCENE INVENTORY
// =============================================================================
console.log("\n=== A. SCENE INVENTORY ===");
const sectionABoundary = Date.now();
const inventory = await page.evaluate(() => {
  const engine = globalThis.__engine;
  const EDITOR_LAYER = globalThis.__EDITOR_LAYER;

  let giEntity = null;
  let giComponent = null;
  for (const entity of engine.entities.values()) {
    const c = entity.components.get("global-illumination");
    if (c) {
      giEntity = entity;
      giComponent = c;
      break;
    }
  }
  const giWorldPos = giEntity ? giEntity.object3D.getWorldPosition(new (globalThis.__THREE.Vector3)()).toArray() : null;

  const meshes = [];
  let totalTris = 0;
  const skinned = [];
  engine.scene.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.visible) return;
    if (o.layers.isEnabled(EDITOR_LAYER)) return;
    const g = o.geometry;
    const tris = g.index ? g.index.count / 3 : (g.attributes.position?.count ?? 0) / 3;
    totalTris += tris;
    meshes.push({ name: o.name || "(unnamed)", tris: Math.round(tris), isSkinned: !!o.isSkinnedMesh });
    if (o.isSkinnedMesh) skinned.push(o.name || "(unnamed)");
  });
  meshes.sort((a, b) => b.tris - a.tris);

  return {
    giEntityName: giEntity ? giEntity.name : null,
    giEntityId: giEntity ? giEntity.id : null,
    giWorldPos,
    giProps: giComponent ? { ...giComponent.props } : null,
    totalMeshes: meshes.length,
    totalTris: Math.round(totalTris),
    top10: meshes.slice(0, 10),
    skinnedMeshes: skinned,
  };
});

if (!inventory.giEntityId) {
  console.log('  NO ENTITY WITH A "global-illumination" COMPONENT WAS FOUND IN THE LOADED SCENE.');
} else {
  console.log(`  GI component sits on entity "${inventory.giEntityName}" (id=${inventory.giEntityId}), world pos [${inventory.giWorldPos.map((v) => v.toFixed(2))}]`);
  console.log(`  props: ${JSON.stringify(inventory.giProps, null, 2)}`);
}
console.log(`\n  every [gi] console line from startup:`);
const startupGi = consoleLog.filter((e) => e.t <= sectionABoundary && /\[gi\]/.test(e.text));
if (!startupGi.length) console.log("    (none captured)");
for (const e of startupGi) console.log(`    [${new Date(e.t).toISOString().slice(11, 23)}] ${e.text}`);

console.log(`\n  scene stats (visible, non-editor-layer meshes):`);
console.log(`    total meshes: ${inventory.totalMeshes}`);
console.log(`    total triangles: ${inventory.totalTris}`);
console.log(`    10 biggest meshes by tris:`);
for (const m of inventory.top10) console.log(`      ${m.tris.toString().padStart(8)} tris  ${m.name}${m.isSkinned ? "  [SkinnedMesh]" : ""}`);
console.log(`    SkinnedMesh count: ${inventory.skinnedMeshes.length}${inventory.skinnedMeshes.length ? ` — ${inventory.skinnedMeshes.join(", ")}` : ""}`);

if (process.env.PERF_AB) {
  const giRuntime = await page.evaluate(() => {
    const system = globalThis.__engine.modules.get("gi")?.system;
    let component = null;
    for (const entity of globalThis.__engine.entities.values()) {
      component = entity.components.get("global-illumination");
      if (component) break;
    }
    if (!system?.state && component) {
      component.setEnabledOverride(true);
      system.attach(component);
    }
    return { hadState: !!system?.state, attached: !!component };
  });
  console.log(`  GI runtime before A/B: state=${giRuntime.hadState}, component=${giRuntime.attached}`);
  if (!giRuntime.hadState && giRuntime.attached) await settleEngine("forced GI attach", 60000);
  const sampleFrames = (milliseconds) => page.evaluate(async (ms) => {
    const frames = [];
    let previous = null;
    const start = performance.now();
    await new Promise((resolve) => {
      const step = (now) => {
        if (previous != null) frames.push(now - previous);
        previous = now;
        if (now - start < ms) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    frames.sort((a, b) => a - b);
    return {
      count: frames.length,
      average: frames.reduce((sum, value) => sum + value, 0) / Math.max(1, frames.length),
      p95: frames[Math.min(frames.length - 1, Math.floor(frames.length * 0.95))] ?? 0,
    };
  }, milliseconds);
  const reportPerf = (label, result) =>
    console.log(`  ${label}: ${result.average.toFixed(2)}ms avg, ${result.p95.toFixed(2)}ms p95 (${result.count} frames)`);

  console.log(`\n=== IMPORTED SCENE GI A/B (${VIEW_WIDTH}x${VIEW_HEIGHT}) ===`);
  await wait(2000);
  reportPerf("exact BVH reflections ON", await sampleFrames(5000));
  await page.evaluate(() => { globalThis.__giNoBvhReflections = true; });
  await wait(1000);
  reportPerf("exact BVH reflections OFF", await sampleFrames(5000));
  await page.evaluate(() => { globalThis.__giNoBvhReflections = false; });
  await closeOnce();
  process.exit(0);
}

// =============================================================================
// B. FREEZE REPRODUCTION
// =============================================================================
console.log("\n=== B. FREEZE REPRODUCTION ===");
try {
  const pick = await page.evaluate((giEntityId) => {
    const engine = globalThis.__engine;
    const THREE = globalThis.__THREE;
    const box = new THREE.Box3();
    let any = false;
    for (const entity of engine.entities.values()) {
      if (!entity.components.get("mesh")) continue;
      if (!entity.object3D.visible) continue;
      entity.object3D.traverse((o) => {
        if (o.isMesh && o.geometry) {
          box.expandByObject(o);
          any = true;
        }
      });
    }
    const centre = any ? box.getCenter(new THREE.Vector3()) : new THREE.Vector3();

    const candidates = [];
    for (const entity of engine.entities.values()) {
      if (entity.id === giEntityId) continue;
      const mc = entity.components.get("mesh");
      if (!mc) continue;
      if (!entity.object3D.visible) continue;
      let tris = 0;
      let hasGeom = false;
      entity.object3D.traverse((o) => {
        if (o.isMesh && o.geometry) {
          hasGeom = true;
          const g = o.geometry;
          tris += g.index ? g.index.count / 3 : (g.attributes.position?.count ?? 0) / 3;
        }
      });
      if (!hasGeom) continue;
      const pos = new THREE.Vector3();
      entity.object3D.getWorldPosition(pos);
      const dist = pos.distanceTo(centre);
      const simple = /cube|box|crate|prop/i.test(entity.name || "") || mc.props?.geometry === "box";
      candidates.push({ id: entity.id, name: entity.name, position: pos.toArray(), tris: Math.round(tris), dist, simple });
    }
    candidates.sort((a, b) => {
      if (a.simple !== b.simple) return a.simple ? -1 : 1;
      if (Math.abs(a.dist - b.dist) > 0.001) return a.dist - b.dist;
      return a.tris - b.tris;
    });
    return { picked: candidates[0] ?? null, candidateCount: candidates.length, centre: centre.toArray() };
  }, inventory.giEntityId);

  if (!pick.picked) {
    console.log(`  no candidate "mesh"-component entity found (${pick.candidateCount} candidates) — skipping B.`);
  } else {
    const picked = pick.picked;
    console.log(`  scene centre (mesh-entity bounds): [${pick.centre.map((v) => v.toFixed(2))}]`);
    console.log(`  picked entity "${picked.name}" (id=${picked.id}) at [${picked.position.map((v) => v.toFixed(2))}], ${picked.tris} tris, dist-to-centre ${picked.dist.toFixed(2)}m (${pick.candidateCount} candidates considered)`);

    const runWindow = (entityId, { move, durationMs, amplitude }) =>
      page.evaluate(
        async ({ entityId, move, durationMs, amplitude }) => {
          const engine = globalThis.__engine;
          const entity = engine.entities.get(entityId);
          if (!entity) return { error: `entity ${entityId} not found at test time` };
          const baseX = entity.object3D.position.x;
          const frames = [];
          const transitions = [];
          let lastSuspended = engine.renderSuspended === true;
          let prev = null;
          await new Promise((resolve) => {
            const t0 = performance.now();
            const step = (now) => {
              const elapsed = now - t0;
              if (move) entity.object3D.position.x = baseX + Math.sin(elapsed * 0.002) * amplitude;
              const suspended = engine.renderSuspended === true;
              if (suspended !== lastSuspended) {
                transitions.push({ t: performance.timeOrigin + now, to: suspended });
                lastSuspended = suspended;
              }
              const tAbs = performance.timeOrigin + now;
              if (prev != null) frames.push({ t: tAbs, dt: now - prev });
              prev = now;
              if (elapsed < durationMs) requestAnimationFrame(step);
              else resolve();
            };
            requestAnimationFrame(step);
          });
          entity.object3D.position.x = baseX;
          return { frames, transitions, baseX };
        },
        { entityId, move, durationMs, amplitude },
      );

    const summarize = (frames) => {
      const dts = frames.map((f) => f.dt).filter((v) => Number.isFinite(v));
      const sorted = [...dts].sort((a, b) => a - b);
      const avg = dts.reduce((a, b) => a + b, 0) / (dts.length || 1);
      const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
      const worst = [...frames].sort((a, b) => b.dt - a.dt).slice(0, 10);
      return { avg, p95, worst, count: dts.length };
    };

    const report = (title, result) => {
      if (result.error) {
        console.log(`  ${title}: ERROR — ${result.error}`);
        return;
      }
      const s = summarize(result.frames);
      console.log(`\n  -- ${title} --`);
      console.log(`  frames: ${s.count}  avg ${s.avg.toFixed(2)}ms  p95 ${s.p95.toFixed(2)}ms`);
      console.log(`  10 worst frame deltas:`);
      for (const f of s.worst) {
        console.log(`    dt=${f.dt.toFixed(1)}ms @ ${new Date(f.t).toISOString()}`);
        const near = linesNear(f.t);
        if (near.length) near.forEach((l) => console.log(l));
        else console.log(`      (no console lines within ±1500ms)`);
      }
      if (result.transitions.length) {
        console.log(`  engine.renderSuspended transitions:`);
        for (const tr of result.transitions) console.log(`    -> ${tr.to} @ ${new Date(tr.t).toISOString()}`);
      } else {
        console.log(`  engine.renderSuspended transitions: (none)`);
      }
    };

    console.log(`\n  running 20s MOVING window (±2m sinusoidal on x)...`);
    const moving = await runWindow(picked.id, { move: true, durationMs: 20000, amplitude: 2 });
    report("20s MOVING", moving);

    console.log(`\n  running 10s STATIC baseline...`);
    const staticRun = await runWindow(picked.id, { move: false, durationMs: 10000, amplitude: 0 });
    report("10s STATIC baseline", staticRun);
  }
} catch (err) {
  console.log(`  SECTION B FAILED: ${err?.stack ?? err?.message ?? err}`);
}

// =============================================================================
// shared camera / screenshot helpers
// =============================================================================
const getCanvasBox = () =>
  page.evaluate(() => {
    const c = [...document.querySelectorAll("canvas")]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
    return { x: c.r.x, y: c.r.y, width: c.r.width, height: c.r.height };
  });

const shoot = async (savePath) => {
  const box = await getCanvasBox();
  const buf = savePath ? await page.screenshot({ path: savePath, clip: box }) : await page.screenshot({ clip: box });
  return buf;
};

const sampler = async (buffer) => {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  return (fx, fy) => {
    const px = Math.min(info.width - 1, Math.max(0, Math.round(fx * info.width)));
    const py = Math.min(info.height - 1, Math.max(0, Math.round(fy * info.height)));
    const i = (py * info.width + px) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
};
const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const projectPoints = (points) =>
  page.evaluate((pts) => {
    const engine = globalThis.__engine;
    const THREE = globalThis.__THREE;
    engine.camera.updateMatrixWorld(true);
    return pts.map(([x, y, z]) => {
      const v = new THREE.Vector3(x, y, z).project(engine.camera);
      return [(v.x + 1) / 2, (1 - v.y) / 2];
    });
  }, points);

const aimCamera = (eye, target) =>
  page.evaluate(
    ({ eye, target }) => {
      const engine = globalThis.__engine;
      const viewport = globalThis.__viewport;
      const EDITOR_LAYER = globalThis.__EDITOR_LAYER;
      if (!engine?.camera) return { hasCamera: false };
      engine.camera.position.set(...eye);
      engine.camera.lookAt(...target);
      if (viewport?.orbit) {
        viewport.orbit.target.set(...target);
        viewport.orbit.update();
      }
      engine.camera.updateMatrixWorld(true);
      engine.camera.layers.disable(EDITOR_LAYER);
      engine.scene.traverse((o) => {
        if (o.isGridHelper || o.type === "GridHelper") o.visible = false;
      });
      return { hasCamera: true, hasViewport: !!viewport?.orbit };
    },
    { eye, target },
  );

// =============================================================================
// C. SHADOW RING CAPTURE
// =============================================================================
console.log("\n=== C. SHADOW RING CAPTURE ===");
try {
  const emissive = await page.evaluate(() => {
    const engine = globalThis.__engine;
    const THREE = globalThis.__THREE;
    const EDITOR_LAYER = globalThis.__EDITOR_LAYER;
    const out = [];
    engine.scene.traverse((o) => {
      if (!o.isMesh || !o.material || o.layers.isEnabled(EDITOR_LAYER)) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const hot = mats.find((m) => (m?.emissiveIntensity ?? 0) > 1);
      if (!hot) return;
      const box = new THREE.Box3().setFromObject(o);
      if (box.isEmpty()) return;
      const c = box.getCenter(new THREE.Vector3());
      out.push({ name: o.name || "(unnamed)", emissiveIntensity: hot.emissiveIntensity, center: c.toArray() });
    });
    return out;
  });

  console.log(`  emissive meshes found (material.emissiveIntensity > 1): ${emissive.length}`);
  for (const e of emissive) console.log(`    ${e.name}  intensity=${e.emissiveIntensity}  center=[${e.center.map((v) => v.toFixed(2))}]`);

  if (!emissive.length) {
    console.log("  no emissive mesh found — skipping C.");
  } else {
    const wall = await page.evaluate((lamps) => {
      const engine = globalThis.__engine;
      const THREE = globalThis.__THREE;
      const EDITOR_LAYER = globalThis.__EDITOR_LAYER;
      const candidates = [];
      engine.scene.traverse((o) => {
        if (!o.isMesh || !o.geometry || o.layers.isEnabled(EDITOR_LAYER)) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        if (mats.some((m) => (m?.emissiveIntensity ?? 0) > 1)) return; // exclude lamps themselves
        const box = new THREE.Box3().setFromObject(o);
        if (box.isEmpty()) return;
        const size = box.getSize(new THREE.Vector3());
        const dims = [size.x, size.y, size.z].sort((a, b) => a - b);
        const area = dims[1] * dims[2];
        const center = box.getCenter(new THREE.Vector3());
        candidates.push({ name: o.name || "(unnamed)", min: box.min.toArray(), max: box.max.toArray(), center: center.toArray(), area });
      });
      const scoreAll = (proximityCap) => {
        let best = null;
        for (const lampC of lamps.map((l) => l.center)) {
          for (const c of candidates) {
            const dist = Math.hypot(c.center[0] - lampC[0], c.center[1] - lampC[1], c.center[2] - lampC[2]);
            if (proximityCap && dist > proximityCap) continue;
            const score = c.area / Math.max(1, dist);
            if (!best || score > best.score) best = { ...c, lampCenter: lampC, dist, score };
          }
        }
        return best;
      };
      return scoreAll(20) ?? scoreAll(null);
    }, emissive);

    if (!wall) {
      console.log("  no nearby wall/floor mesh found near any emissive mesh — skipping C.");
    } else {
      console.log(`  chosen surface "${wall.name}" (area~${wall.area.toFixed(1)}m2, ${wall.dist.toFixed(2)}m from lamp at [${wall.lampCenter.map((v) => v.toFixed(2))}])`);
      const min = wall.min, max = wall.max;
      const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
      let normalAxis = 0;
      for (let i = 1; i < 3; i++) if (size[i] < size[normalAxis]) normalAxis = i;
      const inPlane = [0, 1, 2].filter((i) => i !== normalAxis);
      const dominant = size[inPlane[0]] >= size[inPlane[1]] ? inPlane[0] : inPlane[1];
      const nearPoint = [0, 1, 2].map((i) => Math.min(Math.max(wall.lampCenter[i], min[i]), max[i]));
      let sign = Math.sign(wall.lampCenter[normalAxis] - wall.center[normalAxis]);
      if (sign === 0) sign = 1;
      const normalVec = [0, 0, 0];
      normalVec[normalAxis] = sign;

      const eyeFrom = (p, d) => {
        const eye = p.map((v, i) => v + normalVec[i] * d);
        if (normalAxis !== 1) eye[1] += d * 0.25;
        else eye[dominant] += d * 0.2;
        return eye;
      };

      const wallDiag = Math.hypot(size[inPlane[0]], size[inPlane[1]]);
      const dists = {
        wide: Math.min(60, Math.max(6, wallDiag * 1.1)),
        mid: Math.min(30, Math.max(3, wallDiag * 0.5)),
        close: Math.min(12, Math.max(1.5, wallDiag * 0.2)),
      };
      console.log(`  wall bbox size [${size.map((v) => v.toFixed(2))}], normal axis ${["x", "y", "z"][normalAxis]}, near-lamp point [${nearPoint.map((v) => v.toFixed(2))}]`);

      for (const [tag, d] of Object.entries(dists)) {
        const eye = eyeFrom(nearPoint, d);
        const aim = await aimCamera(eye, nearPoint);
        if (!aim.hasCamera) {
          console.log(`  WARN: no engine.camera when aiming "${tag}" shot`);
          continue;
        }
        await wait(900);
        const outPath = `scripts/gi-diag-game-rings-${tag}.png`;
        await shoot(outPath);
        console.log(`  SHOT ${outPath}  (eye=[${eye.map((v) => v.toFixed(2))}], dist=${d.toFixed(2)}m, hasViewport=${aim.hasViewport})`);
      }

      // Radial luminance profile: 24 points from directly-at-the-lamp (t=0)
      // outward along the wall's dominant in-plane axis, toward whichever
      // edge leaves more room to sample.
      const nearFrac = (nearPoint[dominant] - min[dominant]) / (size[dominant] || 1);
      const dir = nearFrac < 0.5 ? 1 : -1;
      const roomAlong = dir === 1 ? max[dominant] - nearPoint[dominant] : nearPoint[dominant] - min[dominant];
      const maxT = Math.min(roomAlong - 0.15, 8);

      if (maxT <= 0.2) {
        console.log(`  wall too thin along the dominant axis (room=${roomAlong.toFixed(2)}m) — skipping radial profile.`);
      } else {
        const N = 24;
        const pts = [];
        for (let i = 0; i < N; i++) {
          const t = (i / (N - 1)) * maxT;
          const p = nearPoint.slice();
          p[dominant] += dir * t;
          p[normalAxis] += sign * 0.03;
          pts.push(p);
        }
        const mid = pts[Math.floor(N / 2)];
        const fitDist = Math.max(maxT * 1.3, 3);
        const fitEye = eyeFrom(mid, fitDist);
        const aim = await aimCamera(fitEye, mid);
        await wait(900);
        if (aim.hasCamera) {
          const buf = await shoot(null);
          const screen = await projectPoints(pts);
          const offScreen = screen.filter(([x, y]) => x < 0.02 || x > 0.98 || y < 0.02 || y > 0.98).length;
          const at = await sampler(buf);
          const values = screen.map(([x, y]) => Math.round(lum(at(x, y))));
          console.log(`\n  radial luminance profile, ${N} points, t=0..${maxT.toFixed(2)}m along ${["x", "y", "z"][dominant]} from the near-lamp point:`);
          console.log(`    L: ${values.join(" ")}`);
          console.log(`    off-screen sample points: ${offScreen}/${N}${offScreen ? " — those values are CLAMPED EDGE PIXELS" : ""}`);
          let reversals = 0;
          for (let i = 2; i < values.length; i++) {
            const a = Math.sign(values[i - 1] - values[i - 2]);
            const b = Math.sign(values[i] - values[i - 1]);
            if (a !== 0 && b !== 0 && a !== b) reversals++;
          }
          console.log(`    direction reversals: ${reversals} (a smooth falloff is ~0-2; rings show up as many)`);
        } else {
          console.log("  WARN: no engine.camera for the radial profile shot — skipped.");
        }
      }
    }
  }
} catch (err) {
  console.log(`  SECTION C FAILED: ${err?.stack ?? err?.message ?? err}`);
}

// =============================================================================
// D. REFLECTION CHECK
// =============================================================================
console.log("\n=== D. REFLECTION CHECK ===");
try {
  const mirrors = await page.evaluate(() => {
    const engine = globalThis.__engine;
    const THREE = globalThis.__THREE;
    const EDITOR_LAYER = globalThis.__EDITOR_LAYER;
    // Graph-authored materials (shaderGraph/tslGraph) keep a STALE top-level
    // `.roughness`/`.metalness` scalar — giLight.js's own `staticRoughnessOf`
    // documents the identical trap (its comment: "the engine's own material
    // pipeline assigns [a roughnessNode] to EVERY material it builds ... every
    // editor-authored material" reads stale via the bare scalar). Reading only
    // `m.metalness`/`m.roughness` here made this search miss this scene's
    // actual "Box" mirror (graph principledBsdf metalness 1 / roughness 0,
    // stale top-level scalar 0 / 0.7) and only ever find the imported
    // character's plain (non-graph) GLTF material — which, being SKINNED, is
    // architecturally excluded from BVH exact reflections (a documented v1
    // gap: skinned meshes need a per-frame BLAS refit, "still open (v2)") and
    // so can NEVER show texture-at-hit, whatever exactReflections/hitLighting
    // are set to. Same bounded node-unwrap as staticRoughnessOf.
    const resolveScalar = (node, scalarFallback) => {
      if (node == null) return scalarFallback;
      let n = node;
      for (let depth = 0; depth < 8 && n; depth++) {
        if (n.isConstNode || n.isUniformNode) return typeof n.value === "number" ? n.value : scalarFallback;
        n = n.node ?? null;
      }
      return scalarFallback;
    };
    const matches = [];
    engine.scene.traverse((o) => {
      if (!o.isMesh || !o.material || o.layers.isEnabled(EDITOR_LAYER)) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const hit = mats.find((m) => {
        const metalness = resolveScalar(m?.metalnessNode, m?.metalness ?? 0);
        const roughness = resolveScalar(m?.roughnessNode, m?.roughness ?? 1);
        return metalness >= 0.8 && roughness <= 0.3;
      });
      if (!hit) return;
      const box = new THREE.Box3().setFromObject(o);
      if (box.isEmpty()) return;
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      matches.push({
        name: o.name || "(unnamed)",
        metalness: resolveScalar(hit.metalnessNode, hit.metalness),
        roughness: resolveScalar(hit.roughnessNode, hit.roughness),
        materialType: hit.type,
        isSkinned: !!o.isSkinnedMesh,
        center: sphere.center.toArray(),
        radius: sphere.radius,
      });
    });
    // Prefer a candidate the BVH can actually trace (not skinned — see
    // above) so D exercises texture-at-hit instead of landing on the one
    // candidate that is architecturally guaranteed to show zero delta;
    // /mirror/i name match stays the secondary tie-break.
    matches.sort((a, b) => {
      const bvhScore = (m) => (m.isSkinned ? 0 : 1);
      if (bvhScore(b) !== bvhScore(a)) return bvhScore(b) - bvhScore(a);
      return (/mirror/i.test(b.name) ? 1 : 0) - (/mirror/i.test(a.name) ? 1 : 0);
    });
    return matches;
  });

  console.log(`  mirror-ish meshes found (metalness>=0.8, roughness<=0.3): ${mirrors.length}`);
  for (const m of mirrors) console.log(`    ${m.name}  metalness=${m.metalness} roughness=${m.roughness} type=${m.materialType} r=${m.radius.toFixed(2)}`);

  if (!mirrors.length) {
    console.log("  no mirror-ish mesh found — skipping D.");
  } else {
    const mirror = mirrors[0];
    const dist = Math.max(mirror.radius * 4, 3) + 2;
    const dirVec = [0.5, 0.32, 1];
    const len = Math.hypot(...dirVec);
    const eye = mirror.center.map((v, i) => v + (dirVec[i] / len) * dist);
    const aim1 = await aimCamera(eye, mirror.center);
    if (!aim1.hasCamera) throw new Error("no engine.camera to aim at the mirror");
    await wait(1000);

    const offPath = "scripts/gi-diag-game-mirror-off.png";
    const bufOff = await shoot(offPath);
    console.log(`  SHOT ${offPath}  (mirror "${mirror.name}" at [${mirror.center.map((v) => v.toFixed(2))}], eye dist ${dist.toFixed(2)}m)`);

    const centerProj = await projectPoints([mirror.center]);
    const [cx, cy] = centerProj[0];
    const clamp01 = (v) => Math.min(0.98, Math.max(0.02, v));
    const offsets = [
      [0, 0],
      [0.04, 0],
      [-0.04, 0],
      [0, 0.04],
      [0, -0.04],
      [0.025, 0.025],
      [-0.025, -0.025],
    ];
    const screenPts = offsets.map(([dx, dy]) => [clamp01(cx + dx), clamp01(cy + dy)]);

    const atOff = await sampler(bufOff);
    const sampleOff = screenPts.map(([x, y]) => atOff(x, y));

    const giProps = inventory.giProps;
    console.log(`  exactReflections in the AUTHORED scene: ${giProps ? giProps.exactReflections : "(no GI component found in section A)"}`);

    if (!inventory.giEntityId) {
      console.log("  no global-illumination component was found in section A — cannot toggle exactReflections, stopping D here.");
    } else {
      const rebuildMark = Date.now();
      const setResult = await page.evaluate((giEntityId) => {
        const engine = globalThis.__engine;
        const entity = engine.entities.get(giEntityId);
        const component = entity?.components.get("global-illumination");
        const gi = engine.modules.get("gi");
        if (!component || !gi?.system) return { ok: false, error: "component or gi module system not found at rebuild time" };
        component.props.exactReflections = true;
        // Also flips hitLighting: texture-at-hit (GI Phase 3 v2) only
        // substitutes real texture detail for the mean-color mesh-SDF
        // albedo INSIDE the per-hit shading block, which is itself gated by
        // `light.hitLighting` (see giLight.js) — exactReflections alone
        // supplies the BVH t-source but not that per-hit shading path.
        component.props.hitLighting = true;
        gi.system.requestRebuild();
        return { ok: true };
      }, inventory.giEntityId);

      if (!setResult.ok) {
        console.log(`  FAILED to set exactReflections: ${setResult.error}`);
      } else {
        console.log(`  set component.props.exactReflections = true, component.props.hitLighting = true, called gi.system.requestRebuild() @ ${new Date(rebuildMark).toISOString()}`);

        // Wait for a NEW "[gi] built" line after the mark.
        let builtAt = null;
        for (let i = 0; i < 120 && !builtAt; i++) {
          const hit = consoleLog.find((e) => e.t >= rebuildMark && /\[gi\] built/.test(e.text));
          if (hit) builtAt = hit.t;
          else await wait(1000);
        }
        console.log(builtAt ? `  saw "[gi] built" @ ${new Date(builtAt).toISOString()} (+${builtAt - rebuildMark}ms)` : `  WARN: no "[gi] built" line seen within 120s of the rebuild request`);

        // Wait for the compile wave (renderSuspended) to finish, then the
        // instructed 5s settle on top.
        for (let i = 0; i < 90; i++) {
          const suspended = await page.evaluate(() => globalThis.__engine?.renderSuspended === true);
          if (!suspended) break;
          await wait(1000);
        }
        await wait(5000);

        const aim2 = await aimCamera(eye, mirror.center);
        await wait(500);
        const onPath = "scripts/gi-diag-game-mirror-on.png";
        const bufOn = await shoot(onPath);
        console.log(`  SHOT ${onPath}  (hasCamera=${aim2.hasCamera})`);

        const atOn = await sampler(bufOn);
        const sampleOn = screenPts.map(([x, y]) => atOn(x, y));

        console.log(`\n  mirror surface samples (7 points around the projected centre):`);
        console.log(`    OFF: ${sampleOff.map((c) => `rgb(${c.join(",")})`).join("  ")}`);
        console.log(`    ON:  ${sampleOn.map((c) => `rgb(${c.join(",")})`).join("  ")}`);
        const deltas = sampleOff.map((c, i) => Math.max(...c.map((v, k) => Math.abs(v - sampleOn[i][k]))));
        console.log(`    per-point max channel delta: ${deltas.join(", ")}`);
        const maxDelta = Math.max(...deltas);
        if (maxDelta < 6) {
          console.log(`  NOTHING CHANGED VISUALLY on the mirror (max delta ${maxDelta} < 6).`);
        } else {
          console.log(`  the mirror DID change (max delta ${maxDelta}).`);
        }

        // SUPPLEMENTARY TEXTURE PROBE. Every material actually authored in
        // this scene has map="" (checked against the project's own .mat
        // files) — the picked mirror reflects flat colors only, so nothing
        // above can show texture-at-hit either way, and exactReflections/
        // hitLighting were ALREADY true in the authored scene (see the
        // "AUTHORED scene" line above), so the OFF/ON delta being ~0 is
        // expected, not a failure. Add ONE real-image-textured sphere (the
        // project's own dark_rock_diff_1k.jpg) beside the mirror, IN MEMORY
        // ONLY (nothing written to disk — the project stays open read-only),
        // as a concrete demonstration inside this real project's own GI
        // setup rather than a synthetic harness rig.
        const probe = await page.evaluate(
          async ({ mirrorName, mirrorCenter, mirrorRadius, eye, texturePath }) => {
            const engine = globalThis.__engine;
            const THREE = globalThis.__THREE;
            try {
              // Re-find by bounding-sphere proximity, NOT by `o.name`: the
              // detection step's `name` field is a DISPLAY fallback
              // (`o.name || "(unnamed)"`), so an actually-unnamed mesh's
              // real `o.name` is `""` and never matches that string.
              const wantCenter = new THREE.Vector3(...mirrorCenter);
              let mirrorObj = null;
              let bestDist = Infinity;
              engine.scene.traverse((o) => {
                if (!o.isMesh || !o.geometry) return;
                const box = new THREE.Box3().setFromObject(o);
                if (box.isEmpty()) return;
                const sphere = box.getBoundingSphere(new THREE.Sphere());
                const d = sphere.center.distanceTo(wantCenter) + Math.abs(sphere.radius - mirrorRadius);
                if (d < bestDist) {
                  bestDist = d;
                  mirrorObj = o;
                }
              });
              if (!mirrorObj || bestDist > Math.max(0.5, mirrorRadius * 0.5)) {
                return { ok: false, error: `mirror object near [${mirrorCenter.map((v) => v.toFixed(2))}] r=${mirrorRadius.toFixed(2)} not found on re-traverse (best dist ${bestDist.toFixed(2)}, name "${mirrorName}")` };
              }

              const { loadTextureAsset } = await globalThis.__importLive("/src/engine/textureAsset.js");
              const map = await loadTextureAsset(texturePath, { colorSpace: THREE.SRGBColorSpace });

              // Thinnest local axis ~= a panel mirror's own facing normal.
              if (!mirrorObj.geometry.boundingBox) mirrorObj.geometry.computeBoundingBox();
              const size = new THREE.Vector3();
              mirrorObj.geometry.boundingBox.getSize(size);
              const axes = [
                { s: size.x, d: new THREE.Vector3(1, 0, 0) },
                { s: size.y, d: new THREE.Vector3(0, 1, 0) },
                { s: size.z, d: new THREE.Vector3(0, 0, 1) },
              ].sort((a, b) => a.s - b.s);
              mirrorObj.updateMatrixWorld(true);
              const worldNormal = axes[0].d.clone().transformDirection(mirrorObj.matrixWorld).normalize();
              const center = new THREE.Vector3(...mirrorCenter);
              const eyeVec = new THREE.Vector3(...eye);
              const towardEye = eyeVec.clone().sub(center).normalize();
              if (worldNormal.dot(towardEye) < 0) worldNormal.negate();

              const radius = Math.max(0.15, Math.min(0.6, mirrorRadius * 0.5));
              const sphere = new THREE.Mesh(
                new THREE.SphereGeometry(radius, 32, 24),
                new THREE.MeshStandardNodeMaterial({ map, roughness: 0.6, metalness: 0 }),
              );
              sphere.name = "GI-DIAG-texture-probe-sphere";
              sphere.position.copy(center).addScaledVector(worldNormal, mirrorRadius * 1.5);
              sphere.castShadow = true;
              sphere.receiveShadow = true;
              engine.scene.add(sphere);
              sphere.updateMatrixWorld(true);

              engine.modules.get("gi")?.system?.requestRebuild?.();

              return {
                ok: true,
                spherePos: sphere.position.toArray(),
                mirrorNormal: worldNormal.toArray(),
                hasImage: !!map?.image,
                imageSize: map?.image ? [map.image.width, map.image.height] : null,
              };
            } catch (err) {
              return { ok: false, error: err?.stack ?? err?.message ?? String(err) };
            }
          },
          { mirrorName: mirror.name, mirrorCenter: mirror.center, mirrorRadius: mirror.radius, eye, texturePath: `${PROJECT}/dark_rock_diff_1k.jpg` },
        );
        console.log(`  texture probe sphere: ${JSON.stringify(probe)}`);

        if (probe.ok) {
          const probeMark = Date.now();
          let probeBuiltAt = null;
          for (let i = 0; i < 60 && !probeBuiltAt; i++) {
            const hit = consoleLog.find((e) => e.t >= probeMark && /\[gi\] built/.test(e.text));
            if (hit) probeBuiltAt = hit.t;
            else await wait(1000);
          }
          console.log(probeBuiltAt ? `  probe rebuild seen @ +${probeBuiltAt - probeMark}ms` : "  WARN: no post-probe \"[gi] built\" line seen within 60s");
          for (let i = 0; i < 60; i++) {
            const suspended = await page.evaluate(() => globalThis.__engine?.renderSuspended === true);
            if (!suspended) break;
            await wait(1000);
          }
          await wait(3000);

          // Re-derived close-up camera placements (normal offset + guessed
          // lateral) kept landing the probe sphere out of frame or behind
          // nearer geometry in this small, oddly-shaped room — three
          // attempts, three misses. Decouple "safe framing" from "zoomed
          // view" instead: reuse the SAME eye/mirror.center pose the OFF/ON
          // shots already prove renders the whole room correctly, then crop
          // + upscale around the sphere's actual projected screen position
          // (computed exactly via projectPoints, not guessed) — no new
          // camera-geometry guesswork.
          const aimProbe = await aimCamera(eye, mirror.center);
          await wait(500);
          const probePath = "scripts/gi-diag-game-mirror-probe.png";
          const probeBuf = await shoot(probePath);
          console.log(`  SHOT ${probePath}  (textured-sphere-in-mirror demonstration, hasCamera=${aimProbe.hasCamera})`);

          const [sphereUV, mirrorUV] = await projectPoints([probe.spherePos, mirror.center]);
          console.log(`  probe sphere screen UV ${sphereUV.map((v) => v.toFixed(3))}, mirror screen UV ${mirrorUV.map((v) => v.toFixed(3))}`);
          const { info: probeInfo } = await sharp(probeBuf).raw().toBuffer({ resolveWithObject: true });
          const cropAround = async (uv, outPath, label) => {
            const cw = Math.round(probeInfo.width * 0.28);
            const ch = Math.round(probeInfo.height * 0.28);
            const cx = Math.min(probeInfo.width - cw, Math.max(0, Math.round(uv[0] * probeInfo.width - cw / 2)));
            const cy = Math.min(probeInfo.height - ch, Math.max(0, Math.round(uv[1] * probeInfo.height - ch / 2)));
            await sharp(probeBuf)
              .extract({ left: cx, top: cy, width: cw, height: ch })
              .resize(cw * 5, ch * 5, { kernel: "nearest" })
              .toFile(outPath);
            console.log(`  SHOT ${outPath}  (${label}, 5x crop around UV ${uv.map((v) => v.toFixed(3))})`);
          };
          await cropAround(sphereUV, "scripts/gi-diag-game-texture-sphere-direct.png", "probe sphere close-up");
          await cropAround(mirrorUV, "scripts/gi-diag-game-mirror-probe-zoom.png", "mirror surface close-up");
        }
      }
    }
  }

  const bvhLines = consoleLog.filter((e) => /\[gi\] bvh:/.test(e.text));
  console.log(`\n  every "[gi] bvh:" console line from the whole run: ${bvhLines.length}`);
  for (const e of bvhLines) console.log(`    [${new Date(e.t).toISOString().slice(11, 23)}] ${e.text}`);
} catch (err) {
  console.log(`  SECTION D FAILED: ${err?.stack ?? err?.message ?? err}`);
}

// ---------------------------------------------------------------------------
console.log("\n=== DONE ===");
console.log("screenshots:");
for (const f of [
  "scripts/gi-diag-game-rings-wide.png",
  "scripts/gi-diag-game-rings-mid.png",
  "scripts/gi-diag-game-rings-close.png",
  "scripts/gi-diag-game-mirror-off.png",
  "scripts/gi-diag-game-mirror-on.png",
]) {
  console.log(`  ${f}`);
}

await closeOnce();
process.exit(0);
