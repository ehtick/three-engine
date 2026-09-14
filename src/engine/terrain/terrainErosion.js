/**
 * Heightfield erosion (09-13 owner receipt: "too artificial" / "unnatural
 * creases" / "hills look flat and uninteresting"). The rest of
 * `proceduralTerrain.js` is a purely analytic stack (fBm + ridged folds +
 * domain warp + landform + analytic ridge/escarpment profiles) — real relief
 * is shaped by water and gravity acting on that raw noise, so this module is
 * a discrete, in-place post-process over a materialized heightfield grid,
 * never a second analytic term. It intentionally does NOT touch
 * `createTerrainShape`/`createValleyFields`'s analytic `evaluate(x,z)`: dozens
 * of existing tests sweep that function's curvature and check its slope
 * against independent finite differences to ~1e-4/1e-5, which a discretized,
 * eroded surface cannot satisfy by construction.
 *
 * Layout: `heights` is a row-major Float32Array of `(resolution + 1)^2`
 * samples — row r -> local z = -half + r*step, column c -> local
 * x = -half + c*step — byte-identical to `fillHeightfield`'s own grid, so a
 * caller can erode the exact array that function just filled.
 *
 * ⛔ 09-13 RECEIPT REJECTED, ROUND 1: eroding directly at full resolution
 * (385x385) put one droplet-shaped bump/pit at nearly every cell — visually a
 * "crumpled foil" texture over the WHOLE field, flats and slopes alike — and
 * the analytic ridge-fold creases were barely touched (a handful of thermal
 * passes at that resolution moves one cell's worth of material at a time; a
 * crease running for metres needs many more iterations than was affordable
 * there). Fixed by moving the whole simulation to a COARSE grid (`erode`
 * below): downsample the raw field to at most ~193 samples across, run every
 * droplet and every thermal iteration there (cell-scale noise literally
 * cannot exist below the coarse cell size), then upsample the DELTA
 * (eroded-minus-raw, not the eroded heights themselves) back onto the full
 * grid and add it. Large-scale drainage and rounded crests emerge; per-cell
 * pockmarks cannot, because the coarse grid has no cells that small to mark.
 * This also multiplies the droplet budget per coarse cell for the same cost.
 *
 * Two passes, in order, both on the coarse grid:
 *   1. Hydraulic erosion — Beyer/Lague-style droplets: each one carries water
 *      and sediment downhill (bilinear height + gradient sampling, an
 *      inertia-smoothed direction, a long ~64-step lifetime so a path can
 *      actually reach a drainage line), eroding a capacity-limited amount
 *      from a radius brush where it speeds up and depositing where it slows.
 *      A droplet that dies (out of lifetime, out of water, or off the grid)
 *      spreads whatever it is still carrying over its own brush radius, NEVER
 *      as a 4-corner point splat — a point dump at every dead-end is exactly
 *      what produced the round pimples in the rejected receipt.
 *   2. Thermal (talus) erosion — many iterations (default 24) sliding
 *      material from any cell steeper than a talus angle onto its lower
 *      neighbour. This is what actually rounds a sharp ridged-noise fold once
 *      it is running on a coarse grid where 24 iterations can walk material
 *      several cells, not one.
 *
 * Every droplet deposits whatever sediment it is still carrying when it dies,
 * so mass never silently leaves the system — total volume before and after
 * is conserved to within numeric rounding, checked by
 * `tests/terrain-procedural.test.mjs`.
 *
 * Deterministic for a given `seed` (a small xorshift-style PRNG local to this
 * module, no dependency on host Math.random or on evaluation order).
 */

const TALUS_DEFAULT_DEG = 30;

/** mulberry32: tiny, fast, deterministic — the same generator already used by
 * this repo's own test fixtures (see e.g. tests/terrain-procedural.test.mjs). */
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Resamples a `srcCols`-square row-major grid to `dstCols`-square, bilinear,
 * both directions (down- and up-sampling use the same code). Used to move the
 * whole simulation onto a coarse grid and then bring the DELTA it produced
 * back up to the caller's real resolution — see the module doc's rejection
 * note for why this, rather than eroding at full resolution, is what removes
 * the cell-scale pockmark artifact. */
