/** Architecture style catalogue (v2). A style is a plain data record — the kit generators in
 * `../kit/*.js` read it and never mutate it. One record fully describes how a massing model
 * (forms, openings, paths) becomes a finished building: wall construction, corner/base/crown
 * treatment, roof shape and covering, window/door design, supports under raised forms and the
 * cap of free-standing walls. `detail` is the texture/jitter strength (stylized styles keep it
 * low so surfaces read clean; realistic styles push relief and per-piece tone variation).
 *
 * Colours are the colours the viewer should see: surface textures are luminance-normalised, so
 * a palette entry is not darkened by a coloured texture underneath it. */

const DEG = Math.PI / 180;

export const SURFACE_KINDS = Object.freeze(["plaster", "stone", "brick", "plank", "log", "timber", "tiles", "slate", "shingles", "thatch", "metal", "concrete", "adobe", "cobble"]);
const ROOF_COVERS = ["tiles", "slate", "shingles", "barrel", "thatch", "metal", "flat"];
const PLINTHS = ["stones", "band", "none"];
const CORNERS = ["quoins", "posts", "pilasters", "buttress", "logs", "none"];
const CROWNS = ["beam", "cornice", "coping", "vigas", "light", "none"];
const CLADDING = ["none", "clapboard", "logs", "panels"];
const HEADS = ["flat", "round", "pointed", "segment"];
const LAYOUTS = ["punched", "ribbon", "slit"];
const MULLIONS = ["none", "cross", "grid", "vertical", "sash"];
const FRAMES = ["timber", "trim", "stone", "metal", "none"];
const LEAVES = ["planks", "panel", "glass"];
const SUPPORTS = ["stone", "timber", "pilotis"];
const BOUNDARY_CAPS = ["battlements", "rounded", "coping", "palisade"];
const FLAT_EDGES = ["parapet", "battlements", "coping", "eave"];
const ROUND_ROOFS = ["cone", "dome", "flat"];
const BOX_ROOFS = ["gable", "hip", "flat", "shed"];
const FINIALS = ["none", "spike", "ball"];
const RIDGES = ["roll", "tiles", "board", "none"];
const PALETTE_ROLES = ["wall", "roof", "trim", "timber", "stone", "door", "shutter", "glass", "metal", "accent", "light"];

const base = {
  walls: { kind: "plaster", thickness: .4, storey: 3, plinth: { type: "none", height: .5, kind: "stone" }, corners: "none", crown: "none", band: "none", framing: null, cladding: "none", colorPerForm: false },
  roof: { box: "gable", round: "cone", pitch: 40 * DEG, cover: "tiles", kind: "tiles", tile: [.34, .28], thickness: .2, overhang: .4, ridge: "tiles", bargeboard: false, chimney: .4, chimneyKind: "brick", flatEdge: "parapet", flatKind: "concrete", finial: "none", bell: 0 },
  openings: {
    window: { w: 1, h: 1.3, sill: .9, spacing: 2.4, layout: "punched", head: "flat", frame: "timber", frameWidth: .09, sillType: "stone", lintel: "none", mullions: "cross", shutters: 0, shutterType: "plank", flowerBox: 0, glass: "dark" },
    door: { w: 1.1, h: 2.2, head: "flat", frame: "timber", leaf: "planks", step: true, canopy: 0 },
  },
  supports: "stone",
  boundary: { thickness: .5, height: 2.2, cap: "coping", kind: "stone" },
  path: { kind: "cobble" },
  detail: .8,
};

function style(id, label, family, description, palette, overrides) {
  const merge = (a, b) => {
    const out = { ...a };
    for (const [key, value] of Object.entries(b ?? {})) out[key] = value && typeof value === "object" && !Array.isArray(value) && a?.[key] && typeof a[key] === "object" ? merge(a[key], value) : value;
    return out;
  };
  return { id, label, family, description, palette, ...merge(base, overrides) };
}

