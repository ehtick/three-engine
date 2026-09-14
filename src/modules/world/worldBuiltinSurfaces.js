/** Module-owned URLs are rewritten into the player chunk's asset manifest by
 * Vite. They keep working under a nested static-host URL without an editor or
 * a project folder. Never serialize these generated URLs into World documents. */
export const WORLD_BUILTIN_SURFACES = Object.freeze({
  provider: 'Poly Haven',
  license: 'CC0-1.0',
  attribution: 'Surface assets by the credited artists, via Poly Haven. Powered by Poly Haven.',
  totalTextureBytes: 6716074,
  sourceManifestURL: new URL('./assets/manifest.json', import.meta.url).href,
  assets: [
    { id: 'leafy_grass', role: 'grass', physicalDimensions: { meters: [2, 2] },
      maps: {
        albedo: { url: new URL('./assets/leafy_grass_diff_1k.jpg', import.meta.url).href },
        height: { url: new URL('./assets/leafy_grass_disp_1k.png', import.meta.url).href },
      } },
    { id: 'brown_mud_02', role: 'soil', physicalDimensions: { meters: [1.299996018409729, 1.299996018409729] },
      maps: {
        albedo: { url: new URL('./assets/brown_mud_02_diff_1k.jpg', import.meta.url).href },
        height: { url: new URL('./assets/brown_mud_02_disp_1k.png', import.meta.url).href },
      } },
    { id: 'rock_face_03', role: 'rock', physicalDimensions: { meters: [2.6999995708465576, 2.6999995708465576] },
      maps: {
        albedo: { url: new URL('./assets/rock_face_03_diff_1k.jpg', import.meta.url).href },
        height: { url: new URL('./assets/rock_face_03_disp_1k.png', import.meta.url).href },
      } },
  ],
});
