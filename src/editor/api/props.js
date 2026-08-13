/**
 * Component property validation, for the editor API's write ops.
 *
 * The registry validates an op's OWN parameters (`entity.setTransform` wants an
 * array). It cannot validate what goes INSIDE `component.setProp`'s `value`,
 * because the legal shape of that value is decided by the component class, not
 * by the op. So this module answers the two questions the registry cannot:
 *
 *   - Is `key` a property this component actually has?     {@link assertKnownProp}
 *   - Is `value` the right shape for it?                   {@link coercePropValue}
 *
 * Both exist because of the same failure mode. A component's `props` is a plain
 * object, so writing a misspelled key or a wrongly-typed value SUCCEEDS: the
 * write lands, the op returns the entity, the caller sees no error, and the
 * component goes on using its default. A QA pass found `totallyBogusKey`
 * persisted onto a mesh and `geometry: "dodecahedron_not_an_option"` accepted
 * against a `select` with a fixed option list — both silent, both serialised
 * into the `.scene` file.
 *
 * ## Stringified values, and why coercion is not paranoia
 *
 * `component.setProp` declares `value` as "any JSON value", which expands to a
 * JSON Schema property with no `type` at all. Some MCP clients fill an untyped
 * property with the value's JSON *text* rather than the value — so `7.5`
 * arrived as `"7.5"`, `false` as `"false"` (truthy, so every boolean set to
 * false behaved as true), and `[5,6,7]` as `"[5, 6, 7]"`. The same op issued
 * through `batch` was correct, because there the value is nested inside an
 * `array`-typed parameter the client does not touch.
 *
 * {@link toJsonSchema} now emits an explicit type union for `any`, which is the
 * real fix. This is the second half of it: a value that arrives as text is
 * converted back using the component's own declared type, and a value that
 * cannot be converted is REFUSED rather than stored. The damage the string form
 * did was not cosmetic — a collider whose `size` was the string `"[5, 6, 7]"`
 * reached Rapier as NaN half-extents, and a NaN shape makes the wasm world
 * panic on its first step, which poisons the module for the rest of the
 * session ("recursive use of an object detected", every frame, unrecoverable).
 * Refusing the write is the difference between an error message and a restart.
 */
import { getComponentClass } from "../../engine/index.js";

/** Props every component has, regardless of what its class declares. */
const UNIVERSAL_PROPS = new Set(["enabled"]);

/**
 * A schema descriptor's `options`, resolved.
 *
 * `options` may be a FUNCTION: the physics layer names come from project
 * settings that load long after the component class does, so
 * `ColliderComponent.schema` stores a getter and the Inspector calls it at
 * render time. `component.types` used to spread the raw value into its JSON
 * result, where a function serialises to nothing — an agent reading the
 * manifest saw `type: "select"` carrying no options at all, while the op's own
 * description told it those options were the only legal values.
 */
export function optionsOf(descriptor) {
  const raw = descriptor?.options;
  if (typeof raw !== "function") return Array.isArray(raw) ? [...raw] : null;
  try {
    const list = raw();
    return Array.isArray(list) ? [...list] : null;
  } catch {
    // A lazy option provider that throws is a bug in that provider, not a
    // reason to fail the read that happened to trigger it.
    return null;
  }
}

/** key -> descriptor for a component type. */
function descriptorsOf(type) {
  const map = new Map();
  for (const descriptor of getComponentClass(type)?.schema ?? []) {
    if (descriptor?.key) map.set(descriptor.key, descriptor);
  }
  return map;
}

/**
 * The JSON shape a property expects: "string" | "number" | "boolean" |
 * "array" | "object", or null when nothing declares one.
 *
 * Read from the schema descriptor's editor type first, since that is the
 * authored intent, and inferred from the default value otherwise — which is the
 * only signal available for a component whose schema is empty because its
 * inspector section is hand-written (`uielement`, `script`, `particles`).
 */
function expectedKind(descriptor, fallback) {
  switch (descriptor?.type) {
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "vec2":
    case "vec3":
    case "box":
    case "sphere":
    case "catmullrom":
      return "array";
    case "entityMap":
      return "object";
    case "select":
    case "asset":
    case "prefab":
    case "color":
    case "text":
    case "string":
    case "entity":
      return "string";
    default:
      break;
  }
  if (typeof fallback === "number") return "number";
  if (typeof fallback === "boolean") return "boolean";
  if (Array.isArray(fallback)) return "array";
  if (fallback && typeof fallback === "object") return "object";
  if (typeof fallback === "string") return "string";
  return null;
}

