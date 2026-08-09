// Does the sparse fine field reach the PICTURE? A/B of the SDF debug view.
//
// The structural harness (run-gi-sparse-field) proved bricks get ALLOCATED. It
// did not prove anything CONSUMES them — and those are separate failures with
// the same symptom: the user restarts, looks at the debug SDF, and sees the
// identical blobs. Allocation is a compute pass writing a texture; consumption
// is four different shaders sampling it. Either can be broken alone.
//
// So this renders the exact instrument the user is looking at, twice, and
// diffs the pixels. Identical pixels = the fine level is not reaching the
// image, no matter what the brick counter says.
import puppeteer from "puppeteer-core";
import sharp from "sharp";

const url = process.argv[2] ?? "http://localhost:5201/";
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 860, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] (sparse|built)/.test(t)) console.log(`  ${t.slice(0, 220)}`);
  // WebGPU validation errors surface as console errors and are the FIRST
  // thing to suspect when a storage texture silently produces nothing.
  // Page-resource 404s (favicon and friends) are not that.
  if (m.type() === "error" && !/Failed to load resource/.test(t)) errors.push(t.slice(0, 400));
});
page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 400)));

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

const capture = async (sparse, tag) => {
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
  });
  await settle(5000);

  await page.evaluate(async (useSparse) => {
    const { THREE } = await import("/src/engine/index.js");
    await import("/src/modules/index.js");
    const { enableEngineModule } = await import("/src/engine/modules.js");
    const { ensureEngine } = await import("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    await enableEngineModule(engine, "gi");
    globalThis.__engine = engine;
    globalThis.__giSparseField = useSparse;

    const mat = (c) => new THREE.MeshStandardNodeMaterial({ color: c, roughness: 0.85, metalness: 0 });
    const add = (geo, x, y, z) => {
      const m = new THREE.Mesh(geo, mat(0xb0b0b8));
      m.position.set(x, y, z);
      engine.scene.add(m);
      return m;
    };
    // Floor + a colonnade of SLENDER columns. Column diameter 0.4m sits below
    // the coarse field's ~0.33m cell x2 — precisely the regime that melts into
    // blobs today, and precisely what the fine level should resolve.
    add(new THREE.BoxGeometry(24, 0.4, 12), 0, -0.2, 0);
    for (let i = 0; i < 7; i++) {
      for (const sx of [-1, 1]) {
        const col = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 5, 16), mat(0xc0bcb0));
        col.position.set(sx * 3.2, 2.5, -6 + i * 2);
        // Non-primitive so it bakes a grid rather than taking the analytic path.
        col.geometry = col.geometry.toNonIndexed();
        col.geometry.parameters = undefined;
        col.geometry.type = "BufferGeometry";
        engine.scene.add(col);
      }
    }
    const lamp = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 0.1, 1.2),
      new THREE.MeshStandardNodeMaterial({
        color: 0x000000,
        emissive: new THREE.Color(1, 0.9, 0.7),
        emissiveIntensity: 30,
      }),
    );
    lamp.position.set(0, 5.4, 0);
    engine.scene.add(lamp);

    const gi = engine.createEntity({ name: "GI" });
    // THE instrument: raymarch of the field itself. It is a debug VIEW, not a
    // lighting property, so it lives on a global now (giConfig's giDebugView).
    globalThis.__giDebugView = "sdf";
    gi.addComponent("global-illumination", { quality: "high" });
  }, sparse);

  // Wait for the build AND the async SDF bakes to land.
  for (let i = 0; i < 120; i++) {
    await settle(1000);
    const ready = await page.evaluate(() => {
      const s = globalThis.__engine?.modules?.get("gi")?.system;
      const a = s?.state?.atlas;
      return !!a && s.state.entries.length > 0 && a.assignments.filter(Boolean).length >= s.state.entries.length;
    });
    if (ready) break;
  }
  await settle(5000);
  for (let i = 0; i < 30; i++) {
    if (await page.evaluate(() => !!globalThis.__engine?.camera)) break;
    await settle(500);
  }

  const info = await page.evaluate(() => {
    const engine = globalThis.__engine;
    const viewport = globalThis.__viewport;
    engine.camera.position.set(0, 2.2, 9);
    if (viewport?.orbit) {
      viewport.orbit.target.set(0, 2.0, -2);
      viewport.orbit.update();
    }
    engine.camera.lookAt(0, 2.0, -2);
    engine.camera.updateMatrixWorld(true);
    engine.camera.layers.disable(31);
    engine.scene.traverse((o) => {
      if (o.isGridHelper || o.type === "GridHelper") o.visible = false;
    });
    const s = engine.modules?.get("gi")?.system;
    const v = s?.state?.volume;
    return {
      hasSparse: !!v?.sparse,
      brickAxis: v?.sparse?.brickAxis ?? 0,
      coarseCell: v ? +Math.max(v.cell.x, v.cell.y, v.cell.z).toFixed(3) : 0,
      sdfViewVisible: s?.state?.gizmos?.sdfView?.visible ?? null,
    };
  });
  await settle(2500);

  // The viewport canvas mounts through dockview and is intermittently late
  // (documented flake) — poll for it instead of sampling once and dying.
  let box = null;
  for (let i = 0; i < 40 && !box; i++) {
    box = await page.evaluate(() => {
      const c = [...document.querySelectorAll("canvas")]
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter((c) => c.r.width > 200 && c.r.height > 200)
        .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
      return c ? { x: c.r.x, y: c.r.y, width: c.r.width, height: c.r.height } : null;
    });
    if (!box) await settle(500);
  }
  if (!box) throw new Error("no canvas");
  const png = await page.screenshot({ clip: box });
  await sharp(png).toFile(`scripts/gi-diag-sparse-${tag}.png`);
  const raw = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  return { info, raw };
};

