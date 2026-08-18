import {
  Activity,
  Blocks,
  Bone,
  Box,
  Boxes,
  Building2,
  Camera,
  CircleDot,
  Clapperboard,
  Cloud,
  Cpu,
  FileCode2,
  Film,
  Footprints,
  Image,
  Layers,
  Layers3,
  Images,
  Link,
  LayoutGrid,
  Lightbulb,
  Milestone,
  Mountain,
  MousePointerClick,
  Move3d,
  Route,
  Package,
  Radio,
  ScrollText,
  Shapes,
  Sparkles,
  Spline,
  Stamp,
  SquareDashed,
  SquareStack,
  Sun,
  Type,
  Volume2,
  Wand2,
  Waves,
  Waypoints,
  Wind,
} from "lucide-react";

/**
 * Icon + accent colour per component type, used by the Add Component menu and
 * the inspector's section headers.
 *
 * A flat alphabetical list of grey labels is the slowest thing to scan in the
 * whole editor — the eye has to read every word. Colour-coded glyphs let you
 * find "the blue camera one" without reading, and the same glyph appearing on
 * the section header afterwards confirms you added what you meant to.
 *
 * Colours are grouped by family rather than assigned per type, so the palette
 * stays legible: rendering = blue, lighting = amber, physics = green,
 * logic/scripting = purple, audio = pink, UI = teal, AI/navigation = orange.
 */
const RENDER = "#4da3ff";
const LIGHT = "#f5c451";
const PHYSICS = "#4fd475";
const LOGIC = "#b784f5";
const AUDIO = "#ff7ac6";
const UI = "#3fd0c9";
// AI/navigation gets its own hue: a nav agent is neither physics nor logic,
// and colouring it as either makes the Add Component menu harder to scan.
const AI = "#ff9f45";
const WORLD = "#8ea0b5";

const ICONS = {
  mesh: [Box, RENDER],
  model: [Package, RENDER],
  skinnedmesh: [Bone, RENDER],
  objModel: [Package, RENDER],
  instancer: [SquareStack, RENDER],
  geometryModifiers: [Shapes, RENDER],
  lod: [Layers3, RENDER],
  impostor: [Images, RENDER],
  camera: [Camera, RENDER],
  vcam: [Clapperboard, RENDER],
  impulsesource: [Waves, RENDER],
  postprocess: [Sparkles, RENDER],
  particles: [Wand2, RENDER],
  line: [Spline, RENDER],
  trail: [Wind, RENDER],
  decal: [Stamp, RENDER],

  light: [Lightbulb, LIGHT],
  environment: [Cloud, LIGHT],
  "global-illumination": [Sun, LIGHT],

  navmesh: [Waypoints, AI],
  navagent: [Footprints, AI],
  navlink: [Link, AI],

  rigidbody: [Move3d, PHYSICS],
  collider: [SquareDashed, PHYSICS],
  charactercontroller: [Footprints, PHYSICS],

  script: [FileCode2, LOGIC],
  animation: [Activity, LOGIC],
  timeline: [Film, LOGIC],
  ik: [Footprints, LOGIC],
  pool: [Boxes, LOGIC],
  bone: [Bone, LOGIC],

  sound: [Volume2, AUDIO],
  listener: [Radio, AUDIO],

  uiscreen: [Layers, UI],
  uielement: [SquareDashed, UI],
  uiimage: [Image, UI],
  uitext: [Type, UI],
  uibutton: [MousePointerClick, UI],
  uilayout: [LayoutGrid, UI],
  uiscroll: [ScrollText, UI],
  uimask: [CircleDot, UI],

  level: [Building2, WORLD],
  levelfloor: [Layers, WORLD],
  blockout: [Blocks, WORLD],

  terrain: [Mountain, WORLD],
  water: [Waves, WORLD],
  spline: [Spline, WORLD],
  splineFollower: [Route, WORLD],
  splineMesh: [Milestone, WORLD],
};

/** `{ Icon, color }` for a component type; a neutral chip for unknown ones. */
export function componentIcon(type) {
  const [Icon, color] = ICONS[type] ?? [Cpu, WORLD];
  return { Icon, color };
}

/**
 * Grouping for the Add Component menu. Types not listed anywhere fall into
 * "Other", so a module registering a new component still shows up — it just
 * doesn't get a curated home until someone adds one.
 */
export const COMPONENT_GROUPS = [
  { label: "Rendering", types: ["mesh", "model", "skinnedmesh", "objModel", "instancer", "geometryModifiers", "lod", "impostor"] },
  { label: "Effects", types: ["particles", "line", "trail", "decal"] },
  { label: "Camera", types: ["camera", "postprocess"] },
  { label: "Lighting", types: ["light", "environment", "global-illumination"] },
  { label: "Physics", types: ["rigidbody", "collider", "charactercontroller"] },
  { label: "Logic", types: ["script", "animation", "bone", "pool"] },
  { label: "Audio", types: ["sound", "listener"] },
  { label: "UI", types: ["uiscreen", "uielement", "uiimage", "uitext", "uibutton", "uilayout", "uiscroll", "uimask"] },
  { label: "World", types: ["terrain", "water", "spline", "splineMesh", "splineFollower"] },
  { label: "Level Design", types: ["level", "levelfloor", "blockout"] },
];

/**
 * Splits `types` into the curated groups above, preserving each group's order
 * and dropping empty ones. Anything unrecognised lands in a trailing "Other".
 */
export function groupComponentTypes(types) {
  const remaining = new Set(types);
  const groups = [];
  for (const group of COMPONENT_GROUPS) {
    const present = group.types.filter((type) => remaining.has(type));
    for (const type of present) remaining.delete(type);
    if (present.length) groups.push({ label: group.label, types: present });
  }
  if (remaining.size) groups.push({ label: "Other", types: [...remaining] });
  return groups;
}
