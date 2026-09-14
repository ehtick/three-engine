import * as THREE from "three/webgpu";
import { normalizeArchitectureModel, getArchitectureFormFootprint, DEFAULT_FORM_COLOR, resolveArchitectureForm, isBoundaryForm } from "./formModel.js";
import { createRng } from "./styles/rng.js";
import { resolveStyle, paletteIndexFor, paletteAt } from "./styles/catalog.js";
import { layerIndexFor, styleTileMetres } from "./styles/surfaces.js";
import { KitMesh, linearColor, pointInConvex2, ccw2 } from "./kit/kitMesh.js";
import { decorateWalls } from "./kit/wallKit.js";
import { decorateOpenings } from "./kit/openingKit.js";
import { decorateRoof } from "./kit/roofKit.js";
import { openingOutline } from "./kit/openingShape.js";

// Faces are clipped directly against neighboring convex masses. Keeping this
// boundary representation avoids rebuilding a CSG tree as a town grows, and
// removes the shared wall before a hollow skin is generated from the exterior.
// A styled model then runs the kit generators (kit/*.js) per form against the
// same exposed faces, so detail only ever lands on surfaces that are really outside.
const EPS = 1e-6, MAX_VERTICES = 2000000, MAX_FRAGMENTS = 2048;
const CACHE_LIMIT = 1200000, cache = new Map(); let cachedVertices = 0;
const PITCHED = new Set(["hip", "gable", "shed", "dome"]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => a.map((v, i) => v - b[i]);
const add = (a, b, scale = 1) => a.map((v, i) => v + b[i] * scale);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = a => { const length = Math.hypot(...a); return length > EPS ? a.map(v => v / length) : [0, 1, 0]; };
const boxOf = points => ({ min: [0, 1, 2].map(i => Math.min(...points.map(p => p[i]))), max: [0, 1, 2].map(i => Math.max(...points.map(p => p[i]))) });
const overlaps = (a, b, tolerance = EPS) => a.min.every((v, i) => v <= b.max[i] + tolerance && a.max[i] >= b.min[i] - tolerance);
const plane = (normal, point) => ({ normal, constant: dot(normal, point) });
const thickness = form => Math.min(.2, form.size[0] * .15, form.size[1] * .15, form.size[2] * .15);
const styledThickness = (form, style) => Math.max(.12, Math.min(style.walls.thickness, form.size[0] * .3, form.size[2] * .3, form.size[1] * .3));
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const hashString = value => { let h = 2166136261; for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const area = points => {
  if (points.length < 3) return 0;
  const origin = points[0]; let sum = [0, 0, 0];
  for (let i = 1; i < points.length - 1; i++) sum = add(sum, cross(sub(points[i], origin), sub(points[i + 1], origin)));
  return Math.hypot(...sum) / 2;
};
function clean(points) {
  const result = [];
  for (const p of points) if (!result.length || Math.hypot(...sub(p, result.at(-1))) > EPS) result.push(p);
  if (result.length > 1 && Math.hypot(...sub(result[0], result.at(-1))) < EPS) result.pop();
  return result.length >= 3 && area(result) > EPS * EPS ? result : [];
}

function clip(points, boundary, inside, bias = 0) {
  if (!points.length) return [];
  if (points.every(point => Math.abs(dot(boundary.normal, point) - boundary.constant + bias) <= EPS * .01)) return inside ? points : [];
  const output = [], sign = inside ? 1 : -1;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const da = dot(boundary.normal, a) - boundary.constant + bias, db = dot(boundary.normal, b) - boundary.constant + bias;
    const aIn = da * sign <= EPS * .01, bIn = db * sign <= EPS * .01;
    if (aIn) output.push(a);
    if (aIn !== bIn && Math.abs(da - db) > EPS * .001) output.push(add(a, sub(b, a), da / (da - db)));
  }
  return clean(output);
}

/** Exact polygon minus convex solid, represented by convex remaining polygons. */
function subtractPolygon(points, solid, normal, bias = 0) {
  let intersection = points;
  for (const boundary of solid.planes) {
    intersection = clip(intersection, boundary, true, bias * dot(normal, boundary.normal));
    if (!intersection.length) return [points];
  }
  if (area(intersection) >= area(points) * (1 - 1e-10)) return [];
  let remainder = points;
  const outside = [];
  for (const boundary of solid.planes) {
    const offset = bias * dot(normal, boundary.normal);
    const next = clip(remainder, boundary, true, offset);
    const fragment = clip(remainder, boundary, false, offset);
    if (fragment.length) outside.push(fragment);
    remainder = next;
    if (!remainder.length) return outside;
  }
  return outside;
}

function subtractAll(polygons, solid, normal, bias = 0) {
  const result = [];
  for (const polygon of polygons) {
    if (!overlaps(boxOf(polygon), solid.bounds, Math.abs(bias) + EPS)) { result.push(polygon); continue; }
    result.push(...subtractPolygon(polygon, solid, normal, bias));
    if (result.length > MAX_FRAGMENTS) throw new Error("This junction is too complex. Simplify overlapping forms or paths.");
  }
  return result;
}

function prism(ring, bottom, top, owner, kind = "wall") {
  const faces = [], planes = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], normal = unit([b[1] - a[1], 0, a[0] - b[0]]);
    const points = [[a[0], bottom, a[1]], [b[0], bottom, b[1]], [b[0], top, b[1]], [a[0], top, a[1]]];
    faces.push({ points, normal, kind }); planes.push(plane(normal, points[0]));
  }
  faces.push({ points: ring.map(([x, z]) => [x, bottom, z]), normal: [0, -1, 0], kind: "floor" });
  faces.push({ points: ring.map(([x, z]) => [x, top, z]), normal: [0, 1, 0], kind: "top" });
  planes.push(plane([0, -1, 0], [0, bottom, 0]), plane([0, 1, 0], [0, top, 0]));
  return { owner, kind, faces, planes, bounds: boxOf(faces.flatMap(face => face.points)) };
}

