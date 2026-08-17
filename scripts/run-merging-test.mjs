/**
 * Static merging (src/engine/merging.js + src/engine/uberMaterial.js).
 *
 *   node scripts/run-merging-test.mjs
 *
 * Runs the real Engine headlessly. No renderer is created, which is the right
 * scope: what merging must never break is the scene-graph contract the editor
 * depends on — a click still hits the entity, a hidden thing stays hidden, a
 * mover is evicted rather than smeared, and turning it off puts the scene back
 * exactly as it was. Whether the merged draw LOOKS right is a question only a
 * GPU can answer, and `profile.drawCalls` + a screenshot answer it in the editor.
 */
import assert from "node:assert/strict";

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
};
globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(performance.now()), 16);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

const THREE = await import("three/webgpu");
const { Engine, registerBuiltInComponents } = await import("../src/engine/index.js");
const { buildUberMaterial, buildLayeredTexture, isUberCompatible, slotSignature } = await import("../src/engine/uberMaterial.js");

registerBuiltInComponents();

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}\n       ${error.message}`);
  }
};

const engine = new Engine();
const proxies = () => engine.scene.children.filter((o) => o.userData.mergeProxy);

/**
 * A stand-in for an imported PBR material: stock node material, distinct
 * geometry, distinct texture — the shape merging exists for and the shape
 * `batching.js` cannot touch.
 */
function makeTexture(width = 4, height = 4) {
  // A DataTexture has a readable `image` with width/height, which is all
  // `slotSignature` inspects. The pixel copy itself needs a canvas and is
  // exercised in the editor, not here.
  const texture = new THREE.DataTexture(new Uint8Array(width * height * 4), width, height);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function addMesh(name, { size = 1, texture = makeTexture(), roughness = 0.5 } = {}) {
  const entity = engine.createEntity(name);
  const mesh = entity.addComponent("mesh");
  // Distinct geometry per entity: identical geometry would be BATCHING's case.
  mesh.mesh.geometry = new THREE.BoxGeometry(size, size, size);
  const material = new THREE.MeshPhysicalNodeMaterial();
  material.map = texture;
  material.roughness = roughness;
  mesh.mesh.material = material;
  mesh.materialRenderable = true;
  return entity;
}

// ---- eligibility ------------------------------------------------------------

check("a stock PBR node material is uber-compatible", () => {
  assert.equal(isUberCompatible(new THREE.MeshPhysicalNodeMaterial()), true);
});

check("a material with a custom colorNode is refused", () => {
  const material = new THREE.MeshPhysicalNodeMaterial();
  material.colorNode = { isNode: true };
  assert.equal(isUberCompatible(material), false);
});

check("GI's inert giMonitorNode marker does NOT make a material unmergeable", () => {
  // The GI module hangs this on every material in the scene. Treating it as a
  // custom slot would make merging a no-op in exactly the scenes it is for.
  const material = new THREE.MeshPhysicalNodeMaterial();
  material.giMonitorNode = { isNode: true };
  assert.equal(isUberCompatible(material), true);
});

check("an emissive material is refused — it is a light source, not a table row", () => {
  const material = new THREE.MeshPhysicalNodeMaterial();
  material.emissive = new THREE.Color(0x223344);
  assert.equal(isUberCompatible(material), false);
});

check("a texture slot the uber material cannot express is refused", () => {
  const material = new THREE.MeshPhysicalNodeMaterial();
  // `aoMap`, not `roughnessMap` — three's aoMap reads a different UV set, so
  // it has no row representation. The ORM slots below DO have one.
  material.aoMap = makeTexture();
  assert.equal(isUberCompatible(material), false);
});

check("the ORM slots ARE expressible — this is what unblocked real PBR imports", () => {
  const material = new THREE.MeshPhysicalNodeMaterial();
  const orm = makeTexture();
  material.roughnessMap = orm;
  material.metalnessMap = orm;
  assert.equal(isUberCompatible(material), true);
});

check("a compressed texture is arrayable, not 'unreadable'", () => {
  // Basis/KTX2 sources carry their compressed mip bytes on the CPU, so they
  // are concatenated into a CompressedArrayTexture rather than decoded. This
  // returning "unreadable" silently disabled merging for every project that
  // had texture compression turned on.
  const compressed = new THREE.CompressedTexture([{ data: new Uint8Array(8), width: 4, height: 4 }], 4, 4);
  const signature = slotSignature(compressed);
  assert.notEqual(signature, "unreadable");
  assert.ok(String(signature).includes("4x4"), "size is still part of the signature");
  // Format is part of it: two block formats cannot share one array.
  const other = new THREE.CompressedTexture([{ data: new Uint8Array(8), width: 4, height: 4 }], 4, 4);
  other.format = 37496; // RGBA_ASTC_4x4 vs the default
  assert.notEqual(slotSignature(other), signature, "format separates arrays");
});

check("a compressed texture with no mip data is still refused", () => {
  assert.equal(slotSignature(new THREE.CompressedTexture([], 4, 4)), "unreadable");
});

check("a slot that HAS textures but cannot be stacked kills the merge, not the texture", () => {
  // The silent-corruption case. Mixing a compressed source with a plain one in
  // the same slot has no single array representation; before this, the slot
  // simply produced no layers and the material shaded with a flat constant —
  // the group rendered UNTEXTURED and nothing reported it.
  const plain = new THREE.MeshPhysicalNodeMaterial();
  plain.map = makeTexture();
  const compressed = new THREE.MeshPhysicalNodeMaterial();
  compressed.map = new THREE.CompressedTexture(
    [{ data: new Uint8Array(8), width: 4, height: 4 }], 4, 4,
  );
  assert.equal(buildUberMaterial([plain, compressed], plain), null);
});


check("slot signatures separate sizes and join empty slots", () => {
  assert.equal(slotSignature(null), null, "an empty slot matches anything");
  const a = slotSignature(makeTexture(8, 8));
  const b = slotSignature(makeTexture(8, 8));
  const c = slotSignature(makeTexture(16, 16));
  assert.equal(a, b, "same size, same wrapping → same array");
  assert.notEqual(a, c, "different sizes cannot share one array's layers");
});

// ---- grouping ---------------------------------------------------------------

const shared = makeTexture(8, 8);
const merged = [
  addMesh("wall_a", { texture: shared }),
  addMesh("wall_b", { texture: shared }),
  addMesh("wall_c", { texture: shared }),
  addMesh("wall_d", { texture: shared }),
];
const loner = addMesh("odd_one", { texture: makeTexture(32, 32) });

engine.merging.setEnabled(true);
engine.merging.sync();

check("distinct geometries sharing a pipeline state merge into one proxy", () => {
  assert.equal(proxies().length, 1, `expected 1 merge proxy, got ${proxies().length}`);
  assert.equal(engine.merging.groups[0].members.length, 4);
});

check("a mesh whose texture size matches nobody is left alone", () => {
  const mesh = loner.components.get("mesh").mesh;
  assert.equal(mesh.visible, true);
  assert.equal(mesh.userData.mergedInto, undefined);
});

check("merging saves one draw call per member beyond the first", () => {
  assert.equal(engine.merging.savedDrawCalls, 3);
});

check("the merged geometry carries every member's triangles", () => {
  const proxy = proxies()[0];
  const box = new THREE.BoxGeometry(1, 1, 1);
  assert.equal(proxy.geometry.index.count, box.index.count * 4);
});

check("every vertex is tagged with the material row it shades from", () => {
  const rows = proxies()[0].geometry.getAttribute("materialIndex");
  assert.ok(rows, "the merged geometry must carry a materialIndex attribute");
  assert.equal(rows.count, proxies()[0].geometry.getAttribute("position").count);
});

check("members are hidden but still in the graph, so picking still resolves", () => {
  for (const entity of merged) {
    const mesh = entity.components.get("mesh").mesh;
    assert.equal(mesh.visible, false, `${entity.name} should be hidden`);
    assert.ok(mesh.parent, `${entity.name} must stay in the scene graph`);
    // Raycaster tests layers, never visible — this is what keeps editor
    // picking, bounds and the selection outline working with no special case.
    assert.notEqual(mesh.layers.mask, 0, `${entity.name} must stay raycastable`);
  }
});

check("the proxy refuses to be picked, so a click resolves to one entity", () => {
  const hits = [];
  proxies()[0].raycast(new THREE.Raycaster(), hits);
  assert.equal(hits.length, 0);
});

check("positions are baked into world space", () => {
  merged[1].setPosition?.(0, 0, 0);
  const proxy = proxies()[0];
  assert.equal(proxy.matrixAutoUpdate, false, "the proxy must add no transform of its own");
  assert.ok(proxy.geometry.boundingSphere, "a merged proxy is culled as one object");
});

// ---- motion -----------------------------------------------------------------

check("a member that moves is evicted and never merged again", () => {
  const mover = merged[0];
  mover.object3D.position.set(5, 0, 0);
  engine.scene.updateMatrixWorld(true);
  engine.merging.sync(); // notices the motion, marks dirty
  engine.merging.sync(); // rebuilds without it
  const mesh = mover.components.get("mesh").mesh;
  assert.equal(mesh.visible, true, "the mover must be drawing itself again");
  assert.equal(mesh.userData.mergedInto, null);
  assert.equal(engine.merging.groups[0]?.members.length, 3, "the other three stay merged");
});

check("an invalidation storm costs neither a rebuild per frame nor a texture decode", () => {
  // THE REGRESSION THIS EXISTS FOR. `hierarchy-changed` fires constantly in play
  // mode — a script spawning a projectile, a pool recycling one — and merging
  // subscribes to it. Rebuilding the texture arrays on each one measured 351 ms
  // CPU frames, a 6 GB JS heap and 3 fps on the real scene. Two things must hold:
  // the throttle bounds how often geometry is rebuilt, and the cache means a
  // rebuild that changed no materials re-decodes nothing.
  const before = proxies()[0]?.material;
  assert.ok(before, "precondition: a group is merged");
  let rebuilds = 0;
  for (let i = 0; i < 60; i++) {
    const count = engine.merging._rebuildCount;
    engine.merging.invalidate();
    engine.merging.sync();
    if (engine.merging._rebuildCount !== count) rebuilds++;
  }
  assert.ok(rebuilds <= 1, `60 invalidations must not cost 60 rebuilds — cost ${rebuilds}`);
  // And a LOADING storm must cost ZERO until the scene goes quiet. Every one of
  // an imported scene's meshes invalidates as its geometry resolves; rebuilding
  // through that copied every merged vertex in the scene, over and over, and
  // took the heap from ~700 MB to 3.3 GB.
  engine.merging._urgent = false;
  const settled = engine.merging._rebuildCount;
  for (let i = 0; i < 200; i++) {
    engine.merging.invalidate(); // each one re-arms the settle timer
    engine.merging.sync();
  }
  assert.equal(
    engine.merging._rebuildCount,
    settled,
    "a scene that is still changing must not be merged mid-flight",
  );
  assert.equal(
    proxies()[0].material,
    before,
    "the uber material must be reused across rebuilds, not rebuilt from source pixels",
  );
});

check("play mode freezes the merge instead of reacting to a running game", () => {
  // The second half of the same regression. In play mode `hierarchy-changed`
  // fires for every spawned projectile, and each rebuild that misses the
  // material cache allocates the group's whole texture footprint again —
  // measured climbing 613 → 741 → 869 MB of texture memory in twenty seconds.
  engine.playing = true;
  const count = engine.merging._rebuildCount;
  for (let i = 0; i < 30; i++) {
    engine.emit("hierarchy-changed");
    engine.merging.sync();
  }
  assert.equal(
    engine.merging._rebuildCount,
    count,
    "a running game's scene-graph churn must not rebuild a static merge",
  );
  engine.playing = false;
});

// ---- teardown ---------------------------------------------------------------

check("turning merging off restores the scene exactly", () => {
  engine.merging.setEnabled(false);
  assert.equal(proxies().length, 0, "every proxy must be removed");
  for (const entity of merged) {
    const mesh = entity.components.get("mesh").mesh;
    assert.equal(mesh.visible, true, `${entity.name} must be visible again`);
    assert.equal(mesh.userData.mergedInto, null);
  }
});

check("a member whose component was disabled stays hidden after teardown", () => {
  const entity = addMesh("disabled_one", { texture: shared });
  const friends = [
    addMesh("friend_a", { texture: shared }),
    addMesh("friend_b", { texture: shared }),
    addMesh("friend_c", { texture: shared }),
  ];
  engine.merging.setEnabled(true);
  engine.merging.sync();
  const component = entity.components.get("mesh");
  assert.equal(component.mesh.visible, false, "precondition: it merged");
  component.setEnabled(false);
  engine.merging.setEnabled(false);
  assert.equal(
    component.mesh.visible,
    false,
    "restoring a blanket `true` would resurrect a mesh the author disabled",
  );
  for (const friend of friends) {
    assert.equal(friend.components.get("mesh").mesh.visible, true);
  }
});

check("meshes scattered across a world split into local proxies instead of being refused", () => {
  // The Bistro case: one shared material, members spread far enough apart that
  // ONE proxy would be world-sized. Before the spatial split this returned zero
  // groups and said nothing — 1407 of 1532 meshes died on that line.
  const shared = makeTexture();
  for (let i = 0; i < 9; i++) {
    const entity = addMesh(`scattered${i}`, { texture: shared });
    // Three clusters of three, a long way apart relative to a unit box.
    entity.object3D.position.set((i % 3) * 0.5 + Math.floor(i / 3) * 500, 0, 0);
  }
  engine.scene.updateMatrixWorld(true);
  // Off/on rather than invalidate(): a plain invalidation is subject to
  // MIN_REBUILD_INTERVAL_MS, and earlier checks in this file have already
  // rebuilt, so the throttle would swallow it and the assertion would read a
  // stale zero as a failure of the split.
  engine.merging.setEnabled(false);
  engine.merging.setEnabled(true);
  engine.merging.sync();
  assert.ok(engine.merging.groups.length >= 2, `expected several local proxies, got ${engine.merging.groups.length}`);
  for (const group of engine.merging.groups) {
    assert.ok(group.members.length >= 3, "each proxy still clears the threshold");
  }
});

// ---- who owns `visible` -----------------------------------------------------

check("re-enabling a merged member does not resurrect it", () => {
  // THE LOOP, in one assertion. Six places in MeshComponent wrote `mesh.visible`
  // directly, and any of them firing while merging held the mesh un-hid a
  // member — so its geometry drew twice, once as itself and once inside the
  // proxy — after which `component-changed:mesh` (which merging invalidates on)
  // went out.
  //
  // Live on Bistro that read as `[rebuild #27, asked for by
  // component-changed:mesh]` then `#28`, with GI rebuilding between them because
  // the mesh set it collects flips between proxies and members (it built at 580
  // meshes and then at 1034 on the SAME scene). Each of those GI rebuilds cost a
  // material compile wave of 68-77 SECONDS, and the editor never finished
  // loading.
  //
  // `onEnable` is used as the trigger because it is synchronous. The path that
  // actually fired on Bistro is `#applySharedMaterial`, reached from a `.mat`
  // subscription behind an `await loadMaterialAsset(...)` that never resolves in
  // a headless run — an earlier version of this test drove it that way and
  // passed against the BROKEN code, which is worse than no test at all. Both
  // paths now go through the same `#applyVisibility`.
  const shared = makeTexture();
  const members = [
    addMesh("owner_a", { texture: shared }),
    addMesh("owner_b", { texture: shared }),
    addMesh("owner_c", { texture: shared }),
  ];
  engine.merging.setEnabled(false);
  engine.merging.setEnabled(true);
  engine.merging.sync();

  const component = members[0].components.get("mesh");
  assert.equal(component.mesh.visible, false, "precondition: it merged and was hidden");
  assert.ok(component.mesh.userData.mergedInto, "precondition: the proxy's claim is marked");

  component.setEnabled(false);
  component.setEnabled(true);

  assert.equal(
    component.mesh.visible,
    false,
    "THE REGRESSION: a merged member was resurrected — it now draws twice, and the " +
      "component-changed it emits restarts the merge/GI rebuild loop",
  );
});

