// @ts-check
/**
 * The hierarchy's search ranking, in one place.
 *
 * Two callers need it and have to agree: the Hierarchy panel's filter box, and
 * the `selection.selectMatching` op an agent drives over MCP. "Select every
 * mesh" must mean the same 1500 entities whichever one asks, so the tiers live
 * here rather than inside the panel — otherwise the agent's idea of a match and
 * the user's would drift the first time either side was tweaked.
 *
 * The two callers hold entities in different shapes (the panel reads
 * sceneStore's plain mirror, the op reads live `Entity` objects), so ranking
 * takes a small normalized candidate and each side brings its own adapter.
 */

/**
 * Rank a candidate against the query. Lower = better; `Infinity` = no match.
 *
 *   0 — name starts with the query
 *   1 — name contains it
 *   2 — a component type starts with it
 *   3 — a component type contains it
 *   4 — a tag contains it
 *
 * Name and component type are both checked in this priority, so "can" jumps to
 * the top for entities literally named "can" AND for anything carrying a
 * `camera` component.
 *
 * A `tag:` prefix searches tags exclusively — "tag:enemy" finds every tagged
 * enemy without also dragging in the entity someone named "Enemy spawn note".
 *
 * @param {{ name?: string, tags?: string[], componentTypes?: string[] }} candidate
 * @param {string} q  already lowercased and trimmed
 */
export function matchTier(candidate, q) {
  const tags = (candidate.tags ?? []).map((tag) => String(tag).toLowerCase());
  if (q.startsWith("tag:")) {
    const needle = q.slice(4).trim();
    if (!needle) return tags.length ? 0 : Infinity;
    if (tags.some((tag) => tag === needle)) return 0;
    return tags.some((tag) => tag.includes(needle)) ? 1 : Infinity;
  }
  const name = (candidate.name ?? "").toLowerCase();
  if (name.startsWith(q)) return 0;
  if (name.includes(q)) return 1;
  const types = candidate.componentTypes ?? [];
  for (const type of types) {
    if (type.toLowerCase().startsWith(q)) return 2;
  }
  for (const type of types) {
    if (type.toLowerCase().includes(q)) return 3;
  }
  if (tags.some((tag) => tag.includes(q))) return 4;
  return Infinity;
}

/** Candidate from a sceneStore mirror entity (`components` is a plain map). */
export function candidateFromMirror(entity) {
  return {
    name: entity.name,
    tags: entity.tags,
    componentTypes: Object.keys(entity.components ?? {}),
  };
}

/** Candidate from a live engine `Entity` (`components` is a Map of instances). */
export function candidateFromLive(entity) {
  return {
    name: entity.name,
    tags: entity.tags,
    componentTypes: [...(entity.components?.values() ?? [])].map((component) => component.type),
  };
}

/**
 * Builds the panel's match index for the current scene: `{ id -> { tier } }`.
 * Walks the FULL scene rather than the visible rows, so a hit inside a
 * collapsed branch still surfaces. Returns `null` for an empty query so the
 * caller can fast-path to "show everything".
 */
export function buildSearchIndex(rootIds, entities, query) {
  const q = (query ?? "").trim().toLowerCase();
  if (!q || !entities) return null;
  const out = {};
  const stack = [...rootIds];
  while (stack.length) {
    const id = stack.pop();
    const e = entities[id];
    if (!e) continue;
    const tier = matchTier(candidateFromMirror(e), q);
    if (tier !== Infinity) out[id] = { tier };
    if (e.childIds.length) stack.push(...e.childIds);
  }
  return out;
}

/**
 * Match ids in display order: best tier first, name as the stable tiebreaker.
 * This order is also the selection order — shift-click ranges and Ctrl+A in
 * search mode both run over exactly the list the user is looking at.
 */
export function sortMatchIds(matches, entities) {
  if (!matches) return [];
  return Object.keys(matches).sort((a, b) => {
    const t = matches[a].tier - matches[b].tier;
    if (t !== 0) return t;
    return (entities?.[a]?.name ?? "").localeCompare(entities?.[b]?.name ?? "");
  });
}
