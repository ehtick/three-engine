// Deferred (screen-space) GI resolve.
//
// WHY THIS EXISTS — the architecture this replaces:
// GI used to be evaluated INSIDE every lit material's shader. The cascade
// gather and the emitter shadow traces are large pieces of code, so every
// material's fragment shader came out at 180-250kB of WGSL, and the driver
// needs 3-18 SECONDS to compile one of those. A scene's startup cost was
// therefore (materials × a multi-second driver compile), and any GI rebuild
// — a refit, a quality change, a moved bounds source — invalidated all of
// them at once. That is the whole "slow startup / freeze on change" class.
//
// Here the expensive work runs ONCE PER PIXEL instead of once per material:
//   1. a half-resolution gbuffer prepass writes world position + normal
//      (ONE override material → ONE pipeline, regardless of scene size),
//   2. a compute pass evaluates the gather + emitter direct/shadow at those
//      positions and stores the result in screen-space textures,
//   3. materials just SAMPLE those textures (see giLight) — a few lines of
//      WGSL, so material shaders stay small and, crucially, their code is
//      IDENTICAL across GI rebuilds, so rebuilds stop recompiling them.
//
// Trade-offs, deliberately accepted:
//   • Transparent surfaces are not in the gbuffer — they sample the GI of
//     whatever opaque surface is behind them.
//   • The gbuffer uses geometric/vertex normals (an override material can't
//     read each material's normal map). Diffuse GI at probe-lattice scale
//     does not resolve normal-map detail anyway.
//   • Mirror reflections stay per-material (they are view-dependent and only
//     compile for low-roughness materials).
import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  Loop,
  abs,
  acos,
  atomicAdd,
  atomicLoad,
  atomicStore,
  cos,
  cross,
  float,
  fract,
  instanceIndex,
  instancedArray,
  int,
  ivec2,
  mix,
  mrt,
  screenCoordinate,
  normalWorld,
  positionWorld,
  reflect,
  select,
  sin,
  smoothstep,
  step,
  tan,
  texture,
  textureStore,
  uint,
  uintBitsToFloat,
  uniform,
  vec2,
  vec3,
  vec4,
  Return,
} from "three/tsl";
import { MAX_EMITTERS, analyticDirectAt, decodeOctNormal, emitterDirectAt, emitterSlotShadow, spotReachAt, sunShadowVisibilityAt } from "./giLight.js";
import { octDecodeTSL } from "./rayHit/rayHitTSL.js";
import { DEBUG_LAYER, EDITOR_LAYER, GI_DEPTH_LAYER, GI_SHARP_LAYER, UI_LAYER } from "../../engine/editorLayers.js";
import { readRenderTargetImage } from "../../engine/renderTargetImage.js";
import { isFlatTexture } from "./materialNodeBindings.js";
import { ALBEDO_ATLAS_GRID, ALBEDO_ATLAS_SIZE, ALBEDO_ATLAS_TILE } from "./bvh/bvhScene.js";
import { sampleReflectionProbes } from "./reflectionProbes.js";

/**
 * Gbuffer for the GI resolve: world position (+ valid mask) and world normal,
 * rendered with a single override material so the prepass costs exactly ONE
 * pipeline no matter how many materials the scene has.
 */
export function createGiGBuffer(width, height) {
  const rt = new THREE.RenderTarget(width, height, {
    count: 2,
    depthBuffer: true,
    stencilBuffer: false,
    generateMipmaps: false,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });
  // Position needs real range + precision (world coordinates, not 0..1) —
  // half floats lose centimetres tens of metres from the origin, which shows
  // up as probe-sample jitter. The normal target stays half float.
  rt.textures[0].type = THREE.FloatType;
  rt.textures[0].name = "output";
  rt.textures[1].type = THREE.HalfFloatType;
  rt.textures[1].name = "giNormal";

  // Any node material works as the override — the MRT slots below replace its
  // fragment output entirely.
  const material = new THREE.MeshBasicNodeMaterial();
  material.name = "GI gbuffer";
  // MeshBasicNodeMaterial ships with `lights = true` (it shades through a
  // BasicLightingModel whose outgoing light is just the diffuse colour), so the
  // prepass was building the FULL scene lights node — including this module's
  // own GI light, which samples giIrradiance/giEmitterShadow. That result is
  // then thrown away by the MRT below, but the bindings are real: the prepass
  // held the resolve targets, and because the override material is not marked
  // node-driven its bind groups refresh lazily — so after a viewport resize
  // swapped the targets it kept the OLD pair and every prepass submit failed
  // with "Destroyed texture used in a submit", taking GI down with it.
  // Unlit here is also simply correct: this pass writes position + normal.
  material.lights = false;
  // `output` is attachment 0, `giNormal` attachment 1 (MRT maps by key order).
  // w = 1 marks "geometry here"; untouched pixels stay 0 and the resolve
  // skips them.
  const mrtNode = mrt({
    output: vec4(positionWorld, 1),
    giNormal: vec4(normalWorld, 0),
  });

  // THE MIRROR MASK (sparse exact reflections). The normal target's w channel
  // was unused (always 0); it now carries "a reflective material shades this
  // pixel", which is what lets createGiBvhReflect skip the BVH trace on the
  // ~95% of the screen that will never consume a reflection.
  //
  // It has to be a SECOND render rather than a channel of the first, because
  // `scene.overrideMaterial` gives every mesh the same node graph — the
  // prepass cannot see any individual material's roughness. So the mirror
  // meshes (tagged with GI_MIRROR_LAYER by GISystem's collect walk) are simply
  // drawn again, by layer, with a graph identical to the one above except for
  // the w. Rewriting position/normal with the same values at the same depth is
  // deliberate: it keeps this pass a pure superset-free overwrite, so a
  // half-covered pixel can never end up with one attachment from each pass.
  const maskMaterial = new THREE.MeshBasicNodeMaterial();
  maskMaterial.name = "GI gbuffer mirror mask";
  maskMaterial.lights = false;
  const maskMrtNode = mrt({
    output: vec4(positionWorld, 1),
    giNormal: vec4(normalWorld, 1),
  });

  return {
    rt,
    material,
    mrtNode,
    maskMaterial,
    maskMrtNode,
    get position() {
      return rt.textures[0];
    },
    get normal() {
      return rt.textures[1];
    },
    setSize(w, h) {
      if (rt.width === w && rt.height === h) return false;
      rt.setSize(w, h);
      // §11.33: three's RenderTarget.setSize DISPOSES the GPU textures but
      // leaves `texture.version` alone, and a bind group decides "still the
      // same texture" by version (Bindings._update: `binding.generation` vs
      // `textureData.generation`, which IS the version at creation). Without
      // a bump every bind group that held the old view keeps it, and the next
      // submit dies with "Destroyed texture [output] used in a submit". Same
      // rule as createGiTargets' `targetGeneration` — one counter, so a
      // resized texture can never collide with a fresh one.
      for (const t of rt.textures) t.version = ++targetGeneration;
      return true;
    },
    dispose() {
      rt.dispose();
      material.dispose();
      maskMaterial.dispose();
    },
  };
}

/**
 * Renders the gbuffer for this frame. Runs as a nested render inside the
 * engine's pre-render phase, so it must leave the renderer exactly as it
 * found it — a leaked render target or MRT would redirect the main scene
 * render into our half-res buffer.
 */
/**
 * Water refraction (2026-09-06): renders ONE layer of the scene — the water
 * lid — through the water's own MRT material into a gbuffer whose "normal"
 * attachment carries the refracted ray direction. Nested inside the engine's
 * pre-render phase like `renderGiGBuffer`, and leaves the renderer as found.
 */
export function renderWaterGBuffer(renderer, scene, camera, { rt, mrtNode, material, layer }) {
  const previousTarget = renderer.getRenderTarget();
  const previousMRT = renderer.getMRT();
  const previousOverride = scene.overrideMaterial;
  const previousMask = camera.layers.mask;
  const previousTransparent = renderer.transparent;
  const previousAutoClear = renderer.autoClear;
  const previousBackground = scene.background;
  const previousBackgroundNode = scene.backgroundNode;
  const previousClearColor = renderer.getClearColor(new THREE.Color()).clone();
  const previousClearAlpha = renderer.getClearAlpha();
  const previousShadows = renderer.shadowMap.enabled;
  const previousFog = scene.fogNode;
  try {
    renderer.shadowMap.enabled = false;
    renderer.transparent = true;
    scene.background = null;
    scene.backgroundNode = null;
    scene.fogNode = null;
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = true;
    scene.overrideMaterial = material;
    camera.layers.set(layer);
    renderer.setRenderTarget(rt);
    renderer.setMRT(mrtNode);
    renderer.render(scene, camera);
  } finally {
    renderer.setMRT(previousMRT);
    renderer.setRenderTarget(previousTarget);
    scene.overrideMaterial = previousOverride;
    camera.layers.mask = previousMask;
    renderer.transparent = previousTransparent;
    renderer.autoClear = previousAutoClear;
    scene.background = previousBackground;
    scene.backgroundNode = previousBackgroundNode;
    scene.fogNode = previousFog;
    renderer.setClearColor(previousClearColor, previousClearAlpha);
    renderer.shadowMap.enabled = previousShadows;
  }
}

export function renderGiGBuffer(renderer, scene, camera, gbuffer, { mirrorMask = false, depthProxies = null } = {}) {
  const previousTarget = renderer.getRenderTarget();
  const previousMRT = renderer.getMRT();
  const previousOverride = scene.overrideMaterial;
  const previousMask = camera.layers.mask;
  const previousTransparent = renderer.transparent;
  const previousAutoClear = renderer.autoClear;
  // Saved unconditionally, restored unconditionally — the mask branch below
  // stomps all five, and a leaked `autoClearColor = false` would stop the MAIN
  // scene pass clearing for the rest of the session.
  const previousAutoClearColor = renderer.autoClearColor;
  const previousAutoClearDepth = renderer.autoClearDepth;
  const previousAutoClearStencil = renderer.autoClearStencil;
  const previousBackground = scene.background;
  const previousBackgroundNode = scene.backgroundNode;
  // The position target uses alpha as its VALID bit, so the prepass clear is
  // data rather than presentation state: it must be transparent black no
  // matter which clear colour the main viewport owns. In particular, an
  // opaque scene background clears alpha to one, making every sky pixel look
  // like a surface at RGB-as-world-position (normally very near world origin).
  // The resolve/AO then shades that invented wall. A texture/node background
  // is worse: three inserts `Background.mesh` into the render list; its
  // material has `allowOverride = false`, so it survives `overrideMaterial`
  // and writes its colour + alpha directly into attachment zero.
  const previousClearColor = renderer.getClearColor(new THREE.Color()).clone();
  const previousClearAlpha = renderer.getClearAlpha();
  // ⚠ SHADOWS OFF OR THE OVERRIDE POISONS THE SHADOW PASS: a shadow update
  // landing inside a nested override render compiles the override material
  // into the depth-only shadow context — an empty-fragment-struct INVALID
  // pipeline that, once cached, poisons whole command buffers (found via the
  // occluder pass and the selection outline, 2026-08-13; same guard there).
  // Shadows still update in the main render.
  // §12.66 BISECT HATCH: `__giGbufShadowGuard = false` skips the disable —
  // this guard shipped in the 14:02 save at the exact lit→black boot
  // boundary, and three's shadow-node setup observes `shadowMap.enabled`.
  const guardOn = globalThis.__giGbufShadowGuard !== false;
  const previousShadows = renderer.shadowMap.enabled;
  if (guardOn) renderer.shadowMap.enabled = false;
  // OPAQUE ONLY. `scene.overrideMaterial` replaces the material of everything
  // that renders, so a transparent object — a glass pane, or a VolumeNodeMaterial
  // fog box — would be drawn as a solid surface into the gbuffer and every
  // pixel behind it would resolve GI for the FOG BOX instead of the geometry
  // there. User-reported as "put the scene inside a volume and it goes black".
  renderer.transparent = false;
  // Editor gizmos/grid would write geometry into the gbuffer and shadow the
  // scene with objects that are not really there.
  camera.layers.disable(EDITOR_LAYER);
  // Same for UI and runtime debug draw. Neither is world geometry, and a
  // screen-space HUD is laid out in UI pixels at the world origin — as gbuffer
  // geometry that is a wall metres across sitting on the camera, so every pixel
  // behind it would resolve GI for the HUD instead of the scene.
  camera.layers.disable(UI_LAYER);
  camera.layers.disable(DEBUG_LAYER);
  // ── THE DEPTH-PROXY SWAP (§18 G1) ──────────────────────────────────────────
  //
  // This pass is one override material over every eligible mesh, so — exactly
  // like a shadow map — its cost is DRAW COUNT and nothing else. On Bistro it
  // was 317 draws / 10.96 ms of CPU encoding a frame with a `floorIfMerged` of
  // 9, the single biggest item in the tick. `shadowMerge.js` has already merged
  // this same geometry on this same "what does a depth pass actually read" key;
  // all this does is draw ITS proxies instead of their members.
  //
  // ⚠ THE SHARP CHECK IS PER FRAME, AND THAT IS NOT LAZINESS. `GI_SHARP_LAYER`
  // is written when a material's roughness FLOOR resolves, which is an async GPU
  // readback that lands long after the merge was built — a build-time answer is
  // the blind-census bug this module has already shipped once ("0 sharp on a
  // scene of mirrors"). A mask read per member is a few microseconds against the
  // ~35 µs a single draw costs here.
  //
  // Why sharp groups are skipped WHOLESALE rather than partially hidden: pass 2
  // redraws those meshes against pass 1's retained depth with the default
  // LessEqualDepth. A proxy's vertices are baked on the CPU in float64 and
  // stored as float32, while the original's are transformed on the GPU — the two
  // agree to within an ULP, and an ULP the wrong way makes the mask fragment
  // fail the depth test and silently drop that surface's reflection. Letting the
  // originals write their own depth in pass 1 makes the comparison exact.
  const proxyHidden = [];
  const proxyParked = [];
  /** Render bundles held out of the mirror-mask pass; see its note. */
  const bundlesHidden = [];
  // A receipt, because "the merge is healthy" and "the prepass is USING it" are
  // different facts: every rule below refuses groups silently, and a swap that
  // parks everything looks exactly like a swap that is working.
  const proxyStats = { groups: 0, used: 0, unsafe: 0, parkedSharp: 0, parkedHidden: 0, hidden: 0 };
  if (depthProxies) {
    const sharpBit = 1 << GI_SHARP_LAYER;
    let anyDrawn = false;
    for (const group of depthProxies) {
      if (!group?.mesh) continue;
      proxyStats.groups++;
      if (!group.gbufferSafe) { proxyStats.unsafe++; continue; }
      // ⚠⚠ ALL-OR-NOTHING PER GROUP, and this is the correctness rule of the
      // whole swap. A proxy stands in for its members EXACTLY — draw it while
      // any member is independently hidden (merging absorbed it, an LOD or the
      // occlusion system dropped it) and that member's triangles are back in
      // GI's g-buffer as geometry nothing on screen has; hide members without
      // drawing the proxy and the street disappears from GI instead. Both
      // failures are silent, so the group is used only when the substitution is
      // exact, and parked otherwise.
      let sharp = false;
      let invisible = false;
      for (const member of group.members) {
        if (((member.layers.mask >>> 0) & sharpBit) !== 0) { sharp = true; break; }
        if (member.visible === false) { invisible = true; break; }
      }
      if (sharp || invisible) {
        if (sharp) proxyStats.parkedSharp++;
        else proxyStats.parkedHidden++;
        if (group.mesh.visible !== false) {
          group.mesh.visible = false;
          proxyParked.push(group.mesh);
        }
        continue;
      }
      for (const member of group.members) {
        member.visible = false;
        proxyHidden.push(member);
      }
      proxyStats.used++;
      anyDrawn = true;
    }
    proxyStats.hidden = proxyHidden.length;
    // The proxies live on SHADOW_PROXY_LAYER, which no ordinary camera sees.
    // GI_DEPTH_LAYER is the bit that says "and this one is safe here".
    if (anyDrawn) camera.layers.enable(GI_DEPTH_LAYER);
  }
  // A background is presentation, never gbuffer geometry. Remove it for BOTH
  // passes (not just the mirror-mask redraw), and establish an invalid-sky
  // clear explicitly instead of inheriting the viewport's opaque clear.
  scene.background = null;
  scene.backgroundNode = null;
  renderer.setClearColor(0x000000, 0);
  scene.overrideMaterial = gbuffer.material;
  renderer.setRenderTarget(gbuffer.rt);
  renderer.setMRT(gbuffer.mrtNode);
  try {
    renderer.render(scene, camera);
    // Pass 2 — the mirror mask (see createGiGBuffer's maskMrtNode). Only the
    // GI_MIRROR_LAYER meshes, drawn over the same attachments and the same
    // depth buffer, so this costs one projection walk plus the reflective
    // meshes' own rasterisation (a handful of draws in any real scene).
    //
    // autoClear MUST be off: the point is to keep pass 1's colour AND depth.
    // Depth is why the layer set alone is not enough — a mirror that is
    // OCCLUDED must not mark the pixels it hides behind, and the default
    // LessEqualDepth against the retained depth handles both that and the
    // coplanar re-draw of a visible mirror in one test.
    if (mirrorMask) {
      // ⚠ GI_SHARP_LAYER, NOT GI_MIRROR_LAYER (2026-08-25). The mirror layer
      // is every material that READS a reflection — 104 of 111 on Bistro — so
      // masking against it excluded ~nothing and the mask was never a cost
      // lever, only a risk. GI_SHARP_LAYER is the ladder's SHARP+MEDIUM rungs:
      // the surfaces whose traced reflection actually survives
      // `smoothstep(0.45, 0.15, roughness)`. 104 meshes of 1631 here, and the
      // 89% it excludes is provably multiplied by zero. See editorLayers.js.
      // ⚠⚠ A RENDER BUNDLE IGNORES THE LAYER MASK, SO THE LAYER SWITCH BELOW
      // DOES NOT EXCLUDE ONE. `Renderer._projectObject` handles `isBundleGroup`
      // OUTSIDE its `layers.test(camera.layers)` branch, and a bundle is keyed
      // on (group, camera, renderContext) — pass 2 shares all three with pass 1,
      // so a bundle recorded a moment ago would be REPLAYED here and every proxy
      // inside it would be stamped into the mirror mask's `giNormal.w = 1`.
      // That is the four-times-reverted masked-mode failure, arriving by a new
      // road: the whole merged scene would read as reflective.
      //
      // `visible` is the one gate checked BEFORE the bundle branch, so it is the
      // only thing that can hold a bundle out of a pass. Restored in `finally`.
      for (const child of scene.children) {
        if (child.isBundleGroup === true && child.visible !== false) {
          child.visible = false;
          bundlesHidden.push(child);
        }
      }
      camera.layers.set(GI_SHARP_LAYER);
      scene.overrideMaterial = gbuffer.maskMaterial;
      renderer.setMRT(gbuffer.maskMrtNode);
      renderer.autoClear = false;
      // ⭐⭐ THE FOUR-REVERT MASK BUG, ROOT-CAUSED (2026-08-25). `autoClear =
      // false` above was NOT ENOUGH, and this is why — three/Background.js:
      //
      //     let forceClear = false;
      //     ...
      //     } else if ( background.isColor === true ) { forceClear = true; }
      //     ...
      //     if ( renderer.autoClear === true || forceClear === true ) {
      //         renderContext.clearColor = renderer.autoClearColor === true;
      //         renderContext.clearDepth = renderer.autoClearDepth === true;
      //
      // It is an OR. Any opaque Color `scene.background` sets `forceClear`, the
      // branch is taken DESPITE autoClear being false, and the pass opens with
      // a clear loadOp on every MRT attachment AND on depth. Pass 1's gbuffer
      // is wiped, only GI_MIRROR_LAYER meshes survive as geometry, the screen
      // gather finds `position.w == 0` on every wall — and that is exactly the
      // reproduced Cornell-box symptom that reverted masked mode four times:
      // "every diffuse wall PITCH BLACK while the emissive box and the mirror
      // stay lit". Sponza hid it because its mask covered most materials, so
      // most pixels were redrawn by pass 2 anyway.
      //
      // Two independent locks, because one of them alone leaves a hole:
      // · the autoClear* flags are read INSIDE the taken branch, so falsing
      //   them makes the clear impossible whatever `forceClear` decides —
      //   this is the complete fix for the wipe;
      // · nulling the background also keeps `Background.update` from adding a
      //   background MESH to this pass's render list, which under
      //   `scene.overrideMaterial` would rasterise a skybox INTO the gbuffer
      //   as world geometry sitting on the camera.
      renderer.autoClearColor = false;
      renderer.autoClearDepth = false;
      renderer.autoClearStencil = false;
      renderer.render(scene, camera);
    }
  } finally {
    // ⚠ RESTORED HERE, NOT AFTER THE RENDER, and unconditionally: these meshes
    // are the scene's real geometry and every other pass — the colour pass above
    // all — must see them. Leaking a `visible = false` out of this function
    // deletes half the street from the image, so it belongs with the other four
    // save/restore pairs rather than on the success path.
    for (const mesh of proxyHidden) mesh.visible = true;
    for (const proxy of proxyParked) proxy.visible = true;
    for (const bundle of bundlesHidden) bundle.visible = true;
    renderer.autoClear = previousAutoClear;
    renderer.autoClearColor = previousAutoClearColor;
    renderer.autoClearDepth = previousAutoClearDepth;
    renderer.autoClearStencil = previousAutoClearStencil;
    scene.background = previousBackground;
    scene.backgroundNode = previousBackgroundNode;
    renderer.setClearColor(previousClearColor, previousClearAlpha);
    renderer.setMRT(previousMRT);
    renderer.setRenderTarget(previousTarget);
    renderer.transparent = previousTransparent;
    scene.overrideMaterial = previousOverride;
    camera.layers.mask = previousMask;
    if (guardOn) renderer.shadowMap.enabled = previousShadows;
  }
  return proxyStats;
}

/**
 * ══ §11.35 THE G-BUFFER DOWNSAMPLE — one prepass at AO resolution, the chain
 * at resolve resolution ═══════════════════════════════════════════════════
 *
 * The AO term is the highest-frequency thing GI draws, and it was computed at
 * the RESOLVE's resolution (half the viewport per axis at ultra on the user's
 * editor) from a g-buffer rendered at that size, then filtered ±3 texels and
 * upsampled 2×: "blurry" (the user, 2026-09-04; the native texel dump in
 * `probe:gi-gtao CAPTURE=1` shows it without the viewport's own resampling).
 * A sharp AO needs positions at the viewport's resolution. Rendering the
 * g-buffer twice would double the prepass's CPU (the scene walk — ~6 ms on
 * Bistro, §11.33), and re-pointing this file's 25 g-buffer readers at a finer
 * texture is a chain-wide refactor. So: the prepass renders ONCE, at AO
 * resolution (`gbufferFull`), and this quad pass POINT-SAMPLES it down into
 * the resolve-sized g-buffer every other consumer already reads (`gbuffer`:
 * same object, same size, same texel grid as the irradiance) — the chain
 * cannot tell the difference, and only the AO pass reads the full one. A
 * render through three's QuadMesh idiom, not a compute, so the half-res
 * g-buffer stays the RenderTarget the rest of the module is built on.
 */
export function createGiGBufferDownsample({ source, target }) {
  const positionNode = texture(source.position);
  const normalNode = texture(source.normal);
  const material = new THREE.MeshBasicNodeMaterial();
  material.name = "GI gbuffer downsample";
  // Unlit, like the prepass override (createGiGBuffer): `lights = true` would
  // compile the scene's lights node — this module's own GI light included —
  // into a pass whose colour is replaced by the MRT below.
  material.lights = false;
  material.depthTest = false;
  material.depthWrite = false;
  // x, y: source texels per target texel; z, w: the source's last texel.
  const mapU = uniform(new THREE.Vector4(1, 1, 0, 0));
  // `screenCoordinate` is the fragment's position in the TARGET (origin
  // top-left, the texture's own row order), so a straight scale lands on the
  // source texel that covers this target texel's centre — point sampled, as
  // a half-res rasterisation would have been.
  const srcCoord = ivec2(
    screenCoordinate.x.mul(mapU.x).toInt().clamp(int(0), mapU.z.toInt()),
    screenCoordinate.y.mul(mapU.y).toInt().clamp(int(0), mapU.w.toInt()),
  );
  const mrtNode = mrt({
    output: positionNode.load(srcCoord),
    giNormal: normalNode.load(srcCoord),
  });
  const quad = new THREE.QuadMesh(material);
  const downsample = {
    source,
    target,
    material,
    setSize() {
      const sw = source.rt.width, sh = source.rt.height;
      const tw = target.rt.width, th = target.rt.height;
      mapU.value.set(sw / tw, sh / th, Math.max(0, sw - 1), Math.max(0, sh - 1));
    },
    render(renderer) {
      const previousTarget = renderer.getRenderTarget();
      const previousMRT = renderer.getMRT();
      const previousAutoClear = renderer.autoClear;
      renderer.setRenderTarget(target.rt);
      renderer.setMRT(mrtNode);
      // Every target texel is written; a clear would only cost bandwidth.
      renderer.autoClear = false;
      try {
        quad.render(renderer);
      } finally {
        renderer.setMRT(previousMRT);
        renderer.setRenderTarget(previousTarget);
        renderer.autoClear = previousAutoClear;
      }
    },
    dispose() {
      material.dispose();
    },
  };
  downsample.setSize();
  return downsample;
}

/**
 * §13 F3 — the far-field average: "what indirect light looks like around
 * here", reduced to ONE value the resolve can afford to read per pixel.
 *
 * Two tiny dispatches appended to the SRC pass list right after the screen
 * gather (whose output texture is the source — the gather stores `vec4(E, 1)`
 * per valid gbuffer texel):
 *
 *   accum — one thread per gather texel; LIT texels (w = 1, luminance above
 *           a hair) fixed-point-atomic their RGB into a 4-word buffer.
 *           Lit-only is load-bearing: the crushed out-of-volume pixels this
 *           term exists to fix must not drag their own fallback toward black.
 *   ema   — one thread; averages, EMAs at α = 0.05 (~1.3 s at 60 fps — slow
 *           enough to hide view churn, fast enough to track a lamp toggle),
 *           stores to a 1×1 texture, and resets the accumulators for the
 *           next frame. Fewer than 64 lit texels keeps last frame's answer:
 *           a boot frame or a camera buried in a wall must not zero the far
 *           field. The dispatch split is the synchronization — no workgroup
 *           barriers, same idiom as the occupancy surface reducer.
 *
 * The 1×1 OUT TEXTURE is caller-owned and persistent (GISystem keeps it
 * across rebuilds/resizes exactly like the irradiance targets): a TEXTURE
 * because the resolve sits at the portable eight-storage-buffer limit and
 * texture bindings are free of it. Fixed point is ×256 with a per-texel
 * clamp at 32 — headroom for an average E of ~10 over 1.6 M texels before
 * a u32 could wrap.
 */
/**
 * The far-field texture the pass above writes and three consumers read: the
 * resolve (texel 0: the shaped constant), profile.giPasses (texel 1: the
 * gauges) and, since §11.16, the fresh-probe seed (texel 2: the raw mean).
 * Owned by GISystem and persistent across rebuilds/resizes; created up front
 * so the seed can bind it before the passes that fill it exist.
 */
export function createGiFarFieldTexture() {
  const t = new THREE.StorageTexture(4, 1);
  t.type = THREE.HalfFloatType;
  t.name = "giFarFieldAvg";
  return t;
}

export function createGiFarFieldAvgPass({ source, width, height, out }) {
  const srcNode = texture(source);
  const FX = 256;
  // [0..2] sum rgb (fixed point), [3] lit count, [4] DARK count (geometry the
  // gather covered but read <= 0.001 luminance), [5] covered count. The dark
  // share is the "black patches" gauge: it rides in the far-field texture's
  // alpha and `profile.giPasses` reports it as `srcProbes.farField.darkFrac`.
  // [6] FILL count: covered geometry whose resolve validity (alpha) is below
  // 0.5, i.e. pixels the gather could not answer and the far-field constant
  // (or a neighbour) filled — the honest gauge for "patches with no data".
  const accum = instancedArray(new Uint32Array(7), "uint").toAtomic();
  const ema = instancedArray(new Float32Array(4), "float");
  const widthU = uint(width);
  const computeAccum = Fn(() => {
    const i = instanceIndex;
    const coord = ivec2(i.mod(widthU).toInt(), i.div(widthU).toInt());
    const t = srcNode.load(coord).toVar();
    const lum = t.x.mul(0.2126).add(t.y.mul(0.7152)).add(t.z.mul(0.0722));
    If(t.w.lessThan(0.5).and(t.w.greaterThan(0.001)), () => {
      atomicAdd(accum.element(uint(6)), uint(1));
    });
    If(t.w.greaterThan(0.5), () => {
      atomicAdd(accum.element(uint(5)), uint(1));
      If(lum.greaterThan(0.001), () => {
        atomicAdd(accum.element(uint(0)), t.x.min(32).mul(FX).toUint());
        atomicAdd(accum.element(uint(1)), t.y.min(32).mul(FX).toUint());
        atomicAdd(accum.element(uint(2)), t.z.min(32).mul(FX).toUint());
        atomicAdd(accum.element(uint(3)), uint(1));
      }).Else(() => {
        atomicAdd(accum.element(uint(4)), uint(1));
      });
    });
  })().compute(width * height);
  const computeEma = Fn(() => {
    const count = atomicLoad(accum.element(uint(3))).toVar();
    If(count.greaterThan(uint(64)), () => {
      const inv = float(1).div(count.toFloat().mul(FX));
      const avg = vec3(
        atomicLoad(accum.element(uint(0))).toFloat().mul(inv),
        atomicLoad(accum.element(uint(1))).toFloat().mul(inv),
        atomicLoad(accum.element(uint(2))).toFloat().mul(inv),
      ).toVar();
      const primed = ema.element(uint(3)).toVar();
      const alpha = select(primed.greaterThan(0.5), float(0.05), float(1));
      const next = mix(
        vec3(ema.element(uint(0)), ema.element(uint(1)), ema.element(uint(2))),
        avg,
        alpha,
      ).toVar();
      ema.element(uint(0)).assign(next.x);
      ema.element(uint(1)).assign(next.y);
      ema.element(uint(2)).assign(next.z);
      ema.element(uint(3)).assign(1);
      // PUBLISH SHAPED, ACCUMULATE RAW. The raw average of a bulb-lit street
      // is saturated lavender, and at street level the far field is MOST of
      // the frame — the first live look read as purple fog (2026-08-16).
      // Materials multiply this irradiance by their own albedo, so far
      // surfaces keep their color variation; what must go is the TINT and
      // the full-strength energy: keep 35% of the chroma, damp to 60%.
      const pubLum = next.x.mul(0.2126).add(next.y.mul(0.7152)).add(next.z.mul(0.0722));
      const shaped = mix(vec3(pubLum), next, 0.35).mul(0.6);
      const covered = atomicLoad(accum.element(uint(5))).toFloat().max(1);
      const darkFrac = atomicLoad(accum.element(uint(4))).toFloat().div(covered);
      const filled = atomicLoad(accum.element(uint(6))).toFloat();
      const fillFrac = filled.div(covered.add(filled));
      textureStore(out, ivec2(0, 0), vec4(shaped, 1));
      // The readback blit forces alpha to 1, so the gauge lives in a second
      // texel's colour channels (the texture is 2x1; the resolve reads (0,0)).
      textureStore(out, ivec2(1, 0), vec4(darkFrac, covered.div(1e6), fillFrac, 1));
      // §11.16: the RAW mean irradiance (unshaped — the fresh-probe seed wants
      // the scene's irradiance, not the display-tinted constant), alpha 1 =
      // primed. The texture is 4×1 for this texel; (3,0) is spare.
      textureStore(out, ivec2(2, 0), vec4(next, 1));
    });
    atomicStore(accum.element(uint(0)), uint(0));
    atomicStore(accum.element(uint(1)), uint(0));
    atomicStore(accum.element(uint(2)), uint(0));
    atomicStore(accum.element(uint(3)), uint(0));
    atomicStore(accum.element(uint(4)), uint(0));
    atomicStore(accum.element(uint(5)), uint(0));
    atomicStore(accum.element(uint(6)), uint(0));
  })().compute(1);
  return { computeAccum, computeEma };
}

/**
 * The resolve pass: one compute over screen pixels that turns the gbuffer
 * into the two textures materials read.
 *
 * `irradiance` — diffuse indirect (cascade gather) plus every emitter's
 * shadowed direct contribution. This is the whole diffuse GI answer, so a
 * rough material's entire GI cost becomes one texture fetch.
 *
 * `emitterShadow` — the per-emitter shadow factor (one channel per slot,
 * MAX_EMITTERS = 4) that the in-material specular glow needs. Without it,
 * glossy materials would have to re-trace shadows per pixel, which is
 * exactly the per-material cost this pass exists to remove.
 *
 * EXACT-REFLECTION HIT SHADING IS NOT HERE ANY MORE (§14 unit R-A,
 * 2026-08-22) — see `createGiBvhHitShade` below. It lived in this kernel from
 * 2026-08-02 ("binding the gather + emitter + light slots in the BVH pass asks
 * for 16 uniform buffers against a baseline of 12"), and that placement is
 * what made traced shadows at hits unshippable: the cone marcher inflated
 * THIS kernel's register footprint and the whole resolve's occupancy
 * collapsed — 5.95 → 66 ms on the user's Level, and a masked arm with ~10×
 * fewer hit pixels read the SAME 66 ms, which is the signature of a
 * whole-kernel cost, not a per-pixel one. So hits shipped UNSHADOWED at dense
 * (§12.56), and a reflected room rendered as flat, uniformly-lit albedo. The
 * uniform-buffer objection died when sceneSettings started asking the adapter
 * for 24, so the block now lives in its own pass at its own occupancy.
 *
 * `lightShadow` (optional) — GI-TRACED DIRECT SHADOWS. One occupancy shadow
 * cone per flagged analytic light slot, written to a 4-channel screen texture
 * that three's own lighting then samples through a custom `shadow.shadowNode`
 * (see GISystem's `#syncLightShadowNodes`). This is where a light's shadow gets
 * to be a real world-space trace against the same medium GI transports through,
 * instead of a shadow map — no map render, no cascade splits, no peter-panning,
 * and penumbra width that follows the light's authored angular size.
 *
 * It lives in THIS pass rather than in the materials for the same reason
 * everything else here does: one march per screen pixel per light instead of
 * one per fragment per material, and material shaders that stay a texture
 * fetch. Bundle: `{ target, slots, trace, lift, span }` — GISystem owns all of
 * them because they need the volume (trace/lift/span) and the light slots.
 *
 * `cameraPosition` IS ITS OWN INPUT, not a field of `radiance`, and that
 * separation is load-bearing rather than tidiness. Four things here need the
 * camera — the back-face `facing` flip, the gather's view bias, the reflection
 * incident ray, and (at the call site) the emitter shadow pass — while only ONE
 * of them is about reflections. It used to live inside the `radiance` bundle, so
 * a build with no cascade radiance lookup silently lost the back-face flip in
 * three surviving passes: `facing` degenerates to +1, a double-sided wall seen
 * from inside a room gathers the wrong hemisphere, and the emitter pass takes
 * its own documented `cameraPosition = null` fallback. Found while making this
 * chain survive the transport's deletion (GI_SRC_REBUILD_PLAN §12.8), where
 * `radiance` becomes null for real.
 *
 * `gather` MAY BE NULL — a build with no diffuse indirect at all (the SRC
 * rebuild's intermediate state: probes not yet populated). The diffuse term and
 * the AO that modulates it are then compiled out, not multiplied by zero, and
 * an exact-reflection hit is lit by its direct terms alone. Every other term
 * here — emitter direct, analytic direct, reflections, sun shadows — is
 * independent of it and keeps working.
 *
 * `farField` (§13 F3, optional — only passed when the detail volume is armed):
 * `{ node, worldMin, worldSize, feather }`. Surfaces outside the camera-
 * following detail box have no probes, no occupancy and no surface records —
 * without this term their indirect is an ACCIDENTAL zero (F0 measured them
 * crushed black). The term replaces the diffuse indirect with a hemispherical
 * constant — the far-field average texture × a sky-down cosine — feathered in
 * across the last `feather` metres inside the boundary. Direct sun, analytic
 * lights and their traced shadows are volume-independent and untouched; the
 * mix runs BEFORE those terms are added. `worldMin`/`worldSize` are the
 * volume's LIVE world uniforms, so every F2 slide moves the feather with the
 * box for free.
 */
export function createGiResolve({ gbuffer, targets, width, height, gather = null, screenGather = null, screenRadiance = null, cameraPosition = null, normalOffset, intensity, emitter, radiance = null, ao = null, vxao = null, rawCopy = null, emitterTileCut = null, farField = null, bounceWeight = null, reflectionsEnabled = null, emitterShadowSize = null, projScale = null }) {
  // §11.35: an AO term computed at AO resolution is applied in the MATERIAL
  // (giLight samples it at the pixel's own screen UV); folding it into the
  // half-res irradiance here would put the last of the three blurs back.
  if (vxao?.materialSide) vxao = null;
  // The TARGETS are owned by the caller and outlive every rebuild: materials
  // sample them through persistent texture nodes, so recreating them here
  // would silently leave already-compiled materials bound to dead textures.
  // `emitterShadow` is no longer written here — the dedicated emitter shadow
  // pass + filter own it (see createGiEmitterShadowPass); this kernel only
  // SAMPLES it for the diffuse emitter-direct term.
  //
  // `rawCopy` (§12.65): with the irradiance temporal filter built, this kernel
  // ALSO stores its result into `irradianceRaw` — the filter's input. The
  // resolve keeps writing `irradiance` itself so a filter whose pipeline
  // never lands (the §12.56-class silent wedge — see the plan's §12.65
  // postmortem: four priming shapes fired and failed while the identical
  // page-context dispatch worked) degrades to the PRE-FILTER image instead of
  // a black GI texture. The filter, when alive, overwrites `irradiance` later
  // in the same frame (queue order: resolve → filter → history snapshot).
  const { irradiance, radiance: radianceTarget } = targets;

  // Size lives in a uniform so a viewport resize is a uniform write, not a
  // shader rebuild (the WGSL stays byte-identical → three's node cache and
  // the driver's pipeline cache both hit).
  const widthU = uniform(width, "uint");

  const positionNode = texture(gbuffer.position);
  const normalNode = texture(gbuffer.normal);

  const compute = Fn(() => {
    const px = instanceIndex.mod(widthU);
    const py = instanceIndex.div(widthU);
    const coord = ivec2(px.toInt(), py.toInt());
    const g0 = positionNode.load(coord).toVar();
    const g1 = normalNode.load(coord).toVar();
    const out = vec3(0).toVar();
    const reflectedOut = vec3(0).toVar();
    // Diffuse-term validity, written to the outputs' alpha. Defaults to 1 so
    // every arm without an explicit validity source (the legacy closure
    // gather, background pixels) behaves exactly as before.
    const knownF = float(1).toVar();
    // Position alpha and a real normal are one validity contract. The normal
    // half is deliberately repeated here even though the gbuffer producer
    // writes both together: a background material can write attachment zero
    // while leaving the normal attachment clear. Treating that split write as
    // geometry normalizes zero and turns a sky pixel into NaN AO at the world
    // origin.
    If(g0.w.greaterThan(0.5).and(g1.xyz.dot(g1.xyz).greaterThan(0.25)), () => {
      const P = g0.xyz.toVar();
      const rawN = g1.xyz.normalize().toVar();
      const facing = step(0, rawN.dot(cameraPosition ? vec3(cameraPosition).sub(P) : rawN)).mul(2).sub(1);
      const N = rawN.mul(facing).toVar();
      const samplePoint = P.add(N.mul(normalOffset)).toVar();
      // Unit toward-camera vector for the gather's view-bias component
      // (silhouette fix — see cascadeGather.gatherViewBias). Zero when the
      // resolve has no camera at all, which disables it exactly.
      const viewDir = cameraPosition ? vec3(cameraPosition).sub(P).normalize().toVar() : vec3(0);
      // ── THE PRIMARY DIFFUSE TERM COMES FROM EXACTLY ONE OF THESE ────────
      //
      // `!screenGather` is load-bearing, not defensive. Since [I] both inputs
      // are the SAME integral — SRC hands over a closure for the reflection hit
      // below AND a texture its own pass already evaluated per pixel — so
      // running both here would add the pixel's own irradiance to itself. The
      // texture wins because it is the one that has already been paid for.
      if (gather && !screenGather) out.assign(vec3(gather(samplePoint, N, viewDir)).mul(intensity));
      // ── SCREEN-SPACE DIFFUSE INDIRECT (SRC's c0-only resolve) ───────────
      //
      // A TEXTURE, not a closure, and that is the whole reason it is a separate
      // input. `gather` is inlined into this kernel, which already carries the
      // gbuffer, the emitter slots, the occupancy pyramid and the BVH against a
      // PORTABLE limit of eight storage buffers per stage — SRC's version would
      // have added the probe table, the payload and the hash. Its own pass
      // writes a half-res texture instead, and a texture binding is free of that
      // limit (srcScreenGather.js's header).
      //
      // It answers for THIS PIXEL only, so it is deliberately not wired into the
      // reflection-hit shading below: that call site asks about an arbitrary
      // world point, which a screen-space texture cannot answer, and it keeps
      // its documented `gather == null` behaviour until Phase 3's
      // position-indexed probe gather exists.
      // ── SAMPLED BY UV, NOT FETCHED BY TEXEL, SO IT CAN BE SMALLER ────────
      //
      // This was `screenGather.load(coord)`, which requires the gather texture
      // to be exactly resolve-sized. It no longer is: SRC runs its gather at
      // `SRC_GATHER_SCALE` (srcSystem) because the gather is per-output-pixel
      // work and measured 7.55 ms of a 34 ms SRC chain at the user's 1,599,840
      // px. A UV sample lets the hardware bilinear do the upsample for free,
      // and it keeps the RESOLVE at full resolution — which is what ultra's
      // `resolveScale: 1` is actually for (the AO/shadow composite's silhouette
      // edges), and what a `resolveScale` change would have thrown away with it.
      //
      // Same `(px + 0.5) / size` form the AO block below already uses. It works
      // at any gather size including 1:1, so nothing is conditional on the
      // scale — a texture the same size as the resolve samples its own texel
      // centres and returns exactly what `load` did.
      if (screenGather) {
        const guv = vec2(px.toFloat().add(0.5).div(width), py.toFloat().add(0.5).div(height));
        const gs = screenGather.sample(guv).level(0).toVar();
        out.addAssign(gs.xyz.mul(intensity));
        // The gather's alpha is VALIDITY (srcScreenGather: 1 = coverage
        // found, 0 = unknown — an absence, not darkness). Carried through
        // this composite so the temporal filter can hold history over
        // unknown regions instead of blending real light toward black —
        // the black-rectangle class (probe retirement, re-anchors, cold
        // frontiers) dies at the display even while the field refills.
        knownF.assign(gs.w);
      }
      // AMBIENT OCCLUSION ON THE INDIRECT TERM — one texture sample.
      //
      // The probe lattice is ~1m — indirect light arrives with NO small-scale
      // occlusion: no contact darkening under props, no corner/crevice
      // shading. The obscurance itself is computed in `createGiAoPass` (see
      // its header for why the inlined occupancy-oracle ladder that used to
      // live here is gone: §13.7f's unfinishable compile, §13.7d's 0.7 m
      // blind zone); this kernel pays a single bilinear sample.
      //
      // Applied to the GATHER term only: emitter/analytic direct have real
      // traced shadows (penumbra estimator) — obscuring them twice reads as
      // dirt. Reflections keep their own visibility. In particular, this AO is
      // a scalar HEMISPHERE estimate: applying it to the directional glossy
      // lookup makes a smooth metal go black on tiers where the exact trace is
      // absent or on pixels where it misses. A mirror ray and a cosine
      // hemisphere do not share an occlusion factor.
      //
      // The block compiles out when the component's `ao` prop is off
      // (structural), and is gated on having a diffuse term at all — with none,
      // `out` is zero here.
      if ((gather || screenGather) && (ao?.node || vxao?.node)) {
        const aoUv = vec2(px.toFloat().add(0.5).div(width), py.toFloat().add(0.5).div(height));
        let factor = ao?.node ? ao.node.sample(aoUv).level(0).x : float(1);
        // Hybrid composition, not multiplication: screen AO owns sub-voxel
        // contacts while VXAO owns world-space/off-screen blockers. Taking the
        // darker factor lets either estimator fill the other's blind spot but
        // never charges the same occluder twice.
        if (vxao?.node) {
          // Hardware bilinear magnification crosses object silhouettes: one
          // low-res floor texel beside a pillar blends into the pillar's
          // pixels, creating a halo. Reuse the already-bound gbuffer to weight
          // the four low-res samples by whether they belong to THIS surface.
          // This costs texture reads only — no new storage buffer, so the
          // portable eight-buffer budget is unchanged.
          const vxWidth = vxao.width ?? width;
          const vxHeight = vxao.height ?? height;
          // Full-resolution VXAO needs no reconstruction at all. In
          // particular, don't blur its exact per-pixel value back across a
          // broad planar surface just because the optional half-res path has
          // an edge-aware filter.
          if (vxWidth === width && vxHeight === height) {
            factor = factor.min(vxao.node.load(coord).x);
          } else {
          const lowX = px.toFloat().add(0.5).mul(vxWidth / width).sub(0.5).toVar();
          const lowY = py.toFloat().add(0.5).mul(vxHeight / height).sub(0.5).toVar();
          const baseX = lowX.floor().toVar();
          const baseY = lowY.floor().toVar();
          // THE BILINEAR FRACTIONS ARE NOT OPTIONAL. Weighting the 2×2 by the
          // edge terms ALONE is a box filter: every full-res pixel inside one
          // low-res quad gets the identical average, so a smooth AO gradient
          // comes out as 2×2 plateaus — quantised bands on exactly the large
          // featureless floors this term exists to shade. The edge terms
          // MODULATE a bilinear interpolation; they do not replace it.
          const fx = lowX.sub(baseX).toVar();
          const fy = lowY.sub(baseY).toVar();
          const value = float(0).toVar();
          const weight = float(0).toVar();
          const addVxaoTap = (dx, dy) => {
            const bilinear = (dx === 0 ? fx.oneMinus() : fx).mul(dy === 0 ? fy.oneMinus() : fy);
            const lx = baseX.add(dx).toInt().clamp(0, vxWidth - 1).toVar();
            const ly = baseY.add(dy).toInt().clamp(0, vxHeight - 1).toVar();
            // Must match createGiVxaoPass's low-pixel → gbuffer mapping.
            const gx = lx.toFloat().add(0.5).mul(width / vxWidth).toInt().clamp(0, width - 1);
            const gy = ly.toFloat().add(0.5).mul(height / vxHeight).toInt().clamp(0, height - 1);
            const tapP = positionNode.load(ivec2(gx, gy)).toVar();
            const tapN = normalNode.load(ivec2(gx, gy)).xyz.normalize().toVar();
            const sameNormal = smoothstep(0.7, 0.95, tapN.dot(N).abs());
            // PLANE distance, not Euclidean distance. A floor seen at a
            // grazing angle puts the neighbouring low-res texel metres away
            // along the surface while it is still the SAME plane; a Euclidean
            // test rejects all four taps there and the term falls back to
            // "unoccluded", which reads as AO switching off toward the horizon.
            // 0.75 m of plane separation is deliberately wider than the voxel
            // AO detail scale: it keeps broad floor gradients while rejecting
            // the foreground/background discontinuities (pillar, wall and
            // furniture edges) the filter is actually for.
            const sameDepth = float(1).sub(smoothstep(0.12, 0.75, N.dot(tapP.xyz.sub(P)).abs()));
            const w = tapP.w.greaterThan(0.5).select(sameNormal.mul(sameDepth), float(0)).mul(bilinear);
            value.addAssign(vxao.node.load(ivec2(lx, ly)).x.mul(w));
            weight.addAssign(w);
          };
          addVxaoTap(0, 0);
          addVxaoTap(1, 0);
          addVxaoTap(0, 1);
          addVxaoTap(1, 1);
          const vxFactor = value.div(weight.max(1e-4)).toVar();
          // A disocclusion has no trustworthy low-res neighbour. Falling back
          // to unoccluded is preferable to importing a pillar/wall's dark
          // factor across the silhouette for a frame.
          factor = factor.min(weight.greaterThan(1e-4).select(vxFactor, float(1)));
          }
        }
        // AO is a live feature switch. Its capability and sample stay in this
        // graph so an Inspector toggle cannot invalidate world data or force a
        // new resolve pipeline; disabled resolves exactly to factor 1.
        const aoActive = ao?.enabled ?? vxao?.enabled ?? float(1);
        out.mulAssign(mix(float(1), factor, float(aoActive).clamp(0, 1)));
      }
      // ── §13 F3: THE FAR FIELD IS DELIBERATE, NOT AN ACCIDENT ────────────
      // Runs AFTER the AO block on purpose: the AO oracle's occupancy taps
      // are undefined outside the volume, and a fallback multiplied by a
      // broken obscurance would re-crush exactly the pixels this term
      // exists to lift. Runs BEFORE the direct terms below, which must
      // survive at any distance.
      if (screenGather && farField) {
        const rel = vec3(P).sub(vec3(farField.worldMin)).toVar();
        const size = vec3(farField.worldSize).toVar();
        // Signed inside-distance to the box: negative outside, so the clamp
        // sends w to 1 there and the whole diffuse term becomes the constant.
        const inside = rel.x.min(size.x.sub(rel.x))
          .min(rel.y.min(size.y.sub(rel.y)))
          .min(rel.z.min(size.z.sub(rel.z)))
          .toVar();
        // §11.20: only a real DETAIL box has an outside — see GISystem's
        // `boxFeather` note. Absent one, the volume covers the whole scene and
        // this term is a scene-average wash over every surface near the edge.
        const wBox = farField.boxFeather === false
          ? float(0).toVar()
          : float(1).sub(inside.div(float(farField.feather).max(1e-3)).clamp(0, 1)).toVar();
        // -- NEVER BLACK (2026-09-02): the second reason for the constant --
        // A pixel whose gather found NO coverage (a probe born this frame, a
        // column the camera just revealed, an orphan bin with no parent)
        // used to leave the resolve at zero and rely on the temporal filter
        // finding a valid neighbour; with none, the pixel stayed black: the
        // "black patches as I move" report. Now the scene's far-field mean
        // fills it, weighted by the missing coverage, and the validity stays
        // BELOW the filter's 0.5 adoption threshold so a real neighbour still
        // wins over the constant when one exists. `farField.coverage === false`
        // keeps the box-only behaviour.
        //
        // ⭐⭐ §11.20 — AND `1 − knownF` IS THE WRONG COVERAGE (2026-09-03,
        // the user's "almost no colour bleed", twice).
        //
        // Two different things are called coverage here. SPATIAL: did any
        // probe answer for this point — the case this fallback exists for (a
        // probe born this frame, a revealed column, an orphan bin). ANGULAR:
        // how much of this texel's cosine lobe has ever been sampled, which
        // since §12.87 is an honest FRACTION carried in the tile's alpha and
        // therefore in `knownF`. A fully-covered room converges to angular
        // coverage around 0.55 (measured on their Cornell: meanKnownBins 11.4
        // of a 20.1-bin lobe) — so a LINEAR `1 − knownF` mixed **45 % of a
        // flat, scene-average, warm-white constant into every pixel of a
        // perfectly well-covered room**, permanently. That is the missing
        // colour bleed, and it is also why the field read bright-but-pale:
        // the constant carries the room's MEAN, which is exactly the thing a
        // Cornell box's red and green walls are not.
        //
        // Measured, their Cornell, one pose, 30 s settle, against the path
        // tracer: whites' saturation 0.159 with the fill, 0.423 with
        // `__giFarField = false` (tracer 0.573), and the luminance ratio
        // 0.81× → 1.20×. The fix keeps the never-black guarantee and drops
        // the tax: the fill ramps in only where coverage is genuinely LOW,
        // reaching full strength at zero coverage — where the 2026-09-02
        // cases all sit — and contributing nothing at the 0.5-ish coverage a
        // healthy room runs at. Smooth, because a step here would be an edge
        // in the image (the standing no-edges rule).
        //
        // `__giFarFieldCoverageLow` moves the knee (0 restores box-only);
        // `__giFarFieldLinearCoverage = true` restores the old linear ramp
        // for an A/B.
        // ⚠ OPT-IN AND UNPROVEN. On their Cornell this ramp measured NO
        // difference either way (whites' saturation 0.160 vs 0.159) because
        // the box term above was carrying the whole wash — so it has no
        // evidence behind it, and the linear form is what every "never black"
        // case was built and tested against. `__giFarFieldCoverageRamp = true`
        // arms it; `__giFarFieldCoverageLow` moves its knee.
        const covLow = Number.isFinite(Number(globalThis.__giFarFieldCoverageLow))
          ? Math.max(0, Number(globalThis.__giFarFieldCoverageLow))
          : 0.25;
        // ── §11.26 (Unit 1c): THE RAMP IS THE DEFAULT NOW ────────────────────
        //
        // `knownF` used to be the SAMPLED FRACTION of a pixel's lobe (a bin was
        // in or out), so `1 − knownF` was "the share of the lobe nobody has
        // looked at" and filling that share with the far-field constant was
        // defensible. §11.25 made coverage a CONFIDENCE (`Σ cw·c / Σ cw`), which
        // is legitimately 0.1–0.3 for seconds in any sparse region — a fresh
        // corridor, a dark vault — while the estimate underneath is already
        // the parent's real, dim light. The linear form then blended 70–90 % of
        // such pixels into the flat constant: measured on a cold Sponza
        // corridor in the harness, meanLum 0.043 (old) → 0.0043 (Unit 1), STATIC
        // (0 % of pixels moving at rest — a constant does not move), and
        // "responding" to a sun step only because the constant's EMA follows
        // the sun. Same class as §11.20's box feather: a fill designed for
        // ABSENCE reading a fraction as absence.
        //
        // The ramp form fills only where there is almost NO information (full
        // at knownF 0, gone by `covLow` 0.25 — about five rays of evidence at
        // K = 16) and leaves a confident-but-not-certain pixel alone. Under the
        // old coverage §11.20 measured it as "no measurable difference", which
        // is why flipping the default is safe for `__giSrcConfidence = false`
        // too. `__giFarFieldCoverageRamp = false` restores the linear fill.
        const wCov = farField.coverage === false
          ? float(0).toVar()
          : globalThis.__giFarFieldCoverageRamp !== false && covLow > 0
            ? smoothstep(float(0), float(1), float(1).sub(knownF.div(float(covLow)).clamp(0, 1))).toVar()
            : float(1).sub(knownF).clamp(0, 1).toVar();
        const w = wBox.max(wCov).toVar();
        If(w.greaterThan(0), () => {
          // Sky-down hemisphere with a ground-bounce floor: up-facing 1.0,
          // walls 0.6, down-facing 0.2 — the average already contains the
          // scene's own ground bounce, so a hard cosine would starve awnings
          // and soffits for no physical reason.
          const hemi = N.y.mul(0.4).add(0.6);
          const constant = farField.node.load(ivec2(0, 0)).xyz.mul(hemi).mul(intensity);
          out.assign(mix(out, constant, w));
          // A pixel the far-field constant covers is ANSWERED, whatever the
          // gather knew — the deliberate F3 constant is a value, not an
          // absence. The coverage fill is NOT: it stays below 0.5 so the
          // temporal filter still adopts a real neighbour over it.
          knownF.assign(knownF.max(wBox).max(wCov.mul(0.49)));
        });
      }
      // ── GLOSSY RADIANCE, FROM THE HALF-RES GATHER PASS (§12.71b v2) ─────
      //
      // A TEXTURE, not a closure, for exactly the reason the diffuse term is:
      // the directional probe gather is per-pixel work that inlines the whole
      // gatherAt graph, and §12.71b's first version paid that inside THIS
      // kernel at resolve res. SRC's glossy pass now evaluates it at half
      // gather res (a glossy lobe is blurrier than any upsample), the
      // radiance temporal filter tames the single-bin noise that made v1
      // opt-in, and this kernel pays one bilinear sample. Written to the
      // radiance target pre-multiplied by intensity — the same convention as
      // the closure path, so giLight's specular blend is unchanged. This is a
      // DIRECTIONAL radiance estimate and deliberately does not inherit the
      // diffuse hemisphere-AO scalar above.
      if (screenRadiance) {
        const ruv = vec2(px.toFloat().add(0.5).div(width), py.toFloat().add(0.5).div(height));
        reflectedOut.assign(
          screenRadiance.sample(ruv).level(0).xyz
            .mul(intensity)
            .mul(reflectionsEnabled ? float(reflectionsEnabled).clamp(0, 1) : 1),
        );
      } else if (radiance?.lookup && cameraPosition) {
        const incident = P.sub(cameraPosition).normalize().toVar();
        const reflected = reflect(incident, N).toVar();
        reflectedOut.assign(
          vec3(radiance.lookup(samplePoint, reflected))
            .mul(intensity)
            .mul(reflectionsEnabled ? float(reflectionsEnabled).clamp(0, 1) : 1),
        );
      }
      if (emitter) {
        // The per-slot shadows come pre-traced and pre-filtered from the
        // emitter shadow pass. The trace left this kernel for the same reason
        // the direct-light trace did: it was the most expensive per-pixel
        // work here and its pixel count deserves its own budget.
        //
        // ── THE UPSAMPLE IS SURFACE-VALIDATED (2026-09-11) ──────────────────
        //
        // This used to be one hardware-bilinear sample of the shadow-res
        // texture, and that was the "white dashed halo around every ball"
        // (the ball-pool scene, 350 spheres under one emissive orb). The
        // emitter mask runs at `emitterShadowScale` AND under a 160k-pixel
        // ceiling — on a 2 MP viewport that is ~3.6 texels of resolve per
        // mask texel — and a bilinear fetch has no idea which SURFACE a texel
        // belongs to. At a silhouette the lit texels on the front ball blend
        // into the shadowed pixels of the ball behind it: a bright rim one to
        // two pixels wide, exactly along the camera silhouette, dashed with
        // the mask grid's phase. No shadow bias can touch it — the trace was
        // right at every texel it marched; the blend between texels was the
        // artifact. (Six other causes were claimed and refuted before this
        // one was read off the code: emitter scale, both checkerboards, seat
        // rotation, resolve scale, the AO term, MSAA — none of them touched
        // this line.)
        //
        // Now: the same 2×2 bilinear footprint, each tap weighted by its
        // bilinear weight × a receiver-plane test × a normal gate against
        // THIS pixel's P/N — the mask-res filter pass's own same-surface
        // test (createGiLightShadowFilterPass), with the tap's receiver read
        // from the gbuffer at the texel centre the shadow pass marched. The
        // plane eps is distance-robust the same way (two mask texels of
        // world footprint). A pixel whose four taps all fail — a sliver
        // thinner than a mask texel — takes the tap NEAREST ITS OWN PLANE,
        // never a blend, so a rim pixel on the front ball reads the front
        // ball's shadow and a pixel just outside it reads the background's.
        // `__giEmitterShadowValidatedUpsample = false` is the A/B arm (the
        // plain bilinear fetch).
        const shadowUv = vec2(px.toFloat().add(0.5).div(width), py.toFloat().add(0.5).div(height));
        const packedShadow = vec4(texture(targets.emitterShadow, shadowUv).level(0)).toVar();
        const validatedUpsample = !!emitterShadowSize
          && globalThis.__giEmitterShadowValidatedUpsample !== false
          && (emitterShadowSize.width !== width || emitterShadowSize.height !== height);
        if (validatedUpsample) {
          const ew = Math.max(1, emitterShadowSize.width | 0);
          const eh = Math.max(1, emitterShadowSize.height | 0);
          const sxE = width / ew;
          const syE = height / eh;
          const shadowTex = texture(targets.emitterShadow);
          // Continuous mask-space coordinate of this pixel's centre, shifted
          // by half a texel so (x0, y0)..(x0+1, y0+1) is the bilinear footprint.
          const fx = px.toFloat().add(0.5).div(sxE).sub(0.5).toVar();
          const fy = py.toFloat().add(0.5).div(syE).sub(0.5).toVar();
          const x0 = fx.floor().toVar();
          const y0 = fy.floor().toVar();
          const tx = fx.sub(x0).toVar();
          const ty = fy.sub(y0).toVar();
          // One mask texel's world footprint at this receiver, from the same
          // projection scale the AO and shadow filters use. Without a
          // projection scale, a fixed 2 cm — the medium's own quantization.
          const texelW = (cameraPosition && projScale)
            ? P.sub(vec3(cameraPosition)).length().div(float(projScale).max(1e-3).mul(eh))
            : float(0.01);
          const eps = texelW.mul(2).max(1e-3).toVar();
          const acc = vec4(0).toVar();
          const wSum = float(0).toVar();
          const bestD = float(1e9).toVar();
          const bestS = vec4(packedShadow).toVar();
          for (let j = 0; j < 2; j++) {
            for (let i = 0; i < 2; i++) {
              const tap = ivec2(
                x0.add(i).toInt().clamp(0, ew - 1),
                y0.add(j).toInt().clamp(0, eh - 1),
              ).toVar();
              // The receiver the shadow pass marched for this texel: the
              // gbuffer at the texel centre, the pass's own mapping.
              const tg = ivec2(
                tap.x.toFloat().add(0.5).mul(sxE).toInt().clamp(0, width - 1),
                tap.y.toFloat().add(0.5).mul(syE).toInt().clamp(0, height - 1),
              ).toVar();
              const q0 = positionNode.load(tg).toVar();
              const q1 = normalNode.load(tg).toVar();
              const wb = (i ? tx : float(1).sub(tx)).mul(j ? ty : float(1).sub(ty));
              const planeD = q0.xyz.sub(P).dot(N).abs().toVar();
              const wPlane = float(1).sub(planeD.div(eps)).clamp(0, 1);
              // Length-guarded: a no-geometry tap's normal is zero and a
              // normalize() there is NaN, which no multiply by q0.w removes.
              const wNormal = q1.xyz.dot(N).div(q1.xyz.length().max(1e-3)).sub(0.7).mul(1 / 0.3).clamp(0, 1);
              const w = wPlane.mul(wNormal).mul(q0.w).mul(wb).toVar();
              const s = vec4(shadowTex.load(tap)).toVar();
              acc.addAssign(s.mul(w));
              wSum.addAssign(w);
              If(q0.w.greaterThan(0.5).and(planeD.lessThan(bestD)), () => {
                bestD.assign(planeD);
                bestS.assign(s);
              });
            }
          }
          packedShadow.assign(select(wSum.greaterThan(1e-4), acc.div(wSum.max(1e-4)), bestS));
        }
        const shadowChannels = [packedShadow.x, packedShadow.y, packedShadow.z, packedShadow.w];
        // §12.70 W4b slice (ii): under the tile cut, the evaluated slots are
        // the pixel's TILE's id-keyed emitters loaded from tree records — the
        // shadow texture's channels were marched for exactly this list by
        // exactly this keying, so `shadowSample(i)` still means "my i-th
        // emitter's visibility" at every pixel. The reflection-hit path below
        // keeps the GLOBAL seats on purpose: a hit is a different world point
        // — its tile is not this pixel's — and its emitter direct ships
        // unshadowed anyway (§12.56.1).
        let slotSource = emitter;
        let tileComp = null;
        if (emitterTileCut) {
          const spx = px.toFloat().add(0.5).mul(emitterTileCut.scaleX);
          const spy = py.toFloat().add(0.5).mul(emitterTileCut.scaleY);
          const tile = spy.div(emitterTileCut.tileSize).toUint().min(uint(emitterTileCut.tilesY - 1))
            .mul(uint(emitterTileCut.tilesX))
            .add(spx.div(emitterTileCut.tileSize).toUint().min(uint(emitterTileCut.tilesX - 1)))
            .toVar();
          // §13.8 THE SOFT CUT, applied as a RADIANCE scale on the marginal
          // channel. It has to be the colour and not the shadow: the shadow
          // channel is a VISIBILITY that the bilateral filter and the two
          // penumbra-reconstruction passes read as such, and a weight smuggled
          // through it would be blurred across silhouettes as if it were an
          // occluder. Scaling `color` also carries the fade through
          // `emitterDirectAt`'s own cutoff smoothstep, so a channel fading out
          // leaves the reach gate smoothly instead of stepping off it.
          const tileW = emitterTileCut.posBuf
            ? emitterTileCut.posBuf.element(tile.mul(3).add(uint(2))).toVar()
            : null;
          const wAt = tileW ? [tileW.x, tileW.y, tileW.z, tileW.w] : null;
          const tileSlots = [0, 1, 2, 3].map((k) => {
            const slot = emitterTileCut.recordSlot(emitterTileCut.idBuf.element(tile.mul(4).add(uint(k))));
            return wAt ? { ...slot, color: vec3(slot.color).mul(wAt[k]).toVar() } : slot;
          });
          slotSource = { ...emitter, emitterSlots: tileSlots };
          // §12.70 W4c: the cut's tail compensation. The kept four carry the
          // dropped tail's power, so the tile delivers the FULL set's energy
          // — which is what makes two tiles that kept DIFFERENT sets agree at
          // their shared boundary: A gives kept_A · (Σ/kept_A) = Σ and B
          // gives Σ, where uncompensated they gave kept_A ≠ kept_B.
          //
          // ⚠ THE RATIO IS PAIRED WITH ITS OWN TILE'S SET AND MUST STAY
          // NEAREST. Interpolating it across tile centres (the obvious
          // "smooth the seam away" move) hands tile A's kept sum tile B's
          // divisor and re-opens the step it just closed, WIDER — the
          // boundary pixel would deliver kept_A · (Σ/kept_A + Σ/kept_B)/2.
          // Continuity here comes from the pairing, not from blurring.
          if (emitterTileCut.posBuf) {
            tileComp = emitterTileCut.posBuf.element(tile.mul(3).add(uint(1))).w.toVar();
          }
        }
        const direct = emitterDirectAt(
          { ...slotSource, shadowSample: (i) => shadowChannels[i] ?? float(1) },
          P, N, samplePoint,
        );
        out.addAssign(
          tileComp ? direct.irradiance.mul(intensity).mul(tileComp) : direct.irradiance.mul(intensity),
        );
      }
      // GI-traced direct shadows moved to their OWN pass — see
      // createGiLightShadowPass below (independent pixel budget; the trace
      // was the most expensive per-pixel work in this kernel). Exact-
      // reflection hit shading moved out for the same reason (§14 R-A) —
      // see createGiBvhHitShade below.
    });
    // Bounce is the live weight of the complete diffuse GI contribution, not
    // merely the feedback-loop gain. Keeping this multiply at the final store
    // makes Off immediately and visibly zero the term while leaving glossy
    // reflections independent and preserving one stable compute graph.
    out.mulAssign(bounceWeight ? float(bounceWeight).clamp(0, 1) : 1);
    textureStore(irradiance, coord, vec4(out, knownF));
    if (rawCopy) textureStore(rawCopy, coord, vec4(out, knownF));
    textureStore(radianceTarget, coord, vec4(reflectedOut, 1));
  })().compute(width * height);

  return { compute, widthU };
}

/**
 * EXACT-REFLECTION HIT SHADING, as its own pass (§14 unit R-A, 2026-08-22).
 *
 * The BVH prepass traced a reflected ray per pixel earlier this frame and
 * left `{ t, oct-normal }` + albedo in the `bvhShade` textures. This kernel
 * reconstructs each hit point and computes the reflected surface's OUTGOING
 * radiance — field gather + cone-SHADOWED emitter direct + cone-SHADOWED
 * analytic/sun direct — and stores it to `bvhShade.target`, which the mirror
 * materials sample (giLight's exact blend).
 *
 * WHY ITS OWN KERNEL, with the receipts (this block used to live in
 * createGiResolve — see the note in its header):
 * - Traced shadows at hits were measured at resolve 5.95 → 66 ms INSIDE the
 *   resolve, and the cost did not move with the hit-pixel count: register
 *   pressure from the cone marcher collapsed the whole kernel's occupancy.
 *   In its own pass the marcher prices only this dispatch.
 * - The consequence of shipping without them was the user-visible bug: at
 *   DENSE every reflected surface took FULL unshadowed sun + emitter light —
 *   "washed out solid colors without GI or any lighting" on every ultra
 *   mirror. Shadows at hits are the difference between a reflection of the
 *   room and a reflection of the room's albedo.
 * - The old 16-uniform-buffer objection to a self-contained hit pass is
 *   obsolete: sceneSettings asks the adapter for 24 (the probe capture
 *   kernel already binds this exact bundle set and runs everywhere).
 *
 * The shading formula and its diet are IDENTICAL to the reflection probe
 * capture's hit shading (reflectionProbeCapture.js) on purpose — one formula,
 * two consumers: the cone (never the record march), 24× luma trace admission,
 * 4 m emitter march cap, 6 m analytic cap. `__giHitEmitterShadows = false`
 * is the escape hatch back to unshadowed hits (now meaningful at every
 * density — it used to be the dense-mode default).
 *
 * MISS SEMANTICS ride through unchanged: alpha 0 = no hit resolved (masked
 * skip, or hit with no albedo), 1 = shaded hit, −1 = traced miss (giLight's
 * env-on-miss keys on it).
 */
/**
 * ⭐ `termMask` — THE TERM DECOMPOSITION INSTRUMENT (§18.15, 2026-08-25).
 *
 * The hit radiance is a SUM of four independently-sourced terms (field gather,
 * probe-atlas floor, emitter direct, analytic/sun direct) and a colour cast can
 * come from any of them. Reading the code has now produced FOUR wrong answers
 * about one green cast, because every term is individually plausible and none
 * of them is individually observable — `bvhRadiance` only ever shows the sum.
 *
 * `termMask` is a vec4 uniform, one scalar per term in that order, that scales
 * each term where it enters. Set it to (1,0,0,0) and the readback IS the gather
 * term; (0,0,1,0) and it is the emitter term alone. One build, four arms, no
 * rebuild between them — which is the whole point: an A/B that costs a 50 s
 * Bistro rebuild per arm does not get run.
 *
 * It is BUILD-TIME OPT-IN (`null` here → not a single node emitted), so the
 * shipping graph is byte-identical to the pre-instrument one and this cannot
 * become a silent 4-multiply tax on every reflected pixel.
 */
/**
 * The sampled-target replication is a startup fail-safe, not a redundant
 * steady-state contract: until the temporal pipeline is alive the target must
 * still contain the unfiltered hit shade. Keep it on by default; the hatch is
 * only for measuring the storage-write cost after the temporal chain settles.
 */
export function giBvhHitShadeReplicatesTarget(rawCopy, hatch = globalThis.__giBvhReplicateRaw) {
  return !!rawCopy && hatch !== false;
}

export function createGiBvhHitShade({ gbuffer, bvhShade, width, height, resolveWidth = width, resolveHeight = height, gather = null, cameraPosition = null, normalOffset, intensity, emitter = null, rawCopy = null, probes = null, sourceStride = 1, termMask = null, staticOcclude = null, dynOcclude = null, shadowReach = null, bounceWeight = null, sunShadow = null,
  // Water refraction (2026-09-06): 'given' reconstructs the hit along the
  // direction stored in the gbuffer's normal attachment (see
  // createGiBvhReflect's rayMode); `causticGain(point, normal)` multiplies
  // the analytic (sun) term — the lens on a hit under the water.
  rayMode = 'reflect', causticGain = null }) {
  const widthU = uniform(width, "uint");
  const positionNode = texture(gbuffer.position);
  const normalNode = texture(gbuffer.normal);
  const bvhTNode = texture(bvhShade.hit);
  const bvhAlbedoNode = texture(bvhShade.albedo);
  const replicateTarget = giBvhHitShadeReplicatesTarget(rawCopy);
  // width/height is the SHADE grid (half the resolve by default — see
  // createGiBvhTarget's bvhRadiance note); the gbuffer and the prepass's
  // hit/albedo textures live on the resolve grid. The mapping FLOORS
  // (c·scale) deliberately — NOT the centre-of-texel (c+0.5)·scale the
  // temporal pass uses for gbuffer reads: at scale 2 the centre form lands
  // every shade texel on an ODD source texel, and the prepass traces block
  // ANCHORS at EVEN coords (one ray per stride×stride block) — odd texels
  // are the replicated copies, which are exactly the ones the silhouette
  // validation rejects to −1. Sampling them preferentially painted
  // scattered dark holes across every glossy tabletop ("many dark
  // artifacts on the mirror table"); the floor form reads the texel the
  // ray was actually traced for, P/N/t all from the same pixel.
  //
  // ⚠ AND IT MUST LAND ON AN ANCHOR, NOT MERELY FLOOR (2026-08-22, the user's
  // "still quite dirty, a lot of lines"). The floor form alone only reads a
  // traced texel when the shade scale is a MULTIPLE of the prepass stride.
  // Shipping was scale 3 (radianceDiv) against stride 2 at every tier below
  // ultra, and 3 vs 2 BEATS: source texels 0,3,6,9,12 have parities
  // even,odd,even,odd… so every second row and column of the reflection was
  // shaded from a REPLICATED texel (or, at a silhouette, one validated out to
  // −1). Two interleaved images = the ruled lines the user photographed, and
  // the pattern is worst on a floor seen at grazing incidence in a mirror,
  // where a neighbour's `t` reconstructs a hit metres away. Quantising the
  // mapping DOWN to the stride makes every shade texel read a real anchor —
  // the sample spacing goes slightly non-uniform (2,4,2,4 at scale 3) and the
  // material's bilinear upsample never sees it. The receiver-matched search
  // below supersedes the one-anchor snap at every tier, including Ultra.
  const sx = resolveWidth / width;
  const sy = resolveHeight / height;
  const stride = Math.max(1, Math.round(sourceStride) || 1);
  // INTEGER division, explicitly: `int(v).div(int(stride))` is i32 division in
  // WGSL (truncating), where letting a raw JS number in risks TSL promoting the
  // whole expression to float — which would make the snap a silent no-op and
  // leave the bug it exists to prevent looking fixed.
  const snap = (v) => (stride > 1 ? int(v).div(int(stride)).mul(int(stride)) : int(v));
  // Stride reconstruction starts from the UNSNAPPED receiver pixel. Snapping
  // first loses the identity needed to reject an anchor from the other side
  // of a silhouette and was the source of the old checker pattern.
  const desiredAt = (sx !== 1 || sy !== 1)
    ? (c) => ivec2(int(c.x.toFloat().mul(sx)), int(c.y.toFloat().mul(sy)))
    : (c) => c;
  const anchorOffsets = giBvhReflectAnchorOffsets(stride);

  const compute = Fn(() => {
    const px = instanceIndex.mod(widthU);
    const py = instanceIndex.div(widthU);
    const coord = ivec2(px.toInt(), py.toInt());
    const desiredCoord = desiredAt(coord);
    const srcCoord = ivec2(snap(desiredCoord.x), snap(desiredCoord.y)).toVar();
    if (stride > 1) {
      const receiver0 = positionNode.load(desiredCoord).toVar();
      const receiver1 = normalNode.load(desiredCoord).toVar();
      const receiverN = receiver1.xyz.normalize().toVar();
      const receiverLive = bvhShade.masked
        ? receiver0.w.greaterThan(0.5).and(receiver1.w.greaterThan(0.5))
        : receiver0.w.greaterThan(0.5);
      const posTol = receiver0.xyz.sub(vec3(cameraPosition)).length().mul(0.02).max(0.01).toVar();
      const baseX = snap(desiredCoord.x);
      const baseY = snap(desiredCoord.y);
      const bestScore = float(1e20).toVar();
      // Four neighbouring REAL trace anchors, never replicated texels. A
      // candidate must belong to the same receiver plane and must have run a
      // ray (-2 is a proven environment miss; -1 means no ray ran).
      for (const [dx, dy] of anchorOffsets) {
        const cx = baseX.add(int(dx));
        const cy = baseY.add(int(dy));
        If(cx.lessThan(int(resolveWidth)).and(cy.lessThan(int(resolveHeight))), () => {
          const candidate = ivec2(cx, cy);
          const candidate0 = positionNode.load(candidate).toVar();
          const candidate1 = normalNode.load(candidate).toVar();
          const candidateHit = bvhTNode.load(candidate).toVar();
          const traced = candidateHit.x.greaterThanEqual(0).or(candidateHit.x.lessThan(-1.5));
          const sameReceiver = receiverLive
            .and(candidate0.w.greaterThan(0.5))
            .and(traced)
            .and(candidate0.xyz.sub(receiver0.xyz).length().lessThan(posTol))
            .and(candidate1.xyz.normalize().dot(receiverN).greaterThan(0.965));
          const dxPx = cx.sub(desiredCoord.x).toFloat();
          const dyPx = cy.sub(desiredCoord.y).toFloat();
          const score = dxPx.mul(dxPx).add(dyPx.mul(dyPx));
          If(sameReceiver.and(score.lessThan(bestScore)), () => {
            srcCoord.assign(candidate);
            bestScore.assign(score);
          });
        });
      }
    }
    const g0 = positionNode.load(srcCoord).toVar();
    const g1 = normalNode.load(srcCoord).toVar();
    const bvhOut = vec3(0).toVar();
    const bvhValid = float(0).toVar();
    If(g0.w.greaterThan(0.5), () => {
      const P = g0.xyz.toVar();
      {
        const hitTexel = bvhTNode.load(srcCoord).toVar();
        const albedoTexel = bvhAlbedoNode.load(srcCoord).toVar();
        // A traced hit (t >= 0) that also resolved an albedo. Both conditions
        // matter: the prepass writes t = -1 on a miss AND on every pixel the
        // mirror mask skipped, so this is already restricted to the pixels a
        // reflective material will actually read.
        If(hitTexel.x.greaterThanEqual(0).and(albedoTexel.w.greaterThan(0.5)), () => {
          // Reconstruct the hit EXACTLY as the prepass traced it: same
          // unflipped gbuffer normal (the resolve's `facing` flip is a
          // convention the prepass does not share), same normal-lifted
          // origin, same reflected direction. A mismatch here does not fail
          // loudly — it shades a point slightly off the surface, which reads
          // as dim or striped reflections.
          const rawN = g1.xyz.normalize().toVar();
          // The SAME camera uniform the prepass traced with — two uniforms
          // that merely happen to be written from the same camera each tick
          // is one write-ordering bug away from striped reflections.
          const incident = P.sub(vec3(cameraPosition)).normalize().toVar();
          const R = (rayMode === 'given' ? rawN : reflect(incident, rawN)).toVar();
          const hitP = P.add((rayMode === 'given' ? R : rawN).mul(normalOffset)).add(R.mul(hitTexel.x)).toVar();
          // The hit's true face normal, flipped to face the incoming ray: a
          // BVH hit routinely lands on single-sided geometry whose winding
          // points away, and gathering with a back-facing normal samples the
          // probe field on the far side of the wall — which is exactly the
          // "reflected surface is black" failure.
          const nRaw = decodeOctNormal(hitTexel.zw).toVar();
          const nFace = select(nRaw.dot(R).lessThan(0), nRaw, nRaw.negate()).toVar();
          const shadePoint = hitP.add(nFace.mul(normalOffset)).toVar();
          // Direct terms only when there is no gather — a reflected surface then
          // shows its emitter/analytic lighting and no bounce, which is dim but
          // correct, where a missing base would have been black.
          // Bounce is a live contribution weight at reflected hits too. Its
          // zero arm skips SRC/probe sampling while direct lighting below
          // remains alive, matching the primary resolve's Bounce=Off meaning.
          const hitE = vec3(0).toVar();
          const addIndirect = () => {
            hitE.assign(gather ? vec3(gather(shadePoint, nFace, vec3(0))) : vec3(0));
          // Term 1 of 4 — see the termMask note on this function.
          if (termMask) hitE.mulAssign(termMask.x);
          // R-C STOPGAP (2026-08-22, "many artifacts" on the chrome box):
          // the field gather is SCREEN-FED — behind the camera, where
          // mirrors look, its pools are patchily populated and a starved
          // gather reads near-black (the brown/dark mottle on every glossy
          // tabletop). The reflection-probe atlas's COSINE tile is a
          // converged world-space irradiance estimate anywhere in a probe's
          // box, so it is a LUMINANCE FLOOR on the bounce term only:
          // whichever of {field, probe} carries more light wins WHOLE
          // (never mixed — mixing would tint the converged field with the
          // blurry probe; and floor-only, because a starved gather always
          // errs DARK). The atlas stores intensity-PREmultiplied radiance
          // (capture convention) while hitE is ×intensity at the store, so
          // the probe term divides intensity back out. No probes, or
          // outside every box → p.weight 0 → inert. Real R-C (seeding SRC
          // probes at reflection hit points) supersedes this. NOT applied
          // in the probe capture's twin formula — the capture WRITES the
          // atlas this reads (feedback loop).
          if (probes) {
            const p = sampleReflectionProbes(probes, shadePoint, nFace, float(1));
            const pIrr = vec3(p.rgb).mul(Math.PI).mul(p.weight).div(float(intensity).max(1e-4)).toVar();
            const lumW = vec3(0.2126, 0.7152, 0.0722);
            // SOFT blend by luminance ratio, not a whole-winner select
            // (2026-08-22 round 2, "shadows in mirrors look very weird"):
            // the binary select flipped per hit point between the NOISY
            // starved field and the smooth probe — the mottle survived,
            // recoloured. Widened same day ("reflections are very dirty"):
            // the field's per-point bounce variance IS the dirt on every
            // reflected floor, so the probe now dominates up to ~parity
            // (ratio 1 → ~half probe) and the field only wins outright
            // where it is decisively BRIGHTER than the room average (sun
            // bounce hotspots, ratio ≥1.6). Reflected bounce trades
            // per-point exactness for the probe's smoothness — the traced
            // direct sun/emitter terms added below keep the contrast that
            // reads as lighting.
            // ── §18.12: FLOOR THE LEVEL, KEEP THE HUE (2026-08-25) ───────────
            //
            // ⚠ THE OLD LINE CONTRADICTED THE COMMENT ABOVE IT. That comment
            // states this is "a LUMINANCE FLOOR on the bounce term only" and
            // warns in the same breath that "mixing would tint the converged
            // field with the blurry probe" — and then the implementation was a
            // full RGB `mix(pIrr, hitE, ...)`, which imports exactly that tint.
            //
            // The blend is deliberately probe-dominant up to ~parity, so ANY
            // reflected surface dimmer than ~1.6x the room average took most of
            // its bounce COLOUR from the probe atlas. The atlas is a blurred
            // capture of the room, so its chroma is the room's average — on the
            // user's Bistro, a scene with a large green neon and green foliage,
            // that average is green. Result: "all reflections are greenish",
            // on every dim reflected surface at once.
            //
            // It surfaced now rather than earlier because §18.6 made
            // `bvhHitShade` run every frame instead of 1 in 30; before that the
            // reflected image was frozen and stale, so the tint was never
            // applied consistently enough to read as a colour cast.
            //
            // THE FIX IS THE COMMENT'S OWN DESIGN: derive a TARGET LUMINANCE
            // with the identical curve, then SCALE the field's own colour to
            // it. Same anti-dirt behaviour (a starved gather still gets lifted
            // out of the dark), none of the chroma import. At parity the field
            // now passes through untouched, where before it was already half
            // probe.
            const fieldLum = hitE.dot(lumW).toVar();
            const probeLum = pIrr.dot(lumW).toVar();
            const ratio = fieldLum.div(probeLum.max(1e-4)).toVar();
            const targetLum = mix(probeLum, fieldLum, smoothstep(0.6, 1.6, ratio)).toVar();
            const lifted = hitE.mul(targetLum.div(fieldLum.max(1e-4))).toVar();
            // Where the field carries essentially NO signal its hue is noise,
            // and there is nothing to preserve — take the probe whole there.
            // This is the one case the old full-RGB mix got right.
            const probeBlend = (
              globalThis.__giHitProbeChroma === true
                ? mix(pIrr, hitE, smoothstep(0.6, 1.6, ratio))
                : mix(pIrr, lifted, smoothstep(0.02, 0.15, ratio))
            ).toVar();
            // Term 2 of 4. This one REPLACES rather than adds, so the mask
            // fades between "no probe influence at all" and the shipped blend.
            hitE.assign(termMask ? mix(hitE, probeBlend, termMask.y) : probeBlend);
          }
            if (bounceWeight) hitE.mulAssign(float(bounceWeight).clamp(0, 1));
          };
          if (bounceWeight) {
            If(float(bounceWeight).greaterThan(1e-4), addIndirect);
          } else {
            addIndirect();
          }
          // ── HIT SHADOWS DEFAULT ON AT EVERY DENSITY (§14 R-A) ────────────
          //
          // The masked-only gate this used to carry was a property of living
          // inside the resolve (the cone marcher collapsed THAT kernel's
          // occupancy — 66 ms whether hits were masked or dense). In its own
          // pass the marches price only this dispatch, so dense hits get the
          // same traced shadows masked ones always did. The diet stays (24×
          // luma admission + 4 m march cap — occluders past the cap stop
          // occluding: a soft, bounded leak, reflections only).
          const hitShadows = globalThis.__giHitEmitterShadows !== false;
          if (emitter) {
            // ── THE RECORD MARCH, NOT THE CONE (2026-08-22, "fix our dirty
            // bvh reflections") ──────────────────────────────────────────
            //
            // This used to force `recordShadowTrace: null` so the shadow at a
            // reflection hit came from the occupancy cone — the affordable
            // estimator. MEASURED live on the user's Level (mirror slab
            // "Block North Chamber", GI_Concrete_Mid = metal 1 / rough 0):
            // the cone stamps a LATTICE OF BLACK CROSSES across every
            // reflected floor and wall. Three split-image probes through this
            // kernel isolated it — albedo clean, bounce clean, sun term
            // separate, and the dirt vanished the moment hit shadows were
            // switched off — and the same surfaces seen DIRECTLY are smooth,
            // so the occlusion is false.
            //
            // It is not a new failure: `emitterSlotShadow`'s own note records
            // it ("the sphere trace's threshold admissions over the
            // voxel-quantized distance field ETCHED A LATTICE GRID ACROSS
            // RECEIVERS UNDER BIG PANEL EMITTERS"), and that is why the
            // PRIMARY view moved emitters to the record march on 2026-08-06.
            // Reflections kept the retired estimator and therefore kept the
            // artifact — a reflection is the one place a user studies
            // pixel-for-pixel, so it showed up there first and worst.
            //
            // The record march carries no admission thresholds, so there is
            // no lattice to etch. §12.56's 10.96 ms was that march inlined in
            // the RESOLVE at full resolve res, dense; here it prices one
            // half-res kernel whose marching threads are only the mirror
            // pixels that resolved a hit. `__giHitRecordShadows = false`
            // returns to the cone for an A/B.
            const hitParams = hitShadows
              ? {
                  ...emitter,
                  recordShadowTrace: globalThis.__giHitRecordShadows === false
                    ? null
                    : (emitter.recordShadowTrace ?? null),
                  traceCutoffScale: Number.isFinite(Number(globalThis.__giHitEmitterTraceScale))
                    ? Number(globalThis.__giHitEmitterTraceScale)
                    : 24,
                  // ── §18.14: 4 m → 16 m (2026-08-25) ────────────────────────
                  //
                  // MEASURED, not guessed. The §18.13 colour probe read back
                  // each stage of this chain on the user's Bistro:
                  //   bvhColor  (raw hit albedo) rgb 170.5/170.5/170.5  x1.00
                  //   bvhRadiance (shaded hit)   rgb  67.1/101.1/ 73.5  x1.44
                  //   irradiance (diffuse field) rgb 182.2/191.5/208.3  x0.98
                  // The albedo going in is neutral and the diffuse field is
                  // neutral, so the green is created HERE, in the hit shading —
                  // and the scene's only chromatic light is a green shopfront
                  // neon. "All reflections are greenish", localised to one term.
                  //
                  // A 4 m cap means occluders further than 4 m from the hit
                  // point STOP OCCLUDING (this block's own header calls it "a
                  // soft, bounded leak, reflections only"). Bistro is a ~47 m
                  // street, so every reflected surface across the road took that
                  // neon unshadowed. The leak is bounded in the sense of not
                  // being infinite; it is not small.
                  //
                  // ⭐ RAISING IT IS NEARLY FREE, and that is why this is the
                  // right lever rather than damping the emitter: the march is
                  // `shadowTraceFn(..., maxT, float(32), ...)` — a FIXED 32
                  // steps. `maxT` sets step SIZE, not step COUNT. So reach costs
                  // precision, never time.
                  //
                  // 16 m covers a street without making each step so coarse that
                  // thin occluders fall between samples (16/32 = 0.5 m/step,
                  // about two GI cells at this scene's 1 m probe spacing).
                  // ⚠ Still a CONSTANT in metres, which this session has already
                  // been burned by twice (the emitter power gate, twice). The
                  // honest follow-up is to derive it from the GI volume extent,
                  // which GISystem knows and this kernel does not.
                  // `__giHitEmitterMarchCap` is the A/B.
                  maxTraceDistance: Number.isFinite(Number(globalThis.__giHitEmitterMarchCap))
                    ? Number(globalThis.__giHitEmitterMarchCap)
                    : 16,
                }
              : { ...emitter, shadowSample: () => float(1) };
            // Term 3 of 4.
            const emitterTerm = vec3(emitterDirectAt(hitParams, hitP, nFace, shadePoint, { rolled: globalThis.__giRolledDirect !== false }).irradiance).toVar();
            hitE.addAssign(termMask ? emitterTerm.mul(termMask.z) : emitterTerm);
          }
          if (bvhShade.lightSlots?.length) {
            // ── §18.16: THE SUN SHADOW AT A REFLECTION HIT IS A BVH RAY NOW
            // (2026-08-26, "many dark grid artifacts ... that mud is terrible
            // even on higher roughness") ────────────────────────────────────
            //
            // THE ARTIFACT. On the user's Sponza (one directional light at
            // intensity 30, mirror box at roughness 0 / metalness 1) every
            // reflected SUNLIT surface came back as dense black-and-white
            // salt-and-pepper: blown-white where the sun landed, near-black
            // one texel away, in short axis-aligned runs. Only the lit
            // regions carry it — the shadowed half of the same reflected
            // floor is smooth — which localises it to the visibility term of
            // the sun, and nothing else.
            //
            // THE MECHANISM WAS ALREADY WRITTEN DOWN, TWICE, AND ONLY HALF
            // APPLIED. `emitterSlotShadow`'s own note (giLight.js) records
            // that "the sphere trace's threshold admissions over the
            // voxel-quantized distance field ETCHED A LATTICE GRID ACROSS
            // RECEIVERS", and the emitter block directly above this one
            // records the same finding for reflections in so many words —
            // "the cone stamps a LATTICE OF BLACK CROSSES across every
            // reflected floor and wall". Both moved the EMITTER arm onto the
            // record march. The sun arm was added in the same round and kept
            // the retired estimator. That is what is being photographed.
            //
            // WHY A BVH RAY RATHER THAN THE RECORD MARCH. The reflection ray
            // that produced this hit was ALREADY traced through the static
            // BVH8 (§17 R7a) — the exact triangles are right there, the
            // traversal is any-hit (half the work of the closest-hit the
            // prepass ran), and visibility is a boolean question. It is also
            // CHEAPER than what it replaces: the cone is 32 fixed steps, each
            // paying the occupancy oracle's ~27 near-field fetches. And it
            // removes the 6 m reach cap with it — a BVH ray's cost is
            // traversal depth, not distance, so a reflected wall across the
            // atrium finally shadows the floor it stands on.
            //
            // The dynamic set unions in on top (bone capsules, spawned
            // props), so a character standing in the sun casts a shadow in
            // the mirror the same way its reflection appears in it.
            //
            // `__giHitBvhShadows = false` returns the whole light arm to the
            // occupancy cone for an A/B; `__giHitDynShadows = false` drops
            // just the dynamic union.
            // ── THE MAPPED SUN IS A TEXEL, SO THE BVH PAIR IS NOT EMITTED ──
            //
            // MEASURED, Sponza at ultra, resolve 931x772: the static+dynamic
            // any-hit pair below costs `bvhHitShade` **3.57 ms against 1.22**
            // — ~19 % of GI's whole budget — to answer a question the frame has
            // ALREADY answered by rasterising the sun into a 4096² shadow map.
            //
            // ⚠ IT HAS TO BE A BUILD-TIME SWAP, NOT A RUNTIME `If`. A kernel's
            // register allocation is set by the code PRESENT, not by how much
            // of it executes: gating the trace behind a condition was measured
            // (admission 24 -> 4) at 3.53 -> 3.59 ms, i.e. nothing. Only the
            // pair being ABSENT recovers the occupancy.
            const sunMapShadows = hitShadows && !!sunShadow;
            const bvhLightShadows = staticOcclude && globalThis.__giHitBvhShadows !== false && !sunMapShadows;
            // Reach is derived, never a constant in metres (this module has
            // been burned by hard-coded world distances twice — the emitter
            // power gate and the 4 m march cap). `shadowReach` is the GI
            // volume's own diagonal AS A NODE (§13 F1: `world.size.length()`
            // baked to a JS number freezes the pre-refit medium into WGSL),
            // passed by GISystem; the fallback only exists for callers that
            // do not know one.
            const sunReach = float(shadowReach ?? 64).toVar();
            const lightShadowFn = hitShadows && bvhLightShadows
              ? (dirTo, isDir, pointDist, cosH) => {
                  // tMin stays TINY on purpose. `shadePoint` is already lifted
                  // a full `normalOffset` (>= 0.1 m — a GI cell) along the
                  // hit's face normal, and a planar triangle cannot be hit
                  // again from above itself, so there is no acne to bias away
                  // from. A slope-scaled tMin on top of that lift would be a
                  // METRE at grazing sun angles and would delete contact
                  // shadows wholesale — the opposite failure, and the harder
                  // one to see.
                  const tMin = float(1e-3);
                  // A point light's distance is measured from `hitP`, the ray
                  // leaves from `shadePoint`: stop short by the lift so the
                  // lamp's own shell is never the blocker.
                  const near = pointDist.sub(float(normalOffset).mul(2)).max(tMin.mul(2)).toVar();
                  const maxT = mix(near, sunReach, isDir).toVar();
                  const st = staticOcclude(shadePoint, dirTo, tMin, maxT);
                  const vis = float(1).toVar();
                  if (st) vis.assign(select(st.x.greaterThanEqual(0), float(0), float(1)));
                  if (dynOcclude) {
                    const dh = dynOcclude(shadePoint, dirTo, tMin, maxT, hitP);
                    if (dh) vis.mulAssign(float(dh).clamp(0, 1).oneMinus());
                  }
                  return vis;
                }
              : hitShadows && (sunMapShadows || emitter?.shadowTraceFn)
                ? (dirTo, isDir, pointDist, cosH, slotIndex) => {
                    // ── THE MAPPED SUN IS READ, NOT TRACED (2026-09-09) ──────
                    //
                    // `slotIndex` is the 5th argument `analyticDirectAt` now
                    // passes — a build-time constant on the unrolled path, the
                    // Loop's own node on the rolled one. Without it there is no
                    // way to tell WHICH light is being asked about, and handing
                    // a second directional light the sun's map would be simply
                    // wrong.
                    //
                    // −1 from the sampler means "no cascade covers this hit",
                    // and then the cone below stands exactly as it did. That
                    // fallback is the whole reason it returns −1 rather than 0.
                    const vis = float(1).toVar();
                    if (sunMapShadows && slotIndex) {
                      If(slotIndex.equal(sunShadow.slot).and(sunShadow.count.greaterThan(0)), () => {
                        const mapped = float(sunShadowVisibilityAt(sunShadow, shadePoint, nFace)).toVar();
                        If(mapped.greaterThanEqual(0), () => { vis.assign(mapped); });
                      });
                    }
                    if (!emitter?.shadowTraceFn) return vis;
                    const cap = float(6);
                    const maxT = mix(pointDist.sub(0.3), cap, isDir).min(cap).max(0).toVar();
                    // The cone answers for everything the map did not: every
                    // punctual light, and any sun hit outside the cascades.
                    // ⚠ 32 IS A LITERAL AND STAYS ONE. A hatch here was swept
                    // 32/16/8 and read flat (1.20-1.24 ms), then removed — and
                    // removing it left `float(marchSteps)` referring to a
                    // deleted const, a ReferenceError that only stayed quiet
                    // because this branch was not being emitted. Instrumentation
                    // on a hot path must not be able to break the thing it
                    // measures; this is the second time that exact shape has
                    // bitten this module.
                    const coned = float(emitter.shadowTraceFn(
                      shadePoint, dirTo, maxT, float(32), cosH,
                      vec3(0), float(0), null,
                    )).toVar();
                    if (sunMapShadows && slotIndex) {
                      If(slotIndex.notEqual(sunShadow.slot).or(sunShadow.count.lessThanEqual(0)), () => {
                        vis.assign(coned);
                      });
                    } else {
                      vis.assign(coned);
                    }
                    return vis;
                  }
                : null;
            // ⭐ ONE-SIDED (§18.10, 2026-08-25). `nFace` was face-forwarded
            // against the reflected ray above, so this is a SURFACE, not a
            // field cell — see analyticDirectAt's `oneSided` note. With the
            // field-cell `abs()`, every reflected surface facing AWAY from the
            // sun took the sun's FULL irradiance while the same surface
            // rendered directly took zero: the user's "very reflective
            // materials ignore lighting, appearing too bright".
            // Term 4 of 4.
            const analyticTerm = vec3(analyticDirectAt(bvhShade.lightSlots, hitP, nFace, lightShadowFn, true, { rolled: globalThis.__giRolledDirect !== false })).toVar();
            if (causticGain) analyticTerm.mulAssign(vec3(causticGain(shadePoint, nFace)));
            hitE.addAssign(termMask ? analyticTerm.mul(termMask.w) : analyticTerm);
          }
          // ×intensity to match the convention of the term this is mixed WITH
          // on the material side: `reflectedOut` (the cascade radiance lookup)
          // is stored pre-multiplied too. Mixing two terms on different
          // intensity conventions would make the GI intensity slider change
          // reflections' BLEND, not just their level.
          bvhOut.assign(albedoTexel.xyz.mul(hitE).div(Math.PI).mul(intensity));
          // §16 R3b — the capture's hue-preserving luminance cap, applied to
          // the live hit shade too (the two consumers of this formula are
          // documented as IDENTICAL and were not: the capture clamps at 6,
          // this path was unbounded — the ultra "blown-out emitter direct at
          // hits" class). `__giHitLumCap` overrides at build; <= 0 disables.
          {
            const capRaw = Number(globalThis.__giHitLumCap);
            const hitCap = Number.isFinite(capRaw) ? capRaw : 6;
            if (hitCap > 0) {
              const lum = bvhOut.x.mul(0.2126).add(bvhOut.y.mul(0.7152)).add(bvhOut.z.mul(0.0722)).toVar();
              bvhOut.mulAssign(float(hitCap).div(lum.max(hitCap)));
            }
          }
          bvhValid.assign(1);
        });
        // §12.71b v3: the prepass's TRACED-MISS marker (-2, vs -1 for a
        // masked skip) rides through as a NEGATIVE alpha — giLight's
        // env-on-miss term keys on it, and its exact-hit blend clamps, so
        // the encoding is invisible to every other consumer.
        If(hitTexel.x.lessThan(-1.5), () => {
          bvhValid.assign(-1);
        });
      }
    });
    // The RAW texture feeds the temporal filter. Replicate to the sampled
    // target until explicitly disabled for an A/B: that is the fail-open image
    // while the async filter pipeline is compiling (or if it never lands).
    if (rawCopy) textureStore(rawCopy, coord, vec4(bvhOut, bvhValid));
    if (!rawCopy || replicateTarget) textureStore(bvhShade.target, coord, vec4(bvhOut, bvhValid));
  })().compute(width * height);

  return { compute, widthU };
}

/**
 * SCREEN-SPACE AMBIENT OCCLUSION, as its own pass — the successor to the
 * resolve's inlined occupancy-oracle ladder (2026-08-21).
 *
 * The oracle ladder was the right idea priced out of existence twice over:
 * §13.7f measured a build that NEVER FINISHED compiling with it on (~200
 * occupancy fetches inlined per resolve pixel — §13.14's "WGSL size buys
 * compile seconds", bought four times), and §13.7d showed it structurally
 * cannot darken below its own 2-voxel self-surface allowance (0.7 m at
 * default cells) — which is exactly the contact scale AO exists for.
 *
 * This pass reads the gbuffer instead: THREE golden-spiral rings of WORLD
 * POSITION taps around each pixel (22 total — a WIDE ring at the authored
 * radius for corner and crevice shading, a CONTACT ring at a quarter of it
 * whose own falloff normalization keeps centimetre-scale darkening crisp
 * under feet and furniture, and a MICRO ring pinned at a fixed few PIXELS
 * that is the only one able to see two meshes touching at distance — see its
 * note below), Alchemy-style horizon estimate against the camera-faced
 * normal. The three rings combine by the multiplicative union
 * 1-(1-w)(1-c)(1-m) — each deepens what the others cannot resolve, bounded by
 * 1 — and a ^1.5 curve on the result deepens
 * creases without touching open surfaces. World-space vectors from exact
 * positions, so the self-surface allowance problem does not exist here —
 * contact darkening starts at centimetres. The classic screen-space blind
 * spot (off-screen occluders) is accepted: this term only ever REMOVES
 * light from the indirect estimate, and a missed occluder degrades to
 * exactly the pre-AO image.
 *
 * The kernel is ~30 lines of WGSL and two texture bindings — the compile
 * cost that killed the oracle simply is not here. The IGN rotation is a pure
 * function of the pixel coordinate, so the pattern is STABLE across frames:
 * no temporal noise, no filter debt. It modulates the INDIRECT term only
 * (the resolve applies it before the direct terms are added), same contract
 * as the ladder it replaces.
 *
 * `strength`/`radius` are the same live uniforms the old block bound
 * (`__giAoOverride` keeps working); `projScale` converts the world radius to
 * a screen tap radius (0.5 · resolveHeight · proj[1][1], written per frame
 * beside the resolve camera).
 */
export function createGiAoPass({ gbuffer, width, height, cameraPosition, projScale, strength, radius }) {
  const target = new THREE.StorageTexture(width, height);
  target.name = "giAo";
  // Only mip 0 is ever sampled. StorageTexture inherits automatic mip
  // generation; leaving it on silently builds an unused chain every frame.
  target.generateMipmaps = false;
  const widthU = uniform(width, "uint");
  const positionNode = texture(gbuffer.position);
  const normalNode = texture(gbuffer.normal);
  // The old 10/6/6 pattern left visible angular sectors around round props:
  // a stable per-pixel spiral makes those sectors read as large AO blocks.
  // These counts keep the same estimator/radii but provide enough angular
  // coverage for a cylinder base without temporal dithering.
  const TAPS_WIDE = 20;
  const TAPS_CONTACT = 12;
  // ── THE MICRO RING (2026-08-25, "very weak AO, almost invisible BETWEEN
  // MESHES — possibly it works only on larger meshes") ──────────────────────
  //
  // That report names a RESOLUTION limit, not a strength one, and turning
  // strength up cannot reach it. Both rings above are anchored in WORLD space
  // (`aoRadius` 0.5 m, projected to pixels), and a ring of N taps spread
  // √-uniform over radius r puts its INNERMOST tap at r·√(0.5/N) — so the
  // contact ring's 6 taps at r = 0.25·pxRad never sample closer than ~0.29 r.
  //
  // Work it through at a normal viewing distance (projScale ≈ 964 for a
  // 900-row resolve at 50°, dist 10 m): pxRad = 964·0.5/10 = 48 px, contact
  // pxRadC = 12 px, innermost contact tap ≈ 3.5 px. A 2 cm gap between two
  // touching props subtends 964·0.02/10 = 1.9 px. EVERY tap in both rings
  // steps straight over it. A large mesh, by contrast, fills a big share of
  // the 12-48 px disc and reads darkening normally — which is precisely
  // "it works only on larger meshes".
  //
  // The fix is a ring pinned in SCREEN space rather than world space. Two
  // surfaces that touch are adjacent IN PIXELS at every distance — that is the
  // one invariant a world-anchored radius throws away — so a fixed few-pixel
  // ring straddles the contact whether it is 2 cm at 10 m or 2 m at 1 km.
  // Its falloff still normalizes in WORLD units (`effRM` below), which is what
  // keeps it an occlusion term and not an edge detector: a tap 2 px away that
  // is 20 m behind is a silhouette against the background, and its falloff
  // sends it to exactly 0.
  const TAPS_MICRO = 10;
  const MICRO_PX = 3;
  const compute = Fn(() => {
    const px = instanceIndex.mod(widthU);
    const py = instanceIndex.div(widthU);
    const coord = ivec2(px.toInt(), py.toInt());
    const ao = float(1).toVar();
    const g0 = positionNode.load(coord).toVar();
    // BOTH channels, not just position.w — srcSystem's readPixel records the
    // measured lesson: w alone admits sky pixels whose normal is ZERO, and
    // `normalize(0)` here would write NaN into a texture the resolve
    // multiplies into every indirect pixel.
    const nRaw = normalNode.load(coord).xyz.toVar();
    If(g0.w.greaterThan(0.5).and(nRaw.dot(nRaw).greaterThan(0.25)), () => {
      const P = g0.xyz.toVar();
      // The same camera-facing flip the resolve and readPixel apply — a
      // double-sided wall seen from inside must occlude against the inside.
      const rawN = nRaw.normalize().toVar();
      const facing = step(0, rawN.dot(vec3(cameraPosition).sub(P))).mul(2).sub(1);
      const N = rawN.mul(facing).toVar();
      const dist = vec3(cameraPosition).sub(P).length().max(1e-3).toVar();
      const R = float(radius).max(0.05).toVar();
      // World radius → screen taps. Clamped low so distant surfaces keep a
      // usable footprint (AO fades there by the falloff, not by starvation)
      // and high so near surfaces don't march across the whole frame.
      // Max 128 since 2026-08-21 ("make AO realistic-notable"): at 64 the
      // clamp bound at ROOM distances on every real resolve — a 473-row
      // play viewport reached 0.31 m of the authored 0.8 at 2 m, so corner
      // and crevice shading simply never happened. 128 restores the
      // authored reach through typical rooms; the falloff renormalization
      // below keeps whatever still clamps at full strength.
      const pxRad = float(projScale).mul(R).div(dist).clamp(3, 128).toVar();
      // THE EFFECTIVE RADIUS (2026-08-21 — "AO is quite weak"): at editor
      // resolution the pixel clamp binds hard up close (931-px resolve,
      // 0.6 m at 4 m wants 149 px), so the taps actually span a fraction of
      // the authored radius — and normalizing the falloff against the FULL
      // radius then under-reported every one of them. Renormalizing against
      // the span the taps actually cover keeps near-field contact at full
      // strength wherever the clamp bites; unclamped, effR == R exactly.
      const effR = pxRad.mul(dist).div(float(projScale).max(1e-3)).toVar();
      // Interleaved gradient noise — per-pixel spiral rotation, constant in
      // time (deliberately: a temporally jittered AO needs a temporal filter;
      // a stable pattern needs none).
      const ign = fract(
        fract(px.toFloat().mul(0.06711056).add(py.toFloat().mul(0.00583715))).mul(52.9829189),
      ).toVar();
      // THE CONTACT RING: a quarter of the wide radius with its OWN falloff
      // normalization — the same renormalization argument as effR, applied
      // at the scale where feet, chair legs and prop bases occlude. Min 2 px
      // so it never collapses onto the centre texel.
      const pxRadC = pxRad.mul(0.25).max(2).toVar();
      const effRC = pxRadC.mul(dist).div(float(projScale).max(1e-3)).toVar();
      // THE MICRO RING's radius is a CONSTANT IN PIXELS (see the note above) —
      // deliberately not derived from `pxRad`, because deriving it from the
      // world radius is the exact dependency that makes contacts invisible at
      // distance. Its world falloff is the span those pixels actually cover at
      // this depth, floored so the divide stays finite when the camera is
      // almost on the surface.
      const pxRadM = float(MICRO_PX).toVar();
      const effRM = pxRadM.mul(dist).div(float(projScale).max(1e-3)).max(1e-3).toVar();
      const occW = float(0).toVar();
      const occC = float(0).toVar();
      const occM = float(0).toVar();
      // One ring: golden-angle spiral (even angular coverage at any tap
      // count, radii spread √-uniform over the disc), Alchemy-style
      // occlusion ∝ cosine of the tap above the tangent plane, faded over
      // that ring's own effective radius. The 0.1 cosine bias eats
      // self-plane noise and gentle curvature; a tap on this pixel's own
      // flat surface reads exactly 0 by construction. `phase` decorrelates
      // the two rings' spirals.
      const ring = (taps, radPx, radWorld, phase, acc) => {
        for (let k = 0; k < taps; k++) {
          const ang = ign.mul(2 * Math.PI).add(k * 2.39996323 + phase);
          // ── THE RADIUS IS JITTERED TOO (2026-08-26) ─────────────────────
          //
          // The IGN rotation randomized the ANGLE and left the RADII a fixed
          // ladder — `sqrt((k + 0.5) / taps)` is the same 20 distances at
          // every pixel in the frame. On a curved surface each of those
          // distances crosses the geometry at its own point, so the estimate
          // steps 20 times as the surface turns and the steps line up into
          // concentric contours: structured error, identical in every pixel,
          // which no spatial filter can average away because every pixel has
          // the SAME error.
          //
          // `(k + ign) / taps` keeps the stratification (each tap still owns
          // its own annulus, so coverage is unchanged) while making the offset
          // inside the annulus per-pixel. That converts the contours into
          // noise — which is a strictly better failure, because the denoiser
          // behind this pass removes noise and cannot remove a contour.
          const rad = radPx.mul(ign.add(k).div(taps).sqrt());
          const sc = ivec2(
            px.toFloat().add(cos(ang).mul(rad)).toInt().clamp(0, width - 1),
            py.toFloat().add(sin(ang).mul(rad)).toInt().clamp(0, height - 1),
          ).toVar();
          const gs = positionNode.load(sc).toVar();
          const D = gs.xyz.sub(P).toVar();
          const dLen = D.length().max(1e-4).toVar();
          const fall = float(1).sub(dLen.div(radWorld)).clamp(0, 1);
          // Bias 0.1 → 0.03 (2026-08-24, "can't see any notable effect"):
          // 0.1 also ate the GRAZING taps that define a contact — a floor
          // pixel at a column base sees the wall at a shallow D·N, exactly
          // the geometry this pass exists for. 0.03 still zeroes true
          // self-plane taps (their cosine is 0 by construction).
          const cosA = D.div(dLen).dot(N).sub(0.03).max(0);
          acc.addAssign(select(gs.w.greaterThan(0.5), cosA.mul(fall), float(0)));
        }
      };
      ring(TAPS_WIDE, pxRad, effR, 0, occW);
      ring(TAPS_CONTACT, pxRadC, effRC, 1.2, occC);
      // Third phase offset so all three spirals decorrelate; without it the
      // micro ring would sample the same angular directions as the wide one
      // and simply re-report its innermost taps.
      ring(TAPS_MICRO, pxRadM, effRM, 2.4, occM);
      // ×3, and the rings UNION multiplicatively (2026-08-24, the "no
      // notable visual effect" report — both fixes measured against the
      // ring math, not guessed):
      // · ×2 assumed a covering hemisphere averages ~0.5 per tap, but the
      //   product cosA·fall averages ~1/3 over the √-uniform disc even at
      //   full coverage, so a fully enclosed crevice topped out at
      //   obscurance ≈ 0.6·cos̄ ≈ 0.3 — AO could NEVER read dark. ×3 is the
      //   correct renormalization for the linear-falloff disc mean.
      // · max() discarded the contact ring wholesale: each ring normalizes
      //   against its OWN radius, so at a real contact both report the same
      //   fraction and max() returns the wide (lattice-scale) wash — the
      //   6 contact taps were dead weight at exactly the pixels they were
      //   added for. The multiplicative union 1-(1-w)(1-c) keeps the wide
      //   ring's mid-scale term AND lets the contact ring deepen contacts,
      //   bounded by 1 with no double-count blow-up.
      // Wide ×2.5 vs contact ×3 (2026-08-24, second pass — the first shipped
      // ×3 on BOTH and the user's very next look was "started to look bad":
      // the broad ring's doubled obscurance multiplied into shadowed-side
      // indirect read as murk, not contact). The contact ring keeps the full
      // renormalization — crispness lives there; the wide ring stays the
      // gentle mid-scale term it always was, just no longer discarded.
      const obscW = occW.div(TAPS_WIDE).mul(2.5).clamp(0, 1);
      const obscC = occC.div(TAPS_CONTACT).mul(3).clamp(0, 1);
      // Same ×3 renormalization as the contact ring (the linear-falloff disc
      // mean is ~1/3 even at full coverage), and it joins the SAME
      // multiplicative union — bounded by 1, so three rings agreeing on a deep
      // crevice saturate instead of compounding into a black hole.
      const obscM = occM.div(TAPS_MICRO).mul(3).clamp(0, 1);
      const union = float(1).sub(
        float(1).sub(obscW).mul(float(1).sub(obscC)).mul(float(1).sub(obscM)),
      );
      const obscurance = union.mul(float(strength)).clamp(0, 1);
      ao.assign(float(1).sub(obscurance).pow(1.5));
    });
    textureStore(target, coord, vec4(ao, 0, 0, 1));
  })().compute(width * height);

  return { compute, target, node: texture(target), widthU, width, height };
}

/**
 * RAY-TRACED AMBIENT OCCLUSION — AO FROM THE CASCADE'S OWN TRACER (2026-08-26).
 *
 * Replaces BOTH previous estimators, on a user directive ("abandon vxao and
 * gtao, for gi ao, reuse our Radiance Cascade traces"). What each of them was
 * and why neither survives:
 *
 *   · `createGiAoPass` — three screen-space spirals over the gbuffer. It can
 *     only see what is ON SCREEN and it estimates occlusion from a depth
 *     buffer, which is a heightfield and not the scene. 4.31 ms measured.
 *   · `createGiVxaoPass` — six 60-degree cones through the occupancy density
 *     pyramid. Correct in world space and blind below a level-1 cell, because
 *     that is the finest medium it has. **10.94 ms measured — the single most
 *     expensive pass in the whole SRC chain.**
 *
 * Both are approximations of one integral that this module can now evaluate
 * DIRECTLY: the cascade's own ray budget already runs against a masked static
 * BVH8 of exact world triangles (`dynamicObjects.traceStaticBvh`), plus the
 * exact dynamic set. So AO stops being a separate estimator with its own
 * failure modes and becomes the same visibility question the transport already
 * answers, asked per PIXEL instead of per probe.
 *
 * ══ WHY THIS IS NOT THE SAME AS GATHERING THE CASCADE'S STORED VISIBILITY ══
 *
 * Every c0 bin already stores `BIN_T`, the fraction of rays through that
 * direction that passed unblocked, and the gather's irradiance was integrated
 * from those same rays — so the occlusion is ALREADY in the gather, at PROBE
 * LATTICE resolution (0.70 m on the user's Sponza). Re-deriving AO from that
 * field and multiplying it back in would add no detail and darken twice. The
 * whole reason an AO term exists here is the sub-lattice band the probe grid
 * cannot resolve, and only a per-PIXEL query reaches it. That is this pass.
 *
 * ══ THE RADIUS IS DERIVED FROM THE CASCADE, NOT AUTHORED ═══════════════════
 *
 * `intervalBoundary(0, 0, s0) = s0 · R0_OVER_S0` is the distance cascade 0
 * resolves per probe. Four of those is the reach — which lands at 2.24 m on
 * the user's Sponza, within 12% of the 2.0 m the retired VXAO shipped, except
 * that this one is a function of what the scene measures rather than a metre
 * constant. That is the standing rule about world-unit constants, applied to
 * the one number this pass has.
 *
 * ══ WHAT MAKES FOUR RAYS ENOUGH ════════════════════════════════════════════
 *
 * · COSINE-WEIGHTED sampling, so `1 - mean(occluded)` IS the cosine-weighted
 *   visibility integral. No cosine factor, no bias term, no falloff curve
 *   standing in for one.
 * · STRATIFIED: ray k draws its radius from `[k/N, (k+1)/N)`, so the rays
 *   cannot clump. Only the offset inside each stratum is per-pixel.
 * · A STATIC pattern (no `frame` term). The same argument the retired screen
 *   pass made and then failed to honour: a per-pixel rotation is a per-pixel
 *   estimator, and its disagreement is spatial noise. The difference is that
 *   this pass is FOLLOWED by the separable cross-bilateral, which turns a
 *   5x5 neighbourhood of decorrelated 4-ray estimates into ~100 samples. A
 *   temporally-animated pattern would need a history buffer to pay off and
 *   would shimmer without one.
 * · A STOCHASTIC PER-RAY RANGE in [0.55R, R]. `anyHit` returns the first
 *   blocker rather than the nearest, so its `t` cannot drive an exact falloff
 *   curve — but jittering the ray's own tMax makes the ENSEMBLE a smooth ramp
 *   over that band, in expectation exactly. Free, and it is what stops a hard
 *   "AO ends here" ring on large surfaces.
 *
 * ══ THE BIAS IS SLOPE-SCALED, AND IT HAS TO BE ═════════════════════════════
 *
 * Cosine sampling puts most rays near the normal but the tail arbitrarily
 * close to the tangent plane, where an interpolated shading normal and the
 * true triangle diverge most — the classic RTAO dark-banding artifact. `d·N`
 * is `sqrt(1-u1)`, already computed for the direction, so scaling the offset
 * by `1/max(d·N, 0.15)` costs one divide and removes it. Against exact
 * triangles the offset is millimetres, not the 1.5 voxels a DDA needs (see
 * the static-BVH arm's note in GISystem: that inherited voxel bias was the
 * measured cause of "holes in the shadows").
 */
export function createGiRtaoPass({
  gbuffer,
  width,
  height,
  resolveWidth,
  resolveHeight,
  cameraPosition,
  strength,
  radius,
  bias,
  rays = 4,
  traceStatic,
  traceDynamic = null,
  target = null,
}) {
  // HALF FLOAT WHEN THE CALLER OWNS THE TARGET. An 8-bit AO history cannot
  // hold an exponential blend: at weight 0.92 one frame moves the value by
  // 8% of the gap, and below ~1/255 of a step the accumulator simply stops
  // — the classic "temporal filter that converges to a quantized plateau".
  if (!target) {
    target = new THREE.StorageTexture(width, height);
    target.name = "giRtaoRaw";
    target.type = THREE.HalfFloatType;
    target.generateMipmaps = false;
    target.minFilter = THREE.LinearFilter;
    target.magFilter = THREE.LinearFilter;
  }

  const widthU = uniform(width, "uint");
  const positionNode = texture(gbuffer.position);
  const normalNode = texture(gbuffer.normal);
  const sx = resolveWidth / width;
  const sy = resolveHeight / height;
  const RAYS = Math.max(1, Math.min(16, Math.round(rays)));
  /** Where the stochastic range window opens, as a fraction of the radius. */
  const RANGE_FADE = 0.55;

  const compute = Fn(() => {
    const px = instanceIndex.mod(widthU);
    const py = instanceIndex.div(widthU);
    const sourceCoord = ivec2(
      px.toFloat().add(0.5).mul(sx).toInt().clamp(0, resolveWidth - 1),
      py.toFloat().add(0.5).mul(sy).toInt().clamp(0, resolveHeight - 1),
    ).toVar();
    const g0 = positionNode.load(sourceCoord).toVar();
    const nRaw = normalNode.load(sourceCoord).xyz.toVar();
    const ao = float(1).toVar();

    // Both channels, not just `position.w`: a sky texel's normal is ZERO and
    // `normalize(0)` would write NaN into a texture the resolve multiplies
    // into every indirect pixel.
    If(g0.w.greaterThan(0.5).and(nRaw.dot(nRaw).greaterThan(0.25)), () => {
      const P = g0.xyz.toVar();
      const rawN = nRaw.normalize().toVar();
      // Camera-faced, as every other consumer of this gbuffer is: a
      // double-sided wall seen from inside must be occluded against the
      // inside.
      const facing = step(0, rawN.dot(vec3(cameraPosition).sub(P))).mul(2).sub(1);
      const N = rawN.mul(facing).toVar();
      // Duff/Frisvad branchless ONB — `sgn + N.z` cannot vanish, so it is
      // continuous everywhere a `select` on an up-vector is not (and it
      // therefore cannot print a seam where one axis dominates).
      const sgn = select(N.z.greaterThanEqual(0), float(1), float(-1)).toVar();
      const oa = float(-1).div(sgn.add(N.z)).toVar();
      const ob = N.x.mul(N.y).mul(oa).toVar();
      const T = vec3(
        N.x.mul(N.x).mul(oa).mul(sgn).add(1),
        ob.mul(sgn),
        N.x.mul(sgn).negate(),
      ).toVar();
      const B = vec3(ob, N.y.mul(N.y).mul(oa).add(sgn), N.y.negate()).toVar();
      const R = float(radius).max(1e-3).toVar();
      // Two decorrelated interleaved-gradient channels — same lattice,
      // shifted phase, which is enough independence for a 2D sample.
      const ignBase = fract(
        fract(px.toFloat().mul(0.06711056).add(py.toFloat().mul(0.00583715))).mul(52.9829189),
      ).toVar();
      const ign2Base = fract(
        fract(px.toFloat().add(37).mul(0.06711056).add(py.toFloat().add(17).mul(0.00583715)))
          .mul(52.9829189),
      ).toVar();
      // ⛔ THE PATTERN IS FROZEN, AND IT STAYS FROZEN (user, 2026-08-26:
      // "temporal is bad, remove it — we are a game engine, things move a
      // lot, temporal does not work"). Animating it per frame and integrating
      // with a reprojected history was built and reverted: it is the standard
      // RTAO answer and it is the wrong one HERE, because reprojection is only
      // valid where the world stood still, and in a game the world is the
      // thing that moves. A frozen pattern's error is spatial noise, which the
      // separable bilateral removes; an animated one's error is ghosting,
      // which nothing downstream can.
      const ign = ignBase;
      const ign2 = ign2Base;
      // ── INTERLEAVED 2x2 STRATIFICATION (2026-08-26) ─────────────────────
      //
      // A ray costs ~10 ns here — measured, and it is the whole budget: AO on
      // vs off is 18.68 vs 11.33 ms for 714k rays, and neither the radius nor
      // the dynamic-set trace moved it. So the only lever left is how much
      // each ray is WORTH, and the classic answer costs nothing: give the four
      // pixels of every 2x2 quad four DIFFERENT strata of the hemisphere.
      //
      // Any filter whose support spans the quad (radius >= 1 does) then
      // reconstructs a 4x-stratified estimate from 1 ray per pixel. Not "4
      // random samples" — 4 samples that provably cannot land in each other's
      // annulus, which is strictly better than 4 independent ones.
      //
      // ⚠ IT MUST NOT BE THE ONLY DECORRELATION. The quad index is a fixed
      // 2x2 pattern, so on its own it would print a 2x2 grid over the whole
      // frame; `ign` still jitters INSIDE each stratum, per pixel, so the grid
      // has no phase to align on.
      const quad = px.bitAnd(uint(1)).add(py.bitAnd(uint(1)).mul(uint(2))).toFloat().toVar();
      const STRATA = RAYS * 4;
      const occ = float(0).toVar();
      for (let k = 0; k < RAYS; k++) {
        // Stratum (quad*RAYS + k) of STRATA, jittered inside itself.
        const u1 = quad.mul(RAYS).add(k).add(ign).div(STRATA).clamp(0, 0.9999).toVar();
        // The azimuth gets the quad too, a quarter turn apart, so two pixels
        // in the same quad never sample the same DIRECTION either.
        const u2 = fract(ign2.add(quad.mul(0.25)).add(k * 0.618033988749895)).toVar();
        const r = u1.sqrt().toVar();
        // d·N for a cosine-weighted sample, kept because the slope-scaled
        // bias below needs exactly this number.
        const cosD = u1.oneMinus().sqrt().toVar();
        const phi = u2.mul(Math.PI * 2).toVar();
        const dir = T.mul(r.mul(cos(phi))).add(B.mul(r.mul(sin(phi)))).add(N.mul(cosD)).toVar();
        const b = float(bias).div(cosD.max(0.15)).toVar();
        const origin = P.add(N.mul(b)).toVar();
        // Stochastic range — see the header. `u2` is already spent on the
        // azimuth, so this walks its own golden-ratio sequence.
        const tMax = R.mul(mix(
          float(RANGE_FADE), float(1),
          fract(ign.add(quad.mul(0.17)).add(k * 0.754877666246693)),
        )).toVar();
        const hit = float(0).toVar();
        const st = traceStatic(origin, dir, b, tMax);
        if (st) hit.assign(select(st.x.greaterThanEqual(0), float(1), float(0)));
        if (traceDynamic) {
          const dyn = traceDynamic(origin, dir, b, tMax, P);
          if (dyn) hit.assign(hit.max(dyn));
        }
        occ.addAssign(hit);
      }
      ao.assign(mix(float(1), occ.div(RAYS).oneMinus().clamp(0, 1), float(strength).clamp(0, 1)));
    });

    textureStore(target, ivec2(px.toInt(), py.toInt()), vec4(ao, 0, 0, 1));
  })().compute(width * height);

  compute.__giPassName = "rtao";
  return { compute, target, node: texture(target), widthU, width, height, rays: RAYS };
}

/**
 * ⭐ GTAO — GROUND TRUTH AMBIENT OCCLUSION (2026-08-26, user: "could we get
 * back to GTAO in our GI AO solution? just make it right and good").
 *
 * WHAT "GROUND TRUTH" ACTUALLY MEANS HERE, because the name is the reason to
 * prefer it and it is routinely read as a marketing word. Every other AO this
 * module has shipped estimated occlusion with a HEURISTIC — count the rays
 * that hit (RTAO), accumulate density along a cone (VXAO), sum an
 * artist-shaped falloff per tap (the old spirals). GTAO instead SOLVES the
 * cosine-weighted visibility integral in closed form over the horizon angles
 * it measures (Jimenez et al., "Practical Realtime Strategies for Accurate
 * Indirect Occlusion", SIGGRAPH 2016). Given the same horizons, its answer is
 * the analytically correct one — no falloff curve to tune, no strength that
 * secretly means "how wrong am I willing to be". That is why this term has no
 * knobs, and it is the reason to run it in a module whose standing rule is
 * that GI has three properties.
 *
 * THE INTEGRAL, per slice, so the code below reads as maths:
 *
 *   A slice is the plane through the view vector V and one screen-space
 *   direction ω. Marching ω left and right and keeping the largest
 *   cos(angle to V) on each side gives the two HORIZON angles h₀, h₁ that
 *   bound the unoccluded arc in that plane. Projecting the surface normal
 *   into the same plane gives its in-plane angle γ and its length |n| (the
 *   share of the hemisphere this slice is entitled to). The cosine-weighted
 *   visibility of that arc is then, exactly,
 *
 *     ¼·|n|·Σ_{h ∈ {h₀,h₁}} ( cos γ + 2·h·sin γ − cos(2h − γ) )
 *
 *   and AO is the mean over slices. `cos γ` is `cosNorm` below and is never
 *   recomputed from γ — γ is derived FROM it by an arccos.
 *
 * WHY IT COMES BACK AFTER THE RAY-TRACED ARM. That arm is not wrong: it is
 * world-space correct and it sees off-screen geometry. But its cost is the
 * rays and only the rays (measured: ~10 ns each, and neither the reach nor
 * the dynamic-set traversal moved it), so the whole budget bought ONE ray per
 * pixel plus a 7×7 filter to hide the variance — and one ray is a binary
 * sample of a continuous integral. A GTAO slice is not a sample of anything:
 * it reads a horizon, the EXTREME over its entire march, and integrates it in
 * closed form. Three slices over 24 gbuffer loads therefore carry far more of
 * the answer than one ray does, for less, and they produce a smooth field
 * rather than a denoised one.
 *
 * ⚠ THE TRADE IS REAL AND IT IS SCREEN-SPACE: an occluder outside the frustum,
 * or hidden behind the surface it should darken, does not exist to this pass.
 * That is acceptable *here specifically* and nowhere else — the resolve
 * multiplies this factor into the GATHER term only, and the cascade's own
 * BIN_T visibility already carries every world-space blocker at probe-lattice
 * resolution (0.70 m on the user's Sponza). The whole job of an AO term in
 * this module is the SUB-LATTICE band, and that band is by construction
 * within a few pixels of the receiving pixel — exactly where a depth buffer
 * is a faithful description of the world. `__giAoRaytraced = true` restores
 * the ray-traced arm for an A/B.
 *
 * ⛔ NO TEMPORAL. Standing user directive, and GTAO normally ships WITH a
 * 6-frame temporal rotation — that half is deliberately not taken. The
 * cheaper tiers use Jimenez's 4×4 SPATIAL idea (16 slice rotations × 4 step
 * offsets over a 4×4 pixel tile), jittered inside each cell and reconstructed
 * by the existing separable bilateral. Ultra instead evaluates five centred
 * slices at every full-resolution pixel and keeps only the four stable
 * radial strata across neighbours. Its angular error is smooth quadrature
 * error, while the filter resolves the radial phases without temporal history.
 *
 * ⚠ EVERY CONSTANT HERE IS A FRACTION OR A PIXEL COUNT — never a metre.
 * `radius` arrives derived from the cascade (see #armGtaoPass), the falloff
 * opens at a FRACTION of it, and the screen reach is clamped in pixels and as
 * a fraction of the frame height. Metre constants are the class this module
 * has now retracted three times.
 */
// The one-cone world-AO estimator distributes the retired six-cone quadrature
// over screen pixels. Two phases carry the axial cone and five carry its side
// cones, hence the 2:1 weights after a complete seven-phase resolve.
export const GI_WORLD_AO_PHASE_PERIOD = 7;
export const GI_WORLD_AO_PHASE_STRIDE_Y = 3;
// The density-cone estimator is biased open on the measured hidden-floor
// fixture (0.9555 versus exact ray truth 0.9078). Squaring maps it to 0.9130,
// while preserving the only invariant that may not move: response(1) == 1.
export const GI_WORLD_AO_VISIBILITY_POWER = 2;
export function giWorldAoResponse(visibility) {
  const v = Math.max(0, Math.min(1, Number(visibility) || 0));
  return v ** GI_WORLD_AO_VISIBILITY_POWER;
}

export function createGiGtaoPass({
  gbuffer,
  width,
  height,
  resolveWidth,
  resolveHeight,
  cameraPosition,
  cameraRight,
  cameraUp,
  projScale,
  strength,
  radius,
  // Optional large-scale visibility from the GI occupancy pyramid. GTAO owns
  // contacts; this closes the off-screen/hidden-occluder half without binding
  // the occupancy buffer in the already budget-tight resolve.
  traceConeAO = null,
  voxel = null,
  worldRadius = null,
  worldSteps = 6,
  slices = 3,
  steps = 3,
  spatialJitter = true,
  target = null,
}) {
  if (!target) {
    target = new THREE.StorageTexture(width, height);
    target.name = "giGtaoRaw";
    target.type = THREE.HalfFloatType;
    target.generateMipmaps = false;
    target.minFilter = THREE.LinearFilter;
    target.magFilter = THREE.LinearFilter;
  }

  const widthU = uniform(width, "uint");
  const positionNode = texture(gbuffer.position);
  const normalNode = texture(gbuffer.normal);
  const sx = resolveWidth / width;
  const sy = resolveHeight / height;
  const SLICES = Math.max(1, Math.min(8, Math.round(slices)));
  const STEPS = Math.max(1, Math.min(16, Math.round(steps)));
  const HALF_PI = Math.PI / 2;
  /**
   * `__giGtaoRadialPhase = false` (§11.35 rig arm): NO spatial radial phase —
   * every pixel marches the same STEPS radii. The phase exists so a 4-wide
   * filter can average four radial strata; without the filter it prints as
   * the diagonal dashes the user calls "blurry and noisy" once the filter is
   * narrowed. The alternative it tests: enough steps per pixel that no
   * filter is needed, at the AO buffer's own resolution.
   */
  const RADIAL_PHASE = globalThis.__giGtaoRadialPhase !== false;
  /** Where the distance falloff opens, as a fraction of the world radius. */
  const FALLOFF_FROM = 0.6;
  /**
   * Thin-occluder compensation, unitless. A depth buffer records a SURFACE and
   * says nothing about the thickness of the object behind it, so a horizon
   * raised by a thin rail occludes as though the rail reached to infinity.
   * Stretching the sample delta along the view axis before measuring the
   * falloff distance makes an occluder that is far in DEPTH fade sooner than
   * one equally far ACROSS the screen — which is the difference between "a
   * plank in front of the wall" and "the wall". 0 disables it; the value is
   * deliberately modest because over-compensating eats real contact shadows
   * at grazing angles.
   *
   * Measured (`probe:gi-gtao`, ultra/1080p, THIN=0 vs 0.6): the contact does
   * not move at all (0.700 both ways) and the frame lightens by about one
   * percent (mean 0.933 -> 0.943, p05 0.701 -> 0.730). So it is doing exactly
   * what it claims — relaxing occlusion that comes from DEPTH separation,
   * nowhere near a real contact — and it is cheap insurance on a scene whose
   * own build log warns that 85 of 122 meshes are thinner than two GI cells.
   * `__giGtaoThin` retunes it; 0 disables it.
   */
  const THIN = Number.isFinite(Number(globalThis.__giGtaoThin))
    ? Math.max(0, Math.min(4, Number(globalThis.__giGtaoThin)))
    : 0.6;
  /**
   * Screen reach ceiling, as a fraction of the resolve height.
   *
   * ⚠ IT IS AN UNDERSAMPLING AND CACHE GUARD, NOT THE RADIUS. The radius is
   * `radius`, derived from the cascade; this only stops a fixed step count
   * from spreading across half the frame when the camera is pressed against a
   * surface.
   *
   * ⛔ AND IT IS NOT WHY GTAO READS LIGHTER THAN THE RAY-TRACED ARM AT A
   * CONTACT — that was the obvious theory and the measurement refuted it.
   * On the 6x3x6 rig at 1080p a 1.12 m radius wants 263 px and 0.15 allowed
   * 72, so raising the cap to 0.25 should have darkened the contact
   * substantially; it moved it from 0.696 to 0.700. Kept at 0.25 anyway
   * because the looser bound is the more honest one, not because it bought
   * anything.
   */
  const MAX_REACH = 0.25;
  const maxPix = Math.max(4, Math.round(resolveHeight * MAX_REACH));
  /**
   * ⭐⭐ THE STEP-SPACING CEILING (§11.46) — an N-tap estimator may not be
   * asked to cover an arbitrary screen distance.
   *
   * `MAX_REACH` above bounds the RADIUS; nothing bounded the GAP BETWEEN
   * CONSECUTIVE TAPS. With 4 steps and a reach of a quarter of the frame
   * height, taps land ~59 px apart near the camera, and an occlusion
   * estimate sampled every 59 px is not measuring a horizon, it is
   * aliasing one: the AO prints as rectangular blocks that follow the
   * occluder's silhouette, worst where the geometry is CLOSEST (the user's
   * report: "quite a huge radius, i kinda see rects on all edges and near
   * the character's hands"). Half-resolution AO hid it — the 2x bilinear
   * upsample and the wider filter smoothed the blocks away — and §11.35
   * moved the AO to full resolution, where nothing does.
   *
   * So the reach is ALSO bounded by what the tap count can actually
   * resolve: `STEPS x maxStepPix`, a fraction of the buffer height so it
   * is resolution-independent like `MAX_REACH`. Near the camera this
   * shortens the world radius — correctly, because past this point the
   * estimator had no information there anyway. `__giGtaoMaxStepPx` pins the
   * spacing; a huge value restores the pre-§11.46 reach for an A/B.
   *
   * ⭐ WHERE THE NUMBER COMES FROM — it is the filter's reach, not taste.
   * The radial phase gives 4 distinct offsets across neighbouring pixels,
   * so a spacing of `s` px interleaves to `s/4` px of radial granularity;
   * the +-2 px filter can smooth about 5 px of it. Hence s <= ~4x5 = 20-24
   * px, i.e. 2.5 % of a 943-px buffer. The first build used 1 % (9.4 px),
   * which put the effective radius at ~0.14 m three metres from the camera
   * — "now there is almost no ao" (the user). The pre-§11.46 reach was 59
   * px of spacing, four times what the filter can carry, which is why it
   * printed rectangles. Widening the FILTER is what buys a wider spacing;
   * these two constants move together or not at all.
   */
  const MAX_STEP_FRAC = 0.025;
  const maxStepPin = Number(globalThis.__giGtaoMaxStepPx);
  const maxStepPix = Number.isFinite(maxStepPin) && maxStepPin > 0
    ? maxStepPin
    : Math.max(2, resolveHeight * MAX_STEP_FRAC);
  const reachPix = Math.max(4, Math.min(maxPix, STEPS * maxStepPix));
  /**
   * ⭐⭐ THE MINIMUM STEP, IN GBUFFER TEXELS — the single number that decides
   * whether this estimator is correct or 45% too dark, measured.
   *
   * A tap is a `textureLoad` at a TRUNCATED coordinate, so an offset shorter
   * than one texel lands back on the CENTRE texel. Then `d = tapP - P` is
   * exactly zero, `shc = d·V/|d|` is 0/epsilon = 0, and 0 is far above the
   * unoccluded horizon of any surface seen at a grazing angle (`cos(γ±π/2)`
   * is ±sin γ, i.e. ∓0.98 on a floor): the slice reports itself fully
   * occluded BY ITSELF. It is silent — no NaN, no seam, just a floor that
   * reads 0.55 where the ray-traced arm reads 1.00 on the same rig and the
   * same point (2026-08-26, `probe:gi-gtao` ARM=raytraced).
   *
   * A diagonal ω needs |offset| ≥ √2 before BOTH axes are guaranteed to
   * cross a texel boundary; on cheaper tiers the pass also runs at half the
   * gbuffer resolution, so one AO pixel is `sx` gbuffer texels and stepping
   * less than that re-reads the same neighbourhood at a higher cost per unit
   * of new information. The larger of the two is the floor, and the reach
   * clamp below is raised to match so the quadratic distribution is not
   * entirely swallowed by it.
   */
  const MIN_STEP = Math.max(Math.SQRT2, sx, sy);
  /**
   * `__giGtaoDebug = true` fills the target's unused y/z/w with the three
   * numbers that separate "the integral is wrong" from "the horizons are
   * wrong": y = the visibility this pixel WOULD report with no occluder at
   * all (must be ~1 — if it is not, the arc integral or its normalization is
   * at fault and no amount of tap tuning will help), z = how much the march
   * actually raised the two horizons, summed over slices (0 on an open
   * floor), w = the screen reach in gbuffer texels. Read by `probe:gi-gtao`.
   */
  const DEBUG = globalThis.__giGtaoDebug === true;
  const SPATIAL_JITTER = spatialJitter !== false;
  const WORLD_STEPS = Math.max(4, Math.min(12, Math.round(worldSteps)));
  const WORLD_CONE_TAN_HALF = Math.tan(Math.PI / 6);

  const compute = Fn(() => {
    const px = instanceIndex.mod(widthU);
    const py = instanceIndex.div(widthU);
    // The gbuffer is always FULL resolve resolution. Cheaper tiers run this
    // pass at half, so horizon taps still read full-resolution positions while
    // only a quarter of the pixels pay for a march; Ultra runs it one-to-one
    // to preserve silhouettes and the structured sampling pattern.
    const baseX = px.toFloat().add(0.5).mul(sx).toVar();
    const baseY = py.toFloat().add(0.5).mul(sy).toVar();
    const sourceCoord = ivec2(
      baseX.toInt().clamp(0, resolveWidth - 1),
      baseY.toInt().clamp(0, resolveHeight - 1),
    ).toVar();
    const g0 = positionNode.load(sourceCoord).toVar();
    const nRaw = normalNode.load(sourceCoord).xyz.toVar();
    const ao = float(1).toVar();
    const refVis = DEBUG ? float(0).toVar() : null;
    const raised = DEBUG ? float(0).toVar() : null;
    const dbgReach = DEBUG ? float(0).toVar() : null;
    // Kept separate from GTAO until AFTER both estimators have been spatially
    // integrated. E[min(G, V_i)] is biased dark; min(G, E[V_i]) is the
    // intended union of the screen and world visibility estimates.
    const worldAo = float(1).toVar();

    // Both channels, not just `position.w`: a sky texel's normal is ZERO and
    // `normalize(0)` would write NaN into a texture the resolve multiplies
    // into every indirect pixel.
    If(g0.w.greaterThan(0.5).and(nRaw.dot(nRaw).greaterThan(0.25)), () => {
      const P = g0.xyz.toVar();
      const camP = vec3(cameraPosition).toVar();
      const rawN = nRaw.normalize().toVar();
      // Camera-faced, as every other consumer of this gbuffer is: a
      // double-sided wall seen from inside must be occluded against the
      // inside.
      const facing = step(0, rawN.dot(camP.sub(P))).mul(2).sub(1);
      const N = rawN.mul(facing).toVar();
      const camR = vec3(cameraRight).normalize().toVar();
      const camU = vec3(cameraUp).normalize().toVar();
      // View forward from the two screen axes — right × up is +Z, i.e.
      // BACKWARD for a three.js camera, so the cross is taken the other way.
      // Deriving it costs one cross product and removes a third uniform that
      // could go stale independently of the pair it must stay orthogonal to.
      const fwd = cross(camU, camR).normalize().toVar();
      const toCam = camP.sub(P).toVar();
      const V = toCam.normalize().toVar();
      // PROJECTED depth, not euclidean distance: `projScale` is pixels per
      // world unit at unit depth ALONG THE VIEW AXIS, so the world→pixel
      // conversion is only exact against that same axis. At the edge of a
      // wide fov the two differ by tens of percent, and the error would read
      // as an AO radius that grows toward the corners of the frame.
      const viewZ = toCam.dot(fwd).negate().max(1e-3).toVar();
      const R = float(radius).max(1e-3).toVar();
      // World radius → resolve pixels, clamped at both ends. The floor keeps
      // the march from degenerating into re-reading the centre texel when the
      // camera is far away; the ceiling bounds the cache footprint when it is
      // pressed against a wall (and a metre of AO covering a sixth of the
      // screen is not a look anyone asked for).
      const rPix = R.mul(float(projScale)).div(viewZ)
        .clamp(float(STEPS * MIN_STEP), float(Math.max(STEPS * MIN_STEP, reachPix))).toVar();

      /**
       * §11.46 — the world radius the march ACTUALLY covers, back out of the
       * clamped pixel reach. The falloff below ramps occlusion to zero at the
       * radius; ramping against a radius the taps never reach leaves the last
       * tap at full weight, i.e. a HARD CUTOFF at the end of the march, which
       * is the second half of the blocky edge. Never larger than the world
       * radius that was asked for.
       */
      const Reff = rPix.mul(viewZ).div(float(projScale).max(1e-6)).min(R).max(1e-3).toVar();
      if (DEBUG) dbgReach.assign(rPix);

      // ── THE PATTERN: SPATIAL STRATA OR FULL PER-PIXEL QUADRATURE ────────
      //
      // On cheaper tiers, 16 slice rotations and 4 step offsets tile a 4×4
      // pixel block, so a filter spanning that block sees the full set while
      // only one quarter of the pixels pay for it. Ultra has enough samples
      // per pixel to skip that bargain and uses one fixed centred pattern.
      // The IGN jitter is therefore only consumed by the stratified tiers.
      const ix = px.bitAnd(uint(3)).toFloat().toVar();
      const rotIdx = px.add(py).bitAnd(uint(3)).toFloat().mul(4).add(ix).toVar();
      const offIdx = py.sub(px).bitAnd(uint(3)).toFloat().toVar();
      // Half-res tiers jitter within each stratum to trade an enlarged 4x4
      // grid for filterable noise. Ultra supplies enough angular/radial
      // samples at every full-resolution pixel to use one centred pattern
      // everywhere. Keeping the 4x4 phase there merely prints quadrature
      // error as the stipple the user sees on otherwise smooth walls.
      const ign = SPATIAL_JITTER
        ? fract(fract(px.toFloat().mul(0.06711056).add(py.toFloat().mul(0.00583715))).mul(52.9829189)).toVar()
        : float(0.5).toVar();
      // Radial phase is always spatial. A fixed phase copies depth edges at
      // each marched radius; stable interleaved-gradient noise turns those
      // coherent echoes into sub-pixel error for the bilateral to remove.
      const ign2 = fract(
        fract(px.toFloat().add(37).mul(0.06711056).add(py.toFloat().add(17).mul(0.00583715)))
          .mul(52.9829189),
      ).toVar();
      const rot = SPATIAL_JITTER
        ? rotIdx.add(ign).div(16).toVar()
        : float(0.5).toVar();
      // Radial samples MUST retain a spatial phase even on Ultra. Fixing this
      // to 0.5 made every pixel test the same four radii, so a depth edge was
      // copied into four detached, concentric bands. The stable four-stratum
      // pattern is filterable and never changes over time. Only the angular
      // pattern is fixed per Ultra pixel.
      const stepNoise = RADIAL_PHASE ? offIdx.add(ign2).div(4).toVar() : float(0.5).toVar();

      const visibility = float(0).toVar();
      Loop({ start: int(0), end: int(SLICES), type: "int", condition: "<" }, ({ i }) => {
        // Slices span HALF a turn, not a whole one: the march already walks
        // both ways along ω, so φ and φ+π are the same slice.
        const phi = i.toFloat().add(rot).mul(Math.PI / SLICES).toVar();
        const omega = vec2(cos(phi), sin(phi)).toVar();
        // ⭐⭐ THE SCREEN Y AXIS POINTS DOWN AND THE CAMERA'S UP VECTOR DOES
        // NOT — SUBTRACT, NEVER ADD.
        //
        // `omega` walks TEXTURE coordinates, where row 0 is the TOP of the
        // frame, so +y is DOWNWARD; `camU` is the camera's world up. Adding
        // them builds the slice plane for the MIRRORED screen direction while
        // the taps walk the real one, and the two only coincide for a purely
        // horizontal slice. Every other slice then measures a horizon in one
        // plane and projects the normal into another, so a perfectly flat,
        // perfectly unoccluded floor reports occlusion — measured at 0.55 on
        // a rig where the ray-traced arm reads 1.00 at the same world point,
        // with the debug channels showing `unoccluded-ref` a correct 0.98 and
        // `horizon-raise` a nonsense 1.06 (`probe:gi-gtao GTAO_DEBUG=1`).
        //
        // ⭐ The lesson generalizes past this pass: a sign error inside a
        // rotationally symmetric sample set is INVISIBLE to every symmetry
        // argument — the set of slices is unchanged by the flip, only the
        // pairing of each slice with its own plane is — so it cannot be found
        // by reasoning about the pattern, only by reading a per-stage number.
        const dirW = camR.mul(omega.x).sub(camU.mul(omega.y)).toVar();
        const ortho = dirW.sub(V.mul(dirW.dot(V))).toVar();
        // The slice PLANE's normal. Every angle below is measured inside the
        // plane spanned by V and `ortho`.
        const axis = cross(ortho, V).normalize().toVar();
        const projN = N.sub(axis.mul(N.dot(axis))).toVar();
        const projLen = projN.length().toVar();
        const cosNorm = projN.dot(V).div(projLen.max(1e-6)).clamp(-1, 1).toVar();
        const sgn = select(ortho.dot(projN).greaterThanEqual(0), float(1), float(-1)).toVar();
        // γ, the in-plane angle of the projected normal, signed toward +ω.
        const gamma = sgn.mul(acos(cosNorm)).toVar();
        const sinG = sin(gamma).toVar();
        // The UNOCCLUDED horizons — the tangent plane, NOT −1. Starting at −1
        // lets the integral claim visibility from BEHIND the surface, which
        // is the classic HBAO "walls glow at their base" artifact.
        const low0 = cos(gamma.add(HALF_PI)).toVar();
        const low1 = cos(gamma.sub(HALF_PI)).toVar();
        const h0 = low0.toVar();
        const h1 = low1.toVar();

        Loop({ start: int(0), end: int(STEPS), type: "int", condition: "<" }, ({ i: s }) => {
          // Quadratic distribution — half the taps land in the inner quarter
          // of the reach, which is where a contact shadow lives and where the
          // horizon changes fastest.
          const sN = s.toFloat().add(stepNoise).div(STEPS).toVar();
          // ...and at least one whole pixel further out per step, so no two
          // taps of a slice collapse onto the same texel when `rPix` is small
          // (which is most of a large room, seen from across it).
          const offPix = sN.mul(sN).mul(rPix).max(s.toFloat().add(1).mul(MIN_STEP)).toVar();

          // One tap each side. The two sides are SEPARATE horizons: side +ω
          // raises h0, side −ω raises h1, and swapping them turns the arc
          // integral inside out (a uniformly bright frame — worth naming,
          // because it looks like "AO is off" rather than like a sign error).
          const tap = (dir) => {
            const cx = baseX.add(omega.x.mul(offPix).mul(dir)).toInt().clamp(0, resolveWidth - 1);
            const cy = baseY.add(omega.y.mul(offPix).mul(dir)).toInt().clamp(0, resolveHeight - 1);
            return positionNode.load(ivec2(cx, cy)).toVar();
          };
          const raise = (tp, horizon, low) => {
            const d = tp.xyz.sub(P).toVar();
            const len = d.length().max(1e-5).toVar();
            const shc = d.dot(V).div(len).toVar();
            // Thin-occluder compensation (see THIN): the falloff is measured
            // on a delta stretched along the view axis, so depth separation
            // costs more range than screen separation does.
            const fLen = d.add(fwd.mul(d.dot(fwd).mul(THIN))).length().toVar();
            // 1 inside FALLOFF_FROM·R, ramping to 0 at R. A tap past the
            // radius fades to the unoccluded horizon rather than being
            // dropped — a hard cutoff prints a ring wherever the reach lands
            // on a flat floor.
            const w = Reff.sub(fLen).div(Reff.mul(1 - FALLOFF_FROM)).clamp(0, 1).toVar();
            // `tp.w` is the gbuffer's valid mask: the SKY is not an occluder,
            // and its "position" is whatever the clear left behind. The
            // length test is the belt to MIN_STEP's braces: a coincident tap
            // (a degenerate gbuffer, a duplicated texel) must contribute
            // nothing rather than a horizon of 0 — see MIN_STEP's note for
            // what that costs when it slips through.
            const valid = select(
              tp.w.greaterThan(0.5).and(len.greaterThan(1e-4)),
              float(1),
              float(0),
            ).toVar();
            horizon.assign(horizon.max(mix(low, shc, w.mul(valid))));
          };
          raise(tap(float(1)), h0, low0);
          raise(tap(float(-1)), h1, low1);
        });

        // Horizons back to angles, then clamped into the normal's own
        // hemisphere — the arc cannot open wider than the surface can see.
        const a0 = acos(h0.clamp(-1, 1)).toVar();
        const a1 = acos(h1.clamp(-1, 1)).negate().toVar();
        // CLAMPED BOTH WAYS, not min/max per side. The two horizons are on
        // opposite sides of the normal only while the march behaves; a tap
        // that raises a horizon PAST the normal (a surface folding back on
        // itself, one pixel of a thin sliver) would otherwise leave the arc
        // inverted and the integral would return a value above 1.
        const ah0 = gamma.add(a0.sub(gamma).clamp(-HALF_PI, HALF_PI)).toVar();
        const ah1 = gamma.add(a1.sub(gamma).clamp(-HALF_PI, HALF_PI)).toVar();
        // The closed-form cosine-weighted arc integral — see the header. Note
        // `cosNorm` IS cos γ; recomputing it from γ would cost a cosine and
        // lose precision to the arccos that produced γ in the first place.
        const arc = (h) => cosNorm.add(h.mul(2).mul(sinG)).sub(cos(h.mul(2).sub(gamma))).mul(0.25);
        visibility.addAssign(projLen.mul(arc(ah0).add(arc(ah1))));
        if (DEBUG) {
          refVis.addAssign(projLen.mul(arc(gamma.add(HALF_PI)).add(arc(gamma.sub(HALF_PI)))));
          raised.addAssign(h0.sub(low0).add(h1.sub(low1)));
        }
      });

      // |n| already weights each slice by the share of the hemisphere it
      // covers, so the mean over slices is the whole normalization there is —
      // no magic scale, which is the point of the closed form.
      const vis = visibility.div(SLICES).clamp(0, 1).toVar();
      ao.assign(mix(float(1), vis, float(strength).clamp(0, 1)));

      // ── WORLD VISIBILITY: ONE STRATIFIED OCCUPANCY CONE PER PIXEL ───────
      //
      // GTAO can only see the depth image. A wall just outside the frame, the
      // roof above an arcade, or geometry hidden behind the receiver therefore
      // contributes no occlusion at all — exactly the large-scale indirect
      // shadow the radiance field is supposed to carry. The occupancy pyramid
      // already contains those blockers, so sample it here rather than asking
      // GTAO to grow beyond the screen.
      //
      // The retired VXAO pass fired SIX cones per half-res pixel and cost
      // 10.94 ms on Sponza. This fires ONE. A 7-state spatial pattern encodes
      // the same cosine weights as its six-cone quadrature: two states choose
      // the normal cone, and one state chooses each of five 60° side cones.
      // The X filter resolves exactly one complete seven-state cycle; the
      // ordinary Y filter then smooths that result with no temporal history.
      // Stable scene + stable camera = stable answer; motion never reuses an
      // old frame.
      //
      // Composition is min(), not multiplication. The two estimators overlap
      // around contacts, and min lets either reveal a blocker without charging
      // it twice. The factor is consumed only by indirect diffuse; direct and
      // directional/exact reflection paths keep their own visibility.
      if (traceConeAO && voxel != null && worldRadius != null) {
        // Same continuous Duff/Frisvad frame as the full VXAO arm. No up-vector
        // branch means no seam as a normal crosses an axis.
        const sgn = select(N.z.greaterThanEqual(0), float(1), float(-1)).toVar();
        const oa = float(-1).div(sgn.add(N.z)).toVar();
        const ob = N.x.mul(N.y).mul(oa).toVar();
        const T = vec3(
          N.x.mul(N.x).mul(oa).mul(sgn).add(1),
          ob.mul(sgn),
          N.x.mul(sgn).negate(),
        ).toVar();
        const B = vec3(ob, N.y.mul(N.y).mul(oa).add(sgn), N.y.negate()).toVar();

        // 2/7 axial + 1/7 for each side cone is exactly
        // 1 : 5×cos(60°), normalized — the old six-cone quadrature's weights.
        const state = px.add(py.mul(uint(GI_WORLD_AO_PHASE_STRIDE_Y)))
          .mod(uint(GI_WORLD_AO_PHASE_PERIOD)).toVar();
        // Convert before subtracting: u32 state 0/1 would otherwise underflow
        // to ~4.29e9 and feed huge, needless angles to sin/cos in axial lanes.
        const side = state.toFloat().sub(2).max(0).toVar();
        const angle = side.mul((2 * Math.PI) / 5).toVar();
        const sideDir = N.mul(0.5)
          .add(T.mul(cos(angle).mul(Math.sqrt(0.75))))
          .add(B.mul(sin(angle).mul(Math.sqrt(0.75))))
          .normalize()
          .toVar();
        const coneDir = select(state.lessThan(uint(2)), N, sideDir).toVar();

        const vox = vec3(voxel).toVar();
        const finest = vox.x.min(vox.y).min(vox.z).mul(2).toVar();
        const origin = P.add(N.mul(finest.mul(1.5))).toVar();
        const worldVis = float(traceConeAO(
          origin,
          coneDir,
          finest.mul(0.5),
          float(worldRadius).max(finest.mul(6)),
          {
            tanHalf: WORLD_CONE_TAN_HALF,
            steps: WORLD_STEPS,
            receiverP: P,
            receiverN: N,
          },
        )).clamp(0, 1).toVar();
        // Store RAW visibility. The seven spatial phases are samples of one
        // hemisphere integral, so the response curve belongs after their
        // bilateral mean: E[V²] would be a different, darker estimator than
        // E[V]² and would put the phase variance back into the image.
        worldAo.assign(worldVis);
      }
    });

    textureStore(
      target,
      ivec2(px.toInt(), py.toInt()),
      DEBUG
        ? vec4(ao, refVis.div(SLICES), raised.div(SLICES), dbgReach)
        : vec4(ao, worldAo, 0, 1),
    );
  })().compute(width * height);

  compute.__giPassName = "gtao";
  return { compute, target, node: texture(target), widthU, width, height, slices: SLICES, steps: STEPS };
}


/**
 * THE SCREEN-AO DENOISER (2026-08-26, "the ao is quite bad quality still,
 * especially screen space component").
 *
 * WHAT THE GRAIN IS. `createGiAoPass` rotates its three golden-angle spirals
 * by interleaved-gradient noise — a DIFFERENT angle at every pixel. Its header
 * calls that pattern "stable across frames: no temporal noise, no filter debt",
 * and the first half is true: nothing here flickers. The second half is not.
 * A per-pixel rotation is a per-pixel ESTIMATOR, so neighbouring pixels
 * integrate different subsets of the same hemisphere and disagree — that
 * disagreement is spatial noise whether or not it moves, and nothing
 * downstream was removing it. It is worst in the MICRO ring, which draws 10
 * taps from the ~28 pixels inside a 3 px disc and is then multiplied by 3.
 *
 * Every shipping SSAO pairs a rotated kernel with a spatial denoiser for
 * exactly this reason; the rotation is what trades BANDING for noise, and the
 * filter is the other half of that trade. (Dropping the rotation instead is
 * what the pass did before, and it printed angular sectors around round props
 * — see the TAPS_WIDE note. The pair is the answer, not either half.)
 *
 * SEPARABLE, AND CROSS-BILATERAL ON THE PLANE ONLY. Two radius-2 passes cover
 * a 5x5 support for 10 taps instead of 25. The edge test is the receiver's own
 * plane — |dot(N, tapP - P)| — and NOT a normal comparison, because the plane
 * test already rejects the perpendicular face of a corner (its distance from
 * the centre plane grows immediately) while costing one texture read per tap
 * instead of two. AO is a smooth 0..1 factor, so a tap that fails the test is
 * dropped and the weights renormalize; there is no fallback-to-unoccluded that
 * could print a bright halo at a silhouette.
 *
 * ⚠ THE TOLERANCE IS IN PIXEL FOOTPRINTS, NOT METRES. A fixed world epsilon
 * is the constant class this module keeps retracting: at 2 m it rejects a
 * floor's own neighbours, at 40 m it accepts a different wall. `dist /
 * projScale` is the world size of one pixel at this depth, so 4 of them is
 * "about as far as a 2-tap-radius neighbour can legitimately be", at every
 * distance and every field of view.
 */
/**
 * Build the two one-dimensional AO filter kernels. Exported because the
 * seven-phase world estimator's energy is a testable CPU-side invariant, not
 * a visual tuning claim.
 */
export function giAoFilterWeights(radius = 2, worldPhaseResolve = false) {
  const gtaoRadius = Math.max(1, Math.min(6, Math.round(radius)));
  const supportRadius = worldPhaseResolve
    ? Math.max(gtaoRadius, (GI_WORLD_AO_PHASE_PERIOD - 1) / 2)
    : gtaoRadius;
  const sigma = Math.max(0.6, gtaoRadius / 2);
  const gtao = [];
  for (let k = -supportRadius; k <= supportRadius; k++) {
    gtao.push(Math.abs(k) <= gtaoRadius ? Math.exp(-(k * k) / (2 * sigma * sigma)) : 0);
  }
  const total = gtao.reduce((a, b) => a + b, 0);
  for (let i = 0; i < gtao.length; i++) gtao[i] /= total;
  const world = worldPhaseResolve
    ? gtao.map(() => 1 / GI_WORLD_AO_PHASE_PERIOD)
    : [...gtao];
  return { supportRadius, gtao, world };
}

export function createGiAoFilterPass({ gbuffer, source, target, width, height, resolveWidth = width, resolveHeight = height, cameraPosition, projScale, axisX = 0, axisY = 0, radius = 2, combineChannels = false, worldPhaseResolve = false, worldStrength = null }) {
  const widthU = uniform(width, "uint");
  const positionNode = texture(gbuffer.position);
  const normalNode = texture(gbuffer.normal);
  const sourceNode = texture(source);
  // The AO buffer may be coarser than the gbuffer (the ray-traced pass runs at
  // its own budget). Every gbuffer read here goes through this mapping, and it
  // MUST be the same one the producing pass used to pick its source texel —
  // two different roundings would make the filter compare a tap against a
  // different surface than the tap was traced from, which reads as edge
  // dropout exactly at silhouettes.
  const gx = resolveWidth / width;
  const gy = resolveHeight / height;
  const gbufferCoord = (ix, iy) => ivec2(
    ix.toFloat().add(0.5).mul(gx).toInt().clamp(0, resolveWidth - 1),
    iy.toFloat().add(0.5).mul(gy).toInt().clamp(0, resolveHeight - 1),
  );
  // ── WIDTH IS THE CHEAP AXIS, AND THAT IS THE WHOLE BUDGET ARGUMENT ──────
  //
  // The estimator behind this filter costs ~3.4 ns per RAY; a filter tap costs
  // two texture reads. So buying variance reduction with taps instead of rays
  // is roughly an order of magnitude cheaper per unit of noise removed — a
  // radius-4 separable pass is a 9x9 support (~81 decorrelated estimates) for
  // ~0.4 ms, where getting the same reduction from the estimator would mean
  // 80 rays per pixel. That is why the ray-traced arm ships 2 rays and a wide
  // filter rather than 8 rays and a narrow one.
  //
  // What bounds it is DETAIL, not cost: this runs at the AO buffer's own
  // resolution (half the resolve by default), so a radius-4 support is ~4.5
  // full-resolution pixels. Past that the plane test starts being the only
  // thing holding a crease together, and a crease narrower than the support
  // is what AO exists to draw.
  const FILTER = giAoFilterWeights(radius, worldPhaseResolve);
  const RADIUS = FILTER.supportRadius;
  const compute = Fn(() => {
    const px = instanceIndex.mod(widthU);
    const py = instanceIndex.div(widthU);
    const coord = ivec2(px.toInt(), py.toInt());
    const gCoord = gbufferCoord(px, py).toVar();
    const g0 = positionNode.load(gCoord).toVar();
    // x = screen-space estimate; y = optional stratified world estimate. The
    // latter must stay independent through both separable passes so a single
    // binary-ish cone cannot dark-bias GTAO before its neighbourhood integral.
    const centre = sourceNode.load(coord).xy.toVar();
    const out = centre.toVar();
    const nRaw = normalNode.load(gCoord).xyz.toVar();
    If(g0.w.greaterThan(0.5).and(nRaw.dot(nRaw).greaterThan(0.25)), () => {
      const P = g0.xyz.toVar();
      const N = nRaw.normalize().toVar();
      const dist = vec3(cameraPosition).sub(P).length().max(1e-3).toVar();
      // 4 AO-buffer pixels. `projScale` is written for the RESOLVE grid, so a
      // coarser AO buffer has proportionally larger pixels and the tolerance
      // has to grow with them — otherwise a half-res AO rejects its own
      // legitimate neighbours and the filter degrades to a no-op.
      const tol = dist.div(float(projScale).max(1e-3)).mul(4 * gx).max(1e-4).toVar();
      const sum = vec2(0).toVar();
      const wsum = vec2(0).toVar();
      for (let k = -RADIUS; k <= RADIUS; k++) {
        const sc = ivec2(
          px.toInt().add(k * axisX).clamp(0, width - 1),
          py.toInt().add(k * axisY).clamp(0, height - 1),
        ).toVar();
        const tapP = positionNode.load(gbufferCoord(sc.x, sc.y)).toVar();
        // Plane distance in this pixel's own footprint units: full weight
        // inside one tolerance, gone by six.
        const planar = N.dot(tapP.xyz.sub(P)).abs().toVar();
        const planeW = tapP.w.greaterThan(0.5)
          .select(float(1).sub(smoothstep(tol, tol.mul(6), planar)), float(0))
          .toVar();
        // GTAO keeps its narrow Gaussian. On the first/X pass only, world AO
        // uses a uniform seven-tap kernel: state=(x+3y)%7 means those taps are
        // exactly one complete quadrature cycle. This removes the 0.245..0.325
        // axial-weight phase error left by a 5x5 Gaussian on a flat surface.
        const weights = vec2(
          planeW.mul(FILTER.gtao[k + RADIUS]),
          planeW.mul(FILTER.world[k + RADIUS]),
        ).toVar();
        sum.addAssign(sourceNode.load(sc).xy.mul(weights));
        wsum.addAssign(weights);
      }
      // The centre tap always passes its own plane test, so `wsum` is never
      // below its own weight and this can only ever be a renormalized average
      // of real neighbours — never a divide by zero, never a jump to 1.
      out.assign(vec2(
        wsum.x.greaterThan(1e-4).select(sum.x.div(wsum.x), centre.x),
        wsum.y.greaterThan(1e-4).select(sum.y.div(wsum.y), centre.y),
      ));
    });
    // RESPONSE AFTER INTEGRATION. The square is the measured correction from
    // the cached voxel fixture (hidden 0.9555 -> 0.9130 vs truth 0.9078;
    // open 0.9907 -> 0.9815), and exact open visibility remains exactly 1.
    // The normal authored strength controls both GTAO and world AO; there is
    // no second taste multiplier hiding the calibrated spatial response.
    const worldFactor = combineChannels
      ? mix(
        float(1),
        out.y.clamp(0, 1).pow(GI_WORLD_AO_VISIBILITY_POWER),
        float(worldStrength ?? 1).clamp(0, 1),
      ).toVar()
      : out.y;
    textureStore(target, coord, combineChannels
      ? vec4(out.x.min(worldFactor), worldFactor, 0, 1)
      : vec4(out, 0, 1));
  })().compute(width * height);

  compute.__giPassName = axisX ? "aoFilterX" : "aoFilterY";
  return { compute, widthU };
}

/**
 * WORLD-SPACE VOXEL AO — VXAO, in the NVIDIA sense: a cone-traced integral of
 * the hemisphere against a voxel opacity pyramid.
 *
 * The occupancy field already owns the expensive half: conservative scene
 * voxelization plus a five-level FRACTIONAL-density hierarchy. This pass only
 * traces it from visible gbuffer points. It deliberately lives outside the
 * resolve so the occupancy `bits` storage buffer is bound in this small kernel
 * alone; the fully-composed resolve stays under WebGPU's portable
 * eight-storage-buffer limit.
 *
 * THE CONE SET is Crassin's, which is also what VXGI/VXAO ship: six cones of
 * 60° aperture — one along the normal, five at 60° elevation spaced 72° in
 * azimuth — weighted by the cosine of their elevation, so the sum is a
 * cosine-weighted hemisphere integral rather than an unweighted average.
 *
 * NOTHING IS RANDOMISED. The previous arm rotated the azimuth per pixel with
 * interleaved-gradient noise and had no temporal or spatial filter behind it,
 * so the rotation was a per-pixel bias, not an ensemble that averages. Six wide
 * overlapping cones over a CONTINUOUS medium vary so little with azimuth that a
 * fixed frame costs almost nothing in bias and buys an exactly reproducible,
 * noise-free field — which is what a term reconstructed by a 2×2 bilateral
 * upsample needs. The frame is Duff et al.'s branchless orthonormal basis: it
 * has no `up`-vector flip, so it cannot print a seam where one axis dominates.
 *
 * `traceConeAO` is occupancyField.traceOccupancyConeAO — read its header for
 * why the estimator, not the filtering, is where AO smoothness is won.
 *
 * RESOLUTION. This term is metre-scale by construction (its finest medium is a
 * level-1 cell and its cones open at 60°), so it is computed at half width and
 * height and reconstructed by the resolve's position/normal-weighted bilinear
 * upsample. `createGiAoPass` remains responsible for exact screen-space
 * contacts below the voxel scale; the resolve composes them with `min`.
 */
export function createGiVxaoPass({
  gbuffer,
  width,
  height,
  resolveWidth,
  resolveHeight,
  cameraPosition,
  strength,
  radius,
  voxel,
  traceConeAO,
}) {
  const target = new THREE.StorageTexture(width, height);
  target.name = "giVxao";
  target.generateMipmaps = false;
  // This is a deliberately low-frequency channel. The resolve's edge-aware
  // reconstruction is the magnification filter; silhouette/contact validity
  // remains the full-res screen AO.
  target.minFilter = THREE.LinearFilter;
  target.magFilter = THREE.LinearFilter;

  const widthU = uniform(width, "uint");
  const positionNode = texture(gbuffer.position);
  const normalNode = texture(gbuffer.normal);
  const sx = resolveWidth / width;
  const sy = resolveHeight / height;
  /** 60° full aperture. Paired with cell = radius, this is the 1.5-cell
   *  receiver-plane clearance the AO cone's header derives. */
  const CONE_TAN_HALF = Math.tan(Math.PI / 6);
  const SIDE_CONES = 5;
  const SIDE_ELEVATION = Math.PI / 3;
  const SIDE_Z = Math.cos(SIDE_ELEVATION);
  const SIDE_R = Math.sin(SIDE_ELEVATION);
  // Cosine-weighted, normalised. cos(0) = 1 for the axial cone, cos(60°) = 0.5
  // for each side cone.
  const WEIGHT_SUM = 1 + SIDE_CONES * SIDE_Z;
  const W_AXIAL = 1 / WEIGHT_SUM;
  const W_SIDE = SIDE_Z / WEIGHT_SUM;
  // Geometric stepping needs ≈5 steps to cross a 2.4 m reach at this aperture;
  // the march breaks out early, so this is a ceiling, not a cost.
  const CONE_STEPS = 8;

  const compute = Fn(() => {
    const px = instanceIndex.mod(widthU);
    const py = instanceIndex.div(widthU);
    const sourceCoord = ivec2(
      px.toFloat().add(0.5).mul(sx).toInt().clamp(0, resolveWidth - 1),
      py.toFloat().add(0.5).mul(sy).toInt().clamp(0, resolveHeight - 1),
    ).toVar();
    const g0 = positionNode.load(sourceCoord).toVar();
    const nRaw = normalNode.load(sourceCoord).xyz.toVar();
    const ao = float(1).toVar();

    If(g0.w.greaterThan(0.5).and(nRaw.dot(nRaw).greaterThan(0.25)), () => {
      const P = g0.xyz.toVar();
      const rawN = nRaw.normalize().toVar();
      const facing = step(0, rawN.dot(vec3(cameraPosition).sub(P))).mul(2).sub(1);
      const N = rawN.mul(facing).toVar();
      // Duff/Frisvad branchless ONB. `sgn + N.z` cannot vanish: sgn is +1 only
      // where N.z ≥ 0 and −1 only where N.z < 0, so the denominator is in
      // ±[1, 2]. Continuous everywhere a `select` on an up-vector is not.
      const sgn = select(N.z.greaterThanEqual(0), float(1), float(-1)).toVar();
      const oa = float(-1).div(sgn.add(N.z)).toVar();
      const ob = N.x.mul(N.y).mul(oa).toVar();
      const T = vec3(
        N.x.mul(N.x).mul(oa).mul(sgn).add(1),
        ob.mul(sgn),
        N.x.mul(sgn).negate(),
      ).toVar();
      const B = vec3(ob, N.y.mul(N.y).mul(oa).add(sgn), N.y.negate()).toVar();
      const vox = vec3(voxel).toVar();
      const voxMin = vox.x.min(vox.y).min(vox.z).toVar();
      // The medium's finest cell is level 1 = two level-0 voxels. Lifting the
      // origin 1.5 of those puts the very first sample at the trilinear
      // kernel's first zero for the receiver's own surface slab, which is the
      // same clearance the march then holds at every t (see its header).
      const finest = voxMin.mul(2).toVar();
      const origin = P.add(N.mul(finest.mul(1.5))).toVar();
      const tMin = finest.mul(0.5).toVar();
      // FOUR TIMES the AO radius — but what matters is the REACH IN METRES,
      // and the two are only related through the shipped `aoRadius` of 0.5
      // (giConfig), so if that moves far this multiplier has to be re-derived.
      //
      // 2 m is the far end of where this estimator is still honest.
      // scripts/vxao-bench.mjs scores the march against brute-force ray-cast AO
      // over the same voxels: rms 0.047 at 1 m, 0.043 at 1.5 m, 0.049 at 2 m,
      // then 0.056 at 2.5 m and 0.068 at 3 m, drifting steadily dark as the
      // top-level cell grows past a metre and its trilinear support starts
      // finding a ceiling from two metres below it. Shorter reaches score no
      // better and cannot see the off-screen occluder the gate is built around
      // — a 0.85 m slab needs ~1.2 m along a 60-degree cone — so 2 m is the
      // point where capability stops being free, not a preference.
      const reach = float(radius).mul(4).max(finest.mul(6)).toVar();

      const trace = (dir) => traceConeAO(origin, dir, tMin, reach, {
        tanHalf: CONE_TAN_HALF,
        steps: CONE_STEPS,
        receiverP: P,
        receiverN: N,
      });

      const visibility = trace(N).mul(W_AXIAL).toVar();
      for (let k = 0; k < SIDE_CONES; k++) {
        const a = (k * 2 * Math.PI) / SIDE_CONES;
        // T and B are unit and orthogonal to N, and SIDE_Z² + SIDE_R² = 1, so
        // this is already normalised — no normalize() in the inner loop.
        const dir = N.mul(SIDE_Z).add(T.mul(Math.cos(a) * SIDE_R)).add(B.mul(Math.sin(a) * SIDE_R));
        visibility.addAssign(trace(dir).mul(W_SIDE));
      }

      // `strength` applies undiluted. The previous arm scaled it by 0.55 to
      // stop it double-darkening contacts the screen estimator also sees — but
      // the resolve composes the two with `min`, which already forbids that,
      // and most of what the factor was actually suppressing was the old
      // march's own receiver-plane self-occlusion, which no longer exists.
      ao.assign(mix(float(1), visibility.clamp(0, 1), float(strength).clamp(0, 1)));
    });

    textureStore(target, ivec2(px.toInt(), py.toInt()), vec4(ao, 0, 0, 1));
  })().compute(width * height);

  compute.__giPassName = "vxao";
  return { compute, target, node: texture(target), widthU, width, height };
}

/**
 * GI-TRACED DIRECT SHADOWS, as their own pass at their OWN resolution.
 *
 * One occupancy shadow cone per gi-flagged light slot. Everything here
 * mirrors the field's analytic-light term (cascadeGather's lightSlots block)
 * on purpose: the same `vector` convention, the same `dist - lift` reach,
 * the same k = 1/angularRadius penumbra. Two terms that disagree about a
 * light's shadow read as the indirect bounce and the direct light coming
 * from different suns.
 *
 * WHY A SEPARATE PASS: the trace behind this texture is the most expensive
 * per-pixel work the module does (~5-7ns/px measured on the user's Sponza —
 * ~10ms of the 4×-pixel Play frame), and nothing ties its resolution to the
 * gather resolve's: the texture is sampled only by materials, through the
 * position-validated bilateral that already reconstructs full-res edges.
 * Its pixel count is therefore its own budget (GISystem #lightShadowSize),
 * and the gbuffer is read at nearest-texel through the resolution ratio.
 */
export function createGiLightShadowPass({ gbuffer, lightShadow, width, height, resolveWidth, resolveHeight, frame = null, checker = null, checkerFill = null }) {
  const widthU = uniform(width, "uint");
  const positionNode = texture(gbuffer.position);
  const normalNode = texture(gbuffer.normal);
  const sx = resolveWidth / width;
  const sy = resolveHeight / height;

  const compute = Fn(() => {
    // ── CHECKERBOARD TRACE (§12.80 Unit B) ───────────────────────────────────
    // With a `checker` uniform (0/1, advanced every frame by GISystem), each
    // dispatch traces HALF the pixels — the half whose (x+y) parity matches —
    // and the other half keeps last frame's texel (the raw/dist targets are
    // persistent; skipping the store IS the fill). The filter's temporal
    // accumulation integrates the two phases exactly as it already integrates
    // the frame-jittered disc samples. THE DISPATCH HALVES, NOT THE LANES: an
    // in-kernel `If(parity)` skip leaves every warp half-active through the
    // whole BVH descent and saves almost nothing — each thread here maps to
    // one traced cell instead, so warps stay dense. `px` clamps rather than
    // guards on an odd width: the worst case re-traces one edge texel.
    let px, py;
    if (checker) {
      const halfW = widthU.add(uint(1)).div(uint(2));
      py = instanceIndex.div(halfW);
      px = instanceIndex.mod(halfW).mul(uint(2))
        .add(py.add(checker).bitAnd(uint(1)))
        .min(widthU.sub(uint(1)));
    } else {
      px = instanceIndex.mod(widthU);
      py = instanceIndex.div(widthU);
    }
    const coord = ivec2(px.toInt(), py.toInt());
    // Nearest gbuffer texel at the (usually finer) resolve resolution.
    const gCoord = ivec2(
      px.toFloat().add(0.5).mul(sx).toInt(),
      py.toFloat().add(0.5).mul(sy).toInt(),
    );
    const g0 = positionNode.load(gCoord).toVar();
    const g1 = normalNode.load(gCoord).toVar();
    // Exactly FOUR slots, because the target has exactly four channels — a
    // fifth gi light keeps its shadow map instead.
    //
    // THE DEFAULT IS 1 (unshadowed) and it is load-bearing: a pixel with no
    // geometry, a slot with no gi-flagged light, a back-facing receiver —
    // every path that does not trace must leave the light untouched. A
    // default of 0 would black out whatever it missed, which is the one
    // failure mode a shadow term must never have.
    const lightShadowVars = Array.from({ length: 4 }, () => float(1).toVar());
    // PCSS blocker distances (normalized by the shadow span; 0 = no blocker
    // = no blur). Only allocated when the device afforded the dist target.
    const lightShadowDistVars = lightShadow.distTarget
      ? Array.from({ length: 4 }, () => float(0).toVar())
      : null;
    If(g0.w.greaterThan(0.5), () => {
      const P = g0.xyz.toVar();
      const rawN = g1.xyz.normalize().toVar();
      // THE LIFT IS 1.5 OCCUPANCY VOXELS, not the gather's `normalOffset`.
      // The trace's own self-plane exclusion is sized off the OCCUPANCY
      // VOXEL (giField's `planeCut`), because that is the quantization of
      // the medium that answers the distance query — conservative
      // voxelization marks every voxel a triangle touches, so a receiver
      // standing on a surface is INSIDE an occupied voxel and reads its own
      // floor as an occluder. The gather's ~0.4m field-cell offset is a
      // different (and here, wrong) scale: too small and every contact
      // point paints a black band; the ray must also START outside its own
      // voxel or the first sample is already a hit.
      lightShadow.slots.slice(0, lightShadowVars.length).forEach((slot, index) => {
        // ── AND A SPOT ONLY SHADOWS INSIDE ITS OWN CONE ────────────────────
        // This trace is the most expensive per-pixel work the module does
        // (~29 ms GPU/frame on the user's Sponza), and outside a spot's cone
        // its light is exactly zero — whatever the march found there gets
        // multiplied by nothing. The channel keeps its load-bearing default of
        // 1 (unshadowed) on the pixels this skips, which is the same value a
        // zero light would have rendered anyway. Non-spot slots return null
        // here and the condition is unchanged.
        const cone = spotReachAt(slot, P);
        const traceGate = slot.giShadow.greaterThan(0.5).and(slot.active.greaterThan(0.5));
        If(cone ? traceGate.and(cone.greaterThan(0)) : traceGate, () => {
          const isDir = float(slot.kind).toVar();
          const rel = vec3(slot.vector).sub(P).toVar();
          const pointDist = rel.length().max(1e-4).toVar();
          // `vector` holds: point → world position, directional → the unit
          // direction TOWARD the light (giLight.analyticDirectAt and
          // cascadeGather use exactly this convention).
          const dir = mix(rel.div(pointDist), vec3(slot.vector), isDir).toVar();
          // A directional light has no position, so its ray runs until the
          // volume ends — the trace's own slab exit clamps it, `span` only
          // has to be generous (the volume diagonal).
          const dist = mix(pointDist, float(lightShadow.span), isDir).toVar();
          // THE SHADOW RAY'S FRAME IS LIGHT-RELATIVE, NEVER CAMERA-RELATIVE:
          // a visibility term keyed to the camera flips coherently across a
          // whole wall near grazing view angles (black one frame, lit the
          // next). An opaque back-lit face gets no analytic light anyway,
          // and for double-sided sheets the light-facing side is exactly
          // the plane the march must start from.
          const cosSigned = dir.dot(rawN).toVar();
          const cosRayNormal = cosSigned.abs().toVar();
          const shadowOrigin = P.add(rawN.mul(cosSigned.sign()).mul(lightShadow.lift)).toVar();
          // Terminator handling, on the ABSOLUTE cosine: under ~3° of
          // incidence a ray hugs its own surface for its whole length and
          // the exhaustion clamp fails it CLOSED — so these rays never
          // march. The skipped value is 0, NOT the inert 1: the GEOMETRIC
          // N·L here is ~0 while the SHADING normal three lights with can
          // carry real N·L — a skipped 1 renders as a full-sun pixel
          // exactly where crumpled leaf normals graze the sun direction
          // (the white-dot population that survived five sampling-side
          // fixes). Only the NO-GEOMETRY path keeps the load-bearing
          // default 1. (`sign()` at exactly 0 zeroes the lift; dark.)
          lightShadowVars[index].assign(0);
          if (globalThis.__giShadowKindDebug === "gate") {
            // TERMINATOR-GATE MAP: raw |cos(ray, N)| ×2 for EVERY slot-active
            // pixel — painted BEFORE the 0.05 gate, so a floor reading ~0
            // here means `dir` itself is broken (zero/tangent slot vector),
            // not a genuinely grazing sun.
            lightShadowVars[index].assign(cosRayNormal.mul(2).clamp(0, 1));
          }
          if (globalThis.__giShadowKindDebug === "diry") {
            // dir.y remapped [-1,1]→[0,1]: 0.5 = zero vector, >0.5 = upward
            // (toward a sun above the horizon), <0.5 = pointing down.
            lightShadowVars[index].assign(dir.y.mul(0.5).add(0.5).clamp(0, 1));
          }
          if (globalThis.__giShadowKindDebug === "normy") {
            // Receiver normal health: rawN.y remapped [-1,1]→[0,1] (floor
            // should read 255; 128 = degenerate/zero normal).
            lightShadowVars[index].assign(rawN.y.mul(0.5).add(0.5).clamp(0, 1));
          }
          If(cosRayNormal.greaterThan(0.05), () => {
            // ANGULAR RADIUS → PENUMBRA. Directional lights carry it
            // directly (`soft`, radians); point/spot lights carry a world
            // RADIUS whose angular size is radius/distance, per pixel. The
            // clamp floors the sharpest usable cone and caps the softest so
            // the analytic k can never approach 1.
            // The 0.35 cap partly existed because the reach-starved
            // estimator made wide k meaningless (the "90° looks like 20°"
            // class) — with the analytic mid-field width supplying real
            // reach, the cap lifts toward the true half-angle (0.78 ≈ the
            // tan cap below; at extreme angles single-ray min-ratio
            // degrades to "openness along the light axis", which is the
            // right read for a half-sky source).
            const rawAngle = mix(float(slot.srcRadius).div(pointDist), float(slot.soft), isDir)
              .max(0)
              .toVar();
            const angle = rawAngle
              .clamp(0.0005, globalThis.__giShadowAnalyticWidth !== false ? 0.78 : 0.35)
              .toVar();
            // The cone arm wants the TRUE half-angle, unclamped — capping
            // it at 0.35 was exactly the "90° looks the same as 20°" bug;
            // tan capped at ~44.7° half-angle only to keep tan() finite.
            const tanHalf = tan(rawAngle.min(0.78)).toVar();
            const maxT = dist.sub(lightShadow.lift).max(0).toVar();
            // Two decorrelated interleaved-gradient-noise channels per
            // SHADOW pixel: rotation angle + disc radius of the cone
            // march's sun-disc direction sample (see its jitter note). The
            // second uses shifted coordinates — same lattice, different
            // phase — which is enough independence for a 2D disc sample.
            // With a `frame` uniform the pattern ANIMATES (golden-ratio
            // increments — a low-discrepancy walk of the sun disc), so the
            // temporal accumulation in the filter pass integrates a NEW
            // disc sample every frame instead of freezing one dither
            // pattern; a wide penumbra converges to the true coverage in
            // ~a dozen frames.
            const ignBase = fract(
              fract(float(coord.x).mul(0.06711056).add(float(coord.y).mul(0.00583715)))
                .mul(52.9829189),
            );
            const ign2Base = fract(
              fract(float(coord.x).add(37).mul(0.06711056).add(float(coord.y).add(17).mul(0.00583715)))
                .mul(52.9829189),
            );
            const ign = frame ? fract(ignBase.add(float(frame).mul(0.618033988749895))) : ignBase;
            const ign2 = frame ? fract(ign2Base.add(float(frame).mul(0.754877666246693))) : ign2Base;
            // DDA marcher when the bundle carries one, sphere trace as the
            // hatched fallback. The receiver point rides along for the
            // record march's origin-plane exclusion; the DDA arm returns
            // vec2(shadow, blockerDist/span).
            const tracedRaw = lightShadow.traceDda
              ? lightShadow.traceDda(shadowOrigin, dir, maxT, float(1).div(angle), P, tanHalf, ign, ign2, cosRayNormal)
              : lightShadow.trace(shadowOrigin, dir, maxT, float(1).div(angle), cosRayNormal);
            const traced = lightShadow.traceDda ? vec2(tracedRaw).toVar() : vec2(tracedRaw, 0).toVar();
            if (lightShadowDistVars) lightShadowDistVars[index].assign(traced.y);
            if (lightShadow.freeRadius) {
              // BURIAL GATE — ask the record-aware oracle how much free space
              // the receiver has on its light side: buried in a canopy reads
              // ~0 → force dark. PROBE HEIGHT IS 3.5 VOXELS, NOT THE 1.5-VOXEL
              // RAY LIFT (2026-08-06, measured on the wall rig): the
              // conservative voxel shell extends TWO rows above a
              // lattice-aligned surface, so a 1.5-voxel probe sits INSIDE the
              // shell — and wherever the shell's top row carries no usable
              // record (voxelize/accumulate predicate disagreement, ~⅓ of
              // floor columns measured) the oracle reads gap 0 and the gate
              // forced open ground BLACK. That population was previously
              // misread as "⅓ exhaustion clamps" (the old kind map multiplied
              // the paint by this very gate), and its lattice-phase
              // alternation is the raw voxel-grid etching on lit floors. At
              // 3.5 voxels the probe clears the worst-case shell: recordless
              // shells read ≥1.1·voxMax (open) while a real canopy within
              // ~0.5m still reads ~0 (dark). `__giBurialProbeHeight`
              // overrides at build time for A/B, like every hatch here.
              const burialH = Number(globalThis.__giBurialProbeHeight) || 3.5;
              const free = float(lightShadow.freeRadius(
                P.add(rawN.mul(cosSigned.sign()).mul(lightShadow.voxMax.mul(burialH))),
              )).toVar();
              const burial = smoothstep(lightShadow.voxMax.mul(0.5), lightShadow.voxMax.mul(1.25), free);
              if (globalThis.__giShadowKindDebug === "burial") {
                // BURIAL-FACTOR MAP: paints the gate itself. The session-29
                // ⅓-"clamped" kind map was read THROUGH the burial multiply
                // below, so a burial-zero pixel and a kind-4 clamp were
                // indistinguishable — this arm separates them.
                lightShadowVars[index].assign(burial);
              } else if (globalThis.__giShadowKindDebug === "free") {
                // FREE-RADIUS MAP: the oracle's raw answer in units of
                // 2·voxMax. ~0.25 = the bare AABB gap (record sharpening not
                // engaging), ~0.7 = the fitted-plane distance (record path
                // works — the gate's smoothstep/uniform is then the suspect).
                lightShadowVars[index].assign(free.div(lightShadow.voxMax.mul(2)).clamp(0, 1));
              } else if (globalThis.__giShadowKindDebug === "freeabs") {
                // ABSOLUTE free radius, ×4 (0.1875m lift → 0.75): separates a
                // zero ORACLE from a zero NORMALIZER in the "free" paint.
                lightShadowVars[index].assign(free.mul(4).clamp(0, 1));
              } else if (globalThis.__giShadowKindDebug === "freenan") {
                // NaN DETECTor: rgba8 stores NaN as 0, so a NaN-poisoned
                // oracle is indistinguishable from "buried" in every scalar
                // map. White = NaN here.
                lightShadowVars[index].assign(select(free.notEqual(free), float(1), float(0)));
              } else if (globalThis.__giShadowKindDebug === "free075") {
                // RECORD-HEALTH PROBE: the oracle at P + 0.75·voxMax·N — a
                // point INSIDE the receiver's own surface voxel, where the
                // AABB gap is 0 by construction and only the fitted-plane
                // record can answer nonzero (~0.63 voxels → paint ~0.31).
                // Zero here = the cell's record is missing/unusable.
                const free075 = float(lightShadow.freeRadius(
                  P.add(rawN.mul(lightShadow.voxMax.mul(0.75))),
                )).toVar();
                lightShadowVars[index].assign(free075.mul(4).clamp(0, 1));
              } else if (globalThis.__giShadowKindDebug === "voxmax") {
                // The voxMax uniform itself, ×4 (0.125m → 0.5): a stale/zero
                // voxel scale here zeroes the lift AND the burial thresholds.
                lightShadowVars[index].assign(lightShadow.voxMax.mul(4).clamp(0, 1));
              } else if (
                globalThis.__giShadowKindDebug === "gate" ||
                globalThis.__giShadowKindDebug === "diry" ||
                globalThis.__giShadowKindDebug === "normy"
              ) {
                // Pre-gate paints (assigned above the cos If) — keep them.
              } else if (globalThis.__giShadowKindDebug) {
                // Any kind-paint mode: bypass the burial multiply so the map
                // shows the MARCHER's verdict, uncorrupted by the gate.
                lightShadowVars[index].assign(traced.x);
              } else {
                lightShadowVars[index].assign(traced.x.mul(burial));
              }
            } else {
              lightShadowVars[index].assign(traced.x);
            }
          });
        });
      });
    });
    if (lightShadowDistVars) {
      textureStore(
        lightShadow.distTarget,
        coord,
        vec4(lightShadowDistVars[0], lightShadowDistVars[1], lightShadowDistVars[2], lightShadowDistVars[3]),
      );
    }
    // Into the RAW texture when the bundle carries one (the spatial filter
    // pass averages it into the sampled target); straight to the target
    // otherwise (filter unavailable — degraded but correct).
    textureStore(
      lightShadow.rawTarget ?? lightShadow.target,
      coord,
      vec4(lightShadowVars[0], lightShadowVars[1], lightShadowVars[2], lightShadowVars[3]),
    );
    if (checker && checkerFill) {
      // ── §14 Q3: THE HOLD IS ONLY VALID AT REST ─────────────────────────────
      // The untraced half keeps last frame's texel AT THE SAME SCREEN COORD.
      // Parked, that is exact. Under camera motion it is a checkerboard of a
      // STALE WORLD — and the temporal accumulation §12.80.2 counted on to
      // integrate the phases does not exist on the default analytic arm
      // (`history: null`), so the pattern reached the screen. While the
      // camera moves (`checkerFill` = 1, set by GISystem from the VP delta),
      // each traced thread also stamps its result onto its stale row
      // neighbour: the channel is horizontally half-res for that frame
      // instead of wrong — soft beats blocky — at zero extra rays. Writers
      // cannot collide: traced columns are 2 apart, each stale column has
      // exactly one right-writing owner (plus the px==1 edge case for
      // column 0).
      If(float(checkerFill).greaterThan(0.5), () => {
        const nx = px.toInt().add(
          select(px.equal(widthU.sub(uint(1))), int(-1), int(1)),
        ).toVar();
        const nCoord = ivec2(nx, py.toInt());
        if (lightShadowDistVars) {
          textureStore(
            lightShadow.distTarget,
            nCoord,
            vec4(lightShadowDistVars[0], lightShadowDistVars[1], lightShadowDistVars[2], lightShadowDistVars[3]),
          );
        }
        textureStore(
          lightShadow.rawTarget ?? lightShadow.target,
          nCoord,
          vec4(lightShadowVars[0], lightShadowVars[1], lightShadowVars[2], lightShadowVars[3]),
        );
        If(px.equal(uint(1)), () => {
          const lCoord = ivec2(int(0), py.toInt());
          if (lightShadowDistVars) {
            textureStore(
              lightShadow.distTarget,
              lCoord,
              vec4(lightShadowDistVars[0], lightShadowDistVars[1], lightShadowDistVars[2], lightShadowDistVars[3]),
            );
          }
          textureStore(
            lightShadow.rawTarget ?? lightShadow.target,
            lCoord,
            vec4(lightShadowVars[0], lightShadowVars[1], lightShadowVars[2], lightShadowVars[3]),
          );
        });
      });
    }
  })().compute((checker ? Math.ceil(width / 2) : width) * height);

  return { compute, widthU };
}

/**
 * EMITTER SHADOWS as their own pass at the shadow-channel budget
 * (2026-08-06). These traces used to run inside the resolve kernel — one
 * record march (or sphere trace) per RESOLVE pixel per emitter slot, so a
 * scene with several emissive objects paid up to 4 marches × the resolve's
 * 1.6M-pixel budget every frame ("fps drops too quickly with more emissive
 * objects"). This pass runs the identical estimator (emitterSlotShadow —
 * shared with the resolve's hit-shading path) at the SHADOW pixel budget,
 * writes the raw 4-channel result, and the edge-aware filter pass averages
 * it into `emitterShadow` — which also gives the emitter channel the
 * spatial filter it never had (a good part of the coarse-preset
 * blockiness). The resolve and materials then just sample the texture.
 *
 * `cameraPosition` (optional) reproduces the resolve's facing flip so both
 * kernels shade the same side of double-sided geometry; without a camera
 * the raw gbuffer normal is used, exactly like the resolve's own fallback.
 *
 * `distTarget` (optional, 2026-08-13) is the ANALYTIC-PENUMBRA channel: one
 * world-space penumbra HALF-WIDTH in metres per slot, computed from the
 * blocker distance the static-BVH trace already returns (see GISystem's
 * #buildEmitterRecordTrace). It exists only on the arm whose trace advertises
 * `withPenumbra`; with the width-probe arm the marcher carries softness in
 * the shadow value itself and this channel would be all zeros.
 */
export function createGiEmitterShadowPass({
  gbuffer, emitter, normalOffset, target, width, height, resolveWidth, resolveHeight,
  cameraPosition = null, distTarget = null, tileCut = null, frame = null, checker = null,
  // §11.40: `{ read: { vis, t, stamp }, write: { vis, t, stamp } }` cache
  // textures (createGiTargets; the pass loads `read` and stores `write`, a
  // snapshot pass copies write -> read after it), the static generation
  // uniform (uint, bumps when the static g-buffer key moves) and the refresh
  // stride uniform (uint; 1 = march every pixel, S = one in S on movers-only
  // frames). Only the seat-rotating arm consults the cache.
  staticCache = null, staticGen = null, staticStride = null,
  // §11.11 (2026-09-03) ONE SEAT PER PIXEL PER FRAME. With a `seatPhase`
  // uniform (advanced by GISystem once per DISPATCH of this pass — not per
  // frame, or the movers-only stride-2 cadence would visit only two of the
  // four seats at every pixel) each pixel marches a single seat,
  //   k = (x + 2·y + phase) mod seatCount,
  // so every 2×2 block of the grid holds every live seat every frame and
  // every 3×3 window holds each of them at least once. The other live seats
  // are written as −1 (NOT SAMPLED); createGiLightShadowFilterPass in its
  // `sparse` mode reconstructs them from the same-frame neighbours that did
  // march them, and the temporal chain integrates across frames exactly as
  // it integrates the checkerboard. The march count per pixel goes 4 → 1
  // (the pass was ~640 k any-hit rays a frame on the user's Bistro — as
  // many as the whole transport). Empty seats (beyond the tile's count)
  // are written as 1 / width 0, the pass's load-bearing "unshadowed"
  // default, exactly as the dense arm leaves them.
  seatPhase = null,
}) {
  const widthU = uniform(width, "uint");
  const positionNode = texture(gbuffer.position);
  const normalNode = texture(gbuffer.normal);
  const sx = resolveWidth / width;
  const sy = resolveHeight / height;
  const cacheOn = !!(staticCache?.read && staticCache?.write && staticGen && staticStride && seatPhase);
  const cacheVisNode = cacheOn ? texture(staticCache.read.vis) : null;
  const cacheTNode = cacheOn ? texture(staticCache.read.t) : null;
  const cacheStampNode = cacheOn ? texture(staticCache.read.stamp) : null;

  const compute = Fn(() => {
    const px = instanceIndex.mod(widthU);
    const py = instanceIndex.div(widthU);
    const coord = ivec2(px.toInt(), py.toInt());
    // ── CHECKERBOARD (2026-09-02) ──────────────────────────────────────────
    // Half the pixels march each dispatch, alternating with the frame; the
    // skipped half keeps last frame's raw in `target` and the temporal chain
    // that already integrates the per-frame area jitter integrates this too.
    // Only with a `frame` (= the chain exists) and while `checker` is 1 —
    // GISystem zeroes it on movers-only frames, where the pass already runs
    // every other frame, so no pixel is ever refreshed slower than every
    // second dispatch. Measured need: 11.7 ms per dispatch on the user's
    // Bistro (466×280, ≤ 4 seats per tile, 116 emitters).
    if (frame && checker) {
      const parity = px.add(py).add(uint(frame)).bitAnd(uint(1));
      If(uint(checker).equal(uint(1)).and(parity.equal(uint(1))), () => {
        Return();
      });
    }
    const gCoord = ivec2(
      px.toFloat().add(0.5).mul(sx).toInt(),
      py.toFloat().add(0.5).mul(sy).toInt(),
    );
    const g0 = positionNode.load(gCoord).toVar();
    const g1 = normalNode.load(gCoord).toVar();
    // Default 1 (unshadowed) is load-bearing exactly as in the light-shadow
    // pass: every no-geometry / inactive-slot path must leave the emitter's
    // light untouched.
    const shadowVars = Array.from({ length: MAX_EMITTERS }, () => float(1).toVar());
    // WIDTH-MAP PAINT (`__giEmitterWidthDebug = <metres>`): stamps the
    // analytic penumbra half-width into the SHADOW channel, normalized by
    // that many metres, instead of the visibility. It is how the width is
    // inspected at all — the dist target is rgba16float, which no readback in
    // this repo decodes, and the whole claim of this arm ("the penumbra grows
    // with blocker distance") is a claim about this number's gradient. Pair
    // it with `__giEmitterWidePass = false` or the wide passes blur the map.
    const widthDebug = Number(globalThis.__giEmitterWidthDebug);
    const widthPaint = Number.isFinite(widthDebug) && widthDebug > 0 ? widthDebug : 0;
    // DEFAULT 0 = no penumbra = no blur, the fail-SHARP direction and the
    // right one here: every path that does not trace (no geometry, inactive
    // slot, grazing receiver) already leaves a shadow of 1, and blurring a
    // constant costs texture reads for nothing.
    const distVars = distTarget || widthPaint
      ? Array.from({ length: MAX_EMITTERS }, () => float(0).toVar())
      : null;
    // §11.40: the pixel's cache rows, loaded once, written back once (the
    // seat marched this frame replaces its own channel; the others ride).
    const cVis = cacheOn ? vec4(cacheVisNode.load(coord)).toVar() : null;
    const cT = cacheOn ? vec4(cacheTNode.load(coord)).toVar() : null;
    const cStamp = cacheOn ? vec4(cacheStampNode.load(coord)).toVar() : null;
    If(g0.w.greaterThan(0.5), () => {
      const P = g0.xyz.toVar();
      const rawN = g1.xyz.normalize().toVar();
      const facing = cameraPosition
        ? step(0, rawN.dot(vec3(cameraPosition).sub(P))).mul(2).sub(1)
        : float(1);
      const N = rawN.mul(facing).toVar();
      const samplePoint = P.add(N.mul(normalOffset)).toVar();
      // §12.70 W4b slice (ii): under the tile cut, the marched slots are the
      // PIXEL'S TILE's id-keyed emitters loaded from tree records — the same
      // `emitterSlotShadow` estimator, fed a pseudo-slot instead of a seat
      // uniform. Channel i ≡ the tile's i-th emitter BY ID (giScreen's
      // createGiEmitterTileCutPass sorted them), consistent with what the
      // resolve reconstructs at every pixel of the same tile.
      const tile = tileCut
        ? py.div(uint(tileCut.tileSize)).min(uint(tileCut.tilesY - 1))
            .mul(uint(tileCut.tilesX))
            .add(px.div(uint(tileCut.tileSize)).min(uint(tileCut.tilesX - 1)))
            .toVar()
        : null;
      const tileIds = tileCut
        ? [0, 1, 2, 3].map((k) => tileCut.idBuf.element(tile.mul(4).add(uint(k))).toVar())
        : null;
      const slots = tileCut
        ? tileIds.map((id) => tileCut.recordSlot(id))
        : emitter.emitterSlots.slice(0, MAX_EMITTERS);
      // §11.11: the tile's LIVE seat count — the cut sorts by id, so empties
      // (0xffffffff) sink to the end and the live seats are 0..count−1. The
      // global-seat arm has no per-pixel count and rotates over all four.
      const seatCount = seatPhase
        ? (tileIds
            ? tileIds.reduce(
                (acc, id) => acc.add(select(id.notEqual(uint(0xffffffff)), int(1), int(0))),
                int(0),
              ).toVar()
            : int(slots.length))
        : null;
      // §14 Q7: per-pixel, per-frame IGN pair for the area sample — the same
      // decorrelated lattice + golden-ratio walk the light pass uses. Only
      // built when a `frame` uniform arrives, which GISystem sends exactly
      // when the emitter temporal chain exists to integrate it (a jittered
      // ray with no EMA behind it is just shimmer).
      const targetJitter = frame
        ? (() => {
            const ignBase = fract(
              fract(float(coord.x).mul(0.06711056).add(float(coord.y).mul(0.00583715)))
                .mul(52.9829189),
            );
            const ign2Base = fract(
              fract(float(coord.x).add(37).mul(0.06711056).add(float(coord.y).add(17).mul(0.00583715)))
                .mul(52.9829189),
            );
            return vec2(
              fract(ignBase.add(float(frame).mul(0.618033988749895))),
              fract(ign2Base.add(float(frame).mul(0.754877666246693))),
            ).toVar();
          })()
        : null;
      // ⚠⚠ THE LOOP BELOW IS A GPU LOOP, AND THAT IS THE WHOLE POINT.
      //
      // It used to be `slots.forEach(...)` — a JS loop, so it unrolled at
      // graph-build time and emitted the WHOLE of `emitterSlotShadow` four
      // times: four analytic-shape evaluations, four record marches, four
      // BVH descents. Measured in the dumped WGSL: `giDynTrace00110` and
      // `giEmitterFactor` each appeared at FOUR call sites, and the kernel
      // carried 4 loops / 216 ifs at 103 kB.
      //
      // That made this ONE pipeline the whole of GI's startup cost on the
      // user's Level: `probe:gi-boot` warm read it at 5.3–11.7 s across two
      // boots, i.e. 81–90% of time-to-first-correct-frame, while a 250 kB
      // kernel beside it compiled in 4.0 s. §13.14.5's per-inline law is the
      // explanation and the fix: cost tracks CALL SITES, not bytes.
      //
      // Rolling keeps every property that mattered. Each slot still gets its
      // own full march, its own analytic factor and its own admission gate —
      // this is an EMISSION change, not an estimator change, exactly as the
      // light-slot roll in `createSrcHitLighting` was. MAX_EMITTERS stays a
      // compile-time 4 so a lamp edit is still a uniform write (R11).
      //
      // The predicated gather (`select` a virtual slot per iteration, then
      // `select` the result back out) is the same shape `srcShade.js` uses
      // for the light slots and `neeIrradiance` uses for the emitter CDF:
      // funnel N cheap alternatives into ONE expensive call.
      //
      // Keys are intersected rather than listed, so a field added to the slot
      // shape later (the seats carry `exHalf`/`moved` that the tile-cut
      // pseudo-slots do not) is carried through without a second definition
      // of what a slot is going stale here.
      const slotKeys = Object.keys(slots[0] ?? {})
        .filter((k) => slots.every((s) => s?.[k] != null));
      const virtualSlot = (i) => {
        const virt = {};
        for (const key of slotKeys) {
          let acc = slots[0][key];
          for (let k = 1; k < slots.length; k++) acc = select(i.equal(int(k)), slots[k][key], acc);
          virt[key] = acc;
        }
        return virt;
      };
      if (seatPhase) {
        // §11.11: ONE march. The lattice lane is a 2×2-complete pattern
        // (x + 2y covers 0..3 in every block); reduced mod the live count so
        // a one-lamp tile marches its lamp every frame and never wastes a
        // sample on an empty seat. Integer mod spelled out (a − (a/n)·n) so
        // it compiles the same on every backend.
        const n = seatCount.max(int(1)).toVar();
        const lane = px.add(py.mul(uint(2))).add(uint(seatPhase)).bitAnd(uint(3)).toInt().toVar();
        const k = lane.sub(lane.div(n).mul(n)).toVar();
        const pen = distVars ? float(0).toVar() : null;
        // §11.40: the seat's cache entry, and whether this pixel re-marches
        // the static world this frame (stride 1 = always; on movers-only
        // frames one pixel in S, walking with the frame).
        let cache = null;
        if (cacheOn) {
          const chan = (v4) => select(k.equal(int(0)), v4.x, select(k.equal(int(1)), v4.y, select(k.equal(int(2)), v4.z, v4.w)));
          const idSel = tileIds
            ? float(select(k.equal(int(0)), tileIds[0], select(k.equal(int(1)), tileIds[1], select(k.equal(int(2)), tileIds[2], tileIds[3]))).min(uint(4095)))
            : k.toFloat();
          // Never 0 (a fresh cache texture is all zeros and must read INVALID),
          // exact in f32 for gen < 1024 (GISystem wraps it at 1024).
          const stampWant = float(staticGen).add(1).mul(8192).add(idSel).add(1).toVar();
          const strideU = uint(staticStride).max(uint(1)).toVar();
          const phase = px.add(py.mul(uint(3))).add(frame ? uint(frame) : uint(0)).mod(strideU);
          const setChan = (v4, value) => v4.assign(vec4(
            select(k.equal(int(0)), value, v4.x),
            select(k.equal(int(1)), value, v4.y),
            select(k.equal(int(2)), value, v4.z),
            select(k.equal(int(3)), value, v4.w),
          ));
          cache = {
            valid: chan(cStamp).equal(stampWant),
            vis: chan(cVis),
            t: chan(cT),
            march: strideU.equal(uint(1)).or(phase.equal(uint(0))),
            store: (vis, t) => { setChan(cVis, vis); setChan(cT, t); setChan(cStamp, stampWant); },
          };
        }
        const s = float(
          emitterSlotShadow(cache ? { ...emitter, staticCache: cache } : emitter, virtualSlot(k), P, N, samplePoint, pen, targetJitter),
        ).toVar();
        for (let j = 0; j < slots.length; j++) {
          const take = k.equal(int(j));
          const live = int(j).lessThan(seatCount);
          shadowVars[j].assign(select(take, s, select(live, float(-1), float(1))));
          if (distVars) distVars[j].assign(select(take, pen, select(live, float(-1), float(0))));
        }
      } else {
        Loop({ start: int(0), end: int(slots.length), type: "int", condition: "<" }, ({ i }) => {
          const virt = virtualSlot(i);
          const pen = distVars ? float(0).toVar() : null;
          const s = float(
            emitterSlotShadow(emitter, virt, P, N, samplePoint, pen, targetJitter),
          ).toVar();
          for (let k = 0; k < slots.length; k++) {
            const take = i.equal(int(k));
            shadowVars[k].assign(select(take, s, shadowVars[k]));
            if (distVars) distVars[k].assign(select(take, pen, distVars[k]));
          }
        });
      }
    });
    const paint = widthPaint
      ? distVars.map((v) => v.div(widthPaint).clamp(0, 1))
      : shadowVars;
    textureStore(target, coord, vec4(paint[0], paint[1], paint[2], paint[3]));
    if (distTarget) {
      textureStore(distTarget, coord, vec4(distVars[0], distVars[1], distVars[2], distVars[3]));
    }
    if (cacheOn) {
      textureStore(staticCache.write.vis, coord, cVis);
      textureStore(staticCache.write.t, coord, cT);
      textureStore(staticCache.write.stamp, coord, cStamp);
    }
  })().compute(width * height);

  return { compute, widthU };
}

/**
 * §11.40 — the static visibility cache's ping-pong: copies the marcher's
 * WRITE set into the READ set it loads on its next dispatch. Runs right after
 * createGiEmitterShadowPass in the emitter chain, every time it runs.
 */
export function createGiEmitterStaticSnapshotPass({ cache, width, height }) {
  const widthU = uniform(width, "uint");
  const visNode = texture(cache.write.vis);
  const tNode = texture(cache.write.t);
  const stampNode = texture(cache.write.stamp);
  const compute = Fn(() => {
    const px = instanceIndex.mod(widthU);
    const py = instanceIndex.div(widthU);
    const coord = ivec2(px.toInt(), py.toInt());
    textureStore(cache.read.vis, coord, vec4(visNode.load(coord)));
    textureStore(cache.read.t, coord, vec4(tNode.load(coord)));
    textureStore(cache.read.stamp, coord, vec4(stampNode.load(coord)));
  })().compute(width * height);
  return { compute, widthU };
}

/**
 * §12.70 W4b — THE PER-TILE EMITTER CUT. One thread per TILE of the
 * emitter-shadow grid: reconstruct the tile-centre receiver from the gbuffer
 * (the same load + facing flip the shadow pass applies per pixel), rank EVERY
 * light-tree emitter record by `clusterImportance` at that receiver, keep the
 * top MAX_EMITTERS. Deterministic — no draws, no history; the selection can
 * only change when the scene or the camera does.
 *
 * ⚠ CHANNEL KEYING IS BY EMITTER ID, NOT BY RANK. The kept 4 are sorted
 * ascending by id before writing, so wherever two adjacent tiles agree on the
 * SET, they agree on every channel's meaning — at ≤4 emitters that is
 * everywhere, which is what makes the future consumer swap byte-comparable
 * to the global slots. Rank order is deliberately discarded: it is the one
 * thing neighbouring tiles are ALLOWED to disagree on without artifacts.
 *
 * An emitter whose importance is ZERO at the tile centre is excluded even if
 * seats are free (strict `>` against an empty slot's 0): the emission-cone /
 * behind-horizon cases the importance already prices. Empty seats read
 * 0xffffffff. A sky tile (no geometry) writes an all-empty list, valid 0.
 *
 * O(N) scan, not a tree walk, ON PURPOSE: tiles number thousands (not
 * millions of pixels), records max out at 127/leaf, and one inlined
 * importance inside a GPU loop beats a best-first traversal's stack at every
 * N the block can hold. The TREE remains [J]'s sampling structure (§12.69);
 * the screen needs only the ranking key — `createLightTreeEmitterImportance`,
 * the same `buildImportanceMath` the descent compiles.
 *
 * Consumerless in this slice: the rig reads `posBuf`/`idBuf` back and
 * verifies the sets against the CPU's `emitterImportance` at the SAME
 * reconstructed P (§12.70 W4b gate). emitterShadowPass/emitterDirectAt swap
 * onto `idBuf` in the next slice.
 *
 * @param {(P,N,hasN,base,id)=>Node} options.importance
 *   from createLightTreeEmitterImportance(words) — caller-built so this file
 *   stays free of the lightTree modules.
 */
export function createGiEmitterTileCutPass({
  gbuffer, importance, baseWord, emitterCount, tileSize, width, height,
  resolveWidth, resolveHeight, cameraPosition = null,
}) {
  const tilesX = Math.ceil(width / tileSize);
  const tilesY = Math.ceil(height / tileSize);
  const tileCount = tilesX * tilesY;
  // §12.70 W4c — TAIL COMPENSATION CAP. A top-4 cut without compensation is
  // the seam: neighbouring tiles that keep DIFFERENT sets drop DIFFERENT
  // tails, and the missing energy steps at the boundary. `Σimp / Σimp(kept)`
  // is Walter's lightcuts answer — the kept representatives carry the tail's
  // power, so the delivered TOTAL is continuous even where the SET is not.
  // Capped because the ratio is N/4 when every emitter matters equally, and
  // an uncapped multiply would turn a 40-lamp tile's four survivors into
  // ten-times-too-bright pinpoints. `__giTileCutCompensate = 1` disables it
  // (the A/B arm), a number raises/lowers the cap.
  //
  // ⚠ THE TAIL RIDES THE KEPT LAMPS' VISIBILITY, NOT ITS OWN. `importance`
  // has no occlusion term, so a dropped lamp behind a wall still counts
  // toward Σ and its energy arrives through whichever lamps the pixel did
  // keep. Measured harmless where the tail is genuinely visible (the emissive
  // storm: p50 1.17, mean +2.7% canvas energy over the uncompensated arm);
  // the cap is 2 rather than the natural N/4 precisely to bound what that
  // assumption can cost in a room-partitioned scene, and clipping
  // under-delivers, which is the safe direction. An occlusion-aware tail is
  // the honest fix and is not in this slice.
  const compCapRaw = Number(globalThis.__giTileCutCompensate);
  const compCap = Number.isFinite(compCapRaw) ? Math.max(1, compCapRaw) : 2;
  // §13.8 — THE SOFT CUT. The compensation above makes the delivered ENERGY
  // continuous across a set change and says nothing about HUE: a tile keeping
  // 3 warm + 1 cyan and its neighbour keeping 4 warm deliver the same energy
  // in different COLOURS, which is a hue step with no brightness step — the
  // user's "emissives of different colours don't blend, there are hard seams".
  //
  // MEASURED before the fix (`npm run probe:gi-colour-seam`, 24 alternating
  // warm/cyan/magenta strips, adjacent floor tiles bucketed by kept-set
  // symmetric difference — tiles that AGREE on the set are the matched
  // control): Δchroma at a set change is **×4.89 the control at p50, ×7.56 at
  // p99, while Δluminance is ×1.08**. Exactly the predicted signature. The
  // mono-colour NULL (same lamps, one colour, the same 17.7% of boundaries
  // changing set) reads ×1.13 — so it is the colour disagreement and not the
  // switching that costs.
  //
  // THE FIX: give every kept emitter a weight that fades to zero as its own
  // importance approaches the best REJECTED one, then renormalize the weights
  // back onto the same importance sum. At any crossing the two emitters
  // trading places have equal importance and therefore equal weight, so the
  // exchange is invisible — the cut becomes continuous rather than merely
  // energy-conserving. `feather` is the ramp width as a fraction of the
  // member's own importance: 0.5 = full strength once the runner-up is below
  // half of it. 0 restores the hard cut BIT-IDENTICALLY (the A/B arm).
  const featherRaw = Number(globalThis.__giTileCutFeather);
  const feather = Number.isFinite(featherRaw) ? Math.min(1, Math.max(0, featherRaw)) : 0.5;
  // Three buffers' worth of state in two, no bit-casting: THREE vec4 floats
  // per tile — [P.xyz, valid], [N.xyz, compensation] (the rig's CPU mirror
  // re-ranks at this exact receiver, and the importance needs BOTH), then
  // [w0..w3], the per-CHANNEL soft-cut weights — plus 4 u32 ids per tile.
  // The weights ride here rather than in a buffer of their own because the
  // resolve is at the portable 8-storage-buffer limit; a third binding there
  // is a pipeline that silently fails to validate.
  const posBuf = instancedArray(new Float32Array(tileCount * 12), "vec4");
  const idBuf = instancedArray(new Uint32Array(tileCount * 4), "uint");
  const tilesXU = uniform(tilesX, "uint");
  const positionNode = texture(gbuffer.position);
  const normalNode = texture(gbuffer.normal);
  const sx = resolveWidth / width;
  const sy = resolveHeight / height;

  const compute = Fn(() => {
    const tx = instanceIndex.mod(tilesXU);
    const ty = instanceIndex.div(tilesXU);
    // Tile-centre pixel in emitter-shadow res, scaled into gbuffer coords —
    // the per-pixel shadow pass's own mapping, applied at the tile centre.
    const gCoord = ivec2(
      tx.toFloat().add(0.5).mul(tileSize).mul(sx).toInt(),
      ty.toFloat().add(0.5).mul(tileSize).mul(sy).toInt(),
    );
    const g0 = positionNode.load(gCoord).toVar();
    const g1 = normalNode.load(gCoord).toVar();
    const ids = [0, 1, 2, 3].map(() => uint(0xffffffff).toVar());
    const imps = [0, 1, 2, 3].map(() => float(0).toVar());
    const outN = vec3(0, 1, 0).toVar();
    const impTotal = float(0).toVar();
    // §13.8: the RUNNER-UP — the largest importance that did NOT make the cut.
    // It is what rank 3 is about to swap with, so it is the whole feather.
    const impNext = float(0).toVar();
    If(g0.w.greaterThan(0.5), () => {
      const P = g0.xyz.toVar();
      const rawN = g1.xyz.normalize().toVar();
      const facing = cameraPosition
        ? step(0, rawN.dot(vec3(cameraPosition).sub(P))).mul(2).sub(1)
        : float(1);
      const N = rawN.mul(facing).toVar();
      outN.assign(N);
      // §12.70 W5: the bound is a NODE when the caller passes one — a live
      // tree refresh (a lamp moved, a mesh went invisible) can change the
      // emitter count without a GI rebuild, and a baked constant would then
      // either walk records the new tree no longer has or stop short of the
      // ones it does. `uint()` of a number still bakes, so the static callers
      // and the fixtures are unchanged.
      Loop({ start: uint(0), end: uint(emitterCount), type: "uint", condition: "<" }, ({ i }) => {
        const imp = float(importance(P, N, float(1), uint(baseWord), i)).toVar();
        impTotal.addAssign(imp);
        // READ BEFORE THE CHAIN MUTATES IT. Whatever leaves the top four this
        // iteration is either the old rank 3 (if this emitter displaced it) or
        // this emitter itself — and `imp > old3` is exactly the chain's own
        // insertion condition, so the two can never disagree.
        const old3 = imps[3].toVar();
        // Predicated 4-slot insertion, strict `>`: ties keep the EARLIER id
        // in the higher rank — the rig's CPU mirror replicates exactly this.
        If(imp.greaterThan(imps[0]), () => {
          imps[3].assign(imps[2]); ids[3].assign(ids[2]);
          imps[2].assign(imps[1]); ids[2].assign(ids[1]);
          imps[1].assign(imps[0]); ids[1].assign(ids[0]);
          imps[0].assign(imp); ids[0].assign(i);
        }).ElseIf(imp.greaterThan(imps[1]), () => {
          imps[3].assign(imps[2]); ids[3].assign(ids[2]);
          imps[2].assign(imps[1]); ids[2].assign(ids[1]);
          imps[1].assign(imp); ids[1].assign(i);
        }).ElseIf(imp.greaterThan(imps[2]), () => {
          imps[3].assign(imps[2]); ids[3].assign(ids[2]);
          imps[2].assign(imp); ids[2].assign(i);
        }).ElseIf(imp.greaterThan(imps[3]), () => {
          imps[3].assign(imp); ids[3].assign(i);
        });
        impNext.assign(impNext.max(select(imp.greaterThan(old3), old3, imp)));
      });
    });
    // ── §13.8 THE SOFT CUT'S WEIGHT ─────────────────────────────────────────
    //
    // ⚠ THE WEIGHT IS PER EMITTER, NOT PER RANK, AND THAT DISTINCTION IS THE
    // WHOLE FIX. Fading only rank 3 was the obvious version and it was
    // MEASURED (feather 0.5, 24 lamps): the seam's median fell ×3 (Δchroma at
    // a set change 0.0738 → 0.0243) but the CONTROL — boundaries where the set
    // does NOT change — got worse, p90 0.037 → 0.070. A weight attached to a
    // RANK jumps when two kept members merely trade places: X at rank 2 has
    // weight 1 and at rank 3 has weight w, so a 2↔3 swap steps the image by
    // (1−w)·(L_X − L_Y) while the SET never changed. That is a seam the census
    // files under setDiff 0, which is exactly where it showed up.
    //
    // A weight that is a function of the emitter's OWN importance has no such
    // hole: at ANY crossing the two emitters involved have EQUAL importance by
    // definition of a crossing, so they have equal weight, so exchanging them
    // changes nothing. Every pairwise discontinuity in the cut closes at once.
    //
    // `impNext` (the best REJECTED importance) is the threshold, and it is
    // continuous in P for the same reason: it is an order statistic of
    // continuous functions.
    const wRaw = imps.map((imp) => (feather > 0
      ? select(
          imp.greaterThan(0),
          smoothstep(0, 1, imp.sub(impNext).div(imp.mul(feather).max(1e-20))),
          float(0),
        ).toVar()
      : float(1).toVar()));
    // RENORMALIZED ONTO THE SURVIVORS, or the fade would be a brightness dip
    // instead of a hue blend: `Σ wRaw·imp` is scaled back to `Σ imp`, so the
    // faded member's energy moves to the members that stayed and the tail
    // compensation below keeps its EXACT pre-§13.8 value and meaning. The
    // scale is bounded by the slot count (wRaw_k ≤ Σ wRaw so w_k ≤ 4), and the
    // degenerate all-tied tile — where every weight vanishes together — falls
    // back to the hard cut, which is the correct limit of the uniform case.
    const w = wRaw.map((wr) => wr.toVar());
    if (feather > 0) {
      const den = wRaw[0].mul(imps[0]).add(wRaw[1].mul(imps[1]))
        .add(wRaw[2].mul(imps[2])).add(wRaw[3].mul(imps[3])).toVar();
      const num = imps[0].add(imps[1]).add(imps[2]).add(imps[3]).toVar();
      const scale = num.div(den.max(1e-30)).toVar();
      const degenerate = den.lessThanEqual(num.mul(1e-4));
      for (let k = 0; k < 4; k++) w[k].assign(select(degenerate, float(1), wRaw[k].mul(scale)));
    }
    // The by-id sort (empties = 0xffffffff sink to the end): a 5-swap network
    // on 4 elements, each swap predicated. THE WEIGHTS RIDE THE SAME
    // PERMUTATION — they are per-CHANNEL once written, and the channel a rank
    // lands in is exactly what this sort decides.
    const cswap = (a, b) => {
      const doSwap = ids[a].greaterThan(ids[b]);
      const t = ids[a].toVar();
      ids[a].assign(select(doSwap, ids[b], ids[a]));
      ids[b].assign(select(doSwap, t, ids[b]));
      const tw = w[a].toVar();
      w[a].assign(select(doSwap, w[b], w[a]));
      w[b].assign(select(doSwap, tw, w[b]));
    };
    cswap(0, 1); cswap(2, 3); cswap(0, 2); cswap(1, 3); cswap(1, 2);
    // The compensation rides in the normal vec4's free `.w` — one scalar per
    // tile, written whether or not the consumer is armed so the rig can read
    // the distribution back on either arm. `kept` sums the SELECTION, which
    // the id-sort above only permutes; an empty seat contributes its 0.
    // §13.8 leaves this line alone ON PURPOSE: the soft cut renormalizes its
    // own weights so that `Σ w·imp ≡ Σ imp`, so the selection's importance
    // sum — and therefore the tail compensation and every W4c receipt — is
    // untouched by the fade.
    const kept = imps[0].add(imps[1]).add(imps[2]).add(imps[3]).toVar();
    // ── §13.10: THE CAP IS A CORNER, AND A CORNER IS A LINE ─────────────────
    //
    // `clamp(ratio, 1, cap)` is continuous in VALUE and broken in SLOPE at
    // `ratio == cap`. `ratio = Σall/Σkept` is a smooth field over the floor, so
    // that corner traces a smooth CURVE across it — and a slope discontinuity
    // inside an otherwise smooth gradient is exactly what the eye resolves as a
    // line (Mach banding). With 54 emitters the ratio sits near the cap over
    // most of a room, so the curve lands in open floor, which is where the user
    // kept seeing "weird seams between the lights" after the §13.8 soft cut had
    // taken the set-change steps out (2026-08-19).
    //
    // Bisected to here: the seam survives `__giSrcProbes=false` (so it is the
    // DIRECT term), the emitter shadow channels read near-white with only small
    // blobs (so it is not visibility), it is unmoved by probe spacing, by the
    // feather and by the wide passes — and `__giTileCutCompensate=1`, which
    // deletes this term outright, gave the lowest pooled tails of any arm.
    // ⚠ THE ARM THAT LOOKED LIKE A SHADOW VERDICT WAS CONFOUNDED:
    // `emissiveShadows:false` also leaves the tile cut UNARMED, so it removed
    // this compensation too — that is why it cleaned the floor.
    //
    // The soft cap has the same two limits (1 at ratio 1, `cap` at infinity)
    // and the same initial slope, with no corner anywhere:
    //     comp = 1 + (cap−1)·(1 − e^−(ratio−1)/(cap−1))
    // It also delivers slightly LESS than the hard clamp in mid-range, which is
    // the safe direction for a term that rides the kept lamps' visibility.
    // `__giTileCutSoftCap = false` restores the hard clamp (the A/B arm);
    // `__giTileCutCompensate = 1` still disables compensation entirely.
    const softCap = globalThis.__giTileCutSoftCap !== false && compCap > 1;
    const ratio = impTotal.div(kept.max(1e-30)).max(1).toVar();
    const comp = select(
      kept.greaterThan(0),
      softCap
        ? float(1).add(float(compCap - 1).mul(
            float(1).sub(ratio.sub(1).div(compCap - 1).negate().exp()),
          ))
        : ratio.clamp(1, compCap),
      float(1),
    );
    posBuf.element(instanceIndex.mul(3)).assign(vec4(g0.xyz, select(g0.w.greaterThan(0.5), float(1), float(0))));
    posBuf.element(instanceIndex.mul(3).add(uint(1))).assign(vec4(outN, comp));
    posBuf.element(instanceIndex.mul(3).add(uint(2))).assign(vec4(w[0], w[1], w[2], w[3]));
    for (let k = 0; k < 4; k++) {
      idBuf.element(instanceIndex.mul(4).add(uint(k))).assign(ids[k]);
    }
  })().compute(tileCount);

  // importance/baseWord/emitterCount ride along so a viewport resize can
  // rebuild at new tile dims without re-deriving the tree plumbing.
  return { compute, tilesX, tilesY, tileSize, tileCount, posBuf, idBuf, importance, baseWord, emitterCount, compCap, feather };
}

/**
 * EDGE-AWARE SPATIAL FILTER for the traced light-shadow channels.
 *
 * The sun-disc stochastic march resolves ONE jittered sun-disc direction per
 * shadow pixel: unbiased, but a wide penumbra renders as a static IGN dither
 * (~50% black/white speckle at half occlusion — the "very grainy and noisy"
 * report). This pass turns the pixel ensemble into the ensemble AVERAGE: a
 * 21-tap (5×5 minus corners) cross-bilateral at shadow resolution, weights
 * from the RECEIVER PLANE (gbuffer position/normal) so penumbras smooth along
 * a surface but never bleed across silhouettes or depth steps. `planeEps` is
 * the plane-distance tolerance — half an occupancy voxel, the medium's own
 * quantization, passed as a node so a refit rescales it.
 *
 * Filtering happens HERE, at the shadow pass's own budgeted resolution, not
 * in materials: every gi light's compiled shadow branch samples the filtered
 * texture through the existing position-validated bilateral upsample, so the
 * grain fix costs one small compute instead of N material recompiles.
 */
export function createGiLightShadowFilterPass({
  gbuffer, source, target, width, height, resolveWidth, resolveHeight, planeEps,
  history = null, softness = null, cameraPos = null, projScale = null,
  // §11.11 SPARSE RECONSTRUCTION (2026-09-03). The emitter raw under seat
  // rotation carries a −1 sentinel in every channel the pixel did not march
  // this frame. In `sparse` mode the bilateral weights are PER CHANNEL: a
  // tap contributes to a channel only when it carries a sample there, so
  // each seat's value is the plane-weighted mean of the same-frame
  // neighbours that marched it (≥ 3 of the 21 taps for every seat, by the
  // pass's 2×2 lattice). The variance clip uses the same per-channel
  // moments. A channel with NO evidence in the window (an isolated pixel
  // whose same-plane neighbours are all sky/other planes) holds its
  // validated history, else 1 — the chain's load-bearing "unshadowed".
  // `distSource`/`distTarget` carry the analytic width the same way, by
  // NEAREST valid tap instead of mean (see the emitterShadowDistFill note).
  sparse = false, distSource = null, distTarget = null,
}) {
  const widthU = uniform(width, "uint");
  const positionNode = texture(gbuffer.position);
  const normalNode = texture(gbuffer.normal);
  const shadowNode = texture(source);
  const distFill = sparse && distSource && distTarget;
  const distNode = distFill ? texture(distSource) : null;
  const histShadowNode = history ? texture(history.histShadow) : null;
  const histPosNode = history ? texture(history.histPos) : null;
  // Reprojection-validity counter, compiled ONLY under the debug global (an
  // atomicAdd contended by every valid thread is a measurable cost) — the GPU
  // smoke uses it to prove the NDC→texel convention below actually revisits
  // the same surface (a wrong y-flip reads as ~0 valid pixels, silently
  // disabling accumulation).
  // [0] valid, [1] geometry threads, [2] reprojected inside bounds,
  // [3] history texel had geometry (hp.w) — a staged funnel so a zero at
  // [0] names its stage instead of "convention broken" generically.
  const temporalCounter =
    history && globalThis.__giShadowTemporalDebug === true
      ? instancedArray(new Uint32Array(4), "uint").toAtomic()
      : null;
  const sx = resolveWidth / width;
  const sy = resolveHeight / height;

  const compute = Fn(() => {
    const px = instanceIndex.mod(widthU);
    const py = instanceIndex.div(widthU);
    const coord = ivec2(px.toInt(), py.toInt());
    const center = vec4(shadowNode.load(coord)).toVar();
    const gCoord = ivec2(
      px.toFloat().add(0.5).mul(sx).toInt(),
      py.toFloat().add(0.5).mul(sy).toInt(),
    );
    const g0 = positionNode.load(gCoord).toVar();
    const out = center.toVar();
    const distOut = distFill ? vec4(0).toVar() : null;
    // Funnel counter [1] counts EXECUTED THREADS (not geometry) — it
    // separates "pass never dispatches" from "gbuffer is empty" when the
    // valid count reads zero.
    if (temporalCounter) atomicAdd(temporalCounter.element(1), uint(1));
    If(g0.w.greaterThan(0.5), () => {
      const P = g0.xyz.toVar();
      const N = vec3(normalNode.load(gCoord).xyz).normalize().toVar();
      // §14 Q6: the plane eps is DISTANCE-ROBUST. A flat voxel-scale eps
      // compares world distances between taps that sit metres apart far from
      // the camera, so the filter rejected every neighbour at distance and
      // degenerated to a passthrough — which is exactly where the
      // checkerboard trace and the raw staircase need it most ("blocky
      // patterns, especially further away"). The floor is the texel's own
      // world footprint ×2 (`viewDist / (projScale·height)` per texel): near
      // the camera nothing changes (voxMax dominates), far away the kernel
      // keeps its support while the normal gate still preserves edges.
      const texelW = (cameraPos && projScale)
        ? P.sub(vec3(cameraPos)).length()
            .div(float(projScale).max(1e-3).mul(height))
            .toVar()
        : null;
      const eps = texelW
        ? float(planeEps).max(1e-3).max(texelW.mul(2)).toVar()
        : float(planeEps).max(1e-3).toVar();
      const acc = vec4(0).toVar();
      const wSum = (sparse ? vec4(0) : float(0)).toVar();
      const clipM1 = history ? vec4(0).toVar() : null;
      const clipM2 = history ? vec4(0).toVar() : null;
      const bestW = distFill ? vec4(0).toVar() : null;
      const bestD = distFill ? vec4(0).toVar() : null;
      // ANGLE-ADAPTIVE SPATIAL SUPPORT (2026-08-06). σ1.6 was tuned to
      // average the STOCHASTIC arm's per-pixel sun-disc dither; the analytic
      // arm is deterministic, and for a razor-authored sun (sourceAngle 0)
      // the same kernel was the largest single softener in the chain — the
      // user's A/B against three's shadow map read "crisp hexagon vs soft
      // blob". `softness` (uniform, 0 = sharpest claimed light is a razor,
      // 1 = wide) morphs σ 0.55→1.6 at runtime: razor suns keep a center-
      // dominated despeckle (the tile-lattice raw noise still needs SOME
      // support), wide suns keep the historical kernel exactly.
      const sigma2 = softness
        ? mix(float(2 * 0.55 * 0.55), float(2 * 1.6 * 1.6), float(softness).clamp(0, 1)).toVar()
        : null;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (Math.abs(dx) + Math.abs(dy) > 3) continue; // corners add little support
          const gauss = sigma2
            ? float(-(dx * dx + dy * dy)).div(sigma2).exp()
            : Math.exp(-(dx * dx + dy * dy) / (2 * 1.6 * 1.6));
          const tap = ivec2(
            coord.x.add(dx).clamp(0, width - 1),
            coord.y.add(dy).clamp(0, height - 1),
          ).toVar();
          const tg = ivec2(
            tap.x.toFloat().add(0.5).mul(sx).toInt(),
            tap.y.toFloat().add(0.5).mul(sy).toInt(),
          ).toVar();
          const q0 = positionNode.load(tg).toVar();
          const q1 = normalNode.load(tg).toVar();
          // Same-surface test: distance to the receiver's plane, plus a
          // normal agreement gate. `q0.w` zeroes sky/no-geometry taps.
          const planeD = q0.xyz.sub(P).dot(N).abs();
          const wPlane = float(1).sub(planeD.div(eps)).clamp(0, 1);
          const wNormal = q1.xyz.normalize().dot(N).sub(0.7).mul(1 / 0.3).clamp(0, 1);
          const w = wPlane.mul(wNormal).mul(q0.w).mul(gauss).toVar();
          const tapS = vec4(shadowNode.load(tap)).toVar();
          if (sparse) {
            // Per-channel validity: −1 = not marched this frame. `step` at
            // −0.5 keeps a genuine 0 (fully shadowed) a valid sample.
            const wv = step(vec4(-0.5), tapS).mul(w).toVar();
            const tapV = tapS.max(0).toVar();
            acc.addAssign(tapV.mul(wv));
            wSum.addAssign(wv);
            if (history) {
              clipM1.addAssign(tapV.mul(wv));
              clipM2.addAssign(tapV.mul(tapV).mul(wv));
            }
            if (distFill) {
              const tapD = vec4(distNode.load(tap)).toVar();
              const cand = step(vec4(-0.5), tapD).mul(w).toVar();
              const better = step(bestW.add(1e-9), cand).toVar();
              bestD.assign(mix(bestD, tapD.max(0), better));
              bestW.assign(mix(bestW, cand, better));
            }
          } else {
            acc.addAssign(tapS.mul(w));
            wSum.addAssign(w);
            if (history) {
              // §14 Q7b: raw moments for the history clip below — same
              // validity weights, so σ describes THIS surface's raw shadow.
              clipM1.addAssign(tapS.mul(w));
              clipM2.addAssign(tapS.mul(tapS).mul(w));
            }
          }
        }
      }
      out.assign(acc.div(wSum.max(1e-4)));
      // TEMPORAL ACCUMULATION (reprojected). The trace samples ONE point of
      // the sun disc per pixel per frame (animated IGN); blending against
      // last frame's result — reprojected through the previous camera and
      // validated by WORLD POSITION — integrates the disc over time.
      // ~0.9 history weight ≈ a dozen effective sun samples: wide penumbras
      // stop reading as dither ("very dirty at larger angles") and converge
      // to the true coverage fraction. Validation failure (disocclusion, a
      // mover, a teleported camera) falls back to the spatial result alone —
      // the failure mode is grain, never ghosting. `history.weight` is a
      // uniform the system zeroes while a LIGHT is moving: a rotating sun
      // invalidates every pixel's history semantically (same surface, stale
      // shadow), which position validation cannot see.
      let histSampleRef = null;
      let validRef = null;
      if (history) {
        const clip = history.prevViewProj.mul(vec4(P, 1)).toVar();
        const histSample = vec4(0).toVar();
        const valid = float(0).toVar();
        histSampleRef = histSample;
        validRef = valid;
        If(clip.w.greaterThan(1e-3), () => {
          const ndc = clip.xyz.div(clip.w).toVar();
          const hx = ndc.x.mul(0.5).add(0.5).mul(width).toVar();
          // Row convention: texture row 0 is the TOP of the frame (NDC y=+1)
          // — proven by the smoke's per-axis agreement counters (the no-flip
          // arm read 0.8% row agreement, the flip ~full agreement; an early
          // "0 valid" reading against this flip was measured on a STOPPED
          // engine loop and led development astray for an hour — see the
          // smoke's restart note).
          const hy = float(0.5).sub(ndc.y.mul(0.5)).mul(height).toVar();
          If(
            hx.greaterThanEqual(0).and(hx.lessThan(width)).and(hy.greaterThanEqual(0)).and(hy.lessThan(height)),
            () => {
              if (temporalCounter) atomicAdd(temporalCounter.element(2), uint(1));
              const hc = ivec2(hx.toInt(), hy.toInt()).toVar();
              const hp = histPosNode.load(hc).toVar();
              If(hp.w.greaterThan(0.5), () => {
                if (temporalCounter) atomicAdd(temporalCounter.element(3), uint(1));
                // §14 Q6: validEps rides the same texel-footprint floor as
                // the spatial eps — a voxel-scale test at distance rejects
                // every reprojection (sub-texel rounding alone moves the
                // history point more than a voxel in world space there).
                const vEps = texelW
                  ? float(history.validEps).max(1e-3).max(texelW)
                  : float(history.validEps).max(1e-3);
                If(hp.xyz.sub(P).length().lessThan(vEps), () => {
                  histSample.assign(vec4(histShadowNode.load(hc)));
                  valid.assign(1);
                });
              });
              // SILHOUETTE RESCUE: during camera motion, sub-texel rounding
              // lands ~15% of reprojections on a neighbouring texel whose
              // surface differs — those pixels used to fall back to the raw
              // animated dither and flicker with fresh noise every frame
              // ("extremely jumpy on camera movement"). Search the 3×3 ring
              // for a position-valid history texel before giving up; what
              // remains invalid is true disocclusion, which is small and
              // short-lived.
              If(valid.lessThan(0.5), () => {
                for (let dy = -1; dy <= 1; dy++) {
                  for (let dx = -1; dx <= 1; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    const nc = ivec2(
                      hc.x.add(dx).clamp(0, width - 1),
                      hc.y.add(dy).clamp(0, height - 1),
                    ).toVar();
                    const np = histPosNode.load(nc).toVar();
                    const rEps = texelW
                      ? float(history.validEps).max(1e-3).max(texelW)
                      : float(history.validEps).max(1e-3);
                    If(
                      valid.lessThan(0.5)
                        .and(np.w.greaterThan(0.5))
                        .and(np.xyz.sub(P).length().lessThan(rEps)),
                      () => {
                        histSample.assign(vec4(histShadowNode.load(nc)));
                        valid.assign(1);
                      },
                    );
                  }
                }
              });
            },
          );
        });
        // §14 Q7b: NEIGHBOURHOOD VARIANCE CLIP — the moving-occluder fix.
        // Position validation cannot see that an OCCLUDER moved: the floor a
        // character just ran across reprojects perfectly, so its history
        // (the character's shadow of ten frames ago) blended in at ~0.9 and
        // the character trailed "smoke". History may only carry values the
        // plane-validated spatial neighbourhood considers plausible: where
        // the shadow has left, the neighbourhood is uniformly lit, σ→0, and
        // the stale darkness clips away within a frame; at a real static
        // edge σ is wide and accumulation is untouched. Same mechanism as
        // the irradiance filter's clip. `__giShadowTemporalClip` retunes γ;
        // ≤ 0 disables (build-time).
        const shClipGamma = Number(globalThis.__giShadowTemporalClip);
        const shGamma = Number.isFinite(shClipGamma) ? shClipGamma : 1.5;
        if (shGamma > 0) {
          const cw = wSum.max(1e-4);
          const cMean = clipM1.div(cw).toVar();
          const cSigma = clipM2.div(cw).sub(cMean.mul(cMean)).max(0).sqrt().mul(shGamma).toVar();
          const clamped = histSample.clamp(cMean.sub(cSigma), cMean.add(cSigma));
          // §11.11: a channel with NO same-frame evidence has mean 0, σ 0 —
          // the clip would crush its valid history to exactly 0 (the
          // irradiance filter's validityAlpha rule (b), same hazard). The
          // clip applies only where the neighbourhood actually spoke.
          histSample.assign(sparse ? mix(histSample, clamped, step(vec4(1e-4), wSum)) : clamped);
        }
        out.assign(mix(out, histSample, valid.mul(float(history.weight))));
        if (temporalCounter) {
          If(valid.greaterThan(0.5), () => {
            atomicAdd(temporalCounter.element(0), uint(1));
          });
        }
      }
      if (sparse) {
        // A channel with no same-frame evidence in the window: validated
        // history if there is one, else the unshadowed default.
        const has = step(vec4(1e-4), wSum);
        const fallback = histSampleRef ? mix(vec4(1), histSampleRef, validRef) : vec4(1);
        out.assign(mix(fallback, out, has));
      }
      if (distFill) distOut.assign(bestD);
    });
    textureStore(target, coord, out);
    if (distFill) textureStore(distTarget, coord, distOut);
  })().compute(width * height);

  return { compute, widthU, temporalCounter };
}

/**
 * WIDE PENUMBRA RECONSTRUCTION for the direct-shadow channel (2026-08-06).
 *
 * The analytic-width estimator softens the MISS side of a silhouette; the
 * central-ray HIT boundary is binary, and at large source angles that reads
 * as a hard edge inside the smoothed penumbra (user report at 30°, then
 * again at 90°). The material-side PCSS disc cannot fix it alone: its
 * radius is capped at 24 half-res texels (a 90° sun wants 3-4× that) and
 * spending more taps there costs every lit pixel of every material. This
 * pass does the wide blur ONCE, at the shadow channel's own budgeted
 * resolution: per-pixel penumbra width = tan(source half-angle) × blocker
 * distance (the march's own occluder distance, deterministic), radius up
 * to 40 shadow-res texels, a per-pixel IGN-rotated 12-tap golden spiral
 * whose taps contribute per-channel only within that channel's radius,
 * with receiver-plane validity so silhouettes don't cross-bleed. Sub-texel
 * radii keep the sharp result bit-exact, so a 0° sun is untouched.
 *
 * Point lights keep radius 0 for now (their angular size is per-pixel;
 * same deliberate deferral as the material disc).
 *
 * WORLD-WIDTH MODE (`slots: null`, 2026-08-13) — how the EMITTER channel uses
 * this same pass. Area emitters have no single source angle to reconstruct a
 * width from (it is per-pixel: reff/dist), so their marcher stores the
 * finished penumbra HALF-WIDTH IN METRES in the dist channel and this pass
 * only projects it to texels. That removes `span`, `tanHalf`, `slot.kind` and
 * the whole slot table from the emitter arm's bindings — the radius is one
 * multiply. `searchFrac` widens the blocker search to match the pass's own
 * radius cap: a pass that may blur by r texels has to look r texels out for
 * the blocker, or the penumbra clips at the geometric silhouette instead of
 * spanning both sides of it (the light arm's fixed 3 texels is sized for a
 * marcher that already softened the miss side; the emitter arm's raw is a
 * hard binary hit).
 *
 * ── THE WORLD→TEXEL MAP IS THE CAMERA'S, NOT A CONSTANT (2026-08-19) ────────
 * `projScale` is `P[5]/2` from the live projection matrix: a world half-width
 * `w` at depth `d` covers exactly `w·P[5]/(2d)` of the frame HEIGHT. It used to
 * be a hard-coded 1.2, which is that term at a 45° camera and nothing else — a
 * 60° view over-blurred by 1.39×, a 74° view by 1.8×. That is a bug you cannot
 * see as "wrong softness", only as "the shadow got weaker when I changed the
 * view", and it is half of the measured 2× over-blur that turned a full umbra
 * into 35% grey (scripts/run-gi-shadow-viewdist-probe.mjs).
 *
 * `radiusScale` is the other half. TWO CHAINED DISC BLURS OF RADIUS r ARE NOT
 * A BLUR OF RADIUS r — variances add, so the pair behaves like a single disc of
 * r·√2. The chain exists for SAMPLE COUNT (16 taps over 16-tap-averaged data ≈
 * 256 effective), not for width, so each instance takes 1/√2 of the analytic
 * width and the composite lands on the width the penumbra model actually asked
 * for. Callers that WANT the compounding (the 90° sun) simply leave it at 1.
 */
export function createGiLightShadowWidePass({
  gbuffer, source, dist, target, slots = null, span = 1, width, height, resolveWidth, resolveHeight,
  cameraPosition, capFrac = 0.1, searchFrac = null,
  projScale = null, radiusScale = 1, searchWorld = null, rotSalt = 0,
}) {
  const widthU = uniform(width, "uint");
  const positionNode = texture(gbuffer.position);
  const normalNode = texture(gbuffer.normal);
  const sourceNode = texture(source);
  const distNode = texture(dist);
  const sx = resolveWidth / width;
  const sy = resolveHeight / height;

  const compute = Fn(() => {
    const px = instanceIndex.mod(widthU);
    const py = instanceIndex.div(widthU);
    const coord = ivec2(px.toInt(), py.toInt());
    const uv0 = vec2(
      px.toFloat().add(0.5).div(width),
      py.toFloat().add(0.5).div(height),
    ).toVar();
    const gCoord = ivec2(
      px.toFloat().add(0.5).mul(sx).toInt(),
      py.toFloat().add(0.5).mul(sy).toInt(),
    );
    const center = vec4(sourceNode.load(coord)).toVar();
    const out = center.toVar();
    const g0 = positionNode.load(gCoord).toVar();
    If(g0.w.greaterThan(0.5), () => {
      const P = g0.xyz.toVar();
      const N = vec3(normalNode.load(gCoord).xyz).normalize().toVar();
      const viewDist = P.sub(vec3(cameraPosition)).length().max(0.05).toVar();
      const texelUv = vec2(1 / width, 1 / height);
      // ONE IGN rotation for the whole kernel — the blocker search and the blur
      // both walk a disc, and a search that always probes the SAME EIGHT
      // COMPASS POINTS stamps eight offset copies of every shadow into the lit
      // floor around it. That is the user's "many character shadows placed
      // there, not interpolated smoothly between each other": not ghosting, not
      // history, just a fixed-direction gather with no radial spread.
      // §14: `rotSalt` decorrelates CHAINED instances. Both wide passes used
      // to derive identical bearings from the same coord, so the second pass
      // largely re-averaged along the first one's own spokes — the claimed
      // "16 taps over 16-tap-averaged data ≈ 256 effective samples" never
      // held. A constant per-instance rotation restores the independence the
      // chain's whole justification assumes.
      const rotA = fract(
        fract(float(coord.x).mul(0.06711056).add(float(coord.y).mul(0.00583715)))
          .mul(52.9829189),
      ).mul(Math.PI * 2).add(rotSalt).toVar();
      // WORLD-SIZED SEARCH when the caller gives one. A radius fixed in TEXELS
      // is a radius that grows in METRES as the camera pulls back: the same
      // scene then borrows blocker widths from further and further away, which
      // is how open floor metres from any occluder ends up carrying penumbra.
      const searchTx = searchWorld
        ? float(searchWorld).mul(projScale ?? float(1.2)).div(viewDist).mul(height)
            .clamp(3, height * capFrac).toVar()
        : float(searchFrac ? Math.max(3, Math.round(height * searchFrac)) : 3);
      const t3 = texelUv.mul(searchTx);
      const blocker = vec4(distNode.load(coord)).toVar();
      if (searchFrac || searchWorld) {
        // THE PCSS BLOCKER SEARCH, and the rule that keeps contact shadows
        // contact shadows:
        //   · a pixel WITH a blocker of its own uses ITS OWN width. It has the
        //     exact answer — the trace measured its blocker — so nothing may
        //     override it. This is what makes the result monotone in blocker
        //     distance by construction, and it is why the marcher floors a hit
        //     at 1 mm: the channel doubles as the occupancy mask, so "contact,
        //     width ≈ 0" stays distinguishable from "lit, width = 0".
        //   · a LIT pixel has no blocker, so it borrows the AVERAGE width of
        //     the shadowed taps around it — the textbook estimator — which is
        //     what carries a penumbra to the lit side of the silhouette
        //     instead of clipping it there.
        // The first version took a plain MAX over the search, like the light
        // arm's 3-texel cross. At the tens of texels an area light's penumbra
        // needs, that propagated the far end of a wedge (metres of width) into
        // the contact band at its root and washed the whole umbra to light
        // grey — measured on the crate rig as an umbra that survived
        // `nowide` and dissolved under the blur.
        const own = blocker.toVar();
        const acc = vec4(0).toVar();
        const cnt = vec4(0).toVar();
        // A DISC, NOT A RING. The first version put eight taps on the cross and
        // diagonals AT ONE RADIUS — every tap the same distance out, always the
        // same eight bearings. That is not a neighbourhood search, it is a
        // shift-and-copy: a lit pixel exactly `searchTx` from a shadow inherits
        // that shadow's width and blurs it in, so the shadow reappears as eight
        // faint echoes at a fixed screen offset, and NOTHING between them (the
        // "not interpolated smoothly between each other"). A 12-tap golden
        // spiral over sqrt-distributed radii covers the disc uniformly, and the
        // per-pixel rotation decorrelates whatever structure is left.
        for (let k = 0; k < 12; k++) {
          const r = t3.mul(Math.sqrt((k + 0.5) / 12));
          const a = rotA.add(k * 2.399963);
          const uv = uv0.add(vec2(cos(a).mul(r.x), sin(a).mul(r.y))).toVar();
          const s = vec4(distNode.sample(uv).level(0)).toVar();
          // Shadowed mask from the 1 mm sentinel — a comparison-free
          // `s > 0` that stays a plain vec4 through the accumulation.
          const m = s.mul(1000).clamp(0, 1).toVar();
          acc.addAssign(s.mul(m));
          cnt.addAssign(m);
        }
        blocker.assign(mix(acc.div(cnt.max(1e-3)), own, own.mul(1000).clamp(0, 1)));
      } else {
        // The light arm, unchanged: a 4-tap max at a fixed 3 texels. Its
        // marcher already softens the miss side, so the search only has to
        // stop the penumbra clipping at the silhouette by a few texels.
        blocker.assign(blocker
          .max(distNode.sample(uv0.add(vec2(t3.x, 0))).level(0))
          .max(distNode.sample(uv0.sub(vec2(t3.x, 0))).level(0))
          .max(distNode.sample(uv0.add(vec2(0, t3.y))).level(0))
          .max(distNode.sample(uv0.sub(vec2(0, t3.y))).level(0)));
      }
      // Per-slot radius in SHADOW texels. World half-width → fraction of the
      // frame HEIGHT is w·P[5]/(2·viewDist); `proj` IS P[5]/2, read off the
      // live camera (see the header — the 1.2 it replaces is that term at 45°
      // and a silent over-blur at every other fov).
      const proj = projScale ?? float(1.2);
      const blockerCh = [blocker.x, blocker.y, blocker.z, blocker.w];
      const radii = Array.from({ length: 4 }, (_, i) => {
        // WORLD-WIDTH MODE: the channel already holds metres of penumbra
        // half-width (see the header) — scale for the chain, project, cap.
        if (!slots) {
          return blockerCh[i].max(0).mul(radiusScale)
            .mul(proj).div(viewDist)
            .mul(height)
            .clamp(0, height * capFrac)
            .toVar();
        }
        const slot = slots[i];
        if (!slot) return float(0).toVar();
        const tanHalf = tan(float(slot.soft).min(1.0472)); // ≤60° half-angle
        return blockerCh[i].mul(float(span)).mul(tanHalf)
          .mul(float(slot.kind)) // directional only
          .mul(slot.giShadow).mul(slot.active)
          .mul(radiusScale)
          .mul(proj).div(viewDist)
          .mul(height) // → texels
          // RESOLUTION-PROPORTIONAL cap (`capFrac` of frame height), not a
          // fixed texel count: a fixed 40 was 13% of the probe rig's height
          // but only 5% at the real 900k budget — the 90° hard edge
          // survived exactly because the cap shrank on real scenes. Two
          // CHAINED instances (0.08 then 0.25) compound to the huge radii a
          // 90° source demands: at that angle the penumbra width equals the
          // blocker distance, which routinely EXCEEDS the whole geometric
          // shadow — the average over that footprint is what lifts the
          // shadow CORE toward its true partial visibility (Blender's 90°
          // look is mostly-lit wash, not a blurred black blob).
          .clamp(0, height * capFrac)
          .toVar();
      });
      const rMax = radii[0].max(radii[1]).max(radii[2]).max(radii[3]).toVar();
      const dbgMode = globalThis.__giWideRadiusDebug;
      if (dbgMode === true || typeof dbgMode === "string") {
        // FACTOR MAPS instead of a blur (channel 0 only — the probe's
        // readback is single-channel): true→radius/cap, "blocker",
        // "tan" (tanHalf/2), "vd" (viewDist/30). The locator for "the wide
        // pass changes nothing" bugs.
        const paint =
          dbgMode === "blocker" ? blocker.x
          : dbgMode === "tan" ? float(slots?.[0] ? tan(float(slots[0].soft).min(1.0472)) : 0).div(2)
          : dbgMode === "vd" ? viewDist.div(30)
          : dbgMode === "span" ? float(span).div(30)
          : dbgMode === "soft" ? null
          : rMax.div(height * capFrac);
        if (paint) out.assign(vec4(paint, paint, paint, 1));
      }
      const wideBody = () => {
        // `rotA` is the one hoisted above — the search and the blur share it on
        // purpose, so a pixel's two discs are the same disc at two radii.
        const acc = vec4(0).toVar();
        const wSum = vec4(0).toVar();
        for (let k = 0; k < 16; k++) {
          const tapR = rMax.mul(Math.sqrt((k + 0.5) / 16)).toVar();
          const a = rotA.add(k * 2.399963);
          const uv = uv0.add(vec2(cos(a).mul(tapR).div(width), sin(a).mul(tapR).div(height))).toVar();
          const s = vec4(sourceNode.sample(uv).level(0)).toVar();
          const g = vec4(positionNode.sample(uv).level(0)).toVar();
          const rel = g.xyz.sub(P);
          // Receiver-plane validity: in-plane taps pass at any radius,
          // cross-silhouette taps fail (the material disc's v2 rule).
          const ok = g.w.greaterThan(0.5)
            .and(N.dot(rel).abs().lessThan(rel.length().mul(0.2).add(0.15)));
          // Each channel accepts the tap only within ITS radius — one
          // spiral serves four different penumbra widths.
          //
          // WORLD-WIDTH MODE RAMPS THAT ACCEPTANCE over one texel instead of
          // cutting it. With a hard cutoff the tap COUNT is a step function of
          // the radius, so a penumbra whose radius grows smoothly across a
          // wedge (which is what an analytic width does — it is proportional
          // to blocker distance) renders as 16 concentric contour bands.
          // The light arm keeps the hard cut: its radius comes from a source
          // angle and is near-constant across a shadow, so it never crosses
          // enough tap radii to band, and changing it would move a shipping
          // look for nothing.
          const chanOk = slots
            ? vec4(
                select(ok.and(tapR.lessThanEqual(radii[0])), 1, 0),
                select(ok.and(tapR.lessThanEqual(radii[1])), 1, 0),
                select(ok.and(tapR.lessThanEqual(radii[2])), 1, 0),
                select(ok.and(tapR.lessThanEqual(radii[3])), 1, 0),
              ).toVar()
            : vec4(
                radii[0].sub(tapR).clamp(0, 1),
                radii[1].sub(tapR).clamp(0, 1),
                radii[2].sub(tapR).clamp(0, 1),
                radii[3].sub(tapR).clamp(0, 1),
              ).mul(select(ok, 1, 0)).toVar();
          acc.addAssign(s.mul(chanOk));
          wSum.addAssign(chanOk);
        }
        const soft = acc.add(center).div(wSum.add(1)).toVar();
        // Fade the wide result in per channel as its radius clears a couple
        // of texels — sharp shadows stay bit-exact.
        const softness = vec4(
          smoothstep(0.75, 3, radii[0]),
          smoothstep(0.75, 3, radii[1]),
          smoothstep(0.75, 3, radii[2]),
          smoothstep(0.75, 3, radii[3]),
        );
        // `__giWideRadiusDebug === "soft"` paints the raw spiral average —
        // splits "spiral gathers nothing" from "the softness mix discards
        // it" when the wide pass reads as a no-op.
        out.assign(globalThis.__giWideRadiusDebug === "soft" ? soft : mix(center, soft, softness));
      };
      if (dbgMode === undefined || dbgMode === false || dbgMode === "soft") If(rMax.greaterThan(0.75), wideBody);
    });
    textureStore(target, coord, out);
  })().compute(width * height);

  return { compute, widthU };
}

/**
 * Copies the filtered+accumulated shadow result and the gbuffer position into
 * the HISTORY textures for the next frame's reprojection. A separate pass, not
 * folded into the filter: the filter READS history at reprojected (≠ own)
 * coords, so writing history in the same dispatch would race.
 */
export function createGiLightShadowHistoryPass({
  gbuffer, source, histShadow, histPos, width, height, resolveWidth, resolveHeight,
}) {
  const widthU = uniform(width, "uint");
  const positionNode = texture(gbuffer.position);
  const shadowNode = texture(source);
  const sx = resolveWidth / width;
  const sy = resolveHeight / height;
  const compute = Fn(() => {
    const px = instanceIndex.mod(widthU);
    const py = instanceIndex.div(widthU);
    const coord = ivec2(px.toInt(), py.toInt());
    const gCoord = ivec2(
      px.toFloat().add(0.5).mul(sx).toInt(),
      py.toFloat().add(0.5).mul(sy).toInt(),
    );
    const g0 = positionNode.load(gCoord).toVar();
    textureStore(histShadow, coord, vec4(shadowNode.load(coord)));
    textureStore(histPos, coord, vec4(g0.xyz, g0.w));
  })().compute(width * height);
  return { compute, widthU };
}

/**
 * ══ THE IRRADIANCE TEMPORAL FILTER (§12.65) ═════════════════════════════════
 *
 * A reprojected screen-space EMA over the GI resolve — the "resolve-space
 * filter" §12.63 specced after the Sponza probes measured what no CPU dial
 * could reach: post-pan holds churn at 16× the parked floor because the
 * screen-driven transport re-samples every probe when the view changes, and
 * the whole field crawls to its new equilibrium IN VIEW. The probes' own
 * temporal layer cannot help (it is the thing converging); a second, SCREEN
 * layer can, because the resolve's per-pixel answer for a parked-or-panning
 * camera over static geometry is the same world radiance landing on
 * reprojectable pixels.
 *
 * Shape: `raw` is the resolve's output (the filter's OWN input texture,
 * never sampled by materials); history is validated EXACTLY like the
 * light-shadow filter's — previous camera's clip, row-flipped, world-position
 * epsilon, 3×3 silhouette rescue (that pass's comments carry the measured
 * reasons; this one inherits them wholesale). The blend writes `target` =
 * `targets.irradiance`, the texture materials have always sampled.
 *
 * Ghosting control is the SHADOW CHAIN'S, not a neighborhood clamp: the
 * `history.weight` uniform is driven to zero by the system while any LIGHT
 * is moving (matrix, luminance or emitter motion — the same family the α
 * ramp rides), because a light change invalidates history SEMANTICALLY
 * (same surface, stale radiance) in a way position validation cannot see.
 * Camera motion deliberately does NOT drop the weight — reprojection handles
 * it, and that is the entire point: the pan's re-equilibration churn averages
 * away instead of playing on screen. Validation failure falls back to the
 * raw resolve — the failure mode is the pre-§12.65 noise, never a ghost.
 */
// A current-frame neighbour is a bridge, not field evidence. Keeping its
// confidence below one makes a real gather answer replace it immediately and
// prevents spatial rescue from becoming permanent screen-space GI.
export const GI_IRR_SPATIAL_FALLBACK_CONFIDENCE = 0.25;

export function createGiIrradianceTemporalPass({
  gbuffer, source, target, histIrr, histPos, width, height, history,
  // The filter's grid may be SMALLER than the gbuffer's (the glossy radiance
  // chain runs it at half gather res). These give the gbuffer scale, exactly
  // as createGiLightShadowHistoryPass takes them; at 1:1 (the irradiance
  // chain, and the default) the mapping is compiled out and the WGSL is
  // byte-identical to what every §12.65 receipt measured.
  resolveWidth = width, resolveHeight = height,
  // `markerAlpha` (2026-08-22, the hit-radiance chain): the source's ALPHA is
  // a discrete state marker (−1 traced miss / 0 skip / 1 shaded hit —
  // giLight keys env-on-miss and the exact blend on it), not a signal.
  // Filtering it would manufacture fractional states, so this mode (a) only
  // accepts history when BOTH frames were shaded hits — a pixel that flipped
  // hit↔miss takes the raw value, which is exactly the §12.65 designed
  // failure mode — and (b) stores the RAW marker through unconditionally.
  markerAlpha = false,
  // `validityAlpha` (2026-08-22, the black-rectangle fix — the irradiance
  // chain only): the source's ALPHA is a VALIDITY (resolve/gather: 1 =
  // answered, 0 = the field had nothing there — an absence, never a
  // measurement of darkness). Three rules follow, each closing a path by
  // which an absence became a dark vote at the display:
  //   (a) an unknown raw with validated known history HOLDS the history
  //       outright — bypassing `history.weight`, because the alternative to
  //       "slightly stale light" is a black rectangle while the field
  //       refills (probe retirement, a re-anchor, a cold frontier);
  //   (b) the variance clip is SKIPPED for unknown raw (an all-unknown
  //       neighbourhood has mean 0, σ 0 — the clip would crush valid
  //       history to exactly the black being fought), and unknown
  //       neighbours are excluded from the moments;
  //   (c) the stored alpha is the OUTPUT's validity (raw known OR held), so
  //       held light keeps sustaining itself across frames until real data
  //       replaces it, and never-seen regions (alpha 0 everywhere) stay
  //       honestly unlit rather than inventing light.
  validityAlpha = false,
}) {
  const widthU = uniform(width, "uint");
  const positionNode = texture(gbuffer.position);
  const irrNormalNode = texture(gbuffer.normal);
  const rawNode = texture(source);
  const histIrrNode = texture(histIrr);
  const histPosNode = texture(histPos);
  const sx = resolveWidth / width;
  const sy = resolveHeight / height;
  const gAt = (sx !== 1 || sy !== 1)
    ? (c) => ivec2(c.x.toFloat().add(0.5).mul(sx).toInt(), c.y.toFloat().add(0.5).mul(sy).toInt())
    : (c) => c;
  const compute = Fn(() => {
    const px = instanceIndex.mod(widthU);
    const py = instanceIndex.div(widthU);
    const coord = ivec2(px.toInt(), py.toInt());
    const raw = vec4(rawNode.load(coord)).toVar();
    const out = raw.toVar();
    const outKnown = validityAlpha ? float(raw.w).toVar() : null;
    const g0 = positionNode.load(gAt(coord)).toVar();
    If(g0.w.greaterThan(0.5), () => {
      const P = g0.xyz.toVar();
      // §14 Q5: the receiver's normal joins every acceptance below. A
      // position-only test with a voxel-scale eps admits the point on the
      // OTHER SIDE of a silhouette — centimetres away in space, a different
      // world in radiance — and that is the bright rim that appears exactly
      // while the camera moves. The plane test (offset along N) separates
      // across-edge neighbours from along-surface ones, which a radial
      // distance cannot.
      const Nn = vec4(irrNormalNode.load(gAt(coord))).xyz.normalize().toVar();
      // ── THE DEFORMING-SURFACE REJECT (the character ghost) ────────────────
      // Reprojection below assumes the world stood still: it finds where THIS
      // world point sat on screen last frame. For a surface that moved on its
      // own — a skinned character — the texel it lands on holds a different
      // point of that surface, and the position guard cannot tell, because its
      // tolerance is voxel-scale while a limb moves centimetres per frame. So
      // history is refused outright inside the swept bounds of every deforming
      // mesh (GISystem #syncDynamicSurfaceBounds, which explains why this is
      // bounds rather than a per-pixel mark). Refusing falls through to the raw
      // resolve — this pass's designed failure mode, noise and never a ghost.
      const inDynamic = history.dynActive
        ? history.dynActive.greaterThan(0.5)
            .and(P.x.greaterThanEqual(history.dynMin.x)).and(P.x.lessThanEqual(history.dynMax.x))
            .and(P.y.greaterThanEqual(history.dynMin.y)).and(P.y.lessThanEqual(history.dynMax.y))
            .and(P.z.greaterThanEqual(history.dynMin.z)).and(P.z.lessThanEqual(history.dynMax.z))
        : null;
      const clip = history.prevViewProj.mul(vec4(P, 1)).toVar();
      const histSample = vec4(0).toVar();
      const valid = float(0).toVar();
      // How far off the reprojection landed, so the rescue can prefer the
      // NEAREST valid neighbour instead of the first one in scan order. First-
      // in-scan-order is a bias toward −x,−y, which is how a rescue turns into
      // a one-sided fringe along every silhouette.
      const bestD = float(1e9).toVar();
      // A newly revealed point has no reprojectable history. If its raw gather
      // is UNKNOWN while an adjacent pixel on the same receiver is known, keep
      // that value as a low-confidence bridge instead of presenting the
      // absence as a black checker square. This is separate from histSample:
      // strong world-validated history remains the first choice.
      const spatialSample = validityAlpha ? vec4(0).toVar() : null;
      const spatialValid = validityAlpha ? float(0).toVar() : null;
      const spatialBestD = validityAlpha ? float(1e9).toVar() : null;
      // ── §14 Q6's MISSING HALF, and the 2026-08-24 "mud" instrument ────────
      //
      // `createGiLightShadowFilterPass` floors this eps with the texel
      // footprint (`.max(texelW)`); THIS pass never got that treatment and does
      // not even receive the camera. But the arithmetic on the user's Level
      // says a floor is the wrong direction here: `validEps` is `voxMax`
      // ≈ 0.22 m while one texel at 20 m is ≈ 0.024 m, so the world test is
      // already ~9 TEXELS WIDE out there — loose, not tight. A reprojection
      // that lands on the wrong texel while the camera moves is then ACCEPTED,
      // and the pixel adopts a neighbour's irradiance. Close up the same 0.22 m
      // is ~1 texel (tight, correct) and standing still the reprojection is the
      // identity (correct at any eps) — which is exactly the user's three
      // symptoms: muddy at distance, INSTANTLY clean on approach, clean after a
      // few seconds of standing still.
      //
      // ⚠ That is a HYPOTHESIS with the right shape, not a measured result, and
      // this session has already killed six of those. So this is an OVERRIDE,
      // not a change: unset, the kernel is byte-identical to every §12.65
      // receipt. `__giIrrValidEps` (metres, build-time — reload to apply) makes
      // it falsifiable. If tightening it clears distant mud, the fix is to make
      // the eps track the texel footprint instead of the voxel.
      const epsOverride = Number(globalThis.__giIrrValidEps);
      const epsMetres = Number.isFinite(epsOverride) && epsOverride > 0
        ? epsOverride
        : history.validEps;
      const eps = float(epsMetres).max(1e-3).toVar();
      If(clip.w.greaterThan(1e-3), () => {
        const ndc = clip.xyz.div(clip.w).toVar();
        const hx = ndc.x.mul(0.5).add(0.5).mul(width).toVar();
        // Row 0 is the TOP of the frame — the shadow filter's proven flip.
        const hy = float(0.5).sub(ndc.y.mul(0.5)).mul(height).toVar();
        If(
          hx.greaterThanEqual(0).and(hx.lessThan(width)).and(hy.greaterThanEqual(0)).and(hy.lessThan(height)),
          () => {
            const hc = ivec2(hx.toInt(), hy.toInt()).toVar();
            const hp = histPosNode.load(hc).toVar();
            If(hp.w.greaterThan(0.5), () => {
              const d = hp.xyz.sub(P).length().toVar();
              // §14 Q5: within eps AND on this receiver's plane — half the
              // eps along the normal rejects the far side of an edge while
              // along-surface reprojection error (which lies IN the plane)
              // passes untouched.
              If(d.lessThan(eps).and(hp.xyz.sub(P).dot(Nn).abs().lessThan(eps.mul(0.5))), () => {
                histSample.assign(vec4(histIrrNode.load(hc)));
                valid.assign(1);
                bestD.assign(d);
              });
            });
            // Silhouette rescue — same 3×3 ring, same measured reason
            // ("extremely jumpy on camera movement" without it), now
            // nearest-wins rather than first-wins.
            If(valid.lessThan(0.5), () => {
              for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                  if (dx === 0 && dy === 0) continue;
                  const nc = ivec2(
                    hc.x.add(dx).clamp(0, width - 1),
                    hc.y.add(dy).clamp(0, height - 1),
                  ).toVar();
                  const np = histPosNode.load(nc).toVar();
                  const nd = np.xyz.sub(P).length().toVar();
                  If(
                    np.w.greaterThan(0.5).and(nd.lessThan(eps)).and(nd.lessThan(bestD))
                      // §14 Q5: same plane test as the direct hit — the
                      // rescue is the main importer of foreign radiance
                      // (it runs exactly when the view is changing).
                      .and(np.xyz.sub(P).dot(Nn).abs().lessThan(eps.mul(0.5))),
                    () => {
                      histSample.assign(vec4(histIrrNode.load(nc)));
                      valid.assign(1);
                      bestD.assign(nd);
                    },
                  );
                }
              }
            });
          },
        );
      });
      // ── NEIGHBOURHOOD VARIANCE CLIP (2026-08-19) ──────────────────────────
      // A reprojection is only ever validated by WORLD POSITION, and `validEps`
      // is voxel-scale. Two points a few centimetres apart across a silhouette
      // pass that test while carrying completely different irradiance — the
      // lit top of a slab and its shaded side, a bright floor and the dark box
      // standing on it. Adopting the wrong one paints a rim of foreign light
      // along the edge, and because the reprojection only FAILS while the view
      // is changing, the rim appears exactly when the camera moves and heals
      // when it stops ("the bright border on objects when camera moves").
      //
      // The fix is the standard one and it does not depend on diagnosing WHICH
      // lookup went wrong: history may only carry values the local raw resolve
      // considers plausible. Mean ± γ·σ over the 3×3 raw neighbourhood — wide
      // enough that ordinary accumulation is untouched (σ of a noisy resolve is
      // large), tight enough that a value from the other side of an edge is
      // pulled back to this side's range. `__giIrrTemporalClip` retunes γ; ≤ 0
      // restores the unclipped behaviour for an A/B.
      const clipGamma = Number(globalThis.__giIrrTemporalClip);
      const gamma = Number.isFinite(clipGamma) ? clipGamma : 1.5;
      if (gamma > 0) {
        // §14 Q5: the moments are PLANE-WEIGHTED. Unvalidated, the 3×3
        // straddles the silhouette and σ is maximal exactly where the clip
        // is the only guard — the box widens to cover both sides and the
        // foreign value passes untouched. Weighted by the same plane test as
        // the acceptances above, σ describes THIS surface's raw statistics:
        // tight at an edge (history must match this side closely), wide on a
        // noisy flat (ordinary accumulation untouched). The centre tap
        // always counts, so the divide is safe by construction.
        const m1 = vec4(0).toVar();
        const m2 = vec4(0).toVar();
        const wsum = float(0).toVar();
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nc = ivec2(
              coord.x.add(dx).clamp(0, width - 1),
              coord.y.add(dy).clamp(0, height - 1),
            ).toVar();
            const s = vec4(rawNode.load(nc)).toVar();
            const wTap = (dx === 0 && dy === 0)
              ? float(1)
              : (() => {
                  const ngp = vec4(positionNode.load(gAt(nc))).toVar();
                  return select(
                    ngp.w.greaterThan(0.5)
                      .and(ngp.xyz.sub(P).dot(Nn).abs().lessThan(eps.mul(0.5))),
                    float(1),
                    float(0),
                  );
                })();
            const w = float(wTap).toVar();
            // validityAlpha rule (b): an unknown neighbour contributes no
            // moment — its 0 is an absence, and averaging it in drags the
            // clip box toward black exactly where the box is the only guard.
            // The centre tap keeps counting (the clip result is discarded
            // for an unknown centre anyway), so the divide stays safe.
            if (validityAlpha && !(dx === 0 && dy === 0)) w.mulAssign(step(0.5, s.w));
            m1.addAssign(s.mul(w));
            m2.addAssign(s.mul(s).mul(w));
            wsum.addAssign(w);
          }
        }
        const mean = m1.div(wsum).toVar();
        // ⭐⭐⭐ §11.50 — THE CLIP BOX NEEDS A FLOOR, AND WITHOUT ONE THIS
        // FILTER STOPS BEING TEMPORAL (2026-09-04).
        //
        // ⛔ THE BUG: `σ` is measured over a 3x3 of the RAW RESOLVE. On a flat
        // wall the raw gather is SMOOTH — that is the entire point of an
        // 8-corner trilinear gather — so σ → 0 and the box `mean ± γσ`
        // collapses to the single value `mean`. The clamp is then not a guard
        // at all: it is the assignment `history := local mean of this frame`,
        // re-applied every frame. Three consequences, all of them what the
        // user reported:
        //
        //   1. THE FILTER LOSES ITS MEMORY. `out = mix(raw, mean3x3(raw), w)`
        //      carries nothing from before, so the accumulation this pass
        //      exists for never happens — and at w = 0.9 the displayed value
        //      is a repeatedly box-blurred raw, an IIR blur whose kernel
        //      widens every frame.
        //   2. IT LOCKS IN THE LOW SAMPLES. Where a probe cell's coverage hole
        //      makes raw's local mean sit under the true irradiance, the clamp
        //      pins history there and the next frame's box is built from the
        //      pinned value. The picture darkens and stays dark — "our GI lost
        //      its colour", "so little bounce".
        //   3. IT PRINTS THE PROBE LATTICE. The plane-weighted moments cut the
        //      3x3 at every depth discontinuity, so the box width is a
        //      per-pixel function of local geometry AND of which probe cell
        //      answered — hard-edged, cell-sized, exactly the "blocky
        //      artifacts on the edges of walls".
        //
        // Proven in one build: `__giIrrPassthrough` (output forced to input,
        // pass still dispatched) and `__giIrrTemporalClip = 0` produce the SAME
        // bright, block-free picture, while every other arm — history weight
        // pinned to 0, `__giIrrValidityHold = false`, the hit filter's weight
        // pinned to 0 — leaves it dark and blocky. The clip is the only term
        // that moves it.
        //
        // THE FIX is the one every TAA ships: a RELATIVE floor on the box
        // half-width, so a smooth neighbourhood still lets history live within
        // a band around the local mean. Relative because irradiance is HDR and
        // has no natural scale — an absolute floor would be a guard at 0.01
        // and none at 10. At a silhouette the guard is untouched in the way
        // that matters: the far side of an edge differs by multiples, not by
        // `CLIP_FLOOR`, so it is still pulled back.
        // `__giIrrTemporalClipFloor` retunes it; 0 restores the collapsing box.
        const floorPin = Number(globalThis.__giIrrTemporalClipFloor);
        const clipFloor = Number.isFinite(floorPin) && floorPin >= 0 ? floorPin : 0.25;
        const sigma = m2.div(wsum).sub(mean.mul(mean)).max(0).sqrt().mul(gamma)
          .max(mean.abs().mul(clipFloor))
          .toVar();
        const clamped = histSample.clamp(mean.sub(sigma), mean.add(sigma));
        // validityAlpha rule (b): never clip history against an unknown raw
        // centre — its statistics describe an absence, and the clamp would
        // crush the very history the hold below exists to keep.
        histSample.assign(validityAlpha
          ? select(raw.w.greaterThan(0.5), clamped, histSample)
          : clamped);
      }
      // Detail-box slides and fast turns can expose a frontier whose probe
      // tiles are not ready on this frame. Reprojection cannot help a surface
      // never seen by the previous camera, but those holes are usually
      // interleaved with answered pixels on the SAME surface. Rescue only raw
      // UNKNOWN lanes, only from the nearest current-frame 3x3 neighbour, and
      // require both plane and normal agreement. The normal test is essential
      // at floor/wall joints: positions can be arbitrarily close and the
      // floor-plane delta can be zero although their irradiance is unrelated.
      //
      // This adds no buffer or ray work. All three textures are already bound,
      // and these extra taps sit under an unknown-only branch.
      if (validityAlpha && globalThis.__giIrrSpatialFallback !== false) {
        If(raw.w.lessThan(0.5), () => {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nc = ivec2(
                coord.x.add(dx).clamp(0, width - 1),
                coord.y.add(dy).clamp(0, height - 1),
              ).toVar();
              const ngp = vec4(positionNode.load(gAt(nc))).toVar();
              const ns = vec4(rawNode.load(nc)).toVar();
              const ndelta = ngp.xyz.sub(P).toVar();
              const nd = ndelta.length().toVar();
              const nN = vec4(irrNormalNode.load(gAt(nc))).xyz.normalize().toVar();
              If(
                ngp.w.greaterThan(0.5)
                  .and(ns.w.greaterThan(0.5))
                  .and(nd.lessThan(eps))
                  .and(nd.lessThan(spatialBestD))
                  .and(ndelta.dot(Nn).abs().lessThan(eps.mul(0.5)))
                  .and(nN.dot(Nn).greaterThan(0.75)),
                () => {
                  spatialSample.assign(ns);
                  spatialValid.assign(1);
                  spatialBestD.assign(nd);
                },
              );
            }
          }
        });
      }
      // Applied to the BLEND rather than around the lookup so the whole
      // reprojection stays one straight-line dataflow — `valid` is already the
      // gate every other rejection writes to.
      if (inDynamic) valid.assign(select(inDynamic, float(0), valid));
      if (markerAlpha) {
        valid.assign(select(
          raw.w.greaterThan(0.5).and(histSample.w.greaterThan(0.5)),
          valid, float(0),
        ));
      }
      if (validityAlpha) {
        // Rule (a): unknown raw + validated history → hold the history, at a
        // confidence that DECAYS. The first version held at full validity and
        // the held pixels self-sustained forever — next to unknown-no-history
        // neighbours that stayed black, that rendered as a permanent
        // patchwork quilt (the user's 19:10 screenshot). The stored alpha is
        // now a continuous confidence: 1 while raw answers, ×0.97/frame
        // while holding (≈2 s to fade), and the held value blends toward raw
        // by that confidence — a bridge over transients that hands over
        // instead of freezing. `history.weight` is still bypassed while
        // holding: its zero during light motion means "semantically stale",
        // and briefly-stale light beats a black hole by the user's own bar.
        const rawKnown = raw.w.greaterThan(0.5);
        const heldA = histSample.w.mul(0.97).clamp(0, 1).toVar();
        const hold = rawKnown.not()
          .and(valid.greaterThan(0.5))
          .and(heldA.greaterThan(0.05))
          .toVar();
        const spatialA = spatialValid.mul(GI_IRR_SPATIAL_FALLBACK_CONFIDENCE).toVar();
        // Strong reprojected history is world-validated and wins. A previous
        // low-confidence spatial bridge does not suppress a fresh current-
        // frame neighbour with higher confidence, avoiding a fade toward
        // black on the bridge's second frame.
        const holdHistory = hold.and(heldA.greaterThanEqual(spatialA)).toVar();
        const useSpatial = rawKnown.not()
          .and(spatialValid.greaterThan(0.5))
          .and(holdHistory.not())
          .toVar();
        const temporalOut = select(hold,
          mix(raw, histSample, heldA),
          mix(raw, histSample, valid.mul(float(history.weight))));
        out.assign(select(useSpatial, vec4(spatialSample.xyz, spatialA), temporalOut));
        outKnown.assign(select(rawKnown, float(1),
          select(useSpatial, spatialA, select(hold, heldA, float(0)))));
      } else {
        out.assign(mix(raw, histSample, valid.mul(float(history.weight))));
      }
    });
    // §11.50 DIAGNOSTIC: `__giIrrPassthrough = true` stores the raw resolve and
    // nothing else, with the pass still built, still dispatched and still
    // paying its cost. `__giIrrTemporal = false` removes the whole chain —
    // three targets, this pass, the history snapshot AND the glossy/hit
    // temporal filters that share its uniforms — so a difference between those
    // two arms is NOT attributable to this filter. This one is: same build,
    // same bindings, same frame, output forced to the input.
    textureStore(target, coord,
      globalThis.__giIrrPassthrough === true ? raw
        : markerAlpha ? vec4(out.xyz, raw.w)
        : validityAlpha ? vec4(out.xyz, outKnown)
        : out);
  })().compute(width * height);
  return { compute, widthU };
}

/**
 * Octahedral-encodes a unit vector into 2 floats in [-1,1] (Cigolle et al.,
 * "A Survey of Efficient Representations for Independent Unit Vectors") —
 * how createGiBvhReflect packs the BVH hit's exact face normal into the
 * t-target's otherwise-unused .zw (see that function's STRIPING FIX
 * comment below). The HalfFloatType target stores signed components
 * directly, so unlike a u8-texture oct encoding there is no extra
 * ×0.5+0.5 remap here. Decoded in giLight.js with the matching closed-form
 * inverse — no `.toVar()`/`If()` there, that consumption path is PURE
 * DATAFLOW by design (see its own comment).
 */
function octEncodeNormal(n) {
  const denom = abs(n.x).add(abs(n.y)).add(abs(n.z)).max(1e-8).toVar();
  const p = n.xy.div(denom).toVar();
  const signNotZero = vec2(
    select(p.x.greaterThanEqual(0), 1, -1),
    select(p.y.greaterThanEqual(0), 1, -1),
  ).toVar();
  const folded = float(1).sub(abs(p.yx)).mul(signNotZero).toVar();
  return select(n.z.lessThan(0), folded, p);
}

/**
 * Half-res BVH exact-reflection prepass (GI Phase 3 v1 — see
 * docs/GI_PLAN.md). Reads the SAME gbuffer the irradiance resolve reads
 * (position + normal), fires ONE reflection ray per pixel through the
 * multi-mesh BVH (src/modules/gi/bvh/bvhScene.js), and stores the hit
 * distance (miss = -1) into a screen texture. giLight's mirror block
 * samples this by screen UV INSTEAD OF calling the SDF `mirrorTraceFn` when
 * `light.bvhReflectTexture` is set — everything downstream of the hit
 * distance (hit shading, per-hit shadows) is unchanged; only the t SOURCE
 * moves from a per-material SDF trace to this shared compute pass.
 *
 * BVH tracing happens ONLY here (a compute pass), never inside a material:
 * the traversal needs 4 storage buffers plus a per-mesh uniform table, and
 * materials already sit at the 8-storage-buffer fragment-stage limit (see
 * docs/GI_PLAN.md Phase 3 and the dead 2026-07-16 ReSTIR attempt that first
 * hit that ceiling).
 *
 * SPARSE (2026-08-02). This used to trace EVERY gbuffer pixel — a full-screen
 * BVH traversal every frame whether or not a single reflective surface was
 * visible, which is the whole of the "exact reflections are super expensive"
 * report. The gbuffer's second attachment now carries a mirror mask in its w
 * (see createGiGBuffer's `maskMrtNode`), and non-mirror threads exit before
 * `firstHit`. They still WRITE, with t = -1 / hasAlbedo = 0, so a material
 * that samples a masked-off texel gets the ordinary miss semantics and falls
 * back to the cascade lookup — the output is identical, only the cost moves.
 * `mask: false` restores the dense behaviour (the A/B arm).
 *
 * This pass TRACES ONLY — it writes geometry (hit t, face normal, hit albedo),
 * never light. Shading the hit needs the cascade gather, the emitter slots and
 * the analytic light slots, and binding those HERE asks for 16 uniform buffers
 * in one compute stage against a WebGPU baseline of 12 (measured, and the
 * emitter bundle is the part that blows it). The resolve pass already binds all
 * three, so that is where a reflection hit gets lit — see createGiResolve's
 * `bvhShade`.
 */
/**
 * The prepass's block stride, resolved the ONE way — tier default, the
 * `__giBvhReflectStride` A/B hatch, the same clamp.
 *
 * Exported because the hit-shade pass has to SNAP its source reads to this
 * exact number (see createGiBvhHitShade's anchor note): the two deriving it
 * independently is how they drift apart, and a mismatch reads as ruled lines
 * across every reflection — the shipped bug this function exists to prevent
 * from coming back.
 */
export function giBvhReflectStride(strideDefault = 2) {
  const raw = Number(globalThis.__giBvhReflectStride);
  return Math.max(1, Math.min(4, Number.isFinite(raw) ? Math.round(raw) : strideDefault));
}

/**
 * The traced anchors that bracket a pixel inside a stride-sized block.
 * Shared by the hit-shade reconstruction and its focused policy gate so the
 * two cannot quietly disagree about which neighbouring blocks are eligible.
 */
export function giBvhReflectAnchorOffsets(stride = 2) {
  const s = Math.max(1, Math.min(4, Math.round(Number(stride)) || 1));
  return s === 1 ? [[0, 0]] : [[0, 0], [s, 0], [0, s], [s, s]];
}

export function createGiBvhReflect({
  gbuffer, target, colorTarget, width, height, bvhScene,
  cameraPosition, normalOffset, maxDistance, mask = true, dyn = null,
  strideDefault = 2, replicate = true,
  // §17 R7a — the ONE-BVH bundle: { trace(origin,dir,tMin,tMax) →
  // vec4(t, octN.xy, bitcast slot), palette: { bits, wordOffset, words,
  // slots } | null }. When present (and its trace compiles — the static
  // BVH region can be dropped by the degrade ladder), the prepass traces
  // the WHOLE static scene through the shadow BVH8 in one traversal
  // instead of the ≤128-mesh linear loop, and shades hits from the
  // per-slot surface palette. Null keeps the incumbent path compiled
  // (`__giOneBvhReflect = false` forces it from GISystem).
  oneBvh = null,
  // Water refraction (2026-09-06): 'reflect' derives the ray from the
  // receiver's normal and the camera; 'given' reads the ray DIRECTION from
  // the gbuffer's normal attachment as it is (the water's own gbuffer stores
  // the refracted direction there) and steps the origin along the ray.
  rayMode = 'reflect',
}) {
  // ── ONE RAY PER stride×stride BLOCK (2026-08-16) ────────────────────────────
  //
  // MEASURED: this pass is **13.09 ms of a 31.85 ms ultra frame** on the banner
  // Sponza (`profile.giPasses`, 1588×898) — 41 % of the frame, and by far the
  // most expensive thing GI does. It was invisible for three sessions because
  // it was missing from that op's pass list.
  //
  // A BVH traversal per pixel is what costs; the STORES are nearly free. So
  // trace one ray per block and replicate the result across the block, which
  // keeps every target full-resolution and therefore needs NO change in any
  // consumer — the resolve reads these with `load(coord)` on its own full-res
  // grid (createGiResolve's `bvhShade`) and materials sample by `screenUV`. A
  // genuinely half-res TEXTURE would have required touching both.
  //
  // Replication is VALIDATED, not blind: each neighbour's gbuffer position and
  // normal are compared against the traced texel's, and a texel that fails
  // (the block straddles a silhouette) is written as a MISS rather than given
  // its neighbour's hit distance. That matters because the consumer
  // reconstructs the hit point from this `t` and its OWN normal — a wrong `t`
  // puts the reflected sample somewhere else entirely, which is the bright
  // smear half-res reflections are known for. A miss is not a hole: it is the
  // same value a masked-off pixel gets, and the material falls back to the
  // cascade lookup exactly as it does everywhere else.
  //
  // MEASURED on the banner Sponza at 1588×898: 13.09 ms per-pixel → 4.23 ms at
  // stride 2 → 3.84 ms at stride 3. The curve flattens because the validation
  // taps and the stores grow with the block while only the TRACES shrink, so
  // stride 3 is the practical floor; past it the block starts spanning enough
  // surface that the position/normal check rejects most neighbours and the
  // reflection quietly degrades to the cascade lookup for no further speed.
  //
  // `__giBvhReflectStride` is the A/B hatch; 1 restores per-pixel tracing.
  // Default 2 since 2026-08-21 (was 3): stride 3's larger blocks were
  // half of the mosaic patchwork on CURVED mirrors (the user's mirror
  // columns; the other half was the loose same-surface test below). Banner
  // Sponza prices: 13.09 ms per-pixel / 4.23 at 2 / 3.84 at 3 — stride 2
  // buys the quality back for +0.4 ms there, and small scenes barely notice
  // (the user's Level: 0.45 ms at 3, ~0.9 at 2).
  //
  // `strideDefault` (2026-08-31): every exact tier uses 2. The former Ultra
  // stride 1 existed because a block whose anchor lay across a silhouette
  // became an invalid checker square. createGiBvhHitShade now searches the
  // four neighbouring REAL anchors and admits only one whose receiver plane
  // matches, preserving the edge without restoring four BVH traversals.
  // `__giBvhReflectStride = 1` remains the exact reference arm.
  const stride = giBvhReflectStride(strideDefault);
  const blocksW = Math.ceil(width / stride);
  const blocksH = Math.ceil(height / stride);
  const widthU = uniform(width, "uint");
  const heightU = uniform(height, "uint");
  const blocksWU = uniform(blocksW, "uint");
  const positionNode = texture(gbuffer.position);
  const normalNode = texture(gbuffer.normal);
  // `colorTarget` (GI Phase 3 v2 — texture-at-hit) is a second StorageTexture
  // (createGiBvhTarget's `bvhColor`) this pass writes alongside `target`:
  // rgb = the hit's ACTUAL texture-sampled albedo (bvhScene.js `firstHit`'s
  // atlas lookup), a = 1 on a hit, 0 on a miss. giLight.js reads both at the
  // same screen UV to substitute real per-pixel texture detail for the
  // mean-color mesh-SDF albedo, on pixels the BVH actually resolved.
  //
  // STRIPING FIX (GI Phase 3 v3). This pass USED TO back the stored t off
  // along the RAY direction (`hit.t.sub(standoff)`) so the shading sample
  // landed just inside the composited field's occupancy shell, matching
  // where the SDF mirror trace this replaces always lands (it undershoots
  // the surface by `hitCut ≈ 0.45·cell` — see giField.js
  // createMirrorTrace). That works head-on, but at a GRAZING reflection
  // angle the ray direction is nearly tangent to the surface, so backing
  // off a fixed t barely moves the sample off the surface at all — it
  // keeps skimming the occupancy shell, and the trilinear gather taps
  // alternate inside/outside voxels: banded/striped shading across an
  // otherwise-flat reflected face (user report). The fix has to depend on
  // the SURFACE's orientation, not the ray's: store the RAW hit t (no
  // standoff at all) plus the hit's EXACT face normal — bvhScene.js
  // `firstHit`'s new `normal` return, octahedral-encoded (see
  // octEncodeNormal above) into this texture's otherwise-unused .zw
  // (t stays .r, dynFlag .g) — and let the consumer (giLight.js) offset
  // the reconstructed hitPoint along THAT normal instead of along the ray.
  const compute = Fn(() => {
    const px = instanceIndex.mod(blocksWU).mul(stride);
    const py = instanceIndex.div(blocksWU).mul(stride);
    const coord = ivec2(px.toInt(), py.toInt());
    const g0 = positionNode.load(coord).toVar();
    const g1 = normalNode.load(coord).toVar();
    const t = float(-1).toVar();
    // g channel: 1 when the ray could cross a BVH-excluded mesh (skinned…)
    // EARLIER than the BVH hit — the consumer must union in the SDF trace
    // there (and ONLY there: a global union re-seals every silhouette with
    // the SDF's melted phantom hits, measured as the harness delta
    // collapsing 20 → 0).
    const dynFlag = float(0).toVar();
    // Hit albedo (GI Phase 3 v2) — stays (0,0,0,0) on every thread that
    // never reaches a hit (no gbuffer geometry, or the BVH trace missed),
    // matching `t`'s own miss default.
    const albedo = vec3(0).toVar();
    const hasAlbedo = float(0).toVar();
    // Oct-encoded hit normal (GI Phase 3 v3) — stays (0,0) on a miss;
    // giLight.js only trusts it when the SAME pixel's hasAlbedo (bvhCol.a)
    // is also set, so an undecoded miss value is never shaded with.
    const octXY = vec2(0).toVar();
    // Geometry here (g0.w) AND a reflective material shades it (g1.w — the
    // mirror mask). Everything else exits with the miss defaults above.
    const live = mask ? g0.w.greaterThan(0.5).and(g1.w.greaterThan(0.5)) : g0.w.greaterThan(0.5);
    If(live, () => {
      const P = g0.xyz.toVar();
      const N = g1.xyz.normalize().toVar();
      const incident = P.sub(cameraPosition).normalize().toVar();
      const R = (rayMode === 'given' ? N : reflect(incident, N)).toVar();
      const origin = P.add((rayMode === 'given' ? R : N).mul(normalOffset)).toVar();
      // TRACED MISS IS ITS OWN VALUE (-2) since 2026-08-21: a ray that ran
      // the whole BVH and left the scene has PROVEN the environment is
      // visible along R, and giLight's env-on-miss term keys on exactly
      // that. -1 stays "never traced" (masked skip / no geometry), whose
      // honest fallback is still the field lookup.
      t.assign(-2);
      // ── §17 R7a — ONE-BVH REFLECTIONS (2026-08-24) ───────────────────────
      //
      // The incumbent core is a LINEAR LOOP over ≤128 seated mesh AABBs per
      // ray, and the 452 unseated Bistro meshes VANISH from reflections
      // (rays pass through to whatever is behind, or exit to the -2 env
      // marker — sky painted through a chair). The static SHADOW BVH already
      // covers EVERY static placement in one world-space BVH8 whose
      // traversal is closest-hit and whose triangles carry their occupancy
      // slot — so one traversal replaces up to 128 slab tests + k BLAS
      // walks AND every prop appears. Hits shade from the per-slot surface
      // palette (mean albedo — textured refinement is §17 R7b); the dyn
      // union below still wins by min(t) exactly as before. When the trace
      // is unavailable (degrade ladder dropped the region, portable) the
      // JS-null falls back to the incumbent path at build time.
      const oneBvhHit = oneBvh ? oneBvh.trace(origin, R, float(1e-4), float(maxDistance)) : null;
      if (oneBvhHit) {
        If(oneBvhHit.x.greaterThanEqual(0), () => {
          t.assign(oneBvhHit.x);
          // ── §18.17: TWO 12-BIT PAIRS, UNPACKED ───────────────────────────
          //
          // The traversal returns t, a normal, a UV and a slot in one vec4f by
          // packing the normal and the UV as 12+12-bit INTEGER-VALUED floats
          // (never a bitcast — see its own banner for why). Both divisions are
          // by a power of two on a value below 2^24, so the unpack is exact.
          const unpack12 = (q) => {
            const hi = q.div(4096).floor().toVar();
            return vec2(hi, q.sub(hi.mul(4096))).div(4095);
          };
          // The WGSL returns the octahedral GEOMETRIC normal (winding-
          // dependent) — face it against the ray like the incumbent's
          // resolve does, then re-encode with the STORAGE convention.
          const nRaw = octDecodeTSL(unpack12(oneBvhHit.y).mul(2).sub(1)).toVar();
          const nFace = select(nRaw.dot(R).lessThan(0), nRaw, nRaw.negate()).toVar();
          octXY.assign(octEncodeNormal(nFace));
          if (oneBvh.palette) {
            const pal = oneBvh.palette;
            // .w is the slot as an integer-valued float (see the WGSL note —
            // a bitcast would be a denormal), so a plain convert is exact.
            const slot = uint(oneBvhHit.w.max(0)).min(uint(Math.max(0, (pal.slots ?? 768) - 1))).toVar();
            const pbase = uint(pal.wordOffset).add(slot.mul(uint(pal.words))).toVar();
            const pa = vec3(
              uintBitsToFloat(pal.bits.element(pbase)),
              uintBitsToFloat(pal.bits.element(pbase.add(uint(1)))),
              uintBitsToFloat(pal.bits.element(pbase.add(uint(2)))),
            ).toVar();
            // live = 0 ⇒ slot never resolved a surface colour — mid-grey,
            // never black (R1's silent dark vote, arriving as data).
            const live = uint(pal.bits.element(pbase.add(uint(7)))).toVar();
            albedo.assign(select(live.greaterThan(uint(0)), pa, vec3(0.5)));
            // ── §18.17 R7b — THE TEXTURE, NOT THE MEAN ─────────────────────
            //
            // §17 R7a bought "every prop appears in a mirror" by paying with
            // "every prop is one flat colour in it" (the user, 2026-08-26:
            // "we average color of the mesh, we need texture sampling, as
            // average color won't work for many cases"). The per-slot tile
            // table + the interpolated UV the traversal now carries close
            // that: `hasTile` = 0 keeps the mean, per slot, so a material
            // past the atlas cap or without a map degrades alone.
            if (oneBvh.albedoAtlas) {
              const at = oneBvh.albedoAtlas;
              const grid = Math.max(1, at.grid ?? 12);
              // RGBA8: x,y are the tile's grid coordinates, w flags "mapped".
              // A byte read back as a normalised float needs the +0.5 before
              // the floor — 11/255 does not round-trip exactly through f32.
              const tl = at.tiles.load(ivec2(slot.toInt(), int(0))).toVar();
              const tileXY = vec2(tl.x, tl.y).mul(255).add(0.5).floor().toVar();
              // HALF-TEXEL INSET. The atlas is LINEAR-filtered and the tiles
              // are packed edge to edge, so a UV that lands at exactly 0 or 1
              // — which `fract()` produces constantly on a tiled texture —
              // blends with the NEIGHBOURING MATERIAL's tile. Insetting by
              // half a texel keeps every sample inside its own tile; it costs
              // half a texel of the texture at the wrap seam, which is the
              // cheaper of the two errors by a wide margin.
              const inset = 0.5 / Math.max(1, at.tilePx ?? 128);
              // Origin = index/grid, scale = 1/grid: the atlas is square and
              // grid-many tiles across by construction, so both are the same
              // build-time constant on either side of the texture.
              const auv = tileXY.add(unpack12(oneBvhHit.z).clamp(inset, 1 - inset)).div(grid).toVar();
              // `.level(0)` is REQUIRED in a compute kernel: there are no
              // fragment derivatives to pick a mip from.
              const texel = at.node.sample(auv).level(0).rgb.toVar();
              albedo.assign(select(tl.w.greaterThan(0.5), texel, albedo));
            }
          } else {
            albedo.assign(vec3(0.5));
          }
          // §17 debug probe (build-time): paint every one-BVH HIT solid
          // yellow — one boot separates "rays miss (black stays)" from
          // "hits shade black (yellow appears)". EXTRA={"__giOneBvhDebug":true}.
          if (globalThis.__giOneBvhDebug) albedo.assign(vec3(1, 1, 0));
          hasAlbedo.assign(1);
        });
        // §17 debug probe, second half: MISSES become fake 1 m hits painted
        // RED so they are visible through the whole consumer chain (a real
        // miss renders env/black and is indistinguishable from dark shading).
        if (globalThis.__giOneBvhDebug) {
          If(t.lessThan(-1.5), () => {
            t.assign(1);
            albedo.assign(vec3(1, 0, 0));
            hasAlbedo.assign(1);
            octXY.assign(octEncodeNormal(N));
          });
        }
      } else {
        const hit = bvhScene.firstHit(origin, R, float(maxDistance));
        If(hit.t.greaterThanEqual(0), () => {
          t.assign(hit.t);
          albedo.assign(hit.albedo);
          hasAlbedo.assign(hit.hasAlbedo);
          octXY.assign(octEncodeNormal(hit.normal));
        });
      }
      // §14 R-D (2026-08-22, "no character in another material with
      // roughness 0 metalness 1"): skinned characters are BVH-excluded
      // (bvhScene.js) and the SDF arm that used to draw them in mirrors is
      // retired on the deferred path (GISystem nulls mirrorTraceFn — the
      // "39s compile wave" note) — so exact reflections showed a world
      // without the player in it. The dynamic-object set already maintains
      // live per-bone flesh boxes/capsules for every character
      // (skinnedProxy.js) and an exact GPU tracer over them — union it
      // here: nearest t wins, the proxy's normal rides .zw exactly like a
      // BVH hit's, and the object's mean albedo rides the color target, so
      // hit shading (createGiBvhHitShade) lights a reflected character
      // like any other surface — field gather + probe floor + cone-shadowed
      // direct. A flesh-box man is blockier than the real mesh; present
      // and lit beats absent. `__giBvhDynReflect = false` is the hatch.
      const dynUnion = dyn && globalThis.__giBvhDynReflect !== false;
      if (dynUnion) {
        const dh = dyn.trace(origin, R, float(0), float(maxDistance), { objId: true });
        If(float(dh.hit).greaterThan(0.5).and(t.lessThan(0).or(float(dh.t).lessThan(t))), () => {
          t.assign(dh.t);
          octXY.assign(octEncodeNormal(dh.normal));
          const surf = dyn.surfaceAt(dyn.splitObj(dh.obj).index);
          albedo.assign(surf.albedo);
          hasAlbedo.assign(1);
        });
      }
      // The coverage flag exists so the (SDF-armed) consumer could union in
      // meshes the BVH can't see. With the dyn union above, those pixels
      // RESOLVE here instead of being flagged — and the flag's only
      // consumer is compiled out on the deferred path anyway.
      if (!globalThis.__giBvhV1 && !dynUnion) {
        dynFlag.assign(bvhScene.dynamicBlocked(origin, R, t, float(maxDistance)));
      }
    });
    const hitOut = vec4(t, dynFlag, octXY.x, octXY.y).toVar();
    const colorOut = vec4(albedo, hasAlbedo).toVar();
    textureStore(target, coord, hitOut);
    if (colorTarget) textureStore(colorTarget, coord, colorOut);
    // The production hit-shade reconstructs from REAL anchors and writes a
    // full radiance texture, so its raw non-anchor stores are dead bandwidth.
    // `replicate` remains for standalone diagnostics and the dormant unshaded
    // fallback, whose direct raw-texture consumer still needs dense texels.
    if (replicate) {
    // The rest of the block. Unrolled in JS because `stride` is a build-time
    // constant — at the default 2 that is three extra texels, each costing two
    // gbuffer loads and a compare against a BVH traversal we did not do.
    // Tolerances are view-RELATIVE (a texel covers more world the further away
    // it is), and deliberately loose: this only has to separate "the same
    // surface" from "a different surface", not preserve curvature.
    const P0 = g0.xyz.toVar();
    const N0 = g1.xyz.normalize().toVar();
    const posTol = P0.sub(cameraPosition).length().mul(0.02).max(0.01).toVar();
    // Rejected neighbours write -1, NOT -2 (2026-08-22; they were -2 for one
    // day). -2 means "a ray ran the whole BVH and PROVED the environment is
    // visible" — a replication rejection has proven nothing of the sort, it
    // is a validation failure at a silhouette. Marking it -2 handed every
    // block seam that straddles detail to giLight's env-on-miss term, which
    // painted SKY-BRIGHT speckle fringes around windows and sun pools on
    // the user's mirrors the moment reflections widened beyond ultra. -1 =
    // "never traced": the material quietly takes the field/probe fallback.
    // The 08-21 rationale this replaces (don't inherit a wrong t — the
    // curved-mirror mosaic) is preserved: the neighbour still gets no t.
    const missOut = vec4(-1, 0, 0, 0);
    const missColor = vec4(0, 0, 0, 0);
    for (let dy = 0; dy < stride; dy++) {
      for (let dx = 0; dx < stride; dx++) {
        if (dx === 0 && dy === 0) continue;
        const cx = px.add(dx);
        const cy = py.add(dy);
        If(cx.lessThan(widthU).and(cy.lessThan(heightU)), () => {
          const nCoord = ivec2(cx.toInt(), cy.toInt());
          const n0 = positionNode.load(nCoord).toVar();
          const n1 = normalNode.load(nCoord).toVar();
          // Normal tolerance 0.9 → 0.965 (2026-08-21): 0.9 admits ~25° of
          // normal swing, which on a curved mirror hands a neighbour a t
          // whose reconstruction (its OWN normal, the block's t) lands on a
          // different surface entirely — block-sized patches of foreign
          // colour. 0.965 (~15°) keeps flat-surface replication intact and
          // sends real curvature to the -2 fallback above.
          const sameSurface = n0.w
            .greaterThan(0.5)
            .and(g0.w.greaterThan(0.5))
            .and(n0.xyz.sub(P0).length().lessThan(posTol))
            .and(n1.xyz.normalize().dot(N0).greaterThan(0.965));
          textureStore(target, nCoord, select(sameSurface, hitOut, missOut));
          if (colorTarget) textureStore(colorTarget, nCoord, select(sameSurface, colorOut, missColor));
        });
      }
    }
    }
  })().compute(blocksW * blocksH);

  return { compute, widthU };
}

/** Monotonic texture version, see the comment in createGiTargets. */
let targetGeneration = 0;

/**
 * The screen-space targets materials sample. Created once per GISystem and
 * kept across rebuilds (only a viewport resize replaces them), because a
 * material compiled against one of these textures keeps that binding until
 * it is recompiled — and never recompiling materials is the entire point.
 */
export function createGiTargets(width, height, shadowWidth = width, shadowHeight = height, { emitterWidth = shadowWidth, emitterHeight = shadowHeight } = {}) {
  // WHY THE VERSION IS FORCED: three invalidates a cached bind group only when
  // `binding.generation !== textureData.generation` (Bindings._update), and
  // `textureData.generation` is just `texture.version` (Textures.updateTexture).
  // A freshly constructed texture has version 0 — so swapping a texture node's
  // value from one brand-new StorageTexture to another is INVISIBLE to that
  // check, and every material's bind group keeps pointing at the old texture.
  // On a viewport resize that old texture is then destroyed, and every
  // subsequent submit fails validation ("Destroyed texture used in a submit")
  // with the GI field gone. A unique version per generation makes the swap
  // actually rebind. Storage textures take the `createTexture` branch
  // regardless of version, so nothing else changes.
  // `globalThis.__giNoTargetVersion` reproduces the old (broken) behaviour for
  // an A/B — see scripts/run-gi-rc-resize.mjs.
  const version = globalThis.__giNoTargetVersion ? 0 : ++targetGeneration;
  const irradiance = new THREE.StorageTexture(width, height);
  irradiance.type = THREE.HalfFloatType;
  irradiance.name = "giIrradiance";
  irradiance.version = version;
  // SHADOW-CHANNEL resolution since 2026-08-06: the emitter shadow traces
  // moved out of the resolve kernel into their own pass at the shadow-pass
  // pixel budget (the same split that took the direct arm from 22ms to
  // 5.4ms) — the texture follows the pass. Materials sample it by UV, so
  // the resolution change is transparent to them; it also finally matches
  // the shadow-res texel size `giScreenTexel` advertises to the material
  // bilateral. `emitterShadowRaw` is the unfiltered trace output the
  // edge-aware filter pass averages into `emitterShadow` — the emitter
  // channel never had ANY spatial filter before, which is a good part of
  // why coarse-voxel presets read blocky.
  const emitterShadow = new THREE.StorageTexture(emitterWidth, emitterHeight);
  emitterShadow.name = "giEmitterShadow";
  emitterShadow.version = version;
  const emitterShadowRaw = new THREE.StorageTexture(emitterWidth, emitterHeight);
  // HALF FLOAT (§11.11, 2026-09-03): the seat-rotating shadow pass marks the
  // seats it did NOT march this frame with a −1 sentinel, which rgba8unorm
  // cannot hold. The dense arm (`__giEmitterSeatRotate = false`) keeps
  // writing [0, 1] and never notices.
  emitterShadowRaw.type = THREE.HalfFloatType;
  emitterShadowRaw.name = "giEmitterShadowRaw";
  emitterShadowRaw.version = version;
  // ══ §11.40 THE STATIC VISIBILITY CACHE (emitter shadows) ═════════════════
  //
  // On a movers-only frame (static world and camera unchanged, a character
  // animating) the emitter shadow pass re-marched the whole screen against
  // the STATIC BVH every other frame — ~8.5 ms per dispatch on the user's
  // Bistro, for a static answer that had not changed. These hold, per pixel
  // and per seat: the static-only visibility, the static blocker distance
  // (−1 = none) and a stamp `generation·4096 + emitterId` that says which
  // static world and which lamp the entry answers for. The marcher
  // (GISystem #buildEmitterRecordTrace) reads them on held frames and only
  // re-tests the MOVERS; a stride of pixels still re-marches each frame so
  // the area-sampled penumbra keeps integrating.
  const emitterStaticVis = new THREE.StorageTexture(emitterWidth, emitterHeight);
  emitterStaticVis.type = THREE.HalfFloatType;
  emitterStaticVis.name = "giEmitterStaticVis";
  emitterStaticVis.version = version;
  const emitterStaticT = new THREE.StorageTexture(emitterWidth, emitterHeight);
  emitterStaticT.type = THREE.HalfFloatType;
  emitterStaticT.name = "giEmitterStaticT";
  emitterStaticT.version = version;
  // FLOAT, not half: the stamp is an integer up to 4096·4096 and must round-trip exactly.
  const emitterStaticStamp = new THREE.StorageTexture(emitterWidth, emitterHeight);
  emitterStaticStamp.type = THREE.FloatType;
  emitterStaticStamp.name = "giEmitterStaticStamp";
  emitterStaticStamp.version = version;
  // The marcher READS the trio above and WRITES this twin: one texture cannot
  // be both a `texture_2d` load and a `textureStore` target in one kernel
  // (the first build failed WGSL parsing on exactly that), so the pass
  // ping-pongs through `createGiEmitterStaticSnapshotPass` (write -> read),
  // the same idiom as the shadow history snapshots.
  const emitterStaticVisNext = new THREE.StorageTexture(emitterWidth, emitterHeight);
  emitterStaticVisNext.type = THREE.HalfFloatType;
  emitterStaticVisNext.name = "giEmitterStaticVisNext";
  emitterStaticVisNext.version = version;
  const emitterStaticTNext = new THREE.StorageTexture(emitterWidth, emitterHeight);
  emitterStaticTNext.type = THREE.HalfFloatType;
  emitterStaticTNext.name = "giEmitterStaticTNext";
  emitterStaticTNext.version = version;
  const emitterStaticStampNext = new THREE.StorageTexture(emitterWidth, emitterHeight);
  emitterStaticStampNext.type = THREE.FloatType;
  emitterStaticStampNext.name = "giEmitterStaticStampNext";
  emitterStaticStampNext.version = version;
  // ANALYTIC-PENUMBRA CHAIN (2026-08-13, plan §12.52.1 unit 2) — the emitter
  // twins of lightShadowMid/lightShadowWide/lightShadowDist. The marcher
  // stopped computing softness (the 12-tap free-radius width probe, whose
  // lattice-inset bounds were the Cornell waffle grain) and now emits a
  // BLOCKER-DERIVED PENUMBRA WIDTH instead; the wide passes turn that width
  // into the actual soft edge. Chain: raw → filter → MID → wide₁ → WIDE →
  // wide₂ → emitterShadow.
  //
  // HALF FLOAT, and unlike its light-channel sibling that is not a
  // preference: `lightShadowDist` stores a distance normalized by the volume
  // span, but this channel stores a WORLD PENUMBRA HALF-WIDTH in metres, and
  // the widths that matter (centimetres to a couple of metres) against a
  // 12-64 m span would quantize to 8-bit steps of up to 25 cm — tens of
  // texels of blur radius per step, i.e. visible radius banding. Storing
  // metres directly also keeps the wide pass free of every emitter uniform:
  // it needs no slot table, no span, no angular size.
  const emitterShadowDist = new THREE.StorageTexture(emitterWidth, emitterHeight);
  emitterShadowDist.type = THREE.HalfFloatType;
  emitterShadowDist.name = "giEmitterShadowDist";
  emitterShadowDist.version = version;
  // §11.11: the DENSE width. Under seat rotation the marcher writes each
  // pixel's width for ONE seat and a −1 sentinel for the rest; the filter
  // pass fills every channel from the nearest same-plane neighbour that
  // marched that seat this frame (nearest, not mean — the channel doubles
  // as the occupancy mask, and a mean would dilute "lit, 0" with widths).
  // The wide passes read THIS texture on that arm.
  const emitterShadowDistFill = new THREE.StorageTexture(emitterWidth, emitterHeight);
  emitterShadowDistFill.type = THREE.HalfFloatType;
  emitterShadowDistFill.name = "giEmitterShadowDistFill";
  emitterShadowDistFill.version = version;
  const emitterShadowMid = new THREE.StorageTexture(emitterWidth, emitterHeight);
  emitterShadowMid.name = "giEmitterShadowMid";
  emitterShadowMid.version = version;
  const emitterShadowWide = new THREE.StorageTexture(emitterWidth, emitterHeight);
  emitterShadowWide.name = "giEmitterShadowWide";
  emitterShadowWide.version = version;
  const radiance = new THREE.StorageTexture(width, height);
  radiance.type = THREE.HalfFloatType;
  radiance.name = "giRadiance";
  radiance.version = version;
  // GI-traced direct shadows: one shadow factor per analytic light slot
  // (RGBA = slots 0-3, see createGiResolve's `lightShadow`). Deliberately the
  // same rgba8 + LinearFilter defaults `emitterShadow` uses — it holds the
  // same kind of value (a smooth 0..1 visibility) and the linear filter is what
  // turns the half-res resolve into a clean full-res penumbra instead of a
  // blocky one. It is created UNCONDITIONALLY, even when the feature is gated
  // off: one rgba8 half-res texture is ~0.5MB, and making it optional would
  // fork createGiTargets/dispose/the resize swap three ways for nothing. What
  // is conditional is whether anything BINDS it.
  // AT ITS OWN (usually coarser) RESOLUTION: the trace behind this texture is
  // the most expensive per-pixel work in the module (~5-7ns/px measured), and
  // it holds smooth visibility that the material-side position-validated
  // bilateral reconstructs — so its pixel count is a cost knob independent of
  // the gather resolve's (see GISystem #lightShadowSize).
  const lightShadow = new THREE.StorageTexture(shadowWidth, shadowHeight);
  lightShadow.name = "giLightShadow";
  lightShadow.version = version;
  // The trace's UNFILTERED output. The march resolves each pixel's
  // visibility along the central (analytic-width arm) or one jittered
  // (stochastic arm) sun direction; the filter pass
  // (createGiLightShadowFilterPass) averages it into `lightShadow`, which is
  // what materials sample; nothing ever binds the raw texture but the two
  // passes.
  const lightShadowRaw = new THREE.StorageTexture(shadowWidth, shadowHeight);
  lightShadowRaw.name = "giLightShadowRaw";
  lightShadowRaw.version = version;
  // Intermediates for the wide-penumbra chain (analytic chain with PCSS:
  // trace → raw → filter → MID → wide₁ → WIDE → wide₂ → lightShadow). Two
  // more rgba8 at shadow res; unconditional for the same non-forking reason
  // as `lightShadowRaw`.
  const lightShadowMid = new THREE.StorageTexture(shadowWidth, shadowHeight);
  lightShadowMid.name = "giLightShadowMid";
  lightShadowMid.version = version;
  const lightShadowWide = new THREE.StorageTexture(shadowWidth, shadowHeight);
  lightShadowWide.name = "giLightShadowWide";
  lightShadowWide.version = version;
  // PCSS blocker distance, one channel per light slot like `lightShadow`:
  // the trace's occluder distance normalized by the shadow span, driving the
  // sample-time penumbra radius (tan(sourceAngle) x blockerDist — Blender sun
  // semantics). rgba8 is enough: the radius needs ~1% distance precision, not
  // a position. LinearFilter deliberately (a blended blocker distance blends
  // the blur radius — exactly the right thing across a penumbra). Created
  // unconditionally like lightShadow; whether the resolve WRITES it is the
  // device-gated part (an unwritten texture reads 0 → radius 0 → sharp).
  const lightShadowDist = new THREE.StorageTexture(shadowWidth, shadowHeight);
  lightShadowDist.name = "giLightShadowDist";
  lightShadowDist.version = version;
  if (import.meta.env?.DEV) globalThis.__giLastTargetVersion = version;
  const targets = {
    irradiance,
    emitterShadow,
    emitterShadowRaw,
    emitterStaticVis,
    emitterStaticT,
    emitterStaticStamp,
    emitterStaticVisNext,
    emitterStaticTNext,
    emitterStaticStampNext,
    emitterShadowDist,
    emitterShadowDistFill,
    emitterShadowMid,
    emitterShadowWide,
    radiance,
    lightShadow,
    lightShadowRaw,
    lightShadowMid,
    lightShadowWide,
    // TEMPORAL TRIO — LAZY (2026-08-06, the analytic-width default): the
    // accumulate/history chain only exists on the stochastic A/B arm, and
    // its history-position texture alone is 14.4MB of rgba32float at the
    // 900k shadow budget (~22MB for the trio). `ensureShadowTemporal()`
    // creates them on demand when a stochastic build actually asks — so an
    // arm flip via `__giShadowAnalyticWidth = false` + rebuild still works
    // against the SAME persistent targets object.
    lightShadowAccum: null,
    lightShadowHist: null,
    lightShadowHistPos: null,
    lightShadowDist,
    ensureShadowTemporal() {
      if (this.lightShadowAccum) return;
      const v = globalThis.__giNoTargetVersion ? 0 : ++targetGeneration;
      // The ACCUMULATED signal (filter+temporal output). Materials do NOT
      // sample this — a second, history-free filter pass cleans it into
      // `lightShadow`. The split keeps the presentation blur OUTSIDE the
      // accumulation loop: post-filtering the fed-back signal would
      // convolve it once per frame and wash every penumbra to flat grey.
      const accum = new THREE.StorageTexture(shadowWidth, shadowHeight);
      accum.name = "giLightShadowAccum";
      accum.version = v;
      // Temporal history (createGiLightShadowFilterPass's reprojection):
      // last frame's accumulated shadow + the world position it was
      // resolved for (full float — half precision at world scale is ~3cm
      // at 50m, the same order as the validity epsilon).
      const hist = new THREE.StorageTexture(shadowWidth, shadowHeight);
      hist.name = "giLightShadowHist";
      hist.version = v;
      const histPos = new THREE.StorageTexture(shadowWidth, shadowHeight);
      histPos.type = THREE.FloatType;
      histPos.name = "giLightShadowHistPos";
      histPos.version = v;
      this.lightShadowAccum = accum;
      this.lightShadowHist = hist;
      this.lightShadowHistPos = histPos;
    },
    // THE EMITTER CHANNEL'S OWN TEMPORAL TRIO — same shape, same laziness, and
    // it did not exist until 2026-08-07.
    //
    // The analytic-light shadow channel gets a spatial bilateral AND ~0.9
    // history accumulation, because its march is a stochastic estimator whose
    // raw output "renders as a static IGN dither" (see the filter pass note).
    // The emitter channel runs the SAME family of estimator — giLight's own
    // comment says "the emitter arm joins the light arm's estimator family" —
    // but was wired with `createGiLightShadowFilterPass` and NO `history`
    // argument, so it got the spatial half and never the temporal half. One 5x5
    // cross-bilateral, every frame, undamped.
    //
    // That is the user's "emissive lighting ... still has dither": a per-frame
    // re-randomised estimate on emissive light only, while the sun channel next
    // to it is temporally integrated over ~a dozen frames and looks clean. It
    // shows up hardest under motion, when reprojection has real work to do.
    emitterShadowAccum: null,
    emitterShadowHist: null,
    emitterShadowHistPos: null,
    ensureEmitterTemporal() {
      if (this.emitterShadowAccum) return;
      const v = globalThis.__giNoTargetVersion ? 0 : ++targetGeneration;
      // HALF FLOAT, NOT THE rgba8 DEFAULT. These two carry an EMA that feeds
      // itself — out = 0.1·spatial + 0.9·hist, stored, re-read next frame — and
      // at 8 bits every store re-quantises, so rounding bias can accumulate over
      // the hundreds of frames the loop runs.
      //
      // HONESTY NOTE: this was introduced to fix a measured 49% energy loss that
      // turned out not to exist (the baseline it was measured against came from
      // a different build — see the method note in GISystem's emitterTemporal
      // block). Promoting these to HalfFloatType changed the result by 0.0%, so
      // the ratchet was NOT happening at the weights and frame counts in play.
      // It stays because a self-feeding EMA in 8 bits is a real hazard and half
      // float costs one extra byte per texel on two emitter-sized targets — but
      // it is insurance, not a fix, and nothing measured has ever needed it.
      const accum = new THREE.StorageTexture(emitterWidth, emitterHeight);
      accum.type = THREE.HalfFloatType;
      accum.name = "giEmitterShadowAccum";
      accum.version = v;
      const hist = new THREE.StorageTexture(emitterWidth, emitterHeight);
      hist.type = THREE.HalfFloatType;
      hist.name = "giEmitterShadowHist";
      hist.version = v;
      const histPos = new THREE.StorageTexture(emitterWidth, emitterHeight);
      histPos.type = THREE.FloatType;
      histPos.name = "giEmitterShadowHistPos";
      histPos.version = v;
      this.emitterShadowAccum = accum;
      this.emitterShadowHist = hist;
      this.emitterShadowHistPos = histPos;
    },
    // ══ THE IRRADIANCE TEMPORAL TRIO (§12.65) — same laziness as the shadow
    // trios and for the same reason (three resolve-res textures ≈ 30MB at
    // editor scale, only paid when the filter is actually built). With the
    // filter on, the RESOLVE writes `irradianceRaw`; the reprojection filter
    // (createGiIrradianceTemporalPass) blends it against `irradianceHist`
    // and writes `irradiance` — the texture materials have ALWAYS sampled,
    // so the persistent material bindings never learn the filter exists.
    irradianceRaw: null,
    irradianceHist: null,
    irradianceHistPos: null,
    ensureIrradianceTemporal() {
      if (this.irradianceRaw) return;
      const v = globalThis.__giNoTargetVersion ? 0 : ++targetGeneration;
      // HalfFloat like `irradiance` itself — raw and hist carry the same
      // signal. The EMA-in-half-float hazard note on the emitter trio
      // applies unchanged (insurance; nothing measured has needed more).
      const raw = new THREE.StorageTexture(width, height);
      raw.type = THREE.HalfFloatType;
      raw.name = "giIrradianceRaw";
      raw.version = v;
      const hist = new THREE.StorageTexture(width, height);
      hist.type = THREE.HalfFloatType;
      hist.name = "giIrradianceHist";
      hist.version = v;
      // Full float world position, exactly like the shadow trios: half
      // precision at 50m is ~3cm — the same order as the validity epsilon.
      const histPos = new THREE.StorageTexture(width, height);
      histPos.type = THREE.FloatType;
      histPos.name = "giIrradianceHistPos";
      histPos.version = v;
      this.irradianceRaw = raw;
      this.irradianceHist = hist;
      this.irradianceHistPos = histPos;
    },
    dispose() {
      irradiance.dispose();
      this.irradianceRaw?.dispose();
      this.irradianceHist?.dispose();
      this.irradianceHistPos?.dispose();
      emitterShadow.dispose();
      emitterShadowRaw.dispose();
      emitterStaticVis.dispose();
      emitterStaticT.dispose();
      emitterStaticStamp.dispose();
      emitterStaticVisNext.dispose();
      emitterStaticTNext.dispose();
      emitterStaticStampNext.dispose();
      emitterShadowDist.dispose();
      emitterShadowDistFill.dispose();
      emitterShadowMid.dispose();
      emitterShadowWide.dispose();
      radiance.dispose();
      lightShadow.dispose();
      lightShadowRaw.dispose();
      lightShadowMid.dispose();
      lightShadowWide.dispose();
      this.lightShadowAccum?.dispose();
      this.lightShadowHist?.dispose();
      this.lightShadowHistPos?.dispose();
      this.emitterShadowAccum?.dispose();
      this.emitterShadowHist?.dispose();
      this.emitterShadowHistPos?.dispose();
      lightShadowDist.dispose();
    },
  };
  return targets;
}

/**
 * One-shot clear of a shadow storage texture to WHITE (unshadowed).
 *
 * The emitter-shadow targets are StorageTextures, which WebGPU
 * ZERO-initializes — and 0 in a visibility channel means FULLY OCCLUDED.
 * The marcher that writes them compiles asynchronously (it is the module's
 * 110kB monster, deliberately not in the warm-up wave at 0 emitters), and
 * while it compiles its dispatch is SKIPPED — so between (re)build and the
 * pipeline landing, every emitter's direct light was multiplied by zero.
 * The user saw it as "the emissive's light and shadows kick in seconds
 * late" (Cornell box, 2026-08-13). A visibility term must fail OPEN: this
 * pass stamps 1 everywhere, once, right after target creation — the same
 * default the marcher itself starts each pixel from. Its own tiny pipeline
 * also compiles async, but at ~1kB it lands orders of magnitude sooner,
 * and the replay guard re-dispatches it on resolution either way.
 */
export function createGiShadowClearPass(target, width, height) {
  const w = Math.max(1, width | 0);
  const total = w * Math.max(1, height | 0);
  const clear = Fn(() => {
    const x = instanceIndex.mod(uint(w)).toInt();
    const y = instanceIndex.div(uint(w)).toInt();
    textureStore(target, ivec2(x, y), vec4(1));
  });
  return { compute: clear().compute(total) };
}

/**
 * Sibling of createGiTargets for the BVH reflect pass's output (see
 * createGiBvhReflect above) — created/retired separately because it is
 * OPTIONAL (quality-gated, runtime-hatchable — see GISystem's
 * `#bvhReflectionsEnabled`), unlike irradiance/emitterShadow which every
 * build needs. Same forced-version trick as createGiTargets (read that
 * function's comment — it is load-bearing on resize, not decorative).
 *
 * Format: a single signed float (hit distance, miss = -1) needs a float
 * type — HalfFloatType on the default RGBAFormat (rgba16float) matches
 * `irradiance`'s own convention and is a base-WebGPU storage-capable format
 * (r16float, notably, is NOT a valid storage-texture format — only r32float
 * is among single-channel floats). Only the R channel carries data.
 *
 * FILTERING IS THE ONE DELIBERATE DEPARTURE from irradiance/emitterShadow's
 * convention: those hold smooth radiance/shadow-factor values where
 * StorageTexture's default LinearFilter blends half-res texels into a
 * softer full-res look — desirable. `t` is a hit DISTANCE, not a color —
 * bilinear-blending two valid t's from adjacent pixels either side of a
 * silhouette (say t=2 hitting a sphere, t=5 hitting the wall behind it)
 * yields t=3.5, which is not on ANY real surface along that ray. Sampling
 * that corrupted t then computes `hitPoint` off in empty space, and
 * whatever `hitSurfaceFn`/`mirrorSampleFn` finds nearest to THAT reads
 * dimmer/wrong — measured as run-gi-rc-mirror's mirrorLeft (sampled right
 * at the mirror sphere's silhouette) landing at rgb(26,0,0) instead of the
 * SDF arm's exact rgb(39,1,0). NearestFilter fixes it: every sample reads
 * one pixel's real, unblended trace result.
 *
 * `bvhColor` (GI Phase 3 v2 — texture-at-hit) is `bvhReflect`'s sibling: the
 * hit's real texture-sampled albedo (rgb) + a hit flag (a). Same NearestFilter
 * reasoning applies even more directly here — it holds a COLOR sampled at a
 * specific triangle, so blending two different hits' colors across a
 * silhouette is exactly as wrong as blending two different t's. Same
 * forced-version trick, created/disposed together with `bvhReflect` (one
 * `createGiBvhTarget()` call, one version, one lifetime).
 */
export function createGiBvhTarget(width, height, { radianceDiv = null } = {}) {
  const version = globalThis.__giNoTargetVersion ? 0 : ++targetGeneration;
  const bvhReflect = new THREE.StorageTexture(width, height);
  bvhReflect.type = THREE.HalfFloatType;
  bvhReflect.minFilter = THREE.NearestFilter;
  bvhReflect.magFilter = THREE.NearestFilter;
  bvhReflect.name = "giBvhReflect";
  bvhReflect.version = version;
  const bvhColor = new THREE.StorageTexture(width, height);
  bvhColor.type = THREE.HalfFloatType;
  bvhColor.minFilter = THREE.NearestFilter;
  bvhColor.magFilter = THREE.NearestFilter;
  bvhColor.name = "giBvhColor";
  bvhColor.version = version;
  // `bvhRadiance` (2026-08-02) holds what the material actually wants: the
  // reflected point's outgoing RADIANCE (rgb) + a valid flag (a), written by
  // the HIT-SHADE pass (createGiBvhHitShade) from `bvhColor`'s albedo and
  // `bvhReflect`'s hit geometry. It is its own texture rather than an
  // overwrite of `bvhColor` because a pass cannot bind the same texture as
  // both a sampled input and a writable storage output.
  //
  // HALF THE RESOLVE GRID + LinearFilter (2026-08-22): hit shading at full
  // res was resolution theater — the prepass already block-replicates t at
  // stride 2, and the marches (up to 3 emitter cones + a sun cone per
  // texel) measured 43.26 ms at the user's 1.6M-pixel ultra resolve. The
  // consumer samples by screenUV only (giLight — verified, no texel loads),
  // so the hardware bilinear is the upsample, exactly the glossy chain's
  // trade. The t/albedo textures STAY full-res (giLight reads exact t per
  // pixel). `__giHitShadeFull = true` restores full-res for an A/B (read at
  // target creation — boot-time, like every structural hatch).
  //
  // `radianceDiv` (§15 perf, 2026-08-22): the caller may widen the divisor
  // below ultra — hit shading measured 4.42 ms of a 16.6 ms GPU frame at
  // div 2 on the user's Level at "high", and the cost is whole-kernel
  // register pressure (∝ threads, not work), so div 3 is a straight ~55%
  // cut. Ultra keeps div 2: per-pixel exactness is that tier's contract.
  // ⭐⭐ §18 W4 — THE DIVISOR IS A MAXIMUM NOW, NOT A CONSTANT, BECAUSE THE
  // RESOLVE UNDER IT CAN MOVE 5x.
  //
  // `radianceDiv: 3` was measured and chosen against a FIXED 1.6 M-pixel ultra
  // resolve, where it yields ~178 k radiance texels — about 3.2x linear
  // magnification onto a 1.88 M-pixel screen, which the hardware bilinear
  // carries. The frame governor (engine/frameGovernor.js) now scales the
  // resolve itself, and a constant divisor turns into a QUALITY CLIFF the
  // moment it does: at governor rung 3 the resolve is 592 k, the radiance grid
  // is 65 k, and one reflection sample covers a 5.4 x 5.4 SCREEN BLOCK.
  //
  // That is a user-visible bug, reported as "reflections look incredibly
  // shitty" with a screenshot of a Vespa whose chrome was blocky red/white/
  // black speckle. Two multiplications of the same reduction stacked: the
  // governor's, and this one.
  //
  // So solve for the divisor that HOLDS the shipped magnification instead of
  // holding the shipped divisor.
  //
  // ⚠⚠ FRACTIONAL, AND THAT IS THE WHOLE TRICK. The first attempt rounded to an
  // integer and its own gate rejected it: an integer step from 3 to 2
  // multiplies radiance texels by 2.25 while one governor rung only removes
  // 28%, so texels went UP between rung 1 and rung 2. That breaks the ladder's
  // monotonicity in cost, which is far worse than the blockiness it fixes — the
  // governor would descend a rung, measure a SLOWER frame, and descend again
  // into a loop it can never win. A fractional divisor is safe because nothing
  // downstream reads it: `createGiBvhHitShade` derives its mapping as
  // `resolveWidth / radianceWidth` from the ACTUAL texture dimensions, and
  // snaps that to the prepass stride (see its own banner on the 3-vs-2 beat).
  //
  // ⚠ CLAMPED AT 2 ON THE CHEAP SIDE, also load-bearing: without it a small
  // resolve solves below 1 and the radiance grid ends up LARGER than it was at
  // full quality. Div >= 2 keeps radiance texels <= resolve/4 at every rung, so
  // cost falls with the rung even where magnification can no longer be held.
  //
  // At full-quality ultra this returns exactly 3.0 — the shipped value,
  // unchanged, which is the point: it only engages where the governor has
  // already spent resolve.
  const capDiv = globalThis.__giHitShadeFull ? 1 : (radianceDiv ?? 2);
  const TARGET_RADIANCE_TEXELS = 178_000;
  const solved = Math.sqrt((width * height) / TARGET_RADIANCE_TEXELS);
  const radDiv = capDiv <= 1 ? capDiv : Math.min(capDiv, Math.max(2, solved));
  const radW = Math.max(1, Math.round(width / radDiv));
  const radH = Math.max(1, Math.round(height / radDiv));
  const bvhRadiance = new THREE.StorageTexture(radW, radH);
  bvhRadiance.type = THREE.HalfFloatType;
  bvhRadiance.minFilter = THREE.LinearFilter;
  bvhRadiance.magFilter = THREE.LinearFilter;
  bvhRadiance.name = "giBvhRadiance";
  bvhRadiance.version = version;
  // The hit-radiance temporal chain (2026-08-22, with §14 R-A): the same
  // §12.65 fail-safe triplet the irradiance and glossy chains carry — the
  // hit-shade pass writes RAW and the sampled target both, the filter
  // overwrites the target when alive, the snapshot keeps hist+histPos. The
  // hit radiance was the ONLY per-pixel GI term with no temporal filter,
  // and it showed: per-texel cone-shadow and gather variance rendered as
  // speckle across every mirror.
  const bvhRadianceRaw = new THREE.StorageTexture(radW, radH);
  bvhRadianceRaw.type = THREE.HalfFloatType;
  bvhRadianceRaw.minFilter = THREE.NearestFilter;
  bvhRadianceRaw.magFilter = THREE.NearestFilter;
  bvhRadianceRaw.name = "giBvhRadianceRaw";
  bvhRadianceRaw.version = version;
  const bvhRadianceHist = new THREE.StorageTexture(radW, radH);
  bvhRadianceHist.type = THREE.HalfFloatType;
  bvhRadianceHist.minFilter = THREE.NearestFilter;
  bvhRadianceHist.magFilter = THREE.NearestFilter;
  bvhRadianceHist.name = "giBvhRadianceHist";
  bvhRadianceHist.version = version;
  const bvhRadianceHistPos = new THREE.StorageTexture(radW, radH);
  bvhRadianceHistPos.type = THREE.HalfFloatType;
  bvhRadianceHistPos.minFilter = THREE.NearestFilter;
  bvhRadianceHistPos.magFilter = THREE.NearestFilter;
  bvhRadianceHistPos.name = "giBvhRadianceHistPos";
  bvhRadianceHistPos.version = version;
  return {
    bvhRadiance,
    bvhRadianceRaw,
    bvhRadianceHist,
    bvhRadianceHistPos,
    radianceWidth: radW,
    radianceHeight: radH,
    bvhReflect,
    bvhColor,
    dispose() {
      bvhReflect.dispose();
      bvhColor.dispose();
      bvhRadiance.dispose();
      bvhRadianceRaw.dispose();
      bvhRadianceHist.dispose();
      bvhRadianceHistPos.dispose();
    },
  };
}

/**
 * GPU-blits atlas tiles the canvas 2D path in bvhScene.js's buildAlbedoAtlas
 * could not draw — overwhelmingly KTX2/Basis-compressed material maps, which
 * have no CPU-readable `.image` for `ctx.drawImage` to sample (see that
 * function's own comment). The compute shader that actually SAMPLES the
 * atlas (bvhScene.js `firstHit`) has no such limitation: a compressed
 * texture is real, native GPU data, decoded by the sampler hardware exactly
 * like any other texture — the only reason those tiles were ever a flat
 * mean color is that the CANVAS couldn't see the pixels, not that the GPU
 * can't.
 *
 * One-shot per bvhScene build, entirely self-guarding: a no-op whenever
 * `bvhScene.pendingGpuTiles` is empty, which is true both BEFORE the first
 * call that has real work to do and forever AFTER that call finishes (it
 * clears the list). Callers (GISystem's `#tick`) can therefore call this
 * every frame unconditionally — see that call site's own comment.
 *
 * MECHANISM: two kinds of ordinary textured-quad passes (three's own
 * QuadMesh — the exact idiom every postprocessing pass in this three.js
 * build uses to relay one texture into another render target) into a fresh
 * 2048x2048 target: first the EXISTING canvas atlas whole (so every
 * already-drawn/solid-filled tile survives unchanged), then one quad per
 * pending tile with the viewport+scissor restricted to that tile's 256x256
 * rect, sampling the compressed map directly. Renderer state is saved and
 * restored via three's own RendererUtils — the same helper three's
 * postprocessing nodes use for exactly this "nested render mid-frame" shape
 * (renderGiGBuffer above hand-rolls the same idea for a narrower, scene/
 * camera-specific set of fields; this pass only ever touches the renderer).
 *
 * COLOR SPACE: the destination target is declared LINEAR colorSpace
 * (HalfFloatType has no `-srgb` GPU format variant to begin with, so this
 * is belt-and-braces, not load-bearing, for THAT type specifically — but it
 * is the semantically correct label and keeps the invariant explicit).
 * `texture(atlasTexture)`/`texture(map)` sampling auto-decodes each SOURCE
 * (both declared SRGBColorSpace, like any authored color texture) to linear
 * exactly once, at the GPU-format level — this renderer never bakes a
 * second, shader-side color-space conversion on top (see TextureNode's
 * `needsToWorkingColorSpace` callers: always format/hardware-driven here,
 * never WGSL-codegen-driven), so the linear value sampled is exactly the
 * linear value stored, and exactly the linear value read back later with no
 * further decode. A solid-fill tile therefore reads the SAME color before
 * and after this pass runs (old atlas, sRGB-decoded once → stored linear →
 * new target, read with no decode) — that equivalence is the whole
 * color-space correctness bar for this function, and is what makes swapping
 * `atlasTextureNode.value` afterward safe without rebuilding bvhScene's
 * already-compiled compute graph.
 *
 * @param {import("three/webgpu").Renderer} renderer
 * @param {ReturnType<typeof import("./bvh/bvhScene.js").buildBvhScene>} bvhScene
 * @return {number} Tiles actually blitted this call (0 = no-op).
 */
// ── THE ONE-SHOT BLIT MATERIALS ARE SHARED, NOT MINTED PER CALL ─────────────
//
// (2026-09-02, the first-lit freeze.) Every texture average, every GPU pixel
// readback and every atlas tile used to build a fresh `NodeMaterial` with a
// fresh `texture(tex)` node. three names a node's binding after the node's ID
// (`nodeTexture_<id>`), so each of those materials generated DIFFERENT WGSL
// for the same one-line shader, three's program cache (keyed by source) saw
// a new program every time, and every call paid a SYNC `createRenderPipeline`
// on the GPU process's command thread — `probe:gi-boot-frames` caught twelve
// of them, 1.1–1.2 kB each, in the 2.4 s frame at the moment the field lit.
// One material per (colour space, format, type, tinted?) keeps the source —
// and therefore the pipeline — identical across calls; the texture is a
// BINDING, repointed through the node's `.value`, and every caller renders
// through a NEW QuadMesh so the repointed value reaches a fresh bind group
// (a reused mesh would keep the first texture: `Bindings.updateForRender`
// only runs on a refresh, the 740c6ce law).
const _blitMaterials = new Map();
function blitMaterialFor(tex, { tint = false } = {}) {
  const key = `${tint ? "t" : "c"}|${tex.colorSpace}|${tex.isCompressedTexture ? 1 : 0}|${tex.format}|${tex.type}`;
  let entry = _blitMaterials.get(key);
  if (!entry) {
    const node = texture(tex);
    const tintU = tint ? uniform(new THREE.Vector4(1, 1, 1, 1)) : null;
    const material = new THREE.NodeMaterial();
    material.name = tint ? "GI blit (tinted)" : "GI blit";
    material.colorNode = tint ? node.mul(tintU) : node;
    material.transparent = false;
    material.depthTest = false;
    material.depthWrite = false;
    material.fog = false;
    entry = { node, tintU, material };
    _blitMaterials.set(key, entry);
  }
  entry.node.value = tex;
  return entry;
}

/**
 * Mean LINEAR color of a texture the CPU cannot draw (KTX2/basis), on the GPU.
 *
 * The shader decodes what the canvas cannot: sampling an sRGB-format
 * compressed texture yields LINEAR values in-shader, so a 32×32 quad render
 * into a linear rgba8 target followed by one readback is an unbiased linear
 * mean (no Jensen correction needed — the sRGB-space-downsample bias that
 * forced voxelizeOnce's canvas path up to 128×128 does not exist here,
 * because the bilinear filtering happens in linear space).
 *
 * Same nested-render discipline as blitBvhAtlasTiles above: resetRendererState
 * (MRT/renderObjectFunction NULLED — the compile-wave leak class), restore in
 * finally. Alpha-weighted like the canvas path, for the same alphaTest-foliage
 * reason.
 *
 * @param {import("three/webgpu").Renderer} renderer
 * @param {THREE.Texture} tex  a compressed texture
 * @return {Promise<{r:number,g:number,b:number}|null>}
 */
// ── ONE-SHOT READBACK TARGETS ARE POOLED, NEVER DISPOSED (2026-09-02) ──────
//
// three keys a RenderContext by ATTACHMENT SHAPE (`RenderContexts.get`:
// `count:format:type:samples:depth:stencil` + mrt), not by target — so every
// RGBA8/no-depth target in the process shares ONE context object, and the
// context's `textures` is whatever rendered through it last. `compileAsync`
// holds its context across an await per object. The editor's selection-
// outline prewarm compiled its (RGBA8/no-depth) mask target while the GI
// build ran these readbacks through the same context and then DISPOSED the
// target: the compile resumed with `context.textures[0]` = a dead texture,
// the backend had no format for it, and every scene switch could log
// "Async render pipeline creation failed (selectionOutlineMask:…): …
// 'format' … Required member is undefined" (`scripts/.tmp-scene-switch.mjs`
// reproduces it ~1 run in 2). A pooled target stays valid for as long as any
// shared context can point at it; the per-use `texture.version` bump keeps
// the bind-group cache honest exactly as before.
const oneShotTargets = new Map();
function oneShotTargetFor(size, name) {
  const key = `${size}:${name}`;
  let rt = oneShotTargets.get(key);
  if (!rt) {
    rt = new THREE.RenderTarget(size, size, {
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    rt.texture.name = name;
    rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
    // Versioned ONCE. The per-call bump the disposable targets carried made
    // three destroy and re-create the pooled GPU texture on every use, while
    // the previous readback's copy was still in flight — "Destroyed texture
    // [giTexPixels] used in a submit", raised inside whatever async pipeline
    // error scope happened to be open, which marked an unrelated MATERIAL
    // pipeline as failed. A persistent texture has a stable identity; nothing
    // binds it as a sampler, so no bind-group cache needs the bump.
    rt.texture.version = ++targetGeneration;
    oneShotTargets.set(key, rt);
  }
  return rt;
}

export async function computeCompressedTextureAverage(renderer, tex) {
  // The shared blit samples 2D only — see isFlatTexture.
  if (!isFlatTexture(tex)) return null;
  const size = 32;
  const rt = oneShotTargetFor(size, "giTexAverage");
  const rendererState = THREE.RendererUtils.resetRendererState(renderer);
  const quad = new THREE.QuadMesh();
  try {
    renderer.setRenderTarget(rt);
    renderer.setScissorTest(false);
    rt.viewport.set(0, 0, size, size);
    rt.scissor.set(0, 0, size, size);
    quad.material = blitMaterialFor(tex).material;
    quad.render(renderer);
  } finally {
    THREE.RendererUtils.restoreRendererState(renderer, rendererState);
  }
  try {
    const px = await readRenderTargetImage(renderer, rt, size, size);
    let r = 0, g = 0, b = 0, w = 0;
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3] / 255;
      r += (px[i] / 255) * a;
      g += (px[i + 1] / 255) * a;
      b += (px[i + 2] / 255) * a;
      w += a;
    }
    return w > 1e-3 ? { r: r / w, g: g / w, b: b / w } : null;
  } finally {
    // pooled — see oneShotTargetFor
  }
}

/**
 * Raw pixels of a texture the CPU cannot decode (KTX2/basis) — the same GPU
 * blit computeCompressedTextureAverage uses, returned WHOLE instead of
 * averaged, for consumers that need SPATIAL samples (skinnedProxy's
 * per-bone colours: the character's skin is routinely KTX2 in projects with
 * texture compression on, and the CPU canvas sampler silently returns null
 * there — every reflected character came out a grey mannequin).
 *
 * Returns `size`² tightly packed rgba8 LINEAR bytes, row 0 at the TOP
 * (readRenderTargetImage's contract) — a three-style UV samples at
 * `y = floor((1 − v) · size)`. Null when the readback yields nothing.
 */
export async function readTexturePixelsGPU(renderer, tex, size = 64) {
  if (!isFlatTexture(tex)) return null;
  const rt = oneShotTargetFor(size, "giTexPixels");
  const rendererState = THREE.RendererUtils.resetRendererState(renderer);
  const quad = new THREE.QuadMesh();
  try {
    renderer.setRenderTarget(rt);
    renderer.setScissorTest(false);
    rt.viewport.set(0, 0, size, size);
    rt.scissor.set(0, 0, size, size);
    quad.material = blitMaterialFor(tex).material;
    quad.render(renderer);
  } finally {
    THREE.RendererUtils.restoreRendererState(renderer, rendererState);
  }
  try {
    const px = await readRenderTargetImage(renderer, rt, size, size);
    return px?.length ? px : null;
  } finally {
    // pooled — see oneShotTargetFor
  }
}

export function blitBvhAtlasTiles(renderer, bvhScene) {
  const pending = bvhScene?.pendingGpuTiles;
  if (!pending || pending.length === 0) return 0;
  // §18.17: the atlas carries its own geometry when it has one (the per-slot
  // reflection atlas uses smaller tiles — see SLOT_ATLAS_GRID's VRAM note);
  // the seated atlas has none and keeps the module constants.
  const atlasSize = bvhScene.atlasSize ?? ALBEDO_ATLAS_SIZE;
  const atlasTile = bvhScene.atlasTile ?? ALBEDO_ATLAS_TILE;
  const atlasGrid = bvhScene.atlasGrid ?? ALBEDO_ATLAS_GRID;

  const rt = new THREE.RenderTarget(atlasSize, atlasSize, {
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  rt.texture.name = "giBvhAtlasBlit";
  rt.texture.type = THREE.HalfFloatType;
  // Belt-and-braces label — see the COLOR SPACE note above for why this
  // isn't actually load-bearing for a HalfFloatType target in this renderer.
  rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
  rt.texture.wrapS = THREE.ClampToEdgeWrapping;
  rt.texture.wrapT = THREE.ClampToEdgeWrapping;
  // Forced-unique version — see createGiTargets' own comment on
  // `targetGeneration`: a freshly constructed texture defaults to version 0,
  // invisible to the bind-group-invalidation check three does when
  // `atlasTextureNode.value` is repointed below unless the new version is
  // guaranteed different from whatever was bound (the canvas atlas) before.
  rt.texture.version = ++targetGeneration;

  // resetRendererState, NOT saveRendererState: reset additionally NULLS the
  // renderer's MRT and renderObjectFunction (three's own pattern for every
  // internal quad pass). This blit can run while the compile wave has the
  // postprocess scene-pass MRT pinned on the renderer — PassNode.compileAsync
  // sets its MRT, then AWAITS a multi-second compile with frames still
  // flowing — and a bare colorNode quad material built under that MRT
  // generates a fragment whose output struct is EMPTY ("structures must have
  // at least one member"): an invalid pipeline that, once cached, poisons
  // every command buffer that touches it (the renderGiGBuffer/occluder/
  // selection-outline class). Found live on the user's Sponza the first time
  // this path ran with KTX2 tiles during a boot wave, 2026-08-14.
  const rendererState = THREE.RendererUtils.resetRendererState(renderer);
  const quad = new THREE.QuadMesh();
  let blitted = 0;
  try {
    // ⭐⭐ EVERY QUAD HERE IS ITS OWN RENDER PASS, AND A RENDER PASS CLEARS THE
    // WHOLE ATTACHMENT — THE SCISSOR ONLY BOUNDS THE DRAW.
    //
    // This is the bug that made textured reflections black (2026-08-26, the
    // user: "reflectors are just black, it happened after wiring texture
    // sampling"). Pass 1 relayed the canvas, then tile 1's pass cleared it
    // away, then tile 2 cleared tile 1, and so on — the finished atlas held
    // exactly ONE tile. Measured: 0.61% of texels non-black on the 1536²
    // blit, against 17.8% on the canvas it was supposed to relay, and 17.8%
    // is exactly the 25 filled tiles of a 12x12 grid. The one-BVH path had
    // been sampling that ruin ever since §18.17 pointed it at the atlas, and
    // the SEATED atlas has been just as broken since this function was
    // written (2026-08-14) — invisible only because its consumer still used
    // the per-slot MEAN albedo.
    //
    // ⚠ `autoClear = false` is enough HERE and is NOT enough in general.
    // three's `Background.update` reads `renderer.autoClear || forceClear`,
    // and ANY opaque Color `scene.background` raises `forceClear` — that OR
    // is what defeated the gbuffer mask for four sessions. A QuadMesh renders
    // through an internal scene with no background, so nothing on this path
    // can raise it. Confirmed by reading the atlas back rather than by
    // reading three: `node scripts/run-gi-reflect-black-probe.mjs`.
    renderer.autoClear = false;
    renderer.setRenderTarget(rt);
    renderer.setScissorTest(false);
    rt.viewport.set(0, 0, atlasSize, atlasSize);
    rt.scissor.set(0, 0, atlasSize, atlasSize);

    // Pass 1: relay the existing canvas atlas forward whole, so every tile
    // the CPU path already drew or solid-filled survives unchanged.
    quad.material = blitMaterialFor(bvhScene.atlasTexture).material;
    quad.render(renderer);

    // Pass 2+: one quad per pending tile, viewport+scissor restricted to
    // that tile's rect, sampling the compressed map directly — the GPU can
    // decode it even though the canvas never could.
    //
    // ⭐ ONE MATERIAL, ONE PIPELINE, N RENDERS (2026-09-02, the first-lit
    // freeze). The tint used to be a per-tile LITERAL (`vec4(tint.r, …)`)
    // baked into the fragment source, so every tile was a distinct WGSL
    // program and a distinct SYNC `createRenderPipeline` — 15 of the 29
    // pipelines the boot ledger caught inside one 2.4 s frame at the moment
    // the field lit (8 + 7 tiles across the two atlases), each compiled
    // serially on the GPU process's wire thread. The map and the tint are
    // now the two things that vary, and both vary as BINDINGS: one texture
    // node whose `.value` is repointed per tile and one vec4 uniform, so
    // the shader text is identical for every tile and the second tile
    // onward finds the pipeline already in three's cache.
    renderer.setScissorTest(true);
    for (const { map, tileIndex, tint } of pending) {
      if (!isFlatTexture(map)) continue; // the relayed tile stands
      const tileX = (tileIndex % atlasGrid) * atlasTile;
      const tileY = Math.floor(tileIndex / atlasGrid) * atlasTile;
      rt.viewport.set(tileX, tileY, atlasTile, atlasTile);
      rt.scissor.set(tileX, tileY, atlasTile, atlasTile);
      const entry = blitMaterialFor(map, { tint: true });
      entry.tintU.value.set(tint?.r ?? 1, tint?.g ?? 1, tint?.b ?? 1, 1);
      // A quad PER TILE: the shared material's texture node was just
      // repointed, and only a new mesh (a new RenderObject) is guaranteed to
      // bind the new texture — see blitMaterialFor.
      const tileQuad = new THREE.QuadMesh(entry.material);
      tileQuad.render(renderer);
      blitted++;
    }
  } finally {
    THREE.RendererUtils.restoreRendererState(renderer, rendererState);
  }

  // Repoint the PERSISTENT atlas texture node (see bvhScene.js's own
  // comment on `atlasTextureNode`) at the blitted target — the already-
  // compiled bvhReflect compute graph picks this up next dispatch with no
  // rebuild, exactly like GISystem's own `_giBvhReflectNode.value` swaps.
  bvhScene.atlasTextureNode.value = rt.texture;
  bvhScene.blitTarget = rt;
  pending.length = 0;
  return blitted;
}
