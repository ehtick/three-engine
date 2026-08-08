// SPLIT RADIANCE CASCADES — the CPU reference implementation.
//
// This is the whole algorithm in plain JS: probe insertion, Alg. 3 ray
// bookkeeping, split deposit, resolve, merge, irradiance bake, screen gather.
// It exists for three jobs, in order of importance:
//
//   1. GROUND TRUTH for the Phase-0 suite. Every structural property the paper
//      claims (contiguous intervals, contiguous R2 segments, exact 4→1 parent
//      mapping, key bijection, renormalized sparse interpolation) is checkable
//      here with no GPU in the loop, and a property that cannot be stated in
//      100 lines of JS is a property nobody actually understands yet.
//   2. THE MIRROR each GPU kernel is diffed against on a frozen frame. The bvh
//      and occupancy suites set this pattern; it is the only method that has
//      ever attributed a TSL soft error in this module before it shipped as a
//      "mysterious darkening".
//   3. AN EXECUTABLE SPEC. When the WGSL and this disagree, this is the
//      document that says which one is wrong.
//
// It is NOT a performance path and never runs in the engine. Clarity beats
// speed in every trade here — the GPU version is the fast one, and its right
// to be clever is earned by this file being obvious.
//
// docs/GI_SRC_REBUILD_PLAN.md §4.1 steps [B]–[I], §7 Phase 0.

import {
  CASCADE_COUNT,
  MAX_LODS,
  W0,
  binCount,
  binGridWidth,
  IRRADIANCE_TILE_BORDER,
  IRRADIANCE_TILE_INTERIOR,
  intervalBoundaries,
  lodAtDistance,
  lodShells,
  probeSpacing,
} from "./srcConfig.js";
import {
  KEY_EMPTY,
  binMorton,
  cellPosition,
  decodeDir,
  dirToBin,
  hashKey,
  nearestCell,
  octahedralDirection,
  packProbeKey,
  preAverage,
  rayDirection,
  resolveBin,
  splitDeposits,
  sparseGather,
  trilinearCorners,
  unpackProbeKey,
} from "./srcMath.js";

/**
 * Resolved run configuration. `anchor` is the LOD lattice origin — in the
 * engine it is the camera position re-quantized on large moves and NEVER per
 * frame (a per-frame re-anchor is a per-frame probe retirement, i.e. exactly
 * the binary flip R1 forbids).
 */
export function makeSrcConfig(options = {}) {
  const spacing0 = options.spacing0 ?? 0.5;
  const w0 = options.w0 ?? W0;
  const cascadeCount = options.cascadeCount ?? CASCADE_COUNT;
  return {
    spacing0,
    w0,
    cascadeCount,
    maxLods: options.maxLods ?? MAX_LODS,
    raysPerPixel: options.raysPerPixel ?? 1,
    camera: options.camera ?? [0, 0, 0],
    anchor: options.anchor ?? [0, 0, 0],
    // Uniform sky radiance a ray composites when it escapes the last cascade.
    sky: options.sky ?? [0, 0, 0],
    jitter: options.jitter ?? [0, 0],
    // Fixed LOD override — the Phase-0 arms that are not about LODs pin this
    // to 0 so an unrelated LOD boundary cannot explain a failure.
    forceLod: options.forceLod ?? null,
  };
}

/** Lattice origin for (cascade, lod) — the anchor snapped onto that lattice. */
export function latticeOrigin(cfg, cascade, lod) {
  const s = probeSpacing(cascade, lod, cfg.spacing0);
  return [
    Math.round(cfg.anchor[0] / s) * s,
    Math.round(cfg.anchor[1] / s) * s,
    Math.round(cfg.anchor[2] / s) * s,
  ];
}

// ══════════════════════════════════════════════════════════ THE PROBE MAP
//
// CPU mirror of the GPU hashmap: open addressing, linear probing, one map per
// cascade. The GPU insert is a single `atomicCompareExchangeWeak` on the
// packed key; here it is a compare-and-set in a loop, which has the same
// observable semantics (first writer wins, every later writer finds its own
// key and returns the existing slot) without needing atomics to say so.
//
// Eviction is "don't re-insert" — the map is rebuilt every frame from the
// surviving indirection entries, so there is no deletion path to get wrong.

export class SrcProbeMap {
  constructor(capacity) {
    // Power of two so the slot mask is a bitwise and, exactly as in WGSL.
    let cap = 16;
    while (cap < capacity * 2) cap *= 2;
    this.capacity = cap;
    this.keys = new Uint32Array(cap); // 0 = EMPTY
    this.slots = new Int32Array(cap).fill(-1);
    this.probes = []; // indirection buffer: the actual per-probe records
    this.probeSteps = 0; // telemetry: total probe-sequence steps taken
    this.inserts = 0;
  }

