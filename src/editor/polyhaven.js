/**
 * Poly Haven client + import pipeline (editor-only; the runtime never talks
 * to the network). Three asset kinds, three "ready to use" outcomes:
 *
 *   textures → PolyHaven/<Name>/  maps (jpg) + <Name>.mat wiring a full PBR
 *              shader graph (diffuse / normal / roughness / AO / metalness),
 *              data maps tagged linear via .meta
 *   models   → gltf + buffers + textures fetched and packed into a single
 *              .glb, then run through the standard unpackGlb pipeline
 *              (prefab + materials + extracted textures, draco/basis aware)
 *   hdris    → PolyHaven/<Name>_<res>.hdr for the Environment component
 *
 * API: https://github.com/Poly-Haven/Public-API — CC0 content, CORS open on
 * both api.polyhaven.com and the dl.polyhaven.org CDN, so plain fetch works
 * inside the webview.
 */

import { buildPbrGraph } from "./pbrMaterialGraph.js";
import { writeBinaryFile } from "./assetLoader.js";

export { buildPbrGraph };

const API = "https://api.polyhaven.com";

async function invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

// Editor stores stay dynamic so this file's only static import is the pure
// graph builder — packGlb / buildPbrGraph / size math load in any JS runtime.
async function projectStore() {
  return (await import("./store/projectStore.js")).useProjectStore.getState();
}

export const thumbUrl = (id, size = 256) =>
  `https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?width=${size}&height=${size}`;
export const previewUrl = (id, width = 710) =>
  `https://cdn.polyhaven.com/asset_img/primary/${id}.png?width=${width}`;

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

const indexCache = new Map(); // type -> Promise<[{id, name, categories, tags, download_count, authors}]>
const filesCache = new Map(); // id -> Promise<files JSON>

/** Full asset list for one tab, sorted by popularity (site default). */
export function fetchAssetIndex(type) {
  let p = indexCache.get(type);
  if (!p) {
    p = fetch(`${API}/assets?type=${type}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Poly Haven API: HTTP ${r.status}`);
        return r.json();
      })
      .then((byId) =>
        Object.entries(byId)
          .map(([id, info]) => ({ id, ...info }))
          .sort((a, b) => (b.download_count ?? 0) - (a.download_count ?? 0)),
      );
    indexCache.set(type, p);
    p.catch(() => indexCache.delete(type)); // retry next open on failure
  }
  return p;
}

/** Per-asset file tree: { <map>: { <res>: { <fmt>: {url, size, include?} } } } */
export function fetchAssetFiles(id) {
  let p = filesCache.get(id);
  if (!p) {
    p = fetch(`${API}/files/${id}`).then((r) => {
      if (!r.ok) throw new Error(`Poly Haven API: HTTP ${r.status}`);
      return r.json();
    });
    filesCache.set(id, p);
    p.catch(() => filesCache.delete(id));
  }
  return p;
}

// ---------------------------------------------------------------------------
// Download plumbing
// ---------------------------------------------------------------------------

/** Streams a URL to bytes, reporting cumulative progress. */
async function fetchBytes(url, onChunk) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onChunk?.(buf.byteLength);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.byteLength;
    onChunk?.(value.byteLength);
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

const safeName = (name) => name.replace(/[^\w\- ]+/g, "_").trim() || "Unnamed";

/** PolyHaven/ folder inside the open project (created on demand). */
async function ensureDownloadDir() {
  const root = (await projectStore()).rootPath;
  if (!root) throw new Error("Open a project first");
  const dir = `${root}/PolyHaven`;
  await invoke("create_dir", { path: dir }).catch(() => {});
  return dir;
}

async function writeBinary(path, bytes) {
  await writeBinaryFile(path, bytes);
}

async function writeText(path, contents) {
  await invoke("save_scene", { path, contents });
}

