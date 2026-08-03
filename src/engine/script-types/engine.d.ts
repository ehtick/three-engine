/**
 * Type declarations for the `engine` bare specifier. Scripts import from this
 * specifier (e.g. `import { attribute } from "engine"`); at runtime the editor
 * rewrites it to the runtime proxy module's URL (see `scriptRuntime.js`). This
 * file makes the same surface visible to the TS language service so editor
 * autocomplete / type-checking works.
 *
 * ## three's types are re-exported, never redeclared
 *
 * Everything three owns — `Vector3`, `Object3D`, `Color`, … — is re-exported
 * from `three/webgpu` below rather than described by hand. That is not a
 * stylistic preference: this file used to hand-declare ~170 lines of three's
 * math API, and it had silently drifted. It declared `Quaternion.inverse()`,
 * which three renamed to `invert()` years ago, so anyone following
 * autocomplete got a runtime crash. It also declared `Object3D` as a
 * 14-member subset, which lies to the type system exactly when a script
 * reaches for the three escape hatch.
 *
 * A re-export cannot drift. If three renames something, the error surfaces at
 * `tsc` time against the real definition instead of in a user's game. Add
 * nothing here that three already defines.
 */
declare module "engine" {
  /**
   * three's real types, re-exported so `import { Vector3 } from "engine"`
   * gives the identical type the engine itself uses. Mirrors the runtime
   * exports in `scriptRuntime/runtime.js` — keep the two lists in sync.
   *
   * Scene-graph and rendering types are deliberately NOT re-exported here:
   * entities own the scene graph, and wanting `Mesh` / `InstancedMesh` /
   * materials / loaders means you want the escape hatch, which is a
   * first-class option and fully typed:
   *
   *     import * as THREE from "three";
   *     import { Fn, uniform } from "three/tsl";
   *
   * `Object3D` and `Camera` are exceptions, kept because `Entity.object3D`
   * and the camera component expose them directly.
   */
  // Imported (not just re-exported) so the declarations further down this file
  // can reference the real types: `export ... from` creates no local binding.
  import {
    Vector2,
    Vector3,
    Vector4,
    Quaternion,
    Euler,
    Matrix3,
    Matrix4,
    Color,
    Box2,
    Box3,
    Sphere,
    Plane,
    Ray,
    Raycaster,
    Frustum,
    Line3,
    Triangle,
    Spherical,
    Cylindrical,
    MathUtils,
    Clock,
    Layers,
    Object3D,
    Camera,
  } from "three/webgpu";

  export {
    Vector2,
    Vector3,
    Vector4,
    Quaternion,
    Euler,
    Matrix3,
    Matrix4,
    Color,
    Box2,
    Box3,
    Sphere,
    Plane,
    Ray,
    Raycaster,
    Frustum,
    Line3,
    Triangle,
    Spherical,
    Cylindrical,
    MathUtils,
    Clock,
    Layers,
    Object3D,
    Camera,
  };

  /**
   * Subset of the runtime `Entity` class. Transform properties and the most
   * common Object3D methods are aliased directly on the entity so scripts
   * can write `this.entity.position.set(0, 1, 0)` instead of
   * `this.entity.object3D.position.set(0, 1, 0)`. The underlying
   * `object3D` is still typed and reachable for matrix ops and the
   * scene-graph tree.
   */
  export interface Entity {
    id: string;
    name: string;
    object3D: Object3D;
    parent: Entity | null;
    children: Entity[];

    // Transform aliases — get/set both delegate to object3D. Mutation via
    // `this.entity.position.x = 5` works because the getter returns the
    // same Vector3 instance the object3D owns. Setters also accept
    // `[x, y, z]` tuples, which is common for serialized transforms.
    position: Vector3;
    rotation: Euler;
    quaternion: Quaternion;
    scale: Vector3;
    visible: boolean;
    up: Vector3;

    // Forwarded Object3D methods — taking the same args as Object3D.
    lookAt(target: Vector3 | Object3D): void;
    getWorldPosition(target: Vector3): Vector3;
    getWorldQuaternion(target: Quaternion): Quaternion;
    getWorldScale(target: Vector3): Vector3;
    getWorldDirection(target: Vector3): Vector3;
    updateMatrix(): void;
    updateMatrixWorld(force?: boolean): void;

    /**
     * Attach a component by registered type string or component class:
     *
     *     import { MeshComponent } from "engine";
     *     this.entity.addComponent(MeshComponent);
     *     this.entity.addComponent("mesh", { geometry: "sphere" });
     */
    addComponent<C extends { readonly type: keyof ComponentMap }>(
      ctor: C,
      props?: Record<string, unknown>,
    ): ComponentMap[C["type"]];
    addComponent<K extends keyof ComponentMap>(
      type: K,
      props?: Record<string, unknown>,
    ): ComponentMap[K];
    addComponent(type: string | { readonly type: string }, props?: Record<string, unknown>): unknown;

    /**
     * Component on this entity by registered type string or class token.
     * Prefer the class form so typos fail at compile time and the return
     * type resolves automatically:
     *
     *     import { MeshComponent, CharacterControllerComponent } from "engine";
     *     const mesh = this.entity.getComponent(MeshComponent);
     *     const cc = this.entity.getComponent(CharacterControllerComponent);
     *
     * Known type strings (e.g. `"charactercontroller"`, `"model"`) still
     * resolve via {@link ComponentMap}. Unknown strings fall back to `T`
     * (defaulting to `unknown`) for custom/module component types.
     */
    getComponent<C extends { readonly type: keyof ComponentMap }>(
      ctor: C,
    ): ComponentMap[C["type"]] | undefined;
    getComponent<K extends keyof ComponentMap>(type: K): ComponentMap[K] | undefined;
    getComponent<T = unknown>(type: string | { readonly type: string }): T | undefined;

    removeComponent(type: string | { readonly type: string }): void;

    /**
     * A script on this entity by class name, file stem, or asset path — the
     * usual way one behaviour talks to another:
     *
     *     const health = this.entity.getScript<Health>("Health");
     *     health?.damage(10);
     */
    getScript<T = Script>(name: string): T | null;

    /**
     * Calls `hook` on every script attached to this entity, returning true if
     * any handled it. Lets scripts signal each other without knowing what else
     * is attached:
     *
     *     this.entity.dispatch("onDamaged", amount);
     */
    dispatch(hook: string, ...args: unknown[]): boolean;

    /**
     * True when this entity survives `engine.loadScene` — game managers, the
     * audio listener, a player that carries between levels. Serialised, so it
     * can also be ticked on the entity in the editor.
     */
    persistent: boolean;
    setPersistent(value: boolean): void;

    /**
     * True while this entity is parked in an object pool: out of the scene and
     * out of every query, but not destroyed. Check it before acting on a
     * reference you held across a despawn.
     */
    readonly pooled: boolean;

    setParent(parent: Entity | null): void;
    traverse(fn: (entity: Entity) => void): void;
    getTransform(): {
      position: [number, number, number];
      rotation: [number, number, number];
      scale: [number, number, number];
    };
    setTransform(t: {
      position?: [number, number, number];
      rotation?: [number, number, number];
      scale?: [number, number, number];
    }): void;
    /** THREE-style lookup of a child Object3D by exact name. Walks the entire
     *  three.js subtree (including meshes / helpers that are NOT entities). */
    getObjectByName(name: string): Object3D | null;
    /** Entity-aware lookup. Walks this entity's `children` (other entities
     *  only) depth-first and returns the first match, or null. Use this when
     *  you want to navigate to a child *entity* — `getObjectByName` returns a
     *  raw three.js Object3D which is missing the engine's component API,
     *  position/rotation aliases, and entity-tree navigation. */
    getEntityByName(name: string): Entity | null;

    /**
     * Recursively collect every component matching `type` from this entity
     * and all descendants (depth-first). Always returns an array — empty
     * when nothing matches, never null/undefined, so callers can use
     * `arr.length === 0` as a clean "not found" check.
     *
     * Compare against `getComponent(type)` if you only want this entity
     * itself. Prefer a class token exported from `"engine"`:
     *
     *     import { CameraComponent } from "engine";
     *     const cams = this.entity.findComponents(CameraComponent);
     *
     * Known component types (see {@link ComponentMap}) resolve to their
     * typed interface automatically, same as `getComponent`. Pass an explicit
     * `T` to override for custom/module component types not in the map.
     */
    findComponents<C extends { readonly type: keyof ComponentMap }>(
      ctor: C,
    ): ComponentMap[C["type"]][];
    findComponents<K extends keyof ComponentMap>(type: K): ComponentMap[K][];
    findComponents<T = unknown>(type: string | { readonly type: string }): T[];
  }

  /**
   * Base shape every component exposes, regardless of type. Mirrors the
   * runtime `Component` base class (`src/engine/components/Component.js`).
   */
  export interface ComponentBase {
    entity: Entity;
    /** The registered type string (e.g. `"mesh"`, `"charactercontroller"`). */
    type: string;
    /** Effective enabled state — composes `props.enabled` with any transient override. */
    enabled: boolean;
    props: Record<string, unknown>;
    setEnabled(value: boolean): void;
    setProp(key: string, value: unknown): void;
  }

