# Level design: blockouts you can walk

Two features, shipped together because neither is much use alone: a greybox
blockout tool, and a character that can walk what it draws.

- **`level-design` module** (`src/modules/level-design/`) — the Level, Level
  Floor and Blockout components, plus the geometry every piece builds itself
  from.
- **The editor tools** (`src/editor/levelTool.js`, `blockoutDraw.js`,
  `blockoutTool.js`, `levelBuild.js`, `components/LevelToolbar.jsx`) — the
  palette, the grid, the drag, and everything that turns a gesture into
  entities.
- **The character rig** (`src/editor/characterRig.js`,
  `templates/characterScripts.js`) — a kinematic controller, a first/third
  person camera, and the two scripts that drive them, written into the
  project's `scripts/` folder as editable source.

Both are optional modules. Level Design is enabled per project in the Modules
panel; the character needs Physics (Rapier) for its collider.

Gated by `npm run test:level` — headless, no GPU, and it ends by actually
walking a character up a blockout staircase and through a doorway.

---

## The model

```
Level                     grid, storey height, default wall/slab dimensions, Preview
└── Floor 0.00m           a storey — its ELEVATION IS ITS TRANSFORM
    ├── Wall              Blockout(shape: "wall")  + Mesh + Collider
    ├── Floor             Blockout(shape: "floor") + Mesh + Collider
    └── Stair             Blockout(shape: "stair") + Mesh + Collider
```

Three decisions carry most of the design:

**One `Blockout` component with a `shape` prop, not seven components.**
Mid-blockout you constantly find that a wall wanted to be a doorway, or that a
floor should have been a platform one step up. With one component that is a
dropdown, and the entity keeps its name, its place in the hierarchy and
whatever else is attached to it. With seven it is delete-and-redraw.

**A storey's elevation is its transform, not a prop.** Raising a floor is
dragging it with the ordinary move gizmo, which carries every wall on it, and
undo/snapping/multi-select all work because nothing new was invented. A prop
would have been a second source of truth the gizmo could silently disagree
with.

**Slabs hang below their origin; everything else stands on it.** A floor
occupies `y ∈ [-thickness, 0]`, so its walkable *surface* is the entity's
position. Put a floor and a wall at the same storey elevation and the wall
stands on the floor with no arithmetic. Getting this backwards is what makes a
blockout tool need a "snap to surface" button.

### The piece draws through the entity's Mesh component

`BlockoutComponent` does not own a mesh — it computes geometry and hands it to
the entity's `mesh` component, adding one if the entity has none. This is the
same arrangement Terrain uses, and the reason is easy to miss: a mesh parented
under the entity but *outside* a Mesh component is invisible to everything that
reasons about scene geometry. `merging.js` collects candidates by
`entity.components.get("mesh")`, so a level of five hundred private meshes
would be five hundred draw calls that same-material merging could not touch;
`OcclusionSystem` skips `engineOwned` objects, so the walls — the best
occluders a level has — would occlude nothing.

Greybox materials are **interned by colour** (`blockoutMaterial.js`) for the
same reason: same-material merging keys on the material *instance*, so ten
thousand yellow walls share one object.

⚠ The piece assigns that material during its own `onAttach`, and MeshComponent
finishes its async material pass **one microtask later** (`#loadExtraMaterials`
awaits an empty `Promise.all` before calling `#applyMaterialSlots`). That reset
every piece to the default white with no `component-changed` to say it had
happened — a level drawn entirely in white, no grid texture, nothing in the
console. A mesh now carries `userData.materialOwner`, and MeshComponent leaves
its material alone while another component holds the claim. Blockout releases it
while previewing (Preview means "show me what the Mesh component says") and on
detach.

### Geometry: boxes, not CSG

`blockoutGeometry.js` emits axis-aligned boxes (plus a wedge for ramps and a
prism for columns) and welds them into one BufferGeometry. A wall with a door
is the three or four boxes around the hole — never a boolean subtraction. No
library, no degenerate triangles, and the result still reads as "the pieces a
builder would stack".

Conventions the rest of the module depends on:

| | |
|---|---|
| Local X | length / width |
| Local Y | height (thickness, for a slab) |
| Local Z | depth; stairs and ramps climb along **+Z** |
| `size` | always `[x, y, z]`, for every shape — which is what lets `shape` change without remapping props |
| UVs | in **metres**, so one 1 m grid texture reads at true scale on every piece |

