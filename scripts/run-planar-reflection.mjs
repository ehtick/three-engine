// Planar reflection check (reflection plan tier 1 — see docs/GI_PLAN.md).
//
// A dark room with a flat floor and ONE bright red emissive box hovering to the
// LEFT of centre. A mirror shows a box at x = -1.2 as an image at x = -1.2 on
// the other side of the plane, so the floor directly under the box must go red
// while a control patch on the opposite side of the floor stays dark.
//
// Two things make this falsifiable rather than "looks shiny":
//   * the red is EMISSIVE, so its light is unmistakable in the sampled channel
//     and cannot be confused with a lit-surface colour;
//   * the control patch is the SAME material at the same distance and grazing
//     angle, so anything that brightens the floor uniformly (ambient, GI,
//     tonemapping) cancels between the two.
//
// Verdict: PASS when the reflection arm's (underBox.r - control.r) exceeds the
// no-component arm's same quantity by a clear margin.
//
// Env: PLANAR=0 runs only the control arm, PLANAR=1 only the reflection arm;
// unset runs both and prints the verdict. HEADED=1 to watch.
import puppeteer from "puppeteer-core";
import sharp from "sharp";

const url = process.argv[2] ?? "http://localhost:5201/";
const ONLY = process.env.PLANAR === "0" ? "off" : process.env.PLANAR === "1" ? "on" : null;
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

async function runArm(enabled) {
  const label = enabled ? "planar" : "control";
  const browser = await puppeteer.launch({
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: process.env.HEADED ? false : "new",
    args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
  page.on("console", (m) => {
    const t = m.text();
    if (/PR-|planar-reflection|error/i.test(t)) console.log(`[${label}] ${m.type()}: ${t.slice(0, 300)}`);
  });
  page.on("pageerror", (e) => console.log(`[${label}] pageerror: ${e.message}`));

  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
  });
  await settle(5000);

  const points = await page.evaluate(async ({ enabled }) => {
    const { THREE } = await import("/src/engine/index.js");
    const { ensureEngine } = await import("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    globalThis.__engine = engine;
    globalThis.__THREE = THREE;

    if (!engine.camera) {
      engine.camera = new THREE.PerspectiveCamera(60, 1200 / 800, 0.1, 1000);
    }

    // Floor: a RAW mesh parented under an empty entity, deliberately NOT a
    // MeshComponent. MeshComponent owns `mesh.material` and re-assigns it when
    // its (here empty) material asset resolves, which lands AFTER this function
    // returns and silently throws away both the test material and the
    // reflection node the component composited into it — the first version of
    // this harness measured exactly that and reported a working feature as
    // broken. Attaching the component to a plain child mesh keeps the material
    // ours for the whole run.
    const floor = engine.createEntity({ name: "Floor" });
    const floorMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(24, 24),
      // Dark and smooth: a mirror's own albedo must not drown the reflection.
      new THREE.MeshStandardNodeMaterial({ color: 0x0a0a0c, roughness: 0.05, metalness: 0 }),
    );
    floorMesh.name = "floorMesh";
    // The plane's LOCAL +Z is its surface normal, which is exactly the
    // component's default `normalAxis` — rotating it flat carries that with it.
    floorMesh.rotation.x = -Math.PI / 2;
    floor.object3D.add(floorMesh);

    const boxMaterial = new THREE.MeshStandardNodeMaterial({ color: 0xff0000, roughness: 1 });
    boxMaterial.emissive = new THREE.Color(0xff0000);
    boxMaterial.emissiveIntensity = 4;
    const box = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), boxMaterial);
    box.position.set(-1.2, 1.4, 0);
    box.name = "redBox";
    engine.scene.add(box);

    if (enabled) floor.addComponent("planar-reflection", { intensity: 1, resolution: 1, fresnel: false });

    // Grazing-ish view down the floor, box on the left of frame.
    engine.camera.position.set(0, 1.5, 6);
    engine.camera.lookAt(0, 0.3, 0);
    engine.camera.updateMatrixWorld(true);
    console.log("PR- scene ready");

    const project = (v, tag) => {
      const canvas = [...document.querySelectorAll("canvas")].sort((a, b) => b.width * b.height - a.width * a.height)[0];
      const rect = canvas.getBoundingClientRect();
      const p = v.clone().project(engine.camera);
      return { tag, px: Math.round(rect.x + ((p.x + 1) / 2) * rect.width), py: Math.round(rect.y + ((1 - p.y) / 2) * rect.height) };
    };
    // WHERE THE IMAGE ACTUALLY LANDS. Not the floor point under the box — a
    // mirror shows the box's IMAGE (same x/z, negated y), and the pixel that
    // shows it is where the camera→image ray crosses the plane. Sampling
    // under the box instead reads whatever lies up and behind the viewer,
    // which is empty sky; the first version of this harness did exactly that
    // and called a working reflection a failure.
    const cam = engine.camera.position;
    const floorHitOf = (bx, by, bz) => {
      const t = cam.y / (cam.y + by); // cam.y + s*(-by - cam.y) = 0
      return new THREE.Vector3(cam.x + (bx - cam.x) * t, 0.01, cam.z + (bz - cam.z) * t);
    };
    return {
      underBox: project(floorHitOf(-1.2, 1.4, 0), "underBox"),
      control: project(floorHitOf(1.2, 1.4, 0), "control"),
    };
  }, { enabled });

  await settle(6000);
  const box = await page.evaluate(() => {
    const c = [...document.querySelectorAll("canvas")]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
    return c ? { x: c.r.x, y: c.r.y, width: c.r.width, height: c.r.height } : null;
  });
  if (!box) throw new Error("no canvas (editor boot flake) — rerun");
  const png = await page.screenshot();
  await sharp(png).toFile(`scripts/planar-diag-${label}.png`);
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const at = (pt) => {
    // 5x5 median-ish average: one pixel on a reflective floor is noisy.
    let r = 0, g = 0, b = 0, n = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = Math.min(info.width - 1, Math.max(0, pt.px + dx));
        const y = Math.min(info.height - 1, Math.max(0, pt.py + dy));
        const i = (y * info.width + x) * info.channels;
        r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
      }
    }
    return [r / n, g / n, b / n];
  };
  const underBox = at(points.underBox);
  const control = at(points.control);
  await browser.close();
  const fmt = (c) => `rgb(${c.map((v) => v.toFixed(1)).join(", ")})`;
  console.log(`[${label}] underBox ${fmt(underBox)}  control ${fmt(control)}  redDelta ${(underBox[0] - control[0]).toFixed(1)}`);
  return underBox[0] - control[0];
}

if (ONLY) {
  await runArm(ONLY === "on");
  process.exit(0);
}
const off = await runArm(false);
const on = await runArm(true);
const gain = on - off;
console.log(`control redDelta ${off.toFixed(1)} → planar redDelta ${on.toFixed(1)} (gain ${gain.toFixed(1)}, need >= 12)`);
console.log(gain >= 12 ? "VERDICT: PASS" : "VERDICT: FAIL");
process.exit(gain >= 12 ? 0 : 1);