check("a rebuild that changed nothing reuses the cached uber material", () => {
  // "Merge once, then hit the cache." The cache is keyed on the group's material
  // list, and that list used to be in MEMBER-ENCOUNTER order — which merging
  // re-derives on every rebuild, so the same material set could key differently
  // and miss, re-rasterising texture arrays that were already resident. Row
  // order is now canonical (sorted by uuid); "every vertex is tagged with the
  // material row it shades from" above is what guards the other half of that
  // change, since `rowOf` and the uber's layer order must stay the same
  // numbering.
  const shared = makeTexture();
  const trio = [
    addMesh("cached_a", { texture: shared }),
    addMesh("cached_b", { texture: shared }),
    addMesh("cached_c", { texture: shared }),
  ];
  assert.equal(trio.length, 3);
  engine.merging.setEnabled(false);
  engine.merging.setEnabled(true);
  engine.merging.sync();
  const first = engine.merging.groups.map((g) => g.built);
  assert.ok(first.length >= 1, "precondition: something merged");

  // NOT off/on here, unlike the other checks: `setEnabled(false)` calls
  // `#clearCache()` — correctly, since turning merging off must give the
  // texture memory back — which would destroy the very thing under test. So
  // drive a real rebuild instead, winding back the two clocks that would
  // otherwise defer it (SETTLE_MS and MIN_REBUILD_INTERVAL_MS).
  engine.merging.invalidate("test");
  engine.merging._dirtiedAt = -Infinity;
  engine.merging._lastRebuildAt = -Infinity;
  engine.merging.sync();
  const second = engine.merging.groups.map((g) => g.built);
  assert.ok(engine.merging._rebuildCount > 0, "precondition: a rebuild actually ran");

  assert.equal(second.length, first.length, "the same scene must produce the same groups");
  for (let i = 0; i < first.length; i++) {
    assert.equal(
      second[i],
      first[i],
      "THE REGRESSION: an unchanged scene rebuilt its uber material instead of hitting the cache — " +
        "that re-rasterises every texture array, and on a GI scene the fresh material costs a compile wave",
    );
  }
});

