// NOTE: strict type-checking intentionally not enabled here — ~22 pre-existing
// errors unrelated to events (the device union type doesn't narrow per-device,
// e.g. `.id`/`.buttons` on KeyboardDevice|MouseDevice|...), a follow-up. Fixed the
// one real bug it caught along the way: a duplicate `getMap` implementation.
import { EventEmitter } from "../EventEmitter.js";
import { ActionMap } from "./ActionMap.js";
import { KeyboardDevice } from "./devices/KeyboardDevice.js";
import { MouseDevice } from "./devices/MouseDevice.js";
import { GamepadDevice } from "./devices/GamepadDevice.js";
import { TouchDevice } from "./devices/TouchDevice.js";
import { VirtualJoysticks } from "./VirtualJoysticks.js";

// Reusable scratch for camera-space conversion. We don't import THREE here
// (the manager stays three-agnostic), but `getWorldDirection(target)`
// chains `target.set(x, y, z).normalize().negate()` (PerspectiveCamera
// also calls .negate() on top of Object3D's implementation) — it writes
// the result via the vector protocol, not by mutating `.x`/`.y`/`.z`
// directly — so we need a Vector3-shaped object with `.set`, `.normalize`,
// and `.negate`.
const _scratchDir = {
  x: 0, y: 0, z: 0,
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; },
  normalize() {
    const l = Math.hypot(this.x, this.y, this.z) || 1;
    this.x /= l; this.y /= l; this.z /= l;
    return this;
  },
  negate() { this.x = -this.x; this.y = -this.y; this.z = -this.z; return this; },
};

/**
 * Unity Input System-style manager. Owns:
 *   - the device set (keyboard, mouse, up to 4 gamepads, touch, virtual joysticks),
 *   - the action map stack (UI overlays push on top of Gameplay),
 *   - per-frame polling, action resolution, edge tracking,
 *   - a script-facing API for queries + events.
 */
export class InputManager extends EventEmitter {
  constructor({
    canvas = null,
    virtualJoysticks = "auto",
    virtualJoystickTheme = "dark",
    maxGamepads = 4,
    schemes = ["KeyboardMouse", "Gamepad", "Touch"],
    /**
     * Constructor for the live value of vec2 actions. The engine passes
     * `THREE.Vector2` so scripts can call `.length()`, `.normalize()`, etc.
     * directly on `input.readValue("Move")`. When omitted, the manager falls
     * back to a plain `{ x, y }` object — fine for tests and for projects that
     * don't import three.
     */
    Vector2 = null,
    /**
     * Called each tick to resolve the camera used for vec2 actions whose
     * `space` is `"camera"`. The engine passes `() => engine.camera`. The
     * callback may return `null` (no camera in the scene yet) — the manager
     * falls back to input-space values for that tick. Used so the manager
     * itself stays three-agnostic and can be unit-tested without a renderer.
     */
    cameraProvider = null,
  } = {}) {
    super();
    this.canvas = canvas;
    this.attached = false;
    this.maxGamepads = maxGamepads;
    this.schemes = schemes;
    this.Vector2 = Vector2;
    this.cameraProvider = cameraProvider;

    this.keyboard = new KeyboardDevice();
    this.mouse = new MouseDevice();
    this.gamepads = Array.from({ length: maxGamepads }, (_, i) => new GamepadDevice(i));
    this.touch = new TouchDevice();

    const vjEnabled = virtualJoysticks === true ? true : virtualJoysticks === false ? false : null;
    this.virtualJoysticks = new VirtualJoysticks({
      parent: canvas?.parentElement ?? document.body,
      enabled: vjEnabled,
      theme: virtualJoystickTheme,
    });
    this.virtualJoysticksVisible = vjEnabled === true;

    this.devices = [this.keyboard, this.mouse, ...this.gamepads, this.touch, this.virtualJoysticks];

    this.maps = new Map();
    this.stack = [];

    this.activeScheme = "KeyboardMouse";
    this.lastSchemeChangeAt = 0;

    this._unsubTick = null;

    this._lastAnyGamepadInputAt = 0;
    this._lastKeyboardMouseInputAt = 0;
    this._lastTouchInputAt = 0;
  }

  attach(canvas = null) {
    if (this.attached) return;
    if (canvas) this.canvas = canvas;
    const target = this.canvas ?? window;
    this.keyboard.attach(target);
    this.mouse.attach(this.canvas ?? target);
    for (const g of this.gamepads) g.attach();
    this.touch.attach(target);
    if (document.body) {
      this.virtualJoysticks.attach();
      this.virtualJoysticksVisible = this.virtualJoysticks.isVisible();
    } else {
      const onReady = () => {
        this.virtualJoysticks.attach();
        this.virtualJoysticksVisible = this.virtualJoysticks.isVisible();
        document.removeEventListener("DOMContentLoaded", onReady);
      };
      document.addEventListener("DOMContentLoaded", onReady);
    }
    this.attached = true;
  }

