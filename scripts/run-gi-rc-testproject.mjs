// The user's test project, LOADED FROM DISK (C:\Users\Khudiiash\Documents\Test).
// The harness can't open a project the normal way — that path goes through
// Tauri file IO — so this reads scenes/*.scene and the referenced .mat files
// itself and rebuilds the hierarchy in the engine: same transforms, same
// primitive geometries, same material graphs, same GI props. Editing the
// project in the editor and re-running this reproduces whatever the user is
// looking at, with no hand-copied constants to drift.
//
// Reports: the fitted volume + probe spacing, whether the mirror ball is
// black, and a horizontal wall profile (to quantify concentric banding).
//
// Env: PROJECT=<dir>, SCENE=<name.scene>, QUALITY, HITLIGHT=0|1 (override the
// authored props), EMISSION=<multiplier>.
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/Test";
const SCENE = process.env.SCENE ?? "Untitled.scene";

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const scene = readJson(path.join(PROJECT, "scenes", SCENE));

// Resolve every .mat the scene references (paths are absolute and may mix
// separators — the editor writes both).
const materials = {};
const resolveMat = (ref) => {
  if (!ref) return;
  const normalized = ref.replace(/\\/g, "/");
  if (materials[ref] !== undefined) return;
  const candidates = [normalized, path.join(PROJECT, path.basename(normalized))];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      materials[ref] = readJson(candidate);
      return;
    }
  }
  materials[ref] = null;
  console.log(`WARN: material not found on disk: ${ref}`);
};
const walk = (entities) => {
  for (const entity of entities ?? []) {
    for (const component of entity.components ?? []) {
      if (component.type === "mesh") {
        for (let i = 1; i <= 8; i++) resolveMat(component.props[i === 1 ? "material" : `material${i}`]);
      }
    }
    walk(entity.children);
  }
};
walk(scene.entities);

const overrides = {
  quality: process.env.QUALITY ?? null,
  hitLighting: process.env.HITLIGHT == null ? null : process.env.HITLIGHT !== "0",
  emission: process.env.EMISSION == null ? null : Number(process.env.EMISSION),
  matClass: process.env.MATCLASS ?? null,
  resolveScale: process.env.RESOLVE == null ? null : Number(process.env.RESOLVE),
  strip: process.env.STRIP ? process.env.STRIP.split(",").map((s) => s.trim()) : null,
};

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\]|GI-TP/.test(t) || m.type() === "error" || m.type() === "warning") console.log(`${m.type()}: ${t}`);
});
page.on("pageerror", (e) => console.log(`pageerror: ${e.stack ?? e.message}`));

