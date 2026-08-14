// @ts-check
import * as THREE from "three/webgpu";
import { Fn, float, max, mix, step, texture, uniform, uv, vec2, vec4 } from "three/tsl";
import { EDITOR_LAYER, SELECTION_ACTIVE_LAYER, SELECTION_MASK_LAYER } from "../engine/editorLayers.js";
import { vmSingleton } from "./singleton.js";

/**
 * Blender-style silhouette outline for the selected entities.
 *
 * WHY NOT A BOUNDING BOX. The viewport used to bracket the selection with a
 * world-axis-aligned wireframe box (`THREE.BoxHelper` / `Box3Helper`). A box is
 * cheap and tells you the extents, but it is a poor SELECTION cue: it hides the
 * thing you just clicked behind eight lines that belong to no surface, it says
 * nothing about which of two overlapping objects you actually hit, and on a
 * rotated or non-convex mesh the box is mostly empty space. Every DCC app
 * solves this the same way — trace the object's own silhouette.
 *
 * HOW. Screen space, in three passes — mask + horizontal dilate PRE-render
 * (updateSelectionOutlineMask), the final composite either as one post-render
 * quad (direct frames) or inside the postprocess pipeline's output node
 * (applySelectionOutlineOverlay) when one owns the camera:
 *
 *   1. MASK. Render only the selected meshes into an RGBA8 target with a flat
 *      override material: red channel = "selected", green channel = "active"
 *      (Blender's distinction — the active object is the one an operation acts
 *      on, and it gets the lighter orange). Depth testing is off, so this is a
 *      pure union-of-coverage mask, not a visibility test.
 *   2. DILATE. Grow the mask by `radius` pixels horizontally into a second
 *      target, then vertically inside the composite. A separable max filter
 *      costs 2*(2r+1) taps instead of the (2r+1)^2 a single-pass disc would.
 *   3. COMPOSITE. `dilated AND NOT mask` is exactly the ring of pixels within
 *      `radius` of a silhouette edge but outside the object — the outline.
 *      Drawn as a fullscreen quad over the finished frame.
 *
 * A geometric alternative (the "inverted hull": re-draw the mesh inflated along
 * its normals with front faces culled) needs no render targets at all, but it
 * splits open at every hard edge — the exact corners of the exact cube in the
 * screenshot this was written from — because a hard edge has no shared normal
 * to inflate along. Screen space has no such failure mode and gives a constant
 * pixel width regardless of distance, which is what makes the cue readable on a
 * far-away prop.
 *
 * WHY THE MASK PASS IS SAFE. The selected meshes are isolated by moving them
 * onto {@link SELECTION_MASK_LAYER} / {@link SELECTION_ACTIVE_LAYER} and
 * pointing the camera's layer mask at exactly that bit. Both the layer masks
 * and `visible` are saved and restored inside the same synchronous block, so
 * nothing else in the frame can observe them — which matters, because
 * `mesh.layers.mask` is part of the static-batching key (see `batching.js`) and
 * a bit left set across a rebuild would quietly pull a selected mesh out of its
 * batch, or leak the bit onto a batch proxy and drag the whole batch into the
 * mask.
 *
 * COST, measured on a 400-mesh scene at 1400x900 (submit time per frame, the
 * number the stats overlay calls "GPU"): 3.3ms with nothing selected, 4.5ms
 * with one object, 5.2ms with a hundred, 6.8ms with a 400-mesh subtree. So the
 * floor is ~1.2ms — three extra render calls (mask, dilate, composite) plus the
 * output blit each one costs — and it grows only with how much of the scene is
 * actually selected. Nothing is allocated or rendered when the selection is
 * empty.
 *
 * KNOWN LIMITS, deliberate:
 *   - The outline is not occluded. A selected object behind a wall still shows
 *     its silhouette, because the mask pass has no scene depth to test against
 *     and reading the main pass's depth back would cost more than the whole
 *     effect. In an editor "where did my selection go" is worth more than strict
 *     occlusion; Blender hides it, we don't.
 *   - Edges are crisp, not antialiased — same as every other editor overlay
 *     here (grid, gizmo, debug draw). A 4x multisampled mask target would fix
 *     it if that ever reads as cheap-looking.
 *   - Particles (`THREE.Sprite`) and impostor-swapped LOD levels get no
 *     outline: the override material can't reproduce a sprite's billboard
 *     vertex transform, and an impostor's billboard doesn't live under the
 *     entity's own `object3D`.
 */

