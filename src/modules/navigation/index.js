// @ts-check
import { NavMeshComponent } from "./NavMeshComponent.js";
import { NavAgentComponent } from "./NavAgentComponent.js";
import { NavLinkComponent } from "./NavLinkComponent.js";
import { NavigationSystem } from "./NavigationSystem.js";

/**
 * Navigation module — recast/detour navmeshes, path queries and a steering
 * crowd, shipped the same way Rapier is.
 *
 * The wasm is imported lazily inside `setup()` so projects that don't enable
 * navigation never download or instantiate it, and `setup` returns immediately
 * with a placeholder handle while the init finishes in the background. Scene
 * deserialization continues meanwhile; the components wait on `ready` rather
 * than assuming the system exists, which is what keeps recast's init off the
 * visible boot path.
 */
export const navigationModule = {
  id: "navigation",
  name: "Navigation",
  version: "1.0.0",
  category: "AI",
  tags: ["navigation", "navmesh", "pathfinding", "ai", "agent", "recast", "wasm"],
  description:
    "Recast/Detour navigation: bake a navmesh from scene geometry, path " +
    "queries (findPath, sample, random point), Nav Agents with local " +
    "avoidance through a detour crowd, and off-mesh links for jumps and " +
    "ladders. Includes a viewport overlay of the baked surface.",
  components: [NavMeshComponent, NavAgentComponent, NavLinkComponent],

  setup(engine) {
    const ready = (async () => {
      const core = await import("recast-navigation");
      const generators = await import("recast-navigation/generators");
      await core.init();
      const system = new NavigationSystem(engine, { ...core, generators });
      engine.navigation = system;
      const prev = engine.modules.get("navigation");
      if (prev && prev.placeholder) {
        engine.modules.set("navigation", {
          system,
          dispose: () => {
            system.dispose();
            if (engine.navigation === system) engine.navigation = null;
          },
        });
      }
      // Components that attached while the wasm was loading are waiting on
      // this: it is what makes an agent authored before the module finished
      // initialising join the crowd rather than sit inert.
      engine.emit("navmesh-changed");
      return system;
    })();
    return { system: null, ready, placeholder: true, dispose: () => {} };
  },
};
