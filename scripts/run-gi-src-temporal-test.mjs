// SRC TEMPORAL GATE — drives scripts/gi-src-temporal.html.
//
// Plan §4.6 / Phase 4 unit 1: the decaying deposit accumulator, diffed against
// `srcMath.js`'s `decayFixed` word for word over a pure-decay run, and held to
// a constant signal over a traced one. No scene, no engine, no occupancy field
// — the trace is a constant hit in cascade 2's interval, which is what makes
// the arms exact under a ray partition that is deliberately non-deterministic.
//
// Race-sensitive like the rest of the family — the population underneath it is
// built by atomics. Run it more than once before believing a green.
//
// Run: node scripts/run-gi-src-temporal-test.mjs [baseUrl]
import puppeteer from "puppeteer-core";

const base = (process.argv[2] ?? "http://localhost:5201/").replace(/\/$/, "");
const url = `${base}/scripts/gi-src-temporal.html`;

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
  await page.waitForFunction("globalThis.__SRC_TEMPORAL_RESULT__ !== undefined", { timeout: 600000 });
  const result = await page.evaluate("globalThis.__SRC_TEMPORAL_RESULT__");
  if (result?.text) console.log(result.text);
  if (result?.pass) {
    console.log(`gi-src-temporal: PASS — alpha ${result.alpha}, ${result.steadyBins} bins held a ` +
      `constant signal to ${result.steadyWorst}\n` +
      `                 pure decay matched decayFixed word for word, settling in ` +
      `${result.fadeFrames} frames; ${result.tracked} bins retired before going dark\n` +
      `                 ${result.maxRays} rays of accumulated weight (${result.headroom}x headroom); ` +
      `${result.staleBins} stale bins discarded on reclaim\n` +
      `                 frame-to-frame variation fell ${result.varReduction}x against the ` +
      `${result.varPredicted}x an EMA predicts; storage limit ${result.storageLimit}`);
    code = 0;
  } else {
    console.error(`gi-src-temporal: FAIL — ${result?.error ?? `${result?.failures} checks`}`);
    if (!result?.text) console.error(logs.slice(-25).join("\n"));
  }
} catch (err) {
  console.error(`gi-src-temporal: FAIL — ${err.message}`);
  console.error(logs.slice(-30).join("\n"));
} finally {
  await browser.close();
}
process.exit(code);
