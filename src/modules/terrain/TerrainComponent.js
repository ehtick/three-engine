// @ts-check
import * as THREE from "three/webgpu";
import { brushWeight } from "../../engine/brush.js";
import { texture as tslTexture, uv, float, vec3, normalMap, normalView } from "three/tsl";
import { Component } from "../../engine/components/Component.js";
import { resolveAssetUrl } from "../../engine/assetResolver.js";
import { loadTextureAsset } from "../../engine/textureAsset.js";
import {
  compileMaterialGraph,
  getMaterialInstance,
  loadMaterialAsset,
  subscribeMaterial,
} from "../../engine/materialAsset.js";
import { getGltfLoader } from "../../engine/gltfLoader.js";
import { freeze } from "../../engine/freezeLedger.js";
import { frameSliceBudget } from "../../engine/frameSlice.js";
import { stableInstanceCapacity } from "../../engine/instanceCapacity.js";
import {
  PROCEDURAL_TERRAIN_PARAMS,
  landscapeOptionsFromProps,
  fillHeightfield,
  ALWAYS_FILL_NOW,
} from "../../engine/terrain/proceduralTerrain.js";
import { getLandscape, getLandscapeSteps } from "../../engine/terrain/landscapeGenerator.js";
import { createTerrainStone, rockLibraryFor, rockLibraryStepsFor } from "./terrainRocks.js";
import { placeRocks } from "../../engine/rocks/rockPlacement.js";
import { paintLandscapeGround, createLandscapeGroundMaterial, resolveGroundPalette } from "./terrainGround.js";

/** One inspector row per `PROCEDURAL_TERRAIN_PARAMS` entry — the "Procedural"
 *  group is table-generated, never hand-duplicated. Hidden until `procedural`
 *  is on, same convention `showIf` already uses elsewhere in the editor. */
function proceduralSchemaRow(param) {
  return {
    key: param.key,
    label: param.label,
    type: param.kind === "enum" ? "select" : param.kind === "boolean" ? "boolean" : "number",
    ...(param.kind === "enum" ? { options: param.choices } : {}),
    ...(param.kind !== "enum" && param.kind !== "boolean" ? { min: param.min, max: param.max, step: param.step } : {}),
    hint: param.hint,
    section: "Procedural",
    showIf: (props) => !!props.procedural,
  };
}
/** Component prop name -> default, for every procedural param. */
const PROCEDURAL_DEFAULTS = Object.fromEntries(PROCEDURAL_TERRAIN_PARAMS.map((param) => [param.key, param.default]));
/** The 12 procedural param keys, for the `onPropChanged` dispatch below —
 *  changing any of them (while `procedural` is on) regrows the base grid. */
const PROCEDURAL_PARAM_KEYS = new Set(PROCEDURAL_TERRAIN_PARAMS.map((param) => param.key));
/** Ground colour props (09-14): repaint only, never a regrow. */
const TERRAIN_COLOR_KEYS = new Set(["customColors", "grassColor", "soilColor", "rockColor"]);

export const MAX_TERRAIN_LAYERS = 4;
export const SCULPT_TOOLS = ["raise", "lower", "smooth", "flatten", "sharpen", "contrast", "pinch", "erode", "noise"];
const scatterLoader = getGltfLoader();

/** A fresh terrain layer — a full PBR surface (rock, grass, …), not just a
 *  texture. `albedo`/`normalMap`/`roughnessMap` are optional asset paths;
 *  `tint`/`roughness`/`metalness` are scalar fallbacks/multipliers so an
 *  untextured layer is still a valid flat-colored surface. */
export function makeTerrainLayer(overrides = {}) {
  return {
    material: "",
    opacity: 1,
    albedo: "",
    normalMap: "",
    roughnessMap: "",
    tiling: 20,
    tint: "#8a8f7a",
    roughness: 0.95,
    metalness: 0,
    visible: true,
    ...overrides,
  };
}

export const SCATTER_ALIGN_MODES = ["surface", "axis", "source"];
export const SCATTER_AXES = ["+x", "-x", "+y", "-y", "+z", "-z"];

const AXIS_VECTORS = {
  "+x": new THREE.Vector3(1, 0, 0),
  "-x": new THREE.Vector3(-1, 0, 0),
  "+y": new THREE.Vector3(0, 1, 0),
  "-y": new THREE.Vector3(0, -1, 0),
  "+z": new THREE.Vector3(0, 0, 1),
  "-z": new THREE.Vector3(0, 0, -1),
};
const UP_Y = new THREE.Vector3(0, 1, 0);

// Scratch objects — `scatterPlacementMatrix` runs once per instance per refresh
// (thousands of times on a sculpt stroke), so it must not allocate.
const _pos = new THREE.Vector3();
const _up = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _euler = new THREE.Euler();

/**
 * The six random numbers an instance keeps: [yaw, tiltX, tiltZ, scale, stretch,
 * heightOffset], each in 0..1. Storing the *draws* rather than the resolved
 * values is what makes the layer's ranges editable after the fact — the same
 * rock keeps its identity in the distribution while the range moves under it.
 */
function randomDraws(random) {
  return [random(), random(), random(), random(), random(), random()];
}

/** A PRNG seeded from a position — same spot, same numbers, every time. */
function positionSeeded(x, z) {
  let state = (Math.imul(Math.round(x * 1000) | 0, 374761393) ^ Math.imul(Math.round(z * 1000) | 0, 668265263)) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * Upgrades instances painted before placement settings existed. Those baked
 * their transform into the instance, which means every knob on the layer would
 * do nothing to them — the thing you'd actually notice as "changing the
 * settings has no effect on my scatter".
 *
 * The migration must be *deterministic*: it runs again on every `setProp`
 * (props still hold the old shape until the next commit), so drawing fresh
 * randoms would reshuffle the whole layer on each keystroke. Seeding from the
 * instance's position fixes that, and the existing scale is inverted back into
 * its draw so instances keep the exact size they already had.
 */
function migrateScatterInstances(layer) {
  for (const item of layer.instances ?? []) {
    if (item.r) continue;
    const x = item.position?.[0] ?? 0;
    const z = item.position?.[2] ?? 0;
    const random = positionSeeded(x, z);
    const scaleMin = layer.scaleMin ?? 0.8;
    const scaleMax = layer.scaleMax ?? 1.2;
    const scaleDraw = scaleMax > scaleMin
      ? THREE.MathUtils.clamp(((item.scale ?? 1) - scaleMin) / (scaleMax - scaleMin), 0, 1)
      : 0.5;
    // Yaw/tilt are re-drawn (recovering them from the baked quaternion isn't
    // worth it — a different shuffle of the same distribution is invisible),
    // but scale and seating are preserved exactly.
    item.r = [random(), random(), random(), scaleDraw, 0.5, 0.5];
    delete item.quaternion;
    delete item.scale;
    delete item.heightOffset; // the layer's Sink + the r[5] draw own this now
  }
  return layer;
}

/**
 * A scatter layer: a model painted onto the terrain as InstancedMeshes.
 *
 * Placement settings live on the *layer*, and an instance stores only its
 * position plus its raw random draws (`r`, six values in 0..1). Nothing about
 * the final transform is baked, so every knob below re-resolves live across the
 * instances already painted — drag Scale Max and the existing rocks grow. It
 * also means surface-aligned instances re-orient themselves when you sculpt the
 * ground underneath them, instead of hovering at their old angle.
 */
export function makeTerrainScatterLayer(overrides = {}) {
  return {
    name: "Scatter",
    sourceType: "asset", // "asset" | "entity"
    model: "",
    sourceEntity: "",
    instances: [],
    castShadow: true,
    receiveShadow: true,
    visible: true,

    // --- orientation ---
    // "surface" — stand up along the terrain normal (blend controls how much)
    // "axis"    — a fixed axis, ignoring the terrain
    // "source"  — copy the source object's own rotation
    align: "surface",
    alignAxis: "+y", // the "up" the model is authored around
    alignBlend: 1, // 0 = ignore the normal, 1 = fully follow it
    yawMin: 0, // random spin about the model's own up, in degrees
    yawMax: 360,
    tiltJitter: 0, // random lean off the align axis, in degrees

    // --- size ---
    scaleMin: 0.8,
    scaleMax: 1.2,
    stretchMin: 1, // extra multiplier on the up axis only (squat/lanky variation)
    stretchMax: 1,

    // --- seating ---
    heightOffset: 0, // sink (negative) or lift every instance
    heightJitter: 0, // ± random sink/lift

    // --- where it's allowed to land (checked when painting) ---
    slopeMin: 0, // degrees from flat
    slopeMax: 90,
    altitudeMin: -1000,
    altitudeMax: 1000,

    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// Binary <-> base64 helpers (scene-JSON friendly; keeps serialize.js generic).
// Bytes are stringified in chunks — spreading a large typed array straight into
// String.fromCharCode(...arr) overflows the call stack (a 256^2 splatmap is
// 256 KB).
// -----------------------------------------------------------------------------
function bytesToBinaryString(bytes) {
  const CHUNK = 8192;
  let out = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}
function encodeFloat32(arr) {
  return btoa(bytesToBinaryString(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)));
}
function decodeFloat32(str, length) {
  if (!str) return new Float32Array(length);
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const arr = new Float32Array(bytes.buffer);
  // Length mismatch (resolution changed elsewhere): start fresh rather than
  // reading past the buffer end.
  return arr.length === length ? arr : new Float32Array(length);
}
function encodeUint8(arr) {
  return btoa(bytesToBinaryString(arr));
}
function decodeUint8(str, length) {
  if (!str) return null;
  const bin = atob(str);
  if (bin.length !== length) return null;
  const arr = new Uint8Array(length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

/** Empty splatmap: every paint layer starts transparent over the base material. */
function makeDefaultSplat(resolution) {
  return new Uint8Array(resolution * resolution * 4);
}

// -----------------------------------------------------------------------------
// Brush math helpers (module-private).
// -----------------------------------------------------------------------------

/** Average of a vertex's 8-neighborhood (clamped at edges). */
function neighborAvg(src, cols, r, c, res) {
  let sum = 0, n = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || rr > res || cc < 0 || cc > res) continue;
      sum += src[rr * cols + cc];
      n++;
    }
  }
  return n ? sum / n : src[r * cols + c];
}

/** Minimum of a vertex's 8-neighborhood — morphological erosion carves down. */
function neighborMin(src, cols, r, c, res) {
  let mn = Infinity;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || rr > res || cc < 0 || cc > res) continue;
      mn = Math.min(mn, src[rr * cols + cc]);
    }
  }
  return Number.isFinite(mn) ? mn : src[r * cols + c];
}

function hash2(x, y, seed) {
  const h = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return h - Math.floor(h);
}
/** Smooth 2D value noise in [0,1] — coherent bumps for the "noise" brush. */
function valueNoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, u), THREE.MathUtils.lerp(c, d, u), v);
}