await page.goto(url, { waitUntil: "load", timeout: 30000 });
// Dismiss the project picker and WAIT for the viewport to actually mount. A
// single fire-and-forget click 5s after load silently missed on a slow start,
// leaving the picker up — no ViewportPanel, so `engine.camera` and
// `__viewport` stayed null and every later step died on a null camera.
for (let i = 0; i < 40; i++) {
  const ready = await page.evaluate(() => {
    if (globalThis.__viewport?.orbit) return true;
    [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
    return !!globalThis.__viewport?.orbit;
  });
  if (ready) break;
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`  editor ready: viewport=${await page.evaluate(() => !!globalThis.__viewport?.orbit)}`);
await new Promise((r) => setTimeout(r, 5000));

// A/B switch for the per-builder Fn layouts (giFn.js): NOLAYOUTS=1 reproduces
// the previous shipped codegen on the SAME machine state.
if (process.env.NOLAYOUTS) await page.evaluate(() => { globalThis.__giNoLayouts = true; });

const built = await page.evaluate(async ({ scene, materials, overrides }) => {
  try {
    const { THREE } = await import("/src/engine/index.js");
    const TSL = await import("/node_modules/three/build/three.tsl.js");
    await import("/src/modules/index.js");
    const { enableEngineModule } = await import("/src/engine/modules.js");
    const { ensureEngine } = await import("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    await enableEngineModule(engine, "gi");
    globalThis.__engine = engine;
    globalThis.__THREE = THREE;

    // ---- primitive geometries, matching MeshComponent's table
    const geometryFor = (kind) =>
      ({
        plane: () => new THREE.PlaneGeometry(1, 1),
        box: () => new THREE.BoxGeometry(1, 1, 1),
        sphere: () => new THREE.SphereGeometry(0.5, 32, 16),
        cylinder: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 32),
        torus: () => new THREE.TorusGeometry(0.5, 0.2, 16, 48),
      })[kind]?.() ?? new THREE.BoxGeometry(1, 1, 1);

    // ---- .mat → material, THROUGH THE ENGINE'S OWN PIPELINE.
    // Hand-rolled MeshStandardNodeMaterials were what made every previous
    // reflection test pass while the real editor showed none: the editor
    // builds a MeshPhysicalNodeMaterial and populates its *Node slots from
    // the compiled shader graph. Reproduce that exactly.
    const { compileShaderGraph } = await import("/src/engine/tslGraph.js");
    const { applyGraphMutations, MATERIAL_DEFAULTS } = await import("/src/engine/materialAsset.js");
    const materialFor = async (ref) => {
      const def = materials[ref] ?? null;
      // MATCLASS lets the harness A/B the material CLASS against the graph:
      // the editor uses Physical, every passing reflection test used Standard.
      const m =
        overrides.matClass === "standard"
          ? new THREE.MeshStandardNodeMaterial()
          : new THREE.MeshPhysicalNodeMaterial();
      m.side = THREE.DoubleSide;
      m.color.set(def?.color ?? MATERIAL_DEFAULTS.color);
      m.roughness = def?.roughness ?? MATERIAL_DEFAULTS.roughness;
      m.metalness = def?.metalness ?? MATERIAL_DEFAULTS.metalness;
      if (def?.shaderGraph) {
        const result = await compileShaderGraph(def.shaderGraph);
        if (result) applyGraphMutations(m, result, false);
      }
      if (overrides.emission != null && m.emissiveNode) {
        m.emissiveNode = m.emissiveNode.mul(overrides.emission);
      }
      // STRIP=<slot,slot> nulls material *Node slots after the graph applied
      // them — the bisection handle for "which slot the compiler sets that a
      // hand-built material doesn't" questions.
      for (const slot of overrides.strip ?? []) m[slot] = null;
      m.needsUpdate = true;
      return m;
    };

    // ---- hierarchy
    const info = { giProps: null, meshes: [] };
    const build = async (def, parentObject) => {
      const entity = engine.createEntity({ name: def.name });
      const object = entity.object3D;
      object.position.set(...def.position);
      object.rotation.set(...def.rotation);
      object.scale.set(...def.scale);
      if (parentObject) parentObject.add(object);
      for (const component of def.components ?? []) {
        if (component.type === "mesh") {
          const mesh = new THREE.Mesh(
            geometryFor(component.props.geometry),
            await materialFor(component.props.material),
          );
          mesh.name = def.name;
          object.add(mesh);
          info.meshes.push({ name: def.name, mesh });
        } else if (component.type === "global-illumination") {
          info.giProps = { ...component.props };
          info.giEntity = entity;
        }
      }
      for (const child of def.children ?? []) await build(child, object);
      return entity;
    };
    for (const def of scene.entities) await build(def, null);

    // BALLMAT=plain swaps ONLY the mirror's material for a hand-built
    // roughness-0/metalness-1 one, leaving the rest of the scene identical —
    // the A/B that separates "the material definition is wrong" from "the
    // field around the ball is wrong".
    if (overrides.ballMat === "plain") {
      const hit = info.meshes.find((m) => m.name === "Mirror");
      if (hit) {
        const plain = new THREE.MeshStandardNodeMaterial();
        plain.color = new THREE.Color(0xffffff);
        plain.roughness = 0;
        plain.metalness = 1;
        plain.colorNode = TSL.color(new THREE.Color(0xffffff));
        plain.roughnessNode = TSL.float(0);
        plain.metalnessNode = TSL.float(1);
        hit.mesh.material = plain;
      }
    }

    if (!info.giProps) throw new Error("no global-illumination component in the scene");
    const props = { ...info.giProps };
    if (overrides.quality) props.quality = overrides.quality;
    if (overrides.hitLighting != null) props.hitLighting = overrides.hitLighting;
    if (overrides.resolveScale != null) props.resolveScale = overrides.resolveScale;
    globalThis.__gi = info.giEntity.addComponent("global-illumination", props);

    engine.scene.updateMatrixWorld(true);
    const worldOf = (name) => {
      const hit = info.meshes.find((m) => m.name === name);
      if (!hit) return null;
      hit.mesh.geometry.computeBoundingSphere();
      const centre = hit.mesh.geometry.boundingSphere.center.clone().applyMatrix4(hit.mesh.matrixWorld);
      const scale = new THREE.Vector3();
      hit.mesh.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
      return {
        centre: centre.toArray(),
        radius: hit.mesh.geometry.boundingSphere.radius * Math.max(scale.x, scale.y, scale.z),
      };
    };
    const box = new THREE.Box3();
    for (const { mesh } of info.meshes) box.expandByObject(mesh);

    globalThis.__mirrorInfo = worldOf("Mirror");
    console.log(`GI-TP scene ready (quality=${props.quality}, hitLighting=${props.hitLighting})`);
    return {
      props,
      mirror: worldOf("Mirror"),
      light: worldOf("Light"),
      names: info.meshes.map((m) => m.name),
      contentMin: box.min.toArray(),
      contentMax: box.max.toArray(),
    };
  } catch (err) {
    console.log(`GI-TP SETUP FAILED: ${err?.stack ?? err?.message ?? err}`);
    throw err;
  }
}, { scene, materials, overrides });

console.log("");
console.log(`--- scene from ${path.join(PROJECT, "scenes", SCENE)} ---`);
console.log(`  meshes: ${built.names.join(", ")}`);
console.log(`  content bounds: ${built.contentMin.map((v) => v.toFixed(1))} .. ${built.contentMax.map((v) => v.toFixed(1))}`);
console.log(`  mirror: centre ${built.mirror?.centre.map((v) => v.toFixed(2))} r ${built.mirror?.radius.toFixed(2)}`);
console.log(`  lamp:   centre ${built.light?.centre.map((v) => v.toFixed(2))} r ${built.light?.radius.toFixed(2)}`);
console.log(`  gi props: quality=${built.props.quality} hitLighting=${built.props.hitLighting} reflections=${built.props.reflections} bounce=${built.props.bounce}`);

const waitForWave = async (extra = 2500) => {
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (!(await page.evaluate(() => globalThis.__engine?.renderSuspended === true))) break;
  }
  await new Promise((r) => setTimeout(r, extra));
};
await new Promise((r) => setTimeout(r, 6000));
await waitForWave(3000);

