// AI workflow parsing test. No browser, no Tauri, no real `claude` process —
// just the pure pieces of the point-of-intent AI feature exercised directly.
//
//   node scripts/run-ai-test.mjs
//
// `providers/claudeCli.js` and `aiStore.js` both need a live Tauri webview to
// actually run a turn (agent_run/agent_cancel, event listeners), so this
// deliberately does not import them: importing `aiStore.js` pulls in
// `store/projectStore.js`, whose chain hits a Vite-only `.d.ts` import plain
// Node can't load. What CAN be tested here without any of that is exactly the
// part most likely to silently rot — the parsing — because
// `src/editor/ai/parseStreamEvent.js` is deliberately dependency-free (see its
// module doc), and `resolveAllowedTools` in `workflows.js` only needs
// `api/registry.js`, which has zero imports of its own.
//
// `smoke:ai` (not yet written) is the other half: a real editor, a real
// `claude` CLI, and the actual context-menu action end to end.
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { parseAgentLinePayload, parseStreamEvent } from "../src/editor/ai/parseStreamEvent.js";
import { WORKFLOWS, getWorkflow, resolveAllowedTools, resolveToolSchemas } from "../src/editor/ai/workflows.js";
import { createToolLoopProvider } from "../src/editor/ai/providers/toolLoop.js";
import { defineOp, resetOps } from "../src/editor/api/registry.js";
import { MCP_SERVER_NAME } from "../src/editor/mcpClients.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- 1. parseAgentLinePayload: raw agent://line payload -> event or null ----

check(
  "a valid JSON stdout line parses to its object",
  deepEqual(parseAgentLinePayload({ stream: "stdout", line: '{"type":"result","result":"ok"}' }), {
    type: "result",
    result: "ok",
  }),
);

check(
  "an invalid-JSON stdout line falls back to a raw stdout event",
  deepEqual(parseAgentLinePayload({ stream: "stdout", line: "not json {" }), {
    type: "raw",
    stream: "stdout",
    text: "not json {",
  }),
);

check(
  "a non-empty stderr line becomes a raw stderr event",
  deepEqual(parseAgentLinePayload({ stream: "stderr", line: "warning: something" }), {
    type: "raw",
    stream: "stderr",
    text: "warning: something",
  }),
);

check("a blank stdout line is skipped (null)", parseAgentLinePayload({ stream: "stdout", line: "   " }) === null);
check("a blank stderr line is skipped (null)", parseAgentLinePayload({ stream: "stderr", line: "" }) === null);

// --- 2. parseStreamEvent: parsed event -> display lines + result ------------

check(
  "a non-object event produces nothing",
  deepEqual(parseStreamEvent(null), { lines: [], result: null, meta: null }),
);

check(
  "a system/init event without a model produces nothing, not a raw JSON dump",
  deepEqual(parseStreamEvent({ type: "system", subtype: "thinking_tokens", estimated_tokens: 50 }), {
    lines: [],
    result: null,
    meta: null,
  }),
);

check(
  "…but a system/init event WITH a model surfaces just that, not the rest of the multi-KB blob",
  deepEqual(
    parseStreamEvent({ type: "system", subtype: "init", model: "claude-sonnet-5", tools: ["a", "b"], mcp_servers: [] }),
    { lines: [], result: null, meta: { model: "claude-sonnet-5" } },
  ),
);

check(
  "a rate_limit_event produces nothing either",
  deepEqual(parseStreamEvent({ type: "rate_limit_event", rate_limit_info: { utilization: 0.5 } }), {
    lines: [],
    result: null,
    meta: null,
  }),
);

check(
  "an assistant text block becomes a text line",
  deepEqual(
    parseStreamEvent({ type: "assistant", message: { content: [{ type: "text", text: "Looks fine." }] } }).lines,
    [{ kind: "text", text: "Looks fine." }],
  ),
);

check(
  "an assistant tool_use block with input becomes a tool_call line with the args inlined",
  deepEqual(
    parseStreamEvent({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "entity_getBounds", input: { id: "e1" } }] },
    }).lines,
    [{ kind: "tool_call", text: '→ entity_getBounds {"id":"e1"}' }],
  ),
);

check(
  "a tool_use block with no input omits the trailing JSON",
  deepEqual(
    parseStreamEvent({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "console_read", input: {} }] },
    }).lines,
    [{ kind: "tool_call", text: "→ console_read" }],
  ),
);

