import * as THREE from "three/webgpu";
import { Component } from "./Component.js";
import { loadMaterialAsset, getDefaultMaterial } from "../materialAsset.js";
import { resolveSpline } from "./SplineComponent.js";
import { SplineFrame } from "../spline/splineMath.js";
import { bakeMatrixIntoGeometry, relativeMatrix } from "../geometryTransform.js";

/**
 * Hardware-instanced duplicates of a source mesh (Blender Array modifier +
 * Hair-particle-style scatter). Reads the geometry from the entity's own
 * MeshComponent or ModelComponent (first mesh found) — if neither is present
 * (or a ModelComponent's .glb hasn't finished loading yet), the component
 * stays inert and retries once the model loads. One component per entity,
 * because there is only one source mesh per entity to instance; for multiple
 * instance groups use child entities.
 *
 * Two distribution paradigms share a single THREE.InstancedMesh back-end:
 *
 *   mode = "array"   — Array modifier: count copies along a per-step offset
 *                      (position/rotation/scale). With just three offset vec3s
 *                      and a count you can build linear stacks, grids,
 *                      circles, spirals, helices, etc. Seeded RNG mixes jitter.
 *
 *   mode = "path"    — Copies distributed along a Spline: fence posts, railway
 *                      sleepers, street lights, bollards, a hedge, rocks down a
 *                      riverbank. Either a fixed count spread evenly by ARC
 *                      LENGTH, or one every N units. Instances can be oriented
 *                      by the path's frame, so a fence follows its corners and
 *                      a banked guardrail leans with the road.
 *
 *   mode = "scatter" — Hair-particle-style random scattering inside a shape:
 *                      sphere, box, circle, disc, or on the surface of a mesh
 *                      (own or another entity's — Mesh or Model component).
 *                      Seeded RNG so reloads reproduce layout.
 *
 * onMesh surface scattering (scatterShape = "onMesh") has two modes:
 *   scatterSurfaceMode = "whole"     — area-weighted across every face of the
 *                                      target (trees over a whole terrain,
 *                                      spikes over a whole mine hull).
 *   scatterSurfaceMode = "projected" — random points inside a circle or rect
 *                                      are raycast onto the target along a
 *                                      chosen axis (x/y/z), like dropping
 *                                      seeds from above onto terrain within a
 *                                      radius. Samples that miss the surface
 *                                      are skipped (fewer instances than
 *                                      `count`, never a crash).
 *
 * Per-instance variation (both modes):
 *   - random rotation around Y (or full) — rotationJitter
 *   - random uniform scale — scaleJitter
 *   - align to surface normal — onMesh mode only
 *
 * Material is the source mesh's material by default, or a .mat asset if the
 * `material` prop is set. Materials are shared — never disposed by us.
 */
const MODES = ["array", "path", "scatter"];
const SCATTER_SHAPES = ["sphere", "box", "circle", "disc", "onMesh"];

export class InstancerComponent extends Component {
  static type = "instancer";
  static label = "Instancer";
  static defaults = {
    mode: "array", // "array" | "scatter"
    count: 10,
    seed: 0,

    // Array-mode: per-step offset applied to instance i (i ∈ [0, count)).
    // instance_i = T * instance_{i-1} where T = compose(offsetPos, offsetRot, offsetScale).
    arrayOffsetPosition: [1, 0, 0],
    arrayOffsetRotation: [0, 0, 0], // degrees (Euler XYZ), converted to radians on use
    arrayOffsetScale: [0, 0, 0], // additive, e.g. -0.05 = shrink 5% per step

    // Path-mode: distribute along a Spline component's curve.
    pathEntity: "", // empty = the Spline on this entity
    // "count": `count` copies spread evenly by arc length.
    // "spacing": one copy every `pathSpacing` units — the mode a fence wants,
    // because adding a corner should add posts, not respace the existing ones.
    pathDistribution: "count",
    pathSpacing: 2,
    pathAlign: "tangent", // "none" | "tangent" | "frame"
    pathForward: "-Z",
    pathOffset: [0, 0, 0], // in the path's frame: [across, up, along]
    pathJitter: [0, 0, 0], // ± random offset in the same frame

    // Scatter-mode: random distribution shape.
    scatterShape: "sphere", // "sphere" | "box" | "circle" | "disc" | "onMesh"
    scatterSize: [1, 1, 1], // [radius] for sphere/circle/disc; [hx, hy, hz] for box; ignored for onMesh
    scatterAlignToNormal: false, // only meaningful for "onMesh"

    // "onMesh" only: scatter across a target mesh (Mesh or Model component),
    // owned either by this entity or another entity in the scene. Empty
    // entity id = use this entity's own Mesh/Model.
    scatterSurfaceEntity: "",
    scatterSurfaceMode: "whole", // "whole" | "projected" — only meaningful when scatterShape === "onMesh"
    // "projected": random points in a circle/rect are raycast onto the
    // surface along `scatterProjectedAxis`, like dropping seeds from above.
    scatterProjectedShape: "circle", // "circle" | "rect"
    scatterProjectedAxis: "y", // "x" | "y" | "z" — axis the rays are cast along
    scatterProjectedSize: [1, 1, 0], // [radius] for circle; [halfX, halfZ] for rect (world units)
    scatterSurfaceCenter: [0, 0, 0], // world-space center of the projected shape

    // Per-instance jitter (both modes).
    rotationJitter: 0, // 0 = none, 1 = full random orientation, 0..1 blends with Y-only random
    scaleJitter: 0, // ± fraction (e.g. 0.2 = ±20% random scale)

    // Bake the source mesh's own transform (its matrix relative to this
    // entity) into the instanced geometry. See #resolveGeometry.
    bakeSourceTransform: false,

    // Material override. Empty string means "use the source mesh's material".
    material: "",

    castShadow: true,
    receiveShadow: true,
  };

