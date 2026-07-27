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

    addComponent(type: string, props?: Record<string, unknown>): unknown;
    /** Known component types (e.g. `"charactercontroller"`, `"model"`) resolve to
     *  their typed interface automatically — no cast or generic needed. Unknown
     *  strings fall back to `T` (defaulting to `unknown`) for custom/module
     *  component types not in {@link ComponentMap}. */
    getComponent<K extends keyof ComponentMap>(type: K): ComponentMap[K] | undefined;
    getComponent<T = unknown>(type: string): T | undefined;
    removeComponent(type: string): void;

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
     * itself.
     *
     * Known component types (see {@link ComponentMap}) resolve to their
     * typed interface automatically, same as `getComponent`. Pass an explicit
     * `T` to override for custom/module component types not in the map.
     */
    findComponents<K extends keyof ComponentMap>(type: K): ComponentMap[K][];
    findComponents<T = unknown>(type: string): T[];
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
    /** Transitions to `stateName`, cross-fading over `fade` seconds (default 0.2). */
    play(stateName: string, fade?: number): void;
  }

  /** `entity.getComponent("mesh")`. Geometry/material are data-driven via `props` — see `static schema`. */
  export interface MeshComponent extends ComponentBase {}

  /** `entity.getComponent("camera")`. */
  export interface CameraComponent extends ComponentBase {
    camera: Camera | null;
    /** Resolves `props.followTarget` (an entity id) against the live engine. */
    resolveFollowTarget(engine: Engine): Entity | null;
    /** Rotates the entity so -Z faces the follow target, when `enabled` and a target is configured. */
    applyLookAt(enabled: boolean, engine: Engine): void;
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
    /** Instantly repositions the character (world space) and clears fall speed. */
    teleport(v: [number, number, number]): void;
  }

  /**
   * Maps every built-in registered component type string to its typed
   * interface. `getComponent`/`findComponents` key off this so
   * `entity.getComponent("charactercontroller")` resolves to
   * {@link CharacterControllerComponent} automatically, with full
   * autocomplete on its methods — no cast needed.
   *
   * Physics types (`rigidbody`, `collider`, `charactercontroller`) are only
   * actually attachable when the project has the `physics-rapier` module
   * enabled; typing them here is safe either way since `getComponent`
   * already returns `| undefined`.
   *
   * Custom components registered by other modules aren't in this map — use
   * the explicit generic form (`getComponent<MyType>("mytype")`) for those.
   */
  export interface ComponentMap {
    model: ModelComponent;
    animation: AnimationComponent;
    mesh: MeshComponent;
    camera: CameraComponent;
    light: LightComponent;
    listener: ListenerComponent;
    sound: SoundComponent;
    instancer: InstancerComponent;
    particles: ParticleComponent;
    rigidbody: RigidbodyComponent;
    collider: ColliderComponent;
    character: CharacterControllerComponent;
    script: ScriptComponent;
  }

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
    raycast(
      origin: Vector3,
      direction: Vector3,
      maxDist: number,
    ): {
      entity: Entity | null;
      point: Vector3;
      normal: Vector3;
      distance: number;
    } | null;
    setGravity(v: [number, number, number]): void;
  }

  export interface Engine {
    scene: { children: unknown[]; background: unknown; environment: unknown; fog: unknown };
    camera: Camera | null;
    renderer: unknown;
    entities: Map<string, Entity>;
    rootEntities: Entity[];
    playing: boolean;
    config: EngineConfig;
    settings: SceneSettings;
    input: InputManager;
    physics?: PhysicsHandle;
    onUpdate(fn: (dt: number) => void): Unsub;
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
  }
}