// Exact (BVH) vs SDF mirror-reflection check — GI Phase 3 v1 (see
// docs/GI_PLAN.md). Mirror floor under a 16k-tri torus knot lit by an
// overhead emissive lamp panel (same knot/lamp rig as run-gi-sdf-hires.mjs).
//
// The knot has real gaps between its coils. Candidate floor pixels are
// classified EMPIRICALLY, independent of GI entirely (a plain
// THREE.Raycaster against the raw knot/backdrop meshes, mirroring the true
// ray: reflect(incident, floorNormal) from that floor pixel toward the
// camera) into "hole" (the ray misses the knot and reaches a wide emissive
// backdrop panel above) and "loop" (it hits the knot tube first). With the
// BVH path this classification should show up as real luminance contrast on
// the RENDERED floor (hole bright, loop dark, because the exact ray
// genuinely resolves the gap); the SDF fallback traces a coarse composited
// field that melts the knot's fine gaps together, so its hole/loop contrast
// should be much smaller — the hole reads about as dark as the loops,
// "melted".
//
// Verdict: PASS when (holeLum - loopLum) in the BVH arm exceeds the same
// quantity in the SDF arm by >= 15 luminance (0-255 scale).
//
// Env: BVH=1 / BVH=0 runs ONLY that single arm (debugging); unset runs BOTH
// arms and prints the verdict. HEADED=1 to watch. TAG=<suffix> on output PNGs.
import puppeteer from "puppeteer-core";
import sharp from "sharp";

const url = process.argv[2] ?? "http://localhost:5234/";
const ONLY_ARM = process.env.BVH === "0" ? "sdf" : process.env.BVH === "1" ? "bvh" : null;
const TAG = process.env.TAG ?? "";

const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

