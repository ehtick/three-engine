/**
 * Free audio libraries: search two catalogues of game SFX and ambience and
 * import a sound into the project with its licence recorded.
 *
 *   Freesound  — ~600k sounds, the definitive SFX/ambience library. Needs a
 *                free API key (freesound.org/apiv2/apply), pasted once in the
 *                Modules panel like the itch.io and Sketchfab credentials.
 *   Commons    — Wikimedia Commons. No key at all, so the panel does something
 *                useful before anyone has signed up for anything. Weaker on
 *                designed SFX, genuinely good on field-recorded ambience.
 *
 * Auth shape: only Freesound's JSON API is authenticated, and its key is
 * attached server-side by the Rust `fetch_freesound_text` command (host-locked
 * to freesound.org) so it never rides on a JS `fetch`. Verified against the
 * live CDN: previews and waveform images are public, so `<audio>`/`<img>` can
 * point straight at them and the import download reuses the generic
 * `fetch_bytes` proxy. Commons is CORS-open and keyless but goes through the
 * same proxy anyway — one code path, and it sidesteps the webview's CSP.
 *
 * Rate limits are real: Freesound allows 60 requests/minute and 2000/day, so
 * every call here is one user action. The panel debounces; nothing prefetches.
 *
 * What we deliberately don't do: Freesound's *original* uploads require OAuth2,
 * so an import writes the `hq-mp3`/`hq-ogg` preview (128–192 kbps) instead.
 * That is what a shipped game would compress to anyway. If lossless sources
 * ever matter, the OAuth2 code flow slots in behind the same credential UI.
 *
 * **No static imports of editor infrastructure.** Everything Tauri- or
 * DOM-bound is imported at the point of use, which keeps the response
 * normalisers, licence mapping and credits merging importable under plain node
 * — that's what `npm run test:audio` exercises, and it's the same reason
 * `polyhaven.js` is written this way.
 */
const FREESOUND_API = "https://freesound.org/apiv2";
const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const TOKEN_KEY = "engine.freesoundToken.v1";

/** Everything the search needs in one request — see the "use `fields`" note in Freesound's docs. */
const FREESOUND_FIELDS = [
  "id", "name", "username", "url", "license", "duration", "channels",
  "samplerate", "filesize", "type", "tags", "previews", "images", "num_downloads",
].join(",");

const PAGE_SIZE = 30;

async function invoke(cmd, args) {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke(cmd, args);
}

async function projectStore() {
  return (await import("./store/projectStore.js")).useProjectStore.getState();
}

// ---------------------------------------------------------------------------
// Auth (Freesound only)
// ---------------------------------------------------------------------------

export const getSavedToken = () => localStorage.getItem(TOKEN_KEY) ?? "";

export function clearSavedToken() {
  localStorage.removeItem(TOKEN_KEY);
}

/**
 * Freesound has no "who am I" endpoint for token auth (`/me/` is OAuth2-only),
 * so the key is validated by doing the cheapest real search there is and
 * seeing whether it comes back. A bad key answers 401 with a JSON `detail`.
 */
export async function validateAndSaveToken(token) {
  const value = token.trim();
  if (!value) throw new Error("Enter a Freesound API key");
  await freesoundJson("/search/text/", { query: "test", page_size: "1", fields: "id" }, value);
  localStorage.setItem(TOKEN_KEY, value);
  return "Freesound";
}

export async function openApiKeyPage() {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl("https://freesound.org/apiv2/apply/");
}

export async function openSourcePage(item) {
  if (!item?.pageUrl) return;
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(item.pageUrl);
}

// ---------------------------------------------------------------------------
// Licences
// ---------------------------------------------------------------------------

/**
 * Both catalogues describe licences as free text, and Freesound's JSON returns
 * a URL where its search *filter* wants a name — so match on either. What the
 * caller actually needs to know is only ever three things: can it ship, must it
 * be credited, and is it commercial-safe.
 */
