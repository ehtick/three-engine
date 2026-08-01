/**
 * Destination naming for exported builds.
 *
 * Every shipped file lands in a flat `assets/` folder, which means two source
 * files that happen to share a basename — `textures/wood/color.png` and
 * `textures/stone/color.png`, the single most common naming convention in
 * downloaded PBR sets — both want `assets/color.png`. The old exporter let the
 * second copy overwrite the first and said nothing: the build shipped, and one
 * of the two materials was silently wearing the other's texture.
 *
 * This allocator hands out a unique destination per *source*, and remembers the
 * answer so the same source asked twice gets the same name (the scene walk
 * claims a path once per reference).
 *
 * Deliberately free of Tauri and of the DOM so the export path's naming rules
 * are testable in Node — see `npm run test:build`.
 */

/** Last path segment, for either separator. */
export const basename = (p) => String(p).split(/[\\/]/).pop();

/**
 * Splits a filename into `[stem, extension]`. A leading dot is part of the
 * stem (`.gitignore` has no extension), and only the last dot counts — the
 * suffixed forms this module cares about (`foo.png.meta`) are built by
 * appending, never by parsing.
 */
export function splitExtension(name) {
  const i = String(name).lastIndexOf(".");
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [String(name), ""];
}

/**
 * Identity key for a source path. Windows and macOS are case-insensitive, so
 * `Wood.png` and `wood.png` are the same file there and must not be copied
 * twice; separators are normalised for the same reason (the editor mixes
 * `\` and `/` freely depending on which API produced the path).
 */
const sourceKey = (p) => String(p).replaceAll("\\", "/").toLowerCase();

export function createAssetNames({ dir = "assets" } = {}) {
  /** normalised source -> { source, rel } */
  const bySource = new Map();
  /** lowercased destination -> normalised source that owns it */
  const taken = new Map();

  const reserve = (rel, key) => {
    taken.set(rel.toLowerCase(), key);
    return rel;
  };

  /**
   * The build-relative destination for `source`, allocating one on first ask.
   * Non-string input passes through untouched — callers hand this whatever a
   * component prop held, and a null texture slot is not an error.
   */
  function claim(source) {
    if (!source || typeof source !== "string") return source;
    const key = sourceKey(source);
    const existing = bySource.get(key);
    if (existing) return existing.rel;

    const [stem, ext] = splitExtension(basename(source));
    let rel = `${dir}/${stem}${ext}`;
    for (let n = 1; taken.has(rel.toLowerCase()); n++) rel = `${dir}/${stem}-${n}${ext}`;
    reserve(rel, key);
    bySource.set(key, { source, rel });
    return rel;
  }

  /**
   * The destination for a file that rides along with `source` under a fixed
   * suffix (`.meta`, `.basis`). It follows the *renamed* asset — a sidecar
   * left at the original name would belong to whichever copy won the collision,
   * which is exactly the bug this module exists to close.
   */
  function claimSidecar(source, suffix) {
    const rel = `${claim(source)}${suffix}`;
    // Reserve it so a real asset literally named `color.png.meta` can't be
    // handed the same destination later.
    if (!taken.has(rel.toLowerCase())) reserve(rel, sourceKey(`${source}${suffix}`));
    return rel;
  }

  /**
   * Reserves an *explicit* destination for a real file, outside the flat
   * `assets/` folder. The icon is the one asset that belongs beside
   * `index.html` — a favicon sitting among the game's textures reads like one
   * of them, and gets swept up by anything that walks that folder.
   */
  function claimAt(source, wanted) {
    if (!source || typeof source !== "string") return source;
    const key = sourceKey(source);
    const existing = bySource.get(key);
    if (existing) return existing.rel;
    const [stem, ext] = splitExtension(wanted);
    let rel = wanted;
    for (let n = 1; taken.has(rel.toLowerCase()); n++) rel = `${stem}-${n}${ext}`;
    reserve(rel, key);
    bySource.set(key, { source, rel });
    return rel;
  }

  /** The destination already allocated for `source`, or null. */
  function peek(source) {
    return bySource.get(sourceKey(source))?.rel ?? null;
  }

  /** Forgets a source (an asset excluded from the build). Frees its name. */
  function release(source) {
    const key = sourceKey(source);
    const entry = bySource.get(key);
    if (!entry) return false;
    bySource.delete(key);
    taken.delete(entry.rel.toLowerCase());
    return true;
  }

  /** `[originalSourcePath, relativeDestination]` pairs, in claim order. */
  function entries() {
    return [...bySource.values()].map(({ source, rel }) => [source, rel]);
  }

  /**
   * Reserves a destination that has no source file behind it (a generated
   * document — a rewritten `.mat`, a transpiled script). Returns the unique
   * name to write it under, keyed by the original authoring path so repeated
   * asks agree.
   */
  function claimGenerated(originalPath, { rename } = {}) {
    if (!originalPath) return originalPath;
    const key = sourceKey(originalPath);
    const existing = bySource.get(key);
    if (existing) return existing.rel;
    const name = rename ? rename(basename(originalPath)) : basename(originalPath);
    const [stem, ext] = splitExtension(name);
    let rel = `${dir}/${stem}${ext}`;
    for (let n = 1; taken.has(rel.toLowerCase()); n++) rel = `${dir}/${stem}-${n}${ext}`;
    reserve(rel, key);
    // Recorded with a null source so `entries()` (the copy list) skips it —
    // the caller writes its contents itself.
    bySource.set(key, { source: null, rel });
    return rel;
  }

  return {
    claim,
    claimAt,
    claimSidecar,
    claimGenerated,
    peek,
    release,
    /** Sources with a real file behind them, for the copy step. */
    copyEntries: () => entries().filter(([source]) => source !== null),
    entries,
    get size() {
      return bySource.size;
    },
  };
}
