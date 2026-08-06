/**
 * Edit Mode for agents: the geometry editor's operators, driven headlessly.
 *
 * ## Why this is a session and not one tool per call
 *
 * Every operator in `src/editor/mesh/` works the way Blender's do — on the
 * mesh's *selection*, which lives on the elements themselves (`face.select`).
 * That is the right model for a modelling tool and it means a stateless
 * "extrude these faces" tool cannot exist without re-describing the selection
 * on every call, in a mesh whose element identity changes the moment you
 * extrude anything.
 *
 * So this mirrors what the panel does: `geometry.beginEdit` decodes the asset
 * into a BMesh once and holds it, selection ops and operators act on that live
 * mesh, and `geometry.commit` writes it back and reloads everything rendering
 * it. Same sequence a person performs (Tab, select, operate, Tab), same code
 * underneath, and a large mesh is decoded once per edit rather than once per
 * operator.
 *
 * ## Selection: prefer describing WHAT you want, not which indices
 *
 * `select` takes indices, but element order is only stable until the next
 * operator rebuilds topology — the same caveat a person never notices because
 * they are clicking on pixels. The `box`, `trait`, `similar` and `linked`
 * actions describe a selection instead, and survive being run after an edit.
 *
 * ## The one thing that must never happen
 *
 * Two BMeshes for one entity. If the Geometry Editor panel is open on the same
 * entity, whichever commits last silently discards the other's work, so
 * `beginEdit` refuses rather than racing it.
 */
import { defineOp } from "../registry.js";
import { engine } from "../../engineInstance.js";
import { vmSingleton } from "../../singleton.js";
import { useGeometryEditStore } from "../../store/geometryEditStore.js";
import { useProjectStore } from "../../store/projectStore.js";

/**
 * The one open edit session, VM-wide for the same reason everything else in
 * this editor is: a second copy of this module would hold a second mesh, and
 * `commit` through one would write a mesh the other's edits never reached.
 */
const session = vmSingleton("geometryEditSession", () => ({
  /** @type {string | null} */ entityId: null,
  /** @type {string | null} */ path: null,
  /** @type {any} */ mesh: null,
  /** @type {"vert"|"edge"|"face"} */ mode: "face",
}));

function requireSession() {
  if (!session.mesh) {
    throw new Error("No geometry edit session is open. Call geometry.beginEdit(entityId) first.");
  }
  return session;
}

const modules = () =>
  Promise.all([
    import("../../mesh/select.js"),
    import("../../mesh/ops/edit.js"),
    import("../../mesh/ops/extrude.js"),
    import("../../mesh/ops/topology.js"),
    import("../../mesh/ops/cleanup.js"),
    import("../../mesh/ops/uv.js"),
    import("../../mesh/ops/primitives.js"),
    import("../../mesh/io.js"),
  ]).then(([select, edit, extrude, topology, cleanup, uv, primitives, io]) => ({
    select,
    edit,
    extrude,
    topology,
    cleanup,
    uv,
    primitives,
    io,
  }));

/**
 * Every operator `geometry.edit` dispatches, with the parameters it reads.
 *
 * A table rather than one op each: 25 tools whose entire difference is which
 * function they call would bury the rest of the API in a client's tool list,
 * and this is the shape the audio and texture editors already expose
 * (`audio.effects` / `texture.effects` + a `process` tool). `geometry.operations`
 * returns this, so the list an agent sees is generated from the dispatcher
 * rather than written twice.
 */
