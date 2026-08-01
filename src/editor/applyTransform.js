import { engine } from "./engineInstance.js";
import { commandBus } from "./commands/CommandBus.js";
import { invalidateBlobUrl, writeBinaryFile } from "./assetLoader.js";
import { useProjectStore } from "./store/projectStore.js";
import { authoredGeometry, uniqueGeometryPath } from "./geometryEditing.js";
import { encodeGeometryAsset, geometryAssetFromBufferGeometry } from "../engine/geometryAsset.js";
import { invalidateVirtualGeometryAsset } from "../modules/virtual-geometry/index.js";
import {
  APPLY_MODES,
  APPLY_MODE_LABELS,
  applyPlan,
  bakeMatrixIntoGeometry,
  isIdentityMatrix,
} from "../engine/geometryTransform.js";

export { APPLY_MODES, APPLY_MODE_LABELS, applyPlan, bakeMatrixIntoGeometry };

/**
 * Blender's Object → Apply → Transform (Ctrl+A).
 *
 * Bakes some or all of an entity's local transform into its mesh data and
 * clears the part that was baked, so the object looks identical and its
 * transform reads 0/0/0, 1/1/1. Every downstream system that consumes raw
 * geometry — the instancer, physics collider fitting, decal projection, the
 * geometry editor's own coordinate readouts — then sees the shape the author
 * actually built rather than a unit cube with a matrix bolted to it.
 *
 * ## The mode matters, and not all of them are visually neutral
 *
 * An object matrix is `T · R · S`. Applying a suffix of that product is exact
 * (the remaining factors still multiply in the same order); applying a prefix
 * is not. So:
 *
 *   all            bake T·R·S, clear everything          — exact
 *   rotationScale  bake R·S, keep T                      — exact
 *   scale          bake S, keep T·R                      — exact
 *   rotation       bake R, keep T and S                  — exact only if S is uniform
 *   position       bake T, keep R and S                  — exact only if R·S is identity
 *
 * Blender behaves the same way and is famously quiet about it. The two lossy
 * modes are still offered (they are what you want when the object has no scale
 * or no rotation, which is most of the time) but they say so in the result.
 *
 * ## Where the geometry goes
 *
 * A mesh with no `.geom` asset is a PROCEDURAL primitive — its geometry is
 * rebuilt from `props.geometry` ("box", "sphere", …) on every attach, so baking
 * into the live BufferGeometry would be undone by the next scene load. Those
 * are written out as a new asset, which is also what makes the operation mean
 * anything. A geometry shared by several meshes is forked rather than rewritten
 * (Blender refuses outright with "Cannot apply to a multi user"; forking does
 * the same job without making the user go and find the Make Single User item).
 * Only a single-user asset is rewritten in place.
 */

const safeStem = (value) => (value || "Geometry").replace(/[^a-z0-9 _-]/gi, "").trim() || "Geometry";

/** Entity ids whose mesh component renders `path`. */
export function geometryAssetUsers(path) {
  if (!path) return [];
  const users = [];
  for (const entity of engine.entities.values()) {
    if (entity.getComponent?.("mesh")?.props?.geometryAsset === path) users.push(entity.id);
  }
  return users;
}

/**
 * Whether Apply Transform can run, and what it would do.
 *
 * Returned rather than thrown so the menu can grey the item out and say why
 * in the same pass it uses to build the labels.
 */
export function applyTransformStatus(entityId) {
  const entity = engine.getEntity(entityId);
  const component = entity?.getComponent?.("mesh");
  if (!component) {
    return { ok: false, reason: "Only a Mesh component has geometry to bake a transform into" };
  }
  if (!authoredGeometry(entity)) {
    return { ok: false, reason: "This mesh has no geometry yet" };
  }
  const path = component.props.geometryAsset || "";
  const users = geometryAssetUsers(path);
  return {
    ok: true,
    path,
    // "fork" covers both the procedural primitive and the shared asset: in
    // both cases the bake must land somewhere that is this entity's alone.
    fork: !path || users.length > 1,
    sharedWith: Math.max(0, users.length - 1),
  };
}

/** Writes a BufferGeometry to `path` as a binary `.geom` and refreshes its users. */
async function writeGeometry(path, geometry) {
  await writeBinaryFile(path, encodeGeometryAsset(geometryAssetFromBufferGeometry(geometry)));
  invalidateBlobUrl(path);
  // The cluster DAG cached for this asset indexes triangles that have just
  // moved; dropping it makes the reload re-virtualize from the new ones rather
  // than render a LOD cut of the mesh this used to be.
  invalidateVirtualGeometryAsset(path);
  reloadGeometryUsers(path);
}

/** Re-reads `path` on every mesh rendering it. */
export function reloadGeometryUsers(path) {
  for (const entity of engine.entities.values()) {
    const mesh = entity.getComponent?.("mesh");
    if (mesh?.props.geometryAsset === path) mesh.setProp("geometryAsset", path);
  }
}

