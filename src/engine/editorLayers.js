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