check(
  "a user tool_result with string content becomes a tool_result line",
  deepEqual(
    parseStreamEvent({
      type: "user",
      message: { content: [{ type: "tool_result", content: "3 warnings found" }] },
    }).lines,
    [{ kind: "tool_result", text: "3 warnings found" }],
  ),
);

check(
  "a user tool_result with object content is stringified",
  deepEqual(
    parseStreamEvent({
      type: "user",
      message: { content: [{ type: "tool_result", content: { ok: true } }] },
    }).lines,
    [{ kind: "tool_result", text: '{"ok":true}' }],
  ),
);

{
  const long = "x".repeat(500);
  const { lines } = parseStreamEvent({
    type: "user",
    message: { content: [{ type: "tool_result", content: long }] },
  });
  check(
    "a long tool_result is truncated with an ellipsis rather than dumped in full — kept SHORT (120 chars) " +
      "on purpose, since the call itself already says what happened and results are the 'ton of text we " +
      "don't need to see'",
    lines[0].text.length === 121 && lines[0].text.endsWith("…"),
    `got length ${lines[0].text.length}`,
  );
}

check(
  "a result event surfaces its text as the final result, not a line",
  deepEqual(parseStreamEvent({ type: "result", result: "Nothing looks wrong." }).result, "Nothing looks wrong."),
);

check(
  "…and pulls cost/duration/turns/tokens into meta, so the panel can show what a run actually spent",
  deepEqual(
    parseStreamEvent({
      type: "result",
      result: "ok",
      duration_ms: 8300,
      total_cost_usd: 0.1345,
      num_turns: 3,
      usage: { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 12000 },
    }).meta,
    { durationMs: 8300, costUsd: 0.1345, turns: 3, tokens: 12210 },
  ),
);

check(
  "a result event missing the usual fields (unexpected CLI shape) reports nulls, not a crash",
  deepEqual(parseStreamEvent({ type: "result", result: "ok" }).meta, {
    durationMs: null,
    costUsd: null,
    turns: null,
    tokens: null,
  }),
);

check(
  "a raw event (from parseAgentLinePayload's fallback) passes its text through",
  deepEqual(parseStreamEvent({ type: "raw", stream: "stderr", text: "hm" }).lines, [{ kind: "raw", text: "hm" }]),
);

check(
  "an unrecognized event shape is surfaced as raw JSON, not silently dropped",
  deepEqual(parseStreamEvent({ type: "some_future_event", weird: true }).lines, [
    { kind: "raw", text: '{"type":"some_future_event","weird":true}' },
  ]),
);

// --- 3. workflows.js: the registry and its allowedTools resolution ----------

check("exactly one workflow is registered for this phase", WORKFLOWS.length === 1, `${WORKFLOWS.length} workflows`);
check("getWorkflow finds it by id", getWorkflow("diagnose-selected")?.label === "Diagnose this");
check("getWorkflow returns null for an unknown id", getWorkflow("nope") === null);

const diagnose = getWorkflow("diagnose-selected");

// resolveAllowedTools only needs opNames() to know about the names the
// workflow references — register fakes for exactly those (mirroring
// run-mcp-test.mjs's FAKE_TOOLS) rather than importing the real ops files,
// which pull in the live engine and can't run outside a browser/Tauri host.
resetOps();
for (const name of diagnose.allowedTools) {
  defineOp({ name, description: "fake", readOnly: true, run: () => null });
}

{
  const resolved = resolveAllowedTools(diagnose);
  check(
    "resolveAllowedTools returns one mcp__<server>__<tool> name per allowed op, dots underscored",
    deepEqual(
      resolved,
      diagnose.allowedTools.map((n) => `mcp__${MCP_SERVER_NAME}__${n.replaceAll(".", "_")}`),
    ),
    resolved.join(", "),
  );
  check(
    "none of diagnose-selected's tools slipped in a dotted name (would break --allowedTools)",
    resolved.every((n) => !n.slice(`mcp__${MCP_SERVER_NAME}__`.length).includes(".")),
  );
}

{
  let threw = null;
  try {
    resolveAllowedTools({ id: "fake", allowedTools: ["entity.get", "not.a.real.op"] });
  } catch (err) {
    threw = err;
  }
  check(
    "an unknown op name in allowedTools throws instead of silently narrowing to nothing",
    threw !== null && /not\.a\.real\.op/.test(threw.message),
    threw?.message,
  );
}
resetOps();

