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
 * that — it is a stdio process the MCP client spawns, and the editor is a
 * browser/Tauri webview it has no handle on.
 *
 * A browser page can't listen on a socket, so the editor has to dial out (see
 * `src/editor/api/mcpBridge.js`). What it dials is `mcp/broker.mjs`, NOT this
 * file — and that indirection is the whole reason two assistants can drive one
 * editor. An MCP client spawns its own stdio server, so N sessions are N copies
 * of this process no matter what; when this file owned the port, the second copy
 * lost the bind and died, and the client reported the dead pipe as `-32000`.
 * Now every copy is a client of one long-lived broker that owns the port.
 *
 * So this process no longer holds any editor state of its own — it mirrors what
 * the broker pushes. The editor may connect after we start, disconnect on
 * reload, and reconnect, which is why the tool list is dynamic and why
 * `notifications/tools/list_changed` matters here rather than being a formality.
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
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { BRIDGE_PROTOCOL, bridgePort } from "./bridgeProtocol.mjs";

const PORT = bridgePort();
const BROKER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "broker.mjs");
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
// Bridge: a client of the broker, which owns the editor
// ---------------------------------------------------------------------------

/** Socket to the broker, once connected and welcomed. */
let broker = null;
/** Whether the broker says an editor is attached. Mirrored, never authoritative. */
let editor = false;
/** Tool descriptors the editor advertised, as relayed by the broker. */
let editorTools = [];
/** Editor-reported metadata (api version, op count) for `editor_status`. */
let editorInfo = null;
/** How many sessions — including this one — are attached to the broker. */
let sessionCount = 0;
/** Why the bridge is unreachable, if it is. Surfaced by `editor_status`, which
 *  is the only place an assistant can be told anything when no tools exist. */
let bridgeFailure = null;
/** Pending slow retry, so the chains below can never overlap. */
let retryTimer = null;
/** Whether a connect loop is already running. */
let connecting = false;
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

/** Sends a request to the editor, via the broker, and resolves with its reply. */
function request(method, params = {}) {
  if (!broker) return Promise.reject(new Error("The bridge broker is not connected."));
  if (!editor) return Promise.reject(new Error("The editor is not connected."));
  const id = nextId++;
  const socket = broker;
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

/**
 * Starts a broker daemon.
 *
 * Detached with `stdio: "ignore"` on purpose, and both halves matter. Inheriting
 * our pipes would keep the daemon's stdout open against a dead session and, on
 * Windows, tie it to our console — either way its lifetime would collapse back
 * onto ours, which is the exact coupling this design removes. It logs to a file
 * instead (`broker.mjs` says where).
 *
 * Racing is fine and expected: two sessions starting together both land here,
 * and the broker that loses the bind exits 0 without complaint.
 */
function spawnBroker() {
  try {
    const child = spawn(process.execPath, [BROKER_PATH], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    });
    child.unref();
    log(`started a bridge broker (pid ${child.pid}) on port ${PORT}`);
    return true;
  } catch (err) {
    log("could not start a bridge broker:", err?.message ?? err);
    return false;
  }
}

/** Resolves with an open, welcomed socket, or rejects. */
function dialBroker() {
  return new Promise((resolve, reject) => {
    let socket;
    try {
      socket = new WebSocket(`ws://127.0.0.1:${PORT}`);
    } catch (err) {
      reject(err);
      return;
    }
    // A peer that accepts the TCP connection but never welcomes us is worse than
    // one that refuses outright — without this the whole startup would hang on
    // it rather than falling through to spawning a healthy one.
    //
    // In practice this has exactly one cause: a PRE-BROKER `server.mjs` from an
    // older checkout, which hosted the port itself and treats any connection as
    // the editor. It will never welcome anyone, and it cannot be retired over
    // the protocol because it does not speak it. `silent` marks that case so the
    // failure can name it instead of timing out anonymously.
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        // already closing
      }
      reject(Object.assign(new Error("the peer on the bridge port never welcomed us"), { silent: true }));
    }, 1500);
    timer.unref?.();

    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "session", protocol: BRIDGE_PROTOCOL, client: "three-engine-mcp" }));
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on("message", function onFirst(data) {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (message.type !== "welcome") return;
      clearTimeout(timer);
      socket.off("message", onFirst);
      resolve({ socket, welcome: message });
    });
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());

