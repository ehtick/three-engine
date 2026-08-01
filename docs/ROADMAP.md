# Engine Roadmap — game-development features, ranked by value

**Written 2026-07-27** after a full source review (`src/engine`, `src/modules`, `src/editor`).
Ordering is by *value delivered per unit of effort to someone actually shipping a game*,
not by technical interest. Work top-down. Update the status markers as items land.

Status key: `[ ]` not started · `[~]` in progress · `[x]` done

---

## Where the engine stands

**Rendering — the strongest area.** WebGPU/TSL throughout, radiance-cascade real-time GI
over an SDF scene, volumetrics, PCSS shadows, post-process node graph, ~120-node TSL
shader graph, GPU-compute particle graph, Nanite-style virtual geometry, auto-batching,
frustum culling, render scale + dynamic resolution, GPU timestamp profiling.

**Authoring.** Dockview editor with a full undo/redo command bus, prefabs with
diff-derived overrides, a BMesh geometry editor at Blender parity, terrain sculpt +
scatter, asset pipeline with Draco/KTX2, three asset-library browsers
(PolyHaven/AmbientCG/Sketchfab), an animator state-machine graph, an MCP server + PTY
terminal, and an editor op registry shared by scripts and MCP.

**Runtime.** Entity/component over `Object3D`, TS scripting with attributes + hot reload +
multi-script, Rapier physics (rigidbody/collider/character controller), spatial audio with
occlusion, input action maps incl. gamepad + virtual joysticks, a full WebGPU UI widget
set, the modules system, and export → player.

## The gap

The engine has a renderer and a content pipeline that beat most hobby engines, and almost
none of the plumbing that turns a scene into a *game*. Everything below is that plumbing,
ordered by which wall you hit first.

---

## Tier 0 — hard blockers, small effort

### [x] 1. Runtime scene management — **shipped 2026-07-27**
A game can now go menu → level 1 → level 2.

- `src/engine/sceneManager.js` — `engine.loadScene(path, { mode, preload, onProgress,
  setCamera })`, `engine.unloadScene(path)`, `engine.scenes.{loaded, active, isLoading,
  isLoaded}`. Async and cancellable: a superseded load resolves to `null` instead of
  interleaving into the scene that replaced it.
- **Scenes are addressed by project-relative path** (`"scenes/Level2.scene"`). The same
  string works in the editor (resolved against the open project via the new
  `setSceneLoader` hook) and in a build (fetched as a relative URL), because the exporter
  copies scene files across at the same relative path.
- Progress across five phases (fetch → modules → preload → unload → instantiate), emitted
  as `scene-load-progress` and passed to `onProgress`. The player ships a loading screen
  driven by it (`player.html` + `createLoadingScreen`).
- **Asset preload is derived, not hand-maintained**: `collectSceneAssets` reads component
  *schemas* for `type: "asset"` fields (plus model material maps, script paths, prefab
  contents), then follows `.mat` files one level to their textures. A new component with
  an asset field is preloaded the day it is added.
- Persistent entities (`entity.persistent` / `engine.dontDestroyOnLoad`, serialized, with
  a Persistent toggle in the Inspector). A persistent entity nested under a
  non-persistent one is re-rooted rather than destroyed with its parent.
- Additive loads remap colliding entity ids, so the same scene can load twice.
- `exportGame` now ships **every** scene in the project at its project-relative path, not
  just the open one; boot preload stays scoped to the start scene.
- Tests: `npm run test:scenes` (19 headless checks) and `npm run smoke:player-scenes`
  (18 checks driving a real built player over HTTP in Chrome/WebGPU).

Deferred to item 11 (Build & publish), and delivered there: a Build Settings scene list.
Shipping every `.scene` is still the default; it is now a choice.

### [x] 2. Game time control — **shipped 2026-07-27**
Pause menus, slow motion, hitstop and frame-stepping.

- `engine.setTimeScale(v)` / `setPaused(b)` / `step(frames)`, plus `deltaTime`,
  `unscaledDeltaTime`, `elapsedTime`, `unscaledElapsedTime`. Events:
  `time-scale-changed`, `paused-changed`.
- **Paused freezes game time, not the render loop** — the paused frame keeps drawing and
  stays inspectable. `step()` releases one fixed `stepDeltaTime` (1/60) slice, not however
  long the user waited before clicking.
- **Both reset on Stop.** A script that paused the game or dropped timeScale to 0.1 for a
  death effect must not leave the editor viewport frozen or crawling.
- `maxDeltaTime` (0.25s) clamps the delta, so a backgrounded tab or a shader-compile stall
  can't hand physics a multi-second step to tunnel through.
- Wall-clock consumers were moved off the scaled delta: **input** (a pause menu has to stay
  navigable), **audio** bookkeeping, and **script hot-reload polling** (saving a script
  while paused used to do nothing until resume).
- **The GPU particle sim now runs on game time.** It integrated against TSL's built-in
  `deltaTime` — the renderer's own frame time — so particles kept erupting through a pause
  menu and ignored bullet time. `ParticleComponent` writes `engine.deltaTime` into a
  uniform per frame instead.
- Editor: Pause + Step buttons appear in the viewport toolbar while playing;
  `Ctrl+Shift+P` pauses, `Ctrl+.` steps.
- Tests: `npm run test:gametime` (16 checks, incl. the particle sim delta).

### [x] 3. Physics gameplay layer — **shipped 2026-07-27**
`PhysicsSystem` went from one query (`raycast`) to the full gameplay surface.

- **Collision layers + matrix.** Named layers with a symmetric Unity-style matrix, edited in
  Project Settings → Physics Layers and stored in `project.json`. A collider/character names
  its layer by string; the matrix decides which pairs touch, so a bullet can finally be
  stopped from hitting its shooter. Authoring the matrix lopsided is not an error — it is
  symmetrised on load. Unknown layer names fall back to `Default` rather than throwing, so
  renaming a layer can't break a scene.
- **Queries.** `raycast`, `raycastAll`, `shapecast`/`spherecast`/`boxcast`/`capsulecast`,
  `overlap`/`overlapSphere`/`overlapBox`/`overlapCapsule` (de-duplicated per entity). Every
  one takes `{ layers, exclude }`. **Query layers are deliberately independent of the
  collision matrix** — a layer that collides with nothing is still queryable when you ask for
  it, which is what trigger volumes and interaction probes need. `exclude` covers the
  entity's whole subtree, so a weapon parented under the player is excluded too.
- **Joints.** `JointComponent`: fixed, hinge, ball, slider, spring, rope. An empty Connected
  Body pins to the *world* at the current pose (the hinged-door-on-static-geometry case, and
  the common one). Hinge limits/motor speeds are authored and stored in **degrees** —
  a "±45" door reads wrong in radians — and converted at build time. Motors are drivable from
  scripts (`setMotorVelocity`/`setMotorTarget`/`setLimits`). A joint naming a missing or
  body-less entity warns and skips instead of aborting the world build.
- **Character controller.** Moving platforms carry the character (ground contact resolved per
  step, upward-facing surfaces only — a wall is not a platform), exposed to gameplay as
  `getPlatform()`; `pushDynamicBodies` makes the capsule shove dynamic bodies.
- A body that spawns *already inside* a trigger reports entering it, and collision events
  reach every script on both entities (not just the first).
- Tests: `npm run test:physics` (24 headless checks driving the real Rapier world — its wasm
  runs in Node). Also new: `npm run test:scripttypes`, which guards the script-facing
  `ComponentMap` against keys that don't match a registered component type — a near-miss
  there is silently swallowed by `getComponent`'s string overload rather than reported.

### [x] 4. Save/load + persistent data — **shipped 2026-07-27**
`src/engine/saveSystem.js`. Two stores, deliberately separate, because conflating them is
the usual mistake: **`engine.saves`** is a snapshot of one playthrough, **`engine.prefs`** is
volume/difficulty/keybinds — written through immediately, and untouched by deleting every
save slot.

- **A save is not the whole scene.** Re-serializing every entity would bake level geometry
  into saves (so a level fix could never reach an existing one) and would still miss what
  actually matters — the quest flags living in script fields. Instead scripts opt in with
  `onSave()` / `onLoad(data)`, and any entity with a script defining `onSave` is captured,
  transform and enabled-flag included. `onLoad` runs *after* the transform is applied, so a
  script that wants different placement has the last word.
