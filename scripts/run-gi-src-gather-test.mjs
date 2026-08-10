// SRC GATHER GATE — drives scripts/gi-src-gather.html.
//
// Plan §12.18.7 unit 5's gate: `createSrcScreenGather`'s sparse-trilinear,
// coverage-weighted, LOD-blended probe gather, diffed against `srcRef.js`'s
// `gatherPixel` over a synthesized merged c0 field.
//
// The arm that matters is `smooth`. This unit exists to remove the ~0.6 m
// rectangles every frame has had since §12.17, and those were not a probe-
// density problem — one probe per pixel with no interpolation is piecewise
// CONSTANT across a cell. So the gate walks a scan line at 3.9 cm steps well
// inside one 0.5 m cell and measures how many steps change the answer, against
// the same measurement made with interpolation switched off.
//
// Race-sensitive like the rest of the family. Run it more than once.
//
// Run: node scripts/run-gi-src-gather-test.mjs [baseUrl]
import puppeteer from "puppeteer-core";

const base = (process.argv[2] ?? "http://localhost:5201/").replace(/\/$/, "");
const url = `${base}/scripts/gi-src-gather.html`;

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
  await page.waitForFunction("globalThis.__SRC_GATHER_RESULT__ !== undefined", { timeout: 240000 });
  const result = await page.evaluate("globalThis.__SRC_GATHER_RESULT__");
  if (result?.text) console.log(result.text);
  if (result?.pass) {
    console.log(`gi-src-gather: PASS — ${result.checked} points vs gatherPixel over ` +
      `${result.probes} probes (worst ${result.worst}% of peak)\n` +
      `               SMOOTH: ${result.varied}% of 3.9cm steps change value, against a ` +
      `${result.control}% nearest-probe control\n` +
      `               furnace worst ${result.furnaceWorst}, ${result.corners}/8 corners per ` +
      `pixel, coverage worth up to ${result.coverageEffect}%, LOD step ${result.shellMax}, ` +
      `storage limit ${result.storageLimit}`);
    code = 0;
  } else {
    console.error(`gi-src-gather: FAIL — ${result?.error ?? `${result?.failures} checks`}`);
    if (!result?.text) console.error(logs.slice(-25).join("\n"));
  }
} catch (err) {
  console.error(`gi-src-gather: FAIL — ${err.message}`);
  console.error(logs.slice(-30).join("\n"));
} finally {
  await browser.close();
}
process.exit(code);
