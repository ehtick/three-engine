// The Texture Editor panel, driven through the REAL editor.
//
// `npm run test:texture` proves the image core is correct. It cannot prove the
// thing that actually decides whether this feature works: that painting on a
// canvas reaches the layer, that Save writes a PNG the rest of the engine can
// read, and — the one that would quietly destroy work — that a document saved
// with layers comes BACK with those layers the next time the file is opened.
// A sidecar that writes correctly and reads back as a single flattened layer
// looks fine until the second editing session.
//
//   npx vite --port 5216
//   node scripts/run-texture-smoke.mjs [url]
//
// Env: HEADED=1 to watch, KEEP=1 to leave the scratch project behind.
//
// START THE DEV SERVER FRESH — see run-editor-ui-smoke.mjs on Vite's `?t=`
// module twins.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { encodePng, decodePng } from "../src/editor/texture/png.js";
import { decodeTexDoc } from "../src/editor/texture/texdoc.js";

const url = process.argv[2] ?? "http://localhost:5216/";
const ROOT = path.join(os.tmpdir(), "texture-ui-smoke").replaceAll("\\", "/");
const WALL = `${ROOT}/textures/Wall.png`;
const OTHER = `${ROOT}/textures/Other.png`;

let passed = 0;
let failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
};
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------------------------- */
/* scratch project: two flat-red textures and a scene to boot into              */
/* -------------------------------------------------------------------------- */

const SIZE = 64;
const RED = [220, 30, 30, 255];

function flatBuffer(width, height, rgba) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgba[0];
    data[i * 4 + 1] = rgba[1];
    data[i * 4 + 2] = rgba[2];
    data[i * 4 + 3] = rgba[3];
  }
  return { width, height, data };
}

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, "scenes"), { recursive: true });
fs.mkdirSync(path.join(ROOT, "textures"), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, "project.json"),
  JSON.stringify(
    { name: "TextureSmoke", version: 1, lastScene: "scenes/Main.scene", modules: ["texture-editor"] },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(ROOT, "scenes", "Main.scene"),
  JSON.stringify(
    {
      version: 1,
      name: "Main",
      settings: { background: "#202329", ambientColor: "#ffffff", ambientIntensity: 0.6, shadows: false },
      entities: [{ id: "root", name: "Root", components: [] }],
    },
    null,
    2,
  ),
);
fs.writeFileSync(WALL, Buffer.from(await encodePng(flatBuffer(SIZE, SIZE, RED))));
fs.writeFileSync(OTHER, Buffer.from(await encodePng(flatBuffer(SIZE, SIZE, [10, 10, 200, 255]))));

/** Reads the saved PNG back and reports how far it is from pristine red. */
async function readWall() {
  const buffer = await decodePng(new Uint8Array(fs.readFileSync(WALL)));
  let changed = 0;
  for (let i = 0; i < buffer.width * buffer.height; i++) {
    const d = i * 4;
    if (
      Math.abs(buffer.data[d] - RED[0]) > 6 ||
      Math.abs(buffer.data[d + 1] - RED[1]) > 6 ||
      Math.abs(buffer.data[d + 2] - RED[2]) > 6
    ) {
      changed++;
    }
  }
  const at = (x, y) => Array.from(buffer.data.subarray((y * buffer.width + x) * 4, (y * buffer.width + x) * 4 + 4));
  return { buffer, changed, at };
}

/* -------------------------------------------------------------------------- */

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
await installTauriShim(page, { writableRoot: ROOT });

const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.stack ?? e.message));
page.on("console", (m) => {
  if (m.type() === "error" && !/404|Failed to load resource/.test(m.text())) pageErrors.push(m.text());
});

await page.evaluateOnNewDocument(() => {
  globalThis.__importLive = (p) => {
    const prefix = location.origin + p;
    const fetched = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
    return import(/* @vite-ignore */ live ?? p);
  };
});

await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.evaluate(
  async ({ ROOT }) => {
    const { useProjectStore } = await globalThis.__importLive("/src/editor/store/projectStore.js");
    await useProjectStore.getState().openProject(ROOT);
    const { openScenePath } = await globalThis.__importLive("/src/editor/sceneIO.js");
    await openScenePath(`${ROOT}/scenes/Main.scene`);
  },
  { ROOT },
);
await settle(3000);

