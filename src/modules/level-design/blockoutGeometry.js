// @ts-check
import * as THREE from "three/webgpu";

/**
 * The geometry behind every blockout piece.
 *
 * A blockout is not modelling — it is a handful of rectangular volumes placed
 * on a grid — so this file is deliberately not a CSG kernel. Each shape emits
 * axis-aligned boxes (plus two special prisms for ramps and columns) into flat
 * arrays, and the caller turns those into one BufferGeometry. A wall with a
 * door is four boxes around the hole, never a boolean subtraction: no library,
 * no degenerate triangles, and the result still reads as "the pieces a builder
 * would stack".
 *
 * Two conventions the rest of the module depends on:
 *
 *   - **Local X is length, Z is depth, Y is up.** A wall runs along its local
 *     X axis, a stair climbs along +Z. The tool authors direction as the
 *     entity's yaw, so a piece's props stay readable numbers rather than
 *     world-space endpoints that break the moment you move the parent.
 *
 *   - **Slabs hang below their origin; everything else stands on it.** A floor
 *     occupies y ∈ [-thickness, 0] so its walkable SURFACE is the entity's
 *     position — put a floor and a wall at the same storey elevation and the
 *     wall stands on the floor with no arithmetic. Getting this backwards is
 *     what makes a blockout tool need a "snap to surface" button.
 *
 * UVs are emitted in METRES (a 3 m wall spans 3 units of u), which is what
 * makes one shared 1 m grid texture read at the same scale on every piece
 * regardless of its size — the checker in every greybox screenshot.
 */

/** Shapes a Blockout component can take. Order is the tool palette's order. */
export const BLOCKOUT_SHAPES = ["floor", "wall", "stair", "ramp", "box", "column", "platform"];

/**
 * Greybox palette. These are the colours blockouts conventionally use and they
 * are not arbitrary: floors read as ground (green), walls as vertical blockers
 * (yellow), and anything you can climb (stairs/ramps) shares one warm colour,
 * so a level answers "where can I walk" at a glance from across the map.
 */
export const BLOCKOUT_COLORS = {
  floor: "#8fd45a",
  platform: "#6fbf4a",
  wall: "#f5c542",
  stair: "#f08a5d",
  ramp: "#f08a5d",
  box: "#9aa7b8",
  column: "#c8cfd8",
};

/** Default local size (x, y, z) per shape, in metres. */
export const BLOCKOUT_DEFAULT_SIZE = {
  floor: [4, 0.2, 4],
  platform: [2, 0.2, 2],
  wall: [4, 3, 0.2],
  stair: [1.4, 3, 4],
  ramp: [1.6, 1, 4],
  box: [1, 1, 1],
  column: [0.4, 3, 0.4],
};

/** A fresh opening (door/window) on a wall. `offset` is metres from the wall's
 *  centre along its length; `sill` is the height of the hole's bottom edge. */
export function makeOpening(overrides = {}) {
  return { offset: 0, width: 1, height: 2.1, sill: 0, ...overrides };
}

/** Door / window / arch presets — what the Opening tool inserts on a click. */
export const OPENING_PRESETS = {
  door: { width: 1.1, height: 2.1, sill: 0 },
  window: { width: 1.4, height: 1.2, sill: 1 },
  arch: { width: 2.2, height: 2.6, sill: 0 },
};

/* -------------------------------------------------------------------------- */
/* Primitive emitters                                                          */
/* -------------------------------------------------------------------------- */

/** Accumulator the emitters below write into. */
function makeSink() {
  return { position: [], normal: [], uv: [], index: [], boxes: [] };
}

/**
 * One axis-aligned box, centred at (cx, cy, cz).
 *
 * Written out face by face rather than through BoxGeometry + merge: a stair is
 * up to 64 of these and a wall with three windows is a dozen, so a piece would
 * otherwise allocate (and immediately throw away) dozens of BufferGeometries
 * on every prop edit — while the user is dragging a slider.
 *
 * It also pushes the box onto `sink.boxes`, which is what lets a piece describe
 * itself as convex parts for physics instead of only as a hollow trimesh.
 */
