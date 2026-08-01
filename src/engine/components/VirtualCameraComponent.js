import * as THREE from "three/webgpu";
import { Component } from "./Component.js";
import { EDITOR_LAYER } from "../editorLayers.js";
import { resolveSpline } from "./SplineComponent.js";
import { SplineFrame } from "../spline/splineMath.js";
import {
  CameraPose,
  dampAngle,
  dampVector3,
  lookRotation,
  orbitOffset,
  resolveCollision,
} from "../camera/rigMath.js";

/**
 * A virtual camera: a *shot*, not a camera.
 *
 * It renders nothing and owns no projection. It computes where a camera should
 * be and what it should point at, and the Camera component (the "brain") picks
 * the highest-priority one and blends to it. That split is the entire value of
 * the pattern: a game ends up with a dozen framings — third-person follow,
 * aim-down-sights, a death cam, a cutscene push-in, a shop close-up — and with
 * one real camera they all become branches inside whichever script last got
 * there. As separate objects they are authored, previewed, and prioritised
 * independently, and switching between them is a property change instead of a
 * refactor.
 *
 * Body decides where it sits, Aim decides where it looks, and the two are
 * independent — a boom arm that looks at something other than what it follows
 * is how an over-the-shoulder aim camera works.
 */
export class VirtualCameraComponent extends Component {
  static type = "vcam";
  static label = "Virtual Camera";
  static tags = ["camera", "play-mode"];
  // Damped state (where the boom currently is, how far collision has pulled it
  // in) is runtime state, not props — the next Play must start from the shot as
  // authored, not from wherever the last session's camera happened to end up.
  static resetOnStop = true;
  static defaults = {
    priority: 10,
    follow: "",
    lookAt: "",
    body: "orbital",
    bindingMode: "world",
    offset: [0, 1.6, 0],
    distance: 4,
    yaw: 0,
    pitch: 15,
    minPitch: -35,
    maxPitch: 70,
    lookAction: "",
    lookSensitivity: 2,
    invertY: false,
    dollyPath: "",
    dollyPosition: 0,
    autoDolly: false,
    aim: "lookAt",
    aimOffset: [0, 0, 0],
    positionDamping: 0.15,
    verticalDamping: 0.3,
    aimDamping: 0.1,
    collision: true,
    collisionRadius: 0.25,
    collisionPadding: 0.05,
    collisionLayers: "",
    collisionRecovery: 0.35,
    fov: 0,
    blendTime: -1,
  };
  static schema = [
    { key: "priority", label: "Priority", type: "number", step: 1 },
    { key: "follow", label: "Follow", type: "entity" },
    { key: "lookAt", label: "Look At", type: "entity" },
    {
      key: "body",
      label: "Body",
      type: "select",
      options: ["orbital", "transposer", "hardLock", "dolly", "none"],
    },
    { key: "dollyPath", label: "Dolly Track", type: "entity", showIf: (p) => p.body === "dolly" },
    {
      key: "dollyPosition",
      label: "Track Position",
      type: "number",
      min: 0,
      max: 1,
      step: 0.001,
      showIf: (p) => p.body === "dolly" && !p.autoDolly,
    },
    { key: "autoDolly", label: "Auto Dolly", type: "boolean", showIf: (p) => p.body === "dolly" },
    {
      key: "bindingMode",
      label: "Offset Space",
      type: "select",
      options: ["world", "local"],
      showIf: (p) => p.body === "transposer",
    },
    { key: "offset", label: "Pivot Offset", type: "vec3", showIf: (p) => p.body !== "none" },
    { key: "distance", label: "Arm Length", type: "number", min: 0, step: 0.1, showIf: (p) => p.body === "orbital" },
    { key: "yaw", label: "Yaw", type: "number", step: 1, showIf: (p) => p.body === "orbital" },
    { key: "pitch", label: "Pitch", type: "number", step: 1, showIf: (p) => p.body === "orbital" },
    { key: "minPitch", label: "Min Pitch", type: "number", step: 1, showIf: (p) => p.body === "orbital" },
    { key: "maxPitch", label: "Max Pitch", type: "number", step: 1, showIf: (p) => p.body === "orbital" },
    { key: "lookAction", label: "Look Action", type: "text", showIf: (p) => p.body === "orbital" },
    { key: "lookSensitivity", label: "Sensitivity", type: "number", min: 0, step: 0.1, showIf: (p) => p.body === "orbital" },
    { key: "invertY", label: "Invert Y", type: "boolean", showIf: (p) => p.body === "orbital" },
    { key: "aim", label: "Aim", type: "select", options: ["lookAt", "follow", "path", "none"] },
    { key: "aimOffset", label: "Aim Offset", type: "vec3", showIf: (p) => p.aim === "lookAt" },
    { key: "positionDamping", label: "Position Damping", type: "number", min: 0, step: 0.02 },
    { key: "verticalDamping", label: "Vertical Damping", type: "number", min: 0, step: 0.02 },
    { key: "aimDamping", label: "Aim Damping", type: "number", min: 0, step: 0.02 },
    { key: "collision", label: "Avoid Walls", type: "boolean", showIf: (p) => p.body === "orbital" },
    { key: "collisionRadius", label: "Camera Radius", type: "number", min: 0.01, step: 0.05, showIf: (p) => p.body === "orbital" && p.collision },
    { key: "collisionPadding", label: "Wall Padding", type: "number", min: 0, step: 0.01, showIf: (p) => p.body === "orbital" && p.collision },
    { key: "collisionLayers", label: "Collide With", type: "text", showIf: (p) => p.body === "orbital" && p.collision },
    { key: "collisionRecovery", label: "Recovery", type: "number", min: 0, step: 0.05, showIf: (p) => p.body === "orbital" && p.collision },
    { key: "fov", label: "FOV Override", type: "number", min: 0, max: 179, step: 1 },
    { key: "blendTime", label: "Blend In (s)", type: "number", min: -1, step: 0.05 },
  ];

