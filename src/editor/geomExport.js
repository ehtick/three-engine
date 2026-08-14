// @ts-nocheck
import * as THREE from "three/webgpu";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";

/**
 * Getting a mesh back OUT of the editor, as a GLB.
 *
 * `.geom` is our own container (see `engine/geometryAsset.js`) and nothing else
 * on earth reads it. Every route a mesh might legitimately need to take — into
 * Blender for a change the editor cannot make, into a marketplace listing, into
 * a bug report, into another project — was therefore blocked on exporting the
 * whole game and digging the mesh out of the build. This is the one-file
 * version of that, wired to the same asset action list the Inspector and the
 * editor API both read, so a person and an agent export identically.
 *
 * ## Two things the naive version gets wrong
 *
 * **`geometry.userData` becomes glTF `extras`.** Three's exporter calls
 * `serializeUserData(geometry, primitive)`, and our geometries are never bare:
 * a `.geom` authored in Edit Mode carries `editMesh` — the exact polygon
 * topology, per-corner UVs and edge flags — plus `assetPath` and, sometimes, a
 * GI ray proxy. That is editor bookkeeping, it is frequently LARGER than the
 * vertex data it accompanies, and it would be JSON-stringified into the GLB
 * header where no consumer can do anything with it. {@link exportableGeometry}
 * hands the exporter the attributes and nothing else.
 *
 * **Material groups only survive as an ARRAY of materials.** A single material
 * makes the exporter emit one primitive over the whole index buffer and drop
 * `geometry.groups` silently, which quietly welds a two-slot mesh into one.
 * {@link materialsFor} builds one placeholder per slot so the split survives
 * the trip. The materials themselves are placeholders on purpose: a `.geom`
 * holds no material reference — that lives on the Mesh component — so inventing
 * one here would be inventing the wrong one.
 */

const stemOf = (path) => String(path).split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
const dirOf = (path) => String(path).replace(/[\\/][^\\/]+$/, "");
const norm = (path) => String(path ?? "").replaceAll("\\", "/").toLowerCase();

/**
 * The same attributes with none of the editor's baggage.
 *
 * Attributes, index and morph targets are shared by REFERENCE rather than
 * cloned — `BufferGeometry.clone()` deep-copies every buffer, which on an
 * imported mesh is tens of megabytes copied to export tens of megabytes, and it
 * would carry `userData` across anyway.
 */
function exportableGeometry(geometry) {
  const out = new THREE.BufferGeometry();
  out.name = geometry.name ?? "";
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    out.setAttribute(name, attribute);
  }
  if (geometry.index) out.setIndex(geometry.index);
  for (const [name, targets] of Object.entries(geometry.morphAttributes)) {
    out.morphAttributes[name] = targets;
  }
  out.morphTargetsRelative = !!geometry.morphTargetsRelative;
  for (const group of geometry.groups) {
    out.addGroup(group.start, group.count, group.materialIndex);
  }
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

/** One neutral placeholder per material slot; a single material when there is one slot. */
function materialsFor(geometry, name) {
  const slots = new Set();
  for (const group of geometry.groups) slots.add(group.materialIndex ?? 0);
  const make = (index) =>
    new THREE.MeshStandardMaterial({
      name: slots.size > 1 ? `${name}_${index}` : name,
      color: 0xcccccc,
      roughness: 0.8,
      metalness: 0,
    });
  if (slots.size < 2) return make(0);
  return Array.from({ length: Math.max(...slots) + 1 }, (_, index) => make(index));
}

/** Vertex and triangle counts, for reporting what was written. */
export function geometryStats(geometry) {
  const position = geometry.getAttribute("position");
  const vertices = position?.count ?? 0;
  const indexed = geometry.index?.count ?? vertices;
  return { vertices, triangles: Math.floor(indexed / 3) };
}

/**
 * Converts a BufferGeometry to GLB bytes. Pure — no filesystem, no project, no
 * Tauri — which is what lets the headless test exercise it.
 */
export async function glbFromGeometry(geometry, { name = "Mesh" } = {}) {
  const source = exportableGeometry(geometry);
  const mesh = new THREE.Mesh(source, materialsFor(source, name));
  mesh.name = name;
  const result = await new GLTFExporter().parseAsync(mesh, {
    binary: true,
    onlyVisible: false,
    // The exporter otherwise trims the index buffer to `drawRange`, which is
    // the LOD/virtual-geometry machinery's business and not what the asset is.
    truncateDrawRange: false,
  });
  if (!(result instanceof ArrayBuffer)) throw new Error("glTF export did not produce a binary GLB");
  return new Uint8Array(result);
}

/* -------------------------------------------------------------------------- */
/* Writing it somewhere                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A `.glb` beside the `.geom` that does not already exist.
 *
 * The collision this avoids is not hypothetical: a `.geom` is usually the
 * result of unpacking a model, so `Crate.geom` very often sits next to the
 * `Crate.glb` it came from. Defaulting to the obvious name would overwrite the
 * user's source file with a materialless re-export of one of its meshes.
 */
