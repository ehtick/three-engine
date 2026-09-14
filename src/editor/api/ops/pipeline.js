/**
 * The asset pipeline and the ship pipeline: compression, baking, building,
 * publishing.
 *
 * These are the panel buttons that take a while and change files rather than
 * the scene — Draco-compress a model, transcode a texture to Basis, bake a
 * navmesh, export a build, publish it. None of them belong on the undo stack
 * (they write files, or they talk to a host), and each one is gated on the
 * module that owns it exactly as the panel is: a project that has not enabled
 * `basis` should not end up with `.basis` files in it because an agent asked
 * nicely.
 *
 * ## Why baking is here and not on the component
 *
 * `component.setProp` can change a navmesh's cell size, but nothing about
 * setting a property runs recast — the panel has a Bake button for the same
 * reason, because a rebake on every keystroke in a number field is not
 * something anyone wants. So the settings are props and the bake is an op.
 */
import { defineOp } from "../registry.js";
import { engine } from "../../engineInstance.js";
import { useModulesStore } from "../../modules.js";
import { useProjectStore } from "../../store/projectStore.js";

function requireModule(id) {
  if (!useModulesStore.getState().enabled.includes(id)) {
    throw new Error(`The "${id}" module is not enabled for this project. Enable it with module.setEnabled.`);
  }
}

function requireProject() {
  const root = useProjectStore.getState().rootPath;
  if (!root) throw new Error("No project is open.");
  return root;
}

// ---- compression -----------------------------------------------------------

defineOp({
  name: "asset.compress",
  description:
    "Compress an asset in place with the codec for its type: Draco for .glb geometry, Basis/KTX2 for images. Both are lossy-but-visually-lossless transport formats — the editor keeps loading the original and the build ships the compressed one. Returns the before/after sizes so the trade is visible.",
  params: {
    path: { type: "string", required: true, description: "Absolute path to a .glb or an image in the project." },
    codec: {
      type: "string",
      default: "auto",
      enum: ["auto", "draco", "basis"],
      description: "'auto' picks by file type: draco for .glb, basis for images.",
    },
  },
  async run({ path, codec = "auto" }) {
    requireProject();
    const ext = path.split(".").pop()?.toLowerCase();
    const chosen = codec === "auto" ? (ext === "glb" ? "draco" : "basis") : codec;

    if (chosen === "draco") {
      requireModule("draco");
      const { compressGlbInPlace } = await import("../../dracoCompress.js");
      const result = await compressGlbInPlace(path);
      return { path, codec: "draco", ...result };
    }

    requireModule("basis");
    const { compressTextureBasis } = await import("../../basisCompress.js");
    const result = await compressTextureBasis(path);
    return { path, codec: "basis", ...result };
  },
});

defineOp({
  name: "asset.compressAllTextures",
  description:
    "Transcode every texture in the project to Basis/KTX2. This is the bulk version of asset.compress and can take minutes on a large project — it is the same button the Modules panel offers, with the same throttling. Textures whose .meta carries basis.enabled:false are SKIPPED and counted in `skipped`; pass force:true to re-encode those too, which is what you want after the codec rules change.",
  params: {
    force: {
      type: "boolean",
      description:
        "Re-encode textures that opted out (basis.enabled:false) and re-enable them. Use after an encoder change — an opt-out set as damage control looks identical to a deliberate one, so without this the bulk pass silently does nothing on exactly the textures that need fixing.",
    },
  },
  async run({ force = false }) {
    requireModule("basis");
    requireProject();
    const { compressAllProjectTextures } = await import("../../basisCompress.js");
    return (await compressAllProjectTextures({ force })) ?? { ok: true };
  },
});

// ---- navigation ------------------------------------------------------------

