// WHAT DOES ONE EMISSIVE OBJECT ACTUALLY COST, AND WHICH PASS OWNS IT?
//
// The user's report (2026-08-07): "each emissive object is still -15-20 fps"
// and "try to spawn 4 emissive objects in a scene and move them, you will see
// heavy performance drop". Four is the whole analytic budget (MAX_EMITTERS),
// so this is the worst case the current design can be asked for.
//
// The measurement is a SWEEP INSIDE ONE PAGE LOAD, never a comparison between
// two loads. All four lamps exist from the first bake, so the resolve and the
// emitter shadow pass compile their four unrolled slots once and never again;
// an arm then makes 0/1/2/4 of them live by toggling `mesh.visible`, which
// `#refreshEmitterSlots` turns into `slot.radius = 0`. Nothing recompiles
// between arms, so every delta reported here is per-frame work, not pipeline
// churn or a different shader.
//
// Two axes, because the user named two things:
//   live   0 → 4 emitters      "each emissive object is -15-20 fps"
//   motion still / orbiting    "and move them"
//
// Per arm: median frame time (wall clock, the number the user feels) AND the
// per-pass GPU breakdown from profile.giPasses (which pass to actually fix).
// Wall clock alone says "slow"; the breakdown says where.
//
//   node node_modules/vite/bin/vite.js --port 5201 --strictPort
//   node scripts/run-gi-emissive-cost.mjs
//
// Env:
//   GEN_ROOT=<dir>     generated project location
//   LIVE=0,1,2,4       emitter counts to sweep
//   MOTION=0,1         still and/or orbiting
//   SETTLE=6000        ms to let the field settle after each arm change
//   FRAMES=240         frames per wall-clock sample
//   SAMPLES=24         dispatches per pass inside profile.giPasses
//   MOBILITY=dynamic   lamp giMobility (dynamic = exact path, auto/static = voxel)
//   GLOBALS=a=1,b=0    GI knobs set before any module runs
//   SHOT=<dir>         frame dumps
//   HEADED=1
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { makeEmissiveStormProject, LAMP_HOMES } from "./lib/makeEmissiveStormProject.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const GEN_ROOT = (process.env.GEN_ROOT ?? path.resolve("scripts/.gi-emissive-cost")).replaceAll("\\", "/");
const LIVE = (process.env.LIVE ?? "0,1,2,4").split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
const MOTION = (process.env.MOTION ?? "0,1").split(",").map((s) => s.trim() === "1");
const SETTLE = Number(process.env.SETTLE ?? 6000);
const FRAMES = Number(process.env.FRAMES ?? 240);
const SAMPLES = Number(process.env.SAMPLES ?? 24);
const MOBILITY = process.env.MOBILITY ?? "dynamic";
const SHOT = process.env.SHOT ?? ".gi-shots/emissive-cost";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// EMIT=1 reproduces the default an author gets from the Emission node with
// its strength slider untouched — the case where the promotion gate rejected
// saturated lamps outright.
const EMIT = Number(process.env.EMIT ?? 8);
// CLUTTER / MOVERS: scene WEIGHT, the axis that separates per-pixel cost from
// per-traversal cost. See makeEmissiveStormProject's `ring` note.
const CLUTTER = Number(process.env.CLUTTER ?? 0);
const MOVERS = Number(process.env.MOVERS ?? 0);
const SEGS = Number(process.env.SEGS ?? 24);
await makeEmissiveStormProject(GEN_ROOT, {
  lampMobility: MOBILITY, emitStrength: EMIT,
  clutterCount: CLUTTER, moverCount: MOVERS, clutterSegments: SEGS,
});
console.log(`  generated emissive-storm rig at ${GEN_ROOT}   lamps: giMobility=${MOBILITY} emitStrength=${EMIT} clutter=${CLUTTER}x${SEGS}seg movers=${MOVERS}`);
console.log(`  sweep: live=[${LIVE.join(",")}]  motion=[${MOTION.map((m) => (m ? "on" : "off")).join(",")}]`);
await mkdir(SHOT, { recursive: true });

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
const churn = [];
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built|dynamic-objects|occupancy backend|emitter shadows|bright emitters/i.test(t)) {
    console.log(`  ${t.slice(0, 185)}`);
  }
  if (/\[gi\] built/.test(t)) built = true;
  // Anything that re-bakes, re-voxelizes or recompiles DURING an arm is a
  // per-frame cost the pass timings will not show.
  if (/rebak|revoxel|recompil|reseat|cap reached|pool full/i.test(t)) churn.push(t);
  if (m.type() === "error" && !/favicon|404/.test(t)) console.log(`  console.error: ${t.slice(0, 200)}`);
});
page.on("pageerror", (e) => {
  const msg = e.message ?? String(e);
  if (!/save_scene/.test(msg)) console.log(`  pageerror: ${msg.slice(0, 200)}`);
});