  /** Find-or-create. Returns the indirection slot index, or -1 when full. */
  insert(key, makeProbe) {
    if (key === KEY_EMPTY) return -1;
    const mask = this.capacity - 1;
    let slot = hashKey(key) & mask;
    for (let step = 0; step < this.capacity; step++) {
      this.probeSteps++;
      const existing = this.keys[slot];
      if (existing === key) return this.slots[slot];
      if (existing === KEY_EMPTY) {
        this.keys[slot] = key;
        const index = this.probes.length;
        this.probes.push(makeProbe(key, index));
        this.slots[slot] = index;
        this.inserts++;
        return index;
      }
      slot = (slot + 1) & mask;
    }
    return -1;
  }

  /** Lookup only — no insert. Returns the slot index or -1. */
  find(key) {
    if (key === KEY_EMPTY) return -1;
    const mask = this.capacity - 1;
    let slot = hashKey(key) & mask;
    for (let step = 0; step < this.capacity; step++) {
      const existing = this.keys[slot];
      if (existing === key) return this.slots[slot];
      if (existing === KEY_EMPTY) return -1;
      slot = (slot + 1) & mask;
    }
    return -1;
  }

  get loadFactor() {
    return this.probes.length / this.capacity;
  }
}

// ═══════════════════════════════════════════ [B] + [C]  PROBE POPULATION
//
// Per pixel: pick the LOD from the Chebyshev camera distance, insert the
// NEAREST c0 cell — one probe, not the 8 trilinear corners. The authors
// measured corner insertion as 2× the probes for little quality gain, and the
// sparse renormalized gather is what makes the missing corners harmless.
//
// Then the cascade ladder: each c(i−1) probe inserts its nearest c(i) probe
// and keeps the link, which is simultaneously the merge's parent pointer and
// Alg. 3's count-propagation edge.

/**
 * @param {Array<{position:[number,number,number], normal:[number,number,number]}>} pixels
 * @returns {{cascades: SrcProbeMap[], pixelProbe: Int32Array}}
 */
export function buildProbes(cfg, pixels) {
  const cascades = [];
  for (let c = 0; c < cfg.cascadeCount; c++) {
    cascades.push(new SrcProbeMap(Math.max(64, pixels.length >> c)));
  }
  const pixelProbe = new Int32Array(pixels.length).fill(-1);

  const makeProbe = (cascade, lod) => (key, index) => {
    const u = unpackProbeKey(key);
    const origin = latticeOrigin(cfg, cascade, lod);
    const s = probeSpacing(cascade, lod, cfg.spacing0);
    return {
      key,
      index,
      cascade,
      lod: u.lod,
      secondary: u.secondary,
      cell: [u.cx, u.cy, u.cz],
      position: cellPosition(u.cx, u.cy, u.cz, origin[0], origin[1], origin[2], s),
      spacing: s,
      parent: -1,
      children: [],
      rayCount: 0,
      rayOffset: 0,
      age: 0,
      fresh: true,
      // Per-bin deposit accumulators, allocated lazily by depositRay.
      bins: null,
    };
  };

  // ── c0 from pixels ────────────────────────────────────────────────────────
  for (let p = 0; p < pixels.length; p++) {
    const px = pixels[p];
    const lodF =
      cfg.forceLod != null
        ? cfg.forceLod
        : lodAtDistance(
            Math.max(
              Math.abs(px.position[0] - cfg.camera[0]),
              Math.abs(px.position[1] - cfg.camera[1]),
              Math.abs(px.position[2] - cfg.camera[2]),
            ),
            cfg.spacing0,
            cfg.maxLods,
          );
    const lod = Math.floor(lodF);
    const origin = latticeOrigin(cfg, 0, lod);
    const s = probeSpacing(0, lod, cfg.spacing0);
    const cell = nearestCell(
      px.position[0], px.position[1], px.position[2],
      origin[0], origin[1], origin[2], s,
    );
    const key = packProbeKey(lod, false, cell.cx, cell.cy, cell.cz);
    const slot = cascades[0].insert(key, makeProbe(0, lod));
    pixelProbe[p] = slot;
  }

  // ── the ladder: c(i−1) probe inserts its nearest c(i) probe ───────────────
  for (let c = 1; c < cfg.cascadeCount; c++) {
    const child = cascades[c - 1];
    const parentMap = cascades[c];
    for (const probe of child.probes) {
      const origin = latticeOrigin(cfg, c, probe.lod);
      const s = probeSpacing(c, probe.lod, cfg.spacing0);
      const cell = nearestCell(
        probe.position[0], probe.position[1], probe.position[2],
        origin[0], origin[1], origin[2], s,
      );
      const key = packProbeKey(probe.lod, probe.secondary, cell.cx, cell.cy, cell.cz);
      const slot = parentMap.insert(key, makeProbe(c, probe.lod));
      probe.parent = slot;
      if (slot >= 0) parentMap.probes[slot].children.push(probe.index);
    }
  }
  return { cascades, pixelProbe };
}

