import test from "node:test";
import assert from "node:assert/strict";
import {
  acquireFoliageEntry,
  acquireFoliageSurfaceMaterial,
  foliageMaterialKey,
  foliageMaterialSharing,
  releaseFoliageEntry,
  releaseFoliageSurfaceMaterial,
} from "../src/modules/foliage/foliageMaterial.js";
import { ATLAS_IDLE_KEEP, releaseAtlas, trimIdleAtlases } from "../src/modules/foliage/FoliageComponent.js";

/**
 * ONE MATERIAL PER SHADER, NOT PER COMPONENT (2026-09-12).
 *
 * three keys programs on node IDENTITY, so two structurally identical materials
 * built from two sets of freshly-minted `uniform()` nodes compile TWO programs.
 * `FoliageComponent` minted both per instance, and the user's Complex scene —
 * eleven foliage components — spent **2 597 kB of its 5 082 kB boot WGSL (51 %)**
 * on foliage, `Foliage · living surface` alone being 1 897 kB across 30 distinct
 * modules, with vertex the largest stage in the whole boot.
 *
 * The two claims that make sharing SAFE, and that these tests exist to hold:
 *
 *  1. the key contains everything that shapes the GRAPH — which is only
 *     `props.species` (`foliageAnimatedPosition` reads no other prop; every
 *     other branch is `builder.geometry.hasAttribute(...)`, which three keys on
 *     itself);
 *  2. the key contains everything written INTO the shared uniforms, because two
 *     holders both write them every frame and must write the same numbers or
 *     the last writer would silently win.
 */

const base = {
  species: "grass", drawnGrass: false, wind: true, windStrength: 1, windGustStrength: 0.6,
  windScale: 12, windTurbulence: 0.25,
  interaction: false, interactionStrength: 1, interactionRadius: 1,
};

/** Drain the module-level cache so each test starts from a known state. */
function drain(entries) { for (const e of entries) releaseFoliageEntry(e); }

test("⭐ identical props share ONE bucket — eleven components, one shader", () => {
  const held = Array.from({ length: 11 }, () => acquireFoliageEntry({ ...base }));
  const { buckets, components } = foliageMaterialSharing();
  assert.equal(components, 11);
  assert.equal(buckets, 1, "eleven identical components must not mint eleven materials");
  for (const e of held) assert.equal(e, held[0], "every holder must get the same entry");
  drain(held);
  assert.equal(foliageMaterialSharing().buckets, 0, "the last release must free the bucket");
});

test("species separates buckets — different textures, different shader", () => {
  const held = ["oak", "pine", "birch", "grass", "wildflowers"].map((species) =>
    acquireFoliageEntry({ ...base, species }));
  assert.equal(foliageMaterialSharing().buckets, 5);
  drain(held);
});

test("⛔ every prop written into the shared uniforms separates buckets", () => {
  // If any of these were missing from the key, two components would share one
  // uniform object and the last writer each frame would win.
  const varied = [
    { wind: false }, { windStrength: 2 }, { windGustStrength: 0.9 },
    { windScale: 20 }, { windTurbulence: 0.5 },
    { interaction: true }, { interactionStrength: 3 }, { interactionRadius: 4 },
  ];
  for (const patch of varied) {
    const key = Object.keys(patch)[0];
    assert.notEqual(
      foliageMaterialKey({ ...base, ...patch }),
      foliageMaterialKey(base),
      `"${key}" is written into the uniforms but does not separate the bucket`,
    );
  }
});

test("a prop that touches neither the graph nor the uniforms does NOT split the bucket", () => {
  // Scatter/appearance props are per-component data, not shader inputs — they
  // must keep sharing or the whole unit is defeated by ordinary authoring.
  for (const patch of [{ density: 0.9 }, { seed: 42 }, { maxInstances: 500 }, { leafColor: "#123456" }]) {
    assert.equal(foliageMaterialKey({ ...base, ...patch }), foliageMaterialKey(base),
      `${Object.keys(patch)[0]} must not split the bucket`);
  }
});

