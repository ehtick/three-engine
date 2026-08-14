// NOTE: strict type-checking intentionally not enabled here — ~35 pre-existing
// errors unrelated to events (the light union type doesn't narrow to
// SpotLight/DirectionalLight members), a follow-up.
import * as THREE from "three/webgpu";
import { PCFShadowFilter, float } from "three/tsl";
import { CSMShadowNode } from "three/addons/csm/CSMShadowNode.js";
import { Component } from "./Component.js";
import { PCSSShadowFilter } from "../pcssShadowFilter.js";

const SHADOW_TYPE_OPTIONS = [
  "BasicShadowMap",
  "PCFShadowMap",
  "PCFSoftShadowMap",
  "PCSSShadowMap",
  "VSMShadowMap",
];
const _ownerWorld = new THREE.Matrix4();
const _inverseOwnerWorld = new THREE.Matrix4();
const _worldRotation = new THREE.Quaternion();
const _direction = new THREE.Vector3();
const _lightWorld = new THREE.Vector3();
const _targetWorld = new THREE.Vector3();
const _cameraWorld = new THREE.Vector3();
const _shadowCentre = new THREE.Vector3();
const _shadowRight = new THREE.Vector3();
const _shadowUp = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);

export class LightComponent extends Component {
  /** Runtime CSMShadowNode — distinct from the authored boolean `props.csm`. */
  #csm = null;