/** Picks `res` from an availability map, else the nearest available. */
export function pickResolution(byRes, res) {
  if (!byRes) return null;
  if (byRes[res]) return res;
  const order = ["1k", "2k", "4k", "8k", "12k", "16k", "24k"];
  const want = order.indexOf(res);
  const available = Object.keys(byRes).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return (
    available.find((r) => order.indexOf(r) >= want) ?? available[available.length - 1] ?? null
  );
}

// ---------------------------------------------------------------------------
// Textures → PBR material
// ---------------------------------------------------------------------------

// files-JSON key aliases (observed casing varies: "Diffuse", "nor_gl", "AO",
// "Rough"…) for each material slot we can wire. `arm` is the packed
// AO(r)/Rough(g)/Metal(b) fallback used when the separate maps don't exist.
const TEXTURE_SLOTS = [
  { slot: "diffuse", keys: ["diff", "diffuse", "albedo", "col", "color"], srgb: true },
  { slot: "normal", keys: ["nor_gl"] },
  { slot: "roughness", keys: ["rough", "roughness"] },
  { slot: "ao", keys: ["ao"] },
  { slot: "metalness", keys: ["metal", "metallic", "metalness"] },
  { slot: "arm", keys: ["arm"] },
];

/** Resolves which maps a texture asset offers → [{slot, srgb, byRes}]. */
export function textureMapPlan(files) {
  const lower = new Map(Object.keys(files).map((k) => [k.toLowerCase(), k]));
  const plan = [];
  for (const { slot, keys, srgb } of TEXTURE_SLOTS) {
    const key = keys.map((k) => lower.get(k)).find(Boolean);
    if (key) plan.push({ slot, srgb: !!srgb, byRes: files[key] });
  }
  // The packed arm map is only worth downloading when it fills a missing
  // rough/AO channel. A missing metal map just means "not metallic" (the
  // BSDF's metalness defaults to 0), not a reason to fetch arm.
  const have = new Set(plan.map((p) => p.slot));
  if (have.has("roughness") && have.has("ao")) {
    return plan.filter((p) => p.slot !== "arm");
  }
  return plan;
}

/** jpg preferred (small, decodes fast); png fallback; exr/other skipped. */
function pickImageFile(byRes, res) {
  const r = pickResolution(byRes, res);
  const entry = byRes?.[r];
  return entry ? (entry.jpg ?? entry.png ?? null) : null;
}

/** Estimated byte total of a texture download at `res` (for the UI). */
export function textureDownloadSize(files, res) {
  return textureMapPlan(files).reduce((sum, p) => sum + (pickImageFile(p.byRes, res)?.size ?? 0), 0);
}

/**
 * Downloads the map set and writes a ready-to-assign .mat whose shader graph
 * wires everything into a Principled BSDF. Returns the .mat path.
 */
export async function downloadTexture({ name, files, res = "2k", onProgress }) {
  const dir = await ensureDownloadDir();
  const folder = `${dir}/${safeName(name)}`;
  await invoke("create_dir", { path: folder }).catch(() => {});

  const plan = textureMapPlan(files);
  if (!plan.length) throw new Error("No downloadable image maps on this asset");
  const total = textureDownloadSize(files, res);
  let loaded = 0;

  const written = {}; // slot -> asset path
  for (const { slot, srgb, byRes } of plan) {
    const file = pickImageFile(byRes, res);
    if (!file) continue;
    onProgress?.({ label: `Downloading ${slot}…`, loaded, total });
    const bytes = await fetchBytes(file.url, (n) => {
      loaded += n;
      onProgress?.({ label: `Downloading ${slot}…`, loaded, total });
    });
    const ext = file.url.split(".").pop().toLowerCase();
    const path = `${folder}/${safeName(name)}_${slot}.${ext}`;
    await writeBinary(path, bytes);
    // Data maps must not be sRGB-decoded; the graph's texture node defaults
    // to sRGB, so the .meta override is what keeps normals/roughness correct.
    await writeText(`${path}.meta`, JSON.stringify({ colorSpace: srgb ? "srgb" : "linear" }, null, 2));
    const { autoCompressTexture } = await import("./basisCompress.js");
    await autoCompressTexture(path).catch(() => {});
    written[slot] = path;
  }

  onProgress?.({ label: "Writing material…", loaded: total, total });
  const def = {
    color: "#ffffff",
    roughness: 1,
    metalness: 0,
    map: written.diffuse ?? "",
    shaderGraph: buildPbrGraph(written),
  };
  const matPath = `${folder}/${safeName(name)}.mat`;
  await writeText(matPath, JSON.stringify(def, null, 2));
  await (await projectStore()).refresh();
  return matPath;
}


