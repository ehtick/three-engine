// @ts-check

/**
 * Automatic shadow-map freezing — stop re-rendering a shadow map for a scene
 * that has not moved.
 *
 * ## Why this exists
 *
 * A shadow map is a full extra submission of every shadow-casting mesh, from
 * the light's frustum rather than the camera's — so it is NOT reduced by
 * frustum culling of the view, and on a large scene it is routinely the biggest
 * draw consumer in the frame. Measured on Bistro (2026-08-17), after static
 * merging cut the main pass to 88 draws:
 *
 * | pass | draws |
 * |---|---|
 * | `ShadowMap:2048x2048#` | **459** |
 * | main opaque | 88 |
 * | depth prepass | 87 |
 *
 * **Seventy percent of the frame's draw calls were the shadow map**, redrawn
 * every frame for a static street under a static sun. The frame was CPU-bound on
 * submission (`renderEncode` 20.7 ms of a 28.2 ms tick), so that is 70 % of the
 * dominant cost being spent to reproduce an identical texture.
 *
 * ## Why it is automatic, when a manual switch already existed
 *
 * `shadow.autoUpdate` is real and Scene Settings exposes it, but a manual freeze
 * puts the invalidation burden on the author: freeze it and every later edit
 * silently renders with a stale shadow, which is a much worse bug than a slow
 * frame because it looks like a lighting mistake. So the switch was, correctly,
 * left on — and the cost was paid forever.
 *
 * A fingerprint takes neither horn. `godraysShadow.js` established the pattern
 * for exactly this problem one system over; this is the same idea applied to the
 * map that costs the most.
 *
 * ## The conservative rule
 *
 * The fingerprint returns `null` — read as "never freeze" — the moment it sees
 * geometry whose SILHOUETTE can change while its world matrix does not. Skinned
 * meshes and morph targets deform in the vertex shader, so no property this walk
 * can read moves when the shadow should. A miss here is a stale shadow, which is
 * a visible artifact and not a crash, so the rule is deliberately biased towards
 * doing the work.
 *
 * ⚠ A directional light's shadow camera TRACKS THE VIEW CAMERA (LightComponent
 * recentres it). With a one-texel snap that invalidated the map on every camera
 * nudge; LightComponent now snaps to `shadowCamSnap` world units (default 0.5)
 * and skips rewriting matrices inside a cell, so ShadowFreeze can stay engaged
 * while orbiting. Crossing a snap cell still redraws — that is correct: the
 * shadow volume really moved. The win is between steps, and on a parked camera.
 *
 * ⚠⚠ NEVER FINGERPRINT A VALUE THIS SYSTEM'S OWN OUTPUT GATES. The per-light
 * key must be built from inputs three refreshes unconditionally (world
 * matrices, authored parameters), never from state that only advances when the
 * shadow renders — `shadow.camera.matrixWorldInverse` is exactly that, and
 * using it froze every rotating light permanently. Full postmortem at the mix
 * site in `update()`.
 */

/**
 * Hash of everything that feeds a shadow map, or `null` for "never freeze".
 *
 * A rolling integer hash, not a joined string: this runs every frame over the
 * whole scene, and allocating hundreds of short-lived strings to save draw calls
 * would just move the cost onto the garbage collector — the exact mistake
 * `merging.js`' watchers were amortised to undo. Values are rounded to 1e-4 so
 * float jitter in a matrix recomputed every frame from unchanged inputs does not
 * read as motion.
 *
 * A collision costs ONE stale frame until the next real change, which is why a
 * hash is acceptable here and would not be for a cache key.
 */
