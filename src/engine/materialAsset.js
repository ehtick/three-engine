import { vmState, vmRecord } from "./vmState.js";
import * as THREE from "three/webgpu";

import { fract, interleavedGradientNoise, screenCoordinate, viewportDepthTexture } from "three/tsl";

import { resolveAssetUrl } from "./assetResolver.js";
import { migrateLegacyGraph } from "./shaderGraph.js";

import { compileShaderGraph, invalidateShaderTextureCache, migrateGraph } from "./tslGraph.js";
import { loadTextureAsset } from "./textureAsset.js";


export const MATERIAL_PIPELINE_DEFAULTS = {
  cullMode: "back",
  depthTest: true,
  depthWrite: true,
  depthFunc: "less-equal",
  colorWrite: true,
  transparent: false,
  blendMode: "normal",
  alphaTest: 0,
  alphaHash: false,
  premultipliedAlpha: false,
  polygonOffset: false,
  polygonOffsetFactor: 0,
  polygonOffsetUnits: 0,
  wireframe: false,
  toneMapped: true,
  fog: true,
};

export const MATERIAL_VOLUME_PIPELINE_DEFAULTS = {
  ...MATERIAL_PIPELINE_DEFAULTS,
  cullMode: "front",
  depthTest: false,
  depthWrite: false,
  transparent: true,
  blendMode: "additive",
};

export const MATERIAL_DEFAULTS = {

  // New materials and meshes without an assigned material use the same
  // neutral white base. Lighting, not a placeholder tint, determines their
  // visible shade.
  color: "#ffffff",

  roughness: 0.7,

  metalness: 0,

  map: "",

  shaderGraph: null,

  // Null keeps legacy/volume materials on their material-class defaults until
  // fixed-function state is explicitly authored in the Inspector.
  pipeline: null,

};

const SIDE_BY_CULL_MODE = {
  back: THREE.FrontSide,
  front: THREE.BackSide,
  none: THREE.DoubleSide,
};

const DEPTH_FUNC_BY_NAME = {
  never: THREE.NeverDepth,
  always: THREE.AlwaysDepth,
  less: THREE.LessDepth,
  "less-equal": THREE.LessEqualDepth,
  equal: THREE.EqualDepth,
  "greater-equal": THREE.GreaterEqualDepth,
  greater: THREE.GreaterDepth,
  "not-equal": THREE.NotEqualDepth,
};

const BLENDING_BY_MODE = {
  none: THREE.NoBlending,
  normal: THREE.NormalBlending,
  additive: THREE.AdditiveBlending,
  subtractive: THREE.SubtractiveBlending,
  multiply: THREE.MultiplyBlending,
};

/** Applies serialized fixed-function render state to a live Three material. */
export function applyMaterialPipeline(material, definition = MATERIAL_PIPELINE_DEFAULTS) {
  if (!material || !definition) return;
  const defaults = material.userData?.isVolumeMaterial
    ? MATERIAL_VOLUME_PIPELINE_DEFAULTS
    : MATERIAL_PIPELINE_DEFAULTS;
  const pipeline = { ...defaults, ...definition };
  material.side = SIDE_BY_CULL_MODE[pipeline.cullMode] ?? THREE.FrontSide;
  material.depthTest = pipeline.depthTest !== false;
  material.depthWrite = pipeline.depthWrite !== false;
  material.depthFunc = DEPTH_FUNC_BY_NAME[pipeline.depthFunc] ?? THREE.LessEqualDepth;
  material.colorWrite = pipeline.colorWrite !== false;
  material.transparent = pipeline.transparent === true;
  material.blending = BLENDING_BY_MODE[pipeline.blendMode] ?? THREE.NormalBlending;
  material.alphaTest = THREE.MathUtils.clamp(Number(pipeline.alphaTest) || 0, 0, 1);
  material.alphaHash = pipeline.alphaHash === true;
  material.premultipliedAlpha = pipeline.premultipliedAlpha === true;
  material.polygonOffset = pipeline.polygonOffset === true;
  material.polygonOffsetFactor = Number(pipeline.polygonOffsetFactor) || 0;
  material.polygonOffsetUnits = Number(pipeline.polygonOffsetUnits) || 0;
  if ("wireframe" in material) material.wireframe = pipeline.wireframe === true;
  material.toneMapped = pipeline.toneMapped !== false;
  material.fog = pipeline.fog !== false;
  material.needsUpdate = true;
}



const defaults = vmRecord("defaultMaterial", { material: null });



