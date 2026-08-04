/**
 * Texture Editor.
 *
 * Editor-only, like the asset-library browsers: enabling it turns on the paint
 * canvas, the image processing tools and (from phase 3) the atlas/sprite
 * authoring surfaces. Nothing here ships inside an exported game.
 *
 * What the module *authors* deliberately does not live in it. Sprite atlases,
 * nine-slice insets and sprite animations are consumed by `SpriteComponent` and
 * the UI widgets, which are core engine — a shipped game must be able to draw a
 * sprite without a project having enabled a tool called "Texture Editor".
 */
export const textureEditorModule = {
  id: "texture-editor",
  name: "Texture Editor",
  category: "Editor",
  tags: ["editor-tool", "textures", "sprites", "atlas", "painting"],
  description:
    "Paint, process and compose textures inside the editor: layers with blend modes, brush/shape/fill/gradient tools, selections, and non-destructive documents stored beside each image. Sprite atlases, nine-slice and animated sprites follow.",
  version: "1.0.0",
  components: [],
  async setup() {
    return {};
  },
};
