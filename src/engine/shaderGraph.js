import { vmState } from "./vmState.js";
import * as THREE from "three/webgpu";
import { color, float, uv, time, texture as tslTexture, add, sub, mul, div, mix, vec3 } from "three/tsl";
import { loadTextureAsset } from "./textureAsset.js";

const textureCache = vmState("shaderGraphTextures", () => new Map()); // path -> Promise<THREE.Texture>

function loadTexture(path) {
  let cached = textureCache.get(path);
  if (!cached) {
    cached = loadTextureAsset(path, { colorSpace: THREE.SRGBColorSpace });
    textureCache.set(path, cached);
  }
  return cached;
}

/**
 * Shader graph shape: { nodes: [{id, type, props}], edges: [{source, sourceHandle, target, targetHandle}] }.
 *
 * Three flavors of node:
 * - Value/source nodes (Color, Float, UV, Time, Texture, math) compile to a TSL node
 *   and return it as their build result.
 * - Shader/BSDF nodes (Principled, Glass, Diffuse, Emission) do NOT compose a single
 *   TSL node — Three.js physical materials render their lighting model from many
 *   independent `*Node` slots. So these builders assign each wired input to the
 *   matching material slot (mutations) and return `{ surface, mutations }` where
 *   `surface` is a sentinel marker.
 * - The Output node has a single `surface` target handle; it propagates whatever
 *   the upstream shader returned (so `compileShaderGraph` can hand a single result
 *   back to the asset layer).
 *
 * The compile returns `{ surface }` to the asset layer; `surface` is currently a
 * boolean (was-something-wired) marker, but the shape allows future Displacement /
 * Volume slots without breaking callers.
 */
export const SHADER_RESULT = Symbol("shader-result");
const SHADER = { surface: SHADER_RESULT };

// --- Defaults (also drive the editor's inline field initial values) ---
const PRINCIPLED_DEFAULTS = {
  baseColor: "#ffffff",
  roughness: 0.4,
  metalness: 0,
  ior: 1.5,
  specular: 0.5,
  specularTint: 0,
  anisotropic: 0,
  anisotropicRotation: 0,
  sheen: 0,
  sheenTint: 0.5,
  sheenRoughness: 0.3,
  clearcoat: 0,
  clearcoatRoughness: 0.03,
  transmission: 0,
  transmissionRoughness: 0,
  emission: "#000000",
  emissionStrength: 1,
  alpha: 1,
};
const GLASS_DEFAULTS = { color: "#ffffff", roughness: 0, ior: 1.5 };
const DIFFUSE_DEFAULTS = { color: "#ffffff", roughness: 0 };
const EMISSION_DEFAULTS = { color: "#ffffff", emissionStrength: 1 };

/** Per-input definition. The editor renders one row per entry with an inline
 *  color picker or float slider (disabled when the input is wired). Values
 *  live in `node.props[input.name]` and are read by the shader builder if no
 *  wire is connected.
 */
const FLOAT_INPUT = (name, def, min = 0, max = 1, step = 0.01) => ({
  name,
  kind: "float",
  default: def,
  min,
  max,
  step,
});
const COLOR_INPUT = (name, def) => ({ name, kind: "color", default: def });