function resampleBilinear(src, srcCols, dstCols) {
  if (srcCols === dstCols) return src.slice();
  const dst = new Float32Array(dstCols * dstCols);
  const scale = (srcCols - 1) / (dstCols - 1);
  for (let r = 0; r < dstCols; r++) {
    const sy = Math.min(srcCols - 1, r * scale), y0 = Math.floor(sy), ty = sy - y0, y1 = Math.min(srcCols - 1, y0 + 1);
    for (let c = 0; c < dstCols; c++) {
      const sx = Math.min(srcCols - 1, c * scale), x0 = Math.floor(sx), tx = sx - x0, x1 = Math.min(srcCols - 1, x0 + 1);
      const h00 = src[y0 * srcCols + x0], h10 = src[y0 * srcCols + x1], h01 = src[y1 * srcCols + x0], h11 = src[y1 * srcCols + x1];
      dst[r * dstCols + c] = h00 * (1 - tx) * (1 - ty) + h10 * tx * (1 - ty) + h01 * (1 - tx) * ty + h11 * tx * ty;
    }
  }
  return dst;
}

/** Bilinear height + gradient at fractional grid coordinates, clamped to the
 * interior so a droplet can never index outside the array. Gradient is in
 * height-units per grid-cell (not yet divided by `cellSize`). */
function heightAndGradient(heights, cols, fx, fz) {
  const x = Math.min(cols - 1.0001, Math.max(0, fx));
  const z = Math.min(cols - 1.0001, Math.max(0, fz));
  const x0 = Math.floor(x), z0 = Math.floor(z), u = x - x0, v = z - z0;
  const i00 = z0 * cols + x0, i10 = i00 + 1, i01 = i00 + cols, i11 = i01 + 1;
  const h00 = heights[i00], h10 = heights[i10], h01 = heights[i01], h11 = heights[i11];
  return {
    height: h00 * (1 - u) * (1 - v) + h10 * u * (1 - v) + h01 * (1 - u) * v + h11 * u * v,
    gx: (h10 - h00) * (1 - v) + (h11 - h01) * v,
    gz: (h01 - h00) * (1 - u) + (h11 - h10) * u,
    x0, z0, u, v,
  };
}

/** Spreads `amount` over an entire brush footprint centred on the integer
 * cell (cx, cz) — used for EVERY deposit a droplet makes, trail or death. ⛔
 * 09-13 receipt (round 1): a 4-corner bilinear splat still concentrated one
 * droplet-step's deposit onto ~1 cell, and a dead-end's leftover sediment
 * onto the SAME ~1 cell every time — thousands of droplets meant thousands
 * of tiny piles/pockmarks, reading as a fine per-cell texture once summed
 * over the whole field. Spreading every deposit across the SAME brush radius
 * erosion itself uses means no single cell ever receives more than one
 * brush-weight's share, and nothing this module does can add height detail
 * finer than the brush footprint. */
function depositSpread(heights, cols, brush, cx, cz, amount, sedimentMap) {
  for (const cell of brush) {
    const x = cx + cell.dx, z = cz + cell.dz;
    if (x < 0 || x >= cols || z < 0 || z >= cols) continue;
    const index = z * cols + x, share = amount * cell.weight;
    heights[index] += share;
    if (sedimentMap) sedimentMap[index] += share;
  }
}

/** Precomputes a normalized (sum = 1) circular brush of {dx, dz, weight} for
 * radius-limited erosion/deposit — a droplet removes (or, at death, spreads)
 * material over an AREA rather than a single cell. Weight falls off linearly
 * with distance, like Beyer's original. */
function makeBrush(radius) {
  const cells = [];
  const r = Math.max(1, radius);
  let total = 0;
  for (let dz = -Math.ceil(r); dz <= Math.ceil(r); dz++) {
    for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
      const distance = Math.hypot(dx, dz);
      if (distance > r) continue;
      const weight = r - distance;
      cells.push({ dx, dz, weight });
      total += weight;
    }
  }
  for (const cell of cells) cell.weight /= total;
  return cells;
}

/** One droplet's whole downhill lifetime. Mutates `heights` (and, when given,
 * `sedimentMap`/`flowMap`) in place; returns nothing. All distances are in
 * grid cells — `cellSize` only rescales the physical slope/speed coupling so
 * a coarser or finer grid over the same physical terrain erodes comparably. */
