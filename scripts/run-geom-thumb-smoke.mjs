// Focused smoke: Assets-panel `.geom` thumbnails.
//
//   npx vite --port 5199 --strictPort
//   node scripts/run-geom-thumb-smoke.mjs [url]
//
// Verifies the shared offscreen renderer returns a PNG. The Assets-panel tile
// wiring is covered by run-geometry-ui-smoke (which already boots a live project).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";
import {
  encodeGeometryAsset,
  GEOMETRY_BINARY_VERSION,
} from "../src/engine/geometryAsset.js";

const url = process.argv[2] ?? "http://localhost:5199/";
const ROOT = path.join(os.tmpdir(), "geom-thumb-smoke").replaceAll("\\", "/");

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

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, "geometries"), { recursive: true });
fs.mkdirSync(path.join(ROOT, "scenes"), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, "project.json"),
  JSON.stringify({ name: "GeomThumbSmoke", version: 1, lastScene: "scenes/Main.scene", modules: [] }, null, 2),
);
fs.writeFileSync(
  path.join(ROOT, "scenes", "Main.scene"),
  JSON.stringify({
    version: 1,
    name: "Main",
    settings: { background: "#202329", ambientColor: "#ffffff", ambientIntensity: 0.6, shadows: false },
    entities: [],
  }, null, 2),
);

const positions = [];
const normals = [];
const indices = [];
const face = (corners, n) => {
  const base = positions.length / 3;
  for (const c of corners) {
    positions.push(...c);
    normals.push(...n);
  }
  indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
};
face([[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]], [0, 0, 1]);
face([[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]], [0, 0, -1]);
face([[-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5]], [-1, 0, 0]);
face([[0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5]], [1, 0, 0]);
face([[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]], [0, 1, 0]);
face([[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5]], [0, -1, 0]);
const bytes = encodeGeometryAsset({
  version: GEOMETRY_BINARY_VERSION,
  positions,
  indices,
  normals,
  uvs: null,
  attributes: {},
  morphAttributes: {},
  morphTargetsRelative: false,
  groups: [],
});
const geomPath = path.join(ROOT, "geometries", "Cube.geom").replaceAll("\\", "/");
fs.writeFileSync(geomPath, Buffer.from(bytes));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
await installTauriShim(page, { writableRoot: ROOT });
page.on("pageerror", (e) => console.log(`  pageerror: ${e.message}`));

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

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")]
    .find((b) => b.textContent?.includes("Skip the project"))
    ?.click();
});
await settle(3500);

// Engine + asset resolver must be up before loadGeometryAsset can fetch.
await page.evaluate(async () => {
  const { ensureEngine } = await globalThis.__importLive("/src/editor/engineInstance.js");
  await ensureEngine();
});

const api = await page.evaluate(async ({ geomPath }) => {
  const { requestGeometryThumb } = await globalThis.__importLive("/src/editor/geometryThumb.js");
  const url = await requestGeometryThumb(geomPath);
  return {
    ok: typeof url === "string" && url.startsWith("data:image/png"),
    bytes: url?.length ?? 0,
    head: typeof url === "string" ? url.slice(0, 30) : String(url),
  };
}, { geomPath });
check("requestGeometryThumb returns a PNG data URL", api.ok, `${api.bytes} chars · ${api.head}`);

// Coalesce: a second request for the same path must not re-render.
const cached = await page.evaluate(async ({ geomPath }) => {
  const { requestGeometryThumb } = await globalThis.__importLive("/src/editor/geometryThumb.js");
  const t0 = performance.now();
  const url = await requestGeometryThumb(geomPath);
  return { ms: performance.now() - t0, ok: !!url };
}, { geomPath });
check("a cached thumb resolves quickly", cached.ok && cached.ms < 50, `${cached.ms.toFixed(1)}ms`);

console.log(`\n${passed} passed, ${failed} failed`);
await browser.close();
if (!process.env.KEEP) fs.rmSync(ROOT, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
