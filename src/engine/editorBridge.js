/**
 * The seam between the engine and the editor.
 *
 * User scripts can `import { Editor } from "editor"` to drive the editor —
 * spawn entities into the scene the user is authoring, read the selection,
 * write assets, push undoable edits. That surface is implemented in
 * `src/editor/api/`, which imports React stores, the command bus, Tauri and
 * half the editor chrome. None of that may be reachable from `src/engine/`:
 * the player build imports the engine and would drag the entire editor into a
 * shipped game (and fail, since there is no editor to talk to).
 *
 * So the engine owns only a *slot*. The editor calls `setEditorApi(api)` once
 * at boot; everything script-facing reads it back through here. In a player
 * build nothing ever registers, `Editor.*` throws a sentence explaining why,
 * and no editor code is in the bundle. This is the same handshake
 * `assetResolver.js` uses for the asset loader, for the same reason.
 *
 * The decorators live here rather than in the editor for a different reason:
 * `ScriptComponent` (engine-side) has to read them off a loaded script class to
 * decide whether to run it outside play mode. A script that carries
 * `@executeInEditMode` and is opened in the player therefore still loads — the
 * decorator is a marker, and the marker means nothing at runtime.
 */

import { vmRecord, vmState } from "./vmState.js";

/**
 * The slot itself is VM-wide. The editor installs the API through whichever
 * copy of this module `api/index.js` imported; a script reaching `Editor.*`
 * through a second copy would find an empty slot and be told, in a confident
 * full sentence, that it is not running inside the editor.
 */
const slot = vmRecord("editorApiSlot", { api: null });

/** True when running inside the editor (i.e. `setEditorApi` has been called). */
export function hasEditorApi() {
  return !!slot.api;
}

/**
 * Installs the editor's API object. Called once by the editor at boot.
 * Returns an uninstall function, which the harnesses use to reset between
 * runs; production never calls it.
 */
export function setEditorApi(api) {
  slot.api = api ?? null;
  return () => {
    if (slot.api === api) slot.api = null;
  };
}

/** The raw API object, or null outside the editor. */
export function getEditorApi() {
  return slot.api;
}

const NO_EDITOR =
  'The "editor" module is only available inside the editor. ' +
  "Guard editor-only code with `if (isEditor())`, or move it into a script " +
  "that never ships with the game.";

/**
 * Script-facing handle. A Proxy rather than the api object itself because the
 * api does not exist yet when a script module is evaluated — scripts are
 * imported lazily, but a module-scope `const sel = Editor.selection` in a
 * script loaded during boot would otherwise capture `undefined` forever.
 * Forwarding per-access keeps the binding live and lets us throw a real
 * sentence in the player instead of "Cannot read properties of null".
 */
export const Editor = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === "then") return undefined; // never look thenable to `await`
      if (!slot.api) throw new Error(NO_EDITOR);
      const value = slot.api[prop];
      return typeof value === "function" ? value.bind(slot.api) : value;
    },
    has(_target, prop) {
      return !!slot.api && prop in slot.api;
    },
    ownKeys() {
      return slot.api ? Reflect.ownKeys(slot.api) : [];
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (!slot.api) return undefined;
      const descriptor = Reflect.getOwnPropertyDescriptor(slot.api, prop);
      return descriptor && { ...descriptor, configurable: true };
    },
  },
);

/** Cheap "am I in the editor?" test for scripts that ship with the game. */
export function isEditor() {
  return !!slot.api;
}

// ---- @executeInEditMode -----------------------------------------------------

/**
 * Class decorator. Unity's `[ExecuteInEditMode]`: the script gets a lifecycle
 * (`onStart` / `onDestroy`) and an `onEditorUpdate(dt)` tick while the editor
 * is NOT playing, instead of sitting inert until Play.
 *
 * `onUpdate` deliberately does NOT fire in edit mode. Unity reuses `Update` for
 * both and the result is that every such script opens with
 * `if (!Application.isPlaying) return;` or, worse, silently mutates the scene
 * you are authoring. Two hooks make the intent explicit at the call site, and a
 * script that genuinely wants one body for both can write
 * `onEditorUpdate(dt) { this.onUpdate(dt); }`.
 *
 * Usable both bare and called:
 *
 *     @executeInEditMode
 *     export default class Grid extends Script {}
 *
 *     @executeInEditMode()
 *     export default class Grid extends Script {}
 */
