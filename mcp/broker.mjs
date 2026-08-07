#!/usr/bin/env node
/**
 * The editor bridge broker.
 *
 *   node mcp/broker.mjs            # normally spawned by mcp/server.mjs, not by hand
 *
 * ## Why this process exists
 *
 * An MCP server over stdio is spawned by its client, one process per client.
 * Two Claude sessions are therefore two `mcp/server.mjs` processes, always —
 * there is no way to attach a second client to a running stdio server. That was
 * fine while a session's server was also the thing the editor connected to, and
 * fatal the moment you wanted two sessions: the editor dials ONE port, only one
 * process can bind it, and the loser used to exit, which the MCP client reported
 * as a bare `-32000` transport failure.
 *
 * So the port moves here. This is a long-lived daemon that outlives every
 * session: it owns `127.0.0.1:<ENGINE_MCP_PORT>`, accepts the editor on one side
 * and any number of sessions on the other, and routes calls between them. A
 * session server is now a pure client of this process, which means N of them
 * coexist with no contention at all.
 *
 * The editor was not changed to make this work and does not know this process
 * exists. It connects exactly as before and speaks exactly what it always spoke;
 * `bridgeProtocol.mjs` explains why keeping it out of the versioned surface was
 * deliberate.
 *
 * ## Connection roles
 *
 * A socket's role is decided by its first message, not by a separate port:
 *
 *   {type:"hello", tools, info}  -> the editor (its existing greeting)
 *   {type:"session", protocol}   -> an MCP server session
 *
 * Editor->broker and broker->editor traffic is untouched. Session traffic adds
 * only what a session cannot infer on its own: `welcome` on connect and an
 * `editor` state push whenever the editor connects, disconnects, or re-advertises
 * its tools — which is what lets every attached session fire its own MCP
 * `tools/list_changed` at the right moment.
 *
 * ## Ids are rewritten, never forwarded
 *
 * Sessions number their own calls from 1, so two sessions WILL collide. Every
 * forwarded request gets a fresh broker-global id, and the reply is mapped back
 * to the originating socket and its original id. Without that, session B's reply
 * lands in session A's pending map and each gets the other's scene data — the
 * kind of bug that looks like a flaky editor rather than a routing error.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { BRIDGE_PROTOCOL, IDLE_EXIT_MS, bridgePort } from "./bridgeProtocol.mjs";

const PORT = bridgePort();

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * A detached daemon has nowhere to log — its stdio is `ignore` by construction,
 * because inheriting a session's pipes would tie its lifetime to that session
 * and undo the entire point. A file is the only channel left, and it is worth
 * having: "why is the bridge behaving oddly" is otherwise unanswerable after the
 * fact, which is exactly the position this rewrite was written in response to.
 */
const LOG_PATH = process.env.ENGINE_MCP_LOG ?? path.join(os.tmpdir(), `three-engine-broker-${PORT}.log`);

try {
  // Truncate a log that has run away rather than letting it grow without bound;
  // the recent lines are the only ones anyone reads.
  if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 1_000_000) fs.rmSync(LOG_PATH);
} catch {
  // A broker that cannot manage its log still brokers.
}

/**
 * Appends SYNCHRONOUSLY, which for a daemon that logs a handful of lifecycle
 * lines is free — and buys the one case that matters most.
 *
 * The first version buffered through a `createWriteStream`, and the very message
 * worth having ("port already has a broker") was written immediately before
 * `process.exit`, so it never flushed: the log sat empty in exactly the
 * situation someone would open it. A losable log is worse than none, because it
 * reads as "the broker never ran".
 */
