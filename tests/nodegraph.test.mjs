import test from "node:test";
import assert from "node:assert/strict";

import {
  graphToFlow,
  flowToGraph,
  stripHelpers,
  nodesInsideFrame,
  FRAME_TYPE,
  REROUTE_TYPE,
} from "../src/editor/nodegraph/graphUtils.js";
import { createGraphHistory } from "../src/editor/nodegraph/history.js";
import { copySelection, pasteClipboard, duplicateSelection } from "../src/editor/nodegraph/clipboard.js";
import { typesCompatible, wouldCycle, makeConnectionValidator } from "../src/editor/nodegraph/socketTypes.js";

const flowNode = (id, nodeType, props = {}, position = { x: 0, y: 0 }) => ({
  id,
  type: "graphNode",
  position,
  data: { nodeType, props },
});

// ---------------------------------------------------------------------------
// graph <-> flow round-trip
// ---------------------------------------------------------------------------

test("graphToFlow/flowToGraph round-trips nodes, edges and positions", () => {
  const graph = {
    nodes: [
      { id: "a", type: "float", props: { value: 3 }, position: { x: 10, y: 20 } },
      { id: "b", type: "multiply", props: {}, position: { x: 200, y: 40 } },
    ],
    edges: [{ source: "a", sourceHandle: "out", target: "b", targetHandle: "x" }],
  };
  const flow = graphToFlow(graph, { knownType: () => true });
  const back = flowToGraph(flow.nodes, flow.edges);
  assert.deepEqual(
    back.nodes.map((n) => ({ id: n.id, type: n.type, props: n.props, position: n.position })),
    graph.nodes,
  );
  assert.equal(back.edges.length, 1);
  assert.equal(back.edges[0].source, "a");
  assert.equal(back.edges[0].targetHandle, "x");
});

test("graphToFlow drops nodes whose type the registry no longer knows", () => {
  const graph = {
    nodes: [
      { id: "a", type: "float", props: {}, position: { x: 0, y: 0 } },
      { id: "gone", type: "removedInAnUpdate", props: {}, position: { x: 0, y: 0 } },
    ],
    edges: [],
  };
  const flow = graphToFlow(graph, { knownType: (t) => t === "float" });
  assert.deepEqual(flow.nodes.map((n) => n.id), ["a"]);
});

test("graphToFlow keeps frames and reroutes even though no registry declares them", () => {
  const graph = {
    nodes: [
      { id: "f", type: FRAME_TYPE, props: { title: "Body", width: 400, height: 300 }, position: { x: 0, y: 0 } },
      { id: "r", type: REROUTE_TYPE, props: {}, position: { x: 50, y: 50 } },
    ],
    edges: [],
  };
  const flow = graphToFlow(graph, { knownType: () => false });
  assert.equal(flow.nodes.length, 2);
  assert.equal(flow.nodes[0].style.width, 400);
  // Frames must render behind the nodes they group.
  assert.equal(flow.nodes[0].zIndex, -1);
});

test("flowToGraph folds a resized frame's box back into props", () => {
  const frame = {
    id: "f",
    type: FRAME_TYPE,
    position: { x: 0, y: 0 },
    width: 512,
    height: 256,
    data: { nodeType: FRAME_TYPE, props: { title: "Body" } },
  };
  const graph = flowToGraph([frame], []);
  assert.equal(graph.nodes[0].props.width, 512);
  assert.equal(graph.nodes[0].props.height, 256);
  assert.equal(graph.nodes[0].props.title, "Body");
});

// ---------------------------------------------------------------------------
// stripHelpers
// ---------------------------------------------------------------------------

test("stripHelpers removes frames and leaves real wiring untouched", () => {
  const graph = {
    nodes: [
      { id: "a", type: "float", props: {} },
      { id: "b", type: "multiply", props: {} },
      { id: "f", type: FRAME_TYPE, props: {} },
    ],
    edges: [{ source: "a", sourceHandle: "out", target: "b", targetHandle: "x" }],
  };
  const out = stripHelpers(graph);
  assert.deepEqual(out.nodes.map((n) => n.id), ["a", "b"]);
  assert.equal(out.edges.length, 1);
});

test("stripHelpers collapses a reroute so the compiler sees the original source", () => {
  const graph = {
    nodes: [
      { id: "a", type: "float", props: {} },
      { id: "r", type: REROUTE_TYPE, props: {} },
      { id: "b", type: "multiply", props: {} },
    ],
    edges: [
      { source: "a", sourceHandle: "out", target: "r", targetHandle: "in" },
      { source: "r", sourceHandle: "out", target: "b", targetHandle: "x" },
    ],
  };
  const out = stripHelpers(graph);
  assert.deepEqual(out.nodes.map((n) => n.id), ["a", "b"]);
  assert.deepEqual(out.edges, [{ source: "a", sourceHandle: "out", target: "b", targetHandle: "x" }]);
});

