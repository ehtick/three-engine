// SRC PROBE POPULATION GATE — drives scripts/gi-src-populate.html.
//
// Plan §7's Phase-1 gate ("probe counts vs CPU mirror on a fixed camera", "LOD
// rings hug surfaces at expected radii"), run against a SYNTHETIC gbuffer
// instead of the real one. That is deliberate: the pixel set is chosen rather
// than whatever a scene happened to rasterize, it spans every LOD ring on
// purpose, and once the real gbuffer is wired in, a failure there cannot be the
// population math — this gate already owns that.
//
// Run: node scripts/run-gi-src-populate-test.mjs [baseUrl]
import puppeteer from "puppeteer-core";

const base = (process.argv[2] ?? "http://localhost:5201/").replace(/\/$/, "");
const url = `${base}/scripts/gi-src-populate.html`;

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
  await page.waitForFunction("globalThis.__SRC_POPULATE_RESULT__ !== undefined", { timeout: 240000 });
  const result = await page.evaluate("globalThis.__SRC_POPULATE_RESULT__");
  if (result?.text) console.log(result.text);
  if (result?.pass) {
    console.log(`gi-src-populate: PASS — probes ${result.probesPerCascade?.join(" -> ")}, ` +
      `storage limit ${result.storageLimit}`);
    code = 0;
  } else {
    console.error(`gi-src-populate: FAIL — ${result?.error ?? `${result?.failures} checks`}`);
    if (!result?.text) console.error(logs.slice(-25).join("\n"));
  }
} catch (err) {
  console.error(`gi-src-populate: FAIL — ${err.message}`);
  console.error(logs.slice(-30).join("\n"));
} finally {
  await browser.close();
}
process.exit(code);
