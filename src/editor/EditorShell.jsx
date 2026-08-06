import { Suspense, lazy } from "react";
import { DockviewReact, themeAbyss } from "dockview-react";
import { vmSingleton } from "./singleton.js";
import { QuickSearch } from "./QuickSearch.jsx";
import { Toasts } from "./Toasts.jsx";

// Bumped to v2 when the "material" panel was removed (materials are edited only
// through the Shader Graph now). A v1 layout can still contain a Material tab,
// and `fromJSON` throws on a component that is no longer registered — leaving
// the dock half-restored. Bumping the key drops those layouts instead.
const LAYOUT_KEY = "engine.layout.v2";

// Heavy panels: lazy so their deps (three/webgpu, @xyflow/react,
// particleGraph) don't enter the boot path. The viewport alone pulls in
// the entire three.js WebGPU runtime; shader + particles pull in @xyflow.
const ViewportPanel = lazy(() => import("./panels/ViewportPanel.jsx").then((m) => ({ default: m.ViewportPanel })));
const HierarchyPanel = lazy(() => import("./panels/HierarchyPanel.jsx").then((m) => ({ default: m.HierarchyPanel })));
const InspectorPanel = lazy(() => import("./panels/InspectorPanel.jsx").then((m) => ({ default: m.InspectorPanel })));
const AssetsPanel = lazy(() => import("./panels/AssetsPanel.jsx").then((m) => ({ default: m.AssetsPanel })));
const ConsolePanel = lazy(() => import("./panels/ConsolePanel.jsx").then((m) => ({ default: m.ConsolePanel })));
const ConsoleTab = lazy(() => import("./panels/ConsoleTab.jsx").then((m) => ({ default: m.ConsoleTab })));
const ShaderGraphPanel = lazy(() => import("./panels/ShaderGraphPanel.jsx").then((m) => ({ default: m.ShaderGraphPanel })));
const ParticlesPanel = lazy(() => import("./panels/ParticlesPanel.jsx").then((m) => ({ default: m.ParticlesPanel })));
const AnimatorPanel = lazy(() => import("./panels/AnimatorPanel.jsx").then((m) => ({ default: m.AnimatorPanel })));
const TimelinePanel = lazy(() => import("./panels/TimelinePanel.jsx").then((m) => ({ default: m.TimelinePanel })));
const SceneSettingsPanel = lazy(() => import("./panels/SceneSettingsPanel.jsx").then((m) => ({ default: m.SceneSettingsPanel })));
const ProjectSettingsPanel = lazy(() => import("./panels/ProjectSettingsPanel.jsx").then((m) => ({ default: m.ProjectSettingsPanel })));
const ModulesPanel = lazy(() => import("./panels/ModulesPanel.jsx").then((m) => ({ default: m.ModulesPanel })));
const InputPanel = lazy(() => import("./panels/InputPanel.jsx").then((m) => ({ default: m.InputPanel })));
const GeometryEditorPanel = lazy(() => import("./panels/GeometryEditorPanel.jsx").then((m) => ({ default: m.GeometryEditorPanel })));
const PostprocessPanel = lazy(() => import("./panels/PostprocessPanel.jsx").then((m) => ({ default: m.PostprocessPanel })));
const PolyHavenPanel = lazy(() => import("./panels/PolyHavenPanel.jsx").then((m) => ({ default: m.PolyHavenPanel })));
const AmbientCGPanel = lazy(() => import("./panels/AmbientCGPanel.jsx").then((m) => ({ default: m.AmbientCGPanel })));
const SketchfabPanel = lazy(() => import("./panels/SketchfabPanel.jsx").then((m) => ({ default: m.SketchfabPanel })));
const ItchioPanel = lazy(() => import("./panels/ItchioPanel.jsx").then((m) => ({ default: m.ItchioPanel })));
const AudioLibraryPanel = lazy(() => import("./panels/AudioLibraryPanel.jsx").then((m) => ({ default: m.AudioLibraryPanel })));
const AudioEditorPanel = lazy(() => import("./panels/AudioEditorPanel.jsx").then((m) => ({ default: m.AudioEditorPanel })));
const TerminalPanel = lazy(() => import("./panels/TerminalPanel.jsx").then((m) => ({ default: m.TerminalPanel })));
const McpPanel = lazy(() => import("./panels/McpPanel.jsx").then((m) => ({ default: m.McpPanel })));
const AiPanel = lazy(() => import("./panels/AiPanel.jsx").then((m) => ({ default: m.AiPanel })));
const GamePanel = lazy(() => import("./panels/GamePanel.jsx").then((m) => ({ default: m.GamePanel })));
const BuildPanel = lazy(() => import("./panels/BuildPanel.jsx").then((m) => ({ default: m.BuildPanel })));
const TextureEditorPanel = lazy(() => import("./panels/TextureEditorPanel.jsx").then((m) => ({ default: m.TextureEditorPanel })));
// Monaco is several megabytes of editor and language services. Lazy like every
// other heavy panel, so a project that never opens a script never loads it.
const CodePanel = lazy(() => import("./panels/CodePanel.jsx").then((m) => ({ default: m.CodePanel })));
const FontLibraryPanel = lazy(() => import("./panels/FontLibraryPanel.jsx").then((m) => ({ default: m.FontLibraryPanel })));
const GitPanel = lazy(() => import("./panels/GitPanel.jsx").then((m) => ({ default: m.GitPanel })));