const GLOBALS = (process.env.GLOBALS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (GLOBALS.length) console.log(`  globals: ${GLOBALS.join(" ")}`);
await page.evaluateOnNewDocument((project, globals) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__giDynObjectsDebug = true;
  for (const g of globals) {
    const [k, v] = g.split("=");
    globalThis[k] = v === "true" ? true : v === "false" ? false : Number.isFinite(Number(v)) ? Number(v) : v;
  }
}, GEN_ROOT, GLOBALS);

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

let entities = [];
for (let i = 0; i < 120; i++) {
  const r = await call("entity.list", {});
  if (r.ok && Array.isArray(r.value) && r.value.length > 0) { entities = r.value; break; }
  await wait(1000);
}
const cam = entities.find((e) => e.name === "Camera");
if (!cam) { console.log("FATAL: rig entities missing"); await browser.close(); process.exit(1); }
for (let i = 0; i < 240 && !built; i++) await wait(1000);
await wait(SETTLE);

// Park the viewport camera where the lamps, the crates and the floor pools are
// all on screen — every GI screen pass is per-pixel work over what is visible,
// so an off-target camera measures a different frame than the user sees.
await must("viewport.setCamera", { position: [0, 8.5, 10.5], target: [0, 0.6, 0] });
await wait(1500);