// --- 4. static consistency: every allowedTools name is a REAL registered op -
//
// The checks above use fake ops on purpose (importing the real ones needs a
// live engine). This closes the resulting gap statically: grep the actual ops
// source for `name: "<op>"` and confirm each name every workflow references
// really is registered somewhere, so a typo or a renamed op fails this test
// instead of failing silently as "the model says it has no such tool".
{
  const opsDir = path.join(here, "..", "src", "editor", "api", "ops");
  const registered = new Set();
  for (const file of fs.readdirSync(opsDir)) {
    if (!file.endsWith(".js")) continue;
    const text = fs.readFileSync(path.join(opsDir, file), "utf8");
    for (const m of text.matchAll(/name:\s*"([a-zA-Z0-9_.]+)"/g)) registered.add(m[1]);
  }
  for (const workflow of WORKFLOWS) {
    const missing = workflow.allowedTools.filter((name) => !registered.has(name));
    check(
      `workflow "${workflow.id}"'s allowedTools all exist as real registered ops`,
      missing.length === 0,
      missing.join(", "),
    );
  }
}

// --- 5. resolveToolSchemas: the OpenAI-shaped tool list toolLoop.js sends ---

resetOps();
defineOp({
  name: "entity.get",
  description: "Get an entity by id.",
  readOnly: true,
  params: { id: { type: "string", required: true, description: "Entity id" } },
  run: () => null,
});
defineOp({ name: "entity.list", description: "List entities.", readOnly: true, run: () => null });

{
  const schemas = resolveToolSchemas({ id: "fake-schema", allowedTools: ["entity.get", "entity.list"] });
  check("resolveToolSchemas returns one entry per allowed op", schemas.length === 2, `${schemas.length}`);
  check(
    "each entry is OpenAI function-tool shaped ({type:'function', function:{name, description, parameters}})",
    schemas.every(
      (s) =>
        s.type === "function" &&
        typeof s.function?.name === "string" &&
        typeof s.function?.description === "string" &&
        typeof s.function?.parameters === "object",
    ),
    JSON.stringify(schemas[0]),
  );
  check(
    "dots in the op name become underscores in function.name (an OpenAI tool name may not contain a dot)",
    schemas.find((s) => s.function.name === "entity_get") !== undefined && schemas.every((s) => !s.function.name.includes(".")),
    schemas.map((s) => s.function.name).join(", "),
  );
  check(
    "parameters is a real JSON Schema object (type:object, with properties)",
    schemas.find((s) => s.function.name === "entity_get").function.parameters.type === "object" &&
      schemas.find((s) => s.function.name === "entity_get").function.parameters.properties?.id?.type === "string",
  );
}

{
  let threw = null;
  try {
    resolveToolSchemas({ id: "fake", allowedTools: ["entity.get", "not.a.real.op"] });
  } catch (err) {
    threw = err;
  }
  check(
    "resolveToolSchemas: an unknown op name throws instead of silently narrowing the tool list",
    threw !== null && /not\.a\.real\.op/.test(threw.message),
    threw?.message,
  );
}
resetOps();

// --- 6. toolLoop.js: the closed agent loop, driven against a fake transport
//
// createToolLoopProvider() no longer calls `fetch` — it calls an injected
// `transport({url, apiKey, body}) => Promise<string>`, which in production
// routes through the `ai_chat` Rust command (see toolLoop.js's module doc
// and its `defaultTransport`). Injecting a fake transport here is simpler
// and more honest than stubbing a global: it exercises the exact seam the
// real code calls through, with no real network, no real model, no Tauri.

function makeLoopProvider(impl) {
  return createToolLoopProvider({
    id: "test-loop",
    label: "Test Loop",
    baseUrl: "http://fake-host",
    model: "test-model",
    apiKey: "",
    transport: impl,
  });
}

// 6a. finish_reason:"stop" ends the loop in one round trip.
{
  resetOps();
  defineOp({ name: "entity.get", description: "Get an entity.", readOnly: true, run: () => ({ ok: true }) });
  const workflow = { id: "loop-stop", allowedTools: ["entity.get"] };

  const transportCalls = [];
  const events = [];
  let threw = null;
  const provider = makeLoopProvider(async ({ url, body }) => {
    transportCalls.push({ url, body: JSON.parse(body) });
    return JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "All good." } }] });
  });
  try {
    await provider.runTurn({ workflow, prompt: "diagnose" }, (e) => events.push(e));
  } catch (err) {
    threw = err;
  }

  check("a finish_reason:'stop' response ends the loop in one round trip", threw === null && transportCalls.length === 1, `${transportCalls.length} calls, threw=${threw?.message}`);
  const final = events[events.length - 1];
  check("...and surfaces message.content as the result passed to onEvent", final?.result === "All good.", JSON.stringify(final));
  check("meta carries the model up front, in the first event", events[0]?.meta?.model === "test-model", JSON.stringify(events[0]));
  check(
    "meta carries turns/durationMs at the end",
    final?.meta?.turns === 1 && typeof final.meta.durationMs === "number",
    JSON.stringify(final?.meta),
  );
  resetOps();
}