const OPERATIONS = [
  { id: "extrude", needs: "face", params: ["offset"], summary: "Extrude the selected faces as one region, then move them along the region normal by `offset`." },
  { id: "extrudeIndividual", needs: "face", params: ["offset"], summary: "Extrude each selected face along its own normal." },
  { id: "extrudeEdges", needs: "edge", params: ["offset"], summary: "Extrude the selected edges into new faces." },
  { id: "inset", needs: "face", params: ["thickness", "individual"], summary: "Inset the selected faces, creating a border ring." },
  { id: "bevel", needs: "edge", params: ["width", "segments"], summary: "Bevel the selected edges." },
  { id: "subdivide", needs: "face", params: ["cuts"], summary: "Subdivide the selected faces." },
  { id: "loopCut", needs: "edge", params: ["cuts", "slide"], summary: "Ring-cut around the mesh through the first selected edge." },
  { id: "poke", needs: "face", params: ["offset"], summary: "Fan each selected face out from a new centre vertex." },
  { id: "triangulate", needs: "face", params: [], summary: "Triangulate the selected faces." },
  { id: "trisToQuads", needs: "face", params: ["angleLimit"], summary: "Merge adjacent triangles back into quads where the result stays flat enough." },
  { id: "bridge", needs: "edge", params: [], summary: "Bridge two selected edge loops with a new face band." },
  { id: "gridFill", needs: "edge", params: ["span"], summary: "Fill a closed edge loop with a quad grid." },
  { id: "fillHoles", needs: "any", params: ["maxSides"], summary: "Cap every boundary hole in the mesh." },
  { id: "makeFace", needs: "vert", params: [], summary: "Blender's F: make an edge or face from the selected vertices." },
  { id: "dissolve", needs: "any", params: ["kind"], summary: "Dissolve the selection, keeping the surrounding surface — `kind` is verts, edges or faces." },
  { id: "limitedDissolve", needs: "any", params: ["angleLimit", "selectionOnly"], summary: "Dissolve everything flatter than the angle limit — the cheap way to de-densify a flat region." },
  { id: "delete", needs: "any", params: ["kind"], summary: "Delete the selection — `kind` is verts, edges, faces, onlyFaces, onlyEdgesFaces." },
  { id: "deleteLoose", needs: "any", params: [], summary: "Remove vertices and edges attached to no face." },
  { id: "merge", needs: "vert", params: ["kind"], summary: "Merge the selected vertices — `kind` is center, first, last or cursor." },
  { id: "mergeByDistance", needs: "any", params: ["distance", "selectionOnly"], summary: "Weld vertices closer together than `distance`. The standard fix for a mesh that looks split along a seam." },
  { id: "duplicate", needs: "any", params: [], summary: "Duplicate the selection in place; the copy becomes the selection." },
  { id: "smooth", needs: "vert", params: ["factor", "repeat"], summary: "Relax the selected vertices toward their neighbours." },
  { id: "symmetrize", needs: "any", params: ["direction"], summary: "Mirror one half of the mesh onto the other — `direction` is +x, -x, +y, -y, +z or -z." },
  { id: "recalculateNormals", needs: "any", params: ["inside"], summary: "Make face winding consistent. Run this when a surface renders black or inside-out." },
  { id: "flipNormals", needs: "face", params: [], summary: "Flip the selected faces' winding." },
  { id: "shade", needs: "face", params: ["smooth"], summary: "Set smooth or flat shading on the selected faces." },
  { id: "markSharpByAngle", needs: "any", params: ["angle"], summary: "Mark every edge sharper than the angle, for shading." },
  { id: "unwrap", needs: "face", params: ["projection", "axis"], summary: "Generate UVs for the selected faces — `projection` is planar or box." },
];

const operationById = (id) => OPERATIONS.find((op) => op.id === id) ?? null;

// ---- session ---------------------------------------------------------------

