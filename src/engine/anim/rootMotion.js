import * as THREE from "three/webgpu";

/**
 * Root motion: turning the translation baked into a clip's root bone into
 * movement of the *entity*, and taking it back out of the pose so the mesh
 * doesn't travel twice.
 *
 * The hard part is not the bookkeeping, it's getting an exact delta. Reading
 * the bone's transform before and after `mixer.update()` and subtracting works
 * right up until the clip loops, at which point the root snaps from the end of
 * the stride back to the start and the character teleports backwards a metre.
 * Damping or thresholding that spike is the usual hack and it visibly eats
 * motion on short clips.
 *
 * So this samples the root track directly through the clip's own interpolants
 * instead, and when an action wraps it evaluates the interval in two pieces —
 * `[t0, duration]` plus `[0, t1]`. The result is exact for any dt, any
 * timeScale, any number of blended actions, and loops are not a special case at
 * the call site.
 *
 * Everything is expressed in the *entity's* space, not the bone's. glTF rigs
 * routinely sit under an up-axis correction (an armature rotated -90° on X), so
 * "the root bone's local +Z" and "the direction the character faces" are not the
 * same axis, and a system that confuses them turns forward motion into a dive
 * into the floor.
 */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _delta = new THREE.Vector3();
const _within = new THREE.Vector3();
const _poseDelta = new THREE.Vector3();
const _fromEntityQ = new THREE.Quaternion();

/**
 * The rotation about entity +Y contained in a delta quaternion (swing-twist,
 * twist component).
 *
 * Deliberately NOT "the yaw of the bone's orientation": under a glTF up-axis
 * correction the bone's own +Z can map to entity UP, and asking for the heading
 * of a vector pointing straight up is a division by zero that produces ±π of
 * noise per frame. A *delta* has no such degeneracy — it is a small rotation,
 * and the part of it about +Y is well defined however the rig is oriented.
 */
function twistY(dq) {
  let y = dq.y;
  let w = dq.w;
  if (w < 0) {
    // Shortest arc: q and -q are the same rotation, but atan2 isn't.
    y = -y;
    w = -w;
  }
  return 2 * Math.atan2(y, w);
}

/**
 * Picks the bone that carries root motion.
 *
 * Preference order: an explicit name, then the shallowest bone that any clip
 * actually translates (a rig can animate several bones' positions — only the
 * one nearest the armature root is the locomotion root), then the skeleton's
 * first bone.
 */
export function findRootBone(modelRoot, clips, explicitName = "") {
  if (!modelRoot) return null;
  if (explicitName) {
    const named = modelRoot.getObjectByName(explicitName);
    if (named) return named;
    console.warn(`Root motion: no bone named "${explicitName}" on this model — falling back to auto-detect.`);
  }
  const translated = new Set();
  for (const clip of clips ?? []) {
    for (const track of clip.tracks) {
      const parsed = THREE.PropertyBinding.parseTrackName(track.name);
      if (parsed.propertyName === "position") translated.add(parsed.nodeName);
    }
  }
  let best = null;
  let bestDepth = Infinity;
  modelRoot.traverse((object) => {
    if (!object.isBone || !translated.has(object.name)) return;
    let depth = 0;
    for (let cur = object.parent; cur && cur !== modelRoot; cur = cur.parent) depth++;
    if (depth < bestDepth) {
      bestDepth = depth;
      best = object;
    }
  });
  if (best) return best;
  let firstBone = null;
  modelRoot.traverse((object) => {
    if (!firstBone && object.isBone) firstBone = object;
  });
  return firstBone;
}

export class RootMotionExtractor {
  /**
   * @param entityObject the entity's Object3D — the frame deltas are reported in
   * @param rootBone     the bone carrying the motion
   * @param options      `{ applyY, applyRotation }`
   */
  constructor(entityObject, rootBone, options = {}) {
    this.entityObject = entityObject;
    this.rootBone = rootBone;
    this.applyY = !!options.applyY;
    this.applyRotation = options.applyRotation !== false;

    /** Delta produced by the most recent `extract()`, in entity space. */
    this.delta = new THREE.Vector3();
    /** Yaw delta produced by the most recent `extract()`, in radians. */
    this.deltaYaw = 0;
    /** Total since the last `consume()` — for scripts driving a controller. */
    this.pending = new THREE.Vector3();
    this.pendingYaw = 0;

    // How far the raw root has drifted from the clip's first frame, in entity
    // space — NOT the distance travelled. It resets itself every loop, because
    // the bone value it corrects does too.
    this._accum = new THREE.Vector3();
    this._accumYaw = 0;

    this._prevTimes = new Map(); // AnimationAction -> time at the previous frame
    this._interpolants = new Map(); // AnimationClip -> { position, quaternion }
    this._toEntity = null; // bone-parent space -> entity space
    this._fromEntity = null;
    this._toEntityQuat = new THREE.Quaternion();
    this._fromEntityQuat = new THREE.Quaternion();
  }

