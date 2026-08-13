// @ts-check
/**
 * Actions — what a wired-up event actually DOES.
 *
 * This is the engine's answer to Unity's `UnityEvent` (a list of persistent
 * listeners on a component, which is what `Button.onClick` is) and to Godot's
 * signal connections (signal → target node → method). Both let a designer wire
 * behaviour without writing a script, and this file is the shared half of
 * doing the same: one table of action kinds, read by the inspector to render
 * the editor and by the runtime to execute.
 *
 * ## Why a fixed vocabulary instead of Unity's reflection
 *
 * Unity's inspector lists every public method on the target object and calls
 * the one you pick, by name, through reflection. It is more open than what is
 * here — and it is also why a renamed method silently unhooks every button
 * that called it, with no error until someone clicks. A closed table means the
 * editor can show real, typed fields per action (an entity picker, an asset
 * picker, a component's actual property list) and a broken wire is visible.
 *
 * The one open door is `call`, which dispatches a named method to the target's
 * scripts. That is deliberate: it is the escape hatch to arbitrary game code,
 * it goes through the existing `dispatch` mechanism, and it is the only action
 * whose name can't be validated (script hook names are open-ended — the same
 * accepted gap `entity.dispatch` already documents).
 *
 * ## Argument tokens
 *
 * Any action field can hold a token instead of a literal:
 *
 *     "$0"      the triggering event's first argument
 *     "$cause"  the argument named `cause` in the event's catalog entry
 *     "$self"   the entity the binding is on
 *
 * Godot's connection "binds" can only APPEND constants, and Unity's persistent
 * listeners can carry exactly one static argument and cannot see the event's
 * own payload at all. Piping the payload through is the whole point of an
 * event carrying one, so it is here from the start.
 */

/**
 * Fields whose value is an entity id, per action kind.
 *
 * Kept as data rather than discovered by walking, because these ids have to be
 * REMAPPED when a scene is loaded additively or a prefab is instantiated —
 * otherwise the second copy of a level wires itself to the first copy's
 * entities, and the version that reacts is the one you weren't looking at.
 * `sceneManager.remapEntityRefs` reads this through `remapActions` below.
 */
const ENTITY_FIELDS = {
  emit: ["target"],
  call: ["target"],
  setProp: ["target"],
  setActive: ["target"],
  playSound: ["target"],
  playAnimation: ["target"],
  playTimeline: ["target"],
  spawn: ["parent"],
  destroy: ["target"],
  loadScene: [],
  setSave: [],
  log: [],
  wait: [],
};

/**
 * Every action a binding can run.
 *
 * `fields` drives the inspector: each entry is a descriptor in the same shape
 * component schemas use, so the existing field renderers work unchanged.
 * `run` is the runtime. Adding an action is one entry here plus one line in
 * `ENTITY_FIELDS` — there is no third place to update, which is the point.
 */