const log = (...args) => {
  try {
    fs.appendFileSync(LOG_PATH, `[broker ${process.pid}] ${args.join(" ")}\n`);
  } catch {
    // Not worth taking the daemon down over.
  }
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** The editor socket, or null. At most one. */
let editor = null;
/** Tool descriptors from the editor's `hello`. */
let editorTools = [];
/** Editor-reported metadata (api version, op count). */
let editorInfo = null;

/** Every attached session socket -> { protocol, client }. */
const sessions = new Map();

/** Broker-global id -> { socket, sessionId }. */
const routes = new Map();
let nextId = 1;

let idleTimer = null;

/**
 * Exits once nothing has been attached for `IDLE_EXIT_MS`.
 *
 * Re-armed on every attach and detach rather than run as an interval, so the
 * countdown always measures "time since the last thing left" instead of landing
 * on an arbitrary tick boundary.
 */
function armIdleExit() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (editor || sessions.size) return;
  idleTimer = setTimeout(() => {
    if (editor || sessions.size) return;
    log(`nothing attached for ${IDLE_EXIT_MS}ms — exiting`);
    shutdown(0);
  }, IDLE_EXIT_MS);
  idleTimer.unref?.();
}

const send = (socket, payload) => {
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    // Socket died mid-write; its close handler does the cleanup.
  }
};

/** The editor's current state, in the shape a session needs to mirror it. */
const editorState = () => ({
  type: "editor",
  connected: !!editor,
  tools: editorTools,
  info: editorInfo,
  sessions: sessions.size,
});

/**
 * Pushes editor state to every attached session, and the session count back to
 * the editor.
 *
 * The editor half is new, and additive on purpose: `mcpBridge.js` ignores any
 * message without an `id`, so an editor running older code simply drops it. That
 * is what lets the count reach the panel without making the editor's protocol
 * something this daemon has to negotiate. It matters to a person watching the
 * editor for the same reason `attachedSessions` matters to an assistant — two
 * assistants editing one scene is fine, but only if you know it is happening.
 */
function broadcastEditorState() {
  const payload = editorState();
  for (const socket of sessions.keys()) send(socket, payload);
  if (editor) send(editor, { type: "sessions", count: sessions.size });
}

/**
 * Fails every in-flight call matching `predicate`, so a caller gets a real error
 * instead of waiting out its timeout.
 */
function failRoutes(predicate, error) {
  for (const [brokerId, route] of routes) {
    if (!predicate(route)) continue;
    routes.delete(brokerId);
    if (route.socket.readyState === route.socket.OPEN) {
      send(route.socket, { id: route.sessionId, ok: false, error });
    }
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });

wss.on("listening", () => log(`listening on ws://127.0.0.1:${PORT} (protocol ${BRIDGE_PROTOCOL})`));

wss.on("error", (err) => {
  // Two sessions starting at once both spawn a broker; one of them loses this
  // race. That is not a failure — the winner serves both — so exit quietly and
  // let the loser's parent connect to the broker that did bind.
  if (err?.code === "EADDRINUSE") {
    log(`port ${PORT} already has a broker — exiting`);
    process.exit(0);
  }
  log("server error:", err?.message ?? err);
});

