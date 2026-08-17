/**
 * A small, invisible shadow map kept alive purely so god rays have something to
 * raymarch when the light's real shadows come from GI.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * `GodraysNode` samples `light.shadow.map.depthTexture` at every step of its
 * view-ray march — it is a shadow-map effect by construction, not by
 * preference. A light using GI-traced shadows keeps `castShadow` true (three
 * only compiles a shadow branch for shadow-casters, and GI's custom
 * `shadowNode` replaces the map LOOKUP inside it), but three then never renders
 * a map at all: `AnalyticLightNode.setupShadow` takes the custom node and
 * SKIPS `setupShadowNode()`, which is the thing that owns the map. So
 * `shadow.map` stays null and building the god-rays node against it throws
 * `Cannot read properties of null (reading 'depthTexture')` from inside TSL.
 *
 * We cannot ask three to render it — it has opted out of the path. So we render
 * it ourselves, at a resolution chosen for a volumetric effect rather than for
 * surface shadows, and assign it to `light.shadow.map`. Every field the node
 * reads (`shadow.map.depthTexture`, `shadow.camera`, and `shadow.matrix` via
 * TSL's `lightShadowMatrix`) is then populated exactly as three would have, so
 * `GodraysNode` works unmodified and GI keeps owning what materials actually
 * shade with.
 *
 * ── WHY 1024 IS PLENTY ─────────────────────────────────────────────────────
 *
 * This map never touches a surface. It decides whether a point in FOG is lit,
 * and the march already dithers and blurs its result — the frequency it needs
 * is far below what a shadow silhouette needs. 1024² is 4 MB against the 4x64
 * MB of real cascades the gi mode removed, and its depth pass measured free at
 * 4096² when frozen ([[new-sponza-perf]]).
 */
import * as THREE from "three/webgpu";

/** Depth-only override; the colour attachment is never read. */
let overrideMaterial = null;

/**
 * A string that changes whenever this map's content would change, or `null`
 * for "never freeze this scene".
 *
 * Built from the shadow camera's projection·view and, per drawn mesh, its
 * world matrix, geometry id and visibility. Returns `null` — which the caller
 * reads as "always redraw" — the moment it sees a mesh whose SILHOUETTE can
 * change while its matrix does not: skinned meshes and morph targets deform in
 * the vertex shader, so a transform fingerprint is blind to them, and a stale
 * god-ray shadow of a character mid-stride is a visible artifact. Instanced
 * meshes are excluded for the same reason (per-instance matrices live in a
 * buffer this cannot see).
 *
 * A rolling integer hash rather than a joined string: this runs every frame,
 * and 400+ `toFixed` calls per frame to avoid ~1 ms of GPU work is a bad
 * trade. Values are rounded to 1e-4 first so float jitter in a matrix
 * recomputed every frame from unchanged inputs does not read as motion. A hash
 * collision costs one stale frame until the next real change, which is why a
 * hash is acceptable here and would not be for, say, a cache key.
 */
function fingerprintOccluders(scene, light) {
  const camera = light.shadow?.camera;
  if (!camera) return null;
  let h = 0x811c9dc5;
  const mix = (v) => {
    h = (Math.imul(h ^ (v | 0), 0x01000193) >>> 0);
  };
  const pushMatrix = (m) => {
    const e = m.elements;
    for (let i = 0; i < 16; i++) mix(Math.round(e[i] * 1e4));
  };
  pushMatrix(camera.projectionMatrix);
  pushMatrix(camera.matrixWorldInverse);
  let dynamic = false;
  scene.traverse((object) => {
    if (dynamic || !object.isMesh || object.visible === false) return;
    // Skinning and morph targets deform in the VERTEX SHADER, so no property
    // this loop can read changes when the silhouette does — bail entirely.
    if (object.isSkinnedMesh || object.morphTargetInfluences?.length) {
      dynamic = true;
      return;
    }
    mix(object.id);
    mix(object.geometry?.id ?? -1);
    pushMatrix(object.matrixWorld);
    // An InstancedMesh's per-instance transforms live in a buffer, not in
    // `matrixWorld` — but three bumps `instanceMatrix.version` on every upload,
    // which is exactly the "did the silhouette move" signal, for two integers
    // instead of a walk over N matrices. Bailing on these outright (the first
    // version of this guard) was what kept the whole optimisation switched off
    // on the banner Sponza: ONE batching proxy anywhere in the scene made every
    // frame look dynamic, and the map re-rendered 25 meshes at 1024² forever.
    if (object.isInstancedMesh) {
      mix(object.count);
      mix(object.instanceMatrix?.version ?? -1);
    }
  });
  return dynamic ? null : h;
}

/**
 * Creates (or reuses) the god-rays map for `light` and returns a per-frame
 * update function, or null if the light does not need one.
 *
 * Idempotent: the target is cached on the light itself, so a graph rebuild
 * (which happens whenever any post parameter changes) re-attaches to the same
 * texture rather than allocating a second one.
 */
