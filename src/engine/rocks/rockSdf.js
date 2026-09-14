/**
 * Procedural stone as signed distance fields (09-14 owner brief: "a lot better
 * looking procedural rock … whole structures from stone where appropriate").
 *
 * The rocks this replaces were jittered prisms and icosahedra: every piece had
 * the same 6-8 facets, so a field of them read as scattered dice. A signed
 * distance field lets one piece be several honest processes at once:
 *
 *   - a massing primitive (ellipsoid, box, tapered column, torus arch),
 *   - a low-frequency DOMAIN WARP, so every cut below is slightly curved,
 *   - many FRACTURE PLANES intersected with a tight smooth-max — broad flat
 *     faces meeting at chipped edges, the signature of jointed rock,
 *   - optional BEDDING whose depth and spacing wander (never a regular stack:
 *     the first receipt's even grooves read as pancakes, tyres and bricks),
 *   - COLUMNAR JOINTING for basalt: tight Voronoi prisms whose heights follow
 *     a smooth field, stepped, so neighbours agree the way real columns do,
 *   - weathering fBm, strong at low frequency and faint at high.
 *
 * Every builder returns `{ kind, bounds, distance(x,y,z), lipschitz, voxel }`
 * in local metres, y up, y = 0 at the ground contact (bounds extend below 0 so
 * a placed rock can sink into a slope). Mesh with `meshSignedDistance`.
 * Pure functions of (params, seed).
 */

import { createSimplex3, createWorley2, hash2, mulberry32 } from '../terrain/terrainNoise.js';

const clamp = (v, lo = 0, hi = 1) => v < lo ? lo : v > hi ? hi : v;
const lerp = (a, b, t) => a + (b - a) * t;
const smin = (a, b, k) => { const h = clamp(.5 + .5 * (b - a) / k); return lerp(b, a, h) - k * h * (1 - h); };
const smax = (a, b, k) => -smin(-a, -b, k);

export const ROCK_KINDS = Object.freeze(['boulder', 'slab', 'ledge', 'spire', 'columns', 'arch', 'wall']);

function sdEllipsoid(x, y, z, rx, ry, rz) {
  const k0 = Math.hypot(x / rx, y / ry, z / rz), k1 = Math.hypot(x / (rx * rx), y / (ry * ry), z / (rz * rz));
  return k1 > 1e-9 ? k0 * (k0 - 1) / k1 : -Math.min(rx, ry, rz);
}
function sdRoundBox(x, y, z, bx, by, bz, r) {
  const qx = Math.abs(x) - bx + r, qy = Math.abs(y) - by + r, qz = Math.abs(z) - bz + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - r;
}

/** Seeded helpers shared by every builder. */
function kit(seed) {
  const random = mulberry32(seed);
  const n3 = createSimplex3(seed);
  const fbm = (x, y, z, octaves = 3, gain = .5) => {
    let sum = 0, amp = .5, f = 1;
    for (let i = 0; i < octaves; i++) { sum += n3(x * f + i * 7.1, y * f - i * 3.3, z * f + i * 5.7) * amp; amp *= gain; f *= 2.02; }
    return sum;
  };
  /** Fracture planes: unit normals + offsets. `vertical` 1 keeps them joint-like
   * (near-vertical faces), 0 spreads them over the sphere. */
  const planes = (count, radius, depth, vertical = .5, yBias = 0) => Array.from({ length: count }, () => {
    const a = random() * Math.PI * 2;
    const e = (random() * 2 - 1) * lerp(1.2, .35, vertical) + yBias;
    const c = Math.cos(e);
    return { nx: Math.cos(a) * c, ny: Math.sin(e), nz: Math.sin(a) * c, offset: radius * lerp(depth[0], depth[1], random()) };
  });
  const cut = (d, x, y, z, list, k) => {
    for (const p of list) d = smax(d, x * p.nx + y * p.ny + z * p.nz - p.offset, k);
    return d;
  };
  /** Irregular bedding: groove depth 0..1 with wandering spacing and a
   * depth that fades in and out along the bed, so no groove runs all round. */
  const bedding = (x, y, z, spacing, scale) => {
    const u = y / spacing + n3(x / (spacing * 6), y / (spacing * 9), z / (spacing * 6)) * .8;
    const f = u - Math.floor(u);
    const presence = clamp(n3(x / (spacing * 4) + 9.1, Math.floor(u) * 1.7, z / (spacing * 4)) * 1.4 + .35);
    return Math.exp(-Math.pow((f - .5) / .11, 2)) * presence * scale;
  };
  return { random, n3, fbm, planes, cut, bedding };
}

