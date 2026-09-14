import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, cpus, totalmem } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:5401/scripts/world-valley-study.html';
const output = resolve(process.argv[3] ?? 'artifacts/world-study');
const functionalOnly = process.env.WORLD_STUDY_FUNCTIONAL === '1';
const profile = await mkdtemp(join(tmpdir(), 'world-study-'));
await mkdir(output, { recursive: true });
let browser;
const report = { pass: false, scope: functionalOnly ? 'functional-only' : 'performance-and-functional', url, cpu: cpus()[0]?.model, systemMemoryBytes: totalmem(), timestamp: new Date().toISOString(), results: [], errors: [] };
// A failed rerun must never leave a previous PASS receipt as the latest result.
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
try {
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, userDataDir: profile,
    args: ['--enable-unsafe-webgpu','--enable-features=WebGPU','--no-sandbox','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding'] });
  const page = await browser.newPage(); await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  const errors = report.errors;
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); console.error(message.text()); } else if (message.text().startsWith('WORLD-STUDY')) console.log(message.text()); });
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => globalThis.__WORLD_STUDY_RESULT__, { timeout: 200000 });
  const initial = await page.evaluate(() => globalThis.__WORLD_STUDY_RESULT__);
  report.initial = initial;
  if (!initial.pass) throw new Error(JSON.stringify(initial));
  const results = report.results;
  if (!functionalOnly) for (const movingSun of [false, true]) results.push(await page.evaluate(movingSun => globalThis.__WORLD_STUDY__.measure({ movingSun, seconds: 5 }), movingSun));
  await page.evaluate(() => { globalThis.__WORLD_STUDY__.resetSun(); document.body.classList.add('capture'); });
  for (const pose of ['valley','shore','cottage','forest']) {
    await page.evaluate(pose => globalThis.__WORLD_STUDY__.moveCamera(pose), pose);
    await page.waitForFunction(() => globalThis.__WORLD_STUDY_ENGINE__.stats.readout.drawCalls > 0);
    // Allow shader/LOD transitions to complete at the changed viewpoint.
    await new Promise(resolve => setTimeout(resolve, 1400));
    await page.screenshot({ path: join(output, `${pose}.png`) });
  }
  // Drive the real controls, then inspect both persistent intent and roof pixels.
  // All image checks happen outside the performance capture windows.
  if (!initial.baseline) {
    const inspectCottage = async name => {
      await new Promise(resolve => setTimeout(resolve, 1400));
      const png = await page.screenshot({ encoding: 'base64' });
      await writeFile(join(output, `${name}.png`), Buffer.from(png, 'base64'));
      return page.evaluate(async png => {
        const { THREE } = await import('/src/engine/index.js');
        const engine = globalThis.__WORLD_STUDY_ENGINE__, study = globalThis.__WORLD_STUDY__.study;
        const cottage = study.cottage, camera = engine.camera;
        if (!cottage?.isGroup) throw new Error('Study must expose the actual cottage group');
        cottage.updateWorldMatrix(true, true); camera.updateMatrixWorld(true);
        const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
        const { data } = ctx.getImageData(0, 0, image.width, image.height);
        const meshes = [];
        cottage.traverse(object => { if (object.isMesh && object.visible) meshes.push(object); });
        const structuralMeshes = meshes.filter(mesh => !['plant', 'flower'].includes(mesh.userData.worldStudyRole));
        if (!structuralMeshes.some(mesh => mesh.userData.worldStudyRole === 'roof')) throw new Error('No actual roof mesh available');
        // Hash actual vertex/index data and placement, never material colors or
        // family labels. A changed label or randomized texture cannot pass this.
        let geometryHash = 2166136261, vertices = 0, triangles = 0;
        const hash = value => { geometryHash = Math.imul(geometryHash ^ value, 16777619); };
        const silhouetteWidth = 144, silhouetteHeight = 90;
        const silhouette = new Uint8Array(silhouetteWidth * silhouetteHeight);
        const roofCandidates = [];
        const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
        const pa = new THREE.Vector3(), pb = new THREE.Vector3(), pc = new THREE.Vector3();
        const center = new THREE.Vector3(), projected = new THREE.Vector3();
        const normal = new THREE.Vector3(), edge = new THREE.Vector3(), cameraPosition = new THREE.Vector3();
        camera.getWorldPosition(cameraPosition);
        const orient = (ax, ay, bx, by, x, y) => (bx - ax) * (y - ay) - (by - ay) * (x - ax);
        const screen = vector => { vector.project(camera); vector.x = (vector.x + 1) * image.width / 2; vector.y = (1 - vector.y) * image.height / 2; return vector; };
        for (const mesh of structuralMeshes) {
          const geometry = mesh.geometry, position = geometry.attributes.position, index = geometry.index;
          if (!position) continue;
          hash(position.count); hash(index?.count ?? 0);
          for (const value of mesh.matrixWorld.elements) hash(Math.round(value * 10000));
          for (let i = 0; i < position.count; i++) {
            hash(Math.round(position.getX(i) * 10000)); hash(Math.round(position.getY(i) * 10000)); hash(Math.round(position.getZ(i) * 10000));
          }
          if (index) for (let i = 0; i < index.count; i++) hash(index.getX(i));
          vertices += position.count;
          const count = index?.count ?? position.count;
          triangles += count / 3;
          for (let i = 0; i + 2 < count; i += 3) {
            a.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(mesh.matrixWorld);
            b.fromBufferAttribute(position, index ? index.getX(i + 1) : i + 1).applyMatrix4(mesh.matrixWorld);
            c.fromBufferAttribute(position, index ? index.getX(i + 2) : i + 2).applyMatrix4(mesh.matrixWorld);
            screen(pa.copy(a)); screen(pb.copy(b)); screen(pc.copy(c));
            if ([pa.z, pb.z, pc.z].some(z => z < -1 || z > 1)) continue;
            // Coarse projected occupancy proves silhouette changes independently
            // of the declared architectural family and tiny surface variation.
            const ax = pa.x / image.width * silhouetteWidth, ay = pa.y / image.height * silhouetteHeight;
            const bx = pb.x / image.width * silhouetteWidth, by = pb.y / image.height * silhouetteHeight;
            const cx = pc.x / image.width * silhouetteWidth, cy = pc.y / image.height * silhouetteHeight;
            const area = orient(ax, ay, bx, by, cx, cy);
            if (Math.abs(area) > 1e-8) {
              const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(silhouetteWidth - 1, Math.floor(Math.max(ax, bx, cx)));
              const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(silhouetteHeight - 1, Math.floor(Math.max(ay, by, cy)));
              for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
                const ab = orient(ax, ay, bx, by, x + .5, y + .5), bc = orient(bx, by, cx, cy, x + .5, y + .5), ca = orient(cx, cy, ax, ay, x + .5, y + .5);
                if (area > 0 ? ab >= 0 && bc >= 0 && ca >= 0 : ab <= 0 && bc <= 0 && ca <= 0) silhouette[y * silhouetteWidth + x] = 1;
              }
            }
            if (mesh.userData.worldStudyRole !== 'roof') continue;
            center.copy(a).add(b).add(c).multiplyScalar(1 / 3);
            normal.subVectors(b, a).cross(edge.subVectors(c, a));
            if (normal.dot(edge.subVectors(cameraPosition, center)) <= 0) continue;
            screen(projected.copy(center));
            const x = Math.floor(projected.x), y = Math.floor(projected.y);
            if (x < 1 || y < 1 || x >= image.width - 1 || y >= image.height - 1) continue;
            const screenArea = orient(pa.x, pa.y, pb.x, pb.y, pc.x, pc.y);
            const sides = [[pa, pb], [pb, pc], [pc, pa]];
            // Pixel centers must lie inside the triangle with edge clearance;
            // this avoids anti-aliased slate boundaries and roof/background mix.
            if (sides.some(([u, v]) => {
              const side = orient(u.x, u.y, v.x, v.y, x + .5, y + .5);
              return side * screenArea < 0 || Math.abs(side) / Math.max(1e-8, Math.hypot(v.x - u.x, v.y - u.y)) < .7;
            })) continue;
            roofCandidates.push({ x, y });
          }
        }
        const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2(), used = new Set();
        const sums = [0, 0, 0], samplePoints = [];
        const stride = Math.max(1, Math.floor(roofCandidates.length / 800));
        for (let i = 0; i < roofCandidates.length && samplePoints.length < 256; i += stride) {
          const { x, y } = roofCandidates[i], key = y * image.width + x;
          if (used.has(key)) continue;
          used.add(key);
          ndc.set((x + .5) / image.width * 2 - 1, 1 - (y + .5) / image.height * 2);
          raycaster.setFromCamera(ndc, camera);
          const first = raycaster.intersectObjects(meshes, false)[0];
          if (first?.object.userData.worldStudyRole !== 'roof') continue;
          const offset = key * 4;
          if (data[offset] + data[offset + 1] + data[offset + 2] < 36) continue;
          sums[0] += data[offset]; sums[1] += data[offset + 1]; sums[2] += data[offset + 2];
          samplePoints.push([x, y]);
        }
        if (samplePoints.length < 40) throw new Error(`Only ${samplePoints.length} visible interior roof samples (${roofCandidates.length} candidates)`);
        const packedMask = new Uint8Array(Math.ceil(silhouette.length / 8));
        let occupiedPixels = 0;
        silhouette.forEach((value, i) => { if (value) { packedMask[i >> 3] |= 1 << (i & 7); occupiedPixels++; } });
        const sum = sums.reduce((a, b) => a + b, 0);
        return {
          state: study.cottageState,
          geometry: { hash: (geometryHash >>> 0).toString(16), vertices, triangles, meshes: structuralMeshes.length,
            bounds: new THREE.Box3().setFromObject(cottage).getSize(new THREE.Vector3()).toArray(),
            silhouette: { width: silhouetteWidth, height: silhouetteHeight, occupiedPixels, bits: btoa(String.fromCharCode(...packedMask)) } },
          pixels: { count: samplePoints.length, means: sums.map(value => value / samplePoints.length), chroma: sums.map(value => value / sum),
            blueGreenRatio: sums[2] / Math.max(1, sums[1]), greenBlueRatio: sums[1] / Math.max(1, sums[2]), samplePoints },
        };
      }, png);
    };
    await page.evaluate(() => globalThis.__WORLD_STUDY__.moveCamera('cottage'));
    const before = await inspectCottage('roof-before');
    report.edits = { before };
    // Controls are hidden only for captures; expose them for actual clicks.
    const click = async id => {
      await page.evaluate(() => document.body.classList.remove('capture'));
      await page.click(`#${id}`);
      await page.evaluate(() => document.body.classList.add('capture'));
    };
    const paint = async color => {
      await page.evaluate(color => {
        document.body.classList.remove('capture');
        const input = document.querySelector('#roof-color');
        if (input?.type !== 'color' || input.disabled) throw new Error('An enabled roof color input is required');
        input.focus(); input.value = color; input.dispatchEvent(new Event('change', { bubbles: true }));
        document.body.classList.add('capture');
      }, color);
    };
    const controls = () => page.evaluate(() => ({ color: document.querySelector('#roof-color').value, mode: document.querySelector('#roof-mode').textContent }));
    const chromaDistance = (a, b) => a.pixels.chroma.reduce((sum, channel, i) => sum + Math.abs(channel - b.pixels.chroma[i]), 0);
    const silhouetteDifference = (a, b) => {
      const first = Buffer.from(a.geometry.silhouette.bits, 'base64'), second = Buffer.from(b.geometry.silhouette.bits, 'base64');
      assert.equal(first.length, second.length);
      const popcount = value => { let n = 0; for (; value; value &= value - 1) n++; return n; };
      let different = 0, union = 0;
      for (let i = 0; i < first.length; i++) { different += popcount(first[i] ^ second[i]); union += popcount(first[i] | second[i]); }
      return different / Math.max(1, union);
    };
    const blue = '#2359cf', green = '#288148';
    await paint(blue);
    const paintedBlue = await inspectCottage('roof-painted-blue');
    report.edits.paintedBlue = paintedBlue;
    assert.equal(paintedBlue.state.roofColor, blue); assert.equal(paintedBlue.state.edits.length, 1);
    assert.equal(paintedBlue.state.seed, before.state.seed);
    assert.equal(paintedBlue.geometry.hash, before.geometry.hash, 'Painting must preserve actual geometry');
    assert.ok(paintedBlue.pixels.blueGreenRatio > before.pixels.blueGreenRatio + .12, 'Choosing blue must change actual visible roof pixels');
    assert.equal((await controls()).color, blue); assert.match((await controls()).mode, /custom/i);
    const variants = [];
    report.edits.variants = variants;
    let previous = paintedBlue;
    for (let i = 0; i < 4; i++) {
      await click('regenerate');
      const current = await inspectCottage(`cottage-variant-${i + 1}`);
      variants.push(current);
      assert.equal(current.state.seed, previous.state.seed + 1);
      assert.ok(current.state.architecture?.family && current.state.architecture?.label, 'Expose the resolved architectural family');
      assert.notEqual(current.state.architecture.family, previous.state.architecture.family, 'New variation must change architectural family');
      assert.notEqual(current.geometry.hash, previous.geometry.hash, 'New variation must change actual geometry');
      current.silhouetteDifferenceFromPrevious = silhouetteDifference(previous, current);
      assert.ok(current.silhouetteDifferenceFromPrevious > .02, 'New variation must visibly change the cottage silhouette');
      assert.equal(current.state.roofColor, blue);
      assert.deepEqual(current.state.edits, paintedBlue.state.edits); assert.deepEqual(current.state.orphanEdits, []);
      assert.ok(current.pixels.blueGreenRatio > 1.1, 'Every regenerated architectural family must visibly retain the chosen blue roof');
      assert.equal((await controls()).color, blue);
      previous = current;
    }
    assert.equal(new Set(variants.map(value => value.state.architecture.family)).size, 4, 'Four consecutive variants must use four architectural families');
    assert.equal(new Set(variants.map(value => value.geometry.hash)).size, 4, 'Four consecutive variants must have distinct actual geometry');
    await paint(green);
    const paintedGreen = await inspectCottage('roof-painted-green');
    report.edits.paintedGreen = paintedGreen;
    assert.equal(paintedGreen.state.roofColor, green); assert.equal(paintedGreen.state.edits.length, 1);
    assert.equal(paintedGreen.geometry.hash, previous.geometry.hash, 'Repainting must preserve architecture');
    assert.ok(paintedGreen.pixels.greenBlueRatio > 1.1, 'Choosing green must visibly paint the roof green');
    assert.ok(chromaDistance(paintedGreen, previous) > .12, 'Arbitrary color choices must change rendered pixels');
    await page.evaluate(() => document.body.classList.remove('capture'));
    await page.screenshot({ path: join(output, 'cottage-controls.png') });
    await page.evaluate(() => document.body.classList.add('capture'));
    await click('reset-edit');
    const reset = await inspectCottage('roof-reset');
    report.edits.reset = reset;
    assert.equal(reset.state.edits.length, 0); assert.deepEqual(reset.state.orphanEdits, []);
    assert.equal(reset.state.seed, paintedGreen.state.seed);
    assert.equal(reset.state.roofColor, reset.state.generatedRoofColor); assert.notEqual(reset.state.roofColor, green);
    assert.equal(reset.geometry.hash, paintedGreen.geometry.hash, 'Reset must preserve architecture');
    assert.ok(chromaDistance(reset, paintedGreen) > .08, 'Reset must visibly restore generated appearance');
    assert.equal((await controls()).color, reset.state.generatedRoofColor); assert.match((await controls()).mode, /generated/i);
    await click('regenerate');
    const inherited = await inspectCottage('roof-generated-next');
    report.edits.inherited = inherited;
    assert.equal(inherited.state.seed, reset.state.seed + 1); assert.equal(inherited.state.edits.length, 0);
    assert.deepEqual(inherited.state.orphanEdits, []);
    assert.equal(inherited.state.roofColor, inherited.state.generatedRoofColor);
    assert.notEqual(inherited.state.generatedRoofColor, reset.state.generatedRoofColor, 'After reset, regeneration must inherit the next generated palette');
    assert.equal((await controls()).color, inherited.state.generatedRoofColor); assert.match((await controls()).mode, /generated/i);
    report.edits = { before, paintedBlue, variants, paintedGreen, reset, inherited };
  } else {
    const baselineControls = await page.evaluate(() => ({
      selected: document.querySelector('a[aria-current="page"]')?.dataset.style,
      disabled: ['roof-color', 'regenerate', 'reset-edit'].every(id => document.getElementById(id).disabled),
      label: document.getElementById('status').textContent,
    }));
    assert.equal(baselineControls.selected, 'baseline');
    assert.ok(baselineControls.disabled, 'Baseline must not expose detailed-cottage editing');
    assert.match(baselineControls.label, /baseline/i);
    await page.evaluate(() => { globalThis.__WORLD_STUDY__.moveCamera('valley'); document.body.classList.remove('capture'); });
    await new Promise(resolve => setTimeout(resolve, 1400));
    await page.screenshot({ path: join(output, 'baseline-controls.png') });
    report.baselineControls = baselineControls;
  }
  report.browser = await browser.version();
  report.method = functionalOnly
    ? 'Functional verification only; scratch Chromium; 1440x900; actual Engine loop and DOM controls. No performance measurement windows; startup observations are not isolated performance claims. Actual cottage geometry, projected silhouettes and raycast-visible roof pixels gate architectural variation, arbitrary paint, persistent edits and reset/inheritance.'
    : 'Isolated scratch Chromium; 1440x900; actual Engine loop; fixed-camera static and continuously advancing atmosphere sun. CPU phase totals plus GPU timestamp series; GPU queue/copy counters. Does not include a live editor. Counts explicit scene.traverse calls, not per-object caster classification. Shadow implementation is unchanged. Screenshots and edit checks occur after timings.';
  if (errors.length || results.some(result => result.errors.length)) throw new Error('Study reported console/WebGPU errors');
  report.pass = true;
  console.log('WORLD-STUDY PASS', output);
} catch (error) {
  report.failure = error.stack ?? String(error);
  throw error;
} finally {
  await writeFile(join(output,'report.json'), JSON.stringify(report,null,2));
  await browser?.close();
  if (dirname(resolve(profile)) !== resolve(tmpdir()) || !basename(profile).startsWith('world-study-')) throw new Error('Unexpected scratch profile path');
  await rm(profile, { recursive: true, force: true });
}
