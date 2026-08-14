// LIGHT TREE — THE GPU DESCENT (§12.62 Unit W2).
//
// The WGSL/TSL twin of `lightTree.js`'s `sampleLightTree`: the SAME
// importance-weighted descent, the SAME probability rules, the SAME pdf math,
// over the SAME packed u32 block — read through ONE storage buffer, exactly the
// way the production block will be read out of the occupancy `bits` tail.
// `scripts/gi-lighttree-descent.html` is the gate that holds the two together:
// same seeds, same shading points, selected emitter indices EQUAL case by case
// and pdfs within f32 drift of the CPU's f64.
//
// ══ STRUCTURE: NO RECURSION ═════════════════════════════════════════════════
//
// `sampleLightTree` is recursive; WGSL has no recursion. With the production
// `maxSplitDepth = 1` the recursion has exactly one shape: the ROOT either
// SPLITS (strongest child taken with certainty + ONE other sampled among the
// rest) or CHOOSES one child — and every node below the root is choose-one all
// the way to a leaf. So the descent flattens to:
//
//     evaluate root (split? choose?) → up to 2 INDEPENDENT LINEAR DESCENTS
//
// each linear descent being a bounded loop (choose-one per interior node, one
// importance-proportional pick inside the leaf). This file hardcodes that
// shape; a caller wanting a different maxSplitDepth is asking for a different
// kernel, not an option.
//
// ══ THE RNG, AND THE DRAW ORDER CONTRACT ════════════════════════════════════
//
// Counter-based and u32-PURE: state += 0x9e3779b9 (wrapping), then the
// lowbias32 finalizer, then `(h >> 8) * 2^-24`. The top-24-bit form is the
// point — `h / 2^32` rounds on the u32→f32 conversion above 2^24 (the
// srcShade gate's documented hashKey caveat) and would give the two sides
// DIFFERENT u for the same draw. `(h >> 8)` is < 2^24, so its conversion is
// exact in f32 AND in f64: `makeGpuRng` below produces the bit-identical
// sequence in JS, which is what lets the gate demand exact index parity.
//
// DRAW ORDER — must equal sampleLightTree's rng() call order, and does,
// because both sides draw at the same structural points:
//
//   root SPLITS:   [branch A: one draw per interior choose-one node on its
//                   path, then exactly ONE leaf draw]
//                  [ONE draw picking the second branch among the non-top
//                   children]
//                  [branch B: same per-node/per-leaf pattern as A]
//   root CHOOSES:  [ONE root pick draw]
//                  [the single branch's draws, same pattern]
//
// Two invariants keep the streams aligned:
//   · a pick draws ONLY when its candidate mass is positive — the CPU's
//     `pick()` returns −1 *without drawing* when total ≤ 0 (unreachable in
//     practice: both probability rules have a strictly-positive uniform
//     fallback, but mirrored anyway);
//   · a leaf ALWAYS draws exactly once, even with a single emitter —
//     `leafProbabilities` never draws, the pick after it always does.
//
// ══ NUMERICS ════════════════════════════════════════════════════════════════
//
// Every formula is transcribed TERM FOR TERM and in the CPU's evaluation
// order: cosSubClamped/sinSubClamped, the safeSqrt clamps, PBRT's near-field
// `d2 = max(d2, diag/2, 1e-12)` INCLUDING its unit quirk (a length clamping an
// area — it only ever raises d2, a variance knob, never a zero), the
// `cosThetaU = −1` inside-the-cluster case, and the receiver-cosine widening.
// The remaining disagreement is f32-vs-f64 arithmetic, which the gate bounds
// at 1e-4 relative on the pdf.
//
// TWO deliberate evaluation-order deviations, both because the CPU reference
// runs in f64 where its own form is benign, and transcribing that form into
// f32 cancels catastrophically — i.e. the literal transcription lands FARTHER
// from the CPU's value than the algebraically identical rewrite:
//   #1  splitProbabilities' `others = sum − imp[top]` → a direct sum of the
//       non-top importances (measured 1.18e-4 pdf drift from the f32
//       subtraction when the top slot dominates);
//   #2  the complement sqrts: `sinThetaU = sqrt(1 − cosThetaU²)` is the
//       DOUBLE complement `sqrt(1 − (1 − rr²))` = rr, taken as rr directly,
//       and the other `sqrt(1 − c²)` take the factored `(1−c)(1+c)` Sterbenz
//       form (measured 2.15e-4 before, from ordinary far-field rr).
// Both are the same real-number quantity as the CPU's; see the inline notes.
//
// Word layout constants mirror lightTree.js (this file deliberately does not
// import them: the twin must compile standalone in a fixture page, and a
// drifted constant is exactly what the gate exists to catch).
import {
  Break,
  If,
  Loop,
  bitAnd,
  bitXor,
  float,
  int,
  select,
  shiftRight,
  sqrt,
  uint,
  uintBitsToFloat,
  vec3,
} from "three/tsl";