/** Angular fractured boulder. size = longest horizontal dimension (m). */
function boulder({ size = 2, seed = 1, roundness = .35 }) {
  const { random, fbm, planes, cut } = kit(seed);
  const rx = size * .5, rz = size * lerp(.34, .46, random()), ry = size * lerp(.24, .38, random());
  const R = Math.max(rx, rz);
  const list = planes(9 + Math.floor(random() * 6), R, [.42, .72], .3);
  const k = size * lerp(.012, .05, roundness), cy = ry * .55, warp = size * .12;
  return {
    kind: 'boulder', bounds: [-rx * 1.3, -ry * .5, -rz * 1.3, rx * 1.3, ry * 1.6, rz * 1.3], lipschitz: 1.5, voxel: size / 44,
    distance(x, y, z) {
      const s = 1.6 / size;
      const wx = x + fbm(x * s, y * s, z * s, 2) * warp, wy = y - cy + fbm(x * s + 5, y * s, z * s, 2) * warp * .6, wz = z + fbm(x * s, y * s + 9, z * s, 2) * warp;
      let d = sdEllipsoid(wx, wy, wz, rx * 1.2, ry * 1.25, rz * 1.2);
      d = cut(d, wx, wy / (ry / R), wz, list, k);
      return d + fbm(x / size * 4, y / size * 4, z / size * 4, 3) * size * .02;
    },
  };
}

/** Tilted bedded slab: a plate of stone broken off a stratum. */
function slab({ size = 4, seed = 1 }) {
  const { random, fbm, planes, cut, bedding } = kit(seed);
  const bx = size * .5, bz = size * lerp(.32, .45, random()), by = size * lerp(.07, .12, random());
  const tilt = lerp(.1, .32, random()) * (random() < .5 ? -1 : 1), c = Math.cos(tilt), s = Math.sin(tilt);
  const outline = planes(7 + Math.floor(random() * 4), bx, [.55, .95], 1);
  const faces = [{ nx: 0, ny: 1, nz: 0, offset: by * .8 }, { nx: 0, ny: -1, nz: 0, offset: by * .8 }].map(p => ({ ...p, nx: (random() - .5) * .12, nz: (random() - .5) * .12 }));
  return {
    kind: 'slab', bounds: [-bx * 1.15, -by * 2.5, -bz * 1.4 - by * 2, bx * 1.15, by * 2.5 + bz * Math.abs(s), bz * 1.4 + by * 2], lipschitz: 1.5, voxel: size / 56,
    distance(x, y, z) {
      const ly = (y - by * .5) * c - z * s, lz = (y - by * .5) * s + z * c;
      const wx = x + fbm(x / size * 1.5, ly / size, lz / size * 1.5, 2) * size * .08;
      let d = sdRoundBox(wx, ly, lz, bx * 1.1, by, bz * 1.15, by * .3);
      d = cut(d, wx, 0, lz, outline, size * .012);
      d = cut(d, wx, ly, lz, faces, by * .15);
      d += bedding(x, ly, z, by * .6, by * .1);
      return d + fbm(x / size * 5, y / size * 5, z / size * 5) * size * .01;
    },
  };
}

/** Stepped outcrop shelf: fractured strata receding uphill (-z is uphill). */
function ledge({ size = 8, height = 4, seed = 1 }) {
  const { random, fbm, planes, cut } = kit(seed);
  const layers = 2 + Math.floor(random() * 3);
  const courses = Array.from({ length: layers }, (_, i) => {
    const t = i / layers, thick = height / layers * lerp(.8, 1.25, random());
    const hx = size * .5 * lerp(1, .55, t) * lerp(.8, 1.05, random());
    return {
      y: height * (t + .5 / layers), hy: thick * .55, hx, hz: size * .3 * lerp(1, .55, t),
      z: -size * .2 * t + (random() - .5) * size * .06, x: (random() - .5) * size * .12,
      outline: planes(6, hx, [.5, .95], 1),
    };
  });
  return {
    kind: 'ledge', bounds: [-size * .65, -height * .35, -size * .72, size * .65, height * 1.25, size * .5], lipschitz: 1.6, voxel: Math.max(size, height) / 64,
    distance(x, y, z) {
      const wx = x + fbm(x / size, y / size, z / size, 2) * size * .1, wz = z + fbm(x / size + 3, y / size, z / size, 2) * size * .1;
      let d = Infinity;
      for (const course of courses) {
        const px = wx - course.x, py = y - course.y, pz = wz - course.z;
        let piece = sdRoundBox(px, py, pz, course.hx * 1.15, course.hy, course.hz * 1.2, course.hy * .25);
        piece = cut(piece, px, 0, pz, course.outline, size * .015);
        d = d === Infinity ? piece : smin(d, piece, height * .03);
      }
      return d + fbm(x / size * 3, y / size * 3, z / size * 3) * size * .02;
    },
  };
}

