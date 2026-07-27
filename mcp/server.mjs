#!/usr/bin/env node
/**
 * MCP server for the engine's editor.
 *
 * Exposes the editor's operation registry (`src/editor/api/registry.js`) as MCP
 * tools, so an assistant can inspect and edit the scene the user has open:
 * create entities, attach components, read and write project files, drive play
 * mode, undo.
 *
 *   node mcp/server.mjs              # speaks MCP over stdio
 *   ENGINE_MCP_PORT=17325            # bridge port (must match the editor's)
 *
 * Register it with Claude Code:
 *
 *   claude mcp add three-engine -- node /abs/path/to/mcp/server.mjs
 *
 * ## Why there is a WebSocket in the middle
 *
 * The tools have to run INSIDE the editor: they mutate a live scene graph held
 * by a running WebGPU renderer, and every mutation goes through the editor's
 * command bus so it lands on the undo stack. This process cannot do any of
 * that — it is a short-lived stdio process the MCP client spawns, and the
 * editor is a browser/Tauri webview it has no handle on.
 *
 * A browser page can't listen on a socket, so the direction is forced: this
 * process hosts a WebSocket server on 127.0.0.1 and the editor dials in (see
 * `src/editor/api/mcpBridge.js`). Everything else follows from that — the
 * editor may connect after we start, disconnect on reload, and reconnect, which
 * is why the tool list is dynamic and why `notifications/tools/list_changed`
 * matters here rather than being a formality.
 *
 * ## The tool list is the editor's, not ours
 *
 * We deliberately hard-code nothing except `editor_status`. The manifest comes
 * off the wire from the registry, so an op added in `src/editor/api/ops/` shows
 * up here with no change to this file. `editor_status` is the exception because
 * it must answer even when nothing is connected — without it, an assistant
 * facing an empty tool list has no way to distinguish "the editor is closed"
 * from "this server is broken".
 */
import { WebSocketServer } from "ws";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const PORT = Number(process.env.ENGINE_MCP_PORT ?? 17325);
/** How long a forwarded call may take before we give up on the editor. */
const CALL_TIMEOUT_MS = Number(process.env.ENGINE_MCP_TIMEOUT_MS ?? 30_000);
/**
 * How long `tools/list` will wait for an editor at startup.
 *
 * MCP clients list tools immediately after connecting, which is usually a
 * fraction of a second before the editor's bridge dials in — answering "no
 * tools" there would be technically correct and practically useless. After the
 * grace window we answer instantly and rely on `list_changed`.
 */
const STARTUP_GRACE_MS = Number(process.env.ENGINE_MCP_GRACE_MS ?? 10_000);

const startedAt = Date.now();

/** stdout is the MCP protocol channel — every log line MUST go to stderr. */
const log = (...args) => console.error("[three-engine]", ...args);

// ---------------------------------------------------------------------------
// Bridge: one editor at a time
// ---------------------------------------------------------------------------

/** Current editor socket, or null. */
let editor = null;
/** Tool descriptors the editor advertised on connect. */
let editorTools = [];
/** Editor-reported metadata (api version, project, scene) for `editor_status`. */
let editorInfo = null;
/** id -> { resolve, reject, timer } for calls in flight. */
const pending = new Map();
let nextId = 1;
/** Resolvers waiting for an editor to appear. */
const waiters = new Set();

function settleWaiters() {
  for (const resolve of waiters) resolve(!!editor);
  waiters.clear();
}

/** Resolves true as soon as an editor is connected, or false after `ms`. */
function waitForEditor(ms) {
  if (editor) return Promise.resolve(true);
  if (ms <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    waiters.add(resolve);
    setTimeout(() => {
      if (waiters.delete(resolve)) resolve(!!editor);
    }, ms).unref?.();
  });
}

function rejectAllPending(reason) {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
  pending.clear();
}

/** Sends a request to the editor and resolves with its reply. */
function request(method, params = {}) {
  if (!editor) return Promise.reject(new Error("The editor is not connected."));
  const id = nextId++;
  const socket = editor;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`The editor did not answer "${method}" within ${CALL_TIMEOUT_MS}ms.`));
    }, CALL_TIMEOUT_MS);
    timer.unref?.();
    pending.set(id, { resolve, reject, timer });
    try {
      socket.send(JSON.stringify({ id, method, params }));
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      reject(err);
    }
  });
}

const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });

wss.on("listening", () => log(`bridge listening on ws://127.0.0.1:${PORT}`));

wss.on("error", (err) => {
  // EADDRINUSE almost always means a second copy of this server is already
  // running (two MCP clients, or a stale process). Say so rather than dying
  // with a bare stack, and exit — the editor will stay attached to the first.
  if (err?.code === "EADDRINUSE") {
    log(
      `port ${PORT} is already in use — another engine MCP server is probably running. ` +
        `Set ENGINE_MCP_PORT (and match it in the editor's Project Settings) to run a second one.`,
    );
    process.exit(1);
  }
  log("bridge error:", err?.message ?? err);
});