defineOp({
  name: "geometry.beginEdit",
  description:
    "Open an entity's mesh for editing, the same thing pressing Tab in the viewport does. Decodes the geometry into an editable polygon mesh and holds it until geometry.commit or geometry.cancel. Everything else in the geometry.* family needs an open session. Returns the mesh's statistics so you know what you are working with.",
  params: {
    entityId: { type: "string", required: true, description: "Entity carrying the Mesh component to edit." },
  },
  async run({ entityId }) {
    if (session.mesh) {
      throw new Error(
        `A geometry edit session is already open on entity "${session.entityId}". Commit or cancel it before starting another.`,
      );
    }
    // Two BMeshes for one entity means whichever saves last silently throws the
    // other's work away. Refusing is the only honest option.
    if (useGeometryEditStore.getState().entityId) {
      throw new Error(
        "The Geometry Editor panel has a mesh open. Ask the user to leave Edit Mode (Tab) before editing geometry through tools.",
      );
    }
    const entity = engine.getEntity(entityId);
    if (!entity) throw new Error(`No entity with id "${entityId}"`);
    if (!entity.getComponent?.("mesh")) throw new Error(`Entity "${entity.name}" has no Mesh component.`);

    const { authoredGeometry, ensureGeometryAsset } = await import("../../geometryEditing.js");
    const geometry = authoredGeometry(entity);
    if (!geometry) throw new Error(`Entity "${entity.name}" has no geometry to edit.`);
    // Blender's make-single-user step: a primitive mesh has no asset behind it,
    // so editing one has to fork it into a `.geom` first or the edit has
    // nowhere to be saved.
    const path = await ensureGeometryAsset(entityId);

    const { io, cleanup } = await modules();
    session.mesh = io.meshFromBufferGeometry(geometry);
    session.entityId = entityId;
    session.path = path;
    session.mode = "face";
    return { entityId, path, mode: session.mode, statistics: cleanup.meshStatistics(session.mesh) };
  },
});

defineOp({
  name: "geometry.status",
  readOnly: true,
  description:
    "The open edit session: which entity and asset, the current selection mode, how much is selected, and the mesh's vertex/edge/face/ngon counts. Returns `open: false` when there is no session.",
  params: {},
  async run() {
    if (!session.mesh) return { open: false };
    const { select, cleanup } = await modules();
    return {
      open: true,
      entityId: session.entityId,
      path: session.path,
      mode: session.mode,
      selected: {
        verts: select.selectionCount(session.mesh, "vert"),
        edges: select.selectionCount(session.mesh, "edge"),
        faces: select.selectionCount(session.mesh, "face"),
      },
      statistics: cleanup.meshStatistics(session.mesh),
    };
  },
});

defineOp({
  name: "geometry.commit",
  description:
    "Write the edited mesh back to its .geom asset and reload everything rendering it, then close the session. This is what makes the edit visible and permanent — a session left uncommitted changes nothing on disk.",
  params: {
    keepOpen: { type: "boolean", default: false, description: "Save but keep editing, for a checkpoint mid-way through." },
  },
  async run({ keepOpen = false }) {
    const { mesh, path, entityId } = requireSession();
    const { io } = await modules();
    const [{ invoke }, { invalidateBlobUrl }, { reloadGeometryUsers }, { disposeOrReleaseGeometry }] = await Promise.all([
      import("@tauri-apps/api/core"),
      import("../../assetLoader.js"),
      import("../../applyTransform.js"),
      import("../../../engine/geometryAsset.js"),
    ]);

    // Update the live mesh first so the viewport is right immediately; the disk
    // write can land afterwards without the edit looking lost in between. Same
    // order the panel's autosave uses.
    const live = engine.getEntity(entityId)?.getComponent?.("mesh")?.mesh;
    if (live) {
      const previous = live.geometry;
      live.geometry = io.bufferGeometryFromMesh(mesh);
      // `previous` may be the shared `.geom` instance other meshes are still
      // rendering — release rather than dispose.
      disposeOrReleaseGeometry(previous);
    }

    await invoke("save_scene", { path, contents: JSON.stringify(io.assetFromMesh(mesh), null, 2) });
    invalidateBlobUrl(path);
    try {
      const { invalidateVirtualGeometryAsset } = await import("../../../modules/virtual-geometry/index.js");
      // The cluster DAG cached for this asset indexes the triangles that were
      // just replaced; drop it, or the mesh renders a LOD cut of the mesh it
      // used to be.
      invalidateVirtualGeometryAsset?.(path);
    } catch {
      // Module not built into this project — nothing cached to drop.
    }
    reloadGeometryUsers(path);
    await useProjectStore.getState().refresh().catch(() => {});

    const result = { path, entityId, saved: true, open: keepOpen };
    if (!keepOpen) {
      session.mesh = null;
      session.entityId = null;
      session.path = null;
    }
    return result;
  },
});

