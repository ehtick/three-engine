// EMITTER-SHADOW PROBE — the "waffle grid" instrument (2026-08-06 —
// a big emissive panel's shadow channel etches a regular lattice across the
// floor). Big volume → coarse field cells, panel emitter + crate occluder;
// reads back the emitterShadow texture (channel 0 = slot 0, what materials
// sample) and PNGs it, plus a viewport screenshot for context.
// Env HATCH: none | noselfcut (__giNoOccSelfCut) | norecords
// (__giRayHitShadowRecords=false) | sphere (__giSphereEmitters).
// Arms: none (record-march default) | spherearm (__giEmitterRecordShadows=false,
// the legacy sphere trace) | noprobe (__giShadowAnalyticWidth=false — march+pen
// only) | kind (verdict-kind map) | tap (width-probe argmin-tap map) |
// noselfcut | norecords | sphere. STEPS=n overrides the macro budget.
//   HATCH=none node scripts/run-gi-emitter-shadow-probe.mjs <url>
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";

const url = process.argv[2] ?? "http://localhost:5335/";
const hatch = process.env.HATCH ?? "none";
const quality = process.env.QUALITY ?? "high";
const steps = Number(process.env.STEPS ?? 0);
// SLAB=1 — the LEAK arm: a thin (0.08m) wall between the panel and the
// floor, tall/wide enough that the floor strip behind it is geometrically
// FULLY occluded; the mean shadow value over that strip is the leak metric
// (0 = sealed). The thin-wall case is the width probe's known weak spot
// (log-spaced taps can straddle thin geometry), so this is the standing
// guard on the exhaustion→probe fallback.
const slab = process.env.SLAB === "1";
// SUN=1 — add a directional component light with Shadow Source "gi": the
// DIRECT-arm instrument on this same rig. PROFILE=1 folds shadow rays into
// the rayHitDebug counters (macro/brick/invalid limit columns). KINDSUB=1
// compiles the "sub" verdict-kind paint into the sun's raw shadow channel
// (miss=0 plane=32 tri=64 box=96 macroExhaust=128 brickLimit=159
// invalidBrick=191, 255=no-geometry/inactive) — the fail-closed attribution.
const sunOn = process.env.SUN === "1";
const profileOn = process.env.PROFILE === "1";
// KINDSUB=1 → "sub" verdict-kind paint; KINDSUB=2 → "burial" gate-factor
// paint (255 = open, 0 = fully buried); both bypass the burial multiply.
const kindSub = Number(process.env.KINDSUB ?? 0);
// SUNPOS=x,y,z — sun position (direction = toward origin); default 6,8,4.
const sunPos = (process.env.SUNPOS ?? "6,8,4").split(",").map(Number);
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
// THE COMPOSITE-NEVER-LANDED FLAKE, and why it is tracked rather than tolerated.
// Measured 1 run in 4 (2026-08-09): the probe reported `penumbraPx=0 grain=0.0000`
// on unchanged code that gave 16601/0.0307 on the three runs around it. A zero
// here is indistinguishable from "the emitter shadow chain is broken" — it is the
// same signature — and the ONLY thing separating them in the output was the
// absence of the field-ready line, i.e. the pyramid had not been voxelized before
// the measurement took its readback. That makes it an instrument fault, and
// an instrument that reports a plausible wrong number is worse than one that
// fails: this rig's whole purpose is A/B-ing a shadow chain against a recorded
// number. So the composite log is now a PRECONDITION of the measurement.
//
// `diffuse indirect` is in the filter for the SRC interregnum: with the dense
// transport deleted (plan §12.8) every bounce reads zero, and that line is what
// separates "expected" from the several failure modes that look identical.
let sawComposite = false;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] field ready:/.test(t)) sawComposite = true;
  if (/\[gi\] (built|light shadows|emitters|field ready|diffuse indirect)|PROBE/.test(t)) console.log(`  ${t.slice(0, 200)}`);
});
page.on("pageerror", (e) => console.log(`pageerror: ${e.message}`));
await page.goto(url, { waitUntil: "load", timeout: 30000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await new Promise((r) => setTimeout(r, 5000));

const floorY = Number(process.env.FLOORY ?? 0);
// EMITTERS=0,1,2,4,6 — the COST-CURVE arm: steps the number of emissive
// panels and records whole-frame GPU medians + the promoted-slot set at each
// count. Answers "how much does each emissive cost" and "what happens past
// MAX_EMITTERS" with numbers instead of fps feel. Skips the shadow-texture
// metrics (the scene keeps changing).
const emitterCounts = process.env.EMITTERS
  ? process.env.EMITTERS.split(",").map(Number).filter((n) => Number.isFinite(n))
  : null;
// MOVER=1 — the OBJECT-MOTION shadow instrument (plan §7.1, shadow channel):
// a cube ON THE FLOOR (present from boot so it is in the GI fingerprint),
// measured still vs rotating: per-frame step amplitude of the sun's raw
// shadow channel + (with KINDSUB=1) the verdict-kind counts per phase —
// box-kind growth under rotation convicts the contact/complex fallback,
// raw-delta growth without kind change convicts the width term.
const moverOn = process.env.MOVER === "1";
// INTERMIT=1 — the REFIT-INTERMITTENCY instrument (session 30f fix queue b):
// the user's Sponza screenshot shows RANDOM DARK SQUARE PIECES protruding
// from a mover's shadow on some frames only. Hypotheses to separate:
//   H1 dyn-tail overflow      → box px spikes correlate with
//                               dynamicOverflowBricks>0 / allocated≈capacity
//   H2 half-executed chain    → spikes correlate with pendingPipelines>0 or
//                               full-chain dispatches (skipped computes)
//   H3 static-cells-in-brick  → steady box floor, present while STILL too
//   H4 stale-pose (frame lag) → raw churn with ZERO box kinds
// Needs SUN=1 KINDSUB=1. Samples the raw kind map + readbackSurfaceAlloc +
// dispatch counters as fast as readback allows while rotating the mover on
// TWO axes (the user's script: rotation.x/y += dt*0.6, edit-mode update).
// PRESSURE=n adds n dense torus-knot static meshes first (Sponza-class
// record/triangle pool pressure — my clean rig could not reproduce).
const intermitOn = process.env.INTERMIT === "1";
const pressure = Number(process.env.PRESSURE ?? 0);
const intermitMs = Number(process.env.DUR ?? 12000);
// MOVERY — mover height (default 0.6 = resting on the floor; ~2.5 = the
// floating-caster case where the width probe's coarse distanceTexture
// owns the penumbra shape).
const moverY = Number(process.env.MOVERY ?? 0.6);
// SOURCEANGLE — the sun's authored source angle (default 10; 0 = the user's
// razor-sun case where any visible softness is a bug).
const sourceAngle = Number(process.env.SOURCEANGLE ?? 10);
// SRCVOL=legacy|probe|trace|both — THE §12.6 A/B, now inverted. The oracle
// arms (`srcVolume.js`) are the DEFAULT as of §12.6, so **`SRCVOL=legacy` is
// the baseline** and an unset SRCVOL measures the shipping oracle path; `probe`
// and `trace` still isolate one consumer each when the default is overridden
// elsewhere. This probe is the right gate for the pair because its two headline
// metrics ARE the failure class the (refuted) blocker predicted: `grain` is the
// waffle-lattice number (a voxel-quantized distance etching a regular pattern
// into the floor) and `leak` is the seal. Composes with HATCH, so
// `SRCVOL=legacy HATCH=spherearm` is the legacy sphere arm on the composited
// distance — the pre-§12.6 shipping shadow.
const srcVol = process.env.SRCVOL ?? "";
const result = await page.evaluate(async ({ hatch, quality, steps, slab, sunOn, profileOn, kindSub, sunPos, floorY, emitterCounts, moverOn, moverY, sourceAngle, intermitOn, pressure, intermitMs, srcVol }) => {
  globalThis.__probeFloorY = floorY;
  globalThis.__editorKeepRendering = true;
  if (hatch === "noselfcut") globalThis.__giNoOccSelfCut = true;
  if (hatch === "norecords") globalThis.__giRayHitShadowRecords = false;
  if (hatch === "sphere") globalThis.__giSphereEmitters = true;
  if (hatch === "spherearm") globalThis.__giEmitterRecordShadows = false;
  if (steps) globalThis.__giDirectShadowSteps = steps;
  if (hatch === "kind") globalThis.__giEmitterShadowKindDebug = true;
  if (hatch === "noprobe") globalThis.__giShadowAnalyticWidth = false;
  if (hatch === "tap") globalThis.__giWidthProbeDebugTap = true;
  if (srcVol) globalThis.__giSrcVolumeShadows = srcVol;
  if (kindSub) {
    globalThis.__giShadowKindDebug =
      kindSub === 10 ? "normy" :
      kindSub === 9 ? "freenan" : kindSub === 8 ? "free075" : kindSub === 7 ? "diry" : kindSub === 6 ? "gate" :
      kindSub === 5 ? "voxmax" : kindSub === 4 ? "freeabs" : kindSub === 3 ? "free" : kindSub === 2 ? "burial" : "sub";
  }
  if (profileOn) globalThis.__giShadowProfile = true;
  const { THREE } = await import("/src/engine/index.js");
  await import("/src/modules/index.js");
  const { enableEngineModule } = await import("/src/engine/modules.js");
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  await enableEngineModule(engine, "gi");
  for (const entity of [...engine.entities.values()]) engine.destroyEntity(entity);
  for (const child of [...engine.scene.children]) if (child.isMesh) engine.scene.remove(child);
  const anon = (g) => { const n = g.toNonIndexed(); n.parameters = undefined; n.type = "BufferGeometry"; return n; };
  const grey = new THREE.MeshStandardNodeMaterial({ color: 0x999999, roughness: 0.9 });
  const floor = new THREE.Mesh(anon(new THREE.BoxGeometry(30, 0.3, 30)), grey);
  // FLOORY: offset the floor's TOP surface (default 0 = coplanar with the
  // editor grid at y=0 — which z-fights in the gbuffer; see SUN-KINDS notes).
  floor.position.y = -0.15 + Number(globalThis.__probeFloorY ?? 0);
  const crate = new THREE.Mesh(anon(new THREE.BoxGeometry(1.2, 1.2, 1.2)), grey);
  crate.position.set(0, 0.6, 0);
  // The panel: a tall emissive slab standing behind the crate, like the
  // user's screenshot.
  const glowMat = new THREE.MeshStandardNodeMaterial({ color: 0x111111, roughness: 0.9 });
  glowMat.emissive = new THREE.Color(1, 1, 1);
  glowMat.emissiveIntensity = 8;
  const panel = new THREE.Mesh(anon(new THREE.BoxGeometry(5, 4, 0.3)), glowMat);
  panel.position.set(0, 2, -6);
  engine.scene.add(floor, crate, panel);
  // PRESSURE: dense curved static geometry ringing the rig — fills the
  // static record pool and the complex triangle pool the way Sponza does
  // (the intermittency never reproduced on the clean rig; pool pressure is
  // the named delta). Static-only: they never move, so fast chains skip them.
  if (pressure > 0) {
    for (let i = 0; i < pressure; i++) {
      const a = (i / pressure) * Math.PI * 2;
      const r = 8 + (i % 3) * 2;
      const knot = new THREE.Mesh(
        anon(new THREE.TorusKnotGeometry(0.6, 0.2, 48, 12)), grey);
      knot.position.set(Math.cos(a) * r, 0.8, Math.sin(a) * r);
      knot.rotation.set(i * 0.7, i * 1.3, i * 0.4);
      knot.updateMatrixWorld(true);
      engine.scene.add(knot);
    }
  }
  // MOVER: on the floor (ground contact = the mixed-brick case), present
  // BEFORE the GI entity so it lives in the field fingerprint from boot.
  let mover = null;
  if (moverOn || intermitOn) {
    mover = new THREE.Mesh(anon(new THREE.BoxGeometry(1.2, 1.2, 1.2)), grey);
    mover.position.set(2.5, moverY + floorY, 2.5);
    mover.updateMatrixWorld(true);
    engine.scene.add(mover);
  }
  if (slab) {
    const wall = new THREE.Mesh(anon(new THREE.BoxGeometry(6, 3, 0.08)), grey);
    wall.position.set(0, 1.5, -3);
    engine.scene.add(wall);
  }
  const cam = engine.camera;
  cam?.position?.set(7, 7, 9);
  cam?.lookAt?.(0, 0, 0);
  if (sunOn) {
    // The DIRECT arm on this rig: a component light claiming Shadow Source
    // "gi" (same recipe as the smoke's lightshadow arm).
    engine.renderer.shadowMap.enabled = true;
    const sunEnt = engine.createEntity({ name: "Probe Sun" });
    sunEnt.addComponent("light", {
      type: "directional", color: "#ffffff", intensity: 3,
      castShadow: true, shadowMode: "gi", sourceAngle,
    });
    sunEnt.object3D?.position?.set(sunPos[0], sunPos[1], sunPos[2]);
    // AIM the light: directional direction comes from the entity's ROTATION
    // (forward −z), not its position. Without this the sun points (0,0,−1) —
    // horizontal — every floor pixel fails the 0.05 terminator gate and the
    // whole floor paints black. (This exact authoring slip is how the
    // session-29 "⅓ exhaustion clamps" reading happened: gate-fail, burial
    // and exhaustion were indistinguishable in that map.)
    // The component's light aims along the entity's +z (verified via the
    // diry paint: lookAt(origin) produced a sun shining UP), so look at the
    // antipode to shine down through the origin.
    sunEnt.object3D?.lookAt?.(sunPos[0] * 2, sunPos[1] * 2, sunPos[2] * 2);
    sunEnt.object3D?.updateMatrixWorld?.(true);
  }

  const gi = engine.createEntity({ name: "GI Emissive Probe" });
  // ONE PROPERTY on the component. `emissiveShadows` is the feature this probe
  // MEASURES and no preset turns it on (it is a named component of the
  // emissive-projectile frame cost), so it is forced through the measurement
  // hatch — without it the emitter-shadow targets are never built and the
  // readback below fails on an undefined texture rather than a wrong number.
  globalThis.__giConfigOverride = { emissiveShadows: true };
  if (profileOn) globalThis.__giRayHitProfiling = true;
  gi.addComponent("global-illumination", { quality });
  const system = engine.modules.get("gi").system;
  const deadline = performance.now() + 90_000;
  let screen = null;
  while (performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    screen = system.state?.screen ?? null;
    if (screen && (system.state?.volume?.occupancyField?.stats?.dispatches ?? 0) > 3) break;
  }
  if (!screen) return { fail: "GI never built a screen bundle" };
  {
    const end = performance.now() + 60_000;
    let quiet = 0;
    while (performance.now() < end && quiet < 5) {
      await new Promise((r) => setTimeout(r, 200));
      const d = system.state?.volume?.occupancyField?.debugIncremental;
      quiet = globalThis.__giPendingComputePipelines?.size === 0 && d && !d.dirty && !d.staticDirty ? quiet + 1 : 0;
    }
  }
  await new Promise((r) => setTimeout(r, 2000));
  if (intermitOn && mover) {
    // ── REFIT-INTERMITTENCY ARM (see the env note up top for hypotheses) ──
    const sb = system.state?.screen;
    if (!sb?.targets?.lightShadowRaw) return { fail: "intermit arm needs SUN=1 (no lightShadowRaw)" };
    if (!kindSub) return { fail: "intermit arm needs KINDSUB=1 (kind attribution)" };
    const W3 = sb.shadowWidth, H3 = sb.shadowHeight;
    const stride3 = Math.ceil((W3 * 4) / 256) * 256;
    const occF = system.state.volume.occupancyField;
    const countKinds = (A) => {
      const c = { miss: 0, plane: 0, tri: 0, box: 0, macroExhaust: 0, brickLimit: 0, invalidBrick: 0, other: 0 };
      for (let y = 0; y < H3; y++) {
        const row = y * stride3;
        for (let x = 0; x < W3; x++) {
          const b = A[row + x * 4];
          if (b < 16) c.miss++;
          else if (Math.abs(b - 32) <= 8) c.plane++;
          else if (Math.abs(b - 64) <= 8) c.tri++;
          else if (Math.abs(b - 96) <= 8) c.box++;
          else if (Math.abs(b - 128) <= 8) c.macroExhaust++;
          else if (Math.abs(b - 159) <= 8) c.brickLimit++;
          else if (Math.abs(b - 191) <= 8) c.invalidBrick++;
          else if (b < 250) c.other++;
        }
      }
      return c;
    };
    const sampleOnce = async () => {
      const tex = await engine.renderer.backend.copyTextureToBuffer(sb.targets.lightShadowRaw, 0, 0, W3, H3);
      const alloc = await occF.readbackSurfaceAlloc(engine.renderer);
      const st = occF.stats ?? {};
      return {
        kinds: countKinds(tex), tex,
        dynAlloc: alloc?.dynamicAllocated ?? -1,
        dynOver: alloc?.dynamicOverflowBricks ?? -1,
        dynTris: alloc?.dynamicTriangles ?? -1,
        dynTriOver: alloc?.dynamicComplexOverflowCells ?? -1,
        dispatches: st.dispatches ?? -1,
        fastDispatches: st.fastDispatches ?? 0,
        pending: globalThis.__giPendingComputePipelines?.size ?? -1,
      };
    };
    const pngOf = (A) => {
      const c = document.createElement("canvas");
      c.width = W3; c.height = H3;
      const ctx = c.getContext("2d");
      const id = ctx.createImageData(W3, H3);
      for (let y = 0; y < H3; y++) {
        const row = y * stride3;
        for (let x = 0; x < W3; x++) {
          const i = y * W3 + x, b = A[row + x * 4];
          id.data[i * 4] = b; id.data[i * 4 + 1] = b; id.data[i * 4 + 2] = b; id.data[i * 4 + 3] = 255;
        }
      }
      ctx.putImageData(id, 0, 0);
      return c.toDataURL("image/png");
    };
    // Still-phase baseline (3 samples).
    const still = [];
    for (let i = 0; i < 3; i++) { still.push(await sampleOnce()); await new Promise((r) => setTimeout(r, 150)); }
    const staticAlloc = await occF.readbackSurfaceAlloc(engine.renderer);
    // The user's script, verbatim cadence: two-axis rotation at 0.6 rad/s
    // driven per frame (rAF), not a coarse interval.
    let last = performance.now(), rotating = true;
    const spin = () => {
      if (!rotating) return;
      const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      mover.rotation.x += dt * 0.6;
      mover.rotation.y += dt * 0.6;
      mover.updateMatrixWorld(true);
      requestAnimationFrame(spin);
    };
    requestAnimationFrame(spin);
    await new Promise((r) => setTimeout(r, 500)); // enter the rotating regime
    const series = [];
    let worst = null;
    const tEnd = performance.now() + intermitMs;
    while (performance.now() < tEnd) {
      const s = await sampleOnce();
      const { tex, ...rest } = s;
      const badPx = rest.kinds.box + rest.kinds.macroExhaust + rest.kinds.brickLimit + rest.kinds.invalidBrick;
      rest.badPx = badPx;
      series.push(rest);
      if (!worst || badPx > worst.badPx) worst = { badPx, png: pngOf(tex), sample: rest };
    }
    rotating = false;
    // Summaries the hypotheses read directly.
    const nums = (k) => series.map((s) => s[k]);
    const stat = (xs) => {
      const ys = [...xs].sort((a, b) => a - b);
      return { min: ys[0], med: ys[Math.floor(ys.length / 2)], p95: ys[Math.floor(ys.length * 0.95)], max: ys[ys.length - 1] };
    };
    const spikes = series.filter((s) => s.badPx > (still[still.length - 1].kinds.box + 50));
    return {
      intermit: {
        samples: series.length,
        stillKinds: still.map((s) => s.kinds),
        stillDyn: { alloc: still.map((s) => s.dynAlloc), over: still.map((s) => s.dynOver) },
        staticPool: staticAlloc ? {
          records: `${staticAlloc.allocated}/${staticAlloc.capacity}`,
          overflow: staticAlloc.overflowBricks,
          triangles: `${staticAlloc.triangles}/${staticAlloc.triangleCapacity}`,
          triOverflowCells: staticAlloc.complexOverflowCells,
          dynCapacity: staticAlloc.dynamicCapacity,
        } : null,
        badPx: stat(nums("badPx")),
        box: stat(series.map((s) => s.kinds.box)),
        fail: stat(series.map((s) => s.kinds.macroExhaust + s.kinds.brickLimit + s.kinds.invalidBrick)),
        tri: stat(series.map((s) => s.kinds.tri)),
        plane: stat(series.map((s) => s.kinds.plane)),
        dynAlloc: stat(nums("dynAlloc")),
        dynOver: stat(nums("dynOver")),
        dynTris: stat(nums("dynTris")),
        dynTriOver: stat(nums("dynTriOver")),
        pendingNonzero: series.filter((s) => s.pending > 0).length,
        chainDelta: {
          total: series[series.length - 1].dispatches - series[0].dispatches,
          fast: series[series.length - 1].fastDispatches - series[0].fastDispatches,
        },
        spikeCount: spikes.length,
        spikeWithOverflow: spikes.filter((s) => s.dynOver > 0 || s.dynTriOver > 0).length,
        spikeWithPending: spikes.filter((s) => s.pending > 0).length,
        worstSample: worst?.sample ?? null,
      },
      worstPng: worst?.png ?? null,
      stillPng: pngOf((await sampleOnce()).tex),
    };
  }
  if (moverOn && mover) {
    // OBJECT-MOTION SHADOW METRIC: still-phase vs rotating-phase per-frame
    // deltas of the sun's raw channel (production values without KINDSUB,
    // verdict-kind churn with KINDSUB=1).
    const sb = system.state?.screen;
    if (!sb?.targets?.lightShadowRaw) return { fail: "mover arm needs SUN=1 (no lightShadowRaw)" };
    const W3 = sb.shadowWidth, H3 = sb.shadowHeight;
    const stride3 = Math.ceil((W3 * 4) / 256) * 256;
    const grab = async () => engine.renderer.backend.copyTextureToBuffer(sb.targets.lightShadowRaw, 0, 0, W3, H3);
    const deltaOf = (A, B) => {
      const diffs = new Array(W3 * H3);
      let di = 0, changed = 0;
      for (let y = 0; y < H3; y++) {
        const row = y * stride3;
        for (let x = 0; x < W3; x++) {
          const d = Math.abs(A[row + x * 4] - B[row + x * 4]);
          diffs[di++] = d;
          if (d > 2) changed++;
        }
      }
      diffs.sort((a, b) => a - b);
      return { p95: diffs[Math.floor(di * 0.95)], p99: diffs[Math.floor(di * 0.99)], changedPx: changed };
    };
    const kindsOf = (A) => {
      if (!kindSub) return null;
      const counts = { miss: 0, plane: 0, tri: 0, box: 0, fail: 0, other: 0 };
      for (let y = 0; y < H3; y++) {
        const row = y * stride3;
        for (let x = 0; x < W3; x++) {
          const b = A[row + x * 4];
          if (b < 16) counts.miss++;
          else if (Math.abs(b - 32) <= 5) counts.plane++;
          else if (Math.abs(b - 64) <= 5) counts.tri++;
          else if (Math.abs(b - 96) <= 5) counts.box++;
          else if (b >= 120 && b <= 200) counts.fail++;
          else counts.other++;
        }
      }
      return counts;
    };
    const s1 = await grab();
    await new Promise((r) => setTimeout(r, 400));
    const s2 = await grab();
    const rot = setInterval(() => {
      mover.rotation.y += 0.01;
      mover.updateMatrixWorld(true);
    }, 30);
    await new Promise((r) => setTimeout(r, 2500));
    const m1 = await grab();
    await new Promise((r) => setTimeout(r, 400));
    const m2 = await grab();
    clearInterval(rot);
    // Post-rotation still: wait past the ~90-quiet-frame demote + settle.
    await new Promise((r) => setTimeout(r, 4000));
    const p1 = await grab();
    const pngOf = (A) => {
      const c = document.createElement("canvas");
      c.width = W3; c.height = H3;
      const ctx = c.getContext("2d");
      const id = ctx.createImageData(W3, H3);
      for (let y = 0; y < H3; y++) {
        const row = y * stride3;
        for (let x = 0; x < W3; x++) {
          const i = y * W3 + x, b = A[row + x * 4];
          id.data[i * 4] = b; id.data[i * 4 + 1] = b; id.data[i * 4 + 2] = b; id.data[i * 4 + 3] = 255;
        }
      }
      ctx.putImageData(id, 0, 0);
      return c.toDataURL("image/png");
    };
    return {
      moverStill: { ...deltaOf(s1, s2), kinds: kindsOf(s2) },
      moverRotating: { ...deltaOf(m1, m2), kinds: kindsOf(m2) },
      // Cross-phase: how different is the rotating regime from still, and
      // does stopping restore the still image?
      crossStillVsRot: deltaOf(s2, m2),
      crossStillVsPost: deltaOf(s2, p1),
      stillPng: pngOf(s2),
      rotPng: pngOf(m2),
      postPng: pngOf(p1),
    };
  }
  if (emitterCounts) {
    // COST-CURVE ARM: step the emissive count, keep GI awake with a wiggling
    // crate (the game-representative state), record whole-frame GPU medians
    // (engine.stats gpuMs = real resolved timestamps, EMA'd) per count.
    const glowOf = () => {
      const m = new THREE.MeshStandardNodeMaterial({ color: 0x111111, roughness: 0.9 });
      m.emissive = new THREE.Color(1, 1, 1);
      m.emissiveIntensity = 8;
      return m;
    };
    const extras = [];
    const curve = [];
    const sortedCounts = [...emitterCounts].sort((a, b) => a - b);
    const sample = async (label) => {
      let flip = 1;
      const wig = setInterval(() => {
        crate.position.x += 0.02 * (flip = -flip);
        crate.updateMatrixWorld(true);
      }, 50);
      await new Promise((r) => setTimeout(r, 4000)); // pipeline settle after adds
      const xs = [];
      const t0 = performance.now();
      while (performance.now() - t0 < 5000) {
        await new Promise((r) => setTimeout(r, 200));
        const v = engine.stats?.readout?.gpuMs;
        if (Number.isFinite(v) && v > 0) xs.push(v);
      }
      clearInterval(wig);
      xs.sort((a, b) => a - b);
      const med = xs.length ? xs[Math.floor(xs.length / 2)] : -1;
      const promoted = system._emitterInfos ?? [];
      curve.push({ n: label, gpuMs: +med.toFixed(2), samples: xs.length, promoted: promoted.length });
    };
    for (const n of sortedCounts) {
      if (n === 0) {
        panel.material.emissiveIntensity = 0;
        panel.material.needsUpdate = true;
      } else {
        if (panel.material.emissiveIntensity === 0) {
          panel.material.emissiveIntensity = 8;
          panel.material.needsUpdate = true;
        }
        while (extras.length < n - 1) {
          const p = new THREE.Mesh(anon(new THREE.BoxGeometry(1.5, 1.2, 0.2)), glowOf());
          const a = extras.length * 1.1 + 0.6;
          p.position.set(Math.cos(a) * 5, 1.2, Math.sin(a) * 5);
          p.lookAt(0, 1.2, 0);
          engine.scene.add(p);
          p.updateMatrixWorld(true);
          extras.push(p);
        }
      }
      await sample(n);
    }
    // Promoted-set stability: does moving an unrelated object reshuffle the
    // promoted 4 when more candidates exist than slots?
    const idsOf = () => (system._emitterInfos ?? []).map((i) => i.mesh?.uuid ?? "prov").join("|");
    const setA = idsOf();
    crate.position.x += 0.3;
    crate.updateMatrixWorld(true);
    await new Promise((r) => setTimeout(r, 1500));
    const setB = idsOf();
    return { costCurve: curve, promotedStable: setA === setB };
  }
  const emitters = system.state?.emitterSlots?.length ?? 0;
  // The emitter shadow texture lives at the SHADOW-channel resolution since
  // the pass split (2026-08-06).
  const W = screen.emitterShadowWidth ?? screen.shadowWidth ?? screen.width, H = screen.emitterShadowHeight ?? screen.shadowHeight ?? screen.height;
  const strideBytes = Math.ceil((W * 4) / 256) * 256;
  const data = await engine.renderer.backend.copyTextureToBuffer(screen.targets.emitterShadow, 0, 0, W, H);
  const img = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * strideBytes;
    for (let x = 0; x < W; x++) img[y * W + x] = data[row + x * 4] / 255;
  }
  const inPen = (v) => v > 0.08 && v < 0.92;
  let sum = 0, n = 0;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    if (!inPen(img[i])) continue;
    sum += Math.abs(img[i] * 4 - img[i - 1] - img[i + 1] - img[i - W] - img[i + W]); n++;
  }
  const toPng = (im) => {
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d");
    const id = ctx.createImageData(W, H);
    for (let i = 0; i < W * H; i++) {
      const v = Math.max(0, Math.min(255, Math.round(im[i] * 255)));
      id.data[i * 4] = v; id.data[i * 4 + 1] = v; id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(id, 0, 0);
    return c.toDataURL("image/png");
  };
  // Leak metric (SLAB arm): project floor points in the fully-occluded
  // strip behind the slab and read the shadow channel there.
  let leak = null;
  if (slab && engine.camera) {
    const camM = engine.camera;
    camM.updateMatrixWorld(true);
    const vp = new THREE.Matrix4().multiplyMatrices(camM.projectionMatrix, camM.matrixWorldInverse);
    let lSum = 0, lN = 0;
    for (let zi = 0; zi <= 6; zi++) for (let xi = 0; xi <= 8; xi++) {
      const wx = -2 + xi * 0.5, wz = -2.5 + zi * 0.25;
      const pr = new THREE.Vector4(wx, 0.01, wz, 1).applyMatrix4(vp);
      if (pr.w <= 0) continue;
      const sx2 = Math.round((pr.x / pr.w * 0.5 + 0.5) * W);
      const sy2 = Math.round((0.5 - pr.y / pr.w * 0.5) * H);
      if (sx2 < 0 || sx2 >= W || sy2 < 0 || sy2 >= H) continue;
      lSum += img[sy2 * W + sx2]; lN++;
    }
    leak = lN ? lSum / lN : -1;
  }
  // DIRECT-ARM instruments (SUN=1): the sun channel's verdict-kind histogram
  // (KINDSUB paint) + the rayHitDebug limit counters (PROFILE).
  let sunKinds = null;
  if (sunOn && screen.targets?.lightShadowRaw) {
    const W2 = screen.shadowWidth ?? W, H2 = screen.shadowHeight ?? H;
    const stride2 = Math.ceil((W2 * 4) / 256) * 256;
    const d2 = await engine.renderer.backend.copyTextureToBuffer(screen.targets.lightShadowRaw, 0, 0, W2, H2);
    const anchors = [0, 32, 64, 96, 128, 159, 191, 255];
    const names = { 0: "miss", 32: "plane", 64: "tri", 96: "box", 128: "macroExhaust", 159: "brickLimit", 191: "invalidBrick", 255: "noGeomOrInactive" };
    sunKinds = { W: W2, H: H2 };
    // Raw channel-0 PNG of the sun map for spatial-pattern reading.
    const sunImg = new Float32Array(W2 * H2);
    for (let y = 0; y < H2; y++) {
      const row = y * stride2;
      for (let x = 0; x < W2; x++) sunImg[y * W2 + x] = d2[row + x * 4] / 255;
    }
    sunKinds.png = (() => {
      const c = document.createElement("canvas");
      c.width = W2; c.height = H2;
      const ctx = c.getContext("2d");
      const id = ctx.createImageData(W2, H2);
      for (let i = 0; i < W2 * H2; i++) {
        const vv = Math.max(0, Math.min(255, Math.round(sunImg[i] * 255)));
        id.data[i * 4] = vv; id.data[i * 4 + 1] = vv; id.data[i * 4 + 2] = vv; id.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(id, 0, 0);
      return c.toDataURL("image/png");
    })();
    // LATTICE-PHASE CORRELATION: project known floor world points into this
    // map and bucket the byte by voxel-lattice phase (x,z fractional). A
    // world-lattice artifact clusters its dark reads in specific phase bins;
    // a screen-resampling artifact spreads them flat.
    if (engine.camera) {
      try {
        const rbp = await system.state.volume.occupancyField.readbackBits(engine.renderer);
        const camP = engine.camera;
        camP.updateMatrixWorld(true);
        const vpm = new THREE.Matrix4().multiplyMatrices(camP.projectionMatrix, camP.matrixWorldInverse);
        const bins = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => ({ n: 0, dark: 0 })));
        for (let i = 0; i < 6000; i++) {
          const wx = -5 + ((i * 0.61803398875) % 1) * 10;
          const wz = -1 + ((i * 0.7548776662) % 1) * 8;
          const pr = new THREE.Vector4(wx, 0.001, wz, 1).applyMatrix4(vpm);
          if (pr.w <= 0) continue;
          const sxp = Math.round((pr.x / pr.w * 0.5 + 0.5) * W2);
          const syp = Math.round((0.5 - pr.y / pr.w * 0.5) * H2);
          if (sxp < 1 || sxp >= W2 - 1 || syp < 1 || syp >= H2 - 1) continue;
          const byte = d2[syp * stride2 + sxp * 4];
          const px2 = (((wx - rbp.origin.x) / rbp.voxel.x) % 1 + 1) % 1;
          const pz2 = (((wz - rbp.origin.z) / rbp.voxel.z) % 1 + 1) % 1;
          const bx = Math.min(3, Math.floor(px2 * 4)), bz = Math.min(3, Math.floor(pz2 * 4));
          bins[bx][bz].n++;
          if (byte < 16) bins[bx][bz].dark++;
        }
        sunKinds.phase = bins.map((r) => r.map((b) => (b.n ? +(b.dark / b.n).toFixed(2) : -1)));
        // VISIBLE-GEOMETRY SWEEP: project points on every real surface the
        // camera can see (whole floor, wall +z face, crate faces, panel) and
        // read the map byte. If real geometry reads lit/open while the map's
        // dark mass sits elsewhere, the dark class is BACKGROUND texels —
        // black in the texture but never sampled by materials.
        const sweep = { floor: { n: 0, dark: 0 }, wall: { n: 0, dark: 0 }, crate: { n: 0, dark: 0 }, panel: { n: 0, dark: 0 } };
        const readAt = (wx, wy, wz) => {
          const pr = new THREE.Vector4(wx, wy, wz, 1).applyMatrix4(vpm);
          if (pr.w <= 0) return -1;
          const sxp = Math.round((pr.x / pr.w * 0.5 + 0.5) * W2);
          const syp = Math.round((0.5 - pr.y / pr.w * 0.5) * H2);
          if (sxp < 1 || sxp >= W2 - 1 || syp < 1 || syp >= H2 - 1) return -1;
          return d2[syp * stride2 + sxp * 4];
        };
        const floorTopY = 0.001 + (globalThis.__probeFloorY ?? 0);
        for (let ix = 0; ix < 90; ix++) for (let iz = 0; iz < 90; iz++) {
          const b = readAt(-14.5 + ix * 0.33, floorTopY, -14.5 + iz * 0.33);
          if (b < 0) continue;
          sweep.floor.n++; if (b < 16) sweep.floor.dark++;
        }
        for (let ix = 0; ix < 40; ix++) for (let iy = 0; iy < 20; iy++) {
          const b = readAt(-2.9 + ix * 0.15, 0.1 + iy * 0.14, -2.955);
          if (b < 0) continue;
          sweep.wall.n++; if (b < 16) sweep.wall.dark++;
        }
        for (let ix = 0; ix < 12; ix++) for (let iy = 0; iy < 12; iy++) {
          const b1 = readAt(-0.58 + ix * 0.1, 0.02 + iy * 0.1, 0.605);
          if (b1 >= 0) { sweep.crate.n++; if (b1 < 16) sweep.crate.dark++; }
          const b2 = readAt(0.605, 0.02 + iy * 0.1, -0.58 + ix * 0.1);
          if (b2 >= 0) { sweep.crate.n++; if (b2 < 16) sweep.crate.dark++; }
        }
        for (let ix = 0; ix < 24; ix++) for (let iy = 0; iy < 20; iy++) {
          const b = readAt(-2.4 + ix * 0.2, 0.1 + iy * 0.19, -5.845);
          if (b < 0) continue;
          sweep.panel.n++; if (b < 16) sweep.panel.dark++;
        }
        sunKinds.visibleSweep = sweep;
      } catch (err) {
        sunKinds.phase = String(err?.message ?? err);
      }
    }
    // Localize the darkest class: count byte<16 pixels per image sixth
    // (3 columns × 2 rows) so "where do they live" stops being a guess.
    {
      const sixths = [[0, 0, 0], [0, 0, 0]];
      for (let y = 0; y < H2; y++) {
        const row = y * stride2;
        for (let x = 0; x < W2; x++) {
          if (d2[row + x * 4] < 16) sixths[y < H2 / 2 ? 0 : 1][Math.min(2, Math.floor((x / W2) * 3))]++;
        }
      }
      sunKinds.darkSixths = sixths;
    }
    // ATTRIBUTE dark pixels by gbuffer content: read the resolve-res gbuffer
    // position texture and classify each dark shadow pixel's receiver.
    try {
      const gb = screen.gbuffer;
      const RW = screen.width, RH = screen.height;
      const px = await engine.renderer.readRenderTargetPixelsAsync(gb.rt, 0, 0, RW, RH, 0);
      const sx3 = RW / W2, sy3 = RH / H2;
      const occF = system.state.volume.occupancyField;
      const rb3 = await occF.readbackBits(engine.renderer);
      const o3 = rb3.origin, v3 = rb3.voxel;
      // volume extents from level-0 res
      const l0res = occF.densityLayout ? null : null;
      const cls = { background: 0, floorIn: 0, floorOut: 0, wallOrCrate: 0, other: 0 };
      // level-0 res via voxelOf on the max corner is unknown; approximate
      // in-volume test with voxelOf + get() bounds via rb3.get returning 0
      // out of range — instead track via coordinate range of voxelOf against
      // profile: use rb3.voxelOf and compare to [0, res). res is not exposed;
      // reconstruct from origin/voxel and the known auto-fit half-extents is
      // fragile — use gridSpan below if available, else classify by |x|,|z|.
      for (let y = 0; y < H2; y++) {
        const row = y * stride2;
        for (let x = 0; x < W2; x++) {
          if (d2[row + x * 4] >= 16) continue;
          const gx = Math.min(RW - 1, Math.floor((x + 0.5) * sx3));
          const gy = Math.min(RH - 1, Math.floor((y + 0.5) * sy3));
          const gi4 = (gy * RW + gx) * 4;
          const w = px[gi4 + 3];
          if (w < 0.5) { cls.background++; continue; }
          const wx = px[gi4], wy = px[gi4 + 1], wz = px[gi4 + 2];
          cls.wySum = (cls.wySum ?? 0) + wy; cls.wyN = (cls.wyN ?? 0) + 1;
          if (Math.abs(wy) < 0.055) {
            const c = rb3.voxelOf({ x: wx, y: 0, z: wz });
            // in-volume ⇔ some bit exists in the ±2-row window (floor shell)
            let anyBit = 0;
            for (let dy = -2; dy <= 2; dy++) anyBit |= rb3.get(c.x, c.y + dy, c.z, 0);
            if (anyBit) cls.floorIn++; else cls.floorOut++;
          } else if (wy > 0.02 && wy < 3.2) cls.wallOrCrate++;
          else cls.other++;
        }
      }
      sunKinds.darkClasses = cls;
      // Raw NORMAL-attachment texels for a few dark floor pixels (attachment 1).
      try {
        const nx = await engine.renderer.readRenderTargetPixelsAsync(gb.rt, 0, 0, RW, RH, 1);
        const samples = [];
        outer: for (let y = 2; y < H2 - 2; y += 7) {
          const row = y * stride2;
          for (let x = 2; x < W2 - 2; x += 7) {
            if (d2[row + x * 4] >= 16) continue;
            const gx = Math.min(RW - 1, Math.floor((x + 0.5) * sx3));
            const gy = Math.min(RH - 1, Math.floor((y + 0.5) * sy3));
            const gi5 = (gy * RW + gx) * 4;
            if (px[gi5 + 3] < 0.5 || Math.abs(px[gi5 + 1]) > 0.06) continue;
            samples.push({
              p: [px[gi5], px[gi5 + 1], px[gi5 + 2]].map((v) => +v.toFixed(2)),
              n: [nx[gi5], nx[gi5 + 1], nx[gi5 + 2], nx[gi5 + 3]].map((v) => +v.toFixed(3)),
            });
            if (samples.length >= 6) break outer;
          }
        }
        sunKinds.darkNormals = samples;
      } catch (err) {
        sunKinds.darkNormals = String(err?.message ?? err);
      }
    } catch (err) {
      sunKinds.darkClasses = String(err?.message ?? err);
    }
    for (let y = 0; y < H2; y++) {
      const row = y * stride2;
      for (let x = 0; x < W2; x++) {
        const b = d2[row + x * 4];
        let key;
        if (kindSub === 2) {
          // burial-factor histogram: how buried are the shadow origins?
          key = b === 0 ? "buried0" : b < 64 ? "buried<0.25" : b < 128 ? "partial<0.5" : b < 250 ? "partial<0.98" : "open";
        } else if (kindSub >= 3) {
          // scalar-paint histogram, eighths of full scale
          key = `v~${(Math.round((b / 255) * 8) / 8).toFixed(3)}`;
        } else {
          let best = 255, bd = 1e9;
          for (const k of anchors) { const dd = Math.abs(b - k); if (dd < bd) { bd = dd; best = k; } }
          key = bd > 2 ? `odd(${b})` : names[best];
        }
        sunKinds[key] = (sunKinds[key] ?? 0) + 1;
      }
    }
  }
  let rayStats = null;
  if (profileOn) {
    try { rayStats = await system.readRayHitStats?.() ?? null; } catch { rayStats = null; }
  }
  // BITS PROFILE (SUN runs): ground truth on the floor's voxelized rows —
  // for a grid of (x,z) columns, list which y-rows near the floor plane are
  // occupied. Detects bulge height and any per-column alternation.
  let bitsProfile = null;
  if (sunOn) {
    try {
      const occField2 = system.state.volume.occupancyField;
      const rb = await occField2.readbackBits(engine.renderer);
      const profiles = {};
      // Shell-top height vs distance from the volume centre: catches an f32
      // SAT phantom bulge that grows with coordinate magnitude.
      const topByDist = {};
      for (let sx = 0; sx < 60; sx++) {
        for (let sz = 0; sz < 60; sz++) {
          const wx = -9 + sx * 0.3 + 0.037, wz = -9.4 + sz * 0.31 + 0.083;
          const c0 = rb.voxelOf({ x: wx, y: 0.0, z: wz });
          let key = "";
          let top = -9;
          for (let dy = -2; dy <= 3; dy++) {
            const bit = rb.get(c0.x, c0.y + dy, c0.z, 0);
            if (dy >= -2 && dy <= 2) key += bit ? "1" : "0";
            if (bit) top = dy;
          }
          profiles[key] = (profiles[key] ?? 0) + 1;
          if (top > -9) {
            const dist = Math.floor(Math.max(Math.abs(wx), Math.abs(wz)) / 2) * 2;
            (topByDist[dist] ??= {})[top] = ((topByDist[dist] ??= {})[top] ?? 0) + 1;
          }
        }
      }
      const o = rb.origin, vx = rb.voxel;
      bitsProfile = {
        origin: [o.x.toFixed(4), o.y.toFixed(4), o.z.toFixed(4)],
        voxel: [vx.x.toFixed(4), vx.y.toFixed(4), vx.z.toFixed(4)],
        yPhaseOfFloor: (((0 - o.y) / vx.y) % 1).toFixed(3),
        profiles,
        topRowByDist: topByDist,
      };
    } catch (err) {
      bitsProfile = { fail: String(err?.message ?? err) };
    }
  }
  return { W, H, emitters, grain: n ? sum / n : 0, penPx: n, leak, shadowPng: toPng(img), sunKinds, rayStats, bitsProfile };
}, { hatch, quality, steps, slab, sunOn, profileOn, kindSub, sunPos, floorY, emitterCounts, moverOn, moverY, sourceAngle, intermitOn, pressure, intermitMs, srcVol });