/** Keep lazy loading local to one Dockview portal. A shared boundary around
 * Dockview would hide the entire editor whenever any heavy panel suspends. */
function withPanelSuspense(LazyPanel, fallback = <PanelFallback />) {
  return function SuspendedDockPanel(props) {
    return (
      <Suspense fallback={fallback}>
        <LazyPanel {...props} />
      </Suspense>
    );
  };
}

const panelComponents = {
  viewport: withPanelSuspense(ViewportPanel),
  game: withPanelSuspense(GamePanel),
  hierarchy: withPanelSuspense(HierarchyPanel),
  inspector: withPanelSuspense(InspectorPanel),
  assets: withPanelSuspense(AssetsPanel),
  console: withPanelSuspense(ConsolePanel),
  shaderGraph: withPanelSuspense(ShaderGraphPanel),
  particles: withPanelSuspense(ParticlesPanel),
  animator: withPanelSuspense(AnimatorPanel),
  timeline: withPanelSuspense(TimelinePanel),
  sceneSettings: withPanelSuspense(SceneSettingsPanel),
  projectSettings: withPanelSuspense(ProjectSettingsPanel),
  build: withPanelSuspense(BuildPanel),
  modules: withPanelSuspense(ModulesPanel),
  input: withPanelSuspense(InputPanel),
  geometryEditor: withPanelSuspense(GeometryEditorPanel),
  postprocess: withPanelSuspense(PostprocessPanel),
  polyhaven: withPanelSuspense(PolyHavenPanel),
  ambientcg: withPanelSuspense(AmbientCGPanel),
  sketchfab: withPanelSuspense(SketchfabPanel),
  itchio: withPanelSuspense(ItchioPanel),
  audioLibrary: withPanelSuspense(AudioLibraryPanel),
  audioEditor: withPanelSuspense(AudioEditorPanel),
  terminal: withPanelSuspense(TerminalPanel),
  mcp: withPanelSuspense(McpPanel),
  ai: withPanelSuspense(AiPanel),
  textureEditor: withPanelSuspense(TextureEditorPanel),
  git: withPanelSuspense(GitPanel),
  code: withPanelSuspense(CodePanel),
  fontLibrary: withPanelSuspense(FontLibraryPanel),
};
const tabComponents = {
  console: withPanelSuspense(ConsoleTab, <span className="tab-loading">Console</span>),
};

// The chrome (menu bar + scene/keyboard bootstrap) is lazy-loaded behind a
// Suspense boundary so the entire chain of MenuBar → clipboard → entityCommands
// → engine/index.js doesn't enter the boot module graph until after the
// project hub is dismissed. Viewport/Shaders panels do the same.
const EditorChrome = lazy(() => import("./EditorChrome.jsx").then((m) => ({ default: m.EditorChrome })));

function PanelFallback() {
  return <div className="panel-loading">Loading panel…</div>;
}

