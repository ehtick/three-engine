import { useEffect, useMemo, useState } from "react";
import { Boxes, ChevronDown, KeyRound, Search, Sliders, Tag } from "lucide-react";
import {
  useModulesStore,
  listModuleDefinitions,
  setModuleEnabled,
  getModuleSettings,
  saveModuleSettings,
} from "../modules.js";
import { usePlayStore } from "../store/playStore.js";
import { useProjectStore } from "../store/projectStore.js";
import { CREDENTIAL_CHANGED_EVENT } from "../credentialEvents.js";

const SELECTED_KEY = "engine.modules.selected";
const COLLAPSED_KEY = "engine.modules.collapsedCategories";

/**
 * Unity-style package manager. The left rail lists every registered module
 * grouped by `category` (Physics, Rendering, Optimization, …), with a
 * search input that filters across name / description / components / tags.
 * Clicking a row populates the right pane with the module's full details
 * (description, components + tags, runtime notes, version, enable/disable
 * hint).
 *
 * Selection persists across panel open/close via localStorage so reopening
 * lands where the user left off (same pattern as Unity's Package Manager
 * after you revisit it). Collapsed categories are also persisted.
 */

// Category order shown in the rail — anything not in this list lands at the
// bottom under "Other", so adding a new category never silently buries it.
const CATEGORY_ORDER = ["Physics", "Rendering", "Optimization", "World", "Editor", "Other"];

/** Lowercase + collapse whitespace so the search predicate stays simple. */
function norm(s) {
  return (s ?? "").toString().toLowerCase().trim();
}

/** Pulls the searchable haystack out of a module definition. */
function moduleHaystack(def) {
  const comps = (def.components ?? [])
    .map((c) => `${c.label ?? ""} ${c.type ?? ""} ${(c.tags ?? []).join(" ")}`)
    .join(" ");
  return norm([def.name, def.description, def.id, def.category, def.tags?.join(" "), comps].join(" "));
}

