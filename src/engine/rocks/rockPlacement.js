/**
 * Where stone goes, per chunk. Reads a landscape (`landscapeGenerator.js`) and
 * returns placements that instance the rock library (`rockLibrary.js`).
 *
 * CHUNK CONTRACT: every candidate comes from a world-aligned lattice whose
 * jittered anchor lies in exactly one half-open chunk rectangle
 * [x0, x0 + size) x [z0, z0 + size), and every decision is a hash of that
 * lattice cell. A chunk therefore places exactly the rocks the whole world
 * would place in it, never needs its neighbours, and never duplicates a rock
 * across a border (a rock may still OVERHANG into the next chunk).
 *
 * A placement is `{ kind, variant, position, yaw, size | scale, radius }`:
 * `position` is where the variant's ground contact (local y = 0) lands;
 * `size` gives target metres (local x, height above the contact, local z) and
 * is fitted to the variant's MEASURED extent by `instanceScale`; `scale` is a
 * plain factor on the canonical variant.
 *
 * Structures follow the land's own geology rather than a scatter:
 *   wall     along tier risers, plate fractures and gorge walls, back face on
 *            the top edge, crown just under the bench; columnar where the
 *            style says so (the reference's basalt cliffs)
 *   spire    wrapping every heightfield tower, plus lone hoodoos near cliffs
 *   arch     rare, on benches beside a cliff, spanning along the contour
 *   ledge    outcrop shelves on steep grass, strike along the contour
 *   slab     tilted plates on moderate slopes
 *   boulder  talus below cliffs (dense, big) and sparse field stones
 */

import { hash2 } from '../terrain/terrainNoise.js';
import { ROCK_CANON } from './rockLibrary.js';

const clamp = (v, lo = 0, hi = 1) => v < lo ? lo : v > hi ? hi : v;
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (lo, hi, v) => { const t = clamp((v - lo) / (hi - lo)); return t * t * (3 - 2 * t); };

const CHANNEL = { wall: 11, spire: 13, arch: 17, ledge: 19, slab: 23, boulder: 29 };
// Snap offsets for wall anchors: a riser is ~4 m wide, a lattice cell 7 m.
const SNAP = [[0, 0], [-2, 0], [2, 0], [0, -2], [0, 2], [-2, -2], [2, 2], [-2, 2], [2, -2]];

/**
 * @param {any} landscape  a landscapeGenerator landscape
 * @param {{ x0: number, z0: number, size: number, seed?: number, variants?: Record<string, number>, density?: number,
 *   groundAt?: ((x: number, z: number) => number) | null, accept?: ((x: number, z: number, radius: number) => boolean) | null }} options
 *   the half-open chunk rectangle [x0, x0 + size) x [z0, z0 + size) in landscape metres
 */
