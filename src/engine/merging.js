// @ts-check
import * as THREE from "three/webgpu";
import { OCCLUDER_LAYER } from "./editorLayers.js";
import { buildUberMaterial, isUberCompatible, slotSignature } from "./uberMaterial.js";

/**
 * Automatic static MERGING — the case instancing cannot reach.
 *
 * `batching.js` collapses meshes that repeat: same geometry, same material, many
 * transforms, one `InstancedMesh`. That is the right answer for a scene built by
 * dropping one crate a thousand times, and it is worth exactly nothing on an
 * imported environment, where every mesh is unique. Sponza is the canonical
 * shape of the problem: 26 meshes, 26 geometries, 26 materials, no repetition at
 * all, and 26 draw calls in every pass that touches it — main colour, depth
 * prepass, shadow map — for 78 of a 90-call frame.
 *
 * Those 26 materials are not 26 different SHADERS, though. They are one shader
 * with 26 rows of data: `applyStockPbr` already expresses each as plain colour /
 * roughness / metalness / map / normalMap, so what separates two draws is which
 * texture is bound. So this concatenates their geometry into one buffer, tags
 * every vertex with which row it came from, and draws the lot with the single
 * table-driven material `uberMaterial.js` builds.
 *
 * Merging is not free and this file is mostly about what it refuses to do.
 *
 * ## Frustum culling
 *
 * A merged proxy is culled as one object, so merging can trade draw calls for
 * triangles. On the scene this was built for it costs nothing: each Sponza mesh
 * is one MATERIAL's worth of surface scattered across the whole atrium, so its
 * bounding sphere already covers the model and no camera has ever culled one.
 * Where that is not true — props spread over a landscape — merging them into one
 * blob would submit the whole landscape every frame. `MAX_MERGE_RADIUS_RATIO`
 * is the guard: a group whose merged bound is much larger than its members'
 * typical bound is refusing a real cull, and is left alone.
 *
 * ## Motion
 *
 * Merging BAKES world transforms into the vertex buffer, so a member that moves
 * would drag its geometry behind it. Instancing can afford movers (rewrite one
 * matrix); merging cannot (rewrite the mesh). Rather than ask the author to
 * label things static, this watches: a member whose world matrix changes is
 * marked unstable, permanently for the session, and the group rebuilds without
 * it. A crate that gets shoved once is never merged again.
 *
 * ## What sees what
 *
 * Members are hidden with `mesh.visible = false` and left in the scene graph —
 * the same protocol `batching.js` uses, and for its reasons: three's Raycaster
 * tests `layers` and never `visible`, so editor picking, bounds and the
 * selection outline keep resolving to the real per-entity meshes, while the
 * proxy opts out of raycasting so a click never lands on it. The renderer skips
 * an invisible object during scene projection, so a hidden member costs nothing
 * in any pass — including the occluder pass, which renders by layer.
 *
 * ⚠ THE ONE THING THAT DOES CHANGE: the GI module builds its albedo atlas by
 * reading `material.map` on the CPU (`bvh/bvhScene.js buildAlbedoAtlas`). An
 * uber material has no `.map` — its colour lives in a texture array the CPU side
 * cannot index — so a merged surface contributes its group's AVERAGE tint to
 * GI's BVH reflection albedo instead of its own texture. Direct lighting, shadows
 * and the voxel field are unaffected. That is why this system is OFF by default:
 * `settings.performance.staticMerging`.
 */

/** Fewer members than this and the bookkeeping outweighs the saved draws. */
const MIN_GROUP_SIZE = 3;

/**
 * A group is abandoned when merging it would inflate the culling bound by more
 * than this factor over the members' own mean radius. 6x lets a building's
 * worth of surfaces merge (their bounds already overlap) and stops a group of
 * scattered props from becoming one scene-sized object.
 */
const MAX_MERGE_RADIUS_RATIO = 6;

