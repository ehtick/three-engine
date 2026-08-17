// Startup smoke: does launching the editor come back to where you left off?
//
//   npx vite --port 5213 --strictPort
//   node scripts/run-startup-reopen-smoke.mjs [url]
//
// HEADED=1 to watch it run.
//
// The behaviour under test is a DECISION MADE BEFORE THE FIRST PAINT: with a
// last project remembered, the launch walks past the project hub and reopens
// it; without one, or when the folder is gone, it stops at the hub. Every one
// of those failure modes is silent — an editor that opens the wrong thing, or
// stops at a picker it should have skipped, throws nothing — so each case gets
// its own fresh page rather than being inferred from one boot.
//
// Six pages, one launch condition each:
//   1. remembered project           -> opens it, no hub, splash names it
//   2. nothing remembered           -> hub
//   3. remembered project is GONE   -> hub, and the memory is kept
//   4. auto-open opted out          -> hub (this is what ~160 harnesses rely on)
//   5. "Skip the project"           -> STAYS projectless
//   6. reload handoff naming a scene-> that scene, loaded exactly once
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5213/";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------------------------- */
/* scratch project: two scenes, so "the last scene" and "some other scene" are  */
/* distinguishable — a reload handoff that silently loads project.json's        */
/* lastScene instead of the one it was given would otherwise look correct.      */
/* -------------------------------------------------------------------------- */

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "engine-startup-"));
const POSIX = ROOT.replaceAll("\\", "/");
const scene = (name) =>
  JSON.stringify(
    {
      version: 1,
      name,
      settings: { background: "#202329", ambientColor: "#ffffff", ambientIntensity: 0.6, shadows: false },
      entities: [],
    },
    null,
    2,
  );
fs.mkdirSync(path.join(ROOT, "scenes"), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, "project.json"),
  JSON.stringify({ name: "StartupSmoke", version: 1, lastScene: "scenes/Main.scene", modules: [] }, null, 2),
);
fs.writeFileSync(path.join(ROOT, "scenes", "Main.scene"), scene("Main"));
fs.writeFileSync(path.join(ROOT, "scenes", "Other.scene"), scene("Other"));

const GONE = `${POSIX}/DeletedProject`;

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});

const pageErrors = [];

/**
 * One launch, from a known-empty storage state.
 *
 * ⚠ localStorage is per-ORIGIN, not per-page: every page in this browser shares
 * one bucket for `localhost:5213`, so without the wipe below, case 1 opening a
 * project leaves `engine.projectRoot.v1` set for case 2 — which is meant to be
 * a first-ever launch and would silently test the opposite of what it says.
 *
 * `seed` runs before any of the app's code does, which is the only place a
 * "what the last session left behind" fixture can be written — the decision
 * under test is made during module evaluation.
 */
async function launch({ seed, seedArg, autoOpen = true, settle = 6000 }) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  await installTauriShim(page, { writableRoot: ROOT, autoOpenProject: autoOpen });
  page.on("pageerror", (e) => pageErrors.push(e.stack ?? e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/404|Failed to load resource|WebGPU|GPUAdapter/i.test(m.text())) {
      pageErrors.push(m.text());
    }
  });
  // Registered before the seed so the seed's writes survive it.
  await page.evaluateOnNewDocument(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  if (seed) await page.evaluateOnNewDocument(seed, seedArg);
  await page.goto(url, { waitUntil: "load", timeout: 45000 });
  await wait(settle);
  return page;
}

/** What the app settled on, read from the DOM and the store together. */
const readState = (page) =>
  page.evaluate(async () => {
    const { useProjectStore } = await import("/src/editor/store/projectStore.js");
    const s = useProjectStore.getState();
    return {
      rootPath: s.rootPath,
      hubSkipped: s.hubSkipped,
      restoring: s.restoring,
      hub: !!document.querySelector(".hub-shell"),
      splash: document.querySelector(".editor-splash")?.textContent?.trim() ?? null,
      shell: !!document.querySelector(".dockview-theme-abyss, .dv-dockview, .editor-shell"),
      lastProject: localStorage.getItem("engine.projectRoot.v1"),
    };
  });

/* -- 1. a remembered project opens, and the hub never appears --------------- */

