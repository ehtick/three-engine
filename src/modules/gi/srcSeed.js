// SPLIT RADIANCE CASCADES — THE FRESH-PROBE SEED (§12.59.2).
//
// A probe born this frame starts its accumulators at ZERO and converges in
// view. §12.59.1's pan bisect measured what that looks like: a 25° camera pan
// drives per-pixel step amplitude ~200× over the still floor, the churn is
// INVARIANT to the per-probe ray cap (so faster intake cannot hide it — §12.52's
// cold fill is a ray-budget lift, not a prior), and the elevated stills OUTLIVE
// the pan by seconds while the newly-anchored column finishes converging. Every
// at-rest suspect — cap, surprise detector, tracking window — measured inside
// the instrument's noise floor. The mechanism is newborn probes; the fix is a
// RADIANCE PRIOR, and this file is that prior.
//
// ══ WHAT IS WRITTEN, AND WHY IT IS THE PARENT'S MERGED PAYLOAD ══════════════
//
// For each bin of a fresh probe, seed = the 4→1 pre-average of the PARENT
// cascade probe's bins at the same world direction (srcMerge's [G.3] mapping:
// child bin m ↔ parent bins 4m…4m+3, Morton-contiguous), read from `payload` —
// which at this point in the frame still holds LAST frame's resolved+MERGED
// values. Merged, not raw, and that choice is load-bearing:
//
//   · The merged parent answer is FULL-RANGE (own interval + everything above
//     it + sky), i.e. it lives in the same domain the child's own bins reach
//     AFTER their merge. Seed L = that answer with T ≈ 0 (merged T is 0
//     wherever the parent chain resolved), and the child's first merged frame
//     reads ≈ the parent's converged answer instead of ≈ black.
//   · The transition is STATIONARY where the truth is stationary. Take a bin
//     whose truth is "clear through my interval": own rays deposit T=1, L=0 at
//     weight w against seed weight W, so the child resolves
//     L = W·Lp/(W+w), T = w/(W+w), and its merge adds T·Lp — total Lp exactly,
//     at every w. The prior does not fight the evidence on the way out; it
//     hands over.
//   · A raw-accumulator seed would describe the parent's own INTERVAL (2× the
//     child's, different content) and would then be double-counted by the
//     child's merge (seeded L already partly parental, plus T·L_parent again).
//
// UNKNOWN parent bins (payload T < 0) are skipped and the 4→1 average
// renormalizes over what was found — all four unknown seeds nothing and the
// child bin keeps today's from-zero behaviour (R1: an absence is an absence).
// The top cascade has no parent and is not seeded (its §12.59.2 spatial-
// neighbour fallback is deliberately deferred until the parent path's pan
// numbers say whether it is needed).
//
// ══ ORDER: AFTER THE DECAY, AND `atomicAdd`, NOT STORE ══════════════════════
//
// Two traps this placement exists to dodge, both silent:
//
//   1. The deposit's decay pass ZEROES every block claimed this frame (the
//      stamp check — a reclaimed block must not fade a dead probe's history
//      into its successor). A seed written in the populate group would be
//      wiped by it, frame after frame, and render EXACTLY like the seed not
//      existing. So these passes dispatch AFTER `deposit.decay` and before
//      the resolve reads the accumulators.
//   2. The writes are `atomicAdd` onto the just-zeroed words, never
//      `atomicStore` — adds commute with [E]'s scatter, so the seed is correct
//      anywhere in the decay→resolve window and cannot erase a ray that lands
//      first. (`scratch` is atomic; a plain `.assign` would not compile —
//      srcMerge's telemetry clear records the same trap from the store side.)
//
// A third trap, dodged by a flag test rather than by order: a parent that is
// ITSELF fresh claimed its block this frame, so `payload` at that block is a
// PREVIOUS OWNER's stale answer — geometrically unrelated light that no energy
// check would flag. Fresh parents (and blockless ones) are skipped and
// counted, not read.
//
// ══ THE WEIGHT, AND THE IN-PAGE OFF ARM ═════════════════════════════════════
//
// `seedRays` (srcConfig's SEED_RAYS doc carries the two anchors: ≈8 frames of
// measured evidence, just under the decay's steady state) arrives as a uniform
// and every written quantity is proportional to it — so `__giSrcSeedRays = 0`
// zeroes every add and IS the A/B arm, in-page, no rebuild, which is the only
// comparison `run-gi-flicker-frame.mjs`'s own header permits. The build-time
// hatch `__giSrcSeed = false` removes the passes entirely (srcSystem reads it
// once), keeping every kernel byte-identical for gates written before this.
//
// docs/GI_SRC_REBUILD_PLAN.md §12.59.1 (the verdict), §12.59.2 (this spec).

