# Architecture

Architecture is a new optional World module (`architecture`) for freeform structures,
buildings and city layouts. Enable it in Modules and toggle **Architecture** in the
viewport toolbar to open its compact shelf. The scene stays visible and interactive;
settings open in a small flyout within the viewport. The default Build workflow stores a connected model on one `architecture` root;
its derived mesh has no individual wall entities. Optional Parts and Presets use
`architecturepiece` components. There is no required Level → Storey hierarchy. Assemblies can contain pieces,
imported meshes and nested assemblies at arbitrary positions, scales and rotations.

## Authoring

- **Build** is the default shelf mode. Drag a whole building footprint or round
  tower; walls, windows and roof form together. **Grow** adds adjoining volumes
  from wall clicks and stacks from roof clicks; ground drags paint connected cells.
  Shared walls and covered roofs disappear, and removing a form restores newly
  exposed surfaces. **Reshape** exposes handles for width, depth, height, roof pitch,
  base elevation, movement and rotation. Lifting a building adds supports.
  **Wall** draws a continuous freehand wall. **Path** draws a route and cuts
  passages through crossed walls. **Window**, **Door**, **Paint** and **Erase** act
  on the clicked facade or form. Right-click removes a form; Alt or middle-drag
  orbits. Every stroke is one undo entry; Esc cancels an unfinished stroke.
  Heights and placements are continuous and have no required storeys. Roof style,
  tint and an optional defaults flyout complement the direct handles.
- **Parts** provides individual construction elements. Choose a wall, slab, column, stair, ramp or
  box and drag directly in the viewport. The grid can sit at any elevation; height,
  thickness and rise are independent of building storeys. The first unparented
  stroke creates an assembly and its piece in one undo step. Door, Window and Arch
  tools cut the wall you click; Erase removes the piece you click. Tint swatches
  color the next drawn pieces, with optional material assets in the settings flyout.
  Hold Ctrl to bypass snapping or Alt to orbit the camera. Esc finishes drawing and
  leaves the shelf open.
- **Presets** offers house, apartment, tower, warehouse, courtyard, custom footprint,
  pavilion, bridge, fortress and seeded city presets. Choose a preset, move its ghost
  into position and click in the scene to place it. Each click creates another
  independent structure. **R** rotates the next placement by 90°, **Shift+R** rotates
  it back, and **Esc** cancels the ghost. Elevation offsets surface hits, including
  existing roofs for stacking; over empty space it sets the drawing plane height.
  Selecting a preset or moving its preview does not create scene entities or undo
  entries; each placement is one undo step.
- Open **Architecture settings** for dimensions, outlines, façade openings, roof,
  optional connected building levels, interior divisions, materials and city spacing.
  The flyout leaves the viewport available for positioning and camera movement.
  Storeys belong only to recipes that need them. Terrain and water options fit the
  placement preview and the resulting structure to the current scene.
- **Inspect** provides undoable width, height and depth changes for the selection,
  plus a 90-degree rotation, duplication and direct Inspector access. Polygon slabs resize
  their outlines and holes together. Dimensions alter geometry while preserving
  transform scale. Use the ordinary transform
  gizmos and inspector for arbitrary three-axis rotations, scales, materials and
  piece dimensions. Assemblies can collect freely placed pieces and imported models.
- Polygon slabs support concave outlines and real holes. Building outlines include
  rectangle, L shape, courtyard, circle and custom polygons. Doors and windows
  are actual apertures in the wall mesh and collider.
- Select a generated Architecture root to stage changes, **Regenerate**, apply
  materials by role, or create a separate variant. Every create, regenerate,
  duplication and material action is undoable.
- Generated entities are ordinary editable pieces. Regeneration explicitly replaces
  the owned generated branch, including edits to those generated pieces. Separate
  hand-authored additions survive, including additions nested inside generated
  groups; those are moved under the root while preserving their world transforms.
  Undo restores exact IDs, hierarchy, properties and ordering.
- Assemblies can be duplicated and saved through the existing prefab workflow.
  Use the shelf's close button or toggle Architecture again to close the tools.

## Engine integration

**Following terrain edits:** Architecture follows sculpted terrain by default.
Each connected set of forms moves vertically as one building, preserving its
shape, stacked volumes, openings and clearance above the ground. Separate buildings
in a composition or generated city respond independently. The Architecture
Inspector's **Follow sculpted terrain** control can keep a structure at a fixed
elevation; **Terrain surface** chooses an explicit terrain or resolves it beneath
each building. Attachment clearances are saved with the scene.

Live brush updates translate the existing shell once per rendered frame. Finishing
the stroke rebuilds supports and openings and updates collision and GI. Terrain
undo/redo restores the buildings through the same attachment relationship, without
adding separate building edits to history. Buildings retain their authored
orientation and level floors. Paths retain their independently authored elevation.

