// ONE-OFF (2026-08-14): "AO is great, but the flicker still persists" — on the
// REAL Sponza project, whose sun is script-rotated in play (LightScript.ts,
// ±70° ping-pong, ~63s period) and whose console shows §12.43 windows arming
// off the shadow term. The rig-verified at-rest fixes may simply not cover the
// state the user actually looks at. Three arms, ONE in-page instrument (the
// flicker harness's accumulator pattern over the GI resolve texture — a raw
// THREE Texture wrap, which trap 0 permits):
//   A. edit mode, parked camera        — is the at-rest floor actually there?
//   B. edit mode, pan→hold cycles      — does the seed fix hold on Sponza?
//   C. PLAY mode, sun sweeping, parked — the "when light moves" gap, priced.
// Headline per arm: reversals/px/s over significant-change pixels (oscillation
// = flicker; monotonic drift under a moving sun is CORRECT behaviour and must
// not count), plus churn %/frame and the cap/window/motion-term maxima that
// name the driver. In-page numbers comparable across arms of THIS run only.
// Delete with the flicker investigation.
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
const OUT = ".gi-shots/sponza-flicker";
await mkdir(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
await installTauriShim(page, {});
let built = false;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built/.test(t)) built = true;
  if (/\[gi\] (light-track|static shadow bvh: rebuild)/.test(t)) console.log(`  ${t.slice(0, 220)}`);
  if (m.type() === "error" && !/favicon|404|structures must have at least one member|selectionOutlineMask|previous error|Invalid ShaderModule/.test(t)) {
    console.log(`  console.error: ${t.slice(0, 400)}`);
  }
});
page.on("pageerror", (e) => console.log(`  pageerror: ${String(e.message ?? e).slice(0, 260)}`));
await page.evaluateOnNewDocument((project) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
}, PROJECT);

console.log(`opening ${PROJECT} …`);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
for (let i = 0; i < 240 && !built; i++) await wait(1000);
if (!built) { console.log("FATAL: never built"); await browser.close(); process.exit(1); }
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
const call = (op, args) => page.evaluate(
  async (o, a) => { try { return { ok: true, value: await globalThis.__editorApi.call(o, a) }; } catch (e) { return { ok: false, error: String(e) }; } },
  op, args,
);
await call("viewport.setCamera", { position: [6.2, 2.09, -0.37], target: [-6, 2, 0] });
console.log("settling out the compile wave…");
await wait(30000);