/**
 * Ceiling on the texture memory ONE group's arrays may allocate, in bytes.
 *
 * A merged group copies every source texture into an array, so the arrays are
 * pure addition — the originals stay resident for the hidden members' materials
 * and for anything else in the project that shares them. That bill is easy to
 * underestimate and expensive to get wrong: on the scene this was developed
 * against, merging added ~290 MB of texture memory and the D3D12 device was
 * subsequently lost with DXGI_ERROR_DEVICE_HUNG while allocating a buffer.
 *
 * The ratio is what makes a budget the right shape rather than a flat cap. A
 * group of three 2048² materials costs ~90 MB to save two draw calls; a group of
 * twenty 1024² ones costs ~110 MB to save nineteen. Same order of memory, an
 * order of magnitude apart in value — so the test below is per-draw-saved, and
 * this is the ceiling on the whole group as a backstop.
 */
const MAX_GROUP_TEXTURE_BYTES = 192 * 1024 * 1024;

/** Refuse a group that spends more than this much texture memory per draw call saved. */
const MAX_BYTES_PER_DRAW_SAVED = 24 * 1024 * 1024;

/**
 * Floor on the gap between rebuilds, in milliseconds.
 *
 * ⚠ THIS IS NOT A MICRO-OPTIMISATION, IT IS A CRASH FIX. Merging subscribes to
 * `hierarchy-changed`, and in PLAY MODE that fires constantly — a script
 * spawning a projectile, a pool recycling one. `batching.js` shares the
 * subscription and can afford it, because its rebuild is scene-graph
 * bookkeeping. This system's rebuild rasterises every source texture into a new
 * array, so an unthrottled invalidation storm allocates the group's entire
 * texture footprint per frame: measured at 351 ms CPU frames, a 6 GB JS heap and
 * 3 fps on the scene this was developed against, from ~160 MB of arrays being
 * rebuilt about forty times.
 *
 * The throttle is the backstop. The real fix is `_uberCache` below, which makes
 * a rebuild that changed no materials cost nothing — a spawned cannonball has no
 * bearing on Sponza's twenty stone materials, and it should not cost a single
 * texture decode to prove it.
 */
const MIN_REBUILD_INTERVAL_MS = 250;

/**
 * Ceiling on the texture memory held by CACHED-but-unused uber materials.
 *
 * Budgeted in bytes rather than entries, because entries are not the unit that
 * hurts. An eight-entry cache sounds small and is 1.3 GB when each entry owns
 * 160 MB of texture arrays: play-mode texture memory was measured climbing
 * 613 → 741 → 869 MB in twenty seconds, one cache miss at a time, on the way to
 * a second device loss.
 */
const MAX_CACHED_TEXTURE_BYTES = 128 * 1024 * 1024;

/** Components that own their entity's mesh in ways a baked vertex buffer cannot represent. */
const EXCLUSIVE_COMPONENTS = [
  "skinnedmesh",
  "terrain",
  "geometryModifiers",
  "rigidbody",
  "lodgroup",
  "impostor",
  "splinemesh",
  "instancer",
];

/** Attributes carried through a merge. Anything else on a source geometry is dropped. */
const MERGED_ATTRIBUTES = ["position", "normal", "uv", "uv1"];

/**
 * Everything about a material that the bake copied rather than referenced.
 * Two materials with the same signature produce a byte-identical merge, so a
 * change to any of it is a rebuild.
 */
function materialSignature(material) {
  return [
    material.map?.uuid ?? "-",
    material.map?.version ?? -1,
    material.normalMap?.uuid ?? "-",
    material.normalMap?.version ?? -1,
    material.color?.getHex() ?? -1,
    material.roughness,
    material.metalness,
    material.normalScale?.x ?? 1,
  ].join("|");
}

/**
 * GPU bytes the arrays for `materials` would allocate — the price of merging
 * them, payable before a single one is built.
 *
 * `4/3` is the mip chain: a full pyramid adds a third again over the base level.
 * Layers are counted per DISTINCT texture plus one neutral fill, matching what
 * `buildLayeredTexture` actually stacks.
 */
function arrayTextureBytes(materials) {
  let total = 0;
  for (const slot of ["map", "normalMap"]) {
    const distinct = new Set();
    for (const material of materials) {
      if (material[slot]) distinct.add(material[slot]);
    }
    if (!distinct.size) continue;
    const first = /** @type {any} */ ([...distinct][0]);
    const width = first.image?.width ?? 0;
    const height = first.image?.height ?? 0;
    total += width * height * 4 * (distinct.size + 1) * (4 / 3);
  }
  return total;
}