/** Shared plain-white physical material used by every mesh without a .mat assigned. */

export function getDefaultMaterial() {

  if (!defaults.material) {

    defaults.material = new THREE.MeshPhysicalNodeMaterial({

      color: new THREE.Color(MATERIAL_DEFAULTS.color),

      roughness: MATERIAL_DEFAULTS.roughness,

      metalness: MATERIAL_DEFAULTS.metalness,

    });

  }

  return defaults.material;

}



// Asset paths arrive from two sources on Windows: paths written into imported
// prefab JSON use forward slashes, while paths returned by the filesystem use
// backslashes. They identify the same file and must share one live material
// instance; otherwise the mesh and Shader Graph editor mutate separate cache
// entries with no error. Keep the original casing (portable projects may be
// opened on a case-sensitive filesystem), but canonicalise separators.
const assetKey = (path) => String(path ?? "").replaceAll("\\", "/");

// canonical path -> { path, material, def, generation, migrated, isVolume, renderable }
// VM-wide: an editor material edit invalidates the cache and notifies
// subscribers through whichever copy it imported, and a mesh that resolved its
// material through the other copy would keep the stale instance forever.
const cache = vmState("materialCache", () => new Map());


// Meshes referencing a .mat subscribe here so they can react when its material

// *instance* is swapped (surface ↔ volume) or its renderable state flips

// (nothing wired → hidden). In-place edits mutate the shared instance and need

// no notification; only identity/visibility changes do.

const subscribers = vmState("materialSubscribers", () => new Map()); // path -> Set<() => void>



/** Subscribe to material changes for `path`; returns an unsubscribe fn. */

export function subscribeMaterial(path, cb) {
  const key = assetKey(path);
  let set = subscribers.get(key);
  if (!set) subscribers.set(key, (set = new Set()));
  set.add(cb);
  return () => set.delete(cb);
}

function notifyMaterial(path) {
  const set = path && subscribers.get(assetKey(path));
  if (!set) return;
  for (const cb of set) {
    try { cb(); } catch (err) { console.error(`Material subscriber for "${path}": ${err.message}`); }
  }
}



/** A material renders when it has no shader graph (plain scalar material), or

 *  when its graph wires something into the Output's Surface or Volume socket.

 *  A graph whose Output has neither wired is invisible (Blender parity). */

function computeRenderable(graph) {

  const hasOutput = !!graph?.nodes?.some((n) => n.type === "output");

  if (!hasOutput) return true;

  const { hasSurface, hasVolume } = graphOutputState(graph);

  return hasSurface || hasVolume;

}



/** All material `*Node` slots a shader graph may populate on a

 *  MeshPhysicalNodeMaterial. Cleared on every apply. */

const NODE_SLOTS = [

  "colorNode",

  "roughnessNode",

  "metalnessNode",

  "emissiveNode",

  "opacityNode",

  "iorNode",

  "specularIntensityNode",

  "specularColorNode",

  "anisotropyNode",

  "sheenNode",

  "sheenRoughnessNode",

  "clearcoatNode",

  "clearcoatRoughnessNode",

  "transmissionNode",

  "thicknessNode",

  "normalNode",

  "aoNode",

  "positionNode",

];



function clearNodeSlots(material) {

  for (const slot of NODE_SLOTS) material[slot] = null;

}



/** Apply a compiled graph result to a live material — the single source of

 *  truth used by both the asset-load path (`applyMaterialDef`) and the live

 *  ShaderGraph editor. For a volume material the compiled Volume socket yields

 *  a `__volume` bundle that drives the VolumeNodeMaterial's built-in

 *  raymarching lighting model (density scattering, self-emission, step count);

 *  for a surface material the mutations map straight onto the `*Node` slots.

 *

 *  The `positionRay` the model hands the callbacks is world-space; the bundle's

 *  own `scattering`/`emissive` closures transform it back to the local box. */

export function applyGraphMutations(material, result, wantVolume) {

  const mutations = result?.mutations ?? {};

  if (wantVolume) {

    const v = mutations.__volume ?? null;

    material.scatteringNode = v?.scattering ? ({ positionRay }) => v.scattering(positionRay) : null;

    material.scatteringEmissiveNode = v?.emissive ? ({ positionRay }) => v.emissive(positionRay) : null;

    if (v?.steps != null) material.steps = v.steps;

    // `scatteringNode`/`scatteringEmissiveNode` are plain functions the lighting

    // model consumes — they are NOT part of three's material cache key (an

    // arrow's source text is identical every recompile, only its captured

    // closure differs). So `needsUpdate` alone re-uses the stale compiled

    // program until the render context changes on its own (which is why edits

    // only appeared after entering Play — the camera swap forced a rebuild).

    // Disposing evicts the cached node program so the next render rebuilds it

    // with the new closures, making graph edits show immediately.

    if (material.isVolumeNodeMaterial) material.dispose();

  } else {

    for (const slot of NODE_SLOTS) material[slot] = null;

    for (const [slot, node] of Object.entries(mutations)) {

      if (node == null || slot === "__volume") continue;

      material[slot] = node;

    }

  }

  material.needsUpdate = true;

}



