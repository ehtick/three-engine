// MCP UI smoke: does the panel a user actually sees do what it says?
//
//   npx vite --port 5211 --strictPort
//   node scripts/run-mcp-ui-smoke.mjs [url]
//
// HEADED=1 to watch it run.
//
// ## Why this exists separately from run-mcp-smoke.mjs
//
// `run-mcp-smoke` proves the bridge and the protocol work — but it turns the
// bridge on by calling `configureMcpBridge()` directly, because that is the
// convenient thing to do from a harness. That convenience is exactly what let a
// real bug through: in the shipped UI the checkbox only wrote React state and
// marked the panel dirty, so nothing connected until the user also pressed
// Save, and nothing anywhere said so. Every automated check passed while the
// feature was unusable.
//
// So this harness touches nothing but the DOM: it opens the panel, clicks the
// real switch, and asserts the bridge dialled out — with a WebSocket server
// standing in for the MCP process, since what is under test is the editor half.
//
// The general lesson, worth keeping: a test that reaches past the UI to the
// function the UI calls cannot catch a UI that never calls it.
//
// It also covers the second reported bug, "it is disabled every time I restart
// the editor": the setting moved from project.json (per-project, Save-gated,
// default off) to an editor preference, so the harness reloads the whole page
// and asserts the bridge comes back on its own.
//
// START THE DEV SERVER FRESH — see the `?t=` note in run-editor-ui-smoke.mjs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import puppeteer from "puppeteer-core";
import { WebSocketServer } from "ws";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5211/";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Stand-in for mcp/server.mjs — this harness is about the editor half.
let helloTools = null;
const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
wss.on("connection", (socket) => {
  socket.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === "hello") helloTools = msg.tools;
  });
});

// --- a throwaway project (Project Settings needs one open) -------------------

const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-mcpui-"));
fs.writeFileSync(path.join(root, "project.json"), JSON.stringify({ name: "McpUi", version: 1 }, null, 2));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
await installTauriShim(page, {
  writableRoot: root,
  verbose: !!process.env.VERBOSE,
  extraCommands: {
    // Stand in for the Rust CLI probe. One installed and registered, one
    // installed but not, so both row states render.
    mcp_client_status: () => [
      { client: "claude", installed: true, path: "C:/fake/bin/claude.cmd", registered: true, error: null },
      { client: "codex", installed: true, path: "C:/fake/bin/codex.exe", registered: false, error: null },
    ],
  },
});

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

await page.evaluate(async (projectRoot) => {
  const importLive = (p) => {
    const prefix = location.origin + p;
    const fetched = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    return import(/* @vite-ignore */ (fetched.find((n) => n.includes("?")) ?? fetched[0]) ?? p);
  };
  globalThis.__importLive = importLive;
  const { ensureEngine } = await importLive("/src/editor/engineInstance.js");
  await ensureEngine();
  const { useProjectStore } = await importLive("/src/editor/store/projectStore.js");
  globalThis.__openDone = false;
  useProjectStore
    .getState()
    .openProject(projectRoot)
    .then(() => (globalThis.__openDone = true));
}, root.replaceAll("\\", "/"));

for (let i = 0; i < 60 && !(await page.evaluate(() => globalThis.__openDone === true)); i++) await wait(500);
check("the scratch project opens", await page.evaluate(() => globalThis.__openDone === true));

// --- open the Assistant (MCP) panel -------------------------------------------

await page.evaluate(async () => {
  const { openPanel } = await globalThis.__importLive("/src/editor/EditorShell.jsx");
  openPanel("mcp");
});
await wait(1500);

check(
  "the MCP panel opens",
  await page.evaluate(() => !!document.querySelector(".mcp-panel")),
);
check(
  "…and leads with a status line, not a paragraph",
  await page.evaluate(() => {
    const hero = document.querySelector(".mcp-hero");
    return !!hero && !!hero.querySelector(".mcp-hero-dot") && (hero.textContent ?? "").length < 90;
  }),
);
check(
  "MCP is no longer buried in Project Settings",
  await page.evaluate(async () => {
    const { openPanel } = await globalThis.__importLive("/src/editor/EditorShell.jsx");
    openPanel("projectSettings");
    await new Promise((r) => setTimeout(r, 900));
    const buried = [...document.querySelectorAll(".project-settings-panel .section-header")].some((h) =>
      /MCP/i.test(h.textContent ?? ""),
    );
    openPanel("mcp");
    await new Promise((r) => setTimeout(r, 900));
    return !buried;
  }),
);

// The port has to be set before enabling, or the editor dials the default.
await page.evaluate(async (port) => {
  const { setMcpPrefs } = await globalThis.__importLive("/src/editor/mcpPrefs.js");
  await setMcpPrefs({ port });
}, PORT);
await wait(300);
check(
  "the port field reflects the preference",
  await page.evaluate(() => Number(document.querySelector(".mcp-port-row input")?.value)) === PORT,
);