const ARITY = 4;
const NODE_WORDS = 28;
const TRI_WORDS = 10;
const ATTR_WORDS = 8;
const EMITTER_WORDS = 32;

// ═════════════════════════════════════════════════════════ the RNG, both sides

/** lowbias32 finalizer on a u32 — JS half, exact 32-bit at every step. */
export function lowbias32(v) {
  let x = v >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x;
}

/**
 * The CPU mirror of the kernel's RNG: hand this to `sampleLightTree` with the
 * seed the kernel got and both sides consume the IDENTICAL u01 sequence in the
 * identical draw order. Every value is `(lowbias32(seed + n·0x9e3779b9) >> 8)
 * / 2^24` — exactly representable in f32, so f64 JS and f32 WGSL agree
 * bit for bit on `u` itself (only the probabilities it is compared against
 * carry float-width drift).
 */
export function makeGpuRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    return (lowbias32(state) >>> 8) / 16777216;
  };
}

// ═══════════════════════════════════════════════════════════ the TSL descent

/**
 * Builds the descent twin over `words` — an instancedArray/storage node of the
 * packed u32 block(s) (in production: the occupancy `bits` buffer; in the
 * gate: a standalone buffer — the math is the same, which is the point).
 *
 * Returns `(P, N, hasN, baseWord, seed) => { index0, pdf0, index1, pdf1 }`:
 * up to two samples, `index* = −1` where a slot returned nothing (the CPU
 * returns a 0/1/2-length array; slot 0 is always the first pushed sample, so
 * the compaction order matches the CPU's push order). `hasN` is a float 0/1 —
 * the CPU's `N = null` point-receiver case; the N argument is still read (and
 * must be finite) but its term is select()ed out, multiplying by exactly 1.
 *
 * @param {Node} words  u32 storage node holding the packed block(s)
 * @param {{ splitRatio?: number, maxDescent?: number }} [options]
 *   `maxDescent` bounds the per-branch loop; the tree's real depth bounds the
 *   iterations actually run (header word 13 if a caller wants it tight).
 */
