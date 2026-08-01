import * as THREE from "three/webgpu";
import { Component } from "./Component.js";
import { Spline, SplineFrame, SPLINE_TYPES, KNOT_DEFAULTS, normalizeKnot } from "../spline/splineMath.js";

/**
 * A path in the scene (roadmap item 16) — a road, a patrol route, a camera rail.
 *
 * ## The knots are component data, not child entities
 *
 * LOD levels are child entities because they ARE entities (each is a mesh you
 * want to select, move and swap). A knot is not: it has no components, no
 * children and no name, and a forty-knot road would put forty rows in the
 * hierarchy for one object. So knots are props, and the editor supplies the
 * viewport handles that make them directly manipulable — which is the whole
 * meaning of "a scene tool" rather than "a number list in the inspector".
 *
 * ## Local space
 *
 * Knots are in the entity's local space, so moving, rotating or scaling the
 * path entity moves the whole path — and a patrol route can therefore live
 * inside a prefab and be placed twice. Consumers that need world coordinates go
 * through `worldPointAt` / `worldFrameAt`, which apply the entity matrix once.
 *
 * ## One curve, shared
 *
 * The evaluated `Spline` is rebuilt on any prop change and handed out by
 * reference to every consumer (follower, camera dolly, mesh extruder). They
 * watch `version` rather than re-deriving it: a road, three carts and a camera
 * on the same path should pay for one arc-length table, not five.
 */
export class SplineComponent extends Component {
  static type = "spline";
  static label = "Spline";
  static tags = ["gameplay", "3d"];
  static defaults = {
    knots: [
      { position: [-2, 0, 0], handleIn: [-1, 0, 0], handleOut: [1, 0, 0], roll: 0 },
      { position: [2, 0, 0], handleIn: [-1, 0, 0], handleOut: [1, 0, 0], roll: 0 },
    ],
    type: "catmullrom",
    closed: false,
    tension: 1,
    resolution: 16,
    alwaysDraw: true,
    color: "#57d9a3",
  };
  static schema = [
    { key: "type", label: "Type", type: "select", options: SPLINE_TYPES },
    { key: "closed", label: "Closed", type: "boolean" },
    {
      key: "tension",
      label: "Tension",
      type: "number",
      min: 0,
      max: 2,
      step: 0.05,
      showIf: (p) => p.type === "catmullrom",
    },
    { key: "resolution", label: "Resolution", type: "number", min: 2, max: 128, step: 1 },
    { key: "alwaysDraw", label: "Always Draw", type: "boolean" },
    { key: "color", label: "Gizmo Color", type: "color" },
  ];

  onAttach() {
    /** Bumped on every rebuild. Consumers cache derived data against it. */
    this.version = 0;
    this.#rebuild();
  }

  onDetach() {
    this.spline = null;
  }

  onPropChanged() {
    this.#rebuild();
  }

