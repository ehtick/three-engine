/**
 * Live/last AI workflow run, and the orchestration that drives one.
 *
 * `vmSingleton`-wrapped for the same reason as `commandBus`, the MCP stores,
 * and the terminal's session map — see singleton.js. A duplicate copy under
 * Vite HMR would mean AiPanel.jsx renders from a store nothing writes into,
 * which looks exactly like "the feature doesn't work" (this exact class of
 * bug has hit commandBus, useHistoryStore, useSceneStore, useSelectionStore,
 * useMcpStore and the terminal panel before).
 */
import { create } from "zustand";
import { vmSingleton } from "../singleton.js";
import { getWorkflow } from "../ai/workflows.js";
import { getActiveProvider } from "../ai/providers/index.js";
import { useProjectStore } from "./projectStore.js";

export const useAiStore = vmSingleton("aiStore", () =>
  create(() => ({
    status: "idle", // "idle" | "running" | "done" | "error" | "cancelled"
    workflowId: null,
    workflowLabel: null,
    entityId: null,
    provider: null, // active provider's label, so the panel can show who answered
    lines: [], // { kind: "text" | "tool_call" | "tool_result" | "raw", text }
    result: null,
    error: null,
    // Revealed progressively by parseStreamEvent.js's `meta` — which model
    // answered, and (once the run finishes) how long it took, how much it
    // cost, and how many turns/tokens it spent. All null until known; a user
    // watching a run has no other way to answer "what is this actually doing
    // and is it about to be expensive" without this.
    model: null,
    durationMs: null,
    costUsd: null,
    turns: null,
    tokens: null,
  })),
);

/**
 * Applies one `{lines, result, meta}` event to the store. Every provider
 * emits this exact shape — `claudeCli.js` converts its raw `stream-json`
 * lines through `parseStreamEvent` before calling `onEvent`, and the
 * tool-loop providers produce it directly — so this is the one place that
 * knows how to render a run regardless of which provider is behind it.
 */
function handleEvent({ lines, result, meta }) {
  if (lines?.length) useAiStore.setState((s) => ({ lines: [...s.lines, ...lines] }));
  if (result) useAiStore.setState({ result });
  if (meta) useAiStore.setState(meta);
}

/** Starts `workflowId` against `entityId`. Replaces whatever run was showing before. */
export async function runWorkflow(workflowId, entityId) {
  const workflow = getWorkflow(workflowId);
  if (!workflow) throw new Error(`Unknown AI workflow "${workflowId}"`);

  const provider = getActiveProvider();
  if (!provider) {
    useAiStore.setState({
      status: "error",
      workflowId,
      entityId,
      error: "No AI provider configured. Pick one in the AI provider settings.",
    });
    return;
  }

  // Enforced here, not just in the menu items that offer this action:
  // nothing stops a future call site from reaching runWorkflow directly, and
  // an unattended mutating run on a provider that cannot close its own tool
  // set (the claudeCli provider — see providers/claudeCli.js) is exactly the
  // gap this whole provider split exists to close.
  if (workflow.mutates && !provider.capabilities.scopedTools) {
    useAiStore.setState({
      status: "error",
      workflowId,
      entityId,
      provider: provider.label,
      error: `"${workflow.label}" can change the scene, and ${provider.label} cannot limit itself to this workflow's tools. Switch to a scoped provider (e.g. Ollama) to run it.`,
    });
    return;
  }

  useAiStore.setState({
    status: "running",
    workflowId,
    workflowLabel: workflow.label,
    entityId,
    provider: provider.label,
    lines: [],
    result: null,
    error: null,
    model: null,
    durationMs: null,
    costUsd: null,
    turns: null,
    tokens: null,
  });

  try {
    await provider.runTurn(
      {
        workflow,
        entityId,
        prompt: workflow.buildPrompt(entityId),
        cwd: useProjectStore.getState().rootPath ?? null,
      },
      handleEvent,
    );
    if (useAiStore.getState().status === "running") useAiStore.setState({ status: "done" });
  } catch (err) {
    if (useAiStore.getState().status === "running") {
      useAiStore.setState({ status: "error", error: String(err?.message ?? err) });
    }
  }
}

/** Cancels the in-flight run, if any. */
export async function cancelRun() {
  if (useAiStore.getState().status !== "running") return;
  useAiStore.setState({ status: "cancelled" });
  await getActiveProvider()?.cancelTurn();
}
