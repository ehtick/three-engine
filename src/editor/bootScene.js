/**
 * Which scene THIS boot should open — pure, so the editor's boot-time scene
 * loader (`sceneIO.js`'s `restoreLastScene`) and its renderer-settings
 * pre-read (`peekBootRendererSettings`) resolve the exact same decision
 * through the exact same code, in the exact same order, and can never
 * disagree about what the boot is opening.
 *
 * PRIORITY, in this order — never any other:
 *   1. `reopenRequest.scene` — the exact scene `editor.reload` stashed just
 *      before reloading the page (see `startupReopen.js`'s
 *      `stashReopenTarget`). It is more current than anything on disk:
 *      project.json's own `lastScene` is only as fresh as the last
 *      `rememberScene()` write, which is fired but not awaited, so it can
 *      still be in flight when a reload lands a moment later.
 *   2. `projectMeta.lastScene` — what the editor had open, written on every
 *      scene open/save. "Reopen what I had open" is the right default for an
 *      editor (as opposed to a shipped build, which always starts at
 *      `mainScene` — see `resolveBuildScenes` in `build/buildSettings.js`,
 *      which is unrelated to this and never reads this function).
 *   3. `projectMeta.mainScene` — the project's declared entry point, tried
 *      only once nothing else is known (no reload handoff, nothing ever
 *      opened in this project before).
 *
 * NEVER mainScene before lastScene, and never a "try mainScene, notice it
 * was wrong, then load lastScene on top of it" two-step: a boot that fully
 * deserializes one scene (assets, GI build, shader compiles) only to
 * immediately discard it for the RIGHT one is exactly the double load this
 * function exists to prevent. Every boot-time caller that decides which
 * scene to open must resolve it through this function, once, before
 * touching disk.
 *
 * Deliberately store/disk/engine-free — this is the function a Node test
 * exercises directly, with no project, no engine, no Tauri.
 *
 * @param {{lastScene?: string | null, mainScene?: string | null} | null | undefined} projectMeta
 * @param {{scene?: string | null} | null | undefined} reopenRequest
 * @returns {string | null} the winning path, exactly as stored (relative to
 *   the project root, or already absolute) — resolving it against the
 *   project root is the caller's job.
 */
export function resolveBootScene(projectMeta, reopenRequest) {
  if (reopenRequest?.scene) return reopenRequest.scene;
  const meta = projectMeta ?? {};
  return meta.lastScene || meta.mainScene || null;
}