export const ACTION_KINDS = {
  emit: {
    label: "Emit Event",
    summary: (a) => `emit "${a.event || "…"}"`,
    fields: [
      { key: "event", label: "Event", type: "event" },
      { key: "target", label: "On Entity", type: "entity", when: (a) => a.scope === "entity" },
      { key: "args", label: "Arguments", type: "args" },
    ],
    run(action, ctx) {
      if (!action.event) return;
      const args = resolveArgs(action.args, ctx);
      const def = ctx.engine.events?.get?.(action.event);
      if (def?.scope === "entity") {
        const target = resolveEntity(action.target, ctx);
        target?.emit(action.event, ...args);
        return;
      }
      ctx.engine.emit(action.event, ...args);
    },
  },

  call: {
    label: "Call Script Method",
    summary: (a) => `call ${a.method || "…"}()`,
    fields: [
      { key: "target", label: "On Entity", type: "entity" },
      { key: "method", label: "Method", type: "scriptMethod" },
      { key: "args", label: "Arguments", type: "args" },
    ],
    run(action, ctx) {
      if (!action.method) return;
      const target = resolveEntity(action.target, ctx);
      // `dispatch` reaches every script on the entity, which is the same
      // contract the physics hooks use — a method that isn't there is simply
      // not called, rather than an error.
      target?.getComponent("script")?.dispatch(action.method, ...resolveArgs(action.args, ctx));
    },
  },

  setProp: {
    label: "Set Property",
    summary: (a) => `${a.component || "…"}.${a.key || "…"} = ${a.value}`,
    fields: [
      { key: "target", label: "On Entity", type: "entity" },
      { key: "component", label: "Component", type: "componentType" },
      { key: "key", label: "Property", type: "componentProp" },
      { key: "value", label: "Value", type: "any" },
    ],
    run(action, ctx) {
      if (!action.component || !action.key) return;
      const target = resolveEntity(action.target, ctx);
      const component = target?.getComponent(action.component);
      if (!component) return;
      component.setProp(action.key, resolveValue(action.value, ctx));
    },
  },

  setActive: {
    label: "Enable / Disable",
    summary: (a) => `${a.mode ?? "toggle"} ${a.component || "entity"}`,
    fields: [
      { key: "target", label: "On Entity", type: "entity" },
      {
        key: "component",
        label: "Component",
        type: "componentType",
        description: "Leave empty to affect the whole entity.",
      },
      { key: "mode", label: "Mode", type: "select", options: ["enable", "disable", "toggle"] },
    ],
    run(action, ctx) {
      const target = resolveEntity(action.target, ctx);
      if (!target) return;
      const mode = action.mode ?? "toggle";
      if (action.component) {
        const component = target.getComponent(action.component);
        if (!component) return;
        component.setProp("enabled", mode === "toggle" ? !component.enabled : mode === "enable");
        return;
      }
      // `enabledInGame`, not `enabledInEditor`: an entity has a flag per mode
      // and bindings only ever run while playing, so the editor flag is not the
      // one being asked about. (There is no plain `entity.enabled`.)
      const next = mode === "toggle" ? !target.enabledInGame : mode === "enable";
      target.setEnabledInGame(next);
    },
  },

  playSound: {
    label: "Play Sound",
    summary: (a) => `play ${basename(a.asset) || "sound"}`,
    fields: [
      { key: "target", label: "On Entity", type: "entity" },
      {
        key: "asset",
        label: "Clip",
        type: "asset",
        exts: ["wav", "mp3", "ogg", "opus", "flac", "m4a"],
        description: "Leave empty to play the target's own Sound component.",
      },
    ],
    run(action, ctx) {
      const target = resolveEntity(action.target, ctx);
      const sound = target?.getComponent("sound");
      if (!sound) return;
      if (action.asset) sound.setProp("clip", action.asset);
      sound.play?.();
    },
  },

  playAnimation: {
    label: "Play Animation State",
    summary: (a) => `animate → ${a.state || "…"}`,
    fields: [
      { key: "target", label: "On Entity", type: "entity" },
      { key: "state", label: "State", type: "string" },
    ],
    run(action, ctx) {
      if (!action.state) return;
      const target = resolveEntity(action.target, ctx);
      target?.getComponent("animation")?.play?.(action.state);
    },
  },

  playTimeline: {
    label: "Control Timeline",
    summary: (a) => `timeline ${a.mode ?? "play"}`,
    fields: [
      { key: "target", label: "On Entity", type: "entity" },
      { key: "mode", label: "Mode", type: "select", options: ["play", "pause", "resume", "stop"] },
    ],
    run(action, ctx) {
      const target = resolveEntity(action.target, ctx);
      const director = target?.getComponent("timeline");
      if (!director) return;
      const mode = action.mode ?? "play";
      director[mode]?.();
    },
  },

  spawn: {
    label: "Spawn Prefab",
    summary: (a) => `spawn ${basename(a.prefab) || "prefab"}`,
    fields: [
      { key: "prefab", label: "Prefab", type: "prefab" },
      { key: "parent", label: "Parent", type: "entity", description: "Leave empty for the scene root." },
      { key: "at", label: "At", type: "entity", description: "Spawn at this entity's position." },
    ],
    run(action, ctx) {
      if (!action.prefab) return;
      const parent = action.parent ? resolveEntity(action.parent, ctx) : null;
      const at = action.at ? resolveEntity(action.at, ctx) : null;
      // Through the pool: it recycles when a bucket exists for this prefab and
      // creates fresh when one doesn't, so this is the spawn path whether or
      // not the author has set pooling up. Parent and position go in as options
      // rather than being applied after, so the entity is never briefly at the
      // origin under the wrong parent.
      return ctx.engine.pool?.spawn(action.prefab, {
        ...(parent ? { parent } : {}),
        ...(at ? { position: at.position } : {}),
      });
    },
  },

  destroy: {
    label: "Destroy Entity",
    summary: (a) => "destroy entity",
    fields: [{ key: "target", label: "Entity", type: "entity" }],
    run(action, ctx) {
      const target = resolveEntity(action.target, ctx);
      if (!target) return;
      // A pooled instance is PARKED, not destroyed — otherwise a wired-up
      // "destroy the bullet" quietly defeats the pool it was spawned from.
      // Keyed on `_poolGuid` because `despawn` on a non-pooled entity falls
      // through to a real destroy anyway, so calling it blind would work but
      // would read as if pooling were being consulted when it isn't.
      if (target._poolGuid) ctx.engine.pool?.despawn?.(target);
      else ctx.engine.destroyEntity?.(target);
    },
  },

  loadScene: {
    label: "Load Scene",
    summary: (a) => `load ${basename(a.path) || "scene"}`,
    fields: [
      { key: "path", label: "Scene", type: "asset", exts: ["scene"] },
      { key: "mode", label: "Mode", type: "select", options: ["single", "additive"] },
    ],
    run(action, ctx) {
      if (!action.path) return;
      return ctx.engine.loadScene(action.path, { mode: action.mode ?? "single" });
    },
  },

  setSave: {
    label: "Set Saved Value",
    summary: (a) => `${a.store ?? "prefs"}.${a.key || "…"} = ${a.value}`,
    fields: [
      { key: "store", label: "Store", type: "select", options: ["prefs", "save"] },
      { key: "key", label: "Key", type: "string" },
      { key: "value", label: "Value", type: "any" },
    ],
    run(action, ctx) {
      if (!action.key) return;
      const store = action.store === "save" ? ctx.engine.saves?.state : ctx.engine.prefs;
      store?.set?.(action.key, resolveValue(action.value, ctx));
    },
  },

  log: {
    label: "Log Message",
    summary: (a) => `log "${a.message ?? ""}"`,
    fields: [{ key: "message", label: "Message", type: "string" }],
    run(action, ctx) {
      console.log(`[events] ${resolveValue(action.message, ctx)}`);
    },
  },
};

