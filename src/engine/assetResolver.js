// The runtime never talks to Tauri/fs directly (so exported games can serve
// assets over plain HTTP). The editor swaps in a resolver at startup that
// turns project file paths into loadable blob: URLs.
let resolve = async (path) => path;

export function setAssetResolver(fn) {
  resolve = fn;
}

export function resolveAssetUrl(path) {
  return resolve(path);
}

// Sidecar `<asset>.meta` JSON (texture import settings etc.). The default
// loader returns null (no settings); the editor reads the file over Tauri,
// the player fetches it over HTTP.
let loadMeta = async () => null;

export function setAssetMetaLoader(fn) {
  loadMeta = fn;
}

export async function loadAssetMeta(path) {
  try {
    return await loadMeta(path);
  } catch {
    return null;
  }
}

// Sidecar binary WRITER (derived data like baked mesh SDFs). Editor wires
// this to Tauri fs; the player has no writer — derived data is load-only
// there, and callers must treat a false return as "not persisted".
let saveBinary = async () => false;

export function setAssetBinarySaver(fn) {
  saveBinary = fn;
}

export async function saveAssetBinary(path, bytes) {
  try {
    return await saveBinary(path, bytes);
  } catch (error) {
    console.warn(`[assets] binary save failed (${path}):`, error?.message ?? error);
    return false;
  }
}

// Project-level DERIVED DATA directory (e.g. `<project>/Library`). Content-
// hash-keyed artifacts that belong to no single asset file — baked SDFs of
// primitive/GLB-internal geometries — live under it. The editor wires a
// synchronous provider reading the open project's root; the player wires
// its export layout. Null = no project open → callers keep session caches.
let derivedDataRoot = () => null;

export function setDerivedDataRootProvider(fn) {
  derivedDataRoot = fn;
}

export function getDerivedDataPath(relativeKey) {
  try {
    const root = derivedDataRoot();
    return root ? `${String(root).replace(/[\\/]$/, "")}/${relativeKey}` : null;
  } catch {
    return null;
  }
}

// Same idea for script components: the editor supplies a loader that reads
// a script file, wraps it as an ES module, and reports a version so callers
// can tell whether the file changed since the last load (hot reload).
let loadScript = async () => ({ default: null, version: null });

export function setScriptLoader(fn) {
  loadScript = fn;
}

export function loadScriptModule(path) {
  return loadScript(path);
}
