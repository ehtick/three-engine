// @ts-check
import { create } from "zustand";
import { ensureEngine } from "../engineInstance.js";
import { vmSingleton, oncePerVm } from "../singleton.js";
import { freeze } from "../../engine/freezeLedger.js";

/**
 * How the mirror has been brought up to date, counted.
 *
 * `CommandBus.#afterMutation` reads these to answer ONE question: "did an
 * engine event already re-read the mirror for this mutation?" It used to call
 * `refresh()` unconditionally and the "hierarchy-changed" listener called it
 * AGAIN a microtask later, so a single edit rebuilt the mirror of every entity
 * TWICE with fresh object identities — which is why every Hierarchy row
 * re-rendered on a light-intensity edit (ZERO_FREEZE_PLAN §2.4 step 3).
 *
 * A plain object rather than store state: nothing renders from it, and putting
 * it in the store would make every mirror write a store publish of its own.
 */
export const sceneMirrorStats = { full: 0, incremental: 0 };

/**
 * The plain-data row shape the hierarchy renders (and hierarchySearch matches
 * against). The two enabled flags are mirrored so a structured search can
 * filter on them (`?enabled=true` = the row's eye icon, `enabledInGame` = the
 * play-time one). Both are set through commands that emit "hierarchy-changed"
 * and therefore land here via refresh() — but a DIRECT write to the entity's
 * flag bypasses refresh() and will lag in the mirror until the next refresh,
 * so the search box can briefly disagree with the engine about a flag nobody
 * changed through a command.
 */
/**
 * Unique ids preserving first-occurrence order. The engine's parent/child
 * graph is a tree, so a duplicate here means a corrupted tree; the mirror
 * de-dupes them so React never sees two rows with the same key from a
 * single parent (`HierarchyPanel` keys rows by id).
 */
function uniqueIds(items, getId = (it) => it.id) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const id = getId(it);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function mirrorEntity(entity) {
  return {
    id: entity.id,
    name: entity.name,
    parentId: entity.parent?.id ?? null,
    childIds: uniqueIds(entity.children),
    transform: entity.getTransform(),
    tags: [...(entity.tags ?? [])],
    components: Object.fromEntries(
      [...entity.components.values()].map((c) => [c.type, { ...c.props }]),
    ),
    enabled: entity.enabled !== false,
    visibleInEditor: entity.visibleInEditor !== false,
    // The old per-mode keys, for readers not yet moved: the editor one is the
    // viewing aid, the game one is `enabled`.
    enabledInEditor: entity.visibleInEditor !== false,
    enabledInGame: entity.enabled !== false,
  };
}

/**
 * Read-only mirror of the engine's entity tree for React rendering.
 * The three.js scene stays the source of truth; commands mutate the
 * engine, then call refresh() (or updateTransform for live gizmo drags).
 */