Ramps are emitted as a real wedge rather than a stack of thin boxes on
purpose: stepped geometry makes Rapier's slope test flicker between "floor"
and "step" as the capsule crosses each seam.

⚠ **Winding.** The wedge and the prism trace their corners CLOCKWISE seen from
outside, so their indices run backwards (`0,2,1` / `0,3,2`) to produce
counter-clockwise — front-facing — triangles. Emitting them `0,1,2` leaves the
shading normals correct and the geometry inside out: the outward faces are
culled, you see the inner surface of the far side, and nothing anywhere reports
a problem. Columns and ramps shipped like that. `test:level` now checks every
triangle of every shape against its own normal, which is the only way this class
of bug is visible without eyes on it.

---

## Drawing

`blockoutDraw.js` is the whole gesture-to-piece solver, and it is pure
arithmetic so the test can drive it without a viewport. One rule: **a drag
draws, a click places** — a click is simply a drag whose two points are equal,
and the shapes that need a direction (wall, stair, ramp) are the ones that
decline to produce anything from one.

| Tool | Gesture |
|---|---|
| Floor / Platform | drag a rectangle; a click fills the grid cell whose corner you clicked |
| Wall | drag corner to corner; the wall's local +X points from A to B |
| Stair | drag the direction of travel; it climbs one storey (Shift+D to descend) |
| Ramp | drag the direction of travel |
| Box | drag a footprint; it stands one wall height tall |
| Column | click to place, drag out to thicken |
| Opening | click a wall to punch a door / window / arch (O cycles) |
| Erase | click a piece |

Keys while the palette is armed: `1`–`8` pick a tool, `U`/`J` move a storey up
and down, `[`/`]` halve and double the grid, **hold Ctrl** to place freely, Esc
disarms.

### Moving the camera while a tool is armed

The left button is OrbitControls' ROTATE, and a drawing tool takes it — which
leaves pan (right-drag) and zoom (wheel) and no way to turn the view at all.
That is unusable the moment you need to see the other side of what you are
building, so there are two escapes, both the ones muscle memory already reaches
for:

| | |
|---|---|
| **Alt + drag** | orbits — the tool declines the press and OrbitControls takes it, as in Unreal/Unity/Maya |
| **Middle-drag** | orbits — remapped from dolly while a tool is armed (the wheel already dollies), restored on disarm |
| Right-drag | pans, unchanged |
| Wheel | zooms, unchanged |

The cursor says which mode the button is in: a crosshair while the tool owns it,
a grab hand while Alt hands it over. The palette carries a muted `alt-drag`
reminder for the same reason — this is the one part of the interaction nobody
guesses.

The palette is deliberately ONE row — the shapes, the two numbers that change
every few minutes (grid, storey), the greybox/materials switch, and a gear for
the rest. The first version stacked three rows and covered a third of the
viewport, which is the wrong trade for a tool whose whole job is to let you look
at what is behind it. The per-tool hints did not disappear; they are the
buttons' tooltips.

The angle-snap rule is worth stating because it looks like a bug otherwise:
snapping the angle applies **only when the grid is off**. With the grid on the
endpoints already quantise the angle, and re-snapping on top of them would pull
the wall off its own corner.

### Where the settings live

Grid, storey height and the default wall/slab dimensions belong to the
**Level**, not to the editor: they are how *this level* is built and must
survive a reload and reach a teammate. `levelTool.js` is a mirror — activating
a level pulls its numbers in, and changing one in the toolbar writes back
through the command bus, so it is undoable and saved.

### Undo / redo

Everything the tool creates goes through `CreateEntityCommand` /
`SetComponentPropCommand`, so **Ctrl+Z / Ctrl+Shift+Z** (the editor's global
chords) work on a level built by dragging exactly as on one built by hand.
Three details make that true rather than nearly true:

- **One gesture is one Ctrl+Z.** The first piece drawn in an empty scene also
  creates a Level and a storey; `createPiece` wraps the lot in
  `commandBus.markGroup()` / `collapseFrom()`, so undo does not leave an empty
  Level behind. Each step is still its own command underneath — a failure
  part-way through leaves a real, undoable prefix.
