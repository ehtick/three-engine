/**
 * Poly Pizza integration. Browse/import UI is editor-only (Window ▸ Poly
 * Pizza) and gates itself on this module being enabled; downloads land in the
 * project's PolyPizza/ folder as ordinary GLB-unpacked assets, so nothing here
 * ships with an exported game — the module exists so the panel has something
 * to be enabled by, and so the project records that its assets came from here.
 */
export const polypizzaModule = {
  id: "polypizza",
  name: "Poly Pizza",
  category: "Assets",
  tags: ["editor-import", "assets", "models", "gltf", "cc0", "characters", "animated"],
  description:
    "Browse thousands of free low-poly models from poly.pizza — the Google Poly archive plus a decade of community work, under CC0 and CC-BY — and import them into the project. Includes rigged and animated characters and animals. Needs a free API key.",
  version: "1.0.0",
  components: [],
  async setup() {
    return {};
  },
};
