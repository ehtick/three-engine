import { useEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  X,
  Trash2,
  Save,
  Undo2,
  Search,
  Copy,
  Check,
  Radio,
  ArrowUp,
  ArrowDown,
  Copy as Duplicate,
  AlertTriangle,
  FileSearch,
} from "lucide-react";
import { useEventsStore } from "../store/eventsStore.js";
import { useProjectStore } from "../store/projectStore.js";
import { engine } from "../engineInstance.js";
import { EVENT_PARAM_TYPES, EVENT_SCOPES } from "../../engine/events/catalog.js";

/**
 * The project's event catalog, and a live tap on what's firing.
 *
 * Two things Godot's Signals dock and Unity's UnityEvent inspector both lack,
 * and the reason this is a panel rather than a settings page:
 *
 *   - the *signature* is shown as the code you would actually write, because
 *     the point of declaring an event is that you never have to look up what it
 *     takes (see the no-strings rule);
 *   - the Monitor tab shows what really fired, with a listener count, so
 *     "I emitted it and nothing happened" is one glance instead of a bisect —
 *     and an event that fired without being declared can be adopted into the
 *     catalog with one click.
 *
 * Edits go live immediately (every future event dropdown reads the same
 * registry); Save writes `project.json` and regenerates the declarations.
 */
