// SRC DEPOSIT GATE — drives scripts/gi-src-deposit.html.
//
// Plan §12.13.5 unit 3's gate: `createSrcDepositFrame`'s split scatter and
// resolve, diffed against `srcRef.js`'s `traceAndDeposit` on a synthetic
// gbuffer with a synthetic, ray-index-keyed trace — bit-exact across the
// CPU/GPU boundary where anything keyed on the DIRECTION would not be.
//
// Race-sensitive: every accumulator is an atomic and the ray assignment feeding
// it is scheduler-ordered. Run it more than once before believing a green.
//
// Run: node scripts/run-gi-src-deposit-test.mjs [baseUrl]
import puppeteer from "puppeteer-core";

const base = (process.argv[2] ?? "http://localhost:5201/").replace(/\/$/, "");
const url = `${base}/scripts/gi-src-deposit.html`;

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
  await page.waitForFunction("globalThis.__SRC_DEPOSIT_RESULT__ !== undefined", { timeout: 240000 });
  const result = await page.evaluate("globalThis.__SRC_DEPOSIT_RESULT__");
  if (result?.text) console.log(result.text);
  if (result?.pass) {
    console.log(`gi-src-deposit: PASS — ${result.deposits} deposits from ${result.rays} rays ` +
      `(${result.perRay}/ray) into ${result.sampledBins} of ${result.binTotal} bins, ` +
      `${result.binTies} direction ties, ${result.headroom}x fixed-point headroom, ` +
      `storage limit ${result.storageLimit}\n` +
      `                 blocks ${result.blocks} for ${result.liveProbes} live probes ` +
      `(${result.binBytes}MB); starved run dropped ${result.starvedDropped} deposits\n` +
      `                 per-block evidence: ${result.statBlocks} blocks summed ` +
      `${result.statLuma} of shifted luma, exact against the walk`);
    code = 0;
  } else {
    console.error(`gi-src-deposit: FAIL — ${result?.error ?? `${result?.failures} checks`}`);
    if (!result?.text) console.error(logs.slice(-25).join("\n"));
  }
} catch (err) {
  console.error(`gi-src-deposit: FAIL — ${err.message}`);
  console.error(logs.slice(-30).join("\n"));
} finally {
  await browser.close();
}
process.exit(code);