  detach() {
    if (!this.attached) return;
    this.keyboard.detach();
    this.mouse.detach();
    for (const g of this.gamepads) g.detach();
    this.touch.detach();
    this.virtualJoysticks.detach();
    this._unsubTick?.();
    this._unsubTick = null;
    this.attached = false;
  }

  bindUpdate(onUpdate) {
    this._unsubTick?.();
    this._unsubTick = onUpdate((dt) => this.tick(dt));
  }

  /**
   * Replaces the camera provider. Called by the Engine whenever the active
   * scene's camera changes (e.g. switching between two CameraComponents), or
   * once at startup with `() => engine.camera`. The provider is invoked each
   * tick for any vec2 action whose `space` is `"camera"` — passing a fresh
   * closure lets the Engine swap the camera without the manager holding a
   * stale reference.
   */
  setCameraProvider(fn) {
    this.cameraProvider = fn;
  }

  // ---- Map management ----

  addActionMap(def) {
    const map = def instanceof ActionMap ? def : ActionMap.fromJSON(def);
    if (this.maps.has(map.name)) {
      console.warn(`Input: action map "${map.name}" already exists`);
      return this.maps.get(map.name);
    }
    this.maps.set(map.name, map);
    this.emit("map-added", map);
    return map;
  }

  removeActionMap(name) {
    const map = this.maps.get(name);
    if (!map) return;
    this.stack = this.stack.filter((n) => n !== name);
    this.maps.delete(name);
    for (const action of map.actions.values()) action.reset();
    this.emit("map-removed", name);
  }

  enableMap(name) {
    if (!this.maps.has(name)) throw new Error(`Input: unknown map "${name}"`);
    if (!this.stack.includes(name)) {
      this.stack.push(name);
      this.emit("stack-changed", [...this.stack]);
    }
  }

  disableMap(name) {
    const i = this.stack.indexOf(name);
    if (i === -1) return;
    this.stack.splice(i, 1);
    for (const action of this.maps.get(name).actions.values()) action.reset();
    this.emit("stack-changed", [...this.stack]);
  }

  setActiveMap(name) {
    for (const n of [...this.stack]) this.disableMap(n);
    this.enableMap(name);
  }

  isMapActive(name) {
    return this.stack.includes(name);
  }

  // Looks up a live action map by name. Returns null if the map isn't loaded.
  getMap(name) {
    return this.maps.get(name) ?? null;
  }

  // ---- Schemes ----

  detectScheme() {
    const now = performance.now();
    const ages = {
      KeyboardMouse: now - this._lastKeyboardMouseInputAt,
      Gamepad: now - this._lastAnyGamepadInputAt,
      Touch: now - this._lastTouchInputAt,
    };
    let best = this.activeScheme;
    let bestAge = Infinity;
    for (const scheme of this.schemes) {
      const age = ages[scheme] ?? Infinity;
      if (age < bestAge) {
        best = scheme;
        bestAge = age;
      }
    }
    if (best !== this.activeScheme) {
      this.activeScheme = best;
      this.lastSchemeChangeAt = now;
      this.emit("scheme-changed", best);
    }
    return best;
  }

  setScheme(scheme) {
    if (!this.schemes.includes(scheme)) return;
    if (this.activeScheme === scheme) return;
    this.activeScheme = scheme;
    this.lastSchemeChangeAt = performance.now();
    this.emit("scheme-changed", scheme);
  }

  // ---- Tick ----

  tick(dt) {
    if (!this.attached) return;

    for (const g of this.gamepads) g.poll();

    if (this.#anyKeyDown()) {
      this._lastKeyboardMouseInputAt = performance.now();
      this.virtualJoysticks._hardwareInput?.();
    }
    if (this.#anyMouseDown()) {
      this._lastKeyboardMouseInputAt = performance.now();
      this.virtualJoysticks._hardwareInput?.();
    }
    if (this.gamepads.some((g) => g.connected && g.buttons.size > 0)) {
      this._lastAnyGamepadInputAt = performance.now();
    }
    if (this.touch.touches.length > 0) this._lastTouchInputAt = performance.now();
    this.detectScheme();
    this.virtualJoysticks.tick(dt);

    const seen = new Set();
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const map = this.maps.get(this.stack[i]);
      if (!map) continue;
      if (map.schemes && !map.schemes.includes(this.activeScheme)) continue;
      for (const action of map.actions.values()) {
        if (seen.has(action.name)) continue;
        seen.add(action.name);
        this.#resolveAction(action);
      }
    }