test("refcounting: the material survives until the LAST holder releases", () => {
  const a = acquireFoliageEntry({ ...base });
  const b = acquireFoliageEntry({ ...base });
  assert.equal(a, b);
  assert.equal(a.refs, 2);
  releaseFoliageEntry(a);
  assert.equal(a.refs, 1);
  assert.equal(foliageMaterialSharing().buckets, 1, "one holder remains; the bucket must live");
  releaseFoliageEntry(b);
  assert.equal(foliageMaterialSharing().buckets, 0);
});

test("⛔ a double release cannot drive the refcount negative", () => {
  const a = acquireFoliageEntry({ ...base });
  releaseFoliageEntry(a);
  releaseFoliageEntry(a);
  releaseFoliageEntry(a);
  assert.equal(a.refs, 0);
  assert.equal(foliageMaterialSharing().buckets, 0);
});

test("⭐ acquire-before-release: a rebuild landing on the same key keeps its material", () => {
  // `_rebuildShape`'s order. Reversed, the refcount would hit zero between the
  // two calls and dispose the material the component is about to reuse.
  const first = acquireFoliageEntry({ ...base });
  first.material = { disposed: false, dispose() { this.disposed = true; } };
  const second = acquireFoliageEntry({ ...base });   // acquire…
  releaseFoliageEntry(first);                        // …then release
  assert.equal(second, first, "same key must resolve to the same entry");
  assert.equal(first.material.disposed, false, "the shared material must survive the rebuild");
  releaseFoliageEntry(second);
});

/**
 * The impostor bake's SOURCE material. `acquireAtlas` caches the baked atlas on
 * a twelve-prop key (seed, height, colours, densities) — correct, those change
 * the picture — but minted a fresh `createFoliageSurfaceMaterial(props)` per
 * entry, and that reads only `props.species`. It cost double, because
 * `impostorBake.js` memoises its normal-pass material PER SOURCE MATERIAL, so a
 * fresh source defeated that memo too: `Foliage · surface` 44 modules for 6
 * distinct texts, `Impostor normal` 44 for 4.
 */
test("⭐ the bake source material is shared per SPECIES, not per atlas entry", () => {
  // Two components of one species differing in every atlas-key prop but species.
  const a = acquireFoliageSurfaceMaterial({ species: "oak", seed: 1, height: 6, leafColor: "#111111" });
  const b = acquireFoliageSurfaceMaterial({ species: "oak", seed: 99, height: 12, leafColor: "#999999" });
  assert.equal(a, b, "same species must reuse one bake material");
  assert.equal(a.refs, 2);
  const c = acquireFoliageSurfaceMaterial({ species: "pine", seed: 1, height: 6 });
  assert.notEqual(c, a, "a different species needs its own textures and shader");
  assert.equal(foliageMaterialSharing().bakeBuckets, 2);
  releaseFoliageSurfaceMaterial(a);
  releaseFoliageSurfaceMaterial(b);
  releaseFoliageSurfaceMaterial(c);
  assert.equal(foliageMaterialSharing().bakeBuckets, 2, "the last release PARKS each species' bake material");
  assert.equal(foliageMaterialSharing().bakeHolders, 0);
  assert.equal(acquireFoliageSurfaceMaterial({ species: "oak" }), a, "a later bake revives the parked material instead of minting one");
  releaseFoliageSurfaceMaterial(a);
});