/** Where each panel prefers to (re)open. referencePanel falls back if closed too. */
export const PANEL_SPECS = {
  viewport: { title: "Viewport" },
  // Tabbed WITH the viewport, not beside it: they show the same renderer canvas
  // (only one exists — see viewportCanvas.js), so side-by-side would mean one of
  // them is always a placeholder taking up half the screen.
  game: { title: "Game", position: { referencePanel: "viewport", direction: "within" } },
  hierarchy: { title: "Hierarchy", position: { referencePanel: "viewport", direction: "left" }, initialWidth: 260 },
  inspector: { title: "Inspector", position: { referencePanel: "viewport", direction: "right" }, initialWidth: 320 },
  assets: { title: "Assets", position: { referencePanel: "viewport", direction: "below" }, initialHeight: 200 },
  console: { title: "Console", position: { referencePanel: "assets", direction: "within" } },
  shaderGraph: { title: "Shader Graph", position: { referencePanel: "assets", direction: "within" } },
  // Node editors dock with Assets (the full-width strip under the viewport),
  // NOT with the Inspector: the Inspector column is ~320px, and a graph fitted
  // into 320px renders every node as an unreadable postage stamp.
  particles: { title: "Particles", position: { referencePanel: "assets", direction: "within" } },
  animator: { title: "Animator", position: { referencePanel: "assets", direction: "within" } },
  // Same reasoning as the node editors: a dope sheet is a wide, short surface —
  // it needs the full-width strip under the viewport, not the 320px column.
  timeline: { title: "Timeline", position: { referencePanel: "assets", direction: "within" }, initialHeight: 260 },
  sceneSettings: { title: "Scene Settings", position: { referencePanel: "inspector", direction: "within" } },
  projectSettings: { title: "Project Settings", position: { referencePanel: "inspector", direction: "within" } },
  build: { title: "Build", position: { referencePanel: "inspector", direction: "within" } },
  modules: { title: "Modules", position: { referencePanel: "inspector", direction: "within" } },
  input: { title: "Input", position: { referencePanel: "viewport", direction: "below" }, initialHeight: 280 },
  geometryEditor: { title: "Geometry Editor", position: { referencePanel: "viewport", direction: "within" } },
  postprocess: { title: "Post Process", position: { referencePanel: "inspector", direction: "within" } },
  polyhaven: { title: "Poly Haven", position: { referencePanel: "assets", direction: "within" } },
  ambientcg: { title: "AmbientCG", position: { referencePanel: "assets", direction: "within" } },
  sketchfab: { title: "Sketchfab", position: { referencePanel: "assets", direction: "within" } },
  itchio: { title: "itch.io", position: { referencePanel: "assets", direction: "within" } },
  audioLibrary: { title: "Audio Library", position: { referencePanel: "assets", direction: "within" } },
  // Docks with the Assets strip for the same reason the Texture Editor does:
  // track heads plus waveform lanes need width, not the 320px Inspector column.
  audioEditor: { title: "Audio Editor", position: { referencePanel: "assets", direction: "within" }, initialHeight: 420 },
  // Docks with the Assets strip like the other wide authoring surfaces: a
  // paint canvas plus a tool column plus a layer column does not fit the
  // 320px Inspector column, and the canvas is the point of the panel.
  textureEditor: { title: "Texture Editor", position: { referencePanel: "assets", direction: "within" }, initialHeight: 420 },
  // Docks with the Assets strip: a terminal wants width for wrapped output and
  // the CLIs draw full-width boxes, so the 320px Inspector column would render
  // Claude unusable.
  terminal: { title: "Terminal", position: { referencePanel: "assets", direction: "within" } },
  // Docks with the Inspector column: it's a narrow status/settings surface,
  // read at a glance rather than worked in.
  mcp: { title: "Assistant (MCP)", position: { referencePanel: "inspector", direction: "within" } },
  // Same column as the Assistant panel it runs through — opened by context-menu
  // AI actions, not something a user finds by browsing first.
  ai: { title: "AI", position: { referencePanel: "inspector", direction: "within" } },
  // Docks with the Assets strip: the changed-files list and the diff have to be
  // side by side (see GitPanel's header), and a diff in the 320px Inspector
  // column wraps every line into uselessness.
  git: { title: "Source Control", position: { referencePanel: "assets", direction: "within" }, initialHeight: 420 },
  // Code wants the viewport's real estate, not the Assets strip: you read a
  // script down the page, and a 200px-tall pane shows eight lines of it.
  code: { title: "Code", position: { referencePanel: "viewport", direction: "within" } },
  // A font browser is a grid of specimens — same wide strip as the other
  // asset-library panels it sits alongside.
  fontLibrary: { title: "Fonts", position: { referencePanel: "assets", direction: "within" } },
};