defineOp({
  name: "geometry.cancel",
  description: "Throw the edit session away without saving. The asset on disk and the mesh in the viewport are untouched.",
  params: {},
  run() {
    const had = session.entityId;
    session.mesh = null;
    session.entityId = null;
    session.path = null;
    return { discarded: !!had, entityId: had };
  },
});

// ---- selection --------------------------------------------------------------

defineOp({
  name: "geometry.select",
  description:
    "Change what the operators will act on. Prefer the descriptive actions — `box` (everything inside a local-space bounding box), `trait`, `similar`, `linked` — over `index`: element order is only stable until the next operator rebuilds topology, so indices read before an extrude are meaningless after it.",
  params: {
    mode: { type: "string", enum: ["vert", "edge", "face"], description: "Selection mode. Defaults to the session's current one." },
    action: {
      type: "string",
      required: true,
      enum: ["all", "none", "invert", "grow", "shrink", "linked", "index", "box", "trait", "similar", "random"],
      description: "How to choose. 'linked' extends to whole connected islands from what is already selected.",
    },
    indices: { type: "array", description: "For action 'index': positions in the current element order.", items: { type: "number" } },
    min: { type: "array", description: "For action 'box': [x,y,z] lower corner, in the mesh's local space.", items: { type: "number" } },
    max: { type: "array", description: "For action 'box': [x,y,z] upper corner, in the mesh's local space.", items: { type: "number" } },
    trait: {
      type: "string",
      enum: ["nonManifold", "loose", "interior", "boundary", "sharp", "sides", "ungrouped"],
      description: "For action 'trait'.",
    },
    similar: { type: "string", description: "For action 'similar': normal, area, sides, material, length, direction… (depends on mode)." },
    threshold: { type: "number", default: 0.01, description: "Tolerance for 'similar'." },
    ratio: { type: "number", default: 0.5, description: "Fraction to keep, for 'random'." },
    add: { type: "boolean", default: false, description: "Extend the current selection instead of replacing it." },
  },
  async run({ mode, action, indices, min, max, trait, similar, threshold = 0.01, ratio = 0.5, add = false }) {
    const state = requireSession();
    const { select } = await modules();
    const mesh = state.mesh;
    if (mode) state.mode = mode;
    const kind = state.mode;

    if (!add && !["grow", "shrink", "linked", "invert", "none"].includes(action)) select.clearSelection(mesh);

    switch (action) {
      case "all":
        select.selectAll(mesh, kind);
        break;
      case "none":
        select.clearSelection(mesh);
        break;
      case "invert":
        select.invertSelection(mesh, kind);
        break;
      case "grow":
        select.growSelection(mesh, kind);
        break;
      case "shrink":
        select.shrinkSelection(mesh, kind);
        break;
      case "linked": {
        for (const seed of select.selected(mesh, kind)) {
          for (const element of select.linkedElements(mesh, seed, kind)) element.select = true;
        }
        select.flushSelection(mesh, kind);
        break;
      }
      case "index": {
        const list = [...select.elementsOf(mesh, kind)];
        for (const index of indices ?? []) {
          const element = list[index];
          if (element) element.select = true;
        }
        select.flushSelection(mesh, kind);
        break;
      }
      case "box": {
        if (!min || !max) throw new Error("geometry.select: action 'box' needs both `min` and `max`.");
        const inside = (p) =>
          p[0] >= min[0] && p[0] <= max[0] && p[1] >= min[1] && p[1] <= max[1] && p[2] >= min[2] && p[2] <= max[2];
        // Centres, not "every vertex inside": selecting a face means selecting
        // the thing that is in the box, and a face straddling the boundary is
        // in it or not by where it sits, which is what a person dragging a box
        // over a viewport gets.
        for (const element of select.elementsOf(mesh, kind)) {
          if (element.hide) continue;
          const point = centreOf(element, kind);
          if (point && inside(point)) element.select = true;
        }
        select.flushSelection(mesh, kind);
        break;
      }
      case "trait":
        if (!trait) throw new Error("geometry.select: action 'trait' needs `trait`.");
        select.selectByTrait(mesh, kind, trait, { angle: threshold > 1 ? threshold : undefined });
        break;
      case "similar":
        if (!similar) {
          throw new Error(
            `geometry.select: action 'similar' needs \`similar\`. For ${kind}s: ${select.SIMILAR_TYPES[kind].map((t) => t.id).join(", ")}`,
          );
        }
        select.selectSimilar(mesh, kind, similar, threshold);
        break;
      case "random":
        select.selectRandom(mesh, kind, ratio);
        break;
      default:
        throw new Error(`geometry.select: unknown action "${action}"`);
    }

    return {
      mode: kind,
      selected: {
        verts: select.selectionCount(mesh, "vert"),
        edges: select.selectionCount(mesh, "edge"),
        faces: select.selectionCount(mesh, "face"),
      },
    };
  },
});