wss.on("connection", (socket, req) => {
  // `host: "127.0.0.1"` already binds locally; this keeps a future config change
  // from silently exposing scene mutation to the network.
  const address = req.socket.remoteAddress ?? "";
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address)) {
    log(`refused non-local connection from ${address}`);
    socket.close(1008, "local connections only");
    return;
  }

  // Role is unknown until the first message names it.
  let role = null;

  socket.on("message", (data) => {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }

    if (role === null) {
      if (message.type === "session") return attachSession(socket, message);
      if (message.type === "hello") return attachEditor(socket, message);
      // Anything else is a peer we do not know how to talk to. Historically the
      // editor's `hello` was the only greeting, so an unrecognised first message
      // is far more likely to be a version skew than an attack.
      log(`unknown first message "${message.type ?? "(none)"}" — closing`);
      socket.close(1002, "expected a hello or session greeting");
      return;
    }

    if (role === "editor") return onEditorMessage(message);
    return onSessionMessage(socket, message);
  });

  function attachSession(sock, message) {
    role = "session";
    // A session that speaks a NEWER protocol than this daemon means the daemon
    // is stale code left over from a previous checkout. It asks us to retire
    // (see the `retire` branch below) rather than us guessing; all we do here is
    // report honestly.
    sessions.set(sock, { protocol: Number(message.protocol) || 0, client: message.client ?? "unknown" });
    log(`session attached (${sessions.size} now, protocol ${message.protocol}, client ${message.client ?? "?"})`);
    armIdleExit();
    send(sock, { type: "welcome", protocol: BRIDGE_PROTOCOL, pid: process.pid, port: PORT });
    send(sock, editorState());
    broadcastEditorState(); // the other sessions' session counts just changed
  }

  function attachEditor(sock, message) {
    role = "editor";
    // A reloaded editor can connect before its old socket's close event lands.
    // Newest wins — the old one is gone by definition.
    if (editor && editor !== sock) {
      log("a second editor connected; dropping the previous one");
      const stale = editor;
      editor = null;
      try {
        stale.close(1000, "replaced by a newer editor");
      } catch {
        // already closing
      }
      failRoutes(() => true, "The editor was replaced by a newer connection.");
    }
    editor = sock;
    editorTools = Array.isArray(message.tools) ? message.tools : [];
    editorInfo = message.info ?? null;
    log(`editor attached, advertising ${editorTools.length} tools (api ${editorInfo?.apiVersion ?? "?"})`);
    armIdleExit();
    broadcastEditorState();
  }

  const drop = () => {
    if (role === "editor") {
      if (editor !== socket) return;
      editor = null;
      editorTools = [];
      editorInfo = null;
      failRoutes(() => true, "The editor disconnected.");
      log("editor detached");
      broadcastEditorState();
    } else if (role === "session") {
      if (!sessions.delete(socket)) return;
      // Its calls can no longer be answered anywhere useful.
      for (const [brokerId, route] of routes) {
        if (route.socket === socket) routes.delete(brokerId);
      }
      log(`session detached (${sessions.size} left)`);
      broadcastEditorState();
    }
    armIdleExit();
  };
  socket.on("close", drop);
  socket.on("error", drop);
});

/** A reply (or a re-`hello`) from the editor. */
function onEditorMessage(message) {
  // The editor re-advertises whenever its registry changes — a module toggled
  // on, a project opened. Every session needs to hear about it.
  if (message.type === "hello") {
    editorTools = Array.isArray(message.tools) ? message.tools : [];
    editorInfo = message.info ?? null;
    log(`editor re-advertised ${editorTools.length} tools`);
    broadcastEditorState();
    return;
  }

  const route = routes.get(message.id);
  if (!route) return; // a reply to a call whose session already went away
  routes.delete(message.id);
  send(route.socket, { ...message, id: route.sessionId });
}

/** A request from one of the sessions. */
function onSessionMessage(socket, message) {
  // A session that finds an older broker on the port asks it to stand down, then
  // spawns a current one. Without this, a stale daemon from a previous checkout
  // would keep serving an obsolete protocol to every new session indefinitely,
  // and the only cure would be knowing to hunt for the process by hand — which
  // is precisely the debugging session that motivated this file.
  if (message.type === "retire") {
    log(`retiring at the request of a protocol-${message.protocol ?? "?"} session`);
    shutdown(0);
    return;
  }

  if (message.id === undefined) return;

  if (!editor) {
    send(socket, { id: message.id, ok: false, error: "The editor is not connected." });
    return;
  }

  const brokerId = nextId++;
  routes.set(brokerId, { socket, sessionId: message.id });
  send(editor, { id: brokerId, method: message.method, params: message.params ?? {} });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function shutdown(code = 0) {
  // Stop accepting first, so a session racing to connect fails fast and spawns a
  // replacement rather than attaching to a daemon that is on its way out.
  try {
    wss.close();
  } catch {
    // already closing
  }
  for (const socket of [...sessions.keys(), editor].filter(Boolean)) {
    try {
      socket.close(1001, "broker shutting down");
    } catch {
      // already closing
    }
  }
  // Give the close frames a tick to flush; the daemon is going away either way.
  setTimeout(() => process.exit(code), 50).unref?.();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

armIdleExit();
log("broker started");
