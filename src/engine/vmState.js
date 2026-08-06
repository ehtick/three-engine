/**
 * VM-wide state for the engine's module-level caches and registries.
 *
 * The editor has `src/editor/singleton.js` for exactly this, and engine code
 * must not import editor code — so this is the same idea on the engine side of
 * the seam, with its own key namespace so the two can never collide.
 *
 * ## Why a module-level `const cache = new Map()` is not a singleton here
 *
 * This file graph is evaluated more than once in normal use, for three separate
 * reasons:
 *
 *   1. Vite serves a touched module as both `foo.js` and `foo.js?t=<mtime>`,
 *      and rewrites dynamic `import()` specifiers to the `?t=` form — which is
 *      how the editor reaches the whole engine (`import("../engine/index.js")`).
 *   2. The same file is reachable as `/src/…` and as `/@fs/C:/…`; a puppeteer
 *      harness importing the first form sits beside an editor graph using the
 *      second (see the note in `modules.js`).
 *   3. An HMR update re-evaluates a module outright while the old copy is still
 *      live in React's tree.
 *
 * For a pure function that is harmless. For an asset cache or a subscriber
 * registry it is the worst kind of bug: the editor edits a material through one
 * copy — invalidating that copy's cache and notifying that copy's subscribers —
 * while the mesh in the viewport resolved its material from the other copy and
 * is never told. Nothing throws. The file on disk is correct, so the change
 * "appears after a restart", which reads as the feature simply not working.
 *
 * Use it for stateful module-level handles: caches, subscriber sets, registries,
 * lazily-built shared GPU resources. Not for values that can be safely rebuilt.
 */
export function vmState(key, factory) {
  const symbol = Symbol.for(`three-engine.engine.${key}`);
  return (globalThis[symbol] ??= factory());
}

/**
 * A mutable record, for module-level `let`s.
 *
 * `vmState` shares a value; this shares the *variable*. `let cached = null`
 * cannot be shared by reference, so the reassignment has to move into a field:
 * `const s = vmRecord("x", { value: null })` then `s.value = …`.
 */
export function vmRecord(key, initial) {
  return vmState(key, () => ({ ...initial }));
}