// ═════════════════════════════════════════════════ [D] ALG. 3 RAY BUDGETING
//
// Counts propagate UP (a parent's count is the sum of its children's), then
// offsets are handed DOWN so that every probe sharing a parent occupies a
// CONTIGUOUS segment of the one global R2 sequence.
//
// That contiguity is the whole reason the far cascades are usable: a coarse
// probe's 512 direction bins are covered semi-uniformly because the rays that
// reach it are a contiguous R2 run, and contiguous R2 runs are individually
// well-distributed. Hand each child an arbitrary scatter of indices instead
// and the parent's bin coverage becomes a lottery — some bins get eight rays,
// some get none, and the zero-count bins are exactly the ones the merge then
// has to renormalize around.
//
// On the GPU this is a hierarchical prefix sum. Here it is two ordinary loops,
// which is the point: the property is checkable without the scan.

export function assignRays(cfg, built) {
  const { cascades } = built;
  // Counts at c0 come from the pixels that landed on each probe.
  for (const probe of cascades[0].probes) probe.rayCount = 0;
  for (let p = 0; p < built.pixelProbe.length; p++) {
    const slot = built.pixelProbe[p];
    if (slot >= 0) cascades[0].probes[slot].rayCount += cfg.raysPerPixel;
  }
  // Propagate up.
  for (let c = 1; c < cfg.cascadeCount; c++) {
    for (const probe of cascades[c].probes) probe.rayCount = 0;
    for (const child of cascades[c - 1].probes) {
      if (child.parent >= 0) cascades[c].probes[child.parent].rayCount += child.rayCount;
    }
  }
  // Offsets top-down. The top cascade's probes partition [0, total).
  const top = cfg.cascadeCount - 1;
  let running = 0;
  for (const probe of cascades[top].probes) {
    probe.rayOffset = running;
    running += probe.rayCount;
  }
  const totalRays = running;
  for (let c = top; c >= 1; c--) {
    for (const parent of cascades[c].probes) {
      let cursor = parent.rayOffset;
      for (const childIndex of parent.children) {
        const child = cascades[c - 1].probes[childIndex];
        child.rayOffset = cursor;
        cursor += child.rayCount;
      }
    }
  }
  // Finally hand each pixel its own slice of its c0 probe's segment.
  const pixelRayBase = new Int32Array(built.pixelProbe.length).fill(-1);
  const cursors = new Map();
  for (let p = 0; p < built.pixelProbe.length; p++) {
    const slot = built.pixelProbe[p];
    if (slot < 0) continue;
    const probe = cascades[0].probes[slot];
    const cursor = cursors.get(slot) ?? probe.rayOffset;
    pixelRayBase[p] = cursor;
    cursors.set(slot, cursor + cfg.raysPerPixel);
  }
  return { totalRays, pixelRayBase };
}

// ═══════════════════════════════════════════════ [E] + [F]  TRACE + DEPOSIT
//
// A ray from a pixel deposits into the ANCESTOR CHAIN of that pixel's c0
// probe: the cascade-k deposit lands on the chain's cascade-k probe. So one
// full-length ray writes into up to N probes — that is the "split" in Split
// Radiance Cascades, and it is why a cascade never traces its own rays.

function ensureBins(probe, cfg) {
  if (probe.bins) return probe.bins;
  const n = binCount(probe.cascade, cfg.w0);
  probe.bins = {
    sumR: new Float64Array(n),
    sumG: new Float64Array(n),
    sumB: new Float64Array(n),
    sumT: new Float64Array(n),
    count: new Uint32Array(n),
  };
  return probe.bins;
}

/** The ancestor chain of a c0 probe: [c0 slot, c1 slot, ...], -1 where absent. */
export function ancestorChain(built, c0Slot, cascadeCount) {
  const chain = new Array(cascadeCount).fill(-1);
  let slot = c0Slot;
  for (let c = 0; c < cascadeCount && slot >= 0; c++) {
    chain[c] = slot;
    slot = built.cascades[c].probes[slot].parent;
  }
  return chain;
}

/**
 * Trace every ray and scatter its split deposits.
 *
 * `sceneTrace(origin, dir)` returns `{ t, radiance }` with `t < 0` for a miss —
 * the same contract `srcTrace.js` exposes on the GPU, so this function's body
 * is the kernel's body.
 */