function emitBox(sink, cx, cy, cz, sx, sy, sz, record = true) {
  if (!(sx > 1e-5) || !(sy > 1e-5) || !(sz > 1e-5)) return;
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const faces = [
    // [normal, origin corner, u edge, v edge, u length, v length]
    [[0, 0, 1], [-hx, -hy, hz], [1, 0, 0], [0, 1, 0], sx, sy],
    [[0, 0, -1], [hx, -hy, -hz], [-1, 0, 0], [0, 1, 0], sx, sy],
    [[1, 0, 0], [hx, -hy, hz], [0, 0, -1], [0, 1, 0], sz, sy],
    [[-1, 0, 0], [-hx, -hy, -hz], [0, 0, 1], [0, 1, 0], sz, sy],
    [[0, 1, 0], [-hx, hy, hz], [1, 0, 0], [0, 0, -1], sx, sz],
    [[0, -1, 0], [-hx, -hy, -hz], [1, 0, 0], [0, 0, 1], sx, sz],
  ];
  for (const [n, o, u, v, ul, vl] of faces) {
    const base = sink.position.length / 3;
    for (const [su, sv] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      sink.position.push(
        cx + o[0] + u[0] * ul * su + v[0] * vl * sv,
        cy + o[1] + u[1] * ul * su + v[1] * vl * sv,
        cz + o[2] + u[2] * ul * su + v[2] * vl * sv,
      );
      sink.normal.push(n[0], n[1], n[2]);
      sink.uv.push(su * ul, sv * vl);
    }
    sink.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  if (record) sink.boxes.push({ center: [cx, cy, cz], size: [sx, sy, sz] });
}

/**
 * A right-triangular prism: the ramp. Rises from y=0 at -z to y=`sy` at +z,
 * `sx` wide. Emitted directly rather than as a stack of thin boxes so a ramp
 * has a genuinely smooth slope for the character controller to walk up —
 * stepped geometry makes Rapier's slope test flicker between "floor" and
 * "step" as the capsule crosses each seam.
 */
function emitWedge(sink, cx, cy, cz, sx, sy, sz) {
  if (!(sx > 1e-5) || !(sy > 1e-5) || !(sz > 1e-5)) return;
  const hx = sx / 2, hz = sz / 2;
  const x0 = cx - hx, x1 = cx + hx;
  const z0 = cz - hz, z1 = cz + hz;
  const y0 = cy, y1 = cy + sy;
  const slopeLen = Math.hypot(sy, sz);
  // ⚠ WINDING. The corner order below traces each face CLOCKWISE seen from
  // outside, so the indices run backwards (0,2,1 / 0,3,2) to make the triangles
  // counter-clockwise — which is what three.js calls front-facing. Emitting
  // them 0,1,2 leaves the shading normals correct and the geometry inside out:
  // the outward faces are culled, you see the inner surface of the far side,
  // and nothing anywhere reports a problem. That shipped for ramps and columns.
  const quad = (a, b, c, d, n, uvs) => {
    const base = sink.position.length / 3;
    for (const p of [a, b, c, d]) sink.position.push(p[0], p[1], p[2]);
    for (let i = 0; i < 4; i++) sink.normal.push(n[0], n[1], n[2]);
    for (const [u, v] of uvs) sink.uv.push(u, v);
    sink.index.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  const tri = (a, b, c, n, uvs) => {
    const base = sink.position.length / 3;
    for (const p of [a, b, c]) sink.position.push(p[0], p[1], p[2]);
    for (let i = 0; i < 3; i++) sink.normal.push(n[0], n[1], n[2]);
    for (const [u, v] of uvs) sink.uv.push(u, v);
    sink.index.push(base, base + 2, base + 1);
  };
  // Slope, underside, tall end, and the two triangular cheeks.
  const ny = sz / slopeLen, nz = -sy / slopeLen;
  quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z1], [x0, y1, z1], [0, ny, nz],
    [[0, 0], [sx, 0], [sx, slopeLen], [0, slopeLen]]);
  quad([x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0], [0, -1, 0],
    [[0, 0], [sx, 0], [sx, sz], [0, sz]]);
  quad([x0, y1, z1], [x1, y1, z1], [x1, y0, z1], [x0, y0, z1], [0, 0, 1],
    [[0, sy], [sx, sy], [sx, 0], [0, 0]]);
  tri([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [1, 0, 0], [[0, 0], [sz, 0], [sz, sy]]);
  tri([x0, y0, z1], [x0, y0, z0], [x0, y1, z1], [-1, 0, 0], [[0, 0], [sz, 0], [0, sy]]);
  // Physics gets the wedge as its bounding box, flagged: a capsule walking the
  // slope is resolved against the trimesh, and the box is only a stand-in for
  // callers that want convex parts.
  sink.boxes.push({ center: [cx, cy + sy / 2, cz], size: [sx, sy, sz], wedge: true });
}

/** A regular prism (the column): `sides` faces around the Y axis. 4 sides is a
 *  square pillar, 8+ reads as round without paying for a cylinder. */
function emitPrism(sink, cx, cy, cz, radius, height, sides) {
  const n = Math.max(3, Math.min(32, Math.round(sides)));
  if (!(radius > 1e-5) || !(height > 1e-5)) return;
  const ring = [];
  // Rotated a half-step so a 4-sided prism reads as an axis-aligned square
  // pillar rather than a diamond — the shape anyone means by "column".
  const phase = Math.PI / n;
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2;
    ring.push([cx + Math.cos(a) * radius, cz + Math.sin(a) * radius]);
  }
  let u = 0;
  for (let i = 0; i < n; i++) {
    const [ax, az] = ring[i];
    const [bx, bz] = ring[(i + 1) % n];
    const ex = bx - ax, ez = bz - az;
    const len = Math.hypot(ex, ez) || 1;
    const nx = ez / len, nz = -ex / len;
    const base = sink.position.length / 3;
    sink.position.push(ax, cy, az, bx, cy, bz, bx, cy + height, bz, ax, cy + height, az);
    for (let k = 0; k < 4; k++) sink.normal.push(nx, 0, nz);
    sink.uv.push(u, 0, u + len, 0, u + len, height, u, height);
    // Reversed for the same reason as the wedge above: the ring runs clockwise
    // seen from +Y, so 0,1,2 would face inward.
    sink.index.push(base, base + 2, base + 1, base, base + 3, base + 2);
    u += len;
  }
  for (const [y, ny] of [[cy + height, 1], [cy, -1]]) {
    const base = sink.position.length / 3;
    for (const [x, z] of ring) {
      sink.position.push(x, y, z);
      sink.normal.push(0, ny, 0);
      sink.uv.push(x - cx, z - cz);
    }
    for (let i = 1; i < n - 1; i++) {
      // Clockwise ring again: the TOP cap is the one that needs reversing.
      if (ny > 0) sink.index.push(base, base + i + 1, base + i);
      else sink.index.push(base, base + i, base + i + 1);
    }
  }
  sink.boxes.push({ center: [cx, cy + height / 2, cz], size: [radius * 2, height, radius * 2] });
}

