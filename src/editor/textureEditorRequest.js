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

/**
 * "Pack these images into an atlas."
 *
 * Raised by the Assets panel's context menu, which is a component with no state
 * of its own that survives its own closing — so the request travels to the
 * panel that renders the dialog rather than the menu trying to own it.
 */
export const PACK_ATLAS_EVENT = "texture-editor-pack-atlas";

export function requestPackAtlas(paths) {
  state.pendingPack = [...paths];
  window.dispatchEvent(new CustomEvent(PACK_ATLAS_EVENT));
}

export function consumePackAtlasRequest() {
  const pending = state.pendingPack ?? null;
  state.pendingPack = null;
  return pending;
}

/**
 * "Use this font for the Text tool."
 *
 * Latched the same way, for the same reason — the Inspector's font action opens
 * the Texture Editor and sets the font in one click, and the panel may not
 * exist yet when it does. Unlike the two above this one is *not* consumed: the
 * chosen font is a persistent tool setting, and re-reading it on mount is how
 * the Text tool remembers what you last drew with.
 */
export const TEXT_FONT_EVENT = "texture-editor-text-font";

export function setTextToolFont(path) {
  state.textFont = path ?? "";
  window.dispatchEvent(new CustomEvent(TEXT_FONT_EVENT, { detail: path ?? "" }));
}

export function currentTextToolFont() {
  return state.textFont ?? "";
}