async function runArm(hatch) {
  const label = hatch ? "sdf" : "bvh";
  const browser = await puppeteer.launch({
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: process.env.HEADED ? false : "new",
    args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 840, deviceScaleFactor: 1 });
  let sdfLog = "";
  let bvhLog = "";
  page.on("console", (message) => {
    const text = message.text();
    if (/mesh SDF (baked|loaded)/.test(text)) sdfLog += `${text}\n`;
    if (/\[gi\] bvh:/.test(text)) bvhLog += `${text}\n`;
    if (/\[gi\]|GI-BR/.test(text) || message.type() === "error") console.log(`[${label}] ${message.type()}: ${text}`);
  });
  page.on("pageerror", (error) => console.log(`[${label}] pageerror: ${error.stack ?? error.message}`));

  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  // Persisted dockview layouts from other harness runs on this origin can
  // leave the ViewportPanel unmounted (detached-tab trap) - start clean.
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "load", timeout: 30000 });
  for (let i = 0; i < 40; i++) {
    const ready = await page.evaluate(() => {
      if (globalThis.__viewport?.orbit) return true;
      [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
      return !!globalThis.__viewport?.orbit;
    });
    if (ready) break;
    await settle(500);
  }
  await settle(3000);

  // ---- Phase 1: build the scene (fast, synchronous-ish). Camera/candidate
  // search happen LATER (phase 3) — the ViewportPanel's camera mounts late
  // (see run-gi-sdf-hires.mjs's own note) and isn't reliably up yet here. ----
  await page.evaluate(async ({ hatch, v1, v1light }) => {
    if (hatch) globalThis.__giNoBvhReflections = true;
    if (v1) globalThis.__giBvhV1 = true;
    if (v1light) globalThis.__giBvhV1Light = true;
    const { THREE } = await import("/src/engine/index.js");
    await import("/src/modules/index.js");
    const { enableEngineModule } = await import("/src/engine/modules.js");
    const { ensureEngine } = await import("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    await enableEngineModule(engine, "gi");
    globalThis.__engine = engine;
    globalThis.__THREE = THREE;

    const floorMat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.05, metalness: 1 });
    const floor = new THREE.Mesh(new THREE.BoxGeometry(16, 0.2, 16), floorMat);
    floor.position.set(0, -0.1, 0);
    floor.name = "floor";
    engine.scene.add(floor);

    const lampMaterial = new THREE.MeshStandardNodeMaterial({ color: 0x000000, roughness: 1 });
    lampMaterial.emissive = new THREE.Color(0xffffff);
    lampMaterial.emissiveIntensity = 10;
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.12, 1.6), lampMaterial);
    lamp.position.set(0, 5.2, 0);
    lamp.name = "lamp";
    engine.scene.add(lamp);

    // Wide, MODERATELY emissive backdrop just under the lamp — the actual
    // "hole shows bright" target. The lamp itself is a PROMOTED emitter
    // (luminance >= 0.5 composites ZERO emissive into the SDF/BVH field —
    // an intentional design, see giLight.js docs): a reflection ray that
    // hits the lamp mesh directly reads dark unless it ALSO lands inside
    // the specular glow term's razor-thin cone (~1-2 degrees at this
    // roughness) or hitLighting's near-zero-distance re-evaluation — both
    // fragile targets for a handful of hand-picked pixels (measured:
    // several tuning passes of this harness with the lamp as the sole
    // bright target left even a near-perfectly-aimed hole candidate at
    // rgb(0,0,0)). This panel's luminance is kept JUST BELOW the promotion
    // threshold — yellow (r=g=1, b=0) weights to 0.2126+0.7152=0.9278 per
    // unit intensity, so intensity 0.45 -> luminance ~0.42 < 0.5, staying
    // UNPROMOTED — so its emissive survives into the composited field like
    // ordinary geometry, and ANY hit on it (via mirrorSampleFn's plain
    // trilinear field/radiance sample — no glow cone, no hitLighting
    // needed) reads directly bright. Wide (5x5) so an approximately-upward
    // hole ray lands on it without needing pinpoint aim.
    const backdropMat = new THREE.MeshStandardNodeMaterial({ color: 0x000000, roughness: 1 });
    backdropMat.emissive = new THREE.Color(0xffff00);
    backdropMat.emissiveIntensity = 0.45;
    const backdrop = new THREE.Mesh(new THREE.BoxGeometry(5, 0.1, 5), backdropMat);
    backdrop.position.set(0, 4.9, 0);
    backdrop.name = "backdrop";
    engine.scene.add(backdrop);

    const knot = new THREE.Mesh(
      new THREE.TorusKnotGeometry(1.0, 0.28, 200, 40),
      new THREE.MeshStandardNodeMaterial({ color: 0xb8b8c0, roughness: 0.8 }),
    );
    knot.position.set(0, 2.2, 0);
    knot.rotation.x = Math.PI / 2;
    knot.name = "knot";
    engine.scene.add(knot);
    knot.updateMatrixWorld(true);
    lamp.updateMatrixWorld(true);
    backdrop.updateMatrixWorld(true);
    floor.updateMatrixWorld(true);
    globalThis.__giBrMeshes = { floor, lamp, knot, backdrop };
    console.log(`GI-BR knot tris: ${knot.geometry.index.count / 3}`);

    // MANUAL bounds, not autoFit: GISystem's auto-fit trims a scene-dwarfing
    // FLAT outlier (this 16x16 floor vs. the ~3m knot+lamp) down around the
    // "real" content and only re-adds a CLIPPED slice of it (#sceneAabb) —
    // on this rig that left the fitted volume's Y-min at 1.05, i.e. ABOVE
    // the floor (y=0) entirely, so GI (either t-source) cannot reach the
    // mirror surface at all: a first pass of this harness sampled a
    // uniformly black floor in BOTH arms for exactly this reason, not a
    // code bug (confirmed separately via run-gi-rc-mirror.mjs). Sizing the
    // volume by hand guarantees it covers the floor through the lamp.
    const giEntity = engine.createEntity({ name: "GI" });
    giEntity.object3D.position.set(0, 2.6, 0);
    giEntity.addComponent("global-illumination", {
      autoFit: false,
      sizeX: 8,
      sizeY: 7,
      sizeZ: 8,
      voxelSize: 0.08,
      probeSpacing: 0.5,
      quality: "high",
      intensity: 4,
      emissiveShadows: true,
      reflections: true,
      exactReflections: true, // opt-in — the default is now OFF (see GISystem #bvhReflectionsEnabled)
      hitLighting: true,
    });
    console.log("GI-BR scene ready");
  }, { hatch, v1: process.env.V1 === "1" && !hatch, v1light: process.env.V1LIGHT === "1" && !hatch });

  // ---- Phase 2: settle — same rhythm as run-gi-sdf-hires.mjs (compile
  // wave, then the knot's async SDF bake, which even the BVH arm needs —
  // hitSurfaceFn/mirrorSampleFn's diffuse remainder still reads the
  // composited field regardless of which t-source feeds the mirror). ----
  await settle(6000);
  for (let i = 0; i < 90; i++) {
    await settle(1000);
    if (!(await page.evaluate(() => globalThis.__engine?.renderSuspended === true))) break;
  }
  for (let i = 0; i < 60 && !/mesh SDF/.test(sdfLog); i++) await settle(1000);
  await settle(4000);
  for (let i = 0; i < 30; i++) {
    if (await page.evaluate(() => !!globalThis.__engine?.camera)) break;
    await settle(500);
  }

  // ---- Phase 3: camera + empirical hole/loop candidate search, now that
  // the camera and the GI system's fitted bounds both exist. ----
  const setup = await page.evaluate(() => {
    const engine = globalThis.__engine;
    const THREE = globalThis.__THREE;
    const { floor, knot, backdrop } = globalThis.__giBrMeshes;
    if (!engine.camera) throw new Error("engine.camera never became available");

    // Auto-fit trims a scene-dwarfing flat outlier (this 16x16 floor is
    // exactly that) down around the "real" content — see GISystem's
    // `#sceneAabb`. Constrain the candidate search to the ACTUAL fitted
    // volume instead of a hand-guessed region (an earlier pass of this
    // harness picked candidates outside it — all-black floor, no signal).
    const giSystem = engine.modules?.get("gi")?.system;
    const bounds = giSystem?.state?.bounds ?? null;
    const half = bounds
      ? {
          x: Math.min(bounds.max.x - bounds.min.x, bounds.max.x, -bounds.min.x) * 0.9,
          z: Math.min(bounds.max.z - bounds.min.z, bounds.max.z, -bounds.min.z) * 0.9,
        }
      : { x: 1.6, z: 1.6 };

    engine.camera.position.set(0, 4.2, 2.6);
    engine.camera.lookAt(0, 2.0, 0);
    engine.camera.updateMatrixWorld(true);

    // Empirical hole/loop floor-pixel search: plain THREE.Raycaster,
    // completely independent of the GI module (a trustworthy oracle to
    // compare the RENDERED result against). Grid clamped to the fitted
    // volume's own footprint (with margin) so every candidate lands
    // somewhere GI actually lights.
    //
    // "Hole" = the ray misses the knot and hits the wide backdrop panel
    // (see its comment at creation — UNPROMOTED emissive, reads bright via
    // the plain field sample, no glow-cone/hitLighting precision needed).
    // "Loop" = the ray hits the knot's tube first.
    const raycaster = new THREE.Raycaster();
    const normal = new THREE.Vector3(0, 1, 0);
    const camPos = engine.camera.position.clone();
    const candidates = [];
    const xMax = Math.min(1.6, half.x);
    const zMax = Math.min(1.8, half.z);
    for (let x = -xMax; x <= xMax + 1e-6; x += 0.04) {
      for (let z = 0.1; z <= zMax + 1e-6; z += 0.04) {
        const floorPoint = new THREE.Vector3(x, 0.01, z);
        const incident = floorPoint.clone().sub(camPos).normalize();
        const reflected = incident.clone().sub(normal.clone().multiplyScalar(2 * incident.dot(normal)));
        // Only reflections heading broadly upward (toward the knot/backdrop
        // column) make a meaningful hole-vs-loop sample.
        if (reflected.y <= 0.05) continue;
        raycaster.set(floorPoint, reflected);
        raycaster.far = 20;
        const knotHits = raycaster.intersectObject(knot, false);
        const backdropHits = raycaster.intersectObject(backdrop, false);
        if (knotHits.length === 0 && backdropHits.length > 0) {
          candidates.push({ kind: "hole", x, z });
        } else if (knotHits.length > 0 && (backdropHits.length === 0 || knotHits[0].distance < backdropHits[0].distance)) {
          candidates.push({ kind: "loop", x, z });
        }
      }
    }
    // Spatial thinning: greedily keep points far apart so the picks aren't
    // all the same pixel neighbourhood.
    function pick(kind, count, minSep) {
      const pool = candidates.filter((c) => c.kind === kind);
      const chosen = [];
      for (const c of pool) {
        if (chosen.length >= count) break;
        if (chosen.every((p) => Math.hypot(p.x - c.x, p.z - c.z) >= minSep)) chosen.push(c);
      }
      return chosen;
    }
    let holes = pick("hole", 3, 0.5);
    let loops = pick("loop", 3, 0.6);
    if (holes.length < 3) holes = pick("hole", 3, 0.2);
    if (loops.length < 3) loops = pick("loop", 3, 0.2);
    if (holes.length < 3) holes = pick("hole", 3, 0);
    if (loops.length < 3) loops = pick("loop", 3, 0);

    const project = (x, z) => {
      const v = new THREE.Vector3(x, 0.01, z).project(engine.camera);
      return { x, z, u: (v.x + 1) / 2, v: (1 - v.y) / 2 };
    };
    return {
      bounds: bounds ? { min: bounds.min.toArray(), max: bounds.max.toArray() } : null,
      searchRegion: { xMax, zMax },
      holeCandidateCount: candidates.filter((c) => c.kind === "hole").length,
      loopCandidateCount: candidates.filter((c) => c.kind === "loop").length,
      holes: holes.map((h) => project(h.x, h.z)),
      loops: loops.map((l) => project(l.x, l.z)),
    };
  });

  console.log(`[${label}] GI volume bounds: ${setup.bounds ? `[${setup.bounds.min.map((v) => v.toFixed(2))}] .. [${setup.bounds.max.map((v) => v.toFixed(2))}]` : "(none reported — using fallback region)"}`);
  console.log(`[${label}] search region x<=${setup.searchRegion.xMax.toFixed(2)}, z<=${setup.searchRegion.zMax.toFixed(2)}`);
  console.log(`[${label}] candidate search: ${setup.holeCandidateCount} hole / ${setup.loopCandidateCount} loop floor pixels found (before thinning)`);
  if (setup.holes.length < 3 || setup.loops.length < 3) {
    console.log(`[${label}] WARNING: fewer than 3 picks (holes=${setup.holes.length}, loops=${setup.loops.length})`);
  }
  await settle(1500); // let the new camera pose's first frame(s) land

  const box = await page.evaluate(() => {
    const c = [...document.querySelectorAll("canvas")]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
    return { x: c.r.x, y: c.r.y, width: c.r.width, height: c.r.height };
  });
  const png = await page.screenshot({ clip: box });
  const outPath = `scripts/gi-diag-bvh-reflect-${label}${TAG ? `-${TAG}` : ""}.png`;
  await sharp(png).toFile(outPath);
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const at = (u, v) => {
    const px = Math.min(info.width - 1, Math.max(0, Math.round(u * info.width)));
    const py = Math.min(info.height - 1, Math.max(0, Math.round(v * info.height)));
    const i = (py * info.width + px) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  };

  const holeSamples = setup.holes.map((h) => ({ ...h, rgb: at(h.u, h.v), lm: lum(at(h.u, h.v)) }));
  const loopSamples = setup.loops.map((l) => ({ ...l, rgb: at(l.u, l.v), lm: lum(at(l.u, l.v)) }));
  const holeAvg = holeSamples.reduce((s, h) => s + h.lm, 0) / Math.max(1, holeSamples.length);
  const loopAvg = loopSamples.reduce((s, l) => s + l.lm, 0) / Math.max(1, loopSamples.length);

  console.log(`\n=== arm: ${label.toUpperCase()} (${hatch ? "globalThis.__giNoBvhReflections=true" : "default, BVH on at quality high"}) ===`);
  for (const h of holeSamples) console.log(`  hole (${h.x.toFixed(2)},${h.z.toFixed(2)}): rgb(${h.rgb.join(",")}) lum=${h.lm.toFixed(1)}`);
  for (const l of loopSamples) console.log(`  loop (${l.x.toFixed(2)},${l.z.toFixed(2)}): rgb(${l.rgb.join(",")}) lum=${l.lm.toFixed(1)}`);
  console.log(`  hole avg lum ${holeAvg.toFixed(1)}, loop avg lum ${loopAvg.toFixed(1)}, contrast (hole-loop) ${(holeAvg - loopAvg).toFixed(1)}`);
  console.log(`  [gi] bvh: lines:\n${bvhLog.trim() ? bvhLog.trim().replace(/^/gm, "    ") : "    (none)"}`);
  console.log(`SHOT ${outPath}`);

  // STRIPING VISUAL CHECK (GI Phase 3 v3 — see giScreen.js's/giLight.js's
  // STRIPING FIX comments). A large tilted rough box standing on the SAME
  // mirror floor, placed well outside the knot hole/loop search region
  // (x<=1.6, z<=1.8 — see setup above) so it cannot perturb that test.
  // Only meaningful on the BVH arm (the SDF path never showed this
  // artifact — it undershoots the surface by construction).
  if (!hatch) {
    // Closer to the room's lit centre than the diagonal-corner first
    // attempt (3.5,1.3,-3.5), which sat far enough from the lamp/backdrop
    // that its reflection read almost black (no dynamic range to judge
    // banding by) — still x>1.6 (clear of the knot search region) and
    // z<0.1 (clear of its z-range too), and still far enough from the
    // eye-to-box sightline below to keep the knot off it (checked the
    // same way as before: parametrize eye->lookAt, confirm it would need
    // t>1 to reach x=0).
    const boxCenter = [2.5, 1.3, -3];
    const stripe = await page.evaluate(
      ({ boxCenter }) => {
        const engine = globalThis.__engine;
        const THREE = globalThis.__THREE;
        const mat = new THREE.MeshStandardNodeMaterial({ color: 0xc8c8c8, roughness: 0.9, metalness: 0 });
        const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mat);
        box.position.set(...boxCenter);
        box.rotation.set(THREE.MathUtils.degToRad(25), 0, THREE.MathUtils.degToRad(30));
        box.name = "stripeTestBox";
        box.castShadow = true;
        box.receiveShadow = true;
        engine.scene.add(box);
        box.updateMatrixWorld(true);
        engine.modules.get("gi")?.system?.requestRebuild?.();
        return { ok: true };
      },
      { boxCenter },
    );
    console.log(`[${label}] stripe test box added: ${JSON.stringify(stripe)}`);

    for (let i = 0; i < 60; i++) {
      await settle(1000);
      if (!(await page.evaluate(() => globalThis.__engine?.renderSuspended === true))) break;
    }
    await settle(2000);

    // Floor top surface is at y=0 (floor.position.y=-0.1, height 0.2) — the
    // reflection of the box's centre across that plane is where its mirror
    // image sits; project BOTH the real centre and its reflection to frame
    // a shot that comfortably contains the reflected face without guessing
    // camera geometry blind.
    const reflCenter = [boxCenter[0], -boxCenter[1], boxCenter[2]];
    // Along the OUTWARD diagonal from the room's centre (away from the
    // knot, not past it) — eye->lookAt never crosses x=0 within the
    // segment (t would have to exceed 1), so nothing else in the scene
    // sits on the sightline.
    const eye = [boxCenter[0] + 3.5, boxCenter[1] + 1.5, boxCenter[2] - 3.5];
    const lookAt = [boxCenter[0], -0.3, boxCenter[2]];
    // Deliberately NOT touching globalThis.__viewport.orbit here (unlike
    // run-gi-diagnose-game.mjs's aimCamera): OrbitControls.update() recomputes
    // the camera position from ITS OWN stale internal spherical state
    // relative to the target, snapping straight back over a manual
    // camera.position.set() — measured (first attempt: the "stripe" shot
    // came back as the unchanged knot view). This file's own phase-3 setup
    // above never touches orbit either — matching that proven pattern.
    const setResult = await page.evaluate(
      ({ eye, lookAt }) => {
        const engine = globalThis.__engine;
        engine.camera.position.set(...eye);
        engine.camera.lookAt(...lookAt);
        engine.camera.updateMatrixWorld(true);
        return {
          hasViewport: !!globalThis.__viewport,
          hasOrbit: !!globalThis.__viewport?.orbit,
          posAfterSet: engine.camera.position.toArray(),
        };
      },
      { eye, lookAt },
    );
    console.log(`[${label}] DIAG camera set: ${JSON.stringify(setResult)}`);
    await settle(800);
    const posBeforeShot = await page.evaluate(() => globalThis.__engine.camera.position.toArray());
    console.log(`[${label}] DIAG camera position before screenshot: ${JSON.stringify(posBeforeShot)}`);

    const stripeBox = await page.evaluate(() => {
      const c = [...document.querySelectorAll("canvas")]
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
      return { x: c.r.x, y: c.r.y, width: c.r.width, height: c.r.height };
    });
    const stripeFullPng = await page.screenshot({ clip: stripeBox });
    const stripeFullPath = `scripts/gi-diag-bvh-stripes-full${TAG ? `-${TAG}` : ""}.png`;
    await sharp(stripeFullPng).toFile(stripeFullPath);
    console.log(`[${label}] SHOT ${stripeFullPath} (wide, box + its floor reflection)`);

    const reflUV = await page.evaluate(
      (p) => {
        const engine = globalThis.__engine;
        const THREE = globalThis.__THREE;
        const v = new THREE.Vector3(...p).project(engine.camera);
        return [(v.x + 1) / 2, (1 - v.y) / 2];
      },
      reflCenter,
    );
    console.log(`[${label}] reflected-face screen UV ${reflUV.map((v) => v.toFixed(3))}`);

    const { info: stripeInfo } = await sharp(stripeFullPng).raw().toBuffer({ resolveWithObject: true });
    const cw = Math.round(stripeInfo.width * 0.22);
    const ch = Math.round(stripeInfo.height * 0.22);
    const cx = Math.min(stripeInfo.width - cw, Math.max(0, Math.round(reflUV[0] * stripeInfo.width - cw / 2)));
    const cy = Math.min(stripeInfo.height - ch, Math.max(0, Math.round(reflUV[1] * stripeInfo.height - ch / 2)));
    const cropPath = "scripts/gi-diag-bvh-stripes.png";
    await sharp(stripeFullPng)
      .extract({ left: cx, top: cy, width: cw, height: ch })
      .resize(cw * 4, ch * 4, { kernel: "nearest" })
      .toFile(cropPath);
    console.log(`[${label}] SHOT ${cropPath} (4x crop of the reflected face around UV ${reflUV.map((v) => v.toFixed(3))})`);

    // 12-point luminance line straight across the crop region (raw full-res
    // pixels, not the upscaled crop) — a horizontal line through its
    // vertical centre.
    const { data: rawData, info: rawInfo } = await sharp(stripeFullPng).raw().toBuffer({ resolveWithObject: true });
    const sampleAt = (px, py) => {
      const cpx = Math.min(rawInfo.width - 1, Math.max(0, px));
      const cpy = Math.min(rawInfo.height - 1, Math.max(0, py));
      const i = (cpy * rawInfo.width + cpx) * rawInfo.channels;
      return [rawData[i], rawData[i + 1], rawData[i + 2]];
    };
    const lineY = cy + Math.round(ch / 2);
    const linePoints = Array.from({ length: 12 }, (_, i) => cx + Math.round((cw - 1) * (i / 11)));
    const lineSamples = linePoints.map((px) => {
      const rgb = sampleAt(px, lineY);
      return { px, rgb, lm: lum(rgb) };
    });
    console.log(`[${label}] 12-point luminance line @ y=${lineY}, x=[${linePoints[0]}..${linePoints[11]}]:`);
    for (const s of lineSamples) console.log(`    x=${s.px}: rgb(${s.rgb.join(",")}) lum=${s.lm.toFixed(1)}`);
    let reversals = 0;
    for (let i = 1; i < lineSamples.length - 1; i++) {
      const a = lineSamples[i - 1].lm, b = lineSamples[i].lm, c = lineSamples[i + 1].lm;
      if ((b - a) * (c - b) < 0 && Math.abs(b - a) > 1 && Math.abs(c - b) > 1) reversals++;
    }
    console.log(`[${label}] direction reversals along the line: ${reversals} (stripes = many; a smooth gradient is ~0-2)`);
  }

  await browser.close();
  return { label, holeAvg, loopAvg, contrast: holeAvg - loopAvg, bvhLog: bvhLog.trim() };
}

