import { defineOp } from "../registry.js";
import { ARCHITECTURE_PRESETS, normalizeArchitectureSettings } from "../../../modules/architecture/blueprints.js";

const settingsParam = {
  type: "object", description: "Architecture settings. Choose a preset from architecture.presets; override dimensions, footprint, roof, connections, city layout, freeform pieces, materials, terrainFit, terrainId, avoidWater, waterClearance, clearFoliage, foliagePadding and collision.",
};
const entityParam = { type: "string", required: true, description: "Architecture entity or assembly ID." };
const placementParams = {
  position: { type: "array", description: "World position [x, y, z] in metres." },
  rotationY: { type: "number", description: "World yaw in radians." },
  rotation: { type: "array", description: "World Euler rotation [x, y, z] in radians; overrides rotationY." },
  parentId: { type: "string", description: "Optional parent entity. Placement remains in world space." },
  name: { type: "string", description: "Entity name." },
};
const authoring = () => import("../../architectureBuild.js");
const models = () => import("../../architectureModelBuild.js");

for (const [name, method, id, description, edit] of [
  ["updatePath", "updateArchitecturePath", "pathId", "Reshape a path and rebuild crossed wall passages.", true],
  ["removePath", "removeArchitecturePath", "pathId", "Remove a path and close its automatically generated passages.", false],
  ["updateModelOpening", "updateArchitectureOpening", "openingId", "Move or resize an anchored facade aperture.", true],
  ["removeModelOpening", "removeArchitectureOpening", "openingId", "Remove an authored facade aperture and rebuild the wall.", false],
]) defineOp({
  name: `architecture.${name}`, undoable: true, description,
  params: { entityId: entityParam, [id]: { type: "string", required: true }, ...(edit ? { patch: { type: "object", required: true } } : {}) },
  async run(options) { return (await models())[method](options.entityId, options[id], options.patch); },
});

defineOp({
  name: "architecture.sculpt", description: "Activate direct building, tower, freehand wall, grow, reshape, path, window, door, paint or erase gestures in the viewport. Tool none releases the canvas.",
  params: { tool: { type: "string", default: "build" }, entityId: { type: "string" }, height: { type: "number" }, color: { type: "string" }, roof: { type: "string" } },
  async run(options) {
    const gestures = await import("../../architectureSculptTool.js");
    if (options.tool === "none") { gestures.disarmArchitectureSculpt(); return gestures.getArchitectureSculptState(); }
    return gestures.armArchitectureSculpt(options);
  },
});

defineOp({
  name: "architecture.createModel", undoable: true, description: "Create a reactive building composition. Connected forms generate their exterior walls, roofs, supports and openings automatically.",
  params: { ...placementParams, model: { type: "object", description: "Persistent forms, paths and openings model." }, collision: { type: "boolean", default: true }, followTerrain: { type: "boolean", default: true, description: "Follow terrain sculpting while keeping connected buildings level." }, terrainId: { type: "string", description: "Optional terrain entity; otherwise resolve beneath each building." } },
  async run(options) { return (await models()).createArchitectureModel(options); },
});
defineOp({
  name: "architecture.setModel", undoable: true, description: "Replace a reactive composition in one undoable edit and regenerate its connected surfaces.",
  params: { entityId: entityParam, model: { type: "object", required: true } },
  async run({ entityId, model }) { return (await models()).setArchitectureModel(entityId, model); },
});
defineOp({
  name: "architecture.addForm", undoable: true, description: "Add a connected building volume. Omit entityId to create a new composition and first form in one undo entry.",
  params: { entityId: { type: "string" }, form: { type: "object", required: true, description: "shape box/round, base position [x,y,z], size [w,h,d], rotationY, color, roof hip/flat/none, roofHeight, windows. All form coordinates are local to the composition." } },
  async run({ entityId, form }) { return (await models()).addArchitectureForm(entityId, form); },
});
defineOp({
  name: "architecture.updateForm", undoable: true, description: "Reshape a live building form and adapt its neighbours.",
  params: { entityId: entityParam, formId: { type: "string", required: true }, patch: { type: "object", required: true } },
  async run({ entityId, formId, patch }) { return (await models()).updateArchitectureForm(entityId, formId, patch); },
});
defineOp({
  name: "architecture.removeForm", undoable: true, description: "Remove a form and expose/rebuild connected surfaces in one undoable action.",
  params: { entityId: entityParam, formId: { type: "string", required: true } },
  async run({ entityId, formId }) { return (await models()).removeArchitectureForm(entityId, formId); },
});
defineOp({
  name: "architecture.addPath", undoable: true, description: "Draw a path through the composition, generating passages where it crosses building walls.",
  params: { entityId: entityParam, path: { type: "object", required: true } },
  async run({ entityId, path }) { return (await models()).addArchitecturePath(entityId, path); },
});
defineOp({
  name: "architecture.addModelOpening", undoable: true, description: "Cut a window, doorway or arch at a building surface anchor.",
  params: { entityId: entityParam, opening: { type: "object", required: true } },
  async run({ entityId, opening }) { return (await models()).addArchitectureOpening(entityId, opening); },
});

