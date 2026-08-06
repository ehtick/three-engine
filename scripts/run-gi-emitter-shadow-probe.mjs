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
page.on("console", (m) => { const t = m.text(); if (/\[gi\] (built|light shadows|emitters|composited)|PROBE/.test(t)) console.log(`  ${t.slice(0, 200)}`); });
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
const result = await page.evaluate(async ({ hatch, quality, steps, slab, sunOn, profileOn, kindSub, sunPos, floorY, emitterCounts }) => {
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
      castShadow: true, shadowMode: "gi", sourceAngle: 10,
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
  gi.addComponent("global-illumination", {
    autoFit: true, quality, emissiveShadows: true,
    ...(profileOn ? { rayHitProfiling: true } : {}),
  });
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
}, { hatch, quality, steps, slab, sunOn, profileOn, kindSub, sunPos, floorY, emitterCounts });

if (result.fail) { console.log(`FAIL: ${result.fail}`); await browser.close(); process.exit(1); }
if (result.costCurve) {
  for (const row of result.costCurve) console.log(`PROBE EMITTER-COST n=${row.n} gpuMs=${row.gpuMs} promoted=${row.promoted} samples=${row.samples}`);
  console.log(`PROBE EMITTER-STABLE ${result.promotedStable}`);
  await browser.close();
  process.exit(0);
}
writeFileSync(`scripts/gi-diag-emissive-grid-${hatch}${slab ? "-slab" : ""}${steps ? `-s${steps}` : ""}.png`, Buffer.from(result.shadowPng.split(",")[1], "base64"));
await page.screenshot({ path: `scripts/gi-diag-emissive-grid-${hatch}-view.png` });
console.log(`PROBE hatch=${hatch}${slab ? "+slab" : ""} q=${quality} ${result.W}x${result.H} emitters=${result.emitters} penumbraPx=${result.penPx} grain=${result.grain.toFixed(4)} leak=${result.leak == null ? "n/a" : result.leak.toFixed(4)}`);
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
