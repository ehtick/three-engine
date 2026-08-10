// SRC LATTICE PROBE — drives scripts/gi-src-lattice.html.
//
// §7's last Phase 4 gate item: "probe:gi-block-size ACF (expect block scale to
// track s₀·LOD — measure the world period, R14)". The old rig cannot answer it
// — it sweeps voxelSize and probeSpacing with autoFit off, and all three were
// retired when GI collapsed to one property (§12.19.5) — so the METRIC carries
// forward and the sweep axis becomes `quality`, whose four tiers set s₀ to
// 0.8 / 0.6 / 0.45 / 0.35 m.
//
// The expected result is a NULL (§12.22 measured the blocks gone), which is why
// the probe self-tests: white noise decorrelates at lag 1 and would report "no
// blocks" whatever the frame contains, so frames are averaged, the surviving
// noise is measured, and the estimator is run against synthetic fields carrying
// a real period plus that same noise. An instrument that cannot find a block it
// was handed has proved nothing by failing to find one.
//
// Run: node scripts/run-gi-src-lattice-test.mjs [baseUrl]
import puppeteer from "puppeteer-core";

const base = (process.argv[2] ?? "http://localhost:5201/").replace(/\/$/, "");
const url = `${base}/scripts/gi-src-lattice.html`;

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
const logs = [];
page.on("console", (m) => {
  const t = m.text();
  logs.push(t);
  if (/\[gi\] built|diffuse indirect|src probes|unavailable|NOBLOCK/.test(t)) console.log(`  ${t.slice(0, 220)}`);
});
page.on("pageerror", (e) => logs.push(`PAGEERROR ${e.stack ?? e.message}`));

let code = 1;
try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction("globalThis.__SRC_LATTICE_RESULT__ !== undefined", { timeout: 900000 });
  const result = await page.evaluate("globalThis.__SRC_LATTICE_RESULT__");
  if (result?.text) console.log(result.text);
  if (result?.pass) {
    console.log(`gi-src-lattice: PASS — no block period at the probe spacing, at any tier ` +
      `(worst block/s0 ${result.worstRatio}, where 1.0 is a piecewise-constant cell)\n` +
      `                ${result.tiers.map((t) => `${t.tier} s0 ${t.s0} -> ${t.bx}m`).join(", ")}\n` +
      `                the estimator recovers synthetic blocks to ${result.worstControl}% at ` +
      `${result.cmPerTexel}cm/texel, which is what makes the null mean something; ` +
      `storage limit ${result.storageLimit}`);
    code = 0;
  } else {
    console.error(`gi-src-lattice: FAIL — ${result?.error ?? `${result?.failures} checks`}`);
    if (!result?.text) console.error(logs.slice(-25).join("\n"));
  }
} catch (err) {
  console.error(`gi-src-lattice: FAIL — ${err.message}`);
  console.error(logs.slice(-30).join("\n"));
} finally {
  await browser.close();
}
process.exit(code);
