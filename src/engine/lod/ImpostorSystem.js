import * as THREE from "three/webgpu";
import { bakeImpostorAtlas, impostorCacheKey } from "./impostorBake.js";
import { createImpostorGeometry, createImpostorMaterial } from "./impostorMaterial.js";

/**
 * `engine.impostors` — bakes every impostor atlas, and draws every impostor
 * that shares one in a single call (roadmap item 14).
 *
 * ## Why a shared cache is the whole feature
 *
 * A forest is one tree five hundred times. Baking per component would mean five
 * hundred atlases (gigabytes) and five hundred materials. Entities whose source
 * geometry, materials and settings match therefore share ONE atlas, keyed by
 * `impostorCacheKey`, refcounted so the last one out frees the textures.
 *
 * ## Why the system owns the draw, and not the component
 *
 * The obvious shape — one quad mesh per component — is a performance TRAP here,
 * and the kind that measures as a regression: the LOD mesh an impostor replaces
 * is already merged into one instanced draw by `batching.js`, because five
 * hundred identical props share a geometry and a material, which is exactly
 * what that system looks for. Per-component quads would trade a thousand
 * vertices for four hundred and ninety-nine extra draw submissions on a frame
 * that is CPU-bound to begin with.
 *
 * So impostors are drawn the way decals are (item 13): **one buffer per look**.
 * Everything sharing an atlas and its shadow flags goes into one
 * `InstancedBufferGeometry` at the scene root, and each component contributes
 * four instanced attributes — centre, size, and two of the object's world axes.
 * A forest is one draw call.
 *
 * ## Hidden instances are written, not removed
 *
 * An LOD group turns its impostor level on and off constantly, and compacting
 * the buffer on every switch would rewrite the whole forest whenever one tree
 * crossed a threshold. A hidden member gets `aSize = 0` instead, which
 * rasterises nothing — one float per switch. The same write is what stops the
 * batching trap from item 14's first half repeating here: an instance whose
 * entity was hidden keeps drawing until something updates its data, and
 * "the impostor stays on screen under the mesh" points nowhere near this file.
 *
 * ## Why bakes are queued, one per frame
 *
 * A bake is `frames²` small renders plus two readbacks — a handful of
 * milliseconds, but synchronous main-thread work, and a scene enabling fifty
 * impostors at once would spend a second of it in one frame, which reads as the
 * editor hanging on load. The queue spends one bake per frame: the first frames
 * of a scene simply have no impostor to draw, and the chain settles within a
 * second with no stall anyone can see.
 *
 * Bakes run in the engine's PRE-RENDER phase, never from a component's attach:
 * baking is a nested render, and issuing one from inside the main render — or
 * before the renderer's backend has resolved — is a half-drawn frame or an
 * exception on the first tick.
 *
 * ## Why the atlas is not an asset on disk (yet)
 *
 * A baked file would need invalidation whenever the source mesh, its materials
 * or any of their textures change, plus exporter and preload plumbing — and a
 * stale atlas is a bug whose only symptom is "that tree looks wrong far away".
 * A runtime bake can never be stale. The cost is paid once per unique prop per
 * session, the same order as loading the model it replaces.
 */

/** Instances a fresh batch has room for; doubles when it fills. */
const INITIAL_CAPACITY = 16;

/**
 * Whether instance `i`'s buffered data already says what `data` says.
 *
 * Every one of the ten floats is compared, not a representative few: a prop
 * rotating around an axis that only moves `aAxisX.z` is exactly the case a
 * sampled comparison misses, and the symptom — an impostor lit as though it
 * were still facing the old way — is not something anyone traces back to a
 * dirty check.
 */
function unchanged(i, data, centers, sizes, axisX, axisY) {
  if (sizes.array[i] !== data.size) return false;
  const at = i * 3;
  return (
    centers.array[at] === data.center.x &&
    centers.array[at + 1] === data.center.y &&
    centers.array[at + 2] === data.center.z &&
    axisX.array[at] === data.axisX.x &&
    axisX.array[at + 1] === data.axisX.y &&
    axisX.array[at + 2] === data.axisX.z &&
    axisY.array[at] === data.axisY.x &&
    axisY.array[at + 1] === data.axisY.y &&
    axisY.array[at + 2] === data.axisY.z
  );
}

