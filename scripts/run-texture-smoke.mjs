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
/* 8 — the processing menus (phase 2)                                           */
/* -------------------------------------------------------------------------- */

const BLUE = [10, 10, 200, 255];
const readOther = async () => decodePng(new Uint8Array(fs.readFileSync(OTHER)));

/** Opens one of the Image / Adjust / Filter / Channels menus and picks an item. */
async function menuPick(menu, item) {
  const opened = await clickText(".texture-toolbar .toolbar-btn", menu);
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

  check("Cancel is offered", await clickText(".texture-dialog-actions .toolbar-btn", "Cancel"));
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
  check("Resize commits", await clickText(".texture-dialog-actions .toolbar-btn", "Resize"));
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
  check("Pack commits", await clickText(".texture-dialog-actions .toolbar-btn", "Pack"));
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

  const regionRows = await page.evaluate(() => document.querySelectorAll(".atlas-list .atlas-row").length);
  check("the atlas editor lists its regions", regionRows >= 3, String(regionRows));

  // Edit through the UI: set a nine-slice border and a pivot, save, read back.
  const edited = await page.evaluate(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    const rows = [...document.querySelectorAll(".atlas-grid4")];
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

  const bottomPivot = await clickText(".atlas-grid4 .toolbar-btn", "Bottom");
  check("the Bottom pivot preset is offered", bottomPivot);
  await settle(300);

  check("Save is offered once the atlas is dirty", await clickText(".atlas-editor .toolbar-btn", "Save"));
  await settle(800);

  const saved = JSON.parse(fs.readFileSync(atlasFile, "utf8"));
  const first = saved.regions[0];
  check("the nine-slice border round-tripped to disk", first.border.some((v) => v === 3), JSON.stringify(first.border));
  check("the pivot round-tripped to disk", first.pivot[1] === 1, JSON.stringify(first.pivot));

  // Unpack: every region back out as its own file.
  check("Export Sprites is offered", await clickText(".atlas-editor .toolbar-btn", "Export Sprites"));
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
  const toolbarTexts = await page.evaluate(() =>
    [...document.querySelectorAll(".texture-toolbar .toolbar-btn")].map((b) => b.textContent.trim()),
  );
  check(
    "a sheet with no atlas does not inherit the last one's",
    !toolbarTexts.includes("Sprites"),
    toolbarTexts.join(" | "),
  );
  check(
    "a lone sheet offers a way into slicing",
    await clickText(".texture-toolbar .toolbar-btn", "Slice into Sprites"),
    toolbarTexts.join(" | "),
  );
  await page.waitForSelector(".atlas-editor", { timeout: 20000 });
  check("it created the atlas and switched to Atlas mode", fs.existsSync(`${ROOT}/sprites/Walk.atlas`));
  await settle(600);

  // The Slice menu lives on the ATLAS toolbar, not the paint one.
  const openedSlice = await clickText(".atlas-editor .toolbar-btn", "Slice");
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

  // Six columns, one row — the shape of the sheet.
  await page.evaluate(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    const select = document.querySelector(".texture-dialog select");
    const nativeSelect = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
    nativeSelect.call(select, "count");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    setTimeout(() => {
      const numbers = [...document.querySelectorAll(".texture-dialog input[type=number]")];
      setter.call(numbers[0], "6");
      numbers[0].dispatchEvent(new Event("input", { bubbles: true }));
      setter.call(numbers[1], "1");
      numbers[1].dispatchEvent(new Event("input", { bubbles: true }));
    }, 0);
  });
  await settle(400);
  check("Slice commits", await clickText(".texture-dialog-actions .toolbar-btn", "Slice"));
  await settle(600);

  const rows = await page.evaluate(() => document.querySelectorAll(".atlas-list .atlas-row").length);
  check("the sheet was cut into one region per frame", rows >= frames, `${rows} rows`);

  check("Save is offered", await clickText(".atlas-editor .toolbar-btn", "Save"));
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
    // Tick the component directly at a known dt rather than waiting on frames:
    // this is about the animation's arithmetic, not the render loop's timing.
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

check("no page errors during the run", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

console.log(`\n${passed} passed, ${failed} failed`);
if (!process.env.KEEP) fs.rmSync(ROOT, { recursive: true, force: true });
await browser.close();
process.exit(failed ? 1 : 0);
