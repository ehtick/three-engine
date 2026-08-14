// HDRI skybox / IBL smoke test — the equirectangular half of the scene's sky.
//
// `settings.environment.cubemap` takes a `.cubemap` OR an equirect `.hdr`/`.exr`
// (engine/environmentAsset.js). `run-cubemap-skybox.mjs` proves the six-face
// shape; this proves the panorama one, in a real WebGPU context: a .hdr file ->
// HDRLoader -> `scene.background` (sky renders) + `scene.environment` (IBL
// reaches a material), with the right way up.
//
// The way-up check is the one that earns its keep. An equirect assigned without
// `EquirectangularReflectionMapping` still renders — as a stretched rectangle —
// and a v-flip still renders, upside down. Neither is an error; both are a
// picture. So the harness paints the top half of the panorama RED and the
// bottom half GREEN and looks up and down.
//
//   npx vite --port 5209 --strictPort
//   node scripts/run-hdri-skybox.mjs [url]
import puppeteer from "puppeteer-core";
import sharp from "sharp";

const url = process.argv[2] ?? "http://localhost:5209/";

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 });
page.on("pageerror", (error) => console.log(`pageerror: ${error.stack ?? error.message}`));
page.on("console", (m) => {
  if (m.type() === "error" || /HDRI-/.test(m.text())) console.log(`${m.type()}: ${m.text().slice(0, 300)}`);
});

await page.goto(url, { waitUntil: "load", timeout: 30000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await new Promise((resolve) => setTimeout(resolve, 6000));

const setup = await page.evaluate(async () => {
  const { THREE, setAssetResolver } = await import("/src/engine/index.js");
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  globalThis.__engine = engine;
  globalThis.__THREE = THREE;

  /**
   * A 64x32 Radiance (.hdr) panorama: top half red, bottom half green.
   *
   * Written by hand rather than fetched, so the harness needs no asset on disk.
   * FLAT (un-RLE'd) scanlines, which HDRLoader accepts from any file whose first
   * byte is not the RLE marker `2` — the one shape of this format simple enough
   * to emit correctly in a dozen lines. RGBE packs a colour as mantissa bytes
   * plus a shared exponent: value = rgb * 2^(e-128) / 256, so (128, 0, 0, 129)
   * is exactly (1, 0, 0).
   *
   * The SIZE matters and is not arbitrary. Image-based lighting goes through
   * three's PMREM, which derives its cube size from the source image; a toy
   * 4x2 panorama filters down to nothing and lights a white sphere BLACK while
   * the sky itself still draws perfectly. That is a property of the test image,
   * not of the engine — but it looks exactly like a broken IBL path, so the
   * harness stays above it.
   */
  const hdrBytes = () => {
    const [w, h] = [64, 32];
    const header = `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${h} +X ${w}\n`;
    const bytes = [...header].map((c) => c.charCodeAt(0));
    const RED = [128, 0, 0, 129];
    const GREEN = [0, 128, 0, 129];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) bytes.push(...(y < h / 2 ? RED : GREEN));
    }
    return new Uint8Array(bytes);
  };

  const hdrUrl = URL.createObjectURL(new Blob([hdrBytes()], { type: "image/vnd.radiance" }));
  setAssetResolver(async (path) => (path === "harness/sky.hdr" ? hdrUrl : path));

  // A white dielectric sphere with NO lights and NO ambient: anything but black
  // on it comes from the HDRI's image-based lighting.
  const probe = new THREE.Mesh(
    new THREE.SphereGeometry(1, 48, 32),
    new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0 }),
  );
  probe.name = "iblProbe";
  engine.scene.add(probe);

  await engine.applySettings({
    ambientIntensity: 0,
    environment: { cubemap: "harness/sky.hdr", background: true, lighting: true, intensity: 1 },
  });

  // The decode is async — poll until the texture lands on the scene.
  for (let i = 0; i < 100; i++) {
    if (engine.scene.background?.isTexture) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const background = engine.scene.background;
  return {
    isTexture: background?.isTexture === true,
    isEquirect: background?.mapping === THREE.EquirectangularReflectionMapping,
    isEnvironment: engine.scene.environment === background,
    size: `${background?.image?.width ?? 0}x${background?.image?.height ?? 0}`,
  };
});

console.log(`background is a Texture     : ${setup.isTexture} (${setup.size})`);
console.log(`mapping is Equirectangular  : ${setup.isEquirect}`);
console.log(`same texture as environment : ${setup.isEnvironment}`);

const canvasRect = await page.evaluate(() => {
  const canvas = [...document.querySelectorAll("canvas")].sort(
    (a, b) => b.width * b.height - a.width * a.height,
  )[0];
  const rect = canvas.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
});

/** Aims the editor camera down `dir` from the origin and reads an off-centre
 *  pixel — off-centre so the probe sphere (which surrounds the camera here)
 *  cannot be what the sky assertion actually measured. */
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
  const px = Math.round(canvasRect.x + canvasRect.width * 0.12);
  const py = Math.round(canvasRect.y + canvasRect.height * 0.12);
  const idx = (py * info.width + px) * info.channels;
  return { rgb: [data[idx], data[idx + 1], data[idx + 2]], aimNdc };
}

// Tone mapping pulls a saturated channel well below 255, so compare the
// dominant channel rather than exact values.
const dominant = ([r, g, b]) => (r > g && r > b ? "red" : g > r && g > b ? "green" : `neither(${r},${g},${b})`);

let orientationOk = true;
for (const [label, dir, expected] of [
  ["look up   (+Y)", [0, 1, 0], "red"],
  ["look down (−Y)", [0, -1, 0], "green"],
]) {
  const { rgb, aimNdc } = await sampleDirection(dir);
  const got = dominant(rgb);
  const aimed = Math.abs(aimNdc[0]) < 0.02 && Math.abs(aimNdc[1]) < 0.02;
  const ok = got === expected && aimed;
  orientationOk = orientationOk && ok;
  console.log(
    `${label} -> rgb(${rgb.join(", ")}) = ${got} (expected ${expected})` +
      ` · aim NDC ${aimNdc.join(",")} ${aimed ? "" : "CAMERA NOT AIMED"} ${ok ? "OK" : "MISMATCH"}`,
  );
}

// IBL: frame the probe sphere and confirm the sky alone lights it.
await page.evaluate(async () => {
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
});
await new Promise((resolve) => setTimeout(resolve, 800));
const shot = await page.screenshot({ path: "scripts/hdri-skybox.png" });
{
  const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
  const px = Math.round(canvasRect.x + canvasRect.width * 0.5);
  const py = Math.round(canvasRect.y + canvasRect.height * 0.5);
  const idx = (py * info.width + px) * info.channels;
  const rgb = [data[idx], data[idx + 1], data[idx + 2]];
  const lit = rgb.some((c) => c > 40);
  console.log(`ibl probe center -> rgb(${rgb.join(", ")}) ${lit ? "LIT by sky" : "BLACK (no IBL)"}`);
  const pass = setup.isTexture && setup.isEquirect && setup.isEnvironment && orientationOk && lit;
  console.log(`RESULT: ${pass ? "PASS" : "FAIL"}`);
}
console.log("SHOT scripts/hdri-skybox.png");
await browser.close();
process.exit(0);
