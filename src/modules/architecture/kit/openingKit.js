/** Windows, doors and arches: surrounds, lintels, sills, recessed glazing with casements and
 * mullions, shutters, flower boxes, planked or panelled door leaves, steps and canopies. All sized
 * from the opening record and drawn inside the wall's face frame (x along the facade, y up,
 * z outward; the wall's inner face is at z = -thickness). */
import { frame, toWorld, v3, clipPolygon2, ccw2 } from "./kitMesh.js";
import { openingOutline, headY, headRise } from "./openingShape.js";

export function decorateOpenings(ctx) {
  for (const w of ctx.walls) {
    const f = frame(w.origin, w.tangent, [0, 1, 0], w.normal);
    for (const o of w.openings ?? []) {
      if (o.kind === "door") door(ctx, f, w, o);
      else if (o.kind === "arch") archSurround(ctx, f, o, ctx.style.walls.kind === "stone" ? "stone" : "stone", .22);
      else window(ctx, f, w, o);
    }
  }
}

const shift = (pts, dx, dy) => pts.map(([x, y]) => [x + dx, y + dy]);
function inset(pts, d) {
  const c = pts.reduce((s, p) => [s[0] + p[0] / pts.length, s[1] + p[1] / pts.length], [0, 0]);
  return pts.map(([x, y]) => { const dx = x - c[0], dy = y - c[1], l = Math.hypot(dx, dy) || 1; return [x - dx / l * d, y - dy / l * d]; });
}

function frameRole(ctx, type) {
  const { kit } = ctx;
  if (type === "stone") kit.set({ material: "surface", kind: "stone", color: ctx.color("stone"), detail: ctx.detail });
  else if (type === "metal") kit.set({ material: "metal", kind: "metal", color: ctx.color("metal"), detail: ctx.detail * .4 });
  else if (type === "trim") kit.set({ material: "surface", kind: "timber", color: ctx.color("trim"), detail: ctx.detail * .35 });
  else kit.set({ material: "surface", kind: "timber", color: ctx.color("timber"), detail: ctx.detail });
}

/** Band that follows the opening's outline (jambs + head) outside the hole. */
function surround(ctx, f, o, type, width, proud) {
  const { kit } = ctx;
  const head = o.head ?? "flat", rise = headRise(o.width, o.height, head), spring = o.height - rise;
  frameRole(ctx, type);
  const stone = type === "stone";
  kit.set({ shade: ctx.vary(.05) });
  kit.box(f, o.u - width, o.u, o.v - (stone ? .02 : 0), o.v + spring, -.03, proud, { bevel: .015, skip: { "-z": true } });
  kit.set({ shade: ctx.vary(.05) });
  kit.box(f, o.u + o.width, o.u + o.width + width, o.v - (stone ? .02 : 0), o.v + spring, -.03, proud, { bevel: .015, skip: { "-z": true } });
  if (!rise) { kit.box(f, o.u - width, o.u + o.width + width, o.v + o.height, o.v + o.height + width, -.03, proud, { bevel: .015, skip: { "-z": true } }); return; }
  archSurround(ctx, f, o, type, width, proud);
}

function archSurround(ctx, f, o, type, width, proud = .05) {
  const { kit } = ctx, head = o.kind === "arch" && (!o.head || o.head === "flat") ? "round" : o.head ?? "round";
  const rise = headRise(o.width, o.height, head), spring = o.height - rise;
  if (!rise) return;
  frameRole(ctx, type);
  const count = type === "stone" ? Math.max(5, Math.round(o.width * 4.5) | 1) : 8;
  const cx = o.width / 2, pointAt = t => { const x = t * o.width; return [x, headY(o.width, o.height, head, x)]; };
  const normalAt = t => { const a = pointAt(Math.max(0, t - .01)), b = pointAt(Math.min(1, t + .01)); const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [-dy / l, dx / l]; };
  for (let i = 0; i < count; i++) {
    const t0 = i / count, t1 = (i + 1) / count, gap = type === "stone" ? .006 : 0;
    const p0 = pointAt(t0 + gap), p1 = pointAt(t1 - gap), n0 = normalAt(t0 + gap), n1 = normalAt(t1 - gap);
    const key = type === "stone" && i === (count - 1) / 2 ? 1.25 : 1;
    const q0 = [p0[0] + n0[0] * width * key, p0[1] + n0[1] * width * key], q1 = [p1[0] + n1[0] * width * key, p1[1] + n1[1] * width * key];
    const pts = ccw2([p0, p1, q1, q0].map(([x, y]) => [o.u + x, o.v + y]));
    kit.set({ shade: ctx.vary(type === "stone" ? .1 : .03) });
    kit.extrude(f, pts, -.03, proud * key, { back: false });
  }
  if (spring < o.height) {
    kit.set({ shade: ctx.vary(.05) });
    // Imposts where the arch springs, so the band reads as carried by the jambs.
    if (type === "stone") for (const x of [o.u - width * 1.1, o.u + o.width]) kit.box(f, x, x + width * 1.1, o.v + spring - .1, o.v + spring, -.03, proud + .02, { bevel: .012, skip: { "-z": true } });
  }
  void cx;
}