export function createLightTreeSampler(words, options = {}) {
  const splitRatio = options.splitRatio ?? 0.5;
  const maxDescent = options.maxDescent ?? 24;

  return (Pin, Nin, hasNin, baseIn, seedIn) => {
    const P = vec3(Pin).toVar();
    const N = vec3(Nin).toVar();
    const hasN = float(hasNin).toVar();
    const base = uint(baseIn).toVar();
    // Header offsets are BLOCK-RELATIVE (the block rides at an arbitrary
    // baseWord inside `bits`), so every base is `base +` — the gate uploads at
    // a non-zero base precisely to catch an absolute read.
    const nodeBase = base.add(words.element(base.add(uint(1)))).toVar();
    const triBase = base.add(words.element(base.add(uint(2)))).toVar();
    const attrBase = base.add(words.element(base.add(uint(3)))).toVar();
    const emitterBase = base.add(words.element(base.add(uint(4)))).toVar();

    const rngState = uint(seedIn).toVar();
    /** One u01 draw — advances the counter. See the draw-order contract. */
    const rngNext = () => {
      rngState.addAssign(uint(0x9e3779b9));
      const x = rngState.toVar();
      x.assign(bitXor(x, shiftRight(x, uint(16))).mul(uint(0x7feb352d)));
      x.assign(bitXor(x, shiftRight(x, uint(15))).mul(uint(0x846ca68b)));
      x.assign(bitXor(x, shiftRight(x, uint(16))));
      return shiftRight(x, uint(8)).toFloat().mul(1 / 16777216);
    };

    const fword = (idx) => uintBitsToFloat(words.element(idx));
    const safeSqrt = (x) => sqrt(float(x).max(0));
    // PBRT's clamped angle-difference identities — `cosA > cosB` means A < B,
    // where the difference reads as 0 rather than wrapping negative.
    const cosSub = (sinA, cosA, sinB, cosB) =>
      select(cosA.greaterThan(cosB), float(1), cosA.mul(cosB).add(sinA.mul(sinB)));
    const sinSub = (sinA, cosA, sinB, cosB) =>
      select(cosA.greaterThan(cosB), float(0), sinA.mul(cosB).sub(cosA.mul(sinB)));

    /** `clusterImportance`, term for term, in the CPU's evaluation order. */
    const clusterImp = (bmin, bmax, power, axis, cosThetaO, cosThetaE) => {
      const result = float(0).toVar();
      If(power.greaterThan(0), () => {
        const c = bmin.add(bmax).mul(0.5).toVar();
        const dv = P.sub(c).toVar();
        const d2raw = dv.dot(dv).toVar();
        const ext = bmax.sub(bmin).toVar();
        const diag = sqrt(ext.dot(ext)).toVar();
        // The near-field clamp, unit quirk and all (a LENGTH raising an
        // AREA-dimensioned d2) — kept verbatim because the CPU keeps it
        // verbatim from PBRT, and the twin's job is agreement, not taste.
        const d2 = d2raw.max(diag.div(2)).max(1e-12).toVar();
        const d = sqrt(d2raw).toVar();
        const wi = select(d.greaterThan(1e-12), dv.div(d), vec3(0, 1, 0)).toVar();
        const radius = diag.mul(0.5).toVar();
        const rr = radius.div(d).toVar();
        // P inside the cluster's bounding sphere: the cluster subtends every
        // direction, cosThetaU = −1 (the CPU's `d <= radius` branch).
        //
        // ⚠ THE COMPLEMENT-SQRT REWRITES (deviation #2, measured 2.15e-4 on
        // the pdf before them): every `sqrt(1 − c²)` below is the CPU's f64
        // formula, where it is benign — in f32, `1 − c²` at |c| → 1 cancels
        // catastrophically, and sinThetaU's DOUBLE complement
        // `sqrt(1 − (1 − rr²))` cancels at plain far-field rr. Each rewrite
        // is an algebraic identity (the same real number): sinThetaU IS rr
        // outside / 0 inside, and the others take the factored Sterbenz form
        // `(1 − c)(1 + c)` whose small factor is exact (srcMathTsl.decodeDir
        // documents the same trick). Identical order everywhere else.
        const cosThetaU = select(
          d.lessThanEqual(radius), float(-1),
          safeSqrt(float(1).sub(rr).mul(float(1).add(rr))),
        ).toVar();
        const sinThetaU = select(d.lessThanEqual(radius), float(0), rr).toVar();
        const cosTheta = axis.dot(wi).clamp(-1, 1).toVar();
        const sinTheta = safeSqrt(float(1).sub(cosTheta).mul(float(1).add(cosTheta))).toVar();
        const sinThetaO = safeSqrt(float(1).sub(cosThetaO).mul(float(1).add(cosThetaO))).toVar();
        const cosThetaX = cosSub(sinTheta, cosTheta, sinThetaO, cosThetaO).toVar();
        const sinThetaX = sinSub(sinTheta, cosTheta, sinThetaO, cosThetaO).toVar();
        const cosThetaP = cosSub(sinThetaX, cosThetaX, sinThetaU, cosThetaU).toVar();
        If(cosThetaP.greaterThan(cosThetaE), () => {
          const imp = power.mul(cosThetaP).div(d2).toVar();
          // Receiver cosine widened by the subtended angle; select()ed to an
          // exact ×1 for point receivers (the CPU's `if (N)` skip).
          const cosThetaI = wi.dot(N).max(0).toVar();
          const sinThetaI = safeSqrt(float(1).sub(cosThetaI).mul(float(1).add(cosThetaI))).toVar();
          imp.mulAssign(select(
            hasN.greaterThan(0.5),
            cosSub(sinThetaI, cosThetaI, sinThetaU, cosThetaU),
            float(1),
          ));
          result.assign(select(imp.greaterThan(0), imp, float(0)));
        });
      });
      return result;
    };

    /** Importance of one emitter leaf, from its record — `emitterImportance`. */
    const emitterImp = (id) => {
      const p = emitterBase.add(uint(id).mul(uint(EMITTER_WORDS))).toVar();
      const bmin = vec3(fword(p), fword(p.add(uint(1))), fword(p.add(uint(2)))).toVar();
      const bmax = vec3(fword(p.add(uint(3))), fword(p.add(uint(4))), fword(p.add(uint(5)))).toVar();
      const power = fword(p.add(uint(9))).toVar();
      const axis = vec3(fword(p.add(uint(10))), fword(p.add(uint(11))), fword(p.add(uint(12)))).toVar();
      const cosO = fword(p.add(uint(13))).toVar();
      const cosE = fword(p.add(uint(14))).toVar();
      return clusterImp(bmin, bmax, power, axis, cosO, cosE);
    };

    const leafId = (start, j) =>
      words.element(triBase.add(start.add(j).mul(uint(TRI_WORDS))).add(uint(9)));

    /**
     * `childWeights`: per-slot importances, their sum (in slot order — the sum
     * is order-sensitive in floats and the CPU sums in slot order), the live
     * count, and the strongest slot (STRICT >, ties to the lower slot).
     * `wantUnion` also unions the live child boxes — `nodeBounds`, for the
     * root's shouldSplit.
     */
    const childWeights = (node, wantUnion) => {
      const nw = nodeBase.add(uint(node).mul(uint(NODE_WORDS))).toVar();
      const aw = attrBase.add(uint(node).mul(uint(ARITY * ATTR_WORDS))).toVar();
      const refs = [];
      const imps = [];
      const sum = float(0).toVar();
      const live = int(0).toVar();
      const top = int(-1).toVar();
      const best = float(-1).toVar();
      const union = wantUnion
        ? { min: vec3(3.0e38).toVar(), max: vec3(-3.0e38).toVar() }
        : null;
      for (let s = 0; s < ARITY; s++) {
        const ref = words.element(nw.add(uint(s))).toVar();
        const imp = float(0).toVar();
        refs.push(ref);
        imps.push(imp);
        If(ref.notEqual(uint(0)), () => {
          const bp = nw.add(uint(4 + s * 6));
          const bmin = vec3(fword(bp), fword(bp.add(uint(1))), fword(bp.add(uint(2)))).toVar();
          const bmax = vec3(fword(bp.add(uint(3))), fword(bp.add(uint(4))), fword(bp.add(uint(5)))).toVar();
          const ap = aw.add(uint(s * ATTR_WORDS));
          const power = fword(ap).toVar();
          const axis = vec3(fword(ap.add(uint(1))), fword(ap.add(uint(2))), fword(ap.add(uint(3)))).toVar();
          const cosO = fword(ap.add(uint(4))).toVar();
          const cosE = fword(ap.add(uint(5))).toVar();
          imp.assign(clusterImp(bmin, bmax, power, axis, cosO, cosE));
          sum.addAssign(imp);
          live.addAssign(1);
          If(imp.greaterThan(best), () => { best.assign(imp); top.assign(int(s)); });
          if (union) {
            union.min.assign(union.min.min(bmin));
            union.max.assign(union.max.max(bmax));
          }
        });
      }
      return { refs, imps, sum, live, top, union };
    };

    /** arr[c] over the four per-slot vars, c a runtime int. */
    const slotAt = (arr, c) =>
      select(c.equal(int(0)), arr[0],
        select(c.equal(int(1)), arr[1],
          select(c.equal(int(2)), arr[2], arr[3])));

    /** CHOOSE-ONE probabilities — `chooseProbabilities`, uniform fallback. */
    const fillChoose = (w, p) => {
      const liveF = w.live.toFloat().toVar();
      for (let s = 0; s < ARITY; s++) {
        p[s].assign(select(
          w.refs[s].equal(uint(0)), float(0),
          select(w.sum.greaterThan(0), w.imps[s].div(w.sum), float(1).div(liveF)),
        ));
      }
    };

    /**
     * SPLIT inclusion probabilities — `splitProbabilities`.
     *
     * ONE deliberate evaluation-order deviation: the CPU computes
     * `others = sum − imp[top]`, which in ITS f64 is exact; transcribing that
     * subtraction into f32 cancels catastrophically whenever the top slot
     * dominates (sum ≈ imp[top] ⇒ rel error ε·sum/others — the descent gate
     * measured 1.18e-4 on the pdf from exactly this). Summing the non-top
     * importances directly is the same real-number quantity with ~ε relative
     * error, i.e. CLOSER to the CPU's value, which is what "minimize drift"
     * actually asks for.
     */
    const fillSplit = (w, p) => {
      const others = float(0).toVar();
      for (let s = 0; s < ARITY; s++) {
        others.addAssign(select(int(s).equal(w.top), float(0), w.imps[s]));
      }
      const fallback = float(1).div(w.live.sub(1).toFloat()).toVar();
      for (let s = 0; s < ARITY; s++) {
        p[s].assign(select(
          w.refs[s].equal(uint(0)), float(0),
          select(int(s).equal(w.top), float(1),
            select(others.greaterThan(0), w.imps[s].div(others), fallback)),
        ));
      }
    };

    /**
     * `pick`: one slot ∝ p[], skipping `skip`, −1 when total ≤ 0 (and then it
     * does NOT draw — the draw-order contract). `chosen` is assigned BEFORE
     * the `u < p` test, so a u that never dips lands on the LAST positive
     * slot, exactly as the CPU's loop does.
     */
    const pick = (p, skip) => {
      const total = float(0).toVar();
      for (let s = 0; s < ARITY; s++) {
        total.addAssign(skip ? select(skip.equal(int(s)), float(0), p[s]) : p[s]);
      }
      const chosen = int(-1).toVar();
      If(total.greaterThan(0), () => {
        const u = rngNext().mul(total).toVar();
        const done = int(0).toVar();
        for (let s = 0; s < ARITY; s++) {
          const eligible = skip
            ? done.equal(0).and(skip.notEqual(int(s))).and(p[s].greaterThan(0))
            : done.equal(0).and(p[s].greaterThan(0));
          If(eligible, () => {
            chosen.assign(int(s));
            If(u.lessThan(p[s]), () => { done.assign(1); }).Else(() => { u.subAssign(p[s]); });
          });
        }
      });
      return chosen;
    };

    /**
     * One linear descent from root child `slot` carrying inclusion
     * probability `prob0`: choose-one per interior node (no splits below the
     * root — maxSplitDepth = 1), importance-proportional pick in the leaf.
     * Writes (emitter index, pdf) iff pdf > 0 — the CPU's `take`.
     */
    const runBranch = (slot, prob0, outIndex, outPdf) => {
      const prob = float(prob0).toVar();
      const ref = words.element(nodeBase.add(uint(slot))).toVar();
      const dead = int(0).toVar();
      Loop({ start: 0, end: maxDescent, name: "ltDescend" }, () => {
        If(bitAnd(ref, uint(0x80000000)).notEqual(uint(0)), () => { Break(); });
        const node = ref.sub(uint(1)).toVar();
        const w = childWeights(node, false);
        If(w.live.lessThan(1), () => { dead.assign(1); Break(); });
        const p = [float(0).toVar(), float(0).toVar(), float(0).toVar(), float(0).toVar()];
        fillChoose(w, p);
        const c = pick(p, null);
        If(c.lessThan(0), () => { dead.assign(1); Break(); });
        prob.mulAssign(slotAt(p, c));
        ref.assign(words.element(nodeBase.add(node.mul(uint(NODE_WORDS))).add(c.toUint())));
      });
      If(dead.equal(0).and(bitAnd(ref, uint(0x80000000)).notEqual(uint(0))), () => {
        const start = bitAnd(ref, uint(0x00ffffff)).toVar();
        const count = bitAnd(shiftRight(ref, uint(24)), uint(0x7f)).toVar();
        // Pass 1 — the importance sum, in leaf order (`leafProbabilities`).
        const sum = float(0).toVar();
        Loop({ start: uint(0), end: count, type: "uint", condition: "<" }, ({ i }) => {
          sum.addAssign(emitterImp(leafId(start, uint(i))));
        });
        const countF = count.toFloat().toVar();
        const lpOf = (j) => select(
          sum.greaterThan(0), emitterImp(leafId(start, j)).div(sum), float(1).div(countF),
        );
        // Pass 2 — THE leaf draw (always exactly one, even at count = 1),
        // then the CPU's CDF walk over the first count−1 entries.
        const u = rngNext().toVar();
        const j = uint(0).toVar();
        Loop({ start: uint(0), end: count.sub(uint(1)), type: "uint", condition: "<" }, () => {
          const lpj = lpOf(j).toVar();
          If(u.lessThan(lpj), () => { Break(); });
          u.subAssign(lpj);
          j.addAssign(uint(1));
        });
        const pdf = prob.mul(lpOf(j)).toVar();
        If(pdf.greaterThan(0), () => {
          outIndex.assign(leafId(start, j).toFloat());
          outPdf.assign(pdf);
        });
      });
    };

    // ── the descent itself ───────────────────────────────────────────────────
    const index0 = float(-1).toVar();
    const pdf0 = float(0).toVar();
    const index1 = float(-1).toVar();
    const pdf1 = float(0).toVar();

    const w = childWeights(uint(0), true);
    // `shouldSplit(root, depth 0)`: bounding radius vs splitRatio × distance.
    const ext = w.union.max.sub(w.union.min).toVar();
    const rootRadius = sqrt(ext.dot(ext)).mul(0.5).toVar();
    const rootCentre = w.union.min.add(w.union.max).mul(0.5).toVar();
    const rootDelta = P.sub(rootCentre).toVar();
    const rootDist = sqrt(rootDelta.dot(rootDelta)).toVar();
    const wantSplit = w.live.greaterThanEqual(2)
      .and(rootRadius.greaterThan(rootDist.max(1e-6).mul(splitRatio)));

    const p = [float(0).toVar(), float(0).toVar(), float(0).toVar(), float(0).toVar()];
    const splitFlag = int(0).toVar();
    const slot0 = int(-1).toVar();
    const prob0 = float(0).toVar();
    If(w.live.greaterThanEqual(1), () => {
      If(wantSplit, () => {
        splitFlag.assign(1);
        fillSplit(w, p);
        slot0.assign(w.top); // the certainty branch — no draw
        prob0.assign(1);
      }).Else(() => {
        fillChoose(w, p);
        const chosen = pick(p, null); // the root pick draw
        If(chosen.greaterThanEqual(0), () => {
          slot0.assign(chosen);
          prob0.assign(slotAt(p, chosen));
        });
      });
    });
    // Branch A first, THEN the other-branch pick, THEN branch B — the CPU's
    // rng() interleaving (take(top) completes before pick(p, top) draws).
    If(slot0.greaterThanEqual(0), () => {
      runBranch(slot0.toUint(), prob0, index0, pdf0);
    });
    If(splitFlag.equal(1), () => {
      const other = pick(p, w.top);
      If(other.greaterThanEqual(0), () => {
        runBranch(other.toUint(), slotAt(p, other), index1, pdf1);
      });
    });

    return { index0, pdf0, index1, pdf1 };
  };
}
