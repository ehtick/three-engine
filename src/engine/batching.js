// @ts-check
import * as THREE from "three/webgpu";

/**
 * Automatic static batching.
 *
 * A mesh entity is one `THREE.Mesh`, and every `THREE.Mesh` is one draw call —
 * re-issued again for each shadow cascade. A scene assembled from an imported
 * model is thousands of entities that overwhelmingly repeat a handful of
 * distinct (geometry, material) pairs, so the frame becomes CPU-bound on draw
 * submission long before the GPU is doing anything interesting.
 *
 * This system finds meshes that share a geometry AND a material (and agree on
 * the render flags that have to be uniform across a draw) and renders each such
 * group as a single `InstancedMesh`. A thousand crates become one draw call.
 *
 * The member meshes are NOT removed from the scene graph — they are only made
 * invisible. That is deliberate and load-bearing:
 *
 *   - three's Raycaster tests `layers`, never `visible`, so editor picking,
 *     selection outlines and bounds keep working against the real per-entity
 *     meshes with no special-casing anywhere in the editor.
 *   - the batch proxies opt OUT of raycasting (`raycast = () => {}`) so a click
 *     resolves to exactly one entity, exactly as before.
 *   - anything that walks the scene for a component's own mesh still finds it.
 *
 * "Static" refers to topology, not to motion: a member that MOVES is cheap
 * (its instance matrix is rewritten in place), a member that is ADDED, REMOVED,
 * HIDDEN or RE-MATERIALED forces its group to be rebuilt.
 */

/** Groups smaller than this stay as ordinary meshes — a batch of two saves one
 *  draw call and costs a rebuild plus a coarser frustum bound. */
const MIN_GROUP_SIZE = 4;

/**
 * Components that take ownership of their entity's mesh and mutate it in ways a
 * shared instanced draw cannot represent (per-entity deformed geometry, cluster
 * LOD swaps, skinning). Entities carrying any of these are never batched.
 */
const EXCLUSIVE_COMPONENTS = ["skinnedmesh", "terrain", "geometryModifiers"];

/**
 * True when `entity` and every ancestor are both enabled for the current mode
 * and visible.
 *
 * A batch proxy hangs off the scene root, so it does NOT inherit the
 * visibility of the entity subtree its members live in — this system has to
 * resolve that itself or a disabled entity keeps rendering through its batch.
 *
 * Both the per-mode flag and `object3D.visible` are consulted. The engine's
 * main loop derives the latter from the former each frame, but they disagree
 * in the window between a flag flipping and the next tick, and this must be
 * correct whenever it is called rather than only mid-frame.
 */
function entityVisible(entity, modeFlag) {
  for (let node = entity; node; node = node.parent) {
    if (node[modeFlag] === false) return false;
    if (node.object3D.visible === false) return false;
  }
  return true;
}

export class BatchSystem {
  constructor(engine) {
    this.engine = engine;
    this.enabled = false;
    this.batches = []; // { key, mesh, members: [Mesh], cache: Float32Array }
    this._dirty = true;
    this._unsubscribe = [];
  }

  /** Turns batching on/off, restoring plain per-mesh rendering when off. */
  setEnabled(enabled) {
    const next = !!enabled;
    if (next === this.enabled) return;
    this.enabled = next;
    if (next) {
      this._dirty = true;
      const invalidate = () => this.invalidate();
      this._unsubscribe = [
        this.engine.on("hierarchy-changed", invalidate),
        this.engine.on("component-changed", (event) => {
          // Only mesh-shape changes can move an entity between groups; a
          // transform edit is handled by the per-frame matrix sync.
          if (event?.componentType === "mesh" || event?.componentType === "model") invalidate();
        }),
        this.engine.on("play-changed", invalidate),
      ];
    } else {
      for (const off of this._unsubscribe) off();
      this._unsubscribe = [];
      this.#teardown();
    }
  }

  /** Marks the grouping stale; the next `sync()` rebuilds it. */
  invalidate() {
    this._dirty = true;
  }

  /**
   * Per-frame entry point. Rebuilds the grouping when stale, then pushes the
   * world matrix of any member that moved into its batch.
   */
  sync() {
    if (!this.enabled) return;
    // Nothing batched and nothing to regroup: cost nothing on scenes this
    // system has no work to do for.
    if (!this._dirty && this.batches.length === 0) return;
    // Instance matrices are member world matrices, and the renderer only
    // refreshes those later in the frame — so bring the graph up to date here
    // or every batch renders one frame behind its entities.
    this.engine.scene.updateMatrixWorld();
    if (this._dirty) {
      this._dirty = false;
      this.#rebuild();
    }
    for (const batch of this.batches) this.#syncMatrices(batch);
  }

  /* ---------------------------------------------------------------------- */

