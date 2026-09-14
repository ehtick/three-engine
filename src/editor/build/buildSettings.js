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
    label: "Web (zip)",
    hint: "The same folder, zipped with index.html at the root — ready to upload to any static host. The itch.io module's Publish tab builds this and opens your itch.io dashboard for you.",
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
  // Which scenes ship. null (the default) = the start scene plus every scene
  // the game can reach from it — one a shipped script, prefab or event names by
  // path (`engine.loadScene("scenes/Level2.scene")`), discovered during the
  // build the same way assets are; a `.scene` flagged Preload always ships.
  // "all" = every .scene in the project. An array is an explicit allow-list of
  // project-relative paths.
  scenes: null,
  target: "web",
  // See QUALITY_PRESETS in engine/sceneSettings.js. A ceiling, never a raise.
  quality: "ultra",
  // The ceiling a PHONE or TABLET gets instead, or "same" for the one above.
  // Off by default: a lower preset forces dynamic resolution on and the
  // player looks it (2026-09-11) — it is the author's call, per build.
  mobileQuality: "same",
  // Project-relative image used as the page favicon, the loading-screen logo
  // and the desktop app icon.
  icon: "",
  // Build-time compression. Both are gated on their module being enabled —
  // a toggle that silently does nothing is worse than a disabled one.
  compressTextures: false,
  compressModels: false,
  // Ship only the runtime chunks this game can reach — the player template is
  // code-split, and a game without physics has no reason to carry Rapier. Off
  // copies the whole template (the escape hatch if a trimmed build ever fails
  // to load something). See build/runtimeFiles.js.
  trimRuntime: true,
  // Boot/loading screen. Baked into index.html at export, not read from the
  // scene: the loading screen is on screen *before* scene.json is fetched, so
  // anything driven from the scene would flash the default colours first.
  loading: {
    background: "#0d0e11",
    accent: "#0a84ff",
    showTitle: true,
    showLogo: true,
  },
  // Cloudflare Pages project the Publish button uploads to; the game is served
  // at https://<name>.pages.dev. Empty derives the name from the project name.
  pagesProject: "",
};

/**
 * A valid Cloudflare Pages project name, or "" if nothing survives:
 * lowercase letters, digits and hyphens, no leading/trailing hyphen, at most
 * 58 characters. The name is also the public subdomain (<name>.pages.dev),
 * which is why it is derived rather than passed through — "My Game!" must
 * become "my-game", not an API error at the end of a full build+upload.
 */
export function sanitizePagesProject(raw) {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 58)
    .replace(/-+$/g, "");
}

/** The Pages project name a publish will actually use. */
export function resolvePagesProject({ build, projectName } = {}) {
  return sanitizePagesProject(build?.pagesProject) || sanitizePagesProject(projectName) || "my-game";
}

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
 * Returns `{ startScene, scenes, warnings, mode }`. `scenes` always contains
 * `startScene` first: a scene list that omits the scene the build boots into
 * produces a build that loads a black screen and logs a 404, which is a
 * miserable thing to debug an hour before a deadline. Trimming it back in is
 * cheaper than explaining it.
 *
 * `mode` is "reachable" (the default: `scenes` is the seed — the start scene —
 * and the exporter adds every scene shipped content names, see
 * `findSceneReferences`), "all", or "list" (an explicit allow-list).
 */
export function resolveBuildScenes({ available = [], build = BUILD_DEFAULTS, mainScene = "", openScene = "" } = {}) {
  const warnings = [];
  const all = available.map(normalizeRelPath).filter(Boolean);
  // No scenes have been discovered yet (e.g. BuildPanel's first paint, before
  // the async `listProjectAssets` effect has resolved). Emitting "not found"
  // against an empty list is a first-paint artefact, not a real fallback —
  // skip and let the next render decide once `available` is populated.
  if (!all.length) {
    return { startScene: "", scenes: [], warnings: [], mode: "reachable" };
  }
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

  let scenes;
  let mode;
  if (Array.isArray(build?.scenes)) {
    mode = "list";
    const wanted = build.scenes.map(normalizeRelPath).filter(Boolean);
    const missing = wanted.filter((p) => !exists(p));
    for (const p of missing) warnings.push(`Scene "${p}" is in the build list but no longer exists.`);
    scenes = wanted.filter(exists).map(canonical);
    if (startScene && !scenes.some((s) => samePath(s, startScene))) {
      scenes.unshift(startScene);
      warnings.push(`Start scene "${startScene}" was not in the build list — added.`);
    }
  } else if (build?.scenes === "all") {
    mode = "all";
    scenes = [...all];
  } else {
    // The seed of the reachable set; the exporter grows it as it walks.
    mode = "reachable";
    scenes = [];
  }

  // Start scene first, then the rest in project order. Order is cosmetic in
  // the output but it makes the build report readable.
  scenes = [
    ...(startScene ? [startScene] : []),
    ...scenes.filter((s) => !samePath(s, startScene)),
  ];

  return { startScene, scenes, warnings, mode };
}

/**
 * Every project scene named in `text` — a scene's JSON, a prefab def, a
 * script's source — as the project spells it. A game can only reach a scene
 * by its path (`engine.loadScene("scenes/Level2.scene")`, an event action's
 * `path`), so a quoted string ending in `.scene` is the whole evidence;
 * absolute authoring paths under `root` count too. Order of first mention.
 */
export function findSceneReferences(text, { available = [], root = "" } = {}) {
  const canonical = new Map(available.map((p) => [normalizeRelPath(p).toLowerCase(), normalizeRelPath(p)]));
  const found = [];
  const seen = new Set();
  for (const match of String(text ?? "").matchAll(/(['"`])([^'"`\r\n]*\.scene)\1/gi)) {
    // JSON and source both write a Windows backslash as two characters.
    const raw = match[2].replaceAll("\\\\", "\\");
    const rel = root ? toProjectRelative(root, raw) : normalizeRelPath(raw);
    const key = normalizeRelPath(rel).toLowerCase();
    const spelled = canonical.get(key);
    if (!spelled || seen.has(key)) continue;
    seen.add(key);
    found.push(spelled);
  }
  return found;
}

/** Reads the shipped-scenes decision back out for display. */
export function describeSceneSelection(build, availableCount) {
  if (Array.isArray(build?.scenes)) return `${build.scenes.length} of ${availableCount} scenes`;
  if (build?.scenes === "all") return `All ${availableCount} scene${availableCount === 1 ? "" : "s"}`;
  return "The start scene + what it reaches";
}
