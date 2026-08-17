import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-react";
import { useProjectStore, basename } from "../store/projectStore.js";
import { useAssetDrop } from "../assetDrag.js";
import {
  createFolderIn,
  deleteEntries,
  invoke,
  moveDraggedIntoFolder,
  renameEntry,
} from "../assetOps.js";
import { ContextMenu, isTextEditTarget } from "../ContextMenu.jsx";

/**
 * Folder hierarchy sidebar for the Assets panel. Children are listed lazily
 * per-folder (a project can hold thousands of files, so there's no upfront
 * recursive walk) and cached until the project store reports a change.
 *
 * Rows are asset drop targets: dropping onto a folder moves the dragged
 * selection into it, same as dropping onto a folder tile in the grid.
 *
 * Selection works Explorer-style: plain click selects + navigates (the
 * default "open folder" UX), Ctrl/Cmd-click toggles a single row without
 * navigating, Shift-click extends a range over the visible rows. Delete
 * removes every selected folder and double-clicking the label renames it.
 */

const EXPANDED_KEY = "engine.assets.expandedFolders.v1";

function loadExpanded() {
  try {
    return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY)) ?? []);
  } catch {
    return new Set();
  }
}

/** Every ancestor of `path` up to and including `root`. */
function ancestorsOf(path, root) {
  if (!path || !root || !path.startsWith(root)) return [];
  const out = [root];
  const rest = path.slice(root.length).split(/[\\/]/).filter(Boolean);
  let acc = root;
  for (const part of rest) {
    acc = `${acc}/${part}`;
    out.push(acc);
  }
  return out;
}

/**
 * Walks the cached `childrenOf` map depth-first to produce the visible folder
 * paths in display order. Used as the universe for Shift-click range selects.
 */
function visibleFolderPaths(childrenOf, expanded, rootPath) {
  const out = [];
  if (!rootPath) return out;
  const visit = (path) => {
    out.push(path);
    if (!expanded.has(path)) return;
    const children = childrenOf.get(path);
    if (!children) return;
    for (const child of children) visit(child.path);
  };
  visit(rootPath);
  return out;
}

