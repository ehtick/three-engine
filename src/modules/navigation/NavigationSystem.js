import * as THREE from "three/webgpu";
import { EDITOR_LAYER, DEBUG_LAYER } from "../../engine/editorLayers.js";

/**
 * `engine.navigation` — navmesh baking, path queries and the agent crowd.
 *
 * Baking happens in the editor and the result is stored as an asset, not
 * rebuilt at load: recast takes tens to hundreds of milliseconds on a modest
 * level and seconds on a large one, and paying that on every level load — on
 * the player's machine, not the author's — is the difference between a level
 * transition and a stall. Baking at runtime is still supported as a fallback,
 * so navigation works before anyone has pressed Bake.
 *
 * Queries are exposed in engine terms (Vector3s and arrays) rather than
 * recast's, because recast's WASM objects have to be destroyed by hand and a
 * gameplay script is exactly the wrong place to be remembering that.
 */

const DEFAULT_HALF_EXTENTS = { x: 2, y: 4, z: 2 };

// dtCrowdAgent update flags. Named here because the numbers appear nowhere in
// the JS bindings and "updateFlags: 7" is unreadable at the call site.
const DT_CROWD_ANTICIPATE_TURNS = 1;
const DT_CROWD_OBSTACLE_AVOIDANCE = 2;
const DT_CROWD_SEPARATION = 4;
const DT_CROWD_OPTIMIZE_VIS = 8;
const DT_CROWD_OPTIMIZE_TOPO = 16;

export const CROWD_FLAGS = {
  ANTICIPATE_TURNS: DT_CROWD_ANTICIPATE_TURNS,
  OBSTACLE_AVOIDANCE: DT_CROWD_OBSTACLE_AVOIDANCE,
  SEPARATION: DT_CROWD_SEPARATION,
  OPTIMIZE_VIS: DT_CROWD_OPTIMIZE_VIS,
  OPTIMIZE_TOPO: DT_CROWD_OPTIMIZE_TOPO,
};

/** Bake settings, in metres and degrees — recast's own units are voxels. */
export const BAKE_DEFAULTS = {
  cellSize: 0.2,
  cellHeight: 0.15,
  agentRadius: 0.4,
  agentHeight: 1.8,
  agentMaxClimb: 0.4,
  agentMaxSlope: 45,
  minRegionArea: 2,
  tag: "",
};

export class NavigationSystem {
  constructor(engine, recast) {
    this.engine = engine;
    this.recast = recast; // { init, NavMesh, NavMeshQuery, Crowd, importNavMesh, exportNavMesh, ... }
    this.generators = recast.generators;
    this.navMesh = null;
    this.query = null;
    this.crowd = null;
    this.agents = new Set(); // NavAgentComponent
    this.links = new Set(); // NavLinkComponent
    this.stats = null;
    this._maxAgentRadius = 0.6;

    // The crowd only advances while playing. In the editor an agent should sit
    // where it was authored — an enemy that wanders off its spawn point every
    // time you open the scene is a scene that never stays saved.
    this._unsubUpdate = engine.onUpdate((dt) => {
      if (!engine.playing || !this.crowd) return;
      this.crowd.update(dt);
      for (const agent of this.agents) agent.syncFromCrowd(dt);
    });
  }

  get isReady() {
    return !!this.navMesh;
  }

  // --- building -------------------------------------------------------------

  /**
   * Gathers walkable geometry from the scene as flat position/index arrays.
   *
   * What is excluded, and why:
   *   - anything on the editor or debug layers (gizmos, the grid, and the
   *     navmesh overlay itself — baking the previous bake's overlay into the
   *     next one is a genuinely confusing failure);
   *   - skinned meshes, which move; a navmesh baked around a character's
   *     T-pose is worse than no navmesh at all;
   *   - entities tagged `nav-ignore`, the escape hatch for props and triggers.
   *
   * When `tag` is set, only entities carrying it are included — the inverse
   * workflow, for levels where most geometry is decoration.
   */
  collectGeometry({ tag = "", bounds = null } = {}) {
    const positions = [];
    const indices = [];
    const box = bounds ? new THREE.Box3().setFromCenterAndSize(bounds.center, bounds.size) : null;
    const worldVertex = new THREE.Vector3();
    let meshCount = 0;

    for (const entity of this.engine.entities.values()) {
      if (entity.tags?.includes("nav-ignore")) continue;
      if (tag && !entity.tags?.includes(tag)) continue;
      entity.object3D.updateMatrixWorld(true);
      entity.object3D.traverse((object) => {
        if (!object.isMesh || object.isSkinnedMesh) return;
        if (object.layers.isEnabled(EDITOR_LAYER) || object.layers.isEnabled(DEBUG_LAYER)) return;
        if (object.visible === false) return;
        const geometry = object.geometry;
        const attribute = geometry?.attributes?.position;
        if (!attribute) return;
        const base = positions.length / 3;
        for (let i = 0; i < attribute.count; i++) {
          worldVertex.fromBufferAttribute(attribute, i).applyMatrix4(object.matrixWorld);
          positions.push(worldVertex.x, worldVertex.y, worldVertex.z);
        }
        if (geometry.index) {
          const array = geometry.index.array;
          for (let i = 0; i < array.length; i++) indices.push(base + array[i]);
        } else {
          for (let i = 0; i < attribute.count; i++) indices.push(base + i);
        }
        meshCount++;
      });
    }

    if (!box) return { positions, indices, meshCount };
    // Bounds filtering drops whole TRIANGLES, not vertices: dropping vertices
    // would leave dangling indices and recast would read past the array.
    const keptPositions = [];
    const keptIndices = [];
    const remap = new Map();
    const a = new THREE.Vector3();
    for (let t = 0; t < indices.length; t += 3) {
      let inside = false;
      for (let k = 0; k < 3 && !inside; k++) {
        const i = indices[t + k] * 3;
        inside = box.containsPoint(a.set(positions[i], positions[i + 1], positions[i + 2]));
      }
      if (!inside) continue;
      for (let k = 0; k < 3; k++) {
        const original = indices[t + k];
        let mapped = remap.get(original);
        if (mapped === undefined) {
          mapped = keptPositions.length / 3;
          remap.set(original, mapped);
          const i = original * 3;
          keptPositions.push(positions[i], positions[i + 1], positions[i + 2]);
        }
        keptIndices.push(mapped);
      }
    }
    return { positions: keptPositions, indices: keptIndices, meshCount };
  }

