import { Color, DepthTexture, DoubleSide, FloatType, MeshBasicNodeMaterial, Object3D, StorageTexture, Vector3 } from 'three/webgpu';
import { WATER_REFRACTION_LAYER } from '../editorLayers.js';
import { waterCausticGainNode } from './waterCaustics.js';
import { applyMediumSegment } from './waterMedium.js';
import {
  Fn, cameraFar, cameraNear, cameraPosition, cameraProjectionMatrix, cameraProjectionMatrixInverse, cameraViewMatrix, cameraWorldMatrix, float, frontFacing, linearDepth, materialAttenuationColor, materialAttenuationDistance, materialColor, mix, modelNormalMatrix, modelWorldMatrixInverse, normalLocal, normalView, positionLocal,
  mrt, pmremTexture, positionViewDirection, positionWorld, reflect, reflector, refract, screenSize, screenUV, select, texture, transformDirection, transformNormalToView, uniform, vec2, vec3, vec4, viewportTexture,
} from 'three/tsl';
import { seaFoamValueNode, waterCrestGradientNode, waterFoamNode, waterSubsurfaceNode } from './waterFoam.js';
import { seaLostSlopeVarianceNode, seaShadingSlopeNode } from './waterSpectrum.js';

const _eye = new Vector3(), _origin = new Vector3(), _up = new Vector3(), _clearColor = new Color();
/** Whether three's own image-based lighting supplies the sky's reflection. */
const sceneHasEnvironment = (scene) => !!(scene?.environmentNode || scene?.environment?.isTexture);
/** Recursion guard: a mirror must not render itself. */
let reflecting = false;

/**
 * ══ THE WATER SURFACE'S OWN LOOK ═══════════════════════════════════════════
 *
 * The planar mirror, foam, fine-scale normals and subsurface scattering — all
 * in one place because they land on the same handful of material slots and
 * three has exactly one of each. Two modules assigning `emissiveNode` would
 * silently clobber each other.
 *
 * ⛔⛔ **THE MIRROR WAS DELETED ONCE AND THAT WAS WRONG.** The scene appeared to
 * carry two reflections, one correct and one badly broken, and the broken one
 * was blamed on this. It was not: the ghosts were three's screen-space
 * TRANSMISSION, sampling the opaque scene at a refracted screen offset that
 * reached pixels of objects ABOVE the water (see `builtinMaterials.js`, where
 * `thickness` is now zero). This mirror was the CORRECT one all along —
 * measured at 1.5 px against the analytic mirror image, five separate times.
 * Deleting it left the water with no reflection whatever, because the traced
 * path cannot reach it either (`giLight.js`'s `giWater` early return, which is
 * load-bearing for a texture budget): "we had 2 reflections previously, one was
 * correct, and another one was broken. You killed both" (user, 2026-09-06).
 *
 * ⚠ The lesson is not about water. **A diagnosis offered by the person seeing
 * the bug is a hypothesis, not evidence.** "It is the water's own reflection"
 * fitted the symptom perfectly and was wrong, and acting on it deleted a
 * working subsystem instead of the faulty one standing next to it.
 */
