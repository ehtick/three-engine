/**
 * itch.io integration: personal-API-key auth, the owned/purchased library,
 * and a generic asset importer for whatever a download turns out to contain.
 *
 * Unlike Poly Haven/AmbientCG (open CC0 catalogs) or Sketchfab (one fixed
 * GLTF-ZIP shape per download), itch.io asset packs have no manifest — a
 * "download" can be a single PNG, a WAV, a GLB, or a ZIP with an arbitrary
 * mix of sprites/audio/fonts/docs/binaries. So there is no per-kind importer
 * here like `downloadTexture`/`downloadModel`/`downloadHdri` in polyhaven.js
 * — instead `downloadAndImport` walks whatever it receives and classifies
 * each file by extension, importing what the engine understands and copying
 * the rest through untouched. That's an honest description of what "import"
 * can mean for an arbitrary itch.io download; anything cleverer would be
 * guessing at content the API doesn't describe.
 *
 * Auth: itch.io API keys (from https://itch.io/user/settings) are unscoped
 * bearer tokens — one credential covers every endpoint, same tradeoff as the
 * Sketchfab token (plaintext localStorage, no OS keychain yet; see
 * aiPrefs.js for the standing justification). The key never touches a
 * browser `fetch` — it's attached server-side by the Rust `fetch_itchio_text`
 * command, which also hardcodes the `api.itch.io` host so the key can't leak
 * to an arbitrary URL.
 *
 * Endpoint note: `/profile/owned-keys`, `/games/{id}/uploads` and
 * `/uploads/{id}/download` are not in itch.io's published API reference —
 * they're the same endpoints the official itch.io desktop app calls,
 * reverse-engineered by the community and stable for years but with no
 * compatibility guarantee. `/profile`, `/profile/games` and
 * `/games/{id}/download_keys` are documented. If itch.io ever reshapes a
 * response, the field-name guards below (`??` chains) are where to adjust.
 */
import JSZip from "jszip";
import { writeBinaryFile } from "./assetLoader.js";

const API = "https://api.itch.io";
const TOKEN_KEY = "engine.itchioToken.v1";

async function invoke(cmd, args) {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke(cmd, args);
}

async function apiJson(path, { token = null, params = null } = {}) {
  const url = params ? `${API}${path}?${new URLSearchParams(params)}` : `${API}${path}`;
  const text = await invoke("fetch_itchio_text", { url, token: token || getSavedToken() || null });
  const data = JSON.parse(text);
  // itch.io reports refusals in-band: HTTP 200 with `{"errors":["…"]}`. The
  // Rust proxy only rejects non-2xx, so without this a denied request would
  // fall through and surface as a baffling "cannot read property of
  // undefined" three frames later instead of itch.io's own explanation.
  const errors = asArray(data?.errors);
  if (errors.length) throw new Error(`itch.io: ${errors.join("; ")}`);
  return data;
}

async function projectStore() {
  return (await import("./store/projectStore.js")).useProjectStore.getState();
}

/**
 * itch.io's backend serializes an empty result set as `{}` rather than `[]`
 * (a Lua-table-to-JSON quirk — an empty table has no way to know it "should"
 * have been an array), so `owned_keys`/`games`/`uploads` come back as an
 * empty object whenever there's nothing to list, not an empty array. `??`
 * doesn't catch this — `{}` is neither null nor undefined — so every list
 * read in this file goes through here instead of a bare `?? []`.
 */
function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const getSavedToken = () => localStorage.getItem(TOKEN_KEY) ?? "";

export function clearSavedToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export async function validateAndSaveToken(token) {
  const value = token.trim();
  if (!value) throw new Error("Enter an itch.io API key");
  const data = await apiJson("/profile", { token: value });
  localStorage.setItem(TOKEN_KEY, value);
  return data.user?.display_name ?? data.user?.username ?? "itch.io user";
}

// ---------------------------------------------------------------------------
// Library — games/assets the user owns or has purchased
// ---------------------------------------------------------------------------

const normalizeGame = (g) => ({
  id: g?.id ?? null,
  title: g?.title || "Untitled",
  url: g?.url ?? null,
  coverUrl: g?.cover_url ?? null,
  author: g?.user?.display_name ?? g?.user?.username ?? null,
  type: g?.type ?? "default",
  minPrice: g?.min_price ?? 0,
  platforms: {
    windows: !!g?.p_windows,
    linux: !!g?.p_linux,
    osx: !!g?.p_osx,
    android: !!g?.p_android,
  },
});

