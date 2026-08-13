/**
 * Keyboard input device. Maps every KeyboardEvent.code into a stable control
 * name and tracks per-key pressed state. Subscribes once on `attach`; the
 * manager disposes via `detach`.
 *
 * Control naming: "keyboard/<code>", lowercased — e.g. "keyboard/keyw",
 * "keyboard/space", "keyboard/arrowup". We use `event.code` (physical key)
 * rather than `event.key` so QWERTY/AZERTY layouts feel the same; rebinding
 * in the editor stays layout-independent.
 */
/**
 * True when the keystroke was aimed at somewhere text goes. Kept here as a
 * plain DOM test rather than an import so the engine keeps no dependency on
 * the editor — a shipped game needs exactly the same rule.
 */
function isEditableTarget(target) {
  if (!(target instanceof Element)) return false;
  return !!target.closest(
    "input, textarea, select, [contenteditable]:not([contenteditable='false']), .monaco-editor",
  );
}

export class KeyboardDevice {
  constructor() {
    this.id = "keyboard";
    this.name = "Keyboard";
    this.connected = true;
    this.state = new Map(); // code -> boolean
    this._onDown = (e) => this.#handleKey(e, true);
    this._onUp = (e) => this.#handleKey(e, false);
    this._onBlur = () => this.state.clear();
  }

  // Keyboard events always listen on `window` regardless of the passed
  // `target`. Canvas elements aren't focusable by default, so a keydown that
  // fires while focus is on a button, an inspector input, or just the page
  // body would never reach a canvas-scoped listener — leaving
  // `readValue("Move")` stuck at (0, 0). Keyboard events bubble up to window
  // in every browser, so listening there is the only way to guarantee capture.
  attach(_target = window) {
    this.target = window;
    window.addEventListener("keydown", this._onDown);
    window.addEventListener("keyup", this._onUp);
    window.addEventListener("blur", this._onBlur);
  }

  detach() {
    if (!this.target) return;
    this.target.removeEventListener("keydown", this._onDown);
    this.target.removeEventListener("keyup", this._onUp);
    window.removeEventListener("blur", this._onBlur);
    this.target = null;
    this.state.clear();
  }

  #handleKey(e, pressed) {
    const code = e.code?.toLowerCase();
    if (!code) return;
    // Typing is not gameplay. Listening on `window` (see attach) means every
    // keystroke aimed at a text field, a code editor or any other editable
    // element also lands here — so in the editor, writing a script while the
    // game ran walked the player around, and in a shipped game a chat box or a
    // name entry did the same. Releases are never filtered: if a key went down
    // as gameplay and came up while a field had focus, dropping the keyup would
    // leave the control stuck on forever.
    if (pressed && isEditableTarget(e.target)) return;
    // Repeats (auto-repeat keydown) don't count as a new press — the manager
    // tracks the leading-edge frame for `wasPressedThisFrame`.
    if (pressed && this.state.get(code)) return;
    this.state.set(code, pressed);
  }

  /** Returns boolean: is the named control currently held? */
  isPressed(path) {
    const code = path.split("/")[1];
    return !!this.state.get(code);
  }

  /** Scalar read for axis bindings (we treat modifier keys as 0/1 toggles). */
  readValue(path) {
    return this.isPressed(path) ? 1 : 0;
  }

  /** Reset everything (called when entering play, on focus loss, etc.). */
  reset() {
    this.state.clear();
  }

  /** Convenience for editor rebinding: which keycode just went down? */
  static lastKeyDown = null;
}