// --- the switch connects immediately, with no Save step ----------------------

await page.evaluate(() => document.querySelector(".mcp-switch input")?.click());

let connected = false;
for (let i = 0; i < 24 && !connected; i++) {
  await wait(250);
  connected = await page.evaluate(async () => {
    const { useMcpStore } = await globalThis.__importLive("/src/editor/api/mcpBridge.js");
    return useMcpStore.getState().status === "connected";
  });
}
check("flipping the switch connects the bridge — no Save step", connected);
check("…and the editor advertised its tools", (helloTools?.length ?? 0) > 25, `${helloTools?.length ?? 0} tools`);
check(
  "…and the panel says so at a glance",
  await page.evaluate(() => {
    const hero = document.querySelector(".mcp-hero");
    return hero?.classList.contains("ok") && /Connected/.test(hero.textContent ?? "");
  }),
);

// --- the project gets orientation notes, but only now -------------------------
//
// An assistant on the other end of the bridge sees a tool list and knows nothing
// about where it is. AGENTS.md answers that — and is written on CONNECT rather
// than on project open, so a user who has never attached an assistant never
// finds a file about them in their game folder.

const guidePath = path.join(root, "AGENTS.md");
check("AGENTS.md is written when an assistant connects", fs.existsSync(guidePath));
check("CLAUDE.md points at it, for the clients that read that instead", fs.existsSync(path.join(root, "CLAUDE.md")));
const guide = fs.existsSync(guidePath) ? fs.readFileSync(guidePath, "utf8") : "";
check("…and it says where the agent is", /live editor/i.test(guide) && /game project/i.test(guide));
check("…what to call first", /editor_status/.test(guide));
check("…and what not to hand-edit", /\.scene/.test(guide) && /Library\//.test(guide));

// The user is meant to edit this file — project conventions, tone, "don't touch
// the boss arena". A scaffold that rewrote it on every connect would delete that
// silently, which is the worst way to lose work.
fs.writeFileSync(guidePath, "# Mine\n\nDo not touch the boss arena.\n");
await page.evaluate(async () => {
  const { ensureAgentGuide } = await globalThis.__importLive("/src/editor/agentGuide.js");
  await ensureAgentGuide();
});
check(
  "reconnecting never overwrites a guide the user has edited",
  fs.readFileSync(guidePath, "utf8").includes("boss arena"),
);

// --- clients render as rows with brand marks ---------------------------------

const clientRows = await page.evaluate(() =>
  [...document.querySelectorAll(".mcp-client")].map((row) => ({
    name: row.querySelector(".mcp-client-name")?.textContent?.trim(),
    hasMark: !!row.querySelector(".mcp-client-mark svg"),
    action: row.querySelector(".mcp-client-action")?.textContent?.trim() ?? null,
  })),
);
check("both CLIs are listed as rows", clientRows.length === 2, JSON.stringify(clientRows));
check("…each with a brand mark", clientRows.every((r) => r.hasMark));
check("…and named", clientRows.some((r) => r.name === "Claude Code") && clientRows.some((r) => r.name === "Codex"));

// --- the menu-bar chip --------------------------------------------------------

const chip = await page.evaluate(() => {
  const el = document.querySelector(".mcp-chip");
  return el ? { text: el.textContent.trim(), connected: el.classList.contains("connected") } : null;
});
check("the menu bar shows a connected MCP chip", chip?.connected === true, JSON.stringify(chip));

// --- THE reported bug: the setting must survive a restart --------------------
//
// It used to live in project.json and default to off, so every restart (and
// every new project) came up disabled — "it is disabled every time I restart
// the editor, which is annoying". It is now an editor preference, so a reload
// must come back enabled and reconnect on its own, with nothing clicked.

const storedAfterToggle = await page.evaluate(() => localStorage.getItem("engine.mcp.v1"));
check(
  "the choice is persisted immediately, with nothing pressed",
  JSON.parse(storedAfterToggle ?? "{}").enabled === true,
  storedAfterToggle,
);

await page.reload({ waitUntil: "load", timeout: 45000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await wait(7000);
await page.evaluate(() => {
  const importLive = (p) => {
    const prefix = location.origin + p;
    const fetched = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    return import(/* @vite-ignore */ (fetched.find((n) => n.includes("?")) ?? fetched[0]) ?? p);
  };
  globalThis.__importLive = importLive;
  return importLive("/src/editor/engineInstance.js").then((m) => m.ensureEngine());
});

let reconnected = false;
for (let i = 0; i < 40 && !reconnected; i++) {
  await wait(250);
  reconnected = await page.evaluate(async () => {
    const { useMcpStore } = await globalThis.__importLive("/src/editor/api/mcpBridge.js");
    return useMcpStore.getState().status === "connected";
  });
}
check("after a full reload MCP is STILL enabled and reconnects by itself", reconnected);

// --- a duplicated module graph must not split the editor in half -------------
//
// The bug this guards: after a long dev session, HMR had left the editor with
// two `commandBus`es and two `useSceneStore`s. Ops driven over MCP pushed into
// the newer bus, which refreshed the newer store — which no mounted component
// was subscribed to. The engine really was mutated, so edits autosaved and
// reappeared after a restart, while the running editor showed nothing. Silent,
// and indistinguishable from "MCP doesn't work".
//
// Forcing a second evaluation with a `?dup=` query is exactly what Vite does to
// itself with `?t=<mtime>`, so this reproduces the real mechanism rather than a
// model of it.
const dup = await page.evaluate(async () => {
  const load = (p) => import(/* @vite-ignore */ `${location.origin}${p}?dup=1`);
  const [busA, storeA, selA] = await Promise.all([
    globalThis.__importLive("/src/editor/commands/CommandBus.js"),
    globalThis.__importLive("/src/editor/store/sceneStore.js"),
    globalThis.__importLive("/src/editor/store/selectionStore.js"),
  ]);
  const [busB, storeB, selB] = await Promise.all([
    load("/src/editor/commands/CommandBus.js"),
    load("/src/editor/store/sceneStore.js"),
    load("/src/editor/store/selectionStore.js"),
  ]);
  return {
    sameBus: busA.commandBus === busB.commandBus,
    sameScene: storeA.useSceneStore === storeB.useSceneStore,
    sameSelection: selA.useSelectionStore === selB.useSelectionStore,
    sameHistory: busA.useHistoryStore === busB.useHistoryStore,
  };
});
check("a re-evaluated CommandBus module reuses the one bus", dup.sameBus);
check("…the one scene store", dup.sameScene);
check("…the one selection store", dup.sameSelection);
check("…and the one history store", dup.sameHistory);

// Functional proof: drive a command through the DUPLICATE module and watch the
// hierarchy panel the original module's store feeds.
const domBefore = await page.evaluate(
  () => document.querySelectorAll(".hierarchy-panel [data-entity-id], .hierarchy-panel .tree-row").length,
);
await page.evaluate(async () => {
  const load = (p) => import(/* @vite-ignore */ `${location.origin}${p}?dup=1`);
  const { commandBus } = await load("/src/editor/commands/CommandBus.js");
  const { CreateEntityCommand } = await load("/src/editor/commands/entityCommands.js");
  commandBus.execute(new CreateEntityCommand({ name: "DupModuleProbe" }));
});
await wait(800);
const domAfter = await page.evaluate(() => ({
  rows: document.querySelectorAll(".hierarchy-panel [data-entity-id], .hierarchy-panel .tree-row").length,
  named: document.body.innerText.includes("DupModuleProbe"),
}));
check(
  "an edit made through a duplicated module still reaches the UI",
  domAfter.rows === domBefore + 1 && domAfter.named,
  `${domBefore} -> ${domAfter.rows} rows, named=${domAfter.named}`,
);

// --- and turning it off disconnects -------------------------------------------

await page.evaluate(async () => {
  const { openPanel } = await globalThis.__importLive("/src/editor/EditorShell.jsx");
  openPanel("mcp");
});
await wait(900);
await page.evaluate(() => document.querySelector(".mcp-switch input")?.click());
await wait(800);
const offState = await page.evaluate(async () => {
  const { useMcpStore } = await globalThis.__importLive("/src/editor/api/mcpBridge.js");
  const chip = document.querySelector(".mcp-chip");
  return {
    status: useMcpStore.getState().status,
    // The chip is now ALWAYS rendered — it is the entry point when off, which
    // is the fix for "the MCP server is hard to find". So the assertion is that
    // it goes quiet, not that it vanishes.
    chipPresent: !!chip,
    chipOff: chip?.classList.contains("off") ?? false,
    stored: JSON.parse(localStorage.getItem("engine.mcp.v1") ?? "{}").enabled,
  };
});
check("flipping the switch off disconnects immediately", offState.status === "disabled", offState.status);
check("…the chip stays as the way back in", offState.chipPresent === true);
check("…but dims", offState.chipOff === true);
check("…and the off state persists too", offState.stored === false);

// ---------------------------------------------------------------------------
wss.close();
const hard = errors.filter((e) => !/WebGPU|GPUAdapter|deprecat|Failed to load resource|WebSocket/i.test(e));
if (hard.length) {
  console.log("\nconsole errors:");
  for (const e of hard.slice(0, 10)) console.log(`  ${e}`);
}
const failed = results.filter((r) => !r.ok);
console.log(
  `\nMCP-UI-SMOKE ${failed.length === 0 && hard.length === 0 ? "PASS" : "FAIL"} — ${results.length - failed.length}/${results.length} checks`,
);
await browser.close();
process.exit(failed.length === 0 && hard.length === 0 ? 0 : 1);
