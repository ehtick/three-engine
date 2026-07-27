import { WebIO } from "@gltf-transform/core";
import { KHRDracoMeshCompression } from "@gltf-transform/extensions";
import { draco } from "@gltf-transform/functions";
import { getDracoWasm } from "./dracoWasm.js";
import { useModulesStore } from "./modules.js";
import { useAssetProcessingStore } from "./store/assetProcessingStore.js";
import { basename } from "./store/projectStore.js";
import { writeBinaryFile } from "./assetLoader.js";

/**
 * Editor-side Draco compression of imported models (enabled by the "draco"
 * module). Compresses a .glb in place and records the size reduction in a
 * `<glb>.meta` sidecar so the Assets panel can label it. Runtime decoding is
 * handled separately by the shared GLTF loader (src/engine/gltfLoader.js).
 */

async function invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** True when the draco module is enabled for the current project. */
export function isDracoEnabled() {
  return useModulesStore.getState().enabled.includes("draco");
}

let ioPromise = null;

async function getIO() {
  if (!ioPromise) {
    ioPromise = (async () => {
      const { encoder, decoder } = await getDracoWasm();
      return new WebIO().registerExtensions([KHRDracoMeshCompression]).registerDependencies({
        "draco3d.encoder": encoder,
        "draco3d.decoder": decoder,
      });
    })();
  }
  return ioPromise;
}

/** Reads a sidecar .meta (or {}), merges `draco`, writes it back. */
async function writeDracoMeta(glbPath, dracoInfo) {
  const metaPath = `${glbPath}.meta`;
  let meta = {};
  try {
    meta = JSON.parse(await invoke("read_text_file", { path: metaPath })) ?? {};
  } catch {
    meta = {};
  }
  meta.draco = dracoInfo;
  await invoke("save_scene", { path: metaPath, contents: JSON.stringify(meta, null, 2) });
}

/**
 * Compresses a .glb in place with Draco mesh compression. Returns
 * `{ original, compressed }` byte sizes (also written to the .meta sidecar), or
 * null if the file was already Draco-compressed. If compression doesn't shrink
 * the file it's left untouched but still labelled (compressed === original).
 */
export async function compressGlbInPlace(glbPath) {
  return useAssetProcessingStore.getState().track(
    (p) => `Draco compressing ${basename(p)}…`,
    (p) => compressGlbInPlaceImpl(p),
    glbPath,
  );
}

async function compressGlbInPlaceImpl(glbPath) {
  const io = await getIO();

  // `read_binary_file` resolves to an ArrayBuffer (raw IPC bytes).
  const buffer = await invoke("read_binary_file", { path: glbPath });
  const originalBytes = new Uint8Array(buffer);

  const doc = await io.readBinary(originalBytes);
  const alreadyDraco = doc
    .getRoot()
    .listExtensionsUsed()
    .some((ext) => ext.extensionName === "KHR_draco_mesh_compression");
  if (alreadyDraco) return null;

  await doc.transform(draco());
  const out = await io.writeBinary(doc);

  // Keep the compressed result only if it actually saved space; some already
  // lean or point-cloud-free models can grow.
  if (out.byteLength < originalBytes.byteLength) {
    await writeBinaryFile(glbPath, out);
    const info = { original: originalBytes.byteLength, compressed: out.byteLength };
    await writeDracoMeta(glbPath, info);
    return info;
  }

  const info = { original: originalBytes.byteLength, compressed: originalBytes.byteLength };
  await writeDracoMeta(glbPath, info);
  return info;
}

/** Human-readable byte size, e.g. "2.4 MB". */
export function formatBytes(n) {
  if (!Number.isFinite(n)) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
