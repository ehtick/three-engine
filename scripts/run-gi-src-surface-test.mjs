// SRC SURFACE-ATTRIBUTION GATE — drives scripts/gi-src-surface.html.
//
// Plan §12.29's gate: `createSrcSurfaceAttribution`, the GPU path from a static
// ray hit to its material. Unlike its siblings this one builds a REAL
// occupancy field and fires real rays — attribution is written by the voxelizer
// and read through the marcher, so a synthetic trace would check a buffer
// against itself.
//
// The two arms that cost the most are the ones §12.9 paid for: `crossed`
// (which passes by FAILING — it re-introduces the crossed-numbering bug on
// purpose so the arm above it is proven able to see it) and `stable`, whose
// vacuity guard measures the contested voxel set by swapping the slot numbers
// rather than assuming the overlap produced one.
//
// Race-sensitive: the attribution stamp is an atomic written by a
// scheduler-ordered voxelizer. Run it more than once before believing a green.
//
// Run: node scripts/run-gi-src-surface-test.mjs [baseUrl]
import puppeteer from "puppeteer-core";

const base = (process.argv[2] ?? "http://localhost:5201/").replace(/\/$/, "");
const url = `${base}/scripts/gi-src-surface.html`;

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
const logs = [];
page.on("console", (m) => logs.push(m.text()));
page.on("pageerror", (e) => logs.push(`PAGEERROR ${e.stack ?? e.message}`));

let code = 1;
try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction("globalThis.__SRC_SURFACE_RESULT__ !== undefined", { timeout: 240000 });
  const result = await page.evaluate("globalThis.__SRC_SURFACE_RESULT__");
  if (result?.text) console.log(result.text);
  if (result?.pass) {
    console.log(`gi-src-surface: PASS — ${result.clearHits} clear-of-seam hits all read their own ` +
      `mesh's albedo (${result.seamHits} seam hits measured, ${result.retries} face retries)\n` +
      `                 crossing the numbering broke ${result.crossedWrong} of them, ` +
      `${result.swapped} reading the other mesh's colour\n` +
      `                 ${result.stamped} of ${result.records} records stamped; attribution ` +
      `${result.attrMB}MB of ${result.fieldMB}MB, Sponza-ultra projection ${result.sponzaMB}MB`);
    code = 0;
  } else {
    console.error(`gi-src-surface: FAIL — ${result?.error ?? `${result?.failures} checks`}`);
    if (!result?.text) console.error(logs.slice(-25).join("\n"));
  }
} catch (err) {
  console.error(`gi-src-surface: FAIL — ${err.message}`);
  console.error(logs.slice(-30).join("\n"));
} finally {
  await browser.close();
}
process.exit(code);