const kindOf = (value) =>
  Array.isArray(value) ? "array"
  : value === null ? "null"
  : typeof value === "object" ? "object"
  : typeof value;

/**
 * Turns a stringified value back into the value, using the property's declared
 * type. Returns `value` untouched when there is nothing to do; throws when the
 * string cannot possibly be what the property needs.
 */
export function coercePropValue(type, key, value) {
  if (typeof value !== "string") return value;
  const cls = getComponentClass(type);
  if (!cls) return value;
  const expected = expectedKind(descriptorsOf(type).get(key), cls.defaults?.[key]);
  if (!expected || expected === "string") return value;

  const text = value.trim();
  const fail = () => {
    throw new Error(
      `${type}.${key} expects a ${expected}, but got the string ${JSON.stringify(value)}. ` +
        "Pass the value itself, not its JSON text — e.g. [1, 2, 3] rather than \"[1, 2, 3]\".",
    );
  };

  if (expected === "boolean") {
    if (text === "true") return true;
    if (text === "false") return false;
    return fail();
  }
  if (expected === "number") {
    const n = Number(text);
    if (text !== "" && Number.isFinite(n)) return n;
    return fail();
  }
  // array / object
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail();
  }
  if (kindOf(parsed) !== expected) return fail();
  return parsed;
}

/**
 * Throws unless `key` is a property this component type actually has.
 *
 * Three sources count as "has", and the third is what keeps this from breaking
 * working scenes:
 *
 *   - the declared schema — the authored list;
 *   - `defaults` — components whose inspector section is hand-written declare
 *     an empty schema but a full set of defaults (`uielement`);
 *   - whatever the live component is ALREADY storing — a scene saved before a
 *     property was retired still holds it, and refusing to write a key that is
 *     sitting right there in the props object would break editing an old scene
 *     rather than catching a typo. (Global Illumination is the live case: it
 *     declares one property and warns about the 34 retired ones it still loads.)
 *
 * A component with an EMPTY schema and no matching default is left alone
 * entirely: `script` and `particles` carry graph/attribute blobs whose keys are
 * decided at runtime, so there is no list to check against.
 */
export function assertKnownProp(type, key, component = null) {
  const cls = getComponentClass(type);
  if (!cls) return;
  if (UNIVERSAL_PROPS.has(key)) return;
  const descriptors = descriptorsOf(type);
  if (!descriptors.size) return; // hand-written inspector section; no list to check
  if (descriptors.has(key)) return;
  if (cls.defaults && Object.hasOwn(cls.defaults, key)) return;
  if (component?.props && Object.hasOwn(component.props, key)) return;
  const known = [...new Set([...descriptors.keys(), ...Object.keys(cls.defaults ?? {})])].sort();
  throw new Error(
    `"${type}" has no property "${key}". Known properties: ${known.join(", ") || "(none)"}. ` +
      "See component.types.",
  );
}

/** Throws when `value` is outside a `select` property's declared options. */
export function assertLegalValue(type, key, value) {
  const descriptor = descriptorsOf(type).get(key);
  if (descriptor?.type !== "select") return;
  const options = optionsOf(descriptor);
  // An empty or unresolvable option list means the provider has not loaded yet
  // — refusing every write on that basis would be worse than accepting one.
  if (!options?.length) return;
  if (options.includes(value)) return;
  throw new Error(
    `"${value}" is not a legal value for ${type}.${key}. Options: ${options.join(", ")}.`,
  );
}

/** Coerce + validate one property. Returns the value to store. */
export function preparePropValue(type, key, value, component = null) {
  assertKnownProp(type, key, component);
  const coerced = coercePropValue(type, key, value);
  assertLegalValue(type, key, coerced);
  return coerced;
}

/** {@link preparePropValue} over a whole props object. Returns a new object. */
export function preparePropsObject(type, props, component = null) {
  const out = {};
  for (const [key, value] of Object.entries(props ?? {})) {
    out[key] = preparePropValue(type, key, value, component);
  }
  return out;
}
