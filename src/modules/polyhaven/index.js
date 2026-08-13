import { EnvironmentComponent } from "./EnvironmentComponent.js";

/**
 * Poly Haven integration. Runtime side is just the Environment (HDRI)
 * component — the browse/download UI is editor-only (Window ▸ Poly Haven)
 * and gates itself on this module being enabled. Downloads land in the
 * project's PolyHaven/ folder as ordinary assets (textures + .mat, .glb
 * model folders, .hdr images), so nothing here is needed to *use* them —
 * only the Environment component ships with exported games.
 */
export const polyhavenModule = {
  id: "polyhaven",
  name: "Poly Haven",
  category: "Assets",
  tags: ["editor-import", "assets", "hdri", "pbr", "cc0"],
  description:
    "Browse and download free CC0 PBR materials, models and HDRIs from polyhaven.com straight into the project. Adds an Environment (HDRI) component for image-based lighting and skyboxes.",
  version: "1.0.0",
  components: [EnvironmentComponent],
  async setup() {
    return {};
  },
};
