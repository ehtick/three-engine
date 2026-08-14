import {
  extOf,
  ATLAS_EXTENSIONS,
  TEXTURE_EXTENSIONS,
  SCRIPT_EXTENSIONS,
  MATERIAL_EXTENSIONS,
  ENVIRONMENT_EXTENSIONS,
  PREFAB_EXTENSIONS,
  ANIMATOR_EXTENSIONS,
  TIMELINE_EXTENSIONS,
  GEOMETRY_EXTENSIONS,
  AUDIO_EXTENSIONS,
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

/**
 * `.audio` is the JSON sidecar describing import options, not samples — the
 * Audio Editor has nothing to open for it, so it stays out of this list even
 * though it lives in AUDIO_EXTENSIONS.
 */
const isEditableAudio = (ext) => AUDIO_EXTENSIONS.includes(ext) && ext !== "audio";

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
    ENVIRONMENT_EXTENSIONS.includes(ext) ||
    MATERIAL_EXTENSIONS.includes(ext) ||
    GEOMETRY_EXTENSIONS.includes(ext) ||
    isEditableAudio(ext)
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
    // Opens in the editor's own code editor, not the OS's. Handing a script
    // to VS Code was the last thing in the pipeline that made you leave the
    // app for an everyday edit; "Open in IDE" is still one click away in the
    // Inspector and the context menu for when that's genuinely what you want.
    import("./codeStore.js").then((m) => m.openCodeFile(path));
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
  } else if (isEditableAudio(ext)) {
    useSelectionStore.getState().selectAsset(path);
    import("./EditorShell.jsx").then((m) => m.openPanel("audioEditor"));
  } else if (ENVIRONMENT_EXTENSIONS.includes(ext)) {
    // Skies live in the Inspector — cube-map face slots and the "use as scene
    // sky" action for an HDRI. There's no separate editor for either.
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
    // Anything else the code editor understands (`.json`, `.md`, `.wgsl`, a
    // stray `.txt`) opens in it; genuinely opaque files still go to the OS,
    // which is the only thing that knows what to do with them.
    import("./code/monaco.js").then(({ isTextEditablePath }) => {
      if (isTextEditablePath(path)) import("./codeStore.js").then((m) => m.openCodeFile(path));
      else openInIDE(path);
    });
  }
}