defineOp({
  name: "nav.bake",
  description:
    "Bake the scene's navmesh from its geometry and write it to a .navmesh asset. Bake settings (cell size, agent radius/height, slope) live on the NavMesh component — set them with component.setProp first, then bake. Returns the asset path and what recast produced.",
  params: {
    entityId: {
      type: "string",
      description: "Entity carrying the NavMesh component. Omit to use the only one in the scene.",
    },
    path: { type: "string", description: "Where to write the .navmesh. Defaults to the component's current asset." },
  },
  async run({ entityId, path }) {
    requireModule("navigation");
    const hosts = [...engine.entities.values()].filter((e) => e.getComponent?.("navmesh"));
    if (!hosts.length) {
      throw new Error("No NavMesh component in the scene. Add one with component.add(type: 'navmesh') first.");
    }
    const host = entityId ? hosts.find((e) => e.id === entityId) : hosts[0];
    if (!host) throw new Error(`Entity "${entityId}" has no NavMesh component.`);
    if (!entityId && hosts.length > 1) {
      throw new Error(`${hosts.length} entities carry a NavMesh component — pass entityId to say which to bake.`);
    }
    const component = host.getComponent("navmesh");
    const target = path ?? component.props?.data;
    if (!target) {
      throw new Error("No output path — pass `path`, or set the component's Baked Data asset first.");
    }
    const result = await component.bakeAndSave(target);
    await useProjectStore.getState().refresh();
    return { entityId: host.id, path: target, ...(result ?? {}) };
  },
});

// ---- terrain ---------------------------------------------------------------

defineOp({
  name: "terrain.create",
  undoable: true,
  description:
    "Create a terrain: an entity with a Terrain component plus the heightmap and splat assets it needs. Pass `style` to generate it procedurally from the style-driven landscape (meadow | hills | highlands | alpine | canyon | karst | shattered) with its six controls (height, scale, levels, wildness, erosion, rocks — each 0..1 except height 0..2 and scale .4..2.5, .5 being the style's designed look); `rocks` > 0 also builds the style's stone structures (cliff walls, spires, arches, ledges, talus). Omit `style` for a flat sculptable heightfield. Painting is brush work in the viewport and is not exposed as a tool; sculpting is (terrain.sculpt, which lands as a delta on a procedural base); every control is also a component.setProp.",
  params: {
    size: { type: "number", default: 50, description: "World size of one side, in metres. Styles are designed at 512-2048 m; a smaller terrain gets a miniature of the style." },
    resolution: { type: "number", default: 128, description: "Heightmap resolution per side, in samples." },
    name: { type: "string", default: "Terrain", description: "Entity name." },
    style: { type: "string", description: "Procedural landscape style. Omit for a flat heightfield." },
    seed: { type: "number", description: "Procedural seed (default 1)." },
    height: { type: "number", description: "Vertical scale, 0-2 (default 1)." },
    scale: { type: "number", description: "Feature size, .4-2.5 (default 1)." },
    levels: { type: "number", description: "Benches and plateaus separated by cliffs, 0-1 (default .5)." },
    wildness: { type: "number", description: "Exaggeration: sharper crests, taller cliffs, more towers, 0-1 (default .5)." },
    erosion: { type: "number", description: "Carved valleys and gullies, 0-1 (default .5)." },
    rocks: { type: "number", description: "Stone structures, 0-1 (default .5)." },
  },
  async run({ size = 50, resolution = 128, name = "Terrain", style, seed, height, scale, levels, wildness, erosion, rocks }) {
    requireModule("terrain");
    requireProject();
    const { createTerrainAssets, assignTerrainAssets } = await import("../../terrainAssetSetup.js");
    const { CreateEntityCommand } = await import("../../commands/entityCommands.js");
    const { commandBus } = await import("../../commands/CommandBus.js");
    const { TERRAIN_STYLES } = await import("../../../engine/terrain/proceduralTerrain.js");
    if (style !== undefined && !TERRAIN_STYLES.includes(style)) throw new Error(`Unknown terrain style "${style}" — one of ${TERRAIN_STYLES.join(", ")}.`);
    const procedural = style === undefined ? {} : Object.fromEntries(Object.entries({ procedural: true, style, proceduralSeed: seed, height, scale, levels, wildness, erosion, rocks })
      .filter(([, value]) => value !== undefined));
    const assets = await createTerrainAssets({ size, resolution });
    const command = new CreateEntityCommand({ name, components: [{ type: "terrain", props: { size, resolution, ...procedural } }] });
    commandBus.execute(command);
    const entity = engine.getEntity(command.entityId);
    if (entity) assignTerrainAssets(entity, assets);
    await useProjectStore.getState().refresh();
    return { entityId: entity?.id ?? null, size, resolution, assets };
  },
});

