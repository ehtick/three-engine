// WORLD-ABSOLUTE PROBE KEYS — THE PROPERTY GATE (plan Part 2 S1).
//
// Pure Node, no GPU, no browser: every claim S1 rests on is a statement about
// integer arithmetic, and a statement about integer arithmetic should not need a
// 4-minute browser boot to check. What the GPU gates then have to cover is only
// whether the TSL twin agrees — `test:gi-src-math` already exists for that.
//
// ══ WHY THIS GATE IS THE WHOLE ARGUMENT ════════════════════════════════════
//
// The plan proposes replacing the probe hash with a dense camera-centred ring
// ("probe index = worldCell mod ringSize"). Case 0 prices that proposal and it
// does not survive: a probe population is a 2-D manifold in a 3-D lattice, so a
// dense ring pays for the third dimension and gets nothing — 191,692,800 cells
// and 338 GB of direction bins to hold ~16,000 probes.
//
// So the torus moves onto the KEY, where it is free, and the four properties S1
// actually wanted become cases 1–4. Case 2 is the load-bearing one: if two live
// world cells could ever share a key, two unrelated probes would share one
// payload and the light would be wrong in a way no energy check could localize.
//
//   node scripts/run-gi-src-worldkeys-test.mjs
import {
  KEY_AXIS_OFFSET,
  KEY_AXIS_RANGE,
  KEY_EMPTY,
  keyWorldCell,
  packProbeKey,
  probeKeyInWindow,
  unpackProbeKey,
  worldCellAt,
  wrapCellNear,
} from "../src/modules/gi/srcMath.js";
import {
  CASCADE_COUNT,
  LOD0_REACH,
  MAX_LODS,
  W0,
  binCount,
  lodRadius,
  probeSpacing,
} from "../src/modules/gi/srcConfig.js";

let failures = 0;
const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ── CASE 0: price the dense ring the plan proposes ─────────────────────────
// Not a pass/fail on the code — a pass/fail on the DESIGN, recorded here so the
// number cannot be lost again. The shell a level must cover is its outer LOD
// radius; the cells it needs is that span over its own spacing.
{
  const s0 = 0.35;
  let cells = 0;
  let bins = 0;
  for (let c = 0; c < CASCADE_COUNT; c++) {
    for (let L = 0; L < MAX_LODS; L++) {
      const perAxis = Math.ceil(2 * lodRadius(L + 1, s0) / probeSpacing(c, L, s0));
      const n = perAxis ** 3;
      cells += n;
      bins += n * binCount(c, W0);
    }
  }
  const liveC0 = 16000;                       // measured on the user's scene
  const c0l0 = Math.ceil(2 * lodRadius(1, s0) / probeSpacing(0, 0, s0)) ** 3;
  console.log(
    `\n── case 0: the DENSE RING the plan proposes, priced at s0=0.35\n` +
    `   c0/L0 alone: ${c0l0.toLocaleString()} cells to hold ~${liveC0.toLocaleString()} live probes ` +
    `(${Math.round(c0l0 / liveC0)}x waste)\n` +
    `   all ${CASCADE_COUNT * MAX_LODS} (cascade,LOD) levels: ${cells.toLocaleString()} cells = ` +
    `${(cells * 32 / 2 ** 30).toFixed(2)} GB of probe records\n` +
    `   direction bins: ${(bins / 1e6).toFixed(0)}M = ${(bins * 9 * 4 / 2 ** 30).toFixed(0)} GB\n` +
    `   → a dense ring is not buildable; the torus belongs on the KEY.\n`,
  );
  check(
    "case 0: dense storage ring is refuted by its own arithmetic (>100x waste at c0/L0)",
    c0l0 / liveC0 > 100,
    `${Math.round(c0l0 / liveC0)}x`,
  );
}

globalThis.__giSrcWorldKeys = true;

