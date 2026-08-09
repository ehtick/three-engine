// SRC MATH TWIN GATE — drives scripts/gi-src-math.html and reports pass/fail.
//
// `srcMath.js` (the CPU mirror) and `srcMathTsl.js` (the GPU kernel) are two
// expressions of one definition. Each has its own suite; neither suite can see
// them DISAGREE. This does: the page evaluates every TSL twin in a real compute
// pass and diffs it against the JS original over the same inputs, with integer
// results — the values the probe hashmap is keyed on — held BIT-EXACT.
//
// A browser is required and that is not a shortcut waiting to be removed:
// headless WebGPU has never worked in this repo (see the ReSTIR notes), so a
// real Chrome with a real adapter is the only place a WGSL transcription error
// is observable at all.
//
// Run: node scripts/run-gi-src-math-test.mjs [baseUrl]
// Default base is the DEV server on 5201 — the same port the other GI probes
// use. Pass another if you are running a scoped vite.
import puppeteer from "puppeteer-core";

const base = (process.argv[2] ?? "http://localhost:5201/").replace(/\/$/, "");
const url = `${base}/scripts/gi-src-math.html`;

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
  await page.waitForFunction("globalThis.__SRC_MATH_RESULT__ !== undefined", { timeout: 120000 });
  const result = await page.evaluate("globalThis.__SRC_MATH_RESULT__");
  if (result?.text) console.log(result.text);
  if (result?.pass) {
    console.log(`gi-src-math: PASS — ${result.cases} cases, ${result.exactFamilies} exact families bit-identical, storage limit ${result.storageLimit}`);
    code = 0;
  } else {
    console.error(`gi-src-math: FAIL — ${result?.error ?? `${result?.details?.length ?? 0} families disagree`}`);
    // The first differing case of each failing family, with its input, because
    // "hashKey differs" is not actionable and "hashKey differs on case 412,
    // cell (-257, 0, 0)" names the branch.
    for (const d of result?.details ?? []) {
      const c = d.kind === "exact" ? d.first : d.at;
      console.error(`  ${d.label}: ${d.kind === "exact" ? `${d.bad} cases differ` : `worst ${d.worst}`}`);
      console.error(`    case ${c?.i} input ${JSON.stringify(c?.input)}`);
      console.error(`    got ${c?.got} want ${c?.want}`);
    }
    if (!result?.text) console.error(logs.slice(-15).join("\n"));
  }
} catch (err) {
  console.error(`gi-src-math: FAIL — ${err.message}`);
  console.error(logs.slice(-20).join("\n"));
} finally {
  await browser.close();
}
process.exit(code);
