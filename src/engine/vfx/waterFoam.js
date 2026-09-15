import {
  Fn, attribute, cameraFar, cameraNear, cameraPosition, float, linearDepth, mix, normalWorld, positionLocal, positionWorld,
  screenUV, select, texture, vec2, vec3,
  time,
} from "three/tsl";
import { waterRimDistanceNode } from "./waterShape.js";
import { seaDisplacementAt, seaFoamWindowNode } from "./waterSpectrum.js";
import { foamDetailTexture } from "./waterFoamTexture.js";

/**
 * ══ WHAT A WATER SURFACE ADDS ON TOP OF BEING A MIRROR ═════════════════════
 *
 * Foam and subsurface scattering. Both land on material slots
 * `waterSurfaceLook.js` owns, which is why they are composed there — three has
 * exactly one `emissiveNode` and two modules writing it would silently clobber
 * each other. The fine-scale NORMAL used to live here too, as the slope of a
 * value-noise field; it is the spectral sea's derivative cascades now
 * (`waterSpectrum.js#seaShadingSlopeNode`) — real waves, not noise.
 *
 * ⚠ THESE READ THE SOLVER, NOT A SLOT. The engine-owned slots exist for
 * consumers that must not rebuild when a water surface changes (the medium,
 * GI); a material already rebuilds with its own water, so it may read the
 * simulation directly and get the authored wave settings with it.
 */

