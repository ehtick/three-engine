import { useEffect, useState } from "react";
import { Plus, Trash2, ArrowUp, ArrowDown, ChevronRight, ChevronDown, Zap, FilePlus, Share2 } from "lucide-react";
import { engine } from "../engineInstance.js";
import { useProjectStore } from "../store/projectStore.js";
import { methodsForEntity } from "../scriptIntrospect.js";
import { commandBus } from "../commands/CommandBus.js";
import { SetComponentPropCommand } from "../commands/componentCommands.js";
import { PropField } from "../panels/InspectorPanel.jsx";
import { NumberField } from "../fields/NumberField.jsx";
import { ACTION_KINDS, ACTION_KIND_IDS } from "../../engine/events/actions.js";
import { RESERVED_EVENT_NAMES } from "../../engine/events/catalog.js";

/**
 * Inspector UI for event wiring — the editor half of `engine/events/actions.js`.
 *
 * Two entry points, one body:
 *
 *   - `ActionListField` is the reusable "do these things" list. It is what
 *     Unity's `UnityEvent` field is, and `UiButtonComponent`'s `onClick` uses
 *     it in the same place Unity puts it: on the button.
 *   - `EventBindingsSection` is the `events` component's table of
 *     WHEN → THEN rows, which is Godot's Signals dock without the modal.
 *
 * Every action's editor is generated from `ACTION_KINDS[type].fields`, so the
 * day an action is added to that table it is editable here, with no second
 * place to update. The field renderers come from the inspector's own
 * `PropField` so an entity picker here behaves exactly like an entity picker
 * anywhere else.
 */

let nextId = 1;
const makeId = () => `a${Date.now().toString(36)}${nextId++}`;

/* -------------------------------------------------------------------------- */
/* Action-specific field editors                                               */
/* -------------------------------------------------------------------------- */

/** Every event name that can be listened to or emitted, grouped for a select. */
function eventOptions() {
  const project = engine.events?.list?.() ?? [];
  return {
    project: project.map((e) => e.name),
    // `RESERVED_EVENT_NAMES` is the runtime mirror of `EngineEventMap` — the
    // only list of the engine's own event names that exists outside the types.
    engine: RESERVED_EVENT_NAMES.filter((name) => name !== "events-changed"),
  };
}