const PRINCIPLED_INPUTS = [
  COLOR_INPUT("baseColor", PRINCIPLED_DEFAULTS.baseColor),
  FLOAT_INPUT("roughness", PRINCIPLED_DEFAULTS.roughness),
  FLOAT_INPUT("metalness", PRINCIPLED_DEFAULTS.metalness),
  FLOAT_INPUT("ior", PRINCIPLED_DEFAULTS.ior, 1, 3, 0.01),
  FLOAT_INPUT("specular", PRINCIPLED_DEFAULTS.specular),
  FLOAT_INPUT("specularTint", PRINCIPLED_DEFAULTS.specularTint),
  FLOAT_INPUT("anisotropic", PRINCIPLED_DEFAULTS.anisotropic),
  FLOAT_INPUT("anisotropicRotation", PRINCIPLED_DEFAULTS.anisotropicRotation, -1, 1, 0.01),
  FLOAT_INPUT("sheen", PRINCIPLED_DEFAULTS.sheen),
  FLOAT_INPUT("sheenTint", PRINCIPLED_DEFAULTS.sheenTint),
  FLOAT_INPUT("sheenRoughness", PRINCIPLED_DEFAULTS.sheenRoughness),
  FLOAT_INPUT("clearcoat", PRINCIPLED_DEFAULTS.clearcoat),
  FLOAT_INPUT("clearcoatRoughness", PRINCIPLED_DEFAULTS.clearcoatRoughness),
  FLOAT_INPUT("transmission", PRINCIPLED_DEFAULTS.transmission),
  FLOAT_INPUT("transmissionRoughness", PRINCIPLED_DEFAULTS.transmissionRoughness),
  COLOR_INPUT("emission", PRINCIPLED_DEFAULTS.emission),
  FLOAT_INPUT("emissionStrength", PRINCIPLED_DEFAULTS.emissionStrength, 0, 10, 0.05),
  FLOAT_INPUT("alpha", PRINCIPLED_DEFAULTS.alpha),
];
const GLASS_INPUTS = [
  COLOR_INPUT("color", GLASS_DEFAULTS.color),
  FLOAT_INPUT("roughness", GLASS_DEFAULTS.roughness),
  FLOAT_INPUT("ior", GLASS_DEFAULTS.ior, 1, 3, 0.01),
];
const DIFFUSE_INPUTS = [COLOR_INPUT("color", DIFFUSE_DEFAULTS.color), FLOAT_INPUT("roughness", DIFFUSE_DEFAULTS.roughness)];
const EMISSION_INPUTS = [
  COLOR_INPUT("color", EMISSION_DEFAULTS.color),
  FLOAT_INPUT("emissionStrength", EMISSION_DEFAULTS.emissionStrength, 0, 10, 0.05),
];

/**
 * Node registry. Shader-node `inputs` carry `{name, kind, default, min, max, step}`
 * so the editor can render an inline value editor per row. Math/coords/values
 * nodes have plain string inputs (no inline editor — they're always wired).
 * Categories drive the editor's color coding (`bsdf` = orange).
 */
export const NODE_TYPES = {
  // --- values / sources ---
  color: { label: "Color", inputs: [], defaults: { value: "#ffffff" }, category: "value" },
  float: { label: "Float", inputs: [], defaults: { value: 1 }, category: "value" },
  uv: { label: "UV", inputs: [], defaults: {}, category: "coords" },
  time: { label: "Time", inputs: [], defaults: {}, category: "coords" },
  texture: { label: "Texture", inputs: [], defaults: { path: "" }, category: "texture" },
  add: { label: "Add", inputs: ["a", "b"], defaults: {}, category: "math" },
  subtract: { label: "Subtract", inputs: ["a", "b"], defaults: {}, category: "math" },
  multiply: { label: "Multiply", inputs: ["a", "b"], defaults: {}, category: "math" },
  divide: { label: "Divide", inputs: ["a", "b"], defaults: {}, category: "math" },
  lerp: { label: "Lerp", inputs: ["a", "b", "t"], defaults: {}, category: "math" },

  // --- shaders (BSDF / emission) ---
  principledBsdf: {
    label: "Principled BSDF",
    inputs: PRINCIPLED_INPUTS,
    defaults: { ...PRINCIPLED_DEFAULTS },
    category: "bsdf",
    isShader: true,
  },
  glassBsdf: {
    label: "Glass BSDF",
    inputs: GLASS_INPUTS,
    defaults: { ...GLASS_DEFAULTS },
    category: "bsdf",
    isShader: true,
  },
  diffuseBsdf: {
    label: "Diffuse BSDF",
    inputs: DIFFUSE_INPUTS,
    defaults: { ...DIFFUSE_DEFAULTS },
    category: "bsdf",
    isShader: true,
  },
  emission: {
    label: "Emission",
    inputs: EMISSION_INPUTS,
    defaults: { ...EMISSION_DEFAULTS },
    category: "bsdf",
    isShader: true,
  },

  // --- output ---
  output: {
    label: "Material Output",
    inputs: ["surface"],
    defaults: {},
    category: "output",
  },
};

