import { registerModuleDefinition } from "../engine/modules.js";
import { physicsRapierModule } from "./physics-rapier/index.js";
import { dracoModule } from "./draco/index.js";
import { basisModule } from "./basis/index.js";
import { terrainModule } from "./terrain/index.js";
import { virtualGeometryModule } from "./virtual-geometry/index.js";
import { postprocessingModule } from "./postprocessing/index.js";
import { polyhavenModule } from "./polyhaven/index.js";
import { ambientcgModule } from "./ambientcg/index.js";
import { sketchfabModule } from "./sketchfab/index.js";
import { polypizzaModule } from "./polypizza/index.js";
import { kaykitModule } from "./kaykit/index.js";
import { fabModule } from "./fab/index.js";
import { itchioModule } from "./itchio/index.js";
import { giModule } from "./gi/index.js";
import { navigationModule } from "./navigation/index.js";
import { textureEditorModule } from "./texture-editor/index.js";
import { audioLibraryModule } from "./audio-library/index.js";
import { audioEditorModule } from "./audio-editor/index.js";
import { architectureModule } from "./architecture/index.js";
const levelDesignModule = architectureModule;
import { characterControllerModule } from "./character-controller/index.js";
import { kimodoModule } from "./kimodo/index.js";
import { vfxModule } from "./vfx/index.js";
import { clothModule } from "./cloth/index.js";
import { waterModule } from "./water/index.js";
import { particlesModule } from "./particles/index.js";
import { foliageModule } from "./foliage/index.js";
import { atmosphereModule } from "./atmosphere/index.js";
import { worldModule } from "./world/index.js";
/**
 * Built-in module catalog. Importing this file registers every definition;
 * nothing runs until a host enables a module on an engine (editor: Modules
 * panel / project.json `modules`; player: scene.json `modules`).
 *
 * Modules live outside src/engine but obey the same rule: no React, no
 * Tauri — they ship with exported games.
 */
registerModuleDefinition(physicsRapierModule);
registerModuleDefinition(dracoModule);
registerModuleDefinition(basisModule);
registerModuleDefinition(terrainModule);
registerModuleDefinition(worldModule);
registerModuleDefinition(virtualGeometryModule);
registerModuleDefinition(postprocessingModule);
registerModuleDefinition(polyhavenModule);
registerModuleDefinition(ambientcgModule);
registerModuleDefinition(sketchfabModule);
registerModuleDefinition(polypizzaModule);
registerModuleDefinition(kaykitModule);
registerModuleDefinition(fabModule);
registerModuleDefinition(itchioModule);
registerModuleDefinition(giModule);
registerModuleDefinition(navigationModule);
registerModuleDefinition(textureEditorModule);
registerModuleDefinition(audioLibraryModule);
registerModuleDefinition(audioEditorModule);
registerModuleDefinition(architectureModule);
registerModuleDefinition(characterControllerModule);
registerModuleDefinition(kimodoModule);
registerModuleDefinition(vfxModule);
registerModuleDefinition(clothModule);
registerModuleDefinition(waterModule);
registerModuleDefinition(particlesModule);
registerModuleDefinition(foliageModule);
registerModuleDefinition(atmosphereModule);

export { vfxModule, clothModule, waterModule, particlesModule, foliageModule, atmosphereModule };
export { architectureModule, worldModule };

export { physicsRapierModule, dracoModule, basisModule, terrainModule, virtualGeometryModule, postprocessingModule, polyhavenModule, ambientcgModule, sketchfabModule, polypizzaModule, kaykitModule, fabModule, itchioModule, giModule, navigationModule, textureEditorModule, audioLibraryModule, audioEditorModule, levelDesignModule, characterControllerModule, kimodoModule };
