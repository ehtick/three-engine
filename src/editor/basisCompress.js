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

/**
 * Which codec this texture wants — see `compress_texture_basis` for what each
 * mode does and what picking wrong costs.
 *
 * THE SIGNAL ALREADY EXISTS AND ALWAYS DID: `colorSpace` has been written into
 * every `.meta` since import (`glbImport.js` — `srgb` for diffuse/emissive,
 * `linear` for every data map), and so have PolyHaven, ambientCG and itch.io.
 * That single field separates colour from data, which is the distinction ETC1S
 * cares about. So this needs no new metadata and no re-import.
 *
 * Normals need a third answer and `colorSpace` cannot give it — a normal map
 * and an ORM map are both linear. The importer names files by ROLE for an
 * unrelated reason ("<material> normal", "<material> orm" — so one source image
 * used by two slots cannot race onto one path), and that naming is what makes
 * the existing asset sets classifiable without re-importing them. It is a
 * heuristic on the name and it is allowed to be: guessing "linear" for a normal
 * map still gets UASTC, which is the part that matters. `usage` in the meta
 * wins when present, for callers who know better than the filename.
 */
export function basisModeFor(path, meta) {
  const usage = String(meta?.usage ?? "").toLowerCase();
  if (usage === "normal" || usage === "linear" || usage === "srgb") return usage;
  const name = basename(path).toLowerCase();
  const isNormal = /(^|[ \-_.])(normal|normals|nrm|norm|nor)([ \-_.]|$)/.test(name);
  if (meta?.colorSpace === "linear") return isNormal ? "normal" : "linear";
  if (meta?.colorSpace === "srgb") return "srgb";
  // No colorSpace recorded (hand-dropped PNGs, older imports): the name is all
  // there is. Colour is the safe default — see the Rust side's fallback note.
  if (isNormal) return "normal";
  return /(^|[ \-_.])(orm|arm|rough|roughness|metal|metalness|metallic|ao|occlusion|spec|specular|gloss|glossiness|displace|height|bump|mask|opacity|alpha)([ \-_.]|$)/.test(name)
    ? "linear"
    : "srgb";
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

async function compressTextureBasisImpl(path, knownMeta) {
  // The meta is read BEFORE encoding, not after: it is what decides the codec.
  // `writeMeta` re-reads and merges, so a null here only costs the mode guess
  // its best signal — it cannot lose the file's other settings.
  const meta = knownMeta ?? (await readAssetMeta(`${path}.meta`));
  const mode = basisModeFor(path, meta);
  const info = await invoke("compress_texture_basis", { path, mode });
  invalidateBlobUrl(`${path}.basis`);
  // `mode` is recorded so a later reader can tell which codec produced this
  // derivative without re-deriving the guess — and so a re-encode after the
  // rules change is a diff rather than an archaeology exercise.
  await writeMeta(path, { enabled: true, mode, ...info });
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

/**
 * Compresses every texture that has not explicitly opted out.
 *
 * ⚠ `force` EXISTS BECAUSE THE OPT-OUT AND THE DAMAGE CONTROL ARE THE SAME BIT.
 *
 * When the ETC1S-for-everything bug was found (plan §12.78), the mitigation was
 * to set `basis.enabled = false` on all 69 affected maps so the originals would
 * load. That is indistinguishable, in the meta, from a user deciding "never
 * compress this one" — so once the encoder was fixed, this function skipped
 * every single texture that needed re-encoding and returned `{compressed: 0}`.
 * The user saw texture memory move 1.02 GB → 969 MB and reasonably asked
 * whether the fix had worked. It had; nothing had run it.
 *
 * So: `force` re-encodes opted-out textures too, and `skipped` is REPORTED
 * rather than silent — a bulk operation that does nothing must say so.
 */
export async function compressAllProjectTextures({ force = false } = {}) {
  return useAssetProcessingStore.getState().track(
    force ? "Re-compressing project textures…" : "Compressing project textures…",
    () => compressAllProjectTexturesImpl({ force }),
  );
}

async function compressAllProjectTexturesImpl({ force = false } = {}) {
  const root = useProjectStore.getState().rootPath;
  if (!root) return { compressed: 0, failed: 0, skipped: 0 };
  const paths = await listProjectAssets(root, TEXTURE_EXTENSIONS, 20);
  let compressed = 0;
  let failed = 0;
  let skipped = 0;
  let restaled = 0;
  for (const path of paths) {
    const meta = await readAssetMeta(`${path}.meta`);
    if (meta?.basis?.enabled === false && !force) {
      skipped++;
      continue;
    }
    // A derivative written before the codec rules existed carries no `mode`;
    // one written under different rules carries the wrong one. Both mean the
    // file on disk is not what this pipeline would produce today.
    if (meta?.basis && meta.basis.mode !== basisModeFor(path, meta)) restaled++;
    try {
      await compressTextureBasisImpl(path, meta);
      compressed++;
    } catch (err) {
      failed++;
      console.warn(`Basis compression skipped for ${path}: ${err.message ?? err}`);
    }
  }
  if (skipped) {
    console.info(
      `[basis] ${skipped} texture(s) skipped — they carry basis.enabled:false. ` +
        "Pass force to re-encode them (see compressAllProjectTextures).",
    );
  }
  return { compressed, failed, skipped, staleRecoded: restaled };
}

/** Import hook: the module is a global default, explicit asset opt-out wins. */
export async function autoCompressTexture(path) {
  if (!isBasisEnabled()) return null;
  const meta = await readAssetMeta(`${path}.meta`);
  if (meta?.basis?.enabled === false) return null;
  return compressTextureBasis(path);
}
