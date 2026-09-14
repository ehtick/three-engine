/** Wall construction for one form: plinth, corners, cladding, timber framing, storey bands, crown,
 * flat-roof edges (parapet / battlements / coping), free-standing wall caps and the supports under
 * raised forms. Every piece is built in its wall fragment's right-handed face frame
 * (x along the facade, y up, z outward) and skipped when its anchor lies inside a neighbouring
 * form, so junctions never sprout trim inside another building. */
import { frame, toWorld, dirWorld, v3 } from "./kitMesh.js";

const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Ranges of [x0, x1] not covered by an opening whose vertical span meets [y0, y1]. */
export function freeSpans(x0, x1, y0, y1, openings, pad = .02) {
  const blockers = openings.filter(o => o.v < y1 - 1e-4 && o.v + o.height > y0 + 1e-4)
    .map(o => [o.u - pad, o.u + o.width + pad]).sort((a, b) => a[0] - b[0]);
  const spans = []; let cursor = x0;
  for (const [a, b] of blockers) { if (a > cursor + 1e-4) spans.push([cursor, Math.min(a, x1)]); cursor = Math.max(cursor, b); if (cursor >= x1) break; }
  if (cursor < x1 - 1e-4) spans.push([cursor, x1]);
  return spans.filter(([a, b]) => b - a > .04);
}

function groundAO(ctx) {
  const base = ctx.form.base;
  return base < .35 ? p => .7 + .3 * smooth(0, 1.3, p[1] - base) : null;
}

export function decorateWalls(ctx) {
  const { kit } = ctx;
  kit.ao = groundAO(ctx);
  if (ctx.isBoundary) boundaryWall(ctx);
  else {
    for (const wall of ctx.walls) decorateWall(ctx, wall);
    if (ctx.form.base > .35 && !ctx.form.stacked) supports(ctx);
  }
  kit.ao = null;
}

function wallFrame(w) { return frame(w.origin, w.tangent, [0, 1, 0], w.normal); }