defineOp({
  name: "terrain.sculpt",
  undoable: true,
  description:
    "Apply ONE sculpt stroke to a terrain — the same brush the viewport's pointer drag uses (`TerrainComponent.applyHeightBrush` per dab, `commitHeights` at the end, one undo entry), so an agent can shape terrain and, just as important, MEASURE what a stroke costs: the freeze ledger names the dab (`terrain:brush`), the stroke commit (`terrain:stroke-commit`) and the scatter re-seat (`terrain:scatter`), and everything that reacts to the committed heights afterwards (foliage re-layout, the GI reflection-BVH resync, colliders) shows up in profile.freezes with its own owner. Dabs are laid evenly along the straight line from (x, z) to (x2, z2) in WORLD space, at the brush's own cadence; omit x2/z2 for a single dab. Returns the main-thread ms the dabs and the commit took.",
  params: {
    entityId: { type: "string", description: "The terrain entity. Defaults to the only terrain in the scene." },
    x: { type: "number", required: true, description: "World X of the stroke start." },
    z: { type: "number", required: true, description: "World Z of the stroke start." },
    x2: { type: "number", description: "World X of the stroke end (defaults to x)." },
    z2: { type: "number", description: "World Z of the stroke end (defaults to z)." },
    tool: { type: "string", default: "raise", description: "raise | lower | smooth | flatten | sharpen | erode | noise | pinch | contrast." },
    radius: { type: "number", default: 4, description: "Brush radius in metres." },
    strength: { type: "number", default: 1, description: "Brush strength, on the viewport's own scale (a viewport dab applies 0.15 × strength)." },
    hardness: { type: "number", default: 0.5, description: "Falloff hardness 0-1." },
    dabs: { type: "number", default: 12, description: "How many dabs along the line (1-200)." },
  },
  async run({ entityId, x, z, x2, z2, tool = "raise", radius = 4, strength = 1, hardness = 0.5, dabs = 12 }) {
    requireModule("terrain");
    const hosts = [...engine.entities.values()].filter((e) => e.getComponent?.("terrain"));
    const host = entityId ? engine.getEntity(entityId) : hosts[0];
    const component = host?.getComponent?.("terrain");
    if (!component || typeof component.applyHeightBrush !== "function") {
      throw new Error(entityId ? `Entity "${entityId}" has no Terrain component.` : "No Terrain component in the scene — terrain.create first.");
    }
    if (!entityId && hosts.length > 1) {
      throw new Error(`${hosts.length} entities carry a Terrain component — pass entityId to say which to sculpt.`);
    }
    const THREE = await import("three/webgpu");
    const { SetTerrainHeightsCommand } = await import("../../commands/terrainCommands.js");
    const { commandBus } = await import("../../commands/CommandBus.js");
    const count = Math.max(1, Math.min(200, Math.round(Number(dabs) || 1)));
    const endX = Number.isFinite(Number(x2)) ? Number(x2) : Number(x);
    const endZ = Number.isFinite(Number(z2)) ? Number(z2) : Number(z);
    const before = component.props.heights;
    const object = host.object3D;
    object?.updateWorldMatrix?.(true, false);
    const local = new THREE.Vector3();
    const t0 = performance.now();
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0 : i / (count - 1);
      local.set(Number(x) + (endX - Number(x)) * t, 0, Number(z) + (endZ - Number(z)) * t);
      if (object) object.worldToLocal(local);
      local.y = component.heightAtLocal?.(local.x, local.z) ?? 0;
      component.applyHeightBrush(local, {
        tool: String(tool),
        radius: Math.max(0.01, Number(radius) || 4),
        strength: (Number(strength) || 1) * 0.15,
        hardness: Math.max(0, Math.min(1, Number(hardness) || 0.5)),
        falloff: null,
        flattenHeight: local.y,
        seed: 0,
      });
    }
    const dabMs = performance.now() - t0;
    const t1 = performance.now();
    component.commitHeights();
    commandBus.execute(new SetTerrainHeightsCommand(host.id, before, component.props.heights));
    const commitMs = performance.now() - t1;
    return {
      entityId: host.id,
      dabs: count,
      dabMs: +dabMs.toFixed(1),
      commitMs: +commitMs.toFixed(1),
      note: "dabMs is the brush itself (O(brush area) per dab); commitMs is the stroke end — full normals, bounding sphere, scatter re-seat, heights encode. What reacts to the commit (foliage, GI, colliders) lands in later frames: read profile.freezes for those.",
    };
  },
});