/** True when `entity` and every ancestor are enabled for the current mode. */
function entityVisible(entity, modeFlag) {
  for (let node = entity; node; node = node.parent) {
    if (node[modeFlag] === false) return false;
    if (node.object3D.visible === false) return false;
  }
  return true;
}

export class MergeSystem {
  constructor(engine) {
    this.engine = engine;
    this.enabled = false;
    /** @type {any[]} */
    this.groups = [];
    this._dirty = true;
    this._unsubscribe = [];
    /** Entities observed to move. Never merged again this session. */
    this._unstable = new Set();
    this._building = false;
    /** Built uber materials by material-set key — see MIN_REBUILD_INTERVAL_MS. */
    this._uberCache = new Map();
    this._lastRebuildAt = -Infinity;
    this._rebuildCount = 0;
    /** Set when the CURRENT frame is already wrong — bypasses the throttle. */
    this._urgent = true;
  }

  setEnabled(enabled) {
    const next = !!enabled;
    if (next === this.enabled) return;
    this.enabled = next;
    if (next) {
      this._dirty = true;
      // Turning the system on must take effect now, not at the next tick the
      // throttle happens to allow.
      this._urgent = true;
      // ⚠ WHILE PLAYING, THE MERGE IS FROZEN. Entering play rebuilds once; after
      // that, `hierarchy-changed` and `component-changed` are ignored until play
      // ends. This is not a workaround, it is what "static merging" means — every
      // engine bakes it at load and leaves it alone. Reacting to a running game's
      // scene graph is both wrong (a spawned projectile has no bearing on which
      // walls share a material) and ruinous: each rebuild that misses the cache
      // allocates the group's whole texture footprint again, which is how a
      // cannonball script turned into 351 ms frames and a 6 GB heap.
      const invalidate = () => {
        if (this.engine.playing) return;
        this.invalidate();
      };
      this._unsubscribe = [
        this.engine.on("hierarchy-changed", invalidate),
        this.engine.on("component-changed", (event) => {
          if (event?.componentType === "mesh" || event?.componentType === "model") invalidate();
        }),
        // NOT filtered: entering and leaving play is exactly when the merge set
        // legitimately changes (per-mode enable flags), and it happens twice.
        this.engine.on("play-changed", () => this.invalidate()),
      ];
    } else {
      for (const off of this._unsubscribe) off();
      this._unsubscribe = [];
      this.#teardown();
      this.#clearCache();
    }
  }

