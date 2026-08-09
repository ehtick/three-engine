// SRC RAY BUDGET GATE — drives scripts/gi-src-rays.html.
//
// Plan §12.13.5 unit 2's gate: `createSrcRayFrame` (Algorithm 3 on the GPU)
// diffed against `srcRef.js`'s `assignRays`, on a synthetic gbuffer with no
// engine and no scene — the same isolation `gi-src-populate` gets, and for the
// same reason.
//
// It compares the PARTITION, never the offsets. The GPU allocates with atomic
// cursors in scheduler order and the mirror walks its probes in table order, so
// the same probe legitimately gets a different offset in the two — and between
// two GPU runs. What Alg. 3 promises is that the segments tile, and that is
// what is checked (plan §12.13.3).
//
// Race-sensitive by construction: every offset in the frame comes out of an
// atomic. Run it more than once before believing a green.
//
// Run: node scripts/run-gi-src-rays-test.mjs [baseUrl]
import puppeteer from "puppeteer-core";

const base = (process.argv[2] ?? "http://localhost:5201/").replace(/\/$/, "");
const url = `${base}/scripts/gi-src-rays.html`;

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
  await page.waitForFunction("globalThis.__SRC_RAYS_RESULT__ !== undefined", { timeout: 240000 });
  const result = await page.evaluate("globalThis.__SRC_RAYS_RESULT__");
  if (result?.text) console.log(result.text);
  if (result?.pass) {
    console.log(`gi-src-rays: PASS — ${result.totalRays} rays over ` +
      `${result.probesPerCascade?.join(" -> ")} probes, ` +
      `${result.offsetsMoved} offsets moved on the rerun, ` +
      `storage limit ${result.storageLimit}`);
    code = 0;
  } else {
    console.error(`gi-src-rays: FAIL — ${result?.error ?? `${result?.failures} checks`}`);
    if (!result?.text) console.error(logs.slice(-25).join("\n"));
  }
} catch (err) {
  console.error(`gi-src-rays: FAIL — ${err.message}`);
  console.error(logs.slice(-30).join("\n"));
} finally {
  await browser.close();
}
process.exit(code);