/* -------------------------------------------------------------------------- */
/* Shapes                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A wall's solid spans, given its openings.
 *
 * Returns the parts that remain once every hole is cut: the full-height pieces
 * between openings, plus the sill below and the header above each one.
 * Openings are sorted and clipped to the wall, and one that swallows the whole
 * length simply leaves no full-height span — an archway, which is a legitimate
 * thing to author and must not throw.
 *
 * Exported because the editor's Opening tool needs to know where the solid
 * parts are before it inserts another hole.
 */
export function wallSpans(length, height, openings = []) {
  const half = length / 2;
  const holes = (openings ?? [])
    .map((o) => {
      const width = Math.max(0, Number(o?.width) || 0);
      const centre = Number(o?.offset) || 0;
      const sill = Math.max(0, Number(o?.sill) || 0);
      const top = Math.min(height, sill + Math.max(0, Number(o?.height) || 0));
      return { start: centre - width / 2, end: centre + width / 2, sill, top };
    })
    .filter((h) => h.end > -half && h.start < half && h.end > h.start && h.top > h.sill)
    .map((h) => ({ ...h, start: Math.max(h.start, -half), end: Math.min(h.end, half) }))
    .sort((a, b) => a.start - b.start);

  const spans = [];
  let cursor = -half;
  for (const hole of holes) {
    // An opening starting inside the previous one (overlapping doors) only
    // extends the cut — its own sill/header would sit inside solid geometry.
    if (hole.start > cursor) {
      spans.push({ start: cursor, end: hole.start, bottom: 0, top: height });
    }
    if (hole.sill > 0) spans.push({ start: hole.start, end: hole.end, bottom: 0, top: hole.sill });
    if (hole.top < height) spans.push({ start: hole.start, end: hole.end, bottom: hole.top, top: height });
    cursor = Math.max(cursor, hole.end);
  }
  if (cursor < half) spans.push({ start: cursor, end: half, bottom: 0, top: height });
  return spans.filter((s) => s.end - s.start > 1e-4 && s.top - s.bottom > 1e-4);
}