function simulateDroplet(heights, cols, rng, brush, cellSize, params, sedimentMap, flowMap) {
  let x = 1 + rng() * (cols - 2), z = 1 + rng() * (cols - 2);
  let dirX = 0, dirZ = 0, speed = params.initialSpeed, water = params.initialWater, sediment = 0;
  for (let step = 0; step < params.maxLifetime; step++) {
    const nodeX = Math.floor(x), nodeZ = Math.floor(z);
    if (nodeX < 1 || nodeX >= cols - 2 || nodeZ < 1 || nodeZ >= cols - 2) break;
    const here = heightAndGradient(heights, cols, x, z);
    if (flowMap) flowMap[nodeZ * cols + nodeX] += water;

    // Inertia-blended steepest-descent direction; a droplet with zero
    // gradient underfoot (a flat) picks a random heading rather than freezing.
    dirX = dirX * params.inertia - here.gx * (1 - params.inertia);
    dirZ = dirZ * params.inertia - here.gz * (1 - params.inertia);
    const length = Math.hypot(dirX, dirZ);
    if (length < 1e-8) { dirX = rng() * 2 - 1; dirZ = rng() * 2 - 1; }
    else { dirX /= length; dirZ /= length; }

    const newX = x + dirX, newZ = z + dirZ;
    if (newX < 1 || newX >= cols - 2 || newZ < 1 || newZ >= cols - 2) {
      depositSpread(heights, cols, brush, nodeX, nodeZ, sediment, sedimentMap);
      return;
    }
    const there = heightAndGradient(heights, cols, newX, newZ);
    const deltaHeight = there.height - here.height;
    // Slope normalized by physical cell size so a coarser grid (fewer, larger
    // cells over the same metres) erodes about as much per unit AREA as a
    // finer one, not per unit cell.
    const slope = Math.max(-deltaHeight / cellSize, params.minSlope);
    const capacity = slope * speed * water * params.capacityFactor;

    if (sediment > capacity || deltaHeight > 0) {
      // Moving uphill or over-laden: drop the excess (or, uphill, no more
      // than the climb itself so a droplet never digs a pit on the far side).
      // ⛔ A 4-corner bilinear splat here still concentrated one droplet-step's
      // whole deposit onto ~1 cell; thousands of droplets meant thousands of
      // tiny piles, reading as fine per-cell texture once summed. Spreading
      // over the same brush radius erosion uses keeps every operation at the
      // SAME minimum footprint, so nothing this module does can add detail
      // finer than the brush itself.
      const depositAmount = deltaHeight > 0 ? Math.min(deltaHeight, sediment) : (sediment - capacity) * params.depositSpeed;
      sediment -= depositAmount;
      depositSpread(heights, cols, brush, nodeX, nodeZ, depositAmount, sedimentMap);
    } else {
      // Capped at a few cells' worth of relief regardless of how steep the
      // local slope actually is: near a tall declared feature (an escarpment
      // can be 30+ m), an uncapped capacity/`-deltaHeight` bound let ONE
      // droplet step gouge a huge, single-iteration chunk out of the cliff —
      // exactly the "crease got WORSE" failure the 09-13 receipt caught.
      // Many gentle steps (this module already runs plenty of droplets) still
      // erode a real cliff meaningfully; one uncapped step must not.
      const erodeAmount = Math.min((capacity - sediment) * params.erodeSpeed, -deltaHeight, params.maxStepErosion * cellSize);
      if (erodeAmount > 0) {
        for (const cell of brush) {
          const cx = nodeX + cell.dx, cz = nodeZ + cell.dz;
          if (cx < 0 || cx >= cols || cz < 0 || cz >= cols) continue;
          const index = cz * cols + cx, take = erodeAmount * cell.weight;
          heights[index] -= take;
          if (sedimentMap) sedimentMap[index] -= take;
          sediment += take;
        }
      }
    }

    speed = Math.sqrt(Math.max(0, speed * speed - deltaHeight / cellSize * params.gravity));
    water *= (1 - params.evaporateSpeed);
    x = newX; z = newZ;
    if (water < 1e-4) {
      depositSpread(heights, cols, brush, Math.floor(x), Math.floor(z), sediment, sedimentMap);
      return;
    }
  }
  // Lifetime ran out without an early return above: whatever is still being
  // carried is spread right here, never simply discarded (volume gate) and
  // never dumped as a single point (see `depositSpread`'s own doc).
  depositSpread(heights, cols, brush, Math.floor(x), Math.floor(z), sediment, sedimentMap);
}

