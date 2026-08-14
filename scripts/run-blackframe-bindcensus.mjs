// ONE-OFF (2026-08-14, §12.66): the sun's shadow SAMPLE is hard-zero while
// the 4096² map CONTENT is verified good and only ONE such depth texture is
// ever created. Standing hypothesis: the frame's fragment bind groups hold a
// view of a PLACEHOLDER depth texture instead of the real ShadowDepthTexture.
// This boot wraps, at document start:
//   - GPUDevice.createTexture   → serial + label + size on every texture
//   - GPUTexture.createView     → views inherit their texture's serial
//   - GPUDevice.createBindGroup → census every bind group whose entries
//     include a depth-format texture view (which serial, which binding)
//   - GPUTexture.destroy        → depth-texture destroys, with stacks
//   - GPURenderPassEncoder.setBindGroup + GPUQueue.submit → after settle,
//     record ONE frame's worth of actually-bound groups, so we know which
//     depth texture the settled frame's shadow sampler really reads.
// Delete with the fix.
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
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
page.on("console", (m) => { if (/\[gi\] built/.test(m.text())) built = true; });
await page.evaluateOnNewDocument((project) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
  const C = globalThis.__bindCensus = {
    texSerial: 0, bgSerial: 0, depthTextures: [], depthDestroys: [],
    bindGroups: [], recording: false, used: [],
  };
  const patch = () => {
    if (!globalThis.GPUDevice?.prototype?.createTexture || GPUDevice.prototype.__bcPatched) return;
    GPUDevice.prototype.__bcPatched = true;

    const origCreateTexture = GPUDevice.prototype.createTexture;
    GPUDevice.prototype.createTexture = function (desc) {
      const tex = origCreateTexture.call(this, desc);
      try {
        const serial = ++C.texSerial;
        const size = Array.isArray(desc?.size) ? desc.size.slice(0, 2) : [desc?.size?.width, desc?.size?.height];
        tex.__bcSerial = serial;
        tex.__bcInfo = { serial, label: String(desc?.label ?? ""), format: desc?.format, size };
        if (typeof desc?.format === "string" && desc.format.startsWith("depth")) {
          C.depthTextures.push({
            t: performance.now(), serial, label: String(desc?.label ?? ""),
            format: desc.format, size, usage: desc.usage,
            stack: new Error().stack?.split("\n").slice(2, 8).join(" | "),
          });
        }
      } catch {}
      return tex;
    };

    const origCreateView = GPUTexture.prototype.createView;
    GPUTexture.prototype.createView = function (desc) {
      const view = origCreateView.call(this, desc);
      try { view.__bcTexInfo = this.__bcInfo ?? null; } catch {}
      return view;
    };

    const origDestroy = GPUTexture.prototype.destroy;
    GPUTexture.prototype.destroy = function () {
      try {
        if (this.__bcInfo && String(this.__bcInfo.format ?? "").startsWith("depth")) {
          C.depthDestroys.push({
            t: performance.now(), serial: this.__bcInfo.serial, label: this.__bcInfo.label,
            size: this.__bcInfo.size,
            stack: new Error().stack?.split("\n").slice(2, 8).join(" | "),
          });
        }
      } catch {}
      return origDestroy.call(this);
    };

    const origCreateBindGroup = GPUDevice.prototype.createBindGroup;
    GPUDevice.prototype.createBindGroup = function (desc) {
      const bg = origCreateBindGroup.call(this, desc);
      try {
        const serial = ++C.bgSerial;
        bg.__bcSerial = serial;
        bg.__bcLabel = String(desc?.label ?? "");
        const depthEntries = [];
        for (const e of desc?.entries ?? []) {
          const info = e?.resource?.__bcTexInfo;
          if (info && String(info.format ?? "").startsWith("depth")) {
            depthEntries.push({ binding: e.binding, texSerial: info.serial, format: info.format, size: info.size, texLabel: info.label });
          }
        }
        bg.__bcDepth = depthEntries;
        if (depthEntries.length) {
          C.bindGroups.push({
            t: performance.now(), serial, label: bg.__bcLabel, entries: depthEntries,
            stack: new Error().stack?.split("\n").slice(2, 8).join(" | "),
          });
        }
      } catch {}
      return bg;
    };

    const origSetBindGroup = GPURenderPassEncoder.prototype.setBindGroup;
    GPURenderPassEncoder.prototype.setBindGroup = function (index, bg, ...rest) {
      try {
        if (C.recording && bg?.__bcDepth?.length) {
          C.used.push({ index, bgSerial: bg.__bcSerial, label: bg.__bcLabel, entries: bg.__bcDepth });
        }
      } catch {}
      return origSetBindGroup.call(this, index, bg, ...rest);
    };
  };
  patch();
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
await wait(20000);

// Confirm this boot is actually black before trusting the census.
const frame = await page.evaluate(async () => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  return await new Promise((resolve) => {
    let n = 0;
    const off = engine.onPostRender(() => {
      if (++n < 2) return;
      off();
      const src = engine.renderer.domElement;
      const c = document.createElement("canvas");
      c.width = src.width; c.height = src.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(src, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let black = 0, lumSum = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] <= 2 && d[i + 1] <= 2 && d[i + 2] <= 2) black++;
        lumSum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      }
      resolve({ blackFrac: +(black / (d.length / 4)).toFixed(4), meanLum: +(lumSum / (d.length / 4) / 255).toFixed(4) });
    });
  });
});
console.log(`frame ${JSON.stringify(frame)} ${frame.blackFrac > 0.9 ? "(BLACK — census is of the broken state)" : "(LIT?! — census not of a black boot)"}`);

