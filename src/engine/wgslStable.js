// WGSL BYTE-STABILITY — so the browser's compiled-shader disk cache can serve
// the SECOND boot instead of compiling everything again.
//
// ══ WHY ══════════════════════════════════════════════════════════════════════
//
// Chromium keys Dawn's pipeline cache (`DawnWebGPUCache`, sized by
// `--gpu-disk-cache-size-mb` in the editor's WebView2 args) on the shader
// module's SOURCE TEXT plus the pipeline state. It works — GI_SRC_REBUILD_PLAN
// §13.5 measured it at 72× on a byte-identical kernel — and yet the user's
// Foliage scene, booted many times on the same machine, still reported on
// 2026-09-09:
//
//     [gi] render pipelines: 27 compiled, slowest MeshPhysicalNodeMaterial
//          51kB frag/3kB vert 72.1s, …
//     [gi] SLOWEST PIPELINE: #126 [bvhHitShade] took 80.3s (272kB WGSL …
//          binds NodeBuffer_55143,NodeBuffer_55470,NodeBuffer_55471 …)
//
// `NodeBuffer_55143` is the tell. three names an unnamed storage buffer after
// its NODE ID (`WGSLNodeBuilder.getUniformFromNode`: `'NodeBuffer_' +
// uniformNode.id`), and node ids are a process-wide counter that depends on
// how many nodes were created before this one — the scene, the modules, the
// order things loaded. The WGSL text therefore differs from boot to boot in
// exactly those identifiers, the cache key differs with it, and every boot
// compiles the 80-second kernel from scratch. Every OTHER generated name is
// already an index within the shader (`nodeUniform7`, `nodeVar12`,
// `nodeVarying3`, `StructType2`), which is stable for the same graph.
//
// ══ WHAT THIS DOES ═══════════════════════════════════════════════════════════
//
// 1. `canonicalizeWgsl(code)` renames the id-based identifiers to ordinals by
//    first appearance inside the module. An identifier is only a name — the
//    binding layout is by `@group/@binding` index and three never reflects a
//    WGSL name back out of a module — so the rename is semantics-preserving
//    and, applied at `createShaderModule`, makes the text the driver sees
//    identical across boots for the same graph.
// 2. `WgslRegistry` records every module's raw and canonical hash and keeps
//    the previous boot's sets in storage, so `profile.freezes.wgsl` can say
//    how many of this boot's modules the LAST boot already compiled — as raw
//    text (what the cache would have keyed on without the rename) and as
//    canonical text (what it keys on with it). That is the receipt: if the
//    canonical hit rate is high and the raw one low, the rename is what
//    turned the cache on; if BOTH are low, something else in the text still
//    moves, and `profile.wgsl` can dump the module to diff two boots.
//
// ⚠ The rename is applied to the descriptor's `code` string only. Errors from
// the compiler quote the canonical names, which are shorter, not different in
// kind. `globalThis.__wgslCanonical = false` sends the original text through.

const HASH_SEED = 0x811c9dc5;

