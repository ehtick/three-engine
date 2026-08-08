// Drives scripts/gi-gpu-smoke.html arms and reports pass/fail.
// Usage: node drive-gi-gpu-smoke.mjs "<query1>" "<query2>" ...
import puppeteer from "puppeteer-core";

const base = "http://localhost:5201/scripts/gi-gpu-smoke.html";
const arms = process.argv.slice(2);
if (!arms.length) arms.push("?dynobj=2", "?mode=hybrid-exact-complex&dynobj=2");

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
let failed = 0;
for (const arm of arms) {
  const page = await browser.newPage();
  const logs = [];
  page.on("console", (m) => logs.push(m.text()));
  page.on("pageerror", (e) => logs.push(`PAGEERROR ${e.message}`));
  try {
    await page.goto(base + arm, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForFunction("globalThis.__GI_SMOKE_RESULT__ !== undefined", { timeout: 120000 });
    const result = await page.evaluate("globalThis.__GI_SMOKE_RESULT__");
    if (result?.pass) {
      console.log(`PASS ${arm} — storage ${result.storageLimit}`);
    } else {
      failed++;
      console.error(`FAIL ${arm}:`, JSON.stringify(result).slice(0, 400));
      console.error(logs.filter((l) => /error|Error|fail/i.test(l)).slice(-8).join("\n"));
    }
  } catch (err) {
    failed++;
    console.error(`FAIL ${arm}: ${err.message}`);
    console.error(logs.slice(-12).join("\n"));
  }
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
