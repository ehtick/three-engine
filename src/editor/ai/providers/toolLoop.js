/**
 * A hand-rolled agent loop against any OpenAI-compatible `chat/completions`
 * endpoint (Ollama, and any other local/self-hosted server that speaks the
 * same shape). This is the actual fix for the problem `claudeCli.js` cannot
 * solve on its own: driving the CLI's own opaque agent loop means tool
 * availability was never ours to control (`--tools ""` blocks Bash but also
 * silently breaks MCP tool_use — see the ai-workflows project memory). Here
 * we own the request, so the tool set is closed by construction — the model
 * can only be handed the tools we put in `tools:[]`, and `callTool` refuses
 * anything not on the workflow's allowlist even if it tried to invent one.
 *
 * Deliberately not streaming: Ollama does not support incremental tool-call
 * deltas, and per-tool-call progress lines (emitted as each call completes)
 * give a user watching the AI panel better feedback than token streaming
 * would anyway. `parseStreamEvent.js` is untouched by this file on purpose —
 * it stays the claudeCli provider's parser; this loop produces
 * `{lines, result, meta}` directly, matching what `aiStore.handleEvent`
 * already destructures from a claudeCli event, without going through it.
 */
import { resolveToolSchemas } from "../workflows.js";
import { callTool } from "../../api/registry.js";

const MAX_ITERATIONS = 12;
const TOOL_RESULT_TRUNCATE = 120;

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Replaces `{__image: {mimeType, base64}}` payloads — what `viewport.screenshot`
 * returns — with a short marker before a tool result is serialized back into
 * the conversation.
 *
 * A `role: "tool"` message is plain TEXT on every OpenAI-compatible endpoint,
 * so a base64 image sent this way is not an image the model can look at; it
 * is ~1 MB of gibberish characters. That is not merely useless, it is
 * actively harmful: it buries the real tool results, blows a local model's
 * context window, and invites the model to invent a description of the
 * picture it "received". A live run did exactly that — a small local model
 * confidently described a Genshin Impact screenshot, HP bars and all, for a
 * scene containing one light. The marker below is deliberately explicit that
 * the model did NOT see anything, so it has no excuse to describe it.
 *
 * Passing screenshots properly means a vision-capable model plus an
 * `image_url` content part on a follow-up `user` message (a tool message
 * cannot carry one) — worth doing, but it needs a per-model capability flag,
 * since sending an image part to a text-only model is its own error. Until
 * then, refusing to send the bytes is the correct behaviour. The claudeCli
 * provider is unaffected: it passes screenshots as real image content over
 * MCP, which is why it is the default (see aiPrefs.js).
 */
function stripBinaryPayloads(value) {
  if (Array.isArray(value)) return value.map(stripBinaryPayloads);
  if (!value || typeof value !== "object") return value;
  if (value.__image) {
    const { mimeType } = value.__image;
    return {
      __note: `An ${mimeType ?? "image"} was captured but NOT shown to you — this provider cannot pass images to the model. You have not seen it. Do not describe or speculate about its contents; rely only on the other tools.`,
    };
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripBinaryPayloads(v)]));
}

/**
 * Default transport: routes the request through the `ai_chat` Rust command
 * instead of calling `fetch` directly. A packaged Tauri webview's origin is
 * not in Ollama's (or any OpenAI-compatible server's) CORS allowlist by
 * default, so a direct browser `fetch` fails with "Failed to fetch" — see
 * `ai_chat`'s doc comment in `src-tauri/src/lib.rs` for the full rationale.
 * The import is dynamic so this module can still be loaded by plain Node
 * (`run-ai-test.mjs`) without ever touching `@tauri-apps/api`, as long as a
 * test injects its own `transport`.
 */
async function defaultTransport({ url, apiKey, body }) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("ai_chat", { url, apiKey, body });
}

function systemPrompt() {
  return (
    "You are an assistant embedded in a three.js/WebGPU game editor. You have a small set of " +
    "tools to inspect the currently open scene — use them to gather real information before " +
    "answering; do not guess at entity state you have not looked up. Once you have enough " +
    "information, answer concisely in plain text without calling any more tools."
  );
}

/**
 * `createToolLoopProvider({ id, label, baseUrl, model, apiKey, capabilities })`
 * returns a provider object matching the same `{runTurn, cancelTurn,
 * capabilities}` interface `claudeCli.js` exposes. `baseUrl`/`model`/`apiKey`
 * may be functions — called at request time rather than read once — so a
 * provider like `ollama.js` can pull live values out of `aiPrefs` and pick up
 * a settings change without a page reload.
 *
 * `transport({url, apiKey, body}) => Promise<string>` sends one
 * `chat/completions` request and resolves with the raw response body text.
 * It defaults to routing through the `ai_chat` Rust command (see
 * `defaultTransport` above); a test can inject its own to run this loop
 * against a fake server with no Tauri and no network.
 */
