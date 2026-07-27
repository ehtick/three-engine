/**
 * Runtime module exposed to user scripts as `import ... from "editor"`.
 *
 * Everything here is a re-export of `editorBridge.js` — see that file for why
 * the editor API is reached through a slot instead of imported directly. The
 * proxy exists for the same reason `threeRuntime.js` does: a script is imported
 * from a `blob:` URL, which cannot resolve a bare specifier or a relative path,
 * so `scriptRuntime.js` rewrites `"editor"` to this module's real URL, learned
 * from the `__SELF_URL__` below.
 *
 * Importing `"editor"` is always safe, including in a shipped game. It is
 * *calling* `Editor.*` outside the editor that throws, and `isEditor()` is
 * there to branch on. That split is deliberate: a script that draws gizmos
 * while authoring and does nothing at runtime should not need two files.
 */
export {
  Editor,
  isEditor,
  hasEditorApi,
  executeInEditMode,
  menuItem,
  registerMenuItem,
} from "../editorBridge.js";

/** This module's own absolute URL — see `threeRuntime.js` for why. */
export const __SELF_URL__ = import.meta.url;
