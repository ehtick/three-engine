/**
 * AmbientCG client + import pipeline (editor-only; the runtime never talks
 * to the network). One asset kind — materials — and one ready-to-use outcome:
 *
 *   material → AmbientCG/<Name>/  maps (jpg) + <Name>.mat wiring a full PBR
 *              shader graph (color / normal / roughness / AO / metalness,
 *              with displacement fed in as height when present), data maps
 *              tagged linear via .meta.
 *
 * API: https://docs.ambientcg.com/api/v2/ — CC0 content. ambientCG's API
 * and download endpoints don't send CORS headers, so a direct `fetch` from
 * the Tauri webview fails with "Failed to fetch". We proxy those calls
 * through Rust Tauri commands (`fetch_text` for the JSON catalog,
 * `fetch_bytes` for the ZIP). Thumbnail images live on a separate CDN
 * (`acg-media.struffelproductions.com`) that does serve CORS, so the grid
 * tiles can load them directly.
 *
 * The v2 /full_json endpoint gives us metadata + downloadable ZIP URLs in
 * one call. ZIPs contain every map at the requested resolution; we extract
 * them client side via JSZip and pick the slots we care about.
 */
import JSZip from "jszip";
import { buildPbrGraph } from "./pbrMaterialGraph.js";
import { writeBinaryFile } from "./assetLoader.js";

export { buildPbrGraph };

const API = "https://ambientcg.com/api/v2/full_json";

async function invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

async function projectStore() {
  return (await import("./store/projectStore.js")).useProjectStore.getState();
}

// ---------------------------------------------------------------------------
// CORS proxy
// ---------------------------------------------------------------------------
//
// ambientCG's API (`/api/v2/full_json`) and download endpoint (`/get?file=…`)
// do NOT send `Access-Control-Allow-Origin`, so a direct browser fetch
// inside the Tauri webview fails with "Failed to fetch". The thumbnail CDN
// does send CORS, so images load directly. For the API and ZIPs we round-
// trip through the Rust Tauri commands `fetch_text` / `fetch_bytes` which
// run server-side (no CORS in play) and return the raw body.

/** GET `url` and return the response body as a UTF-8 string. */
async function proxyText(url) {
  return invoke("fetch_text", { url });
}

/**
 * GET `url` and return the response body as an `ArrayBuffer` (raw IPC,
 * not JSON). Used for ZIP downloads; JSZip can load from an ArrayBuffer
 * directly via `loadAsync(arrayBuffer)`.
 */
async function proxyBytes(url) {
  // `tauri::ipc::Response` resolves to an ArrayBuffer on the JS side.
  const ab = await invoke("fetch_bytes", { url });
  if (ab instanceof ArrayBuffer) return ab;
  // Older Tauri versions / different bindings may return a Uint8Array
  // — normalise so the rest of the file can treat it as an ArrayBuffer.
  if (ab instanceof Uint8Array) return ab.buffer.slice(ab.byteOffset, ab.byteOffset + ab.byteLength);
  if (ab?.buffer instanceof ArrayBuffer) return ab.buffer;
  throw new Error("fetch_bytes: unexpected return shape");
}

/**
 * Wrapper around `proxyBytes` that reports cumulative byte progress via
 * `onChunk(chunkBytes)` (same shape as the in-webview `fetchBytes` helper
 * used by Poly Haven, so callers can share progress reporting code). The
 * Rust side doesn't stream progress — we just call back once with the
 * final total when the body arrives. For multi-MB ZIPs over a fast LAN
 * the indeterminate state is brief, but it's worth wiring the hook so the
 * UI shows the right shape.
 */
async function proxyBytesWithProgress(url, onChunk) {
  const ab = await proxyBytes(url);
  onChunk?.(ab.byteLength);
  return ab;
}

// Thumbnail sizes: 64 / 128 / 256 / 512 / 1024 / 2048 — we use the 256 PNG
// for the grid tile and the 512 JPG on a white backdrop for the detail pane
// (matches the rest of the engine UI without surprising network costs).
export const thumbUrl = (id, size = 256) =>
  `https://acg-media.struffelproductions.com/file/ambientCG-Web/media/thumbnail/${size}-PNG/${id}.png`;