  static schema = [
    { key: "mode", label: "Mode", type: "select", options: MODES },
    // In path/spacing mode this doubles as the allocation ceiling rather than
    // the number placed: the InstancedMesh is sized once at attach, and a path
    // someone later stretches to ten times its length must not be able to run
    // past its own buffer.
    { key: "count", label: "Count", type: "number", min: 1, max: 1_000_000, step: 1 },
    { key: "seed", label: "Seed", type: "number", min: 0, step: 1 },

    // Path-mode fields.
    { key: "pathEntity", label: "Path", type: "entity", showIf: (p) => p.mode === "path" },
    { key: "pathDistribution", label: "Distribution", type: "select", options: ["count", "spacing"], showIf: (p) => p.mode === "path" },
    { key: "pathSpacing", label: "Spacing", type: "number", min: 0.01, step: 0.1, showIf: (p) => p.mode === "path" && p.pathDistribution === "spacing" },
    { key: "pathAlign", label: "Align", type: "select", options: ["none", "tangent", "frame"], showIf: (p) => p.mode === "path" },
    { key: "pathForward", label: "Forward Axis", type: "select", options: ["-Z", "+Z"], showIf: (p) => p.mode === "path" && p.pathAlign !== "none" },
    { key: "pathOffset", label: "Offset", type: "vec3", showIf: (p) => p.mode === "path" },
    { key: "pathJitter", label: "Offset Jitter", type: "vec3", showIf: (p) => p.mode === "path" },

    // Array-mode fields (showIf: mode === "array").
    { key: "arrayOffsetPosition", label: "Offset Position", type: "vec3", showIf: (p) => p.mode === "array" },
    { key: "arrayOffsetRotation", label: "Offset Rotation", type: "vec3", showIf: (p) => p.mode === "array" },
    { key: "arrayOffsetScale", label: "Offset Scale", type: "vec3", showIf: (p) => p.mode === "array" },

    // Scatter-mode fields (showIf: mode === "scatter").
    { key: "scatterShape", label: "Shape", type: "select", options: SCATTER_SHAPES, showIf: (p) => p.mode === "scatter" },
    { key: "scatterSize", label: "Size", type: "vec3", showIf: (p) => p.mode === "scatter" && p.scatterShape !== "onMesh" },
    { key: "scatterAlignToNormal", label: "Align to Normal", type: "boolean", showIf: (p) => p.mode === "scatter" && p.scatterShape === "onMesh" },
    // Surface-target controls (only when scatterShape === "onMesh").
    { key: "scatterSurfaceEntity", label: "Surface Entity", type: "text", showIf: (p) => p.mode === "scatter" && p.scatterShape === "onMesh" },
    { key: "scatterSurfaceMode", label: "Surface Mode", type: "select", options: ["whole", "projected"], showIf: (p) => p.mode === "scatter" && p.scatterShape === "onMesh" },
    { key: "scatterProjectedShape", label: "Projected Shape", type: "select", options: ["circle", "rect"], showIf: (p) => p.mode === "scatter" && p.scatterShape === "onMesh" && p.scatterSurfaceMode === "projected" },
    { key: "scatterProjectedAxis", label: "Projection Axis", type: "select", options: ["x", "y", "z"], showIf: (p) => p.mode === "scatter" && p.scatterShape === "onMesh" && p.scatterSurfaceMode === "projected" },
    { key: "scatterProjectedSize", label: "Projected Size", type: "vec3", showIf: (p) => p.mode === "scatter" && p.scatterShape === "onMesh" && p.scatterSurfaceMode === "projected" },
    { key: "scatterSurfaceCenter", label: "Center", type: "vec3", showIf: (p) => p.mode === "scatter" && p.scatterShape === "onMesh" && p.scatterSurfaceMode === "projected" },

    // Both modes.
    { key: "rotationJitter", label: "Rotation Jitter", type: "number", min: 0, max: 1, step: 0.05 },
    { key: "scaleJitter", label: "Scale Jitter", type: "number", min: 0, max: 1, step: 0.05 },
    { key: "bakeSourceTransform", label: "Bake Source Transform", type: "boolean" },
    { key: "material", label: "Material Override", type: "asset", exts: ["mat"] },
    { key: "castShadow", label: "Cast Shadow", type: "boolean" },
    { key: "receiveShadow", label: "Receive Shadow", type: "boolean" },
  ];

