/** Roofs as built things: a thick slab per exposed slope, extended past every free eave and verge
 * by the style's overhang (mitred at hips and corners, never past a clipped junction), then a real
 * covering — individual tiles/slates/shingles clipped to the slope outline, barrel tiles, layered
 * thatch or standing-seam metal — plus ridge and hip caps, bargeboards, chimneys, gable framing,
 * and dedicated cone/dome generators for round forms. */
import { toWorld, v3, clipPolygon2, ccw2, pointInConvex2, spanAtX, v2 } from "./kitMesh.js";

const UP = [0, 1, 0];

export function decorateRoof(ctx) {
  const { form, roof } = ctx;
  if (!roof) return;
  if (form.shape === "round" && roof.kind !== "flat") { roundRoof(ctx); return; }
  if (roof.kind === "flat") { if (ctx.style.roof.flatEdge === "eave") flatEave(ctx); return; }
  pitchedRoof(ctx);
}

// ---- slope planes ------------------------------------------------------------------------------
function samePoint(a, b) { return Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3 && Math.abs(a[2] - b[2]) < 1e-3; }

const faceNormalOf = face => { const n = v3.norm(v3.cross(v3.sub(face[1], face[0]), v3.sub(face[2], face[0]))); return n[1] < 0 ? v3.mul(n, -1) : n; };
/** Point where the offset planes (n·x = n·p + t) meet; null when they are near-parallel. */
function planesMeet(planes) {
  const [a, b, c] = planes.map(pl => pl.n), det = v3.dot(a, v3.cross(b, c));
  if (Math.abs(det) < 1e-6) return null;
  const [da, db, dc] = planes.map(pl => pl.d);
  return v3.mul(v3.add(v3.add(v3.mul(v3.cross(b, c), da), v3.mul(v3.cross(c, a), db)), v3.mul(v3.cross(a, b), dc)), 1 / det);
}

function slopePlane(ctx, slope, sourceFaces, overhang, thick = 0) {
  const N = v3.norm(slope.normal);
  let Y = v3.sub(UP, v3.mul(N, N[1]));
  Y = v3.len(Y) < 1e-6 ? [0, 0, 1] : v3.norm(Y);
  const X = v3.norm(v3.cross(Y, N)), cosP = Math.max(.05, Math.abs(N[1]));
  const source = slope.source ?? slope.polygon, O = source[0];
  const to2 = p => { const d = v3.sub(p, O); return [v3.dot(d, X), v3.dot(d, Y)]; };
  const to3 = (x, y, z = 0) => [O[0] + X[0] * x + Y[0] * y + N[0] * z, O[1] + X[1] * x + Y[1] * y + N[1] * z, O[2] + X[2] * x + Y[2] * y + N[2] * z];
  let src3 = source, src2 = source.map(to2);
  if (v2.area(src2) < 0) { src3 = [...src3].reverse(); src2 = [...src2].reverse(); }
  const sourceEdges = src2.map((a, i) => {
    const j = (i + 1) % src2.length, a3 = src3[i], b3 = src3[j];
    const other = sourceFaces.find(face => face !== source && face.some(p => samePoint(p, a3)) && face.some(p => samePoint(p, b3)));
    return { a, b: src2[j], a3, b3, shared: !!other, otherNormal: other ? faceNormalOf(other) : null, horizontal: Math.abs(a3[1] - b3[1]) < 1e-3 };
  });
  const frag2 = ccw2(slope.polygon.map(to2));
  const onEdge = (p, e) => {
    const dx = e.b[0] - e.a[0], dy = e.b[1] - e.a[1], l = Math.hypot(dx, dy) || 1;
    if (Math.abs(dx * (p[1] - e.a[1]) - dy * (p[0] - e.a[0])) / l > 2e-3) return false;
    const t = ((p[0] - e.a[0]) * dx + (p[1] - e.a[1]) * dy) / (l * l);
    return t > -1e-3 && t < 1 + 1e-3;
  };
  const edges = frag2.map((a, i) => {
    const b = frag2[(i + 1) % frag2.length], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    const out = [dy / l, -dx / l];
    const src = sourceEdges.find(e => onEdge(a, e) && onEdge(b, e));
    let extend = !!src && !src.shared;
    if (extend) {
      const mid = [(a[0] + b[0]) / 2 + out[0] * .15, (a[1] + b[1]) / 2 + out[1] * .15];
      if (ctx.blocked(to3(mid[0], mid[1], -.08), .01)) extend = false;
    }
    const horizontalLen = Math.hypot(out[0], out[1] * cosP);
    return { a, b, out, dir: [dx / l, dy / l], extend, eave: !!src?.horizontal, d: extend ? overhang / Math.max(.25, horizontalLen) : 0 };
  });
  const ext2 = frag2.map((p, i) => {
    const e0 = edges[(i - 1 + edges.length) % edges.length], e1 = edges[i];
    const p0 = [e0.a[0] + e0.out[0] * e0.d, e0.a[1] + e0.out[1] * e0.d], p1 = [e1.a[0] + e1.out[0] * e1.d, e1.a[1] + e1.out[1] * e1.d];
    const den = v2.cross(e0.dir, e1.dir);
    if (Math.abs(den) < 1e-6) return [p[0] + e1.out[0] * e1.d, p[1] + e1.out[1] * e1.d];
    const t = v2.cross(v2.sub(p1, p0), e1.dir) / den;
    const q = [p0[0] + e0.dir[0] * t, p0[1] + e0.dir[1] * t];
    const limit = overhang * 3 + .3;
    const dq = [q[0] - p[0], q[1] - p[1]], dl = Math.hypot(dq[0], dq[1]);
    return dl > limit ? [p[0] + dq[0] / dl * limit, p[1] + dq[1] / dl * limit] : q;
  });
  // Mitred slab top: where this slope meets another slope of the same roof (ridge, hip), its top
  // face runs on to the line where both offset planes meet, so neighbouring slabs close without a
  // notch and a ridge/hip cap sits on the covering instead of floating above a gap.
  const top2 = ext2.map((q, i) => {
    if (!thick) return q;
    const p = frag2[i], p3 = to3(p[0], p[1], 0);
    const shared = sourceEdges.filter(e => e.shared && onEdge(p, e));
    if (!shared.length) return q;
    const planes = [{ n: N, d: v3.dot(N, p3) + thick }, ...shared.slice(0, 2).map(e => ({ n: e.otherNormal, d: v3.dot(e.otherNormal, p3) + thick }))];
    if (planes.length === 2) { const dir = v3.norm(v3.cross(planes[0].n, planes[1].n)); planes.push({ n: dir, d: v3.dot(dir, p3) }); }
    const meet = planesMeet(planes);
    if (!meet) return q;
    const offset = v3.sub(meet, v3.addScaled(p3, N, thick));
    if (v3.len(offset) > thick * 6 + .2) return q;
    return [q[0] + v3.dot(offset, X), q[1] + v3.dot(offset, Y)];
  });
  const ys = top2.map(p => p[1]);
  return { slope, N, X, Y, O, cosP, to2, to3, frag2, ext2, top2, edges, minY: Math.min(...ext2.map(p => p[1])), maxY: Math.max(...ys), minX: Math.min(...top2.map(p => p[0])), maxX: Math.max(...top2.map(p => p[0])) };
}