// The lamp control surface, installed once. Motion is driven from rAF rather
// than from play mode: play mode also starts scripts, physics and the game
// clock, all of which would land inside the measurement window.
const setup = await page.evaluate(async (homes, lampTag) => {
  const api = globalThis.__editorApi;
  let sys = null;
  for (const e of (await api.call("entity.list", {})) ?? []) {
    const s = api.entities.live(e.id)?.engine?.modules?.get("gi")?.system;
    if (s) { sys = s; break; }
  }
  if (!sys) return { error: "no gi system" };
  const scene = sys.engine?.scene;
  // MeshComponent does not name its three.Mesh after the entity (the census
  // printed "(unnamed)" for every row) and the ENTITY carries the transform,
  // so a lamp's own `position` is the origin. Identify by the tag the rig set
  // (`giMobility` is stamped on the mesh's userData) and order by WORLD
  // position, so `live=N` always lights the same N.
  const V = sys.engine?.scene?.position?.constructor;
  const wp = (o) => o.getWorldPosition(new V());
  const lamps = [];
  scene?.traverse?.((o) => {
    if (o.isMesh && /Sphere/i.test(o.geometry?.type ?? "") && o.userData?.giMobility === lampTag) lamps.push(o);
  });
  const near = (o, h) => { const p = wp(o); return Math.hypot(p.x - h[0], p.z - h[2]); };
  const homeOf = (o) => { const i = homes.findIndex((h) => near(o, h) < 0.8); return i < 0 ? 99 : i; };
  lamps.sort((a, b) => homeOf(a) - homeOf(b));
  // The rig moves lamps by writing `mesh.position`, but the transform lives on
  // the parent entity — writing the mesh's own local position would offset it
  // from a parent that keeps overwriting the world matrix. Move the PARENT.
  const movers = lamps.map((l) => l.parent ?? l);
  globalThis.__storm = {
    sys, lamps, movers, homes,
    motion: false,
    // Orbit each lamp on its own circle at its own rate: identical motion on
    // all four would let a cache or a coherence heuristic see one moving
    // object where the scene has four.
    tick(t) {
      if (!this.motion) return;
      for (let i = 0; i < this.movers.length; i++) {
        const h = this.homes[i], w = 0.7 + i * 0.23, r = 1.5;
        this.movers[i].position.set(h[0] + Math.cos(t * w) * r, h[1] + Math.sin(t * w * 0.6) * 0.5, h[2] + Math.sin(t * w) * r);
        this.movers[i].updateMatrixWorld(true);
      }
    },
  };
  const loop = (now) => {
    globalThis.__storm.tick(now / 1000);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  // WHY a lamp did or did not get an analytic slot. Promotion is gated on
  // `luminance >= 0.5` computed from the RESOLVED emissive × intensity, and a
  // lamp that fails it lights the scene only through the voxel field — which
  // is a different (and much blockier) product than the one being measured.
  const promoted = new Set((sys._emitterInfos ?? []).map((i) => i.mesh));
  // The same constant-fold the module's resolveMaterialSurface uses — an
  // engine material asset keeps its real emissive in `emissiveNode`
  // (`color × strength`), and `.emissive` sits at black.
  const constColor = (node, d = 0) => {
    if (!node || d > 8) return null;
    const v = node.value;
    if (v && typeof v === "object" && typeof v.r === "number") return { r: v.r, g: v.g, b: v.b };
    if (typeof v === "number") return { r: v, g: v, b: v };
    if ((node.op === "*" || node.op === "+") && node.aNode && node.bNode) {
      const a = constColor(node.aNode, d + 1), b = constColor(node.bNode, d + 1);
      if (a && b) {
        return node.op === "*"
          ? { r: a.r * b.r, g: a.g * b.g, b: a.b * b.b }
          : { r: a.r + b.r, g: a.g + b.g, b: a.b + b.b };
      }
    }
    return node.node ? constColor(node.node, d + 1) : null;
  };
  return {
    lamps: lamps.map((l, i) => {
      const mat = Array.isArray(l.material) ? l.material[0] : l.material;
      const resolved = constColor(mat?.emissiveNode);
      const e = resolved ?? mat?.emissive ?? { r: 0, g: 0, b: 0 };
      const k = resolved ? 1 : (mat?.emissiveIntensity ?? 1);
      const lum = (0.2126 * e.r + 0.7152 * e.g + 0.0722 * e.b) * k;
      const p = wp(l);
      return {
        i, pos: [p.x, p.y, p.z].map((v) => +v.toFixed(2)),
        emissive: [e.r, e.g, e.b].map((v) => +v.toFixed(3)), intensity: k,
        resolvedFromNode: !!resolved,
        luminance: +lum.toFixed(3), promoted: promoted.has(l),
        mobility: l.userData?.giMobility ?? "auto",
      };
    }),
    emitters: sys._emitterInfos?.length ?? 0,
  };
}, LAMP_HOMES, MOBILITY);

if (setup.error) { console.log(`FATAL: ${setup.error}`); await browser.close(); process.exit(1); }
console.log(`\n  lamps (promotion gate is resolved luminance >= 0.5):`);
for (const l of setup.lamps) {
  console.log(
    `    lamp${l.i} @${l.pos.join(",")}  emissive=[${l.emissive.join(",")}]${l.resolvedFromNode ? " (node)" : ` x${l.intensity}`}  ` +
      `luminance ${l.luminance}  mobility=${l.mobility}  ${l.promoted ? "PROMOTED" : "not promoted — FIELD ONLY"}`,
  );
}
console.log(`  promoted emitters at bake: ${setup.emitters}/4`);
if (setup.lamps.length !== 4) {
  console.log(`FATAL: expected 4 lamps, found ${setup.lamps.length}`);
  await browser.close();
  process.exit(1);
}
if (setup.emitters !== 4 && process.env.ALLOW_PARTIAL !== "1") {
  console.log(
    `FATAL: ${setup.emitters}/4 lamps promoted to analytic emitter slots — this rig measures the\n` +
      `       analytic emitter path, and with fewer slots live it measures something else.\n` +
      `       Set ALLOW_PARTIAL=1 to sweep anyway.`,
  );
  await browser.close();
  process.exit(1);
}

/** Wall-clock frame time the user actually feels: median + p95 over FRAMES. */
const frameTime = (frames) =>
  page.evaluate(
    (n) =>
      new Promise((resolve) => {
        const dt = [];
        let last = performance.now();
        const step = (now) => {
          dt.push(now - last);
          last = now;
          if (dt.length < n) requestAnimationFrame(step);
          else {
            // Drop the first 20: the arm change (visibility, motion) lands in
            // them and a settling frame is not a steady-state frame.
            const s = dt.slice(20).sort((a, b) => a - b);
            resolve({
              median: +s[Math.floor(s.length / 2)].toFixed(2),
              p95: +s[Math.floor(s.length * 0.95)].toFixed(2),
              fps: +(1000 / s[Math.floor(s.length / 2)]).toFixed(1),
            });
          }
        };
        requestAnimationFrame(step);
      }),
    frames,
  );

const results = [];
for (const motion of MOTION) {
  for (const live of LIVE) {
    churn.length = 0;
    const applied = await page.evaluate(
      ({ live, motion }) => {
        const S = globalThis.__storm;
        S.motion = motion;
        for (let i = 0; i < S.lamps.length; i++) {
          S.lamps[i].visible = i < live;
          // Motion off: park every lamp back on its home so the arms differ in
          // exactly one thing.
          if (!motion) { S.lamps[i].position.set(...S.homes[i]); S.lamps[i].updateMatrixWorld(true); }
        }
        return { visible: S.lamps.filter((l) => l.visible).length };
      },
      { live, motion },
    );
    await wait(SETTLE);
    const wall = await frameTime(FRAMES);
    // THREE PROFILE RUNS, MEDIAN PER PASS. profile.giPasses freezes the render
    // loop and then re-dispatches each pass with whatever uniforms the last
    // tick left — feedbackParity among them — so a single run can catch a
    // full-cell frame or a half-cell one. Repeating and taking the per-pass
    // median is what makes an 0→4 delta mean the emitters rather than which
    // parity the freeze happened to land on.
    const runs = [];
    for (let k = 0; k < 3; k++) {
      const r = await call("profile.giPasses", { samples: SAMPLES });
      if (r.ok) runs.push(r.value);
      await wait(1200);
    }
    const med = (xs) => {
      const s = xs.filter((v) => typeof v === "number").sort((a, b) => a - b);
      return s.length ? +s[Math.floor(s.length / 2)].toFixed(4) : null;
    };
    const prof = runs.length
      ? { ok: true, value: (() => {
          const base = runs[runs.length - 1];
          const mergeMap = (pick) => {
            const out = {};
            for (const k of new Set(runs.flatMap((r) => Object.keys(pick(r) ?? {})))) {
              const vals = runs.map((r) => pick(r)?.[k]);
              out[k] = typeof vals.find((v) => typeof v === "number") === "number"
                ? med(vals)
                : vals.find((v) => v !== undefined);
            }
            return out;
          };
          const screenPassesMs = mergeMap((r) => r.screenPassesMs);
          const queueMs = mergeMap((r) => r.queueMs);
          const sum = (o) => +Object.values(o).filter((v) => typeof v === "number").reduce((a, b) => a + b, 0).toFixed(3);
          return { ...base, screenPassesMs, queueMs, screenTotalMs: med(runs.map((r) => r.screenTotalMs)), queueTotalMs: sum(queueMs) };
        })() }
      : { ok: false, error: "all profile runs failed" };
    const liveSlots = await page.evaluate(() => {
      const S = globalThis.__storm;
      const st = S.sys.state ?? {};
      return {
        radii: (st.emitterSlots ?? []).map((s) => +(s.radius?.value ?? 0).toFixed(3)),
        adopted: S.sys._dynSet?.count?.() ?? 0,
        dynStats: S.sys._dynSet?.stats ?? null,
        // -1 = every cell this frame; 0/1 = half the cells (checkerboard).
        feedbackParity: st.feedbackParity?.value ?? null,
        cells: st.volume?.occupancyField?.dims ?? st.volume?.world?.dims ?? null,
      };
    });
    const row = {
      live, motion, wall, liveSlots, churn: [...new Set(churn)],
      prof: prof.ok ? prof.value : { error: prof.error },
    };
    results.push(row);
    const p = row.prof;
    console.log(
      `\n── live=${live} motion=${motion ? "ON " : "off"}  ${wall.median}ms (${wall.fps} fps, p95 ${wall.p95}ms)` +
        `   slots=[${liveSlots.radii.join(",")}]  adopted=${liveSlots.adopted}  feedbackParity=${liveSlots.feedbackParity}`,
    );
    if (p.error) console.log(`   profile failed: ${p.error}`);
    else {
      console.log(`   screen ${p.screenTotalMs}ms  queue ${p.queueTotalMs}ms   resolve px ${p.pixels?.resolve?.join("x")}  emitterShadow px ${p.pixels?.emitterShadow?.join("x")}`);
      const top = Object.entries({ ...p.screenPassesMs, ...p.queueMs })
        .filter(([, v]) => typeof v === "number")
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6);
      console.log(`   top: ${top.map(([k, v]) => `${k} ${v}`).join("  ·  ")}`);
    }
    if (row.churn.length) console.log(`   churn: ${row.churn.slice(0, 3).map((c) => c.slice(0, 110)).join(" | ")}`);
    await page.screenshot({ path: path.join(SHOT, `live${live}-motion${motion ? 1 : 0}.png`) });
  }
}

