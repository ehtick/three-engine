import * as THREE from "three/webgpu";
import { loadAssetMeta } from "../../engine/assetResolver.js";
import { EDITOR_LAYER } from "../../engine/editorLayers.js";
import { buildClusterDAG, selectClusterIds, gatherClusterIndices } from "./clusterBuilder.js";

/**
 * Per-engine virtual-geometry runtime (installed by the module's setup()).
 *
 * Unreal-style: virtual geometry is a property of the ASSET, not a component.
 * A model or geometry opts in via its sidecar meta (`<asset>.meta` →
 * `virtualGeometry: { enabled, pixelError }`, edited in the asset
 * inspector). Whenever a Model component finishes loading such a model — any
 * entity, any scene — this system swaps each eligible mesh's geometry in
 * place: same mesh object, same material, same transforms, but the index
 * buffer becomes the per-frame LOD cut through the cluster DAG (see
 * clusterBuilder.js). Nothing else in the engine knows this happened, so
 * shadows, picking and serialization keep working on the original mesh.
 *
 * The cut is selected from the CAMERA POSITION only — deliberately not
 * frustum-culled per cluster. The same index buffer feeds every render of the
 * mesh (main view, shadow maps, editor PIP), so view-dependent culling would
 * punch holes in shadows and in any pass with a different frustum; the
 * distance-only cut is identical for all of them. Whole-mesh frustum culling
 * still happens in three.js via the geometry's bounding sphere. A bonus:
 * rotating the camera in place never re-selects or re-uploads anything.
 *
 * The DAG is built once per (asset, mesh) and cached process-wide — it only
 * stores triangle INDICES plus error metadata, so it's valid for every
 * reload/instance of the same asset even though each load parses fresh
 * vertex buffers.
 *
 * MVP cuts: static meshes only (skinned skipped); multi-material meshes draw
 * with their first material (a dynamic index buffer has no group ranges);
 * shadows reuse the camera's cut; scatter/instancer meshes are untouched.
 */

// `${path}#${meshIndex}` -> Promise<dag>. Failed builds are evicted so a
// broken asset can retry after being re-imported.
const dagCache = new Map();

function getDag(path, meshIndex, geometry) {
  const key = `${path}#${meshIndex}`;
  let p = dagCache.get(key);
  if (!p) {
    p = buildDagFromGeometry(path, geometry);
    p.catch(() => dagCache.delete(key));
    dagCache.set(key, p);
  }
  return p;
}

// mesh -> record. A WeakMap (NOT mesh.userData) on purpose: userData can end
// up in serialization/clone paths, and a record holds multi-megabyte buffers.
const virtualized = new WeakMap();

/** Read-only bridge for low-frequency consumers such as GI ray proxies. */
export function getVirtualGeometryRecord(mesh) {
  return virtualized.get(mesh) ?? null;
}

/** Non-interleaved Float32 view of an attribute (copies when it must). */
function attrToFloat32(attr) {
  if (!attr) return null;
  if (!attr.isInterleavedBufferAttribute && attr.array instanceof Float32Array) return attr.array;
  const n = attr.count, s = attr.itemSize;
  const out = new Float32Array(n * s);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < s; c++) out[i * s + c] = attr.getComponent(i, c);
  }
  return out;
}

async function buildDagFromGeometry(path, geometry) {
  if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
  const positions = attrToFloat32(geometry.getAttribute("position"));
  const normals = attrToFloat32(geometry.getAttribute("normal"));
  const uvAttr = geometry.getAttribute("uv");
  let indices;
  if (geometry.index) {
    indices = geometry.index.array instanceof Uint32Array
      ? geometry.index.array
      : new Uint32Array(geometry.index.array);
  } else {
    indices = new Uint32Array(positions.length / 3);
    for (let i = 0; i < indices.length; i++) indices[i] = i;
  }
  const t0 = performance.now();
  const dag = await buildClusterDAG({ positions, normals, uvs: uvAttr ? attrToFloat32(uvAttr) : null, indices });
  const dt = (performance.now() - t0).toFixed(0);
  const tris = (indices.length / 3).toLocaleString();
  console.info(`[virtual-geometry] ${path}: ${tris} tris → ${dag.clusterCount} clusters (${dag.levelCount} LODs, ${dt} ms)`);
  return dag;
}

