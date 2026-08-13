// @ts-check
/**
 * In-place live updates for the browser preview — the player's half of the
 * connector the injected preview client (see editor/build/playerHtml.js)
 * talks to.
 *
 * The goal is the editor's own behaviour: an authored change appears in the
 * running build without anything restarting. Two earlier generations of this
 * both failed that bar in ways that looked identical to the user:
 *
 *  1. `location.reload()` on every rebuild — a full page load, WebGPU adapter
 *     init and every shader compile again, per gizmo nudge.
 *  2. `engine.loadScene()` on every scene edit — no page load, but it still
 *     destroyed and rebuilt the whole scene behind the loading screen, reset
 *     the camera, and re-ran GI voxelization. Visually a reload.
 *
 * So scene edits go through `reconcileScene`, the same diffing restore the
 * editor uses when leaving Play mode: entities that did not change are not
 * touched, and (in this mode) neither are the scripts, sounds and animations
 * running inside them. Assets update through the caches that own them, the
 * way the editor's project watcher does it.
 *
 * The one thing that genuinely cannot be hot-applied is new ENGINE code
 * (`_engine/`, index.html). That returns false and the client reloads.
 *
 * Installed only when the build carries `player.livePreview` (the exporter
 * sets it for preview builds alone), so a published game never grows a
 * `window.__playerLiveUpdate` hook.
 */
import { reconcileScene } from "../engine/serialize.js";
import { applyEngineModules } from "../engine/modules.js";
import { reloadMaterialAsset, refreshMaterialsUsingTexture } from "../engine/materialAsset.js";
import { invalidateShaderTextureCache } from "../engine/tslGraph.js";
import { invalidateGeometryAsset } from "../engine/geometryAsset.js";
import { invalidateCubemapAsset } from "../engine/cubemapAsset.js";
import { invalidateAtlasAsset } from "../engine/sprite/atlasAsset.js";
import { disposeAudioAsset } from "../engine/audio/AudioAsset.js";

const TEXTURE_RE = /\.(png|jpe?g|webp|basis|ktx2|hdr|exr)$/i;
const AUDIO_RE = /\.(audio|wav|mp3|ogg|opus|flac|m4a|webm)$/i;
const SCENE_RE = /\.scene$/i;

const norm = (p) => String(p ?? "").replaceAll("\\", "/");

/** Build-relative files the hot path understands. Everything else — above all
 *  the `_engine/` runtime bundle — means "reload the page". */
const isGameData = (rel) =>
  rel === "scene.json" ||
  rel.startsWith("assets/") ||
  SCENE_RE.test(rel) ||
  /^icon\.[a-z0-9]+$/i.test(rel);

/**
 * Does any string anywhere in `value` name one of `wanted`?
 *
 * Deliberately structural rather than schema-driven: a component references
 * assets from schema fields, from nested lists (script slots, sound entries)
 * and from plain maps (a model's per-material overrides). A false positive
 * costs one component re-attach; a false negative shows stale pixels.
 */
function referencesAny(value, wanted, depth = 0) {
  if (depth > 6 || value == null) return false;
  if (typeof value === "string") return wanted.has(norm(value));
  if (typeof value !== "object") return false;
  for (const inner of Object.values(value)) {
    if (referencesAny(inner, wanted, depth + 1)) return true;
  }
  return false;
}

/**
 * Re-attaches every component that names one of `paths`, so it re-reads the
 * asset through its own loader.
 *
 * Dropping a cache entry is only half of an asset update: a Sprite holds its
 * decoded texture, a Mesh holds its geometry instance, an atlas consumer holds
 * its parsed sheet. Nothing tells them the bytes moved. Remove + re-add with
 * the same props is the one generic "reload yourself" every component already
 * implements correctly, via `onAttach`.
 *
 * Scripts are excluded on purpose — they have a real hot-reload path that
 * preserves state (see `refreshScript`), and re-attaching would throw it away.
 */
function refreshComponentsReferencing(engine, paths) {
  const wanted = new Set(paths.map(norm));
  if (!wanted.size) return 0;
  let count = 0;
  for (const entity of [...engine.entities.values()]) {
    for (const component of [...entity.components.values()]) {
      const type = component.type;
      if (type === "script") continue;
      const { props } = component.toJSON();
      if (!referencesAny(props, wanted)) continue;
      entity.removeComponent(type);
      entity.addComponent(type, props);
      count++;
    }
  }
  return count;
}

/** The scene file the running game is currently in. */
function currentScenePath(engine) {
  const loaded = engine.scenes?.loaded ?? [];
  const single = loaded.find((s) => s?.mode === "single") ?? loaded[0];
  return norm(single?.path || "scene.json");
}

/**
 * @param {any} engine
 * @param {{ refreshScript: (path: string) => Promise<void> }} deps
 *   `refreshScript` lives in main.js — it owns the script module cache the
 *   ScriptComponent loader reads from.
 */