/**
 * Dockview's API handle and the queue of opens made before it exists.
 *
 * VM-wide, and that is load-bearing rather than tidiness. These used to be
 * module-scope `let`/`const`, which made them per-module-INSTANCE — and Vite
 * evaluates this file more than once (an HMR update, or its `?t=<mtime>` URL
 * twin). When that happened, the MenuBar imported a copy whose `api` was still
 * null while the mounted Dockview had set it on the other copy. `openPanel`
 * then took its "not ready yet" branch, parked the request in the queue and
 * returned — so every View-menu click did NOTHING, with no error anywhere.
 *
 * That is the worst possible shape for a bug: silent, intermittent, and it
 * looks like the menu is broken rather than like a stale module. See
 * `singleton.js`; this is the same failure as the duplicated command bus.
 */
const dock = vmSingleton("dockState", () => ({
  api: null,
  // Calls to `openPanel` made before Dockview fires `onReady` would otherwise
  // be silently dropped. We queue them here and flush in onDockReady, so
  // clicking "Edit Material" / "Edit Shader Graph" during the first paint still
  // opens the panel once Dockview is ready. A Set dedupes a flurry of clicks.
  pending: new Set(),
}));

/**
 * Finds the id of a currently visible panel to use as a positioning
 * anchor when the spec's preferred anchor is closed. Dockview exposes
 * `api.panels` (all panels, including hidden ones) and `panel.api.isVisible`
 * per-panel — we want the first VISIBLE one so the `addPanel` call below
 * doesn't silently fail (issue: when the anchor panel has been closed by
 * the user, addPanel against it as a reference can no-op without
 * logging). Active panel first, then iterate visible panels.
 */
function isUsableAnchor(panel) {
  const groupApi = panel?.group?.api;
  if (!groupApi?.isVisible) return false;
  try {
    return groupApi.location?.type === "grid";
  } catch {
    return false;
  }
}

/** A group thinner/shorter than this is effectively invisible — a splitter
 *  dragged shut, or a group restored at zero from a saved layout. */
const MIN_GROUP_PX = 40;

/**
 * Brings `panel` genuinely into view.
 *
 * `setActive()` alone is not enough, and each of these states produces the
 * exact same symptom the user sees — the click does nothing, silently, with no
 * error — because activating a panel that cannot be painted is a legal no-op:
 *
 *   1. **Another group is maximized.** Dockview hides every other group while
 *      one is maximized (double-clicking a tab does this, so it's easy to hit
 *      by accident). The panel becomes active behind the maximized group.
 *   2. **The group is a collapsed edge group.**
 *   3. **The group is hidden.**
 *   4. **The group has been sized to ~0** by dragging a splitter shut, or by a
 *      saved layout that restored it that way.
 *
 * Each is checked and undone before activating.
 */
function revealPanel(panel) {
  const groupApi = panel?.group?.api;
  if (!groupApi) {
    panel?.api?.setActive();
    return;
  }
  try {
    // (1) — exit someone else's maximized group, but never un-maximize the
    // group we were asked to reveal.
    if (dock.api?.hasMaximizedGroup?.() && !groupApi.isMaximized?.()) {
      dock.api.exitMaximizedGroup();
    }
    if (groupApi.isCollapsed?.()) groupApi.expand?.(); // (2)
    if (!groupApi.isVisible) groupApi.setVisible(true); // (3)
  } catch (err) {
    // Dockview throws from some of these when a group is in an odd location
    // (popout windows, mid-drag). Activating is still worth attempting.
    console.warn(`revealPanel(${panel.id}): ${err.message}`);
  }
  panel.api.setActive();

  // (4) — measured after activation, on the next frame, because the group's
  // box is only meaningful once the layout has run.
  requestAnimationFrame(() => {
    try {
      const box = panel.group?.api?.boundingBox;
      if (!box) return;
      const width = box.width < MIN_GROUP_PX ? Math.round(window.innerWidth * 0.3) : undefined;
      const height = box.height < MIN_GROUP_PX ? Math.round(window.innerHeight * 0.35) : undefined;
      if (width || height) panel.group.api.setSize({ width, height });
    } catch {}
  });
}

