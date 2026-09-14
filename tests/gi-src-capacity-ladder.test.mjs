import test from "node:test";
import assert from "node:assert/strict";
import {
  BLOCK_RUNGS_PER_OCTAVE,
  CASCADE_COUNT,
  MIN_BLOCKS,
  binCount,
  blockVectorFromPeaks,
  snapBlockCapacity,
} from "../src/modules/gi/srcConfig.js";

/**
 * THE CAPACITY LADDER (2026-09-12).
 *
 * Every cascade's `blockCapacity` is baked into the SRC kernels as a WGSL
 * literal — the cascade bin partition, the slot bases, and the tile atlas's
 * height. Chromium keys Dawn's compiled-shader disk cache on the WGSL TEXT, so
 * an arbitrary capacity means an arbitrary key and a cold compile of ~70
 * kernels on every boot. Measured: two rebuilds in ONE session produced two
 * 204 682-byte modules differing in 21 of 6 639 lines, all of them these
 * literals; `DawnWebGPUCache` held 17 MB / 54 entries against a 1 GB cap.
 *
 * The claim these tests defend is narrow and load-bearing: **two demands that
 * differ slightly must produce the SAME capacity vector**, because that is the
 * only thing that makes the shader text repeat. Everything else here is a
 * guard on what the ladder must not break while doing it.
 */

const slots = (c0) => Array.from({ length: CASCADE_COUNT }, (_, c) => Math.max(1024, c0 >> c));
const bins = (v) => v.reduce((s, b, c) => s + b * binCount(c), 0);

test("the ladder is idempotent — a rung snaps to itself", () => {
  for (let cascade = 0; cascade < CASCADE_COUNT; cascade++) {
    for (const v of [1024, 2048, 20480, 81920, 98304, 131072, 262144]) {
      const once = snapBlockCapacity(v, cascade);
      assert.equal(snapBlockCapacity(once, cascade), once, `c${cascade} ${v} → ${once} moved twice`);
    }
  }
});

test("⭐ THE POINT: nearby demands collapse onto one rung", () => {
  // The two capacities measured in one live session, which produced two
  // different 200 kB kernels and therefore two cold compiles.
  assert.equal(snapBlockCapacity(89088, 0), snapBlockCapacity(92672, 0));
  assert.equal(snapBlockCapacity(89088, 0), 98304);
  // A whole octave of cascade-0 demand may only ever reach four values.
  const reachable = new Set();
  for (let v = 65537; v <= 131072; v += 7) reachable.add(snapBlockCapacity(v, 0));
  assert.equal(reachable.size, BLOCK_RUNGS_PER_OCTAVE, [...reachable].sort((a, b) => a - b).join("/"));
});

test("the overshoot is bounded by one rung — the memory this costs", () => {
  for (let cascade = 0; cascade < CASCADE_COUNT; cascade++) {
    for (let v = 2048; v < 300000; v = Math.ceil(v * 1.013)) {
      const up = snapBlockCapacity(v, cascade);
      assert.ok(up >= v, `c${cascade} ${v} → ${up} rounded DOWN`);
      assert.ok(
        up <= v * (1 + 1 / BLOCK_RUNGS_PER_OCTAVE) + 1,
        `c${cascade} ${v} → ${up} overshot more than one rung`,
      );
    }
  }
});

test("pools at or below one fine quantum are untouched — gates keep their sizes", () => {
  assert.equal(snapBlockCapacity(MIN_BLOCKS, 0), MIN_BLOCKS);
  assert.equal(snapBlockCapacity(64, 0), 64);
  assert.equal(snapBlockCapacity(1024, 0), 1024);   // exactly the quantum
  assert.equal(snapBlockCapacity(128, 3), 128);
  assert.equal(snapBlockCapacity(0, 0), 0);
  assert.equal(snapBlockCapacity(NaN, 0), 0);
});

