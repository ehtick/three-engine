import { useCallback, useDeferredValue, useMemo, useRef, useState } from "react";
import { Box, ChevronDown, Search, TriangleAlert } from "../icons/index.jsx";
import { useSceneStore } from "../store/sceneStore.js";
import { useEntityDrop } from "../entityDrag.js";
import { PopoverMenu } from "./PopoverMenu.jsx";

/** "Parent / Grandparent" for a row, so two entities called "Door" tell apart. */
function entityPath(entities, id) {
  const names = [];
  let cursor = entities[id]?.parentId;
  while (cursor && entities[cursor] && names.length < 3) {
    names.push(entities[cursor].name);
    cursor = entities[cursor].parentId;
  }
  return names.join(" / ");
}

/**
 * An entity reference — a joint's connected body, a camera's follow target.
 * Stores the entity id; empty means "none".
 *
 * Never a text box: the value is set by dropping a row from the Hierarchy on
 * the field, or by picking from the browser it opens (every entity the
 * descriptor's `filter` admits, searchable by name or ancestor).
 */
export function EntityField({ descriptor, value, onCommit }) {
  const entities = useSceneStore((s) => s.entities);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // The dropdown search input binds to `query` so every keystroke paints
  // immediately; the lowercased substring filter over the scene's entity
  // list consumes `deferredQuery`. A scene with thousands of entities opens
  // many of these pickers per inspector — without the defer, the filter
  // chunked the input. Enter-to-pick and Escape still read `query` so the
  // intent of the just-typed character survives a one-frame lag.
  const deferredQuery = useDeferredValue(query);
  const triggerRef = useRef(null);
  const filter = descriptor.filter;
  const passes = useCallback((e) => !!e && (!filter || filter(e)), [filter]);

  const dropRef = useEntityDrop({
    accepts: (ids) => ids.length === 1 && passes(entities?.[ids[0]]),
    onDrop: (ids) => onCommit(ids[0]),
  });
  const setTriggerRef = useCallback(
    (el) => {
      triggerRef.current = el;
      dropRef(el);
    },
    [dropRef],
  );

  const current = value ? entities?.[value] : null;
  const missing = !!value && !current;
  const emptyLabel = descriptor.emptyLabel ?? "None";

  const options = useMemo(
    () =>
      Object.values(entities ?? {})
        .filter(passes)
        .map((e) => ({ id: e.id, name: e.name ?? e.id, path: entityPath(entities, e.id) }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)),
    [entities, passes],
  );
  const needle = deferredQuery.trim().toLowerCase();
  const matches = needle
    ? options.filter((o) => o.name.toLowerCase().includes(needle) || o.path.toLowerCase().includes(needle))
    : options;

  const pick = (id) => {
    setOpen(false);
    onCommit(id);
  };

  return (
    <div className="dropdown-wrap entity-field-wrap">
      <div
        ref={setTriggerRef}
        className={`entity-field${value ? "" : " empty"}${missing ? " missing" : ""}`}
        role="button"
        tabIndex={0}
        title={missing ? "This entity is no longer in the scene" : (current?.name ?? `${emptyLabel} — drop an entity here or pick one`)}
        onClick={() => {
          setQuery("");
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setQuery("");
            setOpen(true);
          }
        }}
      >
        {missing ? (
          <TriangleAlert size={13} className="entity-field-glyph" aria-hidden="true" />
        ) : (
          <Box size={13} className="entity-field-glyph" aria-hidden="true" />
        )}
        <span className="entity-field-name">{missing ? "Missing" : (current?.name ?? emptyLabel)}</span>
        <span className="asset-field-caret" aria-hidden="true">
          <ChevronDown size={12} />
        </span>
      </div>
      {open && (
        <PopoverMenu
          anchorRef={triggerRef}
          className="entity-browser component-menu"
          minWidth={260}
          layer={descriptor.layer}
          onClose={() => setOpen(false)}
        >
          <div className="component-menu-search">
            <Search size={12} aria-hidden="true" />
            <input
              autoFocus
              type="text"
              placeholder="Search"
              aria-label="Search entities"
              value={query}
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") setOpen(false);
                else if (e.key === "Enter" && matches.length) pick(matches[0].id);
              }}
            />
          </div>
          <div className="component-menu-list entity-browser-list" role="listbox">
            <button type="button" role="option" aria-selected={!value} className="dropdown-item" onClick={() => pick("")}>
              {emptyLabel}
            </button>
            {matches.map((o) => (
              <button
                key={o.id}
                type="button"
                role="option"
                aria-selected={o.id === value}
                className={`dropdown-item entity-browser-row${o.id === value ? " checked" : ""}`}
                title={o.path ? `${o.path} / ${o.name}` : o.name}
                onClick={() => pick(o.id)}
              >
                <Box size={13} className="entity-browser-glyph" aria-hidden="true" />
                <span className="entity-browser-name">{o.name}</span>
                {o.path && <span className="entity-browser-path">{o.path}</span>}
              </button>
            ))}
            {matches.length === 0 && <div className="dropdown-item">{needle ? "No matches" : "No entities"}</div>}
          </div>
        </PopoverMenu>
      )}
    </div>
  );
}