function decorateWall(ctx, w) {
  const { kit, style, form, rng } = ctx;
  const f = wallFrame(w), W = w.width, H = w.height, T = ctx.thickness, S = style.walls;
  const round = form.shape === "round";
  const bottomY = w.origin[1];
  const grounded = Math.abs(bottomY - form.base) < .03 && form.base < .35;
  const reachesTop = Math.abs(bottomY + H - form.top) < .03;
  // A corner is only free (quoins, posts, extended cornices) when nothing abuts just past it.
  const freeCorner = u => ![.15, .5, .9].some(k => ctx.blocked(toWorld(f, u, H * k, -T * .5), .01));
  const cornerStart = !round && Math.abs(w.facetU0) < .03 && freeCorner(-.25), cornerEnd = !round && Math.abs(w.facetU0 + W - w.facetWidth) < .03 && freeCorner(W + .25);
  const openings = w.openings ?? [];
  const probe = (x, y, z = .12) => ctx.blocked(toWorld(f, x, y, z));
  const storeyH = form.size[1] / Math.max(1, form.storeys);
  const levels = [];
  for (let k = 1; k < form.storeys; k++) { const y = form.base + k * storeyH - bottomY; if (y > .3 && y < H - .3) levels.push(y); }
  const flatTop = reachesTop && ctx.roofKind === "flat";
  const crownDrop = reachesTop && !flatTop && S.crown === "cornice" ? .36 : reachesTop && S.crown === "beam" ? .24 : 0;

  // ---- plinth -------------------------------------------------------------------------------
  let plinthTop = 0;
  if (grounded && S.plinth.type !== "none" && S.cladding !== "logs") {
    plinthTop = Math.min(S.plinth.height, H * .35);
    const e0 = cornerStart ? .07 : 0, e1 = cornerEnd ? .07 : 0;
    if (S.plinth.type === "stones" && !ctx.draft) stoneCourses(ctx, f, -e0, W + e1, 0, plinthTop, openings, { kind: S.plinth.kind, color: ctx.color("stone"), big: ctx.stylized, probe });
    else {
      kit.set({ kind: S.plinth.kind, color: ctx.color("stone"), shade: ctx.vary(.05), detail: ctx.detail });
      for (const [a, b] of freeSpans(-e0, W + e1, 0, plinthTop, openings)) if (!probe((a + b) / 2, plinthTop / 2)) kit.box(f, a, b, -.03, plinthTop, -.02, .07, { bevel: .025, skip: { "-z": true, "-y": true } });
    }
  }

  // ---- cladding ------------------------------------------------------------------------------
  if (ctx.draft) { /* cladding lands on release */ }
  else if (S.cladding === "clapboard") clapboard(ctx, f, W, plinthTop, H - crownDrop, openings, probe);
  else if (S.cladding === "logs") logCourses(ctx, f, w, W, H, openings, cornerStart, cornerEnd, probe);
  else if (S.cladding === "panels") panels(ctx, f, W, plinthTop, H - crownDrop, openings, storeyH);

  // ---- timber framing --------------------------------------------------------------------------
  if (S.framing && !round && W > .9) framing(ctx, f, W, H, plinthTop, crownDrop, levels, openings, cornerStart, cornerEnd, probe);

  // ---- corners ---------------------------------------------------------------------------------
  const cornerTop = H - (flatTop ? 0 : crownDrop);
  for (const [isCorner, side] of [[cornerStart, 0], [cornerEnd, 1]]) {
    if (!isCorner) continue;
    const x = side ? W : 0, dir = side ? -1 : 1;
    const probeXs = S.corners === "buttress" ? [-.27, 0, .27].map(o => (side ? W - .45 : .45) + o) : [x + dir * .2];
    if ([.15, .5, .85].some(k => probeXs.some(px => probe(px, H * k, S.corners === "buttress" ? .5 : .3)))) continue;
    if (S.corners === "quoins") {
      kit.set({ kind: "stone", color: ctx.color("stone"), detail: ctx.detail });
      const blockH = ctx.stylized ? .46 : .34;
      let y = plinthTop, row = side;
      while (y < cornerTop - .08) {
        const h = Math.min(blockH, cornerTop - y), long = row % 2 === 0, len = long ? .58 : .32;
        kit.set({ shade: ctx.vary(.09) });
        const a = side ? W - len : -.05, b = side ? W + .05 : len;
        kit.box(f, a, b, y + .01, y + h - .01, -.02, .05, { bevel: .02, skip: { "-z": true } });
        y += h; row++;
      }
    } else if (S.corners === "posts") {
      kit.set({ kind: "timber", color: ctx.color("timber"), shade: ctx.vary(.06), detail: ctx.detail });
      const a = side ? W - .2 : -.07, b = side ? W + .07 : .2;
      kit.box(f, a, b, plinthTop, cornerTop, -.02, .07, { bevel: .018, skip: { "-z": true } });
    } else if (S.corners === "pilasters") {
      kit.set({ kind: S.kind === "brick" ? "brick" : "stone", color: ctx.color(S.kind === "brick" ? "wall" : "stone"), shade: ctx.vary(.04) * .96, detail: ctx.detail });
      const a = side ? W - .5 : -.1, b = side ? W + .1 : .5;
      kit.box(f, a, b, plinthTop, cornerTop, -.02, .1, { bevel: .02, skip: { "-z": true } });
      kit.set({ kind: "stone", color: ctx.color("stone") });
      kit.box(f, a - .06, b + .06, cornerTop - .28, cornerTop, -.02, .16, { bevel: .02, skip: { "-z": true } });
    } else if (S.corners === "buttress") buttress(ctx, f, side ? W - .45 : .45, H, plinthTop);
  }
  if (S.corners === "buttress" && !round && W > 5) {
    const count = Math.floor(W / 4.2);
    for (let i = 1; i <= count; i++) {
      const x = W * i / (count + 1);
      if (openings.some(o => x > o.u - .5 && x < o.u + o.width + .5) || [.15, .5, .85].some(k => [-.27, 0, .27].some(o => probe(x + o, H * k, .5)))) continue;
      buttress(ctx, f, x, H, plinthTop);
    }
  }
  if (S.corners === "pilasters" && !round && W > 6) {
    const count = Math.floor(W / 4.5);
    kit.set({ kind: S.kind === "brick" ? "brick" : "stone", color: ctx.color(S.kind === "brick" ? "wall" : "stone"), shade: .95, detail: ctx.detail });
    for (let i = 1; i <= count; i++) {
      const x = W * i / (count + 1);
      if (openings.some(o => x > o.u - .4 && x < o.u + o.width + .4) || probe(x, H / 2)) continue;
      kit.box(f, x - .25, x + .25, plinthTop, cornerTop, -.02, .09, { bevel: .02, skip: { "-z": true } });
    }
  }

  // ---- storey bands --------------------------------------------------------------------------
  if (S.band === "string") {
    kit.set({ kind: "stone", color: ctx.color("stone"), shade: 1, detail: ctx.detail });
    for (const y of levels) for (const [a, b] of freeSpans(cornerStart ? -.06 : 0, cornerEnd ? W + .06 : W, y - .08, y + .08, openings)) if (!probe((a + b) / 2, y)) kit.box(f, a, b, y - .08, y + .08, -.02, .06, { bevel: .018, skip: { "-z": true } });
  } else if (S.band === "light") {
    kit.set({ material: "light", kind: "metal", color: ctx.color("light"), shade: 1, detail: 0 });
    for (const y of levels) for (const [a, b] of freeSpans(0, W, y - .03, y + .03, openings)) kit.box(f, a, b, y - .03, y + .03, -.01, .035, { skip: { "-z": true } });
    kit.set({ material: "surface" });
  }

  // ---- crown ---------------------------------------------------------------------------------
  if (reachesTop && !flatTop) crown(ctx, f, W, H, openings, cornerStart, cornerEnd, probe);
  if (flatTop) flatEdge(ctx, f, w, W, H, T, cornerStart, cornerEnd, probe);
  else if (reachesTop && S.crown === "vigas") vigas(ctx, f, W, H, openings);
}

