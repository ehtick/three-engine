/**
 * "Open this file in whatever the OS uses for it."
 *
 * Three places want it — the Assets panel (double-click / context menu), the
 * Asset Inspector's "Open in IDE" button, and the Scripts component slot's Edit
 * button — and they had two copies of the same three lines between them. One
 * helper keeps the error reporting identical wherever it's triggered from, and
 * gives us a single place to swap in a configurable editor command later.
 *
 * `openPath` is imported lazily: `@tauri-apps/plugin-opener` is only meaningful
 * inside the desktop shell, and pulling it into the boot graph for a button
 * most sessions never press is not worth the bytes.
 */
export async function openInIDE(path) {
  if (!path) return false;
  try {
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(path);
    return true;
  } catch (err) {
    console.error(`Failed to open "${path}": ${err}`);
    return false;
  }
}