export function ensureGodraysShadowMap(engine, light, { size = 1024 } = {}) {
  if (!light?.shadow || !engine?.renderer) return null;
  // Only for lights three has declined to render a map for. A light on normal
  // map shadows already has one, and stealing it would be a regression.
  if (light.userData?.giShadowMode !== "gi") return null;

  let state = light.userData.__godraysShadow;
  if (!state || state.size !== size) {
    state?.target?.dispose?.();
    const target = new THREE.RenderTarget(size, size, {
      depthBuffer: true,
      stencilBuffer: false,
      // RGBA8, NOT RedFormat, though nothing ever samples this attachment:
      // the scene's transparent materials (vines, leaves) reach the pipeline
      // with SrcAlpha/OneMinusSrcAlpha blending even under the override
      // material, and WebGPU rejects alpha-reading blend factors against a
      // target whose format has no alpha — the invalid pipeline then poisons
      // the WHOLE command encoder and every submit that frame is dropped
      // ("Color blending srcFactor is reading alpha but it is missing from
      // fragment output", found 2026-08-16 on the banner Sponza). 4 MB at
      // 1024², which is what the header's budget already said.
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
    });
    const depth = new THREE.DepthTexture(size, size);
    depth.compareFunction = THREE.LessCompare; // required by the node's `.compare()`
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;
    target.depthTexture = depth;
    state = { target, size };
    light.userData.__godraysShadow = state;
  }

  // ⚠ THE ASSIGNMENT IS THE WHOLE TRICK, and it is safe precisely because
  // three has opted out: with a custom `shadowNode` nothing in three's shadow
  // path ever reads, re-renders or disposes `shadow.map`, so this field is
  // ours to own for as long as the light stays in gi mode.
  light.shadow.map = state.target;

  overrideMaterial ??= Object.assign(new THREE.MeshBasicNodeMaterial(), {
    // Marks this as a shadow render so three's override handling does not try
    // to preserve the real material's colourNode (see `isShadowPassMaterial`).
    isShadowPassMaterial: true,
  });

  return function renderGodraysShadow() {
    const renderer = engine.renderer;
    const scene = engine.scene;
    if (!renderer || !scene || light.userData?.giShadowMode !== "gi") return;
    // The shadow camera is maintained by LightComponent's directional sync
    // (it recentres on the active camera so the viewer is never outside the
    // frustum); we only have to publish the matrices the node samples with.
    light.shadow.updateMatrices(light);

    // ── FREEZE WHEN NOTHING THAT FEEDS THIS MAP HAS MOVED ────────────────────
    //
    // This pass re-rendered ALL 25 meshes at 1024² EVERY frame on the banner
    // Sponza — 262 k triangles and a quarter of the frame's draw calls — for a
    // map whose inputs (a static sun over static geometry) had not changed
    // since the boot. A depth map is a pure function of its camera and its
    // occluders, so it only needs redrawing when one of those changes.
    //
    // The fingerprint is deliberately over-inclusive: the shadow camera's
    // matrices (which DO move — LightComponent recentres them on the active
    // camera, so panning the viewport correctly invalidates this) plus every
    // drawn mesh's world transform, geometry identity and visibility. A miss
    // here is a STALE VOLUMETRIC SHADOW, not a crash, so the rule for anything
    // whose silhouette changes without its matrix changing — skinning, morph
    // targets — is simply to never freeze at all. That is one comparison per
    // mesh in a traverse this pass was already paying for.
    const key = fingerprintOccluders(scene, light);
    if (key !== null && key === state.lastKey) return;
    state.lastKey = key;

    const prevTarget = renderer.getRenderTarget();
    const prevOverride = scene.overrideMaterial;
    const prevBackground = scene.background;
    // ⚠ MRT MUST BE NULLED AND LIGHTS MUST BE HIDDEN — the same two guards
    // `selectionOutline.js` carries, for the same two failures, both of which
    // this pass hit live on the banner Sponza (2026-08-16):
    //
    // (1) A VISIBLE LIGHT MAKES `renderer.render` RUN THE SHADOW-MAP PASS, and
    //     that pass applies `scene.overrideMaterial` — compiling this
    //     MeshBasicNodeMaterial into a depth-only context whose fragment output
    //     struct is EMPTY. "structures must have at least one member" ->
    //     invalid ShaderModule -> invalid RenderPipeline -> the WHOLE command
    //     encoder is poisoned and every submit that frame is DROPPED. A dropped
    //     submit is a dropped frame, which is why this reads as a frame-rate
    //     problem rather than as an error.
    // (2) The postprocess pass's MRT is still pinned on the renderer here, and
    //     a leaked MRT builds empty-output fragments the same way — that is the
    //     "fragment_Background.material" half of the same console burst.
    //
    // Hiding the lights costs this pass nothing: it renders depth from the
    // light's camera through an override material that shades with neither.
    const prevMrt = renderer.getMRT();
    const hidden = [];
    try {
      scene.traverse((obj) => {
        if (obj.isLight && obj.visible) hidden.push(obj);
      });
      for (const l of hidden) l.visible = false;
      scene.overrideMaterial = overrideMaterial;
      // A background would draw at far depth and occlude nothing, but it costs
      // a full-screen draw in a pass whose entire point is to be cheap.
      scene.background = null;
      renderer.setMRT(null);
      renderer.setRenderTarget(state.target);
      renderer.clear();
      renderer.render(scene, light.shadow.camera);
    } finally {
      for (const l of hidden) l.visible = true;
      scene.overrideMaterial = prevOverride;
      scene.background = prevBackground;
      renderer.setMRT(prevMrt);
      renderer.setRenderTarget(prevTarget);
    }
  };
}

/** Releases the map when god rays stop needing it (or the light leaves gi mode). */
export function disposeGodraysShadowMap(light) {
  const state = light?.userData?.__godraysShadow;
  if (!state) return;
  // Null it before disposing: a frame that renders between the two would
  // otherwise hand three's node a destroyed texture.
  if (light.shadow?.map === state.target) light.shadow.map = null;
  state.target.dispose?.();
  delete light.userData.__godraysShadow;
}
