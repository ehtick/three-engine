import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** A renderer-independent, deterministic description used by the study UI. */
export function describeCottageStudy({ seed = 1, style = 'natural' } = {}) {
  seed = Number(seed) >>> 0;
  const stylized = style === 'stylized';
  const familyIndex = seed % 4;
  const families = [
    { family: 'classic-gable', label: 'Gabled cottage', width: 8, depth: 6, wallHeight: 4.12, ridgeHeight: 6.18, roofAxis: 'z', entryX: 0, storeys: 1 },
    { family: 'porch-farmhouse', label: 'Porch farmhouse', width: 10.8, depth: 5.8, wallHeight: 3.82, ridgeHeight: 5.98, roofAxis: 'x', entryX: -2.6, storeys: 1 },
    { family: 'two-storey', label: 'Two-storey cottage', width: 5.7, depth: 6.6, wallHeight: 6.38, ridgeHeight: 8.55, roofAxis: 'z', entryX: -1.25, storeys: 2 },
    { family: 'side-wing', label: 'Cottage with side wing', width: 6.8, depth: 6.4, wallHeight: 4.40, ridgeHeight: 6.85, roofAxis: 'z', entryX: -1.35, storeys: 1 },
  ];
  const base = families[familyIndex];
  // Seed 8 retains the original proportions; later cycles vary proportions within
  // their construction family without stretching completed windows or slates.
  const cycle = (Math.floor(seed / 4) + 1) % 3;
  const width = base.width + cycle * 0.16;
  const depth = base.depth + cycle * 0.12;
  const wallHeight = base.wallHeight + (stylized ? -0.18 : 0);
  const ridgeHeight = base.ridgeHeight + (stylized ? 0.22 : 0) + cycle * 0.08;
  const natural = [
    { plaster: '#d7d1bb', roof: '#626c71', shutter: '#697c72', timber: '#625344' },
    { plaster: '#e1d9bd', roof: '#92684f', shutter: '#677f77', timber: '#645744' },
    { plaster: '#cfc1a1', roof: '#555f69', shutter: '#6f797d', timber: '#584a3d' },
    { plaster: '#c6cec0', roof: '#787a60', shutter: '#69775c', timber: '#685748' },
  ];
  const stylizedPalettes = [
    { plaster: '#ead5ad', roof: '#b56446', shutter: '#4d8476', timber: '#65472e' },
    { plaster: '#ebdcbd', roof: '#7c98a0', shutter: '#789863', timber: '#725036' },
    { plaster: '#d4b88e', roof: '#687d9c', shutter: '#698683', timber: '#644538' },
    { plaster: '#d6d7b1', roof: '#a47161', shutter: '#6b8b62', timber: '#756044' },
  ];
  const shade = 0.96 + ((Math.imul(seed ^ 0x51F2, 1597334677) >>> 0) % 101) / 1250;
  const vary = (hex) => `#${[1, 3, 5].map(i => Math.min(255, Math.round(parseInt(hex.slice(i, i + 2), 16) * shade)).toString(16).padStart(2, '0')).join('')}`;
  const palette = Object.fromEntries(Object.entries((stylized ? stylizedPalettes : natural)[familyIndex]).map(([role, hex]) => [role, vary(hex)]));
  const mainX = familyIndex === 3 ? -1.80 : 0;
  const main = { id: 'main', x: mainX, z: 0, width, depth, wallHeight, ridgeHeight, roofAxis: base.roofAxis, storeys: base.storeys, entryX: base.entryX };
  const mainEave = wallHeight - 0.48 * (ridgeHeight - wallHeight) / (width / 2);
  const wing = familyIndex === 3 ? {
    id: 'wing', x: mainX + width / 2 + 1.80, z: depth / 2 - 2.15,
    width: 3.6, depth: 4.3, wallHeight: stylized ? 2.95 : 3.08,
    // Leave room for slate/ridge-cap thickness below the main roof's overhang.
    ridgeHeight: Math.min(stylized ? 4.12 : 4.04, mainEave - 0.27), roofAxis: 'x', storeys: 1, entryX: null,
  } : null;
  return {
    family: base.family, label: base.label, seed, style, roofColor: palette.roof, palette,
    footprint: { width: width + (wing ? wing.width : 0), depth },
    dimensions: { width: width + (wing ? wing.width : 0), depth, wallHeight, ridgeHeight, storeys: base.storeys },
    roofAxis: base.roofAxis, entry: { x: mainX + base.entryX, z: depth / 2 },
    porch: familyIndex === 1 ? { width: width - 0.65, depth: 1.90 } : null,
    wing, volumes: wing ? [main, wing] : [main],
  };
}

/**
 * A self-contained construction specimen for World phase 0. This is deliberately
 * a study asset, not an Architecture provider or a generated-feature document.
 * Local axes: Y up, +Z entrance; seed selects an actual construction family.
 * Every visible detail is procedural. Material-role meshes merge the small parts
 * so stone courses, shutters and individual slates do not become separate draws.
 */
