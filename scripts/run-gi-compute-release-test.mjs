/**
 * GI compute-node eviction (src/modules/gi/releaseCompute.js).
 *
 *   node scripts/run-gi-compute-release-test.mjs
 *
 * WHAT THIS GUARDS. `GISystem#dispose` used to assume GC would reclaim a
 * finished build's compute work: "storage buffers are released with GC once
 * nothing references them". True of the scene graph, false of the renderer —
 * three keeps every dispatched compute node in `renderer._pipelines`/`_bindings`,
 * and a bind group holds strong references to every buffer it binds. Rebuilds
 * mint fresh nodes and three keys pipelines on node id, so nothing is ever
 * evicted: 516 pipelines for 68 kernels on Bistro, and ~2 GB of JS heap per GI
 * settings change (13.4 GB killed the WebGPU device outright, 2026-08-17).
 *
 * The risk here is UNDER-COLLECTION, and it is silent: a node the walk misses
 * is simply never evicted and the leak comes back for that pass only. The first
 * implementation used a key allowlist and missed `screen.resolve.compute`
 * because the wrapper hangs off `resolve` — so most of these check that the
 * walk still reaches every shape a pass can take, including ones added later.
 *
 * The other risk is walking too far: `state.light` is a real Object3D, and
 * following it climbs `parent` into the whole scene graph.
 */
import assert from "node:assert/strict";

const { collectStateComputeNodes, releaseComputeNodes } = await import(
  "../src/modules/gi/releaseCompute.js"
);

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

/** three marks compute nodes with `isComputeNode`; that is the only signal. */
const node = (id) => ({ isComputeNode: true, id });

/** A renderer whose caches record what was evicted, in order. */
const spyRenderer = () => {
  const evicted = [];
  return {
    evicted,
    _bindings: { deleteForCompute: (n) => evicted.push(`bind:${n.id}`) },
    _pipelines: { delete: (n) => evicted.push(`pipe:${n.id}`) },
    _nodes: { delete: (n) => evicted.push(`node:${n.id}`) },
  };
};

const ids = (nodes) => nodes.map((n) => n.id).sort((a, b) => a - b);

check("collects a screen pass reached through its wrapper (screen.<pass>.compute)", () => {
  // The shape the allowlist version missed. `resolve` is not a name any hand
  // written field list would have predicted, and every screen pass looks
  // like this — so this is the case that must never regress.
  const a = node(1);
  const found = collectStateComputeNodes({ screen: { resolve: { compute: a } } });
  assert.deepEqual(ids(found), [1], "screen.resolve.compute must be collected");
});

check("collects from a passes array, a queue, and several wrappers at once", () => {
  const [a, b, c, d] = [node(1), node(2), node(3), node(4)];
  const found = collectStateComputeNodes({
    screen: { resolve: { compute: a }, lightShadowPass: { compute: d }, srcProbes: { passes: [b, c] } },
    queue: [c],
  });
  assert.deepEqual(ids(found), [1, 2, 3, 4]);
});

check("collects a pass added under a name nothing here knows about", () => {
  // The whole point of a general walk: a kernel added next year, hung off a
  // field invented next year, still gets evicted.
  const a = node(7);
  const found = collectStateComputeNodes({ screen: { someFuturePass: { compute: a } } });
  assert.deepEqual(ids(found), [7], "a general walk must not depend on the field's name");
});

check("de-duplicates a node reachable by more than one path", () => {
  const a = node(1);
  const found = collectStateComputeNodes({ queue: [a, a], screen: { srcProbes: { passes: [a] } } });
  assert.equal(found.length, 1, "evicting the same node twice would be a wasted recompile");
});

check("does NOT walk into the scene graph via state.light", () => {
  // `state.light` is a real Object3D whose `parent` reaches the scene and every
  // object in it. Following it would be slow and would collect nodes belonging
  // to systems this build does not own.
  const scene = { isObject3D: true, children: [] };
  const light = { isObject3D: true, parent: scene, stray: node(99) };
  scene.children.push(light);
  const found = collectStateComputeNodes({ light, queue: [node(1)] });
  assert.deepEqual(ids(found), [1], "nothing below an Object3D may be collected");
});

check("survives a cyclic state without hanging", () => {
  const state = { queue: [node(1)] };
  state.screen = state;
  assert.deepEqual(ids(collectStateComputeNodes(state)), [1]);
});

check("evicts all THREE caches, bindings first and the node builder state last", () => {
  // Order is load-bearing. `Bindings.deleteForCompute` falls back to
  // `nodes.getForCompute(node)` to find the bind groups when its own entry is
  // gone, so the builder state must outlive it — dropping `_nodes` first would
  // make that lookup REBUILD the state we are discarding. And the bind groups
  // are what hold the buffers this whole fix exists to free.
  const renderer = spyRenderer();
  releaseComputeNodes(renderer, [node(1)]);
  assert.deepEqual(renderer.evicted, ["bind:1", "pipe:1", "node:1"]);
});

check("clearing only bindings+pipelines is NOT enough — _nodes must be evicted", () => {
  // Measured live: with `_nodes` left alone the heap still climbed 3223 → 4625
  // MB across a single GI quality change, because NodeManager holds each
  // compute node's builder state and that references the bindings.
  const renderer = spyRenderer();
  releaseComputeNodes(renderer, [node(1)]);
  assert.ok(
    renderer.evicted.includes("node:1"),
    "the NodeManager entry is the one that kept ~1.4 GB per rebuild alive",
  );
});

check("a node that was never dispatched does not abort the sweep", () => {
  // A build torn down mid compile-wave has nodes with no cache entry at all;
  // three throws rather than no-op. The rest of the generation must still go.
  const seen = [];
  const renderer = {
    _bindings: {
      deleteForCompute: (n) => {
        if (n.id === 1) throw new Error("never dispatched");
        seen.push(n.id);
      },
    },
    _pipelines: { delete: () => {} },
  };
  const released = releaseComputeNodes(renderer, [node(1), node(2), node(3)]);
  assert.deepEqual(seen, [2, 3], "nodes after the throwing one must still be evicted");
  assert.equal(released, 2, "the failed node must not be counted as released");
});

check("degrades to a no-op if three renames its caches", () => {
  // These are underscore-private. A three upgrade must cost us the leak we
  // already had, never a crash in the middle of a rebuild.
  assert.equal(releaseComputeNodes({}, [node(1)]), 0);
  assert.equal(releaseComputeNodes(null, [node(1)]), 0);
  assert.equal(releaseComputeNodes(spyRenderer(), null), 0);
});

check("ignores non-nodes handed to it", () => {
  const renderer = spyRenderer();
  releaseComputeNodes(renderer, [null, undefined, 42, "compute", node(5)]);
  assert.deepEqual(renderer.evicted, ["bind:5", "pipe:5", "node:5"]);
});

console.log(failures ? `\n${failures} failing` : "\nall ok");
process.exit(failures ? 1 : 0);