// ── CASE 1: a key is a PURE FUNCTION of the world cell ────────────────────
// The property re-anchoring breaks today. Same point, wildly different anchors
// (a camera that walked 900 m, and one at the origin) must produce one key.
{
  const s0 = 0.35;
  let worst = 0;
  let mismatches = 0;
  const points = [];
  for (let i = 0; i < 400; i++) {
    const t = i / 400;
    points.push([
      Math.sin(t * 41) * 700, Math.cos(t * 13) * 40, Math.sin(t * 7) * 700,
    ]);
  }
  for (const p of points) {
    for (let c = 0; c < CASCADE_COUNT; c++) {
      for (let L = 0; L < MAX_LODS; L++) {
        const s = probeSpacing(c, L, s0);
        const keys = new Set();
        // Four anchors: the point itself, the origin, and two far-off cameras.
        for (const a of [p, [0, 0, 0], [500, 20, -500], [-912.5, -7, 331.25]]) {
          const cell = worldCellAt(p[0], p[1], p[2], a[0], a[1], a[2], s);
          keys.add(packProbeKey(L, 0, cell.cx, cell.cy, cell.cz));
        }
        if (keys.size !== 1) { mismatches++; worst = Math.max(worst, keys.size); }
      }
    }
  }
  check(
    "case 1: key is anchor-INDEPENDENT (the re-anchor cannot renumber a probe)",
    mismatches === 0,
    mismatches === 0
      ? `${points.length * CASCADE_COUNT * MAX_LODS} (point, cascade, LOD) triples, one key each`
      : `${mismatches} triples produced up to ${worst} different keys`,
  );
}

// ── CASE 2: NO TWO LIVE CELLS ALIAS, over every (cascade, LOD) pair ───────
// The load-bearing property. Live span on one axis at LOD L is
// 2·lodRadius(L+1); the key repeats every KEY_AXIS_RANGE cells of that level's
// spacing. Asserted per pair rather than argued once, because the margin is only
// 2x at the tightest pair and any future change to LOD0_REACH, MAX_LODS or the
// axis bit count moves it.
{
  const s0 = 0.35;
  let worstMargin = Infinity;
  let worstAt = "";
  for (let c = 0; c < CASCADE_COUNT; c++) {
    for (let L = 0; L < MAX_LODS; L++) {
      const s = probeSpacing(c, L, s0);
      const period = KEY_AXIS_RANGE * s;      // world units between aliases
      const span = 2 * lodRadius(L + 1, s0);  // widest live extent on one axis
      const margin = period / span;
      if (margin < worstMargin) { worstMargin = margin; worstAt = `c${c}/L${L}`; }
    }
  }
  check(
    "case 2: alias period exceeds the live span at EVERY (cascade, LOD) pair",
    worstMargin > 1,
    `worst margin ${worstMargin.toFixed(2)}x at ${worstAt} ` +
    `(the bound is 2·2^cascade; a margin <= 1 would make two probes share a payload)`,
  );
  // And the reconstruction is exact everywhere inside that span — the property
  // `wrapCellNear` has to have for the margin to mean anything.
  let bad = 0;
  for (let c = 0; c < CASCADE_COUNT; c++) {
    for (let L = 0; L < MAX_LODS; L++) {
      const s = probeSpacing(c, L, s0);
      const reach = Math.floor(lodRadius(L + 1, s0) / s);   // live cells from camera
      for (const camCell of [0, 1, -1, 511, 512, -512, 100000, -99999]) {
        for (let d = -reach; d <= reach; d += Math.max(1, Math.floor(reach / 37))) {
          const world = camCell + d;
          const packed = world & (KEY_AXIS_RANGE - 1);
          if (wrapCellNear(packed, camCell) !== world) bad++;
        }
      }
    }
  }
  check(
    "case 2b: wrapCellNear recovers the exact world cell everywhere inside the live span",
    bad === 0,
    bad === 0 ? "including negative cells and cells past the 512 window" : `${bad} misreconstructions`,
  );
}

// ── CASE 3: pack → unpack → world cell round-trips exactly ────────────────
{
  let bad = 0;
  let empties = 0;
  const s0 = 0.35;
  for (let L = 0; L < MAX_LODS; L++) {
    const s = probeSpacing(0, L, s0);
    const reach = Math.floor(lodRadius(L + 1, s0) / s);
    for (const base of [[0, 0, 0], [1000, -30, -1000], [-2600, 12, 2600]]) {
      const camCell = base.map((v) => Math.round(v / s));
      for (let i = 0; i < 60; i++) {
        const cell = [
          camCell[0] + ((i * 17) % (2 * reach + 1)) - reach,
          camCell[1] + ((i * 29) % (2 * reach + 1)) - reach,
          camCell[2] + ((i * 41) % (2 * reach + 1)) - reach,
        ];
        const key = packProbeKey(L, 0, cell[0], cell[1], cell[2]);
        if (key === KEY_EMPTY) { empties++; continue; }
        const got = keyWorldCell(key, camCell[0], camCell[1], camCell[2]);
        if (!got || got.lod !== L || got.cx !== cell[0] || got.cy !== cell[1] || got.cz !== cell[2]) bad++;
      }
    }
  }
  check(
    "case 3: pack → keyWorldCell round-trips lod + world cell exactly",
    bad === 0 && empties === 0,
    bad === 0 && empties === 0 ? "1800 cells across 10 LODs and 3 world regions"
      : `${bad} wrong, ${empties} packed EMPTY`,
  );
}

