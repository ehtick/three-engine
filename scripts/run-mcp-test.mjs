// MCP server + protocol test. No browser, no editor — a fake editor sits on the
// bridge socket and a real MCP client drives the server over stdio.
//
//   node scripts/run-mcp-test.mjs
//
// This is the half of the MCP integration that can be tested deterministically:
// the protocol, the dynamic tool list, and every failure path. `run-mcp-smoke`
// covers the other half (a real editor actually mutating a real scene), which
// needs a GPU and takes 30 seconds; this runs in about two and answers "did I
// break the wire format" on every change.
//
// The fake editor matters as much as the real one. Timeouts, disconnects mid-
// call, and an op that fails cleanly are all states a live editor reaches
// rarely and unreproducibly — here they are three lines each. Each has a
// distinct user-visible message, and the whole point of the test is that they
// stay distinguishable: "the editor is closed", "the editor stopped answering"
// and "the op you asked for failed" send an assistant in three directions.
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

/** A port nothing else is on, so parallel runs and a user's own editor don't
 *  collide with the test (17325 is very likely already taken here). */
const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = await freePort();
const TIMEOUT_MS = 1200;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: {
    ...process.env,
    ENGINE_MCP_PORT: String(PORT),
    // Short so the "no editor yet" list doesn't stall the test for 10s, but
    // non-zero so the wait path itself is still exercised.
    ENGINE_MCP_GRACE_MS: "400",
    ENGINE_MCP_TIMEOUT_MS: String(TIMEOUT_MS),
  },
  stderr: "pipe",
});

