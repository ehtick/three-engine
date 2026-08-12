// SPLIT RADIANCE CASCADES — the GISystem entry point.
//
// Plan §7: "GISystem grows one `backend === "split-rc"` branch that early-outs
// into `srcSystem`, not tentacles." This is that early-out. Everything SRC
// needs from the engine arrives through the four arguments below; everything
// GISystem needs from SRC is on the returned object. Neither knows anything
// else about the other, which is the only reason the Phase-2/3 work can grow
// underneath this without turning into a sweep through a 7,000-line file.
//
// ══ ON BY DEFAULT SINCE PHASE 5 LANDED (user decision, 2026-08-11) ═════════
//
// `__giSrcProbes` defaulted OFF through Phases 1–4 because the population
// produced no light — the transport deposited zeros, so on-by-default would
// have cost GPU time for nothing and made every §12 number incomparable. That
// rationale died with Phase 5: hit shading is landed and wired (§12.28–§12.29),
// SRC is the ONLY diffuse-indirect term this module has (§12.8 deleted the
// dense cascades), so off-by-default meant every project shipped with no bounce
// unless someone typed a console flag before boot.
//
// `__giSrcProbes = false` is the EXPLICIT opt-out (R12: the hatch is a flag,
// not a rebuild) — it is what a harness pins to measure the legacy-only screen
// chain, and any comparison against numbers recorded before this flip must pin
// it. `smoke:gi-gpu`'s non-src arms and the emitter-shadow probe do exactly
// that.
//
// ══ THE ANCHOR, WHICH IS THE ONE THING HERE THAT IS NOT OBVIOUS ════════════
//
// Probe keys carry cell coordinates in 9 bits per axis, RELATIVE to a lattice
// anchor. At LOD 0 that window is ±256·s₀ — about ±128 m at the default s₀ —
// so an anchor pinned at the world origin makes every near-camera probe
// unrepresentable the moment the player walks 130 m away. `packProbeKey`
// returns EMPTY there, which is correct and silent: GI simply stops having
// probes, and the symptom is a scene that lights fine at spawn and goes flat
// after a walk.
//
// So the anchor follows the camera — but NOT per frame. Re-anchoring re-keys
// every probe, which retires every probe, which is precisely the binary
// per-frame flip R1 forbids. It happens when the camera has drifted past
// `REANCHOR_CHEBYSHEV` (64·s₀, comfortably inside the 254·s₀ the window
// actually allows) and not before.
//
// One property makes this cheap, and it is worth stating because it is not
// obvious from the code: `latticeOrigin(anchor, s) = round(anchor/s)·s` is
// ALWAYS a multiple of s, so every lattice is world-aligned regardless of where
// the anchor sits. **Re-anchoring never moves a probe.** It only renumbers it.
// The cost is a lost temporal history, not a spatial pop.
//
// docs/GI_SRC_REBUILD_PLAN.md §4.1, §4.2, §7 Phase 1.

import * as THREE from "three/webgpu";
import { float, ivec2, step, texture, uint, uniform, vec3 } from "three/tsl";
import {
  ALPHA_TRACK_HOLD_MS, CASCADE_COUNT, COLD_GUARD_FRAMES, GOV_HI, GOV_LO, MAX_LODS,
  PROBE_RAY_CAP_OFF, SRC_QUALITY, SUM_SHIFT, SURPRISE_ONE, TEMPORAL_ALPHA,
  TEMPORAL_ALPHA_STILL, W0, srcProbeRayCap, srcQualityTier, srcTransportRays,
} from "./srcConfig.js";
import { createSrcProbeGizmos } from "./srcGizmos.js";
import { R2_ALPHA1_FX, R2_ALPHA2_FX } from "./srcMath.js";
import {
  createSrcHashBlockFrame,
  createSrcProbeFrame,
  createSrcProbeStore,
  formatSrcProbeStats,
  readSrcProbeStats,
} from "./srcProbes.js";
import {
  DEPOSIT_SCALE, createSrcBinStore, createSrcDepositFrame, createSrcShadeCounters,
} from "./srcDeposit.js";
import { createSrcHitShader } from "./srcShade.js";
import { createSrcMergeFrame, formatSrcMerge } from "./srcMerge.js";
import { createSrcSecondaryFrame, formatSrcSecondary } from "./srcSecondary.js";
import { createSrcScreenGather, formatSrcGather } from "./srcScreenGather.js";
import { createSrcTileAtlas, formatSrcTiles } from "./srcTiles.js";
import { createSrcRayFrame, createSrcRayStore } from "./srcRays.js";
import { createSrcSceneTrace, createSrcVisibility, ifMoverHit, moverSurfaceAt } from "./srcTrace.js";

/** Camera drift, in units of s₀, that triggers a re-anchor. */
const REANCHOR_CHEBYSHEV = 64;
/** The anchor snaps to multiples of this many s₀, so it moves in whole steps. */
const ANCHOR_QUANTUM = 16;
/** Per-frame camera deltas that count as "panning" for the §12.45.2 cap lift:
 *  5 mm translation, 0.1° rotation — above orbit-damping jitter, below any
 *  deliberate pan. */
const CAM_LIFT_POS = 0.005;
const CAM_LIFT_ROT = 0.0017;

/** Is the SRC probe population compiled into this build? ON unless explicitly
 *  opted out — see the header. `__giSrcProbes = false` is the hatch. */
export function srcProbesEnabled() {
  return globalThis.__giSrcProbes !== false;
}

/**
 * Is SRC HIT SHADING on? The single source of truth for it, because the flag is
 * read in two places that must not disagree: here, to build the shader, and in
 * `GISystem`'s field construction, to allocate the surface attribution region
 * the shader reads. A field built without the region and a shader built
 * expecting one is a throw at best and a grey world at worst, and they are
 * separated by a full rebuild — so they read one function.
 *
 * ⚠ **IT FOLLOWS `__giSrcProbes`, AND THAT IS A FIX, NOT A CONVENIENCE.**
 *
 * These were two independent opt-ins, and one of the four combinations —
 * probes ON, shading OFF — RENDERS A BLACK SCENE. Not dimmer: the eye check
 * measures 4.0% of pixels lit against 68.2% with shading on (§12.30.1).
 *
 * It is nobody's bug. `createGiResolve` takes SRC's screen gather as the
 * PRIMARY diffuse term and switches the legacy closure off against it
 * (`if (gather && !screenGather)`, giScreen.js) because since [I] the two are
 * the same integral and running both would add a pixel's irradiance to itself.
 * So turning probes on REPLACES the working diffuse term with SRC's — and
 * before Phase 5, SRC's carried sky only. The renderer is behaving perfectly
 * and the screen is black.
 *
 * That state cost a full day: the black frame was read as a broken transport
 * and chased through `maxL`, step budgets, attribution and the shadow bias,
 * none of which were wrong. A flag combination that is guaranteed-black is not
 * a diagnostic state worth preserving by default, so shading is on whenever
 * probes are. `__giSrcShade = false` stays as the EXPLICIT opt-out the sky-only
 * gates still need — the difference is that you now have to ask for it.
 */
export function srcShadeEnabled() {
  if (globalThis.__giSrcShade === false) return false;
  return globalThis.__giSrcShade === true || srcProbesEnabled();
}

/**
 * Expected live c0 probes, from the gbuffer's pixel count.
 *
 * A c0 probe is a unique visible SURFACE CELL, so the count is bounded by
 * pixels but is nowhere near them — the population gate measures 410 probes for
 * 4,687 pixels on a room-plus-shells set, and the paper's own figure is 30–80k
 * for a 1080p frame. A quarter of the pixel count is comfortably above both and
 * is what the ≤0.5 hash load factor is then derived from; the telemetry prints
 * the real load every frame, so a scene that disagrees says so rather than
 * quietly dropping inserts.
 */
function expectedC0Probes(pixelCount) {
  return Math.min(131072, Math.max(16384, 1 << Math.ceil(Math.log2(Math.max(1, pixelCount / 4)))));
}

/**
 * Build the SRC probe population bound to one gbuffer.
 *
 * @param {object} options
 * @param {object} options.gbuffer  from `createGiGBuffer` — `position` is
 *   `vec4(worldPos, 1)` at full float, and its `w` IS the validity bit the
 *   resolve already keys off. Nothing new is rendered for SRC (plan §7:
 *   "Reuses gbuffer").
 * @param {number} options.width  gbuffer width — the resolve's half-res, not the
 *   viewport's
 * @param {number} options.height
 * @param {object} [options.props]  the component props, for the quality tier
 * @param {object} [options.volume]  `createSrcVolume`'s bundle. OPTIONAL, and
 *   the population is fully functional without it — it buys exactly one thing,
 *   the scaffold ray pass below, which needs `occupancyField` + `world` and is
 *   the only part of SRC that touches the medium so far. The standalone gate
 *   pages have no engine and therefore no volume; they build the frame and
 *   nothing else, which is what keeps them standalone.
 * @param {object} [options.lighting]  `{ sun, emitters }` for hit shading —
 *   `sun` is `{direction, irradiance}` (direction TOWARD the light), `emitters`
 *   is `giLight.js`'s slot array. Phase 5. See `shadeHit` below for why this and
 *   `staticSurfaceAt` are two arguments rather than one switch.
 * @param {object} [options.surfaces]  `srcSurface.js`'s bundle — `{surfaceAt,
 *   passes, sync}`. The whole bundle rather than the read closure alone, because
 *   the attribution owns a compute pass (the palette upload) that must run
 *   BEFORE the deposit reads it, and a `sync` that makes a material recolour a
 *   512-entry buffer write instead of a re-voxelize. Movers need none of it;
 *   they carry their surface in their own object header.
 */
