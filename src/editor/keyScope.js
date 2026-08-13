// @ts-check
import { isGraphHovered, isPointerInside } from "./nodegraph/graphContext.js";

/**
 * Who owns the keyboard right now.
 *
 * Every editor context — the viewport, the code editor, the paint canvas, the
 * dope sheet, a rename field — wants its own keymap, and those keymaps overlap
 * heavily (Ctrl+S, Ctrl+Z, Delete, single letters). The editor used to settle
 * that overlap five different ways at once: `closest("input, textarea, …")` in
 * one handler, `document.activeElement.tagName` in another, `matches(":hover")`
 * in a third, a geometric pointer test in a fourth, and a hardcoded list of
 * panel selectors in `EditorChrome`. The lists drifted apart, so a key could be
 * claimed twice or by the wrong context — most visibly in the code editor,
 * where Ctrl+S saved the scene *as well as* the file and Ctrl+F could never
 * open Monaco's find widget because the quick-search overlay took it first.
 *
 * This module answers the question once. Given a keyboard event it resolves a
 * single owning scope, and every handler in the editor asks it rather than
 * re-deriving ownership from the DOM.
 *
 * Resolution order, most specific first:
 *   1. inside a code editor            → "code"
 *   2. inside a text field             → "text"
 *   3. inside a registered panel root  → that panel  (innermost wins)
 *   4. the same three, against `document.activeElement`
 *   5. the pointer sits inside a panel root that opted into hover ownership
 *
 * Focus beats hover deliberately. Typing in the code editor with the pointer
 * resting over the texture editor used to hand Ctrl+Z to the paint canvas.
 *
 * Hover is still needed as a fallback because clicking a paint canvas, a
 * keyframe diamond or a graph edge never moves `document.activeElement`, so a
 * focus-only test would drop those panels' shortcuts the moment they were used.
 */

/**
 * Application verbs: they run from anywhere, including mid-word in the code
 * editor. Deliberately tiny — each one is a whole-app action (open a scene, run
 * the game, step a frame, build, close the project) that no text field and no
 * panel has its own meaning for, so there is nothing to collide with.
 */
const APP_CHORDS = ["ctrl+o", "ctrl+p", "ctrl+shift+p", "ctrl+.", "ctrl+b", "ctrl+shift+w"];

/** Panels let the app keep its verbs, plus quick search. */
const PANEL_PASSTHROUGH = new Set([...APP_CHORDS, "ctrl+f"]);

/**
 * A plain text field claims typing and the editing chords (Ctrl+Z/C/X/V/A,
 * Delete, arrows) but has no meaning of its own for save or find, so those keep
 * reaching the app — Ctrl+S still saves the scene from a rename field.
 */
const TEXT_PASSTHROUGH = new Set([...PANEL_PASSTHROUGH, "ctrl+s", "ctrl+shift+s"]);

/**
 * A code editor is the one context that owns save AND find: Ctrl+S writes the
 * file (`CodeEditor` registers it on the Monaco instance) and Ctrl+F opens the
 * find widget. Only the app verbs get through.
 */
const CODE_PASSTHROUGH = new Set(APP_CHORDS);

const CODE_SELECTOR = ".monaco-editor";
const TEXT_SELECTOR =
  "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

const CODE_SCOPE = { id: "code", passthrough: CODE_PASSTHROUGH };
const TEXT_SCOPE = { id: "text", passthrough: TEXT_PASSTHROUGH };

/**
 * Every panel that runs its own keymap, and how it claims the keyboard.
 *
 * `pointer: true` means the panel also owns keys while the pointer merely rests
 * over it — correct for canvas-like surfaces where interacting doesn't move
 * focus. `pointer: false` restricts it to real DOM focus/target ancestry.
 *
 * Adding a panel keymap is a row here; nothing else in the editor needs to
 * learn about it.
 */
export const KEY_SCOPES = [
  { id: "geometry", selector: ".geometry-editor", pointer: false, passthrough: PANEL_PASSTHROUGH },
  { id: "code", selector: ".code-panel", pointer: true, passthrough: PANEL_PASSTHROUGH },
  // Both selectors on purpose: `.shader-graph-canvas` is the editor's own
  // wrapper (it carries the toolbar and the palette), `.react-flow` the canvas
  // inside it. A graph mounted without the wrapper still gets its keys.
  {
    id: "graph",
    selector: ".react-flow, .shader-graph-canvas",
    pointer: true,
    passthrough: PANEL_PASSTHROUGH,
    hovered: isGraphHovered,
  },
  { id: "timeline", selector: ".timeline-panel", pointer: true, passthrough: PANEL_PASSTHROUGH },
  { id: "texture", selector: ".texture-editor", pointer: true, passthrough: PANEL_PASSTHROUGH },
  { id: "audio", selector: ".audio-editor", pointer: true, passthrough: PANEL_PASSTHROUGH },
];