/** Wires an established broker socket up to our mirrored state. */
function adoptBroker(socket) {
  broker = socket;

  socket.on("message", (data) => {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      log("ignored an unparseable message from the broker");
      return;
    }

    // The broker's view of the editor, pushed on every change. This is the only
    // thing that moves `editor`/`editorTools` — we never observe the editor
    // directly any more.
    if (message.type === "editor") {
      const had = editor;
      editor = !!message.connected;
      editorTools = Array.isArray(message.tools) ? message.tools : [];
      editorInfo = message.info ?? null;
      sessionCount = Number(message.sessions) || 0;
      if (editor !== had) {
        log(editor ? `editor connected (${editorTools.length} tools)` : "editor disconnected");
        if (!editor) rejectAllPending("The editor disconnected.");
      }
      if (editor) settleWaiters();
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
    if (broker !== socket) return;
    broker = null;
    editor = false;
    editorTools = [];
    editorInfo = null;
    rejectAllPending("The bridge broker disconnected.");
    log("broker disconnected — reconnecting");
    notifyToolsChanged();
    // The daemon idled out, crashed, or retired for a newer one. Any of those is
    // recoverable: connect again, spawning a replacement if nothing answers.
    connectToBroker().catch((err) => log("reconnect failed:", err?.message ?? err));
  };
  socket.on("close", drop);
  socket.on("error", drop);
}

/**
 * Connects to the broker, starting one if there isn't a usable one already.
 *
 * Retries rather than failing on the first refusal, because "nothing is
 * listening yet" is the ordinary first-run state, not an error — the daemon we
 * just spawned needs a moment to bind.
 */
async function connectToBroker(attempts = 12) {
  // Two overlapping loops would both spawn brokers and both adopt a socket,
  // leaving one orphaned and this session counted twice.
  if (connecting || broker) return !!broker;
  connecting = true;
  try {
    return await attemptConnect(attempts);
  } finally {
    connecting = false;
  }
}

async function attemptConnect(attempts) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    let established;
    try {
      established = await dialBroker();
    } catch (err) {
      // Diagnose as soon as the condition is visible, not after the retries run
      // out. A stale pre-broker server is not going to start behaving on attempt
      // nine, and by then an assistant has long since called `editor_status` and
      // been told only that something is not working yet. Retrying underneath a
      // published explanation costs nothing; withholding it for half a minute
      // costs the user the whole diagnosis.
      if (err?.silent) {
        bridgeFailure =
          `Something is holding port ${PORT} but does not speak the bridge protocol. This is ` +
          "almost always an MCP server from an older checkout of the engine, left running by a " +
          "Claude or Codex session that is still open — it owned this port itself, before the " +
          "broker existed. Close that session (or kill the stray `node .../mcp/server.mjs` " +
          "process) and this will connect on its own.";
        if (attempt === 0) log(bridgeFailure);
      }
      // Nothing (usable) is listening. Start one and give it a moment. Doing
      // this on every failed attempt rather than only the first is deliberate:
      // if two sessions race, the loser's broker exits, and whichever daemon
      // survives may still be a moment from binding.
      if (attempt === 0 || attempt === 3) spawnBroker();
      await wait(Math.min(150 * (attempt + 1), 600));
      continue;
    }

    const { socket, welcome } = established;
    // An older daemon left over from a previous checkout speaks an older
    // protocol. Retire it and take the port with a current one, rather than
    // leaving the user to find a stale process by hand.
    if (Number(welcome.protocol) < BRIDGE_PROTOCOL) {
      log(`broker pid ${welcome.pid} speaks protocol ${welcome.protocol}; retiring it for ${BRIDGE_PROTOCOL}`);
      try {
        socket.send(JSON.stringify({ type: "retire", protocol: BRIDGE_PROTOCOL }));
        socket.close();
      } catch {
        // already closing
      }
      await wait(300);
      spawnBroker();
      await wait(200);
      continue;
    }
    if (Number(welcome.protocol) > BRIDGE_PROTOCOL) {
      // The reverse skew: a NEWER broker, i.e. this session is the stale one.
      // Retiring it would start a fight between two long-lived sessions, so
      // attach anyway and say so — the shapes are usually still compatible, and
      // a loud log beats a silent downgrade.
      log(`warning: broker speaks protocol ${welcome.protocol}, this server speaks ${BRIDGE_PROTOCOL}`);
    }

    adoptBroker(socket);
    bridgeFailure = null;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    log(`attached to bridge broker pid ${welcome.pid} on port ${PORT}`);
    return true;
  }
  bridgeFailure ??=
    `Could not start or reach a bridge broker on port ${PORT} after ${attempts} attempts. ` +
    "Check that the port is free and that mcp/broker.mjs can run.";
  // Back off, but NEVER stop. This process lives as long as the conversation
  // does, and the thing blocking the port — a stale server from an older
  // checkout, an editor mid-restart — is usually cleared by hand minutes later.
  // An earlier version returned false here and simply stopped, so a session that
  // started during that window stayed toolless until the whole client was
  // restarted, with no way for the user to tell that clearing the blockage had
  // done any good. Retrying quietly is what makes the fix take effect on its own.
  scheduleBrokerRetry();
  return false;
}

