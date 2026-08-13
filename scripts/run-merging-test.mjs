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
const { isUberCompatible, slotSignature } = await import("../src/engine/uberMaterial.js");

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
  material.roughnessMap = makeTexture();
  assert.equal(isUberCompatible(material), false);
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