// ── REPORT ──────────────────────────────────────────────────────────────────
// The headline the user asked about is a DELTA: what does adding an emissive
// object cost? Reported per emitter so "15-20 fps each" has something to be
// compared against, and per PASS so the fix has an address.
const key = (live, motion) => results.find((r) => r.live === live && r.motion === motion);
const num = (v) => (typeof v === "number" ? v : null);

console.log(`\n\n=== MARGINAL COST OF ONE EMISSIVE OBJECT ===`);
for (const motion of MOTION) {
  const base = key(LIVE[0], motion);
  if (!base) continue;
  console.log(`\n  motion ${motion ? "ON" : "off"}   baseline live=${LIVE[0]}: ${base.wall.median}ms (${base.wall.fps} fps)`);
  for (const live of LIVE.slice(1)) {
    const r = key(live, motion);
    if (!r) continue;
    const dMs = +(r.wall.median - base.wall.median).toFixed(2);
    const dFps = +(r.wall.fps - base.wall.fps).toFixed(1);
    const n = live - LIVE[0];
    console.log(
      `    live=${live}: ${r.wall.median}ms (${r.wall.fps} fps)   Δ ${dMs >= 0 ? "+" : ""}${dMs}ms  ${dFps} fps` +
        `   →  ${(dMs / n).toFixed(2)}ms and ${(dFps / n).toFixed(1)} fps PER EMITTER`,
    );
  }
}