/** How long to wait before retrying a bridge connection that would not come up. */
const RETRY_MS = Number(process.env.ENGINE_MCP_RETRY_MS ?? 10_000);

/** Retries the connection later, unless one is already scheduled or live. */
function scheduleBrokerRetry(ms = RETRY_MS) {
  if (retryTimer || broker) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (broker) return;
    connectToBroker().catch((err) => log("retry failed:", err?.message ?? err));
  }, ms);
  retryTimer.unref?.();
}

// ---------------------------------------------------------------------------
// MCP surface
// ---------------------------------------------------------------------------

/**
 * Sent to the client during initialize, before any tool is called.
 *
 * The tool list says what each tool does and nothing about where the assistant
 * IS: that the folder it has open is a game, that a live editor is holding that
 * project in memory, that scene files are generated. The project's own AGENTS.md
 * carries the long version — but only agents that read files before acting will
 * ever see it, and only once a project is open. This is the floor: short, always
 * delivered, and true before the editor has even connected.
 */
const INSTRUCTIONS = `These tools drive a LIVE, RUNNING instance of the Three Engine editor — a
three.js/WebGPU game editor — with a person watching it. They are not file
operations against a project on disk; they are remote control of an application.

Call \`editor_status\` first. It tells you whether the editor is actually
connected and which project and scene it has open. If it is not connected, no
other tool will work, and saying so is better than guessing.

Then orient yourself with \`scene_get\`, \`entity_list\` and \`module_list\` before
changing anything. \`component_types\` lists every component and its real property
names; read it rather than guessing.

What to keep in mind:
- Scene edits (\`entity_*\`, \`component_*\`) go through the editor's undo stack, so
  the person can take back your work. Prefer them to writing files.
- Never hand-edit a \`.scene\` file. It is a serialization format the editor
  already has loaded; your changes will be overwritten or load broken.
- \`asset_delete\`, \`asset_write\` and the build tools are NOT undoable. Ask before
  deleting the user's files.
- The project may be under version control: \`git_status\` says whether it is, and
  the \`git_*\` tools commit, branch, diff and push exactly as the editor's Source
  Control panel does. A commit before a large or risky change is the only undo
  that survives closing the editor. \`git_discard\` is the one tool here that
  destroys work — confirm it first.
- Look at what you built: \`viewport_screenshot\` returns a real image, and
  \`console_read\` returns the editor's errors.
- Many tools are gated on an engine module and will refuse with a message naming
  it. Enabling a module changes what the project ships — ask first.
- Before concluding the editor cannot do something, check \`editor_status\`:
  it reports how many tools the editor is actually offering, by family. Your
  tool list was fetched once and can be older than the editor it describes.

If a project is open, read AGENTS.md in the project folder for the fuller
version, including that project's own conventions.`;