  onAttach() {
    // Re-entrant: the model-loaded retry below can fire while we're already
    // attached (e.g. the surface target's model loads after ours). Tear down
    // the stale InstancedMesh first so we never leak a duplicate.
    if (this.instancedMesh) this.#teardownMesh();

    // Both the source mesh (this entity) and the scatter target (possibly
    // another entity) may be backed by a ModelComponent whose .glb is still
    // loading. Re-run onAttach once either finishes loading.
    this._unsubModelLoaded?.();
    this._unsubModelLoaded = this.entity.engine?.on?.("model-loaded", (loadedEntity) => {
      const targetId = this.props.scatterSurfaceEntity;
      if (loadedEntity === this.entity || (targetId && loadedEntity?.id === targetId)) {
        this.onAttach();
      }
    });

    const sourceMesh = getPrimarySourceMesh(this.entity);
    if (!sourceMesh) {
      if (!isModelPending(this.entity)) {
        console.warn(
          `InstancerComponent on entity "${this.entity.name ?? this.entity.id}" requires a Mesh or Model component with a loaded mesh. Add one first.`,
        );
      }
      this.instancedMesh = null;
      return;
    }

    const maxCount = Math.max(1, Math.floor(this.props.count));

    const { geometry, owned } = this.#resolveGeometry(sourceMesh);
    this.instancedMesh = new THREE.InstancedMesh(geometry, sourceMesh.material, maxCount);
    this.instancedMesh.userData.entityId = this.entity.id;
    this.instancedMesh.castShadow = !!this.props.castShadow;
    this.instancedMesh.receiveShadow = !!this.props.receiveShadow;
    // We never dispose the SOURCE's geometry — the mesh component owns that.
    // A baked copy, on the other hand, is ours alone and must be released.
    this._ownsGeometry = owned;

    // When the thing being distributed over lives on a different entity —
    // a scatter target, or a path — instances must live in world space so they
    // follow THAT entity's transform. We park the InstancedMesh directly under
    // the engine scene in those cases. Self-targeted and untargeted modes keep
    // the original parent so the Instancer entity's transform still moves the
    // instances.
    let foreign = null;
    if (this.props.mode === "path") {
      const path = resolveSpline(this.entity, this.props.pathEntity);
      foreign = path && path.entity !== this.entity ? path.entity : null;
    } else {
      const targetEntityId = this.props.scatterSurfaceEntity;
      const targetEntity = targetEntityId ? this.entity?.engine?.getEntity?.(targetEntityId) : null;
      foreign = targetEntity && targetEntity !== this.entity ? targetEntity : null;
    }
    this._parent = foreign ? this.entity.engine.scene : this.entity.object3D;

    // Dragging a knot must move the fence posts with the fence. Coalesced to
    // the next frame, so a drag re-lays them once per frame rather than once
    // per pointer event.
    this._unsubSpline?.();
    this._unsubSpline =
      this.props.mode === "path"
        ? this.entity.engine?.on?.("spline-changed", () => this.#invalidateLayout())
        : null;

    this.#fillMatrices(maxCount);

    if (this.props.material) this.#loadSharedMaterial(this.props.material);
    else this.instancedMesh.material = sourceMesh.material;

    this._parent.add(this.instancedMesh);
    this.instancedMesh.visible = this._enabled;
  }

  onDetach() {
    this._unsubModelLoaded?.();
    this._unsubModelLoaded = null;
    this._unsubSpline?.();
    this._unsubSpline = null;
    this._unsubRelayout?.();
    this._unsubRelayout = null;
    this.#teardownMesh();
  }

  /**
   * Re-lays the instances next frame, without rebuilding the InstancedMesh.
   *
   * A full detach/attach would re-allocate the buffer and re-resolve the
   * material on every frame of a knot drag; the layout is the only thing a
   * path edit changes, and the allocation is already sized for the ceiling.
   */
  #invalidateLayout() {
    if (this._unsubRelayout || !this.instancedMesh || !this.entity?.engine) return;
    this._unsubRelayout = this.entity.engine.onPreRender(() => {
      this._unsubRelayout?.();
      this._unsubRelayout = null;
      if (this.instancedMesh) this.#fillMatrices(Math.max(1, Math.floor(this.props.count)));
    });
  }