// One measurement pass, built fresh each arm (play mode swaps GI targets —
// the dead-target-reference instrument failure the flicker harness documents).
// frames counted AFTER a 30-frame prevLum warmup; `pan` runs setCamera cycles.
const measure = (label, opts) => page.evaluate(async (lbl, o) => {
  const api = globalThis.__editorApi;
  const engine = api.entities.live("KT0sShKBX-")?.engine ?? api.entities.live("Gql8TsY-b9")?.engine;
  const system = engine?.modules?.get("gi")?.system;
  const renderer = engine?.renderer;
  const targets = system?._giTargets;
  const size = system?._giTargetSize;
  if (!targets?.irradiance || !size) return { error: `no GI resolve targets (${lbl})` };
  const { width, height } = size;
  const TSL = await import("/node_modules/three/build/three.tsl.js");
  const { Fn, If, float, instanceIndex, instancedArray, ivec2, select, texture, uniform, vec2, vec3, vec4 } = TSL;
  // x prevLum, y prev significant delta, z reversal count, w changed-frames.
  const stateBuf = instancedArray(new Float32Array(width * height * 4), "vec4");
  const ampBuf = instancedArray(new Float32Array(width * height * 2), "vec2");
  const irrNode = texture(targets.irradiance);
  const widthU = uniform(width, "uint");
  const armed = uniform(0);
  const accumulator = Fn(() => {
    const px = instanceIndex.mod(widthU);
    const py = instanceIndex.div(widthU);
    const texel = irrNode.load(ivec2(px.toInt(), py.toInt()));
    const lum = texel.xyz.dot(vec3(0.2126, 0.7152, 0.0722)).toVar();
    const prev = stateBuf.element(instanceIndex).toVar();
    const delta = lum.sub(prev.x).toVar();
    const threshold = float(0.002).max(prev.x.mul(0.01)).toVar();
    const moved = delta.abs().greaterThan(threshold).toVar();
    const outDelta = float(prev.y).toVar();
    const outRev = float(prev.z).toVar();
    const outChanged = float(prev.w).toVar();
    If(moved.and(armed.greaterThan(0.5)), () => {
      const flipped = delta.mul(prev.y).lessThan(0);
      outRev.assign(prev.z.add(select(flipped, float(1), float(0))));
      outDelta.assign(delta);
      outChanged.assign(prev.w.add(1));
      const amp = ampBuf.element(instanceIndex).toVar();
      ampBuf.element(instanceIndex).assign(vec2(amp.x.max(delta.abs()), amp.y.add(delta.abs())));
    });
    stateBuf.element(instanceIndex).assign(vec4(lum, outDelta, outRev, outChanged));
  })().compute(width * height);

  const frame = () => new Promise((r) => requestAnimationFrame(r));
  // Motion/cap sampling names the driver per arm.
  const mot = { cap: 0, capN: 0, tr: 0, sh: 0, em: 0, lum: 0, rest: 1 };
  const sample = () => {
    mot.capN++;
    if ((globalThis.__giSrcTransport?.probeRayCap ?? 0) > 100000) mot.cap++;
    mot.tr = Math.max(mot.tr, system._giTrackMotion ?? 0);
    mot.sh = Math.max(mot.sh, system._giShadowLastMotion ?? 0);
    mot.em = Math.max(mot.em, system._giEmitterLastMotion ?? 0);
    mot.lum = Math.max(mot.lum, system._giLightLumMotion ?? 0);
    mot.rest = Math.min(mot.rest, globalThis.__giSrcRestFactorLive ?? 1);
  };
  let setCam = null;
  if (o.pan) {
    const cam = await api.call("viewport.getCamera", {});
    const [tx, ty, tz] = cam.target;
    const dx = cam.position[0] - tx, dz = cam.position[2] - tz;
    setCam = (theta) => {
      const c = Math.cos(theta), s = Math.sin(theta);
      return api.call("viewport.setCamera", {
        position: [tx + dx * c - dz * s, cam.position[1], tz + dx * s + dz * c],
        target: [tx, ty, tz],
      });
    };
  }
  for (let i = 0; i < 30; i++) { await frame(); renderer.compute(accumulator); }
  const t0 = performance.now();
  if (o.pan) {
    const seg = Math.floor(o.frames / 4); // 2 cycles × (pan + hold)
    for (let cyc = 0; cyc < 2; cyc++) {
      armed.value = 0;
      for (let i = 0; i < seg; i++) {
        await frame();
        await setCam(((cyc % 2 === 0 ? i + 1 : seg - 1 - i) / seg) * 0.35);
        renderer.compute(accumulator); sample();
      }
      armed.value = 1;
      for (let i = 0; i < seg; i++) { await frame(); renderer.compute(accumulator); sample(); }
    }
    await setCam(0);
  } else {
    armed.value = 1;
    for (let i = 0; i < o.frames; i++) { await frame(); renderer.compute(accumulator); sample(); }
  }
  const seconds = (performance.now() - t0) / 1000;
  const state = new Float32Array(await renderer.getArrayBufferAsync(stateBuf.value));
  const amp = new Float32Array(await renderer.getArrayBufferAsync(ampBuf.value));
  let px = 0, lit = 0, revSum = 0, changedSum = 0, changedPx = 0, ampMaxSum = 0, ampTotSum = 0, hot = 0;
  for (let i = 0; i < width * height; i++) {
    px++;
    const lum = state[i * 4];
    const rev = state[i * 4 + 2];
    const changed = state[i * 4 + 3];
    if (lum > 0.002) lit++;
    if (changed > 0) {
      changedPx++; changedSum += changed; revSum += rev;
      ampMaxSum += amp[i * 2]; ampTotSum += amp[i * 2 + 1];
      if (rev / seconds > 5) hot++;
    }
  }
  const counted = o.pan ? seconds / 2 : seconds; // pan arm counts holds only
  return {
    label: lbl, width, height, seconds: +seconds.toFixed(1),
    litFrac: +(lit / px).toFixed(3),
    changedPxPct: +((changedPx / Math.max(1, lit)) * 100).toFixed(1),
    // flicker headline: reversals per changed pixel per counted second
    revPerPxS: +(revSum / Math.max(1, changedPx) / Math.max(0.1, counted)).toFixed(3),
    revPerLitPxS: +(revSum / Math.max(1, lit) / Math.max(0.1, counted)).toFixed(3),
    churnPct: +((changedSum / Math.max(1, lit) / Math.max(0.1, counted * 60)) * 100).toFixed(2),
    hotPxPct: +((hot / Math.max(1, lit)) * 100).toFixed(2),
    meanStepAmp: +(ampTotSum / Math.max(1, changedSum)).toFixed(4),
    capLiftPct: +((mot.cap / Math.max(1, mot.capN)) * 100).toFixed(0),
    restFactorMin: +mot.rest.toFixed(2),
    motion: { tr: +mot.tr.toFixed(3), sh: +mot.sh.toFixed(4), em: +mot.em.toFixed(3), lum: +mot.lum.toFixed(4) },
  };
}, label, opts);

const shoot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });

// ── ARM A: edit, parked.
console.log("\nARM A: edit mode, parked, 300 frames…");
console.log(JSON.stringify(await measure("A edit parked", { frames: 300 })));
await shoot("a-edit-parked");

// ── ARM B: edit, pan→hold ×2.
console.log("\nARM B: edit mode, pan-hold cycles, 480 frames…");
console.log(JSON.stringify(await measure("B edit pan-hold", { frames: 480, pan: true })));
await shoot("b-edit-panhold");

// ── ARM C: play, sun sweeping, parked game camera.
console.log("\nARM C: entering play…");
const p = await call("play.set", { playing: true });
if (!p.ok) console.log(`  play.set failed: ${p.error}`);
await wait(4000); // scripts start, GI reconciles; instrument built fresh below
console.log("ARM C: play mode, sun sweeping, 600 frames…");
console.log(JSON.stringify(await measure("C play sun", { frames: 600 })));
await shoot("c-play-sun");
await shoot("c-play-sun-2"); // a second look ~1s later for eyeballing
await call("play.set", { playing: false });

console.log(`\nshots → ${OUT}`);
await browser.close();