/** Convex roof solid of a resolved form (roof hip/gable/shed/dome; dome is a cone here). */
function roofSolid(form, owner) {
  if (!PITCHED.has(form.roof)) return null;
  const ring = getArchitectureFormFootprint(form), y = form.position[1] + form.size[1], h = form.roofHeight;
  const transform = ([x, z], lift = h) => [form.position[0] + x * Math.cos(form.rotationY) + z * Math.sin(form.rotationY), y + lift, form.position[2] - x * Math.sin(form.rotationY) + z * Math.cos(form.rotationY)];
  const lower = ring.map(([x, z]) => [x, y, z]); let polygons, gables = [];
  const width = form.size[0], depth = form.size[2];
  if (form.shape === "round") {
    const apex = [form.position[0], y + h, form.position[2]];
    polygons = lower.map((a, i) => [a, lower[(i + 1) % lower.length], apex]);
  } else if (form.roof === "hip" || form.roof === "dome") {
    if (width >= depth) {
      const left = transform([-(width - depth) / 2, 0]), right = transform([(width - depth) / 2, 0]);
      polygons = [[lower[0], lower[1], right, left], [lower[1], lower[2], right], [lower[2], lower[3], left, right], [lower[3], lower[0], left]];
    } else {
      const front = transform([0, -(depth - width) / 2]), back = transform([0, (depth - width) / 2]);
      polygons = [[lower[0], lower[1], front], [lower[1], lower[2], back, front], [lower[2], lower[3], back], [lower[3], lower[0], front, back]];
    }
  } else if (form.roof === "shed") {
    // One slope falling toward +z (roofAxis x) or +x (roofAxis z); the high side closes with a wall.
    const axis = form.roofAxis ?? "x";
    const lift = i => transform([[-width / 2, -depth / 2], [width / 2, -depth / 2], [width / 2, depth / 2], [-width / 2, depth / 2]][i]);
    if (axis === "x") {
      polygons = [[lift(0), lift(1), lower[2], lower[3]]];
      gables = [[lower[0], lower[1], lift(1), lift(0)], [lower[1], lower[2], lift(1)], [lower[3], lower[0], lift(0)]];
    } else {
      polygons = [[lift(0), lower[1], lower[2], lift(3)]];
      gables = [[lower[3], lower[0], lift(0), lift(3)], [lower[0], lower[1], lift(0)], [lower[2], lower[3], lift(3)]];
    }
  } else {
    // A triangular prism: two slopes meeting at a ridge that runs along the
    // resolved axis, closed by vertical gable ends (wall-coloured triangles).
    const axis = form.roofAxis ?? (width >= depth ? "x" : "z");
    if (axis === "x") {
      const left = transform([-width / 2, 0]), right = transform([width / 2, 0]);
      polygons = [[lower[0], lower[1], right, left], [lower[2], lower[3], left, right]];
      gables = [[lower[2], lower[1], right], [lower[0], lower[3], left]];
    } else {
      const front = transform([0, -depth / 2]), back = transform([0, depth / 2]);
      polygons = [[lower[1], lower[2], back, front], [lower[3], lower[0], front, back]];
      gables = [[lower[1], lower[0], front], [lower[3], lower[2], back]];
    }
  }
  const centre = [form.position[0], y + h * .3, form.position[2]];
  const face = (points, kind, up) => {
    let normal = unit(cross(sub(points[1], points[0]), sub(points[2], points[0])));
    if (up ? normal[1] < 0 : dot(normal, sub(points[0], centre)) < 0) normal = normal.map(v => -v);
    return { points, normal, kind };
  };
  const faces = [
    ...polygons.map(clean).filter(p => p.length).map(points => face(points, "roof", true)),
    ...gables.map(clean).filter(p => p.length).map(points => face(points, "wall", false)),
  ];
  return { owner, kind: "roof", faces, planes: [...faces.map(face => plane(face.normal, face.points[0])), plane([0, -1, 0], [0, y, 0])], bounds: boxOf(faces.flatMap(face => face.points)) };
}

function openingHead(opening, style) {
  if (opening.head) return opening.head;
  if (opening.kind === "arch") return "round";
  if (!style) return "flat";
  return opening.kind === "door" ? style.openings.door.head : style.openings.window.head;
}

function openingSolid(opening, form) {
  const center = opening.position, normal = opening.normal, tangent = [normal[2], 0, -normal[0]];
  const width = opening.width, height = opening.height;
  const ring = openingOutline(width, height, opening.head ?? "flat", 12).map(([x, y]) => [x - width / 2, y - height / 2]);
  const depth = (opening.wallThickness ?? thickness(form)) * 3 + .15 + (form.shape === "round" ? Math.min(Math.max(...form.size), width * width / Math.max(.6, Math.min(form.size[0], form.size[2]) * 2)) : 0);
  const planes = ring.map((a, i) => {
    const b = ring[(i + 1) % ring.length], outward = unit(add(tangent.map(v => v * (b[1] - a[1])), [0, a[0] - b[0], 0]));
    return plane(outward, add(add(center, tangent, a[0]), [0, a[1], 0]));
  });
  planes.push(plane(normal, add(center, normal, depth)), plane(normal.map(v => -v), add(center, normal, -depth)));
  const points = ring.flatMap(([x, y]) => [-depth, depth].map(d => add(add(add(center, tangent, x), [0, y, 0]), normal, d)));
  return { planes, bounds: boxOf(points), id: opening.id };
}

/** Storey-aligned automatic openings. With a style: its window size, spacing, layout and head,
 * plus one front door for the form chosen to carry its building's entrance. */
