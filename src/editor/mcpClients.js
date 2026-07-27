/**
 * Registering the `three-engine` MCP server with the local AI CLIs, from a
 * button instead of a copy-pasted command.
 *
 * The Rust side (`src-tauri/src/mcp_clients.rs`) shells out to
 * `claude mcp add` / `codex mcp add`; this module works out WHAT to register
 * and keeps a small store so the settings panel can show per-client state.
 *
 * ## Finding server.mjs
 *
 * The command we register is `node <abs path>/mcp/server.mjs`, so the path has
 * to be absolute and correct on the user's disk. In a dev run the app is served
 * by Vite from the repo, so the repo root is knowable; in a packaged build the
 * server ships beside the executable. `resolveServerPath` tries the candidates
 * in order and verifies each with a stat, rather than guessing — registering a
 * path that does not exist produces an MCP client that fails at spawn time with
 * a message pointing at node, not at us.
 */
import { create } from "zustand";
import { vmSingleton } from "./singleton.js";

export const MCP_SERVER_NAME = "three-engine";

// VM-wide for the same reason as the bridge store: a duplicate module copy
// would leave the panel subscribed to a store nothing writes to.
export const useMcpClientStore = vmSingleton("mcpClientStore", () =>
  create(() => ({
  /** [{ client, installed, path, registered, error }] or null before the first probe. */
  clients: null,
  busy: null, // client id currently being registered
  message: null, // last result, shown under the buttons
  })),
);

async function invoke(cmd, args) {
  const { invoke: call } = await import("@tauri-apps/api/core");
  return call(cmd, args);
}

const exists = async (path) => {
  try {
    await invoke("stat_file", { path });
    return true;
  } catch {
    return false;
  }
};

let cachedServerPath = null;

/**
 * Absolute path to `mcp/server.mjs`, or null if it cannot be found.
 *
 * `import.meta.url` in a Vite dev server is an http:// URL whose pathname is
 * the repo-relative module path, which is how we recover the repo root without
 * hard-coding it. A built app has no such luck, so the packaged location is
 * tried too.
 */
export async function resolveServerPath() {
  if (cachedServerPath) return cachedServerPath;

  const candidates = [];
  // Dev: the page is served from the repo root, and Tauri exposes the cwd of
  // the process, which `tauri dev` sets to src-tauri/.
  try {
    const { appLocalDataDir, resourceDir } = await import("@tauri-apps/api/path");
    for (const dir of await Promise.all([resourceDir().catch(() => null), appLocalDataDir().catch(() => null)])) {
      if (dir) candidates.push(`${dir.replaceAll("\\", "/").replace(/\/$/, "")}/mcp/server.mjs`);
    }
  } catch {
    // path API unavailable (browser harness) — fall through to the dev guess.
  }

  // Baked in by vite.config.js — see the note there for why the build system is
  // the only layer that can know this. Tried FIRST because in a dev run it is
  // the checkout the user is actually editing.
  const repoRoot = typeof __ENGINE_REPO_ROOT__ === "string" ? __ENGINE_REPO_ROOT__ : null;
  if (repoRoot) candidates.unshift(`${repoRoot.replaceAll("\\", "/")}/mcp/server.mjs`);

  for (const candidate of candidates) {
    if (await exists(candidate)) {
      cachedServerPath = candidate;
      return candidate;
    }
  }
  return null;
}

/** Refreshes installed/registered state for every supported client. */
export async function refreshMcpClients() {
  try {
    const clients = await invoke("mcp_client_status", { name: MCP_SERVER_NAME });
    useMcpClientStore.setState({ clients });
    return clients;
  } catch (err) {
    // Outside Tauri (the browser harness) there is nothing to probe.
    useMcpClientStore.setState({ clients: [], message: String(err?.message ?? err) });
    return [];
  }
}

/**
 * Registers the server with one client. Idempotent — the Rust side removes any
 * existing entry first, so pressing the button twice (or after moving the repo)
 * updates the path rather than erroring.
 */
export async function connectMcpClient(client) {
  useMcpClientStore.setState({ busy: client, message: null });
  try {
    const serverPath = await resolveServerPath();
    if (!serverPath) {
      throw new Error(
        "Could not locate mcp/server.mjs. Register it manually with: " +
          `claude mcp add ${MCP_SERVER_NAME} -- node <repo>/mcp/server.mjs`,
      );
    }
    const result = await invoke("mcp_client_register", {
      client,
      name: MCP_SERVER_NAME,
      commandPath: "node",
      args: [serverPath],
    });
    useMcpClientStore.setState({ message: result.message });
    await refreshMcpClients();
    return result;
  } catch (err) {
    const message = String(err?.message ?? err);
    useMcpClientStore.setState({ message });
    return { ok: false, message };
  } finally {
    useMcpClientStore.setState({ busy: null });
  }
}

/** Removes the server from one client. */
export async function disconnectMcpClient(client) {
  useMcpClientStore.setState({ busy: client, message: null });
  try {
    const result = await invoke("mcp_client_unregister", { client, name: MCP_SERVER_NAME });
    useMcpClientStore.setState({ message: result.message });
    await refreshMcpClients();
    return result;
  } catch (err) {
    const message = String(err?.message ?? err);
    useMcpClientStore.setState({ message });
    return { ok: false, message };
  } finally {
    useMcpClientStore.setState({ busy: null });
  }
}
