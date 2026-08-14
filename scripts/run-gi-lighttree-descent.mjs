// LIGHT-TREE DESCENT GATE — drives scripts/gi-lighttree-descent.html.
//
// §12.62 Unit W2: `lightTreeGpu.js`'s `createLightTreeSampler` (the WGSL/TSL
// descent twin) diffed against `lightTree.js`'s `sampleLightTree` over the
// same packed words, shading points and counter-based RNG seeds. Indices must
// match EXACTLY case by case; pdfs within 1e-4 relative (f32 drift); plus a
// lightTreeSelectPdf self-consistency arm and a perturbation canary.
//
// Run: node scripts/run-gi-lighttree-descent.mjs [baseUrl]
import puppeteer from "puppeteer-core";

const base = (process.argv[2] ?? "http://localhost:5201/").replace(/\/$/, "");
const url = `${base}/scripts/gi-lighttree-descent.html`;

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
  await page.waitForFunction("globalThis.__LT_DESCENT_RESULT__ !== undefined", { timeout: 240000 });
  const result = await page.evaluate("globalThis.__LT_DESCENT_RESULT__");
  if (result?.text) console.log(result.text);
  if (result?.pass) {
    console.log(`gi-lighttree-descent: PASS — ${result.checks} checks over ${result.cases} cases ` +
      `and ${result.fixtures} fixtures, max pdf rel ${result.maxPdfRel?.toExponential?.(2)}`);
    code = 0;
  } else {
    console.error(`gi-lighttree-descent: FAIL — ${result?.error ?? `${result?.failures} of ${result?.checks} checks`}`);
    if (!result?.text) console.error(logs.slice(-25).join("\n"));
  }
} catch (err) {
  console.error(`gi-lighttree-descent: FAIL — ${err.message}`);
  console.error(logs.slice(-30).join("\n"));
} finally {
  await browser.close();
}
process.exit(code);
