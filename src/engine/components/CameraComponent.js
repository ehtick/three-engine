import * as THREE from "three/webgpu";
import { Component } from "./Component.js";
import { DEBUG_LAYER, EDITOR_LAYER, UI_LAYER } from "../editorLayers.js";
import { BLEND_STYLES, CameraPose, blendCurve } from "../camera/rigMath.js";

/** Occlusion is tri-state so a pre-existing scene setting still means something. */
export const OCCLUSION_MODES = ["inherit", "on", "off"];

/**
 * The real camera — and, when the scene has any Virtual Cameras, the "brain"
 * that decides which of them is live and blends between them.
 *
 * The brain is folded into this component rather than being a separate one
 * because there is exactly one active camera per frame, and a scene where the
 * camera silently does nothing until you remember to add a second component is
 * worse than one extra prop here.
 */
export class CameraComponent extends Component {
  static type = "camera";
  static label = "Camera";
  static defaults = {
    fov: 60,
    near: 0.1,
    far: 1000,
    // --- virtual camera brain ---
    blendTime: 0.6,
    blendStyle: "easeInOut",
    shake: 1,
    previewRigInEditor: false,
    // Preview / follow state travels with the camera component so it
    // stays attached to the entity that owns it (the user picks the
    // camera, the follow target lives on that camera). `showPreview`
    // and `followInViewport` are editor-only at runtime — the shipped
    // player simply ignores them — but we keep them on the component
    // anyway so the inspector's per-camera toggle round-trips cleanly
    // through save/load.
    showPreview: true,
    followTarget: null, // entity id (string) or null
    followInViewport: false,
    followInGame: false,
    // --- culling ---
    // What this camera does and does not bother drawing. It lives here rather
    // than in scene settings because culling is a property of a VIEW: a minimap
    // and a first-person camera looking at the same room disagree about what is
    // worth testing, and the answer to "why did that mesh vanish?" should be on
    // the thing that made it vanish.
    frustumCulling: true,
    // Tri-state, not a boolean, because it used to be
    // `settings.performance.occlusionCulling` and every scene authored before
    // the move still carries that. "inherit" reads the scene setting, so those
    // scenes behave exactly as they did; "on"/"off" are this camera saying so.
    occlusionCulling: "inherit",
    occluderMinSize: 1.5,
    occlusionBias: 0.02,
    cullShadowCasters: true,
  };
  static schema = [
    { key: "fov", label: "FOV", type: "number", min: 1, max: 179, step: 1 },
    { key: "near", label: "Near", type: "number", min: 0.001, step: 0.1 },
    { key: "far", label: "Far", type: "number", min: 1, step: 10 },
    { key: "blendTime", label: "Blend (s)", type: "number", min: 0, step: 0.05 },
    { key: "blendStyle", label: "Blend Curve", type: "select", options: BLEND_STYLES },
    { key: "shake", label: "Shake Scale", type: "number", min: 0, max: 4, step: 0.1 },
    { key: "previewRigInEditor", label: "Preview Rig", type: "boolean" },
    { key: "frustumCulling", label: "Frustum Culling", type: "boolean" },
    {
      key: "occlusionCulling",
      label: "Occlusion Culling",
      type: "select",
      options: OCCLUSION_MODES,
    },
    { key: "occluderMinSize", label: "Min Occluder Size", type: "number", min: 0, step: 0.1 },
    { key: "occlusionBias", label: "Occlusion Bias", type: "number", min: 0, max: 1, step: 0.005 },
    { key: "cullShadowCasters", label: "Cull Shadow Casters", type: "boolean" },
  ];