  /** `entity.getComponent("model")` / `findComponents("model")`. */
  export interface ModelComponent extends ComponentBase {
    /** Root of the loaded GLTF scene graph, or `null` before it finishes loading. */
    root: Object3D | null;
    /** Animation clips available on this model (drives the sibling `AnimationComponent`). */
    clips: unknown[];
  }

  /** `entity.getComponent("animation")`. Drives a `.anim` state machine against the sibling Model component. */
  export interface AnimationComponent extends ComponentBase {
    /** Name of the currently playing state, or `null` if nothing is playing. */
    readonly currentState: string | null;
    /** Names of the clips available on the sibling `ModelComponent`. */
    getClipNames(): string[];
    setNumber(name: string, value: number): void;
    setBool(name: string, value: boolean): void;
    setTrigger(name: string): void;
    getParam(name: string): unknown;
    /** Transitions to `stateName` on `layer`, cross-fading over `fade` seconds (default 0.2). */
    play(stateName: string, fade?: number, layer?: number | string): void;
    /**
     * Blends an override/additive layer in or out (0..1). Layer 0 is the base
     * layer and is always at full weight — setting it is ignored.
     *
     *     anim.setLayerWeight("Aim", this.aiming ? 1 : 0);
     */
    setLayerWeight(layer: number | string, weight: number): void;
    getLayerWeight(layer: number | string): number;
    /** Current state name per layer, base first. */
    getLayerStates(): (string | null)[];
    /**
     * Root motion accumulated since the last call, in the entity's local space.
     * For `rootMotionTarget: "script"`, where a character controller consumes
     * the motion instead of it being written to the transform:
     *
     *     const { position, yaw } = anim.consumeRootMotion();
     *     this.entity.rotateY(yaw);
     *     controller.move(position.applyQuaternion(this.entity.quaternion));
     */
    consumeRootMotion(): { position: Vector3; yaw: number };
    /** This frame's root motion delta, without consuming it. */
    readonly rootMotionDelta: Vector3 | null;
  }

  /**
   * `entity.getComponent("timeline")`. The director for a `.timeline` asset —
   * keyframed properties plus animation, audio, event, activation and
   * camera-shot tracks.
   *
   *     const cutscene = this.entity.getComponent("timeline");
   *     cutscene.play();
   *     this.engine.on("timeline-event", ({ method }) => { ... });
   */
  export interface TimelineComponent extends ComponentBase {
    /** Length of the loaded timeline in seconds (0 before it loads). */
    readonly duration: number;
    /** Playhead position in seconds. */
    readonly time: number;
    readonly isPlaying: boolean;
    readonly isPaused: boolean;
    /** Starts (or restarts) playback; `from` defaults to the authored start time. */
    play(from?: number): void;
    pause(): void;
    resume(): void;
    /**
     * Stops and reverts everything the timeline animated. `{ hold: true }`
     * leaves the last sampled frame standing instead.
     */
    stop(options?: { hold?: boolean }): void;
    /** Moves the playhead and poses the scene there, without playing. */
    setTime(t: number): void;
    /** Alias of `setTime` — poses the scene at `t`. */
    evaluate(t: number): void;
  }

  /**
   * `entity.getComponent("ik")`. Two-bone IK correcting the sibling Model's
   * pose after the animator runs. Configure via `props` (see `static schema`);
   * drive it from a script by animating `props.weight`:
   *
   *     this.entity.getComponent("ik").setProp("weight", grounded ? 1 : 0);
   */
  export interface IKComponent extends ComponentBase {}

  /** `entity.getComponent("mesh")`. Geometry/material are data-driven via `props` — see `static schema`. */
  export interface MeshComponent extends ComponentBase {}

  /**
   * `entity.getComponent("camera")`. Also the virtual-camera "brain": when the
   * scene contains any `vcam`, this picks the highest-priority one and blends
   * the real camera onto it.
   */
  export interface CameraComponent extends ComponentBase {
    camera: Camera | null;
    /** The virtual camera currently driving this one, or null. */
    readonly live: VirtualCameraComponent | null;
    /** The highest-priority (or soloed) virtual camera right now. */
    pickVirtualCamera(engine: Engine): VirtualCameraComponent | null;
    /** Resolves `props.followTarget` (an entity id) against the live engine. */
    resolveFollowTarget(engine: Engine): Entity | null;
    /** Rotates the entity so -Z faces the follow target, when `enabled` and a target is configured. */
    applyLookAt(enabled: boolean, engine: Engine): void;
  }

  /**
   * `entity.getComponent("vcam")`. A *shot* — where a camera should be and what
   * it should look at. The Camera component blends between them by priority.
   *
   *     const cam = this.entity.getComponent("vcam");
   *     cam.addOrbit(dx * 2, dy * 2);     // boom arm, degrees
   *     cam.setProp("priority", 100);     // make this shot live
   */
  export interface VirtualCameraComponent extends ComponentBase {
    /** Set the boom arm's angles, in degrees. Pitch is clamped to the props. */
    setOrbit(yawDeg: number, pitchDeg: number): void;
    addOrbit(yawDeg: number, pitchDeg: number): void;
    getOrbit(): { yaw: number; pitch: number };
    /**
     * Snaps to the target pose on the next frame, skipping the damping. Call
     * after teleporting the follow target, or the camera films the trip.
     */
    warp(): void;
    /** Overrides priority entirely while set — the editor's Solo. */
    setSolo(value: boolean): void;
    readonly followTarget: Entity | null;
    readonly lookTarget: Entity | null;
  }

  /**
   * `entity.getComponent("impulsesource")`. An authored camera shake living on
   * the thing that causes it.
   *
   *     this.entity.getComponent("impulsesource").fire({ magnitude: 0.8 });
   */
  export interface ImpulseSourceComponent extends ComponentBase {
    fire(overrides?: Record<string, unknown>): unknown;
  }

  /** A position: a `Vector3`, an `[x, y, z]` tuple, or anything with x/y/z. */
  export type PointLike = Vector3 | number[] | { x: number; y: number; z: number };

  /**
   * `engine.debug` — immediate-mode debug drawing, from gameplay code.
   *
   *     this.engine.debug.ray(muzzle, forward, 50, "#ff0", 1);
   *     this.engine.debug.sphere(target.position, 0.5, "#f0f");
   *     this.engine.debug.text(this.entity.position, this.state);
   *
   * With no `duration` a shape lasts one frame, so drawing every frame needs no
   * cleanup. A `duration` (seconds, real time) is how you see a one-shot event:
   * a raycast fired inside a collision handler exists for a single frame, and
   * one frame of a red line at 120fps is not something a human can see.
   */
  /** Easing curve names accepted by `engine.tween`. */
  export type EasingName =
    | "linear"
    | "quadIn" | "quadOut" | "quadInOut"
    | "cubicIn" | "cubicOut" | "cubicInOut"
    | "quartIn" | "quartOut" | "quartInOut"
    | "sineIn" | "sineOut" | "sineInOut"
    | "expoIn" | "expoOut" | "expoInOut"
    | "backIn" | "backOut" | "backInOut"
    | "elasticOut" | "bounceOut";

  export interface TweenOptions {
    /** Seconds. Default 0.25. */
    duration?: number;
    /** Seconds to wait before starting. */
    delay?: number;
    ease?: EasingName | ((t: number) => number);
    /** Start values; defaults to whatever the target holds when it begins. */
    from?: Record<string, number>;
    /** Extra repeats. -1 loops forever. */
    loop?: number;
    /** Reverse on every repeat. */
    yoyo?: boolean;
    /**
     * Run on wall-clock time instead of game time, so the tween keeps going
     * while the game is paused — what a pause menu's own animation needs.
     */
    unscaled?: boolean;
    onUpdate?: (t: number, target: any) => void;
    onComplete?: (target: any) => void;
  }

  /** Handle returned by `engine.tween`. Awaitable. */
  export interface Tween extends PromiseLike<any> {
    readonly done: boolean;
    /** Stop here; the target keeps the value it reached. */
    cancel(): void;
    /** Jump to the end and fire `onComplete`. */
    complete(): void;
  }

  export interface DebugDraw {
    enabled: boolean;
    line(from: PointLike, to: PointLike, color?: string | number, duration?: number): DebugDraw;
    ray(origin: PointLike, direction: PointLike, length?: number, color?: string | number, duration?: number): DebugDraw;
    /** A line with a head, so which end is which is readable. */
    arrow(from: PointLike, to: PointLike, color?: string | number, duration?: number, headSize?: number): DebugDraw;
    /** `size` is the full extent, not the half-extent. */
    box(center: PointLike, size?: number | PointLike, color?: string | number, duration?: number, quaternion?: unknown): DebugDraw;
    sphere(center: PointLike, radius?: number, color?: string | number, duration?: number, segments?: number): DebugDraw;
    circle(center: PointLike, radius?: number, normal?: PointLike, color?: string | number, duration?: number, segments?: number): DebugDraw;
    /** Upright capsule — the shape a character controller actually is. */
    capsule(center: PointLike, radius?: number, height?: number, color?: string | number, duration?: number): DebugDraw;
    point(position: PointLike, size?: number, color?: string | number, duration?: number): DebugDraw;
    polyline(points: PointLike[], color?: string | number, duration?: number, closed?: boolean): DebugDraw;
    /** Red/green/blue triad for an Object3D or a Matrix4 — which way is it facing? */
    axes(target: unknown, size?: number, duration?: number): DebugDraw;
    /** Screen-facing label at a world position. */
    text(position: PointLike, message: unknown, color?: string, duration?: number, size?: number): DebugDraw;
    /** Drops every timed shape. */
    clear(): void;
    setEnabled(value: boolean): void;
  }

