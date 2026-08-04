// Type-check fixture for the script typings. Verifies:
//   1. `extends Script` exposes `this.entity / this.engine / this.THREE / this.input`
//   2. `import * as THREE from "three/webgpu"` resolves with full types
//   3. `@attribute` accepts the documented option shape
//   4. The full lifecycle (onStart / onUpdate / onDestroy / onHotReload) type-checks
//   5. `entity.position / rotation / scale / etc` aliases work (no .object3D needed)
//   6. The InputManager types are complete and discriminate on action type
//   7. `addActionMap(def)` accepts the documented plain-object shape
//   8. The wide three + TSL surface is typed, matching what the runtime exposes
//
// Not a runtime artifact — the file's existence means any breakage surfaces
// during `npm run check:types`.
//
// This fixture is the *type* half of a pair. `scripts/run-script-runtime-smoke.mjs`
// is the runtime half, asserting the same imports actually resolve in a browser.
// Both are needed: for a long time the types described nine three classes while
// the runtime exposed twenty-eight, and neither check existed to notice.

import { Script, attribute, MeshComponent, CameraComponent, CharacterControllerComponent } from "engine";
import * as THREE from "three/webgpu";

// 1. extends Script
export default class Player extends Script {
  @attribute({ type: "number", default: 5, min: 0, max: 20, step: 0.1, label: "Speed" })
  speed = 5;

  @attribute({ type: "boolean", default: true })
  invertY = false;

  @attribute({ type: "text", default: "Player" })
  mapName = "Player";

  @attribute({ type: "select", default: "humanoid", options: ["humanoid", "vehicle"] })
  kind: "humanoid" | "vehicle" = "humanoid";

  @attribute({ type: "vec3", default: [0, 0, 0] })
  target: [number, number, number] = [0, 0, 0];

  private velocity = new this.THREE.Vector3();
  private _offMove: (() => void) | null = null;
  private _offFire: (() => void) | null = null;

