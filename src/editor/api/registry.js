/**
 * The editor's operation registry.
 *
 * Every scriptable editor action is registered here once, as a named operation
 * with a described, validated parameter list. Two very different consumers then
 * read the same registry:
 *
 *   - In-editor scripts, through the ergonomic `Editor` facade (`api/index.js`).
 *     The facade is a thin naming layer — `Editor.entities.create(...)` calls
 *     `callOp("entity.create", ...)` — so a script and a tool can never drift.
 *   - A future MCP server, through {@link toolManifest} and {@link callOp}.
 *     MCP wants `{ name, description, inputSchema }` per tool and a single
 *     dispatch entry point; that is exactly what a registry is, so building the
 *     server later is an adapter over a transport, not a second API.
 *
 * The alternative — scripts calling the command bus and stores directly, and an
 * MCP layer re-deriving its own tool list — was rejected because it has no
 * single place where "what can be automated" is answered. Anything not in this
 * registry is, by definition, not part of the editor API, which is a property
 * worth being able to check.
 *
 * ## Parameter descriptors
 *
 * A hand-rolled shape rather than raw JSON Schema, because the registry needs
 * three things from a parameter (a type to validate, a sentence to show an LLM,
 * whether it's required) and raw schema makes the common case verbose:
 *
 *     params: {
 *       name: { type: "string", required: true, description: "Entity name" },
 *       parentId: { type: "string", description: "Parent entity id" },
 *     }
 *
 * {@link toJsonSchema} expands that into the real thing for MCP. Types are the
 * JSON ones — string, number, boolean, object, array — plus `"any"`.
 */

/**
 * name -> descriptor. Insertion order is the manifest order.
 *
 * Hung off a `Symbol.for` key rather than being a plain module-scope Map,
 * because this module can legitimately be evaluated more than once per VM:
 * Vite serves a touched module as both `foo.js` and `foo.js?t=<mtime>`, and an
 * HMR update re-runs it outright. Two Maps would mean the manifest an MCP
 * client sees and the registry `callOp` dispatches against are different
 * objects — half the tools missing, with nothing in the console to say why.
 * (`assetLoader.js` guards esbuild's one-shot `initialize()` the same way.)
 */
const REGISTRY_KEY = Symbol.for("three-engine.editorOps");
const ops = (globalThis[REGISTRY_KEY] ??= new Map());

/**
 * Identity of a definition, for telling re-evaluation from a real collision.
 *
 * Description + parameter schema, and deliberately NOT `String(run)`. Function
 * source looks like the obvious identity and is not stable here: Vite rewrites
 * `await import("../../playMode.js")` inside an op body to a URL carrying a
 * `?t=<mtime>` cache-buster, so the six ops that lazily import came out with a
 * different fingerprint on every evaluation while the other 25 matched — a
 * failure that only appears for ops with dynamic imports, in dev, which is a
 * miserable thing to debug later.
 *
 * Two genuinely different ops sharing a name AND a description AND an identical
 * parameter schema is not a real scenario; and if it somehow were, they would be
 * indistinguishable to every caller anyway.
 */
const fingerprint = (descriptor) =>
  `${descriptor.description ?? ""}|${JSON.stringify(descriptor.params ?? {})}`;

/**
 * Registers one operation.
 *
 * A duplicate name is only an error when the two definitions actually DIFFER.
 * Two modules both claiming `entity.create` is a real bug — callers would get
 * whichever loaded last, and it would present as behaviour that changes between
 * a cold and a warm editor — so that still throws. But the same module being
 * re-evaluated (HMR, or the two URL spellings above) re-registers something
 * byte-identical, and treating that as a collision turns an ordinary hot reload
 * into a hard failure. Fingerprint-compare separates the two exactly.
 */
export function defineOp(descriptor) {
  const { name, run } = descriptor;
  if (!name) throw new Error("defineOp requires a name");
  if (typeof run !== "function") throw new Error(`Op "${name}" has no run()`);
  const existing = ops.get(name);
  if (existing) {
    if (existing._fingerprint === fingerprint(descriptor)) return name; // re-evaluation
    throw new Error(
      `Editor op "${name}" is already defined with a different implementation. ` +
        "Two modules cannot claim the same op name.",
    );
  }
  ops.set(name, {
    _fingerprint: fingerprint(descriptor),
    group: name.split(".")[0],
    description: "",
    params: {},
    // Advertised to MCP clients so a read-only session can be offered the safe
    // subset. Not enforced here — it is metadata about the op, not a sandbox.
    readOnly: false,
    // Ops that push onto the undo stack say so, because "can I take this back?"
    // is the first thing anyone driving an editor remotely wants to know.
    undoable: false,
    ...descriptor,
  });
  return name;
}

/** Every registered op descriptor, in registration order. */
export function listOps() {
  return [...ops.values()];
}

/** One op descriptor, or undefined. */
export function getOp(name) {
  return ops.get(name);
}

/** Registered op names, sorted — handy for error messages and tests. */
export function opNames() {
  return [...ops.keys()].sort();
}

/** Wipes the registry. Test/harness only; the editor registers once at boot. */
export function resetOps() {
  ops.clear();
}