const box = await page.evaluate(() => {
  const c = [...document.querySelectorAll("canvas")]
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
  return { x: c.r.x, y: c.r.y, width: c.r.width, height: c.r.height };
});

// The editor's viewport controller owns the camera and overwrites whatever the
// setup step asked for, so aim it HERE, after the wave, just before sampling.
// Stand in front of the mirror ball, inside the room, looking at it.
const mirror = built.mirror ?? { centre: [0, 0, 0], radius: 1 };
// Stand far enough back that the whole room fits the frame at any panel
// layout — a tight framing made the wall-profile samples land on clamped
// edge pixels and silently reported them as wall luminances.
const roomSpan = Math.max(
  built.contentMax[0] - built.contentMin[0],
  built.contentMax[1] - built.contentMin[1],
);
const eye = [
  mirror.centre[0] + roomSpan * 0.15,
  mirror.centre[1] + roomSpan * 0.2,
  mirror.centre[2] + roomSpan * 1.1,
];
// `engine.camera` is the VIEWPORT's camera and is null until the panel has
// mounted one — after a long compile wave that can still be pending here.
for (let i = 0; i < 30; i++) {
  if (await page.evaluate(() => !!globalThis.__engine?.camera)) break;
  await new Promise((r) => setTimeout(r, 500));
}
// CLOSEUP=1 reproduces the USER'S viewpoint for the banding report: inside the
// room, near the lamp wall, looking along it at a grazing angle. The default
// wide framing shows the rings at a few pixels across, which is why a scanline
// across it measured nothing — instrument first, fix second.
if (process.env.CLOSEUP) {
  const lampC = built.light?.centre ?? [0, 0, 0];
  eye[0] = lampC[0] + 6;
  eye[1] = lampC[1] - 0.5;
  eye[2] = lampC[2] + 7;
  mirror.centre = [lampC[0] - 1, lampC[1] - 1, lampC[2] - 4];
}
const aimed = await page.evaluate(({ eye, target }) => {
  const engine = globalThis.__engine;
  const viewport = globalThis.__viewport;
  if (!engine?.camera) return { hasViewport: false, noCamera: true };
  engine.camera.position.set(...eye);
  engine.camera.lookAt(...target);
  // OrbitControls owns the ORIENTATION: its update() re-aims the camera at
  // orbit.target every frame, so a bare lookAt is reverted before the next
  // render. Move the target too (dev-only handle installed by ViewportPanel).
  if (viewport?.orbit) {
    viewport.orbit.target.set(...target);
    viewport.orbit.update();
  }
  engine.camera.updateMatrixWorld(true);
  engine.camera.layers.disable(31);
  return { hasViewport: !!viewport?.orbit, position: engine.camera.position.toArray() };
}, { eye, target: mirror.centre });
if (!aimed.hasViewport) console.log("WARN: no __viewport handle — the orbit controls will overwrite the aim");
await new Promise((r) => setTimeout(r, 1500));

