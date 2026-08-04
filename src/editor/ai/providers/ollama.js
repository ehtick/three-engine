/**
 * The default AI provider: `toolLoop.js` bound to a local Ollama server.
 * Free, local, and `scopedTools: true` — the tool set is closed by
 * construction (see toolLoop.js), so this is the only provider a `mutates`
 * workflow may run on until an Anthropic-native tool-loop adapter exists.
 *
 * `baseUrl`/`model` are passed as thunks reading `useAiPrefs` at call time
 * rather than resolved once here at import time, so changing the provider
 * settings takes effect on the very next run without a page reload.
 */
import { createToolLoopProvider } from "./toolLoop.js";
import { useAiPrefs } from "../../aiPrefs.js";

export const ollamaProvider = createToolLoopProvider({
  id: "ollama",
  label: "Ollama (local)",
  baseUrl: () => useAiPrefs.getState().ollamaBaseUrl,
  model: () => useAiPrefs.getState().ollamaModel,
  apiKey: () => "",
  capabilities: { scopedTools: true, isLocal: true, needsApiKey: false },
  disclosure: "Runs entirely on your machine against a local Ollama server. Tools are limited to this workflow's allowlist by construction.",
});
