/**
 * Poly Pizza API v1.1 client and GLB importer.
 *
 * Poly Pizza is the surviving home of the Google Poly archive plus a decade of
 * community low-poly work — ~10k models under CC0 and CC-BY, in twelve
 * categories, a chunk of them rigged and animated. Unlike Poly Haven (one
 * curated CC0 catalogue fetched whole) and like Sketchfab, it is a *search*
 * API: results are paged server-side and there is no index to filter locally.
 *
 * ## The three facts that shape this file
 *
 * 1. **There is no anonymous read tier.** Every endpoint 401s without a key,
 *    so the credential gates browsing, not just downloading — the panel is
 *    inert until one is saved. (Sketchfab's catalogue is public and only its
 *    download endpoint needs a token; do not copy that assumption here.)
 *
 * 2. **The key is an `x-auth-token` header**, not an `Authorization` scheme.
 *    Sending it as `Bearer`/`Token` fails with the same 401 as sending
 *    nothing, which is indistinguishable from a bad key.
 *
 * 3. **The download is already a plain GLB** on a public CDN
 *    (`static.poly.pizza/<uuid>.glb`) — no zip, no GLTF-with-siblings, no
 *    credential. That makes the import path three steps shorter than
 *    Sketchfab's: fetch bytes, write, unpack.
 *
 * Downloads land in the project's `PolyPizza/` folder as ordinary assets, with
 * an ATTRIBUTION.md beside them. That file is not decoration: most of the
 * catalogue is CC-BY, and the attribution string the API returns is the exact
 * credit line the licence requires.
 */
import { writeBinaryFile } from "./assetLoader.js";

const API = "https://api.poly.pizza/v1.1";
const TOKEN_KEY = "engine.polyPizzaToken.v1";

/**
 * THE FILTERS ARE NUMERIC ENUMS, and `code` below is the number.
 *
 * This cost a while to find, so it is worth writing down exactly. The filter
 * parameters are `Category` / `License` / `Animated` — PascalCase — and their
 * values are INDICES, not names. Send `License=CC0` and the API answers
 *
 *     400 {"error":{"issues":[{"code":"invalid_type","expected":"number",
 *          "received":"nan","path":["License"]}],"name":"ZodError"}}
 *
 * because it coerces the value to a number and `"CC0"` is NaN. Send the same
 * thing in lowercase (`license=CC0`) and there is no error at all — the
 * parameter is simply unknown, so it is never validated and never applied, and
 * you get a full unfiltered page back that looks like a working search. That
 * silent version is how this went unnoticed through several rounds of testing:
 * the only symptom was that `Category=weapons` and `Category=people-characters`
 * returned identical results.
 *
 * The codes are the indices of Poly Pizza's own arrays, read out of its site
 * bundle (`static/js/client.*.js`). Its dropdowns use `-1` for "All", but that
 * is a UI sentinel it drops before sending — the API rejects it outright
 * (`{"code":"custom","message":"License must be 0 or 1"}`). "Any licence" is
 * therefore the ABSENCE of the parameter, which is why an unfiltered browse
 * remains impossible and `needsFilter` still has a job.
 *
 * Order matters and is theirs, not ours: `code` is a position in their array.
 * Sorting this list into something friendlier for our dropdown would silently
 * repoint every category.
 */
export const CATEGORIES = [
  { id: "food-drink", code: 0, label: "Food & drink" },
  { id: "clutter", code: 1, label: "Clutter" },
  { id: "weapons", code: 2, label: "Weapons" },
  { id: "transport", code: 3, label: "Transport" },
  { id: "furniture-decor", code: 4, label: "Furniture & decor" },
  { id: "objects", code: 5, label: "Objects" },
  { id: "nature", code: 6, label: "Nature" },
  { id: "animals", code: 7, label: "Animals" },
  { id: "buildings", code: 8, label: "Buildings" },
  // Their own description of this one is "Animated + Rigged Women, Men" — it is
  // where the character work lives.
  { id: "people-characters", code: 9, label: "People & characters" },
  { id: "scenes-levels", code: 10, label: "Scenes & levels" },
  { id: "other", code: 11, label: "Other" },
];

const CATEGORY_CODES = new Map(CATEGORIES.map((c) => [c.id, c.code]));

