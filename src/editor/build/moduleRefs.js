/** Disabled modules keep their definitions in the catalog. A World existing
 * only in an unopened level or reachable prefab still needs its runtime and
 * required provider closure in the exported player. */
export function moduleIdsForComponentTypes(types, definitions) {
  const wanted = new Set(types);
  return definitions.filter(definition =>
    definition.components?.some(component => wanted.has(component.type)),
  ).map(definition => definition.id);
}
