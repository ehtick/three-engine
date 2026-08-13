/**
 * Runtime module exposed to user scripts as `import ... from "engine"`.
 *
 * Three kinds of exports live here:
 *   1. Engine-specific surface — `Script` (base class) and the `attribute`
 *      decorator. `ScriptComponent` injects `entity` / `engine` / `THREE` /
 *      `input` on every script instance regardless of base class, so
 *      `extends Script` is a typed no-op.
 *   2. three's math and value types, re-exported. These are not wrappers —
 *      `Vector3` here IS three's `Vector3`, the same constructor the engine
 *      itself uses, so vectors cross the script boundary without conversion
 *      and `instanceof` works.
 *   3. Component classes — the same constructors the engine registers — so
 *      scripts can write `entity.getComponent(MeshComponent)` without
 *      stringly-typed keys.
 *
 * ## What belongs here vs. in `"three"`
 *
 * `"engine"` is the authored surface: the vocabulary you need to write game
 * logic against entities and components. That includes math (you cannot write
 * a single line of gameplay without vectors) but deliberately NOT the three
 * scene graph — `Mesh`, `InstancedMesh`, materials, geometries, loaders.
 * Entities own the scene graph, and reaching for those types means you want
 * the escape hatch, which is a first-class option:
 *
 *     import * as THREE from "three";        // the whole real three
 *     import { Fn, uniform } from "three/tsl";
 *
 * Both resolve to the exact module instances the engine is built against —
 * see `threeRuntime.js` / `tslRuntime.js`. Nothing is hidden or shimmed, so
 * the full three ecosystem stays reachable from a script.
 *
 * This module used to read its three classes off `globalThis.__ENGINE_THREE__`
 * because it shipped as a `data:` URL with no module-resolution base. It is
 * now a real chunk that imports three directly, so that global handshake —
 * and the boot-ordering failure it created ("the engine must finish booting
 * before user scripts run") — is gone.
 */
export {
  // Vectors / rotation / matrices — the core of any gameplay math.
  Vector2,
  Vector3,
  Vector4,
  Quaternion,
  Euler,
  Matrix3,
  Matrix4,
  // Color, so scripts can drive material and light colours.
  Color,
  // Volumes and intersection primitives — triggers, spatial queries, culling.
  Box2,
  Box3,
  Sphere,
  Plane,
  Ray,
  Raycaster,
  Frustum,
  Line3,
  Triangle,
  // Alternate coordinate systems, handy for orbital / turret math.
  Spherical,
  Cylindrical,
  // Scalar helpers: clamp / lerp / degToRad / randFloat / smoothstep / …
  MathUtils,
  // Timing and layer masks.
  Clock,
  Layers,
  // Kept from the previous surface so existing scripts keep resolving. Prefer
  // `Entity`'s transform accessors over touching `Object3D` directly, and the
  // camera component over the raw camera.
  Object3D,
  Camera,
} from "three/webgpu";

/**
 * `engine.math` — gameplay math, the layer above three's types: angle blending
 * that takes the short way round, frame-rate-independent smoothing, seeded
 * randomness, noise, ray tests on plain `{x, y, z}` shapes, and aiming
 * solvers.
 *
 * The same object the engine itself uses, so a value computed in a script and
 * one computed in a component are computed by the same code. Also reachable as
 * `this.math` and `this.engine.math` without importing anything.
 *
 * Only the namespace is exported, not its members: `clamp`, `lerp` and `step`
 * are words a game's own module is entitled to use.
 */
export { math } from "../math/index.js";

/**
 * Component classes for typed lookup. Same constructors the engine registers.
 * Physics / navigation are included even when those modules are disabled —
 * the class is only a type token; attaching still needs the module enabled.
 *
 * Keep in sync with `ComponentMap` and the `ComponentClass<"…">` consts in
 * `script-types/engine.d.ts`.
 *
 *     import { Script, MeshComponent } from "engine";
 *     const mesh = this.entity.getComponent(MeshComponent);
 */