function fingerprintCasters(scene) {
  let h = 0x811c9dc5;
  let dynamic = false;
  const mix = (v) => {
    h = Math.imul(h ^ (v | 0), 0x01000193) >>> 0;
  };
  scene.traverse((object) => {
    if (dynamic || !object.isMesh) return;
    // `vfxStatic` (2026-09-10): a GPU-animated caster (foliage wind, cloth,
    // water) whose animation clock is FROZEN this frame ("Run In Editor" off)
    // deforms in the vertex shader off a HELD time, so its shadow is constant
    // — treat it as an ordinary caster (fingerprinted by transform/visibility
    // below) rather than a permanent deforming one, so the map can freeze at
    // rest. `vfxSimulation` itself stays set (GI/physics/merge still read it).
    if (object.isSkinnedMesh || object.morphTargetInfluences?.length || (object.userData?.vfxSimulation && object.userData?.vfxStatic !== true)) {
      dynamic = true;
      return;
    }
    // Only CASTERS matter. A receiver moving changes what the shadow lands on,
    // which is resolved per-pixel at lookup time from a map that did not change.
    if (object.castShadow !== true) return;
    // Visibility is part of the content: hiding a caster must redraw the map.
    mix(object.visible === false ? 1 : 2);
    if (object.visible === false) return;
    mix(object.id);
    mix(object.geometry?.id ?? -1);
    const e = object.matrixWorld.elements;
    for (let i = 0; i < 16; i++) mix(Math.round(e[i] * 1e4));
    // Per-instance transforms live in a buffer this walk cannot see, but three
    // bumps `instanceMatrix.version` on every upload — the "did the silhouette
    // move" signal for two integers instead of a walk over N matrices. Bailing
    // on instanced meshes outright is what kept the equivalent optimisation
    // switched off in `godraysShadow.js`: ONE batching proxy anywhere in the
    // scene made every frame look dynamic.
    if (object.isInstancedMesh) {
      mix(object.count);
      mix(object.instanceMatrix?.version ?? -1);
    }
  });
  return dynamic ? null : h;
}

/**
 * Does the scene contain anything whose SILHOUETTE moves without its matrix?
 *
 * ⭐ THIS IS THE SAME TEST `fingerprintCasters` MAKES, HOISTED OUT OF THE PER-
 * FRAME WALK. A single skinned mesh anywhere — one character in a 1600-mesh
 * street — makes the fingerprint return `null` forever, so the freeze can never
 * engage and the full traversal is pure loss. MEASURED on Bistro:
 * `shadowFreeze` 1.147 ms of a 35.6 ms CPU frame (3.2 %) with `frozen: 0`, every
 * frame, to re-derive an answer that cannot change without a hierarchy edit.
 *
 * Being skinned or carrying morph targets is STRUCTURAL — a mesh cannot acquire
 * either without being rebuilt and re-added — so `hierarchy-changed` is a
 * complete invalidation signal, which is what makes caching this safe when
 * caching the fingerprint itself would not be.
 */
function sceneHasDeformingCaster(scene) {
  let found = false;
  scene.traverse((object) => {
    if (found || !object.isMesh) return;
    // ⚠ Deliberately NOT gated on `castShadow`, to match `fingerprintCasters`
    // exactly. Diverging here would make the fast path answer a different
    // question from the slow one, which is how a cache becomes a bug.
    // See `vfxStatic` note in fingerprintCasters: a frozen-clock GPU caster is
    // not deforming this frame, so it must not force the whole map dynamic.
    if (object.isSkinnedMesh || object.morphTargetInfluences?.length || (object.userData?.vfxSimulation && object.userData?.vfxStatic !== true)) found = true;
  });
  return found;
}