test("`down` floors to the rung and never returns zero", () => {
  for (let cascade = 0; cascade < CASCADE_COUNT; cascade++) {
    for (let v = 2048; v < 300000; v = Math.ceil(v * 1.031)) {
      const down = snapBlockCapacity(v, cascade, { down: true });
      assert.ok(down > 0, `c${cascade} ${v} floored to ${down}`);
      assert.ok(down <= v, `c${cascade} ${v} → ${down} rounded UP under {down:true}`);
    }
  }
});

test("blockVectorFromPeaks lands every cascade on the ladder", () => {
  const v = blockVectorFromPeaks({
    peaks: [39952, 12636, 3564, 970],       // the live session's measured peaks
    current: [80896, 19456, 4608, 1280],
    slots: slots(131072),
    binCeiling: 16_000_000,
  });
  v.blocks.forEach((b, c) => {
    assert.equal(snapBlockCapacity(b, c), b, `cascade ${c} returned ${b}, off the ladder`);
  });
  assert.equal(v.bins, bins(v.blocks), "reported bins must match the returned vector");
});

test("⭐ THE CACHE-HIT PROPERTY: the vector is a FIXED POINT, so boot N+1 repeats boot N", () => {
  const base = { slots: slots(131072), binCeiling: 16_000_000 };
  const peaks = [39952, 12636, 3564, 970];
  // Boot N grows from the persisted pool and persists what it reached. Boot
  // N+1 restores exactly that and sees the same scene. It must not move — a
  // vector that drifts by even one cascade is a fresh set of WGSL literals and
  // a cold compile of ~70 kernels. This is the RATCHET that made capacities
  // essentially never repeat before the ladder.
  const first = blockVectorFromPeaks({ ...base, peaks, current: [80896, 19456, 4608, 1280] });
  let v = first.blocks;
  for (let boot = 0; boot < 5; boot++) {
    const next = blockVectorFromPeaks({ ...base, peaks, current: v });
    assert.deepEqual(next.blocks, v, `boot ${boot + 2} moved: ${v.join("/")} → ${next.blocks.join("/")}`);
    v = next.blocks;
  }
});

test("a small demand drift does not move the vector once it is settled", () => {
  const base = { slots: slots(131072), binCeiling: 16_000_000 };
  const settled = blockVectorFromPeaks({ ...base, peaks: [39952, 12636, 3564, 970] }).blocks;
  // +1 % on every cascade — the sort of drift a camera move produces. Inside
  // a rung it must be free. (A drift large enough to cross a rung SHOULD grow
  // the pool; that is the ladder working, and the next boot settles there.)
  const drifted = blockVectorFromPeaks({
    ...base,
    peaks: [40351, 12762, 3599, 979],
    current: settled,
  }).blocks;
  assert.deepEqual(drifted, settled, `${settled.join("/")} → ${drifted.join("/")}`);
});

test("the ladder never shrinks a pool below what it already holds", () => {
  const current = [98304, 20480, 5120, 1280];
  const v = blockVectorFromPeaks({
    peaks: [10, 5, 2, 1],                    // demand collapsed; the pool must not
    current,
    slots: slots(131072),
    binCeiling: 16_000_000,
  });
  v.blocks.forEach((b, c) => assert.ok(b >= current[c], `cascade ${c} shrank ${current[c]} → ${b}`));
});

test("⛔ the device ceiling still holds, and the clamped vector is still on the ladder", () => {
  const ceiling = 2_000_000;
  const v = blockVectorFromPeaks({
    peaks: [200000, 90000, 40000, 20000],
    slots: slots(262144),
    binCeiling: ceiling,
  });
  assert.ok(v.clamped, "this demand must trip the ceiling");
  assert.ok(v.bins <= ceiling, `${v.bins} bins exceeds the ${ceiling} ceiling`);
  v.blocks.forEach((b, c) => {
    assert.ok(b >= MIN_BLOCKS, `cascade ${c} fell below MIN_BLOCKS`);
    assert.equal(snapBlockCapacity(b, c), b, `clamped cascade ${c} (${b}) is off the ladder`);
  });
});

