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
import { ivec2, texture, uniform, vec3 } from "three/tsl";
import { CASCADE_COUNT, MAX_LODS, SRC_QUALITY, srcQualityTier } from "./srcConfig.js";
import { createSrcProbeGizmos } from "./srcGizmos.js";
import { R2_ALPHA1_FX, R2_ALPHA2_FX } from "./srcMath.js";
import {
  createSrcProbeFrame,
  createSrcProbeStore,
  formatSrcProbeStats,
  readSrcProbeStats,
} from "./srcProbes.js";
import { createSrcRayPass } from "./srcRayPass.js";
import { createSrcSceneTrace } from "./srcTrace.js";

/** Camera drift, in units of s₀, that triggers a re-anchor. */
const REANCHOR_CHEBYSHEV = 64;
/** The anchor snaps to multiples of this many s₀, so it moves in whole steps. */
const ANCHOR_QUANTUM = 16;

/** Is the SRC probe population compiled into this build? Opt-in — see the header. */
export function srcProbesEnabled() {
  return globalThis.__giSrcProbes === true;
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
 */
export function createSrcProbeSystem({ gbuffer, width, height, props = null, volume = null } = {}) {
  const tier = SRC_QUALITY[srcQualityTier(props)];
  const spacing0 = Number(globalThis.__giSrcSpacing0) || tier.spacing0;
  const pixelCount = width * height;

  const store = createSrcProbeStore({
    c0Probes: expectedC0Probes(pixelCount),
    cascadeCount: CASCADE_COUNT,
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
    const g0 = positionNode.load(texelOf(i)).toVar();
    // `w > 0.5` is the gbuffer's own "geometry here" mark (createGiGBuffer
    // writes `vec4(positionWorld, 1)` and leaves untouched texels at 0). Using
    // the same test as `createGiResolve` is deliberate: a second definition of
    // "this pixel is real" is a second definition of what GI covers.
    return { position: g0.xyz, valid: g0.w.greaterThan(0.5) };
  };
  // `normal.w` is the MIRROR MASK, not a validity bit (giScreen's second pass
  // writes 1 there for reflective pixels) — read `.xyz` and let `position.w`
  // stay the single validity test.
  const readNormal = (i) => normalNode.load(texelOf(i)).xyz;

  const frame = createSrcProbeFrame(store, {
    spacing0,
    camera: vec3(cameraU),
    anchor: vec3(anchorU),
    pixelCount,
    maxLods: MAX_LODS,
    readPixel,
  });

  // The gizmos share the SAME anchor uniform, not a copy. A gizmo lattice
  // drawn from a second anchor would look perfectly plausible and be in the
  // wrong place, which is the most misleading failure a debug view can have.
  const gizmos = createSrcProbeGizmos(store, { spacing0, anchor: vec3(anchorU) });

  // ── THE SCAFFOLD RAY PASS (plan §12.13.5 unit 1) ─────────────────────────
  //
  // One profiled ray per participating pixel. It produces no light and it is
  // meant to be deleted by unit 3 — what it produces is the ray-hit counters,
  // which have had no producer since the dense transport died and which are the
  // only gate on the traversal's step budgets. See `srcRayPass.js`.
  //
  // The R2 PHASE advances by the two plastic-constant increments each frame, so
  // frame f traces the sequence shifted by f points. That is a scaffold-grade
  // choice deliberately: Alg. 3 owns the real global ray numbering (unit 2), and
  // inventing a second one here would be a throwaway scheme inside a throwaway
  // pass. What it must NOT be is a float — §12.11.1.
  const jitterXU = uniform(0, "uint");
  const jitterYU = uniform(0, "uint");
  const rayPass = volume?.occupancyField
    ? createSrcRayPass({
        pixelProbe: frame.pixelProbe,
        pixelCount,
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
          // Measured on an 8 m scene. A real one has to be re-measured when unit
          // 3 makes this the production ray, and `?raysteps=N` is the A/B.
          steps: Number(globalThis.__giSrcRaySteps) || 192,
          // Movers are IN. They are hit geometry for every other ray class in
          // this module (`composeFieldDynamics`), and a budget measured with
          // them excluded would be a budget for a medium nothing else traces.
          skipMovers: false,
          // Nothing here shades a mover hit, and asking for the packed id costs
          // the marcher its dynamic-object bookkeeping on every ray.
          wantDynObj: false,
        }),
        readPixel,
        readNormal,
        camera: vec3(cameraU),
        spacing0,
        jitterX: jitterXU,
        jitterY: jitterYU,
        maxLods: MAX_LODS,
      })
    : null;

  let anchored = false;
  let reanchors = 0;
  const scratch = new THREE.Vector3();

  const system = {
    store,
    frame,
    gizmos,
    rayPass,
    spacing0,
    // The ray pass rides the SAME dispatch list, after the population, because
    // it reads `pixelProbe` — which the population's last resolve writes. A
    // separate `renderer.compute` call would be the same barrier at the cost of
    // one more launch; a different ORDER would trace against last frame's
    // membership, which is the kind of one-frame skew that looks like noise.
    passes: rayPass ? [...frame.passes, rayPass.reset, rayPass.compute] : frame.passes,
    pixelProbe: frame.pixelProbe,
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
        bytes: store.bytes,
        spacing0,
        pixelCount,
        rays: rayPass ? await rayPass.readback(renderer) : null,
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
        gbuffer, width: nextWidth, height: nextHeight, props, volume,
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
      rayPass?.dispose();
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
  return `[gi] src probes: ${system.pixelCount} gbuffer pixels, s0=${system.spacing0}, ` +
    `${c}, ${(system.store.bytes / 1048576).toFixed(2)}MB` +
    // Named in the boot log because "SRC is populating but tracing nothing" and
    // "SRC is tracing" are two different builds with identical probe telemetry,
    // and the second one is the one whose step budgets are being measured.
    (system.rayPass ? ", scaffold rays ON" : ", no volume — scaffold rays OFF");
}

/** The per-frame telemetry line (plan §8: permanent, MCP-readable). */
export function formatSrcProbeFrame(stats) {
  const r = stats.rays;
  return `[gi] src probes — ${formatSrcProbeStats(stats.cascades)}` +
    (stats.reanchors > 1 ? `  reanchors ${stats.reanchors}` : "") +
    (r?.dispatched
      ? `  |  rays ${r.rays} hit ${(r.hitRate * 100).toFixed(1)}% ` +
        `t̄ ${r.meanT.toFixed(2)}m max ${r.maxT.toFixed(2)}m`
      : "");
}