  /**
   * Caches the fixed transform between the root bone's parent and the entity.
   *
   * It is fixed because the chain entity → … → rootBone.parent is the armature's
   * static up-axis correction; the animated bones all live at or below the root
   * bone, which is excluded. Recomputing it per frame would also make it depend
   * on the pose we are in the middle of correcting.
   */
  #ensureBasis() {
    if (this._toEntity) return true;
    const parent = this.rootBone?.parent;
    if (!parent || !this.entityObject) return false;
    this.entityObject.updateMatrixWorld(true);
    this._toEntity = new THREE.Matrix4()
      .copy(this.entityObject.matrixWorld)
      .invert()
      .multiply(parent.matrixWorld);
    this._fromEntity = new THREE.Matrix4().copy(this._toEntity).invert();
    this._toEntity.decompose(_v, this._toEntityQuat, _v2);
    this._fromEntityQuat.copy(this._toEntityQuat).invert();
    return true;
  }

  /** Root position/quaternion interpolants for a clip (null when it has none). */
  #interpolantsFor(clip) {
    let entry = this._interpolants.get(clip);
    if (entry) return entry;
    entry = { position: null, quaternion: null, duration: clip.duration };
    const name = this.rootBone?.name;
    for (const track of clip.tracks) {
      const parsed = THREE.PropertyBinding.parseTrackName(track.name);
      if (parsed.nodeName !== name) continue;
      if (parsed.propertyName === "position") entry.position = track.createInterpolant();
      else if (parsed.propertyName === "quaternion") entry.quaternion = track.createInterpolant();
    }
    this._interpolants.set(clip, entry);
    return entry;
  }

  /**
   * Resets the running totals. Call on state entry or when the model rebuilds —
   * NOT every frame: `_accum` is what keeps the in-place pose stable across
   * loops, and zeroing it mid-clip snaps the mesh.
   */
  reset() {
    this._prevTimes.clear();
    this._accum.set(0, 0, 0);
    this._accumYaw = 0;
    this.delta.set(0, 0, 0);
    this.deltaYaw = 0;
  }

  /** Forget an action's history — used when a state stops contributing. */
  forget(action) {
    this._prevTimes.delete(action);
  }

  /**
   * Records where each contributing action's playhead sits BEFORE the mixer
   * advances it. Must be called every frame, immediately before
   * `mixer.update(dt)`.
   *
   * Reading the previous frame's time out of a cache instead looks equivalent
   * and isn't: on the frame a state is entered there is no previous value, so
   * the first frame's motion is silently dropped — a stride's worth of travel
   * lost at every state change, which reads as the character stuttering
   * whenever it starts walking.
   */
  snapshot(contributions) {
    for (const { action, weight } of contributions) {
      if (weight > 0) this._prevTimes.set(action, action.time);
    }
  }

  /**
   * Reads this frame's root motion from the actions that contributed to the
   * pose, and rewrites the root bone so the pose is in-place.
   *
   * Must run AFTER `mixer.update(dt)` — it reads each action's advanced time
   * and pairs it with the `snapshot()` taken before.
   *
   * @param contributions [{ action, clip, weight }] — normalised weights
   * @param dt            the same delta the mixer was advanced by
   */
  extract(contributions, dt) {
    this.delta.set(0, 0, 0);
    this.deltaYaw = 0;
    // The pose correction tracks a DIFFERENT quantity than the entity delta:
    // how far the raw bone has drifted from the clip's first frame, which
    // resets to zero every time the clip loops. The entity delta keeps
    // accumulating across loops; the bone's raw value does not, so subtracting
    // the travelled total from it would push the mesh a full stride further
    // away every cycle.
    _poseDelta.set(0, 0, 0);
    let poseYaw = 0;
    if (!this.#ensureBasis()) return this.delta;

    let totalWeight = 0;
    for (const { action, clip, weight } of contributions) {
      if (!(weight > 0) || !clip) continue;
      const entry = this.#interpolantsFor(clip);
      if (!entry.position && !entry.quaternion) continue;
      const duration = entry.duration || clip.duration;
      if (duration <= 0) continue;
      const t1 = action.time;
      if (!this._prevTimes.has(action)) continue; // first frame in this state
      const t0 = this._prevTimes.get(action);

      // How many whole cycles the playhead crossed. `t1` is what three left
      // after wrapping; `projected` is where the playhead would have gone if it
      // hadn't. The difference, in units of duration, is the wrap count — which
      // makes looping a plain arithmetic term instead of a special case, and is
      // correct for any dt (including one larger than the whole clip) and for
      // clips playing backwards.
      const rate = action.getEffectiveTimeScale?.() ?? action.timeScale ?? 1;
      const projected = t0 + rate * dt;
      const cycles = action.loop === THREE.LoopRepeat ? Math.round((projected - t1) / duration) : 0;

      // Within-cycle motion: what the raw bone value actually changed by,
      // wrap included. This is what the pose correction follows.
      const within = _within.copy(this.#segment(entry, t0, t1));
      const withinYaw = this.#segmentYaw(entry, t0, t1);
      // Total motion: the same, plus a whole cycle's worth for each wrap. This
      // is what the entity travelled.
      const dp = _delta.copy(within);
      let dyaw = withinYaw;
      if (cycles !== 0) {
        dp.addScaledVector(this.#segment(entry, 0, duration), cycles);
        dyaw += cycles * this.#segmentYaw(entry, 0, duration);
      }
      this.delta.addScaledVector(dp, weight);
      this.deltaYaw += dyaw * weight;
      _poseDelta.addScaledVector(within, weight);
      poseYaw += withinYaw * weight;
      totalWeight += weight;
    }
    // Blend weights are normalised over the *active* actions, but actions with
    // no root track drop out above. Re-normalise so a tree where only one child
    // carries root motion doesn't scale the motion down by the others' weight.
    if (totalWeight > 1e-6 && Math.abs(totalWeight - 1) > 1e-6) {
      this.delta.divideScalar(totalWeight);
      this.deltaYaw /= totalWeight;
      _poseDelta.divideScalar(totalWeight);
      poseYaw /= totalWeight;
    }

    // Only cancel what was actually handed over. Vertical motion left in the
    // pose is what keeps a jump's arc; a turn left in the pose is what keeps a
    // pivot-in-place readable.
    if (!this.applyY) {
      this.delta.y = 0;
      _poseDelta.y = 0;
    }
    if (!this.applyRotation) {
      this.deltaYaw = 0;
      poseYaw = 0;
    }

    this._accum.add(_poseDelta);
    this._accumYaw += poseYaw;
    this.pending.add(this.delta);
    this.pendingYaw += this.deltaYaw;
    this.#cancelInPose();
    return this.delta;
  }

  /** Entity-space position change of the root over [t0, t1] (no wrap handling). */
  #segment(entry, t0, t1, out = _v) {
    out.set(0, 0, 0);
    if (!entry.position) return out;
    const a = entry.position.evaluate(t0);
    const ax = a[0];
    const ay = a[1];
    const az = a[2];
    const b = entry.position.evaluate(t1);
    // The interpolant reuses one result buffer, so `a` is already clobbered by
    // the second evaluate — hence the copies above.
    out.set(b[0] - ax, b[1] - ay, b[2] - az);
    // Direction only: the offset between two points in the parent's space maps
    // through the rotation/scale, not the translation.
    return out.applyMatrix4(_m.copy(this._toEntity).setPosition(0, 0, 0));
  }

  /** Entity-space yaw change of the root over [t0, t1] (no wrap handling). */
  #segmentYaw(entry, t0, t1) {
    if (!entry.quaternion) return 0;
    const a = entry.quaternion.evaluate(t0);
    _q.set(a[0], a[1], a[2], a[3]);
    const b = entry.quaternion.evaluate(t1);
    _q2.set(b[0], b[1], b[2], b[3]);
    // Bone-space delta, conjugated into entity space: the same rotation, seen
    // from the frame the character actually turns in.
    _q2.multiply(_q.invert());
    _q2.premultiply(this._toEntityQuat).multiply(_fromEntityQ.copy(this._toEntityQuat).invert());
    return twistY(_q2);
  }

  /**
   * Removes the extracted motion from the bone, leaving the pose in place.
   *
   * Subtracts the accumulated *within-cycle* drift rather than this frame's
   * delta: per-frame subtraction would accumulate float error over a long run,
   * and subtracting the distance travelled would push the mesh a stride further
   * back every loop (the raw bone value snaps to the start of the clip; the
   * travelled total does not).
   */
  #cancelInPose() {
    const bone = this.rootBone;
    if (!bone) return;
    _v.copy(bone.position).applyMatrix4(this._toEntity).sub(this._accum);
    bone.position.copy(_v.applyMatrix4(this._fromEntity));
    if (this.applyRotation) {
      _q.copy(this._toEntityQuat).multiply(bone.quaternion);
      _q2.setFromAxisAngle(UP, -this._accumYaw);
      _q.premultiply(_q2);
      bone.quaternion.copy(_q.premultiply(this._fromEntityQuat));
    }
  }

  /**
   * Hands the motion accumulated since the last call to the caller and clears
   * it. For scripts that feed root motion into a character controller instead of
   * letting it write the transform directly — the two must not both happen, or
   * the character moves at double speed.
   */
  consume(out = new THREE.Vector3()) {
    out.copy(this.pending);
    const yaw = this.pendingYaw;
    this.pending.set(0, 0, 0);
    this.pendingYaw = 0;
    return { position: out, yaw };
  }

  /**
   * Applies this frame's delta straight to the entity's transform, and clears
   * the pending total — motion written to the transform must not also be
   * handed to a script, or a character driven by both moves at double speed.
   */
  applyTo(object3D) {
    if (this.deltaYaw) object3D.rotateY(this.deltaYaw);
    if (this.delta.lengthSq() > 0) {
      object3D.position.add(_v.copy(this.delta).applyQuaternion(object3D.quaternion));
    }
    this.pending.set(0, 0, 0);
    this.pendingYaw = 0;
  }
}

const UP = new THREE.Vector3(0, 1, 0);