// ---------------------------------------------------------------------------
// Models → packed .glb → standard unpack pipeline
// ---------------------------------------------------------------------------

/** Estimated byte total of a model download at `res`. */
export function modelDownloadSize(files, res) {
  const r = pickResolution(files.gltf ?? {}, res);
  const entry = files.gltf?.[r];
  if (!entry) return 0;
  const gltf = entry.gltf ?? entry; // some assets nest a format level
  const include = gltf.include ?? {};
  return (gltf.size ?? 0) + Object.values(include).reduce((s, f) => s + (f.size ?? 0), 0);
}

function gltfEntry(files, res) {
  const r = pickResolution(files.gltf ?? {}, res);
  const entry = files.gltf?.[r];
  if (!entry) return null;
  return entry.gltf ?? entry;
}

/**
 * Fetches the .gltf + every included file (buffers, textures), packs them
 * into one self-contained .glb and hands it to the regular GLB import
 * (prefab + materials + texture extraction). Returns the unpacked folder.
 */
export async function downloadModel({ name, files, res = "1k", onProgress }) {
  const entry = gltfEntry(files, res);
  if (!entry) throw new Error("No glTF download for this asset");
  const dir = await ensureDownloadDir();

  const include = entry.include ?? {};
  const total = modelDownloadSize(files, res);
  let loaded = 0;
  const tick = (label) => (n) => {
    loaded += n;
    onProgress?.({ label, loaded, total });
  };

  onProgress?.({ label: "Downloading glTF…", loaded, total });
  const gltfBytes = await fetchBytes(entry.url, tick("Downloading glTF…"));
  const resources = new Map();
  for (const [relPath, file] of Object.entries(include)) {
    const short = relPath.split("/").pop();
    resources.set(relPath, await fetchBytes(file.url, tick(`Downloading ${short}…`)));
  }

  onProgress?.({ label: "Packing .glb…", loaded: total, total });
  const glb = packGlb(JSON.parse(new TextDecoder().decode(gltfBytes)), resources);
  const glbPath = `${dir}/${safeName(name)}.glb`;
  await writeBinary(glbPath, glb);

  onProgress?.({ label: "Importing…", loaded: total, total });
  const { unpackGlb } = await import("./glbImport.js");
  const folder = await unpackGlb(glbPath);
  await (await projectStore()).refresh();
  return folder ?? glbPath;
}

const MIME_BY_EXT = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

/**
 * Minimal glTF→GLB packer: concatenates all external buffers into one BIN
 * chunk, folds uri-images in as bufferViews, and emits the binary container.
 * No geometry is touched — just container plumbing, so it's lossless.
 */
