import test from "node:test";
import assert from "node:assert/strict";

import {
  POST_VERSION,
  POST_EXT,
  DEFAULT_POST_GRAPH,
  createPostGraph,
  normalizePostGraph,
  normalizePostAsset,
  serializePostAsset,
  postGraphSummary,
} from "../src/modules/postprocessing/postAsset.js";

/**
 * The `.post` document format. This module deliberately imports no `three`, so
 * these run in plain node — which is the point: a hand-edited or agent-written
 * graph reaching the compiler malformed is the failure worth catching, and by
 * the time the compiler sees it the error names a TSL node rather than a file.
 */

const GRADED = {
  nodes: [
    { id: "in", type: "input", props: {}, position: { x: 0, y: 0 } },
    { id: "bloom", type: "bloom", props: { strength: 0.4 }, position: { x: 200, y: 0 } },
    { id: "out", type: "output", props: {}, position: { x: 400, y: 0 } },
  ],
  edges: [
    { source: "in", sourceHandle: "color", target: "bloom", targetHandle: "color" },
    { source: "bloom", sourceHandle: "color", target: "out", targetHandle: "color" },
  ],
};

test("a fresh graph is an independent passthrough", () => {
  const a = createPostGraph();
  const b = createPostGraph();
  a.nodes[0].position.x = 999;
  assert.equal(b.nodes[0].position.x, DEFAULT_POST_GRAPH.nodes[0].position.x);
  assert.equal(DEFAULT_POST_GRAPH.nodes[0].position.x, 80, "the shared default was mutated");
  assert.ok(b.nodes.some((n) => n.type === "input"));
  assert.ok(b.nodes.some((n) => n.type === "output"));
});

test("normalize fills in what a hand-edited file leaves out", () => {
  const graph = normalizePostGraph({
    nodes: [
      { id: "in", type: "input" },
      { id: "out", type: "output", position: { x: "nope", y: 12 } },
    ],
    edges: [{ source: "in", sourceHandle: "color", target: "out", targetHandle: "color" }],
  });
  assert.deepEqual(graph.nodes[0].props, {});
  assert.deepEqual(graph.nodes[0].position, { x: 0, y: 0 });
  assert.deepEqual(graph.nodes[1].position, { x: 0, y: 12 }, "a non-finite coordinate becomes 0, not NaN");
  assert.ok(graph.edges[0].id, "edges get an id so React Flow can key them");
});

test("a dangling edge is dropped rather than reaching the compiler", () => {
  // Deleting a node in a text editor leaves its wires behind; the compiler
  // walks edges without checking that both ends exist.
  const graph = normalizePostGraph({
    nodes: [
      { id: "in", type: "input" },
      { id: "out", type: "output" },
    ],
    edges: [
      { source: "in", sourceHandle: "color", target: "out", targetHandle: "color" },
      { source: "in", sourceHandle: "color", target: "deleted", targetHandle: "color" },
      { source: "ghost", sourceHandle: "color", target: "out", targetHandle: "color" },
    ],
  });
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].target, "out");
});

test("junk nodes are dropped and duplicate ids collapse", () => {
  const graph = normalizePostGraph({
    nodes: [
      { id: "in", type: "input" },
      { id: "in", type: "input" },
      { type: "bloom" }, // no id
      { id: "nameless" }, // no type
      null,
      { id: "out", type: "output" },
    ],
    edges: [],
  });
  assert.deepEqual(
    graph.nodes.map((n) => n.id),
    ["in", "out"],
  );
});

test("an empty or unusable graph falls back to a passthrough, never to nothing", () => {
  // A black viewport with no error is the worst outcome here: it reads as a
  // broken effect rather than as an empty file.
  for (const input of [null, {}, { nodes: [] }, { nodes: "not an array" }, { nodes: [{}] }]) {
    const graph = normalizePostGraph(input);
    assert.ok(graph.nodes.some((n) => n.type === "output"), `no output for ${JSON.stringify(input)}`);
    assert.ok(graph.edges.length >= 1, `no wire for ${JSON.stringify(input)}`);
  }
});

test("the document round-trips through serialize/parse", () => {
  const text = serializePostAsset(GRADED);
  const doc = normalizePostAsset(JSON.parse(text));
  assert.equal(doc.version, POST_VERSION);
  assert.deepEqual(
    doc.graph.nodes.map((n) => n.type),
    ["input", "bloom", "output"],
  );
  assert.equal(doc.graph.nodes[1].props.strength, 0.4);
  assert.equal(doc.graph.edges.length, 2);
  assert.equal(text.at(-1), "\n", "files end with a newline so git doesn't complain");
});

test("a bare {nodes,edges} loads — an inline graph lifted out of a .scene by hand", () => {
  const doc = normalizePostAsset(GRADED);
  assert.equal(doc.graph.nodes.length, 3);
  assert.equal(doc.version, POST_VERSION);
});

test("the summary names the effect chain, not the frame", () => {
  const { nodeCount, effects, label } = postGraphSummary(GRADED);
  assert.equal(nodeCount, 3);
  assert.deepEqual(effects, ["bloom"], "input/output are the frame, not an effect");
  assert.equal(label, "bloom");
  assert.equal(postGraphSummary(createPostGraph()).label, "Passthrough");
});

test("the extension is what the editor registered", () => {
  assert.equal(POST_EXT, "post");
});
