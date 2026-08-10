// SPLIT RADIANCE CASCADES — the GISystem entry point.
//
// Plan §7: "GISystem grows one `backend === "split-rc"` branch that early-outs
// into `srcSystem`, not tentacles." This is that early-out. Everything SRC
// needs from the engine arrives through the four arguments below; everything
// GISystem needs from SRC is on the returned object. Neither knows anything
// else about the other, which is the only reason the Phase-2/3 work can grow
// underneath this without turning into a sweep through a 7,000-line file.
//
// ══ WHY THIS IS OPT-IN AND WILL STAY OPT-IN UNTIL PHASE 6 ══════════════════
//
// `__giSrcProbes` defaults OFF. The probe population produces no light — the
// diffuse indirect term is still absent (plan §12.8) — so switching it on today
// costs GPU time and changes nothing on screen. It is on the frame so a person
// can look at the gizmos and so `smoke:gi-gpu?src=1` can audit the bindings; it
// is off by default so the shipping build is byte-identical, which is what
// makes every existing probe's numbers still comparable.
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
import { float, ivec2, step, texture, uniform, vec3 } from "three/tsl";
import { CASCADE_COUNT, MAX_LODS, SRC_QUALITY, TEMPORAL_ALPHA, W0, srcQualityTier } from "./srcConfig.js";
import { createSrcProbeGizmos } from "./srcGizmos.js";
import { R2_ALPHA1_FX, R2_ALPHA2_FX } from "./srcMath.js";
import {
  createSrcHashBlockFrame,
  createSrcProbeFrame,
  createSrcProbeStore,
  formatSrcProbeStats,
  readSrcProbeStats,
} from "./srcProbes.js";
import { createSrcBinStore, createSrcDepositFrame, createSrcShadeCounters } from "./srcDeposit.js";
import { createSrcHitShader } from "./srcShade.js";
import { createSrcMergeFrame, formatSrcMerge } from "./srcMerge.js";
import { createSrcScreenGather, formatSrcGather } from "./srcScreenGather.js";
import { createSrcTileAtlas, formatSrcTiles } from "./srcTiles.js";
import { createSrcRayFrame, createSrcRayStore } from "./srcRays.js";
import { createSrcSceneTrace, createSrcVisibility, ifMoverHit, moverSurfaceAt } from "./srcTrace.js";

/** Camera drift, in units of s₀, that triggers a re-anchor. */
const REANCHOR_CHEBYSHEV = 64;
/** The anchor snaps to multiples of this many s₀, so it moves in whole steps. */
const ANCHOR_QUANTUM = 16;

/** Is the SRC probe population compiled into this build? Opt-in — see the header. */
export function srcProbesEnabled() {
  return globalThis.__giSrcProbes === true;
}

/**
 * Is SRC HIT SHADING on? Opt-in, and the single source of truth for it, because
 * the flag is read in two places that must not disagree: here, to build the
 * shader, and in `GISystem`'s field construction, to allocate the surface
 * attribution region the shader reads. A field built without the region and a
 * shader built expecting one is a throw at best and a grey world at worst, and
 * they are separated by a full rebuild — so they read one function.
 */