function pitchedRoof(ctx) {
  const { kit, style, roof, form } = ctx, R = style.roof;
  const sourceFaces = roof.slopes.map(s => s.source ?? s.polygon);
  const uniqueSources = [...new Set(sourceFaces)];
  const thatch = R.cover === "thatch";
  const thick = thatch ? Math.max(.3, R.thickness) : R.thickness;
  const planes = roof.slopes.map(s => slopePlane(ctx, s, uniqueSources, R.overhang, thick));
  const roofArea = planes.reduce((sum, p) => sum + Math.abs(v2.area(p.ext2)), 0);
  const colorRoof = ctx.color("roof");
  for (const P of planes) {
    // Slab: covering-coloured top, timber soffit, fascia sides on the free edges.
    const bottom = P.ext2.map(([x, y]) => P.to3(x, y, 0)), top = P.top2.map(([x, y]) => P.to3(x, y, thick));
    kit.set({ material: "surface", formId: form.id, surface: "roof", kind: R.kind, color: colorRoof, shade: thatch ? 1 : .82, detail: ctx.detail });
    kit.poly(top, P.N);
    kit.set({ surface: "roof-detail", kind: thatch ? "thatch" : "plank", color: thatch ? colorRoof : ctx.color("timber"), shade: thatch ? .6 : .8 });
    kit.poly(bottom, v3.mul(P.N, -1));
    const centre = v3.avg([...bottom, ...top]);
    for (let i = 0; i < P.ext2.length; i++) {
      const j = (i + 1) % P.ext2.length, quad = [bottom[i], bottom[j], top[j], top[i]];
      kit.set({ kind: thatch ? "thatch" : "timber", color: thatch ? colorRoof : ctx.color(style.roof.bargeboard ? "trim" : "timber"), shade: thatch ? .85 : .9 });
      kit.poly(quad, v3.sub(v3.avg(quad), centre));
    }
    kit.set({ surface: "roof-detail" });
    if (ctx.draft) { if (R.bargeboard) bargeboards(ctx, P, thick); continue; }
    if (R.cover === "tiles" || R.cover === "slate" || R.cover === "shingles") tiles(ctx, P, thick, roofArea);
    else if (R.cover === "barrel") barrel(ctx, P, thick);
    else if (R.cover === "metal") seams(ctx, P, thick);
    else if (thatch) thatchLayers(ctx, P, thick);
    if (R.bargeboard) bargeboards(ctx, P, thick);
  }
  caps(ctx, planes, thick);
  gableFraming(ctx);
  chimney(ctx, planes);
}