/** Tower of rock (karst tower, hoodoo, sea stack): faceted, weathered, with
 * irregular bedding notches and a broken crown. `flutes` adds vertical rain
 * grooves (limestone). */
function spire({ height = 20, radius = 4, seed = 1, flutes = .5 }) {
  const { random, n3, fbm, planes, cut, bedding } = kit(seed);
  const taper = lerp(.2, .5, random()), lean = [(random() - .5) * .1, (random() - .5) * .1];
  const faces = planes(6 + Math.floor(random() * 4), radius, [.55, .85], 1).map(p => ({ ...p, ny: 0 }));
  const spacing = Math.max(1.2, height / lerp(4, 7, random()));
  const crown = height * lerp(.88, 1, random());
  return {
    kind: 'spire', bounds: [-radius * 1.7, -radius * .8, -radius * 1.7, radius * 1.7, height * 1.1, radius * 1.7], lipschitz: 1.8, voxel: Math.max(radius / 12, height / 110),
    distance(x, y, z) {
      const t = clamp(y / height);
      const px = x - lean[0] * y, pz = z - lean[1] * y;
      const wx = px + fbm(px / radius * .45, y / radius * .18, pz / radius * .45, 2) * radius * .7;
      const wz = pz + fbm(px / radius * .45 + 17, y / radius * .18, pz / radius * .45 - 9, 2) * radius * .7;
      const r = radius * (1 - taper * Math.pow(t, 1.3)) * (1 + .25 * clamp((.15 - t) / .15));
      let d = Math.hypot(wx, wz) - r;
      const along = r / radius;
      d = cut(d, wx / along, 0, wz / along, faces, radius * .05) * along;
      if (flutes > 0) {
        const angle = Math.atan2(wz, wx), ridge = Math.cos(angle * 11 + n3(wx / radius, y / (radius * 3), wz / radius) * 3);
        d += Math.pow(Math.max(0, ridge), 6) * radius * .06 * flutes;
      }
      d += bedding(x, y, z, spacing, radius * .12);
      const top = crown + fbm(x / radius * .6, 0, z / radius * .6, 3) * radius * 1.2;
      d = smax(d, y - top, radius * .15);
      return d + fbm(x / radius * 2, y / radius * 2, z / radius * 2, 3) * radius * .05;
    },
  };
}

/** Columnar basalt: tight Voronoi prisms whose heights follow a smooth,
 * stepped field inside an elliptic footprint (the sheer walls of the Elden
 * Ring reference are these at 3-5 m per column). */
function columns({ width = 10, depth = 6, height = 14, seed = 1, column = 0 }) {
  const { random, n3, fbm } = kit(seed);
  const size = column || Math.max(1, Math.min(width, depth) / 4.5, height / 11);
  const cells = createWorley2(seed + 77, .55);
  const work = {};
  const lean = [(random() - .5) * .1, (random() - .5) * .06];
  const stepHeight = size * lerp(.5, .9, random());
  return {
    kind: 'columns', bounds: [-width * .62, -height * .2, -depth * .68, width * .62, height * 1.2, depth * .68], // size/9 floored columns at ~36 k triangles per variant (4.6 M on a shattered
    // terrain); size/6 still resolves each prism's faces and joints.
    lipschitz: 1.3, voxel: Math.max(size / 6, Math.max(width, depth, height) / 90),
    distance(x, y, z) {
      const px = x - lean[0] * y, pz = z - lean[1] * y;
      const c = cells(px / size, pz / size, work);
      const inside = (c.f2 - c.f1) * .5 * size;
      const cx = c.px * size, cz = c.pz * size;
      // Height follows a smooth field over the footprint (tallest toward the
      // back and the middle), quantized to steps, with a little jitter.
      const u = cx / (width * .5), v = cz / (depth * .5);
      const field = height * (.62 + .38 * (1 - u * u)) * (.8 - .25 * v) / .8 + n3(cx / (width * .35), 1.3, cz / (depth * .5)) * height * .22;
      const h = Math.floor(field / stepHeight) * stepHeight + (hash2(c.cx, c.cz, seed) - .5) * stepHeight * .35;
      const tilt = (hash2(c.cx, c.cz, seed + 5) - .5) * .25;
      const side = size * .02 - inside;
      let d = smax(side, y - h - (px - cx) * tilt, size * .025);
      const foot = Math.hypot(px / (width * .5), pz / (depth * .5)) - 1;
      d = smax(d, foot * Math.min(width, depth) * .5, size * .15);
      return d + fbm(x / size * .6, y / size * .25, z / size * .6, 2) * size * .04;
    },
  };
}