export function normalizeLicense(raw) {
  const s = String(raw ?? "").toLowerCase();
  const has = (...needles) => needles.some((n) => s.includes(n));

  if (has("publicdomain/zero", "creative commons 0", "cc0")) {
    return { id: "cc0", name: "CC0", attribution: false, commercial: true, url: "https://creativecommons.org/publicdomain/zero/1.0/" };
  }
  if (has("publicdomain/mark", "public domain")) {
    return { id: "pd", name: "Public domain", attribution: false, commercial: true, url: "https://creativecommons.org/publicdomain/mark/1.0/" };
  }
  // Order matters: every NonCommercial licence also contains "by".
  if (has("by-nc", "noncommercial", "attribution noncommercial")) {
    return { id: "by-nc", name: "CC BY-NC", attribution: true, commercial: false, url: "https://creativecommons.org/licenses/by-nc/4.0/" };
  }
  if (has("sampling+", "sampling plus")) {
    return { id: "sampling+", name: "Sampling+", attribution: true, commercial: false, url: "https://creativecommons.org/licenses/sampling+/1.0/" };
  }
  if (has("by-sa", "share alike", "sharealike")) {
    return { id: "by-sa", name: "CC BY-SA", attribution: true, commercial: true, url: "https://creativecommons.org/licenses/by-sa/4.0/" };
  }
  if (has("licenses/by", "attribution", "cc by")) {
    return { id: "by", name: "CC BY", attribution: true, commercial: true, url: "https://creativecommons.org/licenses/by/4.0/" };
  }
  return { id: "unknown", name: raw ? String(raw) : "Unknown", attribution: true, commercial: false, url: null };
}

// ---------------------------------------------------------------------------
// Freesound
// ---------------------------------------------------------------------------

async function freesoundJson(path, params, token = null) {
  const key = token || getSavedToken();
  if (!key) throw new Error("Add a Freesound API key in the Modules panel to search Freesound.");
  const url = `${FREESOUND_API}${path}?${new URLSearchParams(params)}`;
  const text = await invoke("fetch_freesound_text", { url, token: key });
  return JSON.parse(text);
}

/**
 * Freesound's filter syntax is Solr's: space-separated terms AND together, and
 * ranges are `[min TO max]`. `duration` is what separates a footstep from a
 * ten-minute forest bed, so the kind presets are duration ranges rather than
 * anything Freesound models directly — it has no "is this a sound effect"
 * field, and pretending otherwise would be inventing data.
 */
export function freesoundFilter({ cc0Only, kind, monoOnly, minDuration, maxDuration }) {
  const terms = [];
  if (cc0Only) terms.push('license:"Creative Commons 0"');
  if (monoOnly) terms.push("channels:1");
  const range = durationRange({ kind, minDuration, maxDuration });
  if (range) terms.push(`duration:[${range[0]} TO ${range[1]}]`);
  return terms.join(" ");
}

const KIND_DURATIONS = {
  sfx: [0, 15],
  ambience: [15, 3600],
  any: null,
};

function durationRange({ kind, minDuration, maxDuration }) {
  const preset = KIND_DURATIONS[kind] ?? null;
  const min = minDuration ?? preset?.[0];
  const max = maxDuration ?? preset?.[1];
  if (min == null && max == null) return null;
  return [min ?? 0, max ?? 3600];
}

const FREESOUND_SORTS = {
  relevance: "score",
  downloads: "downloads_desc",
  rating: "rating_desc",
  newest: "created_desc",
  shortest: "duration_asc",
  longest: "duration_desc",
};

