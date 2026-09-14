import { describeCottageStudy } from './worldCottage.js';

const hexColor = value => typeof value === 'string' && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value) ? value : null;
const round4 = value => Math.round(value * 1e4) / 1e4 || 0;

/** A cheap integer hash (seed -> style pick), independent of the building's
 * own mulberry32 `random()` stream so choosing the style never perturbs the
 * door/window rolls that stream already produces. */
function hashSeed(x) {
  x = (x ^ (x >>> 16)) >>> 0; x = Math.imul(x, 0x45d9f3b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0; x = Math.imul(x, 0x45d9f3b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/** World `style` ('natural' | 'stylized') to an architecture style catalogue
 * id (World production plan §3, P1-H): natural alternates between the two
 * realistic cottage styles by seed parity; stylized always reads as Tiny
 * Glade, the cozy stylized cottage look. */
function cottageStyleId(style, styleSeed) {
  if (style === 'stylized') return 'tiny-glade';
  return hashSeed(styleSeed) % 2 === 0 ? 'timber-medieval' : 'stone-cottage';
}

/**
 * The cottage construction families as an editable Architecture model document:
 * pure JSON, no renderer objects. The World generator emits this instead of the
 * baked study group so a generated house is a real Architecture component that
 * the editor can select, sculpt and re-open. Same local axes as the study:
 * Y up, +Z entrance, volumes in building-local space. Deterministic per seed —
 * the same arguments always produce a byte-identical document, and the document
 * already has the exact shape `normalizeArchitectureModel` returns.
 */
export function cottageArchitectureModel({ style = 'natural', seed = 1, roofColor, buildingScale = 1 } = {}) {
  const specification = describeCottageStudy({ style, seed });
  const styleSeed = (Number(seed) >>> 0) || 1;
  const styleId = cottageStyleId(style, styleSeed);
  let state = styleSeed;
  const random = () => {
    state += 0x6D2B79F5;
    let n = state;
    n = Math.imul(n ^ (n >>> 15), n | 1);
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
  const scale = Number.isFinite(Number(buildingScale)) && Number(buildingScale) > 0 ? Number(buildingScale) : 1;
  const m = value => round4(value * scale);
  const roof = hexColor(roofColor) ?? specification.palette.roof, plaster = specification.palette.plaster;
  const forms = [], openings = [];
  const main = specification.volumes[0];
  const doorWidth = 1.05 + random() * .25;
  // A porch canopy sits at 2.2 m, so its door cannot use the full height range.
  const doorHeight = Math.min(2.1 + random() * .3, specification.porch ? 2.15 : 2.4);
  openings.push({ id: 'door-main', formId: main.id,
    position: [m(specification.entry.x), m(doorHeight / 2), m(specification.entry.z)],
    normal: [0, 0, 1], width: m(doorWidth), height: m(doorHeight), kind: 'door' });
  for (const volume of specification.volumes) {
    forms.push({
      id: volume.id, shape: 'box',
      position: [m(volume.x), 0, m(volume.z)],
      size: [m(volume.width), m(volume.wallHeight), m(volume.depth)],
      rotationY: 0, color: plaster,
      roof: 'gable', roofAxis: volume.roofAxis, roofColor: roof,
      roofHeight: m(volume.ridgeHeight - volume.wallHeight), windows: false,
    });
    const faces = [
      { normal: [0, 0, 1], length: volume.width },
      { normal: [0, 0, -1], length: volume.width },
      { normal: [1, 0, 0], length: volume.depth },
      { normal: [-1, 0, 0], length: volume.depth },
    ];
    for (const face of faces) {
      const [nx, , nz] = face.normal;
      const cx = volume.x + nx * volume.width / 2, cz = volume.z + nz * volume.depth / 2;
      // A facade buried in a neighbouring volume has no exterior wall to light.
      const buried = specification.volumes.some(other => other !== volume &&
        Math.abs(cx + nx * .06 - other.x) <= other.width / 2 && Math.abs(cz + nz * .06 - other.z) <= other.depth / 2);
      if (buried) continue;
      const count = Math.min(3, Math.max(1, Math.floor((face.length - 1.4) / 2.6))), rows = volume.storeys >= 2 ? 2 : 1;
      for (let column = 0; column < count; column++) for (let row = 0; row < rows; row++) {
        const width = .95 + random() * .2, height = 1.1 + random() * .2;
        let u = -face.length / 2 + face.length * (column + .5) / count + (random() - .5) * .5;
        u = Math.max(-(face.length / 2 - width / 2 - .45), Math.min(face.length / 2 - width / 2 - .45, u));
        // Keep the ground-floor windows on the entry facade clear of the door.
        if (volume === main && nz === 1 && row === 0 && Math.abs(u - (specification.entry.x - main.x)) < width / 2 + doorWidth / 2 + .3) continue;
        const y = .9 + height / 2 + row * 2.95;
        if (y + height / 2 > volume.wallHeight - .3) continue;
        openings.push({ id: `window-${volume.id}-${openings.length}`, formId: volume.id,
          position: [m(volume.x + nx * volume.width / 2 + (nz ? u : 0)), m(y), m(volume.z + nz * volume.depth / 2 + (nx ? u : 0))],
          normal: [nx, 0, nz], width: m(width), height: m(height), kind: 'window' });
      }
    }
  }
  // The porch is a flat canopy slab in front of the entry facade; the compiler
  // grows its support posts down to the ground on its own.
  if (specification.porch) forms.push({
    id: 'porch', shape: 'box',
    position: [m(main.x), m(2.2), m(main.z + main.depth / 2 + specification.porch.depth / 2)],
    size: [m(specification.porch.width), Math.max(.3, m(.3)), m(specification.porch.depth)],
    rotationY: 0, color: specification.palette.timber,
    roof: 'flat', roofAxis: null, roofColor: roof,
    roofHeight: m(1.2), windows: false,
  });
  return { version: 1, cellSize: 3, forms, paths: [], openings, style: { id: styleId, seed: styleSeed } };
}