/** Blender's own theme colours: "Active Object" and "Object Selected". */
const ACTIVE_COLOR = 0xffa040;
const SELECTED_COLOR = 0xed5700;

/** Outline half-width in CSS pixels. Blender's is 2; thicker reads as a glow. */
const WIDTH_CSS_PX = 2;

/** Guards the unrolled tap loops on a hypothetical 8x-DPI display. */
const MAX_RADIUS = 6;

const SELECTED_BIT = 1 << SELECTION_MASK_LAYER;
const ACTIVE_BIT = 1 << SELECTION_ACTIVE_LAYER;

const _size = new THREE.Vector2();

const state = vmSingleton("selectionOutline", () => ({
  /** @type {THREE.Object3D[]} Roots whose subtrees are outlined. */
  roots: [],
  /** @type {THREE.Object3D|null} The active root — drawn in the lighter colour. */
  activeRoot: null,
  /** @type {{mesh: THREE.Mesh, active: boolean}[]} Flattened, cached. */
  entries: [],
  /** Set when the scene tree may have changed under a selected root. */
  dirty: false,
  enabled: true,
  /** Dilation radius in device pixels the current materials were built for. */
  radius: 0,
  /** @type {THREE.RenderTarget|null} */
  maskTarget: null,
  /** @type {THREE.RenderTarget|null} */
  dilateTarget: null,
  /** @type {THREE.QuadMesh|null} */
  quad: null,
  /** @type {THREE.NodeMaterial|null} */
  maskSelectedMaterial: null,
  /** @type {THREE.NodeMaterial|null} */
  maskActiveMaterial: null,
  /** @type {THREE.NodeMaterial|null} */
  dilateMaterial: null,
  /** @type {THREE.NodeMaterial|null} */
  compositeMaterial: null,
  /** @type {any} vec2 uniform: one texel of the current target. */
  texel: null,
  /**
   * True while the mask/dilate targets hold a live ring. Cleared (with a real
   * GPU clear of both targets) the frame the selection empties, so neither the
   * post-render composite nor the postprocess overlay can show a stale ring.
   */
  ringLive: false,
  /**
   * Float uniform: the current dilation radius, read per-tap by the overlay
   * node (see applySelectionOutlineOverlay) so a DPI change never forces the
   * postprocess pipeline to rebuild — its tap loop is unrolled to MAX_RADIUS
   * and gated at runtime.
   */
  overlayRadiusU: null,
}));

/**
 * Sets what the outline traces.
 *
 * @param {THREE.Object3D[]} roots Subtree roots to outline (usually one
 *   `entity.object3D` per selected entity).
 * @param {THREE.Object3D|null} [activeRoot] The root drawn in the active
 *   colour — Blender's "active object", i.e. the last one clicked.
 */
export function setSelectionOutline(roots, activeRoot = null) {
  state.roots = roots ?? [];
  state.activeRoot = activeRoot ?? null;
  state.dirty = true;
}

/**
 * Marks the cached mesh list stale. Call when the scene tree changes — a
 * prefab respawn rebuilds a selected entity's subtree behind our back, and the
 * cached `THREE.Mesh` references would outline a destroyed object.
 */
export function invalidateSelectionOutline() {
  state.dirty = true;
}

/** Hides/shows the outline without forgetting what is selected. */
export function setSelectionOutlineEnabled(enabled) {
  state.enabled = enabled !== false;
}

/* -------------------------------------------------------------------------- */

/**
 * Collects the drawable meshes under `root`.
 *
 * Editor-only subtrees are skipped WHOLE (an early return inside `traverse`
 * would still visit their children): a light's cone helper or a camera's body
 * model would otherwise inflate the silhouette of the entity it belongs to.
 */
function collectMeshes(root, active, out, seen) {
  if (!root) return;
  if (root.userData?.editorOnly || root.userData?.batchProxy) return;
  if (root.layers.isEnabled(EDITOR_LAYER)) return;
  if (root.isMesh && !root.isSprite && !seen.has(root)) {
    seen.add(root);
    out.push({ mesh: root, active });
  }
  for (const child of root.children) collectMeshes(child, active, out, seen);
}