// ---- build and publish -----------------------------------------------------

defineOp({
  name: "build.getSettings",
  readOnly: true,
  description:
    "The project's build settings — target, which scenes ship and which one boots, quality ceiling, compression, runtime trimming — plus the resolved scene plan. `scenes: null` (the default) ships the start scene plus every scene it can reach — the plan then lists only the seed and build.export's `sceneList` the final set; 'all' ships every scene; an array is an explicit list. A build ships only the assets the chosen scenes (and the prefabs and scripts they reach) reference; an asset flagged Exclude never ships, a prefab flagged Preload always does.",
  params: {},
  async run() {
    const { BUILD_DEFAULTS, resolveBuildScenes, toProjectRelative } = await import("../../build/buildSettings.js");
    const { getProjectSettings } = await import("../../projectSettings.js");
    const { useProjectStore } = await import("../../store/projectStore.js");
    const root = requireProject();
    const settings = getProjectSettings();
    const build = { ...BUILD_DEFAULTS, ...(settings.build ?? {}) };
    // Project-relative, exactly as the exporter resolves them — the listing is
    // absolute, and comparing that against the relative build list reported
    // every listed scene as "no longer exists".
    const { withoutSidecars, listProjectEntries } = await import("../../assetLoader.js");
    const available = withoutSidecars(await listProjectEntries(root, 8))
      .filter((entry) => !entry.is_dir && entry.name.endsWith(".scene"))
      .map((entry) => toProjectRelative(root, entry.path));
    const { currentScenePath } = await import("../../sceneIO.js");
    const open = currentScenePath();
    return {
      settings: build,
      resolved: resolveBuildScenes({
        available,
        build,
        mainScene: useProjectStore.getState().projectMeta?.mainScene ?? "",
        openScene: open ? toProjectRelative(root, open) : "",
      }),
    };
  },
});

defineOp({
  name: "build.setSettings",
  description:
    "Change build settings. Merged into what is there, so pass only what you are changing. Saved to project.json, the same as pressing Save in the Build panel.",
  params: {
    patch: {
      type: "object",
      required: true,
      description:
        "Keys from build.getSettings' `settings`, e.g. { target: 'web' | 'zip' | 'desktop', startScene, scenes (null = the start scene + what it reaches, 'all' = every scene, or an array of project-relative paths), quality, compressTextures, compressModels, trimRuntime, icon, loading, pagesProject }.",
    },
  },
  async run({ patch }) {
    const { getProjectSettings, saveProjectSettings } = await import("../../projectSettings.js");
    const settings = getProjectSettings();
    const next = { ...settings, build: { ...(settings.build ?? {}), ...patch } };
    await saveProjectSettings(next);
    return { settings: next.build };
  },
});

