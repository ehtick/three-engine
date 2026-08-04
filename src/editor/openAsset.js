import {
  extOf,
  ATLAS_EXTENSIONS,
  TEXTURE_EXTENSIONS,
  SCRIPT_EXTENSIONS,
  MATERIAL_EXTENSIONS,
  CUBEMAP_EXTENSIONS,
  PREFAB_EXTENSIONS,
  ANIMATOR_EXTENSIONS,
  TIMELINE_EXTENSIONS,
  GEOMETRY_EXTENSIONS,
} from "./assetLoader.js";
import { useProjectStore, basename } from "./store/projectStore.js";
import { useSceneStore } from "./store/sceneStore.js";
import { useSelectionStore } from "./store/selectionStore.js";
import { openScenePath } from "./sceneIO.js";
import { openPrefabMode } from "./prefab.js";
import { openInIDE } from "./openInIde.js";

/**
 * "Open this asset in whatever editor owns it."
 *
 * Lifted out of the Assets panel's double-click handler so the inspector's
 * asset slots can offer the same action from their context menu — an asset
 * reference should behave the same wherever the user meets it.
 */

/**
 * The Geometry Editor edits a live mesh on an entity, not a file — so opening a
 * .geom means finding an entity that uses it and editing that. Selecting the
 * asset itself would leave the editor with nothing to act on.
 */
function openGeometryAsset(path) {
  const key = (p) => String(p ?? "").replaceAll("\\", "/");
  const entities = useSceneStore.getState().entities;
  const match = Object.values(entities).find(
    (entity) => key(entity?.components?.mesh?.geometryAsset) === key(path),
  );
  if (!match) {
    console.warn(
      `No entity in the scene uses "${basename(path)}" — ` +
        `drag it onto an entity's Mesh (or into the scene) to edit it.`,
    );
    return;
  }
  useSelectionStore.getState().select(match.id);
  import("./EditorShell.jsx").then((m) => m.openPanel("geometryEditor"));
}

/** True when `openAssetPath` has a dedicated editor for this file. */
export function hasAssetEditor(path) {
  const ext = extOf(path);
  return (
    ext === "scene" ||
    TEXTURE_EXTENSIONS.includes(ext) ||
    ATLAS_EXTENSIONS.includes(ext) ||
    SCRIPT_EXTENSIONS.includes(ext) ||
    PREFAB_EXTENSIONS.includes(ext) ||
    ANIMATOR_EXTENSIONS.includes(ext) ||
    TIMELINE_EXTENSIONS.includes(ext) ||
    CUBEMAP_EXTENSIONS.includes(ext) ||
    MATERIAL_EXTENSIONS.includes(ext) ||
    GEOMETRY_EXTENSIONS.includes(ext)
  );
}

export function openAssetPath(path, { isDir = false } = {}) {
  if (!path) return;
  if (isDir) {
    useProjectStore.getState().navigate(path);
    return;
  }
  const ext = extOf(path);
  if (SCRIPT_EXTENSIONS.includes(ext)) {
    openInIDE(path);
  } else if (ext === "scene") {
    openScenePath(path).catch((err) => console.error(String(err)));
  } else if (PREFAB_EXTENSIONS.includes(ext)) {
    // Opens the prefab in isolation, like Unity's Prefab Mode.
    openPrefabMode(path).catch((err) => console.error(String(err)));
  } else if (ANIMATOR_EXTENSIONS.includes(ext)) {
    useSelectionStore.getState().selectAsset(path);
    import("./EditorShell.jsx").then((m) => m.openPanel("animator"));
  } else if (TIMELINE_EXTENSIONS.includes(ext)) {
    useSelectionStore.getState().selectAsset(path);
    import("./EditorShell.jsx").then((m) => m.openPanel("timeline"));
  } else if (CUBEMAP_EXTENSIONS.includes(ext)) {
    // Face slots live in the Inspector — there's no separate cube map editor.
    useSelectionStore.getState().selectAsset(path);
    import("./EditorShell.jsx").then((m) => m.openPanel("inspector"));
  } else if (MATERIAL_EXTENSIONS.includes(ext)) {
    // A material *is* its shader graph — that's the only editor for it.
    useSelectionStore.getState().selectAsset(path);
    import("./EditorShell.jsx").then((m) => m.openPanel("shaderGraph"));
  } else if (ATLAS_EXTENSIONS.includes(ext)) {
    // A sprite atlas opens the same panel, in its Atlas mode.
    useSelectionStore.getState().selectAsset(path);
    import("./EditorShell.jsx").then((m) => m.openPanel("textureEditor"));
  } else if (TEXTURE_EXTENSIONS.includes(ext)) {
    // Images open in the Texture Editor rather than the OS image viewer. The
    // panel gates itself on the `texture-editor` module, so a project that has
    // not enabled it gets an explanation and a button rather than nothing.
    useSelectionStore.getState().selectAsset(path);
    import("./EditorShell.jsx").then((m) => m.openPanel("textureEditor"));
  } else if (GEOMETRY_EXTENSIONS.includes(ext)) {
    openGeometryAsset(path);
  } else {
    openInIDE(path);
  }
}
