// A READ-ONLY Tauri IPC shim for puppeteer harnesses.
//
// Everything the editor knows about a project — the asset browser, .mat/.geom/
// .glb loading, scripts — goes through `invoke()` from @tauri-apps/api, which
// dispatches to `window.__TAURI_INTERNALS__.invoke`. In a plain browser that
// object doesn't exist, so no harness could ever open a real project; each one
// hand-rebuilt a scene from parsed JSON instead, and therefore could never
// reproduce anything that depends on the real asset pipeline.
//
// This installs that missing object and proxies it to Node's fs. WRITE commands
// are refused by default: a harness must never mutate the user's project. A
// harness that genuinely needs writes (testing "save creates the asset" flows)
// passes `writableRoot` — a scratch directory it owns — and only writes landing
// inside that directory are served. Everything outside it still fails loudly.
import fs from "node:fs";
import path from "node:path";

const WRITE_COMMANDS = new Set([
  "save_scene",
  "write_binary_file",
  "create_dir",
  "rename_path",
  "delete_path",
  "import_files",
  "export_game",
  "compress_texture_basis",
  "scaffold_three_types",
]);

const norm = (p) => path.resolve(String(p ?? "")).replaceAll("\\", "/").toLowerCase();
const isInside = (root, target) => {
  const r = norm(root);
  const t = norm(target);
  return t === r || t.startsWith(`${r}/`);
};

function listDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).map((e) => {
    const full = path.join(dir, e.name);
    let size = 0;
    let modified = 0;
    try {
      const stat = fs.statSync(full);
      size = e.isDirectory() ? 0 : stat.size;
      modified = stat.mtimeMs / 1000;
    } catch {
      // Unreadable entry (permissions, a broken link) — report it with zeroes
      // rather than failing the whole listing, which is what the Rust command
      // effectively does via its `.ok()` on metadata.
    }
    return {
      name: e.name,
      path: full,
      is_dir: e.isDirectory(),
      ext: path.extname(e.name).slice(1).toLowerCase(),
      size,
      modified,
    };
  });
  entries.sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  return entries;
}

/**
 * Handles one invoke() call in Node. Binary reads come back as a plain array of
 * bytes because that's all that survives the puppeteer bridge; the page side
 * turns it back into an ArrayBuffer, which is what the real IPC channel gives
 * `invoke` for a `tauri::ipc::Response`.
 */
function handle(cmd, args = {}, writableRoot = null) {
  if (WRITE_COMMANDS.has(cmd)) {
    const target = args.path ?? args.destination ?? args.dest;
    if (!writableRoot || !target || !isInside(writableRoot, target)) {
      throw new Error(`tauriShim: refusing write command "${cmd}" outside the harness scratch root`);
    }
    switch (cmd) {
      case "save_scene":
        fs.mkdirSync(path.dirname(args.path), { recursive: true });
        fs.writeFileSync(args.path, args.contents ?? "", "utf8");
        return null;
      case "write_binary_file":
        fs.mkdirSync(path.dirname(args.path), { recursive: true });
        fs.writeFileSync(args.path, Buffer.from(args.contents ?? []));
        return null;
      case "create_dir":
        fs.mkdirSync(args.path, { recursive: true });
        return null;
      case "delete_path":
        fs.rmSync(args.path, { recursive: true, force: true });
        return null;
      // scaffold_three_types is a no-op the editor calls on every Assets mount;
      // succeeding silently keeps it out of the harness's error log.
      case "scaffold_three_types":
        return null;
      default:
        throw new Error(`tauriShim: write command "${cmd}" is not implemented`);
    }
  }
  switch (cmd) {
    case "list_dir":
      return listDir(args.path);
    case "read_text_file":
    case "load_scene":
      return fs.readFileSync(args.path, "utf8");
    case "read_binary_file":
      return { __bytes: [...fs.readFileSync(args.path)] };
    case "read_binary_file_head": {
      const fd = fs.openSync(args.path, "r");
      const max = Number(args.maxBytes ?? args.max_bytes ?? 65536);
      const buf = Buffer.alloc(max);
      const read = fs.readSync(fd, buf, 0, max, 0);
      fs.closeSync(fd);
      return { __bytes: [...buf.subarray(0, read)] };
    }
    case "file_size":
      return fs.statSync(args.path).size;
    case "stat_file":
      return fs.statSync(args.path).mtimeMs / 1000;
    default:
      throw new Error(`tauriShim: unhandled command "${cmd}"`);
  }
}