export function traceAndDeposit(cfg, built, pixels, rays, sceneTrace) {
  const stats = { traced: 0, hits: 0, escapes: 0, deposits: 0 };
  for (let p = 0; p < pixels.length; p++) {
    const c0Slot = built.pixelProbe[p];
    if (c0Slot < 0) continue;
    const px = pixels[p];
    const chain = ancestorChain(built, c0Slot, cfg.cascadeCount);
    const lod = built.cascades[0].probes[c0Slot].lod;
    const bounds = intervalBoundaries(lod, cfg.spacing0, cfg.cascadeCount);
    const base = rays.pixelRayBase[p];
    for (let r = 0; r < cfg.raysPerPixel; r++) {
      const dir = rayDirection(
        base + r,
        px.normal[0], px.normal[1], px.normal[2],
        cfg.jitter[0], cfg.jitter[1],
      );
      const hit = sceneTrace(px.position, dir);
      stats.traced++;
      if (hit.t >= 0) stats.hits++;
      else stats.escapes++;
      const deposits = splitDeposits(hit.t >= 0 ? hit.t : -1, hit.radiance ?? [0, 0, 0], bounds);
      for (const dep of deposits) {
        const slot = chain[dep.cascade];
        if (slot < 0) continue;
        const probe = built.cascades[dep.cascade].probes[slot];
        const w = binGridWidth(dep.cascade, cfg.w0);
        const bin = dirToBin(dir[0], dir[1], dir[2], w);
        const m = binMorton(bin.i, bin.j);
        const bins = ensureBins(probe, cfg);
        bins.sumR[m] += dep.radiance[0];
        bins.sumG[m] += dep.radiance[1];
        bins.sumB[m] += dep.radiance[2];
        bins.sumT[m] += dep.transmittance;
        bins.count[m] += 1;
        stats.deposits++;
      }
    }
  }
  return stats;
}

/** Resolve fixed-point-style accumulators into per-bin values (null = unknown). */
export function resolveProbes(cfg, built) {
  const resolved = [];
  for (let c = 0; c < cfg.cascadeCount; c++) {
    const perProbe = [];
    for (const probe of built.cascades[c].probes) {
      const n = binCount(c, cfg.w0);
      const values = new Array(n).fill(null);
      if (probe.bins) {
        for (let m = 0; m < n; m++) {
          values[m] = resolveBin(
            probe.bins.sumR[m], probe.bins.sumG[m], probe.bins.sumB[m],
            probe.bins.sumT[m], probe.bins.count[m],
          );
        }
      }
      perProbe.push(values);
    }
    resolved.push(perProbe);
  }
  return resolved;
}

// ═════════════════════════════════════════════════════════════ [G] MERGE
//
// Cascade N−1 → 0. Each bin takes its own interval, then lets through whatever
// it did not block from the sparse-trilinear-interpolated, 4→1 pre-averaged
// parent. The top cascade's "parent" is the sky.

export function mergeCascades(cfg, built, resolved) {
  const merged = new Array(cfg.cascadeCount);
  const top = cfg.cascadeCount - 1;

  // The top cascade merges against the sky: nothing above it to interpolate.
  merged[top] = built.cascades[top].probes.map((probe, i) => {
    const n = binCount(top, cfg.w0);
    const out = new Array(n).fill(null);
    for (let m = 0; m < n; m++) {
      const self = resolved[top][i][m];
      if (!self) continue;
      out[m] = {
        radiance: [
          self.radiance[0] + self.transmittance * cfg.sky[0],
          self.radiance[1] + self.transmittance * cfg.sky[1],
          self.radiance[2] + self.transmittance * cfg.sky[2],
        ],
        // Transmittance is CONSUMED by the sky composite — nothing above the
        // last cascade can still be occluded, so leaving it non-zero would let
        // a caller composite the sky a second time.
        transmittance: 0,
      };
    }
    void probe;
    return out;
  });

  for (let c = top - 1; c >= 0; c--) {
    const parentCascade = c + 1;
    merged[c] = built.cascades[c].probes.map((probe, i) => {
      const n = binCount(c, cfg.w0);
      const out = new Array(n).fill(null);
      // The parent lattice this probe interpolates over.
      const s = probeSpacing(parentCascade, probe.lod, cfg.spacing0);
      const origin = latticeOrigin(cfg, parentCascade, probe.lod);
      const corners = trilinearCorners(
        probe.position[0], probe.position[1], probe.position[2],
        origin[0], origin[1], origin[2], s,
      );
      for (let m = 0; m < n; m++) {
        const self = resolved[c][i][m];
        if (!self) continue;
        // ── THE DIRECTION OF THE 4→1 MAPPING ────────────────────────────────
        // Bins get FINER as the cascade index rises (|D_i| = 2·w₀²·4^i), so
        // the cascade ABOVE has four bins for every one of ours, and what this
        // level consumes is their PRE-AVERAGE. Morton order is what makes
        // those four contiguous: they are exactly slots 4m … 4m+3 (proved in
        // the Phase-0 suite's Morton-contiguity arm), so this is one aligned
        // fetch on the GPU rather than four strided ones.
        //
        // Getting this backwards — halving our own bin index to index the
        // level above — silently reads a bin pointing somewhere else entirely.
        // It costs no energy and throws no error; it just delivers the wrong
        // direction's radiance, which reads as a hue rotation that survives
        // every energy check. The furnace arm catches it only because a
        // furnace is direction-independent everywhere except at the seams.
        const gathered = sparseGather(
          corners,
          (cx, cy, cz) => {
            const key = packProbeKey(probe.lod, probe.secondary, cx, cy, cz);
            const slot = built.cascades[parentCascade].find(key);
            if (slot < 0) return null;
            return preAverageChildBins(merged[parentCascade][slot], m);
          },
          (acc, v, weight) => {
            acc.r += v.radiance[0] * weight;
            acc.g += v.radiance[1] * weight;
            acc.b += v.radiance[2] * weight;
            acc.t += v.transmittance * weight;
            return acc;
          },
          () => ({ r: 0, g: 0, b: 0, t: 0 }),
        );
        if (!gathered) {
          // No parent probe existed. NOT a black vote — the bin keeps its own
          // interval and stays transparent above it, so temporal accumulation
          // can fill it in later frames. A fixed-radius fallback here is
          // exactly the cliff R1 forbids.
          out[m] = { radiance: self.radiance.slice(), transmittance: self.transmittance };
          continue;
        }
        const inv = 1 / gathered.weight;
        const parentL = [
          gathered.value.r * inv,
          gathered.value.g * inv,
          gathered.value.b * inv,
        ];
        const parentT = gathered.value.t * inv;
        out[m] = {
          radiance: [
            self.radiance[0] + self.transmittance * parentL[0],
            self.radiance[1] + self.transmittance * parentL[1],
            self.radiance[2] + self.transmittance * parentL[2],
          ],
          transmittance: self.transmittance * parentT,
        };
      }
      return out;
    });
  }
  return merged;
}