  /** Releases every cached uber material and the texture arrays it owns. */
  #clearCache() {
    for (const entry of this._uberCache.values()) entry.dispose();
    this._uberCache.clear();
  }

  invalidate() {
    this._dirty = true;
  }

  /**
   * Per-frame entry point, called from the same place `batching.sync()` is so
   * both agree with the scene graph before any pass reads it.
   */
  sync() {
    if (!this.enabled || this._building) return;
    if (!this._dirty && this.groups.length === 0) return;
    if (this._dirty) {
      // Stay dirty and come back: an invalidation storm must cost one rebuild
      // per interval, not one per frame. See MIN_REBUILD_INTERVAL_MS. The first
      // build is never delayed — the scene would draw unmerged until the
      // timer elapsed, which is a visible pop for no benefit.
      const now = performance.now();
      const throttled =
        this._rebuildCount > 0 && now - this._lastRebuildAt < MIN_REBUILD_INTERVAL_MS;
      // URGENT REBUILDS ARE NEVER THROTTLED, and the distinction is the whole
      // reason for the flag. The throttle exists for `hierarchy-changed`, whose
      // storms are unbounded and whose contents (a spawned projectile) have
      // nothing to do with what is merged. A member that MOVED, or a material
      // that was EDITED, is different in kind: the proxy on screen is already
      // showing the wrong thing, and holding that for a quarter second to save
      // a rebuild the cache has made cheap would trade a real artifact for
      // nothing. Both are self-limiting anyway — a mover is marked unstable and
      // never merged again, an edit lands once.
      if (throttled && !this._urgent) return;
      this._urgent = false;
      this._lastRebuildAt = now;
      this._rebuildCount++;
      this._dirty = false;
      this.engine.scene.updateMatrixWorld();
      this.#rebuild();
      return;
    }
    if (!this.groups.length) return;
    this.engine.scene.updateMatrixWorld();
    this.#watchForMotion();
    // Materials are authored, not simulated: nothing edits a .mat mid-game, and
    // the check costs a signature per merged material per frame.
    if (!this.engine.playing) this.#watchForMaterialEdits();
  }

  /**
   * Rebuilds when a source material's appearance changed underneath the bake.
   *
   * There is no event for this. `materialAsset.js` notifies subscribers only
   * when a material's IDENTITY or renderability changes, on the stated grounds
   * that "in-place edits mutate the shared instance and need no notification" —
   * true for everyone who reads the live material each frame, and false for this
   * system, which copied its pixels and scalars into an array texture and a
   * uniform buffer. Without this, editing a .mat leaves the viewport showing the
   * old one until something unrelated invalidates the group, and the async
   * texture load that lands one frame after a merge never appears at all.
   *
   * A signature compare over the merged materials is a few dozen property reads
   * per frame — cheaper than the plumbing an event would need, and it cannot
   * miss a mutation nobody thought to announce.
   */
  #watchForMaterialEdits() {
    for (const group of this.groups) {
      for (let i = 0; i < group.materials.length; i++) {
        if (materialSignature(group.materials[i]) === group.signatures[i]) continue;
        this._dirty = true;
        this._urgent = true;
        return;
      }
    }
  }

  /**
   * A merged member that moved invalidates its whole group — the movement is
   * already baked out of the vertex buffer, so the frame it is noticed the
   * proxy is showing that member in its old place. Marking it unstable and
   * rebuilding restores it as an ordinary mesh and never merges it again.
   */
  #watchForMotion() {
    let moved = false;
    for (const group of this.groups) {
      for (let i = 0; i < group.members.length; i++) {
        const elements = group.members[i].mesh.matrixWorld.elements;
        const cached = group.matrices[i];
        for (let e = 0; e < 16; e++) {
          if (cached[e] === elements[e]) continue;
          this._unstable.add(group.members[i].entityId);
          moved = true;
          break;
        }
      }
    }
    if (moved) {
      this._dirty = true;
      this._urgent = true;
    }
  }

  /* ---------------------------------------------------------------------- */

  /**
   * Everything eligible, keyed by what has to agree for one draw to stand in
   * for all of them.
   *
   * The key deliberately EXCLUDES `OCCLUDER_LAYER`. That bit is written by the
   * occlusion system from a bounding-sphere test, so folding it into the key
   * would split a group by a property that is not about how the group draws —
   * the same trap `batching.js` documents. The proxy is tagged instead, exactly
   * as batch proxies are.
   */
  #collectGroups() {
    const groups = new Map();
    const modeFlag = this.engine.playing ? "enabledInGame" : "enabledInEditor";
    for (const entity of this.engine.entities.values()) {
      if (this._unstable.has(entity.id)) continue;
      const component = entity.components.get("mesh");
      const mesh = component?.mesh;
      if (!mesh || !component.enabled) continue;
      if (mesh.userData.noBatch || mesh.userData.noMerge) continue;
      if (component.materialRenderable === false) continue;
      if (!entityVisible(entity, modeFlag)) continue;
      if (Array.isArray(mesh.material)) continue;
      if (mesh.userData.batchedInto) continue;
      const { geometry, material } = mesh;
      if (!geometry || !material) continue;
      if (geometry.morphAttributes && Object.keys(geometry.morphAttributes).length) continue;
      if (!geometry.attributes?.position) continue;
      if (EXCLUSIVE_COMPONENTS.some((type) => entity.components.has(type))) continue;
      if (!isUberCompatible(material)) continue;

      const colorSignature = slotSignature(material.map);
      const normalSignature = slotSignature(material.normalMap);
      if (colorSignature === "unreadable" || normalSignature === "unreadable") continue;

      // Scalars that the uber material does NOT carry per row: a difference
      // here would change the look, so it splits the group instead.
      const key = [
        material.type,
        material.transparent ? 1 : 0,
        material.side,
        material.alphaTest,
        material.blending,
        material.depthTest ? 1 : 0,
        material.depthWrite ? 1 : 0,
        material.toneMapped ? 1 : 0,
        material.fog ? 1 : 0,
        material.wireframe ? 1 : 0,
        material.ior,
        material.specularIntensity,
        material.specularColor?.getHex() ?? -1,
        mesh.castShadow ? 1 : 0,
        mesh.receiveShadow ? 1 : 0,
        (mesh.layers.mask >>> 0) & ~(1 << OCCLUDER_LAYER),
        mesh.renderOrder,
        // An empty slot (null signature) is compatible with any size, so it is
        // not part of the key — `#splitBySlotSize` resolves those afterwards.
        colorSignature ?? "*",
        normalSignature ?? "*",
      ].join("|");
      const list = groups.get(key);
      const record = { entityId: entity.id, mesh, material, colorSignature, normalSignature };
      if (list) list.push(record);
      else groups.set(key, [record]);
    }
    return [...groups.values()];
  }

  /**
   * Folds a group with no COLOUR map into one that has colour maps of a single
   * size: an untextured material samples the neutral white layer and shades
   * identically, so keeping it in its own draw buys nothing.
   *
   * ⚠ THE NORMAL SLOT IS DELIBERATELY NOT FOLDED, and the reason is a measured
   * regression rather than caution. A material with no normal map compiles a
   * shader with no normal mapping in it; fold it into a normal-mapped group and
   * it starts paying for a texture fetch AND — because merged geometry carries
   * no tangents — three's derivative-based tangent frame, per fragment, forever.
   * On Sponza that folds fourteen untextured-normal materials into the expensive
   * shader to save ONE draw call, and this scene's frame is fragment-bound, not
   * draw-bound. Merging must not make the shader more expensive than the
   * materials it replaced.
   *
   * Wildcards fold into the LARGEST eligible group so the fewest draws survive.
   */
  #foldWildcards(groups) {
    const hosts = groups.filter((g) => g[0].colorSignature).sort((a, b) => b.length - a.length);
    const rest = [];
    for (const group of groups) {
      if (group[0].colorSignature) continue;
      const host = hosts.find(
        (candidate) =>
          candidate[0].normalSignature === group[0].normalSignature &&
          // Only the colour signature may differ; everything else in the key
          // already matched or these would not both be here.
          candidate[0].mesh.material.side === group[0].mesh.material.side,
      );
      if (host) host.push(...group);
      else rest.push(group);
    }
    return [...hosts, ...rest].filter((g) => g.length);
  }

  #rebuild() {
    this.#teardown();
    this._building = true;
    try {
      for (const members of this.#foldWildcards(this.#collectGroups())) {
        if (members.length < MIN_GROUP_SIZE) continue;
        const group = this.#buildGroup(members);
        if (group) this.groups.push(group);
      }
    } finally {
      this._building = false;
    }
  }

  /**
   * The uber material for `materials`, built once and kept.
   *
   * Keyed on the material set AND each material's appearance signature, so the
   * cache can only ever hand back something pixel-identical to what a fresh
   * build would produce — edit a .mat and the signature moves, missing the
   * cache and rebuilding. What it removes is the case that actually happens
   * every frame in play mode: a rebuild triggered by something that has nothing
   * to do with these materials, which used to re-decode every texture.
   *
   * @returns {any | null}
   */
  #uberFor(materials) {
    const key = materials.map((m) => `${m.uuid}@${materialSignature(m)}`).join("|");
    const cached = this._uberCache.get(key);
    if (cached) {
      // Re-insert so the eviction below is least-recently-USED, not
      // least-recently-built: the groups a scene rebuilds are the ones it keeps.
      this._uberCache.delete(key);
      this._uberCache.set(key, cached);
      return cached;
    }
    const built = buildUberMaterial(materials, materials[0]);
    if (!built) return null;
    built.bytes = arrayTextureBytes(materials);
    this._uberCache.set(key, built);
    // Never evict something a group is drawing with. A rebuild tears down and
    // repopulates `groups` one at a time, so mid-rebuild this set is the groups
    // already rebuilt — exactly the ones that must survive.
    const live = new Set(this.groups.map((group) => group.built));
    let idle = 0;
    for (const entry of this._uberCache.values()) {
      if (entry !== built && !live.has(entry)) idle += entry.bytes ?? 0;
    }
    for (const [oldest, entry] of this._uberCache) {
      if (idle <= MAX_CACHED_TEXTURE_BYTES) break;
      if (entry === built || live.has(entry)) continue;
      this._uberCache.delete(oldest);
      idle -= entry.bytes ?? 0;
      entry.dispose();
    }
    return built;
  }

  /** @returns {any | null} */
  #buildGroup(members) {
    // One row per DISTINCT material: two meshes sharing a material share a row.
    const materials = [];
    const rowOf = new Map();
    for (const member of members) {
      if (rowOf.has(member.material)) continue;
      rowOf.set(member.material, materials.length);
      materials.push(member.material);
    }

    // Priced BEFORE anything is allocated. See MAX_GROUP_TEXTURE_BYTES: the
    // arrays are additional memory, not a replacement, and a group can cost
    // hundreds of megabytes to save two draw calls.
    const bytes = arrayTextureBytes(materials);
    const saved = members.length - 1;
    if (bytes > MAX_GROUP_TEXTURE_BYTES || bytes > saved * MAX_BYTES_PER_DRAW_SAVED) {
      console.warn(
        `[merging] skipped a group of ${members.length} meshes: its texture arrays would cost ` +
          `${(bytes / 1048576).toFixed(0)} MB to save ${saved} draw call${saved === 1 ? "" : "s"}.`,
      );
      return null;
    }

    const geometry = mergeGeometries(members, rowOf);
    if (!geometry) return null;
    geometry.computeBoundingSphere();

    // Would merging refuse a cull the scene is currently getting? Compare the
    // merged bound against the members' own — see MAX_MERGE_RADIUS_RATIO.
    let meanRadius = 0;
    for (const member of members) {
      if (!member.mesh.geometry.boundingSphere) member.mesh.geometry.computeBoundingSphere();
      const scale = member.mesh.matrixWorld.getMaxScaleOnAxis();
      meanRadius += (member.mesh.geometry.boundingSphere?.radius ?? 0) * scale;
    }
    meanRadius /= members.length;
    const mergedRadius = geometry.boundingSphere?.radius ?? 0;
    if (meanRadius > 0 && mergedRadius > meanRadius * MAX_MERGE_RADIUS_RATIO) {
      geometry.dispose();
      return null;
    }

    const built = this.#uberFor(materials);
    if (!built) {
      geometry.dispose();
      return null;
    }

    const template = members[0].mesh;
    const proxy = new THREE.Mesh(geometry, built.material);
    proxy.name = `Merged(${members.length})`;
    proxy.castShadow = template.castShadow;
    proxy.receiveShadow = template.receiveShadow;
    proxy.renderOrder = template.renderOrder;
    proxy.layers.mask = (template.layers.mask >>> 0) & ~(1 << OCCLUDER_LAYER);
    // Vertices are already in world space, so the proxy must add no transform.
    proxy.matrixAutoUpdate = false;
    proxy.raycast = () => {};
    proxy.userData.batchProxy = true;
    proxy.userData.mergeProxy = true;
    proxy.userData.engineOwned = true;
    this.engine.scene.add(proxy);

    const matrices = [];
    for (const member of members) {
      matrices.push(Float64Array.from(member.mesh.matrixWorld.elements));
      member.mesh.userData.mergedInto = proxy;
      member.mesh.visible = false;
    }
    return {
      members,
      matrices,
      materials,
      signatures: materials.map(materialSignature),
      mesh: proxy,
      // Reported by `profile.drawCalls`. A merged group's whole case is a
      // ratio — draws removed against megabytes spent — and neither number is
      // visible from outside without carrying it here.
      textureBytes: bytes,
      // The CACHE owns the uber material and its texture arrays, not the group
      // — that is the whole point of `#uberFor`. Held here only so eviction can
      // tell a live entry from a stale one.
      built,
    };
  }

  #teardown() {
    for (const group of this.groups) {
      for (const member of group.members) {
        const mesh = member.mesh;
        if (!mesh.userData.mergedInto) continue;
        mesh.userData.mergedInto = null;
        // NOT a blanket `true`: a member whose component was disabled (or whose
        // material stopped being renderable) while it was merged must stay
        // hidden — and that is exactly the change that triggered this rebuild.
        const component = this.engine.entities.get(mesh.userData.entityId)?.components.get("mesh");
        mesh.visible = component
          ? component.enabled && component.materialRenderable !== false
          : true;
      }
      this.engine.scene.remove(group.mesh);
      // The merged geometry IS this group's own — dispose it. The material is
      // the cache's, and disposing it here is what made every rebuild re-decode
      // every texture; see MIN_REBUILD_INTERVAL_MS.
      group.mesh.geometry.dispose();
    }
    this.groups.length = 0;
  }

  /** Draw calls this grouping removed, for the stats overlay. */
  get savedDrawCalls() {
    let saved = 0;
    for (const group of this.groups) saved += group.members.length - 1;
    return saved;
  }

  dispose() {
    this.setEnabled(false);
  }
}