/**
 * Every shadow caster in the scene whose map this system can actually stop.
 *
 * ⚠⚠ THIS IS NOT `object.isLight`, AND THAT COST THE WHOLE OPTIMISATION.
 *
 * The gate this system writes is `shadow.autoUpdate`, and the only code that
 * reads it is `ShadowNode.updateBefore` (three r185, ShadowNode.js:855):
 *
 *     let needsUpdate = shadow.needsUpdate || shadow.autoUpdate;
 *     if ( needsUpdate ) this.updateShadow( frame );   // <- renders the map
 *
 * So the question is never "is this a light" — it is **"does a plain
 * `ShadowNode` own this map"**. Two cases break the naive answer, and CSM
 * manages to be both at once:
 *
 * 1. **A custom `shadow.shadowNode` means three SKIPS `ShadowNode` entirely.**
 *    `AnalyticLightNode.setupShadow` takes the custom node and never calls
 *    `setupShadowNode()`, so nothing reads `autoUpdate` and freezing such a
 *    light is a silent no-op. Both of this project's custom nodes land here:
 *    GI-traced shadows and `CSMShadowNode`.
 * 2. **A CSM cascade is NOT a Light.** `CSMShadowNode._init` builds one
 *    `class LwLight extends Object3D` per cascade — `castShadow = true`, a
 *    real cloned `DirectionalLightShadow`, wrapped in a real TSL
 *    `shadow(lwLight, lShadow)` node, and added to the scene graph by
 *    `updateBefore`. It carries **no `isLight`**, because it is an Object3D.
 *
 * Together those two produced a total, silent failure: an `object.isLight`
 * filter found ONLY the CSM parent — whose flag nothing reads (case 1) — and
 * never the cascades, which are the objects that actually own the maps and DO
 * honour the flag (case 2). Measured on Bistro (2026-08-24, 2 cascades at
 * 4096²): **842 of the frame's 1144 draws and 4.5M triangles re-rendered every
 * frame on a parked camera over static geometry**, ~46 ms of a 63 ms
 * `renderEncode` on an 83 ms CPU frame. `frozenLights` reported 1 the whole
 * time — a freeze that owned a light it could not stop.
 *
 * The predicate below therefore asks the structural question directly: it takes
 * anything that carries its own `shadow.camera` (that is what a map is rendered
 * from) and rejects anything whose map a custom node owns.
 */
import { shadowUpdateDue, shadowUpdateStride } from "./shadowUpdateStride.js";

export function collectFreezableCasters(scene) {
  const casters = [];
  scene.traverse((object) => {
    // A Mesh has `castShadow` too and no `shadow`, so this pair is what
    // separates "casts into someone's map" from "owns a map".
    if (object.castShadow !== true) return;
    const shadow = object.shadow;
    if (!shadow?.camera) return;
    // Clipmaps certify their own completed static/combined captures, including
    // material and deformation changes that this whole-scene key cannot see.
    if (shadow.clipmapCacheOwned === true) return;
    // Case 1: a custom node owns the render and never reads `autoUpdate`.
    // Freezing here would be a false receipt, not an optimisation. The CSM
    // parent light is excluded by exactly this — its cascades are found
    // separately, on their own placeholders, where the flag is real.
    if (shadow.shadowNode) return;
    // GI-traced lights already freeze themselves — their map is a 16x16 stub
    // that never renders. (Redundant with the check above while GI assigns a
    // `shadowNode`, and kept because it is a statement about GI's contract
    // rather than about three's internals.)
    if (object.userData?.giShadowMode === "gi") return;
    casters.push(object);
  });
  return casters;
}

/**
 * Per-frame shadow-map freezing across every shadow-casting light in the scene.
 *
 * Owns `shadow.autoUpdate` ONLY for lights it has taken over, and only while the
 * project has not frozen shadows itself — `settings.shadow.autoUpdate === false`
 * is an explicit authored choice and this must not quietly re-enable it.
 */