/**
 * A jointed rock mass: blocks, each a rounded box cut by its own fracture
 * planes (the method that made the boulder read as stone), fused with a small
 * smooth-min. Shared by the wall and the arch, whose first versions were a
 * warped slab and a torus and read as melted wax and a rope.
 */
function blockMass(blocks, k) {
  // ⛔ Axis-aligned boxes read as crates (round-6 receipt). Each block also
  // pitches and rolls a little, and a slightly larger ellipsoid chops its
  // corners, so a block is a weathered joint block rather than a cuboid.
  const prepared = blocks.map(b => {
    const h = Math.sin(b.x * 12.9898 + b.y * 78.233 + b.z * 37.719) * 43758.5453;
    const r1 = h - Math.floor(h), r2 = (h * 7.13) - Math.floor(h * 7.13);
    const pitch = b.pitch ?? (r1 - .5) * .22, roll = b.roll ?? (r2 - .5) * .22;
    return { ...b, cy: Math.cos(b.yaw), sy: Math.sin(b.yaw), cp: Math.cos(pitch), sp: Math.sin(pitch), cr: Math.cos(roll), sr: Math.sin(roll) };
  });
  return (x, y, z) => {
    let d = Infinity;
    for (const b of prepared) {
      const px = x - b.x, py = y - b.y, pz = z - b.z;
      const yx = b.cy * px - b.sy * pz, yz = b.sy * px + b.cy * pz;
      const ly0 = b.cp * py - b.sp * yz, lz = b.sp * py + b.cp * yz;
      const lx = b.cr * yx - b.sr * ly0, ly = b.sr * yx + b.cr * ly0;
      const m = Math.min(b.hx, b.hy, b.hz);
      let piece = sdRoundBox(lx, ly, lz, b.hx, b.hy, b.hz, m * .16);
      piece = smax(piece, sdEllipsoid(lx, ly, lz, b.hx * 1.32, b.hy * 1.32, b.hz * 1.32), m * .2);
      // ⛔ Planes in block-NORMALIZED space: one metre offset for every axis cut
      // a 12 m block's top down to 3 m (the squat round-3 wall). Normalized, a
      // plane with offset ~.8 chips the same corner share whatever the aspect.
      const nx = lx / b.hx, ny = ly / b.hy, nz = lz / b.hz;
      for (const p of b.planes) piece = smax(piece, (nx * p.nx + ny * p.ny + nz * p.nz - p.offset) * m, b.k);
      d = d === Infinity ? piece : smin(d, piece, k);
    }
    return d;
  };
}

