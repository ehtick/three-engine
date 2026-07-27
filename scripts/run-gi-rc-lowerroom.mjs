// Repro of the user's "black floor with a sharp lit circle" report:
// a USER-SCALE tall room (12x9x12) split horizontally by a thin slab, with
// a THIN floor (thinner than the auto-fit cell size → single shell layer).
// Lamps live in the LOWER room (a sphere lamp mid-air + a squashed-sphere
// lamp on the floor). Expectation: the lower floor is clearly lit by its
// own lamps. Bug report: floor renders black except a sharp-edged circle.
import puppeteer from "puppeteer-core";
import sharp from "sharp";

const url = process.argv[2] ?? "http://localhost:5201/";
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
page.on("console", (message) => {
  const text = message.text();
  if (/\[gi\]|GI-LR|pageerror/.test(text)) console.log(`${message.type()}: ${text}`);
});
page.on("pageerror", (error) => console.log(`pageerror: ${error.stack ?? error.message}`));

await page.goto(url, { waitUntil: "load", timeout: 30000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await new Promise((resolve) => setTimeout(resolve, 5000));

await page.evaluate(async () => {
  const { THREE } = await import("/src/engine/index.js");
  await import("/src/modules/index.js");
  const { enableEngineModule } = await import("/src/engine/modules.js");
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  await enableEngineModule(engine, "gi");
  globalThis.__engine = engine;
  globalThis.__THREE = THREE;

  // USER'S BUILDING BLOCKS: thin DoubleSide PLANES, some facing OUT of the
  // room, plus a big ground plane — mirrors their Cornell construction.
  const material = (color) =>
    new THREE.MeshStandardNodeMaterial({ color, roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
  const addPlane = (size, position, rotation, color, name) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(...size), material(color));
    mesh.position.set(...position);
    mesh.rotation.set(...rotation);
    mesh.name = name;
    engine.scene.add(mesh);
    return mesh;
  };
  // Big ground plane (60x60, like the user's) — the room floor IS this plane.
  addPlane([60, 60], [0, 0, 0], [-Math.PI / 2, 0, 0], 0xcccccc, "ground");
  addPlane([12, 12], [0, 9, 0], [Math.PI / 2, 0, 0], 0xb8c3cf, "ceiling");
  addPlane([12, 9], [0, 4.5, -6], [0, Math.PI, 0], 0xb8c3cf, "back"); // normal → -Z, outward
  addPlane([12, 9], [-6, 4.5, 0], [0, -Math.PI / 2, 0], 0x9f2418, "red"); // outward
  addPlane([12, 9], [6, 4.5, 0], [0, Math.PI / 2, 0], 0x3a9f24, "green"); // outward
  // Thin slab splitting the room at y = 4.5 — a PLANE like the user's.
  addPlane([12, 12], [0, 4.5, 0], [-Math.PI / 2, 0, 0], 0xd0d0d0, "slab");

  // Dense baked-SDF mesh standing in the LOWER room (character stand-in) —
  // becomes a detail slot in the shadow/mirror traces.
  const knot = new THREE.Mesh(
    new THREE.TorusKnotGeometry(0.9, 0.32, 220, 24),
    new THREE.MeshStandardNodeMaterial({ color: 0x888a90, roughness: 0.35, metalness: 0.9 }),
  );
  knot.position.set(-1.6, 1.5, 0.6);
  knot.name = "knot";
  engine.scene.add(knot);

  const lampMaterial = () => {
    const m = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 1 });
    m.emissive = new THREE.Color(0xffffff);
    m.emissiveIntensity = 8;
    return m;
  };
  // UPPER room: ceiling lamp + a white box prop.
  const upperLamp = new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 16), lampMaterial());
  upperLamp.position.set(0, 8.2, 0);
  upperLamp.name = "upperLamp";
  engine.scene.add(upperLamp);
  const cube = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), material(0xeeeeee));
  cube.position.set(2.6, 5.63, -1.4);
  cube.name = "cube";
  engine.scene.add(cube);

  // LOWER room: sphere lamp mid-air + squashed-sphere lamp resting on floor.
  const midLamp = new THREE.Mesh(new THREE.SphereGeometry(0.6, 24, 16), lampMaterial());
  midLamp.position.set(1.6, 2.2, 1.0);
  midLamp.name = "midLamp";
  engine.scene.add(midLamp);
  const floorLamp = new THREE.Mesh(new THREE.SphereGeometry(0.9, 24, 16), lampMaterial());
  floorLamp.scale.set(1, 0.22, 1);
  floorLamp.position.set(1.9, 0.2, 3.2);
  floorLamp.name = "floorLamp";
  engine.scene.add(floorLamp);

  const giEntity = engine.createEntity({ name: "GI" });
  giEntity.addComponent("global-illumination", {
    autoFit: true, quality: "medium", intensity: 1,
  });

  // Camera outside the open front wall, seeing both floors (user's view).
  engine.camera.position.set(0.4, 4.2, 16.5);
  engine.camera.lookAt(0, 3.6, 0);
  engine.camera.updateMatrixWorld(true);
  console.log("GI-LR scene ready");
});

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await settle(11000);