function pickVisibleAnchor() {
  const active = dock.api.activePanel;
  if (isUsableAnchor(active)) return active;
  for (const panel of dock.api.panels) {
    if (isUsableAnchor(panel)) return panel;
  }
  return null;
}

/**
 * Is `id` a panel the user can currently see? True only when the panel exists,
 * its group is on screen, and it is the active tab of that group — a panel
 * sitting behind another tab is "open" to Dockview but invisible to the user,
 * and revealing something in it would be a silent no-op.
 *
 * Used by features that want to *follow* the user's attention without stealing
 * it (see assetReveal.js): they act when the panel is visible and do nothing
 * when it isn't, rather than popping a panel open unasked.
 */
export function isPanelVisible(id) {
  const panel = dock.api?.getPanel(id);
  if (!panel) return false;
  try {
    if (dock.api.hasMaximizedGroup?.() && !panel.group?.api?.isMaximized?.()) return false;
    if (!panel.group?.api?.isVisible) return false;
    if (panel.group.api.isCollapsed?.()) return false;
    if (panel.group.activePanel && panel.group.activePanel.id !== id) return false;
    const box = panel.group.api.boundingBox;
    if (box && (box.width < MIN_GROUP_PX || box.height < MIN_GROUP_PX)) return false;
  } catch {
    return false;
  }
  return true;
}

/** Closes `id` if it is open. No-op otherwise. */
export function closePanel(id) {
  const panel = dock.api?.getPanel(id);
  if (!panel) return false;
  panel.api.close();
  return true;
}

/**
 * Maximizes (or restores) the group holding `id` — the Game panel's
 * "maximize on play", which is the one case where the editor is allowed to
 * rearrange the layout on its own.
 *
 * Restoring only exits the maximized group when it is still OURS. Blindly
 * calling `exitMaximizedGroup` on Stop would also un-maximize a group the user
 * maximized themselves while the game ran, which reads as the editor
 * scrambling their layout for no reason.
 */
export function maximizePanel(id, maximized = true) {
  const panel = dock.api?.getPanel(id);
  const groupApi = panel?.group?.api;
  if (!groupApi) return false;
  try {
    if (maximized) {
      revealPanel(panel);
      if (!groupApi.isMaximized?.()) groupApi.maximize?.();
    } else if (groupApi.isMaximized?.()) {
      dock.api.exitMaximizedGroup?.();
    }
    return true;
  } catch (err) {
    console.warn(`maximizePanel(${id}): ${err.message}`);
    return false;
  }
}