export function placeRocks(landscape, { x0, z0, size, seed = landscape.options.seed, variants = {}, density = landscape.options.rocks, groundAt = null, accept = null }) {
  const mix = landscape.rockMix ?? {};
  const amount = clamp(density * 2, 0, 2);
  const out = [];
  if (amount <= 0) return out;
  const point = {};
  const sample = (x, z) => landscape.sample(x, z, point);
  const heightAt = (x, z) => landscape.sample(x, z, point).height;
  const gradient = (x, z, e = 1.5) => [(heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e), (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e)];
  const x1 = x0 + size, z1 = z0 + size;
  const variantOf = (kind, h) => Math.floor(h * Math.max(1, variants[kind] ?? 4));
  const lowestUnder = (x, z, radius) => {
    // An owner's composed ground (World banks/roads/pads, a sculpted terrain)
    // wins over the raw landscape, so a rock is seated where it is drawn.
    const ground = groundAt ?? heightAt;
    let low = ground(x, z);
    for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; low = Math.min(low, ground(x + Math.cos(a) * radius, z + Math.sin(a) * radius)); }
    return low;
  };

  /** Visit every lattice anchor of `spacing` whose jittered point is in this chunk. */
  const lattice = (spacing, channel, visit) => {
    const i0 = Math.floor(x0 / spacing) - 1, i1 = Math.floor(x1 / spacing) + 1;
    const j0 = Math.floor(z0 / spacing) - 1, j1 = Math.floor(z1 / spacing) + 1;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const ax = (i + .15 + .7 * hash2(i, j, seed + channel)) * spacing;
      const az = (j + .15 + .7 * hash2(i, j, seed + channel * 7)) * spacing;
      if (ax < x0 || ax >= x1 || az < z0 || az >= z1) continue;
      visit(ax, az, (k) => hash2(i, j, seed + channel * 131 + k * 977));
    }
  };

  // ---- cliff walls ----
  // ⛔ A 7 m lattice under 10-16 m segments stacked every face ~2x deep: 938
  // walls and 2.9 M triangles on one canyon terrain. 12 m keeps a riser covered
  // end to end with a little overlap at the joints.
  if (mix.cliffs > 0 || mix.columns > 0) lattice(12, CHANNEL.wall, (ax, az, rand) => {
    const columnar = rand(1) < clamp(mix.columns ?? 0);
    // ⛔ Columns at wall density turned shattered into a city of organ pipes
    // (4834 of them in the round-6 receipt); they are the accent, not the rule.
    if (rand(0) > clamp((columnar ? .4 : .85) * Math.max(mix.cliffs ?? 0, mix.columns ?? 0) * amount)) return;
    let best = 0, x = ax, z = az;
    for (const [ox, oz] of SNAP) { const c = sample(ax + ox, az + oz).cliff; if (c > best) { best = c; x = ax + ox; z = az + oz; } }
    if (best < .25) return;
    // Towers are wrapped by their own spire; a wall glued to a flank is a blob.
    if (sample(x, z).tower > .02) return;
    const [gx, gz] = gradient(x, z);
    const slope = Math.hypot(gx, gz);
    if (slope < .6) return;
    const dx = -gx / slope, dz = -gz / slope;   // downhill
    // Walk up and down the face until the ground eases: that is the drop.
    let ux = x, uz = z, fx = x, fz = z;
    for (let k = 0; k < 30; k++) { const [sx, sz] = gradient(ux, uz); if (Math.hypot(sx, sz) < .35) break; ux -= dx * 1.5; uz -= dz * 1.5; }
    for (let k = 0; k < 30; k++) { const [sx, sz] = gradient(fx, fz); if (Math.hypot(sx, sz) < .35) break; fx += dx * 1.5; fz += dz * 1.5; }
    const top = heightAt(ux, uz), foot = heightAt(fx, fz), drop = top - foot;
    if (drop < 3) return;
    const run = Math.hypot(ux - fx, uz - fz);
    const thickness = clamp(run + 2, 3, 10);
    // A tall face gets a proportionally long segment, never a stretched pipe.
    const length = Math.max(lerp(10, 16, rand(2)), drop * (columnar ? .55 : .45));
    // ⛔ Centred mid-riser and sized drop + 1.2 m, blocks stood proud of the
    // bench above like crates (round-6 receipt). The back face now sits on the
    // top edge and the crown just under the bench, so the grass edge overhangs.
    const base = foot - 1.2;
    out.push({
      kind: columnar ? 'columns' : 'wall', variant: variantOf(columnar ? 'columns' : 'wall', rand(3)),
      position: [ux + dx * thickness * .5, base, uz + dz * thickness * .5], yaw: Math.atan2(dx, dz),
      size: [length, top - .5 - base, thickness], radius: length * .55, drop,
    });
  });

  // ---- towers: wrap every heightfield pillar, and lone spires near cliffs ----
  if (landscape.towers) for (const tower of landscape.towers(x0, z0, x1, z1)) {
    const ground = lowestUnder(tower.x, tower.z, tower.radius * 1.15);
    const width = tower.radius * 2.04;
    out.push({ kind: 'spire', variant: variantOf('spire', hash2(Math.round(tower.x), Math.round(tower.z), seed + 5)),
      position: [tower.x, ground - 1, tower.z], yaw: hash2(Math.round(tower.z), Math.round(tower.x), seed) * Math.PI * 2,
      size: [width, tower.peak - ground + 1 + tower.radius * .1, width], radius: tower.radius, wraps: true });
  }
  if (mix.spires > 0) lattice(64, CHANNEL.spire, (x, z, rand) => {
    if (rand(0) > clamp(mix.spires * amount * .45)) return;
    const p = sample(x, z);
    if (p.tower > 0) return;
    const [gx, gz] = gradient(x, z);
    if (Math.hypot(gx, gz) > .4) return;
    let near = 0;
    for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI * 2; near = Math.max(near, sample(x + Math.cos(a) * 22, z + Math.sin(a) * 22).cliff); }
    if (near < .2) return;
    const radius = lerp(2.2, 5.5, rand(1)), height = radius * lerp(3, 7, rand(2));
    out.push({ kind: 'spire', variant: variantOf('spire', rand(3)), position: [x, lowestUnder(x, z, radius) - .6, z], yaw: rand(4) * Math.PI * 2,
      size: [radius * 2, height, radius * 2], radius });
  });

  // ---- arches ----
  if (mix.arches > 0) lattice(150, CHANNEL.arch, (x, z, rand) => {
    if (rand(0) > clamp(mix.arches * amount * .6)) return;
    const [gx, gz] = gradient(x, z, 3);
    const slope = Math.hypot(gx, gz);
    if (slope > .35) return;
    let near = 0;
    for (let k = 0; k < 8; k++) { const a = k / 8 * Math.PI * 2; near = Math.max(near, sample(x + Math.cos(a) * 18, z + Math.sin(a) * 18).cliff); }
    if (near < .15 && mix.arches < .3) return;
    const span = lerp(12, 24, rand(1));
    const s = span / ROCK_CANON.arch.span;
    // Along the contour: the opening faces downhill.
    const yaw = slope > .02 ? Math.atan2(-gx, -gz) + Math.PI / 2 : rand(2) * Math.PI * 2;
    out.push({ kind: 'arch', variant: variantOf('arch', rand(3)), position: [x, lowestUnder(x, z, span * .6) - 1, z], yaw,
      scale: [s, s * lerp(.8, 1.2, rand(4)), s], radius: span * .7 });
  });

  // ---- ledges and slabs on steep grass ----
  if (mix.slabs > 0) {
    lattice(17, CHANNEL.ledge, (x, z, rand) => {
      const [gx, gz] = gradient(x, z);
      const slope = Math.hypot(gx, gz);
      const p = sample(x, z);
      if (p.cliff > .25 || p.tower > 0 || rand(0) > clamp(mix.slabs * amount * .55 * smoothstep(.4, .85, slope) * (1 - smoothstep(1.4, 2, slope)))) return;
      const sizeM = lerp(6, 12, rand(1)), heightM = lerp(2.2, 4.5, rand(2));
      out.push({ kind: 'ledge', variant: variantOf('ledge', rand(3)), position: [x, lowestUnder(x, z, sizeM * .4) - heightM * .25, z],
        yaw: Math.atan2(-gx, -gz), scale: [sizeM / ROCK_CANON.ledge.size, heightM / ROCK_CANON.ledge.height, sizeM / ROCK_CANON.ledge.size], radius: sizeM * .6 });
    });
    lattice(11, CHANNEL.slab, (x, z, rand) => {
      const [gx, gz] = gradient(x, z);
      const slope = Math.hypot(gx, gz);
      if (slope < .18 || slope > .9 || rand(0) > clamp(mix.slabs * amount * .22)) return;
      const s = lerp(2.5, 6, rand(1)) / ROCK_CANON.slab.size;
      out.push({ kind: 'slab', variant: variantOf('slab', rand(2)), position: [x, lowestUnder(x, z, s * 2.5) - .2, z], yaw: Math.atan2(-gx, -gz) + (rand(3) - .5) * .6,
        scale: [s, s, s], radius: s * 3 });
    });
  }

  // ---- boulders: talus below cliffs, sparse field stones elsewhere ----
  if (mix.boulders > 0) lattice(5, CHANNEL.boulder, (x, z, rand) => {
    const [gx, gz] = gradient(x, z);
    const slope = Math.hypot(gx, gz);
    if (slope > 1.1) return;
    // Talus: a cliff within ~12 m uphill.
    const ux = slope > .02 ? -gx / slope : 0, uz = slope > .02 ? -gz / slope : 0;
    let above = 0;
    for (const d of [4, 8, 12]) { const q = sample(x - ux * d, z - uz * d); above = Math.max(above, q.cliff, q.tower * .8); }
    const talus = smoothstep(.15, .5, above);
    const chance = talus * .75 + (1 - talus) * .035;
    if (rand(0) > clamp(mix.boulders * amount * .5 * chance)) return;
    const sizeM = lerp(.7, 2.2, Math.pow(rand(1), 1.6)) * (1 + talus * 1.2);
    const s = sizeM / ROCK_CANON.boulder.size;
    out.push({ kind: 'boulder', variant: variantOf('boulder', rand(2)), position: [x, lowestUnder(x, z, sizeM * .45) - sizeM * .12, z], yaw: rand(3) * Math.PI * 2,
      scale: [s * lerp(.85, 1.15, rand(4)), s * lerp(.8, 1.2, rand(5)), s * lerp(.85, 1.15, rand(6))], radius: sizeM * .6 });
  });
  return accept ? out.filter(placement => accept(placement.position[0], placement.position[2], placement.radius ?? 1)) : out;
}

/** Variant counts the placement above can reference, for `buildRockLibrarySteps`. */
export function rockKindsFor(landscape, variants = 4) {
  const mix = landscape.rockMix ?? {};
  return {
    boulder: mix.boulders > 0 ? variants : 0,
    slab: mix.slabs > 0 ? Math.max(2, variants - 1) : 0,
    ledge: mix.slabs > 0 ? Math.max(2, variants - 1) : 0,
    wall: mix.cliffs > 0 ? variants : 0,
    // Only styles that place columns: building them for every cliff style cost
    // ~1 s of meshing (36 k-triangle variants) that highlands never drew.
    columns: mix.columns > 0 ? Math.max(2, variants - 1) : 0,
    spire: mix.spires > 0 || landscape.style.towers ? variants : 0,
    arch: mix.arches > 0 ? 2 : 0,
  };
}
