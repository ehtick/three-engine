import { exportGame } from "./exportGame.js";
import { useProjectStore } from "./store/projectStore.js";
import { getProjectSettings } from "./projectSettings.js";
import { resolvePagesProject } from "./build/buildSettings.js";

/**
 * Builds the web target and uploads it to Cloudflare Pages, returning
 * `{ url, deploymentUrl, project, report }` (or null if the build was
 * cancelled). The stable URL is `https://<project>.pages.dev`; the game stays
 * up when this machine is off, which is the difference between this and the
 * share tunnel.
 *
 * Auth is wrangler's own OAuth. The deploy is attempted first and retried
 * once after `pages_login` if the failure was auth-shaped — so the happy path
 * after the first publish never pays a login round-trip.
 */
export async function publishToPages({ onProgress } = {}) {
  const root = useProjectStore.getState().rootPath;
  if (!root) throw new Error("Open a project before publishing.");
  const projectName = useProjectStore.getState().projectMeta?.name;
  const project = resolvePagesProject({ build: getProjectSettings().build, projectName });

  const { invoke } = await import("@tauri-apps/api/core");
  // fresh: what gets uploaded is exactly what this build produces — a reused
  // folder would ship (and size-check) orphans of assets deleted since the
  // last publish.
  const outDir = await invoke("prepare_browser_preview", {
    projectRoot: root,
    purpose: "publish",
    fresh: true,
  });
  // Always the web target, whatever the release target is set to — Pages
  // hosts a folder. livePreview must stay off: the injected reload client
  // would poll a __preview_revision.json that a published site never has.
  const report = await exportGame({
    outDir,
    onProgress,
    buildOverride: { target: "web", livePreview: false, includeDerivedData: true },
  });
  if (!report.ok) {
    if (report.cancelled) return null;
    throw new Error(report.error || "unknown build error");
  }

  onProgress?.({ phase: "publish", message: `Uploading to ${project}.pages.dev…` });
  let outcome = await invoke("pages_deploy", { dir: report.contentDir, project });
  if (outcome.status === "needsLogin") {
    onProgress?.({
      phase: "publish",
      message: "Log in to Cloudflare in the browser window that just opened…",
    });
    await invoke("pages_login");
    onProgress?.({ phase: "publish", message: `Uploading to ${project}.pages.dev…` });
    outcome = await invoke("pages_deploy", { dir: report.contentDir, project });
    if (outcome.status === "needsLogin") {
      throw new Error("Cloudflare login did not complete — try publishing again.");
    }
  }
  return { url: outcome.url, deploymentUrl: outcome.deploymentUrl, project, report };
}