const results = [];
if (ONLY_ARM === "bvh") {
  results.push(await runArm(false));
} else if (ONLY_ARM === "sdf") {
  results.push(await runArm(true));
} else {
  results.push(await runArm(false)); // BVH on (default at quality high)
  results.push(await runArm(true)); // SDF fallback (the hatch)
}

console.log("\n=== SUMMARY ===");
for (const r of results) {
  console.log(`${r.label}: hole ${r.holeAvg.toFixed(1)}, loop ${r.loopAvg.toFixed(1)}, contrast ${r.contrast.toFixed(1)}`);
}

if (results.length === 2) {
  const bvh = results.find((r) => r.label === "bvh");
  const sdf = results.find((r) => r.label === "sdf");
  const delta = bvh.contrast - sdf.contrast;
  console.log(`BVH contrast ${bvh.contrast.toFixed(1)} vs SDF contrast ${sdf.contrast.toFixed(1)} — delta ${delta.toFixed(1)} (need >= 15)`);
  const pass = delta >= 15;
  console.log(pass ? "VERDICT: PASS" : "VERDICT: FAIL");
  process.exit(pass ? 0 : 1);
} else {
  console.log("(single-arm run — no cross-arm verdict; leave BVH unset to run both arms)");
  process.exit(0);
}
