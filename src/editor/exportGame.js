import { ensureEngine } from "./engineInstance.js";
import { createAssetNames, basename } from "./build/assetNames.js";
import { rewriteComponentAssets } from "./build/assetRefs.js";
import { BUILD_DEFAULTS, resolveBuildScenes, normalizeRelPath, toProjectRelative } from "./build/buildSettings.js";
import { themePlayerHtml, injectLivePreviewClient, PREVIEW_REVISION_PATH } from "./build/playerHtml.js";
import { desktopScaffoldFiles } from "./build/desktopScaffold.js";

/**
 * Builds the project into a standalone, playable game: the prebuilt player
 * template (dist-player/, from `npm run build:player`), the scenes chosen in
 * Build Settings, and every asset they reference, with all paths rewritten to
 * be build-relative.
 *
 * Three targets, one pipeline. `web` is a folder for any static host, `zip` is
 * the same folder archived with index.html at the root (what itch.io expects),
 * and `desktop` puts the web build under `web/` next to a generated Tauri
 * project that packages it. Nothing about the game differs between them — the
 * difference is purely how it is delivered.
 */
export async function exportGame(options = {}) {
  const report = await runExport(options);
  if (report.ok) {
    console.log(
      `Build complete → ${report.outDir}\n` +
        `  ${report.sceneCount} scene(s), ${report.assetCount} asset file(s)` +
        `${report.preloadCount ? `, ${report.preloadCount} preloaded` : ""}` +
        `${report.savedBytes ? `, ${formatBytes(report.savedBytes)} saved by compression` : ""}`,
    );
    for (const warning of report.warnings) console.warn(`Build: ${warning}`);
  } else if (report.error) {
    console.error(`Build failed: ${report.error}`);
  }
  return report;
}

/** Human-readable byte size. */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

const noop = () => {};

/**
 * Build for the menu / Ctrl+B path, which has no panel to render a result
 * into. Toasts are that path's only feedback — without them a failed build
 * is invisible anywhere but the Console.
 */
export async function exportGameWithToasts() {
  const { pushToast, dismissToastKey } = await import("./toasts.js");
  const report = await exportGame({
    onProgress: ({ message }) =>
      pushToast({ level: "info", title: "Building…", detail: message, key: "menu-build", timeoutMs: 60000 }),
  });
  if (report.cancelled) {
    dismissToastKey("menu-build");
  } else if (!report.ok) {
    pushToast({ level: "error", title: "Build failed", detail: report.error, key: "menu-build" });
  } else {
    const warned = report.warnings?.length
      ? ` (${report.warnings.length} warning${report.warnings.length === 1 ? "" : "s"} — see Console)`
      : "";
    pushToast({
      level: "info",
      title: `Build finished${warned}`,
      detail: report.zipPath ?? report.outDir,
      key: "menu-build",
    });
  }
  return report;
}

