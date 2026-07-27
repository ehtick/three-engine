// End-to-end MCP smoke: a real MCP client drives a real MCP server, which
// drives a real editor, which mutates a real scene.
//
//   npx vite --port 5211 --strictPort
//   node scripts/run-mcp-smoke.mjs [url]
//
// HEADLESS=1 to hide the window.
//
// `run-mcp-test.mjs` already covers the protocol against a fake editor, and it
// is the one to run while iterating. This one exists for the assertions that
// only mean something against the real thing:
//
//   - The manifest an assistant sees is the LIVE op registry, not a hand-kept
//     list. If someone adds an op and forgets a description or a schema, this
//     is where it shows.
//   - A tool call actually changes the scene — asserted by reading the engine
//     from the page, not by trusting the tool's own return value.
//   - `history_undo` reverts it. This is the whole safety story for letting an
//     assistant touch a user's project, and it only holds because every op goes
//     through the command bus. A regression there is invisible in the tool's
//     response and obvious here.
//
// RUNS HEADED by default, same reason as the other engine harnesses: headless
// Chrome exposes no WebGPU adapter, so the editor never gets a renderer.
//
// START THE DEV SERVER FRESH — see the `?t=` trap in run-multiscript-smoke.mjs.
import puppeteer from "puppeteer-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "..", "mcp", "server.mjs");
const url = process.argv[2] ?? "http://localhost:5211/";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

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