export function normalizeFreesound(sound) {
  const previews = sound.previews ?? {};
  // hq-ogg is smaller than hq-mp3 at comparable quality and every browser the
  // engine targets decodes it, so it's the import; mp3 is the fallback for the
  // rare sound whose ogg preview failed to generate.
  const ogg = previews["preview-hq-ogg"] ?? previews["preview-lq-ogg"] ?? null;
  const mp3 = previews["preview-hq-mp3"] ?? previews["preview-lq-mp3"] ?? null;
  const downloadUrl = ogg ?? mp3;
  return {
    key: `freesound:${sound.id}`,
    provider: "freesound",
    id: sound.id,
    name: sound.name ?? `Sound ${sound.id}`,
    author: sound.username ?? null,
    authorUrl: sound.username ? `https://freesound.org/people/${sound.username}/` : null,
    pageUrl: sound.url ?? `https://freesound.org/s/${sound.id}/`,
    duration: sound.duration ?? 0,
    channels: sound.channels ?? null,
    sampleRate: sound.samplerate ?? null,
    tags: sound.tags ?? [],
    license: normalizeLicense(sound.license),
    // Previews stream straight from the CDN — no credentials, verified live.
    previewUrl: mp3 ?? ogg,
    waveformUrl: sound.images?.waveform_m ?? sound.images?.waveform_l ?? null,
    downloadUrl,
    downloadExt: downloadUrl === ogg ? "ogg" : "mp3",
    // The `filesize` field is the *original* upload, which is not what we
    // download. Reporting it would overstate the import by an order of
    // magnitude, so leave it null and let the download report its own size.
    downloadBytes: null,
    originalBytes: sound.filesize ?? null,
    originalFormat: sound.type ?? null,
    downloads: sound.num_downloads ?? 0,
  };
}

async function searchFreesound({ query, page, sort, ...filters }) {
  const params = {
    query: query || "",
    fields: FREESOUND_FIELDS,
    page: String(page),
    page_size: String(PAGE_SIZE),
    sort: FREESOUND_SORTS[sort] ?? "score",
  };
  const filter = freesoundFilter(filters);
  if (filter) params.filter = filter;
  const data = await freesoundJson("/search/text/", params);
  const results = (data.results ?? []).map(normalizeFreesound);
  return { results, total: data.count ?? results.length, hasMore: !!data.next };
}

// ---------------------------------------------------------------------------
// Wikimedia Commons
// ---------------------------------------------------------------------------