function glazing(ctx, f, o, recess, mullions, glassKind) {
  const { kit } = ctx, head = o.head ?? "flat";
  const outline = shift(openingOutline(o.width, o.height, head, 10), o.u, o.v);
  const pane = inset(outline, .015);
  const paper = glassKind === "paper";
  kit.set({ material: paper ? "surface" : "glass", kind: "plaster", color: ctx.color("glass"), shade: 1, detail: paper ? .15 : 0 });
  kit.extrude(f, pane, -recess - .03, -recess, { sides: false, back: false });
  // Casement ring and bars share the frame colour; they sit at the glass plane, never proud.
  const barType = ctx.style.openings.window.frame === "metal" ? "metal" : ctx.style.openings.window.frame === "timber" ? "timber" : "trim";
  frameRole(ctx, barType);
  const bw = barType === "metal" ? .045 : .06, z0 = -recess - .01, z1 = -recess + .045;
  for (let i = 0; i < pane.length; i++) {
    const a = pane[i], b = pane[(i + 1) % pane.length], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
    if (l < .02) continue;
    const nx = -dy / l * bw, ny = dx / l * bw; // CCW outline: left normal points inward
    kit.extrude(f, ccw2([a, b, [b[0] + nx, b[1] + ny], [a[0] + nx, a[1] + ny]]), z0, z1, { back: false });
  }
  const bars = [];
  const cx = o.u + o.width / 2, spring = o.v + o.height - headRise(o.width, o.height, head);
  const vertical = x => bars.push([[x - bw * .4, o.v], [x + bw * .4, o.v], [x + bw * .4, o.v + o.height + 1], [x - bw * .4, o.v + o.height + 1]]);
  const horizontal = y => bars.push([[o.u, y - bw * .4], [o.u + o.width, y - bw * .4], [o.u + o.width, y + bw * .4], [o.u, y + bw * .4]]);
  if (mullions === "cross") { vertical(cx); horizontal(Math.min(spring, o.v + o.height * .62)); }
  else if (mullions === "vertical") { const n = Math.max(1, Math.round(o.width / .55)); for (let i = 1; i < n; i++) vertical(o.u + o.width * i / n); if (n === 1 && o.width > .5) vertical(cx); }
  else if (mullions === "sash") { horizontal(o.v + o.height * .52); vertical(cx); }
  else if (mullions === "grid") {
    const cols = Math.max(2, Math.round(o.width / (paper ? .28 : .36))), rows = Math.max(2, Math.round(o.height / (paper ? .3 : .38)));
    for (let i = 1; i < cols; i++) vertical(o.u + o.width * i / cols);
    for (let j = 1; j < rows; j++) horizontal(o.v + o.height * j / rows);
  }
  const clipper = ccw2(pane);
  for (const bar of bars) { const piece = clipPolygon2(bar, clipper); if (piece.length) kit.extrude(f, piece, z0, z1 - .01, { back: false }); }
}

