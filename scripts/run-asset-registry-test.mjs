/**
 * `engine.assets` — script-facing texture/material/geometry/audio/cubemap
 * access (roadmap: assets registry).
 *
 * Runs the real Engine and the real per-type loader modules
 * (materialAsset.js / geometryAsset.js / audio/AudioAsset.js), with a stub
 * `fetch` standing in for the project filesystem — exactly the pattern
 * `run-pool-test.mjs` uses for the real prefab expander. No renderer, no
 * browser: material/geometry loading is plain fetch+JSON/binary, and audio
 * loading short-circuits cleanly with no AudioContext (see the "audio" guard
 * in AudioAsset.js). Texture/cubemap decoding needs a real `Image` element,
 * which this environment doesn't have — those two are exercised only for
 * their caching/dedup contract, not an actual decoded pixel (cubemap image
 * decode is covered end-to-end by the headed-Chrome `run-cubemap-skybox.mjs`
 * instead).
 */
import nodeAssert from "node:assert/strict";
import { inspect, isDeepStrictEqual } from "node:util";

// Same rationale as run-pool-test.mjs: build assertion messages lazily so a
// failure on an object-heavy operand (Engine, Entity) can't OOM the process.
const brief = (value) =>
  value && typeof value === "object"
    ? inspect(value, { depth: 0, getters: false, customInspect: false, breakLength: 100 })
    : inspect(value);
const because = (message) => (message ? `${message} — ` : "");
const assert = {
  ok: nodeAssert.ok,
  equal(actual, expected, message) {
    if (Object.is(actual, expected)) return;
    throw new Error(`${because(message)}expected ${brief(expected)}, got ${brief(actual)}`);
  },
  notEqual(actual, expected, message) {
    if (!Object.is(actual, expected)) return;
    throw new Error(`${because(message)}expected anything but ${brief(expected)}`);
  },
  deepEqual(actual, expected, message) {
    if (isDeepStrictEqual(actual, expected)) return;
    throw new Error(`${because(message)}expected ${brief(expected)}, got ${brief(actual)}`);
  },
};

const stubElement = () => ({
  style: {},
  appendChild() {},
  removeChild() {},
  addEventListener() {},
  removeEventListener() {},
  setAttribute() {},
  classList: { add() {}, remove() {} },
  parentElement: null,
});
globalThis.document ??= {
  body: stubElement(),
  createElement: stubElement,
  addEventListener() {},
  removeEventListener() {},
  hidden: false,
};
globalThis.window ??= {
  devicePixelRatio: 1,
  addEventListener() {},
  removeEventListener() {},
  performance: globalThis.performance,
  crypto: globalThis.crypto,
};
globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(performance.now()), 16);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