- **The toolbar follows the stack.** Grid size and storey height live on the
  Level component, so undo puts the old value back on it; `levelTool.js`
  subscribes to `component-changed` and re-pulls them. Without that the palette
  would keep drawing with the value that was just undone. Its number fields also
  commit on blur/Enter rather than per keystroke, so typing 3.25 is one undo
  entry, not four — and they blur on commit, because a focused input owns Ctrl+Z
  (see `keyScope.js`) and would otherwise swallow it.
- **Undo mid-drag cancels the drag.** The tool watches `useHistoryStore`; a
  gesture that survived an undo would place a piece into a storey that no longer
  exists the moment the button came up.

Adding the Blockout component by hand pairs it with the Mesh component it needs
in one `BatchCommand` (`InspectorPanel.addComponentCommands`), so undo takes
back both instead of orphaning the Mesh.

The one thing that is NOT undoable is writing the character scripts — a file on
disk is outside the command bus. The rig entity itself is a single command, and
the script files are reused rather than rewritten, so undo/redo of the rig is
clean either way.

---

## Making it walkable

Each piece gets a sibling `Collider` with `shape: "mesh"` — a trimesh built
from the rendered geometry at play start. Not a box, because a staircase and a
wall with a door are not boxes, and because a trimesh re-derives itself when the
piece is resized, so collision can never drift from the picture.

Two ways a level ends up non-walkable, both repaired by **Add colliders** in the
Level inspector (or `level.addColliders`): it was drawn before the physics
module was enabled, or with the Level's Collision switch off.

---

## The character

`character.create` (or Hierarchy → **+** → Character) builds:

```
Player       CharacterController + Script[CharacterController.ts, CharacterCamera.ts]
├── Body     Model + SkinnedMesh + Animation (a real animated humanoid — see below)
└── Camera    Camera
```

**The origin is at the character's feet.** The controller's capsule is centred
on its `offset`, so the rig lifts it by half its own height. Everything
downstream depends on that: a player is placed on a floor at that floor's
elevation, "Eye Height 1.6" means what it says, and crouching shrinks the
capsule toward the ground rather than lifting the feet through it. The Body
model's own origin is already at its feet in its source file, so — unlike the
capsule primitive it replaced — it needs no vertical offset at all, just a
uniform scale (`(height + 2×radius) / CHARACTER_MODEL_HEIGHT`) and a 180°
yaw correction (the source asset faces +Z; the rig's forward convention,
matching the third-person camera sitting behind the player at +Z, is −Z).

### The default body and its locomotion graph

`character.create` needs its own module, **`character-controller`** —
separate from `level-design`, so a project that only wants one can enable
just that one; a level's blockout geometry and a player's body are unrelated
things. It has no components (the actual movement is
`CharacterControllerComponent`, owned by `physics-rapier`); what it owns is
the default visible body's asset, in `src/modules/character-controller/`
(`characterModel.js` for the `?url` import, `characterModelData.js` for
everything Node can resolve directly — split only because `?url` is Vite-only
syntax the headless tests can't parse — plus `assets/CharacterModel.glb` and
its raw FBX sources under `assets/source/`). `characterRig.js` (the
editor-side rig-creation code — commandBus, prefab instantiation, none of
which a runtime module has business owning) imports from there, same as
before the split.

The visible body is not a placeholder. `character.create` unpacks the vendored
GLB into `<root>/Character/CharacterModel/` the first time a project creates a
Character Controller, and every rig after that reuses the same unpacked copy —
same "existing files are reused" rule the scripts follow. The model is
Mixamo's **Y Bot**, with **Idle / Running / Jumping Up / Jumping Down**
merged onto it — Mixamo always ships a character and its animations as
separate downloads sharing one skeleton, so `scripts/merge-ybot-clips.mjs`
combines the five FBX files (`assets/source/`) into one GLB
(`assets/CharacterModel.glb`) offline, once. The model ships *inside the
editor*, not fetched live: Mixamo's own upload/download flow has been broken
since ~2025-06 (see `characterModelData.js`'s docs for the licensing note too
— Mixamo content is free to use in your own projects, not to redistribute
standalone).

Unpacking runs the *same* pipeline (`unpackGlb`) any GLB import through the
Assets panel would — `.geom`/`.mat` extraction, skinned-mesh + bone entities,
a generated `.anim` — except that generated `.anim` (one state per clip, no
transitions: a starting point for a human, not something a script can drive)
is immediately overwritten with a hand-authored real locomotion graph:

- **"Locomotion"** — a `blend1d` state blending Idle → Running on a `Speed`
  parameter (threshold 4.5, the controller's default Walk Speed). There is
  only one moving clip in this set, so Running plays across the whole
  Walk→Sprint range once `Speed` clears that threshold.
- **"JumpUp" / "JumpDown"** — PAUSE-then-LAND, not a rise/fall pair keyed on
  velocity. That was the first design (a third parameter, `VerticalSpeed` —
  the controller's own `cc.getVelocity()[1]` — split JumpUp/JumpDown on
  vertical speed crossing zero, and both looped so a long flight didn't
  freeze). It produced two bugs in sequence, both reported verbatim: **"it
  falls down in idle after jump"** (a one-shot fall clip shorter than real
  airtime clamps on an ALREADY-LANDED pose while still visibly falling), and
  once "fixed" by looping, **"it repeats jump down animation throughout the
  whole jump"** (a LANDING-impact clip playing on repeat while still
  airborne, because this pack has no "falling" clip and JumpDown was being
  asked to stand in for one). The actual fix drops the velocity split
  entirely: `JumpUp` plays once on leaving the ground and PAUSES on its last
  frame (`loop: false`, held by three's own `clampWhenFinished`) — a launch
  pose that covers the whole flight, rise and fall alike, for however long it
  actually takes. `JumpDown` — the landing IMPACT — is entered only once
  `Grounded` goes back to true, plays through its own fixed ~0.37 s once
  (also `loop: false`, safe now since it's never asked to cover a
  variable-length fall), and blends into Locomotion **on its own**, purely
  from an `exitTime` once its clip finishes — no `Grounded`/`Speed` condition
  needed, since Grounded is already true the instant it's entered. Entering
  JumpUp is scoped `from: "__any__"` rather than `"state-locomotion"`, so a
  jump re-triggered immediately on landing (bunny-hopping) cuts back to JumpUp
  right away instead of waiting for JumpDown's crossfade to finish.

`CharacterController.ts` finds the Animation component on its Body child once
(`findComponents("animation")[0]`) and feeds two parameters every frame from
values it already computes — `this.speed`, `this.grounded` — no `VerticalSpeed`,
no conversion needed. **Retuning Walk/Sprint Speed in the Inspector does not
move the blend threshold** — it's baked into the `.anim` asset, the same
tradeoff any Mecanim-style blend tree makes; open the Animator panel on
`CharacterModel.anim` if you retune those a lot.

`npm run test:level` drives the real `AnimatorRuntime` against the actual
exported graph object with fake clips (`character animator` section) — weights
at rest and at the default speed, the Idle/Running blend sums to 1, leaving the
ground pauses in JumpUp for a full 2 s of simulated flight without ever
auto-playing JumpDown, touching down hands off to JumpDown, JumpDown recovers
to Locomotion on its own once its clip finishes, a landing while still moving
blends into Running rather than Idle, and a re-jump mid-recovery cuts back to
JumpUp immediately — the same shape `run-animation-test.mjs` uses for the
engine's own animator suite. `withMesh: false` skips the body entirely (no
model, no capsule) rather than forcing the capsule; the capsule is *only* the
automatic fallback when the model can't be set up (a broken unpack, no project
on disk), never something a caller asks for by name anymore.

