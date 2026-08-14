/**
 * The asset libraries: Poly Haven, ambientCG, Sketchfab, Poly Pizza and itch.io.
 *
 * Five browser panels with five different APIs, presented here as one
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
import { listProjectEntries, withoutSidecars } from "../../assetLoader.js";

/** Providers, and the module each one ships in. */
const PROVIDERS = {
  polyhaven: { module: "polyhaven", label: "Poly Haven", types: ["texture", "model", "hdri"], needsKey: false },
  ambientcg: { module: "ambientcg", label: "ambientCG", types: ["texture", "model", "hdri"], needsKey: false },
  sketchfab: { module: "sketchfab", label: "Sketchfab", types: ["model"], needsKey: true },
  polypizza: { module: "polypizza", label: "Poly Pizza", types: ["model"], needsKey: true },
  itchio: { module: "itchio", label: "itch.io", types: ["pack"], needsKey: true },
};

const providerIds = Object.keys(PROVIDERS);

/**
 * Poly Pizza's twelve fixed categories, duplicated from `polypizza.js`.
 *
 * Duplicated rather than imported because every provider in this file is
 * loaded dynamically inside `run()` — these ops are registered at editor boot
 * and must not drag six API clients into that import graph to describe their
 * own parameters. `run-library-test.mjs` asserts the two lists stay identical,
 * which is the part a copy actually needs.
 */
const POLYPIZZA_CATEGORIES = [
  "food-drink", "clutter", "weapons", "transport",
  "furniture-decor", "objects", "nature", "animals",
  "buildings", "people-characters", "scenes-levels", "other",
];

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

const slash = (path) => String(path ?? "").replaceAll("\\", "/");
const extensionOf = (path) => slash(path).split("/").pop()?.split(".").pop()?.toLowerCase() ?? "";

/**
 * The one file from an import that is worth acting on next.
 *
 * An import is not one file. A GLB unpacks into a folder of `.geom`, `.mat`,
 * textures AND a `.prefab`; a PBR set is 4-7 images plus a `.mat`. Handing back
 * that whole list and leaving the caller to work out which one to instantiate
 * is the gap this closes: an agent that has just imported a tree wants to place
 * a tree, and `paths[0]` is as likely to be a normal map as anything useful.
 *
 * The prefab cannot be derived from the folder name, because a name collision
 * suffixes the FOLDER (`Big Tree 2/`) while the prefab keeps the original stem
 * (`Big Tree.prefab`). So it is found by listing, not by construction.
 */
async function primaryAsset(paths) {
  const direct = paths.find((path) => extensionOf(path) === "prefab")
    ?? paths.find((path) => extensionOf(path) === "mat")
    ?? paths.find((path) => ["hdr", "exr"].includes(extensionOf(path)));
  if (direct) return direct;

  // Sketchfab and Poly Pizza hand back the unpack FOLDER rather than a file.
  for (const folder of paths) {
    try {
      const entries = withoutSidecars(await listProjectEntries(folder, 2));
      const prefab = entries.find((entry) => !entry.is_dir && extensionOf(entry.name) === "prefab");
      if (prefab) return slash(prefab.path);
    } catch {
      // Not a directory, or unreadable — try the next candidate.
    }
  }
  return null;
}

