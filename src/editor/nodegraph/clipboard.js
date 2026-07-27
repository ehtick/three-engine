/**
 * Copy / cut / paste / duplicate for node-graph selections.
 *
 * The buffer is module-level (not the OS clipboard) so a copy survives panel
 * remounts and works between the shader and particle graphs' own instances
 * without asking for clipboard permissions. `kind` tags which registry the
 * nodes came from, so pasting a shader node into the particle graph is
 * rejected instead of producing nodes the compiler doesn't know.
 */

let buffer = null; // { kind, nodes, edges }

const freshId = (type) => `${type}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Stores the selected nodes plus every edge *between* them. Edges to
 * unselected nodes are dropped — pasting them would wire the copy back into
 * the original's neighbours, which is never what a user means by "copy".
 */
export function copySelection(kind, nodes, edges, { protectedTypes = [] } = {}) {
  const selected = nodes.filter((n) => n.selected && !protectedTypes.includes(n.data?.nodeType));
  if (!selected.length) return false;
  const ids = new Set(selected.map((n) => n.id));
  buffer = {
    kind,
    nodes: selected.map((n) => ({
      id: n.id,
      type: n.type,
      position: { ...n.position },
      data: { nodeType: n.data.nodeType, props: structuredClone(n.data.props ?? {}) },
      ...(n.style ? { style: { ...n.style } } : {}),
      ...(n.width != null ? { width: n.width } : {}),
      ...(n.height != null ? { height: n.height } : {}),
    })),
    edges: edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ({
        source: e.source,
        sourceHandle: e.sourceHandle ?? "out",
        target: e.target,
        targetHandle: e.targetHandle,
      })),
  };
  return true;
}

export function hasClipboard(kind) {
  return !!buffer && buffer.kind === kind;
}

/**
 * Returns `{nodes, edges}` to append, with fresh ids and internal edges
 * remapped onto them. `at` (flow coords) places the pasted block's top-left
 * corner; without it the block lands offset from the original so the copy is
 * visibly distinct instead of sitting exactly on top of its source.
 */
export function pasteClipboard(kind, { at = null, offset = 28 } = {}) {
  if (!hasClipboard(kind)) return null;
  const idMap = new Map();
  let minX = Infinity;
  let minY = Infinity;
  for (const n of buffer.nodes) {
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
  }
  const dx = at ? at.x - minX : offset;
  const dy = at ? at.y - minY : offset;

  const nodes = buffer.nodes.map((n) => {
    const id = freshId(n.data.nodeType);
    idMap.set(n.id, id);
    return {
      ...n,
      id,
      // Pasted nodes come in selected so the user can immediately drag the
      // whole block, and so a second paste replaces rather than accumulates.
      selected: true,
      position: { x: n.position.x + dx, y: n.position.y + dy },
      data: { nodeType: n.data.nodeType, props: structuredClone(n.data.props ?? {}) },
    };
  });
  const edges = buffer.edges.map((e) => ({
    id: `e-${idMap.get(e.source)}-${idMap.get(e.target)}-${e.targetHandle}`,
    source: idMap.get(e.source),
    sourceHandle: e.sourceHandle,
    target: idMap.get(e.target),
    targetHandle: e.targetHandle,
  }));
  return { nodes, edges };
}

/** Copy + paste in one step, bypassing the shared buffer so Ctrl+D never
 *  clobbers whatever the user had copied earlier. */
export function duplicateSelection(kind, nodes, edges, opts = {}) {
  const saved = buffer;
  const ok = copySelection(kind, nodes, edges, opts);
  const result = ok ? pasteClipboard(kind, opts) : null;
  buffer = saved;
  return result;
}