  onStart() {
    // this.entity — typed as Entity with transform aliases.
    const ent = this.engine.createEntity({ name: "Bullet" });
    const meshComp = ent.getComponent<{ mesh: unknown }>("mesh");
    void meshComp;

    // Class-token lookup — preferred over strings; return type comes from ComponentMap.
    const meshByClass = this.entity.getComponent(MeshComponent);
    const ccByClass = this.entity.getComponent(CharacterControllerComponent);
    meshByClass?.setProp("geometry", "box");
    // Authored props are also direct fields (`comp.intensity`), mirrored at runtime.
    if (meshByClass) meshByClass.geometry = "sphere";
    ccByClass?.move([0, 0, 0]);
    const camsByClass = this.entity.findComponents(CameraComponent);
    void camsByClass;

    // Transform aliases — no .object3D needed.
    this.entity.position.set(0, 1, 0);
    this.entity.rotation.set(0, Math.PI, 0);
    this.entity.scale.set(2, 2, 2);
    this.entity.quaternion.identity();
    this.entity.visible = false;

    // Setting from arrays via .set() — works whether you have a tuple or
    // a Vector3 already.
    this.entity.position.set(5, 0, 0);
    this.entity.scale.set(1, 1, 1);
    // Array spread works too: this.entity.position.set(...[1, 2, 3])

    // In-place mutation through the alias.
    this.entity.position.x += 10;
    this.entity.position.y = this.target[1];

    // Forwarded Object3D methods.
    this.entity.lookAt(new this.THREE.Vector3(this.target[0], this.target[1], this.target[2]));
    const worldPos = this.entity.getWorldPosition(new this.THREE.Vector3());
    void worldPos;

    // Entity-tree walk: returns a child Entity, not an Object3D.
    // Use `getEntityByName` when the next node is itself an entity
    // (parent/child linked through the editor). Use `getObjectByName`
    // for raw three.js nodes (meshes inside a loaded GLB).
    const childEnt: import("engine").Entity | null = this.entity.getEntityByName("Child");
    const childObj: import("engine").Object3D | null = this.entity.getObjectByName("Mesh");
    void childEnt; void childObj;

    // findComponents — recursive component lookup. Returns an array (empty
    // when nothing matches), so callers can use `arr.length` instead of
    // null-checks. Generic over T for typed access by component shape —
    // cast at the call site since component classes live in modules
    // outside the engine ambient surface.
    interface CameraComponentLike {
      camera: import("engine").Object3D;
      fov: number;
    }
    const cams = this.entity.findComponents<CameraComponentLike>("camera");
    const camerasByType: CameraComponentLike[] = cams;
    void camerasByType;

    // this.input — typed as InputManager | null
    this.input?.wasPressedThisFrame("Jump");

    // MathUtils exposed via THREE
    const clamped = this.THREE.MathUtils.clamp(this.speed, 0, 100);
    void clamped;

    // 6a. Discriminated Action narrowing via getAction():
    //     type === "button" → value: boolean
    //     type === "value"  → value: number
    //     type === "vec2"   → value: THREE.Vector2 (real instance — not {x,y})
    const fire = this.input?.getAction("Fire");
    if (fire?.type === "button") {
      const held: boolean = fire.value;
      fire.value = true;
      // `space` is always "world" for buttons but the field is still there.
      const s: "world" | "camera" = fire.space;
      void s;
      void held;
    }
    const throttle = this.input?.getAction("Throttle");
    if (throttle?.type === "value") {
      const t: number = throttle.value;
      throttle.value = t * 0.5;
    }
    const move = this.input?.getAction("Move");
    if (move?.type === "vec2") {
      // `move.value` is a real THREE.Vector2 with full methods.
      const x: number = move.value.x;
      const y: number = move.value.y;
      const magnitude: number = move.value.length();
      move.value.normalize();
      // `space` tells you whether the manager already rotated this by the
      // active camera. "world" → input-space (x=strafe, y=forward); the
      // script does its own yaw. "camera" → world XZ already, write directly
      // into entity.position.
      const space: "world" | "camera" = move.space;
      this.entity.position.x += x * this.speed * 0.016;
      this.entity.position.z += y * this.speed * 0.016;
      void magnitude;
      void space;
    }

    // 6b. readValue returns the union; the discriminated narrowing above is
    //     the recommended way to use it for typed actions.
    const moveValue = this.input?.readValue("Move");
    if (typeof moveValue === "object" && moveValue !== null) {
      // moveValue is the same Vector2 instance the manager mutates each tick.
      this.entity.position.x = moveValue.x;
      moveValue.normalize();
    }

    // 6c. onAction callback receives the union value type. The runtime
    //     filters by action name so the callback is only invoked for that
    //     action — the user can narrow via instanceof / typeof if needed.
    this._offFire = this.input?.onAction("Fire", (v) => {
      // v: boolean | number | { x, y }
      if (typeof v === "boolean") console.log("fire:", v);
      else if (typeof v === "number") console.log("fire as value:", v);
    }) ?? null;

    // 6d. onRelease has no value param.
    this._offMove = this.input?.onRelease("Move", () => {
      console.log("move released");
    }) ?? null;

    // 7. addActionMap accepts the documented def shape:
    //    - binding shorthand `{ path }`
    //    - explicit binding `{ kind: "binding", path }`
    //    - explicit composite `{ kind: "composite", type: "2d", parts }`
    //    - shorthand composite (auto-detected by `type: "2d"` shape)
    this.input?.addActionMap({
      name: "Vehicle",
      schemes: ["KeyboardMouse", "Gamepad"],
      actions: [
        // value axis
        {
          name: "Steer",
          type: "value",
          bindings: [
            { path: "keyboard/keya", negate: true, scale: 1 },
            { path: "keyboard/keyd" },
            { path: "gamepad/any/leftStickX" },
          ],
        },
        // trigger
        {
          name: "Throttle",
          type: "value",
          bindings: [
            { path: "keyboard/keyw" },
            { kind: "binding", path: "gamepad/any/rightTrigger" },
          ],
        },
        // button with explicit binding
        {
          name: "Handbrake",
          type: "button",
          composite: "any",
          bindings: [
            { kind: "binding", path: "keyboard/space" },
            { path: "gamepad/any/buttonSouth" },
          ],
        },
        // vec2 composite (WASD) — shorthand composite (no `kind` needed,
        // the manager auto-detects from the `type: "2d"` shape).
        {
          name: "Move",
          type: "vec2",
          bindings: [
            {
              type: "2d",
              parts: {
                up:    { path: "keyboard/keyw" },
                down:  { path: "keyboard/keys" },
                left:  { path: "keyboard/keya" },
                right: { path: "keyboard/keyd" },
              },
            },
          ],
        },
        // camera-relative vec2: the manager rotates this by the active
        // camera's yaw each tick. Scripts read it as world XZ directly.
        {
          name: "MoveCamera",
          type: "vec2",
          space: "camera",
          bindings: [
            { path: "gamepad/any/leftStick" },
            {
              type: "2d",
              parts: {
                up:    { path: "keyboard/keyw" },
                down:  { path: "keyboard/keys" },
                left:  { path: "keyboard/keya" },
                right: { path: "keyboard/keyd" },
              },
            },
          ],
        },
      ],
    });
    this.input?.enableMap("Vehicle");
    this.input?.setActiveMap("Vehicle");
    this.input?.setScheme("Gamepad");
    const active = this.input?.detectScheme();
    // Pin a custom camera provider — useful if a script wants to feed a
    // different camera than `engine.camera` (e.g. a security-camera minimap).
    this.input?.setCameraProvider(() => this.engine.camera);
    void active;
  }

