/** Geometry kit shared by every architecture style generator. Pure math on plain arrays (no
 * renderer, no THREE objects), so it runs in Node tests, the editor and a worker alike.
 *
 * Every primitive writes flat-shaded (or explicitly smooth) triangles into a bucket keyed by
 * (material, formId, surface). A vertex carries: position, normal, a metre-scaled planar UV
 * (divided by its surface kind's tile size), the texture-array layer of that kind, and a tint
 * `[r, g, b, detail]` = linear palette colour × per-piece shade × ambient-occlusion factor, with
 * `detail` (0..1) scaling how strongly the kind's texture reads. The per-piece shade is what
 * makes a roof of identical tiles or a plinth of identical stones read as hand-made. */

export const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  addScaled: (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: a => Math.hypot(a[0], a[1], a[2]),
  norm: a => { const l = Math.hypot(a[0], a[1], a[2]); return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 1, 0]; },
  lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
  avg: points => { const s = [0, 0, 0]; for (const p of points) { s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; } const n = points.length || 1; return [s[0] / n, s[1] / n, s[2] / n]; },
};

/** A rigid local frame: world = o + t·x + u·y + n·z. */
export function frame(o, t, u, n) { return { o: [...o], t: v3.norm(t), u: v3.norm(u), n: v3.norm(n) }; }
export function toWorld(f, x, y, z) {
  return [f.o[0] + f.t[0] * x + f.u[0] * y + f.n[0] * z, f.o[1] + f.t[1] * x + f.u[1] * y + f.n[1] * z, f.o[2] + f.t[2] * x + f.u[2] * y + f.n[2] * z];
}
export function dirWorld(f, x, y, z) { return [f.t[0] * x + f.u[0] * y + f.n[0] * z, f.t[1] * x + f.u[1] * y + f.n[1] * z, f.t[2] * x + f.u[2] * y + f.n[2] * z]; }
/** Frame whose t runs from a to b, with u as close to `upHint` as possible. */
export function segmentFrame(a, b, upHint = [0, 1, 0]) {
  const t = v3.norm(v3.sub(b, a));
  let u = v3.sub(upHint, v3.mul(t, v3.dot(upHint, t)));
  if (v3.len(u) < 1e-6) u = Math.abs(t[1]) < .9 ? [0, 1, 0] : [1, 0, 0], u = v3.sub(u, v3.mul(t, v3.dot(u, t)));
  u = v3.norm(u);
  return { o: [...a], t, u, n: v3.cross(t, u), length: v3.len(v3.sub(b, a)) };
}

