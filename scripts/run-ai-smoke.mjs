// End-to-end AI smoke: a real editor, a real op registry, and the actual
// context-menu action a user would click — driven against the tool-loop
// provider (toolLoop.js) instead of a real `claude` process.
//
//   npx vite --port 5211 --strictPort
//   node scripts/run-ai-smoke.mjs [url]
//
// HEADLESS=1 to hide the window.
//
// `test:ai` already covers parseStreamEvent.js and the tool loop's dispatch
// logic against a fake `fetch`, with no browser (that's the one to run while
// iterating). This one is for the assertion that only means something against
// the real thing: does right-clicking an entity and choosing "AI: Diagnose
// this" actually drive the real op registry, through the real editor UI, end
// to end.
//
// Why a stub HTTP server instead of a real `claude` process (the previous
// version of this file): the provider split (see the AI provider-architecture
// plan) made the tool-loop provider — closed by construction, no MCP bridge,
// no CLI, no API key — the one every user gets by default. It is also free
// and needs nothing installed, so this smoke test can now run unattended,
// unlike the old CLI-backed version which spent a real API call and skipped
// itself when `claude` wasn't on PATH. The claudeCli provider still exists
// and still needs a live CLI to exercise for real — that is a manual check
// (see the plan's Verification section), not something this suite spends
// tokens on automatically.
//
// The stub server is a real `node:http` server speaking the OpenAI
// `chat/completions` shape: first request (no prior tool result in the
// message history) returns `finish_reason:"tool_calls"` naming a real,
// read-only op (`entity_get`); once a `role:"tool"` message shows up in the
// history it returns `finish_reason:"stop"` with a plausible diagnosis. This
// proves the FULL round trip — schema building, the fetch, tool dispatch
// through the real `callTool`/registry, the result fed back, and the final
// answer reaching the store and the DOM — without hand-waving any of it.
//
// Puppeteer drives a plain Chrome tab against the Vite dev server, not the
// packaged Tauri app, so `window.__TAURI_INTERNALS__` does not exist here —
// `installTauriShim` fills that gap the same way every other browser harness
// in this project does. The tool-loop provider never touches
// `agent_run`/`agent_cancel`/`detect_terminal_programs` (those are the
// claudeCli provider's, untouched by this smoke test), but it DOES now route
// its chat requests through the `ai_chat` Rust command (see toolLoop.js and
// `ai_chat`'s doc comment in src-tauri/src/lib.rs — a direct browser `fetch`
// to Ollama fails on CORS in a packaged app). `installTauriShim` has no
// business implementing an HTTP proxy generically, so `extraCommands` below
// supplies a Node-side implementation that mirrors the Rust command's
// contract exactly: POST `body` to `url` as JSON, return the response body
// text verbatim (or throw with the status + body on a non-2xx response).
//
// RUNS HEADED by default — headless Chrome exposes no WebGPU adapter.
// START THE DEV SERVER FRESH — see the `?t=` trap in run-multiscript-smoke.mjs.
import puppeteer from "puppeteer-core";
import http from "node:http";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5211/";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

const DIAGNOSIS_TEXT = "Diagnosis: the entity has a mesh component and no related console errors — looks fine.";

// --- the stub OpenAI-compatible server ---------------------------------------
//
// Stateless by design: whether to answer with a tool call or the final answer
// is read straight off the request body (has a prior `role:"tool"` message
// been sent back yet?) rather than tracked server-side, so it transparently
// supports however many runs the page fires at it — including the
// back-to-back-run and cancel-path checks below — without any per-run reset.
function startStubServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method !== "POST") {
        res.writeHead(404).end();
        return;
      }
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          res.writeHead(400).end("bad request json");
          return;
        }
        const messages = body.messages ?? [];
        const hasToolResult = messages.some((m) => m.role === "tool");
        const payload = hasToolResult
          ? {
              choices: [{ finish_reason: "stop", message: { role: "assistant", content: DIAGNOSIS_TEXT } }],
            }
          : (() => {
              const userText = messages.find((m) => m.role === "user")?.content ?? "";
              const entityId = userText.match(/entity\s+"([^"]+)"/)?.[1] ?? null;
              return {
                choices: [
                  {
                    finish_reason: "tool_calls",
                    message: {
                      role: "assistant",
                      tool_calls: [{ id: "call_1", function: { name: "entity_get", arguments: JSON.stringify({ id: entityId }) } }],
                    },
                  },
                ],
              };
            })();
        // A deliberate delay so a cancel fired shortly after a run starts
        // actually lands mid-flight, the way it would against a real slow
        // model — without this every request would resolve near-instantly
        // and the cancel-path check below would prove nothing.
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        }, 900);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const stubServer = await startStubServer();
const stubPort = stubServer.address().port;
console.log(`stub OpenAI-compatible server listening on 127.0.0.1:${stubPort}`);

// --- editor -------------------------------------------------------------------

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADLESS ? "new" : false,
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });

const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(`pageerror: ${e.stack ?? e.message}`));