- **Runtime spawns round-trip.** A prefab instance spawned during play is recorded with its
  prefab link and respawned under its saved id; save-participating spawns the save *doesn't*
  contain are pruned, so an enemy killed before saving isn't standing there after loading.
- **Slots**: `save`/`load`/`has`/`delete`/`list` (headers only, newest first — what a load
  menu wants), plus `capture`/`restore` for checkpoints and custom UI. A save names the scene
  it belongs to and `load` returns to that level first.
- **Versioned migration.** `registerMigration(n, fn)` chains one version at a time from the
  project's `game.saveVersion`. A save with no path to the current version is **refused**, not
  loaded — silently feeding v1 data to v2 scripts corrupts a playthrough hours before the
  player notices.
- **Namespaced storage** (`game.saveId`, defaulting to the title) so two games on one origin —
  itch.io, a shared dev server — can't read each other's slots. The editor and the exporter
  derive it identically, so testing a save in the editor tells you about the shipped game.
  Backend is swappable (`setSaveBackend`) like `assetResolver`; the default is localStorage,
  degrading to memory when it's blocked, with `saves.durable` reporting which is live.
- Two engine bugs fell out and are fixed: `ScriptComponent` called the *optional* `onStart` /
  `onDestroy` hooks unconditionally, so a script defining only `onUpdate` logged a TypeError
  every Play and latched itself off on the third; and script modules load asynchronously, so
  a newly respawned entity needed the new `ScriptComponent.whenReady()` before `onLoad` could
  reach it.