const grab = async () => {
  const shot = await page.screenshot({ clip: box });
  const { default: sharp } = await import("sharp");
  const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
  return {
    at: (fx, fy) => {
      const px = Math.min(info.width - 1, Math.max(0, Math.round(fx * info.width)));
      const py = Math.min(info.height - 1, Math.max(0, Math.round(fy * info.height)));
      const i = (py * info.width + px) * info.channels;
      return [data[i], data[i + 1], data[i + 2]];
    },
  };
};
const img = await grab();

// Screen positions are PROJECTED from world space, never guessed: the room is
// 20m wide and off-origin, so eyeballed screen fractions land on the wrong
// object.
const project = (points) =>
  page.evaluate((pts) => {
    const engine = globalThis.__engine;
    const THREE = globalThis.__THREE;
    const camera = engine.camera;
    camera.updateMatrixWorld(true);
    return pts.map(([x, y, z]) => {
      const v = new THREE.Vector3(x, y, z).project(camera);
      return [(v.x + 1) / 2, (1 - v.y) / 2];
    });
  }, points);

console.log("");
console.log(`--- mirror ball (hitLighting=${built.props.hitLighting}) ---`);
const [mx, my, mz] = mirror.centre;
const r = mirror.radius;
const ballWorld = [
  [mx, my, mz + r * 0.98],
  [mx - r * 0.45, my, mz + r * 0.85],
  [mx + r * 0.45, my, mz + r * 0.85],
  [mx, my + r * 0.45, mz + r * 0.85],
  [mx, my - r * 0.45, mz + r * 0.85],
];
const ballPoints = await project(ballWorld);
console.log("  ball screen coords: " + ballPoints.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" "));
const ball = ballPoints.map(([x, y]) => img.at(x, y));
console.log("  ball samples: " + ball.map((c) => `rgb(${c.join(",")})`).join(" "));
const ballMax = Math.max(...ball.flat());
const spread = Math.max(...ball.map((c) => Math.max(...c))) - Math.min(...ball.map((c) => Math.max(...c)));
console.log(`  brightest channel on the ball: ${ballMax} ${ballMax < 25 ? "→ BLACK (no reflection)" : "→ reflecting something"}`);
console.log(`  variation across the ball: ${spread} (a mirror shows the room, so it should NOT be flat)`);