/** Action kind ids, for a `select`'s options list. */
export const ACTION_KIND_IDS = Object.keys(ACTION_KINDS);

const basename = (path) => String(path ?? "").split(/[\\/]/).pop()?.replace(/\.\w+$/, "") ?? "";

/* -------------------------------------------------------------------------- */
/* Value resolution                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Resolves one authored value against the triggering event's payload.
 *
 * Only strings can be tokens, and only ones starting with `$` — so a literal
 * that happens to be "0" stays the string "0", and a number field is never
 * reinterpreted. `$$` escapes a leading dollar for the rare literal that needs
 * one.
 */
export function resolveValue(value, ctx) {
  if (typeof value !== "string" || value[0] !== "$") return value;
  if (value.startsWith("$$")) return value.slice(1);
  const token = value.slice(1);
  if (token === "self") return ctx.self ?? null;
  if (token === "event") return ctx.event ?? null;
  const index = Number(token);
  if (Number.isInteger(index) && index >= 0) return ctx.args?.[index];
  // Named: look the parameter up in the catalog entry for the event that fired.
  const params = ctx.params ?? [];
  const at = params.findIndex((p) => p.name === token);
  return at === -1 ? undefined : ctx.args?.[at];
}

/** Resolves a list of authored argument values. */
export function resolveArgs(args, ctx) {
  if (!Array.isArray(args)) return [];
  return args.map((value) => resolveValue(value, ctx));
}

