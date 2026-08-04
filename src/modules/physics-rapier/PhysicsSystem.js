// @ts-check
import * as THREE from "three/webgpu";
import { EDITOR_LAYER } from "../../engine/editorLayers.js";
import { PhysicsLayers } from "./layers.js";

const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 4;
const DEG2RAD = Math.PI / 180;

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _parentQuat = new THREE.Quaternion();
const _mat = new THREE.Matrix4();

/**
 * Owns the Rapier world. Lifecycle mirrors play mode: the world is built
 * from the entity tree when playing starts and freed when it stops (the
 * editor restores its scene snapshot anyway). While playing it steps on a
 * fixed timestep, drives kinematic bodies from entity transforms, writes
 * dynamic body transforms back to entities, and dispatches collision events
 * to script hooks (onCollisionEnter/Exit, onTriggerEnter/Exit).
 *
 * Exposed as `engine.physics` for scripts:
 *   this.engine.physics.raycast(origin, direction, maxDistance) →
 *     { entity, point, normal, distance } | null
 *   this.engine.physics.setGravity([x, y, z])
 */
export class PhysicsSystem {
  constructor(engine, RAPIER) {
    this.engine = engine;
    this.RAPIER = RAPIER;
    this.world = null;
    this.eventQueue = null;
    this.gravity = [0, -9.81, 0];
    this.accumulator = 0;
    this.colliderEntity = new Map(); // collider handle -> entity
    // Layer index per collider handle. Queries filter on this rather than on
    // Rapier's interaction groups — see layers.js for why.
    this.colliderLayer = new Map(); // collider handle -> layer index
    this.dynamicBodies = []; // { entity, body }
    this.kinematicBodies = []; // { entity, body, prev, delta }
    this.characters = []; // { entity, cc } — kinematic character controllers
    this.joints = []; // { entity, joint }
    // entity -> RAPIER.RigidBody. Held on the system rather than being a local
    // of the world build, because entities now arrive after it: a pooled bullet
    // spawned mid-play needs the same three passes the build does, and a child
    // collider added later needs to find its ancestor's body.
    this.bodyByEntity = new Map();
    // Entities whose physics representation is stale (a component attached or
    // detached, an instance spawned). Flushed at the top of `update` and again
    // the moment a spawn completes — see `#flushDirty`.
    this.dirty = new Set();
    // Layer names + collision matrix. The editor writes project settings into
    // `engine.config.physicsLayers`; an exported build gets the same blob from
    // scene.json. `src/engine` stays physics-agnostic — it just carries it.
    this.layers = new PhysicsLayers(engine.config?.physicsLayers);

    this.unsubs = [
      engine.on("play-changed", (playing) => (playing ? this.#build() : this.#teardown())),
      engine.onUpdate((dt) => this.update(dt)),
      // A spawn is announced once its subtree is complete AND placed. Both
      // halves matter: a body built while the subtree was half-expanded has no
      // ancestor to attach a child collider to, and one built before the spawn
      // position was applied leaves the bullet falling from the muzzle's
      // authored origin. Flushed immediately rather than at the next update, so
      // a script's `onStart` can set a velocity on the thing it just spawned.
      engine.on("entity-spawned", (entity) => {
        this.markDirty(entity);
        this.sync();
      }),
      // A pooled entity is parked, not destroyed: its components stay attached,
      // so nothing else here would ever hear about it. Its body has to go all
      // the same, or the corridor fills with invisible walls where enemies died.
      engine.on("entity-despawned", (entity) => this.removeEntity(entity)),
    ];
    engine.physics = this;
    if (engine.playing) this.#build();
  }

  dispose() {
    for (const unsub of this.unsubs) unsub();
    this.#teardown();
    if (this.engine.physics === this) delete this.engine.physics;
  }

  setGravity([x, y, z]) {
    this.gravity = [x, y, z];
    if (this.world) this.world.gravity = new this.RAPIER.Vector3(x, y, z);
  }

  /** Remove a live character immediately when its component/entity is
   * detached during Play. Keeping this explicit prevents a resumed frame
   * from stepping a component whose public Rapier handles were cleared. */
  unregisterCharacter(cc) {
    const index = this.characters.findIndex((entry) => entry.cc === cc);
    if (index === -1) return;
    const [entry] = this.characters.splice(index, 1);
    this.#removeCharacterEntry(entry);
  }

  /**
   * Replaces the layer names + collision matrix. Applied live: every existing
   * collider's interaction groups are rewritten, so tweaking the matrix in
   * project settings takes effect without restarting Play.
   */
  setLayers(config) {
    this.layers.set(config ?? {});
    if (!this.world) return;
    for (const [handle, layerIndex] of this.colliderLayer) {
      this.world.getCollider(handle)?.setCollisionGroups(this.layers.groupsFor(layerIndex));
    }
  }

  // ---- queries ------------------------------------------------------------
  //
  // Every query takes the same options bag:
  //   layers  — only hit colliders on these layers (names). Omitted = all.
  //             Independent of the collision matrix (see layers.js).
  //   exclude — an entity (or array) whose colliders are ignored. This is the
  //             "don't shoot yourself" argument, and it is the single most
  //             common reason a naive raycast returns the wrong hit.
  //   solid   — treat shapes the origin is already inside as hits (default true)

  /** Builds the `filterPredicate` + exclusion args shared by every query. */
  #filter({ layers = null, exclude = null } = {}) {
    const mask = this.layers.maskFor(layers);
    const excluded = new Set();
    for (const entity of exclude == null ? [] : Array.isArray(exclude) ? exclude : [exclude]) {
      const target = typeof entity === "string" ? this.engine.getEntity(entity) : entity;
      // Excluding an entity excludes its whole subtree: a character's capsule
      // and the weapon model parented under it are one thing to the player.
      target?.traverse?.((e) => excluded.add(e.id));
    }
    const all = mask === 0xffff;
    if (all && !excluded.size) return null;
    return (collider) => {
      const handle = collider.handle;
      if (!all && !(mask & (1 << (this.colliderLayer.get(handle) ?? 0)))) return false;
      if (excluded.size) {
        const entity = this.colliderEntity.get(handle);
        if (entity && excluded.has(entity.id)) return false;
      }
      return true;
    };
  }

  #hitFromRay(ray, hit) {
    const distance = hit.timeOfImpact ?? hit.toi;
    const point = ray.pointAt(distance);
    return {
      entity: this.colliderEntity.get(hit.collider.handle) ?? null,
      point: [point.x, point.y, point.z],
      normal: hit.normal ? [hit.normal.x, hit.normal.y, hit.normal.z] : [0, 0, 0],
      distance,
    };
  }