const server = new Server(
  { name: "three-engine", version: "1.0.0" },
  { capabilities: { tools: { listChanged: true } }, instructions: INSTRUCTIONS },
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
      brokerConnected: !!broker,
      hint: broker
        ? "The bridge is up but the engine editor is not attached to it. Start the editor " +
          "(npm run dev, or the desktop app), open a project, and make sure Project Settings → " +
          `MCP is enabled and set to port ${PORT}. Tools will appear automatically once it connects.`
        : (bridgeFailure ??
          `Could not reach the bridge broker on port ${PORT} yet, so nothing can be forwarded to ` +
            "the editor. This normally resolves itself within a second or two of startup."),
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
  // Families, not just a count. The number on its own cannot be compared to
  // anything — but "the editor is offering 12 texture_* tools" is directly
  // checkable against the list the client is holding, which is the one thing
  // that distinguishes "this editor cannot do that" from "your tool list is
  // older than this editor". An assistant that concludes the former when the
  // latter is true stops looking and writes a worse solution around the gap,
  // and nothing in a stale tool list says it is stale.
  const families = {};
  for (const tool of editorTools) {
    const family = tool.name.split("_")[0];
    families[family] = (families[family] ?? 0) + 1;
  }
  return {
    connected: true,
    port: PORT,
    apiVersion: editorInfo?.apiVersion ?? null,
    toolCount: editorTools.length,
    toolFamilies: families,
    // One editor can be driven by several assistants at once. That is a
    // supported setup, not an anomaly — but it does mean the scene can change
    // under you between two of your own calls, and that the undo stack is
    // shared. An assistant that knows it has company can say so before making a
    // large change; one that assumes it is alone will blame the editor.
    attachedSessions: sessionCount,
    ...(sessionCount > 1
      ? {
          sharedEditorHint:
            `${sessionCount} assistant sessions are attached to this editor. The scene, the undo ` +
            "stack and play mode are shared, so re-read state you depend on rather than trusting " +
            "a cached read, and prefer narrow, reversible edits.",
        }
      : {}),
    staleListHint:
      "If a tool you expect is missing from your list, compare it with toolCount/toolFamilies above. " +
      "A tool list is fetched once per session, so it can predate the running editor; reconnecting " +
      "(or reloading the editor after an engine update) refreshes it.",
    project,
    scene,
  };
}

/**
 * MCP content for an op result.
 *
 * JSON text for structured ops, but an op that produces a picture must come
 * back as an image block or the whole point is lost — a base64 PNG rendered as
 * a wall of text is worse than useless, since it burns the context window and
 * still cannot be seen. `viewport.screenshot` marks its result with `__image`;
 * that key is the contract between the editor and this file.
 *
 * The remaining fields still travel as text alongside the image, so the caller
 * knows what it is looking at (which camera, what size).
 */
const asContent = (value) => {
  if (value && typeof value === "object" && value.__image?.base64) {
    const { __image, ...rest } = value;
    const content = [
      { type: "image", data: __image.base64, mimeType: __image.mimeType ?? "image/png" },
    ];
    if (Object.keys(rest).length) {
      content.push({ type: "text", text: JSON.stringify(rest, null, 2) });
    }
    return { content };
  }
  return { content: [{ type: "text", text: JSON.stringify(value ?? null, null, 2) }] };
};

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
  // Close our socket, never the broker: it is shared with every other session
  // and is meant to outlive us. It reaps itself once nothing is attached.
  const socket = broker;
  broker = null;
  try {
    socket?.close(1000, "session ending");
  } catch {
    // already closing
  }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// The MCP client (claude) closes its end of stdin when IT exits — the normal
// end of a `-p` turn, not an error. Without this, nothing here ever reacts to
// that: the open WebSocket keeps a live handle open, which keeps the event loop
// (and therefore the process) alive indefinitely even with a completely dead
// stdio channel. That used to be actively destructive, because the orphan also
// squatted on PORT and every subsequent session failed to bind it. Since the
// port moved to the broker an orphan is merely a leak rather than a denial of
// service — but it is still a leak, and this is still the fix.
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);

await server.connect(new StdioServerTransport());
mcpConnected = true;
log("MCP server ready on stdio");
// Not awaited: `tools/list` blocks on the editor for us (see STARTUP_GRACE_MS),
// so the client's very first request already covers the connect latency, and
// holding up `server.connect` behind a broker spawn would only make a slow
// bridge look like a slow handshake.
connectToBroker().catch((err) => log("could not attach to a bridge broker:", err?.message ?? err));
// If the editor was already waiting when we finished connecting, the
// list_changed we skipped above still needs sending.
if (editor) notifyToolsChanged();