  /**
   * `engine.navigation` — recast/detour navmesh queries. Present only when the
   * Navigation module is enabled, and only usable once something has baked.
   */
  export interface NavigationSystem {
    /** False until a navmesh has been baked or loaded. */
    readonly isReady: boolean;
    /**
     * Corners of a path between two world points, or `[]` when there is no
     * route. An empty result usually means one END is off the navmesh — check
     * with `isOnNavMesh` before blaming the pathfinder.
     */
    findPath(from: PointLike, to: PointLike): Vector3[];
    /** Nearest point ON the navmesh, or null if nothing is in range. */
    sample(point: PointLike, halfExtents?: PointLike): Vector3 | null;
    /**
     * Whether `point` is standing on walkable ground, within `tolerance` metres
     * horizontally. Not the same question as `sample()` — that one always finds
     * the nearest walkable spot, so it answers "yes" for a point inside a wall
     * with a corridor next door.
     */
    isOnNavMesh(point: PointLike, tolerance?: number): boolean;
    /** A random walkable point within `radius` — patrol targets, spawns. */
    randomPoint(center: PointLike, radius?: number): Vector3 | null;
    /** Slides along the navmesh toward `to`, stopping at the first wall. */
    moveAlongSurface(from: PointLike, to: PointLike): Vector3 | null;
    /** Rebuilds from the current scene. Prefer the NavMesh component's Bake. */
    bake(settings?: Record<string, unknown>): { success: boolean; error?: string; stats?: unknown };
  }

  /**
   * `entity.getComponent("navagent")`. Pathfinding with local avoidance.
   *
   *     const agent = this.entity.getComponent("navagent");
   *     agent.setDestination(player.position);
   *     if (agent.isAtDestination) this.attack();
   */
  export interface NavAgentComponent extends ComponentBase {
    /**
     * Sends the agent to a world position, snapped to the nearest walkable
     * spot. Returns false when there is no navmesh, or nothing walkable near
     * the target.
     */
    setDestination(point: PointLike): boolean;
    /** Decelerates to a halt, keeping the destination for `resume()`. */
    stop(): void;
    resume(): void;
    /** Teleports without walking — respawns, doors, cutscenes. */
    warp(point: PointLike): boolean;
    readonly isStopped: boolean;
    readonly hasPath: boolean;
    /** Straight-line distance to the destination (not path length). */
    readonly remainingDistance: number;
    readonly isAtDestination: boolean;
    readonly velocity: Vector3;
    readonly isOnNavMesh: boolean;
    /** The corners the agent is currently steering through. */
    readonly path: Vector3[];
  }

  /** `entity.getComponent("navmesh")`. The scene's navmesh and bake settings. */
  export interface NavMeshComponent extends ComponentBase {
    bake(): { success: boolean; error?: string; stats?: unknown };
  }

  /** `entity.getComponent("navlink")`. An off-mesh link — a jump, ladder or drop. */
  export interface NavLinkComponent extends ComponentBase {
    endpoints(): { start: Vector3; end: Vector3 };
  }

  /** A placed decal. Returned by `engine.decals.spawn`, or null when the
   *  projector found no geometry to cut. */
  export interface DecalHandle {
    /** Vertices this decal contributed to its batch. */
    readonly vertexCount: number;
    /** Seconds this decal has existed (game time). */
    readonly age: number;
    /** Takes it off the wall immediately. */
    remove(): void;
  }

  export interface DecalSpawnOptions {
    /** Surface point — what a raycast hit gives you. */
    position?: PointLike;
    /** Surface normal. The decal is oriented to project back down it. */
    normal?: PointLike;
    /** Explicit orientation instead of `normal`. */
    rotation?: { x: number; y: number; z: number; w: number };
    /** Explicit world matrix instead of position/normal. */
    matrix?: unknown;
    /** Spin around the projection axis — randomise it so repeated hits don't
     *  read as the same sprite stamped twice. */
    roll?: number;
    /** A number for a cube, or `[x, y, z]`: the texture spans x/y and z is how
     *  deep the projector reaches into the surface. */
    size?: number | PointLike;
    /** Project-relative texture path. */
    texture?: string;
    color?: string | number;
    opacity?: number;
    /** Lit decals take scene lighting; unlit ones are drawn flat. */
    lit?: boolean;
    blending?: "alpha" | "additive";
    /** Faces angled further than this from the projector are skipped, so a
     *  decal on a thin wall doesn't also appear on the far side. */
    maxAngle?: number;
    /** Lift off the surface, in metres, to beat z-fighting. */
    offset?: number;
    /** Seconds before it disappears. 0 = permanent (until the cap evicts it). */
    lifetime?: number;
    /** Seconds of fade-out at the end of `lifetime`. */
    fadeTime?: number;
    /** Only project onto entities carrying this tag. */
    tag?: string;
  }

  /**
   * `engine.decals` — bullet holes, blood, scorch marks, footprints.
   *
   *     const hit = this.engine.physics.raycast(origin, direction, 50);
   *     if (hit) this.engine.decals.spawn({
   *       position: hit.point, normal: hit.normal,
   *       texture: "textures/bullet_hole.png", size: 0.15, lifetime: 20, fadeTime: 3 });
   *
   * Decals sharing a texture and blend mode are merged into one draw call, and
   * `maxDecals` evicts the oldest — a level must not get slower the longer the
   * fight goes on.
   */
  export interface DecalSystem {
    /** Places a decal, or returns null if the projector hit nothing. */
    spawn(options: DecalSpawnOptions): DecalHandle | null;
    remove(handle: DecalHandle): void;
    /** Drops every decal (also done automatically on Stop and scene change). */
    clear(): void;
    /** Hard cap; the oldest is evicted past it. Default 256. */
    maxDecals: number;
    readonly decals: DecalHandle[];
  }

  /** `entity.getComponent("line")`. A polyline with width — beams, ropes, aim
   *  indicators. Styling lives in `props`; the points are the API. */
  export interface LineRendererComponent extends ComponentBase {
    readonly pointCount: number;
    getPoint(index: number): Vector3 | null;
    /** Replaces every point. Accepts Vector3s, `[x,y,z]` or `{x,y,z}`. */
    setPoints(points: PointLike[]): LineRendererComponent;
    setPoint(index: number, point: PointLike): LineRendererComponent;
    addPoint(point: PointLike): LineRendererComponent;
    clearPoints(): LineRendererComponent;
    /** Rebuilds the strip. Only needed after mutating `props.points` directly. */
    rebuild(): void;
  }

  /** `entity.getComponent("trail")`. A ribbon that follows the entity and fades
   *  behind it. Points are recorded in world space, on game time. */
  export interface TrailRendererComponent extends ComponentBase {
    /** Recorded points currently alive. */
    readonly pointCount: number;
    /** Drops the history — call this after a teleport, or the trail draws a
     *  streak across the level. */
    clear(): TrailRendererComponent;
    setEmitting(value: boolean): TrailRendererComponent;
  }

  /** `entity.getComponent("decal")`. An authored projector; see `props` for its
   *  box, texture and filters. */
  export interface DecalComponent extends ComponentBase {
    /** Re-projects against the current geometry. Needed after changing the
     *  surface in a way nothing announces (a terrain sculpt, a mesh edit). */
    project(): DecalHandle | null;
    /** Triangles the last projection produced; 0 means it hit nothing. */
    readonly triangleCount: number;
  }

  /** `entity.getComponent("lod")`. Picks which child entity draws, by how much
   *  of the frame's height the group covers. Level 0 is the finest child. */
  export interface LodGroupComponent extends ComponentBase {
    /** Level currently drawn; -1 when culled, null before the first frame. */
    readonly activeLevel: number | null;
    /** Share of the viewport's height the group covered on the last update. */
    readonly coverage: number;
    /** The child entities acting as levels, finest first. */
    readonly levelEntities: Entity[];
    /** Thresholds, always as long as the child list. */
    readonly thresholds: number[];
    /** Puts every level back under the ordinary visibility rules. */
    releaseLevels(): void;
  }

  /** An orthonormal frame on a path: where it is, which way it heads, and
   *  which way is "up" for it at that point (after any authored bank). */
  export interface SplineFrame {
    position: Vector3;
    tangent: Vector3;
    normal: Vector3;
    binormal: Vector3;
    distance: number;
  }

  /** One authored control point. Handles are relative to `position` and are
   *  only read in `bezier` mode; `roll` banks the frame, in degrees. */
  export interface SplineKnot {
    position: number[];
    handleIn: number[];
    handleOut: number[];
    roll: number;
  }