export class ShadowFreezeSystem {
  constructor(engine) {
    this.engine = engine;
    /** Lights this system currently manages, and their last content key. */
    this._keys = new WeakMap();
    /** @type {Set<any>} lights whose autoUpdate this system switched off. */
    this._owned = new Set();
    this.frozenLights = 0;
    /**
     * Casters this system could freeze, whether or not it did this frame.
     *
     * A RECEIPT, and it exists because the absence of one hid a total failure
     * for as long as CSM has been on: nothing anywhere reported how many maps
     * were actually being stopped, so a filter that found zero freezable
     * casters looked exactly like a scene that was legitimately moving. Any
     * frame where `managedLights` is 0 on a shadowed scene, or where
     * `frozenLights` stays 0 on a parked one, is this system not working.
     */
    this.managedLights = 0;
    /**
     * Why the freeze is doing what it is doing, for `profile.frameStats`.
     *
     * `frozenLights: 0` reads identically whether the scene is legitimately
     * moving, the author switched shadows off, or one skinned mesh has disabled
     * the whole system — three very different problems. Nothing said which.
     */
    this.reason = "not run yet";
    /** Cached answer to `sceneHasDeformingCaster`, keyed on hierarchy edits. */
    this._hasDeformingCaster = false;
    this._deformDirty = true;
    this._deformOff = null;
    /** Renderer/device identity, so a rebuild or device loss un-freezes. */
    this._rendererSeen = false;
    this._renderer = null;
    this._device = null;
    this.enabled = true;
  }

