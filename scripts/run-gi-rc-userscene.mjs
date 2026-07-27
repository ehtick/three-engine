// Repro of the user's dragonkin two-story Cornell: room made of PLANE walls
// + thin mid partition, sitting ON a large ground plane, floor-hugging lamp
// below the partition + ceiling lamp above, knot (dragon stand-in), mirror
// egg. GI on a bare ROOT entity (tests the whole-scene fallback trim) or,
// with ?organizer=1, on an organizer entity holding only the room.
//
// Probes: floor radial profile below the low lamp (circle-cutoff check),
// lower-room brightness with only the UPPER lamp lit (partition leak),
// ceiling-top variance (outside checkerboard), shadow edge behind the box.
import puppeteer from "puppeteer-core";
import sharp from "sharp";

const url = process.argv[2] ?? "http://localhost:5201/";
const organizer = !!process.env.ORGANIZER;
const quality = process.env.GI_QUALITY ?? "high";
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1300, height: 900, deviceScaleFactor: 1 });
page.on("console", (message) => {
  const text = message.text();
  if (/\[gi\]|GI-US/.test(text)) console.log(`${message.type()}: ${text}`);
});
page.on("pageerror", (error) => console.log(`pageerror: ${error.message}`));
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log(`${m.type()}: ${m.text().slice(0, 500)}`); });
page.on("error", (error) => console.log(`PAGE CRASHED: ${error.message}`));

