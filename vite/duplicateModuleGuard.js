/**
 * Dev-only guard: says out loud when a source module is evaluated more than
 * once in the same page.
 *
 * ## Why this is worth a build plugin
 *
 * A module-level `const store = create(...)` / `const cache = new Map()` is a
 * singleton only while the module is evaluated once. In this app that is not
 * guaranteed: Vite rewrites `import()` specifiers for a changed module to a
 * `?t=<mtime>` URL, and a fresh URL is a fresh module instance — the previously
 * loaded copy stays live in React's tree. The editor reaches almost everything
 * heavy through dynamic imports, so any agent (or person) editing source while
 * the editor is open can end up with two of something stateful.
 *
 * The failure that follows is silent by construction: the second copy works
 * perfectly, it is just wired to nobody. MCP-driven edits land in one command
 * bus while the mounted panels subscribe to the other; an asset invalidation
 * clears one cache while the renderer reads the other. The engine really is
 * mutated, so everything autosaves and reappears correctly after a restart —
 * which is what makes people report it as "the feature does not work".
 *
 * `src/editor/singleton.js` (`vmSingleton`) and `src/engine/vmState.js` are the
 * fix. This is the detector: state that should have been wrapped and was not
 * now announces itself, by name, the moment it splits — instead of being
 * diagnosed from symptoms hours later.
 *
 * Serve-mode only. A production bundle evaluates each module exactly once, and
 * the check would be dead weight in a shipped game.
 */

/**
 * Injected verbatim, on ONE line so every line number in a stack trace still
 * matches the file on disk.
 *
 * Self-contained on purpose: importing a helper would give the guard the very
 * problem it detects, and would add an import edge to every module in the app.
 *
 * The key is the path from `/src/` onwards, so the two URL spellings of one
 * file — `/src/x.js` and `/@fs/C:/…/src/x.js` — compare equal. That pair is a
 * real duplication vector too; it bit a puppeteer harness once already.
 */
const PROBE =
  ';(()=>{try{' +
  'const g=globalThis,u=import.meta.url,i=u.indexOf("?"),p=i<0?u:u.slice(0,i),q=i<0?"":u.slice(i);' +
  'const key=p.replace(/^.*\\/src\\//,"src/");' +
  'const seen=(g.__moduleEvals??=new Map()),prev=seen.get(key);' +
  'if(prev===undefined){seen.set(key,q);return}' +
  'if(prev===q)return;' +
  'const dup=(g.__duplicateModules??=new Set());' +
  'if(dup.has(key))return;' +
  'dup.add(key);' +
  'console.warn("[duplicate module] "+key+" has been evaluated twice in this page ("+(prev||"<no query>")+" and "+(q||"<no query>")+"). Any module-level state in it is now SPLIT: writes through one copy are invisible to readers holding the other. Wrap it in vmSingleton (src/editor/singleton.js) or vmState (src/engine/vmState.js), or reload the page.");' +
  '}catch{}})();';

export function duplicateModuleGuard() {
  return {
    name: "engine:duplicate-module-guard",
    apply: "serve",
    transform(code, id) {
      // Our own source only. node_modules is pre-bundled into single instances
      // by esbuild, and instrumenting it would bury the signal.
      if (id.includes("node_modules")) return null;
      if (!/\/src\/.*\.(js|jsx)($|\?)/.test(id.replaceAll("\\", "/"))) return null;
      // The guard module itself is exempt for the obvious reason.
      if (id.includes("duplicateModuleGuard")) return null;
      return { code: PROBE + code, map: null };
    },
  };
}
