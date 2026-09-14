/**
 * ⭐ STABLE INSTANCE CAPACITIES (09-14, Complex scene: 3-5 min from boot to a
 * settled World).
 *
 * three builds an InstancedMesh's matrix node from `instanceMatrix.count` — the
 * ALLOCATED capacity, not `mesh.count`. While `capacity × 64` bytes fits the
 * device's `maxUniformBufferBindingSize` (65 536 unless the engine asks for
 * more, i.e. ≤ 1024 matrices), that capacity is written into the vertex WGSL as
 * a literal (`array< mat4x4<f32>, 982 >`); above it the matrices become
 * instanced attributes and the text no longer depends on the count.
 *
 * Batches sized exactly to their population therefore gave every streamed
 * foliage population a new ~44 kB vertex program (plus its shadow twin) each
 * time it grew, and different text on every boot, so Dawn's shader cache never
 * served them: `profile.freezes.wgsl` showed those modules compiling cold 108 to
 * 191 s into the boot, with every impostor bake queued behind them. Capacities
 * now come from a small fixed set — at least `INSTANCE_CAPACITY_FLOOR`, then
 * powers of two — so a population's program text is identical while it grows
 * and from one boot to the next.
 */
export const INSTANCE_CAPACITY_FLOOR = 1024;

/** The smallest stable capacity that holds `needed` instances. */
export function stableInstanceCapacity(needed) {
  const count = Math.max(1, Math.ceil(Number(needed) || 0));
  return Math.max(INSTANCE_CAPACITY_FLOOR, 2 ** Math.ceil(Math.log2(count)));
}
