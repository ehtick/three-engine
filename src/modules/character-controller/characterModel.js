import characterModelGlbUrl from "./assets/CharacterModel.glb?url";

export * from "./characterModelData.js";

/**
 * The vendored GLB's URL — split into its own tiny file because `?url` is
 * Vite-only syntax; see `characterModelData.js` for everything importable
 * from plain Node (clip names, native height, the locomotion graph).
 *
 * ## Why a vendored file, not a live fetch from an asset library
 *
 * The character is Mixamo's "Y Bot" plus four of its animations, merged
 * offline into one GLB (`scripts/merge-ybot-clips.mjs` — see
 * `characterModelData.js` for the merge itself and its licensing note).
 * Mixamo's own download flow has been broken since ~2025-06, so there is no
 * live source to fetch from even if that were otherwise the right call — see
 * `characterModelData.js`'s docs. Vendoring is the same fix that applied to
 * the Poly Pizza-sourced model this replaced: the file ships inside the
 * editor bundle (`?url`, the same mechanism `dracoWasm.js` uses for the Draco
 * codec) and `characterRig.js` writes it into the target project once, the
 * same way it writes the controller scripts.
 */
export const CHARACTER_MODEL_GLB_URL = characterModelGlbUrl;