/**
 * One page of the caller's owned/purchased/claimed library. Each entry
 * carries a `downloadKeyId` — itch.io's uploads/download endpoints for a
 * game the caller doesn't themselves publish require that key alongside the
 * bearer token, mirroring how the itch.io app fetches a purchased game.
 */
export async function fetchLibrary(page = 1) {
  const data = await apiJson("/profile/owned-keys", { params: { page: String(page) } });
  const keys = asArray(data.owned_keys ?? data.ownedKeys);
  const games = keys
    .filter((k) => k?.game)
    .map((k) => ({ ...normalizeGame(k.game), downloadKeyId: k.id }));
  return { games, nextPage: games.length > 0 ? page + 1 : null };
}

/** Games the caller publishes themselves — the Publish tab's game picker. */
export async function fetchMyGames() {
  const data = await apiJson("/profile/games");
  return asArray(data.games).map(normalizeGame);
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

const normalizeUpload = (u) => ({
  id: u?.id,
  filename: u?.filename ?? "",
  displayName: u?.display_name || u?.filename || `Upload ${u?.id ?? ""}`,
  size: u?.size ?? 0,
  type: u?.type ?? "default",
  platforms: {
    windows: !!u?.p_windows,
    linux: !!u?.p_linux,
    osx: !!u?.p_osx,
    android: !!u?.p_android,
  },
});

/** Every file offered for a game. `downloadKeyId` is required for games the caller doesn't publish. */
export async function fetchUploads(gameId, downloadKeyId = null) {
  const params = downloadKeyId ? { download_key_id: String(downloadKeyId) } : undefined;
  const data = await apiJson(`/games/${gameId}/uploads`, { params });
  return asArray(data.uploads).map(normalizeUpload);
}

/** Resolves a short-lived signed URL for one upload's bytes. */
async function resolveDownloadUrl(uploadId, downloadKeyId = null) {
  const params = downloadKeyId ? { download_key_id: String(downloadKeyId) } : undefined;
  const data = await apiJson(`/uploads/${uploadId}/download`, { params });
  const url = data.url ?? data.download?.url;
  if (!url) throw new Error("itch.io did not return a download URL for this upload");
  return url;
}

// ---------------------------------------------------------------------------
// Byte fetch (generic proxy — no auth needed once we have the signed URL)
// ---------------------------------------------------------------------------

async function proxyBytes(url) {
  const value = await invoke("fetch_bytes", { url });
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return new Uint8Array(value);
  throw new Error("itch.io download returned an unexpected response");
}

// ---------------------------------------------------------------------------
// Import classification
// ---------------------------------------------------------------------------

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);
const AUDIO_EXT = new Set(["wav", "mp3", "ogg"]);
const MODEL_EXT = new Set(["glb"]); // .gltf ships as loose JSON+bin+textures; not worth reassembling here
// Never worth importing — build artefacts and installers a "download & import"
// button has no business unpacking into a project's asset tree.
const SKIP_EXT = new Set([
  "exe", "app", "dmg", "deb", "rpm", "appimage", "msi", "apk",
  "html", "htm", "js", "css", // web game builds — not assets
]);

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : "";
}