function stoneCourses(ctx, f, x0, x1, y0, y1, openings, { kind, color, big, probe }) {
  const { kit, rng } = ctx;
  const rows = Math.max(1, Math.round((y1 - y0) / (big ? .3 : .22)));
  const rowH = (y1 - y0) / rows, gap = big ? .035 : .022, bevel = big ? .06 : .03;
  kit.set({ kind, color, detail: ctx.detail });
  for (let r = 0; r < rows; r++) {
    const ya = y0 + r * rowH;
    for (const [a, b] of freeSpans(x0, x1, ya, ya + rowH, openings)) {
      let x = a - (r % 2) * rowH * .7;
      while (x < b - .02) {
        const width = rowH * (big ? 1.7 + rng.next() * 1.4 : 1.5 + rng.next() * 1.8);
        const sa = Math.max(x, a), sb = Math.min(x + width, b);
        x += width;
        if (sb - sa < .08 || probe((sa + sb) / 2, ya + rowH / 2) || probe(sa + .04, ya + rowH / 2) || probe(sb - .04, ya + rowH / 2)) continue;
        const lift = (rng.next() - .5) * rowH * .12, proud = (big ? .06 : .035) + rng.next() * (big ? .05 : .035);
        kit.set({ shade: ctx.vary(.16) * (r === 0 ? .9 : 1) });
        kit.box(f, sa + gap / 2, sb - gap / 2, ya + gap / 2 + (r === 0 ? -.04 : 0), ya + rowH - gap / 2 + lift, -.03, proud, { bevel, skip: { "-z": true } });
      }
    }
  }
}

function clapboard(ctx, f, W, y0, y1, openings, probe) {
  const { kit } = ctx, boardH = .22;
  kit.set({ kind: "plank", color: ctx.color("wall"), detail: ctx.detail });
  for (let y = y0; y < y1 - .05; y += boardH) {
    const top = Math.min(y1, y + boardH);
    for (const [a, b] of freeSpans(-.02, W + .02, y, top, openings)) {
      if (probe((a + b) / 2, y + .1)) continue;
      kit.set({ shade: ctx.vary(.07) });
      const g = { o: toWorld(f, a, 0, 0), t: f.u, u: f.n, n: f.t };
      kit.extrude(g, [[y, -.01], [y, .04], [top, .012], [top, -.01]], 0, b - a, { back: false });
    }
  }
}