  onAttach() {
    this.pose = new CameraPose();
    // Damped state, distinct from the target it is chasing. `_settled` is what
    // tells the first frame after activation to snap instead of glide — see
    // `evaluate`.
    this._position = new THREE.Vector3();
    this._aimPoint = new THREE.Vector3();
    this._yaw = THREE.MathUtils.degToRad(this.props.yaw ?? 0);
    this._pitch = THREE.MathUtils.degToRad(this.props.pitch ?? 0);
    this._armDistance = this.props.distance ?? 4;
    this._settled = false;
    // Dolly state: the last evaluated track frame (also what the "path" aim
    // mode reads) and the reusable auto-dolly projection result.
    this._dollyFrame = null;
    this._dollyHit = null;
    /** Runtime-only override that outranks every priority. Editor "Solo". */
    this.solo = false;
    /**
     * Runtime-only channel driven by a timeline camera-shot track. Its own
     * channel rather than "temporarily raise the priority" for the same reason
     * `solo` has one: a shot track must be able to cut to a low-priority shot
     * and hand control back afterwards without ever writing an authored
     * priority it would then have to remember to put back.
     */
    this.timelineShot = false;
    this.timelineBlend = -1;

    const engine = this.entity.engine;
    (engine.virtualCameras ??= new Set()).add(this);
    this.model = buildVcamGizmo();
    this.model.traverse((child) => child.layers.set(EDITOR_LAYER));
    this.model.visible = this._enabled;
    this.entity.object3D.add(this.model);
  }

  onDetach() {
    this.entity.engine.virtualCameras?.delete(this);
    if (this.model) {
      this.entity.object3D.remove(this.model);
      this.model.traverse((child) => {
        child.geometry?.dispose();
        child.material?.dispose();
      });
      this.model = null;
    }
  }

  onDisable() {
    if (this.model) this.model.visible = false;
    // A disabled vcam that becomes active again must re-settle, or it glides in
    // from wherever the target was when it was switched off.
    this._settled = false;
  }

  onEnable() {
    if (this.model) this.model.visible = true;
  }