/**
 * Licence filter values.
 *
 * The catalogue has exactly TWO licences, not the seven Creative Commons
 * variants the community client lists — Poly Pizza's own array is
 * `["CC-BY 3.0", "CC0 1.0"]`, so the code is 0 or 1 and there is no NC or ND
 * content to worry about at all.
 */
export const LICENSES = [
  { id: "", code: -1, label: "Any licence" },
  { id: "CC0", code: 1, label: "CC0 — public domain" },
  { id: "CC-BY", code: 0, label: "CC-BY — credit required" },
];

const LICENSE_CODES = new Map(LICENSES.map((l) => [l.id, l.code]));

/**
 * Whether a set of filters describes a request the browse endpoint will refuse.
 *
 * With no keyword, at least one of Category / License / Animated must be
 * present or the endpoint answers `400 {"error":"No query parameters, must have
 * License, Animated, or Category"}`. And "any licence" cannot fill that role,
 * because it is expressed by OMITTING License rather than by a wildcard value —
 * `License=-1` is rejected outright ("License must be 0 or 1"). So there is
 * genuinely no way to ask this API for the unfiltered catalogue, and callers
 * have to know that rather than discover it as a failed request.
 */
export const needsFilter = ({ query = "", category = "", license = "", animated = null } = {}) =>
  !String(query).trim() && !category && !license && animated == null;

/** What to tell the user when `needsFilter` is true. */
export const FILTER_PROMPT =
  "Poly Pizza's catalogue can't be browsed unfiltered — type a search, or pick a category, a licence, or Animated.";

async function invoke(cmd, args) {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke(cmd, args);
}

/**
 * Every request goes through the Rust proxy so the key is attached
 * server-side. The host allowlist lives there; this side only builds paths.
 */
async function apiJson(path, token = getSavedToken()) {
  if (!token) throw new Error("Connect a Poly Pizza API key to browse the catalogue");
  const text = await invoke("fetch_polypizza_text", { url: `${API}${path}`, token });
  return JSON.parse(text);
}

export const getSavedToken = () => localStorage.getItem(TOKEN_KEY) ?? "";

export function clearSavedToken() {
  localStorage.removeItem(TOKEN_KEY);
}

/**
 * Validates by spending one real search. Poly Pizza has no `/me` endpoint, so
 * "is this key good" can only be answered by using it — better to find out
 * here than to save a dead key and have the grid fail with a bare 401.
 *
 * The `License=1` is NOT decoration, and neither is the `1`. A bare
 * `/search?limit=1` is the filterless request the endpoint rejects outright, so
 * validating with one turned every key — valid or not — into a 400 that read as
 * "your key is bad". `License=CC0` fails differently (ZodError: expected a
 * number) and `License=-1` differently again ("License must be 0 or 1"). `1` is
 * CC0, and is the cheapest request the API will actually accept.
 */
export async function validateAndSaveToken(token) {
  const value = token.trim();
  if (!value) throw new Error("Enter a Poly Pizza API key");
  const data = await apiJson("/search?License=1&limit=1", value);
  if (!Array.isArray(data?.results)) throw new Error("Poly Pizza did not accept that key");
  localStorage.setItem(TOKEN_KEY, value);
  return "Poly Pizza";
}

/**
 * First present value among several candidate keys.
 *
 * Poly Pizza answers in **PascalCase** — `ID`, `Title`, `Thumbnail`,
 * `Download`, `Creator.Username` — while the community TypeScript client that
 * documents this API declares it all in camelCase. Its types are simply never
 * exercised (that client passes the raw JSON straight through and never reads a
 * field), so the declarations were wrong and nothing there could notice.
 *
 * Reading both is not defensive padding: the wrapper really is mixed —
 * `results` came back lowercase while every field inside it is PascalCase — so
 * there is no single convention to commit to. Note `Licence`, British spelling
 * in the response, against `license` as the request parameter.
 */
const first = (...values) => values.find((value) => value !== undefined && value !== null);

/**
 * One search result, in the shape the panel and the MCP ops both read.
 *
 * `downloadUrl` is carried through verbatim: it is the CDN URL the import
 * needs, and re-deriving it from the id is not possible — the file is named by
 * a storage uuid unrelated to the model id.
 *
 * `name` deliberately has NO "Untitled model" fallback baked into the read.
 * That fallback is what made a total mapping failure look like a catalogue full
 * of genuinely untitled models: every tile said "Untitled model" over a
 * placeholder and nothing anywhere reported an error. The default is applied at
 * the end, where it is visibly a default.
 */
