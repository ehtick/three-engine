import * as THREE from "three/webgpu";
import { Component } from "./Component.js";
import { resolveSpline } from "./SplineComponent.js";
import { SplineFrame, WRAP_MODES, advanceAlong } from "../spline/splineMath.js";

/**
 * Moves an entity along a spline (roadmap item 16) — a patrol route, an
 * elevator, a moving platform, a cart carrying a camera, a train.
 *
 * ## `position` is a prop, and that is the integration
 *
 * Distance along the path lives in `props.position`, which means the timeline's
 * property tracks can key it the day this component exists (they are derived
 * from component schemas), a script can write it, and a save file records it —
 * none of which needed a line of code here. `speed` is then just the
 * convenience of not having to key it: a patrolling guard sets a speed and
 * forgets, a cutscene elevator sets speed to 0 and keys the position.
 *
 * ## Distance is in the path's own units
 *
 * Not world metres. A scaled path entity is a longer road, and if `position`
 * meant world distance then scaling the road would slide everything on it —
 * a timeline key placed at "the corner" would no longer be at the corner. In
 * the normal case (scale 1) the two are identical.
 *
 * ## It applies the pose in the editor too
 *
 * A cart you cannot see on its rail until you press Play is not authorable.
 * Unlike the camera rig's `Preview Rig` — which is off by default because a
 * camera's transform is *authored* data that a preview would overwrite — a
 * follower's transform is *derived* data: the only correct value for it is the
 * one the path dictates. The authored transform is still captured and restored
 * when the component is removed or preview is switched off, so turning the
 * feature off gives the object back.
 */
export class SplineFollowerComponent extends Component {
  static type = "splineFollower";
  static label = "Spline Follower";
  static tags = ["gameplay", "play-mode"];
  // `_direction` (ping-pong), `_finished` and any position the guard walked to
  // during play are simulation state. Leaving Play must put the patrol back at
  // the start of its route, not wherever it was when someone hit Stop.
  static resetOnStop = true;
  static defaults = {
    path: "",
    position: 0,
    speed: 2,
    wrap: "loop",
    align: "heading",
    forward: "-Z",
    offset: [0, 0, 0],
    autoPlay: true,
    preview: true,
  };
  static schema = [
    { key: "path", label: "Path", type: "entity" },
    { key: "position", label: "Position", type: "number", step: 0.1 },
    { key: "speed", label: "Speed", type: "number", step: 0.1 },
    { key: "wrap", label: "Wrap", type: "select", options: WRAP_MODES },
    { key: "align", label: "Align", type: "select", options: ["none", "heading", "frame"] },
    {
      key: "forward",
      label: "Forward Axis",
      type: "select",
      options: ["-Z", "+Z"],
      showIf: (p) => p.align !== "none",
    },
    { key: "offset", label: "Offset", type: "vec3" },
    { key: "autoPlay", label: "Auto Play", type: "boolean" },
    { key: "preview", label: "Preview In Editor", type: "boolean" },
  ];

  onAttach() {
    this._direction = 1;
    this._finished = false;
    this.moving = this.props.autoPlay !== false;
    // Captured before anything is written, so switching preview off (or
    // removing the component) restores exactly what the author placed.
    this._authored = {
      position: this.entity.object3D.position.toArray(),
      quaternion: this.entity.object3D.quaternion.toArray(),
    };
    this.entity.engine?.paths?.register(this);
    // Land on the path immediately rather than on the first tick: a component
    // added to an entity across the level looks broken for a frame otherwise,
    // and in a stopped editor there may not BE a next tick worth waiting for.
    this.apply();
  }

  onDetach() {
    this.entity.engine?.paths?.unregister(this);
    this.#restoreAuthored();
  }

  onDisable() {
    this.#restoreAuthored();
  }

  onEnable() {
    this.apply();
  }

  onPropChanged(key) {
    if (key === "preview" && this.props.preview === false) {
      this.#restoreAuthored();
      return;
    }
    if (key === "autoPlay") this.moving = this.props.autoPlay !== false;
    // Never rebuild: the base class's detach/attach would re-capture the
    // authored transform from the PREVIEWED pose, permanently losing it.
    this.apply();
  }

