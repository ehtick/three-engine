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
    "Create a terrain: an entity with a Terrain component plus the heightmap and splat assets it needs. Sculpting and painting are brush work in the viewport and are not exposed as tools; what an agent can do is create the terrain, size it, and set its material layers with component.setProp.",
  params: {
    size: { type: "number", default: 50, description: "World size of one side, in metres." },
    resolution: { type: "number", default: 128, description: "Heightmap resolution per side, in samples." },
    name: { type: "string", default: "Terrain", description: "Entity name." },
  },
  async run({ size = 50, resolution = 128, name = "Terrain" }) {
    requireModule("terrain");
    requireProject();
    const { createTerrainAssets, assignTerrainAssets } = await import("../../terrainAssetSetup.js");
    const { CreateEntityCommand } = await import("../../commands/entityCommands.js");
    const { commandBus } = await import("../../commands/CommandBus.js");
    const assets = await createTerrainAssets({ size, resolution });
    const command = new CreateEntityCommand({ name, components: [{ type: "terrain", props: { size, resolution } }] });
    commandBus.execute(command);
    const entity = engine.getEntity(command.entityId);
    if (entity) assignTerrainAssets(entity, assets);
    await useProjectStore.getState().refresh();
    return { entityId: entity?.id ?? null, size, resolution, assets };
  },
});

// ---- build and publish -----------------------------------------------------

defineOp({
  name: "build.getSettings",
  readOnly: true,
  description:
    "The project's build settings — target, output folder, which scenes ship and which one boots, quality ceiling, compression — plus the resolved scene list those settings actually produce. Read this before build.export to see what a build would contain.",
  params: {},
  async run() {
    const { BUILD_DEFAULTS, resolveBuildScenes } = await import("../../build/buildSettings.js");
    const { getProjectSettings } = await import("../../projectSettings.js");
    const settings = getProjectSettings();
    const build = { ...BUILD_DEFAULTS, ...(settings.build ?? {}) };
    const available = (await import("../../assetLoader.js")).withoutSidecars(
      await (await import("../../assetLoader.js")).listProjectEntries(requireProject(), 8),
    )
      .filter((entry) => !entry.is_dir && entry.name.endsWith(".scene"))
      .map((entry) => entry.path.replaceAll("\\", "/"));
    const { currentScenePath } = await import("../../sceneIO.js");
    return {
      settings: build,
      resolved: resolveBuildScenes({
        available,
        build,
        mainScene: build.mainScene ?? "",
        openScene: currentScenePath() ?? "",
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
        "Keys from build.getSettings' `settings`, e.g. { target: 'web' | 'zip' | 'desktop', outDir, mainScene, scenes, quality, compress }.",
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
    "Run a build with the current settings: writes the player, the selected scenes and every asset they reference into the output folder. Minutes, not seconds, on a real project. Returns the report — output folder, scene and asset counts, bytes saved by compression, and any warnings, which are worth reading.",
  params: {
    target: { type: "string", enum: ["web", "zip", "desktop"], description: "Override the configured target for this run only." },
  },
  async run({ target }) {
    requireProject();
    const { exportGame } = await import("../../exportGame.js");
    const report = await exportGame(target ? { target } : {});
    if (!report.ok) throw new Error(report.error ?? "The build failed — check console.read for details.");
    return {
      outDir: report.outDir,
      target: report.target ?? target ?? null,
      scenes: report.sceneCount,
      assets: report.assetCount,
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
