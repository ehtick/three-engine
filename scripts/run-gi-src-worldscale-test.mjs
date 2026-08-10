// SRC WORLD-SCALE PROBE — drives scripts/gi-src-worldscale.html.
//
// Plan §1's central claim for the rebuild, and §7's remaining Phase 4 gate
// item: SRC's cost is SCREEN-proportional and "unlike today it does not scale
// with world size" (§4.2). Every §12 number so far was taken on an 8-metre
// room; this sweeps the world 8m -> 216m (729x the ground area) with the screen
// held at 320x240 and checks what a bigger world could actually break — the
// LOD-bounded probe population, the pool's claim counters, and whether the
// frame still resolves.
//
// The occupancy field DOES scale and is reported alongside rather than omitted:
// §4.5's R16 names it as the remaining scene-scale limit, out of SRC's scope.
//
// Run: node scripts/run-gi-src-worldscale-test.mjs [baseUrl]
import puppeteer from "puppeteer-core";

const base = (process.argv[2] ?? "http://localhost:5201/").replace(/\/$/, "");
const url = `${base}/scripts/gi-src-worldscale.html`;

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
  if (/\[gi\] built|diffuse indirect/.test(t)) console.log(`  ${t.slice(0, 150)}`);
});
page.on("pageerror", (e) => logs.push(`PAGEERROR ${e.stack ?? e.message}`));

let code = 1;
try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction("globalThis.__SRC_WORLDSCALE_RESULT__ !== undefined", { timeout: 900000 });
  const result = await page.evaluate("globalThis.__SRC_WORLDSCALE_RESULT__");
  if (result?.text) console.log(result.text);
  if (result?.pass) {
    console.log(`gi-src-worldscale: PASS — ${result.srcMB}MB of SRC at every scale from ` +
      `${result.scales[0]}m to ${result.scales.at(-1)}m (${result.areaRatio}x the ground area)\n` +
      `                   c0 probes ${result.c0.join(" -> ")} (${result.probeRatio}x), ` +
      `worst hashmap load ${result.worstLoad}, 0 failed claims\n` +
      `                   lit ${result.litFrac.join("% / ")}%; occupancy field ` +
      `${result.occMB.join(" / ")}MB at voxel ${result.occVoxel.join(" / ")}m
` +
      `                   THE WORLD-DEPENDENT TERM IS THE FIELD, NOT THE TRANSPORT: ` +
      `${result.occRatio}x SRC's footprint at ${result.scales.at(-1)}m (R16, still open); ` +
      `storage limit ${result.storageLimit}`);
    code = 0;
  } else {
    console.error(`gi-src-worldscale: FAIL — ${result?.error ?? `${result?.failures} checks`}`);
    if (!result?.text) console.error(logs.slice(-25).join("\n"));
  }
} catch (err) {
  console.error(`gi-src-worldscale: FAIL — ${err.message}`);
  console.error(logs.slice(-30).join("\n"));
} finally {
  await browser.close();
}
process.exit(code);