/** Natural arch: a jointed rock mass with a tunnel eroded through it. */
function arch({ span = 16, height = 10, thickness = 3.5, seed = 1 }) {
  const { random, fbm, planes, bedding } = kit(seed);
  const R = span / 2, depth = thickness * lerp(1.2, 1.7, random());
  const outerW = R + thickness * 1.4, outerH = height + thickness * lerp(.9, 1.3, random());
  const blocks = [];
  // Two pillars and a lintel course, each broken into a few blocks.
  for (const side of [-1, 1]) for (let i = 0; i < 2; i++) {
    const hy = outerH * lerp(.3, .38, random());
    blocks.push({ x: side * (R + thickness * .3) + (random() - .5) * thickness * .4, y: hy * (i * 1.55 + .9) - thickness * .4, z: (random() - .5) * depth * .2,
      hx: thickness * lerp(.85, 1.1, random()), hy, hz: depth * .5, yaw: (random() - .5) * .25, k: thickness * .03,
      planes: planes(5, thickness, [.7, 1], .8) });
  }
  for (let i = 0; i < 3; i++) {
    const hx = outerW * lerp(.38, .5, random());
    blocks.push({ x: (i - 1) * outerW * .55 + (random() - .5) * thickness, y: outerH - thickness * lerp(.5, .8, random()), z: (random() - .5) * depth * .25,
      hx, hy: thickness * lerp(.6, .85, random()), hz: depth * .5 * lerp(.85, 1, random()), yaw: (random() - .5) * .2, k: thickness * .03,
      planes: planes(5, hx, [.75, 1], .6) });
  }
  const mass = blockMass(blocks, thickness * .35);
  return {
    kind: 'arch', bounds: [-outerW - thickness * 1.5, -thickness, -depth * 1.3, outerW + thickness * 1.5, outerH + thickness * 1.5, depth * 1.3], lipschitz: 1.8, voxel: Math.max(span, height) / 90,
    distance(x, y, z) {
      const wy = y + fbm(x / thickness * .3, y / thickness * .3, z / thickness * .3, 2) * thickness * .35;
      let d = mass(x, y, z);
      // The opening: an eroded, slightly irregular ellipse through the mass.
      const tunnel = Math.hypot(x / R, Math.max(0, wy) / height) - 1 + fbm(x / thickness * .5, y / thickness * .5, 0, 2) * .08;
      d = smax(d, -tunnel * Math.min(R, height) * .8, thickness * .25);
      d += bedding(x, y, z, thickness * .8, thickness * .05);
      return d + fbm(x / thickness * 1.4, y / thickness * 1.4, z / thickness * 1.4, 3) * thickness * .05;
    },
  };
}

/** Cliff wall segment (local +z faces outward/downhill): a row of jointed
 * blocks of varying height and depth — buttresses and recesses — with faint
 * irregular bedding and an eroded top. */
function wall({ length = 16, height = 12, thickness = 5, seed = 1, columnar = false }) {
  if (columnar) return { ...columns({ width: length, depth: thickness, height, seed }), kind: 'wall' };
  const { random, fbm, planes, bedding } = kit(seed);
  const blocks = [];
  let x = -length * .5;
  while (x < length * .5) {
    const w = Math.min(length * .5 - x, thickness * lerp(.9, 1.9, random())) || thickness;
    const tall = height * lerp(.55, 1, random()) * (1 - .5 * Math.pow(Math.abs(x + w / 2) / (length * .5), 3));
    // Some blocks stand proud (buttresses), some recede (recesses).
    const z = (random() - .5) * thickness * .7;
    const courses = tall > thickness * 2.2 ? 2 : 1;
    for (let c = 0; c < courses; c++) {
      const hy = tall / courses * .5;
      blocks.push({ x: x + w / 2 + (random() - .5) * w * .15, y: hy * (1 + c * 2) - thickness * .3, z: z + (random() - .5) * thickness * .2 * c,
        hx: w * .55, hy: hy * 1.04, hz: thickness * .5 * lerp(.75, 1.1, random()), yaw: (random() - .5) * .3, k: thickness * .025,
        planes: planes(6, Math.min(w * .55, hy, thickness * .5) * 1.4, [.7, 1.05], .7) });
    }
    x += w * lerp(.7, .95, random());
  }
  const mass = blockMass(blocks, thickness * .18);
  const spacing = Math.max(1, height / lerp(4, 7, random()));
  return {
    kind: 'wall', bounds: [-length * .62 - thickness, -height * .25, -thickness * 1.1, length * .62 + thickness, height * 1.15, thickness * 1.1], lipschitz: 1.8, voxel: Math.max(length, height) / 100,
    distance(x, y, z) {
      let d = mass(x, y, z);
      d += bedding(x, y, z, spacing, thickness * .05);
      return d + fbm(x / thickness * .6, y / thickness * .6, z / thickness * .6, 3) * thickness * .07;
    },
  };
}

const BUILDERS = { boulder, slab, ledge, spire, columns, arch, wall };

/** Build a rock field of `kind` with its own parameters (see each builder). */
export function createRockSdf(kind, params = {}) {
  const builder = BUILDERS[kind];
  if (!builder) throw new RangeError(`Unknown rock kind ${kind}`);
  return builder(params);
}