  #teardownMesh() {
    if (!this.instancedMesh) return;
    this.sharedGeneration = (this.sharedGeneration ?? 0) + 1;
    this._parent?.remove(this.instancedMesh);
    this._parent = null;
    if (this._ownsGeometry) this.instancedMesh.geometry.dispose();
    this.instancedMesh = null;
  }

  onDisable() {
    if (this.instancedMesh) this.instancedMesh.visible = false;
  }

  onEnable() {
    if (this.instancedMesh) this.instancedMesh.visible = true;
  }

  /**
   * The geometry the instances are drawn from.
   *
   * By default it is the source mesh's raw geometry, which is right for a Mesh
   * component (its mesh sits at the entity's origin) and WRONG for a Model: a
   * glTF's meshes are nodes in a hierarchy, routinely carrying a rotation, a
   * scale and an offset of their own — the +Z/+Y axis conversion alone puts one
   * on most imported models. Instancing the raw buffer throws all of that away,
   * so every copy comes out rotated, mis-sized or displaced relative to the
   * model standing right next to it, with nothing in the inspector to explain
   * why. `bakeSourceTransform` folds that matrix into a private copy of the
   * geometry instead.
   *
   * It is a copy, not a mutation: the source mesh is still being rendered from
   * the same buffer, and baking in place would move the model itself.
   */
  #resolveGeometry(sourceMesh) {
    if (!this.props.bakeSourceTransform) return { geometry: sourceMesh.geometry, owned: false };
    // The matrix RELATIVE to this entity, not the world one: the InstancedMesh
    // is parented under the entity (or, for a foreign target, under the scene
    // with the same conversion applied per instance), so folding in the
    // entity's own transform would apply it twice.
    const relative = relativeMatrix(sourceMesh, this.entity.object3D);
    if (!relative) return { geometry: sourceMesh.geometry, owned: false };
    // Shared with Apply Transform, winding flip included: a mirrored source
    // (negative scale on a glTF node is common) keeps its winding through
    // `applyMatrix4` and renders inside-out with perfectly good normals.
    return { geometry: bakeMatrixIntoGeometry(sourceMesh.geometry, relative), owned: true };
  }

  /**
   * Bumps the seed by 1 and rebuilds matrices — handy editor button so the
   * user can re-roll the random layout without typing a new seed.
   */
  regenerate() {
    this.props.seed = (this.props.seed ?? 0) + 1;
    this.onDetach();
    this.onAttach();
    this.entity?.engine?.emit?.("component-changed", {
      entityId: this.entity?.id,
      componentType: this.type,
      key: "seed",
    });
    this.entity?.engine?.emit?.("hierarchy-changed");
  }

  async #loadSharedMaterial(path) {
    const generation = (this.sharedGeneration = (this.sharedGeneration ?? 0) + 1);
    const shared = await loadMaterialAsset(path);
    if (generation !== this.sharedGeneration || !this.instancedMesh) return;
    this.instancedMesh.material = shared;
  }

  onPropChanged(key) {
    if (!this.instancedMesh) {
      // No source mesh yet — re-attaching will rebuild once a Mesh/Model component appears.
      if (key === "mode" || key === "count" || key === "seed" ||
          key === "arrayOffsetPosition" || key === "arrayOffsetRotation" || key === "arrayOffsetScale" ||
          key === "pathEntity" || key === "pathDistribution" || key === "pathSpacing" ||
          key === "pathAlign" || key === "pathForward" || key === "pathOffset" || key === "pathJitter" ||
          key === "scatterShape" || key === "scatterSize" || key === "scatterAlignToNormal" ||
          key === "scatterSurfaceEntity" || key === "scatterSurfaceMode" ||
          key === "scatterProjectedShape" || key === "scatterProjectedAxis" ||
          key === "scatterProjectedSize" || key === "scatterSurfaceCenter" ||
          key === "rotationJitter" || key === "scaleJitter" || key === "bakeSourceTransform") {
        this.onAttach();
        return;
      }
      if (key === "castShadow" || key === "receiveShadow") return;
      return;
    }
    if (key === "material") {
      this.sharedGeneration = (this.sharedGeneration ?? 0) + 1;
      if (this.props.material) this.#loadSharedMaterial(this.props.material);
      else {
        const src = getPrimarySourceMesh(this.entity);
        this.instancedMesh.material = src?.material ?? getDefaultMaterial();
      }
      return;
    }
    if (key === "castShadow" || key === "receiveShadow") {
      this.instancedMesh[key] = !!this.props[key];
      return;
    }
    // Anything that affects the layout / count: full rebuild.
    this.onDetach();
    this.onAttach();
  }

  // ---------------------------------------------------------------------------
  // Matrix layout
  // ---------------------------------------------------------------------------

  #fillMatrices(count) {
    const mesh = this.instancedMesh;
    const rng = makeRng(this.props.seed ?? 0);

    const tmp = new THREE.Matrix4();
    const tmpPos = new THREE.Vector3();
    const tmpQuat = new THREE.Quaternion();
    const tmpScale = new THREE.Vector3(1, 1, 1);

    if (this.props.mode === "array") {
      const offPos = new THREE.Vector3().fromArray(vec3From(this.props.arrayOffsetPosition, 1, 0, 0));
      const offRotDeg = vec3From(this.props.arrayOffsetRotation, 0, 0, 0);
      const offScale = new THREE.Vector3().fromArray(vec3From(this.props.arrayOffsetScale, 0, 0, 0));

      const pos = new THREE.Vector3(0, 0, 0);
      const quat = new THREE.Quaternion();
      const scale = new THREE.Vector3(1, 1, 1);
      const offQuat = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          THREE.MathUtils.degToRad(offRotDeg[0]),
          THREE.MathUtils.degToRad(offRotDeg[1]),
          THREE.MathUtils.degToRad(offRotDeg[2]),
          "XYZ",
        ),
      );

      const hasOffsetRotation = offRotDeg[0] || offRotDeg[1] || offRotDeg[2];
      const hasOffsetScale = offScale.x || offScale.y || offScale.z;

      for (let i = 0; i < count; i++) {
        composeInto(tmp, pos, quat, scale);
        applyJitter(tmp, this.props, rng);
        mesh.setMatrixAt(i, tmp);

        // Step the instance transform: rotation accumulated first (so the
        // subsequent position offset is rotated into the new local frame —
        // this is what makes spirals, helices, and circles work). Scale
        // accumulates additively (e.g. -0.05 per step → shrink 5% per copy).
        if (hasOffsetRotation) quat.multiply(offQuat);
        // Rotate the offset position by the current orientation, then translate.
        pos.add(offPos.clone().applyQuaternion(quat));
        if (hasOffsetScale) {
          scale.x += offScale.x;
          scale.y += offScale.y;
          scale.z += offScale.z;
        }
      }
    } else if (this.props.mode === "path") {
      this.#fillPathMatrices(mesh, count, rng);
      return;
    } else if (this.props.scatterShape === "onMesh") {
      // Surface scatter: sample points on a target mesh (Mesh or Model
      // component, own or foreign entity). Sampling always happens in world
      // space so self vs. foreign and Mesh vs. Model all share one code path;
      // results are then converted into this._parent's local space, which is
      // exactly what `setMatrixAt` needs.
      const meshes = resolveSurfaceMeshes(this.entity, this.props);
      const alignToNormal = !!this.props.scatterAlignToNormal;
      const surfaceMode = this.props.scatterSurfaceMode ?? "whole";
      const worldSampler = meshes.length
        ? (surfaceMode === "projected"
          ? makeProjectedSurfaceSampler(meshes, this.props)
          : makeWholeSurfaceSampler(meshes))
        : null;

      if (!worldSampler) {
        mesh.count = 0;
        mesh.instanceMatrix.needsUpdate = true;
        return;
      }

      this._parent.updateWorldMatrix(true, false);
      const parentInverse = new THREE.Matrix4().copy(this._parent.matrixWorld).invert();
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(parentInverse);
      const tmpNormal = new THREE.Vector3();

      // Projected sampling can miss the surface (a point in the shape may not
      // land on any triangle) — retry with fresh samples up to a budget, then
      // settle for however many instances actually landed.
      const maxAttempts = surfaceMode === "projected" ? count * 8 : count;
      let placed = 0;
      let attempts = 0;
      while (placed < count && attempts < maxAttempts) {
        attempts++;
        const sample = worldSampler(rng);
        if (!sample) continue;
        const [wx, wy, wz, wnx, wny, wnz] = sample;
        tmpPos.set(wx, wy, wz).applyMatrix4(parentInverse);

        if (alignToNormal) {
          tmpNormal.set(wnx, wny, wnz).applyMatrix3(normalMatrix).normalize();
          tmpQuat.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tmpNormal);
        } else {
          tmpQuat.identity();
        }

        tmpScale.set(1, 1, 1);
        composeInto(tmp, tmpPos, tmpQuat, tmpScale);
        applyJitter(tmp, this.props, rng);
        mesh.setMatrixAt(placed, tmp);
        placed++;
      }

      mesh.count = placed;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.frustumCulled = true;
      return;
    } else {
      // Free-space scatter: sphere / box / circle / disc around the origin.
      const shape = this.props.scatterShape ?? "sphere";
      const size = vec3From(this.props.scatterSize, 1, 1, 1);

      for (let i = 0; i < count; i++) {
        const [px, py, pz] = samplePoint(shape, size, rng);
        tmpPos.set(px, py, pz);
        tmpQuat.identity();
        tmpScale.set(1, 1, 1);
        composeInto(tmp, tmpPos, tmpQuat, tmpScale);
        applyJitter(tmp, this.props, rng);
        mesh.setMatrixAt(i, tmp);
      }
    }

    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.frustumCulled = true;
  }

  /**
   * Distributes instances along a Spline (roadmap item 16).
   *
   * Positions are spaced by ARC LENGTH, never by the curve's parameter — the
   * whole point of a fence is that its posts are evenly spaced, and parameter
   * spacing bunches them up wherever a segment happens to be short.
   *
   * `count` distribution divides the path into equal shares; `spacing` places
   * one every N units and lets the number follow the length. The second is what
   * a fence actually wants: adding a corner should add posts, not respace every
   * post already placed.
   */
  #fillPathMatrices(mesh, maxCount, rng) {
    const path = resolveSpline(this.entity, this.props.pathEntity);
    if (!path?.spline?.valid) {
      // Half-wired (no path yet, or one knot) draws nothing rather than piling
      // every instance on the origin, which looks like a broken source mesh.
      mesh.count = 0;
      mesh.instanceMatrix.needsUpdate = true;
      return;
    }
    const foreign = path.entity !== this.entity;
    const length = path.length;
    const closed = path.closed;

    const distances = [];
    if (this.props.pathDistribution === "spacing") {
      const spacing = Math.max(0.01, this.props.pathSpacing ?? 1);
      const n = Math.min(maxCount, Math.floor(length / spacing) + 1);
      for (let i = 0; i < n; i++) distances.push(i * spacing);
    } else {
      const n = Math.max(1, maxCount);
      // A closed path divides by n, not n-1: its last position would otherwise
      // land exactly on top of the first, giving a fence with two posts in one
      // hole and a visible gap opposite.
      const divisor = closed ? n : Math.max(1, n - 1);
      for (let i = 0; i < n; i++) distances.push((i / divisor) * length);
    }

    let parentInverse = null;
    let parentQuat = null;
    if (foreign) {
      this._parent.updateWorldMatrix(true, false);
      parentInverse = _matrix.copy(this._parent.matrixWorld).invert();
      parentQuat = new THREE.Quaternion().setFromRotationMatrix(parentInverse);
    }

    const align = this.props.pathAlign ?? "tangent";
    const offset = vec3From(this.props.pathOffset, 0, 0, 0);
    const jitter = vec3From(this.props.pathJitter, 0, 0, 0);
    const tmp = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);
    const dir = new THREE.Vector3();
    const up = new THREE.Vector3();
    const right = new THREE.Vector3();
    const back = new THREE.Vector3();

    for (let i = 0; i < distances.length; i++) {
      // The frame is asked for in the space the instances will live in: the
      // path's own when it is this entity's, world when it is somebody else's.
      const frame = foreign ? path.worldFrameAt(distances[i], _frame) : path.frameAt(distances[i], _frame);
      // Jitter is drawn per instance in the FRAME's axes, so "spread these
      // rocks two metres either side of the river" stays two metres either side
      // of the river round every bend.
      pos
        .copy(frame.position)
        .addScaledVector(frame.binormal, offset[0] + (rng() * 2 - 1) * jitter[0])
        .addScaledVector(frame.normal, offset[1] + (rng() * 2 - 1) * jitter[1])
        .addScaledVector(frame.tangent, offset[2] + (rng() * 2 - 1) * jitter[2]);

      if (align === "none") {
        quat.identity();
      } else {
        if (align === "tangent") {
          // Yaw only: a fence post follows the corners and stays vertical even
          // where the path climbs. `frame` is the one that leans with a banked
          // road, which is what a guardrail wants and a lamp post does not.
          dir.copy(frame.tangent);
          dir.y = 0;
          if (dir.lengthSq() < 1e-8) dir.copy(frame.binormal).setY(0);
          if (dir.lengthSq() < 1e-8) dir.set(0, 0, 1);
          dir.normalize();
          up.set(0, 1, 0);
        } else {
          dir.copy(frame.tangent);
          up.copy(frame.normal);
        }
        if (this.props.pathForward === "+Z") {
          right.copy(up).cross(dir).normalize();
          tmp.makeBasis(right, up, dir);
        } else {
          right.copy(dir).cross(up).normalize();
          tmp.makeBasis(right, up, back.copy(dir).negate());
        }
        quat.setFromRotationMatrix(tmp);
      }

      if (foreign) {
        pos.applyMatrix4(parentInverse);
        quat.premultiply(parentQuat);
      }
      scale.set(1, 1, 1);
      composeInto(tmp, pos, quat, scale);
      applyJitter(tmp, this.props, rng);
      mesh.setMatrixAt(i, tmp);
    }

    mesh.count = distances.length;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.frustumCulled = true;
  }
}

