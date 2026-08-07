// Multi-session bridge test: several MCP sessions driving ONE editor.
//
//   node scripts/run-mcp-multi-test.mjs
//
// `run-mcp-test` covers one session's protocol surface. This covers the thing
// that made the broker necessary: an MCP server over stdio is spawned per
// client, so two assistants are always two server processes, and they used to
// fight over the editor's port — the loser exited and its client reported a bare
// `-32000`. Everything here would have been impossible before `mcp/broker.mjs`.
//
// The checks worth understanding:
//
//   * Id collision. Sessions number their calls from 1 independently, so two
//     concurrent calls are BOTH id 1 on the wire. The broker rewrites ids and
//     maps replies back. If it ever stops doing that, the sessions silently
//     receive each other's results — a scene read answering with someone else's
//     scene — which no single-session test can catch. The two calls here are
//     deliberately held in flight together to force the overlap.
//   * Session independence. Killing one session must not disturb the other.
//     That is the original bug, stated as a test.
//   * Retirement. A stale daemon from an older checkout is the failure mode this
//     design could plausibly reintroduce, so the retire-and-respawn path is
//     exercised end to end, including sessions reconnecting afterwards.
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "..", "mcp", "server.mjs");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A port nothing else is on — 17325 is very likely taken by a real editor. */
const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const PORT = await freePort();

const ENV = {
  ...process.env,
  ENGINE_MCP_PORT: String(PORT),
  ENGINE_MCP_GRACE_MS: "3000",
  ENGINE_MCP_TIMEOUT_MS: "4000",
  // Short, so a broker left behind by this test reaps itself in seconds rather
  // than sitting on the port for the two minutes a real one is given.
  ENGINE_MCP_IDLE_MS: "3000",
  // Likewise for the self-healing retry (10s in production).
  ENGINE_MCP_RETRY_MS: "1000",
};

// ---------------------------------------------------------------------------
// A fake editor — with reconnect, like the real one
// ---------------------------------------------------------------------------