export function createSrcProbeSystem({
  gbuffer, width, height, props = null, volume = null, sky = null,
  lighting = null, surfaces = null, sceneMotion = null, trackMotion = null,
} = {}) {
  const tier = SRC_QUALITY[srcQualityTier(props)];
  const spacing0 = Number(globalThis.__giSrcSpacing0) || tier.spacing0;
  const pixelCount = width * height;

  const store = createSrcProbeStore({
    c0Probes: expectedC0Probes(pixelCount),
    cascadeCount: CASCADE_COUNT,
    w0: W0,
    // The bin block pool is sized from here, so the A/B dial for GI's largest
    // allocation lives next to the other two (`__giSrcSpacing0`, `__giSrcLmax`).
    // In bins, not bytes — the byte count is srcDeposit's layout to know.
    binBudget: Number(globalThis.__giSrcBinBudget) || undefined,
  });

  const cameraU = uniform(new THREE.Vector3());
  const anchorU = uniform(new THREE.Vector3());
  // Size in a uniform so a resize is a uniform write for the texel decode. The
  // DISPATCH counts are baked into the compute nodes, so a resize still rebuilds
  // the frame — see `setSize` on the returned object.
  const widthU = uniform(width, "uint");
  const positionNode = texture(gbuffer.position);
  const normalNode = texture(gbuffer.normal);

  /** Texel coords for a linear pixel index — the one decode both readers use. */
  const texelOf = (i) => ivec2(i.mod(widthU).toInt(), i.div(widthU).toInt());
  // ── THE GATHER'S OWN GRID ─────────────────────────────────────────────────
  //
  // `SRC_GATHER_SCALE` is a divisor on the gather's resolution only — see the
  // call site for why this is not `resolveScale`. Its thread `i` indexes a
  // gatherWidth × gatherHeight grid, so it needs a map into the FULL-res
  // gbuffer; `readPixel` decodes against `widthU` and would otherwise read a
  // pixel `SRC_GATHER_SCALE`× too far left on a row `SRC_GATHER_SCALE`× too far
  // up — a plausible image, subtly sheared, of a scene that is not there.
  //
  // The multipliers are JS constants, not uniforms, and that is safe for the
  // reason `setSize` already documents: the dispatch counts are baked into the
  // compute nodes, so a resolution change rebuilds this whole frame anyway.
  // ⚠ **1, NOT 2, AND THE 2 WAS MEASURED BEFORE IT WAS BACKED OUT.**
  //
  // At 2 this is worth ~5.6 ms on the user's editor (gather 7.55 → ~1.9 ms) and
  // it works — no validation errors, no page errors, the chain drops. What it
  // also does is bleed irradiance ACROSS SILHOUETTES, and that is visible on a
  // real object rather than theoretical: a box in the Sponza nave renders pure
  // black with sharp edges at 1:1 and soft mid-grey at 2:1, having picked up its
  // neighbours' light. The control that settles it is a shot taken BEFORE this
  // code existed — `resolveScale 0.5`, full-res gather — which shows the SAME
  // grey box. So the artifact belongs to a coarse irradiance carrier in
  // general, this change reproduces it faithfully, and it is not a mapping bug.
  //
  // The engine already knows the answer: `giConfig.js` says the resolve→screen
  // step upsamples through "the position-validated bilateral", which is exactly
  // the filter this gather→resolve step lacks. Shipping 2 without it would be
  // trading a measured 5.6 ms for light leaking onto every silhouette — the
  // same class of artifact ultra's `resolveScale: 1` is chosen to avoid, which
  // would make it a strange thing to introduce while defending that flag
  // (§12.34).
  //
  // So the plumbing lands and the scale does not. At 1 the UV sample in
  // giScreen returns exactly what `load(coord)` did (texel centres, 1:1), the
  // gather grid equals the resolve grid, and nothing about the image moves.
  // Raising this to 2 is a one-token change once the bilateral exists, and the
  // 5.6 ms is already priced.
  const SRC_GATHER_SCALE = 1;
  const gatherWidth = Math.max(1, Math.ceil(width / SRC_GATHER_SCALE));
  const gatherHeight = Math.max(1, Math.ceil(height / SRC_GATHER_SCALE));
  const gatherReadPixel = (i) => readPixel(
    i.div(uint(gatherWidth)).mul(uint(SRC_GATHER_SCALE * width))
      .add(i.mod(uint(gatherWidth)).mul(uint(SRC_GATHER_SCALE))),
  );
  const readPixel = (i) => {
    const t = texelOf(i);
    const g0 = positionNode.load(t).toVar();
    // ══ `position.w > 0.5` IS NOT SUFFICIENT, MEASURED ═══════════════════════
    //
    // It is the gbuffer's own "geometry here" mark and it is what
    // `createGiResolve` tests, so the first version of this used it alone. On
    // the smoke scene that admitted **8,809 of 19,200 pixels (46%)** which have
    // no geometry at all: their position is the origin and their NORMAL IS
    // ZERO. Every one of them inserted a probe at the world origin, was handed
    // a ray budget, fired a hemisphere of rays around `normalize(0)` = NaN, and
    // then gathered nothing — the failure presented as "GI is patchy" and took
    // three wrong hypotheses (probe density, back-facing normals, hemisphere
    // coverage) before a bad-normal counter named it in one run.
    //
    // A pixel with no normal cannot be shaded and cannot define a hemisphere,
    // so it is not a pixel GI covers. Testing BOTH channels here rather than in
    // each consumer is the point: one definition of "this pixel is real", which
    // the population, the ray budget, the deposit and the gather all inherit.
    const nrm = normalNode.load(t).xyz.toVar();
    // ── FACE FORWARD TOWARD THE CAMERA, HERE AND NOWHERE ELSE ─────────────
    //
    // The same flip `createGiResolve` and `giLight` apply: a double-sided wall
    // seen from inside a room has a normal pointing OUT, and firing a
    // hemisphere of rays into that direction samples the outside of the room.
    //
    // It lives at the ENGINE BOUNDARY rather than in the kernels, and that
    // placement is the point. It is a gbuffer fact, not an algorithm property —
    // `srcRef.js`'s `traceAndDeposit` takes the normal it is handed. Putting it
    // in the deposit kernel made the GPU and the mirror disagree about 28% of
    // bins in one run of `test:gi-src-deposit`, which is exactly the kind of
    // divergence a second definition produces. Here, the deposit's ray
    // hemisphere and the gather's query hemisphere are the same vector by
    // construction — and a flip on one side only would have each read the half
    // of the bin sphere the other never filled.
    const facing = step(0, nrm.dot(vec3(cameraU).sub(g0.xyz))).mul(2).sub(1).toVar();
    return {
      position: g0.xyz,
      valid: g0.w.greaterThan(0.5).and(nrm.dot(nrm).greaterThan(0.25)),
      normal: nrm.mul(facing),
    };
  };
  // `normal.w` is the MIRROR MASK, not a validity bit (giScreen's second pass
  // writes 1 there for reflective pixels) — read `.xyz` and let `position.w`
  // stay the single validity test.
  const readNormal = (i) => readPixel(i).normal;

  // ── THE TEMPORAL BLEND (plan §4.6) ────────────────────────────────────────
  //
  // `keep` is 1 − α, applied to every deposit accumulator before this frame's
  // rays land on top; `srcDeposit.js`'s header argues the placement. The frame
  // stamp goes to the probe frame AND the deposit frame as ONE node, because
  // its whole job is to let the decay recognize a block the compaction claimed
  // moments earlier — two counters that agreed most of the time would be worse
  // than none, since the disagreement shows up as a new probe wearing a dead
  // one's light rather than as anything that looks like a bug.
  //
  // `__giSrcAlpha` is the harness override, and `1` is single-frame mode. It is
  // POLLED PER FRAME (`syncCamera`), not read once at build, for a reason the
  // flicker instrument makes concrete: `run-gi-flicker-frame.mjs`'s own header
  // records that the SAME baseline config read 1.404 and 5.194 reversals/px in
  // two processes — a 3.7x spread, larger than any effect anyone has tried to
  // measure with it — so its numbers are only comparable WITHIN one page. An α
  // read at build time can only be A/B'd by reloading, which is exactly the
  // comparison that instrument forbids. Polling costs a global read per frame
  // and is the same convention `__giDebugView` runs under.
  // ── MOTION-ADAPTIVE α (§12.38) ────────────────────────────────────────────
  //
  // A still scene settles to TEMPORAL_ALPHA_STILL (the ALPHA_SWEEP measured
  // 3.75× fewer still-scene reversals there — srcConfig's table); any scene
  // motion ramps continuously back to TEMPORAL_ALPHA, so a moving light,
  // emitter or occluder gets exactly the adaptation every §12 measurement ran
  // at. `sceneMotion` is a NORMALIZED [0,1] getter supplied by GISystem (null
  // in every standalone gate, which therefore keep the flat TEMPORAL_ALPHA
  // they were written against). The hatch outranks the ramp: a forced
  // `__giSrcAlpha` is a forced α, else the flicker instrument could not pin
  // its arms.
  const readAlpha = () => {
    if (Number.isFinite(Number(globalThis.__giSrcAlpha))) {
      return Math.min(1, Math.max(0, Number(globalThis.__giSrcAlpha)));
    }
    if (!sceneMotion) return TEMPORAL_ALPHA;
    const m = Math.min(1, Math.max(0, Number(sceneMotion()) || 0));
    return TEMPORAL_ALPHA_STILL + m * (TEMPORAL_ALPHA - TEMPORAL_ALPHA_STILL);
  };
  const keepU = uniform(1 - readAlpha());
  // ── THE α COMPENSATION'S LIFT (§12.40.4) ──────────────────────────────────
  //
  // How much of the per-block influx compensation is SUSPENDED, derived from
  // the same α the motion signal produces: at the still floor the lift is 0
  // (full compensation — capped blocks keep proportionally more history and
  // the ray cap is variance-neutral), at the moving α it is 1 (no
  // compensation — the fast decay wins, which is both the responsiveness the
  // user asked for and the mechanism that retires stale bins; the deposit's
  // `influxLift` doc carries the rounding-fixed-point argument). Deriving
  // from α rather than from `sceneMotion` directly means a pinned
  // `__giSrcAlpha` pins the lift too — 0.05 IS "still", 0.1 IS "moving",
  // whoever says so — and gates with no motion getter (flat TEMPORAL_ALPHA)
  // get lift 1 = the exact pre-compensation decay they were written against.
  // `__giSrcAlphaComp = false` is the explicit opt-out, polled per frame like
  // every other hatch here.
  // Where α sits on the still→moving ramp, in [0,1]. Two consumers with
  // DIFFERENT opt-outs, so it is its own function: the compensation lift
  // (opted out by `__giSrcAlphaComp = false`) and the tracking root below
  // (opted out by `__giSrcMotionTrack = false`) — coupling them through one
  // switch would make "disable compensation" silently mean "always decay at
  // the tracking rate".
  const motionOf = (alpha) => {
    const span = TEMPORAL_ALPHA - TEMPORAL_ALPHA_STILL;
    if (!(span > 0)) return 1;
    return Math.min(1, Math.max(0, (alpha - TEMPORAL_ALPHA_STILL) / span));
  };
  const liftFor = (alpha) => (globalThis.__giSrcAlphaComp === false ? 1 : motionOf(alpha));
  const influxLiftU = uniform(liftFor(readAlpha()));
  // ── SURPRISE (srcConfig's SURPRISE block) ─────────────────────────────────
  //
  // Read ONCE, at build, unlike every other hatch here — because it decides
  // whether the bundles are PASSED, and a bundle is a set of nodes in a kernel
  // rather than a uniform. `false` builds the pre-surprise kernels byte for
  // byte, which is the only form of "off" that can back a bit-exactness claim.
  // The two live dials (`__giSrcSurpriseGain`, `__giSrcColdFill`) are polled
  // per frame like the rest, and gain 0 is the in-page A/B.
  const surpriseOn = globalThis.__giSrcSurprise !== false;
  // How much faster a fully surprised block decays: `keepFast = 1 − α_moving`
  // expressed as a multiplier on THIS frame's `1 − keep`. Never below 1 — the
  // mechanism may only ever forget faster, never slower, so a pinned α (where
  // `keep` is already the fast one) makes this exactly 1 and the mix a no-op.
  const surpriseFU = uniform(1);
  // The governor. One multiply, applied in the publish, reaching both consumers
  // through the word it writes — srcConfig's one-switch rule.
  const surpriseGainU = uniform(1);
  // [D1']'s exemption master switch, 0 for the COLD_GUARD_FRAMES after a build
  // or a re-anchor (when EVERY block is cold at once) and whenever the cap is
  // pinned by an instrument.
  const boostEnableU = uniform(0, "uint");
  let coldGuard = COLD_GUARD_FRAMES;
  // Starts at 1, not 0: an unclaimed block's stamp is 0, and a frame counter
  // that also started there would call every block in the pool fresh on frame
  // zero. Harmless in fact (an unclaimed block holds zeros, which zero to
  // zeros) and not worth relying on.
  const frameStampU = uniform(1, "uint");

  const frame = createSrcProbeFrame(store, {
    spacing0,
    camera: vec3(cameraU),
    anchor: vec3(anchorU),
    pixelCount,
    maxLods: MAX_LODS,
    readPixel,
    frameStamp: frameStampU,
  });

  // The gizmos share the SAME anchor uniform, not a copy. A gizmo lattice
  // drawn from a second anchor would look perfectly plausible and be in the
  // wrong place, which is the most misleading failure a debug view can have.
  const gizmos = createSrcProbeGizmos(store, { spacing0, anchor: vec3(anchorU) });

  // ── ALGORITHM 3 (plan §12.13.5 unit 2) ────────────────────────────────────
  //
  // Built UNCONDITIONALLY, unlike the scaffold trace below, because the budget
  // is not a diagnostic — it is the numbering every later phase's deposit is
  // addressed by, and unit 3 needs it whether or not a scaffold exists. It also
  // costs nothing to look at: `srcRays.js`'s passes are eight tiny dispatches
  // over the probe table, no marching.
  const rayStore = createSrcRayStore(store, { pixelCount });
  // ── THE RAY CEILING (srcConfig's `transportRays`) ─────────────────────────
  //
  // Uniforms, not build-time constants, so the ceiling is an A/B and a resize
  // is a uniform write rather than a rebuild (R11). `natural` is what this
  // resolution would fire unstrided — the number that was 3,146,400 on the
  // user's editor and 94% of a 260 ms SRC chain.
  const strideU = uniform(1, "uint");
  const phaseU = uniform(0, "uint");
  const naturalRays = pixelCount * tier.raysPerPixel;
  // ── THE CEILING IS POLLED PER FRAME, NOT READ AT BUILD ────────────────────
  //
  // Same rule `__giSrcAlpha` follows two dozen lines up, and for the reason
  // §12.23 wrote down: a build-time value can only be A/B'd by RELOADING, and a
  // reload is the comparison this module has repeatedly got wrong. The first
  // attempt to price this ceiling used one page per arm and the arms came back
  // at 315,952 and 499,720 transport pixels — the editor's viewport panel
  // settles to different sizes across loads, so the "hold the resolve, move
  // only the ceiling" sweep moved both. Polling makes the whole A/B happen
  // inside ONE page, one build, one viewport, which is the only version of it
  // that means anything.
  //
  // It is also free: `readCeiling` is a global read and a divide on the CPU,
  // once per frame, and the kernels see a uniform. Nothing rebuilds (R11).
  const readCeiling = () => srcTransportRays(srcQualityTier(props));
  // ── THE DISPATCH SIZE IS BAKED; THE STRIDE INSIDE IT IS NOT ───────────────
  //
  // three bakes `.compute(n)`, so the thread count cannot be a uniform. It is
  // therefore derived from the TIER's ceiling — a build-time constant — and NOT
  // from the resolution or from the live hatch. Two consequences, both wanted:
  // the transport's dispatch size is resolution-INDEPENDENT (a viewport resize
  // stops rebuilding these three passes), and `__giSrcTransportRays` can still
  // move the ceiling at runtime *within* that budget by changing the stride.
  //
  // A hatch set ABOVE the tier's ceiling therefore cannot buy more rays than
  // the baked thread count allows — it clamps. Said out loud because a probe
  // that raises the hatch and sees no change would otherwise read that as "the
  // ceiling does nothing".
  const transportThreads = Math.max(
    1,
    Math.ceil(SRC_QUALITY[srcQualityTier(props)].transportRays / Math.max(1, tier.raysPerPixel)),
  );
  // Two terms, and the `max` is what makes both directions of the hatch work.
  //
  //  `fill`  = floor(pixelCount / threads) — the stride that spreads the baked
  //            thread count across the WHOLE screen. `floor`, not `ceil`: the
  //            largest pixel touched is `(threads-1)·stride + phase`, which must
  //            stay under `pixelCount` for every `phase < stride`.
  //  `want`  = ceil(naturalRays / ceiling) — the stride the live ceiling asks
  //            for. TIGHTER than the tier's: threads run off the end and skip,
  //            which is how a runtime A/B buys fewer rays without a rebuild.
  //
  // Taking the max clamps a LOOSER hatch to the baked budget. Without it, a
  // ceiling above the tier's would produce a stride too small to reach the far
  // side of the screen and the transport would quietly sample a CROP — the top
  // strip lit, the rest dark, which reads as a GI bug rather than as a budget.
  const strideFor = (ceiling) => Math.max(
    1,
    Math.floor(pixelCount / transportThreads),
    Math.ceil(naturalRays / Math.max(1, ceiling)),
  );
  let rayCeiling = readCeiling();
  let rayStride = strideFor(rayCeiling);
  strideU.value = rayStride;
  // ── THE PER-PROBE RAY CAP (srcConfig's `probeRayCap`, §12.32.1 option 1) ──
  //
  // The ceiling bounds the FRAME and prices rays by screen coverage; the cap
  // bounds each PROBE, which is the thing actually being estimated. Measured
  // before building (SWEEP=histo, Sponza, high): the median c0 probe fires 8
  // rays/frame while the fattest fires 1,794 — so capping at the tier's B cuts
  // the traced set to 0.10–0.26× with every capped probe still receiving B
  // fresh rays EVERY frame. Same polling rule as the ceiling and α: a build
  // value can only be A/B'd by reloading, so `__giSrcProbeRayCap` is read per
  // frame and the kernels see a uniform.
  const readCap = () => srcProbeRayCap(srcQualityTier(props), tier.raysPerPixel);
  let probeRayCap = readCap();
  const capU = uniform(probeRayCap, "uint");
  // ⚠ A DERIVED NUMBER THAT NOTHING PRINTS IS A NUMBER PROBES WILL GUESS.
  // The ceiling A/B measured two arms 5.0x apart in flicker and the only way to
  // tell "5x more stable" from "refreshed 5x less often" was the stride ratio —
  // which no probe could read, because the boot line is emitted once at build
  // and the runtime hatch moves the stride silently afterwards. So publish it.
  const publishTransport = () => {
    globalThis.__giSrcTransport = {
      pixelCount,
      threads: transportThreads,
      naturalRays,
      ceiling: rayCeiling,
      stride: rayStride,
      // With a cap this is an UPPER BOUND, not the fired count — the real
      // total is per-probe-capped on the GPU and only `readStats().totalRays`
      // knows it. Kept under its old name because probes ratio it against the
      // ceiling; the cap field beside it says when it is a bound.
      tracedRays: Math.ceil(naturalRays / rayStride),
      probeRayCap,
    };
  };
  publishTransport();
  // ⚠ `createSrcRayFrame` IS CALLED BELOW THE BIN STORE, not here where the ray
  // store is built. The surprise publish reads the per-block statistics, and
  // those live in the bin store's `scratch` tail (R7 — [E] is at the portable
  // 8-buffer ceiling, so they could not have a buffer of their own). Order of
  // CONSTRUCTION only; the dispatch order in `passes` is unchanged.

  // ── [E] + [F]: THE SPLIT SCATTER AND THE RESOLVE (plan §12.13.5 unit 3) ──
  //
  // This replaced unit 1's scaffold ray pass, which existed only to give
  // `srcTrace.js` a caller and feed the ray-hit counters. It traces the same
  // rays through the same closure and additionally does something with the
  // answer; the scaffold's tallies live on inside the deposit's own `stats`,
  // because they were the only instrument on the traversal's step budgets.
  //
  // The R2 PHASE advances by the two plastic-constant increments each frame, so
  // frame f traces the sequence shifted by f points — which under temporal
  // accumulation is the coverage a single frame's R2 run cannot give on its own.
  // What it must NOT be is a float — §12.11.1.
  const jitterXU = uniform(0, "uint");
  const jitterYU = uniform(0, "uint");
  // The radiance the fixed-point accumulator saturates at. Live, because
  // §12.13.4 deliberately left clamp-vs-auto-exposure open, and the deposit
  // COUNTS its own clamps so the decision gets made from a measurement.
  const lmaxU = uniform(Number(globalThis.__giSrcLmax) || 16);

  // ── [E']: HIT SHADING (plan §7 Phase 5, §12.26) ───────────────────────────
  //
  // Gated on having something to shade WITH as well as a flag. `__giSrcShade`
  // off, or no `lighting`, or no `staticSurfaceAt`, and `shadeHit` stays null —
  // which keeps this build byte-identical and keeps every gate written before
  // Phase 5 comparable, exactly as `__giSrcProbes` does for the population.
  //
  // **THE TWO ARGUMENTS ARE NOT ONE SWITCH.** `staticSurfaceAt` is the other
  // half of Phase 5 and lives in `srcSurface.js`: §12.9 deleted the coarse
  // surface-attribution grid, so there is currently no path on the GPU from a
  // static hit to its material. Shading with `lighting` alone would light the
  // whole static world at one default albedo — a grey-box bounce that looks
  // plausible, is wrong everywhere, and would be read as a shader bug rather
  // than a missing input. `STAT_UNATTRIBUTED` counts it if it ever happens.
  //
  // DECIDED HERE, ABOVE THE BIN STORE, because [J]'s hit list is a REGION of
  // the store's `scratch` buffer (R7) and the store therefore has to be built
  // knowing whether the multibounce is on.
  const staticSurfaceAt = surfaces?.surfaceAt ?? null;
  const shadeEnabled = srcShadeEnabled() && !!lighting && !!staticSurfaceAt;
  // ── [J]'s GATE — DEFAULT ON, FROM THE TIER (§12.39) ───────────────────────
  //
  // It was opt-in (`__giSrcSecondary === true`) for exactly as long as [J] was
  // a LINE INSIDE THE DEPOSIT: inlining `gatherAt` into the hit shader took
  // that kernel from 58 kB to 323 kB of WGSL and its pipeline compile to 48
  // seconds, so multibounce cost every boot half a minute whether or not the
  // scene needed it. Now that [J] is its own ~20 kB dispatch (`srcSecondary.js`)
  // the deposit is within ~2% of the single-bounce build (`smoke:gi-gpu`
  // asserts it), so the reason for the opt-in is gone and the flag flips to an
  // OPT-OUT: `tier.secondary` is the low-tier one (low ships single-bounce) and
  // `__giSrcSecondary = false` is the R12 hatch that reproduces every pre-[J]
  // gate result.
  //
  // `shadeEnabled` is a HARD requirement, not a coincidence: the hit list is
  // filled by the hit shader's sink, so with no shader there are no entries and
  // [J] would be a dispatch over an always-empty list.
  //
  // `volume?.occupancyField` stands in for `tiles && gather && binStore` — each
  // of those is built if and only if the one before it was, and this decision
  // has to be made before the first of them exists.
  const secondaryOn = !!(volume?.occupancyField && shadeEnabled
    && tier.secondary !== false && globalThis.__giSrcSecondary !== false);
  // EXACTLY the rays this dispatch can fire, so the list can never overflow:
  // [E] runs `transportThreads` threads at `raysPerPixel` rays each, and one
  // ray produces at most one entry. `STAT_SEC_OVERFLOW` counts the bound being
  // wrong rather than trusting it.
  const secondaryCapacity = secondaryOn ? transportThreads * tier.raysPerPixel : 0;
  const binStore = volume?.occupancyField
    ? createSrcBinStore(store, { w0: W0, secondaryCapacity })
    : null;

  // ── ALGORITHM 3'S FRAME, now that the statistics have somewhere to live ───
  //
  // The surprise bundle needs the bin store, so this sits below it (see the
  // note at `publishTransport`). Both bundles are `null` without a bin store or
  // with `__giSrcSurprise = false`, and that is the byte-identical build.
  const surpriseBundle = surpriseOn && binStore
    ? {
        scratch: binStore.scratch,
        statBase: binStore.blockStatBase,
        keep: keepU,
        lift: influxLiftU,
        gain: surpriseGainU,
        frameStamp: frameStampU,
        // What ONE deposit adds to a block's weight sum. [E] shifts each
        // deposit by SUM_SHIFT before summing, so this is `DEPOSIT_SCALE`
        // through the same shift — the divisor that turns the weight sum back
        // into a deposit COUNT for the shot-noise term.
        rayWeight: DEPOSIT_SCALE >> SUM_SHIFT,
      }
    : null;
  const rayFrame = createSrcRayFrame(store, rayStore, {
    pixelProbe: frame.pixelProbe,
    raysPerPixel: tier.raysPerPixel,
    stride: strideU,
    phase: phaseU,
    threads: transportThreads,
    cap: capU,
    capBoost: surpriseBundle
      ? { frameStamp: frameStampU, boostEnable: boostEnableU, counters: store.counters }
      : null,
    surprise: surpriseBundle,
  });

  // ── [H]: THE IRRADIANCE TILES (plan §12.18.7 unit 4) ─────────────────────
  //
  // c0 only, and only because [G] runs before the bake each frame: a merged c0
  // bin carries the whole cascade chain's answer at the finest spacing the
  // hierarchy has, so tiles for cascades 1-3 would bake the same light more
  // coarsely and nothing would read them.
  //
  // CONSTRUCTED HERE — above the hit shader — since §12.39: [J] gathers this
  // atlas, and it is built between the shader and the deposit. Dispatch order
  // is the `passes` list below and is unchanged; at the moment [J] samples a
  // tile the atlas holds LAST frame's bake, which is exactly the temporal
  // feedback R4 models (§12.26.9).
  const tiles = binStore
    ? createSrcTileAtlas(store, binStore, {
        w0: W0,
        // The scene's own Sky Light, composited against a bin's RESIDUAL
        // transmittance — zero for every merged bin, so it only ever fires for
        // the orphans. Zero when a project never set it, which means this build
        // still renders exactly as it did.
        sky: sky ? vec3(sky) : vec3(0),
      })
    : null;

  // ── [I]: THE SCREEN GATHER (plan §12.18.7 unit 5) ────────────────────────
  //
  // Sparse-trilinear over the ≤8 nearest c0 probes, one filtered tile tap each,
  // blended across the LOD overlap. This is what removes the ~0.6 m rectangles
  // that every frame since §12.17 has had: `srcGather.js` (deleted with this
  // unit) assigned ONE probe per pixel with no interpolation, so the blocks
  // were the probe cells at the correct spacing and no probe density was ever
  // going to remove them.
  //
  // `hashBlockFrame` is what makes the closure affordable inside the resolve —
  // and since §12.39 its words ride `hashKeys`' TAIL, so the lookup is ONE
  // storage buffer: the price at which the deposit kernel (7 of 8 bindings)
  // can afford it too.
  const hashBlockFrame = tiles ? createSrcHashBlockFrame(store, 0) : null;
  const gather = tiles
    ? createSrcScreenGather(store, tiles, {
        lookup: hashBlockFrame.lookup,
        spacing0,
        camera: vec3(cameraU),
        // The SAME anchor the population, the gizmos and the merge use. A
        // gather that interpolates over a lattice placed from a second anchor
        // reads plausible light from the wrong probes.
        anchor: vec3(anchorU),
        // ── THE GATHER RUNS COARSER THAN THE RESOLVE ─────────────────────
        //
        // It is per-OUTPUT-pixel work — one probe-lattice interpolation per
        // screen pixel — and it measured **7.55 ms of a 34 ms SRC chain** on
        // the user's editor at 1,599,840 px, second only to the deposit. Unlike
        // the deposit it cannot be strided, because every output pixel needs a
        // value this frame; the only lever is producing fewer of them and
        // letting the resolve's UV sample upsample (giScreen).
        //
        // This is NOT `resolveScale`. Dropping that would take the AO/shadow
        // composite down with it, and its silhouette edges are the thing ultra
        // pays for. Irradiance is the smooth term — it is already a trilinear
        // interpolation over a ~0.35 m probe lattice, so a half-resolution
        // carrier is far below the frequency it can represent. Halving the
        // resolve is a visible change; halving THIS should not be, and
        // `probe:gi-src-cost` measures whether that holds rather than assuming.
        readPixel: gatherReadPixel,
        width: gatherWidth,
        height: gatherHeight,
        maxLods: MAX_LODS,
        w0: W0,
      })
    : null;

  // ── [J]: THE SECOND BOUNCE (plan §4.1 [J], §12.39) ───────────────────────
  //
  // Its own dispatch over the hit list [E] appends, gathering the SAME tile
  // atlas the screen does — see `srcSecondary.js`'s header for why it is a pass
  // rather than a line in the hit shader, why it costs three storage bindings,
  // and why it must run between [E] and [F]. Built here because it needs the
  // gather's inputs (`tiles`, the hash→block lookup) and the deposit needs to
  // know it exists.
  const secondary = secondaryOn && binStore
    ? createSrcSecondaryFrame(store, binStore, {
        tiles,
        lookup: hashBlockFrame.lookup,
        spacing0,
        // The same three uniforms the screen gather reads. A second camera or
        // anchor here would gather over a lattice placed differently from the
        // one [E] filled — plausible light from the wrong probes.
        camera: vec3(cameraU),
        anchor: vec3(anchorU),
        lmax: lmaxU,
        maxLods: MAX_LODS,
        w0: W0,
        capacity: secondaryCapacity,
      })
    : null;

  // ── [E']: THE HIT SHADER ITSELF ───────────────────────────────────────────
  //
  // `shadeEnabled` and `secondaryOn` are decided above the bin store (the hit
  // list is a region of it); this is only the construction.
  const shadeHit = shadeEnabled && binStore
    ? createSrcHitShader({
        // Provenance lives HERE and nowhere else — `srcShade.js` never asks
        // whether a hit moved. A mover-shaped `if` inside the shader is the
        // shape of the bug where a moving crate lights the room differently from
        // the identical static one beside it (§12.26.1).
        surfaceAt: (hit, dir) => {
          // ⚠ `srcSurface.js`'s signature is `(voxel, worldPos, normal)`, NOT
          // `(hit, dir)`. The first version of this call passed the hit record
          // straight through, and `vec3(hitRecord)` is a TSL type error a long
          // way from its cause — "Invalid parameter for the type vec3" pointing
          // at srcSurface, in a file that is correct.
          //
          // `voxel` is the level-0 cell the MARCHER found, which is why
          // `createSrcSceneTrace` passes it through rather than letting a
          // consumer re-derive it: `position` is lifted half a coarse cell along
          // the normal, so flooring it lands on the shell cell instead.
          //
          // The normal here is the RAW record normal, deliberately NOT the
          // face-forwarded one. The face retry steps INWARD along it to find the
          // cell the surface belongs to, so it needs the normal that points out
          // of the GEOMETRY — a normal flipped to oppose the ray would step the
          // wrong way on every back-face hit and silently attribute the cell
          // behind the wall.
          if (hit.voxel == null) {
            throw new Error(
              "srcSystem: the scene trace produced no `voxel`, so static hits have no " +
              "attribution key. `createSrcSceneTrace` passes it through from the marcher — " +
              "a trace built without it cannot shade a static surface",
            );
          }
          const s = staticSurfaceAt(hit.voxel, hit.exactPosition, hit.normal);
          const albedo = vec3(s.albedo).toVar();
          const emissive = vec3(s.emissive).toVar();
          const emitter = float(s.emitter).toVar();
          const valid = float(s.valid ?? 1).toVar();
          // A mover overwrites all four. Its emissive is ALREADY zeroed at bake
          // time when it was promoted to an analytic emitter slot
          // (`dynamicObjects`' `writeSurface`, `promoted ? 0 : k`), so it wants
          // no flag: the promotion set is the NEE set, and the surface it
          // publishes is the half of the handoff the ray path is meant to carry.
          ifMoverHit(hit.dynObj, () => {
            const m = moverSurfaceAt(volume.occupancyField, hit.dynObj);
            if (m) {
              albedo.assign(m.surface.albedo);
              emissive.assign(m.surface.emissive);
              emitter.assign(float(-1));
              valid.assign(float(1));
            }
          });
          return { position: hit.exactPosition, normal: hit.normal, albedo, emissive, emitter, valid };
        },
        sun: lighting.sun ?? null,
        lights: lighting.lights ?? [],
        emitters: lighting.emitters ?? [],
        maxRay: lighting.maxRay ?? null,
        // ── THE ISOLATION HATCH (R12/R14) ────────────────────────────────
        //
        // `__giSrcNoShadow` drops the visibility ray entirely, which separates
        // the two causes of a black frame that the tallies cannot tell apart:
        // "no light reaches the hit" (the lighting term is zero) from "every
        // hit is occluded" (the ray says so). With it on, `maxL` still zero
        // means the lighting; `maxL` nonzero means the visibility.
        visibility: globalThis.__giSrcNoShadow === true ? null : createSrcVisibility(volume.occupancyField, volume.world, {
          rayHitMode: volume.rayHitMode,
          // A shadow ray is SHORTER than a diffuse one by construction — it
          // stops at its source — so it does not inherit the 192 the primary
          // budget was measured to need. Its own number is owed a measurement on
          // a real scene; until then this is the marcher's own default.
          steps: Number(globalThis.__giSrcShadowSteps) || 64,
        }),
        voxelSize: volume.world.minCell,
        // NO `secondary` OPTION — [J] IS A PASS. The shader hands its hit,
        // normal and clamped ρ to the deposit's sink instead, and
        // `srcSecondary.js` finishes the expression in a kernel of its own. The
        // R4 ceiling that bounds the loop is still applied here, at the hit,
        // and it is the ρ the sink publishes.
        // One NEE sample, and it is not a quality dial yet. With importance =
        // contribution the one-sample estimator IS the exact sum (§12.26.5), so
        // every extra sample buys only visibility variance — and the tiers have
        // no measurement to set it from. `__giSrcNeeSamples` is the A/B until
        // one exists; stratification means 1 → 4 cuts the standard error 2.61×
        // where independent draws would give 2.00×.
        neeSamples: Math.max(1, Number(globalThis.__giSrcNeeSamples) || 1),
        count: createSrcShadeCounters(binStore),
      })
    : null;
  const deposit = binStore
    ? createSrcDepositFrame(store, binStore, {
        pixelProbe: frame.pixelProbe,
        pixelRayBase: rayStore.pixelRayBase,
        // [D5]'s winner worklist — [E] traces densely from it (§12.44); the
        // stride/phase uniforms below stay because the dispatch SIZE is still
        // the transport's and a live ceiling change must keep moving it.
        rayWork: rayStore.rayWork,
        pixelCount,
        raysPerPixel: tier.raysPerPixel,
        stride: strideU,
        phase: phaseU,
        threads: transportThreads,
        lmax: lmaxU,
        // Null unless [E'] above was built. With radiance zero, what survives
        // the resolve is transmittance, and a receiver lit by transmittance
        // alone against the sky is ambient occlusion. That is §7's "AO-like
        // short-range bounce", not a placeholder.
        shadeHit,
        // [J]'s hit list. Passed ONLY when the secondary pass exists, and that
        // is what keeps the opted-out kernel byte-identical to the pre-[J] one:
        // with this null, not a node of the capture or the append is built.
        secondary: secondary
          ? { base: binStore.hitListBase, capacity: secondaryCapacity }
          : null,
        trace: createSrcSceneTrace(volume.occupancyField, volume.world, {
          rayHitMode: volume.rayHitMode,
          // ── THE STEP BUDGET, MEASURED RATHER THAN INHERITED ──────────────
          //
          // `createSrcSceneTrace`'s 96 is the dense backend's number, and
          // srcTrace's own header warns that SRC's rays are LONGER than the
          // interval rays it was tuned for. It is: on the smoke scene the
          // legacy occupancy rung exhausts 274 times out of 19,200 rays at 96,
          // once at 128, and never at 192 or 256. The HIT RATE converges on the
          // same schedule (77.2% → 77.0% → 77.0%), which is the confirmation
          // that matters — an exhausted ray fails CLOSED from detail, so those
          // 274 were counting as hits.
          //
          // 192 rather than "as low as passes" because the budget is a LOOP
          // CEILING, not a cost: a ray that resolves in twenty steps pays twenty
          // whatever the bound is. The only thing a higher ceiling buys is that
          // the rays which would have given up finish instead. The plane rung
          // clears 96 on its own (0 exhaustions) — this is sized for the rung
          // that does not.
          //
          // Measured on an 8 m scene; `?raysteps=N` is the A/B, and a real scene
          // still owes a re-measurement.
          steps: Number(globalThis.__giSrcRaySteps) || 192,
          // Movers are IN. They are hit geometry for every other ray class in
          // this module (`composeFieldDynamics`), and a budget measured with
          // them excluded would be a budget for a medium nothing else traces.
          skipMovers: false,
          // The packed mover id costs the marcher its dynamic-object bookkeeping
          // on every ray, so it is asked for only when something reads it — and
          // the only reader is the hit shader's `surfaceAt`.
          wantDynObj: shadeEnabled,
        }),
        readPixel,
        readNormal,
        camera: vec3(cameraU),
        spacing0,
        jitterX: jitterXU,
        jitterY: jitterYU,
        keep: keepU,
        frameStamp: frameStampU,
        influxLift: influxLiftU,
        // The other half of the same bundle: [E] fills the per-block sums and
        // the decay reads the `u` word the publish wrote from them. Null and
        // neither node exists — see `createSrcDepositFrame`'s `surprise` doc.
        surprise: surpriseBundle
          ? { statBase: binStore.blockStatBase, surpriseF: surpriseFU }
          : null,
        maxLods: MAX_LODS,
      })
    : null;

  // ── [G]: THE MERGE (plan §12.18.7 unit 3) ────────────────────────────────
  //
  // Cascade 3 → 0, in place over the resolved payload. This is what turns a
  // one-metre answer into a whole-reach one: before it, a c0 bin knew only
  // about cascade 0's interval; after it, the same bin carries the product of
  // transmittance and the sum of radiance along the entire cascade chain.
  //
  // The SKY IS ITS PARENT AT THE TOP and nowhere else — a per-cascade sky
  // deposit would multiply it by the cascade count.
  const merge = binStore
    ? createSrcMergeFrame(store, binStore, {
        spacing0,
        // The SAME anchor uniform the population and the gizmos use. A merge
        // that interpolates over a lattice placed from a second anchor produces
        // plausible light in the wrong place, and no energy check can see it.
        anchor: vec3(anchorU),
        sky: sky ? vec3(sky) : vec3(0),
        w0: W0,
      })
    : null;

  // ([H]'s tile atlas, [I]'s gather and the hash→block frame are CONSTRUCTED
  // above the hit shader now — [J] needs the atlas and the lookup at build
  // time. Their DISPATCH position is unchanged; the `passes` list below is the
  // frame order, and construction order never was.)

  let anchored = false;
  let reanchors = 0;
  const scratch = new THREE.Vector3();
  // Camera-pan lift state (§12.45.2). Thresholds are per-FRAME deltas chosen
  // above orbit-damping jitter and below any deliberate pan: 5 mm translation,
  // 0.1° rotation. Frame-rate dependence only widens the margin (slower frames
  // → larger deltas).
  const camPrevPos = new THREE.Vector3();
  const camPrevQ = new THREE.Quaternion();
  const camScratchQ = new THREE.Quaternion();
  let camSeen = false;
  let camHoldUntil = 0;

  const system = {
    store,
    frame,
    gizmos,
    rayStore,
    rayFrame,
    binStore,
    deposit,
    /** [J], or null when the tier or the hatch turned the second bounce off. */
    secondary,
    merge,
    tiles,
    hashBlockFrame,
    gather,
    spacing0,
    raysPerPixel: tier.raysPerPixel,
    // ONE dispatch list, in dependency order: population → budget → trace and
    // scatter → resolve → merge → gather. Each stage reads what the previous one
    // wrote (`pixelProbe`, then `pixelRayBase`, then the bin accumulators, then
    // the resolved payload), and every gap between two entries is the barrier
    // that makes that legal. A different order would spend this frame's rays
    // against last frame's membership, which is the kind of one-frame skew that
    // reads as noise rather than as a bug.
    //
    // THE MERGE'S OWN INTERNAL ORDER IS ALSO LOAD-BEARING and lives inside its
    // pass list: cascade c reads the region cascade c+1 wrote one dispatch ago,
    // so the ladder is only correct top-down and only because these are separate
    // dispatches (srcMerge.js's header).
    passes: deposit
      ? [
          // The attribution palette FIRST: the deposit's `shadeHit` reads it, and
          // a palette written after the rays that sample it is a frame of stale
          // colour on every material edit.
          ...(shadeEnabled ? surfaces?.passes ?? [] : []),
          ...frame.passes,
          // ⚠ `hashBlock` MOVED UP for [J] (§12.39), and the move is
          // correctness, not taste. The hash slot LAYOUT is rebuilt every
          // frame by [K] with scheduler-dependent contention, so a key's slot
          // index does not survive the rebuild — a tail written at the END of
          // last frame is misaligned with THIS frame's keys the moment the
          // population runs. The deposit's secondary term looks keys up
          // per hit, so the words must be republished after compaction and
          // BEFORE the first ray. Both inputs are settled by then (`hashSlot`
          // and `PROBE_BLOCK` are compaction's outputs), and neither changes
          // again within the frame, so the gather far below reads the same
          // truth it always did.
          hashBlockFrame.pass,
          ...rayFrame.passes,
          // ── [J] SITS BETWEEN [E] AND [F], AND BOTH SIDES ARE FORCED ───────
          //
          // AFTER [E]: the hit list does not exist until the scatter writes it.
          // BEFORE [F]: the resolve reads the accumulators once, so a bounce
          // deposited after it is a frame late — and worse than late, because
          // an entry's bin slot expires with the frame ([C] re-claims blocks
          // every frame, so the slot is only valid inside the frame that
          // produced it). The atlas [J] samples is still LAST frame's bake
          // ([H] runs below), which is the temporal fixed point R4 models.
          //
          // `hashBlockFrame.pass` does NOT move for this: it already runs
          // before the first ray, for the reason above it, and that is exactly
          // where [J]'s corner lookups need it.
          ...(secondary
            ? [deposit.decay, deposit.scatter, secondary.pass, deposit.resolve]
            : deposit.passes),
          ...merge.passes, ...tiles.passes,
          gather.reset, gather.compute,
        ]
      : [...frame.passes, ...rayFrame.passes],
    // ── WHO OWNS THE FRAME ──────────────────────────────────────────────────
    //
    // Group boundaries, in the SAME order as `passes`, so `profile.giPasses`
    // can attribute the chain instead of reporting one sum. It reported one
    // sum on the grounds that "the interesting question is what the chain
    // costs, not which of two clears is slower" — true when this was fourteen
    // tiny dispatches, and false at 44 dispatches costing 91ms on the user's
    // Sponza, which is ~50x the entire screen-pass total. A cost with no owner
    // is a cost nobody can act on.
    //
    // Counts are derived from the same arrays spread above, so the two cannot
    // drift without the assert in `profile.giPasses` firing.
    passGroups: deposit
      ? [
          { label: "surfaces (attribution palette)", count: (shadeEnabled ? surfaces?.passes ?? [] : []).length },
          { label: "populate", count: frame.passes.length },
          { label: "hashBlock", count: 1 },
          { label: "rays", count: rayFrame.passes.length },
          // SPLIT AROUND [J] when it runs, because "the deposit" is no longer
          // three contiguous dispatches — and `profile.giPasses` asserts these
          // counts sum to `passes.length`, so a group list that did not split
          // would withhold every per-group number rather than mislabel one.
          ...(secondary
            ? [
                { label: "deposit (decay + trace + shade)", count: 2 },
                { label: "secondary [J]", count: 1 },
                { label: "deposit (resolve)", count: 1 },
              ]
            : [{ label: "deposit (trace + shade)", count: deposit.passes.length }]),
          { label: "merge", count: merge.passes.length },
          { label: "tiles", count: tiles.passes.length },
          { label: "gather", count: 2 },
        ].filter((g) => g.count > 0)
      : [
          { label: "populate", count: frame.passes.length },
          { label: "rays", count: rayFrame.passes.length },
        ],
    pixelProbe: frame.pixelProbe,
    /** Non-null only when `shadeHit` was actually built — see `describeSrcProbeSystem`. */
    shading: shadeHit
      ? {
          lights: (lighting?.lights ?? []).length,
          emitters: (lighting?.emitters ?? []).length,
          attributed: !!surfaces,
          // THE BUILT PASS, not the gate that asked for it — a boot line that
          // disagrees with the built kernel is the §12.30 failure this file
          // keeps re-finding.
          secondary: !!secondary,
        }
      : null,
    width,
    height,
    pixelCount,
    // The ray ceiling, published so the boot line and `profile.giPasses` report
    // what the transport ACTUALLY fires rather than what the resolution implies.
    // `natural` is the pre-ceiling number: reading only `rays/px` off the log
    // was how a 3,146,400-ray frame looked like "2 rays/px" for a whole phase.
    // GETTERS, because the ceiling is polled per frame — a snapshot taken here
    // would report the value the system was BUILT with and go stale the moment
    // a probe moved it, which is the reading error this whole section keeps
    // paying for in a different costume.
    get rayStride() { return rayStride; },
    get rayCeiling() { return rayCeiling; },
    naturalRays,
    get tracedRays() { return Math.ceil(naturalRays / rayStride); },
    get probeRayCap() { return probeRayCap; },
    get reanchorCount() { return reanchors; },

    /**
     * Per-frame camera sync, and the re-anchor decision. Call BEFORE dispatching
     * `passes` — the whole frame's geometry is derived from these two uniforms,
     * so a stale camera puts every probe one frame behind its own gbuffer.
     */
    syncCamera(camera) {
      camera.getWorldPosition(cameraU.value);
      // ── THE CAMERA-PAN LIFT WINDOW — NOW OPT-IN (§12.47) ─────────────────
      // The camera is DELIBERATELY absent from the α signal (§12.38) and from
      // the tracking window (§12.43's refutation) — probe evidence is world-
      // anchored, so a pan stales nothing and must not buy fast decay. But a
      // pan CREATES probes: newly revealed surfaces allocate cold blocks, and
      // §12.45.2 lifted the CAP for them on the argument that adding evidence
      // is variance-reducing by construction.
      //
      // ⚠⚠ THAT ARGUMENT IGNORED THE PRICE, AND THE PRICE IS HALF THE FRAME
      // RATE. This arming is LEVEL-triggered — every moving frame re-pushes
      // the 1200 ms hold — so the cap is lifted for the WHOLE of any camera
      // movement, not for a window after it. Uncapped deposit is ~2× capped
      // (§12.42: the cap is ~14 ms of a 21 ms deposit), and the user reported
      // exactly that shape: "60 fps when still, 30 fps when moving camera."
      // It is §12.46's pathology in the camera path — sustained motion held
      // an emergency window open — and it survived that fix because §12.46
      // only re-armed the LIGHT side.
      //
      // Rising-edge arming does not rescue this one the way it rescued the
      // light window: a pan reveals cold blocks CONTINUOUSLY, so a one-shot
      // burst at the start of the movement would buy a 1.2 s hitch and then
      // stop helping exactly when the pan is still revealing geometry. So the
      // honest choice is on-or-off, and the measurement decides it: §12.45.2
      // priced the benefit at 2.89 vs 3.40 rev/px on pan-holds — marginal
      // against its own round spread — against a halved frame rate during the
      // single most common interaction in the editor. OFF by default;
      // `__giSrcCamCapLift = true` opts back in (the rig's lift-on arm).
      // The per-block form (lift the cap for NEWLY ALLOCATED blocks only,
      // rather than globally) is the version worth building — it is the same
      // targeting §12.42's per-block α compensation already does — and it
      // needs the cap to stop being one global uniform first.
      camera.getWorldQuaternion(camScratchQ);
      if (camSeen && globalThis.__giSrcCamCapLift === true) {
        const posDelta = camPrevPos.distanceTo(cameraU.value);
        const rotDelta = 2 * Math.acos(Math.min(1, Math.abs(camScratchQ.dot(camPrevQ))));
        if (posDelta > CAM_LIFT_POS || rotDelta > CAM_LIFT_ROT) {
          camHoldUntil = performance.now() + ALPHA_TRACK_HOLD_MS;
        }
      }
      camPrevPos.copy(cameraU.value);
      camPrevQ.copy(camScratchQ);
      camSeen = true;
      // Advance the R2 phase before the re-anchor early-out below, not after —
      // a still camera is exactly the case where every frame takes that return,
      // and it is also the only case where a frozen ray set would be invisible
      // (the picture would simply stop improving).
      jitterXU.value = (jitterXU.value + R2_ALPHA1_FX) >>> 0;
      jitterYU.value = (jitterYU.value + R2_ALPHA2_FX) >>> 0;
      // α is live — see `readAlpha`. Assigning unconditionally would dirty the
      // uniform every frame; the compare keeps a still scene's upload count at
      // zero, which the frame-pacing work cares about.
      // Cheap when `SlotRegistry.revision` is unchanged, which is every frame
      // that is not a material edit.
      if (shadeEnabled) surfaces?.sync?.();
      // ══ THE DECAY MUST FOLLOW THE REFRESH RATE, NOT THE FRAME RATE ═══════
      //
      // α is "how much of a probe's estimate is replaced by new evidence", and
      // §12.23 measured the whole temporal design at α = 0.1 PER REFRESH, back
      // when every pixel fired every frame so refresh rate == frame rate.
      //
      // The ray ceiling broke that identity and I did not notice: with a stride
      // of S a probe receives rays every S-th frame, while the decay pass still
      // runs over every allocated bin EVERY frame. At the user's resolution
      // S ≈ 12, so between two refreshes a bin's sums are multiplied by
      // 0.9^12 = 0.28 — **72% of the accumulated evidence destroyed before
      // anything arrives to replace it.** Bins sink under `MIN_WEIGHT`, retire,
      // and return a frame later, and §12.24 already named what that looks
      // like: the step floor is bin-level MEMBERSHIP, because a bin leaving the
      // readable set changes the renormalization denominator the gather divides
      // by. On screen it is flicker, and the user reported exactly that.
      //
      // So decay per FRAME becomes the S-th root of the intended decay per
      // REFRESH: over S frames the product is exactly `1 − α` again, which is
      // the number every §12.23 measurement was taken at. At S = 1 this is
      // identically `1 − α` and nothing changes, which is where all the gates
      // run.
      //
      // ⚠ It is a root, not a division. `keep/S` or `1 − α/S` both look
      // plausible and neither composes: decay is MULTIPLICATIVE across frames,
      // so the only function whose S-fold product is `1 − α` is its S-th root.
      const alpha = readAlpha();
      // Published every frame for probes — a plain number write. The α ramp
      // was UNGATEABLE end-to-end before this: `keepU` folds the stride root
      // in, so no page could read back what α the motion signal actually
      // produced, and the intensity-delta fix would have shipped on faith.
      globalThis.__giSrcAlphaLive = alpha;
      // ── THE ROOT RELAXES WITH MOTION (§12.43) ────────────────────────────
      // At m = 0 this is §12.32's root exactly — preserve evidence across
      // sparse refreshes, the still scene's variance shield. At m = 1 it is
      // no root at all: history is KNOWN-WRONG the moment the scene changes,
      // and preserving it multiplied a light step's convergence time by the
      // stride (measured 7.42 s at stride 12, `probe:gi-src-converge`).
      // GISystem's peak-hold keeps m up for the window the field needs.
      // `trackMotion` is nonzero ONLY while GISystem's light-event window is
      // open (a light matrix/luminance/emitter peak armed it — never mover
      // churn, never sub-threshold jitter; the gating lives THERE, one
      // definition). Standalone gates pass no getter and keep §12.32's root
      // identically. The first draft derived this from α itself and TRACK_AB
      // refuted it: any spurious motion spike became a 1.2 s burst of
      // relaxed-root fast decay, and the rig's still controls read 21.2 vs
      // 0.92 rev/px — the user saw it as water caustics on a parked floor.
      const tr = trackMotion ? Math.min(1, Math.max(0, Number(trackMotion()) || 0)) : 0;
      const rootS = 1 + (Math.max(1, rayStride) - 1) * (1 - tr);
      const keep = (1 - alpha) ** (1 / rootS);
      if (keepU.value !== keep) keepU.value = keep;
      // The compensation lift rides the same α, published for the same
      // reason α is: the rig's CAP arms need to SEE that compensation was
      // active, not assume it. Compare-then-assign, still scene uploads
      // nothing.
      const lift = liftFor(alpha);
      globalThis.__giSrcCompLiftLive = lift;
      if (influxLiftU.value !== lift) influxLiftU.value = lift;
      // ── SURPRISE'S TWO CPU DIALS ─────────────────────────────────────────
      //
      // `surpriseF` is the fast-α decay expressed against THIS frame's own
      // `keep` — the stride root is already folded into `keep`, so a surprised
      // block reaches the rate the moving scene would have used at stride 1
      // rather than a rate that happens to be faster. Floored at 1: surprise
      // may only accelerate forgetting. With α pinned to the moving value the
      // ratio IS 1 and the mix becomes a no-op, which is the instrument rule
      // (a pin must not be quietly overridden by a scene-derived term).
      const decayNow = Math.max(1e-6, 1 - keep);
      const surpriseF = Math.max(1, TEMPORAL_ALPHA / decayNow);
      if (surpriseFU.value !== surpriseF) surpriseFU.value = surpriseF;
      // THE GOVERNOR. Surprise and §12.45's scene-wide light window solve the
      // same problem, and both at once pays for uncapped evidence twice while
      // the window's relaxed root already decays fast. So the per-block term
      // fades out across [GOV_LO, GOV_HI] of the same motion signal the α ramp
      // rides. Smoothstep rather than a threshold for R1's reason: a binary
      // handover would step the ray budget on the frame it crossed.
      const mLight = motionOf(alpha);
      const govT = Math.min(1, Math.max(0, (mLight - GOV_LO) / Math.max(1e-6, GOV_HI - GOV_LO)));
      const forcedGain = Number(globalThis.__giSrcSurpriseGain);
      const gain = Number.isFinite(forcedGain)
        ? Math.min(1, Math.max(0, forcedGain))
        : 1 - govT * govT * (3 - 2 * govT);
      if (surpriseGainU.value !== gain) surpriseGainU.value = gain;
      // The stamp advances with the jitter and for the same reason: both are
      // "which frame is this", and the decay pass compares against it exactly.
      // It wraps at 2^32 — 2.2 years at 60 fps, and the only consequence of a
      // wrap is that a block untouched since the last lap gets zeroed instead
      // of decayed, which is what a block untouched for 2.2 years deserves.
      frameStampU.value = (frameStampU.value + 1) >>> 0;
      // The ray ceiling's residue class, rotated by the same counter. Over
      // `stride` frames every pixel is sampled exactly once, which is what
      // makes this a temporal subsample rather than a permanent crop — and the
      // accumulator it feeds is the one §12.23 built to weight by evidence.
      // Read from `frameStampU` rather than a second counter so there is one
      // definition of "which frame is this" (the decay pass compares against it
      // exactly, and two counters that drift would silently decorrelate the
      // stride from the decay).
      // The ceiling is live (see `readCeiling`), so re-derive the stride before
      // using it. Compare-then-assign for the same reason `keepU` does: a
      // uniform written every frame is uploaded every frame, and a still scene
      // should upload nothing.
      const nextCeiling = readCeiling();
      if (nextCeiling !== rayCeiling) {
        rayCeiling = nextCeiling;
        rayStride = strideFor(rayCeiling);
        strideU.value = rayStride;
        // Publish the derived stride. The boot line reports the stride the
        // system was BUILT with, and `__giSrcTransportRays` moves it afterwards
        // without logging — so a probe that changes the ceiling at runtime had
        // no way to read what it actually bought and was reduced to re-deriving
        // it from an assumed `pixelCount`. Written only on change, so a still
        // scene still writes nothing.
        publishTransport();
      }
      // The cap polls on the same schedule and for the same reason as the
      // ceiling. Compare-then-assign: a still scene uploads nothing.
      // ── AND IT LIFTS INSIDE THE TRACKING WINDOW (§12.45) ─────────────────
      // Measured before built (rig LIGHT_STEP, interleaved ×2): post-step
      // churn 24.1 rev/px shipped vs 15.3 with the cap off vs 3.7 window-off
      // — the cap owns 36% of the light-update flicker, because the window's
      // fast decay needs evidence at exactly the rate the cap denies. So
      // while GISystem's light-event window is open (`tr` above — never mover
      // churn, never camera pans), the tier cap lifts to OFF and the fat
      // probes feed the fast α; it re-engages when the window closes. The
      // deposit pays uncapped cost for the window's 1.2 s, which is the point.
      // A cap PINNED via `__giSrcProbeRayCap` NEVER lifts — pins belong to
      // instruments (§12.42: non-cap sweeps pin the cap off), and a pin that
      // drifted with scene state would un-A/B every arm that set it.
      // `__giSrcCapWindowLift = false` opts out (the rig's no-lift arm).
      // The CAMERA window is OPT-IN as of §12.47 — `camHoldUntil` only ever
      // advances when `__giSrcCamCapLift === true`, so this term is false in
      // the shipping config and the test below costs one clock read. See the
      // block at the top of this function for why it cost half the frame rate.
      const capPinned = Number.isFinite(Number(globalThis.__giSrcProbeRayCap));
      const capLifted = !capPinned && (
        (tr > 0 && globalThis.__giSrcCapWindowLift !== false)
        || performance.now() < camHoldUntil
      );
      const nextCap = capLifted ? PROBE_RAY_CAP_OFF : readCap();
      if (nextCap !== probeRayCap) {
        probeRayCap = nextCap;
        capU.value = nextCap;
        publishTransport();
      }
      // ── [D1']'s EXEMPTION SWITCH ─────────────────────────────────────────
      //
      // Off for COLD_GUARD_FRAMES after a build or a re-anchor: a re-anchor
      // re-keys every probe, so EVERY block is claimed on one frame and the
      // cold fill would multiply the whole frame's ray budget by four on
      // exactly the frame that already rebuilt the lattice.
      //
      // A PINNED CAP NEVER LIFTS, the same instrument rule §12.45 states for
      // the window lift: pins belong to instruments, and a pin that drifted
      // with scene state would un-A/B every arm that set it.
      //
      // `__giSrcColdFill = false` turns off BOTH legs — one uniform gates the
      // whole exemption path in [D1'], and splitting it would cost a second
      // uniform to disable a leg no measurement has separated yet.
      if (coldGuard > 0) coldGuard--;
      const boostOn = surpriseOn && globalThis.__giSrcColdFill !== false
        && !capPinned && coldGuard === 0 ? 1 : 0;
      if (boostEnableU.value !== boostOn) boostEnableU.value = boostOn;
      // [J]'s LOD-bias hatch, polled beside the others for the same §12.23
      // reason: a build-time read can only be A/B'd by reloading.
      secondary?.poll();
      phaseU.value = rayStride > 1 ? frameStampU.value % rayStride : 0;
      const a = anchorU.value;
      const drift = Math.max(
        Math.abs(cameraU.value.x - a.x),
        Math.abs(cameraU.value.y - a.y),
        Math.abs(cameraU.value.z - a.z),
      );
      if (anchored && drift <= REANCHOR_CHEBYSHEV * spacing0) return false;
      // Snap to a whole number of quanta rather than to the camera itself, so a
      // player pacing back and forth across the threshold does not re-anchor on
      // alternate frames. The quantum is the hysteresis.
      const q = ANCHOR_QUANTUM * spacing0;
      scratch.copy(cameraU.value).divideScalar(q).round().multiplyScalar(q);
      a.copy(scratch);
      anchored = true;
      reanchors++;
      // Every probe is about to be re-keyed, so every block will be claimed on
      // one frame and every one of them COLD. Re-arm the guard — see the switch
      // above for what the unguarded version costs.
      coldGuard = COLD_GUARD_FRAMES;
      return true;
    },

    /** Telemetry for `profile.giPasses` and the boot log. Async — off the hot path. */
    async readStats(renderer) {
      const stats = await readSrcProbeStats(renderer, store);
      // ── SURPRISE'S TWO INSTRUMENTS, PUBLISHED HERE AND NOT PER FRAME ─────
      //
      // Both are GPU readbacks, and §13's startup work priced what a readback
      // on the frame path costs (the `field ready` diagnostic was 1.0–1.8 s of
      // every startup number this project ever recorded). `readStats` is
      // already async and already off the hot path, so a probe polls the
      // instrument rather than the renderer paying for it every frame.
      //
      // They separate the three ways this mechanism renders identically to
      // being absent: never armed (`boosted` 0 with a nonzero mean u — the
      // guard or the pin), never surprised (mean u 0 — the governor or the
      // evidence floor), or working.
      if (surpriseBundle) {
        globalThis.__giSrcBoostedLive = stats.reduce((a, s) => a + (s.boosted ?? 0), 0);
        const free = new Uint32Array(await renderer.getArrayBufferAsync(store.freeStack.value));
        let sum = 0;
        for (let b = 0; b < store.blockTotal; b++) sum += free[store.blockSurpriseBase + b] >>> 0;
        globalThis.__giSrcSurpriseLive = store.blockTotal > 0
          ? sum / store.blockTotal / SURPRISE_ONE
          : 0;
      }
      return {
        cascades: stats,
        reanchors,
        bytes: store.bytes + rayStore.bytes + (binStore?.bytes ?? 0)
          + (merge?.bytes ?? 0) + (tiles?.bytes ?? 0) + (hashBlockFrame?.bytes ?? 0),
        spacing0,
        pixelCount,
        raysPerPixel: tier.raysPerPixel,
        totalRays: await rayFrame.readTotal(renderer),
        rays: deposit ? await deposit.readStats(renderer) : null,
        secondary: secondary ? await secondary.readStats(renderer) : null,
        merge: merge ? await merge.readStats(renderer) : null,
        tiles: tiles ? await tiles.readStats(renderer) : null,
        gather: gather ? await gather.readStats(renderer) : null,
      };
    },

    /**
     * A resize rebuilds the frame. The dispatch counts are compile-time
     * constants on the compute nodes (three bakes `.compute(n)`), and the
     * `pixelProbe` buffer is one entry per pixel — neither survives a resolution
     * change, and pretending otherwise would run the population over a stale
     * pixel count and silently drop the new edge of the screen.
     */
    setSize(nextWidth, nextHeight) {
      if (nextWidth === system.width && nextHeight === system.height) return system;
      // EVERY create arg forwards. The first version passed only the six it
      // could see, so `lighting`/`surfaces`/`sceneMotion`/`trackMotion`
      // defaulted to null and the FIRST viewport resize silently rebuilt the
      // deposit without hit shading (radiance degraded to sky-only, and the
      // reshaped kernel was a fresh compile on top). Found 2026-08-12 while
      // tracing the dynamic-resolution rebuild churn.
      const next = createSrcProbeSystem({
        gbuffer, width: nextWidth, height: nextHeight, props, volume, sky,
        lighting, surfaces, sceneMotion, trackMotion,
      });
      // Carry the debug view's on/off state across the rebuild. Losing it means
      // a viewport resize silently turns the gizmos off mid-inspection, which
      // reads as "the probes vanished when I dragged the panel".
      next.gizmos.setVisible(gizmos.group.visible);
      const parent = gizmos.group.parent;
      system.dispose();
      parent?.add(next.gizmos.group);
      return next;
    },

    dispose() {
      gizmos.dispose();
      secondary?.dispose();
      gather?.dispose();
      hashBlockFrame?.dispose();
      tiles?.dispose();
      merge?.dispose();
      binStore?.dispose();
      rayStore.dispose();
      frame.dispose();
      store.dispose();
    },
  };
  return system;
}