export const useSceneStore = vmSingleton("sceneStore", () =>
  create((set, get) => ({
    sceneName: "Untitled",
    scenePath: null,
    rootIds: [],
    entities: {}, // id -> mirror
    dirty: false,

    // refresh/updateTransform run inside React store actions, which fire only
    // after EditorShell has mounted and resolved `ensureEngine()`. Belt and
    // braces: guard against the load-not-yet-finished race so a stray call
    // during boot doesn't throw on the Proxy.
    refresh(scenePath = undefined) {
      const inst = engineInstanceCache;
      if (!inst) return;
      const token = freeze.begin("sceneStore:refresh");
      try {
        const entities = {};
        for (const entity of inst.entities.values()) {
          entities[entity.id] = mirrorEntity(entity);
        }
        set((state) => ({
          entities,
          rootIds: uniqueIds(inst.rootEntities),
          sceneName: inst.sceneName,
          ...(scenePath !== undefined ? { scenePath } : { scenePath: state.scenePath }),
        }));
        sceneMirrorStats.full++;
      } finally {
        freeze.end(token);
      }
    },

    /**
     * ── ONE ENTITY, NOT ALL OF THEM (2026-09-07, ZERO_FREEZE_PLAN §1.2) ────
     *
     * Re-mirrors the entity that changed and LEAVES EVERY OTHER MIRROR OBJECT
     * ALONE. That identity stability is the whole point: `refresh()` allocates
     * a fresh `{...c.props}` per component per entity, so after it ran every
     * Hierarchy row's props were a new object and every memoised row
     * re-rendered — on a light-intensity edit, twice. Here only the touched
     * entity's object changes identity, so React re-renders one row.
     *
     * Deliberately NOT a place to notice structure: a new entity, a removed
     * one, a re-parent and a component add/remove all emit "hierarchy-changed"
     * and `refresh()` owns them. An id this mirror has never seen is skipped
     * rather than inserted, because inserting it without its `rootIds`/
     * `childIds` context would publish a tree that does not close.
     */
    refreshEntity(id) {
      const inst = engineInstanceCache;
      if (!inst) return;
      const entity = inst.getEntity?.(id);
      if (!entity || !get().entities[id]) return;
      // The map object has to be replaced for zustand to see a change; the
      // spread copies REFERENCES (one per entity), not mirrors, so it costs a
      // fraction of what re-mirroring the scene costs. See updateTransform.
      set((state) => ({ entities: { ...state.entities, [id]: mirrorEntity(entity) } }));
      sceneMirrorStats.incremental++;
    },

    /**
     * Refreshes the mirrored transform of one entity or a batch of them.
     *
     * Accepts an array because the map object has to be replaced for zustand to
     * see a change, and that spread is proportional to SCENE SIZE, not to how
     * many entities moved. Calling this in a loop while dragging a 100-entity
     * multi-selection therefore copied a scene-sized object 100 times per
     * pointermove. One call, one spread.
     */
    updateTransform(ids) {
      const inst = engineInstanceCache;
      if (!inst) return;
      const list = Array.isArray(ids) ? ids : [ids];
      if (!list.length) return;
      set((state) => {
        let entities = null; // cloned lazily, at most once
        for (const id of list) {
          const entity = inst.getEntity(id);
          const previous = state.entities[id];
          if (!entity || !previous) continue;
          entities ??= { ...state.entities };
          entities[id] = { ...previous, transform: entity.getTransform() };
        }
        return entities ? { entities } : {};
      });
    },

      setScenePath(scenePath) {
        set({ scenePath });
      },

      /** Updates scene chrome without rebuilding the O(N) entity mirror. The
       * hierarchy transaction already published that mirror exactly once. */
      setSceneMeta(sceneName, scenePath) {
        set({ sceneName, scenePath });
      },

      markDirty(dirty = true) {
        set({ dirty });
      },
  })),
);

// Cached singleton handle so refresh/updateTransform can read the engine
// without going through the throwing Proxy.
let engineInstanceCache = null;

/**
 * Hands the mirror an engine directly.
 *
 * The editor fills this from `ensureEngine()` below. It is exported for the
 * headless test of `refreshEntity`: whether an untouched entity's mirror keeps
 * its OBJECT IDENTITY across an edit is the entire point of unit §1.2 (React
 * re-renders on identity, so losing it means the incremental path bought
 * nothing), and it cannot be observed from outside this module.
 */
export function attachSceneEngine(engine) {
  engineInstanceCache = engine;
}

// Subscribe to engine events once the lazy engine has resolved. EditorShell
// calls `await ensureEngine()` in its mount effect, but we also kick off the
// load here so that subscribers attached by external modules (e.g. the
// autosave interval) start firing as early as possible.
//
// `oncePerVm` because a re-evaluated copy of this module would otherwise add a
// second "hierarchy-changed" listener that refreshes the same store again —
// harmless in outcome, but it doubles a scene-sized mirror rebuild on every
// tree change, and the count grows with each hot reload.
// `typeof document` because a headless import (node --test, for the mirror's
// own unit test) has no editor to attach to, and `ensureEngine()` would pull in
// the Tauri asset layer and reject where nothing can handle it.
if (oncePerVm("sceneStore.subscribe") && typeof document !== "undefined") {
  ensureEngine().then((engine) => {
    engineInstanceCache = engine;
    // STRUCTURE: entities appearing/disappearing/moving in the tree, and the
    // structural props of §1.1. Only this rebuilds the whole mirror.
    // `__label` is how Engine._invoke names a listener in `profile.edit`; an
    // anonymous one shows up as a blank row, which is exactly the row you need
    // to read when an edit is expensive.
    const refreshAll = () => useSceneStore.getState().refresh();
    refreshAll.__label = "sceneStore.refresh";
    engine.on("hierarchy-changed", refreshAll);
    // VALUES: one entity's props changed. This is what keeps the inspector's
    // controlled inputs live now that an ordinary prop edit no longer emits
    // "hierarchy-changed" — and it costs one mirror instead of `entityCount`.
    const refreshOne = (info) => {
      if (globalThis.__editorMirrorIncremental === false) return refreshAll();
      if (info?.entityId) useSceneStore.getState().refreshEntity(info.entityId);
    };
    refreshOne.__label = "sceneStore.refreshEntity";
    engine.on("component-changed", refreshOne);
  });
}