class ImpostorBatch {
  constructor(scene, atlas, material, flags) {
    this.atlas = atlas;
    this.material = material;
    this.flags = flags;
    this.members = [];
    this.capacity = INITIAL_CAPACITY;
    this.geometry = createImpostorGeometry(this.capacity);
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.name = "Impostors";
    this.mesh.castShadow = flags.castShadow;
    this.mesh.receiveShadow = flags.receiveShadow;
    // Instance data is absolute world-space, so the proxy must contribute no
    // transform of its own. The material's position node depends on it.
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    // Picking resolves to the real entities, never to the proxy — the same rule
    // the batch system follows. An impostor level's sibling LOD mesh is still
    // in the scene (hidden, but the raycaster tests layers, not visibility), so
    // clicking a tree in the viewport still selects it.
    this.mesh.raycast = () => {};
    this.mesh.userData.engineOwned = true;
    this.mesh.userData.impostorBatch = true;
    this.mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0);
    scene.add(this.mesh);
    this.dirty = true;
  }

  /** Doubles the instance buffers. The old data is not copied across — the very
   *  next `sync()` rewrites every member anyway, which `dirty` forces. */
  #grow() {
    while (this.capacity < this.members.length) this.capacity *= 2;
    const geometry = createImpostorGeometry(this.capacity);
    this.mesh.geometry = geometry;
    this.geometry.dispose();
    this.geometry = geometry;
  }

  add(component) {
    this.members.push(component);
    if (this.members.length > this.capacity) this.#grow();
    this.dirty = true;
  }

  remove(component) {
    const at = this.members.indexOf(component);
    if (at < 0) return;
    this.members.splice(at, 1);
    this.dirty = true;
  }

  /**
   * Rewrites the instance data for every member whose transform or visibility
   * moved. Cheap in the steady state (a comparison per member) and correct on
   * the frame anything changes, which matters more: LOD switches, moving props
   * and a scene load all arrive as changes to this data.
   */
  sync() {
    const centers = this.geometry.attributes.aCenter;
    const sizes = this.geometry.attributes.aSize;
    const axisX = this.geometry.attributes.aAxisX;
    const axisY = this.geometry.attributes.aAxisY;
    let changed = false;
    let visibleCount = 0;
    const sphere = this.mesh.boundingSphere;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    for (let i = 0; i < this.members.length; i++) {
      const member = this.members[i];
      const data = member.instanceData(this.atlas);
      if (data.size > 0) {
        visibleCount++;
        minX = Math.min(minX, data.center.x - data.size);
        minY = Math.min(minY, data.center.y - data.size);
        minZ = Math.min(minZ, data.center.z - data.size);
        maxX = Math.max(maxX, data.center.x + data.size);
        maxY = Math.max(maxY, data.center.y + data.size);
        maxZ = Math.max(maxZ, data.center.z + data.size);
      }
      if (!this.dirty && unchanged(i, data, centers, sizes, axisX, axisY)) continue;
      changed = true;
      sizes.array[i] = data.size;
      centers.array[i * 3] = data.center.x;
      centers.array[i * 3 + 1] = data.center.y;
      centers.array[i * 3 + 2] = data.center.z;
      axisX.array[i * 3] = data.axisX.x;
      axisX.array[i * 3 + 1] = data.axisX.y;
      axisX.array[i * 3 + 2] = data.axisX.z;
      axisY.array[i * 3] = data.axisY.x;
      axisY.array[i * 3 + 1] = data.axisY.y;
      axisY.array[i * 3 + 2] = data.axisY.z;
    }

    if (changed || this.dirty) {
      centers.needsUpdate = true;
      sizes.needsUpdate = true;
      axisX.needsUpdate = true;
      axisY.needsUpdate = true;
      this.geometry.instanceCount = this.members.length;
      if (visibleCount === 0) {
        sphere.center.set(0, 0, 0);
        sphere.radius = 0;
        // A zero radius would cull the batch even when a member reappears, so
        // the mesh is hidden outright instead and shown again by the next sync
        // that finds a visible member.
        this.mesh.visible = false;
      } else {
        sphere.center.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
        sphere.radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) * 0.5;
        this.mesh.visible = true;
      }
    }
    this.dirty = false;
    return visibleCount;
  }

  dispose(scene) {
    scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    this.atlas.dispose();
  }
}

export class ImpostorSystem {
  constructor(engine) {
    this.engine = engine;
    /** cacheKey -> { atlas, material, refs } */
    this.cache = new Map();
    /** batchKey -> ImpostorBatch */
    this.batches = new Map();
    /** Components with no atlas yet. */
    this.queue = [];
    this.enabled = true;
    this.baking = false;
    this.bakedCount = 0;
    this.failures = 0;
    this.visibleCount = 0;
  }