export function EventsPanel() {
  const [tab, setTab] = useState("catalog");
  const dirty = useEventsStore((s) => s.dirty);
  const saving = useEventsStore((s) => s.saving);
  const commit = useEventsStore((s) => s.commit);
  const revert = useEventsStore((s) => s.revert);
  const add = useEventsStore((s) => s.add);
  const errors = useEventsStore((s) => s.errors);
  const count = useEventsStore((s) => s.events.length);
  const hasProject = useProjectStore((s) => !!s.rootPath);

  return (
    <div className="events-panel">
      <div className="panel-toolbar">
        <span className="asset-path" title="Project events">
          Events
          {count > 0 && <span className="events-count">{count}</span>}
        </span>
        <button className="toolbar-btn" onClick={add} title="Declare a new event">
          <Plus size={13} /> Event
        </button>
        <button
          className="toolbar-btn"
          disabled={!dirty}
          onClick={revert}
          title="Discard changes since the last save"
        >
          <Undo2 size={13} /> Revert
        </button>
        <button
          className="toolbar-btn"
          disabled={!dirty || !hasProject || saving}
          onClick={commit}
          title={
            hasProject
              ? "Save to project.json and regenerate project-events.d.ts"
              : "Open a project to save"
          }
        >
          <Save size={13} /> Save{dirty ? " •" : ""}
        </button>
        <div className="events-tabs">
          <button
            className={`events-tab ${tab === "catalog" ? "active" : ""}`}
            onClick={() => setTab("catalog")}
          >
            Catalog
          </button>
          <button
            className={`events-tab ${tab === "monitor" ? "active" : ""}`}
            onClick={() => setTab("monitor")}
          >
            Monitor
          </button>
        </div>
      </div>

      {errors.length > 0 && (
        <div className="events-errors">
          <AlertTriangle size={13} />
          <div>
            {errors.map((err) => (
              <div key={err}>{err}</div>
            ))}
          </div>
        </div>
      )}

      {tab === "catalog" ? <CatalogTab /> : <MonitorTab onDeclared={() => setTab("catalog")} />}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Catalog                                                                     */
/* -------------------------------------------------------------------------- */

function CatalogTab() {
  const events = useEventsStore((s) => s.events);
  const selected = useEventsStore((s) => s.selected);
  const select = useEventsStore((s) => s.select);
  const filter = useEventsStore((s) => s.filter);
  const setFilter = useEventsStore((s) => s.setFilter);
  const remove = useEventsStore((s) => s.remove);
  const duplicate = useEventsStore((s) => s.duplicate);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return events;
    return events.filter(
      (e) =>
        e.name.toLowerCase().includes(needle) ||
        (e.category ?? "").toLowerCase().includes(needle) ||
        (e.description ?? "").toLowerCase().includes(needle),
    );
  }, [events, filter]);

  // Grouped by category, with uncategorised last — a project with no categories
  // (the common case early on) sees one flat list and no empty headers.
  const groups = useMemo(() => {
    const map = new Map();
    for (const event of visible) {
      const key = event.category || "";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(event);
    }
    return [...map.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  }, [visible]);

  const current = events.find((e) => e.name === selected) ?? null;

  return (
    <div className="events-layout">
      <aside className="events-list">
        <div className="events-filter">
          <Search size={12} />
          <input
            type="text"
            value={filter}
            placeholder="Filter events…"
            onChange={(e) => setFilter(e.target.value)}
          />
          {filter && (
            <button className="icon-btn" title="Clear" onClick={() => setFilter("")}>
              <X size={11} />
            </button>
          )}
        </div>
        {events.length === 0 && (
          // NOT `.inspector-panel.empty` — that class is `display:flex` with no
          // direction, so a text node plus a sibling element become two
          // side-by-side columns, each squeezed to one word per line.
          <div className="events-rail-empty">No events yet.</div>
        )}
        {events.length > 0 && visible.length === 0 && (
          <div className="events-rail-empty">Nothing matches “{filter}”.</div>
        )}
        {groups.map(([category, list]) => (
          <div key={category || "_"} className="events-group">
            {category && <div className="events-group-title">{category}</div>}
            {list.map((event) => (
              <div
                key={event.name}
                className={`events-row ${selected === event.name ? "active" : ""}`}
              >
                {/* Read as a signature, not a name plus a count: the list is
                    what an author scans to remember what an event takes, and
                    "3" does not answer that. */}
                <button className="events-row-name" onClick={() => select(event.name)}>
                  <span className="events-row-label">
                    {event.name}
                    <span className="events-row-params">
                      ({event.params.map((p) => p.name).join(", ")})
                    </span>
                  </span>
                  {event.scope === "entity" && (
                    <span className="events-row-scope" title="Fires on one entity's own bus">
                      entity
                    </span>
                  )}
                </button>
                <button
                  className="icon-btn"
                  title="Duplicate"
                  onClick={() => duplicate(event.name)}
                >
                  <Duplicate size={11} />
                </button>
                <button className="icon-btn" title="Delete" onClick={() => remove(event.name)}>
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        ))}
      </aside>

      <main className="events-main">
        {current ? (
          <EventEditor key={current.name} event={current} />
        ) : (
          <NothingSelected hasEvents={events.length > 0} />
        )}
      </main>
    </div>
  );
}

/**
 * Events worth having in almost any game, creatable in one click.
 *
 * Not decoration for an empty screen. The hard part of starting a catalog is
 * not typing a name, it is knowing what shape an event should be — and the
 * three below are the shapes that recur: a global fact, a global fact carrying
 * a number, and a per-entity notification. Clicking one and then editing it is
 * a much better first minute than an empty text field.
 */
const STARTERS = [
  {
    name: "game-started",
    scope: "global",
    params: [],
    description: "The run has begun — spawn the player, start the music.",
  },
  {
    name: "score-changed",
    scope: "global",
    params: [{ name: "total", type: "number" }],
    description: "The score changed. Carries the new total.",
  },
  {
    name: "damaged",
    scope: "entity",
    params: [{ name: "amount", type: "number" }],
    description: "This entity took damage.",
  },
];

/**
 * The right pane before anything is selected.
 *
 * It is the panel's biggest surface, and "Pick an event on the left." spent all
 * of it saying nothing — worst of all when the left is empty too, which is
 * exactly the moment someone needs to know what this screen is for.
 */
function NothingSelected({ hasEvents }) {
  const patch = useEventsStore((s) => s.patch);
  const select = useEventsStore((s) => s.select);
  const events = useEventsStore((s) => s.events);

  const create = (starter) => {
    if (events.some((e) => e.name === starter.name)) {
      select(starter.name);
      return;
    }
    patch((list) => [...list, structuredClone(starter)]);
    select(starter.name);
  };

  return (
    <div className="events-splash">
      <h2>Project events</h2>
      <p>
        An event declared here is typed in every script straight away —{" "}
        <code>emit</code> knows what payload it must be given, <code>on</code> knows what it will
        receive, and a misspelled name is a compile error rather than a handler that never fires.
      </p>
      <pre className="events-splash-code">
        <span className="k">this</span>.engine.emit(<span className="s">"score-changed"</span>, 120);
        {"\n"}
        <span className="k">this</span>.engine.on(<span className="s">"score-changed"</span>, (total) =&gt; …);
      </pre>
      <p className="events-splash-sub">
        {hasEvents
          ? "Pick one on the left to edit it, or start from a common shape:"
          : "Start from a common shape, or use “+ Event” for an empty one:"}
      </p>
      <div className="events-starters">
        {STARTERS.map((starter) => (
          <button key={starter.name} className="events-starter" onClick={() => create(starter)}>
            <span className="events-starter-name">
              {starter.name}
              <span className="events-row-params">
                ({starter.params.map((p) => p.name).join(", ")})
              </span>
            </span>
            <span className="events-starter-desc">{starter.description}</span>
          </button>
        ))}
      </div>
      <p className="events-splash-foot">
        Wiring one up without a script is the <strong>Events</strong> component in the Inspector —
        and the <strong>Monitor</strong> tab above shows everything firing at runtime, including the
        emissions nothing is listening to.
      </p>
    </div>
  );
}

function EventEditor({ event }) {
  const rename = useEventsStore((s) => s.rename);
  const update = useEventsStore((s) => s.update);
  const addParam = useEventsStore((s) => s.addParam);
  const updateParam = useEventsStore((s) => s.updateParam);
  const removeParam = useEventsStore((s) => s.removeParam);
  const moveParam = useEventsStore((s) => s.moveParam);
  const rootPath = useProjectStore((s) => s.rootPath);

  const [draftName, setDraftName] = useState(event.name);
  const [nameError, setNameError] = useState(null);
  const [usages, setUsages] = useState(null);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    setDraftName(event.name);
    setNameError(null);
    setUsages(null);
  }, [event.name]);

  /**
   * Commits a rename, then offers to rewrite the scripts that used the old name.
   *
   * Asking rather than doing: the match is a string literal, so an unrelated
   * string that happens to equal the event name would be rewritten too, and
   * silently editing someone's source on a blur event is not a trade worth
   * making. Declining leaves the catalog renamed and the scripts alone, which
   * the generated declarations then report as real errors at the real sites.
   */
  const commitRename = async () => {
    const next = draftName.trim();
    if (next === event.name) return;
    const error = rename(event.name, next);
    if (error) {
      setNameError(error);
      return;
    }
    setNameError(null);
    if (!rootPath) return;
    const { findEventUsages, renameEventInScripts } = await import("../eventUsages.js");
    const hits = await findEventUsages(rootPath, event.name);
    if (!hits.length) return;
    const files = new Set(hits.map((h) => h.path)).size;
    const ok = window.confirm(
      `"${event.name}" appears ${hits.length} time(s) in ${files} script file(s).\n\n` +
        `Rewrite them to "${next}"?\n\n` +
        hits
          .slice(0, 8)
          .map((h) => `  ${h.path.split(/[\\/]/).pop()}:${h.line}  ${h.text.slice(0, 60)}`)
          .join("\n") +
        (hits.length > 8 ? `\n  …and ${hits.length - 8} more` : ""),
    );
    if (!ok) return;
    const result = await renameEventInScripts(rootPath, event.name, next);
    console.log(`Renamed ${result.occurrences} occurrence(s) across ${result.files} file(s).`);
  };

  const scanUsages = async () => {
    if (!rootPath) return;
    setScanning(true);
    try {
      const { findEventUsages } = await import("../eventUsages.js");
      setUsages(await findEventUsages(rootPath, event.name));
    } finally {
      setScanning(false);
    }
  };

  const paramNames = event.params.map((p) => p.name);

  return (
    <div className="events-editor">
      <div className="events-field">
        <label>Name</label>
        <input
          type="text"
          className={nameError ? "invalid" : ""}
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setDraftName(event.name);
              setNameError(null);
            }
          }}
        />
      </div>
      {nameError && <div className="events-inline-error">{nameError}</div>}

      <div className="events-field">
        <label>Scope</label>
        <select value={event.scope} onChange={(e) => update(event.name, { scope: e.target.value })}>
          {Object.entries(EVENT_SCOPES).map(([key, { label }]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="events-scope-hint">
        {event.scope === "entity"
          ? "Fires on one entity — entity.emit(…) reaches only that entity's listeners."
          : "Fires on the engine — every listener anywhere hears it."}
      </div>

      <div className="events-field">
        <label>Category</label>
        <input
          type="text"
          value={event.category ?? ""}
          placeholder="Ungrouped"
          onChange={(e) => update(event.name, { category: e.target.value })}
        />
      </div>

      <div className="events-field events-field-tall">
        <label>Description</label>
        <textarea
          rows={2}
          value={event.description ?? ""}
          placeholder="Shown on hover in the code editor."
          onChange={(e) => update(event.name, { description: e.target.value })}
        />
      </div>

      <div className="events-section-header">
        <span>Parameters</span>
        <button className="toolbar-btn" onClick={() => addParam(event.name)}>
          <Plus size={12} /> Parameter
        </button>
      </div>

      {event.params.length === 0 && (
        <div className="events-empty-params">No parameters — the event carries no payload.</div>
      )}

      {event.params.map((param, index) => (
        <div className="events-param" key={index}>
          <input
            type="text"
            className="events-param-name"
            value={param.name}
            onChange={(e) => updateParam(event.name, index, { name: e.target.value })}
            title="Parameter name — becomes the argument's label in autocomplete"
          />
          <select
            value={param.type}
            onChange={(e) => updateParam(event.name, index, { type: e.target.value })}
          >
            {Object.entries(EVENT_PARAM_TYPES).map(([key, { label }]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          <label className="events-param-optional" title="Optional parameters must come last">
            <input
              type="checkbox"
              checked={!!param.optional}
              onChange={(e) => updateParam(event.name, index, { optional: e.target.checked })}
            />
            opt
          </label>
          <input
            type="text"
            className="events-param-desc"
            value={param.description ?? ""}
            placeholder="Description"
            onChange={(e) => updateParam(event.name, index, { description: e.target.value })}
          />
          <button
            className="icon-btn"
            title="Move up"
            disabled={index === 0}
            onClick={() => moveParam(event.name, index, -1)}
          >
            <ArrowUp size={11} />
          </button>
          <button
            className="icon-btn"
            title="Move down"
            disabled={index === event.params.length - 1}
            onClick={() => moveParam(event.name, index, 1)}
          >
            <ArrowDown size={11} />
          </button>
          <button
            className="icon-btn"
            title="Remove parameter"
            onClick={() => removeParam(event.name, index)}
          >
            <Trash2 size={11} />
          </button>
        </div>
      ))}
      {paramNames.length !== new Set(paramNames).size && (
        <div className="events-inline-error">Two parameters share a name — rename one.</div>
      )}

      <Signature event={event} />

      <div className="events-section-header">
        <span>Usage</span>
        <button className="toolbar-btn" onClick={scanUsages} disabled={!rootPath || scanning}>
          <FileSearch size={12} /> {scanning ? "Scanning…" : "Find in scripts"}
        </button>
      </div>
      <ListenerCount event={event} />
      {usages && (
        <div className="events-usages">
          {usages.length === 0 ? (
            <div className="events-empty-params">No script references this event yet.</div>
          ) : (
            usages.map((hit, i) => (
              <button
                key={`${hit.path}:${hit.line}:${i}`}
                className="events-usage"
                title={hit.path}
                onClick={async () => {
                  const { useCodeStore } = await import("../codeStore.js");
                  useCodeStore.getState().open(hit.path);
                }}
              >
                <span className="events-usage-file">
                  {hit.path.split(/[\\/]/).pop()}:{hit.line}
                </span>
                <code>{hit.text}</code>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The event as the two lines you would actually type.
 *
 * This is the panel earning its keep: an author should never have to open a
 * doc — or this panel — to remember what an event takes, and the fastest way to
 * guarantee that is to hand them the call itself.
 */
function Signature({ event }) {
  const [copied, setCopied] = useState(null);
  const target = event.scope === "entity" ? "this.entity" : "this.engine";
  const args = event.params.map((p) => p.name);
  const emitLine = `${target}.emit("${event.name}"${args.length ? `, ${args.join(", ")}` : ""});`;
  const onLine = `${target}.on("${event.name}", (${args.join(", ")}) => { … });`;

  const copy = async (text, which) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1200);
    } catch {
      // Clipboard blocked — the text is on screen and selectable anyway.
    }
  };

  return (
    <>
      <div className="events-section-header">
        <span>Signature</span>
      </div>
      <div className="events-signature">
        {[
          ["emit", emitLine],
          ["on", onLine],
        ].map(([which, line]) => (
          <div className="events-signature-row" key={which}>
            <code>{line}</code>
            <button className="icon-btn" title="Copy" onClick={() => copy(line, which)}>
              {copied === which ? <Check size={11} /> : <Copy size={11} />}
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * How many listeners the event has right now.
 *
 * Only meaningful for the global bus: a per-entity event has an independent
 * listener set on every entity, so one number would be a lie rather than a
 * summary. Polled rather than subscribed — there is no "listener added" event,
 * and adding one to `EventEmitter.on` would put a notification on the hottest
 * path in the engine to service a debugging readout.
 */
function ListenerCount({ event }) {
  const [count, setCount] = useState(null);
  useEffect(() => {
    if (event.scope !== "global") {
      setCount(null);
      return;
    }
    const read = () => setCount(engine.listenerCount?.(event.name) ?? 0);
    read();
    const id = setInterval(read, 500);
    return () => clearInterval(id);
  }, [event.name, event.scope]);

  if (event.scope !== "global") {
    return (
      <div className="events-listeners">
        Per-entity events have their own listeners on each entity — there is no global count.
      </div>
    );
  }
  return (
    <div className={`events-listeners ${count === 0 ? "none" : ""}`}>
      {count === 0
        ? "Nothing is listening right now — an emit would go nowhere."
        : `${count} listener${count === 1 ? "" : "s"} attached right now.`}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Monitor                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A live tail of every emission on every bus.
 *
 * Recording is armed only while this tab is mounted — the tap sits inside
 * `EventEmitter.emit`, so leaving it on would tax every event in the editor for
 * a readout nobody is looking at.
 */
function MonitorTab({ onDeclared }) {
  const monitoring = useEventsStore((s) => s.monitoring);
  const emissions = useEventsStore((s) => s.emissions);
  const setMonitoring = useEventsStore((s) => s.setMonitoring);
  const pollEmissions = useEventsStore((s) => s.pollEmissions);
  const clearEmissions = useEventsStore((s) => s.clearEmissions);
  const patch = useEventsStore((s) => s.patch);
  const select = useEventsStore((s) => s.select);
  const [needle, setNeedle] = useState("");
  const [follow, setFollow] = useState(true);
  const bottomRef = useRef(null);

  useEffect(() => {
    setMonitoring(true);
    return () => setMonitoring(false);
  }, [setMonitoring]);

  useEffect(() => {
    if (!monitoring) return;
    // 4Hz: fast enough to feel live, slow enough that a busy frame doesn't
    // rerender the panel per event.
    const id = setInterval(pollEmissions, 250);
    return () => clearInterval(id);
  }, [monitoring, pollEmissions]);

  useEffect(() => {
    if (follow) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [emissions, follow]);

  const rows = useMemo(() => {
    const filter = needle.trim().toLowerCase();
    if (!filter) return emissions;
    return emissions.filter(
      (e) => e.name.toLowerCase().includes(filter) || e.source.toLowerCase().includes(filter),
    );
  }, [emissions, needle]);

  /** Adopts an undeclared event into the catalog, inferring parameter types
   *  from what actually came through. Run the game, watch it fire, declare it —
   *  which is a good deal faster than writing the declaration by hand. */
  const declare = (emission) => {
    patch((events) => [
      ...events,
      {
        name: emission.name,
        scope: emission.source === "engine" ? "global" : "entity",
        params: emission.args.map((arg, i) => ({
          name: `arg${i + 1}`,
          type: inferType(arg),
        })),
        description: `Seen at runtime from ${emission.source}.`,
      },
    ]);
    select(emission.name);
    onDeclared?.();
  };

  return (
    <div className="events-monitor">
      <div className="events-monitor-bar">
        <span className={`events-rec ${monitoring ? "on" : ""}`}>
          <Radio size={12} /> {monitoring ? "Recording" : "Paused"}
        </span>
        <div className="events-filter">
          <Search size={12} />
          <input
            type="text"
            value={needle}
            placeholder="Filter by event or source…"
            onChange={(e) => setNeedle(e.target.value)}
          />
        </div>
        <label className="events-follow">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Follow
        </label>
        <button className="toolbar-btn" onClick={clearEmissions}>
          <Trash2 size={12} /> Clear
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="inspector-panel empty">
          Nothing yet. Press Play — every emission on every bus shows up here, including the ones
          with no listeners.
        </div>
      ) : (
        <div className="events-monitor-list">
          {rows.map((row) => (
            <div
              key={row.seq}
              className={`events-emission ${row.listeners === 0 ? "unheard" : ""}`}
              title={row.declared ? undefined : "Not declared in the catalog"}
            >
              <span className="events-emission-source">{row.source}</span>
              <span className="events-emission-name">{row.name}</span>
              <span className="events-emission-args">
                {row.args.length ? row.args.map((a) => formatArg(a)).join(", ") : ""}
              </span>
              <span className="events-emission-listeners">{row.listeners}</span>
              {!row.declared && (
                <button
                  className="events-declare"
                  title="Add this event to the catalog"
                  onClick={() => declare(row)}
                >
                  <Plus size={10} /> Declare
                </button>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}

/** Best guess at a catalog type from one recorded (already-summarized) value. */
function inferType(value) {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") {
    // `summarizeArg` renders an entity as `<Name>`; a real string stays a string.
    if (/^<.*>$/.test(value)) return "entity";
    if (/^#[0-9a-f]{3,8}$/i.test(value)) return "color";
    return "string";
  }
  return "any";
}

function formatArg(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return `"${value}"`;
  return String(value);
}