export function executeInEditMode(target) {
  const mark = (cls) => {
    cls.executeInEditMode = true;
    return cls;
  };
  // Bare form: the decorator itself receives the class.
  if (typeof target === "function") return mark(target);
  // Called form: `@executeInEditMode()` — return the actual decorator.
  return mark;
}

/** True when `cls` was marked with {@link executeInEditMode}. */
export function runsInEditMode(cls) {
  return !!cls?.executeInEditMode;
}

// ---- @menuItem and standalone menu registration -----------------------------

/**
 * Menu entries contributed by scripts, keyed by an id so a hot reload replaces
 * its own entries instead of stacking duplicates every 0.75s poll.
 *
 * Two registration paths, because the two things people want are different:
 *
 *   - `@menuItem("Tools/Rebuild Nav Mesh")` on a script METHOD. Bound to that
 *     script instance, so it can touch `this.entity`. Appears only while an
 *     entity carrying the script is in the scene — which is what you want for
 *     "do this to this object".
 *   - `registerMenuItem("Tools/Import CSV", fn)` at module scope. Not bound to
 *     anything, alive as long as the module is loaded. For project-wide tools.
 */
// VM-wide, like the API slot above: the MenuBar subscribes through the copy the
// editor chrome imported, and a script registering through another copy would
// add an entry no menu is listening to.
const menuEntries = vmState("scriptMenuEntries", () => new Map()); // id -> { id, path, label, order, run }
const menuListeners = vmState("scriptMenuListeners", () => new Set());
const menuIds = vmRecord("scriptMenuSeq", { next: 0 });

function notifyMenus() {
  for (const fn of menuListeners) {
    try {
      fn(listMenuItems());
    } catch (err) {
      console.error("Editor menu listener threw:", err);
    }
  }
}

/**
 * Registers a menu entry. `path` is `"TopMenu/Label"`; deeper paths keep the
 * remainder as the visible label (`"Tools/Nav/Bake"` shows as "Nav/Bake" under
 * Tools) because the menu bar renders one flat list per top-level menu.
 *
 * Returns an unregister function. Passing an explicit `id` makes the
 * registration idempotent — re-registering the same id replaces it, which is
 * how hot reload avoids duplicates.
 * @param {string} path
 * @param {() => void} run
 * @param {{ id?: string, order?: number }} [options]
 */
export function registerMenuItem(path, run, { id, order = 0 } = {}) {
  if (typeof run !== "function") throw new Error("registerMenuItem needs a function");
  const key = id ?? `menu:${++menuIds.next}`;
  const [menu, ...rest] = String(path).split("/");
  menuEntries.set(key, {
    id: key,
    // A path with no "/" (just "Bake") lands under Tools rather than creating a
    // top-level menu per script.
    menu: rest.length ? menu : "Tools",
    label: rest.length ? rest.join("/") : menu,
    order,
    run,
  });
  notifyMenus();
  return () => {
    if (menuEntries.delete(key)) notifyMenus();
  };
}

/** Every registered entry, sorted by menu then explicit order then label. */
export function listMenuItems() {
  return [...menuEntries.values()].sort(
    (a, b) =>
      a.menu.localeCompare(b.menu) || a.order - b.order || a.label.localeCompare(b.label),
  );
}

/** Subscribes to menu-entry changes; fires immediately with the current list. */
export function subscribeMenuItems(fn) {
  menuListeners.add(fn);
  fn(listMenuItems());
  return () => menuListeners.delete(fn);
}

/** Drops every entry whose id starts with `prefix` (used to retire a script's
 *  entries when its component detaches or reloads). */
export function unregisterMenuItemsWithPrefix(prefix) {
  let changed = false;
  for (const key of [...menuEntries.keys()]) {
    if (key.startsWith(prefix)) {
      menuEntries.delete(key);
      changed = true;
    }
  }
  if (changed) notifyMenus();
}

/**
 * Method decorator recording `path` against the method name in the class's
 * static `menuItems` map. `ScriptComponent` reads that map when a script
 * instance is created and registers one bound entry per method.
 *
 * Declared as an own property per class (never inherited-and-mutated), so a
 * subclass adding entries doesn't retroactively give them to its base.
 */
export function menuItem(path, { order = 0 } = {}) {
  return function (target, key) {
    const cls = target?.constructor ?? target;
    if (!Object.prototype.hasOwnProperty.call(cls, "menuItems")) {
      cls.menuItems = { ...cls.menuItems };
    }
    cls.menuItems[key] = { path, order };
  };
}

/** Menu-item descriptors declared on `cls` via {@link menuItem}. */
export function getMenuItemDefs(cls) {
  return cls?.menuItems ?? {};
}