export const previewUrl = (id) =>
  `https://acg-media.struffelproductions.com/file/ambientCG-Web/media/thumbnail/512-JPG-FFFFFF/${id}.jpg`;

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

const indexCache = new Map(); // query-key -> Promise<asset list>

/**
 * v2 /full_json accepts kebab-case type names. The docs (and the response's
 * own `dataType` field) use PascalCase / camelCase like `3DModel`, but the
 * server actually rejects anything other than `3d-model` — passing
 * `3DModel` returns the unfiltered catalog and the panel sees materials.
 * Normalise everything here so the rest of the file stays PascalCase.
 */
const V2_TYPE_ALIASES = {
  "3DModel": "3d-model",
};

/**
 * Full asset list. `type` is the ambientCG dataType — `Material`, `HDRI` or
 * `3DModel` (the engine exposes all three via the AmbientCG browser tabs).
 * Sorted by popularity (downloadCount) so the default view is "what's good".
 */
export function fetchAssetIndex({
  type = "Material",
  sort = "Popular",
  query = "",
} = {}) {
  // The v2 /full_json `type` param is documented as case-insensitive, but
  // `3DModel` / `Model` / `ThreeDModel` are all silently rejected (returning
  // the full 2863-result catalog) — only the lowercase kebab `3d-model`
  // actually filters to the 34 3D assets. The other types (Material / HDRI)
  // are fine in any case, but we normalize everything to lowercase kebab
  // to be safe and to share one cache key shape with the v3 API.
  const apiType = V2_TYPE_ALIASES[type] ?? type.toLowerCase();
  const cacheKey = `${type}|${sort}|${query}`;
  let p = indexCache.get(cacheKey);
  if (!p) {
    const params = new URLSearchParams({
      type: apiType,
      sort,
      limit: "100",
      include: "statisticsData,labelData,previewData",
    });
    if (query) params.set("q", query);
    p = proxyText(`${API}?${params}`)
      .then((body) => JSON.parse(body))
      .then((data) =>
        (data.foundAssets ?? [])
          .map((a) => ({
            id: a.assetId,
            name: a.displayName || a.assetId,
            category: a.displayCategory || null,
            tags: a.tags ?? [],
            downloadCount: a.downloadCount ?? 0,
            maps: a.maps ?? [],
            thumbnails: a.previewImage ?? {},
          }))
          .sort((a, b) => b.downloadCount - a.downloadCount),
      );
    indexCache.set(cacheKey, p);
    p.catch(() => indexCache.delete(cacheKey));
  }
  return p;
}

/**
 * Per-asset detail. The full_json endpoint already returns the downloadable
 * ZIP list in `previewData`'s previewLinks — but those are preview *HTML*
 * pages, not the files. We pull a fresh full_json for the single asset id,
 * which gives us the same data as the index entry plus the relationships we
 * need. Easiest: re-issue full_json with the `id` filter; ambientCG accepts
 * a comma-separated id list and ignores unknowns.
 */
