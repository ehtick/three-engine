import { vmSingleton } from "./singleton.js";

/**
 * "Open the Texture Editor and start a new document."
 *
 * A plain `window.dispatchEvent` loses the request when the panel is opened by
 * the same click: the panel is lazy-loaded, so it mounts a tick or two after
 * `openPanel` returns and there is nobody listening yet. The flag is latched
 * instead, and the panel drains it on mount as well as listening for later
 * requests — so the Assets panel's "New Texture" works whether the editor tab
 * was already open or not.
 *
 * VM-wide for the reason described in `singleton.js`: Vite can evaluate this
 * module more than once, and a per-copy `let` would let the setter and the
 * reader end up on different objects.
 */
const state = vmSingleton("textureEditorRequest", () => ({ pendingNew: false }));

export const NEW_TEXTURE_EVENT = "texture-editor-new";

export function requestNewTexture() {
  state.pendingNew = true;
  window.dispatchEvent(new CustomEvent(NEW_TEXTURE_EVENT));
}

/** True once per request; the panel calls this on mount. */
export function consumeNewTextureRequest() {
  const pending = state.pendingNew;
  state.pendingNew = false;
  return pending;
}
