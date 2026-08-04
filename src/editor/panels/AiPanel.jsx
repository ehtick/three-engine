import { useEffect, useMemo, useRef } from "react";
import { Sparkles, X } from "lucide-react";
import { useAiStore, cancelRun } from "../store/aiStore.js";
import { engine } from "../engineInstance.js";

/**
 * Shows the live/last AI workflow run — streamed tool calls and text as they
 * arrive, then the final result. One run at a time (see aiStore.js), so this
 * is a status surface, not a chat: there is nothing to reply to yet, only to
 * watch and, on a mutating workflow later, undo.
 */

const STATUS_LABEL = {
  idle: "No run yet",
  running: "Running…",
  done: "Done",
  error: "Error",
  cancelled: "Cancelled",
};

function formatTokens(n) {
  if (!n) return null;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k tokens` : `${n} tokens`;
}

function formatCost(usd) {
  if (usd == null) return null;
  return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

function formatDuration(ms) {
  if (ms == null) return null;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function LineRow({ line }) {
  return <div className={`ai-line ${line.kind}`}>{line.text}</div>;
}

export function AiPanel() {
  const status = useAiStore((s) => s.status);
  const workflowLabel = useAiStore((s) => s.workflowLabel);
  const entityId = useAiStore((s) => s.entityId);
  const lines = useAiStore((s) => s.lines);
  const result = useAiStore((s) => s.result);
  const error = useAiStore((s) => s.error);
  const model = useAiStore((s) => s.model);
  const durationMs = useAiStore((s) => s.durationMs);
  const costUsd = useAiStore((s) => s.costUsd);
  const turns = useAiStore((s) => s.turns);
  const tokens = useAiStore((s) => s.tokens);
  const listRef = useRef(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, result]);

  const entityName = entityId ? (engine.getEntity(entityId)?.name ?? entityId) : null;
  const tone = status === "running" ? "wait" : status === "error" ? "error" : status === "done" ? "ok" : "";

  const toolCallCount = useMemo(() => lines.filter((l) => l.kind === "tool_call").length, [lines]);

  // While running there's only a live tool-call tally to show (cost/duration
  // arrive with the final `result` event); once finished, prefer the richer
  // summary — this is the direct answer to "what model, how many tokens, how
  // much did this cost" that the raw log never made visible on its own.
  const statusLine =
    status === "running"
      ? [STATUS_LABEL.running, toolCallCount > 0 ? `${toolCallCount} tool call${toolCallCount === 1 ? "" : "s"}` : null]
      : [STATUS_LABEL[status] ?? status, formatDuration(durationMs), turns ? `${turns} turn${turns === 1 ? "" : "s"}` : null, formatTokens(tokens), formatCost(costUsd)];
  const subtitle = [model, ...statusLine].filter(Boolean).join(" · ");

  return (
    <div className="inspector-panel ai-panel">
      <div className={`mcp-hero ${tone}`}>
        <span className="mcp-hero-dot" />
        <span className="mcp-hero-text">
          <span className="mcp-hero-title">
            {workflowLabel ?? "AI"}
            {entityName ? ` — ${entityName}` : ""}
          </span>
          <span className="mcp-hero-sub">{subtitle}</span>
        </span>
        {status === "running" && (
          <button className="mcp-action" title="Stop this run" onClick={() => cancelRun()}>
            <X size={13} />
            Cancel
          </button>
        )}
      </div>

      {status === "idle" ? (
        <div className="mcp-empty">
          <Sparkles size={13} />
          Right-click an entity and choose an AI action to start.
        </div>
      ) : (
        <div className="ai-lines" ref={listRef}>
          {lines.map((line, i) => (
            <LineRow key={i} line={line} />
          ))}
          {result && <div className="ai-result">{result}</div>}
          {error && <div className="ai-line error">{error}</div>}
        </div>
      )}
    </div>
  );
}
