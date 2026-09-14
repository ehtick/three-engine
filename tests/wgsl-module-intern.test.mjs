import test from "node:test";
import assert from "node:assert/strict";
import { WgslRegistry, canonicalizeWgsl } from "../src/engine/wgslStable.js";

/**
 * MODULE INTERNING (2026-09-12).
 *
 * three interns its programs by the WGSL text IT generated; `canonicalizeWgsl`
 * runs later, at `createShaderModule`. So two graphs that differ only in
 * `NodeBuffer_<node.id>` naming are distinct to three, identical to the driver,
 * and arrive as two `GPUShaderModule`s with byte-identical source. Measured on
 * the user's Complex scene: **129 of 336 modules redundant, 1 148 kB — 23 % of
 * the boot's WGSL** — handed to the GPU process that is the boot's bottleneck.
 *
 * A GPUShaderModule is immutable and may back any number of pipelines, so
 * returning the same one for identical source is safe. These tests pin that,
 * and the two ways it must NOT go wrong: never returning a module for text
 * that does not match (a hash collision must not hand the driver the wrong
 * shader), and the revert hatch.
 */

const withFlag = (value, fn) => {
  const previous = globalThis.__wgslInternModules;
  globalThis.__wgslInternModules = value;
  try { return fn(); } finally {
    if (previous === undefined) delete globalThis.__wgslInternModules;
    else globalThis.__wgslInternModules = previous;
  }
};

test("identical text is created once and handed back thereafter", () => {
  const r = new WgslRegistry(null);
  let made = 0;
  const code = "fn main() { let x = 1; }";
  const a = r.intern(code, () => { made++; return { id: made }; });
  const b = r.intern(code, () => { made++; return { id: made }; });
  const c = r.intern(code, () => { made++; return { id: made }; });
  assert.equal(made, 1, "the driver should have been asked once");
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(r.internHits, 2);
  assert.equal(r.internBytesSaved, code.length * 2);
});

test("different text gets different modules", () => {
  const r = new WgslRegistry(null);
  let made = 0;
  const a = r.intern("fn a() {}", () => ({ id: ++made }));
  const b = r.intern("fn b() {}", () => ({ id: ++made }));
  assert.notEqual(a, b);
  assert.equal(made, 2);
  assert.equal(r.internHits, 0);
});

test("⭐ THE POINT: two graphs differing only in NodeBuffer ids share one module", () => {
  const r = new WgslRegistry(null);
  let made = 0;
  // The same graph built twice in one session: three's process-wide node
  // counter has moved, so its own interning sees two different programs.
  const first = canonicalizeWgsl("var<storage> NodeBuffer_55143: array<u32>; fn f() { NodeBuffer_55143[0]; }");
  const second = canonicalizeWgsl("var<storage> NodeBuffer_98221: array<u32>; fn f() { NodeBuffer_98221[0]; }");
  assert.equal(first, second, "canonicalisation must already make these identical");
  r.intern(first, () => ({ id: ++made }));
  r.intern(second, () => ({ id: ++made }));
  assert.equal(made, 1, "the driver must compile this graph once, not twice");
});

test("⛔ a key collision never hands back a module for different text", () => {
  const r = new WgslRegistry(null);
  let made = 0;
  const real = "fn real() {}";
  r.intern(real, () => ({ id: ++made, tag: "real" }));
  // Force the collision the length+hash key is meant to make unlikely, by
  // reaching into the cache: a stored entry whose text does NOT match must be
  // ignored rather than returned.
  const key = [...r._intern.keys()][0];
  r._intern.set(key, { code: "fn imposter() {}", module: { id: -1, tag: "imposter" } });
  const got = r.intern(real, () => ({ id: ++made, tag: "real-again" }));
  assert.equal(got.tag, "real-again", "a mismatched entry must be rebuilt, never reused");
  assert.equal(made, 2);
});

test("the hatch reverts to one module per call", () => {
  const r = new WgslRegistry(null);
  let made = 0;
  withFlag(false, () => {
    r.intern("fn x() {}", () => ({ id: ++made }));
    r.intern("fn x() {}", () => ({ id: ++made }));
  });
  assert.equal(made, 2, "__wgslInternModules = false must disable interning");
  assert.equal(r.internHits, 0);
});

test("the summary reports what never reached the driver", () => {
  const r = new WgslRegistry(null);
  const code = "fn main() {}";
  r.record("a", code);
  r.record("b", code);
  r.intern(code, () => ({}));
  r.intern(code, () => ({}));
  const s = r.summary();
  assert.equal(s.internedDuplicates, 1);
  assert.equal(typeof s.internedKB, "number");
});