/** Morton → (i, j). Local helper so mergeCascades reads in bin space. */
function mortonToBinPair(m) {
  let i = 0;
  let j = 0;
  for (let b = 0; b < 16; b++) {
    i |= ((m >>> (2 * b)) & 1) << b;
    j |= ((m >>> (2 * b + 1)) & 1) << b;
  }
  return { i, j };
}

/**
 * Pre-average a probe's four child bins into the value the next level up
 * consumes (paper §6). Exposed so the Phase-0 suite can check the 4→1
 * contiguity claim against `binMorton` directly.
 */
export function preAverageChildBins(values, parentMorton) {
  const base = parentMorton * 4;
  return preAverage([values[base], values[base + 1], values[base + 2], values[base + 3]]);
}

// ══════════════════════════════════════════════════════ [H] IRRADIANCE BAKE
//
// Per probe, bake the Lambertian rendering-equation integral into a 6×6
// octahedral tile. Pixels then take ≤8 FILTERED samples of these tiles in the
// normal direction — which is the whole reason this pass exists: a raw
// per-pixel gather over 32 dirs × 8 probes is 256 unfiltered reads, and the
// paper calls that out as prohibitive.
//
// THE NORMALIZATION IS LOAD-BEARING (R4):
//
//     E(n̂) = π · Σ L_bin·max(0, ω_bin·n̂) / Σ max(0, ω_bin·n̂)
//
// not `Δω · Σ L·cos`. The two agree in the limit, but the normalized form is
// EXACT for uniform radiance at ANY bin count — feed it L = 1 everywhere and
// it returns exactly π, so ρ/π·E is exactly ρ. That makes the furnace test a
// statement about the estimator rather than about discretization error, and it
// is what bounds the multibounce loop's gain below 1 by construction.

/**
 * The per-(bin, tile-texel) cosine weight table:
 *
 *     W(bin, n̂) = ⟨max(0, ω·n̂)⟩ over the bin's solid angle
 *
 * NOT `max(0, ω_centre·n̂)`, and that distinction is worth an essay because it
 * is a bias the convergence sweep caught red-handed.
 *
 * A c0 bin is 4π/32 ≈ 0.39 sr — about 40° across. Evaluating the cosine at its
 * CENTRE and calling that the bin's contribution is a one-point quadrature over
 * a 40° cone, and the error it leaves is ANGULAR: refining probe spacing cannot
 * reduce it, because s0 buys spatial resolution and this is a directional
 * integral. The Phase-0 sweep showed exactly that fingerprint — 32.2% → 30.0%
 * → 28.6% across two halvings of s0, i.e. flat. A blur shrinks; a bias sits
 * there, and telling them apart is the entire reason that arm measures
 * convergence instead of comparing against a tolerance.
 *
 * (This is the same class as the "frozen texel-centre cosine" the plan's §1
 * table blames for the dense backend's settled-panel residual. It survived the
 * architecture change because it was never in the transport — it was in the
 * bake.)
 *
 * The fix is a proper quadrature: sub-sample each bin. Because the bins are
 * EQUAL-AREA in (x, y), uniform sub-sampling in (x, y) is uniform in solid
 * angle, so a plain mean over sub-samples IS the solid-angle average — no
 * Jacobian, no weights. The table depends only on (w, tileRes, sub), never on
 * the scene, so it is computed once and shared by every probe; on the GPU it is
 * a small read-only buffer (32 bins × 36 texels at c0).
 */