const client = new Client({ name: "mcp-test", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);
check("the MCP client completes the handshake", true);

// Orientation is delivered by the protocol itself, before any tool is called.
// Without it an assistant sees ~95 tool descriptions and knows nothing about
// where it is — that these drive a live editor with a person watching, that
// scene files are generated, that undo exists. A tool list cannot say that.
const instructions = client.getInstructions?.() ?? "";
check("the server introduces itself in the initialize response", instructions.length > 200, `${instructions.length} chars`);
check("…saying what the tools actually drive", /live/i.test(instructions) && /editor/i.test(instructions));
check("…and where to start", /editor_status/.test(instructions));

// --- 1. before any editor connects -------------------------------------------

let listed = await client.listTools();
let names = listed.tools.map((t) => t.name);
check("editor_status is offered with no editor connected", names.includes("editor_status"), names.join(", "));
check("no editor tools are advertised yet", names.length === 1, `${names.length} tools`);

const statusOffline = await client.callTool({ name: "editor_status", arguments: {} });
const offlineText = statusOffline.content?.[0]?.text ?? "";
check("editor_status reports disconnected", /"connected":\s*false/.test(offlineText));
check(
  "…and explains how to connect the editor",
  /Project Settings/.test(offlineText) && offlineText.includes(String(PORT)),
);

const offlineCall = await client.callTool({ name: "entity_create", arguments: { name: "X" } });
check(
  "calling an editor tool while offline is a clean error",
  offlineCall.isError === true && /editor to be running/.test(offlineCall.content?.[0]?.text ?? ""),
  offlineCall.content?.[0]?.text,
);

// --- 2. a fake editor connects ------------------------------------------------

const FAKE_TOOLS = [
  {
    name: "entity_create",
    description: "Create an entity.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, additionalProperties: false },
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
  {
    name: "always_fails",
    description: "An op that reports failure.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "never_answers",
    description: "An op the editor never replies to.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

/** Records what the server forwarded, so we can assert arguments survive. */
const seen = [];

function fakeEditor() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws.on("open", () => ws.send(JSON.stringify({ type: "hello", tools: FAKE_TOOLS, info: { apiVersion: "1.0.0" } })));
  ws.on("message", (raw) => {
    const { id, method, params } = JSON.parse(String(raw));
    seen.push({ method, params });
    const reply = (payload) => ws.send(JSON.stringify({ id, ...payload }));
    if (method === "tools") return reply({ ok: true, result: FAKE_TOOLS });
    if (method !== "call") return reply({ ok: false, error: `unknown method ${method}` });

    const { tool, args } = params;
    // The editor's real `callTool` never throws — it answers {ok,...}. The
    // fake must match that, or the test would prove nothing about the split
    // between "op failed" and "bridge failed".
    if (tool === "never_answers") return; // deliberate silence, exercises the timeout
    if (tool === "always_fails") return reply({ ok: true, result: { ok: false, error: "nope, bad argument" } });
    if (tool === "scene_get") return reply({ ok: true, result: { ok: true, result: { name: "FakeScene" } } });
    if (tool === "project_get") return reply({ ok: true, result: { ok: true, result: { rootPath: "/fake" } } });
    return reply({ ok: true, result: { ok: true, result: { id: "e1", echoedArgs: args } } });
  });
  return ws;
}

let editorSocket = fakeEditor();
await wait(600);

listed = await client.listTools();
names = listed.tools.map((t) => t.name);
check("the editor's tools appear once it connects", names.includes("entity_create"), `${names.length} tools`);
check("editor_status is still there alongside them", names.includes("editor_status"));
check(
  "tool schemas survive the bridge",
  listed.tools.find((t) => t.name === "entity_create")?.inputSchema?.properties?.name?.type === "string",
);

const statusOnline = await client.callTool({ name: "editor_status", arguments: {} });
const onlineText = statusOnline.content?.[0]?.text ?? "";
check("editor_status reports connected", /"connected":\s*true/.test(onlineText));
check("…and reads the scene LIVE rather than from the cached hello", /FakeScene/.test(onlineText), onlineText.slice(0, 120));

// A stale tool list is indistinguishable from a missing feature — it caused an
// assistant to conclude the texture editor had "no drawing primitives" and work
// around a tool it simply had not been told about. The count and the per-family
// breakdown come from what the EDITOR is offering right now, so an assistant
// that suspects a gap can compare them against the list it is holding.
const status = JSON.parse(onlineText);
check("editor_status reports how many tools the editor is really offering", status.toolCount === FAKE_TOOLS.length, `${status.toolCount}`);
check(
  "…broken down by family, so a missing one is checkable",
  status.toolFamilies?.scene === 1 && status.toolFamilies?.entity === 1,
  JSON.stringify(status.toolFamilies),
);
check("…with the reason a list can disagree", /predate the running editor/.test(status.staleListHint ?? ""));

// --- 3. calls ----------------------------------------------------------------

const created = await client.callTool({ name: "entity_create", arguments: { name: "Spawner" } });
const createdText = created.content?.[0]?.text ?? "";
check("a tool call reaches the editor", seen.some((s) => s.params?.tool === "entity_create"));
check("arguments are forwarded intact", /"name":\s*"Spawner"/.test(createdText), createdText);
check("the result is returned as JSON content", /"id":\s*"e1"/.test(createdText));
check("a successful call is not flagged as an error", created.isError !== true);

const failed = await client.callTool({ name: "always_fails", arguments: {} });
check(
  "an op that fails is surfaced with its own message",
  failed.isError === true && /nope, bad argument/.test(failed.content?.[0]?.text ?? ""),
  failed.content?.[0]?.text,
);

const timedOut = await client.callTool({ name: "never_answers", arguments: {} });
check(
  "an unanswered call times out instead of hanging",
  timedOut.isError === true && /did not answer/.test(timedOut.content?.[0]?.text ?? ""),
  timedOut.content?.[0]?.text,
);

// --- 4. the editor goes away and comes back ----------------------------------

editorSocket.close();
await wait(400);
listed = await client.listTools();
check(
  "the tool list empties when the editor disconnects",
  listed.tools.length === 1 && listed.tools[0].name === "editor_status",
  `${listed.tools.length} tools`,
);

editorSocket = fakeEditor();
await wait(600);
listed = await client.listTools();
check(
  "…and refills when it reconnects",
  listed.tools.map((t) => t.name).includes("entity_create"),
  `${listed.tools.length} tools`,
);

// A reload can open the new socket before the old one's close lands; the newest
// must win rather than leaving calls routed at a dead socket.
const replacement = fakeEditor();
await wait(600);
const afterReplace = await client.callTool({ name: "entity_create", arguments: { name: "AfterReplace" } });
check(
  "a replacement connection takes over cleanly",
  /AfterReplace/.test(afterReplace.content?.[0]?.text ?? ""),
  afterReplace.content?.[0]?.text?.slice(0, 80),
);

replacement.close();
try {
  editorSocket.close();
} catch {
  // already closed by the server as the replaced connection
}
await client.close();

const failedChecks = results.filter((r) => !r.ok);
console.log(
  `\nMCP-TEST ${failedChecks.length === 0 ? "PASS" : "FAIL"} — ${results.length - failedChecks.length}/${results.length} checks`,
);
process.exit(failedChecks.length === 0 ? 0 : 1);