function refreshEntries() {
  if (!state.dirty) return;
  state.dirty = false;
  const entries = [];
  const seen = new Set();
  // Active first: a mesh reachable from both the active root and another
  // selected root (a parent/child pair, both selected) belongs to the active
  // one, so `seen` must have claimed it before the plain pass runs.
  if (state.activeRoot) collectMeshes(state.activeRoot, true, entries, seen);
  for (const root of state.roots) {
    if (root === state.activeRoot) continue;
    collectMeshes(root, false, entries, seen);
  }
  state.entries = entries;
}

function ensureTargets(width, height) {
  if (!state.maskTarget) {
    state.maskTarget = makeTarget(width, height, "selectionOutlineMask");
    state.dilateTarget = makeTarget(width, height, "selectionOutlineDilate");
  }
  if (state.maskTarget.width !== width || state.maskTarget.height !== height) {
    state.maskTarget.setSize(width, height);
    state.dilateTarget?.setSize(width, height);
  }
}

function makeTarget(width, height, name) {
  const target = new THREE.RenderTarget(width, height, {
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    // Nearest everywhere: the mask is binary coverage, and a filtered tap
    // would report "half covered" for texels the dilation then grows from.
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    // Sampling past the edge must not wrap an outline around the screen.
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    // Linear, not sRGB: these hold coverage, not colour. Declaring sRGB would
    // make the backend pick an `-srgb` format and encode the 1.0s on write.
    colorSpace: THREE.LinearSRGBColorSpace,
  });
  target.texture.name = name;
  return target;
}

/**
 * Flat mask material. `side: DoubleSide` because coverage is all we want: a
 * single-sided plane viewed from behind still has a silhouette.
 */
function makeMaskMaterial(channel) {
  const material = new THREE.NodeMaterial();
  material.colorNode = channel === "active" ? vec4(0, 1, 0, 1) : vec4(1, 0, 0, 1);
  material.side = THREE.DoubleSide;
  material.depthTest = false;
  material.depthWrite = false;
  material.fog = false;
  material.toneMapped = false;
  material.name = `selectionOutlineMask:${channel}`;
  return material;
}

/**
 * Builds the two fullscreen materials for a given dilation radius.
 *
 * The tap loops are unrolled in JS rather than expressed as a TSL `Loop` over a
 * uniform bound, so the shader has no dynamic branching and the radius is a
 * compile-time constant. The trade is a rebuild when the radius changes, which
 * happens only when the display's pixel ratio does.
 */
function buildFullscreenMaterials(radius) {
  const maskTexture = state.maskTarget.texture;
  const dilateTexture = state.dilateTarget.texture;
  const texel = state.texel;
  const activeColor = uniform(new THREE.Color(ACTIVE_COLOR));
  const selectedColor = uniform(new THREE.Color(SELECTED_COLOR));

  state.dilateMaterial?.dispose();
  state.compositeMaterial?.dispose();

  // Pass 2: horizontal max.
  const dilate = new THREE.NodeMaterial();
  dilate.colorNode = Fn(() => {
    const base = uv();
    let acc = /** @type {any} */ (texture(maskTexture, base));
    for (let i = 1; i <= radius; i++) {
      const offset = vec2(texel.x.mul(i), 0);
      acc = max(acc, texture(maskTexture, base.add(offset)));
      acc = max(acc, texture(maskTexture, base.sub(offset)));
    }
    return acc;
  })();
  dilate.depthTest = false;
  dilate.depthWrite = false;
  dilate.fog = false;
  dilate.toneMapped = false;
  dilate.name = "selectionOutlineDilate";

  // Pass 3: vertical max, minus the mask itself, blended over the frame.
  const composite = new THREE.NodeMaterial();
  composite.colorNode = Fn(() => {
    const base = uv();
    let grown = /** @type {any} */ (texture(dilateTexture, base));
    for (let i = 1; i <= radius; i++) {
      const offset = vec2(0, texel.y.mul(i));
      grown = max(grown, texture(dilateTexture, base.add(offset)));
      grown = max(grown, texture(dilateTexture, base.sub(offset)));
    }
    const mask = texture(maskTexture, base);
    // Subtracting BOTH channels — not just the matching one — is what keeps a
    // selected object's outline from being painted across the interior of the
    // active object in front of it. Without scene depth that overlap is the
    // one artefact you'd actually notice.
    const inside = max(mask.r, mask.g);
    const edge = max(grown.r, grown.g).mul(inside.oneMinus());
    const color = mix(selectedColor, activeColor, step(0.5, grown.g));
    return vec4(color, edge);
  })();
  composite.transparent = true;
  composite.depthTest = false;
  composite.depthWrite = false;
  composite.fog = false;
  composite.toneMapped = false;
  composite.name = "selectionOutlineComposite";

  state.dilateMaterial = dilate;
  state.compositeMaterial = composite;
  state.radius = radius;
}