/**
 * ⛔⛔ THE CEILING LATCH (2026-09-12, found on the user's live editor).
 *
 * A ceiling-clamped pool can never satisfy anybody, so `noBlock` stays high
 * every frame and `peaks` — a running max of `live + noBlock`, persisted across
 * sessions — climbs WITHOUT BOUND. The rescale then re-splits the same fixed
 * ceiling by an ever-changing ratio, which is exactly the "re-split a FIXED
 * total by a parked SNAPSHOT of demand" that `blockVectorFromPeaks`' own header
 * warns against. Measured from the user's live numbers: cascade 0 halves
 * (65536 → 32768) while cascade 3 doubles, and every step is a fresh set of
 * baked WGSL literals — a cold compile of ~70 kernels and a field that
 * re-converges from black, for a pool that did not get bigger.
 */
test("⛔ at the ceiling the vector LATCHES — unbounded peaks cannot move it", () => {
  const slots = [131072, 65536, 32768, 16384];
  const ceiling = 16_000_000;
  let current = [65536, 28672, 10240, 1792];      // the user's live vector, ceiling-clamped
  let peaks = [107081, 33452, 13482, 2684];       // and its live peaks
  const start = current.join("/");
  for (let session = 0; session < 6; session++) {
    peaks = peaks.map((p) => Math.round(p * 1.5));
    const v = blockVectorFromPeaks({ peaks, current, slots, binCeiling: ceiling });
    assert.ok(v.clamped, "this demand must still read as clamped");
    assert.equal(v.blocks.join("/"), start, `session ${session + 1} moved the latched vector`);
    current = v.blocks;
  }
});

test("⛔ the latch never starves cascade 0 to feed the coarse cascades", () => {
  const slots = [131072, 65536, 32768, 16384];
  const current = [65536, 28672, 10240, 1792];
  const v = blockVectorFromPeaks({
    // c3 demand exploding is the shape that used to eat c0's budget: a c3 block
    // costs 2048 bins against c0's 32.
    peaks: [110000, 40000, 30000, 20000],
    current,
    slots,
    binCeiling: 16_000_000,
  });
  assert.ok(v.blocks[0] >= current[0], `cascade 0 shrank ${current[0]} → ${v.blocks[0]}`);
});

test("the latch yields to a genuinely smaller ceiling", () => {
  const slots = [131072, 65536, 32768, 16384];
  const current = [65536, 28672, 10240, 1792];    // 14.68 M bins
  const v = blockVectorFromPeaks({
    peaks: [107081, 33452, 13482, 2684],
    current,
    slots,
    binCeiling: 4_000_000,                        // a portable device: the held vector cannot fit
  });
  assert.ok(v.bins <= 4_000_000, `${v.bins} bins exceeds the smaller ceiling`);
  assert.notEqual(v.blocks.join("/"), current.join("/"), "the latch must not hold an oversized vector");
  v.blocks.forEach((b, c) => assert.equal(snapBlockCapacity(b, c), b, `cascade ${c} off the ladder`));
});

test("the latch does not apply to a cascade the slot vector can no longer hold", () => {
  const current = [65536, 28672, 10240, 1792];
  const shrunk = [8192, 4096, 2048, 1024];        // c0Probes was lowered
  const v = blockVectorFromPeaks({
    peaks: [107081, 33452, 13482, 2684],
    current,
    slots: shrunk,
    binCeiling: 16_000_000,
  });
  v.blocks.forEach((b, c) => assert.ok(b <= shrunk[c], `cascade ${c}: ${b} blocks for ${shrunk[c]} slots`));
});

test("a cascade is never given more blocks than it has probe slots", () => {
  const s = slots(4096);
  const v = blockVectorFromPeaks({
    peaks: [1e6, 1e6, 1e6, 1e6],
    slots: s,
    binCeiling: 16_000_000,
  });
  v.blocks.forEach((b, c) => assert.ok(b <= s[c], `cascade ${c}: ${b} blocks for ${s[c]} slots`));
});
