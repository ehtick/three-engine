// MCP tools smoke: do the newer tool families actually run?
//
//   npx vite --port 5211 --strictPort
//   node scripts/run-mcp-tools-smoke.mjs [url]
//
// HEADED=1 to watch it run.
//
// `run-mcp-coverage-test.mjs` proves the tools EXIST and are described. That is
// a source scan, and a source scan cannot tell a working tool from one that
// throws on its first line — which is the failure mode a thin op wrapper
// actually has, because it is mostly a call into a module whose signature may
// have moved. So this drives them against a live editor with a real project
// open, and asserts on the files and scene state they claim to produce.
//
// Deliberately NOT covered here: anything that goes to the network (library
// searches and imports hit Poly Haven / ambientCG / Sketchfab / itch.io) or
// that takes minutes (build.export, compressAllTextures). Their gating,
// validation and status reporting are checked; the download itself is not
// something a test should do sixty times a day to somebody else's free API.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5211/";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-tools-"));
fs.writeFileSync(path.join(root, "project.json"), JSON.stringify({ name: "Tools", version: 1 }, null, 2));
fs.mkdirSync(path.join(root, "textures"), { recursive: true });

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
await installTauriShim(page, {
  writableRoot: root,
  verbose: !!process.env.VERBOSE,
  extraCommands: { watch_project: () => true, unwatch_project: () => null },
});

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.stack ?? e.message}`));

await page.goto(url, { waitUntil: "load", timeout: 45000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await wait(6000);

await page.evaluate(async (projectRoot) => {
  const importLive = (p) => {
    const prefix = location.origin + p;
    const fetched = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    return import(/* @vite-ignore */ (fetched.find((n) => n.includes("?")) ?? fetched[0]) ?? p);
  };
  globalThis.__importLive = importLive;
  const { ensureEngine } = await importLive("/src/editor/engineInstance.js");
  await ensureEngine();
  const { useProjectStore } = await importLive("/src/editor/store/projectStore.js");
  globalThis.__openDone = false;
  useProjectStore.getState().openProject(projectRoot).then(() => (globalThis.__openDone = true));
  globalThis.__call = async (tool, args = {}) => {
    const { callTool } = await importLive("/src/editor/api/registry.js");
    return callTool(tool, args);
  };
}, root.replaceAll("\\", "/"));

for (let i = 0; i < 60 && !(await page.evaluate(() => globalThis.__openDone === true)); i++) await wait(500);
check("the scratch project opens", await page.evaluate(() => globalThis.__openDone === true));

// --- the module gate is real ------------------------------------------------
//
// The project's module list is a statement about what the project uses. A tool
// that quietly worked through a disabled module would make "enabled" mean
// nothing — and would leave files from a module the project does not ship.

const gated = await page.evaluate(() =>
  globalThis.__call("texture_create", { directory: "x", name: "y.png" }),
);
check(
  "a tool refuses to work through a disabled module, and says which one",
  gated.ok === false && /texture-editor/.test(gated.error ?? ""),
  gated.error,
);

const enabled = await page.evaluate(() => globalThis.__call("module_setEnabled", { id: "texture-editor", enabled: true }));
check("module.setEnabled turns it on", enabled.ok === true, enabled.error ?? "");
await wait(600);

// --- textures ----------------------------------------------------------------

const effects = await page.evaluate(() => globalThis.__call("texture_effects"));
const effectList = effects.result ?? [];
check("texture.effects lists the panel's own registry", effectList.length >= 10, `${effectList.length} effects`);
check(
  "…with the parameters and ranges a caller needs to use them",
  effectList.some((e) => e.id === "levels" && e.params.some((p) => p.key === "gamma" && p.max !== undefined)),
);

const dir = `${root.replaceAll("\\", "/")}/textures`;
const created = await page.evaluate(
  (d) => globalThis.__call("texture_create", { directory: d, name: "Probe.png", width: 64, height: 32, background: "#804020" }),
  dir,
);
check("texture.create writes a new image", created.ok === true, created.error ?? "");
check("…to disk, not just to an open tab", fs.existsSync(path.join(root, "textures", "Probe.png")));

const info = await page.evaluate((d) => globalThis.__call("texture_info", { path: `${d}/Probe.png` }), dir);
check("texture.info reports its size", info.result?.width === 64 && info.result?.height === 32, JSON.stringify(info.result ?? info.error));

// Compared by CONTENT, not by size: inverting a flat colour produces a PNG of
// exactly the same length, so a length check here passes whether the pixels
// changed or not — which is the same as not checking.
const beforeBytes = fs.readFileSync(path.join(root, "textures", "Probe.png"));
const processed = await page.evaluate((d) => globalThis.__call("texture_process", { path: `${d}/Probe.png`, effect: "invert" }), dir);
check("texture.process applies an effect", processed.ok === true, processed.error ?? "");
const afterBytes = fs.readFileSync(path.join(root, "textures", "Probe.png"));
check("…and the pixels on disk really changed", !beforeBytes.equals(afterBytes), `${beforeBytes.length} -> ${afterBytes.length} bytes`);

const badEffect = await page.evaluate((d) => globalThis.__call("texture_process", { path: `${d}/Probe.png`, effect: "nope" }), dir);
check(
  "…and an unknown effect answers with the list instead of a stack trace",
  badEffect.ok === false && /Available:/.test(badEffect.error ?? ""),
  (badEffect.error ?? "").slice(0, 60),
);

// Probe.png is 64x32 here, so "fit into a 32x32 box" has a wrong answer (32x32)
// and a right one (32x16) — a square source could not tell them apart.
const fitted = await page.evaluate(
  (d) => globalThis.__call("texture_resizeMany", { paths: [`${d}/Probe.png`], width: 32, height: 32, mode: "fit" }),
  dir,
);
check(
  "texture.resizeMany fits inside the box without distorting",
  fitted.ok === true && fitted.result?.resized?.[0]?.width === 32 && fitted.result?.resized?.[0]?.height === 16,
  JSON.stringify(fitted.result ?? fitted.error),
);

const mixed = await page.evaluate(
  (d) => globalThis.__call("texture_resizeMany", { paths: [`${d}/Probe.png`, `${d}/Notes.txt`], scale: 100 }),
  dir,
);
check(
  "…and reports the files it skipped instead of silently dropping them",
  mixed.ok === true && mixed.result?.skipped?.length === 1 && mixed.result?.unchanged?.length === 1,
  JSON.stringify(mixed.result ?? mixed.error),
);

const resized = await page.evaluate((d) => globalThis.__call("texture_resize", { path: `${d}/Probe.png`, width: 32, height: 32 }), dir);
check("texture.resize resamples", resized.ok === true && resized.result?.width === 32, JSON.stringify(resized.result ?? resized.error));
const resizedInfo = await page.evaluate((d) => globalThis.__call("texture_info", { path: `${d}/Probe.png` }), dir);
check(
  "…and the file on disk is that size, not just the answer",
  resizedInfo.result?.width === 32 && resizedInfo.result?.height === 32,
  JSON.stringify(resizedInfo.result ?? resizedInfo.error),
);

const meta = await page.evaluate((d) => globalThis.__call("texture_setMeta", { path: `${d}/Probe.png`, colorSpace: "linear" }), dir);
check("texture.setMeta writes the colour-space flag", meta.ok === true, meta.error ?? "");
check(
  "…into the .meta sidecar the loader reads",
  fs.existsSync(path.join(root, "textures", "Probe.png.meta")) &&
    JSON.parse(fs.readFileSync(path.join(root, "textures", "Probe.png.meta"), "utf8")).colorSpace === "linear",
);

const second = await page.evaluate(
  (d) => globalThis.__call("texture_create", { directory: d, name: "Probe2.png", width: 32, height: 32, background: "#204080" }),
  dir,
);
const packed = await page.evaluate(
  (d) => globalThis.__call("texture_atlas_pack", { paths: [`${d}/Probe.png`, `${d}/Probe2.png`], name: "Sprites", directory: d }),
  dir,
);
check("texture.atlas.pack builds an atlas", second.ok === true && packed.ok === true, packed.error ?? "");
const atlasPath = `${dir}/Sprites.atlas`;
check("…writing the descriptor beside the packed image", fs.existsSync(path.join(root, "textures", "Sprites.atlas")));

const atlas = await page.evaluate((p) => globalThis.__call("texture_atlas_get", { path: p }), atlasPath);
check("texture.atlas.get reads the regions back", (atlas.result?.regions?.length ?? 0) === 2, JSON.stringify(atlas.result?.regions ?? atlas.error));

// --- authoring a texture from nothing ----------------------------------------
//
// "Create a texture" means building one up — layers, shapes, patterns — not
// only running filters over an image that already exists.

const authored = `${dir}/Authored.png`;
await page.evaluate((d) => globalThis.__call("texture_create", { directory: d, name: "Authored.png", width: 64, height: 64 }), dir);

const gen = await page.evaluate(
  (p) => globalThis.__call("texture_generate", { path: p, generator: "checker", size: 16, color: "#ffffff", colorTo: "#202020" }),
  authored,
);
check("texture.generate paints a checkerboard", gen.ok === true, gen.error ?? "");

const layered = await page.evaluate((p) => globalThis.__call("texture_addLayer", { path: p, name: "Detail" }), authored);
check("texture.addLayer adds a layer", layered.ok === true && layered.result?.index === 1, layered.error ?? "");

const drawn = await page.evaluate(
  (p) => globalThis.__call("texture_draw", { path: p, shape: "ellipse", rect: [8, 8, 48, 48], color: "#ff3300", layer: 1 }),
  authored,
);
check("texture.draw draws onto the layer it was told to", drawn.ok === true, drawn.error ?? "");

const gradient = await page.evaluate(
  (p) => globalThis.__call("texture_draw", { path: p, shape: "gradient", gradient: "radial", color: "#ffffff", colorTo: "#000000", opacity: 0.5, layer: 1 }),
  authored,
);
check("…and a gradient", gradient.ok === true, gradient.error ?? "");

const layerInfo = await page.evaluate((p) => globalThis.__call("texture_info", { path: p }), authored);
check(
  "texture.info reports the layer stack that produced the image",
  (layerInfo.result?.layers?.length ?? 0) === 2 && layerInfo.result.layers[1].name === "Detail",
  JSON.stringify(layerInfo.result?.layers?.map((l) => l.name)),
);

const opacity = await page.evaluate((p) => globalThis.__call("texture_setLayer", { path: p, layer: 1, opacity: 0.4 }), authored);
check("texture.setLayer changes the mix", opacity.ok === true && opacity.result?.opacity === 0.4, opacity.error ?? "");

const badShape = await page.evaluate((p) => globalThis.__call("texture_draw", { path: p, shape: "rect" }), authored);
check("…and a shape with no geometry says what is missing", badShape.ok === false && /rect/.test(badShape.error ?? ""), (badShape.error ?? "").slice(0, 60));

const dropped = await page.evaluate((p) => globalThis.__call("texture_removeLayer", { path: p, layer: 1 }), authored);
check("texture.removeLayer removes it", dropped.ok === true && dropped.result?.layers === 1, dropped.error ?? "");

// --- editing geometry ---------------------------------------------------------
//
// The session model: begin, select, operate, commit — the same sequence a person
// performs with Tab. Every operator below is checked by its effect on the mesh's
// element counts, because an operator that silently no-ops (wrong selection mode,
// a signature that moved) reports success just as happily as one that worked.

const cube = await page.evaluate(() =>
  globalThis.__call("entity_create", { name: "EditMe", components: [{ type: "mesh", props: { geometry: "box" } }] }),
);
check("a mesh entity to edit", cube.ok === true, cube.error ?? "");
const cubeId = cube.result?.id;

const noSession = await page.evaluate(() => globalThis.__call("geometry_edit", { operation: "extrude" }));
check(
  "an operator with no session says so instead of throwing from three layers down",
  noSession.ok === false && /beginEdit/.test(noSession.error ?? ""),
  (noSession.error ?? "").slice(0, 60),
);

const began = await page.evaluate((id) => globalThis.__call("geometry_beginEdit", { entityId: id }), cubeId);
check("geometry.beginEdit opens the mesh", began.ok === true, began.error ?? "");
check(
  "…decoded as a real polygon mesh, not a triangle soup",
  began.result?.statistics?.faces === 6 && began.result?.statistics?.quads === 6,
  JSON.stringify(began.result?.statistics),
);
check("…and forks a .geom asset to save into", typeof began.result?.path === "string", began.result?.path);

const operations = await page.evaluate(() => globalThis.__call("geometry_operations"));
check("geometry.operations lists the operators", (operations.result?.length ?? 0) >= 20, `${operations.result?.length} operators`);

const nothingSelected = await page.evaluate(() => globalThis.__call("geometry_edit", { operation: "bevel" }));
check(
  "an operator with an empty selection names the mode to select in",
  nothingSelected.ok === false && /geometry.select/.test(nothingSelected.error ?? ""),
  (nothingSelected.error ?? "").slice(0, 70),
);

const selectAll = await page.evaluate(() => globalThis.__call("geometry_select", { mode: "face", action: "all" }));
check("geometry.select selects every face", selectAll.result?.selected?.faces === 6, JSON.stringify(selectAll.result ?? selectAll.error));

const subdivided = await page.evaluate(() => globalThis.__call("geometry_edit", { operation: "subdivide", params: { cuts: 1 } }));
check(
  "subdivide really subdivides",
  subdivided.result?.after?.faces === 24,
  JSON.stringify({ before: subdivided.result?.before?.faces, after: subdivided.result?.after?.faces, error: subdivided.error }),
);

// A box selection over the top half — the kind of selection an agent can
// actually reason about, unlike element indices.
const topFaces = await page.evaluate(() =>
  globalThis.__call("geometry_select", { mode: "face", action: "box", min: [-2, 0.4, -2], max: [2, 2, 2] }),
);
check("box selection picks out a region by position", (topFaces.result?.selected?.faces ?? 0) > 0, JSON.stringify(topFaces.result ?? topFaces.error));

const extruded = await page.evaluate(() => globalThis.__call("geometry_edit", { operation: "extrude", params: { offset: 0.5 } }));
check(
  "extrude adds geometry",
  (extruded.result?.after?.verts ?? 0) > (extruded.result?.before?.verts ?? 0),
  JSON.stringify({ before: extruded.result?.before?.verts, after: extruded.result?.after?.verts, error: extruded.error }),
);

const inset = await page.evaluate(() => globalThis.__call("geometry_edit", { operation: "inset", params: { thickness: 0.1 } }));
check("inset runs with a thickness", inset.ok === true && (inset.result?.after?.faces ?? 0) > (inset.result?.before?.faces ?? 0), inset.error ?? "");

const nudged = await page.evaluate(() => globalThis.__call("geometry_transform", { translate: [0, 0.25, 0] }));
check("geometry.transform moves the selection", nudged.ok === true && (nudged.result?.moved ?? 0) > 0, nudged.error ?? "");

const shaded = await page.evaluate(() => globalThis.__call("geometry_edit", { operation: "recalculateNormals" }));
check("cleanup operators run too", shaded.ok === true, shaded.error ?? "");

const status = await page.evaluate(() => globalThis.__call("geometry_status"));
check("geometry.status reports the open session", status.result?.open === true && status.result?.entityId === cubeId, JSON.stringify(status.result));

const committed = await page.evaluate(() => globalThis.__call("geometry_commit"));
check("geometry.commit saves", committed.ok === true, committed.error ?? "");
const geomPath = committed.result?.path?.replace(root.replaceAll("\\", "/"), "");
check("…to the .geom asset on disk", !!geomPath && fs.existsSync(path.join(root, geomPath)), geomPath);
const savedGeom = geomPath ? JSON.parse(fs.readFileSync(path.join(root, geomPath), "utf8")) : null;
check("…carrying the edited mesh, not the original cube", (savedGeom?.positions?.length ?? savedGeom?.verts?.length ?? 0) > 24, Object.keys(savedGeom ?? {}).join(", "));

const afterCommit = await page.evaluate(() => globalThis.__call("geometry_status"));
check("…and closes the session", afterCommit.result?.open === false);

// --- post-process graphs (.post) ---------------------------------------------
//
// The graph used to be a blob inside the .scene, so "does this op work" and
// "did anything reach the disk" were the same question and neither was
// checkable. Now it is a document: every check below is against the FILE, plus
// the one thing a file can't show — that a live camera picked the change up.

const postGate = await page.evaluate((r) => globalThis.__call("post_create", { path: `${r}/Gated.post` }), root.replaceAll("\\", "/"));
check(
  "post.create refuses while the postprocessing module is off",
  postGate.ok === false && /postprocessing/.test(postGate.error ?? ""),
  (postGate.error ?? "").slice(0, 60),
);
check("…and writes nothing", !fs.existsSync(path.join(root, "Gated.post")));

await page.evaluate(() => globalThis.__call("module_setEnabled", { id: "postprocessing", enabled: true }));
await wait(600);

const postTypes = await page.evaluate(() => globalThis.__call("post_nodeTypes"));
const postNodes = postTypes.result?.nodes ?? [];
check("post.nodeTypes lists the node registry", postNodes.length >= 20, `${postNodes.length} types`);
check(
  "…with each param's default and whether it is a live uniform",
  postNodes.some((n) => n.type === "bloom" && n.params.some((p) => p.kind === "hot" && p.default !== undefined)),
);

const postCreated = await page.evaluate((r) => globalThis.__call("post_create", { path: `${r}/Look` }), root.replaceAll("\\", "/"));
check("post.create writes a new .post", postCreated.ok === true, postCreated.error ?? "");
check("…appending the extension when it is missing", fs.existsSync(path.join(root, "Look.post")));
check("…as a passthrough, not an empty file", postCreated.result?.label === "Passthrough", JSON.stringify(postCreated.result));

const GRADE = {
  nodes: [
    { id: "in", type: "input", props: {}, position: { x: 0, y: 0 } },
    { id: "bl", type: "bloom", props: { strength: 0.6 }, position: { x: 200, y: 0 } },
    { id: "out", type: "output", props: {}, position: { x: 400, y: 0 } },
  ],
  edges: [
    { source: "in", sourceHandle: "color", target: "bl", targetHandle: "color" },
    { source: "bl", sourceHandle: "out", target: "out", targetHandle: "color" },
  ],
};

const noOutput = await page.evaluate(
  (args) => globalThis.__call("post_set", { path: `${args.r}/Look.post`, graph: { nodes: [args.g.nodes[0]], edges: [] } }),
  { r: root.replaceAll("\\", "/"), g: GRADE },
);
check("post.set refuses a graph with no Output node", noOutput.ok === false, (noOutput.error ?? "").slice(0, 60));

const badType = await page.evaluate(
  (args) => {
    const graph = structuredClone(args.g);
    graph.nodes[1].type = "blooom";
    return globalThis.__call("post_set", { path: `${args.r}/Look.post`, graph });
  },
  { r: root.replaceAll("\\", "/"), g: GRADE },
);
check("…and a typo'd node type, by name", badType.ok === false && /blooom/.test(badType.error ?? ""), (badType.error ?? "").slice(0, 60));
check(
  "…without touching the file either time",
  JSON.parse(fs.readFileSync(path.join(root, "Look.post"), "utf8")).graph.nodes.length === 2,
);

const postSet = await page.evaluate(
  (args) => globalThis.__call("post_set", { path: `${args.r}/Look.post`, graph: args.g }),
  { r: root.replaceAll("\\", "/"), g: GRADE },
);
check("post.set writes the graph", postSet.ok === true, postSet.error ?? "");
const onDisk = JSON.parse(fs.readFileSync(path.join(root, "Look.post"), "utf8"));
check("…to the file, versioned", onDisk.version === 1 && onDisk.graph.nodes.length === 3, JSON.stringify(Object.keys(onDisk)));
check("…keeping the param that was set", onDisk.graph.nodes.find((n) => n.id === "bl")?.props?.strength === 0.6);

// A camera to point it at. `post.assign` is the whole reason a .post is not
// just a file in a folder.
const cam = await page.evaluate(() =>
  globalThis.__call("entity_create", { name: "PostCam", components: [{ type: "camera" }, { type: "postprocess" }] }),
);
const camId = cam.result?.id;
check("a camera with a Post Process component exists to assign to", !!camId, cam.error ?? "");

const assigned = await page.evaluate(
  (args) => globalThis.__call("post_assign", { entityId: args.id, path: `${args.r}/Look.post` }),
  { id: camId, r: root.replaceAll("\\", "/") },
);
check("post.assign points the camera at it", assigned.ok === true && assigned.result?.changed === true, assigned.error ?? "");

await wait(500);
const camGraph = await page.evaluate((id) => globalThis.__call("post_get", { entityId: id }), camId);
check(
  "…and the camera now RENDERS the file, not an inline graph",
  camGraph.result?.source === "asset" && camGraph.result?.label === "bloom",
  JSON.stringify({ source: camGraph.result?.source, label: camGraph.result?.label }),
);

const postList = await page.evaluate(() => globalThis.__call("post_list"));
const listed = (postList.result?.graphs ?? []).find((g) => g.path.endsWith("Look.post"));
check("post.list finds it", !!listed, (postList.result?.graphs ?? []).map((g) => g.path).join(", "));
check("…and names the camera using it", listed?.usedBy?.some((u) => u.entityId === camId), JSON.stringify(listed?.usedBy));

const cleared = await page.evaluate((id) => globalThis.__call("post_assign", { entityId: id, path: "" }), camId);
check("post.assign clears the slot", cleared.ok === true && cleared.result?.path === "", cleared.error ?? "");

const escapePost = await page.evaluate(() => globalThis.__call("post_create", { path: "C:/Windows/Temp/Escape.post" }));
check(
  "post.create refuses a path outside the project",
  escapePost.ok === false && /outside the open project/.test(escapePost.error ?? ""),
  (escapePost.error ?? "").slice(0, 60),
);

// --- libraries and build ------------------------------------------------------

const libStatus = await page.evaluate(() => globalThis.__call("library_status"));
const providers = libStatus.result?.providers ?? [];
// Written out rather than counted so adding a library fails here with the
// name of the one that has no status, instead of an off-by-one on a number.
const LIBRARIES = ["polyhaven", "ambientcg", "sketchfab", "polypizza", "itchio"];
check(
  "library.status answers for every library",
  LIBRARIES.every((id) => providers.some((p) => p.id === id)) && providers.length === LIBRARIES.length,
  providers.map((p) => p.id).join(", "),
);
check(
  "…and explains what is missing rather than just refusing",
  providers.every((p) => p.ready || (p.note ?? "").length > 10),
  JSON.stringify(providers.find((p) => !p.ready)),
);

const badProvider = await page.evaluate(() => globalThis.__call("library_search", { provider: "nope", query: "rock" }));
check("library.search rejects an unknown library by name", badProvider.ok === false, (badProvider.error ?? "").slice(0, 70));

const buildSettings = await page.evaluate(() => globalThis.__call("build_getSettings"));
check("build.getSettings reads the project's settings", buildSettings.ok === true, buildSettings.error ?? "");
check(
  "…and resolves which scenes a build would actually contain",
  !!buildSettings.result?.resolved,
  JSON.stringify(buildSettings.result?.settings?.target ?? null),
);

const buildPatch = await page.evaluate(() => globalThis.__call("build_setSettings", { patch: { target: "zip" } }));
check("build.setSettings saves a change", buildPatch.ok === true && buildPatch.result?.settings?.target === "zip", buildPatch.error ?? "");

// --- new asset-management tools ----------------------------------------------

const folder = await page.evaluate((r) => globalThis.__call("asset_createFolder", { path: `${r}/Made` }), root.replaceAll("\\", "/"));
check("asset.createFolder creates a folder", folder.ok === true && fs.existsSync(path.join(root, "Made")), folder.error ?? "");

const renamed = await page.evaluate((d) => globalThis.__call("asset_rename", { path: `${d}/Probe2.png`, name: "Renamed.png" }), dir);
check("asset.rename renames on disk", renamed.ok === true && fs.existsSync(path.join(root, "textures", "Renamed.png")), renamed.error ?? "");

const moved = await page.evaluate(
  (args) => globalThis.__call("asset_move", { paths: [`${args.dir}/Renamed.png`], directory: `${args.root}/Made` }),
  { dir, root: root.replaceAll("\\", "/") },
);
check("asset.move moves it", moved.ok === true && fs.existsSync(path.join(root, "Made", "Renamed.png")), moved.error ?? "");

const removed = await page.evaluate((r) => globalThis.__call("asset_delete", { paths: [`${r}/Made/Renamed.png`] }), root.replaceAll("\\", "/"));
check("asset.delete deletes it", removed.ok === true && !fs.existsSync(path.join(root, "Made", "Renamed.png")), removed.error ?? "");

const escape = await page.evaluate(() => globalThis.__call("asset_delete", { paths: ["C:/Windows/System32/drivers/etc/hosts"] }));
check(
  "…and refuses a path outside the project",
  escape.ok === false && /outside the open project/.test(escape.error ?? ""),
  (escape.error ?? "").slice(0, 60),
);

// ---------------------------------------------------------------------------
const hard = errors.filter((e) => !/WebGPU|GPUAdapter|deprecat|Failed to load resource|WebSocket/i.test(e));
if (hard.length) {
  console.log("\nconsole errors:");
  for (const e of hard.slice(0, 10)) console.log(`  ${e}`);
}
const failed = results.filter((r) => !r.ok);
console.log(
  `\nMCP-TOOLS-SMOKE ${failed.length === 0 && hard.length === 0 ? "PASS" : "FAIL"} — ${results.length - failed.length}/${results.length} checks`,
);
await browser.close();
process.exit(failed.length === 0 && hard.length === 0 ? 0 : 1);