  /**
   * Bakes a navmesh from the current scene.
   *
   * @returns `{ success, error?, stats }`
   */
  bake(settings = {}) {
    const config = { ...BAKE_DEFAULTS, ...settings };
    const started = Date.now();
    const { positions, indices, meshCount } = this.collectGeometry({
      tag: config.tag,
      bounds: config.bounds ?? null,
    });
    if (!indices.length) {
      return {
        success: false,
        error:
          "No walkable geometry found. Add some meshes, or check that they aren't tagged " +
          "`nav-ignore` (or excluded by the Include Tag).",
      };
    }

    const cs = Math.max(config.cellSize, 0.01);
    const ch = Math.max(config.cellHeight, 0.01);
    const recastConfig = {
      cs,
      ch,
      // Recast counts these in VOXELS, but nobody thinks about their character
      // in voxels — the component asks for metres and degrees and converts here.
      // Ceil for radius/height (never let an agent fit somewhere it doesn't),
      // floor for climb (never let it step onto something it can't reach).
      walkableRadius: Math.ceil(config.agentRadius / cs),
      walkableHeight: Math.ceil(config.agentHeight / ch),
      walkableClimb: Math.floor(config.agentMaxClimb / ch),
      walkableSlopeAngle: config.agentMaxSlope,
      minRegionArea: config.minRegionArea,
      offMeshConnections: this.#collectLinks(),
    };

    const result = this.generators.generateSoloNavMesh(positions, indices, recastConfig);
    if (!result.success) {
      return { success: false, error: result.error ?? "recast failed to build a navmesh" };
    }
    this.#install(result.navMesh);
    this.stats = {
      meshCount,
      triangles: indices.length / 3,
      links: recastConfig.offMeshConnections.length,
      ms: Date.now() - started,
    };
    return { success: true, stats: this.stats };
  }