export function installLiveUpdate(engine, { refreshScript }) {
  /**
   * @param {string[]} changed  build-relative paths the last rebuild rewrote
   * @returns {Promise<boolean>} true when applied in place; false = reload me
   */
  globalThis.__playerLiveUpdate = async (changed) => {
    if (!Array.isArray(changed)) return false;
    const files = [...new Set(changed.map(norm))];
    // A rebuild that rewrote nothing (the common case while the editor is
    // idle) is already applied.
    if (!files.length) return true;
    if (!files.every(isGameData)) return false;

    const materials = [];
    const scripts = [];
    const owned = []; // assets whose holders must re-read them
    const scenes = new Set();

    for (const rel of files) {
      if (rel === "scene.json" || SCENE_RE.test(rel)) {
        scenes.add(rel);
      } else if (/\.mat$/i.test(rel)) {
        materials.push(rel);
      } else if (/\.js$/i.test(rel)) {
        scripts.push(rel);
      } else if (/^icon\./i.test(rel)) {
        // The favicon. Nothing in the running game reads it.
      } else if (/\.meta$/i.test(rel)) {
        // Import settings (filtering, wrap, compression). The asset itself is
        // unchanged, so refresh whatever samples it.
        const base = rel.replace(/\.meta$/i, "");
        if (TEXTURE_RE.test(base)) {
          invalidateShaderTextureCache(base);
          refreshMaterialsUsingTexture(base);
        }
        owned.push(base);
      } else if (TEXTURE_RE.test(rel)) {
        // Materials pick new pixels up through their own graph cache; sprites,
        // decals and UI images own their texture and re-read on re-attach.
        invalidateShaderTextureCache(rel);
        refreshMaterialsUsingTexture(rel);
        owned.push(rel);
      } else if (/\.geom$/i.test(rel)) {
        invalidateGeometryAsset(rel);
        owned.push(rel);
      } else if (/\.cubemap$/i.test(rel)) {
        invalidateCubemapAsset(rel);
        owned.push(rel);
      } else if (/\.atlas$/i.test(rel)) {
        invalidateAtlasAsset(rel);
        owned.push(rel);
      } else if (AUDIO_RE.test(rel)) {
        // The decode cache keys on the `.audio` sidecar path; for a raw file
        // drop the sibling sidecar too (a miss is harmless).
        disposeAudioAsset(rel);
        disposeAudioAsset(rel.replace(/\.[^.]+$/, ".audio"));
        owned.push(rel);
      } else {
        // Models, fonts, timelines, animation controllers, future formats:
        // fetched fresh by whichever component names them.
        owned.push(rel);
      }
    }

    for (const rel of materials) {
      // `false` (never loaded) just means nothing on screen uses it.
      await reloadMaterialAsset(rel).catch((err) =>
        console.warn(`[live] material ${rel}: ${err?.message ?? err}`),
      );
    }
    for (const rel of scripts) {
      // A script that no longer parses is broken either way — a page reload
      // would not run it any better. Report and carry on.
      await refreshScript(rel).catch((err) =>
        console.warn(`[live] script ${rel}: ${err?.message ?? err}`),
      );
    }

    // A changed scene the game is NOT currently in needs nothing: scene files
    // are fetched fresh whenever the game loads one.
    const current = currentScenePath(engine);
    if (scenes.has(current)) {
      const json = await (await fetch(current, { cache: "no-cache" })).json();
      // Build-level config rides along in the start scene and can change
      // under the author's hands too.
      if (json.player?.title) document.title = json.player.title;
      // Set before reconcile: `applySettings` clamps the scene's authored
      // performance block against this ceiling on the way in.
      engine.config.quality = json.player?.quality ?? null;
      if (json.physics) engine.config.physicsLayers = json.physics;
      // Idempotent — it diffs against what is already running, so a module
      // the author just enabled starts and a disabled one is torn down.
      if (Array.isArray(json.modules)) await applyEngineModules(engine, json.modules);
      if (json.input) engine.applyInput(json.input);
      if (json.events) engine.applyEvents(json.events);
      // Parked pool instances are not in the snapshot, so the reconcile would
      // destroy them out from under their buckets. Clearing first is what both
      // other restore paths do (`#unloadAll`, leaving Play).
      engine.pool?.reset?.();
      await reconcileScene(engine, json, { resetStatefulComponents: false });
    }

    // After reconcile: it may have re-created some of these components anyway,
    // and a re-attach of something it just built is still correct.
    const refreshed = refreshComponentsReferencing(engine, owned);

    console.log(
      `[live] applied ${files.length} change(s) in place` +
        `${scenes.has(current) ? " (scene reconciled)" : ""}` +
        `${materials.length ? `, ${materials.length} material(s)` : ""}` +
        `${scripts.length ? `, ${scripts.length} script(s)` : ""}` +
        `${refreshed ? `, ${refreshed} component(s) reloaded` : ""}`,
    );
    return true;
  };
}