const openTexture = async (target) => {
  await page.evaluate(async (p) => {
    const { useSelectionStore } = await globalThis.__importLive("/src/editor/store/selectionStore.js");
    useSelectionStore.getState().selectAsset(p);
    const { openPanel } = await globalThis.__importLive("/src/editor/EditorShell.jsx");
    openPanel("textureEditor");
  }, target);
};

await openTexture(WALL);
await page.waitForSelector(".texture-editor", { timeout: 30000 });
await page.waitForSelector(".texture-canvas", { timeout: 30000 });
await settle(900);

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

const statusText = () =>
  page.evaluate(() => document.querySelector(".texture-status")?.textContent ?? "");

const canvasBox = () =>
  page.evaluate(() => {
    const r = document.querySelector(".texture-canvas").getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });

/** Drags a short stroke through the middle of the view. The document is fitted
 *  and centred, so the middle of the canvas is the middle of the texture at
 *  whatever zoom the panel settled on — no coordinate maths to get wrong. */
async function paintAcrossCentre(offset = 0) {
  const box = await canvasBox();
  const cx = box.x + box.w / 2 + offset;
  const cy = box.y + box.h / 2 + offset;
  await page.mouse.move(cx - 20, cy);
  await page.mouse.down();
  for (let i = -20; i <= 20; i += 4) {
    await page.mouse.move(cx + i, cy);
    await settle(16);
  }
  await page.mouse.up();
  await settle(250);
}

const clickButtonTitled = async (title) => {
  const ok = await page.evaluate((t) => {
    const el = [...document.querySelectorAll("button")].find((b) => b.title === t);
    if (!el) return false;
    el.click();
    return true;
  }, title);
  await settle(300);
  return ok;
};

const clickText = async (selector, needle) => {
  const ok = await page.evaluate(
    (sel, n) => {
      const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().includes(n));
      if (!el) return false;
      el.click();
      return true;
    },
    selector,
    needle,
  );
  await settle(400);
  return ok;
};

const save = async () => {
  await clickText(".texture-toolbar .toolbar-btn", "Save");
  await settle(700);
};

/* -------------------------------------------------------------------------- */
/* 1 — the panel opens the texture                                              */
/* -------------------------------------------------------------------------- */

console.log("\nopening");
{
  const status = await statusText();
  check("the panel reports the texture's real size", status.includes(`${SIZE} × ${SIZE}`), status);
  check("a plain PNG opens as a single layer", status.includes("1 layer"), status);
  check("no page errors while mounting", pageErrors.length === 0, pageErrors[0] ?? "");
}

/* -------------------------------------------------------------------------- */
/* 2 — painting reaches the pixels, and Save writes them                        */
/* -------------------------------------------------------------------------- */

console.log("\npainting and saving");
{
  await paintAcrossCentre();
  const title = await page.evaluate(() => document.querySelector(".texture-title")?.textContent ?? "");
  check("an unsaved edit is marked in the title", title.includes("•"), title);

  await save();
  const { changed, at } = await readWall();
  check("the stroke reached the saved PNG", changed > 50, `${changed} texels differ`);
  check("the corners were left alone", at(0, 0).join() === RED.join(), at(0, 0).join());
  const cleanTitle = await page.evaluate(() => document.querySelector(".texture-title")?.textContent ?? "");
  check("saving clears the dirty marker", !cleanTitle.includes("•"), cleanTitle);
}

/* -------------------------------------------------------------------------- */
/* 3 — undo really rewinds the pixels, not just the UI                          */
/* -------------------------------------------------------------------------- */

console.log("\nundo");
{
  await clickButtonTitled("Undo (Ctrl+Z)");
  await save();
  const { changed } = await readWall();
  check("undo restored the image exactly", changed === 0, `${changed} texels still differ`);

  await clickButtonTitled("Redo (Ctrl+Shift+Z)");
  await save();
  const after = await readWall();
  check("redo puts the stroke back", after.changed > 50, `${after.changed} texels differ`);
}

/* -------------------------------------------------------------------------- */
/* 4 — layers survive the round trip through disk                               */
/* -------------------------------------------------------------------------- */

