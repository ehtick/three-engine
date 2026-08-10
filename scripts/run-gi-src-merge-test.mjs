// SRC MERGE GATE — drives scripts/gi-src-merge.html.
//
// Plan §12.18.7 unit 3's gate: `createSrcMergeFrame`'s cascade N−1 → 0 ladder,
// diffed against `srcRef.js`'s `mergeCascades` over a SYNTHESIZED resolved
// field — no deposit, no scene, no engine. The field is written straight into
// the payload buffer from a hash of (cascade, probe key, morton), so the gate
// chooses its own awkward cases (unknown bins, partial pre-averages, orphaned
// stencils) instead of waiting for a real deposit to produce them by luck.
//
// Race-sensitive like the rest of the family — the population underneath it is
// built by atomics. Run it more than once before believing a green.
//
// Run: node scripts/run-gi-src-merge-test.mjs [baseUrl]
import puppeteer from "puppeteer-core";

const base = (process.argv[2] ?? "http://localhost:5201/").replace(/\/$/, "");
const url = `${base}/scripts/gi-src-merge.html`;

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
  await page.waitForFunction("globalThis.__SRC_MERGE_RESULT__ !== undefined", { timeout: 240000 });
  const result = await page.evaluate("globalThis.__SRC_MERGE_RESULT__");
  if (result?.text) console.log(result.text);
  if (result?.pass) {
    console.log(`gi-src-merge: PASS — ${result.merged}/${result.bins} known bins merged over ` +
      `${result.probes} probes, ${result.meanCorners}/8 corners found, ` +
      `${result.orphanRate}% orphaned, ${result.resolvedRate}% reached the sky\n` +
      `              ${result.mergedChecked} bins diffed against mergeCascades ` +
      `(worst ${result.worstErr}); furnace lit ${result.furnaceLit} bins ` +
      `(worst ${result.furnaceWorst}); storage limit ${result.storageLimit}`);
    code = 0;
  } else {
    console.error(`gi-src-merge: FAIL — ${result?.error ?? `${result?.failures} checks`}`);
    if (!result?.text) console.error(logs.slice(-25).join("\n"));
  }
} catch (err) {
  console.error(`gi-src-merge: FAIL — ${err.message}`);
  console.error(logs.slice(-30).join("\n"));
} finally {
  await browser.close();
}
process.exit(code);
