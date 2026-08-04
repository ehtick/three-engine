/**
 * Headless Claude Code CLI provider.
 *
 * Runs a SHORT, SCOPED, one-shot `claude -p` turn — as opposed to
 * TerminalPanel.jsx's long-lived interactive session — for a context-menu AI
 * action. It reuses the exact same MCP server this editor already ships
 * (`mcp/server.mjs`, the one the interactive terminal registers via the
 * Connect buttons in McpPanel.jsx), scoped for this one run alone:
 *
 *   - `--mcp-config` + `--strict-mcp-config` so the model can reach ONLY this
 *     editor's tools, not whatever else is in the user's global Claude config;
 *   - `--allowedTools` restricts WHICH of the editor's MCP tools this run may
 *     use — the calling workflow's declared subset (see workflows.js), never
 *     the full registry.
 *   - `--permission-mode bypassPermissions` because this is headless: nothing
 *     can answer an interactive tool-approval prompt.
 *
 * This provider's tool set is **not scopeable** in the way the tool-loop
 * providers are (see toolLoop.js): it drives the CLI's own opaque agent loop,
 * which still has its full set of built-in tools (Bash, Read, Write, ...)
 * available to it — `--tools ""` was tried to close that gap and rejected,
 * see the comment on `capabilities` below and the `ai-workflows` project
 * memory for the five-experiment writeup. That is why `capabilities.scopedTools`
 * is `false` here: the safety boundary this provider offers is "the user's own
 * CLI, own machine, own files, same as typing in the Terminal panel" — fine
 * for read-only workflows, not for an unattended mutating one (enforced in
 * aiStore.js, not here).
 *
 * Flag spellings (`--mcp-config`, `--strict-mcp-config`, `--allowedTools`,
 * `--permission-mode bypassPermissions`, `--output-format stream-json`,
 * `--no-session-persistence`) were checked against a real `claude --help`.
 * The exact shape of `stream-json` EVENTS (as opposed to the flags) was
 * checked against fewer live runs — see parseStreamEvent.js.
 */
import { parseAgentLinePayload, parseStreamEvent } from "../parseStreamEvent.js";
import { resolveAllowedTools } from "../workflows.js";

const RUN_ID = "editor-ai-main"; // one AI run at a time, like TerminalPanel's SESSION_ID

async function invoke(cmd, args) {
  const { invoke: call } = await import("@tauri-apps/api/core");
  return call(cmd, args);
}

let claudePathCache = null;

/** Absolute path to the `claude` binary, resolved the same way TerminalPanel.jsx does. */
async function resolveClaudePath() {
  if (claudePathCache) return claudePathCache;
  const pairs = await invoke("detect_terminal_programs");
  const path = Object.fromEntries(pairs ?? [])?.claude ?? null;
  if (path) claudePathCache = path;
  return path;
}

/**
 * Waits (up to `timeoutMs`) for the bridge to actually finish connecting —
 * not just for the enable request to be issued. `setMcpPrefs`/
 * `configureMcpBridge` return as soon as the first connection attempt has
 * fired; the WS handshake itself can still take a moment, and every workflow
 * run spawns a FRESH `mcp/server.mjs`, so even an already-"enabled" bridge is
 * often mid-reconnect (the previous run's server just exited) rather than
 * steady-state connected. Resolves either way on timeout — if the bridge
 * still isn't connected by then, `mcp/server.mjs`'s own grace period
 * (ENGINE_MCP_GRACE_MS) gives it a little more time regardless, and the
 * reconnect loop itself now always keeps retrying (see the `mcpBridge.js`
 * fix this call exists because of — a synthetic browser-only test's near
 * instant JS-to-JS calls hid how much real Tauri IPC round trips could
 * lengthen this race).
 */
async function waitForBridgeConnected(timeoutMs = 8000) {
  const { useMcpStore } = await import("../../api/mcpBridge.js");
  if (useMcpStore.getState().status === "connected") return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve();
    }, timeoutMs);
    const unsubscribe = useMcpStore.subscribe((state) => {
      if (state.status === "connected") {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });
}

