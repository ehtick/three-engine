// SRC TILE GATE — drives scripts/gi-src-tiles.html.
//
// Plan §12.18.7 unit 4's gate: `createSrcTileAtlas`'s octahedral irradiance
// bake, diffed against `srcRef.js`'s `bakeProbeIrradiance` over a SYNTHESIZED
// merged c0 field — no deposit, no merge, no scene, no engine.
//
// Two arms are worth knowing about before reading a failure:
//   • `border` is EXACT, because a border texel and the interior texel it
//     mirrors are computed by the GPU from the same table row in the same
//     order. A difference there is an ADDRESSING fault, not arithmetic.
//   • `bleed` lights ONE tile in a field of black ones and samples its atlas
//     neighbours at 4,096 normals. That is what makes hardware bilinear over a
//     packed atlas safe rather than merely cheap.
//
// Race-sensitive like the rest of the family — the population underneath it is
// built by atomics. Run it more than once before believing a green.
//
// Run: node scripts/run-gi-src-tiles-test.mjs [baseUrl]
import puppeteer from "puppeteer-core";

const base = (process.argv[2] ?? "http://localhost:5201/").replace(/\/$/, "");
const url = `${base}/scripts/gi-src-tiles.html`;

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
  await page.waitForFunction("globalThis.__SRC_TILES_RESULT__ !== undefined", { timeout: 240000 });
  const result = await page.evaluate("globalThis.__SRC_TILES_RESULT__");
  if (result?.text) console.log(result.text);
  if (result?.pass) {
    console.log(`gi-src-tiles: PASS — ${result.tiles}/${result.blocks} tiles in a ` +
      `${result.atlas} atlas (${result.megabytes}MB, ${result.coverage}% covered)\n` +
      `             ${result.interiorChecked} interior texels vs bakeProbeIrradiance ` +
      `(worst used ${result.worstRel}% of its allowance), ` +
      `${result.borderChecked} border texels bit-exact\n` +
      `             furnace worst ${result.furnaceWorst}, corner spread ${result.cornerSpread}%, ` +
      `${result.uncovered}% of texels uncovered, ${result.queries} sampler queries ` +
      `(worst ${result.worstSample}% of tile range), storage limit ${result.storageLimit}`);
    code = 0;
  } else {
    console.error(`gi-src-tiles: FAIL — ${result?.error ?? `${result?.failures} checks`}`);
    if (!result?.text) console.error(logs.slice(-25).join("\n"));
  }
} catch (err) {
  console.error(`gi-src-tiles: FAIL — ${err.message}`);
  console.error(logs.slice(-30).join("\n"));
} finally {
  await browser.close();
}
process.exit(code);
