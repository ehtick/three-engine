/**
 * The asset libraries: Poly Haven, ambientCG, Sketchfab and itch.io.
 *
 * Four browser panels with four different APIs, presented here as one
 * search-then-import pair. The panels each speak their provider's own dialect —
 * ambientCG calls a PBR set a "Material" and Poly Haven calls it a "texture",
 * resolutions are `2k` in one and `2K-JPG` in the other — and an agent should
 * not have to learn four vocabularies to find a rock texture. `library.search`
 * normalises the result shape; `library.import` takes what search returned.
 *
 * Everything here calls the same module the corresponding panel calls, so an
 * import made by an agent lands in the same folder, with the same `.meta`
 * sidecars and the same ATTRIBUTION/CREDITS bookkeeping, as one made by hand.
 * That is the property worth protecting: these libraries have licence terms,
 * and an agent-only import path would eventually forget one of them.
 *
 * ## Why import is not "download to a path"
 *
 * A texture on Poly Haven is 4-7 files that have to become one material; a
 * Sketchfab model is a zip that has to be unpacked, its textures rewritten and
 * its .glb repacked. `library.import` returns what it created rather than
 * taking a destination, because the provider decides how many files there are.
 */
import { defineOp } from "../registry.js";
import { useModulesStore } from "../../modules.js";
import { useProjectStore } from "../../store/projectStore.js";

/** Providers, and the module each one ships in. */
const PROVIDERS = {
  polyhaven: { module: "polyhaven", label: "Poly Haven", types: ["texture", "model", "hdri"], needsKey: false },
  ambientcg: { module: "ambientcg", label: "ambientCG", types: ["texture", "model", "hdri"], needsKey: false },
  sketchfab: { module: "sketchfab", label: "Sketchfab", types: ["model"], needsKey: true },
  itchio: { module: "itchio", label: "itch.io", types: ["pack"], needsKey: true },
};

const providerIds = Object.keys(PROVIDERS);

function requireProvider(id) {
  const provider = PROVIDERS[id];
  if (!provider) throw new Error(`Unknown library "${id}". Known: ${providerIds.join(", ")}`);
  if (!useModulesStore.getState().enabled.includes(provider.module)) {
    throw new Error(
      `The "${provider.module}" module is not enabled for this project. Enable it with module.setEnabled, or in the Modules panel.`,
    );
  }
  return provider;
}

function requireProject() {
  const root = useProjectStore.getState().rootPath;
  if (!root) throw new Error("No project is open — there is nowhere to import to.");
  return root;
}

/** ambientCG's dataType names for our three asset kinds. */
const ACG_TYPE = { texture: "Material", model: "3DModel", hdri: "HDRI" };

const matches = (haystack, needle) => !needle || String(haystack ?? "").toLowerCase().includes(needle.toLowerCase());

/**
 * Normalises what the download helpers return.
 *
 * They each hand back the thing that is *useful* for their asset kind — a
 * `.mat` path for a PBR set, a `.prefab` for an ambientCG model, a folder for a
 * Sketchfab unpack — and that is right for the panels, which show one link. An
 * automated caller wants a list it can pass to the next tool without knowing
 * which of the three shapes it got.
 */
const asPaths = (value) => {
  if (!value) return [];
  if (typeof value === "string") return [value.replaceAll("\\", "/")];
  if (Array.isArray(value)) return value.flatMap(asPaths);
  return Object.values(value).flatMap(asPaths);
};

