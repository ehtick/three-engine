import { useModulesStore } from "./modules.js";
import { useProjectStore } from "./store/projectStore.js";
import { useAssetProcessingStore } from "./store/assetProcessingStore.js";
import { basename } from "./store/projectStore.js";
import {
  invalidateBlobUrl,
  listProjectAssets,
  readAssetMeta,
  TEXTURE_EXTENSIONS,
} from "./assetLoader.js";

async function invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

export function isBasisEnabled() {
  return useModulesStore.getState().enabled.includes("basis");
}

/**
 * Merges the `basis` block into the texture's existing `.meta` — and REFUSES
 * to write if that meta exists but could not be read.
 *
 * `readAssetMeta` returns null for both "no meta file" and "the read or the
 * JSON parse failed", and spreading null into `{}` turns the second case into
 * a silent overwrite of every other key. That is not hypothetical: the user's
 * banner Sponza came out of a compress-all pass with all 69 metas reduced to
 * `{"basis": {...}}`, losing the glTF importer's `flipY: false` and
 * `colorSpace: "linear"`. Both losses are invisible while every map is
 * compressed (a compressed texture cannot be flipped at upload, so they all
 * agreed) and both bite the moment one map is not: the PNG came back flipped
 * against its own KTX2 albedo — "the metallic roughness map is slipped, not
 * matching the albedo" — while normal/ORM maps quietly started being
 * sRGB-decoded as colour. An asset pipeline may not lose import settings.
 */
async function writeMeta(path, basis) {
  const metaPath = `${path}.meta`;
  let current = {};
  let raw = null;
  try {
    raw = await invoke("read_text_file", { path: metaPath });
  } catch {
    raw = null; // no sidecar yet — this compress creates the first one
  }
  if (raw != null) {
    try {
      current = JSON.parse(raw) ?? {};
    } catch (err) {
      throw new Error(
        `${basename(path)}: its .meta is present but unreadable (${err?.message ?? err}) — ` +
          "refusing to compress, because writing would drop flipY / colorSpace / wrap settings. " +
          "Fix or delete the .meta and retry.",
      );
    }
  }
  const next = { ...current, basis };
  await invoke("save_scene", {
    path: metaPath,
    contents: JSON.stringify(next, null, 2),
  });
  return next;
}

/** Compresses a texture source without replacing it. */
export async function compressTextureBasis(path) {
  return useAssetProcessingStore.getState().track(
    (p) => `Compressing ${basename(p)}…`,
    (p) => compressTextureBasisImpl(p),
    path,
  );
}

async function compressTextureBasisImpl(path) {
  const info = await invoke("compress_texture_basis", { path });
  invalidateBlobUrl(`${path}.basis`);
  await writeMeta(path, { enabled: true, ...info });
  return info;
}

/** Applies the inspector override and creates/removes its derivative. */
export async function setTextureBasisEnabled(path, enabled) {
  if (enabled && !isBasisEnabled()) {
    throw new Error("Enable the Basis Compression module first");
  }
  if (enabled) return compressTextureBasis(path);
  await invoke("delete_path", { path: `${path}.basis` }).catch(() => {});
  invalidateBlobUrl(`${path}.basis`);
  await writeMeta(path, { enabled: false });
  return null;
}

/** Compresses every texture that has not explicitly opted out. */
export async function compressAllProjectTextures() {
  return useAssetProcessingStore.getState().track(
    "Compressing project textures…",
    () => compressAllProjectTexturesImpl(),
  );
}

async function compressAllProjectTexturesImpl() {
  const root = useProjectStore.getState().rootPath;
  if (!root) return { compressed: 0, failed: 0 };
  const paths = await listProjectAssets(root, TEXTURE_EXTENSIONS, 20);
  let compressed = 0;
  let failed = 0;
  for (const path of paths) {
    const meta = await readAssetMeta(`${path}.meta`);
    if (meta?.basis?.enabled === false) continue;
    try {
      await compressTextureBasisImpl(path);
      compressed++;
    } catch (err) {
      failed++;
      console.warn(`Basis compression skipped for ${path}: ${err.message ?? err}`);
    }
  }
  return { compressed, failed };
}

/** Import hook: the module is a global default, explicit asset opt-out wins. */
export async function autoCompressTexture(path) {
  if (!isBasisEnabled()) return null;
  const meta = await readAssetMeta(`${path}.meta`);
  if (meta?.basis?.enabled === false) return null;
  return compressTextureBasis(path);
}