import {
  atomicAdd,
  atomicStore,
  float,
  Fn,
  If,
  instancedArray,
  instanceIndex,
  Loop,
  Return,
  uint,
  vec3,
} from "three/tsl";
import { CASCADE_COUNT } from "./srcConfig.js";
import { binPartitionUniforms, capAt, probeRegionUniforms } from "./srcCapacityUniforms.js";
import {
  BIN_B, BIN_COUNT, BIN_G, BIN_R, BIN_T, BIN_WORDS, DEPOSIT_SCALE, readPayload,
} from "./srcDeposit.js";
import {
  FLAG_ALIVE,
  FLAG_FRESH,
  PROBE_BLOCK,
  PROBE_FLAGS,
  PROBE_KEY,
  PROBE_PARENT,
  PROBE_WORDS,
  SLOT_EMPTY,
  createProbeLookup,
} from "./srcProbes.js";
import { worldKeysEnabled } from "./srcMath.js";
import {
  cellPosition,
  keyCell,
  keyLod,
  keySecondary,
  keyWorldCell,
  latticeOrigin,
  nearestCell,
  packProbeKey,
  probeSpacing,
} from "./srcMathTsl.js";
import { floor, int, ivec2, ivec3 } from "three/tsl";

/** Seed telemetry. One atomic buffer, six words. */
export const SEED_PROBES = 0;  // fresh probes seeded (parent had history)
export const SEED_ORPHAN = 1;  // fresh probes with no parent probe at all
export const SEED_COLD = 2;    // fresh probes whose parent was fresh/blockless — a cold column
export const SEED_BINS = 3;    // bins that received a prior
export const SEED_SPATIAL = 4; // cold-column probes rescued by the LOD+1 spatial fallback
// §16 D2a: fresh probes that held NO bin block when the seed ran. This exit
// used to `Return()` silently, which made "seed 0 probes" unreadable — it
// could mean "nothing fresh at sample time" OR "fresh probes exist but the
// seed cannot reach them" and the two have opposite fixes.
export const SEED_NOBLOCK = 5;
/** fresh probes whose parent (or spatial candidate) sits behind a wall — no prior taken (BVH segment test) */
export const SEED_LOS = 6;
/** §11.16: bins that took the FAR-FIELD prior (no parent / spatial source) */
export const SEED_FAR = 7;
/** §11.16: fresh probes that were seeded ONLY from the far field */
export const SEED_FAR_PROBES = 8;
export const SEED_WORDS = 9;

/**
 * Bins per thread. Bin counts quadruple up the ladder (32 at c0, 512 at c2
 * with w0 = 4), and a pan frame's fresh probes are few — one thread per probe
 * would put a 512-iteration loop on a handful of threads, which is a
 * tail-latency shape, not a throughput one. Splitting a probe across
 * `bins/32` threads keeps every live thread the same length as a c0 thread;
 * dead threads (the steady-state majority) exit on the flags read either way.
 */
const SEED_GROUP_BINS = 32;

/**
 * Radiance ceiling on the seed, in units of Lmax. Merged payload can exceed
 * Lmax (it is a SUM down the ladder plus sky), and the fixed-point words the
 * seed writes are u32 — the clamp bounds the add at
 * `SEED_MAX_UNIT · seedRays · 2^16`, three orders under overflow, and a prior
 * brighter than 8× the deposit ceiling is not a prior worth propagating.
 */
const SEED_MAX_UNIT = 8;

/**
 * Build the seed as a dispatch list: one telemetry clear, then one pass per
 * cascade 0…N−2 (the top cascade has no parent).
 *
 * MUST dispatch after `createSrcDepositFrame`'s decay and before its resolve —
 * the header's trap 1. srcSystem's `passes` list is the enforcement.
 *
 * @param {object} store  from `createSrcProbeStore`
 * @param {object} bins   from `createSrcBinStore`
 * @param {object} options
 * @param {Node} options.lmax  the SAME uniform the deposit converts through —
 *   a second ceiling here would seed in a different fixed point than the rays
 *   land in, and the blend would silently weight the two inconsistently.
 * @param {Node} options.seedRays  uniform: the prior's effective sample count,
 *   in rays. 0 zeroes every write (the in-page off arm).
 */