defineOp({
  name: "build.export",
  description:
    "Run a build with the current settings: writes the player runtime (trimmed to the modules the game enables), the selected scenes, the prefabs they can reach and every asset those reference into the output folder, and removes files a previous build left there. Minutes, not seconds, on a real project. Returns the report — output folder, scene/prefab/asset counts, leftover files removed, runtime files shipped vs left out, and any warnings, which are worth reading.",
  params: {
    target: { type: "string", enum: ["web", "zip", "desktop"], description: "Override the configured target for this run only." },
  },
  async run({ target }) {
    requireProject();
    const { exportGame } = await import("../../exportGame.js");
    const report = await exportGame(target ? { buildOverride: { target } } : {});
    if (!report.ok) throw new Error(report.error ?? "The build failed — check console.read for details.");
    return {
      outDir: report.outDir,
      target: report.target ?? target ?? null,
      scenes: report.sceneCount,
      sceneList: report.scenes ?? [],
      sceneMode: report.sceneMode ?? null,
      prefabs: report.prefabCount ?? 0,
      prefabsLeftOut: report.prefabsSkipped ?? 0,
      assets: report.assetCount,
      removed: report.removed ?? [],
      runtime: report.runtime ?? null,
      warnings: report.warnings ?? [],
    };
  },
});

defineOp({
  name: "build.publish",
  description:
    "Build and publish to Cloudflare Pages, returning the public URL. THE FIRST PUBLISH OPENS A BROWSER WINDOW for the user to log in to Cloudflare — it cannot complete unattended, so tell them to expect it. Subsequent publishes reuse the saved login.",
  params: {},
  async run() {
    requireProject();
    const { publishToPages } = await import("../../publishGame.js");
    const result = await publishToPages({});
    if (!result?.url) throw new Error(result?.error ?? "Publish did not return a URL — check console.read.");
    return { url: result.url, project: result.project ?? null };
  },
});

defineOp({
  name: "build.preview",
  description:
    "Serve the last build on a local address and return the URL, so it can be opened in a real browser. This is how a WebGPU build gets tested outside the editor's own webview.",
  params: {
    lan: { type: "boolean", default: false, description: "Serve on the LAN address (with TLS) instead of localhost, for testing on a phone." },
  },
  async run({ lan = false }) {
    const { invoke } = await import("../../assetOps.js");
    const { getProjectSettings } = await import("../../projectSettings.js");
    const { BUILD_DEFAULTS } = await import("../../build/buildSettings.js");
    const build = { ...BUILD_DEFAULTS, ...(getProjectSettings().build ?? {}) };
    const dir = `${requireProject()}/${build.outDir ?? "Build"}`;
    const url = await invoke(lan ? "serve_build_lan" : "serve_build", { dir });
    return { url, dir, lan };
  },
});

defineOp({
  name: "build.serve",
  description:
    "Start, stop or inspect the LIVE preview server — the one behind the Wi-Fi button in the viewport toolbar. Unlike build.preview (a one-shot static serve of the last build), this rebuilds and re-serves the project on every edit, and it is STICKY: a project left serving starts serving again the next time the editor opens, until it is stopped. Omit `enabled` to read the current state. Starting it leaves Play mode, because it exports the authored scene rather than a scene gameplay has already mutated.",
  params: {
    enabled: {
      type: "boolean",
      description: "true to start serving (and remember it for this project), false to stop (and forget it).",
    },
  },
  async run({ enabled }) {
    const preview = await import("../../browserPreview.js");
    if (enabled !== undefined) {
      requireProject();
      const running = !!preview.getActiveBrowserPreview();
      // toggleBrowserPreview flips; call it only when the ask differs from the
      // world, so `enabled: true` twice doesn't take a running server down.
      if (!!enabled !== running) await preview.toggleBrowserPreview();
    }
    const state = preview.getBrowserPreviewState();
    return {
      running: !!state.urls,
      localUrl: state.urls?.localUrl ?? null,
      lanUrl: state.urls?.lanUrl ?? null,
      shareUrl: state.share?.url ?? null,
      startsWithEditor: preview.isBrowserPreviewAutoStart(),
      busy: state.busy,
      message: state.message,
    };
  },
});
