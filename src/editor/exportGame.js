import { ensureEngine } from "./engineInstance.js";

const basename = (p) => p.split(/[\\/]/).pop();

/**
 * Exports the current scene as a standalone playable build: copies the
 * prebuilt player template (dist-player/, from `npm run build:player`),
 * writes scene.json, and copies every referenced asset into assets/,
 * rewriting scene paths to be relative. Serve the output folder with any
 * static server (module scripts don't run over file://).
 */
export async function exportGame() {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const outDir = await open({ directory: true, title: "Export Game To…" });
  if (!outDir) return;

  const engine = await ensureEngine();
  const { serializeScene, prefabRegistry } = await import("../engine/index.js");
  // Prefab defs ride along in the scene JSON: a build has no project to scan,
  // and instances (plus `engine.instantiate` from scripts) must resolve with
  // no I/O before the first frame.
  const scene = serializeScene(engine, { embedPrefabs: true });

  // Runtime-relevant project settings ride along in the scene JSON.
  const { getProjectSettings } = await import("./projectSettings.js");
  const { useProjectStore } = await import("./store/projectStore.js");
  const projectSettings = getProjectSettings();
  const meta = useProjectStore.getState();
  scene.player = {
    title: projectSettings.game.title || meta.projectMeta?.name || basename(meta.rootPath ?? "Game"),
    pixelRatioCap: projectSettings.rendering.pixelRatioCap,
  };
  // Enabled engine modules ride along so the player can boot them before
  // deserializing (their components must be registered to instantiate).
  const { useModulesStore } = await import("./modules.js");
  scene.modules = [...useModulesStore.getState().enabled];
  // Input config rides along — the player applies it on boot.
  scene.input = engine.input.toJSON();
  const assets = new Map(); // absolute source -> relative dest
  const scriptPaths = new Set(); // scripts ship transpiled, not copied
  const materialPaths = new Set(); // .mat files ship with rewritten texture paths
  const cubemapPaths = new Set(); // .cubemap files ship with rewritten face paths
  const audioSidecarPaths = new Set(); // .audio JSON files copied verbatim with path rewrites
  const claim = (p) => {
    if (!p || typeof p !== "string") return p;
    const rel = `assets/${basename(p)}`;
    assets.set(p, rel);
    return rel;
  };

  /**
   * A script can hold a prefab reference as a plain path string (that's what
   * the inspector's prefab field stores). Paths don't survive the trip into a
   * build, so swap them for the prefab's guid — which is stable and is what the
   * player's registry is keyed by. `engine.instantiate` accepts either.
   */
  const toPrefabGuid = (value) => {
    if (typeof value !== "string") return value;
    const guid = prefabRegistry.guidForPath(value);
    return guid ?? value;
  };
  const rewritePrefabRefs = (props) => {
    for (const [key, value] of Object.entries(props ?? {})) {
      if (typeof value === "string") props[key] = toPrefabGuid(value);
    }
  };

  const visitComponent = (c) => {
    rewritePrefabRefs(c.props);
    if (c.type === "mesh") {
      if (c.props.geometryAsset) c.props.geometryAsset = claim(c.props.geometryAsset);
      if (c.props.material) {
        materialPaths.add(c.props.material);
        c.props.material = `assets/${basename(c.props.material)}`;
      }
    } else if (c.type === "model") {
      c.props.path = claim(c.props.path) || c.props.path;
      for (const [name, matPath] of Object.entries(c.props.materials ?? {})) {
        materialPaths.add(matPath);
        c.props.materials[name] = `assets/${basename(matPath)}`;
      }
    } else if (c.type === "skinnedmesh" && c.props.material) {
      materialPaths.add(c.props.material);
      c.props.material = `assets/${basename(c.props.material)}`;
    } else if (c.type === "environment" && c.props.hdri) {
      c.props.hdri = claim(c.props.hdri);
    } else if (c.type === "animation" && c.props.controller) {
      c.props.controller = claim(c.props.controller);
    } else if (c.type === "script") {
      // Every slot in the list ships, not just the first. Legacy `{ path }`
      // components are still readable here: normalizeProps folds them into
      // `scripts` when the component loads, but an unopened scene on disk may
      // not have been through that yet.
      const slots = c.props.scripts ?? (c.props.path ? [{ path: c.props.path }] : []);
      for (const slot of slots) {
        if (!slot?.path) continue;
        scriptPaths.add(slot.path);
        slot.path = `assets/${basename(slot.path).replace(/\.ts$/i, ".js")}`;
      }
      if (c.props.scripts) delete c.props.path;
    } else if (c.type === "sound") {
      // Each entry's audioAsset is the sidecar path. Ship the sidecar JSON
      // (with its inner `path` rewritten to the assets folder) and the raw
      // audio file it points to. Both end up in `assets/` and the
      // runtime's asset resolver loads them by relative URL.
      for (const entry of c.props.entries ?? []) {
        if (!entry.audioAsset) continue;
        audioSidecarPaths.add(entry.audioAsset);
        entry.audioAsset = `assets/${basename(entry.audioAsset)}`;
      }
    }
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

  // Scene settings can reference a .cubemap (skybox / image-based lighting).
  // It ships like a .mat: the descriptor is rewritten, its faces are copied.
  if (scene.settings?.environment?.cubemap) {
    const src = scene.settings.environment.cubemap;
    cubemapPaths.add(src);
    scene.settings.environment.cubemap = `assets/${basename(src)}`;
  }

  scene.entities.forEach(visit);
  for (const def of scene.prefabs ?? []) {
    if (def.root) visit(def.root);
    for (const ov of def.overrides ?? []) visitOverride(ov); // variants
    // The registry in the build is keyed by guid; drop the authoring path so a
    // machine-specific absolute path doesn't ship inside the bundle.
    delete def.path;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  try {
    // Transpile TS scripts to plain JS files shipped alongside the scene.
    const { transpileScript } = await import("./assetLoader.js");
    const files = [];
    for (const src of scriptPaths) {
      const raw = await invoke("read_text_file", { path: src });
      files.push([`assets/${basename(src).replace(/\.ts$/i, ".js")}`, await transpileScript(raw)]);
    }
    for (const src of materialPaths) {
      const def = JSON.parse(await invoke("read_text_file", { path: src }));
      if (def.map) def.map = claim(def.map);
      for (const n of def.shaderGraph?.nodes ?? []) {
        if (n.type === "texture" && n.props?.path) n.props.path = claim(n.props.path);
      }
      files.push([`assets/${basename(src)}`, JSON.stringify(def)]);
    }
    const { normalizeCubemapDef, CUBEMAP_FACES } = await import("../engine/cubemapAsset.js");
    for (const src of cubemapPaths) {
      const def = normalizeCubemapDef(JSON.parse(await invoke("read_text_file", { path: src })));
      for (const { key } of CUBEMAP_FACES) {
        if (def.faces[key]) def.faces[key] = claim(def.faces[key]);
      }
      files.push([`assets/${basename(src)}`, JSON.stringify(def)]);
    }
    for (const src of audioSidecarPaths) {
      // Sidecar may reference a sibling raw audio file (def.path) — copy
      // that and rewrite the path. When the sidecar JSON is missing or has
      // no `path`, the runtime falls back to using the sidecar's own path
      // minus its `.audio` extension as the raw file (handled by
      // loadAudioAsset), so we also copy the raw-equivalent just in case.
      let def = null;
      try {
        def = JSON.parse(await invoke("read_text_file", { path: src }));
      } catch {
        def = null;
      }
      const rawPath = def?.path ?? src.replace(/\.audio$/i, "");
      if (def && def.path) def.path = claim(def.path);
      const sidecarBody = def ? JSON.stringify(def) : `{"path":"${basename(rawPath)}"}`;
      files.push([`assets/${basename(src)}`, sidecarBody]);
      // Best-effort: raw audio lives next to the sidecar typically. Copy
      // it when present; missing files are silently skipped (the runtime
      // will log on first play attempt).
      try {
        await invoke("stat_file", { path: rawPath });
        assets.set(rawPath, `assets/${basename(rawPath)}`);
      } catch {
        // Raw file missing — likely the sidecar pointed elsewhere.
      }
    }
    // Import settings ship as sidecar .meta files when present: textures
    // (filtering/wrap), models (virtual geometry), and geometry (GI ray proxy
    // import cache).
    for (const [src, rel] of [...assets.entries()]) {
      if (!/\.(png|jpe?g|webp|glb|geom)$/i.test(src)) continue;
      try {
        await invoke("stat_file", { path: `${src}.meta` });
        assets.set(`${src}.meta`, `${rel}.meta`);
        if (/\.(png|jpe?g|webp)$/i.test(src)) {
          const textureMeta = JSON.parse(
            await invoke("read_text_file", { path: `${src}.meta` }),
          );
          if (textureMeta?.basis?.enabled) {
            await invoke("stat_file", { path: `${src}.basis` });
            assets.set(`${src}.basis`, `${rel}.basis`);
          }
        }
      } catch {
        // No sidecar — defaults apply.
      }
    }
    // Per-asset build flags decide what actually ships and what the player
    // loads up front. Read once here, at the end, rather than in `claim` —
    // `claim` is called from a synchronous walk and the flags live on disk.
    const { readAssetFlags } = await import("./assetFlags.js");
    const preload = [];
    const excluded = [];
    const flagTargets = [
      ...[...assets.keys()].filter((src) => !/\.(meta|basis)$/i.test(src)),
      ...materialPaths,
    ];
    for (const src of flagTargets) {
      const flags = await readAssetFlags(src);
      if (flags.exclude) {
        excluded.push(basename(src));
        // Sidecars follow the asset out of the build.
        assets.delete(src);
        assets.delete(`${src}.meta`);
        assets.delete(`${src}.basis`);
        materialPaths.delete(src);
      } else if (flags.preload) {
        preload.push(assets.get(src) ?? `assets/${basename(src)}`);
      }
    }
    // The player fetches these before the first frame; everything else streams
    // in when the scene first asks for it.
    if (preload.length) scene.preload = [...new Set(preload)];
    if (excluded.length) {
      console.warn(
        `Excluded from build: ${excluded.join(", ")}. Anything in the scene that ` +
          `references them will fail to load at runtime.`,
      );
    }
    // Materials dropped by exclusion mustn't still be written into assets/.
    const shippedFiles = files.filter(([rel]) => {
      const stem = rel.replace(/^assets\//, "");
      return !excluded.includes(stem);
    });

    await invoke("export_game", {
      outDir,
      sceneJson: JSON.stringify(scene, null, 2),
      assets: [...assets.entries()],
      files: shippedFiles,
    });
    console.log(
      `Game exported to ${outDir} (${assets.size + shippedFiles.length} asset(s)` +
        `${preload.length ? `, ${preload.length} preloaded` : ""})`,
    );
  } catch (err) {
    console.error(`Export failed: ${err}`);
  }
}