const safeName = (name) => String(name).replace(/[^\w\- ]+/g, "_").trim() || "Unnamed";
const normalPath = (path) => path.replace(/\\/g, "/").replace(/^\.\//, "");

/** Heuristic srgb/linear split — itch.io ships no colour-space metadata. */
function isDataMap(basename) {
  return /normal|rough|metal|_ao\.|ambientocclusion|height|displacement|_mask\./i.test(basename);
}

async function writeBinary(path, bytes) {
  await writeBinaryFile(path, bytes);
}

async function writeText(path, contents) {
  await invoke("save_scene", { path, contents });
}

/**
 * Classifies and writes one extracted file. Returns "imported" | "copied" |
 * "skipped" for the caller's summary. Images get a `.meta` colour-space tag
 * (best-effort filename heuristic — itch.io asset packs rarely ship PBR sets,
 * but sprite packs sometimes bundle a normal map); everything else the
 * engine can load (audio, .glb) is written as-is; installers/build output
 * are dropped instead of cluttering the project.
 */
async function importOneFile(folder, relPath, bytes) {
  const ext = extOf(relPath);
  if (SKIP_EXT.has(ext)) return "skipped";
  const outPath = `${folder}/${relPath}`;
  if (IMAGE_EXT.has(ext)) {
    await writeBinary(outPath, bytes);
    await writeText(`${outPath}.meta`, JSON.stringify({ colorSpace: isDataMap(relPath) ? "linear" : "srgb" }, null, 2));
    return "imported";
  }
  if (AUDIO_EXT.has(ext)) {
    await writeBinary(outPath, bytes);
    return "imported";
  }
  if (MODEL_EXT.has(ext)) {
    await writeBinary(outPath, bytes);
    // Same final step as the Sketchfab importer: unpack into a prefab +
    // extracted materials/textures rather than leaving a bare .glb behind.
    const { unpackGlb } = await import("./glbImport.js");
    await unpackGlb(outPath).catch(() => {}); // best-effort — a malformed glb still stays on disk
    return "imported";
  }
  // Everything else (fonts, docs, .json data, unrecognised binaries) — keep
  // it alongside the imported assets rather than silently dropping it.
  await writeBinary(outPath, bytes);
  return "copied";
}

async function ensureDir(path) {
  await invoke("create_dir", { path }).catch(() => {});
}

/** Project-relative `Itchio/<Game>/` folder (created on demand). */
async function ensureGameDir(gameTitle) {
  const root = (await projectStore()).rootPath;
  if (!root) throw new Error("Open a project first");
  const dir = `${root}/Itchio/${safeName(gameTitle)}`;
  await ensureDir(`${root}/Itchio`);
  await ensureDir(dir);
  return dir;
}

export function buildAttribution(game, upload) {
  return [
    `# ${game.title}`,
    "",
    `Upload: ${upload.displayName}`,
    game.author ? `Creator: ${game.author}` : null,
    game.url ? `Source: ${game.url}` : null,
    "",
    "Downloaded from itch.io. Check the page above for the",
    "asset's actual license/usage terms before shipping it — itch.io does not",
    "expose that as structured data, so this file can't fill it in for you.",
  ].filter((line) => line !== null).join("\n");
}

/**
 * Downloads one upload, imports what the engine understands, copies the
 * rest, and drops installers/build output. Returns
 * `{ folder, imported, copied, skipped }` file counts.
 */
export async function downloadAndImport({ game, upload, downloadKeyId, onProgress }) {
  const url = await resolveDownloadUrl(upload.id, downloadKeyId);
  onProgress?.({ label: "Downloading…", loaded: 0, total: upload.size ?? 0 });
  const bytes = await proxyBytes(url);
  onProgress?.({ label: "Downloading…", loaded: bytes.byteLength, total: upload.size || bytes.byteLength });

  const folder = await ensureGameDir(game.title);
  const uploadDir = `${folder}/${safeName(upload.displayName)}`;
  await ensureDir(uploadDir);

  const counts = { imported: 0, copied: 0, skipped: 0 };
  const isZip = extOf(upload.filename) === "zip" || extOf(upload.displayName) === "zip";

  if (isZip) {
    onProgress?.({ label: "Extracting archive…", loaded: bytes.byteLength, total: bytes.byteLength });
    const zip = await JSZip.loadAsync(bytes);
    const entries = Object.values(zip.files).filter((e) => !e.dir);
    let done = 0;
    for (const entry of entries) {
      const rel = normalPath(entry.name);
      const fileBytes = await entry.async("uint8array");
      const outcome = await importOneFile(uploadDir, rel, fileBytes);
      counts[outcome]++;
      done++;
      onProgress?.({ label: `Imported ${done}/${entries.length} files`, loaded: bytes.byteLength, total: bytes.byteLength });
    }
  } else {
    const outcome = await importOneFile(uploadDir, safeName(upload.filename || upload.displayName), bytes);
    counts[outcome]++;
  }

  onProgress?.({ label: "Writing attribution…", loaded: bytes.byteLength, total: bytes.byteLength });
  await writeText(`${uploadDir}/ATTRIBUTION.md`, buildAttribution(game, upload));
  await (await projectStore()).refresh();
  return { folder: uploadDir, ...counts };
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

export async function openGamePage(game) {
  if (!game.url) return;
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(game.url);
}

/** The account settings page where itch.io API keys are generated. */
export async function openApiKeyPage() {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl("https://itch.io/user/settings");
}

/** The creator dashboard page for uploading a build to one of the caller's own games. */
export async function openGameEditPage(game) {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(game.id ? `https://itch.io/game/edit/${game.id}` : "https://itch.io/dashboard");
}