const linearCache = new Map();
export function linearColor(hex) {
  let c = linearCache.get(hex);
  if (!c) {
    const h = String(hex).replace("#", ""), full = h.length === 3 ? h.split("").map(x => x + x).join("") : h.padEnd(6, "0");
    const n = parseInt(full, 16), toLinear = v => (v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
    c = [toLinear(((n >> 16) & 255) / 255), toLinear(((n >> 8) & 255) / 255), toLinear((n & 255) / 255)];
    linearCache.set(hex, c);
  }
  return c;
}

export class KitMesh {
  /** `layerOf(kind)` -> texture array layer; `repeatOf(kind)` -> [u, v] metres per tile. */
  constructor({ layerOf = () => 0, repeatOf = () => [1, 1] } = {}) {
    this.layerOf = layerOf; this.repeatOf = repeatOf;
    this.buckets = new Map();
    this.state = { material: "surface", kind: "plaster", color: [1, 1, 1], shade: 1, detail: 1, formId: null, surface: "detail" };
    this.ao = null;
    this.triangles = 0;
    this._bucket = null;
  }
  /** Sets the current material/kind/colour. Unspecified keys keep their value. */
  set({ material, kind, color, shade, detail, formId, surface } = {}) {
    const s = this.state;
    if (material !== undefined) s.material = material;
    if (kind !== undefined) s.kind = kind;
    if (color !== undefined) s.color = typeof color === "string" ? linearColor(color) : color;
    if (shade !== undefined) s.shade = shade;
    if (detail !== undefined) s.detail = detail;
    if (formId !== undefined) s.formId = formId;
    if (surface !== undefined) s.surface = surface;
    this._bucket = null;
    return this;
  }
  paint(kind, color, shade = 1, material = "surface") { return this.set({ kind, color, shade, material }); }
  bucket() {
    if (this._bucket) return this._bucket;
    const s = this.state, key = `${s.material}|${s.formId}|${s.surface}`;
    let b = this.buckets.get(key);
    if (!b) this.buckets.set(key, b = { material: s.material, formId: s.formId, surface: s.surface, position: [], normal: [], uv: [], layer: [], tint: [] });
    return (this._bucket = b);
  }
  _vertex(b, p, n, tangent, vertical, repeat, layer, tint) {
    b.position.push(p[0], p[1], p[2]); b.normal.push(n[0], n[1], n[2]);
    b.uv.push((p[0] * tangent[0] + p[2] * tangent[2]) / repeat[0], (p[0] * vertical[0] + p[1] * vertical[1] + p[2] * vertical[2]) / repeat[1]);
    b.layer.push(layer);
    const ao = this.ao ? this.ao(p) : 1;
    b.tint.push(tint[0] * ao, tint[1] * ao, tint[2] * ao, tint[3]);
  }
  /** Convex planar polygon, flat-shaded. `hint` is any vector on the outward side; the winding
   * is flipped to face it. Degenerate polygons are skipped. */
  poly(points, hint = null, normalOverride = null) {
    if (points.length < 3) return;
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const area = Math.hypot(nx, ny, nz);
    if (area < 1e-10) return;
    let n = [nx / area, ny / area, nz / area];
    let pts = points;
    if (hint && v3.dot(n, hint) < 0) { n = [-n[0], -n[1], -n[2]]; pts = [...points].reverse(); }
    const shadeN = normalOverride ?? n;
    const b = this.bucket(), s = this.state, repeat = this.repeatOf(s.kind), layer = this.layerOf(s.kind);
    const tangent = Math.abs(n[1]) > .9 ? [1, 0, 0] : v3.norm([n[2], 0, -n[0]]), vertical = v3.norm(v3.cross(n, tangent));
    const tint = [s.color[0] * s.shade, s.color[1] * s.shade, s.color[2] * s.shade, s.detail];
    for (let i = 1; i < pts.length - 1; i++) {
      this._vertex(b, pts[0], shadeN, tangent, vertical, repeat, layer, tint);
      this._vertex(b, pts[i], shadeN, tangent, vertical, repeat, layer, tint);
      this._vertex(b, pts[i + 1], shadeN, tangent, vertical, repeat, layer, tint);
      this.triangles++;
    }
  }
  /** One triangle with per-vertex normals (smooth curved surfaces); winding follows n0. */
  tri(p0, p1, p2, n0, n1, n2) {
    const face = v3.cross(v3.sub(p1, p0), v3.sub(p2, p0));
    if (v3.len(face) < 1e-12) return;
    if (v3.dot(face, v3.add(v3.add(n0, n1), n2)) < 0) { [p1, p2] = [p2, p1]; [n1, n2] = [n2, n1]; }
    const b = this.bucket(), s = this.state, repeat = this.repeatOf(s.kind), layer = this.layerOf(s.kind);
    const fn = v3.norm(face), tangent = Math.abs(fn[1]) > .9 ? [1, 0, 0] : v3.norm([fn[2], 0, -fn[0]]), vertical = v3.norm(v3.cross(fn, tangent));
    const tint = [s.color[0] * s.shade, s.color[1] * s.shade, s.color[2] * s.shade, s.detail];
    this._vertex(b, p0, n0, tangent, vertical, repeat, layer, tint);
    this._vertex(b, p1, n1, tangent, vertical, repeat, layer, tint);
    this._vertex(b, p2, n2, tangent, vertical, repeat, layer, tint);
    this.triangles++;
  }
  quadSmooth(a, b, c, d, na, nb, nc, nd) { this.tri(a, b, c, na, nb, nc); this.tri(a, c, d, na, nc, nd); }

  /** Box spanning [x0,x1]×[y0,y1]×[z0,z1] in frame `f`, with an optional chamfer. `skip` names
   * faces to omit ("-x", "+x", "-y", "+y", "-z", "+z") — e.g. the face against a wall. */
  box(f, x0, x1, y0, y1, z0, z1, { bevel = 0, skip = null } = {}) {
    const h = [Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, Math.abs(z1 - z0) / 2];
    if (h[0] < 1e-5 || h[1] < 1e-5 || h[2] < 1e-5) return;
    const c0 = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
    const c = Math.max(0, Math.min(bevel, h[0] * .45, h[1] * .45, h[2] * .45));
    const P = l => toWorld(f, c0[0] + l[0], c0[1] + l[1], c0[2] + l[2]);
    const centre = P([0, 0, 0]);
    const skipped = (axis, sign) => !!skip && !!skip[`${sign < 0 ? "-" : "+"}${"xyz"[axis]}`];
    const emit = locals => { const pts = locals.map(P); this.poly(pts, v3.sub(v3.avg(pts), centre)); };
    for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
      if (skipped(axis, sign)) continue;
      const a = (axis + 1) % 3, b = (axis + 2) % 3;
      emit([[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sa, sb]) => { const l = [0, 0, 0]; l[axis] = sign * h[axis]; l[a] = sa * (h[a] - c); l[b] = sb * (h[b] - c); return l; }));
    }
    if (c <= 0) return;
    for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) {
      const k = 3 - a - b;
      for (const sa of [-1, 1]) for (const sb of [-1, 1]) {
        if (skipped(a, sa) || skipped(b, sb)) continue;
        const pts = [];
        for (const [sk, first] of [[-1, true], [1, true], [1, false], [-1, false]]) {
          const l = [0, 0, 0]; l[k] = sk * (h[k] - c);
          if (first) { l[a] = sa * h[a]; l[b] = sb * (h[b] - c); } else { l[a] = sa * (h[a] - c); l[b] = sb * h[b]; }
          pts.push(l);
        }
        emit(pts);
      }
    }
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      if (skipped(0, sx) || skipped(1, sy) || skipped(2, sz)) continue;
      emit([[sx * h[0], sy * (h[1] - c), sz * (h[2] - c)], [sx * (h[0] - c), sy * h[1], sz * (h[2] - c)], [sx * (h[0] - c), sy * (h[1] - c), sz * h[2]]]);
    }
  }
  /** Beam of `width` (along u) × `depth` (along n) between two world points. */
  beam(a, b, width, depth, upHint = [0, 1, 0], opts = {}) {
    const f = segmentFrame(a, b, upHint);
    this.box(f, 0, f.length, -width / 2, width / 2, -depth / 2, depth / 2, opts);
  }
  /** Convex 2D polygon in the frame's (x, y) plane, extruded from z0 to z1. */
  extrude(f, pts2, z0, z1, { back = true, front = true, sides = true } = {}) {
    if (pts2.length < 3) return;
    const lo = pts2.map(([x, y]) => toWorld(f, x, y, z0)), hi = pts2.map(([x, y]) => toWorld(f, x, y, z1));
    const centre = v3.avg([...lo, ...hi]);
    if (front) this.poly(hi, dirWorld(f, 0, 0, z1 >= z0 ? 1 : -1));
    if (back) this.poly(lo, dirWorld(f, 0, 0, z1 >= z0 ? -1 : 1));
    if (sides) for (let i = 0; i < pts2.length; i++) {
      const j = (i + 1) % pts2.length, quad = [lo[i], lo[j], hi[j], hi[i]];
      this.poly(quad, v3.sub(v3.avg(quad), centre));
    }
  }
  /** Cylinder/frustum along the frame's u axis, centred at local (cx, cz). `arc` limits the
   * sweep (radians, measured from +t toward +n) for half-rounds. Smooth side normals. */
  cylinder(f, cx, cz, radius, y0, y1, segments = 8, { radiusTop = radius, capTop = true, capBottom = true, arc = null } = {}) {
    const a0 = arc ? arc[0] : 0, a1 = arc ? arc[1] : Math.PI * 2, closed = !arc;
    const count = Math.max(3, segments), ring = [];
    for (let i = 0; i <= count; i++) {
      const a = a0 + (a1 - a0) * i / count, c = Math.cos(a), s = Math.sin(a);
      const slope = (radius - radiusTop) / Math.max(1e-6, y1 - y0);
      ring.push({ lo: toWorld(f, cx + c * radius, y0, cz + s * radius), hi: toWorld(f, cx + c * radiusTop, y1, cz + s * radiusTop), n: v3.norm(dirWorld(f, c, slope, s)) });
    }
    for (let i = 0; i < count; i++) {
      const A = ring[i], B = ring[i + 1];
      this.quadSmooth(A.lo, B.lo, B.hi, A.hi, A.n, B.n, B.n, A.n);
    }
    const capPts = (y, r) => ring.slice(0, closed ? count : count + 1).map((_, i) => { const a = a0 + (a1 - a0) * i / count; return toWorld(f, cx + Math.cos(a) * r, y, cz + Math.sin(a) * r); });
    if (capTop && radiusTop > 1e-4) this.poly(capPts(y1, radiusTop), dirWorld(f, 0, 1, 0));
    if (capBottom && radius > 1e-4) this.poly(capPts(y0, radius), dirWorld(f, 0, -1, 0));
    if (!closed) { this.poly([ring[0].lo, ring[0].hi, toWorld(f, cx, y1, cz), toWorld(f, cx, y0, cz)], dirWorld(f, -Math.sin(a0), 0, Math.cos(a0))); this.poly([ring[count].lo, ring[count].hi, toWorld(f, cx, y1, cz), toWorld(f, cx, y0, cz)], dirWorld(f, Math.sin(a1), 0, -Math.cos(a1))); }
  }
  /** Low-poly ellipsoid (foliage blobs, finials). */
  blob(center, radii, segments = 6, rings = 4) {
    const P = (i, j) => { const th = Math.PI * j / rings, ph = Math.PI * 2 * i / segments; const d = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)]; return { p: [center[0] + d[0] * radii[0], center[1] + d[1] * radii[1], center[2] + d[2] * radii[2]], n: v3.norm([d[0] / radii[0], d[1] / radii[1], d[2] / radii[2]]) }; };
    for (let j = 0; j < rings; j++) for (let i = 0; i < segments; i++) {
      const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
      if (j > 0) this.tri(a.p, d.p, b.p, a.n, d.n, b.n);
      if (j < rings - 1) this.tri(b.p, d.p, c.p, b.n, d.n, c.n);
    }
  }
  /** Planar convex polygon slab: top at +thickness along `normal`, optional bottom and sides. */
  slab(points, normal, thickness, { bottom = true, sides = true, topShade = null } = {}) {
    const n = v3.norm(normal), top = points.map(p => v3.addScaled(p, n, thickness));
    const centre = v3.avg([...points, ...top]);
    const shade = this.state.shade;
    if (topShade !== null) this.set({ shade: shade * topShade });
    this.poly(top, n);
    if (topShade !== null) this.set({ shade });
    if (bottom) this.poly(points, v3.mul(n, -1));
    if (sides) for (let i = 0; i < points.length; i++) {
      const j = (i + 1) % points.length, quad = [points[i], points[j], top[j], top[i]];
      this.poly(quad, v3.sub(v3.avg(quad), centre));
    }
  }
}