function autoOpenings(form, style = null, { door = false, blocked = () => false } = {}) {
  if (!form.windows || isBoundaryForm(form) || form.size[1] < 2.3) return [];
  const W = style?.openings.window ?? { w: 1, h: 1.3, sill: .9, spacing: 2.2, layout: "punched", head: "flat" };
  const D = style?.openings.door ?? { w: 1.1, h: 2.2, head: "flat" };
  const density = Math.max(.25, W.density ?? 1);
  const ring = getArchitectureFormFootprint(form), result = [];
  const storeys = Math.max(1, Math.round(form.size[1] / (style?.walls.storey ?? 2.8))), storeyHeight = form.size[1] / storeys;
  const slit = W.layout === "slit";
  const winHeight = style ? Math.min(W.h, Math.max(.6, storeyHeight - Math.min(W.sill, storeyHeight * .35) - .45)) : Math.min(1.3, Math.max(.8, storeyHeight - 1.5));
  const sill = style ? Math.max(.3, Math.min(W.sill, storeyHeight - winHeight - .35)) : Math.min(1, Math.max(.75, (storeyHeight - winHeight) * .5 + .15));
  const head = style ? W.head : "flat";
  const push = (x, z, normal, storey, width, extra = {}) => result.push({ id: `auto-${result.length}`, formId: form.id, position: [x, form.position[1] + storey * storeyHeight + sill + winHeight / 2, z], normal, width, height: winHeight, kind: "window", head, auto: true, ...extra });
  const grounded = form.position[1] < .35;
  if (form.shape === "round") {
    const circumference = Math.PI * (form.size[0] + form.size[2]) / 2;
    const count = Math.min(16, Math.max(slit ? 4 : 3, Math.round(circumference / ((style ? W.spacing : 2.8) / density))));
    const c = Math.cos(form.rotationY), s = Math.sin(form.rotationY);
    const width = style ? Math.min(W.w, Math.min(form.size[0], form.size[2]) * .3) : Math.min(.95, Math.min(form.size[0], form.size[2]) * .3);
    let doorAt = -1;
    if (door && grounded) {
      let best = -Infinity;
      for (let i = 0; i < count; i++) {
        const angle = i * Math.PI * 2 / count, lx = Math.cos(angle) * form.size[0] / 2, lz = Math.sin(angle) * form.size[2] / 2;
        const wx = form.position[0] + lx * c + lz * s, wz = form.position[2] - lx * s + lz * c, n = unit([Math.cos(angle) * c + Math.sin(angle) * s, 0, -Math.cos(angle) * s + Math.sin(angle) * c]);
        if (blocked([wx + n[0] * .4, form.position[1] + 1, wz + n[2] * .4])) continue;
        const score = n[2] - Math.abs(n[0]) * .2;
        if (score > best) { best = score; doorAt = i; }
      }
    }
    for (let i = 0; i < count; i++) {
      const angle = i * Math.PI * 2 / count, local = [Math.cos(angle) * form.size[0] / 2, Math.sin(angle) * form.size[2] / 2];
      const n = unit([Math.cos(angle) / form.size[0], 0, Math.sin(angle) / form.size[2]]);
      const x = form.position[0] + local[0] * c + local[1] * s, z = form.position[2] - local[0] * s + local[1] * c, normal = [n[0] * c + n[2] * s, 0, -n[0] * s + n[2] * c];
      for (let storey = 0; storey < storeys; storey++) {
        if (storey === 0 && i === doorAt) {
          const dw = Math.min(D.w, width * 1.6), dh = Math.min(D.h, storeyHeight - .35);
          result.push({ id: `auto-${result.length}`, formId: form.id, position: [x, form.position[1] + dh / 2, z], normal, width: dw, height: dh, kind: "door", head: D.head, auto: true });
        } else if ((i + storey) % (slit && storeys > 1 ? 2 : 1) === 0) push(x, z, normal, storey, width);
      }
    }
    return result;
  }
  const edges = ring.map((a, edge) => { const b = ring[(edge + 1) % ring.length]; return { a, b, length: Math.hypot(b[0] - a[0], b[1] - a[1]), n: unit([b[1] - a[1], 0, a[0] - b[0]]) }; });
  let doorEdge = -1;
  if (door && grounded) {
    let best = -Infinity;
    edges.forEach((e, i) => {
      if (e.length < D.w + 1) return;
      const mid = [(e.a[0] + e.b[0]) / 2 + e.n[0] * .4, form.position[1] + 1, (e.a[1] + e.b[1]) / 2 + e.n[2] * .4];
      if (blocked(mid)) return;
      const score = e.length + e.n[2] * 1.5;
      if (score > best) { best = score; doorEdge = i; }
    });
  }
  edges.forEach((e, edge) => {
    const margin = style ? Math.max(.7, W.w * .7) : .7, usable = e.length - margin * 2;
    const minWidth = style ? W.w : 1.1;
    const lerp = t => [e.a[0] + (e.b[0] - e.a[0]) * t, e.a[1] + (e.b[1] - e.a[1]) * t];
    if (W.layout === "ribbon" && style) {
      if (usable < 1) return;
      const [x, z] = lerp(.5);
      for (let storey = 0; storey < storeys; storey++) {
        if (edge === doorEdge && storey === 0) {
          const dh = Math.min(D.h, storeyHeight - .3), dw = Math.min(D.w * 1.4, usable);
          result.push({ id: `auto-${result.length}`, formId: form.id, position: [x, form.position[1] + dh / 2, z], normal: e.n, width: dw, height: dh, kind: "door", head: D.head, auto: true });
          continue;
        }
        push(x, z, e.n, storey, usable, { layout: "ribbon" });
      }
      return;
    }
    if (usable < minWidth) return;
    const spacing = (style ? W.spacing : 2.2) / density;
    const count = style ? Math.max(1, Math.min(14, Math.round(usable / spacing))) : Math.max(1, Math.min(5, Math.floor((usable + 1.2) / 2.2)));
    const step = usable / count;
    const doorCol = edge === doorEdge ? Math.floor((count - 1) / 2) : -1;
    for (let col = 0; col < count; col++) {
      const [x, z] = lerp((margin + step * (col + .5)) / e.length);
      for (let storey = 0; storey < storeys; storey++) {
        if (col === doorCol && storey === 0) {
          const dh = Math.min(D.h, storeyHeight - .3), dw = Math.min(D.w, step - .2);
          if (dw < .6) continue;
          result.push({ id: `auto-${result.length}`, formId: form.id, position: [x, form.position[1] + dh / 2, z], normal: e.n, width: dw, height: dh, kind: "door", head: D.head, auto: true });
          continue;
        }
        push(x, z, e.n, storey, style ? Math.min(W.w, step - .3) : 1);
      }
    }
    if (doorCol < 0 && edge === doorEdge) {
      const [x, z] = lerp(.5), dh = Math.min(D.h, storeyHeight - .3);
      result.push({ id: `auto-${result.length}`, formId: form.id, position: [x, form.position[1] + dh / 2, z], normal: e.n, width: D.w, height: dh, kind: "door", head: D.head, auto: true });
    }
  });
  return result;
}

function pathSegments(paths) {
  const result = [];
  for (const path of paths) for (let i = 0; i < path.points.length - 1; i++) {
    const a = path.points[i], b = path.points[i + 1], dx = b[0] - a[0], dz = b[1] - a[1], length = Math.hypot(dx, dz);
    if (length < .01) continue;
    const nx = -dz / length * path.width / 2, nz = dx / length * path.width / 2;
    const ex = dx / length * .02, ez = dz / length * .02;
    const ring = [[a[0] - ex - nx, a[1] - ez - nz], [b[0] + ex - nx, b[1] + ez - nz], [b[0] + ex + nx, b[1] + ez + nz], [a[0] - ex + nx, a[1] - ez + nz]];
    result.push({ ...prism(ring, path.elevation - .02, path.elevation + 2.4, -1), pathId: path.id, ring, elevation: path.elevation, width: path.width });
  }
  return result;
}

function faceName(kind, normal) {
  if (kind === "roof") return "roof";
  if (normal[1] > .5) return "top";
  if (normal[1] < -.5) return "bottom";
  return Math.abs(normal[0]) > Math.abs(normal[2]) ? normal[0] > 0 ? "east" : "west" : normal[2] > 0 ? "south" : "north";
}

