// @ts-check
/**
 * The project's event catalog — the list of events a *game* declares, as
 * opposed to the ones the engine itself emits.
 *
 * This module is deliberately pure: it imports nothing, touches no globals, and
 * never reaches for the filesystem. Four very different callers need the same
 * answers and none of them can afford to disagree —
 *
 *   - the Events panel, validating what the user types;
 *   - `Engine.applyEvents`, hydrating the live catalog at boot;
 *   - `projectEventTypes.js`, generating the `.d.ts` that makes the names
 *     type-checked in scripts;
 *   - the exporter, carrying the catalog into a build.
 *
 * ## Why a catalog instead of one asset per event
 *
 * Unity's ScriptableObject "GameEvent" pattern makes each event a file so it
 * can be dragged into an inspector slot. We get the same wiring from a typed
 * dropdown, and a file per event would mean a second thing to keep in sync with
 * the generated declarations. The catalog lives in `project.json` next to the
 * `input` block, which is the same kind of project-wide, panel-authored data
 * and already has a working editor around it.
 */

/**
 * Parameter types an event can declare.
 *
 * The set is the intersection of two constraints: it has to be expressible as a
 * TypeScript type (so the generated declarations are useful), and it has to be
 * editable as a literal value in the inspector (so a wired-up action can supply
 * one without a script). Anything failing either test belongs in `any`.
 *
 * `ts` is written as an inline `import(...)` rather than a bare name because the
 * generated file is a module augmentation in the *user's* project — three is
 * reachable through their tsconfig `paths`, but nothing is in lexical scope.
 * `Entity` is the exception: inside `declare module "engine"` it resolves to the
 * engine's own export.
 */
export const EVENT_PARAM_TYPES = {
  number: { ts: "number", label: "Number" },
  string: { ts: "string", label: "String" },
  boolean: { ts: "boolean", label: "Boolean" },
  vec3: { ts: "import(\"three\").Vector3", label: "Vector3" },
  color: { ts: "string", label: "Color (hex)" },
  entity: { ts: "Entity", label: "Entity" },
  asset: { ts: "string", label: "Asset path" },
  any: { ts: "any", label: "Any" },
};

/** Which bus an event travels on. */
export const EVENT_SCOPES = {
  global: { map: "EngineEventMap", label: "Global (engine)" },
  entity: { map: "EntityEventMap", label: "Per-entity" },
};

/**
 * Event names the engine itself already declares in `EngineEventMap`.
 *
 * A project event that reuses one of these is not a shadow — it is a duplicate
 * property in a merged interface, which TypeScript rejects outright ("subsequent
 * property declarations must have the same type"). One bad name would therefore
 * break every declaration in the generated file, so the catalog refuses the
 * collision instead of letting the codegen produce something that doesn't
 * compile.
 *
 * Kept in sync with `script-types/engine.d.ts` by a drift check in
 * `scripts/run-events-test.mjs` — the same guard the math package uses. Add a
 * name here only when it is also added there.
 */
export const RESERVED_EVENT_NAMES = [
  "hierarchy-changed",
  "renderer-rebuilt",
  "modules-changed",
  "settings-changed",
  "play-changed",
  "time-scale-changed",
  "paused-changed",
  "input-changed",
  "entity-spawned",
  "entity-despawned",
  "component-changed",
  "script-loaded",
  "model-loaded",
  "timeline-finished",
  "timeline-event",
  "ui-click",
  "ui-focus-changed",
  "ui-cancel",
  "scene-load-start",
  "scene-load-progress",
  "scene-loaded",
  "scene-load-error",
  "scene-unloaded",
  "prefabs-changed",
  "transform-changed",
  "audio-changed",
  "path-completed",
  "entity-tags-changed",
  // Emitted by this system itself (see Engine.applyEvents).
  "events-changed",
];

/** Letters, digits, `_` and `-`; must not start with a digit or `-`. */
const EVENT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/** A tuple label in `[cause: string]` has to be a plain JS identifier. */
const PARAM_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Why `name` can't be used, or null when it can.
 *
 * `existing` is the list of names already taken; pass the catalog's other
 * events so the panel can flag a duplicate while the user is still typing.
 */
export function eventNameError(name, existing = []) {
  const value = String(name ?? "").trim();
  if (!value) return "An event needs a name.";
  if (!EVENT_NAME_RE.test(value)) {
    return "Use letters, digits, - and _ (and don't start with a digit).";
  }
  if (RESERVED_EVENT_NAMES.includes(value)) {
    return `"${value}" is an engine event — pick another name.`;
  }
  if (existing.some((other) => other === value)) {
    return `"${value}" is already defined.`;
  }
  return null;
}

/** Why `name` can't be a parameter name, or null when it can. */
export function paramNameError(name, existing = []) {
  const value = String(name ?? "").trim();
  if (!value) return "A parameter needs a name.";
  if (!PARAM_NAME_RE.test(value)) return "Use a plain identifier: letters, digits, _ or $.";
  if (existing.includes(value)) return `"${value}" is used twice.`;
  return null;
}

/**
 * Coerces whatever is in `project.json` into a catalog we can rely on.
 *
 * Forgiving on purpose. This block is hand-editable, arrives from older
 * projects that predate half the fields, and can be merged by git into shapes
 * neither side wrote. Anything unusable is dropped and *reported* rather than
 * thrown — a malformed entry must not stop a project from opening, but it also
 * must not disappear silently, because the user's script will fail to compile
 * against a name that quietly isn't there.
 *
 * @returns `{ events, errors }` — `errors` is a list of human-readable strings.
 */
