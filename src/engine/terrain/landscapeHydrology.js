/**
 * Rivers and lakes as part of the landscape (09-14, T6 in docs/TERRAIN_PLAN.md;
 * owner: "terrain must account for rivers and lakes").
 *
 * Built once on the landscape's MACRO grid, applied per point like every other
 * detail stage, so a streamed chunk carries exactly the water the whole world
 * has — no neighbour reads, no seams:
 *
 *   LAKES   basins the depression fill kept, plus lakes dug where drainage
 *           collects on a flat valley floor. A lake is a connected set of cells
 *           under its spill level (priority flood, no grade), so its surface is
 *           flat by construction. Per point the shore is the contour of the
 *           blurred lake mask (roughly metres from the edge, with a little
 *           noise): the bed is clamped below the level inside, a narrow rim is
 *           held just above it outside, so water never floats over lower land.
 *   RIVERS  the D8 drainage of the graded (lake-draining) surface; a cell is
 *           river once its catchment passes a threshold. Reaches are traced
 *           source to mouth, end at a lake, a confluence, the world edge or the
 *           reserved World region, and are smoothed (Chaikin, endpoints fixed).
 *           The water surface is a running minimum of the ground along the
 *           reach, so it only ever descends; tributaries land exactly on the
 *           level they join. Width follows catchment (≈ sqrt of area).
 *           Per point: a parabolic bed inside the channel, banks rising at a
 *           natural slope, a low levee so the surface is always contained.
 *
 * `reserve` (metres, a square centred on the origin) is the authored World
 * region: it keeps its own water, so no lake is kept and no river runs inside
 * it, and every effect fades to nothing across a band outside its edge.
 */

const TAU = Math.PI * 2;
const clamp = (v, lo = 0, hi = 1) => v < lo ? lo : v > hi ? hi : v;
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (lo, hi, v) => { const t = clamp((v - lo) / (hi - lo)); return t * t * (3 - 2 * t); };
/** Polynomial smooth min/max: C1, so carved ground has no creases. */
const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * .25; };
const smax = (a, b, k) => -smin(-a, -b, k);
const hash = (a, b, seed) => {
  let v = Math.imul(a ^ seed, 374761393) ^ Math.imul(b, 668265263);
  v = Math.imul(v ^ v >>> 13, 1274126177);
  return ((v ^ v >>> 16) >>> 0) / 4294967296;
};

/** How far from the reserved region every water effect has faded in (m). */
export const RESERVE_FADE = 48;
const BUCKET = 32;

/**
 * Priority-flood depression fill (Barnes, Lehman & Mulla 2014) with an
 * epsilon grade. Returns the filled surface; `heights` is not modified.
 */
export function priorityFlood(heights, cols, epsilon) {
  const count = cols * cols, filled = Float32Array.from(heights), done = new Uint8Array(count);
  const heap = new Int32Array(count);
  let size = 0;
  const less = (a, b) => filled[a] < filled[b];
  const push = (i) => {
    let k = size++; heap[k] = i;
    while (k > 0) { const p = (k - 1) >> 1; if (!less(heap[k], heap[p])) break; const t = heap[k]; heap[k] = heap[p]; heap[p] = t; k = p; }
  };
  const pop = () => {
    const top = heap[0]; heap[0] = heap[--size];
    let k = 0;
    for (;;) {
      const l = k * 2 + 1, r = l + 1; let m = k;
      if (l < size && less(heap[l], heap[m])) m = l;
      if (r < size && less(heap[r], heap[m])) m = r;
      if (m === k) break;
      const t = heap[k]; heap[k] = heap[m]; heap[m] = t; k = m;
    }
    return top;
  };
  for (let i = 0; i < cols; i++) for (const index of [i, (cols - 1) * cols + i, i * cols, i * cols + cols - 1]) {
    if (!done[index]) { done[index] = 1; push(index); }
  }
  while (size) {
    const i = pop(), x = i % cols, z = (i - x) / cols;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, zz = z + dz;
      if ((dx === 0 && dz === 0) || xx < 0 || zz < 0 || xx >= cols || zz >= cols) continue;
      const j = zz * cols + xx;
      if (done[j]) continue;
      done[j] = 1;
      const floor = filled[i] + epsilon * (dx && dz ? Math.SQRT2 : 1);
      if (filled[j] < floor) filled[j] = floor;
      push(j);
    }
  }
  return filled;
}