/** One boot line describing what was allocated. */
export function describeSrcProbeSystem(system) {
  const c = system.store.cascades
    .map((x) => `c${x.cascade} ${x.probeCapacity}/${x.hashCapacity}`)
    .join(" ");
  const bytes = system.store.bytes + system.rayStore.bytes + (system.binStore?.bytes ?? 0);
  // `passes/groups` is not decoration: `profile.giPasses` attributes the chain
  // by walking `passGroups`, and when that came back absent there was no way to
  // tell a system that never published it from an editor running a stale
  // module. The boot line now carries both counts, so the answer is in the log
  // that is already being read rather than in another instrumented run.
  const groups = Array.isArray(system.passGroups) ? system.passGroups.length : "ABSENT";
  return `[gi] src probes: ${system.pixelCount} gbuffer pixels, ${system.passes.length} passes / ` +
    `${groups} groups, s0=${system.spacing0}, ` +
    `${c}, ${system.raysPerPixel} rays/px, ` +
    // ⚠ SAY THE RAY COUNT, NOT JUST THE RATE. "2 rays/px" read as a small
    // number for a whole phase while it meant 3,146,400 rays a frame and 94% of
    // the GI cost; the rate is only a cost once multiplied by a resolution the
    // reader has to find elsewhere in the same line. Both now, plus the stride
    // that separates them, so a ceiling that is or is not biting is visible.
    (system.rayStride > 1
      ? `${system.tracedRays} rays/frame (ceiling ${system.rayCeiling}, stride ${system.rayStride} of ${system.naturalRays}), `
      : `${system.tracedRays} rays/frame (under the ${system.rayCeiling} ceiling), `) +
    // The cap makes `rays/frame` above an UPPER BOUND — the fired total is
    // per-probe-capped on the GPU (`readStats().totalRays` has it). Printed
    // with the bound so nobody divides a deposit time by the wrong count,
    // which is the exact instrument mistake the traced/natural split fixed.
    (system.probeRayCap && system.probeRayCap < PROBE_RAY_CAP_OFF
      ? `probe cap ${system.probeRayCap} (rays/frame is a bound; readStats has the fired total), `
      : "") +
    `${(bytes / 1048576).toFixed(2)}MB` +
    // The BLOCK counts are named, not the probe capacities, because they are
    // what the memory is a function of since the claim landed — and because a
    // pool short for the scene shows up as `NOBLOCK` in the frame line, which
    // only makes sense next to the capacity it fell short of.
    // "SRC is populating but tracing nothing" and "SRC is depositing" are two
    // builds with identical probe telemetry, so the log says which one this is.
    (system.binStore
      ? `, ${(system.binStore.binTotal / 1e6).toFixed(2)}M bins in ` +
        `${system.store.cascades.map((x) => x.blockCapacity).join("/")} blocks, ` +
        // "depositing" and "depositing + merging" are two builds with identical
        // probe telemetry and a range difference of four cascades, so the boot
        // line names which one this is.
        (system.merge ? "depositing + merging" : "depositing") +
        // ── WHETHER HIT SHADING IS ON, SAID OUT LOUD ────────────────────────
        //
        // Added after an eye check could not tell. `shadeHit` needs THREE things
        // to line up — the flag, the lighting bundle and the surface attribution
        // — and any one of them missing leaves a system that populates, deposits
        // and merges exactly as before while shading black. That is
        // indistinguishable from "Phase 5 is not written yet" in every log line
        // this module prints, so the log now names it.
        (system.shading
          ? `, SHADING (${system.shading.lights} lights, ${system.shading.emitters} emitters` +
            `${system.shading.attributed ? ", static surfaces attributed" : ""}` +
            `${system.shading.secondary ? ", MULTIBOUNCE via the tile atlas" : ", single bounce"})`
          : ", NO hit shading (radiance is sky-only)") +
        (system.tiles
          ? `, ${system.tiles.layout.width}x${system.tiles.layout.height} tile atlas ` +
            `(${system.tiles.blocks} x ${system.tiles.tileSize}²)`
          : "")
      : ", no volume — no deposit");
}