export function normalizeEventCatalog(raw) {
  const errors = [];
  const events = [];
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.events) ? raw.events : [];
  if (raw != null && !Array.isArray(raw) && !Array.isArray(raw?.events)) {
    errors.push("The `events` block should be a list.");
    return { events, errors };
  }

  const seen = [];
  for (const entry of list) {
    // A bare string is a valid shorthand for a no-argument event; people write
    // it by hand and it would be hostile to reject.
    const def = typeof entry === "string" ? { name: entry } : entry;
    if (!def || typeof def !== "object") {
      errors.push(`Skipped an event entry that isn't an object: ${JSON.stringify(entry)}`);
      continue;
    }
    const name = String(def.name ?? "").trim();
    const nameError = eventNameError(name, seen);
    if (nameError) {
      errors.push(`Skipped "${name || "(unnamed)"}": ${nameError}`);
      continue;
    }
    seen.push(name);

    const scope = def.scope === "entity" ? "entity" : "global";
    const params = [];
    const paramNames = [];
    for (const rawParam of Array.isArray(def.params) ? def.params : []) {
      const param = typeof rawParam === "string" ? { name: rawParam } : rawParam;
      if (!param || typeof param !== "object") continue;
      const paramName = String(param.name ?? "").trim();
      const paramError = paramNameError(paramName, paramNames);
      if (paramError) {
        errors.push(`"${name}": skipped parameter "${paramName || "(unnamed)"}" — ${paramError}`);
        continue;
      }
      const type = param.type in EVENT_PARAM_TYPES ? param.type : "any";
      if (param.type && !(param.type in EVENT_PARAM_TYPES)) {
        errors.push(`"${name}.${paramName}": unknown type "${param.type}" — treated as "any".`);
      }
      paramNames.push(paramName);
      params.push({
        name: paramName,
        type,
        ...(param.optional ? { optional: true } : {}),
        ...(param.description ? { description: String(param.description) } : {}),
      });
    }

    // An optional parameter followed by a required one is not expressible as a
    // tuple, and TypeScript's error for it points at the generated file rather
    // than at anything the user can see. Reorder instead: the declared types
    // stay correct and the panel is where the ordering gets fixed for real.
    const firstOptional = params.findIndex((p) => p.optional);
    if (firstOptional !== -1 && params.slice(firstOptional).some((p) => !p.optional)) {
      errors.push(`"${name}": optional parameters were moved after the required ones.`);
      params.sort((a, b) => Number(!!a.optional) - Number(!!b.optional));
    }

    events.push({
      name,
      scope,
      params,
      ...(def.description ? { description: String(def.description) } : {}),
      ...(def.category ? { category: String(def.category) } : {}),
    });
  }
  return { events, errors };
}

/** The TypeScript tuple for one event's payload, e.g. `[cause: string]`. */
function tupleFor(params) {
  if (!params.length) return "[]";
  const parts = params.map(
    (p) => `${p.name}${p.optional ? "?" : ""}: ${EVENT_PARAM_TYPES[p.type]?.ts ?? "any"}`,
  );
  return `[${parts.join(", ")}]`;
}

/** A JSDoc block for one event, or "" when there's nothing to say. */
function docFor(event, indent) {
  const lines = [];
  if (event.description) lines.push(...String(event.description).split("\n"));
  for (const param of event.params) {
    if (param.description) lines.push(`@param ${param.name} ${param.description}`);
  }
  if (!lines.length) return "";
  if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`;
  return `${indent}/**\n${lines.map((l) => `${indent} * ${l}`).join("\n")}\n${indent} */\n`;
}

const GENERATED_BANNER = `// GENERATED — do not edit.
//
// Three Engine rewrites this file from the \`events\` block in project.json
// every time the Events panel saves. Add, rename and remove events there.
//
// Everything below is a module augmentation, which is what makes a project's
// own events type-checked at both ends: \`engine.emit("...")\` knows the payload
// it must be given, \`engine.on("...")\` knows the payload it will receive, and a
// name that isn't in this file is a compile error rather than a silent no-op.
`;

/**
 * The full text of `<project>/project-events.d.ts`.
 *
 * Always returns a valid module — an empty catalog still produces a file with a
 * trailing `export {}`, because a project that had events and then removed them
 * must not be left with a stale declaration on disk.
 */
export function generateEventTypes(events) {
  const byScope = { global: [], entity: [] };
  for (const event of events) byScope[event.scope === "entity" ? "entity" : "global"].push(event);

  const blocks = [];
  for (const [scope, { map }] of Object.entries(EVENT_SCOPES)) {
    const scoped = byScope[scope];
    if (!scoped.length) continue;
    const body = scoped
      .map((event) => `${docFor(event, "    ")}    "${event.name}": ${tupleFor(event.params)};`)
      .join("\n");
    blocks.push(`  interface ${map} {\n${body}\n  }`);
  }

  const augmentation = blocks.length
    ? `declare module "engine" {\n${blocks.join("\n\n")}\n}\n\n`
    : "// No project events are defined yet — add some in the Events panel.\n\n";

  return `${GENERATED_BANNER}\n${augmentation}export {};\n`;
}

/** Serializable form, ready to be written into `project.json`. */
export function serializeEventCatalog(events) {
  return events.map((event) => ({
    name: event.name,
    ...(event.scope === "entity" ? { scope: "entity" } : {}),
    ...(event.description ? { description: event.description } : {}),
    ...(event.category ? { category: event.category } : {}),
    ...(event.params?.length
      ? {
          params: event.params.map((p) => ({
            name: p.name,
            type: p.type,
            ...(p.optional ? { optional: true } : {}),
            ...(p.description ? { description: p.description } : {}),
          })),
        }
      : {}),
  }));
}
