/**
 * Google Fonts, searchable and importable without leaving the editor.
 *
 * Picking a font is otherwise the same detour every time: browser, search,
 * download a zip, find the file, drag it in, delete the zip. That is the exact
 * shape of thing this app is supposed to remove, so the catalog is browsable
 * here and importing is one click.
 *
 * ## Two endpoints, no API key
 *
 * The documented Web Fonts Developer API needs a Google Cloud key, which means
 * a signup and a console visit before a single font can be searched — a
 * non-starter for a tool that should just work. It isn't necessary either:
 *
 * - `fonts.google.com/metadata/fonts` returns the whole catalog (~1,900
 *   families with category, subsets, weights, designers, popularity) as plain
 *   JSON to an unauthenticated GET. It's what the Google Fonts site itself
 *   reads, and it is the only source for the *browsing* metadata — categories,
 *   subsets, popularity ordering — that the CSS endpoint doesn't expose.
 * - `fonts.googleapis.com/css2` returns `@font-face` rules whose `src` URLs
 *   point at the actual font binaries on `fonts.gstatic.com`. Also keyless,
 *   and it is the officially supported way to reach the files.
 *
 * Both go through the Rust proxy: the metadata host sends no CORS headers, so
 * a direct fetch from the webview fails outright.
 *
 * ## Why TrueType rather than WOFF2
 *
 * The CSS endpoint serves whichever format it thinks the caller supports,
 * inferred from the User-Agent. The proxy's UA is not a browser it recognises,
 * so it serves `.ttf` — which is the format we want anyway: WOFF2 is smaller
 * on the wire but its table directory is brotli-compressed and transformed, so
 * nothing can read a family name, a licence, or a glyph count out of it (see
 * `fontMeta.js`). A `.ttf` shows the user everything about what they imported.
 *
 * ## Licensing
 *
 * Everything in the catalog is open source — almost all of it OFL, the rest
 * Apache 2.0 or Ubuntu FL — so it is all shippable in a game. The families
 * flagged `isOpenSource: false` are the handful Google hosts under other
 * terms; they are surfaced with a warning rather than hidden, because "why
 * can't I find X" is a worse experience than a caveat.
 */

const METADATA_URL = "https://fonts.google.com/metadata/fonts";
const CSS_URL = "https://fonts.googleapis.com/css2";

async function invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** Human-readable weight names, for the variant chips. */
const WEIGHT_NAMES = {
  100: "Thin",
  200: "ExtraLight",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "SemiBold",
  700: "Bold",
  800: "ExtraBold",
  900: "Black",
};

/** `"700i"` → `{ weight: 700, italic: true, label: "Bold Italic" }`. */
export function parseVariant(key) {
  const italic = key.endsWith("i");
  const weight = Number.parseInt(italic ? key.slice(0, -1) : key, 10) || 400;
  const name = WEIGHT_NAMES[weight] ?? String(weight);
  return { key, weight, italic, label: italic ? (weight === 400 ? "Italic" : `${name} Italic`) : name };
}

let catalogPromise = null;

/**
 * The whole family catalog, normalized and sorted by Google's own default
 * ordering (roughly popularity). Fetched once per session — it's ~1 MB of
 * JSON and it does not change between two clicks.
 */
export function fetchFontCatalog() {
  if (catalogPromise) return catalogPromise;
  catalogPromise = (async () => {
    const text = await invoke("fetch_text", { url: METADATA_URL });
    // The endpoint has historically served an anti-JSON-hijacking prefix
    // (`)]}'`). It currently doesn't, but a parser that assumes clean JSON
    // would break silently if it comes back, and skipping to the first brace
    // costs nothing.
    const start = text.indexOf("{");
    const data = JSON.parse(start > 0 ? text.slice(start) : text);
    const families = data.familyMetadataList ?? [];
    return families
      .map((entry) => ({
        family: entry.family,
        category: entry.category ?? "Other",
        subsets: (entry.subsets ?? []).filter((subset) => subset !== "menu"),
        variants: Object.keys(entry.fonts ?? { 400: {} }).map(parseVariant),
        axes: (entry.axes ?? []).map((axis) => axis.tag),
        designers: entry.designers ?? [],
        popularity: entry.popularity ?? 9999,
        defaultSort: entry.defaultSort ?? 9999,
        trending: entry.trending ?? 9999,
        dateAdded: entry.dateAdded ?? "",
        lastModified: entry.lastModified ?? "",
        size: entry.size ?? 0,
        openSource: entry.isOpenSource !== false,
        variable: (entry.axes ?? []).length > 0,
      }))
      .sort((a, b) => a.defaultSort - b.defaultSort);
  })();
  catalogPromise.catch(() => {
    catalogPromise = null; // a network blip shouldn't disable the panel forever
  });
  return catalogPromise;
}

/** The distinct categories present in the catalog, for the filter row. */
export function catalogCategories(catalog) {
  return [...new Set(catalog.map((entry) => entry.category))].sort();
}

/**
 * A `css2` family spec for the requested variants.
 *
 * The endpoint is strict: axis tuples must be listed in a fixed order
 * (`ital` before `wght`) and ascending, and it 400s rather than ignoring a
 * malformed one. Building it here — rather than at three call sites — is what
 * keeps that from being rediscovered each time.
 */