// ---- the scene-wide texture budget ------------------------------------------

check("merging stops at a scene-wide texture ceiling, not just a per-group one", () => {
  // THE BISTRO CASE. Every one of 112 groups was individually affordable — the
  // largest cost ~1.5 MB per draw saved against a 24 MB allowance — and they
  // summed to 630 MB of PURE ADDITION, because the originals stay resident for
  // the hidden members. A per-item budget with no aggregate is a rate limit,
  // not a budget.
  //
  // The ceiling is lowered rather than the textures enlarged: reproducing the
  // real 256 MB default end-to-end would mean allocating ~170 MB of pixels
  // (`#uberFor` stacks actual image data, so the sizes cannot be faked), which
  // would make this suite the memory problem it exists to catch. The RATIOS are
  // what matter and they are preserved — each cluster passes both per-group
  // tests, so only the aggregate can refuse anything.
  const fresh = new Engine();
  fresh.merging.textureBudgetBytes = 12 * 1024 * 1024;

  // Six clusters of eight, each member with its own 256² map: 9 layers *
  // 262 kB * 4/3 ~ 3.1 MB per cluster against 7 draws saved (~450 kB each, far
  // under MAX_BYTES_PER_DRAW_SAVED). Six clusters offer ~19 MB into a 12 MB
  // ceiling, so roughly half must be refused.
  for (let cluster = 0; cluster < 6; cluster++) {
    for (let i = 0; i < 8; i++) {
      const entity = fresh.createEntity(`big_${cluster}_${i}`);
      const mesh = entity.addComponent("mesh");
      mesh.mesh.geometry = new THREE.BoxGeometry(1, 1, 1);
      const material = new THREE.MeshPhysicalNodeMaterial();
      material.map = makeTexture(256, 256);
      material.roughness = 0.5;
      mesh.mesh.material = material;
      mesh.materialRenderable = true;
      // Tight clusters, far apart: one bucket each for #splitByLocality.
      entity.object3D.position.set(cluster * 1000 + i * 0.1, 0, 0);
    }
  }
  fresh.scene.updateMatrixWorld(true);
  fresh.merging.setEnabled(true);
  fresh.merging.sync();

  const spent = fresh.merging.groups.reduce((n, g) => n + (g.textureBytes ?? 0), 0);
  assert.ok(
    fresh.merging.groups.length >= 2,
    `precondition: expected affordable groups to form, got ${fresh.merging.groups.length}`,
  );
  assert.ok(
    fresh.merging.groups.length < 6,
    "precondition: the ceiling must actually refuse something, or this asserts nothing",
  );
  assert.ok(
    spent <= fresh.merging.textureBudgetBytes,
    `THE REGRESSION: merging committed ${(spent / 1048576).toFixed(1)} MB of texture arrays, ` +
      `over the ${(fresh.merging.textureBudgetBytes / 1048576).toFixed(0)} MB scene ceiling`,
  );
});