/** Thermal (talus) erosion: iteratively slides material from a cell to any
 * lower 8-connected neighbour (4 axis + 4 diagonal, each at its own true run
 * length) once the slope between them exceeds `talusAngleDeg`. Runs on a
 * delta buffer (not in place cell-by-cell) so the result does not depend on
 * scan order — the classic source of directional streaking in a naive
 * single-buffer implementation. This is what actually rounds a sharp
 * ridged-noise fold, GIVEN ENOUGH ITERATIONS on a small-enough (coarse) grid
 * that each one moves material more than one physical cell. */
function thermalErode(heights, cols, cellSize, iterations, talusAngleDeg, rate, maxStepMove) {
  const talus = Math.tan((talusAngleDeg * Math.PI) / 180) * cellSize;
  const cap = maxStepMove * cellSize;
  const delta = new Float32Array(heights.length);
  const diagonal = Math.SQRT2;
  const neighbors = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, diagonal], [1, -1, diagonal], [-1, 1, diagonal], [-1, -1, diagonal]];
  for (let iteration = 0; iteration < iterations; iteration++) {
    delta.fill(0);
    for (let z = 0; z < cols; z++) {
      for (let x = 0; x < cols; x++) {
        const index = z * cols + x, h = heights[index];
        // ⛔ Splitting one bounded move across EVERY exceeding neighbour
        // diluted it so much that even 100 iterations only rounded a crease
        // ~20% — each neighbour only ever got a sliver of the move. A cell
        // instead slides toward its SINGLE steepest lower neighbour, the
        // whole (rate-bounded) excess in one go: this is the ordinary
        // pairwise talus rule (Musgrave-style), it cannot invert a spike
        // (rate <= 1 always leaves the excess non-negative), and it actually
        // converges on a crease within the iteration counts this module uses.
        let bestIndex = -1, bestExcess = 0;
        for (const [dx, dz, run] of neighbors) {
          const nx = x + dx, nz = z + dz;
          if (nx < 0 || nx >= cols || nz < 0 || nz >= cols) continue;
          // The talus THRESHOLD scales with the neighbour's own run (a
          // diagonal step covers cellSize*sqrt2, so the same angle allows a
          // sqrt2-times-larger raw height difference before it counts as
          // "steeper than talus").
          const nIndex = nz * cols + nx, diff = h - heights[nIndex], excess = diff - talus * run;
          if (excess > bestExcess) { bestExcess = excess; bestIndex = nIndex; }
        }
        if (bestIndex < 0) continue;
        // Same cap as hydraulic erosion's own per-step bound, and for the
        // same reason: a tall declared feature (a 30+ m escarpment) can have
        // an "excess" many times a coarse cell's size, and moving all of it
        // in one iteration is exactly what turned a fixable analytic crease
        // into a WORSE one once upsampled. Many iterations of a small, capped
        // move erode it just as far, without ever overshooting in one step.
        const move = Math.min(bestExcess * rate, cap);
        delta[index] -= move;
        delta[bestIndex] += move;
      }
    }
    for (let i = 0; i < heights.length; i++) heights[i] += delta[i];
  }
}