console.log(`\n=== WHICH PASS GREW (GPU ms, 0 → max emitters) ===`);
for (const motion of MOTION) {
  const lo = key(LIVE[0], motion), hi = key(LIVE[LIVE.length - 1], motion);
  if (!lo?.prof || !hi?.prof || lo.prof.error || hi.prof.error) continue;
  const flat = (p) => ({ ...p.screenPassesMs, ...p.queueMs });
  const a = flat(lo.prof), b = flat(hi.prof);
  const rows = [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .map((k) => ({ k, a: num(a[k]), b: num(b[k]) }))
    .filter((r) => r.a !== null || r.b !== null)
    .map((r) => ({ ...r, d: (r.b ?? 0) - (r.a ?? 0) }))
    .sort((x, y) => y.d - x.d);
  console.log(`\n  motion ${motion ? "ON" : "off"}   total screen ${lo.prof.screenTotalMs} → ${hi.prof.screenTotalMs}ms   queue ${lo.prof.queueTotalMs} → ${hi.prof.queueTotalMs}ms`);
  for (const r of rows.slice(0, 8)) {
    if (Math.abs(r.d) < 0.005) continue;
    console.log(`    ${r.k.padEnd(26)} ${String(r.a ?? "-").padStart(8)} → ${String(r.b ?? "-").padStart(8)}   Δ ${r.d >= 0 ? "+" : ""}${r.d.toFixed(3)}ms`);
  }
}

if (MOTION.length > 1) {
  console.log(`\n=== WHAT MOTION COSTS (same emitter count, still → orbiting) ===`);
  for (const live of LIVE) {
    const s = key(live, false), m = key(live, true);
    if (!s || !m) continue;
    console.log(
      `  live=${live}: ${s.wall.median}ms → ${m.wall.median}ms   Δ ${(m.wall.median - s.wall.median).toFixed(2)}ms` +
        `   (screen ${s.prof?.screenTotalMs} → ${m.prof?.screenTotalMs}, queue ${s.prof?.queueTotalMs} → ${m.prof?.queueTotalMs})`,
    );
  }
}

await writeFile(path.join(SHOT, "emissive-cost.json"), JSON.stringify(results, null, 2));
console.log(`\n  raw → ${path.join(SHOT, "emissive-cost.json")}`);
await browser.close();
process.exit(0);