  /**
   * Asks for an atlas for `component`. Returns immediately; the component is
   * called back through `applyAtlas` once one exists.
   */
  request(component) {
    if (!this.enabled) return;
    if (this.queue.includes(component)) return;
    // A cache hit needs no bake at all — the path the other 499 trees take, and
    // it has to be synchronous or every instance would wait a frame behind the
    // first for nothing.
    const source = component.resolveSource();
    if (source) {
      const key = impostorCacheKey(source, component.bakeSettings());
      const entry = this.cache.get(key);
      if (entry) {
        entry.refs++;
        this.#attach(component, key, entry);
        return;
      }
    }
    this.queue.push(component);
  }

  /** Removes a component that is waiting, e.g. because it was detached. */
  cancel(component) {
    const at = this.queue.indexOf(component);
    if (at >= 0) this.queue.splice(at, 1);
  }

  /** Hands back a component's claim on its atlas and drops it out of its batch. */
  release(component) {
    const batch = this.batches.get(component.batchKey);
    if (batch) {
      batch.remove(component);
      if (batch.members.length === 0) {
        this.batches.delete(component.batchKey);
        batch.dispose(this.engine.scene);
        // The batch owns the material and the atlas textures, so the cache
        // entry goes with it.
        this.cache.delete(component.atlasKey);
      }
    }
    const entry = this.cache.get(component.atlasKey);
    if (entry) entry.refs--;
    component.batchKey = null;
    component.atlasKey = null;
    component.atlas = null;
  }

  /**
   * Forces a fresh bake, discarding whatever the component is using. The
   * editor's Re-bake button: the author edited the source mesh, and the cache —
   * correctly — cannot know a `.geom` changed underneath it.
   */
  rebake(component) {
    this.release(component);
    this.cancel(component);
    this.request(component);
  }

  #batchKeyFor(component, atlasKey) {
    // Shadow flags cannot vary within one draw, so they are part of the
    // grouping rather than something the first member silently decides for the
    // rest — the mistake that makes one prop's "cast shadow: off" switch off a
    // whole forest's shadows.
    return `${atlasKey}|${component.props.castShadow ? 1 : 0}${component.props.receiveShadow ? 1 : 0}`;
  }

  #attach(component, atlasKey, entry) {
    const batchKey = this.#batchKeyFor(component, atlasKey);
    let batch = this.batches.get(batchKey);
    if (!batch) {
      batch = new ImpostorBatch(this.engine.scene, entry.atlas, entry.material, {
        castShadow: component.props.castShadow !== false,
        receiveShadow: component.props.receiveShadow !== false,
      });
      this.batches.set(batchKey, batch);
    }
    component.applyAtlas(atlasKey, batchKey, entry.atlas);
    batch.add(component);
  }

  /** One bake per frame, from the engine's pre-render phase. */
  update() {
    if (!this.enabled) return;
    this.#drainQueue();
    let visible = 0;
    for (const batch of this.batches.values()) visible += batch.sync();
    this.visibleCount = visible;
  }

  #drainQueue() {
    if (this.baking || this.queue.length === 0) return;
    const renderer = this.engine.renderer;
    if (!renderer || !this.engine.rendererReady) return;
    const component = this.queue.shift();
    if (!component.entity || component.detached) return;
    const source = component.resolveSource();
    if (!source) {
      // No source yet — a scene still deserializing, or a `source` naming an
      // entity that does not exist. Re-queue rather than fail: the alternative
      // is an impostor that silently never appears because it was asked for one
      // frame too early.
      component.pendingSource = true;
      this.queue.push(component);
      return;
    }
    component.pendingSource = false;
    const settings = component.bakeSettings();
    const key = impostorCacheKey(source, settings);
    const cached = this.cache.get(key);
    if (cached) {
      cached.refs++;
      this.#attach(component, key, cached);
      return;
    }
    this.baking = true;
    bakeImpostorAtlas(renderer, source, settings)
      .then((atlas) => {
        const material = createImpostorMaterial(atlas, {
          alphaTest: settings.alphaTest,
          lit: settings.lit,
        });
        const entry = { atlas, material, refs: 1 };
        this.cache.set(key, entry);
        this.bakedCount++;
        if (component.entity && !component.detached) this.#attach(component, key, entry);
        else {
          this.cache.delete(key);
          material.dispose();
          atlas.dispose();
        }
      })
      .catch((error) => {
        this.failures++;
        component.bakeError = error?.message ?? String(error);
        console.warn(`Impostor bake failed: ${component.bakeError}`);
      })
      .finally(() => {
        this.baking = false;
      });
  }

  get stats() {
    return {
      atlases: this.cache.size,
      batches: this.batches.size,
      instances: this.visibleCount,
      pending: this.queue.length,
      baked: this.bakedCount,
      failures: this.failures,
    };
  }

  dispose() {
    this.queue.length = 0;
    for (const batch of this.batches.values()) batch.dispose(this.engine.scene);
    this.batches.clear();
    this.cache.clear();
  }
}
