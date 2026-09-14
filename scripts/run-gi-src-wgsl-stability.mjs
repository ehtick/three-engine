// SRC WGSL STABILITY GATE — drives scripts/gi-src-wgsl-stability.html.
//
// Builds the whole SRC kernel chain twice in one page under two different
// capacity vectors and diffs the shader-module text the driver was handed.
// Zero differing modules is the receipt that no pool capacity is baked into
// kernel text any more — the precondition for Dawn's disk cache serving a
// boot after a pool grow. See the page header for the full argument and
// wgslStable.js for the cache mechanics.
//
// Run: node scripts/run-gi-src-wgsl-stability.mjs [baseUrl]
import puppeteer from "puppeteer-core";

const base = (process.argv[2] ?? "http://localhost:5201/").replace(/\/$/, "");
const url = `${base}/scripts/gi-src-wgsl-stability.html`;

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
  await page.waitForFunction("globalThis.__SRC_WGSL_STABILITY_RESULT__ !== undefined", { timeout: 240000 });
  const result = await page.evaluate("globalThis.__SRC_WGSL_STABILITY_RESULT__");
  if (result?.text) console.log(result.text);
  if (result?.pass) {
    console.log(`gi-src-wgsl-stability: PASS — ${result.identical}/${result.modules} modules byte-identical across the two pool vectors`);
    code = 0;
  } else {
    console.error(`gi-src-wgsl-stability: FAIL — ${result?.differing ?? "?"} of ${result?.modules ?? "?"} modules differ across pool vectors`);
    if (!result?.text) console.error(logs.slice(-25).join("\n"));
  }
} catch (err) {
  console.error(`gi-src-wgsl-stability: FAIL — ${err.message}`);
  console.error(logs.slice(-30).join("\n"));
} finally {
  await browser.close();
}
process.exit(code);
