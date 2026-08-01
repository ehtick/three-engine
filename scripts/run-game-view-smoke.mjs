/**
 * Game view panel (src/editor/panels/GamePanel.jsx + viewportCanvas.js).
 *
 * There is exactly ONE WebGPU renderer and one canvas; the Game panel shows it
 * by taking ownership rather than by building a second renderer. Nothing about
 * that is testable headlessly — it is DOM ownership, letterboxing arithmetic
 * against a live layout, and a renderer that must survive being reparented
 * mid-frame. So this drives the real editor in Chrome.
 *
 * What it is really guarding: the canvas ends up in exactly one place, the
 * viewport gets it back on Stop (with its aspect box cleared — an inline
 * letterbox style would otherwise stick forever), an aspect preset changes the
 * RENDERED size and not just the CSS box, and the renderer keeps producing
 * frames through every handover.
 *
 * Needs a vite dev server: `node scripts/run-game-view-smoke.mjs http://localhost:5202/`
 */
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5201/";
let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}   ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

// A bare `import()` would load a SECOND copy of the module graph (with its own
// Engine and its own canvas-arbiter state). Reuse the URL the browser actually
// fetched — see run-editor-ui-smoke.mjs.
await page.evaluateOnNewDocument(() => {
  globalThis.__importLive = (path) => {
    const prefix = location.origin + path;
    const fetched = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
    return import(/* @vite-ignore */ live ?? path);
  };
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  for (let i = 0; i < 40; i++) {
    const ready = await page.evaluate(() => {
      if (globalThis.__viewport?.orbit) return true;
      [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
      return !!globalThis.__viewport?.orbit;
    });
    if (ready) break;
    await sleep(500);
  }
  await sleep(2000);

  // A scene with a camera, so Play has something to look through.
  await page.evaluate(async () => {
    const { ensureEngine } = await globalThis.__importLive("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    globalThis.__engine = engine;
    engine.clear({ resetSettings: false });
    const box = engine.createEntity({ name: "Box" });
    box.addComponent("mesh", { geometry: "box" });
    const cam = engine.createEntity({ name: "Main Camera" });
    cam.position = [0, 2, 6];
    cam.addComponent("camera", {});
    globalThis.__ticks = 0;
    engine.onUpdate(() => globalThis.__ticks++);
  });

  const openGame = async () => {
    await page.evaluate(async () => {
      const { openPanel } = await globalThis.__importLive("/src/editor/EditorShell.jsx");
      openPanel("game");
    });
    await sleep(1200);
  };

  // ---- the panel opens ------------------------------------------------------
  await openGame();
  check("the Game panel opens", (await page.$(".game-panel")) !== null);
  check(
    "it shows a placeholder while stopped, rather than stealing the idle viewport",
    (await page.$(".game-placeholder")) !== null,
  );
  check("the canvas is still in the viewport", await page.evaluate(() =>
    document.querySelector(".viewport-canvas")?.closest(".viewport-panel") !== null,
  ));

  // ---- play hands the canvas over ------------------------------------------
  await page.evaluate(async () => {
    const { play } = await globalThis.__importLive("/src/editor/playMode.js");
    await play();
  });
  await sleep(1500);

  const onPlay = await page.evaluate(() => {
    const canvas = document.querySelector(".viewport-canvas");
    return {
      canvases: document.querySelectorAll("canvas.viewport-canvas").length,
      inStage: !!canvas?.closest(".game-stage"),
      placeholder: !!document.querySelector(".game-placeholder"),
    };
  });
  check("the canvas moved into the game stage on Play", onPlay.inStage);
  check("there is still exactly ONE renderer canvas", onPlay.canvases === 1, String(onPlay.canvases));
  check("the placeholder went away", onPlay.placeholder === false);

  const ticking = await page.evaluate(async () => {
    const before = globalThis.__ticks;
    await new Promise((r) => setTimeout(r, 600));
    return { before, after: globalThis.__ticks };
  });
  check(
    "the renderer survived being reparented and keeps producing frames",
    ticking.after > ticking.before,
    `${ticking.before} → ${ticking.after}`,
  );

  // ---- aspect presets change the RENDERED size -----------------------------
  const pickAspect = async (label) => {
    await page.evaluate((wanted) => {
      const toolbar = document.querySelector(".game-toolbar");
      const trigger = [...toolbar.querySelectorAll("button")].find((b) => /Aspect|:|×/.test(b.textContent ?? ""));
      trigger?.click();
      queueMicrotask(() => {
        const item = [...document.querySelectorAll(".dropdown-item")].find((b) =>
          b.textContent?.trim().startsWith(wanted),
        );
        item?.click();
      });
    }, label);
    await sleep(900);
  };

  const sizeOf = () =>
    page.evaluate(() => {
      const canvas = document.querySelector(".viewport-canvas");
      const stage = document.querySelector(".game-stage");
      return {
        backing: [canvas.width, canvas.height],
        css: [Math.round(stage.clientWidth), Math.round(stage.clientHeight)],
      };
    });

  const free = await sizeOf();
  await pickAspect("9:16");
  const portrait = await sizeOf();
  check(
    "a portrait preset really renders a portrait frame (not a CSS-squashed landscape one)",
    portrait.css[1] > portrait.css[0] && portrait.backing[1] > portrait.backing[0],
    `css ${portrait.css.join("×")}, backing ${portrait.backing.join("×")}`,
  );
  check(
    "the backing store followed the letterbox, so the renderer really resized",
    portrait.backing[0] !== free.backing[0],
    `${free.backing.join("×")} → ${portrait.backing.join("×")}`,
  );
  const ratio = portrait.css[0] / portrait.css[1];
  check("the 9:16 box holds its ratio", Math.abs(ratio - 9 / 16) < 0.02, ratio.toFixed(3));

  await pickAspect("4:3");
  const fourThree = await sizeOf();
  const r43 = fourThree.css[0] / fourThree.css[1];
  check("switching presets re-letterboxes", Math.abs(r43 - 4 / 3) < 0.02, r43.toFixed(3));

  const stillTicking = await page.evaluate(async () => {
    const before = globalThis.__ticks;
    await new Promise((r) => setTimeout(r, 600));
    return globalThis.__ticks > before;
  });
  check("the renderer survived the resizes too", stillTicking);

  // ---- stop hands it back, un-letterboxed ---------------------------------
  await page.evaluate(async () => {
    const { stop } = await globalThis.__importLive("/src/editor/playMode.js");
    await stop();
  });
  await sleep(1500);

  // Viewport and Game are tabbed in one group, and dockview UNMOUNTS the
  // inactive tab — so on Stop there is no viewport container to hand the canvas
  // back to yet. The canvas must be PARKED (detached), not left sitting behind
  // the Game panel's "press Play" placeholder showing a live editor view.
  const onStop = await page.evaluate(() => ({
    parked: document.querySelector("canvas.viewport-canvas") === null,
    placeholder: !!document.querySelector(".game-placeholder"),
  }));
  check("Stop parks the canvas instead of leaving it behind the placeholder", onStop.parked);
  check("the Game panel is back to its placeholder", onStop.placeholder);

  // Now do what a user does: click back to the Viewport tab.
  await page.evaluate(async () => {
    const { openPanel } = await globalThis.__importLive("/src/editor/EditorShell.jsx");
    openPanel("viewport");
  });
  await sleep(1200);

  const backInViewport = await page.evaluate(() => {
    const canvas = document.querySelector(".viewport-canvas");
    const panel = canvas?.closest(".viewport-panel");
    return {
      inViewport: !!panel,
      inlineWidth: canvas?.style.width ?? "",
      inlineHeight: canvas?.style.height ?? "",
      fills: panel ? Math.abs(canvas.clientWidth - panel.clientWidth) < 2 : false,
    };
  });
  check("returning to the Viewport tab hands the canvas back", backInViewport.inViewport);
  check(
    "the game's inline letterbox size was cleared (or the viewport keeps 4:3 forever)",
    backInViewport.inlineWidth === "" && backInViewport.inlineHeight === "",
    `w="${backInViewport.inlineWidth}" h="${backInViewport.inlineHeight}"`,
  );
  check("...and the canvas fills the viewport again", backInViewport.fills);

  // ---- closing the Game panel mid-play must not blank the game ------------
  await openGame();
  await page.evaluate(async () => {
    const { play } = await globalThis.__importLive("/src/editor/playMode.js");
    await play();
  });
  await sleep(1200);
  check("playing again re-claims the stage", await page.evaluate(() =>
    !!document.querySelector(".viewport-canvas")?.closest(".game-stage"),
  ));

  await page.evaluate(async () => {
    const { closePanel } = await globalThis.__importLive("/src/editor/EditorShell.jsx");
    closePanel?.("game");
  });
  await sleep(1200);
  const afterClose = await page.evaluate(() => ({
    canvases: document.querySelectorAll("canvas.viewport-canvas").length,
    inViewport: !!document.querySelector(".viewport-canvas")?.closest(".viewport-panel"),
  }));
  check(
    "closing the Game tab mid-play returns the picture to the viewport",
    afterClose.inViewport,
  );
  check("still exactly one canvas", afterClose.canvases === 1, String(afterClose.canvases));

  const finalTicks = await page.evaluate(async () => {
    const before = globalThis.__ticks;
    await new Promise((r) => setTimeout(r, 600));
    return globalThis.__ticks > before;
  });
  check("and the game is still running", finalTicks);

  await page.evaluate(async () => {
    const { stop } = await globalThis.__importLive("/src/editor/playMode.js");
    await stop();
  });

  const fatal = pageErrors.filter((m) => !/WebGPU|GPUAdapter|deprecat|ResizeObserver/i.test(m));
  check("no page errors", fatal.length === 0, fatal.slice(0, 2).join(" | "));
} catch (error) {
  fail++;
  console.error("  FAIL   harness threw");
  console.error(`         ${error.stack ?? error.message}`);
} finally {
  await browser.close();
}

console.log(`\nGAME-VIEW-SMOKE ${fail ? "FAIL" : "PASS"} — ${pass}/${pass + fail} checks`);
process.exit(fail ? 1 : 0);
