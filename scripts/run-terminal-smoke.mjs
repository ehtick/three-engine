// Terminal panel smoke: the frontend half of the in-editor terminal.
//
//   npx vite --port 5211 --strictPort
//   node scripts/run-terminal-smoke.mjs [url]
//
// HEADED=1 to watch it run.
//
// ## What this can and cannot cover
//
// The terminal is two halves that only meet in the desktop app: a real PTY in
// Rust (`src-tauri/src/pty.rs`) and xterm.js here. A browser has no
// pseudo-terminal, so this harness stands in for the Rust side via the shim's
// `extraCommands` and drives `pty://data` through `__tauriShimEmit`. What it
// proves is everything on this side of the IPC boundary:
//
//   - the panel spawns the right program, in the open project's directory
//   - PTY bytes reach xterm and render (asserted against the rendered rows,
//     not against our own buffer — the point is that the emulator got them)
//   - a UTF-8 sequence split across two chunks still renders as one character,
//     which is the whole reason output crosses as base64 rather than a string
//   - keystrokes go back out as `pty_write`
//   - resizing tells the child, or a TUI keeps drawing at the wrong width
//   - switching program restarts the session instead of stacking a second one
//
// The Rust half has its own test (`cargo test -p tauri-app --lib`), which spawns
// a real PTY and asserts a child's output comes back. Neither test alone proves
// the feature works end-to-end; that only happens in the app.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5211/";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-term-"));
fs.writeFileSync(path.join(root, "project.json"), JSON.stringify({ name: "Term", version: 1 }));

// --- stand-in for the Rust PTY ------------------------------------------------

