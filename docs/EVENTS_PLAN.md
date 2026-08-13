# Events — making the bus a first-class authoring surface

Status: **all five phases shipped 2026-08-12, plus the three follow-ups that
were originally scoped out** (script-method discovery + stub generation, the
node graph, project-wide script type codegen). Extends the emitter work shipped
2026-08-04/05 (`45fa864`).

## What shipped

### Follow-ups — the three "not built" items, built

**I argued against the node graph and was wrong.** The argument was that flat
rows "fit the shapes people actually build" — an argument about the median case
when the ask was about the ceiling — plus "Shader Graph exists for real graphs",
which is close to backwards: those prove the toolkit works here. The real case
is that rows cannot express **control flow or data flow**: no
`if health < 20 then A else B`, no "spawn a crate, then set a prop on the crate
you just spawned", no fan-in where three triggers share one chain. Blueprints
are the mainstream answer for exactly that. All three now have a test named
after them in `test:eventbindings`.

- `src/engine/events/graph.js` — node table + runtime. Control is PUSHED along
  `event`-typed sockets (already exclusive in the toolkit, so a control wire
  physically cannot land in a data socket); data is PULLED and memoised per run,
  so a value feeding three inputs is computed once and one nobody reads is never
  computed. Actions are DERIVED from `ACTION_KINDS`, so rows and graph cannot
  drift. An exec cycle is bounded by a step budget rather than banned — a loop
  is a legal pattern; a data cycle resolves to `null` once.
- `EventGraphPanel` + `eventGraphRegistry` on the shared `nodegraph/` toolkit.
  One widget added to `GraphNode.jsx` (`string`), because a `code` textarea for
  a method name reads as "write some code here".
- **Rows and graph both run and are NOT two views of one thing.** Converting a
  branch into rows is lossy, and a lossy round-trip through an editor is how
  authored work quietly disappears.
- `src/editor/scriptIntrospect.js` — parses a project's script sources for class
  names and methods. Source text, not the loaded class: the script on the entity
  you are wiring may never have run. It refuses to guess — a destructured
  parameter reports unknown arity rather than an invented name.
- `src/editor/scriptStubs.js` + the `call` action's method picker — Godot's
  connect-and-generate. Insertion walks brace depth to the class's own closing
  brace; appending at the last `}` in the file would put the method *outside*
  the class, which saves fine and does nothing.
- `src/editor/projectScriptTypes.js` → `<project>/project-scripts.d.ts`, closing
  `getScript` and `dispatch` over `ScriptMap` / `ScriptHookMap`. **This is the
  standing "accepted gap" from the no-strings rule, now closed** — it was only
  ever true of the engine repo, and the editor has the project open. Parameter
  TYPES stay `any` (a script's annotations name types from its own module scope
  and would not resolve from the project root) but names and arity are real, so
  a missing argument is an error and autocomplete shows the label.

### Phase 3 — inspector wiring

- `src/engine/events/actions.js` — `ACTION_KINDS`, one table of 12 actions read
  by BOTH the inspector (to render each editor from `fields`) and the runtime
  (to execute via `run`). Adding an action is one entry plus one line in
  `ENTITY_FIELDS`; there is no third place.
- `EventBindingComponent` (`type: "events"`) — rows of
  `WHEN <source> THEN <actions…>` with `once` / `deferred` / `delay` / `enabled`.
  Five sources: engine, entity, component, input, lifecycle.
- `UiButtonComponent` gained `onClick` / `onPointerEnter` / `onPointerExit` /
  `onFocus` / `onBlur` as `actions` props — Unity's `Button.onClick`, in the
  same place Unity puts it. Additive: the script `dispatch` and the global
  `ui-click` still fire, in that order.
- `src/editor/components/EventSections.jsx` — `ActionList` (reusable, used by
  both) and `EventBindingsSection`. Reuses the inspector's own exported
  `PropField`, so an entity picker here is the same picker as everywhere else.
- `sceneManager.remapEntityRefs` handles `type: "actions"` and `type: "bindings"`.