function tiles(ctx, P, thick, roofArea) {
  const { kit, style, rng } = ctx, R = style.roof, cover = R.cover;
  let [tw, th] = R.tile;
  const budget = 2600;
  if (roofArea / (tw * th) > budget) { const k = Math.sqrt(roofArea / (tw * th) / budget); tw *= k; th *= k; }
  const len = th * 1.42, tileT = cover === "slate" ? .022 : cover === "shingles" ? .028 : ctx.stylized ? .06 : .045;
  const gap = cover === "tiles" ? (ctx.stylized ? .025 : .012) : .008;
  const scallop = ctx.stylized && cover === "tiles";
  const clipper = P.top2;
  const colorRoof = ctx.color("roof");
  kit.set({ kind: R.kind, color: colorRoof, detail: ctx.detail });
  const rows = Math.ceil((P.maxY - P.minY) / th) + 1;
  for (let r = 0; r < rows; r++) {
    const y0 = P.minY - th * .15 + r * th;
    if (y0 > P.maxY) break;
    const offset = (r % 2) * tw * .5 + (ctx.stylized ? 0 : (rng.next() - .5) * tw * .2);
    for (let x = Math.floor((P.minX - offset) / tw) * tw + offset; x < P.maxX; x += tw) {
      const x0 = x + gap / 2, x1 = x + tw - gap / 2, y1 = Math.min(y0 + len, P.maxY + len);
      let outline;
      if (scallop) {
        const rr = Math.min((x1 - x0) * .45, len * .32), arc = (cx, cy, a0, a1) => Array.from({ length: 4 }, (_, i) => { const a = a0 + (a1 - a0) * i / 3; return [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]; });
        outline = [...arc(x0 + rr, y0 + rr, Math.PI, Math.PI * 1.5), ...arc(x1 - rr, y0 + rr, Math.PI * 1.5, Math.PI * 2), [x1, y1], [x0, y1]];
      } else outline = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      const piece = clipPolygon2(outline, clipper);
      if (!piece.length || Math.abs(v2.area(piece)) < (x1 - x0) * len * .12) continue;
      const lift = y => thick + .004 + r * .0005 + tileT * Math.max(0, 1 - (y - y0) / len);
      const topPts = piece.map(([px, py]) => P.to3(px, py, lift(py)));
      const centre = P.to3((x0 + x1) / 2, (y0 + y1) / 2, thick);
      if (ctx.blocked(centre, .02)) continue;
      let shade = ctx.vary(cover === "slate" ? .12 : .1);
      if (!ctx.stylized && rng.chance(.05)) shade *= .8;
      kit.set({ shade, color: !ctx.stylized && rng.chance(.035) ? mixHex(colorRoof, "#6d7250", .3) : colorRoof });
      kit.poly(topPts, P.N);
      kit.set({ shade: shade * .72 });
      for (let i = 0; i < piece.length; i++) {
        const a = piece[i], b = piece[(i + 1) % piece.length];
        if (a[1] > y1 - 1e-3 && b[1] > y1 - 1e-3) continue;
        const quad = [P.to3(a[0], a[1], thick), P.to3(b[0], b[1], thick), P.to3(b[0], b[1], lift(b[1])), P.to3(a[0], a[1], lift(a[1]))];
        const outward = [b[1] - a[1], -(b[0] - a[0])];
        kit.poly(quad, v3.add(v3.mul(P.X, outward[0]), v3.mul(P.Y, outward[1])));
      }
    }
  }
}

function barrel(ctx, P, thick) {
  const { kit, style } = ctx, [tw, th] = style.roof.tile, radius = tw * .42;
  kit.set({ kind: style.roof.kind, color: ctx.color("roof"), detail: ctx.detail });
  const shrink = ccw2(P.top2);
  for (let x = P.minX + tw / 2; x < P.maxX; x += tw) {
    const span = spanAtX(shrink, x);
    if (!span || span[1] - span[0] < .15) continue;
    for (let y = span[0]; y < span[1] - .02; y += th) {
      const y1 = Math.min(span[1], y + th * 1.12);
      const c = P.to3(x, (y + y1) / 2, thick);
      if (ctx.blocked(c, .02)) continue;
      kit.set({ shade: ctx.vary(.1) });
      const g = { o: P.to3(x, 0, thick - radius * .2 + .012 * ((y - span[0]) / th % 2)), t: P.X, u: P.Y, n: P.N };
      kit.cylinder(g, 0, 0, radius, y, y1, 6, { arc: [0, Math.PI], capTop: false });
    }
  }
}