/** Catmull-Rom read of a square grid (value only). */
function cubicAt(grid, cols, cell, origin, x, z) {
  let gx = (x - origin) / cell, gz = (z - origin) / cell;
  const max = cols - 1;
  gx = clamp(gx, 0, max); gz = clamp(gz, 0, max);
  const ix = Math.min(max - 1, Math.floor(gx)), iz = Math.min(max - 1, Math.floor(gz)), tx = gx - ix, tz = gz - iz;
  const w = (t) => [((-t + 2) * t - 1) * t / 2, ((3 * t - 5) * t * t + 2) / 2, ((-3 * t + 4) * t + 1) * t / 2, (t - 1) * t * t / 2];
  const wx = w(tx), wz = w(tz);
  let value = 0;
  for (let j = 0; j < 4; j++) {
    const row = Math.min(max, Math.max(0, iz + j - 1)) * cols;
    let r = 0;
    for (let i = 0; i < 4; i++) r += grid[row + Math.min(max, Math.max(0, ix + i - 1))] * wx[i];
    value += r * wz[j];
  }
  return value;
}

/** Box blur, in place, one pass per axis. */
function blur(grid, cols, radius) {
  const tmp = new Float32Array(grid.length), span = radius * 2 + 1;
  for (let z = 0; z < cols; z++) for (let x = 0; x < cols; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += grid[z * cols + clamp(x + k, 0, cols - 1)];
    tmp[z * cols + x] = sum / span;
  }
  for (let z = 0; z < cols; z++) for (let x = 0; x < cols; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += tmp[clamp(z + k, 0, cols - 1) * cols + x];
    grid[z * cols + x] = sum / span;
  }
}

const D8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/**
 * @param macro     the macro height grid, AFTER the depression fill; lakes are
 *                  dug and their beds deepened in place
 * @param options   { cols, cell, half, seed, amount 0..1, lakes, rivers (style
 *                  multipliers), height (amplitude multiplier H), reserve (m) }
 */
