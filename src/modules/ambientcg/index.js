import { ObjModelComponent } from "./ObjModelComponent.js";

/**
 * AmbientCG integration. Three asset kinds:
 *
 *   materials → AmbientCG/<Name>/  maps (jpg) + <Name>.mat wiring a full PBR
 *              shader graph (color / normal / roughness / AO / metalness /
 *              displacement), data maps tagged linear via .meta.
 *
 *   hdris     → AmbientCG/<Name>/<Name>_<res>.exr (the environment map
 *              itself; the existing Environment (HDRI) component from the
 *              polyhaven module loads it directly).
 *
 *   models    → AmbientCG/<Name>/<Name>.obj + <Name>.mtl + companion texture
 *              maps + <Name>.prefab (one entity with an `objModel` component
 *              pointing at the obj/mtl pair; the component ships with this
 *              module).
 *
 * Browse/download UI is editor-only (Window ▸ AmbientCG) and gates itself
 * on this module being enabled. Downloads land in the project's
 * AmbientCG/ folder as ordinary assets — once imported, the assets are
 * usable from any scene regardless of whether the module stays enabled.
 */
export const ambientcgModule = {
  id: "ambientcg",
  name: "AmbientCG",
  category: "Assets",
  tags: ["editor-import", "assets", "textures", "models", "hdri", "pbr", "cc0"],
  description:
    "Browse and download free CC0 PBR materials, HDRIs and 3D models from ambientcg.com straight into the project. Adds an OBJ Model component for the runtime loader.",
  version: "1.0.0",
  components: [ObjModelComponent],
  async setup() {
    return {};
  },
};