/** Local-space centre of a vert, edge or face. */
function centreOf(element, kind) {
  if (kind === "vert") return element.co;
  if (kind === "edge") {
    const a = element.v1?.co ?? element.verts?.[0]?.co;
    const b = element.v2?.co ?? element.verts?.[1]?.co;
    if (!a || !b) return null;
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  }
  const loops = element.loops ?? [];
  if (!loops.length) return null;
  const sum = [0, 0, 0];
  for (const loop of loops) {
    sum[0] += loop.v.co[0];
    sum[1] += loop.v.co[1];
    sum[2] += loop.v.co[2];
  }
  return [sum[0] / loops.length, sum[1] / loops.length, sum[2] / loops.length];
}

// ---- operators ---------------------------------------------------------------

defineOp({
  name: "geometry.operations",
  readOnly: true,
  description:
    "Every operator geometry.edit can run, what each one needs selected, and the parameters it reads. Generated from the dispatcher, so it cannot drift from what is actually implemented.",
  params: {},
  run() {
    return OPERATIONS.map((op) => ({ id: op.id, requires: op.needs, params: op.params, summary: op.summary }));
  },
});

defineOp({
  name: "geometry.edit",
  description:
    "Run one modelling operator from geometry.operations on the current selection. Requires an open session; call geometry.select first, because an operator with nothing selected does nothing and reports so rather than guessing at what you meant.",
  params: {
    operation: { type: "string", required: true, description: "An id from geometry.operations, e.g. 'extrude', 'bevel', 'subdivide'." },
    params: { type: "object", description: "Operator parameters — see geometry.operations for which ones it reads." },
  },
  async run({ operation, params = {} }) {
    const state = requireSession();
    const spec = operationById(operation);
    if (!spec) {
      throw new Error(`Unknown operation "${operation}". Available: ${OPERATIONS.map((op) => op.id).join(", ")}`);
    }
    const m = await modules();
    const mesh = state.mesh;
    const before = m.cleanup.meshStatistics(mesh);

    if (spec.needs !== "any" && m.select.selectionCount(mesh, spec.needs) === 0) {
      throw new Error(
        `"${operation}" works on selected ${spec.needs}s and nothing is selected. Run geometry.select with mode "${spec.needs}" first.`,
      );
    }

    await applyOperation(m, mesh, operation, params, state);

    const after = m.cleanup.meshStatistics(mesh);
    return { operation, before, after, changed: JSON.stringify(before) !== JSON.stringify(after) };
  },
});