defineOp({
  name: "library.status",
  readOnly: true,
  description:
    "Which asset libraries can be searched right now: whether each module is enabled and whether the ones needing an account have a saved key. Call this first when a search fails — the answer is almost always a disabled module or a missing token, and both are fixable without guessing.",
  params: {},
  async run() {
    const enabled = useModulesStore.getState().enabled;
    const [sketchfab, polypizza, itchio] = await Promise.all([
      import("../../sketchfab.js").catch(() => null),
      import("../../polypizza.js").catch(() => null),
      import("../../itchio.js").catch(() => null),
    ]);
    const keys = {
      sketchfab: !!sketchfab?.getSavedToken?.(),
      polypizza: !!polypizza?.getSavedToken?.(),
      itchio: !!itchio?.getSavedToken?.(),
    };
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
    "Search one asset library. Returns `{ id, name, provider, type, tags, resolutions }` — pass an `id` straight to library.import. Poly Haven and ambientCG filter a full catalogue locally (so any word in the name, tags or categories matches); Sketchfab, Poly Pizza and itch.io query their own search. Poly Pizza additionally accepts `category`, `license` and `animated`, applied server-side. ⚠ With no `query` it needs at least one of them — there is no unfiltered browse — and `license` alone cannot mean 'any', since 'any' is expressed by omitting it. `people-characters` (their own label: 'Animated + Rigged Women, Men') plus `animated: true` is the way to find a rigged character.",
  params: {
    provider: { type: "string", required: true, enum: providerIds, description: "Which library to search." },
    query: { type: "string", default: "", description: "Free text. Omit to browse the most popular." },
    type: {
      type: "string",
      default: "texture",
      enum: ["texture", "model", "hdri", "pack"],
      description: "What kind of asset. Poly Haven and ambientCG have all three; Sketchfab and Poly Pizza are models only; itch.io is asset packs.",
    },
    category: {
      type: "string",
      enum: POLYPIZZA_CATEGORIES,
      description:
        "Poly Pizza only: one of its twelve fixed categories. `people-characters` and `animals` hold the rigged, animated models.",
    },
    license: {
      type: "string",
      enum: ["CC0", "CC-BY"],
      description:
        "Poly Pizza only: the catalogue is exactly two licences. Pass CC0 when the result must be usable with no credit line; CC-BY requires attribution (written to ATTRIBUTION.md on import). Omit for either.",
    },
    animated: {
      type: "boolean",
      description: "Poly Pizza only: return only models that ship with animation clips.",
    },
    limit: { type: "number", default: 20, description: "Maximum results (1-100)." },
  },
  async run({ provider, query = "", type = "texture", category = "", license = "", animated, limit = 20 }) {
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

    if (provider === "polypizza") {
      const { searchModels } = await import("../../polypizza.js");
      // The only provider here whose category/licence/animated filters run
      // SERVER-side, so they are passed through rather than applied to a page
      // of results — "an animated character" is one request, not a scan.
      const { models = [], total } = await searchModels({
        query,
        category,
        license,
        animated: animated === true ? true : undefined,
        limit: max,
      });
      return models.slice(0, max).map((model) => ({
        id: model.id,
        name: model.name,
        provider,
        type: "model",
        authors: [model.author].filter(Boolean),
        license: model.license,
        animated: model.animated,
        // Search results carry no triangle count — it is 0 here for every
        // model, and only `/model/{id}` knows the real number.
        triangles: model.triangles,
        // Surfaced so the mapping is checkable from outside the editor: a null
        // here is the machine-readable version of a grid full of placeholders.
        thumbnail: model.thumbnailUrl,
        total,
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
    "Import an asset from a library into the open project, exactly as the library's panel would: files land in the provider's folder, textures get their .meta colour-space flags, and attribution is written where the licence requires it. Returns `{ paths, primary, next }` — `primary` is the ONE file worth acting on (the .prefab for a model, the .mat for a PBR set, the .hdr for an environment) and `next` names the op that consumes it. Pass `instantiate: true` to place a model in the scene in the same call. The file import itself is NOT undoable; the entity it creates is.",
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
    instantiate: {
      type: "boolean",
      default: false,
      description:
        "Models only: spawn the imported prefab into the open scene and return its entityId, so finding a model and using it is one call rather than three.",
    },
    position: {
      type: "array",
      description: "Where to place it when `instantiate` is set. [x, y, z]; defaults to the origin.",
      items: { type: "number" },
    },
  },
  async run({ provider, id, type = "texture", resolution, uploadId, instantiate = false, position = null }) {
    requireProvider(provider);
    requireProject();

    /**
     * Turns whatever a download helper returned into one answer shape, and
     * optionally places it. Defined inside `run` because it closes over the
     * caller's `instantiate`/`position` — the alternative is threading both
     * through five provider branches that do not otherwise care about them.
     */
    const finish = async (result, extra = {}) => {
      const paths = asPaths(result);
      const primary = await primaryAsset(paths);
      const kind = primary ? extensionOf(primary) : null;
      const out = { paths, primary, ...extra };
      if (kind === "prefab") {
        out.next = "prefab.instantiate — pass `primary` as `path`.";
        if (instantiate) {
          const { instantiatePrefab } = await import("../../prefab.js");
          const entity = await instantiatePrefab(primary, position, null);
          if (!entity) throw new Error(`Imported ${primary}, but it could not be instantiated.`);
          out.entityId = entity.id;
          out.next = null;
        }
      } else if (kind === "mat") {
        out.next = "component.setProp — set a mesh's `material` to `primary`.";
      } else if (kind === "hdr" || kind === "exr") {
        out.next = "scene.setEnvironment — pass `primary` as `path`.";
      }
      // Asked for but not applicable: say so rather than silently ignoring it.
      if (instantiate && !out.entityId) {
        out.instantiateSkipped = primary
          ? `"${primary}" is not a prefab, so there is nothing to spawn.`
          : "This import produced no prefab to spawn.";
      }
      return out;
    };

    if (provider === "polyhaven") {
      const ph = await import("../../polyhaven.js");
      const [index, files] = await Promise.all([
        ph.fetchAssetIndex(type === "texture" ? "textures" : type === "model" ? "models" : "hdris"),
        ph.fetchAssetFiles(id),
      ]);
      const name = index.find((asset) => asset.id === id)?.name ?? String(id);
      const res = resolution ?? (type === "model" ? "1k" : "2k");
      if (type === "texture") return finish(await ph.downloadTexture({ name, files, res }));
      if (type === "model") return finish(await ph.downloadModel({ name, files, res }));
      return finish(await ph.downloadHdri({ name, files, res }));
    }

    if (provider === "ambientcg") {
      const acg = await import("../../ambientcg.js");
      const files = await acg.fetchAssetFiles(id);
      const name = String(id);
      const res = resolution ?? acg.RES_DEFAULTS?.[ACG_TYPE[type] ?? "Material"] ?? "2K-JPG";
      if (type === "texture") return finish(await acg.downloadTexture({ name, files, res }));
      if (type === "model") return finish(await acg.downloadModel({ name, files, res }));
      return finish(await acg.downloadHdri({ name, files, res }));
    }

    if (provider === "sketchfab") {
      const { searchModels, downloadModel } = await import("../../sketchfab.js");
      // Sketchfab's API has no "get one model" endpoint we use elsewhere; the
      // search result IS the download descriptor, so re-find it by uid.
      const { models = [] } = await searchModels(String(id));
      const model = models.find((m) => m.uid === id) ?? models[0];
      if (!model) throw new Error(`No Sketchfab model with uid "${id}" — search for it first.`);
      return finish(await downloadModel(model));
    }

    if (provider === "polypizza") {
      // Unlike Sketchfab, this one HAS a get-one-model endpoint, so an id can
      // be imported without re-running the search that found it — which
      // matters because the CDN filename is a storage uuid unrelated to the
      // id, and only the model record carries it.
      const { fetchModel, downloadModel } = await import("../../polypizza.js");
      const model = await fetchModel(String(id));
      if (!model?.downloadUrl) throw new Error(`Poly Pizza model "${id}" has no downloadable file.`);
      return finish(await downloadModel(model), { license: model.license, attribution: model.attribution });
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
    // itch.io packs are archives of loose files, not a single importable
    // asset, so there is no `primary` to hand back — the counts are the answer.
    return { folder: outcome.folder, imported: outcome.imported, copied: outcome.copied, skipped: outcome.skipped };
  },
});

defineOp({
  name: "scene.setEnvironment",
  undoable: true,
  description:
    "Point the scene's sky at an HDRI in the project. Writes the scene setting `environment.cubemap` (which accepts .hdr/.exr as well as .cubemap), so it is controllable in Scene Settings — intensity, rotation, sky blur, and whether it draws as a backdrop or only lights the scene. This is the step after importing an HDRI: the file on its own lights nothing. A scene that already carries an Environment component keeps using that instead; Scene Settings offers a one-click move.",
  params: { path: { type: "string", required: true, description: "Absolute path to an .hdr/.exr in the project." } },
  async run({ path }) {
    const { setSceneEnvironment } = await import("../../polyhaven.js");
    const { entity } = await setSceneEnvironment(path);
    return { hdri: path, entityId: entity?.id ?? null, via: entity ? "component" : "sceneSettings" };
  },
});
