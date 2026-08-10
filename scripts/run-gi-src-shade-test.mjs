// SRC HIT-SHADING GATE — drives scripts/gi-src-shade.html.
//
// Plan §7 Phase 5 / §12.26's gate: `srcShade.js`'s `createSrcHitShader` diffed
// against `srcRef.js`'s `makeHitShader` on a synthetic fixture, plus the two
// shadow-ray budget arms §12.26.3 paid for.
//
// No occupancy field and no engine — `createSrcVisibility` is handed a fake
// medium, because both things this checks about a shadow ray are properties of
// its BUDGET rather than of the geometry it traverses.
//
// Run: node scripts/run-gi-src-shade-test.mjs [baseUrl]
import puppeteer from "puppeteer-core";

const base = (process.argv[2] ?? "http://localhost:5201/").replace(/\/$/, "");
const url = `${base}/scripts/gi-src-shade.html`;

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
  await page.waitForFunction("globalThis.__SRC_SHADE_RESULT__ !== undefined", { timeout: 240000 });
  const result = await page.evaluate("globalThis.__SRC_SHADE_RESULT__");
  if (result?.text) console.log(result.text);
  if (result?.pass) {
    console.log(`gi-src-shade: PASS — ${result.checks} checks over ${result.hits} hits ` +
      `and ${result.emitters} analytic emitters`);
    code = 0;
  } else {
    console.error(`gi-src-shade: FAIL — ${result?.error ?? `${result?.failures} of ${result?.checks} checks`}`);
    if (!result?.text) console.error(logs.slice(-25).join("\n"));
  }
} catch (err) {
  console.error(`gi-src-shade: FAIL — ${err.message}`);
  console.error(logs.slice(-30).join("\n"));
} finally {
  await browser.close();
}
process.exit(code);