async function defaultTargetFor(path) {
  const stem = stemOf(path);
  const dir = dirOf(path);
  const { invoke, uniqueName } = await import("./assetOps.js");
  const siblings = await invoke("list_dir", { path: dir }).catch(() => []);
  return `${dir}/${uniqueName(`${stem}.glb`, siblings)}`;
}

/** Shows the new file in the Assets panel when it landed inside the project. */
async function refreshIfInProject(target) {
  const { useProjectStore } = await import("./store/projectStore.js");
  const root = useProjectStore.getState().rootPath;
  if (!root) return;
  if (!norm(target).startsWith(`${norm(root).replace(/\/$/, "")}/`)) return;
  await useProjectStore.getState().refresh();
}

async function writeGlb(targetPath, geometry, name) {
  const bytes = await glbFromGeometry(geometry, { name });
  const { writeBinaryFile } = await import("./assetLoader.js");
  await writeBinaryFile(targetPath, bytes);
  await refreshIfInProject(targetPath);
  return { targetPath, bytes: bytes.byteLength, ...geometryStats(geometry) };
}

const formatSize = (bytes) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const describe = (result) =>
  `${result.triangles.toLocaleString()} triangles · ${formatSize(result.bytes)}`;

/**
 * Asks where to put it. Returns null when the user cancels — the dialog is
 * opened BEFORE the mesh is loaded and converted so a cancel costs nothing.
 */
async function pickTarget(defaultPath) {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const chosen = await save({
    title: "Export as GLB",
    defaultPath,
    filters: [{ name: "glTF Binary", extensions: ["glb"] }],
  });
  if (!chosen) return null;
  // A user who types a bare name gets a `.glb` anyway; a file called `Crate`
  // is not something the OS, this editor or Blender will open.
  return /\.glb$/i.test(chosen) ? chosen : `${chosen}.glb`;
}

/**
 * Exports a `.geom` asset to `targetPath` (default: a free `.glb` beside it).
 * Headless — this is the path the editor API takes.
 */
export async function exportGeometryAssetAsGlb(path, { targetPath } = {}) {
  const { loadGeometryAsset } = await import("../engine/geometryAsset.js");
  // A private instance, not the shared cache entry: we dispose it below, and
  // disposing something other meshes are rendering would blank them.
  const geometry = await loadGeometryAsset(path);
  try {
    const target = (targetPath || (await defaultTargetFor(path))).replaceAll("\\", "/");
    return { path, ...(await writeGlb(target, geometry, stemOf(path))) };
  } finally {
    geometry.dispose();
  }
}

/**
 * One toast per export, replaced in place as it progresses.
 *
 * Converting a Sponza-sized mesh blocks the thread for a second or two with
 * nothing on screen between the file dialog closing and the file appearing,
 * which reads as "the export did nothing". Sharing one dedupe key means the
 * "Exporting…" toast becomes the result rather than stacking beside it.
 */
const TOAST_KEY = "geom-export-glb";

/** The Assets-panel action: pick a destination, then export. */
export async function exportGeometryAssetWithDialog(path) {
  const { pushToast } = await import("./toasts.js");
  try {
    const target = await pickTarget(await defaultTargetFor(path));
    if (!target) return null;
    pushToast({ title: "Exporting GLB…", detail: stemOf(path), key: TOAST_KEY, timeoutMs: 120000 });
    const result = await exportGeometryAssetAsGlb(path, { targetPath: target });
    pushToast({ title: `Exported ${stemOf(target)}.glb`, detail: describe(result), key: TOAST_KEY });
    return result;
  } catch (error) {
    pushToast({ level: "error", title: "GLB export failed", detail: error?.message ?? String(error), key: TOAST_KEY });
    throw error;
  }
}

/**
 * The Geometry Editor's action: exports the mesh AS EDITED, including changes
 * that have not been autosaved yet. Exporting the file on disk from a panel
 * showing something else is the kind of surprise that costs an afternoon.
 */
export async function exportGeometryWithDialog(geometry, { name = "Mesh", defaultPath } = {}) {
  const { pushToast } = await import("./toasts.js");
  try {
    const target = await pickTarget(defaultPath ?? `${name}.glb`);
    if (!target) return null;
    pushToast({ title: "Exporting GLB…", detail: name, key: TOAST_KEY, timeoutMs: 120000 });
    const result = await writeGlb(target.replaceAll("\\", "/"), geometry, name);
    pushToast({ title: `Exported ${stemOf(target)}.glb`, detail: describe(result), key: TOAST_KEY });
    return result;
  } catch (error) {
    pushToast({ level: "error", title: "GLB export failed", detail: error?.message ?? String(error), key: TOAST_KEY });
    throw error;
  }
}