**Argument tokens** — `$0`, `$cause`, `$self` pipe the triggering event's own
payload into an action. Godot's connection binds can only append constants and
Unity's persistent listener carries exactly one static argument and cannot see
the payload at all, so this is strictly past both.

### Phase 4 — script ergonomics

- `@listen("name")` (`src/engine/scriptRuntime/listen.js`) — subscribes on
  script start, unsubscribes on stop, across hot reload. `{ on: "entity" }` and
  `{ on: "input" }` pick the bus; `{ once: true }` self-cancels. Typed through
  the same maps, so a typo is a compile error.
- `EventEmitter.waitFor(event, { timeout })` → `Promise<args[] | null>` on every
  bus. Godot's `await some_signal`, which `once` could not express.

**Two real bugs found while wiring `@listen` into `ScriptComponent`**, both in
the hot-reload path and both invisible until an author edits a running script:
the branch that calls `onHotReload` skips `#reconcileSlotRunning`, so the new
instance was never subscribed (a script with `onHotReload` silently stops
hearing its events after the first edit); and neither branch detached the OLD
instance, so its handlers kept running the previous version of the code against
a discarded object — a reload that makes a script fire twice, once as it was and
once as it is.

### Phase 1 + 2 + 5

- `src/engine/events/catalog.js` — pure catalog: validate, normalize, generate
  the `.d.ts`. Imports nothing.
- `src/engine/events/EventRegistry.js` — `engine.events`; catalog queries plus
  the emission monitor's ring buffer.
- `EventEmitter.monitor` (static tap, `null` by default) + `listenerCount`.
  The tap fires BEFORE the no-listener early return, so a zero-listener emit is
  recorded — that is the case people are actually debugging.
- `Engine.applyEvents(json)` + the `events-changed` engine event, shaped like
  `applyInput`. Wired at all three boot sites (`EditorChrome`, `player/main`,
  `player/liveUpdate`) and into `exportGame`.
- `src/editor/projectEventTypes.js` → `<project>/project-events.d.ts`, plus a
  replaceable Monaco extra-lib (`registerExtraLib`) so the in-editor Code panel
  isn't the one place a project's own events fail to autocomplete.
- `src/editor/eventUsages.js` — find/rename an event across project scripts.
- Events panel + `eventsStore`, registered at all five touchpoints
  (`EditorShell` lazy import, panel map, panel title/position, `MenuBar`,
  `QuickSearch`).
- `src/editor/api/ops/events.js` — 12 ops (`list`, `define`, `update`, `rename`,
  `remove`, `usages`, `emit`, `monitor`, `actions`, `bindings`, `bind`,
  `unbind`). `events.actions` publishes the action vocabulary so an assistant
  wires a door from a described schema rather than guessing at an opaque blob.
- Tests: `npm run test:events` (44 checks, including a drift guard that reparses
  `EngineEventMap` out of `engine.d.ts`), `npm run test:eventtypes` (runs the
  real `tsc` over a synthetic scaffolded project), and
  `npm run test:eventbindings` (45 checks over actions, the binding component,
  `@listen` and `waitFor`).

⚠ **`defineOp` takes `run`, not `handler`** — and it throws at import time, so
the editor fails to boot while the build, the type check and every source-scan
test still pass. That shipped once here. `test:mcp-coverage` now asserts every
`defineOp` block contains a `run`.

**The two traps, both confirmed by a test rather than by reasoning.** The
tsconfig's `exclude: ["engine-types"]` really does make an augmentation written
there compile to nothing — `test:eventtypes` asserts that placement FAILS, so
the day the exclude changes, the test says so. And `applyEvents` emits
`events-changed`, which the store subscribes to; without a re-entrancy guard the
echo re-hydrates on every keystroke, clearing `dirty` (Save never lights up) and
clearing the selection (the row deselects mid-word).

⚠ `inputStore.js` has this second bug for real: `patch()` sets `dirty: true`
then calls `applyInput`, whose `input-changed` echo runs `hydrate()`, which sets
`dirty: false` **and** `selectedMap: null, selectedAction: null`. Left alone —
it is pre-existing and outside this change — but it is the same shape, and the
Input panel's Save button and selection are the visible symptoms.