function window(ctx, f, w, o) {
  const { kit, style, rng } = ctx, S = style.openings.window, T = ctx.thickness;
  const layout = o.layout ?? S.layout;
  if (layout === "slit") {
    frameRole(ctx, "stone");
    const wd = .22;
    kit.set({ shade: ctx.vary(.06) });
    kit.box(f, o.u - wd, o.u, o.v - wd, o.v + o.height + wd, -.03, .06, { bevel: .02, skip: { "-z": true } });
    kit.box(f, o.u + o.width, o.u + o.width + wd, o.v - wd, o.v + o.height + wd, -.03, .06, { bevel: .02, skip: { "-z": true } });
    kit.box(f, o.u, o.u + o.width, o.v + o.height, o.v + o.height + wd, -.03, .06, { bevel: .02, skip: { "-z": true } });
    kit.box(f, o.u, o.u + o.width, o.v - wd, o.v, -.03, .06, { bevel: .02, skip: { "-z": true } });
    kit.set({ material: "glass", kind: "plaster", color: "#0b0c0d", shade: 1, detail: 0 });
    kit.box(f, o.u, o.u + o.width, o.v, o.v + o.height, -T * .8 - .02, -T * .8);
    kit.set({ material: "surface" });
    return;
  }
  const recess = Math.min(T * .55, .24);
  const frameType = S.frame, fw = S.frameWidth;
  const ribbon = layout === "ribbon";
  if (frameType !== "none") {
    if (S.lintel !== "none" && (o.head ?? "flat") === "flat") {
      frameRole(ctx, S.lintel === "stone" ? "stone" : "timber");
      kit.set({ shade: ctx.vary(.06) });
      kit.box(f, o.u - .16, o.u + o.width + .16, o.v + o.height, o.v + o.height + .24, -.03, .06, { bevel: .02, skip: { "-z": true } });
      const jamb = { ...o, height: o.height };
      frameRole(ctx, frameType);
      kit.box(f, jamb.u - fw, jamb.u, jamb.v, jamb.v + jamb.height, -.03, .035, { bevel: .01, skip: { "-z": true } });
      kit.box(f, jamb.u + jamb.width, jamb.u + jamb.width + fw, jamb.v, jamb.v + jamb.height, -.03, .035, { bevel: .01, skip: { "-z": true } });
    } else surround(ctx, f, o, frameType, ribbon ? fw * .8 : fw, ribbon ? .02 : .045);
  } else if (S.lintel !== "none") {
    frameRole(ctx, S.lintel === "stone" ? "stone" : "timber");
    kit.box(f, o.u - .16, o.u + o.width + .16, o.v + o.height, o.v + o.height + .22, -.03, .06, { bevel: .02, skip: { "-z": true } });
  }
  if (S.sillType !== "none") {
    frameRole(ctx, S.sillType === "stone" ? "stone" : S.sillType === "trim" ? "trim" : "timber");
    kit.set({ shade: ctx.vary(.05) });
    kit.box(f, o.u - .12, o.u + o.width + .12, o.v - .09, o.v + .005, -recess, .13, { bevel: .018 });
  }
  glazing(ctx, f, o, recess, S.mullions, S.glass);
  if (ribbon) return;
  // Shutters hinge open against the wall when there is room beside the frame.
  const curved = ctx.form.shape === "round";
  if (S.shutters > 0 && !curved && !ctx.draft && rng.chance(S.shutters) && o.kind === "window") {
    const spring = o.height - headRise(o.width, o.height, o.head ?? "flat");
    const leafW = o.width / 2 + .02, leafH = Math.max(.5, spring);
    const others = (w.openings ?? []).filter(x => x !== o);
    const room = side => {
      const edge = side < 0 ? o.u - fw : o.u + o.width + fw;
      const limit = side < 0 ? others.filter(x => x.u + x.width <= o.u).reduce((m, x) => Math.max(m, x.u + x.width + .2), 0) : others.filter(x => x.u >= o.u + o.width).reduce((m, x) => Math.min(m, x.u - .2), w.width);
      return side < 0 ? edge - limit : limit - edge;
    };
    const color = ctx.pick("shutter");
    for (const side of [-1, 1]) {
      if (room(side) < leafW + .05) continue;
      const x0 = side < 0 ? o.u - fw - leafW : o.u + o.width + fw, x1 = x0 + leafW;
      if (ctx.blocked(toWorld(f, (x0 + x1) / 2, o.v + leafH / 2, .1))) continue;
      kit.set({ material: "surface", kind: "plank", color, detail: ctx.detail * .6 });
      if (S.shutterType === "louvre") {
        kit.set({ shade: ctx.vary(.03) });
        kit.box(f, x0, x0 + .06, o.v, o.v + leafH, .02, .07, { skip: { "-z": true } });
        kit.box(f, x1 - .06, x1, o.v, o.v + leafH, .02, .07, { skip: { "-z": true } });
        kit.box(f, x0, x1, o.v, o.v + .07, .02, .07, { skip: { "-z": true } });
        kit.box(f, x0, x1, o.v + leafH - .07, o.v + leafH, .02, .07, { skip: { "-z": true } });
        for (let y = o.v + .1; y < o.v + leafH - .1; y += .085) {
          const g = { o: toWorld(f, x0 + .06, 0, 0), t: f.u, u: f.n, n: f.t };
          kit.extrude(g, [[y, .02], [y + .02, .02], [y + .075, .06], [y + .055, .06]], 0, leafW - .12, { back: false });
        }
      } else {
        const boards = 3, bw = leafW / boards;
        for (let i = 0; i < boards; i++) {
          kit.set({ shade: ctx.vary(.07) });
          kit.box(f, x0 + i * bw + .006, x0 + (i + 1) * bw - .006, o.v, o.v + leafH, .02, .055, { bevel: .006, skip: { "-z": true } });
        }
        kit.set({ shade: ctx.vary(.05) * .92 });
        for (const y of [o.v + leafH * .2, o.v + leafH * .8]) kit.box(f, x0 + .03, x1 - .03, y - .05, y + .05, .055, .08, { skip: { "-z": true } });
      }
      if (!ctx.stylized) {
        kit.set({ material: "metal", kind: "metal", color: ctx.color("metal"), shade: 1, detail: .3 });
        for (const y of [o.v + leafH * .2, o.v + leafH * .8]) kit.box(f, side < 0 ? x1 - .2 : x0, side < 0 ? x1 : x0 + .2, y - .02, y + .02, .08, .095, { skip: { "-z": true } });
        kit.set({ material: "surface" });
      }
    }
  }
  if (S.flowerBox > 0 && !curved && !ctx.draft && o.v > .7 && rng.chance(S.flowerBox)) flowerBox(ctx, f, o);
}