export function fetchAssetFiles(id) {
  let p = indexCache.get(`files|${id}`);
  if (!p) {
    const params = new URLSearchParams({
      id,
      include: "statisticsData,labelData,previewData,fileData",
    });
    p = proxyText(`${API}?${params}`)
      .then((body) => JSON.parse(body))
      .then((data) => {
        const a = (data.foundAssets ?? [])[0];
        if (!a) throw new Error(`AmbientCG asset "${id}" not found`);
        // The /fileData include used to expose `downloadFolders` with per-
        // format entries; if the current response doesn't carry them we
        // synthesize from the well-known attribute scheme ambientCG has used
        // for years. The list of valid attributes depends on the asset's
        // dataType — HDRIs ship plain `<id>_<res>.zip` files, 3D models use
        // `<id>_<quality>-<res>-<fmt>.zip`, materials use the simple
        // `<id>_<res>-<fmt>.zip` pattern the panel already supports.
        const dataType = a.dataType ?? "Material";
        const zipBase = `https://ambientcg.com/get?file=${a.assetId}`;
        const attrs = RES_ATTRS[dataType] ?? RES_ATTRS.Material;
        const downloads = {};
        for (const attr of attrs) {
          downloads[attr] = {
            url: `${zipBase}_${attr}.zip`,
            size: null,
          };
        }
        // Best-effort: if the API ever exposes real sizes, prefer those.
        if (Array.isArray(a.downloadFolders)) {
          for (const f of a.downloadFolders) {
            const attr = f?.attributes ?? f?.attribute;
            if (attr && downloads[attr]) {
              downloads[attr].url = f.downloadLink ?? f.rawLink ?? downloads[attr].url;
              downloads[attr].size = f.zipSize ?? f.size ?? null;
            }
          }
        }
        return {
          id: a.assetId,
          name: a.displayName || a.assetId,
          category: a.displayCategory || null,
          tags: a.tags ?? [],
          maps: a.maps ?? [],
          dataType,
          downloads,
        };
      });
    indexCache.set(`files|${id}`, p);
    p.catch(() => indexCache.delete(`files|${id}`));
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

/** AmbientCG/ folder inside the open project (created on demand). */
async function ensureDownloadDir() {
  const root = (await projectStore()).rootPath;
  if (!root) throw new Error("Open a project first");
  const dir = `${root}/AmbientCG`;
  await invoke("create_dir", { path: dir }).catch(() => {});
  return dir;
}

async function writeBinary(path, bytes) {
  await writeBinaryFile(path, bytes);
}

async function writeText(path, contents) {
  await invoke("save_scene", { path, contents });
}

// ---------------------------------------------------------------------------
// Texture plan
// ---------------------------------------------------------------------------

/**
 * ambientCG ZIPs include a predictable set of maps. We only consume the
 * slots the engine's PBR shader graph cares about; displacement is loaded
 * as a height map (linear, like normals) but the current .mat format only
 * exposes a `map` slot — so we wire it into a custom shader-graph node when
 * present and otherwise skip it.
 *
 * Filename convention (e.g. `Tiles141_1K-JPG_Color.jpg`):
 *   <assetId>_<res>-<fmt>_<Map>.jpg|png
 *
 * Per ambientCG docs we may also see _NormalGL / _NormalDX (glTF uses GL;
 * ambientCG ships both to support engines that want DX). We always prefer
 * _NormalGL — it's the convention the rest of the engine uses.
 */
const TEXTURE_SLOTS = [
  { slot: "diffuse",   keys: ["color", "diffuse", "albedo"], srgb: true },
  { slot: "normal",    keys: ["normalgl"], srgb: false }, // GL convention; matches Three.js
  { slot: "normalDX",  keys: ["normaldx"], srgb: false }, // fallback if only DX shipped
  { slot: "roughness", keys: ["roughness", "rough"], srgb: false },
  { slot: "ao",        keys: ["ambientocclusion", "ao"], srgb: false },
  { slot: "metalness", keys: ["metalness", "metallic", "metal"], srgb: false },
  { slot: "displacement", keys: ["displacement", "height", "bump"], srgb: false },
];

/**
 * Extracts the map type from a filename inside the ZIP. Returns null if the
 * file isn't one we recognise.
 */
function classifyZipEntry(filename, assetId) {
  // Strip the "<assetId>_<attrs>_" prefix and the extension; the remainder
  // is the map type. E.g. "Tiles141_1K-JPG_Color.jpg" -> "color".
  const base = filename.split("/").pop() ?? "";
  const stem = base.replace(/\.(jpg|jpeg|png|webp)$/i, "");
  const prefix = `${assetId}_`;
  if (!stem.toLowerCase().startsWith(prefix.toLowerCase())) return null;
  const tail = stem.slice(prefix.length);
  // The first segment after the assetId is "<res>-<fmt>" (e.g. "1K-JPG"),
  // anything after the second underscore is the map name. We only need the
  // last segment, but match case-insensitively and treat the full tail as
  // "<res>-<fmt>_<map>" -> drop the first segment.
  const parts = tail.split("_");
  if (parts.length < 2) return null;
  const mapPart = parts[parts.length - 1].toLowerCase();
  // Skip "usdc" / ".blend" / ".tres" / ".mtlx" / "preview.png" siblings by
  // matching only against the known slot keys.
  for (const { slot, keys } of TEXTURE_SLOTS) {
    if (keys.includes(mapPart)) return slot;
  }
  return null;
}

/**
 * Returns [{slot, srgb, entryName, ext}] describing which files inside the
 * ZIP to extract. The "normal" slot wins over "normalDX" if both exist;
 * ambientCG ships both so we always get one.
 */
export function textureMapPlanFromMaps(mapsList) {
  // mapsList is the asset's `maps` array, e.g. ["color","displacement","normal","roughness"]
  const set = new Set((mapsList ?? []).map((m) => m.toLowerCase()));
  const plan = [];
  const pushIf = (slot, srgb, ...keys) => {
    if (keys.some((k) => set.has(k))) plan.push({ slot, srgb });
  };
  pushIf("diffuse", true, "color", "diffuse", "albedo");
  pushIf("normal", false, "normal");
  pushIf("roughness", false, "roughness", "rough");
  pushIf("ao", false, "ambientocclusion", "ao");
  pushIf("metalness", false, "metalness", "metallic", "metal");
  pushIf("displacement", false, "displacement", "height", "bump");
  return plan;
}

/**
 * Estimated byte total of a texture download at `res`. ambientCG returns the
 * full ZIP size on the v3 endpoint; the v2 endpoint we use here only ships
 * sizes when the `fileData` include is supported, so the caller falls back
 * to the live `Content-Length` during the actual download. We still try to
 * surface the advertised size when present so the UI can show something
 * useful before the request starts.
 */
export function textureDownloadSize(files, res) {
  const entry = files?.downloads?.[res];
  return entry?.size ?? 0;
}

// ---------------------------------------------------------------------------
// Material download
// ---------------------------------------------------------------------------

/**
 * Downloads the ambientCG ZIP, extracts the maps we care about, writes them
 * into AmbientCG/<Name>/, writes a sidecar `.meta` so the runtime knows the
 * colour space of each map, then builds a `<Name>.mat` wiring them into a
 * Principled BSDF via the shared `buildPbrGraph` shader-graph builder.
 * Returns the `.mat` path.
 */
export async function downloadTexture({ name, files, res = "1K-JPG", onProgress }) {
  const entry = files?.downloads?.[res];
  if (!entry?.url) throw new Error(`No "${res}" download for this asset`);

  const dir = await ensureDownloadDir();
  const folder = `${dir}/${safeName(name)}`;
  await invoke("create_dir", { path: folder }).catch(() => {});

  // 1. Pull the ZIP via the Rust proxy (ambientCG's download endpoint has
  //    no CORS headers). The proxy returns an ArrayBuffer; JSZip can load
  //    from that directly via loadAsync(buffer).
  onProgress?.({ label: "Downloading ZIP…", loaded: 0, total: entry.size ?? 0 });
  const zipBuffer = await proxyBytesWithProgress(entry.url, (n) => {
    onProgress?.({ label: "Downloading ZIP…", loaded: n, total: entry.size ?? 0 });
  });
  const zipBytes = new Uint8Array(zipBuffer);

  // 2. Extract only the maps we want (drastically reduces noise in the
  // project folder — ambientCG ZIPs also ship .blend, .mtlx, .usdc, etc.).
  onProgress?.({ label: "Extracting maps…", loaded: zipBytes.byteLength, total: zipBytes.byteLength });
  const zip = await JSZip.loadAsync(zipBuffer);
  const plan = textureMapPlanFromMaps(files.maps);
  if (!plan.length) throw new Error("No downloadable image maps on this asset");

  // Prefer the requested format (PNG vs JPG) — they're both inside the ZIP.
  // PNG preferred when the slot is one we marked srgb=false (data maps) — but
  // actually JPG is fine here too because we tag the colour space via .meta;
  // we always pick JPG when present to keep size down, falling back to PNG.
  const written = {};
  let writtenCount = 0;
  for (const { slot, srgb } of plan) {
    // Find all entries inside the ZIP whose filename ends in _<slot>.jpg
    // (or _<slot>.png). The assetId prefix means we can match precisely.
    const candidate = Object.keys(zip.files).find((name) => {
      const e = zip.files[name];
      if (e.dir) return false;
      const lower = name.toLowerCase();
      const wantExt = lower.endsWith(".jpg") || lower.endsWith(".jpeg");
      if (!wantExt) return false;
      const klass = classifyZipEntry(name, files.id ?? safeName(name));
      return klass === slot;
    });
    if (!candidate) continue;
    const ext = candidate.split(".").pop().toLowerCase();
    const path = `${folder}/${safeName(name)}_${slot}.${ext}`;
    const bytes = await zip.files[candidate].async("uint8array");
    await writeBinary(path, bytes);
    await writeText(`${path}.meta`, JSON.stringify({ colorSpace: srgb ? "srgb" : "linear" }, null, 2));
    const { autoCompressTexture } = await import("./basisCompress.js");
    await autoCompressTexture(path).catch(() => {});
    written[slot] = path;
    writtenCount++;
    onProgress?.({
      label: `Extracted ${writtenCount}/${plan.length} maps`,
      loaded: zipBytes.byteLength,
      total: zipBytes.byteLength,
    });
  }

  if (!writtenCount) throw new Error("ZIP did not contain any of the expected map files");

  // 3. Build the .mat. Normal map selection: prefer "normal" (GL convention)
  // but fall back to "normalDX" — Three.js's NormalMap node flips Y, so GL
  // textures need no extra work. (DX textures look inverted without a flip;
  // we don't flip here — we just tag them so a future improvement can wire
  // a flip-node into the shader graph. For now GL is the primary path.)
  const graphInput = { ...written };
  if (graphInput.normalDX && !graphInput.normal) graphInput.normal = graphInput.normalDX;

  onProgress?.({ label: "Writing material…", loaded: zipBytes.byteLength, total: zipBytes.byteLength });
  const def = {
    color: "#ffffff",
    roughness: 1,
    metalness: 0,
    map: written.diffuse ?? "",
    shaderGraph: buildPbrGraph(graphInput),
  };
  const matPath = `${folder}/${safeName(name)}.mat`;
  await writeText(matPath, JSON.stringify(def, null, 2));
  await (await projectStore()).refresh();
  return matPath;
}

// ---------------------------------------------------------------------------
// HDRI download
// ---------------------------------------------------------------------------

/**
 * Downloads an ambientCG HDRI ZIP and extracts the `<assetId>_<res>_HDR.exr`
 * file into AmbientCG/<Name>/<Name>_<res>.exr. The .exr is what the engine's
 * Environment (HDRI) component loads (see EnvironmentComponent.js — it
 * already understands `.exr`). A tonemapped JPG preview lands alongside it
 * for the Assets panel thumbnail.
 *
 * Returns the .exr path.
 */
export async function downloadHdri({ name, files, res = "2K", onProgress }) {
  const entry = files?.downloads?.[res];
  if (!entry?.url) throw new Error(`No "${res}" HDRI download for this asset`);

  const dir = await ensureDownloadDir();
  const folder = `${dir}/${safeName(name)}`;
  await invoke("create_dir", { path: folder }).catch(() => {});

  onProgress?.({ label: "Downloading ZIP…", loaded: 0, total: entry.size ?? 0 });
  const zipBuffer = await proxyBytesWithProgress(entry.url, (n) => {
    onProgress?.({ label: "Downloading ZIP…", loaded: n, total: entry.size ?? 0 });
  });
  const zipBytes = new Uint8Array(zipBuffer);

  onProgress?.({ label: "Extracting…", loaded: zipBytes.byteLength, total: zipBytes.byteLength });
  const zip = await JSZip.loadAsync(zipBuffer);

  // Find the HDR file — ambientCG names them `<assetId>_<res>_HDR.exr`.
  // We pick the first .exr we see regardless of name; ambientCG only ships
  // one HDR map per ZIP.
  const hdrEntry = Object.keys(zip.files).find((name) => {
    const f = zip.files[name];
    return !f.dir && /\.exr$/i.test(name);
  });
  if (!hdrEntry) throw new Error("HDRI ZIP did not contain an .exr file");

  const bytes = await zip.files[hdrEntry].async("uint8array");
  const stem = safeName(name);
  const path = `${folder}/${stem}_${res}.exr`;
  await writeBinary(path, bytes);

  // Pull the tonemapped JPG preview too — it gives the Assets panel a
  // usable thumbnail and is what ambientCG shows on its own listing page.
  const previewEntry = Object.keys(zip.files).find((name) => {
    const f = zip.files[name];
    return !f.dir && /tonemapped/i.test(name) && /\.(jpg|jpeg|png)$/i.test(name);
  });
  if (previewEntry) {
    const previewBytes = await zip.files[previewEntry].async("uint8array");
    const ext = previewEntry.split(".").pop().toLowerCase();
    const previewPath = `${folder}/${stem}_${res}_preview.${ext}`;
    await writeBinary(previewPath, previewBytes);
    await writeText(`${previewPath}.meta`, JSON.stringify({ colorSpace: "srgb" }, null, 2));
  }

  await (await projectStore()).refresh();
  return path;
}

// ---------------------------------------------------------------------------
// 3D model download
// ---------------------------------------------------------------------------

/**
 * Downloads an ambientCG 3D model ZIP and extracts the mesh + materials +
 * texture maps into AmbientCG/<Name>/. Writes a `<Name>.prefab` whose root
 * entity has an `objModel` component pointing at the .obj / .mtl pair —
 * the runtime component (see src/modules/ambientcg/ObjModelComponent.js)
 * loads everything via the engine's normal asset resolver.
 *
 * ambientCG 3D model ZIPs ship:
 *   `<id>_<attrs>.obj`         — Wavefront mesh
 *   `<id>_<attrs>.mtl`         — companion materials (one material usually)
 *   `<id>_<attrs>_Color.jpg`   — diffuse map
 *   `<id>_<attrs>_NormalGL.jpg` / `_NormalDX.jpg`
 *   `<id>_<attrs>_Roughness.jpg`
 *   `<id>_<attrs>_AmbientOcclusion.jpg`
 *   `<id>_<attrs>.usdc`        — USD (skipped, not loadable by the engine)
 *   `<id>_<attrs>.blend`       — Blender source (skipped)
 *   `<id>.png`                 — preview thumbnail
 *
 * Returns the .prefab path.
 */
export async function downloadModel({ name, files, res = "SQ-2K-JPG", onProgress }) {
  const entry = files?.downloads?.[res];
  if (!entry?.url) throw new Error(`No "${res}" model download for this asset`);

  const dir = await ensureDownloadDir();
  const folder = `${dir}/${safeName(name)}`;
  await invoke("create_dir", { path: folder }).catch(() => {});

  onProgress?.({ label: "Downloading ZIP…", loaded: 0, total: entry.size ?? 0 });
  const zipBuffer = await proxyBytesWithProgress(entry.url, (n) => {
    onProgress?.({ label: "Downloading ZIP…", loaded: n, total: entry.size ?? 0 });
  });
  const zipBytes = new Uint8Array(zipBuffer);

  onProgress?.({ label: "Extracting…", loaded: zipBytes.byteLength, total: zipBytes.byteLength });
  const zip = await JSZip.loadAsync(zipBuffer);
  const assetId = files.id;

  // 1. Pull the .obj and .mtl text (small files; keep them in memory).
  const objEntry = Object.keys(zip.files).find((n) => !zip.files[n].dir && /\.obj$/i.test(n));
  const mtlEntry = Object.keys(zip.files).find((n) => !zip.files[n].dir && /\.mtl$/i.test(n));
  if (!objEntry) throw new Error("Model ZIP did not contain a .obj file");

  onProgress?.({ label: "Extracting mesh…", loaded: zipBytes.byteLength, total: zipBytes.byteLength });
  const objText = await zip.files[objEntry].async("string");
  let mtlText = null;
  if (mtlEntry) mtlText = await zip.files[mtlEntry].async("string");

  const stem = safeName(name);
  const objPath = `${folder}/${stem}.obj`;
  const mtlPath = `${folder}/${stem}.mtl`;
  await writeText(objPath, objText);
  if (mtlText) await writeText(mtlPath, mtlText);

  // 2. Extract the texture maps into the same folder. We only care about
  // the maps the MTL actually references; falling back to common ambientCG
  // names if the MTL is missing or empty.
  const referenced = mtlText ? listMtlTextureRefs(mtlText) : ["Color.jpg", "NormalGL.jpg"];
  let extracted = 0;
  for (const ref of referenced) {
    const refLower = ref.toLowerCase();
    const found = Object.keys(zip.files).find((n) => {
      const f = zip.files[n];
      if (f.dir) return false;
      const base = (n.split("/").pop() ?? "").toLowerCase();
      return base === refLower || base.endsWith(`_${refLower}`);
    });
    if (!found) continue;
    const bytes = await zip.files[found].async("uint8array");
    const base = found.split("/").pop();
    const ext = base.split(".").pop().toLowerCase();
    const slot = mapBaseToSlot(base, assetId);
    const outName = slot ? `${stem}_${slot}.${ext}` : base;
    const outPath = `${folder}/${outName}`;
    await writeBinary(outPath, bytes);
    // diffuse / color → sRGB; everything else (normal / roughness / AO /
    // metalness) → linear, so the runtime texture node keeps them correct.
    const srgb = slot === "diffuse";
    await writeText(`${outPath}.meta`, JSON.stringify({ colorSpace: srgb ? "srgb" : "linear" }, null, 2));
    extracted++;
  }
  onProgress?.({
    label: `Extracted ${extracted} map${extracted === 1 ? "" : "s"}`,
    loaded: zipBytes.byteLength,
    total: zipBytes.byteLength,
  });

  // 3. Write the prefab. The runtime `objModel` component reads `obj` /
  // `mtl` paths and resolves textures through the engine asset resolver.
  // A fresh guid keeps the prefab identity stable across re-imports.
  const prefabPath = `${folder}/${stem}.prefab`;
  const prefabDef = {
    prefab: 1,
    guid: `p_${assetId.toLowerCase()}_${Date.now().toString(36)}`,
    name: stem,
    root: {
      fid: "f_root",
      name: stem,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      components: [
        {
          type: "objModel",
          props: {
            obj: objPath,
            mtl: mtlPath,
            castShadow: true,
            receiveShadow: true,
          },
        },
      ],
      children: [],
    },
  };
  await writeText(prefabPath, JSON.stringify(prefabDef, null, 2));

  await (await projectStore()).refresh();
  return prefabPath;
}

/**
 * Sweeps an MTL file for texture map references. Returns the unique
 * basenames referenced (e.g. ["Color.jpg", "NormalGL.jpg", "Roughness.jpg"]).
 * ambientCG ships a single-material MTL, so dedup is enough.
 */
function listMtlTextureRefs(mtlText) {
  const refs = new Set();
  for (const line of mtlText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // map_Kd / map_Bump / map_Ks / map_Ns / map_Ke / bump — all take an
    // optional `-options` block before the filename, which we strip out.
    const m = trimmed.match(/^(?:map_[A-Za-z]+|bump|refl|decal)\s+(?:(?:-[a-z]+\s+[^ ]+\s+)*)([^ ]+)/);
    if (m) {
      const file = m[1].trim();
      // Strip a leading path component — the .mtl uses bare filenames.
      const base = file.split(/[\\/]/).pop();
      if (base) refs.add(base);
    }
  }
  return [...refs];
}

/**
 * Maps an extracted texture's basename to the slot name we use in the
 * `.prefab`. The runtime component looks for `_diffuse.jpg` /
 * `_normal.jpg` etc. when applying PBR maps; non-matches fall through to
 * the MTL's literal filename reference. Returns null when no slot applies
 * (e.g. preview thumbnail) — the file is still extracted, just kept under
 * its original name.
 */
function mapBaseToSlot(basename, assetId) {
  const lower = basename.toLowerCase();
  const prefix = `${assetId.toLowerCase()}_`;
  let stem = lower.replace(/\.(jpg|jpeg|png|webp)$/i, "");
  if (stem.startsWith(prefix)) stem = stem.slice(prefix.length);
  // Quality-prefixed ZIPs (e.g. SQ-2K-JPG) carry that prefix inside the
  // filename too: `<id>_sq-2k-jpg_color.jpg`. Strip everything up to and
  // including the `<fmt>-` segment so we're left with the bare map name.
  // The pattern matches "<digits>k-<fmt>-" (e.g. "1k-jpg-", "2k-png-").
  const qIdx = stem.search(/-?\d+k-(?:jpg|png)-/);
  if (qIdx >= 0) stem = stem.slice(qIdx + stem.match(/-?\d+k-(?:jpg|png)-/)[0].length);
  if (stem === "color" || stem === "diffuse" || stem === "albedo") return "diffuse";
  if (stem === "normalgl" || stem === "normal") return "normal";
  if (stem === "normaldx") return "normalDX";
  if (stem === "roughness" || stem === "rough") return "roughness";
  if (stem === "ambientocclusion" || stem === "ao") return "ao";
  if (stem === "metalness" || stem === "metallic" || stem === "metal") return "metalness";
  if (stem === "displacement" || stem === "height" || stem === "bump") return "displacement";
  return null;
}

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

/**
 * Resolution attribute schemes per ambientCG dataType. ambientCG uses three
 * flavours: materials use `<res>-<fmt>` (JPG preferred for size), 3D models
 * use `<quality>-<res>-<fmt>` (LQ / SQ / HQ prefixes), and HDRIs use plain
 * `<res>` (no format — the .exr lives alone in each ZIP). Sorted
 * small-to-large so `pickResolution` can pick "nearest >= requested".
 */
const RES_ATTRS = {
  Material: ["1K-JPG", "2K-JPG", "4K-JPG", "8K-JPG", "1K-PNG", "2K-PNG", "4K-PNG", "8K-PNG"],
  HDRI: ["1K", "2K", "4K", "8K", "12K", "16K"],
  "3DModel": [
    "LQ-1K-JPG", "LQ-2K-JPG", "LQ-4K-JPG",
    "SQ-1K-JPG", "SQ-2K-JPG", "SQ-4K-JPG",
    "HQ-1K-JPG", "HQ-2K-JPG", "HQ-4K-JPG",
    "LQ-1K-PNG", "LQ-2K-PNG", "LQ-4K-PNG",
    "SQ-1K-PNG", "SQ-2K-PNG", "SQ-4K-PNG",
    "HQ-1K-PNG", "HQ-2K-PNG", "HQ-4K-PNG",
  ],
};

/** Default attribute for each kind — what the panel preselects. */
export const RES_DEFAULTS = {
  Material: "1K-JPG",
  HDRI: "2K",
  "3DModel": "SQ-2K-JPG",
};

/** Resolutions actually offered for this asset, in canonical order. */
export function availableResolutions(downloads) {
  if (!downloads) return [];
  const order = RES_ATTRS.Material; // same shape: ordered list of attributes
  return Object.keys(downloads).sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/** Picks `res` from an availability map, else the nearest available. */
export function pickResolution(downloads, res) {
  if (!downloads) return null;
  if (downloads[res]) return res;
  const order = RES_ATTRS.Material;
  const wantIdx = order.indexOf(res);
  const available = availableResolutions(downloads);
  if (wantIdx < 0) return available[0] ?? null;
  return (
    available.find((r) => order.indexOf(r) >= wantIdx) ??
    available[available.length - 1] ??
    null
  );
}