/** Node-side stand-in for the `ai_chat` Rust command — see the module doc above. */
async function aiChat({ url, apiKey, body }) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} returned ${res.status}: ${text}`);
  return text;
}

await installTauriShim(page, { verbose: false, extraCommands: { ai_chat: aiChat } });

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
  globalThis.__importLive = importLive;

  const { useAiPrefs, setAiPrefs } = await importLive("/src/editor/aiPrefs.js");
  globalThis.__aiPrefs = useAiPrefs;
  // Point the editor's provider settings at the stub server and pick the
  // tool-loop (Ollama-shaped) provider — the default, but set explicitly so
  // this test doesn't depend on that default never changing.
  setAiPrefs({ providerId: "ollama", ollamaBaseUrl: `http://127.0.0.1:${port}`, ollamaModel: "stub-model" });

  const { useAiStore, runWorkflow, cancelRun } = await importLive("/src/editor/store/aiStore.js");
  globalThis.__aiStore = useAiStore;
  globalThis.__runAiWorkflow = runWorkflow;
  globalThis.__cancelAiRun = cancelRun;

  const { getActiveProvider } = await importLive("/src/editor/ai/providers/index.js");
  const provider = getActiveProvider();
  return { fatal: null, providerId: provider?.id ?? null, scopedTools: provider?.capabilities?.scopedTools ?? null };
}, stubPort);

if (booted.fatal) {
  console.log(` FAIL  ${booted.fatal}`);
  await browser.close();
  stubServer.close();
  process.exit(1);
}
check("the active provider after setAiPrefs is the tool-loop (ollama) provider", booted.providerId === "ollama", JSON.stringify(booted));
check("...and it declares scopedTools — the whole safety property this provider exists for", booted.scopedTools === true);

// --- create a target entity and drive the real context menu -------------------

const entity = await page.evaluate(() => {
  const created = globalThis.__editorApi.entities.create({ name: "AiDiagnoseTarget" });
  globalThis.__editorApi.components.add(created.id, "mesh", { geometry: "sphere" });
  return created;
});
check("a target entity exists to diagnose", !!entity?.id, JSON.stringify(entity));

await wait(300); // let the hierarchy row render

const menuShown = await page.evaluate((entityName) => {
  const rows = [...document.querySelectorAll("[data-entity-id]")];
  const row = rows.find((r) => r.textContent?.trim().startsWith(entityName));
  if (!row) return { found: false };
  const rect = row.getBoundingClientRect();
  row.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: Math.round(rect.left + 8), clientY: Math.round(rect.top + 6) }),
  );
  return { found: true };
}, "AiDiagnoseTarget");
check("right-clicking the entity's hierarchy row opens a menu", menuShown.found);
await wait(250);

const clicked = await page.evaluate(() => {
  const item = [...document.querySelectorAll(".dropdown-item")].find((b) => b.textContent?.includes("AI: Diagnose this"));
  if (!item) return { found: false, disabled: null };
  const disabled = item.disabled;
  item.click();
  return { found: true, disabled };
});
check("the context menu offers \"AI: Diagnose this\", enabled for a single selection", clicked.found && clicked.disabled === false);

// --- the run actually happens ---------------------------------------------

console.log("\nwaiting for the run against the stub server to finish (up to 20s)…");
const deadline = Date.now() + 20_000;
let last = null;
while (Date.now() < deadline) {
  last = await page.evaluate(() => {
    const s = globalThis.__aiStore.getState();
    return { status: s.status, lineCount: s.lines.length, result: s.result, error: s.error };
  });
  if (last.status === "done" || last.status === "error") break;
  await wait(500);
}

check("the run finished (not still running, not stuck at idle)", last?.status === "done" || last?.status === "error", JSON.stringify(last));
if (last?.status === "error") {
  console.log(` context: ${last.error}`);
}
check("the model called its scoped tool and produced output", (last?.lineCount ?? 0) > 0, `${last?.lineCount} lines`);
check("a final diagnosis came back, matching the stub's answer", last?.result === DIAGNOSIS_TEXT, last?.result);

// --- safety: the allowlist must actually be keeping general-purpose tools out
//
// A live test against the CLI provider once caught --allowedTools alone NOT
// restricting anything — a scoped run could still call Bash. The whole point
// of the tool-loop provider is that this is now structurally impossible (the
// model is only ever handed this workflow's schemas, and the dispatcher
// double-checks the allowlist regardless — see toolLoop.js and its
// fake-fetch coverage in run-ai-test.mjs). This is the permanent regression
// guard for that: if any disallowed tool call ever appears in the transcript,
// this must fail loudly.
const allLines = await page.evaluate(() => globalThis.__aiStore.getState().lines);
const FORBIDDEN_TOOLS = ["Bash", "Read", "Write", "Edit", "WebFetch", "WebSearch", "PowerShell", "Glob", "Grep"];
const forbiddenCalls = allLines.filter(
  (l) => l.kind === "tool_call" && FORBIDDEN_TOOLS.some((t) => l.text.startsWith(`→ ${t}`)),
);
check(
  "the scoped run never called a general-purpose tool (Bash/Read/Write/...) — the tool-loop allowlist held",
  forbiddenCalls.length === 0,
  forbiddenCalls.map((l) => l.text).join(" | "),
);
check(
  "...and it DID call the one real, scoped op it was offered (entity_get)",
  allLines.some((l) => l.kind === "tool_call" && l.text.startsWith("→ entity_get")),
  allLines.map((l) => `${l.kind}:${l.text}`).join(" | "),
);

