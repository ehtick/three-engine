// @ts-check
import * as THREE from "three/webgpu";
import { Component } from "../../engine/components/Component.js";
import { CROWD_FLAGS } from "./NavigationSystem.js";

/**
 * A pathfinding agent — the thing that turns "go there" into movement that
 * goes around walls and around other agents.
 *
 * Local avoidance is why this rides recast's crowd rather than just following
 * a path: a path is computed against static geometry, so ten enemies given ten
 * correct paths to the same door walk through each other to reach it. The crowd
 * steers them around one another every frame while keeping each on its path.
 *
 *     const agent = this.entity.getComponent("navagent");
 *     agent.setDestination(player.position);
 *     if (agent.remainingDistance < 2) this.attack();
 */
export class NavAgentComponent extends Component {
  static type = "navagent";
  static label = "Nav Agent";
  static tags = ["navigation", "play-mode"];
  // The agent's crowd membership and current path are runtime state — the next
  // Play must start from the authored spawn point, not from wherever the last
  // session's chase ended.
  static resetOnStop = true;
  static defaults = {
    radius: 0.4,
    height: 1.8,
    speed: 3.5,
    acceleration: 8,
    angularSpeed: 480,
    stoppingDistance: 0.2,
    separation: 2,
    avoidance: true,
    avoidanceQuality: 3,
    autoRotate: true,
    autoRepath: true,
    drawPath: false,
  };
  static schema = [
    { key: "radius", label: "Radius", type: "number", min: 0.05, step: 0.05 },
    { key: "height", label: "Height", type: "number", min: 0.1, step: 0.1 },
    { key: "speed", label: "Speed", type: "number", min: 0, step: 0.1 },
    { key: "acceleration", label: "Acceleration", type: "number", min: 0.1, step: 0.5 },
    { key: "angularSpeed", label: "Turn Speed", type: "number", min: 0, step: 10, showIf: (p) => p.autoRotate },
    { key: "stoppingDistance", label: "Stopping Distance", type: "number", min: 0, step: 0.05 },
    { key: "avoidance", label: "Avoid Others", type: "boolean" },
    {
      key: "avoidanceQuality",
      label: "Avoidance Quality",
      type: "number",
      min: 0,
      max: 3,
      step: 1,
      showIf: (p) => p.avoidance,
    },
    { key: "separation", label: "Separation", type: "number", min: 0, max: 8, step: 0.25, showIf: (p) => p.avoidance },
    { key: "autoRotate", label: "Face Movement", type: "boolean" },
    { key: "autoRepath", label: "Auto Repath", type: "boolean" },
    { key: "drawPath", label: "Draw Path", type: "boolean" },
  ];

  onAttach() {
    this.agent = null;
    this.destination = null;
    this._stopped = false;
    this._velocity = new THREE.Vector3();
    const engine = this.entity.engine;
    engine.navigation?.agents.add(this);
    engine.navigation?.noteAgentRadius(this.props.radius ?? 0.4);
    // The module and its wasm load asynchronously; joining is retried when the
    // navmesh first appears, so an agent authored before the bake still works.
    this._unsubNav = engine.on("navmesh-changed", () => this.rejoinCrowd());
    this._unsubPlay = engine.on("play-changed", (playing) => {
      if (playing) this.rejoinCrowd();
      else this.#leaveCrowd();
    });
    if (engine.playing) this.rejoinCrowd();
  }

  onDetach() {
    this.#leaveCrowd();
    this.entity.engine.navigation?.agents.delete(this);
    this._unsubNav?.();
    this._unsubPlay?.();
  }

