# World built-in surface maps

These optional surface details sit over procedural terrain and planting. The six original 1024 × 1024 files total **6,716,074 bytes**; no image editing or conversion was applied. [manifest.json](./manifest.json) records download URLs, checksums, dimensions, color spaces and attribution.

| Role | Source and authors | Original tile size | Files |
| --- | --- | --- | --- |
| `grass` | [Leafy Grass](https://polyhaven.com/a/leafy_grass), Charlotte Baglioni | 2 × 2 m | `leafy_grass_diff_1k.jpg`, `leafy_grass_disp_1k.png` |
| `soil` | [Brown Mud 02](https://polyhaven.com/a/brown_mud_02), Rob Tuytel | approximately 1.3 × 1.3 m | `brown_mud_02_diff_1k.jpg`, `brown_mud_02_disp_1k.png` |
| `rock` | [Rock Face 03](https://polyhaven.com/a/rock_face_03), Dario Barresi and Rico Cilliers | approximately 2.7 × 2.7 m | `rock_face_03_diff_1k.jpg`, `rock_face_03_disp_1k.png` |

Assets are [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/), verified against [Poly Haven's license](https://polyhaven.com/license). Attribution is appreciated: **Surface assets by the credited artists, via Poly Haven. Powered by Poly Haven.** Poly Haven describes its textures as [seamless PBR materials](https://polyhaven.com/) and explains its [albedo convention](https://docs.polyhaven.com/en/faq).

## Replacing a set

Production World stores replacements in `document.resources.surfaceMaps`, with one entry for each `grass`, `soil` and `rock` role: `{ albedo: 'project/path.jpg', height: 'project/path.png', size: [2, 2] }`. The loader uses the ordinary engine asset resolver, and the exporter copies and rewrites these paths. Missing surfaceMaps selects this local built-in set through module-owned Vite URLs; no manifest fetch or external download is needed. The player ships hashed relative asset URLs that work in a nested static-host folder.

Standalone study callers may still pass another manifest URL to `loadWorldSurfaceMaps`. Its `assets` array should contain exactly one entry for each `role`: `grass`, `soil` and `rock`. Each entry needs:

- `id`: a stable asset identifier.
- `physicalDimensions.meters`: two finite positive numbers, giving the width and height of one repeat in world metres. Preserve source dimensions; do not substitute pixel resolution.
- `maps.albedo.publicURL` and `maps.height.publicURL`: URLs for both images. Relative paths resolve against the loaded manifest URL; root-relative and absolute URLs also work.
- Source, author and license metadata, with updated file hashes and byte sizes. `provider` and `totalTextureBytes` describe the whole manifest.

Provide tileable albedo and matching height maps. Albedo uses `SRGBColorSpace`; height uses `NoColorSpace` and its red channel. Both repeat with filtered mipmaps. The texture owner must outlive borrowing materials; the valley study disposes its supplied owner after those materials.

The renderer browser-decodes height images and uses **artistic bump shading, not physical geometry displacement**. The original grass and rock height PNGs are 16-bit; mud is 8-bit. Browser decoding/upload may reduce precision. No calibrated displacement amplitude was supplied, so tile dimensions must not be interpreted as height amplitude. Surface scale and bump controls change appearance without moving terrain or plants.
