// @ts-nocheck
import {
  extOf,
  TEXTURE_EXTENSIONS,
  SCRIPT_EXTENSIONS,
  AUDIO_EXTENSIONS,
  FONT_EXTENSIONS,
} from "./assetLoader.js";
import { openAssetPath } from "./openAsset.js";
import { openInIDE } from "./openInIde.js";
import { useSelectionStore } from "./store/selectionStore.js";
import { useProjectStore, basename } from "./store/projectStore.js";

/**
 * What you can do with an asset, as data.
 *
 * Every asset type already had actions scattered across the Assets panel's
 * context menu, the Inspector's ad-hoc buttons and the double-click handler —
 * three lists that disagreed. A `.mat` could be opened from two of them, a
 * `.timeline` from one, and there was no place that could answer "what *can*
 * I do with this file", which is precisely what someone selecting an unfamiliar
 * asset wants to know.
 *
 * So: one registry, consulted by the Inspector (which lists them) and
 * available to the context menu and to the editor API (so an agent driving the
 * editor can enumerate and run the same actions a user can — see
 * `api/ops/assets.js`).
 *
 * An action is `{ id, label, hint, icon, primary?, danger?, run() }`. `icon` is
 * a lucide icon *name*, not a component, so this module stays free of React and
 * can be imported by headless tests and the API layer.
 */

async function invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

const openPanel = (id) => import("./EditorShell.jsx").then((m) => m.openPanel(id));
const select = (path) => useSelectionStore.getState().selectAsset(path);

/** Human label for the editor that owns each extension. */
const EDITOR_LABEL = {
  scene: "Scene",
  mat: "Shader Graph",
  anim: "Animator",
  timeline: "Timeline",
  atlas: "Atlas Editor",
  geom: "Geometry Editor",
  prefab: "Prefab Mode",
  entity: "Prefab Mode",
  cubemap: "Inspector",
};

function textureActions(path) {
  return [
    {
      id: "texture.edit",
      label: "Edit in Texture Editor",
      hint: "Paint, adjust and filter this image with layers.",
      icon: "Brush",
      primary: true,
      run: () => openAssetPath(path),
    },
    {
      id: "texture.slice",
      label: "Slice into Sprites…",
      hint: "Cut a sprite sheet into an .atlas of named regions.",
      icon: "Grid3x3",
      run: async () => {
        // Reuses an atlas that already claims this image rather than making a
        // second one — two atlases over one sheet is how regions end up edited
        // in the wrong file.
        const { findAtlasForImage, createAtlasForImage } = await import("./atlasFile.js");
        const existing = await findAtlasForImage(path);
        const atlasPath = existing ?? (await createAtlasForImage(path));
        if (!existing) await useProjectStore.getState().refresh();
        openAssetPath(atlasPath);
      },
    },
    {
      id: "texture.material",
      label: "Create Material",
      hint: "New .mat beside this texture, wired to it as the base colour map.",
      icon: "Palette",
      run: async () => {
        const { createMaterialFromTexture } = await import("./assetOps.js");
        const created = await createMaterialFromTexture(path);
        if (created) select(created);
      },
    },
  ];
}

function modelActions(path) {
  return [
    {
      id: "model.unpack",
      label: "Unpack Model",
      hint: "Extract meshes, materials and textures into project assets plus a prefab.",
      icon: "PackageOpen",
      primary: true,
      run: async () => {
        const { unpackGlb } = await import("./glbImport.js");
        await unpackGlb(path);
      },
    },
    {
      id: "model.draco",
      label: "Compress (Draco)",
      hint: "Shrink the mesh data in place; decoded transparently at runtime.",
      icon: "Archive",
      available: async () => (await import("./dracoCompress.js")).isDracoEnabled(),
      run: async () => {
        const { compressGlbInPlace } = await import("./dracoCompress.js");
        await compressGlbInPlace(path);
      },
    },
  ];
}

function geometryActions(path) {
  return [
    {
      id: "asset.open",
      label: `Open in ${EDITOR_LABEL.geom}`,
      hint: "The editor that owns this asset type.",
      icon: "ExternalLink",
      primary: true,
      run: () => openAssetPath(path),
    },
    {
      id: "geom.exportGlb",
      label: "Export as GLB…",
      hint: "Write the mesh out as a .glb anything else can open — Blender, a marketplace, another project.",
      icon: "Download",
      run: async () => {
        const { exportGeometryAssetWithDialog } = await import("./geomExport.js");
        await exportGeometryAssetWithDialog(path);
      },
    },
  ];
}

