// Viewport-RESIZE regression: a resize swaps the deferred-resolve targets
// (giIrradiance / giEmitterShadow) behind the persistent texture nodes. If the
// swap does not actually rebind, every material keeps sampling the OLD pair,
// which is then destroyed — the console fills with "Destroyed texture used in
// a submit" and the GI field disappears.
//
// PASS = zero destroyed-texture / validation errors after several resizes AND
// the sampled wall pixels still carry bounce light (non-black, close to the
// pre-resize reading).
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

const validationErrors = [];
page.on("console", (message) => {
  const text = message.text();
  if (/Destroyed texture|GPUValidationError|used in a submit/.test(text)) validationErrors.push(text.slice(0, 200));
  if (/\[gi\]|GI-RS/.test(text)) console.log(`${message.type()}: ${text}`);
});
page.on("pageerror", (error) => console.log(`pageerror: ${error.stack ?? error.message}`));
page.on("error", (error) => console.log(`PAGE CRASHED: ${error.message}`));

// NOFIX=1 restores the pre-fix behaviour (both target generations at version
// 0, so three never rebinds) — the A/B that proves the root cause.
if (process.env.NOFIX) {
  await page.evaluateOnNewDocument(() => {
    globalThis.__giNoTargetVersion = true;
  });
}
// KEEP=1 never destroys a replaced target pair (leaks them). Isolates "the
// destroy is premature" from "the rebind never happens".
if (process.env.KEEP) {
  await page.evaluateOnNewDocument(() => {
    globalThis.__giKeepRetiredTargets = true;
  });
}

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

  const material = (color) => new THREE.MeshStandardNodeMaterial({ color, roughness: 0.9, metalness: 0 });
  const addBox = (size, position, color, name) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material(color));
    mesh.position.set(...position);
    mesh.name = name;
    engine.scene.add(mesh);
    return mesh;
  };
  addBox([6, 0.1, 6], [0, -0.05, 0], 0xcccccc, "floor");
  addBox([6, 0.1, 6], [0, 5.05, 0], 0xb8c3cf, "ceiling");
  addBox([6, 5, 0.1], [0, 2.5, -3.05], 0xb8c3cf, "back");
  addBox([0.1, 5, 6], [-3.05, 2.5, 0], 0x9f2418, "red");
  addBox([0.1, 5, 6], [3.05, 2.5, 0], 0x3a9f24, "green");

  const lampMaterial = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 1 });
  lampMaterial.emissive = new THREE.Color(0xffffff);
  lampMaterial.emissiveIntensity = 10;
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.4, 24, 16), lampMaterial);
  lamp.position.set(0, 4.4, 0.4);
  lamp.name = "lamp";
  engine.scene.add(lamp);

  const giEntity = engine.createEntity({ name: "GI" });
  giEntity.addComponent("global-illumination", { autoFit: true, quality: "medium", intensity: 1 });

  engine.camera.position.set(0.1, 1.9, 5.6);
  engine.camera.lookAt(0, 1.4, 0);
  engine.camera.updateMatrixWorld(true);
  console.log("GI-RS scene ready");
});

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitForWave = async (extra = 1500) => {
  for (let i = 0; i < 90; i++) {
    await settle(1000);
    const suspended = await page.evaluate(() => globalThis.__engine?.renderSuspended === true);
    if (!suspended) break;
  }
  await settle(extra);
};

// Wall points, well clear of the lamp and of every silhouette — these read
// pure bounce light, so a dead GI field shows up as (near) black.
const sampleWalls = async (tag) => {
  const points = await page.evaluate(() => {
    const engine = globalThis.__engine;
    const THREE = globalThis.__THREE;
    engine.camera.updateMatrixWorld(true);
    const canvas = [...document.querySelectorAll("canvas")].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const rect = canvas.getBoundingClientRect();
    const project = (v, name) => {
      const projected = v.clone().project(engine.camera);
      return {
        name,
        px: Math.round(rect.x + ((projected.x + 1) / 2) * rect.width),
        py: Math.round(rect.y + ((1 - projected.y) / 2) * rect.height),
      };
    };
    return [
      project(new THREE.Vector3(-2.9, 2.2, -1.0), "redWall"),
      project(new THREE.Vector3(2.9, 2.2, -1.0), "greenWall"),
      project(new THREE.Vector3(0, 0.05, -1.2), "floor"),
      project(new THREE.Vector3(0, 3.4, -2.9), "backWall"),
    ];
  });
  const shot = await page.screenshot({ path: `scripts/gi-diag-resize-${tag}.png` });
  const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
  const readings = {};
  for (const point of points) {
    const idx = (point.py * info.width + point.px) * info.channels;
    readings[point.name] = [data[idx], data[idx + 1], data[idx + 2]];
  }
  console.log(
    `${tag}: ` +
      Object.entries(readings)
        .map(([name, rgb]) => `${name} rgb(${rgb.join(", ")})`)
        .join("  "),
  );
  return readings;
};

await settle(12000);
await waitForWave(2000);