  /** Result of projecting a point onto a path. */
  export interface SplineHit {
    /** Arc length along the path, in the path's own units. */
    distance: number;
    /** 0..1 along the path. */
    t: number;
    point: Vector3;
    sqDistance: number;
  }

  /**
   * `entity.getComponent("spline")`. A path in the scene — a road, a patrol
   * route, a camera rail. Knots are LOCAL to the entity, so moving the path
   * entity moves the whole path; use the `world*` queries for world space.
   *
   *     const path = this.engine.findEntity("Patrol").getComponent("spline");
   *     const target = path.worldPointAt(this.distance);
   */
  export interface SplineComponent extends ComponentBase {
    /** Total arc length, in the path's own (local) units. */
    readonly length: number;
    /** Length scaled by the entity's world scale. */
    readonly worldLength: number;
    readonly knotCount: number;
    readonly closed: boolean;
    /** Bumped on every rebuild; cache derived data against it. */
    readonly version: number;
    pointAt(distance: number, out?: Vector3): Vector3;
    tangentAt(distance: number, out?: Vector3): Vector3;
    frameAt(distance: number, out?: SplineFrame): SplineFrame;
    worldPointAt(distance: number, out?: Vector3): Vector3;
    worldFrameAt(distance: number, out?: SplineFrame): SplineFrame;
    /** Nearest point on the path to a WORLD position. */
    closestPoint(worldPoint: Vector3, out?: SplineHit): SplineHit;
    getKnot(index: number): SplineKnot | null;
    setKnot(index: number, knot: Partial<SplineKnot>): SplineComponent;
    addKnot(position: PointLike, index?: number): SplineComponent;
    removeKnot(index: number): SplineComponent;
    setKnots(knots: Partial<SplineKnot>[]): SplineComponent;
  }

  /** `entity.getComponent("splineFollower")`. Moves its entity along a path.
   *  `position` is a plain prop, so a timeline can key it. */
  export interface SplineFollowerComponent extends ComponentBase {
    /** The path being followed, or null while it is unwired. */
    readonly path: SplineComponent | null;
    readonly pathLength: number;
    /** 0..1 along the path — what a progress bar wants. */
    readonly progress: number;
    /** True once a `once`/`clamp` path has reached its end. */
    readonly finished: boolean;
    /** Distance travelled, in the path's own units. */
    position: number;
    play(): SplineFollowerComponent;
    pause(): SplineFollowerComponent;
    /** Jumps to a distance and clears the finished latch. */
    seek(distance?: number): SplineFollowerComponent;
    /** Re-applies the pose from the current `position`. */
    apply(): void;
  }

  /** `entity.getComponent("splineMesh")`. Geometry swept along a path. */
  export interface SplineMeshComponent extends ComponentBase {
    readonly triangleCount: number;
    /** Queues a re-sweep for the next frame. Safe to call per pointer event. */
    invalidate(): void;
    /** Re-sweeps immediately. */
    rebuild(): void;
  }

  /** `engine.lod` — drives every LOD group once per frame. */
  export interface LodSystem {
    enabled: boolean;
    setEnabled(value: boolean): void;
    readonly stats: { groups: number; culled: number; switches: number };
  }

  /** `engine.cameraImpulse` — camera shake, decoupled from which camera is live. */
  export interface ImpulseSystem {
    /**
     * Fires a shake. `position` + `radius` make it fall off with distance;
     * omit them for a global rumble.
     *
     *     this.engine.cameraImpulse.emit({
     *       position: this.entity.position, magnitude: 0.4, duration: 0.5, radius: 20 });
     */
    emit(options: {
      position?: Vector3 | number[] | null;
      magnitude?: number;
      duration?: number;
      frequency?: number;
      radius?: number;
      direction?: Vector3 | number[] | null;
      rotation?: number;
      attack?: number;
    }): unknown;
    /** Drops every live impulse. */
    clear(): void;
    readonly count: number;
  }

  /** `entity.getComponent("light")`. Light kind/color/shadow params live in `props` — see `static schema`. */
  export interface LightComponent extends ComponentBase {
    /** The underlying three.js light instance (`DirectionalLight` / `PointLight` / `SpotLight` / `AmbientLight`). */
    light: unknown;
  }

  /** `entity.getComponent("listener")`. One listener is active scene-wide; see the component's doc comment for claim rules. */
  export interface ListenerComponent extends ComponentBase {}

  /** `entity.getComponent("sound")`. Playback is driven by `engine.audio`; entries live in `props.entries`. */
  export interface SoundComponent extends ComponentBase {
    /** Plays one entry immediately (used by the inspector's Preview button). Returns a handle with `stop()`, or `null` if not ready. */
    previewEntry(entryId: string): { stop(): void } | null;
    /** Read-only slot list (one per active entry). */
    getSlots(): unknown[];
  }

  /** `entity.getComponent("instancer")`. Hardware-instances the sibling `MeshComponent`/`ModelComponent`'s geometry; see `static schema`. */
  export interface InstancerComponent extends ComponentBase {
    /** Re-rolls the seeded RNG and rebuilds the instance transforms. */
    regenerate(): void;
  }

  /** `entity.getComponent("particles")`. Emission/shape/color-over-life are graph-driven via `props`. */
  export interface ParticleComponent extends ComponentBase {
    /** Resets the simulation (clears all live particles and restarts emission). */
    restart(): void;
  }

  /**
   * `entity.getComponent("rigidbody")`. Physics body driven by the Rapier world
   * while playing (requires the `physics-rapier` module) — all methods no-op
   * outside play mode. `bodyType`/`mass`/damping/locks live in `props`.
   */
  export interface RigidbodyComponent extends ComponentBase {
    applyImpulse(v: [number, number, number]): void;
    applyForce(v: [number, number, number]): void;
    applyTorqueImpulse(v: [number, number, number]): void;
    setLinearVelocity(v: [number, number, number]): void;
    getLinearVelocity(): [number, number, number];
    setAngularVelocity(v: [number, number, number]): void;
    getAngularVelocity(): [number, number, number];
    /** Teleports the body (world position, optional quaternion `[x,y,z,w]`); zeroes velocity. */
    teleport(position: [number, number, number], quaternion?: [number, number, number, number]): void;
  }

  /**
   * `entity.getComponent("collider")`. Collision shape (requires the
   * `physics-rapier` module); pairs with a Rigidbody on this entity or the
   * nearest ancestor. Shape/size/friction/etc. live in `props`.
   */
  export interface ColliderComponent extends ComponentBase {}

  /**
   * `entity.getComponent("charactercontroller")`. Kinematic character
   * controller (requires the `physics-rapier` module) — walks, climbs
   * slopes/steps, and slides along walls without a separate Rigidbody or
   * Collider. Movement is velocity-based (units/second); gravity is applied
   * internally when `props.applyGravity` is on.
   */
  export interface CharacterControllerComponent extends ComponentBase {
    /** Sets desired horizontal velocity (units/s). `y` is ignored — gravity/jump own vertical motion. */
    move(v: [number, number, number]): void;
    /** Launches upward at `speed` (units/s) — only takes effect when grounded. */
    jump(speed: number): void;
    /** Overrides the full velocity vector directly (advanced — bypasses `move`/`jump`). */
    setVelocity(v: [number, number, number]): void;
    getVelocity(): [number, number, number];
    /** Touching the floor after the last physics step? */
    isGrounded(): boolean;
    /** The moving platform the character is standing on, or null. The controller
     *  already carries the character along — this is for gameplay that needs to
     *  know (parenting an effect, "you are on the lift" triggers). */
    getPlatform(): Entity | null;
    /** Instantly repositions the character (world space) and clears fall speed. */
    teleport(v: [number, number, number]): void;
  }

  /**
   * `entity.getComponent("joint")`. A constraint between this entity's
   * Rigidbody and another one (requires the `physics-rapier` module) — doors,
   * ropes, swings, suspension. The joint only exists while playing, so these
   * methods no-op in the editor. Kind/anchors/limits live in `props`.
   *
   * Hinge angles are in DEGREES, slider offsets in metres — the same units the
   * Inspector shows.
   */
  export interface JointComponent extends ComponentBase {
    /** Drives the joint like a motor — an automatic door, a winch, a powered
     *  wheel. Hinge and slider only. */
    setMotorVelocity(speed: number, maxForce?: number): void;
    /** Drives the joint toward an angle (hinge) or offset (slider). */
    setMotorTarget(target: number, stiffness?: number, damping?: number): void;
    setLimits(min: number, max: number): void;
  }