function logCourses(ctx, f, w, W, H, openings, cornerStart, cornerEnd, probe) {
  const { kit } = ctx, r = .17, pitch = .32;
  const phase = Math.abs(w.normal[0]) > Math.abs(w.normal[2]) ? pitch / 2 : 0;
  kit.set({ kind: "log", color: ctx.color("wall"), detail: ctx.detail });
  const g = { o: [0, 0, 0], t: [0, 1, 0], u: f.t, n: f.n };
  for (let y = phase + r * .8; y < H - r * .6; y += pitch) {
    for (const [a0, b0] of freeSpans(0, W, y - r, y + r, openings, .01)) {
      const a = a0 <= 1e-3 && cornerStart ? -.32 : a0, b = b0 >= W - 1e-3 && cornerEnd ? W + .32 : b0;
      if (probe((a + b) / 2, y, .2)) continue;
      kit.set({ shade: ctx.vary(.1) });
      g.o = toWorld(f, 0, y, 0);
      kit.cylinder(g, 0, r * .25, r, a, b, 8);
    }
  }
}

function panels(ctx, f, W, y0, y1, openings, storeyH) {
  const { kit } = ctx, pw = 1.2, ph = Math.max(.8, storeyH / 2), gap = .035;
  kit.set({ kind: "metal", color: ctx.color("wall"), detail: ctx.detail });
  const cols = Math.max(1, Math.round(W / pw)), cw = W / cols;
  for (let y = y0; y < y1 - .1; y += ph) {
    const top = Math.min(y1, y + ph);
    for (let c = 0; c < cols; c++) {
      const a = c * cw, b = a + cw;
      if (openings.some(o => o.u < b + .05 && o.u + o.width > a - .05 && o.v < top + .05 && o.v + o.height > y - .05)) continue;
      kit.set({ shade: ctx.vary(.05) });
      kit.box(f, a + gap, b - gap, y + gap, top - gap, -.01, .025, { bevel: .012, skip: { "-z": true } });
    }
  }
}

function framing(ctx, f, W, H, plinthTop, crownDrop, levels, openings, cornerStart, cornerEnd, probe) {
  const { kit, style, rng } = ctx, spacing = style.walls.framing.spacing, pw = .18, depth = .06;
  const top = H - crownDrop;
  const cuts = new Set();
  if (!cornerStart) cuts.add(pw / 2);
  if (!cornerEnd) cuts.add(W - pw / 2);
  for (const o of openings) { cuts.add(Math.max(pw / 2, o.u - pw / 2)); cuts.add(Math.min(W - pw / 2, o.u + o.width + pw / 2)); }
  const inner = Math.max(1, Math.round(W / spacing));
  for (let i = 1; i < inner; i++) {
    const x = W * i / inner;
    if (!openings.some(o => x > o.u - pw && x < o.u + o.width + pw)) cuts.add(x);
  }
  const xs = [0, ...[...cuts].sort((a, b) => a - b), W].filter((x, i, all) => i === 0 || x - all[i - 1] > .3 || x === W);
  kit.set({ kind: "timber", color: ctx.color("timber"), detail: ctx.detail });
  for (const x of xs) {
    if (x < .01 || x > W - .01) continue;
    if (probe(x, H / 2)) continue;
    kit.set({ shade: ctx.vary(.07) });
    kit.box(f, x - pw / 2, x + pw / 2, plinthTop, top, -.02, depth, { bevel: .015, skip: { "-z": true } });
  }
  const rails = [plinthTop + .08, ...levels];
  for (const y of rails) for (const [a, b] of freeSpans(0, W, y - .08, y + .08, openings)) {
    if (probe((a + b) / 2, y)) continue;
    kit.set({ shade: ctx.vary(.06) });
    kit.box(f, a, b, y - .08, y + .08, -.02, depth + .01, { bevel: .015, skip: { "-z": true } });
  }
  for (const o of openings) {
    if (o.kind !== "window") continue;
    const left = Math.max(0, o.u - pw), right = Math.min(W, o.u + o.width + pw);
    kit.set({ shade: ctx.vary(.05) });
    if (o.v - .1 > plinthTop + .2) kit.box(f, left, right, o.v - .16, o.v, -.02, depth, { bevel: .012, skip: { "-z": true } });
    if (o.v + o.height + .16 < top - .1) kit.box(f, left, right, o.v + o.height, o.v + o.height + .16, -.02, depth, { bevel: .012, skip: { "-z": true } });
  }
  if (!style.walls.framing.braces) return;
  const bands = [plinthTop, ...levels, top];
  const sorted = xs.filter(x => x > -.01 && x < W + .01);
  for (let k = 0; k < bands.length - 1; k++) {
    const ya = bands[k] + .08, yb = bands[k + 1] - .08;
    if (yb - ya < .8) continue;
    for (let i = 0; i < sorted.length - 1; i++) {
      const xa = sorted[i] + pw / 2, xb = sorted[i + 1] - pw / 2;
      if (xb - xa < .5) continue;
      if (openings.some(o => o.u < xb && o.u + o.width > xa && o.v < yb && o.v + o.height > ya)) continue;
      const edge = i === 0 || i === sorted.length - 2;
      if (!edge && !rng.chance(.25)) continue;
      const rising = i < (sorted.length - 1) / 2;
      const run = Math.min(xb - xa, (yb - ya) * .9);
      const p0 = rising ? toWorld(f, xa, ya, .03) : toWorld(f, xb, ya, .03);
      const p1 = rising ? toWorld(f, xa + run, yb, .03) : toWorld(f, xb - run, yb, .03);
      if (ctx.blocked(v3.lerp(p0, p1, .5))) continue;
      kit.set({ shade: ctx.vary(.07) });
      kit.beam(p0, p1, .13, depth, w0Normal(f), { bevel: .012 });
    }
  }
}
const w0Normal = f => f.n;