// ---- placeholders never merge -----------------------------------------------

check("a scene with assets still streaming merges NOTHING until they land", () => {
  // Two Bistro loads, two halves of one regression. Rebuild #10: 1426 meshes in
  // 4 mega-groups, because `materialRenderable` goes true on the PLACEHOLDER
  // and they all looked alike. After gating on `assetLoadsPending` alone: the
  // transcode waves pause for seconds without being done, the settle timer
  // released in every gap, and one load committed INCREMENTAL generations at
  // 887 then 952 meshes — each staging fresh texture arrays and handing GI a
  // different mesh set. Hence the shape asserted here: pending anywhere means
  // no rebuild at all; the bound turns that into "merge what arrived, skip the
  // stragglers"; arrival folds everyone in.
  const fresh = new Engine();
  const shared = makeTexture();
  const add = (name) => {
    const entity = fresh.createEntity(name);
    const mesh = entity.addComponent("mesh");
    mesh.mesh.geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshPhysicalNodeMaterial();
    material.map = shared;
    material.roughness = 0.5;
    mesh.mesh.material = material;
    mesh.materialRenderable = true;
    return entity;
  };
  const pending = add("streaming");
  const ready = [add("ready_a"), add("ready_b"), add("ready_c")];
  pending.components.get("mesh")._materialAssetLoading = true;
  fresh.scene.updateMatrixWorld(true);

  // Phase 1 — the hard hold. Wind every release clock: only the pending gate
  // can be what defers.
  fresh.merging.setEnabled(true);
  fresh.merging._dirtiedAt = -Infinity;
  fresh.merging._lastRebuildAt = -Infinity;
  fresh.merging.sync();
  assert.equal(
    fresh.merging.groups.length,
    0,
    "THE REGRESSION: merging committed a generation while assets were still streaming",
  );

  // Phase 2 — the bound. A load stuck past MAX_LOAD_DEFER_MS merges what has
  // arrived, and the straggler is excluded rather than baked as a placeholder.
  // An origin infinitely far in the past. NOT a small positive number:
  // `performance.now()` counts from PROCESS start, so early in this suite
  // `now - 1` is a few seconds and the bound would still be holding. And the
  // pending count must read as ALREADY SEEN — the bound is progress-aware, so
  // a count it has not seen yet would re-arm the very origin being wound back.
  fresh.merging._deferHoldStart = -Infinity;
  fresh.merging._lastPendingCount = 1;
  fresh.merging._dirtiedAt = -Infinity;
  fresh.merging._lastRebuildAt = -Infinity;
  fresh.merging.sync();
  const pendingMesh = pending.components.get("mesh").mesh;
  assert.ok(
    ready.every((e) => e.components.get("mesh").mesh.userData.mergedInto),
    "past the bound, the arrived meshes must merge",
  );
  assert.equal(
    pendingMesh.userData.mergedInto ?? null,
    null,
    "THE REGRESSION: a placeholder-material mesh was baked into a group",
  );
  assert.equal(pendingMesh.visible, true, "it must keep drawing its placeholder meanwhile");

  // Phase 3 — arrival folds it in through the normal invalidation path.
  pending.components.get("mesh")._materialAssetLoading = false;
  fresh.merging.invalidate("test");
  fresh.merging._dirtiedAt = -Infinity;
  fresh.merging._lastRebuildAt = -Infinity;
  fresh.merging.sync();
  assert.ok(
    pending.components.get("mesh").mesh.userData.mergedInto,
    "an arrived mesh must join the group on the next rebuild",
  );
});