// Every live system, so the editor can poke all open engines when a model's
// meta changes (see refreshVirtualGeometryAsset).
const activeSystems = new Set();

/** Editor hook: re-evaluates one asset everywhere after its meta changed. */
export function refreshVirtualGeometryAsset(path) {
  for (const sys of activeSystems) sys.refreshAsset(path);
}

/**
 * Editor hook: the asset's TRIANGLES changed, not just its meta — the geometry
 * editor saved over it.
 *
 * A cluster DAG is a set of indices into one specific triangle list, cached per
 * asset path because every instance and every reload of that asset shares it.
 * Once the file has been re-authored those indices point at different
 * triangles, so the cache has to go or the mesh renders a LOD cut of the mesh
 * it used to be.
 *
 * The swapped geometry is deliberately NOT put back: by the time this runs the
 * caller has already placed the edited geometry on the mesh, and restoring the
 * pre-edit one would visibly undo the save. Dropping the records is enough —
 * the reload that follows fires `component-changed`, and `applyEntity`
 * re-virtualizes from the geometry that is on the mesh by then.
 */
export function invalidateVirtualGeometryAsset(path) {
  const np = normPath(path);
  for (const key of [...dagCache.keys()]) {
    // Keys are `${path}#${meshIndex}`.
    if (normPath(key.slice(0, key.lastIndexOf("#"))) === np) dagCache.delete(key);
  }
  for (const sys of activeSystems) sys.forgetAsset(path);
}

export const VIRTUAL_GEOMETRY_META_DEFAULTS = {
  enabled: false,
  pixelError: 1,
  // Camera-movement dead-band as a fraction of the distance to the mesh: the
  // camera must move this fraction of its distance before the mesh recomputes
  // its LOD cut. Because projected error scales as 1/distance, a fraction f of
  // movement shifts the error budget by ~f, so f = 0.02 lags the LOD by at
  // most ~2% of a pixel-error boundary (invisible) while skipping the vast
  // majority of per-frame re-selections during smooth camera motion.
  hysteresis: 0.02,
};

/** Ignores retired per-asset debug settings while normalizing stored meta. */
function resolveVgMeta(raw) {
  if (!raw) return null;
  return {
    enabled: raw.enabled === true,
    pixelError: raw.pixelError ?? VIRTUAL_GEOMETRY_META_DEFAULTS.pixelError,
    hysteresis: raw.hysteresis ?? VIRTUAL_GEOMETRY_META_DEFAULTS.hysteresis,
  };
}

// Runtime perf knob (project/module default; see index.js applySettings). Caps
// how many meshes may rebuild their cut in a single frame so a dense scene
// with a moving camera spreads the cost across frames instead of spiking.
let maxUpdatesPerFrame = 8;

/** Editor/host hook: pushes the module's runtime settings onto every engine. */
export function setVirtualGeometryRuntimeConfig({ maxUpdatesPerFrame: m } = {}) {
  if (Number.isFinite(m) && m > 0) maxUpdatesPerFrame = Math.floor(m);
}

// Debug visualization belongs to the editor viewport, not individual assets.
// Retain the requested state for systems created after the viewport toggle.
let debugTrianglesVisible = false;

/** Editor hook: shows triangle-density coloring for every live VG mesh. */
export function setVirtualGeometryDebugVisible(visible) {
  debugTrianglesVisible = !!visible;
  for (const system of activeSystems) system.setDebugVisible(debugTrianglesVisible);
}

