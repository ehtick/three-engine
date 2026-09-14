/** The outline of an opening, shared by the hole cutter (`formGeometry.js#openingSolid`) and every
 * decorator that frames, glazes or fills that hole — one definition, so a frame can never sit off
 * its own aperture. Coordinates are local to the opening: x in [0, width] from the left jamb,
 * y in [0, height] from the sill/threshold. Every head is convex. */
export const OPENING_HEADS = Object.freeze(["flat", "round", "pointed", "segment"]);

export function headRise(width, height, head) {
  if (head === "round") return Math.min(width / 2, height * .55);
  if (head === "pointed") return Math.min(width * .74, height * .6);
  if (head === "segment") return Math.min(width * .2, height * .3);
  return 0;
}

/** Top of the opening at local x (clamped to [0, width]). */
export function headY(width, height, head, x) {
  const rise = headRise(width, height, head), spring = height - rise;
  const cx = Math.max(0, Math.min(width, x));
  if (!rise) return height;
  if (head === "round") {
    const r = width / 2, sy = rise / r; // an ellipse when the height clamps the rise
    const dx = cx - r;
    return spring + Math.sqrt(Math.max(0, r * r - dx * dx)) * sy;
  }
  if (head === "segment") {
    const R = (width * width / 4 + rise * rise) / (2 * rise), cy = height - R;
    return cy + Math.sqrt(Math.max(0, R * R - (cx - width / 2) ** 2));
  }
  // pointed: two arcs of radius R centred on the far side of the opening's axis
  const R = Math.max(width * .8, (rise * rise + (width / 2) ** 2) / width + 1e-6);
  const centre = cx <= width / 2 ? R : width - R;
  const at = Math.sqrt(Math.max(0, R * R - (cx - centre) ** 2)), apex = Math.sqrt(Math.max(0, R * R - (width / 2 - centre) ** 2));
  return spring + (at / Math.max(apex, 1e-6)) * rise;
}

/** Closed CCW outline [[x, y], ...] starting at the bottom-left corner. */
export function openingOutline(width, height, head = "flat", segments = 10) {
  const rise = headRise(width, height, head);
  if (!rise) return [[0, 0], [width, 0], [width, height], [0, height]];
  const points = [[0, 0], [width, 0]];
  for (let i = 0; i <= segments; i++) {
    const x = width * (1 - i / segments);
    points.push([x, headY(width, height, head, x)]);
  }
  return points;
}
