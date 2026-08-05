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
  abs,
  float,
  fract,
  instanceIndex,
  ivec2,
  mix,
  mrt,
  normalWorld,
  positionWorld,
  reflect,
  select,
  smoothstep,
  step,
  tan,
  texture,
  textureStore,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { MAX_EMITTERS, analyticDirectAt, decodeOctNormal, emitterDirectAt } from "./giLight.js";
import { DEBUG_LAYER, EDITOR_LAYER, GI_MIRROR_LAYER, UI_LAYER } from "../../engine/editorLayers.js";
import { ALBEDO_ATLAS_GRID, ALBEDO_ATLAS_SIZE, ALBEDO_ATLAS_TILE } from "./bvh/bvhScene.js";

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
      rt.setSize(w, h);
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
export function renderGiGBuffer(renderer, scene, camera, gbuffer, { mirrorMask = false } = {}) {
  const previousTarget = renderer.getRenderTarget();
  const previousMRT = renderer.getMRT();
  const previousOverride = scene.overrideMaterial;
  const previousMask = camera.layers.mask;
  const previousTransparent = renderer.transparent;
  const previousAutoClear = renderer.autoClear;
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
      camera.layers.set(GI_MIRROR_LAYER);
      scene.overrideMaterial = gbuffer.maskMaterial;
      renderer.setMRT(gbuffer.maskMrtNode);
      renderer.autoClear = false;
      renderer.render(scene, camera);
    }
  } finally {
    renderer.autoClear = previousAutoClear;
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
 *
 * `bvhShade` (optional, 2026-08-02) — LIGHTS THE EXACT-REFLECTION HITS the
 * BVH prepass traced earlier this frame: `{ hit, albedo, target, lightSlots,
 * cameraPosition }`. It reads that pass's hit distance + face normal + albedo,
 * reconstructs the hit point, and writes the reflected surface's outgoing
 * radiance to `target`, which the mirror materials then sample directly.
 *
 * WHY HERE and not in the prepass that traced it: shading a hit needs the
 * cascade gather, the emitter slots (with their shadow traces) and the light
 * slots. This pass already binds all three, so the marginal cost is two
 * texture reads and one storage write. Binding them in the BVH pass instead
 * asks for 16 uniform buffers in one compute stage against a WebGPU baseline
 * of 12 — over which the pipeline is INVALID and every compute submitted with
 * it is silently dropped.
 *
 * WHY IT IS AFFORDABLE AT ALL: the work is inside `t >= 0`, and the prepass
 * writes t = -1 on every pixel its mirror mask skipped. So the second gather
 * runs only on pixels that a reflective material will actually read — the mask
 * is what makes this a mirror-pixel cost instead of a whole-screen one.
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
 */
export function createGiResolve({ gbuffer, targets, width, height, gather, normalOffset, intensity, emitter, radiance, bvhShade = null, ao = null }) {
  // The TARGETS are owned by the caller and outlive every rebuild: materials
  // sample them through persistent texture nodes, so recreating them here
  // would silently leave already-compiled materials bound to dead textures.
  const { irradiance, emitterShadow, radiance: radianceTarget } = targets;

  // Size lives in a uniform so a viewport resize is a uniform write, not a
  // shader rebuild (the WGSL stays byte-identical → three's node cache and
  // the driver's pipeline cache both hit).
  const widthU = uniform(width, "uint");

  const positionNode = texture(gbuffer.position);
  const normalNode = texture(gbuffer.normal);
  const bvhTNode = bvhShade ? texture(bvhShade.hit) : null;
  const bvhAlbedoNode = bvhShade ? texture(bvhShade.albedo) : null;

  const compute = Fn(() => {
    const px = instanceIndex.mod(widthU);
    const py = instanceIndex.div(widthU);
    const coord = ivec2(px.toInt(), py.toInt());
    const g0 = positionNode.load(coord).toVar();
    const g1 = normalNode.load(coord).toVar();
    const out = vec3(0).toVar();
    const reflectedOut = vec3(0).toVar();
    // Exact-reflection hit radiance (see bvhShade's doc on this function).
    const bvhOut = vec3(0).toVar();
    const bvhValid = float(0).toVar();
    // One var per emitter slot: TSL can't assign INTO a vec4 var's components,
    // and the values are produced inside the If below, so they have to be
    // declared outside it and packed afterwards.
    const shadowVars = Array.from({ length: MAX_EMITTERS }, () => float(1).toVar());
    If(g0.w.greaterThan(0.5), () => {
      const P = g0.xyz.toVar();
      const rawN = g1.xyz.normalize().toVar();
      const facing = step(0, rawN.dot(radiance?.cameraPosition?.sub(P) ?? rawN)).mul(2).sub(1);
      const N = rawN.mul(facing).toVar();
      const samplePoint = P.add(N.mul(normalOffset)).toVar();
      // Unit toward-camera vector for the gather's view-bias component
      // (silhouette fix — see cascadeGather.gatherViewBias). Zero when the
      // resolve has no camera (radiance null), which disables it exactly.
      const viewDir = radiance?.cameraPosition
        ? vec3(radiance.cameraPosition).sub(P).normalize().toVar()
        : vec3(0);
      out.assign(vec3(gather(samplePoint, N, viewDir)).mul(intensity));
      // AMBIENT OCCLUSION ON THE INDIRECT TERM (occupancy-oracle obscurance).
      //
      // The probe lattice is ~1m — indirect light arrives with NO small-scale
      // occlusion: no contact darkening under props, no corner/crevice
      // shading ("no AO or shadows from indirect light"). The occupancy
      // pyramid's free-radius oracle is a conservative distance bound, i.e.
      // exactly the ingredient of the classic SDF ambient-obscurance ladder
      // (IQ): at heights d_i along the normal, an unoccluded point has
      // free radius ≥ d_i; the shortfall, distance-weighted, integrates to
      // an obscurance estimate. World-space (no screen-space halo/edge
      // artifacts), a few bitset fetches per tap at HALF RES, and it rides
      // the pyramid the resolve's field traces already conceptually own.
      //
      // Applied to the GATHER term only: emitter/analytic direct have real
      // traced shadows (penumbra estimator) — obscuring them twice reads as
      // dirt. Reflections keep their own visibility. `strength`/`radius`
      // are live uniforms (aoStrength/aoRadius props); the whole block is
      // compiled out when the component's `ao` prop is off (structural).
      if (ao?.occupancy?.freeRadiusAtWorld) {
        const occAcc = float(0).toVar();
        // 4 taps, linear spacing (¼..1 × radius), falloff halving per tap —
        // the standard 4-tap SDF-AO ladder against the oracle. Two voxel-
        // specific corrections vs the SDF original:
        //   · SELF-SURFACE ALLOWANCE: the pixel's own surface is SET VOXELS,
        //     and on a CURVED receiver the error is bigger than one voxel —
        //     conservative SAT voxelization bulges up to a full voxel
        //     OUTSIDE the true surface (every touched voxel is set), and the
        //     gbuffer P sits anywhere inside its surface voxel, so the
        //     oracle can read ~2 voxels of false self-occlusion. One voxel
        //     of allowance was enough for flat floors but painted
        //     grid-aligned grey blotches over spheres (user screenshot,
        //     2026-08-03). Two voxels zeroes the unoccluded baseline on
        //     curved geometry too, at the cost of slightly later contact
        //     onset — AO now starts biting ~0.2m from a wall instead of
        //     ~0.1m at ultra's voxel size.
        //   · maxLevel 3 (27 near + 24 ladder fetches/tap): the oracle's
        //     bound saturates at ~8 level-0 voxels, which covers the default
        //     0.6m radius at every preset — capping shy of the last tap
        //     would read open sky as occlusion.
        const radius = float(ao.radius).max(0.05).toVar();
        const voxN = vec3(ao.occupancy.voxel);
        const allowance = voxN.x.max(voxN.y).max(voxN.z).mul(2).toVar();
        for (let i = 1; i <= 4; i++) {
          const d = radius.mul(i / 4);
          const free = float(ao.occupancy.freeRadiusAtWorld(P.add(N.mul(d)), 3, true, null));
          occAcc.addAssign(d.sub(allowance).sub(free).max(0).div(d).mul(1 / 2 ** (i - 1)));
        }
        // Normalize by Σ falloff (1+½+¼+⅛), scale, floor at 0.
        const obscurance = occAcc.mul(float(ao.strength).div(1.875)).clamp(0, 1);
        out.mulAssign(obscurance.oneMinus());
      }
      if (radiance) {
        const incident = P.sub(radiance.cameraPosition).normalize().toVar();
        const reflected = reflect(incident, N).toVar();
        reflectedOut.assign(vec3(radiance.lookup(samplePoint, reflected)).mul(intensity));
      }
      if (emitter) {
        const direct = emitterDirectAt(emitter, P, N, samplePoint);
        out.addAssign(direct.irradiance.mul(intensity));
        direct.shadows.forEach((shadow, index) => {
          if (index < MAX_EMITTERS) shadowVars[index].assign(shadow);
        });
      }
      // GI-traced direct shadows moved to their OWN pass — see
      // createGiLightShadowPass below (independent pixel budget; the trace
      // was the most expensive per-pixel work in this kernel).
      if (bvhShade) {
        const hitTexel = bvhTNode.load(coord).toVar();
        const albedoTexel = bvhAlbedoNode.load(coord).toVar();
        // A traced hit (t >= 0) that also resolved an albedo. Both conditions
        // matter: the prepass writes t = -1 on a miss AND on every pixel the
        // mirror mask skipped, so this is already restricted to the pixels a
        // reflective material will actually read.
        If(hitTexel.x.greaterThanEqual(0).and(albedoTexel.w.greaterThan(0.5)), () => {
          // Reconstruct the hit EXACTLY as the prepass traced it: same
          // unflipped gbuffer normal (the `facing` flip above is a
          // resolve-only convention the prepass does not share), same
          // normal-lifted origin, same reflected direction. A mismatch here
          // does not fail loudly — it shades a point slightly off the
          // surface, which reads as dim or striped reflections.
          const rawN = g1.xyz.normalize().toVar();
          const incident = P.sub(bvhShade.cameraPosition).normalize().toVar();
          const R = reflect(incident, rawN).toVar();
          const hitP = P.add(rawN.mul(normalOffset)).add(R.mul(hitTexel.x)).toVar();
          // The hit's true face normal, flipped to face the incoming ray: a
          // BVH hit routinely lands on single-sided geometry whose winding
          // points away, and gathering with a back-facing normal samples the
          // probe field on the far side of the wall — which is exactly the
          // "reflected surface is black" failure.
          const nRaw = decodeOctNormal(hitTexel.zw).toVar();
          const nFace = select(nRaw.dot(R).lessThan(0), nRaw, nRaw.negate()).toVar();
          const shadePoint = hitP.add(nFace.mul(normalOffset)).toVar();
          const hitE = vec3(gather(shadePoint, nFace, vec3(0))).toVar();
          if (emitter) {
            hitE.addAssign(emitterDirectAt(emitter, hitP, nFace, shadePoint).irradiance);
          }
          if (bvhShade.lightSlots?.length) {
            hitE.addAssign(analyticDirectAt(bvhShade.lightSlots, hitP, nFace));
          }
          // ×intensity to match the convention of the term this is mixed WITH
          // on the material side: `reflectedOut` (the cascade radiance lookup)
          // is stored pre-multiplied too. Mixing two terms on different
          // intensity conventions would make the GI intensity slider change
          // reflections' BLEND, not just their level.
          bvhOut.assign(albedoTexel.xyz.mul(hitE).div(Math.PI).mul(intensity));
          bvhValid.assign(1);
        });
      }
    });
    textureStore(irradiance, coord, vec4(out, 1));
    textureStore(emitterShadow, coord, vec4(shadowVars[0], shadowVars[1], shadowVars[2], shadowVars[3]));
    textureStore(radianceTarget, coord, vec4(reflectedOut, 1));
    if (bvhShade) textureStore(bvhShade.target, coord, vec4(bvhOut, bvhValid));
  })().compute(width * height);

  return { compute, widthU };
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
export function createGiLightShadowPass({ gbuffer, lightShadow, width, height, resolveWidth, resolveHeight }) {
  const widthU = uniform(width, "uint");
  const positionNode = texture(gbuffer.position);
  const normalNode = texture(gbuffer.normal);
  const sx = resolveWidth / width;
  const sy = resolveHeight / height;

  const compute = Fn(() => {
    const px = instanceIndex.mod(widthU);
    const py = instanceIndex.div(widthU);
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
        If(slot.giShadow.greaterThan(0.5).and(slot.active.greaterThan(0.5)), () => {
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
          If(cosRayNormal.greaterThan(0.05), () => {
            // ANGULAR RADIUS → PENUMBRA. Directional lights carry it
            // directly (`soft`, radians); point/spot lights carry a world
            // RADIUS whose angular size is radius/distance, per pixel. The
            // clamp floors the sharpest usable cone and caps the softest so
            // the analytic k can never approach 1.
            const rawAngle = mix(float(slot.srcRadius).div(pointDist), float(slot.soft), isDir)
              .max(0)
              .toVar();
            const angle = rawAngle.clamp(0.0005, 0.35).toVar();
            // The cone arm wants the TRUE half-angle, unclamped — capping
            // it at 0.35 was exactly the "90° looks the same as 20°" bug;
            // tan capped at ~44.7° half-angle only to keep tan() finite.
            const tanHalf = tan(rawAngle.min(0.78)).toVar();
            const maxT = dist.sub(lightShadow.lift).max(0).toVar();
            // Interleaved gradient noise, per SHADOW pixel — the cone
            // march's lattice-decorrelation rotation (see its jitter note).
            const ign = fract(
              fract(float(coord.x).mul(0.06711056).add(float(coord.y).mul(0.00583715)))
                .mul(52.9829189),
            );
            // DDA marcher when the bundle carries one, sphere trace as the
            // hatched fallback. The receiver point rides along for the
            // record march's origin-plane exclusion; the DDA arm returns
            // vec2(shadow, blockerDist/span).
            const tracedRaw = lightShadow.traceDda
              ? lightShadow.traceDda(shadowOrigin, dir, maxT, float(1).div(angle), P, tanHalf, ign)
              : lightShadow.trace(shadowOrigin, dir, maxT, float(1).div(angle), cosRayNormal);
            const traced = lightShadow.traceDda ? vec2(tracedRaw).toVar() : vec2(tracedRaw, 0).toVar();
            if (lightShadowDistVars) lightShadowDistVars[index].assign(traced.y);
            if (lightShadow.freeRadius) {
              // BURIAL GATE — ask the record-aware oracle how much free
              // space the RAY ORIGIN has: a receiver buried inside a canopy
              // reads ~0 and cannot plausibly see the sun — force dark. An
              // open receiver's lifted origin reads ≈ the full 1.5-voxel
              // lift and passes untouched.
              const free = float(lightShadow.freeRadius(shadowOrigin)).toVar();
              const burial = smoothstep(lightShadow.voxMax.mul(0.5), lightShadow.voxMax.mul(1.25), free);
              lightShadowVars[index].assign(traced.x.mul(burial));
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
    textureStore(
      lightShadow.target,
      coord,
      vec4(lightShadowVars[0], lightShadowVars[1], lightShadowVars[2], lightShadowVars[3]),
    );
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
export function createGiBvhReflect({
  gbuffer, target, colorTarget, width, height, bvhScene,
  cameraPosition, normalOffset, maxDistance, mask = true,
}) {
  const widthU = uniform(width, "uint");
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
    const px = instanceIndex.mod(widthU);
    const py = instanceIndex.div(widthU);
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
      const R = reflect(incident, N).toVar();
      const origin = P.add(N.mul(normalOffset)).toVar();
      const hit = bvhScene.firstHit(origin, R, float(maxDistance));
      If(hit.t.greaterThanEqual(0), () => {
        t.assign(hit.t);
        albedo.assign(hit.albedo);
        hasAlbedo.assign(hit.hasAlbedo);
        octXY.assign(octEncodeNormal(hit.normal));
      });
      if (!globalThis.__giBvhV1) {
        dynFlag.assign(bvhScene.dynamicBlocked(origin, R, t, float(maxDistance)));
      }
    });
    textureStore(target, coord, vec4(t, dynFlag, octXY.x, octXY.y));
    if (colorTarget) textureStore(colorTarget, coord, vec4(albedo, hasAlbedo));
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
export function createGiTargets(width, height, shadowWidth = width, shadowHeight = height) {
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
  return {
    irradiance,
    emitterShadow,
    radiance,
    lightShadow,
    lightShadowDist,
    dispose() {
      irradiance.dispose();
      emitterShadow.dispose();
      radiance.dispose();
      lightShadow.dispose();
      lightShadowDist.dispose();
    },
  };
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
export function createGiBvhTarget(width, height) {
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
  // the RESOLVE pass from `bvhColor`'s albedo and `bvhReflect`'s hit geometry
  // (see createGiResolve's `bvhShade`). It is a third texture rather than an
  // overwrite of `bvhColor` because a pass cannot bind the same texture as
  // both a sampled input and a writable storage output.
  const bvhRadiance = new THREE.StorageTexture(width, height);
  bvhRadiance.type = THREE.HalfFloatType;
  bvhRadiance.minFilter = THREE.NearestFilter;
  bvhRadiance.magFilter = THREE.NearestFilter;
  bvhRadiance.name = "giBvhRadiance";
  bvhRadiance.version = version;
  return {
    bvhRadiance,
    bvhReflect,
    bvhColor,
    dispose() {
      bvhReflect.dispose();
      bvhColor.dispose();
      bvhRadiance.dispose();
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
export function blitBvhAtlasTiles(renderer, bvhScene) {
  const pending = bvhScene?.pendingGpuTiles;
  if (!pending || pending.length === 0) return 0;

  const rt = new THREE.RenderTarget(ALBEDO_ATLAS_SIZE, ALBEDO_ATLAS_SIZE, {
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

  const rendererState = THREE.RendererUtils.saveRendererState(renderer);
  const quad = new THREE.QuadMesh();
  let blitted = 0;
  try {
    renderer.setRenderTarget(rt);
    renderer.setScissorTest(false);
    rt.viewport.set(0, 0, ALBEDO_ATLAS_SIZE, ALBEDO_ATLAS_SIZE);
    rt.scissor.set(0, 0, ALBEDO_ATLAS_SIZE, ALBEDO_ATLAS_SIZE);

    // Pass 1: relay the existing canvas atlas forward whole, so every tile
    // the CPU path already drew or solid-filled survives unchanged.
    const copyMaterial = new THREE.NodeMaterial();
    copyMaterial.colorNode = texture(bvhScene.atlasTexture);
    copyMaterial.transparent = false;
    copyMaterial.depthTest = false;
    copyMaterial.depthWrite = false;
    copyMaterial.fog = false;
    quad.material = copyMaterial;
    quad.render(renderer);
    copyMaterial.dispose();

    // Pass 2+: one quad per pending tile, viewport+scissor restricted to
    // that tile's rect, sampling the compressed map directly — the GPU can
    // decode it even though the canvas never could.
    renderer.setScissorTest(true);
    for (const { map, tileIndex } of pending) {
      const tileX = (tileIndex % ALBEDO_ATLAS_GRID) * ALBEDO_ATLAS_TILE;
      const tileY = Math.floor(tileIndex / ALBEDO_ATLAS_GRID) * ALBEDO_ATLAS_TILE;
      rt.viewport.set(tileX, tileY, ALBEDO_ATLAS_TILE, ALBEDO_ATLAS_TILE);
      rt.scissor.set(tileX, tileY, ALBEDO_ATLAS_TILE, ALBEDO_ATLAS_TILE);
      const tileMaterial = new THREE.NodeMaterial();
      tileMaterial.colorNode = texture(map);
      tileMaterial.transparent = false;
      tileMaterial.depthTest = false;
      tileMaterial.depthWrite = false;
      tileMaterial.fog = false;
      quad.material = tileMaterial;
      quad.render(renderer);
      tileMaterial.dispose();
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
