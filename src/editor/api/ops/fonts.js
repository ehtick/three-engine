/**
 * Fonts, the code editor, and the asset-action registry — the three surfaces
 * added alongside the Inspector rework, exposed so an agent can drive them.
 *
 * The rule this file exists to satisfy: a feature is not done until an agent
 * can do through the MCP server what a person can do through the UI. Without
 * these, an assistant asked to "make the score readout use the pixel font"
 * could see the file in `asset.list` and had no way to import one, inspect
 * one, or attach one — the capability would have been invisible rather than
 * missing, which is the failure mode worth preventing.
 */
import { defineOp } from "../registry.js";
import { useProjectStore } from "../../store/projectStore.js";
import { listProjectAssets, FONT_EXTENSIONS } from "../../assetLoader.js";
import { assetActionList, runAssetAction } from "../../assetActions.js";
import { fetchFontCatalog, importGoogleFont, parseVariant } from "../../fontLibrary.js";

const norm = (p) => String(p ?? "").replaceAll("\\", "/");

function projectRoot() {
  const root = useProjectStore.getState().rootPath;
  if (!root) throw new Error("No project is open.");
  return root;
}

defineOp({
  name: "font.list",
  readOnly: true,
  description:
    "List the font files in the project, with the CSS family name each is registered under. Use that family for UiText.fontAsset or a canvas font string.",
  params: {},
  async run() {
    const root = projectRoot();
    const paths = await listProjectAssets(root, FONT_EXTENSIONS, 8);
    const { fontFamilyFor } = await import("../../../engine/ui/fontAsset.js");
    return {
      fonts: paths.map((path) => ({
        path: norm(path),
        name: norm(path).split("/").pop(),
        family: fontFamilyFor(path),
      })),
    };
  },
});

defineOp({
  name: "font.inspect",
  readOnly: true,
  description:
    "Read a font file's own metadata: family and style names, weight, glyph and codepoint counts, which scripts it covers, and whether its licence permits embedding it in a build.",
  params: {
    path: { type: "string", required: true, description: "Absolute path to a .ttf, .otf, .woff or .woff2." },
  },
  async run({ path }) {
    const { ensureFontLoaded } = await import("../../../engine/ui/fontAsset.js");
    const entry = await ensureFontLoaded(path);
    if (!entry) throw new Error(`Could not read "${path}".`);
    return {
      path: norm(path),
      family: entry.family,
      displayName: entry.displayName,
      loaded: entry.loaded,
      // WOFF2 hides its tables behind brotli, so `readable: false` here means
      // "the font works, its metadata cannot be read" — not "broken file".
      meta: entry.meta,
    };
  },
});

defineOp({
  name: "font.search",
  readOnly: true,
  description:
    "Search the Google Fonts catalog by name, designer or category without leaving the editor. Returns families with their available weights, so font.import can be called with a specific set.",
  params: {
    query: { type: "string", description: "Name, designer or subset to match. Omit to browse by popularity." },
    category: { type: "string", description: "e.g. 'Sans Serif', 'Serif', 'Display', 'Handwriting', 'Monospace'." },
    limit: { type: "number", default: 20, description: "How many families to return." },
  },
  async run({ query, category, limit = 20 }) {
    const catalog = await fetchFontCatalog();
    const terms = String(query ?? "").trim().toLowerCase();
    const results = catalog
      .filter((entry) => {
        if (category && entry.category.toLowerCase() !== category.toLowerCase()) return false;
        if (!terms) return true;
        return (
          entry.family.toLowerCase().includes(terms) ||
          entry.designers.some((name) => name.toLowerCase().includes(terms))
        );
      })
      .slice(0, Math.max(1, Math.min(100, limit)))
      .map((entry) => ({
        family: entry.family,
        category: entry.category,
        variants: entry.variants.map((variant) => variant.key),
        variable: entry.variable,
        designers: entry.designers,
        openSource: entry.openSource,
      }));
    return { count: results.length, fonts: results };
  },
});

defineOp({
  name: "font.import",
  description:
    "Download a Google Fonts family into <project>/Fonts/<Family>/ as TrueType files, ready to assign. Weights are keys like '400', '700', '400i' (italic); omit for Regular only.",
  params: {
    family: { type: "string", required: true, description: "Exact family name, e.g. 'Press Start 2P'." },
    variants: {
      type: "array",
      description: "Weight keys to fetch, e.g. ['400','700']. Defaults to Regular.",
    },
  },
  async run({ family, variants }) {
    projectRoot();
    const wanted = (variants?.length ? variants : ["400"]).map((key) => parseVariant(String(key)));
    const written = await importGoogleFont(family, wanted);
    // The family NAME is what a text surface asks for, not a file path — see
    // fonts.js on generated family names.
    return {
      family,
      files: written.map(norm),
      next: "Use the family name (not a file path) wherever a font is selected.",
    };
  },
});

defineOp({
  name: "asset.actions",
  readOnly: true,
  description:
    "List what can be done with an asset — the same actions the Inspector shows — as ids you can pass to asset.runAction. Use this to discover per-type capabilities instead of guessing.",
  params: {
    path: { type: "string", required: true, description: "Absolute path to a project asset." },
  },
  async run({ path }) {
    return { path: norm(path), actions: await assetActionList(path) };
  },
});

defineOp({
  name: "asset.runAction",
  description:
    "Run one of the actions asset.actions listed — unpack a model, create a material from a texture, set a main scene, attach a script to the selection, and so on.",
  params: {
    path: { type: "string", required: true, description: "Absolute path to a project asset." },
    action: { type: "string", required: true, description: "Action id from asset.actions, e.g. 'texture.material'." },
  },
  async run({ path, action }) {
    return runAssetAction(path, action);
  },
});

defineOp({
  name: "code.open",
  description:
    "Open a project file in the editor's built-in code editor so the user can see what you are describing. Does not modify the file.",
  params: {
    path: { type: "string", required: true, description: "Absolute path to a text file in the project." },
  },
  async run({ path }) {
    const { openCodeFile } = await import("../../codeStore.js");
    openCodeFile(path);
    return { opened: norm(path) };
  },
});

defineOp({
  name: "code.openFiles",
  readOnly: true,
  description:
    "List the files open in the code editor and which of them have unsaved edits — worth checking before writing to a file the user may be editing.",
  params: {},
  async run() {
    const { useCodeStore } = await import("../../codeStore.js");
    const state = useCodeStore.getState();
    return {
      files: state.files.map(norm),
      active: state.activePath ? norm(state.activePath) : null,
      unsaved: state.dirtyPaths().map(norm),
    };
  },
});
