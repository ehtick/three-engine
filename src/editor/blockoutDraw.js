/**
 * The arithmetic of a blockout gesture: two points on the draw plane in, one
 * piece spec out.
 *
 * Split from the viewport plumbing on purpose — this is where every "the wall
 * came out facing the wrong way" and "a click should give me one tile" bug
 * lives, and it is testable in plain node because it touches nothing but
 * numbers. `blockoutTool.js` raycasts and renders; this decides what was drawn.
 *
 * Angle convention, which is the part that is easy to get backwards: a Y
 * rotation of θ maps local +X to (cos θ, 0, −sin θ) and local +Z to
 * (sin θ, 0, cos θ). Walls run along their local X, stairs and ramps climb
 * along their local +Z, so the two get different formulas rather than one
 * shared "yaw from a direction" helper that is right for one of them.
 */

/** Rounds to the nearest multiple of `step`. `step` 0 means "don't snap". */
export function snapValue(value, step) {
  if (!(step > 0)) return value;
  return Math.round(value / step) * step;
}

/** Snaps a point on the draw plane. Y is the plane's elevation and untouched:
 *  the storey decides the height, never the ray. */
export function snapPoint(point, step) {
  return { x: snapValue(point.x, step), y: point.y, z: snapValue(point.z, step) };
}

/** Nearest multiple of `degrees`, in radians. 0 leaves the angle alone. */
export function snapAngle(radians, degrees) {
  if (!(degrees > 0)) return radians;
  const step = (degrees * Math.PI) / 180;
  return Math.round(radians / step) * step;
}

/** A drag shorter than this is a click, not a drag. In metres — half the
 *  smallest grid anyone blocks out with. */
const CLICK_EPSILON = 0.02;

/**
 * The rectangle a footprint drag covers.
 *
 * A click (a === b) yields ONE grid cell extending in the +X/+Z direction from
 * the point, rather than a zero-size piece or a cell centred on the click.
 * That is what makes click-placing slabs tile: each click fills the cell whose
 * corner you clicked, and the grid you see is the grid you get.
 */
export function footprint(a, b, grid) {
  const cell = grid > 0 ? grid : 1;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const sx = Math.abs(dx) < CLICK_EPSILON ? cell : Math.abs(dx);
  const sz = Math.abs(dz) < CLICK_EPSILON ? cell : Math.abs(dz);
  const cx = Math.abs(dx) < CLICK_EPSILON ? a.x + sx / 2 : (a.x + b.x) / 2;
  const cz = Math.abs(dz) < CLICK_EPSILON ? a.z + sz / 2 : (a.z + b.z) / 2;
  return { cx, cz, sx, sz };
}

/**
 * The piece a drag from `a` to `b` describes, or null when the gesture has not
 * said enough yet (a wall needs a direction; a slab does not).
 *
 * Returns world-space `position` / `rotationY` and local `size`, which is
 * exactly what `levelBuild.createPiece` takes — the tool never rewrites this.
 */
export function pieceFromDrag(tool, a, b, settings = {}) {
  const grid = settings.grid ?? 0;
  const angleSnap = settings.angleSnap ?? 0;
  const wallHeight = settings.wallHeight ?? 3;
  const wallThickness = settings.wallThickness ?? 0.2;
  const slabThickness = settings.slabThickness ?? 0.2;
  const stairWidth = settings.stairWidth ?? 1.4;
  const storeyHeight = settings.storeyHeight ?? 3;
  const elevation = a.y ?? 0;

  switch (tool) {
    case "floor":
    case "platform": {
      const { cx, cz, sx, sz } = footprint(a, b, grid);
      return {
        shape: tool,
        position: [cx, elevation, cz],
        rotationY: 0,
        size: [sx, slabThickness, sz],
      };
    }

    case "box": {
      const { cx, cz, sx, sz } = footprint(a, b, grid);
      return {
        shape: "box",
        position: [cx, elevation, cz],
        rotationY: 0,
        size: [sx, wallHeight, sz],
      };
    }

    case "column": {
      const spread = Math.hypot(b.x - a.x, b.z - a.z);
      // Dragging out from the click sets the pillar's thickness; a plain click
      // uses a sensible default rather than a zero-width column.
      const thickness = spread < CLICK_EPSILON ? 0.4 : Math.max(0.1, spread * 2);
      return {
        shape: "column",
        position: [a.x, elevation, a.z],
        rotationY: 0,
        size: [thickness, wallHeight, thickness],
        props: { sides: settings.columnSides ?? 4 },
      };
    }

    case "wall": {
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      let length = Math.hypot(dx, dz);
      if (length < CLICK_EPSILON) return null;
      // Local +X must point from a to b.
      let angle = Math.atan2(-dz, dx);
      if (grid <= 0 && angleSnap > 0) {
        // Only with the grid off: snapped endpoints already quantise the angle,
        // and re-snapping on top of them would pull the wall off its corner.
        angle = snapAngle(angle, angleSnap);
        length = Math.max(CLICK_EPSILON, length);
      }
      const cx = (a.x + b.x) / 2;
      const cz = (a.z + b.z) / 2;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      return {
        shape: "wall",
        // Re-derived from the (possibly snapped) angle so the wall's ends stay
        // on its own axis rather than drifting off the snapped direction.
        position: [
          grid <= 0 && angleSnap > 0 ? a.x + (cosA * length) / 2 : cx,
          elevation,
          grid <= 0 && angleSnap > 0 ? a.z - (sinA * length) / 2 : cz,
        ],
        rotationY: angle,
        size: [length, wallHeight, wallThickness],
      };
    }

    case "stair":
    case "ramp": {
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const run = Math.hypot(dx, dz);
      if (run < CLICK_EPSILON) return null;
      const rise = tool === "stair" ? storeyHeight : (settings.rampRise ?? 1);
      const width = tool === "stair" ? stairWidth : Math.max(stairWidth, 1.6);
      // Local +Z is the climb direction. Descending flips it and drops the base
      // by the rise, so the drag still reads "I walk from here to there" and
      // the far end lands one storey DOWN instead of up.
      const descend = !!settings.descend;
      const angle = descend ? Math.atan2(-dx, -dz) : Math.atan2(dx, dz);
      return {
        shape: tool,
        position: [(a.x + b.x) / 2, elevation - (descend ? rise : 0), (a.z + b.z) / 2],
        rotationY: angle,
        size: [width, rise, run],
        props: tool === "stair" ? { open: !!settings.openTreads, steps: 0 } : {},
      };
    }

    default:
      return null;
  }
}

/**
 * Where along a wall a world point falls, in the wall's own metres from its
 * centre — what the Opening tool needs from a click on a wall face.
 *
 * `rotationY` and `position` are the wall's world transform. The inverse
 * rotation is applied by hand (rather than via the object's matrix) so this
 * stays a pure function the tests can drive without a scene.
 */
export function offsetAlongWall(point, position, rotationY) {
  const dx = point.x - position[0];
  const dz = point.z - position[2];
  // Inverse of the +X mapping above: project onto (cos θ, −sin θ).
  return dx * Math.cos(rotationY) - dz * Math.sin(rotationY);
}