  update() {
    const engine = this.engine;
    const scene = engine?.scene;
    if (!scene) return;
    // The author's own freeze wins outright: re-enabling autoUpdate under a
    // project that switched it off would be this system overriding a setting
    // rather than implementing one.
    // Published for `asyncRenderPipelines`' busy gate: true ONLY on the path
    // below that releases every freeze and re-renders each map every frame, so
    // a pipeline still compiling can never be baked into cached shadow content.
    // Every other path — this system freezing, the author's one-shot shadows,
    // an update stride, a device change — leaves it false.
    if (engine.renderer) engine.renderer.__shadowMapsRedrawnEveryFrame = false;
    if (this.enabled === false) {
      this.reason = "disabled";
      this.#releaseAll(true);
      return;
    }
    if (engine.settings?.shadow?.autoUpdate === false) {
      this.reason = "the project authored shadow.autoUpdate = false";
      // Do not restore a flag the author explicitly switched off. In
      // particular, a light can still be in `_owned` when Scene Settings is
      // changed from automatic to one-shot shadows; the old release path
      // immediately wrote `true` back and made that setting render forever.
      this.#releaseAll(false);
      return;
    }

    // ⭐ THE CHEAP QUESTION FIRST. See sceneHasDeformingCaster: one skinned mesh
    // makes every later step futile, and asking it per frame cost more than the
    // freeze was ever going to save on a scene that has one.
    if (!this._deformOff && typeof engine.on === "function") {
      this._deformOff = engine.on("hierarchy-changed", () => {
        this._deformDirty = true;
      });
    }
    if (this._deformDirty) {
      this._deformDirty = false;
      this._hasDeformingCaster = sceneHasDeformingCaster(scene);
    }
    if (this._hasDeformingCaster) {
      this.reason = "a skinned or morphing mesh is present — no matrix this walk can read moves when its shadow should";
      this.managedLights = 0;
      this.#releaseAll();
      this.#applyUpdateStride(scene);
      if (engine.renderer && this.updateStride <= 1) engine.renderer.__shadowMapsRedrawnEveryFrame = true;
      return;
    }

    // ⚠⚠ A NEW RENDERER OR A NEW DEVICE MEANS EVERY SHADOW MAP IS GONE, AND A
    // FROZEN LIGHT WILL NEVER NOTICE.
    //
    // The fingerprint answers "has the SCENE changed", and after a device loss
    // or a renderer rebuild the scene is byte-for-byte identical — the casters
    // did not move, the light did not rotate, the map resolution is the same.
    // So the key matches, `autoUpdate` stays false, and three never re-renders
    // a map that is now an EMPTY texture on a fresh device. The whole scene
    // loses its shadows, permanently, and nothing in the scene can ever bring
    // them back: exactly the "stale shadow reads as a lighting bug" failure
    // this file's header calls more expensive than a slow frame.
    //
    // This was invisible before CSM cascades became freezable, because they
    // were never frozen — a lost device healed itself on the very next frame.
    // Making the freeze work is what made this reachable.
    //
    // Checked by IDENTITY every frame rather than wired to an event, on
    // purpose: `renderer-rebuilt` exists, but a freeze that depends on someone
    // remembering to notify it is a freeze that will silently stop being
    // correct. Two reference compares per frame cost nothing.
    const renderer = engine.renderer;
    const device = renderer?.backend?.device;
    // The FIRST observation is not a change — nothing is frozen yet, and
    // treating it as one would spend a frame resetting state that is already
    // empty (and, in a fixture, silently shift every later expectation).
    const changed = this._rendererSeen && (renderer !== this._renderer || device !== this._device);
    this._rendererSeen = true;
    this._renderer = renderer;
    this._device = device;
    if (changed) {
      this.#releaseAll();
      // A FIRST SIGHTING AGAIN, not merely unfrozen: the keys must go too, or
      // the very next update matches the pre-loss key and re-freezes the empty
      // map on the frame after. Dropping the map restores the "same key twice"
      // rule, which guarantees three completes one real render first.
      this._keys = new WeakMap();
      this.managedLights = 0;
      return;
    }

    const lights = collectFreezableCasters(scene);
    this.managedLights = lights.length;
    if (!lights.length) {
      this.reason = "no caster owns a plain ShadowNode — every map here has a custom node (CSM/GI)";
      this.#releaseAll();
      return;
    }

    // ONE traversal for the whole scene, not one per light: the caster set is
    // shared, and only the shadow CAMERA differs between lights.
    const content = fingerprintCasters(scene);
    if (content === null) {
      // Something in the scene deforms without moving. Hand every light back.
      // ⭐ THE BACKSTOP TEACHES THE CACHE. Reaching here means a deforming mesh
      // arrived by a route that is not `hierarchy-changed` — MEASURED on Bistro,
      // where a ModelComponent swapping in a skinned GLB announces itself as
      // `component-changed:mesh`, so this branch fired every single frame and
      // the cheap path never did. Recording what the slow path just proved makes
      // the next frame take the early exit; `hierarchy-changed` still clears it,
      // so removing the character still restores the freeze.
      this._hasDeformingCaster = true;
      this.reason = "a deforming caster appeared without a hierarchy edit";
      this.#releaseAll();
      return;
    }

    // ⭐⭐ PROOF THAT A RENDER HAPPENED BETWEEN THE TWO SIGHTINGS.
    //
    // The freeze rule is "same key twice", and its entire safety rests on three
    // having rendered the map at least once in between — see the `autoUpdate`
    // note below. That was enforced only by WHERE `Engine#tick` called this,
    // and the call sat ABOVE the tick's `renderSuspended` early return, so a
    // suspended GI compile wave produced update() calls on frames that never
    // drew. Store the key on one of those, match it on the next, and the light
    // is frozen with `autoUpdate = false` on a map three has never rendered.
    // Both flags false, three's gate is `needsUpdate || autoUpdate`, and the
    // map stays EMPTY until something else sets `needsUpdate` — reported as
    // "shadows are broken after each reload, have to change bias to fix them"
    // (user, 2026-08-25). The tick order is fixed too, but a caller-side
    // invariant that only a comment defends is one refactor from returning, so
    // it is now checked here.
    //
    // `info.render.calls` is cumulative and nothing in this engine resets it,
    // which is exactly the property needed: it advances if and only if the
    // renderer actually ran.
    const renderCalls = this.engine?.renderer?.info?.render?.calls ?? 0;

    let frozen = 0;
    for (const light of lights) {
      const shadow = light.shadow;
      let key = content;
      const mixKey = (v) => {
        key = Math.imul(key ^ (v | 0), 0x01000193) >>> 0;
      };
      const mixMatrix = (m) => {
        if (!m) return;
        const e = m.elements;
        for (let i = 0; i < 16; i++) mixKey(Math.round(e[i] * 1e4));
      };
      // ⚠⚠ THE LIGHT'S OWN TRANSFORM, NOT THE SHADOW CAMERA'S WORLD MATRIX.
      //
      // This used to fold in `shadow.camera.matrixWorldInverse`, which reads
      // like the right thing — it is literally the view the map is rendered
      // from — and it is a FEEDBACK LOOP. `LightShadow.updateMatrices()` is
      // what recomputes that matrix from the light, and three only calls it
      // from `ShadowNode.updateShadow()`, which is gated on
      // `shadow.needsUpdate || shadow.autoUpdate` — the very flag this system
      // writes. So the moment a light is frozen, its shadow camera stops
      // moving, the key can never change again, and the freeze is PERMANENT:
      //
      //   frame N   user rotates the sun. Casters unchanged; the shadow camera
      //             still holds frame N-1's matrix, so the key matches the
      //             previous one and `autoUpdate` goes false.
      //   frame N+1 the shadow camera is frozen at the pre-rotation pose, so
      //             the key matches again... forever.
      //
      // Reported as "shadow map from the directional light does not update when
      // I rotate it, though auto update is on" (2026-08-17) — and `autoUpdate`
      // genuinely IS on in Scene Settings; this system had taken the light over
      // and switched the per-light flag off underneath it.
      //
      // The fix is to key on INPUTS three updates unconditionally rather than
      // on a derived value the freeze itself gates. `light.matrixWorld` and the
      // target's are refreshed by `scene.updateMatrixWorld()` every render, and
      // `LightComponent#syncDirectionalTransform` rewrites the local matrices
      // in `onPreRender` — before this runs — so both a same-frame and a
      // next-frame read of a rotation are caught. Worst case is one stale
      // frame; the old worst case was "stale until something else moves".
      mixMatrix(light.matrixWorld);
      mixMatrix(light.matrix);
      mixMatrix(light.target?.matrixWorld);
      mixMatrix(light.target?.matrix);
      // Spot cone angle and range drive the shadow camera's fov/far, and both
      // reach it through `updateMatrices` — i.e. through the same gate.
      mixKey(Math.round((light.angle ?? -1) * 1e4));
      mixKey(Math.round((light.distance ?? -1) * 1e4));
      const camera = shadow.camera;
      if (camera) {
        // The projection is safe to read directly: `updateProjectionMatrix()`
        // is called by whoever edits the frustum (LightComponent on a prop
        // change), not by the shadow render, so it is not part of the loop.
        mixMatrix(camera.projectionMatrix);
        // The shadow camera's view matrix stays in the key as a SECOND signal,
        // never the only one. It cannot cost a stale map (an extra input can
        // only ever invalidate more often) and it catches anything that poses
        // the shadow camera directly instead of through the light. It just
        // must not be relied on alone — see the block above.
        mixMatrix(camera.matrixWorldInverse);
      }
      // Map resolution is not in any matrix, and changing it must redraw.
      mixKey(shadow.mapSize?.width ?? 0);
      mixKey(shadow.mapSize?.height ?? 0);
      // ⚠ THIS SYSTEM WRITES `autoUpdate` AND NOTHING ELSE. It must never set
      // `shadow.needsUpdate` itself, and that is a crash, not a preference:
      //
      //   // three/src/nodes/lighting/ShadowNode.js, updateBefore()
      //   let needsUpdate = shadow.needsUpdate || shadow.autoUpdate;
      //   if ( needsUpdate ) {
      //     this.updateShadow( frame );
      //     if ( this.shadowMap.depthTexture.version === ... )   // UNGUARDED
      //
      // Forcing `needsUpdate` on a light whose ShadowNode has not built its map
      // yet drives that branch before `shadowMap` exists — `Uncaught TypeError:
      // Cannot read properties of null (reading 'depthTexture')`, thrown out of
      // `renderer.render` and killing the tick. Restoring `autoUpdate` instead
      // asks for exactly the same render through the path three already owns,
      // on its own schedule, with its own initialisation guarantees.
      //
      // A first sight therefore CHANGES NOTHING: the light keeps rendering
      // normally and is only frozen once the same key has been seen twice, so
      // three is guaranteed to have completed at least one real shadow render
      // before this system ever switches it off.
      const previous = this._keys.get(light);
      if (previous?.key === key && renderCalls > previous.calls) {
        shadow.autoUpdate = false;
        this._owned.add(light);
        frozen++;
      } else {
        // A repeat key with no render in between leaves the record ALONE, so
        // the freeze still lands on the first sighting after the renderer
        // actually runs rather than restarting the count.
        if (previous?.key !== key) this._keys.set(light, { key, calls: renderCalls });
        shadow.autoUpdate = true;
        this._owned.add(light);
      }
    }
    this.frozenLights = frozen;
    this.reason = frozen === lights.length
      ? `frozen (${frozen}/${lights.length})`
      : `redrawing — the scene key changed (${frozen}/${lights.length} frozen)`;
  }