  onPropChanged(key) {
    if (key === "yaw") this._yaw = THREE.MathUtils.degToRad(this.props.yaw ?? 0);
    if (key === "pitch") this._pitch = THREE.MathUtils.degToRad(this.props.pitch ?? 0);
    if (key === "distance") this._armDistance = this.props.distance ?? 4;
    // Everything else is read fresh each frame; a rebuild would drop the
    // damped state and make every inspector tweak snap the camera.
  }

  // --- script API ----------------------------------------------------------

  /** Orbit angles in degrees. */
  setOrbit(yawDeg, pitchDeg) {
    this._yaw = THREE.MathUtils.degToRad(yawDeg);
    this._pitch = THREE.MathUtils.degToRad(this.#clampPitch(pitchDeg));
  }

  addOrbit(yawDeg, pitchDeg) {
    this.setOrbit(
      THREE.MathUtils.radToDeg(this._yaw) + yawDeg,
      THREE.MathUtils.radToDeg(this._pitch) + pitchDeg,
    );
  }

  getOrbit() {
    return {
      yaw: THREE.MathUtils.radToDeg(this._yaw),
      pitch: THREE.MathUtils.radToDeg(this._pitch),
    };
  }

  /**
   * Drops this camera straight onto its target pose, skipping the damping.
   * Call after teleporting the follow target — otherwise the camera "catches
   * up" across the level, filming the whole trip.
   */
  warp() {
    this._settled = false;
  }

  /** Raises this camera above the others until `solo` is cleared. */
  setSolo(value) {
    this.solo = !!value;
  }

  /**
   * Cuts to (or releases) this shot from a timeline camera track. `blend` is
   * the shot's own blend time in seconds, or -1 for the Camera component's
   * default — the same convention as the authored `blendTime` prop.
   */
  setTimelineShot(active, blend = -1) {
    this.timelineShot = !!active;
    this.timelineBlend = Number.isFinite(blend) ? blend : -1;
    // A shot cut to after sitting idle would otherwise glide in from wherever
    // its damped state was left, filming the trip across the level.
    if (this.timelineShot) this._settled = false;
  }

  get followTarget() {
    return this.props.follow ? this.entity.engine.getEntity(this.props.follow) : null;
  }

  get lookTarget() {
    const id = this.props.lookAt || this.props.follow;
    return id ? this.entity.engine.getEntity(id) : null;
  }

  // --- evaluation ----------------------------------------------------------

  #clampPitch(pitchDeg) {
    return THREE.MathUtils.clamp(pitchDeg, this.props.minPitch ?? -89, this.props.maxPitch ?? 89);
  }

  /**
   * Advances this shot by `dt` and returns its pose.
   *
   * `snap` (or a first evaluation) skips the damping entirely. Without it, a
   * camera that has been idle since the level loaded activates from a stale
   * position and swoops across the map to catch up — which reads as a bug even
   * though every individual step is correct.
   */
  evaluate(dt, { snap = false } = {}) {
    const immediate = snap || !this._settled;
    const engine = this.entity.engine;
    this.#applyLookInput();

    const follow = this.followTarget;
    const pivot = _pivot;
    const offset = this.props.offset ?? [0, 0, 0];

    if (follow) {
      follow.object3D.updateMatrixWorld(true);
      follow.object3D.getWorldPosition(pivot);
    } else {
      this.entity.object3D.getWorldPosition(pivot);
    }

    let targetPos = _targetPos;
    const body = this.props.body ?? "orbital";
    // Dolly is checked before the no-follow fallback: a camera rail is the one
    // body mode that is completely specified without a follow target (a
    // cutscene push-in is a position on a track and nothing else), so folding
    // it into "no target means stay put" would break the primary use.
    if (body === "dolly") {
      this.#evaluateDolly(targetPos, follow, offset);
    } else if (body === "none" || !follow) {
      // No follow target means the shot is wherever the author put it — a
      // fixed camera. Falling back to the origin instead would silently
      // relocate every half-configured vcam to the middle of the level.
      this.entity.object3D.getWorldPosition(targetPos);
    } else if (body === "hardLock") {
      targetPos.copy(pivot).add(_offset.fromArray(offset).applyQuaternion(follow.object3D.getWorldQuaternion(_q)));
    } else if (body === "transposer") {
      _offset.fromArray(offset);
      if (this.props.bindingMode === "local") _offset.applyQuaternion(follow.object3D.getWorldQuaternion(_q));
      targetPos.copy(pivot).add(_offset);
    } else {
      // Orbital: the pivot is raised by the offset (shoulder height), and the
      // camera sits at the end of an arm behind it.
      pivot.add(_offset.fromArray(offset));
      orbitOffset(_arm, this._yaw, this._pitch, 1);
      this.#resolveArm(engine, pivot, _arm, immediate, dt);
      targetPos.copy(pivot).addScaledVector(_arm, this._armDistance);
    }

    if (immediate) this._position.copy(targetPos);
    else {
      // Vertical damping is a separate dial because it has a different job:
      // horizontal lag reads as weight, vertical lag stops stairs and hops
      // from bobbing the frame.
      const p = this.props.positionDamping ?? 0;
      dampVector3(this._position, targetPos, [p, this.props.verticalDamping ?? p, p], dt);
    }
    this.pose.position.copy(this._position);

    this.#applyAim(dt, immediate, follow);
    this.pose.fov = this.props.fov > 0 ? this.props.fov : 0;
    this._settled = true;
    return this.pose;
  }

