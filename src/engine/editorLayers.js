/**
 * Dedicated Three.js layer for objects that must only appear in the editor
 * view (camera model, gizmo, grid, selection box, frustum helper).
 *
 * The editor orbit camera leaves all layers enabled, so it sees this layer.
 * Play-mode cameras and the camera-preview camera must `layers.disable()` it
 * so the editor-only content doesn't leak into the game or the PIP render.
 *
 * Picking still works on layer-31 objects because the picking raycaster
 * tests all layers by default (see ViewportPanel.jsx `setupPicking`).
 */
export const EDITOR_LAYER = 31;

/**
 * Layer for runtime debug drawing (`engine.debug`).
 *
 * Deliberately NOT `EDITOR_LAYER`: debug draw is a gameplay-debugging tool, so
 * it has to be visible in Play mode and the Game view, which are exactly the
 * views that disable the editor layer. Giving it a layer of its own also means
 * a camera can switch all of it off at once — and keeps it out of any pass that
 * renders a filtered layer set.
 *
 * Cameras start with only layer 0 enabled, so every camera that should show
 * debug drawing enables this explicitly (`CameraComponent` and the editor's
 * orbit camera both do).
 */
export const DEBUG_LAYER = 30;

/**
 * Layer for objects large enough to be worth drawing into the occlusion
 * culling depth pass (`culling/OcclusionSystem.js`).
 *
 * A layer rather than a list, because the point is for the pass to SKIP the
 * rest of the scene without walking it: `camera.layers.set(OCCLUDER_LAYER)`
 * makes three's projection step reject everything else at the object level.
 *
 * It is an ADDITIONAL bit, never a replacement — an occluder still has layer 0
 * enabled and renders normally. The one thing to know about it is that
 * `mesh.layers.mask` is part of the static batching key, so the tag is written
 * on a dirty flag and not per frame; flipping it every frame would rebuild
 * every batch in the scene, every frame.
 */
export const OCCLUDER_LAYER = 29;

/**
 * Layer for meshes whose material sits in GI's MIRROR roughness bucket
 * (`giRoughnessBucketOf` 0 or 3 — see `src/modules/gi/giLight.js`).
 *
 * Exists so the exact-reflection BVH prepass can be SPARSE. That pass used to
 * fire one BVH ray for every gbuffer pixel, whether or not any reflective
 * surface was on screen; tagging the mirror meshes lets a second, tiny gbuffer
 * render mark exactly the pixels that will ever consume a reflection, and the
 * compute pass skips the rest (`giScreen.js` `createGiBvhReflect`).
 *
 * Same rules as `OCCLUDER_LAYER`, and for the same reason: it is an ADDITIONAL
 * bit (the mesh keeps layer 0 and renders normally), and `mesh.layers.mask` is
 * part of the static batching key — so GISystem writes it only when a
 * material's bucket actually changes, never per frame.
 */
export const GI_MIRROR_LAYER = 28;

/**
 * Layer for UI meshes (`components/ui/*`).
 *
 * UI used to share bit 30 with {@link DEBUG_LAYER}, which was a real bug rather
 * than a tidy coincidence: every game camera and the editor camera enable the
 * debug layer, so UI quads were already being drawn by the main scene pass —
 * while `UiSystem` ALSO drew them in a second full `renderer.render()` of its
 * own. That second pass roughly doubled frame time (see
 * `scripts/run-ui-perf.mjs`) to produce pixels the main pass had already
 * produced. It also meant UI leaked into every consumer that treats "not the
 * editor layer" as "part of the world": GI voxelization and the occlusion
 * depth pass both swallowed HUD quads sitting at pixel-scale world
 * coordinates.
 *
 * UI now renders in the main pass and nowhere else. A camera that should show
 * UI enables this bit explicitly (`CameraComponent`, the editor orbit camera);
 * every auxiliary pass leaves it off, which is what keeps a HUD out of shadow
 * maps, GI, occlusion and reflections.
 */
export const UI_LAYER = 27;

/**
 * Layers the editor's selection outline stamps on the selected meshes for the
 * duration of its mask pass (`editor/selectionOutline.js`) — one bit for the
 * selection, one for the active object, which is drawn in a lighter colour.
 *
 * Unlike every other layer here these are TRANSIENT: the pass overwrites
 * `mesh.layers.mask` outright (so the camera sees the selection and nothing
 * else) and restores it before returning, inside one synchronous block. That
 * is not tidiness — `mesh.layers.mask` is part of the static batching key, so a
 * bit left set until the next rebuild would silently pull a selected mesh out
 * of its batch, and a bit copied onto a batch proxy (`instanced.layers.mask =
 * template.layers.mask`) would drag a thousand unselected crates into the
 * outline. Nothing outside that block should ever see these bits set.
 */
export const SELECTION_MASK_LAYER = 26;
export const SELECTION_ACTIVE_LAYER = 25;

/**
 * Layer for the postprocess editor-overlay pass's DEPTH SEED quad
 * (`PostprocessComponent`): a fullscreen quad that copies the scene pass's
 * depth into the overlay pass's depth attachment so editor helpers occlude
 * against real scene geometry inside a PP-owned frame.
 *
 * A private bit rather than EDITOR_LAYER because the quad must render ONLY in
 * that one pass — on a direct frame the editor camera sees EDITOR_LAYER, and
 * a depth-stomping fullscreen quad there would overwrite the live depth
 * buffer for everything drawn after it.
 */
export const PP_OVERLAY_SEED_LAYER = 24;