// --- editor ------------------------------------------------------------------

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADLESS ? "new" : false,
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.stack ?? e.message}`));

await page.goto(url, { waitUntil: "load", timeout: 45000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await wait(6000);

const booted = await page.evaluate(async (port) => {
  const importLive = (p) => {
    const prefix = location.origin + p;
    const fetched = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
    return import(/* @vite-ignore */ live ?? p);
  };
  const { ensureEngine } = await importLive("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  if (!engine.renderer) return { fatal: "editor never got a renderer" };
  // The bridge is off by default (it's a project setting), so the harness turns
  // it on directly rather than driving the settings UI — this test is about the
  // bridge, not about the checkbox.
  const { configureMcpBridge, useMcpStore } = await importLive("/src/editor/api/mcpBridge.js");
  globalThis.__mcpStore = useMcpStore;
  configureMcpBridge({ enabled: true, port });
  return { fatal: null };
}, PORT);

if (booted.fatal) {
  console.log(` FAIL  ${booted.fatal}`);
  await browser.close();
  process.exit(1);
}

// --- MCP client + server ------------------------------------------------------

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...process.env, ENGINE_MCP_PORT: String(PORT), ENGINE_MCP_GRACE_MS: "8000" },
  stderr: "pipe",
});
const client = new Client({ name: "mcp-smoke", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

// The editor is retrying with backoff; give it a beat to notice the server.
await wait(2500);
const bridgeStatus = await page.evaluate(() => globalThis.__mcpStore.getState());
check(
  "the editor's bridge connects to the MCP server",
  bridgeStatus.status === "connected",
  `status=${bridgeStatus.status} tools=${bridgeStatus.toolCount}`,
);

const listed = await client.listTools();
const names = listed.tools.map((t) => t.name);
check("the assistant sees the live op registry", names.length > 25, `${names.length} tools`);
check("…including entity_create", names.includes("entity_create"));
check("…and component_types (the discovery tool)", names.includes("component_types"));
check("…and editor_status", names.includes("editor_status"));
check("no advertised tool name contains a dot", names.every((n) => !n.includes(".")));
check(
  "every tool carries a description and an object schema",
  listed.tools.every((t) => t.description?.length > 10 && t.inputSchema?.type === "object"),
);
check(
  "undoable ops say so in their description",
  /Undoable/.test(listed.tools.find((t) => t.name === "entity_create")?.description ?? ""),
);

const status = await client.callTool({ name: "editor_status", arguments: {} });
const statusText = status.content?.[0]?.text ?? "";
check("editor_status reports the live editor", /"connected":\s*true/.test(statusText));
check("…and reads the open scene", /"scene"/.test(statusText) && !/"scene":\s*null/.test(statusText), statusText.slice(0, 160));

// --- a real edit --------------------------------------------------------------

const before = await page.evaluate(() => globalThis.__editorApi.entities.all().length);

const created = await client.callTool({
  name: "entity_create",
  arguments: { name: "McpSpawner", transform: { position: [4, 5, 6] } },
});
const createdText = created.content?.[0]?.text ?? "";
check("entity_create succeeds", created.isError !== true, createdText.slice(0, 120));

const live = await page.evaluate(() => {
  const found = globalThis.__editorApi.entities.all({ nameContains: "McpSpawner" });
  return { count: found.length, position: found[0]?.transform?.position ?? null, id: found[0]?.id ?? null };
});
check("the entity really exists in the editor's scene", live.count === 1, `${live.count} found`);
check("…at the position the tool asked for", JSON.stringify(live.position) === "[4,5,6]", JSON.stringify(live.position));

const added = await client.callTool({
  name: "component_add",
  arguments: { id: live.id, type: "mesh", props: { geometry: "sphere" } },
});
const hasMesh = await page.evaluate(
  (id) => globalThis.__editorApi.entities.get(id).components.some((c) => c.type === "mesh"),
  live.id,
);
check("component_add attaches a real component", added.isError !== true && hasMesh === true);

// The load-bearing check: an assistant's edits must be revertible by the user.
await client.callTool({ name: "history_undo", arguments: {} });
await client.callTool({ name: "history_undo", arguments: {} });
const after = await page.evaluate(() => ({
  total: globalThis.__editorApi.entities.all().length,
  spawners: globalThis.__editorApi.entities.all({ nameContains: "McpSpawner" }).length,
}));
check("history_undo reverts the assistant's edits", after.spawners === 0 && after.total === before, JSON.stringify(after));

// --- error paths against the real registry -----------------------------------

const badArgs = await client.callTool({ name: "entity_get", arguments: { id: "no-such-entity" } });
check(
  "a bad argument comes back as a readable error, not a crash",
  badArgs.isError === true && /No entity with id/.test(badArgs.content?.[0]?.text ?? ""),
  badArgs.content?.[0]?.text,
);

const unknownParam = await client.callTool({ name: "entity_list", arguments: { bogus: 1 } });
check(
  "the registry's parameter validation reaches the assistant",
  unknownParam.isError === true && /unknown parameter/i.test(unknownParam.content?.[0]?.text ?? ""),
  unknownParam.content?.[0]?.text,
);

// Path containment is the safety story for letting an assistant write files, so
// it gets a real test rather than one that passes because no project is open —
// "No project is open" would satisfy a naive assertion while proving nothing.
// Faking a root exercises `insideProject` itself.
//
// Setting rootPath makes the editor apply that "project's" settings, which say
// MCP is disabled (the default) — so the bridge drops and has to be re-enabled
// afterwards. That is correct product behaviour, not a bug: project settings own
// the bridge. It just means the harness has to re-enable and wait for the
// reconnect, or the checks below would pass on "the editor disconnected".
await page.evaluate(async (port) => {
  const importLive = (p) => {
    const prefix = location.origin + p;
    const fetched = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    return import(/* @vite-ignore */ (fetched.find((n) => n.includes("?")) ?? fetched[0]) ?? p);
  };
  const { useProjectStore } = await importLive("/src/editor/store/projectStore.js");
  globalThis.__restoreRoot = useProjectStore.getState().rootPath;
  useProjectStore.setState({ rootPath: "C:/fake/project" });
  await new Promise((r) => setTimeout(r, 500));
  const { configureMcpBridge } = await importLive("/src/editor/api/mcpBridge.js");
  configureMcpBridge({ enabled: false, port });
  configureMcpBridge({ enabled: true, port });
}, PORT);

// Poll rather than sleep a fixed amount — the reconnect is a socket round trip.
let reconnected = false;
for (let i = 0; i < 20 && !reconnected; i++) {
  await wait(250);
  reconnected = (await page.evaluate(() => globalThis.__mcpStore.getState().status)) === "connected";
}
check("the bridge reconnects after a settings change", reconnected);

const escape = await client.callTool({
  name: "asset_read",
  arguments: { path: "C:/Windows/System32/drivers/etc/hosts" },
});
check(
  "reads outside the project are refused",
  escape.isError === true && /outside the open project/.test(escape.content?.[0]?.text ?? ""),
  escape.content?.[0]?.text,
);

const escapeWrite = await client.callTool({
  name: "asset_write",
  arguments: { path: "C:/Windows/Temp/engine-mcp-should-not-exist.txt", contents: "x" },
});
check(
  "writes outside the project are refused",
  escapeWrite.isError === true && /outside the open project/.test(escapeWrite.content?.[0]?.text ?? ""),
  escapeWrite.content?.[0]?.text,
);

// The mirror half: a path INSIDE the root must get past containment. It still
// fails (there is no such file, and no Tauri here) — but with a different
// error, which is what proves the check is a boundary and not a blanket refusal.
const inside = await client.callTool({
  name: "asset_read",
  arguments: { path: "C:/fake/project/scenes/Main.scene" },
});
check(
  "a path inside the project gets past containment",
  // Must fail on the FILE (no Tauri in a plain browser), not on the boundary and
  // not on the bridge — otherwise this would pass whenever the socket dropped,
  // which is exactly how it passed for the wrong reason the first time.
  /asset_read failed/.test(inside.content?.[0]?.text ?? "") &&
    !/outside the open project/.test(inside.content?.[0]?.text ?? ""),
  inside.content?.[0]?.text?.slice(0, 110),
);

await page.evaluate(async () => {
  const importLive = (p) => {
    const prefix = location.origin + p;
    const fetched = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    return import(/* @vite-ignore */ (fetched.find((n) => n.includes("?")) ?? fetched[0]) ?? p);
  };
  const { useProjectStore } = await importLive("/src/editor/store/projectStore.js");
  useProjectStore.setState({ rootPath: globalThis.__restoreRoot ?? null });
});

// --- the editor going away ----------------------------------------------------

await page.evaluate(async () => {
  const importLive = (p) => {
    const prefix = location.origin + p;
    const fetched = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    return import(/* @vite-ignore */ (fetched.find((n) => n.includes("?")) ?? fetched[0]) ?? p);
  };
  const { configureMcpBridge } = await importLive("/src/editor/api/mcpBridge.js");
  configureMcpBridge({ enabled: false, port: 0 });
});
await wait(1200);

const offline = await client.listTools();
check(
  "closing the bridge empties the tool list",
  offline.tools.length === 1 && offline.tools[0].name === "editor_status",
  `${offline.tools.length} tools`,
);
const offlineStatus = await client.callTool({ name: "editor_status", arguments: {} });
check(
  "…and editor_status explains why",
  /"connected":\s*false/.test(offlineStatus.content?.[0]?.text ?? ""),
);

await client.close();

const hard = errors.filter((e) => !/WebGPU|GPUAdapter|deprecat|Failed to load resource|WebSocket/i.test(e));
if (hard.length) {
  console.log("\nconsole errors:");
  for (const e of hard.slice(0, 10)) console.log(`  ${e}`);
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\nMCP-SMOKE ${failed.length === 0 && hard.length === 0 ? "PASS" : "FAIL"} — ${results.length - failed.length}/${results.length} checks`,
);
await browser.close();
process.exit(failed.length === 0 && hard.length === 0 ? 0 : 1);
