/**
 * A real build, served the way a host actually serves it.
 *
 * The headless test (run-build-test.mjs) proves the build system's decisions.
 * This proves the one thing that cannot be checked without a browser: that the
 * output runs **from a subdirectory**. Every local check is done at
 * `http://localhost:PORT/`, which IS the site root, so an absolute `/_engine/…`
 * bundle URL works perfectly on the developer's machine and 404s the moment the
 * game is on itch.io (`html.itch.zone/html/<id>/`), on a GitHub Pages project
 * site, or in any `unzip into a folder` deploy. The failure is a white page
 * with no message. So this harness serves the build from `/games/demo/` and
 * refuses to pass if anything is fetched from the server root.
 *
 * Also covers: the themed loading screen, the build quality preset actually
 * reaching the running engine as a ceiling, and the live-preview reload
 * client noticing a finished rebuild.
 *
 * Usage: npm run smoke:build   (needs `npm run build:player` first)
 */
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import {
  themePlayerHtml,
  injectLivePreviewClient,
  PREVIEW_REVISION_PATH,
} from "../src/editor/build/playerHtml.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const template = path.join(root, "dist-player");
const out = path.join(root, ".tmp-build-smoke");
// Served from a subdirectory on purpose — see the header.
const MOUNT = "/games/demo/";

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

// --- Stage a build ----------------------------------------------------------
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

const startScene = {
  version: 1,
  name: "Level1",
  // What the exporter writes into scene.json.
  player: {
    title: "Subpath Test",
    // Deliberately the cheapest preset, so its effect on a scene authored at
    // full quality is unambiguous.
    quality: "low",
    saveId: "subpath-test",
    saveVersion: 1,
    startScene: "scenes/Level1.scene",
  },
  // Authored at full quality — the preset has to clamp this on the way in.
  settings: {
    shadows: true,
    performance: { maxDevicePixelRatio: 2, renderScale: 1, volumeStepScale: 1, dynamicResolution: false },
  },
  entities: [
    entity("box", "Box", { components: [{ type: "mesh", props: { geometry: "box" } }] }),
    entity("cam", "Camera", { components: [{ type: "camera", props: {} }] }),
  ],
};
const level2 = {
  version: 1,
  name: "Level2",
  // A second level authored *cheaper* than the preset allows. The ceiling must
  // not raise it back up when this scene loads.
  settings: { performance: { renderScale: 0.4, maxDevicePixelRatio: 1 } },
  entities: [entity("cam2", "Camera 2", { components: [{ type: "camera", props: {} }] })],
};

await rm(out, { recursive: true, force: true });
await cp(template, out, { recursive: true });

// The exporter's own HTML rewrite, run on the real template.
const themed = themePlayerHtml(await readFile(path.join(template, "index.html"), "utf8"), {
  title: "Subpath Test",
  icon: "icon.png",
  loading: { background: "#2b0b0b", accent: "#ff5533", showTitle: true, showLogo: false },
});
await writeFile(path.join(out, "index.html"), themed);
await writeFile(path.join(out, "scene.json"), JSON.stringify(startScene));
await mkdir(path.join(out, "scenes"), { recursive: true });
await writeFile(path.join(out, "scenes", "Level2.scene"), JSON.stringify(level2));

// --- Serve it under a subpath ------------------------------------------------
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".scene": "application/json",
  ".css": "text/css",
  ".wasm": "application/wasm",
};
/** Anything requested outside the mount point — i.e. an absolute URL that
 *  assumed the game owns the domain root. */