/**
 * Renders the outline's MASK and horizontal-DILATE passes into the module's
 * offscreen targets. This is the half of the effect that makes nested
 * `renderer.render()` calls and manual `setRenderTarget` swaps, so it MUST run
 * in the engine's PRE-render phase, next to the GI gbuffer and the occluder
 * pass — the sanctioned slot for nested renders.
 *
 * ⚠ WHY THE SPLIT EXISTS (2026-08-13): this whole effect used to run
 * post-render, after the frame was presented. With a PostprocessComponent
 * active, the frame is owned by three's RenderPipeline, and
 * PostprocessComponent's own header documents the rule the old shape broke:
 * manual target swapping outside the renderer's managed frame desynchronizes
 * the WebGPU backend's cached render state. The result was SILENT canvas
 * corruption (no validation errors) from the first selection onward —
 * reproduced deterministically on the user's project by
 * scripts/run-outline-postfx-repro.mjs. Post-render now draws at most ONE
 * fullscreen quad (compositeSelectionOutline), and with a postprocess pipeline
 * active it draws nothing at all — the ring composites INSIDE the pipeline via
 * applySelectionOutlineOverlay.
 *
 * Every piece of renderer/scene state this touches is restored before it
 * returns, including the layer masks it stamps on the selected meshes and the
 * previous render target.
 *
 * @param {object} options
 * @param {THREE.WebGPURenderer} options.renderer
 * @param {THREE.Scene} options.scene
 * @param {THREE.Camera} options.camera
 * @param {number} [options.width] Mask resolution (defaults to the renderer's
 *   drawing buffer).
 * @param {number} [options.height]
 * @param {number} [options.pixelRatio] Device pixels per CSS pixel, for keeping
 *   the outline the same apparent thickness on a HiDPI display.
 * @param {boolean} [options.playing] Play mode never shows the editor outline;
 *   passing true clears any live ring instead of rendering one.
 * @return {boolean} True when the targets now hold a live ring.
 */