const cosWeightCache = new Map();
export function binCosineWeights(w, tileRes, sub = 4) {
  const key = `${w}|${tileRes}|${sub}`;
  const hit = cosWeightCache.get(key);
  if (hit) return hit;
  const nBins = 2 * w * w;
  const texels = tileRes * tileRes;
  const table = new Float64Array(nBins * texels);
  // Texel normals, hoisted.
  const normals = new Array(texels);
  for (let v = 0; v < tileRes; v++) {
    for (let u = 0; u < tileRes; u++) normals[v * tileRes + u] = octahedralDirection(u, v, tileRes);
  }
  const invSub = 1 / (sub * sub);
  for (let j = 0; j < w; j++) {
    for (let i = 0; i < 2 * w; i++) {
      const m = binMorton(i, j);
      for (let sy = 0; sy < sub; sy++) {
        for (let sx = 0; sx < sub; sx++) {
          const x = (i + (sx + 0.5) / sub) / (2 * w);
          const y = (j + (sy + 0.5) / sub) / w;
          const d = decodeDir(x, y);
          for (let t = 0; t < texels; t++) {
            const n = normals[t];
            const cos = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
            if (cos > 0) table[m * texels + t] += cos * invSub;
          }
        }
      }
    }
  }
  cosWeightCache.set(key, table);
  return table;
}

/**
 * Fill the 1-texel border of an octahedral tile (paper §6: "6×6 octahedral
 * irradiance texture + 1-texel border").
 *
 * ══ THE BORDER IS A CORRECTNESS REQUIREMENT, NOT AN OPTIMIZATION ═══════════
 *
 * The octahedral square's CENTRE is +Z, its four CORNERS are all −Z, and its
 * edges run from the ±X/±Y equator points out to those corners. So the exact −Z
 * direction sits precisely on the tile's corner — the one place bilinear
 * filtering has nothing to interpolate toward.
 *
 * Without a border, `sampleTile` clamps, and all four taps for n̂ = (0,0,−1)
 * collapse onto the single interior corner texel, whose own direction at 6×6 is
 * (0.236, 0.236, −0.943) — **19.4° off axis**. The probe then reports the
 * irradiance of a normal tilted toward +X+Y, which in any room with asymmetric
 * walls is a large, systematic, ORIENTATION-DEPENDENT error: measured here as
 * +32% on a −Z-facing receiver, with a blue cast borrowed from the +X wall.
 *
 * It is invisible to every test that does not vary surface orientation, and it
 * is invariant to probe spacing, to ray count and to angular resolution — the
 * Phase-0 convergence sweep found it precisely BECAUSE refining s0 (29.2 →
 * 25.5%) and w0 (26.9 → 25.1%) both plateaued instead of converging. A
 * tolerance-based test would have been "tuned" to 35% and shipped it.
 *
 * ══ THE WRAP RULE ══════════════════════════════════════════════════════════
 *
 * Crossing an edge of the octahedral square continues onto the sphere at the
 * mirrored position on the SAME edge with the other axis negated. In texel
 * terms: an edge's border row is that edge's own texels in REVERSE order, and
 * each corner border texel is the DIAGONALLY OPPOSITE interior corner. With
 * that in place the four taps around −Z become the four directions symmetric
 * about it, and their x/y biases cancel exactly.
 */
export function fillOctahedralBorder(tile, interior, size) {
  const at = (x, y) => (y * size + x) * 3;
  const inner = (x, y) => ((y + 1) * size + (x + 1)) * 3;
  const copy = (dst, src) => {
    tile[dst] = tile[src];
    tile[dst + 1] = tile[src + 1];
    tile[dst + 2] = tile[src + 2];
  };
  const N = interior;
  for (let j = 0; j < N; j++) {
    // Left/right borders mirror their own edge vertically.
    copy(at(0, j + 1), inner(0, N - 1 - j));
    copy(at(N + 1, j + 1), inner(N - 1, N - 1 - j));
  }
  for (let i = 0; i < N; i++) {
    // Top/bottom borders mirror their own edge horizontally.
    copy(at(i + 1, 0), inner(N - 1 - i, 0));
    copy(at(i + 1, N + 1), inner(N - 1 - i, N - 1));
  }
  // Corners take the diagonally opposite interior corner — all four of them are
  // the −Z pole, which is exactly why this line matters more than it looks.
  copy(at(0, 0), inner(N - 1, N - 1));
  copy(at(N + 1, 0), inner(0, N - 1));
  copy(at(0, N + 1), inner(N - 1, 0));
  copy(at(N + 1, N + 1), inner(0, 0));
}

