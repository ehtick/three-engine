/** Official Sketchfab Data API v3 client and authenticated GLTF importer. */
import JSZip from "jszip";
import { packGlb } from "./polyhaven.js";
import { writeBinaryFile } from "./assetLoader.js";

const API = "https://api.sketchfab.com/v3";
const TOKEN_KEY = "engine.sketchfabToken.v1";

async function invoke(cmd, args) {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke(cmd, args);
}

async function apiJson(url, token = null) {
  const text = await invoke("fetch_sketchfab_text", { url, token: token || null });
  return JSON.parse(text);
}

export const getSavedToken = () => localStorage.getItem(TOKEN_KEY) ?? "";

export function clearSavedToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export async function validateAndSaveToken(token) {
  const value = token.trim();
  if (!value) throw new Error("Enter a Sketchfab token");
  const me = await apiJson(`${API}/me`, value);
  localStorage.setItem(TOKEN_KEY, value);
  return me.displayName ?? me.username ?? "Sketchfab user";
}

const thumbnail = (item, target = 512) => {
  const images = item.thumbnails?.images ?? [];
  return [...images].sort(
    (a, b) => Math.abs((a.width ?? 0) - target) - Math.abs((b.width ?? 0) - target),
  )[0]?.url ?? null;
};

const normalise = (item) => ({
  id: item.uid,
  name: item.name || "Untitled model",
  description: item.description ?? "",
  author: item.user?.displayName ?? item.user?.username ?? "Unknown creator",
  authorUrl: item.user?.profileUrl ?? null,
  sourceUrl: item.viewerUrl ?? `https://sketchfab.com/3d-models/${item.uid}`,
  license: item.license?.label ?? "License not specified",
  licenseUrl: item.license?.url ?? null,
  thumbnailUrl: thumbnail(item),
  categories: (item.categories ?? []).map((category) => category.name).filter(Boolean),
  tags: (item.tags ?? []).map((tag) => tag.name).filter(Boolean),
  views: item.viewCount ?? 0,
  likes: item.likeCount ?? 0,
  faces: item.faceCount ?? 0,
  animated: (item.animationCount ?? 0) > 0,
});

export async function searchModels(query = "", nextUrl = null) {
  const url = nextUrl
    ? nextUrl
    : `${API}/search?${new URLSearchParams({
        type: "models",
        downloadable: "true",
        count: "24",
        q: query.trim(),
      })}`;
  const data = await apiJson(url);
  return {
    models: (data.results ?? []).map(normalise),
    next: data.next ?? null,
  };
}

async function proxyBytes(url) {
  const value = await invoke("fetch_bytes", { url });
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return new Uint8Array(value);
  throw new Error("Sketchfab download returned an unexpected response");
}

const safeName = (name) => name.replace(/[^\w\- ]+/g, "_").trim() || "Unnamed";
const normalPath = (path) => path.replace(/\\/g, "/").replace(/^\.\//, "");

export function buildAttribution(model) {
  return [
    `# ${model.name}`,
    "",
    `Creator: ${model.author}`,
    model.authorUrl ? `Creator profile: ${model.authorUrl}` : null,
    `Source: ${model.sourceUrl}`,
    `License: ${model.license}`,
    model.licenseUrl ? `License details: ${model.licenseUrl}` : null,
    "",
    "Downloaded from Sketchfab. Preserve this attribution with the asset and derived works.",
  ].filter((line) => line !== null).join("\n");
}

/** Converts the official GLTF ZIP layout into one self-contained GLB. */
export async function packSketchfabArchive(zipBytes) {
  const zip = await JSZip.loadAsync(zipBytes);
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  const gltfEntry = entries.find((entry) => /(?:^|\/)scene\.gltf$/i.test(entry.name))
    ?? entries.find((entry) => /\.gltf$/i.test(entry.name));
  if (!gltfEntry) throw new Error("Sketchfab archive did not contain a GLTF scene");

  const gltfName = normalPath(gltfEntry.name);
  const base = gltfName.includes("/") ? gltfName.slice(0, gltfName.lastIndexOf("/") + 1) : "";
  const resources = new Map();
  for (const entry of entries) {
    const name = normalPath(entry.name);
    if (name === gltfName || (base && !name.startsWith(base))) continue;
    const relative = base ? name.slice(base.length) : name;
    resources.set(relative, await entry.async("uint8array"));
  }
  const json = JSON.parse(await gltfEntry.async("string"));
  return packGlb(json, resources);
}

/** Downloads Sketchfab's temporary GLTF ZIP, packs it to GLB, and imports it. */
export async function downloadModel(model, onProgress) {
  const token = getSavedToken();
  if (!token) throw new Error("Connect a Sketchfab token before downloading");
  const { useProjectStore } = await import("./store/projectStore.js");
  const root = useProjectStore.getState().rootPath;
  if (!root) throw new Error("Open a project first");

  onProgress?.({ label: "Authorizing download…", loaded: 0, total: 0 });
  const download = await apiJson(`${API}/models/${encodeURIComponent(model.id)}/download`, token);
  const archive = download.gltf;
  if (!archive?.url) throw new Error("Sketchfab did not provide a GLTF download for this model");

  onProgress?.({ label: "Downloading GLTF archive…", loaded: 0, total: archive.size ?? 0 });
  const zipBytes = await proxyBytes(archive.url);
  onProgress?.({ label: "Extracting archive…", loaded: zipBytes.byteLength, total: zipBytes.byteLength });
  const glb = await packSketchfabArchive(zipBytes);

  const importDir = `${root}/Sketchfab`;
  await invoke("create_dir", { path: importDir }).catch(() => {});
  const glbPath = `${importDir}/${safeName(model.name)}.glb`;
  await writeBinaryFile(glbPath, glb);

  onProgress?.({ label: "Importing model…", loaded: zipBytes.byteLength, total: zipBytes.byteLength });
  const { unpackGlb } = await import("./glbImport.js");
  const folder = (await unpackGlb(glbPath)) ?? importDir;
  await invoke("save_scene", { path: `${folder}/ATTRIBUTION.md`, contents: buildAttribution(model) });
  await useProjectStore.getState().refresh();
  return folder;
}

export async function openModelPage(model) {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(model.sourceUrl);
}

export async function openTokenPage() {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl("https://sketchfab.com/settings/password");
}
