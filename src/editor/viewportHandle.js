import { vmSingleton } from "./singleton.js";

/**
 * A published handle onto the live viewport (camera, orbit controls, canvas).
 *
 * `ViewportPanel.jsx` owns that state in a module-level object, and two things
 * need to reach it from outside: the editor API's viewport ops (screenshot,
 * aim the camera, frame an entity) and test harnesses. Neither should
 * `import("./panels/ViewportPanel.jsx")` to get there — that module pulls in
 * three/webgpu, OrbitControls, TransformControls and the whole gizmo stack, so
 * importing it from an op would drag the renderer into any graph that merely
 * wants to know where the camera is.
 *
 * The panel used to expose the same object as `globalThis.__viewport` under an
 * `import.meta.env.DEV` guard. That is fine for a harness and wrong for a
 * feature: the MCP screenshot tool has to work in a packaged build too.
 *
 * Same slot pattern as `editorBridge.js`, and VM-wide for the reason in
 * `singleton.js` — a hot reload that re-evaluated this file would otherwise
 * leave the ops looking at an empty slot while the panel filled the other copy.
 */
const slot = vmSingleton("viewportHandle", () => ({ handle: null }));

/** Called by ViewportPanel once its camera and controls exist. */
export function setViewportHandle(handle) {
  slot.handle = handle ?? null;
}

/** The live viewport, or null when no viewport panel is mounted. */
export function getViewportHandle() {
  return slot.handle;
}

/** True when there is a camera to render from. */
export function hasViewport() {
  return !!slot.handle?.camera;
}
