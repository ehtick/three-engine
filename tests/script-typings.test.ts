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

import {
  Script,
  attribute,
  listen,
  MeshComponent,
  CameraComponent,
  CharacterControllerComponent,
  TimelineComponent,
  AnimationComponent,
} from "engine";
import type { EventBinding, EventAction } from "engine";
import * as THREE from "three/webgpu";

// `EntityEventMap` is empty out of the box (ad-hoc, game-authored events) —
// a project registers its own the same way a module registers an
// EngineEventMap entry. This is the fixture's own registration, exercised
// in section 9 below.
declare module "engine" {
  interface EntityEventMap {
    damaged: [amount: number];
  }
}

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
  private _offPlayChanged: (() => void) | null = null;
  private _offActionPressed: (() => void) | null = null;
  private _offDamaged: (() => void) | null = null;
  private _offTimelineFinished: (() => void) | null = null;

  onStart() {
    // this.entity — typed as Entity with transform aliases.
    const ent = this.engine.createEntity({ name: "Bullet" });
    // String-token lookup resolves to the real MeshComponent shape via
    // ComponentMap — no cast needed, and an unregistered/typo'd string is a
    // compile error rather than silently returning `unknown`.
    const meshComp = ent.getComponent("mesh");
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
    // null-checks. The string-token form resolves via ComponentMap same as
    // the class-token form above — both give the real component shape.
    const cams = this.entity.findComponents("camera");
    const camerasByType: CameraComponent[] = cams;
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

    // 8. engine.on/once/off/emit — checked against EngineEventMap (name AND
    //    payload). A typo'd or made-up event name is a compile error.
    const offPlay = this.engine.on("play-changed", (playing) => {
      const p: boolean = playing;
      void p;
    });
    this._offPlayChanged = offPlay;
    this.engine.once("entity-spawned", (entity) => {
      const e: import("engine").Entity = entity;
      void e;
    });
    this.engine.emit("hierarchy-changed");
    this.engine.emit("component-changed", {
      entityId: this.entity.id,
      componentType: "mesh",
      key: "geometry",
    });

    // 8a. emitAsync/callAll/callFirst — the super-events-style additions.
    //     callAll/callFirst are generic over the listener's return type.
    void this.engine.emitAsync("play-changed", true);
    const results: boolean[] = this.engine.callAll<"play-changed", boolean>("play-changed", true);
    void results;
    void this.engine
      .callFirstAsync<"entity-spawned", boolean>("entity-spawned", this.entity)
      .then((first) => {
        const f: boolean | undefined = first;
        void f;
      });

    // 8b. engine.input is a SEPARATE TypedEmitter over InputEventMap — these
    //     event names never fire on `engine` itself (a real bug this fixed:
    //     they used to live in EngineEventMap by mistake).
    this._offActionPressed = this.input?.on("action-pressed", (name, value) => {
      const n: string = name;
      const v: number = value;
      void n; void v;
    }) ?? null;

    // 9. entity.on/off/once/emit — a SEPARATE local TypedEmitter scoped to
    //    this one entity, checked against EntityEventMap (registered above).
    //    Distinct from `dispatch(hook, ...)`, which calls a named method.
    this._offDamaged = this.entity.on("damaged", (amount) => {
      const a: number = amount;
      void a;
    });
    this.entity.emit("damaged", 10);
    void this.entity.emitAsync("damaged", 5);
    const totals: number[] = this.entity.callAll<"damaged", number>("damaged", 1);
    void totals;
    // Another entity's listeners are unaffected — a separate instance, a
    // separate TypedEmitter.
    const other = this.engine.createEntity({ name: "Other" });
    other.on("damaged", () => {});
    other.emit("damaged", 99);

    // 10. Every component gets `changed`/`destroyed` for free via
    //     ComponentEventMap, and a component with its own events (Timeline,
    //     Animation) merges them in through ComponentBase's 2nd type param.
    const timeline = this.entity.getComponent(TimelineComponent);
    this._offTimelineFinished = timeline?.on("finished", () => {}) ?? null;
    timeline?.on("looped", () => {});
    // "changed"/"destroyed" also work on a component with its own map —
    // ComponentEventMap and the component-specific map merge, not replace.
    timeline?.on("changed", (key) => {
      const k: string = key;
      void k;
    });
    timeline?.on("destroyed", () => {});

    const anim = this.entity.getComponent(AnimationComponent);
    anim?.on("state-changed", (state, previous) => {
      const s: string | null = state;
      const p: string | null = previous;
      void s; void p;
    });
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
    this._offPlayChanged?.();
    this._offActionPressed?.();
    this._offDamaged?.();
    this._offTimelineFinished?.();
    this._offPlayChanged = null;
    this._offActionPressed = null;
    this._offDamaged = null;
    this._offTimelineFinished = null;
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

// ---------------------------------------------------------------------------
// 10. The EDITOR surface. Everything below is what an in-editor tool script is
//     made of, and none of it was type-checked before: `editor.d.ts` described
//     nine namespaces while `src/editor/api/index.js` had twenty-two, so two
//     thirds of `Editor.*` was a red squiggle in the app's own code editor.
//
//     Note the split, which is the thing people get wrong: the HOOKS are on
//     `Script` (from "engine"), the DECORATORS and the API are from "editor".
//     Importing `executeInEditMode` from "engine" is a compile error here and
//     a load failure at runtime — which is the point of declaring it.
// ---------------------------------------------------------------------------

import {
  Editor,
  isEditor,
  hasEditorApi,
  executeInEditMode,
  menuItem,
  registerMenuItem,
} from "editor";
import type { Gizmos, EntityInfo, BatchStep } from "editor";

@executeInEditMode
export class SpawnVolume extends Script {
  @attribute({ type: "number", default: 4, min: 0.1 })
  radius = 4;

  // Editor-only lifecycle: ticks while STOPPED. `onUpdate` above stays play-only.
  onEditorUpdate(dt: number) {
    void dt;
  }

  // No decorator needed for gizmos — they run on any loaded script.
  onDrawGizmos(gizmos: Gizmos) {
    gizmos
      .color("#4af")
      .sphere(this.entity.position, this.radius)
      .transform(this.entity.object3D.matrixWorld)
      .arrow([0, 0, 0], [0, 2, 0])
      .capsule([0, 0, 0], 0.5, 2)
      .axes(this.entity.object3D.matrixWorld, 0.5)
      .transform(null);
    gizmos.color(1, 0.5, 0).box(this.entity.position, [2, 1, 2]);
  }

  onDrawGizmosSelected(gizmos: Gizmos) {
    gizmos.polyline([[0, 0, 0], [1, 0, 0], [1, 0, 1]], true).point([0, 0, 0], 0.2);
  }

  @menuItem("Tools/Snap To Ground")
  snapToGround() {
    // Bound to this instance, so `this.entity` is reachable from the menu.
    Editor.entities.setTransform(this.entity.id, { position: [0, 0, 0] });
  }
}

// A module-scope entry, for a tool not bound to any entity.
const disposeMenu: () => void = registerMenuItem("Tools/Rebuild", () => {}, { order: 1 });
void disposeMenu;

// Bare and called forms of the class decorator both type-check.
@executeInEditMode()
class AlsoInEditMode extends Script {}
void AlsoInEditMode;

/** Every namespace of the facade, exercised against its real signature. */
async function editorSurface() {
  // Guarding is the whole reason `Editor.*` can live in a script that ships.
  if (!isEditor() || !hasEditorApi()) return;

  const version: string = Editor.version;
  void version;
  void Editor.ops()[0]?.name;
  void Editor.tools({ readOnly: true })[0]?.inputSchema;
  void (await Editor.call("entity.list", {}));
  // Both fields must be reachable from the `else` too — see ToolCallResult's
  // note on why this is not a discriminated union under `strict: false`.
  const tool = await Editor.callTool("entity_list", {});
  if (tool.ok) void tool.result;
  else console.error(tool.error);
  void Editor.resolveToolName("entity_create");

  // entities / components / selection / history / play / scene / project
  const made: EntityInfo = Editor.entities.create({ name: "Box", components: [{ type: "mesh" }] });
  const all: EntityInfo[] = Editor.entities.all({ tag: "enemy" });
  void all;
  void Editor.entities.get(made.id).transform.position;
  void Editor.entities.live(made.id)?.position.x;
  void Editor.entities.rename(made.id, "Crate");
  void Editor.entities.reparent(made.id, null, 0);
  void Editor.entities.duplicate([made.id]);
  void Editor.entities.setTransform(made.id, { position: [1, 2, 3], rotation: [0, 0, 0] });
  void Editor.entities.setTags(made.id, ["prop"]);
  void Editor.entities.getBounds(made.id).size;
  void Editor.entities.delete(made.id).deleted;

  void Editor.components.types()[0]?.schema;
  void Editor.components.add(made.id, "mesh", { geometry: "sphere" });
  void Editor.components.setProp(made.id, "mesh", "geometry", "box");
  void Editor.components.remove(made.id, "mesh");

  const ids: string[] = Editor.selection.ids;
  void ids;
  void Editor.selection.entities[0]?.name;
  void Editor.selection.set(made.id);
  void Editor.selection.selectAssets(["a.png"]);
  void Editor.selection.clear();
  void Editor.selection.get().assetPath;

  const canUndo: boolean = Editor.history.get().canUndo;
  void canUndo;
  void Editor.history.undo();
  void Editor.history.redo();

  const playing: boolean = Editor.play.isPlaying;
  void playing;
  void (await Editor.play.start());
  void (await Editor.play.stop());

  void Editor.scene.get().entityCount;
  void (await Editor.scene.save());
  void (await Editor.scene.open("Main.scene"));
  void (await Editor.scene.getSettings());
  void (await Editor.scene.setSettings({ fog: true }, "Fog on"));

  const root: string | null = Editor.project.rootPath;
  void root;
  void Editor.project.get().meta;

  // sight
  const shot = await Editor.viewport.screenshot({ width: 800, camera: "game", overlays: false });
  const png: string = shot.__image.base64;
  void png;
  void Editor.viewport.getCamera().position;
  void Editor.viewport.setCamera([5, 5, 5], [0, 0, 0]);
  void Editor.viewport.focus(made.id, 1.5);
  void Editor.viewport.freezeWhenUnfocused(true).enabled;
  void Editor.console.read({ level: "error", limit: 10 }).entries;

  // assets / fonts / code
  void (await Editor.assets.list({ ext: "ts", depth: 2 }))[0]?.path;
  void (await Editor.assets.read("a.ts"));
  void (await Editor.assets.write("a.ts", "// hi"));
  void (await Editor.assets.createScript("Tool", "scripts"));
  void (await Editor.assets.openInIDE("a.ts"));
  void (await Editor.assets.reveal("a.ts"));
  void (await Editor.assets.rename("a.ts", "b.ts"));
  void (await Editor.assets.move(["b.ts"], "scripts"));
  void (await Editor.assets.createFolder("scripts/tools"));
  void (await Editor.assets.refresh());
  void Editor.assets.watchStatus();
  void (await Editor.assets.actions("a.png")).actions;
  void (await Editor.assets.runAction("a.png", "texture.material"));
  void (await Editor.assets.delete(["b.ts"]));

  void (await Editor.fonts.list());
  void (await Editor.fonts.search("pixel", { category: "Display", limit: 5 }));
  void (await Editor.fonts.import("Press Start 2P", ["400"])).files;
  void (await Editor.fonts.inspect("f.ttf"));

  void (await Editor.code.open("a.ts")).opened;
  void (await Editor.code.openFiles()).unsaved;

  // authoring
  void (await Editor.materials.create("Rust", { color: "#c0392b", roughness: 0.8 })).path;
  void (await Editor.materials.get("Rust.mat"));
  void (await Editor.materials.set("Rust.mat", { metalness: 1 }));
  void (await Editor.prefabs.list())[0]?.path;
  void (await Editor.prefabs.instantiate("Tree.prefab", { position: [0, 0, 0] }));
  void (await Editor.prefabs.createFrom(made.id, "prefabs"));
  void (await Editor.modules.list())[0]?.enabled;
  void (await Editor.modules.setEnabled("gi", true));

  // sound
  void (await Editor.audio.status());
  void (await Editor.audio.search("gravel footsteps", { provider: "commons", kind: "sfx", cc0Only: true }));
  void (await Editor.audio.import(1234, "freesound"));
  void (await Editor.audio.credits());
  void (await Editor.audio.info("step.wav"));
  void (await Editor.audio.tracks("step.wav"));
  void (await Editor.audio.edit("step.wav", "trimSilence", { thresholdDb: -50 }));
  void (await Editor.audio.effects());
  void (await Editor.audio.process("step.wav", "reverb", { mix: 0.3 }));
  void (await Editor.audio.generate("tone.wav", "sine", { hz: 440 }));
  void (await Editor.audio.addTrack("step.wav", "tail.wav"));
  void (await Editor.audio.setTrack("step.wav", 0, { gain: 0.5 }));
  void (await Editor.audio.removeTrack("step.wav", 1));
  void (await Editor.audio.loop("amb.wav"));
  void (await Editor.audio.variations("step.wav", { count: 4 }));
  void (await Editor.audio.export("step.wav", { format: "ogg", bitrate: 64000, estimateOnly: true }));

  // libraries
  void (await Editor.library.status());
  void (await Editor.library.search("polyhaven", "rock", { type: "texture", limit: 5 }));
  void (await Editor.library.import("polyhaven", "rock_01", { type: "texture", resolution: "2k" }));
  void (await Editor.library.setEnvironment("sky.hdr"));

  // images
  void (await Editor.textures.info("t.png"));
  void (await Editor.textures.create("textures", "Grate.png", { width: 256, background: "#202020" })).path;
  void (await Editor.textures.effects());
  void (await Editor.textures.process("t.png", "blur", { radius: 2 }));
  void (await Editor.textures.resize("t.png", 128, 128, { mode: "canvas", filter: "nearest" }));
  void (await Editor.textures.setMeta("t.png", { colorSpace: "linear", wrap: "clamp" }));
  void (await Editor.textures.addLayer("t.png", { name: "Detail", opacity: 0.5 }));
  void (await Editor.textures.setLayer("t.png", 0, { visible: false, offset: [2, 2] }));
  void (await Editor.textures.removeLayer("t.png", 1));
  void (await Editor.textures.draw("t.png", "rect", { rect: [0, 0, 16, 16], color: "#fff", fill: true }));
  void (await Editor.textures.draw("t.png", "flood", { x: 4, y: 4, tolerance: 0.2 }));
  void (await Editor.textures.generate("t.png", "noise", { scale: 8 }));
  void (await Editor.textures.atlas.pack(["a.png", "b.png"], { padding: 4, powerOfTwo: true }));
  void (await Editor.textures.atlas.get("s.atlas"));
  void (await Editor.textures.atlas.set("s.atlas", { pivot: [0.5, 0.5] }));
  void (await Editor.textures.atlas.export("s.atlas", "out"));

  // geometry (Edit Mode)
  void (await Editor.geometry.begin(made.id));
  void (await Editor.geometry.status());
  void (await Editor.geometry.select("box", { mode: "face", min: [-1, -1, -1], max: [1, 1, 1] }));
  void (await Editor.geometry.select("trait", { trait: "boundary", add: true }));
  void (await Editor.geometry.operations());
  void (await Editor.geometry.edit("extrude", { distance: 0.5 }));
  void (await Editor.geometry.transform({ translate: [0, 1, 0], rotate: [0, 45, 0] }));
  void (await Editor.geometry.addPrimitive("uvsphere", { at: [0, 2, 0], options: { radius: 0.5 } }));
  void (await Editor.geometry.remesh({ voxelSize: 0.05, adaptivity: 0 }));
  void (await Editor.geometry.commit(true));
  void (await Editor.geometry.cancel());

  // pipeline / build / git
  void (await Editor.pipeline.compress("m.glb", "draco"));
  void (await Editor.pipeline.compressAllTextures());
  void (await Editor.pipeline.bakeNavMesh({ id: made.id }));
  void (await Editor.pipeline.createTerrain({ size: 100, resolution: 256 }));

  const repo = await Editor.git.status();
  if (repo.isRepo) {
    void (await Editor.git.stage());
    void (await Editor.git.commit("wip", { all: true }));
    void (await Editor.git.log({ limit: 5 }));
    void (await Editor.git.branches());
    void (await Editor.git.checkout("main", { create: false }));
    void (await Editor.git.push({ setUpstream: true }));
    void (await Editor.git.github.status());
  }

  void (await Editor.build.get());
  void (await Editor.build.set({ target: "web" }));
  void (await Editor.build.export("zip"));
  void (await Editor.build.preview(true));
  void (await Editor.build.serve());
  void (await Editor.build.serve(true));

  // batch — many ops, one undo step; "$0" is step 0's returned id.
  const steps: BatchStep[] = [
    { op: "entity.create", args: { name: "Parent" } },
    { op: "entity.create", args: { name: "Child", parentId: "$0" } },
  ];
  void (await Editor.batch("Build rig", steps));

  // chrome
  const off: () => void = Editor.menu.add("Tools/Thing", () => {});
  off();
  void Editor.menu.list();
  void Editor.menu.subscribe(() => {});
  Editor.log("done");
}
void editorSurface;

// ---------------------------------------------------------------------------
// 10. Events: `@listen` and `waitFor`.
//
// The catalog's whole payoff is that a project's own event names are checked at
// both ends. Here the fixture registers two the way the generated
// `project-events.d.ts` does, then uses them — so a regression in the decorator
// overloads or the emitter generics fails `npm run check:types` rather than
// showing up as autocomplete that quietly knows less.
// ---------------------------------------------------------------------------
declare module "engine" {
  interface EngineEventMap {
    "score-changed": [total: number];
  }
  interface EntityEventMap {
    healed: [amount: number];
  }
}

class EventScript extends Script {
  // Payload types flow from the map into the handler's parameters.
  @listen("score-changed")
  onScore(total: number) {
    void total.toFixed(0);
  }

  // A per-entity event, on the entity's own bus.
  @listen("healed", { on: "entity" })
  onHealed(amount: number) {
    void amount;
  }

  // Input action names are open strings — the same accepted gap
  // `input.onAction` already carries.
  @listen("Jump", { on: "input" })
  onJump() {}

  async onStart() {
    // Always an array, even for a one-argument event; null only when a timeout
    // was asked for and elapsed.
    const scored = await this.engine.waitFor("score-changed");
    if (scored) {
      const [total] = scored;
      void total.toFixed(0);
    }
    const timed = await this.engine.waitFor("play-changed", { timeout: 2 });
    void timed;
    void (await this.entity.waitFor("healed"));

    // The catalog handle.
    void this.engine.events.has("score-changed");
    void this.engine.events.list().map((d) => d.name);
    void this.engine.listenerCount("score-changed");

    // Wiring read from a script, typed.
    const wired = this.entity.getComponent("events");
    if (wired) {
      const rows: EventBinding[] = wired.bindings;
      void rows.map((row) => row.when.source);
    }
    const button = this.entity.getComponent("uibutton");
    if (button) {
      const responses: EventAction[] = button.onClick;
      void responses.map((r) => r.type);
    }
  }
}
void EventScript;