  static type = "light";
  static label = "Light";
  static defaults = {
    kind: "directional",
    color: "#ffffff",
    intensity: 1,
    distance: 0, // point/spot: 0 = infinite
    angle: 45, // spot cone angle, degrees
    decay: 2, // physical light decay (point/spot). 0 = classic inverse-square-free.
    penumbra: 0, // spot: 0..1 softness at the cone edge
    castShadow: false,
    // map = three.js shadow maps (+CSM); gi = the GI module traces shadows from
    // the occupancy field (no shadow map allocated; falls back to maps
    // automatically if the GI module is absent).
    shadowMode: "map",
    // Angular DIAMETER of the source in degrees — Blender's sun "Angle" parity
    // (0.53° ≈ the real sun). Drives the GI penumbra softness for this light;
    // also used by gi shadow mode.
    sourceAngle: 0.53,
    // Shadow-map settings (per-light). Mirrors three.js Light.shadow.* fields.
    shadowMapType: "PCFSoftShadowMap",
    shadowMapWidth: 2048,
    shadowMapHeight: 2048,
    shadowBias: -0.0005,
    shadowNormalBias: 0.02,
    shadowRadius: 1, // PCF/VSM blur radius; PCSS directional source radius in world units
    // Directional / spot shadow camera (orthographic frustum).
    shadowCamNear: 0.1,
    shadowCamFar: 100,
    shadowCamSize: 20, // orthographic half-extent (left/right/top/bottom = ±size)
    shadowCamFov: 90, // point-light cube: face FOV in degrees
    // Directional-light CSM settings. CSMShadowNode is WebGPU-only.
    csm: false,
    csmCascades: 4,
    csmMaxFar: 1000,
    csmMode: "practical",
    csmSplitLambda: 0.9,
    csmLightMargin: 200,
    csmFade: true,
    // Directional shadow maps always recentre on the active camera (editor
    // orbit camera in edit mode, the play-mode camera during play). The
    // camera pose drives the orthographic frustum every pre-render so the
    // user can never orbit outside the shadow coverage.
  };
  // Schema entries with `showIf` are auto-filtered by the Inspector; see
  // ComponentSection. `section` is just a label prefix in the inspector.
  static schema = [
    { key: "kind", label: "Type", type: "select", options: ["directional", "point", "spot", "ambient"] },
    { key: "color", label: "Color", type: "color" },
    { key: "intensity", label: "Intensity", type: "number", min: 0, step: 0.1 },
    { key: "distance", label: "Distance", type: "number", min: 0, step: 0.5, showIf: (p) => p.kind === "point" || p.kind === "spot" },
    { key: "decay", label: "Decay", type: "number", min: 0, max: 5, step: 0.1, showIf: (p) => p.kind === "point" || p.kind === "spot" },
    { key: "angle", label: "Angle°", type: "number", min: 1, max: 90, step: 1, showIf: (p) => p.kind === "spot" },
    { key: "penumbra", label: "Penumbra", type: "number", min: 0, max: 1, step: 0.05, showIf: (p) => p.kind === "spot" },
    { key: "castShadow", label: "Cast Shadow", type: "boolean", showIf: (p) => p.kind !== "ambient" },
    { key: "shadowMode", label: "Shadow Source", type: "select", options: ["map", "gi"], showIf: (p) => p.kind !== "ambient" && p.castShadow, section: "Shadow" },
    // Angular size shapes the GI penumbra in BOTH modes (gi traces it directly;
    // map mode still feeds it to the GI bounce), so it is never gated on mode.
    // Up to 90° (Blender sun parity): beyond ~20° the softness comes from the
    // PCSS sample-time blur (radius = tan(half-angle) × blocker distance),
    // not the trace's cone estimator, which keeps its own internal clamp.
    { key: "sourceAngle", label: "Source Angle°", type: "number", min: 0, max: 90, step: 0.05, showIf: (p) => p.kind === "directional", section: "Shadow" },
    // Shadow-map controls. Master switch (castShadow) gates the rest via showIf
    // so the inspector stays tidy when shadows are off; `shadowMode === "gi"`
    // hides them too because no shadow map is rendered in that mode.
    { key: "shadowMapType", label: "Map Type", type: "select", options: SHADOW_TYPE_OPTIONS, showIf: (p) => p.kind !== "ambient" && p.castShadow && p.shadowMode !== "gi", section: "Shadow" },
    { key: "shadowMapWidth", label: "Map Width", type: "number", min: 16, step: 256, showIf: (p) => (p.kind !== "ambient" && p.castShadow && p.shadowMode !== "gi"), section: "Shadow" },
    { key: "shadowMapHeight", label: "Map Height", type: "number", min: 16, step: 256, showIf: (p) => (p.kind !== "ambient" && p.castShadow && p.shadowMode !== "gi"), section: "Shadow" },
    { key: "shadowBias", label: "Bias", type: "number", step: 0.0005, showIf: (p) => (p.kind !== "ambient" && p.castShadow && p.shadowMode !== "gi"), section: "Shadow" },
    { key: "shadowNormalBias", label: "Normal Bias", type: "number", step: 0.005, showIf: (p) => (p.kind !== "ambient" && p.castShadow && p.shadowMode !== "gi"), section: "Shadow" },
    // Point lights keep this row in gi mode: the GI side reuses it as the
    // point light's source RADIUS (its directional twin is `sourceAngle`).
    { key: "shadowRadius", label: "Radius / Light Size", type: "number", min: 0, step: 0.25, showIf: (p) => p.kind !== "ambient" && p.castShadow && (p.shadowMode !== "gi" || p.kind === "point"), section: "Shadow" },
    { key: "shadowCamNear", label: "Cam Near", type: "number", min: 0, step: 0.1, showIf: (p) => ((p.kind === "directional" || p.kind === "spot" || p.kind === "point") && p.castShadow && p.shadowMode !== "gi"), section: "Shadow" },
    { key: "shadowCamFar", label: "Cam Far", type: "number", min: 0, step: 1, showIf: (p) => ((p.kind === "directional" || p.kind === "spot" || p.kind === "point") && p.castShadow && p.shadowMode !== "gi"), section: "Shadow" },
    { key: "shadowCamSize", label: "Frustum Size", type: "number", min: 0.1, step: 1, showIf: (p) => ((p.kind === "directional" || p.kind === "spot") && p.castShadow && !p.csm && p.shadowMode !== "gi"), section: "Shadow" },
    { key: "shadowCamFov", label: "Face FOV°", type: "number", min: 1, max: 179, step: 1, showIf: (p) => (p.kind === "point" && p.castShadow && p.shadowMode !== "gi"), section: "Shadow" },
    { key: "csm", label: "Cascaded Shadows", type: "boolean", showIf: (p) => p.kind === "directional" && p.castShadow && p.shadowMode !== "gi", section: "Shadow" },
    { key: "csmCascades", label: "Cascades", type: "number", min: 2, max: 4, step: 1, showIf: (p) => p.kind === "directional" && p.castShadow && p.csm && p.shadowMode !== "gi", section: "CSM" },
    { key: "csmMaxFar", label: "CSM Max Far", type: "number", min: 1, step: 10, showIf: (p) => p.kind === "directional" && p.castShadow && p.csm && p.shadowMode !== "gi", section: "CSM" },
    { key: "csmMode", label: "Split Mode", type: "select", options: ["practical", "uniform", "logarithmic"], showIf: (p) => p.kind === "directional" && p.castShadow && p.csm && p.shadowMode !== "gi", section: "CSM" },
    { key: "csmSplitLambda", label: "Near Detail", type: "number", min: 0, max: 1, step: 0.05, showIf: (p) => p.kind === "directional" && p.castShadow && p.csm && p.csmMode === "practical" && p.shadowMode !== "gi", section: "CSM" },
    { key: "csmLightMargin", label: "Light Margin", type: "number", min: 0, step: 10, showIf: (p) => p.kind === "directional" && p.castShadow && p.csm && p.shadowMode !== "gi", section: "CSM" },
    { key: "csmFade", label: "Cascade Fade", type: "boolean", showIf: (p) => p.kind === "directional" && p.castShadow && p.csm && p.shadowMode !== "gi", section: "CSM" },
  ];