function collector() {
  return { position: [], normal: [], uv: [], styleLayer: [], styleTint: [], index: [], groups: [], surfaces: [], descriptors: [], materialMap: new Map() };
}

/** Styled geometry batches into four shared materials, whatever the style or kind. */
const STYLED_MATERIALS = new Set(["surface", "glass", "metal", "light"]);
function materialIndex(output, color, role, styled) {
  const name = styled ? (STYLED_MATERIALS.has(role) ? role : "surface") : null;
  const key = styled ? `styled:${name}` : `${role}:${color}`;
  if (!output.materialMap.has(key)) {
    output.materialMap.set(key, output.descriptors.length);
    output.descriptors.push(styled ? { role: name, styled: true } : { color, role });
  }
  return output.materialMap.get(key);
}

/** `styled` = `{ kind, detail, shade?(point) }` for a massing face of a styled model. */
function emitFace(output, polygon, normal, metadata, color, role, styled) {
  let points = clean(polygon);
  if (!points.length) return;
  if (dot(cross(sub(points[1], points[0]), sub(points[2], points[0])), normal) < 0) points = [...points].reverse();
  const base = output.position.length / 3, start = output.index.length;
  if (base + points.length > MAX_VERTICES) throw new Error("Architecture geometry exceeded 2,000,000 vertices. Simplify the model.");
  const tangent = Math.abs(normal[1]) > .9 ? [1, 0, 0] : unit([normal[2], 0, -normal[0]]), vertical = unit(cross(normal, tangent));
  const repeat = styled ? styleTileMetres(styled.kind) : null, layer = styled ? layerIndexFor(styled.kind) : 0, tint = styled ? linearColor(color) : null;
  for (const p of points) {
    output.position.push(...p);
    const n = styled?.normalAt && !metadata.interior ? styled.normalAt(p, normal) : normal;
    output.normal.push(n[0], n[1], n[2]);
    const u = dot(p, tangent), v = dot(p, vertical);
    if (styled) {
      const shade = (styled.shade ? styled.shade(p) : 1) * (metadata.interior ? .55 : 1);
      output.uv.push(u / repeat[0], v / repeat[1]);
      output.styleLayer.push(layer);
      output.styleTint.push(tint[0] * shade, tint[1] * shade, tint[2] * shade, styled.detail);
    } else {
      output.uv.push(u, v);
      output.styleLayer.push(0);
      output.styleTint.push(1, 1, 1, 0);
    }
  }
  for (let i = 1; i < points.length - 1; i++) output.index.push(base, base + i, base + i + 1);
  const count = output.index.length - start, index = materialIndex(output, color, role, !!styled);
  output.groups.push({ start, count, materialIndex: index });
  output.surfaces.push({ start, count, ...metadata, normal: [...normal], face: faceName(metadata.kind, normal) });
}

function emitSkin(output, polygon, normal, depth, metadata, color, role, styled) {
  let points = clean(polygon);
  if (!points.length) return;
  if (dot(cross(sub(points[1], points[0]), sub(points[2], points[0])), normal) < 0) points = [...points].reverse();
  const inner = points.map(point => add(point, normal, -depth));
  emitFace(output, points, normal, metadata, color, role, styled);
  emitFace(output, inner, normal.map(v => -v), { ...metadata, interior: true }, color, role, styled);
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length, outward = unit(cross(sub(points[j], points[i]), normal));
    emitFace(output, [points[i], points[j], inner[j], inner[i]], outward, { ...metadata, interior: true }, color, role, styled);
  }
}

function exposed(face, solid, neighbors) {
  let polygons = [face.points];
  for (const neighbor of neighbors) {
    if (neighbor === solid || !overlaps(boxOf(face.points), neighbor.bounds)) continue;
    // Outward sampling removes opposite shared faces. Coplanar faces pointing
    // the same way belong to the earlier form, so overlapping boxes never flicker.
    const coincident = neighbor.planes.some(boundary => dot(boundary.normal, face.normal) > 1 - 1e-8 && Math.abs(dot(boundary.normal, face.points[0]) - boundary.constant) < EPS * 8);
    const bias = solid.kind === "support" || (face.kind === "roof" && neighbor.kind !== "roof") || (coincident && neighbor.owner < solid.owner) ? 0 : EPS * 4;
    polygons = subtractAll(polygons, neighbor, face.normal, bias);
    if (!polygons.length) break;
  }
  return polygons;
}

/** `palette` tints the base massing unless a form authored its own color/roofColor. */
function colorFor(form, role, palette) {
  const wallColor = palette && form.color === DEFAULT_FORM_COLOR ? palette.wall : form.color;
  if (role === "roof") return form.roofColor ?? (palette ? palette.roof : `#${new THREE.Color(wallColor).multiplyScalar(.44).getHexString()}`);
  if (role === "floor" || role === "support") return `#${new THREE.Color(wallColor).multiplyScalar(.8).getHexString()}`;
  return wallColor;
}

/** Cross section of a convex post, used to close the new faces made by cuts. */
function section(solid, boundary) {
  const vertices = solid.faces.flatMap(face => face.points), distances = vertices.map(point => dot(boundary.normal, point) - boundary.constant);
  if (Math.min(...distances) >= -EPS || Math.max(...distances) <= EPS) return [];
  const points = [];
  const keep = point => { if (!points.some(other => Math.hypot(...sub(point, other)) < EPS)) points.push(point); };
  for (const face of solid.faces) for (let i = 0; i < face.points.length; i++) {
    const a = face.points[i], b = face.points[(i + 1) % face.points.length];
    const da = dot(boundary.normal, a) - boundary.constant, db = dot(boundary.normal, b) - boundary.constant;
    if (Math.abs(da) < EPS) keep(a);
    if (da * db < 0) keep(add(a, sub(b, a), da / (da - db)));
  }
  if (points.length < 3) return [];
  const center = points.reduce((sum, point) => add(sum, point, 1 / points.length), [0, 0, 0]);
  const u = unit(cross(Math.abs(boundary.normal[1]) < .9 ? [0, 1, 0] : [1, 0, 0], boundary.normal)), v = cross(boundary.normal, u);
  return clean(points.sort((a, b) => Math.atan2(dot(sub(a, center), v), dot(sub(a, center), u)) - Math.atan2(dot(sub(b, center), v), dot(sub(b, center), u))));
}