// Wall banding: a horizontal profile across the back wall at lamp height.
console.log("");
console.log("--- back wall horizontal profile (banding check) ---");
const lamp = built.light ?? { centre: [0, 0, 0] };
const backZ = built.contentMin[2] + 0.02;
const x0 = built.contentMin[0] + 1;
const x1 = built.contentMax[0] - 1;
const wallWorld = [];
for (let i = 0; i <= 24; i++) wallWorld.push([x0 + (i / 24) * (x1 - x0), lamp.centre[1], backZ]);
const wallPoints = await project(wallWorld);
const offScreen = wallPoints.filter(([x, y]) => x < 0.01 || x > 0.99 || y < 0.01 || y > 0.99).length;
const profile = wallPoints.map(([x, y]) => {
  const c = img.at(x, y);
  return Math.round(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]);
});
console.log("  L: " + profile.join(" "));
console.log(
  `  sample points off-screen: ${offScreen}/${wallPoints.length}` +
    `${offScreen ? " — luminances above are CLAMPED EDGE PIXELS, not the wall" : ""}`,
);
let reversals = 0;
for (let i = 2; i < profile.length; i++) {
  const a = Math.sign(profile[i - 1] - profile[i - 2]);
  const b = Math.sign(profile[i] - profile[i - 1]);
  if (a !== 0 && b !== 0 && a !== b) reversals++;
}
console.log(`  direction reversals across the profile: ${reversals} (a smooth falloff should be 0-2; rings show up as many)`);


