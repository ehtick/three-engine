import assert from "node:assert/strict";
import test from "node:test";
import { MeshStandardNodeMaterial, PerspectiveCamera } from "three/webgpu";
import * as TSL from "three/tsl";
import { ssr } from "three/addons/tsl/display/SSRNode.js";
import { compilePostGraph, nodeDefaults, postGraphSignature } from "../src/modules/postprocessing/postGraph.js";
import { resolveShadedParam } from "../src/modules/postprocessing/PostprocessComponent.js";

/**
 * The SSR post node's reach, and the composite that hands back to the fallback.
 *
 * Run with `node --test tests/post-ssr.test.mjs`.
 *
 * Worth pinning because the failure was invisible in code review and obvious on
 * screen: SSRNode constructs `maxDistance` as `uniform(1)` — one WORLD UNIT —
 * and our builder never assigned it, so the effect reflected a footstep of
 * floor. Every other knob it exposes was left at an addon default too, and
 * because `updateParams` was a stub, none of them could be moved at runtime
 * either: a slider drag leaves the graph signature identical, the component
 * skipped the recompile, and nothing wrote the new value anywhere.
 */

const CAMERA = new PerspectiveCamera(50, 1, 0.1, 1000);

/** A graph of `input -> [chain...] -> ssr -> output`, plus its SSR props. */
function ssrGraph(props = {}, chain = []) {
  const nodes = [
    { id: "in", type: "input", props: {}, position: { x: 0, y: 0 } },
    ...chain.map((type, i) => ({ id: `c${i}`, type, props: {}, position: { x: 0, y: 0 } })),
    { id: "ssr", type: "ssr", props, position: { x: 0, y: 0 } },
    { id: "out", type: "output", props: {}, position: { x: 0, y: 0 } },
  ];
  // The color wire threads the chain; depth/normal always come straight off
  // the Input node, as the panel wires them.
  const colorPath = ["in", ...chain.map((_, i) => `c${i}`), "ssr"];
  const edges = [];
  for (let i = 0; i < colorPath.length - 1; i++) {
    edges.push({
      source: colorPath[i],
      sourceHandle: i === 0 ? "color" : "out",
      target: colorPath[i + 1],
      targetHandle: "color",
    });
  }
  edges.push({ source: "in", sourceHandle: "depth", target: "ssr", targetHandle: "depth" });
  edges.push({ source: "in", sourceHandle: "normal", target: "ssr", targetHandle: "normal" });
  edges.push({ source: "ssr", sourceHandle: "out", target: "out", targetHandle: "color" });
  return { nodes, edges };
}

/** Compiles a graph, capturing the SSRNode instance the builder created. */
function compile(graph) {
  let instance = null;
  const compiled = compilePostGraph(graph, {
    camera: CAMERA,
    beautyNode: TSL.vec4(0, 0, 0, 1),
    depthNode: TSL.float(0.5),
    normalNode: TSL.vec3(0, 1, 0),
    metalnessNode: TSL.float(1),
    roughnessNode: TSL.float(0.2),
    temps: new Set(),
    ssr: (...args) => (instance = ssr(...args)),
  });
  return { compiled, instance };
}

test("the addon's own default reach really is one world unit", () => {
  // The premise of the whole fix. If a three upgrade ever changes this, the
  // node below is over-riding a different default than the one documented.
  const bare = ssr(TSL.vec4(0), TSL.float(0), TSL.vec3(0, 1, 0), { camera: CAMERA });
  assert.equal(bare.maxDistance.value, 1);
});

test("SSR compiles with a scene-sized reach, not the addon's 1 unit", () => {
  const { instance } = compile(ssrGraph());
  assert.ok(instance, "builder created an SSRNode");
  assert.equal(instance.maxDistance.value, nodeDefaults("ssr").maxDistance);
  assert.equal(instance.maxDistance.value, 20);
  // The rest of the march tuning has to land too — a long ray with the
  // default single-metre thickness tunnels straight through thin geometry.
  assert.equal(instance.thickness.value, 0.1);
  assert.equal(instance.quality.value, 0.5);
  assert.equal(instance.screenEdgeFade.value, 0.2);
  assert.equal(instance.intensity.value, 1);
});

test("authored props override the defaults", () => {
  const { instance } = compile(ssrGraph({ maxDistance: 120, thickness: 0.4, quality: 0.25 }));
  assert.equal(instance.maxDistance.value, 120);
  assert.equal(instance.thickness.value, 0.4);
  assert.equal(instance.quality.value, 0.25);
});

test("hot params reach the live uniforms without a recompile", () => {
  const graph = ssrGraph();
  const { compiled, instance } = compile(graph);

  // A slider drag: same structure, new numbers. The component keys its
  // rebuild off this signature, so if it moved, `updateParams` would never
  // be the path taken.
  const dragged = ssrGraph({ maxDistance: 75, thickness: 0.9, quality: 1, screenEdgeFade: 0, intensity: 2 });
  assert.equal(postGraphSignature(dragged), postGraphSignature(graph));

  compiled.updateParams(dragged);
  assert.equal(instance.maxDistance.value, 75);
  assert.equal(instance.thickness.value, 0.9);
  assert.equal(instance.quality.value, 1);
  assert.equal(instance.screenEdgeFade.value, 0);
  assert.equal(instance.intensity.value, 2);
});