const DEFAULT_PARAMS = Object.freeze({
  inertia: .05, capacityFactor: .5, minSlope: .01, depositSpeed: .08, erodeSpeed: .05,
  evaporateSpeed: .01, gravity: 4, maxLifetime: 64, initialSpeed: 1, initialWater: 1,
  // 09-13 receipt, round 2: World's default terrain (default roughness/ridged,
  // an escarpment/ridge layout on top) has a MUCH lower ambient curvature
  // than this module's own worst-case test fixtures — the same absolute
  // erosion rates that looked reasonable there measurably raised the real
  // default world's high-frequency energy. These defaults are the gentlest
  // that still move visible material (see tests/terrain-procedural.test.mjs's
  // "no added pockmarks" check), at the cost of a subtler effect than an
  // aggressively-tuned single fixture would suggest.
  erosionRadius: 6, dropletsPerCell: .05, thermalIterations: 15, talusAngleDeg: TALUS_DEFAULT_DEG, thermalRate: .4,
  // Stream-power model (the live path since 09-13): iterations at strength 1,
  // incision constant K per iteration (dimensionless, area in cells), the
  // drainage-area exponent m, and the hillslope diffusion rate per iteration.
  iterations: 60, incision: .013, areaExponent: .5, diffusion: .16,
  // Both in units of coarse cellSize: the largest a SINGLE droplet step or a
  // SINGLE thermal iteration may move at one cell, regardless of how steep a
  // declared feature (an escarpment) makes the local slope/excess look. See
  // the two call sites for why an uncapped version of either blew up near one.
  maxStepErosion: .1,
  // Slope (m/m) above which this module's whole delta is frozen — see
  // `applySteepFreeze`. A declared escarpment/ridge crest is already an
  // analytically smooth, deliberately steep feature (its own tests hold its
  // curvature to a tight bound) — this module has no business reshaping it
  // further, so its own steep faces are left alone; only the gentler,
  // noise-driven relief around them erodes.
  // 09-13: the freeze is OFF (stream power + diffusion is what rounds a declared
  // crest into a hill; the droplet model needed it, this one does not).
  freezeSlope: 1e9, freezeBand: 1,
});

/** Runs the whole hydraulic + thermal simulation directly on `heights` at
 * `cellSize` — the actual work, always run on a COARSE grid by the two
 * exported entry points below. Not exported: a caller always goes through
 * `erodeHeightfield`/`erodeHeightfieldSteps`, which handle the down/upsample. */
/**
 * ⭐ 09-13 THE MODEL IS STREAM POWER, NOT DROPLETS. Two droplet/thermal cuts
 * were judged on hillshade receipts: the first carpeted the field with
 * cell-scale pockmarks, the second (rates cut until the pockmarks went) moved
 * nothing visible and its steepest-neighbour thermal step oscillated into a
 * checkerboard on flats. What reads as "organic" relief is a DRAINAGE NETWORK
 * — valleys converging downslope with rounded interfluves between them — and
 * the model geomorphology uses for exactly that is the stream-power law with
 * hillslope diffusion (Braun & Willett 2013, implicit, unconditionally stable):
 *
 *   dh/dt = −K · A^m · S   (incision, A = upslope drainage area, S = slope)
 *         + D · ∇²h        (diffusion: rounds crests, fills creases)
 *
 * Per iteration: route flow D8 to the lowest neighbour, accumulate drainage
 * area from the top of the field down, then update every node in receiver-
 * first order: h = (h + F·h_receiver) / (1 + F), F = K·(A/cell²)^m — the
 * implicit form, so no step size can blow up a steep declared feature. The
 * mean height change is re-added uniformly (a floating base level), so the
 * field keeps its volume and the World's water/bank levels stay meaningful.
 * `flow` (drainage area, cells) and `sediment` (net height change, m) are
 * the maps a later geology pass can read.
 */
/** Fills `order` with every index sorted by descending height — exact, and
 * far cheaper than a comparator sort on 40k floats every iteration: a counting
 * sort into 4096 height buckets, then an insertion sort inside each (a bucket
 * holds ~10 cells). The order is what makes the accumulation and the implicit
 * incision correct, so it cannot be approximate. */
function sortDescendingByHeight(heights, order, keys, bucketStart, bucketCount) {
  const count = heights.length, buckets = bucketCount.length;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < count; i++) { const h = heights[i]; if (h < lo) lo = h; if (h > hi) hi = h; }
  const scale = hi > lo ? (buckets - 1) / (hi - lo) : 0;
  bucketCount.fill(0);
  for (let i = 0; i < count; i++) { const b = buckets - 1 - ((heights[i] - lo) * scale | 0); keys[i] = b; bucketCount[b]++; }
  bucketStart[0] = 0;
  for (let b = 0; b < buckets; b++) bucketStart[b + 1] = bucketStart[b] + bucketCount[b];
  bucketCount.fill(0);
  for (let i = 0; i < count; i++) { const b = keys[i]; order[bucketStart[b] + bucketCount[b]++] = i; }
  for (let b = 0; b < buckets; b++) {
    const from = bucketStart[b], to = bucketStart[b + 1];
    for (let k = from + 1; k < to; k++) {
      const v = order[k], h = heights[v]; let j = k - 1;
      while (j >= from && heights[order[j]] < h) { order[j + 1] = order[j]; j--; }
      order[j + 1] = v;
    }
  }
}

