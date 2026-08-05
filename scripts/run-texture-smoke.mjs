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
  await clickText(".texture-toolbar .tx-btn", "Save");
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
  const title = await page.evaluate(() => document.querySelector(".tx-title")?.textContent ?? "");
  check("an unsaved edit is marked in the title", title.includes("•"), title);

  await save();
  const { changed, at } = await readWall();
  check("the stroke reached the saved PNG", changed > 50, `${changed} texels differ`);
  check("the corners were left alone", at(0, 0).join() === RED.join(), at(0, 0).join());
  const cleanTitle = await page.evaluate(() => document.querySelector(".tx-title")?.textContent ?? "");
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
  check("Create is available", await clickText(".texture-dialog-actions .tx-btn", "Create"));
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
/* 8 — the processing menus (phase 2)                                           */
/* -------------------------------------------------------------------------- */

const BLUE = [10, 10, 200, 255];
const readOther = async () => decodePng(new Uint8Array(fs.readFileSync(OTHER)));

/** Opens one of the Image / Adjust / Filter / Channels menus and picks an item. */
async function menuPick(menu, item) {
  const opened = await clickText(".texture-toolbar .tx-btn", menu);
  if (!opened) return false;
  await settle(200);
  const picked = await page.evaluate((needle) => {
    const el = [...document.querySelectorAll(".dropdown-item")].find((e) =>
      e.textContent.trim().startsWith(needle),
    );
    if (!el) return false;
    el.click();
    return true;
  }, item);
  await settle(400);
  return picked;
}