/** Opens any panel (focuses it if already present), even after it was closed. */
export function openPanel(id) {
  if (!dock.api) {
    // Dockview not yet mounted (typical during the first paint: heavy panels
    // like Viewport lazy-load three.js/WebGPU behind Suspense). Park the
    // request and flush it from onDockReady so the click isn't lost.
    dock.pending.add(id);
    return;
  }
  const existing = dock.api.getPanel(id);
  if (existing) {
    revealPanel(existing);
    return;
  }
  const spec = PANEL_SPECS[id];
  if (!spec) {
    console.warn(`openPanel(${id}) called with no matching PANEL_SPECS entry`);
    return;
  }
  // The mounted Dockview holds whatever `panelComponents` existed when it was
  // created. After a hot reload that ADDS a panel, the running instance has
  // never heard of it and `addPanel` fails deep inside Dockview with a message
  // that doesn't name the cause. Say the actual thing, since the fix is a
  // reload and nothing else will hint at that.
  if (!panelComponents[id]) {
    console.error(
      `openPanel(${id}): no panel component is registered under that id. ` +
        "If this panel was added since the editor started, reload the window.",
    );
    return;
  }
  const { position, ...rest } = spec;
  const options = { id, component: id, ...rest };
  // The Console panel uses a custom tab renderer so it can show an unread-error
  // dot — pin the renderer here so programmatic opens (via the menu, etc.)
  // pick it up too, not just the default layout builder above.
  if (id === "console") options.tabComponent = "console";
  // Position selection. We pick the first matching rule so the "right
  // thing" is always predictable:
  //   (a) No position in the spec → leave options.position unset;
  //       Dockview docks to the container edge (safest default).
  //   (b) Spec position has no reference panel (e.g. { direction: "right" })
  //       → use it as-is.
  //   (c) Spec position's anchor is visible → use it.
  //   (d) Spec position's anchor is hidden/missing → fall back to any
  //       currently visible panel as a "within" anchor so the panel still
  //       appears instead of silently failing. (This is the bugfix: the
  //       old logic picked `dock.api.panels[0]`, which is the first panel
  //       in serialization order and is often the very same hidden
  //       anchor the spec wanted — addPanel then no-ops without logging.)
  //   (e) No visible panels at all → leave options.position unset so
  //       Dockview docks to the container edge instead of failing.
  if (!position) {
    // (a)
  } else if (!position.referencePanel) {
    options.position = position; // (b)
  } else if (isUsableAnchor(dock.api.getPanel(position.referencePanel))) {
    // Pass the live object. String ids restored from an older layout can point
    // at a hidden/stale group even though getPanel briefly resolves them.
    options.position = {
      ...position,
      referencePanel: dock.api.getPanel(position.referencePanel),
    }; // (c)
  } else if (pickVisibleAnchor()) {
    // (d) — log so future layout-fallback surprises are debuggable.
    console.warn(
      `openPanel(${id}): preferred anchor "${position.referencePanel}" is not visible; docking to a visible panel.`,
    );
    options.position = {
      referencePanel: pickVisibleAnchor(),
      direction: "within",
    };
  }
  // (e) — no `options.position` set: addPanel docks to container edge.
  let panel;
  try {
    panel = dock.api.addPanel(options);
  } catch (err) {
    console.warn(`openPanel(${id}): addPanel with a position failed (${err.message}); docking to the container edge.`);
  }
  // Last resort: an anchor that looked usable can still be rejected (a group
  // mid-drag, a popout window that has since closed). Retrying WITHOUT a
  // position always docks to the container edge, which is ugly but visible —
  // strictly better than the click appearing to do nothing.
  if (!panel) {
    try {
      panel = dock.api.addPanel({ id, component: id, ...(options.tabComponent ? { tabComponent: options.tabComponent } : {}), title: spec.title });
    } catch (err) {
      console.error(`openPanel(${id}) failed: ${err.message}`);
      return;
    }
  }
  revealPanel(panel);
}

/** Wipes the saved layout and rebuilds the default one. */
export function resetLayout() {
  if (!dock.api) return;
  localStorage.removeItem(LAYOUT_KEY);
  dock.api.clear();
  buildDefaultLayout(dock.api);
}

function buildDefaultLayout(api) {
  api.addPanel({ id: "viewport", component: "viewport", title: "Viewport" });
  api.addPanel({
    id: "hierarchy",
    component: "hierarchy",
    title: "Hierarchy",
    position: { referencePanel: "viewport", direction: "left" },
    initialWidth: 260,
  });
  api.addPanel({
    id: "inspector",
    component: "inspector",
    title: "Inspector",
    position: { referencePanel: "viewport", direction: "right" },
    initialWidth: 320,
  });
  const assets = api.addPanel({
    id: "assets",
    component: "assets",
    title: "Assets",
    position: { referencePanel: "viewport", direction: "below" },
    initialHeight: 200,
  });
  api.addPanel({
    id: "console",
    component: "console",
    tabComponent: "console",
    title: "Console",
    position: { referencePanel: "assets", direction: "within" },
  });
  assets.api.setActive();
}

/**
 * Double-click a tab (or the empty part of a tab bar) to fill the window with
 * that panel; Escape puts it back.
 *
 * Dockview has the maximize API but binds no gesture to it, so a panel can only
 * be enlarged by dragging splitters — and there is no way at all to get a
 * temporarily-bigger viewport or paint canvas without wrecking the layout you
 * then have to rebuild by hand.
 *
 * Bound to the TAB BAR, never to the panel body: panel bodies are full of
 * double-click handlers already (renaming a layer, a keyframe, a graph node),
 * and a gesture that sometimes renames a layer and sometimes swallows the whole
 * screen is worse than no gesture.
 */