/** Normalize an input entry to `{name, kind, default, min, max, step}` regardless
 *  of whether the registry listed it as a string (math/coords) or object (shader).
 *  String entries have no inline editor — kind is null.
 */
export function inputSpec(nodeType, input) {
  if (typeof input === "string") return { name: input, kind: null };
  return input;
}

/** Wrap a wired source's resolved value into an input slot on a shader builder.
 *  `value` may be a TSL node (from value/math/coords/texture) or a SHADER object
 *  (from another shader node — used by future Mix/Add shaders; harmless today).
 */
function pickInput(value, kind) {
  if (value == null) return null;
  if (value === SHADER) return value;
  if (kind === "color") return value;
  return value; // TSL coerces in math context
}

/** Helper: pull an input from `inputOf`, then fall back to the prop's default. */
async function inputOrDefault(inputOf, id, handle, propKey, kind, node, fallback) {
  const wired = await inputOf(id, handle);
  if (wired != null) return pickInput(wired, kind);
  return fallback;
}

async function colorOrDefault(inputOf, node, id, handle, propKey) {
  const wired = await inputOf(id, handle);
  if (wired != null && wired !== SHADER) return wired;
  return color(new THREE.Color(node.props[propKey] ?? "#ffffff"));
}

async function floatOrDefault(inputOf, node, id, handle, propKey, fallback) {
  const wired = await inputOf(id, handle);
  if (wired != null && wired !== SHADER) return wired;
  return float(node.props[propKey] ?? fallback);
}