test("⛔ a bake material survives until its last concurrent bake finishes", () => {
  // Bakes are queued per renderer, so two species-mates overlap: releasing the
  // first must not dispose the shader the second is still drawing through.
  const first = acquireFoliageSurfaceMaterial({ species: "grass", seed: 1 });
  first.material = { disposed: false, dispose() { this.disposed = true; } };
  const second = acquireFoliageSurfaceMaterial({ species: "grass", seed: 2 });
  releaseFoliageSurfaceMaterial(first);
  assert.equal(first.material.disposed, false, "the second bake still needs it");
  releaseFoliageSurfaceMaterial(second);
  assert.equal(first.material.disposed, false, "the last release parks it for the next species-mate's bake");
  const later = acquireFoliageSurfaceMaterial({ species: "grass", seed: 3 });
  assert.equal(later, first, "a bake queued after the others finished reuses the parked shader");
  releaseFoliageSurfaceMaterial(later);
});

test("the hatch gives every component its own material again", () => {
  const previous = globalThis.__foliageShareMaterials;
  globalThis.__foliageShareMaterials = false;
  try {
    const held = Array.from({ length: 4 }, () => acquireFoliageEntry({ ...base }));
    assert.equal(foliageMaterialSharing().buckets, 4, "__foliageShareMaterials = false must not share");
    drain(held);
  } finally {
    if (previous === undefined) delete globalThis.__foliageShareMaterials;
    else globalThis.__foliageShareMaterials = previous;
  }
  assert.equal(foliageMaterialSharing().buckets, 0);
});

/**
 * ⭐ THE ATLAS CACHE PARKS (09-14). `_rebuildShape` releases its atlas and asks
 * again only once the owning World is Ready; disposing on the last release made
 * every World regeneration re-bake every species — minutes of 10-25 s GPU
 * stalls on the Complex scene, with `Foliage · surface` / `Impostor normal`
 * pipeline ids climbing the whole time.
 */
function fakeAtlasEntry(cache, key, overrides = {}) {
  const entry = {
    refs: 1, key, cache, settled: true, idleAt: 0, error: null,
    atlas: { disposed: false, dispose() { this.disposed = true; } },
    material: { disposed: false, dispose() { this.disposed = true; } },
    ...overrides,
  };
  cache.set(key, entry);
  return entry;
}

test("⭐ a released atlas stays baked for the next holder of its key", () => {
  const cache = new Map();
  const entry = fakeAtlasEntry(cache, "oak|seed:21");
  const { atlas, material } = entry;
  releaseAtlas(entry);
  assert.equal(cache.get("oak|seed:21"), entry, "the last release must not evict the atlas");
  assert.equal(atlas.disposed, false);
  assert.equal(material.disposed, false);
  releaseAtlas(entry);
  assert.equal(entry.refs, 0, "a double release cannot drive the refcount negative");
});

test("parked atlases are bounded: only the oldest beyond ATLAS_IDLE_KEEP are disposed", () => {
  const cache = new Map();
  const entries = Array.from({ length: ATLAS_IDLE_KEEP + 3 }, (_, i) => fakeAtlasEntry(cache, `k${i}`));
  const atlases = entries.map(entry => entry.atlas);
  for (const entry of entries) releaseAtlas(entry);
  assert.equal(cache.size, ATLAS_IDLE_KEEP);
  for (let i = 0; i < 3; i++) assert.equal(atlases[i].disposed, true, `oldest parked atlas ${i} must be disposed`);
  for (let i = 3; i < entries.length; i++) assert.equal(cache.get(`k${i}`), entries[i]);
  const held = fakeAtlasEntry(cache, "held");
  trimIdleAtlases(cache, 0);
  assert.equal(cache.get("held"), held, "an atlas someone still holds is never trimmed");
  assert.equal(held.atlas.disposed, false);
});

test("an unsettled bake is never trimmed; a failed one is dropped so it can retry", () => {
  const cache = new Map();
  const baking = fakeAtlasEntry(cache, "baking", { settled: false, atlas: null });
  releaseAtlas(baking);
  assert.equal(cache.get("baking"), baking, "a bake still in flight keeps its slot for a re-acquire");
  const failed = fakeAtlasEntry(cache, "failed", { error: "boom", atlas: null });
  releaseAtlas(failed);
  assert.equal(cache.has("failed"), false, "a failed bake must not be served again");
});
