import {
  Boxes,
  Grid3x3,
  FileCode2,
  Files,
  Folder,
  Globe,
  Image,
  Layers,
  Package,
  Palette,
  Shapes,
  Type,
  Volume2,
  Workflow,
} from "lucide-react";
import {
  MODEL_IMPORT_EXTENSIONS,
  TEXTURE_EXTENSIONS,
  SCRIPT_EXTENSIONS,
  MATERIAL_EXTENSIONS,
  ENVIRONMENT_EXTENSIONS,
  PREFAB_EXTENSIONS,
  ANIMATOR_EXTENSIONS,
  GEOMETRY_EXTENSIONS,
  ATLAS_EXTENSIONS,
  AUDIO_EXTENSIONS,
  FONT_EXTENSIONS,
} from "./assetLoader.js";
import { getAssetFlags } from "./assetFlags.js";

/**
 * Type filter for the Assets panel. Extension lists are pulled from
 * assetLoader so a new format registered there shows up in the filter without
 * a second place to update.
 */
export const ASSET_TYPES = [
  { id: "all", label: "All Assets", Icon: Files, exts: null },
  { id: "folder", label: "Folders", Icon: Folder, exts: [], dirs: true },
  { id: "model", label: "Models", Icon: Boxes, exts: MODEL_IMPORT_EXTENSIONS },
  { id: "texture", label: "Textures", Icon: Image, exts: TEXTURE_EXTENSIONS },
  { id: "material", label: "Materials", Icon: Palette, exts: MATERIAL_EXTENSIONS },
  // Both shapes of a sky under one filter — a cube map and an HDRI are the same
  // thing to anyone looking for one. See src/engine/environmentAsset.js.
  { id: "cubemap", label: "Skies", Icon: Globe, exts: ENVIRONMENT_EXTENSIONS },
  { id: "geometry", label: "Geometry", Icon: Shapes, exts: GEOMETRY_EXTENSIONS },
  { id: "atlas", label: "Sprite Atlases", Icon: Grid3x3, exts: ATLAS_EXTENSIONS },
  { id: "prefab", label: "Prefabs", Icon: Package, exts: PREFAB_EXTENSIONS },
  { id: "scene", label: "Scenes", Icon: Layers, exts: ["scene"] },
  { id: "script", label: "Scripts", Icon: FileCode2, exts: SCRIPT_EXTENSIONS },
  { id: "animator", label: "Animators", Icon: Workflow, exts: ANIMATOR_EXTENSIONS },
  { id: "audio", label: "Audio", Icon: Volume2, exts: AUDIO_EXTENSIONS },
  { id: "font", label: "Fonts", Icon: Type, exts: FONT_EXTENSIONS },
];

export const assetType = (id) => ASSET_TYPES.find((type) => type.id === id) ?? ASSET_TYPES[0];

function matchesType(entry, typeId) {
  if (typeId === "all") return true;
  const type = assetType(typeId);
  if (entry.is_dir) return !!type.dirs;
  return type.exts?.includes(entry.ext) ?? false;
}

/**
 * Parses the search box into name terms and `tag:` terms. Both kinds AND
 * together, so "rock tag:cliff" means "named rock AND tagged cliff" — the
 * narrowing most people expect from a search box that accepts qualifiers.
 */
export function parseQuery(query) {
  const terms = String(query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const tags = [];
  const names = [];
  for (const term of terms) {
    if (term.startsWith("tag:")) {
      const tag = term.slice(4);
      if (tag) tags.push(tag);
    } else names.push(term);
  }
  return { names, tags, empty: !names.length && !tags.length };
}

function matchesQuery(entry, parsed) {
  if (parsed.empty) return true;
  const name = entry.name.toLowerCase();
  if (!parsed.names.every((term) => name.includes(term))) return false;
  if (!parsed.tags.length) return true;
  const tags = (getAssetFlags(entry.path).tags ?? []).map((tag) => tag.toLowerCase());
  return parsed.tags.every((term) => tags.some((tag) => tag.includes(term)));
}

/**
 * Applies the panel's three filters in sequence. `usedPaths` is null when the
 * "used by selection" filter is off; when on it's a Set of normalised paths,
 * and folders are kept only if something inside them is used — otherwise the
 * result is a flat list with no way to navigate to what it found.
 */
export function filterEntries(entries, { typeId = "all", query = "", usedPaths = null } = {}) {
  const parsed = parseQuery(query);
  const norm = (p) => String(p ?? "").replaceAll("\\", "/").toLowerCase();
  const usedPrefixes = usedPaths ? [...usedPaths] : null;
  return entries.filter((entry) => {
    if (usedPaths) {
      const path = norm(entry.path);
      const hit = entry.is_dir
        ? usedPrefixes.some((used) => used.startsWith(`${path}/`))
        : usedPaths.has(path);
      if (!hit) return false;
    }
    if (!matchesType(entry, typeId)) return false;
    return matchesQuery(entry, parsed);
  });
}
