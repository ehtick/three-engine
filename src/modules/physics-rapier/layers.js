/**
 * Collision layers and the layer matrix.
 *
 * Without these, every collider collides with every other collider, and the
 * first thing anyone building a game hits is that a bullet spawned at the
 * muzzle immediately collides with the player who fired it. The fix is not
 * per-collider hacks — it is the Unity/Godot model: each collider is on ONE
 * named layer, and a symmetric matrix says which layers interact.
 *
 * Rapier expresses this as a u32 per collider: the upper 16 bits are the
 * layer's *membership* and the lower 16 its *filter*. Two colliders interact
 * only if each one's membership is in the other's filter — which is exactly a
 * symmetric matrix, so the two models line up with no fudging.
 *
 * QUERIES DELIBERATELY DO NOT USE THE MATRIX. A `raycast(..., { layers: [...] })`
 * filters by a predicate instead, so a layer that collides with nothing (a
 * trigger volume, say) is still raycastable when you explicitly ask for it.
 * Passing the collision groups to the query would make such a layer invisible
 * to every query — technically consistent, endlessly surprising.
 */

/** Rapier packs membership+filter into one u32, so 16 layers is the ceiling. */
export const MAX_PHYSICS_LAYERS = 16;

export const DEFAULT_PHYSICS_LAYERS = [
  "Default",
  "Player",
  "Enemy",
  "Projectile",
  "Ground",
  "Trigger",
  "Debris",
  "NoCollision",
];

const ALL_BITS = 0xffff;

export class PhysicsLayers {
  constructor(config) {
    this.set(config);
  }

  /**
   * @param names   ordered layer names; index is the bit position
   * @param matrix  matrix[i] = bitmask of layers i collides with. Omitted =
   *                everything collides with everything, which is the
   *                behaviour projects had before layers existed.
   */
  set({ names, matrix } = {}) {
    const list = (Array.isArray(names) && names.length ? names : DEFAULT_PHYSICS_LAYERS)
      .slice(0, MAX_PHYSICS_LAYERS)
      .map((name, i) => String(name ?? "").trim() || `Layer ${i}`);
    this.names = list;
    this._index = new Map(list.map((name, i) => [name.toLowerCase(), i]));
    const mask = (1 << list.length) - 1;
    this.matrix = list.map((_, i) => {
      const row = Array.isArray(matrix) ? Number(matrix[i]) : NaN;
      return (Number.isFinite(row) ? row : ALL_BITS) & mask;
    });
    // A hand-edited or half-migrated matrix can disagree with itself. Physics
    // has no notion of "A hits B but B does not hit A", so fold the two halves
    // together rather than letting Rapier silently pick one.
    this.#symmetrize();
  }

  #symmetrize() {
    for (let i = 0; i < this.matrix.length; i++) {
      for (let j = i + 1; j < this.matrix.length; j++) {
        // AND, not OR: if the two halves disagree, the pair does NOT collide.
        // Unchecking one box in the matrix UI is a request to disable the
        // pair, and "off" is the conservative reading of a half-migrated file.
        const on = !!(this.matrix[i] & (1 << j)) && !!(this.matrix[j] & (1 << i));
        if (on) {
          this.matrix[i] |= 1 << j;
          this.matrix[j] |= 1 << i;
        } else {
          this.matrix[i] &= ~(1 << j);
          this.matrix[j] &= ~(1 << i);
        }
      }
    }
  }

  /** Layer index for a name. Unknown names fall back to 0 ("Default"). */
  indexOf(name) {
    if (typeof name === "number") return name >= 0 && name < this.names.length ? name : 0;
    return this._index.get(String(name ?? "").trim().toLowerCase()) ?? 0;
  }

  has(name) {
    return this._index.has(String(name ?? "").trim().toLowerCase());
  }

  collides(a, b) {
    const i = this.indexOf(a);
    const j = this.indexOf(b);
    return !!(this.matrix[i] & (1 << j));
  }

  setCollides(a, b, value) {
    const i = this.indexOf(a);
    const j = this.indexOf(b);
    if (value) {
      this.matrix[i] |= 1 << j;
      this.matrix[j] |= 1 << i;
    } else {
      this.matrix[i] &= ~(1 << j);
      this.matrix[j] &= ~(1 << i);
    }
  }

  /** The u32 a collider on this layer gets: (membership << 16) | filter. */
  groupsFor(layer) {
    const i = this.indexOf(layer);
    return ((1 << i) << 16) | (this.matrix[i] & ALL_BITS);
  }

  /**
   * Bitmask for a query's `layers` option. `null`/omitted means every layer,
   * so a query with no filter behaves like it always did.
   */
  maskFor(layers) {
    if (layers == null) return ALL_BITS;
    const list = Array.isArray(layers) ? layers : [layers];
    let mask = 0;
    for (const name of list) mask |= 1 << this.indexOf(name);
    return mask;
  }

  toJSON() {
    return { names: [...this.names], matrix: [...this.matrix] };
  }
}