test("updateParams restores omitted props to their defaults", () => {
  const { compiled, instance } = compile(ssrGraph({ maxDistance: 75 }));
  assert.equal(instance.maxDistance.value, 75);
  // A node whose props were cleared must fall back to the declared default,
  // not keep whatever was last pushed into the uniform.
  compiled.updateParams(ssrGraph());
  assert.equal(instance.maxDistance.value, 20);
});

test("the roughness gate and the luminance clamp are hot, and default to a real cut", () => {
  // Mirror-mode SSR fakes roughness with a mip chain of 5-tap box blurs
  // (SSRNode.js:462-466, 779-788). Past ~0.5 roughness that is a sparse tap
  // pattern over a 1/8-res buffer, so a bright reflection returns as hard
  // rectangles — the banner curtains' gold thread (metal at roughness
  // 0.76-0.94) wore exactly that. The gate has to be a SLIDER, not a rebuild:
  // finding the right cut for a scene is a drag, not a graph edit.
  const graph = ssrGraph();
  const { compiled, instance } = compile(graph);
  assert.equal(nodeDefaults("ssr").maxRoughness, 0.6);
  assert.equal(instance.maxLuminance.value, 10, "the addon's clamp is assigned, not left to chance");

  const dragged = ssrGraph({ maxRoughness: 1, maxLuminance: 2.5 });
  assert.equal(postGraphSignature(dragged), postGraphSignature(graph));
  compiled.updateParams(dragged);
  assert.equal(instance.maxLuminance.value, 2.5);
});

test("Stochastic degrades to mirror mode when the scene has no equirect HDRI", () => {
  // SSRNode's GGX branch defines its miss path as
  // `this._importanceEnvironment.sampleEnvironment…` with no null guard, and
  // that field is null until setEnvMap() gets an equirect HDR with CPU-side
  // pixels. Flipping the toggle on a scene without one threw
  // "Cannot read properties of null (reading 'sampleEnvironmentBRDF')" during
  // the TSL build and took the whole post chain down with it (live, 2026-08-15).
  const { instance } = compile(ssrGraph({ stochastic: true }));
  assert.ok(instance, "the node still builds");
  assert.equal(instance.stochastic, false, "degraded to mirror mode rather than throwing");
});

test("structural params stay structural", () => {
  // `binaryRefine` and `stochastic` are baked into the addon's fragment Fn,
  // so they must force a rebuild rather than ride the hot path.
  const a = ssrGraph({ binaryRefine: true });
  const b = ssrGraph({ binaryRefine: false });
  assert.notEqual(postGraphSignature(a), postGraphSignature(b));
  assert.notEqual(postGraphSignature(ssrGraph({ stochastic: true })), postGraphSignature(ssrGraph()));
});

/**
 * Reads the constant out of a TSL node, through the VarNode/ConvertNode
 * wrappers `float()` puts around one — same bounded unwrap `giLight.js`
 * uses to read a material's static roughness.
 */
function constantOf(node) {
  let n = node;
  for (let depth = 0; depth < 8 && n; depth++) {
    if (n.isConstNode || n.isUniformNode) return n.value;
    n = n.node ?? n.aNode ?? null;
  }
  return null;
}

test("matParams follows the node the material shades with, not the scalar", () => {
  // The whole bug: a shader-graph material carries its real values on
  // `metalnessNode` / `roughnessNode` and leaves the asset's scalars stale.
  // `MeshStandardNodeMaterial.setupVariants` prefers the node; the MRT used to
  // read the scalar, so SSR was handed a different material than the one on
  // screen — and its `metalness <= 0` discard then deleted every pixel of a
  // mirror whose scalar happened to be 0.
  const graphAuthored = new MeshStandardNodeMaterial();
  graphAuthored.metalness = 0;      // stale asset scalar
  graphAuthored.roughness = 0.7;    // stale asset scalar
  graphAuthored.metalnessNode = TSL.float(1);   // what it actually shades with
  graphAuthored.roughnessNode = TSL.float(0);

  assert.equal(constantOf(resolveShadedParam(graphAuthored, "metalnessNode", TSL.metalness)), 1);
  assert.equal(constantOf(resolveShadedParam(graphAuthored, "roughnessNode", TSL.roughness)), 0);
});

test("matParams falls back to the scalar accessor when there is no node", () => {
  // glTF-loaded materials carry no nodes, and for them the scalar IS what they
  // shade with — the fallback must stay a live material reference, not a
  // baked constant.
  const loaded = new MeshStandardNodeMaterial();
  loaded.metalness = 0.25;
  assert.equal(loaded.metalnessNode, null);

  const resolved = resolveShadedParam(loaded, "metalnessNode", TSL.metalness);
  assert.ok(resolved, "resolves to something buildable");
  // Not a constant: it has to re-read `material.metalness` per material.
  assert.equal(constantOf(resolved), null);
});

test("SSR still compiles downstream of another effect", () => {
  // The addon infers its camera from `colorNode.passNode`, which only the raw
  // scene-pass texture carries — anything in between and the constructor
  // throws "No camera found", taking the whole graph down with it. We pass
  // the camera explicitly so the wire order is the user's business.
  const { instance } = compile(ssrGraph({}, ["saturation", "vignette"]));
  assert.ok(instance);
  assert.equal(instance.camera, CAMERA);
  assert.equal(instance.maxDistance.value, 20);
});