  onUpdate(dt: number) {
    // Direct transform read via the alias (same Vector3 instance as object3D.position).
    const forward = new this.THREE.Vector3(0, 0, -1).applyEuler(this.entity.rotation);
    this.entity.position.add(forward.multiplyScalar(dt * this.speed));
  }

  onDestroy() {
    // Tear down any subscriptions we set up in onStart.
    this._offMove?.();
    this._offFire?.();
    this._offMove = null;
    this._offFire = null;
  }

  onHotReload(oldInstance: Script) {
    this.velocity.copy((oldInstance as Player).velocity);
  }
}

// 2. Class without extends — `@attribute` still works (just no `this.*` typing).
export class Bare {
  @attribute({ type: "number", default: 1 })
  count = 1;

  onUpdate(_dt: number) {
    // No this.entity here — would fail if attempted.
  }
}

// 3. Top-level three import works (forwarded from "engine" via three.d.ts).
const _t0: THREE.Vector2 = new THREE.Vector2();
const _t1: THREE.Vector3 = new THREE.Vector3();
const _t2: THREE.Euler = new THREE.Euler();
const _t3: THREE.Quaternion = new THREE.Quaternion();
const _t4: THREE.Color = new THREE.Color();
void _t0; void _t1; void _t2; void _t3; void _t4;

// 4. `Vector2` is also re-exported from "engine" as a type-only handle, so
//    scripts that prefer `import type { Vector2 } from "engine"` get the same
//    shape they would from `import * as THREE from "three/webgpu"`.
import type { Vector2 as EngineVector2 } from "engine";
const _v2: EngineVector2 = new THREE.Vector2();
void _v2;

// 5. Math classes are also re-exported from "engine" as runtime values, not
//    just types. At runtime `import { Vector3 } from "engine"` returns the
//    actual three.js class constructor (see src/engine/scriptRuntime/runtime.js),
//    so `new Vector3()` gives you a real THREE.Vector3 with full methods —
//    not `undefined`. Same shape for `import * as THREE from "three/webgpu"`.
import { Vector3, Quaternion, Object3D as EngineObject3D } from "engine";
const _v3: Vector3 = new Vector3(1, 2, 3);
const _q: Quaternion = new Quaternion();
const _o3d: EngineObject3D | null = null;
void _v3; void _q; void _o3d;
// 6. The wide three surface is typed, not a nine-symbol subset. Every symbol
//    below was `undefined` at runtime AND absent from the types before the
//    script runtime switched to re-exporting three wholesale. These lines are
//    the regression guard: reintroducing an allowlist in either place breaks
//    them.
const _im = new THREE.InstancedMesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardNodeMaterial(),
  16,
);
_im.setMatrixAt(0, new THREE.Matrix4());
const _mixer = new THREE.AnimationMixer(new THREE.Object3D());
const _loader = new THREE.TextureLoader();
const _skinned = new THREE.SkinnedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicNodeMaterial());
void _im; void _mixer; void _loader; void _skinned;

// 7. TSL — the material pipeline is TSL-native, so a script driving materials
//    needs `three/tsl` to resolve to the same graph library the engine uses.
import { Fn, uniform, vec3, float } from "three/tsl";
const _speed = uniform(1.5);
const _tint = Fn(() => vec3(1, 0, 0).mul(float(0.5)));
void _speed; void _tint;

// 8. The wider math surface newly re-exported from "engine". `Spherical` /
//    `Raycaster` / `Box3` are the ones gameplay code reaches for most (orbit
//    math, picking, trigger volumes) and none of them used to exist here.
import { Spherical, Raycaster, Box3, Frustum, MathUtils, Clock } from "engine";
const _sph = new Spherical().setFromVector3(new Vector3(1, 2, 3));
const _ray = new Raycaster(new Vector3(), new Vector3(0, 0, -1));
const _box = new Box3().setFromCenterAndSize(new Vector3(), new Vector3(2, 2, 2));
const _frustum = new Frustum();
const _clamped: number = MathUtils.clamp(5, 0, 1);
const _clock = new Clock();
void _sph; void _ray; void _box; void _frustum; void _clamped; void _clock;

// 9. `this.THREE` is the whole three namespace, not a 12-entry object type.
//    (It used to declare `Object3D: unknown`.)
class UsesInjectedThree extends Script {
  onStart() {
    const mesh = new this.THREE.InstancedMesh(
      new this.THREE.SphereGeometry(1),
      new this.THREE.MeshStandardNodeMaterial(),
      4,
    );
    this.entity.object3D.add(mesh);
  }
}
void UsesInjectedThree;