/**
 * Runs an operator, then applies the amount.
 *
 * The operators build topology and stop there, because in the panel the amount
 * is a modal drag — you extrude and then move the mouse. An agent has no mouse,
 * so the amount is a parameter, and each operator hands back exactly what is
 * needed to apply one: extrude returns the new verts and the region normal,
 * inset returns per-vertex offset directions and the thickness at which the cap
 * would collapse. Using those is what makes `{extrude, offset: 0.4}` mean the
 * same thing as extruding and dragging 0.4.
 */
async function applyOperation(m, mesh, operation, p, state) {
  const faces = () => m.select.selected(mesh, "face");
  const edges = () => m.select.selected(mesh, "edge");
  const verts = () => m.select.selected(mesh, "vert");
  const fail = (result) => {
    if (result?.error) throw new Error(result.error);
    return result;
  };
  /** Moves an operator's new verts along one shared direction. */
  const moveAlong = (result, direction, distance) => {
    if (!distance || !result?.verts) return;
    for (const vert of result.verts) {
      vert.co[0] += direction[0] * distance;
      vert.co[1] += direction[1] * distance;
      vert.co[2] += direction[2] * distance;
    }
  };

  switch (operation) {
    case "extrude": {
      const result = fail(m.extrude.extrudeFaceRegion(mesh, faces()));
      moveAlong(result, result.normal, p.offset ?? 0);
      return;
    }
    case "extrudeIndividual": {
      fail(m.extrude.extrudeFacesIndividual(mesh, faces()));
      // Each face went its own way, so there is no single direction — move each
      // new vertex along its own normal, which is what Blender's I-then-drag
      // does for an individual extrude.
      const offsets = m.extrude.shrinkFattenOffsets(mesh, "face");
      for (const [vert, normal] of offsets) {
        vert.co[0] += normal[0] * (p.offset ?? 0);
        vert.co[1] += normal[1] * (p.offset ?? 0);
        vert.co[2] += normal[2] * (p.offset ?? 0);
      }
      return;
    }
    case "extrudeEdges": {
      const result = fail(m.extrude.extrudeEdges(mesh, edges()));
      moveAlong(result, result.normal ?? [0, 1, 0], p.offset ?? 0);
      return;
    }
    case "inset": {
      const result = fail(m.extrude.insetFaces(mesh, faces(), { individual: !!p.individual }));
      // Thickness travels along each vertex's own inward direction, clamped
      // short of the point where the cap collapses to nothing.
      const wanted = p.thickness ?? 0;
      const limit = result.maxThickness || Infinity;
      const thickness = Math.min(wanted, limit);
      for (const [vert, direction] of result.perVertexOffsets ?? []) {
        vert.co[0] += direction[0] * thickness;
        vert.co[1] += direction[1] * thickness;
        vert.co[2] += direction[2] * thickness;
      }
      return;
    }
    case "bevel":
      m.topology.bevelEdges(mesh, edges(), { width: p.width ?? 0.1, segments: p.segments ?? 1 });
      return;
    case "subdivide":
      m.topology.subdivideFaces(mesh, faces(), p.cuts ?? 1);
      return;
    case "loopCut":
      fail(m.topology.loopCut(mesh, edges()[0], { cuts: p.cuts ?? 1, slide: p.slide ?? 0 }));
      return;
    case "poke":
      m.cleanup.pokeFaces(mesh, faces(), { offset: p.offset ?? 0 });
      return;
    case "triangulate":
      m.cleanup.triangulateFaces(mesh, faces());
      return;
    case "trisToQuads":
      m.cleanup.trisToQuads(mesh, { faces: faces(), ...(p.angleLimit ? { angleLimit: p.angleLimit } : {}) });
      return;
    case "bridge":
      fail(m.cleanup.bridgeEdgeLoops(mesh, edges()));
      return;
    case "gridFill":
      fail(m.cleanup.gridFill(mesh, edges(), { span: p.span ?? null }));
      return;
    case "fillHoles":
      m.cleanup.fillHoles(mesh, { maxSides: p.maxSides ?? 64 });
      return;
    case "makeFace":
      fail(m.edit.makeEdgeFace(mesh, state.mode));
      return;
    case "dissolve": {
      const kind = p.kind ?? "faces";
      if (kind === "verts") m.edit.dissolveVerts(mesh);
      else if (kind === "edges") m.edit.dissolveEdges(mesh);
      else m.edit.dissolveFaces(mesh);
      return;
    }
    case "limitedDissolve":
      m.edit.limitedDissolve(mesh, {
        angleLimit: p.angleLimit ?? (5 * Math.PI) / 180,
        selectionOnly: p.selectionOnly !== false,
      });
      return;
    case "delete":
      m.edit.deleteSelection(mesh, state.mode, p.kind ?? "verts");
      return;
    case "deleteLoose":
      m.edit.deleteLoose(mesh, { verts: true, edges: true, faces: false });
      return;
    case "merge":
      fail(m.edit.mergeSelection(mesh, state.mode, p.kind ?? "center"));
      return;
    case "mergeByDistance":
      m.edit.mergeByDistance(mesh, p.distance ?? 0.0001, { selectionOnly: p.selectionOnly !== false });
      return;
    case "duplicate":
      fail(m.edit.duplicateSelection(mesh, state.mode));
      return;
    case "smooth":
      m.cleanup.smoothVerts(mesh, verts(), { factor: p.factor ?? 0.5, repeat: p.repeat ?? 1 });
      return;
    case "symmetrize":
      m.cleanup.symmetrize(mesh, p.direction ?? "+x");
      return;
    case "recalculateNormals":
      m.cleanup.recalculateNormals(mesh, { inside: !!p.inside });
      return;
    case "flipNormals":
      m.cleanup.flipNormals(mesh, faces());
      return;
    case "shade":
      m.cleanup.setShading(mesh, p.smooth !== false, faces());
      return;
    case "markSharpByAngle":
      m.cleanup.markSharpByAngle(mesh, p.angle ?? Math.PI / 6);
      return;
    case "unwrap":
      if ((p.projection ?? "planar") === "box") m.uv.unwrapBox(mesh, faces());
      else m.uv.unwrapPlanar(mesh, p.axis ?? "z", faces());
      return;
    default:
      throw new Error(`geometry.edit: "${operation}" is listed but not dispatched — this is a bug in ops/geometry.js`);
  }
}