  onAttach() {
    const { fov, near, far } = this.props;
    this.camera = new THREE.PerspectiveCamera(fov, 16 / 9, near, far);
    // Game cameras see runtime debug drawing. A camera starts with only layer 0
    // enabled, so without this `engine.debug` would draw into Play mode and the
    // Game view and render nothing — the two views it exists for.
    this.camera.layers.enable(DEBUG_LAYER);
    // ...and UI, which renders in this camera's own pass rather than a second
    // one of its own (see engine/ui/UiSystem.js).
    this.camera.layers.enable(UI_LAYER);
    this.camera.userData.entityId = this.entity.id;
    this.entity.engine.cameraComponents.add(this);
    this.entity.object3D.add(this.camera);
    this.model = buildCameraModel();
    this.model.traverse((child) => child.layers.set(EDITOR_LAYER));
    this.model.visible = this._enabled;
    this.entity.object3D.add(this.model);

    // Brain state.
    this.live = null; // the vcam currently driving the camera
    this.blendFrom = null; // the one being blended out of, if it still exists
    this._blendPose = new CameraPose(); // frozen fallback for a departed vcam
    this._pose = new CameraPose();
    this._blendElapsed = 0;
    this._blendDuration = 0;
    this._previewPose = null; // entity transform to restore when preview stops

    this.unsubUpdate = this.entity.engine.onUpdate((dt) => {
      const engine = this.entity.engine;
      if (this.#tickRig(dt, engine)) return;
      if (!engine.playing) return;
      this.applyLookAt(!!this.props.followInGame, engine);
    });
  }

  onDetach() {
    this.#restorePreviewPose();
    this.entity.engine.cameraComponents.delete(this);
    if (!this.camera) return;
    this.entity.object3D.remove(this.camera);
    this.camera = null;
    if (this.model) {
      this.entity.object3D.remove(this.model);
      this.model.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
      });
      this.model = null;
    }
    if (this.unsubUpdate) {
      this.unsubUpdate();
      this.unsubUpdate = null;
    }
  }

  onDisable() {
    // Hide the editor gizmo (lens + frustum helper) and stop following the
    // target while disabled. The PerspectiveCamera itself stays attached so
    // toggling back on restores its FOV/transform without a rebuild.
    if (this.model) this.model.visible = false;
  }

  onEnable() {
    if (this.model) this.model.visible = true;
  }

  onPropChanged(key) {
    if (!this.camera) return;
    if (key === "fov" || key === "near" || key === "far") {
      this.camera[key] = this.props[key];
      this.camera.updateProjectionMatrix();
    }
    // showPreview / followTarget / followInViewport / followInGame are
    // consumed by the editor (preview toggle) and by the per-frame follow
    // tick; no three.js camera property to push.
  }

  // --- virtual camera brain --------------------------------------------------

  /**
   * The virtual camera that should be live: the highest priority among the
   * enabled ones, with ties going to the most recently attached.
   *
   * `solo` short-circuits everything. It is an editor affordance — click Solo
   * on a shot to see it now — and giving it its own channel rather than
   * "temporarily raise the priority" means it can't be confused with, or
   * accidentally saved as, an authored priority.
   */
  pickVirtualCamera(engine) {
    let best = null;
    let bestPriority = -Infinity;
    // A timeline camera-shot track outranks every authored priority while its
    // clip is under the playhead. A cutscene that cuts to a shot is stating
    // what the audience sees; losing that fight to whichever gameplay camera
    // happens to sit at priority 100 would make shot tracks unusable in exactly
    // the scenes they exist for.
    let shot = null;
    for (const vcam of engine.virtualCameras ?? []) {
      if (vcam.solo) return vcam;
      if (vcam.timelineShot) shot = vcam;
      if (!vcam.enabled) continue;
      if (vcam.entity?.enabledInGame === false && engine.playing) continue;
      const priority = vcam.props.priority ?? 0;
      if (priority >= bestPriority) {
        bestPriority = priority;
        best = vcam;
      }
    }
    return shot ?? best;
  }

  /**
   * Runs one frame of the rig. Returns true when it took over the camera, so
   * the caller knows to skip the legacy look-at follow.
   */
  #tickRig(dt, engine) {
    const vcams = engine.virtualCameras;
    if (!vcams?.size) {
      this.#restorePreviewPose();
      return false;
    }
    // `timelinePreview` is set transiently by a bound TimelineRuntime that owns
    // a camera-shot track, and cleared when it unbinds. Without it the brain
    // sits idle in the editor and scrubbing a shot track does nothing visible —
    // which reads as the track being broken.
    const previewing = !engine.playing && (this.props.previewRigInEditor || this.timelinePreview);
    if (!engine.playing && !previewing) {
      this.#restorePreviewPose();
      return false;
    }
    if (previewing) this.#capturePreviewPose();

    const next = this.pickVirtualCamera(engine);
    if (!next) return false;

    if (next !== this.live) {
      // Freeze the current result before switching, so a blend has something
      // to start from even if the outgoing shot is deleted mid-blend.
      if (this.live) {
        this._blendPose.copy(this._pose);
        this.blendFrom = this.live;
      } else {
        this.blendFrom = null;
      }
      // The incoming shot's own blend time wins when set: "how long to ease
      // into THIS shot" is a property of the shot, not of the camera. -1 means
      // "use the camera's default".
      // A timeline shot's blend is a property of the cut, not of the shot: the
      // same vcam can be cut to hard in one sequence and eased into in another.
      const requested = next.timelineShot && next.timelineBlend >= 0
        ? next.timelineBlend
        : next.props.blendTime;
      this._blendDuration = this.live ? (requested >= 0 ? requested : this.props.blendTime ?? 0) : 0;
      this._blendElapsed = 0;
      this.live = next;
      // Snap the incoming shot onto its target before it is seen. Without this
      // it evaluates from wherever its damped state was left — often across the
      // level — and the blend films the trip.
      next.evaluate(0, { snap: true });
    }

    const target = this.live.evaluate(dt);
    if (this.blendFrom && this._blendDuration > 0 && this._blendElapsed < this._blendDuration) {
      this._blendElapsed += dt;
      const t = blendCurve(this._blendElapsed / this._blendDuration, this.props.blendStyle);
      // Keep evaluating the outgoing shot while it exists — a follow camera
      // that freezes the moment you cut away from it drags a stationary ghost
      // through the blend.
      const from = this.blendFrom.entity ? this.blendFrom.evaluate(dt) : this._blendPose;
      this._pose.lerpPoses(from, target, t);
      if (this._blendElapsed >= this._blendDuration) this.blendFrom = null;
    } else {
      this._pose.copy(target);
      this.blendFrom = null;
    }

    this.#applyPose(engine);
    return true;
  }

  /** Writes the blended pose (plus shake) onto the camera entity. */
  #applyPose(engine) {
    const object = this.entity.object3D;
    _worldPos.copy(this._pose.position);
    _worldQuat.copy(this._pose.quaternion);

    const shakeScale = this.props.shake ?? 1;
    if (shakeScale > 0 && engine.cameraImpulse?.count) {
      engine.cameraImpulse.sample(_worldPos, _shakePos, _shakeEuler);
      // Shake is applied in the camera's OWN space: a horizontal rattle has to
      // mean "left/right of frame", not "along world X", or the same explosion
      // shakes sideways or into the lens depending on which way you happened to
      // be facing.
      _worldPos.add(_shakePos.multiplyScalar(shakeScale).applyQuaternion(_worldQuat));
      _shakeEuler.x *= shakeScale;
      _shakeEuler.y *= shakeScale;
      _shakeEuler.z *= shakeScale;
      _worldQuat.multiply(_shakeQuat.setFromEuler(_shakeEuler));
    }

    // The pose is world-space; the entity's transform is relative to its
    // parent. A camera parented under anything (a vehicle, a UI root) would
    // otherwise be offset by that parent's transform, twice.
    const parent = object.parent;
    if (parent && parent !== engine.scene) {
      parent.updateMatrixWorld(true);
      _m.copy(parent.matrixWorld).invert();
      object.position.copy(_worldPos).applyMatrix4(_m);
      parent.getWorldQuaternion(_parentQuat);
      object.quaternion.copy(_parentQuat.invert()).multiply(_worldQuat);
    } else {
      object.position.copy(_worldPos);
      object.quaternion.copy(_worldQuat);
    }

    const fov = this._pose.fov > 0 ? this._pose.fov : this.props.fov;
    if (this.camera && Math.abs(this.camera.fov - fov) > 1e-4) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Remembers the authored transform the first time an editor preview moves
   * the camera, so turning the preview off puts it back.
   *
   * Play mode doesn't need this — leaving Play restores the scene from its
   * snapshot — but the editor has no such safety net, and a preview that
   * quietly rewrites the camera's saved position is a preview nobody can
   * afford to leave on.
   */
  #capturePreviewPose() {
    if (this._previewPose) return;
    this._previewPose = {
      position: this.entity.object3D.position.clone(),
      quaternion: this.entity.object3D.quaternion.clone(),
      fov: this.camera?.fov ?? this.props.fov,
    };
  }

  #restorePreviewPose() {
    if (!this._previewPose) return;
    this.entity.object3D.position.copy(this._previewPose.position);
    this.entity.object3D.quaternion.copy(this._previewPose.quaternion);
    if (this.camera) {
      this.camera.fov = this._previewPose.fov;
      this.camera.updateProjectionMatrix();
    }
    this._previewPose = null;
    this.live = null;
    this.blendFrom = null;
  }

  // ---------------------------------------------------------------------------

  /**
   * Returns the engine entity this camera should currently follow, or null
   * if no follow is configured / the configured target no longer exists.
   * Resolves the stored id string against the live engine — the engine
   * passed in is the one the component lives on.
   */
  resolveFollowTarget(engine) {
    const id = this.props.followTarget;
    if (!id) return null;
    return engine.getEntity(id) ?? null;
  }

  /**
   * When `enabled` is true and a follow target is configured, rotates the
   * camera entity so its -Z points at the target's world position. Position
   * is left alone (the user controls where the camera sits; the camera
   * always "looks at" the target).
   *
   * Safe to call every frame; uses a scratch vector to avoid allocations.
   */
  applyLookAt(enabled, engine) {
    if (!this.camera) return;
    if (!enabled) return;
    const target = this.resolveFollowTarget(engine);
    if (!target) return;
    const targetPos = _scratchTargetPos;
    target.object3D.getWorldPosition(targetPos);
    // The PerspectiveCamera lives as a child of the entity's object3D, so
    // rotating the entity rotates the camera. Object3D.lookAt orients +Z
    // at the target, but a PerspectiveCamera looks down its local -Z — so
    // we flip 180° around Y right after, giving us an entity orientation
    // whose -Z faces the target. Using the entity (not the camera) keeps
    // the gizmo and follow in sync: rotating the entity rotates the camera
    // and the editor's frustum helper together, instead of just the child.
    const obj = this.entity.object3D;
    obj.lookAt(targetPos);
    obj.rotateY(Math.PI);
  }
}