export { MeshComponent } from "../components/MeshComponent.js";
export { ModelComponent } from "../components/ModelComponent.js";
export { AnimationComponent } from "../components/AnimationComponent.js";
export { TimelineComponent } from "../components/TimelineComponent.js";
export { IKComponent } from "../components/IKComponent.js";
export { CameraComponent } from "../components/CameraComponent.js";
export { VirtualCameraComponent } from "../components/VirtualCameraComponent.js";
export { ImpulseSourceComponent } from "../components/ImpulseSourceComponent.js";
export { LightComponent } from "../components/LightComponent.js";
export { ListenerComponent } from "../components/ListenerComponent.js";
export { SoundComponent } from "../components/SoundComponent.js";
export { InstancerComponent } from "../components/InstancerComponent.js";
export { ParticleComponent } from "../components/ParticleComponent.js";
export { LineRendererComponent } from "../components/LineRendererComponent.js";
export { TrailRendererComponent } from "../components/TrailRendererComponent.js";
export { DecalComponent } from "../components/DecalComponent.js";
export { BoneComponent } from "../components/BoneComponent.js";
export { SkinnedMeshComponent } from "../components/SkinnedMeshComponent.js";
export { PlanarReflectionComponent } from "../components/PlanarReflectionComponent.js";
export { LodGroupComponent } from "../components/LodGroupComponent.js";
export { PoolComponent } from "../components/PoolComponent.js";
export { ImpostorComponent } from "../components/ImpostorComponent.js";
export { GeometryModifiersComponent } from "../components/GeometryModifiersComponent.js";
export { SplineComponent } from "../components/SplineComponent.js";
export { SplineFollowerComponent } from "../components/SplineFollowerComponent.js";
export { SplineMeshComponent } from "../components/SplineMeshComponent.js";
export { UiScreenComponent } from "../components/ui/UiScreenComponent.js";
export { UiElementComponent } from "../components/ui/UiElementComponent.js";
export { UiImageComponent } from "../components/ui/UiImageComponent.js";
export { UiTextComponent } from "../components/ui/UiTextComponent.js";
export { UiButtonComponent } from "../components/ui/UiButtonComponent.js";
export { UiLayoutComponent } from "../components/ui/UiLayoutComponent.js";
export { UiScrollComponent } from "../components/ui/UiScrollComponent.js";
export { UiMaskComponent } from "../components/ui/UiMaskComponent.js";
export { ScriptComponent } from "../components/ScriptComponent.js";

export { RigidbodyComponent } from "../../modules/physics-rapier/RigidbodyComponent.js";
export { ColliderComponent } from "../../modules/physics-rapier/ColliderComponent.js";
export { CharacterControllerComponent } from "../../modules/physics-rapier/CharacterControllerComponent.js";
export { JointComponent } from "../../modules/physics-rapier/JointComponent.js";

export { NavMeshComponent } from "../../modules/navigation/NavMeshComponent.js";
export { NavAgentComponent } from "../../modules/navigation/NavAgentComponent.js";
export { NavLinkComponent } from "../../modules/navigation/NavLinkComponent.js";

export { TerrainComponent } from "../../modules/terrain/TerrainComponent.js";
export { PostprocessComponent } from "../../modules/postprocessing/PostprocessComponent.js";
export { EnvironmentComponent } from "../../modules/polyhaven/EnvironmentComponent.js";
export { ObjModelComponent } from "../../modules/ambientcg/ObjModelComponent.js";
export { GlobalIlluminationComponent } from "../../modules/gi/GlobalIlluminationComponent.js";

/**
 * Base class scripts extend for full IntelliSense on `this.entity`,
 * `this.engine`, `this.THREE`, `this.input`, plus the lifecycle methods.
 *
 * The runtime DOES NOT require extending this class — `ScriptComponent`
 * injects the context properties on every script instance regardless of its
 * base class. This class exists purely as a type-system helper.
 */
export class Script {}

/**
 * Class-field decorator that registers the field in the class's static
 * `attributes` map. The editor reads that map to render Inspector fields
 * and `ScriptComponent` applies saved values on start.
 */
export function attribute(options = {}) {
  return function (target, key) {
    const ctor = target.constructor ?? target;
    if (!Object.prototype.hasOwnProperty.call(ctor, "attributes")) {
      ctor.attributes = { ...ctor.attributes };
    }
    ctor.attributes[key] = options;
  };
}

/**
 * `@autobind` — bind a script's methods to their instance once, at the class,
 * instead of writing `.bind(this)` at every call site. Usable on the whole
 * class or on a single method; see `autobind.js` for the mechanism.
 *
 *     @autobind
 *     export default class FpsCounter extends Script {
 *       onStart() { this.engine.time.every(0.25, this.updateFps); }
 *       updateFps() { this.text.text = `FPS: ${this.engine.stats.fps}`; }
 *     }
 */
export { autobind } from "./autobind.js";

/**
 * `@listen` — a method that subscribes itself for as long as the script runs.
 *
 *     export default class Hud extends Script {
 *       @listen("score-changed")
 *       onScore(total) { this.text.text = `${total}`; }
 *     }
 *
 * No `onStart` subscribe, no `onDestroy` unsubscribe, and therefore no way to
 * forget the second one — which is the leak Unity's `OnEnable`/`OnDisable`
 * pairing and Godot's `connect`/`disconnect` both leave to the author. Names
 * are checked against the project's event catalog, so a typo is a compile
 * error rather than a handler that never fires. See `listen.js`.
 */
export { listen } from "./listen.js";

/** This module's own absolute URL — see `threeRuntime.js` for why. */
export const __SELF_URL__ = import.meta.url;
