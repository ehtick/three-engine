/**
 * Socket typing shared by the shader and particle graphs: a colour per type
 * (so a wire's meaning is readable at a glance) and a compatibility rule React
 * Flow uses to refuse nonsense connections before they reach a compiler.
 *
 * The rule is deliberately permissive among numeric types. TSL broadcasts
 * freely — `float(2).mul(vec3(...))` is legal and useful — so blocking
 * float→vec3 would forbid perfectly good graphs. What it DOES block is mixing
 * the bundle types: `surface` (a Principled BSDF's multi-slot bundle) and
 * `volume` (a raymarch callback bundle) are not values, and wiring one into a
 * math node silently produced `null` downstream before this existed.
 */

export const SOCKET_COLORS = {
  float: "#9aa3b2",
  vec2: "#7dd3fc",
  vec3: "#a78bfa",
  vec4: "#c084fc",
  color: "#f4bf4f",
  surface: "#ef6c4d",
  volume: "#5fd35f",
  spline: "#34c8ae",
  event: "#ff7ab6",
  any: "#6f7480",
};

/** Types that are values and interconvert under TSL's broadcasting rules. */
const NUMERIC = new Set(["float", "vec2", "vec3", "vec4", "color", "any"]);

/** Bundle types: exclusive, only ever connect to their own kind. */
const EXCLUSIVE = new Set(["surface", "volume", "spline", "event"]);

export function socketColor(type) {
  return SOCKET_COLORS[type] ?? SOCKET_COLORS.any;
}

/**
 * True when a wire from `sourceType` may land on `targetType`.
 * Unknown types are treated as `any` so a registry that hasn't declared a
 * type yet stays fully connectable rather than silently un-wireable.
 */
export function typesCompatible(sourceType, targetType) {
  const a = sourceType ?? "any";
  const b = targetType ?? "any";
  if (a === "any" || b === "any") return true;
  if (a === b) return true;
  if (EXCLUSIVE.has(a) || EXCLUSIVE.has(b)) return false;
  return NUMERIC.has(a) && NUMERIC.has(b);
}

/**
 * Builds React Flow's `isValidConnection` from a registry.
 *
 * `resolve(nodeId)` must return `{ outType(handleId), inType(handleId) }` for
 * a node — the panels supply this from their own registry shape (the shader
 * registry stores `def.out` / `inputs[].type`; the particle registry stores
 * per-port `type`).
 */
export function makeConnectionValidator(resolve) {
  return (connection) => {
    const { source, target, sourceHandle, targetHandle } = connection;
    // A node feeding itself is always a cycle, and cycles hang the compilers'
    // recursive `build()` walk (both memoize per node, not per path).
    if (source === target) return false;
    const from = resolve(source);
    const to = resolve(target);
    if (!from || !to) return true; // unknown node: don't block the user
    return typesCompatible(from.outType(sourceHandle), to.inType(targetHandle));
  };
}

/**
 * True if adding `source → target` would create a cycle. React Flow's own
 * validator only sees one connection at a time, so this walks the existing
 * edge set backwards from `source` looking for `target`.
 */
export function wouldCycle(edges, source, target) {
  const incoming = new Map();
  for (const e of edges) {
    let list = incoming.get(e.target);
    if (!list) incoming.set(e.target, (list = []));
    list.push(e.source);
  }
  const seen = new Set();
  const stack = [source];
  while (stack.length) {
    const id = stack.pop();
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const up of incoming.get(id) ?? []) stack.push(up);
  }
  return false;
}