export function updateSelectionOutlineMask({ renderer, scene, camera, width, height, pixelRatio, playing = false }) {
  if (!renderer || !scene || !camera) return false;
  const wants = !playing && state.enabled && state.roots.length > 0;
  if (wants) refreshEntries();
  if (!wants || state.entries.length === 0) {
    clearRing(renderer);
    return false;
  }

  let w = width;
  let h = height;
  if (!w || !h) {
    renderer.getDrawingBufferSize(_size);
    w = _size.width;
    h = _size.height;
  }
  if (!w || !h) return false;

  ensureTargets(w, h);
  if (!state.quad) state.quad = new THREE.QuadMesh();
  if (!state.texel) state.texel = uniform(new THREE.Vector2());
  if (!state.maskSelectedMaterial) {
    state.maskSelectedMaterial = makeMaskMaterial("selected");
    state.maskActiveMaterial = makeMaskMaterial("active");
  }
  state.texel.value.set(1 / w, 1 / h);

  const ratio = pixelRatio ?? renderer.getPixelRatio();
  const radius = Math.max(1, Math.min(MAX_RADIUS, Math.round(WIDTH_CSS_PX * ratio)));
  if (!state.compositeMaterial || state.radius !== radius) buildFullscreenMaterials(radius);
  if (state.overlayRadiusU) state.overlayRadiusU.value = radius;

  // Stamp the isolation layer. `visible` is forced only for meshes a SYSTEM
  // hid while still drawing them — a static-batching member renders through
  // its proxy, so its own flag says nothing about whether it is on screen
  // (batching.js sets it false by design). A mesh the USER hid stays hidden
  // and gets no outline, which is the honest answer.
  const stamped = [];
  let hasActive = false;
  let hasSelected = false;
  for (const { mesh, active } of state.entries) {
    if (!mesh.parent) continue; // removed from the scene since we collected it
    const forceVisible =
      !mesh.visible && !!(mesh.userData?.batchedInto || mesh.userData?.mergedInto);
    if (!mesh.visible && !forceVisible) continue;
    stamped.push({ mesh, mask: mesh.layers.mask, visible: mesh.visible });
    mesh.layers.mask = active ? ACTIVE_BIT : SELECTED_BIT;
    if (forceVisible) mesh.visible = true;
    if (active) hasActive = true;
    else hasSelected = true;
  }
  if (stamped.length === 0) {
    clearRing(renderer);
    return false;
  }

  // Cast: three's own runtime takes `(renderer, scene, state)` for both of
  // these — its shipped `@types` declaration drops the `scene` parameter.
  const utils = /** @type {any} */ (THREE.RendererUtils);
  const rendererState = utils.resetRendererAndSceneState(renderer, scene);
  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  const prevAutoClearColor = renderer.autoClearColor;
  const prevAutoClearDepth = renderer.autoClearDepth;
  const prevCameraMask = camera.layers.mask;
  // Belt to precompileSelectionOutlineMasks' guard: the narrowed camera layers
  // already keep lights out of these renders, but a shadow update inside a
  // nested override render is the empty-fragment-struct pipeline trap, and
  // this is cheap insurance against a light ever landing on a mask layer.
  const prevShadows = renderer.shadowMap.enabled;
  try {
    renderer.shadowMap.enabled = false;
    renderer.setRenderTarget(state.maskTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = true;
    renderer.autoClearColor = true;
    renderer.autoClearDepth = true;

    // Two draws because `scene.overrideMaterial` is a scene-wide switch: one
    // per channel, each seeing only its own layer bit. The second must not
    // clear what the first wrote.
    if (hasSelected) {
      scene.overrideMaterial = state.maskSelectedMaterial;
      camera.layers.mask = SELECTED_BIT;
      renderer.render(scene, camera);
      renderer.autoClear = false;
      renderer.autoClearColor = false;
    }
    if (hasActive) {
      scene.overrideMaterial = state.maskActiveMaterial;
      camera.layers.mask = ACTIVE_BIT;
      renderer.render(scene, camera);
    }
    scene.overrideMaterial = null;

    renderer.setRenderTarget(state.dilateTarget);
    renderer.autoClear = true;
    renderer.autoClearColor = true;
    state.quad.material = state.dilateMaterial;
    state.quad.render(renderer);
  } finally {
    camera.layers.mask = prevCameraMask;
    for (const { mesh, mask, visible } of stamped) {
      mesh.layers.mask = mask;
      mesh.visible = visible;
    }
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    renderer.autoClearColor = prevAutoClearColor;
    renderer.autoClearDepth = prevAutoClearDepth;
    renderer.shadowMap.enabled = prevShadows;
    utils.restoreRendererAndSceneState(renderer, scene, rendererState);
  }
  state.ringLive = true;
  return true;
}

/**
 * Clears the mask/dilate targets the frame the ring should disappear
 * (deselection, play mode, disabled). One real GPU clear, then nothing until
 * the next selection — the overlay/composite read transparent black and draw
 * no ring. Freshly created WebGPU textures are zero-initialized by spec, so a
 * never-rendered target needs no clear.
 */
function clearRing(renderer) {
  if (!state.ringLive) return;
  state.ringLive = false;
  if (!state.maskTarget || !renderer) return;
  const prevTarget = renderer.getRenderTarget();
  const prevColor = new THREE.Color();
  renderer.getClearColor(prevColor);
  const prevAlpha = renderer.getClearAlpha();
  try {
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(state.maskTarget);
    renderer.clear(true, false, false);
    renderer.setRenderTarget(state.dilateTarget);
    renderer.clear(true, false, false);
  } finally {
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevColor, prevAlpha);
  }
}

/**
 * Draws the finished ring over `target` (the canvas when null) as ONE
 * fullscreen quad — no nested scene renders, no camera or layer state.
 *
 * Only for frames the engine renders DIRECTLY (`renderer.render`). When a
 * postprocess pipeline owns the frame, do not call this — the ring composites
 * inside the pipeline via applySelectionOutlineOverlay instead, because even
 * a single manual target swap after `RenderPipeline.render()` lands in the
 * corruption class documented at the top of updateSelectionOutlineMask.
 *
 * @param {object} options
 * @param {THREE.WebGPURenderer} options.renderer
 * @param {THREE.RenderTarget|null} [options.target]
 * @return {boolean} True when the quad was drawn.
 */