/**
 * Installs the shim on a puppeteer page. Must be called BEFORE `page.goto` —
 * the editor's stores read `__TAURI_INTERNALS__` during module evaluation.
 */
export async function installTauriShim(
  page,
  { verbose = false, writableRoot = null, extraCommands = {} } = {},
) {
  const extraNames = Object.keys(extraCommands);
  await page.exposeFunction("__tauriShimInvoke", async (cmd, args) => {
    try {
      // Harness-supplied handlers win, so a test can stand in for a Rust
      // command this shim has no business implementing generically (the PTY
      // commands, for instance — there is no pseudo-terminal in a browser).
      const result = extraCommands[cmd]
        ? await extraCommands[cmd](args ?? {})
        : handle(cmd, args, writableRoot);
      if (verbose) console.log(`  [tauri] ${cmd} ${args?.path ?? ""}`);
      return { ok: true, result: result === undefined ? null : result };
    } catch (err) {
      if (verbose) console.log(`  [tauri] ${cmd} FAILED: ${err.message}`);
      return { ok: false, error: String(err.message ?? err) };
    }
  });
  await page.evaluateOnNewDocument((names) => {
    let callbackId = 0;
    const callbacks = new Map();
    // event name -> Set of callback ids, so the harness can emit into whatever
    // the app called `listen()` for. Tauri routes `listen` through invoke, so
    // without this every event-driven feature is untestable in a browser.
    const listeners = new Map();

    /** Delivers `payload` to everything listening for `event`. */
    window.__tauriShimEmit = (event, payload) => {
      const ids = listeners.get(event);
      if (!ids) return 0;
      for (const id of [...ids]) window[`_${id}`]?.({ event, id, payload });
      return ids.size;
    };
    window.__tauriShimListenerCount = (event) => listeners.get(event)?.size ?? 0;
    window.__tauriShimExtraCommands = names;

    window.__TAURI_INTERNALS__ = {
      async invoke(cmd, args) {
        // The event plugin is pure bookkeeping — answer it here rather than
        // round-tripping to Node, which has no idea what the page listens to.
        if (cmd === "plugin:event|listen") {
          const { event, handler } = args ?? {};
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event).add(handler);
          return handler;
        }
        if (cmd === "plugin:event|unlisten") {
          listeners.get(args?.event)?.delete(args?.eventId);
          return null;
        }
        const { ok, result, error } = await window.__tauriShimInvoke(cmd, args ?? {});
        if (!ok) throw new Error(error);
        // `read_binary_file` resolves to an ArrayBuffer over the real IPC
        // channel; callers feed it straight to `new Blob([...])`.
        if (result && typeof result === "object" && Array.isArray(result.__bytes)) {
          return new Uint8Array(result.__bytes).buffer;
        }
        return result;
      },
      transformCallback(callback, once) {
        const id = ++callbackId;
        callbacks.set(id, { callback, once });
        window[`_${id}`] = (payload) => {
          const entry = callbacks.get(id);
          if (!entry) return;
          if (entry.once) callbacks.delete(id);
          entry.callback(payload);
        };
        return id;
      },
      unregisterCallback(id) {
        callbacks.delete(id);
        delete window[`_${id}`];
      },
      convertFileSrc: (filePath) => filePath,
    };
  }, extraNames);
}