  onAttach() {
    this.#buildLight();
  }

  onDetach() {
    this.unsubPreRender?.();
    this.unsubPreRender = null;
    this.unsubRendererRebuilt?.();
    this.unsubRendererRebuilt = null;
    // Clears shadow.shadowNode only when it is OUR CSM node. A gi-mode light
    // carries the GI module's node in that slot; blanking it here would be
    // meddling with another module's state, and it is unnecessary — the light
    // itself is discarded below, and the GI module drops nodes for lights that
    // stop appearing in its per-frame scan.
    this.#disposeCSM();
    if (!this.light) return;
    if (this.light.target) this.entity.object3D.remove(this.light.target);
    this.entity.object3D.remove(this.light);
    this.light.dispose?.();
    this.light = null;
  }

  onDisable() {
    if (this.light) this.light.visible = false;
  }

  onEnable() {
    if (this.light) this.light.visible = true;
  }

  onPropChanged(key) {
    // Switching `kind` swaps the entire three.js light instance (point vs
    // spot vs directional have different constructors and shadow camera
    // shapes). Tear the old one down and rebuild from current props.
    // These settings change the composed lighting graph. Rebuild the light so
    // three.js cannot retain an AnalyticLightNode compiled against the old
    // custom shadow node (or its old cascade count/fade branch).
    if (
      key === "kind" ||
      key === "shadowMapType" ||
      key === "castShadow" ||
      key === "shadowMode" ||
      key === "csm" ||
      key === "csmCascades" ||
      key === "csmFade" ||
      !this.light
    ) {
      this.onDetach();
      this.#buildLight();
      return;
    }
    if (key === "csmMode" || key === "csmMaxFar" || key === "csmSplitLambda") {
      if (this.#csm) {
        this.#csm.maxFar = Math.max(1, this.props.csmMaxFar);
        this.#configureCSMSplits();
      }
      this.#syncCSMShadowDepth();
      this.#updateCSMFrustums(true);
      return;
    }
    if (key === "csmLightMargin") {
      if (this.#csm) this.#csm.lightMargin = Math.max(0, this.props.csmLightMargin);
      this.#syncCSMShadowDepth();
      this.#updateCSMFrustums(true);
      return;
    }
    // Angular size is pure GI-contract data: nothing in three.js reads it, so
    // republishing userData IS the whole update. Rebuilding the light for a
    // slider drag would drop the compiled shadow branch for no reason.
    if (key === "sourceAngle") {
      this.#publishGIShadowContract();
      return;
    }
    this.#applyShadowProp(key);
    // shadowRadius doubles as the point light's GI source radius — republish
    // after every non-rebuild change so the contract can never go stale.
    this.#publishGIShadowContract();
    this.#syncCSMCascadeShadows();
    if (key === "color") this.light.color.set(this.props.color);
    else if (key === "intensity") this.light.intensity = this.props.intensity;
    else if (key === "distance") {
      if ("distance" in this.light) this.light.distance = this.props.distance;
    } else if (key === "decay") {
      if ("decay" in this.light) this.light.decay = this.props.decay;
    } else if (key === "penumbra") {
      if ("penumbra" in this.light) this.light.penumbra = this.props.penumbra;
    } else if (key === "angle") {
      if (this.light.isSpotLight) this.light.angle = THREE.MathUtils.degToRad(this.props.angle);
    } else if (key in this.light) this.light[key] = this.props[key];
  }

  #buildLight() {
    const {
      kind,
      color,
      intensity,
      distance,
      angle,
      decay,
      penumbra,
      castShadow,
      shadowMapWidth,
      shadowMapHeight,
      shadowCamNear,
      shadowCamFar,
      shadowCamSize,
      shadowCamFov,
    } = this.props;

    switch (kind) {
      case "point":
        // PointLight: constructor (color, intensity, distance, decay).
        this.light = new THREE.PointLight(color, intensity, distance, decay);
        break;
      case "spot":
        // SpotLight: constructor (color, intensity, distance, angle, penumbra, decay).
        this.light = new THREE.SpotLight(
          color,
          intensity,
          distance,
          THREE.MathUtils.degToRad(angle),
          penumbra,
          decay,
        );
        break;
      case "ambient":
        this.light = new THREE.AmbientLight(color, intensity);
        break;
      case "directional":
      default:
        this.light = new THREE.DirectionalLight(color, intensity);
        break;
    }
    this.light.userData.entityId = this.entity.id;
    // Publish before anything reads it: #isCSMUsable and the gi-mode shadow
    // config below both branch on userData.giShadowMode.
    this.#publishGIShadowContract();
    if (this.light.shadow) {
      this.#configureShadow({
        shadowMapWidth,
        shadowMapHeight,
        shadowCamNear,
        shadowCamFar,
        shadowCamSize,
        shadowCamFov,
      });
      this.light.castShadow = !!castShadow;
      if (this.light.userData.giShadowMode === "gi") {
        // castShadow STAYS true — three only compiles a shadow branch for
        // shadow-casting lights, and the GI module's custom shadowNode
        // replaces the map lookup inside that branch (same mechanism as CSM
        // above, which also renders no map of its own).
        //
        // Belt-and-braces on the map itself: with a custom shadowNode three
        // skips map rendering entirely, but if the GI module is absent (or
        // hasn't claimed this light yet) three falls back to REAL shadow maps.
        // A frozen 16×16 map keeps that fallback nearly free and visibly soft
        // rather than silently shadowless.
        this.light.shadow.autoUpdate = false;
        this.light.shadow.mapSize.set(16, 16);
        // INERT PLACEHOLDER, assigned from frame 1 — not left for the GI
        // module's first light scan. A castShadow light with autoUpdate=false
        // and NO rendered map crashes three's `updateShadow`
        // (`shadow.map.depthTexture` on null) on every frame that renders it
        // without a custom shadowNode — which is exactly the window between
        // booting a scene SAVED with a gi-mode sun and the GI module's first
        // 250ms scan. A custom node makes three skip the map path entirely,
        // and `1` (unshadowed) is also the correct end state when the GI
        // module never claims the light at all. The module replaces this node
        // (and disposes the light's cached shadow branch) when it claims.
        this.light.shadow.shadowNode = float(1);
      }
    }
    this.entity.object3D.add(this.light);
    // Directional/spot lights aim at their target; keep the target with the entity
    // so rotating the entity re-aims the light.
    if (this.light.target) {
      this.light.target.position.set(0, 0, -1);
      this.entity.object3D.add(this.light.target);
    }
    // Resolve after scripts and physics have finalized this frame's camera
    // and entity transforms. The sync also pins the entity's world position
    // to the origin and resets parent scale so directional lights can only
    // be re-aimed via rotation. The shadow camera recentres on whichever
    // camera is currently active so the user never leaves the frustum.
    if (this.light.isDirectionalLight) {
      this.unsubPreRender = this.entity.engine.onPreRender(() => {
        this.#syncDirectionalTransform();
        if (!this.#csm && this.#isCSMUsable()) this.#syncCSM();
        this.#updateCSMFrustums();
      });
      this.unsubRendererRebuilt = this.entity.engine.on("renderer-rebuilt", () => {
        this.#syncCSM({ recreate: true });
        // AnalyticLightNode instances are cached by light UUID across renderer
        // lifetimes. Clear the cached shadow branch so the new renderer builds
        // against the replacement CSM node.
        this.light?.dispose?.();
      });
      this.#syncDirectionalTransform();
      this.#syncCSM();
    }
    // Honour the enabled flag at attach time.
    this.light.visible = this._enabled;
  }

  /**
   * The ENTIRE contract with the GI module: three fields on `light.userData`.
   * The GI module scans the scene's lights, honours `giShadowMode === "gi"` by
   * assigning its own `shadow.shadowNode`, and shapes the penumbra from the
   * angle/radius. This component never imports the GI module and the GI module
   * never imports this one — if it isn't installed the flags are simply inert
   * and three renders the (tiny) fallback map.
   */
  #publishGIShadowContract() {
    if (!this.light) return;
    const d = this.light.userData;
    d.giShadowMode =
      this.props.shadowMode === "gi" && this.props.castShadow && this.props.kind !== "ambient"
        ? "gi"
        : "map";
    // Authored as an angular DIAMETER in degrees (Blender's sun "Angle");
    // consumers want the half-angle in radians, so halve it here once.
    d.giSourceAngle = THREE.MathUtils.degToRad(Math.max(0, this.props.sourceAngle ?? 0.53)) / 2;
    // Point/spot sources have a world-space radius instead of an angular size,
    // and shadowRadius is the row the inspector already keeps visible for them.
    d.giSourceRadius = Math.max(0, this.props.shadowRadius ?? 0);
  }

  #syncDirectionalTransform() {
    if (!this.light?.isDirectionalLight || !this.light.target) return;

    const owner = this.entity.object3D;
    // Directional lights are infinite sources — their position is meaningless
    // (only the rotation defines the emitted direction). Pin the owner to the
    // world origin every frame so any external mutation (gizmo drag, script,
    // legacy scene data, parent transform) cannot move the light. Reset the
    // parent's scale too: a non-uniform parent scale would otherwise skew the
    // shadow-map frustum and tilt the apparent light direction.
    owner.position.set(0, 0, 0);
    owner.scale.set(1, 1, 1);
    owner.updateMatrixWorld(true);
    _ownerWorld.copy(owner.matrixWorld);
    _inverseOwnerWorld.copy(_ownerWorld).invert();
    owner.getWorldQuaternion(_worldRotation);
    _direction.set(0, 0, -1).applyQuaternion(_worldRotation).normalize();

    // Directional shadow coverage is always recentred on the currently active
    // camera (editor orbit camera in edit mode, the play-mode camera while
    // playing). Without this the user can orbit outside the shadow frustum
    // and every shadow on the screen appears clipped.
    const camera = this.entity.engine.camera;
    if (camera) {
      camera.getWorldPosition(_cameraWorld);
      _shadowCentre.copy(_cameraWorld);
      // Stabilize the orthographic projection: snap its lateral origin to
      // whole shadow-map texels so tiny camera movements do not make every
      // shadow edge crawl across the texture.
      _shadowRight.crossVectors(_direction, _worldUp);
      if (_shadowRight.lengthSq() < 1e-8) _shadowRight.set(1, 0, 0);
      else _shadowRight.normalize();
      _shadowUp.crossVectors(_shadowRight, _direction).normalize();
      const worldUnits = this.props.shadowCamSize * 2;
      const texelX = worldUnits / Math.max(1, this.props.shadowMapWidth);
      const texelY = worldUnits / Math.max(1, this.props.shadowMapHeight);
      const projectedX = _shadowCentre.dot(_shadowRight);
      const projectedY = _shadowCentre.dot(_shadowUp);
      _shadowCentre.addScaledVector(_shadowRight, Math.round(projectedX / texelX) * texelX - projectedX);
      _shadowCentre.addScaledVector(_shadowUp, Math.round(projectedY / texelY) * texelY - projectedY);
      // The orthographic shadow camera sees only forward along the light
      // direction. Put the view camera midway through its depth interval so
      // nearby casters are retained on both sides of the viewer.
      const depthCentre = (this.props.shadowCamNear + this.props.shadowCamFar) * 0.5;
      _lightWorld.copy(_shadowCentre).addScaledVector(_direction, -depthCentre);
    } else {
      _lightWorld.set(0, 0, 0);
    }

    _targetWorld.copy(_lightWorld).add(_direction);
    this.light.position.copy(_lightWorld).applyMatrix4(_inverseOwnerWorld);
    this.light.target.position.copy(_targetWorld).applyMatrix4(_inverseOwnerWorld);
    this.light.updateMatrix();
    this.light.target.updateMatrix();
  }

  // Map shadow-type name → three.js constant. Built lazily and reused.
  static #shadowTypeMap = null;
  static #getShadowTypeMap() {
    if (!this.#shadowTypeMap) {
      this.#shadowTypeMap = {
        BasicShadowMap: THREE.BasicShadowMap,
        PCFShadowMap: THREE.PCFShadowMap,
        PCFSoftShadowMap: THREE.PCFSoftShadowMap,
        PCSSShadowMap: THREE.PCFShadowMap,
        VSMShadowMap: THREE.VSMShadowMap,
      };
    }
    return this.#shadowTypeMap;
  }

  #isCSMUsable() {
    return (
      this.light?.isDirectionalLight === true &&
      this.props.csm === true &&
      this.props.castShadow === true &&
      // gi mode owns shadow.shadowNode; there is exactly one slot, so a CSM
      // node would fight the GI module's for it. Gating here (rather than at
      // the construction site) also stops the per-frame onPreRender resync
      // from building one behind our back.
      this.light.userData.giShadowMode !== "gi" &&
      this.entity.engine.renderer?.backend?.isWebGPUBackend === true
    );
  }

  #syncCSMShadowDepth() {
    if (!this.light?.isDirectionalLight || !this.light.shadow) return;
    const useCSM = this.#isCSMUsable();
    const far = useCSM
      ? Math.max(
          this.props.shadowCamFar,
          this.props.csmMaxFar + this.props.csmLightMargin * 2,
        )
      : this.props.shadowCamFar;
    const shadows = [
      this.light.shadow,
      ...(this.#csm?.lights?.map((cascadeLight) => cascadeLight.shadow) ?? []),
    ];
    for (const shadow of shadows) {
      if (shadow.camera.far === far) continue;
      shadow.camera.far = far;
      shadow.camera.updateProjectionMatrix();
      shadow.needsUpdate = true;
    }
  }

  #syncCSM({ recreate = false } = {}) {
    if (!this.light?.isDirectionalLight || !this.light.shadow) return;
    if (recreate) this.#disposeCSM();
    if (!this.#isCSMUsable()) {
      this.#disposeCSM();
      this.#syncCSMShadowDepth();
      return;
    }
    // CSMShadowNode clones the light shadow once per cascade. Expand the
    // source depth range first: each cascade is placed `lightMargin` behind
    // its covered volume, so cloning the normal 100-unit camera here would
    // clip every caster with the default 200-unit margin and yield blank maps.
    this.#syncCSMShadowDepth();
    if (!this.#csm) {
      if (
        this.props.shadowMapType === "PCFShadowMap" ||
        this.props.shadowMapType === "PCFSoftShadowMap"
      ) {
        // CSMShadowNode clones this filter during its lazy graph setup. It
        // must be present on the source before construction; changing a clone
        // after its ShadowNode has compiled would leave the old filter cached.
        this.light.shadow.filterNode = PCFShadowFilter;
      }
      this.#csm = new CSMShadowNode(this.light, {
        cascades: Math.min(4, Math.max(2, Math.round(this.props.csmCascades))),
        maxFar: Math.max(1, this.props.csmMaxFar),
        mode: this.props.csmMode === "practical" ? "custom" : this.props.csmMode,
        lightMargin: Math.max(0, this.props.csmLightMargin),
      });
      this.#csm.fade = this.props.csmFade === true;
      this.#configureCSMSplits();
    }
    this.light.shadow.shadowNode = this.#csm;
    this.light.shadow.needsUpdate = true;
    // CSMShadowNode initializes its internal frustum lazily during shader
    // setup. Until then, updateFrustums() would dereference mainFrustum=null.
    this.#updateCSMFrustums();
  }

  #disposeCSM() {
    if (!this.#csm) return;
    if (this.light?.shadow?.shadowNode === this.#csm) {
      this.light.shadow.shadowNode = undefined;
      this.light.shadow.needsUpdate = true;
    }
    this.#csm.dispose?.();
    this.#csm = null;
  }

  #configureCSMSplits() {
    if (!this.#csm) return;
    if (this.props.csmMode !== "practical") {
      this.#csm.mode = this.props.csmMode;
      return;
    }
    // Three's fixed 0.5 practical split gives a 1000-unit, four-cascade CSM
    // a roughly 125-unit first cascade. That wastes most near-map texels on
    // empty distance and makes indoor contact shadows look uniformly soft.
    // Keep the practical blend adjustable, but bias its default much closer
    // to logarithmic so resolution is concentrated around the viewer.
    this.#csm.mode = "custom";
    this.#csm.customSplitsCallback = (cascades, near, far, target) => {
      const lambda = THREE.MathUtils.clamp(this.props.csmSplitLambda, 0, 1);
      for (let i = 1; i <= cascades; i++) {
        const p = i / cascades;
        const uniform = (near + (far - near) * p) / far;
        const logarithmic = (near * (far / near) ** p) / far;
        target.push(THREE.MathUtils.lerp(uniform, logarithmic, lambda));
      }
    };
  }

  #syncCSMCascadeShadows() {
    if (!this.#csm?.lights?.length) return;
    const last = Math.max(1, this.#csm.lights.length - 1);
    const baseRadius = Math.max(0, this.props.shadowRadius);
    const baseBias = this.props.shadowBias;
    const baseNormalBias = Math.max(0, this.props.shadowNormalBias);
    for (let i = 0; i < this.#csm.lights.length; i++) {
      const shadow = this.#csm.lights[i].shadow;
      const t = i / last;
      let changed = false;

      // The upstream CSM clone multiplies bias by (cascade + 1), producing
      // detached far shadows and triangular light wedges at closed corners.
      // Use less bias in the high-resolution near maps and never exceed the
      // user's requested bias in the far map.
      const bias = baseBias * THREE.MathUtils.lerp(0.35, 1, t);
      const normalBias = baseNormalBias * THREE.MathUtils.lerp(0.2, 1, t);
      if (shadow.bias !== bias) {
        shadow.bias = bias;
        changed = true;
      }
      if (shadow.normalBias !== normalBias) {
        shadow.normalBias = normalBias;
        changed = true;
      }

      if (
        this.props.shadowMapType === "PCFShadowMap" ||
        this.props.shadowMapType === "PCFSoftShadowMap"
      ) {
        // PCFSoft's built-in WebGPU filter ignores LightShadow.radius. Use
        // the radius-aware PCF filter so near cascades stay contact-sharp and
        // the increasingly coarse far cascades receive a wider stable kernel.
        if (shadow.filterNode !== PCFShadowFilter) {
          shadow.filterNode = PCFShadowFilter;
          changed = true;
        }
        const radius = baseRadius * THREE.MathUtils.lerp(0.3, 2.5, t ** 1.5);
        if (shadow.radius !== radius) {
          shadow.radius = radius;
          changed = true;
        }
      }
      if (changed) shadow.needsUpdate = true;
    }
  }

  #updateCSMFrustums(force = false) {
    if (!this.#isCSMUsable() || !this.#csm) return;
    const camera = this.entity.engine.camera;
    if (!camera) return;
    camera.updateMatrixWorld(true);
    if (this.#csm.mainFrustum === null) return;
    if (this.#csm.camera !== camera) {
      this.#csm.camera = camera;
      force = true;
    }
    this.#csm.lightMargin = Math.max(0, this.props.csmLightMargin);
    this.#syncCSMCascadeShadows();
    if (force || this.#csm.camera === camera) this.#csm.updateFrustums();
  }

  #configureShadow({ shadowMapWidth, shadowMapHeight, shadowCamNear, shadowCamFar, shadowCamSize, shadowCamFov }) {
    const s = this.light.shadow;
    // mapSize is a Vector2 — set both axes separately; for point lights both
    // must match (cube faces are square).
    s.mapSize.set(shadowMapWidth, shadowMapHeight);
    s.bias = this.props.shadowBias;
    s.normalBias = this.props.shadowNormalBias;
    s.radius = this.props.shadowRadius;
    // Scene Settings' "shadow auto update" lives on the PER-LIGHT shadow in the
    // WebGPU path (ShadowNode gates on `shadow.needsUpdate || shadow.autoUpdate`;
    // renderer.shadowMap.autoUpdate is never read). applySettingsToScene mirrors
    // it onto existing lights — a light created afterwards must read it here or
    // it silently re-renders its map every frame regardless of the setting.
    // gi-mode lights are re-frozen right after this call (their 16x16 map never
    // renders), so initializing from settings here is safe for them too.
    const shadowSettings = this.entity?.engine?.settings?.shadow;
    if (shadowSettings) {
      s.autoUpdate = shadowSettings.autoUpdate !== false;
      s.needsUpdate = true;
    }
    const typeMap = LightComponent.#getShadowTypeMap();
    if (this.props.shadowMapType in typeMap) {
      s.type = typeMap[this.props.shadowMapType];
    }
    s.filterNode =
      this.props.shadowMapType === "PCSSShadowMap" &&
      this.light.isDirectionalLight
        ? PCSSShadowFilter
        : undefined;
    const cam = s.camera;
    if (this.light.isDirectionalLight || this.light.isSpotLight) {
      // Orthographic frustum: ±shadowCamSize on each side.
      cam.left = -shadowCamSize;
      cam.right = shadowCamSize;
      cam.top = shadowCamSize;
      cam.bottom = -shadowCamSize;
      cam.near = shadowCamNear;
      cam.far = shadowCamFar;
      cam.updateProjectionMatrix();
    } else if (this.light.isPointLight) {
      // Point lights render to a cube map with a perspective camera.
      cam.near = shadowCamNear;
      cam.far = shadowCamFar;
      cam.fov = Math.min(179, Math.max(1, shadowCamFov));
      cam.updateProjectionMatrix();
    }
  }

  #applyShadowProp(key) {
    const s = this.light?.shadow;
    if (!s) return;
    switch (key) {
      case "shadowMapWidth":
      case "shadowMapHeight":
        s.mapSize.set(this.props.shadowMapWidth, this.props.shadowMapHeight);
        s.map?.dispose?.();
        break;
      case "shadowBias":
        s.bias = this.props.shadowBias;
        break;
      case "shadowNormalBias":
        s.normalBias = this.props.shadowNormalBias;
        break;
      case "shadowRadius":
        s.radius = this.props.shadowRadius;
        break;
      case "shadowMapType": {
        const map = LightComponent.#getShadowTypeMap();
        s.type = map[this.props.shadowMapType] ?? THREE.PCFSoftShadowMap;
        s.filterNode =
          this.props.shadowMapType === "PCSSShadowMap" &&
          this.light.isDirectionalLight
            ? PCSSShadowFilter
            : undefined;
        // PCFSoft / VSM cache depth/blur textures; dispose to force reallocate
        // on the new type so the next frame doesn't render with stale data.
        s.dispose?.();
        break;
      }
      case "shadowCamNear":
      case "shadowCamFar":
      case "shadowCamSize":
      case "shadowCamFov": {
        const cam = s.camera;
        if (this.light.isDirectionalLight || this.light.isSpotLight) {
          const size = this.props.shadowCamSize;
          cam.left = -size;
          cam.right = size;
          cam.top = size;
          cam.bottom = -size;
          cam.near = this.props.shadowCamNear;
          cam.far = this.props.shadowCamFar;
          cam.updateProjectionMatrix();
        } else if (this.light.isPointLight) {
          cam.near = this.props.shadowCamNear;
          cam.far = this.props.shadowCamFar;
          cam.fov = this.props.shadowCamFov;
          cam.updateProjectionMatrix();
        }
        break;
      }
    }
  }
}