export function familySpec(family, variants) {
  const name = family.replaceAll(" ", "+");
  if (!variants?.length) return name;
  const anyItalic = variants.some((variant) => variant.italic);
  const tuples = variants
    .map((variant) => (anyItalic ? [variant.italic ? 1 : 0, variant.weight] : [variant.weight]))
    .sort((a, b) => a[0] - b[0] || (a[1] ?? 0) - (b[1] ?? 0))
    .map((tuple) => tuple.join(","));
  const axes = anyItalic ? "ital,wght" : "wght";
  return `${name}:${axes}@${[...new Set(tuples)].join(";")}`;
}

/**
 * The font file URLs for one family, as `[{ weight, italic, url, format }]`.
 *
 * Parsed out of the CSS rather than guessed: gstatic paths carry a content
 * hash that changes whenever Google re-releases a family, so there is no
 * stable URL to construct.
 */
export async function fetchFontFileUrls(family, variants) {
  const url = `${CSS_URL}?family=${familySpec(family, variants)}&display=swap`;
  const css = await invoke("fetch_text", { url });
  const out = [];
  for (const block of css.split("@font-face").slice(1)) {
    const style = /font-style:\s*([a-z]+)/.exec(block)?.[1] ?? "normal";
    const weight = Number.parseInt(/font-weight:\s*(\d+)/.exec(block)?.[1] ?? "400", 10);
    const src = /src:\s*url\(([^)]+)\)\s*format\('([^']+)'\)/.exec(block);
    if (!src) continue;
    out.push({ weight, italic: style === "italic", url: src[1], format: src[2] });
  }
  if (!out.length) throw new Error(`Google Fonts returned no files for "${family}"`);
  return out;
}

const EXT_BY_FORMAT = { truetype: "ttf", opentype: "otf", woff: "woff", woff2: "woff2" };

/** `Noto Sans` + Bold Italic → `NotoSans-BoldItalic.ttf`. */
function fileNameFor(family, weight, italic, format) {
  const stem = family.replaceAll(" ", "");
  const name = WEIGHT_NAMES[weight] ?? String(weight);
  const style = italic ? (weight === 400 ? "Italic" : `${name}Italic`) : name;
  return `${stem}-${style}.${EXT_BY_FORMAT[format] ?? "ttf"}`;
}

/**
 * Downloads the chosen variants of `family` into `<project>/Fonts/<Family>/`.
 *
 * Grouped into a folder per family because a family is rarely one file — ask
 * for Regular and Bold and you get two, and loose weights scattered through
 * the assets root is exactly the mess the Poly Haven and AmbientCG importers
 * were built to avoid.
 *
 * Returns the written paths. Reports per-file failures through `onProgress`
 * and keeps going: three of four weights is a useful outcome, and failing the
 * whole import because one request timed out is not.
 */
export async function importGoogleFont(family, variants, { onProgress } = {}) {
  const { useProjectStore } = await import("./store/projectStore.js");
  const root = useProjectStore.getState().rootPath;
  if (!root) throw new Error("Open a project first.");

  const files = await fetchFontFileUrls(family, variants);
  const dir = `${root}/Fonts/${family.replaceAll(" ", "")}`;
  await invoke("create_dir", { path: dir }).catch(() => {});

  const { writeBinaryFile } = await import("./assetLoader.js");
  const written = [];
  for (const [index, file] of files.entries()) {
    const name = fileNameFor(family, file.weight, file.italic, file.format);
    onProgress?.({ index, total: files.length, name });
    try {
      const bytes = await invoke("fetch_bytes", { url: file.url });
      const path = `${dir}/${name}`;
      await writeBinaryFile(path, new Uint8Array(bytes));
      written.push(path);
    } catch (error) {
      console.error(`Font "${name}" failed to download: ${error?.message ?? error}`);
    }
  }
  if (!written.length) throw new Error(`Nothing downloaded for "${family}".`);
  await useProjectStore.getState().refresh();
  return written;
}

/**
 * A preview `FontFace` for a catalog family, registered under a name that
 * cannot collide with a project font.
 *
 * Rendering specimens from a stylesheet `<link>` would have been less code and
 * would fetch from Google on every repaint; this fetches once, through the
 * same proxy as everything else, and the caller can drop it when the panel
 * closes. The prefix keeps browsing state out of the project's font namespace
 * (see `fontAsset.js` for why those names are generated).
 */
const previewCache = new Map();

export function previewFamilyName(family) {
  return `gf-preview-${family.replace(/[^A-Za-z0-9]+/g, "-")}`;
}

export function ensurePreviewFont(family) {
  const key = previewFamilyName(family);
  let promise = previewCache.get(key);
  if (promise) return promise;
  promise = (async () => {
    if (typeof FontFace === "undefined") return null;
    const files = await fetchFontFileUrls(family, [{ weight: 400, italic: false }]);
    const bytes = await invoke("fetch_bytes", { url: files[0].url });
    const face = new FontFace(key, bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes).buffer);
    await face.load();
    document.fonts.add(face);
    return key;
  })();
  previewCache.set(key, promise);
  promise.catch(() => previewCache.delete(key));
  return promise;
}