// 6b. finish_reason:"tool_calls" actually executes the op, and the follow-up
// request body feeds the result back as a role:"tool" message.
{
  resetOps();
  let getCalls = 0;
  defineOp({
    name: "entity.get",
    description: "Get an entity.",
    readOnly: true,
    params: { id: { type: "string", required: true } },
    run: ({ id }) => {
      getCalls += 1;
      return { id, name: "Thing" };
    },
  });
  const workflow = { id: "loop-tools", allowedTools: ["entity.get"] };

  const transportCalls = [];
  let call = 0;
  const provider = makeLoopProvider(async ({ body }) => {
    call += 1;
    transportCalls.push({ body: JSON.parse(body) });
    if (call === 1) {
      return JSON.stringify({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              tool_calls: [{ id: "call_1", function: { name: "entity_get", arguments: JSON.stringify({ id: "e1" }) } }],
            },
          },
        ],
      });
    }
    return JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Diagnosis: fine." } }] });
  });
  await provider.runTurn({ workflow, prompt: "diagnose" }, () => {});

  check("a tool_calls response actually executes the named op", getCalls === 1, `getCalls=${getCalls}`);
  const toolMsg = transportCalls[1]?.body.messages.find((m) => m.role === "tool" && m.tool_call_id === "call_1");
  check(
    "the SECOND request body carries a {role:'tool', tool_call_id, content} message with that op's result",
    !!toolMsg && JSON.parse(toolMsg.content).ok === true && JSON.parse(toolMsg.content).result.name === "Thing",
    JSON.stringify(toolMsg),
  );
  resetOps();
}

// 6b-image. A tool result carrying an image (what `viewport.screenshot`
// returns) must NEVER put its base64 into the conversation. A `role:"tool"`
// message is plain text, so those bytes are not a picture the model can see —
// they are ~1 MB of gibberish that buries the real results, blows a local
// model's context, and invites it to invent a description. This shipped
// broken once: a small local model confidently described a Genshin Impact
// screenshot, HP bars and all, for a scene containing a single light.
{
  resetOps();
  const base64 = "iVBORw0KGgoAAAANSUhEUg" + "A".repeat(4000);
  defineOp({
    name: "viewport.screenshot",
    description: "Screenshot the viewport.",
    readOnly: true,
    run: () => ({ __image: { mimeType: "image/png", base64 } }),
  });
  const workflow = { id: "loop-image", allowedTools: ["viewport.screenshot"] };

  const bodies = [];
  let call = 0;
  const provider = makeLoopProvider(async ({ body }) => {
    call += 1;
    bodies.push(JSON.parse(body));
    if (call === 1) {
      return JSON.stringify({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              tool_calls: [{ id: "call_1", function: { name: "viewport_screenshot", arguments: "{}" } }],
            },
          },
        ],
      });
    }
    return JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Done." } }] });
  });
  await provider.runTurn({ workflow, prompt: "diagnose" }, () => {});

  const toolMsg = bodies[1]?.messages.find((m) => m.role === "tool");
  const sent = JSON.stringify(bodies[1] ?? {});
  check(
    "an image tool result NEVER sends its base64 bytes into the conversation",
    !sent.includes(base64.slice(0, 64)),
    `request body length ${sent.length}`,
  );
  check(
    "...and the model is told explicitly it has NOT seen the image, so it has no excuse to describe it",
    /NOT shown to you|have not seen it/i.test(toolMsg?.content ?? ""),
    toolMsg?.content,
  );
  resetOps();
}