// ── CASE 4: NO CELL IS EVER UNREPRESENTABLE ──────────────────────────────
// Today `packProbeKey` returns EMPTY past ±256 cells, and an EMPTY key is a
// probe that silently does not exist — the plan's "lights fine at spawn, goes
// flat after a walk". Under a toroidal window that outcome is unreachable.
{
  let empties = 0;
  for (const v of [0, 255, 256, 257, 512, 100000, -1, -256, -257, -100000]) {
    for (let L = 0; L < MAX_LODS; L++) {
      if (packProbeKey(L, 0, v, v, v) === KEY_EMPTY) empties++;
      if (!probeKeyInWindow(v, v, v)) empties++;
    }
  }
  check(
    "case 4: no world cell is unrepresentable at any distance (walking cannot delete a probe)",
    empties === 0,
    empties === 0 ? "cells from -100000 to +100000 all pack to a valid key" : `${empties} EMPTY/out-of-window`,
  );
  // A key must still never collide with the EMPTY sentinel.
  let zeros = 0;
  for (let L = 0; L < MAX_LODS; L++) {
    for (const sec of [0, 1]) if (packProbeKey(L, sec, 0, 0, 0) === 0) zeros++;
  }
  check("case 4b: the LOD+1 bias still keeps every packed key nonzero", zeros === 0);
}

// ── CASE 5: A 100 m TELEPORT RENUMBERS NOTHING ───────────────────────────
// The plan's gate 3, as arithmetic. Every probe still inside its LOD's reach
// after the move must keep the key it had before.
{
  const s0 = 0.35;
  const before = [0, 1.7, 0];
  const after = [100, 1.7, 0];
  let renumbered = 0;
  let survivors = 0;
  for (let i = 0; i < 3000; i++) {
    const t = i / 3000;
    const p = [Math.sin(t * 97) * 60 + 50, Math.cos(t * 31) * 6 + 2, Math.sin(t * 53) * 60];
    for (let c = 0; c < CASCADE_COUNT; c++) {
      for (let L = 0; L < MAX_LODS; L++) {
        const s = probeSpacing(c, L, s0);
        const cheb = (cam) => Math.max(...p.map((v, k) => Math.abs(v - cam[k])));
        // Only points live at this LOD in BOTH poses are "survivors" — the rest
        // legitimately change shell, which is a different question.
        if (cheb(before) > lodRadius(L + 1, s0) || cheb(after) > lodRadius(L + 1, s0)) continue;
        survivors++;
        const k0 = packProbeKey(L, 0, ...Object.values(worldCellAt(p[0], p[1], p[2], ...before, s)));
        const k1 = packProbeKey(L, 0, ...Object.values(worldCellAt(p[0], p[1], p[2], ...after, s)));
        if (k0 !== k1) renumbered++;
      }
    }
  }
  check(
    "case 5: a 100 m camera teleport renumbers ZERO surviving probes",
    renumbered === 0 && survivors > 0,
    `${survivors} surviving (point, cascade, LOD) triples, ${renumbered} renumbered ` +
    `(today's anchor-relative keying renumbers ALL of them past ${LOD0_REACH}·s0 drift)`,
  );
}

// ── CASE 6: the OFF arm is untouched ─────────────────────────────────────
// The hatch defaults off and the plan requires the old keying kept for A/B, so
// the anchor-relative path must be bit-identical with the flag down.
{
  globalThis.__giSrcWorldKeys = false;
  let bad = 0;
  for (let i = -260; i <= 260; i += 7) {
    const key = packProbeKey(3, 0, i, -i, i >> 1);
    const inRange = Math.abs(i) <= KEY_AXIS_OFFSET - 1 || i === -KEY_AXIS_OFFSET;
    if (!inRange) { if (key !== KEY_EMPTY) bad++; continue; }
    const u = unpackProbeKey(key);
    if (!u || u.cx !== i || u.cy !== -i || u.cz !== (i >> 1) || u.lod !== 3 || u.residue) bad++;
  }
  check("case 6: hatch OFF is the shipped anchor-relative keying, unchanged", bad === 0);
  globalThis.__giSrcWorldKeys = true;
}

console.log("\n─────────────────────────────────────────────────────────────────");
console.log(failures === 0 ? "gi-src-worldkeys: all cases PASS" : `gi-src-worldkeys: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