/** FNV-1a over UTF-16 code units, as 8 hex characters. Fast enough for 1.5 MB a boot. */
export function hashText(text) {
  let h = HASH_SEED;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * The identifier families three derives from a process-wide node id. Each is
 * renamed to `<prefix><ordinal>` by first appearance; the ordinals restart per
 * family and per module.
 */
const ID_FAMILIES = [
  // WGSLNodeBuilder.getUniformFromNode: an unnamed storage buffer. No trailing
  // word boundary: the id is also embedded in derived names such as
  // `NodeBuffer_55143Struct`, and those must move with it.
  /\bNodeBuffer_(\d+)/g,
  // RangeNode: `builder.geometry.setAttribute('__range' + this.id, …)`.
  /\b__range(\d+)/g,
];

/**
 * Rename id-derived identifiers to per-module ordinals. Idempotent: canonical
 * text canonicalises to itself.
 */
export function canonicalizeWgsl(code) {
  if (typeof code !== "string" || code.length === 0) return code;
  let out = code;
  for (const family of ID_FAMILIES) {
    const seen = new Map();
    // A whole-word scan first, so the ordinal is by FIRST appearance in the
    // text and not by the order `replace` happens to visit overlapping hits.
    family.lastIndex = 0;
    if (!family.test(out)) continue;
    family.lastIndex = 0;
    const prefix = family.source.slice(2, family.source.indexOf("("));   // `\bNodeBuffer_` → `NodeBuffer_`
    out = out.replace(family, (whole, id) => {
      let ordinal = seen.get(id);
      if (ordinal === undefined) {
        ordinal = seen.size;
        seen.set(id, ordinal);
      }
      return `${prefix}${ordinal}`;
    });
  }
  return out;
}

const STORAGE_KEY = "freeze.wgsl.v1";
const PERSIST_DEBOUNCE_MS = 1500;
/** Shader text kept for `profile.wgsl` dumps, in total; beyond it only hashes. */
const MAX_KEPT_BYTES = 24 * 1024 * 1024;

/**
 * Every shader module this boot created, with its raw and canonical hash, and
 * whether the previous boot created the same text.
 */
export class WgslRegistry {
  /**
   * @param {{getItem(k:string):string|null, setItem(k:string,v:string):void}|null} storage
   */
  constructor(storage = null) {
    this.storage = storage;
    this.modules = [];
    this.rawSet = new Set();
    this.canonSet = new Set();
    this.previous = { raw: new Set(), canon: new Set(), at: 0, count: 0 };
    this._persistTimer = null;
    this._keptBytes = 0;
    /** canonical text → the one GPUShaderModule the driver needs for it. */
    this._intern = new Map();
    this.internHits = 0;
    this.internBytesSaved = 0;
    this.#loadPrevious();
  }

  #loadPrevious() {
    try {
      const text = this.storage?.getItem?.(STORAGE_KEY);
      if (!text) return;
      const parsed = JSON.parse(text);
      this.previous = {
        raw: new Set(Array.isArray(parsed?.raw) ? parsed.raw : []),
        canon: new Set(Array.isArray(parsed?.canon) ? parsed.canon : []),
        at: Number(parsed?.at) || 0,
        count: Array.isArray(parsed?.raw) ? parsed.raw.length : 0,
      };
    } catch {
      /* a corrupt or unavailable store reads as "no previous boot" */
    }
  }

  /**
   * Record one module. Returns the text to hand to the device — canonical
   * when `canonical` is true — plus the hashes.
   */
  record(label, code, { canonical = true } = {}) {
    const raw = typeof code === "string" ? code : "";
    const canon = canonical ? canonicalizeWgsl(raw) : raw;
    const hash = hashText(raw);
    const canonHash = canon === raw ? hash : hashText(canon);
    const entry = {
      label: String(label ?? "").slice(0, 80),
      bytes: raw.length,
      hash,
      canonHash,
      renamed: canon !== raw,
      rawSeenLastBoot: this.previous.raw.has(hash),
      canonSeenLastBoot: this.previous.canon.has(canonHash),
      at: typeof performance !== "undefined" ? +performance.now().toFixed(0) : Date.now(),
      code: null,
    };
    if (this._keptBytes + canon.length <= MAX_KEPT_BYTES) {
      entry.code = canon;
      this._keptBytes += canon.length;
    }
    this.modules.push(entry);
    this.rawSet.add(hash);
    this.canonSet.add(canonHash);
    this.#schedulePersist();
    // The text the device gets is always the canonical one, kept or not.
    return entry.code === null ? { ...entry, code: canon } : entry;
  }

  #schedulePersist() {
    if (!this.storage || this._persistTimer) return;
    const schedule = typeof setTimeout === "function" ? setTimeout : null;
    if (!schedule) { this.persist(); return; }
    this._persistTimer = schedule(() => {
      this._persistTimer = null;
      this.persist();
    }, PERSIST_DEBOUNCE_MS);
    // A node test must not be held open by the debounce.
    this._persistTimer?.unref?.();
  }

  /** Write this boot's hash sets so the NEXT boot can score itself. */
  persist() {
    try {
      this.storage?.setItem?.(STORAGE_KEY, JSON.stringify({
        at: Date.now(),
        raw: [...this.rawSet],
        canon: [...this.canonSet],
      }));
    } catch {
      /* quota or a private window: the receipt is simply unavailable next boot */
    }
  }

  /** The `profile.freezes.wgsl` section. */
  summary({ limit = 8 } = {}) {
    const modules = this.modules;
    const bytes = modules.reduce((sum, m) => sum + m.bytes, 0);
    const rawHits = modules.filter((m) => m.rawSeenLastBoot).length;
    const canonHits = modules.filter((m) => m.canonSeenLastBoot).length;
    const renamed = modules.filter((m) => m.renamed).length;
    // The modules the rename rescued: the last boot compiled the same graph
    // under different ids.
    const rescued = modules.filter((m) => m.canonSeenLastBoot && !m.rawSeenLastBoot);
    // The modules still unstable: never seen even canonically, though this
    // is not the first boot. Sorted by size, because the big ones are the
    // minutes.
    const unstable = modules
      .filter((m) => !m.canonSeenLastBoot)
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, limit)
      .map((m) => ({ label: m.label, kB: +(m.bytes / 1024).toFixed(0), hash: m.canonHash }));
    return {
      modules: modules.length,
      kB: +(bytes / 1024).toFixed(0),
      renamed,
      previousBoot: this.previous.count
        ? { modules: this.previous.count, ageMinutes: +((Date.now() - this.previous.at) / 60000).toFixed(0) }
        : null,
      rawHitsFromLastBoot: rawHits,
      canonicalHitsFromLastBoot: canonHits,
      rescuedByRename: rescued.length,
      // Modules three asked for that the driver already had, byte for byte.
      // A high number here is not a problem being reported — it is work that
      // no longer reaches the GPU process.
      internedDuplicates: this.internHits,
      internedKB: +(this.internBytesSaved / 1024).toFixed(0),
      stillUnstable: unstable,
    };
  }

  /**
   * ── THE IN-PROCESS TWIN OF THE DISK CACHE ────────────────────────────────
   *
   * three interns its programs by WGSL text, so two graphs that produce the
   * same source share one `GPUShaderModule` — except the interning happens on
   * the text three GENERATED, and `canonicalizeWgsl` runs later, at
   * `createShaderModule`. Two graphs that differ only in `NodeBuffer_<node.id>`
   * naming are therefore distinct to three, identical to the driver, and get
   * two modules with byte-identical source.
   *
   * Measured on the user's Complex scene (2026-09-12): **129 of 336 modules
   * were redundant — 1 148 kB, 23 % of the boot's WGSL**, handed to a GPU
   * process that is the boot's bottleneck. Worst offenders are the foliage
   * family (`vertex_Foliage · living surface` ×4, `fragment_Foliage · surface`
   * ×5), which is also the family that owns 51 % of the wave.
   *
   * A `GPUShaderModule` is immutable and may back any number of pipelines, so
   * returning the same one for identical source is safe — it is exactly what
   * three already does one level up. The cache is per REGISTRY, and the
   * registry is per device, so a lost device cannot hand back a dead module.
   *
   * Keyed by canonical hash AND length, with the stored source compared before
   * reuse: a 32-bit FNV collision across a few hundred modules is unlikely but
   * handing the driver the WRONG shader would be undebuggable, and the string
   * compare is free beside a driver compile.
   *
   * `globalThis.__wgslInternModules = false` reverts to one module per call.
   */
  intern(code, make) {
    if (globalThis.__wgslInternModules === false) return make();
    const key = `${hashText(code)}:${code.length}`;
    const hit = this._intern.get(key);
    if (hit && hit.code === code) {
      this.internHits++;
      this.internBytesSaved += code.length;
      return hit.module;
    }
    const module = make();
    // A collision (same key, different text) simply does not cache the second.
    if (!hit) this._intern.set(key, { code, module });
    return module;
  }

  /** One module's text, for a diff between two boots (null text = not kept). */
  module(index) {
    const m = this.modules[index];
    return m ? { index, label: m.label, bytes: m.bytes, hash: m.hash, canonHash: m.canonHash, code: m.code } : null;
  }

  /** The module table without the text. */
  list() {
    return this.modules.map((m, index) => ({
      index,
      label: m.label,
      kB: +(m.bytes / 1024).toFixed(1),
      hash: m.hash,
      canonHash: m.canonHash,
      renamed: m.renamed,
      rawSeenLastBoot: m.rawSeenLastBoot,
      canonSeenLastBoot: m.canonSeenLastBoot,
      at: m.at,
    }));
  }
}