function buttress(ctx, f, x, H, plinthTop) {
  const { kit } = ctx, d = Math.min(.95, H * .12 + .35), mid = H * .5, topY = Math.min(H * .86, H - .3);
  kit.set({ kind: "stone", color: ctx.color("stone"), shade: ctx.vary(.05), detail: ctx.detail });
  const g = { o: toWorld(f, x - .25, 0, 0), t: f.n, u: [0, 1, 0], n: f.t };
  kit.extrude(g, [[-.02, 0], [d, 0], [d, mid * .82], [d * .6, mid], [-.02, mid]], 0, .5);
  kit.extrude(g, [[-.02, mid], [d * .6, mid], [d * .6, topY - .35], [-.02, topY]], 0, .5);
}

function crown(ctx, f, W, H, openings, cornerStart, cornerEnd, probe) {
  const { kit, style } = ctx, S = style.walls;
  const e0 = cornerStart ? .1 : 0, e1 = cornerEnd ? .1 : 0;
  if (probe(W / 2, H - .1, .25)) return;
  if (S.crown === "beam") {
    kit.set({ kind: "timber", color: ctx.color("timber"), shade: ctx.vary(.05), detail: ctx.detail });
    kit.box(f, -e0 * .8, W + e1 * .8, H - .24, H, -.02, .08, { bevel: .02, skip: { "-z": true } });
  } else if (S.crown === "cornice") {
    const stone = S.kind === "stone" || S.kind === "brick";
    kit.set({ kind: stone ? "stone" : "plaster", color: ctx.color(stone ? "stone" : "trim"), shade: 1, detail: ctx.detail * .6 });
    kit.box(f, -e0 * .5, W + e1 * .5, H - .36, H - .24, -.02, .05, { bevel: .015, skip: { "-z": true } });
    kit.box(f, -e0, W + e1, H - .24, H - .1, -.02, .11, { bevel: .02, skip: { "-z": true } });
    kit.box(f, -e0 * 1.6, W + e1 * 1.6, H - .1, H, -.02, .17, { bevel: .02, skip: { "-z": true } });
  } else if (S.crown === "light") {
    kit.set({ material: "light", kind: "metal", color: ctx.color("light"), shade: 1, detail: 0 });
    kit.box(f, 0, W, H - .22, H - .16, -.01, .04, { skip: { "-z": true } });
    kit.set({ material: "surface" });
  } else if (S.crown === "coping") {
    kit.set({ kind: "concrete", color: ctx.color("trim"), shade: 1, detail: ctx.detail * .5 });
    kit.box(f, -e0 * .3, W + e1 * .3, H - .12, H, -.02, .05, { skip: { "-z": true } });
  }
}

