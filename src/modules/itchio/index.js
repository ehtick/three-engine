/**
 * itch.io integration. Purely an editor-side importer + publish helper — like
 * Poly Haven/AmbientCG/Sketchfab, there is nothing runtime here. Downloads
 * land in the project's Itchio/<Game>/<Upload>/ folder as ordinary assets
 * (textures, audio, .glb models), so an exported game needs nothing from
 * this module to *use* them; enabling it only turns on the browser panel.
 */
export const itchioModule = {
  id: "itchio",
  name: "itch.io",
  category: "Editor",
  tags: ["editor-import", "assets", "itch.io", "publish"],
  description:
    "Search the whole itch.io store and import free asset packs straight into the project, plus your own owned/purchased library. Store browsing is unofficial (it reads itch.io's public pages); downloads go through itch.io's API with your key. Also builds a publish-ready zip for uploading to your own itch.io page.",
  version: "1.0.0",
  components: [],
  async setup() {
    return {};
  },
};