  /**
   * Closest hit along a world-space ray, or null.
   *
   *     const hit = this.engine.physics.raycast(
   *       muzzle, forward, 100, { layers: ["Enemy", "Ground"], exclude: this.entity });
   */
  raycast(origin, direction, maxDistance = 1000, options = {}) {
    if (!this.world) return null;
    const ray = this.#ray(origin, direction);
    const hit = this.world.castRayAndGetNormal(
      ray, maxDistance, options.solid !== false, undefined, undefined, undefined, undefined, this.#filter(options),
    );
    return hit ? this.#hitFromRay(ray, hit) : null;
  }

  /** Every hit along the ray, nearest first — shotgun pellets, penetration. */
  raycastAll(origin, direction, maxDistance = 1000, options = {}) {
    if (!this.world) return [];
    const ray = this.#ray(origin, direction);
    const hits = [];
    this.world.intersectionsWithRay(
      ray, maxDistance, options.solid !== false,
      (hit) => {
        hits.push(this.#hitFromRay(ray, hit));
        return true; // keep going
      },
      undefined, undefined, undefined, undefined, this.#filter(options),
    );
    return hits.sort((a, b) => a.distance - b.distance);
  }

  /**
   * Sweeps a shape through the world and returns the first thing it would hit
   * — the query a ground check, a melee swing or a dash wants, because unlike
   * a ray it has thickness and cannot slip through a gap the character can't.
   */
  shapecast(shape, origin, direction, maxDistance = 1000, options = {}) {
    if (!this.world) return null;
    const desc = this.#shape(shape);
    if (!desc) return null;
    const dir = _pos.set(direction[0], direction[1], direction[2]).normalize();
    const rot = options.rotation
      ? { x: options.rotation[0], y: options.rotation[1], z: options.rotation[2], w: options.rotation[3] }
      : { x: 0, y: 0, z: 0, w: 1 };
    const hit = this.world.castShape(
      { x: origin[0], y: origin[1], z: origin[2] },
      rot,
      { x: dir.x * maxDistance, y: dir.y * maxDistance, z: dir.z * maxDistance },
      desc,
      0,
      1,
      options.stopAtPenetration !== false,
      undefined, undefined, undefined, undefined, this.#filter(options),
    );
    if (!hit) return null;
    // castShape's velocity is the full sweep, so time_of_impact is 0..1 along
    // it — convert back to world units so callers can compare it to a ray.
    const t = hit.time_of_impact ?? hit.timeOfImpact ?? 0;
    const w = hit.witness1;
    const n = hit.normal1;
    return {
      entity: this.colliderEntity.get(hit.collider.handle) ?? null,
      point: w ? [w.x, w.y, w.z] : [0, 0, 0],
      normal: n ? [n.x, n.y, n.z] : [0, 0, 0],
      distance: t * maxDistance,
    };
  }

  /** `shapecast` with a sphere — the usual ground/ledge probe. */
  spherecast(origin, radius, direction, maxDistance = 1000, options = {}) {
    return this.shapecast({ kind: "sphere", radius }, origin, direction, maxDistance, options);
  }

  /** `shapecast` with a box. `halfExtents` is half the size on each axis. */
  boxcast(origin, halfExtents, direction, maxDistance = 1000, options = {}) {
    return this.shapecast({ kind: "box", halfExtents }, origin, direction, maxDistance, options);
  }

  /** `shapecast` with a capsule (halfHeight excludes the caps, like Rapier). */
  capsulecast(origin, radius, halfHeight, direction, maxDistance = 1000, options = {}) {
    return this.shapecast({ kind: "capsule", radius, halfHeight }, origin, direction, maxDistance, options);
  }

  /**
   * Every entity whose collider overlaps a shape placed at `center`. The
   * explosion-damage / interaction-prompt / "who is in this room" query.
   * Entities are de-duplicated — a compound body counts once.
   */
  overlap(shape, center, options = {}) {
    if (!this.world) return [];
    const desc = this.#shape(shape);
    if (!desc) return [];
    const rot = options.rotation
      ? { x: options.rotation[0], y: options.rotation[1], z: options.rotation[2], w: options.rotation[3] }
      : { x: 0, y: 0, z: 0, w: 1 };
    const found = new Set();
    this.world.intersectionsWithShape(
      { x: center[0], y: center[1], z: center[2] },
      rot,
      desc,
      (collider) => {
        const entity = this.colliderEntity.get(collider.handle);
        if (entity) found.add(entity);
        return true;
      },
      undefined, undefined, undefined, undefined, this.#filter(options),
    );
    return [...found];
  }

  overlapSphere(center, radius, options = {}) {
    return this.overlap({ kind: "sphere", radius }, center, options);
  }

  overlapBox(center, halfExtents, options = {}) {
    return this.overlap({ kind: "box", halfExtents }, center, options);
  }

  overlapCapsule(center, radius, halfHeight, options = {}) {
    return this.overlap({ kind: "capsule", radius, halfHeight }, center, options);
  }

  #ray(origin, direction) {
    const dir = _pos.set(direction[0], direction[1], direction[2]).normalize();
    return new this.RAPIER.Ray(
      { x: origin[0], y: origin[1], z: origin[2] },
      { x: dir.x, y: dir.y, z: dir.z },
    );
  }