/**
 * The entity an action targets. An empty target means "the entity the binding
 * is on", which is both the common case and the one that survives being turned
 * into a prefab — a hard-coded id would not.
 */
function resolveEntity(ref, ctx) {
  if (!ref) return ctx.self ?? null;
  if (typeof ref === "object") return ref;
  const resolved = resolveValue(ref, ctx);
  if (resolved && typeof resolved === "object") return resolved;
  return ctx.engine.getEntity?.(resolved ?? ref) ?? null;
}

/* -------------------------------------------------------------------------- */
/* Running                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Runs a list of actions.
 *
 * `ctx` carries `{ engine, self, args, params }` — the engine, the entity the
 * binding lives on, the triggering event's arguments, and the catalog entry's
 * parameter list (so `$name` tokens can be resolved by name).
 *
 * A throwing action is logged and the rest still run. One misconfigured row in
 * a list of six should not silently swallow the other five — that failure is
 * near-impossible to diagnose from the game, because the symptom is "the door
 * opened but the sound didn't play".
 */
export function runActions(actions, ctx) {
  if (!Array.isArray(actions)) return;
  for (const action of actions) {
    if (!action || action.enabled === false) continue;
    const kind = ACTION_KINDS[action.type];
    if (!kind) {
      console.warn(`[events] Unknown action type "${action.type}".`);
      continue;
    }
    const delay = Number(action.delay) || 0;
    if (delay > 0) {
      // On the engine's scheduler, so the delay obeys game time — a wired
      // "explode in 2 seconds" must slow down with bullet time and stop dead
      // when the game is paused, exactly as the same thing written in a script
      // would.
      ctx.engine.time?.after?.(delay, () => runOne(kind, action, ctx));
      continue;
    }
    runOne(kind, action, ctx);
  }
}

function runOne(kind, action, ctx) {
  try {
    kind.run(action, ctx);
  } catch (err) {
    console.error(`[events] Action "${action.type}" failed: ${err?.message ?? err}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Entity-id remapping                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Rewrites every entity id inside an actions list through `idMap`.
 *
 * Called by `sceneManager.remapEntityRefs` for any schema field of type
 * `"actions"`, and by the binding component's own field, so a second copy of a
 * scene (or a prefab instance) wires itself to its OWN entities.
 *
 * Returns the original array untouched when nothing changed, so the caller's
 * cached scene JSON is not needlessly cloned.
 */
export function remapActions(actions, idMap) {
  if (!Array.isArray(actions) || !idMap?.size) return actions;
  let changed = false;
  const next = actions.map((action) => {
    if (!action) return action;
    const keys = ENTITY_FIELDS[action.type] ?? ["target"];
    let copy = action;
    for (const key of keys) {
      const mapped = idMap.get(copy[key]);
      if (!mapped) continue;
      if (copy === action) copy = { ...action };
      copy[key] = mapped;
      changed = true;
    }
    return copy;
  });
  return changed ? next : actions;
}

/**
 * The same, for a binding list — each row's `when` may name an entity too.
 */
export function remapBindings(bindings, idMap) {
  if (!Array.isArray(bindings) || !idMap?.size) return bindings;
  let changed = false;
  const next = bindings.map((binding) => {
    if (!binding) return binding;
    let copy = binding;
    const mappedWhen = idMap.get(binding.when?.target);
    if (mappedWhen) {
      copy = { ...binding, when: { ...binding.when, target: mappedWhen } };
      changed = true;
    }
    const actions = remapActions(binding.do, idMap);
    if (actions !== binding.do) {
      copy = copy === binding ? { ...binding } : copy;
      copy.do = actions;
      changed = true;
    }
    return copy;
  });
  return changed ? next : bindings;
}