  /**
   * Give every managed light its `autoUpdate` back and forget its key.
   *
   * `autoUpdate = true` alone is a complete restore: three's own gate is
   * `shadow.needsUpdate || shadow.autoUpdate`, so the map renders again on the
   * very next frame. Raising `needsUpdate` as well would add nothing and can
   * throw — see the note in `update()`.
   */
  /**
   * A portable device re-renders its maps every Nth frame
   * (shadowUpdateStride.js) when nothing here can freeze them — the
   * deforming-caster case above, which is every scene with a character in
   * it. Owns `autoUpdate` the same way the freeze does and hands it back the
   * moment the stride returns to 1 (a pin change; a desktop never enters).
   */
  #applyUpdateStride(scene) {
    const stride = shadowUpdateStride();
    if (stride <= 1) {
      if (this._strideLights?.size) {
        for (const light of this._strideLights) if (light.shadow) light.shadow.autoUpdate = true;
        this._strideLights.clear();
      }
      this.updateStride = 1;
      return;
    }
    const frame = this.engine.renderer?.info?.frame ?? (this._strideFrame = (this._strideFrame ?? 0) + 1);
    const due = shadowUpdateDue(frame, stride);
    const lights = collectFreezableCasters(scene);
    this._strideLights ??= new Set();
    for (const light of lights) {
      const shadow = light.shadow;
      if (!shadow || this._owned.has(light)) continue;
      shadow.autoUpdate = false;
      // Set on due frames, CLEARED on the others: three clears `needsUpdate`
      // itself only when the depth texture's version survived the render
      // (ShadowNode.updateBefore), and on the user's iPhone it did not — the
      // flag stayed up, every frame rendered, and two lit render calls a
      // frame rendered it twice (the ledger read `ShadowMap × 2.00` with the
      // stride armed). The stride owns the flag now, both ways.
      shadow.needsUpdate = due;
      this._strideLights.add(light);
    }
    this.updateStride = stride;
    this.updateStrideDue = due;
  }

  #releaseAll(restoreAutoUpdate = true) {
    if (!this._owned.size) return;
    for (const light of this._owned) {
      // CSM disposes and rebuilds its cascade placeholders on any cascade-count
      // or renderer change, so `_owned` can outlive the object it names.
      if (restoreAutoUpdate && light.shadow) light.shadow.autoUpdate = true;
      this._keys.delete(light);
    }
    this._owned.clear();
    this.frozenLights = 0;
  }

  dispose() {
    if (this._strideLights?.size) {
      for (const light of this._strideLights) if (light.shadow) light.shadow.autoUpdate = true;
      this._strideLights.clear();
    }
    this._deformOff?.();
    this._deformOff = null;
    this.#releaseAll();
  }
}