// ---------------------------------------------------------- MIRRORDIAG=1
// Why is the mirror ball dark? Three questions, in the order that narrows
// fastest: (1) does the mirror code contribute ANYTHING (reflections on/off
// must change the ball), (2) is the RADIANCE FIELD the mirror samples even
// lit next to the walls the ball should show, (3) does the ball CAUSALLY
// track a wall recolour.
if (process.env.MIRRORDIAG) {
  const rgb = (c) => `rgb(${c.join(",")})`;

  console.log('');
  console.log('--- 0. what GI thinks each material is (bucket 0=mirror 1=specular 2=diffuse 3=dynamic) ---');
  const buckets = await page.evaluate(async () => {
    const { giRoughnessBucketOf } = await import('/src/modules/gi/giLight.js');
    const out = [];
    globalThis.__engine.scene.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const m = o.material;
      const describe = (n) => {
        if (n == null) return 'null';
        let k = n, hops = 0;
        while (k && hops < 8) {
          if (k.isConstNode) return `const(${k.value})`;
          if (k.isUniformNode) return `uniform(${k.value})`;
          k = k.node ?? null; hops++;
        }
        return n.constructor?.name ?? 'node';
      };
      out.push({
        name: o.name || m.type,
        bucket: giRoughnessBucketOf(m),
        roughness: m.roughness,
        roughnessNode: describe(m.roughnessNode),
        metalnessNode: describe(m.metalnessNode),
        roughnessMap: !!m.roughnessMap,
      });
    });
    return out;
  });
  for (const b of buckets) {
    console.log(`  ${String(b.name).padEnd(10)} bucket=${b.bucket}  material.roughness=${b.roughness}  roughnessNode=${b.roughnessNode}  metalnessNode=${b.metalnessNode}  roughnessMap=${b.roughnessMap}`);
  }

  console.log('');
  console.log('--- 1. what the ball SHOULD be showing (wall luminance) ---');
  const wallProbe = await project([
    [built.contentMax[0] - 0.3, mirror.centre[1], mirror.centre[2]],
    [built.contentMin[0] + 0.3, mirror.centre[1], mirror.centre[2]],
    [mirror.centre[0], mirror.centre[1], built.contentMin[2] + 0.3],
  ]);
  const wallCols = wallProbe.map(([x, y]) => img.at(x, y));
  console.log(`  nearWall+X ${rgb(wallCols[0])}  nearWall-X ${rgb(wallCols[1])}  backWall ${rgb(wallCols[2])}`);
  console.log('  ball brightest ' + Math.max(...ball.flat()) + ' vs wall brightest ' + Math.max(...wallCols.flat()));

  console.log('');
  console.log('--- 2. the radiance field the mirror samples, 1 cell off each wall ---');
  const field = await page.evaluate(async (probe) => {
    const engine = globalThis.__engine;
    const volume = engine.modules.get('gi').system.state.volume;
    const renderer = engine.renderer;
    const rad = new Float32Array(await renderer.getArrayBufferAsync(volume.radianceBuffer.value));
    const stag = new Float32Array(await renderer.getArrayBufferAsync(volume.stagingBuffer.value));
    const { res, bounds, cell } = volume;
    return probe.map(([x, y, z]) => {
      const cx = Math.max(0, Math.min(res.x - 1, Math.floor((x - bounds.min.x) / cell.x)));
      const cy = Math.max(0, Math.min(res.y - 1, Math.floor((y - bounds.min.y) / cell.y)));
      const cz = Math.max(0, Math.min(res.z - 1, Math.floor((z - bounds.min.z) / cell.z)));
      const i = ((cz * res.y + cy) * res.x + cx) * 4;
      return { rad: [rad[i], rad[i + 1], rad[i + 2]].map((v) => +v.toFixed(3)), occ: +stag[i + 3].toFixed(2) };
    });
  }, [
    [built.contentMax[0] - 0.3, mirror.centre[1], mirror.centre[2]],
    [built.contentMin[0] + 0.3, mirror.centre[1], mirror.centre[2]],
    [mirror.centre[0], mirror.centre[1], built.contentMin[2] + 0.3],
    [mirror.centre[0], built.contentMin[1] + 0.3, mirror.centre[2]],
  ]);
  ['+X wall', '-X wall', 'back wall', 'floor'].forEach((n, i) => {
    console.log(`  ${n.padEnd(10)} radiance ${field[i].rad}  occupancy ${field[i].occ}`);
  });

  console.log('');
  console.log('--- 3. A/B: reflections OFF (mirror path compiled out) ---');
  await page.evaluate(() => {
    const gi = globalThis.__gi;
    gi.props.reflections = false;
    gi.system?.requestRebuild?.() ?? globalThis.__engine.modules.get('gi').system.requestRebuild();
  });
  await waitForWave(3000);
  const imgOff = await grab();
  const ballOff = ballPoints.map(([x, y]) => imgOff.at(x, y));
  console.log('  ball with reflections ON : ' + ball.map(rgb).join(' '));
  console.log('  ball with reflections OFF: ' + ballOff.map(rgb).join(' '));
  const delta = ball.map((c, i) => Math.max(...c.map((v, k) => Math.abs(v - ballOff[i][k]))));
  console.log('  per-point max channel delta: ' + delta.join(' '));
  console.log('  ' + (Math.max(...delta) < 6
    ? 'VERDICT: the mirror path contributes NOTHING — the ball looks the same without it'
    : 'VERDICT: the mirror path DOES contribute (delta above) — it is hitting, just dark'));
  await page.screenshot({ path: 'scripts/gi-diag-testproject-norefl.png', clip: box });
}

