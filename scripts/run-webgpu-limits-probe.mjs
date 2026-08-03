// Prints the WebGPU adapter + default-device limits that harness Chrome sees.
import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.goto("http://localhost:5201/", { waitUntil: "domcontentloaded" });
const r = await page.evaluate(async () => {
  if (!navigator.gpu) return { err: "no navigator.gpu" };
  const out = {};
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return { err: "no adapter" };
  out.adapter = { vendor: adapter.info?.vendor, storage: adapter.limits.maxStorageBuffersPerShaderStage };
  const d1 = await adapter.requestDevice();
  out.plain = d1.limits.maxStorageBuffersPerShaderStage;
  // Fresh adapter per request — an adapter is consumed by requestDevice.
  const a2 = await navigator.gpu.requestAdapter();
  try {
    const d2 = await a2.requestDevice({ requiredLimits: { maxStorageBuffersPerShaderStage: 16 } });
    out.withLimits = d2.limits.maxStorageBuffersPerShaderStage;
  } catch (e) { out.withLimits = `THREW: ${e.message}`; }
  // three's exact recipe: every adapter-supported feature + the limits.
  const a3 = await navigator.gpu.requestAdapter();
  const feats = [];
  for (const f of a3.features) feats.push(f);
  try {
    const d3 = await a3.requestDevice({ requiredFeatures: feats, requiredLimits: { maxStorageBuffersPerShaderStage: 16 } });
    out.threeRecipe = d3.limits.maxStorageBuffersPerShaderStage;
  } catch (e) { out.threeRecipe = `THREW: ${e.message}`; }
  // three r185's ACTUAL adapter request: featureLevel 'compatibility'.
  const a4 = await navigator.gpu.requestAdapter({ featureLevel: "compatibility" });
  out.compatAdapter = a4
    ? { storage: a4.limits.maxStorageBuffersPerShaderStage, core: a4.features.has("core-features-and-limits") }
    : null;
  if (a4) {
    try {
      const d4 = await a4.requestDevice({ requiredLimits: { maxStorageBuffersPerShaderStage: 16 } });
      out.compatWithLimits = d4.limits.maxStorageBuffersPerShaderStage;
    } catch (e) { out.compatWithLimits = `THREW: ${e.message}`; }
    const a5 = await navigator.gpu.requestAdapter({ featureLevel: "compatibility" });
    const d5 = await a5.requestDevice();
    out.compatPlain = d5.limits.maxStorageBuffersPerShaderStage;
  }
  return out;
});
console.log(JSON.stringify(r, null, 1));
await browser.close();
