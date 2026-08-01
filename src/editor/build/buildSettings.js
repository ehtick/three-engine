/**
 * What a build *is* — the settings the exporter reads, and the pure functions
 * that turn them into a concrete plan (which scene boots, which scenes ship).
 *
 * Kept free of React, Tauri and the engine so `npm run test:build` can exercise
 * the decisions that actually go wrong in a build — which scene boots, what
 * happens when the start scene isn't in the scene list — without a browser.
 */

export const BUILD_TARGETS = {
  web: {
    label: "Web (folder)",
    hint: "A folder to drop on any static host. Needs a server — module scripts don't run over file://.",
  },
  zip: {
    label: "Web (zip, itch.io)",
    hint: "The same folder, zipped with index.html at the root — the layout itch.io expects.",
  },
  desktop: {
    label: "Desktop (Tauri project)",
    hint: "The web build plus a Tauri project that packages it into a native app. Needs Rust to compile.",
  },
};

export const BUILD_DEFAULTS = {
  // Project-relative path of the scene the build boots into. Empty falls back
  // to the project's main scene, then to whatever is open in the editor.
  startScene: "",
  // null = ship every .scene in the project (the right default until someone
  // has a reason to trim). An array is an explicit allow-list of
  // project-relative paths.
  scenes: null,
  target: "web",
  // See QUALITY_PRESETS in engine/sceneSettings.js. A ceiling, never a raise.
  quality: "ultra",
  // Project-relative image used as the page favicon, the loading-screen logo
  // and the desktop app icon.
  icon: "",
  // Build-time compression. Both are gated on their module being enabled —
  // a toggle that silently does nothing is worse than a disabled one.
  compressTextures: false,
  compressModels: false,
  // Boot/loading screen. Baked into index.html at export, not read from the
  // scene: the loading screen is on screen *before* scene.json is fetched, so
  // anything driven from the scene would flash the default colours first.
  loading: {
    background: "#0d0e11",
    accent: "#0a84ff",
    showTitle: true,
    showLogo: true,
  },
};

/** Forward slashes, no leading `./` or `/`, no trailing slash. */
export function normalizeRelPath(raw) {
  if (!raw) return "";
  let p = String(raw).replaceAll("\\", "/").trim();
  while (p.startsWith("./")) p = p.slice(2);
  while (p.startsWith("/")) p = p.slice(1);
  while (p.endsWith("/") && p.length > 1) p = p.slice(0, -1);
  return p;
}

/** Project-relative form of an absolute path inside `root`, else the input. */
export function toProjectRelative(root, absPath) {
  if (!root || !absPath) return normalizeRelPath(absPath);
  const r = normalizeRelPath(root);
  const p = String(absPath).replaceAll("\\", "/");
  return p.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? p.slice(r.length + 1) : normalizeRelPath(absPath);
}

const samePath = (a, b) => !!a && !!b && normalizeRelPath(a).toLowerCase() === normalizeRelPath(b).toLowerCase();

/**
 * Decides what actually ships.
 *
 * @param available  every project-relative `.scene` path found in the project
 * @param build      the `build` settings section
 * @param mainScene  project.json's `mainScene` (the editor's boot scene)
 * @param openScene  project-relative path of the scene open in the editor
 *
 * Returns `{ startScene, scenes, warnings }`. `scenes` always contains
 * `startScene` first: a scene list that omits the scene the build boots into
 * produces a build that loads a black screen and logs a 404, which is a
 * miserable thing to debug an hour before a deadline. Trimming it back in is
 * cheaper than explaining it.
 */
export function resolveBuildScenes({ available = [], build = BUILD_DEFAULTS, mainScene = "", openScene = "" } = {}) {
  const warnings = [];
  const all = available.map(normalizeRelPath).filter(Boolean);
  const exists = (p) => all.some((s) => samePath(s, p));
  const canonical = (p) => all.find((s) => samePath(s, p)) ?? normalizeRelPath(p);

  // Start scene: the explicit choice, else the project's main scene, else
  // whatever is open — the same fallback chain the editor's own boot uses, so
  // "Export" with nothing configured does the obvious thing.
  let startScene = "";
  for (const candidate of [build?.startScene, mainScene, openScene]) {
    const p = normalizeRelPath(candidate);
    if (!p) continue;
    if (exists(p)) {
      startScene = canonical(p);
      break;
    }
    // Only complain about a *configured* start scene that has gone missing.
    // A stale `mainScene` is the project's business, not the build's.
    if (samePath(p, build?.startScene)) {
      warnings.push(`Start scene "${p}" was not found in the project — falling back.`);
    }
  }
  if (!startScene && all.length) {
    startScene = all[0];
    warnings.push(`No start scene configured — booting into "${startScene}".`);
  }

  // Scene list: null means everything.
  let scenes;
  if (Array.isArray(build?.scenes)) {
    const wanted = build.scenes.map(normalizeRelPath).filter(Boolean);
    const missing = wanted.filter((p) => !exists(p));
    for (const p of missing) warnings.push(`Scene "${p}" is in the build list but no longer exists.`);
    scenes = wanted.filter(exists).map(canonical);
    if (startScene && !scenes.some((s) => samePath(s, startScene))) {
      scenes.unshift(startScene);
      warnings.push(`Start scene "${startScene}" was not in the build list — added.`);
    }
  } else {
    scenes = [...all];
  }

  // Start scene first, then the rest in project order. Order is cosmetic in
  // the output but it makes the build report readable.
  scenes = [
    ...(startScene ? [startScene] : []),
    ...scenes.filter((s) => !samePath(s, startScene)),
  ];

  return { startScene, scenes, warnings };
}

/** Reads the shipped-scenes decision back out for display. */
export function describeSceneSelection(build, availableCount) {
  if (!Array.isArray(build?.scenes)) return `All ${availableCount} scene${availableCount === 1 ? "" : "s"}`;
  return `${build.scenes.length} of ${availableCount} scenes`;
}