/** Commons returns `Artist` as a rendered HTML fragment (usually a user link). */
function stripHtml(value) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeCommons(page) {
  const info = page.imageinfo?.[0] ?? {};
  const meta = info.extmetadata ?? {};
  const title = String(page.title ?? "").replace(/^File:/, "");
  const name = stripHtml(meta.ObjectName?.value) || title.replace(/\.[a-z0-9]+$/i, "");
  // `url` arrives with analytics query params appended; they're harmless but
  // they'd end up in the saved filename, so cut them.
  const url = String(info.url ?? "").split("?")[0];
  const ext = (/\.([a-z0-9]+)$/i.exec(url)?.[1] ?? "ogg").toLowerCase();
  return {
    key: `commons:${page.pageid}`,
    provider: "commons",
    id: page.pageid,
    name,
    author: stripHtml(meta.Artist?.value) || info.user || null,
    authorUrl: null,
    pageUrl: info.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title ?? "")}`,
    duration: info.duration ?? 0,
    channels: null,
    sampleRate: null,
    tags: [],
    license: normalizeLicense(meta.LicenseShortName?.value ?? meta.UsageTerms?.value ?? meta.LicenseUrl?.value),
    previewUrl: url,
    waveformUrl: null,
    downloadUrl: url,
    downloadExt: ext,
    downloadBytes: info.size ?? null,
    originalBytes: info.size ?? null,
    originalFormat: ext,
    downloads: 0,
  };
}

/**
 * Commons has no licence facet in its search index, so `cc0Only` and the
 * duration presets are applied client-side to the page we fetched. That means
 * a filtered page can come back shorter than PAGE_SIZE — the panel pages on
 * demand, so that's honest rather than lossy.
 */
async function searchCommons({ query, page, ...filters }) {
  const params = {
    action: "query",
    format: "json",
    origin: "*",
    generator: "search",
    gsrsearch: `filetype:audio ${query || "ambience"}`.trim(),
    gsrnamespace: "6",
    gsrlimit: String(PAGE_SIZE),
    gsroffset: String((page - 1) * PAGE_SIZE),
    prop: "imageinfo",
    iiprop: "url|size|mime|user|extmetadata",
    iiextmetadatafilter: "LicenseShortName|UsageTerms|Artist|LicenseUrl|ObjectName",
  };
  const text = await invoke("fetch_text", { url: `${COMMONS_API}?${new URLSearchParams(params)}` });
  const data = JSON.parse(text);
  const pages = Object.values(data?.query?.pages ?? {});
  // `index` is the relevance order; the pages object is keyed by id and
  // arrives in arbitrary order, so without this the results reshuffle.
  pages.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  let results = pages.map(normalizeCommons).filter((item) => item.downloadUrl);
  if (filters.cc0Only) results = results.filter((item) => !item.license.attribution);
  const range = durationRange(filters);
  if (range) results = results.filter((item) => !item.duration || (item.duration >= range[0] && item.duration <= range[1]));

  return { results, total: data?.continue ? null : results.length, hasMore: !!data?.continue || pages.length === PAGE_SIZE };
}

// ---------------------------------------------------------------------------
// Internet Archive
// ---------------------------------------------------------------------------

const ARCHIVE_API = "https://archive.org";

/**
 * An Archive result is an **item**, not a sound. Items routinely hold a whole
 * pack — one "Walking Sound Effects" item is thirty footstep files — so the
 * search lists items and the import walks the item's file list. That is the
 * shape the data actually has; presenting each item as a single sound would
 * mean throwing most of it away.
 *
 * Licences on the Archive are declared by the uploader and not verified by
 * anyone. `normalizeLicense` reports what the item claims, the same as it does
 * for the other providers.
 */
function normalizeArchiveItem(doc) {
  const creator = Array.isArray(doc.creator) ? doc.creator[0] : doc.creator;
  return {
    key: `archive:${doc.identifier}`,
    provider: "archive",
    id: doc.identifier,
    name: (Array.isArray(doc.title) ? doc.title[0] : doc.title) || doc.identifier,
    author: creator ?? null,
    authorUrl: null,
    pageUrl: `${ARCHIVE_API}/details/${doc.identifier}`,
    // The search index carries no duration — it's per file, and we haven't
    // fetched the file list yet. Showing 0 would read as "empty".
    duration: 0,
    channels: null,
    sampleRate: null,
    tags: [],
    license: normalizeLicense(doc.licenseurl),
    // Both resolved lazily from /metadata on first play or on import: one
    // request per item, and only for items the user actually touches.
    previewUrl: null,
    waveformUrl: null,
    downloadUrl: null,
    downloadExt: null,
    downloadBytes: null,
    originalBytes: null,
    originalFormat: null,
    downloads: doc.downloads ?? 0,
    needsResolve: true,
  };
}

/**
 * Archive `format` strings and extensions for things the engine can actually
 * decode — deliberately not "anything that looks like audio". AIFF is the
 * notable omission: the Archive hosts plenty, and it would import cleanly and
 * then fail to play, which is a worse outcome than not offering it.
 */
const ARCHIVE_AUDIO_FORMAT = /mp3|ogg|vorbis|opus|flac|wave|wav|mpeg-4 audio|m4a|aac/i;
const AUDIO_FILE_EXT = /\.(mp3|ogg|oga|opus|flac|wav|m4a)$/i;

/**
 * The item's audio files, deduplicated.
 *
 * The Archive derives extra formats from every upload, so one source sound
 * appears as `clip.wav` (original) plus `clip.mp3` and `clip.ogg`
 * (derivatives). Importing the raw list would give you every sound three times
 * under three extensions. Files are therefore grouped by filename stem and one
 * is kept per group, preferring the upload the human actually made — the
 * Archive labels that `source: "original"`, so this uses its own metadata
 * rather than guessing from the extension.
 */
export function pickArchiveFiles(files, identifier) {
  const audio = (files ?? []).filter(
    (f) => f?.name && (ARCHIVE_AUDIO_FORMAT.test(f.format ?? "") || AUDIO_FILE_EXT.test(f.name)),
  );

  const groups = new Map();
  for (const file of audio) {
    const stem = file.name.replace(/\.[a-z0-9]+$/i, "").trim().toLowerCase();
    const existing = groups.get(stem);
    if (!existing || (file.source === "original" && existing.source !== "original")) {
      groups.set(stem, file);
    }
  }

  return [...groups.values()].map((file) => ({
    name: file.name.trim(),
    // Names can carry leading spaces and punctuation, so the segment is
    // encoded rather than pasted into the URL.
    url: `${ARCHIVE_API}/download/${encodeURIComponent(identifier)}/${encodeURIComponent(file.name)}`,
    ext: (/\.([a-z0-9]+)$/i.exec(file.name)?.[1] ?? "mp3").toLowerCase(),
    bytes: Number(file.size) || null,
    seconds: Number(file.length) || 0,
    isOriginal: file.source === "original",
  }));
}

/** Fetches one item's metadata and returns its usable audio files. */
export async function resolveArchiveFiles(identifier) {
  const text = await invoke("fetch_text", { url: `${ARCHIVE_API}/metadata/${encodeURIComponent(identifier)}` });
  const data = JSON.parse(text);
  if (!data || data.is_dark) throw new Error(`Internet Archive item "${identifier}" is not available`);
  const files = pickArchiveFiles(data.files, identifier);
  if (!files.length) throw new Error(`Internet Archive item "${identifier}" has no audio files`);
  return { files, metadata: data.metadata ?? {} };
}

/**
 * Restricting the Archive to things that are actually sound effects, and
 * actually downloadable. Both halves were learned the hard way:
 *
 * - **A bare full-text query is useless here.** The Archive is a general media
 *   archive, so `footsteps AND mediatype:audio` matches any sermon, podcast or
 *   radio drama whose *description* says "footsteps" — 2944 results, none of
 *   them a sound effect. Scoping the query to `title`/`subject` and requiring a
 *   sound-effects signal turns that into ~9 results that are all usable.
 * - **Many items 401 on download.** The metadata endpoint happily lists their
 *   files, so nothing about the file list reveals it — the item is flagged
 *   `access-restricted-item`, and excluding that in the query is the only way to
 *   avoid offering a sound that cannot be played or imported.
 */
const ARCHIVE_SFX_SCOPE =
  '(subject:("sound effects") OR title:("sound effect") OR collection:(soundeffects))';

async function searchArchive({ query, page, cc0Only, sfxOnly = true }) {
  // Solr-ish, and it is fussy: wildcards in a licenceurl term make the backend
  // answer with an Elasticsearch error rather than results, so the CC0 filter
  // is an exact match on the one URL the Archive actually stores.
  const terms = ["mediatype:audio", "-access-restricted-item:true"];
  // Scope the user's words to title/subject. Full-text matching is what drags
  // in the spoken-word archive.
  if (query) terms.push(`(title:(${query}) OR subject:(${query}))`);
  if (sfxOnly) terms.push(ARCHIVE_SFX_SCOPE);
  if (cc0Only) terms.push('licenseurl:"http://creativecommons.org/publicdomain/zero/1.0/"');

  const params = new URLSearchParams({
    q: terms.join(" AND "),
    rows: String(PAGE_SIZE),
    page: String(page),
    output: "json",
  });
  // The Archive's relevance ranking is poor on this corpus; download count is a
  // far better proxy for "is this the thing people actually wanted".
  params.append("sort[]", "downloads desc");
  for (const field of ["identifier", "title", "licenseurl", "creator", "downloads"]) params.append("fl[]", field);

  const text = await invoke("fetch_text", { url: `${ARCHIVE_API}/advancedsearch.php?${params}` });
  const data = JSON.parse(text);
  if (data?.error) throw new Error(`Internet Archive: ${data.error}`);
  const docs = data?.response?.docs ?? [];
  const total = data?.response?.numFound ?? docs.length;
  return { results: docs.map(normalizeArchiveItem), total, hasMore: page * PAGE_SIZE < total };
}

// ---------------------------------------------------------------------------
// Public search
// ---------------------------------------------------------------------------

export const PROVIDERS = [
  { id: "freesound", label: "Freesound", needsKey: true, blurb: "~600k sounds. Free API key." },
  { id: "commons", label: "Commons", needsKey: false, blurb: "Wikimedia. No key needed." },
  {
    id: "archive",
    label: "Archive",
    needsKey: false,
    blurb: "Internet Archive. No key needed. Results are whole items (often a pack of sounds); licences are declared by the uploader.",
  },
];

export const SORTS = [
  { id: "relevance", label: "Relevance" },
  { id: "downloads", label: "Most downloaded" },
  { id: "rating", label: "Highest rated" },
  { id: "newest", label: "Newest" },
  { id: "shortest", label: "Shortest" },
  { id: "longest", label: "Longest" },
];

export const KINDS = [
  { id: "sfx", label: "SFX", hint: "Under 15 seconds" },
  { id: "ambience", label: "Ambience", hint: "15 seconds and longer" },
  { id: "any", label: "Any length", hint: "No duration filter" },
];

/** One page of results from one provider. `page` is 1-based. */
export async function search({ provider = "freesound", query = "", page = 1, sort = "relevance", ...filters }) {
  const args = { query, page, sort, ...filters };
  if (provider === "commons") return searchCommons(args);
  if (provider === "archive") return searchArchive(args);
  return searchFreesound(args);
}

/**
 * One sound by id. The panel never needs this — it imports the row it already
 * has — but a scripted or MCP-driven caller has an id and nothing else, and
 * making it round-trip a whole result object through a tool call to import
 * something would be a bad API.
 */
export async function getSound(provider, id) {
  if (provider === "archive") {
    const params = new URLSearchParams({ q: `identifier:${id}`, rows: "1", page: "1", output: "json" });
    for (const field of ["identifier", "title", "licenseurl", "creator", "downloads"]) params.append("fl[]", field);
    const text = await invoke("fetch_text", { url: `${ARCHIVE_API}/advancedsearch.php?${params}` });
    const found = JSON.parse(text)?.response?.docs?.[0];
    if (!found) throw new Error(`The Internet Archive has no item "${id}"`);
    return normalizeArchiveItem(found);
  }
  if (provider === "commons") {
    const params = {
      action: "query",
      format: "json",
      origin: "*",
      pageids: String(id),
      prop: "imageinfo",
      iiprop: "url|size|mime|user|extmetadata",
      iiextmetadatafilter: "LicenseShortName|UsageTerms|Artist|LicenseUrl|ObjectName",
    };
    const text = await invoke("fetch_text", { url: `${COMMONS_API}?${new URLSearchParams(params)}` });
    const page = Object.values(JSON.parse(text)?.query?.pages ?? {})[0];
    if (!page || page.missing !== undefined) throw new Error(`Commons has no file with page id ${id}`);
    return normalizeCommons(page);
  }
  const data = await freesoundJson(`/sounds/${id}/`, { fields: FREESOUND_FIELDS });
  return normalizeFreesound(data);
}

/**
 * Parses `Audio/CREDITS.md` back into structured entries — the question worth
 * asking of it is "what in this project still needs crediting before it ships",
 * and that shouldn't require reading prose.
 */
export function parseCredits(markdown) {
  if (!markdown) return [];
  const blocks = String(markdown).split(/(?=<!-- audio-credit:)/).filter((b) => b.includes("<!-- audio-credit:"));
  return blocks.map((block) => {
    const field = (label) => new RegExp(`^- ${label}: (.+)$`, "m").exec(block)?.[1]?.trim() ?? null;
    return {
      key: /<!-- audio-credit:([^ ]+) -->/.exec(block)?.[1] ?? null,
      name: /^### (.+)$/m.exec(block)?.[1]?.trim() ?? null,
      file: field("File")?.replace(/^`|`$/g, "") ?? null,
      license: field("Licence")?.replace(/\s*\(https?:\/\/\S+\)$/, "") ?? null,
      author: field("Author"),
      source: field("Source"),
      attributionRequired: block.includes("**Attribution required.**"),
      commercialUseAllowed: !block.includes("**Not cleared for commercial use**"),
    };
  });
}

/** Every recorded credit for the open project, or `[]` when nothing was imported. */
export async function readCredits() {
  const root = (await projectStore()).rootPath;
  if (!root) throw new Error("Open a project first");
  return parseCredits(await readText(`${root}/Audio/CREDITS.md`));
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export const safeName = (name) =>
  String(name)
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^\w\- ]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "Sound";

const PROVIDER_FOLDER = { freesound: "Freesound", commons: "Commons", archive: "Archive" };

/** Nothing sane holds more sounds than this; see the cap note in importItem. */
const ARCHIVE_FILE_CAP = 200;

async function ensureDir(path) {
  await invoke("create_dir", { path }).catch(() => {});
}

async function writeText(path, contents) {
  await invoke("save_scene", { path, contents });
}

async function readText(path) {
  return invoke("read_text_file", { path }).catch(() => null);
}

async function proxyBytes(url) {
  const value = await invoke("fetch_bytes", { url });
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return new Uint8Array(value);
  throw new Error("Download returned an unexpected response");
}

/**
 * `Audio/CREDITS.md`, maintained in place.
 *
 * A CC-BY sound used without credit is a licence breach that nobody notices
 * until the game ships, so this is written on every import rather than offered
 * as a button somebody has to remember to press. Entries carry an HTML comment
 * marker so re-importing the same sound rewrites its own entry instead of
 * appending a duplicate — the marker is the only reliable identity here, since
 * a user can rename the file afterwards.
 */
export function creditEntry(item, filename) {
  const parts = [
    `<!-- audio-credit:${item.key} -->`,
    `### ${item.name}`,
    "",
    `- File: \`${filename}\``,
    `- Licence: ${item.license.name}${item.license.url ? ` (${item.license.url})` : ""}`,
  ];
  if (item.author) parts.push(`- Author: ${item.author}`);
  if (item.pageUrl) parts.push(`- Source: ${item.pageUrl}`);
  if (item.license.attribution) {
    parts.push(`- **Attribution required.** Credit this in the shipped game.`);
  }
  if (!item.license.commercial) {
    parts.push(`- **Not cleared for commercial use** under this licence.`);
  }
  return parts.join("\n");
}

