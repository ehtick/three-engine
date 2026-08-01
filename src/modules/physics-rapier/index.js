import { RigidbodyComponent } from "./RigidbodyComponent.js";
import { ColliderComponent } from "./ColliderComponent.js";
import { CharacterControllerComponent } from "./CharacterControllerComponent.js";
import { JointComponent } from "./JointComponent.js";
import { PhysicsSystem } from "./PhysicsSystem.js";
import { setPhysicsLayerConfig } from "./layerConfig.js";

/** Filters the one-shot deprecation warning from `@dimforge/rapier3d-compat`
 *  that fires every time `RAPIER.init()` is called. Installed once per VM
 *  (idempotent). See `physicsRapierModule.setup` for the full rationale. */
const RAPIER_INIT_WARNING =
  "using deprecated parameters for the initialization function; pass a single object instead";
let rapierWarningFilterInstalled = false;
function suppressRapierInitWarning() {
  if (rapierWarningFilterInstalled) return;
  rapierWarningFilterInstalled = true;
  const original = console.warn.bind(console);
  console.warn = (...args) => {
    if (typeof args[0] === "string" && args[0].includes(RAPIER_INIT_WARNING)) return;
    original(...args);
  };
}

/**
 * Rapier physics module. The wasm-backed Rapier package is imported lazily
 * inside setup() so projects (and exported games) that don't enable physics
 * never download or instantiate it.
 *
 * `setup` returns as soon as the JS module is loaded — the WASM init runs
 * in the background and the PhysicsSystem is installed when ready. The
 * scene continues deserializing while Rapier initializes; script hot-reload
 * and entity creation don't depend on the world being live, and the
 * PhysicsSystem itself no-ops on play-changed until `ready` resolves. This
 * keeps Rapier's ~300-800 ms WASM init off the visible boot path.
 */
export const physicsRapierModule = {
  id: "physics-rapier",
  name: "Rapier Physics",
  version: "1.0.0",
  category: "Physics",
  tags: ["physics", "rapier", "wasm", "3d", "rigidbody", "collider"],
  description:
    "Rigid-body physics powered by Rapier: Rigidbody, Collider, Character " +
    "Controller and Joint components, collision layers with a project-wide " +
    "matrix, fixed-step simulation in play mode, collision/trigger script " +
    "hooks, and ray/shape/overlap queries.",
  components: [RigidbodyComponent, ColliderComponent, CharacterControllerComponent, JointComponent],

  setup(engine) {
    // Layer names have to be readable by component schemas (the Inspector's
    // Layer dropdown) before — and independently of — the Rapier world.
    setPhysicsLayerConfig(engine.config?.physicsLayers);
    const ready = (async () => {
      const mod = await import("@dimforge/rapier3d-compat");
      const RAPIER = mod.default ?? mod;
      // `@dimforge/rapier3d-compat@0.19.3` (the version pinned by package.json)
      // ships a wrapper that always invokes the underlying wasm-bindgen
      // initializer with a raw `Uint8Array` of base64-decoded bytes — which the
      // initializer treats as a deprecated single-argument call and logs a
      // warning we cannot avoid at the call site:
      //   "using deprecated parameters for the initialization function; pass
      //    a single object instead"
      // The init still succeeds (the wasm is decoded from the embedded bytes),
      // so this warning is noise that drowns out real console messages from
      // the editor. Filter it on first import, after first call (which warms
      // the wasm cache and avoids any further warnings even on subsequent
      // init() calls).
      const originalInit = RAPIER.init;
      suppressRapierInitWarning();
      await originalInit.call(RAPIER);
      const system = new PhysicsSystem(engine, RAPIER);
      // Swap the placeholder handle for the live one once Rapier is up. If
      // the user disabled the module in the meantime, dispose immediately.
      const prev = engine.modules.get("physics-rapier");
      if (prev && prev.placeholder) {
        engine.modules.set("physics-rapier", { system, dispose: () => system.dispose() });
      }
    })();
    return {
      system: null,
      ready,
      placeholder: true,
      dispose: () => {
        // No-op until the real handle is installed — ready's `.then` cleans
        // up via the swap above.
      },
    };
  },
};