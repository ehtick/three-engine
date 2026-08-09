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
import {
  createSrcProbeFrame,
  createSrcProbeStore,
  formatSrcProbeStats,
  readSrcProbeStats,
} from "./srcProbes.js";

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
 */
export function createSrcProbeSystem({ gbuffer, width, height, props = null } = {}) {
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

  const frame = createSrcProbeFrame(store, {
    spacing0,
    camera: vec3(cameraU),
    anchor: vec3(anchorU),
    pixelCount,
    maxLods: MAX_LODS,
    readPixel: (i) => {
      const px = i.mod(widthU);
      const py = i.div(widthU);
      const g0 = positionNode.load(ivec2(px.toInt(), py.toInt())).toVar();
      // `w > 0.5` is the gbuffer's own "geometry here" mark (createGiGBuffer
      // writes `vec4(positionWorld, 1)` and leaves untouched texels at 0). Using
      // the same test as `createGiResolve` is deliberate: a second definition of
      // "this pixel is real" is a second definition of what GI covers.
      return { position: g0.xyz, valid: g0.w.greaterThan(0.5) };
    },
  });

  let anchored = false;
  let reanchors = 0;
  const scratch = new THREE.Vector3();

  const system = {
    store,
    frame,
    spacing0,
    passes: frame.passes,
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
      return { cascades: stats, reanchors, bytes: store.bytes, spacing0, pixelCount };
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
        gbuffer, width: nextWidth, height: nextHeight, props,
      });
      system.dispose();
      return next;
    },

    dispose() {
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
    `${c}, ${(system.store.bytes / 1048576).toFixed(2)}MB`;
}

/** The per-frame telemetry line (plan §8: permanent, MCP-readable). */
export function formatSrcProbeFrame(stats) {
  return `[gi] src probes — ${formatSrcProbeStats(stats.cascades)}` +
    (stats.reanchors > 1 ? `  reanchors ${stats.reanchors}` : "");
}