function seams(ctx, P, thick) {
  const { kit } = ctx, step = .55;
  kit.set({ material: "metal", kind: "metal", color: ctx.color("roof"), shade: .9, detail: ctx.detail * .5 });
  for (let x = P.minX + step / 2; x < P.maxX; x += step) {
    const span = spanAtX(P.top2, x);
    if (!span || span[1] - span[0] < .2) continue;
    const a = P.to3(x, span[0] + .02, thick + .025), b = P.to3(x, span[1] - .02, thick + .025);
    if (ctx.blocked(v3.lerp(a, b, .5), .02)) continue;
    kit.beam(a, b, .05, .035, P.N);
  }
  kit.set({ material: "surface" });
}

function thatchLayers(ctx, P, thick) {
  const { kit } = ctx, colorRoof = ctx.color("roof");
  kit.set({ kind: "thatch", color: colorRoof, detail: ctx.detail });
  // Overlapping courses of straw, each ending in a soft rolled lip, darker where it tucks under.
  const span = P.maxY - P.minY, count = Math.max(2, Math.round(span / .85));
  for (let i = 1; i < count; i++) {
    const yCut = P.minY + span * i / count, lift = .055 * i;
    const upper = clipPolygon2(P.top2, [[P.minX - 1, yCut], [P.maxX + 1, yCut], [P.maxX + 1, P.maxY + 1], [P.minX - 1, P.maxY + 1]]);
    if (!upper.length) continue;
    kit.set({ shade: ctx.vary(.06) * (1 + i * .015), detail: ctx.detail * .55 });
    kit.poly(upper.map(([x, y]) => P.to3(x, y, thick + lift)), P.N);
    for (let k = 0; k < upper.length; k++) {
      const a = upper[k], b = upper[(k + 1) % upper.length];
      if (Math.abs(a[1] - yCut) > 1e-3 || Math.abs(b[1] - yCut) > 1e-3) continue;
      kit.set({ shade: .62 });
      kit.poly([P.to3(a[0], a[1], thick), P.to3(b[0], b[1], thick), P.to3(b[0], b[1], thick + lift), P.to3(a[0], a[1], thick + lift)], v3.mul(P.Y, -1));
      const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), r = .09;
      const g = { o: P.to3(0, yCut, thick + lift - r * .45), t: v3.mul(P.Y, -1), u: P.X, n: P.N };
      kit.set({ shade: ctx.vary(.05) * .88 });
      kit.cylinder(g, 0, 0, r, x0, x1, 6, { arc: [0, Math.PI] });
    }
  }
  kit.set({ detail: ctx.detail });
  // A rolled, overhanging eave edge.
  for (let i = 0; i < P.ext2.length; i++) {
    const e = P.edges[i];
    if (!e.extend || !e.eave) continue;
    const a = P.ext2[i], b = P.ext2[(i + 1) % P.ext2.length];
    const r = thick * .55, g = { o: P.to3(a[0], a[1], thick * .5), t: P.N, u: v3.norm(v3.sub(P.to3(b[0], b[1]), P.to3(a[0], a[1]))), n: v3.mul(P.Y, -1) };
    kit.set({ shade: .9 });
    kit.cylinder(g, 0, 0, r, 0, Math.hypot(b[0] - a[0], b[1] - a[1]), 8);
  }
}

function bargeboards(ctx, P, thick) {
  const { kit } = ctx;
  kit.set({ material: "surface", kind: "timber", color: ctx.color("trim"), shade: ctx.vary(.04), detail: ctx.detail * .5 });
  for (let i = 0; i < P.ext2.length; i++) {
    const e = P.edges[i];
    if (!e.extend) continue;
    const a = P.ext2[i], b = P.ext2[(i + 1) % P.ext2.length];
    const A = P.to3(a[0], a[1], 0), B = P.to3(b[0], b[1], 0), L = v3.len(v3.sub(B, A));
    if (L < .1) continue;
    const t = v3.norm(v3.sub(B, A)), n = v3.norm(v3.add(v3.mul(P.X, e.out[0]), v3.mul(P.Y, e.out[1])));
    const g = { o: A, t, u: P.N, n };
    kit.box(g, -.03, L + .03, -.2, thick + .05, 0, .05, { bevel: .01 });
  }
}