  /** The spline this camera rides, or null while it is half-wired. */
  get dollyTrack() {
    return this.props.body === "dolly" ? resolveSpline(this.entity, this.props.dollyPath) : null;
  }

  /**
   * Camera rail (roadmap item 16, feeding item 7).
   *
   * `dollyPosition` is NORMALISED, unlike the spline follower's metres, and the
   * difference is deliberate. A cart's speed is a physical quantity, so its
   * position has to be in path units. A camera rail is a *shot* — "start at one
   * end and arrive at the other over five seconds" — so its position wants to
   * be a fraction, which is also what makes a timeline key on it survive
   * someone extending the track afterwards.
   *
   * `autoDolly` instead projects the follow target onto the track: the camera
   * slides along a fixed rail keeping pace with the player, which is how a
   * side-scrolling or corridor camera is built.
   */
  #evaluateDolly(out, follow, offset) {
    const path = this.dollyTrack;
    if (!path?.spline?.valid) {
      // Half-wired: sit where the author put the entity rather than snapping to
      // the world origin, which would look like the camera had been deleted.
      this.entity.object3D.getWorldPosition(out);
      this._dollyFrame = null;
      return;
    }
    let distance;
    if (this.props.autoDolly && follow) {
      follow.object3D.getWorldPosition(_aimTarget);
      this._dollyHit = path.closestPoint(_aimTarget, this._dollyHit ?? {});
      distance = this._dollyHit.distance;
    } else {
      distance = THREE.MathUtils.clamp(this.props.dollyPosition ?? 0, 0, 1) * path.length;
    }
    this._dollyFrame = path.worldFrameAt(distance, this._dollyFrame ?? new SplineFrame());
    const frame = this._dollyFrame;
    // The pivot offset is applied in the TRACK's frame, not the world's: a rail
    // raised "two metres above the track" should stay two metres above it round
    // a banked corner, which a world-space offset does not.
    out
      .copy(frame.position)
      .addScaledVector(frame.binormal, offset[0] ?? 0)
      .addScaledVector(frame.normal, offset[1] ?? 0)
      .addScaledVector(frame.tangent, offset[2] ?? 0);
  }

  /** Feeds a Vec2 input action into the boom arm's yaw/pitch. */
  #applyLookInput() {
    const action = this.props.lookAction;
    if (!action || this.props.body !== "orbital") return;
    const engine = this.entity.engine;
    if (!engine.playing) return;
    const value = engine.input?.readValue?.(action);
    if (!value || typeof value === "number") return;
    const sensitivity = this.props.lookSensitivity ?? 1;
    // Deliberately NOT multiplied by dt: mouse deltas are already per-frame
    // displacements, and scaling them by frame time makes the same physical
    // mouse movement turn the camera further on a slow frame.
    this._yaw -= (value.x ?? 0) * sensitivity;
    const dy = (value.y ?? 0) * sensitivity * (this.props.invertY ? 1 : -1);
    this._pitch = THREE.MathUtils.degToRad(
      this.#clampPitch(THREE.MathUtils.radToDeg(this._pitch + dy)),
    );
  }

  /** Pulls the arm in when something solid is between the pivot and the camera. */
  #resolveArm(engine, pivot, direction, immediate, dt) {
    const desired = this.props.distance ?? 4;
    if (!this.props.collision) {
      this._armDistance = desired;
      return;
    }
    const layers = String(this.props.collisionLayers ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    this._armDistance = resolveCollision(engine.physics, pivot, direction, desired, {
      radius: this.props.collisionRadius ?? 0.25,
      padding: this.props.collisionPadding ?? 0.05,
      layers,
      // The thing being filmed is not an obstruction between the camera and
      // itself; excluding it covers the target's whole subtree, so a weapon
      // parented to the player doesn't shove the camera either.
      exclude: this.followTarget ?? undefined,
      previousDistance: immediate ? null : this._armDistance,
      recovery: this.props.collisionRecovery ?? 0.35,
      dt,
    });
  }

  #applyAim(dt, immediate, follow) {
    const mode = this.props.aim ?? "lookAt";
    if (mode === "none") {
      this.entity.object3D.getWorldQuaternion(this.pose.quaternion);
      return;
    }
    if (mode === "follow") {
      const source = follow ?? this.entity;
      source.object3D.getWorldQuaternion(this.pose.quaternion);
      return;
    }
    if (mode === "path") {
      // Facing along the rail — a rollercoaster cam, a train's cab, a drone
      // shot that follows the route rather than an object. Damped through the
      // aim POINT like every other mode, so a sharp corner eases rather than
      // snapping the whole frame round.
      const frame = this._dollyFrame;
      if (!frame) {
        this.entity.object3D.getWorldQuaternion(this.pose.quaternion);
        return;
      }
      _aimTarget.copy(this.pose.position).addScaledVector(frame.tangent, 10);
      if (immediate) this._aimPoint.copy(_aimTarget);
      else dampVector3(this._aimPoint, _aimTarget, this.props.aimDamping ?? 0, dt);
      lookRotation(this.pose.quaternion, this.pose.position, this._aimPoint);
      return;
    }
    const target = this.lookTarget;
    if (!target) {
      this.entity.object3D.getWorldQuaternion(this.pose.quaternion);
      return;
    }
    target.object3D.getWorldPosition(_aimTarget);
    _aimTarget.add(_offset.fromArray(this.props.aimOffset ?? [0, 0, 0]));
    // Damping the aim POINT rather than the resulting rotation: a slerp between
    // orientations swings the camera through the short arc between them, which
    // for a target passing behind the camera means whipping the wrong way
    // round. A damped point is always somewhere the camera can plausibly look.
    if (immediate) this._aimPoint.copy(_aimTarget);
    else dampVector3(this._aimPoint, _aimTarget, this.props.aimDamping ?? 0, dt);
    lookRotation(this.pose.quaternion, this.pose.position, this._aimPoint);
  }
}

const _pivot = new THREE.Vector3();
const _targetPos = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _arm = new THREE.Vector3();
const _aimTarget = new THREE.Vector3();
const _q = new THREE.Quaternion();

/**
 * Editor gizmo: a small wireframe pyramid pointing down -Z, drawn on the
 * editor layer only. A virtual camera has no mesh of its own, and an entity
 * you cannot see is an entity you cannot select.
 */
function buildVcamGizmo() {
  const group = new THREE.Group();
  const cone = new THREE.ConeGeometry(0.18, 0.42, 4);
  cone.rotateX(-Math.PI / 2);
  const material = new THREE.MeshBasicMaterial({ color: 0xffb347, wireframe: true });
  group.add(new THREE.Mesh(cone, material));
  const ring = new THREE.TorusGeometry(0.1, 0.02, 6, 12);
  group.add(new THREE.Mesh(ring, material));
  return group;
}
