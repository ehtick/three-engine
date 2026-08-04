import { create } from "zustand";
import { EditorApi } from "./index.js";
import { vmSingleton } from "../singleton.js";

/**
 * The editor's half of the MCP bridge.
 *
 * Dials the MCP server's local WebSocket (see `mcp/server.mjs`), advertises the
 * op registry as a tool manifest, and executes forwarded calls against the live
 * editor. The direction is dictated by the browser: a page cannot listen on a
 * socket, so the short-lived stdio process is the server and the long-lived
 * editor is the client.
 *
 * ## Reconnecting is the normal case, not the error case
 *
 * The MCP server's lifetime is the assistant's, not the editor's — it is
 * spawned when a conversation starts and killed when it ends, possibly several
 * times while the editor stays open. So a failed connection is expected and
 * must be quiet: the backoff below tops out at 15s and logs only on the
 * transitions a user cares about (connected, and the first failure after a
 * successful connection). An earlier version logged every attempt and filled
 * the console with a line every two seconds whenever no assistant was running.
 *
 * ## Everything runs through `EditorApi.callTool`
 *
 * Not `callOp`: `callTool` resolves `{ ok, error }` instead of throwing, which
 * is exactly the shape a transport needs, and it applies the registry's
 * argument validation. A model on the other end WILL send a string where a
 * number belongs, and the error it gets back should name the parameter.
 */

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15_000;

export const useMcpStore = vmSingleton("mcpStore", () =>
  create(() => ({
    /** "disabled" | "connecting" | "connected" */
    status: "disabled",
    port: null,
    /** Number of tools advertised on the current connection. */
    toolCount: 0,
    /** Total calls served since this editor session started — a liveness signal
     *  the status chip can show, so "is it actually doing anything?" is visible. */
    callCount: 0,
    lastTool: null,
    lastError: null,
  })),
);

/**
 * Connection state, VM-wide rather than in module-scope `let`s.
 *
 * A second copy of this module (HMR, Vite's `?t=` twin) would otherwise get its
 * own socket and its own reconnect timer while the first is still connected —
 * two live bridges under one editor, each thinking it is the bridge. That is
 * worse than the split-brain the command bus had, because a second socket is
 * visible to the MCP server as a second editor. Same reasoning as
 * `singleton.js`; here the whole mutable record is shared, not just a store.
 */
const state = vmSingleton("mcpBridgeState", () => ({
  socket: null,
  reconnectTimer: null,
  reconnectDelay: RECONNECT_MIN_MS,
  config: { enabled: false, port: 17325 },
  /** Suppresses the "connection failed" log until after a successful connect,
   *  so a session with no assistant running stays silent. */
  hadConnection: false,
}));

function clearReconnect() {
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
}

function scheduleReconnect() {
  if (!state.config.enabled || state.reconnectTimer) return;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connect();
  }, state.reconnectDelay);
  state.reconnectDelay = Math.min(state.reconnectDelay * 2, RECONNECT_MAX_MS);
}

/** Handles one request from the MCP server. */
async function handleMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  const { id, method, params = {} } = message;
  if (id === undefined) return;

  const reply = (payload) => {
    try {
      state.socket?.send(JSON.stringify({ id, ...payload }));
    } catch {
      // Socket died between request and reply; the server times the call out.
    }
  };

  try {
    if (method === "tools") {
      reply({ ok: true, result: EditorApi.tools() });
      return;
    }
    if (method === "call") {
      const outcome = await EditorApi.callTool(params.tool, params.args ?? {});
      // `prev`, not `state` — the module-level `state` above is the bridge's
      // connection record, and shadowing it here would be a trap for the next
      // person editing this block.
      useMcpStore.setState((prev) => ({
        callCount: prev.callCount + 1,
        lastTool: params.tool,
        lastError: outcome.ok ? null : outcome.error,
      }));
      // `callTool` already encodes success/failure in the payload; the envelope
      // is always ok:true because the BRIDGE succeeded. Keeping the two layers
      // separate is what lets the server say "the op failed" and "I couldn't
      // reach the editor" differently.
      reply({ ok: true, result: outcome });
      return;
    }
    reply({ ok: false, error: `Unknown bridge method "${method}"` });
  } catch (err) {
    reply({ ok: false, error: String(err?.message ?? err) });
  }
}

