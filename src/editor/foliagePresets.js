import { FOLIAGE_SPECIES } from "../modules/foliage/foliageGeometry.js";

const PLACEMENT = {
  oak: { density: 0.015, minSpacing: 4, lodNear: 35, lodFar: 90, maxDistance: 350 },
  pine: { density: 0.025, minSpacing: 3, lodNear: 35, lodFar: 90, maxDistance: 350 },
  birch: { density: 0.03, minSpacing: 2.5, lodNear: 30, lodFar: 80, maxDistance: 300 },
  "black-tupelo": { density: 0.018, minSpacing: 4, lodNear: 35, lodFar: 90, maxDistance: 350 },
  "weeping-willow": { density: 0.012, minSpacing: 5, lodNear: 35, lodFar: 90, maxDistance: 350 },
  spruce: { density: 0.02, minSpacing: 3, lodNear: 35, lodFar: 90, maxDistance: 350 },
  maple: { density: 0.015, minSpacing: 4.5, lodNear: 35, lodFar: 90, maxDistance: 350 },
  poplar: { density: 0.03, minSpacing: 2, lodNear: 35, lodFar: 90, maxDistance: 350 },
  shrub: { density: 0.08, minSpacing: 1.2, lodNear: 15, lodFar: 40, maxDistance: 120 },
  hawthorn: { density: 0.035, minSpacing: 2.5, lodNear: 25, lodFar: 65, maxDistance: 220 },
  grass: { density: 3, minSpacing: 0.15, lodNear: 12, lodFar: 30, maxDistance: 65 },
  wildflowers: { density: 0.8, minSpacing: 0.3, lodNear: 15, lodFar: 35, maxDistance: 80 },
};

export const FOLIAGE_CHOICES = [
  { species: "oak", label: "Oak" },
  { species: "pine", label: "Pine" },
  { species: "birch", label: "Birch" },
  { species: "black-tupelo", label: "Black Tupelo" },
  { species: "weeping-willow", label: "Weeping Willow" },
  { species: "spruce", label: "Spruce" },
  { species: "maple", label: "Maple" },
  { species: "poplar", label: "Poplar" },
  { species: "shrub", label: "Shrub" },
  { species: "hawthorn", label: "Hawthorn" },
  { species: "grass", label: "Grass" },
  { species: "wildflowers", label: "Wildflowers" },
];

/** Species edits update their shape and spacing together in one undo step. */
export function foliagePreset(species = "oak") {
  const id = PLACEMENT[species] ? species : "oak";
  const source = FOLIAGE_SPECIES[id];
  const { height, width, leafColor, barkColor, flowerColor } = source;
  return {
    species: id, height, width, leafColor, barkColor, flowerColor,
    ...(!["grass", "wildflowers"].includes(id) ? { leafDensity: 1, leafSize: 1, branchDensity: 1, crownBase: 0, crownSpread: 1 } : {}),
    ...PLACEMENT[id], minScale: 0.8, maxScale: 1.2,
    maxSlope: id === "grass" || id === "wildflowers" ? 50 : 40,
    alignToNormal: id === "grass" || id === "wildflowers",
  };
}

/** A surface remains an explicit reference, so duplicate/reload preserves it. */
export function foliageEntitySpec({ species = "oak", surfaceId = "", parentId = null, position } = {}) {
  const props = foliagePreset(species);
  const label = FOLIAGE_CHOICES.find((item) => item.species === props.species).label;
  return {
    name: surfaceId ? `${label} Scatter` : label,
    ...(parentId ? { parentId } : {}),
    ...(position ? { transform: { position: [...position] } } : {}),
    components: [{ type: "foliage", props: { ...props, surface: surfaceId, distribution: surfaceId ? "scatter" : "single" } }],
  };
}

/** Includes imported model roots whose renderable meshes are descendants. */
export function isFoliageSurface(entity, getEntity, visited = new Set()) {
  if (!entity || visited.has(entity.id)) return false;
  visited.add(entity.id);
  const components = entity.components ?? {};
  const has = (type) => entity.getComponent ? !!entity.getComponent(type) : !!components[type];
  if (has("mesh") || has("model") || has("terrain")) return true;
  return (entity.children ?? entity.childIds ?? []).some((child) =>
    isFoliageSurface(typeof child === "string" ? getEntity?.(child) : child, getEntity, visited));
}
