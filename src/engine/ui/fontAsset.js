import { resolveAssetUrl } from "../assetResolver.js";
import { parseFontMetadata, fontDisplayName, fontFormatOf } from "./fontMeta.js";

/**
 * Project font files (`.ttf` / `.otf` / `.woff` / `.woff2`) as engine assets.
 *
 * Text rendering here — both the SDF atlas and the canvas raster path — goes
 * through the browser's own text stack, which means the only way to draw with
 * a font is for that font to be a registered `FontFace` the platform will
 * honour in `ctx.font`. So an imported font is not decoded into glyph outlines
 * by us; it is handed to `document.fonts`, and everything downstream just names
 * it. The whole job of this module is to make that naming unambiguous and to
 * make "is it ready" answerable.
 *
 * ## Why the family name is generated, not taken from the file
 *
 * Using the font's declared family ("Inter") reads better and breaks quickly:
 * two files can declare the same family (Inter Regular and Inter Bold, or a
 * user's two different cuts of Helvetica), and registering both means the
 * second silently shadows the first — text renders in a font the user did not
 * pick, with nothing to indicate why. Worse, a project font can collide with a
 * font installed on the developer's machine, so the editor looks right and the
 * exported game looks wrong on every other computer.
 *
 * A family id derived from the asset path is unique by construction, cannot
 * collide with a system font, and is stable across sessions and machines — so
 * a scene that says `fontAsset: "ui/Inter-Bold.ttf"` renders identically
 * everywhere. The real name is kept as `displayName` for the UI to show.
 *
 * ## Readiness
 *
 * A glyph rasterized before its font loads bakes the *fallback* font into an
 * SDF atlas that is then cached — the text stays wrong for the rest of the
 * session, and reloading "fixes" it, which is the worst kind of bug to chase.
 * So `ensureFontLoaded` is the only supported way in, and `onFontLoaded`
 * exists for caches that need to throw work away when a font arrives late.
 */

export const FONT_EXTENSIONS = ["ttf", "otf", "woff", "woff2"];

/** `format()` hint for the `FontFace` src, by extension. */
const FORMAT_BY_EXT = {
  ttf: "truetype",
  otf: "opentype",
  woff: "woff",
  woff2: "woff2",
};

const extOf = (path) => String(path ?? "").split(".").pop()?.toLowerCase() ?? "";
const normalize = (path) => String(path ?? "").replaceAll("\\", "/");

/** path -> { family, displayName, meta, face, promise } */
const cache = new Map();
const listeners = new Set();

/**
 * A short, stable hash of the asset path.
 *
 * FNV-1a: not cryptographic, but the requirement here is only "two different
 * paths in one project almost never collide", and 32 bits of a good avalanche
 * covers that with room to spare.
 */
function hashPath(path) {
  let hash = 0x811c9dc5;
  const text = normalize(path).toLowerCase();
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(6, "0").slice(-6);
}

/**
 * The CSS family name this font asset is registered under.
 *
 * Pure and synchronous, so a component can build its `ctx.font` string (and
 * its atlas cache key) before the font has finished loading — the string is
 * correct either way, it just doesn't resolve to anything yet.
 */
export function fontFamilyFor(path) {
  if (!path) return null;
  const stem = normalize(path).split("/").pop().replace(/\.[^.]+$/, "");
  const safe = stem.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "font";
  return `ea-${safe}-${hashPath(path)}`;
}

/** True once this font is registered and usable for drawing. */
export function isFontLoaded(path) {
  return cache.get(normalize(path))?.loaded === true;
}

/** Everything known about a loaded font, or null before it loads. */
export function getLoadedFont(path) {
  const entry = cache.get(normalize(path));
  return entry?.loaded ? entry : null;
}

/**
 * Notifies when any font finishes loading. Callers that cache anything derived
 * from a font — glyph atlases above all — must invalidate here, because their
 * cache was populated with the fallback face.
 *
 * @param {(path: string, entry: object) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onFontLoaded(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Loads (or returns the in-flight/settled load of) the font at `path`.
 *
 * Resolves to `{ family, displayName, meta, path }`. Rejects only for a file
 * that cannot be read or that the platform refuses as a font — a file whose
 * *metadata* can't be parsed still loads fine and simply reports less.
 */
export function ensureFontLoaded(path) {
  if (!path) return Promise.resolve(null);
  const key = normalize(path);
  const existing = cache.get(key);
  if (existing) return existing.promise;

  const family = fontFamilyFor(path);
  const entry = { path, family, displayName: null, meta: null, loaded: false, face: null, promise: null };
  entry.promise = (async () => {
    const url = await resolveAssetUrl(path);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const bytes = new Uint8Array(await response.arrayBuffer());

    // Parsed before registration so the failure modes stay separate: a file
    // that is not a font at all is worth saying so about, rather than letting
    // `FontFace` fail with a browser-specific message.
    if (!fontFormatOf(bytes)) throw new Error("Not a recognised font file (expected TTF, OTF, WOFF or WOFF2)");
    entry.meta = await parseFontMetadata(bytes);
    const stem = normalize(path).split("/").pop().replace(/\.[^.]+$/, "");
    entry.displayName = fontDisplayName(entry.meta, stem);

    if (typeof document === "undefined" || typeof FontFace === "undefined") {
      // Headless (tests, exporters): metadata is still useful, drawing is not
      // happening, and pretending the face registered would be a lie the
      // caller can't detect.
      entry.loaded = false;
      return entry;
    }

    const format = FORMAT_BY_EXT[extOf(path)];
    const face = new FontFace(family, bytes, format ? { format } : {});
    await face.load();
    document.fonts.add(face);
    entry.face = face;
    entry.loaded = true;
    for (const fn of listeners) {
      try {
        fn(path, entry);
      } catch (error) {
        console.warn(`[fonts] listener failed for ${path}:`, error?.message ?? error);
      }
    }
    return entry;
  })();

  // A failed load must not poison the cache: the file may be mid-import, and
  // the next attempt should actually retry rather than replay the error.
  entry.promise.catch(() => {
    if (cache.get(key) === entry) cache.delete(key);
  });
  cache.set(key, entry);
  return entry.promise;
}

/**
 * Drops a font so the next use re-reads it. Called when the file is
 * overwritten (re-import, texture-editor save) — the FontFace holds a decoded
 * copy of the old bytes and would otherwise keep drawing the old design.
 */
export function invalidateFontAsset(path) {
  const key = normalize(path);
  const entry = cache.get(key);
  if (!entry) return;
  cache.delete(key);
  if (entry.face && typeof document !== "undefined") {
    try {
      document.fonts.delete(entry.face);
    } catch {}
  }
}

/** Test/teardown hook — forgets every font. */
export function disposeFontAssets() {
  for (const path of [...cache.keys()]) invalidateFontAsset(path);
}

/**
 * The CSS family list to draw `fontAsset` (a project font) or `fontFamily` (a
 * system/CSS family) with, in that order of preference.
 *
 * The generated family is quoted and followed by the requested fallback, so a
 * font that failed to load — or a headless render — still draws *something*
 * rather than nothing. Silent fallback is right here: text disappearing is a
 * far worse failure than text in the wrong face.
 */
export function fontStackFor(fontAsset, fontFamily = "system-ui, sans-serif") {
  const family = fontAsset ? fontFamilyFor(fontAsset) : null;
  return family ? `"${family}", ${fontFamily}` : fontFamily;
}
