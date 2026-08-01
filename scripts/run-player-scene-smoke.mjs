/**
 * Runtime scene loading, end to end, in a REAL build.
 *
 * The headless test (run-scene-manager-test.mjs) proves the bookkeeping. This
 * proves the thing a player actually ships: `npm run build:player` output,
 * served over HTTP, booting through `engine.loadScene` and then changing level
 * at runtime — with a real WebGPU renderer attaching real components, and the
 * loading screen coming and going.
 *
 * Usage: npm run smoke:player-scenes   (builds the player first if needed)
 */
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const template = path.join(root, "dist-player");
const out = path.join(root, ".tmp-player-smoke");

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}   ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

if (!existsSync(path.join(template, "index.html"))) {
  console.error("dist-player/ not found — run `npm run build:player` first.");
  process.exit(1);
}

// --- Stage a two-scene build -----------------------------------------------
const entity = (id, name, extra = {}) => ({
  id,
  name,
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  components: [],
  children: [],
  ...extra,
});
const camera = (id, name) => entity(id, name, { components: [{ type: "camera", props: {} }] });
const box = (id, name) => entity(id, name, { components: [{ type: "mesh", props: { geometry: "box" } }] });

const startScene = {
  version: 1,
  name: "Level1",
  player: { title: "Scene Smoke" },
  entities: [
    box("l1-box", "Level 1 Box"),
    camera("l1-cam", "Level 1 Camera"),
    entity("keeper", "Game Manager", { persistent: true }),
  ],
};
const level2 = {
  version: 1,
  name: "Level2",
  entities: [box("l2-box", "Level 2 Box"), camera("l2-cam", "Level 2 Camera")],
};
const hud = { version: 1, name: "Hud", entities: [entity("hud", "Hud Root")] };

await rm(out, { recursive: true, force: true });
await cp(template, out, { recursive: true });
await writeFile(path.join(out, "scene.json"), JSON.stringify(startScene));
await mkdir(path.join(out, "scenes"), { recursive: true });
await writeFile(path.join(out, "scenes", "Level2.scene"), JSON.stringify(level2));
await writeFile(path.join(out, "scenes", "Hud.scene"), JSON.stringify(hud));

