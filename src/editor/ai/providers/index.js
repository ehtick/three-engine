/**
 * Provider registry — the AI equivalent of `workflows.js`'s `WORKFLOWS`
 * array. Every provider exposes the same interface (`runTurn`, `cancelTurn`,
 * `capabilities`, `disclosure`) regardless of whether it drives the Claude
 * Code CLI or a hand-rolled tool loop against an OpenAI-compatible endpoint —
 * see the architecture comment in the plan this shipped from. `aiStore.js`
 * is the only caller that should reach into `capabilities` to enforce the
 * mutating-workflow safety rule.
 */
import { claudeCliProvider } from "./claudeCli.js";
import { ollamaProvider } from "./ollama.js";
import { useAiPrefs } from "../../aiPrefs.js";

export const PROVIDERS = [ollamaProvider, claudeCliProvider];

export function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) ?? null;
}

/**
 * The provider named by `aiPrefs.providerId`, or the first registered
 * provider if that id is unset/stale (e.g. a provider was removed after the
 * preference was saved) — never `null` while `PROVIDERS` is non-empty, so
 * callers only need to handle "no providers registered at all", not two
 * different kinds of missing.
 */
export function getActiveProvider() {
  return getProvider(useAiPrefs.getState().providerId) ?? PROVIDERS[0] ?? null;
}