**Terrain:** optional fitting samples the current terrain at footprint vertices and
across a grid, then seats each structure on the highest sampled elevation. It uses
the actual world transforms; tilted terrain uses a raycast against its mesh. Fitting
happens on create/regenerate; ongoing following handles subsequent sculpting.
Architecture leaves terrain sculpt data untouched. Placement sampling is
bounded and may miss small features between samples; inspect steep ground and
adjust foundations or placement where needed.

**Water:** optional clearance queries the actual enabled water surfaces beneath
sampled footprint positions. It raises the structure above those surfaces by the
configured clearance, including wave height returned by the water component.

**Physics:** connected models use an ordinary indexed Mesh with material groups
and one concave Collider, rebuilt when the model changes. Empty previews and
disabled models do not create collision. Each independent piece uses a normal Mesh and an optional concave Collider. Mesh
auto-collision is disabled so an automatic convex shape cannot fill an entrance
or stairwell. Piece geometry edits mark physics dirty. If Physics was disabled at
creation, `architecture.addColliders` repairs an existing structure in one undo step.

**Foliage:** Clear Foliage filters the original deterministic scatter through a
cached spatial mask of Architecture footprints with configurable padding. Holes
and courtyards remain available for planting. Moving, removing or disabling the
exclusion restores the same original plants, and terrain reseating retains their
source triangles. Tilted structures use projected rendered triangles. This clears
procedural Foliage scatter; separately authored plants and Terrain's model scatter
layers are not deleted. Footprints project downward, so an elevated bridge can
clear the ground beneath it when this option is enabled.

**GI/rendering:** connected shells provide conservative enclosed room samples to
GI probe discovery, and expose form/path footprints to foliage masks. Models and
pieces drive the engine's standard Mesh component, with indexed
geometry, material ownership, shadows, culling and existing merging/instancing
eligibility. Architecture infers enclosed rooms from upright wall geometry and
exposes them to the existing GI reflection-probe discovery. Probe budgets and
WebGPU binding limits are unchanged. Hand-placed probes remain overrides.

## Scripts and editor automation

```js
const composition = await Editor.architecture.createModel({
  name: "Riverside", position: [30, 0, 10],
  model: { forms: [{ id: "hall", shape: "box", position: [0, 0, 0],
    size: [10, 4, 7], roof: "hip", roofHeight: 2, color: "#d5d1c7" }] },
});
await Editor.architecture.addForm(composition.entityId, {
  id: "tower", shape: "round", position: [5, 0, 0], size: [4, 8, 4],
});
await Editor.architecture.sculpt({ entityId: composition.entityId, tool: "reshape" });

// Optional recipe-based assemblies remain available.
const house = await Editor.architecture.create(
  { preset: "house", width: 16, depth: 12, roof: "gable", terrainFit: "highest" },
  { position: [30, 0, 10], name: "Hill house" },
);
await Editor.architecture.rebuild(house.entityId, { storeys: 3 });

const assembly = await Editor.architecture.createAssembly({ name: "Sky bridge", position: [0, 18, 0] });
await Editor.architecture.addPiece({
  parentId: assembly.entityId, shape: "floor", size: [30, .5, 5], position: [0, 18, 0],
});
await Editor.architecture.materials(assembly.entityId, { floor: "Materials/Stone.mat" });
```

`architecture.createModel`, `setModel`, `addForm`, `updateForm`, `removeForm`,
`addPath`, `updatePath`, `removePath`, `addModelOpening`, `updateModelOpening`,
`removeModelOpening` and `sculpt` expose the connected workflow. Root placement is
world-space; form positions, paths and aperture anchors are composition-local.
`updateForm` carries apertures with the form; `setModel` replaces the exact document.

`architecture.presets`, `preview`, `create`, `rebuild`, `createAssembly`, `addPiece`,
`duplicateAssembly`, `duplicateFloor`, `materials`, `addColliders`, `setTool` and `list` are also
registered editor operations for MCP. Positions and rotations are world-space;
dimensions are local metres. XYZ rotation overrides yaw when provided. Parenting
that would require shear is rejected before changing the scene.

The connected geometry generator lives in `src/modules/architecture/formGeometry.js`
with the serializable contract in `formModel.js`. It clips intersecting exterior
faces, derives inner skins and aperture reveals, and batches by material. Local
form caches reuse unchanged surface work. Each composition supports up to 256
forms, 64 paths and 512 authored apertures; larger worlds use multiple compositions.
Form roofs are `hip`, `gable`, `flat` or `none`; `roofAxis` (`"x"`/`"z"`, default
the longer axis) picks the ridge direction and `roofColor` overrides the roof
material tint, so gabled volumes keep plastered end triangles. `shed` and `dome` (round
forms) are also available, and `auto` (the Build/Grow default) takes the roof shape and
pitch from the composition's style, as does `roofHeight: null`. The growth grid is
regular. Irregular Townscaper topology
and Tiny Glade's artwork are not included; see [interaction references](ARCHITECTURE_INTERACTIONS.md).