const FAKE_TOOLS = [
  {
    name: "echo",
    description: "Echo the arguments back.",
    inputSchema: { type: "object", properties: { tag: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "slow_echo",
    description: "Echo the arguments back, slowly.",
    inputSchema: { type: "object", properties: { tag: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "scene_get",
    description: "Read the scene.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "project_get",
    description: "Read the project.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

/**
 * Mirrors `src/editor/api/mcpBridge.js`, including its reconnect loop — without
 * that the retirement check below would prove nothing, since a real editor
 * survives a broker restart and a one-shot fake would not.
 */
function fakeEditor(port = PORT) {
  const handle = { ws: null, closed: false, connects: 0 };
  const open = () => {
    if (handle.closed) return;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    handle.ws = ws;
    ws.on("open", () => {
      handle.connects++;
      ws.send(JSON.stringify({ type: "hello", tools: FAKE_TOOLS, info: { apiVersion: "1.0.0" } }));
    });
    ws.on("message", async (raw) => {
      const { id, method, params } = JSON.parse(String(raw));
      const reply = (payload) => {
        try {
          ws.send(JSON.stringify({ id, ...payload }));
        } catch {
          // socket died; the caller times out
        }
      };
      if (method !== "call") return reply({ ok: false, error: `unknown method ${method}` });
      const { tool, args } = params;
      if (tool === "slow_echo") await wait(500);
      if (tool === "scene_get") return reply({ ok: true, result: { ok: true, result: { name: "FakeScene" } } });
      if (tool === "project_get") return reply({ ok: true, result: { ok: true, result: { rootPath: "/fake" } } });
      return reply({ ok: true, result: { ok: true, result: { echoedTag: args?.tag ?? null } } });
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      if (!handle.closed) setTimeout(open, 120);
    });
  };
  open();
  handle.stop = () => {
    handle.closed = true;
    try {
      handle.ws?.close();
    } catch {
      // already closed
    }
  };
  return handle;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

async function startSession(name, port = PORT) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...ENV, ENGINE_MCP_PORT: String(port) },
    stderr: "pipe",
  });
  const client = new Client({ name, version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

const textOf = (res) => res.content?.map((c) => c.text).filter(Boolean).join("\n") ?? "";
const tagOf = (res) => {
  try {
    return JSON.parse(textOf(res))?.echoedTag ?? null;
  } catch {
    return null;
  }
};

const editorHandle = fakeEditor();

// --- 1. two sessions, one editor ---------------------------------------------

const [alice, bob] = await Promise.all([startSession("alice"), startSession("bob")]);
check("two MCP sessions start against one port", true);

// Both must see the editor. Before the broker, exactly one of these processes
// survived and the other's client reported a transport error.
await wait(1500);
const aliceTools = (await alice.listTools()).tools.map((t) => t.name);
const bobTools = (await bob.listTools()).tools.map((t) => t.name);
check("session A sees the editor's tools", aliceTools.includes("echo"), `${aliceTools.length} tools`);
check("session B sees the editor's tools too", bobTools.includes("echo"), `${bobTools.length} tools`);
check("…and the same ones", aliceTools.length === bobTools.length);
check("the editor only ever connected once", editorHandle.connects === 1, `${editorHandle.connects} connects`);

// --- 2. both sessions can drive it -------------------------------------------

const aliceCall = await alice.callTool({ name: "echo", arguments: { tag: "from-alice" } });
const bobCall = await bob.callTool({ name: "echo", arguments: { tag: "from-bob" } });
check("session A can call the editor", tagOf(aliceCall) === "from-alice", textOf(aliceCall));
check("session B can call the editor", tagOf(bobCall) === "from-bob", textOf(bobCall));

// --- 3. the id-collision case ------------------------------------------------

// Held in flight together on purpose: `slow_echo` sits for 500ms, so both calls
// are outstanding at the broker at the same instant, each numbered from its own
// session's counter. This is the one thing that cannot work without id rewriting.
const [slowA, slowB] = await Promise.all([
  alice.callTool({ name: "slow_echo", arguments: { tag: "concurrent-alice" } }),
  bob.callTool({ name: "slow_echo", arguments: { tag: "concurrent-bob" } }),
]);
check(
  "concurrent calls from both sessions do not cross replies",
  tagOf(slowA) === "concurrent-alice" && tagOf(slowB) === "concurrent-bob",
  `A got ${tagOf(slowA)}, B got ${tagOf(slowB)}`,
);

// --- 4. sessions know they have company --------------------------------------

const status = JSON.parse(textOf(await alice.callTool({ name: "editor_status", arguments: {} })));
check("editor_status reports both sessions", status.attachedSessions === 2, `${status.attachedSessions}`);
check(
  "…and warns that the scene and undo stack are shared",
  /shared/i.test(status.sharedEditorHint ?? ""),
  status.sharedEditorHint?.slice(0, 60),
);
check("…while still reporting the editor as connected", status.connected === true);

// --- 5. one session leaving does not disturb the other -----------------------

await alice.close();
await wait(800);
const afterAlice = await bob.callTool({ name: "echo", arguments: { tag: "bob-alone" } });
check("session B keeps working after session A exits", tagOf(afterAlice) === "bob-alone", textOf(afterAlice));
check("the editor did not have to reconnect", editorHandle.connects === 1, `${editorHandle.connects} connects`);

const soloStatus = JSON.parse(textOf(await bob.callTool({ name: "editor_status", arguments: {} })));
check("…and the session count drops back to one", soloStatus.attachedSessions === 1, `${soloStatus.attachedSessions}`);

// --- 6. a session joining late attaches to the running broker ----------------

const carol = await startSession("carol");
await wait(1500);
const carolTools = (await carol.listTools()).tools.map((t) => t.name);
check("a session starting later sees the already-connected editor", carolTools.includes("echo"), `${carolTools.length} tools`);
check("…without the editor reconnecting", editorHandle.connects === 1, `${editorHandle.connects} connects`);

// --- 7. the editor going away reaches every session --------------------------

editorHandle.stop();
await wait(900);
const bobAfterEditorGone = (await bob.listTools()).tools.map((t) => t.name);
const carolAfterEditorGone = (await carol.listTools()).tools.map((t) => t.name);
check(
  "every session's tool list empties when the editor disconnects",
  bobAfterEditorGone.length === 1 && carolAfterEditorGone.length === 1,
  `B ${bobAfterEditorGone.length}, C ${carolAfterEditorGone.length}`,
);

const editor2 = fakeEditor();
await wait(1500);
const bobRefilled = (await bob.listTools()).tools.map((t) => t.name);
const carolRefilled = (await carol.listTools()).tools.map((t) => t.name);
check(
  "…and refills for every session when it comes back",
  bobRefilled.includes("echo") && carolRefilled.includes("echo"),
  `B ${bobRefilled.length}, C ${carolRefilled.length}`,
);

// --- 8. retiring a stale broker ----------------------------------------------

// A session that finds an older daemon on the port tells it to stand down and
// starts a current one. Simulated here by sending that message directly: what is
// being checked is the recovery, i.e. that both live sessions reattach to the
// replacement on their own rather than needing a restart.
const retirer = new WebSocket(`ws://127.0.0.1:${PORT}`);
await new Promise((resolve) => {
  retirer.on("open", () => {
    retirer.send(JSON.stringify({ type: "session", protocol: 1, client: "retire-probe" }));
    setTimeout(() => {
      retirer.send(JSON.stringify({ type: "retire", protocol: 99 }));
      retirer.close();
      resolve();
    }, 200);
  });
  retirer.on("error", resolve);
});

await wait(3000);
const bobAfterRetire = await bob.callTool({ name: "echo", arguments: { tag: "after-retire" } });
check(
  "sessions recover automatically after the broker is retired",
  tagOf(bobAfterRetire) === "after-retire",
  textOf(bobAfterRetire),
);
const carolAfterRetire = await carol.callTool({ name: "echo", arguments: { tag: "carol-after-retire" } });
check(
  "…all of them, not just the one that noticed first",
  tagOf(carolAfterRetire) === "carol-after-retire",
  textOf(carolAfterRetire),
);

// --- 9. a session that starts while the port is blocked heals itself ---------

// The migration case, and a real one: a PRE-BROKER `mcp/server.mjs` from an
// older checkout owns the port and treats every connection as the editor, so it
// accepts and never welcomes, and cannot be retired over a protocol it does not
// speak. A session starting into that must (a) say so, because "no tools" with
// no explanation is indistinguishable from a broken install, and (b) come up on
// its own once the blockage is cleared — the first version gave up after its
// initial attempts and stayed dead until the whole client was restarted, which
// meant fixing the actual problem appeared to change nothing.
const BLOCKED_PORT = await freePort();
const legacy = new (await import("ws")).WebSocketServer({ host: "127.0.0.1", port: BLOCKED_PORT });
legacy.on("connection", () => {}); // accept, then say nothing at all

const blocked = await startSession("blocked", BLOCKED_PORT);
await wait(6000);
const blockedStatus = JSON.parse(textOf(await blocked.callTool({ name: "editor_status", arguments: {} })));
check(
  "a session blocked by a pre-broker server explains what is holding the port",
  /older checkout/.test(blockedStatus.hint ?? ""),
  blockedStatus.hint?.slice(0, 70),
);
check("…and reports the bridge itself as unreachable", blockedStatus.brokerConnected === false);

await new Promise((resolve) => legacy.close(resolve));
const editor3 = fakeEditor(BLOCKED_PORT);
// Long enough for the retry (1s here, 10s in production) to fire and win.
await wait(6000);
const healed = (await blocked.listTools()).tools.map((t) => t.name);
check(
  "…then connects on its own once the port frees, with no restart",
  healed.includes("echo"),
  `${healed.length} tools`,
);
editor3.stop();
await blocked.close();

// --- done --------------------------------------------------------------------

editor2.stop();
await bob.close();
await carol.close();
try {
  await alice.close();
} catch {
  // already closed
}

const failedChecks = results.filter((r) => !r.ok);
console.log(
  `\nMCP-MULTI ${failedChecks.length === 0 ? "PASS" : "FAIL"} — ${results.length - failedChecks.length}/${results.length} checks`,
);
process.exit(failedChecks.length === 0 ? 0 : 1);