export function createSrcSeedFrame(store, bins, { lmax, seedRays, camera = null, spacing0 = null, maxLods = null, anchor = null, losSegment = null, farField = null, seedFarRays = null } = {}) {
  // §11.16 — THE FAR-FIELD PRIOR (srcConfig's SEED_RAYS_FAR doc). `farField`
  // is the 4×1 far-field texture GISystem owns: texel (2,0) holds the RAW
  // screen-gather mean irradiance with alpha 1 once primed (giScreen's
  // createGiFarFieldAvgPass). A bin that finds no parent and no spatial
  // source starts there, as radiance E/π at `seedFarRays` rays' weight; and
  // the TOP cascade, which has no parent at all, is seeded for the first time.
  // Without the texture (every fixture) the kernels are byte-identical.
  // ⛔ OPT-IN (2026-09-03 evening, measured and REFUTED as a default — srcConfig's
  // SEED_RAYS_FAR doc): `__giSrcSeedFar = true` arms it; the default build is
  // byte-identical to the pre-§11.16 seed.
  const farOn = !!farField?.node && seedFarRays != null && globalThis.__giSrcSeedFar === true;
  const { probeTable } = store;
  const { payload, scratch } = bins;
  const N = store.cascadeCount ?? CASCADE_COUNT;
  // Bin bases as uniforms, not literals — a pool grow must not change this
  // kernel's text, or the driver's compiled-shader cache goes cold for it
  // (srcCapacityUniforms.js carries the argument). The probe table's region
  // rides along: the seed indexes it as `instanceIndex + probeBase`.
  const cap = {
    ...binPartitionUniforms(bins),
    ...probeRegionUniforms(bins.cascades),
  };
  // §12.59.2's DEFERRED SPATIAL FALLBACK, built 2026-08-22 night — the user's
  // "lighting blocks update on the way" named it: at a walk frontier the whole
  // COLUMN is fresh, the cascade parent is unusable, and the probe converged
  // from zero IN VIEW (under locality retention the pop is worse-looking, not
  // worse — converged neighbours make each cold block visible by contrast).
  // The fallback seeds a cold-column probe from the SAME-cascade probe at
  // LOD+1 (whose 2× cell reaches back into visited, converged space) — same
  // bin count, 1:1 direction mapping, no 4→1.
  //
  // §16 D2b (2026-08-24): armed on BOTH key arms now. The world arm recovers
  // the LOD+1 cell anchor-free via `keyWorldCell` + floor-halving; the
  // anchor-relative arm cannot halve cell indices (each spacing has its own
  // `latticeOrigin`), so it re-keys BY POSITION exactly the way the populate
  // pass [B] would: position from this key's cell, then `nearestCell` on the
  // LOD+1 lattice. With §16 D1's retention, the LOD+1 probes that covered a
  // region while it was distant SURVIVE the approach — which is precisely the
  // converged prior a walk frontier wants.
  // Cost: fresh probes only (a handful per frame) — structurally inside the
  // 60 fps rule.
  const worldKeys = worldKeysEnabled();
  const spatial = camera && spacing0 != null && maxLods != null && (worldKeys || anchor);

  const stats = instancedArray(new Uint32Array(SEED_WORDS), "uint").toAtomic();
  const passes = [];
  // One flag-checked probe lookup per seeded cascade (the fallback finds the
  // LOD+1 probe by key in the SAME cascade's hash).
  const lookups = spatial
    ? Array.from({ length: farOn ? N : N - 1 }, (_, c) => createProbeLookup(store, c))
    : null;

  // `atomicStore`, not `.assign` — srcMerge's telemetry clear carries the trap.
  passes.push(Fn(() => {
    const i = instanceIndex.toVar();
    If(i.lessThan(uint(SEED_WORDS)), () => {
      atomicStore(stats.element(i), uint(0));
    });
  })().compute(SEED_WORDS));

  for (let c = 0; c < (farOn ? N : N - 1); c++) {
    const info = bins.cascades[c];
    // The top cascade (far arm only) has no parent: its bins take the far
    // field or nothing.
    const parentInfo = c + 1 < N ? bins.cascades[c + 1] : null;
    const nBins = info.bins;
    const groupBins = Math.min(nBins, SEED_GROUP_BINS);
    const groups = Math.max(1, Math.floor(nBins / groupBins));

    passes.push(Fn(() => {
      // One thread per (probe, bin group). Both factors are powers of two, so
      // the split is shifts, same as the merge's (block, bin) split.
      const i = instanceIndex.toVar();
      const group = i.mod(uint(groups)).toVar();
      const p = uint(capAt(cap.probeBase, c)).add(i.div(uint(groups))).toVar();
      const w = p.mul(uint(PROBE_WORDS)).toVar();

      const flags = probeTable.element(w.add(uint(PROBE_FLAGS))).toVar();
      If(flags.bitAnd(uint(FLAG_ALIVE)).equal(uint(0)), () => { Return(); });
      // FRESH means "born this frame" here and nowhere looser: the age pass
      // clears the flag on every survivor BEFORE re-inserting it, so a probe
      // seen last frame cannot take this branch and be re-seeded over its own
      // history.
      If(flags.bitAnd(uint(FLAG_FRESH)).equal(uint(0)), () => { Return(); });
      // Per-probe counters tally once, on the probe's first group — the other
      // groups of the same probe take the same branches and stay silent.
      const first = group.equal(uint(0));

      const block = probeTable.element(w.add(uint(PROBE_BLOCK))).toVar();
      // No block, nowhere to seed. §16 D2a: counted now — this was the one
      // silent exit, and it made "seed 0 probes" indistinguishable from
      // "nothing fresh at sample time".
      If(block.equal(uint(SLOT_EMPTY)), () => {
        If(first, () => {
          atomicAdd(stats.element(uint(SEED_NOBLOCK)), uint(1));
        });
        Return();
      });

      // PROBE_PARENT holds the parent's probe INDEX here — the populate
      // ladder's resolve settled it earlier this frame (its hash-slot interim
      // is dead by compaction, srcProbes' PROBE_PARENT doc). SLOT_EMPTY is a
      // probe whose parent cell never got a probe.
      const parent = probeTable.element(w.add(uint(PROBE_PARENT))).toVar();
      // The header's trap 3 folded in: a usable parent is alive, NOT fresh
      // (a fresh parent's payload is a previous owner's stale answer) and
      // holds a block. `pblock` is only meaningful when `parentUsable` is 1.
      const parentUsable = uint(0).toVar();
      const pblock = uint(SLOT_EMPTY).toVar();
      If(parent.notEqual(uint(SLOT_EMPTY)), () => {
        const pw = parent.mul(uint(PROBE_WORDS)).toVar();
        const pflags = probeTable.element(pw.add(uint(PROBE_FLAGS))).toVar();
        const pb = probeTable.element(pw.add(uint(PROBE_BLOCK))).toVar();
        If(pflags.bitAnd(uint(FLAG_ALIVE)).notEqual(uint(0))
          .and(pflags.bitAnd(uint(FLAG_FRESH)).equal(uint(0)))
          .and(pb.notEqual(uint(SLOT_EMPTY))), () => {
          pblock.assign(pb);
          parentUsable.assign(uint(1));
        });
      });
      // Section 10 (2026-09-02): a parent behind a wall is no prior. The seed
      // used to copy an OUTDOOR parent's merged bins (sky) into an INDOOR
      // fresh probe — the blue patches (black with the sky off) on every
      // surface the camera turned onto. One any-hit segment child -> parent
      // (the merge's own test) declines the parent; the probe then converges
      // from its own rays under the resolve's far-field fill.
      const losGate = !!losSegment && spatial;
      if (losGate) {
        If(parentUsable.equal(uint(1)), () => {
          const keyC = probeTable.element(w.add(uint(PROBE_KEY))).toVar();
          const lodC = keyLod(keyC).toVar();
          const sC = probeSpacing(c, lodC, spacing0).toVar();
          const childPos = (worldKeys
            ? vec3(keyWorldCell(keyC, camera, sC)).mul(sC)
            : cellPosition(keyCell(keyC), latticeOrigin(anchor, sC), sC)).toVar();
          const pkey = probeTable.element(parent.mul(uint(PROBE_WORDS)).add(uint(PROBE_KEY))).toVar();
          const sP = probeSpacing(c + 1, keyLod(pkey), spacing0).toVar();
          const parentPos = (worldKeys
            ? vec3(keyWorldCell(pkey, camera, sP)).mul(sP)
            : cellPosition(keyCell(pkey), latticeOrigin(anchor, sP), sP)).toVar();
          If(float(losSegment(childPos, parentPos)).lessThan(0.5), () => {
            parentUsable.assign(uint(0));
            If(first, () => {
              atomicAdd(stats.element(uint(SEED_LOS)), uint(1));
            });
          });
        });
      }

      // ── THE SPATIAL FALLBACK (header note above) ─────────────────────────
      // Only consulted when the cascade parent is unusable. The LOD+1 probe
      // is found by KEY (same cascade, the containing cell one LOD up), via
      // the flag-checked probe lookup — the block-only lookup would read a
      // same-frame-fresh probe's previous owner (trap 3 again).
      const spBlock = uint(SLOT_EMPTY).toVar();
      if (spatial) {
        const lookupProbe = lookups[c];
        If(parentUsable.equal(uint(0)), () => {
          const key = probeTable.element(w.add(uint(PROBE_KEY))).toVar();
          const lod = keyLod(key).toVar();
          If(lod.add(int(1)).lessThan(int(maxLods)), () => {
            const sL = probeSpacing(c, lod, spacing0).toVar();
            // §16 D2b, arm-aware. World keys: floor-division by 2 (negatives
            // included) is the containing cell one LOD up on a world-anchored
            // lattice whose spacing doubles. Anchor arm: cell indices CANNOT
            // be halved (each spacing snaps its own `latticeOrigin`), so
            // re-key by POSITION exactly as the populate pass [B] would —
            // this key's world position, `nearestCell` on the LOD+1 lattice.
            const cellL1 = (worldKeys
              ? ivec3(floor(vec3(keyWorldCell(key, camera, sL)).mul(0.5)))
              : nearestCell(
                  cellPosition(keyCell(key), latticeOrigin(anchor, sL), sL),
                  latticeOrigin(anchor, sL.mul(2)),
                  sL.mul(2),
                )).toVar();
            const sp = uint(lookupProbe(packProbeKey(lod.add(int(1)), keySecondary(key), cellL1))).toVar();
            If(sp.notEqual(uint(SLOT_EMPTY)), () => {
              const spw = sp.mul(uint(PROBE_WORDS)).toVar();
              const spFlags = probeTable.element(spw.add(uint(PROBE_FLAGS))).toVar();
              const spb = probeTable.element(spw.add(uint(PROBE_BLOCK))).toVar();
              If(spFlags.bitAnd(uint(FLAG_ALIVE)).notEqual(uint(0))
                .and(spFlags.bitAnd(uint(FLAG_FRESH)).equal(uint(0)))
                .and(spb.notEqual(uint(SLOT_EMPTY))), () => {
                spBlock.assign(spb);
              });
              if (losSegment) {
                // The same wall test for the spatial candidate.
                If(spBlock.notEqual(uint(SLOT_EMPTY)), () => {
                  const childPos = (worldKeys
                    ? vec3(keyWorldCell(key, camera, sL)).mul(sL)
                    : cellPosition(keyCell(key), latticeOrigin(anchor, sL), sL)).toVar();
                  const sP = sL.mul(2).toVar();
                  const spPos = (worldKeys
                    ? vec3(cellL1).mul(sP)
                    : cellPosition(cellL1, latticeOrigin(anchor, sP), sP)).toVar();
                  If(float(losSegment(childPos, spPos)).lessThan(0.5), () => {
                    spBlock.assign(uint(SLOT_EMPTY));
                    If(first, () => {
                      atomicAdd(stats.element(uint(SEED_LOS)), uint(1));
                    });
                  });
                });
              }
            });
          });
        });
      }

      // Nothing to seed from: tally as before (orphan = no parent cell at
      // all; cold = a fresh/blockless column) and keep today's from-zero.
      const noSource = parentUsable.equal(uint(0)).and(spBlock.equal(uint(SLOT_EMPTY))).toVar();
      If(noSource, () => {
        If(first, () => {
          If(parent.equal(uint(SLOT_EMPTY)), () => {
            atomicAdd(stats.element(uint(SEED_ORPHAN)), uint(1));
          }).Else(() => {
            atomicAdd(stats.element(uint(SEED_COLD)), uint(1));
          });
          // §11.16: counted as a far-only probe; the bins below take the
          // far-field prior where it is primed.
          if (farOn) atomicAdd(stats.element(uint(SEED_FAR_PROBES)), uint(1));
        });
        // Without the far field there is nothing to write: today's from-zero.
        if (!farOn) Return();
      });
      If(noSource.not(), () => {
        If(first, () => {
          atomicAdd(stats.element(uint(SEED_PROBES)), uint(1));
          If(spBlock.notEqual(uint(SLOT_EMPTY)), () => {
            atomicAdd(stats.element(uint(SEED_SPATIAL)), uint(1));
          });
        });
      });

      // The prior's weight in fixed-point count units. Everything below is
      // proportional to it, which is what makes 0 the in-page off arm.
      const W = float(seedRays).mul(float(DEPOSIT_SCALE)).max(0).toVar();
      // §11.16: the far prior's own weight and value. Unprimed (alpha 0 — the
      // first frames, or a build whose far-field passes never ran) seeds
      // nothing, exactly like a missing parent.
      const Wf = farOn ? float(seedFarRays).mul(float(DEPOSIT_SCALE)).max(0).toVar() : null;
      const farTexel = farOn ? farField.node.load(ivec2(2, 0)).toVar() : null;
      const farReady = farOn ? farTexel.w.greaterThan(0.5).and(Wf.greaterThanEqual(1)).toVar() : null;
      const farUnit = farOn
        ? farTexel.xyz.div(Math.PI).div(float(lmax).max(1e-6)).clamp(0, SEED_MAX_UNIT).toVar()
        : null;
      const Wfu = farOn ? Wf.add(0.5).floor().toUint().toVar() : null;
      if (farOn) {
        If(W.lessThan(1).and(farReady.not()), () => { Return(); });
      } else {
        If(W.lessThan(1), () => { Return(); });
      }
      const Wu = W.add(0.5).floor().toUint().toVar();

      const mBase = group.mul(uint(groupBins)).toVar();
      Loop({ start: uint(0), end: uint(groupBins), type: "uint", condition: "<" }, ({ i: j }) => {
        const m = mBase.add(j).toVar();
        const pL = vec3(0).toVar();
        const pT = float(0).toVar();
        const known = float(0).toVar();
        If(spBlock.notEqual(uint(SLOT_EMPTY)), () => {
          // SPATIAL source: same cascade, LOD+1 — SAME bin count and the SAME
          // direction convention, so bin m reads bin m, no 4→1.
          const source = readPayload(payload, uint(capAt(cap.binBase, c)).add(spBlock.mul(uint(nBins))).add(m));
          If(source.T.greaterThanEqual(0), () => {
            pL.assign(source.L);
            pT.assign(source.T);
            known.assign(1);
          });
        }).Else(() => {
          // srcMerge [G.3]'s 4→1 pre-average, same direction convention: the
          // parent's four finer bins for child bin m are `4m…4m+3`, one aligned
          // Morton run. Getting it backwards reads another DIRECTION's radiance
          // — a hue rotation no energy check can see (the merge's own warning).
          // The top cascade (far arm) has no parent block to read: `known`
          // stays 0 and the bin takes the far field below.
          if (parentInfo) {
            If(parentUsable.equal(uint(1)), () => {
              const pBase = uint(capAt(cap.binBase, c + 1))
                .add(pblock.mul(uint(parentInfo.bins)))
                .add(m.mul(uint(4)))
                .toVar();
              for (let k = 0; k < 4; k++) {
                const parent = readPayload(payload, pBase.add(uint(k)));
                If(parent.T.greaterThanEqual(0), () => {
                  pL.addAssign(parent.L);
                  pT.addAssign(parent.T);
                  known.addAssign(1);
                });
              }
            });
          }
        });
        If(known.greaterThan(0), () => {
          const inv = float(1).div(known).toVar();
          // Into the deposit's fixed point: BIN_R carries `L/Lmax · 2^16` per
          // ray-weight, BIN_COUNT carries `2^16` per ray — seeding W of count
          // and `unit·W` of radiance makes the resolve's `ΣR/Σcount · Lmax`
          // read back exactly the parent's mean at weight `seedRays`.
          const unit = pL.mul(inv).div(float(lmax).max(1e-6))
            .clamp(0, SEED_MAX_UNIT).toVar();
          const slot = uint(capAt(cap.binBase, c))
            .add(block.mul(uint(nBins)))
            .add(m)
            .mul(uint(BIN_WORDS))
            .toVar();
          atomicAdd(scratch.element(slot.add(uint(BIN_R))), unit.x.mul(W).add(0.5).floor().toUint());
          atomicAdd(scratch.element(slot.add(uint(BIN_G))), unit.y.mul(W).add(0.5).floor().toUint());
          atomicAdd(scratch.element(slot.add(uint(BIN_B))), unit.z.mul(W).add(0.5).floor().toUint());
          atomicAdd(
            scratch.element(slot.add(uint(BIN_T))),
            pT.mul(inv).clamp(0, 1).mul(W).add(0.5).floor().toUint(),
          );
          atomicAdd(scratch.element(slot.add(uint(BIN_COUNT))), Wu);
          atomicAdd(stats.element(uint(SEED_BINS)), uint(1));
        });
        // ── §11.16: NO PARENT ANSWER FOR THIS BIN → THE FAR-FIELD PRIOR ────
        // Radiance E_far/π so the seeded tile reads E_far; T = 0, the merged
        // domain, same hand-over algebra as the parent seed (header).
        if (farOn) {
          If(known.equal(0).and(farReady), () => {
            const slot = uint(capAt(cap.binBase, c))
              .add(block.mul(uint(nBins)))
              .add(m)
              .mul(uint(BIN_WORDS))
              .toVar();
            atomicAdd(scratch.element(slot.add(uint(BIN_R))), farUnit.x.mul(Wf).add(0.5).floor().toUint());
            atomicAdd(scratch.element(slot.add(uint(BIN_G))), farUnit.y.mul(Wf).add(0.5).floor().toUint());
            atomicAdd(scratch.element(slot.add(uint(BIN_B))), farUnit.z.mul(Wf).add(0.5).floor().toUint());
            atomicAdd(scratch.element(slot.add(uint(BIN_COUNT))), Wfu);
            atomicAdd(stats.element(uint(SEED_FAR)), uint(1));
          });
        }
      });
    })().compute(info.probeCapacity * groups));
  }

  return {
    passes,
    stats,
    /** The GPU buffers that die with this bundle (releaseCompute's teardown walk). */
    get storageAttributes() {
      return [stats].map((n) => n?.value).filter(Boolean);
    },
    bytes: SEED_WORDS * 4,

    /**
     * One frame's seed telemetry. `cold` is the number to watch on a fast pan:
     * it is the fresh probes whose parent was ALSO born this frame — a column
     * the ladder could not seed, i.e. exactly where §12.59.2's deferred
     * spatial-neighbour fallback would act if the pan numbers demand it.
     */
    async readStats(renderer) {
      const allocated = !!renderer?.backend?.get?.(stats.value)?.buffer;
      if (!allocated) return { dispatched: false, probes: 0, bins: 0 };
      const v = new Uint32Array(await renderer.getArrayBufferAsync(stats.value));
      return {
        dispatched: true,
        probes: v[SEED_PROBES] >>> 0,
        orphans: v[SEED_ORPHAN] >>> 0,
        cold: v[SEED_COLD] >>> 0,
        bins: v[SEED_BINS] >>> 0,
        spatial: v[SEED_SPATIAL] >>> 0,
        noBlock: v[SEED_NOBLOCK] >>> 0,
        los: v[SEED_LOS] >>> 0,
        far: v[SEED_FAR] >>> 0,
        farProbes: v[SEED_FAR_PROBES] >>> 0,
      };
    },

    dispose() {
      stats?.value?.dispose?.();
    },
  };
}

/** The per-frame seed line, for the telemetry log. */
export function formatSrcSeed(s) {
  if (!s?.dispatched) return "";
  return `seed ${s.probes} probes / ${s.bins} bins` +
    (s.spatial ? ` (${s.spatial} via LOD+1 spatial)` : "") +
    (s.cold ? ` (${s.cold} cold)` : "") +
    (s.orphans ? ` (${s.orphans} orphan)` : "") +
    (s.noBlock ? ` (${s.noBlock} noblock)` : "") +
    (s.far ? ` (${s.farProbes} far-only probes, ${s.far} far bins)` : "");
}