function materialActions(path) {
  return [
    {
      id: "material.graph",
      label: "Open Shader Graph",
      hint: "A material is its shader graph — this is where it's authored.",
      icon: "Workflow",
      primary: true,
      run: () => {
        select(path);
        return openPanel("shaderGraph");
      },
    },
    {
      id: "material.assign",
      label: "Assign to Selected Entities",
      hint: "Sets the Mesh component's material on everything selected in the scene.",
      icon: "MousePointerClick",
      enabled: () => useSelectionStore.getState().ids.length > 0,
      run: async () => {
        const { commandBus } = await import("./commands/CommandBus.js");
        const { SetComponentPropCommand } = await import("./commands/componentCommands.js");
        for (const id of useSelectionStore.getState().ids) {
          commandBus.execute(new SetComponentPropCommand(id, "mesh", "material", path));
        }
      },
    },
  ];
}

function prefabActions(path) {
  return [
    {
      id: "prefab.open",
      label: "Open Prefab",
      hint: "Edit it in isolation; every linked instance follows the change.",
      icon: "Package",
      primary: true,
      run: async () => {
        const { openPrefabMode } = await import("./prefab.js");
        await openPrefabMode(path);
      },
    },
    {
      id: "prefab.instantiate",
      label: "Add to Scene",
      hint: "Drops a linked instance at the world origin.",
      icon: "Plus",
      run: async () => {
        const { instantiatePrefab } = await import("./prefab.js");
        await instantiatePrefab(path);
      },
    },
  ];
}

function sceneActions(path) {
  return [
    {
      id: "scene.open",
      label: "Open Scene",
      hint: "Replaces what's in the viewport. Unsaved changes are confirmed first.",
      icon: "Layers",
      primary: true,
      run: async () => {
        const { openScenePath } = await import("./sceneIO.js");
        await openScenePath(path);
      },
    },
    {
      id: "scene.startup",
      label: "Set as Main Scene",
      hint: "The scene the editor boots into and a built game loads first.",
      icon: "Play",
      run: async () => {
        // Stored project-relative on projectMeta, matching Project Settings —
        // an absolute path here would break the moment the project moved.
        const root = (useProjectStore.getState().rootPath ?? "").replaceAll("\\", "/");
        const full = path.replaceAll("\\", "/");
        const relative = full.toLowerCase().startsWith(`${root.toLowerCase()}/`)
          ? full.slice(root.length + 1)
          : full;
        await useProjectStore.getState().updateMeta({ mainScene: relative });
      },
    },
  ];
}

function fontActions(path) {
  return [
    {
      id: "font.uitext",
      label: "Use on Selected UI Text",
      hint: "Sets the Font Asset of every selected entity's UI Text component.",
      icon: "Type",
      primary: true,
      enabled: () => useSelectionStore.getState().ids.length > 0,
      run: async () => {
        const { commandBus } = await import("./commands/CommandBus.js");
        const { SetComponentPropCommand } = await import("./commands/componentCommands.js");
        for (const id of useSelectionStore.getState().ids) {
          commandBus.execute(new SetComponentPropCommand(id, "uitext", "fontAsset", path));
        }
      },
    },
    {
      id: "font.texttool",
      label: "Use in Texture Editor",
      hint: "Selects this font for the Text tool and opens the editor.",
      icon: "Brush",
      run: async () => {
        const { setTextToolFont } = await import("./textureEditorRequest.js");
        setTextToolFont(path);
        await openPanel("textureEditor");
      },
    },
    {
      id: "font.browse",
      label: "Find More Fonts",
      hint: "Search and import from Google Fonts without leaving the editor.",
      icon: "Search",
      run: () => openPanel("fontLibrary"),
    },
  ];
}

function scriptActions(path) {
  return [
    {
      id: "script.code",
      label: "Open in Code Editor",
      hint: "Full-size editor with autocomplete against the engine's declarations.",
      icon: "FileCode2",
      primary: true,
      run: async () => {
        const { openCodeFile } = await import("./codeStore.js");
        openCodeFile(path);
      },
    },
    {
      id: "script.attach",
      label: "Attach to Selected Entities",
      hint: "Adds a Script component pointing at this file.",
      icon: "Plus",
      enabled: () => useSelectionStore.getState().ids.length > 0,
      run: async () => {
        const { commandBus } = await import("./commands/CommandBus.js");
        const { AddComponentCommand } = await import("./commands/componentCommands.js");
        for (const id of useSelectionStore.getState().ids) {
          commandBus.execute(new AddComponentCommand(id, "script", { script: path }));
        }
      },
    },
  ];
}

