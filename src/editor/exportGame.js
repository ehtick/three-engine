import { ensureEngine } from "./engineInstance.js";
import { isBuiltinMaterial } from "../engine/builtinMaterials.js";
import { createAssetNames, basename } from "./build/assetNames.js";
import { rewriteComponentAssets, rewriteVfxGraphAssets, DOCUMENT_KINDS, extOf, ASSET_EXTENSIONS } from "./build/assetRefs.js";
import { selectRuntimeFiles, scriptImportSpecifiers, pagesHeaders, PAGES_HEADERS_PATH } from "./build/runtimeFiles.js";
import { moduleIdsForComponentTypes } from "./build/moduleRefs.js";
import {
  BUILD_DEFAULTS,
  resolveBuildScenes,
  findSceneReferences,
  normalizeRelPath,
  toProjectRelative,
} from "./build/buildSettings.js";
import { themePlayerHtml, injectLivePreviewClient, PREVIEW_REVISION_PATH } from "./build/playerHtml.js";
import { desktopScaffoldFiles } from "./build/desktopScaffold.js";
import { serializeEventCatalog } from "../engine/events/catalog.js";

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
        `  ${report.sceneCount} scene(s), ${report.prefabCount ?? 0} prefab(s), ${report.assetCount} asset file(s)` +
        `${report.preloadCount ? `, ${report.preloadCount} preloaded` : ""}` +
        `${report.savedBytes ? `, ${formatBytes(report.savedBytes)} saved by compression` : ""}` +
        `${report.prefabsSkipped ? `\n  ${report.prefabsSkipped} prefab(s) no shipped scene reaches were left out` : ""}` +
        `${report.removed?.length ? `\n  ${report.removed.length} leftover file(s) from the previous build removed` : ""}` +
        `${
          report.runtime?.trimmed
            ? `\n  runtime: ${report.runtime.files} of ${report.runtime.files + report.runtime.skipped} template files ` +
              `(${formatBytes(report.runtime.skippedBytes)} this game cannot reach left out)`
            : ""
        }`,
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
  const { dependenciesOf } = await import("../engine/prefab/index.js");
  const { resolveModuleId, resolveModuleDependencies, getModuleDefinitions } = await import("../engine/modules.js");
  const { readAssetFlags } = await import("./assetFlags.js");
  const { getProjectSettings } = await import("./projectSettings.js");
  const { useProjectStore } = await import("./store/projectStore.js");
  const { useModulesStore } = await import("./modules.js");
  const { listProjectAssets, transpileScript } = await import("./assetLoader.js");
  const { currentScenePath } = await import("./sceneIO.js");
  const {
    staticBvhArtifactRelativePath,
    staticBvhSceneManifestRelativePath,
  } = await import("../modules/gi/staticBvhDiskCache.js");
  const {
    STATIC_BVH_FORMAT_PLACEMENT,
    STATIC_BVH_FORMAT_WORLD,
  } = await import("../modules/gi/staticBvhFormats.js");

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

  // The scenes that ship. In "reachable" mode (the default) this starts as the
  // start scene alone and grows as shipped content names other scenes — a
  // script's `engine.loadScene("scenes/Level2.scene")`, an event action, a
  // prefab's script — the same rule assets follow. A `.scene` flagged Preload
  // always ships (a level only ever named by data). The explicit list and
  // "all" modes ship exactly what they say.
  const shippedScenes = [...plan.scenes];
  const queuedScenes = new Set(shippedScenes.map((s) => normalizeRelPath(s).toLowerCase()));
  const enqueueScene = (rel) => {
    const key = normalizeRelPath(rel).toLowerCase();
    if (queuedScenes.has(key)) return;
    queuedScenes.add(key);
    shippedScenes.push(rel);
  };
  const enqueueScenes = (text) => {
    if (plan.mode !== "reachable") return;
    for (const rel of findSceneReferences(text, { available, root })) enqueueScene(rel);
  };

  const samePath = (a, b) =>
    !!a && !!b && normalizeRelPath(a).toLowerCase() === normalizeRelPath(b).toLowerCase();
  /**
   * The scene JSON to ship for one project-relative path. The scene open in
   * the editor is serialized live rather than read off disk: exporting is the
   * one moment where "what I'm looking at" and "what ships" diverging is
   * unforgivable, and unsaved edits are the normal state of an editor.
   */
  const readScene = async (rel) => {
    if (samePath(rel, openRel)) {
      // Component.toJSON() intentionally makes a cheap shallow props copy, but
      // build rewriting changes nested values such as script slot paths. Give
      // the exporter a fully detached snapshot so generated `assets/*.js`
      // paths can never leak back into the live editor scene.
      return structuredClone(serializeScene(engine));
    }
    // Prefab definitions live in the registry, not in each scene file; the
    // start scene carries the reachable ones for the whole build
    // (embedReachablePrefabs), so a level that isn't open still resolves its
    // instances by guid.
    return JSON.parse(await invoke("load_scene", { path: joinPath(root, rel) }));
  };

  // --- Asset collection ------------------------------------------------------
  const names = createAssetNames();
  const scriptPaths = new Set(); // ship transpiled, not copied
  const materialPaths = new Set(); // .mat files ship with rewritten texture paths
  const cubemapPaths = new Set(); // .cubemap files ship with rewritten face paths
  const audioSidecarPaths = new Set(); // .audio JSON, copied with path rewrites
  const timelinePaths = new Set(); // .timeline files ship with rewritten clip paths
  const atlasPaths = new Set(); // .atlas files ship with a rewritten image path
  const vfxPaths = new Set(); // .vfx graphs ship with rewritten mesh/texture paths
  const componentTypes = new Set();
  const catalog = getModuleDefinitions();
  const schemaFor = type => getComponentClass(type)?.schema ??
    catalog.flatMap(definition => definition.components ?? []).find(component => component.type === type)?.schema;
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
  // Every prefab a shipped scene — or a shipped prefab — names, by guid. Only
  // these (and what they depend on) are embedded; see embedReachablePrefabs.
  const referencedPrefabs = new Set();
  const notePrefab = (link) => {
    const guid = prefabRegistry.resolveLink(link);
    if (guid) referencedPrefabs.add(guid);
    return guid;
  };
  const toPrefabGuid = (value) => {
    if (typeof value !== "string") return value;
    const guid = prefabRegistry.guidForPath(value);
    if (guid) {
      referencedPrefabs.add(guid);
      return guid;
    }
    if (prefabRegistry.has(value)) referencedPrefabs.add(value);
    return value;
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
    vfx: vfxPaths,
  };
  /** Claim one asset path by value, routing documents to their re-emit bucket
   *  exactly as `rewriteComponentAssets` does internally. */
  const rewriteAssetValue = (value) => {
    if (isBuiltinMaterial(value)) return value;
    const kind = DOCUMENT_KINDS[extOf(value)];
    if (!kind) return claim(value);
    documentBuckets[kind]?.add(sourcePath(value));
    return claimDoc(value);
  };

  /**
   * Transpiled, path-rewritten source of every shipped script, read once. The
   * prefab closure has to look inside scripts before the document loops run
   * (a script can name a prefab by guid), so reading is memoised rather than
   * done in the loop. `null` records an unreadable script.
   */
  const scriptSources = new Map();
  const readScriptSource = async (src) => {
    if (scriptSources.has(src)) return scriptSources.get(src);
    let code = null;
    try {
      const raw = await readRequiredText(src, "script");
      code = rewriteSourceAssetPaths(await transpileScript(raw), {
        root,
        rewriteAssetValue,
        onFound: (original) =>
          warnings.push(
            `${basename(src)} hard-codes the absolute path "${original}". It was rewritten so the ` +
              `build works, but the path is specific to this machine — prefer an ` +
              `@attribute({ type: "asset" }) field and pick the asset in the Inspector.`,
          ),
      });
      enqueueScenes(code);
    } catch (err) {
      warnings.push(`Skipped script ${src}: ${err?.message ?? err}`);
    }
    scriptSources.set(src, code);
    return code;
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
    componentTypes.add(c.type);
    rewritePrefabRefs(c.props);
    rewriteComponentAssets(c, {
      getSchema: schemaFor,
      claim,
      claimDoc,
      add: (kind, p) => documentBuckets[kind]?.add(sourcePath(p)),
      rewritePrefab: toPrefabGuid,
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
    if (node.prefab) {
      notePrefab(node.prefab);
      delete node.prefab.path;
    }
    for (const c of node.components ?? []) visitComponent(c);
    for (const ov of node.overrides ?? []) visitOverride(ov);
    (node.children ?? []).forEach(visit);
  };

  const rewriteScene = (sceneJson) => {
    // The scene's sky slot, which holds either shape (engine/environmentAsset.js).
    // A .cubemap ships like a .mat — the descriptor is re-emitted and its six
    // faces are copied. An .hdr/.exr is one file and just gets copied; routing
    // it through the cubemap bucket would try to parse a binary as JSON.
    const sky = sceneJson.settings?.environment?.cubemap;
    if (sky) {
      if (extOf(sky) === "cubemap") {
        cubemapPaths.add(sourcePath(sky));
        sceneJson.settings.environment.cubemap = claimDoc(sky);
      } else {
        sceneJson.settings.environment.cubemap = claim(sky);
      }
    }
    (sceneJson.entities ?? []).forEach(visit);
    // Prefab defs are never read from scene files: the registry is the source
    // of truth in the editor, and the build embeds the reachable subset of it
    // on the start scene (embedReachablePrefabs).
    delete sceneJson.prefabs;
  };
  /** Claims a prefab def's assets exactly as a scene subtree's are claimed. */
  const visitPrefabDef = (def) => {
    if (def.root) visit(def.root);
    for (const ov of def.overrides ?? []) visitOverride(ov); // variants
  };

  // --- Prefabs: the reachable subset of the registry -------------------------
  // The player has no project to scan, so prefab defs ride along in scene.json.
  // Embedding every def in the project (the old behaviour) also claimed every
  // asset every prefab touched — a build carried the meshes, materials and
  // textures of prefabs no shipped scene could ever spawn. Now a def ships when
  // a shipped scene instances it, a shipped prefab nests it or derives from it
  // (variants), a shipped script's attribute names it, a shipped script's
  // SOURCE mentions its guid or `.prefab` path, or its `.prefab` file is
  // flagged Preload — the "always ship" escape hatch for a prefab only ever
  // named at runtime (a spawn table, a name assembled from data). An Exclude
  // flag on the `.prefab` keeps it out even when something references it.
  //
  // Incremental, and called twice: once after the start scene (so its prefabs'
  // assets count as start-scene assets for the boot preload list) and once
  // after every level has been walked.
  const shippedPrefabs = new Map(); // guid -> def, as it ships
  const consideredPrefabs = new Set();
  const excludedPrefabs = new Set();
  const scannedScripts = new Set();
  let prefabFlagsRead = false;
  async function embedReachablePrefabs() {
    const all = prefabRegistry.all();
    const frontier = new Set();
    const enqueue = (guid) => {
      if (!guid || consideredPrefabs.has(guid)) return;
      consideredPrefabs.add(guid);
      frontier.add(guid);
    };
    if (!prefabFlagsRead) {
      prefabFlagsRead = true;
      for (const def of all) {
        const path = prefabRegistry.pathOf(def.guid);
        const flags = path ? await readAssetFlags(path) : null;
        if (flags?.exclude) excludedPrefabs.add(def.guid);
        else if (flags?.preload) enqueue(def.guid);
      }
    }
    for (const guid of referencedPrefabs) enqueue(guid);

    const prefabPathLiteral = /(['"`])([^'"`\r\n]+\.prefab)\1/gi;
    const literalHits = (code) => {
      const hits = new Set();
      for (const def of all) if (code.includes(def.guid)) hits.add(def.guid);
      for (const match of code.matchAll(prefabPathLiteral)) {
        const guid =
          prefabRegistry.guidForPath(match[2]) ??
          (root ? prefabRegistry.guidForPath(joinPath(root, match[2])) : null);
        if (guid) hits.add(guid);
      }
      return hits;
    };

    while (frontier.size) {
      const closure = new Set();
      for (const guid of frontier) dependenciesOf(guid, closure);
      frontier.clear();
      for (const guid of closure) {
        consideredPrefabs.add(guid);
        if (shippedPrefabs.has(guid)) continue;
        if (excludedPrefabs.has(guid)) {
          warnings.push(
            `Prefab ${basename(prefabRegistry.pathOf(guid) ?? guid)} is flagged Exclude but a shipped ` +
              `scene or prefab references it — its instances will not spawn.`,
          );
          continue;
        }
        const def = prefabRegistry.getDef(guid);
        if (!def) continue;
        const copy = structuredClone(def);
        // Claims the def's assets, and records any prefab it names in turn.
        visitPrefabDef(copy);
        // The registry in the build is keyed by guid. The authoring path is a
        // machine-specific absolute path; ship the project-relative form, so
        // `engine.instantiate("prefabs/Enemy.prefab")` resolves in a build the
        // way it does in the editor.
        const path = prefabRegistry.pathOf(guid);
        if (path && root) copy.path = toProjectRelative(root, path);
        else delete copy.path;
        if (copy.variantOf?.path) {
          copy.variantOf.path = root ? toProjectRelative(root, copy.variantOf.path) : null;
        }
        shippedPrefabs.set(guid, copy);
        enqueueScenes(JSON.stringify(copy));
      }
      // A script reached so far may name a prefab the walk cannot see — by guid
      // (`engine.instantiate("p_…")`) or by path literal.
      for (const src of scriptPaths) {
        if (scannedScripts.has(src)) continue;
        scannedScripts.add(src);
        if ((await readAssetFlags(src)).exclude) continue;
        const code = await readScriptSource(src);
        if (code) for (const guid of literalHits(code)) enqueue(guid);
      }
      // Attribute-level references discovered while visiting the defs above.
      for (const guid of referencedPrefabs) enqueue(guid);
    }
  }

  // Build-relative destinations dropped by an Exclude flag. Checked BEFORE a
  // document is read, so an excluded material's textures are never claimed:
  // "exclude" means the file and everything only it references stay home.
  const excluded = [];
  const skipExcluded = async (src, bucket) => {
    if (!(await readAssetFlags(src)).exclude) return false;
    const rel = names.peek(src);
    if (rel) excluded.push(rel);
    names.release(src);
    bucket?.delete(src);
    return true;
  };

  try {
    // --- The start scene, which is also the build's config carrier ----------
    const scene = await readScene(plan.startScene);
    scene.player = {
      title,
      // A ceiling over each scene's authored performance block. See
      // QUALITY_PRESETS in engine/sceneSettings.js.
      quality: build.quality ?? "ultra",
      // The phone/tablet ceiling, applied by the player only on a portable
      // device; "same" (the default) ships phones the preset above.
      mobileQuality: build.mobileQuality ?? "same",
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
    let enabledModules = resolveModuleDependencies([...useModulesStore.getState().enabled], { ignoreUnknown: true });
    scene.modules = enabledModules;
    scene.input = engine.input.toJSON();
    // The project's declared events. Carried as the normalized catalog rather
    // than the raw project.json block so a build can't ship an entry the editor
    // was already ignoring.
    scene.events = serializeEventCatalog(engine.events.list());
    // The collision-layer matrix is project-wide, and a build with the wrong
    // matrix has every bullet hitting the player who fired it.
    scene.physics = {
      names: projectSettings.physics.layers,
      matrix: projectSettings.physics.matrix,
      autoCollidersEnabled: projectSettings.physics.autoCollidersEnabled === true,
    };
    rewriteScene(scene);
    onProgress({ phase: "prefabs", message: "Collecting prefabs…" });
    await embedReachablePrefabs();
    // Only the start scene's assets (its prefabs' included) feed the boot
    // preload list below. Levels the game loads later preload themselves, on
    // demand.
    const startAssets = new Set(names.entries().map(([source]) => source).filter(Boolean));
    const startMaterials = new Set(materialPaths);

    const files = []; // [relativePath, contents]

    // --- Every other shipped scene, at its project-relative path -------------
    if (plan.mode === "reachable") {
      if (root) {
        for (const rel of available) {
          if ((await readAssetFlags(joinPath(root, rel))).preload) enqueueScene(rel);
        }
      }
      enqueueScenes(JSON.stringify(scene));
    }
    onProgress({ phase: "scenes", message: "Collecting scenes…" });
    // A worklist, not a fixed list: a level can name the next one, and a prefab
    // a level embeds can name another, so shipping repeats until nothing new
    // turns up. The start scene ships twice — as scene.json (what the player
    // boots) and at its own path — so a script can reload the level it started in.
    const shippedSceneList = [];
    let nextScene = 0;
    while (nextScene < shippedScenes.length) {
      while (nextScene < shippedScenes.length) {
        const rel = shippedScenes[nextScene++];
        if (root && !samePath(rel, plan.startScene) && (await readAssetFlags(joinPath(root, rel))).exclude) {
          warnings.push(`Scene ${rel} is flagged Exclude — not shipped.`);
          continue;
        }
        try {
          // Serialized fresh so the rewrite can't touch the copy already bound
          // for scene.json.
          const json = await readScene(rel);
          rewriteScene(json);
          enqueueScenes(JSON.stringify(json));
          files.push([rel, JSON.stringify(json)]);
          shippedSceneList.push(rel);
        } catch (err) {
          warnings.push(`Skipped scene ${rel}: ${err?.message ?? err}`);
        }
      }
      // Prefabs only a later level reaches — and any scene THEY name.
      await embedReachablePrefabs();
    }
    scene.prefabs = [...shippedPrefabs.values()];
    const prefabsSkipped = prefabRegistry.all().length - shippedPrefabs.size - excludedPrefabs.size;
    enabledModules = resolveModuleDependencies([
      ...enabledModules, ...moduleIdsForComponentTypes(componentTypes, catalog),
    ], { ignoreUnknown: true });
    scene.modules = enabledModules;
    // A later level can introduce a provider the start scene does not contain.
    // Preserve that closure in each exported scene, including a start reload.
    for (const entry of files) {
      const json = JSON.parse(entry[1]);
      json.modules = enabledModules;
      entry[1] = JSON.stringify(json);
    }

    // --- Referenced documents ------------------------------------------------
    onProgress({ phase: "assets", message: "Rewriting asset references…" });
    // A referenced document that no longer exists (an asset deleted after a
    // scene started referencing it) is a warning, not a failed build — same
    // policy as the scene loop above. The runtime already tolerates the
    // resulting 404 with a default material/skipped script, and "I deleted an
    // asset and now nothing builds" is worse than either.
    for (const src of [...scriptPaths]) {
      onProgress({ phase: "assets", message: `Reading script ${basename(src)}…` });
      if (await skipExcluded(src, scriptPaths)) continue;
      const code = await readScriptSource(src);
      if (code == null) continue;
      files.push([claimDoc(src, (name) => name.replace(/\.ts$/i, ".js")), code]);
    }
    for (const src of [...vfxPaths]) {
      onProgress({ phase: "assets", message: `Reading VFX ${basename(src)}...` });
      if (await skipExcluded(src, vfxPaths)) continue;
      try {
        const { parseVfxAsset } = await import("../engine/vfx/vfxAsset.js");
        const doc = parseVfxAsset(JSON.parse(await readRequiredText(src, "VFX")));
        rewriteVfxGraphAssets(doc.graph, rewriteAssetValue);
        files.push([claimDoc(src), JSON.stringify(doc)]);
      } catch (err) {
        warnings.push(`Skipped VFX ${src}: ${err?.message ?? err}`);
      }
    }
    for (const src of [...materialPaths]) {
      onProgress({ phase: "assets", message: `Reading material ${basename(src)}…` });
      if (await skipExcluded(src, materialPaths)) continue;
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
    for (const src of [...cubemapPaths]) {
      onProgress({ phase: "assets", message: `Reading cubemap ${basename(src)}…` });
      if (await skipExcluded(src, cubemapPaths)) continue;
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
    for (const src of [...timelinePaths]) {
      onProgress({ phase: "assets", message: `Reading timeline ${basename(src)}…` });
      if (await skipExcluded(src, timelinePaths)) continue;
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
    for (const src of [...atlasPaths]) {
      onProgress({ phase: "assets", message: `Reading atlas ${basename(src)}…` });
      if (await skipExcluded(src, atlasPaths)) continue;
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
    for (const src of [...audioSidecarPaths]) {
      if (await skipExcluded(src, audioSidecarPaths)) continue;
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
      root,
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
      // A texture over the size cap ships its resampled build-cache derivative
      // and a meta that points at it; the project's own meta and full-size
      // `.basis` stay home.
      const capped = compression.cappedTextures.get(src);
      if (capped) {
        generatedSidecarFiles.push([names.claimSidecar(src, ".meta"), JSON.stringify(capped.meta, null, 2)]);
        sidecarCopies.push([capped.cache, names.claimSidecar(src, ".basis")]);
        continue;
      }
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
    const preload = [];
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
    // Ship only the exact static-BVH artifacts selected by each scene's tiny
    // manifest. Copying the whole content-addressed cache made every geometry
    // edit permanently add another ~158 MiB to Bistro builds. Missing pointers
    // are safe (the player builds in memory), but explicit so an author knows
    // which scene still needs one editor bake before release.
    const derivedByDestination = new Map();
    if (root && enabledModules.includes("gi")) {
      for (const rel of shippedSceneList) {
        const sceneKey = samePath(rel, openRel) ? openScenePath : joinPath(root, rel);
        try {
          const candidates = [];
          for (const format of [STATIC_BVH_FORMAT_PLACEMENT, STATIC_BVH_FORMAT_WORLD]) {
            const manifestPath = joinPath(
              root,
              `Library/${staticBvhSceneManifestRelativePath(sceneKey, { format })}`,
            );
            try {
              const manifest = JSON.parse(await invoke("read_text_file", { path: manifestPath }));
              const signature = String(manifest?.signature ?? "").toLowerCase();
              const manifestFormat = manifest?.format ?? STATIC_BVH_FORMAT_WORLD;
              const artifact = staticBvhArtifactRelativePath(signature, { format: manifestFormat });
              if (
                manifest?.version !== 1 || manifestFormat !== format ||
                manifest?.artifact !== artifact
              ) continue;
              candidates.push({ manifest, artifact });
            } catch {
              // A scene normally owns only one live format pointer.
            }
          }
          candidates.sort((a, b) => Number(b.manifest.updatedAt ?? 0) - Number(a.manifest.updatedAt ?? 0));
          const selected = candidates[0];
          if (!selected) throw new Error("stale, malformed, or missing pointer");
          const { artifact } = selected;
          const destination = `Library/${artifact}`;
          derivedByDestination.set(destination, [joinPath(root, destination), destination]);
        } catch (error) {
          warnings.push(
            `GI acceleration cache not baked for ${rel}; open the scene once before the final build ` +
              `(${error?.message ?? error}).`,
          );
        }
      }
    }
    // Architecture's style-surface disk cache (owner: "write those textures once to disk and
    // reuse rather than generate at runtime"): the whole static table is small (tests below
    // measure it) and content-addressed by (kind, variant, flat) alone, not by scene, so —
    // unlike the BVH's per-scene, potentially-158MiB artifacts above — it is safe to ship
    // whatever of it the editor has already baked wholesale. A file missing here is a normal,
    // safe miss: the player paints that one layer once at first boot, same as any other miss.
    if (root && enabledModules.includes("architecture")) {
      try {
        const { styleSurfaceCacheFileList } = await import("../modules/architecture/styles/surfaces.js");
        const dir = joinPath(root, "Library/architecture/style-surfaces");
        const entries = await invoke("list_dir", { path: dir }).catch(() => []);
        const present = new Set((entries || []).map((entry) => String(entry?.name ?? entry)));
        for (const relPath of styleSurfaceCacheFileList()) {
          const filename = relPath.split("/").pop();
          if (!present.has(filename)) continue;
          const destination = `Library/${relPath}`;
          derivedByDestination.set(destination, [joinPath(root, destination), destination]);
        }
      } catch {
        // No baked style-surface cache yet — the player paints every layer at first boot.
      }
    }
    const derivedCopies = [...derivedByDestination.values()];

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
    // Last line of defence before the bytes leave the editor: nothing shipped
    // may still name a file on this machine. See findLeakedAbsolutePaths.
    for (const leak of findLeakedAbsolutePaths(shippedFiles, root)) {
      warnings.push(
        `${leak.file} still contains the local path "${leak.path}" — whatever reads it will ` +
          `fail to load in a browser. This is an exporter gap: please report which asset ` +
          `field it came from.`,
      );
    }
    // --- The runtime: only the engine code this game can reach --------------
    // The player template is code-split behind dynamic imports; a game with no
    // physics module has no reason to ship Rapier. See build/runtimeFiles.js.
    let runtime = null;
    if (build.trimRuntime !== false) {
      try {
        const templateFiles = await invoke("list_player_template");
        const manifest = JSON.parse(await invoke("read_player_template", { rel: ".vite/manifest.json" }));
        const copySources = names.copyEntries().map(([source]) => source);
        const modelExtensions = await modelExtensionsUsed(invoke, copySources);
        runtime = selectRuntimeFiles({
          manifest,
          templateFiles,
          modules: [...enabledModules, ...enabledModules.map(resolveModuleId)],
          assetExtensions: [...copySources.map(extOf), ...shippedFiles.map(([rel]) => extOf(rel))],
          scriptImports: scriptImportSpecifiers(scriptSources.values()),
          livePreview: !!build.livePreview,
          compressTextures: !!build.compressTextures,
          compressModels: !!build.compressModels,
          dracoModels: modelExtensions.has("KHR_draco_mesh_compression"),
          meshoptModels: modelExtensions.has("EXT_meshopt_compression") || modelExtensions.has("KHR_meshopt_compression"),
          basisModels: modelExtensions.has("KHR_texture_basisu"),
        });
      } catch (err) {
        runtime = null;
        warnings.push(
          `Runtime not trimmed — the whole player template ships (${err?.message ?? err}). ` +
            "Run `npm run build:player` to refresh the template.",
        );
      }
    }
    // Cloudflare Pages cache rules (publishGame uploads the web target). Not
    // for the itch.io zip or the desktop shell — neither host reads it.
    if (!isZip && !isDesktop) {
      shippedFiles.push([PAGES_HEADERS_PATH, pagesHeaders({ files: runtime?.files ?? null })]);
    }
    const exportReport = await invoke("export_game", {
      outDir: contentDir,
      sceneJson: JSON.stringify(scene, null, 2),
      assets: [...names.copyEntries(), ...shippedSidecars, ...derivedCopies],
      files: shippedFiles,
      // Only the runtime files selected above (null = the whole template), and
      // sweep whatever the previous build into this folder left behind.
      templateFiles: runtime?.files ?? null,
      prune: true,
    });
    // Test shims may still answer with the old bare missing-list (or null).
    const missingAssets = Array.isArray(exportReport)
      ? exportReport
      : (exportReport?.missing ?? []);
    const changedFiles = Array.isArray(exportReport) ? null : (exportReport?.changed ?? null);
    for (const src of missingAssets) {
      if (runtime?.files && /[\\/]_engine[\\/]|[\\/]dist-player[\\/]/.test(src)) {
        warnings.push(
          `Player template file ${basename(src)} vanished during the build (template rebuilt?) — build again.`,
        );
        continue;
      }
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
      // A rebuild that rewrote NOTHING must not publish a revision. Every edit
      // schedules more than one flush (the debounce fires, then the reconcile's
      // own `hierarchy-changed` schedules a trailing one), so roughly half of
      // all exports are byte-for-byte no-ops. Publishing them anyway cost real
      // robustness in two ways: every connected client did a pointless
      // catch-up round trip, and — the one that bites — each no-op consumed a
      // slot in the bounded `history` window that a client uses to rejoin after
      // missing builds. Measured on a live session: 16 of the 25 history
      // entries were empty, so a preview in a background tab (or a phone with
      // its screen off, which is the whole reason the window exists) fell out
      // of the window after ~9 real edits and hard-reloaded. Skipping no-ops
      // roughly triples the effective window and costs nothing: a client whose
      // revision is unchanged is, by definition, already up to date.
      const noop = Array.isArray(changedFiles) && changedFiles.length === 0 && previous !== null;
      if (!noop) {
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
      sceneCount: shippedSceneList.length,
      scenes: shippedSceneList,
      sceneMode: plan.mode,
      assetCount:
        names.copyEntries().length + shippedSidecars.length + derivedCopies.length + shippedFiles.length,
      preloadCount: preload.length,
      prefabCount: scene.prefabs.length,
      prefabsSkipped: Math.max(0, prefabsSkipped),
      excluded,
      // Leftovers of the previous build into this folder that were deleted.
      removed: Array.isArray(exportReport) ? [] : (exportReport?.removed ?? []),
      runtime: runtime
        ? {
            trimmed: runtime.trimmed,
            files: runtime.files.length,
            skipped: runtime.skipped.length,
            shippedBytes: runtime.shippedBytes,
            skippedBytes: runtime.skippedBytes,
          }
        : null,
      savedBytes: compression.savedBytes,
      compressed: compression.count,
      warnings,
      ...extra,
    };
  } catch (err) {
    return fail(err?.message ?? String(err));
  }
}

/** A quoted literal holding something that starts like an absolute path —
 *  `C:\…`, `C:/…` or `/…`. Escaped characters inside are tolerated so a
 *  Windows path written `"C:\\Users\\…"` in source is matched whole. */
const ABSOLUTE_LITERAL_RE = /(['"`])((?:[A-Za-z]:[\\/]|\/)(?:\\.|[^\\\r\n])*?)\1/g;

/**
 * Rewrites absolute project asset paths that a SCRIPT hard-codes as string
 * literals, claiming each one into the build.
 *
 * The structured fix (rewriting a script slot's saved `attributes`) only
 * reaches values the author actually set in the Inspector. An
 * `@attribute({ type: "asset" }) ballMaterial = "C:/…/CannonBall.mat"` that
 * still holds its declared DEFAULT has no saved value anywhere — the path
 * exists only in the script's own source, which the exporter transpiles
 * verbatim. That build then ships a scene whose every reference is correct and
 * one script that asks the browser for `file:///C:/Users/…`, which Chrome
 * refuses outright ("Not allowed to load local resource"). The asset is not
 * merely mis-addressed, it was never copied into the build at all, so claiming
 * here is what makes it exist.
 *
 * Only ABSOLUTE paths are touched: they cannot work in a build under any
 * circumstances, so rewriting them is strictly an improvement, while guessing
 * at relative strings risks mangling something that is not a path.
 *
 * @param code   transpiled script source
 * @param deps   { root, rewriteAssetValue, onFound }
 */
export function rewriteSourceAssetPaths(code, { root, rewriteAssetValue, onFound = noop }) {
  if (!root || !code.includes(":") && !code.includes("/")) return code;
  const rootKey = String(root).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  return String(code).replace(ABSOLUTE_LITERAL_RE, (match, quote, body) => {
    // `"C:\\Users\\x"` is the two-character escape in source; the VALUE has one.
    const value = body.replace(/\\(.)/g, "$1");
    const key = value.replaceAll("\\", "/").toLowerCase();
    if (!key.startsWith(`${rootKey}/`)) return match;
    if (!ASSET_EXTENSIONS.has(extOf(value))) return match;
    const rel = rewriteAssetValue(value);
    if (!rel || rel === value) return match;
    onFound(value, rel);
    // Build-relative paths are plain `assets/name.ext` — no quotes, no
    // backslashes — so they need no re-escaping for any quote style.
    return `${quote}${rel}${quote}`;
  });
}

/**
 * Reports any absolute local path still present in the text files a build is
 * about to ship.
 *
 * This class of bug has now been found three separate ways (a hand-maintained
 * component ladder, a model's per-material map, a script attribute), and every
 * time it was silent at build time and only visible as a failed fetch in
 * someone's browser — usually long after, and usually blamed on the server.
 * The check costs a regex over already-in-memory strings and turns "some
 * materials just don't load" into a named warning at the moment it is created.
 */
export function findLeakedAbsolutePaths(files, root) {
  if (!root) return [];
  const rootKey = String(root).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  const leaks = [];
  for (const [rel, contents] of files) {
    if (typeof contents !== "string") continue;
    for (const match of contents.matchAll(ABSOLUTE_LITERAL_RE)) {
      const value = match[2].replace(/\\(.)/g, "$1");
      if (!value.replaceAll("\\", "/").toLowerCase().startsWith(`${rootKey}/`)) continue;
      leaks.push({ file: rel, path: value });
      break; // One per file is enough to send someone to the right place.
    }
  }
  return leaks;
}

/**
 * Whether any shipped model needs the Draco decoder. The engine core attaches
 * a DRACOLoader to every glTF load and fetches the decoder only for a mesh
 * that declares `KHR_draco_mesh_compression`, so a downloaded model can need
 * it with the Draco module off. The declaration sits in the glTF JSON's
 * `extensionsUsed`, inside the first 64 KB of any realistic file.
 */
export async function anyDracoModel(invoke, sources) {
  return (await modelExtensionsUsed(invoke, sources)).has("KHR_draco_mesh_compression");
}

/** glTF extensions whose decoders the player only ships on demand. */
const DECODER_EXTENSIONS = [
  "KHR_draco_mesh_compression",
  "EXT_meshopt_compression",
  "KHR_meshopt_compression",
  "KHR_texture_basisu",
];

/**
 * Which decoder-backed extensions any shipped model declares (Draco, meshopt,
 * KTX2 textures) — same 64 KB `extensionsUsed` head scan for all of them.
 */
export async function modelExtensionsUsed(invoke, sources) {
  const decoder = new TextDecoder();
  const found = new Set();
  for (const src of sources) {
    if (!/\.(glb|gltf)$/i.test(src)) continue;
    try {
      const head = await invoke("read_binary_file_head", { path: src, maxBytes: 65536 });
      const bytes =
        head instanceof ArrayBuffer ? new Uint8Array(head) : ArrayBuffer.isView(head) ? head : Uint8Array.from(head);
      const text = decoder.decode(bytes);
      for (const name of DECODER_EXTENSIONS) if (text.includes(name)) found.add(name);
      if (found.size === DECODER_EXTENSIONS.length) break;
    } catch {
      // Unreadable here → the copy step reports it. Assume no extensions.
    }
  }
  return found;
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
async function compressBuildAssets({ names, build, root, onProgress, warnings }) {
  // cappedTextures: source -> { cache, meta } for textures resampled under the
  // build's size cap (shipped by the sidecar step instead of the project's).
  const result = { savedBytes: 0, count: 0, overwrites: [], cappedTextures: new Map() };
  const wantTextures = build.compressTextures;
  const wantModels = build.compressModels;
  if (!wantTextures && !wantModels) return result;

  const sources = names.copyEntries().map(([source]) => source);

  if (wantTextures) {
    const { isBasisEnabled, compressTextureBasis, basisModeFor } = await import("./basisCompress.js");
    if (!isBasisEnabled()) {
      warnings.push("Texture compression is on but the Basis module is disabled — skipped.");
    } else {
      const { readAssetMeta } = await import("./assetLoader.js");
      const { invoke } = await import("@tauri-apps/api/core");
      const { imageDimensions, textureBuildSize, basisBuildCacheName } = await import("./build/textureBuildSize.js");
      const textures = sources.filter((p) => /\.(png|jpe?g)$/i.test(p));
      for (const [i, src] of textures.entries()) {
        onProgress({ phase: "compress", message: `Compressing textures ${i + 1}/${textures.length}…` });
        const meta = await readAssetMeta(`${src}.meta`);
        // An explicit per-asset opt-out wins over the build-wide toggle: a
        // texture is opted out because it *looked wrong* compressed, and a
        // build setting should not quietly undo that judgement.
        if (meta?.basis?.enabled === false) continue;
        const capped = root
          ? await cappedBasisDerivative({ invoke, src, meta, root, build, basisModeFor, imageDimensions, textureBuildSize, basisBuildCacheName })
          : null;
        if (capped?.error) {
          warnings.push(`Texture size cap skipped for ${basename(src)}: ${capped.error}`);
        } else if (capped) {
          result.cappedTextures.set(src, capped);
          result.savedBytes += capped.saved;
          result.count++;
          continue;
        }
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
          // Optimization rides on compressModels unless explicitly turned off.
          const out = await compressGlbBuffer(original, { optimize: build.optimizeModels !== false });
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

/**
 * The build's resampled Basis derivative for one texture over the size cap,
 * or null when it ships at source size (under the cap, `maxSize: 0`, or its
 * dimensions/meta can't be read). Encoded into `Library/build-cache/basis/`
 * — never beside the source, where the editor's full-size `.basis` lives —
 * and reused while the source, cap and codec are unchanged.
 */
async function cappedBasisDerivative({
  invoke, src, meta, root, build, basisModeFor, imageDimensions, textureBuildSize, basisBuildCacheName,
}) {
  let size = null;
  try {
    const head = await invoke("read_binary_file_head", { path: src, maxBytes: 262144 });
    const dims = imageDimensions(head instanceof ArrayBuffer ? new Uint8Array(head) : head);
    size = dims && textureBuildSize(dims, meta, build.maxTextureSize);
  } catch {
    return null;
  }
  if (!size?.resized) return null;
  if (!meta) {
    // readAssetMeta answers null for "no meta" AND "unreadable meta"; a
    // generated meta must not replace one we couldn't read (flipY/colorSpace).
    const metaExists = await invoke("file_size", { path: `${src}.meta` }).then(() => true, () => false);
    if (metaExists) return null;
  }
  try {
    const mode = basisModeFor(src, meta);
    const mtime = await invoke("stat_file", { path: src });
    const cache = joinPath(
      root,
      `Library/build-cache/basis/${basisBuildCacheName(src, { mtime, mode, width: size.width, height: size.height })}`,
    );
    let compressed = await invoke("file_size", { path: cache }).catch(() => null);
    if (compressed == null) {
      const info = await invoke("compress_texture_basis", {
        path: src,
        mode,
        resample: [size.width, size.height],
        output: cache,
      });
      compressed = info?.compressed ?? 0;
    }
    const original = await invoke("file_size", { path: src }).catch(() => 0);
    return {
      cache,
      saved: Math.max(0, Number(original) - Number(compressed)),
      meta: { ...(meta ?? {}), basis: { enabled: true, mode, width: size.width, height: size.height } },
    };
  } catch (err) {
    return { error: err?.message ?? String(err) };
  }
}