  /**
   * Maps every built-in registered component type string to its typed
   * interface. `getComponent`/`findComponents` key off this so
   * `entity.getComponent("charactercontroller")` resolves to
   * {@link CharacterControllerComponent} automatically, with full
   * autocomplete on its methods — no cast needed.
   *
   * Physics types (`rigidbody`, `collider`, `charactercontroller`, `joint`)
   * are only actually attachable when the project has the `physics-rapier`
   * module enabled; typing them here is safe either way since `getComponent`
   * already returns `| undefined`.
   *
   * Every key here MUST be the component's registered `static type` string —
   * a near-miss (`character` for `charactercontroller`) doesn't error, it
   * silently falls through to the `getComponent<T = unknown>` overload and
   * quietly costs the autocomplete this map exists to provide.
   *
   * Custom components registered by other modules aren't in this map — use
   * the explicit generic form (`getComponent<MyType>("mytype")`) or pass a
   * class/token with `static type` for those.
   *
   * Prefer `import { MeshComponent } from "engine"` and
   * `entity.getComponent(MeshComponent)` over bare strings when the type is
   * listed here — the class token's `type` literal selects the same entry.
   */
  export interface ComponentMap {
    model: ModelComponent;
    animation: AnimationComponent;
    timeline: TimelineComponent;
    ik: IKComponent;
    mesh: MeshComponent;
    camera: CameraComponent;
    vcam: VirtualCameraComponent;
    impulsesource: ImpulseSourceComponent;
    navmesh: NavMeshComponent;
    navagent: NavAgentComponent;
    navlink: NavLinkComponent;
    light: LightComponent;
    listener: ListenerComponent;
    sound: SoundComponent;
    instancer: InstancerComponent;
    particles: ParticleComponent;
    line: LineRendererComponent;
    trail: TrailRendererComponent;
    decal: DecalComponent;
    lod: LodGroupComponent;
    spline: SplineComponent;
    splineFollower: SplineFollowerComponent;
    splineMesh: SplineMeshComponent;
    rigidbody: RigidbodyComponent;
    collider: ColliderComponent;
    charactercontroller: CharacterControllerComponent;
    joint: JointComponent;
    script: ScriptComponent;
  }

  /**
   * Lookup tokens for `getComponent` / `findComponents` / `addComponent` /
   * `removeComponent`. Each shares its name with the instance interface above
   * (value + type merge): import the const, pass it to `getComponent`, and
   * IntelliSense on the result comes from the matching interface.
   *
   *     import { MeshComponent } from "engine";
   *     const mesh = this.entity.getComponent(MeshComponent);
   *
   * Keep the `type` literals in sync with {@link ComponentMap} and the
   * re-exports in `scriptRuntime/runtime.js`.
   */
  interface ComponentClass<T extends string> {
    readonly type: T;
  }

  export const MeshComponent: ComponentClass<"mesh">;
  export const ModelComponent: ComponentClass<"model">;
  export const AnimationComponent: ComponentClass<"animation">;
  export const TimelineComponent: ComponentClass<"timeline">;
  export const IKComponent: ComponentClass<"ik">;
  export const CameraComponent: ComponentClass<"camera">;
  export const VirtualCameraComponent: ComponentClass<"vcam">;
  export const ImpulseSourceComponent: ComponentClass<"impulsesource">;
  export const LightComponent: ComponentClass<"light">;
  export const ListenerComponent: ComponentClass<"listener">;
  export const SoundComponent: ComponentClass<"sound">;
  export const InstancerComponent: ComponentClass<"instancer">;
  export const ParticleComponent: ComponentClass<"particles">;
  export const LineRendererComponent: ComponentClass<"line">;
  export const TrailRendererComponent: ComponentClass<"trail">;
  export const DecalComponent: ComponentClass<"decal">;
  export const LodGroupComponent: ComponentClass<"lod">;
  export const SplineComponent: ComponentClass<"spline">;
  export const SplineFollowerComponent: ComponentClass<"splineFollower">;
  export const SplineMeshComponent: ComponentClass<"splineMesh">;
  export const ScriptComponent: ComponentClass<"script">;

  export const RigidbodyComponent: ComponentClass<"rigidbody">;
  export const ColliderComponent: ComponentClass<"collider">;
  export const CharacterControllerComponent: ComponentClass<"charactercontroller">;
  export const JointComponent: ComponentClass<"joint">;

  export const NavMeshComponent: ComponentClass<"navmesh">;
  export const NavAgentComponent: ComponentClass<"navagent">;
  export const NavLinkComponent: ComponentClass<"navlink">;

  /** One entry in a script component's list. */
  export interface ScriptSlot {
    /** Project-relative path to the `.js` / `.ts` file. */
    path: string;
    /** Per-script toggle. A disabled script keeps its attribute values. */
    enabled?: boolean;
    /** Saved `@attribute` values, keyed by field name. */
    attributes?: Record<string, unknown>;
  }

  /**
   * Holds the list of scripts attached to an entity. Array order is execution
   * order.
   *
   * Reach a sibling script through `getScript` rather than by index — indices
   * shift when someone reorders the list in the inspector:
   *
   *     const health = this.entity.getScript("Health");
   */
  export interface ScriptComponent extends ComponentBase {
    props: { scripts: ScriptSlot[]; enabled?: boolean; viewOnly?: boolean };
    /** Live instances, in execution order. Includes disabled scripts. */
    readonly instances: Script[];
    /** First instance. Prefer `getScript` when several are attached. */
    readonly instance: Script | null;
    /** By class name, file stem, or full asset path; null when absent. */
    getScript<T = Script>(name: string): T | null;
    /** Calls `hook` on every running script that defines it. */
    dispatch(hook: string, ...args: unknown[]): boolean;
    /** `@attribute` descriptors declared by the script at `index`. */
    getAttributeDefs(index?: number): Record<string, AttributeOptions>;
  }

  /** Union of every value shape an action can carry, for callers that don't
   *  know the action's type at compile time. Discriminate by reading the
   *  action via `input.getAction(name)?.type` — TypeScript will narrow the
   *  `value` field for you.
   *
   *  For vec2 actions the value is a real `THREE.Vector2` instance with full
   *  methods (`.length()`, `.normalize()`, `.dot()`, …), not a plain object —
   *  the engine's input manager allocates a Vector2 per vec2 action and mutates
   *  it in place each tick. */
  export type ActionValue = boolean | number | Vector2;

  /** A live action. The `type` field is the discriminant — TypeScript narrows
   *  `value` automatically:
   *    type === "button" → value: boolean
   *    type === "value"  → value: number
   *    type === "vec2"   → value: Vector2 (THREE.Vector2) */
  export type Action =
    | ButtonAction
    | ValueAction
    | Vec2Action;

  /** Coordinate space the resolved value lives in. Only meaningful for vec2
   *  actions — buttons and value axes are scalar-shaped either way.
   *    "world"  (default) — input-space: x = strafe-right, y = forward. The
   *                        consumer rotates by the camera / facing if it cares.
   *    "camera" — the InputManager has already rotated by the active camera's
   *               yaw. `value.x` = world X, `value.y` = world Z (the vec2's
   *               `y` slot holds depth so the consumer can write straight into
   *               `entity.position.z`). The manager falls back to input-space
   *               when no camera provider is wired (e.g. unit tests). */
  export type ActionSpace = "world" | "camera";

  export interface ButtonAction {
    name: string;
    type: "button";
    /** Per-frame resolved value: `true` when held, `false` when released.
     *  The `onAction` callback also receives this. */
    value: boolean;
    /** "any" | "all" | "min" — how multiple bindings combine. See
     *  InputAction.composite in src/engine/input/Action.js. */
    composite: ActionComposite;
    /** Always "world" for buttons; surfaces here so the union shape stays
     *  consistent and code can read it without a type guard. */
    space: ActionSpace;
    bindings: BindingDef[];
    wasDown: boolean;
    pressedThisFrame: boolean;
    releasedThisFrame: boolean;
  }

  export interface ValueAction {
    name: string;
    type: "value";
    value: number;
    composite: ActionComposite;
    /** Always "world" for value axes. */
    space: ActionSpace;
    bindings: BindingDef[];
    wasDown: boolean;
    pressedThisFrame: boolean;
    releasedThisFrame: boolean;
  }

  export interface Vec2Action {
    name: string;
    type: "vec2";
    /** Real `THREE.Vector2` instance with `.length()`, `.normalize()`, etc.
     *  The manager mutates this in place each tick, so the same reference is
     *  returned every read — don't snapshot it for later comparison without
     *  `.clone()`-ing first.
     *
     *  When `space === "camera"`, this is already in world coordinates (XZ
     *  plane). When `space === "world"`, it stays in input space (x = strafe,
     *  y = forward) and the script rotates by the camera or facing if it
     *  cares about world. */
    value: Vector2;
    composite: ActionComposite;
    space: ActionSpace;
    bindings: BindingDef[];
    wasDown: boolean;
    pressedThisFrame: boolean;
    releasedThisFrame: boolean;
  }

  export type ActionComposite = "any" | "all" | "min";

  /** Plain-object description of one binding (the shape `addActionMap` accepts
   *  and the shape `ActionMap.toJSON()` produces). The runtime auto-detects
   *  composites from shape, but you can mark them with `kind: "composite"` or
   *  `kind: "binding"` to be explicit. */
  export type BindingDef =
    | BindingPlain
    | BindingExplicit
    | CompositeDef
    | CompositeShorthand;

  /** Shorthand composite — `{ type: "1d" | "2d", parts }` with no `kind`.
   *  The runtime detects this from the shape (a regular binding has a
   *  `path`, not a `parts` map) and upgrades it to a Composite. The
   *  serialized form (`ActionMap.toJSON()`) always uses the explicit
   *  `kind: "composite"` form so round-trips are stable. */
  export interface CompositeShorthand {
    type: "1d" | "2d";
    parts: CompositeParts;
  }