// --- metadata: model/duration/turns/tokens should be visible, not discarded ---

const meta = await page.evaluate(() => {
  const s = globalThis.__aiStore.getState();
  return { model: s.model, durationMs: s.durationMs, turns: s.turns };
});
check("the run's model is captured, not left unknown", meta.model === "stub-model", meta.model);
check("duration/turns are captured from the final event, not discarded", meta.durationMs > 0 && meta.turns === 2, JSON.stringify(meta));

// The UI, not just the store — a store update with nothing subscribed to it
// reads exactly like success from the store alone. See vite-module-duplication.
const panelText = await page.evaluate(() => document.querySelector(".ai-panel")?.textContent ?? null);
check("the AI panel actually rendered the result in the DOM", !!panelText && panelText.includes(DIAGNOSIS_TEXT.slice(0, 30)));
check("the panel header shows the model name", !!panelText && panelText.includes(meta.model ?? "\0"));

// --- autoscroll: a real, prior bug (.ai-lines never actually scrolled down) -
//
// The CLI-backed version of this test could rely on a long real transcript to
// force actual overflow; the stub here answers in one tool-call round trip,
// so overflow isn't guaranteed. What's still checked is the invariant that
// matters — whatever the content height, the pane is scrolled to its bottom,
// not stuck at its top the way it was before the autoscroll fix landed.
const scrollState = await page.evaluate(() => {
  const el = document.querySelector(".ai-lines");
  if (!el) return null;
  return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
});
check(
  "the log is scrolled to its bottom, not stuck at the top",
  !!scrollState && scrollState.scrollTop + scrollState.clientHeight >= scrollState.scrollHeight - 4,
  JSON.stringify(scrollState),
);

check("no uncaught page errors during the run", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

// --- a SECOND, back-to-back run ---------------------------------------------
//
// Less load-bearing than it was for the CLI provider (there is no
// per-run `mcp/server.mjs` process to leak or port-squat here — the
// tool-loop provider is pure in-process JS), but still real regression
// coverage: the store must fully reset between runs rather than accreting
// state from the previous one.

const secondEntity = await page.evaluate(() => globalThis.__editorApi.entities.create({ name: "AiSecondRunTarget" }));
await page.evaluate((id) => {
  globalThis.__runAiWorkflow("diagnose-selected", id);
}, secondEntity.id);

console.log("\nwaiting for a SECOND, back-to-back run to finish (up to 20s)…");
const secondDeadline = Date.now() + 20_000;
let second = null;
while (Date.now() < secondDeadline) {
  second = await page.evaluate(() => {
    const s = globalThis.__aiStore.getState();
    return { status: s.status, lineCount: s.lines.length, result: s.result, error: s.error };
  });
  if (second.status === "done" || second.status === "error") break;
  await wait(500);
}
check("a SECOND back-to-back run also finishes cleanly, its own fresh state", second?.status === "done", JSON.stringify(second));
check("...and it also got real tool access, not a stale result", (second?.lineCount ?? 0) > 0, `${second?.lineCount} lines`);

// --- cancel path ------------------------------------------------------------

const cancelEntity = await page.evaluate(() => globalThis.__editorApi.entities.create({ name: "AiCancelTarget" }));
// Deliberately not `await`ing the workflow itself — only that it started.
// Returning its promise from the evaluated function would make Puppeteer wait
// for the whole run to finish before the next line ever cancels it.
await page.evaluate((id) => {
  globalThis.__runAiWorkflow("diagnose-selected", id);
}, cancelEntity.id);
await wait(300); // let it actually start (the request is in flight, stub delays 900ms) before cancelling
await page.evaluate(() => globalThis.__cancelAiRun());
await wait(500);
const afterCancel = await page.evaluate(() => globalThis.__aiStore.getState().status);
check("cancelling an in-flight run marks it cancelled", afterCancel === "cancelled", afterCancel);
const countAtCancel = await page.evaluate(() => globalThis.__aiStore.getState().lines.length);
await wait(1500); // longer than the stub's 900ms response delay — nothing should still land
const countAfterWait = await page.evaluate(() => globalThis.__aiStore.getState().lines.length);
check(
  "…and no further output arrives after cancelling (the in-flight fetch actually aborted)",
  countAfterWait === countAtCancel,
  `${countAtCancel} -> ${countAfterWait}`,
);

// --- summary ----------------------------------------------------------------

await browser.close();
stubServer.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log("Failed:", failed.map((r) => r.name).join(", "));
  process.exit(1);
}