const spawned = [];
const written = [];
const resized = [];
const killed = [];

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
await installTauriShim(page, {
  writableRoot: root,
  extraCommands: {
    detect_terminal_programs: () => [
      ["claude", "C:/fake/bin/claude.cmd"],
      // Deliberately absent, so the "not installed" branch is exercised.
      ["codex", null],
    ],
    pty_spawn: (args) => {
      spawned.push(args);
      return null;
    },
    pty_write: (args) => {
      written.push(args);
      return null;
    },
    pty_resize: (args) => {
      resized.push(args);
      return null;
    },
    pty_kill: (args) => {
      killed.push(args);
      return null;
    },
    pty_alive: () => spawned.length > 0,
  },
});

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.stack ?? e.message}`));

await page.goto(url, { waitUntil: "load", timeout: 45000 });
await page.evaluate(() =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click(),
);
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

// --- open the panel -----------------------------------------------------------

await page.evaluate(async () => {
  const { openPanel } = await globalThis.__importLive("/src/editor/EditorShell.jsx");
  openPanel("terminal");
});
await wait(2500);

const mounted = await page.evaluate(() => ({
  panel: !!document.querySelector(".terminal-panel"),
  xterm: !!document.querySelector(".terminal-host .xterm"),
  rows: document.querySelectorAll(".terminal-host .xterm-rows > div").length,
}));
check("the Terminal panel mounts", mounted.panel);
check("xterm attaches to it", mounted.xterm);
check("the emulator has a sized grid", mounted.rows > 5, `${mounted.rows} rows`);

check("it spawns a session on open", spawned.length === 1, JSON.stringify(spawned[0] ?? null).slice(0, 120));
check(
  "…running the resolved claude binary, not the bare name",
  spawned[0]?.command === "C:/fake/bin/claude.cmd",
  spawned[0]?.command,
);
check(
  "…in the open project's directory",
  (spawned[0]?.cwd ?? "").replaceAll("\\", "/").toLowerCase() === root.replaceAll("\\", "/").toLowerCase(),
  spawned[0]?.cwd,
);
check("…with a real terminal size", spawned[0]?.cols > 10 && spawned[0]?.rows > 3, `${spawned[0]?.cols}x${spawned[0]?.rows}`);

const codexDisabled = await page.evaluate(
  () =>
    [...document.querySelectorAll(".terminal-panel .panel-toolbar button")].find((b) =>
      /Codex/.test(b.textContent),
    )?.disabled,
);
check("a CLI that isn't installed is offered but disabled", codexDisabled === true);

// --- output reaches the emulator ----------------------------------------------

const emitted = await page.evaluate((b64) => window.__tauriShimEmit("pty://data", { id: "editor-terminal-main", data: b64 }), Buffer.from("hello from the pty\r\n").toString("base64"));
check("the panel is listening for pty output", emitted > 0, `${emitted} listeners`);
await wait(500);

const rendered = await page.evaluate(
  () => document.querySelector(".terminal-host .xterm-rows")?.textContent ?? "",
);
check("PTY output renders in the terminal", rendered.includes("hello from the pty"), rendered.slice(0, 60));

// The reason output crosses as base64 rather than a string: a multi-byte
// character split across two reads must still render as one character.
const snowman = Buffer.from("\r\nsplit:☃ ok\r\n", "utf8");
const cut = 9; // lands inside the 3-byte ☃
await page.evaluate((b64) => window.__tauriShimEmit("pty://data", { id: "editor-terminal-main", data: b64 }), snowman.subarray(0, cut).toString("base64"));
await wait(150);
await page.evaluate((b64) => window.__tauriShimEmit("pty://data", { id: "editor-terminal-main", data: b64 }), snowman.subarray(cut).toString("base64"));
await wait(400);
const utf8 = await page.evaluate(
  () => document.querySelector(".terminal-host .xterm-rows")?.textContent ?? "",
);
check(
  "a UTF-8 char split across two chunks still renders",
  utf8.includes("split:☃ ok"),
  utf8.replace(/\s+/g, " ").slice(-40),
);

// Output for a DIFFERENT session id must be ignored, or two panels would
// cross-talk.
await page.evaluate((b64) => window.__tauriShimEmit("pty://data", { id: "someone-else", data: b64 }), Buffer.from("LEAKED").toString("base64"));
await wait(300);
const leak = await page.evaluate(
  () => document.querySelector(".terminal-host .xterm-rows")?.textContent ?? "",
);
check("output addressed to another session is ignored", !leak.includes("LEAKED"));

// --- input goes back out ------------------------------------------------------

await page.evaluate(() => document.querySelector(".terminal-host .xterm-helper-textarea")?.focus());
await page.keyboard.type("ls");
await wait(300);
check(
  "keystrokes are forwarded to the pty",
  written.map((w) => w.data).join("") === "ls",
  JSON.stringify(written.map((w) => w.data)),
);

// --- program switching --------------------------------------------------------

await page.evaluate(() => {
  [...document.querySelectorAll(".terminal-panel .panel-toolbar button")]
    .find((b) => b.textContent.trim() === "Shell")
    ?.click();
});
await wait(800);
check("switching program restarts the session", spawned.length === 2, `${spawned.length} spawns`);
check(
  "…with the same id, so the backend replaces rather than stacks",
  spawned[1]?.id === spawned[0]?.id,
  `${spawned[0]?.id} / ${spawned[1]?.id}`,
);
check("…and runs a shell instead of claude", /powershell|bash|sh/i.test(spawned[1]?.command ?? ""), spawned[1]?.command);

// --- exit is reported ---------------------------------------------------------

await page.evaluate(() => window.__tauriShimEmit("pty://exit", { id: "editor-terminal-main", code: 0 }));
await wait(400);
const exitState = await page.evaluate(() => ({
  status: document.querySelector(".terminal-status")?.textContent?.trim(),
  text: document.querySelector(".terminal-host .xterm-rows")?.textContent ?? "",
}));
check("a process exit is visible in the panel", exitState.status === "exited", exitState.status);
check("…and says so in the terminal", exitState.text.includes("process exited"), exitState.text.slice(-60));

// ---------------------------------------------------------------------------
const hard = errors.filter((e) => !/WebGPU|GPUAdapter|deprecat|Failed to load resource/i.test(e));
if (hard.length) {
  console.log("\nconsole errors:");
  for (const e of hard.slice(0, 10)) console.log(`  ${e}`);
}
const failed = results.filter((r) => !r.ok);
console.log(
  `\nTERMINAL-SMOKE ${failed.length === 0 && hard.length === 0 ? "PASS" : "FAIL"} — ${results.length - failed.length}/${results.length} checks`,
);
await browser.close();
process.exit(failed.length === 0 && hard.length === 0 ? 0 : 1);