const CREDITS_HEADER = [
  "# Audio credits",
  "",
  "Maintained by the Audio Library panel. Every imported sound is listed with the",
  "licence it arrived under. Entries marked **attribution required** must appear in",
  "the shipped game's credits; entries marked not cleared for commercial use must be",
  "replaced before selling it.",
  "",
].join("\n");

export function mergeCredits(existing, item, filename) {
  const entry = creditEntry(item, filename);
  const marker = `<!-- audio-credit:${item.key} -->`;
  if (!existing) return `${CREDITS_HEADER}\n${entry}\n`;

  const index = existing.indexOf(marker);
  if (index === -1) return `${existing.replace(/\s*$/, "")}\n\n${entry}\n`;

  // Replace from this marker up to the next entry (or end of file). Splitting
  // on the marker prefix rather than on blank lines keeps multi-line entries
  // intact when an entry gains a warning line it didn't have before.
  const after = existing.slice(index + marker.length);
  const nextMarker = after.indexOf("<!-- audio-credit:");
  const tail = nextMarker === -1 ? "" : after.slice(nextMarker);
  const head = existing.slice(0, index);
  return `${head}${entry}\n${tail ? `\n${tail}` : ""}`.replace(/\s*$/, "\n");
}

async function updateCredits(audioRoot, item, filename) {
  const path = `${audioRoot}/CREDITS.md`;
  const existing = await readText(path);
  await writeText(path, mergeCredits(existing, item, filename));
}