  onPropChanged(key) {
    if (key === "radius") this.entity.engine.navigation?.noteAgentRadius(this.props.radius ?? 0.4);
    // Live-tunable: changing speed or avoidance mid-play should be visible
    // immediately, not after a re-add that would drop the agent's path.
    this.agent?.updateParameters(this.#crowdParams());
  }

  onDisable() {
    this.#leaveCrowd();
  }

  onEnable() {
    if (this.entity.engine.playing) this.rejoinCrowd();
  }

  // --- crowd membership -----------------------------------------------------

  #crowdParams() {
    const avoidance = this.props.avoidance !== false;
    return {
      radius: this.props.radius ?? 0.4,
      height: this.props.height ?? 1.8,
      maxSpeed: this.props.speed ?? 3.5,
      maxAcceleration: this.props.acceleration ?? 8,
      // Recast wants these in agent radii; expressing them absolutely would
      // make a small agent look ahead absurdly far and a large one not at all.
      collisionQueryRange: (this.props.radius ?? 0.4) * 12,
      pathOptimizationRange: (this.props.radius ?? 0.4) * 30,
      separationWeight: avoidance ? (this.props.separation ?? 2) : 0,
      obstacleAvoidanceType: avoidance ? Math.round(this.props.avoidanceQuality ?? 3) : 0,
      updateFlags:
        CROWD_FLAGS.ANTICIPATE_TURNS |
        CROWD_FLAGS.OPTIMIZE_VIS |
        CROWD_FLAGS.OPTIMIZE_TOPO |
        (avoidance ? CROWD_FLAGS.OBSTACLE_AVOIDANCE | CROWD_FLAGS.SEPARATION : 0),
    };
  }

  /** (Re)joins the crowd — after a bake, after Play starts, after re-enabling. */
  rejoinCrowd() {
    const nav = this.entity.engine.navigation;
    if (!nav?.crowd || !this.enabled) return;
    // Register here as well as in onAttach: the module's wasm loads
    // asynchronously, so a scene deserialized during that window attaches every
    // agent before `engine.navigation` exists. Registering only in onAttach
    // leaves those agents in a crowd but absent from the system's per-frame
    // sync — they path correctly and never move.
    nav.agents.add(this);
    nav.noteAgentRadius(this.props.radius ?? 0.4);
    this.#leaveCrowd();
    this.entity.object3D.updateMatrixWorld(true);
    const position = this.entity.object3D.getWorldPosition(_v);
    // Snap onto the navmesh rather than adding at the authored position: an
    // agent placed a few centimetres above the floor (which is where anything
    // dropped into a scene ends up) is OFF the navmesh, and recast quietly
    // refuses to path for it.
    const grounded = nav.sample(position) ?? position;
    this.agent = nav.crowd.addAgent(
      { x: grounded.x, y: grounded.y, z: grounded.z },
      this.#crowdParams(),
    );
    if (this.destination) this.setDestination(this.destination);
  }