const STYLES = [
  style("tiny-glade", "Tiny Glade", "stylized", "Cozy cream plaster, chunky stone plinths, scalloped clay roofs, arched windows with shutters and flower boxes.", {
    wall: ["#f1e4cb", "#ecdcbf", "#f4eadb"], roof: ["#bb6a45", "#a4573a", "#6d8090", "#c27b4f"], trim: ["#f7f0e3"], timber: ["#7c5b40", "#6b4c34"],
    stone: ["#cfc3aa", "#bcb099", "#d8cfbb"], door: ["#5f806c", "#7b4b37", "#52718a"], shutter: ["#6b9a7f", "#5f87a8", "#b96a4b"], glass: ["#39505c"], metal: ["#3d3a36"], accent: ["#e0575a", "#f0c24f", "#d67ab6", "#f4f1ea"], light: ["#ffd27a"],
  }, {
    walls: { kind: "plaster", thickness: .45, plinth: { type: "stones", height: .6, kind: "stone" }, crown: "beam" },
    roof: { box: "gable", round: "cone", pitch: 44 * DEG, cover: "tiles", kind: "tiles", tile: [.46, .36], thickness: .24, overhang: .45, ridge: "roll", chimney: .45, chimneyKind: "stone", finial: "ball", bell: .35 },
    openings: { window: { w: .9, h: 1.25, head: "round", frame: "trim", mullions: "cross", shutters: .55, flowerBox: .6 }, door: { head: "round", canopy: .25 } },
    boundary: { thickness: .6, height: 1.4, cap: "rounded", kind: "stone" }, detail: .35,
  }),
  style("townscaper", "Townscaper", "stylized", "Pastel plaster blocks with white cornices, steep little tile roofs and tall shuttered windows.", {
    wall: ["#f4c9b0", "#bfe0d2", "#f2e19c", "#d5c3ea", "#f3b8b8", "#b9d4f1", "#f7f1e5"], roof: ["#d9744c", "#c9604a", "#e0985a"], trim: ["#ffffff"], timber: ["#8a6a48"],
    stone: ["#ece4d2"], door: ["#3d5a6c", "#6c3d3d", "#3d6c4a"], shutter: ["#3f6b7c", "#7c4a3f", "#4f7c52"], glass: ["#2f4550"], metal: ["#3a3a3a"], accent: ["#f28b82", "#fbd35c"], light: ["#ffe2a0"],
  }, {
    walls: { kind: "plaster", thickness: .32, storey: 2.8, crown: "cornice", colorPerForm: true },
    roof: { box: "gable", round: "cone", pitch: 40 * DEG, cover: "tiles", tile: [.36, .3], thickness: .14, overhang: .18, ridge: "board", chimney: .15, flatEdge: "coping", flatKind: "plaster", finial: "spike" },
    openings: { window: { w: .8, h: 1.45, spacing: 1.9, frame: "trim", sillType: "trim", mullions: "vertical", shutters: .25, flowerBox: .15 }, door: { head: "round", frame: "trim", leaf: "panel" } },
    supports: "stone", boundary: { thickness: .35, height: 1.2, cap: "coping", kind: "plaster" }, path: { kind: "cobble" }, detail: .2,
  }),
  style("timber-medieval", "Timber Medieval", "realistic", "Half-timbered frame with plaster infill, deep thatch, rubble plinth and small shuttered windows.", {
    wall: ["#e6dcc3", "#ddd0ae", "#d3c6a3"], roof: ["#a89266", "#978258", "#8b7a55"], trim: ["#3b2a1d"], timber: ["#4a3524", "#3d2c1d", "#54402c"],
    stone: ["#8d8577", "#7d766a", "#968d7d"], door: ["#46321f", "#3a2a1a"], shutter: ["#4d3a27", "#5b4630"], glass: ["#2d3a3e"], metal: ["#2f2d2a"], accent: ["#9b4a3a", "#c7a75a"], light: ["#ffc46e"],
  }, {
    walls: { kind: "plaster", thickness: .35, storey: 2.9, plinth: { type: "stones", height: .55, kind: "stone" }, corners: "posts", crown: "beam", framing: { spacing: 1.3, braces: true } },
    roof: { box: "gable", pitch: 52 * DEG, cover: "thatch", kind: "thatch", thickness: .45, overhang: .55, ridge: "roll", chimney: .35, chimneyKind: "stone" },
    openings: { window: { w: .8, h: 1, frame: "timber", sillType: "timber", mullions: "grid", shutters: .5 }, door: { w: 1.05, h: 2.1, frame: "timber" } },
    supports: "timber", boundary: { thickness: .5, height: 1.6, cap: "rounded", kind: "stone" }, detail: .85,
  }),
  style("stone-cottage", "Stone Cottage", "realistic", "Coursed rubble walls with dressed quoins, slate roofs, stone lintels and a big chimney.", {
    wall: ["#b0a797", "#a39a8a", "#b8ae9c"], roof: ["#5b6168", "#50565d", "#62676c"], trim: ["#e9e3d6", "#5a4a38"], timber: ["#4d3b2b"],
    stone: ["#c9c0ae", "#bcb39f"], door: ["#3f5a4a", "#5a3a2a", "#2f4455"], shutter: ["#4f6a58", "#6b4a36"], glass: ["#28363c"], metal: ["#2e2e2e"], accent: ["#b9473d", "#d9b44a"], light: ["#ffc46e"],
  }, {
    walls: { kind: "stone", thickness: .55, corners: "quoins" },
    roof: { box: "gable", pitch: 42 * DEG, cover: "slate", kind: "slate", tile: [.3, .24], thickness: .2, overhang: .3, ridge: "tiles", bargeboard: true, chimney: .8, chimneyKind: "stone" },
    openings: { window: { w: .9, h: 1.2, frame: "trim", sillType: "stone", lintel: "stone", mullions: "cross", shutters: .2 }, door: { head: "segment", frame: "stone" } },
    boundary: { thickness: .55, height: 1.3, cap: "rounded", kind: "stone" }, detail: .9,
  }),
  style("plaster-mediterranean", "Mediterranean", "realistic", "Whitewashed thick walls, barrel-tile hip roofs, round arches, louvred shutters and domed towers.", {
    wall: ["#f3eee3", "#efe6d4", "#f6f1e8"], roof: ["#b8643d", "#a85834", "#c4744a"], trim: ["#e8dcc4"], timber: ["#8a6a48"],
    stone: ["#d2c7ae", "#bfb399"], door: ["#3f6a66", "#2e4d6b", "#7a3d34"], shutter: ["#3c7a73", "#35668f", "#6b8a3c"], glass: ["#2c3f48"], metal: ["#2c2c2c"], accent: ["#d4418e", "#f28d35"], light: ["#ffd98a"],
  }, {
    walls: { kind: "plaster", thickness: .55, plinth: { type: "band", height: .45, kind: "stone" }, crown: "cornice" },
    roof: { box: "hip", round: "dome", pitch: 24 * DEG, cover: "barrel", kind: "tiles", tile: [.26, .42], thickness: .16, overhang: .35, ridge: "tiles", chimney: .2, flatEdge: "parapet", flatKind: "plaster", finial: "ball" },
    openings: { window: { w: .9, h: 1.45, head: "round", frame: "none", sillType: "stone", mullions: "none", shutters: .7, shutterType: "louvre", flowerBox: .3 }, door: { head: "round", frame: "stone", leaf: "planks" } },
    boundary: { thickness: .45, height: 1.6, cap: "coping", kind: "plaster" }, detail: .55,
  }),
  style("wood-frontier", "Frontier", "realistic", "Clapboard walls, shingle roofs, board trims and a porch canopy over every door.", {
    wall: ["#9c7a55", "#8b6b49", "#a88460"], roof: ["#5f5244", "#54493d", "#6a5b4a"], trim: ["#d9cdb6", "#4a3a2a"], timber: ["#5c4632", "#4d3a28"],
    stone: ["#8c8474", "#7a7264"], door: ["#4a3826", "#6b3b2b"], shutter: ["#3f4f3a", "#5a3a2a"], glass: ["#26333a"], metal: ["#2f2e2c"], accent: ["#b04a3a"], light: ["#ffbf66"],
  }, {
    walls: { kind: "plank", thickness: .3, plinth: { type: "band", height: .35, kind: "stone" }, corners: "posts", crown: "beam", cladding: "clapboard" },
    roof: { box: "gable", pitch: 33 * DEG, cover: "shingles", kind: "shingles", tile: [.26, .2], thickness: .16, overhang: .45, ridge: "board", bargeboard: true, chimney: .35, chimneyKind: "brick" },
    openings: { window: { w: .9, h: 1.35, frame: "trim", sillType: "timber", mullions: "sash", shutters: .3 }, door: { frame: "trim", leaf: "planks", canopy: .7 } },
    supports: "timber", boundary: { thickness: .3, height: 2.4, cap: "palisade", kind: "log" }, path: { kind: "cobble" }, detail: .85,
  }),
  style("nordic-log", "Nordic Log", "realistic", "Round-log walls with crossed corners, steep dark shingles, white-framed small windows.", {
    wall: ["#8f7250", "#7d6344", "#9a7c58"], roof: ["#3f3a35", "#4a4038", "#56503f"], trim: ["#eee8da", "#2c2015"], timber: ["#5a4430", "#4b3826"],
    stone: ["#7d766a", "#6a645a"], door: ["#3a2c1e", "#5a2e24"], shutter: ["#5a2e24", "#3a4a5a"], glass: ["#233036"], metal: ["#2a2a2a"], accent: ["#c9a14a"], light: ["#ffb85c"],
  }, {
    walls: { kind: "log", thickness: .42, plinth: { type: "stones", height: .45, kind: "stone" }, corners: "logs", cladding: "logs" },
    roof: { box: "gable", pitch: 40 * DEG, cover: "shingles", kind: "shingles", tile: [.3, .22], thickness: .2, overhang: .5, ridge: "board", bargeboard: true, chimney: .5, chimneyKind: "stone" },
    openings: { window: { w: .75, h: .95, frame: "trim", sillType: "timber", mullions: "cross", shutters: .45 }, door: { frame: "timber" } },
    supports: "timber", boundary: { thickness: .4, height: 2.2, cap: "palisade", kind: "log" }, detail: .8,
  }),
  style("castle", "Castle", "realistic", "Massive ashlar walls, battlements on every roof and wall, arrow slits and round gate arches.", {
    wall: ["#a59e90", "#9a9385", "#b0a999"], roof: ["#4d5156", "#595d61"], trim: ["#8f887a"], timber: ["#4a3828"],
    stone: ["#b7b0a1", "#a8a192"], door: ["#4a3624", "#3b2b1c"], shutter: ["#4a3624"], glass: ["#1f2528"], metal: ["#2b2b2b"], accent: ["#8e2f2f", "#2f4e8e"], light: ["#ffb454"],
  }, {
    walls: { kind: "stone", thickness: .9, storey: 3.4, plinth: { type: "band", height: .8, kind: "stone" }, corners: "quoins", crown: "none" },
    roof: { box: "flat", round: "flat", pitch: 50 * DEG, cover: "slate", kind: "slate", flatEdge: "battlements", flatKind: "stone", chimney: 0, finial: "spike", overhang: .25 },
    openings: { window: { w: .28, h: 1.3, layout: "slit", frame: "stone", sillType: "none", mullions: "none" }, door: { w: 1.8, h: 2.8, head: "round", frame: "stone", leaf: "planks", step: false } },
    supports: "stone", boundary: { thickness: 1.4, height: 4.5, cap: "battlements", kind: "stone" }, path: { kind: "cobble" }, detail: .9,
  }),
  style("gothic", "Gothic", "realistic", "Pale limestone with buttresses, steep slate roofs, tall pointed-arch windows and spires.", {
    wall: ["#d2cbbb", "#c7c0b0", "#dcd5c6"], roof: ["#454b52", "#3c4248"], trim: ["#bdb5a3"], timber: ["#3f3024"],
    stone: ["#bfb7a5", "#d8d0bf"], door: ["#4a2f22", "#3a2418"], shutter: ["#3a2418"], glass: ["#2c3b52", "#4a2e44"], metal: ["#2e3236"], accent: ["#7a1f2e"], light: ["#ffcc80"],
  }, {
    walls: { kind: "stone", thickness: .7, storey: 4, plinth: { type: "band", height: .6, kind: "stone" }, corners: "buttress", crown: "cornice" },
    roof: { box: "gable", round: "cone", pitch: 60 * DEG, cover: "slate", kind: "slate", tile: [.26, .22], thickness: .2, overhang: .2, ridge: "board", chimney: 0, finial: "spike" },
    openings: { window: { w: 1, h: 2.3, sill: 1.2, spacing: 2.6, head: "pointed", frame: "stone", sillType: "stone", mullions: "vertical" }, door: { w: 1.6, h: 3, head: "pointed", frame: "stone", leaf: "planks" } },
    boundary: { thickness: .7, height: 2.5, cap: "coping", kind: "stone" }, detail: .85,
  }),
  style("victorian-brick", "Victorian Brick", "realistic", "Red brick with stone quoins and string courses, slate roofs, tall sash windows and chimneys.", {
    wall: ["#9a4e3a", "#8c4533", "#a65a42"], roof: ["#4a5058", "#555b62"], trim: ["#f1ede4", "#2f3a33"], timber: ["#4a3a2a"],
    stone: ["#dcd3bf", "#cfc6b1"], door: ["#233c2e", "#2a2f4a", "#6a1f22"], shutter: ["#233c2e"], glass: ["#26343c"], metal: ["#222222"], accent: ["#d9b44a"], light: ["#ffd08a"],
  }, {
    walls: { kind: "brick", thickness: .4, storey: 3.2, plinth: { type: "band", height: .5, kind: "stone" }, corners: "quoins", crown: "cornice", band: "string" },
    roof: { box: "gable", pitch: 45 * DEG, cover: "slate", kind: "slate", tile: [.3, .24], thickness: .18, overhang: .35, ridge: "tiles", bargeboard: true, chimney: .9, chimneyKind: "brick" },
    openings: { window: { w: .95, h: 1.7, head: "segment", frame: "trim", sillType: "stone", lintel: "stone", mullions: "sash" }, door: { h: 2.4, head: "flat", frame: "trim", leaf: "panel", canopy: .5 } },
    boundary: { thickness: .35, height: 1.2, cap: "coping", kind: "brick" }, detail: .85,
  }),
  style("japanese", "Japanese", "realistic", "White plaster between dark posts, heavy tiled hip roofs with deep eaves and paper screen windows.", {
    wall: ["#efe9dc", "#e8e1d0"], roof: ["#474a4d", "#3d4043"], trim: ["#2e2620"], timber: ["#3b2e24", "#4a3a2c"],
    stone: ["#8d8a80", "#7d7a70"], door: ["#3b2e24"], shutter: ["#3b2e24"], glass: ["#efe4c8"], metal: ["#2a2a2a"], accent: ["#b5302c"], light: ["#ffcf85"],
  }, {
    walls: { kind: "plaster", thickness: .3, plinth: { type: "band", height: .5, kind: "stone" }, corners: "posts", crown: "beam", framing: { spacing: 1.8, braces: false } },
    roof: { box: "hip", round: "cone", pitch: 30 * DEG, cover: "barrel", kind: "tiles", tile: [.28, .34], thickness: .3, overhang: 1, ridge: "board", chimney: 0, finial: "ball", bell: .5 },
    openings: { window: { w: 1.5, h: 1.3, spacing: 2.6, frame: "timber", sillType: "timber", mullions: "grid", glass: "paper" }, door: { w: 1.6, frame: "timber", leaf: "panel", step: true } },
    supports: "timber", boundary: { thickness: .3, height: 1.8, cap: "coping", kind: "plaster" }, path: { kind: "cobble" }, detail: .6,
  }),
  style("desert-adobe", "Desert Adobe", "realistic", "Soft mud-brick walls with rounded parapets, protruding roof beams and small deep windows.", {
    wall: ["#c79a6e", "#bd8f62", "#d0a67a"], roof: ["#b98b5e"], trim: ["#6b4a2e"], timber: ["#6b4a2e", "#5a3e26"],
    stone: ["#b8a07e"], door: ["#4f6f7a", "#6b4a2e"], shutter: ["#4f6f7a"], glass: ["#2a3438"], metal: ["#2a2a2a"], accent: ["#3f8f8a", "#d9573c"], light: ["#ffc070"],
  }, {
    walls: { kind: "adobe", thickness: .6, crown: "vigas" },
    roof: { box: "flat", round: "dome", cover: "flat", kind: "adobe", flatEdge: "parapet", flatKind: "adobe", chimney: 0, overhang: .2 },
    openings: { window: { w: .75, h: .9, frame: "timber", sillType: "none", lintel: "timber", mullions: "none" }, door: { frame: "timber", leaf: "planks" } },
    supports: "timber", boundary: { thickness: .5, height: 1.6, cap: "rounded", kind: "adobe" }, path: { kind: "cobble" }, detail: .6,
  }),
  style("modern", "Modern", "realistic", "White render and concrete, flat roofs with thin copings, ribbon windows and slender pilotis.", {
    wall: ["#f2f2ee", "#e6e5df", "#d9d8d2"], roof: ["#8f8f8a"], trim: ["#3a3a3a"], timber: ["#8a6a4a"],
    stone: ["#b9b8b2"], door: ["#2b2b2b"], shutter: ["#3a3a3a"], glass: ["#34495a"], metal: ["#3b3d40"], accent: ["#e0a040"], light: ["#fff0d0"],
  }, {
    walls: { kind: "concrete", thickness: .3, storey: 3.1, crown: "coping" },
    roof: { box: "flat", round: "flat", cover: "flat", kind: "concrete", flatEdge: "coping", flatKind: "concrete", chimney: 0, overhang: .15 },
    openings: { window: { w: 1, h: 1.4, sill: .8, layout: "ribbon", frame: "metal", frameWidth: .05, sillType: "none", mullions: "vertical" }, door: { frame: "metal", leaf: "glass", step: false } },
    supports: "pilotis", boundary: { thickness: .25, height: 1.1, cap: "coping", kind: "concrete" }, path: { kind: "concrete" }, detail: .45,
  }),
  style("futuristic", "Futuristic", "realistic", "Brushed metal panels, glowing light strips, domes and continuous tinted glazing.", {
    wall: ["#c9ced4", "#b8bec6", "#dfe3e8"], roof: ["#9aa2ab"], trim: ["#e3e7eb"], timber: ["#3a3f46"],
    stone: ["#8d949c"], door: ["#1f2328"], shutter: ["#2b3036"], glass: ["#1e4d5c", "#29486e"], metal: ["#5b636c", "#3b4148"], accent: ["#35e0ff"], light: ["#5ce8ff", "#ff6adf"],
  }, {
    walls: { kind: "metal", thickness: .35, storey: 3.2, crown: "light", band: "light", cladding: "panels" },
    roof: { box: "flat", round: "dome", cover: "metal", kind: "metal", flatEdge: "coping", flatKind: "metal", chimney: 0, overhang: .3, finial: "spike" },
    openings: { window: { w: 1, h: 1.1, sill: 1, layout: "ribbon", frame: "metal", frameWidth: .06, sillType: "none", mullions: "vertical", glass: "tinted" }, door: { frame: "metal", leaf: "glass", step: false } },
    supports: "pilotis", boundary: { thickness: .3, height: 1.2, cap: "coping", kind: "metal" }, path: { kind: "concrete" }, detail: .5,
  }),
  style("industrial", "Industrial", "realistic", "Brick sheds with pilasters, low metal roofs and large gridded steel windows.", {
    wall: ["#8a4b3a", "#7d4434", "#945443"], roof: ["#6f767c", "#5f666c"], trim: ["#3a3d40"], timber: ["#4a3a2a"],
    stone: ["#9a958a"], door: ["#3d4a52", "#5a3a2a"], shutter: ["#3d4a52"], glass: ["#2a3a42"], metal: ["#3a3f44"], accent: ["#d9a13a"], light: ["#ffd9a0"],
  }, {
    walls: { kind: "brick", thickness: .45, storey: 4, plinth: { type: "band", height: .6, kind: "concrete" }, corners: "pilasters", crown: "cornice" },
    roof: { box: "gable", pitch: 20 * DEG, cover: "metal", kind: "metal", thickness: .12, overhang: .3, ridge: "board", chimney: .3, chimneyKind: "brick" },
    openings: { window: { w: 1.8, h: 2.1, sill: 1.1, spacing: 3, head: "segment", frame: "metal", frameWidth: .06, sillType: "stone", mullions: "grid" }, door: { w: 2.2, h: 2.8, frame: "metal", leaf: "panel", step: false } },
    boundary: { thickness: .4, height: 2, cap: "coping", kind: "brick" }, path: { kind: "concrete" }, detail: .85,
  }),
];

const deepFreeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };
export const STYLE_IDS = Object.freeze(STYLES.map(s => s.id));
const STYLE_MAP = new Map(STYLES.map(s => [s.id, deepFreeze(s)]));
export const DEFAULT_STYLE_ID = "tiny-glade";

/** A known style by id; an unrecognised id falls back to `timber-medieval` so a stale or
 * foreign id never leaves a building undecorated. */
export function getStyle(id) {
  return STYLE_MAP.get(id) ?? STYLE_MAP.get("timber-medieval");
}
export function listStyles() { return STYLES.map(s => ({ id: s.id, label: s.label, family: s.family, description: s.description, swatch: [s.palette.wall[0], s.palette.roof[0], s.palette.trim[0]] })); }

const clampNumber = (value, min, max) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : undefined;
const hex = value => typeof value === "string" && /^#[\da-f]{6}$/i.test(value) ? value : undefined;

/** Authorable per-model tweaks over a catalogue style (`model.style.params`). Every key is
 * optional; values are clamped to ranges that keep every combination buildable. */
export const STYLE_PARAMS = Object.freeze({
  detail: { min: 0, max: 1, label: "Surface detail" },
  roofPitch: { min: 10, max: 70, label: "Roof pitch (°)" },
  overhang: { min: 0, max: 1.5, label: "Roof overhang (m)" },
  wallThickness: { min: .15, max: 1.5, label: "Wall thickness (m)" },
  windowDensity: { min: 0, max: 2, label: "Window density" },
  shutters: { min: 0, max: 1, label: "Shutters" },
  flowerBoxes: { min: 0, max: 1, label: "Flower boxes" },
  chimneys: { min: 0, max: 1, label: "Chimneys" },
});
export function normalizeStyleParams(params) {
  if (!params || typeof params !== "object") return undefined;
  const out = {};
  for (const [key, range] of Object.entries(STYLE_PARAMS)) { const v = clampNumber(params[key], range.min, range.max); if (v !== undefined) out[key] = v; }
  for (const key of ["wall", "roof", "trim"]) { const v = hex(params[key]); if (v) out[key] = v; }
  for (const key of ["plinth", "ridge"]) if (typeof params[key] === "boolean") out[key] = params[key];
  if (BOX_ROOFS.includes(params.roofBox)) out.roofBox = params.roofBox;
  if (ROUND_ROOFS.includes(params.roofRound)) out.roofRound = params.roofRound;
  return Object.keys(out).length ? out : undefined;
}