export function* buildHydrologySteps(macro, { cols, cell, half, seed, amount, lakes: lakeBias = 1, rivers: riverBias = 1, height = 1, reserve = 0 }, clock = { due: () => false }) {
  const count = cols * cols;
  const reserveHalf = reserve > 0 ? reserve / 2 : 0;
  const xOf = (i) => -half + (i % cols) * cell, zOf = (i) => -half + Math.floor(i / cols) * cell;
  const reservedCell = (i, margin) => reserveHalf > 0 && Math.max(Math.abs(xOf(i)), Math.abs(zOf(i))) < reserveHalf + margin;
  const edgeCell = (i, margin) => { const c = i % cols, r = (i - c) / cols; return c < margin || r < margin || c >= cols - margin || r >= cols - margin; };

  // ⛔ 09-14 receipt: D8 over a filled flat (a plain epsilon grade) routes in
  // ruler-straight lines with right-angle turns. A smooth jitter below half
  // the grade breaks those ties into meanders; it can never create a sink,
  // because every graded cell keeps a neighbour at least one grade lower.
  const grade = cell * 2e-3;
  const jitter = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const x = xOf(i), z = zOf(i);
    jitter[i] = grade * .45 * Math.sin(x * .021 + Math.sin(z * .017 + seed % 97) * 2.3) * Math.sin(z * .019 - Math.sin(x * .013) * 1.7);
  }
  // ---- drainage of the land as it stands, for lake siting ----
  const drainage = (surface) => {
    const receiver = new Int32Array(count), area = new Float32Array(count).fill(1), order = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      order[i] = i;
      const c = i % cols, r = (i - c) / cols;
      let best = i, drop = 0;
      for (const [dx, dz] of D8) {
        const cc = c + dx, rr = r + dz;
        if (cc < 0 || rr < 0 || cc >= cols || rr >= cols) continue;
        const j = rr * cols + cc, d = (surface[i] + jitter[i] - surface[j] - jitter[j]) / (dx && dz ? Math.SQRT2 : 1);
        if (d > drop) { drop = d; best = j; }
      }
      receiver[i] = best;
    }
    order.sort((a, b) => surface[b] - surface[a]);
    for (let k = 0; k < count; k++) { const i = order[k]; if (receiver[i] !== i) area[receiver[i]] += area[i]; }
    return { receiver, area };
  };

  const lakes = [];
  const lakeOf = new Int32Array(count).fill(-1);
  const lakeAmount = clamp(amount * lakeBias, 0, 1.5);
  if (lakeAmount > 0) {
    // ---- dug lakes: flat valley floors where drainage collects ----
    const graded = priorityFlood(macro, cols, grade);
    const { area } = drainage(graded);
    yield 'landscape:lakes';
    let areaMax = 1;
    for (let i = 0; i < count; i++) if (area[i] > areaMax) areaMax = area[i];
    const logMax = Math.log1p(areaMax);
    const spacing = lerp(900, 420, clamp(lakeAmount));
    const wanted = Math.round((half * 2 / spacing) ** 2 * .55 * clamp(lakeAmount, 0, 1.5));
    const candidates = [];
    for (let i = 0; i < count; i++) {
      if (edgeCell(i, 4) || reservedCell(i, 140)) continue;
      const n = Math.log1p(area[i]) / logMax;
      if (n < .35 || n > .8) continue;
      const c = i % cols, r = (i - c) / cols;
      if (c < 1 || r < 1 || c >= cols - 1 || r >= cols - 1) continue;
      const slope = Math.hypot(macro[i + 1] - macro[i - 1], macro[i + cols] - macro[i - cols]) / (2 * cell);
      if (slope > .12) continue;
      candidates.push([i, n * (1 - slope * 6) + hash(c, r, seed ^ 0x51ed27) * .35, slope]);
    }
    candidates.sort((a, b) => b[1] - a[1]);
    const dug = [];
    for (const [i, , slope] of candidates) {
      if (dug.length >= wanted) break;
      const x = xOf(i), z = zOf(i);
      if (dug.some(site => Math.hypot(site.x - x, site.z - z) < spacing * .7)) continue;
      const c = i % cols, r = (i - c) / cols, key = hash(c, r, seed ^ 0x2b7e1516);
      const radius = lerp(38, 120, key) * Math.sqrt(clamp(lakeAmount, .3, 1.5));
      const stretch = lerp(1.1, 2.2, hash(r, c, seed ^ 0x1f83d9ab));
      // Elongated along the local fall line, like a dammed valley lake.
      const gx = macro[i + 1] - macro[i - 1], gz = macro[i + cols] - macro[i - cols], gl = Math.hypot(gx, gz) || 1;
      const ax = gx / gl, az = gz / gl;
      const depth = slope * radius * stretch * 1.35 + lerp(3, 9, hash(c + 7, r, seed)) * clamp(height, .5, 2);
      dug.push({ x, z, radius, stretch, ax, az, depth });
    }
    for (const site of dug) {
      const reach = site.radius * site.stretch * 1.3;
      const c0 = Math.max(0, Math.floor((site.x - reach + half) / cell)), c1 = Math.min(cols - 1, Math.ceil((site.x + reach + half) / cell));
      const r0 = Math.max(0, Math.floor((site.z - reach + half) / cell)), r1 = Math.min(cols - 1, Math.ceil((site.z + reach + half) / cell));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const dx = -half + c * cell - site.x, dz = -half + r * cell - site.z;
        const along = (dx * site.ax + dz * site.az) / (site.radius * site.stretch), across = (-dx * site.az + dz * site.ax) / site.radius;
        const e = Math.hypot(along, across);
        if (e < 1.3) macro[r * cols + c] -= site.depth * (1 - smoothstep(0, 1.3, e)) ** 1.5;
      }
    }
    yield 'landscape:lakes';

    // ---- every basin below its spill level is a lake candidate ----
    const spill = priorityFlood(macro, cols, 0);
    const minArea = lerp(9000, 1800, clamp(lakeAmount)), minDepth = lerp(2.5, .9, clamp(lakeAmount));
    const seen = new Uint8Array(count), stack = new Int32Array(count);
    const basins = [];
    for (let start = 0; start < count; start++) {
      if (seen[start] || spill[start] - macro[start] < 1e-3) continue;
      let top = 0, deepest = 0, reserved = false, touchesEdge = false;
      const cells = [];
      stack[top++] = start; seen[start] = 1;
      while (top) {
        const i = stack[--top];
        cells.push(i);
        deepest = Math.max(deepest, spill[i] - macro[i]);
        if (reservedCell(i, RESERVE_FADE + cell * 2)) reserved = true;
        if (edgeCell(i, 2)) touchesEdge = true;
        const c = i % cols, r = (i - c) / cols;
        for (const [dx, dz] of D8.slice(0, 4)) {
          const cc = c + dx, rr = r + dz;
          if (cc < 0 || rr < 0 || cc >= cols || rr >= cols) continue;
          const j = rr * cols + cc;
          if (seen[j] || spill[j] - macro[j] < 1e-3) continue;
          seen[j] = 1; stack[top++] = j;
        }
      }
      basins.push({ cells, level: spill[start], deepest, rejected: reserved || touchesEdge || cells.length * cell * cell < minArea || deepest < minDepth });
    }
    // ⛔ 09-14 first count: every kept basin flooded to its spill level put
    // 29-35 % of a 2 km landscape under water. Lakes share a coverage budget
    // (best basins first); a basin bigger than its share floods only its low
    // part, at a lower level, and the rest stays a dry hollow around the lake.
    const budget = (half * 2) ** 2 * lerp(0, .07, clamp(lakeAmount)) * (lakeAmount > 1 ? lakeAmount : 1);
    const largest = Math.max(24000, budget * .55);
    basins.sort((a, b) => b.deepest * Math.sqrt(b.cells.length) - a.deepest * Math.sqrt(a.cells.length) || a.cells[0] - b.cells[0]);
    let covered = 0;
    for (const basin of basins) {
      let { cells, level } = basin;
      if (!basin.rejected && covered < budget) {
        // Varied caps, or every capped lake came out exactly the same size.
        const allowed = Math.min(largest * lerp(.3, 1, hash(basin.cells[0], basin.cells.length, seed ^ 0x6c62272e)), budget - covered + minArea);
        if (cells.length * cell * cell > allowed) {
          const sorted = cells.slice().sort((a, b) => macro[a] - macro[b]);
          level = macro[sorted[Math.max(0, Math.floor(allowed / (cell * cell)) - 1)]];
          // ⛔ A lowered level floods every pocket of a wide flat basin: the
          // meadow receipt showed a spatter of ponds. Only the largest connected
          // piece is the lake; the other pockets are raised to the level (dry).
          const below = new Set(sorted.filter(i => macro[i] < level));
          let best = [];
          const visited = new Set();
          for (const seedCell of below) {
            if (visited.has(seedCell)) continue;
            const piece = [seedCell], queue = [seedCell];
            visited.add(seedCell);
            while (queue.length) {
              const i = queue.pop(), c = i % cols, r = (i - c) / cols;
              for (const [dx, dz] of D8.slice(0, 4)) {
                const j = (r + dz) * cols + c + dx;
                if (c + dx < 0 || r + dz < 0 || c + dx >= cols || r + dz >= cols || !below.has(j) || visited.has(j)) continue;
                visited.add(j); piece.push(j); queue.push(j);
              }
            }
            if (piece.length > best.length) best = piece;
          }
          const keep = new Set(best);
          for (const i of below) if (!keep.has(i)) macro[i] = level + cell * 1e-3;
          cells = best;
        }
        let deepest = 0;
        for (const i of cells) deepest = Math.max(deepest, level - macro[i]);
        if (cells.length * cell * cell >= minArea && deepest >= minDepth) {
          const index = lakes.length;
          let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
          for (const i of cells) {
            lakeOf[i] = index;
            const x = xOf(i), z = zOf(i);
            x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z);
          }
          lakes.push({ index, level, area: cells.length * cell * cell, maxDepth: deepest, cells: cells.length, bounds: [x0 - cell * 3, z0 - cell * 3, x1 + cell * 3, z1 + cell * 3] });
          covered += cells.length * cell * cell;
          continue;
        }
      }
      // Not a lake: fill it, so it cannot read as a dry crater either.
      for (const i of basin.cells) macro[i] = spill[i] + cell * 1e-3;
    }
    if (clock.due()) yield 'landscape:lakes';
    // Shelving beds: never shallower than a metre-scale profile from the shore.
    const distance = new Float32Array(count).fill(Infinity);
    const queue = [];
    for (let i = 0; i < count; i++) if (lakeOf[i] >= 0) {
      const c = i % cols, r = (i - c) / cols;
      const shore = D8.slice(0, 4).some(([dx, dz]) => { const cc = c + dx, rr = r + dz; return cc < 0 || rr < 0 || cc >= cols || rr >= cols || lakeOf[rr * cols + cc] !== lakeOf[i]; });
      if (shore) { distance[i] = 1; queue.push(i); }
    }
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head], c = i % cols, r = (i - c) / cols;
      for (const [dx, dz] of D8.slice(0, 4)) {
        const cc = c + dx, rr = r + dz;
        if (cc < 0 || rr < 0 || cc >= cols || rr >= cols) continue;
        const j = rr * cols + cc;
        if (lakeOf[j] !== lakeOf[i] || distance[j] <= distance[i] + 1) continue;
        distance[j] = distance[i] + 1; queue.push(j);
      }
    }
    for (let i = 0; i < count; i++) if (lakeOf[i] >= 0) {
      const lake = lakes[lakeOf[i]];
      const profile = Math.min(lerp(2, 7, clamp(Math.sqrt(lake.area) / 400)), .8 + distance[i] * cell * .06);
      macro[i] = Math.min(macro[i], lake.level - profile);
    }
  }
  yield 'landscape:lakes';

  // Lake mask for per-point shores: blurred so the contour is round, read bicubic.
  const lakeMask = new Float32Array(count);
  for (let i = 0; i < count; i++) lakeMask[i] = lakeOf[i] >= 0 ? 1 : 0;
  if (lakes.length) blur(lakeMask, cols, 1);
  // Nearest lake within two cells, so a dry point far from water costs one read.
  const lakeNear = Int32Array.from(lakeOf);
  if (lakes.length) for (let pass = 0; pass < 2; pass++) {
    const from = Int32Array.from(lakeNear);
    for (let r = 0; r < cols; r++) for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (from[i] >= 0) continue;
      for (const [dx, dz] of D8) {
        const cc = c + dx, rr = r + dz;
        if (cc < 0 || rr < 0 || cc >= cols || rr >= cols || from[rr * cols + cc] < 0) continue;
        lakeNear[i] = from[rr * cols + cc]; break;
      }
    }
  }

  // ---- rivers: D8 drainage of the graded surface (lakes drain to outlets) ----
  const graded = priorityFlood(macro, cols, grade);
  const { receiver, area } = drainage(graded);
  yield 'landscape:rivers';
  const riverAmount = clamp(amount * riverBias, 0, 1.5);
  const reaches = [];
  if (riverAmount > 0) {
    // Catchment in m² where a river begins: ~1.4 km² at amount 0, ~0.12 km² at 1.
    // ⛔ 09-14 first count: 1.4 km² .. 0.12 km² gave 0-5 reaches on a 2 km landscape.
    const startArea = lerp(4e5, 2.5e4, clamp(riverAmount)) / (cell * cell);
    const isRiver = new Uint8Array(count);
    for (let i = 0; i < count; i++) isRiver[i] = area[i] >= startArea && lakeOf[i] < 0 && !reservedCell(i, RESERVE_FADE * .5) ? 1 : 0;
    const donors = new Int32Array(count), lakeDonor = new Int32Array(count).fill(-1);
    for (let i = 0; i < count; i++) {
      const j = receiver[i];
      if (j === i) continue;
      if (isRiver[i] && (isRiver[j] || lakeOf[j] >= 0)) donors[j]++;
      if (lakeOf[i] >= 0 && isRiver[j]) lakeDonor[j] = lakeOf[i];
    }
    const sources = [];
    for (let i = 0; i < count; i++) if (isRiver[i] && donors[i] === 0) sources.push(i);
    // Largest catchment at the mouth first: trunks are traced before their tributaries.
    const mouthArea = (i) => { let k = i, guard = 0; while (receiver[k] !== k && isRiver[receiver[k]] && guard++ < count) k = receiver[k]; return area[k]; };
    sources.sort((a, b) => mouthArea(b) - mouthArea(a) || area[b] - area[a] || a - b);
    const owner = new Int32Array(count).fill(-1), ownerIndex = new Int32Array(count);
    for (const source of sources) {
      const cellsOf = [source];
      let current = source, end = 'edge', target = -1;
      owner[source] = reaches.length; ownerIndex[source] = 0;
      for (;;) {
        const next = receiver[current];
        if (next === current) { end = 'edge'; break; }
        if (lakeOf[next] >= 0) { end = 'lake'; target = lakeOf[next]; cellsOf.push(next); break; }
        if (!isRiver[next]) { end = 'cut'; break; }
        if (owner[next] >= 0) { end = 'join'; target = owner[next]; cellsOf.push(next); break; }
        owner[next] = reaches.length; ownerIndex[next] = cellsOf.length;
        cellsOf.push(next);
        current = next;
      }
      const joinIndex = end === 'join' ? ownerIndex[cellsOf[cellsOf.length - 1]] : -1;
      reaches.push({ index: reaches.length, cells: cellsOf, end, target, joinIndex, startLake: lakeDonor[source] });
      if (clock.due()) yield 'landscape:rivers';
    }
    // Surfaces in trace order: a reach only ever joins one traced before it.
    for (const reach of reaches) {
      const n = reach.cells.length, surface = new Float64Array(n), width = new Float64Array(n), depth = new Float64Array(n);
      let running = reach.startLake >= 0 ? lakes[reach.startLake].level : Infinity;
      for (let k = 0; k < n; k++) {
        const i = reach.cells[k];
        const catchment = area[Math.min(i, count - 1)] * cell * cell;
        width[k] = clamp(1.15 * Math.sqrt(catchment / 1e4), 2.5, 34);
        depth[k] = clamp(.45 + width[k] * .055, .5, 2.6);
        running = Math.min(running, macro[i] - (.35 + depth[k] * .3));
        surface[k] = running;
      }
      let landing = -Infinity;
      if (reach.end === 'lake') landing = lakes[reach.target].level;
      else if (reach.end === 'join') landing = reaches[reach.target].surface[reach.joinIndex];
      if (Number.isFinite(landing)) for (let k = 0; k < n; k++) surface[k] = Math.max(surface[k], landing);
      if (reach.end === 'join' || reach.end === 'lake') { surface[n - 1] = landing; width[n - 1] = width[Math.max(0, n - 2)]; }
      reach.surface = surface; reach.width = width; reach.depth = depth;
    }
    yield 'landscape:rivers';
    // Smooth into polylines [x, z, surface, width, depth] (Chaikin x2, ends fixed).
    const kept = [];
    const joined = new Set(reaches.filter(r => r.end === 'join').map(r => r.target));
    for (const reach of reaches) {
      if (reach.cells.length < 3 && !joined.has(reach.index)) continue;
      let points = reach.cells.map((i, k) => [xOf(i), zOf(i), reach.surface[k], reach.width[k], reach.depth[k]]);
      for (let pass = 0; pass < 2; pass++) {
        if (points.length < 3) break;
        const next = [points[0]];
        for (let k = 0; k < points.length - 1; k++) {
          const a = points[k], b = points[k + 1];
          next.push(a.map((v, j) => v * .75 + b[j] * .25), a.map((v, j) => v * .25 + b[j] * .75));
        }
        next.push(points[points.length - 1]);
        points = next;
      }
      // A gentle meander on top of the drainage path (a cell-scale staircase
      // otherwise), tapered to zero at both ends so junctions stay put.
      // ⛔ A fixed 3 m wiggle left 600 m ruler-straight reaches across the
      // highlands' filled benches: flats get a wide meander, slopes a small one.
      for (let k = 1; k < points.length - 1; k++) {
        const taper = Math.min(1, k / 6, (points.length - 1 - k) / 6);
        const [px, pz] = points[k], a = points[k - 1], b = points[k + 1];
        const e = cell;
        const fall = Math.hypot(cubicAt(macro, cols, cell, -half, px + e, pz) - cubicAt(macro, cols, cell, -half, px - e, pz),
          cubicAt(macro, cols, cell, -half, px, pz + e) - cubicAt(macro, cols, cell, -half, px, pz - e)) / (2 * e);
        // ⛔ D8 down a plain slope is axis-aligned too (the highlands receipt's
        // 600 m straight reach vanished with water=0, so it was a river): sloped
        // reaches meander as well, a little less than flats.
        const amplitude = lerp(Math.min(cell * 1.6, 16), Math.min(cell * 1.1, 10), smoothstep(.015, .09, fall));
        const tx = b[0] - a[0], tz = b[1] - a[1], tl = Math.hypot(tx, tz) || 1;
        const wave = Math.sin(px * .031 + Math.sin(pz * .023) * 2) * Math.cos(pz * .027 - px * .009);
        points[k] = [px - tz / tl * wave * amplitude * taper, pz + tx / tl * wave * amplitude * taper, ...points[k].slice(2)];
      }
      // A confluence lands on the trunk's centreline at its own level.
      if (reach.end === 'join') {
        const trunk = reaches[reach.target], last = points[points.length - 1];
        last[2] = trunk.surface[reach.joinIndex];
      }
      const packed = new Float64Array(points.length * 5);
      points.forEach((p, k) => packed.set(p, k * 5));
      kept.push({ id: `river/${kept.length}`, points: packed, end: reach.end, catchment: area[reach.cells[reach.cells.length - 1]] * cell * cell, source: reach.index });
    }
    reaches.length = 0;
    reaches.push(...kept);
  }

  // ---- segment index for per-point queries (CSR buckets) ----
  const bucketCols = Math.ceil(half * 2 / BUCKET) + 1, bucketCount = bucketCols * bucketCols;
  const counts = new Int32Array(bucketCount + 1);
  const visitSegments = (emit) => {
    for (let r = 0; r < reaches.length; r++) {
      const p = reaches[r].points, n = p.length / 5;
      for (let k = 0; k < n - 1; k++) {
        const reach = Math.max(p[k * 5 + 3], p[(k + 1) * 5 + 3]) / 2 + bankReach(Math.max(p[k * 5 + 3], p[(k + 1) * 5 + 3]));
        const x0 = Math.min(p[k * 5], p[(k + 1) * 5]) - reach, x1 = Math.max(p[k * 5], p[(k + 1) * 5]) + reach;
        const z0 = Math.min(p[k * 5 + 1], p[(k + 1) * 5 + 1]) - reach, z1 = Math.max(p[k * 5 + 1], p[(k + 1) * 5 + 1]) + reach;
        const b0 = Math.max(0, Math.floor((x0 + half) / BUCKET)), b1 = Math.min(bucketCols - 1, Math.floor((x1 + half) / BUCKET));
        const c0 = Math.max(0, Math.floor((z0 + half) / BUCKET)), c1 = Math.min(bucketCols - 1, Math.floor((z1 + half) / BUCKET));
        for (let bz = c0; bz <= c1; bz++) for (let bx = b0; bx <= b1; bx++) emit(bz * bucketCols + bx, r, k);
      }
    }
  };
  visitSegments((bucket) => counts[bucket + 1]++);
  for (let b = 0; b < bucketCount; b++) counts[b + 1] += counts[b];
  const items = new Int32Array(counts[bucketCount] * 2), fillAt = counts.slice(0, bucketCount);
  visitSegments((bucket, r, k) => { const at = fillAt[bucket]++; items[at * 2] = r; items[at * 2 + 1] = k; });
  yield 'landscape:rivers';

  const shoreNoiseScale = Math.min(3, cell * .3);
  const reachStamp = new Int32Array(reaches.length), reachDistance = new Float64Array(reaches.length), reachSegment = new Int32Array(reaches.length), reachT = new Float64Array(reaches.length);
  let stamp = 0;

  function reserveWeight(x, z) {
    return reserveHalf > 0 ? smoothstep(reserveHalf, reserveHalf + RESERVE_FADE, Math.max(Math.abs(x), Math.abs(z))) : 1;
  }

  /** The lake nearest (x, z) and the signed distance (m, wet positive) to its shore. */
  function lakeAt(x, z, out = {}) {
    out.lake = -1; out.signed = -Infinity; out.level = NaN;
    if (!lakes.length) return out;
    const gx = (x + half) / cell, gz = (z + half) / cell;
    if (gx < -1 || gz < -1 || gx > cols || gz > cols) return out;
    const c = clamp(Math.round(gx), 0, cols - 1), r = clamp(Math.round(gz), 0, cols - 1);
    const lake = lakeNear[r * cols + c];
    if (lake < 0) return out;
    const m = cubicAt(lakeMask, cols, cell, -half, x, z);
    const wobble = Math.sin(x * .11 + Math.sin(z * .07) * 2.1) * Math.sin(z * .09 - x * .03) * shoreNoiseScale;
    out.lake = lake; out.level = lakes[lake].level;
    out.signed = (m - .5) * cell * 2 + wobble;
    return out;
  }

  const lakeWork = {};
  /**
   * Carve (x, z)'s height `h` for lakes and rivers; writes water, waterDepth
   * (≥ 0), shore (m to the nearest water edge, dry positive), flowX/flowZ and
   * wet (0..1, how much the water reshaped this point). Returns the new height.
   */
  function apply(x, z, h, out) {
    out.water = NaN; out.waterDepth = 0; out.shore = Infinity; out.flowX = 0; out.flowZ = 0; out.wet = 0;
    const fade = reserveWeight(x, z);
    if (fade <= 0) return h;
    let wet = 0;
    // Lakes: flat surface, bed below it inside, a held rim just outside.
    if (lakes.length) {
      const lake = lakeAt(x, z, lakeWork);
      if (lake.lake >= 0 && lake.signed > -10) {
        const level = lake.level, s = lake.signed;
        let target;
        if (s >= 0) {
          const bed = smin(h, level - Math.min(lakes[lake.lake].maxDepth + 1, 1.2 + s * .35), .6);
          target = lerp(level, bed, smoothstep(0, 3, s));
        } else {
          const rim = smax(h, level + .3 * smoothstep(0, 3, -s), .3);
          target = lerp(lerp(level, rim, smoothstep(0, 3, -s)), h, smoothstep(3, 9, -s));
        }
        const weight = 1 - smoothstep(3, 9, -s);
        h = lerp(h, target, fade);
        wet = Math.max(wet, weight * fade);
        if (s > -3 && fade >= .999) { out.water = level; out.waterDepth = Math.max(0, level - h); }
        out.shore = Math.min(out.shore, -s);
      }
    }
    // Rivers: each reach once, by its nearest segment.
    const bx = Math.floor((x + half) / BUCKET), bz = Math.floor((z + half) / BUCKET);
    if (reaches.length && bx >= 0 && bz >= 0 && bx < bucketCols && bz < bucketCols) {
      const bucket = bz * bucketCols + bx, from = counts[bucket], to = counts[bucket + 1];
      if (to > from) {
        stamp++;
        let minReach = Infinity, maxReach = -1;
        for (let q = from; q < to; q++) {
          const r = items[q * 2], k = items[q * 2 + 1], p = reaches[r].points;
          const ax = p[k * 5], az = p[k * 5 + 1], dx = p[(k + 1) * 5] - ax, dz = p[(k + 1) * 5 + 1] - az;
          const len2 = dx * dx + dz * dz, t = len2 > 0 ? clamp(((x - ax) * dx + (z - az) * dz) / len2) : 0;
          const d = Math.hypot(x - ax - dx * t, z - az - dz * t);
          if (reachStamp[r] !== stamp || d < reachDistance[r]) { reachStamp[r] = stamp; reachDistance[r] = d; reachSegment[r] = k; reachT[r] = t; }
          if (r < minReach) minReach = r; if (r > maxReach) maxReach = r;
        }
        for (let r = minReach; r <= maxReach; r++) {
          if (reachStamp[r] !== stamp) continue;
          const p = reaches[r].points, k = reachSegment[r], t = reachT[r], d = reachDistance[r];
          const surface = lerp(p[k * 5 + 2], p[(k + 1) * 5 + 2], t), width = lerp(p[k * 5 + 3], p[(k + 1) * 5 + 3], t), depth = lerp(p[k * 5 + 4], p[(k + 1) * 5 + 4], t);
          const inner = width / 2, reach = inner + bankReach(width);
          if (d >= reach) continue;
          const bed = d < inner ? surface - depth * (1 - (d / inner) ** 2) : surface + (d - inner) * .42;
          let carved = smin(h, bed, .5);
          // A low levee: the ground by the channel never sits under the water.
          carved = lerp(carved, smax(carved, surface + .12 + Math.max(0, d - inner) * .05, .25), smoothstep(inner - 1.2, inner + .4, d));
          const weight = (1 - smoothstep(reach * .55, reach, d)) * fade;
          h = lerp(h, carved, weight);
          wet = Math.max(wet, (1 - smoothstep(inner, reach, d)) * fade);
          out.shore = Math.min(out.shore, d - inner);
          if (d < inner + 1.5 && fade >= .999 && !(out.water > surface)) {
            out.water = surface; out.waterDepth = Math.max(0, surface - h);
            const dx = p[(k + 1) * 5] - p[k * 5], dz = p[(k + 1) * 5 + 1] - p[k * 5 + 1], len = Math.hypot(dx, dz) || 1;
            const speed = clamp(.35 + (p[k * 5 + 2] - p[(k + 1) * 5 + 2]) / len * 40, .3, 2.5);
            out.flowX = dx / len * speed; out.flowZ = dz / len * speed;
          }
        }
      }
    }
    out.wet = wet;
    return h;
  }

  /** Segments whose START point lies in [x0,x1)×[z0,z1): a chunk's own piece of every river. */
  function riverSegmentsIn(x0, z0, x1, z1) {
    const out = [];
    for (let r = 0; r < reaches.length; r++) {
      const p = reaches[r].points, n = p.length / 5;
      for (let k = 0; k < n - 1; k++) {
        const x = p[k * 5], z = p[k * 5 + 1];
        if (x >= x0 && x < x1 && z >= z0 && z < z1) out.push([r, k]);
      }
    }
    return out;
  }

  /** Cheap pre-test: false means (x, z) is certainly more than a few metres from any water. */
  function mayBeWet(x, z) {
    if (reserveWeight(x, z) <= 0) return false;
    const c = Math.round((x + half) / cell), r = Math.round((z + half) / cell);
    if (lakes.length && c >= 0 && r >= 0 && c < cols && r < cols && lakeNear[r * cols + c] >= 0) return true;
    const bx = Math.floor((x + half) / BUCKET), bz = Math.floor((z + half) / BUCKET);
    if (bx < 0 || bz < 0 || bx >= bucketCols || bz >= bucketCols) return false;
    const bucket = bz * bucketCols + bx;
    return counts[bucket + 1] > counts[bucket];
  }

  function lakesIn(x0, z0, x1, z1) {
    return lakes.filter(lake => lake.bounds[0] < x1 && lake.bounds[2] > x0 && lake.bounds[1] < z1 && lake.bounds[3] > z0);
  }

  return Object.freeze({ lakes, reaches, apply, lakeAt, mayBeWet, reserveWeight, riverSegmentsIn, lakesIn, bankReach, reserveHalf });
}

/** How far past its edge a river of this width reshapes its banks (m). */
export function bankReach(width) { return Math.max(7, width * 1.4); }