const CDN = "https://static.poly.pizza";

/**
 * Two ids, and they are not interchangeable.
 *
 * `PublicID` is the short slug in the page URL (`/m/0J_HflIStKl`) and is what
 * `/model/{id}` takes. `ResourceID` is the storage uuid that NAMES THE FILES:
 * the model is `<ResourceID>.glb` and its thumbnail is `<ResourceID>.jpg` on
 * the CDN — both verified against the live host. Neither can be derived from
 * the other, so a record that carries only the slug cannot be downloaded, and
 * one that carries only the uuid cannot be linked to.
 */
const normalise = (item) => {
  const creator = first(item.Creator, item.creator) ?? {};
  const id = first(item.PublicID, item.ID, item.id) ?? null;
  const resource = first(item.ResourceID, item.resourceId) ?? null;
  return {
    id,
    resourceId: resource,
    name: first(item.Title, item.title) || "Untitled model",
    description: first(item.Description, item.description) ?? "",
    author: first(creator.Username, creator.Name, creator.name) ?? "Unknown creator",
    // `DPURL` is the creator's display PICTURE, not their profile — linking to
    // it would open a jpg. The profile is derivable from the username instead.
    authorUrl: creator.Username ? `https://poly.pizza/u/${encodeURIComponent(creator.Username)}` : null,
    sourceUrl: id ? `https://poly.pizza/m/${id}` : "https://poly.pizza",
    license: first(item.Licence, item.License, item.license) ?? "License not specified",
    // The credit line the licence actually asks for, pre-composed by the API.
    attribution: first(item.Attribution, item.attribution) ?? "",
    // Prefer whatever the API sends; fall back to deriving it. The API's own
    // field names are not consistent across its endpoints, and a grid of
    // placeholder tiles is a worse failure than one extra `??`.
    thumbnailUrl:
      first(item.Thumbnail, item.thumbnail) ?? (resource ? `${CDN}/${resource}.jpg` : null),
    // GLB only; the FBX twin (`DownloadFBX`) is deliberately ignored.
    downloadUrl:
      first(item.Download, item.download) ?? (resource ? `${CDN}/${resource}.glb` : null),
    triangles: first(item.Tris, item.TriangleCount, item.triCount, item.triangles) ?? 0,
    animated: !!first(item.Animated, item.animated),
    uploadedAt: first(item.UploadDate, item.PublishedAt, item.uploadDate) ?? null,
    tags: first(item.Tags, item.tags) ?? [],
  };
};

/**
 * Search the catalogue.
 *
 * An empty query hits `/search` (the browse feed) rather than `/search/`,
 * which is a 404 — the keyword is a path segment here, not a query parameter,
 * so "no keyword" is a different endpoint and not an empty string.
 *
 * `page` is 1-based. The API returns `total` for the whole match set, not for
 * the page, which is what lets the panel say "showing 24 of 812" instead of
 * discovering the end by walking into it.
 */