{
  // The splash is short-lived by design, so it is sampled early rather than
  // after the settle — by the time the project is open it is gone, and a check
  // that can only run after would be checking the wrong frame.
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  await installTauriShim(page, { writableRoot: ROOT, autoOpenProject: true });
  await page.evaluateOnNewDocument(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.evaluateOnNewDocument((root) => {
    localStorage.setItem("engine.projectRoot.v1", root);
    localStorage.setItem("engine.recentProjects.v1", JSON.stringify([root]));
  }, POSIX);
  await page.goto(url, { waitUntil: "load", timeout: 45000 });
  const early = await page.evaluate(() => ({
    hub: !!document.querySelector(".hub-shell"),
    splashOrShell: !!document.querySelector(".editor-splash") || !!document.querySelector(".dv-dockview"),
  }));
  check("the hub does not paint on a launch that has a project to reopen", early.hub === false, JSON.stringify(early));

  await wait(8000);
  const state = await readState(page);
  check("…and the remembered project is open", state.rootPath === POSIX, String(state.rootPath));
  check("…with the restore flag cleared afterwards", state.restoring === false, String(state.restoring));
  check("…without having flipped 'skip the hub' to get there", state.hubSkipped === false, String(state.hubSkipped));

  const scenePath = await page.evaluate(async () => {
    const { useSceneStore } = await import("/src/editor/store/sceneStore.js");
    return useSceneStore.getState().scenePath;
  });
  check(
    "…and project.json's lastScene is the scene that loaded",
    /Main\.scene$/i.test(scenePath ?? ""),
    String(scenePath),
  );
  await page.close();
}

/* -- 2. a first-ever launch still gets the picker --------------------------- */

{
  const page = await launch({ seed: null });
  const state = await readState(page);
  check("a launch with nothing remembered shows the hub", state.hub === true && state.rootPath === null, JSON.stringify(state));
  await page.close();
}

/* -- 3. a project that has moved or been deleted ---------------------------- */

{
  // The failure this guards is not "it errors" — `openProject` REPORTS SUCCESS
  // for a path that no longer exists (project.json failing to read is a
  // tolerated "not a hub project", and the folder listing catches its own
  // error into store state). Without the existence check the editor opens onto
  // nothing and the only symptom is an empty Assets panel.
  const page = await launch({
    seed: (gone) => {
      localStorage.setItem("engine.projectRoot.v1", gone);
      localStorage.setItem("engine.recentProjects.v1", JSON.stringify([gone]));
    },
    seedArg: GONE,
  });
  const state = await readState(page);
  check("a remembered project that is gone falls back to the hub", state.hub === true, JSON.stringify(state));
  check("…rather than opening an editor pointed at nothing", state.rootPath === null, String(state.rootPath));
  check(
    "…and the memory is kept, not erased (an unplugged drive looks the same)",
    state.lastProject === GONE,
    String(state.lastProject),
  );
  await page.close();
}

/* -- 4. the opt-out every harness in scripts/ depends on -------------------- */

{
  const page = await launch({
    seed: (root) => {
      localStorage.setItem("engine.projectRoot.v1", root);
      localStorage.setItem("engine.recentProjects.v1", JSON.stringify([root]));
    },
    seedArg: POSIX,
    autoOpen: false,
  });
  const state = await readState(page);
  check("__editorNoAutoOpen keeps the hub, even with a project remembered", state.hub === true, JSON.stringify(state));
  const rows = await page.evaluate(() => document.querySelectorAll(".hub-recent-open-btn").length);
  check("…and the recent row the GI/blackframe harnesses click is there", rows === 1, String(rows));
  await page.close();
}

/* -- 5. "Skip the project" must actually skip ------------------------------- */

{
  // Regression: the Assets panel used to call `restoreLastFolder()` on mount
  // whenever no project was open, so choosing "Skip the project" opened the
  // last project a beat later anyway. It went unnoticed because a harness's
  // profile is empty, so there was never a last project to restore.
  const page = await launch({
    seed: (root) => {
      localStorage.setItem("engine.projectRoot.v1", root);
      localStorage.setItem("engine.recentProjects.v1", JSON.stringify([root]));
    },
    seedArg: POSIX,
    autoOpen: false,
    settle: 3000,
  });
  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
  });
  await wait(6000);
  const state = await readState(page);
  check("'Skip the project' leaves the editor projectless", state.rootPath === null, String(state.rootPath));
  check("…and does not quietly reopen the last project", state.hubSkipped === true, JSON.stringify(state));
  await page.close();
}

/* -- 6. a reload comes back to the EXACT scene ------------------------------ */

{
  // project.json says Main; the handoff says Other. The handoff has to win, or
  // `editor.reload` relocates the session — and it must not load twice, which
  // is what happens if the hook races the boot instead of waiting for it.
  const page = await launch({
    seed: (args) => {
      localStorage.setItem("engine.projectRoot.v1", args.root);
      localStorage.setItem("engine.recentProjects.v1", JSON.stringify([args.root]));
      sessionStorage.setItem(
        "engine.mcpReloadReopen",
        JSON.stringify({ project: args.root, scene: `${args.root}/scenes/Other.scene` }),
      );
    },
    seedArg: { root: POSIX },
    settle: 12000,
  });
  const after = await page.evaluate(async () => {
    const { useSceneStore } = await import("/src/editor/store/sceneStore.js");
    return useSceneStore.getState().scenePath;
  });
  check(
    "a reload handoff reopens the scene it names, not project.json's lastScene",
    /Other\.scene$/i.test(after ?? ""),
    String(after),
  );
  const handoff = await page.evaluate(() => sessionStorage.getItem("engine.mcpReloadReopen"));
  check("…and the handoff is consumed, so the next launch is ordinary", handoff === null, String(handoff));
  await page.close();
}

/* -------------------------------------------------------------------------- */

const hard = pageErrors.filter((e) => !/WebGPU|GPUAdapter|deprecat|WebSocket/i.test(e));
if (hard.length) {
  console.log("\nconsole errors:");
  for (const e of hard.slice(0, 8)) console.log(`  ${String(e).slice(0, 300)}`);
}
const failed = results.filter((r) => !r.ok);
const bad = failed.length || hard.length;
console.log(`\nSTARTUP-SMOKE ${bad ? "FAIL" : "PASS"} — ${results.length - failed.length}/${results.length} checks`);
await browser.close();
fs.rmSync(ROOT, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