export function srcShadeEnabled() {
  return globalThis.__giSrcShade === true;
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
  lighting = null, surfaces = null,
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
  const readAlpha = () => (Number.isFinite(Number(globalThis.__giSrcAlpha))
    ? Math.min(1, Math.max(0, Number(globalThis.__giSrcAlpha)))
    : TEMPORAL_ALPHA);
  const keepU = uniform(1 - readAlpha());
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
  const rayFrame = createSrcRayFrame(store, rayStore, {
    pixelProbe: frame.pixelProbe,
    raysPerPixel: tier.raysPerPixel,
  });

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
  const binStore = volume?.occupancyField ? createSrcBinStore(store, { w0: W0 }) : null;

  // ── [E']: HIT SHADING (plan §7 Phase 5, §12.26) ───────────────────────────
  //
  // OPT-IN, and gated on having something to shade WITH as well as a flag.
  // `__giSrcShade` off, or no `lighting`, or no `staticSurfaceAt`, and
  // `shadeHit` stays null — which keeps this build byte-identical and keeps
  // every gate written before Phase 5 comparable, exactly as `__giSrcProbes`
  // does for the population.
  //
  // **THE TWO ARGUMENTS ARE NOT ONE SWITCH.** `staticSurfaceAt` is the other
  // half of Phase 5 and lives in `srcSurface.js`: §12.9 deleted the coarse
  // surface-attribution grid, so there is currently no path on the GPU from a
  // static hit to its material. Shading with `lighting` alone would light the
  // whole static world at one default albedo — a grey-box bounce that looks
  // plausible, is wrong everywhere, and would be read as a shader bug rather
  // than a missing input. `STAT_UNATTRIBUTED` counts it if it ever happens.
  const staticSurfaceAt = surfaces?.surfaceAt ?? null;
  const shadeEnabled = srcShadeEnabled() && !!lighting && !!staticSurfaceAt;
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
        visibility: createSrcVisibility(volume.occupancyField, volume.world, {
          rayHitMode: volume.rayHitMode,
          // A shadow ray is SHORTER than a diffuse one by construction — it
          // stops at its source — so it does not inherit the 192 the primary
          // budget was measured to need. Its own number is owed a measurement on
          // a real scene; until then this is the marcher's own default.
          steps: Number(globalThis.__giSrcShadowSteps) || 64,
        }),
        voxelSize: volume.world.minCell,
        // [J] is not built yet, so this is a single bounce and R4's ceiling has
        // no loop to bound. It still applies — the ceiling is a property of the
        // albedo, not of the loop, and turning it on later must not change what
        // one bounce looks like.
        secondary: null,
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
        pixelCount,
        raysPerPixel: tier.raysPerPixel,
        lmax: lmaxU,
        // Null unless [E'] above was built. With radiance zero, what survives
        // the resolve is transmittance, and a receiver lit by transmittance
        // alone against the sky is ambient occlusion. That is §7's "AO-like
        // short-range bounce", not a placeholder.
        shadeHit,
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

  // ── [H]: THE IRRADIANCE TILES (plan §12.18.7 unit 4) ─────────────────────
  //
  // c0 only, and only because [G] has already run: a merged c0 bin carries the
  // whole cascade chain's answer at the finest spacing the hierarchy has, so
  // tiles for cascades 1-3 would bake the same light more coarsely and nothing
  // would read them.
  //
  // [I] below is what reads them: one filtered tap per trilinear corner, in
  // the shading point's normal direction.
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
  // see its header for the three-buffers-to-two argument.
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
        readPixel,
        width,
        height,
        maxLods: MAX_LODS,
        w0: W0,
      })
    : null;

  let anchored = false;
  let reanchors = 0;
  const scratch = new THREE.Vector3();

  const system = {
    store,
    frame,
    gizmos,
    rayStore,
    rayFrame,
    binStore,
    deposit,
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
          ...frame.passes, ...rayFrame.passes, ...deposit.passes,
          ...merge.passes, ...tiles.passes,
          // `hashBlock` sits here and not with the population because it reads
          // BOTH halves of what compaction settles (`hashSlot` and
          // `PROBE_BLOCK`), and because its only consumer is the gather below.
          hashBlockFrame.pass, gather.reset, gather.compute,
        ]
      : [...frame.passes, ...rayFrame.passes],
    pixelProbe: frame.pixelProbe,
    /** Non-null only when `shadeHit` was actually built — see `describeSrcProbeSystem`. */
    shading: shadeHit
      ? {
          lights: (lighting?.lights ?? []).length,
          emitters: (lighting?.emitters ?? []).length,
          attributed: !!surfaces,
        }
      : null,
    width,
    height,
    pixelCount,
    get reanchorCount() { return reanchors; },

    /**
     * Per-frame camera sync, and the re-anchor decision. Call BEFORE dispatching
     * `passes` — the whole frame's geometry is derived from these two uniforms,
     * so a stale camera puts every probe one frame behind its own gbuffer.
     */
    syncCamera(camera) {
      camera.getWorldPosition(cameraU.value);
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
      const keep = 1 - readAlpha();
      if (keepU.value !== keep) keepU.value = keep;
      // The stamp advances with the jitter and for the same reason: both are
      // "which frame is this", and the decay pass compares against it exactly.
      // It wraps at 2^32 — 2.2 years at 60 fps, and the only consequence of a
      // wrap is that a block untouched since the last lap gets zeroed instead
      // of decayed, which is what a block untouched for 2.2 years deserves.
      frameStampU.value = (frameStampU.value + 1) >>> 0;
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
      return true;
    },

    /** Telemetry for `profile.giPasses` and the boot log. Async — off the hot path. */
    async readStats(renderer) {
      const stats = await readSrcProbeStats(renderer, store);
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
      const next = createSrcProbeSystem({
        gbuffer, width: nextWidth, height: nextHeight, props, volume, sky,
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
  return `[gi] src probes: ${system.pixelCount} gbuffer pixels, s0=${system.spacing0}, ` +
    `${c}, ${system.raysPerPixel} rays/px, ${(bytes / 1048576).toFixed(2)}MB` +
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
            `${system.shading.attributed ? ", static surfaces attributed" : ""})`
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
        (r.noBlock ? `  DROPPED ${r.noBlock}` : "")
      : "") +
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