The recipe generator lives in `src/modules/architecture/blueprints.js`. Recipes emit
serializable ordinary parts; add recipes without adding render systems or creating
another runtime scene format. Generation is deterministic and bounded (up to 8,000
pieces per recipe by default); larger worlds can be composed from multiple roots.
Custom outlines accept up to 64 vertices. These generators provide structural
geometry; detailed ornament and specialist shapes can be added as normal imported
meshes or edited geometry within an assembly.

## Styles

A composition's `model.style = { id, seed, params }` turns massing into a finished building.
The catalogue (`src/modules/architecture/styles/catalog.js`) has 15 styles: Tiny Glade,
Townscaper, Timber Medieval, Stone Cottage, Mediterranean, Frontier, Nordic Log, Castle,
Gothic, Victorian Brick, Japanese, Desert Adobe, Modern, Futuristic and Industrial. A style
decides wall construction (thickness, plinth, corners, cladding, timber framing, storey bands,
crown), roof shape/pitch/overhang/covering, flat-roof edges (parapet, battlements, coping),
window and door design, supports under raised forms and the cap of free-standing walls.
`params` tunes a style without forking it: detail, roof pitch, overhang, wall thickness, window
density, shutters, flower boxes, chimneys, wall/roof/trim colours, plinth and ridge toggles.
Pick a style from the Build shelf (it restyles the selected composition and becomes the default
for new ones) or tune it in the Inspector; MCP exposes `architecture.styles` and
`architecture.setStyle`.

Styled geometry is generated per form by the kit (`src/modules/architecture/kit/`): `wallKit`,
`openingKit` and `roofKit` draw into `kitMesh`, which writes bevelled boxes, extrusions,
cylinders and polygons with a per-vertex tint (palette colour × per-piece shade × ground AO) and
texture-array layer. Roofs are slabs extended past every free eave and verge and mitred at
ridges and hips, covered by individual tiles clipped to each exposed slope, barrel tiles,
layered thatch or standing seams. Every decoration is anchored against the neighbouring solids,
so detail never lands inside another form; openings, supports and wall ends that would meet a
neighbour are dropped. A styled model uses four materials (surface, glass, metal, light)
whatever the style mix; textures are luminance-normalised so the palette carries colour. Each
connected building gets one automatic entrance unless a door is authored. Live gestures build a
draft (no coverings, cladding or small props) and the full kit lands on release, reusing the
per-form cache for untouched forms.

`npm run preview:architecture` renders contact sheets of every style across the harness
scenarios (`scripts/lib/architecturePreviewScenarios.js`) into `artifacts/architecture/preview`
against a Vite server (default `http://127.0.0.1:5351`; pass `http://localhost:5351` if Vite
binds IPv6). Look at them before calling a visual change done; `tests/architecture-kit.test.mjs`
covers catalogue validity, auto roofs, entrances, overhang reach, neighbour intrusion, smooth
round walls and picking coverage.

## Compatibility and validation

`level-design` in saved module lists resolves to the canonical `architecture` module.
Legacy Level, Level Floor and Blockout components remain registered for saved scenes.
The old source API remains available; new authoring creates only Architecture types.

Run `npm run test:architecture` for generation, geometry, lifecycle, terrain/water,
GI-room and foliage-mask checks. `npm run smoke:architecture` exercises the live
editor against a fresh Vite server on `127.0.0.1:5341`: it verifies the compact shelf,
unblocked camera interaction, real drawing and openings, placement ghosts, repeated
stamps, rotation, keyboard undo, inspector regeneration and a narrow viewport.
`npm run smoke:architecture-sculpt` drives real building, facade growth, stacking,
reshape/lift handles, anchored windows, freehand walls and path passages, with
screenshots in `artifacts/architecture-sculpt`. Both scripts require a fresh Vite
server and run sequentially. Shelf regression screenshots are in
`artifacts/architecture-ui`. `npm run test:architecture-terrain` checks exact
foundation sampling, independent building groups, terrain undo and saved
attachments, and real physics after terrain edits. `npm run smoke:architecture-terrain`
drives the Terrain brush and following toggle in the actual editor; screenshots
are written to `artifacts/architecture-terrain`. Run browser checks sequentially.
Existing foliage and blockout regressions remain relevant to their shared geometry
and mesh integration.