  /** Every mesh eligible to be batched, keyed by what has to match to share a draw. */
  #collectGroups() {
    const groups = new Map(); // key -> Mesh[]
    const modeFlag = this.engine.playing ? "enabledInGame" : "enabledInEditor";
    for (const entity of this.engine.entities.values()) {
      const component = entity.components.get("mesh");
      const mesh = component?.mesh;
      if (!mesh || !component.enabled) continue;
      if (mesh.userData.noBatch) continue;
      // A material with nothing wired to Surface/Volume renders nothing; the
      // component signals that by hiding its own mesh.
      if (component.materialRenderable === false) continue;
      // Deliberately NOT `mesh.visible`: a batched member is hidden by this
      // very system, so its own flag says nothing about whether it should draw.
      if (!entityVisible(entity, modeFlag)) continue;
      // Multi-material meshes draw once per group; instancing them would need
      // one InstancedMesh per group and is not worth the complexity here.
      if (Array.isArray(mesh.material)) continue;
      const { geometry, material } = mesh;
      if (!geometry || !material) continue;
      if (geometry.morphAttributes && Object.keys(geometry.morphAttributes).length) continue;
      if (EXCLUSIVE_COMPONENTS.some((type) => entity.components.has(type))) continue;

      const key = `${geometry.uuid}|${material.uuid}|${mesh.castShadow ? 1 : 0}${
        mesh.receiveShadow ? 1 : 0
      }|${mesh.layers.mask}|${mesh.renderOrder}`;
      const list = groups.get(key);
      if (list) list.push(mesh);
      else groups.set(key, [mesh]);
    }
    return groups;
  }

  #rebuild() {
    const groups = this.#collectGroups();
    this.#teardown();
    for (const [key, members] of groups) {
      if (members.length < MIN_GROUP_SIZE) continue;
      const template = members[0];
      const instanced = new THREE.InstancedMesh(
        template.geometry,
        template.material,
        members.length,
      );
      instanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      instanced.castShadow = template.castShadow;
      instanced.receiveShadow = template.receiveShadow;
      instanced.layers.mask = template.layers.mask;
      instanced.renderOrder = template.renderOrder;
      instanced.name = `Batch(${members.length})`;
      // Instance matrices are absolute world matrices, so the proxy itself must
      // contribute no transform of its own.
      instanced.matrixAutoUpdate = false;
      // Picking must resolve to the real per-entity mesh, never to the proxy.
      instanced.raycast = () => {};
      instanced.userData.batchProxy = true;
      instanced.userData.engineOwned = true;

      const cache = new Float32Array(members.length * 16);
      for (let i = 0; i < members.length; i++) {
        const member = members[i];
        instanced.setMatrixAt(i, member.matrixWorld);
        cache.set(member.matrixWorld.elements, i * 16);
        member.visible = false;
        member.userData.batchedInto = instanced;
      }
      instanced.instanceMatrix.needsUpdate = true;
      instanced.computeBoundingSphere();
      this.engine.scene.add(instanced);
      this.batches.push({ key, mesh: instanced, members, cache });
    }
  }

  /** Rewrites the instance matrix of every member whose world transform moved. */
  #syncMatrices(batch) {
    const { mesh, members, cache } = batch;
    let moved = false;
    for (let i = 0; i < members.length; i++) {
      const elements = members[i].matrixWorld.elements;
      const at = i * 16;
      let same = true;
      for (let e = 0; e < 16; e++) {
        if (cache[at + e] !== elements[e]) {
          same = false;
          break;
        }
      }
      if (same) continue;
      cache.set(elements, at);
      mesh.setMatrixAt(i, members[i].matrixWorld);
      moved = true;
    }
    if (!moved) return;
    mesh.instanceMatrix.needsUpdate = true;
    // The batch is culled as one object, so its bound has to follow its members.
    mesh.computeBoundingSphere();
  }

  /**
   * Removes every batch proxy and hands the member meshes back their own
   * visibility. Restoring a blanket `true` would be wrong: a member whose
   * component was disabled (or whose material stopped being renderable) while
   * it was batched must stay hidden, and that is precisely the change that
   * triggered the rebuild.
   */
  #teardown() {
    for (const batch of this.batches) {
      for (const member of batch.members) {
        member.userData.batchedInto = null;
        const component = this.engine.entities
          .get(member.userData.entityId)
          ?.components.get("mesh");
        member.visible = component
          ? component.enabled && component.materialRenderable !== false
          : true;
      }
      this.engine.scene.remove(batch.mesh);
      // The geometry and material are the shared originals — the proxy owns
      // neither, so only its own per-instance buffers are released.
      batch.mesh.dispose();
    }
    this.batches.length = 0;
  }

  /** Number of draw calls saved by the current grouping (for the stats overlay). */
  get savedDrawCalls() {
    let saved = 0;
    for (const batch of this.batches) saved += batch.members.length - 1;
    return saved;
  }

  dispose() {
    this.setEnabled(false);
  }
}
