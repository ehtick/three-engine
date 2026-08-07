// Call an editor op from the shell, through the same MCP server an assistant uses.
//
// WHY THIS EXISTS. The editor's op registry is reachable three ways: the
// Inspector (a human), an MCP client (an assistant with the server registered),
// and nothing else. A session whose MCP client was never given `three-engine`
// — or a shell script, or CI — had no way in at all, which is awkward because
// the ops are the project's own supported automation surface and the standing
// rule is that every feature must be drivable by an agent.
//
// This is a thin CLI over `mcp/server.mjs`: it spawns the same stdio server,
// which dials the same broker on ENGINE_MCP_PORT, which routes to whatever
// editor is attached. Nothing new is bound and nothing is bypassed, so this
// cannot collide with a live assistant session — the broker exists precisely to
// let N sessions share one editor.
//
//   node scripts/engine-op.mjs --list
//   node scripts/engine-op.mjs profile_giPasses
//   node scripts/engine-op.mjs component_setProp '{"id":"...","type":"...","key":"...","value":1}'
//
// Prints the tool's JSON result to stdout and nothing else, so it pipes.
// Diagnostics go to stderr. Exits non-zero if the editor is not attached — a
// silent empty result would be indistinguishable from an op that returned
// nothing, which is the failure mode this project keeps re-learning.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "..", "mcp", "server.mjs");

const [, , toolArg, argsArg] = process.argv;
if (!toolArg) {
  console.error("usage: node scripts/engine-op.mjs <tool_name> ['<json args>']");
  console.error("       node scripts/engine-op.mjs --list");
  process.exit(2);
}

let args = {};
if (argsArg) {
  try {
    args = JSON.parse(argsArg);
  } catch (err) {
    console.error(`args must be JSON: ${err.message}`);
    process.exit(2);
  }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  // The server logs to stderr; let it through so a broker/editor problem is
  // visible rather than showing up as an inexplicable timeout.
  stderr: "inherit",
});
const client = new Client({ name: "engine-op-cli", version: "1.0.0" }, { capabilities: {} });

const fail = (msg, code = 1) => {
  console.error(msg);
  process.exit(code);
};

const timeout = Number(process.env.OP_TIMEOUT ?? 60_000);
const withTimeout = (p, what) =>
  Promise.race([
    p,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${what} timed out after ${timeout}ms`)), timeout).unref(),
    ),
  ]);

try {
  await withTimeout(client.connect(transport), "connect");

  if (toolArg === "--list") {
    const { tools } = await withTimeout(client.listTools(), "tools/list");
    // Names only by default — the full manifest is large and this is usually
    // "what can I call".
    if (process.env.FULL) console.log(JSON.stringify(tools, null, 2));
    else console.log(tools.map((t) => t.name).sort().join("\n"));
  } else {
    const res = await withTimeout(client.callTool({ name: toolArg, arguments: args }), toolArg);
    const text = (res?.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    if (res?.isError) fail(text || `${toolArg} reported an error with no message`);
    console.log(text);
  }
  await client.close();
  process.exit(0);
} catch (err) {
  fail(`engine-op: ${err?.message ?? err}`);
}