export function createCottageStudy(THREE, { style = 'natural', roofColor, seed = 1 } = {}) {
  const specification = describeCottageStudy({ style, seed });
  seed = specification.seed;
  const stylized = style === 'stylized';
  let state = (Number(seed) >>> 0) || 1;
  const random = () => {
    state += 0x6D2B79F5;
    let n = state;
    n = Math.imul(n ^ (n >>> 15), n | 1);
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
  const group = new THREE.Group();
  group.name = `World cottage study · ${specification.label} · ${style}`;
  const parts = new Map();
  const textures = [];
  const materials = new Map();
  let frame = new THREE.Matrix4();

  const palette = {
    plaster: specification.palette.plaster,
    stone: stylized ? '#aa9a7b' : '#999488',
    mortar: stylized ? '#736b55' : '#757268',
    timber: specification.palette.timber,
    door: stylized ? '#936748' : '#82684b',
    shutter: specification.palette.shutter,
    roof: roofColor ?? specification.roofColor,
    glass: stylized ? '#4b6260' : '#3a494a',
    iron: '#373936',
    chimney: stylized ? '#b28161' : '#987663',
    plant: stylized ? '#648749' : '#63794a',
    flower: stylized ? '#e6be76' : '#c7b788',
  };
  const colors = Object.fromEntries(Object.entries(palette).map(([key, color]) => [key, new THREE.Color(color)]));

  // No canvas/browser dependence: deterministic small single-channel-style RGBA
  // height maps provide grain at eye level, while geometry carries silhouettes.
  const makeBump = (kind) => {
    const size = 128;
    const data = new Uint8Array(size * size * 4);
    const lattice = (x, y) => {
      let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + (Number(seed) | 0);
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
    };
    const noise = (x, y) => {
      const ix = Math.floor(x), iy = Math.floor(y);
      let fx = x - ix, fy = y - iy;
      fx = fx * fx * (3 - 2 * fx);
      fy = fy * fy * (3 - 2 * fy);
      const a = lattice(ix, iy), b = lattice(ix + 1, iy);
      const c = lattice(ix, iy + 1), d = lattice(ix + 1, iy + 1);
      return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
    };
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      let n;
      if (kind === 'wood') {
        const drift = noise(u * 5, v * 2);
        n = 0.46 + 0.20 * Math.sin((u * 28 + drift * 1.5) * Math.PI * 2)
          + 0.18 * noise(u * 72, v * 3) + 0.08 * lattice(x, y);
      } else if (kind === 'slate') {
        n = noise(u * 6, v * 6) * 0.55 + noise(u * 38, v * 9) * 0.30 + lattice(x, y) * 0.15;
      } else {
        n = noise(u * 14, v * 14) * 0.55 + noise(u * 45, v * 45) * 0.28 + lattice(x, y) * 0.17;
      }
      const value = Math.max(0, Math.min(255, Math.round(n * 255)));
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = value;
      data[i + 3] = 255;
    }
    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    texture.name = `Cottage ${kind} microrelief`;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.repeat.set(kind === 'wood' ? 1 : 3, kind === 'wood' ? 1 : 3);
    texture.needsUpdate = true;
    textures.push(texture);
    return texture;
  };
  const plasterBump = makeBump('plaster');
  const slateBump = makeBump('slate');
  const woodBump = makeBump('wood');
  for (const role of Object.keys(palette)) {
    const material = new THREE.MeshStandardMaterial({
      name: `Cottage · ${role}`,
      color: 0xffffff,
      vertexColors: true,
      roughness: role === 'glass' ? 0.29 : role === 'iron' ? 0.72 : 0.96,
      metalness: role === 'iron' ? 0.55 : role === 'glass' ? 0.15 : 0,
    });
    if (role === 'plaster' || role === 'stone' || role === 'chimney') {
      material.bumpMap = plasterBump;
      material.bumpScale = stylized ? 0.013 : role === 'plaster' ? 0.025 : 0.045;
    } else if (role === 'roof') {
      material.bumpMap = slateBump;
      material.bumpScale = stylized ? 0.016 : 0.035;
    } else if (role === 'timber' || role === 'door' || role === 'shutter') {
      material.bumpMap = woodBump;
      material.bumpScale = stylized ? 0.011 : 0.023;
    }
    materials.set(role, material);
    parts.set(role, []);
  }

  const put = (role, geometry, shade = 1, tint = null) => {
    if (geometry.index) {
      const old = geometry;
      geometry = geometry.toNonIndexed();
      old.dispose();
    }
    geometry.applyMatrix4(frame);
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
    const count = geometry.attributes.position.count;
    if (!geometry.attributes.uv) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
    const color = (tint ?? colors[role]).clone().multiplyScalar(shade);
    const vertexColors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) color.toArray(vertexColors, i * 3);
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(vertexColors, 3));
    geometry.clearGroups();
    parts.get(role).push(geometry);
  };
  const box = (role, x, y, z, w, h, d, shade = 1, angleZ = 0, angleY = 0) => {
    const geometry = new THREE.BoxGeometry(w, h, d);
    if (angleZ) geometry.rotateZ(angleZ);
    if (angleY) geometry.rotateY(angleY);
    geometry.translate(x, y, z);
    put(role, geometry, shade);
  };
  const beam = (a, b, width, depth, role = 'timber', shade = 1) => {
    const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b);
    const direction = to.clone().sub(from);
    const geometry = new THREE.BoxGeometry(width, direction.length(), depth);
    geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()));
    geometry.translate(...from.add(to).multiplyScalar(0.5).toArray());
    put(role, geometry, shade);
  };
  const atFacade = (x, z, angle, callback) => {
    const previous = frame;
    const local = new THREE.Matrix4().makeRotationY(angle);
    local.setPosition(x, 0, z);
    frame = previous.clone().multiply(local);
    try { callback(); } finally { frame = previous; }
  };

  // Wall strips stop at the opening bounds; the inset glass/door is physically
  // behind the facade, with exposed plaster reveals and timber liners.
  const apertures = [];
  let activeVolumeId = 'main';
  const recordAperture = (opening, kind = 'window') => {
    apertures.push({
      volume: activeVolumeId, kind, width: opening.w, height: opening.h,
      center: new THREE.Vector3(opening.x, opening.bottom + opening.h / 2, 0).applyMatrix4(frame).toArray(),
      normal: new THREE.Vector3(0, 0, 1).transformDirection(frame).toArray(),
    });
  };
  const wall = (width, openings, wallTop) => {
    for (const opening of openings) recordAperture(opening, opening.kind);

    const xs = [...new Set([-width / 2, width / 2, ...openings.flatMap(o => [o.x - o.w / 2, o.x + o.w / 2])])].sort((a, b) => a - b);
    const ys = [...new Set([0.56, wallTop, ...openings.flatMap(o => [o.bottom, o.bottom + o.h])])].sort((a, b) => a - b);
    for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < ys.length - 1; j++) {
      const x = (xs[i] + xs[i + 1]) * 0.5, y = (ys[j] + ys[j + 1]) * 0.5;
      if (openings.some(o => Math.abs(x - o.x) < o.w / 2 && y > o.bottom && y < o.bottom + o.h)) continue;
      box('plaster', x, y, -0.15, xs[i + 1] - xs[i], ys[j + 1] - ys[j], 0.3);
    }
  };
  const window = (x, bottom = 1.37, w = 1.23, h = 1.55, shutters = true) => {
    const y = bottom + h * 0.5;
    box('glass', x, y, -0.135, w - 0.10, h - 0.10, 0.04, 0.78 + random() * 0.21);
    for (const side of [-1, 1]) box('timber', x + side * (w / 2 - 0.04), y, -0.04, 0.09, h, 0.22, 0.93);
    for (const side of [-1, 1]) box('timber', x, y + side * (h / 2 - 0.04), -0.04, w, 0.09, 0.22, 0.93);
    box('timber', x, y, -0.075, 0.055, h - 0.12, 0.09, 1.10);
    box('timber', x, y - 0.08, -0.075, w - 0.12, 0.054, 0.09, 1.10);
    box('stone', x, bottom - 0.065, 0.12, w + 0.31, 0.13, 0.42, 1.15);
    box('timber', x, bottom + h + 0.075, 0.055, w + 0.31, 0.15, 0.21, 0.92);
    if (!shutters) return;
    for (const side of [-1, 1]) {
      const sx = x + side * (w / 2 + 0.29);
      const shade = 0.93 + random() * 0.14;
      box('shutter', sx, y, 0.055, 0.48, h + 0.035, 0.085, shade);
      for (const edge of [-1, 1]) box('shutter', sx + edge * 0.21, y, 0.108, 0.058, h + 0.035, 0.045, shade * 0.86);
      for (let row = 0; row < 10; row++) {
        box('shutter', sx, bottom + 0.12 + row * (h - 0.24) / 9, 0.108, 0.38, 0.087, 0.045, shade * (0.94 + random() * 0.10));
      }
      for (const sy of [bottom + 0.28, bottom + h - 0.28]) box('iron', sx - side * 0.10, sy, 0.145, 0.26, 0.045, 0.025);
      box('iron', sx + side * 0.08, bottom - 0.02, 0.16, 0.035, 0.16, 0.035);
    }
  };


  const foundation = (width) => {
    for (let row = 0; row < 3; row++) {
      let x = -width / 2;
      while (x < width / 2 - 0.02) {
        const w = Math.min(0.52 + random() * 0.53, width / 2 - x);
        box('stone', x + w / 2, 0.11 + row * 0.205, 0.025 + random() * 0.025,
          w - 0.019, 0.181 + random() * 0.018, 0.18, 0.84 + random() * 0.30);
        x += w;
      }
    }
  };
  const door = (x, porch = false) => atFacade(x, 0, 0, () => {
    box('door', 0, 1.77, -0.11, 1.20, 2.35, 0.13, 0.70);
    for (let board = 0; board < 7; board++) {
      box('door', -0.52 + board * 0.173, 1.77, -0.025, 0.162, 2.28, 0.06, 0.92 + random() * 0.16);
    }
    for (const side of [-1, 1]) box('timber', side * 0.73, 1.79, 0.035, 0.18, 2.50, 0.24, 0.97);
    box('timber', 0, 3.04, 0.035, 1.64, 0.20, 0.27, 1.04);
    for (const y of [1.00, 2.45]) box('iron', -0.24, y, 0.024, 0.65, 0.065, 0.035);
    box('iron', 0.39, 1.78, 0.06, 0.05, 0.23, 0.055);
    box('iron', 0.36, 1.82, 0.09, 0.14, 0.04, 0.05);
    box('stone', 0, 0.57, 0.13, 1.61, 0.14, 0.66, 1.05);
    for (let step = 0; step < 3; step++) {
      const height = 0.16 + step * 0.155;
      box('stone', 0, height / 2, (porch ? 2.55 : 1.08) - step * 0.30,
        1.88 - step * 0.10, height, 0.69, 0.98 + step * 0.05);
    }
  });
  const plantingBox = (x, bottom, width) => {
    const boxWidth = width - 0.04;
    box('timber', x, bottom - 0.19, 0.31, boxWidth, 0.29, 0.36, 0.92);
    box('mortar', x, bottom - 0.04, 0.31, boxWidth - 0.12, 0.025, 0.25, 0.44);
    for (let i = 0; i < 8; i++) {
      box('timber', x - boxWidth * 0.425 + i * boxWidth * 0.12, bottom - 0.19, 0.504, 0.012, 0.24, 0.021, 0.60);
    }
    for (let i = 0; i < 22; i++) {
      const px = x + (random() - 0.5) * (boxWidth - 0.15);
      const pz = 0.33 + (random() - 0.5) * 0.22;
      const py = bottom + 0.03 + random() * 0.19;
      const leaf = new THREE.IcosahedronGeometry(0.085, 0);
      leaf.scale(1.3, 0.58, 0.83);
      leaf.rotateZ(random() * 1.5);
      leaf.rotateY(random() * Math.PI);
      leaf.translate(px, py, pz);
      put('plant', leaf, 0.82 + random() * 0.30);
      if (i % 3 === 0) {
        const flower = new THREE.IcosahedronGeometry(0.037, 0);
        flower.scale(1.2, 0.55, 1.2);
        flower.translate(px, py + 0.07, pz);
        put('flower', flower, 0.90 + random() * 0.20);
      }
    }
  };
  const frontOpenings = (v) => {
    const win = (x, bottom = 1.39, w = 1.24, h = 1.53) => ({ x, bottom, w, h, kind: 'window' });
    if (v.id === 'wing') return [win(0.15, 1.15, 1.37, 1.31)];
    if (specification.family === 'classic-gable') return [win(-v.width * 0.29375), win(v.width * 0.29375)];
    if (specification.family === 'porch-farmhouse') return [win(-v.width * 0.41, 1.42, 0.95, 1.45), win(0.27), win(v.width * 0.32)];
    if (specification.family === 'two-storey') return [win(1.23, 1.43, 1.13, 1.49), win(-1.26, 4.32, 1.08, 1.38), win(1.26, 4.32, 1.08, 1.38)];
    return [win(1.40, 1.42, 1.28, 1.62)];
  };

  // Families change construction before geometry is made: facade apertures, floor
  // count, joining walls and foundations are evaluated independently for each volume.
  for (const v of specification.volumes) atFacade(v.x, v.z, 0, () => {
    activeVolumeId = v.id;
    const hw = v.width / 2, hd = v.depth / 2;
    box('mortar', 0, 0.30, 0, v.width + 0.08, 0.60, v.depth + 0.08);
    atFacade(0, hd, 0, () => foundation(v.width + 0.1));
    atFacade(0, -hd, Math.PI, () => foundation(v.width + 0.1));
    atFacade(hw, 0, Math.PI / 2, () => foundation(v.depth + 0.1));
    if (v.id !== 'wing') atFacade(-hw, 0, -Math.PI / 2, () => foundation(v.depth + 0.1));
    const windows = frontOpenings(v);
    atFacade(0, hd, 0, () => {
      const openings = [...windows];
      if (v.entryX !== null) openings.push({ x: v.entryX, bottom: 0.56, w: 1.29, h: 2.39, kind: 'door' });
      wall(v.width, openings, v.wallHeight);
      for (const o of windows) {
        window(o.x, o.bottom, o.w, o.h, v.id !== 'wing');
        if (o.bottom < 2 && specification.family !== 'porch-farmhouse') plantingBox(o.x, o.bottom, o.w);
      }
      if (v.entryX !== null) door(v.entryX, !!specification.porch);
    });
    atFacade(0, -hd, Math.PI, () => {
      const positions = v.id === 'wing' ? [0] : [-v.width * 0.275, v.width * 0.275];
      const openings = positions.map(x => ({ x, bottom: v.id === 'wing' ? 1.18 : 1.42, w: v.id === 'wing' ? 1.05 : 1.18, h: v.id === 'wing' ? 1.26 : 1.50 }));
      if (v.storeys === 2) for (const x of positions) openings.push({ x, bottom: 4.34, w: 1.08, h: 1.35 });
      wall(v.width, openings, v.wallHeight);
      for (const o of openings) window(o.x, o.bottom, o.w, o.h, v.id !== 'wing');
    });
    for (const side of [-1, 1]) {
      if (v.id === 'wing' && side === -1) continue; // The main volume is the shared wall.
      atFacade(side * hw, 0, side * Math.PI / 2, () => {
        const joining = specification.wing && v.id === 'main' && side === 1;
        const positions = v.id === 'wing' ? [0] : joining ? [2.14] : [-v.depth * 0.24, v.depth * 0.24];
        const openings = positions.map(x => ({ x, bottom: v.id === 'wing' ? 1.20 : 1.45, w: joining ? 0.90 : 1.14, h: v.id === 'wing' ? 1.23 : 1.47 }));
        if (v.storeys === 2) for (const x of positions) openings.push({ x, bottom: 4.35, w: 1.10, h: 1.33 });
        wall(v.depth - 0.6, openings, v.wallHeight);
        for (const o of openings) window(o.x, o.bottom, o.w, o.h, false);
        box('timber', 0, v.wallHeight - 0.07, 0.025, v.depth + 0.19, 0.19, 0.18, 0.95);
        if (v.roofAxis === 'z') for (let x = -hd + 0.15; x < hd; x += 0.71) {
          box('timber', x, v.wallHeight - 0.10, 0.24, 0.13, 0.16, 0.56, 0.91 + random() * 0.13);
        }
      });
    }
    if (v.storeys === 2) {
      for (const side of [-1, 1]) atFacade(0, side * hd, side === 1 ? 0 : Math.PI, () => {
        box('timber', 0, 3.57, 0.04, v.width + 0.12, 0.21, 0.19, 0.91);
        for (const x of [-hw + 0.12, 0, hw - 0.12]) box('timber', x, 4.91, 0.035, 0.17, 2.62, 0.18, 1.04);
      });
      for (const side of [-1, 1]) atFacade(side * hw, 0, side * Math.PI / 2, () => {
        box('timber', 0, 3.57, 0.04, v.depth, 0.21, 0.19, 0.94);
      });
    }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      if (v.id === 'wing' && sx === -1) continue;
      for (let row = 0; 0.79 + row * 0.35 < v.wallHeight - 0.09; row++) {
        const y = 0.79 + row * 0.35, length = row % 2 ? 0.39 : 0.66;
        box('stone', sx * (hw - length / 2 + 0.025), y, sz * (hd + 0.023), length, 0.319, 0.10, 0.96 + random() * 0.12);
        box('stone', sx * (hw + 0.023), y, sz * (hd - (1.02 - length) / 2), 0.10, 0.319, 1.02 - length, 0.96 + random() * 0.12);
      }
    }
  });

  // Polygon slates have clipped lower corners, a visible edge and overlapping
  // courses. Each side is still part of the single merged roof-role draw.
  const slate = (length, width, thickness) => {
    const c = Math.min(width, length) * 0.10;
    const points = [
      [-length / 2, -width / 2], [length / 2 - c, -width / 2],
      [length / 2, -width / 2 + c], [length / 2, width / 2 - c],
      [length / 2 - c, width / 2], [-length / 2, width / 2],
    ];
    const positions = [], uvs = [];
    const vertex = (i, y) => {
      const [x, z] = points[i];
      positions.push(x, y, z);
      uvs.push(x / length + 0.5, z / width + 0.5);
    };
    for (let i = 1; i < points.length - 1; i++) {
      vertex(0, thickness); vertex(i + 1, thickness); vertex(i, thickness);
      vertex(0, 0); vertex(i, 0); vertex(i + 1, 0);
    }
    for (let i = 0; i < points.length; i++) {
      const next = (i + 1) % points.length;
      vertex(i, 0); vertex(next, thickness); vertex(next, 0);
      vertex(i, 0); vertex(i, thickness); vertex(next, thickness);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.computeVertexNormals();
    return geometry;
  };

  // The long farmhouse turns its RIDGE, not the finished house. Openings still
  // face +Z, while its gables face +/-X. The wing gets a separate lower roof.
  for (const v of specification.volumes) atFacade(v.x, v.z, v.roofAxis === 'x' ? Math.PI / 2 : 0, () => {
    activeVolumeId = v.id;
    const halfSpan = (v.roofAxis === 'x' ? v.depth : v.width) / 2;
    const length = v.roofAxis === 'x' ? v.width : v.depth;
    const wallTop = v.wallHeight, ridge = v.ridgeHeight;
    const pitch = (ridge - wallTop) / halfSpan, roofAngle = Math.atan(pitch);
    const eaveX = halfSpan + 0.48, eaveY = ridge - eaveX * pitch;
    const roofLength = Math.hypot(eaveX, ridge - eaveY), roofDepth = length + 0.98;
    for (const side of [-1, 1]) {
      if (v.id === 'wing' && side === -1) continue;
      atFacade(0, side * length / 2, side === 1 ? 0 : Math.PI, () => {
        const atticY = wallTop + (ridge - wallTop) * 0.39;
        const attic = side === 1 && v.id !== 'wing';
        const shape = new THREE.Shape();
        shape.moveTo(-halfSpan, wallTop);
        shape.lineTo(halfSpan, wallTop);
        shape.lineTo(0, ridge);
        shape.closePath();
        if (attic) {
          const hole = new THREE.Path();
          hole.absellipse(0, atticY, 0.35, 0.42, 0, Math.PI * 2, true);
          shape.holes.push(hole);
          recordAperture({ x: 0, bottom: atticY - 0.42, w: 0.70, h: 0.84 }, 'attic');
        }
        const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.28, bevelEnabled: false, curveSegments: 18, steps: 1 });
        geometry.translate(0, 0, -0.28);
        put('plaster', geometry);
        box('timber', 0, wallTop - 0.035, 0.044, halfSpan * 2 + 0.12, 0.17, 0.21, 0.94);
        for (const sx of [-1, 1]) {
          beam([sx * (halfSpan - 0.04), wallTop + 0.015, 0.075], [0, ridge - 0.04, 0.075], 0.155, 0.17, 'timber', 1.04);
          if (v.id !== 'wing') {
            const postX = halfSpan * 0.443;
            beam([sx * postX, wallTop + 0.06, 0.045], [sx * postX, ridge - postX * pitch - 0.07, 0.045], 0.13, 0.14, 'timber', 0.98);
            beam([sx * halfSpan * 0.825, wallTop + 0.07, 0.043], [sx * halfSpan * 0.46, wallTop + (ridge - wallTop) * 0.36, 0.043], 0.10, 0.13, 'timber', 1.04);
          }
        }
        if (attic) {
          const torus = new THREE.TorusGeometry(0.389, 0.057, 6, 32);
          torus.scale(1, 1.18, 1);
          torus.translate(0, atticY, -0.012);
          put('timber', torus, 1.12);
          const glass = new THREE.CircleGeometry(0.35, 32);
          glass.scale(1, 1.2, 1);
          glass.translate(0, atticY, -0.09);
          put('glass', glass, 0.89);
          box('timber', 0, atticY, -0.035, 0.044, 0.79, 0.08, 1.09);
          box('timber', 0, atticY, -0.035, 0.65, 0.044, 0.08, 1.09);
        } else box('timber', 0, (wallTop + ridge) / 2, 0.025, 0.15, ridge - wallTop - 0.10, 0.15);
      });
    }
  const columns = Math.max(8, Math.round(roofDepth / (stylized ? 0.54 : 0.44)));
  const rows = Math.max(6, Math.round(roofLength / (stylized ? 0.51 : 0.42)));
  for (const side of [-1, 1]) {
    box('timber', side * eaveX * 0.5, (ridge + eaveY) * 0.5 - 0.035, 0, roofLength, 0.14, roofDepth, 0.84, -side * roofAngle);
    const rowStep = roofLength / rows;
    const columnWidth = roofDepth / columns;
    for (let row = 0; row < rows; row++) {
      const along = (row + 0.5) * rowStep;
      // Upper rows sit above lower rows at their overlap, as real slates do.
      const lift = 0.057 + (rows - row) * 0.004;
      const stagger = row % 2 ? 0.5 : 0;
      for (let column = 0; column < columns + stagger; column++) {
        const start = Math.max(-roofDepth / 2, -roofDepth / 2 + (column - stagger) * columnWidth);
        const end = Math.min(roofDepth / 2, -roofDepth / 2 + (column + 1 - stagger) * columnWidth);
        if (end - start < 0.03) continue;
        const tileLength = rowStep + (row === rows - 1 ? 0.035 : 0.10);
        const geometry = slate(tileLength, end - start - 0.009, 0.032 + random() * 0.015);
        if (side === -1) geometry.rotateY(Math.PI);
        geometry.rotateZ(-side * roofAngle);
        geometry.translate(side * along * Math.cos(roofAngle), ridge - along * Math.sin(roofAngle) + lift, (start + end) * 0.5);
        const moss = !stylized && side === -1 && random() < 0.13;
        put('roof', geometry, 0.83 + random() * 0.28, moss ? colors.roof.clone().lerp(new THREE.Color('#6c7052'), 0.35) : null);
      }
    }
    box('timber', side * (eaveX + 0.015), eaveY - 0.085, 0, 0.14, 0.23, roofDepth + 0.045, 0.92);
  }
  for (const z of [-roofDepth / 2 - 0.025, roofDepth / 2 + 0.025]) {
    for (const side of [-1, 1]) {
      beam([0, ridge + 0.022, z], [side * (eaveX + 0.035), eaveY - 0.008, z], 0.19, 0.13, 'timber', 1.05);
    }
  }
  // Half-round clay/slate ridge caps close the two roof slopes.
  for (let z = -roofDepth / 2 + 0.20; z < roofDepth / 2; z += 0.39) {
    const cap = new THREE.CylinderGeometry(0.135, 0.135, 0.405, 10, 1, true, 0, Math.PI);
    cap.rotateZ(Math.PI / 2);
    cap.rotateY(Math.PI / 2);
    cap.translate(0, ridge + 0.106, z);
    put('roof', cap, 0.98 + random() * 0.12);
  }

  if (v.id !== 'wing') {
  // A brick chimney emerges from the slope, with lead flashing, corbelled cap,
  // and two terracotta pots whose open tops remain visible from the valley view.
  const chimneyX = specification.family === 'porch-farmhouse' ? halfSpan * 0.48
    : specification.family === 'two-storey' ? halfSpan * 0.34 : -halfSpan * 0.5325;
  const chimneyZ = specification.family === 'porch-farmhouse' ? -length * 0.31
    : specification.family === 'two-storey' ? -length * 0.34
    : specification.family === 'side-wing' ? length * 0.16 : -length * 0.226667;
  const chimneyBase = ridge - Math.abs(chimneyX) * pitch - 0.08;
  const chimneyTop = ridge + 0.38;
  box('mortar', chimneyX, (chimneyBase + chimneyTop) * 0.5, chimneyZ, 0.76, chimneyTop - chimneyBase, 0.91, 0.84);
  const chimneyRows = Math.ceil((chimneyTop - chimneyBase) / 0.165);
  for (let row = 0; row < chimneyRows; row++) {
    const y = chimneyBase + 0.075 + row * 0.165;
    for (const sign of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        box('chimney', chimneyX - 0.26 + i * 0.26, y, chimneyZ + sign * 0.458, 0.246, 0.145, 0.075, 0.84 + random() * 0.31);
        box('chimney', chimneyX + sign * 0.382, y, chimneyZ - 0.30 + i * 0.30, 0.075, 0.145, 0.286, 0.84 + random() * 0.31);
      }
    }
  }
  box('iron', chimneyX, chimneyBase + 0.13, chimneyZ, 0.96, 0.09, 1.08, 0.9, roofAngle);
  box('stone', chimneyX, chimneyTop + 0.055, chimneyZ, 0.91, 0.14, 1.07, 0.86);
  box('stone', chimneyX, chimneyTop + 0.16, chimneyZ, 1.01, 0.09, 1.16, 0.98);
  for (const dz of [-0.26, 0.26]) {
    const pot = new THREE.CylinderGeometry(0.143, 0.17, 0.38, 12, 1, true);
    pot.translate(chimneyX, chimneyTop + 0.37, chimneyZ + dz);
    put('chimney', pot, 1.08);
    const lip = new THREE.TorusGeometry(0.143, 0.026, 5, 12);
    lip.rotateX(Math.PI / 2);
    lip.translate(chimneyX, chimneyTop + 0.56, chimneyZ + dz);
    put('chimney', lip, 1.12);
    const dark = new THREE.CircleGeometry(0.13, 12);
    dark.rotateX(-Math.PI / 2);
    dark.translate(chimneyX, chimneyTop + 0.39, chimneyZ + dz);
    put('iron', dark, 0.40);
  }

  }
  });

  if (!specification.porch) atFacade(specification.entry.x, specification.entry.z - 3, 0, () => {
  // Small entrance hood: slate courses, exposed brackets and real eave depth.
  const hoodPitch = 0.43;
  const hoodAngle = Math.atan(hoodPitch);
  const hoodLength = Math.hypot(1.20, 1.20 * hoodPitch);
  for (const side of [-1, 1]) {
    box('timber', side * 0.60, 3.73 - 0.60 * hoodPitch, 3.50, hoodLength, 0.10, 1.38, 0.85, -side * hoodAngle);
    for (let row = 0; row < 3; row++) for (let column = 0; column < 4; column++) {
      const along = (row + 0.5) * hoodLength / 3;
      const geometry = slate(hoodLength / 3 + 0.055, 0.335, 0.035);
      if (side === -1) geometry.rotateY(Math.PI);
      geometry.rotateZ(-side * hoodAngle);
      geometry.translate(side * along * Math.cos(hoodAngle), 3.78 - along * Math.sin(hoodAngle), 2.81 + (column + 0.5) * 0.345);
      put('roof', geometry, 0.93 + random() * 0.14);
    }
    beam([side * 0.84, 2.93, 3.06], [side * 0.84, 3.22, 3.78], 0.11, 0.11, 'timber', 1.03);
    beam([0, 3.74, 4.21], [side * 1.24, 3.74 - 1.24 * hoodPitch, 4.21], 0.13, 0.10, 'timber', 1.08);
  }

  });

  if (specification.porch) atFacade(0, specification.entry.z, 0, () => {
    const width = specification.porch.width;
    const run = 2.14, drop = 0.47, high = 3.43, low = high - drop;
    const slope = Math.atan(drop / run), slopeLength = Math.hypot(run, drop);
    // Broad raised porch, continuous shelter and front posts change the entire
    // farmhouse facade, with a clear stair opening aligned to the offset door.
    box('stone', 0, 0.21, 0.95, width, 0.42, 1.98, 0.92);
    const boards = Math.ceil(width / 0.24);
    for (let i = 0; i < boards; i++) box('door', -width / 2 + (i + 0.5) * width / boards,
      0.48, 0.95, width / boards - 0.008, 0.10, 1.98, 0.86 + random() * 0.18);
    const roofBase = new THREE.BoxGeometry(slopeLength, 0.095, width + 0.34);
    roofBase.rotateZ(-slope);
    roofBase.rotateY(-Math.PI / 2);
    roofBase.translate(0, high - drop / 2 - 0.04, run / 2 - 0.12);
    put('timber', roofBase, 0.86);
    const columns = Math.ceil((width + 0.34) / 0.46), rows = 5;
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
      const along = (row + 0.5) * slopeLength / rows;
      const geometry = slate(slopeLength / rows + 0.07, (width + 0.34) / columns - 0.009, 0.038);
      geometry.rotateZ(-slope);
      geometry.rotateY(-Math.PI / 2);
      geometry.translate(-(width + 0.34) / 2 + (column + 0.5) * (width + 0.34) / columns,
        high - along * Math.sin(slope) + 0.055 + (rows - row) * 0.004, -0.12 + along * Math.cos(slope));
      put('roof', geometry, 0.87 + random() * 0.23);
    }
    box('timber', 0, low - 0.065, run - 0.12, width + 0.38, 0.19, 0.15, 1.03);
    const posts = [-width / 2 + 0.20, -1.15, 1.65, width / 2 - 0.20];
    for (const x of posts) {
      box('timber', x, (low + 0.43) / 2, 1.83, 0.16, low - 0.43, 0.16, 1.04);
      box('stone', x, 0.59, 1.83, 0.24, 0.27, 0.24, 1.08);
      beam([x, high - 0.13, -0.05], [x, low - 0.13, 1.93], 0.11, 0.11, 'timber', 0.95);
      for (const side of [-1, 1]) {
        if (Math.abs(x + side * 0.39) < width / 2) beam([x, low - 0.62, 1.83], [x + side * 0.39, low - 0.11, 1.83], 0.09, 0.09, 'timber', 1.02);
      }
    }
    // Rail on the wide right span leaves the left entrance/stair approach clear.
    const railStart = -0.98, railEnd = width / 2 - 0.25;
    box('timber', (railStart + railEnd) / 2, 1.13, 1.83, railEnd - railStart, 0.10, 0.10, 1.01);
    for (let x = railStart; x <= railEnd; x += 0.40) box('timber', x, 0.80, 1.83, 0.055, 0.56, 0.055, 0.94);
  });

  let triangles = 0;
  for (const [role, geometries] of parts) {
    if (!geometries.length) continue;
    const geometry = mergeGeometries(geometries, false);
    for (const part of geometries) part.dispose();
    if (!geometry) throw new Error(`Cottage geometry merge failed: ${role}`);
    geometry.name = `Cottage merged ${role}`;
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    triangles += geometry.attributes.position.count / 3;
    const mesh = new THREE.Mesh(geometry, materials.get(role));
    mesh.name = `Cottage · ${role}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.worldStudyRole = role;
    group.add(mesh);
  }
  let disposed = false;
  group.userData.dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const mesh of group.children) mesh.geometry?.dispose();
    for (const material of materials.values()) material.dispose();
    for (const texture of textures) texture.dispose();
  };
  group.userData.study = {
    ...specification, roofColor: palette.roof, palette: { ...palette },
    kind: 'construction-visual-specimen', style, seed,
    wallFootprint: { ...specification.footprint }, wallHeight: specification.dimensions.wallHeight,
    ridgeHeight: specification.dimensions.ridgeHeight, front: '+Z', materialRoles: [...parts.keys()],
    apertures,
    meshes: group.children.length, triangles,
    limitations: ['Opaque recessed glazing; no furnished interior', 'Study geometry, not a source-editable Architecture assembly'],
  };
  return group;
}