// ---- CPU texels are surrendered after upload --------------------------------

check("an uber array texture frees its staged CPU texels once the GPU owns them", () => {
  // The staged arrays are merging's single largest JS-heap cost (Bistro at
  // world scale: ~630 MB per generation), and three keeps them referenced
  // forever after upload. `onUpdate` is what the common renderer calls after
  // `backend.updateTexture` — invoking it here is exactly the upload contract.
  const { texture } = buildLayeredTexture(
    [makeTexture(8, 8), makeTexture(8, 8)],
    { neutral: [255, 255, 255, 255], colorSpace: THREE.SRGBColorSpace },
  );
  assert.equal(
    typeof texture.onUpdate,
    "function",
    "THE REGRESSION: no after-upload release hook — every staged texel array lives as long as the cache entry",
  );
  assert.ok(texture.image.data instanceof Uint8Array, "before upload the staging copy must stay (headless runs never upload)");
  texture.onUpdate(texture);
  assert.equal(texture.image.data, null, "the staged texels must be surrendered after upload");
  assert.equal(texture.image.width, 8, "dimensions must survive — the backend sizes bind groups from them");
  assert.equal(texture.image.depth, 3, "layer count must survive with them");
  assert.equal(texture.onUpdate, null, "the hook is one-shot");
  assert.equal(texture.version, 1, "nothing may have re-staged a released texture (version bumps only at creation)");
});

