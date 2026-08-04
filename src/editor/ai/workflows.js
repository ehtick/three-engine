/**
 * AI workflow registry.
 *
 * Each entry is a scoped, narrow AI action — a right-click "AI: X" — rather
 * than a general-purpose chat with the whole editor exposed. See
 * AI_EDITOR_INTEGRATION_INSTRUCTIONS.md §6 ("Do not expose the entire editor
 * tool registry to every AI request") and §19 ("Build a small number of
 * excellent workflows first"). One entry today.
 *
 * `allowedTools` names are op names from `api/registry.js` (dotted, e.g.
 * "entity.get"), checked against the live registry by {@link resolveAllowedTools}
 * so a typo here fails loudly at run time instead of silently narrowing the
 * model to nothing.
 */
import { opNames, getOp, toJsonSchema } from "../api/registry.js";
import { MCP_SERVER_NAME } from "../mcpClients.js";

export const WORKFLOWS = [
  {
    id: "diagnose-selected",
    label: "Diagnose this",
    // Any single entity, for now — narrows further (by component type) once a
    // second, more targeted workflow needs it.
    appliesTo: () => true,
    allowedTools: [
      "entity.get",
      "entity.getBounds",
      "entity.list",
      "viewport.focus",
      "viewport.screenshot",
      "console.read",
    ],
    buildPrompt: (entityId) =>
      `Diagnose entity "${entityId}" in the currently open scene of a three.js/WebGPU game editor. ` +
      "Use the available tools to inspect its components, bounds, and a viewport screenshot, and check " +
      "recent console errors/warnings for anything related to it. Explain concisely what, if anything, " +
      "looks wrong or worth improving. You only have read-only tools available — do not attempt to modify anything.",
  },
];

export function getWorkflow(id) {
  return WORKFLOWS.find((w) => w.id === id) ?? null;
}

/**
 * Guards a workflow's `allowedTools` against the live registry so a typo here
 * fails loudly at run time instead of silently narrowing the model to
 * nothing. Shared by {@link resolveAllowedTools} (the claudeCli path) and
 * {@link resolveToolSchemas} (the tool-loop path) rather than duplicated.
 */
function checkKnownOps(workflow) {
  const known = new Set(opNames());
  const missing = workflow.allowedTools.filter((name) => !known.has(name));
  if (missing.length) {
    throw new Error(`Workflow "${workflow.id}" references unknown op(s): ${missing.join(", ")}`);
  }
}

/**
 * A workflow's `allowedTools`, resolved to the exact strings the `claude` CLI's
 * `--allowedTools` flag expects for MCP tools: `mcp__<server>__<tool>`, with
 * dots turned into underscores the same way {@link toolManifest} in
 * `api/registry.js` names them. This exact namespacing was not verified
 * against a live `claude` install — if a run reports every tool call denied
 * despite this list, check `claude mcp list` / the CLI's own permission-flag
 * docs for the current naming convention and fix it here, in the one place
 * that knows about it.
 */
export function resolveAllowedTools(workflow) {
  checkKnownOps(workflow);
  return workflow.allowedTools.map((name) => `mcp__${MCP_SERVER_NAME}__${name.replaceAll(".", "_")}`);
}

/**
 * A workflow's `allowedTools`, resolved to OpenAI `chat/completions`-shaped
 * tool descriptors — what `toolLoop.js` hands the request as `tools:[...]`.
 * Reuses `toJsonSchema` from `api/registry.js` rather than re-deriving a
 * schema converter; dots are stripped from tool names the same way
 * `resolveAllowedTools`/`toolManifest` do it, since neither an MCP tool name
 * nor an OpenAI function name may contain one.
 */
export function resolveToolSchemas(workflow) {
  checkKnownOps(workflow);
  return workflow.allowedTools.map((name) => {
    const op = getOp(name);
    return {
      type: "function",
      function: {
        name: name.replaceAll(".", "_"),
        description: op.description,
        parameters: toJsonSchema(op.params),
      },
    };
  });
}