function supportCutCaps(output, post, cutters, form, palette) {
  for (let index = 0; index < cutters.length; index++) {
    const cutter = cutters[index];
    for (const boundary of cutter.planes) {
      let polygon = section(post, boundary);
      for (const constraint of cutter.planes) {
        polygon = clip(polygon, constraint, true);
        if (!polygon.length) break;
      }
      if (!polygon.length) continue;
      const normal = boundary.normal.map(n => -n);
      let polygons = [polygon];
      for (let other = 0; other < cutters.length; other++) {
        if (other === index) continue;
        const coincident = cutters[other].planes.some(p => dot(p.normal, boundary.normal) > 1 - 1e-8 && Math.abs(p.constant - boundary.constant) < EPS);
        if (coincident && other > index) continue;
        polygons = subtractAll(polygons, cutters[other], normal);
      }
      for (const cap of polygons) emitFace(output, cap, normal, { formId: form.id, kind: "support", cap: true }, colorFor(form, "support", palette), "support");
    }
  }
}

const insideSolid = (solid, point, margin) => solid.planes.every(p => dot(p.normal, point) - p.constant < -margin);

/** The openings a form cuts: authored ones (head resolved) plus automatic ones clear of them. */
function formOpenings(form, manual, env, blocked) {
  const style = env.style, T = style ? styledThickness(form, style) : thickness(form);
  const authored = manual.filter(opening => opening.formId === form.id).map(o => ({ ...o, head: openingHead(o, style), wallThickness: T }));
  const hasDoor = authored.some(o => o.kind === "door");
  const automatic = autoOpenings(form, style, { door: env.door && !hasDoor, blocked })
    .filter(opening => !authored.some(other => Math.hypot(...sub(opening.position, other.position)) < (opening.width + other.width + opening.height + other.height) * .35))
    // An automatic opening must be clear of neighbours along its whole width, not just its centre.
    .filter(opening => {
      const n = opening.normal, t = [n[2], 0, -n[0]];
      return [-.5, 0, .5].every(k => [-.5, 0, .5].every(j => !blocked(add(add(add(opening.position, t, k * (opening.width + .3)), [0, 1, 0], j * (opening.height + .3)), n, .35), .01)));
    })
    .map(o => ({ ...o, wallThickness: T }));
  return [...authored, ...automatic];
}

/** Face frames, openings in face coordinates, roof slopes (with their unclipped source faces) and
 * footprint of ONE resolved form, against its neighbouring solids. */
function describeForm(form, index, body, roofSolidResult, neighbors, openings) {
  const base = form.position[1], top = base + form.size[1], axis = form.roofAxis ?? (form.size[0] >= form.size[2] ? "x" : "z");
  const record = { id: form.id, shape: form.shape, position: [...form.position], size: [...form.size], rotationY: form.rotationY,
    roof: form.roof, roofAxis: axis, roofHeight: form.roofHeight, storeys: Math.max(1, Math.round(form.size[1] / 2.8)), base, top, kind: isBoundaryForm(form) ? "wall" : "building" };
  const walls = [];
  // Right-handed face frame (tangent × up = normal): every decorator builds in it.
  const facets = body.faces.filter(f => f.kind === "wall").map((face, facetIndex) => {
    const normal = unit([face.normal[0], 0, face.normal[2]]), tangent = unit([normal[2], 0, -normal[0]]), up = [0, 1, 0];
    const us = face.points.map(p => dot(sub(p, face.points[0]), tangent)), vs = face.points.map(p => dot(sub(p, face.points[0]), up));
    const u0 = Math.min(...us), v0 = Math.min(...vs);
    return { face, facetIndex, normal: [...face.normal], tangent, up, origin: add(add(face.points[0], tangent, u0), up, v0), width: Math.max(...us) - u0, height: Math.max(...vs) - v0 };
  });
  const openingsByFacet = new Map();
  for (const opening of openings) {
    let best = null;
    for (const f of facets) {
      if (dot(opening.normal, f.normal) < .5 && form.shape !== "round") continue;
      const distance = Math.abs(dot(sub(opening.position, f.origin), f.normal));
      const u = dot(sub(opening.position, f.origin), f.tangent), v = dot(sub(opening.position, f.origin), f.up);
      if (u < -1e-3 || u > f.width + 1e-3 || v < -1e-3 || v > f.height + 1e-3) continue;
      if (!best || distance < best.distance) best = { facetIndex: f.facetIndex, distance, u, v };
    }
    if (best) {
      const list = openingsByFacet.get(best.facetIndex) ?? [];
      list.push({ id: opening.id, kind: opening.kind, head: opening.head ?? "flat", layout: opening.layout, auto: !!opening.auto, u: best.u - opening.width / 2, v: best.v - opening.height / 2, width: opening.width, height: opening.height });
      openingsByFacet.set(best.facetIndex, list);
    }
  }
  for (const f of facets) {
    const fragments = exposed(f.face, body, neighbors).map(clean).filter(p => p.length);
    if (!fragments.length) continue;
    const localOpenings = openingsByFacet.get(f.facetIndex) ?? [];
    fragments.forEach((polygon, fragIndex) => {
      const us = polygon.map(p => dot(sub(p, f.origin), f.tangent)), vs = polygon.map(p => dot(sub(p, f.origin), f.up));
      const u0 = Math.min(...us), v0 = Math.min(...vs), width = Math.max(...us) - u0, height = Math.max(...vs) - v0;
      const origin = add(add(f.origin, f.tangent, u0), f.up, v0);
      const fragmentOpenings = localOpenings.map(o => ({ ...o, u: o.u - u0, v: o.v - v0 }))
        .filter(o => o.u + o.width / 2 >= -1e-3 && o.u + o.width / 2 <= width + 1e-3 && o.v + o.height / 2 >= -1e-3 && o.v + o.height / 2 <= height + 1e-3);
      walls.push({ id: `${form.id}-wall-${f.facetIndex}${fragments.length > 1 ? `-${fragIndex}` : ""}`, formId: form.id,
        polygon: polygon.map(p => [...p]), normal: [...f.normal], tangent: [...f.tangent], up: [0, 1, 0], origin,
        width, height, exterior: true, openings: fragmentOpenings, facetIndex: f.facetIndex, facetU0: u0, facetWidth: f.width });
    });
  }
  let roof = null;
  if (form.roof === "flat") {
    const topFace = body.faces.find(f => f.kind === "top");
    const fragments = exposed(topFace, body, neighbors).map(clean).filter(p => p.length);
    roof = { id: `${form.id}-roof`, formId: form.id, kind: "flat", pitch: 0, axis, ridge: null, eaves: [], gables: [],
      slopes: fragments.map(polygon => ({ polygon: polygon.map(p => [...p]), normal: [0, 1, 0], downhill: [0, 0, 0], source: topFace.points })) };
  } else if (roofSolidResult) {
    const slopeFaces = roofSolidResult.faces.filter(f => f.kind === "roof"), gableFaces = roofSolidResult.faces.filter(f => f.kind === "wall");
    const slopes = [];
    for (const face of slopeFaces) for (const polygon of exposed(face, roofSolidResult, neighbors).map(clean).filter(p => p.length)) slopes.push({ polygon: polygon.map(p => [...p]), normal: [...face.normal], source: face.points });
    const gables = [];
    for (const face of gableFaces) for (const polygon of exposed(face, roofSolidResult, neighbors).map(clean).filter(p => p.length)) gables.push({ polygon: polygon.map(p => [...p]), normal: [...face.normal] });
    const pitch = slopeFaces.length ? Math.acos(Math.min(1, Math.max(-1, dot(slopeFaces[0].normal, [0, 1, 0])))) : 0;
    roof = { id: `${form.id}-roof`, formId: form.id, kind: form.roof, pitch, axis, slopes, gables, allSources: slopeFaces.map(f => f.points) };
  }
  const ring = getArchitectureFormFootprint(form);
  const footprint = { formId: form.id, edges: ring.map((a, i) => { const b = ring[(i + 1) % ring.length]; return { a: [a[0], 0, a[1]], b: [b[0], 0, b[1]], outward: unit([b[1] - a[1], 0, a[0] - b[0]]), groundY: base }; }) };
  return { form: record, walls, roof, footprint };
}