wss.on("connection", (socket, req) => {
  // Refuse anything that isn't loopback. `host: "127.0.0.1"` already binds
  // locally, but a belt-and-braces check keeps a future config change from
  // silently exposing scene mutation to the network.
  const address = req.socket.remoteAddress ?? "";
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address)) {
    log(`refused non-local connection from ${address}`);
    socket.close(1008, "local connections only");
    return;
  }

  // A reloaded editor can connect before its old socket's close event lands.
  // Newest wins — the old one is gone by definition.
  if (editor && editor !== socket) {
    log("a second editor connected; dropping the previous one");
    try {
      editor.close(1000, "replaced by a newer editor");
    } catch {
      // already closing
    }
    rejectAllPending("The editor was replaced by a newer connection.");
  }
  editor = socket;
  log("editor connected");

  socket.on("message", (data) => {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      log("ignored unparseable message from the editor");
      return;
    }

    // Unsolicited: the editor announcing itself and its tool list.
    if (message.type === "hello") {
      editorTools = Array.isArray(message.tools) ? message.tools : [];
      editorInfo = message.info ?? null;
      log(`editor advertised ${editorTools.length} tools (api ${editorInfo?.apiVersion ?? "?"})`);
      settleWaiters();
      notifyToolsChanged();
      return;
    }

    const entry = pending.get(message.id);
    if (!entry) return; // a reply to a call we already timed out
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(message.error ?? "The editor reported an unknown error."));
  });

  const drop = () => {
    if (editor !== socket) return;
    editor = null;
    editorTools = [];
    editorInfo = null;
    rejectAllPending("The editor disconnected.");
    log("editor disconnected");
    notifyToolsChanged();
  };
  socket.on("close", drop);
  socket.on("error", drop);
});

// ---------------------------------------------------------------------------
// MCP surface
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "three-engine", version: "1.0.0" },
  { capabilities: { tools: { listChanged: true } } },
);

let mcpConnected = false;

/** Tells the client the tool list changed, once we're actually connected. */
function notifyToolsChanged() {
  if (!mcpConnected) return;
  server.sendToolListChanged?.().catch((err) => log("list_changed failed:", err?.message ?? err));
}

/**
 * The one tool that exists whether or not the editor is up. Without it, an
 * assistant that gets an empty tool list cannot tell a closed editor from a
 * broken server, and will usually conclude the latter.
 */
const STATUS_TOOL = {
  name: "editor_status",
  description:
    "Check whether the engine editor is connected to this MCP server, and what project and scene it currently has open. Call this first if other editor tools are missing or failing — it distinguishes 'the editor is not running' from a real error.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (!editor) await waitForEditor(Math.max(0, STARTUP_GRACE_MS - (Date.now() - startedAt)));
  return { tools: [STATUS_TOOL, ...editorTools] };
});

async function describeStatus() {
  if (!editor) {
    return {
      connected: false,
      port: PORT,
      hint:
        "The engine editor is not connected. Start it (npm run dev, or the desktop app), " +
        "open a project, and make sure Project Settings → MCP is enabled and set to port " +
        `${PORT}. Tools will appear automatically once it connects.`,
    };
  }
  // Ask live rather than reporting the cached hello: the user has almost
  // certainly opened a different scene since then, and a stale answer here
  // would send the assistant editing the wrong file.
  //
  // Unwrapped from the editor's `{ ok, result }` envelope — the envelope is a
  // transport detail, and leaving it in makes the status read as
  // `"scene": { "ok": true, "result": { … } }`, which invites an assistant to
  // reach for `.result.result` everywhere else too.
  const unwrap = (reply) => (reply?.ok ? (reply.result ?? null) : null);
  const [scene, project] = await Promise.all([
    request("call", { tool: "scene_get", args: {} }).then(unwrap).catch(() => null),
    request("call", { tool: "project_get", args: {} }).then(unwrap).catch(() => null),
  ]);
  return {
    connected: true,
    port: PORT,
    apiVersion: editorInfo?.apiVersion ?? null,
    toolCount: editorTools.length,
    project,
    scene,
  };
}

/** MCP wants text content; JSON is the most useful shape for structured ops. */
const asContent = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value ?? null, null, 2) }],
});

const asError = (message) => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  if (name === "editor_status") {
    try {
      return asContent(await describeStatus());
    } catch (err) {
      return asError(`Could not read editor status: ${err?.message ?? err}`);
    }
  }

  if (!editor) {
    return asError(
      `"${name}" needs the engine editor to be running and connected. ` +
        "Call editor_status for details.",
    );
  }

  try {
    // The editor's `callTool` never throws — it answers `{ ok, error }` — so a
    // rejection here means the BRIDGE failed (timeout, disconnect), not the op.
    // Both are surfaced as isError, but the messages stay distinguishable.
    const result = await request("call", { tool: name, args });
    if (result?.ok === false) return asError(`${name} failed: ${result.error}`);
    return asContent(result?.result);
  } catch (err) {
    return asError(`${name} could not reach the editor: ${err?.message ?? err}`);
  }
});

const shutdown = () => {
  try {
    wss.close();
  } catch {
    // already closing
  }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await server.connect(new StdioServerTransport());
mcpConnected = true;
log("MCP server ready on stdio");
// If the editor was already waiting when we finished connecting, the
// list_changed we skipped above still needs sending.
if (editor) notifyToolsChanged();