/** Type-specific actions, keyed off the extension. */
function typeActions(path) {
  const ext = extOf(path);
  if (TEXTURE_EXTENSIONS.includes(ext)) return textureActions(path);
  if (FONT_EXTENSIONS.includes(ext)) return fontActions(path);
  if (SCRIPT_EXTENSIONS.includes(ext)) return scriptActions(path);
  if (ext === "glb") return modelActions(path);
  if (ext === "geom") return geometryActions(path);
  if (ext === "mat") return materialActions(path);
  if (ext === "prefab" || ext === "entity") return prefabActions(path);
  if (ext === "scene") return sceneActions(path);
  if (AUDIO_EXTENSIONS.includes(ext) && ext !== "audio") {
    return [
      {
        id: "audio.edit",
        label: "Open in Audio Editor",
        hint: "Trim, apply effects, build seamless loops and export.",
        icon: "AudioWaveform",
        primary: true,
        run: () => openAssetPath(path),
      },
    ];
  }
  if (EDITOR_LABEL[ext]) {
    return [
      {
        id: "asset.open",
        label: `Open in ${EDITOR_LABEL[ext]}`,
        hint: "The editor that owns this asset type.",
        icon: "ExternalLink",
        primary: true,
        run: () => openAssetPath(path),
      },
    ];
  }
  return [];
}

/**
 * Actions available for one asset, most useful first.
 *
 * The common tail — reveal, copy path, duplicate, delete — is appended for
 * every type, because those are exactly the operations someone hunts through
 * menus for and they have no reason to differ by extension.
 */
export function assetActions(path) {
  if (!path) return [];
  const ext = extOf(path);
  const actions = [...typeActions(path)];

  // Code editing is offered for anything the editor can show as text, not just
  // scripts: opening a `.mat` or a `.meta` to see what is actually in it is a
  // legitimate thing to want, and refusing is just an obstacle.
  if (!SCRIPT_EXTENSIONS.includes(ext)) {
    actions.push({
      id: "asset.source",
      label: "View Source",
      hint: "Open the raw file in the code editor.",
      icon: "Braces",
      // Resolved lazily: `isTextEditablePath` lives with the Monaco setup, and
      // pulling that graph in to build a menu would load the editor for
      // everyone who ever clicks an asset.
      available: async () => {
        const { isTextEditablePath } = await import("./code/monaco.js");
        return isTextEditablePath(path);
      },
      run: async () => {
        const { openCodeFile } = await import("./codeStore.js");
        openCodeFile(path);
      },
    });
  }

  actions.push(
    {
      id: "asset.reveal",
      label: "Show in File Explorer",
      hint: "Opens the containing folder with this file selected.",
      icon: "FolderOpen",
      run: async () => {
        const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
        await revealItemInDir(path);
      },
    },
    {
      id: "asset.copyPath",
      label: "Copy Path",
      hint: "The project-relative path, for pasting into a script.",
      icon: "Copy",
      run: async () => {
        const root = useProjectStore.getState().rootPath ?? "";
        const relative = path.replaceAll("\\", "/").replace(`${root.replaceAll("\\", "/")}/`, "");
        await navigator.clipboard.writeText(relative);
      },
    },
    {
      id: "asset.duplicate",
      label: "Duplicate",
      hint: "A copy beside it, named to avoid a collision.",
      icon: "CopyPlus",
      run: async () => {
        const { duplicateAsset } = await import("./assetOps.js");
        const created = await duplicateAsset(path);
        if (created) select(created);
      },
    },
    {
      id: "asset.externalIde",
      label: "Open in IDE",
      hint: "Hands the file to whatever your OS opens it with.",
      icon: "ExternalLink",
      run: () => openInIDE(path),
    },
    {
      id: "asset.delete",
      label: `Delete ${basename(path)}`,
      hint: "Moves the file (and its sidecars) to the recycle bin.",
      icon: "Trash2",
      danger: true,
      run: async () => {
        const { deleteEntries } = await import("./assetOps.js");
        await deleteEntries([{ path, name: basename(path), is_dir: false }]);
      },
    },
  );
  return actions;
}

/**
 * Runs an action by id. The one entry point the editor API uses, so an agent
 * and a user go through exactly the same code.
 */
export async function runAssetAction(path, id) {
  const action = assetActions(path).find((entry) => entry.id === id);
  if (!action) throw new Error(`No action "${id}" for ${basename(path)}`);
  if (action.enabled && !action.enabled()) throw new Error(`"${action.label}" is not available right now`);
  await action.run();
  return { path, action: id };
}

/** Action ids available for `path`, for menus and for the API's discovery op. */
export async function assetActionList(path) {
  const out = [];
  for (const action of assetActions(path)) {
    if (action.available && !(await action.available())) continue;
    out.push({
      id: action.id,
      label: action.label,
      hint: action.hint,
      primary: !!action.primary,
      danger: !!action.danger,
      enabled: action.enabled ? !!action.enabled() : true,
    });
  }
  return out;
}
