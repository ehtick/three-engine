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
    if (object.isSkinnedMesh || object.morphTargetInfluences?.length) {
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
    this.enabled = true;
  }

  update() {
    const engine = this.engine;
    const scene = engine?.scene;
    if (!scene) return;
    // The author's own freeze wins outright: re-enabling autoUpdate under a
    // project that switched it off would be this system overriding a setting
    // rather than implementing one.
    if (this.enabled === false || engine.settings?.shadow?.autoUpdate === false) {
      this.#releaseAll();
      return;
    }

    const lights = [];
    scene.traverse((object) => {
      if (object.isLight && object.castShadow && object.shadow) lights.push(object);
    });
    if (!lights.length) {
      this.#releaseAll();
      return;
    }

    // ONE traversal for the whole scene, not one per light: the caster set is
    // shared, and only the shadow CAMERA differs between lights.
    const content = fingerprintCasters(scene);
    if (content === null) {
      // Something in the scene deforms without moving. Hand every light back.
      this.#releaseAll();
      return;
    }

    let frozen = 0;
    for (const light of lights) {
      const shadow = light.shadow;
      // GI-traced lights already freeze themselves — their map is a 16×16 stub
      // that never renders, and touching `needsUpdate` here would make it render.
      if (light.userData?.giShadowMode === "gi") continue;
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
      if (previous === key) {
        shadow.autoUpdate = false;
        this._owned.add(light);
        frozen++;
      } else {
        this._keys.set(light, key);
        shadow.autoUpdate = true;
        this._owned.add(light);
      }
    }
    this.frozenLights = frozen;
  }

  /**
   * Give every managed light its `autoUpdate` back and forget its key.
   *
   * `autoUpdate = true` alone is a complete restore: three's own gate is
   * `shadow.needsUpdate || shadow.autoUpdate`, so the map renders again on the
   * very next frame. Raising `needsUpdate` as well would add nothing and can
   * throw — see the note in `update()`.
   */
  #releaseAll() {
    if (!this._owned.size) return;
    for (const light of this._owned) {
      light.shadow.autoUpdate = true;
      this._keys.delete(light);
    }
    this._owned.clear();
    this.frozenLights = 0;
  }

  dispose() {
    this.#releaseAll();
  }
}
