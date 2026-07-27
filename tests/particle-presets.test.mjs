import test from "node:test";
import assert from "node:assert/strict";

import { PARTICLE_PRESETS } from "../src/editor/particlePresets.js";
import { P_NODE_TYPES, nodeDefaults } from "../src/engine/particleGraph.js";

/**
 * Static validation of every shipped preset.
 *
 * `compileParticleGraph` can't run here (it needs a GPU device), so these
 * checks cover the failure modes that a typo actually produces: an unknown node
 * type, a wire to a port that doesn't exist, a param that no longer exists on
 * the node, or a graph with no System node. Each of those otherwise surfaces as
 * a silent no-op or a console warning at runtime, in the editor, on the one
 * preset nobody clicked.
 */

const presets = Object.entries(PARTICLE_PRESETS);

test("there are presets to validate", () => {
  assert.ok(presets.length >= 10, `only ${presets.length} presets`);
});

for (const [name, graph] of presets) {
  test(`preset "${name}" is structurally valid`, () => {
    const byId = new Map();
    for (const node of graph.nodes) {
      assert.ok(P_NODE_TYPES[node.type], `unknown node type "${node.type}"`);
      assert.ok(!byId.has(node.id), `duplicate node id "${node.id}"`);
      byId.set(node.id, node);

      // Every prop must correspond to a real param on that node type,
      // otherwise it is silently ignored at compile time.
      const known = new Set(Object.keys(nodeDefaults(node.type)));
      for (const key of Object.keys(node.props ?? {})) {
        assert.ok(known.has(key), `node "${node.id}" (${node.type}) has unknown param "${key}"`);
      }
    }

    assert.ok(
      graph.nodes.some((n) => n.type === "system"),
      "a graph without a System node cannot compile",
    );

    const seenTargets = new Set();
    for (const edge of graph.edges) {
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      assert.ok(source, `edge from missing node "${edge.source}"`);
      assert.ok(target, `edge to missing node "${edge.target}"`);

      const outs = P_NODE_TYPES[source.type].outputs ?? [];
      const handle = edge.sourceHandle ?? "out";
      assert.ok(
        outs.some((o) => o.key === handle),
        `"${edge.source}" (${source.type}) has no output "${handle}"`,
      );

      const ins = P_NODE_TYPES[target.type].inputs ?? [];
      assert.ok(
        ins.some((i) => i.key === edge.targetHandle),
        `"${edge.target}" (${target.type}) has no input "${edge.targetHandle}"`,
      );

      // One wire per input: a second one silently wins and the author's intent
      // is lost.
      const slot = `${edge.target}.${edge.targetHandle}`;
      assert.ok(!seenTargets.has(slot), `input ${slot} is wired twice`);
      seenTargets.add(slot);
    }
  });
}

test("every System node's inputs are reachable (no orphaned branches)", () => {
  for (const [name, graph] of presets) {
    const targets = new Set(graph.edges.map((e) => e.target));
    const sources = new Set(graph.edges.map((e) => e.source));
    for (const node of graph.nodes) {
      if (node.type === "system") continue;
      // A node that neither feeds anything nor is fed is dead weight in the
      // preset — usually a wire the author forgot to connect.
      assert.ok(
        sources.has(node.id) || targets.has(node.id),
        `preset "${name}": node "${node.id}" (${node.type}) is not connected to anything`,
      );
    }
  }
});

test("scene-integration presets actually enable the integration", () => {
  // The whole point of these presets: particles that read as part of the lit
  // scene. If someone edits the defaults back off, this catches it.
  const integrated = {
    "Dust Motes": ["lit", "castShadow", "receiveShadow"],
    Blizzard: ["lit", "sceneCollision"],
    Rain: ["lit"],
  };
  for (const [name, flags] of Object.entries(integrated)) {
    const graph = PARTICLE_PRESETS[name];
    assert.ok(graph, `preset "${name}" is missing`);
    const sys = graph.nodes.find((n) => n.type === "system");
    for (const flag of flags) {
      assert.equal(sys.props[flag], true, `preset "${name}" should set ${flag}`);
    }
  }

  // These push light back into the scene (and therefore into GI).
  for (const name of ["Fire", "Sparks", "Fireflies", "Explosion", "Portal Ring", "Magic Vortex"]) {
    const graph = PARTICLE_PRESETS[name];
    assert.ok(graph, `preset "${name}" is missing`);
    const emitters = graph.nodes.filter((n) => n.type === "system");
    assert.ok(
      emitters.some((s) => (s.props.lightCount ?? 0) > 0),
      `preset "${name}" should drive at least one scene light`,
    );
  }
});
