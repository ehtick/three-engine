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

const extOf = (path) => {
  const name = String(path).split(/[\\/]/).pop() ?? "";
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
};

/** `.ts` authoring sources ship transpiled. */
const scriptRename = (name) => name.replace(/\.ts$/i, ".js");

/**
 * @param component  serialized `{ type, props }` (mutated in place)
 * @param ctx {{
 *   getSchema: (type: string) => Array<{ key: string, type: string }> | undefined,
 *   claim: (path: string) => string,
 *   claimDoc: (path: string, rename?: (name: string) => string) => string,
 *   add: (kind: string, path: string) => void,
 * }}
 *   `claim` copies a file into the build and returns its build-relative path;
 *   `claimDoc` reserves a destination for a re-emitted document; `add`
 *   registers the document's source under a `DOCUMENT_KINDS` bucket (or
 *   `"script"`) so the exporter reads and rewrites it later.
 */
export function rewriteComponentAssets(component, { getSchema, claim, claimDoc, add }) {
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
      }
      delete props.path;
    } else if (typeof props.path === "string" && props.path) {
      props.path = claimScript(props.path);
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