/** Ensures the editor's MCP bridge is listening AND connected before claude spawns. */
async function ensureBridgeEnabled() {
  const { useMcpPrefs, setMcpPrefs } = await import("../../mcpPrefs.js");
  if (!useMcpPrefs.getState().enabled) {
    // The user just explicitly triggered an AI action; requiring a separate
    // manual "turn on MCP first" step would be exactly the context-switch
    // this feature exists to remove.
    await setMcpPrefs({ enabled: true });
  }
  await waitForBridgeConnected();
}

/**
 * Runs one scoped turn against `workflow` for `entityId`. `onEvent({lines,
 * result, meta})` is called once per parsed `stream-json` line, converted via
 * `parseStreamEvent` (see that module) — the same shape every provider emits,
 * so `aiStore.js` has exactly one `handleEvent` regardless of which provider
 * is running. Resolves when the process exits 0, rejects otherwise.
 */
export async function runTurn({ workflow, prompt, cwd }, onEvent) {
  const claudePath = await resolveClaudePath();
  if (!claudePath) {
    throw new Error("Claude Code CLI not found. Install it and sign in — the same requirement as the Terminal panel.");
  }

  const { resolveServerPath } = await import("../../mcpClients.js");
  const serverPath = await resolveServerPath();
  if (!serverPath) {
    throw new Error("Could not locate this editor's own mcp/server.mjs.");
  }

  await ensureBridgeEnabled();

  const mcpConfig = JSON.stringify({
    mcpServers: { "three-engine": { command: "node", args: [serverPath] } },
  });

  const args = [
    "-p",
    prompt,
    "--mcp-config",
    mcpConfig,
    "--strict-mcp-config",
    "--allowedTools",
    resolveAllowedTools(workflow).join(","),
    "--permission-mode",
    "bypassPermissions",
    "--output-format",
    "stream-json",
    "--verbose",
    // Each workflow run is a fresh, stateless turn — nothing ever resumes it —
    // so there is no reason to leave a session file behind on every click.
    "--no-session-persistence",
  ];

  const { listen } = await import("@tauri-apps/api/event");

  return new Promise((resolve, reject) => {
    let settled = false;
    let offLine = () => {};
    let offExit = () => {};
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      offLine();
      offExit();
      fn();
    };

    Promise.all([
      listen("agent://line", ({ payload }) => {
        if (payload.id !== RUN_ID) return;
        const event = parseAgentLinePayload(payload);
        if (event) onEvent(parseStreamEvent(event));
      }),
      listen("agent://exit", ({ payload }) => {
        if (payload.id !== RUN_ID) return;
        finish(() => {
          if (payload.code === 0) resolve();
          else reject(new Error(`claude exited with code ${payload.code ?? "unknown"}`));
        });
      }),
    ]).then(([unLine, unExit]) => {
      offLine = unLine;
      offExit = unExit;
      // A cancel (or the process dying) between the invoke() call below and
      // these listeners attaching would be missed; narrow enough not to chase
      // for a first version, and cancelling something that has not yet
      // started producing output is a rare click.
    });

    invoke("agent_run", { id: RUN_ID, command: claudePath, args, cwd: cwd ?? null }).catch((err) => {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))));
    });
  });
}

export async function cancelTurn() {
  await invoke("agent_cancel", { id: RUN_ID });
}

/** This provider, registered in providers/index.js. */
export const claudeCliProvider = {
  id: "claude-cli",
  label: "Claude Code CLI (subscription)",
  capabilities: { scopedTools: false, isLocal: false, needsApiKey: false },
  disclosure:
    "Runs with your full Claude Code permissions — the same access as typing directly into the Terminal panel. " +
    "Fine for read-only actions; mutating workflows are refused on this provider.",
  runTurn,
  cancelTurn,
};
