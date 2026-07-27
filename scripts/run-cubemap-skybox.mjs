// Cube-map skybox / IBL smoke test.
//
// Proves the whole chain end to end in a real WebGPU context: a `.cubemap`
// asset -> CubeTexture -> `scene.background` (skybox renders) + `scene.environment`
// (image-based lighting reaches a material). Face order is verified by giving
// each face a unique color and aiming the camera down each axis.
//
//   npx vite --port 5209 --strictPort
//   node scripts/run-cubemap-skybox.mjs [url]
import puppeteer from "puppeteer-core";
import sharp from "sharp";

const url = process.argv[2] ?? "http://localhost:5209/";

// Face -> color, chosen so every channel pattern is distinct.
const FACE_COLORS = {
  px: [255, 0, 0], // right   red
  nx: [0, 255, 0], // left    green
  py: [0, 0, 255], // top     blue
  ny: [255, 255, 0], // bottom  yellow
  pz: [255, 0, 255], // front   magenta
  nz: [0, 255, 255], // back    cyan
};

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 });
page.on("pageerror", (error) => console.log(`pageerror: ${error.stack ?? error.message}`));
page.on("console", (m) => {
  if (m.type() === "error" || /CUBE-/.test(m.text())) console.log(`${m.type()}: ${m.text().slice(0, 300)}`);
});

await page.goto(url, { waitUntil: "load", timeout: 30000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await new Promise((resolve) => setTimeout(resolve, 6000));

const setup = await page.evaluate(async (faceColors) => {
  const { THREE, setAssetResolver } = await import("/src/engine/index.js");
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  globalThis.__engine = engine;
  globalThis.__THREE = THREE;

  // Stand in for the project filesystem: harness paths resolve to in-memory
  // URLs, so the real cubemapAsset loader runs unmodified.
  const solidPng = ([r, g, b]) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, 0, 64, 64);
    return canvas.toDataURL("image/png");
  };
  const faces = {};
  const urls = {};
  for (const [key, color] of Object.entries(faceColors)) {
    faces[key] = `harness/${key}.png`;
    urls[faces[key]] = solidPng(color);
  }
  const defJson = JSON.stringify({ version: 1, faces });
  urls["harness/sky.cubemap"] = URL.createObjectURL(new Blob([defJson], { type: "application/json" }));
  setAssetResolver(async (path) => urls[path] ?? path);
  globalThis.__faceUrls = urls;

  // A white dielectric sphere with NO lights and NO ambient: anything but
  // black on it comes from the cube map's image-based lighting.
  const probe = new THREE.Mesh(
    new THREE.SphereGeometry(1, 48, 32),
    new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0 }),
  );
  probe.name = "iblProbe";
  engine.scene.add(probe);

  await engine.applySettings({
    ambientIntensity: 0,
    environment: { cubemap: "harness/sky.cubemap", background: true, lighting: true, intensity: 1 },
  });

  // The decode is async — poll until the texture lands on the scene.
  for (let i = 0; i < 100; i++) {
    if (engine.scene.background?.isCubeTexture) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const background = engine.scene.background;
  return {
    isCubeTexture: background?.isCubeTexture === true,
    isEnvironment: engine.scene.environment === background,
    // Image order must be +X −X +Y −Y +Z −Z (three's CubeTextureLoader order).
    imageOrder: (background?.images ?? []).map((img) => {
      const src = img?.src ?? "";
      return Object.entries(urls).find(([, u]) => u === src)?.[0] ?? "?";
    }),
  };
}, FACE_COLORS);

console.log(`background is CubeTexture : ${setup.isCubeTexture}`);
console.log(`same texture as environment: ${setup.isEnvironment}`);
console.log(`image order               : ${setup.imageOrder.join(", ")}`);

const canvasRect = await page.evaluate(() => {
  const canvas = [...document.querySelectorAll("canvas")].sort(
    (a, b) => b.width * b.height - a.width * a.height,
  )[0];
  const rect = canvas.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
});

/** Points the editor camera down `dir` from the origin and returns the center
 *  pixel, plus the NDC of the aim point — the control that proves the camera
 *  really faces `dir` before we read any conclusion out of the pixel. */