/** The effective style for a model: catalogue record + clamped params. Plain (unfrozen) copy. */
export function resolveStyle(id, params) {
  const s = structuredClone(getStyle(id));
  const p = normalizeStyleParams(params) ?? {};
  if (p.detail !== undefined) s.detail = p.detail;
  if (p.roofPitch !== undefined) s.roof.pitch = p.roofPitch * DEG;
  if (p.overhang !== undefined) s.roof.overhang = p.overhang;
  if (p.wallThickness !== undefined) s.walls.thickness = p.wallThickness;
  if (p.windowDensity !== undefined) s.openings.window.density = p.windowDensity;
  if (p.shutters !== undefined) s.openings.window.shutters = p.shutters;
  if (p.flowerBoxes !== undefined) s.openings.window.flowerBox = p.flowerBoxes;
  if (p.chimneys !== undefined) s.roof.chimney = p.chimneys;
  if (p.plinth === false) s.walls.plinth.type = "none";
  if (p.ridge === false) s.roof.ridge = "none";
  if (p.roofBox) s.roof.box = p.roofBox;
  if (p.roofRound) s.roof.round = p.roofRound;
  for (const key of ["wall", "roof", "trim"]) if (p[key]) s.palette[key] = [p[key]];
  return s;
}

const fold = (seed, n) => { const s = Number.isFinite(seed) ? Math.trunc(seed) : 0; return ((s % n) + n) % n; };
/** `seed`'s fixed palette-combo index for `style` (wraps at the wall palette's length). */
export function paletteIndexFor(style, seed) { return fold(seed, style?.palette?.wall?.length || 1); }
/** The role palette for one combo index: every role reads its own list at `index % length`. */
export function paletteAt(style, index) {
  const out = {};
  for (const role of PALETTE_ROLES) { const list = style?.palette?.[role]?.length ? style.palette[role] : ["#cccccc"]; out[role] = list[fold(index, list.length)]; }
  return out;
}
/** One seeded hex per role (independent picks). */
export function pickPalette(style, rng) {
  const out = {};
  for (const role of PALETTE_ROLES) { const list = style?.palette?.[role]?.length ? style.palette[role] : ["#cccccc"]; out[role] = rng.pick(list); }
  return out;
}