/** The per-frame telemetry line (plan §8: permanent, MCP-readable). */
export function formatSrcProbeFrame(stats) {
  const r = stats.rays;
  return `[gi] src probes — ${formatSrcProbeStats(stats.cascades)}` +
    (stats.reanchors > 1 ? `  reanchors ${stats.reanchors}` : "") +
    `  |  budget ${stats.totalRays} rays` +
    (r?.dispatched
      // `traced` vs `budget`: these must be EQUAL, and printing both rather than
      // one is what makes a divergence visible at a glance. They come from
      // opposite ends — the budget from Alg. 3's global cursor, the traced count
      // from an atomic in the deposit kernel itself.
      ? ` traced ${r.rays} hit ${(r.hitRate * 100).toFixed(1)}% ` +
        `t̄ ${r.meanT.toFixed(2)}m max ${r.maxT.toFixed(2)}m` +
        `  |  ${r.deposits} deposits (${r.perRay.toFixed(2)}/ray)` +
        // Clamps are the open `Lmax` decision's evidence (§12.13.4). Printed
        // always, including at zero — "the clamp never fired" is the finding.
        (r.clamped ? `  CLAMPED ${r.clamped}` : "") +
        // Deposits the block pool refused. The probe-side twin (`NOBLOCK n/cap`
        // in the cascade line) says how many probes; this says what it cost.
        (r.noBlock ? `  DROPPED ${r.noBlock}` : "") +
        // ── WHY THE FRAME IS THE BRIGHTNESS IT IS ─────────────────────────
        //
        // `maxL` is the most diagnostic number this module has and it was
        // computed and never printed: the brightest radiance any hit produced,
        // as a fraction of `Lmax`. **Zero means no hit shaded to anything**,
        // which separates "the transport is broken" from "the lighting is" in
        // one glance — and on screen those two are the same black frame.
        //
        // Printed at zero on purpose, with the shade tallies beside it, so a
        // black frame names its own cause: `NO HIT SHADING` = the shader was
        // never built; `UNATTRIBUTED` high = the palette is not answering;
        // shadow rays ≈ shaded with `maxL 0` = every hit is occluded from every
        // light.
        (r.shaded
          ? `  |  shaded ${r.shaded}` +
            (r.unattributedRate > 0.001 ? ` (${(r.unattributedRate * 100).toFixed(1)}% UNATTRIBUTED)` : "") +
            `, ${r.shadowRays} shadow rays, maxL ${r.maxRadianceFraction.toFixed(4)}` +
            (r.maxRadianceFraction === 0 ? " ← NO HIT PRODUCED ANY RADIANCE" : "") +
            (r.emissiveHits ? `, ${r.emissiveHits} emissive` : "") +
            (r.emitZeroed ? `, ${r.emitZeroed} R5-ZEROED` : "") +
            (r.albedoClamped ? `, ${r.albedoClamped} albedo-clamped` : "") +
            (r.importanceFloored ? `, ${r.importanceFloored} IMPORTANCE-FLOORED` : "")
          : "  |  NO HIT SHADING")
      : "") +
    // [J]'s own line. `bounce 0/N` with the boot line claiming MULTIBOUNCE is
    // the reading that separates "the second bounce is dim here" from "the
    // pass did not dispatch", which are the same picture.
    (stats.secondary?.dispatched ? `  |  ${formatSrcSecondary(stats.secondary)}` : "") +
    // The merge's range instrument. `to sky` is the fraction of merged bins
    // whose parent chain reached the top — i.e. how much of the frame is
    // getting the full-reach answer rather than a partial one.
    (stats.merge?.dispatched ? `  |  ${formatSrcMerge(stats.merge)}` : "") +
    (stats.tiles?.dispatched
      ? `  |  ${formatSrcTiles(stats.tiles, stats.cascades[0]?.live ?? 0)}`
      : "") +
    // [I]'s instrument. `corners` is the one that says whether the picture is
    // INTERPOLATED: at 1 per pixel this is the old one-probe-per-pixel gather
    // wearing a new name, and the blocks are still there.
    (stats.gather?.dispatched ? `  |  ${formatSrcGather(stats.gather)}` : "");
}
