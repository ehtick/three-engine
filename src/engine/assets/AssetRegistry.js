import { loadTextureAsset } from "../textureAsset.js";
import { loadMaterialAsset, getMaterialInstance } from "../materialAsset.js";
import { acquireGeometryAsset, releaseGeometryAsset } from "../geometryAsset.js";
import { loadAudioAsset, getAudioBuffer } from "../audio/AudioAsset.js";
import { loadCubemapAsset, getLoadedCubemap } from "../cubemapAsset.js";
import { assetCatalog } from "./catalog.js";

/**
 * `engine.assets` — script-facing access to the same texture / material /
 * geometry / audio / cubemap caches components already load through.
 *
 * There is no separate ID scheme here: every asset in the project (other than
 * prefabs, which use a guid — see `prefab/registry.js`) is already addressed
 * by its own project-relative path, the same string an `@attribute({ type:
 * "asset" })` field gives you in the Inspector. This class exists so a
 * script can turn that path into the live resource without knowing which of
 * five differently-shaped loader modules owns it.
 *
 * Every accessor returns (or resolves to) the SHARED instance other systems
 * are also using — do not mutate or dispose it. `geometry()` is the one
 * exception: it is refcounted, so pair every call with `releaseGeometry()`.
 */
export class AssetRegistry {
  constructor(engine) {
    this._engine = engine;
    // loadTextureAsset has no cache of its own (each call decodes + uploads a
    // fresh GPU texture) — materials get away with that because they load
    // their map exactly once per .mat. A script calling `texture(path)`
    // repeatedly (e.g. every frame) would otherwise leak a texture per call.
    this._textures = new Map(); // cacheKey -> Promise<Texture>
  }

  /**
   * Loads (or returns the already-loading/loaded) texture at `path`. Repeat
   * calls with the same path + colorSpace share one in-flight/settled
   * promise and one GPU texture.
   */
  texture(path, options = {}) {
    const key = `${path}|${options.colorSpace ?? ""}`;
    let promise = this._textures.get(key);
    if (!promise) {
      promise = loadTextureAsset(path, options);
      this._textures.set(key, promise);
      // A failed load must not poison the cache — the file may appear later.
      promise.catch(() => {
        if (this._textures.get(key) === promise) this._textures.delete(key);
      });
    }
    return promise;
  }

  /** The shared `.mat` material for `path`, loading its def on first use. */
  material(path) {
    return loadMaterialAsset(path);
  }

  /** The live material instance for `path`, or null if not loaded yet. */
  getMaterial(path) {
    return getMaterialInstance(path);
  }

  /**
   * Borrows the shared geometry for a `.geom` path, incrementing its
   * refcount. Pair every call with `releaseGeometry` (e.g. in `onDestroy`)
   * once you are done with the instance.
   */
  geometry(path) {
    return acquireGeometryAsset(path);
  }

  /** Returns a geometry borrowed via `geometry()`. */
  releaseGeometry(geometry) {
    return releaseGeometryAsset(geometry);
  }

  /**
   * Decoded `AudioBuffer` for an audio asset path. Ensures the shared
   * AudioContext exists first, so it's safe to call before any user gesture
   * — the buffer just won't be ready (resolves null) until one arrives.
   */
  async audio(path) {
    const context = await this._engine.audio.ensureContext();
    return loadAudioAsset(path, context);
  }

  /** The already-decoded buffer for `path`, or null if not loaded yet. */
  getAudioBuffer(path) {
    return getAudioBuffer(path);
  }

  /** The shared `CubeTexture` for a `.cubemap` path. */
  cubemap(path) {
    return loadCubemapAsset(path);
  }

  /** The already-loaded cube texture for `path`, or null if not loaded yet. */
  getCubemap(path) {
    return getLoadedCubemap(path);
  }

  /**
   * The path of the asset named `name` (case-insensitive, exact match), or
   * null if none is known. Two assets can legitimately share a basename
   * (`textures/wood/color.png` and `textures/stone/color.png`) — this
   * returns the first in path order; prefer `findAllByName` when that's a
   * real possibility for your project.
   *
   * Coverage follows the catalog, not the filesystem: in the editor that's
   * whatever project-wide scan / tag edit has run; in a build it's only
   * assets a shipped scene actually references (an asset tagged but never
   * placed in any scene never ships, so it's never found here either).
   */
  findByName(name) {
    return this.findAllByName(name)[0] ?? null;
  }

  /** Every known asset path named `name` (case-insensitive, exact match). */
  findAllByName(name) {
    return assetCatalog.findByName(name).sort();
  }

  /** Every known asset path carrying `tag`. */
  byTag(tag) {
    return assetCatalog.findByTag(tag).sort();
  }

  /**
   * Every known asset path carrying at least one (`mode: "any"`, default) or
   * every one (`mode: "all"`) of `tags`.
   */
  byTags(tags, mode = "any") {
    return assetCatalog.findByTags(tags, mode).sort();
  }
}