function connect() {
  if (!state.config.enabled) return;
  clearReconnect();
  const url = `ws://127.0.0.1:${state.config.port}`;
  useMcpStore.setState({ status: "connecting", port: state.config.port });

  let ws;
  try {
    ws = new WebSocket(url);
  } catch (err) {
    useMcpStore.setState({ status: "connecting", lastError: String(err?.message ?? err) });
    scheduleReconnect();
    return;
  }
  state.socket = ws;

  ws.onopen = () => {
    if (state.socket !== ws) return;
    state.reconnectDelay = RECONNECT_MIN_MS;
    state.hadConnection = true;
    const tools = EditorApi.tools();
    ws.send(
      JSON.stringify({
        type: "hello",
        tools,
        info: { apiVersion: EditorApi.version, opCount: EditorApi.ops().length },
      }),
    );
    useMcpStore.setState({ status: "connected", toolCount: tools.length, lastError: null });
    console.log(`MCP bridge connected on port ${state.config.port} — ${tools.length} tools exposed`);
  };

  ws.onmessage = (event) => {
    if (state.socket === ws) handleMessage(String(event.data));
  };

  ws.onclose = () => {
    if (state.socket !== ws) return;
    state.socket = null;
    const wasConnected = useMcpStore.getState().status === "connected";
    useMcpStore.setState({ status: state.config.enabled ? "connecting" : "disabled", toolCount: 0 });
    if (wasConnected) console.log("MCP bridge disconnected");
    // Always keep trying while enabled — `scheduleReconnect` itself already
    // no-ops when disabled. This used to be gated on `state.hadConnection`,
    // which was meant to keep a session with no assistant ever running quiet
    // (see the log suppression in `onerror` below, which is the right place
    // for that) but instead made it permanent: a bridge enabled a moment
    // before anything is listening — the ordinary case for "enable the bridge
    // and immediately spawn a scoped client", not an edge case — missed its
    // first connect attempt and then never retried at all, silently stuck in
    // "connecting" forever. Caught live: a fresh `runWorkflow` enabling the
    // bridge and spawning `claude` within the same couple of seconds hit this
    // every time.
    scheduleReconnect();
  };

  ws.onerror = () => {
    // Fires before onclose for a refused connection. Only worth a line if we
    // had previously been connected — otherwise it just means no assistant is
    // running, which is the normal state.
    if (state.socket === ws && state.hadConnection) {
      useMcpStore.setState({ lastError: `Could not reach ${url}` });
    }
  };
}

function disconnect() {
  clearReconnect();
  const ws = state.socket;
  state.socket = null;
  try {
    ws?.close();
  } catch {
    // already closed
  }
  useMcpStore.setState({ status: "disabled", toolCount: 0 });
}

/**
 * Applies `{ enabled, port }`. Idempotent — called at boot and again whenever
 * project settings are saved, so it must no-op when nothing changed rather
 * than tearing down a healthy connection on every unrelated settings write.
 */
export function configureMcpBridge({ enabled = false, port = 17325 } = {}) {
  const next = { enabled: !!enabled, port: Number(port) || 17325 };
  const changed = next.enabled !== state.config.enabled || next.port !== state.config.port;
  state.config = next;
  if (!changed) return;
  state.reconnectDelay = RECONNECT_MIN_MS;
  state.hadConnection = false;
  disconnect();
  if (!state.config.enabled) return;
  // Announce the intent. Everything after this point is silent until the first
  // successful connection (see the note above), so without this line an editor
  // that never manages to connect produces no console output at all — and the
  // first question anyone asks is "is it even trying?".
  console.log(`MCP bridge enabled — dialing ws://127.0.0.1:${state.config.port}`);
  connect();
}

/** Current bridge configuration — for the status chip and for tests. */
export function mcpBridgeConfig() {
  return { ...state.config };
}

/** Forces an immediate reconnect attempt (the status chip's retry button). */
export function retryMcpBridge() {
  if (!state.config.enabled) return;
  state.reconnectDelay = RECONNECT_MIN_MS;
  // `disconnect()` sets the store to "disabled"; the config itself is untouched,
  // so `connect()` immediately re-enters "connecting".
  disconnect();
  connect();
}