export async function compileShaderGraph(graph) {
  if (!graph?.nodes?.length) return null;
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const edges = graph.edges ?? [];
  const cache = new Map();

  async function inputOf(nodeId, handle) {
    const edge = edges.find((e) => e.target === nodeId && e.targetHandle === handle);
    return edge ? build(edge.source) : null;
  }

  async function build(id) {
    if (cache.has(id)) return cache.get(id);
    const node = nodeById.get(id);
    if (!node) return null;
    const promise = (async () => {
      switch (node.type) {
        // ---------- values / sources ----------
        case "color":
          return color(new THREE.Color(node.props.value ?? "#ffffff"));
        case "float":
          return float(node.props.value ?? 0);
        case "uv":
          return uv();
        case "time":
          return time;
        case "texture": {
          if (!node.props.path) return null;
          const tex = await loadTexture(node.props.path);
          return tslTexture(tex);
        }
        case "add": {
          const [a, b] = await Promise.all([inputOf(id, "a"), inputOf(id, "b")]);
          return a && b ? add(a, b) : a ?? b ?? null;
        }
        case "subtract": {
          const [a, b] = await Promise.all([inputOf(id, "a"), inputOf(id, "b")]);
          return a && b ? sub(a, b) : a ?? null;
        }
        case "multiply": {
          const [a, b] = await Promise.all([inputOf(id, "a"), inputOf(id, "b")]);
          return a && b ? mul(a, b) : a ?? b ?? null;
        }
        case "divide": {
          const [a, b] = await Promise.all([inputOf(id, "a"), inputOf(id, "b")]);
          return a && b ? div(a, b) : a ?? null;
        }
        case "lerp": {
          const [a, b, t] = await Promise.all([inputOf(id, "a"), inputOf(id, "b"), inputOf(id, "t")]);
          return a && b && t ? mix(a, b, t) : a ?? b ?? null;
        }

        // ---------- shaders ----------
        case "principledBsdf": {
          const baseColor = await colorOrDefault(inputOf, node, id, "baseColor", "baseColor");
          const roughness = await floatOrDefault(inputOf, node, id, "roughness", "roughness", PRINCIPLED_DEFAULTS.roughness);
          const metalness = await floatOrDefault(inputOf, node, id, "metalness", "metalness", PRINCIPLED_DEFAULTS.metalness);
          const ior = await floatOrDefault(inputOf, node, id, "ior", "ior", PRINCIPLED_DEFAULTS.ior);
          const specular = await floatOrDefault(inputOf, node, id, "specular", "specular", PRINCIPLED_DEFAULTS.specular);
          const specularTint = await floatOrDefault(inputOf, node, id, "specularTint", "specularTint", PRINCIPLED_DEFAULTS.specularTint);
          const anisotropic = await floatOrDefault(inputOf, node, id, "anisotropic", "anisotropic", PRINCIPLED_DEFAULTS.anisotropic);
          const sheen = await floatOrDefault(inputOf, node, id, "sheen", "sheen", PRINCIPLED_DEFAULTS.sheen);
          const sheenTint = await floatOrDefault(inputOf, node, id, "sheenTint", "sheenTint", PRINCIPLED_DEFAULTS.sheenTint);
          const sheenRoughness = await floatOrDefault(inputOf, node, id, "sheenRoughness", "sheenRoughness", PRINCIPLED_DEFAULTS.sheenRoughness);
          const clearcoat = await floatOrDefault(inputOf, node, id, "clearcoat", "clearcoat", PRINCIPLED_DEFAULTS.clearcoat);
          const clearcoatRoughness = await floatOrDefault(inputOf, node, id, "clearcoatRoughness", "clearcoatRoughness", PRINCIPLED_DEFAULTS.clearcoatRoughness);
          const transmission = await floatOrDefault(inputOf, node, id, "transmission", "transmission", PRINCIPLED_DEFAULTS.transmission);
          const transmissionRoughness = await floatOrDefault(inputOf, node, id, "transmissionRoughness", "transmissionRoughness", PRINCIPLED_DEFAULTS.transmissionRoughness);
          const emissionCol = await colorOrDefault(inputOf, node, id, "emission", "emission");
          const emissionStrength = await floatOrDefault(inputOf, node, id, "emissionStrength", "emissionStrength", PRINCIPLED_DEFAULTS.emissionStrength);
          const alpha = await floatOrDefault(inputOf, node, id, "alpha", "alpha", PRINCIPLED_DEFAULTS.alpha);
          const sheenColor = sheenTint != null ? vec3(1).mul(sheenTint) : vec3(1);
          return {
            surface: SHADER_RESULT,
            mutations: {
              colorNode: baseColor,
              roughnessNode: roughness,
              metalnessNode: metalness,
              iorNode: ior,
              specularIntensityNode: specular,
              specularColorNode: specularTint != null ? vec3(1).mul(specularTint) : null,
              anisotropyNode: anisotropic,
              sheenNode: sheen != null ? sheenColor.mul(sheen) : null,
              sheenRoughnessNode: sheenRoughness,
              clearcoatNode: clearcoat,
              clearcoatRoughnessNode: clearcoatRoughness,
              transmissionNode: transmission,
              thicknessNode: transmissionRoughness, // close-enough: drives blur of refracted background
              emissiveNode: emissionStrength != null ? emissionCol.mul(emissionStrength) : emissionCol,
              opacityNode: alpha,
            },
          };
        }

        case "glassBsdf": {
          const col = await colorOrDefault(inputOf, node, id, "color", "color");
          const roughness = await floatOrDefault(inputOf, node, id, "roughness", "roughness", GLASS_DEFAULTS.roughness);
          const ior = await floatOrDefault(inputOf, node, id, "ior", "ior", GLASS_DEFAULTS.ior);
          return {
            surface: SHADER_RESULT,
            mutations: {
              colorNode: col,
              roughnessNode: roughness,
              metalnessNode: float(0),
              transmissionNode: float(1),
              iorNode: ior,
            },
          };
        }

        case "diffuseBsdf": {
          const col = await colorOrDefault(inputOf, node, id, "color", "color");
          const roughness = await floatOrDefault(inputOf, node, id, "roughness", "roughness", DIFFUSE_DEFAULTS.roughness);
          return {
            surface: SHADER_RESULT,
            mutations: {
              colorNode: col,
              roughnessNode: roughness,
              metalnessNode: float(0),
            },
          };
        }

        case "emission": {
          const col = await colorOrDefault(inputOf, node, id, "color", "color");
          const strength = await floatOrDefault(inputOf, node, id, "emissionStrength", "emissionStrength", EMISSION_DEFAULTS.emissionStrength);
          return {
            surface: SHADER_RESULT,
            mutations: {
              emissiveNode: strength != null ? col.mul(strength) : col,
            },
          };
        }

        // ---------- output ----------
        case "output": {
          const upstream = await inputOf(id, "surface");
          if (upstream == null) return null;
          if (upstream === SHADER) return SHADER;
          // Shader builders return `{ surface: SHADER_RESULT, mutations: {...} }` —
          // the Output just propagates that object so the asset layer can apply
          // the mutations. SHADER_RESULT is the sentinel; the `surface` prop is it.
          if (typeof upstream === "object" && upstream.surface === SHADER_RESULT) return upstream;
          return null;
        }

        default:
          return null;
      }
    })();
    cache.set(id, promise);
    return promise;
  }

  const outputNode = graph.nodes.find((n) => n.type === "output");
  if (!outputNode) return null;
  const result = await build(outputNode.id);
  if (result == null || result === SHADER) {
    // No shader wired to the output — clear all mutations so the material falls
    // back to its scalar color/rough/metal props.
    return { surface: null, mutations: {} };
  }
  return result;
}