// ------------------------------------------------------------------ PERF=1
// Steady-state cost of THEIR scene, framed on the mirror ball (the expensive
// pixels). GPU ms comes from the engine's timestamp queries — rAF deltas are
// vsync-capped at 8.3ms and hide everything.
if (process.env.PERF) {
  const perf = await page.evaluate(async () => {
    const engine = globalThis.__engine;
    const gpu = [];
    const deltas = [];
    await new Promise((resolve) => {
      let last = performance.now();
      const start = last;
      const step = (now) => {
        deltas.push(now - last);
        last = now;
        const g = engine.stats?.readout?.gpuMs ?? 0;
        if (g > 0) gpu.push(g);
        if (now - start < 5000) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    const sorted = (a) => [...a].sort((x, y) => x - y);
    const d = sorted(deltas);
    const g = sorted(gpu);
    const pick = (arr, q) => (arr.length ? arr[Math.floor(arr.length * q)] : null);
    return {
      frames: d.length,
      median: pick(d, 0.5),
      p95: pick(d, 0.95),
      worst: d[d.length - 1],
      gpuMedian: pick(g, 0.5),
      gpuP95: pick(g, 0.95),
      gpuSamples: g.length,
    };
  });
  // PROFILE=1 additionally samples the JS stack (CDP profiler) so a CPU-bound
  // frame can be attributed to actual functions instead of guessed at.
  if (process.env.PROFILE) {
    const cdp = await page.createCDPSession();
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
    await cdp.send("Profiler.start");
    await new Promise((r) => setTimeout(r, 6000));
    const { profile } = await cdp.send("Profiler.stop");
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const self = new Map();
    for (const node of profile.nodes) {
      const f = node.callFrame;
      const where = `${f.functionName || "(anonymous)"}  ${(f.url || "").split("/").slice(-1)[0]}:${f.lineNumber + 1}`;
      self.set(where, (self.get(where) ?? 0) + (node.hitCount ?? 0));
    }
    const totalHits = [...self.values()].reduce((a, b) => a + b, 0) || 1;
    console.log("");
    console.log("--- CPU self-time (JS sampling profiler, steady state) ---");
    [...self.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 18)
      .forEach(([where, hits]) => {
        console.log(`  ${((hits / totalHits) * 100).toFixed(1).padStart(5)}%  ${where}`);
      });
    void byId;
  }

  console.log("");
  console.log("--- steady-state cost (camera on the mirror ball) ---");
  console.log(`  frame ms: median ${perf.median?.toFixed(1)}  p95 ${perf.p95?.toFixed(1)}  worst ${perf.worst?.toFixed(1)}  (${perf.frames} frames, vsync-capped)`);
  console.log(`  GPU ms:   median ${perf.gpuMedian?.toFixed(2)}  p95 ${perf.gpuP95?.toFixed(2)}  (${perf.gpuSamples} samples)`);
}

// --------------------------------------------------------------- BANDING=1
// Quantifies the "hard edge" contour rings the user sees in indirect light.
// A smooth falloff has a near-zero SECOND difference along a scanline; a
// piecewise-linear (trilinear-over-probes) falloff is C0 but not C1, so its
// derivative jumps at every probe-cell boundary and the second difference
// spikes there — that kink is exactly what the eye reads as a hard contour
// edge / Mach band. So: sample densely, report the second-difference spikes.
if (process.env.BANDING) {
  const dense = 160;
  const lamp = built.light ?? { centre: [0, 0, 0] };
  const scan = async (label, from, to) => {
    const pts = [];
    for (let i = 0; i < dense; i++) {
      const t = i / (dense - 1);
      pts.push([0, 1, 2].map((k) => from[k] + (to[k] - from[k]) * t));
    }
    const screen = await project(pts);
    const onScreen = screen.filter(([x, y]) => x > 0.01 && x < 0.99 && y > 0.01 && y < 0.99).length;
    const lum = screen.map(([x, y]) => {
      const c = img.at(x, y);
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    });
    // Smooth the sampling noise (±1 level) before differencing twice, or the
    // metric just measures screenshot dither.
    const sm = lum.map((_, i) => {
      const a = lum[Math.max(0, i - 1)], b = lum[i], c = lum[Math.min(lum.length - 1, i + 1)];
      return (a + b + c) / 3;
    });
    const d2 = [];
    for (let i = 1; i < sm.length - 1; i++) d2.push(Math.abs(sm[i + 1] - 2 * sm[i] + sm[i - 1]));
    d2.sort((a, b) => b - a);
    const top = d2.slice(0, 8);
    const kinks = d2.filter((v) => v > 0.6).length;
    console.log(
      `  ${label.padEnd(12)} on-screen ${onScreen}/${dense}  L ${Math.round(Math.min(...lum))}..${Math.round(Math.max(...lum))}` +
        `  worst |d2| ${top[0].toFixed(2)}  top8 ${top.map((v) => v.toFixed(2)).join(",")}  kinks>0.6: ${kinks}`,
    );
    return { worst: top[0], kinks };
  };
  console.log("");
  console.log("--- indirect-light banding (second difference along a scanline) ---");
  const [minX, minY, minZ] = built.contentMin;
  const [maxX, maxY, maxZ] = built.contentMax;
  // Back wall, PROJECTED from world so camera framing drift cannot move the
  // window (it did, and made the first A/B unreadable). Heights chosen clear
  // of the mirror box that occludes the wall centre.
  const wallZ = minZ + 0.05;
  await scan("wall y=4", [minX + 6, minY + 4, wallZ], [maxX - 4, minY + 4, wallZ]);
  await scan("wall y=8", [minX + 6, minY + 8, wallZ], [maxX - 4, minY + 8, wallZ]);
  await scan("wall hi", [minX + 6, maxY - 3, wallZ], [maxX - 4, maxY - 3, wallZ]);

  // SCREEN-SPACE scans: world-space lines kept crossing object silhouettes
  // (a 25-level second difference is a hard EDGE, not a band). These sweep
  // pure image rows/columns so a flat lit wall can be picked out by eye from
  // the printed profile.
  const screenScan = (label, y, x0 = 0.02, x1 = 0.98) => {
    const lum = [];
    for (let i = 0; i < dense; i++) {
      const c = img.at(x0 + (i / (dense - 1)) * (x1 - x0), y);
      lum.push(Math.round(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]));
    }
    const sm = lum.map((_, i) => (lum[Math.max(0, i - 1)] + lum[i] + lum[Math.min(lum.length - 1, i + 1)]) / 3);
    const d2 = [];
    for (let i = 1; i < sm.length - 1; i++) d2.push(Math.abs(sm[i + 1] - 2 * sm[i] + sm[i - 1]));
    const sorted = [...d2].sort((a, b) => b - a);
    console.log(`  ${label}  L ${Math.min(...lum)}..${Math.max(...lum)}  worst |d2| ${sorted[0].toFixed(2)}  mean|d2| ${(d2.reduce((a, b) => a + b, 0) / d2.length).toFixed(3)}  kinks>0.6: ${d2.filter((v) => v > 0.6).length}`);
    console.log(`    ${lum.filter((_, i) => i % 4 === 0).join(" ")}`);
  };
  console.log("");
  console.log("--- BACK-WALL FALLOFF (the banded region; smooth => tiny |d2|) ---");
  screenScan("wall y=0.55", 0.55, 0.34, 0.70);
  screenScan("wall y=0.60", 0.6, 0.34, 0.70);
  screenScan("wall y=0.65", 0.65, 0.34, 0.70);
}

const tag = process.env.TAG ?? (built.props.hitLighting ? "hit" : "nohit");
await page.screenshot({ path: `scripts/gi-diag-testproject-${tag}.png`, clip: box });
console.log(`SHOT scripts/gi-diag-testproject-${tag}.png`);
await browser.close();
process.exit(0);
