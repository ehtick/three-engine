// SRC VISUAL — drives scripts/gi-src-visual.html and writes the frames to PNG.
//
// The eye check, made capturable: three renders of one scene — the analytic
// light alone, SRC's c0 resolve ALONE (light off, sky up), and both together.
// The middle one is the point; every lit pixel in it came out of the new code.
//
// It does not replace a person looking at Sponza in the editor (plan §12.17.8).
// It makes the failure a headless rig CAN see obvious, and it produces images a
// person can judge without launching anything.
//
// Run: node scripts/run-gi-src-visual.mjs [outDir] [baseUrl] [?query]
import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const outDir = process.argv[2] ?? "artifacts/gi-src-visual";
const base = (process.argv[3] ?? "http://localhost:5201/").replace(/\/$/, "");
// 3rd arg is a QUERY, not part of the base — passing "?lamp=3" as the base
// silently produced a page with a NaN lamp intensity and a black direct frame.
const query = process.argv[4] ?? "";
const url = `${base}/scripts/gi-src-visual.html${query}`;

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
  await page.waitForFunction("globalThis.__SRC_VISUAL_RESULT__ !== undefined", { timeout: 240000 });
  const result = await page.evaluate("globalThis.__SRC_VISUAL_RESULT__");
  if (result?.text) console.log(result.text);
  if (result?.pass) {
    mkdirSync(outDir, { recursive: true });
    for (const shot of result.shots) {
      const file = join(outDir, `${shot.label}.png`);
      writeFileSync(file, Buffer.from(shot.png.split(",")[1], "base64"));
      console.log(`  wrote ${file} (mean ${shot.mean}/255)`);
    }
    if (result.gather) {
      const g = result.gather;
      console.log(`gi-src-visual: PASS — ${g.lit}/${g.pixels} pixels lit, ` +
        `lum ${g.minLum}..${g.maxLum}, contrast ${g.contrast}, ${g.corners}/8 probes per pixel`);
    }
    if (result.rays) {
      console.log(`  rays ${result.rays.traced}/${result.rays.budget}, ` +
        `${result.rays.deposits} deposits, hit ${(result.rays.hitRate * 100).toFixed(1)}%, ` +
        `probes ${result.probes?.join(" -> ")}`);
    }
    code = 0;
  } else {
    console.error(`gi-src-visual: FAIL — ${result?.error ?? "no result"}`);
    console.error(logs.slice(-25).join("\n"));
  }
} catch (err) {
  console.error(`gi-src-visual: FAIL — ${err.message}`);
  console.error(logs.slice(-30).join("\n"));
} finally {
  await browser.close();
}
process.exit(code);