function installMaximizeGestures(api, container) {
  const groupFromEvent = (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return null;
    // A tab, or the strip they sit in — but not the buttons in it, which have
    // their own jobs (close, and any group actions).
    const bar = target.closest(".dv-tabs-and-actions-container, .dv-tab");
    if (!bar || target.closest(".dv-default-tab-action, button")) return null;
    const groupEl = target.closest(".dv-groupview");
    if (!groupEl) return null;
    return api.groups.find((group) => group.element === groupEl) ?? null;
  };

  const onDoubleClick = (event) => {
    const group = groupFromEvent(event);
    if (!group) return;
    event.preventDefault();
    if (group.api.isMaximized?.()) api.exitMaximizedGroup();
    else group.api.maximize?.();
  };

  const onKeyDown = (event) => {
    // Bubble phase and `defaultPrevented`-aware on purpose: a dialog, a rename
    // field or a modal tool gets Escape first and stops it. Un-maximizing is
    // the LAST thing Escape should mean, not the first.
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (!api.hasMaximizedGroup?.()) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && /input|textarea|select/i.test(active.tagName)) return;
    if (document.querySelector(".dropdown-menu, .texture-dialog, .modal, [role='dialog']")) return;
    api.exitMaximizedGroup();
  };

  container.addEventListener("dblclick", onDoubleClick);
  window.addEventListener("keydown", onKeyDown);

  // The layout change itself is instant (dockview hides the other groups), so
  // the animation is on the group that survives: without it a panel filling the
  // screen looks like a broken repaint rather than a deliberate zoom.
  api.onDidMaximizedGroupChange?.(() => {
    const maximized = api.hasMaximizedGroup?.();
    container.classList.toggle("dv-has-maximized", !!maximized);
    const group = maximized ? api.groups.find((g) => g.api.isMaximized?.()) : null;
    const element = group?.element ?? container;
    element.classList.remove("dv-zooming");
    // Force a reflow so re-adding the class restarts the animation when the
    // user maximizes two panels in a row.
    void element.offsetWidth;
    element.classList.add("dv-zooming");
    setTimeout(() => element.classList.remove("dv-zooming"), 220);
  });
}

function onDockReady(event) {
  const { api } = event;
  dock.api = api;
  // Same escape hatch ViewportPanel provides via `globalThis.__viewport`:
  // layout bugs ("the panel didn't open") are only diagnosable from the live
  // dock API, and harnesses need it to reproduce maximized/collapsed groups.
  if (import.meta.env?.DEV) globalThis.__dockApi = api;
  let restored = false;
  try {
    const saved = localStorage.getItem(LAYOUT_KEY);
    if (saved) {
      api.fromJSON(JSON.parse(saved));
      restored = true;
    }
  } catch (err) {
    console.warn(`Failed to restore layout, using default: ${err.message}`);
  }
  if (!restored || api.panels.length === 0) {
    if (restored) api.clear();
    buildDefaultLayout(api);
  }

  let saveTimer = null;
  api.onDidLayoutChange(() => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(api.toJSON()));
    }, 500);
  });

  // Flush any openPanel requests that came in while the dock was mounting.
  // We copy first because openPanel itself is read-only on `dock.api` (it's
  // set by the time we get here), but adding to a Set we're iterating over
  // would still be surprising — capturing the planned ids up-front and
  // clearing the queue keeps things deterministic if more clicks land during
  // the flush.
  if (dock.pending.size > 0) {
    const queued = [...dock.pending];
    dock.pending.clear();
    for (const id of queued) openPanel(id);
  }

  const container = event.containerApi?.element ?? document.querySelector(".dock-container");
  if (container) installMaximizeGestures(api, container);
}

export function EditorShell() {
  return (
    <div className="editor-root">
      <Suspense fallback={<PanelFallback />}>
        <EditorChrome />
      </Suspense>
      <QuickSearch />
      <Toasts />
      <div className="dock-container">
        <DockviewReact
          components={panelComponents}
          tabComponents={tabComponents}
          onReady={onDockReady}
          theme={themeAbyss}
          // Tauri's embedded webview can swallow HTML5 drag/drop events.
          // Pointer DnD keeps tabs movable between dock groups as well as
          // reorderable within their current group.
          dndStrategy="pointer"
        />
      </div>
    </div>
  );
}
