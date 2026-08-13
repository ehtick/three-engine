/** Sketchfab's catalog/import UI is editor-only; imported models are ordinary assets. */
export const sketchfabModule = {
  id: "sketchfab",
  name: "Sketchfab",
  category: "Assets",
  tags: ["editor-import", "assets", "models", "gltf", "creative-commons"],
  description:
    "Browse downloadable Sketchfab models and import authenticated GLTF downloads into the project with license attribution.",
  version: "1.0.0",
  components: [],
  async setup() {
    return {};
  },
};
