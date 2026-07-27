import { useEffect, useMemo, useRef, useState } from "react";
import { typesCompatible } from "./socketTypes.js";

/**
 * Node search palette shared by every graph editor.
 *
 * Beyond the plain substring filter it replaces, this adds:
 *  - fuzzy subsequence matching with prefix/word-start scoring, so "fno" finds
 *    "Fractal Noise" and "pbsdf" finds "Principled BSDF";
 *  - a recents row (per graph kind), because in practice a user reaches for the
 *    same six nodes all session;
 *  - category filter chips;
 *  - drag-from-palette onto the canvas;
 *  - type filtering, which is what makes edge-drop-to-search work: release a
 *    wire on empty canvas and the palette opens showing only nodes that can
 *    actually accept (or produce) that socket's type, then auto-wires the pick.
 */

const RECENTS_KEY = (kind) => `engine.nodegraph.recents.${kind}`;
const MAX_RECENTS = 8;

function loadRecents(kind) {
  try {
    return JSON.parse(localStorage.getItem(RECENTS_KEY(kind)) ?? "[]");
  } catch {
    return [];
  }
}

export function noteRecent(kind, type) {
  try {
    const next = [type, ...loadRecents(kind).filter((t) => t !== type)].slice(0, MAX_RECENTS);
    localStorage.setItem(RECENTS_KEY(kind), JSON.stringify(next));
  } catch {}
}

/**
 * Subsequence score. Returns -1 for no match; higher is better.
 * A run of consecutive characters and a match at a word boundary both score
 * above a scattered match, which is what makes short abbreviations land on the
 * node the user meant instead of the first alphabetical hit.
 */
function fuzzyScore(query, text) {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 1000 - t.length;
  let score = 0;
  let qi = 0;
  let run = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) {
      run = 0;
      continue;
    }
    run++;
    score += 10 + run * 4;
    if (ti === 0 || t[ti - 1] === " " || t[ti - 1] === "-") score += 15;
    qi++;
  }
  return qi === q.length ? score - t.length * 0.1 : -1;
}

/**
 * @param {object} props
 * @param {string} props.kind          registry id, namespaces the recents list
 * @param {Array}  props.items         [{type, label, cat, catLabel, inputTypes, outputTypes}]
 * @param {object} [props.filter]      {direction: "source"|"target", type} — from an edge drop
 * @param {object} [props.style]       absolute position (context-menu mode)
 */
export function NodePalette({ kind, items, filter = null, style, onPick, onClose }) {
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState(null);
  const [active, setActive] = useState(0);
  const listRef = useRef(null);
  const recents = useMemo(() => loadRecents(kind), [kind]);

  const { groups, flat } = useMemo(() => {
    let pool = items;

    // Edge-drop filtering. Dragging FROM an output ("source") means we need a
    // node with a compatible INPUT to receive it, and vice versa.
    if (filter) {
      pool = pool.filter((it) => {
        const ports = filter.direction === "source" ? it.inputTypes : it.outputTypes;
        return (ports ?? []).some((t) => typesCompatible(
          filter.direction === "source" ? filter.type : t,
          filter.direction === "source" ? t : filter.type,
        ));
      });
    }
    if (cat) pool = pool.filter((it) => it.cat === cat);

    const q = query.trim();
    let scored;
    if (q) {
      scored = pool
        .map((it) => ({ it, score: Math.max(fuzzyScore(q, it.label), fuzzyScore(q, it.type) - 5) }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.it);
      // A flat, relevance-ordered list is the right shape for a search; the
      // category grouping below only makes sense when browsing.
      return { groups: [{ cat: null, catLabel: "Results", items: scored }], flat: scored };
    }

    const ordered = [];
    if (!cat && recents.length) {
      const byType = new Map(pool.map((it) => [it.type, it]));
      const recentItems = recents.map((t) => byType.get(t)).filter(Boolean);
      if (recentItems.length) ordered.push({ cat: "__recent", catLabel: "Recent", items: recentItems });
    }
    for (const it of pool) {
      let g = ordered.find((x) => x.cat === it.cat);
      if (!g) ordered.push((g = { cat: it.cat, catLabel: it.catLabel ?? it.cat, items: [] }));
      g.items.push(it);
    }
    return { groups: ordered, flat: ordered.flatMap((g) => g.items) };
  }, [items, query, cat, filter, recents]);

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    listRef.current?.querySelector(".node-palette-item.active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const categories = useMemo(() => {
    const seen = new Map();
    for (const it of items) if (!seen.has(it.cat)) seen.set(it.cat, it.catLabel ?? it.cat);
    return [...seen.entries()];
  }, [items]);

  const pick = (item) => {
    noteRecent(kind, item.type);
    onPick(item.type);
  };

  return (
    <>
      <div
        className="dropdown-overlay"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div className={`dropdown-menu node-palette ${style ? "context-menu" : ""}`} style={style}>
        <input
          className="node-palette-search"
          autoFocus
          placeholder={filter ? `Nodes accepting ${filter.type}…` : "Search nodes…"}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && flat[active]) pick(flat[active]);
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, flat.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Escape") onClose();
          }}
        />
        {categories.length > 1 && (
          <div className="node-palette-cats">
            <button className={`node-palette-cat${cat === null ? " active" : ""}`} onClick={() => setCat(null)}>
              All
            </button>
            {categories.map(([key, label]) => (
              <button
                key={key}
                className={`node-palette-cat cat-${key}${cat === key ? " active" : ""}`}
                onClick={() => setCat(cat === key ? null : key)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <div className="node-palette-list" ref={listRef}>
          {groups.map((g) => (
            <div key={g.cat ?? "results"}>
              <div className="node-palette-group">{g.catLabel}</div>
              {g.items.map((it) => (
                <button
                  key={`${g.cat}-${it.type}`}
                  className={`dropdown-item node-palette-item${flat[active] === it ? " active" : ""}`}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData("application/nodegraph-type", it.type);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onMouseEnter={() => setActive(flat.indexOf(it))}
                  onClick={() => pick(it)}
                >
                  <span className={`shader-node-dot cat-${it.cat}`} />
                  {it.label}
                </button>
              ))}
            </div>
          ))}
          {!flat.length && <div className="node-palette-group">No matches</div>}
        </div>
      </div>
    </>
  );
}