/**
 * Non-clobbering filename: `Rain.ogg`, then `Rain 2.ogg`, `Rain 3.ogg`…
 * `stat_file` resolves with an mtime for a file that exists and rejects for one
 * that doesn't — the rejection is the answer, so it's caught rather than
 * inspected (an mtime is legitimately falsy at the epoch).
 */
async function uniquePath(dir, base, ext) {
  for (let n = 1; n < 100; n++) {
    const name = n === 1 ? `${base}.${ext}` : `${base} ${n}.${ext}`;
    const path = `${dir}/${name}`;
    const exists = await invoke("stat_file", { path }).then(() => true, () => false);
    if (!exists) return { path, name };
  }
  return { path: `${dir}/${base} ${Date.now()}.${ext}`, name: `${base} ${Date.now()}.${ext}` };
}

/**
 * Downloads one sound into `<project>/Audio/<Provider>/` and records its
 * licence. Returns `{ path, name, bytes }`.
 */
export async function importSound(item, { onProgress } = {}) {
  if (item?.provider === "archive") return importArchiveItem(item, { onProgress });
  if (!item?.downloadUrl) throw new Error(`"${item?.name ?? "This sound"}" has no downloadable file`);
  const root = (await projectStore()).rootPath;
  if (!root) throw new Error("Open a project first");

  const audioRoot = `${root}/Audio`;
  const dir = `${audioRoot}/${PROVIDER_FOLDER[item.provider] ?? "Imported"}`;
  await ensureDir(audioRoot);
  await ensureDir(dir);

  onProgress?.({ label: "Downloading…", loaded: 0, total: item.downloadBytes ?? 0 });
  const bytes = await proxyBytes(item.downloadUrl);

  const { path, name } = await uniquePath(dir, safeName(item.name), item.downloadExt);
  onProgress?.({ label: "Writing…", loaded: bytes.byteLength, total: bytes.byteLength });
  const { writeBinaryFile } = await import("./assetLoader.js");
  await writeBinaryFile(path, bytes);

  onProgress?.({ label: "Recording licence…", loaded: bytes.byteLength, total: bytes.byteLength });
  await updateCredits(audioRoot, item, `${PROVIDER_FOLDER[item.provider] ?? "Imported"}/${name}`);

  await (await projectStore()).refresh();
  return { path, name, bytes: bytes.byteLength };
}