export function compositeSelectionOutline({ renderer, target = null }) {
  if (!renderer || !state.ringLive || !state.compositeMaterial || !state.quad) return false;
  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  const prevAutoClearColor = renderer.autoClearColor;
  const prevAutoClearDepth = renderer.autoClearDepth;
  try {
    // autoClear off or the WebGPU pass starts with `loadOp: Clear` and wipes
    // everything drawn before us.
    renderer.setRenderTarget(target);
    renderer.autoClear = false;
    renderer.autoClearColor = false;
    renderer.autoClearDepth = false;
    state.quad.material = state.compositeMaterial;
    state.quad.render(renderer);
  } finally {
    renderer.autoClear = prevAutoClear;
    renderer.autoClearColor = prevAutoClearColor;
    renderer.autoClearDepth = prevAutoClearDepth;
    renderer.setRenderTarget(prevTarget);
  }
  return true;
}

/**
 * Mask + composite in one call — the OFFSCREEN path (viewport.screenshot ops),
 * which owns its whole render sequence and passes an explicit target. The live
 * viewport must NOT use this: its two halves belong to different frame phases
 * (see updateSelectionOutlineMask).
 */
export function renderSelectionOutline({ renderer, scene, camera, target = null, width, height, pixelRatio }) {
  if (!updateSelectionOutlineMask({ renderer, scene, camera, width, height, pixelRatio })) return false;
  return compositeSelectionOutline({ renderer, target });
}

/**
 * Wraps a postprocess chain's output colour with the selection ring — the
 * "separate pass" that lets the outline coexist with the postprocessing
 * module. PostprocessComponent calls this (via `engine.viewportOverlayNode`)
 * once per pipeline compile; selection changes only change the CONTENT of the
 * mask/dilate textures, never the node graph, so selecting never rebuilds the
 * postprocess pipeline.
 *
 * Stability contract: the targets are created here if they don't exist yet
 * (2×2, zero-filled ⇒ no ring) and are only ever `setSize`d afterwards, which
 * keeps the texture OBJECTS the pipeline binds valid. disposeSelectionOutline
 * breaks that contract, which is why it must only run on `renderer-rebuilt` —
 * the same event that rebuilds every postprocess pipeline anyway.
 *
 * The vertical-dilate tap loop is unrolled to MAX_RADIUS and each tap is
 * gated by a radius uniform, so a DPI change (radius change) is a uniform
 * write, not a recompile. The ring colour passes through the pipeline's tone
 * mapping, so it reads a touch dimmer than the direct-render path's — a known,
 * accepted difference.
 *
 * @param {any} colorNode The chain's output colour node.
 * @return {any} The colour node with the ring mixed in.
 */
export function applySelectionOutlineOverlay(colorNode) {
  if (!state.texel) state.texel = uniform(new THREE.Vector2(0.5, 0.5));
  if (!state.maskTarget) {
    state.maskTarget = makeTarget(2, 2, "selectionOutlineMask");
    state.dilateTarget = makeTarget(2, 2, "selectionOutlineDilate");
  }
  state.overlayRadiusU ??= uniform(0);
  const maskTexture = state.maskTarget.texture;
  const dilateTexture = state.dilateTarget.texture;
  const texel = state.texel;
  const radiusU = state.overlayRadiusU;
  const activeColor = uniform(new THREE.Color(ACTIVE_COLOR));
  const selectedColor = uniform(new THREE.Color(SELECTED_COLOR));
  return Fn(() => {
    const base = uv();
    let grown = /** @type {any} */ (texture(dilateTexture, base));
    for (let i = 1; i <= MAX_RADIUS; i++) {
      const gate = step(float(i), radiusU);
      const offset = vec2(0, texel.y.mul(i));
      grown = max(grown, texture(dilateTexture, base.add(offset)).mul(gate));
      grown = max(grown, texture(dilateTexture, base.sub(offset)).mul(gate));
    }
    const mask = texture(maskTexture, base);
    // Same ring maths as the composite material — see buildFullscreenMaterials
    // for why BOTH channels subtract.
    const inside = max(mask.r, mask.g);
    const edge = max(grown.r, grown.g).mul(inside.oneMinus());
    const ring = mix(selectedColor, activeColor, step(0.5, grown.g));
    const beauty = vec4(colorNode);
    return vec4(mix(beauty.rgb, ring, edge), beauty.a);
  })();
}

