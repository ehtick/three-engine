// Model documents the architecture preview harness renders. Pure JSON — the same
// shapes the Build/Grow/Wall/Path gestures and the World cottage adapter author.
// Roofs are `auto` (the style decides) unless a scenario is about a specific roof.
import { cottageArchitectureModel } from '../../src/modules/world/cottageArchitecture.js';

const box = (id, position, size, extra = {}) => ({ id, shape: 'box', position, size, rotationY: 0, color: '#ddc7a5', roof: 'auto', roofHeight: null, windows: true, ...extra });
const round = (id, position, size, extra = {}) => ({ id, shape: 'round', position, size, rotationY: 0, color: '#ddc7a5', roof: 'auto', roofHeight: null, windows: true, ...extra });

function wallArc(count = 6, radius = 9, height = 3.2, thickness = .5) {
  const forms = [];
  let previous = null;
  for (let i = 0; i <= count; i++) {
    const a = -Math.PI * .1 + i / count * Math.PI * .7;
    const point = [Math.cos(a) * radius, Math.sin(a) * radius];
    if (previous) {
      const dx = point[0] - previous[0], dz = point[1] - previous[1];
      forms.push({ id: `wall-${i}`, kind: 'wall', shape: 'box', position: [(point[0] + previous[0]) / 2, 0, (point[1] + previous[1]) / 2], size: [Math.hypot(dx, dz) + thickness, height, thickness], rotationY: -Math.atan2(dz, dx), color: '#ddc7a5', roof: 'none', roofHeight: 0, windows: false });
    }
    previous = point;
  }
  return forms;
}

export const ARCHITECTURE_PREVIEW_SCENARIOS = {
  cottage: () => ({ forms: [box('main', [0, 0, 0], [8, 4.2, 6], { roofAxis: 'x' })], openings: [], paths: [] }),
  lplan: () => ({ forms: [box('main', [0, 0, 0], [9, 5.8, 6], { roofAxis: 'x' }), box('wing', [3.5, 0, 5], [5, 3.6, 6], { roofAxis: 'z' })], openings: [], paths: [] }),
  tower: () => ({ forms: [box('hall', [0, 0, 0], [8, 4.5, 6]), round('tower', [4.2, 0, 3.2], [4, 10, 4])], openings: [], paths: [] }),
  stack: () => ({ forms: [box('base', [0, 0, 0], [7, 3.2, 7], { roof: 'flat' }), box('upper', [.8, 3.2, .4], [4.5, 3, 4.5])], openings: [], paths: [] }),
  cells: () => ({ forms: [[0, 0, 3], [3, 0, 3], [6, 0, 6], [3, 3, 3], [0, 3, 9], [6, 3, 3]].map(([x, z, h], i) => box(`cell-${i}`, [x, 0, z], [3, h, 3])), openings: [], paths: [] }),
  bridge: () => ({ forms: [box('left', [-7, 0, 0], [4, 7, 4]), box('span', [0, 4, 0], [10, 2.6, 3], { roofAxis: 'x' }), box('right', [7, 0, 0], [4, 7, 4])],
    openings: [], paths: [{ id: 'road', points: [[0, -8], [0, 8]], width: 2.5, elevation: 0 }] }),
  wall: () => ({ forms: [...wallArc(), round('keep', [9, 0, -1.4], [4.5, 7, 4.5])],
    openings: [], paths: [{ id: 'gate', points: [[2, 2], [6.5, 6.5]], width: 2.2, elevation: 0 }] }),
  village: () => {
    const a = cottageArchitectureModel({ seed: 1 }), b = cottageArchitectureModel({ seed: 3 });
    const shift = (model, dx, dz, prefix) => ({
      forms: model.forms.map(form => ({ ...form, id: `${prefix}${form.id}`, color: '#ddc7a5', roofColor: null, position: [form.position[0] + dx, form.position[1], form.position[2] + dz] })),
      openings: model.openings.map(o => ({ ...o, id: `${prefix}${o.id}`, formId: `${prefix}${o.formId}`, position: [o.position[0] + dx, o.position[1], o.position[2] + dz] })),
    });
    const left = shift(a, -6, 0, 'a-'), right = shift(b, 7, 1, 'b-');
    return { forms: [...left.forms, ...right.forms], openings: [...left.openings, ...right.openings], paths: [] };
  },
};