export function createToolLoopProvider({ id, label, baseUrl, model, apiKey, capabilities, disclosure, transport = defaultTransport }) {
  // The request now runs in Rust, so there is nothing left in this process to
  // `AbortController.abort()` mid-flight. Cancellation instead flips this
  // flag, checked right after each round trip returns and before starting
  // the next one — cancel takes effect BETWEEN round trips, not inside one.
  // That's an acceptable trade: a single completion is seconds, and
  // correctness in a packaged app (no CORS failures) matters more than
  // shaving those seconds off cancel latency.
  let cancelled = false;

  async function runTurn({ workflow, prompt }, onEvent) {
    const resolvedBaseUrl = typeof baseUrl === "function" ? baseUrl() : baseUrl;
    const resolvedModel = typeof model === "function" ? model() : model;
    const resolvedApiKey = typeof apiKey === "function" ? apiKey() : apiKey;

    const tools = resolveToolSchemas(workflow);
    const messages = [
      { role: "system", content: systemPrompt() },
      { role: "user", content: prompt },
    ];

    onEvent({ lines: [], result: null, meta: { model: resolvedModel } });

    cancelled = false;
    const startedAt = Date.now();
    let turns = 0;
    let tokens = null;
    let finalText = null;

    while (true) {
      if (cancelled) return;

      turns += 1;
      if (turns > MAX_ITERATIONS) {
        onEvent({
          lines: [{ kind: "text", text: `(stopped after ${MAX_ITERATIONS} tool-call rounds)` }],
          result: finalText,
          meta: { durationMs: Date.now() - startedAt, turns: turns - 1, tokens, costUsd: null },
        });
        return;
      }

      const requestBody = JSON.stringify({
        model: resolvedModel,
        messages,
        tools,
        stream: false,
        temperature: 0,
      });

      let raw;
      try {
        raw = await transport({ url: `${resolvedBaseUrl}/chat/completions`, apiKey: resolvedApiKey, body: requestBody });
      } catch (err) {
        throw new Error(`Could not reach ${label} at ${resolvedBaseUrl} — is it running? (${err?.message ?? err})`);
      }

      if (cancelled) return;

      const data = JSON.parse(raw);
      if (data.usage) {
        tokens = (data.usage.total_tokens ?? (data.usage.prompt_tokens ?? 0) + (data.usage.completion_tokens ?? 0)) || tokens;
      }

      const choice = data.choices?.[0];
      const message = choice?.message ?? {};
      const toolCalls = message.tool_calls ?? [];

      if (choice?.finish_reason === "tool_calls" && toolCalls.length) {
        messages.push(message);

        const known = new Set(workflow.allowedTools.map((n) => n.replaceAll(".", "_")));
        for (const call of toolCalls) {
          const fn = call.function ?? {};
          onEvent({
            lines: [{ kind: "tool_call", text: `→ ${fn.name} ${fn.arguments ?? ""}` }],
            result: null,
            meta: null,
          });

          let toolResultText;
          if (!known.has(fn.name)) {
            // Second line of defence: the model was only ever offered tools
            // from this workflow's allowlist, so it can't legitimately
            // arrive here with anything else — but the dispatcher should
            // not rely on the request shape alone to enforce that.
            toolResultText = JSON.stringify({ ok: false, error: `Tool "${fn.name}" is not allowed for this workflow.` });
          } else {
            let args;
            try {
              args = fn.arguments ? JSON.parse(fn.arguments) : {};
            } catch (err) {
              toolResultText = JSON.stringify({ ok: false, error: `Malformed tool arguments: ${err.message}` });
            }
            if (toolResultText === undefined) {
              const outcome = await callTool(fn.name, args);
              toolResultText = JSON.stringify(stripBinaryPayloads(outcome));
            }
          }

          onEvent({
            lines: [{ kind: "tool_result", text: truncate(toolResultText, TOOL_RESULT_TRUNCATE) }],
            result: null,
            meta: null,
          });

          messages.push({ role: "tool", tool_call_id: call.id, content: toolResultText });
        }
        continue;
      }

      finalText = message.content ?? "";
      onEvent({
        lines: finalText ? [{ kind: "text", text: finalText }] : [],
        result: finalText,
        meta: { durationMs: Date.now() - startedAt, turns, tokens, costUsd: null },
      });
      return;
    }
  }

  async function cancelTurn() {
    cancelled = true;
  }

  return { id, label, capabilities, disclosure, runTurn, cancelTurn };
}