/**
 * Pre-compiles the mask materials' render pipelines against every mesh
 * currently in view, so selecting an object never compiles mid-frame.
 *
 * WHY: a WebGPU render pipeline is per material × geometry layout × render
 * context. The mask pass draws the selected meshes with an override material
 * into its own RGBA8/no-depth target, so the FIRST time any given mesh is
 * selected, that pipeline does not exist yet and compiles synchronously inside
 * the frame — the reported "it lags each time I select another object".
 * `renderer.compileAsync` walks the same projection path `render` does, so
 * running it with the override + the mask target bound builds exactly the
 * pipelines the mask pass will ask for, off the critical path.
 *
 * compileAsync's setup (projection, render-object creation, pipeline REQUESTS)
 * is synchronous — its only awaits are `init()` (already done) and the final
 * pipeline promises — so the override/target are restored immediately after
 * the call returns and the compiles finish in the background.
 *
 * LIMIT: `compileAsync` frustum-culls, so this warms the meshes the camera can
 * currently see — which covers click-selection by construction. Selecting an
 * OFF-SCREEN entity from the hierarchy can still compile on first draw; call
 * this again after big camera jumps if that ever reads as a hitch.
 */
export async function precompileSelectionOutlineMasks({ renderer, scene, camera }) {
  if (!renderer || !scene || !camera) return;
  if (!state.maskSelectedMaterial) {
    state.maskSelectedMaterial = makeMaskMaterial("selected");
    state.maskActiveMaterial = makeMaskMaterial("active");
  }
  if (!state.maskTarget) {
    state.maskTarget = makeTarget(2, 2, "selectionOutlineMask");
    state.dilateTarget = makeTarget(2, 2, "selectionOutlineDilate");
  }
  // ⚠ LIGHTS MUST BE HIDDEN DURING THE PROJECTION, for two reasons that both
  // matter. (1) With a light in the render list, compileAsync ALSO compiles
  // the shadow-map pass, and the shadow pass applies scene.overrideMaterial —
  // compiling this colorNode material into a depth-only context whose
  // fragment output struct is EMPTY: an invalid WGSL pipeline ("structures
  // must have at least one member"), the exact class that poisoned command
  // buffers via the occluder pass. (2) Pipelines key on the lights node, and
  // the REAL mask pass renders with camera layers that exclude every light —
  // warming with lights hidden builds exactly the no-lights variant the mask
  // pass will bind. Hide → synchronous projection → restore happens inside
  // one JS task per material, so no rendered frame ever sees the scene dark.
  const lights = [];
  scene.traverse((obj) => {
    if (obj.isLight && obj.visible) lights.push(obj);
  });
  for (const material of [state.maskSelectedMaterial, state.maskActiveMaterial]) {
    const prevOverride = scene.overrideMaterial;
    const prevTarget = renderer.getRenderTarget();
    // (3) MRT must be NULLED, not merely inherited: GI's compile wave pins the
    // postprocess pass's MRT on the renderer across a multi-second await
    // (PassNode.compileAsync restores only at the end), and this warm can run
    // inside that window. Compiling the mask — or the scene BACKGROUND, which
    // ignores overrideMaterial — under that leaked MRT builds fragments whose
    // output struct is EMPTY: the same invalid-pipeline class as (1). Seen
    // live 2026-08-14 as "fragment_Background.material: structures must have
    // at least one member" during boot on the user's Sponza.
    const prevMrt = renderer.getMRT();
    let pending = null;
    try {
      for (const light of lights) light.visible = false;
      scene.overrideMaterial = material;
      renderer.setRenderTarget(state.maskTarget);
      renderer.setMRT(null);
      pending = renderer.compileAsync(scene, camera);
    } finally {
      renderer.setMRT(prevMrt);
      renderer.setRenderTarget(prevTarget);
      scene.overrideMaterial = prevOverride;
      for (const light of lights) light.visible = true;
    }
    await pending;
  }
}

/** Frees the targets and materials. The selection itself is forgotten too. */
export function disposeSelectionOutline() {
  state.maskTarget?.dispose();
  state.dilateTarget?.dispose();
  state.maskSelectedMaterial?.dispose();
  state.maskActiveMaterial?.dispose();
  state.dilateMaterial?.dispose();
  state.compositeMaterial?.dispose();
  state.maskTarget = null;
  state.dilateTarget = null;
  state.maskSelectedMaterial = null;
  state.maskActiveMaterial = null;
  state.dilateMaterial = null;
  state.compositeMaterial = null;
  state.quad = null;
  state.radius = 0;
  state.ringLive = false;
  state.roots = [];
  state.activeRoot = null;
  state.entries = [];
}