defineOp({
  name: "architecture.styles", readOnly: true,
  description: "The building style catalogue (tiny-glade, townscaper, timber-medieval, castle, gothic, japanese, modern, futuristic...) with each style's tunable params. A composition's model.style = { id, seed, params } decides walls, roofs, openings and every detail; forms with roof 'auto' take the style's roof shape and pitch.",
  params: {},
  async run() {
    const { listStyles, STYLE_PARAMS } = await import("../../../modules/architecture/styles/catalog.js");
    return { styles: listStyles(), params: structuredClone(STYLE_PARAMS), colorParams: ["wall", "roof", "trim"], booleanParams: ["plinth", "ridge"], formRoofs: ["auto", "gable", "hip", "shed", "flat", "none", "dome"], openingHeads: ["auto", "flat", "round", "pointed", "segment"] };
  },
});
defineOp({
  name: "architecture.setStyle", undoable: true,
  description: "Restyle a composition in one undoable edit. Omit id to keep the current style; params merge over existing params (null removes a key); style id '' removes the style (plain massing).",
  params: { entityId: entityParam, id: { type: "string" }, seed: { type: "number" }, params: { type: "object" } },
  async run({ entityId, id, seed, params }) {
    const { engine } = await import("../../engineInstance.js");
    const model = structuredClone(engine.getEntity(entityId)?.getComponent("architecture")?.props.model);
    if (!model) throw new Error("Select a live Architecture model to restyle.");
    if (id === "") { delete model.style; return (await models()).setArchitectureModel(entityId, model, "Clear architecture style"); }
    const style = { ...(model.style ?? { id: "tiny-glade", seed: 1 }) };
    if (id) style.id = id;
    if (Number.isFinite(seed)) style.seed = seed;
    if (params) { style.params = { ...(style.params ?? {}) }; for (const [key, value] of Object.entries(params)) { if (value === null) delete style.params[key]; else style.params[key] = value; } }
    model.style = style;
    return (await models()).setArchitectureModel(entityId, model, "Set architecture style");
  },
});
defineOp({
  name: "architecture.presets", readOnly: true,
  description: "Available Architecture generators and editable defaults. Buildings, cities and freeform assemblies share ordinary editable meshes; generated content can be regenerated explicitly.",
  params: {},
  run() { return { presets: structuredClone(ARCHITECTURE_PRESETS), defaults: normalizeArchitectureSettings({}) }; },
});

defineOp({
  name: "architecture.preview", readOnly: true,
  description: "Validate architecture and estimate generated pieces and assembly placement against actual Terrain and Water surfaces without changing the scene.",
  params: { settings: settingsParam, ...placementParams },
  async run({ settings, ...options }) { return (await authoring()).previewArchitecture(settings, options); },
});

defineOp({
  name: "architecture.create", undoable: true,
  description: "Create an editable building, city or arbitrary assembly in one undo step. Uses Architecture pieces with ordinary Mesh materials, shadows, GI and concave colliders when Physics is enabled. Generator settings stay on the root for explicit regeneration.",
  params: { settings: settingsParam, ...placementParams },
  async run({ settings, ...options }) { return (await authoring()).createArchitecture(settings, options); },
});

defineOp({
  name: "architecture.rebuild", undoable: true,
  description: "Explicitly replace the owned generated branch using updated settings. Keeps the Architecture root ID and preserves hand-authored additions, including additions nested in generated assemblies. Edits to generated pieces are replaced; undo restores their exact prior IDs and geometry.",
  params: { entityId: entityParam, settings: settingsParam },
  async run({ entityId, settings }) { return (await authoring()).rebuildArchitecture(entityId, settings); },
});