function flowerBox(ctx, f, o) {
  const { kit, rng } = ctx, y = o.v - (ctx.style.openings.window.sillType === "none" ? .02 : .1);
  if (ctx.blocked(toWorld(f, o.u + o.width / 2, y - .15, .15))) return;
  kit.set({ material: "surface", kind: "plank", color: ctx.color("timber"), shade: ctx.vary(.05), detail: ctx.detail * .6 });
  kit.box(f, o.u - .06, o.u + o.width + .06, y - .28, y - .04, .01, .27, { bevel: .02, skip: { "-z": true } });
  const greens = ["#4f7a3a", "#5c8a40", "#44692f", "#6a9447"];
  const count = Math.max(4, Math.round(o.width * 6));
  for (let i = 0; i < count; i++) {
    const x = o.u + (i + .5) / count * o.width + (rng.next() - .5) * .08;
    const p = toWorld(f, x, y + .02 + rng.next() * .06, .14 + (rng.next() - .5) * .08);
    kit.set({ kind: "plaster", color: greens[i % greens.length], shade: ctx.vary(.12), detail: 0 });
    kit.blob(p, [.1 + rng.next() * .05, .08 + rng.next() * .05, .1 + rng.next() * .05], 6, 3);
    if (rng.chance(.7)) {
      kit.set({ color: ctx.pick("accent"), shade: ctx.vary(.06) });
      kit.blob(v3.add(p, [(rng.next() - .5) * .08, .09, (rng.next() - .5) * .08]), [.045, .035, .045], 5, 2);
    }
  }
}