function* erosionPassSteps(heights, cols, cellSize, strength, params, wantMaps, clock) {
  const count = cols * cols;
  const iterations = Math.max(1, Math.round(params.iterations * strength));
  const K = params.incision * strength, m = params.areaExponent, D = params.diffusion;
  const receiver = new Int32Array(count), order = new Int32Array(count), area = new Float32Array(count);
  const original = heights.slice();
  const keys = new Float64Array(count);
  const nx = [-1, 0, 1, -1, 1, -1, 0, 1], nz = [-1, -1, -1, 0, 0, 1, 1, 1];
  const nd = nx.map((dx, i) => Math.hypot(dx, nz[i]));
  const laplace = new Float32Array(count);
  const bucketCount = new Int32Array(4096), bucketStart = new Int32Array(4097);
  for (let iteration = 0; iteration < iterations; iteration++) {
    // Flow routing: steepest descent to the lowest neighbour; a pit or an
    // edge cell is its own receiver (local base level — a lake or the world edge).
    for (let z = 0; z < cols; z++) for (let x = 0; x < cols; x++) {
      const i = z * cols + x; let best = i, bestSlope = 0;
      for (let k = 0; k < 8; k++) {
        const xx = x + nx[k], zz = z + nz[k];
        if (xx < 0 || zz < 0 || xx >= cols || zz >= cols) continue;
        const j = zz * cols + xx, slope = (heights[i] - heights[j]) / nd[k];
        if (slope > bestSlope) { bestSlope = slope; best = j; }
      }
      receiver[i] = best;
    }
    // Top-down order by elevation (a receiver is always lower than its donors).
    sortDescendingByHeight(heights, order, keys, bucketStart, bucketCount);
    // One iteration over a 257² landscape macro grid is ~60 ms; yield between
    // its phases too (the maths is identical however it is sliced).
    if (clock.due()) yield 'terrain';
    // Drainage area by MULTIPLE flow directions (Freeman 1991): a cell hands its
    // area to every lower neighbour in proportion to slope. Single-direction
    // (D8) accumulation drew every channel as a straight axis-aligned or
    // diagonal line on the grid — the receipt showed a field of them.
    area.fill(1);
    for (let k = 0; k < count; k++) {
      const i = order[k]; if (receiver[i] === i) continue;
      const x = i % cols, z = (i - x) / cols;
      let total = 0;
      for (let q = 0; q < 8; q++) {
        const xx = x + nx[q], zz = z + nz[q];
        if (xx < 0 || zz < 0 || xx >= cols || zz >= cols) continue;
        const drop = (heights[i] - heights[zz * cols + xx]) / nd[q];
        if (drop > 0) total += drop;
      }
      if (total <= 0) continue;
      for (let q = 0; q < 8; q++) {
        const xx = x + nx[q], zz = z + nz[q];
        if (xx < 0 || zz < 0 || xx >= cols || zz >= cols) continue;
        const j = zz * cols + xx, drop = (heights[i] - heights[j]) / nd[q];
        if (drop > 0) area[j] += area[i] * drop / total;
      }
    }
    if (clock.due()) yield 'terrain';
    // Implicit incision, receivers first (ascending elevation).
    let meanChange = 0;
    for (let k = count - 1; k >= 0; k--) {
      const i = order[k], r = receiver[i];
      if (r === i) continue;
      const F = K * Math.pow(area[i], m);
      const next = (heights[i] + F * heights[r]) / (1 + F);
      meanChange += next - heights[i];
      heights[i] = next;
    }
    // Hillslope diffusion (explicit, D ≤ .2 per iteration in cell units is stable).
    for (let z = 0; z < cols; z++) for (let x = 0; x < cols; x++) {
      const i = z * cols + x;
      const w = heights[z * cols + (x > 0 ? x - 1 : x + 1)], e = heights[z * cols + (x < cols - 1 ? x + 1 : x - 1)];
      const n = heights[(z > 0 ? z - 1 : z + 1) * cols + x], s = heights[(z < cols - 1 ? z + 1 : z - 1) * cols + x];
      laplace[i] = (w + e + n + s) * .25 - heights[i];
    }
    for (let i = 0; i < count; i++) heights[i] += laplace[i] * D;
    // Floating base level: the field keeps its mean height (volume).
    const lift = -meanChange / count;
    for (let i = 0; i < count; i++) heights[i] += lift;
    if (clock.due()) yield 'terrain';
  }
  if (!wantMaps) return undefined;
  const sediment = new Float32Array(count);
  for (let i = 0; i < count; i++) sediment[i] = heights[i] - original[i];
  return { flow: area, sediment };
}