async function sampleDirection(dir) {
  const aimNdc = await page.evaluate((direction) => {
    const engine = globalThis.__engine;
    const THREE = globalThis.__THREE;
    const viewport = globalThis.__viewport;
    const camera = viewport?.camera ?? engine.camera;
    camera.position.set(0, 0, 0);
    if (viewport?.orbit) {
      viewport.orbit.target.set(direction[0] * 10, direction[1] * 10, direction[2] * 10);
      viewport.orbit.update();
    } else {
      camera.lookAt(direction[0] * 10, direction[1] * 10, direction[2] * 10);
    }
    camera.updateMatrixWorld(true);
    const aim = new THREE.Vector3(...direction).multiplyScalar(10).project(camera);
    return [Number(aim.x.toFixed(3)), Number(aim.y.toFixed(3))];
  }, dir);
  await new Promise((resolve) => setTimeout(resolve, 700));
  const shot = await page.screenshot();
  const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
  // Off-center so the IBL probe sphere (at the origin, and therefore around
  // the camera) can't be what we read: sample near the frame's top-left.
  const px = Math.round(canvasRect.x + canvasRect.width * 0.12);
  const py = Math.round(canvasRect.y + canvasRect.height * 0.12);
  const idx = (py * info.width + px) * info.channels;
  return { rgb: [data[idx], data[idx + 1], data[idx + 2]], aimNdc };
}

// Which face color a sampled pixel is closest to. Tone mapping + sRGB pull a
// saturated 255 down to ~82 and a 0 up to ~23, so match the channel pattern
// rather than exact values.
const classify = ([r, g, b]) => {
  const on = (v) => (v > 50 ? 1 : 0);
  const pattern = `${on(r)}${on(g)}${on(b)}`;
  const match = Object.entries(FACE_COLORS).find(
    ([, c]) => `${on(c[0])}${on(c[1])}${on(c[2])}` === pattern,
  );
  return match?.[0] ?? `unknown(${r},${g},${b})`;
};

// Looking down an axis shows that axis' face image, EXCEPT in X, which three's
// cube-map sampling mirrors (the same `tFlip` convention its WebGL renderer
// uses, and the one every three cube-map example asset is authored for). So a
// standard six-file skybox pack loaded in +X −X +Y −Y +Z −Z order looks right,
// and reflections agree with the sky. A change to CUBEMAP_FACES' order would
// break these expectations.
const DIRECTIONS = [
  ["look +X", [1, 0, 0], "nx"],
  ["look −X", [-1, 0, 0], "px"],
  ["look +Y", [0, 1, 0], "py"],
  ["look −Y", [0, -1, 0], "ny"],
  ["look +Z", [0, 0, 1], "pz"],
  ["look −Z", [0, 0, -1], "nz"],
];

let orientationOk = true;
for (const [label, dir, expected] of DIRECTIONS) {
  const { rgb, aimNdc } = await sampleDirection(dir);
  const got = classify(rgb);
  const aimed = Math.abs(aimNdc[0]) < 0.02 && Math.abs(aimNdc[1]) < 0.02;
  const ok = got === expected && aimed;
  orientationOk = orientationOk && ok;
  console.log(
    `${label} -> rgb(${rgb.join(", ")}) = ${got} face (expected ${expected})` +
      ` · aim NDC ${aimNdc.join(",")} ${aimed ? "" : "CAMERA NOT AIMED"} ${ok ? "OK" : "MISMATCH"}`,
  );
}

// IBL: frame the probe sphere and confirm it is lit by the sky alone.
const probeSample = await page.evaluate(async () => {
  const engine = globalThis.__engine;
  const viewport = globalThis.__viewport;
  const camera = viewport?.camera ?? engine.camera;
  camera.position.set(0, 0, 5);
  if (viewport?.orbit) {
    viewport.orbit.target.set(0, 0, 0);
    viewport.orbit.update();
  } else {
    camera.lookAt(0, 0, 0);
  }
  camera.updateMatrixWorld(true);
  await new Promise((r) => setTimeout(r, 500));
  return true;
});
void probeSample;
await new Promise((resolve) => setTimeout(resolve, 800));
const shot = await page.screenshot({ path: "scripts/cubemap-skybox.png" });
{
  const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
  const px = Math.round(canvasRect.x + canvasRect.width * 0.5);
  const py = Math.round(canvasRect.y + canvasRect.height * 0.5);
  const idx = (py * info.width + px) * info.channels;
  const rgb = [data[idx], data[idx + 1], data[idx + 2]];
  const lit = rgb.some((c) => c > 40);
  console.log(`ibl probe center -> rgb(${rgb.join(", ")}) ${lit ? "LIT by sky" : "BLACK (no IBL)"}`);
  console.log(
    `RESULT: ${setup.isCubeTexture && setup.isEnvironment && orientationOk && lit ? "PASS" : "FAIL"}`,
  );
}
console.log("SHOT scripts/cubemap-skybox.png");
await browser.close();
process.exit(0);