defineOp({
  name: "geometry.transform",
  description:
    "Move, rotate or scale the current selection, in the mesh's local space. Rotation is in degrees around the pivot; the pivot defaults to the selection's median, which is what the viewport's transform gizmo uses.",
  params: {
    translate: { type: "array", description: "[x,y,z] offset.", items: { type: "number" } },
    rotate: { type: "array", description: "[x,y,z] degrees.", items: { type: "number" } },
    scale: { type: "array", description: "[x,y,z] multipliers.", items: { type: "number" } },
    pivot: { type: "array", description: "[x,y,z] to transform around. Defaults to the selection's median.", items: { type: "number" } },
  },
  async run({ translate, rotate, scale, pivot }) {
    const state = requireSession();
    const { select } = await modules();
    const mesh = state.mesh;
    // Vertices are what actually move, whatever the selection mode is — an edge
    // or face selection is a selection of its vertices for this purpose, which
    // `flushSelection` has already made true.
    const moving = select.selected(mesh, "vert");
    if (!moving.length) throw new Error("Nothing is selected to transform.");

    const centre = pivot ?? median(moving);
    const rad = (rotate ?? [0, 0, 0]).map((deg) => (deg * Math.PI) / 180);
    const s = scale ?? [1, 1, 1];
    const t = translate ?? [0, 0, 0];

    for (const vert of moving) {
      let [x, y, z] = [vert.co[0] - centre[0], vert.co[1] - centre[1], vert.co[2] - centre[2]];
      x *= s[0];
      y *= s[1];
      z *= s[2];
      // XYZ order, matching the Inspector's Euler fields.
      if (rad[0]) [y, z] = [y * Math.cos(rad[0]) - z * Math.sin(rad[0]), y * Math.sin(rad[0]) + z * Math.cos(rad[0])];
      if (rad[1]) [x, z] = [x * Math.cos(rad[1]) + z * Math.sin(rad[1]), -x * Math.sin(rad[1]) + z * Math.cos(rad[1])];
      if (rad[2]) [x, y] = [x * Math.cos(rad[2]) - y * Math.sin(rad[2]), x * Math.sin(rad[2]) + y * Math.cos(rad[2])];
      vert.co[0] = centre[0] + x + t[0];
      vert.co[1] = centre[1] + y + t[1];
      vert.co[2] = centre[2] + z + t[2];
    }
    return { moved: moving.length, pivot: centre };
  },
});