async function runExport({ outDir: presetOut, onProgress = noop, buildOverride = {} } = {}) {
  const warnings = [];
  const fail = (error) => ({ ok: false, error, warnings });

  const outDir = presetOut ?? (await pickOutputDirectory());
  if (!outDir) return { ok: false, cancelled: true, warnings };

  const { invoke } = await import("@tauri-apps/api/core");
  const readRequiredText = async (path, kind) => {
    try {
      return await invoke("read_text_file", { path });
    } catch (error) {
      // Older preview attempts could leak the generated `assets/Foo.js` path
      // into a live script slot. Recover that one known shape from the normal
      // authoring location without hiding arbitrary missing-file mistakes.
      if (kind === "script" && root) {
        const normalized = String(path).replaceAll("\\", "/");
        const generated = normalized.match(/\/assets\/([^/]+)\.js$/i);
        if (generated) {
          for (const ext of ["ts", "js"]) {
            const candidate = joinPath(root, `scripts/${generated[1]}.${ext}`);
            try {
              const contents = await invoke("read_text_file", { path: candidate });
              warnings.push(`Recovered stale script reference ${path} from ${candidate}.`);
              return contents;
            } catch {
              // Try the other authoring extension before reporting the
              // original, more useful missing-path error below.
            }
          }
        }
      }
      throw new Error(
        `Could not read referenced ${kind} at ${path}: ${error?.message ?? String(error)}`,
      );
    }
  };
  const engine = await ensureEngine();
  const { serializeScene, prefabRegistry, getComponentClass } = await import("../engine/index.js");
  const { getProjectSettings } = await import("./projectSettings.js");
  const { useProjectStore } = await import("./store/projectStore.js");
  const { useModulesStore } = await import("./modules.js");
  const { listProjectAssets, transpileScript } = await import("./assetLoader.js");
  const { currentScenePath } = await import("./sceneIO.js");

  const projectSettings = getProjectSettings();
  const build = { ...BUILD_DEFAULTS, ...(projectSettings.build ?? {}), ...buildOverride };
  const meta = useProjectStore.getState();
  const root = meta.rootPath;
  const title =
    projectSettings.game.title || meta.projectMeta?.name || basename(meta.rootPath ?? "Game");

  // Both non-plain targets nest the game rather than filling the chosen folder,
  // and for the same reason: something has to sit *beside* the build without
  // being swept into it. `desktop` puts the Tauri project there; `zip` puts the
  // archive there, which otherwise ends up inside the very folder it is
  // archiving.
  const isDesktop = build.target === "desktop";
  const isZip = build.target === "zip";
  const folderName = sanitizeFileName(title);
  const contentDir = isDesktop
    ? joinPath(outDir, "web")
    : isZip
      ? joinPath(outDir, folderName)
      : outDir;

  onProgress({ phase: "scenes", message: "Resolving scenes…" });
  const openScenePath = currentScenePath();
  const openRel = root && openScenePath ? toProjectRelative(root, openScenePath) : "";
  const available = root
    ? (await listProjectAssets(root, ["scene"], 8)).map((abs) => toProjectRelative(root, abs))
    : [];
  const plan = resolveBuildScenes({
    available,
    build,
    mainScene: meta.projectMeta?.mainScene ?? "",
    openScene: openRel,
  });
  warnings.push(...plan.warnings);
  if (!plan.startScene) return fail("No scene to build — save a scene first.");

  const samePath = (a, b) =>
    !!a && !!b && normalizeRelPath(a).toLowerCase() === normalizeRelPath(b).toLowerCase();
  /**
   * The scene JSON to ship for one project-relative path. The scene open in
   * the editor is serialized live rather than read off disk: exporting is the
   * one moment where "what I'm looking at" and "what ships" diverging is
   * unforgivable, and unsaved edits are the normal state of an editor.
   */
  const readScene = async (rel, { embedPrefabs = false } = {}) => {
    if (samePath(rel, openRel)) {
      // Component.toJSON() intentionally makes a cheap shallow props copy, but
      // build rewriting changes nested values such as script slot paths. Give
      // the exporter a fully detached snapshot so generated `assets/*.js`
      // paths can never leak back into the live editor scene.
      return structuredClone(serializeScene(engine, { embedPrefabs }));
    }
    const json = JSON.parse(await invoke("load_scene", { path: joinPath(root, rel) }));
    // Prefab definitions live in the registry, not in each scene file. The
    // start scene carries them for the whole build, so a level that isn't open
    // still resolves its instances by guid.
    if (embedPrefabs) json.prefabs = structuredClone(prefabRegistry.all());
    return json;
  };

  // --- Asset collection ------------------------------------------------------
  const names = createAssetNames();
  const scriptPaths = new Set(); // ship transpiled, not copied
  const materialPaths = new Set(); // .mat files ship with rewritten texture paths
  const cubemapPaths = new Set(); // .cubemap files ship with rewritten face paths
  const audioSidecarPaths = new Set(); // .audio JSON, copied with path rewrites
  const timelinePaths = new Set(); // .timeline files ship with rewritten clip paths
  const atlasPaths = new Set(); // .atlas files ship with a rewritten image path
  // Saved scenes deliberately use project-relative paths so projects remain
  // portable. Runtime asset loading resolves those paths against `root`; the
  // exporter must do the same before handing sources to native filesystem IPC.
  const sourcePath = (p) => {
    if (!p || typeof p !== "string") return p;
    return /^([a-zA-Z]:[\\/]|[\\/]{2}|\/)/.test(p) || !root ? p : joinPath(root, p);
  };
  const claim = (p) => names.claim(sourcePath(p));
  /** Documents we re-emit rather than copy still need a unique destination. */
  const claimDoc = (p, rename) =>
    names.claimGenerated(sourcePath(p), rename ? { rename } : undefined);

  /**
   * A script can hold a prefab reference as a plain path string (that's what
   * the inspector's prefab field stores). Paths don't survive the trip into a
   * build, so swap them for the prefab's guid — which is stable and is what the
   * player's registry is keyed by. `engine.instantiate` accepts either.
   */
  const toPrefabGuid = (value) => {
    if (typeof value !== "string") return value;
    return prefabRegistry.guidForPath(value) ?? value;
  };
  const rewritePrefabRefs = (props) => {
    for (const [key, value] of Object.entries(props ?? {})) {
      if (typeof value === "string") props[key] = toPrefabGuid(value);
    }
  };

  // Where each re-emitted document's SOURCE is collected, per assetRefs kind.
  const documentBuckets = {
    material: materialPaths,
    atlas: atlasPaths,
    timeline: timelinePaths,
    audio: audioSidecarPaths,
    script: scriptPaths,
  };
  /**
   * Schema-driven, same as the runtime's `collectSceneAssets`: every component
   * schema field of `type: "asset"` ships, the day the component is added. The
   * hand-maintained ladder this replaces fell behind the component roster —
   * Sprite/UiImage/Decal/Line/Trail textures, Instancer and SplineMesh material
   * overrides, a mesh's material2…8 and UiText fonts all reached the browser
   * as absolute authoring paths that no server will serve.
   */
  const visitComponent = (c) => {
    rewritePrefabRefs(c.props);
    rewriteComponentAssets(c, {
      getSchema: (type) => getComponentClass(type)?.schema,
      claim,
      claimDoc,
      add: (kind, p) => documentBuckets[kind]?.add(sourcePath(p)),
    });
  };

  /**
   * One walker for both shapes, because they *are* one shape: a scene entity, a
   * prefab node and an added-entity override all carry components + children,
   * and a prefab instance (in a scene or nested in a prefab) carries overrides
   * whose payloads are components and subtrees in turn.
   */
  const visitOverride = (ov) => {
    if (ov.k === "prop") {
      const shim = { type: ov.c, props: { [ov.key]: ov.v } };
      visitComponent(shim);
      ov.v = shim.props[ov.key];
    } else if (ov.k === "addComponent") {
      visitComponent({ type: ov.c, props: ov.v });
    } else if (ov.k === "addEntity") {
      visit(ov.v);
    }
  };
  const visit = (node) => {
    // Instances resolve by guid in a build; the authoring path is a local
    // absolute path and has no business shipping.
    if (node.prefab) delete node.prefab.path;
    for (const c of node.components ?? []) visitComponent(c);
    for (const ov of node.overrides ?? []) visitOverride(ov);
    (node.children ?? []).forEach(visit);
  };

  const rewriteScene = (sceneJson) => {
    // Scene settings can reference a .cubemap (skybox / image-based lighting).
    // It ships like a .mat: the descriptor is rewritten, its faces are copied.
    if (sceneJson.settings?.environment?.cubemap) {
      const src = sceneJson.settings.environment.cubemap;
      cubemapPaths.add(sourcePath(src));
      sceneJson.settings.environment.cubemap = claimDoc(src);
    }
    (sceneJson.entities ?? []).forEach(visit);
    for (const def of sceneJson.prefabs ?? []) {
      if (def.root) visit(def.root);
      for (const ov of def.overrides ?? []) visitOverride(ov); // variants
      // The registry in the build is keyed by guid; drop the authoring path so
      // a machine-specific absolute path doesn't ship inside the bundle.
      delete def.path;
    }
  };

  try {
    // --- The start scene, which is also the build's config carrier ----------
    const scene = await readScene(plan.startScene, { embedPrefabs: true });
    scene.player = {
      title,
      pixelRatioCap: projectSettings.rendering.pixelRatioCap,
      // A ceiling over each scene's authored performance block. See
      // QUALITY_PRESETS in engine/sceneSettings.js.
      quality: build.quality ?? "ultra",
      // Saves: the namespace keeps two games on one origin (an itch.io page, a
      // shared dev server) from reading each other's slots, and must be derived
      // exactly as `applyProjectSettings` does it or a save written while
      // testing in the editor would be invisible to the build.
      saveId: projectSettings.game.saveId || title,
      saveVersion: projectSettings.game.saveVersion ?? 1,
      // Which project-relative path scene.json is a copy of, so a script can
      // tell "am I in the first level" without hard-coding the name.
      startScene: plan.startScene,
      // Tells the player runtime to expose the in-place hot-update hook the
      // injected preview client calls. Deliberately a stable flag rather than
      // a timestamp: the revision token lives ONLY in __preview_revision.json,
      // so an otherwise-unedited scene.json is byte-identical across rebuilds
      // and a material tweak doesn't read as a scene change in the manifest.
      ...(build.livePreview ? { livePreview: true } : {}),
    };
    const enabledModules = [...useModulesStore.getState().enabled];
    scene.modules = enabledModules;
    scene.input = engine.input.toJSON();
    // The collision-layer matrix is project-wide, and a build with the wrong
    // matrix has every bullet hitting the player who fired it.
    scene.physics = {
      names: projectSettings.physics.layers,
      matrix: projectSettings.physics.matrix,
    };
    rewriteScene(scene);
    // Only the start scene's assets feed the boot preload list below. Levels
    // the game loads later preload themselves, on demand.
    const startAssets = new Set(names.entries().map(([source]) => source).filter(Boolean));
    const startMaterials = new Set(materialPaths);

    const files = []; // [relativePath, contents]

    // --- Every other shipped scene, at its project-relative path -------------
    onProgress({ phase: "scenes", message: `Collecting ${plan.scenes.length} scene(s)…` });
    for (const rel of plan.scenes) {
      try {
        // The start scene ships twice — as scene.json (what the player boots)
        // and at its own path — so a script can reload the level it started in.
        // Serialized fresh so the rewrite can't touch the copy already bound
        // for scene.json.
        const json = await readScene(rel);
        rewriteScene(json);
        files.push([rel, JSON.stringify(json)]);
      } catch (err) {
        warnings.push(`Skipped scene ${rel}: ${err?.message ?? err}`);
      }
    }

    // --- Referenced documents ------------------------------------------------
    onProgress({ phase: "assets", message: "Rewriting asset references…" });
    // A referenced document that no longer exists (an asset deleted after a
    // scene started referencing it) is a warning, not a failed build — same
    // policy as the scene loop above. The runtime already tolerates the
    // resulting 404 with a default material/skipped script, and "I deleted an
    // asset and now nothing builds" is worse than either.
    for (const src of scriptPaths) {
      onProgress({ phase: "assets", message: `Reading script ${basename(src)}…` });
      try {
        const raw = await readRequiredText(src, "script");
        files.push([claimDoc(src, (name) => name.replace(/\.ts$/i, ".js")), await transpileScript(raw)]);
      } catch (err) {
        warnings.push(`Skipped script ${src}: ${err?.message ?? err}`);
      }
    }
    for (const src of materialPaths) {
      onProgress({ phase: "assets", message: `Reading material ${basename(src)}…` });
      try {
        const def = JSON.parse(await readRequiredText(src, "material"));
        if (def.map) def.map = claim(def.map);
        for (const n of def.shaderGraph?.nodes ?? []) {
          if (n.type === "texture" && n.props?.path) n.props.path = claim(n.props.path);
        }
        files.push([claimDoc(src), JSON.stringify(def)]);
      } catch (err) {
        warnings.push(`Skipped material ${src}: ${err?.message ?? err}`);
      }
    }
    const { normalizeCubemapDef, CUBEMAP_FACES } = await import("../engine/cubemapAsset.js");
    for (const src of cubemapPaths) {
      onProgress({ phase: "assets", message: `Reading cubemap ${basename(src)}…` });
      try {
        const def = normalizeCubemapDef(JSON.parse(await readRequiredText(src, "cubemap")));
        for (const { key } of CUBEMAP_FACES) {
          if (def.faces[key]) def.faces[key] = claim(def.faces[key]);
        }
        files.push([claimDoc(src), JSON.stringify(def)]);
      } catch (err) {
        warnings.push(`Skipped cubemap ${src}: ${err?.message ?? err}`);
      }
    }
    for (const src of timelinePaths) {
      onProgress({ phase: "assets", message: `Reading timeline ${basename(src)}…` });
      let def;
      try {
        def = JSON.parse(await readRequiredText(src, "timeline"));
      } catch (err) {
        warnings.push(`Skipped timeline ${src}: ${err?.message ?? err}`);
        continue;
      }
      for (const track of def.tracks ?? []) {
        if (track.kind !== "audio") continue;
        for (const clip of track.clips ?? []) {
          if (!clip.asset) continue;
          // A clip may name the `.audio` sidecar or a raw file; sidecars go
          // through the same rewrite the Sound component's entries do.
          if (/\.audio$/i.test(clip.asset)) {
            audioSidecarPaths.add(sourcePath(clip.asset));
            clip.asset = claimDoc(clip.asset);
          } else {
            clip.asset = claim(clip.asset);
          }
        }
      }
      files.push([claimDoc(src), JSON.stringify(def)]);
    }
    for (const src of atlasPaths) {
      onProgress({ phase: "assets", message: `Reading atlas ${basename(src)}…` });
      let def;
      try {
        def = JSON.parse(await readRequiredText(src, "atlas"));
      } catch (err) {
        warnings.push(`Skipped atlas ${src}: ${err?.message ?? err}`);
        continue;
      }
      if (def.image) def.image = claim(def.image);
      // `source` records where each region came from at pack time. It is an
      // authoring path into the project and has no business in a build — and
      // shipping it would drag every loose sprite along with the sheet.
      for (const region of def.regions ?? []) delete region.source;
      files.push([claimDoc(src), JSON.stringify(def)]);
    }
    for (const src of audioSidecarPaths) {
      // Sidecar may reference a sibling raw audio file (def.path) — copy that
      // and rewrite the path. When the sidecar JSON is missing or has no
      // `path`, the runtime falls back to the sidecar's own path minus its
      // `.audio` extension (handled by loadAudioAsset), so copy that too.
      let def = null;
      try {
        def = JSON.parse(await invoke("read_text_file", { path: src }));
      } catch {
        def = null;
      }
      const rawPath = sourcePath(def?.path ?? src.replace(/\.audio$/i, ""));
      let rawRel = null;
      try {
        await invoke("stat_file", { path: rawPath });
        rawRel = claim(rawPath);
      } catch {
        // Raw file missing — likely the sidecar pointed elsewhere.
      }
      if (def && def.path) def.path = rawRel ?? claim(def.path);
      const sidecarBody = def
        ? JSON.stringify(def)
        : JSON.stringify({ path: rawRel ?? basename(rawPath) });
      files.push([claimDoc(src), sidecarBody]);
    }

    // --- Build-time compression ---------------------------------------------
    // Runs before sidecar discovery so a texture compressed just now has its
    // `.basis` derivative found and shipped in the same pass.
    const compression = await compressBuildAssets({
      names,
      build,
      onProgress,
      warnings,
    });

    // --- Import-settings sidecars -------------------------------------------
    // Textures (filtering/wrap), models (virtual geometry) and geometry (GI ray
    // proxy import cache) ship their `.meta` when one exists. Sidecars follow
    // the asset's *renamed* destination — two `color.png` from different
    // folders no longer land on one name, and neither do their metas.
    const sidecarCopies = [];
    const generatedSidecarFiles = [];
    for (const [src] of names.copyEntries()) {
      if (!/\.(png|jpe?g|webp|glb|geom)$/i.test(src)) continue;
      try {
        await invoke("stat_file", { path: `${src}.meta` });
        sidecarCopies.push([`${src}.meta`, names.claimSidecar(src, ".meta")]);
        if (/\.(png|jpe?g|webp)$/i.test(src)) {
          const textureMeta = JSON.parse(await invoke("read_text_file", { path: `${src}.meta` }));
          if (textureMeta?.basis?.enabled) {
            await invoke("stat_file", { path: `${src}.basis` });
            sidecarCopies.push([`${src}.basis`, names.claimSidecar(src, ".basis")]);
          }
        }
      } catch {
        // Geometry loading probes its optional import metadata unconditionally.
        // Ship an empty object so browser previews apply defaults without a
        // noisy 404 for every mesh in a large scene.
        if (/\.geom$/i.test(src)) {
          generatedSidecarFiles.push([names.claimSidecar(src, ".meta"), "{}"]);
        }
      }
    }

    // --- Per-asset build flags ----------------------------------------------
    const { readAssetFlags } = await import("./assetFlags.js");
    const preload = [];
    const excluded = [];
    // `engine.assets.findByName`/`byTag` at runtime — one entry per shipped
    // asset, name = the AUTHORING basename (stable across a collision rename,
    // so `wood/color.png` and `stone/color.png` both search as "color.png"
    // even though only one of them keeps that exact build filename).
    const assetDefs = [];
    const flagTargets = [...names.copyEntries().map(([source]) => source), ...materialPaths];
    for (const src of flagTargets) {
      const flags = await readAssetFlags(src);
      if (flags.exclude) {
        excluded.push(names.peek(src));
        // Sidecars follow the asset out of the build.
        names.release(src);
        materialPaths.delete(src);
        continue;
      }
      const rel = names.peek(src);
      if (!rel) continue;
      assetDefs.push({ path: rel, name: basename(src), tags: flags.tags });
      if (flags.preload && (startAssets.has(src) || startMaterials.has(src))) {
        // Boot preload stays scoped to the start scene: a "Preload" flag on a
        // texture only level 5 uses must not sit in front of the main menu.
        preload.push(rel);
      }
    }
    if (preload.length) scene.preload = [...new Set(preload)];
    if (assetDefs.length) scene.assetIndex = assetDefs;
    if (excluded.length) {
      warnings.push(
        `Excluded from the build: ${excluded.filter(Boolean).map(basename).join(", ")}. ` +
          `Anything in a scene that references them will fail to load at runtime.`,
      );
    }
    const excludedRel = new Set(excluded.filter(Boolean));
    const shippedFiles = files.filter(([rel]) => !excludedRel.has(rel));
    shippedFiles.push(...generatedSidecarFiles.filter(
      ([rel]) => !excludedRel.has(rel.replace(/\.meta$/i, "")),
    ));
    const shippedSidecars = sidecarCopies.filter(
      ([, rel]) => !excludedRel.has(rel.replace(/\.(meta|basis)$/i, "")),
    );

    // (GI used to package Library/gi-sdf prebuilt bakes here. The SDF bake
    // pipeline was deleted 2026-08-02 — the occupancy backend voxelizes from
    // triangles on the GPU at load, so a build ships nothing and bakes
    // nothing.)
    const derivedCopies = [];

    // --- The player template, themed for this game --------------------------
    onProgress({ phase: "write", message: "Writing build…" });
    const iconRel = build.icon ? await stageIcon({ build, root, invoke, names, warnings }) : "";
    try {
      const template = await invoke("read_player_template", { rel: "index.html" });
      // The template is PREBUILT (dist-player/, from `npm run build:player`)
      // — a dev checkout can silently ship day-old runtime code with the
      // freshest scene, which reads as "the browser build behaves nothing
      // like the editor" (it once ran a deleted GI pipeline for a day). Say
      // how old the runtime is, loudly when it's old.
      const stamp = template.match(/player-template-built ([0-9T:.Z-]+)/)?.[1];
      if (stamp) {
        const ageDays = (Date.now() - Date.parse(stamp)) / 86_400_000;
        const note = `player runtime built ${stamp}`;
        if (ageDays > 1) {
          warnings.push(`${note} — ${ageDays.toFixed(1)} days old; run \`npm run build:player\` if engine code changed since`);
        } else {
          console.log(`[export] ${note}`);
        }
      }
      let themed = themePlayerHtml(template, { title, icon: iconRel, loading: build.loading ?? {} });
      // Live previews watch the revision marker and update themselves. The
      // client is injected into the FRESHLY GENERATED index.html rather than
      // living in the player bundle, so it works even when the prebuilt
      // template is out of date — the exact situation live preview is in the
      // business of surviving. It carries no baked revision (it baselines from
      // its first poll), so an unchanged index.html stays byte-identical
      // across rebuilds and never pollutes the change manifest.
      if (build.livePreview) {
        themed = injectLivePreviewClient(themed);
      }
      shippedFiles.push(["index.html", themed]);
    } catch (err) {
      // A template we can't read is not fatal — the copied one still boots,
      // it just wears the engine's default title and colours.
      warnings.push(`Loading screen not customised: ${err?.message ?? err}`);
    }
    const exportReport = await invoke("export_game", {
      outDir: contentDir,
      sceneJson: JSON.stringify(scene, null, 2),
      assets: [...names.copyEntries(), ...shippedSidecars, ...derivedCopies],
      files: shippedFiles,
    });
    // Test shims may still answer with the old bare missing-list (or null).
    const missingAssets = Array.isArray(exportReport)
      ? exportReport
      : (exportReport?.missing ?? []);
    const changedFiles = Array.isArray(exportReport) ? null : (exportReport?.changed ?? null);
    for (const src of missingAssets) {
      warnings.push(`Skipped missing asset ${src} — a scene or material still references it.`);
    }

    // Compressed model bytes overwrite the copies that were just made, so the
    // project's own .glb files are never touched. (Basis works the other way
    // round — a `.basis` sits next to the source as a documented derivative
    // cache, the same one the import path creates.)
    for (const [rel, bytes] of compression.overwrites) {
      await invoke("write_binary_file", { path: joinPath(contentDir, rel), contents: [...bytes] });
    }

    if (build.livePreview) {
      // The revision marker is written LAST — and atomically, because every
      // connected browser is polling this exact file — so a changed revision
      // always means "a complete new build is on disk". It carries the change
      // manifest, the revision it replaced, and a short delta history: the
      // client hot-applies the union of every delta since the revision it is
      // running, so rapid consecutive rebuilds (a gizmo drag outruns the 1s
      // poll easily) don't force a page reload. Only a client older than the
      // whole window — or one running a build the manifest can't account for
      // — falls back to reloading.
      let previous = null;
      let history = [];
      try {
        const old = JSON.parse(
          await invoke("read_text_file", { path: joinPath(contentDir, PREVIEW_REVISION_PATH) }),
        );
        previous = old?.revision ?? null;
        if (Array.isArray(old?.history)) history = old.history;
      } catch {
        // First build into this directory — nothing came before.
      }
      const revision = Date.now();
      const manifest = { revision, previous };
      if (changedFiles) {
        manifest.changed = changedFiles;
        manifest.history = [...history, { revision, changed: changedFiles }].slice(-25);
      }
      await invoke("write_file_atomic", {
        path: joinPath(contentDir, PREVIEW_REVISION_PATH),
        contents: JSON.stringify(manifest),
      });
    }

    // --- Target-specific delivery -------------------------------------------
    const extra = { warnings };
    if (isZip) {
      onProgress({ phase: "package", message: "Zipping…" });
      // The archive is a sibling of the build, never inside it. The folder is
      // kept as well as zipped — it is what "Run" serves, and testing the
      // thing you are about to upload beats testing a copy of it.
      const zipPath = joinPath(outDir, `${folderName}.zip`);
      await invoke("zip_dir", { dir: contentDir, dest: zipPath });
      extra.zipPath = zipPath;
    } else if (isDesktop) {
      onProgress({ phase: "package", message: "Writing desktop project…" });
      const scaffold = desktopScaffoldFiles({ title, hasIcon: !!iconRel });
      for (const [rel, contents] of scaffold) {
        await writeText(invoke, joinPath(outDir, rel), contents);
      }
      if (iconRel) {
        await invoke("create_dir", { path: joinPath(outDir, "src-tauri/icons") });
        const bytes = await readIconBytes({ build, root, invoke });
        if (bytes) {
          await invoke("write_binary_file", {
            path: joinPath(outDir, "src-tauri/icons/icon.png"),
            contents: [...bytes],
          });
        }
      }
      extra.desktopReadme = joinPath(outDir, "README.md");
    }

    return {
      ok: true,
      outDir,
      contentDir,
      target: build.target,
      startScene: plan.startScene,
      sceneCount: plan.scenes.length,
      assetCount:
        names.copyEntries().length + shippedSidecars.length + derivedCopies.length + shippedFiles.length,
      preloadCount: preload.length,
      excluded,
      savedBytes: compression.savedBytes,
      compressed: compression.count,
      warnings,
      ...extra,
    };
  } catch (err) {
    return fail(err?.message ?? String(err));
  }
}