/**
 * Vertex normals for one rectangle of heightfield grid vertices — rows
 * `rMin..rMax`, columns `cMin..cMax`, inclusive — written in place into `out`
 * (a normal attribute's array; vertex (r, c) is array index `r * (res + 1) + c`).
 * O(rectangle), so a brush dab can refresh only the vertices it moved plus the
 * one-vertex ring whose normals read into them.
 *
 * This is EXACTLY what `BufferGeometry.computeVertexNormals()` produces for a
 * `PlaneGeometry(size, size, res, res).rotateX(-PI / 2)`: the unnormalised
 * (area-weighted) sum of the six triangles around a vertex, then normalised.
 * ⛔ It is NOT the central difference `(-dh/dx, 1, -dh/dz)` — that agrees only
 * to first order, and on the coarse, bumpy grid a freshly sculpted terrain is
 * the two shade visibly differently (a dab would then "pop" at pointerup when
 * the full pass replaced them). PlaneGeometry splits every cell along the
 * (r+1, c)–(r, c+1) diagonal, so two of the six triangles reach the NE and SW
 * diagonal neighbours; edge and corner vertices sum the triangles that exist.
 * Pinned against three's own result in tests/terrain-sculpt.test.mjs.
 *
 * Layout (see #buildGeometry): row r → local z = -half + r·step, column c →
 * local x = -half + c·step, y = height.
 */
export function heightfieldNormals(heights, res, step, out, rMin = 0, rMax = res, cMin = 0, cMax = res) {
  const cols = res + 1;
  rMin = Math.max(0, rMin);
  rMax = Math.min(res, rMax);
  cMin = Math.max(0, cMin);
  cMax = Math.min(res, cMax);
  for (let r = rMin; r <= rMax; r++) {
    const row = r * cols;
    for (let c = cMin; c <= cMax; c++) {
      const i = row + c;
      const h0 = heights[i];
      let nx = 0, ny = 0, nz = 0;
      // Each block is one cell's triangles touching this vertex, as three
      // accumulates them: (C - B) × (A - B) per face, with the common factor
      // `step` divided out (every face contributes `step` to y).
      if (r < res && c < res) {
        // face (P, S, E)
        const hS = heights[i + cols], hE = heights[i + 1];
        nx -= hE - h0; ny += step; nz -= hS - h0;
      }
      if (r > 0 && c < res) {
        // faces (N, P, NE) and (P, E, NE)
        const hN = heights[i - cols], hNE = heights[i - cols + 1], hE = heights[i + 1];
        nx -= hNE - hN; ny += step; nz -= h0 - hN;
        nx -= hE - h0; ny += step; nz += hNE - hE;
      }
      if (r > 0 && c > 0) {
        // face (W, P, N)
        const hW = heights[i - 1], hN = heights[i - cols];
        nx -= h0 - hW; ny += step; nz += hN - h0;
      }
      if (r < res && c > 0) {
        // faces (W, SW, P) and (SW, S, P)
        const hW = heights[i - 1], hSW = heights[i + cols - 1], hS = heights[i + cols];
        nx -= h0 - hW; ny += step; nz -= hSW - hW;
        nx -= hS - hSW; ny += step; nz += h0 - hS;
      }
      const len = Math.hypot(nx, ny, nz) || 1;
      out[i * 3] = nx / len;
      out[i * 3 + 1] = ny / len;
      out[i * 3 + 2] = nz / len;
    }
  }
}

/**
 * Heightmap-displaced ground plane with up to 4 splatmap-blended texture
 * layers. Geometry, heights, and the splatmap are all CPU-owned so brush
 * strokes can mutate live buffers directly for immediate visual feedback;
 * `props.heights`/`props.splatmap` are only re-encoded (base64) once per
 * stroke, on commit.
 *
 * Lives in the optional `terrain` module — not part of the base engine.
 * Sculpt/paint strokes are driven externally (the editor's viewport pointer
 * handlers call the brush methods); this component owns the data and the
 * material, exposing cheap mutation + commit methods.
 */
export class TerrainComponent extends Component {
  static type = "terrain";
  static label = "Terrain";
  static tags = ["world", "terrain", "heightmap", "3d"];
  static requiredComponents = ["mesh"];
  static defaults = {
    size: 50,
    resolution: 128,
    splatResolution: 256,
    splatmap: "", // base64 Uint8Array(splatResolution^2 * 4)
    layers: [], // optional material overlays blended over the Mesh base material
    scatterLayers: [], // model-backed instance layers painted onto the surface
    castShadow: false,
    receiveShadow: true,
    // --- Procedural (P1-T) ---
    proceduralSeed: 1,
    proceduralExtent: 0, // landscape extent the grid samples; 0 = this terrain's own size
    proceduralOrigin: [0, 0], // this grid's centre inside the landscape (a chunk tile)
    proceduralReserve: 0, // square (m) at the landscape origin with no generated rivers/lakes (a World region)
    stoneLayer: true, // build the Stone control's rock structures (World draws its own)
    // Ground colours (09-14). Off = the style's own palette. A World turns this
    // on and hands in its Ground swatches, so this inspector shows the colours
    // the landscape is really painted with (an edit here edits that swatch).
    customColors: false,
    grassColor: "#5f7a3a",
    soilColor: "#6f624c",
    rockColor: "#77736c",
    ...PROCEDURAL_DEFAULTS, // style, height, scale, levels, wildness, erosion, rocks
    // `heights`, `heightEdits` and `procedural` MUST stay last, in this exact
    // order. A bulk multi-key update — WorldComponent._commit's generic
    // desired-vs-current diff, or any script writing several props at once —
    // applies `Object.entries(desired)` in object-key order, which for
    // `{...defaults, ...providerProps}` is exactly THIS declaration order
    // (providerProps only ever updates values in place, never reorders).
    // `onPropChanged` for every Procedural param/seed is a no-op while
    // `procedural` is false, so ordering them all before `procedural` means
    // the eventual `setBaseProp("procedural", true)` is the ONE moment a
    // rebuild actually happens, already seeing every other correct value —
    // not a cascade of intermediate rebuilds each keyed to a half-updated
    // prop set (a scene saved before `procedural` existed hit exactly that:
    // its loaded `heights`/absent-`procedural` diffed against the plan in
    // whatever order `changes` happened to list them).
    heights: "", // base64 Float32Array((resolution+1)^2), row-major. Ignored while `procedural` is on.
    // Sculpt delta against the procedural base, same base64 layout as `heights`.
    heightEdits: "",
    procedural: false, // when on, the base grid is generated instead of authored/sculpted freehand
  };
  static schema = [
    { key: "size", label: "Size", type: "number", min: 1, step: 1 },
    { key: "resolution", label: "Resolution", type: "number", min: 2, max: 512, step: 1 },
    { key: "splatResolution", label: "Splat Resolution", type: "number", min: 16, max: 1024, step: 1 },
    { key: "castShadow", label: "Cast Shadow", type: "boolean" },
    { key: "receiveShadow", label: "Receive Shadow", type: "boolean" },
    {
      key: "procedural", label: "Procedural", type: "boolean", section: "Procedural",
      hint: "Generate the base grid instead of authoring/sculpting it freehand. A sculpt stroke still works — it lands in a separate delta on top of the generated base, so changing a param below never erases it.",
    },
    {
      key: "proceduralSeed", label: "Seed", type: "number", min: 0, max: 0xffffffff, step: 1, section: "Procedural",
      hint: "Chooses every procedural decision for this terrain's own base grid.",
      showIf: (props) => !!props.procedural,
    },
    ...PROCEDURAL_TERRAIN_PARAMS.map(proceduralSchemaRow),
    {
      key: "customColors", label: "Custom Colours", type: "boolean", section: "Colours",
      hint: "Paint the procedural ground with the colours below instead of the style's palette. In a World these are the World's Ground colours.",
      showIf: (props) => !!props.procedural,
    },
    ...[["grassColor", "Grass"], ["soilColor", "Soil"], ["rockColor", "Rock"]].map(([key, label]) => ({
      key, label, type: "color", section: "Colours",
      showIf: (props) => !!props.procedural && !!props.customColors,
    })),
  ];