  /** Off-mesh links, as recast wants them, from every NavLink in the scene. */
  #collectLinks() {
    const out = [];
    for (const link of this.links) {
      const params = link.toConnectionParams();
      if (params) out.push(params);
    }
    return out;
  }

  #install(navMesh) {
    this.dispose({ keepAgents: true });
    this.navMesh = navMesh;
    this.query = new this.recast.NavMeshQuery(navMesh);
    this.crowd = new this.recast.Crowd(navMesh, {
      maxAgents: 512,
      // Recast sizes its internal grid off this, and an agent larger than the
      // declared maximum silently stops avoiding anything. Track the largest
      // agent actually in the scene rather than guessing.
      maxAgentRadius: this._maxAgentRadius,
    });
    // Re-add existing agents: a re-bake must not leave every enemy in the level
    // inert until someone reloads the scene.
    for (const agent of this.agents) agent.rejoinCrowd();
    this.engine.emit("navmesh-changed");
  }

  /** Largest agent radius seen, so the next crowd is built big enough. */
  noteAgentRadius(radius) {
    if (radius > this._maxAgentRadius) this._maxAgentRadius = radius;
  }

  // --- serialization --------------------------------------------------------

  /** The baked navmesh as bytes, for writing to a `.navmesh` asset. */
  toBytes() {
    if (!this.navMesh) return null;
    return this.recast.exportNavMesh(this.navMesh);
  }

  /** Installs a previously baked navmesh. */
  fromBytes(bytes) {
    if (!bytes?.length) return false;
    const result = this.recast.importNavMesh(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    if (!result?.navMesh) return false;
    this.#install(result.navMesh);
    this.stats = { loaded: true, bytes: bytes.length };
    return true;
  }

  // --- queries --------------------------------------------------------------

  /**
   * A path between two world points, as an array of `Vector3` corners.
   * Returns an empty array when no path exists — including when either end is
   * off the navmesh, which is by far the most common cause and is worth
   * checking with `sample()` before blaming the pathfinder.
   */
  findPath(from, to, options = {}) {
    if (!this.query) return [];
    const result = this.query.computePath(toPoint(from), toPoint(to), {
      halfExtents: options.halfExtents ?? DEFAULT_HALF_EXTENTS,
    });
    if (!result.success || !result.path?.length) return [];
    return result.path.map((p) => new THREE.Vector3(p.x, p.y, p.z));
  }

  /** The nearest point ON the navmesh to `point`, or null if none is in range. */
  sample(point, halfExtents = DEFAULT_HALF_EXTENTS) {
    if (!this.query) return null;
    const result = this.query.findClosestPoint(toPoint(point), { halfExtents });
    if (!result.success) return null;
    return new THREE.Vector3(result.point.x, result.point.y, result.point.z);
  }

  /**
   * True when `point` is standing on walkable ground, within `tolerance`
   * metres horizontally.
   *
   * Distinct from `sample()` on purpose. `sample` answers "where is the nearest
   * walkable spot" and always finds one if anything is in range — so using it
   * as a containment test reports a point in the middle of a wall as being on
   * the navmesh, because the corridor next door is close enough. This one
   * compares the answer to the question.
   *
   * Horizontal distance only: standing a metre above the floor is normal (an
   * entity's origin is usually at its feet, but not always), while being a
   * metre to the side of the navmesh is not.
   */
  isOnNavMesh(point, tolerance = 0.5) {
    const nearest = this.sample(point, { x: Math.max(tolerance, 0.05), y: 4, z: Math.max(tolerance, 0.05) });
    if (!nearest) return false;
    const query = toPoint(point);
    return Math.hypot(nearest.x - query.x, nearest.z - query.z) <= tolerance + 1e-4;
  }

  /**
   * A random walkable point within `radius` of `center` — patrols, spawns.
   *
   * Detour's sampler walks the polygon graph rather than sampling a disc, so it
   * can and does return points beyond the radius when the polygons are large.
   * Rejecting and retrying is cheap and gives the caller the contract they
   * actually asked for; the closest attempt is returned if none land inside,
   * which beats returning null and making every caller write this loop.
   */
  randomPoint(center, radius = 10, attempts = 8) {
    if (!this.query) return null;
    const origin = toPoint(center);
    let best = null;
    let bestDistance = Infinity;
    for (let i = 0; i < attempts; i++) {
      const result = this.query.findRandomPointAroundCircle(origin, radius, {
        halfExtents: DEFAULT_HALF_EXTENTS,
      });
      if (!result.success) continue;
      const p = result.randomPoint;
      const distance = Math.hypot(p.x - origin.x, p.z - origin.z);
      if (distance <= radius) return new THREE.Vector3(p.x, p.y, p.z);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = new THREE.Vector3(p.x, p.y, p.z);
      }
    }
    if (!best) return null;
    // Every attempt overshot — likely a level made of a few very large polygons,
    // where the sampler's per-polygon choice is coarse. Pull the closest one
    // back to the radius and re-snap it, rather than handing back a point
    // outside the range the caller asked for.
    const pulled = best
      .clone()
      .sub(new THREE.Vector3(origin.x, best.y, origin.z))
      .setLength(radius * 0.95)
      .add(new THREE.Vector3(origin.x, best.y, origin.z));
    return this.sample(pulled) ?? best;
  }

  /**
   * Slides from `from` toward `to` along the navmesh, stopping at the first
   * wall. The query a "can I see/reach there directly" check wants — cheaper
   * than a full path, and it returns where you'd actually end up.
   */
  moveAlongSurface(from, to) {
    if (!this.query) return null;
    const start = this.query.findNearestPoly(toPoint(from), { halfExtents: DEFAULT_HALF_EXTENTS });
    if (!start?.success) return null;
    const result = this.query.moveAlongSurface(start.nearestRef, toPoint(from), toPoint(to));
    if (!result?.success) return null;
    const p = result.resultPosition;
    return new THREE.Vector3(p.x, p.y, p.z);
  }

  // --- debug ----------------------------------------------------------------

  /** Positions/indices of the baked navmesh, for the viewport overlay. */
  debugGeometry() {
    if (!this.navMesh || !this.recast.getNavMeshPositionsAndIndices) return null;
    const [positions, indices] = this.recast.getNavMeshPositionsAndIndices(this.navMesh);
    return { positions, indices };
  }

  dispose({ keepAgents = false } = {}) {
    if (!keepAgents) {
      this._unsubUpdate?.();
      this._unsubUpdate = null;
      this.agents.clear();
      this.links.clear();
    }
    this.crowd?.destroy?.();
    this.query?.destroy?.();
    this.navMesh?.destroy?.();
    this.crowd = null;
    this.query = null;
    this.navMesh = null;
  }
}

/** Accepts a Vector3, an [x,y,z] tuple or an {x,y,z}, as recast's plain object. */
function toPoint(value) {
  if (Array.isArray(value)) return { x: value[0] ?? 0, y: value[1] ?? 0, z: value[2] ?? 0 };
  return { x: value?.x ?? 0, y: value?.y ?? 0, z: value?.z ?? 0 };
}