  /** Query shapes are built per call — they are tiny and Rapier copies them. */
  #shape(shape) {
    const { RAPIER } = this;
    if (!shape) return null;
    if (typeof shape.radius === "number" && shape.kind === "sphere") return new RAPIER.Ball(shape.radius);
    if (shape.kind === "box") {
      const [x, y, z] = shape.halfExtents ?? [0.5, 0.5, 0.5];
      return new RAPIER.Cuboid(x, y, z);
    }
    if (shape.kind === "capsule") return new RAPIER.Capsule(shape.halfHeight ?? 0.5, shape.radius ?? 0.5);
    console.warn(`physics: unknown query shape "${shape.kind}"`);
    return null;
  }

  // ---- world build ----

  #build() {
    this.#teardown();
    const { RAPIER } = this;
    this.world = new RAPIER.World({ x: this.gravity[0], y: this.gravity[1], z: this.gravity[2] });
    this.eventQueue = new RAPIER.EventQueue(true);
    this.engine.scene.updateMatrixWorld(true);

    const entities = [...this.engine.entities.values()];
    // Three passes, and the order is the whole reason they are separate: a
    // collider needs its (possibly ancestral) body to exist, and a joint needs
    // the bodies at BOTH of its ends. `#addEntities` runs the same three for a
    // subtree that turns up after the world is already running.
    for (const entity of entities) this.#createBody(entity);
    for (const entity of entities) this.#createColliders(entity);
    this.#applyFallbackMass(entities);
    this.#buildJoints(entities);

    // Scene queries read acceleration structures that `step` maintains, so a
    // world that has never stepped answers EVERY raycast with null — including
    // one fired from a script's `onStart`, before the first frame. Prime them
    // with a zero-length step: nothing integrates, but the structures get
    // built. The event queue is passed (not drained) on purpose, so a body
    // that spawns already inside a trigger still reports its enter event on
    // the first real tick.
    this.world.timestep = 0;
    this.world.step(this.eventQueue);
    this.world.timestep = FIXED_DT;
    // Rapier's event queue only holds the LAST step's events, so the priming
    // step's have to be taken out now or the next step drops them — which
    // would silently swallow the enter event for anything that spawns already
    // inside a trigger. Held, not dispatched: scripts have not had their
    // `onStart` yet, and receiving `onTriggerEnter` before `onStart` would be
    // a genuinely confusing order. The first real tick delivers them.
    this._deferredEvents = [];
    this.#drainEvents(this._deferredEvents);
  }

  /**
   * Pass 1 for one entity: a body per entity that has a rigidbody, or a static
   * body per collider-only entity with no rigidbody anywhere above it (compound
   * child colliders attach to the ancestor's body in pass 2).
   */
  #createBody(entity) {
    const { RAPIER } = this;
    // Character controllers own their body + capsule collider exclusively.
    const cc = entity.getComponent("charactercontroller");
    if (cc) {
      this.#buildCharacter(entity, cc);
      return;
    }
    const rb = entity.getComponent("rigidbody");
    const col = entity.getComponent("collider");
    if (!rb && !col) return;
    if (!rb && this.#ancestorBodyEntity(entity)) return;

    entity.object3D.getWorldPosition(_pos);
    entity.object3D.getWorldQuaternion(_quat);
    const type = rb?.props.bodyType ?? "fixed";
    const desc = (
      type === "dynamic" ? RAPIER.RigidBodyDesc.dynamic()
      : type === "kinematic" ? RAPIER.RigidBodyDesc.kinematicPositionBased()
      : RAPIER.RigidBodyDesc.fixed()
    )
      .setTranslation(_pos.x, _pos.y, _pos.z)
      .setRotation({ x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w });
    if (rb && type === "dynamic") {
      desc
        .setLinearDamping(rb.props.linearDamping)
        .setAngularDamping(rb.props.angularDamping)
        .setGravityScale(rb.props.gravityScale)
        .setCcdEnabled(!!rb.props.ccd)
        .enabledRotations(!rb.props.lockRotationX, !rb.props.lockRotationY, !rb.props.lockRotationZ);
    }
    const body = this.world.createRigidBody(desc);
    this.bodyByEntity.set(entity, body);
    if (!rb) return;
    rb.body = body;
    if (type === "dynamic") this.dynamicBodies.push({ entity, body });
    // `prev`/`delta` track how far a kinematic body moved each step, so a
    // character standing on it can be carried along (see #carryVelocity).
    else if (type === "kinematic") {
      this.kinematicBodies.push({ entity, body, prev: [_pos.x, _pos.y, _pos.z], delta: [0, 0, 0] });
    }
  }

  /** Pass 2 for one entity: its collider, on its own body or its ancestor's. */
  #createColliders(entity) {
    if (entity.getComponent("charactercontroller")) return; // owns its own capsule
    const col = entity.getComponent("collider");
    if (!col) return;
    const bodyEntity = this.bodyByEntity.has(entity) ? entity : this.#ancestorBodyEntity(entity);
    const body = bodyEntity ? this.bodyByEntity.get(bodyEntity) : null;
    if (!body) return;
    const desc = this.#colliderDesc(col, entity, bodyEntity);
    if (!desc) return;
    const collider = this.world.createCollider(desc, body);
    col.collider = collider;
    this.colliderEntity.set(collider.handle, entity);
    this.colliderLayer.set(collider.handle, this.layers.indexOf(col.props.layer));
  }

  /**
   * Pass 3: rescue dynamic bodies that ended up weighing nothing.
   *
   * Mass is set on the COLLIDER descriptor, because that is the only way to get
   * an inertia tensor derived from the actual shape — a body given a bare
   * scalar mass tumbles like a point mass. The cost of that choice is that a
   * dynamic body with no mass-contributing collider has a mass of zero, and
   * Rapier applies gravity as a FORCE of `mass × g`: zero mass is zero force,
   * and an inverse mass of zero also swallows every `applyForce` and
   * `applyImpulse`. So the body sits in mid-air, perfectly still, ignoring
   * everything — while the Inspector goes on reading "Mass: 1".
   *
   * It is reached more easily than it looks: add a Rigidbody and press Play
   * before adding the Collider, remove a collider at runtime, or leave a body
   * whose only collider is a trigger. Falling back here rather than predicting
   * it in pass 1 means the question is asked of the world after the colliders
   * are actually in it, so it cannot disagree with them.
   */
  #applyFallbackMass(entities) {
    for (const entity of entities) {
      const body = this.bodyByEntity.get(entity);
      if (!body || !body.isDynamic() || body.mass() > 0) continue;
      const mass = entity.getComponent("rigidbody")?.props.mass;
      // `false`: nothing is asleep yet at build time, and waking a body here
      // would be a side effect of measuring it.
      body.setAdditionalMass(mass > 0 ? mass : 1, false);
    }
  }

  // ---- runtime registration ------------------------------------------------
  //
  // The world used to be built exactly once, from the entity tree, at Play.
  // Anything spawned afterwards — the bullet, the enemy, the pooled effect —
  // therefore had a Rigidbody component whose `body` stayed null forever: it
  // never fell, never collided, and nothing said so. The mirror was as bad:
  // destroying an entity mid-play left its collider in the world, so a corridor
  // slowly filled with invisible walls where enemies had died.

  /**
   * Marks an entity's physics representation stale. Cheap and idempotent —
   * components call it from `onAttach`, and the actual rebuild happens once per
   * flush no matter how many components on one entity ask for it.
   *
   * `subtree` defaults to true because the reason to rebuild is almost always
   * structural: a rigidbody appearing above a child collider changes which body
   * that collider belongs to, and the child has no way to know.
   */
  markDirty(entity, { subtree = true } = {}) {
    if (!entity) return;
    if (subtree) entity.traverse((e) => this.dirty.add(e));
    else this.dirty.add(entity);
  }

  /** Rebuilds everything marked dirty. Safe to call at any time. */
  sync() {
    this.#flushDirty({ prime: true });
  }

  /** Builds (or rebuilds) the physics representation of an entity subtree. */
  addEntity(entity) {
    this.markDirty(entity);
    this.#flushDirty({ prime: true });
  }

  /**
   * Removes an entity subtree from the world. Called from component teardown,
   * so it must tolerate being invoked for entities that were never in it.
   */
  removeEntity(entity, { subtree = true } = {}) {
    if (!this.world || !entity) return;
    const list = [];
    if (subtree) entity.traverse((e) => list.push(e));
    else list.push(entity);
    this.#removeEntities(list);
  }

  #flushDirty({ prime = false } = {}) {
    if (!this.world || !this.dirty.size) return;
    // An entity can be marked dirty and then destroyed in the same frame (spawn
    // an effect, kill it on the same tick); `removeEntity` already took its
    // bodies out, and rebuilding one that is no longer in the scene would put
    // a body back with nothing to own it.
    const list = [...this.dirty].filter((e) => this.engine.entities.has(e.id));
    this.dirty.clear();
    if (!list.length) return;
    // Only the affected subtrees, not the whole scene: this runs per spawn, and
    // a full `scene.updateMatrixWorld(true)` per bullet is the sort of cost that
    // makes pooling pointless. `updateWorldMatrix(true, true)` walks up to the
    // root for ancestry and down through the subtree.
    for (const entity of list) entity.object3D.updateWorldMatrix(true, true);
    this.#removeEntities(list);
    for (const entity of list) this.#createBody(entity);
    for (const entity of list) this.#createColliders(entity);
    this.#applyFallbackMass(list);
    this.#buildJoints(list);
    if (prime) this.#primeQueries();
  }

  /**
   * Makes a body created between steps visible to scene queries.
   *
   * Rapier maintains its query acceleration structures inside `step`, so a
   * collider added since the last one is invisible to every raycast until the
   * next — which means `spawn` a grenade and immediately `raycast` from it (a
   * script's `onStart`, the ordinary case) silently misses. A zero-length step
   * builds the structures without integrating anything: the same trick the
   * world build uses to make queries work before the first frame.
   *
   * The events it produces are held rather than dispatched, exactly as the
   * build does — a body that spawns already inside a trigger must still report
   * entering it, but not before its scripts have had their `onStart`.
   */
  #primeQueries() {
    const timestep = this.world.timestep;
    this.world.timestep = 0;
    this.world.step(this.eventQueue);
    this.world.timestep = timestep;
    this._deferredEvents ??= [];
    this.#drainEvents(this._deferredEvents);
  }

  /**
   * Frees the joints an entity owns, leaving its body alone. Detaching a
   * JointComponent means "this door is no longer hinged", not "this door is no
   * longer a physics object".
   */
  removeJoints(entity) {
    if (!this.world) return;
    for (let i = this.joints.length - 1; i >= 0; i--) {
      const entry = this.joints[i];
      if (entry.entity !== entity) continue;
      this.joints.splice(i, 1);
      const comp = entity.getComponent?.("joint");
      if (comp?.joint === entry.joint) comp.joint = null;
      this.world.removeImpulseJoint(entry.joint, true);
    }
  }

  /** Frees the Rapier objects owned by these entities, in dependency order. */
  #removeEntities(list) {
    const set = new Set(list);
    // Bodies about to be freed, by handle. Removing a body frees the colliders
    // attached to it, so a collider whose body is in this set must NOT also be
    // removed by hand — Rapier treats the second removal as a use-after-free.
    const doomed = new Set();
    for (const entity of list) {
      const body = this.bodyByEntity.get(entity);
      if (body) doomed.add(body.handle);
    }

    // Joints first: a joint outliving either of its bodies is a dangling
    // reference the next step reads.
    for (const entity of list) this.removeJoints(entity);

    for (const entity of list) {
      const cc = entity.getComponent?.("charactercontroller");
      if (cc) this.unregisterCharacter(cc);

      const col = entity.getComponent?.("collider");
      if (col?.collider) {
        const handle = col.collider.handle;
        this.colliderEntity.delete(handle);
        this.colliderLayer.delete(handle);
        if (!doomed.has(col.collider.parent()?.handle)) this.world.removeCollider(col.collider, true);
        col.collider = null;
      }

      const body = this.bodyByEntity.get(entity);
      if (!body) continue;
      this.bodyByEntity.delete(entity);
      // Colliders on this body that belong to OTHER entities (compound child
      // colliders) die with it, so their bookkeeping has to go too.
      for (const [handle, owner] of [...this.colliderEntity]) {
        const collider = this.world.getCollider(handle);
        if (collider && collider.parent()?.handle !== body.handle) continue;
        this.colliderEntity.delete(handle);
        this.colliderLayer.delete(handle);
        const comp = owner.getComponent?.("collider");
        if (comp?.collider?.handle === handle) comp.collider = null;
      }
      this.dynamicBodies = this.dynamicBodies.filter((e) => e.body !== body);
      this.kinematicBodies = this.kinematicBodies.filter((e) => e.body !== body);
      const rb = entity.getComponent?.("rigidbody");
      if (rb?.body === body) rb.body = null;
      this.world.removeRigidBody(body);
    }
  }

  /**
   * Impulse joints (doors, ropes, swings, suspension). A JointComponent lives
   * on the entity holding the joint's own body and names the entity it is
   * attached to; leaving that blank pins the body to the world through a
   * hidden fixed body, which is how a swinging sign or a lamp cord is built.
   */
  #buildJoints(entities) {
    const { RAPIER } = this;
    const bodyByEntity = this.bodyByEntity;
    const v = (a) => ({ x: a?.[0] ?? 0, y: a?.[1] ?? 0, z: a?.[2] ?? 0 });
    for (const entity of entities) {
      const comp = entity.getComponent("joint");
      if (!comp) continue;
      const bodyA = bodyByEntity.get(entity) ?? entity.getComponent("rigidbody")?.body;
      if (!bodyA) {
        console.warn(`Joint on "${entity.name}": needs a Rigidbody on the same entity`);
        continue;
      }
      const p = comp.props;
      const other = p.connectedEntity ? this.engine.getEntity(p.connectedEntity) : null;
      if (p.connectedEntity && !other) {
        console.warn(`Joint on "${entity.name}": connected entity not found`);
        continue;
      }
      let bodyB = other ? bodyByEntity.get(other) ?? other.getComponent("rigidbody")?.body : null;
      if (other && !bodyB) {
        console.warn(`Joint on "${entity.name}": "${other.name}" has no Rigidbody`);
        continue;
      }
      if (!bodyB) {
        // Anchor to the world: a fixed body at this entity's current pose.
        entity.object3D.getWorldPosition(_pos);
        bodyB = this.world.createRigidBody(
          RAPIER.RigidBodyDesc.fixed().setTranslation(_pos.x, _pos.y, _pos.z),
        );
      }
      const a1 = v(p.anchor);
      const a2 = v(p.connectedAnchor);
      const axis = v(p.axis?.some?.((n) => n !== 0) ? p.axis : [0, 1, 0]);
      let data = null;
      if (p.kind === "hinge") data = RAPIER.JointData.revolute(a1, a2, axis);
      else if (p.kind === "ball") data = RAPIER.JointData.spherical(a1, a2);
      else if (p.kind === "slider") data = RAPIER.JointData.prismatic(a1, a2, axis);
      else if (p.kind === "spring") data = RAPIER.JointData.spring(p.restLength, p.stiffness, p.damping, a1, a2);
      else if (p.kind === "rope") data = RAPIER.JointData.rope(Math.max(p.restLength, 0.0001), a1, a2);
      else data = RAPIER.JointData.fixed(a1, { x: 0, y: 0, z: 0, w: 1 }, a2, { x: 0, y: 0, z: 0, w: 1 });

      const joint = this.world.createImpulseJoint(data, bodyA, bodyB, true);
      // Connected bodies usually want to interpenetrate — a hinged door and
      // its frame overlap at the pivot by construction.
      joint.setContactsEnabled?.(!!p.enableCollision);
      // A hinge's limits and motor speed are ANGLES: authored in degrees
      // (a "±45" door reads wrong as radians), stored in degrees, converted
      // here. A slider's are distances and pass through untouched.
      const angular = p.kind === "hinge";
      const toNative = (value) => (angular ? value * DEG2RAD : value);
      if (p.limitsEnabled && (p.kind === "hinge" || p.kind === "slider")) {
        joint.setLimits?.(toNative(p.limitMin), toNative(p.limitMax));
      }
      if (p.motorEnabled && (p.kind === "hinge" || p.kind === "slider")) {
        joint.configureMotorVelocity?.(toNative(p.motorSpeed), p.motorMaxForce);
      }
      comp.joint = joint;
      this.joints.push({ entity, joint });
    }
  }

  #ancestorBodyEntity(entity) {
    for (let p = entity.parent; p; p = p.parent) {
      if (p.getComponent("rigidbody")) return p;
    }
    return null;
  }

  #colliderDesc(col, entity, bodyEntity) {
    const { RAPIER } = this;
    const { shape, size, radius, height, offset, friction, restitution, isSensor } = col.props;
    entity.object3D.getWorldScale(_scale);
    const sx = Math.abs(_scale.x), sy = Math.abs(_scale.y), sz = Math.abs(_scale.z);
    const maxS = Math.max(sx, sy, sz);

    let desc = null;
    if (shape === "box") {
      desc = RAPIER.ColliderDesc.cuboid((size[0] / 2) * sx, (size[1] / 2) * sy, (size[2] / 2) * sz);
    } else if (shape === "sphere") {
      desc = RAPIER.ColliderDesc.ball(radius * maxS);
    } else if (shape === "capsule") {
      desc = RAPIER.ColliderDesc.capsule((height / 2) * sy, radius * Math.max(sx, sz));
    } else if (shape === "mesh") {
      const tri = collectTrimesh(entity.object3D);
      if (!tri) {
        console.warn(`Collider on "${entity.name}": mesh shape found no geometry`);
        return null;
      }
      desc = RAPIER.ColliderDesc.trimesh(tri.vertices, tri.indices);
    } else if (shape === "heightfield") {
      const terrain = entity.getComponent("terrain");
      if (!terrain?.heightsArray) {
        console.warn(`Collider on "${entity.name}": heightfield shape requires a Terrain component`);
        return null;
      }
      desc = RAPIER.ColliderDesc.heightfield(
        terrain.resolution,
        terrain.resolution,
        toColumnMajor(terrain.heightsArray, terrain.resolution),
        { x: (terrain.props.size ?? 50) * sx, y: sy, z: (terrain.props.size ?? 50) * sz },
      );
    }
    if (!desc) return null;

    desc
      .setFriction(friction)
      .setRestitution(restitution)
      .setSensor(!!isSensor)
      .setCollisionGroups(this.layers.groupsFor(col.props.layer))
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

    // A dynamic body's mass comes from its Rigidbody, not shape density.
    const rb = bodyEntity.getComponent("rigidbody");
    if (rb?.props.bodyType === "dynamic" && entity === bodyEntity && rb.props.mass > 0) {
      desc.setMass(rb.props.mass);
    }

    // Collider pose relative to its body (child colliders + local offset).
    // mesh/heightfield shapes are built already positioned (mesh bakes world
    // scale into its vertices; heightfield is centered on the entity origin
    // by construction), so they ignore the `offset` prop.
    _pos.fromArray(shape === "mesh" || shape === "heightfield" ? [0, 0, 0] : offset).multiply(_scale);
    _quat.identity();
    if (entity !== bodyEntity) {
      _mat.copy(bodyEntity.object3D.matrixWorld).invert().multiply(entity.object3D.matrixWorld);
      const rel = new THREE.Vector3(), relQ = new THREE.Quaternion(), relS = new THREE.Vector3();
      _mat.decompose(rel, relQ, relS);
      _pos.applyQuaternion(relQ).add(rel);
      _quat.copy(relQ);
    }
    desc.setTranslation(_pos.x, _pos.y, _pos.z).setRotation({ x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w });
    return desc;
  }

  /** Builds a kinematic body + capsule + KinematicCharacterController for a
   *  character-controller entity, at its current world transform. */
  #buildCharacter(entity, cc) {
    const { RAPIER } = this;
    const p = cc.props;
    entity.object3D.getWorldPosition(_pos);
    entity.object3D.getWorldQuaternion(_quat);
    entity.object3D.getWorldScale(_scale);
    const sy = Math.abs(_scale.y);
    const sxz = Math.max(Math.abs(_scale.x), Math.abs(_scale.z));

    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(_pos.x, _pos.y, _pos.z)
        .setRotation({ x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w }),
    );

    const colDesc = RAPIER.ColliderDesc.capsule((p.height / 2) * sy, p.radius * sxz)
      .setTranslation(p.offset[0] * _scale.x, p.offset[1] * _scale.y, p.offset[2] * _scale.z)
      .setCollisionGroups(this.layers.groupsFor(p.layer));
    const collider = this.world.createCollider(colDesc, body);
    this.colliderEntity.set(collider.handle, entity);
    this.colliderLayer.set(collider.handle, this.layers.indexOf(p.layer));

    // Small skin gap keeps the capsule from snagging on the surfaces it slides
    // against; scaled with the body so it stays proportional.
    const controller = this.world.createCharacterController(Math.max(p.skinWidth, 0.001) * (sxz || 1));
    controller.setUp({ x: 0, y: 1, z: 0 });
    controller.setMaxSlopeClimbAngle(p.slopeClimbAngle * DEG2RAD);
    controller.setMinSlopeSlideAngle(p.slopeSlideAngle * DEG2RAD);
    controller.setSlideEnabled(true);
    if (p.autostep) {
      controller.enableAutostep(p.autostepHeight * sy, p.autostepMinWidth * sxz, true);
    } else {
      controller.disableAutostep();
    }
    if (p.snapToGround) controller.enableSnapToGround(p.snapDistance * sy);
    else controller.disableSnapToGround();
    controller.setApplyImpulsesToDynamicBodies(!!p.pushDynamicBodies);

    cc.body = body;
    cc.collider = collider;
    cc.controller = controller;
    cc.grounded = false;
    // Retain the Rapier handles on the system entry too. Component teardown
    // deliberately clears its public handles, but the system still needs the
    // originals in order to remove them safely from the live world.
    this.characters.push({ entity, cc, body, collider, controller });
  }

  #removeCharacterEntry({ cc, body, collider, controller }) {
    if (collider) {
      this.colliderEntity.delete(collider.handle);
      this.colliderLayer.delete(collider.handle);
    }
    if (this.world) {
      if (controller) this.world.removeCharacterController(controller);
      // Removing the rigid body also removes its attached capsule collider.
      if (body) this.world.removeRigidBody(body);
    }
    if (cc.body === body) cc.body = null;
    if (cc.collider === collider) cc.collider = null;
    if (cc.controller === controller) cc.controller = null;
    cc.grounded = false;
  }

  #teardown() {
    for (const { entity } of [...this.dynamicBodies, ...this.kinematicBodies]) {
      const rb = entity.getComponent("rigidbody");
      if (rb) rb.body = null;
    }
    for (const { cc } of this.characters) {
      cc.body = null;
      cc.collider = null;
      cc.controller = null;
      cc.grounded = false;
    }
    this.characters = [];
    for (const entity of this.colliderEntity.values()) {
      const col = entity.getComponent("collider");
      if (col) col.collider = null;
    }
    for (const { entity } of this.joints) {
      const comp = entity.getComponent("joint");
      if (comp) comp.joint = null;
    }
    this.joints = [];
    this.dynamicBodies = [];
    this.kinematicBodies = [];
    this.bodyByEntity.clear();
    this.dirty.clear();
    this.colliderEntity.clear();
    this.colliderLayer.clear();
    this.accumulator = 0;
    this.eventQueue?.free();
    this.eventQueue = null;
    this.world?.free();
    this.world = null;
  }

  // ---- per-frame stepping ----

  /**
   * Advances the world by `dt` seconds of GAME time (so pause and slow motion
   * reach physics). Public because a system's step is a legitimate thing for a
   * host to drive — the engine's update loop is just the usual caller.
   */
  update(dt) {
    if (!this.world || !this.engine.playing) return;

    // Entities that appeared or changed since the last step. The spawn path
    // flushes this itself; this is the safety net for everything else — an
    // additive scene loaded mid-game, a component added from the inspector
    // while playing, a script calling `addComponent` directly.
    this.#flushDirty();

    // Defensive reconciliation for component replacement/HMR and any caller
    // that cleared a component handle directly. Normally onDetach reaches
    // unregisterCharacter first; this closes the remaining stale-entry path.
    for (let i = this.characters.length - 1; i >= 0; i -= 1) {
      const entry = this.characters[i];
      const attached = entry.entity.getComponent("charactercontroller") === entry.cc;
      const handlesMatch = entry.cc.body === entry.body
        && entry.cc.collider === entry.collider
        && entry.cc.controller === entry.controller;
      if (attached && handlesMatch) continue;
      this.characters.splice(i, 1);
      this.#removeCharacterEntry(entry);
    }

    // Kinematic bodies follow their entity (scripts/animations drive them).
    if (this.kinematicBodies.length) this.engine.scene.updateMatrixWorld(true);
    for (const entry of this.kinematicBodies) {
      const { entity, body, prev } = entry;
      entity.object3D.getWorldPosition(_pos);
      entity.object3D.getWorldQuaternion(_quat);
      // How far the platform is about to move. A character standing on it adds
      // this to its own motion (see #stepCharacter) — without it, a moving
      // platform slides out from under the player, which is the single most
      // reported "my character controller is broken" symptom.
      entry.delta[0] = _pos.x - prev[0];
      entry.delta[1] = _pos.y - prev[1];
      entry.delta[2] = _pos.z - prev[2];
      prev[0] = _pos.x;
      prev[1] = _pos.y;
      prev[2] = _pos.z;
      body.setNextKinematicTranslation({ x: _pos.x, y: _pos.y, z: _pos.z });
      body.setNextKinematicRotation({ x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w });
    }

    this.accumulator = Math.min(this.accumulator + dt, FIXED_DT * MAX_SUBSTEPS);
    let stepped = false;
    while (this.accumulator >= FIXED_DT) {
      this.accumulator -= FIXED_DT;
      this.world.timestep = FIXED_DT;
      // Resolve character motion before the step so the world advances the
      // kinematic bodies to their collision-free targets this substep.
      for (const entry of this.characters) this.#stepCharacter(entry, FIXED_DT);
      this.world.step(this.eventQueue);
      stepped = true;
      this.#dispatchEvents();
    }
    if (!stepped) return;

    // Write dynamic body poses back to entities (world -> parent-local).
    for (const { entity, body } of this.dynamicBodies) {
      if (body.isSleeping()) continue;
      const t = body.translation();
      const r = body.rotation();
      const obj = entity.object3D;
      _pos.set(t.x, t.y, t.z);
      _quat.set(r.x, r.y, r.z, r.w);
      if (entity.parent) {
        entity.parent.object3D.updateWorldMatrix(true, false);
        obj.position.copy(_pos).applyMatrix4(_mat.copy(entity.parent.object3D.matrixWorld).invert());
        entity.parent.object3D.getWorldQuaternion(_parentQuat);
        obj.quaternion.copy(_parentQuat.invert().multiply(_quat));
      } else {
        obj.position.copy(_pos);
        obj.quaternion.copy(_quat);
      }
    }

    // Character controllers own position only — the entity keeps its own
    // rotation (scripts steer yaw directly on the transform).
    for (const { entity, cc, body } of this.characters) {
      const t = body.translation();
      _pos.set(t.x, t.y, t.z);
      const obj = entity.object3D;
      if (entity.parent) {
        entity.parent.object3D.updateWorldMatrix(true, false);
        obj.position.copy(_pos).applyMatrix4(_mat.copy(entity.parent.object3D.matrixWorld).invert());
      } else {
        obj.position.copy(_pos);
      }
    }
  }

  /** Integrates one character's velocity (with gravity) for a fixed step,
   *  resolves the move against the world, and queues the next kinematic pose. */
  #stepCharacter(entry, dt) {
    const { cc, body, collider, controller } = entry;
    const p = cc.props;
    const v = cc.velocity;
    if (p.applyGravity) v[1] += this.gravity[1] * (p.gravityScale ?? 1) * dt;

    // Carried motion from the platform the character stood on last step. One
    // step of lag is deliberate: the ground is only known *after* the solve,
    // and re-solving to remove the lag costs more than the half-frame of drift
    // it saves (invisible at 60 Hz).
    const carry = entry.platform?.delta;
    const t = body.translation();
    controller.computeColliderMovement(
      collider,
      {
        x: v[0] * dt + (carry?.[0] ?? 0),
        y: v[1] * dt + (carry?.[1] ?? 0),
        z: v[2] * dt + (carry?.[2] ?? 0),
      },
      // The controller sweeps its own query and does NOT inherit the capsule's
      // collision groups — without passing them it collides with every layer,
      // so a character on a layer excluded from Debris still bumped into it.
      undefined,
      this.layers.groupsFor(p.layer),
    );
    cc.grounded = controller.computedGrounded();
    // Zero out downward speed once grounded so gravity doesn't accumulate into
    // a huge value while standing still.
    if (cc.grounded && v[1] < 0) v[1] = 0;

    entry.platform = cc.grounded ? this.#groundPlatform(controller) : null;
    cc.platformEntity = entry.platform?.entity ?? null;

    const m = controller.computedMovement();
    body.setNextKinematicTranslation({ x: t.x + m.x, y: t.y + m.y, z: t.z + m.z });
  }

  /**
   * The kinematic body the character is standing on, if any. Reads the
   * controller's own collision list rather than firing a second downward
   * query — it already knows exactly what it hit, and a separate raycast can
   * disagree with the solve at ledges.
   */
  #groundPlatform(controller) {
    const count = controller.numComputedCollisions?.() ?? 0;
    for (let i = 0; i < count; i++) {
      const hit = controller.computedCollision(i);
      const normal = hit?.normal1 ?? hit?.normal2;
      // Surfaces facing mostly upward are ground; a wall is not a platform.
      if (!normal || Math.abs(normal.y) < 0.5) continue;
      const handle = hit.collider?.handle ?? hit.colliderHandle;
      if (handle == null) continue;
      const entity = this.colliderEntity.get(handle);
      if (!entity) continue;
      const platform = this.kinematicBodies.find((k) => k.entity === entity);
      if (platform) return platform;
    }
    return null;
  }

  #drainEvents(into) {
    this.eventQueue.drainCollisionEvents((h1, h2, started) => into.push([h1, h2, started]));
  }

  #dispatchEvents() {
    const events = [];
    if (this._deferredEvents?.length) {
      events.push(...this._deferredEvents);
      this._deferredEvents.length = 0;
    }
    this.#drainEvents(events);
    for (const [h1, h2, started] of events) {
      const e1 = this.colliderEntity.get(h1);
      const e2 = this.colliderEntity.get(h2);
      if (!e1 || !e2) continue;
      const sensor = this.world.getCollider(h1)?.isSensor() || this.world.getCollider(h2)?.isSensor();
      const hook = sensor
        ? (started ? "onTriggerEnter" : "onTriggerExit")
        : (started ? "onCollisionEnter" : "onCollisionExit");
      // `dispatch` reaches EVERY script on the entity, not just the first one.
      // This used to read `.instance?.[hook]`, which silently delivered
      // collisions to whichever script happened to be listed first.
      e1.getComponent("script")?.dispatch(hook, e2);
      e2.getComponent("script")?.dispatch(hook, e1);
      this.engine.emit(sensor ? "trigger" : "collision", { a: e1, b: e2, started });
    }
  }
}

