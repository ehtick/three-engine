/**
 * The `three/webgpu` surface as user scripts see it.
 *
 * `linkEngineImports` rewrites `"three"`, `"three/webgpu"` and `"three/webgpu"`
 * imports in user scripts to this module's URL. It is a plain re-export, so
 * scripts get the WHOLE three surface — every class, every helper, whatever
 * version the engine is built against — with no allowlist to maintain.
 *
 * ## Why a re-export and not a hand-written list
 *
 * This file used to enumerate ~28 classes read off `globalThis.__ENGINE_THREE__`,
 * because the module was shipped as a `data:` URL (Vite inlines
 * `new URL('./x.js', import.meta.url)` at build time) and a data URL has no
 * module-resolution base — so it could not `import` three itself.
 *
 * The consequence was that `import { InstancedMesh } from "three/webgpu"` in a
 * user script silently evaluated to `undefined`, while
 * `import THREE from "three/webgpu"` (the default) handed back the entire
 * namespace. A 1%-complete wrapper that disagreed with itself.
 *
 * `scriptRuntime.js` now resolves this module's URL by dynamically importing
 * it and reading `__SELF_URL__` below, which makes it a real chunk at a real
 * http(s) URL with working module resolution. See that file for the details.
 *
 * ## Single instance
 *
 * Both this module and the engine import the bare `"three/webgpu"` specifier,
 * so the bundler (or Vite's dep pre-bundling in dev) hands both the same
 * module instance. User-script classes are therefore the same constructors the
 * engine uses — `instanceof` works across the boundary and there is no
 * duplicate three in the bundle.
 *
 * `"three"` is deliberately mapped here too rather than to the plain three
 * build. `three` and `three/webgpu` are separate module instances with
 * separate class identities; letting a script import the former would produce
 * a second copy of three whose `Vector3` is not the engine's `Vector3`. The
 * webgpu build is a superset, so pointing both specifiers here is both safe
 * and the only way to keep one instance.
 */
export * from "three/webgpu";

// `export *` deliberately skips `default`. Scripts written in the namespace
// idiom (`import THREE from "three/webgpu"`) got the whole namespace as the
// default export from the previous implementation, so keep that working.
import * as THREE_NS from "three/webgpu";
export default THREE_NS;

/**
 * This module's own absolute URL.
 *
 * In dev that is the Vite-served source URL; in a production build it is the
 * emitted chunk's hashed URL. Either way it is fully qualified, which is what
 * lets a user script loaded from a `blob:` URL import it — a relative or
 * root-absolute specifier cannot be resolved against a non-hierarchical base.
 *
 * `scriptRuntime.js` reads this instead of computing
 * `new URL('./threeRuntime.js', import.meta.url)` from the outside, because
 * that form is a build-time asset reference that Vite inlines as a `data:`
 * URL — which is exactly what forced the old allowlist.
 */
export const __SELF_URL__ = import.meta.url;