// ── NOISE PRIMITIVES ────────────────────────────────────────────────────────
// Hash without sine (Dave Hoskins hash12/hash22): `fract(sin(x)·43758)` bands
// once float32 `sin` quantizes at large world-cell arguments (mobile GPUs worst).
// fract/dot/mul only — identical in WGSL and the WebGL2 fallback. Range [0,1).
const hash = (p) => {
  const q = vec3(p.x, p.y, p.x).mul(.1031).fract();
  const r = q.add(q.dot(q.yzx.add(33.33)));
  return r.x.add(r.y).mul(r.z).fract();
};
const hash2 = (p) => {
  const q = vec3(p.x, p.y, p.x).mul(vec3(.1031, .1030, .0973)).fract();
  const r = q.add(q.dot(q.yzx.add(33.33)));
  return vec2(r.x.add(r.y).mul(r.z), r.x.add(r.z).mul(r.y)).fract();
};
const valueNoise = Fn(([p]) => {
  const i = p.floor().toVar(), f = p.fract().toVar();
  const u = f.mul(f).mul(f.mul(-2).add(3));
  const a = hash(i), b = hash(i.add(vec2(1, 0))), c = hash(i.add(vec2(0, 1))), d = hash(i.add(vec2(1, 1)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});
/**
 * Cellular (Worley) noise: the distance to the nearest and second-nearest of a
 * jittered lattice of points, both in cell units. `F2 − F1` is zero exactly on
 * the boundary between two cells and grows away from it, which is what draws
 * the NETWORK foam makes; `F1` alone is a field of round blobs, which is what
 * draws the bubbles and the holes in a sheet. The jitter drifts with `time`,
 * so the cells breathe slowly instead of sitting still like a texture.
 */
const cellular = Fn(([p, time]) => {
  const i = p.floor().toVar(), f = p.fract().toVar();
  const f1 = float(8).toVar(), f2 = float(8).toVar();
  for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
    const g = vec2(x, y);
    const jitter = hash2(i.add(g)).mul(6.2831).add(time).sin().mul(.5).add(.5);
    const r = g.add(jitter).sub(f);
    const d = r.dot(r).toVar();
    const closer = d.lessThan(f1);
    f2.assign(select(closer, f1, f2.min(d)));
    f1.assign(select(closer, d, f1));
  }
  return vec2(f1.sqrt(), f2.sqrt());
});
const ANGLES = [.0, 1.1, 2.3, 3.9, 5.1, 2.7, 4.4, .6];
const SPEEDS = [.11, -.19, .31, -.43, .23, -.37, .53, -.29];

/** Fixed four octaves, each rotated so the lattice never lines up with itself.
 *  Used where the fractal is a breakup mask and its shape is not authored. */
function fbm(p, time, drift = 1) {
  let sum = float(0), amplitude = float(.5), scale = float(1);
  for (let i = 0; i < 4; i++) {
    const c = Math.cos(ANGLES[i]), s = Math.sin(ANGLES[i]);
    const q = vec2(p.x.mul(c).sub(p.y.mul(s)), p.x.mul(s).add(p.y.mul(c))).mul(scale)
      .add(time.mul(SPEEDS[i] * drift));
    sum = sum.add(valueNoise(q).mul(amplitude));
    amplitude = amplitude.mul(.5);
    scale = scale.mul(2.07);
  }
  return sum.mul(1.0667);          // four halving octaves sum to 0.9375
}

/**
 * ⭐ **THE DETAIL RUNS ON THE WAVES' CLOCK, NOT ON THE WALL.**
 *
 * `simTime` is elapsed seconds. The swell multiplies it by `waveSpeed`
 * (the spectral sea's clock) and the fine detail did not, so the two were
 * only ever coincidentally in step: set the waves slow and the detail — and the
 * caustic lens it bends, and the god rays that lens makes — kept scrolling at
 * the same fixed rate. Measured with the waves STOPPED, where the answer has to
 * be zero: the caustic map still turned over 4.2 % of itself every tenth of a
 * second. "They don't match the surface speed" (user, 2026-09-06), exactly.
 *
 * The 0.25 is the rate itself, and it is deliberately about four times slower
 * than the constant it replaces — the same report asks for these to "update
 * slower and smoother", and a detail field is ripples riding a swell, not
 * weather of its own.
 */
function waveClock(u) { return u.simTime.mul(u.speed).mul(.25); }

/** Where this fragment is in WORLD metres, for noise that does not change size
 *  with the pool. */
const worldXZ = (u) => vec2(positionLocal.x.mul(u.waveScale.x), positionLocal.z.mul(u.waveScale.z));

/**
 * ══ FOAM ═══════════════════════════════════════════════════════════════════
 *
 * ⭐ **FOAM IS ONE NUMBER PER POINT — HOW MUCH — AND THE LOOK IS A FUNCTION
 * OF THAT NUMBER.** The number comes from two places:
 *
 *  · THE SIMULATED FIELD (`gridSimulation.js`) — entrained by steep water, by
 *    crests two waves built between them, and by anything churning the
 *    surface; it spreads, persists and decays, so a patch drifts and dissolves
 *    instead of blinking with the wave that made it.
 *  · CONTACT — how close the opaque scene is behind this fragment. Not a
 *    property of water at all, just a depth comparison.
 *
 * What the number DRAWS is taken from the photographs (and the sea): fresh,
 * dense foam is a white SHEET with holes in it; as it thins it breaks into a
 * NETWORK of filaments along the boundaries of the cells the bubbles drain
 * into — the web every aerial photograph of a wake shows — and the last of it
 * is a scatter of single BUBBLES. So a high value draws the sheet, a middle
 * value the web, a low value specks; and because the field decays over a few
 * seconds, one patch goes through all three in order, sheet → web → specks,
 * which is what foam actually does.
 *
 * ⛔ THE PREVIOUS VERSION CARVED A BLOB FIELD WITH VALUE NOISE. Value noise
 * has structure at one scale per octave and no lines in it at all, so foam
 * came out as soft-edged white blotches at every strength ("it is not
 * realistic", user 2026-09-06, with a photograph of the network beside it).
 * The network is a Worley boundary, not a threshold on a blob.
 *
 * `foam` decides how much of the surface counts as foamy (it moves the
 * generation threshold in the solver) and gates this on or off; it is not a
 * dimmer, because half-transparent foam is a grey wash and not less foam.
 */
export function waterFoamNode(u, sceneDepth = null, spectrum = null, flow = null) {
  // ⚠ WRAPPED IN `Fn`, AND IT HAS TO BE. `toVar()` and `addAssign` allocate on
  // the builder's STACK, and a node factory called straight from a material
  // build has no stack — "No stack defined for assign operation". Anything here
  // that declares a variable belongs inside one of these.
  return Fn(() => waterFoamBody(u, sceneDepth, spectrum, flow))();
}
function waterFoamBody(u, sceneDepth, spectrum, flow) {
  const p = worldXZ(u);
  const clock = waveClock(u);
  const drift = clock.mul(.5);
  // ── THE WAKE PATTERN RIDES THE FLOW ──────────────────────────────────
  // The pattern's coordinates follow the water: the drift the solver
  // accumulated (`flowTexture` .zw, local units) where the ripple window is,
  // so a wake's sheet and web move with the water they float on instead of
  // sitting still while it passes ("a static pattern", user, 2026-09-07).
  let carried = vec2(0);
  if (flow) {
    const t = vec2(positionLocal.x.sub(u.rippleCenter.x).div(u.rippleHalf.x.mul(2)).add(.5), positionLocal.z.sub(u.rippleCenter.y).div(u.rippleHalf.y.mul(2)).add(.5));
    const inside = t.x.greaterThan(0).and(t.x.lessThan(1)).and(t.y.greaterThan(0)).and(t.y.lessThan(1));
    const d = flow.sample(t.clamp(0, 1)).zw;
    carried = select(inside, vec2(d.x.mul(u.waveScale.x), d.y.mul(u.waveScale.z)), vec2(0));
  }
  const pw = p.sub(carried);

  // The solver's own foam, and the contact term.
  // ── WHITECAPS, PER PIXEL ──────────────────────────────────────────────
  //
  // The field's foam arrives per VERTEX, and a clipmap ring's vertices are
  // metres apart and sample the Jacobian at coarse mips, where its extremes
  // average away — an ocean at full choppiness showed no whitecaps at all
  // (the ocean arm, 2026-09-06). The fold is read here at the pixel from the
  // same cascades the shading normal reads, band-limited by their own mips.
  // The ripple field's foam: wakes, splashes, a rim's churn — drawn with the
  // sheet / network / flecks below. The SEA's whitecaps are a separate value
  // and a separate look (the end of this function).
  const simulated = attribute("waterFoam", "float").clamp(0, 1);
  let sea = null;
  if (spectrum) {
    // The whitecap MEMORY (waterSpectrum.js, the foam window) carries the
    // streaks and the distance; the instantaneous gate keeps the fold's own
    // edge crisp where the eye is close enough to see it.
    // The particles' splat (soft discs summed) IS the foam: a fold births
    // them at nine a square metre a second, so a breaking crest whitens in
    // a fifth of a second and the trail behind it is what the wind streaks
    // are. (A per-pixel gate on the fold beside it painted every steep face
    // a snow blanket — the eye shot, 2026-09-07.)
    sea = seaFoamWindowNode(spectrum, p).min(1).toVar();
  }
  // The width itself is modulated, so the shoreline is ragged rather than a
  // uniform ring offset from the geometry.
  const ragged = fbm(p.mul(.7), clock, .7);
  const width = u.foamThreshold.max(.02).mul(ragged.mul(1.1).add(.45));
  // ── CONTACT: SCENE DEPTH ONLY FROM A PASS THAT OWNS IT ─────────────────
  //
  // Whatever the water touches foams at the waterline. The general answer
  // is the scene depth behind the fragment, but three's shared
  // `viewportDepthTexture()` is declared with the sample count of whichever
  // render target is current when the shader is BUILT (the MSAA canvas,
  // during GI's compile wave) and then bound in whatever pass draws the
  // water — a 1-sample one gets a 1×1 placeholder instead: "Sample count (1)
  // … doesn't match expectation (multisampled: 1)" (live editor,
  // 2026-09-06). So scene depth is read ONLY from a pass that owns its depth
  // texture (`engine.scenePass`, the post chain's beauty pass — its sample
  // count is a property of the texture). Without one, contact is the pool's
  // own rim: the box's edges in world metres, which binds nothing at all.
  const halfW = u.waveScale.x.mul(u.halfExtent.x), halfH = u.waveScale.z.mul(u.halfExtent.z);
  // Metres to the lid's outline: the box's rim, or a round pool's wall.
  const boxRim = halfW.sub(p.x.abs()).min(halfH.sub(p.y.abs()));
  const roundRim = waterRimDistanceNode(u.shape, u.halfExtent, p.x.div(u.waveScale.x), p.y.div(u.waveScale.z)).mul(u.waveScale.x.min(u.waveScale.z));
  const toRim = select(u.shape.x.lessThan(.5), boxRim, roundRim).max(0);
  const rimContact = toRim.smoothstep(width.mul(.15), width).oneMinus();
  let contact = rimContact;
  if (sceneDepth) {
    // A texture node (the lid's per-target depth copy) or a raw texture.
    const depthSample = sceneDepth.isNode ? sceneDepth.sample(screenUV).x : texture(sceneDepth, screenUV).x;
    const behind = linearDepth(depthSample).sub(linearDepth());
    const metres = behind.mul(cameraFar.sub(cameraNear)).max(0);
    contact = metres.smoothstep(width.mul(.15), width).oneMinus().max(rimContact);
  }
  const amount = simulated.max(contact.mul(.9)).toVar();

  // Patchiness: a slow, large fractal modulates the amount by ±25 % so the
  // sheet's edge and the web's density vary along a crest rather than
  // following the solver's cells.
  const patch = fbm(p.mul(.55), clock, .6);
  const v = amount.mul(patch.mul(.5).add(.75)).clamp(0, 1).toVar();

  // ── THE WAKE: A SHEET, THEN PATCHES ALONG THE CURRENT, THEN FLECKS ────
  //
  // ⛔ NO LATTICE. The Worley network read as a Voronoi diagram twice ("the
  // foam patterns look quite weird"; "what do we do with those static foam
  // upon object falling the water?", 2026-09-07 — a five-metre lace mat
  // around a floating crate). A splash leaves a bright disc of foam that
  // the ring's current tears into ragged PATCHES stretched along the flow
  // — radial streaks from an impact, a trail behind a moving body — and
  // the last of it is flecks. The pattern rides the drift (`pw`), and its
  // stretch follows the flow's direction and speed where the flow texture
  // is read; still water leaves it isotropic.
  let dir = vec2(1, 0), speed = float(0);
  if (flow) {
    const t = vec2(positionLocal.x.sub(u.rippleCenter.x).div(u.rippleHalf.x.mul(2)).add(.5), positionLocal.z.sub(u.rippleCenter.y).div(u.rippleHalf.y.mul(2)).add(.5));
    const f = flow.sample(t.clamp(0, 1)).xy;
    const metres = vec2(f.x.mul(u.waveScale.x), f.y.mul(u.waveScale.z));
    speed = metres.length();
    dir = metres.div(speed.max(1e-3));
    dir = select(speed.greaterThan(1e-3), dir, vec2(1, 0));
  }
  const stretch = float(1).add(speed.smoothstep(0, .3).mul(3));
  const alongFlow = pw.dot(dir), acrossFlow = pw.y.mul(dir.x).sub(pw.x.mul(dir.y));
  const holes = fbm(pw.mul(5), clock, 1.7);
  const patches = fbm(vec2(alongFlow.div(stretch).mul(1.6), acrossFlow.mul(1.6)), clock, .6);
  const grain = fbm(pw.mul(6), clock, 2).mul(.9).add(.35);
  // The fresh sheet: bright, its edge eaten by holes.
  const sheet = v.sub(holes.mul(.35)).smoothstep(.5, .8);
  // Patches: where the stretched fractal falls under one and a half times
  // the value — most of a fresh patch, a fifth of a fading one.
  const torn = v.mul(1.5).sub(patches).div(.2).clamp(0, 1).mul(holes.mul(.6).add(.5));
  // The flecks of the last of it.
  const specks = fbm(pw.mul(11), clock, 1.5).smoothstep(.6, .78).mul(fbm(pw.mul(2.5), clock, .8).smoothstep(.4, .7));
  const speckMask = v.smoothstep(.015, .16);
  const wake = sheet.max(torn.mul(.85)).max(speckMask.mul(specks)).mul(grain.mul(.4).add(.7)).clamp(0, 1);
  if (!sea) return wake.mul(u.foam.smoothstep(0, .15));

  // ── THE WHITECAPS (2026-09-07) ──────────────────────────────────────
  //
  // A breaking crest is a ragged sheet that dissolves into STREAKS along the
  // wind and then into bubbles — never the wake's lattice, which at sea
  // scale read as lace over hundreds of metres. The memory (0–1, decaying
  // from the fold) is cut by a fractal stretched four to one along the wave
  // direction: fresh foam is a sheet with bubbles in it, older foam only
  // where the streaks run, and the last of it a few bubbles. The texture is
  // finer than a pixel past a few tens of metres, so it fades out with
  // distance and the mip-filtered COVERAGE takes over as a soft tone — the
  // horizon is a stipple, not a speckle.
  // The memory's values are SMALL (linear, at the ocean preset, harness
  // 2026-09-07: median .05, p90 .28, p99 .64 — the gate opens a little,
  // often, and decays). A SHEET above .3 (its edge eaten by the bubbles),
  // STREAKS where the stretched fractal falls under three times the value
  // (a tenth of the area at the median, nearly all of a fresh patch), the
  // bubbles' own texture over both — with holes, or under a sun the foam
  // clips to a flat white. (Distance fades written as 1 − smoothstep: the
  // reversed-edge form is undefined in GLSL and not worth a doubt in WGSL.)
  // Streaks run along the wind — or along the CURRENT when there is one: a
  // hull's tail streams downstream.
  // ⛔ THE MAP IS THE FOAM. No fractal on top of it: a noise sampled at the
  // world position stays put while the particles stream with the current,
  // and an animated one flickers ("a noise pattern that does not move with
  // it", user, 2026-09-07). What the eye sees is the particles themselves —
  // specks, streaks, lace, holes — the paper's picture. A soft threshold
  // keeps a Gaussian's faint tail from greying the water; far away the
  // mip-filtered coverage is the tone. The ripple field's foam is not drawn
  // here any more: it is a SOURCE for the particles (gridSimulation.js
  // `spectrum.ripple`), so a wake and a crest share one motion.
  // ── SEA OF THIEVES' RECIPE (Ang et al., SIGGRAPH 2018) ────────────────
  // The MASK is where foam is: the particles' map (whitecaps, wakes, a
  // splash's returns, all riding the water) and the contact ring around
  // an intersecting object. The LOOK is a texture blended by the mask —
  // waterFoamTexture.js's lace, bubbles and patches — sampled in the
  // WATER'S OWN FRAME: the surface point's rest position (the pixel's
  // world position less the sea's horizontal displacement there) plus the
  // sea's scroll, so the lace rides the current and the orbital motion
  // with the foam it dresses instead of standing still under it. The mask
  // DISSOLVES the texture: a faint mask keeps only the brightest walls (a
  // thin lace), a strong one nearly everything (a sheet with bubble holes).
  const detail = texture(foamDetailTexture());
  const rest = spectrum ? p.sub(seaDisplacementAt(spectrum, p).xz).add(spectrum.uniforms.scroll) : p;
  // ⚠ NO CELL FINER THAN A FEW CENTIMETRES: sampled at 0.35–0.55 m tiles
  // the texture's finest cells were 7 mm, under a pixel a few metres out,
  // and every motion of the mask across them shimmered ("flickery",
  // user, 2026-09-07). The tiles are 4.5 / 1.3 / 1.6 m now (cells of
  // 50 / 5 / 3 cm) and the dissolve's feather is wider.
  // ⚠ THE LACE RIDES THE FLUID TOO. The particles move with the sea, the
  // current AND the fluid's swirl (waterFoamFlow.js); the rest frame
  // carries the first two, so the mask slid across the lace at the swirl's
  // speed and the dissolve's edge shimmered ("still flickering", user,
  // 2026-09-07). A FLOW MAP: two lace samples advected by the swirl over a
  // three-second period, half a period apart, cross-faded — the standard
  // trick (Crest, Unreal) for a texture that must follow a flow field.
  const swirlRaw = spectrum?.flow ? spectrum.flow.at(p) : vec2(0), swirlSpeed = swirlRaw.length();
  const swirl = swirlRaw.mul(swirlSpeed.min(.6).div(swirlSpeed.max(1e-3)));   // the lace follows gentle swirls only
  const PERIOD = 4;
  const phaseA = time.div(PERIOD).fract(), phaseB = time.div(PERIOD).add(.5).fract();
  const restA = rest.sub(swirl.mul(phaseA.sub(.5).mul(PERIOD))), restB = rest.sub(swirl.mul(phaseB.sub(.5).mul(PERIOD)));
  const weightA = phaseA.mul(2).sub(1).abs().oneMinus(), weightB = phaseB.mul(2).sub(1).abs().oneMinus();
  const flowSample = (scale, offset, channel) => detail.sample(restA.div(scale).add(offset))[channel].mul(weightA)
    .add(detail.sample(restB.div(scale).add(offset))[channel].mul(weightB)).div(weightA.add(weightB).max(1e-3));
  const laceA = flowSample(4.5, vec2(0, 0), "x"), laceB = flowSample(1.3, vec2(.37, .61), "x");
  const bubbles = flowSample(1.6, vec2(.13, .71), "y");
  const foamPatch = detail.sample(rest.div(9)).z;
  // The contact ring follows the foam dial too (a third at 0, all at 1).
  const mask = sea.max(contact.mul(.85).mul(u.foam.mul(.7).add(.3))).mul(foamPatch.mul(.8).add(.6)).clamp(0, 1);
  const foamGrain = mix(laceA, laceB, .5).mul(bubbles.mul(.35).add(.75));
  const threshold = mask.oneMinus();
  const realistic = foamGrain.smoothstep(threshold.sub(.25), threshold.add(.25));
  // STYLIZED (the water's other mode): Sea of Thieves' own look — the soft,
  // dispersed mask with a coarse lace bite, hard-edged and flat.
  const stylized = mask.mul(laceA.mul(.5).add(.75)).smoothstep(.3, .45);
  const dressed = mix(realistic, stylized, u.stylized);
  // Far away the texture's mips average to a tone; the mask's own coverage
  // (the map's mips) is what the eye sees there.
  const metres = positionWorld.sub(cameraPosition).length();
  const far = mask.smoothstep(.03, .4).mul(.6);
  const whitecap = mix(dressed, far, metres.smoothstep(80, 300));
  void wake;
  return whitecap.mul(u.foam.smoothstep(0, .15));
}

/**
 * ══ SUBSURFACE SCATTERING — THE GLOW THROUGH A CREST ═══════════════════════
 *
 * Looking toward the sun through the thin water at the top of a wave, light that
 * entered the far side scatters out toward the eye and the crest lights up from
 * within. One dot product, and it is the cue that most separates water from a
 * polished surface.
 */
/** The sea's raw whitecap value at the pixel (memory ∨ instantaneous gate) — a probe. */
export function seaFoamValueNode(u, spectrum) {
  if (!spectrum) return float(0);
  return Fn(() => {
    const p = worldXZ(u);
    return seaFoamWindowNode(spectrum, p).min(1);
  })();
}
/** Where on its wave a point sits: 0 in the trough, 1 on the crest — IN
 *  METRES (a lid's local units times its scale against the authored heights;
 *  on a lid scaled by three the raw ratio saturated and every swell became a
 *  hard-edged green sheet, 2026-09-06). Only a sea with real waves has thin
 *  crests: the term fades in between 10 and 50 cm of wave height, so a pool's
 *  ripples never turn green. */
function crestNode(u) {
  const range = u.waveHeight.add(u.amplitude).max(.001);
  const height = positionLocal.y.mul(u.waveScale.y);
  return height.div(range).mul(.5).add(.5).clamp(0, 1).mul(range.smoothstep(.1, .5));
}
/**
 * ⭐ THE COLOUR GRADIENT ON THE WATER ITSELF. Thin water at a crest absorbs
 * less and scatters more toward the eye than the deep body in a trough — the
 * real sea is lighter and greener along its crests ("you see color gradients
 * on the water itself, subsurface scattering, which we lack", user,
 * 2026-09-07). A multiplier on the transmitted radiance: ×1 in the trough,
 * brighter and toward green at the crest.
 */
export function waterCrestGradientNode(u) {
  return mix(vec3(1), vec3(.8, 1.4, 1.25), crestNode(u).smoothstep(.35, 1));
}
export function waterSubsurfaceNode(u, source) {
  // `source` is the water slot (its `uniforms.toSun` / `uniforms.scatter`)
  // or, with underwater off and no slot, the look's own { toSun, scatter }
  // uniforms — the gradients are the surface's, not the medium's ("we lost
  // surface colour gradients … no subsurface scattering", user, 2026-09-07).
  const toEye = cameraPosition.sub(positionWorld).normalize();
  const toSun = vec3(source.uniforms?.toSun ?? source.toSun);
  // Light that entered the far side of a crest and scatters out toward the
  // eye — strongest looking toward the sun through the wave (the demo's
  // distorted back-light), never quite absent — in the colour thin water
  // hands on: the in-scatter colour pushed toward a bright teal, not the
  // body's own dark blue, which glowed invisibly against itself.
  const backlit = toEye.dot(toSun.negate().add(normalWorld.mul(.3)).normalize()).max(0).pow(4);
  const crest = crestNode(u).smoothstep(.5, 1).pow(1.5);
  const tint = vec3(.5, 1.7, 1.3);
  return vec3(source.uniforms?.scatter ?? source.scatter).mul(tint).mul(crest).mul(backlit.mul(1.2).add(.25));
}

/** Kept for the surface smoke, which asserts crest foam exists at all. */
export function waterCrestFoamNode(u) { return waterFoamNode(u); }