defineOp({
  name: "library.status",
  readOnly: true,
  description:
    "Which asset libraries can be searched right now: whether each module is enabled and whether the ones needing an account have a saved key. Call this first when a search fails — the answer is almost always a disabled module or a missing token, and both are fixable without guessing.",
  params: {},
  async run() {
    const enabled = useModulesStore.getState().enabled;
    const [sketchfab, itchio] = await Promise.all([
      import("../../sketchfab.js").catch(() => null),
      import("../../itchio.js").catch(() => null),
    ]);
    const keys = { sketchfab: !!sketchfab?.getSavedToken?.(), itchio: !!itchio?.getSavedToken?.() };
    return {
      projectOpen: !!useProjectStore.getState().rootPath,
      providers: providerIds.map((id) => {
        const provider = PROVIDERS[id];
        const on = enabled.includes(provider.module);
        const hasKey = !provider.needsKey || keys[id];
        return {
          id,
          label: provider.label,
          types: provider.types,
          moduleEnabled: on,
          needsKey: provider.needsKey,
          ready: on && hasKey,
          note: !on
            ? `Enable the "${provider.module}" module.`
            : hasKey
              ? null
              : `No API token saved. Add one in the ${provider.label} panel.`,
        };
      }),
    };
  },
});

defineOp({
  name: "library.search",
  readOnly: true,
  description:
    "Search one asset library. Returns `{ id, name, provider, type, tags, resolutions }` — pass an `id` straight to library.import. Poly Haven and ambientCG filter a full catalogue locally (so any word in the name, tags or categories matches); Sketchfab and itch.io query their own search.",
  params: {
    provider: { type: "string", required: true, enum: providerIds, description: "Which library to search." },
    query: { type: "string", default: "", description: "Free text. Omit to browse the most popular." },
    type: {
      type: "string",
      default: "texture",
      enum: ["texture", "model", "hdri", "pack"],
      description: "What kind of asset. Poly Haven and ambientCG have all three; Sketchfab is models only; itch.io is asset packs.",
    },
    limit: { type: "number", default: 20, description: "Maximum results (1-100)." },
  },
  async run({ provider, query = "", type = "texture", limit = 20 }) {
    requireProvider(provider);
    const max = Math.max(1, Math.min(100, limit));

    if (provider === "polyhaven") {
      const { fetchAssetIndex } = await import("../../polyhaven.js");
      const index = await fetchAssetIndex(type === "texture" ? "textures" : type === "model" ? "models" : "hdris");
      return index
        .filter(
          (asset) =>
            matches(asset.name, query) ||
            (asset.tags ?? []).some((tag) => matches(tag, query)) ||
            (asset.categories ?? []).some((c) => matches(c, query)),
        )
        .slice(0, max)
        .map((asset) => ({
          id: asset.id,
          name: asset.name,
          provider,
          type,
          tags: asset.tags ?? [],
          authors: Object.keys(asset.authors ?? {}),
          downloads: asset.download_count ?? null,
        }));
    }

    if (provider === "ambientcg") {
      const { fetchAssetIndex } = await import("../../ambientcg.js");
      const index = await fetchAssetIndex({ type: ACG_TYPE[type] ?? "Material", query });
      return index.slice(0, max).map((asset) => ({
        id: asset.id ?? asset.assetId,
        name: asset.name ?? asset.assetId ?? asset.id,
        provider,
        type,
        tags: asset.tags ?? [],
        downloads: asset.downloadCount ?? null,
      }));
    }

    if (provider === "sketchfab") {
      const { searchModels } = await import("../../sketchfab.js");
      const { models = [] } = await searchModels(query);
      return models.slice(0, max).map((model) => ({
        id: model.uid,
        name: model.name,
        provider,
        type: "model",
        tags: (model.tags ?? []).map((t) => t.name ?? t),
        authors: [model.user?.displayName ?? model.user?.username].filter(Boolean),
        license: model.license?.label ?? null,
      }));
    }

    const { browseStore, searchStore } = await import("../../itchioStore.js");
    const { items = [] } = query ? await searchStore(query) : await browseStore({});
    return items.slice(0, max).map((item) => ({
      id: item.gameId,
      name: item.title,
      provider,
      type: "pack",
      author: item.author ?? null,
      price: item.price ?? null,
      url: item.url ?? null,
    }));
  },
});