test("stripHelpers follows a chain of reroutes back to the real producer", () => {
  const graph = {
    nodes: [
      { id: "a", type: "texture", props: {} },
      { id: "r1", type: REROUTE_TYPE, props: {} },
      { id: "r2", type: REROUTE_TYPE, props: {} },
      { id: "b", type: "multiply", props: {} },
    ],
    edges: [
      { source: "a", sourceHandle: "g", target: "r1", targetHandle: "in" },
      { source: "r1", sourceHandle: "out", target: "r2", targetHandle: "in" },
      { source: "r2", sourceHandle: "out", target: "b", targetHandle: "x" },
    ],
  };
  const out = stripHelpers(graph);
  // The source HANDLE has to survive the collapse too — a reroute carrying a
  // texture's green channel must still resolve to `.g`, not to the default out.
  assert.deepEqual(out.edges, [{ source: "a", sourceHandle: "g", target: "b", targetHandle: "x" }]);
});

test("stripHelpers drops a dangling reroute's downstream wire instead of emitting a broken edge", () => {
  const graph = {
    nodes: [
      { id: "r", type: REROUTE_TYPE, props: {} },
      { id: "b", type: "multiply", props: {} },
    ],
    edges: [{ source: "r", sourceHandle: "out", target: "b", targetHandle: "x" }],
  };
  assert.deepEqual(stripHelpers(graph).edges, []);
});

test("stripHelpers survives a reroute loop rather than recursing forever", () => {
  const graph = {
    nodes: [
      { id: "r1", type: REROUTE_TYPE, props: {} },
      { id: "r2", type: REROUTE_TYPE, props: {} },
      { id: "b", type: "multiply", props: {} },
    ],
    edges: [
      { source: "r1", sourceHandle: "out", target: "r2", targetHandle: "in" },
      { source: "r2", sourceHandle: "out", target: "r1", targetHandle: "in" },
      { source: "r2", sourceHandle: "out", target: "b", targetHandle: "x" },
    ],
  };
  assert.deepEqual(stripHelpers(graph).edges, []);
});

test("stripHelpers returns the graph untouched when there are no helpers", () => {
  const graph = { nodes: [{ id: "a", type: "float", props: {} }], edges: [] };
  assert.equal(stripHelpers(graph), graph);
});

// ---------------------------------------------------------------------------
// frames
// ---------------------------------------------------------------------------

test("nodesInsideFrame selects only fully-contained non-frame nodes", () => {
  const frame = { id: "f", position: { x: 0, y: 0 }, width: 300, height: 200, data: { nodeType: FRAME_TYPE } };
  const inside = { id: "in", position: { x: 20, y: 20 }, measured: { width: 100, height: 50 }, data: { nodeType: "float" } };
  const straddling = { id: "out", position: { x: 260, y: 20 }, measured: { width: 100, height: 50 }, data: { nodeType: "float" } };
  const otherFrame = { id: "f2", position: { x: 10, y: 10 }, width: 50, height: 50, data: { nodeType: FRAME_TYPE } };
  const got = nodesInsideFrame(frame, [frame, inside, straddling, otherFrame]);
  assert.deepEqual(got.map((n) => n.id), ["in"]);
});

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

test("history undoes and redoes graph states", () => {
  const h = createGraphHistory();
  const a = [flowNode("a", "float")];
  const ab = [flowNode("a", "float"), flowNode("b", "multiply")];
  h.reset(a, []);
  assert.equal(h.canUndo, false);
  h.push(ab, []);
  assert.equal(h.canUndo, true);
  const undone = h.undo();
  assert.deepEqual(undone.nodes.map((n) => n.id), ["a"]);
  const redone = h.redo();
  assert.deepEqual(redone.nodes.map((n) => n.id), ["a", "b"]);
});

test("history ignores a push that changes nothing structural", () => {
  const h = createGraphHistory();
  const nodes = [flowNode("a", "float", { value: 1 })];
  h.reset(nodes, []);
  // Same content, different array identity + transient React Flow fields.
  h.push([{ ...nodes[0], selected: true, measured: { width: 10, height: 10 } }], []);
  assert.equal(h.canUndo, false);
});

test("history collapses one gesture into a single undo entry", () => {
  const h = createGraphHistory();
  h.reset([flowNode("a", "float", { value: 0 })], []);
  for (let v = 1; v <= 20; v++) h.push([flowNode("a", "float", { value: v })], [], "a:value");
  const undone = h.undo();
  // One undo returns to the value before the whole drag, not to 19.
  assert.equal(undone.nodes[0].data.props.value, 0);
  assert.equal(h.canUndo, false);
});

test("history starts a new entry once a gesture ends", () => {
  const h = createGraphHistory();
  h.reset([flowNode("a", "float", { value: 0 })], []);
  h.push([flowNode("a", "float", { value: 1 })], [], "a:value");
  h.endGesture();
  h.push([flowNode("a", "float", { value: 2 })], [], "a:value");
  assert.equal(h.undo().nodes[0].data.props.value, 1);
  assert.equal(h.undo().nodes[0].data.props.value, 0);
});

test("a fresh edit after undo discards the redo branch", () => {
  const h = createGraphHistory();
  h.reset([flowNode("a", "float")], []);
  h.push([flowNode("a", "float"), flowNode("b", "multiply")], []);
  h.undo();
  assert.equal(h.canRedo, true);
  h.push([flowNode("a", "float"), flowNode("c", "add")], []);
  assert.equal(h.canRedo, false);
});