const TYPE_CHECKS = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  boolean: (v) => typeof v === "boolean",
  object: (v) => !!v && typeof v === "object" && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  any: () => true,
};

/**
 * Validates and normalizes `args` against an op's parameter descriptors.
 *
 * Validation lives here rather than in each op because the MCP path takes
 * arguments straight off the wire from a model, which will confidently pass a
 * string where a number belongs. Failing with "entity.create: `name` must be a
 * string, got number" beats an op throwing somewhere three layers down.
 *
 * Unknown keys are rejected rather than ignored: silently dropping a
 * misremembered parameter name means the caller sees a successful no-op, which
 * is the worst possible outcome for an automated client.
 */
export function validateArgs(op, args = {}) {
  const out = {};
  const params = op.params ?? {};
  for (const key of Object.keys(args ?? {})) {
    if (!(key in params)) {
      const known = Object.keys(params).join(", ") || "(none)";
      throw new Error(`${op.name}: unknown parameter "${key}". Accepts: ${known}`);
    }
  }
  for (const [key, spec] of Object.entries(params)) {
    const value = args?.[key];
    if (value === undefined || value === null) {
      if (spec.required) throw new Error(`${op.name}: "${key}" is required`);
      if (spec.default !== undefined) out[key] = spec.default;
      continue;
    }
    const check = TYPE_CHECKS[spec.type ?? "any"];
    if (check && !check(value)) {
      throw new Error(
        `${op.name}: "${key}" must be a ${spec.type}, got ${Array.isArray(value) ? "array" : typeof value}`,
      );
    }
    if (spec.enum && !spec.enum.includes(value)) {
      throw new Error(`${op.name}: "${key}" must be one of ${spec.enum.join(", ")}`);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Runs an op by name. The single dispatch point — the script facade and any
 * future transport both land here, so logging, validation and error shaping
 * happen exactly once.
 *
 * Always returns a promise even for synchronous ops, so callers never have to
 * know which is which.
 */
export async function callOp(name, args = {}) {
  const op = ops.get(name);
  if (!op) {
    throw new Error(`Unknown editor op "${name}". Registered: ${opNames().join(", ")}`);
  }
  return op.run(validateArgs(op, args));
}

/**
 * What `type: "any"` becomes in JSON Schema.
 *
 * NOT an omitted `type`, which is what this used to emit. A property with no
 * type is under-specified, and an MCP client faced with one is free to send the
 * value's JSON *text* instead of the value: `component.setProp`'s `value`
 * arrived as `"7.5"`, `"true"` and `"[5, 6, 7]"` — every boolean set to `false`
 * became the truthy string `"false"`, and a vec3 became a string that reached
 * the physics engine as NaN. The same op nested inside `batch`'s `array`
 * parameter was unaffected, which is what localised it here.
 *
 * An explicit union says "genuinely any JSON value" in a form a client can act
 * on. `ops/props.js` converts anything that still arrives as text.
 */
const ANY_JSON_TYPES = ["string", "number", "boolean", "object", "array", "null"];

/** Expands a parameter descriptor map into a JSON Schema object. */
export function toJsonSchema(params = {}) {
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(params)) {
    const type = spec.type ?? "any";
    properties[key] = {
      ...(type === "any" ? { type: [...ANY_JSON_TYPES] } : { type }),
      ...(spec.description ? { description: spec.description } : {}),
      ...(spec.enum ? { enum: spec.enum } : {}),
      ...(spec.default !== undefined ? { default: spec.default } : {}),
      ...(spec.items ? { items: spec.items } : {}),
    };
    if (spec.required) required.push(key);
  }
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

/**
 * The registry rendered as MCP tool descriptors.
 *
 * MCP tool names may not contain dots, so `entity.create` is advertised as
 * `entity_create`; {@link resolveToolName} maps back. Filter with
 * `{ readOnly: true }` to expose only the inspection half of the API.
 */
export function toolManifest({ readOnly = false } = {}) {
  return listOps()
    .filter((op) => !readOnly || op.readOnly)
    .map((op) => ({
      name: op.name.replaceAll(".", "_"),
      description: [op.description, op.undoable ? "Undoable (pushes onto the editor's undo stack)." : null]
        .filter(Boolean)
        .join(" "),
      inputSchema: toJsonSchema(op.params),
    }));
}

/** MCP tool name (`entity_create`) or op name (`entity.create`) -> op name. */
export function resolveToolName(toolName) {
  if (ops.has(toolName)) return toolName;
  for (const name of ops.keys()) {
    if (name.replaceAll(".", "_") === toolName) return name;
  }
  return toolName;
}

/**
 * Transport-facing entry point: takes an MCP-style tool name and arguments,
 * returns `{ ok, result }` or `{ ok: false, error }` instead of throwing.
 *
 * A thrown exception is the right thing for a script (it gets a stack, in
 * context, in the console). A remote caller wants a value it can serialize and
 * reason about, and an editor that keeps running.
 */
export async function callTool(toolName, args = {}) {
  try {
    return { ok: true, result: await callOp(resolveToolName(toolName), args) };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}