  #rebuild() {
    this.spline = new Spline(this.props.knots ?? [], {
      type: this.props.type,
      closed: this.props.closed,
      tension: this.props.tension,
      samplesPerSegment: this.props.resolution,
    });
    this.version++;
    // Consumers that are not components (the editor's knot handles, a script
    // holding a cached extrusion) have nothing else to hang off.
    this.entity?.engine?.emit?.("spline-changed", { entityId: this.entity.id });
  }

  /** Rebuilds after a direct `props.knots` mutation (the editor's drag path). */
  invalidate() {
    this.#rebuild();
  }

  // ---- script API ----------------------------------------------------------

  get length() {
    return this.spline?.length ?? 0;
  }

  get knotCount() {
    return this.props.knots?.length ?? 0;
  }

  get closed() {
    return !!this.props.closed;
  }

  pointAt(distance, out = new THREE.Vector3()) {
    return this.spline ? this.spline.pointAtDistance(distance, out) : out.set(0, 0, 0);
  }

  tangentAt(distance, out = new THREE.Vector3()) {
    return this.spline ? this.spline.tangentAtDistance(distance, out) : out.set(0, 0, 1);
  }

  frameAt(distance, out = new SplineFrame()) {
    return this.spline ? this.spline.frameAtDistance(distance, out) : out;
  }

  /** The entity's world matrix, refreshed — every world query needs it current. */
  #matrix() {
    this.entity.object3D.updateWorldMatrix(true, false);
    return this.entity.object3D.matrixWorld;
  }

  worldPointAt(distance, out = new THREE.Vector3()) {
    this.pointAt(distance, out);
    return out.applyMatrix4(this.#matrix());
  }

  /**
   * Frame at `distance`, in world space.
   *
   * Directions go through the normal matrix, not the full one — applying the
   * world matrix to a tangent would add the translation, which points every
   * frame at the origin and is a bug that survives testing on a path parked at
   * the origin.
   */
  worldFrameAt(distance, out = new SplineFrame()) {
    this.frameAt(distance, out);
    const matrix = this.#matrix();
    out.position.applyMatrix4(matrix);
    _normalMatrix.getNormalMatrix(matrix);
    out.tangent.applyMatrix3(_normalMatrix).normalize();
    out.normal.applyMatrix3(_normalMatrix).normalize();
    // Re-orthogonalise: a non-uniform scale shears the two apart, and every
    // consumer downstream assumes an orthonormal basis.
    out.normal.addScaledVector(out.tangent, -out.normal.dot(out.tangent));
    if (out.normal.lengthSq() < 1e-10) out.normal.set(0, 1, 0);
    out.normal.normalize();
    out.binormal.copy(out.tangent).cross(out.normal).normalize();
    return out;
  }

  /**
   * World length. A scaled path entity really is a longer road, and a follower
   * asked to travel at 3 m/s should cover three world metres per second on it.
   */
  get worldLength() {
    const scale = _scale.setFromMatrixScale(this.#matrix());
    // Uniform scale is the honest case; for a non-uniform one the mean is the
    // only single number available, and a follower's speed is a scalar.
    return this.length * ((Math.abs(scale.x) + Math.abs(scale.y) + Math.abs(scale.z)) / 3);
  }

  /** Nearest point on the path to a WORLD position; distance is in local units. */
  closestPoint(worldPoint, out = {}) {
    if (!this.spline) return out;
    _point.copy(worldPoint).applyMatrix4(_inverse.copy(this.#matrix()).invert());
    return this.spline.closestPoint(_point, out);
  }

  // ---- knot editing (scripts and the editor's viewport handles) -------------

  getKnot(index) {
    const knot = this.props.knots?.[index];
    return knot ? normalizeKnot(knot) : null;
  }

  setKnot(index, knot) {
    const list = this.props.knots;
    if (!list?.[index]) return this;
    list[index] = normalizeKnot({ ...normalizeKnot(list[index]), ...knot });
    this.#rebuild();
    return this;
  }

  addKnot(position, index = -1) {
    const list = [...(this.props.knots ?? [])];
    const knot = normalizeKnot({ position, handleIn: KNOT_DEFAULTS.handleIn, handleOut: KNOT_DEFAULTS.handleOut });
    if (index < 0 || index >= list.length) list.push(knot);
    else list.splice(index, 0, knot);
    this.props.knots = list;
    this.#rebuild();
    return this;
  }

  removeKnot(index) {
    const list = this.props.knots ?? [];
    if (index < 0 || index >= list.length) return this;
    this.props.knots = list.filter((_, i) => i !== index);
    this.#rebuild();
    return this;
  }

  setKnots(knots) {
    this.props.knots = (knots ?? []).map(normalizeKnot);
    this.#rebuild();
    return this;
  }

  // ---- gizmo ---------------------------------------------------------------

  /**
   * The curve itself, drawn whether or not the path is selected.
   *
   * A path has no renderable geometry, so an unselected one would be
   * completely invisible — you could not find the patrol route you came to
   * edit without knowing which entity it was and clicking it in the hierarchy.
   * Unity draws splines the same way, and `alwaysDraw` turns it off for a scene
   * that has grown enough of them to be noisy.
   */
  onDrawGizmos(gizmos) {
    if (!this.props.alwaysDraw || !this.spline?.valid) return;
    this.#drawCurve(gizmos, this.props.color ?? "#57d9a3");
  }

  /** Selected: the curve highlighted, plus the knots and the frames it rides. */
  onDrawGizmosSelected(gizmos) {
    if (!this.spline?.valid) {
      // A one-knot path still has a knot to grab; drawing nothing at all makes
      // a half-authored spline look like a broken component.
      this.#drawKnots(gizmos);
      return;
    }
    this.#drawCurve(gizmos, "#ffd166");
    this.#drawKnots(gizmos);
    this.#drawFrames(gizmos);
    gizmos.transform(null);
  }

  #drawCurve(gizmos, color) {
    gizmos.transform(this.#matrix());
    gizmos.color(color);
    const spline = this.spline;
    // Segment by segment out of the sample buffer rather than building a point
    // array: this runs for every spline in the scene every frame, and an array
    // of a few hundred fresh Vector3s per path per frame is exactly the kind of
    // garbage that makes a debug overlay cost more than the thing it draws.
    for (let i = 0; i < spline.sampleCount - 1; i++) {
      gizmos.line(spline.samplePosition(i, _a), spline.samplePosition(i + 1, _b));
    }
    gizmos.transform(null);
  }

  #drawKnots(gizmos) {
    gizmos.transform(this.#matrix());
    const knots = this.props.knots ?? [];
    const size = this.#handleScale();
    for (let i = 0; i < knots.length; i++) {
      const knot = normalizeKnot(knots[i]);
      gizmos.color(i === 0 ? "#4dff9f" : "#ffffff");
      gizmos.point(knot.position, size);
      if (this.props.type === "bezier") {
        // The handles are what a bezier IS. Without the stems you are dragging
        // two disconnected dots whose relationship to the curve is a guess.
        gizmos.color("#7aa2ff");
        const p = _point.fromArray(knot.position);
        gizmos.line(knot.position, _v.copy(p).add(_h.fromArray(knot.handleIn)).toArray());
        gizmos.line(knot.position, _v.copy(p).add(_h.fromArray(knot.handleOut)).toArray());
      }
    }
    gizmos.transform(null);
  }

  /**
   * A few frame ticks along the curve.
   *
   * The normal is the invisible half of a path: two splines through identical
   * knots with different roll produce a flat road and a banked one, and nothing
   * else on screen says which you have.
   */
  #drawFrames(gizmos) {
    const spline = this.spline;
    const length = spline.length;
    if (!(length > 1e-6)) return;
    gizmos.transform(this.#matrix());
    const ticks = THREE.MathUtils.clamp(Math.round(length / 2), 3, 24);
    const size = this.#handleScale() * 4;
    for (let i = 0; i <= ticks; i++) {
      spline.frameAtDistance((i / ticks) * length, _frame);
      gizmos.color("#57d9a3");
      gizmos.line(_frame.position.toArray(), _v.copy(_frame.position).addScaledVector(_frame.normal, size).toArray());
    }
    gizmos.transform(null);
  }

  /** Knot markers sized off the path, so a 200m road's knots aren't specks. */
  #handleScale() {
    return THREE.MathUtils.clamp((this.spline?.length ?? 1) * 0.02, 0.05, 0.6);
  }
}

const _normalMatrix = new THREE.Matrix3();
const _inverse = new THREE.Matrix4();
const _point = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _v = new THREE.Vector3();
const _h = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _frame = new SplineFrame();

/**
 * Resolves the path a consumer points at.
 *
 * An empty reference means "the spline on my own entity", which is the common
 * case for a road (the mesh and the path are one object) and saves an entity
 * reference that could dangle. A named entity without a spline returns null
 * rather than throwing — half-wired is a normal state while authoring.
 */
export function resolveSpline(entity, pathId) {
  if (!entity) return null;
  if (!pathId) return entity.getComponent?.("spline") ?? null;
  const target = entity.engine?.getEntity?.(pathId);
  return target?.getComponent?.("spline") ?? null;
}
