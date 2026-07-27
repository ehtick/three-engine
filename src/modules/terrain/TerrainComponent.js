import * as THREE from "three/webgpu";
import { brushWeight } from "../../editor/brush.js";
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
    heights: "", // base64 Float32Array((resolution+1)^2), row-major
    splatmap: "", // base64 Uint8Array(splatResolution^2 * 4)
    layers: [], // optional material overlays blended over the Mesh base material
    scatterLayers: [], // model-backed instance layers painted onto the surface
    castShadow: false,
    receiveShadow: true,
  };
  static schema = [
    { key: "size", label: "Size", type: "number", min: 1, step: 1 },
    { key: "resolution", label: "Resolution", type: "number", min: 2, max: 512, step: 1 },
    { key: "splatResolution", label: "Splat Resolution", type: "number", min: 16, max: 1024, step: 1 },
    { key: "castShadow", label: "Cast Shadow", type: "boolean" },
    { key: "receiveShadow", label: "Receive Shadow", type: "boolean" },
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
  }

  onDetach() {
    if (!this.mesh) return;
    this.generation = (this.generation ?? 0) + 1;
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
    if (this.mesh) this.mesh.visible = false;
    if (this.scatterRoot) this.scatterRoot.visible = false;
  }

  onEnable() {
    if (this.mesh) this.mesh.visible = true;
    if (this.scatterRoot) this.scatterRoot.visible = true;
  }

  onPropChanged(key) {
    if (key === "heights") {
      this.heightsArray = decodeFloat32(this.props.heights, (this.resolution + 1) ** 2);
      this.#applyHeightsToGeometry();
      return;
    }
    if (key === "splatmap") {
      const decoded = decodeUint8(this.props.splatmap, this.splatResolution * this.splatResolution * 4);
      this.splatData = decoded ?? makeDefaultSplat(this.splatResolution);
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
    const resolution = (this.resolution = Math.max(2, Math.floor(this.props.resolution ?? 128)));
    const size = this.props.size ?? 50;
    this.geometry = new THREE.PlaneGeometry(size, size, resolution, resolution);
    this.geometry.rotateX(-Math.PI / 2);
    this.heightsArray = decodeFloat32(this.props.heights, (resolution + 1) ** 2);
    this.#applyHeightsToGeometry();
  }

  #applyHeightsToGeometry() {
    const pos = this.geometry.getAttribute("position");
    const n = Math.min(pos.count, this.heightsArray.length);
    for (let i = 0; i < n; i++) pos.setY(i, this.heightsArray[i]);
    pos.needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere();
    for (let i = 0; i < (this.scatterLayersData?.length ?? 0); i++) this.#refreshScatterLayer(i);
  }

  /** Encode the live heights buffer back into `props` (call once per stroke). */
  commitHeights() {
    this.props.heights = encodeFloat32(this.heightsArray);
  }

  /**
   * Bilinear-sampled height at a local-space (x, z) — used by the editor's
   * brush indicator to hug the live surface (including mid-stroke changes,
   * before a commit re-encodes props.heights). Clamps outside the grid to the
   * nearest edge rather than extrapolating.
   */
  heightAtLocal(x, z) {
    const half = (this.props.size ?? 50) / 2;
    const cols = this.resolution + 1;
    const fc = THREE.MathUtils.clamp(((x + half) / (half * 2)) * this.resolution, 0, this.resolution);
    const fr = THREE.MathUtils.clamp(((z + half) / (half * 2)) * this.resolution, 0, this.resolution);
    const c0 = Math.floor(fc), r0 = Math.floor(fr);
    const c1 = Math.min(c0 + 1, this.resolution), r1 = Math.min(r0 + 1, this.resolution);
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
    const step = (this.props.size ?? 50) / this.resolution;
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
    const step = (this.props.size ?? 50) / this.resolution;
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
    const resolution = (this.splatResolution = Math.max(2, Math.floor(this.props.splatResolution ?? 256)));
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
    const baseAsset = this.baseMaterial;
    const baseGraph = this.baseGraph ?? {};
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

  async #loadBaseMaterial() {
    const path = this.meshComponent?.props.material;
    const generation = (this.baseMaterialGeneration = (this.baseMaterialGeneration ?? 0) + 1);
    this.baseMaterialUnsub?.();
    this.baseMaterialUnsub = null;
    if (!path) {
      this.baseMaterial = null;
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
        const capacity = 2 ** Math.ceil(Math.log2(needed));
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
    const { tool, radius, strength, hardness = 0.5, falloff = null, flattenHeight = 0, seed = 0 } = opts;
    const cols = this.resolution + 1;
    const heights = this.heightsArray;
    const half = (this.props.size ?? 50) / 2;
    const step = (half * 2) / this.resolution;

    // Neighbor-reading tools work off a snapshot so one pass isn't biased by
    // its own in-progress writes.
    const needsSnapshot = tool === "smooth" || tool === "sharpen" || tool === "erode" || tool === "pinch" || tool === "contrast";
    const src = needsSnapshot ? heights.slice() : heights;

    // Only touch vertices inside the brush's bounding box.
    const cMin = Math.max(0, Math.floor((local.x - radius + half) / step));
    const cMax = Math.min(this.resolution, Math.ceil((local.x + radius + half) / step));
    const rMin = Math.max(0, Math.floor((local.z - radius + half) / step));
    const rMax = Math.min(this.resolution, Math.ceil((local.z + radius + half) / step));

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
            const avg = neighborAvg(src, cols, r, c, this.resolution);
            heights[idx] = src[idx] + (avg - src[idx]) * Math.min(1, amt);
            break;
          }
          case "sharpen": {
            const avg = neighborAvg(src, cols, r, c, this.resolution);
            heights[idx] = src[idx] + (src[idx] - avg) * amt;
            break;
          }
          case "erode": {
            const mn = neighborMin(src, cols, r, c, this.resolution);
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
            heights[idx] = src[idx] + (src[idx] - neighborAvg(src, cols, r, c, this.resolution)) * amt * 2;
            break;
          default:
            break;
        }
      }
    }
    this.#applyHeightsToGeometry();
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
    const res = this.splatResolution;

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