// ---- 2D helpers -----------------------------------------------------------------------------
export const v2 = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1]],
  cross: (a, b) => a[0] * b[1] - a[1] * b[0],
  area: pts => { let s = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; },
};
/** Sutherland–Hodgman clip of `subject` (any simple polygon) by a CONVEX CCW `clipper`. */
export function clipPolygon2(subject, clipper) {
  let out = subject;
  for (let i = 0; i < clipper.length && out.length; i++) {
    const a = clipper[i], b = clipper[(i + 1) % clipper.length], input = out; out = [];
    const side = p => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    for (let j = 0; j < input.length; j++) {
      const p = input[j], q = input[(j + 1) % input.length], sp = side(p), sq = side(q);
      if (sp >= -1e-9) out.push(p);
      if ((sp >= -1e-9) !== (sq >= -1e-9)) { const t = sp / (sp - sq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
    }
  }
  return out.length >= 3 ? out : [];
}
export function ccw2(pts) { return v2.area(pts) < 0 ? [...pts].reverse() : pts; }
export function pointInConvex2(p, poly, margin = 0) {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], e = [b[0] - a[0], b[1] - a[1]], l = Math.hypot(e[0], e[1]) || 1;
    if ((e[0] * (p[1] - a[1]) - e[1] * (p[0] - a[0])) / l < -margin) return false;
  }
  return true;
}
/** [ymin, ymax] where the vertical line x crosses a convex polygon, or null. */
export function spanAtX(poly, x) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if ((a[0] - x) * (b[0] - x) > 0) continue;
    if (Math.abs(b[0] - a[0]) < 1e-9) { lo = Math.min(lo, a[1], b[1]); hi = Math.max(hi, a[1], b[1]); continue; }
    const t = (x - a[0]) / (b[0] - a[0]), y = a[1] + (b[1] - a[1]) * t;
    lo = Math.min(lo, y); hi = Math.max(hi, y);
  }
  return lo <= hi ? [lo, hi] : null;
}