// 6c. the allowlist guard — the load-bearing safety check of the whole
// feature. A tool_calls response naming something outside the workflow's
// allowedTools must not execute, and must feed back an error.
{
  resetOps();
  let listCalls = 0;
  defineOp({ name: "entity.get", description: "Get an entity.", readOnly: true, run: () => ({ ok: true }) });
  defineOp({
    name: "entity.list",
    description: "List entities.",
    readOnly: true,
    run: () => {
      listCalls += 1;
      return [];
    },
  });
  // entity.list is a REAL, registered op — but NOT on this workflow's allowlist.
  const workflow = { id: "loop-allowlist", allowedTools: ["entity.get"] };

  const transportCalls = [];
  let call = 0;
  const provider = makeLoopProvider(async ({ body }) => {
    call += 1;
    transportCalls.push({ body: JSON.parse(body) });
    if (call === 1) {
      return JSON.stringify({
        choices: [
          {
            finish_reason: "tool_calls",
            message: { role: "assistant", tool_calls: [{ id: "call_x", function: { name: "entity_list", arguments: "{}" } }] },
          },
        ],
      });
    }
    return JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }] });
  });
  await provider.runTurn({ workflow, prompt: "x" }, () => {});

  check(
    "a tool_calls response naming a tool NOT in the workflow's allowedTools is NEVER executed",
    listCalls === 0,
    `listCalls=${listCalls}`,
  );
  const guardMsg = transportCalls[1]?.body.messages.find((m) => m.role === "tool" && m.tool_call_id === "call_x");
  check(
    "...and an error is fed back as that call's tool result instead of silently dropping it",
    !!guardMsg && JSON.parse(guardMsg.content).ok === false,
    guardMsg?.content,
  );
  resetOps();
}

// 6d. malformed function.arguments JSON is fed back as a tool error, not thrown.
{
  resetOps();
  defineOp({ name: "entity.get", description: "Get an entity.", readOnly: true, run: () => ({ ok: true }) });
  const workflow = { id: "loop-malformed", allowedTools: ["entity.get"] };

  let capturedToolMsg = null;
  let call = 0;
  let threw = null;
  const provider = makeLoopProvider(async ({ body: rawBody }) => {
    call += 1;
    const body = JSON.parse(rawBody);
    if (call === 1) {
      return JSON.stringify({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              tool_calls: [{ id: "call_bad", function: { name: "entity_get", arguments: "{not valid json" } }],
            },
          },
        ],
      });
    }
    capturedToolMsg = body.messages.find((m) => m.role === "tool" && m.tool_call_id === "call_bad");
    return JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "recovered" } }] });
  });
  try {
    await provider.runTurn({ workflow, prompt: "x" }, () => {});
  } catch (err) {
    threw = err;
  }

  check("malformed function.arguments JSON does not throw out of the run", threw === null, threw?.message);
  check(
    "...and is fed back as a tool error instead",
    !!capturedToolMsg && JSON.parse(capturedToolMsg.content).ok === false,
    capturedToolMsg?.content,
  );
  resetOps();
}

// 6e. the iteration cap (12) terminates a server that returns tool_calls forever.
{
  resetOps();
  defineOp({ name: "entity.get", description: "Get an entity.", readOnly: true, run: () => ({ ok: true }) });
  const workflow = { id: "loop-cap", allowedTools: ["entity.get"] };

  let call = 0;
  const events = [];
  const provider = makeLoopProvider(async () => {
    call += 1;
    return JSON.stringify({
      choices: [
        {
          finish_reason: "tool_calls",
          message: { role: "assistant", tool_calls: [{ id: `call_${call}`, function: { name: "entity_get", arguments: "{}" } }] },
        },
      ],
    });
  });
  await provider.runTurn({ workflow, prompt: "x" }, (e) => events.push(e));

  check("a server that returns tool_calls forever is stopped by the iteration cap, not looped unbounded", call === 12, `${call} transport calls`);
  const final = events[events.length - 1];
  check(
    "...the cap is surfaced through onEvent (a text line + meta.turns), not a silent hang",
    final?.meta?.turns === 12 && /stopped after/.test(final?.lines?.[0]?.text ?? ""),
    JSON.stringify(final),
  );
  resetOps();
}

// 6f. a transport rejection (what a non-2xx HTTP response becomes, once the
// Rust `ai_chat` command turns it into a rejected promise carrying the
// status + response body — see its doc comment in src-tauri/src/lib.rs)
// surfaces as a readable error naming the base URL.
{
  resetOps();
  defineOp({ name: "entity.get", description: "Get an entity.", readOnly: true, run: () => ({ ok: true }) });
  const workflow = { id: "loop-http-error", allowedTools: ["entity.get"] };

  const provider = makeLoopProvider(async ({ url }) => {
    throw new Error(`${url} returned 500: internal error`);
  });

  let threw = null;
  try {
    await provider.runTurn({ workflow, prompt: "x" }, () => {});
  } catch (err) {
    threw = err;
  }

  check(
    "a transport rejection surfaces as a readable error naming the base URL",
    threw !== null && threw.message.includes("http://fake-host"),
    threw?.message,
  );
  resetOps();
}

// --- summary ------------------------------------------------------------------

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log("Failed:", failed.map((r) => r.name).join(", "));
  process.exit(1);
}