/** Chooses the coarse grid a caller's full-resolution request actually erodes
 * on: at most `maxCoarseResolution` (default 192, i.e. <=193 samples across —
 * the brief's own cap) segments, never coarser than the caller's own grid. */
function coarseResolutionFor(resolution, options) {
  return Math.min(resolution, Math.max(2, Math.round(options.coarseResolution ?? 192)));
}

/** Zeroes `delta` (in place) wherever the RAW (pre-erosion) grid's own slope
 * already exceeds `params.freezeSlope` — a declared escarpment/ridge/cliff
 * face, not the gentler noise-driven relief this module exists to erode. A
 * smoothstep band (`freezeSlope` .. `freezeSlope + freezeBand`) fades the
 * gate in rather than drawing a hard edge around every protected feature. */
function applySteepFreeze(delta, raw, cols, cellSize, params) {
  const lo = params.freezeSlope, hi = params.freezeSlope + params.freezeBand;
  if (!(hi > 0)) return;
  for (let z = 0; z < cols; z++) {
    for (let x = 0; x < cols; x++) {
      const index = z * cols + x;
      const xw = x > 0 ? x - 1 : x, xe = x < cols - 1 ? x + 1 : x;
      const zn = z > 0 ? z - 1 : z, zs = z < cols - 1 ? z + 1 : z;
      const gx = (raw[z * cols + xe] - raw[z * cols + xw]) / ((xe - xw) * cellSize || 1);
      const gz = (raw[zs * cols + x] - raw[zn * cols + x]) / ((zs - zn) * cellSize || 1);
      const slope = Math.hypot(gx, gz);
      const t = slope <= lo ? 0 : slope >= hi ? 1 : (slope - lo) / (hi - lo);
      const freeWeight = 1 - t * t * (3 - 2 * t);
      delta[index] *= freeWeight;
    }
  }
}

/**
 * Erodes `heights` (a `(resolution + 1)^2` row-major Float32Array, see module
 * doc) in place. The simulation itself always runs on a coarse grid (at most
 * `options.coarseResolution ?? 192` segments) and only the resulting DELTA is
 * upsampled back onto `heights` — see the module doc's rejection note.
 *
 * `options`:
 *   - `seed` (default 1): deterministic RNG seed.
 *   - `strength` (0..1, default .6): master intensity — scales droplet count;
 *     0 is a guaranteed no-op (byte-identical input/output).
 *   - `cellSize` (metres, default 1): physical size of one FULL-resolution
 *     grid cell; the coarse grid's own cell size is derived from it and the
 *     coarse/full resolution ratio, so results stay size-invariant.
 *   - `coarseResolution` (default 192): the simulation grid's own resolution.
 *   - `talusAngleDeg` (default 30), `thermalIterations` (default 24),
 *     `thermalRate` (default .5): thermal-erosion tuning.
 *   - `maps` (default false): when true, also returns `{ flow, sediment }` —
 *     two full-resolution Float32Arrays (upsampled the same way as the
 *     height delta) for a future World geology stage. `flow` is accumulated
 *     water volume that passed through each coarse cell; `sediment` is net
 *     height change from erosion/deposition alone (+ deposition/fan, −
 *     erosion/scour).
 *
 * Returns `undefined` normally, or `{ flow, sediment }` when `options.maps`.
 */