## Where we actually are

Verified against the tree, not memory:

- `src/engine/EventEmitter.js` — `on`/`once`/`off`/`emit`/`emitAsync`/
  `callAll(-Async)`/`callFirst(-Async)`/`clear`. Solid; nothing to fix here.
- Four typed buses, all closed over an event map in `engine.d.ts`:
  `Engine`→`EngineEventMap`, `Entity`→`EntityEventMap` (**ships empty**),
  `Component`→`ComponentEventMap` + a per-type merge, `InputManager`→
  `InputEventMap`.
- `entity.dispatch(hook, ...)` — method-call fan-out to every script on the
  entity. Deliberately separate from the buses; stays that way.
- `UiButtonComponent.click()` → `dispatch("onClick")` on same-entity scripts +
  `engine.emit("ui-click", entity)`. **There is no way to make a button do
  anything to another entity without writing a script.**
- `src/editor/projectTypes.js` scaffolds `<project>/engine-types/*.d.ts` and a
  `tsconfig.json` whose `paths` point at them.
- `src/editor/code/monaco.js:221` feeds the same `engine.d.ts` to the embedded
  editor via `addExtraLib`.
- `src/engine/scriptRuntime/autobind.js` — a working legacy-style
  (`target, key, descriptor`) decorator, re-exported from `runtime.js`. The
  scaffolded tsconfig already sets `experimentalDecorators: true`.

### The five real gaps

1. **No project event catalog.** A game's own events need a hand-written
   `declare module "engine"` merge that the user must author and maintain.
2. **No editor wiring, at all.** Every connection is code. A designer cannot
   make a button start the game.
3. **No visibility.** Nothing answers "who listens to `player-died`?" or "what
   fired last frame?".
4. **No connection-level semantics** — no one-shot, no deferred, no delay.
5. **No await.** `once` returns an unsubscribe, not a promise.

## What we take from Godot and Unity