function vigas(ctx, f, W, H, openings) {
  const { kit } = ctx;
  kit.set({ kind: "log", color: ctx.color("timber"), detail: ctx.detail });
  const g = { o: [0, 0, 0], t: f.t, u: f.n, n: [0, 1, 0] };
  for (let x = .6; x < W - .4; x += .95) {
    if (openings.some(o => x > o.u - .2 && x < o.u + o.width + .2 && o.v + o.height > H - .7)) continue;
    g.o = toWorld(f, x, 0, 0);
    kit.set({ shade: ctx.vary(.1) });
    kit.cylinder(g, 0, H - .5, .1, -.1, .5 + ctx.rng.next() * .12, 7);
  }
}

function flatEdge(ctx, f, w, W, H, T, cornerStart, cornerEnd, probe) {
  const { kit, style } = ctx, edge = style.roof.flatEdge, S = style.walls;
  if (probe(W / 2, H + .3, -T / 2)) return;
  const e0 = cornerStart ? .06 : 0, e1 = cornerEnd ? .06 : 0;
  const capKind = S.kind === "stone" || S.kind === "brick" ? "stone" : S.kind === "adobe" ? "adobe" : "concrete";
  const capColor = S.kind === "adobe" ? ctx.color("wall") : ctx.color(S.kind === "stone" ? "stone" : "trim");
  if (edge === "parapet" || edge === "battlements") {
    const ph = edge === "battlements" ? .75 : ctx.stylized ? .6 : .85;
    kit.set({ kind: S.kind, color: ctx.color("wall"), shade: 1, detail: ctx.detail });
    kit.box(f, 0, W, H - .01, H + ph, -T, 0, { skip: { "-y": true } });
    kit.set({ kind: capKind, color: capColor, shade: ctx.vary(.04), detail: ctx.detail });
    if (S.kind === "adobe") {
      const g = { o: toWorld(f, 0, H + ph, -T / 2), t: f.n, u: f.t, n: [0, 1, 0] };
      kit.cylinder(g, 0, -.02, T / 2 + .02, -e0, W + e1, 8, { arc: [0, Math.PI] });
    } else kit.box(f, -e0, W + e1, H + ph, H + ph + .09, -T - .04, .06, { bevel: .02 });
    if (edge === "battlements") {
      const mw = .75, gap = .55, count = Math.max(1, Math.round((W + gap) / (mw + gap))), step = (W + gap) / count;
      for (let i = 0; i < count; i++) {
        const a = i * step, b = Math.min(W, a + step - gap);
        if (b - a < .25) continue;
        kit.set({ kind: S.kind, color: ctx.color("wall"), shade: ctx.vary(.05) });
        kit.box(f, a, b, H + ph + .09, H + ph + .85, -T + .02, -.02, { bevel: .03, skip: { "-y": true } });
        kit.set({ kind: capKind, color: capColor, shade: ctx.vary(.05) });
        kit.box(f, a - .04, b + .04, H + ph + .85, H + ph + .95, -T - .02, .02, { bevel: .02 });
      }
      kit.set({ kind: "stone", color: ctx.color("stone"), shade: .92 });
      kit.box(f, -e0, W + e1, H - .12, H + .06, -.02, .24, { bevel: .03, skip: { "-z": true } });
      for (let x = .3; x < W - .1; x += .62) {
        kit.set({ shade: ctx.vary(.08) * .9 });
        kit.box(f, x - .12, x + .12, H - .5, H - .12, -.02, .2, { bevel: .025, skip: { "-z": true } });
      }
    }
  } else if (edge === "coping") {
    kit.set({ kind: capKind, color: capColor, shade: 1, detail: ctx.detail * .5 });
    kit.box(f, -e0, W + e1, H - .02, H + .14, -T - .02, .1, { bevel: .015 });

  }
  if (S.crown === "light") {
    kit.set({ material: "light", kind: "metal", color: ctx.color("light"), shade: 1, detail: 0 });
    kit.box(f, 0, W, H - .3, H - .24, -.01, .04, { skip: { "-z": true } });
    kit.set({ material: "surface" });
  }
}