console.log("=== ARM A: sparse OFF ===");
const a = await capture(false, "off");
console.log(JSON.stringify(a.info));
console.log("=== ARM B: sparse ON ===");
const b = await capture(true, "on");
console.log(JSON.stringify(b.info));

// Pixel diff over the whole frame.
const A = a.raw.data;
const B = b.raw.data;
const ch = a.raw.info.channels;
const px = Math.min(A.length, B.length) / ch;
let changed = 0;
let sum = 0;
for (let i = 0; i < px; i++) {
  const d =
    Math.abs(A[i * ch] - B[i * ch]) +
    Math.abs(A[i * ch + 1] - B[i * ch + 1]) +
    Math.abs(A[i * ch + 2] - B[i * ch + 2]);
  if (d > 12) changed++;
  sum += d;
}
const pctChanged = (changed / px) * 100;
console.log(`\npixels ${px}, changed ${changed} (${pctChanged.toFixed(2)}%), mean |Δ| ${(sum / px).toFixed(2)}`);

// THE ACTUAL QUANTITY. The columns are 0.4m across; at 0.22m coarse cells the
// field renders them as ~0.9m blobs that merge with their neighbours. Count
// the isosurface pixels in the band ABOVE the floor line — if the fine level
// is resolving the real silhouette, that count goes DOWN (the blobs shrink
// onto the geometry), and it is a far more meaningful signal than "the image
// changed", which a broken shader also produces.
const info = a.raw.info;
const columnPixels = (buf) => {
  let n = 0;
  const y0 = Math.round(info.height * 0.18);
  const y1 = Math.round(info.height * 0.45);
  // Right half only: the stats overlay occupies the top-right, so stop short
  // of it and skip the left edge where a column is clipped by the frame.
  const x0 = Math.round(info.width * 0.1);
  const x1 = Math.round(info.width * 0.72);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * info.width + x) * ch;
      // Background is near-black navy; the isosurface is bright pastel.
      if (buf[i] + buf[i + 1] + buf[i + 2] > 200) n++;
    }
  }
  return n;
};
const colA = columnPixels(A);
const colB = columnPixels(B);
console.log(`column-band isosurface pixels: off ${colA} → on ${colB} (${(((colB - colA) / colA) * 100).toFixed(1)}%)`);
if (errors.length) {
  console.log(`\nCONSOLE ERRORS (${errors.length}):`);
  for (const e of [...new Set(errors)].slice(0, 8)) console.log(`  ${e}`);
}

const checks = [
  ["arm A had no sparse field", a.info.hasSparse === false],
  ["arm B had one", b.info.hasSparse === true],
  ["the SDF debug view was actually on", b.info.sdfViewVisible === true],
  // The whole point. Anything under a percent means the fine level is not
  // reaching the raymarch, whatever the brick counter claims.
  [`the fine field changes the rendered field (${pctChanged.toFixed(2)}% > 1%)`, pctChanged > 1],
  // Down, but not to nothing: a shredded or empty field also shrinks the
  // count, so the lower bound is what separates "resolved the silhouette"
  // from "lost the geometry" — the exact failure this harness caught once.
  [`blobs shrank onto the geometry (off ${colA} → on ${colB})`, colB < colA * 0.85 && colB > colA * 0.25],
  ["no GPU/console errors", errors.length === 0],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
  if (!ok) failed++;
}
console.log(failed === 0 ? "GI-SV ALL PASS" : `GI-SV ${failed} FAILED`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