/**
 * Concatenates every member's geometry into one buffer, in world space, with a
 * `materialIndex` attribute naming the row each vertex shades with.
 *
 * Positions and normals are transformed here rather than left local because the
 * proxy carries no transform: a merged group has as many source transforms as it
 * has members and one object to hang them on.
 */
function mergeGeometries(members, rowOf) {
  let vertexCount = 0;
  let indexCount = 0;
  for (const member of members) {
    const geometry = member.mesh.geometry;
    const position = geometry.attributes.position;
    vertexCount += position.count;
    indexCount += geometry.index ? geometry.index.count : position.count;
  }
  if (!vertexCount || vertexCount > 0x7fffffff) return null;

  const present = new Set(MERGED_ATTRIBUTES);
  for (const name of MERGED_ATTRIBUTES) {
    // An attribute only survives if EVERY member has it — a half-filled uv
    // channel shades half the merge with garbage.
    for (const member of members) {
      if (!member.mesh.geometry.attributes[name]) {
        present.delete(name);
        break;
      }
    }
  }
  if (!present.has("position")) return null;

  const merged = new THREE.BufferGeometry();
  const buffers = {};
  for (const name of present) {
    const itemSize = members[0].mesh.geometry.attributes[name].itemSize;
    buffers[name] = { array: new Float32Array(vertexCount * itemSize), itemSize };
  }
  const rows = new Float32Array(vertexCount);
  const indices = vertexCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);

  const vector = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();
  let vertexAt = 0;
  let indexAt = 0;
  for (const member of members) {
    const geometry = member.mesh.geometry;
    const matrix = member.mesh.matrixWorld;
    normalMatrix.getNormalMatrix(matrix);
    const position = geometry.attributes.position;
    const row = rowOf.get(member.material) ?? 0;

    for (const name of present) {
      const source = geometry.attributes[name];
      const target = buffers[name];
      if (name === "position") {
        for (let i = 0; i < source.count; i++) {
          vector.fromBufferAttribute(source, i).applyMatrix4(matrix);
          target.array[(vertexAt + i) * 3] = vector.x;
          target.array[(vertexAt + i) * 3 + 1] = vector.y;
          target.array[(vertexAt + i) * 3 + 2] = vector.z;
        }
      } else if (name === "normal") {
        for (let i = 0; i < source.count; i++) {
          vector.fromBufferAttribute(source, i).applyMatrix3(normalMatrix).normalize();
          target.array[(vertexAt + i) * 3] = vector.x;
          target.array[(vertexAt + i) * 3 + 1] = vector.y;
          target.array[(vertexAt + i) * 3 + 2] = vector.z;
        }
      } else {
        const size = target.itemSize;
        for (let i = 0; i < source.count; i++) {
          for (let c = 0; c < size; c++) {
            target.array[(vertexAt + i) * size + c] = source.getComponent(i, c);
          }
        }
      }
    }
    rows.fill(row, vertexAt, vertexAt + position.count);

    if (geometry.index) {
      const source = geometry.index;
      for (let i = 0; i < source.count; i++) indices[indexAt + i] = source.getX(i) + vertexAt;
      indexAt += source.count;
    } else {
      for (let i = 0; i < position.count; i++) indices[indexAt + i] = vertexAt + i;
      indexAt += position.count;
    }
    vertexAt += position.count;
  }

  for (const name of present) {
    merged.setAttribute(name, new THREE.BufferAttribute(buffers[name].array, buffers[name].itemSize));
  }
  merged.setAttribute("materialIndex", new THREE.BufferAttribute(rows, 1));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  return merged;
}