const isHex = value => typeof value === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
const isUnit = value => Number.isFinite(value) && value >= 0 && value <= 1;
const isPositive = value => Number.isFinite(value) && value > 0;

/** Throws with a specific message on the first malformed field; returns true otherwise. */
export function validateStyle(s) {
  const fail = message => { throw new Error(`Invalid architecture style: ${message}`); };
  const oneOf = (value, list, name) => { if (!list.includes(value)) fail(`${name} must be one of ${list.join(", ")} (got ${value})`); };
  if (!s || typeof s !== "object") fail("style must be an object");
  if (typeof s.id !== "string" || !s.id) fail("id must be a non-empty string");
  if (typeof s.label !== "string" || !s.label) fail("label must be a non-empty string");
  oneOf(s.family, ["realistic", "stylized"], "family");
  if (!s.palette || typeof s.palette !== "object") fail("palette must be an object");
  for (const role of PALETTE_ROLES) {
    const list = s.palette[role];
    if (!Array.isArray(list) || !list.length) fail(`palette.${role} must be a non-empty array of hex colors`);
    for (const value of list) if (!isHex(value)) fail(`palette.${role} has an invalid hex color: ${value}`);
  }
  const w = s.walls; if (!w) fail("walls must be an object");
  oneOf(w.kind, SURFACE_KINDS, "walls.kind");
  if (!isPositive(w.thickness)) fail("walls.thickness must be positive");
  if (!isPositive(w.storey)) fail("walls.storey must be positive");
  oneOf(w.plinth?.type, PLINTHS, "walls.plinth.type"); oneOf(w.plinth?.kind, SURFACE_KINDS, "walls.plinth.kind");
  oneOf(w.corners, CORNERS, "walls.corners"); oneOf(w.crown, CROWNS, "walls.crown"); oneOf(w.band, ["none", "string", "light"], "walls.band"); oneOf(w.cladding, CLADDING, "walls.cladding");
  if (w.framing !== null && (!w.framing || !isPositive(w.framing.spacing) || typeof w.framing.braces !== "boolean")) fail("walls.framing must be null or {spacing>0, braces:boolean}");
  const r = s.roof; if (!r) fail("roof must be an object");
  oneOf(r.box, BOX_ROOFS, "roof.box"); oneOf(r.round, ROUND_ROOFS, "roof.round"); oneOf(r.cover, ROOF_COVERS, "roof.cover");
  oneOf(r.kind, SURFACE_KINDS, "roof.kind"); oneOf(r.flatKind, SURFACE_KINDS, "roof.flatKind"); oneOf(r.chimneyKind, SURFACE_KINDS, "roof.chimneyKind");
  oneOf(r.flatEdge, FLAT_EDGES, "roof.flatEdge"); oneOf(r.ridge, RIDGES, "roof.ridge"); oneOf(r.finial, FINIALS, "roof.finial");
  if (!(Number.isFinite(r.pitch) && r.pitch > 0 && r.pitch < Math.PI / 2)) fail("roof.pitch must be radians in (0, PI/2)");
  if (!(Array.isArray(r.tile) && r.tile.length === 2 && r.tile.every(isPositive))) fail("roof.tile must be [width, height] metres");
  if (!isPositive(r.thickness) || !(r.overhang >= 0)) fail("roof.thickness must be positive and roof.overhang non-negative");
  if (!isUnit(r.chimney) || !isUnit(r.bell)) fail("roof.chimney and roof.bell must be in [0,1]");
  const win = s.openings?.window, door = s.openings?.door;
  if (!win || !door) fail("openings.window and openings.door are required");
  for (const key of ["w", "h", "spacing", "frameWidth"]) if (!isPositive(win[key])) fail(`openings.window.${key} must be positive`);
  oneOf(win.layout, LAYOUTS, "openings.window.layout"); oneOf(win.head, HEADS, "openings.window.head"); oneOf(win.frame, FRAMES, "openings.window.frame");
  oneOf(win.sillType, ["stone", "timber", "trim", "none"], "openings.window.sillType"); oneOf(win.lintel, ["stone", "timber", "none"], "openings.window.lintel");
  oneOf(win.mullions, MULLIONS, "openings.window.mullions"); oneOf(win.shutterType, ["plank", "louvre"], "openings.window.shutterType");
  if (!isUnit(win.shutters) || !isUnit(win.flowerBox)) fail("openings.window.shutters/flowerBox must be in [0,1]");
  oneOf(door.head, HEADS, "openings.door.head"); oneOf(door.frame, FRAMES, "openings.door.frame"); oneOf(door.leaf, LEAVES, "openings.door.leaf");
  if (!isUnit(door.canopy)) fail("openings.door.canopy must be in [0,1]");
  oneOf(s.supports, SUPPORTS, "supports");
  oneOf(s.boundary?.cap, BOUNDARY_CAPS, "boundary.cap"); oneOf(s.boundary?.kind, SURFACE_KINDS, "boundary.kind");
  oneOf(s.path?.kind, SURFACE_KINDS, "path.kind");
  if (!isUnit(s.detail)) fail("detail must be a number in [0,1]");
  return true;
}
