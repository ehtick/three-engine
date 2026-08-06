import puppeteer from "puppeteer-core";

const url = process.argv[2];
const timeout = Number(process.argv[3] ?? 70_000);
if (!url) {
  console.error("usage: node scripts/run-gpu-page.mjs <url> [timeout-ms]");
  process.exit(2);
}

const executablePath = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const browser = await puppeteer.launch({
  executablePath,
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    // Headless/occluded pages get ~1/s timer+rAF throttling without these —
    // any arm that needs LIVE frames (temporal gates, kind-map readbacks)
    // silently measures a stalled engine (the session-15 profiling trap).
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
const validationErrors = [];
let passed = false;
page.on("console", (message) => {
  const line = message.text();
  console.log(line);
  if (line.includes("GI-SMOKE PASS")) passed = true;
  if (/WebGPU validation|exceeds the maximum per-stage limit|invalid ComputePipeline|pipeline.*invalid/i.test(line)) {
    validationErrors.push(line);
  }
});
page.on("pageerror", (error) => {
  const line = error.stack ?? error.message;
  console.error(line);
  validationErrors.push(line);
});

try {
  await page.goto(url, { waitUntil: "load", timeout: Math.min(timeout, 30_000) });
  await page.waitForFunction(
    () => globalThis.__GI_SMOKE_RESULT__?.pass === true || globalThis.__GI_SMOKE_RESULT__?.pass === false,
    { timeout },
  );
  const result = await page.evaluate(() => globalThis.__GI_SMOKE_RESULT__);
  if (!passed || !result?.pass || validationErrors.length) {
    throw new Error(`GI GPU smoke failed: ${JSON.stringify({ result, validationErrors })}`);
  }
} catch (error) {
  console.error(error?.stack ?? error);
  await browser.close();
  process.exit(1);
}

await browser.close();
process.exit(0);