/**
 * Translate prop names that the legacy shaderGraph.js runtime used on
 * `principledBsdf` nodes (`baseColor`, `specular`, `specularTint`, `emission`,
 * `alpha`, `transmissionRoughness`) to the names the current tslGraph runtime
 * reads (`color`, `specularIntensity`, `specularColor`, `emissive`, `opacity`,
 * `thickness`). Same for `emission` → `emissive` and `sheenTint` → `sheen`.
 *
 * Without this translation a .mat file authored under the legacy runtime
 * silently renders with the runtime's input defaults (white diffuse, etc.) —
 * every input would resolve to its spec default because none of the new keys
 * are populated.
 *
 * Idempotent and cheap — only rewrites a node when it actually has legacy
 * keys present, so already-modern graphs are returned unchanged.
 */
function normalizeLegacyPropKeys(graph) {
  if (!graph?.nodes?.length) return graph;
  // Map: legacy prop name → current (tslGraph) prop name. The values come
  // from the legacy `shaderGraph.js` PRINCIPLED_INPUTS / current tslGraph
  // NODE_TYPES.principledBsdf.inputs.
  const RENAMES = {
    baseColor: "color",
    specular: "specularIntensity",
    specularTint: "specularColor",
    anisotropicRotation: null, // dropped — tslGraph no longer exposes this input
    sheenTint: "sheen",
    emission: "emissive",
    alpha: "opacity",
    transmissionRoughness: "thickness",
  };
  let changed = false;
  const nodes = graph.nodes.map((n) => {
    if (!n?.props) return n;
    let nodeChanged = false;
    const props = { ...n.props };
    for (const [from, to] of Object.entries(RENAMES)) {
      if (from in props) {
        if (to && props[to] == null) props[to] = props[from];
        delete props[from];
        nodeChanged = true;
      }
    }
    // Legacy spec used `sheen` as the scalar amount AND tslGraph uses
    // `sheen` for the same scalar amount — they're already aligned, no rename.
    if (nodeChanged) {
      changed = true;
      return { ...n, props };
    }
    return n;
  });
  if (!changed) return graph;
  return { ...graph, nodes };
}

/**
 * Convert an older single-Output (color-sink) graph into the new shader-tree
 * shape: a Principled BSDF pre-seeded from the .mat defaults wired to the Output.
 *
 * Detected when the graph has any node of `type === "output"` with a `color`
 * target handle (the old API). Idempotent — already-migrated graphs pass through.
 */
