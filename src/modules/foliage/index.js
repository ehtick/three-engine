import { FoliageComponent } from "./FoliageComponent.js";

export const foliageModule = {
  id: "foliage", name: "Foliage", version: "1.0.0", category: "World",
  tags: ["foliage", "trees", "grass", "flowers", "terrain", "world", "3d"],
  description: "Procedural trees, grass and flowers with surface scattering, wind, collider bending and automatic instanced LOD and impostors. Grass is drawn as a continuous sward rather than scattered.",
  components: [FoliageComponent],
  setup(engine) {
    engine._foliageModuleEnabled = true;
    for (const entity of engine.entities.values()) {
      const component = entity.getComponent("foliage");
      if (component?.missingType === "foliage") {
        const props = { ...component.props };
        entity.removeComponent("foliage");
        entity.addComponent(new FoliageComponent(props));
        continue;
      }
      if (component && component._attached !== false && !component._alive) component.onAttach();
    }
    return {
      dispose() {
        engine._foliageModuleEnabled = false;
        for (const entity of engine.entities.values()) {
          const component = entity.getComponent("foliage");
          if (component?._alive) component.onDetach();
        }
      },
    };
  },
};