  #leaveCrowd() {
    if (!this.agent) return;
    this.entity.engine.navigation?.crowd?.removeAgent(this.agent);
    this.agent = null;
  }

  // --- script API -----------------------------------------------------------

  /**
   * Sends the agent to a world position. The point is snapped to the nearest
   * walkable spot, so aiming at a player standing on a ledge above still moves
   * the agent to the reachable ground nearby instead of silently doing nothing.
   *
   * @returns false when there is no navmesh, or nothing walkable near the target
   */
  setDestination(point) {
    const nav = this.entity.engine.navigation;
    if (!nav?.query) return false;
    const target = nav.sample(point);
    if (!target) return false;
    this.destination = target.clone();
    this._stopped = false;
    if (!this.agent) return true; // applied when the agent joins the crowd
    return this.agent.requestMoveTarget({ x: target.x, y: target.y, z: target.z });
  }

  /**
   * Brings the agent to a halt, keeping the destination for `resume()`.
   *
   * It decelerates rather than freezing — the crowd is a steering simulation
   * and teleporting the velocity to zero would make a running enemy stop dead
   * mid-stride. Clearing the target FIRST and then asking for zero velocity
   * matters: the other order has `resetMoveTarget` discard the velocity request
   * it was just given, and the agent coasts on its last heading.
   */
  stop() {
    this._stopped = true;
    this.agent?.resetMoveTarget();
    this.agent?.requestMoveVelocity({ x: 0, y: 0, z: 0 });
  }

  resume() {
    if (!this._stopped) return;
    this._stopped = false;
    if (this.destination) this.setDestination(this.destination);
  }

  /** Teleports without walking there — respawns, doors, cutscenes. */
  warp(point) {
    const nav = this.entity.engine.navigation;
    const target = nav?.sample(point) ?? toVector(point);
    this.entity.object3D.position.copy(target);
    this.agent?.teleport({ x: target.x, y: target.y, z: target.z });
    return true;
  }

  get isStopped() {
    return this._stopped;
  }

  get hasPath() {
    return !!this.destination && !!this.agent;
  }

  /** Straight-line distance left to the destination (not path length). */
  get remainingDistance() {
    if (!this.destination) return Infinity;
    return this.entity.object3D.position.distanceTo(this.destination);
  }

  /** True once the agent is within its stopping distance of the destination. */
  get isAtDestination() {
    return this.remainingDistance <= (this.props.stoppingDistance ?? 0.2);
  }

  get velocity() {
    return this._velocity;
  }

  get isOnNavMesh() {
    return !!this.entity.engine.navigation?.isOnNavMesh(this.entity.object3D.position);
  }

  /** The corners the agent is currently steering through. */
  get path() {
    const corners = this.agent?.corners?.() ?? [];
    return corners.map((c) => new THREE.Vector3(c.x, c.y, c.z));
  }

  // --- per-frame ------------------------------------------------------------

  /**
   * Copies the crowd's simulated pose onto the entity. Called by the system
   * with the delta it stepped the crowd by — taking it as an argument rather
   * than reading `engine.deltaTime` keeps the turn rate correct for any caller
   * that steps the crowd itself (a test, a rewind, a fixed-step server).
   */
  syncFromCrowd(dt = this.entity.engine.deltaTime) {
    if (!this.agent || !this.enabled) return;
    // `position()`, NOT `interpolatedPosition`: recast only maintains the
    // interpolated one when the crowd is stepped with a separate
    // time-since-last-call, and we step it with the frame's own delta. Reading
    // the interpolated value under a fixed step returns the position the agent
    // had when it JOINED the crowd, forever — an agent that paths correctly,
    // reports a shrinking distance, and never visibly moves.
    const position = this.agent.position();
    const velocity = this.agent.velocity();
    this._velocity.set(velocity.x, velocity.y, velocity.z);

    const object = this.entity.object3D;
    // The crowd works in world space; the entity's transform is parent-relative.
    if (object.parent && object.parent !== this.entity.engine.scene) {
      object.parent.updateMatrixWorld(true);
      _m.copy(object.parent.matrixWorld).invert();
      object.position.set(position.x, position.y, position.z).applyMatrix4(_m);
    } else {
      object.position.set(position.x, position.y, position.z);
    }

    if (this.props.autoRotate !== false) this.#faceMovement(dt);
    if (this.props.drawPath) this.#drawPath();
  }

  /**
   * Turns toward the direction of travel, at a limited rate.
   *
   * Snapping to the velocity each frame looks like the character is on rails,
   * and at low speeds the velocity direction is noise — hence both the turn
   * rate and the deadzone.
   */
  #faceMovement(dt) {
    const speed = this._velocity.length();
    if (speed < 0.05) return;
    const heading = Math.atan2(this._velocity.x, this._velocity.z);
    const object = this.entity.object3D;
    const current = object.rotation.y;
    let delta = heading - current;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta <= -Math.PI) delta += Math.PI * 2;
    const maxStep = THREE.MathUtils.degToRad(this.props.angularSpeed ?? 480) * (dt || 0);
    object.rotation.y = current + THREE.MathUtils.clamp(delta, -maxStep, maxStep);
  }

  #drawPath() {
    const debug = this.entity.engine.debug;
    if (!debug) return;
    const corners = this.path;
    if (corners.length < 2) return;
    debug.polyline(corners, "#ffd166");
    for (const corner of corners) debug.point(corner, 0.08, "#ffd166");
    if (this.destination) debug.sphere(this.destination, 0.25, "#ff6b6b");
  }
}

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();

function toVector(value) {
  if (Array.isArray(value)) return new THREE.Vector3(value[0] ?? 0, value[1] ?? 0, value[2] ?? 0);
  return new THREE.Vector3(value?.x ?? 0, value?.y ?? 0, value?.z ?? 0);
}