/** Stable bright pseudo-random color from an id (UE-debug-view style). */
function debugColor(id, out) {
  const h = (Math.imul(id + 1, 2654435761) >>> 0) / 4294967296;
  const hue = h * 6;
  const x = 1 - Math.abs((hue % 2) - 1);
  const seg = hue | 0;
  let r = 0, g = 0, b = 0;
  if (seg === 0) { r = 1; g = x; } else if (seg === 1) { r = x; g = 1; }
  else if (seg === 2) { g = 1; b = x; } else if (seg === 3) { g = x; b = 1; }
  else if (seg === 4) { r = x; b = 1; } else { r = 1; b = x; }
  // Two brightness bands so same-hue neighbours still separate.
  const l = 0.55 + (((Math.imul(id + 7, 40503) >>> 0) % 100) / 100) * 0.45;
  out[0] = r * l;
  out[1] = g * l;
  out[2] = b * l;
}

/** Paths may arrive with either slash direction on Windows — compare loosely. */
const normPath = (p) => (p ?? "").replace(/\\/g, "/");

// Scratch objects for the per-frame selection — never allocate in the loop.
const _inv = new THREE.Matrix4();
const _camWorld = new THREE.Vector3();
const _camLocal = new THREE.Vector3();
const _center = new THREE.Vector3();
const _rgb = [0, 0, 0];

export class VirtualGeometrySystem {
  constructor(engine) {
    this.engine = engine;
    // One record per virtualized mesh:
    // { mesh, path, dag, geometry, index, original, selClusters, drawn,
    //   hash, debug }
    this.records = [];
    this.settings = new Map(); // path -> resolved virtualGeometry meta | null
    this.stats = { drawnTriangles: 0, totalTriangles: 0, drawnClusters: 0 };
    this.debugVisible = debugTrianglesVisible;
    this._pruneNeeded = false;
    // Round-robin cursor into `records` for the per-frame update budget.
    this._scanStart = 0;
    this._offModel = engine.on("model-loaded", (entity) => this.applyEntity(entity));
    this._offComponent = engine.on("component-changed", ({ entityId, componentType, key }) => {
      // MeshComponent emits this after its asynchronous .geom load completes.
      if (componentType === "mesh" && key === "geometryAsset") {
        const entity = engine.entities.get(entityId);
        if (entity) this.applyEntity(entity);
      }
    });
    this._offHier = engine.on("hierarchy-changed", () => (this._pruneNeeded = true));
    this._offTick = engine.onUpdate(() => this.#tick());
    activeSystems.add(this);
    // The module can be enabled after a scene (and its models) already loaded.
    for (const entity of engine.entities.values()) this.applyEntity(entity);
  }

  setDebugVisible(visible) {
    visible = !!visible;
    if (this.debugVisible === visible) return;
    this.debugVisible = visible;
    // Force every record dirty so the debug overlay rebuilds/tears down on the
    // next tick (debugVisible is folded into the discrete hash).
    for (const r of this.records) r.discreteHash = null;
  }

  dispose() {
    activeSystems.delete(this);
    this._offModel?.();
    this._offComponent?.();
    this._offHier?.();
    this._offTick?.();
    for (const r of this.records) this.#restore(r);
    this.records = [];
    this.settings.clear();
  }

  async #metaFor(path, force = false) {
    if (!force && this.settings.has(path)) return this.settings.get(path);
    const meta = await loadAssetMeta(`${path}.meta`);
    const vg = resolveVgMeta(meta?.virtualGeometry);
    this.settings.set(path, vg);
    return vg;
  }