function door(ctx, f, w, o) {
  const { kit, style, rng } = ctx, S = style.openings.door, T = ctx.thickness;
  const head = o.head ?? S.head, oo = { ...o, head };
  const recess = Math.min(T * .5, .22);
  if (S.frame !== "none") surround(ctx, f, oo, S.frame, S.frame === "stone" ? .2 : .1, S.frame === "stone" ? .06 : .045);
  const outline = shift(openingOutline(o.width, o.height, head, 12), o.u, o.v);
  const top = x => o.v + headY(o.width, o.height, head, x - o.u);
  if (S.leaf === "glass") {
    glazing(ctx, f, oo, recess, "vertical", "tinted");
  } else if (S.leaf === "panel") {
    kit.set({ material: "surface", kind: "plank", color: ctx.pick("door"), shade: 1, detail: ctx.detail * .5 });
    kit.extrude(f, ccw2(outline), -recess - .06, -recess, { back: false });
    const cols = o.width > 1.4 ? 2 : 1, rows = 2, pad = .12;
    const spring = o.height - headRise(o.width, o.height, head);
    const pw = (o.width - pad * (cols + 1)) / cols, ph = (spring - pad * (rows + 1)) / rows;
    for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) {
      const x0 = o.u + pad + c * (pw + pad), y0 = o.v + pad + r * (ph + pad);
      kit.set({ shade: 1.05 });
      kit.box(f, x0, x0 + pw, y0, y0 + ph, -recess, -recess + .025, { bevel: .012, skip: { "-z": true } });
    }
  } else {
    const boards = Math.max(3, Math.round(o.width / .17)), bw = o.width / boards;
    const color = ctx.pick("door");
    kit.set({ material: "surface", kind: "plank", color, detail: ctx.detail * .8 });
    for (let i = 0; i < boards; i++) {
      const x0 = o.u + i * bw + .004, x1 = o.u + (i + 1) * bw - .004;
      kit.set({ shade: ctx.vary(.09) });
      kit.extrude(f, ccw2([[x0, o.v], [x1, o.v], [x1, top(x1) - .005], [x0, top(x0) - .005]]), -recess - .06, -recess - rng.next() * .012, { back: false });
    }
    kit.set({ material: "metal", kind: "metal", color: ctx.color("metal"), shade: 1, detail: .3 });
    for (const y of [o.v + .35, o.v + Math.min(o.height - .45, 1.7)]) kit.box(f, o.u + .05, o.u + o.width * .72, y - .035, y + .035, -recess - .005, -recess + .01, { skip: { "-z": true } });
    kit.box(f, o.u + o.width * .8, o.u + o.width * .84, o.v + .95, o.v + 1.12, -recess, -recess + .05);
  }
  kit.set({ material: "surface" });
  const grounded = Math.abs(w.origin[1] + o.v - ctx.form.base) < .08 && ctx.form.base < .35;
  if (S.step && grounded) {
    kit.set({ kind: "stone", color: ctx.color("stone"), shade: ctx.vary(.06), detail: ctx.detail });
    kit.box(f, o.u - .22, o.u + o.width + .22, o.v - .12, o.v + .03, -recess, .42, { bevel: .03 });
  }
  if (S.canopy > 0 && rng.chance(S.canopy) && !ctx.blocked(toWorld(f, o.u + o.width / 2, o.v + o.height + .6, .5))) canopy(ctx, f, o);
}

function canopy(ctx, f, o) {
  const { kit } = ctx;
  const x0 = o.u - .45, x1 = o.u + o.width + .45, xm = (x0 + x1) / 2, ye = o.v + o.height + .38, yr = ye + (x1 - x0) * .32, depth = 1;
  kit.set({ kind: ctx.style.roof.kind === "thatch" ? "shingles" : ctx.style.roof.kind, color: ctx.color("roof"), shade: ctx.vary(.04), detail: ctx.detail });
  for (const [a, b] of [[x0, xm], [x1, xm]]) {
    const pts = [toWorld(f, a, ye, 0), toWorld(f, b, yr, 0), toWorld(f, b, yr, depth), toWorld(f, a, ye, depth)];
    const n = v3.norm(v3.cross(v3.sub(pts[1], pts[0]), v3.sub(pts[3], pts[0])));
    kit.slab(pts, n[1] < 0 ? v3.mul(n, -1) : n, .09);
  }
  kit.set({ kind: "timber", color: ctx.color("timber"), shade: ctx.vary(.05), detail: ctx.detail });
  for (const x of [x0 + .12, x1 - .12]) kit.beam(toWorld(f, x, ye - .75, .02), toWorld(f, x, ye - .02, depth * .8), .1, .1, f.t, { bevel: .01 });
}