// ---- SAME-MATERIAL merging: the free path -----------------------------------

/**
 * Meshes that already share ONE material instance. This is what an imported
 * environment is mostly made of — Bistro's main pass submitted 484 draws over
 * 161 materials, one of them drawn 40 times — and it needs no shading table, so
 * it must cost no texture memory and mint no new material.
 */
function sameMaterialScene(material, { count = 4, strip = null } = {}) {
  const fresh = new Engine();
  for (let i = 0; i < count; i++) {
    const entity = fresh.createEntity(`shared_${i}`);
    const mesh = entity.addComponent("mesh");
    mesh.mesh.geometry = new THREE.BoxGeometry(1 + i * 0.01, 1, 1);
    // Every member shares the SAME material object — that is the whole premise.
    mesh.mesh.material = material;
    mesh.materialRenderable = true;
    if (strip && i === 0) mesh.mesh.geometry.deleteAttribute(strip);
  }
  fresh.merging.setEnabled(true);
  fresh.merging.sync();
  return fresh;
}

const sharedPbr = new THREE.MeshPhysicalNodeMaterial();
sharedPbr.map = makeTexture(64, 64);
const sharedScene = sameMaterialScene(sharedPbr);
const sharedProxy = sharedScene.scene.children.filter((o) => o.userData.mergeProxy);

check("meshes sharing one material merge for ZERO texture memory", () => {
  assert.equal(sharedProxy.length, 1, `expected 1 proxy, got ${sharedProxy.length}`);
  const group = sharedScene.merging.groups[0];
  assert.equal(group.members.length, 4);
  assert.equal(group.sameMaterial, true, "the group must take the free path");
  assert.equal(
    group.textureBytes, 0,
    "THE REGRESSION: a one-material group built a one-layer array texture — a full copy of every source map to express a table with a single row",
  );
  assert.equal(group.built, null, "no uber material may be minted");
});

check("the proxy wears the AUTHOR'S material, not a copy", () => {
  // Identity, not equality: this is what makes the merge free for GI (no new
  // shader variant to compile) and what makes a .mat edit land live.
  assert.equal(sharedProxy[0].material, sharedPbr);
});

check("a same-material merge writes no materialIndex attribute", () => {
  assert.equal(
    sharedProxy[0].geometry.getAttribute("materialIndex"), undefined,
    "the material shades from its own uniforms and never samples a row",
  );
  assert.ok(sharedProxy[0].geometry.getAttribute("position"), "positions must still be there");
});

check("a material the UBER path refuses still merges when it is shared", () => {
  // The headline case. Bistro's imported materials carry custom nodes and maps
  // outside UBER_SLOTS, so `uberIncompatibility` turned every one of them away
  // and they drew one-mesh-per-call forever. None of those reasons apply when
  // there is no table to build.
  const exotic = new THREE.MeshPhysicalNodeMaterial();
  exotic.colorNode = { isNode: true };
  exotic.aoMap = makeTexture();
  assert.equal(isUberCompatible(exotic), false, "precondition: the uber path must refuse this");
  const scene = sameMaterialScene(exotic);
  const built = scene.scene.children.filter((o) => o.userData.mergeProxy);
  assert.equal(built.length, 1, "a shared exotic material must still collapse to one draw");
  assert.equal(scene.merging.groups[0].textureBytes, 0);
});