async function pickOutputDirectory() {
  const { open } = await import("@tauri-apps/plugin-dialog");
  return open({ directory: true, title: "Build To…" });
}

const joinPath = (a, b) => `${String(a).replace(/[\\/]+$/, "")}/${normalizeRelPath(b)}`;

/**
 * Filesystem-safe filename for the zip.
 *
 * Illegal characters become spaces rather than dashes, and runs collapse:
 * "My Game v1.zip" reads better than "My--Game--v1.zip", and this name is the
 * first thing anyone sees when they download the build. A trailing dot or
 * space is stripped because Windows silently refuses both.
 */
export function sanitizeFileName(name) {
  return (
    String(name || "game")
      .replace(/[<>:"/\\|?*]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/, "") || "game"
  );
}

/** `save_scene` is the generic "write this text here" IPC. */
const writeText = (invoke, path, contents) => invoke("save_scene", { path, contents });

async function readIconBytes({ build, root, invoke }) {
  const abs = build.icon.match(/^([a-zA-Z]:|\/)/) ? build.icon : joinPath(root, build.icon);
  try {
    return new Uint8Array(await invoke("read_binary_file", { path: abs }));
  } catch {
    return null;
  }
}

/**
 * Copies the project's icon to the build root as `icon.png` (not into
 * `assets/` — a favicon reference sitting among the game's textures reads like
 * one, and gets swept up by anything that filters that folder).
 */
async function stageIcon({ build, root, invoke, names, warnings }) {
  const abs = build.icon.match(/^([a-zA-Z]:|\/)/) ? build.icon : joinPath(root, build.icon);
  try {
    await invoke("stat_file", { path: abs });
  } catch {
    warnings.push(`Icon "${build.icon}" was not found — the build has no icon.`);
    return "";
  }
  // Registered with the allocator (rather than pushed straight onto the copy
  // list) so no game asset can be handed `icon.png` at the build root.
  const ext = /\.(png|jpe?g|webp|svg|ico)$/i.exec(abs)?.[0] ?? ".png";
  return names.claimAt(abs, `icon${ext.toLowerCase()}`);
}

/**
 * Build-time texture and model compression.
 *
 * Textures go through the Basis encoder, which writes a `.basis` derivative
 * beside the source — the same cache the import path creates, and the same one
 * the Inspector's toggle deletes. Models are compressed *into the build*: the
 * bytes are returned here and written over the copied file afterwards, so a
 * build never silently rewrites the .glb the project is still authoring
 * against.
 *
 * Both are no-ops unless their module is enabled. A toggle that quietly does
 * nothing because a module is off is worse than one that refuses.
 */
async function compressBuildAssets({ names, build, onProgress, warnings }) {
  const result = { savedBytes: 0, count: 0, overwrites: [] };
  const wantTextures = build.compressTextures;
  const wantModels = build.compressModels;
  if (!wantTextures && !wantModels) return result;

  const sources = names.copyEntries().map(([source]) => source);

  if (wantTextures) {
    const { isBasisEnabled, compressTextureBasis } = await import("./basisCompress.js");
    if (!isBasisEnabled()) {
      warnings.push("Texture compression is on but the Basis module is disabled — skipped.");
    } else {
      const { readAssetMeta } = await import("./assetLoader.js");
      const textures = sources.filter((p) => /\.(png|jpe?g)$/i.test(p));
      for (const [i, src] of textures.entries()) {
        onProgress({ phase: "compress", message: `Compressing textures ${i + 1}/${textures.length}…` });
        const meta = await readAssetMeta(`${src}.meta`);
        // An explicit per-asset opt-out wins over the build-wide toggle: a
        // texture is opted out because it *looked wrong* compressed, and a
        // build setting should not quietly undo that judgement.
        if (meta?.basis?.enabled === false) continue;
        if (meta?.basis?.enabled === true) continue; // already has a derivative
        try {
          const info = await compressTextureBasis(src);
          if (info) {
            result.savedBytes += Math.max(0, (info.original ?? 0) - (info.compressed ?? 0));
            result.count++;
          }
        } catch (err) {
          warnings.push(`Basis compression skipped for ${basename(src)}: ${err?.message ?? err}`);
        }
      }
    }
  }

  if (wantModels) {
    const { isDracoEnabled } = await import("./dracoCompress.js");
    if (!isDracoEnabled()) {
      warnings.push("Model compression is on but the Draco module is disabled — skipped.");
    } else {
      const { compressGlbBuffer } = await import("./dracoCompress.js");
      const { invoke } = await import("@tauri-apps/api/core");
      const models = names.copyEntries().filter(([source]) => /\.glb$/i.test(source));
      for (const [i, [source, rel]] of models.entries()) {
        onProgress({ phase: "compress", message: `Compressing models ${i + 1}/${models.length}…` });
        try {
          const original = new Uint8Array(await invoke("read_binary_file", { path: source }));
          const out = await compressGlbBuffer(original);
          if (out && out.byteLength < original.byteLength) {
            result.overwrites.push([rel, out]);
            result.savedBytes += original.byteLength - out.byteLength;
            result.count++;
          }
        } catch (err) {
          warnings.push(`Draco compression skipped for ${basename(source)}: ${err?.message ?? err}`);
        }
      }
    }
  }

  return result;
}