function caps(ctx, planes, thick) {
  const { kit, style, roof } = ctx, R = style.roof;
  if (R.ridge === "none" || !planes.length) return;
  const lines = [];
  const sources = [...new Set(roof.slopes.map(s => s.source ?? s.polygon))];
  const cosP = planes[0].cosP, drop = R.overhang * Math.sqrt(1 - cosP * cosP) / cosP;
  for (let i = 0; i < sources.length; i++) for (let j = i + 1; j < sources.length; j++) {
    const shared = sources[i].filter(p => sources[j].some(q => samePoint(p, q)));
    if (shared.length < 2) continue;
    let [a, b] = shared;
    const horizontal = Math.abs(a[1] - b[1]) < 1e-3;
    if (horizontal) {
      // Ridge: extend to the verges where a gable (not a hip) ends it.
      const dir = v3.norm(v3.sub(b, a));
      const gableEnd = p => !sources.some((face, k) => k !== i && k !== j && face.some(q => samePoint(p, q)));
      if (gableEnd(a)) a = v3.addScaled(a, dir, -R.overhang);
      if (gableEnd(b)) b = v3.addScaled(b, dir, R.overhang);
    } else {
      // Hip: run the cap down to the mitred eave corner.
      if (a[1] > b[1]) [a, b] = [b, a];
      const horiz = v3.norm([a[0] - b[0], 0, a[2] - b[2]]);
      a = v3.add(a, [horiz[0] * R.overhang * Math.SQRT2, -drop, horiz[2] * R.overhang * Math.SQRT2]);
    }
    const n = v3.norm(v3.add(planes.find(p => p.slope.source === sources[i] || p.slope.polygon === sources[i])?.N ?? UP, planes.find(p => p.slope.source === sources[j] || p.slope.polygon === sources[j])?.N ?? UP));
    lines.push({ a, b, n, horizontal });
  }
  const lift = thick / cosP + (R.cover === "slate" || R.cover === "shingles" ? .03 : .05);
  const radius = R.ridge === "roll" ? (ctx.stylized ? .17 : .13) + thick * .15 : .12;
  for (const line of lines) {
    const L = v3.len(v3.sub(line.b, line.a)), dir = v3.norm(v3.sub(line.b, line.a));
    const pieces = Math.max(1, Math.round(L / (R.ridge === "tiles" ? .4 : .6)));
    for (let k = 0; k < pieces; k++) {
      const s0 = L * k / pieces, s1 = L * (k + 1) / pieces + (R.ridge === "tiles" ? .03 : 0);
      const mid = v3.addScaled(line.a, dir, (s0 + s1) / 2), centre = v3.add(mid, [0, lift, 0]);
      if (ctx.blocked(centre, .02)) continue;
      if (!planes.some(P => pointInConvex2(P.to2(mid), P.ext2, .3))) continue;
      kit.set({ material: "surface", kind: R.kind === "thatch" ? "thatch" : R.ridge === "board" ? "timber" : R.kind, color: R.ridge === "board" ? ctx.color("timber") : ctx.color("roof"), shade: ctx.vary(.08) * (R.ridge === "board" ? .95 : .92), detail: ctx.detail });
      const base = v3.add(v3.addScaled(line.a, dir, s0), [0, lift - radius * .35, 0]);
      if (R.ridge === "board") {
        const g = { o: v3.add(v3.addScaled(line.a, dir, s0), [0, lift - .02, 0]), t: dir, u: UP, n: v3.norm(v3.cross(dir, UP)) };
        kit.box(g, 0, s1 - s0, 0, .07, -.2, .2, { bevel: .015 });
      } else {
        const side = v3.norm(v3.cross(dir, UP)), g = { o: base, t: side, u: dir, n: UP };
        kit.cylinder(g, 0, 0, radius * (R.ridge === "tiles" ? 1 : 1.1), 0, s1 - s0, 7, { arc: [0, Math.PI], radiusTop: radius * (R.ridge === "tiles" ? .9 : 1.1) });
      }
    }
  }
}

function gableFraming(ctx) {
  const { kit, style, roof } = ctx;
  if (!style.walls.framing || !roof.gables?.length) return;
  kit.set({ material: "surface", kind: "timber", color: ctx.color("timber"), detail: ctx.detail });
  for (const gable of roof.gables) {
    const pts = gable.polygon;
    if (pts.length !== 3) continue;
    const n = v3.norm(gable.normal), z = v3.mul(n, .04);
    const sorted = [...pts].sort((a, b) => a[1] - b[1]), apex = sorted[2], [l, r] = [sorted[0], sorted[1]];
    const mid = v3.lerp(l, r, .5);
    if (ctx.blocked(v3.add(v3.lerp(mid, apex, .5), v3.mul(n, .2)))) continue;
    kit.set({ shade: ctx.vary(.06) });
    kit.beam(v3.add(v3.add(mid, [0, .1, 0]), z), v3.add(v3.add(apex, [0, -.15, 0]), z), .18, .06, n, { bevel: .012 });
    for (const side of [l, r]) {
      kit.set({ shade: ctx.vary(.06) });
      kit.beam(v3.add(v3.lerp(side, mid, .55), [z[0], z[1] + .12, z[2]]), v3.add(v3.lerp(mid, apex, .45), z), .15, .06, n, { bevel: .012 });
    }
  }
}