function median(verts) {
  const sum = [0, 0, 0];
  for (const vert of verts) {
    sum[0] += vert.co[0];
    sum[1] += vert.co[1];
    sum[2] += vert.co[2];
  }
  return [sum[0] / verts.length, sum[1] / verts.length, sum[2] / verts.length];
}

defineOp({
  name: "geometry.addPrimitive",
  description:
    "Add a primitive into the mesh being edited — Blender's Add menu in Edit Mode. Use this to build a shape out of parts inside one mesh; to create a whole new object instead, use entity.create with a mesh component.",
  params: {
    kind: {
      type: "string",
      required: true,
      enum: ["plane", "cube", "circle", "uvsphere", "icosphere", "cylinder", "cone", "torus", "grid"],
      description: "Which primitive.",
    },
    at: { type: "array", default: [0, 0, 0], description: "[x,y,z] local-space position.", items: { type: "number" } },
    options: {
      type: "object",
      description:
        "Shape parameters, per primitive: `size` (plane, grid, cube), `radius` + `segments` (circle, sphere, cylinder, cone, torus), `depth` (cylinder, cone), `subdivisions` (grid, icosphere), `rings` (uvsphere), `tube` (torus). Omitted values take Blender-like defaults.",
    },
  },
  async run({ kind, at = [0, 0, 0], options = {} }) {
    const state = requireSession();
    const { primitives, cleanup } = await modules();
    const result = primitives.addPrimitive(state.mesh, kind, { at, ...options });
    if (result?.error) throw new Error(result.error);
    return { kind, at, statistics: cleanup.meshStatistics(state.mesh) };
  },
});

defineOp({
  name: "geometry.remesh",
  description:
    "Rebuild the whole surface at an even triangle density (voxel remesh). Destroys the existing topology by design — it is the tool for turning a sculpted or messy mesh into a clean one, not for tidying an edit. Slow on dense meshes.",
  params: {
    voxelSize: { type: "number", description: "World-space voxel edge. Smaller keeps more detail and costs more. Omit for the suggested size." },
    adaptivity: { type: "number", default: 0, description: "0 keeps a uniform grid; higher merges flat regions into larger triangles." },
  },
  async run({ voxelSize, adaptivity = 0 }) {
    const state = requireSession();
    const [{ voxelRemesh, suggestedVoxelSize }, { meshStatistics }] = await Promise.all([
      import("../../mesh/ops/voxelRemesh.js"),
      import("../../mesh/ops/cleanup.js"),
    ]);
    const before = meshStatistics(state.mesh);
    const size = voxelSize ?? suggestedVoxelSize(state.mesh);
    const result = voxelRemesh(state.mesh, { voxelSize: size, adaptivity });
    if (result?.error) throw new Error(result.error);
    // It rebuilds rather than editing in place, so the session has to adopt the
    // new mesh — otherwise commit would write the mesh from before the remesh.
    session.mesh = result.mesh;
    return {
      voxelSize: result.voxelSize,
      before,
      after: meshStatistics(session.mesh),
      // Surface Nets produces a new surface with no relationship to the old
      // parameterisation. Saying so is the difference between an agent
      // re-unwrapping and an agent shipping an untextured model.
      uvsLost: true,
    };
  },
});