const _scratchTargetPos = new THREE.Vector3();
const _worldPos = new THREE.Vector3();
const _worldQuat = new THREE.Quaternion();
const _parentQuat = new THREE.Quaternion();
const _shakePos = new THREE.Vector3();
const _shakeEuler = new THREE.Euler();
const _shakeQuat = new THREE.Quaternion();
const _m = new THREE.Matrix4();

/**
 * Procedural camera mesh: a small boxy body with a cylindrical lens and a
 * wireframe frustum cone pointing along the entity's local -Z (which is
 * where a real PerspectiveCamera also looks). No extra rotation on the
 * group itself — the geometry is authored so the lens sits on the -Z face
 * directly.
 *
 * The whole model is pushed onto `EDITOR_LAYER` by the caller (see
 * `onAttach`), so it only renders to cameras that have that layer enabled
 * (the editor orbit camera). Picking still finds it because the editor's
 * raycaster tests every layer.
 */
function buildCameraModel() {
  const group = new THREE.Group();
  const bodyGeo = new THREE.BoxGeometry(0.35, 0.25, 0.45);
  const bodyMat = new THREE.MeshBasicMaterial({ color: 0x111111 });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  group.add(body);

  const vfGeo = new THREE.BoxGeometry(0.18, 0.07, 0.18);
  const vf = new THREE.Mesh(vfGeo, bodyMat);
  vf.position.set(0, 0.16, 0.05);
  group.add(vf);

  const lensGeo = new THREE.CylinderGeometry(0.11, 0.11, 0.18, 24);
  lensGeo.rotateX(Math.PI / 2); // cylinder is Y-up by default; face it forward.
  const lensMat = new THREE.MeshBasicMaterial({ color: 0x3a3d44 });
  const lens = new THREE.Mesh(lensGeo, lensMat);
  lens.position.set(0, 0, -0.28);
  group.add(lens);

  group.translateZ(0.325);

  return group;
}