defineOp({
  name: "library.import",
  description:
    "Import an asset from a library into the open project, exactly as the library's panel would: files land in the provider's folder, textures get their .meta colour-space flags, and attribution is written where the licence requires it. Returns the created paths. Nothing here is undoable — these are file imports, not editor commands.",
  params: {
    provider: { type: "string", required: true, enum: providerIds, description: "The library the id came from." },
    id: { type: "any", required: true, description: "The `id` from a library.search result." },
    type: {
      type: "string",
      default: "texture",
      enum: ["texture", "model", "hdri", "pack"],
      description: "Must match the type the id was found under.",
    },
    resolution: {
      type: "string",
      description:
        "Provider-specific resolution key — Poly Haven '1k'/'2k'/'4k', ambientCG '1K-JPG'/'2K-JPG'. Defaults to a sensible mid setting.",
    },
    uploadId: {
      type: "number",
      description: "itch.io only: which upload of the pack to fetch. Omit to take the first one available to you.",
    },
  },
  async run({ provider, id, type = "texture", resolution, uploadId }) {
    requireProvider(provider);
    requireProject();

    if (provider === "polyhaven") {
      const ph = await import("../../polyhaven.js");
      const [index, files] = await Promise.all([
        ph.fetchAssetIndex(type === "texture" ? "textures" : type === "model" ? "models" : "hdris"),
        ph.fetchAssetFiles(id),
      ]);
      const name = index.find((asset) => asset.id === id)?.name ?? String(id);
      const res = resolution ?? (type === "model" ? "1k" : "2k");
      if (type === "texture") return { paths: asPaths(await ph.downloadTexture({ name, files, res })) };
      if (type === "model") return { paths: asPaths(await ph.downloadModel({ name, files, res })) };
      return { paths: asPaths(await ph.downloadHdri({ name, files, res })) };
    }

    if (provider === "ambientcg") {
      const acg = await import("../../ambientcg.js");
      const files = await acg.fetchAssetFiles(id);
      const name = String(id);
      const res = resolution ?? acg.RES_DEFAULTS?.[ACG_TYPE[type] ?? "Material"] ?? "2K-JPG";
      if (type === "texture") return { paths: asPaths(await acg.downloadTexture({ name, files, res })) };
      if (type === "model") return { paths: asPaths(await acg.downloadModel({ name, files, res })) };
      return { paths: asPaths(await acg.downloadHdri({ name, files, res })) };
    }

    if (provider === "sketchfab") {
      const { searchModels, downloadModel } = await import("../../sketchfab.js");
      // Sketchfab's API has no "get one model" endpoint we use elsewhere; the
      // search result IS the download descriptor, so re-find it by uid.
      const { models = [] } = await searchModels(String(id));
      const model = models.find((m) => m.uid === id) ?? models[0];
      if (!model) throw new Error(`No Sketchfab model with uid "${id}" — search for it first.`);
      return { paths: asPaths(await downloadModel(model)) };
    }

    const itch = await import("../../itchio.js");
    const uploads = await itch.fetchUploads(id);
    if (!uploads?.length) {
      throw new Error(
        `itch.io returned no downloadable uploads for game ${id}. Paid packs you do not own cannot be imported — open the page and buy it first.`,
      );
    }
    const upload = uploadId ? uploads.find((u) => u.id === uploadId) : uploads[0];
    if (!upload) throw new Error(`No upload ${uploadId} on game ${id}. Available: ${uploads.map((u) => u.id).join(", ")}`);
    const outcome = await itch.downloadAndImport({ game: { id, title: String(id) }, upload });
    return { folder: outcome.folder, imported: outcome.imported, copied: outcome.copied, skipped: outcome.skipped };
  },
});

defineOp({
  name: "scene.setEnvironment",
  undoable: true,
  description:
    "Point the scene's lighting environment at an HDRI in the project. Reuses the scene's existing Environment component if there is one, otherwise creates an Environment entity carrying it. This is the step after importing an HDRI — the file on its own lights nothing.",
  params: { path: { type: "string", required: true, description: "Absolute path to an .hdr/.exr in the project." } },
  async run({ path }) {
    const { setSceneEnvironment } = await import("../../polyhaven.js");
    const entity = await setSceneEnvironment(path);
    return { entityId: entity?.id ?? null, hdri: path };
  },
});