function EventSelect({ value, onCommit }) {
  const { project, engine: builtIn } = eventOptions();
  const known = project.includes(value) || builtIn.includes(value);
  return (
    <select className="select-field" value={value ?? ""} onChange={(e) => onCommit(e.target.value)}>
      <option value="">— none —</option>
      {/* A name saved before the event was renamed or deleted would otherwise
          render blank and silently rewrite the row on the next edit. */}
      {!known && value ? <option value={value}>{`${value} (missing)`}</option> : null}
      {project.length > 0 && (
        <optgroup label="This project">
          {project.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </optgroup>
      )}
      <optgroup label="Engine">
        {builtIn.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </optgroup>
    </select>
  );
}

/** The component types actually present on the targeted entity. */
function ComponentSelect({ entityId, targetId, value, onCommit, allowEmpty }) {
  const target = engine.getEntity(targetId || entityId);
  const types = target ? [...(target.components?.keys() ?? [])] : [];
  const known = types.includes(value);
  return (
    <select className="select-field" value={value ?? ""} onChange={(e) => onCommit(e.target.value)}>
      <option value="">{allowEmpty ? "— whole entity —" : "— none —"}</option>
      {!known && value ? <option value={value}>{`${value} (missing)`}</option> : null}
      {types.map((type) => (
        <option key={type} value={type}>
          {type}
        </option>
      ))}
    </select>
  );
}

/** The property keys of whichever component the row names. */
function ComponentPropSelect({ entityId, targetId, componentType, value, onCommit }) {
  const target = engine.getEntity(targetId || entityId);
  const component = componentType ? target?.getComponent(componentType) : null;
  const keys = (component?.constructor?.schema ?? []).map((f) => f?.key).filter(Boolean);
  const known = keys.includes(value);
  return (
    <select className="select-field" value={value ?? ""} onChange={(e) => onCommit(e.target.value)}>
      <option value="">— none —</option>
      {!known && value ? <option value={value}>{`${value} (missing)`}</option> : null}
      {keys.map((key) => (
        <option key={key} value={key}>
          {key}
        </option>
      ))}
    </select>
  );
}

/**
 * The argument list handed to an emit or a script call.
 *
 * Each entry is free text so it can hold either a literal or a `$token`. A
 * typed editor per argument would need the event's catalog entry, which is
 * knowable for `emit` and genuinely is not for `call` (script hook signatures
 * are open-ended) — and one list that behaves the same in both places beats two
 * that don't.
 */
function ArgsField({ value, onCommit, hint }) {
  const args = Array.isArray(value) ? value : [];
  return (
    <div className="event-args">
      {args.map((arg, index) => (
        <div className="event-arg" key={index}>
          <input
            type="text"
            className="text-field"
            value={arg ?? ""}
            placeholder={hint?.[index]?.name ? `${hint[index].name} (${hint[index].type})` : "value or $0"}
            onChange={(e) => onCommit(args.map((a, i) => (i === index ? e.target.value : a)))}
          />
          <button
            className="icon-btn"
            title="Remove argument"
            onClick={() => onCommit(args.filter((_a, i) => i !== index))}
          >
            <Trash2 size={11} />
          </button>
        </div>
      ))}
      <button className="toolbar-btn" onClick={() => onCommit([...args, ""])}>
        <Plus size={11} /> Argument
      </button>
      {args.length > 0 && (
        <div className="event-arg-hint">
          Literal, or <code>$0</code> / <code>$name</code> for the event's own arguments,{" "}
          <code>$self</code> for this entity.
        </div>
      )}
    </div>
  );
}

/**
 * The method a `call` action invokes: a picker over the methods the target's
 * scripts actually declare, plus a "create it" button when the name is new.
 *
 * This is Godot's Signals dock, whose whole trick is that connecting a signal
 * offers the target's real methods AND writes the empty one for you when you
 * want a new handler. Typing a bare string was the alternative, and a typo
 * there is a call that silently does nothing — `dispatch` reaches every script
 * and reports that none handled it, which nothing was watching.
 *
 * Methods are read from the script SOURCE, not from a loaded class: the script
 * on the entity you are wiring may never have run.
 */
function ScriptMethodField({ entityId, targetId, value, onCommit }) {
  const rootPath = useProjectStore((s) => s.rootPath);
  const [methods, setMethods] = useState(null);
  const [creating, setCreating] = useState(false);
  const target = engine.getEntity(targetId || entityId);
  const targetKey = target?.id;

  useEffect(() => {
    let cancelled = false;
    if (!target || !rootPath) {
      setMethods([]);
      return undefined;
    }
    methodsForEntity(target, rootPath).then((found) => {
      if (!cancelled) setMethods(found);
    });
    return () => {
      cancelled = true;
    };
  }, [targetKey, rootPath, target]);

  const callable = (methods ?? []).filter((m) => !m.isHook && !m.isStatic);
  const known = callable.some((m) => m.name === value);
  const slots = target?.getComponent?.("script")?.props?.scripts ?? [];

  /** Appends an empty method to the first script on the target and selects it. */
  const createMethod = async () => {
    const name = window.prompt("New method name:", value || "onEvent");
    if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) return;
    const path = slots.find((s) => s?.path)?.path;
    if (!path) return;
    setCreating(true);
    try {
      const { addMethodToScript } = await import("../scriptStubs.js");
      const ok = await addMethodToScript(path, name);
      if (!ok) return;
      onCommit(name);
      const { regenerateScriptTypes } = await import("../projectWatcher.js");
      await regenerateScriptTypes();
      setMethods(await methodsForEntity(target, rootPath));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="event-method">
      <select
        className="select-field"
        value={known || !value ? (value ?? "") : "__missing__"}
        onChange={(e) => onCommit(e.target.value)}
      >
        <option value="">— none —</option>
        {/* A method that was renamed or deleted would otherwise render blank
            and silently rewrite the row on the next edit. */}
        {value && !known && <option value="__missing__">{`${value} (missing)`}</option>}
        {callable.map((m) => (
          <option key={m.name} value={m.name}>
            {m.name}
            {m.params?.length ? `(${m.params.map((p) => p.name).join(", ")})` : "()"}
            {m.script ? ` — ${m.script}` : ""}
          </option>
        ))}
      </select>
      <button
        className="icon-btn"
        title={
          slots.length
            ? "Create a new method on this entity's script"
            : "The target entity has no script to add a method to"
        }
        disabled={!slots.length || creating}
        onClick={createMethod}
      >
        <FilePlus size={12} />
      </button>
      {methods !== null && !callable.length && slots.length > 0 && (
        <div className="event-arg-hint">
          That script declares no callable methods yet — use ＋ to add one.
        </div>
      )}
      {methods !== null && !slots.length && (
        <div className="event-arg-hint">The target entity has no Script component.</div>
      )}
    </div>
  );
}

/** Dispatches one action field to the right editor. */
function ActionField({ field, action, entityId, onCommit }) {
  const value = action[field.key];
  switch (field.type) {
    case "event":
      return <EventSelect value={value} onCommit={onCommit} />;
    case "componentType":
      return (
        <ComponentSelect
          entityId={entityId}
          targetId={action.target}
          value={value}
          onCommit={onCommit}
          allowEmpty={action.type === "setActive"}
        />
      );
    case "componentProp":
      return (
        <ComponentPropSelect
          entityId={entityId}
          targetId={action.target}
          componentType={action.component}
          value={value}
          onCommit={onCommit}
        />
      );
    case "args":
      return (
        <ArgsField
          value={value}
          onCommit={onCommit}
          hint={engine.events?.get?.(action.event)?.params}
        />
      );
    case "scriptMethod":
      return (
        <ScriptMethodField
          entityId={entityId}
          targetId={action.target}
          value={value}
          onCommit={onCommit}
        />
      );
    default:
      // entity / asset / prefab / select / string / number — the inspector's own
      // renderers, so these behave identically to every other field in the app.
      return <PropField descriptor={field} value={value ?? ""} onCommit={onCommit} />;
  }
}

/* -------------------------------------------------------------------------- */
/* The reusable action list                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One row of the "then do this" list.
 *
 * Collapsed by default and summarised in one line, because the common shape of
 * this list is four short actions and an inspector that shows four expanded
 * forms at once is one nobody can scan.
 */
function ActionRow({ action, entityId, index, count, onChange, onRemove, onMove }) {
  const [open, setOpen] = useState(!action.type);
  const kind = ACTION_KINDS[action.type];
  const set = (key, value) => onChange({ ...action, [key]: value });

  return (
    <div className={`event-action ${action.enabled === false ? "off" : ""}`}>
      <div className="event-action-head">
        <button className="icon-btn" onClick={() => setOpen((v) => !v)} title={open ? "Collapse" : "Expand"}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <select
          className="select-field event-action-kind"
          value={action.type ?? ""}
          onChange={(e) => onChange({ id: action.id, enabled: action.enabled, type: e.target.value })}
        >
          <option value="">— pick an action —</option>
          {ACTION_KIND_IDS.map((id) => (
            <option key={id} value={id}>
              {ACTION_KINDS[id].label}
            </option>
          ))}
        </select>
        {!open && kind && <span className="event-action-summary">{safeSummary(kind, action)}</span>}
        <input
          type="checkbox"
          checked={action.enabled !== false}
          title="Enable this action"
          onChange={(e) => set("enabled", e.target.checked)}
        />
        <button className="icon-btn" title="Move up" disabled={index === 0} onClick={() => onMove(-1)}>
          <ArrowUp size={11} />
        </button>
        <button
          className="icon-btn"
          title="Move down"
          disabled={index === count - 1}
          onClick={() => onMove(1)}
        >
          <ArrowDown size={11} />
        </button>
        <button className="icon-btn" title="Remove action" onClick={onRemove}>
          <Trash2 size={11} />
        </button>
      </div>

      {open && kind && (
        <div className="event-action-body">
          {kind.fields
            // A field can declare `when` to hide itself for irrelevant shapes
            // (an emit's target only matters for a per-entity event).
            .filter((field) => !field.when || field.when(action))
            .map((field) => (
              <div className="event-action-field" key={field.key}>
                <label title={field.description}>{field.label}</label>
                <ActionField
                  field={field}
                  action={action}
                  entityId={entityId}
                  onCommit={(value) => set(field.key, value)}
                />
              </div>
            ))}
          <div className="event-action-field">
            <label title="Seconds to wait before running this action. Uses game time, so a pause pauses it.">
              Delay
            </label>
            <NumberField value={action.delay ?? 0} min={0} step={0.1} onCommit={(v) => set("delay", v)} />
          </div>
        </div>
      )}
    </div>
  );
}

/** A summary line must never take the inspector down with it. */
function safeSummary(kind, action) {
  try {
    return kind.summary?.(action) ?? kind.label;
  } catch {
    return kind.label;
  }
}

/**
 * An editable list of actions, committed as one whole-array undo step.
 *
 * `onCommit` lets the binding component reuse this for a row's nested `do`
 * list; without it, the list writes straight to `componentType.propKey`.
 */
export function ActionList({ entityId, componentType, propKey, actions, onCommit, label }) {
  const list = Array.isArray(actions) ? actions : [];
  const commit =
    onCommit ??
    ((next) =>
      commandBus.execute(
        new SetComponentPropCommand(entityId, componentType, propKey, next, `Edit ${label ?? propKey}`),
      ));

  const move = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    const next = [...list];
    [next[index], next[target]] = [next[target], next[index]];
    commit(next);
  };

  return (
    <div className="event-actions">
      {list.length === 0 && <div className="event-empty">Nothing yet — add an action.</div>}
      {list.map((action, index) => (
        <ActionRow
          key={action.id ?? index}
          action={action}
          entityId={entityId}
          index={index}
          count={list.length}
          onChange={(next) => commit(list.map((a, i) => (i === index ? next : a)))}
          onRemove={() => commit(list.filter((_a, i) => i !== index))}
          onMove={(delta) => move(index, delta)}
        />
      ))}
      <button
        className="toolbar-btn"
        onClick={() => commit([...list, { id: makeId(), type: "", enabled: true }])}
      >
        <Plus size={12} /> Action
      </button>
    </div>
  );
}

/**
 * The `actions`-typed props on a component, each as its own labelled block.
 *
 * Driven by the schema rather than a hard-coded list of `onClick`/`onFocus`,
 * so a component that grows a sixth response list gets an editor for free.
 */
export function ActionListSections({ entityId, componentType, props }) {
  const schema = engine.getEntity(entityId)?.getComponent(componentType)?.constructor?.schema ?? [];
  const fields = schema.filter((f) => f?.type === "actions");
  if (!fields.length) return null;
  return (
    <>
      {fields.map((field) => (
        <div className="event-block" key={field.key}>
          <div className="event-block-title">
            <Zap size={12} /> {field.label}
          </div>
          <ActionList
            entityId={entityId}
            componentType={componentType}
            propKey={field.key}
            label={field.label}
            actions={props[field.key]}
          />
        </div>
      ))}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* The Events component's WHEN → THEN table                                    */
/* -------------------------------------------------------------------------- */

const SOURCES = [
  ["engine", "Engine event"],
  ["entity", "Entity event"],
  ["component", "Component event"],
  ["input", "Input action"],
  ["lifecycle", "Lifecycle"],
];

/** The `when` half of a binding row — what makes it fire. */
function WhenEditor({ when, entityId, onChange }) {
  const set = (patch) => onChange({ ...when, ...patch });
  const source = when.source ?? "engine";
  return (
    <div className="event-when">
      <div className="event-action-field">
        <label>Source</label>
        <select
          className="select-field"
          value={source}
          // Only the source is kept: an event name from the engine bus is
          // meaningless on the input source, and carrying it over produces a
          // row that looks configured and does nothing.
          onChange={(e) => onChange({ source: e.target.value })}
        >
          {SOURCES.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </div>

      {source === "engine" && (
        <div className="event-action-field">
          <label>Event</label>
          <EventSelect value={when.event} onCommit={(v) => set({ event: v })} />
        </div>
      )}

      {source === "entity" && (
        <>
          <div className="event-action-field">
            <label title="Leave empty for this entity.">On Entity</label>
            <PropField
              descriptor={{ key: "target", type: "entity" }}
              value={when.target ?? ""}
              onCommit={(v) => set({ target: v })}
            />
          </div>
          <div className="event-action-field">
            <label>Event</label>
            <EventSelect value={when.event} onCommit={(v) => set({ event: v })} />
          </div>
        </>
      )}

      {source === "component" && (
        <>
          <div className="event-action-field">
            <label>Component</label>
            <ComponentSelect entityId={entityId} value={when.component} onCommit={(v) => set({ component: v })} />
          </div>
          <div className="event-action-field">
            <label>Event</label>
            <select
              className="select-field"
              value={when.event ?? ""}
              onChange={(e) => set({ event: e.target.value })}
            >
              <option value="">— none —</option>
              {/* Universal component events, plus the per-type ones the two
                  components that declare their own actually emit. */}
              {["changed", "destroyed", "finished", "looped", "state-changed"].map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
        </>
      )}

      {source === "input" && (
        <>
          <div className="event-action-field">
            <label>Action</label>
            <input
              type="text"
              className="text-field"
              value={when.action ?? ""}
              placeholder="Jump"
              onChange={(e) => set({ action: e.target.value })}
            />
          </div>
          <div className="event-action-field">
            <label>Edge</label>
            <select
              className="select-field"
              value={when.edge ?? "pressed"}
              onChange={(e) => set({ edge: e.target.value })}
            >
              <option value="pressed">pressed</option>
              <option value="released">released</option>
            </select>
          </div>
        </>
      )}

      {source === "lifecycle" && (
        <div className="event-action-field">
          <label>Phase</label>
          <select
            className="select-field"
            value={when.phase ?? "start"}
            onChange={(e) => set({ phase: e.target.value })}
          >
            <option value="start">on play start</option>
            <option value="stop">on play stop</option>
            <option value="destroy">on destroy</option>
          </select>
        </div>
      )}
    </div>
  );
}

/** A one-line description of a row, for the collapsed header. */
function bindingSummary(binding) {
  const when = binding.when ?? {};
  switch (when.source) {
    case "input":
      return `${when.action || "…"} ${when.edge ?? "pressed"}`;
    case "lifecycle":
      return `on ${when.phase ?? "start"}`;
    case "component":
      return `${when.component || "…"}: ${when.event || "…"}`;
    case "entity":
      return `entity: ${when.event || "…"}`;
    default:
      return when.event || "…";
  }
}

/**
 * The `events` component's editor.
 *
 * A flat list of rows rather than a graph: the shapes people actually build
 * with this are "one trigger, a few responses", and a node canvas for that is
 * more ceremony than the thing it describes. The Shader Graph and Particles
 * panels already exist for the cases that genuinely are graphs.
 */
export function EventBindingsSection({ entityId, props }) {
  const bindings = Array.isArray(props.bindings) ? props.bindings : [];
  const graphNodes = props.graph?.nodes?.length ?? 0;
  const commit = (next, label = "Edit event bindings") =>
    commandBus.execute(new SetComponentPropCommand(entityId, "events", "bindings", next, label));

  const update = (index, patch) =>
    commit(bindings.map((b, i) => (i === index ? { ...b, ...patch } : b)));

  return (
    <div className="event-bindings">
      {/* The graph is the other half of this component and lives in its own
          panel, because a canvas does not fit an inspector column. Surfacing
          the node count here is what stops the two from being invisible to each
          other — wiring you cannot see is wiring you debug twice. */}
      <button
        className="toolbar-btn event-graph-link"
        onClick={async () => {
          const { openPanel } = await import("../EditorShell.jsx");
          openPanel("eventGraph");
        }}
        title="Branches, values passed between actions, several triggers sharing one chain — the wiring rows can't express"
      >
        <Share2 size={12} /> {graphNodes ? `Graph (${graphNodes} nodes)` : "Open Graph"}
      </button>
      {bindings.length === 0 && (
        <div className="event-empty">
          No wiring yet. A binding reads <em>when something happens, do these things</em> — and needs
          no script.
        </div>
      )}
      {bindings.map((binding, index) => (
        <BindingRow
          key={binding.id ?? index}
          binding={binding}
          entityId={entityId}
          onUpdate={(patch) => update(index, patch)}
          onRemove={() => commit(bindings.filter((_b, i) => i !== index), "Remove binding")}
        />
      ))}
      <button
        className="toolbar-btn"
        onClick={() =>
          commit(
            [...bindings, { id: makeId(), enabled: true, when: { source: "engine" }, do: [] }],
            "Add binding",
          )
        }
      >
        <Plus size={12} /> Binding
      </button>
    </div>
  );
}

function BindingRow({ binding, entityId, onUpdate, onRemove }) {
  const [open, setOpen] = useState(!binding.when?.event && binding.when?.source !== "lifecycle");
  return (
    <div className={`event-binding ${binding.enabled === false ? "off" : ""}`}>
      <div className="event-binding-head">
        <button className="icon-btn" onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <span className="event-binding-when">{bindingSummary(binding)}</span>
        <span className="event-binding-count">
          {(binding.do ?? []).length} action{(binding.do ?? []).length === 1 ? "" : "s"}
        </span>
        <label className="event-binding-flag" title="Fire only the first time">
          <input
            type="checkbox"
            checked={!!binding.once}
            onChange={(e) => onUpdate({ once: e.target.checked })}
          />
          once
        </label>
        <label
          className="event-binding-flag"
          title="Run on the next frame instead of inside the event — safe for actions that destroy or reparent entities"
        >
          <input
            type="checkbox"
            checked={!!binding.deferred}
            onChange={(e) => onUpdate({ deferred: e.target.checked })}
          />
          deferred
        </label>
        <input
          type="checkbox"
          checked={binding.enabled !== false}
          title="Enable this binding"
          onChange={(e) => onUpdate({ enabled: e.target.checked })}
        />
        <button className="icon-btn" title="Remove binding" onClick={onRemove}>
          <Trash2 size={11} />
        </button>
      </div>
      {open && (
        <div className="event-binding-body">
          <WhenEditor
            when={binding.when ?? { source: "engine" }}
            entityId={entityId}
            onChange={(when) => onUpdate({ when })}
          />
          <div className="event-then">Then</div>
          <ActionList
            entityId={entityId}
            actions={binding.do}
            onCommit={(next) => onUpdate({ do: next })}
          />
        </div>
      )}
    </div>
  );
}
