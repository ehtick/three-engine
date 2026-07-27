/**
 * VM-wide singletons for module-level editor state.
 *
 * A module that does `export const x = makeThing()` is a singleton only as long
 * as the module is evaluated once. In this app that assumption is wrong twice
 * over: Vite serves a module the app has touched as both `foo.js` and
 * `foo.js?t=<mtime>` (the trap the puppeteer harnesses work around with
 * `importLive`), and an HMR update re-evaluates it outright while the old copy
 * is still live in React's tree.
 *
 * That is harmless for pure functions and catastrophic for stateful handles.
 * The failure that prompted this: after a long dev session of edits, the editor
 * ended up with two `commandBus`es and two `useSceneStore`s. Ops driven over
 * MCP pushed commands into the newer bus, which refreshed the newer store —
 * which no mounted component was subscribed to. The engine really was being
 * mutated, so the scene autosaved correctly and every edit reappeared after a
 * restart, while the running editor showed nothing at all. Silent, and it looks
 * exactly like "the feature doesn't work".
 *
 * Hanging the instance off a `Symbol.for` key makes a re-evaluated module reuse
 * the first instance, which is what "singleton" was supposed to mean. React
 * components hold the original reference anyway, so preserving it is also the
 * behaviour that keeps a hot reload from dropping editor state on the floor.
 *
 * `assetLoader.js` already guards esbuild's one-shot `initialize()` this way,
 * and `api/registry.js` the op table; this is the same pattern with a name.
 *
 * Use it for stateful module-level handles — stores, buses, caches. Do NOT use
 * it as a general "make this global"; a value that can be safely recreated
 * should just be recreated.
 */
export function vmSingleton(key, factory) {
  const symbol = Symbol.for(`three-engine.${key}`);
  return (globalThis[symbol] ??= factory());
}

/**
 * True the first time it is called for `key` in this VM, false afterwards.
 *
 * For module-scope side effects that must not run twice — subscribing to an
 * engine event, starting an interval. `vmSingleton` covers values; this covers
 * the statements next to them.
 */
export function oncePerVm(key) {
  const symbol = Symbol.for(`three-engine.once.${key}`);
  if (globalThis[symbol]) return false;
  globalThis[symbol] = true;
  return true;
}