function chimney(ctx, planes) {
  const { kit, style, rng, form } = ctx, R = style.roof;
  if (!(R.chimney > 0) || !rng.chance(R.chimney)) return;
  const size = ctx.stylized ? .85 : .72;
  const byArea = [...planes].sort((a, b) => Math.abs(v2.area(b.frag2)) - Math.abs(v2.area(a.frag2)));
  for (const P of byArea) {
    const ys = P.frag2.map(p => p[1]), xs = P.frag2.map(p => p[0]);
    const y = Math.max(...ys) - size * .6 - .35;
    for (const t of [.28, .72, .5]) {
      const x = Math.min(...xs) + (Math.max(...xs) - Math.min(...xs)) * t;
      const corners = [[x - size / 2, y - size / 2], [x + size / 2, y - size / 2], [x + size / 2, y + size / 2], [x - size / 2, y + size / 2]];
      if (!corners.every(c => pointInConvex2(c, P.frag2, -.1))) continue;
      const base = P.to3(x, y, 0), top = form.top + form.roofHeight + (ctx.stylized ? .5 : .75);
      if (ctx.blocked([base[0], top, base[2]], .02)) continue;
      const hx = v3.norm([P.X[0], 0, P.X[2]]), g = { o: [base[0], 0, base[2]], t: hx, u: UP, n: v3.cross(hx, UP) };
      const bottom = base[1] - size - .1;
      const kind = R.chimneyKind;
      if (kind === "stone" && ctx.stylized) {
        let yy = bottom;
        while (yy < top - .05) {
          const h = Math.min(top - yy, .32 + rng.next() * .12), grow = rng.next() * .05;
          kit.set({ material: "surface", kind: "stone", color: ctx.color("stone"), shade: ctx.vary(.14), detail: ctx.detail });
          kit.box(g, -size / 2 - grow, size / 2 + grow, yy, yy + h - .02, -size / 2 - grow, size / 2 + grow, { bevel: .05 });
          yy += h;
        }
      } else {
        kit.set({ material: "surface", kind, color: kind === "brick" ? mixHex(ctx.color("wall"), "#9a4e3a", ctx.style.walls.kind === "brick" ? 0 : .8) : ctx.color("stone"), shade: .95, detail: ctx.detail });
        kit.box(g, -size / 2, size / 2, bottom, top, -size / 2, size / 2, { bevel: .02 });
      }
      kit.set({ kind: "stone", color: ctx.color("stone"), shade: .9 });
      kit.box(g, -size / 2 - .08, size / 2 + .08, top, top + .12, -size / 2 - .08, size / 2 + .08, { bevel: .02 });
      kit.set({ kind: "brick", color: "#a85b3f", shade: ctx.vary(.08) });
      const pots = ctx.stylized ? [[0, 0]] : [[-size * .22, 0], [size * .22, 0]];
      for (const [px, pz] of pots) kit.cylinder(g, px, pz, .1, top + .12, top + .45, 8, { radiusTop: .085, capTop: false });
      kit.set({ kind: "metal", color: "#1b1a19", shade: 1, detail: 0 });
      for (const [px, pz] of pots) kit.cylinder(g, px, pz, .07, top + .3, top + .44, 6, { capBottom: false });
      return;
    }
  }
}

function flatEave(ctx) {
  const { kit, style, roof, form } = ctx;
  for (const s of roof.slopes) {
    const P = slopePlane(ctx, { ...s, normal: UP, source: s.source ?? s.polygon }, [], style.roof.overhang);
    kit.set({ material: "surface", formId: form.id, surface: "roof", kind: style.roof.flatKind, color: ctx.color("roof"), shade: 1, detail: ctx.detail });
    kit.slab(P.ext2.map(([x, y]) => P.to3(x, y, 0)), UP, Math.max(.12, style.roof.thickness * .6));
  }
}

