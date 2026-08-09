// SRC PROBE HASHMAP GATE — drives scripts/gi-src-probes.html.
//
// `srcProbes.js` is a lock-free open-addressed hashmap in raw WGSL. Every way
// it can be wrong looks healthy from outside: a duplicate entry splits one
// probe's rays across two payloads, a lost insert is a dark patch that moves
// with the camera, a leaked slot kills the table after `probeCapacity` probes
// have ever existed. The page holds it to `srcRef.js`'s `SrcProbeMap` under a
// contended storm and then checks the three lifecycle properties no mirror
// covers: a survivor keeps its index, an absent probe retires on schedule, and
// a retired index comes back.
//
// Run: node scripts/run-gi-src-probes-test.mjs [baseUrl]
import puppeteer from "puppeteer-core";

const base = (process.argv[2] ?? "http://localhost:5201/").replace(/\/$/, "");
const url = `${base}/scripts/gi-src-probes.html`;

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
  await page.waitForFunction("globalThis.__SRC_PROBES_RESULT__ !== undefined", { timeout: 180000 });
  const result = await page.evaluate("globalThis.__SRC_PROBES_RESULT__");
  if (result?.text) console.log(result.text);
  if (result?.pass) {
    console.log(`gi-src-probes: PASS — storage limit ${result.storageLimit}`);
    code = 0;
  } else {
    console.error(`gi-src-probes: FAIL — ${result?.error ?? `${result?.failures} checks`}`);
    if (!result?.text) console.error(logs.slice(-20).join("\n"));
  }
} catch (err) {
  console.error(`gi-src-probes: FAIL — ${err.message}`);
  console.error(logs.slice(-25).join("\n"));
} finally {
  await browser.close();
}
process.exit(code);