console.log("\nlayers and the .tex sidecar");
{
  check("a new layer can be added", await clickButtonTitled("New layer"));
  await settle(300);
  check("the status counts both layers", (await statusText()).includes("2 layers"), await statusText());

  await paintAcrossCentre(0);

  // Half-opacity on the top layer: the value has to survive the sidecar, and
  // it also proves the flatten applies it rather than storing it and forgetting.
  const setOpacity = await page.evaluate(() => {
    const input = document.querySelector(".texture-layer-props input[type=range]");
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "0.5");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  });
  check("the layer opacity slider is present", setOpacity);
  await settle(300);
  await save();

  const sidecar = `${WALL}.tex`;
  check("a .tex sidecar was written beside the image", fs.existsSync(sidecar));
  if (fs.existsSync(sidecar)) {
    const doc = await decodeTexDoc(new Uint8Array(fs.readFileSync(sidecar)), { decodePng });
    check("the sidecar holds both layers", doc.layers.length === 2, `${doc.layers.length} layers`);
    check(
      "the top layer's opacity round-tripped",
      Math.abs((doc.layers[1]?.opacity ?? 1) - 0.5) < 0.02,
      String(doc.layers[1]?.opacity),
    );
    check("the sidecar's size matches the image", doc.width === SIZE && doc.height === SIZE);
  }
}

/* -------------------------------------------------------------------------- */
/* 5 — reopening restores the layers (the failure that costs a session's work)  */
/* -------------------------------------------------------------------------- */

console.log("\nreopening");
{
  await openTexture(OTHER);
  await settle(1200);
  check("switching textures loads the other one", (await statusText()).includes("1 layer"), await statusText());

  await openTexture(WALL);
  await settle(1400);
  const status = await statusText();
  check("reopening restores the saved layer stack", status.includes("2 layers"), status);
}

/* -------------------------------------------------------------------------- */
/* 6 — the sidecar is an implementation detail, not an asset                    */
/* -------------------------------------------------------------------------- */

console.log("\nasset listing");
{
  const names = await page.evaluate(async (dir) => {
    const loader = await globalThis.__importLive("/src/editor/assetLoader.js");
    // Through the editor's own wrapper — a bare specifier can't be imported
    // from an `evaluate` string, and Vite is what resolves it in the app.
    const { invoke } = await globalThis.__importLive("/src/editor/assetOps.js");
    const entries = await invoke("list_dir", { path: dir });
    return loader.withoutSidecars(entries).map((e) => e.name);
  }, `${ROOT}/textures`);
  check("the .tex sidecar is hidden from the Assets grid", !names.some((n) => n.endsWith(".tex")), names.join(", "));
  check("the image itself is still listed", names.includes("Wall.png"), names.join(", "));
}

/* -------------------------------------------------------------------------- */
/* 7 — creating a texture from scratch                                          */
/* -------------------------------------------------------------------------- */

console.log("\nnew texture");
{
  await page.evaluate(async (dir) => {
    const { useProjectStore } = await globalThis.__importLive("/src/editor/store/projectStore.js");
    await useProjectStore.getState().navigate(dir);
  }, `${ROOT}/textures`);
  await settle(400);

  await page.evaluate(async () => {
    const { requestNewTexture } = await globalThis.__importLive("/src/editor/textureEditorRequest.js");
    requestNewTexture();
  });
  await page.waitForSelector(".texture-dialog", { timeout: 10000 });

  await page.evaluate(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    const inputs = [...document.querySelectorAll(".texture-dialog input")];
    const name = inputs.find((i) => i.type === "text" || !i.type || i.type === "");
    const numbers = inputs.filter((i) => i.type === "number");
    setter.call(name, "Made");
    name.dispatchEvent(new Event("input", { bubbles: true }));
    for (const input of numbers) {
      setter.call(input, "32");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await settle(200);
  check("Create is available", await clickText(".texture-dialog-actions .toolbar-btn", "Create"));
  await settle(1500);

  const made = `${ROOT}/textures/Made.png`;
  check("the new texture exists on disk", fs.existsSync(made));
  if (fs.existsSync(made)) {
    const buffer = await decodePng(new Uint8Array(fs.readFileSync(made)));
    check("it has the requested size", buffer.width === 32 && buffer.height === 32, `${buffer.width}×${buffer.height}`);
    check("a transparent document really is transparent", buffer.data[3] === 0, String(buffer.data[3]));
  }
  check(
    "a brand-new flat document writes no pointless sidecar",
    !fs.existsSync(`${made}.tex`),
    "a one-layer document is exactly its PNG",
  );
}

/* -------------------------------------------------------------------------- */

check("no page errors during the run", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

console.log(`\n${passed} passed, ${failed} failed`);
if (!process.env.KEEP) fs.rmSync(ROOT, { recursive: true, force: true });
await browser.close();
process.exit(failed ? 1 : 0);