  onAttach() {
    this.#buildGeometry();
    this.#buildSplatmap();
    this.#buildMaterial();
    const meshComponent = this.entity.getComponent("mesh");
    if (!meshComponent?.mesh) throw new Error("Terrain requires an attached Mesh component");
    this.meshComponent = meshComponent;
    this.previousMeshGeometry = meshComponent.mesh.geometry;
    this.previousMeshMaterial = meshComponent.mesh.material;
    this.mesh = meshComponent.mesh;
    this.mesh.geometry = this.geometry;
    this.mesh.material = this.material;
    this.mesh.userData.entityId = this.entity.id;
    this.mesh.castShadow = !!this.props.castShadow;
    this.mesh.receiveShadow = !!this.props.receiveShadow;
    this.mesh.visible = this.enabled;
    this.scatterRoot = new THREE.Group();
    this.scatterRoot.name = "Terrain Scatter";
    this.entity.object3D.add(this.scatterRoot);
    this.scatterLayersData = this.#adoptScatterLayers(this.props.scatterLayers);
    this.scatterSources = [];
    this.unsubScatterModel = this.entity.engine.on("model-loaded", (entity) => {
      if ((this.scatterLayersData ?? []).some((layer) => layer.sourceType === "entity" && layer.sourceEntity === entity.id)) {
        this.#loadScatterLayers();
      }
    });
    this.unsubScatterSourceChange = this.entity.engine.on("component-changed", (info) => {
      if ((info.componentType === "mesh" || info.componentType === "model")
        && (this.scatterLayersData ?? []).some((layer) => layer.sourceType === "entity" && layer.sourceEntity === info.entityId)) {
        this.#loadScatterLayers();
      }
    });
    this.unsubScatterHierarchy = this.entity.engine.on("hierarchy-changed", () => {
      if (this.#scatterSourceReadinessChanged()) this.#loadScatterLayers();
    });
    this.unsubTerrainMeshChange = this.entity.engine.on("component-changed", (info) => {
      if (info.entityId !== this.entity.id || info.componentType !== "mesh") return;
      if (info.key === "material") this.#loadBaseMaterial();
      this.#applyTerrainMesh();
    });
    this.#loadScatterLayers();
    this.#loadLayerMaps();
    this.#loadBaseMaterial();
    if (this._proceduralFillPending) {
      // Stone is built when the fill lands (see #scheduleProceduralFill).
      this._proceduralFillPending = false;
      this.#scheduleProceduralFill();
    } else {
      this.#paintProceduralGround();
      this.#rebuildStone();
    }
  }

  onDetach() {
    if (!this.mesh) return;
    this._stoneGeneration = (this._stoneGeneration ?? 0) + 1;
    this._stoneUnsub?.();
    this._stoneUnsub = null;
    this._stone?.dispose();
    this._stone = null;
    if (this._groundMaterial) {
      this.clearProceduralMaterial(this);
      this._groundMaterial.dispose();
      this._groundMaterial = null;
    }
    this.generation = (this.generation ?? 0) + 1;
    this._committedHeights = null;
    this._committedHeightEdits = null;
    this._brushScratch = null;
    // Cancel any in-flight sliced procedural regeneration (see
    // #scheduleProceduralFill): its onPreRender tick must not touch a
    // detached component's geometry.
    this._proceduralGeneration = (this._proceduralGeneration ?? 0) + 1;
    this._proceduralUnsub?.();
    this._proceduralUnsub = null;
    if (this.meshComponent?.mesh === this.mesh) {
      this.mesh.geometry = this.previousMeshGeometry;
      this.mesh.material = this.previousMeshMaterial;
    }
    if (this.scatterRoot) this.entity.object3D.remove(this.scatterRoot);
    this.#disposeScatterLayers();
    this.unsubScatterModel?.();
    this.unsubScatterModel = null;
    this.unsubScatterSourceChange?.();
    this.unsubScatterSourceChange = null;
    this.unsubScatterHierarchy?.();
    this.unsubScatterHierarchy = null;
    this.unsubTerrainMeshChange?.();
    this.unsubTerrainMeshChange = null;
    this.geometry.dispose();
    this.material.dispose();
    this.splatTexture.dispose();
    this.#disposeLayerMaps();
    this.#disposeLayerMaterials();
    this.#disposeBaseMaterial();
    this.mesh = null;
    this.meshComponent = null;
    this.previousMeshGeometry = null;
    this.previousMeshMaterial = null;
    this.scatterRoot = null;
  }

  onDisable() {
    if (this._stone) this._stone.group.visible = false;
    if (this.mesh) this.mesh.visible = false;
    if (this.scatterRoot) this.scatterRoot.visible = false;
  }

  onEnable() {
    if (this._stone) this._stone.group.visible = true;
    if (this.mesh) this.mesh.visible = true;
    if (this.scatterRoot) this.scatterRoot.visible = true;
  }

  onPropChanged(key) {
    if (key === "heights") {
      // Ignored while procedural: the base grid comes from the Procedural
      // params instead, and a sculpt stroke lands in `heightEdits`. A stray
      // write here (an old command, a script) must not fight that.
      if (this.props.procedural) return;
      if (this._committedHeights != null && this.props.heights === this._committedHeights) {
        // The stroke's own SetTerrainHeightsCommand echoing the string
        // `commitHeights()` just encoded from the live buffer: the geometry
        // already IS this state, so the decode and the second full pass
        // (normals, bounds, every scatter layer) would only repeat the commit.
        this._committedHeights = null;
        return;
      }
      this._committedHeights = null;
      this.heightsArray = decodeFloat32(this.props.heights, (this._gridResolution + 1) ** 2);
      this.#applyHeightsToGeometry();
      this.#announceSurfaceChange("committed");
      return;
    }
    if (key === "heightEdits") {
      // Inert until procedural is on — see `heights` above for the symmetric
      // case. A resolution/procedural toggle rebuilds wholesale (bottom of
      // this method) and decodes this fresh there instead.
      if (!this.props.procedural) return;
      if (this._committedHeightEdits != null && this.props.heightEdits === this._committedHeightEdits) {
        this._committedHeightEdits = null;
        return;
      }
      this._committedHeightEdits = null;
      this._heightEditsArray = decodeFloat32(this.props.heightEdits, (this._gridResolution + 1) ** 2);
      this.#applyProceduralEditsToGeometry();
      this.#announceSurfaceChange("committed");
      return;
    }
    if (TERRAIN_COLOR_KEYS.has(key)) { this.#paintProceduralGround(); return; }
    if (key === "stoneLayer") { this.#rebuildStone(); return; }
    if (key === "proceduralSeed" || key === "proceduralExtent" || key === "proceduralOrigin" || key === "proceduralReserve" || PROCEDURAL_PARAM_KEYS.has(key)) {
      // The 12 shape params plus the seed only matter while procedural is on;
      // an edit while it is off is an inert prop write (no geometry effect).
      if (this.props.procedural) this.#scheduleProceduralFill();
      return;
    }
    if (key === "splatmap") {
      const decoded = decodeUint8(this.props.splatmap, this._splatResolution * this._splatResolution * 4);
      this.splatData = decoded ?? makeDefaultSplat(this._splatResolution);
      this.splatTexture.image.data.set(this.splatData);
      this.splatTexture.needsUpdate = true;
      return;
    }
    if (key === "layers") {
      this.#loadLayerMaps();
      return;
    }
    if (key === "scatterLayers") {
      const next = this.#adoptScatterLayers(this.props.scatterLayers);
      const sourceKeys = next.map((layer) => layer.sourceType === "entity"
        ? `entity:${layer.sourceEntity ?? ""}`
        : `asset:${layer.model ?? ""}`);
      const canReuse = sourceKeys.length === (this.scatterSourceKeys?.length ?? -1)
        && sourceKeys.every((path, i) => path === this.scatterSourceKeys[i]);
      this.scatterLayersData = next;
      if (canReuse) {
        for (let i = 0; i < next.length; i++) this.#refreshScatterLayer(i);
      } else {
        this.#loadScatterLayers();
      }
      return;
    }
    if (key === "castShadow" || key === "receiveShadow") {
      if (this.mesh) this.mesh[key] = !!this.props[key];
      return;
    }
    // size / resolution / splatResolution: structural — full rebuild.
    this.onDetach();
    this.onAttach();
  }

  // ---------------------------------------------------------------------------
  // Geometry / heights
  // ---------------------------------------------------------------------------

  #buildGeometry() {
    // Component mirrors authored props through setters. Runtime dimensions
    // must use separate names: assigning this.resolution re-enters onAttach.
    const resolution = (this._gridResolution = Math.max(2, Math.floor(this.props.resolution ?? 128)));
    const size = this.props.size ?? 50;
    this.geometry = new THREE.PlaneGeometry(size, size, resolution, resolution);
    this.geometry.rotateX(-Math.PI / 2);
    if (this.props.procedural) {
      // A structural rebuild (attach, a resolution/size/procedural-toggle
      // change) drives the fill to completion synchronously — the same cost
      // an ordinary `heights` decode already pays here, unsliced. Live
      // param edits while already attached go through #scheduleProceduralFill
      // instead, which is the one that must not freeze.
      this._heightEditsArray = decodeFloat32(this.props.heightEdits, (resolution + 1) ** 2);
      // ⛔ 09-14 live: a synchronous landscape build here blocked attach for
      // 0.6-0.8 s per terrain. With a frame loop, attach flat (plus any edits)
      // and let `onAttach` schedule the sliced fill; headless callers stay sync.
      const deferred = typeof this.entity?.engine?.onPreRender === "function";
      this._proceduralBase = deferred ? new Float32Array((resolution + 1) ** 2) : this.#fillProceduralBaseSync();
      this._proceduralFillPending = deferred;
      this.heightsArray = new Float32Array((resolution + 1) ** 2);
      for (let i = 0; i < this.heightsArray.length; i++) this.heightsArray[i] = this._proceduralBase[i] + this._heightEditsArray[i];
    } else {
      this.heightsArray = decodeFloat32(this.props.heights, (resolution + 1) ** 2);
    }
    this.#applyHeightsToGeometry();
  }

  /** Builds this terrain's own shape/rockiness from its current Procedural
   *  props (see `createProceduralTerrainShape`) and a fresh generator over it. */
  #createProceduralGenerator(clock, target) {
    const options = landscapeOptionsFromProps(this.props);
    return fillHeightfield((sliceClock) => getLandscapeSteps(options, sliceClock), {
      size: this.props.size ?? 50, resolution: this._gridResolution,
      overlay: this._shapeOverlay, clock, target, origin: this.props.proceduralOrigin ?? [0, 0],
    });
  }

  /** Drives a fresh procedural fill to completion right now — the attach/
   *  structural-rebuild path, where a synchronous cost is already accepted. */
  #fillProceduralBaseSync() {
    const generator = this.#createProceduralGenerator(ALWAYS_FILL_NOW, null);
    let result = generator.next();
    while (!result.done) result = generator.next();
    return result.value;
  }

  /**
   * The live-edit path: a Procedural param, the seed, or an owner's
   * `setShapeOverlay`/`clearShapeOverlay` changed while already attached.
   * Sliced over the engine's own per-frame ticks (`entity.engine.onPreRender`,
   * the same hook `WorldComponent` ticks its own generation from) so a large
   * standalone terrain's slider drag never blocks a frame; the OLD grid stays
   * on screen until the new one is ready. World's own fast path — an overlay
   * whose `samples` already match this grid — completes on the very first
   * slice (see `fillHeightfield`), so a World-owned terrain never actually
   * waits on a render tick here.
   *
   * No `engine.onPreRender` available (a bare component under a test harness,
   * or any headless driver with no render loop) finishes synchronously rather
   * than never — the alternative is a terrain that silently never updates.
   */
  #scheduleProceduralFill() {
    const generation = (this._proceduralGeneration = (this._proceduralGeneration ?? 0) + 1);
    this._proceduralUnsub?.();
    this._proceduralUnsub = null;
    const fillStart = performance.now();
    let slices = 0;
    const finish = (base) => {
      if (generation !== this._proceduralGeneration || !this.geometry) return;
      this._proceduralBase = base;
      this.#applyProceduralEditsToGeometry();
      // Colliders and architecture terrain-follow listen for a committed surface;
      // a sliced fill landing is exactly that.
      this.#paintProceduralGround();
      this.#announceSurfaceChange("committed");
      this.#rebuildStone();
      freeze.bootMark("terrain: procedural fill", performance.now() - fillStart, `${slices} slice(s)`);
    };
    const engine = this.entity?.engine;
    const onPreRender = typeof engine?.onPreRender === "function" ? engine.onPreRender.bind(engine) : null;
    if (!onPreRender) {
      finish(this.#fillProceduralBaseSync());
      return;
    }
    const resolution = this._gridResolution;
    const target = new Float32Array((resolution + 1) ** 2);
    const clock = { deadline: 0, due() { return performance.now() >= this.deadline; } };
    const generator = this.#createProceduralGenerator(clock, target);
    let unsubscribe;
    const step = () => {
      if (generation !== this._proceduralGeneration) { unsubscribe?.(); return; }
      slices++;
      // Widens past the old fixed 6 ms while a boot frame is long (the GPU
      // compiling shaders, not the CPU) and stays at that floor once frames
      // are fast again — see `frameSliceBudget`.
      clock.deadline = performance.now() + frameSliceBudget(engine);
      const result = generator.next();
      if (result.done) { unsubscribe?.(); this._proceduralUnsub = null; finish(result.value); }
    };
    unsubscribe = onPreRender(step);
    this._proceduralUnsub = unsubscribe;
    step(); // make progress now rather than waiting for the next render tick
  }