/** Inspect the graph and return the wiring state of the Material Output. */

function graphOutputState(graph) {

  if (!graph?.nodes) return { hasSurface: false, hasVolume: false };

  const output = graph.nodes.find((n) => n.type === "output");

  if (!output) return { hasSurface: false, hasVolume: false };

  const edges = graph.edges ?? [];

  let hasSurface = false;

  let hasVolume = false;

  for (const e of edges) {

    if (e.target !== output.id) continue;

    if (e.targetHandle === "volume") hasVolume = true;

    else hasSurface = true;

  }

  return { hasSurface, hasVolume };

}



/** True when the graph wires anything into the Output's `Volume` socket —

 *  in that case the material is a `VolumeNodeMaterial` and only the

 *  `scatteringNode` slot is populated. */

function graphHasVolume(graph) {

  return graphOutputState(graph).hasVolume;

}



/** Create a fresh material instance sized for the def's intent. The caller

 *  must attach it to `entry.material` so the cache stays consistent. */

function createMaterialFor(def) {

  if (graphHasVolume(def.shaderGraph)) {

    const mat = new THREE.VolumeNodeMaterial();

    mat.userData.isVolumeMaterial = true;

    // Additive so light scattering / emission reads as glow (matches three's

    // volume-lighting example); the model already applies transmittance.

    mat.blending = THREE.AdditiveBlending;

    // Dither the ray start per pixel to hide banding at low step counts.

    mat.offsetNode = fract(interleavedGradientNoise(screenCoordinate));

    // Depth occlusion: the lighting model clips scattering behind opaque

    // geometry using `depthNode`. `viewportDepthTexture()` snapshots the

    // already-rendered opaque depth into its own texture right before this

    // (transparent) material draws — no extra scene render, so it doesn't

    // fight the main pass over shadow maps / the depth attachment the way a

    // standalone depthPass does in a plain (non-PostProcessing) render loop.

    mat.depthNode = viewportDepthTexture();

    return mat;

  }

  return new THREE.MeshPhysicalNodeMaterial();

}



export function applyMaterialDef(entry, def) {

  // If the new def switches the material kind (surface ↔ volume), swap the

  // underlying instance so the new type's slots are clean.

  const wantVolume = graphHasVolume(def.shaderGraph);

  if (entry.material && !!entry.isVolume !== wantVolume) {

    entry.material = createMaterialFor(def);

    entry.migrated = false;

  } else if (!entry.material) {

    entry.material = createMaterialFor(def);

  }

  entry.isVolume = wantVolume;

  entry.renderable = computeRenderable(def.shaderGraph);

  const { material } = entry;

  const generation = (entry.generation = (entry.generation ?? 0) + 1);

  entry.def = def;



  if (!wantVolume) {

    material.color.set(def.color ?? MATERIAL_DEFAULTS.color);

    material.roughness = def.roughness ?? MATERIAL_DEFAULTS.roughness;

    material.metalness = def.metalness ?? MATERIAL_DEFAULTS.metalness;

    if (def.map) {

      loadTextureAsset(def.map, { colorSpace: THREE.SRGBColorSpace })
        .then((texture) => {
          if (generation !== entry.generation) return;
          material.map = texture;
          material.needsUpdate = true;
          // Visibility depends on the graph's Surface/Volume wiring, not on the
          // diffuse map, but re-derive from `entry.def` so the value is always
          // consistent with the most recently applied def — the sync notify
          // below can otherwise leave a stale `false` from a half-applied graph.
          entry.renderable = computeRenderable(entry.def?.shaderGraph);
          notifyMaterial(entry.path);

        })

        .catch((err) => console.error(`Material texture "${def.map}": ${err.message}`));

    } else {

      material.map = null;

    }

  }



  // Start each apply from a clean slate of *Node slots — otherwise an old

  // graph leaving a slot populated would leak into the new graph's compile.

  if (def.pipeline) applyMaterialPipeline(material, def.pipeline);

  clearNodeSlots(material);



  if (def.shaderGraph) {

    // Two-step migration: v0 color-output → BSDF (legacy), then BSDF → slot Output.

    const graph = entry.migrated ? def.shaderGraph : migrateGraph(migrateLegacyGraph(def.shaderGraph, def));

    entry.migrated = true;

    compileShaderGraph(graph)

      .then((result) => {

        if (generation !== entry.generation) return;

        if (!result) return;

        applyGraphMutations(material, result, wantVolume);

        // The graph's `*Node` slots only exist once the (async) compile lands.
        // Subscribers that *read* those slots rather than just re-adopting the
        // instance — Terrain blends colorNode/roughnessNode/normalNode of each
        // layer .mat into its own splat material — wired themselves up before
        // this point and saw every slot null. Without this second notify they
        // keep that stale wiring forever, so a full PBR .mat renders as its
        // diffuse map alone.
        //
        // Re-evaluate visibility from the *final* graph (post-migration, in
        // `entry.def`) — the sync notify below ran with the pre-migration
        // graph and may have flipped `renderable` to `false` on a graph whose
        // Output got wired during compile. Without this refresh the mesh
        // stays hidden until a manual edit forces another apply.
        entry.renderable = computeRenderable(entry.def?.shaderGraph);
        notifyMaterial(entry.path);

      })

      .catch((err) => console.error(`Material shader graph: ${err.message}`));

  }

  material.needsUpdate = true;

  // Instance identity and renderable state are known synchronously — tell

  // subscribed meshes to (re)adopt the instance and update visibility.

  notifyMaterial(entry.path);

}