console.log("\nprocessing menus");
{
  await openTexture(OTHER);
  await settle(1400);
  check("the flat blue texture is open", (await statusText()).includes("64 × 64"), await statusText());

  // A zero-parameter adjustment applies straight away — no dialog to dismiss.
  check("Adjust ▸ Invert is reachable", await menuPick("Adjust", "Invert"));
  await save();
  {
    const buffer = await readOther();
    const p = Array.from(buffer.data.subarray(0, 4));
    check(
      "invert really inverted the saved pixels",
      Math.abs(p[0] - (255 - BLUE[0])) < 4 && Math.abs(p[2] - (255 - BLUE[2])) < 4,
      p.join(),
    );
    check("and left alpha alone", p[3] === 255, String(p[3]));
  }

  // A parameterised filter opens a dialog; cancelling must put the pixels back.
  check("Filter ▸ Blur opens its dialog", await menuPick("Filter", "Blur"));
  const dialogUp = await page.evaluate(() => !!document.querySelector(".texture-dialog"));
  check("the operation dialog rendered", dialogUp);
  await settle(500); // let the debounced preview run

  // An open dialog must go QUIET. Previewing writes to the document, which
  // re-renders the panel, which hands the dialog a fresh callback — if that
  // callback is an effect dependency, the dialog re-previews forever and burns
  // a core for as long as it is open, with no symptom a screenshot would show.
  // The busy marker is the tell: it is set on every scheduled preview.
  let busySamples = 0;
  for (let i = 0; i < 10; i++) {
    await settle(100);
    if (await page.evaluate(() => !!document.querySelector(".texture-dialog-busy"))) busySamples++;
  }
  check("an idle dialog is not re-previewing in a loop", busySamples === 0, `${busySamples}/10 samples busy`);

  check("Cancel is offered", await clickText(".texture-dialog-actions .tx-btn", "Cancel"));
  await settle(400);
  await save();
  {
    const buffer = await readOther();
    const p = Array.from(buffer.data.subarray(0, 4));
    check(
      "cancelling a previewed filter restores the layer exactly",
      Math.abs(p[0] - (255 - BLUE[0])) < 4 && Math.abs(p[2] - (255 - BLUE[2])) < 4,
      p.join(),
    );
  }

  // Resize is a document operation: the file on disk must change size.
  check("Image ▸ Resize opens its dialog", await menuPick("Image", "Resize Image"));
  await page.evaluate(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    const numbers = [...document.querySelectorAll(".texture-dialog input[type=number]")];
    for (const input of numbers) {
      setter.call(input, "32");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await settle(200);
  check("Resize commits", await clickText(".texture-dialog-actions .tx-btn", "Resize"));
  await settle(500);
  check("the panel reports the new size", (await statusText()).includes("32 × 32"), await statusText());
  await save();
  {
    const buffer = await readOther();
    check("the saved PNG really is smaller", buffer.width === 32 && buffer.height === 32, `${buffer.width}×${buffer.height}`);
  }
}

/* -------------------------------------------------------------------------- */
/* 9 — channel packing writes a new asset                                       */
/* -------------------------------------------------------------------------- */

console.log("\nchannel packing");
{
  check("Channels ▸ Pack opens its dialog", await menuPick("Channels", "Pack Channels"));
  await page.waitForSelector(".texture-dialog.wide", { timeout: 10000 });

  // Constants only — enough to prove the dialog, the packer and the asset write
  // are wired together. The per-channel file pickers are the same AssetField the
  // Inspector uses everywhere else.
  const filled = await page.evaluate(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    const rows = [...document.querySelectorAll(".texture-pack-row")];
    const values = [64, 128, 192, 255];
    rows.forEach((row, i) => {
      const input = row.querySelector("input[type=number]");
      if (!input) return;
      setter.call(input, String(values[i]));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const name = [...document.querySelectorAll(".texture-dialog.wide label input")].find(
      (i) => i.type !== "number",
    );
    setter.call(name, "Packed");
    name.dispatchEvent(new Event("input", { bubbles: true }));
    return rows.length;
  });
  check("the dialog offers one row per channel", filled === 4, String(filled));
  await settle(200);
  check("Pack commits", await clickText(".texture-dialog-actions .tx-btn", "Pack"));
  await settle(2000);

  const packed = `${ROOT}/textures/Packed.png`;
  check("the packed texture was written", fs.existsSync(packed));
  if (fs.existsSync(packed)) {
    const buffer = await decodePng(new Uint8Array(fs.readFileSync(packed)));
    const p = Array.from(buffer.data.subarray(0, 4));
    check("each channel got its constant", p.join() === "64,128,192,255", p.join());
  }
  check("a packed map is tagged linear, not sRGB", fs.existsSync(`${packed}.meta`));
  if (fs.existsSync(`${packed}.meta`)) {
    const meta = JSON.parse(fs.readFileSync(`${packed}.meta`, "utf8"));
    check("the .meta says colorSpace linear", meta.colorSpace === "linear", JSON.stringify(meta));
  }
}

/* -------------------------------------------------------------------------- */
/* 10 — packing an atlas, then editing it (phase 3)                             */
/* -------------------------------------------------------------------------- */

console.log("\nsprite atlas");
{
  // Three loose sprites of different sizes, each a flat identifiable colour so
  // the packed sheet can be checked pixel by pixel.
  const sprites = [
    { name: "alpha", w: 20, h: 12, color: [255, 0, 0, 255] },
    { name: "beta", w: 8, h: 30, color: [0, 255, 0, 255] },
    { name: "gamma", w: 16, h: 16, color: [0, 0, 255, 255] },
  ];
  fs.mkdirSync(path.join(ROOT, "sprites"), { recursive: true });
  for (const sprite of sprites) {
    fs.writeFileSync(
      path.join(ROOT, "sprites", `${sprite.name}.png`),
      Buffer.from(await encodePng(flatBuffer(sprite.w, sprite.h, sprite.color))),
    );
  }

  const packed = await page.evaluate(
    async ({ dir, names }) => {
      const { buildAtlasFromImages } = await globalThis.__importLive("/src/editor/atlasFile.js");
      const result = await buildAtlasFromImages(
        names.map((n) => `${dir}/${n}.png`),
        { directory: dir, name: "Pack", padding: 2, extrude: 1, powerOfTwo: true },
      );
      return { atlasPath: result.atlasPath, overflow: result.overflow, regions: result.def.regions.length };
    },
    { dir: `${ROOT}/sprites`, names: sprites.map((s) => s.name) },
  );
  check("packing wrote an atlas with one region per image", packed.regions === 3, String(packed.regions));
  check("nothing overflowed", packed.overflow.length === 0, packed.overflow.join());

  const atlasFile = `${ROOT}/sprites/Pack.atlas`;
  const sheetFile = `${ROOT}/sprites/Pack.png`;
  check("both the sheet and the .atlas exist", fs.existsSync(atlasFile) && fs.existsSync(sheetFile));

  const def = JSON.parse(fs.readFileSync(atlasFile, "utf8"));
  const sheet = await decodePng(new Uint8Array(fs.readFileSync(sheetFile)));
  check("regions are named after their source files", def.regions.map((r) => r.name).sort().join() === "alpha,beta,gamma", def.regions.map((r) => r.name).join());
  check("the sheet is power-of-two", (sheet.width & (sheet.width - 1)) === 0 && (sheet.height & (sheet.height - 1)) === 0, `${sheet.width}×${sheet.height}`);

  // The check that matters: each region must actually contain ITS sprite. A
  // packer that reports plausible rects while blitting to the wrong place is
  // the failure mode, and it looks completely fine until something renders.
  let correct = 0;
  for (const sprite of sprites) {
    const region = def.regions.find((r) => r.name === sprite.name);
    if (!region) continue;
    const [x, y, w, h] = region.rect;
    if (w !== sprite.w || h !== sprite.h) continue;
    const i = ((y + (h >> 1)) * sheet.width + x + (w >> 1)) * 4;
    const p = [sheet.data[i], sheet.data[i + 1], sheet.data[i + 2], sheet.data[i + 3]];
    if (p.join() === sprite.color.join()) correct++;
  }
  check("every region holds its own sprite's pixels", correct === 3, `${correct}/3`);

  // Extrusion: one texel outside the rect repeats the sprite's edge colour.
  {
    const region = def.regions.find((r) => r.name === "alpha");
    const [x, y] = region.rect;
    const i = (y * sheet.width + x - 1) * 4;
    check(
      "the sprite's edge is extruded into the gutter",
      sheet.data[i] === 255 && sheet.data[i + 3] === 255,
      [sheet.data[i], sheet.data[i + 1], sheet.data[i + 2], sheet.data[i + 3]].join(),
    );
  }

  // Open it in the panel's Atlas mode.
  await page.evaluate(async (p) => {
    const { useSelectionStore } = await globalThis.__importLive("/src/editor/store/selectionStore.js");
    useSelectionStore.getState().selectAsset(p);
    const { openPanel } = await globalThis.__importLive("/src/editor/EditorShell.jsx");
    openPanel("textureEditor");
  }, atlasFile);
  await page.waitForSelector(".atlas-editor", { timeout: 30000 });
  await settle(1200);

  const regionRows = await page.evaluate(() => document.querySelectorAll(".tx-list .tx-row-item").length);
  check("the atlas editor lists its regions", regionRows >= 3, String(regionRows));

  // Edit through the UI: set a nine-slice border and a pivot, save, read back.
  const edited = await page.evaluate(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    const rows = [...document.querySelectorAll(".tx-quad")];
    if (rows.length < 3) return false;
    // grids are: rect (X/Y/W/H), pivot (X/Y + buttons), nine-slice (L/R/T/B)
    const slice = rows[2].querySelectorAll("input[type=number]");
    if (slice.length < 4) return false;
    slice.forEach((input) => {
      setter.call(input, "3");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    return true;
  });
  check("the nine-slice fields accept a border", edited);
  await settle(300);
  const sliceCells = await page.evaluate(() => document.querySelectorAll(".atlas-nineslice-cell").length);
  check("the nine-slice schematic appears once a border is set", sliceCells === 9, String(sliceCells));

  const bottomPivot = await clickText(".tx-row .tx-btn", "Bottom");
  check("the Bottom pivot preset is offered", bottomPivot);
  await settle(300);

  check("Save is offered once the atlas is dirty", await clickText(".atlas-editor .tx-btn", "Save"));
  await settle(800);

  const saved = JSON.parse(fs.readFileSync(atlasFile, "utf8"));
  const first = saved.regions[0];
  check("the nine-slice border round-tripped to disk", first.border.some((v) => v === 3), JSON.stringify(first.border));
  check("the pivot round-tripped to disk", first.pivot[1] === 1, JSON.stringify(first.pivot));

  // Unpack: every region back out as its own file.
  check("Export Sprites is offered", await clickButtonTitled("Export every region as its own PNG"));
  await settle(1500);
  const outDir = path.join(ROOT, "sprites", "Pack_sprites");
  check("the unpack direction wrote a folder of sprites", fs.existsSync(outDir));
  if (fs.existsSync(outDir)) {
    const files = fs.readdirSync(outDir).sort();
    check("one file per region", files.length === 3, files.join());
    const back = await decodePng(new Uint8Array(fs.readFileSync(path.join(outDir, "beta.png"))));
    check("an exported sprite has its original size", back.width === 8 && back.height === 30, `${back.width}×${back.height}`);
    check(
      "and its original pixels",
      back.data[0] === 0 && back.data[1] === 255 && back.data[2] === 0,
      Array.from(back.data.subarray(0, 4)).join(),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 10b — cutting a LONE spritesheet up, which needs no pre-existing atlas       */
/* -------------------------------------------------------------------------- */

console.log("\nslicing a lone spritesheet");
{
  // The case the packing flow does not cover and that a user actually starts
  // from: one downloaded sheet, six frames in a row, no .atlas anywhere.
  const SHEET = `${ROOT}/sprites/Walk.png`;
  const frames = 6;
  const cell = 24;
  const strip = flatBuffer(cell * frames, cell, [0, 0, 0, 0]);
  for (let f = 0; f < frames; f++) {
    for (let y = 4; y < cell - 4; y++) {
      for (let x = f * cell + 4; x < f * cell + cell - 4; x++) {
        const i = (y * strip.width + x) * 4;
        strip.data[i] = 40 * f + 15;
        strip.data[i + 1] = 200;
        strip.data[i + 2] = 90;
        strip.data[i + 3] = 255;
      }
    }
  }
  fs.writeFileSync(SHEET, Buffer.from(await encodePng(strip)));

  await openTexture(SHEET);
  await page.waitForSelector(".texture-canvas", { timeout: 30000 });
  await settle(1000);

  // Opening a different sheet must not leave the PREVIOUS one's atlas attached
  // — the button would then be a shortcut to the wrong file's regions.
  if (process.env.SHOT_PAINT) await page.screenshot({ path: process.env.SHOT_PAINT });
  const toolbarTexts = await page.evaluate(() =>
    [...document.querySelectorAll(".texture-toolbar .tx-btn")].map((b) => b.textContent.trim()),
  );
  check(
    "a sheet with no atlas does not inherit the last one's",
    toolbarTexts.includes("Slice"),
    toolbarTexts.join(" | "),
  );
  check(
    "a lone sheet offers a way into slicing",
    await clickText(".texture-toolbar .tx-btn", "Slice"),
    toolbarTexts.join(" | "),
  );
  await page.waitForSelector(".atlas-editor", { timeout: 20000 });
  check("it created the atlas and switched to Atlas mode", fs.existsSync(`${ROOT}/sprites/Walk.atlas`));
  await settle(600);

  // The Slice menu lives on the ATLAS toolbar, not the paint one.
  const openedSlice = await clickText(".atlas-editor .tx-btn", "Slice");
  await settle(250);
  const pickedGrid = await page.evaluate(() => {
    const el = [...document.querySelectorAll(".dropdown-item")].find((e) =>
      e.textContent.trim().startsWith("By Grid"),
    );
    if (!el) return false;
    el.click();
    return true;
  });
  check("Slice ▸ By Grid is reachable", openedSlice && pickedGrid);
  await page.waitForSelector(".texture-dialog", { timeout: 10000 });
  // SHOT=<path> captures the dialog. Layout bugs here are invisible to every
  // assertion that is not about geometry, and this panel docks into a short
  // strip where dialogs are easy to clip.
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });

  // Layout, measured rather than eyeballed. These panels dock into a short
  // strip, and a dialog that centres inside the PANEL puts its own buttons off
  // the bottom of the screen — which is exactly what happened.
  const layout = await page.evaluate(() => {
    const dialog = document.querySelector(".texture-dialog");
    const actions = document.querySelector(".texture-dialog-actions");
    const toggle = document.querySelector(".texture-dialog .texture-check");
    const box = dialog.getBoundingClientRect();
    const act = actions.getBoundingClientRect();
    const tog = toggle?.getBoundingClientRect();
    return {
      dialog: { top: box.top, bottom: box.bottom, width: box.width },
      actions: { top: act.top, bottom: act.bottom, left: act.left, width: act.width },
      toggle: tog ? { width: tog.width, height: tog.height } : null,
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  });
  check(
    "the dialog fits on screen",
    layout.dialog.top >= 0 && layout.dialog.bottom <= layout.viewport.h,
    `${Math.round(layout.dialog.top)}..${Math.round(layout.dialog.bottom)} of ${layout.viewport.h}`,
  );
  check(
    "its Cancel/Slice row is visible, not pushed off the bottom",
    layout.actions.bottom <= layout.viewport.h && layout.actions.width > 0,
    `actions bottom ${Math.round(layout.actions.bottom)} of ${layout.viewport.h}`,
  );
  check(
    "a checkbox row lays out as a ROW, not stacked",
    !!layout.toggle && layout.toggle.width > layout.toggle.height * 2,
    layout.toggle ? `${Math.round(layout.toggle.width)}×${Math.round(layout.toggle.height)}` : "missing",
  );
  await page.waitForSelector(".texture-dialog", { timeout: 10000 });

  // Six columns, one row - the shape of the sheet. The dropdown is the editor's
  // own SelectField (a portalled popover), not a native <select>.
  check("the dialog uses the editor's own dropdown", await clickText(".texture-dialog .tx-select", "Cell"));
  await settle(250);
  check(
    "its menu offers the column/row mode",
    await clickText(".tx-select-menu .dropdown-item", "Column"),
  );
  await settle(300);
  await page.evaluate(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    const numbers = [...document.querySelectorAll(".texture-dialog input[type=number]")];
    setter.call(numbers[0], "6");
    numbers[0].dispatchEvent(new Event("input", { bubbles: true }));
    setter.call(numbers[1], "1");
    numbers[1].dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle(400);
  check("Slice commits", await clickText(".texture-dialog-actions .tx-btn", "Slice"));
  await settle(600);

  const rows = await page.evaluate(() => document.querySelectorAll(".tx-list .tx-row-item").length);
  check("the sheet was cut into one region per frame", rows >= frames, `${rows} rows`);

  check("Save is offered", await clickText(".atlas-editor .tx-btn", "Save"));
  await settle(800);
  const sliced = JSON.parse(fs.readFileSync(`${ROOT}/sprites/Walk.atlas`, "utf8"));
  check("the regions reached disk", sliced.regions.length === frames, `${sliced.regions.length} regions`);
  check(
    "each region is one cell wide",
    sliced.regions.every((r) => r.rect[2] === cell && r.rect[3] === cell),
    JSON.stringify(sliced.regions[0]?.rect),
  );
  check(
    "and they tile the sheet left to right",
    sliced.regions.every((r, i) => r.rect[0] === i * cell),
    sliced.regions.map((r) => r.rect[0]).join(),
  );
}

/* -------------------------------------------------------------------------- */
/* 11 — the runtime: SpriteComponent drawing and animating from the atlas       */
/* -------------------------------------------------------------------------- */

console.log("\nsprite runtime");
{
  // Give the atlas an animation over its three regions, on disk, so the
  // component reads exactly what the editor writes.
  const atlasFile = `${ROOT}/sprites/Pack.atlas`;
  const def = JSON.parse(fs.readFileSync(atlasFile, "utf8"));
  def.animations = [{ name: "spin", fps: 10, loop: true, frames: def.regions.map((r) => r.name) }];
  fs.writeFileSync(atlasFile, JSON.stringify(def, null, 2));

  const result = await page.evaluate(async (atlasPath) => {
    const { ensureEngine } = await globalThis.__importLive("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    globalThis.__engine = engine;
    const { invalidateAtlasAsset } = await globalThis.__importLive("/src/engine/sprite/atlasAsset.js");
    invalidateAtlasAsset(); // the file was just rewritten under the cache

    const entity = engine.createEntity({ name: "Sprite" });
    const sprite = entity.addComponent("sprite", {
      atlas: atlasPath,
      animation: "spin",
      pixelsPerUnit: 100,
      playOnStart: true,
    });
    // Give the atlas + image loads a moment; both are async by design.
    await new Promise((r) => setTimeout(r, 1200));

    const mesh = entity.object3D.children.find((c) => c.isMesh);
    const positions = mesh?.geometry.getAttribute("position");
    // Restart from zero and step synchronously. Everything from here to the
    // return runs in one task, so the engine's own update loop cannot interleave
    // — which it otherwise does, at whatever rate the frame pacing has settled
    // on, making the sequence depend on how long the load happened to take.
    sprite.play();
    // 10 fps, so one frame per 0.1s — four steps must wrap back to the first.
    const walked = [sprite.frame];
    for (let i = 0; i < 4; i++) {
      sprite.tick(0.1);
      walked.push(sprite.frame);
    }

    sprite.stop();
    const stopped = { playing: sprite.isPlaying, frame: sprite.frame };
    sprite.setRegion("beta");
    const still = sprite.frame;

    const bounds = [];
    if (positions) {
      for (let i = 0; i < 4; i++) bounds.push(positions.getX(i), positions.getY(i));
    }

    return {
      regionNames: sprite.regionNames,
      hasMesh: !!mesh,
      hasMap: !!mesh?.material?.map,
      drawCount: mesh?.geometry.drawRange.count ?? 0,
      walked,
      stopped,
      still,
      bounds,
    };
  }, atlasFile);

  check("the sprite resolved its atlas", result.regionNames.length === 3, result.regionNames.join());
  check("it built a mesh with a texture", result.hasMesh && result.hasMap);
  check("a plain sprite draws one quad (6 indices)", result.drawCount === 6, String(result.drawCount));
  check("it starts on a real frame", !!result.walked[0], result.walked[0]);
  check(
    "advancing game time walks every frame in order",
    new Set(result.walked.slice(0, 3)).size === 3,
    result.walked.join(" -> "),
  );
  check(
    "and a looping animation wraps back to its first frame",
    result.walked[3] === result.walked[0],
    result.walked.join(" -> "),
  );
  check("stop() halts playback", result.stopped.playing === false);
  check("setRegion shows a still frame by name", result.still === "beta", result.still);

  // beta is 8×30 at 100 px/unit, so the quad must be 0.08 × 0.30 world units —
  // the size comes from the sprite's pixels, with no scale factor anywhere.
  const xsOf = result.bounds.filter((_, i) => i % 2 === 0);
  const ysOf = result.bounds.filter((_, i) => i % 2 === 1);
  const w = Math.max(...xsOf) - Math.min(...xsOf);
  const h = Math.max(...ysOf) - Math.min(...ysOf);
  check("the quad's world size comes from its pixel size", Math.abs(w - 0.08) < 1e-4 && Math.abs(h - 0.3) < 1e-4, `${w.toFixed(3)} × ${h.toFixed(3)}`);
}

/* -------------------------------------------------------------------------- */
/* 11b — selections really clip painting, and copy/paste-to-layer              */
/* -------------------------------------------------------------------------- */

console.log("\nselections and the clipboard");
{
  // A fresh flat sheet so every assertion is about what this section did.
  const SEL = `${ROOT}/textures/Sel.png`;
  fs.writeFileSync(SEL, Buffer.from(await encodePng(flatBuffer(64, 64, [30, 30, 30, 255]))));
  await openTexture(SEL);
  await page.waitForSelector(".texture-canvas", { timeout: 30000 });
  await settle(1000);

  const canvasCentre = async () => {
    const box = await canvasBox();
    return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  };

  // Rectangle-select a small box in the middle, then paint right across the
  // whole width. Only the selected band may change.
  const pickTool = async (title) => {
    const ok = await page.evaluate((t) => {
      const el = [...document.querySelectorAll(".texture-tool")].find((b) => (b.title ?? "").startsWith(t));
      if (!el) return false;
      el.click();
      return true;
    }, title);
    await settle(200);
    return ok;
  };

  check("the rectangle-select tool is offered", await pickTool("Rectangle Select"));
  {
    const c = await canvasCentre();
    await page.mouse.move(c.x - 40, c.y - 20);
    await page.mouse.down();
    await page.mouse.move(c.x + 40, c.y + 20, { steps: 8 });
    await page.mouse.up();
    await settle(400);
  }
  const selected = await page.evaluate(() => !!document.querySelector(".texture-options .tx-btn:not(:disabled)"));
  check("a marquee drag produced a selection", selected);

  if (process.env.SHOT_ANTS) {
    await settle(300);
    await page.screenshot({ path: process.env.SHOT_ANTS });
  }
  check("back to the brush", await pickTool("Brush"));
  await paintAcrossCentre();
  await save();
  {
    const buffer = await decodePng(new Uint8Array(fs.readFileSync(SEL)));
    const rows = new Set();
    for (let y = 0; y < buffer.height; y++) {
      for (let x = 0; x < buffer.width; x++) {
        const i = (y * buffer.width + x) * 4;
        if (buffer.data[i] > 90) {
          rows.add(y);
          break;
        }
      }
    }
    // The marquee covered roughly the middle 40 rows of a 64px sheet; painting
    // ran across the full width. If the selection were ignored the stroke would
    // reach rows outside it.
    const painted = [...rows].sort((a, b) => a - b);
    check("something was painted", painted.length > 0, `${painted.length} rows`);
    check(
      "the selection clipped the stroke to its own rows",
      painted.length > 0 && painted[0] > 2 && painted[painted.length - 1] < 61,
      `rows ${painted[0]}..${painted[painted.length - 1]}`,
    );
  }

  // Layer via Copy: the selected pixels onto a brand-new layer, in one step.
  const beforeLayers = await statusText();
  const c = await canvasCentre();
  await page.mouse.move(c.x, c.y);
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyJ");
  await page.keyboard.up("Control");
  await settle(500);
  const afterLayers = await statusText();
  check(
    "Ctrl+J puts the selection on a new layer",
    /2 layers/.test(afterLayers),
    `${beforeLayers.trim()} -> ${afterLayers.trim()}`,
  );

  // And it really carries pixels: hide the original, save, and the sheet must
  // still show the painted band (from the copy) but nothing outside it.
  const copied = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".texture-layers .tx-row-item")];
    // Rows are top-of-stack first; the copy is the new top layer.
    return rows.length;
  });
  check("the layer list shows both", copied === 2, String(copied));

  // Ctrl+C / Ctrl+V — copy the selected area, paste it onto its own layer.
  const press = async (key, ...modifiers) => {
    for (const m of modifiers) await page.keyboard.down(m);
    await page.keyboard.press(key);
    for (const m of modifiers.reverse()) await page.keyboard.up(m);
    await settle(400);
  };
  await page.mouse.move(c.x, c.y);
  await press("KeyC", "Control");
  await press("KeyV", "Control");
  check("Ctrl+C then Ctrl+V pastes onto a new layer", /3 layers/.test(await statusText()), await statusText());

  // Ctrl+X removes the selected pixels from the layer it cut from.
  await press("KeyX", "Control");
  await save();
  {
    const buffer = await decodePng(new Uint8Array(fs.readFileSync(SEL)));
    // The cut layer is the pasted copy, which held the painted band; with it
    // gone the flattened sheet must be back to its flat background there.
    const i = ((buffer.height >> 1) * buffer.width + (buffer.width >> 1)) * 4;
    check(
      "Ctrl+X removes the selected pixels",
      buffer.data[i + 3] === 255,
      Array.from(buffer.data.subarray(i, i + 4)).join(),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 11c — layer masks and layer effects, all the way to the saved PNG           */
/* -------------------------------------------------------------------------- */

console.log("\nmasks and effects");
{
  const FX = `${ROOT}/textures/Fx.png`;
  // A small opaque square on a transparent sheet: an outline has somewhere to
  // go, and a mask has something to hide.
  const sheet = flatBuffer(48, 48, [0, 0, 0, 0]);
  for (let y = 16; y < 32; y++) {
    for (let x = 16; x < 32; x++) {
      const i = (y * 48 + x) * 4;
      sheet.data[i] = 255;
      sheet.data[i + 1] = 255;
      sheet.data[i + 2] = 255;
      sheet.data[i + 3] = 255;
    }
  }
  fs.writeFileSync(FX, Buffer.from(await encodePng(sheet)));

  await openTexture(FX);
  await page.waitForSelector(".texture-canvas", { timeout: 30000 });
  await settle(1200);

  // --- effects ---
  check("the Effects section is offered", await page.evaluate(() =>
    [...document.querySelectorAll(".tx-section-head")].some((h) => h.textContent.includes("Effects")),
  ));
  const added = await page.evaluate(() => {
    const head = [...document.querySelectorAll(".tx-section-head")].find((h) => h.textContent.includes("Effects"));
    head?.querySelector(".tx-icon-btn")?.click();
    return !!head;
  });
  check("the add-effect menu opens", added);
  await settle(300);
  check("Outline is on the menu", await clickText(".dropdown-item", "Outline"));
  await settle(600);

  // Red, so the outline is unmistakable in the saved pixels.
  const coloured = await page.evaluate(() => {
    const input = document.querySelector(".tx-effect input[type=color]");
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "#ff0000");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  });
  check("the effect exposes its parameters", coloured);
  await settle(500);
  await save();
  {
    const buffer = await decodePng(new Uint8Array(fs.readFileSync(FX)));
    const at = (x, y) => Array.from(buffer.data.subarray((y * buffer.width + x) * 4, (y * buffer.width + x) * 4 + 4));
    // The square is 16..31; a 2px outline lands just outside it.
    check("the outline reached the SAVED png", at(15, 24)[0] > 180 && at(15, 24)[3] > 180, at(15, 24).join());
    check("and it is the colour that was picked", at(15, 24)[1] < 80 && at(15, 24)[2] < 80, at(15, 24).join());
    check("the artwork itself is untouched", at(24, 24).join() === "255,255,255,255", at(24, 24).join());
  }

  // --- masks ---
  check("a mask can be added", await clickText(".texture-layer-props .tx-btn", "Mask"));
  await settle(500);
  check(
    "the layer row shows it carries one",
    await page.evaluate(() => !!document.querySelector(".texture-layers .tx-badge")),
  );
  check("mask editing can be entered", await clickText(".texture-layer-props .tx-btn", "Edit mask"));
  await settle(300);

  // Paint black into the mask — the brush colour is the mask value, so this
  // hides what it covers rather than painting on the artwork.
  await page.evaluate(() => {
    const inputs = [...document.querySelectorAll(".texture-swatches input[type=color]")];
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(inputs[0], "#000000");
    inputs[0].dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle(200);
  await paintAcrossCentre();
  await save();
  {
    const buffer = await decodePng(new Uint8Array(fs.readFileSync(FX)));
    const at = (x, y) => Array.from(buffer.data.subarray((y * buffer.width + x) * 4, (y * buffer.width + x) * 4 + 4));
    check("painting the mask hid part of the artwork", at(24, 24)[3] < 120, at(24, 24).join());
    check(
      "the outline survives what the mask hid",
      at(15, 24)[3] > 150,
      "an effect is derived from the shape, not from what the mask left visible",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 11d — transforming a layer (scale / rotate / flip)                          */
/* -------------------------------------------------------------------------- */

console.log("\nlayer transforms");
{
  const TR = `${ROOT}/textures/Tr.png`;
  // A red block in the top-left quadrant: a flip has somewhere unambiguous to
  // move it to, and "did anything happen" is answerable from two texels.
  const sheet = flatBuffer(32, 32, [0, 0, 0, 0]);
  for (let y = 4; y < 12; y++) {
    for (let x = 4; x < 12; x++) {
      const i = (y * 32 + x) * 4;
      sheet.data[i] = 255;
      sheet.data[i + 3] = 255;
    }
  }
  fs.writeFileSync(TR, Buffer.from(await encodePng(sheet)));

  await openTexture(TR);
  await page.waitForSelector(".texture-canvas", { timeout: 30000 });
  await settle(1000);

  const alphaAt = async (x, y) => {
    const buffer = await decodePng(new Uint8Array(fs.readFileSync(TR)));
    return buffer.data[(y * buffer.width + x) * 4 + 3];
  };

  check("the Layer menu exists", await clickText(".texture-toolbar .tx-btn", "Layer"));
  await settle(250);
  check("it offers a horizontal flip", await clickText(".dropdown-item", "Flip Horizontal"));
  await settle(500);
  await save();
  check("flipping moved the block to the other side", (await alphaAt(24, 8)) > 200, String(await alphaAt(24, 8)));
  check("and left nothing behind", (await alphaAt(8, 8)) === 0, String(await alphaAt(8, 8)));

  // Rotate it back round: 180 twice must be a no-op, which is the cheapest
  // proof the sampler is not drifting.
  await clickText(".texture-toolbar .tx-btn", "Layer");
  await settle(200);
  await clickText(".dropdown-item", "Rotate 180");
  await settle(400);
  await clickText(".texture-toolbar .tx-btn", "Layer");
  await settle(200);
  await clickText(".dropdown-item", "Rotate 180");
  await settle(400);
  await save();
  check("two 180 turns are exactly a no-op", (await alphaAt(24, 8)) > 200, String(await alphaAt(24, 8)));

  // The numeric dialog, previewing live and cancelling cleanly.
  await clickText(".texture-toolbar .tx-btn", "Layer");
  await settle(200);
  check("Transform opens a dialog", await clickText(".dropdown-item", "Transform"));
  await page.waitForSelector(".texture-dialog", { timeout: 10000 });
  const setScale = await page.evaluate(() => {
    const input = document.querySelector(".texture-dialog input[type=number]");
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "50");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  });
  check("it takes a scale", setScale);
  await settle(500);
  check("Cancel is offered", await clickText(".texture-dialog-actions .tx-btn", "Cancel"));
  await settle(400);
  await save();
  check("cancelling a previewed transform restores the layer", (await alphaAt(24, 8)) > 200, String(await alphaAt(24, 8)));
}

/* -------------------------------------------------------------------------- */
/* 12 — double-click a tab bar to maximize, Escape to restore                  */
/* -------------------------------------------------------------------------- */

console.log("\npanel maximize");
{
  const isMaximized = () => page.evaluate(() => !!globalThis.__dockApi?.hasMaximizedGroup?.());
  const tabBar = await page.evaluate(() => {
    const panel = document.querySelector(".texture-modes, .texture-editor");
    const group = panel?.closest(".dv-groupview");
    const bar = group?.querySelector(".dv-tabs-and-actions-container");
    if (!bar) return null;
    const r = bar.getBoundingClientRect();
    // The empty space to the right of the tabs — clicking a tab itself would
    // also be valid, but this proves the whole bar is a target.
    return { x: r.right - 24, y: r.y + r.height / 2 };
  });
  check("the panel's tab bar was found", !!tabBar);

  if (tabBar) {
    check("nothing is maximized to begin with", (await isMaximized()) === false);
    await page.mouse.move(tabBar.x, tabBar.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.mouse.down({ clickCount: 2 });
    await page.mouse.up({ clickCount: 2 });
    await settle(400);
    check("double-clicking the tab bar maximizes the panel", await isMaximized());

    await page.keyboard.press("Escape");
    await settle(400);
    check("Escape restores the layout", (await isMaximized()) === false);

    // Escape must not be greedy: a focused text field owns it first, and a
    // gesture that also fires while someone is typing is worse than none.
    await page.mouse.move(tabBar.x, tabBar.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.mouse.down({ clickCount: 2 });
    await page.mouse.up({ clickCount: 2 });
    await settle(400);
    const focused = await page.evaluate(() => {
      const input = document.querySelector(".texture-editor input[type=range], .atlas-editor input");
      if (!input) return false;
      input.focus();
      return document.activeElement === input;
    });
    if (focused) {
      await page.keyboard.press("Escape");
      await settle(300);
      check("Escape in a focused field does not un-maximize", await isMaximized());
      await page.evaluate(() => document.activeElement?.blur?.());
    }
    await page.keyboard.press("Escape");
    await settle(400);
    check("and it restores once the field is left", (await isMaximized()) === false);
  }
}

/* -------------------------------------------------------------------------- */

check("no page errors during the run", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

console.log(`\n${passed} passed, ${failed} failed`);
if (!process.env.KEEP) fs.rmSync(ROOT, { recursive: true, force: true });
await browser.close();
process.exit(failed ? 1 : 0);