function loadCollapsed() {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function ModulesPanel() {
  const enabled = useModulesStore((s) => s.enabled);
  const playing = usePlayStore((s) => s.playing);
  const hasProject = useProjectStore((s) => !!s.rootPath);
  const [defs, setDefs] = useState([]);
  const [busy, setBusy] = useState(null);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [selectedId, setSelectedId] = useState(() => {
    try {
      return localStorage.getItem(SELECTED_KEY) ?? null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    listModuleDefinitions().then((d) => {
      setDefs(d);
      // Restore from localStorage; fall back to the first module so the
      // right pane is never blank on first open. Stale ids (the module
      // was unregistered) drop to the head of the list automatically.
      if (d.length === 0) {
        setSelectedId(null);
        return;
      }
      const exists = d.some((x) => x.id === selectedId);
      if (!exists) setSelectedId(d[0].id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    try {
      localStorage.setItem(SELECTED_KEY, selectedId);
    } catch {}
  }, [selectedId]);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed));
    } catch {}
  }, [collapsed]);

  const toggle = async (id, on) => {
    setBusy(id);
    try {
      await setModuleEnabled(id, on);
    } catch (err) {
      console.error(`Module "${id}": ${err.message ?? err}`);
    } finally {
      setBusy(null);
    }
  };

  // Search predicate matches against the whole haystack per module.
  // Multi-token AND: every whitespace-separated term must match somewhere.
  const tokens = norm(query).split(/\s+/).filter(Boolean);
  const filteredDefs = useMemo(() => {
    if (tokens.length === 0) return defs;
    return defs.filter((d) => {
      const hay = moduleHaystack(d);
      return tokens.every((t) => hay.includes(t));
    });
  }, [defs, tokens]);

  // Group modules by category, ordered by CATEGORY_ORDER; unknown categories
  // append under "Other" so they're still reachable. Each group is wrapped
  // with its (collapsible) header inside the rail.
  const grouped = useMemo(() => {
    const buckets = new Map();
    for (const d of filteredDefs) {
      const cat = d.category ?? "Other";
      if (!buckets.has(cat)) buckets.set(cat, []);
      buckets.get(cat).push(d);
    }
    const ordered = [];
    for (const cat of CATEGORY_ORDER) {
      const list = buckets.get(cat);
      if (list && list.length) ordered.push({ category: cat, items: list });
    }
    for (const [cat, list] of buckets) {
      if (!CATEGORY_ORDER.includes(cat)) ordered.push({ category: cat, items: list });
    }
    return ordered;
  }, [filteredDefs]);

  // If the user searches for something that filters the selected module
  // out, fall back to the first remaining match so the right pane stays
  // meaningful. Only auto-redirect when the selection no longer appears in
  // the filtered list AND there is at least one hit to land on — that way
  // an empty search never erases the selection.
  useEffect(() => {
    if (!selectedId) return;
    if (filteredDefs.some((d) => d.id === selectedId)) return;
    if (filteredDefs.length > 0) setSelectedId(filteredDefs[0].id);
  }, [filteredDefs, selectedId]);

  const selected = defs.find((d) => d.id === selectedId) ?? null;
  const disabledReason = playing ? "Stop play mode to change modules" : null;
  const intro = (
    <div className="modules-intro">
      Engine modules extend the runtime with new components and systems.
      Enabled modules are saved with the project and ship with exported games.
      {!hasProject && <em> No project open — choices won't persist.</em>}
    </div>
  );

  const toggleCategory = (cat) => {
    setCollapsed((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat],
    );
  };

  return (
    <div className="modules-panel">
      {intro}
      {defs.length === 0 ? (
        <div className="modules-intro">No modules registered.</div>
      ) : (
        <div className="modules-body">
          {/* Left rail: pick a module to inspect on the right. */}
          <div className="modules-list" role="listbox" aria-label="Engine modules">
            <div className="modules-search">
              <Search size={13} />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${defs.length} module${defs.length === 1 ? "" : "s"}…`}
                aria-label="Search modules"
              />
            </div>

            {grouped.length === 0 ? (
              <div className="modules-empty">No modules match "{query}".</div>
            ) : (
              grouped.map(({ category, items }) => {
                const isCollapsed = collapsed.includes(category);
                return (
                  <section key={category} className="modules-category">
                    <button
                      type="button"
                      className="modules-category-header"
                      onClick={() => toggleCategory(category)}
                      aria-expanded={!isCollapsed}
                    >
                      <ChevronDown
                        size={12}
                        className={`modules-category-chevron${isCollapsed ? " collapsed" : ""}`}
                      />
                      <span className="modules-category-label">{category}</span>
                      <span className="modules-category-count">{items.length}</span>
                    </button>
                    {!isCollapsed &&
                      items.map((def) => {
                        const on = enabled.includes(def.id);
                        const isActive = def.id === selectedId;
                        return (
                          <div
                            key={def.id}
                            role="option"
                            aria-selected={isActive}
                            className={`modules-list-row${isActive ? " active" : ""}`}
                            onClick={() => setSelectedId(def.id)}
                            title={def.description}
                          >
                            <span className="modules-list-name">
                              <Boxes size={13} />
                              <span className="modules-list-name-text">{def.name}</span>
                            </span>
                            <input
                              type="checkbox"
                              checked={on}
                              disabled={busy === def.id || playing}
                              title={
                                playing
                                  ? "Stop play mode to change modules"
                                  : on
                                  ? "Disable module"
                                  : "Enable module"
                              }
                              // Stop the row's onClick (which selects) when the user
                              // clicks the switch directly — both intents are valid
                              // but shouldn't fire together (clicks on the rail row
                              // shouldn't toggle; clicks on the switch shouldn't
                              // re-select).
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => toggle(def.id, e.target.checked)}
                            />
                          </div>
                        );
                      })}
                  </section>
                );
              })
            )}
          </div>

          {/* Right pane: detailed view of the selected module. */}
          <div className="modules-detail">
            {selected ? (
              <ModuleDetail
                key={selected.id}
                def={selected}
                on={enabled.includes(selected.id)}
                busy={busy === selected.id}
                disabledReason={disabledReason}
                onToggle={(on) => toggle(selected.id, on)}
              />
            ) : (
              <div className="modules-detail-empty">Select a module to see its details.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Per-user API keys/tokens live here, not on the browse/import panel they
 * unlock — the Modules panel is where every other per-module setting lives,
 * and it means switching to a different itch.io/Sketchfab account doesn't
 * require re-finding the field inside a grid of thumbnails. Each entry names
 * the editor-only client module (dynamically imported so it never enters the
 * runtime module registry's import graph) and the three functions every one
 * of these clients already exposes: getSavedToken/clearSavedToken/
 * validateAndSaveToken. Keyed as arrays so a module can list more than one
 * credential later; `id` (not the module id) is what travels in
 * `CREDENTIAL_CHANGED_EVENT`, since one module could own several.
 */
const CREDENTIAL_PROVIDERS = {
  sketchfab: [
    {
      id: "sketchfab",
      label: "Sketchfab token",
      placeholder: "Sketchfab API/OAuth token",
      helpLabel: "Find token",
      load: () => import("../sketchfab.js"),
      openHelp: (mod) => mod.openTokenPage(),
    },
  ],
  itchio: [
    {
      id: "itchio",
      label: "itch.io API key",
      placeholder: "itch.io API key",
      helpLabel: "Find key",
      load: () => import("../itchio.js"),
      openHelp: (mod) => mod.openApiKeyPage(),
    },
  ],
  // Freesound only — the module's other source (Wikimedia Commons) is keyless,
  // so the panel still works with this left blank.
  "audio-library": [
    {
      id: "freesound",
      label: "Freesound API key",
      placeholder: "Freesound API key",
      helpLabel: "Get key",
      load: () => import("../audioLibrary.js"),
      openHelp: (mod) => mod.openApiKeyPage(),
    },
  ],
};

function ModuleCredential({ provider }) {
  const [mod, setMod] = useState(null);
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    provider.load().then((m) => {
      if (!alive) return;
      setMod(m);
      setToken(m.getSavedToken());
    });
    return () => { alive = false; };
  }, [provider]);

  if (!mod) return null;

  const connect = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const displayName = await mod.validateAndSaveToken(draft);
      setToken(mod.getSavedToken());
      setName(displayName);
      setDraft("");
      window.dispatchEvent(new CustomEvent(CREDENTIAL_CHANGED_EVENT, { detail: { id: provider.id, connected: true } }));
    } catch (err) {
      setError(err.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = () => {
    mod.clearSavedToken();
    setToken("");
    setName("");
    window.dispatchEvent(new CustomEvent(CREDENTIAL_CHANGED_EVENT, { detail: { id: provider.id, connected: false } }));
  };

  return (
    <section className="modules-detail-section">
      <div className="modules-detail-section-label">
        <KeyRound size={11} />
        <span>{provider.label}</span>
      </div>
      {token ? (
        <div className="modules-credential-row">
          <span className="asset-hint">Saved locally{name ? ` — ${name}` : ""}</span>
          <button className="toolbar-btn" onClick={disconnect}>Disconnect</button>
        </div>
      ) : (
        <form className="modules-credential-row" onSubmit={connect}>
          <input
            type="password"
            autoComplete="off"
            className="text-field"
            placeholder={provider.placeholder}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button className="toolbar-btn" disabled={busy || !draft.trim()}>
            {busy ? "Checking…" : "Connect"}
          </button>
          <button type="button" className="sf-link-btn" onClick={() => provider.openHelp(mod)}>
            {provider.helpLabel}
          </button>
        </form>
      )}
      {error && <div className="ph-error">{error}</div>}
    </section>
  );
}

/**
 * Editable project-level defaults for a module that declares a `settings`
 * schema (see the module definition). Persists into project.json and pushes
 * runtime-affecting values onto the live engine via the module's
 * applySettings(). Field descriptors carry type/min/max/step/help.
 */
function ModuleSettings({ def }) {
  const hasProject = useProjectStore((s) => !!s.rootPath);
  const [values, setValues] = useState(null);

  useEffect(() => {
    let live = true;
    setValues(null);
    getModuleSettings(def.id)
      .then((v) => live && setValues(v))
      .catch((err) => console.error(`Module settings: ${err.message ?? err}`));
    return () => { live = false; };
  }, [def.id]);

  if (!values) return null;

  const patch = (p) => {
    setValues((v) => ({ ...v, ...p }));
    saveModuleSettings(def.id, p).catch((err) => console.error(`Module settings: ${err.message ?? err}`));
  };

  const commitNumber = (field, raw) => {
    let value = field.type === "int" ? parseInt(raw, 10) : parseFloat(raw);
    if (!Number.isFinite(value)) return;
    if (field.min != null) value = Math.max(field.min, value);
    if (field.max != null) value = Math.min(field.max, value);
    if (value !== values[field.key]) patch({ [field.key]: value });
  };

  return (
    <section className="modules-detail-section">
      <div className="modules-detail-section-label">
        <Sliders size={11} />
        <span>Default settings</span>
      </div>
      {def.settings.map((field) => (
        <div className="field-row" key={field.key} title={field.help}>
          <span className="field-label">{field.label}</span>
          {field.type === "bool" ? (
            <input
              type="checkbox"
              checked={!!values[field.key]}
              onChange={(e) => patch({ [field.key]: e.target.checked })}
            />
          ) : (
            <input
              className="number-field"
              type="number"
              min={field.min}
              max={field.max}
              step={field.step ?? 1}
              key={`${field.key}-${values[field.key]}`}
              defaultValue={values[field.key]}
              onBlur={(e) => commitNumber(field, e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
          )}
        </div>
      ))}
      <div className="asset-hint">
        {hasProject
          ? "Defaults apply to newly imported assets and this project's runtime."
          : "Open a project for these defaults to persist."}
      </div>
    </section>
  );
}

function ModuleDetail({ def, on, busy, disabledReason, onToggle }) {
  const components = def.components ?? [];
  // Aggregate every tag from the components on this module so the user can
  // see at a glance what the module adds. Deduplicated, declaration order.
  const componentTags = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const c of components) {
      for (const t of c.tags ?? []) {
        if (seen.has(t)) continue;
        seen.add(t);
        out.push(t);
      }
    }
    return out;
  }, [components]);

  return (
    <div className="modules-detail-body">
      <header className="modules-detail-header">
        <div className="modules-detail-title">
          <h3>{def.name}</h3>
          <div className="modules-detail-meta">
            <span className="modules-detail-category">{def.category ?? "Other"}</span>
            <span className="modules-detail-version">v{def.version}</span>
            {on && <span className="module-badge">Enabled</span>}
          </div>
        </div>
        <input
          type="checkbox"
          checked={on}
          disabled={busy || !!disabledReason}
          title={disabledReason ?? (on ? "Disable module" : "Enable module")}
          onChange={(e) => onToggle(e.target.checked)}
          aria-label={`Toggle ${def.name}`}
        />
      </header>

      <p className="modules-detail-desc">{def.description}</p>

      {CREDENTIAL_PROVIDERS[def.id]?.map((provider) => (
        <ModuleCredential key={provider.id} provider={provider} />
      ))}

      {def.settings?.length > 0 && <ModuleSettings def={def} />}

      {def.tags?.length > 0 && (
        <section className="modules-detail-section">
          <div className="modules-detail-section-label">
            <Tag size={11} />
            <span>Tags</span>
          </div>
          <ul className="modules-tag-list">
            {def.tags.map((t) => (
              <li key={t} className="modules-tag-chip">
                {t}
              </li>
            ))}
          </ul>
        </section>
      )}

      {components.length > 0 && (
        <section className="modules-detail-section">
          <div className="modules-detail-section-label">Adds components</div>
          <ul className="modules-component-list">
            {components.map((c) => {
              const tags = c.tags ?? [];
              return (
                <li key={c.type ?? c.label} className="modules-component-item">
                  <span className="modules-component-chip">{c.label ?? c.type}</span>
                  {tags.length > 0 && (
                    <ul className="modules-tag-list modules-tag-list-inline">
                      {tags.map((t) => (
                        <li key={t} className="modules-tag-chip modules-tag-chip-small">
                          {t}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {componentTags.length > 0 && (
        <section className="modules-detail-section">
          <div className="modules-detail-section-label">Component tags</div>
          <ul className="modules-tag-list">
            {componentTags.map((t) => (
              <li key={t} className="modules-tag-chip">
                {t}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="modules-detail-section">
        <div className="modules-detail-section-label">Runtime</div>
        <dl className="modules-detail-grid">
          <dt>Module ID</dt>
          <dd>
            <code>{def.id}</code>
          </dd>
          <dt>Version</dt>
          <dd>v{def.version}</dd>
          <dt>State</dt>
          <dd>
            <span className={`modules-state-dot ${on ? "on" : "off"}`} />
            {on ? "Enabled for this project" : "Disabled"}
          </dd>
        </dl>
      </section>

      <p className="modules-detail-note">
        Enabled choices persist in <code>project.json</code> and ride into exported games.
      </p>
    </div>
  );
}