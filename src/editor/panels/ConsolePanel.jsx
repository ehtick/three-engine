import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Trash2, Search, X, Info, AlertTriangle, AlertCircle } from "../icons/index.jsx";
import { useConsoleStore } from "../store/consoleStore.js";

// The capture folds console.info into "log" (consoleStore.js), so these three
// levels are the whole vocabulary an entry can carry.
const LEVELS = [
  { key: "error", label: "Errors", title: "Show errors", Icon: AlertCircle },
  { key: "warn", label: "Warnings", title: "Show warnings", Icon: AlertTriangle },
  { key: "log", label: "Info", title: "Show info and log messages", Icon: Info },
];

export function ConsolePanel() {
  const entries = useConsoleStore((s) => s.entries);
  const clear = useConsoleStore((s) => s.clear);
  const listRef = useRef(null);
  const [hiddenLevels, setHiddenLevels] = useState(() => new Set());
  const [query, setQuery] = useState("");
  // The filter input is bound directly to `query` so every keystroke paints
  // immediately; the substring filter over `entries` consumes
  // `deferredQuery`, which React is allowed to lag behind by a frame. Long
  // sessions can have thousands of log entries, and lowercasing every
  // message on every keystroke is the part that freezes the input.
  const deferredQuery = useDeferredValue(query);

  const toggleLevel = (key) =>
    setHiddenLevels((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const visible = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    return entries.filter(
      (e) => !hiddenLevels.has(e.level) && (!needle || e.message.toLowerCase().includes(needle))
    );
  }, [entries, hiddenLevels, deferredQuery]);

  // Follow the tail as new entries arrive — except while searching: a list
  // jumping under a query the user is reading is worse than a stale scroll.
  useEffect(() => {
    if (query.trim()) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length, query]);

  return (
    <div className="console-panel">
      <div className="panel-toolbar">
        <button className="toolbar-btn icon-only" title="Clear the console" onClick={clear}>
          <Trash2 size={13} />
        </button>
        {LEVELS.map(({ key, label, title, Icon }) => (
          <button
            key={key}
            className={`toolbar-btn ${hiddenLevels.has(key) ? "" : "active"}`}
            title={title}
            aria-pressed={!hiddenLevels.has(key)}
            onClick={() => toggleLevel(key)}
          >
            <Icon size={13} />
            {label}
          </button>
        ))}
        <div className="console-search">
          <Search size={12} className="console-search-icon" />
          <input
            className="console-search-input"
            type="text"
            placeholder="Filter"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.stopPropagation();
                setQuery("");
              }
            }}
          />
          {query && (
            <button className="console-search-clear" title="Clear search" onClick={() => setQuery("")}>
              <X size={11} />
            </button>
          )}
        </div>
      </div>
      <div className="console-list" ref={listRef}>
        {visible.map((entry) => (
          <div key={entry.id} className={`console-entry ${entry.level}`}>
            <span className="console-time">
              {entry.time.toLocaleTimeString(undefined, { hour12: false })}
            </span>
            <span className="console-message">{entry.message}</span>
            {entry.count > 1 && (
              <span className="console-repeat" title="repeats folded into this entry" style={{ marginLeft: 8, opacity: 0.7, flexShrink: 0 }}>
                ×{entry.count}
              </span>
            )}
          </div>
        ))}
        {visible.length === 0 && (
          <div className="console-empty">
            {entries.length === 0 ? "Console is empty." : "No entries match the current filters."}
          </div>
        )}
      </div>
    </div>
  );
}