// Stand-in project filesystem: `setAssetResolver` is identity, so a fetch
// URL is exactly the project path used below, and FIXTURES is keyed by it.
const FIXTURES = new Map(); // path -> { json } | { arrayBuffer }
globalThis.fetch = async (url) => {
  const fixture = FIXTURES.get(url);
  if (!fixture) {
    return {
      ok: false,
      status: 404,
      json: async () => { throw new Error(`404 (no fixture) ${url}`); },
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  }
  return {
    ok: true,
    status: 200,
    json: async () => fixture.json,
    arrayBuffer: async () => fixture.arrayBuffer,
  };
};

const { Engine, setAssetResolver, assetCatalog, registerAssetDefs } = await import("../src/engine/index.js");
const { encodeGeometryAsset } = await import("../src/engine/geometryAsset.js");

setAssetResolver(async (path) => path);

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error.message}`);
  }
};
const section = (title) => console.log(`\n${title}`);

const engine = new Engine();

// ---------------------------------------------------------------------------

section("engine.assets — wiring");

await check("engine.assets is an AssetRegistry instance owned by this engine", () => {
  assert.ok(engine.assets, "engine.assets is missing");
  assert.equal(typeof engine.assets.texture, "function");
  assert.equal(typeof engine.assets.material, "function");
  assert.equal(typeof engine.assets.geometry, "function");
  assert.equal(typeof engine.assets.audio, "function");
  assert.equal(typeof engine.assets.cubemap, "function");
});

// ---------------------------------------------------------------------------

section("engine.assets — findByName / byTag (catalog)");

assetCatalog.clear();
assetCatalog.register({ path: "textures/wood/color.png", tags: ["wood", "floor"] });
assetCatalog.register({ path: "textures/stone/color.png", tags: ["stone", "floor"] });
assetCatalog.register({ path: "prefabs/Zombie.prefab", tags: ["enemy", "undead"] });
assetCatalog.register({ path: "prefabs/Skeleton.prefab", tags: ["enemy", "undead", "ranged"] });

await check("findByName(): resolves a uniquely-named asset", () => {
  assert.equal(engine.assets.findByName("Zombie.prefab"), "prefabs/Zombie.prefab");
});

await check("findByName(): is case-insensitive", () => {
  assert.equal(engine.assets.findByName("zombie.prefab"), "prefabs/Zombie.prefab");
});

await check("findByName(): null for an unknown name", () => {
  assert.equal(engine.assets.findByName("nope.png"), null);
});

await check("findAllByName(): every path sharing a basename, sorted", () => {
  assert.deepEqual(
    engine.assets.findAllByName("color.png"),
    ["textures/stone/color.png", "textures/wood/color.png"],
  );
});

await check("findByName(): the ambiguous case still returns one deterministic path", () => {
  assert.equal(engine.assets.findByName("color.png"), "textures/stone/color.png");
});

await check("byTag(): every path carrying a tag, sorted", () => {
  assert.deepEqual(engine.assets.byTag("undead"), ["prefabs/Skeleton.prefab", "prefabs/Zombie.prefab"]);
});

await check("byTag(): empty array for a tag nothing carries", () => {
  assert.deepEqual(engine.assets.byTag("boss"), []);
});

await check("byTags(): mode 'any' unions", () => {
  assert.deepEqual(
    engine.assets.byTags(["ranged", "wood"]),
    ["prefabs/Skeleton.prefab", "textures/wood/color.png"],
  );
});

await check("byTags(): mode 'all' intersects", () => {
  assert.deepEqual(engine.assets.byTags(["enemy", "ranged"], "all"), ["prefabs/Skeleton.prefab"]);
});

await check("register(): re-registering a path replaces its tags, not merges them", () => {
  assetCatalog.register({ path: "prefabs/Zombie.prefab", tags: ["enemy"] }); // "undead" dropped
  assert.deepEqual(engine.assets.byTag("undead"), ["prefabs/Skeleton.prefab"]);
  assert.deepEqual(engine.assets.byTag("enemy"), ["prefabs/Skeleton.prefab", "prefabs/Zombie.prefab"]);
  assetCatalog.register({ path: "prefabs/Zombie.prefab", tags: ["enemy", "undead"] }); // restore for later checks
});

await check("registerAssetDefs(): bulk-loads entries the way a build's scene.assetIndex does", () => {
  registerAssetDefs([{ path: "audio/hit.audio", tags: ["combat"] }]);
  assert.equal(engine.assets.findByName("hit.audio"), "audio/hit.audio");
  assert.deepEqual(engine.assets.byTag("combat"), ["audio/hit.audio"]);
});

// ---------------------------------------------------------------------------

section("engine.assets — material");

FIXTURES.set("materials/glow.mat", {
  json: { color: "#ff8800", roughness: 0.25, metalness: 0.1 },
});

await check("material(): resolves the shared instance, applying the fetched def", async () => {
  const material = await engine.assets.material("materials/glow.mat");
  assert.ok(material, "expected a material instance");
  assert.equal(material.roughness, 0.25);
  assert.equal(material.metalness, 0.1);
});

await check("material(): repeat calls return the same shared instance", async () => {
  const a = await engine.assets.material("materials/glow.mat");
  const b = await engine.assets.material("materials/glow.mat");
  assert.equal(a, b);
});

await check("getMaterial(): mirrors the shared instance once loaded", async () => {
  const loaded = await engine.assets.material("materials/glow.mat");
  assert.equal(engine.assets.getMaterial("materials/glow.mat"), loaded);
});

await check("getMaterial(): null for a path never loaded", () => {
  assert.equal(engine.assets.getMaterial("materials/never-loaded.mat"), null);
});

// ---------------------------------------------------------------------------

section("engine.assets — geometry");

const quad = encodeGeometryAsset({
  version: 2,
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  indices: [0, 1, 2, 0, 2, 3],
  uvs: [0, 0, 1, 0, 1, 1, 0, 1],
  groups: [],
});
FIXTURES.set("meshes/quad.geom", { arrayBuffer: quad.buffer });

await check("geometry(): decodes the fetched .geom into a BufferGeometry", async () => {
  const geometry = await engine.assets.geometry("meshes/quad.geom");
  assert.ok(geometry.isBufferGeometry, "expected a BufferGeometry");
  assert.equal(geometry.getAttribute("position").count, 4);
});

await check("geometry(): repeat borrows share one instance (refcounted)", async () => {
  const a = await engine.assets.geometry("meshes/quad.geom");
  const b = await engine.assets.geometry("meshes/quad.geom");
  assert.equal(a, b);
  // Three borrows total from this section (the first check above + these
  // two) — release them all so later sections start from a clean cache.
  assert.equal(engine.assets.releaseGeometry(a), true);
  assert.equal(engine.assets.releaseGeometry(a), true);
  assert.equal(engine.assets.releaseGeometry(b), true);
});

await check("releaseGeometry(): false for an instance the cache doesn't own", () => {
  assert.equal(engine.assets.releaseGeometry({}), false);
});

// ---------------------------------------------------------------------------

section("engine.assets — audio (no AudioContext in this environment)");

await check("audio(): resolves null rather than hanging or throwing", async () => {
  const buffer = await engine.assets.audio("sounds/explosion.audio");
  assert.equal(buffer, null);
});

await check("getAudioBuffer(): null for a path with no decoded buffer", () => {
  assert.equal(engine.assets.getAudioBuffer("sounds/explosion.audio"), null);
});

// ---------------------------------------------------------------------------

section("engine.assets — texture (caching contract; decode needs a real DOM)");

await check("texture(): repeat calls in the same tick share one in-flight promise", () => {
  const a = engine.assets.texture("textures/icon.png");
  const b = engine.assets.texture("textures/icon.png");
  a.catch(() => {}); // no document.createElementNS here — the decode itself is expected to fail
  assert.equal(a, b, "expected the same promise for the same path+colorSpace");
});

await check("texture(): a different colorSpace is a different cache entry", () => {
  const a = engine.assets.texture("textures/icon2.png");
  const b = engine.assets.texture("textures/icon2.png", { colorSpace: "srgb" });
  a.catch(() => {});
  b.catch(() => {});
  assert.notEqual(a, b);
});

await check("texture(): a failed load evicts its cache entry", async () => {
  const a = engine.assets.texture("textures/icon3.png");
  await a.catch(() => {}); // decode fails without a real DOM — that's the point
  const b = engine.assets.texture("textures/icon3.png");
  b.catch(() => {});
  assert.notEqual(a, b, "expected a fresh promise once the previous one failed");
});

// ---------------------------------------------------------------------------

section("engine.assets — cubemap (loadCubemapAsset never rejects; resolves null on any failure)");

FIXTURES.set("skies/day.cubemap", {
  json: { version: 1, faces: { px: "a.png", nx: "a.png", py: "a.png", ny: "a.png", pz: "a.png", nz: "a.png" } },
});

await check("cubemap(): resolves null when face decode fails (no real DOM here)", async () => {
  const texture = await engine.assets.cubemap("skies/day.cubemap");
  assert.equal(texture, null);
});

await check("getCubemap(): null for a path with no loaded texture", () => {
  assert.equal(engine.assets.getCubemap("skies/day.cubemap"), null);
});

// ---------------------------------------------------------------------------

if (failures) {
  console.error(`\n${failures} asset-registry check(s) failed`);
  process.exit(1);
}
console.log("\nall asset-registry checks passed");