// ---- free-standing walls ----------------------------------------------------------------------
function boundaryWall(ctx) {
  const { kit, style, form, rng } = ctx, B = style.boundary;
  for (const w of ctx.walls) {
    const f = wallFrame(w);
    const grounded = Math.abs(w.origin[1] - form.base) < .03 && form.base < .35;
    if (grounded && B.cap !== "palisade" && w.width > 1.2 && (B.kind === "stone" || style.walls.plinth.type === "stones")) {
      stoneCourses(ctx, f, -.04, w.width + .04, 0, Math.min(.5, w.height * .3), w.openings ?? [], { kind: "stone", color: ctx.color("stone"), big: ctx.stylized, probe: (x, y) => ctx.blocked(toWorld(f, x, y, .12)) });
    }
  }
  const [L, H, T] = form.size, c = Math.cos(form.rotationY), s = Math.sin(form.rotationY);
  const fw = frame([form.position[0], form.base, form.position[2]], [c, 0, -s], [0, 1, 0], [s, 0, c]);
  const colorWall = ctx.color("wall"), capKind = B.kind;
  if (B.cap === "battlements") {
    kit.set({ kind: capKind, color: ctx.color("stone"), shade: .95, detail: ctx.detail });
    kit.box(fw, -L / 2, L / 2, H - .14, H, -T / 2 - .08, T / 2 + .08, { bevel: .03 });
    const mw = .8, gap = .6, count = Math.max(1, Math.round((L + gap) / (mw + gap))), step = (L + gap) / count;
    for (let i = 0; i < count; i++) {
      const a = -L / 2 + i * step, b = Math.min(L / 2, a + step - gap);
      if (b - a < .25 || ctx.blocked(toWorld(fw, (a + b) / 2, H + .5, 0))) continue;
      kit.set({ kind: capKind, color: colorWall, shade: ctx.vary(.06) });
      kit.box(fw, a, b, H, H + .9, -T / 2 + .02, T / 2 - .02, { bevel: .04, skip: { "-y": true } });
    }
  } else if (B.cap === "rounded") {
    kit.set({ kind: capKind, color: ctx.color("stone"), shade: ctx.vary(.05), detail: ctx.detail });
    const g = { o: toWorld(fw, 0, H, 0), t: fw.n, u: fw.t, n: [0, 1, 0] };
    kit.cylinder(g, 0, -.05, T / 2 + .07, -L / 2 - .02, L / 2 + .02, 10, { arc: [0, Math.PI] });
  } else if (B.cap === "coping") {
    kit.set({ kind: capKind === "plaster" ? "concrete" : capKind, color: ctx.color(capKind === "brick" || capKind === "stone" ? "stone" : "trim"), shade: 1, detail: ctx.detail * .5 });
    kit.box(fw, -L / 2 - .02, L / 2 + .02, H, H + .13, -T / 2 - .06, T / 2 + .06, { bevel: .02 });
  } else if (B.cap === "palisade") {
    kit.set({ kind: "log", color: ctx.color("timber"), detail: ctx.detail });
    const r = Math.max(.12, T * .5 + .02), step = r * 1.9;
    const g = { o: [0, 0, 0], t: fw.t, u: [0, 1, 0], n: fw.n };
    for (let x = -L / 2 + r; x <= L / 2 - r * .5; x += step) {
      const top = H + .15 + rng.next() * .35;
      g.o = toWorld(fw, x, 0, 0);
      kit.set({ shade: ctx.vary(.12) });
      kit.cylinder(g, 0, 0, r, -.05, top, 7, { capBottom: false, capTop: false });
      kit.cylinder(g, 0, 0, r, top, top + r * 2.2, 7, { radiusTop: .005, capBottom: false, capTop: false });
    }
    return;
  }
  const [emitStart, emitEnd] = ctx.boundaryEnds ?? [true, true];
  for (const [emit, x] of [[emitStart, -L / 2], [emitEnd, L / 2]]) {
    if (!emit || ctx.blocked(toWorld(fw, x, H + .4, 0))) continue;
    const half = Math.max(.35, T / 2 + .15), extra = B.cap === "battlements" ? 1.1 : .3;
    kit.set({ kind: capKind, color: colorWall, shade: ctx.vary(.05), detail: ctx.detail });
    kit.box(fw, x - half, x + half, -.02, H + extra, -half, half, { bevel: .04, skip: { "-y": true } });
    kit.set({ kind: capKind === "plaster" ? "concrete" : capKind, color: ctx.color("stone"), shade: 1 });
    kit.box(fw, x - half - .08, x + half + .08, H + extra, H + extra + .16, -half - .08, half + .08, { bevel: .03 });
  }
}