const _frame = new SplineFrame();
const _matrix = new THREE.Matrix4();

// -----------------------------------------------------------------------------
// Helpers (module-private)
// -----------------------------------------------------------------------------

function vec3From(v, dx, dy, dz) {
  if (Array.isArray(v) && v.length === 3) return [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
  return [dx, dy, dz];
}

/**
 * Mulberry32 — tiny seeded RNG. Same seed → same instance layout on reload.
 */
function makeRng(seed) {
  let a = (seed | 0) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function composeInto(out, pos, quat, scale) {
  out.compose(pos, quat, scale);
}

/**
 * Apply per-instance rotation and scale jitter on top of `matrix`. Both
 * jitter passes operate on the matrix's rotation/scale columns only and
 * preserve the translation column — we extract pos/quat/scale once, mutate
 * quat and scale, and recompose at the end. Mutating the matrix piecewise
 * (e.g. with `makeRotationFromQuaternion`) silently zeros translation.
 *
 * rotationJitter = 0 → no rotation noise.
 * rotationJitter = 1 → fully random orientation (uniform on the sphere).
 * rotationJitter ∈ (0, 1) → blends Y-only random with full random.
 * scaleJitter     = fraction; final scale = 1 + (rand*2-1) * scaleJitter, uniform on xyz.
 */
function applyJitter(matrix, props, rng) {
  const rj = props.rotationJitter ?? 0;
  const sj = props.scaleJitter ?? 0;
  if (rj <= 0 && sj <= 0) return;

  // Decompose once, mutate quat/scale, recompose once.
  const pos = new THREE.Vector3().setFromMatrixPosition(matrix);
  const quat = new THREE.Quaternion().setFromRotationMatrix(matrix);
  const scale = new THREE.Vector3().setFromMatrixScale(matrix);

  if (rj > 0) {
    let jitterQuat;
    if (rj >= 1) {
      // Uniform random unit quaternion (Marsaglia).
      const u1 = rng(), u2 = rng(), u3 = rng();
      const s1 = Math.sqrt(1 - u1);
      const s2 = Math.sqrt(u1);
      jitterQuat = new THREE.Quaternion(
        s1 * Math.sin(2 * Math.PI * u2),
        s1 * Math.cos(2 * Math.PI * u2),
        s2 * Math.sin(2 * Math.PI * u3),
        s2 * Math.cos(2 * Math.PI * u3),
      );
    } else {
      // Y-only random rotation, then slerp toward full random by rj.
      jitterQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * Math.PI * 2);
      const u1 = rng(), u2 = rng(), u3 = rng();
      const s1 = Math.sqrt(1 - u1);
      const s2 = Math.sqrt(u1);
      const randQuat = new THREE.Quaternion(
        s1 * Math.sin(2 * Math.PI * u2),
        s1 * Math.cos(2 * Math.PI * u2),
        s2 * Math.sin(2 * Math.PI * u3),
        s2 * Math.cos(2 * Math.PI * u3),
      );
      jitterQuat.slerp(randQuat, rj);
    }
    // Left-multiply: jitter applies in instance-local frame on top of the
    // existing orientation.
    quat.multiply(jitterQuat);
  }

  if (sj > 0) {
    const factor = 1 + (rng() * 2 - 1) * sj;
    scale.multiplyScalar(factor);
  }

  matrix.compose(pos, quat, scale);
}

/**
 * Sample a random point for a free-space scatter shape (sphere/box/circle/disc).
 * Returns [x, y, z, nx, ny, nz]; normal is always straight up (these shapes
 * have no surface to align to).
 */
function samplePoint(shape, size, rng) {
  if (shape === "sphere") {
    // Uniform inside a sphere of radius size[0] (rejection sampling).
    const r = size[0];
    for (let i = 0; i < 8; i++) {
      const x = rng() * 2 - 1;
      const y = rng() * 2 - 1;
      const z = rng() * 2 - 1;
      const l2 = x * x + y * y + z * z;
      if (l2 <= 1) return [x * r, y * r, z * r, 0, 1, 0];
    }
    return [0, 0, 0, 0, 1, 0];
  }
  if (shape === "box") {
    const [hx, hy, hz] = size;
    return [(rng() * 2 - 1) * hx, (rng() * 2 - 1) * hy, (rng() * 2 - 1) * hz, 0, 1, 0];
  }
  if (shape === "circle") {
    // Ring: radius = size[0], thickness = size[1] (or 0 for a thin ring).
    const R = size[0];
    const t = size[1] ?? 0;
    const radius = t > 0 ? R - rng() * t : R;
    const theta = rng() * Math.PI * 2;
    return [Math.cos(theta) * radius, 0, Math.sin(theta) * radius, 0, 1, 0];
  }
  if (shape === "disc") {
    // Filled disc on XZ plane, radius = size[0].
    const R = size[0];
    const r = Math.sqrt(rng()) * R;
    const theta = rng() * Math.PI * 2;
    return [Math.cos(theta) * r, 0, Math.sin(theta) * r, 0, 1, 0];
  }
  // Fallback.
  return [0, 0, 0, 0, 1, 0];
}

/**
 * Every renderable THREE.Mesh owned by an entity's Mesh or Model component.
 * A MeshComponent contributes its single mesh; a ModelComponent contributes
 * every mesh in its loaded .glb hierarchy (traversed). Empty array if neither
 * component exists yet, or a ModelComponent's .glb hasn't loaded.
 */
function getEntityMeshes(entity) {
  const meshComp = entity?.getComponent?.("mesh");
  if (meshComp?.mesh) return [meshComp.mesh];
  const modelComp = entity?.getComponent?.("model");
  if (modelComp?.root) {
    const meshes = [];
    modelComp.root.traverse((o) => { if (o.isMesh) meshes.push(o); });
    return meshes;
  }
  return [];
}

/** The mesh whose geometry/material the InstancedMesh instances (first mesh found). */
function getPrimarySourceMesh(entity) {
  return getEntityMeshes(entity)[0] ?? null;
}

/** True if the entity has a ModelComponent whose .glb is still loading (not a real failure). */
function isModelPending(entity) {
  const modelComp = entity?.getComponent?.("model");
  return !!modelComp && !!modelComp.props?.path && !modelComp.root;
}

/**
 * Resolve every mesh to sample on for `scatterShape === "onMesh"`. Defaults
 * to this entity's own Mesh/Model; honours `scatterSurfaceEntity` if it
 * points to another entity with a Mesh or Model component.
 *
 * Returns [] if no usable mesh is found — the scatter branch then skips
 * sampling entirely rather than crashing on a half-configured component.
 */
function resolveSurfaceMeshes(entity, props) {
  const targetId = props?.scatterSurfaceEntity;
  if (targetId) {
    const engine = entity?.engine;
    const targetEntity = engine?.getEntity?.(targetId);
    if (targetEntity) {
      if (targetEntity === entity) return getEntityMeshes(entity);
      const meshes = getEntityMeshes(targetEntity);
      if (meshes.length) return meshes;
      if (!isModelPending(targetEntity)) {
        console.warn(
          `InstancerComponent on "${entity.name ?? entity.id}": surface target "${targetEntity.name ?? targetId}" has no Mesh or Model component — falling back to local mesh.`,
        );
      }
    } else {
      console.warn(
        `InstancerComponent on "${entity.name ?? entity.id}": surface target "${targetId}" not found — falling back to local mesh.`,
      );
    }
  }
  return getEntityMeshes(entity);
}

/** Triangle area from a flat 9-float worldVerts entry. */
function triangleArea(worldVerts, baseIdx) {
  const ax = worldVerts[baseIdx + 3] - worldVerts[baseIdx];
  const ay = worldVerts[baseIdx + 4] - worldVerts[baseIdx + 1];
  const az = worldVerts[baseIdx + 5] - worldVerts[baseIdx + 2];
  const bx = worldVerts[baseIdx + 6] - worldVerts[baseIdx];
  const by = worldVerts[baseIdx + 7] - worldVerts[baseIdx + 1];
  const bz = worldVerts[baseIdx + 8] - worldVerts[baseIdx + 2];
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  return 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
}

/**
 * Area-weighted surface sampler across every triangle of every mesh in
 * `meshes` (world space). Used for scatterSurfaceMode === "whole" — spreads
 * instances over the entire target regardless of shape (a whole terrain, a
 * whole mine hull). Returns [x, y, z, nx, ny, nz] in world space, or null if
 * none of the meshes have usable geometry.
 */
function makeWholeSurfaceSampler(meshes) {
  let triCount = 0;
  for (const m of meshes) {
    const geom = m.geometry;
    const index = geom?.getIndex();
    const pos = geom?.getAttribute?.("position");
    if (!pos) continue;
    triCount += index ? index.count / 3 : pos.count / 3;
  }
  if (triCount === 0) return null;

  const worldVerts = new Float32Array(triCount * 9);
  const cdf = new Float32Array(triCount);
  const tmp = new THREE.Vector3();
  let total = 0;
  let t = 0;
  for (const m of meshes) {
    const geom = m.geometry;
    const pos = geom?.getAttribute?.("position");
    if (!pos) continue;
    m.updateWorldMatrix(true, false);
    const index = geom.getIndex();
    const meshTriCount = index ? index.count / 3 : pos.count / 3;
    for (let k = 0; k < meshTriCount; k++) {
      let i0, i1, i2;
      if (index) { i0 = index.getX(k * 3); i1 = index.getX(k * 3 + 1); i2 = index.getX(k * 3 + 2); }
      else        { i0 = k * 3; i1 = k * 3 + 1; i2 = k * 3 + 2; }
      const ids = [i0, i1, i2];
      for (let vi = 0; vi < 3; vi++) {
        tmp.fromBufferAttribute(pos, ids[vi]).applyMatrix4(m.matrixWorld);
        const w = t * 9 + vi * 3;
        worldVerts[w] = tmp.x; worldVerts[w + 1] = tmp.y; worldVerts[w + 2] = tmp.z;
      }
      total += triangleArea(worldVerts, t * 9);
      cdf[t] = total;
      t++;
    }
  }
  if (total <= 0) return null;

  return (rng) => {
    const r = rng() * total;
    let lo = 0, hi = triCount - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < r) lo = mid + 1; else hi = mid;
    }
    const wv = lo * 9;
    let u = rng(), v_ = rng();
    if (u + v_ > 1) { u = 1 - u; v_ = 1 - v_; }
    const w = 1 - u - v_;
    const x = worldVerts[wv] * w + worldVerts[wv + 3] * u + worldVerts[wv + 6] * v_;
    const y = worldVerts[wv + 1] * w + worldVerts[wv + 4] * u + worldVerts[wv + 7] * v_;
    const z = worldVerts[wv + 2] * w + worldVerts[wv + 5] * u + worldVerts[wv + 8] * v_;
    const ax = worldVerts[wv + 3] - worldVerts[wv];
    const ay = worldVerts[wv + 4] - worldVerts[wv + 1];
    const az = worldVerts[wv + 5] - worldVerts[wv + 2];
    const bx = worldVerts[wv + 6] - worldVerts[wv];
    const by = worldVerts[wv + 7] - worldVerts[wv + 1];
    const bz = worldVerts[wv + 8] - worldVerts[wv + 2];
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    return [x, y, z, nx / nl, ny / nl, nz / nl];
  };
}