function compileForm(form, index, bodies, roofs, passages, manual, env) {
  const body = bodies[index], roof = roofs[index], style = env.style, palette = env.palette;
  const reach = style ? 1.8 : 0;
  const relevantBounds = { min: [body.bounds.min[0] - reach, Math.min(0, body.bounds.min[1]) - reach, body.bounds.min[2] - reach], max: (roof ? roof.bounds.max.map((n, i) => Math.max(n, body.bounds.max[i])) : body.bounds.max).map(n => n + reach) };
  const neighbors = [...bodies, ...roofs.filter(Boolean)].filter(other => other.owner !== index && overlaps(relevantBounds, other.bounds, .01));
  const paths = passages.filter(path => overlaps(relevantBounds, path.bounds));
  const authoredKey = manual.filter(opening => opening.formId === form.id);
  const key = JSON.stringify([form, neighbors.map(n => [n.owner, n.kind, n.planes]), paths.map(p => [p.pathId, p.planes]), authoredKey, env.key]);
  if (cache.has(key)) { const entry = cache.get(key); cache.delete(key); cache.set(key, entry); return { output: entry, cached: true }; }
  const output = collector(), t = style ? styledThickness(form, style) : thickness(form);
  const blocked = (point, margin = .02) => neighbors.some(other => insideSolid(other, point, margin));
  const openings = formOpenings(form, manual, env, blocked);
  const cutters = openings.map(opening => openingSolid(opening, form));
  const boundary = isBoundaryForm(form);
  const grounded = form.position[1] < .35;
  const wallShade = grounded ? p => .74 + .26 * smooth(0, 1.4, p[1] - form.position[1]) : null;
  // Round walls shade as a smooth drum, not 24 flat facets (reveal sides keep their own normal).
  const roundNormal = form.shape !== "round" ? null : (p, faceNormal) => {
    const c = Math.cos(form.rotationY), s = Math.sin(form.rotationY), dx = p[0] - form.position[0], dz = p[2] - form.position[2];
    const lx = (dx * c - dz * s) / (form.size[0] / 2) ** 2, lz = (dx * s + dz * c) / (form.size[2] / 2) ** 2;
    const n = unit([lx * c + lz * s, 0, -lx * s + lz * c]);
    return Math.abs(faceNormal[1]) < .1 && dot(n, faceNormal) > .85 ? n : faceNormal;
  };
  const massStyle = kind => {
    if (!style) return undefined;
    if (kind === "wall") return { kind: boundary ? style.boundary.kind : style.walls.kind, detail: style.detail, shade: wallShade, normalAt: roundNormal };
    if (kind === "roof") return { kind: style.roof.flatKind, detail: style.detail };
    return { kind: "plank", detail: style.detail };
  };
  const massColor = kind => {
    if (!style) return colorFor(form, kind, palette);
    if (kind === "wall") return boundary && !["plaster", "adobe", "concrete"].includes(style.boundary.kind) ? (style.boundary.kind === "log" ? palette.timber : palette.stone) : env.wallColor(form);
    if (kind === "roof") return form.roofColor ?? (style.roof.flatKind === style.walls.kind ? env.wallColor(form) : palette.stone);
    return palette.timber;
  };
  for (const face of body.faces) {
    if (face.kind === "top" && form.roof !== "flat") continue;
    let polygons = exposed(face, body, neighbors);
    if (face.kind === "wall") for (const cutter of [...cutters, ...paths]) polygons = subtractAll(polygons, cutter, face.normal);
    // The underside becomes a floor hanging below the authored base elevation.
    const kind = face.kind === "top" ? "roof" : face.kind;
    for (const polygon of polygons) emitSkin(output, kind === "floor" ? polygon.map(p => add(p, face.normal, t)) : polygon, face.normal, t, { formId: form.id, kind }, massColor(kind), kind, massStyle(kind));
  }
  // A styled pitched roof is entirely kit-built (slab + covering); its gable walls stay massing.
  if (roof) for (const face of roof.faces) {
    if (style && face.kind === "roof") continue;
    for (const polygon of exposed(face, roof, neighbors)) emitSkin(output, polygon, face.normal, Math.min(.12, t), { formId: form.id, kind: face.kind }, massColor(face.kind), face.kind, massStyle(face.kind));
  }
  if (!style && form.position[1] > .3) {
    const ring = getArchitectureFormFootprint(form), postWidth = Math.min(.35, form.size[0] / 5, form.size[2] / 5), center = form.position;
    const anchors = form.shape === "round" ? [ring[3], ring[9], ring[15], ring[21]] : ring;
    for (const anchor of anchors) {
      const point = [center[0] + (anchor[0] - center[0]) * .8, center[2] + (anchor[1] - center[2]) * .8], h = postWidth / 2;
      const post = prism([[point[0] - h, point[1] - h], [point[0] + h, point[1] - h], [point[0] + h, point[1] + h], [point[0] - h, point[1] + h]], 0, form.position[1] - t, index, "support");
      const blockers = [...bodies, ...roofs.filter(Boolean)].filter(other => other.owner !== index && overlaps(post.bounds, other.bounds));
      const postPaths = passages.filter(path => overlaps(post.bounds, path.bounds));
      for (const face of post.faces) {
        let polygons = exposed(face, post, blockers);
        for (const path of postPaths) polygons = subtractAll(polygons, path, face.normal);
        for (const polygon of polygons) emitFace(output, polygon, face.normal, { formId: form.id, kind: "support" }, colorFor(form, "support", palette), "support");
      }
      supportCutCaps(output, post, [...blockers, ...postPaths], form, palette);
    }
  }
  if (style) {
    const description = describeForm(form, index, body, roof, neighbors, openings);
    const stacked = form.position[1] > .35 && neighbors.some(other => other.kind !== "roof" && insideSolid(other, [form.position[0], form.position[1] - .15, form.position[2]], 0));
    description.form.storeys = Math.max(1, Math.round(form.size[1] / style.walls.storey));
    description.form.stacked = stacked;
    const kit = new KitMesh({ layerOf: layerIndexFor, repeatOf: styleTileMetres });
    const rng = createRng(hashString(`${env.seed}:${form.id}`));
    const ctx = {
      kit, style, rng, form: description.form, walls: description.walls, roof: description.roof, thickness: t,
      detail: style.detail, stylized: style.family === "stylized", isBoundary: boundary, boundaryEnds: env.ends, draft: !!env.draft,
      roofKind: form.roof, roundKind: form.roof === "dome" ? "dome" : "cone",
      blocked, pathBlocked: (x, z) => passages.some(p => pointInConvex2([x, z], ccw2(p.ring), .25)),
      color: role => role === "wall" ? env.wallColor(form) : role === "roof" ? (form.roofColor ?? palette.roof) : palette[role] ?? "#cccccc",
      pick: role => { const choices = style.palette[role] ?? [palette[role]]; return choices[hashString(`${env.seed}:${form.id}:${role}`) % choices.length]; },
      vary: amount => 1 + (rng.next() * 2 - 1) * amount * (.45 + .55 * style.detail),
    };
    kit.set({ formId: form.id, surface: "wall-detail" });
    decorateWalls(ctx);
    kit.set({ material: "surface", formId: form.id, surface: "wall-detail" });
    decorateOpenings(ctx);
    kit.set({ material: "surface", formId: form.id, surface: "roof-detail" });
    decorateRoof(ctx);
    appendKit(output, kit);
  }
  const vertexCount = output.position.length / 3;
  if (vertexCount <= CACHE_LIMIT) {
    cache.set(key, output); cachedVertices += vertexCount;
    while (cache.size > 384 || cachedVertices > CACHE_LIMIT) { const oldest = cache.keys().next().value; cachedVertices -= cache.get(oldest).position.length / 3; cache.delete(oldest); }
  }
  return { output, cached: false };
}