/**
 * TerrainComponent.heightsArray is row-major over (z-row, x-col) — it comes
 * straight from PlaneGeometry's vertex order (see TerrainComponent's
 * #applyHeightsToGeometry). Rapier's ColliderDesc.heightfield wants the same
 * (row, col) samples in column-major order (nalgebra convention: index =
 * row + col * (nrows+1)) — this just transposes the storage, not the terrain.
 */
function toColumnMajor(heights, resolution) {
  const cols = resolution + 1;
  const out = new Float32Array(heights.length);
  for (let r = 0; r <= resolution; r++) {
    for (let c = 0; c <= resolution; c++) {
      out[r + c * cols] = heights[r * cols + c];
    }
  }
  return out;
}

/**
 * Merges every rendered mesh under the entity's Object3D (skipping
 * editor-only helpers) into one trimesh, in the entity's world frame
 * relative to itself — i.e. vertices carry the world scale and child
 * offsets, since Rapier shapes can't scale.
 */
function collectTrimesh(root) {
  const verts = [];
  const indices = [];
  root.updateWorldMatrix(true, false);
  const invRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const rootScale = new THREE.Vector3();
  root.getWorldScale(rootScale);
  const local = new THREE.Matrix4();
  const v = new THREE.Vector3();

  root.traverse((child) => {
    if (!child.isMesh || !child.geometry?.attributes?.position) return;
    if (child.layers.mask === 1 << EDITOR_LAYER) return; // editor-only helper
    child.updateWorldMatrix(true, false);
    local.copy(invRoot).multiply(child.matrixWorld);
    const pos = child.geometry.attributes.position;
    const base = verts.length / 3;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(local).multiply(rootScale);
      verts.push(v.x, v.y, v.z);
    }
    const index = child.geometry.index;
    if (index) {
      for (let i = 0; i < index.count; i++) indices.push(base + index.getX(i));
    } else {
      for (let i = 0; i < pos.count; i++) indices.push(base + i);
    }
  });

  if (!verts.length) return null;
  return { vertices: new Float32Array(verts), indices: new Uint32Array(indices) };
}