  #restoreAuthored() {
    if (!this._authored || !this.entity?.object3D) return;
    this.entity.object3D.position.fromArray(this._authored.position);
    this.entity.object3D.quaternion.fromArray(this._authored.quaternion);
  }

  // ---- script API ----------------------------------------------------------

  get path() {
    return resolveSpline(this.entity, this.props.path);
  }

  /** Path length in the path's own units — what `position` is measured in. */
  get pathLength() {
    return this.path?.length ?? 0;
  }

  /** 0..1 along the path. The form a UI progress bar wants. */
  get progress() {
    const length = this.pathLength;
    return length > 1e-6 ? THREE.MathUtils.clamp(this.props.position / length, 0, 1) : 0;
  }

  get position() {
    return this.props.position ?? 0;
  }

  set position(value) {
    this.props.position = value;
    this.apply();
  }

  /** True once a `once`/`clamp` path has reached its end. */
  get finished() {
    return this._finished;
  }

  play() {
    this.moving = true;
    this._finished = false;
    return this;
  }

  pause() {
    this.moving = false;
    return this;
  }

  /** Jumps to `distance` (or to the start) and clears the finished latch. */
  seek(distance = 0) {
    this.props.position = distance;
    this._finished = false;
    this._direction = 1;
    this.apply();
    return this;
  }

  // ---- runtime -------------------------------------------------------------

  /** Called by PathSystem ahead of the update callbacks. `dt` is game time. */
  tick(dt) {
    const engine = this.entity.engine;
    const path = this.path;
    if (!path?.spline?.valid) return;
    if (engine?.playing && this.moving && dt > 0) {
      const speed = this.props.speed ?? 0;
      if (speed !== 0) {
        const result = advanceAlong(
          this.props.position ?? 0,
          speed * dt,
          path.length,
          this.props.wrap ?? "clamp",
          this._direction,
        );
        // Written directly, NOT through setProp: a per-frame `setProp` would
        // emit component-changed + hierarchy-changed sixty times a second and
        // re-render the entire editor mirror behind a moving platform.
        this.props.position = result.distance;
        this._direction = result.direction;
        if (result.finished && !this._finished) {
          this._finished = true;
          if (this.props.wrap === "once") this.moving = false;
          engine.emit?.("path-completed", { entityId: this.entity.id });
        } else if (!result.finished) {
          this._finished = false;
        }
      }
    } else if (!engine?.playing && this.props.preview === false) {
      return;
    }
    this.apply();
  }

  /**
   * Writes the entity's transform from the current `position`.
   *
   * Separate from `tick` so an inspector edit, a timeline scrub and a script
   * assignment all land through exactly the same path as playback — the state
   * is a pure function of `position`, which is what makes scrubbing a director
   * track over an elevator show the elevator where it will actually be.
   */
  apply() {
    const path = this.path;
    if (!path?.spline?.valid || !this.entity?.object3D) return;
    if (!this.entity.engine?.playing && this.props.preview === false) return;
    const object = this.entity.object3D;
    path.worldFrameAt(THREE.MathUtils.clamp(this.props.position ?? 0, 0, path.length), _frame);

    const offset = this.props.offset ?? [0, 0, 0];
    _pos
      .copy(_frame.position)
      .addScaledVector(_frame.binormal, offset[0] ?? 0)
      .addScaledVector(_frame.normal, offset[1] ?? 0)
      .addScaledVector(_frame.tangent, offset[2] ?? 0);

    const parent = object.parent;
    if (parent) {
      parent.updateWorldMatrix(true, false);
      object.position.copy(parent.worldToLocal(_pos));
    } else {
      object.position.copy(_pos);
    }

    const align = this.props.align ?? "heading";
    if (align === "none") return;
    if (align === "heading") {
      // Yaw only: a guard walking a route that dips over a hill should stay
      // upright. Using the full frame there tips the character forward, which
      // reads as the model being broken rather than the path being 3D.
      _dir.copy(_frame.tangent);
      _dir.y = 0;
      if (_dir.lengthSq() < 1e-8) _dir.copy(_frame.binormal).setY(0);
      if (_dir.lengthSq() < 1e-8) return;
      _dir.normalize();
      _up.set(0, 1, 0);
    } else {
      _dir.copy(_frame.tangent);
      _up.copy(_frame.normal);
    }
    if (this.props.forward === "+Z") {
      _right.copy(_up).cross(_dir).normalize();
      _matrix.makeBasis(_right, _up, _dir);
    } else {
      _right.copy(_dir).cross(_up).normalize();
      _matrix.makeBasis(_right, _up, _back.copy(_dir).negate());
    }
    _quat.setFromRotationMatrix(_matrix);
    if (parent) {
      parent.getWorldQuaternion(_parentQuat);
      object.quaternion.copy(_parentQuat.invert().multiply(_quat));
    } else {
      object.quaternion.copy(_quat);
    }
  }

  /** Where on the path this thing currently is — the one thing a still frame
   *  can't tell you when several carts share one rail. */
  onDrawGizmosSelected(gizmos) {
    const path = this.path;
    if (!path?.spline?.valid) return;
    this.entity.object3D.updateWorldMatrix(true, false);
    gizmos.color("#ffd166");
    gizmos.point(this.entity.object3D.getWorldPosition(_pos), 0.15);
  }
}

const _frame = new SplineFrame();
const _pos = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _back = new THREE.Vector3();
const _matrix = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _parentQuat = new THREE.Quaternion();