  /** Shorthand: just a `path` — the manager creates a regular binding. */
  export interface BindingPlain {
    path: string;
    negate?: boolean;
    scale?: number;
  }

  /** Explicit form of a regular binding. */
  export interface BindingExplicit {
    kind: "binding";
    id?: string;
    path: string;
    negate?: boolean;
    scale?: number;
  }

  /** Joins multiple sub-bindings into one logical value:
   *    type "2d" → { up, down, left, right } → { x, y } in [-1..1]^2
   *    type "1d" → { negative, positive }   → number in [-1..1]
   *  Each `parts.<slot>` is itself a `BindingDef`. */
  export interface CompositeDef {
    kind: "composite";
    id?: string;
    type: "1d" | "2d";
    parts: CompositeParts;
  }

  export interface CompositeParts {
    up?: BindingDef;
    down?: BindingDef;
    left?: BindingDef;
    right?: BindingDef;
    negative?: BindingDef;
    positive?: BindingDef;
  }

  /** Shape `addActionMap` accepts (and `toJSON()` produces). */
  export interface ActionMapDef {
    name: string;
    /** Which device groups this map listens to. `null` = listen to all
     *  schemes the manager was constructed with (defaults to
     *  ["KeyboardMouse", "Gamepad", "Touch"]). */
    schemes?: string[] | null;
    actions: ActionDef[];
  }

  export interface ActionDef {
    name: string;
    type: "button" | "value" | "vec2";
    composite?: ActionComposite;
    /** Coordinate space the resolved vec2 lives in. Only affects vec2
     *  actions; ignored for buttons and value axes. Default: "world". */
    space?: ActionSpace;
    bindings?: BindingDef[];
  }

  /** Live action map. Read-only view exposed via `input.getMap(name)`. */
  export interface ActionMap {
    name: string;
    schemes: string[] | null;
    actions: Map<string, Action>;
  }

  export type Unsub = () => void;

  export interface InputManager {
    /** Currently active device group ("KeyboardMouse" | "Gamepad" | "Touch"). */
    activeScheme: string;
    /** Device groups the manager is configured to track. */
    schemes: string[];
    /** True while the action is currently held down (latched last frame). */
    isPressed(actionName: string): boolean;
    /** True for the single tick the action transitioned to held. */
    wasPressedThisFrame(actionName: string): boolean;
    /** True for the single tick the action transitioned to released. */
    wasReleasedThisFrame(actionName: string): boolean;
    /** Current resolved value of the action. Shape depends on the action's
     *  type — narrow via `getAction(name)?.type` if you need to know.
     *  For vec2 actions this is a real `THREE.Vector2` (mutated in place
     *  each tick), so you can call `.length()`, `.normalize()`, `.dot()`,
     *  etc. directly.
     *  Returns `0` when the action isn't found. */
    readValue(actionName: string): ActionValue;
    /** Subscribe to press events for one action. Callback receives the
     *  action's current `value` — boolean for buttons, number for value
     *  actions, `{ x, y }` for vec2 actions. */
    onAction(
      name: string,
      cb: (value: ActionValue) => void,
    ): Unsub;
    /** Subscribe to release events for one action. Callback receives no
     *  arguments (the action name is already known from the `name` param). */
    onRelease(name: string, cb: () => void): Unsub;
    /** Looks up a live action by name. Returns `null` if no active map
     *  defines it. The returned action is the same instance the manager
     *  updates each tick, so reading `.value` after `getAction` gives you
     *  the current frame's value with a properly-typed shape. */
    getAction(name: string): Action | null;
    /** Looks up a live action map by name. */
    getMap(name: string): ActionMap | null;
    /** Adds (or replaces) an action map. Accepts the runtime `ActionMap`
     *  instance directly, or the plain-object shape used by `toJSON()`. */
    addActionMap(def: ActionMapDef): ActionMap;
    /** Removes an action map. Idempotent. */
    removeActionMap(name: string): void;
    /** Pushes the map onto the top of the active stack. */
    enableMap(name: string): void;
    /** Pops the map from the stack and resets its actions. */
    disableMap(name: string): void;
    /** Replaces the entire active stack with a single map. */
    setActiveMap(name: string): void;
    /** True if the map is currently on the stack. */
    isMapActive(name: string): boolean;
    /** Replaces the camera provider used for vec2 actions whose `space` is
     *  `"camera"`. The callback is invoked each tick and should return a
     *  `THREE.Camera` (anything with `getWorldDirection(target)` works) or
     *  `null`. The Engine wires `() => engine.camera` automatically; calling
     *  this from a script lets you pin a different camera for a sub-scene. */
    setCameraProvider(fn: (() => unknown) | null): void;
    /** Re-runs scheme auto-detection based on the most recent device input. */
    detectScheme(): string;
    /** Force-pin the active scheme. */
    setScheme(scheme: string): void;
    /** Round-trip the entire manager to a plain object (for save/load). */
    toJSON(): unknown;
    /** Clears all transient state (values, edge latches, devices). */
    reset(): void;
  }

  export interface EngineConfig {
    scriptHotReload: boolean;
    scriptReloadIntervalMs: number;
  }

  export interface SceneSettings {
    toneMapping: string;
    exposure: number;
    ambientColor: string;
    ambientIntensity: number;
    backgroundColor: string;
    shadowsEnabled: boolean;
    shadowType: "basic" | "pcf" | "pcfSoft" | "vsm";
  }

  export interface PhysicsHandle {
    /**
     * Closest hit along a ray, or null.
     *
     *     const hit = this.engine.physics.raycast(
     *       muzzle, forward, 100,
     *       { layers: ["Enemy", "Ground"], exclude: this.entity });
     */
    raycast(
      origin: [number, number, number] | Vector3,
      direction: [number, number, number] | Vector3,
      maxDistance?: number,
      options?: PhysicsQueryOptions,
    ): PhysicsHit | null;

    /** Every hit along the ray, nearest first. */
    raycastAll(
      origin: [number, number, number] | Vector3,
      direction: [number, number, number] | Vector3,
      maxDistance?: number,
      options?: PhysicsQueryOptions,
    ): PhysicsHit[];

    /**
     * Sweeps a shape and returns the first thing it would hit. Unlike a ray it
     * has thickness, so it cannot slip through a gap the character can't.
     */
    shapecast(
      shape: PhysicsQueryShape,
      origin: [number, number, number] | Vector3,
      direction: [number, number, number] | Vector3,
      maxDistance?: number,
      options?: PhysicsQueryOptions,
    ): PhysicsHit | null;
    spherecast(
      origin: [number, number, number] | Vector3,
      radius: number,
      direction: [number, number, number] | Vector3,
      maxDistance?: number,
      options?: PhysicsQueryOptions,
    ): PhysicsHit | null;
    boxcast(
      origin: [number, number, number] | Vector3,
      halfExtents: [number, number, number],
      direction: [number, number, number] | Vector3,
      maxDistance?: number,
      options?: PhysicsQueryOptions,
    ): PhysicsHit | null;
    capsulecast(
      origin: [number, number, number] | Vector3,
      radius: number,
      halfHeight: number,
      direction: [number, number, number] | Vector3,
      maxDistance?: number,
      options?: PhysicsQueryOptions,
    ): PhysicsHit | null;

    /**
     * Every entity overlapping a shape — explosion damage, interaction
     * prompts, "who is in this room". De-duplicated per entity.
     */
    overlap(shape: PhysicsQueryShape, center: [number, number, number] | Vector3, options?: PhysicsQueryOptions): Entity[];
    overlapSphere(center: [number, number, number] | Vector3, radius: number, options?: PhysicsQueryOptions): Entity[];
    overlapBox(center: [number, number, number] | Vector3, halfExtents: [number, number, number], options?: PhysicsQueryOptions): Entity[];
    overlapCapsule(center: [number, number, number] | Vector3, radius: number, halfHeight: number, options?: PhysicsQueryOptions): Entity[];

    setGravity(v: [number, number, number]): void;
    /** Replaces the layer names + collision matrix, applied live. */
    setLayers(config: { names?: string[]; matrix?: number[] }): void;
  }

  /**
   * Shared options for every physics query.
   *
   * `layers` is deliberately independent of the project's collision matrix: a
   * layer that collides with nothing is still queryable when you ask for it.
   * `exclude` is the "don't shoot yourself" argument — it covers the entity's
   * whole subtree, so a weapon parented under the player is excluded too.
   */
  export interface PhysicsQueryOptions {
    layers?: string | string[];
    exclude?: Entity | string | Array<Entity | string>;
    /** Count shapes the origin starts inside as hits. Default true. */
    solid?: boolean;
    /** Quaternion [x, y, z, w] for shape queries. Default identity. */
    rotation?: [number, number, number, number];
  }

  export interface PhysicsHit {
    entity: Entity | null;
    point: [number, number, number];
    normal: [number, number, number];
    distance: number;
  }