/**
 * Bake per-probe irradiance tiles. Returns `size × size` RGB tiles where
 * `size = interior + 2` — the interior carries the integral, the border carries
 * the octahedral wrap so a bilinear sample in ANY normal direction is correct.
 */
export function bakeProbeIrradiance(cfg, built, merged, cascade = 0, interior = IRRADIANCE_TILE_INTERIOR) {
  const w = binGridWidth(cascade, cfg.w0);
  const nBins = binCount(cascade, cfg.w0);
  const size = interior + 2 * IRRADIANCE_TILE_BORDER;
  const texels = interior * interior;
  const cosTable = binCosineWeights(w, interior);
  const tiles = [];
  for (let i = 0; i < built.cascades[cascade].probes.length; i++) {
    const values = merged[cascade][i];
    const tile = new Float32Array(size * size * 3);
    for (let v = 0; v < interior; v++) {
      for (let u = 0; u < interior; u++) {
        const t = v * interior + u;
        let wr = 0;
        let sr = 0;
        let sg = 0;
        let sb = 0;
        for (let m = 0; m < nBins; m++) {
          const value = values[m];
          if (!value) continue; // unknown bin — excluded, never voted black
          const cw = cosTable[m * texels + t];
          if (!(cw > 0)) continue;
          wr += cw;
          sr += value.radiance[0] * cw;
          sg += value.radiance[1] * cw;
          sb += value.radiance[2] * cw;
        }
        const o = ((v + 1) * size + (u + 1)) * 3;
        if (wr > 0) {
          // π·Σ(L·W)/Σ(W) — exact for uniform L at any bin count (see the header).
          const k = Math.PI / wr;
          tile[o] = sr * k;
          tile[o + 1] = sg * k;
          tile[o + 2] = sb * k;
        }
      }
    }
    fillOctahedralBorder(tile, interior, size);
    tiles.push(tile);
  }
  return tiles;
}

/**
 * Bilinear sample of a bordered probe tile in direction `n̂`.
 *
 * `interior` is the payload resolution (6); the backing array is
 * `(interior + 2)²`. Interior texel (u, v) lives at (u+1, v+1), which is what
 * makes a tap that walks off the interior land on a BORDER texel carrying the
 * correct wrapped value instead of a clamped duplicate — see
 * `fillOctahedralBorder` for why that distinction is worth 32% at the poles.
 */
export function sampleTile(tile, interior, nx, ny, nz) {
  const size = interior + 2 * IRRADIANCE_TILE_BORDER;
  const inv = 1 / (Math.abs(nx) + Math.abs(ny) + Math.abs(nz));
  const px = nx * inv;
  const py = ny * inv;
  let fx = px;
  let fy = py;
  if (nz <= 0) {
    const sx = px >= 0 ? 1 : -1;
    const sy = py >= 0 ? 1 : -1;
    fx = (1 - Math.abs(py)) * sx;
    fy = (1 - Math.abs(px)) * sy;
  }
  // Interior-space continuous coords, then shifted into the bordered atlas.
  const u = (fx * 0.5 + 0.5) * interior - 0.5 + IRRADIANCE_TILE_BORDER;
  const v = (fy * 0.5 + 0.5) * interior - 0.5 + IRRADIANCE_TILE_BORDER;
  const u0 = Math.floor(u);
  const v0 = Math.floor(v);
  const tu = u - u0;
  const tv = v - v0;
  const at = (uu, vv) => {
    const cu = Math.min(size - 1, Math.max(0, uu));
    const cv = Math.min(size - 1, Math.max(0, vv));
    const o = (cv * size + cu) * 3;
    return [tile[o], tile[o + 1], tile[o + 2]];
  };
  const a = at(u0, v0);
  const b = at(u0 + 1, v0);
  const c = at(u0, v0 + 1);
  const d = at(u0 + 1, v0 + 1);
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const top = a[i] * (1 - tu) + b[i] * tu;
    const bot = c[i] * (1 - tu) + d[i] * tu;
    out[i] = top * (1 - tv) + bot * tv;
  }
  return out;
}

// ═══════════════════════════════════════════════════════ [I] SCREEN GATHER
//
// Per pixel: ≤8 nearest c0 probes, sparse-trilinear-renormalized, each
// contributing a filtered tile sample in the pixel's normal direction. LOD
// blending rides on top via `lodBlend` across the ×0.9 overlap.