function appendKit(output, kit) {
  for (const bucket of kit.buckets.values()) {
    const count = bucket.position.length / 3;
    if (!count) continue;
    const vertexOffset = output.position.length / 3, start = output.index.length;
    if (vertexOffset + count > MAX_VERTICES) throw new Error("Architecture geometry exceeded 2,000,000 vertices. Simplify the model.");
    for (const n of bucket.position) output.position.push(n);
    for (const n of bucket.normal) output.normal.push(n);
    for (const n of bucket.uv) output.uv.push(n);
    for (const n of bucket.layer) output.styleLayer.push(n);
    for (const n of bucket.tint) output.styleTint.push(n);
    for (let i = 0; i < count; i++) output.index.push(vertexOffset + i);
    output.groups.push({ start, count, materialIndex: materialIndex(output, null, bucket.material, true) });
    output.surfaces.push({ start, count, formId: bucket.formId, kind: bucket.surface === "roof" ? "roof" : bucket.surface, styled: true, detail: true, normal: [0, 1, 0], face: bucket.surface });
  }
}

function append(output, source) {
  const vertexOffset = output.position.length / 3, indexOffset = output.index.length;
  if (vertexOffset + source.position.length / 3 > MAX_VERTICES) throw new Error("Architecture geometry exceeded 2,000,000 vertices. Simplify the model.");
  for (const n of source.position) output.position.push(n);
  for (const n of source.normal) output.normal.push(n);
  for (const n of source.uv) output.uv.push(n);
  for (const n of source.styleLayer) output.styleLayer.push(n);
  for (const n of source.styleTint) output.styleTint.push(n);
  for (const n of source.index) output.index.push(n + vertexOffset);
  const materials = source.descriptors.map(descriptor => materialIndex(output, descriptor.color, descriptor.role, !!descriptor.styled));
  for (const group of source.groups) output.groups.push({ start: group.start + indexOffset, count: group.count, materialIndex: materials[group.materialIndex] });
  for (const surface of source.surfaces) output.surfaces.push({ ...surface, start: surface.start + indexOffset });
}

/** Everything a model's forms share while compiling: resolved style, palette, auto-door owners
 * (one entrance per connected building) and free-standing wall joints (one pillar per joint). */
function modelEnvironment(model, forms, bodies) {
  const style = model.style ? resolveStyle(model.style.id, model.style.params) : null;
  const seed = model.style?.seed ?? 0;
  const palette = style ? { ...paletteAt(style, paletteIndexFor(style, seed)), ...(model.style.palette || {}), ...(model.style.params?.wall ? { wall: model.style.params.wall } : {}), ...(model.style.params?.roof ? { roof: model.style.params.roof } : {}), ...(model.style.params?.trim ? { trim: model.style.params.trim } : {}) } : null;
  const doors = new Set(), ends = forms.map(() => [true, true]);
  if (style) {
    const parent = forms.map((_, i) => i), find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < forms.length; i++) for (let j = i + 1; j < forms.length; j++) {
      if (isBoundaryForm(forms[i]) || isBoundaryForm(forms[j])) continue;
      if (overlaps(bodies[i].bounds, bodies[j].bounds, .05)) parent[find(i)] = find(j);
    }
    const authoredDoor = new Set(model.openings.filter(o => o.kind === "door").map(o => find(forms.findIndex(f => f.id === o.formId))));
    const best = new Map();
    forms.forEach((form, i) => {
      if (isBoundaryForm(form) || !form.windows || form.position[1] >= .35 || form.size[1] < 2.3) return;
      const root = find(i);
      if (authoredDoor.has(root)) return;
      const score = form.size[0] * form.size[2];
      if (!best.has(root) || score > best.get(root).score) best.set(root, { index: i, score });
    });
    for (const { index } of best.values()) doors.add(index);
    const endpoints = forms.map(form => {
      if (!isBoundaryForm(form)) return null;
      const c = Math.cos(form.rotationY), s = Math.sin(form.rotationY), h = form.size[0] / 2;
      return [[form.position[0] - h * c, form.position[2] + h * s], [form.position[0] + h * c, form.position[2] - h * s]];
    });
    endpoints.forEach((pair, i) => {
      if (!pair) return;
      pair.forEach((p, k) => {
        for (let j = 0; j < i; j++) if (endpoints[j]?.some(q => Math.hypot(q[0] - p[0], q[1] - p[1]) < Math.max(forms[i].size[2], forms[j].size[2]) * 1.5)) { ends[i][k] = false; break; }
      });
    });
  }
  const wallColor = form => {
    if (!style) return form.color;
    if (form.color !== DEFAULT_FORM_COLOR) return form.color;
    if (style.walls.colorPerForm) { const list = style.palette.wall; return list[hashString(`${seed}:${form.id}`) % list.length]; }
    return palette.wall;
  };
  const key = style ? JSON.stringify([model.style, palette]) : "";
  return { style, seed, palette, doors, ends, wallColor, key };
}

