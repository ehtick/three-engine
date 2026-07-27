/**
 * Runtime module exposed to user scripts as `import ... from "engine"`.
 *
 * Two kinds of exports live here:
 *   1. Engine-specific surface — `Script` (base class) and the `attribute`
 *      decorator. `ScriptComponent` injects `entity` / `engine` / `THREE` /
 *      `input` on every script instance regardless of base class, so
 *      `extends Script` is a typed no-op.
 *   2. three's math and value types, re-exported. These are not wrappers —
 *      `Vector3` here IS three's `Vector3`, the same constructor the engine
 *      itself uses, so vectors cross the script boundary without conversion
 *      and `instanceof` works.
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

/** This module's own absolute URL — see `threeRuntime.js` for why. */
export const __SELF_URL__ = import.meta.url;