if (result.fail) { console.log(`FAIL: ${result.fail}`); await browser.close(); process.exit(1); }
// See the console-hook note: no composite ⇒ the readback measured a field that
// was never filled, and every number below is meaningless rather than merely
// small. Fail instead of printing one.
if (!sawComposite) {
  console.log("FAIL: the field never logged `field ready` — every measurement below would predate the pyramid. Re-run.");
  await browser.close();
  process.exit(1);
}
if (result.intermit) {
  const { stillKinds, ...rest } = result.intermit;
  console.log(`PROBE INTERMIT-STILL ${JSON.stringify(stillKinds)}`);
  console.log(`PROBE INTERMIT ${JSON.stringify(rest)}`);
  if (result.worstPng) writeFileSync("scripts/gi-diag-intermit-worst.png", Buffer.from(result.worstPng.split(",")[1], "base64"));
  if (result.stillPng) writeFileSync("scripts/gi-diag-intermit-post.png", Buffer.from(result.stillPng.split(",")[1], "base64"));
  await browser.close();
  process.exit(0);
}
if (result.moverStill) {
  console.log(`PROBE MOVER-STILL ${JSON.stringify(result.moverStill)}`);
  console.log(`PROBE MOVER-ROT   ${JSON.stringify(result.moverRotating)}`);
  if (result.crossStillVsRot) console.log(`PROBE MOVER-CROSS stillVsRot=${JSON.stringify(result.crossStillVsRot)} stillVsPost=${JSON.stringify(result.crossStillVsPost)}`);
  if (result.postPng) writeFileSync(`scripts/gi-diag-mover-post${kindSub ? "-kind" : ""}.png`, Buffer.from(result.postPng.split(",")[1], "base64"));
  if (result.stillPng) writeFileSync(`scripts/gi-diag-mover-still${kindSub ? "-kind" : ""}.png`, Buffer.from(result.stillPng.split(",")[1], "base64"));
  if (result.rotPng) writeFileSync(`scripts/gi-diag-mover-rot${kindSub ? "-kind" : ""}.png`, Buffer.from(result.rotPng.split(",")[1], "base64"));
  await browser.close();
  process.exit(0);
}
if (result.costCurve) {
  for (const row of result.costCurve) console.log(`PROBE EMITTER-COST n=${row.n} gpuMs=${row.gpuMs} promoted=${row.promoted} samples=${row.samples}`);
  console.log(`PROBE EMITTER-STABLE ${result.promotedStable}`);
  await browser.close();
  process.exit(0);
}
writeFileSync(`scripts/gi-diag-emissive-grid-${hatch}${slab ? "-slab" : ""}${steps ? `-s${steps}` : ""}.png`, Buffer.from(result.shadowPng.split(",")[1], "base64"));
await page.screenshot({ path: `scripts/gi-diag-emissive-grid-${hatch}-view.png` });
console.log(`PROBE hatch=${hatch}${srcVol ? `+src:${srcVol}` : ""}${slab ? "+slab" : ""} q=${quality} ${result.W}x${result.H} emitters=${result.emitters} penumbraPx=${result.penPx} grain=${result.grain.toFixed(4)} leak=${result.leak == null ? "n/a" : result.leak.toFixed(4)}`);
if (result.sunKinds) {
  const { png, ...counts } = result.sunKinds;
  if (png) writeFileSync(`scripts/gi-diag-sun-${kindSub || "raw"}.png`, Buffer.from(png.split(",")[1], "base64"));
  console.log(`PROBE SUN-KINDS ${JSON.stringify(counts)}`);
}
if (result.bitsProfile) console.log(`PROBE BITS-PROFILE ${JSON.stringify(result.bitsProfile)}`);
if (result.rayStats) {
  const s = result.rayStats;
  console.log(`PROBE RAYSTATS rays=${s.rays} avgMacro=${s.averageMacroSteps?.toFixed?.(2)} maxMacro=${s.maxMacroSteps} maxBrick=${s.maxBrickSteps} macroLimitExits=${s.macroStepLimitExits} brickLimitExits=${s.brickStepLimitExits} stepLimitExits=${s.stepLimitExits} invalid=${s.invalidNumerics}`);
}
await browser.close();