/**
 * Pure architectural description of a compiled model: face frames, openings in each face's own
 * coordinates, roof slopes and the ground footprint. Recomputes bodies/roofs itself and never
 * touches the geometry cache.
 */
export function describeBuilding(model, opts = {}) {
  const normalized = normalizeArchitectureModel(model);
  const style = normalized.style ? resolveStyle(normalized.style.id, normalized.style.params) : null;
  const forms = normalized.forms.map(form => resolveArchitectureForm(form, style));
  const bodies = forms.map((form, i) => prism(getArchitectureFormFootprint(form), form.position[1], form.position[1] + form.size[1], i));
  const roofs = forms.map(roofSolid);
  const env = modelEnvironment(normalized, forms, bodies);
  const out = { forms: [], walls: [], roofs: [], footprint: [], seed: Number.isFinite(opts?.seed) ? opts.seed : 0 };
  forms.forEach((form, i) => {
    const body = bodies[i], roof = roofs[i];
    const relevantBounds = { min: [body.bounds.min[0], Math.min(0, body.bounds.min[1]), body.bounds.min[2]], max: roof ? roof.bounds.max.map((n, k) => Math.max(n, body.bounds.max[k])) : body.bounds.max };
    const neighbors = [...bodies, ...roofs.filter(Boolean)].filter(other => other.owner !== i && overlaps(relevantBounds, other.bounds, .01));
    const blocked = (point, margin = .02) => neighbors.some(other => insideSolid(other, point, margin));
    const openings = formOpenings(form, normalized.openings, { ...env, door: env.doors.has(i) }, blocked);
    const d = describeForm(form, i, body, roof, neighbors, openings);
    out.forms.push(d.form); out.walls.push(...d.walls); if (d.roof) out.roofs.push(d.roof); out.footprint.push(d.footprint);
  });
  return out;
}

/** `options.draft` builds the silhouette-defining kit only (slabs, overhangs, frames, caps) and skips
 * coverings, stone courses, cladding and small props — the fast path for live drags. */
export function buildArchitectureFormGeometry(input, options = {}) {
  const model = normalizeArchitectureModel(input), output = collector();
  const preStyle = model.style ? resolveStyle(model.style.id, model.style.params) : null;
  const forms = model.forms.map(form => resolveArchitectureForm(form, preStyle));
  const bodies = forms.map((form, i) => prism(getArchitectureFormFootprint(form), form.position[1], form.position[1] + form.size[1], i));
  const roofs = forms.map(roofSolid), passages = pathSegments(model.paths); let reusedForms = 0;
  const env = modelEnvironment(model, forms, bodies);
  for (let i = 0; i < forms.length; i++) {
    const formEnv = { ...env, draft: !!options.draft, door: env.doors.has(i), ends: env.ends[i], key: `${env.key}|${env.doors.has(i)}|${env.ends[i]}|${!!options.draft}` };
    const compiled = compileForm(forms[i], i, bodies, roofs, passages, model.openings, formEnv);
    append(output, compiled.output); if (compiled.cached) reusedForms++;
  }
  for (let index = 0; index < passages.length; index++) {
    const path = passages[index], top = { points: path.ring.map(([x, z]) => [x, path.elevation + .015, z]), normal: [0, 1, 0] };
    let polygons = [top.points];
    for (let prior = 0; prior < index; prior++) if (Math.abs(passages[prior].elevation - path.elevation) < .001 && overlaps(path.bounds, passages[prior].bounds)) polygons = subtractAll(polygons, passages[prior], top.normal);
    const styled = env.style ? { kind: env.style.path.kind, detail: env.style.detail } : undefined;
    for (const polygon of polygons) emitSkin(output, polygon, top.normal, .08, { formId: null, pathId: path.pathId, kind: "path" }, env.style ? env.palette.stone : "#b7a48b", "path", styled);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(output.position, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(output.normal, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(output.uv, 2));
  // Every vertex carries these (one attribute layout): layer into the shared surface arrays and
  // tint = linear colour × shade × AO in rgb, texture detail strength in a.
  geometry.setAttribute("styleLayer", new THREE.Float32BufferAttribute(output.styleLayer, 1));
  geometry.setAttribute("styleTint", new THREE.Float32BufferAttribute(output.styleTint, 4));
  // Batch the entire town by material. Picking ranges are reordered together
  // with their triangles, so faceIndex attribution survives this draw-call cut.
  const ordered = output.groups.map((group, i) => ({ group, surface: output.surfaces[i] })).sort((a, b) => a.group.materialIndex - b.group.materialIndex);
  const vertexTotal = output.position.length / 3;
  const indices = vertexTotal > 65535 ? new Uint32Array(output.index.length) : new Uint16Array(output.index.length);
  const surfaces = [];
  let cursor = 0;
  for (const { group, surface } of ordered) {
    const start = cursor;
    for (let i = group.start; i < group.start + group.count; i++) indices[cursor++] = output.index[i];
    surfaces.push({ ...surface, start, normal: [...surface.normal] });
    const last = geometry.groups.at(-1);
    if (last && last.materialIndex === group.materialIndex) last.count += group.count;
    else geometry.addGroup(start, group.count, group.materialIndex);
  }
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  if (output.position.length) { geometry.computeBoundingBox(); geometry.computeBoundingSphere(); }
  else { geometry.boundingBox = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3()); geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0); }
  geometry.userData.architectureSurfaceRanges = surfaces;
  return { geometry, materials: output.descriptors, surfaces,
    stats: { forms: model.forms.length, paths: model.paths.length, vertices: vertexTotal, triangles: output.index.length / 3, reusedForms } };
}
