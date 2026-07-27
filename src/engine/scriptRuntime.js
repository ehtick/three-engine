/**
 * Resolves the bare specifiers user scripts import.
 *
 * A script is loaded by fetching its source, transpiling it, and importing it
 * from a `blob:` URL. Bare specifiers (`"engine"`, `"three"`) mean nothing to
 * the browser in that context, and `blob:` is a non-hierarchical scheme, so
 * relative and root-absolute paths cannot be resolved against it either
 * ("Invalid relative url or base scheme isn't hierarchical"). `linkEngineImports`
 * therefore rewrites each supported specifier to a fully-qualified URL before
 * the import.
 *
 * ## How the target URLs are discovered
 *
 * Each specifier maps to a small proxy module under `./scriptRuntime/`. We
 * learn a proxy's URL by importing it and reading the `__SELF_URL__` it
 * exports — i.e. its own `import.meta.url`, evaluated inside the module.
 *
 * That indirection is the whole trick, and it is worth understanding before
 * changing it. The obvious alternative,
 *
 *     new URL('./scriptRuntime/threeRuntime.js', import.meta.url)
 *
 * is a build-time asset reference: Vite statically analyses that form and in a
 * production build inlines the target as a base64 `data:` URL. A `data:` URL
 * has no module-resolution base, so the proxy could not `import` three — which
 * is precisely why this file used to ship a hand-written allowlist of ~28
 * three classes read off a global, and why `import { InstancedMesh }` from a
 * user script silently produced `undefined`.
 *
 * Importing the proxy normally instead makes it a real chunk that the bundler
 * resolves like any other module. Its `import.meta.url` is then the dev server
 * URL (dev) or the emitted chunk's hashed URL (build) — absolute in both
 * cases, so a `blob:`-hosted script can import it. And because the proxy and
 * the engine both import the same bare `"three/webgpu"` specifier, they share
 * one module instance: script-side classes are the engine's constructors.
 *
 * The imports are lazy — nothing is fetched until the first user script is
 * linked, so projects with no scripts pay nothing.
 */

/**
 * Specifier → proxy module loader. Every entry resolves to a module exporting
 * `__SELF_URL__`.
 *
 * `"three"` and `"three/webgpu"` intentionally share one proxy. They are
 * distinct module instances with distinct class identities; if a script
 * imported the plain `three` build while the engine ran on `three/webgpu`,
 * its `Vector3` would not be the engine's `Vector3` and `instanceof` checks
 * would quietly fail. The webgpu build is a superset, so routing both here is
 * safe and keeps exactly one three in the bundle.
 */
const PROXY_LOADERS = {
  engine: () => import("./scriptRuntime/runtime.js"),
  editor: () => import("./scriptRuntime/editorRuntime.js"),
  three: () => import("./scriptRuntime/threeRuntime.js"),
  "three/webgpu": () => import("./scriptRuntime/threeRuntime.js"),
  "three/tsl": () => import("./scriptRuntime/tslRuntime.js"),
};

/**
 * Minimal stand-in for the `"engine"` module, used only when the real proxy
 * cannot be imported — plain Node (no DOM, and `three/webgpu` touches browser
 * globals at module scope). Covers `Script` and `attribute`, which is what
 * non-browser callers exercise; tests needing math import three directly.
 */
const NODE_FALLBACK_ENGINE = `data:text/javascript;charset=utf-8,${encodeURIComponent(`
export class Script {}
export function attribute(options = {}) {
  return function (target, key) {
    const ctor = target.constructor ?? target;
    if (!Object.prototype.hasOwnProperty.call(ctor, "attributes")) {
      ctor.attributes = { ...ctor.attributes };
    }
    ctor.attributes[key] = options;
  };
}
`)}`;

let urlsPromise = null;

/**
 * Maps every supported specifier to the absolute URL a user script should
 * import instead. Cached — the proxies' URLs are fixed for the lifetime of the
 * page.
 *
 * A proxy that fails to import is omitted rather than fatal, so one
 * unavailable surface (e.g. `three/tsl` in a non-browser context) does not
 * take down script loading entirely. `"engine"` additionally falls back to a
 * data URL so `Script` / `attribute` always resolve.
 */
export function resolveRuntimeUrls() {
  urlsPromise ??= (async () => {
    const entries = await Promise.all(
      Object.entries(PROXY_LOADERS).map(async ([specifier, load]) => {
        try {
          const mod = await load();
          return [specifier, mod.__SELF_URL__ ?? null];
        } catch (err) {
          if (specifier === "engine") return [specifier, NODE_FALLBACK_ENGINE];
          console.warn(
            `[scripts] "${specifier}" is unavailable to user scripts: ${err?.message ?? err}`,
          );
          return [specifier, null];
        }
      }),
    );
    return Object.fromEntries(entries.filter(([, url]) => url));
  })();
  return urlsPromise;
}

/** Escapes a specifier for literal use inside a RegExp. */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * Builds a matcher for one specifier. Covers every form a script can use it
 * in: `import x from "s"`, `import "s"`, `export { x } from "s"`, and the
 * dynamic `import("s")` (hence the optional paren — the previous version of
 * this regex missed dynamic imports entirely).
 *
 * The closing quote is back-referenced, so `"three"` cannot match inside
 * `"three/webgpu"` and the rewrite order between specifiers does not matter.
 */
const matcherFor = (specifier) =>
  new RegExp(`((?:from|import)\\s*\\(?\\s*)(["'])${escapeRe(specifier)}\\2`, "g");

/**
 * Rewrites the bare specifiers in a user script to absolute proxy URLs:
 *
 *   "engine"       → Script / attribute / three's math types
 *   "editor"       → the Editor API + @executeInEditMode / @menuItem
 *   "three"        → the full three/webgpu surface (same instance as the engine)
 *   "three/webgpu" → ditto
 *   "three/tsl"    → the full TSL surface (same instance as the engine)
 *
 * Anything else is left alone. Note that `"three/addons/*"` is NOT rewritten:
 * each addon is its own module and would need its own resolvable URL, so an
 * addon import still fails at load time with the browser's own "failed to
 * resolve module specifier" error rather than silently yielding `undefined`.
 */
export async function linkEngineImports(code) {
  const urls = await resolveRuntimeUrls();
  let out = code;
  for (const [specifier, url] of Object.entries(urls)) {
    out = out.replace(matcherFor(specifier), (_, lead, quote) => `${lead}${quote}${url}${quote}`);
  }
  return out;
}