  export interface PhysicsQueryShape {
    kind: "sphere" | "box" | "capsule";
    radius?: number;
    halfExtents?: [number, number, number];
    halfHeight?: number;
  }

  export interface Engine {
    scene: { children: unknown[]; background: unknown; environment: unknown; fog: unknown };
    camera: Camera | null;
    renderer: unknown;
    entities: Map<string, Entity>;
    rootEntities: Entity[];
    playing: boolean;

    // ---- Game time ---------------------------------------------------------
    /**
     * Multiplier on the delta every update callback receives. 0.5 = half
     * speed, 2 = double, 0 = frozen. Rendering continues either way. Reset to
     * 1 when the game stops, so a bullet-time effect cannot leak into the
     * editor. Set it via `setTimeScale`.
     */
    readonly timeScale: number;
    setTimeScale(value: number): void;

    /**
     * Freezes game time while the render loop keeps running — what a pause
     * menu wants. UI driven by `unscaledDeltaTime` keeps animating.
     */
    readonly paused: boolean;
    setPaused(paused: boolean): void;

    /** Advances `frames` fixed slices of game time while paused. */
    step(frames?: number): void;

    /** The delta update callbacks received this frame (== their `dt`). */
    readonly deltaTime: number;
    /**
     * Wall-clock seconds since the last frame, ignoring timeScale and paused.
     * Use it for anything that must keep moving while the game is paused:
     *
     *     onUpdate() {
     *       this.menuSpin += this.engine.unscaledDeltaTime;
     *     }
     */
    readonly unscaledDeltaTime: number;
    /** Game-time seconds since play started (scaled, stops while paused). */
    readonly elapsedTime: number;
    /** Wall-clock seconds since the engine started. */
    readonly unscaledElapsedTime: number;
    /** Upper bound on a single frame's delta (default 0.25s). */
    maxDeltaTime: number;
    /** Delta used per `step()` frame (default 1/60). */
    stepDeltaTime: number;

    config: EngineConfig;
    settings: SceneSettings;
    input: InputManager;
    physics?: PhysicsHandle;
    /** Camera shake. Lives on the engine so a rumble survives a shot change. */
    cameraImpulse: ImpulseSystem;
    /**
     * Animates numeric properties toward `to` over `options.duration` seconds.
     * Dotted paths reach into nested objects:
     *
     *     this.engine.tween(this.entity.object3D, { "position.y": 3 },
     *                       { duration: 0.4, ease: "backOut" });
     *     await this.engine.tween(hud, { alpha: 0 }, { duration: 0.3 });
     *
     * On game time — a pause freezes it and bullet time slows it. Cleared on
     * Stop.
     */
    tween(target: object, to: Record<string, number>, options?: TweenOptions): Tween;
    /** Runtime debug drawing, visible in the viewport AND in Play/Game views. */
    debug: DebugDraw;
    /** Projected decals — bullet holes, blood, scorch marks. Cleared on Stop. */
    decals: DecalSystem;
    /** Detail-level selection for LOD groups. */
    lod: LodSystem;
    /** Navmesh queries. Only present when the Navigation module is enabled. */
    navigation?: NavigationSystem;
    onUpdate(fn: (dt: number) => void): Unsub;
    /**
     * Runs after every `onUpdate`, in ascending `order` (default 0). The pose
     * pipeline's stage list: IK solvers run at 0, bone-attachment sync at 100.
     * Use it when your work must observe the frame's FINAL bone transforms.
     */
    onLateUpdate(fn: (dt: number) => void, order?: number): Unsub;
    onPostRender(fn: () => void): Unsub;
    on(event: string, fn: (...args: any[]) => void): Unsub;
    off(event: string, fn: (...args: any[]) => void): void;
    emit(event: string, ...args: any[]): void;
    getEntity(id: string): Entity | null;
    createEntity(opts?: { id?: string; name?: string; parent?: Entity | null }): Entity;
    destroyEntity(entity: Entity): void;

    /**
     * Spawns a prefab and returns its root entity (null when the prefab can't
     * be found). Synchronous — prefabs are resolved before the scene loads, so
     * this is safe to call from `update()`.
     *
     * `ref` is a prefab asset path (what an `@attribute({ type: "prefab" })`
     * field gives you) or a prefab guid.
     *
     *   @attribute({ type: "prefab" }) bullet!: string;
     *
     *   fire(muzzle: Entity) {
     *     const b = this.entity.engine.instantiate(this.bullet, {
     *       position: muzzle.getWorldPosition(new Vector3()),
     *     });
     *   }
     */
    instantiate(
      ref: string | { guid?: string; path?: string },
      opts?: {
        parent?: Entity | null;
        position?: Vector3 | [number, number, number];
        rotation?: Vector3 | [number, number, number];
        scale?: Vector3 | [number, number, number];
        name?: string;
      },
    ): Entity | null;

    /**
     * `instantiate` spread across frames, under the spawn budget
     * (`engine.pool.budgetMs`). Use it for one-off heavy prefabs; for anything
     * spawned repeatedly, `spawn` is better — a pool removes the cost rather
     * than spreading it.
     *
     *   const boss = await this.engine.instantiateAsync(this.bossPrefab);
     */
    instantiateAsync(
      ref: string | { guid?: string; path?: string },
      opts?: {
        parent?: Entity | null;
        position?: Vector3 | [number, number, number];
        rotation?: Vector3 | [number, number, number];
        scale?: Vector3 | [number, number, number];
        name?: string;
      },
    ): Promise<Entity | null>;

    /**
     * Pooled spawn: reuses a parked instance of this prefab when there is one,
     * otherwise instantiates. Interchangeable with `instantiate` — a recycled
     * instance is restored to its prefab state and its scripts get a fresh
     * `onStart`, so `onStart` / `onDestroy` are the spawn / despawn hooks.
     *
     *   const b = this.engine.spawn(this.bullet, { position: muzzle });
     *   this.engine.despawn(b, 3);   // back to the pool in three seconds
     */
    spawn(
      ref: string | { guid?: string; path?: string },
      opts?: {
        parent?: Entity | null;
        position?: Vector3 | [number, number, number];
        rotation?: Vector3 | [number, number, number];
        scale?: Vector3 | [number, number, number];
        name?: string;
      },
    ): Entity | null;

    /**
     * Returns a pooled instance to its pool, or destroys an entity that never
     * came from one — so gameplay code can despawn uniformly. `delay` is in
     * seconds of game time.
     */
    despawn(entity: Entity | string, delay?: number): boolean;

    /** Prefab pools + the spawn budget. See {@link PoolHandle}. */
    pool: PoolHandle;

    /** Runtime scene loading. `engine.loadScene` is the shorthand. */
    scenes: SceneManagerHandle;

    /**
     * Loads a scene by project-relative path — the same string works in the
     * editor and in an exported build.
     *
     *   await this.engine.loadScene("scenes/Level2.scene");
     *   await this.engine.loadScene("scenes/Hud.scene", { mode: "additive" });
     *
     * Entities marked persistent (see `entity.setPersistent`) survive a
     * "single"-mode load; everything else in the outgoing scene is destroyed.
     * Resolves to the loaded scene, or null if another load superseded this
     * one before it finished.
     */
    loadScene(path: string, opts?: SceneLoadOptions): Promise<LoadedScene | null>;

    /** Removes an additively-loaded scene. True when it was loaded. */
    unloadScene(path: string): boolean;

    /** Marks an entity as surviving scene loads (Unity's DontDestroyOnLoad). */
    dontDestroyOnLoad(entity: Entity | string): Entity | null;

    /** Save slots — a snapshot of one playthrough. See {@link SaveHandle}. */
    saves: SaveHandle;

    /**
     * Preferences: volume, difficulty, keybinds, "seen the intro". Written
     * through to storage on every change and NOT touched by loading or
     * deleting a save slot — deleting every save must not reset the volume.
     *
     *     this.engine.prefs.set("volume", 0.5);
     *     const volume = this.engine.prefs.get("volume", 1);
     */
    prefs: KeyValueHandle;
  }

  /** A small persisted key/value bag (`engine.prefs`, `engine.saves.state`). */
  export interface KeyValueHandle {
    get(key: string, fallback?: any): any;
    set(key: string, value: any): any;
    has(key: string): boolean;
    delete(key: string): boolean;
    keys(): string[];
    clear(): void;
    /** Adds `amount` to a numeric key (missing = 0) — score, coins, kills. */
    increment(key: string, amount?: number): number;
    toJSON(): Record<string, any>;
  }

  /** One entry from `engine.saves.list()` — enough to draw a load menu. */
  export interface SaveHeader {
    slot: string;
    /** `Date.now()` when it was written. */
    savedAt: number;
    /** The scene the save belongs to, restored before its entity state. */
    scene: string | null;
    playTime: number;
    version: number;
    meta?: any;
    /** Present and true when the slot could not be parsed. */
    corrupt?: boolean;
  }