export function gatherPixel(cfg, built, tiles, position, normal, interior = IRRADIANCE_TILE_INTERIOR) {
  const cheb = Math.max(
    Math.abs(position[0] - cfg.camera[0]),
    Math.abs(position[1] - cfg.camera[1]),
    Math.abs(position[2] - cfg.camera[2]),
  );
  const lodF = cfg.forceLod != null ? cfg.forceLod : lodAtDistance(cheb, cfg.spacing0, cfg.maxLods);
  const shells = lodShells(lodF, cfg.maxLods);

  const out = [0, 0, 0];
  let totalShell = 0;
  for (const shell of shells) {
    if (shell.lod >= cfg.maxLods) continue;
    const s = probeSpacing(0, shell.lod, cfg.spacing0);
    const origin = latticeOrigin(cfg, 0, shell.lod);
    const corners = trilinearCorners(
      position[0], position[1], position[2],
      origin[0], origin[1], origin[2], s,
    );
    const gathered = sparseGather(
      corners,
      (cx, cy, cz) => {
        const key = packProbeKey(shell.lod, false, cx, cy, cz);
        const slot = built.cascades[0].find(key);
        return slot < 0 ? null : slot;
      },
      (acc, slot, weight) => {
        const c = sampleTile(tiles[slot], interior, normal[0], normal[1], normal[2]);
        acc.r += c[0] * weight;
        acc.g += c[1] * weight;
        acc.b += c[2] * weight;
        return acc;
      },
      () => ({ r: 0, g: 0, b: 0 }),
    );
    if (!gathered) continue;
    const inv = 1 / gathered.weight;
    out[0] += gathered.value.r * inv * shell.weight;
    out[1] += gathered.value.g * inv * shell.weight;
    out[2] += gathered.value.b * inv * shell.weight;
    totalShell += shell.weight;
  }
  if (totalShell > 0 && Math.abs(totalShell - 1) > 1e-9) {
    // A shell that had no probes at all must not darken the pixel — the
    // remaining shell carries full weight. Same renormalize-don't-zero rule.
    out[0] /= totalShell;
    out[1] /= totalShell;
    out[2] /= totalShell;
  }
  return out;
}

// ════════════════════════════════════════════════════════ THE WHOLE FRAME

/** One full single-frame pass — the α=1 configuration the quality gate uses. */
export function runSrcFrame(cfg, pixels, sceneTrace) {
  const built = buildProbes(cfg, pixels);
  const rays = assignRays(cfg, built);
  const stats = traceAndDeposit(cfg, built, pixels, rays, sceneTrace);
  const resolved = resolveProbes(cfg, built);
  const merged = mergeCascades(cfg, built, resolved);
  const tiles = bakeProbeIrradiance(cfg, built, merged);
  return { built, rays, stats, resolved, merged, tiles };
}

// ═══════════════════════════════════════════════════ THE ARBITER: BRUTE MC
//
// Ground truth for the merge, independent of every structure above it: Monte
// Carlo the rendering equation at a point with the SAME scene trace. An
// estimate that misses this by more than its own standard error is a
// structural bug; one that misses by less is sampling noise and nothing else.
// (The distinction is the lesson of `run-gi-light-tree-test.mjs`'s arbiter —
// a convergence test with no error bars cannot tell those apart, so it fails
// either always or never.)

export function brutePointIrradiance(position, normal, sceneTrace, sky, samples = 20000, seed = 1) {
  let state = seed >>> 0;
  const rand = () => {
    // mulberry32 — the harness PRNG standard in this repo. Never Math.random.
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const acc = [0, 0, 0];
  const sq = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < samples; i++) {
    // Cosine-weighted hemisphere sample about `normal` — its pdf is cos/π, so
    // the estimator is a plain mean of L and E = π·mean(L).
    const u1 = rand();
    const u2 = rand();
    const r = Math.sqrt(u1);
    const phi = 2 * Math.PI * u2;
    const x = r * Math.cos(phi);
    const y = r * Math.sin(phi);
    const z = Math.sqrt(Math.max(0, 1 - u1));
    // Build an orthonormal basis around the normal (Duff et al. branchless).
    const sign = normal[2] >= 0 ? 1 : -1;
    const a = -1 / (sign + normal[2]);
    const b = normal[0] * normal[1] * a;
    const t1 = [1 + sign * normal[0] * normal[0] * a, sign * b, -sign * normal[0]];
    const t2 = [b, sign + normal[1] * normal[1] * a, -normal[1]];
    const dir = [
      t1[0] * x + t2[0] * y + normal[0] * z,
      t1[1] * x + t2[1] * y + normal[1] * z,
      t1[2] * x + t2[2] * y + normal[2] * z,
    ];
    const hit = sceneTrace(position, dir);
    const L = hit.t >= 0 ? (hit.radiance ?? [0, 0, 0]) : sky;
    for (let k = 0; k < 3; k++) {
      acc[k] += L[k];
      sq[k] += L[k] * L[k];
    }
    n++;
  }
  const mean = acc.map((v) => v / n);
  const stderr = mean.map((m, k) => {
    const variance = Math.max(0, sq[k] / n - m * m);
    return Math.sqrt(variance / n);
  });
  return {
    // E = π·mean(L) under the cosine pdf.
    irradiance: mean.map((m) => m * Math.PI),
    stderr: stderr.map((s) => s * Math.PI),
    samples: n,
  };
}
