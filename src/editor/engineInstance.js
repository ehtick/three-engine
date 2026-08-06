// The editor's runtime engine. The actual Engine class plus all component
// classes and shader/particle graphs live in a heavy module graph (pulls in
// three/webgpu and registers every component at module load). To keep the
// boot path cheap we defer that import — and the `new Engine()` itself —
// until the first `await ensureEngine()` at a real entry point. The throw
// on direct `engine.X` access exists to catch any consumer that forgets to
// await; replace with `engineInstance` once it's resolved.

import { vmSingleton } from "./singleton.js";

/**
 * The one Engine, and the one in-flight load, held VM-wide.
 *
 * These were plain module-level `let`s, which is a singleton only while the
 * module is evaluated once — and this one is not. Vite serves a touched module
 * as both `foo.js` and `foo.js?t=<mtime>`, so a second evaluation used to
 * construct a SECOND `Engine`: ops would spawn entities into an engine nothing
 * was rendering, the viewport kept drawing the first one, and the edit only
 * appeared after a restart (when the autosaved scene was reloaded into a single
 * fresh instance). Two engines is the worst version of the split-brain
 * described in `singleton.js`, because every downstream store is keyed off
 * whichever one its module happened to capture.
 */
const state = vmSingleton("engineInstance", () => ({
  /** @type {any} */ instance: null,
  /** @type {Promise<any> | null} */ loader: null,
}));

async function loadEngine() {
  if (state.instance) return state.instance;
  if (!state.loader) {
    state.loader = (async () => {
      const [
        {
          Engine,
          THREE,
          setAssetResolver,
          setScriptLoader,
          setAssetMetaLoader,
          setSceneLoader,
          setAssetBinarySaver,
          setDerivedDataRootProvider,
          registerBuiltInComponents,
        },
        { toBlobUrl, loadScriptModule, readAssetMeta, readSceneJson, writeAssetBinary, onAssetInvalidated },
        { useProjectStore },
        { invalidateGeometryAsset },
      ] = await Promise.all([
        import("../engine/index.js"),
        import("./assetLoader.js"),
        import("./store/projectStore.js"),
        import("../engine/geometryAsset.js"),
      ]);
      // Debugging convenience only: reach the engine's three instance from a
      // console or a test harness. User scripts no longer need it — the
      // script-runtime proxies are real modules that import three themselves
      // (see scriptRuntime.js), so there is no boot-order requirement here.
      globalThis.__ENGINE_THREE__ = THREE;
      // Built-in components must be on the registry before any scene is
      // deserialized; calling explicitly also survives bundler tree-shaking
      // in production builds where the side-effect imports would otherwise
      // be dropped.
      registerBuiltInComponents();
      const inst = new Engine();
      // The runtime stays fs-agnostic; the editor supplies the actual
      // path -> URL resolution (Tauri fs read -> blob: URL) and script
      // loading so components can stay portable.
      setAssetResolver(toBlobUrl);
      setScriptLoader(loadScriptModule);
      setAssetMetaLoader(readAssetMeta);
      // Runtime `engine.loadScene("scenes/X.scene")` — resolved against the
      // open project so a script behaves identically here and in a build.
      setSceneLoader(readSceneJson);
      setAssetBinarySaver(writeAssetBinary);
      // `.geom` files are also cached as decoded, SHARED BufferGeometry
      // instances. Every in-place asset overwrite goes through
      // `invalidateBlobUrl`, so hanging the geometry cache off that keeps a
      // re-saved mesh from rendering stale. Wired here (rather than imported
      // by assetLoader.js) so the lightweight asset modules stay free of
      // `three/webgpu`.
      onAssetInvalidated(invalidateGeometryAsset);
      // Derived data (hash-keyed baked SDFs etc.) lives in `<project>/Library`
      // — read lazily so it tracks whichever project is currently open.
      setDerivedDataRootProvider(() => {
        const root = useProjectStore.getState().rootPath;
        return root ? `${root}/Library` : null;
      });
      state.instance = inst;
      // The Editor API publishes itself to the script runtime and starts the
      // gizmo pass, both of which need a live engine — hence here rather than
      // at module scope. Dynamically imported so the command bus and the React
      // stores it pulls in stay out of the boot chunk.
      const { installEditorApi } = await import("./api/index.js");
      installEditorApi();
      return inst;
    })();
  }
  return state.loader;
}

/** Resolves to the singleton Engine. Safe to await multiple times. */
export function ensureEngine() {
  return loadEngine();
}

/**
 * True once the singleton Engine exists — i.e. once touching the `engine`
 * proxy below is safe. For code that legitimately runs during the load window
 * (a panel's mount effect can beat `ensureEngine()`, most reliably after a page
 * reload with a persisted dockview layout) and needs to no-op rather than
 * throw. A throw inside a React mount effect unmounts the whole tree, so the
 * visible symptom is not an error message but a viewport that never appears.
 */
export function isEngineReady() {
  return state.instance !== null && state.instance !== undefined;
}

/**
 * Backwards-compatible shim. The Proxy returns `engineInstance` once it's
 * resolved and throws a helpful error during the load window — that window
 * is short (the engine is awaited in `EditorShell`'s mount effect before any
 * UI interaction is possible), and the throw makes any forgotten `await`
 * obvious instead of silently returning undefined.
 */
/** @type {import("engine").Engine} */
export const engine = /** @type {any} */ (
  vmSingleton(
    "engineProxy",
    () =>
      new Proxy(function () {}, {
        get(_target, prop) {
          if (prop === "then") return undefined; // not a thenable
          if (!state.instance) {
            if (import.meta.env?.DEV) {
              throw new Error(
                "engine accessed before `await ensureEngine()` — fix the consumer to await.",
              );
            }
            throw new Error("engine not initialized; await ensureEngine() first");
          }
          const value = state.instance[prop];
          return typeof value === "function" ? value.bind(state.instance) : value;
        },
        // Without a set trap, writes like `engine.camera = ...` would land on the
        // dummy Proxy target and silently never reach the real engine.
        set(_target, prop, value) {
          if (!state.instance) {
            throw new Error("engine assigned before `await ensureEngine()` — fix the consumer to await.");
          }
          state.instance[prop] = value;
          return true;
        },
      }),
  )
);
