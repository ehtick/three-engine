// Measures the main-thread freeze caused by a GI config change (quality
// switch → full rebuild → material recompile wave) and by initial enable.
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5201/";
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
page.on("console", (m) => {
  if (/\[gi\]|GI-RB/.test(m.text())) console.log(`${m.type()}: ${m.text()}`);
});
page.on("pageerror", (e) => console.log(`pageerror: ${e.stack ?? e.message}`));

await page.goto(url, { waitUntil: "load", timeout: 30000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await new Promise((r) => setTimeout(r, 5000));

// A/B switch for the per-builder Fn layouts (giFn.js): NOLAYOUTS=1 reproduces
// the previous shipped codegen on the SAME machine state.
if (process.env.NOLAYOUTS) await page.evaluate(() => { globalThis.__giNoLayouts = true; });

await page.evaluate(async () => {
  globalThis.__refl = new URLSearchParams(location.search).get("norefl") ? false : true;
  const { THREE } = await import("/src/engine/index.js");
  await import("/src/modules/index.js");
  const { enableEngineModule } = await import("/src/engine/modules.js");
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  await enableEngineModule(engine, "gi");
  globalThis.__engine = engine;

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
  addPlane([12, 12], [0, 0, 0], [-Math.PI / 2, 0, 0], 0xcccccc, "ground");
  addPlane([12, 12], [0, 9, 0], [Math.PI / 2, 0, 0], 0xb8c3cf, "ceiling");
  addPlane([12, 9], [0, 4.5, -6], [0, Math.PI, 0], 0xb8c3cf, "back");
  addPlane([12, 9], [-6, 4.5, 0], [0, -Math.PI / 2, 0], 0x9f2418, "red");
  addPlane([12, 9], [6, 4.5, 0], [0, Math.PI / 2, 0], 0x3a9f24, "green");
  // 20 distinct materials — approximates a real scene's compile-wave width.
  for (let i = 0; i < 20; i++) {
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.5, 0.5),
      new THREE.MeshStandardNodeMaterial({
        color: new THREE.Color().setHSL(i / 20, 0.6, 0.55),
        roughness: 0.2 + (i % 5) * 0.18,
        metalness: i % 2 ? 0.9 : 0,
      }),
    );
    box.position.set(-4 + (i % 5) * 2, 0.6 + Math.floor(i / 5) * 1.4, -3 + (i % 3) * 3);
    engine.scene.add(box);
  }
  const lamp = new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 24, 16),
    (() => {
      const m = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 1 });
      m.emissive = new THREE.Color(0xffffff);
      m.emissiveIntensity = 8;
      return m;
    })(),
  );
  lamp.position.set(0, 8.2, 0);
  engine.scene.add(lamp);
  engine.camera.position.set(0.4, 4.2, 16.5);
  engine.camera.lookAt(0, 3.6, 0);
  engine.camera.updateMatrixWorld(true);
  console.log("GI-RB scene ready (no GI yet)");
});

const measure = async (tag, action, ms) => {
  const stats = await page.evaluate(
    async ({ action, ms }) => {
      const engine = globalThis.__engine;
      const deltas = [];
      const start = performance.now();
      let last = start;
      // eslint-disable-next-line no-eval
      await eval(action)(engine);
      return await new Promise((resolve) => {
        const step = (now) => {
          deltas.push(now - last);
          last = now;
          if (now - start < ms) requestAnimationFrame(step);
          else {
            let worst = 0, worstAt = 0, acc = 0;
            for (const d of deltas) { acc += d; if (d > worst) { worst = d; worstAt = acc; } }
            resolve({ worst, worstAt });
          }
        };
        requestAnimationFrame(step);
      });
    },
    { action, ms },
  );
  console.log(`${tag}: worst frame ${stats.worst.toFixed(0)}ms (ended ${(stats.worstAt / 1000).toFixed(1)}s after action)`);
};

await measure(
  "enable GI (first build + compile wave)",
  `async (engine) => {
    const giEntity = engine.createEntity({ name: "GI" });
    globalThis.__gi = giEntity.addComponent("global-illumination", { autoFit: true, quality: "high", intensity: 1, reflections: globalThis.__refl });
  }`,
  25000,
);
console.log(
  await page.evaluate(() => {
    const nodes = globalThis.__engine.renderer._nodes;
    const materials = new Set();
    globalThis.__engine.scene.traverse((o) => {
      if (o.isMesh && o.material) materials.add(o.material);
    });
    // sample two same-structure materials' cache keys
    const ro = [];
    globalThis.__engine.scene.traverse((o) => {
      if (o.isMesh && o.material?.isMeshStandardNodeMaterial) ro.push(o);
    });
    return `CACHE nodeBuilderCache.size=${nodes.nodeBuilderCache.size} materials=${materials.size}`;
  }),
);

await measure(
  "quality high→ultra (rebuild)",
  `async () => {
    globalThis.__gi.props.quality = "ultra";
    globalThis.__gi.onPropChanged("quality");
  }`,
  25000,
);
await measure(
  "quality ultra→medium (rebuild)",
  `async () => {
    globalThis.__gi.props.quality = "medium";
    globalThis.__gi.onPropChanged("quality");
  }`,
  25000,
);
await measure(
  "intensity change (live, no rebuild)",
  `async () => {
    globalThis.__gi.props.intensity = 0.6;
    globalThis.__gi.onPropChanged("intensity");
  }`,
  3000,
);

await browser.close();
process.exit(0);