function FolderRow({
  path,
  name,
  depth,
  childrenOf,
  expanded,
  selectedSet,
  anchor,
  onSelect,
  onToggle,
  hasLoaded,
  renamingPath,
  setRenamingPath,
  onActivate,
  onContextMenu,
}) {
  const navigate = useProjectStore((s) => s.navigate);
  const currentPath = useProjectStore((s) => s.currentPath);
  // Compared here rather than by the parent: passing a BOOLEAN down and then
  // re-comparing it against the child's path (`renaming === child.path`) is
  // always false, which is how renaming used to work on the root row only.
  const renaming = renamingPath === path;
  const isOpen = expanded.has(path);
  const children = childrenOf.get(path);
  const active = currentPath === path;
  const selected = selectedSet.has(path);
  // Until a folder has been listed we don't know whether it has subfolders, so
  // show the chevron optimistically and let the first expand settle it.
  const expandable = !hasLoaded(path) || (children?.length ?? 0) > 0;

  const dropRef = useAssetDrop({
    accepts: (dragged) => dragged !== path,
    hoverClass: "drop-target",
    onDrop: (dragged) => moveDraggedIntoFolder(dragged, path),
  });

  // Plain click selects + navigates; Ctrl/Cmd toggles without navigating;
  // Shift extends the range from the anchor. Navigation is deferred by a short
  // debounce so a quick double-click on the label cancels it — otherwise the
  // first click would navigate into the folder before rename mode kicks in.
  const NAV_DELAY = 180;
  const navTimer = useRef(null);
  const handleClick = (e) => {
    onActivate?.();
    if (e.detail > 1) {
      clearTimeout(navTimer.current);
      navTimer.current = null;
      return;
    }
    if (e.shiftKey) {
      onSelect({ path, mode: "range", anchor });
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      onSelect({ path, mode: "toggle" });
      return;
    }
    onSelect({ path, mode: "replace" });
    clearTimeout(navTimer.current);
    navTimer.current = setTimeout(() => navigate(path), NAV_DELAY);
  };

  // Flush any pending navigation when the row unmounts (avoids navigating into
  // a folder that's been deleted).
  useEffect(() => () => clearTimeout(navTimer.current), []);

  const startRename = () => {
    // Make sure the row we're renaming is part of the selection so Delete can
    // still act on the rest of the selection afterwards.
    onActivate?.();
    onSelect({ path, mode: "replace" });
    setRenamingPath(path);
  };

  return (
    <>
      <div
        ref={dropRef}
        className={`folder-row ${active ? "active" : ""} ${selected ? "selected" : ""}`}
        style={{ paddingLeft: 4 + depth * 12 }}
        onClick={handleClick}
        onDoubleClick={() => startRename()}
        onContextMenu={(e) => onContextMenu?.(e, { path, name, isRoot: depth === 0 })}
        title={path}
      >
        <button
          className="folder-twisty"
          onClick={(e) => {
            e.stopPropagation();
            onToggle(path);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          tabIndex={-1}
        >
          {expandable ? (
            isOpen ? (
              <ChevronDown size={12} />
            ) : (
              <ChevronRight size={12} />
            )
          ) : null}
        </button>
        {isOpen ? <FolderOpen size={13} /> : <Folder size={13} />}
        {renaming ? (
          <input
            className="rename-input folder-rename"
            autoFocus
            defaultValue={name}
            onFocus={(e) => e.target.select()}
            onBlur={(e) => {
              setRenamingPath(null);
              renameEntry({ name, path }, e.target.value);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                setRenamingPath(null);
                renameEntry({ name, path }, e.target.value);
              }
              if (e.key === "Escape") setRenamingPath(null);
            }}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="folder-label">{name}</span>
        )}
      </div>
      {isOpen &&
        children?.map((child) => (
          <FolderRow
            key={child.path}
            path={child.path}
            name={child.name}
            depth={depth + 1}
            childrenOf={childrenOf}
            expanded={expanded}
            selectedSet={selectedSet}
            anchor={anchor}
            onSelect={onSelect}
            onToggle={onToggle}
            hasLoaded={hasLoaded}
            renamingPath={renamingPath}
            setRenamingPath={setRenamingPath}
            onActivate={onActivate}
            onContextMenu={onContextMenu}
          />
        ))}
    </>
  );
}

export function FolderTree() {
  const rootPath = useProjectStore((s) => s.rootPath);
  const currentPath = useProjectStore((s) => s.currentPath);
  const entries = useProjectStore((s) => s.entries);
  const changeCounter = useProjectStore((s) => s.changeCounter);
  const [expanded, setExpanded] = useState(loadExpanded);
  const [childrenOf, setChildrenOf] = useState(() => new Map()); // path -> [{name, path}]
  const [selected, setSelected] = useState(() => new Set());
  const [anchor, setAnchor] = useState(null);
  const [renamingPath, setRenamingPath] = useState(null);
  const [menu, setMenu] = useState(null); // {x, y, path, name, isRoot}
  const loadedRef = useRef(new Set());
  const treeRef = useRef(null);

  const hasLoaded = useCallback((path) => loadedRef.current.has(path), []);

  const listFolder = useCallback(async (path) => {
    try {
      const dirEntries = await invoke("list_dir", { path });
      // The tree only renders folders, but keep `is_dir` on the record so the
      // Delete shortcut can build an entry object without a re-fetch.
      const dirs = dirEntries
        .filter((e) => e.is_dir)
        .map((e) => ({ name: e.name, path: e.path, is_dir: true }));
      loadedRef.current.add(path);
      setChildrenOf((prev) => new Map(prev).set(path, dirs));
    } catch {
      loadedRef.current.add(path);
      setChildrenOf((prev) => new Map(prev).set(path, []));
    }
  }, []);

  // A refresh (create / delete / move / rename) is signalled by either
  // `entries` changing (the current folder was affected) or `changeCounter`
  // bumping (a sibling/ancestor path was modified). Either way, our cached
  // listings may be stale — re-list everything currently visible rather than
  // trying to guess what changed.
  useEffect(() => {
    if (!rootPath) return;
    loadedRef.current = new Set();
    const visible = [rootPath, ...[...expanded].filter((p) => p.startsWith(rootPath))];
    for (const path of new Set(visible)) listFolder(path);
    // `entries` and `changeCounter` are the change signals; `expanded`
    // changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath, entries, changeCounter, listFolder]);

  // List a folder the first time it's expanded.
  useEffect(() => {
    for (const path of expanded) {
      if (!loadedRef.current.has(path)) listFolder(path);
    }
  }, [expanded, listFolder]);

  // Reveal the browsed folder: expand its ancestors so it's visible in the tree.
  useEffect(() => {
    if (!currentPath || !rootPath) return;
    // Parents of the browsed folder, and the root itself (always open).
    const chain = [rootPath, ...ancestorsOf(currentPath, rootPath).slice(0, -1)];
    setExpanded((prev) => {
      if (chain.every((p) => prev.has(p))) return prev;
      const next = new Set(prev);
      for (const p of chain) next.add(p);
      return next;
    });
  }, [currentPath, rootPath]);

  useEffect(() => {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded]));
  }, [expanded]);

  const onToggle = useCallback((path) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const onSelect = useCallback(({ path, mode }) => {
    // Compute the next selection outside the setState updater so we can also
    // update the anchor atomically (and stay pure in Strict Mode).
    const prev = selectedRef.current;
    const next = new Set(prev);
    let nextAnchor = anchorRef.current;
    if (mode === "toggle") {
      if (next.has(path)) next.delete(path);
      else next.add(path);
      nextAnchor = path;
    } else if (mode === "range") {
      const order = visibleFolderPaths(childrenOfRef.current, expandedRef.current, rootPathRef.current);
      const from = order.indexOf(anchorRef.current ?? path);
      const to = order.indexOf(path);
      if (from === -1 || to === -1) {
        next.clear();
        next.add(path);
        nextAnchor = path;
      } else {
        const [lo, hi] = from < to ? [from, to] : [to, from];
        next.clear();
        for (let i = lo; i <= hi; i++) next.add(order[i]);
        // Shift-click never moves the range origin (Explorer behaviour).
      }
    } else {
      next.clear();
      next.add(path);
      nextAnchor = path;
    }
    setSelected(next);
    setAnchor(nextAnchor);
  }, []);

  const selectedRef = useRef(selected);
  useEffect(() => { selectedRef.current = selected; }, [selected]);

  // Keep refs of state that `onSelect` reads but shouldn't trigger a re-bind,
  // so the row click handlers stay referentially stable across re-renders.
  const childrenOfRef = useRef(childrenOf);
  const expandedRef = useRef(expanded);
  const rootPathRef = useRef(rootPath);
  const anchorRef = useRef(anchor);
  useEffect(() => { childrenOfRef.current = childrenOf; }, [childrenOf]);
  useEffect(() => { expandedRef.current = expanded; }, [expanded]);
  useEffect(() => { rootPathRef.current = rootPath; }, [rootPath]);
  useEffect(() => { anchorRef.current = anchor; }, [anchor]);

  // Drop selection rows that are no longer in the tree (after deletes, etc.).
  useEffect(() => {
    if (!selected.size || !rootPath) return;
    const known = new Set(visibleFolderPaths(childrenOf, expanded, rootPath));
    let changed = false;
    for (const p of selected) {
      if (!known.has(p)) { changed = true; break; }
    }
    if (changed) {
      const next = new Set();
      for (const p of selected) if (known.has(p)) next.add(p);
      setSelected(next);
    }
  }, [childrenOf, expanded, rootPath, selected]);

  // Drop expanded-folders entries that no longer exist on disk. Without this
  // the tree keeps trying to list deleted paths forever (silently failing),
  // and the stale ids live on in localStorage across sessions.
  useEffect(() => {
    if (!rootPath || !expanded.size) return;
    const known = new Set(visibleFolderPaths(childrenOf, expanded, rootPath));
    const live = new Set([rootPath, ...[...known]]);
    let changed = false;
    for (const p of expanded) {
      if (!live.has(p)) { changed = true; break; }
    }
    if (changed) {
      const next = new Set();
      for (const p of expanded) if (live.has(p)) next.add(p);
      setExpanded(next);
    }
  }, [childrenOf, rootPath, expanded]);

  // Delete key on the tree deletes every selected folder. Skip while renaming so
  // Backspace inside the input still edits text.
  useEffect(() => {
    const onKey = (e) => {
      // Optional call: a keydown does not always carry an Element target — a
      // synthetic event dispatched on `window` hands us the window itself, and
      // an unguarded `.closest` there takes down the whole handler chain.
      if (e.target.closest?.("input")) return;
      if (e.key !== "Delete" || !selected.size) return;
      const tree = treeRef.current;
      if (!tree) return;
      // Only act when focus is inside the tree — otherwise let Delete work in
      // the asset grid (or other panels) as before.
      if (!tree.contains(document.activeElement) && document.activeElement !== tree) return;
      e.preventDefault();
      const list = [...selected].map((p) => ({ path: p, name: basename(p), is_dir: true }));
      deleteEntries(list);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  // The root row is non-deletable — make sure it never lands in the selection.
  const visibleSet = useMemo(
    () => new Set(visibleFolderPaths(childrenOf, expanded, rootPath)),
    [childrenOf, expanded, rootPath],
  );
  const safeSelected = useMemo(() => {
    if (!rootPath) return new Set();
    const next = new Set();
    for (const p of selected) {
      if (p !== rootPath && visibleSet.has(p)) next.add(p);
    }
    return next;
  }, [selected, visibleSet, rootPath]);

  // Right-click on a row. Mirrors the grid's menu: clicking outside the
  // selection re-selects the row first, so the menu always acts on what is
  // highlighted rather than on something the user can't see is targeted.
  const openMenu = useCallback(
    (event, target) => {
      if (isTextEditTarget(event.target)) return;
      event.preventDefault();
      // Without this the sidebar container's own menu — and the window-level
      // fallback in nativeContextMenu.jsx — would fire too and replace this one.
      event.stopPropagation();
      treeRef.current?.focus({ preventScroll: true });
      // Empty space is not a row: right-clicking it must not throw away a
      // selection the user built up in order to ask about the folder they are in.
      if (!target.background && !selectedRef.current.has(target.path)) {
        onSelect({ path: target.path, mode: "replace" });
      }
      setMenu({ x: event.clientX, y: event.clientY, ...target });
    },
    [onSelect],
  );

  /**
   * What the menu acts on: the whole selection when the clicked row is part of
   * it, otherwise just that row. The root is never a target — deleting the
   * project folder from inside the project is not a thing to offer.
   */
  const menuTargets = () => {
    if (!menu || menu.isRoot) return [];
    const selection = [...safeSelected];
    return selection.length > 1 && selection.includes(menu.path)
      ? selection.map((path) => ({ path, name: basename(path), is_dir: true }))
      : [{ path: menu.path, name: menu.name, is_dir: true }];
  };

  const revealFolder = async (path) => {
    try {
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(path);
    } catch (err) {
      console.warn(`Couldn't reveal ${path}: ${err?.message ?? err}`);
    }
  };

  const menuItems = () => {
    if (!menu) return [];
    const targets = menuTargets();
    const many = targets.length > 1;
    return [
      !menu.isRoot && { label: "Open", action: () => useProjectStore.getState().navigate(menu.path) },
      {
        label: "New Folder",
        hint: `Create a subfolder inside ${menu.name}`,
        action: async () => {
          const created = await createFolderIn(menu.path);
          if (!created) return;
          // Expand the parent, or the new folder is created somewhere the user
          // can't see it — and drop straight into rename, same as Ctrl+G does.
          setExpanded((prev) => new Set(prev).add(menu.path));
          setRenamingPath(created);
        },
      },
      { separator: true },
      {
        label: "Rename",
        disabled: menu.isRoot,
        hint: menu.isRoot ? "The project root is renamed on disk, not from here" : undefined,
        action: () => setRenamingPath(menu.path),
      },
      { label: "Show in Explorer", action: () => revealFolder(menu.path) },
      { separator: true },
      {
        label: many ? `Delete ${targets.length} folders` : "Delete",
        shortcut: "Del",
        danger: true,
        disabled: !targets.length,
        hint: menu.isRoot ? "The project root can't be deleted from here" : undefined,
        action: () => deleteEntries(targets),
      },
    ];
  };

  if (!rootPath) return null;

  return (
    <div
      className="folder-tree"
      ref={treeRef}
      tabIndex={0}
      onClick={(e) => e.stopPropagation()}
      // Empty space below the rows still belongs to a folder — the root — so
      // right-clicking it offers what you can do there rather than nothing.
      onContextMenu={(e) =>
        openMenu(e, { path: rootPath, name: basename(rootPath), isRoot: true, background: true })
      }
    >
      <FolderRow
        path={rootPath}
        name={basename(rootPath)}
        depth={0}
        childrenOf={childrenOf}
        expanded={expanded}
        selectedSet={safeSelected}
        anchor={anchor}
        onSelect={onSelect}
        onToggle={onToggle}
        hasLoaded={hasLoaded}
        renamingPath={renamingPath}
        setRenamingPath={setRenamingPath}
        onActivate={() => treeRef.current?.focus({ preventScroll: true })}
        onContextMenu={openMenu}
      />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems()} onClose={() => setMenu(null)} />}
    </div>
  );
}