    for (const mapName of this.stack) {
      const map = this.maps.get(mapName);
      if (!map) continue;
      for (const action of map.actions.values()) {
        if (action.pressedThisFrame) this.emit("action-pressed", action.name, action.value);
        if (action.releasedThisFrame) this.emit("action-released", action.name);
      }
    }

    this.mouse.consumeFrame();
  }

  #anyKeyDown() {
    for (const v of this.keyboard.state.values()) if (v) return true;
    return false;
  }

  #anyMouseDown() {
    for (const v of this.mouse.buttons.values()) if (v) return true;
    return false;
  }

  #resolveAction(action) {
    // `before` is the input-space value (x = strafe-right, y = forward, in the
    // [-1..1] unit square). For vec2 actions with `space === "camera"`, we
    // additionally rotate by the active camera's yaw so the consumer can
    // write it straight into world-space position. `wasDown`/`newDown` are
    // computed from the input-space value so a tap on W is still "pressed"
    // even if the camera isn't available that frame.
    let before = this.#readActionValue(action);
    const wasDown = !!action.wasDown;
    const newDown = computeDown(action, before);

    if (action.type === "vec2" && action.space === "camera") {
      const cam = this.cameraProvider?.();
      const transformed = this.#toCameraSpace(before, cam);
      if (transformed) before = transformed;
      // else: no camera this tick — fall through with the input-space value
      // (better than freezing at zero — the script can still see the raw
      // input and decide what to do).
    }

    if (action.type === "vec2") {
      if (this.Vector2) {
        if (!(action.value instanceof this.Vector2)) {
          action.value = new this.Vector2(before.x, before.y);
        } else {
          action.value.set(before.x, before.y);
        }
      } else {
        action.value = { x: before.x, y: before.y };
      }
    } else {
      action.value = before;
    }
    action.wasDown = !!newDown;
    action.pressedThisFrame = newDown && !wasDown;
    action.releasedThisFrame = !newDown && wasDown;
  }

  /**
   * Rotates the input-space (x = strafe-right, y = forward) vec2 by the
   * active camera's yaw and returns a world-space { x, z } pair on the
   * ground plane. Returns null if no camera or the camera is looking
   * straight up/down (degenerate — the caller should fall back to
   * input-space so the script at least sees the raw input).
   *
   * Convention: world "forward" for a camera looking down -Z is (0, 0, -1).
   * "forward" in input space is +y. So `world = forward * y + right * x`,
   * where `right` is the CAMERA's screen-right vector (the way the
   * player is facing when they press D). That keeps A/D/W/S intuitive:
   *   D → screen-right
   *   A → screen-left
   *   W → screen-up (away from camera)
   *   S → screen-down (toward camera)
   * regardless of how the camera is rotated or where the character is
   * facing in the world.
   *
   * Note: this is the camera-relative "right", NOT the player's body-
   * right. The two differ when the player is rotated independently of
   * the camera (e.g. a third-person character with `transform` not
   * aligned to camera). For "control the body", pair this with a script
   * that snaps the body to the camera's yaw each frame.
   *
   * We project onto the XZ plane (Y = 0) because camera-relative movement
   * is grounded — the input doesn't have a "fly up" axis, and a vertical
   * camera would otherwise blow up the cross product.
   */
  #toCameraSpace(v, cam) {
    if (!cam) return null;
    // getWorldDirection accounts for parent transforms and the camera's own
    // quaternion. Returns the camera's forward vector (the way it looks).
    let fx, fy, fz;
    if (typeof cam.getWorldDirection === "function") {
      cam.getWorldDirection(_scratchDir);
      fx = _scratchDir.x; fy = _scratchDir.y; fz = _scratchDir.z;
    } else if (cam.quaternion) {
      // Fallback for tests / mocks without getWorldDirection. Apply the
      // camera's quaternion to a (0, 0, -1) forward — same as three's
      // internal default. We only need the x/z components, so a full
      // quaternion multiply is overkill; just extract the rotation of -Z
      // under the camera's basis.
      const q = cam.quaternion;
      // Forward = rotate (0, 0, -1) by quaternion (x, y, z, w):
      //   fx = 2 * (x*z - w*y)
      //   fy = 2 * (y*z + w*x)
      //   fz = 1 - 2 * (x*x + y*y)
      fx = -2 * (q.x * q.z - q.w * q.y);
      fy = -2 * (q.y * q.z + q.w * q.x);
      fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
    } else {
      return null;
    }
    // Project to the ground plane (Y = 0). Camera-relative movement is
    // grounded; the input doesn't have a "fly up" axis, and a vertical
    // camera would otherwise blow up the cross product.
    fy = 0;
    const lenSq = fx * fx + fz * fz;
    if (lenSq < 1e-6) return null; // looking straight up/down
    const inv = 1 / Math.sqrt(lenSq);
    fx *= inv;
    fz *= inv;
    // Camera screen-right = forward × worldUp. In right-handed Y-up:
    //   (fx, 0, fz) × (0, 1, 0) = (-fz, 0, fx)
    // Sanity check with camera looking down -Z (fx=0, fz=-1):
    //   right = (1, 0, 0) ✓ — D moves the character to the screen-right.
    // The alternative `up × forward` gives the player's body-right,
    // which is the OPPOSITE direction for any camera behind the player
    // (camera and player face the same way but the camera is on the
    // player's back, so the player's right is the camera's left). The
    // script's job to follow the camera is to rotate the body so the
    // two agree.
    const rx = -fz;
    const rz = fx;
    // We pack the world-space XZ pair into the vec2's (x, y) slots so the
    // Vector2 contract stays intact. Scripts consume it the same way they
    // already consume world-space input: `move.x` = world X, `move.y` =
    // world Z. The "y is forward" input-space convention collapses into
    // "y is depth" world-space here.
    return { x: rx * v.x + fx * v.y, y: rz * v.x + fz * v.y };
  }

  /** Combined value of an action across all of its bindings. */
  #readActionValue(action) {
    if (action.type === "button") {
      for (const b of action.bindings) {
        if (b.kind === "composite") continue;
        if (this.#bindingIsPressedNow(b)) return true;
      }
      return false;
    }
    if (action.type === "value") {
      let best = 0;
      for (const b of action.bindings) {
        if (b.kind === "composite") continue;
        const v = this.#readBinding(b);
        if (Math.abs(v) > Math.abs(best)) best = v;
      }
      return best;
    }
    let x = 0, y = 0;
    for (const b of action.bindings) {
      if (b.kind === "composite") {
        if (b.type === "2d") {
          x += this.#readCompositePart(b.parts.right, "x+") - this.#readCompositePart(b.parts.left, "x-");
          y += this.#readCompositePart(b.parts.up, "y+") - this.#readCompositePart(b.parts.down, "y-");
        }
      } else {
        const v = this.#readBinding(b);
        if (typeof v === "object" && v !== null) {
          x += v.x; y += v.y;
        }
      }
    }
    const m = Math.hypot(x, y);
    if (m > 1) { x /= m; y /= m; }
    return { x, y };
  }

  /** Reads the (modifier-applied) value of a single binding. */
  #readBinding(binding) {
    const [family, slot, control] = binding.path.split("/");
    for (const device of this.devices) {
      if (family === "keyboard" && device.id === "keyboard") {
        return applyScalarModifiers(device.readValue(binding.path), binding);
      }
      if (family === "mouse" && device.id === "mouse") {
        return applyScalarModifiers(device.readValue(binding.path), binding);
      }
      if (family === "touch" && device.id === "touch") {
        return applyScalarModifiers(device.readValue(binding.path), binding);
      }
      if (family === "virtualjoystick" && device.id === "virtualjoysticks") {
        return applyScalarModifiers(device.readValue(binding.path), binding);
      }
      if (family === "gamepad") {
        if (slot === "any") {
          for (const g of this.devices) {
            if (g.id?.startsWith("gamepad/") && g.connected && g.buttons.size + g.axes.size > 0) {
              const v = g.readValue(`gamepad/${g.index}/${control}`);
              const nonZero = (typeof v === "number" && v !== 0) || (typeof v === "object" && (v.x !== 0 || v.y !== 0));
              if (nonZero) return applyScalarModifiers(v, binding);
            }
          }
        } else if (device.id === `gamepad/${slot}`) {
          return applyScalarModifiers(device.readValue(binding.path), binding);
        }
      }
    }
    return 0;
  }

  // Composite parts are magnitudes — the slot name (up/down/left/right) IS the
  // direction, and the composite formula (`x += right - left`) handles the
  // sign. The binding's `negate` flag is irrelevant here: if it were honored,
  // pressing A (left part with negate:true) would return -1, then `right - left`
  // becomes `0 - (-1) = +1`, so D and A both produced +x. We strip the sign.
  #readCompositePart(b, sign) {
    if (!b) return 0;
    const v = this.#readBinding(b);
    if (typeof v === "number") return Math.abs(v);
    if (sign === "x+" || sign === "x-") return Math.abs(v.x ?? 0);
    if (sign === "y+" || sign === "y-") return Math.abs(v.y ?? 0);
    return 0;
  }

  #bindingIsPressedNow(b) {
    const v = this.#readBinding(b);
    if (typeof v === "number") return v > 0.5;
    if (typeof v === "object" && v !== null) return Math.hypot(v.x ?? 0, v.y ?? 0) > 0.5;
    return false;
  }

  // ---- Script-facing API ----

  isPressed(actionName) {
    const a = this.#findAction(actionName);
    return a ? !!a.wasDown : false;
  }

  wasPressedThisFrame(actionName) {
    const a = this.#findAction(actionName);
    return !!a?.pressedThisFrame;
  }

  wasReleasedThisFrame(actionName) {
    const a = this.#findAction(actionName);
    return !!a?.releasedThisFrame;
  }

  // Looks up a live action by name. The returned action is the same instance
  // the manager updates each tick, so `getAction("Move")?.value` is a properly
  // typed `THREE.Vector2` for vec2 actions, a `boolean` for buttons, and a
  // `number` for value actions — TypeScript narrows on the `.type` field.
  getAction(name) {
    return this.#findAction(name);
  }

  // Returns the live value the manager resolved this tick. For vec2 actions
  // this is a real `THREE.Vector2` (mutated in place each tick); clone it if
  // you need a snapshot. Returns 0 when the action isn't found.
  readValue(actionName) {
    const a = this.#findAction(actionName);
    if (!a) return 0;
    return a.value ?? 0;
  }

  onAction(name, cb) {
    return this.on("action-pressed", (n, v) => {
      if (n === name) cb(v);
    });
  }

  onRelease(name, cb) {
    return this.on("action-released", (n) => {
      if (n === name) cb();
    });
  }

  #findAction(name) {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const map = this.maps.get(this.stack[i]);
      if (!map) continue;
      const a = map.find(name);
      if (a) return a;
    }
    return null;
  }

  // ---- Persistence ----

  toJSON() {
    return {
      version: 1,
      schemes: this.schemes,
      activeScheme: this.activeScheme,
      stack: [...this.stack],
      virtualJoysticks: this.virtualJoysticks.enabled,
      virtualJoystickTheme: this.virtualJoysticks.theme,
      maps: [...this.maps.values()].map((m) => m.toJSON()),
    };
  }

  // Round-trip rebuild from a saved snapshot. Pass the Vector2 factory your
  // runtime uses (typically `THREE.Vector2`) so vec2 actions come back as
  // real Vector2 instances instead of plain `{ x, y }` objects. Pass
  // `cameraProvider` if the manager should rotate vec2 actions whose
  // `space === "camera"` against the active scene camera.
  static fromJSON(o, { Vector2 = null, cameraProvider = null } = {}) {
    const inst = new InputManager({
      virtualJoysticks: o.virtualJoysticks ?? "auto",
      virtualJoystickTheme: o.virtualJoystickTheme ?? "dark",
      schemes: o.schemes ?? ["KeyboardMouse", "Gamepad", "Touch"],
      Vector2,
      cameraProvider,
    });
    inst.activeScheme = o.activeScheme ?? "KeyboardMouse";
    for (const m of o.maps ?? []) inst.addActionMap(m);
    inst.stack = [...(o.stack ?? [])];
    return inst;
  }

  reset() {
    for (const map of this.maps.values()) {
      for (const a of map.actions.values()) a.reset();
    }
    this.keyboard.reset();
    this.mouse.reset();
    for (const g of this.gamepads) g.reset();
    this.touch.reset();
    this.virtualJoysticks.reset();
  }
}

// ---- Pure helpers (exported for testability + reuse from a UI rebind tool) ----

function applyScalarModifiers(v, binding) {
  if (typeof v === "number") {
    let out = v * binding.scale;
    if (binding.negate) out = -out;
    return out;
  }
  if (typeof v === "object" && v !== null) {
    const out = { x: (v.x ?? 0) * binding.scale, y: (v.y ?? 0) * binding.scale };
    if (binding.negate) { out.x = -out.x; out.y = -out.y; }
    return out;
  }
  return 0;
}

function computeDown(action, before) {
  if (action.type === "button") return !!before;
  if (action.type === "value") return Math.abs(before) > 0.001;
  return Math.hypot(before.x ?? 0, before.y ?? 0) > 0.001;
}

export { applyScalarModifiers, computeDown };