  /**
   * `engine.saves` — save slots.
   *
   * A save is NOT the whole scene. Scripts opt in with `onSave`/`onLoad`
   * (see {@link Script}); an entity whose script defines `onSave` is captured
   * along with its transform and enabled flag. Prefab instances spawned at
   * runtime are recorded with their prefab link and respawned on load, and
   * ones the save doesn't contain are removed — so an enemy killed before
   * saving is not standing there after loading.
   */
  export interface SaveHandle {
    /** Game progress captured into whichever slot is written next. */
    state: KeyValueHandle;
    /** False when storage is memory-only (blocked/absent localStorage). */
    readonly durable: boolean;
    /** The game's own save version (project setting `game.saveVersion`). */
    readonly version: number;
    namespace: string;

    /** Captures the live scene and writes it to `slot`. */
    save(slot: string | number, meta?: any): Promise<any>;
    /** Reads `slot` and applies it. False when missing, corrupt, or refused. */
    load(slot: string | number, opts?: { loadScene?: boolean; prune?: boolean }): Promise<boolean>;
    has(slot: string | number): Promise<boolean>;
    delete(slot: string | number): Promise<void>;
    /** Every written slot, newest first — headers only. */
    list(): Promise<SaveHeader[]>;

    /** Builds the payload without writing it (checkpoints, custom slot UI). */
    capture(meta?: any): any;
    /** Applies a payload from `capture()` / `read()`. */
    restore(data: any, opts?: { loadScene?: boolean; prune?: boolean }): Promise<boolean>;
    read(slot: string | number, opts?: { migrate?: boolean }): Promise<any>;
    write(slot: string | number, data: any): Promise<void>;

    /**
     * Registers an upgrade from version `toVersion - 1` to `toVersion`.
     * Migrations chain, so each one handles a single step. A save with no
     * path to the current version is REFUSED — silently feeding old data to
     * new scripts corrupts a playthrough hours before the player notices.
     */
    registerMigration(toVersion: number, fn: (data: any) => any): void;
  }

  export interface SceneLoadOptions {
    /** "single" replaces the current scene (default); "additive" adds to it. */
    mode?: "single" | "additive";
    /**
     * Prefetch the scene's assets before building it, so the level does not
     * pop in over the first seconds of play. Default true. Pass an array to
     * preload exactly those paths instead, or false to skip.
     */
    preload?: boolean | string[];
    /** Progress for a loading screen; also emitted as "scene-load-progress". */
    onProgress?: (p: SceneLoadProgress) => void;
    /**
     * Repoint `engine.camera` at the loaded scene's camera. Defaults to
     * "auto" — only while playing, so loading a scene in the editor never
     * steals the viewport camera.
     */
    setCamera?: boolean | "auto";
  }

  export interface SceneLoadProgress {
    path: string;
    mode: "single" | "additive";
    phase: "fetch" | "modules" | "preload" | "unload" | "instantiate";
    loaded: number;
    total: number;
    /** 0..1 across every phase. */
    progress: number;
  }

  export interface LoadedScene {
    path: string;
    name: string;
    mode: "single" | "additive";
    /** Ids of the roots this scene created. */
    rootIds: string[];
  }

  /** Per-prefab pool counters, keyed by prefab path. */
  export interface PoolStats {
    [prefab: string]: { free: number; active: number; created: number; reused: number; peak: number };
  }

  /**
   * `engine.pool` — prefab pooling and the spawn budget.
   *
   * Pools are keyed by prefab and only prefabs can be pooled: a recycled
   * instance is restored to its prefab, and there is nothing to restore an
   * arbitrary entity to.
   */
  export interface PoolHandle {
    /** Wall-clock milliseconds per frame the spawn queue may spend (default 2). */
    budgetMs: number;

    /** Parked instances across every pool. */
    readonly size: number;

    /** Queued spawns still waiting for room in the budget. */
    readonly pending: number;

    /** Pooled spawn. `engine.spawn` is the shorthand. */
    spawn(ref: string | { guid?: string; path?: string }, opts?: object): Entity | null;

    /** Queued pooled spawn — resolves when the budget gets to it. */
    spawnAsync(ref: string | { guid?: string; path?: string }, opts?: object): Promise<Entity | null>;

    /** Returns an instance to its pool. `engine.despawn` is the shorthand. */
    despawn(entity: Entity, delay?: number): boolean;

    /**
     * Fills a pool ahead of time, spread across frames. Tops up to `count`
     * rather than adding `count` more, so calling it twice is not a doubling.
     *
     *   await this.engine.pool.prewarm(this.enemyPrefab, 40);
     */
    prewarm(ref: string | { guid?: string; path?: string }, count?: number, opts?: object): Promise<number>;

    /** Instances of this prefab currently parked and ready. */
    free(ref: string | { guid?: string; path?: string }): number;

    /** Destroys parked instances (of one prefab, or all), leaving live ones. */
    clear(ref?: string | { guid?: string; path?: string } | null): void;

    /** Per-prefab counters — what a spawn-heavy scene is actually doing. */
    stats(): PoolStats;
  }

  export interface SceneManagerHandle {
    /** Loaded scenes, in load order. */
    loaded: LoadedScene[];
    /** The most recent "single"-mode scene — the level you are in. */
    active: LoadedScene | null;
    isLoading: boolean;
    isLoaded(path: string): boolean;
    load(path: string, opts?: SceneLoadOptions): Promise<LoadedScene | null>;
    unload(path: string): boolean;
  }

  /**
   * The three namespace as `this.THREE` exposes it — the real thing, not a
   * subset. `ScriptComponent` injects the engine's own three import, so this
   * is typed as that entire module.
   *
   * This used to be a 12-entry object type with `Object3D: unknown` in it.
   * Prefer a top-level `import * as THREE from "three"` in new scripts;
   * `this.THREE` predates the runtime being able to resolve bare specifiers
   * and is kept because existing scripts use it.
   */
  export const THREE: typeof import("three/webgpu");

  /**
   * Schema for an `@attribute`-decorated field. The editor reads this off the
   * loaded class (`static attributes`) and renders an Inspector field of the
   * matching kind (`number` / `text` / `boolean` / `select` / `vec3` /
   * `prefab`).
   *
   * Constraints on `min`/`max`/`step` only apply to numeric fields. The
   * `options` array supplies values for `select` fields. A `prefab` field
   * renders a prefab picker and holds the asset path — pass it straight to
   * `engine.instantiate()`.
   */
  export interface AttributeOptions {
    type?: "number" | "text" | "boolean" | "select" | "vec3" | "prefab";
    default?: unknown;
    min?: number;
    max?: number;
    step?: number;
    options?: Array<string | number>;
    label?: string;
  }

  /**
   * Class-field decorator that registers the field in the class's static
   * `attributes` map. The editor reads that map to render Inspector fields
   * and `ScriptComponent` applies saved values on start.
   */
  export function attribute(options?: AttributeOptions): PropertyDecorator;

  /**
   * Base class scripts extend for full IntelliSense on `this.entity`,
   * `this.engine`, `this.THREE`, `this.input`, plus the lifecycle methods.
   *
   * The runtime DOES NOT require extending this class — `ScriptComponent`
   * injects the four context properties on every script instance regardless
   * of its base class. This class exists purely as a type-system helper.
   */
  export class Script {
    entity: Entity;
    engine: Engine;
    THREE: typeof THREE;
    input: InputManager | null;

    /** Called when play starts (or when this script is enabled during play). */
    onStart?(): void;
    /** Called once per frame while playing. `dt` is in seconds. */
    onUpdate?(dt: number): void;
    /** Called when play stops, the script is disabled, or it is removed. */
    onDestroy?(): void;
    /**
     * Called instead of destroy/start when the file changes while playing.
     * Copy state across from `oldInstance` to survive the reload.
     */
    onHotReload?(oldInstance: Script): void;

    // --- hooks other systems dispatch -------------------------------------
    // These reach every script on the entity (see ScriptComponent.dispatch),
    // so several scripts can react to the same collision or click.

    /** Physics module: a non-sensor collider began touching `other`. */
    onCollisionEnter?(other: Entity): void;
    /** Physics module: a non-sensor collider stopped touching `other`. */
    onCollisionExit?(other: Entity): void;
    /** Physics module: `other` entered a sensor collider on this entity. */
    onTriggerEnter?(other: Entity): void;
    /** Physics module: `other` left a sensor collider on this entity. */
    onTriggerExit?(other: Entity): void;
    /** UI button on this entity was clicked. */
    onClick?(): void;
    /** Pointer entered this entity's UI button. */
    onPointerEnter?(): void;
    /** Pointer left this entity's UI button. */
    onPointerExit?(): void;

    // --- save/load ---------------------------------------------------------

    /**
     * Return the state this script needs restored later. Defining this hook is
     * what OPTS THE ENTITY IN to saves — its transform and enabled flag come
     * along automatically, so a script that only needs those can return
     * nothing:
     *
     *     onSave() { return { opened: this.opened }; }
     *
     * Return plain JSON-safe data (no entities, no three.js objects). Runs
     * whenever the game calls `engine.saves.save()` / `capture()`.
     */
    onSave?(): unknown;

    /**
     * Restores what `onSave` returned (or `null` if it returned nothing).
     * Runs AFTER the saved transform is applied, so setting a position here
     * has the last word.
     */
    onLoad?(data: any): void;
  }
}