/**
 * One undoable Apply Transform.
 *
 * The entity-side half (the transform, and which asset the mesh points at) is
 * synchronous and exactly reversible, so Ctrl+Z restores it immediately. The
 * disk write is not: a fork leaves its new `.geom` on disk (harmless — undo
 * simply stops pointing at it, and redo needs it back), while an in-place
 * rewrite is undone by baking the INVERSE matrix into the same file, which is
 * exact because a matrix bake is exactly invertible.
 */
class ApplyTransformCommand {
  constructor({ entityId, mode, matrix, next, before, path, previousPath, forked }) {
    this.entityId = entityId;
    this.mode = mode;
    this.matrix = matrix;
    this.inverse = matrix.clone().invert();
    this.next = next;
    this.before = before;
    this.path = path;
    this.previousPath = previousPath;
    this.forked = forked;
    this.label = `Apply ${APPLY_MODE_LABELS[mode] ?? mode}`;
    // The first `do()` is the one the caller already performed (the geometry is
    // written before the command is pushed, so a failed write never lands in
    // the history). Only a REDO has to re-do anything.
    this._applied = true;
  }

  do() {
    const entity = engine.getEntity(this.entityId);
    if (!entity) return;
    const component = entity.getComponent("mesh");
    if (this.forked && component) component.setProp("geometryAsset", this.path);
    entity.setTransform(this.next);
    if (this._applied) {
      this._applied = false;
      return;
    }
    // Redo of an in-place rewrite: the file currently holds the un-baked
    // geometry (undo put it back), so bake it again.
    if (!this.forked) this.#rebake(this.matrix);
  }

  undo() {
    const entity = engine.getEntity(this.entityId);
    if (!entity) return;
    const component = entity.getComponent("mesh");
    if (this.forked && component) component.setProp("geometryAsset", this.previousPath);
    entity.setTransform(this.before);
    if (!this.forked) this.#rebake(this.inverse);
  }

  #rebake(matrix) {
    const entity = engine.getEntity(this.entityId);
    const geometry = entity && authoredGeometry(entity);
    if (!geometry) return;
    const baked = bakeMatrixIntoGeometry(geometry, matrix);
    writeGeometry(this.path, baked)
      .catch((error) => console.error(`Apply Transform could not rewrite ${this.path}:`, error))
      .finally(() => baked.dispose());
  }
}

/**
 * Applies `mode` of the entity's transform to its geometry.
 *
 * @returns {Promise<{ok: boolean, message: string, path?: string}>}
 */
export async function applyTransformToGeometry(entityId, mode = "all") {
  const status = applyTransformStatus(entityId);
  if (!status.ok) return { ok: false, message: status.reason };
  const entity = engine.getEntity(entityId);
  const component = entity.getComponent("mesh");
  const geometry = authoredGeometry(entity);
  const { matrix, next, warning } = applyPlan(entity.getTransform(), mode);

  // An identity bake would fork a primitive into an asset for no reason and
  // leave an undo step that does nothing.
  if (isIdentityMatrix(matrix)) {
    return { ok: false, message: "Nothing to apply — that part of the transform is already identity" };
  }

  const previousPath = component.props.geometryAsset || "";
  let path = previousPath;
  if (status.fork) {
    const root = useProjectStore.getState().rootPath;
    if (!root) return { ok: false, message: "Open a project before applying a transform" };
    path = await uniqueGeometryPath(root, safeStem(entity.name));
  }

  const baked = bakeMatrixIntoGeometry(geometry, matrix);
  try {
    await writeGeometry(path, baked);
  } catch (error) {
    baked.dispose();
    return { ok: false, message: `Could not write ${path}: ${error.message ?? error}` };
  }
  baked.dispose();
  if (status.fork) await useProjectStore.getState().refresh();

  // Pushed only after the write succeeded: a history entry for a bake that
  // never reached disk would undo a change that never happened.
  const command = new ApplyTransformCommand({
    entityId,
    mode,
    matrix,
    next,
    before: entity.getTransform(),
    path,
    previousPath,
    forked: status.fork,
  });
  // `execute` calls `do()` — the `_applied` latch makes that first call set the
  // transform and the asset pointer without re-baking geometry that is already
  // on disk. Calling `do()` here as well would bake it twice.
  commandBus.execute(command);

  const name = path.split(/[\\/]/).pop();
  const parts = [`Applied ${APPLY_MODE_LABELS[mode] ?? mode}`];
  if (status.fork) {
    parts.push(
      previousPath
        ? `— forked to ${name} (${status.sharedWith} other mesh${status.sharedWith === 1 ? "" : "es"} still use the original)`
        : `— saved as ${name}`,
    );
  }
  if (warning) parts.push(`· ${warning}`);
  return { ok: true, message: parts.join(" "), path };
}