async function measure(tag) {
  const points = await page.evaluate(() => {
    const engine = globalThis.__engine;
    const THREE = globalThis.__THREE;
    engine.camera.updateMatrixWorld(true);
    const canvas = [...document.querySelectorAll("canvas")].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const rect = canvas.getBoundingClientRect();
    const samples = [
      ...[-5, -3.5, -2, -1, 0, 1, 2, 3.5, 5].map((x) => ({ tag: `floor x=${x}`, world: [x, 0.06, 2.5] })),
      ...[-5, -2.5, 0, 2.5, 5].map((x) => ({ tag: `floorBack x=${x}`, world: [x, 0.06, -2.5] })),
      { tag: "redLower", world: [-5.95, 2.2, 0] },
      { tag: "greenLower", world: [5.95, 2.2, 0] },
      { tag: "slabUnder", world: [0, 4.38, 1.5] },
      { tag: "slabTop", world: [-2, 4.63, 1.5] },
      { tag: "greenUpper", world: [5.95, 6.5, 0] },
    ];
    const out = [];
    for (const s of samples) {
      const world = new THREE.Vector3(...s.world);
      const projected = world.clone().project(engine.camera);
      if (Math.abs(projected.x) > 0.98 || Math.abs(projected.y) > 0.98) continue;
      const px = rect.x + ((projected.x + 1) / 2) * rect.width;
      const py = rect.y + ((1 - projected.y) / 2) * rect.height;
      out.push({ tag: s.tag, px: Math.round(px), py: Math.round(py) });
    }
    return out;
  });
  const shot = await page.screenshot({ path: `scripts/gi-diag-lowerroom-${tag}.png` });
  const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
  console.log(
    `${tag}:`,
    points
      .map((point) => {
        const idx = (point.py * info.width + point.px) * info.channels;
        const luma = Math.round(0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2]);
        return `${point.tag}:L${luma}`;
      })
      .join(" "),
  );
}

await measure("main");

// Read back the FLOOR's field cells: occupancy + stored normal, to check the
// single-shell-layer normal direction (the suspected root cause).
const cells = await page.evaluate(async () => {
  const engine = globalThis.__engine;
  const system = engine.modules.get("gi").system;
  const state = system.state;
  const volume = state.volume;
  const renderer = engine.renderer;
  const staging = new Float32Array(await renderer.getArrayBufferAsync(volume.stagingBuffer.value));
  const normals = new Float32Array(await renderer.getArrayBufferAsync(volume.normalBuffer.value));
  const { res, bounds, cell } = volume;
  const idxOf = (x, y, z) => (z * res.y + y) * res.x + x;
  const report = [];
  // Column at world (0, *, 2.5) — sweep y cells around the floor plane.
  const cx = Math.floor((0 - bounds.min.x) / cell.x);
  const cz = Math.floor((2.5 - bounds.min.z) / cell.z);
  for (let y = 0; y < Math.min(8, res.y); y++) {
    const i = idxOf(cx, y, cz);
    const occ = staging[i * 4 + 3];
    if (occ > 0.5 || y < 6) {
      report.push({
        y,
        worldY: +(bounds.min.y + (y + 0.5) * cell.y).toFixed(3),
        occ,
        n: [+normals[i * 4].toFixed(2), +normals[i * 4 + 1].toFixed(2), +normals[i * 4 + 2].toFixed(2)],
      });
    }
  }
  return { cellY: +cell.y.toFixed(3), boundsMinY: +bounds.min.y.toFixed(3), report };
});
console.log("floor cells:", JSON.stringify(cells));

await browser.close();
process.exit(0);