  /** Virtualizes an entity's Model or .geom-backed Mesh (if opted in). */
  async applyEntity(entity) {
    const mc = entity.getComponent?.("model");
    const meshComponent = entity.getComponent?.("mesh");
    const path = mc?.props?.path || meshComponent?.props?.geometryAsset;
    if (!path) return;
    const vg = await this.#metaFor(path);
    if (!vg?.enabled) return;
    const meshes = [];
    const root = mc?.root;
    if (root) {
      root.traverse((o) => {
        if (o.isMesh && !o.isSkinnedMesh && !o.userData.vgeoDebug) meshes.push(o);
      });
    } else if (meshComponent?.mesh && !meshComponent.mesh.isSkinnedMesh) {
      meshes.push(meshComponent.mesh);
    }
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i];
      if (virtualized.has(mesh)) continue;
      if (!mesh.geometry?.getAttribute("position")) continue;
      try {
        const dag = await getDag(path, i, mesh.geometry);
        // The await is a suspension point: the model may have been reloaded
        // or the entity destroyed meanwhile. Only swap a mesh that is still
        // the live one.
        if ((mc && mc.root !== root) || (!mc && meshComponent.mesh !== mesh) || virtualized.has(mesh)) continue;
        this.#virtualize(mesh, path, dag);
      } catch (err) {
        console.error(`[virtual-geometry] ${path} failed: ${err.message}`);
      }
    }
  }

  #virtualize(mesh, path, dag) {
    const src = mesh.geometry;
    const geometry = new THREE.BufferGeometry();
    // Vertex data is shared with the source geometry; only the index buffer
    // (the current LOD cut) belongs to this record.
    for (const name of Object.keys(src.attributes)) geometry.setAttribute(name, src.attributes[name]);
    const index = new THREE.BufferAttribute(new Uint32Array(dag.lod0IndexCount), 1);
    index.setUsage(THREE.DynamicDrawUsage);
    geometry.setIndex(index);
    geometry.setDrawRange(0, 0);
    const [bx, by, bz, br] = dag.bounds;
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(bx, by, bz), br);

    mesh.geometry = geometry;
    if (Array.isArray(mesh.material)) mesh.material = mesh.material[0]; // no group ranges
    // This mesh's index buffer is now rewritten per frame to the selected
    // cluster cut, so it can never share a draw with anything else. Opt it out
    // of automatic batching (see engine/batching.js), which would otherwise
    // freeze it at whatever LOD it held when the batch was built.
    mesh.userData.noBatch = true;
    this.engine.batching?.invalidate();

    const record = {
      mesh,
      path,
      dag,
      geometry,
      index,
      original: src,
      selClusters: new Uint32Array(dag.clusterCount),
      drawn: 0,
      // Selection cache. selSig = FNV hash of the selected cluster SET; null
      // until the first selection. discreteHash = hash of the non-continuous
      // inputs (projection, viewport, mesh matrix, pixelError, debug). selCam*
      // / selDist gate re-selection against smooth camera translation.
      selSig: null,
      discreteHash: null,
      selCamX: 0,
      selCamY: 0,
      selCamZ: 0,
      selDist: 0,
      debug: null,
    };
    virtualized.set(mesh, record);
    this.records.push(record);
    this.engine.emit("virtual-geometry-ready", { mesh, path, dag });
  }

  /**
   * Stops tracking every mesh built from `path`, leaving whatever geometry is
   * on them alone. See `invalidateVirtualGeometryAsset`.
   */
  forgetAsset(path) {
    const np = normPath(path);
    const dead = this.records.filter((r) => normPath(r.path) === np);
    if (!dead.length) return;
    this.records = this.records.filter((r) => normPath(r.path) !== np);
    for (const r of dead) {
      if (virtualized.get(r.mesh) === r) virtualized.delete(r.mesh);
      this.#dropDebug(r);
      // Only ours to free if the mesh has already moved on to something else.
      if (r.mesh.geometry !== r.geometry) r.geometry.dispose();
    }
    this.engine.batching?.invalidate();
  }

  /** Puts the original geometry back and drops per-record GPU state. */
  #restore(r) {
    if (virtualized.get(r.mesh) === r) {
      r.mesh.geometry = r.original;
      r.mesh.userData.noBatch = false;
      this.engine.batching?.invalidate();
      virtualized.delete(r.mesh);
    }
    this.#dropDebug(r);
    r.geometry.dispose();
  }

  #dropDebug(r) {
    if (!r.debug) return;
    r.mesh.remove(r.debug.mesh);
    r.debug.geometry.dispose();
    r.debug.mesh.material.dispose();
    r.debug = null;
  }

  /** Editor hook: an asset's virtualGeometry meta changed. */
  async refreshAsset(path) {
    const vg = await this.#metaFor(path, true);
    const np = normPath(path);
    if (!vg?.enabled) {
      // Turned off: restore every mesh using this asset.
      const dead = this.records.filter((r) => normPath(r.path) === np);
      this.records = this.records.filter((r) => normPath(r.path) !== np);
      for (const r of dead) this.#restore(r);
      this.engine.emit("virtual-geometry-changed", { path });
      console.info(`[virtual-geometry] ${path}: disabled, restored ${dead.length} mesh(es)`);
      return;
    }
    // Turned on / retuned: (re)apply to every entity using the asset. Hash
    // reset picks up pixelError changes on already-virtual meshes.
    let matched = 0;
    for (const r of this.records) {
      if (normPath(r.path) === np) {
        // The tick looks settings up by the record's own path string, which
        // may differ from the editor's in slash direction — refresh it too.
        this.settings.set(r.path, vg);
        r.discreteHash = null; // pixelError changes are folded into it
        matched++;
      }
    }
    for (const entity of this.engine.entities.values()) {
      const modelPath = entity.getComponent?.("model")?.props?.path;
      const geometryPath = entity.getComponent?.("mesh")?.props?.geometryAsset;
      if (normPath(modelPath) === np || normPath(geometryPath) === np) this.applyEntity(entity);
    }
    this.engine.emit("virtual-geometry-changed", { path });
    console.info(
      `[virtual-geometry] ${path}: enabled, pixelError=${vg.pixelError}, ` +
        `${matched}/${this.records.length} mesh(es) matched`,
    );
  }

  /** Drops records whose mesh is no longer connected to the scene (model
   *  reloaded / entity destroyed — ModelComponent already disposed the
   *  swapped geometry, we just stop tracking it). */
  #prune() {
    this._pruneNeeded = false;
    const scene = this.engine.scene;
    this.records = this.records.filter((r) => {
      let n = r.mesh;
      while (n.parent) n = n.parent;
      if (n === scene) return true;
      if (virtualized.get(r.mesh) === r) virtualized.delete(r.mesh);
      this.#dropDebug(r);
      return false;
    });
  }

  #tick() {
    if (this._pruneNeeded) this.#prune();
    const records = this.records;
    const n = records.length;
    if (!n) return;
    const engine = this.engine;
    const camera = engine.camera;
    const renderer = engine.renderer;
    if (!camera || !renderer) return;

    const heightPx = renderer.domElement?.height || 1080;
    const isOrtho = !!camera.isOrthographicCamera;
    // Perspective: pxError = worldError * k / distance. Ortho: * k directly.
    const k = isOrtho
      ? (heightPx * (camera.zoom ?? 1)) / Math.max(1e-6, camera.top - camera.bottom)
      : heightPx / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov ?? 50) / 2));
    _camWorld.setFromMatrixPosition(camera.matrixWorld);

    // Base of the discrete (non-continuous) hash, shared by every record:
    // projection scale, viewport height, debug toggle. A change here (resize,
    // zoom, debug on/off) dirties all records at once.
    let base = 2166136261;
    const mixB = (v) => (base = ((base ^ Math.fround(v)) * 16777619) >>> 0);
    const p = camera.projectionMatrix.elements;
    mixB(p[0]); mixB(p[5]); mixB(heightPx); mixB(this.debugVisible ? 1 : 0);

    // Pass 1: refresh world matrices, fold in the per-record discrete inputs,
    // and decide which records are dirty. Dirty = first selection, a discrete
    // change, or the camera translated past this record's movement dead-band
    // (perspective only — an ortho pan never changes projected error).
    for (let i = 0; i < n; i++) {
      const r = records[i];
      r.mesh.updateWorldMatrix(true, false);
      const vg = this.settings.get(r.path) ?? VIRTUAL_GEOMETRY_META_DEFAULTS;
      r._vg = vg;
      const em = r.mesh.matrixWorld.elements;
      let h = base;
      const mix = (v) => (h = ((h ^ Math.fround(v)) * 16777619) >>> 0);
      mix(em[0]); mix(em[5]); mix(em[10]); mix(em[12]); mix(em[13]); mix(em[14]);
      mix(vg.pixelError ?? 1);
      r._dHash = h;

      let dirty = r.selSig === null || h !== r.discreteHash;
      if (!dirty && !isOrtho) {
        const dx = _camWorld.x - r.selCamX, dy = _camWorld.y - r.selCamY, dz = _camWorld.z - r.selCamZ;
        const tol = (vg.hysteresis ?? VIRTUAL_GEOMETRY_META_DEFAULTS.hysteresis) * r.selDist;
        if (dx * dx + dy * dy + dz * dz > tol * tol) dirty = true;
      }
      r._dirty = dirty;
    }

    // Pass 2: process dirty records up to the per-frame budget, resuming from
    // last frame's cursor so no mesh is starved when the scene has more moving
    // virtual meshes than the budget allows.
    let budget = maxUpdatesPerFrame > 0 ? maxUpdatesPerFrame : n;
    let scanned = 0;
    const start = this._scanStart % n;
    while (scanned < n && budget > 0) {
      const i = (start + scanned) % n;
      scanned++;
      const r = records[i];
      if (!r._dirty) continue;
      r.discreteHash = r._dHash;
      // Distance to the mesh's bounding-sphere centre (world space) seeds the
      // next frame's movement dead-band.
      _center.set(r.dag.bounds[0], r.dag.bounds[1], r.dag.bounds[2]).applyMatrix4(r.mesh.matrixWorld);
      r.selDist = _camWorld.distanceTo(_center);
      r.selCamX = _camWorld.x; r.selCamY = _camWorld.y; r.selCamZ = _camWorld.z;
      this.#select(r, r._vg, k, isOrtho);
      budget--;
    }
    this._scanStart = (start + scanned) % n;

    // Pass 3: aggregate stats over every record (processed or not).
    let drawn = 0, total = 0, clusters = 0;
    for (let i = 0; i < n; i++) {
      const r = records[i];
      total += r.dag.lod0IndexCount / 3;
      drawn += r.drawn / 3;
      clusters += r._selStats?.drawnClusters ?? 0;
    }
    this.stats.drawnTriangles = drawn;
    this.stats.totalTriangles = total;
    this.stats.drawnClusters = clusters;
  }

  #select(r, vg, k, isOrtho) {
    const mesh = r.mesh;
    // World matrix already refreshed in the tick's pass 1.
    _inv.copy(mesh.matrixWorld).invert();
    _camLocal.copy(_camWorld).applyMatrix4(_inv);

    const tau = Math.max(0.05, vg.pixelError ?? 1);
    const stats = (r._selStats ??= {});
    const clusterCount = selectClusterIds(
      r.dag, _camLocal.x, _camLocal.y, _camLocal.z, k, isOrtho, tau, r.selClusters, stats,
    );

    // Signature of the selected cluster SET. The expensive part — rebuilding
    // the index buffer and re-uploading it to the GPU — only runs when the set
    // actually changed, which during smooth motion is far rarer than the
    // per-frame re-selection itself.
    let sig = 2166136261;
    for (let s = 0; s < clusterCount; s++) sig = ((sig ^ r.selClusters[s]) * 16777619) >>> 0;
    sig = ((sig ^ clusterCount) * 16777619) >>> 0;
    const changed = sig !== r.selSig;

    if (changed) {
      r.selSig = sig;
      const count = gatherClusterIndices(r.dag, r.selClusters, clusterCount, r.index.array);
      r.drawn = count;
      r.index.clearUpdateRanges();
      if (count > 0) r.index.addUpdateRange(0, count);
      r.index.needsUpdate = true;
      r.geometry.setDrawRange(0, count);
    }

    if (this.debugVisible) {
      if (changed || !r.debug) this.#updateDebug(r, r.drawn, clusterCount);
      r.debug.mesh.visible = true;
    } else if (r.debug) {
      r.debug.mesh.visible = false;
    }
  }

  /**
   * Editor debug view: unlit flat pseudo-random colors, stable frame to
   * frame. Every triangle of the cut is colored individually, so on-screen
   * triangle density is directly visible; it grows near and shrinks far.
   *
   * Buffers are position + uint8 color only (no normals — unlit), sized to
   * the CURRENT cut and grown geometrically on demand: a typical cut is far
   * smaller than full detail, so this stays tens of MB instead of the
   * hundreds that full-detail preallocation would cost per mesh.
   */
  #updateDebug(r, indexCount, drawnClusters) {
    if (!r.debug || r.debug.capacity < indexCount) {
      const capacity = Math.ceil((indexCount * 1.5) / 3) * 3;
      this.#dropDebug(r);
      const geometry = new THREE.BufferGeometry();
      const position = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
      position.setUsage(THREE.DynamicDrawUsage);
      // Float RGB on purpose: it's the one vertex-color layout every three.js
      // path is exercised with. Byte-packed colors looked tempting but WebGPU
      // has no 3-component byte vertex format (`unorm8x3` doesn't exist), and
      // a format the pipeline rejects makes the mesh silently draw nothing.
      const color = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
      color.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute("position", position);
      geometry.setAttribute("color", color);
      geometry.setDrawRange(0, 0);
      geometry.boundingSphere = r.geometry.boundingSphere.clone();
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
        vertexColors: true,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      }));
      mesh.userData.vgeoDebug = true;
      mesh.userData.entityId = r.mesh.userData.entityId;
      mesh.layers.set(EDITOR_LAYER);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      r.mesh.add(mesh); // child ⇒ inherits transform, dies with the mesh
      r.debug = { geometry, mesh, position, color, capacity };
      r._dbgPositions = attrToFloat32(r.geometry.getAttribute("position"));
    }
    const dag = r.dag;
    const positions = r._dbgPositions;
    const dp = r.debug.position.array;
    const dc = r.debug.color.array;
    let vi = 0;
    for (let s = 0; s < drawnClusters; s++) {
      const ci = r.selClusters[s];
      const off = dag.clusterRanges[ci * 2], cnt = dag.clusterRanges[ci * 2 + 1];
      for (let j = 0; j < cnt; j += 3) {
        // Global triangle id ⇒ a triangle keeps its color between frames.
        debugColor((off + j) / 3, _rgb);
        for (let e = 0; e < 3; e++) {
          const v = dag.indexData[off + j + e] * 3;
          const p3 = vi * 3;
          dp[p3] = positions[v]; dp[p3 + 1] = positions[v + 1]; dp[p3 + 2] = positions[v + 2];
          dc[p3] = _rgb[0]; dc[p3 + 1] = _rgb[1]; dc[p3 + 2] = _rgb[2];
          vi++;
        }
      }
    }
    for (const attr of [r.debug.position, r.debug.color]) {
      attr.clearUpdateRanges();
      if (vi > 0) attr.addUpdateRange(0, vi * 3);
      attr.needsUpdate = true;
    }
    r.debug.geometry.setDrawRange(0, vi);
  }
}