⚠ **Swapping the source model invalidates every project's already-unpacked
copy.** `ensureCharacterModel()` reuses whatever sits at
`<root>/Character/CharacterModel/` if that path already exists — it has no way
to know the vendored GLB changed underneath it. Changing
`assets/CharacterModel.glb` (or its clip names / native height) means deleting
that folder in any project you want to pick up the new one, then creating a
fresh Character Controller (or reusing the existing rig's Body slot) to
re-trigger the unpack.

### Why the controller is scripts, not a component

A player controller is the one part of a game that every project rewrites.
Every game changes the jump curve, adds a dodge, swaps crouch for slide.
Delivering it as a component would make all of that a feature request;
delivering it as ~250 lines of typed, commented source in `scripts/` makes it
an edit. Every field is an `@attribute`, so the whole thing is tunable in the
Inspector *without* opening the code — and the code is there the moment tuning
is not enough.

Existing files are **reused, never overwritten**. Adding a second player must
not discard the edits made for the first.

**`CharacterController.ts`** — walk / sprint / crouch / jump against the
kinematic controller. Exponential (framerate-independent) acceleration, coyote
time, a jump buffer, optional air jumps, and body facing that follows either
the movement direction (third person) or the camera (first person, aiming).

**`CharacterCamera.ts`** — owns yaw and pitch; the controller reads its `yaw`,
which is what keeps "forward" and "where the camera points" the same thing in
both views. First person parks the camera at eye height and lets the body carry
the yaw. Third person is a **rigid orbit**: the camera is on its new arc the
same frame the mouse moves, with a sphere cast that pulls it in when a wall
would come between it and the player, snapping in and easing out (easing in
clips through the wall for a few frames). Sprinting kicks the FOV — and that
write is epsilon-gated: `setProp` fires "hierarchy-changed" (the editor
re-mirrors the whole scene for React off it), so an unguarded per-frame write
here fired that storm for the entire time a script was in Play, worst on the
frames the moving entity was selected. See below.

Nothing about the look is interpolated, and that is the correction that matters:
the first version eased the camera's final *world position* toward its target,
so a flick turned the view instantly while the body slid into frame over the
next tenth of a second — the character swam across the screen on every turn.
Smoothing a camera's orientation and its position by different amounts is what
makes a third-person camera feel wrong. `Follow Damping` now trails only the
**pivot** (the character's shoulder) and defaults to `0`; however high it goes,
turning stays instant, because a mouse is an input and not a mass.
`CharacterCamera.snap()` clears the lag after a teleport, and
`CharacterController.warpTo()` calls it for you.

⚠ **`setProp` from a script is an editor-facing write, not a per-frame one.**
`Component.setProp` fires `"hierarchy-changed"` on every call, and the editor
answers that by re-mirroring every entity in the scene for React — fine for an
occasional change, ruinous for a value written every tick. `applyFov`'s
exponential decay never lands on its target exactly, so an unguarded
`camera.setProp("fov", next)` there fired the storm for the whole of Play at a
hundredth of a degree of real change per call. It read as **"fps drops the
moment we move the character"**, because the cost only became visible once the
moving entity was *selected* — the Inspector then has a full page of fields to
reconcile every frame — but a stationary, unselected character paid the same
storm invisibly. Fixed by skipping the call once `|next - current| < 0.01`,
mirroring the epsilon `CameraComponent` already uses for its own per-frame
`camera.fov` write. Any script tweening a prop every frame needs the same
guard; `npm run test:level` gates it (`FOV settles and STOPS writing`, `FOV
converges during a sprint kick, then goes silent`), and
`scripts/run-character-motion-perf.mjs` reproduces it live (114 → 120 fps,
arm `walk+turn+selected`).

Two small engine additions were needed and are worth knowing about:

- **`InputManager.requestPointerLock()` / `exitPointerLock()` /
  `pointerLocked`** — a first-person camera is the most common thing anyone
  writes against the input API, and it needed all three; reaching for
  `document` from a script loses the type checking the API exists to provide.
- **`CharacterControllerComponent.setCapsule({ height, radius, offset })`** —
  height and radius are structural everywhere else (read once when the world is
  built), but a capsule is the one shape Rapier can resize in place, and a
  character that cannot change height cannot crouch. The offset moves with the
  height so a feet-at-origin rig shrinks toward the floor. Standing back up is
  the caller's problem: the script sphere-casts upward first, so sitting under
  a table keeps you there.

---

## Driving it from an agent

Every gesture has an op (`src/editor/api/ops/level.js`), and each takes either
a drag or explicit numbers:

```js
const { entityId } = await Editor.level.create({ grid: 1, storeyHeight: 3 });
await Editor.level.addPiece({ shape: "floor", from: [0, 0, 0], to: [8, 0, 6] });
await Editor.level.addPiece({ shape: "wall",  from: [0, 0, 0], to: [8, 0, 0] });
await Editor.level.addOpening(wallId, { kind: "door", offset: 2 });
await Editor.level.addColliders(entityId);
await Editor.character.create({ view: "first", position: [4, 0, 3] });
```

`level.setTool` arms the viewport palette and points it at a level and storey —
the handoff for "I have built the shell, you carry on drawing". The pointer
state deliberately has no op: an agent that could arm a tool but not click
would leave the editor in a mode the user then has to escape from.