/** Returns the shared material for a .mat path, loading its def on first use. */

export async function loadMaterialAsset(path) {
  const key = assetKey(path);
  let entry = cache.get(key);
  if (!entry) {
    // Provisional def (surface). `applyMaterialDef` will swap to a volume

    // material once the file is fetched and parsed.

    entry = { path: key, material: new THREE.MeshPhysicalNodeMaterial(), def: { ...MATERIAL_DEFAULTS }, isVolume: false, renderable: true, migrated: false };
    cache.set(key, entry);
    try {

      const url = await resolveAssetUrl(path);

      const def = await (await fetch(url)).json();

      applyMaterialDef(entry, { ...MATERIAL_DEFAULTS, ...def });

    } catch (err) {

      console.error(`Failed to load material "${path}": ${err.message}`);

    }

  }

  return entry.material;

}



/** True if the .mat asset at `path` resolves to a `VolumeNodeMaterial`. The

 *  editor uses this to flag / convert meshes that point at a volume .mat. */

export function isVolumeMaterial(path) {
  return cache.get(assetKey(path))?.isVolume === true;
}



/** The current shared material instance for `path` (may change on surface ↔

 *  volume swaps — subscribers re-read it via `subscribeMaterial`). */

export function getMaterialInstance(path) {
  return cache.get(assetKey(path))?.material ?? null;
}



/** False when the .mat's graph has an Output with nothing wired to Surface or

 *  Volume — such a mesh must not render (Blender parity). Defaults to true. */

export function isMaterialRenderable(path) {
  const entry = cache.get(assetKey(path));
  return entry ? entry.renderable !== false : true;

}



/** In-place graph edit (no class change): refresh renderable state from the

 *  new graph and notify meshes so visibility tracks Surface/Volume wiring

 *  without a full recompile. The ShaderGraphPanel calls this after applying a

 *  live edit to the shared instance. */

export function syncMaterialRenderState(path, graph) {
  const entry = cache.get(assetKey(path));
  if (!entry) return;

  if (entry.def) entry.def.shaderGraph = graph;

  entry.renderable = computeRenderable(graph);

  notifyMaterial(path);

}



/**
 * Compiles a .mat's graph into raw `*Node` mutations for a caller that wants to
 * blend them into its *own* material rather than use the shared instance.
 *
 * Terrain is the reason this exists. It can't just read the shared instance's
 * `*Node` slots: those bake in the graph's own `uv()`, so every layer would
 * sample at the terrain's raw UV and the layer's `tiling` would do nothing.
 * Passing `uvNode` recompiles the same graph against the layer's tiled UV.
 *
 * Returns null when the .mat has no graph (a plain scalar material) — the
 * caller should fall back to the instance's scalar color/roughness/metalness.
 */