export function erodeHeightfield(heights, resolution, options = {}) {
  const cols = resolution + 1;
  if (heights.length !== cols * cols) throw new RangeError(`erodeHeightfield: heights must hold ${cols * cols} samples for resolution ${resolution}`);
  const strength = options.strength ?? .6;
  const wantMaps = options.maps === true;
  if (strength <= 0) return wantMaps ? { flow: new Float32Array(heights.length), sediment: new Float32Array(heights.length) } : undefined;

  const steps = erodeHeightfieldSteps(heights, resolution, options, { due: () => false });
  let result = steps.next();
  while (!result.done) result = steps.next();
  return result.value;
}

/**
 * Generator twin of `erodeHeightfield`, for a caller that is itself a
 * clock-sliced generator (`fillHeightfield`): identical result, but the
 * droplet population (and each thermal iteration) is walked in batches with a
 * `yield` between them so a driving clock (`{ due() }`, same contract as
 * `fillHeightfield`'s own) can hand control back to its frame loop instead of
 * stalling it for the whole erosion pass. The down/upsample steps themselves
 * are cheap (one pass over the coarse or full grid) and are not sliced.
 */
export function* erodeHeightfieldSteps(heights, resolution, options = {}, clock = { due: () => false }) {
  const cols = resolution + 1;
  if (heights.length !== cols * cols) throw new RangeError(`erodeHeightfieldSteps: heights must hold ${cols * cols} samples for resolution ${resolution}`);
  const strength = options.strength ?? .6;
  const wantMaps = options.maps === true;
  if (strength <= 0) return wantMaps ? { flow: new Float32Array(heights.length), sediment: new Float32Array(heights.length) } : undefined;

  const params = { ...DEFAULT_PARAMS, ...options };
  const fullCellSize = Math.max(1e-6, options.cellSize ?? 1);
  const coarseResolution = coarseResolutionFor(resolution, options);
  const coarseCols = coarseResolution + 1;
  const coarseCellSize = fullCellSize * (resolution / coarseResolution);

  const coarseRaw = resampleBilinear(heights, cols, coarseCols);
  const coarseEroded = coarseRaw.slice();
  const maps = yield* erosionPassSteps(coarseEroded, coarseCols, coarseCellSize, strength, params, wantMaps, clock);

  const coarseDelta = new Float32Array(coarseCols * coarseCols);
  for (let i = 0; i < coarseDelta.length; i++) coarseDelta[i] = coarseEroded[i] - coarseRaw[i];
  // ⛔ 09-13 receipt, round 2: an escarpment/ridge is a DECLARED, already
  // analytically-smooth feature (dozens of tests hold its own curvature to a
  // tight bound) that can still be 30+ m tall over a narrow footprint — right
  // at that scale, a coarse cell's worth of "excess" dwarfs the terrain's own
  // ambient relief, and even a capped erosion step there reshaped the face
  // enough to read as a WORSE crease once upsampled, not a rounder one.
  // Freezing the delta whereever the RAW (pre-erosion) slope is already steep
  // — a cliff face, a ridge crest, not the gentler rolling ground the analytic
  // ridged-noise folds actually crease — protects exactly the features this
  // module has no business reshaping, while leaving the noise-driven relief
  // (where the real "unnatural crease" and "flat hills" complaints live) free
  // to erode normally.
  applySteepFreeze(coarseDelta, coarseRaw, coarseCols, coarseCellSize, params);
  if (coarseCols === cols) {
    for (let i = 0; i < heights.length; i++) heights[i] += coarseDelta[i];
  } else {
    const fullDelta = resampleBilinear(coarseDelta, coarseCols, cols);
    for (let i = 0; i < heights.length; i++) heights[i] += fullDelta[i];
  }
  if (clock.due()) yield 'terrain';
  if (!wantMaps) return undefined;
  return {
    flow: coarseCols === cols ? maps.flow : resampleBilinear(maps.flow, coarseCols, cols),
    sediment: coarseCols === cols ? maps.sediment : resampleBilinear(maps.sediment, coarseCols, cols),
  };
}