export function migrateLegacyGraph(graph, def) {
  if (!graph?.nodes?.length) return graph;
  // Normalize prop keys first: BSDF graphs authored by the legacy
  // shaderGraph.js runtime used `baseColor`, `specular`, `specularTint`,
  // `emission`, `alpha`, `transmissionRoughness` as prop names. The current
  // tslGraph runtime reads `color`, `specularIntensity`, `specularColor`,
  // `emissive`, `opacity`, `thickness`. Without this translation a .mat
  // file authored under the old runtime silently renders with default
  // values (white diffuse, etc.) — every input resolves to its spec
  // default because none of the new keys are populated.
  const normalized = normalizeLegacyPropKeys(graph);
  // Legacy graphs wired value nodes into the Output's `color` handle (which
  // became material.colorNode) and used NO other Output handle. The modern
  // slot-based Output (tslGraph.js) also has a `color` handle, but it exposes
  // many others too (roughness/metalness/normal/…/volume). So `output.color`
  // alone is ambiguous: treat the graph as legacy only when `color` is the
  // *only* Output handle wired. Any other handle (e.g. a `volume` edge) proves
  // it's already a modern graph — migrating it would drop those edges.
  const outputIds = new Set(normalized.nodes.filter((n) => n.type === "output").map((n) => n.id));
  const outputEdges = (normalized.edges ?? []).filter((e) => outputIds.has(e.target));
  const hasLegacy =
    outputEdges.length > 0 && outputEdges.every((e) => e.targetHandle === "color");
  if (!hasLegacy) return normalized;

  // `migrateLegacyGraph` is only invoked at runtime (via `compileShaderGraph`
  // in tslGraph.js) to massage old-format graphs into modern ones. The modern
  // compile reads each input from `node.props[<input.key>]` — and in
  // tslGraph's NODE_TYPES.principledBsdf, the input keys are `color`,
  // `specularIntensity`, `specularColor`, `emissive`, `opacity`, etc., NOT
  // `baseColor`/`specular`/`specularTint`/`emission`/`alpha`. So we have to
  // emit seed props under those keys. Otherwise the migrated graph would
  // compile to the default white because every input would resolve to its
  // spec default and the user's stored `def.color` would be silently dropped.
  const seedProps = {};
  if (def?.color) seedProps.color = def.color;
  else seedProps.color = "#ffffff";
  if (def?.roughness != null) seedProps.roughness = def.roughness;
  if (def?.metalness != null) seedProps.metalness = def.metalness;
  seedProps.ior = 1.5;
  seedProps.specularIntensity = 0.5;
  seedProps.specularColor = "#ffffff";
  seedProps.emissive = "#000000";
  seedProps.emissiveStrength = 1;
  seedProps.opacity = 1;

  const oldOutput = normalized.nodes.find((n) => n.type === "output");
  const oldEdges = normalized.edges ?? [];
  const oldNodes = normalized.nodes;

  // The legacy Output only had a `color` input — every edge into it carries
  // a color expression, so we funnel them all into Principled.color (the
  // tslGraph input key, NOT `baseColor`).
  // (Anything else odd, e.g. an edge with a strange handle, just gets dropped
  // from the migrated graph; better than mis-wiring.)
  const newEdges = [];
  for (const e of oldEdges) {
    if (e.target === oldOutput.id && e.targetHandle === "color") {
      newEdges.push({ ...e, target: "principled", targetHandle: "color" });
    } else if (e.target !== oldOutput.id) {
      newEdges.push(e);
    }
  }
  newEdges.push({ source: "principled", sourceHandle: "out", target: "output", targetHandle: "surface" });

  const newNodes = [
    ...oldNodes.filter((n) => n.id !== oldOutput.id),
    { id: "principled", type: "principledBsdf", props: seedProps, position: { x: 280, y: 200 } },
    { id: "output", type: "output", props: {}, position: { x: 600, y: 200 } },
  ];

  return { nodes: newNodes, edges: newEdges };
}