check("an emissive material is refused even when shared — GI keys emitters on the mesh", () => {
  // The one refusal that survives: merging two emissive meshes moves the light
  // to the combined centroid.
  const lamp = new THREE.MeshPhysicalNodeMaterial();
  lamp.emissive = new THREE.Color(0x884400);
  const scene = sameMaterialScene(lamp);
  assert.equal(scene.scene.children.filter((o) => o.userData.mergeProxy).length, 0);
});

check("an emissiveNode material is refused even with material.emissive BLACK", () => {
  // ⚠ THE REGRESSION THIS EXISTS TO CATCH (Bistro 2026-08-17). Engine material
  // assets put emission in `emissiveNode` and leave the top-level `emissive`
  // field at stale black — GI's own resolver says so and reads the node. The
  // refusal above tested only the stale field, so every authored emissive mesh
  // read "not emissive", merged, and GI then fitted ONE emitter to the combined
  // bounds: the live ledger showed every top emitter as a `Merged(N)` at
  // fill=0.001, which §13.7g's sparse correction dims 1000x. The user's report
  // was "a 1000 emission strength mesh does not cast any light at all".
  const lamp = new THREE.MeshPhysicalNodeMaterial();
  lamp.emissiveNode = { isNode: true };
  assert.equal(lamp.emissive.getHex(), 0x000000, "precondition: the stale field must read black");
  const scene = sameMaterialScene(lamp);
  assert.equal(
    scene.scene.children.filter((o) => o.userData.mergeProxy).length, 0,
    "a node-emissive mesh must not be welded into a proxy",
  );
});

check("a member missing uv splits off instead of stripping uv from the rest", () => {
  // `mergeGeometries` keeps an attribute only when EVERY member has it, so
  // without an attribute-set key one uv-less mesh silently strips the channel
  // off the whole group and the material samples something that is not there —
  // three says "Vertex attribute uv not found on geometry" and the merge shades
  // from garbage.
  const material = new THREE.MeshPhysicalNodeMaterial();
  material.map = makeTexture();
  const scene = sameMaterialScene(material, { count: 4, strip: "uv" });
  const built = scene.scene.children.filter((o) => o.userData.mergeProxy);
  assert.equal(built.length, 1, "the three uv-ful members still merge");
  assert.equal(scene.merging.groups[0].members.length, 3, "the uv-less member must not join them");
  assert.ok(built[0].geometry.getAttribute("uv"), "THE REGRESSION: uv was stripped from the merge");
});

check("small props spread down a street merge into chunks instead of dying as singletons", () => {
  // ⚠ THE REGRESSION THIS GUARDS, measured on Bistro 2026-08-17: the main pass
  // drew one material 31 times and another 29 times with same-material merging
  // fully enabled and every gate passed. `#splitByLocality` had already diced
  // them into singletons, because it sized its cell from the MEMBERS' radius —
  // ~0.4 m for a café chair — so forty chairs down a 115 m street landed in
  // forty cells, every one below MIN_GROUP_SIZE. The rule refused to merge
  // small objects at ANY distance, which is backwards: they are the cheapest
  // and most numerous thing to merge.
  const material = new THREE.MeshPhysicalNodeMaterial();
  material.map = makeTexture();
  const fresh = new Engine();
  for (let i = 0; i < 30; i++) {
    const entity = fresh.createEntity(`prop_${i}`);
    const mesh = entity.addComponent("mesh");
    mesh.mesh.geometry = new THREE.BoxGeometry(1, 1, 1);
    mesh.mesh.material = material;
    mesh.materialRenderable = true;
    // Unit-sized props at 3 units apart: far apart relative to themselves,
    // close together relative to the street.
    entity.object3D.position.set(i * 3, 0, 0);
  }
  fresh.scene.updateMatrixWorld(true);
  fresh.merging.setEnabled(true);
  fresh.merging.sync();
  const merged = fresh.merging.groups.reduce((n, g) => n + g.members.length, 0);
  assert.ok(
    fresh.merging.groups.length >= 2,
    `expected several per-block proxies, got ${fresh.merging.groups.length}`,
  );
  assert.ok(
    merged >= 20,
    `THE REGRESSION: only ${merged} of 30 props merged — the locality cell shrank with the props`,
  );
  // Still CHUNKED, not one street-long blob: culling has to survive the fix.
  assert.ok(
    fresh.merging.groups.length >= 3,
    "a 87-unit street must still dice into several proxies, not merge whole",
  );
});