// ---- supports under raised forms ----------------------------------------------------------------
function supports(ctx) {
  const { kit, style, form } = ctx;
  const [w, , d] = form.size, c = Math.cos(form.rotationY), s = Math.sin(form.rotationY);
  const local = (x, z) => [form.position[0] + x * c + z * s, form.position[2] - x * s + z * c];
  const top = form.base - ctx.thickness;
  if (top < .2) return;
  const points = [];
  if (form.shape === "round") {
    const count = Math.max(4, Math.round(Math.PI * (w + d) / 2 / 3));
    for (let i = 0; i < count; i++) { const a = i / count * Math.PI * 2; points.push(local(Math.cos(a) * w * .38, Math.sin(a) * d * .38)); }
  } else {
    const inset = .35, nx = Math.max(1, Math.ceil((w - inset * 2) / 3.4)), nz = Math.max(1, Math.ceil((d - inset * 2) / 3.4));
    for (let i = 0; i <= nx; i++) for (let j = 0; j <= nz; j++) {
      if (i > 0 && i < nx && j > 0 && j < nz) continue;
      points.push(local(-w / 2 + inset + (w - inset * 2) * i / nx, -d / 2 + inset + (d - inset * 2) * j / nz));
    }
  }
  const size = Math.min(.55, w / 6, d / 6);
  for (const [x, z] of points) {
    if (ctx.blocked([x, top - .3, z], -.05) || ctx.blocked([x, .3, z], -.05) || ctx.pathBlocked(x, z)) continue;
    const g = frame([x, 0, z], [c, 0, -s], [0, 1, 0], [s, 0, c]);
    if (style.supports === "pilotis") {
      kit.set({ kind: "concrete", color: ctx.color("stone"), shade: 1, detail: ctx.detail * .5 });
      kit.cylinder(g, 0, 0, size * .38, -.02, top, 14);
    } else if (style.supports === "timber") {
      kit.set({ kind: "stone", color: ctx.color("stone"), shade: ctx.vary(.08), detail: ctx.detail });
      kit.box(g, -size * .45, size * .45, -.05, .25, -size * .45, size * .45, { bevel: .03 });
      kit.set({ kind: "timber", color: ctx.color("timber"), shade: ctx.vary(.06) });
      kit.box(g, -size * .24, size * .24, .25, top, -size * .24, size * .24, { bevel: .02 });
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const knee = Math.min(.8, top * .3);
        if (ctx.blocked(toWorld(g, dx * knee, top - .1, dz * knee), -.02)) continue;
        kit.beam(toWorld(g, dx * size * .2, top - knee, dz * size * .2), toWorld(g, dx * knee, top - .02, dz * knee), .12, .12, [0, 1, 0], { bevel: .01 });
      }
    } else {
      kit.set({ kind: "stone", color: ctx.color("stone"), shade: ctx.vary(.06), detail: ctx.detail });
      kit.box(g, -size * .7, size * .7, -.05, .35, -size * .7, size * .7, { bevel: .04 });
      kit.box(g, -size / 2, size / 2, .35, top - .3, -size / 2, size / 2, { bevel: .035 });
      kit.box(g, -size * .68, size * .68, top - .3, top, -size * .68, size * .68, { bevel: .035 });
    }
  }
}
