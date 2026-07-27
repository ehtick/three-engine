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
  float,
  instanceIndex,
  ivec2,
  mrt,
  normalWorld,
  positionWorld,
  texture,
  textureStore,
  uniform,
  vec3,
  vec4,
} from "three/tsl";
import { MAX_EMITTERS, emitterDirectAt } from "./giLight.js";
import { EDITOR_LAYER } from "../../engine/editorLayers.js";

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

  return {
    rt,
    material,
    mrtNode,
    get position() {
      return rt.textures[0];
    },
    get normal() {
      return rt.textures[1];
    },
    setSize(w, h) {
      rt.setSize(w, h);
    },
    dispose() {
      rt.dispose();
      material.dispose();
    },
  };
}

/**
 * Renders the gbuffer for this frame. Runs as a nested render inside the
 * engine's pre-render phase, so it must leave the renderer exactly as it
 * found it — a leaked render target or MRT would redirect the main scene
 * render into our half-res buffer.
 */
export function renderGiGBuffer(renderer, scene, camera, gbuffer) {
  const previousTarget = renderer.getRenderTarget();
  const previousMRT = renderer.getMRT();
  const previousOverride = scene.overrideMaterial;
  const previousMask = camera.layers.mask;
  const previousTransparent = renderer.transparent;
  // OPAQUE ONLY. `scene.overrideMaterial` replaces the material of everything
  // that renders, so a transparent object — a glass pane, or a VolumeNodeMaterial
  // fog box — would be drawn as a solid surface into the gbuffer and every
  // pixel behind it would resolve GI for the FOG BOX instead of the geometry
  // there. User-reported as "put the scene inside a volume and it goes black".
  renderer.transparent = false;
  // Editor gizmos/grid would write geometry into the gbuffer and shadow the
  // scene with objects that are not really there.
  camera.layers.disable(EDITOR_LAYER);
  scene.overrideMaterial = gbuffer.material;
  renderer.setRenderTarget(gbuffer.rt);
  renderer.setMRT(gbuffer.mrtNode);
  try {
    renderer.render(scene, camera);
  } finally {
    renderer.setMRT(previousMRT);
    renderer.setRenderTarget(previousTarget);
    renderer.transparent = previousTransparent;
    scene.overrideMaterial = previousOverride;
    camera.layers.mask = previousMask;
  }
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
 */
export function createGiResolve({ gbuffer, targets, width, height, gather, normalOffset, intensity, emitter }) {
  // The TARGETS are owned by the caller and outlive every rebuild: materials
  // sample them through persistent texture nodes, so recreating them here
  // would silently leave already-compiled materials bound to dead textures.
  const { irradiance, emitterShadow } = targets;

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
    // One var per emitter slot: TSL can't assign INTO a vec4 var's components,
    // and the values are produced inside the If below, so they have to be
    // declared outside it and packed afterwards.
    const shadowVars = Array.from({ length: MAX_EMITTERS }, () => float(1).toVar());
    If(g0.w.greaterThan(0.5), () => {
      const P = g0.xyz.toVar();
      const N = g1.xyz.normalize().toVar();
      const samplePoint = P.add(N.mul(normalOffset)).toVar();
      out.assign(vec3(gather(samplePoint, N)).mul(intensity));
      if (emitter) {
        const direct = emitterDirectAt(emitter, P, N, samplePoint);
        out.addAssign(direct.irradiance.mul(intensity));
        direct.shadows.forEach((shadow, index) => {
          if (index < MAX_EMITTERS) shadowVars[index].assign(shadow);
        });
      }
    });
    textureStore(irradiance, coord, vec4(out, 1));
    textureStore(emitterShadow, coord, vec4(shadowVars[0], shadowVars[1], shadowVars[2], shadowVars[3]));
  })().compute(width * height);

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
export function createGiTargets(width, height) {
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
  const emitterShadow = new THREE.StorageTexture(width, height);
  emitterShadow.name = "giEmitterShadow";
  emitterShadow.version = version;
  if (import.meta.env?.DEV) globalThis.__giLastTargetVersion = version;
  return {
    irradiance,
    emitterShadow,
    dispose() {
      irradiance.dispose();
      emitterShadow.dispose();
    },
  };
}