  /** `heightsArray = base + edits`, then the ordinary O(terrain) full apply —
   *  shared by a completed #scheduleProceduralFill and a `heightEdits` write. */
  #applyProceduralEditsToGeometry() {
    const base = this._proceduralBase ?? new Float32Array((this._gridResolution + 1) ** 2);
    const edits = this._heightEditsArray ?? new Float32Array(base.length);
    if (!this.heightsArray || this.heightsArray.length !== base.length) this.heightsArray = new Float32Array(base.length);
    for (let i = 0; i < base.length; i++) this.heightsArray[i] = base[i] + edits[i];
    this.#applyHeightsToGeometry();
  }

  /**
   * An owner (World) lends this terrain the reshaping its own banks/road
   * corridors/building pads/ridges/escarpments apply on top of whatever bare
   * landform this component grows from its own Procedural params —
   * `landscapeFields.js`'s `createShapeOverlay` builds the descriptor.
   * `evaluate(x, z, baseHeight) -> height` is the fallback per-vertex path;
   * `samples`, when sized for this exact grid, is used verbatim instead (see
   * `fillHeightfield`) — the path every World-owned terrain actually takes.
   * A changed `key` (the owner's own invalidation signal — World uses its
   * `fieldKey`) regenerates; the same key is assumed unchanged even when
   * `samples` is a fresh array instance, so a look-only regeneration whose
   * fields are numerically identical does not repeat the walk/copy.
   */
  /**
   * The Stone control (09-14): rock structures sited from this terrain's own
   * landscape — cliff walls on risers, spires around towers, arches, ledges,
   * talus — seated on the CURRENT surface (edits included). Rebuilt after a
   * procedural fill; World-owned terrains set `stoneLayer: false` because
   * the World builds stone against its own banks, roads and pads.
   */
  #rebuildStone() {
    this._stoneGeneration = (this._stoneGeneration ?? 0) + 1;
    this._stoneUnsub?.();
    this._stoneUnsub = null;
    if (!this.props.procedural || this.props.stoneLayer === false || !(this.props.rocks > 0) || !this.entity?.object3D || !this.heightsArray) {
      this._stone?.dispose();
      this._stone = null;
      return;
    }
    const generation = this._stoneGeneration;
    const options = landscapeOptionsFromProps(this.props);
    const size = this.props.size ?? 50;
    const [ox, oz] = this.props.proceduralOrigin ?? [0, 0];
    // The previous stone stays on screen until the new set is ready.
    const groundAt = (x, z) => this.heightAtLocal(x - ox, z - oz);
    const finish = ({ library, kinds, placements = null }) => {
      if (generation !== this._stoneGeneration || !this.entity?.object3D) return;
      const start = performance.now();
      const stone = createTerrainStone({
        landscape: getLandscape(options), x0: ox - size / 2, z0: oz - size / 2, size, library, kinds, placements, groundAt,
      });
      this._stone?.dispose();
      // Placements are landscape metres; the group maps them into this entity.
      stone.group.position.set(-ox, 0, -oz);
      stone.group.visible = this.enabled;
      this.entity.object3D.add(stone.group);
      this._stone = stone;
      freeze.bootMark("terrain: stone place", performance.now() - start, `${stone.placements.length} rocks`);
    };
    const engine = this.entity.engine;
    const onPreRender = typeof engine?.onPreRender === "function" ? engine.onPreRender.bind(engine) : null;
    if (!onPreRender) { finish(rockLibraryFor(getLandscape(options))); return; }
    // ⛔ 09-14 live: meshing the library synchronously on attach blocked the
    // editor ~2 s per style (and the page dropped right after). Slice it.
    const clock = { deadline: 0, due() { return performance.now() >= this.deadline; } };
    // Placement is ~0.4 s over a 512 m terrain. `placeRocks` partitions exactly
    // by half-open rectangle (tests/landscape-generator.test.mjs), so a 4x4
    // split placed one cell per slice is the same set as one pass.
    const steps = (function* () {
      const landscape = getLandscape(options);
      const { library, kinds } = yield* rockLibraryStepsFor(landscape, 3, clock);
      const placements = [], cells = 4, cell = size / cells, x0 = ox - size / 2, z0 = oz - size / 2;
      for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) {
        const cx0 = x0 + i * cell, cz0 = z0 + j * cell;
        // Rectangle edges come from the same expression on both sides of a
        // cell border, so no anchor is lost or counted twice between cells.
        placements.push(...placeRocks(landscape, { x0: cx0, z0: cz0, size: x0 + (i + 1) * cell - cx0, variants: kinds, groundAt }));
        yield "rocks";
      }
      return { library, kinds, placements };
    })();
    let unsubscribe;
    const step = () => {
      if (generation !== this._stoneGeneration) { unsubscribe?.(); return; }
      clock.deadline = performance.now() + frameSliceBudget(engine);
      const result = steps.next();
      if (result.done) { unsubscribe?.(); this._stoneUnsub = null; finish(result.value); }
    };
    unsubscribe = onPreRender(step);
    this._stoneUnsub = unsubscribe;
  }

  /**
   * Style-coloured ground for a standalone procedural terrain (see
   * terrainGround.js). An owner that lends a shape overlay (World) paints and
   * owns its own ground material, so this steps aside for it; an owner's
   * material set later simply replaces this one.
   */
  #paintProceduralGround() {
    if (!this.props.procedural || this._shapeOverlay || !this.geometry || !this.heightsArray) return;
    if (this._proceduralMaterial && this._proceduralMaterial.owner !== this) return;
    const landscapeStyle = getLandscape(landscapeOptionsFromProps(this.props));
    const colors = paintLandscapeGround(this.heightsArray, { resolution: this._gridResolution, size: this.props.size ?? 50, palette: resolveGroundPalette(landscapeStyle.palette, this.props) });
    this.geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    if (!this._groundMaterial) {
      this._groundMaterial = createLandscapeGroundMaterial();
      this.setProceduralMaterial(this, this._groundMaterial);
    }
  }

  setShapeOverlay(owner, { key = null, evaluate = null, samples = null } = {}) {
    if (!owner) throw new TypeError("Terrain shape overlay requires an owner");
    const changed = this._shapeOverlay?.key !== key;
    this._shapeOverlay = { owner, key, evaluate, samples };
    if (this.props.procedural && changed) this.#scheduleProceduralFill();
  }
  clearShapeOverlay(owner) {
    if (this._shapeOverlay?.owner !== owner) return;
    this._shapeOverlay = null;
    if (this.props.procedural) this.#scheduleProceduralFill();
  }

  /**
   * The full, from-scratch apply — load, undo/redo, a resolution change.
   * O(terrain): every vertex, `computeVertexNormals()` over every triangle, the
   * bounding sphere, every scatter layer. A brush dab must NOT come through
   * here (it did, dozens of times a second, and a 512 grid is ~525k triangles
   * per dab — "terrain sculpting is freezing"); dabs take #applyHeightsRect
   * and this tail runs once per stroke from commitHeights().
   */
  #applyHeightsToGeometry() {
    const pos = this.geometry.getAttribute("position");
    const n = Math.min(pos.count, this.heightsArray.length);
    for (let i = 0; i < n; i++) pos.setY(i, this.heightsArray[i]);
    // This is a whole-buffer upload: an empty range list means "everything",
    // and ranges left by dabs that never reached a frame would otherwise turn
    // it into a partial one.
    pos.clearUpdateRanges();
    this.geometry.getAttribute("normal")?.clearUpdateRanges();
    pos.needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.#finishHeightsGeometry();
  }

  /** The O(terrain) tail shared by a full apply and a stroke commit. */
  #finishHeightsGeometry() {
    this.geometry.boundingBox = null;
    this.geometry.computeBoundingSphere();
    const span = freeze.begin("terrain:scatter");
    try {
      for (let i = 0; i < (this.scatterLayersData?.length ?? 0); i++) this.#refreshScatterLayer(i);
    } finally {
      freeze.end(span);
    }
  }

  /**
   * The per-dab path: writes `heightsArray` into the geometry for grid rows
   * rMin..rMax × columns cMin..cMax only, recomputes the normals of that
   * rectangle plus the one-vertex ring whose normals read into it (exactly —
   * see heightfieldNormals), grows the bounding sphere to cover the moved
   * vertices, and marks just the touched rows for upload. O(brush area).
   * Everything that is O(terrain) — the exact bounding sphere, the scatter
   * layers' re-seat — waits for commitHeights().
   *
   * The upload ranges are honoured by both backends: WebGPU
   * (WebGPUAttributeUtils.updateAttribute — one `queue.writeBuffer` per range,
   * then `clearUpdateRanges()`) and WebGL (`bufferSubData` per range). A row is
   * contiguous in the attribute, so the range is whole rows: one range per
   * attribute per dab rather than one per row.
   */
  #applyHeightsRect(rMin, rMax, cMin, cMax) {
    const res = this._gridResolution;
    const cols = res + 1;
    rMin = Math.max(0, rMin);
    rMax = Math.min(res, rMax);
    cMin = Math.max(0, cMin);
    cMax = Math.min(res, cMax);
    if (rMin > rMax || cMin > cMax) return;
    const size = this.props.size ?? 50;
    const half = size / 2;
    const step = size / res;
    const heights = this.heightsArray;
    const pos = this.geometry.getAttribute("position");
    const nrm = this.geometry.getAttribute("normal");
    const posArr = pos.array;
    // Mid-stroke the sphere only ever grows (a tall peak at the edge must not
    // frustum-cull the whole terrain); the commit recomputes it exactly.
    const sphere = this.geometry.boundingSphere;
    const sx = sphere?.center.x ?? 0, sy = sphere?.center.y ?? 0, sz = sphere?.center.z ?? 0;
    let r2 = sphere ? sphere.radius * sphere.radius : 0;
    for (let r = rMin; r <= rMax; r++) {
      const z = -half + r * step;
      for (let c = cMin; c <= cMax; c++) {
        const i = r * cols + c;
        const y = heights[i];
        posArr[i * 3 + 1] = y;
        const x = -half + c * step;
        const d2 = (x - sx) ** 2 + (y - sy) ** 2 + (z - sz) ** 2;
        if (d2 > r2) r2 = d2;
      }
    }
    if (sphere) sphere.radius = Math.sqrt(r2);
    const nr0 = Math.max(0, rMin - 1), nr1 = Math.min(res, rMax + 1);
    const nc0 = Math.max(0, cMin - 1), nc1 = Math.min(res, cMax + 1);
    heightfieldNormals(heights, res, step, nrm.array, nr0, nr1, nc0, nc1);
    pos.addUpdateRange(rMin * cols * 3, (rMax - rMin + 1) * cols * 3);
    pos.needsUpdate = true;
    nrm.addUpdateRange(nr0 * cols * 3, (nr1 - nr0 + 1) * cols * 3);
    nrm.needsUpdate = true;
    this.geometry.boundingBox = null;
    const rect = { rMin, rMax, cMin, cMax };
    const previous = this._surfaceDirtyRect;
    this._surfaceDirtyRect = previous ? { rMin: Math.min(previous.rMin, rMin), rMax: Math.max(previous.rMax, rMax), cMin: Math.min(previous.cMin, cMin), cMax: Math.max(previous.cMax, cMax) } : rect;
    this.#announceSurfaceChange("preview", rect);
  }

  /**
   * End of a sculpt stroke: finishes the O(terrain) work the dabs deferred —
   * a full pass over positions and normals (the same analytic normals the dabs
   * wrote, over the whole grid, so the end state is exactly what a from-scratch
   * apply gives), the exact bounding sphere, every scatter layer's re-seat —
   * then encodes the live heights buffer back into a prop. Once per stroke,
   * never per dab.
   *
   * Non-procedural (the ordinary sculptable heightfield): re-encodes the whole
   * buffer into `props.heights`, exactly as always. Procedural: the buffer is
   * `base + edits`, and only the DELTA against this terrain's own generated
   * base goes into `props.heightEdits` — `heights` is never touched, so it
   * cannot fight the next `landform`/`roughness`/... change.
   *
   * The editor follows this with SetTerrainHeightsCommand against whichever
   * prop this wrote (`do()` is `setProp(key, <this same string>)`);
   * onPropChanged recognises the string this commit produced and skips the
   * decode and a second full pass. Undo/redo carry a different string and
   * take the full path.
   */
  commitHeights() {
    const span = freeze.begin("terrain:stroke-commit");
    try {
      if (this.geometry) {
        const res = this._gridResolution;
        const pos = this.geometry.getAttribute("position");
        const nrm = this.geometry.getAttribute("normal");
        const n = Math.min(pos.count, this.heightsArray.length);
        for (let i = 0; i < n; i++) pos.setY(i, this.heightsArray[i]);
        heightfieldNormals(this.heightsArray, res, (this.props.size ?? 50) / res, nrm.array);
        pos.clearUpdateRanges();
        pos.needsUpdate = true;
        nrm.clearUpdateRanges();
        nrm.needsUpdate = true;
        this.#finishHeightsGeometry();
      }
      if (this.props.procedural) {
        const base = this._proceduralBase ?? new Float32Array(this.heightsArray.length);
        const edits = new Float32Array(this.heightsArray.length);
        for (let i = 0; i < edits.length; i++) edits[i] = this.heightsArray[i] - (base[i] ?? 0);
        this._heightEditsArray = edits;
        this.props.heightEdits = encodeFloat32(edits);
        this._committedHeightEdits = this.props.heightEdits;
      } else {
        this.props.heights = encodeFloat32(this.heightsArray);
        this._committedHeights = this.props.heights;
      }
      this.#announceSurfaceChange("committed", this._surfaceDirtyRect ?? null);
      this._surfaceDirtyRect = null;
    } finally {
      freeze.end(span);
    }
  }

  /** Dedicated light notification: live dabs must not wake every generic
   * geometry consumer, recook physics or rebuild GI and foliage. */
  #announceSurfaceChange(phase, rect = null) {
    this._surfaceRevision = (this._surfaceRevision ?? 0) + 1;
    this.entity.engine?.emit?.("terrain-surface-changed", { entityId: this.entity.id, component: this, phase, rect, revision: this._surfaceRevision });
  }

  /**
   * Bilinear-sampled height at a local-space (x, z) — used by the editor's
   * brush indicator to hug the live surface (including mid-stroke changes,
   * before a commit re-encodes props.heights). Clamps outside the grid to the
   * nearest edge rather than extrapolating.
   */
  heightAtLocal(x, z) {
    const half = (this.props.size ?? 50) / 2;
    const cols = this._gridResolution + 1;
    const fc = THREE.MathUtils.clamp(((x + half) / (half * 2)) * this._gridResolution, 0, this._gridResolution);
    const fr = THREE.MathUtils.clamp(((z + half) / (half * 2)) * this._gridResolution, 0, this._gridResolution);
    const c0 = Math.floor(fc), r0 = Math.floor(fr);
    const c1 = Math.min(c0 + 1, this._gridResolution), r1 = Math.min(r0 + 1, this._gridResolution);
    const tc = fc - c0, tr = fr - r0;
    const h00 = this.heightsArray[r0 * cols + c0];
    const h10 = this.heightsArray[r0 * cols + c1];
    const h01 = this.heightsArray[r1 * cols + c0];
    const h11 = this.heightsArray[r1 * cols + c1];
    return THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(h00, h10, tc),
      THREE.MathUtils.lerp(h01, h11, tc),
      tr,
    );
  }

  /** Surface normal sampled from the live heightfield in entity-local space. */
  normalAtLocal(x, z) {
    const step = (this.props.size ?? 50) / this._gridResolution;
    const dx = this.heightAtLocal(x + step, z) - this.heightAtLocal(x - step, z);
    const dz = this.heightAtLocal(x, z + step) - this.heightAtLocal(x, z - step);
    return new THREE.Vector3(-dx, step * 2, -dz).normalize();
  }

  /** Predicted post-stroke height, used by the editor's outcome silhouette. */
  previewHeightAtLocal(x, z, center, opts) {
    const current = this.heightAtLocal(x, z);
    const { tool, radius, strength, hardness = 0.5, flattenHeight = center.y, seed = 0 } = opts;
    const dist = Math.hypot(x - center.x, z - center.z);
    if (dist > radius) return current;
    const exp = THREE.MathUtils.lerp(0.4, 4, hardness);
    const amount = strength * Math.pow(1 - dist / radius, exp);
    const step = (this.props.size ?? 50) / this._gridResolution;
    const neighbor = () => {
      let sum = 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        sum += this.heightAtLocal(x + dx * step, z + dz * step);
      }
      return sum / 9;
    };
    switch (tool) {
      case "raise": return current + amount;
      case "lower": return current - amount;
      case "flatten": return current + (flattenHeight - current) * Math.min(1, amount);
      case "smooth": return current + (neighbor() - current) * Math.min(1, amount);
      case "sharpen": return current + (current - neighbor()) * amount;
      case "erode": {
        let mn = current;
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          mn = Math.min(mn, this.heightAtLocal(x + dx * step, z + dz * step));
        }
        return current + (mn - current) * Math.min(1, amount);
      }
      case "noise": return current + (valueNoise(x * 0.5, z * 0.5, seed) * 2 - 1) * amount;
      default: return current;
    }
  }

  // ---------------------------------------------------------------------------
  // Splatmap
  // ---------------------------------------------------------------------------

  #buildSplatmap() {
    const resolution = (this._splatResolution = Math.max(2, Math.floor(this.props.splatResolution ?? 256)));
    const decoded = decodeUint8(this.props.splatmap, resolution * resolution * 4);
    this.splatData = decoded ?? makeDefaultSplat(resolution);
    this.splatTexture = new THREE.DataTexture(this.splatData, resolution, resolution, THREE.RGBAFormat);
    this.splatTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.splatTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.splatTexture.flipY = false;
    this.splatTexture.needsUpdate = true;
  }

  /** Encode the live splat buffer back into `props` (call once per stroke). */
  commitSplatmap() {
    this.props.splatmap = encodeUint8(this.splatData);
  }

  fillSplatLayer(layerIndex) {
    const layer = THREE.MathUtils.clamp(layerIndex | 0, 0, 3);
    for (let i = 0; i < this.splatData.length; i += 4) {
      for (let ch = 0; ch < 4; ch++) this.splatData[i + ch] = ch === layer ? 255 : 0;
    }
    this.splatTexture.needsUpdate = true;
  }

  clearSplatLayer(layerIndex) {
    const layer = THREE.MathUtils.clamp(layerIndex | 0, 0, 3);
    for (let i = layer; i < this.splatData.length; i += 4) this.splatData[i] = 0;
    this.splatTexture.needsUpdate = true;
  }
  // ---------------------------------------------------------------------------
  // Material — per-layer PBR surfaces blended by the splatmap
  // ---------------------------------------------------------------------------

  #buildMaterial() {
    this.material = new THREE.MeshStandardNodeMaterial({
      color: 0x8a8f7a,
      roughness: 0.95,
      metalness: 0,
    });
    // Per-layer loaded maps: this.layerMaps[i] = { albedo, normal, roughness }.
    this.layerMaps = [];
    this.layerMaterials = [];
    // Compiled shader-graph mutations per layer / for the base .mat.
    this.layerGraphs = [];
    this.baseGraph = null;
    this.layerMaterialUnsubs = [];
    this.baseMaterial = null;
    this.baseMaterialUnsub = null;
    this.#wireMaterialNodes();
  }

  /**
   * Weighted-average splat blend of every layer, per PBR channel — so rock,
   * grass, sand etc. differ in roughness and surface normal, not just color:
   *
   *   color     = Σ(albedoᵢ·tintᵢ · wᵢ) / Σwᵢ
   *   roughness = Σ(roughnessᵢ         · wᵢ) / Σwᵢ
   *   metalness = Σ(metalnessᵢ         · wᵢ) / Σwᵢ
   *   ao        = Σ(aoᵢ                · wᵢ) / Σwᵢ     [if any AO maps]
   *   normal    = normalize( Σ(normalᵢ · wᵢ) / Σwᵢ )   [if any normal maps]
   *
   * Every existing layer contributes (its scalar tint/roughness apply even
   * without maps), so an untextured layer is a valid flat-colored surface and
   * layer 0 is paintable. With no layers, all channel nodes are cleared and
   * the material falls back to its scalar base color.
   *
   * A layer backed by a .mat contributes its whole compiled graph, not just a
   * diffuse map — `this.layerGraphs[i]` holds the mutations, recompiled against
   * the layer's tiled UV (see `compileMaterialGraph`).
   *
   * Normal blend note: contributions are blended as *decoded* normals (the
   * space `material.normalNode` expects). A .mat's `normalNode` is already
   * decoded — it comes out of a Normal Map node — so only the legacy raw
   * `maps.normal` texel path needs `normalMap()` applied to it here. Blending
   * the two in encoded 0..1 texel space and decoding once at the end (what this
   * used to do) double-decodes the .mat contribution and yields wrong lighting.
   */
  #wireMaterialNodes() {
    const layers = (this.props.layers ?? []).slice(0, MAX_TERRAIN_LAYERS);
    const splat = tslTexture(this.splatTexture, uv());
    const rawWeights = [splat.r, splat.g, splat.b, splat.a];
    const weights = rawWeights.map((weight, index) => weight.mul(layers[index]?.opacity ?? 1));

    let paintedWeight = null;
    for (let i = 0; i < layers.length; i++) {
      if (layers[i]?.visible === false) continue;
      paintedWeight = paintedWeight ? paintedWeight.add(weights[i]) : weights[i];
    }
    const baseWeight = paintedWeight ? float(1).sub(paintedWeight).max(float(0)) : float(1);
    // A provider supplies a borrowed procedural base; authored Mesh materials
    // still win, and the ordinary Terrain paint layers blend over either base.
    const procedural = !this.meshComponent?.props.material ? this._proceduralMaterial?.material : null;
    const baseAsset = procedural ?? this.baseMaterial;
    const baseGraph = procedural ?? this.baseGraph ?? {};
    this.material.vertexColors = !!procedural?.vertexColors;
    const baseColorValue = baseAsset?.color ?? new THREE.Color(0x8a8f7a);
    // A graph's `color` slot is fed from a Principled BSDF `color` input, which
    // is wired straight from a texture's `out` socket — a vec4. Everything else
    // blended here is vec3, and summing the two mixes an alpha channel into the
    // color and yields a near-black surface. Truncate to rgb up front.
    const baseColor = baseGraph.colorNode
      ? vec3(baseGraph.colorNode)
      : (baseAsset?.map ? tslTexture(baseAsset.map, uv()).rgb : vec3(baseColorValue.r, baseColorValue.g, baseColorValue.b));
    const baseRough = baseGraph.roughnessNode ?? float(baseAsset?.roughness ?? 0.95);
    const baseMetal = baseGraph.metalnessNode ?? float(baseAsset?.metalness ?? 0);

    let colorNum = baseColor.mul(baseWeight);
    let roughNum = baseRough.mul(baseWeight);
    let metalNum = baseMetal.mul(baseWeight);
    let aoNum = (baseGraph.aoNode ?? float(1)).mul(baseWeight);
    // Layers with no normal map still contribute — as the geometric normal, so
    // painting a flat layer over a bumpy one correctly flattens it.
    let normalNum = (baseGraph.normalNode ?? normalView).mul(baseWeight);
    let denom = baseWeight;
    let hasNormal = !!baseGraph.normalNode;
    let hasAo = !!baseGraph.aoNode;

    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i] ?? {};
      if (layer.visible === false) continue;
      const maps = this.layerMaps[i] ?? {};
      const asset = this.layerMaterials[i] ?? null;
      const graph = this.layerGraphs?.[i] ?? {};
      const w = weights[i];
      const layerUv = uv().mul(layer.tiling ?? 20);
      const tint = new THREE.Color(layer.tint ?? "#ffffff");
      const tintNode = vec3(tint.r, tint.g, tint.b);
      const assetColor = asset?.color ? vec3(asset.color.r, asset.color.g, asset.color.b) : null;
      const color = (graph.colorNode
        ? vec3(graph.colorNode)
        : (asset?.map ? tslTexture(asset.map, layerUv).rgb : null)
          ?? assetColor
          ?? (maps.albedo ? tslTexture(maps.albedo, layerUv).rgb : null)
          ?? vec3(1, 1, 1)
      ).mul(tintNode);
      const rough = graph.roughnessNode
        ?? (maps.roughness ? tslTexture(maps.roughness, layerUv).r.mul(layer.roughness ?? 1) : float(asset?.roughness ?? layer.roughness ?? 0.95));
      const metal = graph.metalnessNode ?? float(asset?.metalness ?? layer.metalness ?? 0);
      const ao = graph.aoNode ?? float(1);
      // A .mat's normalNode is already decoded; a legacy raw texel map is not.
      const normal = graph.normalNode
        ?? (maps.normal ? normalMap(tslTexture(maps.normal, layerUv)) : null);
      if (normal) hasNormal = true;
      if (graph.aoNode) hasAo = true;

      colorNum = colorNum.add(color.mul(w));
      roughNum = roughNum.add(rough.mul(w));
      metalNum = metalNum.add(metal.mul(w));
      aoNum = aoNum.add(ao.mul(w));
      normalNum = normalNum.add((normal ?? normalView).mul(w));
      denom = denom.add(w);
    }

    const inv = denom.max(float(1e-4));
    this.material.colorNode = colorNum.div(inv);
    this.material.roughnessNode = roughNum.div(inv);
    this.material.metalnessNode = metalNum.div(inv);
    this.material.aoNode = hasAo ? aoNum.div(inv) : null;
    // Already-decoded normals: blend and renormalize, do NOT decode again.
    this.material.normalNode = hasNormal ? normalNum.div(inv).normalize() : null;
    this.material.needsUpdate = true;
  }
  #applyTerrainMesh() {
    if (!this.meshComponent?.mesh || !this.geometry || !this.material) return;
    this.mesh = this.meshComponent.mesh;
    this.mesh.geometry = this.geometry;
    this.mesh.material = this.material;
  }

  /** Borrow a generated base without taking ownership of its textures/nodes. */
  setProceduralMaterial(owner, material) {
    if (!owner || !material?.isMaterial) throw new TypeError('Terrain procedural material requires an owner and material');
    this._proceduralMaterial = { owner, material };
    if (this.material) { this.#wireMaterialNodes(); this.#applyTerrainMesh(); }
  }
  clearProceduralMaterial(owner) {
    if (this._proceduralMaterial?.owner !== owner) return;
    this._proceduralMaterial = null;
    if (this.material) { this.#wireMaterialNodes(); this.#applyTerrainMesh(); }
  }

  async #loadBaseMaterial() {
    const path = this.meshComponent?.props.material;
    const generation = (this.baseMaterialGeneration = (this.baseMaterialGeneration ?? 0) + 1);
    this.baseMaterialUnsub?.();
    this.baseMaterialUnsub = null;
    if (!path) {
      this.baseMaterial = null;
      this.baseGraph = null;
      this.#wireMaterialNodes();
      return;
    }
    await loadMaterialAsset(path);
    // The .mat's `*Node` slots are populated by an async graph compile, so the
    // instance alone is not enough — compile the graph ourselves and blend the
    // resulting mutations (the base layer samples at the raw UV).
    const graph = await compileMaterialGraph(path).catch((err) => {
      console.error(`Terrain base material "${path}": ${err.message}`);
      return null;
    });
    if (generation !== this.baseMaterialGeneration || !this.mesh) return;
    this.baseMaterial = getMaterialInstance(path);
    this.baseGraph = graph;
    this.baseMaterialUnsub = subscribeMaterial(path, () => this.#loadBaseMaterial());
    this.#wireMaterialNodes();
    this.#applyTerrainMesh();
  }

  #disposeBaseMaterial() {
    this.baseMaterialGeneration = (this.baseMaterialGeneration ?? 0) + 1;
    this.baseMaterialUnsub?.();
    this.baseMaterialUnsub = null;
    this.baseMaterial = null;
    this.baseGraph = null;
  }
  /** Load one texture (or null) with the right color space + wrapping. */
  async #loadMap(path, { srgb }) {
    if (!path) return null;
    try {
      return await loadTextureAsset(path, {
        colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace,
      });
    } catch (err) {
      console.error(`Terrain layer map "${path}": ${err.message}`);
      return null;
    }
  }

  async #loadLayerMaps() {
    const generation = (this.generation = (this.generation ?? 0) + 1);
    const layers = (this.props.layers ?? []).slice(0, MAX_TERRAIN_LAYERS);
    const loaded = await Promise.all(layers.map(async (layer) => ({
      material: layer?.material ? await loadMaterialAsset(layer.material) : null,
      // The .mat's graph is recompiled here against this layer's tiled UV.
      // Reading the shared instance's `*Node` slots instead would bake in the
      // graph's own uv() and silently ignore `tiling`.
      graph: layer?.material
        ? await compileMaterialGraph(layer.material, { uvNode: uv().mul(layer.tiling ?? 20) }).catch((err) => {
            console.error(`Terrain layer material "${layer.material}": ${err.message}`);
            return null;
          })
        : null,
      // Back-compat for old scenes; new layers use only material.
      albedo: await this.#loadMap(layer?.material ? "" : (layer?.albedo ?? layer?.texture), { srgb: true }),
      normal: await this.#loadMap(layer?.material ? "" : layer?.normalMap, { srgb: false }),
      roughness: await this.#loadMap(layer?.material ? "" : layer?.roughnessMap, { srgb: false }),
    })));
    if (generation !== this.generation || !this.mesh) return;
    this.#disposeLayerMaps();
    this.#disposeLayerMaterials();
    this.layerMaps = loaded.map(({ albedo, normal, roughness }) => ({ albedo, normal, roughness }));
    this.layerMaterials = loaded.map(({ material }) => material);
    this.layerGraphs = loaded.map(({ graph }) => graph);
    this.layerMaterialUnsubs = layers.map((layer) => layer?.material
      ? subscribeMaterial(layer.material, () => this.#loadLayerMaps())
      : null);
    this.#wireMaterialNodes();
  }

  #disposeLayerMaterials() {
    for (const unsubscribe of this.layerMaterialUnsubs ?? []) unsubscribe?.();
    this.layerMaterialUnsubs = [];
    this.layerMaterials = [];
    this.layerGraphs = [];
  }
  #disposeLayerMaps() {
    for (const maps of this.layerMaps ?? []) {
      maps?.albedo?.dispose?.();
      maps?.normal?.dispose?.();
      maps?.roughness?.dispose?.();
    }
    this.layerMaps = [];
  }

  // ---------------------------------------------------------------------------
  // Model scatter layers
  // ---------------------------------------------------------------------------

  /** Takes ownership of the layer data coming out of props: a deep copy (we
   *  mutate it as the user paints) with legacy instances upgraded in place. */
  #adoptScatterLayers(layers) {
    const next = JSON.parse(JSON.stringify(layers ?? []));
    for (const layer of next) migrateScatterInstances(layer);
    return next;
  }

  /** Removes every instance of a layer, keeping the layer and its settings. */
  clearScatterLayer(layerIndex) {
    const layer = this.scatterLayersData?.[layerIndex];
    if (!layer) return 0;
    const removed = layer.instances?.length ?? 0;
    layer.instances = [];
    this.#refreshScatterLayer(layerIndex);
    return removed;
  }

  #scatterSourceReadinessChanged() {
    return (this.scatterLayersData ?? []).some((layer, index) => {
      if (layer.sourceType !== "entity") return false;
      const source = this.entity.engine.getEntity(layer.sourceEntity);
      const hasRenderableSource = !!(source?.getComponent("mesh")?.mesh || source?.getComponent("model")?.root);
      const hasLoadedScatterSource = !!this.scatterSources?.[index]?.length;
      return hasRenderableSource !== hasLoadedScatterSource;
    });
  }

  async #loadScatterLayers() {
    if (!this.scatterRoot) return;
    this.#disposeScatterLayers();
    const generation = (this.scatterGeneration = (this.scatterGeneration ?? 0) + 1);
    this.scatterSources = (this.scatterLayersData ?? []).map(() => []);
    this.scatterSourceKeys = (this.scatterLayersData ?? []).map((layer) => layer.sourceType === "entity"
      ? `entity:${layer.sourceEntity ?? ""}`
      : `asset:${layer.model ?? ""}`);
    await Promise.all((this.scatterLayersData ?? []).map(async (layer, layerIndex) => {
      try {
        let root = null;
        let sourceOwner = null;
        let owned = false;
        if (layer?.sourceType === "entity") {
          sourceOwner = this.entity.engine.getEntity(layer.sourceEntity);
          if (!sourceOwner) return;
          sourceOwner.object3D.updateWorldMatrix(true, true);
        } else {
          if (!layer?.model) return;
          const url = await resolveAssetUrl(layer.model);
          const gltf = await scatterLoader.loadAsync(url);
          root = gltf.scene;
          owned = true;
        }
        if (generation !== this.scatterGeneration || !this.scatterRoot) return;
        const objects = [];
        if (sourceOwner) {
          const mesh = sourceOwner.getComponent("mesh")?.mesh;
          const modelRoot = sourceOwner.getComponent("model")?.root;
          if (mesh) objects.push(mesh);
          modelRoot?.traverse((object) => object.isMesh && objects.push(object));
        } else {
          root.updateMatrixWorld(true);
          root.traverse((object) => object.isMesh && objects.push(object));
        }
        const ownerInverse = sourceOwner?.object3D.matrixWorld.clone().invert();
        const sources = [];
        for (const object of objects) {
          if (!object.isMesh || !object.geometry || !object.material) continue;
          sources.push({
            geometry: object.geometry,
            material: object.material,
            // The live source mesh for entity-backed layers. Its geometry and
            // material can still be swapped after this point (async .mat /
            // geometry-asset resolution), so `#refreshScatterLayer` re-reads
            // them from here rather than trusting the snapshot above. Asset
            // (GLB) layers own their objects outright and have nothing to track.
            object: owned ? null : object,
            sourceMatrix: ownerInverse
              ? ownerInverse.clone().multiply(object.matrixWorld)
              : object.matrixWorld.clone(),
            mesh: null,
            owned,
            animated: !!(object.isSkinnedMesh || sourceOwner?.getComponent("animation")),
          });
        }
        this.scatterSources[layerIndex] = sources;
        this.#refreshScatterLayer(layerIndex);
      } catch (err) {
        console.error(`Terrain scatter source "${layer.model || layer.sourceEntity}": ${err.message}`);
      }
    }));
  }

  #disposeScatterLayers() {
    this.scatterGeneration = (this.scatterGeneration ?? 0) + 1;
    for (const sources of this.scatterSources ?? []) {
      const geometries = new Set();
      const materials = new Set();
      for (const source of sources ?? []) {
        if (source.mesh?.parent) source.mesh.parent.remove(source.mesh);
        if (source.owned && source.geometry) geometries.add(source.geometry);
        const mats = Array.isArray(source.material) ? source.material : [source.material];
        for (const mat of mats) if (source.owned && mat) materials.add(mat);
      }
      for (const geometry of geometries) geometry.dispose?.();
      for (const material of materials) material.dispose?.();
    }
    this.scatterSources = [];
    this.scatterRoot?.clear();
  }

  /**
   * The rotation a "source"-aligned layer copies: the source entity's own
   * orientation, expressed in the terrain's local space (so a rotated terrain
   * doesn't double-rotate its scatter). Asset-backed layers have no source
   * entity — their orientation is already baked into `source.sourceMatrix`, so
   * identity is the right answer there.
   */
  #alignSourceQuat(layer, out) {
    out.identity();
    if (layer.sourceType !== "entity") return out;
    const owner = this.entity.engine.getEntity(layer.sourceEntity);
    if (!owner) return out;
    owner.object3D.updateWorldMatrix(true, false);
    this.entity.object3D.updateWorldMatrix(true, false);
    const terrainQuat = _q2.setFromRotationMatrix(this.entity.object3D.matrixWorld).invert();
    const sourceQuat = _q3.setFromRotationMatrix(owner.object3D.matrixWorld);
    return out.copy(terrainQuat).multiply(sourceQuat);
  }

  /**
   * Resolves one instance's placement matrix from the layer's settings and the
   * instance's stored random draws. This is the single definition of what a
   * scatter instance looks like — the runtime InstancedMesh and the editor's
   * brush silhouette both go through here, so a preview can't drift from what
   * actually gets painted.
   *
   * `lift` nudges the instance up along the terrain normal (the preview uses it
   * to avoid z-fighting with the ground).
   */
  scatterPlacementMatrix(layerIndex, item, out = new THREE.Matrix4(), lift = 0) {
    const layer = this.scatterLayersData?.[layerIndex] ?? {};
    const x = item.position?.[0] ?? 0;
    const z = item.position?.[2] ?? 0;
    const ground = this.heightAtLocal(x, z);

    // Instances painted before placement settings existed baked their transform
    // into the instance. Keep rendering them exactly as they were.
    const r = item.r;
    if (!r) {
      _pos.set(x, ground + (item.heightOffset ?? 0) + lift, z);
      _quat.fromArray(item.quaternion ?? [0, 0, 0, 1]);
      _scale.setScalar(item.scale ?? 1);
      return out.compose(_pos, _quat, _scale);
    }

    const align = layer.align ?? "surface";
    const axis = AXIS_VECTORS[layer.alignAxis ?? "+y"] ?? UP_Y;
    if (align === "source") {
      this.#alignSourceQuat(layer, _quat);
    } else {
      _up.copy(axis);
      if (align === "surface") {
        const blend = THREE.MathUtils.clamp(layer.alignBlend ?? 1, 0, 1);
        _up.lerp(this.normalAtLocal(x, z), blend).normalize();
      }
      _quat.setFromUnitVectors(UP_Y, _up);
    }
    // Yaw spins the model about its *own* up, so it works the same whether the
    // instance is standing on flat ground or lying on a cliff face.
    const yaw = THREE.MathUtils.degToRad(THREE.MathUtils.lerp(layer.yawMin ?? 0, layer.yawMax ?? 360, r[0]));
    if (yaw) _quat.multiply(_q2.setFromAxisAngle(UP_Y, yaw));
    const tilt = THREE.MathUtils.degToRad(layer.tiltJitter ?? 0);
    if (tilt) {
      _euler.set((r[1] * 2 - 1) * tilt, 0, (r[2] * 2 - 1) * tilt);
      _quat.multiply(_q2.setFromEuler(_euler));
    }

    const s = THREE.MathUtils.lerp(layer.scaleMin ?? 0.8, layer.scaleMax ?? 1.2, r[3]);
    const stretch = THREE.MathUtils.lerp(layer.stretchMin ?? 1, layer.stretchMax ?? 1, r[4]);
    _scale.set(s, s * stretch, s);

    const offset = (layer.heightOffset ?? 0) + (r[5] * 2 - 1) * (layer.heightJitter ?? 0);
    _pos.set(x, ground + offset + lift, z);
    return out.compose(_pos, _quat, _scale);
  }

  #refreshScatterLayer(layerIndex) {
    const layer = this.scatterLayersData?.[layerIndex];
    const sources = this.scatterSources?.[layerIndex];
    if (!layer || !sources || !this.scatterRoot) return;
    const instances = layer.instances ?? [];
    const placementMatrix = new THREE.Matrix4();
    const finalMatrix = new THREE.Matrix4();
    for (const source of sources) {
      // An entity-backed source can swap its geometry/material out from under
      // us: MeshComponent resolves its `.mat` (and geometry asset) *after*
      // attach, replacing `mesh.material` with the shared instance. We captured
      // the placeholder. Re-read the live object rather than trusting the
      // snapshot — otherwise the scatter renders with the default white
      // material after every scene load or Play (the material we captured was
      // never the real one).
      if (source.object) {
        if (source.object.geometry && source.object.geometry !== source.geometry) {
          source.geometry = source.object.geometry;
          if (source.mesh?.parent) source.mesh.parent.remove(source.mesh);
          source.mesh = null; // capacity/geometry changed — rebuild below
        }
        if (source.object.material && source.object.material !== source.material) {
          source.material = source.object.material;
          if (source.mesh) source.mesh.material = source.material;
        }
      }

      const needed = Math.max(1, instances.length);
      let mesh = source.mesh;
      if (!mesh || mesh.instanceMatrix.count < needed) {
        if (mesh?.parent) mesh.parent.remove(mesh);
        // Stable capacities (instanceCapacity.js): a small exact one is baked into the WGSL.
        const capacity = stableInstanceCapacity(needed);
        mesh = new THREE.InstancedMesh(source.geometry, source.material, capacity);
        this.scatterRoot.add(mesh);
        source.mesh = mesh;
      }
      mesh.count = instances.length;
      mesh.castShadow = layer.castShadow !== false;
      mesh.receiveShadow = layer.receiveShadow !== false;
      mesh.visible = layer.visible !== false;
      mesh.userData.entityId = this.entity.id;
      for (let i = 0; i < instances.length; i++) {
        this.scatterPlacementMatrix(layerIndex, instances[i], placementMatrix);
        finalMatrix.multiplyMatrices(placementMatrix, source.sourceMatrix);
        mesh.setMatrixAt(i, finalMatrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  /** Re-rolls every instance's random draws (the "Reseed" button). Positions
   *  stay put; rotation/scale/offset variation is drawn afresh. */
  reseedScatterLayer(layerIndex) {
    const layer = this.scatterLayersData?.[layerIndex];
    if (!layer) return;
    for (const item of layer.instances ?? []) {
      item.r = randomDraws(Math.random);
      delete item.quaternion; // legacy bake, if any — the draws replace it
      delete item.scale;
      delete item.heightOffset;
    }
    this.#refreshScatterLayer(layerIndex);
  }

  /** Source geometry for the editor's true-model scatter silhouette. */
  getScatterPreviewSources(layerIndex) {
    return this.scatterSources?.[layerIndex] ?? [];
  }

  getScatterInstances(layerIndex) {
    return this.scatterLayersData?.[layerIndex]?.instances ?? [];
  }

  /**
   * Picks positions for a brush dab. Only the *position* and the random draws
   * are decided here — the actual transform is resolved later from the layer's
   * settings (see `scatterPlacementMatrix`), which is what lets those settings
   * stay editable after painting.
   *
   * A candidate is rejected when it lands outside the terrain, too close to a
   * neighbour (spacing), or outside the layer's slope / altitude window.
   */
  #scatterCandidates(local, opts) {
    const layer = this.scatterLayersData?.[opts.layerIndex] ?? {};
    const spacing = Math.max(0.1, opts.spacing ?? 2);
    const radius = Math.max(0.1, opts.radius ?? 4);
    const density = THREE.MathUtils.clamp(opts.strength ?? 1, 0.01, 1);
    const count = Math.min(64, Math.max(1, Math.ceil(Math.PI * radius * radius / (spacing * spacing) * 0.35 * density)));
    let state = ((opts.seed ?? 0) + 1) >>> 0;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    const existing = opts.existing ?? [];
    const accepted = [];
    const half = (this.props.size ?? 50) / 2;
    const slopeMin = layer.slopeMin ?? 0;
    const slopeMax = layer.slopeMax ?? 90;
    const altitudeMin = layer.altitudeMin ?? -Infinity;
    const altitudeMax = layer.altitudeMax ?? Infinity;

    for (let attempt = 0; attempt < count * 12 && accepted.length < count; attempt++) {
      const angle = random() * Math.PI * 2;
      const radial = Math.sqrt(random()) * radius;
      const jitter = THREE.MathUtils.clamp(opts.jitter ?? 0.75, 0, 1);
      const ring = Math.round(radial / spacing) * spacing;
      const r = THREE.MathUtils.lerp(ring, radial, jitter);
      const x = local.x + Math.cos(angle) * r;
      const z = local.z + Math.sin(angle) * r;
      if (x < -half || x > half || z < -half || z > half) continue;
      const tooClose = [...existing, ...accepted].some((item) => {
        const p = item.position;
        return p && Math.hypot(p[0] - x, p[2] - z) < spacing;
      });
      if (tooClose) continue;

      // Slope filter: grass on the flats, nothing on the cliff — the angle
      // between the surface normal and straight up, in degrees.
      const normal = this.normalAtLocal(x, z);
      const slope = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(normal.y, -1, 1)));
      if (slope < slopeMin || slope > slopeMax) continue;

      const height = this.heightAtLocal(x, z);
      if (height < altitudeMin || height > altitudeMax) continue;

      accepted.push({ position: [x, 0, z], r: randomDraws(random) });
    }
    return accepted;
  }

  getScatterPreviewPlacements(local, opts) {
    const layer = this.scatterLayersData?.[opts.layerIndex];
    if (!layer || opts.erase) return [];
    return this.#scatterCandidates(local, { ...opts, existing: layer.instances ?? [] });
  }

  applyScatterBrush(local, opts) {
    const layer = this.scatterLayersData?.[opts.layerIndex];
    if (!layer) return 0;
    const instances = (layer.instances ??= []);
    const before = instances.length;
    if (opts.erase) {
      const effectiveRadius = Math.max(0.1, opts.radius ?? 4) * THREE.MathUtils.lerp(0.25, 1, opts.strength ?? 1);
      layer.instances = instances.filter((item) => {
        const p = item.position;
        return !p || Math.hypot(p[0] - local.x, p[2] - local.z) > effectiveRadius;
      });
    } else {
      instances.push(...this.#scatterCandidates(local, { ...opts, existing: instances }));
    }
    this.#refreshScatterLayer(opts.layerIndex);
    return Math.abs((layer.instances?.length ?? 0) - before);
  }

  commitScatterLayers() {
    return JSON.stringify(this.scatterLayersData ?? []);
  }

  // ---------------------------------------------------------------------------
  // Sculpt brush (called from the editor's viewport pointer handlers)
  // ---------------------------------------------------------------------------

  /**
   * local: THREE.Vector3 brush center in this entity's local space.
   * opts: { tool, radius, strength, hardness?, flattenHeight?, seed? }
   * Tools: raise, lower, smooth, flatten, sharpen, erode, noise.
   */
  applyHeightBrush(local, opts) {
    if (!this.geometry) return;
    const span = freeze.begin("terrain:brush");
    try {
      this.#sculpt(local, opts);
    } finally {
      freeze.end(span);
    }
  }

  /**
   * Rows `rMin - 1 .. rMax + 1` of the live heights, copied into a reusable
   * scratch buffer sized like `heightsArray`. The neighbour-reading tools
   * read one vertex around the dab's box and nothing further, so that is all
   * a snapshot needs to hold — `heights.slice()` was an O(terrain) 1 MB copy
   * per dab on a 512 grid. The scratch is allocated once per resolution.
   */
  #brushSnapshot(rMin, rMax) {
    const heights = this.heightsArray;
    let scratch = this._brushScratch;
    if (!scratch || scratch.length !== heights.length) scratch = this._brushScratch = new Float32Array(heights.length);
    const cols = this._gridResolution + 1;
    const from = Math.max(0, rMin - 1) * cols;
    const to = Math.min(this._gridResolution, rMax + 1) * cols + cols;
    scratch.set(heights.subarray(from, to), from);
    return scratch;
  }

  #sculpt(local, opts) {
    const { tool, radius, strength, hardness = 0.5, falloff = null, flattenHeight = 0, seed = 0 } = opts;
    const cols = this._gridResolution + 1;
    const heights = this.heightsArray;
    const half = (this.props.size ?? 50) / 2;
    const step = (half * 2) / this._gridResolution;

    // Only touch vertices inside the brush's bounding box.
    const cMin = Math.max(0, Math.floor((local.x - radius + half) / step));
    const cMax = Math.min(this._gridResolution, Math.ceil((local.x + radius + half) / step));
    const rMin = Math.max(0, Math.floor((local.z - radius + half) / step));
    const rMax = Math.min(this._gridResolution, Math.ceil((local.z + radius + half) / step));
    if (rMin > rMax || cMin > cMax) return; // the brush is off the grid

    // Neighbor-reading tools work off a snapshot so one pass isn't biased by
    // its own in-progress writes.
    const needsSnapshot = tool === "smooth" || tool === "sharpen" || tool === "erode" || tool === "pinch" || tool === "contrast";
    const src = needsSnapshot ? this.#brushSnapshot(rMin, rMax) : heights;

    for (let r = rMin; r <= rMax; r++) {
      for (let c = cMin; c <= cMax; c++) {
        const x = -half + c * step;
        const z = -half + r * step;
        const dist = Math.hypot(x - local.x, z - local.z);
        if (dist > radius) continue;
        // Shared with the mesh sculptor: with no named curve this is the
        // hardness exponent terrain has always used, so existing strokes are
        // unchanged, and naming one opts into the same curves Blender offers.
        const amt = strength * brushWeight(dist / radius, { curve: falloff, hardness });
        const idx = r * cols + c;
        switch (tool) {
          case "raise":
            heights[idx] += amt;
            break;
          case "lower":
            heights[idx] -= amt;
            break;
          case "flatten":
            heights[idx] += (flattenHeight - heights[idx]) * Math.min(1, amt);
            break;
          case "smooth": {
            const avg = neighborAvg(src, cols, r, c, this._gridResolution);
            heights[idx] = src[idx] + (avg - src[idx]) * Math.min(1, amt);
            break;
          }
          case "sharpen": {
            const avg = neighborAvg(src, cols, r, c, this._gridResolution);
            heights[idx] = src[idx] + (src[idx] - avg) * amt;
            break;
          }
          case "erode": {
            const mn = neighborMin(src, cols, r, c, this._gridResolution);
            heights[idx] = src[idx] + (mn - src[idx]) * Math.min(1, amt);
            break;
          }
          case "noise":
            heights[idx] += (valueNoise(x * 0.5, z * 0.5, seed) * 2 - 1) * amt;
            break;
          case "pinch": {
            // Pull the surface towards the brush centre's height, tightening a
            // ridge instead of raising or lowering it.
            const target = this.heightAtLocal(local.x, local.z);
            heights[idx] += (target - src[idx]) * Math.min(1, amt);
            break;
          }
          case "contrast":
            // Push away from the local average: the inverse of smooth, and the
            // heightfield equivalent of the mesh sculptor's Crease.
            heights[idx] = src[idx] + (src[idx] - neighborAvg(src, cols, r, c, this._gridResolution)) * amt * 2;
            break;
          default:
            break;
        }
      }
    }
    this.#applyHeightsRect(rMin, rMax, cMin, cMax);
  }

  // ---------------------------------------------------------------------------
  // Paint brush — writes the splatmap channel of the active layer
  // ---------------------------------------------------------------------------

  /**
   * local: THREE.Vector3 brush center in local space.
   * opts: { layerIndex, radius, strength, hardness?, erase? }
   * Adds weight to the active layer's channel (or subtracts it when
   * `erase` is set — the eraser removes what was painted, revealing the
   * layers underneath) and renormalizes the four channels so they sum to
   * 255 per texel (a proper splat weight set). If erasing empties a texel
   * completely it falls back to the base layer (channel 0) so the surface
   * never renders as an unweighted void.
   */
  applySplatBrush(local, opts) {
    if (!this.splatData) return;
    const { layerIndex, radius, strength, hardness = 0.5, falloff = null, erase = false } = opts;
    const layer = THREE.MathUtils.clamp(layerIndex | 0, 0, 3);
    const half = (this.props.size ?? 50) / 2;
    const res = this._splatResolution;

    // Texel <-> world mapping matches the material's uv() sampling:
    //   world x = -half + u*size,  world z =  half - v*size   (see PlaneGeometry
    //   UVs after rotateX; DataTexture flipY = false).
    const worldToU = (wx) => (wx + half) / (half * 2);
    const worldToV = (wz) => (half - wz) / (half * 2);
    const uMin = worldToU(local.x - radius), uMax = worldToU(local.x + radius);
    const vLo = worldToV(local.z + radius), vHi = worldToV(local.z - radius);
    const xMin = Math.max(0, Math.floor(uMin * res)), xMax = Math.min(res - 1, Math.ceil(uMax * res));
    const yMin = Math.max(0, Math.floor(vLo * res)), yMax = Math.min(res - 1, Math.ceil(vHi * res));

    for (let y = yMin; y <= yMax; y++) {
      for (let x = xMin; x <= xMax; x++) {
        const u = (x + 0.5) / res;
        const v = (y + 0.5) / res;
        const wx = u * half * 2 - half;
        const wz = half - v * half * 2;
        const dist = Math.hypot(wx - local.x, wz - local.z);
        if (dist > radius) continue;
        const delta = Math.min(1, strength * brushWeight(dist / radius, { curve: falloff, hardness })) * 255;
        const base = (y * res + x) * 4;
        const cur = [this.splatData[base], this.splatData[base + 1], this.splatData[base + 2], this.splatData[base + 3]];
        const amount = delta / 255;
        if (erase) {
          cur[layer] *= 1 - amount;
        } else {
          // Move the complete weight vector toward the selected layer. The
          // former add-then-normalize rule converged near 50/50, preventing
          // a painted layer from ever replacing the one underneath.
          for (let ch = 0; ch < 4; ch++) {
            cur[ch] = ch === layer
              ? cur[ch] + (255 - cur[ch]) * amount
              : cur[ch] * (1 - amount);
          }
        }
        for (let ch = 0; ch < 4; ch++) {
          this.splatData[base + ch] = Math.round(THREE.MathUtils.clamp(cur[ch], 0, 255));
        }
      }
    }
    this.splatTexture.needsUpdate = true;
  }
}