/**
 * Every box of a piece, in local space. The single place that knows what each
 * shape MEANS; `buildBlockoutGeometry` only turns the result into buffers, and
 * physics reads the same list, so a shape can never collide differently from
 * how it looks.
 */
function emitShape(sink, shape, props) {
  const size = props.size ?? BLOCKOUT_DEFAULT_SIZE[shape] ?? [1, 1, 1];
  const sx = Math.max(0.001, Number(size[0]) || 0);
  const sy = Math.max(0.001, Number(size[1]) || 0);
  const sz = Math.max(0.001, Number(size[2]) || 0);

  switch (shape) {
    case "floor":
    case "platform":
      // Hangs below the origin: the top face IS the walkable elevation.
      emitBox(sink, 0, -sy / 2, 0, sx, sy, sz);
      return;

    case "wall": {
      for (const span of wallSpans(sx, sy, props.openings)) {
        emitBox(
          sink,
          (span.start + span.end) / 2,
          (span.bottom + span.top) / 2,
          0,
          span.end - span.start,
          span.top - span.bottom,
          sz,
        );
      }
      return;
    }

    case "stair": {
      const steps = Math.max(1, Math.min(64, Math.round(props.steps ?? defaultSteps(sy))));
      const rise = sy / steps;
      const run = sz / steps;
      for (let i = 0; i < steps; i++) {
        // Solid stairs fill down to the ground (one box per step, from 0 up);
        // open stairs are floating treads one rise thick.
        const bottom = props.open ? i * rise : 0;
        const top = (i + 1) * rise;
        emitBox(sink, 0, (bottom + top) / 2, -sz / 2 + run * (i + 0.5), sx, top - bottom, run);
      }
      return;
    }

    case "ramp":
      emitWedge(sink, 0, 0, 0, sx, sy, sz);
      return;

    case "column":
      emitPrism(sink, 0, 0, 0, Math.max(sx, sz) / 2, sy, props.sides ?? 4);
      return;

    case "box":
    default:
      emitBox(sink, 0, sy / 2, 0, sx, sy, sz);
  }
}

/** Step count for a stair whose `steps` prop is unset: ~18 cm risers, the
 *  height a real staircase uses and the height Rapier's default autostep
 *  clears, so a character walks up an auto-generated stair without tuning. */
export function defaultSteps(rise) {
  return Math.max(1, Math.min(64, Math.round(rise / 0.18)));
}

/**
 * Builds one piece's geometry.
 *
 * Returns the BufferGeometry plus the box list it was built from — the caller
 * keeps the boxes for collision and for the editor's snapping, which is why
 * this is not just a geometry. An empty piece (a wall that is entirely one
 * opening) still returns a valid, empty geometry rather than null: a null here
 * would have to be special-cased by the component, the collider and the
 * preview ghost alike.
 */
export function buildBlockoutGeometry(shape, props = {}) {
  const sink = makeSink();
  emitShape(sink, shape, props);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(sink.position, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(sink.normal, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(sink.uv, 2));
  geometry.setIndex(sink.index);
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return { geometry, boxes: sink.boxes };
}

/** The box list alone — the same numbers the geometry is built from, without
 *  allocating buffers. Used by physics and by tests. */
export function blockoutBoxes(shape, props = {}) {
  const sink = makeSink();
  emitShape(sink, shape, props);
  return sink.boxes;
}

/**
 * The piece's local bounding box, as [min, max]. Cheap enough to call per
 * frame: it reads the size props rather than the emitted geometry, which is
 * what the tool's preview ghost and the snapping code want.
 */
export function blockoutBounds(shape, props = {}) {
  const size = props.size ?? BLOCKOUT_DEFAULT_SIZE[shape] ?? [1, 1, 1];
  const [sx, sy, sz] = size.map((v) => Math.max(0.001, Number(v) || 0));
  const below = shape === "floor" || shape === "platform";
  return [
    [-sx / 2, below ? -sy : 0, -sz / 2],
    [sx / 2, below ? 0 : sy, sz / 2],
  ];
}
