import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { getGltfLoader } from "../src/engine/gltfLoader.js";

// Negative-control seam: point these at mutated copies (no dedupe, no texture
// dispose) and the gates below must fail.
const { createRefCountedCache, assetPathMatches } = await import(
  process.env.ASSET_CACHE_IMPL ?? "../src/engine/refCountedCache.js"
);
const {
  acquireModelAsset,
  releaseModelAsset,
  instantiateModel,
  invalidateModelAsset,
  flushModelAssetCache,
  collectModelResources,
} = await import(process.env.MODEL_ASSET_IMPL ?? "../src/engine/modelAsset.js");
import {
  acquireTextureAsset,
  releaseTextureAsset,
  loadTextureAsset,
  invalidateTextureAsset,
} from "../src/engine/textureAsset.js";
import { selectRuntimeFiles } from "../src/editor/build/runtimeFiles.js";

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const disposeCounter = (target) => {
  const counter = { count: 0 };
  target.addEventListener("dispose", () => counter.count++);
  return counter;
};

test("refcounted cache: one load per key, disposal only after the last release", async () => {
  let loads = 0;
  const disposed = [];
  const cache = createRefCountedCache({
    load: async (key) => ({ key, n: ++loads }),
    dispose: (value) => disposed.push(value),
  });
  const [a, b] = await Promise.all([cache.acquire("x"), cache.acquire("x")]);
  assert.equal(a, b);
  assert.equal(loads, 1);
  assert.equal(cache.refsOf(a), 2);
  cache.release(a);
  await tick();
  assert.deepEqual(disposed, [], "a live holder keeps the value");
  // Release then re-acquire in the same turn (component re-attach) reuses it.
  cache.release(b);
  const again = await cache.acquire("x");
  assert.equal(again, a);
  assert.equal(loads, 1);
  cache.release(again);
  assert.equal(cache.release(again), false, "double release is ignored");
  await tick();
  assert.deepEqual(disposed, [a]);
  await cache.acquire("x");
  assert.equal(loads, 2, "evicted entries load fresh");
});

test("refcounted cache: invalidation retires without disposing under holders; failures do not poison", async () => {
  let loads = 0;
  const disposed = [];
  let fail = true;
  const cache = createRefCountedCache({
    load: async (key) => {
      if (key === "bad" && fail) throw new Error("missing");
      return { key, n: ++loads };
    },
    dispose: (value) => disposed.push(value),
  });
  const old = await cache.acquire("x");
  assert.equal(cache.invalidate((key) => key === "x"), 1);
  const fresh = await cache.acquire("x");
  assert.notEqual(fresh, old);
  assert.deepEqual(disposed, []);
  cache.release(old);
  assert.deepEqual(disposed, [old], "retired value disposes at its last release");

  await assert.rejects(cache.acquire("bad"));
  fail = false;
  assert.equal((await cache.acquire("bad")).key, "bad");
  assert.ok(assetPathMatches("C:/Proj/models/Hero.glb", "models/hero.glb"));
  assert.ok(!assetPathMatches("models/hero.glb", "models/superhero.glb"));
});

function fakeGltf({ skinned = false } = {}) {
  const map = new THREE.Texture();
  const normalMap = new THREE.Texture();
  const material = new THREE.MeshStandardMaterial({ map, normalMap });
  const geometry = new THREE.BoxGeometry();
  const scene = new THREE.Group();
  if (skinned) {
    const bone = new THREE.Bone();
    const count = geometry.attributes.position.count;
    geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4));
    geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(new Float32Array(count * 4).fill(0.25), 4));
    const mesh = new THREE.SkinnedMesh(geometry, material);
    scene.add(bone, mesh);
    mesh.bind(new THREE.Skeleton([bone]));
  } else {
    scene.add(new THREE.Mesh(geometry, material));
  }
  const clip = new THREE.AnimationClip("Run", -1, [new THREE.NumberKeyframeTrack(".x", [5, 6], [0, 1])]);
  return { gltf: { scene, animations: [clip] }, geometry, material, map, normalMap };
}

test("model cache: N entities share one parse, geometry and materials; textures dispose with the last one", async () => {
  const loader = getGltfLoader();
  const original = loader.loadAsync;
  let parses = 0;
  const fixture = fakeGltf({ skinned: true });
  loader.loadAsync = async () => {
    parses++;
    return fixture.gltf;
  };
  try {
    const counters = [fixture.geometry, fixture.material, fixture.map, fixture.normalMap].map(disposeCounter);
    const templates = await Promise.all([1, 2, 3].map(() => acquireModelAsset("models\\hero.glb")));
    assert.equal(parses, 1, "one parse for three entities");
    assert.equal(templates[0].clips[0].tracks[0].times[0], 0, "clips rebased once");

    const a = instantiateModel(templates[0]);
    const b = instantiateModel(templates[1]);
    const meshOf = (root) => root.children.find((child) => child.isMesh);
    assert.notEqual(a.root, b.root);
    assert.equal(meshOf(a.root).geometry, meshOf(b.root).geometry);
    assert.equal(meshOf(a.root).material, meshOf(b.root).material);
    assert.notEqual(meshOf(a.root).skeleton.bones[0], meshOf(b.root).skeleton.bones[0], "skinned clones get their own bones");
    assert.notEqual(meshOf(a.root).skeleton.bones[0], fixture.gltf.scene.children[0]);
    a.clips.push("appended");
    assert.equal(b.clips.length, 1, "clip arrays are per entity");

    releaseModelAsset(templates[0]);
    releaseModelAsset(templates[1]);
    flushModelAssetCache();
    assert.deepEqual(counters.map((c) => c.count), [0, 0, 0, 0], "nothing freed while an entity still renders it");
    releaseModelAsset(templates[2]);
    flushModelAssetCache();
    assert.deepEqual(counters.map((c) => c.count), [1, 1, 1, 1], "geometry, material and every map freed once");

    const next = await acquireModelAsset("models/hero.glb");
    assert.equal(parses, 2);
    invalidateModelAsset("C:/Project/models/Hero.glb");
    const reparsed = await acquireModelAsset("models/hero.glb");
    assert.equal(parses, 3, "an overwrite invalidates by any spelling");
    releaseModelAsset(next);
    releaseModelAsset(reparsed);
    flushModelAssetCache();
  } finally {
    loader.loadAsync = original;
  }
});