// Maps a projection axis to [rayAxis, planeAxisA, planeAxisB] component indices.
const PROJECTION_AXES = { x: [0, 1, 2], y: [1, 0, 2], z: [2, 0, 1] };

/**
 * Projected surface sampler: picks a random point inside a circle or rect
 * (in the plane perpendicular to `scatterProjectedAxis`, centered on
 * `scatterSurfaceCenter`), then raycasts onto `meshes` along that axis —
 * like dropping a seed from above onto terrain. Returns [x, y, z, nx, ny, nz]
 * in world space from the closest hit, or null if the ray missed (the caller
 * retries with a fresh sample). Returns null outright if there's nothing to
 * raycast against.
 */
function makeProjectedSurfaceSampler(meshes, props) {
  if (!meshes.length) return null;
  const shape = props.scatterProjectedShape ?? "circle";
  const [ai, bi, ci] = PROJECTION_AXES[props.scatterProjectedAxis] ?? PROJECTION_AXES.y;
  const size = vec3From(props.scatterProjectedSize, 1, 1, 0);
  const center = new THREE.Vector3().fromArray(vec3From(props.scatterSurfaceCenter, 0, 0, 0));

  const box = new THREE.Box3();
  for (const m of meshes) box.expandByObject(m);
  if (box.isEmpty()) return null;
  const rayAxisSize = box.max.getComponent(ai) - box.min.getComponent(ai);
  const margin = Math.max(0.5, rayAxisSize * 0.1);

  const dir = new THREE.Vector3();
  dir.setComponent(ai, -1);
  const raycaster = new THREE.Raycaster();
  raycaster.far = rayAxisSize + margin * 2 || margin * 2;

  const origin = new THREE.Vector3();
  return (rng) => {
    let u, v;
    if (shape === "rect") {
      u = (rng() * 2 - 1) * size[0];
      v = (rng() * 2 - 1) * (size[1] || size[0]);
    } else {
      const r = Math.sqrt(rng()) * size[0];
      const theta = rng() * Math.PI * 2;
      u = Math.cos(theta) * r;
      v = Math.sin(theta) * r;
    }
    origin.copy(center);
    origin.setComponent(bi, center.getComponent(bi) + u);
    origin.setComponent(ci, center.getComponent(ci) + v);
    origin.setComponent(ai, box.max.getComponent(ai) + margin);
    raycaster.set(origin, dir);
    const hits = raycaster.intersectObjects(meshes, false);
    if (!hits.length) return null;
    const hit = hits[0];
    const n = hit.face
      ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize()
      : new THREE.Vector3(0, 1, 0);
    return [hit.point.x, hit.point.y, hit.point.z, n.x, n.y, n.z];
  };
}