// --- Serve it ---------------------------------------------------------------
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".scene": "application/json",
  ".css": "text/css",
  ".wasm": "application/wasm",
};
const server = createServer(async (req, res) => {
  const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\//, "") || "index.html";
  try {
    const body = await readFile(path.join(out, rel));
    res.writeHead(200, { "Content-Type": MIME[path.extname(rel)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(0, r));
const url = `http://localhost:${server.address().port}/`;

// --- Drive it ---------------------------------------------------------------
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

try {
  // Record every progress event from the very first one.
  await page.evaluateOnNewDocument(() => {
    globalThis.__progress = [];
    globalThis.__ticks = 0;
    const install = setInterval(() => {
      if (!globalThis.__engine) return;
      clearInterval(install);
      globalThis.__engine.on("scene-load-progress", (p) => globalThis.__progress.push(p));
      // Frames actually produced, counted from the engine's own update loop —
      // three's per-frame info is reset each frame and has no frame counter.
      globalThis.__engine.onUpdate(() => globalThis.__ticks++);
    }, 5);
  });
  await page.goto(url, { waitUntil: "load", timeout: 60000 });

  const booted = await page
    .waitForFunction(() => globalThis.__engine?.playing === true, { timeout: 45000 })
    .then(() => true)
    .catch(() => false);
  check("the build boots and starts playing", booted);
  if (!booted) throw new Error("player never reached playing state");

  // The overlay lifts two rAFs after the scene is ready (so the first frame
  // has landed), which can trail `playing = true` by a frame or two.
  await page
    .waitForFunction(() => document.getElementById("loading")?.classList.contains("is-hidden"), { timeout: 10000 })
    .catch(() => {});

  const first = await page.evaluate(() => ({
    names: [...globalThis.__engine.entities.values()].map((e) => e.name).sort(),
    scene: globalThis.__engine.scenes.active?.path,
    title: document.title,
    cameraName: globalThis.__engine.camera?.name ?? null,
    loadingHidden: document.getElementById("loading")?.classList.contains("is-hidden"),
    progressPhases: [...new Set(globalThis.__progress.map((p) => p.phase))],
  }));
  check("the start scene is built", first.names.join(",") === "Game Manager,Level 1 Box,Level 1 Camera", first.names.join(","));
  check("it boots through the scene manager", first.scene === "scene.json", String(first.scene));
  check("the exported page title is applied", first.title === "Scene Smoke", first.title);
  check("the loading screen went away", first.loadingHidden === true);
  check("boot reported progress phases", first.progressPhases.length >= 4, first.progressPhases.join(","));

  // Runtime level change — the whole point.
  const second = await page.evaluate(async () => {
    globalThis.__progress.length = 0;
    const record = await globalThis.__engine.loadScene("scenes/Level2.scene");
    return {
      record,
      names: [...globalThis.__engine.entities.values()].map((e) => e.name).sort(),
      sceneName: globalThis.__engine.sceneName,
      cameraIsLevel2:
        globalThis.__engine.camera ===
        globalThis.__engine.getEntity("l2-cam")?.getComponent("camera")?.camera,
      progressEnd: globalThis.__progress.at(-1)?.progress ?? null,
      loadingHidden: document.getElementById("loading")?.classList.contains("is-hidden"),
    };
  });
  check("loadScene resolves with the new scene", second.record?.name === "Level2", JSON.stringify(second.record));
  check("the old level is gone and the new one is here", second.names.join(",") === "Game Manager,Level 2 Box,Level 2 Camera", second.names.join(","));
  check("the persistent entity carried across", second.names.includes("Game Manager"));
  check("engine.sceneName follows the load", second.sceneName === "Level2", second.sceneName);
  check("the camera repointed at the new scene's camera", second.cameraIsLevel2 === true);
  check("progress reached 1", second.progressEnd === 1, String(second.progressEnd));

  // The loading screen re-shows during a mid-game load and hides again.
  await page.waitForFunction(() => document.getElementById("loading")?.classList.contains("is-hidden"), { timeout: 10000 }).catch(() => {});
  check("the loading screen hid again after the level change", await page.evaluate(() => document.getElementById("loading")?.classList.contains("is-hidden")) === true);

  // Additive load on top of the level.
  const third = await page.evaluate(async () => {
    await globalThis.__engine.loadScene("scenes/Hud.scene", { mode: "additive" });
    const names = [...globalThis.__engine.entities.values()].map((e) => e.name).sort();
    const unloaded = globalThis.__engine.unloadScene("scenes/Hud.scene");
    return {
      withHud: names,
      afterUnload: [...globalThis.__engine.entities.values()].map((e) => e.name).sort(),
      unloaded,
      active: globalThis.__engine.scenes.active?.path,
    };
  });
  check("an additive scene loads alongside the level", third.withHud.includes("Hud Root") && third.withHud.includes("Level 2 Box"), third.withHud.join(","));
  check("the active scene is still the level", third.active === "scenes/Level2.scene", String(third.active));
  check("unloading the additive scene removes only its entities", third.unloaded && !third.afterUnload.includes("Hud Root") && third.afterUnload.includes("Level 2 Box"), third.afterUnload.join(","));

  // Frames still render after two scene swaps — a stale camera or a disposed
  // render target would surface here rather than as a silent black screen.
  const rendered = await page.evaluate(async () => {
    const before = globalThis.__ticks;
    await new Promise((r) => setTimeout(r, 500));
    const after = globalThis.__ticks;
    return { before, after, backend: globalThis.__engine.getBackendName?.() };
  });
  check("the render loop is still running after the swaps", rendered.after > rendered.before, `${rendered.before} → ${rendered.after} (${rendered.backend})`);

  const fatal = pageErrors.filter((m) => !/Preload failed|preload failed/i.test(m));
  check("no page errors", fatal.length === 0, fatal.slice(0, 2).join(" | "));
} catch (error) {
  check("harness completed", false, error.message);
} finally {
  await browser.close();
  server.close();
  await rm(out, { recursive: true, force: true });
}

console.log(`\nPLAYER-SCENE-SMOKE ${fail ? "FAIL" : "PASS"} — ${pass}/${pass + fail} checks`);
process.exit(fail ? 1 : 0);
