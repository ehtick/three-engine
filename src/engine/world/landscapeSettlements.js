import { planSettlements, SETTLEMENT_PATTERNS } from './settlements.js';
import { worldRandom } from './worldLayout.js';

/**
 * Settlements across a streamed landscape (09-14, T6 W6; owner: "build
 * buildings … there").
 *
 * The world is cut into SETTLEMENT_CELL squares. A cell may hold one hamlet,
 * sited by a hash of the cell and planned by the SAME planner the authored
 * valley uses (`planSettlements`: streets, plots, pads, feathers) on a
 * WINDOW-sized piece of the raw landscape around its site. The window (plus
 * every road and pad feather) lies strictly inside its cell, so:
 *   - a plan is a pure function of (landscape, seed, cell) — any load order,
 *     any chunk, the same village;
 *   - a point is only ever reshaped by the plan of the cell it lies in.
 *
 * `apply(x, z, out)` folds a resolved plan into a landscape sample: graded
 * lanes (the valley's corridor profile) then level pads (its rounded-rectangle
 * blend), writing `path` and `pad` masks and softening cliff/tower/gradient so
 * nothing else grows or stands on them. Planning is ~15-30 ms per hamlet, so
 * a streamer resolves a chunk's cells as a job before building its ground.
 */

export const SETTLEMENT_CELL = 640;
const WINDOW = 256;
const MARGIN = 16;
const clamp = (v, lo = 0, hi = 1) => v < lo ? lo : v > hi ? hi : v;
const smooth = (lo, hi, v) => { const t = clamp((v - lo) / (hi - lo)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
const hash = (a, b, seed) => {
  let v = Math.imul(a ^ seed, 374761393) ^ Math.imul(b, 668265263);
  v = Math.imul(v ^ v >>> 13, 1274126177);
  return ((v ^ v >>> 16) >>> 0) / 4294967296;
};

/**
 * @param landscape  raw landscape (hydrology included)
 * @param options    seed, density 0..1 (share of cells with a hamlet, and their
 *                   size), reserve (m: the World region, kept clear), settlement
 *                   (planner options: roadWidth, maxGrade, buildingScale, pattern…),
 *                   footprint(variationSeed, role) -> {width, depth}
 */
export function createLandscapeSettlements(landscape, { seed = 894, density = .5, reserve = 0, settlement = {}, footprint = null } = {}) {
  const plans = new Map();
  const keyOf = (ix, iz) => ix * 131071 + iz;
  const half = landscape.extent / 2, reserveHalf = reserve / 2;
  const maxGrade = settlement.maxGrade ?? .35;
  const raw = {};

  function siteOf(ix, iz) {
    if (!(density > 0)) return null;
    if (hash(ix, iz, seed ^ 0x2545f491) > clamp(density) * .8) return null;
    const room = SETTLEMENT_CELL - WINDOW - 2 * MARGIN - 8;
    const cx = (ix + .5) * SETTLEMENT_CELL + (hash(iz, ix, seed ^ 0x1b3) - .5) * room;
    const cz = (iz + .5) * SETTLEMENT_CELL + (hash(ix + 17, iz - 5, seed ^ 0x7f1) - .5) * room;
    const w = WINDOW / 2 + MARGIN;
    if (Math.abs(cx) + w > half - 8 || Math.abs(cz) + w > half - 8) return null;
    if (reserveHalf > 0 && Math.abs(cx) - w < reserveHalf + 32 && Math.abs(cz) - w < reserveHalf + 32) return null;
    return [cx, cz];
  }

  /** Road elevations: the ground along the lane, smoothed, then held to the planner's grade. */
  function grade(points) {
    const n = points.length, y = points.map(([x, z]) => landscape.sample(x, z, raw).height);
    for (let pass = 0; pass < 4; pass++) for (let k = 1; k < n - 1; k++) y[k] = (y[k - 1] + 2 * y[k] + y[k + 1]) / 4;
    const length = k => Math.hypot(points[k][0] - points[k - 1][0], points[k][1] - points[k - 1][1]);
    for (let k = 1; k < n; k++) y[k] = clamp(y[k], y[k - 1] - maxGrade * length(k), y[k - 1] + maxGrade * length(k));
    for (let k = n - 2; k >= 0; k--) y[k] = clamp(y[k], y[k + 1] - maxGrade * length(k + 1), y[k + 1] + maxGrade * length(k + 1));
    return y;
  }

  function planCell(ix, iz) {
    const site = siteOf(ix, iz);
    if (!site) return null;
    const [ox, oz] = site;
    const fields = {
      sample(x, z) {
        if (Math.abs(x) > WINDOW / 2 || Math.abs(z) > WINDOW / 2) return null;
        const s = landscape.sample(ox + x, oz + z, raw);
        return { height: s.height, slope: Math.hypot(s.gx, s.gz), shore: Number.isFinite(s.shore) ? s.shore : 64 };
      },
      sampleHeight(x, z) { return landscape.sample(ox + x, oz + z, raw).height; },
    };
    const cellSeed = (seed ^ Math.imul(ix, 73856093) ^ Math.imul(iz, 19349663)) >>> 0;
    const budget = 3 + Math.floor(hash(ix, iz, seed ^ 0x51) * (3 + 10 * clamp(density)));
    const pattern = SETTLEMENT_PATTERNS.includes(settlement.pattern) ? settlement.pattern : ['cluster', 'street', 'scattered'][Math.floor(hash(iz, ix, seed ^ 0x77) * 3)];
    const result = planSettlements({ fields, extent: WINDOW, budget, footprint,
      random: (channel, index = 0) => worldRandom(cellSeed, 500 + channel, index), settlement: { ...settlement, count: 1, pattern } });
    if (!result.buildings.length) return null;
    const id = `hamlet/${ix},${iz}`;
    const roads = result.roads.map(road => {
      const points = road.points.map(([x, z]) => [ox + x, oz + z]);
      return { id: `${id}/${road.id}`, kind: road.kind, width: road.width, points, elevations: grade(points),
        half: road.width / 2, feather: Math.max(1.2, road.width * .85) };
    });
    // A side street starts on a street already laid: it lands on that level.
    for (let r = 1; r < roads.length; r++) {
      const [x, z] = roads[r].points[0], landing = roadAt(roads.slice(0, r), x, z);
      if (!landing || landing.distance > 1.5) continue;
      const delta = landing.target - roads[r].elevations[0];
      roads[r].elevations = roads[r].elevations.map((y, k) => y + delta * Math.max(0, 1 - k / 6));
    }
    const buildings = result.buildings.map(b => ({ id: `${id}/${b.id}`, settlement: id, role: b.role, scale: b.scale, variationSeed: b.variationSeed,
      position: [ox + b.position[0], b.position[1], oz + b.position[2]], rotation: [...b.rotation], halfWidth: b.halfWidth, halfDepth: b.halfDepth, feather: b.feather }));
    const pads = buildings.map(b => ({ center: b.position, angle: b.rotation[1], halfWidth: b.halfWidth, halfDepth: b.halfDepth, feather: b.feather }));
    const w = WINDOW / 2 + MARGIN;
    return { id, cell: [ix, iz], site, buildings, pads, roads, pattern: result.settlements[0]?.pattern ?? pattern,
      kind: result.settlements[0]?.kind ?? 'hamlet', bounds: [ox - w, oz - w, ox + w, oz + w] };
  }

  /** Nearest graded lane within its corridor reach. */
  function roadAt(roads, x, z) {
    let best = null, best2 = Infinity;
    for (const road of roads) {
      const reach = road.half + road.feather;
      for (let k = 1; k < road.points.length; k++) {
        const a = road.points[k - 1], b = road.points[k], dx = b[0] - a[0], dz = b[1] - a[1], len2 = dx * dx + dz * dz;
        if (len2 < 1e-9) continue;
        const t = clamp(((x - a[0]) * dx + (z - a[1]) * dz) / len2);
        const ex = x - a[0] - dx * t, ez = z - a[1] - dz * t, d2 = ex * ex + ez * ez;
        if (d2 >= best2 || d2 > reach * reach) continue;
        best2 = d2;
        best = { road, distance: 0, target: road.elevations[k - 1] + (road.elevations[k] - road.elevations[k - 1]) * t };
      }
    }
    if (best) best.distance = Math.sqrt(best2);
    return best;
  }

  /** Rounded-rectangle distance from a pad's rectangle (negative inside), as landscapeFields does. */
  function padDistance(pad, x, z) {
    const c = Math.cos(pad.angle), s = Math.sin(pad.angle), dx = x - pad.center[0], dz = z - pad.center[2];
    const px = Math.abs(c * dx - s * dz) - pad.halfWidth, pz = Math.abs(s * dx + c * dz) - pad.halfDepth;
    return px <= 0 && pz <= 0 ? Math.max(px, pz) : Math.hypot(Math.max(px, 0), Math.max(pz, 0));
  }

  function planAt(x, z) {
    const plan = plans.get(keyOf(Math.floor(x / SETTLEMENT_CELL), Math.floor(z / SETTLEMENT_CELL)))?.plan;
    if (!plan) return null;
    const b = plan.bounds;
    return x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3] ? plan : null;
  }

  function apply(x, z, out) {
    out.path = 0; out.pad = 0;
    const plan = planAt(x, z);
    if (!plan) return out;
    let h = out.height, natural = 1;
    const road = roadAt(plan.roads, x, z);
    if (road) {
      const blend = smooth(road.road.half, road.road.half + road.road.feather, road.distance);
      h = mix(road.target, h, blend);
      natural *= blend;
      out.path = 1 - smooth(road.road.half * .75, road.road.half + .5, road.distance);
    }
    for (const pad of plan.pads) {
      const distance = padDistance(pad, x, z);
      if (distance > pad.feather) continue;
      const blend = smooth(0, pad.feather, distance);
      h = mix(pad.center[1], h, blend);
      natural *= blend;
      out.pad = Math.max(out.pad, 1 - smooth(0, 1.5, distance));
    }
    if (natural < 1) {
      out.height = h;
      out.gx *= natural; out.gz *= natural;
      out.cliff = (out.cliff ?? 0) * natural; out.tower = (out.tower ?? 0) * natural;
      // Water depth follows the reshaped ground (a lane never runs into a lake: sited dry).
      if (Number.isFinite(out.water)) out.waterDepth = Math.max(0, out.water - h);
    }
    return out;
  }

  /** True on a lane or a building plot (plus a working margin): nothing grows or stands there. */
  function blocked(x, z) {
    const plan = planAt(x, z);
    if (!plan) return false;
    const road = roadAt(plan.roads, x, z);
    if (road && road.distance < road.road.half + 1) return true;
    return plan.pads.some(pad => padDistance(pad, x, z) < 1.5);
  }

  const cellsOf = (x0, z0, x1, z1) => {
    const out = [];
    for (let iz = Math.floor(z0 / SETTLEMENT_CELL); iz <= Math.floor((z1 - 1e-9) / SETTLEMENT_CELL); iz++) {
      for (let ix = Math.floor(x0 / SETTLEMENT_CELL); ix <= Math.floor((x1 - 1e-9) / SETTLEMENT_CELL); ix++) out.push([ix, iz]);
    }
    return out;
  };

  function* resolveCellSteps(ix, iz) {
    const key = keyOf(ix, iz);
    if (plans.has(key)) return plans.get(key).plan;
    yield 'sites';
    const plan = planCell(ix, iz);
    plans.set(key, { ix, iz, plan });
    return plan;
  }

  return {
    apply, blocked,
    resolvedRect: ({ x0, z0, x1, z1 }) => cellsOf(x0, z0, x1, z1).every(([ix, iz]) => plans.has(keyOf(ix, iz))),
    *resolveRectSteps({ x0, z0, x1, z1 }) { for (const [ix, iz] of cellsOf(x0, z0, x1, z1)) yield* resolveCellSteps(ix, iz); },
    resolveCellSteps,
    /** Buildings whose position lies in [x0,x1)×[z0,z1), from resolved cells. */
    buildingsIn(x0, z0, x1, z1) {
      const out = [];
      for (const [ix, iz] of cellsOf(x0, z0, x1, z1)) {
        for (const building of plans.get(keyOf(ix, iz))?.plan?.buildings ?? []) {
          const [x, , z] = building.position;
          if (x >= x0 && x < x1 && z >= z0 && z < z1) out.push(building);
        }
      }
      return out;
    },
    plans: () => [...plans.values()].map(entry => entry.plan).filter(Boolean),
    /** Forget plans of cells farther than `keep` from (x, z): they re-plan identically when needed. */
    prune(x, z, keep) {
      for (const [key, { ix, iz }] of plans) {
        const x0 = ix * SETTLEMENT_CELL, z0 = iz * SETTLEMENT_CELL;
        const d = Math.hypot(Math.max(x0 - x, 0, x - x0 - SETTLEMENT_CELL), Math.max(z0 - z, 0, z - z0 - SETTLEMENT_CELL));
        if (d > keep) plans.delete(key);
      }
    },
    /** JS heap estimate for the plans held. */
    bytes() {
      let total = 0;
      for (const { plan } of plans.values()) total += 64 + (plan ? 600 + plan.buildings.length * 420 + plan.roads.reduce((sum, road) => sum + road.points.length * 72, 0) : 0);
      return total;
    },
  };
}

/** A landscape whose samples carry the settlements: tiles, colliders, water, plants and grass all see pads and lanes. */
export function composeLandscape(landscape, settlements) {
  if (!settlements) return landscape;
  return Object.freeze({ ...landscape, base: landscape, settlements,
    sample(x, z, out = {}) { landscape.sample(x, z, out); return settlements.apply(x, z, out); } });
}