export function installWaterSurfaceLook({ engine, mesh, material, simulation = null, slot = null, getSlot = null, underwater = true }) {
  const target = new Object3D(); target.rotation.x = -Math.PI / 2; mesh.add(target);
  const gain = uniform(1), distortion = uniform(.02);
  // 1 while the scene has an environment: the mirror then renders without
  // its background and counts only where it saw geometry (see the hook).
  const envReflection = uniform(0);
  // 1 while the material's own image-based lighting cannot see that
  // environment — GI installs a black `scene.environmentNode` so its probes
  // replace the IBL, and the water, which GI deliberately leaves out of its
  // radiance block, then reflected NOTHING ("no sky reflection from the
  // surface … looks cartoonish", user, 2026-09-07, GI on). The lid samples
  // the environment texture itself along the true reflected ray then.
  const skyTerm = uniform(0);
  let skyNode = null;
  // ⚠ EVERY SLOT THIS TOUCHES IS CAPTURED, and every rebuild starts from the
  // capture rather than from what it built last time — `build()` re-runs on
  // each GI compile wave, and composing onto its own output would stack foam on
  // foam until the water was a white sheet.
  const previous = {
    emissiveNode: material.emissiveNode, colorNode: material.colorNode,
    roughnessNode: material.roughnessNode, normalNode: material.normalNode,
    transmissionNode: material.transmissionNode, transmission: material.transmission,
    thicknessNode: material.thicknessNode,
    giWater: material.userData.giWater,
  };
  let node = null, disposed = false, rearms = 0;
  // ── REFRACTION THROUGH THE SCENE'S BVH (2026-09-06) ────────────────────
  //
  // With GI present the water renders its own gbuffer (the lid's position and
  // its refracted ray) and GI traces and hit-shades those rays through the
  // scene BVH; the lid reads the radiance at its own pixel. Nothing is read
  // from the screen, so nothing above the water can be painted onto it. The
  // two texture nodes are the water's; GI swaps their `.value`.
  // Resolved at EVERY build, not at install: the water installs seconds before
  // GI is built, and `build()` re-runs on each compile wave — the first wave
  // after GI arrives is when this arm compiles and registers.
  const giSystemNow = () => (globalThis.__waterBvhRefraction === false ? null : (engine?.modules?.get?.('gi')?.system ?? null));
  const refractionRadiance = texture(new StorageTexture(1, 1)), refractionHit = texture(new StorageTexture(1, 1));
  const gbufferMaterial = new MeshBasicNodeMaterial({ side: DoubleSide });
  gbufferMaterial.name = 'water refraction gbuffer'; gbufferMaterial.lights = false; gbufferMaterial.fog = false;
  let giRefraction = null, giRefractionSystem = null;
  // ── THE VIEWPORT'S DEPTH, COPIED BY THE WATER ITSELF ───────────────────
  //
  // three's `viewportDepthTexture` decides a depth texture's sample count from
  // whatever render target is CURRENT when the shader is built or the texture
  // first bound; a compile path with another target current (the census, a
  // compile wave) then binds a single-sample 1×1 to a pipeline that declared
  // a multisampled one ("Sample count (1) … doesn't match expectation"). A
  // texture that carries a `renderTarget.samples` of its own is read from
  // that instead, everywhere. So: one depth texture PER RENDER TARGET, pinned
  // to that target's sample count at creation, chosen by `updateReference`
  // for whichever target is current — at build, at bind, in every context —
  // and filled by a copy before the lid draws in the main pass. A target the
  // water never draws into keeps a 1×1 that is at least consistent.
  const depthTextures = new Map();
  // The target three is REALLY drawing into: a canvas with tone mapping or
  // MSAA goes through the renderer's internal framebuffer target, while
  // `getRenderTarget()` reads null and `currentSamples` 0 — exactly as
  // `compileAsync` resolves it.
  const effectiveTarget = (renderer) => {
    const current = renderer.getRenderTarget();
    if (current) return current;
    if (renderer.needsFrameBufferTarget && typeof renderer._getFrameBufferTarget === 'function') return renderer._getFrameBufferTarget();
    return renderer._outputRenderTarget ?? null;
  };
  const depthTextureFor = (renderer) => {
    const current = effectiveTarget(renderer);
    // ⚠ KEYED BY WHAT THE SHADER CARES ABOUT — the sample count and the
    // depth format — never by the target's identity. Keyed by identity, every
    // scene pass the postprocess re-created (a camera switch, a resize) left
    // its predecessor's screen-sized depth copy in this map, and the map's
    // strong reference kept the dead target's own textures alive with it:
    // 14 MB per event, for the life of the water (the editor's texture
    // census read five of them, 2026-09-07).
    const source = current?.depthTexture;
    const samples = Math.max(1, current ? (current.samples || 1) : (renderer.currentSamples || 1));
    // No source target = the canvas itself, whose depth is depth32float under a
    // reversed buffer (WebGPUUtils.getCurrentDepthStencilFormat). A default
    // DepthTexture is depth24plus there and `copyFramebufferToTexture` rejects
    // the mismatch; the resolved type is in the key so a renderer rebuild that
    // toggles it cannot reuse the old copy.
    const type = source ? source.type : (renderer.reversedDepthBuffer === true ? FloatType : undefined);
    const key = `${samples}|${type ?? ''}|${source?.format ?? ''}`;
    let depth = depthTextures.get(key);
    if (!depth) {
      depth = new DepthTexture(1, 1);
      if (source) { depth.type = source.type; depth.format = source.format; }
      else if (type !== undefined) depth.type = type;
      depth.renderTarget = { samples };
      depthTextures.set(key, depth);
    }
    return depth;
  };
  const depthNode = texture(new DepthTexture(1, 1));
  depthNode.updateReference = function (frame) { this.value = depthTextureFor(frame.renderer); return this.value; };
  const copyViewportDepth = (frame) => {
    const { renderer } = frame;
    const current = effectiveTarget(renderer);
    const depth = depthTextureFor(renderer);
    const w = current ? current.width : renderer.domElement.width, h = current ? current.height : renderer.domElement.height;
    if (depth.image.width !== w || depth.image.height !== h) { depth.image.width = w; depth.image.height = h; depth.needsUpdate = true; }
    renderer.copyFramebufferToTexture(depth);
  };

  /** Is the eye on the +Y side of the water's own surface plane? Scale-free. */
  const eyeAbove = (camera) => {
    // The component's answer — the surface under the eye, with hysteresis —
    // when there is one; the rest plane otherwise (a harness without one).
    if (typeof simulation?.eyeBelow === "boolean") return !simulation.eyeBelow;
    if (!camera) return true;
    mesh.updateWorldMatrix(true, false);
    mesh.getWorldPosition(_origin);
    _up.set(0, 1, 0).transformDirection(mesh.matrixWorld).normalize();
    return camera.getWorldPosition(_eye).sub(_origin).dot(_up) >= 0;
  };

  // The sun and the scatter colour the subsurface term needs when there is
  // no slot to read them from (underwater off): the brightest directional
  // light, and the water colour under it — the slot's own formula.
  const sunFallback = { toSun: uniform(new Vector3(0, 1, 0)), scatter: uniform(new Color(0, 0, 0)) };
  const _from = new Vector3(), _to = new Vector3();
  let sunSource = null, sunSearch = 0;
  const update = () => {
    const gi = engine?.modules?.get('gi')?.system?.component;
    const setting = gi?.enabled !== false ? gi?.props?.reflections : undefined;
    gain.value = setting === false || setting === 0 ? 0 : 1;
    if (getSlot?.() ?? slot) return;              // the slot carries the sun; nothing to search for
    // The scene walk once a second, not per frame; the light's direction every frame.
    if (--sunSearch <= 0 || (sunSource && !sunSource.parent)) {
      sunSearch = 60; sunSource = null;
      engine?.scene?.traverse?.((object) => { if (object.isDirectionalLight && object.intensity > 0 && (!sunSource || object.intensity > sunSource.intensity)) sunSource = object; });
    }
    const source = sunSource;
    if (source && simulation?.uniforms?.color) {
      source.updateWorldMatrix(true, false, true); source.target?.updateWorldMatrix?.(true, false, true);
      source.getWorldPosition(_from); (source.target ?? source).getWorldPosition(_to);
      const ray = _to.sub(_from).normalize();
      sunFallback.toSun.value.copy(ray).negate();
      const luma = source.color.r * .2126 + source.color.g * .7152 + source.color.b * .0722;
      sunFallback.scatter.value.copy(simulation.uniforms.color.value).multiplyScalar(source.intensity * luma * Math.max(0, -ray.y) / Math.PI);
    }
  };

  const build = () => {
    // The caustic slot is read at every build: the component claims it from
    // an engine pool that may not exist at install time.
    if (getSlot) slot = getSlot() ?? slot;
    // The lid's shaded normal in LOCAL space (flat until the sea block sets it).
    let lidNormalLocal = normalLocal;
    const u = simulation?.uniforms ?? null;
    node?.dispose();
    // ── ONE MIRROR PER RENDER, NOT ONE PER FRAME ─────────────────────────
    //
    // `bounces: false` updates once per FRAME — for whichever render draws the
    // water first, which in this engine can be a GI probe capture or a second
    // viewport. Measured with a decoy camera rendered immediately before the
    // measured one: 80.8 px of error against 1.5 px. Per-render gives every
    // camera its own target, and `reflecting` is the recursion guard that
    // `bounces: false` was really buying.
    node = reflector({ target, resolutionScale: .5, generateMipmaps: true, bounces: true });
    const base = node._reflectorBaseNode ?? node;
    // three sizes the mirror from the DRAWING BUFFER while the shader samples
    // it with `screenUV`, which normalizes by the current render target. Those
    // agree only when the frame goes straight to the canvas.
    const resize = base._updateResolution.bind(base);
    base._updateResolution = (renderTarget, renderer) => {
      const current = renderer.getRenderTarget();
      if (!current) return resize(renderTarget, renderer);
      renderTarget.setSize(Math.max(1, Math.round(current.width * base.resolutionScale)),
        Math.max(1, Math.round(current.height * base.resolutionScale)));
    };
    const original = base.updateBefore.bind(base);
    base.updateBefore = (frame) => {
      update();
      if (disposed || gain.value === 0 || engine?.renderSuspended) return;
      if (reflecting) return false;
      reflecting = true;
      // ── A MIRROR MUST NOT REFLECT ITSELF, AND ITS RAY TRAVELS IN AIR ────
      //
      // The virtual camera sits below the surface looking up, so the water body
      // is the first thing it sees; and the reflected ray never crosses water,
      // so leaving the medium armed fogs the whole reflection as though it were
      // being viewed from underneath. Both are the same one-frame suspension.
      //
      // three also refuses to render a reflector the camera is behind and
      // CLEARS its target — right for a floor mirror, catastrophic for water,
      // where a surface seen from just under the waterline is the most
      // reflective thing in the scene. Rotating the target by π mirrors about
      // the same plane with its normal turned around, and the oblique clip then
      // keeps the half the eye is actually in.
      // The opaque scene's depth, before anything nested changes the context.
      copyViewportDepth(frame);
      const above = eyeAbove(frame.camera);
      target.rotation.x = above ? -Math.PI / 2 : Math.PI / 2;
      target.updateMatrixWorld(true);
      base.forceUpdate = true;
      const body = mesh.visible;
      const slots = engine?.waterSlots?.slots ?? [];
      const armed = slots.map((s) => s.uniforms.active.value);
      const nested = globalThis.__giNestedRender;
      globalThis.__giNestedRender = true;
      mesh.visible = false;
      for (const s of slots) s.uniforms.active.value = 0;
      // ⚠ NO BACKGROUND IN THE MIRROR. The sky is read per pixel along the
      // true reflected ray (`pmremTexture` below); the mirror is for what
      // stands near the water, and its ALPHA says where it saw geometry.
      const scene = frame.scene, renderer = frame.renderer;
      const background = scene.background, backgroundNode = scene.backgroundNode;
      const clearColor = renderer.getClearColor(_clearColor).clone(), clearAlpha = renderer.getClearAlpha();
      // ── THE SKY IS THREE'S OWN (2026-09-07) ────────────────────────────
      //
      // With an environment on the scene, the material's image-based lighting
      // already reflects the sky along every pixel's true reflected ray,
      // prefiltered by the wave roughness. The mirror's job is then what
      // STANDS near the water: it renders without a background and its alpha
      // says where it saw geometry. (A second sky term on top of the IBL
      // reflected the sky twice, and the sea's horizon read brighter than the
      // sky it mirrored — "our default ocean looks pathetic".) Without an
      // environment there is no IBL, and the mirror keeps the background.
      const strip = sceneHasEnvironment(scene);
      envReflection.value = strip ? 1 : 0;
      skyTerm.value = strip && scene.environmentNode && scene.environment?.isTexture ? 1 : 0;
      if (skyNode && scene.environment?.isTexture && skyNode.value !== scene.environment) skyNode.value = scene.environment;
      if (strip) { scene.background = null; scene.backgroundNode = null; renderer.setClearColor(0x000000, 0); }
      try { return original(frame); } finally {
        if (strip) { scene.background = background; scene.backgroundNode = backgroundNode; renderer.setClearColor(clearColor, clearAlpha); }
        reflecting = false;
        mesh.visible = body;
        for (let i = 0; i < slots.length; i++) slots[i].uniforms.active.value = armed[i];
        globalThis.__giNestedRender = nested;
      }
    };

    // ── DETAIL NORMALS FIRST: THEY CHANGE EVERY TERM BELOW ───────────────
    //
    // A 128² grid over ten metres cannot hold a wave finer than ~20 cm, and
    // real water is full of structure well under that. Geometry cannot get
    // there and a NORMAL can — which then feeds the Fresnel, the mirror's
    // distortion and the specular glitter at once, because all three read the
    // shading normal. This is "add those smaller details onto normal map".
    if (u && simulation?.spectrum) {
      // ── THE SEA'S SLOPE, PER PIXEL, FROM THE DERIVATIVE CASCADES ─────────
      //
      // The mesh normal carries only the ripple field (gridSimulation's
      // surface kernel); the sea is added here from the same derivative maps
      // the caustic lens reads, with their hardware mip chains — real waves
      // at every scale the spectrum holds, where the value-noise "detail
      // normal" used to be. Babylon's distance fade drops each cascade as its
      // texels fall under a pixel. Composed in LOCAL space against the
      // interpolated geometric normal and taken to view space from there, so
      // no tangent frame has to be guessed on an anisotropically scaled box.
      //
      // ⚠ AND STYLIZED WATER HAS ALMOST NONE OF IT. Sub-pixel glitter is the
      // single strongest cue that a surface is photographic; a cel-shaded pond
      // reads as cel-shaded largely by not having it.
      const world = vec2(positionLocal.x.mul(u.waveScale.x), positionLocal.z.mul(u.waveScale.z));
      const slope = seaShadingSlopeNode(simulation.spectrum, world, u.surfaceDetail, u.seaLod).mul(mix(float(1), float(.12), u.stylized));
      let local = vec2(slope.x.mul(u.waveScale.x).div(u.waveScale.y), slope.y.mul(u.waveScale.z).div(u.waveScale.y));
      // ...and the ripple WINDOW's slope, per pixel too, so a splash reads on
      // a mesh whose vertices are a metre apart (the mesh normal is flat).
      if (simulation.rippleTexture) {
        const w = simulation.ripple.resolution;
        const t = vec2(positionLocal.x.sub(u.rippleCenter.x).div(u.rippleHalf.x.mul(2)).add(.5), positionLocal.z.sub(u.rippleCenter.y).div(u.rippleHalf.y.mul(2)).add(.5));
        const inside = t.x.greaterThan(.5 / w).and(t.x.lessThan(1 - .5 / w)).and(t.y.greaterThan(.5 / w)).and(t.y.lessThan(1 - .5 / w));
        const r = select(inside, texture(simulation.rippleTexture, t), vec4(0));
        const ny = float(1).sub(r.y.mul(r.y)).sub(r.z.mul(r.z)).max(1e-3).sqrt();
        local = local.add(vec2(r.y.negate().div(ny), r.z.negate().div(ny)));
      }
      const perturbed = normalLocal.add(vec3(local.x.negate().mul(normalLocal.y), 0, local.y.negate().mul(normalLocal.y))).normalize();
      lidNormalLocal = perturbed;
      material.normalNode = transformNormalToView(perturbed);
    }
    // ── TWO SIDES, TWO FRESNELS ───────────────────────────────────────────
    //
    // "When looking at the water surface from below, can't see anything above
    // it, only the reflection of the pool floor" (user, 2026-09-06). From the
    // air, Schlick at R0 = 2 %. From the WATER, the exit angle is refracted
    // OUTWARD: beyond the critical angle (cos θ < 0.661 for n = 1.333) nothing
    // gets out and the underside is a perfect mirror of the pool — total
    // internal reflection — and inside that cone, Snell's window, the world
    // above shows through at the air-side transmittance of the exit angle.
    // ⚠ PER FRAGMENT, from the face the eye actually sees — a back face is
    // a piece of surface the eye is under, whatever the rest plane says. The
    // eye's height against the rest plane switched the WHOLE lid to the
    // water-side Fresnel from a trough: total-internal-reflection white on
    // every near slope ("depth issues under grazing angles", 2026-09-07).
    // The component culls the side the state does not need; a double-sided
    // lid (the harness) gets both, each with its own physics.
    const fromBelow = frontFacing.not();
    const cosV = normalView.dot(positionViewDirection).abs().clamp(0, 1);
    const airFresnel = cosV.oneMinus().pow(5).mul(.97963).add(.02037);
    const sin2t = float(1.333 * 1.333).mul(cosV.mul(cosV).oneMinus());
    const cosT = sin2t.oneMinus().max(0).sqrt();
    const waterFresnel = select(sin2t.greaterThanEqual(1), float(1), cosT.oneMinus().pow(5).mul(.97963).add(.02037));
    const fresnel = select(fromBelow, waterFresnel, airFresnel);
    // ⚠ FROM THE CAPTURE, NOT FROM THE MATERIAL — this function writes
    // `roughnessNode`, and reading the live slot would feed each rebuild its
    // own previous output and blur the mirror a little further every time.
    // The WATER's roughness, not the material's — see `gridSimulation`'s
    // update. An authored graph pins its own value and the component's control
    // would otherwise do nothing at all.
    const authoredRoughness = u ? u.roughness : (previous.roughnessNode ?? float(material.roughness ?? .12));
    // ── THE FAR SEA IS ROUGH, NOT GLASS ───────────────────────────────────
    //
    // Where distance fades a cascade out of the shading normal, its slope
    // variance becomes microfacet roughness (Beckmann m² = 2σ², GGX α ≈ m):
    // the sparkle a pixel can no longer resolve as normals is the lobe it
    // gets instead — the sun's glitter spreads into the broad highlight a real
    // sea shows toward the horizon, and the mirror blurs with it.
    const roughness = (u && simulation?.spectrum)
      ? float(authoredRoughness).pow(4).add(seaLostSlopeVarianceNode(simulation.spectrum).mul(2)).max(0).pow(.25).clamp(0, 1)
      : authoredRoughness;
    // The distortion belongs in ONE space: the wave normal against the same
    // surface's flat normal, both viewed from the camera, so it vanishes to
    // zero on flat water instead of drifting with where the camera points.
    const flatNormalView = transformDirection(cameraViewMatrix, modelNormalMatrix.mul(vec3(0, 1, 0)).normalize()).normalize();
    const uv = screenUV.flipX().add(normalView.sub(flatNormalView).xy.mul(distortion)).clamp(.001, .999);
    // ── THE MIRROR IS FOR WHAT STANDS NEAR THE WATER ──────────────────────
    //
    // A planar mirror of a flat sky, bent by a two-percent distortion, is a
    // sheet of glass: the swells' slopes could not show through it (the
    // ocean arm, 2026-09-06). The sky along each pixel's true reflected ray,
    // prefiltered by the roughness the far field earns, is the material's own
    // image-based lighting whenever the scene has an environment — so then
    // the mirror counts only where its alpha says it saw geometry (it renders
    // without a background; see the hook). Without an environment the mirror
    // carries the background as it always did.
    const mirror = node.sample(uv).level(float(roughness).clamp(0, 1).mul(6));
    let reflected = mirror.rgb.mul(mix(float(1), mirror.a.clamp(0, 1), envReflection)).mul(fresnel).mul(gain);
    // The environment along the reflected ray, prefiltered by the roughness
    // the far field earns — only while the material's IBL is overridden
    // (`skyTerm`; see the hook). `skyNode.value` follows the scene's texture.
    const skyTexture = engine?.scene?.environment?.isTexture ? engine.scene.environment : null;
    if (skyTexture) {
      const lidNormalWorldR = modelNormalMatrix.mul(lidNormalLocal).normalize();
      const R = reflect(cameraPosition.sub(positionWorld).normalize().negate(), lidNormalWorldR);
      skyNode = pmremTexture(skyTexture, R, float(roughness).clamp(0, 1));
      // The same reflectance the material's IBL would apply — Karis'
      // analytic environment BRDF for water's F0 (0.02) — not the bare
      // Fresnel: a rough far sea at grazing returns ~15 % of the sky, a calm
      // one ~70 %, and with plain Fresnel the GI-mode sea read 108 % of its
      // sky against 48 % with the IBL (harness, 2026-09-07).
      const rr = vec4(-1, -.0275, -.572, .022).mul(float(roughness).clamp(0, 1)).add(vec4(1, .0425, 1.04, -.04));
      const a004 = rr.x.mul(rr.x).min(cosV.mul(-9.28).exp2()).mul(rr.x).add(rr.y);
      const envF = float(.02).mul(a004.mul(-1.04).add(rr.z)).add(a004.mul(1.04).add(rr.w));
      reflected = reflected.add(skyNode.rgb.mul(envF).mul(skyTerm).mul(select(fromBelow, float(0), float(1))));
    }

    let emissive = vec3(previous.emissiveNode ?? 0);
    if (u) {
      // Foam is WHITE, ROUGH AND OPAQUE — a material, not a glow, and not a
      // mirror either.
      // ⛔ NOT THE POST CHAIN'S OWN DEPTH. The lid draws INTO that pass, and
      // sampling its depth attachment from inside it is a read and a write
      // of one texture in one synchronization scope: "[Texture "depth"]
      // usage (TextureBinding|RenderAttachment) includes writable usage",
      // the water's pipeline refused (user, 2026-09-07, post-processing on
      // the camera). The contact foam reads the same per-target depth COPY
      // the refraction arm reads (`depthNode`, copied before the lid draws).
      const soft = waterFoamNode(u, depthNode, simulation?.spectrum ?? null, simulation?.flowTexture ? texture(simulation.flowTexture) : null).toVar();
      // ── ⛔ `style` EXISTED ONLY IN A MATERIAL NOBODY USES ─────────────────
      //
      // The banding and the hard foam edge that make "stylized" stylized were
      // written into the GENERATED water material, and every water in practice
      // wears an authored one (`builtin:Water.mat`), so the dropdown moved
      // nothing: a property sweep scored it at a BIT-IDENTICAL zero. Same shape
      // as colour, saturation, foam, roughness, caustic intensity and
      // transmission before it — which is why there is now a test that sets
      // every control to both ends of its range and measures the frame.
      //
      // Two things separate a stylized surface from a realistic one, and both
      // belong here, where the authored material is actually composed: the
      // colour steps instead of graduating, and the foam has an EDGE instead of
      // a falloff. Nothing else changes, so the dropdown is a look and not a
      // second water.
      const foam = mix(soft, soft.smoothstep(.28, .34), u.stylized).toVar();
      const baseColor = vec3(previous.colorNode ?? materialColor).toVar();
      const banded = baseColor.mul(4).add(.5).floor().div(4);
      material.roughnessNode = mix(float(roughness), float(.85), foam);
      // ── ⛔ THE DIAL WAS BAKED INTO THE GRAPH AT BUILD TIME ────────────────
      //
      // This read `previous.transmission` — the AUTHORED material's value,
      // captured once — and compiled it in as a constant. `gridSimulation`
      // dutifully wrote `material.transmission` on every prop change, and a
      // `transmissionNode` overrides that property completely, so the slider
      // moved a number three had stopped reading: "refraction does not change
      // anything when changing, and does not seem to be working" (user,
      // 2026-09-06). The water's own uniform is the live one, and using it also
      // makes the control work on an AUTHORED material, which is every water in
      // practice — the fifth control to have had exactly this shape.
      const through = u.transmission;
      // ── THE WATER REFRACTS FOR ITSELF ────────────────────────────────────
      //
      // three's transmission bends the ray and then multiplies it, per axis,
      // by the mesh's scale (`getVolumeTransmissionRay`: `normalize(r) ·
      // thickness · modelScale`). On a 5 × 3 × 5 pool the sideways travel is
      // 5/3 of the downward one: every surface pixel read the framebuffer far
      // beyond where its ray really lands, and a crate at the waterline was
      // painted onto the water beside it — "this bug with red box reflection
      // which is obviously incorrect" (user, 2026-09-06, the fourth report).
      // So the surface does its own: Snell in WORLD space, the column to the
      // first wall or the floor, the exit point projected and read from the
      // same framebuffer copy three used, tinted the same way (the water's
      // colour × Beer's law over the column, the authored attenuation). Only
      // the geometry changed.
      material.transmissionNode = null; material.transmission = 0; material.thicknessNode = null;
      // ⚠ THE LID WRITES DEPTH. It composes its own refraction and mirror,
      // so it needs no blending — and without a depth write the clipmap's
      // far rings, drawn after the near ones, painted far crests over near
      // ones at grazing angles and spray behind a crest showed through it
      // ("far waves appear in front of the close ones, same with sprays",
      // user, 2026-09-07). An authored material's flags do not decide this.
      material.depthWrite = true; material.depthTest = true;
      const toEyeWorld = cameraPosition.sub(positionWorld).normalize();
      const lidNormalWorld = modelNormalMatrix.mul(lidNormalLocal).normalize();
      // From BELOW the ray leaves into air: the normal faces the eye and eta
      // inverts; beyond the critical angle `refract` is zero (total internal
      // reflection — the mirror carries everything there).
      const bentWorld = refract(toEyeWorld.negate(), select(fromBelow, lidNormalWorld.negate(), lidNormalWorld), select(fromBelow, float(1.333), float(1 / 1.333)));
      // ⚠ CLIPPED TO THE VOLUME, in LOCAL extents but WORLD metres of travel:
      // P + t·bentWorld ↔ P_local + t·(M⁻¹ bentWorld), same t. Unclipped, a
      // grazing ray's exit point landed outside the pool and sampled the sky
      // inside the water ("those incorrect reflections are back").
      gbufferMaterial.mrtNode = mrt({ output: vec4(positionWorld, 1), giNormal: vec4(bentWorld, 1) });
      gbufferMaterial.needsUpdate = true;
      const bentLocal = modelWorldMatrixInverse.mul(vec4(bentWorld, 0)).xyz;
      const tFloor = u.waterDepth.div(bentLocal.y.negate().max(1e-4));
      const tX = u.halfExtent.x.sub(positionLocal.x.mul(bentLocal.x.sign())).div(bentLocal.x.abs().max(1e-5));
      const tZ = u.halfExtent.z.sub(positionLocal.z.mul(bentLocal.z.sign())).div(bentLocal.z.abs().max(1e-5));
      let column = tFloor.min(tX).min(tZ).max(0).min(u.waterDepth.mul(u.waveScale.y).mul(3));
      let refracted;
      const giSystem = giSystemNow();
      const giTraced = underwater && !!(giSystem?.registerWaterRefraction && slot);
      if (globalThis.__waterRefractionLog !== false) console.log(`[water] refraction arm: ${!underwater ? 'NONE (underwater off)' : giTraced ? 'BVH-traced' : 'screen-space'} (gi ${giSystem ? 'present' : 'absent'}, register ${typeof giSystem?.registerWaterRefraction}, slot ${slot ? 'yes' : 'no'})`);
      if (!underwater) {
        // ── UNDERWATER OFF: nothing below the surface is looked at. The lid
        // is its deep colour under the reflection — no framebuffer read at a
        // refracted pixel, no GI ray through the water, no medium column.
        // The body colour the medium's deep column would have given: the
        // tuned water colour falling to the deep colour — not the deep colour
        // alone, which read as black under a pale sky's reflection.
        // A quarter of the way to the water colour, at seven tenths: the
        // medium's column is a dark, absorbing thing (a bright body colour
        // read as milk, and the crest gradient drew contour lines on it).
        refracted = mix(vec3(u.deepColor), baseColor, .25).mul(.7).mul(fresnel.oneMinus());
      } else if (giTraced && !giRefraction) {
        mesh.layers.enable(WATER_REFRACTION_LAYER);
        giRefraction = giSystem.registerWaterRefraction({
          mesh, material: gbufferMaterial, layer: WATER_REFRACTION_LAYER,
          causticGain: (point, normal) => waterCausticGainNode(point, slot, normal),
          radianceNode: refractionRadiance, hitNode: refractionHit,
        });
        giRefractionSystem = giSystem;
      }
      if (giTraced) {
        // ── THE TRACED HIT, AT THIS PIXEL ──────────────────────────────────
        //
        // `hit.x` is the distance along the refracted ray to the first thing
        // it meets in the scene BVH (−1 untraced, −2 left the scene);
        // `radiance` is that hit shaded (albedo, sun through the lens, its
        // shadow, probes, emitters). The medium is applied over the traced
        // segment — absorption, in-scatter and the shafts along the very ray
        // the eye follows into the water. A miss from above reads as deep
        // water; from below, the ray left into the air and the mirror's
        // target holds the world above.
        const hit = refractionHit.sample(screenUV).toVar();
        const rad = refractionRadiance.sample(screenUV).toVar();
        const t = hit.x.max(0).toVar();
        const valid = rad.w.greaterThan(.5).and(hit.x.greaterThanEqual(0));
        const hitLocal = modelWorldMatrixInverse.mul(vec4(positionWorld.add(bentWorld.mul(t)), 1)).xyz;
        const far = hitLocal.y.negate().mul(u.waveScale.y).max(0);
        const segment = { near: float(0), far, length: t, at: (k) => positionWorld.add(bentWorld.mul(t.mul(k))) };
        // ⚠ Inside `Fn` scopes: the medium's `If` needs a shader stack, which
        // exists only while a function body is being built, not while the
        // material's graph is assembled ("Cannot read properties of null
        // (reading 'If')", editor, 2026-09-06).
        const lit = Fn(() => { const rgb = rad.rgb.toVar(); applyMediumSegment(rgb, slot, segment); return rgb; })();
        const deepLength = u.waterDepth.mul(u.waveScale.y).mul(4);
        const deep = Fn(() => { const rgb = vec3(0).toVar(); applyMediumSegment(rgb, slot, { near: float(0), far: deepLength, length: deepLength, at: (k) => positionWorld.add(bentWorld.mul(deepLength.mul(k))) }); return rgb; })();
        const above = node.sample(screenUV.flipX()).rgb;
        const travel = t;
        const beer = select(materialAttenuationDistance.greaterThan(0),
          vec3(materialAttenuationColor).max(1e-4).log().mul(travel.div(materialAttenuationDistance)).exp(), vec3(1));
        refracted = select(valid, lit, select(fromBelow, above, deep)).mul(baseColor).mul(beer).mul(fresnel.oneMinus());
      } else {
        // ── THE DEPTH BEHIND EVERY PIXEL, FROM THE VIEWPORT'S OWN DEPTH BUFFER ─
        //
        // The water copies the opaque depth before it draws (`copyViewportDepth`;
        // multisampled on the editor's viewport, loaded per texel). One copy,
        // sampled twice: at this pixel, for the column;
        // at the refracted pixel, for what is there. A pixel's depth unprojects
        // through the camera to a world point, and the lid's inverse says
        // whether that point is under the water at all.
        const viewportDepth = depthNode;
        const worldAt = (uv, depth) => {
          const h = cameraWorldMatrix.mul(cameraProjectionMatrixInverse.mul(vec4(uv.x.mul(2).sub(1), uv.y.oneMinus().mul(2).sub(1), depth, 1)));
          return h.xyz.div(h.w);
        };
        // ── THE STRAW IN THE GLASS: THE OBJECT BEHIND THE PIXEL SETS THE COLUMN ─
        //
        // An object crossing the surface must appear BROKEN at the waterline: the
        // offset is the water between the surface and the object — nothing at
        // the waterline, the whole column at the floor.
        const behind = worldAt(screenUV, viewportDepth.sample(screenUV).x).sub(positionWorld).length();
        // ⚠ A METRE OF TRAVEL AT MOST. The floor's absolute displacement is
        // invisible (nothing undisplaced stands beside it to compare with); what
        // the eye reads is the waves' wobble and an object's break at the
        // waterline, both of which a metre carries. The full three-metre column
        // only widened the band beside a crate whose samples land on it.
        column = column.min(behind).min(1);
        // `transmission` still scales the travel — the dial that reads as
        // "refraction". From below there is no column: the pixel behind.
        const travel = select(fromBelow, float(0), column.mul(through));
        const uvAt = (t) => {
          const exit = positionWorld.add(bentWorld.mul(t));
          const clip = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(exit, 1)));
          const ndc = clip.xy.div(clip.w).add(1).mul(.5);
          return vec2(ndc.x, ndc.y.oneMinus()).clamp(.001, .999);
        };
        // ── NOTHING ABOVE THE WATER CAN BE SEEN THROUGH IT ─────────────────
        //
        // The framebuffer at the refracted pixel may hold an object standing
        // ABOVE the surface — a crate's faces, painted onto the water behind it
        // ("there are 2: one is correct, another is broken", user, 2026-09-06,
        // the seventh report). Unproject what is there: if it stands above the
        // lid's plane it cannot be behind this pixel's ray. Eroded by a texel at
        // full travel: the colour copy is the RESOLVED image, the depth one
        // sample of it, so a silhouette pixel passes with the object's colour
        // bled into it — a one-pixel red fringe. And a refused ray does not
        // drop to the pixel beneath it (that read as a flat hole with no waves
        // in it): the travel shrinks in steps, so the wobble the surface's
        // normal gives the ray survives next to the crate, only shorter.
        const aboveAt = (uv) => modelWorldMatrixInverse.mul(vec4(worldAt(uv, viewportDepth.sample(uv).x), 1)).y.greaterThan(.002);
        const texel = vec2(1.5).div(screenSize);
        // Every level eroded the same way: a level tested at its centre only
        // left its own one-pixel contour of bled colour ("several layers of red
        // borders", user, 2026-09-06).
        const blockedAt = (uv) => aboveAt(uv)
          .or(aboveAt(uv.add(vec2(texel.x, 0)))).or(aboveAt(uv.sub(vec2(texel.x, 0))))
          .or(aboveAt(uv.add(vec2(0, texel.y)))).or(aboveAt(uv.sub(vec2(0, texel.y))));
        // The last resort keeps the waves: the pixel beneath, nudged by the
        // surface's slope a few pixels — the wobble without the travel.
        const uvFull = uvAt(travel), uvMid = uvAt(travel.mul(.4));
        const uvWobble = screenUV.add(normalView.sub(flatNormalView).xy.mul(vec2(.03, -.03))).clamp(.001, .999);
        const sampleUv = select(blockedAt(uvFull), select(blockedAt(uvMid), select(blockedAt(uvWobble), screenUV, uvWobble), uvMid), uvFull);
        // ⚠ THE MATERIAL'S OWN ATTENUATION, exactly as three's `volumeAttenuation`
        // read it: colour^(travel / distance), none at an infinite distance. Every
        // water in practice wears the AUTHORED material, whose distance is
        // infinite — the water's own `deepColor`/`absorption` pair belongs to the
        // generated material only, and applied here it made a pool of ink ("if
        // make water surface fully opaque, reflection won't longer be an issue?",
        // user, 2026-09-06). The depth of the water is the MEDIUM's job.
        const beer = select(materialAttenuationDistance.greaterThan(0),
          vec3(materialAttenuationColor).max(1e-4).log().mul(travel.div(materialAttenuationDistance)).exp(), vec3(1));
        // Tinted by the water's colour, as three's transmission tinted it: the
        // look the user tuned.
        refracted = viewportTexture(sampleUv).rgb.mul(baseColor).mul(beer).mul(fresnel.oneMinus());
      }
      // What three's `mix(diffuse, backdrop, transmission)` left of the
      // diffuse — the stylized, less-than-clear water — stays on the colour.
      // Foam is not a perfect white: sea foam reflects about three quarters of
      // the light, and at 1 it clipped to a flat cut-out under a strong sun.
      material.colorNode = mix(mix(baseColor, banded, u.stylized).mul(through.oneMinus()), vec3(.75), foam);
      // The transmitted light, lighter and greener along the crests (thin
      // water), the body's colour in the troughs — see waterCrestGradientNode.
      const subsurface = waterSubsurfaceNode(u, slot ?? sunFallback);
      emissive = emissive.add(refracted.mul(waterCrestGradientNode(u)).mul(through).mul(foam.oneMinus()));
      emissive = emissive.add(reflected.mul(foam.oneMinus()));
      emissive = emissive.add(subsurface.mul(foam.oneMinus()));
      // Harness probe (`?lookDebug=reflected|refracted|subsurface|lit`): one
      // term of the surface alone, the others black — to find which one
      // carries an artefact.
      const probe = globalThis.__waterLookDebug;
      if (probe && probe !== 'lit') { emissive = { reflected, refracted: refracted.mul(waterCrestGradientNode(u)).mul(through), subsurface, fresnel: vec3(fresnel).mul(.5), facing: select(frontFacing, vec3(0, .6, 0), vec3(1, 0, 0)), gradient: waterCrestGradientNode(u).mul(.5), base: mix(vec3(u.deepColor), baseColor, .25), through: vec3(through) }[probe] ?? emissive; material.colorNode = vec3(0); }
      if (probe === 'lit') emissive = vec3(0);
    } else {
      emissive = emissive.add(reflected);
    }
    // Harness probe: the foam value alone (`?foamDebug=1`).
    if (globalThis.__waterFoamDebug === 'sea' && u) { material.emissiveNode = vec3(seaFoamValueNode(u, simulation?.spectrum ?? null)); material.colorNode = vec3(0); }
    else if (globalThis.__waterFoamDebug && u) { material.emissiveNode = vec3(waterFoamNode(u, null, simulation?.spectrum ?? null)); material.colorNode = vec3(0); }
    else material.emissiveNode = emissive;
    material.userData.giWater = true;
    material.needsUpdate = true;
    reportBindings();
  };

  /**
   * ── A RECEIPT FOR THE ONE LIMIT NO HARNESS CAN SEE ────────────────────
   *
   * The water's fragment stage binds the medium's slot arrays, the depth
   * texture, the mirror, the transmission target, the sea's derivatives —
   * and, only in the editor, the shadow maps, the environment and GI. The
   * portable limit is sixteen and the harness counts nine; the editor
   * reported seventeen ("The number of sampled textures (17) in the Fragment
   * stage exceeds the maximum per-stage limit (16)", 2026-09-06). So the
   * compiled shader is asked, once per build, and the census goes to the
   * console where `console_read` can see it — by TYPE, since the declarations
   * are anonymous, which is enough to say what the editor adds.
   */
  let reportTimer = null;
  const reportBindings = () => {
    const renderer = engine?.renderer;
    if (!renderer?.debug?.getShaderAsync || !engine?.scene || !engine?.camera) return;
    clearTimeout(reportTimer);
    reportTimer = setTimeout(async () => {
      if (disposed) return;
      // The water's own two, then every other material in the scene: the
      // medium (`scene.fogNode`) and the caustic light compile into ALL of
      // them, so a material that was one binding under the limit before the
      // water arrived is the one that fails after — and three names the
      // pipeline, not the material.
      const seen = new Set();
      const census = [["water lid", mesh], ["water body", mesh.children?.find?.((c) => c.userData?.vfxSimulation === "water")]];
      engine.scene.traverse((o) => {
        const m = Array.isArray(o.material) ? o.material[0] : o.material;
        if (!o.isMesh || !m || o === mesh || o.parent === mesh || seen.has(m.uuid) || seen.size > 12) return;
        if (!m.isNodeMaterial || m.userData?.engineOwned) return;
        seen.add(m.uuid);
        census.push([`${o.name || o.type} / ${m.name || m.type}`, o]);
      });
      for (const [label, object] of census) {
        if (!object) continue;
        try {
          const { fragmentShader } = await renderer.debug.getShaderAsync(engine.scene, engine.camera, object);
          const kinds = {};
          for (const m of fragmentShader.matchAll(/@binding\(\s*\d+\s*\)\s*@group\(\s*\d+\s*\)\s*var\s+\w+\s*:\s*(texture_[\w]+)/g)) {
            if (m[1].startsWith("texture_storage")) continue;
            kinds[m[1]] = (kinds[m[1]] ?? 0) + 1;
          }
          const total = Object.values(kinds).reduce((a, b) => a + b, 0);
          console.log(`[water] ${label}: fragment binds ${total} sampled textures (portable limit 16): ${
            Object.entries(kinds).map(([k, n]) => `${n}× ${k}`).join(", ")}${total > 16 ? " ⛔ OVER THE LIMIT" : ""}`);
        } catch (error) { console.log(`[water] ${label}: binding census failed: ${error?.message ?? error}`); }
      }
    }, 3000);
  };

  const onWave = () => { if (!disposed && ++rearms <= 8) queueMicrotask(() => { if (!disposed) build(); }); };
  engine?.on?.('gi-compile-wave-done', onWave);
  // The scene pass is (re)created after the water more often than not. A
  // rebuild is what the SAMPLE COUNT needs (the depth binding is multisampled
  // or not at build time); the same count re-adopted by the postprocess (a
  // camera switch, play/stop) is not worth a 90 ms freeze, a new pipeline in
  // three's cache and a new mirror target — the same pass, the same shader.
  let passSamples;
  const onPass = (pass) => {
    if (disposed) return;
    const samples = pass ? (pass.renderTarget?.samples ?? 1) : (engine?.renderer?.currentSamples ?? 1);
    if (samples === passSamples) return;
    passSamples = samples;
    queueMicrotask(() => { if (!disposed) build(); });
  };
  engine?.on?.('scene-pass-changed', onPass);
  build(); update();
  return {
    update, gain, distortion,
    get node() { return node; },
    get base() { return node?._reflectorBaseNode ?? null; },
    dispose() {
      if (disposed) return; disposed = true;
      clearTimeout(reportTimer);
      engine?.off?.('gi-compile-wave-done', onWave);
      engine?.off?.('scene-pass-changed', onPass);
      node?.dispose(); target.removeFromParent();
      if (giRefraction) { giRefractionSystem?.unregisterWaterRefraction?.(giRefraction); giRefraction = null; mesh.layers.disable(WATER_REFRACTION_LAYER); }
      gbufferMaterial.dispose();
      for (const depth of depthTextures.values()) depth.dispose(); depthTextures.clear();
      material.emissiveNode = previous.emissiveNode; material.colorNode = previous.colorNode;
      material.roughnessNode = previous.roughnessNode; material.normalNode = previous.normalNode;
      material.transmissionNode = previous.transmissionNode; material.thicknessNode = previous.thicknessNode;
      material.transmission = previous.transmission;
      if (previous.giWater === undefined) delete material.userData.giWater;
      else material.userData.giWater = previous.giWater;
      material.needsUpdate = true;
    },
  };
}