// ---- round roofs --------------------------------------------------------------------------------
function roundRoof(ctx) {
  const { kit, style, form, rng } = ctx, R = style.roof;
  const dome = ctx.roundKind === "dome";
  const cx = form.position[0], cz = form.position[2], rx = form.size[0] / 2, rz = form.size[2] / 2, r = (rx + rz) / 2;
  const H = Math.max(.3, form.roofHeight), top = form.top, o = R.overhang;
  const R0 = 1 + o / r, yEave = top - (dome ? -.02 : o * H / r);
  const bell = dome ? 0 : R.bell;
  const profile = t => {
    if (dome) { const a = t * Math.PI / 2; return { rho: (1 + .06) * Math.cos(a) * (t < .02 ? 1 : 1), y: top + .05 + H * Math.sin(a) }; }
    const shape = bell ? Math.pow(t, 1 + bell * .8) * (1 - bell * .1) + bell * .1 * t : t;
    return { rho: R0 * (1 - t), y: yEave + (top + H - yEave) * shape };
  };
  const surf = (theta, t, lift = 0) => {
    const p = profile(t), c = Math.cos(theta), s = Math.sin(theta);
    const q = profile(Math.min(1, t + .01)), dr = (q.rho - p.rho) * r, dy = q.y - p.y;
    const n = v3.norm([c * dy, -dr, s * dy]);
    const base = [cx + c * rx * p.rho, p.y, cz + s * rz * p.rho];
    return { p: v3.addScaled(base, n, lift), n: n[1] < 0 ? v3.mul(n, -1) : n };
  };
  const segments = Math.max(24, Math.min(64, Math.round(Math.PI * 2 * r * R0 / .45)));
  const rings = 14, thick = R.cover === "thatch" ? .35 : Math.max(.12, R.thickness * .8);
  kit.set({ material: "surface", formId: form.id, surface: "roof", kind: dome && R.cover === "flat" ? "metal" : R.kind, color: ctx.color("roof"), shade: .82, detail: ctx.detail });
  for (let j = 0; j < rings; j++) for (let i = 0; i < segments; i++) {
    const a0 = i / segments * Math.PI * 2, a1 = (i + 1) / segments * Math.PI * 2, t0 = j / rings, t1 = (j + 1) / rings;
    const A = surf(a0, t0, thick), B = surf(a1, t0, thick), C = surf(a1, t1, thick), D = surf(a0, t1, thick);
    kit.quadSmooth(A.p, B.p, C.p, D.p, A.n, B.n, C.n, D.n);
  }
  const thatchRound = R.cover === "thatch";
  const soffit = () => kit.set({ kind: thatchRound ? "thatch" : "plank", color: thatchRound ? ctx.color("roof") : ctx.color("timber"), shade: thatchRound ? .7 : .85 });
  kit.set({ surface: "roof-detail" }); soffit();
  const inner = Math.max(.5, (dome ? .9 : .97) - .1);
  for (let i = 0; i < segments; i++) {
    const a0 = i / segments * Math.PI * 2, a1 = (i + 1) / segments * Math.PI * 2;
    const e0 = surf(a0, 0), e1 = surf(a1, 0);
    const ring = (a, k) => [cx + Math.cos(a) * rx * k, yEave - .01, cz + Math.sin(a) * rz * k];
    kit.poly([e0.p, e1.p, ring(a1, inner), ring(a0, inner)], [0, -1, 0]);
    const t0 = surf(a0, 0, thick), t1 = surf(a1, 0, thick);
    kit.set({ kind: thatchRound ? "thatch" : "timber", color: thatchRound ? ctx.color("roof") : ctx.color(R.bargeboard ? "trim" : "timber"), shade: .9 });
    kit.poly([e0.p, e1.p, t1.p, t0.p], [Math.cos((a0 + a1) / 2), 0, Math.sin((a0 + a1) / 2)]);
    soffit();
  }
  kit.set({ surface: "roof-detail" });
  if (thatchRound && !ctx.draft) {
    const bands = 4;
    for (let k = 1; k <= bands; k++) {
      const tk = k / (bands + 1);
      kit.set({ kind: "thatch", color: ctx.color("roof"), shade: ctx.vary(.05) * .8, detail: ctx.detail * .55 });
      for (let i = 0; i < segments; i++) {
        const a0 = i / segments * Math.PI * 2, a1 = (i + 1) / segments * Math.PI * 2;
        const A = surf(a0, tk, thick + .09), B = surf(a1, tk, thick + .09), C = surf(a1, tk + .035, thick), D = surf(a0, tk + .035, thick);
        kit.quadSmooth(A.p, B.p, C.p, D.p, A.n, B.n, C.n, D.n);
        const Ab = surf(a0, tk - .02, thick), Bb = surf(a1, tk - .02, thick);
        kit.set({ shade: .62 });
        kit.poly([Ab.p, Bb.p, B.p, A.p], [Math.cos((a0 + a1) / 2), -.4, Math.sin((a0 + a1) / 2)]);
        kit.set({ shade: .8 });
      }
    }
    kit.set({ detail: ctx.detail });
  }
  if (ctx.draft) { /* covering lands on release */ }
  else if (R.cover === "tiles" || R.cover === "slate" || R.cover === "shingles" || R.cover === "barrel") {
    let [tw, th] = R.tile;
    const profileLength = Math.hypot(r * R0, top + H - yEave);
    const estimate = (profileLength / th) * (Math.PI * r * R0 / tw);
    if (estimate > 1500) { const k = Math.sqrt(estimate / 1500); tw *= k; th *= k; }
    const rowsT = Math.ceil(profileLength / th), tileT = ctx.stylized ? .055 : .035;
    const colorRoof = ctx.color("roof");
    kit.set({ kind: R.kind, color: colorRoof, detail: ctx.detail });
    for (let row = 0; row < rowsT; row++) {
      const ta = row / rowsT, tb = Math.min(.97, (row + 1.45) / rowsT);
      if (ta > .9) break;
      const circumference = Math.PI * 2 * r * profile(ta).rho;
      const count = Math.max(6, Math.round(circumference / tw));
      const phase = row % 2 ? .5 : 0;
      for (let i = 0; i < count; i++) {
        const gapA = ctx.stylized ? .08 : .04;
        const a0 = (i + phase + gapA) / count * Math.PI * 2, a1 = (i + phase + 1 - gapA) / count * Math.PI * 2, am = (a0 + a1) / 2;
        const probe = surf(am, (ta + tb) / 2, thick);
        if (ctx.blocked(probe.p, .02)) continue;
        const low = thick + .004 + tileT, high = thick + .004;
        const A = surf(a0, ta, low), B = surf(a1, ta, low), C = surf(a1, tb, high), D = surf(a0, tb, high);
        const shade = ctx.vary(.1);
        kit.set({ shade });
        if (ctx.stylized) {
          const M = surf(am, Math.max(0, ta - .25 / rowsT), low);
          kit.tri(A.p, M.p, D.p, A.n, M.n, D.n); kit.tri(M.p, B.p, C.p, M.n, B.n, C.n); kit.tri(M.p, C.p, D.p, M.n, C.n, D.n);
          kit.set({ shade: shade * .72 });
          const Ab = surf(a0, ta, thick), Mb = surf(am, Math.max(0, ta - .25 / rowsT), thick), Bb = surf(a1, ta, thick);
          kit.poly([Ab.p, Mb.p, M.p, A.p], v3.mul(A.n, -1).map((v, k) => k === 1 ? -Math.abs(v) - .5 : v));
          kit.poly([Mb.p, Bb.p, B.p, M.p], v3.mul(B.n, -1).map((v, k) => k === 1 ? -Math.abs(v) - .5 : v));
        } else {
          kit.quadSmooth(A.p, B.p, C.p, D.p, A.n, B.n, C.n, D.n);
          kit.set({ shade: shade * .72 });
          const Ab = surf(a0, ta, thick), Bb = surf(a1, ta, thick);
          kit.poly([Ab.p, Bb.p, B.p, A.p], [Math.cos(am), -.6, Math.sin(am)]);
        }
      }
    }
  } else if (R.cover === "metal") {
    kit.set({ material: "metal", kind: "metal", color: ctx.color("metal"), shade: 1, detail: ctx.detail * .5 });
    const ribs = 12;
    for (let i = 0; i < ribs; i++) {
      const a = i / ribs * Math.PI * 2;
      for (let j = 0; j < 8; j++) {
        const p0 = surf(a, j / 8, thick + .03), p1 = surf(a, (j + 1) / 8, thick + .03);
        kit.beam(p0.p, p1.p, .06, .06, p0.n);
      }
    }
    kit.set({ material: "surface" });
  }
  // Finial.
  const apex = [cx, (dome ? top + .05 + H : top + H) + thick * .6, cz];
  if (ctx.blocked(apex, .02)) return;
  const g = { o: [cx, 0, cz], t: [1, 0, 0], u: UP, n: [0, 0, 1] };
  if (R.finial === "spike") {
    kit.set({ material: "metal", kind: "metal", color: ctx.color("metal"), shade: 1, detail: .3 });
    kit.cylinder(g, 0, 0, .09, apex[1] - .1, apex[1] + .25, 8, { radiusTop: .05 });
    kit.cylinder(g, 0, 0, .05, apex[1] + .25, apex[1] + 1.3, 8, { radiusTop: .004 });
    kit.blob([cx, apex[1] + .45, cz], [.09, .09, .09], 8, 4);
    kit.set({ material: "surface" });
  } else if (R.finial === "ball") {
    kit.set({ kind: "timber", color: ctx.color("trim"), shade: 1, detail: .2 });
    kit.cylinder(g, 0, 0, .12, apex[1] - .15, apex[1] + .2, 8, { radiusTop: .07 });
    kit.blob([cx, apex[1] + .34, cz], [.17, .17, .17], 10, 6);
  } else {
    kit.set({ kind: R.kind, color: ctx.color("roof"), shade: .85 });
    kit.cylinder(g, 0, 0, .22, apex[1] - .25, apex[1] + .05, 8, { radiusTop: .08 });
  }
  void rng;
}

export function mixHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const mix = shift => Math.round(((pa >> shift) & 255) * (1 - t) + ((pb >> shift) & 255) * t);
  return `#${((mix(16) << 16) | (mix(8) << 8) | mix(0)).toString(16).padStart(6, "0")}`;
}