- Tests: `npm run test:saves` (35 headless checks) and `npm run smoke:saves` (16 checks that
  save in a real built player, **reload the page**, and load it back through real
  localStorage — the one thing an in-memory test can't prove).

### [x] 5. Game view panel + play polish — **shipped 2026-07-27**
A dedicated **Game** tab (`src/editor/panels/GamePanel.jsx`, Window → Game), tabbed with the
Viewport.

- **One renderer, shared.** The Game view shows the *same* canvas as the viewport rather than
  standing up a second `WebGPURenderer` (the model-preview panel already pays that cost and
  it is filed as a debt, not a pattern). `src/editor/viewportCanvas.js` arbitrates ownership
  by ranked claim; the Game panel outranks the viewport exactly while playing and hands the
  canvas back on Stop.
- **Aspect / resolution presets** — free, 16:9, 16:10, 21:9, 4:3, 1:1, 9:16, plus fixed
  1920×1080 / 1280×720 / 1080×1920. These resize the **renderer**, not just the CSS box, so a
  portrait preset really renders a portrait frame and a HUD anchored bottom-right really
  moves. A fixed resolution is never scaled up past 1:1 — a blown-up 1080p target would
  misrepresent both framing and sharpness.
- Stats overlay (forced on here — telemetry is the point of this view, and it must not be
  switchable from a dropdown in another panel), maximize-on-play, mute, and Play/Pause/Step
  wired to item 2. Aspect + maximize choices persist.
- Three DOM-ownership bugs were found and fixed by the smoke, all of the silent variety:
  appending into a **detached** container made the canvas vanish editor-wide; a stale unmount
  cleanup deleted the *incoming* instance's claim because both use the id `"viewport"`; and —
  the expensive one — **dockview detaches an inactive tab's element without unmounting its
  React component**, so nothing re-registers the claim when you click back. A frame-budget
  retry is the wrong tool there (a hidden tab stays detached for minutes); a scoped
  `MutationObserver`, installed only while unresolved, is the right one.
- Test: `npm run smoke:gameview` (22 checks driving the real editor — canvas ownership,
  letterbox arithmetic against a live layout, and a renderer that must keep producing frames
  through every handover; none of it is testable headlessly).

---

## Tier 1 — makes it feel like a game

### [x] 6. Animation depth — **shipped 2026-07-27**
`.anim` controllers went from "one clip at a time" to the full character-animation surface.
Controllers are now **version 2** (`layers[]`); v1 files are folded into a single Base Layer
on load and upgraded in place the first time the panel saves — opening one does not rewrite
it.

- **Blend trees** (`src/engine/anim/blendTree.js`) — 1D by threshold, and 2D solved with
  gradient-band interpolation in either a cartesian or a **directional** metric. Directional
  is what a strafe set needs: "forward at 3 m/s" and "backward at 3 m/s" are 180° apart, not
  merely far apart, and cartesian distance can't tell those cases apart. Children are
  **cycle-synced** — every clip is retimed to a common weighted-average stride length, which
  is the difference between a walk/run blend and a foot-skate.
- **Layers with avatar masks.** Override or additive, per-layer weight drivable from scripts
  (`anim.setLayerWeight("Aim", 1)`). The implementation detail that dictated the design:
  three's `PropertyMixer` blends toward the **bind pose** by `1 - cumulativeWeight`, so
  contributors to a bone must sum to exactly 1 — which rules out "down-weight the base layer
  so the upper one wins", because an action's weight applies to all of its tracks and would
  drain the legs to make room for an arms-only overlay. Instead each layer's clips are split
  into **mask regions** (bones that see the same set of override layers above them), computed
  once at build time; the per-region weights then telescope to exactly 1 everywhere. Disjoint
  masks — a face layer and an arm layer — correctly leave each other alone. A mask is
  narrowed to the nodes its clips actually drive, so a mask that over-reaches its clips
  doesn't pull bones toward the bind pose.
- **Root motion.** Sampled through the clip's own interpolants rather than differencing the
  bone before/after `mixer.update`, so a clip looping mid-frame is a plain arithmetic term
  (`cycles × per-cycle motion`) instead of a spike to threshold away. Exact for any dt, any
  timeScale, any number of blended clips. Everything is expressed in the **entity's** space,
  through the rig's up-axis correction — the reason a naive implementation sends a walk cycle
  into the floor. Yaw comes from the swing-twist of a *delta* quaternion, because the yaw of
  an *orientation* is undefined when a glTF armature's local axis points at world up. Applies
  to the transform, or to `consumeRootMotion()` for a character controller; never both, and
  never while merely previewing in the editor.
- **Two-bone IK** (`IKComponent`) — analytic, no iteration: bend the mid joint by the law of
  cosines, swing the root onto the target, roll to the pole. Optional **ground probe** for
  foot planting (raycasts down from the animated foot, so a walk authored on a flat floor
  stops sinking into a ramp), pole hint, weight blending, softness so full extension doesn't
  pop, and tip alignment to a slope.
- New engine stage `onLateUpdate(fn, order)`: the pose pipeline runs animator → IK (0) →
  bone-attachment sync (100). Attachment sync used to be ordered by subscription time, which
  left an attached weapon holding the *pre-IK* pose.
- Editor: per-layer canvas with a Layers list (weight, blend mode, reorder, live weight
  readout while playing), a bone-checklist avatar-mask editor, a blend-tree editor with a
  draggable 2D sample pad, transition offsets, root-motion props on the Animation component,
  and a bone dropdown for the IK chain that spells out which three bones it resolves to.
- Also fixed on the way past: additive scene loads remapped colliding entity **ids** but not
  props that *reference* an entity, so a second copy of a scene wired its IK targets (and
  joints, and camera follow targets) to the first copy's entities. Now derived from the
  schema's `type: "entity"` fields, the same way asset preloading is derived.
- Tests: `npm run test:anim` (47 headless checks against the real `AnimationMixer`) and
  `npm run smoke:animator` (34 checks driving the real Animator panel and reading the saved
  controller back off disk — the round trip a unit test can't see).

### [x] 7. Camera rigs (Cinemachine-lite) — **shipped 2026-07-27**
A game ends up with a dozen framings — third-person follow, aim-down-sights, a death cam, a
cutscene push-in — and with one real camera they all become branches inside whichever script
last got there. They are now separate objects.

- **`VirtualCameraComponent` (`vcam`)** — a *shot*, not a camera: it renders nothing and owns
  no projection, it just computes where a camera should be and what it should point at. Body
  modes: `orbital` (boom arm), `transposer` (offset in world or target-local space),
  `hardLock` (first person), `none` (a fixed shot). Aim modes: `lookAt` with an aim offset,
  `follow`, `none`. Body and aim are independent, which is what an over-the-shoulder aim
  camera is made of.
- **The brain lives on `CameraComponent`**, because there is exactly one active camera per
  frame and a scene where the camera silently does nothing until you add a second component
  is worse than one extra prop. It picks the highest-priority enabled vcam, blends position /
  rotation / **field of view** (a cut from a 30° telephoto to a 90° wide angle without
  blending the lens is a jump cut in the middle of a smooth move), and keeps evaluating the
  outgoing shot during the blend so a follow camera doesn't freeze into a ghost. An incoming
  shot is snapped onto its target before it is ever seen — otherwise it evaluates from a
  stale position and the blend films its trip across the level.
- **Damping is exponential, not `lerp(a, b, dt * k)`.** The `lerp` version ties the rig's feel
  to the frame rate: the same camera glides at 240Hz and snaps at 30Hz, and the difference is
  invisible on the machine it was authored on. Vertical damping is a separate dial from
  horizontal — that is what stops stairs and small hops bobbing the frame while a turn still
  reads as responsive.
- **Wall avoidance** sweeps a *sphere* from the pivot, not a ray: a ray slips through the gap
  between a doorframe and a pillar that the camera's near plane does not. It snaps inward and
  eases back out — the asymmetry is the point, since a camera that eases *into* a wall spends
  those frames inside it.
- **Impulses** (`engine.cameraImpulse`, `ImpulseSourceComponent`) are events, not state: fire
  and forget, several at once, with squared distance falloff and a clamp so a barrage can't
  fling the camera through a wall. Deterministic — no `Math.random()` — so a replay or a test
  shakes the same way twice. Shake is applied in the camera's own space, so a horizontal
  rattle means "across frame" rather than "along world X". Cleared on Stop.
- **The editor never moves your camera by accident.** The rig drives the transform only while
  playing, or while `Preview Rig` is explicitly on — and turning the preview off restores the
  authored pose exactly. Play mode needs no such care (the scene snapshot handles it); the
  editor has no safety net, and a preview that quietly rewrites the camera's saved position is
  a preview nobody can leave on. Plus a viewport gizmo, and inspector Solo / Fire buttons.
- Tests: `npm run test:camera` (41 headless checks, including the same rig settling identically
  at 30Hz and 240Hz) and `npm run smoke:camera` (16 checks that the inspector sections render
  and act — a throw in one of them blanks the whole Inspector, which no headless test can see).

### [x] 8. Navigation + AI — **shipped 2026-07-27**
`recast-navigation` shipped as a module the same way Rapier is: the wasm is imported lazily
inside `setup()`, so projects that don't enable navigation never download it (it is a 726KB
chunk), and `setup` returns immediately while the init finishes in the background.

- **`engine.navigation`** — `bake()` from scene geometry, `findPath`, `sample`,
  `isOnNavMesh`, `randomPoint`, `moveAlongSurface`. Bake settings are authored in **metres and
  degrees** and converted to the voxel counts recast wants (ceil for radius/height so an agent
  never fits somewhere it shouldn't, floor for step height so it never climbs what it can't) —
  the sort of conversion nobody notices being wrong until agents walk through walls.
- **`sample()` and `isOnNavMesh()` are deliberately different questions.** `sample` finds the
  nearest walkable spot and always succeeds if anything is in range, so using it as a
  containment test reports a point in the middle of a wall as walkable because the corridor
  next door is close enough. `isOnNavMesh` compares the answer to the question.
- **Geometry collection** skips the editor and debug layers (including the previous bake's own
  overlay), skinned meshes (a navmesh baked around a T-pose is worse than none), and anything
  tagged `nav-ignore`; an Include Tag flips it to opt-in. Bounds filtering drops whole
  *triangles*, because dropping vertices leaves dangling indices and recast reads past the array.
- **`NavAgentComponent`** rides recast's crowd rather than just following a path — a path is
  computed against static geometry, so ten enemies with ten correct paths to one door walk
  through each other to reach it. `setDestination` snaps to walkable ground (so aiming at a
  player on a ledge moves the agent to reachable ground rather than silently failing), plus
  `stop`/`resume`/`warp`, `remainingDistance`, `isAtDestination`, and optional path debug draw.
  Agents are snapped onto the navmesh when they join: anything dropped into a scene sits a few
  centimetres above the floor, which is *off* the navmesh as far as detour is concerned.
- **`NavLinkComponent`** — off-mesh links for jumps, ladders and drops, baked into the mesh via
  recast's off-mesh connections. Without them a half-metre ditch is an impassable wall. End
  offsets are local, so a link authored on a prefab rotates with the instance.
- **`NavMeshComponent`** holds the bake settings (a property of the *level* — an indoor map and
  an open field want different cell sizes) and writes the result to a `.navmesh` asset rather
  than embedding it in the scene JSON. Baking at load would put recast's tens-to-hundreds of
  milliseconds on the player's machine at every level transition; a runtime bake is still the
  fallback so navigation works before anyone presses Bake. Includes the viewport overlay.
- Two races closed: components attach while the wasm is still loading (a scene deserialized in
  that window would have had agents that path correctly and never move, and links silently
  missing from every bake), and a re-bake destroys the crowd (every enemy would go inert until
  someone reloaded the scene).
- Tests: `npm run test:camera`-style — `npm run test:nav`, 31 headless checks driving the REAL
  recast wasm, including a path that must detour around a wall and a link that must turn an
  impossible route into a possible one.

### [x] 9. Debug draw + script gizmos — **shipped 2026-07-27**
`engine.debug.line/ray/arrow/box/sphere/capsule/point/polyline/axes/text`, callable from
gameplay scripts and visible in the viewport **and** in Play and Game views — which is the
whole difference from the pre-existing `onDrawGizmos`, an editor-only surface on a layer play
cameras don't render. Both now share one `DebugBuffer`: same shapes, same single draw call,
one place to fix the circle maths.

- **Immediate mode with an escape hatch.** No duration means one frame, so a script draws
  unconditionally and never cleans up — nothing to dispose, nothing leaked when a script is
  deleted mid-session. A `duration` is the only way to see a one-shot event: a raycast fired
  inside a collision handler exists for one frame, and one frame at 120fps is not something a
  human can see. Timed shapes are capped and warn once, because `debug.line(a, b, c, 0.5)`
  inside an update loop is an easy mistake with no symptom but a slowly dying editor.
- Durations run on **wall-clock** time: bullet time must not stretch a two-second line to
  thirteen, and a paused game must not freeze one on screen forever.
- Its own `DEBUG_LAYER`, so a camera can switch all of it off at once and the GI/batching
  passes never see it; a Debug Draw toggle in the viewport's Layers dropdown turns it off at
  the source rather than hiding the mesh.
- Tests: `npm run test:debugdraw` (20 checks, mostly about lifetime — the part that decides
  whether the feature is usable or a leak).

---

## Tier 2 — production capability

Items 10, 11, 12 and 13 shipped. Tier 2 is complete; Tier 3 is in progress.

### [x] 10. Timeline / sequencer — **shipped 2026-07-28**
`.timeline` assets, a dope-sheet panel, and a director component. Doors, flickering lights,
elevators and cutscenes no longer need a script — and the same asset is what a cutscene is
made of.

- **State is a pure function of time; triggers are a function of the interval crossed.**
  This one split shapes the whole design. `sample(t)` writes the world as it should look at
  `t` and never consults where the playhead was before, so frame 40 looks identical whether
  you arrived from 39 or from 200 — which is the only thing that makes scrubbing usable.
  `fireBetween(from, to)` fires event markers, and scrubbing never calls it, so dragging the
  playhead across an "explode" marker forty times does not detonate forty times.
- **Binding captures, unbinding restores.** Previewing writes real values onto real
  components (you have to *see* the light dim), so the runtime records every value it touches
  and puts it all back on Stop, on asset switch, and on unmount. Without that, looking at a
  timeline permanently rewrites the scene it animates — the same lesson as the camera rig's
  `Preview Rig`, and the reason `wrapMode: "once"` reverts while `"hold"` leaves the last
  frame standing (a door wants hold; a camera-shake overlay wants its transform back).
- **Six track kinds, two shapes.** Point tracks carry `keys` (property, event), range tracks
  carry `clips` (activation, animation, audio, camera). Keeping it to exactly two shapes is
  what lets the dope sheet drag, select, resize and delete generically instead of branching
  per kind.
- **Property tracks are derived from component schemas**, so a component that gains a
  property gains the ability to be keyed the same day. Rotation is keyed in **degrees** and
  applied in radians through one accessor shared with record mode — recording degrees against
  a runtime that writes radians looks like the animation running 57× too fast rather than
  like a unit mismatch. Euler interpolation takes the short way around (350° → 10° is a 20°
  turn), and `smooth` uses **auto-clamped** tangents: plain Catmull-Rom overshoots at a local
  extremum, which on a door's "closed" key means the door passes through the frame before
  settling.
- **Animation tracks own the rig for as long as they are bound**, not just while a clip is
  under the playhead — handing it back to the state machine in the gaps makes an empty stretch
  of track play whatever the animator felt like. Clip poses come from setting `action.time`
  and calling `mixer.update(0)`, so a scrub lands on exactly the pose playback produced.
- **Camera-shot tracks get their own channel on the vcam** (`setTimelineShot`), like `solo`
  and unlike "temporarily raise the priority": a shot must be able to cut to a low-priority
  vcam and hand control back without ever writing an authored priority. It outranks priority
  while its clip is live — a cutscene is stating what the audience sees. A bound shot track
  also switches the camera brain's preview on transiently (and off again), or scrubbing one
  in the editor would do nothing visible.
- **Bindings** (`trackId -> entityId` on the director) let one asset drive twelve doors.
  The additive-load id remap learned a new schema field type, `entityMap`, to follow them —
  without it the second copy of a cutscene animates the *first* copy's objects, so the scene
  you are looking at does nothing.
- Editor: dope sheet with ruler scrubbing, frame snapping, key/clip drag + resize,
  interpolation menus, per-kind lane colours, an add-track picker driven by the target
  entity's real components, and **record mode** — park the playhead, move the object, get a
  key. Local snapshot undo (Ctrl+Z belongs to the panel while the pointer is over it, the
  same deal the node graphs have). Directors get a bindings table in the Inspector.
- `exportGame` ships `.timeline` files with their audio-clip paths rewritten, and scene
  preloading follows a timeline to its clips the way it already follows a `.mat` to its
  textures.
- Tests: `npm run test:timeline` (41 headless checks, most of them about determinism and
  reversibility) and `npm run smoke:timeline` (37 checks driving the real panel, including
  the round trip through disk and back into the runtime). The smoke found a real bug that no
  DOM-level click could: the add-track popover rendered *under* its own dismiss overlay —
  perfectly visible, completely inert.

### [x] 11. Build & publish — **shipped 2026-07-28**
Export went from "writes a folder and hopes" to a configured build with three delivery
targets. The pure decision-making moved into `src/editor/build/` (naming, scene plan,
HTML rewrite, desktop scaffold) so the parts that silently produce a *wrong* game rather
than a failed one are testable without a browser.

- **The web build did not actually run on itch.io.** Vite emitted `<script src="/_engine/…">`
  — an absolute URL — so the bundle 404s the moment the game is served from a subpath, which
  is what itch.io (`html.itch.zone/html/<id>/`), GitHub Pages project sites and every
  "unzip into a folder" host do. It works perfectly at `localhost:PORT/` because that *is*
  the site root, so the bug is invisible until players see it: a white page, no error. Fixed
  with a relative `base`, and the engine's chunks moved to `_engine/` so a game asset can
  never land on a bundle chunk's name. `npm run smoke:build` serves a real build from
  `/games/demo/` and fails if anything is fetched from the server root.
- **Same-named assets were silently overwriting each other.** Every file shipped as
  `assets/<basename>`, so `textures/wood/color.png` and `textures/stone/color.png` — the
  normal case, since downloaded PBR sets all name their maps the same thing — both became
  `assets/color.png`. The build shipped, and one material wore the other's texture.
  `build/assetNames.js` now allocates a unique destination per source (case- and
  separator-insensitive, because Windows is), sidecars follow the *renamed* asset, and
  generated documents (rewritten `.mat`, transpiled scripts) share the namespace.
- **Build Settings panel** (Window → Build, `Ctrl+B` to build): start scene, per-scene ship
  toggles, quality preset, target, icon, loading-screen colours, compression, and a build
  report. It shows the *resolved* plan, not just the raw settings — the start-scene fallback
  is three deep, and a build that boots the wrong level is discovered after uploading. A
  start scene left out of the scene list is added back rather than producing a black screen.
- **Quality presets are a ceiling, never an override.** Every knob is the cheaper of what the
  scene authored and what the preset allows, so a level deliberately dropped to
  `renderScale: 0.5` is not raised by someone picking "High" in a dialog; `ultra` applies no
  ceiling. Re-applied on every settings change rather than once at boot, because loading
  level 2 brings that level's own `performance` block with it.
- **Three targets, one pipeline.** `web` is a folder; `zip` archives it with `index.html` at
  the root (the layout itch.io wants — `MyGame/index.html` inside the zip is a blank page
  with no diagnosis) and writes the archive *beside* the build, not inside the folder it is
  walking; `desktop` emits a complete Tauri project around the build, with
  `--enable-unsafe-webgpu` already set (without it a desktop build of a WebGPU engine is a
  black window) and a real bundle identifier. The desktop target is honest about being a
  project to compile: an .exe needs Rust and can only target the machine building it.
- **The output can be run.** A built game cannot be opened from the filesystem — module
  scripts, the scene fetch and the WASM decoders are all blocked over `file://` — and "now
  install a static server" is a strange thing for an engine to say about its own output, so
  the editor runs one (`src-tauri/src/preview.rs`, loopback only, std-only).
- **The loading screen is themed at export**, not at runtime: it is on screen before
  `scene.json` has been fetched, so anything read from the scene would flash the engine's
  colours first. Title, favicon, background, accent and logo are baked into `index.html`;
  the text colour is derived from the background's luminance, because a white loading screen
  with white-on-white text is a setting whose effect is "the loading screen is now blank".
- **Build-time compression** wired to the existing modules: textures through Basis (which
  writes the same `.basis` derivative cache the import path does), models through Draco
  *into the build* — the bytes overwrite the copied file, so a build never rewrites the .glb
  the project is still authoring against. Per-asset opt-outs beat the build-wide toggle.
- The packaged-editor debt is closed too: `export_game` now resolves the player template from
  the app's resource directory first, and `dist-player/` is bundled with the editor.
- Tests: `npm run test:build` (82 headless checks), `npm run smoke:build` (21 checks driving a
  real build served from a subpath in Chrome/WebGPU), `npm run smoke:build-export` (39 checks
  running the real export over a project shaped like the one that broke it, asserting each
  material still names its *own* texture after the rename), plus 5 new Rust tests and 7 new
  checks in `smoke:editor-ui` for the panel.

### [x] 12. UI depth — **shipped 2026-07-28**
The widget set was fine; everything around it assumed a HUD that never moves.

- **Text is resolution-independent** (`src/engine/ui/sdfFont.js`). Glyphs are rasterized once
  into a shared signed-distance atlas — a Euclidean distance transform over the coverage,
  the tiny-sdf approach — and drawn as one quad each. The old canvas raster is genuinely
  sharp for a static HUD and hopeless for anything else: a world-space label blurs as you
  walk toward it, a tweened scale re-rasterizes and re-uploads a texture every frame, and
  anything past 2048 physical px was simply clamped. **Single-channel SDF, not MSDF** —
  MSDF needs glyph *outlines*, which canvas does not expose, so it means shipping a font
  parser and a bake step; this works with any system font and costs a rounded corner on
  hard-cornered faces at extreme magnification. Outlines came almost free with it, which is
  what makes a HUD readable over arbitrary scenery. The raster path stays as an explicit
  option, because an SDF is a coverage mask and cannot do colour emoji.
- **Antialiasing now comes from the fragment derivative**, not a CPU-computed uniform. The
  old `1/k` feather is only right for a screen overlay whose on-screen size is known at
  layout time; a world panel got a razor edge up close and a smear at distance.
- **Nine-slice and tiled sprites** — corners keep their pixel size while edges and centre
  stretch or repeat, with the insets authored in *texture* pixels so they survive resizing
  the element. Branchless UV remap in the shader.
- **World-space UI.** `renderMode: "world"` puts a screen in the scene at its entity's
  transform, sized `reference × worldScale` (a 200×40 bar at 0.005 is 1m × 0.2m), optionally
  billboarded and optionally occluded by geometry. Panels render through the scene camera in
  the same post pass; the camera is *borrowed* rather than cloned, so the panel can't drift a
  frame behind the world. Health bars over enemies, signs, interaction prompts.
- **The editor no longer drowns in its own UI.** A screen-space canvas used to cover the
  viewport at all times, hiding the scene it was being built against. It is now drawn as a
  **plane in the world** while editing — the way Unity and PlayCanvas do it — so it can be
  moved aside, framed and clicked on its own; Play (or the new Show UI Overlay layer toggle)
  puts it back where the player will see it. Clicking a UI element in the viewport selects
  it, but only after the 3D pick comes up empty, so a plane parked at the origin can't
  swallow every click on what is behind it.
- **Focus navigation** (`src/engine/ui/uiFocus.js`) — directional movement across buttons off
  the existing UI action map, so arrow keys, d-pad and stick all work and are rebindable.
  Scored as `along + 2 × across` rather than by straight distance: pressing Right in a grid
  should reach the item beside you, not the nearer diagonal. Candidates behind you are
  excluded outright — a menu where Down sometimes moves up is worse than one where Down
  occasionally does nothing. Per-button overrides handle wrap-around, which geometry alone
  never produces. Hover/press/focus are three independent flags, not one `state` string:
  collapsing them is what makes the gamepad highlight vanish the moment someone touches the
  mouse. Focus runs on wall-clock time, since a pause menu is exactly where it matters.
- **Tweening** (`src/engine/tween.js`) — `engine.tween(target, to, opts)` over dotted paths,
  21 easings, loop/yoyo, cancel/complete, awaitable. On game time (a pause freezes it, bullet
  time slows it) with an `unscaled` opt-out for the pause menu's own animation, and cleared on
  Stop so a running tween can't keep writing to a scene the snapshot has already restored.
- Known limit: mask/scroll clipping on a world panel is a projected screen-space box — exact
  for a billboarded panel, conservative for one seen at a steep angle.
- Tests: `npm run test:ui` (73 headless checks — layout, the distance transform, glyph
  layout, focus scoring, tween timing) and `npm run smoke:ui` (36 checks driving the real
  editor and a real WebGPU frame: plane-vs-overlay modes, a panel following its entity,
  glyph geometry, nine-slice uniforms, a menu driven with no mouse, and a pixel readback
  proving the thing is actually on screen).

### [x] 13. Gameplay VFX — **shipped 2026-07-28**
The particle system was strong; these are the adjacent primitives it did not cover.
All three live in `src/engine/vfx/`, and two of the three are the same primitive.

- **A line and a trail are one thing given a spine.** A ribbon is a polyline with
  width — a strip of quads with colour, width and UVs varying along it — and lines and
  trails differ only in *where the spine comes from* (authored points vs. a moving
  object's history). So `ribbon.js` builds the strip and each component supplies the
  points and the **ramp coordinate**: a line ramps by distance along itself, a trail by
  each point's **age**, which is not the same thing (a trail from an object that stopped
  moving has all its length piled at one end of the age ramp).
- **The billboard is in the vertex stage, not on the CPU.** Offsetting each point by a
  side vector computed from the camera is the obvious implementation and it cannot work
  here: the viewport camera, the game camera and the shadow pass all draw the *same*
  buffer in the same frame, so a CPU billboard is correct for at most one of them — and
  it re-uploads the whole strip whenever the camera moves, for a trail that did not
  change. Writing the spine (position, tangent, side sign, width, colour) and doing the
  billboard in the shader makes the buffer a pure function of the points, so a static
  line costs nothing per frame and orbiting the camera touches no memory.
- **The bounding sphere is written, never computed.** The buffers are over-allocated
  (a trail's point count moves every frame) and three only computes a sphere when it is
  null — a computed one reads the whole *capacity*, including the stale tail past the
  live vertices, giving a sphere either far too large (the ribbon never culls) or centred
  on the origin (it culls while on screen). Both present as "it sometimes disappears".
- **A trail's points are world-space, at the scene root** — that is the whole feature.
  Parent the strip to the object and the history moves with it, turning a sword arc into
  a rigid ribbon bolted to the blade. Which then means the mesh inherits nothing from its
  entity, so visibility is carried across by hand up the ancestor chain, or hiding a
  character leaves its trail hanging in the air.
- **It samples in late-update**, after the animator, after IK, after bone-attachment sync.
  A trail on a weapon parented to a hand bone that sampled during `onUpdate` records the
  *previous* frame's pose — a sword trail lagging the sword by one frame is the artefact
  nobody can name and everybody sees. It runs on **game time**, so bullet time slows a
  trail and a pause freezes one; history is runtime state (`resetOnStop`), or leaving Play
  leaves a streak from wherever the object got to back to its authored spot.
- **The tail is cut, not popped.** The oldest point is interpolated to where it should be
  at exactly `time` seconds old rather than deleted whole, so the trail retreats smoothly
  instead of twitching backwards a segment at a time — a stutter that gets blamed on the
  frame rate.
- **Decals are clipped copies of the surface**, three's `DecalGeometry` approach: the
  triangles under the projector box, cut against it and re-UVed. Screen-space decals need
  a depth prepass and a G-buffer the forward path does not have, and they bleed onto
  whatever is behind the surface; a decal mesh curves over a barrel and wraps a corner
  with no per-material work. Skinned meshes are skipped **deliberately** — their buffer
  holds the bind pose, so a decal projected onto a walking character lands on a T-posed
  copy of it standing somewhere else. Batch proxies are skipped too (their members are
  still in the scene, just invisible — projecting onto both doubles every triangle), as
  are the decal batches themselves, since a decal on a decal compounds every spawn.
- **One buffer per look, not one mesh per decal.** A firefight leaves a hundred bullet
  holes; as individual meshes that is a hundred draw calls for two hundred triangles —
  pure submission overhead. Decals sharing texture, blend mode and lit-ness are
  concatenated into one buffer, rebuilt on spawn and expiry (events, not frames). Per-decal
  **fade lives in the vertex colours**, not a uniform — a uniform means a material, and
  therefore a draw call, per decal. `maxDecals` is a hard ring that evicts the oldest: a
  shooter with no cap gets slower the longer you play, and nobody attributes that to bullet
  holes.
- `engine.decals.spawn({ position, normal, texture, size, lifetime })` off a raycast hit is
  the gameplay path; `DecalComponent` is the authored one — the entity *is* the projector,
  aimed along its own -Z like a camera, so placing one is the ordinary move gizmo. It
  re-projects on a **coalesced next-frame** bake, so dragging the gizmo across a wall
  re-cuts once per frame rather than once per pointer event. Decals are cleared on Stop and
  on scene load: a bullet hole punched during Play must not survive into the edited scene,
  nor into the next level.
- Tests: `npm run test:vfx` (63 headless checks) and `npm run smoke:vfx` (24 checks against
  a real WebGPU frame — that the billboard really is in the vertex stage because orbiting
  does *not* rebuild the buffer, that 25 decals really are one draw call while a differently
  lit one is not, and a pixel readback proving all three are on screen).
- Writing that smoke's pixel check is its own lesson: sampling the frame's dead centre read
  the **viewport grid's origin axis line**, drawn over the decal, and reported a working
  decal as missing; the beam was sampled at a hard-coded fraction of the frame height and
  missed by 50px. Sample points are now projected through the live camera and averaged over
  a small patch, which is robust to fov, aspect and canvas size.

---

## Tier 3 — scale and polish

Items 14, 15 and 16 shipped in full.

### [x] 14. LOD groups + impostors + GPU occlusion culling — **shipped 2026-07-28**
All three parts. LOD groups first, then impostors and occlusion culling.

Virtual geometry already covers the *dense* case — a scanned rock at two million triangles
is a cluster DAG and needs no help. It does nothing for the case that actually fills a
level: five hundred cheap props where the cost is draw submission and vertex work, not any
one mesh being big. `src/engine/lod/` + `LodGroupComponent` are that.

- **Screen height, not distance.** "Swap at 30 metres" is wrong in three independent ways,
  each of which only shows up after the level is built: a chain tuned on a 60° camera pops
  mid-frame the moment the player aims down a 20° scope (the tree is three times bigger at
  the same distance); duplicating a rock and scaling it 4× should push its switch distance
  out 4× and does not, so the big one turns to mush while still filling a quarter of the
  screen; and resolution and aspect move it again. Thresholds are the **share of the
  frame's height** the object covers, which is what the level is a claim about in the first
  place. Height rather than area, so the same numbers hold in 21:9 and in 9:16.
- **Orthographic cameras get their own formula**, because the perspective one makes LOD
  level a function of where the camera happens to be parked — on an isometric game, dollying
  back would re-LOD the entire map even though nothing changed size on screen.
- **The children ARE the levels**, finest first. Not a list of entity references: a
  reference list has to be remapped on every additive load and prefab instantiation (the
  trap items 6 and 10 were each fixed for) and it can dangle. Child order cannot dangle,
  needs no remap, and makes "add a level" the ordinary reparent that an imported
  `_LOD0/_LOD1` chain already produces. `levels[i]` is the minimum coverage for child *i*,
  so the array descends and its last entry doubles as the cull point — a final `0` means
  "draws at any distance", and there is no separate culled knob to fall out of sync with a
  level someone just deleted.
- **Hysteresis is not polish.** An object parked on a threshold — where anything the player
  is walking toward spends a moment, and where a prop at a fixed distance can sit forever —
  flips level every frame. That is a visible shimmer, and worse than it looks: every switch
  invalidates the static batch its props are drawn in, so one flickering tree can put the
  whole scene into a batch rebuild every frame. The current level's band is widened at both
  ends and only left decisively. A test drives ±1% jitter across a boundary for 200 frames
  and demands ≤1 switch; the control case with hysteresis off produces >20.
- **One writer of `object3D.visible`.** The engine resolves visibility from the per-mode
  enabled flags once per frame, so a component writing that field is overwritten before it
  is ever drawn. The LOD pass sets `entity._lodHidden` and the engine's own resolve ands it
  in — which also makes it a *veto rather than an override*: a level the author disabled
  stays hidden even when the camera asks for it.
- **The batching interaction is the trap.** A batched member draws through its `InstancedMesh`
  proxy whatever its own `visible` says, and batching only re-reads visibility when it
  rebuilds. So hiding LOD0 and showing LOD1 without invalidating leaves *both* on screen at
  full cost — and the symptom is "the LODs don't do anything", which points nowhere near
  batching. The LOD pass therefore invalidates. The other direction matters as much: a
  hillside of five hundred props crossing thresholds at slightly different moments would
  rebuild every frame, so the whole pass runs first and raises **at most one** invalidation
  per frame (a test asserts 100 simultaneous switches produce exactly 1).
- **Every exit restores the levels** — removing the component, disabling it, or turning the
  system off. A deleted LOD group that left four of five levels invisible would be a scene
  missing most of its geometry with nothing in the UI to explain why.
- Editor: a levels list bound to the children with a **live measured screen height** beside
  the thresholds. That readout is the feature, not decoration — every question an author has
  is "which level am I looking at, and why", and a good chain is one you cannot answer that
  about by looking.
- Tests: `npm run test:lod` (45 headless checks — the coverage maths, the hysteresis
  control case, the batch-invalidation coalescing) and `npm run smoke:lod` (19 checks in a
  real WebGPU frame, each level flat-coloured so a pixel read says *which* one is drawn,
  plus twenty batched props proving no batch is left drawing a level the system hid).
- Instrument note, the same shape as item 13's: a mesh component resolves its material
  asynchronously even when the prop is empty, so the smoke's per-level colours applied in
  the same tick as `addComponent` were silently replaced by the default white — and every
  colour assertion read the same lit grey and blamed the LOD system. The smoke now guards
  that its own colours stuck before asserting anything about them.

**Impostors** (`src/engine/lod/octahedral.js`, `impostorBake.js`, `impostorMaterial.js`,
`ImpostorSystem.js` + `ImpostorComponent`). Past the distance where even a few hundred
triangles are more than the silhouette deserves, a prop becomes one camera-facing quad
showing a pre-rendered view of itself.

- **An impostor is a LEVEL, not a mode.** The component goes on a child of an LOD group
  alongside the mesh levels, and the group treats it like any other one — same thresholds,
  same hysteresis, same children-are-the-levels rule. Nothing in LOD selection had to learn
  what an impostor is. `source` defaults to "the first sibling that is not me", which in a
  chain is LOD0, so the common case needs no wiring and there is no stored id to dangle.
- **Octahedral addressing, three frames blended.** Views are baked on an octahedral map
  (hemisphere by default — a tree is never seen from below, and folding the atlas to the
  upper half doubles the detail per frame). The obvious `yaw × pitch` grid wastes most of
  its frames near the poles and changes texel density with latitude. The three views
  surrounding the current direction are blended by barycentric weight, because snapping to
  the nearest one switches the whole billboard to a ~15° different rendering between one
  frame and the next, which reads as the scenery twitching as the player walks.
- **Albedo + normal, not a lit capture.** Baking the lit appearance is simpler and freezes
  the lighting: the impostor keeps its noon shading at dusk, ignores the shadow it stands
  in, and — worst — is lit differently from the level it replaces, so the switch that was
  meant to be invisible becomes a brightness pop. The bake runs in its own scene under a
  single white ambient (approximately albedo, from arbitrary shader-graph materials that
  have no readable `color`), plus an object-space normal atlas the runtime lights from.
- **One draw call for the forest, and that dictated the whole design.** A quad per prop
  would be a REGRESSION: the LOD mesh it replaces was already merged into one instanced
  draw by `batching.js`, so per-component meshes would trade a thousand vertices for four
  hundred and ninety-nine extra submissions on a CPU-bound frame. Impostors are drawn the
  way decals are — one buffer per look — with centre, size and the object's two world axes
  as instanced attributes, so the material never reads the model matrix. Hiding one writes
  `aSize = 0` rather than compacting the buffer, so an LOD switch costs one float.
- Atlases are shared by cache key (geometry + materials + transform + settings), refcounted,
  and baked ONE PER FRAME from the pre-render phase: fifty impostors enabled at once would
  otherwise spend a second of synchronous work in a single frame and read as a hang.
  Runtime bake, not a baked asset — a file would need invalidation whenever the mesh, its
  materials or their textures changed, and a stale atlas's only symptom is "that tree looks
  wrong far away".
- Editor: an Impostor section reporting the atlas size, how many props share it (a forest
  reading "1 draw call, 500 instances" is the feature working) and a Re-bake button, plus
  an **Add impostor level** button on the LOD group.
- Tests: `npm run test:impostor` (38 headless checks) and `npm run smoke:impostor` (18 in a
  real WebGPU frame). The smoke is built around a deliberately asymmetric source — red box
  on +X, blue on -X, green on +Y — because the failure that matters is not "nothing is
  drawn", it is a MIRRORED impostor, which is perfectly plausible and completely wrong.
- Two orientation traps, both found that way: the readback arrives with row 0 at the top
  while the viewport that placed each tile also counts from the top, so the pixels inside a
  tile are upside down but the tiles are not — flipping the whole image fixes the pixels and
  makes the shader read frame `n-1-r`, which is a different view of the same object and
  therefore *still looks like an object*. And the source is normally hidden at the moment it
  is baked (the impostor level is asked for exactly when the mesh levels switch off), so the
  bake clone has to force `visible` or the atlas comes out empty.

**GPU occlusion culling** (`src/engine/culling/occlusionMath.js` + `OcclusionSystem.js`).
Off by default; a per-scene setting, because it is a win indoors and a small loss in an
open landscape with nothing to hide behind.

- **The decision comes back to the CPU, and that is not a compromise.** In a GPU-driven
  renderer the culling compute shader writes an indirect draw buffer and the CPU never
  learns what was culled. three submits every draw from JavaScript, so a decision that
  stays on the GPU cannot remove a single draw call. What the GPU is good at here is
  producing the depth: a low-resolution pass over the large occluders, read back
  asynchronously (a quarter of a megabyte, never awaited on the critical path), reduced to
  a Hi-Z **max** pyramid on the CPU where each test is a handful of samples.
- **Max, not min.** The question is whether the FARTHEST occluder in a region is still
  nearer than the object's NEAREST point; a min-reduction answers a question that is true of
  most objects most of the time and culls things that are plainly on screen.
- **The test uses the camera the depth was captured with.** Applying a stale buffer against
  the current camera is what makes occlusion culling flicker whenever the player turns. What
  is left is objects that moved in between, which can be culled for one frame as they emerge
  — a real limitation, and a far smaller one.
- **Only big things are occluders**, tagged with their own layer so the pass skips the rest
  without walking it. Rendering the whole scene would double draw submission, spending
  exactly the resource this exists to save. The tag is written on a dirty flag, never per
  frame: `layers.mask` is part of the batching key.
- Visibility goes through `entity._occluded`, ANDed in by the engine's one resolve pass —
  the same single-writer rule LOD groups follow. Batched members are skipped entirely (they
  draw through a proxy that only re-reads visibility on rebuild) and the **proxies** are
  tested instead, so one test hides a hundred props.
- Honest limitation: a culled object stops casting its shadow. Unity and Unreal make the
  same trade; `cullShadowCasters` turns it off where it shows.
- Tests: `npm run test:occlusion` (27 headless checks, most of them asserting something is
  still DRAWN — the failure mode here is objects that vanish) and `npm run smoke:occlusion`
  (18 checks in a real frame, ending on the only number that matters: draw calls fell from
  52 to 13 with forty props behind one wall).
- Two bugs the smoke caught that nothing else could, both silent: the depth material carried
  the default alpha blend, and an `r32float` target has no alpha channel — WebGPU rejected
  the pipeline, dropped every draw, and left the system culling against a stale buffer; and
  the scene background is drawn as a full-screen pass that IGNORES camera layers, so the sky
  landed in the depth buffer as a distance of a few centimetres and the entire level was
  "behind" it. The first hid behind a smoke console filter that dropped anything matching
  `/WebGPU/` — the filters are narrow now, and a validation error fails the run.
### [x] 15. Object pooling + async instantiate — **shipped 2026-07-28**

`src/engine/pool.js` (`engine.pool`, a `PoolSystem`) behind three engine methods:
`engine.spawn(ref, opts)`, `engine.despawn(entity, delay)` and
`engine.instantiateAsync(ref)`, plus a `PoolComponent` ("Prefab Pool") for authored
prewarming.

- **A pool is a correctness feature disguised as a performance one.** The only question
  that matters is whether a recycled instance is indistinguishable from a fresh one, and
  every way it isn't is a bug that shows up as "the second grenade behaves differently" —
  hours from the code that caused it. So a recycle restores the instance against a
  **template snapshot taken before any spawn option was applied**: the prefab as the
  expander produced it, not wherever the first bullet happened to be fired.
- **`resetOnStop` is the marker, reused.** What leaving Play resets is exactly what a
  recycle must reset — simulation state living outside props (a script instance, an
  animation state machine's position, a playing sound). Those components are *removed on
  despawn and re-added on spawn*, which makes `onStart` / `onDestroy` the spawn / despawn
  hooks with no new script surface to learn. Everything else is restored by diffing
  against the template and writing only what changed.
- **Structural edits refuse recycling.** An instance whose children or components no
  longer match the template is destroyed rather than reused, because the alternative is a
  pool that quietly hands out the wrong thing.
- **Despawn parks, it does not destroy** — out of `engine.entities`, out of the scene, out
  of queries and serialization, `entity.pooled` true. That is also the trap: nothing else
  in the engine hears about an entity that was never destroyed, so anything holding
  per-entity state has to be told. PhysicsSystem listens for `entity-despawned` and
  surrenders the body; the LOD and occlusion vetoes (`_lodHidden` / `_occluded`) are
  cleared on recycle, or an instance parked while its LOD group had it hidden comes back
  invisible and is never told otherwise.
- **The spawn budget** (`engine.pool.budgetMs`) drains a queue of pending instantiations
  across frames, always running at least one item so a zero budget cannot deadlock. A
  queued item that throws rejects its own promise and nothing else.
- **Pooling exposed a latent physics bug rather than introducing one.** The Rapier world
  was built exactly once, at Play: every bullet and enemy spawned afterwards had a
  Rigidbody whose `body` stayed null forever — it never fell, never collided, and nothing
  said so. The mirror was as bad: a destroyed entity left its collider behind, so a
  corridor slowly filled with invisible walls where enemies had died. Registration is now
  incremental, driven off `entity-spawned` / `entity-despawned` and flushed immediately so
  a script's `onStart` can set a velocity on the thing it just spawned.
- **A second silent one, found by the same section.** Mass is set on the *collider*
  descriptor, because that is the only way to get an inertia tensor derived from the actual
  shape. The cost is that a dynamic body with no mass-contributing collider weighs zero —
  and Rapier applies gravity as a force of `mass × g`, so zero mass is zero force, and a
  zero inverse mass swallows every `applyForce` and `applyImpulse` too. The body hangs in
  mid-air ignoring everything while the Inspector reads "Mass: 1". Reached by adding a
  Rigidbody before its Collider, removing a collider at runtime, or leaving a body whose
  only collider is a trigger. A fourth build pass now asks the world for each dynamic
  body's mass *after* the colliders are in it and falls back to the authored value.
- Test: `npm run test:pool` (53 headless checks against the real Engine, the real prefab
  expander and the real Rapier world — no renderer).
- **Instrument note, and it cost a run to find.** Almost every operand in that file is an
  Entity or a Component, and node builds an `AssertionError`'s message *eagerly*, inspecting
  both operands with `depth: 1000` and `getters: true` — on an entity that walks
  entity → engine → scene → all of three.js, invoking every getter on the way. So a
  one-line wrong expectation did not fail: it killed the process twenty seconds later on a
  4 GB heap with no clue which check was to blame, and every check after it went
  unreported. The suite now compares first and describes operands at `depth: 0`, which is
  what turned that into a one-line failure message and surfaced the mass bug hiding behind
  it.

### [x] 16. Splines / paths as a scene tool — **shipped 2026-07-28**
`src/engine/spline/` plus three components (`spline`, `splineFollower`, `splineMesh`), a
`dolly` body mode on the virtual camera, and viewport knot editing. Roads, patrol routes and
camera rails are all the same object with something different pointed at it.

- **One curve representation, three authoring modes.** Catmull-Rom, Bezier and polyline are
  three ways of authoring the same thing — a chain of cubic segments — and the conversion to
  piecewise cubic Bezier is exact for both of the others, not an approximation. So the
  evaluator, the arc-length table, the frames and the closest-point search are written once
  instead of three times, and a bug in any of them cannot exist in only one mode.
- **Every public query is in DISTANCE, never in the curve's parameter.** On a segment twice
  as long as its neighbour a constant `du` travels twice as fast, and every consumer here is
  asking a question about distance: a patrol at 3 m/s, a rail traversed over five seconds, a
  road whose texture must not stretch. `t` means "fraction of the length". The point is
  evaluated from the cubic at the parameter the table returns, not lerped between two
  samples — a lerp cuts the corner by the chord error, which reads as a path that does not
  pass through its own drawn curve.
- **Frames are rotation-minimizing, not Frenet.** The textbook frame comes from the curvature
  vector and is unusable here twice over: it is undefined on a straight section (a road with
  a straight bit has no normal there) and it FLIPS through 180° at an inflection point, which
  is a length of tarmac turning itself inside out between two frames. Double-reflection
  transport has no relationship to curvature, so a straight run keeps the previous
  orientation and an inflection is a non-event. A test walks an S-curve and demands the
  normal stay up through the middle.
- **A closed loop's twist is spread, not dumped at the seam.** Transporting a frame around a
  closed curve lands it rotated about the tangent — a real geometric quantity, not an error.
  Left alone all of it appears at the join, where a closed road meets itself in a visible
  kink. It is measured and distributed by arc length, so there is no seam anywhere rather
  than a bad one in one place.
- **Knots are component data, not child entities** — the opposite call to LOD levels, and for
  the opposite reason. An LOD level *is* an entity (a mesh you select, move and swap); a knot
  has no components, no children and no name, and a forty-knot road would put forty rows in
  the hierarchy for one object. What replaces the hierarchy affordance is the viewport tool.
- **The viewport tool is the feature.** Handles are two instanced meshes (knots, tangents)
  picked by `instanceId`, **sized in pixels** and rescaled every frame — a fixed world radius
  is invisible on a 300m road and the size of a house on a 2m one, and a path is exactly the
  object that spans both. Drag a knot, Ctrl+click the curve to insert one *between the right
  pair* (appending instead sends the road off to wherever you clicked), Shift+click to extend
  onto whatever surface is under the cursor, X to delete, Alt to break a mirrored tangent.
  A drag writes live and commits **one** undo step on release.
- **The gizmo-priority ordering was the subtle part.** The transform gizmo is parked on the
  selected knot, so its arrows lie along the curve. Bailing out early when an arrow is hovered
  (the obvious guard, so gizmo drags keep working) makes every knot along an axis
  unselectable and kills Ctrl+click-to-insert along three lines through the path. The handle
  pick and the modified gestures go first; the gizmo gets the unmodified click it would
  otherwise have lost.
- **Followers put `position` in a plain prop**, which is the whole timeline integration:
  property tracks are derived from component schemas, so a cutscene can key an elevator the
  day the component exists. `speed` is only the convenience of not keying it. Distance is in
  the path's own units, not world metres — otherwise scaling a road would slide everything on
  it, and a key placed at "the corner" would no longer be at the corner. Wrap modes are
  shared with the camera dolly (`advanceAlong`), so a cart and a camera on one rail turn round
  at the same point, and ping-pong reflects repeatedly so a frame hitch or `timeScale: 20`
  can't overshoot past the far end.
- **Followers are ticked by a system, from the engine's own tick, ahead of the update
  callbacks** — because physics is a *module* and registers its callback whenever it is
  enabled. A follower subscribing with `engine.onUpdate` would land wherever load order put
  it, so a moving platform would carry its riders correctly or lag them by a frame depending
  on the day. Driven explicitly, it is always first.
- **The follower applies its pose in the editor, unlike the camera rig's `Preview Rig`.** The
  difference is not inconsistency: a camera's transform is *authored* data that a preview
  would overwrite, while a follower's is *derived* — the only correct value is the one the
  path dictates. The authored transform is still captured and restored when preview is turned
  off or the component removed.
- **Camera rails ride the same path (`body: "dolly"`), and their position is NORMALISED**
  where the follower's is metres. A cart's speed is a physical quantity so its position must
  be in path units; a rail is a *shot* — "one end to the other over five seconds" — so a
  fraction is what a timeline key should hold, and it survives someone extending the track
  afterwards. `autoDolly` projects the follow target onto the rail instead (corridor and
  side-on cameras); a new `aim: "path"` faces along the track. A dolly needs no follow target,
  so it is resolved before the "no target means stay put" fallback that every other body mode
  shares.
- **The Instancer gained a `path` mode** — fence posts, sleepers, street lights, bollards,
  rocks down a riverbank. Two distributions, and the second is the one that matters: `count`
  divides the path into equal shares, `spacing` places one every N units and lets the number
  follow the length, because adding a corner to a fence should add posts rather than respace
  every post already placed. `count` doubles as the allocation ceiling there, since the
  InstancedMesh is sized once and a path someone later stretches must not run past its buffer.
  Alignment is `tangent` (yaw only — a post stays vertical where the path climbs) or `frame`
  (leans with the bank, which is what a guardrail wants and a lamp post does not). A closed
  path divides by n rather than n-1, or the last post lands in the first one's hole and leaves
  a gap opposite. Editing a knot re-lays the instances on a coalesced next-frame pass that
  reuses the buffer instead of re-allocating it.
- **Apply Transform** (`src/engine/geometryTransform.js` + `src/editor/applyTransform.js`),
  Blender's Ctrl+A, in the hierarchy context menu. It exists because everything that consumes
  raw geometry — the instancer, collider fitting, decal projection, the geometry editor's own
  readouts — sees the shape the author built rather than a unit cube with a matrix bolted on.
  An object matrix is `T·R·S`, so baking a *suffix* of that product is exact and baking a
  prefix is not: All, Rotation & Scale and Scale are visually neutral, while Rotation alone is
  only exact under uniform scale and Location alone only when there is no rotation or scale.
  Blender has the same five modes and the same two caveats and is quiet about them; these say
  so in the result. **A primitive's geometry is procedural** — rebuilt from `props.geometry` on
  every attach — so applying to one writes a new `.geom` and repoints the mesh at it, which is
  also the only thing that makes the operation persist; a geometry shared by several meshes is
  forked rather than rewritten (Blender refuses outright, which is correct and unhelpful).
  A mirrored bake **flips the triangle winding**: `applyMatrix4` transforms normals through the
  inverse-transpose and leaves the index order alone, so every face ends up back-facing with a
  perfectly good normal — the mesh renders inside-out and the normals look innocent. Undo is
  exact because a matrix bake is invertible: a fork undoes by repointing the mesh, an in-place
  rewrite by baking the inverse back into the same file.
- **The Instancer gained `bakeSourceTransform`**, the same arithmetic pointed at the same gap.
  It instanced the source mesh's raw buffer, which is right for a Mesh component and wrong for
  a Model: a glTF's meshes are nodes carrying rotation, scale and offset of their own (the
  axis conversion alone puts one on most imported models), so every copy came out rotated,
  mis-sized or displaced next to the model it was copied from, with nothing in the inspector
  to explain it. The option folds that matrix into a private copy — a copy, because baking in
  place would move the model itself — and skips cloning entirely when the matrix is identity.
- A path entity gets its own hierarchy icon, in the same green the curve is drawn in — it
  ranks above `mesh`, because a road carries both the path and the mesh swept from it and the
  path is what the entity is.
- **Roads are swept, not modelled**, because a road is the one piece of level geometry that
  changes every time the level does. The profile is 2D in the frame's own plane, so this file
  contains no orientation logic at all — banking, non-corkscrewing pipes and vertical fence
  posts are all properties of the frame, solved once. **V runs on arc length**, or a road's
  centre line changes dash length as it curves; the rebuild is coalesced to the next frame, so
  dragging a knot across a 200m road re-sweeps once per frame rather than once per pointer
  event.
- Tests: `npm run test:spline` (85 headless checks), `npm run test:applytransform` (29, most of
  them asserting a point does not move under an "exact" mode), and `npm run smoke:spline` (41 driving the
  real editor and a real WebGPU frame — a click on a real handle, a real Ctrl+click insert, a
  pixel readback proving the road is on screen and that it moves when a knot does).
- **The smoke earned its keep on its first run**, and with the failure this codebase already
  has a name for: `splineEditing.js` kept its handles, its in-flight drag and its
  "which spline was I last looking at" latch in module-level `let`s. Vite serves a touched
  module as both `foo.js` and `foo.js?t=…`, so the harness's copy had its own — a second,
  invisible set of handle meshes, and a latch that cleared the knot selection the first time
  it ran. The gizmo moved and the knot did not. All mutable state now lives in the
  `vmSingleton`, which is also what stops an HMR update breaking dragging mid-session.

- **[ ] 17.** Localization, runtime input rebinding UI, accessibility options
- **[ ] 18.** Blendshape/morph control, ragdoll ↔ animation blending
- **[ ] 19.** Networking/multiplayer — large scope, narrow audience, last

---

## Cross-cutting

- **[ ] Template game project.** One small complete game — third-person character, three
  levels, menu, save, one enemy type. Fastest way to validate this ordering, becomes a
  regression test, and doubles as a "New Project → Third Person" template. Run it in
  parallel with Tier 0.
- **[ ] CI.** ~20 smoke/test scripts exist and nothing runs them automatically. A workflow
  running `check:types` + the test scripts on push is cheap insurance.
- **[ ] Refresh `HANDOFF.md`.** It stops at 2026-07-05 and misses GI, terrain, the geometry
  editor, audio, input, UI, MCP and virtual geometry.