// PROBE=1 hooks three's Bindings._update and tallies, per GI texture binding,
// which texture VERSION the binding carried on the way in and on the way out.
// A binding that keeps an old version after the swap is a stale bind group.
if (process.env.PROBE) {
  await page.evaluate(() => {
    const bindings = globalThis.__engine.renderer._bindings;
    const proto = Object.getPrototypeOf(bindings);
    const original = proto._update;
    const tally = { in: {}, out: {}, rebinds: 0 };
    globalThis.__probe = tally;
    const scan = (bucket, bindGroup) => {
      for (const binding of bindGroup.bindings) {
        if (!binding.isSampledTexture) continue;
        const name = binding.texture?.name ?? "";
        if (!name.startsWith("gi")) continue;
        const key = `${name}@v${binding.texture.version}/gen${binding.generation}`;
        bucket[key] = (bucket[key] ?? 0) + 1;
      }
    };
    proto._update = function (bindGroup, bindingsArray) {
      scan(tally.in, bindGroup);
      const result = original.call(this, bindGroup, bindingsArray);
      scan(tally.out, bindGroup);
      return result;
    };
    const backendProto = Object.getPrototypeOf(globalThis.__engine.renderer.backend);
    const originalUpdate = backendProto.updateBindings;
    backendProto.updateBindings = function (...args) {
      tally.rebinds++;
      return originalUpdate.apply(this, args);
    };
  });
}

// WHOBINDS=1 names, per material, which GI textures end up in that material's
// bind groups — i.e. which pass is actually holding the resolve targets.
if (process.env.WHOBINDS) {
  await page.evaluate(() => {
    const bindings = globalThis.__engine.renderer._bindings;
    const proto = Object.getPrototypeOf(bindings);
    const original = proto.updateForRender;
    const tally = {};
    globalThis.__whoBinds = tally;
    proto.updateForRender = function (renderObject) {
      for (const group of this.getForRender(renderObject)) {
        for (const binding of group.bindings) {
          if (!binding.isSampledTexture) continue;
          const name = binding.texture?.name ?? "";
          if (!name.startsWith("gi")) continue;
          const key = `${renderObject.material?.name || renderObject.material?.type}::${name}@v${binding.texture.version}`;
          tally[key] = (tally[key] ?? 0) + 1;
        }
      }
      return original.call(this, renderObject);
    };
  });
}

// STACKS=1 brackets every queue.submit in a validation error scope and keeps
// the JS stack of the ones that fail — that names the pass holding the stale
// texture instead of guessing from the encoder label.
if (process.env.STACKS) {
  await page.evaluate(() => {
    const device = globalThis.__engine.renderer.backend.device;
    const queue = device.queue;
    const originalSubmit = queue.submit.bind(queue);
    globalThis.__submitFailures = [];
    queue.submit = (buffers) => {
      const stack = new Error().stack ?? "";
      device.pushErrorScope("validation");
      originalSubmit(buffers);
      device.popErrorScope().then((error) => {
        if (!error) return;
        globalThis.__submitFailures.push({
          message: error.message.split("\n")[0].slice(0, 140),
          stack: stack.split("\n").slice(1, 10).join(" << "),
        });
      });
    };
  });
}

const before = await sampleWalls("before");
const errorsBefore = validationErrors.length;

// Several resizes, including a shrink and a grow, each given a few frames to
// settle — the failure mode only needs ONE size change to latch.
for (const [width, height] of [
  [1100, 700],
  [1500, 950],
  [900, 620],
  [1400, 900],
]) {
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await settle(1200);
  console.log(`GI-RS resized to ${width}x${height}`);
}
await settle(2000);

if (process.env.PROBE) {
  const probe = await page.evaluate(() => globalThis.__probe);
  console.log("probe bindings IN :", JSON.stringify(probe.in));
  console.log("probe bindings OUT:", JSON.stringify(probe.out));
  console.log("probe bind-group rebuilds:", probe.rebinds);
  const live = await page.evaluate(() => globalThis.__giLastTargetVersion ?? null);
  console.log("newest target version:", live);
}

if (process.env.WHOBINDS) {
  const tally = await page.evaluate(() => globalThis.__whoBinds);
  console.log("materials holding GI textures:");
  for (const [key, count] of Object.entries(tally)) console.log(`  ${key} × ${count}`);
}

if (process.env.STACKS) {
  const failures = await page.evaluate(() => globalThis.__submitFailures ?? []);
  const unique = new Map();
  for (const failure of failures) if (!unique.has(failure.stack)) unique.set(failure.stack, failure);
  console.log(`failing submits: ${failures.length} (${unique.size} distinct call sites)`);
  for (const failure of unique.values()) console.log(`  ${failure.message}\n    at ${failure.stack}`);
}

const after = await sampleWalls("after");
const errorsAfter = validationErrors.length - errorsBefore;

console.log(`validation errors before resizes: ${errorsBefore}, after: ${errorsAfter}`);
for (const text of validationErrors.slice(0, 3)) console.log(`  ! ${text}`);

const luminance = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
let failures = 0;
if (errorsAfter > 0) {
  console.log(`FAIL: ${errorsAfter} WebGPU validation errors after resizing`);
  failures++;
}
for (const name of Object.keys(before)) {
  const l0 = luminance(before[name]);
  const l1 = luminance(after[name]);
  const drift = Math.abs(l1 - l0);
  const ok = l1 > 4 && drift < Math.max(12, l0 * 0.35);
  console.log(`${name}: L ${l0.toFixed(1)} → ${l1.toFixed(1)} (drift ${drift.toFixed(1)}) ${ok ? "ok" : "FAIL"}`);
  if (!ok) failures++;
}
console.log(failures === 0 ? "RESIZE PASS" : `RESIZE FAIL (${failures})`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