export function packGlb(json, resources) {
  const parts = []; // Uint8Array segments of the BIN chunk
  let binLength = 0;
  const append = (bytes) => {
    const offset = binLength;
    parts.push(bytes);
    binLength += bytes.byteLength;
    const pad = (4 - (binLength % 4)) % 4;
    if (pad) {
      parts.push(new Uint8Array(pad));
      binLength += pad;
    }
    return offset;
  };
  const resource = (uri) => {
    const key = decodeURIComponent(uri);
    const bytes = resources.get(key) ?? resources.get(key.replace(/^\.\//, ""));
    if (!bytes) throw new Error(`Missing resource "${uri}" in download`);
    return bytes;
  };

  // External buffers → one combined buffer; bufferViews shift accordingly.
  const bufferOffsets = (json.buffers ?? []).map((buf) => {
    if (buf.uri == null) throw new Error("GLB-embedded source buffers aren't expected here");
    return append(resource(buf.uri));
  });
  for (const view of json.bufferViews ?? []) {
    view.byteOffset = (view.byteOffset ?? 0) + bufferOffsets[view.buffer ?? 0];
    view.buffer = 0;
  }

  // uri images → embedded bufferViews.
  for (const image of json.images ?? []) {
    if (image.uri == null) continue;
    const bytes = resource(image.uri);
    const byteOffset = append(bytes);
    json.bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.byteLength });
    image.bufferView = json.bufferViews.length - 1;
    image.mimeType = MIME_BY_EXT[image.uri.split(".").pop().toLowerCase()] ?? "image/png";
    delete image.uri;
  }

  json.buffers = [{ byteLength: binLength }];

  // Assemble container: 12-byte header + JSON chunk (space-padded) + BIN chunk.
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.byteLength % 4)) % 4;
  if (jsonPad) {
    const padded = new Uint8Array(jsonBytes.byteLength + jsonPad);
    padded.set(jsonBytes);
    padded.fill(0x20, jsonBytes.byteLength);
    jsonBytes = padded;
  }
  const totalLength = 12 + 8 + jsonBytes.byteLength + 8 + binLength;
  const glb = new Uint8Array(totalLength);
  const dv = new DataView(glb.buffer);
  dv.setUint32(0, 0x46546c67, true); // "glTF"
  dv.setUint32(4, 2, true);
  dv.setUint32(8, totalLength, true);
  dv.setUint32(12, jsonBytes.byteLength, true);
  dv.setUint32(16, 0x4e4f534a, true); // "JSON"
  glb.set(jsonBytes, 20);
  let cursor = 20 + jsonBytes.byteLength;
  dv.setUint32(cursor, binLength, true);
  dv.setUint32(cursor + 4, 0x004e4942, true); // "BIN"
  cursor += 8;
  for (const part of parts) {
    glb.set(part, cursor);
    cursor += part.byteLength;
  }
  return glb;
}

// ---------------------------------------------------------------------------
// HDRIs
// ---------------------------------------------------------------------------

export function hdriDownloadSize(files, res) {
  const r = pickResolution(files.hdri ?? {}, res);
  const entry = files.hdri?.[r];
  return entry?.hdr?.size ?? entry?.exr?.size ?? 0;
}

/** Downloads the .hdr (RGBE — small and directly loadable) into PolyHaven/. */
export async function downloadHdri({ name, files, res = "2k", onProgress }) {
  const r = pickResolution(files.hdri ?? {}, res);
  const file = files.hdri?.[r]?.hdr ?? files.hdri?.[r]?.exr;
  if (!file) throw new Error("No HDR download for this asset");
  const dir = await ensureDownloadDir();
  const total = file.size ?? 0;
  let loaded = 0;
  const bytes = await fetchBytes(file.url, (n) => {
    loaded += n;
    onProgress?.({ label: "Downloading HDRI…", loaded, total });
  });
  const ext = file.url.split(".").pop().toLowerCase();
  const path = `${dir}/${safeName(name)}_${r}.${ext}`;
  await writeBinary(path, bytes);
  await (await projectStore()).refresh();
  return path;
}

/**
 * Points the scene at an HDRI: reuses the first Environment component in the
 * scene, else creates an "Environment" entity (undoable) with one.
 */
export async function setSceneEnvironment(hdriPath) {
  const { ensureEngine } = await import("./engineInstance.js");
  const engine = await ensureEngine();
  for (const entity of engine.entities.values()) {
    const comp = entity.getComponent("environment");
    if (comp) {
      comp.setProp("hdri", hdriPath);
      return entity;
    }
  }
  const { CreateEntityCommand } = await import("./commands/entityCommands.js");
  const { commandBus } = await import("./commands/CommandBus.js");
  const cmd = new CreateEntityCommand({
    name: "Environment",
    components: [{ type: "environment", props: { hdri: hdriPath } }],
  });
  commandBus.execute(cmd);
  return engine.getEntity(cmd.entityId);
}
