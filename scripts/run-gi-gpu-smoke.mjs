// Drives scripts/gi-gpu-smoke.html arms and reports pass/fail.
// Usage: node drive-gi-gpu-smoke.mjs "<query1>" "<query2>" ...
import puppeteer from "puppeteer-core";

// `GI_SMOKE_PAGE` overrides the page — which exists so a suspected regression
// can be A/B'd against a checked-out copy of the same harness at another
// commit, on the same adapter, in the same session. Cross-session comparisons
// of this smoke are not meaningful (compile waves swing several-fold).
const base = process.env.GI_SMOKE_PAGE ?? "http://localhost:5201/scripts/gi-gpu-smoke.html";
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
      // The `?src=1` arm's whole output is these numbers; a bare PASS would
      // hide the probe counts and the hash load the arm exists to report.
      if (result.srcProbes) {
        console.log(`  src probes: ${result.srcProbes.dispatches} dispatches, ` +
          `${result.srcProbes.megabytes}MB, gizmoPixels ${result.srcProbes.gizmoPixels}, ` +
          result.srcProbes.cascades
            .map((c, i) => `c${i} ${c.live} live/load ${c.load}/steps ${c.steps}` +
              (c.failed ? ` FAILED ${c.failed}` : ""))
            .join("  "));
        // The scaffold ray pass's numbers are the input to the `Lmax` decision
        // §12.13.4 left open, so they get printed rather than merely asserted.
        const r = result.srcProbes.rays;
        if (r) {
          console.log(`  src rays: ${r.count} traced = ${r.budget} budgeted ` +
            `(${r.perPixel}/px), hit ${(r.hitRate * 100).toFixed(1)}%, ` +
            `mean t ${r.meanT}m, max t ${r.maxT}m`);
          console.log(`  src deposits: ${r.deposits} (${r.perRay}/ray) into ` +
            `${(r.bins / 1e6).toFixed(2)}M bins, ${r.clamped} clamped`);
        }
      }
      const unfed = logs.find((l) => l.includes("traversal counters unfed"));
      if (unfed) console.log(`  note: ${unfed.replace("GI-SMOKE NOTE ", "")}`);
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
