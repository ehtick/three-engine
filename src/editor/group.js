// @ts-check
import { ensureEngine } from "./engineInstance.js";
import { commandBus } from "./commands/CommandBus.js";
import { topMostIds } from "./commands/entityCommands.js";
import { useSelectionStore } from "./store/selectionStore.js";

/**
 * Creates a fresh empty "Group" entity and reparents every top-most
 * selected entity under it as a single undoable step.
 *
 * Layout rules:
 *  - If the selection shares a common parent (typical case after a
 *    Shift-click range or Ctrl-click on siblings), the new Group is
 *    inserted at the position of the first selected child under that
 *    parent — so the group visually replaces the children in place.
 *  - If the selection spans multiple parents, the new Group goes to the
 *    scene root and the children are gathered under it. Mixed-parent
 *    cases are rare (Shift-click range only spans one subtree), so the
 *    resulting layout is still predictable.
 *  - Children are appended to the new Group in selection order.
 *
 * Implemented as a single custom command rather than a BatchCommand of
 * CreateEntityCommand + N ReparentEntityCommand because the reparent
 * commands need the freshly-created group's id, which the existing
 * CreateEntityCommand only assigns during its own do(). Bundling the
 * whole operation into one command keeps the history entry atomic and
 * avoids the chicken-and-egg id problem.
 */
class GroupSelectionCommand {
  constructor(engine, ids, groupName = "Group") {
    this.engine = engine;
    this.ids = ids;
    this.groupName = groupName;
    // Assigned on first do(): the id of the freshly-created Group entity,
    // plus the captured pre-reparent state of each child so undo can
    // restore both the hierarchy and the world transforms.
    this.groupId = null;
    this.snapshot = null; // { commonParentId, groupIndex, reparent: [{id, oldParentId, oldIndex, oldTransform}] }
    this.label = ids.length === 1
      ? `Group entity`
      : `Group ${ids.length} entities`;
  }

  do() {
    const engine = this.engine;
    const ids = this.ids;

    // Determine the common parent. If every selected entity has the same
    // parent, the group lands as a sibling under that parent. Otherwise the
    // group lands at the scene root.
    const firstEntity = engine.getEntity(ids[0]);
    const commonParentId = firstEntity?.parent?.id ?? null;
    let allShareParent = true;
    for (const id of ids) {
      const entity = engine.getEntity(id);
      if (!entity || (entity.parent?.id ?? null) !== commonParentId) {
        allShareParent = false;
        break;
      }
    }

    // Compute the group's sibling index. When sharing a parent, insert the
    // group at the first selected child's index so it visually replaces the
    // children in the hierarchy list. At the scene root we always append.
    let groupIndex = null;
    if (allShareParent && commonParentId !== null) {
      const parent = firstEntity.parent;
      const siblingList = parent.children;
      const firstIdx = siblingList.indexOf(firstEntity);
      groupIndex = firstIdx === -1 ? null : firstIdx;
    }

    // Capture each child's pre-reparent state for undo.
    const reparentSnapshot = ids.map((id) => {
      const entity = engine.getEntity(id);
      return {
        id,
        oldParentId: entity.parent?.id ?? null,
        oldIndex: entity.parent
          ? entity.parent.children.indexOf(entity)
          : engine.rootEntities.indexOf(entity),
        oldTransform: entity.getTransform(),
      };
    });

    // Create the group as an empty entity (no components). Engine.createEntity
    // already mints a unique id and calls setParent; we then splice it into
    // the desired sibling slot if we're sharing a parent.
    const parentEntity = allShareParent && commonParentId !== null
      ? engine.getEntity(commonParentId)
      : null;
    const group = engine.createEntity({
      name: this.groupName,
      parent: parentEntity,
    });
    if (groupIndex !== null && parentEntity) {
      const siblings = parentEntity.children;
      const currentIdx = siblings.indexOf(group);
      if (currentIdx !== -1 && currentIdx !== groupIndex) {
        siblings.splice(currentIdx, 1);
        siblings.splice(Math.min(groupIndex, siblings.length), 0, group);
      }
      engine.emit("hierarchy-changed");
    }

    // Reparent each selected child into the group, appending in selection
    // order. attach() preserves the child's world transform; setParent()
    // updates the Entity tree. Mirrors ReparentEntityCommand.do() without
    // the index arg.
    for (const child of reparentSnapshot) {
      const entity = engine.getEntity(child.id);
      if (!entity) continue;
      group.object3D.attach(entity.object3D);
      entity.setParent(group);
    }
    engine.emit("hierarchy-changed");

    this.groupId = group.id;
    this.snapshot = { commonParentId, allShareParent, groupIndex, reparent: reparentSnapshot };
  }

  undo() {
    if (!this.snapshot || !this.groupId) return;
    const engine = this.engine;
    const group = engine.getEntity(this.groupId);
    if (!group) return;

    // Reverse the reparent in reverse order so earlier-index children are
    // restored before later-index ones (the inverse of the order they were
    // appended). Each restore also re-inserts the child at its original
    // index and writes its pre-drag local transform so world-space pose
    // matches what it was before Group was applied.
    const restore = [...this.snapshot.reparent].reverse();
    for (const entry of restore) {
      const entity = engine.getEntity(entry.id);
      if (!entity) continue;
      const oldParent = entry.oldParentId ? engine.getEntity(entry.oldParentId) : null;
      (oldParent ? oldParent.object3D : engine.scene).attach(entity.object3D);
      entity.setParent(oldParent);
      const siblings = oldParent ? oldParent.children : engine.rootEntities;
      const idx = siblings.indexOf(entity);
      if (idx !== -1 && entry.oldIndex !== -1 && entry.oldIndex !== idx) {
        siblings.splice(idx, 1);
        siblings.splice(Math.min(entry.oldIndex, siblings.length), 0, entity);
      }
      entity.setTransform(entry.oldTransform);
    }

    // Destroy the empty group. Its children list is empty after the
    // reparents above, so this is a clean destroyEntity.
    engine.destroyEntity(group);
    this.groupId = null;
  }
}

/**
 * Groups every top-most selected entity under a fresh empty "Group" parent
 * as one undoable step. Selects the new group on success so the user can
 * immediately rename it or keep grouping.
 *
 * Exposed as an async function so callers can `await ensureEngine()` the
 * same way duplicateSelection / deleteSelection do.
 */
export async function groupSelection() {
  const engine = await ensureEngine();
  const rawIds = useSelectionStore.getState().ids;
  // topMostIds drops descendants of other selected rows; preserve the
  // remaining ordering for selection-order child placement.
  const top = topMostIds(rawIds).filter((id) => engine.getEntity(id));
  if (!top.length) return;

  const cmd = new GroupSelectionCommand(engine, top);
  commandBus.execute(cmd);
  if (cmd.groupId) {
    useSelectionStore.getState().select([cmd.groupId]);
  }
}