/**
 * Imports a whole Internet Archive item into `Audio/Archive/<item>/`.
 *
 * An item is a pack, so this is closer to the itch.io importer than to the
 * one-file path above: it walks the item's deduplicated audio files and writes
 * each one, reporting progress per file because a thirty-file item over a slow
 * connection is otherwise a very long silence.
 *
 * A partial failure does not abort the rest. One 403 on one file of thirty is
 * not a reason to throw away twenty-nine good downloads; the count of failures
 * comes back in the result so the caller can say so.
 */
async function importArchiveItem(item, { onProgress } = {}) {
  const root = (await projectStore()).rootPath;
  if (!root) throw new Error("Open a project first");

  onProgress?.({ label: "Reading item…", loaded: 0, total: 0 });
  const { files } = await resolveArchiveFiles(item.id);

  const audioRoot = `${root}/Audio`;
  const dir = `${audioRoot}/Archive/${safeName(item.name)}`;
  await ensureDir(audioRoot);
  await ensureDir(`${audioRoot}/Archive`);
  await ensureDir(dir);

  // Truncation is reported, never silent — a partial import that looks complete
  // is worse than one that says what it left behind.
  const capped = files.length > ARCHIVE_FILE_CAP;
  const wanted = capped ? files.slice(0, ARCHIVE_FILE_CAP) : files;

  let written = 0;
  let failed = 0;
  let bytes = 0;
  const { writeBinaryFile } = await import("./assetLoader.js");

  for (const [index, file] of wanted.entries()) {
    onProgress?.({ label: `Downloading ${index + 1}/${wanted.length}…`, loaded: index, total: wanted.length });
    try {
      const data = await proxyBytes(file.url);
      const { path } = await uniquePath(dir, safeName(file.name), file.ext);
      await writeBinaryFile(path, data);
      bytes += data.byteLength;
      written++;
    } catch (err) {
      console.warn(`Audio Library: "${file.name}" failed (${err.message ?? err})`);
      failed++;
    }
  }

  if (!written) throw new Error(`Nothing could be downloaded from "${item.name}"`);

  onProgress?.({ label: "Recording licence…", loaded: wanted.length, total: wanted.length });
  await updateCredits(audioRoot, item, `Archive/${safeName(item.name)}/ (${written} files)`);
  await (await projectStore()).refresh();

  return {
    path: dir,
    name: safeName(item.name),
    bytes,
    files: written,
    failed,
    skipped: capped ? files.length - ARCHIVE_FILE_CAP : 0,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers (shared by the panel)
// ---------------------------------------------------------------------------

export function formatDuration(seconds) {
  if (!seconds || seconds < 0) return "—";
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatBytes(bytes) {
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 10 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}