const escapedRequests = [];
const server = createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  if (!url.startsWith(MOUNT)) {
    // Answer honestly (404) and record it: this is exactly what itch.io does.
    escapedRequests.push(url);
    res.writeHead(404).end("not found");
    return;
  }
  const rel = url.slice(MOUNT.length) || "index.html";
  try {
    const body = await readFile(path.join(out, rel));
    res.writeHead(200, { "Content-Type": MIME[path.extname(rel)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(0, r));
const url = `http://localhost:${server.address().port}${MOUNT}`;

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
  // Read the served HTML directly: the tab title and the loading colours are
  // baked in, and must be right BEFORE any script has run.
  const rawHtml = await (await fetch(url)).text();
  check("the tab title is in the served HTML, not set by script", rawHtml.includes("<title>Subpath Test</title>"));
  check("the loading colours are baked in", rawHtml.includes("--loading-bg:#2b0b0b"), "");
  check("the bundle is referenced relatively", /src="\.\/_engine\//.test(rawHtml), rawHtml.match(/src="[^"]*"/)?.[0] ?? "no script tag");

  await page.goto(url, { waitUntil: "load", timeout: 60000 });

  // The loading screen is live before the engine is.
  const loadingStyle = await page.evaluate(() => {
    const el = document.getElementById("loading");
    if (!el) return null;
    const s = getComputedStyle(el);
    const fill = document.querySelector(".loading-bar-fill");
    return {
      background: s.backgroundColor,
      accent: fill ? getComputedStyle(fill).backgroundColor : null,
      title: document.querySelector(".loading-title")?.textContent ?? null,
      logo: !!document.querySelector(".loading-logo"),
    };
  });
  check("the loading screen wears the build's background", loadingStyle?.background === "rgb(43, 11, 11)", String(loadingStyle?.background));
  check("and its accent colour", loadingStyle?.accent === "rgb(255, 85, 51)", String(loadingStyle?.accent));
  check("the game title is on the loading screen", loadingStyle?.title === "Subpath Test", String(loadingStyle?.title));
  check("the logo stays off when disabled", loadingStyle?.logo === false);

  const booted = await page
    .waitForFunction(() => globalThis.__engine?.playing === true, { timeout: 45000 })
    .then(() => true)
    .catch(() => false);
  check("a build served from a subdirectory boots", booted, booted ? "" : `nothing was served outside ${MOUNT}? ${escapedRequests.length === 0}`);
  if (!booted) throw new Error("player never reached playing state");

  // THE check this harness exists for.
  check(
    "nothing was fetched from the server root",
    escapedRequests.length === 0,
    escapedRequests.slice(0, 3).join(", "),
  );

  const first = await page.evaluate(() => {
    const e = globalThis.__engine;
    return {
      names: [...e.entities.values()].map((x) => x.name).sort(),
      quality: e.config.quality,
      renderScale: e.settings.performance.renderScale,
      dpr: e.settings.performance.maxDevicePixelRatio,
      dynamic: e.settings.performance.dynamicResolution,
      shadows: e.settings.shadows,
      title: document.title,
    };
  });
  check("the scene built", first.names.join(",") === "Box,Camera", first.names.join(","));
  check("the build's quality preset reached the engine", first.quality === "low", String(first.quality));
  check("it clamped render scale below what the scene authored", first.renderScale < 1, String(first.renderScale));
  check("it clamped the pixel ratio", first.dpr === 1, String(first.dpr));
  check("it turned dynamic resolution on", first.dynamic === true);
  check("it turned shadows off", first.shadows === false);
  check("the page title survives boot", first.title === "Subpath Test", first.title);

  // A level authored cheaper than the preset must not be raised by it — the
  // ceiling has to keep being a ceiling across a runtime scene change.
  const second = await page.evaluate(async () => {
    await globalThis.__engine.loadScene("scenes/Level2.scene");
    const e = globalThis.__engine;
    return {
      scene: e.sceneName,
      renderScale: e.settings.performance.renderScale,
      dpr: e.settings.performance.maxDevicePixelRatio,
    };
  });
  check("a relative scene path resolves under the subpath", second.scene === "Level2", String(second.scene));
  check(
    "a scene authored cheaper than the preset is left alone",
    second.renderScale === 0.4,
    String(second.renderScale),
  );
  check("and its own pixel-ratio choice stands", second.dpr === 1, String(second.dpr));

  // Frames are still being produced — a black canvas would otherwise pass
  // every check above.
  const rendered = await page.evaluate(async () => {
    let ticks = 0;
    globalThis.__engine.onUpdate(() => ticks++);
    await new Promise((r) => setTimeout(r, 400));
    return { ticks, backend: globalThis.__engine.getBackendName?.() };
  });
  check("the render loop is running", rendered.ticks > 0, `${rendered.ticks} frames (${rendered.backend})`);

  const fatal = pageErrors.filter((m) => !/Preload failed|preload failed|icon\.png/i.test(m));
  check("no page errors", fatal.length === 0, fatal.slice(0, 2).join(" | "));

  // --- Live-preview reload client -------------------------------------------
  // The editor's rebuild loop rewrites the served files, but the open tab
  // (worst of all a phone across the room) keeps running the old build until
  // it reloads itself. Stage the same build the way a `livePreview` export
  // ships it and prove the injected client notices a finished rebuild.
  check("a release build carries no reload client", !rawHtml.includes("live-preview-client"));
  const REV_A = 1111;
  const REV_B = 2222;
  await writeFile(path.join(out, "index.html"), injectLivePreviewClient(themed, REV_A));
  await writeFile(path.join(out, PREVIEW_REVISION_PATH), JSON.stringify({ revision: REV_A }));
  const previewHtml = await (await fetch(url)).text();
  check("a live-preview build carries the client", previewHtml.includes("live-preview-client"));
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  const navigated = page
    .waitForNavigation({ waitUntil: "load", timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  // What the live rebuild loop does last on every export.
  await writeFile(path.join(out, PREVIEW_REVISION_PATH), JSON.stringify({ revision: REV_B }));
  check("a finished rebuild reloads the open page", await navigated);
  check(
    "the reloaded page is the served build",
    await page.evaluate(() => !!document.getElementById("live-preview-client")),
  );
} catch (error) {
  check("harness completed", false, error.message);
} finally {
  await browser.close();
  server.close();
  await rm(out, { recursive: true, force: true });
}

console.log(`\nBUILD-SMOKE ${fail ? "FAIL" : "PASS"} — ${pass}/${pass + fail} checks`);
process.exit(fail ? 1 : 0);