/**
 * Normalised chord for an event: "ctrl+shift+s", "delete", "f", "ctrl+.".
 * Meta folds into "ctrl" so one spelling covers both platforms, matching the
 * `e.ctrlKey || e.metaKey` test every handler in the editor already uses.
 */
export function chordOf(event) {
  const parts = [];
  if (event.ctrlKey || event.metaKey) parts.push("ctrl");
  if (event.shiftKey) parts.push("shift");
  if (event.altKey) parts.push("alt");
  parts.push(String(event.key ?? "").toLowerCase());
  return parts.join("+");
}

function closestScope(node) {
  if (!(node instanceof Element)) return null;
  // A code editor's own textarea is still the code editor, so this has to win
  // over the walk below — which would otherwise stop at the textarea and call
  // it a plain text field.
  const code = node.closest(CODE_SELECTOR);
  if (code) return { scope: CODE_SCOPE, element: code };
  for (let el = node; el; el = el.parentElement) {
    if (el.matches(TEXT_SELECTOR)) return { scope: TEXT_SCOPE, element: el };
    for (const scope of KEY_SCOPES) {
      if (el.matches(scope.selector)) return { scope, element: el };
    }
  }
  return null;
}

function depthOf(el) {
  let n = 0;
  for (let p = el; p; p = p.parentElement) n += 1;
  return n;
}

/** Innermost hover-owning panel under the pointer, or null. */
function scopeUnderPointer() {
  if (typeof document === "undefined") return null;
  let best = null;
  let bestDepth = -1;
  let fallback = null;
  for (const scope of KEY_SCOPES) {
    if (!scope.pointer) continue;
    for (const el of document.querySelectorAll(scope.selector)) {
      if (!isPointerInside(el)) continue;
      const depth = depthOf(el);
      if (depth > bestDepth) {
        best = { scope, element: el };
        bestDepth = depth;
      }
    }
    // The graph editors track their own hover flag as well: a dropdown overlay
    // mounting under a stationary pointer fires `mouseleave` on the canvas, and
    // the flag survives that where a bounding-box test on a covered canvas
    // would not. It names no element — it is a module-wide "some graph has the
    // pointer" flag — so it is only a last resort.
    if (!fallback && scope.hovered?.()) fallback = { scope, element: null };
  }
  return best ?? fallback;
}

// Several handlers ask about the same event (the global one, the panel's own,
// quick search). Resolving once per event keeps them consistent even if the DOM
// changes mid-dispatch, and skips repeated `querySelectorAll` sweeps.
const resolved = new WeakMap();

function resolve(event) {
  if (resolved.has(event)) return resolved.get(event);
  const hit =
    closestScope(event.target) ??
    closestScope(typeof document === "undefined" ? null : document.activeElement) ??
    scopeUnderPointer();
  resolved.set(event, hit);
  return hit;
}

/**
 * The scope that owns `event`, or null when nothing does and the event belongs
 * to the editor at large (the viewport, the hierarchy, the menu bar).
 */
export function activeKeyScope(event) {
  return resolve(event)?.scope ?? null;
}

/**
 * The element the owning scope was resolved from, or null when it came from a
 * panel's own hover flag rather than a specific node. Panels that can be
 * mounted more than once (the node-graph editors) use it to check the key
 * landed on *this* instance and not a sibling.
 */
export function activeKeyScopeElement(event) {
  return resolve(event)?.element ?? null;
}

/**
 * True when some context other than the editor at large claims this key, so a
 * global handler must keep its hands off it. Passthrough chords (see above)
 * report false even inside a scope — that is how Ctrl+P still starts the game
 * from inside the code editor.
 */
export function keyScopeOwns(event) {
  const scope = activeKeyScope(event);
  if (!scope) return false;
  return !scope.passthrough.has(chordOf(event));
}

/**
 * True when `id` is the context that owns this key. Panels use this in place of
 * their own hover/focus tests, so a panel never acts on a key that a code
 * editor, a text field or a panel nested inside it has already claimed.
 */
export function ownsKeyboard(id, event) {
  return activeKeyScope(event)?.id === id;
}

/**
 * True while the user is typing — in a text field or a code editor. For
 * handlers that only need to stay out of the way of text entry and have no
 * scope of their own.
 */
export function isTypingTarget(event) {
  const id = activeKeyScope(event)?.id;
  return id === "text" || id === "code";
}