// ---------------------------------------------------------------------------
// clipboard
// ---------------------------------------------------------------------------

test("copy/paste remaps ids and keeps only edges internal to the selection", () => {
  const nodes = [
    { ...flowNode("a", "float"), selected: true },
    { ...flowNode("b", "multiply"), selected: true },
    { ...flowNode("outside", "add"), selected: false },
  ];
  const edges = [
    { source: "a", sourceHandle: "out", target: "b", targetHandle: "x" },
    { source: "b", sourceHandle: "out", target: "outside", targetHandle: "a" },
  ];
  assert.equal(copySelection("test", nodes, edges), true);
  const pasted = pasteClipboard("test");
  assert.equal(pasted.nodes.length, 2);
  assert.equal(pasted.edges.length, 1, "the edge leaving the selection must not be pasted");
  // Fresh ids, and the internal edge points at them.
  const ids = new Set(pasted.nodes.map((n) => n.id));
  assert.equal(ids.has("a"), false);
  assert.equal(ids.has(pasted.edges[0].source), true);
  assert.equal(ids.has(pasted.edges[0].target), true);
});

test("paste rejects a buffer copied from a different graph kind", () => {
  copySelection("shader", [{ ...flowNode("a", "float"), selected: true }], []);
  assert.equal(pasteClipboard("particles"), null);
});

test("copy skips protected node types", () => {
  const nodes = [
    { ...flowNode("out", "output"), selected: true },
    { ...flowNode("a", "float"), selected: true },
  ];
  copySelection("test", nodes, [], { protectedTypes: ["output"] });
  const pasted = pasteClipboard("test");
  assert.deepEqual(pasted.nodes.map((n) => n.data.nodeType), ["float"]);
});

test("copy of an empty selection reports failure and leaves the buffer alone", () => {
  copySelection("test", [{ ...flowNode("a", "float"), selected: true }], []);
  assert.equal(copySelection("test", [flowNode("b", "multiply")], []), false);
  assert.deepEqual(pasteClipboard("test").nodes.map((n) => n.data.nodeType), ["float"]);
});

test("duplicate does not clobber the copy buffer", () => {
  copySelection("test", [{ ...flowNode("kept", "float"), selected: true }], []);
  duplicateSelection("test", [{ ...flowNode("other", "multiply"), selected: true }], []);
  assert.deepEqual(pasteClipboard("test").nodes.map((n) => n.data.nodeType), ["float"]);
});

test("pasted node props are deep-copied, not shared with the source", () => {
  const source = { ...flowNode("a", "gradient", { stops: [{ t: 0, color: "#fff" }] }), selected: true };
  copySelection("test", [source], []);
  const pasted = pasteClipboard("test");
  pasted.nodes[0].data.props.stops[0].color = "#000";
  assert.equal(source.data.props.stops[0].color, "#fff");
});

// ---------------------------------------------------------------------------
// socket types
// ---------------------------------------------------------------------------

test("numeric socket types interconvert, bundles do not", () => {
  assert.equal(typesCompatible("float", "vec3"), true, "TSL broadcasts float into vec3");
  assert.equal(typesCompatible("color", "vec4"), true);
  assert.equal(typesCompatible("any", "surface"), true, "unknown types stay connectable");
  assert.equal(typesCompatible("surface", "surface"), true);
  assert.equal(typesCompatible("float", "surface"), false);
  assert.equal(typesCompatible("volume", "vec3"), false);
  assert.equal(typesCompatible("surface", "volume"), false);
});

test("the connection validator refuses a self-connection and mismatched bundles", () => {
  const registry = {
    bsdf: { out: "surface", in: {} },
    mul: { out: "float", in: { x: "float" } },
  };
  const validate = makeConnectionValidator((id) => {
    const entry = registry[id];
    if (!entry) return null;
    return { outType: () => entry.out, inType: (h) => entry.in[h] ?? "any" };
  });
  assert.equal(validate({ source: "mul", target: "mul", sourceHandle: "out", targetHandle: "x" }), false);
  assert.equal(validate({ source: "bsdf", target: "mul", sourceHandle: "out", targetHandle: "x" }), false);
  assert.equal(validate({ source: "mul", target: "mul2", sourceHandle: "out", targetHandle: "x" }), true);
});

test("wouldCycle detects a loop through intermediate nodes", () => {
  const edges = [
    { source: "a", target: "b" },
    { source: "b", target: "c" },
  ];
  // Wiring c -> a closes the loop a->b->c->a.
  assert.equal(wouldCycle(edges, "c", "a"), true);
  assert.equal(wouldCycle(edges, "a", "c"), false);
  assert.equal(wouldCycle(edges, "a", "a"), true);
});

test("wouldCycle terminates on a graph that already contains a loop", () => {
  const edges = [
    { source: "a", target: "b" },
    { source: "b", target: "a" },
  ];
  assert.equal(wouldCycle(edges, "b", "z"), false);
});