| | Godot | Unity | Us |
|---|---|---|---|
| Declaration | `signal died(cause)` on the class, typed | `UnityEvent` field, or a ScriptableObject asset | **Project catalog** with typed params → codegen'd into `EngineEventMap` |
| Editor wiring | Signals dock: node → signal → target node → method, generates the stub | Inspector list: target object + method + one static arg (reflection) | **`Events` component**: `WHEN <source> THEN <actions…>`, fixed action vocabulary — no reflection |
| Per-connection flags | deferred, one-shot, binds | none | once, delay, deferred, enabled |
| Arg flow | binds append *constants* | one static arg, no pass-through | **`$0`/`$cause` token** pipes an event's own args into an action |
| Auto-unsubscribe | manual `disconnect` | `OnEnable`/`OnDisable` boilerplate (the #1 leak source) | **`@listen`** decorator: subscribe on start, unsubscribe on destroy |
| Await a signal | `await sig` | no | `engine.waitFor(name, { timeout })` |
| Who's listening | static connections only | nothing | **panel usages column + live monitor** |
| Decoupled global events | autoload EventBus idiom | ScriptableObject GameEvent assets | the catalog *is* the bus — no asset per event |

Two things neither engine has, and where the win is: **the name is
type-checked end to end** (panel → codegen → `@listen` → `emit`, no strings
anywhere), and **a live monitor** during Play.

## Phase 1 — catalog + codegen

The "automatically available in scripts" half. Nothing here has UI.

**Storage**: a `events` block in `project.json`, exactly mirroring how `input`
already lives there. Rejected: one asset per event (Unity's GameEvent). It buys
drag-and-drop into inspector slots, which a typed dropdown gives us anyway, and
costs a file per event plus a second thing to keep in sync.

```jsonc
"events": [
  { "name": "player-died", "scope": "global", "category": "Gameplay",
    "description": "Fired when the player runs out of health.",
    "params": [{ "name": "cause", "type": "string" }] }
]
```

`scope`: `"global"` (→ `EngineEventMap`) or `"entity"` (→ `EntityEventMap`).
Param types are the intersection of *typeable* and *inspector-editable*:
`number | string | boolean | vec3 | color | entity | asset | any`.

**Files**

- `src/engine/events/catalog.js` (new) — pure: normalize, validate (name shape,
  duplicate names, reserved names already in `EngineEventMap`), and emit the
  `.d.ts` text. Engine-side so the exporter can reuse it.
- `src/engine/Engine.js` — `applyEvents(json)` + an `events-changed` engine
  event, mirroring `applyInput` at `Engine.js:586`. Read at boot from
  `project.json` where `input` is read.
- `src/editor/projectEventTypes.js` (new) — writes the generated declaration.

**Trap — where the generated `.d.ts` goes.** The scaffolded tsconfig is
`include: ["**/*.ts", …]`, `exclude: ["node_modules", "engine-types", "dist"]`.
A `declare module` file written *into* `engine-types/` is excluded and would
silently do nothing. Write it to **`<project>/project-events.d.ts`** (project
root, matched by `include`, not excluded). Never mind that it sits next to the
user's files — it is generated, has a "do not edit" banner, and being visible is
a feature.

**Trap — Monaco.** `monaco.js` must `addLib` the generated text as a second
extra lib and re-add it on `events-changed` (same URI replaces).

## Phase 2 — the Events panel

`src/editor/panels/EventsPanel.jsx` + `src/editor/store/eventsStore.js`, both
modelled on `InputPanel.jsx` / `inputStore.js` (patch pushes to the live engine
immediately, an explicit Save commits to `project.json`). Store must be a
`vmSingleton` — see the module-duplication rule.

- Left rail: categories. Main pane: events with name, params, description.
- **Rename is a refactor, not a text edit.** Renaming retargets every binding in
  every open scene and reports script-source sites it found by grep. Shipping
  rename without this makes the panel a footgun; Godot doesn't do it either and
  it is a known misery.
- **Usages** column: binding count (scan the scene) + live listener count.
- **Monitor** tab: ring buffer of recent emissions during Play — name, args,
  listener count, emitter. Recording is opt-in, armed only while the panel is
  open, so it costs nothing in a normal session.

Registration is 3 touchpoints: `EditorShell.jsx` lazy import, `EditorShell.jsx`
panel map, `MenuBar.jsx` `openPanel("events")`.

## Phase 3 — wiring in the inspector

The half that makes it usable without scripts.

**A reusable field type `"actions"`**, rendered by a new `ActionListField`
section in `InspectorPanel.jsx` (same shape as the existing `ScriptsSection` /
`LinePointsSection` custom sections). Any component can declare a prop of this
type. That is the Unity `UnityEvent` field, generalized.

**`EventBindingComponent`** (`type: "events"`, label "Events") — rows of:

```
WHEN <source>  THEN <action…>          [once] [delay] [deferred] [enabled]
```

`when.source` is one of:

- `engine` — an event name from the catalog **or** a built-in `EngineEventMap`
  name (typed dropdown, grouped)
- `entity` — target entity (defaults to self) + an `EntityEventMap` name
- `component` — a component on this entity + one of its events
  (`changed`, `finished`, `looped`, `state-changed`)
- `input` — an action name + press/release
- `lifecycle` — start / destroy / enable / disable

Action vocabulary v1 — a fixed list, deliberately *not* Unity's reflection over
arbitrary methods:

`emit` (chains catalog events — this is the EventBus pattern) · `call` (a method
on a script on a target entity; we generate the stub like Godot does) ·
`setProp` · `setActive` · `playSound` · `playAnimation` · `playTimeline` ·
`spawnPrefab` · `destroyEntity` · `loadScene` · `setSaveValue` · `log`.

Each action's arguments are typed, and any argument accepts a **`$cause` /
`$0` token** that pipes the triggering event's own argument through. Godot's
binds can only append constants; Unity can't do this at all.

**UiButton** gains `onClick` / `onPointerEnter` / `onPointerExit` / `onFocus` /
`onBlur` as `"actions"` props — Unity's `Button.onClick`, in the same place
Unity puts it. The existing `dispatch("onClick")` and `engine.emit("ui-click")`
stay, so nothing breaks.

**Traps**

- Binding rows reference entities by id → prefab instantiation and scene load
  must remap them. The timeline's `entityMap` remap is the precedent to copy.
- Bindings must unsubscribe on Stop. `Component.resetOnStop` is the hook.

## Phase 4 — script ergonomics

- **`@listen("player-died") onDied(cause) {}`** — subscribe on start,
  unsubscribe on destroy, no boilerplate. Same legacy-decorator shape as
  `autobind.js`. Typed: the name is `keyof EngineEventMap` and the method's
  parameters are checked against the tuple, so the codegen'd catalog is what
  makes it type-safe. Second arg `{ target: "entity" }` for the local bus.
- **`engine.waitFor(name, { timeout })` / `entity.waitFor(...)`** →
  `Promise<args>`. Godot's `await signal`, which we currently can't express.

## Phase 5 — MCP + tests (not optional)

Ops in a new `src/editor/api/ops/events.js`: `events.list`, `events.define`,
`events.update`, `events.remove`, `events.emit`, `events.bindings`,
`events.bind`, `events.unbind`, `events.monitor`. Plus the `test:mcp-coverage`
entry.

Tests: extend `scripts/run-events-test.mjs`; new
`scripts/run-event-bindings-test.mjs` (a binding fires, respects `once`/`delay`,
unsubscribes on stop, survives a scene reload with remapped entity ids).

Exporter: confirm `exportGame.js` carries the `events` block into the shipped
`project.json` — bindings ride along already as component props.

### Third round — the three "still not built" items, built

- **Real parameter types on `dispatch`.** I said this needed a generated file
  per script so imported types resolve. It did not: the generated file now says
  `ScriptHookArgs<ScriptMap["Health"], "damage">` and lets TypeScript read the
  signature off the class, which is referenced by `import("./scripts/Health")` —
  inside that module, where every type in it already resolves. So the REAL
  types flow through, imported ones included, and the generator never has to
  understand any of them. `dispatch("open", "fast")` where the script says
  `speed: number` is now a compile error, proven by real `tsc`. A hook several
  scripts declare becomes the UNION of their signatures rather than the old
  `any[]` give-up.
- **Method picker in the graph.** `cachedProjectScripts` is a synchronous
  accessor the panel warms on mount, so `describe()` can offer real methods
  without awaiting. Cold falls back to a text input rather than an empty
  dropdown — an empty dropdown reads as "this script has no methods".
- **Live graph debugging.** The runtime takes an opt-in `trace` Map, the
  component arms it only while the graph panel is open, and the panel polls a
  sequence counter (unchanged ⇒ nothing ran ⇒ no React work). Nodes light green
  while running and fade over four seconds, so a branch taken a moment ago is
  still readable. `GraphEditor` gained a `nodeClasses` prop, symmetric with the
  `nodeErrors` it already had.

### UI pass on the Events panel

The first version leaned on `.inspector-panel.empty` for its empty states.
**That class is `display:flex` with no `flex-direction`**, so a text node beside
a sibling element becomes two columns of one word each — which is exactly what
it did. Purpose-built states now: the rail says one line, and the right pane
(the panel's biggest surface, previously spending all of it on "Pick an event on
the left") is a real starting point with three one-click starter events, since
the hard part of beginning a catalog is knowing what shape an event should be.
Catalog rows read as signatures — `score-changed(total)` — because the list is
what you scan to remember what an event takes, and a count of `1` does not
answer that.

**Also fixed: `eventsStore` cached the engine in a module-level `let` while the
store itself is a `vmSingleton`.** Under Vite's module duplication the two
diverge — same store object, second module scope, cached variable never
assigned — and every action early-returns, so the panel's buttons silently do
nothing. It now reads the shared proxy. `inputStore.js` still has the
cached-variable shape.

## Still not built

- **Rows ⇆ graph conversion.** Deliberate: it is lossy in the direction that
  matters and both representations run, so nothing forces a choice.
- **`$token` autocomplete in the row editor.** The argument fields accept
  `$0`/`$cause` but do not suggest them; the event's parameter list is right
  there and could.
