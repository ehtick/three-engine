/**
 * Rewrites one serialized component's asset references for a build.
 *
 * The runtime already discovers a scene's assets from component schemas
 * (`collectSceneAssets` in engine/sceneManager.js) — "a new component with an
 * `asset` field is preloaded the day it is added". The exporter used to be a
 * hand-maintained `if (c.type === …)` ladder instead, and every component it
 * fell behind on shipped scenes still pointing at the author's local files:
 * a Sprite's `texture`, a Decal's image, an Instancer's material override all
 * reached the browser as `C:\Users\…` paths that no server will serve.
 *
 * This walker is the exporter's half of the same contract: every schema field
 * of `type: "asset"` is claimed into the build, routed by the *value's*
 * extension — document formats (.mat, .atlas, .timeline, .audio) are re-emitted
 * by the exporter with their own inner paths rewritten, everything else is a
 * straight file copy. Prop shapes a schema field cannot express (script slot
 * lists, sound entries, a model's per-material override map) are handled here
 * too, so `exportGame` has exactly one place that knows how components
 * reference files.
 *
 * Pure on purpose: schema lookup and name allocation come in as callbacks, so
 * `npm run test:build` can drive this in Node with synthetic schemas.
 */

/** Document formats the exporter re-emits (with inner paths rewritten) rather
 *  than copies. The value names the collection bucket in `exportGame`. */
export const DOCUMENT_KINDS = {
  mat: "material",
  atlas: "atlas",
  timeline: "timeline",
  audio: "audio",
};

export const extOf = (path) => {
  const name = String(path).split(/[\\/]/).pop() ?? "";
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
};

/**
 * Every extension the exporter knows how to ship.
 *
 * Component asset fields are found by schema (`type: "asset"`), but a script's
 * `@attribute({ type: "asset", exts: ["mat"] })` values live in an untyped
 * `attributes` bag on a script slot — the component schema for `script`
 * describes the slot list, not what any individual script declares. So for
 * those the *value* is the only evidence, and a known asset extension is what
 * identifies one. A false positive costs one extra copied file; a false
 * negative ships `C:\Users\…\Thing.mat` to a browser, which fails with
 * "Not allowed to load local resource" and no indication of which of the
 * author's scripts is at fault.
 */
export const ASSET_EXTENSIONS = new Set([
  "mat", "atlas", "timeline", "audio", "cubemap", "geom", "anim", "post",
  "glb", "gltf",
  "png", "jpg", "jpeg", "webp", "basis", "ktx2", "hdr", "exr",
  "ogg", "oga", "wav", "mp3", "flac", "m4a", "opus",
  "ttf", "otf", "woff", "woff2",
]);

export const looksLikeAssetPath = (value) =>
  typeof value === "string" && value !== "" && ASSET_EXTENSIONS.has(extOf(value));

/** `.ts` authoring sources ship transpiled. */
const scriptRename = (name) => name.replace(/\.ts$/i, ".js");

/**
 * Rewrites the asset and prefab references a SCRIPT declares.
 *
 * `@attribute({ type: "asset", exts: ["mat"] }) ballMaterial = "…"` is a
 * documented part of the scripting API (see engine.d.ts), but its value is
 * stored in an untyped `attributes` bag on the script slot, one level below
 * anything the component schema or the prefab-path sweep reaches. Both walks
 * missed it, so a script's material/texture/prefab reference shipped as the
 * author's local absolute path and the browser refused to load it.
 *
 * Values are matched by shape rather than by declaration because the exporter
 * has no access to the script's decorators: it reads serialized scenes, and a
 * scene on disk records only the value. Nested objects and arrays are walked
 * too — an attribute can be a list of spawn definitions.
 */
function rewriteScriptAttributes(attributes, { rewrite, rewritePrefab }, depth = 0) {
  if (!attributes || typeof attributes !== "object" || depth > 6) return;
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === "string") {
      if (looksLikeAssetPath(value)) attributes[key] = rewrite(value);
      // A prefab reference is a path in the editor and a guid in a build; the
      // guid lookup returns the value untouched when it isn't a prefab path.
      else attributes[key] = rewritePrefab(value);
    } else if (value && typeof value === "object") {
      rewriteScriptAttributes(value, { rewrite, rewritePrefab }, depth + 1);
    }
  }
}

/**
 * @param component  serialized `{ type, props }` (mutated in place)
 * @param ctx {{
 *   getSchema: (type: string) => Array<{ key: string, type: string }> | undefined,
 *   claim: (path: string) => string,
 *   claimDoc: (path: string, rename?: (name: string) => string) => string,
 *   add: (kind: string, path: string) => void,
 *   rewritePrefab?: (value: string) => string,
 * }}
 *   `claim` copies a file into the build and returns its build-relative path;
 *   `claimDoc` reserves a destination for a re-emitted document; `add`
 *   registers the document's source under a `DOCUMENT_KINDS` bucket (or
 *   `"script"`) so the exporter reads and rewrites it later; `rewritePrefab`
 *   swaps an authoring prefab path for the guid a build resolves by.
 */
export function rewriteComponentAssets(
  component,
  { getSchema, claim, claimDoc, add, rewritePrefab = (v) => v },
) {
  const props = component?.props;
  if (!props) return;

  const rewrite = (value) => {
    if (typeof value !== "string" || !value) return value;
    const kind = DOCUMENT_KINDS[extOf(value)];
    if (!kind) return claim(value);
    add(kind, value);
    return claimDoc(value);
  };

  for (const field of getSchema(component.type) ?? []) {
    if (field?.type !== "asset") continue;
    const value = props[field.key];
    if (typeof value === "string" && value) props[field.key] = rewrite(value);
  }

  // Per-material overrides on an imported model are a name -> path map, not a
  // schema field (same carve-out `collectSceneAssets` makes).
  if (component.type === "model" && props.materials && typeof props.materials === "object") {
    for (const [name, value] of Object.entries(props.materials)) {
      if (typeof value === "string" && value) props.materials[name] = rewrite(value);
    }
  }

  // Script slots: every slot in the list ships transpiled, not copied. Legacy
  // `{ path }` components (an unopened scene on disk that never went through
  // normalizeProps) are rewritten IN PLACE — building a temp slot list and
  // rewriting that would ship the file but leave the scene pointing at the
  // authoring path.
  if (component.type === "script") {
    const claimScript = (path) => {
      add("script", path);
      return claimDoc(path, scriptRename);
    };
    if (Array.isArray(props.scripts)) {
      for (const slot of props.scripts) {
        if (slot?.path) slot.path = claimScript(slot.path);
        rewriteScriptAttributes(slot?.attributes, { rewrite, rewritePrefab });
      }
      delete props.path;
    } else if (typeof props.path === "string" && props.path) {
      props.path = claimScript(props.path);
      rewriteScriptAttributes(props.attributes, { rewrite, rewritePrefab });
    }
  }

  // Sound entries: `audioAsset` is the `.audio` sidecar path; the exporter
  // ships the sidecar JSON (inner `path` rewritten) plus the raw file.
  if (component.type === "sound") {
    for (const entry of props.entries ?? []) {
      if (typeof entry?.audioAsset === "string" && entry.audioAsset) {
        add("audio", entry.audioAsset);
        entry.audioAsset = claimDoc(entry.audioAsset);
      }
    }
  }
}