check("a GLB that bakes transforms into vertices still measures as a big scene", () => {
  // ⚠ THE BUG THIS GUARDS, and it shipped for one boot. The locality floor is
  // scene-relative, and the first version measured the scene with
  // `setFromMatrixPosition(mesh.matrixWorld)`. Bistro's exporter baked every
  // node transform into the VERTEX DATA and left all 1500 matrices at identity,
  // so the scene measured **0 m across** — the floor evaluated to zero and the
  // whole fix was inert. The failure is invisible from the outcome alone: a zero
  // floor looks exactly like a floor that did not need to bind. The merge
  // report's "Scene diagonal 0m" on a 109 × 115 m city is what caught it.
  const material = new THREE.MeshPhysicalNodeMaterial();
  material.map = makeTexture();
  const fresh = new Engine();
  for (let i = 0; i < 30; i++) {
    const entity = fresh.createEntity(`baked_${i}`);
    const mesh = entity.addComponent("mesh");
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    // The offset lives in the GEOMETRY, and the entity never moves — exactly
    // what `gltf-transform`'s flatten/dedup pass produces.
    geometry.translate(i * 3, 0, 0);
    mesh.mesh.geometry = geometry;
    mesh.mesh.material = material;
    mesh.materialRenderable = true;
  }
  fresh.scene.updateMatrixWorld(true);
  fresh.merging.setEnabled(true);
  fresh.merging.sync();
  assert.ok(
    fresh.merging._sceneDiagonal > 50,
    `THE REGRESSION: baked transforms measured the scene at ${(fresh.merging._sceneDiagonal ?? 0).toFixed(1)}m instead of ~87m`,
  );
  const merged = fresh.merging.groups.reduce((n, g) => n + g.members.length, 0);
  assert.ok(merged >= 20, `expected the props to chunk, only ${merged} of 30 merged`);
});

check("a merged proxy never exceeds the triangle budget GI can represent", () => {
  // ⚠ THE ARTIFACT THIS GUARDS, reported by the user on the live scene: "when I
  // start moving the camera, there are black patches in some area, that starts
  // filling with light, or turning black again". A proxy is ONE object to every
  // downstream system, and those are budgeted per object. When the locality
  // floor let groups grow, Bistro produced a 166 676-triangle proxy — over GI's
  // 150 000 `bvh cap`, so it was dropped from exact reflections entirely — and
  // pushed the surface-record triangle pool to 4 241 682 of 2 097 152, taking
  // cells that fall back to coarse voxel-box hits from 24 701 to 300 306.
  //
  // Merging must not hand a downstream system an object it cannot represent.
  const material = new THREE.MeshPhysicalNodeMaterial();
  material.map = makeTexture();
  const fresh = new Engine();
  // 12 meshes x ~15k triangles = ~186k, comfortably over the 120k budget.
  for (let i = 0; i < 12; i++) {
    const entity = fresh.createEntity(`heavy_${i}`);
    const mesh = entity.addComponent("mesh");
    // A sphere is the cheapest way to get a real index count up.
    mesh.mesh.geometry = new THREE.SphereGeometry(1, 90, 84);
    mesh.mesh.material = material;
    mesh.materialRenderable = true;
    entity.object3D.position.set(i * 0.5, 0, 0);
  }
  fresh.scene.updateMatrixWorld(true);
  fresh.merging.setEnabled(true);
  fresh.merging.sync();
  assert.ok(fresh.merging.groups.length >= 2, "an over-budget group must CHUNK, not merge whole");
  for (const group of fresh.merging.groups) {
    const tris = group.mesh.geometry.index.count / 3;
    assert.ok(
      tris <= 120_000,
      `THE REGRESSION: a proxy carries ${Math.round(tris)} triangles — GI drops it above 150k`,
    );
  }
  // And it must still be a merge, not a silent refusal back to one draw each.
  const merged = fresh.merging.groups.reduce((n, g) => n + g.members.length, 0);
  assert.ok(merged >= 9, `chunking must keep the draw saving, only ${merged} of 12 merged`);
});

check("editing a shared material does NOT invalidate — the proxy already has it", () => {
  // ⚠ THE TRAP THIS GUARDS. A same-material group carries its material (GI and
  // the reports read it) and an EMPTY signature list. Walk `materials` instead
  // of `signatures` in `#watchForMaterialEdits` and every sweep compares a live
  // signature against `undefined`, differs, and invalidates — a rebuild loop
  // four frames a second with no edit behind it, on the scene least able to
  // afford one.
  const material = new THREE.MeshPhysicalNodeMaterial();
  material.map = makeTexture();
  const scene = sameMaterialScene(material);
  assert.equal(scene.merging._dirty, false, "precondition: settled after the first merge");
  // A signature-moving edit: three bumps `version` on every `needsUpdate`.
  material.map.version++;
  material.roughness = 0.9;
  for (let frame = 0; frame < 8; frame++) scene.merging.sync();
  assert.equal(
    scene.merging._dirty, false,
    "THE REGRESSION: a same-material group asked for a rebuild it does not need",
  );
});

// ---- the setting ------------------------------------------------------------

check("merging is off unless the scene asks for it", () => {
  // Not disposed: Engine.dispose() reaches for a renderer this headless run
  // never created. The default is what is being asserted, and it is set in the
  // constructor.
  const fresh = new Engine();
  assert.equal(fresh.merging.enabled, false);
  assert.equal(fresh.settings.performance.staticMerging, false);
});

console.log(failures ? `\n${failures} failing` : "\nall ok");
process.exit(failures ? 1 : 0);