// Record one settled frame's worth of actually-bound depth-referencing groups.
await page.evaluate(() => { globalThis.__bindCensus.used.length = 0; globalThis.__bindCensus.recording = true; });
await wait(400);
await page.evaluate(() => { globalThis.__bindCensus.recording = false; });

const report = await page.evaluate(() => {
  const C = globalThis.__bindCensus;
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  let light = null;
  engine.scene.traverse((o) => { if (o.isDirectionalLight && !light) light = o; });
  const depthTex = light?.shadow?.map?.depthTexture ?? light?.shadow?.map?.texture;
  // Which GPU texture serial does the backend hold for the shadow depth texture NOW?
  let realSerial = null;
  try {
    const backendData = engine.renderer.backend.get(depthTex);
    realSerial = backendData?.texture?.__bcSerial ?? null;
  } catch {}
  // Aggregate created bind groups per referenced depth-tex serial.
  const bySerialCreated = {};
  for (const bgc of C.bindGroups) {
    for (const e of bgc.entries) {
      const k = `${e.texSerial}(${e.size?.[0]}x${e.size?.[1]} ${e.format}${e.texLabel ? ` "${e.texLabel}"` : ""})`;
      (bySerialCreated[k] ??= { count: 0, firstT: bgc.t, lastT: bgc.t }).count++;
      bySerialCreated[k].lastT = bgc.t;
    }
  }
  // Aggregate the settled frame's USED bind groups per serial.
  const bySerialUsed = {};
  const usedUnique = new Map();
  for (const u of C.used) {
    if (!usedUnique.has(u.bgSerial)) usedUnique.set(u.bgSerial, u);
    for (const e of u.entries) {
      const k = `${e.texSerial}(${e.size?.[0]}x${e.size?.[1]} ${e.format}${e.texLabel ? ` "${e.texLabel}"` : ""})`;
      (bySerialUsed[k] ??= 0), bySerialUsed[k]++;
    }
  }
  // The LAST 12 created depth-referencing bind groups, with stacks.
  const lastCreated = C.bindGroups.slice(-12).map((b) => ({
    t: +(b.t / 1000).toFixed(1), serial: b.serial, label: b.label.slice(0, 90),
    entries: b.entries, stack: b.stack,
  }));
  const usedSample = [...usedUnique.values()].slice(0, 30).map((u) => ({
    bgSerial: u.bgSerial, index: u.index, label: u.label.slice(0, 90), entries: u.entries,
  }));
  return {
    realShadowDepth: { serial: realSerial, jsType: depthTex?.constructor?.name ?? null },
    depthTextures: C.depthTextures.map((d) => ({ t: +(d.t / 1000).toFixed(1), serial: d.serial, size: d.size, format: d.format, label: d.label, stack: d.stack })),
    depthDestroys: C.depthDestroys.map((d) => ({ t: +(d.t / 1000).toFixed(1), serial: d.serial, size: d.size, label: d.label, stack: d.stack })),
    createdBindGroupsBySerial: bySerialCreated,
    settledFrameUsedBySerial: bySerialUsed,
    settledFrameUsedUniqueBGs: usedUnique.size,
    lastCreated,
    usedSample,
  };
});

console.log(`\n=== real ShadowDepthTexture (backend view NOW): ${JSON.stringify(report.realShadowDepth)}`);
console.log(`\n=== depth textures created (${report.depthTextures.length}):`);
for (const d of report.depthTextures) console.log(`  t=${d.t}s serial=${d.serial} ${d.size?.[0]}x${d.size?.[1]} ${d.format} label="${d.label}"\n    ${d.stack}`);
console.log(`\n=== depth textures DESTROYED (${report.depthDestroys.length}):`);
for (const d of report.depthDestroys) console.log(`  t=${d.t}s serial=${d.serial} ${d.size?.[0]}x${d.size?.[1]} label="${d.label}"\n    ${d.stack}`);
console.log(`\n=== bind groups CREATED referencing depth textures, by texture serial:`);
for (const [k, v] of Object.entries(report.createdBindGroupsBySerial)) console.log(`  tex ${k}: ${v.count} bind groups, t=${(v.firstT / 1000).toFixed(1)}s..${(v.lastT / 1000).toFixed(1)}s`);
console.log(`\n=== SETTLED FRAME actually-bound depth references (unique BGs: ${report.settledFrameUsedUniqueBGs}):`);
for (const [k, v] of Object.entries(report.settledFrameUsedBySerial)) console.log(`  tex ${k}: bound ${v}×`);
console.log(`\n=== last 12 depth-referencing bind groups created:`);
for (const b of report.lastCreated) console.log(`  t=${b.t}s bg#${b.serial} "${b.label}" entries=${JSON.stringify(b.entries)}\n    ${b.stack}`);
console.log(`\n=== settled-frame used sample (${report.usedSample.length}):`);
for (const u of report.usedSample) console.log(`  bg#${u.bgSerial}@${u.index} "${u.label}" ${JSON.stringify(u.entries)}`);
await browser.close();