test("collectModelResources skips materials owned elsewhere and their maps", () => {
  const own = fakeGltf();
  const shared = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
  own.gltf.scene.add(new THREE.Mesh(new THREE.BoxGeometry(), shared));
  const found = collectModelResources(own.gltf.scene, (material) => material === shared);
  assert.ok(found.materials.has(own.material) && !found.materials.has(shared));
  assert.ok(found.textures.has(own.map) && found.textures.has(own.normalMap));
  assert.ok(!found.textures.has(shared.map));
});

test("texture cache: shared per path+options, private clones release on dispose", async () => {
  const proto = THREE.TextureLoader.prototype;
  const original = proto.loadAsync;
  let loads = 0;
  proto.loadAsync = async () => {
    loads++;
    return new THREE.Texture({ width: 4, height: 4 });
  };
  try {
    const opts = { colorSpace: THREE.SRGBColorSpace };
    const [a, b] = await Promise.all([acquireTextureAsset("tex/a.png", opts), acquireTextureAsset("tex\\a.png", opts)]);
    assert.equal(a, b);
    assert.equal(loads, 1);
    const tiled = await acquireTextureAsset("tex/a.png", { ...opts, wrapS: THREE.RepeatWrapping });
    assert.notEqual(tiled, a, "a baked wrap is a different cache entry");
    assert.equal(tiled.wrapS, THREE.RepeatWrapping);

    const privateCopy = await loadTextureAsset("tex/a.png", opts);
    assert.notEqual(privateCopy, a);
    assert.equal(privateCopy.source, a.source, "the clone shares the decoded image");
    assert.equal(loads, 2);

    const sharedDisposed = disposeCounter(a);
    releaseTextureAsset(a);
    releaseTextureAsset(b);
    await tick();
    assert.equal(sharedDisposed.count, 0, "the private copy still holds the decode");
    privateCopy.dispose();
    await tick();
    assert.equal(sharedDisposed.count, 1);

    releaseTextureAsset(tiled);
    const held = await acquireTextureAsset("tex/b.png", opts);
    invalidateTextureAsset("C:/proj/tex/b.png.meta");
    const refreshed = await acquireTextureAsset("tex/b.png", opts);
    assert.notEqual(refreshed, held, ".meta change retires the cached decode");
    releaseTextureAsset(held);
    releaseTextureAsset(refreshed);
  } finally {
    proto.loadAsync = original;
  }
});

test("player ships meshopt/basis decoders for models that declare them", () => {
  const manifest = {
    "player.html": {
      file: "player.js",
      isEntry: true,
      dynamicImports: [
        "node_modules/three/examples/jsm/libs/meshopt_decoder.module.js",
        "node_modules/three/examples/jsm/loaders/KTX2Loader.js",
      ],
    },
    "node_modules/three/examples/jsm/libs/meshopt_decoder.module.js": { file: "_engine/meshopt_decoder-A.js" },
    "node_modules/three/examples/jsm/loaders/KTX2Loader.js": { file: "_engine/KTX2Loader-G.js" },
  };
  const templateFiles = ["player.js", "_engine/meshopt_decoder-A.js", "_engine/KTX2Loader-G.js", "basis/basis_transcoder.wasm"];
  const plain = selectRuntimeFiles({ manifest, templateFiles }).files;
  assert.ok(!plain.includes("_engine/meshopt_decoder-A.js") && !plain.includes("basis/basis_transcoder.wasm"));
  const meshopt = selectRuntimeFiles({ manifest, templateFiles, meshoptModels: true }).files;
  assert.ok(meshopt.includes("_engine/meshopt_decoder-A.js"));
  const basis = selectRuntimeFiles({ manifest, templateFiles, basisModels: true }).files;
  assert.ok(basis.includes("_engine/KTX2Loader-G.js") && basis.includes("basis/basis_transcoder.wasm"));
});

test("glTF loader has meshopt and KTX2 decoders wired", () => {
  const loader = getGltfLoader();
  assert.equal(typeof loader.meshoptDecoder?.decodeGltfBufferAsync, "function");
  assert.equal(typeof loader.ktx2Loader?.load, "function");
});