await page.goto(url, { waitUntil: "load", timeout: 30000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await new Promise((resolve) => setTimeout(resolve, 5000));

await page.evaluate(
  async ({ organizer, quality }) => {
    const { THREE } = await import("/src/engine/index.js");
    await import("/src/modules/index.js");
    const { enableEngineModule } = await import("/src/engine/modules.js");
    const { ensureEngine } = await import("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    await enableEngineModule(engine, "gi");
    globalThis.__engine = engine;
    globalThis.__THREE = THREE;
    engine.camera.layers.disable(31); // editor grid pollutes pixel probes

    const roomRoot = new THREE.Group();
    roomRoot.name = "roomRoot";
    engine.scene.add(roomRoot);
    const parentFor = () => roomRoot;

    const material = (color) =>
      new THREE.MeshStandardNodeMaterial({ color, roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
    const allBaked = new URLSearchParams(location.search).get("baked") === "1";
    const wallGeometry = (size) => {
      const g = new THREE.PlaneGeometry(...size);
      if (!allBaked) return g;
      // Simulate geometry-editor walls: strip the primitive identity so the
      // GI takes the baked-SDF path instead of the exact analytic one.
      const stripped = g.toNonIndexed();
      stripped.parameters = undefined;
      return stripped;
    };
    const addPlane = (parent, size, position, rotation, color, name) => {
      const mesh = new THREE.Mesh(wallGeometry(size), material(color));
      mesh.position.set(...position);
      mesh.rotation.set(...rotation);
      mesh.name = name;
      parent.add(mesh);
      return mesh;
    };
    // Big ground plane the room SITS on (the auto-fit trap) — direct scene child.
    addPlane(engine.scene, [60, 60], [0, 0, 0], [-Math.PI / 2, 0, 0], 0x777777, "bigGround");

    // Room: 8m wide, 6m tall, 8m deep, thin partition at y=3.
    const W = 8, H = 6, D = 8;
    addPlane(parentFor(), [W, D], [0, 0.011, 0], [-Math.PI / 2, 0, 0], 0xcccccc, "roomFloor");
    addPlane(parentFor(), [W, D], [0, H, 0], [Math.PI / 2, 0, 0], 0xc4c9cf, "ceiling");
    addPlane(parentFor(), [W, H], [0, H / 2, -D / 2], [0, 0, 0], 0xc4c9cf, "back");
    addPlane(parentFor(), [D, H], [-W / 2, H / 2, 0], [0, Math.PI / 2, 0], 0x9f2418, "red");
    addPlane(parentFor(), [D, H], [W / 2, H / 2, 0], [0, -Math.PI / 2, 0], 0x3a9f24, "green");
    // Thin mid partition (full span) — the leak test subject.
    // NON-primitive slab (simulates geometry-editor/GLB walls): no
    // `parameters` → no analytic slot → exercises the BAKED thin-wall path.
    const slabGeometry = new THREE.BoxGeometry(W, 0.05, D).toNonIndexed();
    slabGeometry.parameters = undefined;
    const slab = new THREE.Mesh(slabGeometry, material(0xb9b9b9));
    slab.position.set(0, 3, 0);
    slab.name = "slab";
    parentFor().add(slab);

    const lampMaterial = (intensity) => {
      const m = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 1 });
      m.emissive = new THREE.Color(0xffffff);
      m.emissiveIntensity = intensity;
      return m;
    };
    // Upper lamp under ceiling; LOWER lamp hugging the floor (circle test).
    const upperLamp = new THREE.Mesh(new THREE.SphereGeometry(0.45, 24, 16), lampMaterial(9));
    upperLamp.position.set(0, 5.2, 0);
    upperLamp.name = "upperLamp";
    parentFor().add(upperLamp);
    const lowLamp = new THREE.Mesh(new THREE.SphereGeometry(0.45, 24, 16), lampMaterial(9));
    lowLamp.position.set(0.8, 0.55, 1.0);
    lowLamp.name = "lowLamp";
    parentFor().add(lowLamp);
    globalThis.__lowLamp = lowLamp;
    globalThis.__upperLamp = upperLamp;
    globalThis.__slab = slab;

    const knot = new THREE.Mesh(
      new THREE.TorusKnotGeometry(0.7, 0.24, 200, 20),
      new THREE.MeshStandardNodeMaterial({ color: 0x8a8d92, roughness: 0.35, metalness: 0.9 }),
    );
    knot.position.set(-2.0, 4.1, 0.4);
    knot.name = "knot";
    parentFor().add(knot);

    const egg = new THREE.Mesh(
      new THREE.SphereGeometry(0.8, 48, 32),
      new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.08, metalness: 1 }),
    );
    egg.scale.set(1, 1.25, 1);
    egg.position.set(1.8, 4.3, -0.8);
    egg.name = "egg";
    parentFor().add(egg);

    // GI component: bare ROOT entity (fallback) or organizer entity that
    // ADOPTS the room group (entity-driven exact bounds).
    const giEntity = engine.createEntity({ name: "GI" });
    if (organizer) giEntity.object3D.add(roomRoot);
    giEntity.addComponent("global-illumination", { autoFit: true, quality, intensity: 1 });

    engine.camera.position.set(0.5, 2.2, 9.5);
    engine.camera.lookAt(0, 2.2, 0);
    engine.camera.updateMatrixWorld(true);
    console.log(`GI-US scene ready (organizer=${organizer})`);
  },
  { organizer, quality },
);

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Wait for the async compile wave to finish (render is suspended during it
// — screenshots would sample a frozen pre-GI frame).
for (let i = 0; i < 120; i++) {
  await settle(1000);
  const suspended = await page.evaluate(() => globalThis.__engine.renderSuspended === true);
  if (!suspended && i >= 8) break;
  if (i % 5 === 4) console.log(`waiting: renderSuspended=${suspended} at ${i + 1}s`);
}
await settle(3000);

const sampleWorldPoints = async (points, tag, shotPath) => {
  const projected = await page.evaluate((pts) => {
    const engine = globalThis.__engine;
    const THREE = globalThis.__THREE;
    engine.camera.updateMatrixWorld(true);
    const canvas = [...document.querySelectorAll("canvas")].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const rect = canvas.getBoundingClientRect();
    return pts.map(([x, y, z, label]) => {
      const v = new THREE.Vector3(x, y, z).project(engine.camera);
      return {
        label,
        px: Math.round(rect.x + ((v.x + 1) / 2) * rect.width),
        py: Math.round(rect.y + ((1 - v.y) / 2) * rect.height),
      };
    });
  }, points);
  const shot = await page.screenshot({ path: shotPath });
  const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
  const lum = ({ px, py }) => {
    const idx = (py * info.width + px) * info.channels;
    return Math.round(0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2]);
  };
  console.log(`${tag}: ` + projected.map((p) => `${p.label}:L${lum(p)}`).join(" "));
};

// ---- View 1: lower room, floor radial profile away from the low lamp.
await page.evaluate(() => {
  const engine = globalThis.__engine;
  engine.camera.position.set(0.8, 2.4, 7.5);
  engine.camera.lookAt(0.8, 0.6, 0);
  engine.camera.updateMatrixWorld(true);
});
await settle(600);
const radial = [];
for (let r = 0.6; r <= 3.4; r += 0.4) {
  radial.push([0.8 - r, 0.03, 1.0, `r${r.toFixed(1)}`]);
}
await sampleWorldPoints(radial, "lowlamp floor radial(-x)", "scripts/gi-diag-us-lower.png");

// ---- Leak test: turn the LOW lamp off (emissive 0) → lower room should go
// dark except bounce through the open front; slab must block the upper lamp.
await page.evaluate(() => {
  globalThis.__lowLamp.material.emissiveIntensity = 0;
  globalThis.__lowLamp.material.needsUpdate = false;
});
await settle(2500);
await sampleWorldPoints(
  [
    [-1.5, 0.03, 0.5, "floorL"],
    [0, 0.03, 0, "floorC"],
    [1.5, 0.03, 0.5, "floorR"],
    [0, 2.9, 0, "slabUnder"],
  ],
  "upper-lamp-only lower room (leak check)",
  "scripts/gi-diag-us-leak.png",
);
await page.evaluate(() => {
  globalThis.__lowLamp.material.emissiveIntensity = 9;
});

// ---- View 2: ceiling top from outside (checkerboard test).
await page.evaluate(() => {
  const engine = globalThis.__engine;
  engine.camera.position.set(4.5, 10.5, 8.5);
  engine.camera.lookAt(0, 6, 0);
  engine.camera.updateMatrixWorld(true);
});
await settle(800);
const ceilTop = [];
for (let i = 0; i < 8; i++) {
  ceilTop.push([-3 + i * 0.85, 6.02, 0.5, `x${i}`]);
}
await sampleWorldPoints(ceilTop, "ceiling-top row (should be uniform dark)", "scripts/gi-diag-us-ceiling.png");

// ---- View 3: upper room look (mud on egg, shadows).
await page.evaluate(() => {
  const engine = globalThis.__engine;
  engine.camera.position.set(0.4, 4.7, 8.6);
  engine.camera.lookAt(0, 3.9, 0);
  engine.camera.updateMatrixWorld(true);
});
await settle(800);
await page.screenshot({ path: "scripts/gi-diag-us-upper.png" });

// Egg mirror probes (rgb): left face should catch red, right face green.
{
  const projected = await page.evaluate(() => {
    const engine = globalThis.__engine;
    const THREE = globalThis.__THREE;
    const canvas = [...document.querySelectorAll("canvas")].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const rect = canvas.getBoundingClientRect();
    const project = (x, y, z, label) => {
      const v = new THREE.Vector3(x, y, z).project(engine.camera);
      return { label, px: Math.round(rect.x + ((v.x + 1) / 2) * rect.width), py: Math.round(rect.y + ((1 - v.y) / 2) * rect.height) };
    };
    return [project(1.15, 4.3, -0.55, "eggLeft"), project(2.45, 4.3, -0.7, "eggRight"), project(1.8, 4.9, -0.65, "eggTop")];
  });
  const shot = await page.screenshot({});
  const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
  console.log(
    "egg rgb: " +
      projected
        .map((p) => {
          const idx = (p.py * info.width + p.px) * info.channels;
          return `${p.label}:(${data[idx]},${data[idx + 1]},${data[idx + 2]})`;
        })
        .join(" "),
  );
}

// Floor blockiness close-up: low grazing view along the upper floor.
await page.evaluate(() => {
  const engine = globalThis.__engine;
  engine.camera.position.set(-2.5, 3.9, 6.5);
  engine.camera.lookAt(1.5, 3.1, -2);
  engine.camera.updateMatrixWorld(true);
});
await settle(800);
await page.screenshot({ path: "scripts/gi-diag-us-floor.png" });
console.log("SHOTS scripts/gi-diag-us-{lower,leak,ceiling,upper,floor}.png");

await browser.close();
process.exit(0);