export async function compileMaterialGraph(path, { uvNode = null } = {}) {
  const entry = cache.get(assetKey(path));
  const def = entry?.def;
  if (!def?.shaderGraph) return null;
  const graph = migrateGraph(migrateLegacyGraph(def.shaderGraph, def));
  const result = await compileShaderGraph(graph, { uvNode });
  return result?.mutations ?? null;
}

/** Editor hooks: read the cached def / push edits into the live shared material. */

export function getMaterialDef(path) {
  return cache.get(assetKey(path))?.def ?? null;
}

export function updateMaterialAsset(path, def) {
  const entry = cache.get(assetKey(path));
  if (entry) applyMaterialDef(entry, def);

}

/** Fast editor path for fixed-function state changes; avoids recompiling TSL. */
export function updateMaterialPipeline(path, pipeline) {
  const entry = cache.get(assetKey(path));
  if (!entry) return;
  entry.def = { ...entry.def, pipeline: { ...pipeline } };
  applyMaterialPipeline(entry.material, pipeline);
  notifyMaterial(path);
}

/** Best-effort swatch color for a .mat: walks the live material's
 *  colorNode to find a constant color. Used by the editor's swatch UI so
 *  it shows what the material *actually* renders, not what the top-level
 *  `def.color` field happens to be — those can drift (a Shader Graph edit
 *  changes colorNode without writing back to the top-level field, an old
 *  .mat file might have a stale `color: "#ffffff"` from a buggy autosave
 *  before the swatch was fixed, etc.).
 *
 * Returns a `#rrggbb` string or `null` when the color can't be resolved
 * (complex expression, no material loaded yet, etc.). The caller decides
 *  what to fall back to. */
export function getMaterialColorPreview(path) {
  const entry = cache.get(assetKey(path));
  if (!entry?.material) return null;
  const node = entry.material.colorNode;
  if (!node) {
    // No shader graph (or graph compile hasn't landed yet) — fall back to
    // the scalar `material.color` which is set synchronously from def.color.
    const c = entry.material.color;
    if (c && typeof c.r === "number") {
      const r = Math.round(c.r * 255);
      const g = Math.round(c.g * 255);
      const b = Math.round(c.b * 255);
      return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    }
    return null;
  }
  return readConstantColor(node);
}

/** Walk a TSL color expression looking for a constant ColorNode / uniform
 *  carrying a THREE.Color or [r,g,b] array. Returns null for anything more
 *  complex (e.g. multiply, add, texture sample). */
function readConstantColor(node) {
  if (!node) return null;
  // TSL ColorNode / uniform-color: `value` is a THREE.Color (has r/g/b in 0..1).
  const v = node.value;
  if (v && typeof v === "object" && typeof v.r === "number" && typeof v.g === "number" && typeof v.b === "number") {
    const r = Math.round(v.r * 255);
    const g = Math.round(v.g * 255);
    const b = Math.round(v.b * 255);
    return `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
  }
  return null;
}



/**
 * Re-reads a `.mat` from disk and re-applies it to the SHARED instance every
 * mesh already points at.
 *
 * For when the file changed underneath the editor — a `.mat` written by an
 * agent, an external tool, or a version-control checkout. Mutating the existing
 * instance rather than making a new one is what makes the change appear without
 * touching a single mesh: nothing has to be re-pointed, and a surface↔volume
 * switch still reaches subscribers through `applyMaterialDef`.
 *
 * The caller must have dropped any cached URL for `path` first (the editor's
 * `invalidateBlobUrl`), or `resolveAssetUrl` hands back the stale bytes.
 *
 * Returns false when the material was never loaded — there is nothing on screen
 * using it, so there is nothing to refresh.
 */
export async function reloadMaterialAsset(path) {
  const entry = cache.get(assetKey(path));
  if (!entry) return false;
  const url = await resolveAssetUrl(path);
  const def = await (await fetch(url)).json();
  applyMaterialDef(entry, { ...MATERIAL_DEFAULTS, ...def });
  return true;
}

/** Re-applies materials referencing a texture (after its .meta changed). */

export function refreshMaterialsUsingTexture(texPath) {
  const key = assetKey(texPath);
  invalidateShaderTextureCache(texPath);
  for (const entry of cache.values()) {
    if (assetKey(entry.def?.map) === key) applyMaterialDef(entry, entry.def);
  }
}

/** Re-resolves texture variants after the Basis module is toggled. */
export function refreshAllMaterials() {
  invalidateShaderTextureCache();
  for (const entry of cache.values()) applyMaterialDef(entry, entry.def);
}