defineOp({
  name: "architecture.createAssembly", undoable: true,
  description: "Create an empty Architecture assembly at any world position and rotation. Parent arbitrary pieces, imported meshes or other assemblies under it; no storey structure is required.",
  params: placementParams,
  async run(options) { return (await authoring()).createArchitectureAssembly(options); },
});

defineOp({
  name: "architecture.addPiece", undoable: true,
  description: "Add a freeform Architecture piece under any entity: floor (slab), platform, wall, column, stair, ramp or box. Props support wall openings, polygon footprint/holes, stair steps, column sides, role and material. All positions are in world space.",
  params: {
    ...placementParams,
    shape: { type: "string", default: "box", description: "floor | platform | wall | column | stair | ramp | box" },
    size: { type: "array", description: "Local dimensions [width, height, depth], all positive metres." },
    props: { type: "object", description: "Shape properties, such as openings, footprint, holes, steps, sides, role and material." },
    collision: { type: "boolean", default: true, description: "Add a concave mesh Collider when Physics is enabled." },
  },
  async run(options) { return (await authoring()).createArchitecturePiece(options); },
});

defineOp({
  name: "architecture.duplicateAssembly", undoable: true,
  description: "Duplicate any architecture assembly or piece, preserving its nested content and assigning stable new IDs. Optional world position moves the whole copy. The copy is hand-authored content, independent of its source generator.",
  params: { entityId: entityParam, name: placementParams.name, position: placementParams.position },
  async run({ entityId, ...options }) { return (await authoring()).duplicateArchitectureAssembly(entityId, options); },
});

defineOp({
  name: "architecture.duplicateFloor", undoable: true,
  description: "Convenience for copying an assembly to another local elevation. Works on any assembly and does not impose floor grouping or building constraints.",
  params: { entityId: entityParam, name: placementParams.name, elevation: { type: "number", description: "Local Y elevation. Defaults to one generator storey-height above the source." } },
  async run({ entityId, ...options }) { return (await authoring()).duplicateArchitectureFloor(entityId, options); },
});

defineOp({
  name: "architecture.materials", undoable: true,
  description: "Apply material asset paths to architecture roles throughout an assembly in one undo step. Keys are piece roles such as wall, floor, roof, foundation, stair and road; default applies to every unmatched role. Generator roots retain the assignments for regeneration.",
  params: { entityId: entityParam, materials: { type: "object", required: true, description: "Map role names to .mat asset paths. Empty paths clear assignments." } },
  async run({ entityId, materials }) { return (await authoring()).applyArchitectureMaterials(entityId, materials); },
});

defineOp({
  name: "architecture.list", readOnly: true,
  description: "List Architecture roots with saved generator settings, generated branch IDs and current piece counts.",
  params: {},
  async run() { return { architectures: (await authoring()).listArchitecture() }; },
});

defineOp({
  name: "architecture.addColliders", undoable: true,
  description: "Add concave colliders to architecture pieces that do not already have collision. Use after enabling Physics on an existing structure. Preserves wall openings, stairs and slab holes.",
  params: { entityId: entityParam },
  async run({ entityId }) { return (await authoring()).addArchitectureColliders(entityId); },
});

defineOp({
  name: "architecture.setTool",
  description: "Hand the user an armed viewport Architecture drawing tool with grid, elevation and dimensions. Drag creates editable pieces under any assembly; no storey grouping is required. Shape none exits drawing without changing the scene.",
  params: {
    shape: { type: "string", default: "wall", description: "wall | floor | column | stair | ramp | box | opening | erase | select | none" },
    parentId: placementParams.parentId,
    elevation: { type: "number", default: 0, description: "World height of the drawing plane, in metres." },
    ...Object.fromEntries(["grid", "height", "thickness", "slabThickness", "stairWidth", "rise", "columnSides"].map((key) => [key, { type: "number", description: `Drawing ${key}, in metres except columnSides.` }])),
    collision: { type: "boolean", default: true, description: "Add concave colliders when Physics is available." },
    material: { type: "string", description: "Material asset for newly drawn pieces." },
    role: { type: "string", description: "Optional custom material role for newly drawn pieces." },
  },
  async run(options) {
    const tool = await import("../../architectureTool.js");
    if (options.shape === "none") { tool.disarmArchitectureTool(); return tool.getArchitectureToolState(); }
    return tool.armArchitectureTool(options);
  },
});