export async function searchModels({
  query = "",
  category = "",
  license = "",
  animated = null,
  limit = 24,
  page = 1,
} = {}) {
  // ⚠ MEASURED, 2026-08-11: on the KEYWORD-LESS browse (`/search`), none of
  // these three filters actually narrow the result set. The endpoint requires
  // at least one of them to be present — omit them all and it answers 400 —
  // Filter names are PascalCase and their values are NUMBERS — see CATEGORIES
  // for the codes and for why a string value fails silently in one casing and
  // loudly in the other. `limit` and `page` really are lowercase (verified:
  // `limit=3` returns 3), so the casing is per-parameter, not a convention.
  const params = new URLSearchParams();
  const categoryCode = CATEGORY_CODES.get(category);
  if (categoryCode !== undefined) params.set("Category", String(categoryCode));
  // OMITTED for "any", not sent as -1. The site's own dropdown uses -1 to mean
  // "All", but that is a UI sentinel it drops before the request: the API
  // answers `{"code":"custom","message":"License must be 0 or 1"}`. So "any
  // licence" is the absence of the parameter, which is why a browse still needs
  // one of the other two — see `needsFilter`.
  const licenseCode = LICENSE_CODES.get(license);
  if (licenseCode !== undefined && licenseCode >= 0) params.set("License", String(licenseCode));
  // 1/0, NOT "true"/"false". Same numeric coercion as License: the string
  // "true" becomes NaN and the request fails with the same ZodError, which is
  // why every filter here has to be a number even when it reads as a boolean.
  if (animated === true) params.set("Animated", "1");
  if (animated === false) params.set("Animated", "0");
  params.set("limit", String(Math.max(1, Math.min(100, limit))));
  params.set("page", String(Math.max(1, page)));

  const keyword = query.trim();
  // Refuse locally, with the reason, rather than letting the API answer 400 and
  // surfacing a raw ZodError in the grid.
  if (!keyword && needsFilter({ query, category, license, animated })) {
    throw new Error(FILTER_PROMPT);
  }
  const path = keyword
    ? `/search/${encodeURIComponent(keyword)}?${params}`
    : `/search?${params}`;
  const data = await apiJson(path);
  const raw = first(data?.results, data?.Results) ?? [];
  const results = raw.map(normalise);
  // Falls back to the page length so a missing `total` degrades to "one page"
  // rather than to zero, which would read as an empty catalogue.
  const total = first(data?.total, data?.Total) ?? results.length;
  return {
    models: results,
    total,
    page,
    // The API reports the full match count, so "is there another page" is
    // arithmetic rather than a probe request.
    hasMore: page * limit < total,
  };
}

/**
 * One model by id — what `library.import` needs when it only has an id.
 *
 * The endpoint may answer either the model itself or a single-result envelope,
 * so unwrap before normalising: handing `normalise` an envelope produces a
 * record with every field undefined and no error anywhere.
 */
export async function fetchModel(id) {
  const data = await apiJson(`/model/${encodeURIComponent(id)}`);
  const envelope = first(data?.results, data?.Results);
  return normalise(Array.isArray(envelope) ? (envelope[0] ?? {}) : (data ?? {}));
}

async function proxyBytes(url) {
  const value = await invoke("fetch_bytes", { url });
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return new Uint8Array(value);
  throw new Error("Poly Pizza download returned an unexpected response");
}

const safeName = (name) => name.replace(/[^\w\- ]+/g, "_").trim() || "Unnamed";

export function buildAttribution(model) {
  return [
    `# ${model.name}`,
    "",
    `Creator: ${model.author}`,
    model.authorUrl ? `Creator profile: ${model.authorUrl}` : null,
    `Source: ${model.sourceUrl}`,
    `License: ${model.license}`,
    // The API's own credit string, kept verbatim: it is what a CC-BY notice is
    // supposed to say, and paraphrasing it is how attribution quietly stops
    // satisfying the licence.
    model.attribution ? "" : null,
    model.attribution ? `Required credit: ${model.attribution}` : null,
    "",
    "Downloaded from Poly Pizza. Preserve this attribution with the asset and derived works.",
  ].filter((line) => line !== null).join("\n");
}

/**
 * Downloads the GLB and imports it as ordinary project assets.
 *
 * No zip and no credential on the binary, so this is deliberately shorter than
 * the Sketchfab path: the bytes arrive ready to write. `unpackGlb` decides on
 * its own whether the model flattens to mesh entities or keeps the model
 * component — which is the branch that matters for the rigged characters,
 * since a skinned mesh cannot be flattened without losing its skeleton.
 */
export async function downloadModel(model, onProgress) {
  if (!model?.downloadUrl) throw new Error(`Poly Pizza has no download for "${model?.name ?? "?"}"`);
  const { useProjectStore } = await import("./store/projectStore.js");
  const root = useProjectStore.getState().rootPath;
  if (!root) throw new Error("Open a project first");

  onProgress?.({ label: "Downloading model…", loaded: 0, total: 0 });
  const glb = await proxyBytes(model.downloadUrl);

  const importDir = `${root}/PolyPizza`;
  await invoke("create_dir", { path: importDir }).catch(() => {});
  const glbPath = `${importDir}/${safeName(model.name)}.glb`;
  await writeBinaryFile(glbPath, glb);

  onProgress?.({ label: "Importing model…", loaded: glb.byteLength, total: glb.byteLength });
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

export async function openApiKeyPage() {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl("https://poly.pizza/settings/api");
}
