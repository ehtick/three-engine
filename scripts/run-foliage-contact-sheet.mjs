// Copy of `run-foliage-tree-preview.mjs`'s harness-driving shape, purpose-built
// for the P1-A tree-quality receipt: ONE contact-sheet PNG per brief, rather
// than the per-species/per-LOD screenshots and canopy regression gate the
// original script produces (that script's own smoke-test wiring is untouched).
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const positional = process.argv.slice(2).filter(value => !value.startsWith('--'));
const base = positional[0] ?? process.env.FOLIAGE_PREVIEW_BASE ?? 'http://127.0.0.1:5401';
const outDir = positional[1] ?? 'C:/Users/KHUDII~1/AppData/Local/Temp/claude/C--Users-Khudiiash-Documents-JS-engine/1aa7d815-bb78-437c-85f5-3ad5bb036c8b/scratchpad';
fs.mkdirSync(outDir, { recursive: true });

// Mirrors src/engine/world/valleyEcology.js:70-95's exact tree/shrub group
// props (that table is private to `valleyEcologySteps`, and this brief's file
// list does not include that module) — every group's own species, height,
// width, leafDensity, leafSize, branchDensity, crownBase, crownSpread,
// leafColor and barkColor, with `seed` forced to 3 so every population is
// judged at the one seed the brief names.
const VALLEY_ECOLOGY_POPULATIONS = [
  { id: 'oak-wide', props: { species: 'oak', height: 11, width: 8.8, leafDensity: 1.5, leafSize: 1.28, branchDensity: 1.25, crownBase: -.08, crownSpread: .96, leafColor: '#526632', barkColor: '#625440' } },
  { id: 'oak-elder', props: { species: 'oak', height: 13, width: 10, leafDensity: 1.55, leafSize: 1.24, branchDensity: 1.25, crownBase: -.07, crownSpread: .96, leafColor: '#4b6030', barkColor: '#5b503c' } },
  { id: 'birch-tall', props: { species: 'birch', height: 12, width: 6, leafDensity: 1.5, leafSize: 1.2, branchDensity: 1.2, crownBase: -.05, crownSpread: 1, leafColor: '#70874a', barkColor: '#c0bfb0' } },
  { id: 'pine-tall', props: { species: 'pine', height: 14, width: 6.3, leafDensity: 1.35, leafSize: 1.15, branchDensity: 1.1, crownBase: -.05, crownSpread: 1, leafColor: '#3b5339', barkColor: '#6c5444' } },
  { id: 'hazel-study', props: { species: 'oak', height: 1.8, width: 2.9, leafDensity: 1.6, leafSize: 1.35, branchDensity: 1.4, crownBase: -.15, crownSpread: 1.2, leafColor: '#4e6736', barkColor: '#6c6048' } },
  { id: 'young-growth', props: { species: 'birch', height: 2.8, width: 2.6, leafDensity: 1.5, leafSize: 1.25, branchDensity: 1.2, crownBase: -.15, crownSpread: 1.15, leafColor: '#688446', barkColor: '#82755d' } },
  { id: 'accent', props: { species: 'oak', height: 12, width: 7.2, leafDensity: 1.45, leafSize: 1.24, branchDensity: 1.15, crownBase: -.06, crownSpread: .98, leafColor: '#c99a3a', barkColor: '#5e5142' } },
].map(entry => ({ id: entry.id, props: { ...entry.props, seed: 3 } }));

const SPECIES_PRESETS = ['oak', 'birch', 'pine', 'black-tupelo', 'weeping-willow', 'spruce', 'maple', 'poplar', 'shrub', 'hawthorn']
  .map(species => ({ id: species, props: { species, seed: 1 } })); // default controls: no shape overrides at all

function writeDataUrl(dataUrl, file) {
  const base64 = dataUrl.split(',')[1];
  fs.writeFileSync(file, Buffer.from(base64, 'base64'));
  console.log('wrote', file, fs.statSync(file).size, 'bytes');
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'engine-contact-sheet-')), headless: 'new',
  // A 7-population sheet builds every tree/atlas SEQUENTIALLY (see the
  // per-entity comment below) — comfortably past puppeteer's own 180s default
  // CDP protocol timeout once each population's own warmup takes a couple of
  // seconds. Raised so a real, still-in-progress build never reads as a
  // dead protocol.
  protocolTimeout: 600000,
  args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--no-sandbox', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});
// One fresh page per sheet, not two `contactSheet` calls on the same page: a
// second call in the same session hit a pre-existing engine race (shared TSL
// material-node builder state left over from the first sheet's own species)
// that is well outside this brief's file list to chase down. A fresh
// navigation gives each sheet a clean engine/material-cache state, exactly
// like a fresh `smoke:foliage-trees` run would get.
async function renderSheet(entries, cols, rows, file, view = 'side', sheetW = 1600, sheetH = 900) {
  const page = await browser.newPage();
  try {
    const errors = [];
    page.on('pageerror', e => errors.push(e.stack ?? e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.setViewport({ width: 500, height: 500, deviceScaleFactor: 1 });
    await page.goto(`${base}/scripts/foliage-contact-sheet.html`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => globalThis.__CONTACT_SHEET_READY__ || globalThis.__CONTACT_SHEET_ERROR__, { timeout: 120000 });
    const failure = await page.evaluate(() => globalThis.__CONTACT_SHEET_ERROR__);
    if (failure) throw new Error(failure);
    // WebGPU pads readback rows to a 256-byte stride, so the tile width must
    // itself be a multiple of 64px (tileW*4 an exact multiple of 256) or the
    // raw readback comes back larger than tileW*tileH*4 and `renderTile`'s
    // tightly-packed check throws. 5x2 at 1600x900 -> 320px tiles (320*4=1280);
    // 2x1 at 1280x720 -> 640px tiles (640*4=2560) for the walk-height sheet.
    const dataUrl = await page.evaluate((entries, cols, rows, sheetW, sheetH, view) =>
      globalThis.__CONTACT_SHEET__.contactSheet(entries, cols, rows, sheetW, sheetH, view), entries, cols, rows, sheetW, sheetH, view);
    if (errors.length) throw new Error(JSON.stringify(errors));
    writeDataUrl(dataUrl, file);
  } finally { await page.close(); }
}

// P1-A twig-mass receipt: `accent` and `oak-wide` at a walking-height
// three-quarter view (camera 1.7m up, 12m away — see `frameWalk` in
// foliage-contact-sheet.html), the owner's own reported viewing condition.
const WALK_POPULATIONS = VALLEY_ECOLOGY_POPULATIONS.filter(entry => entry.id === 'accent' || entry.id === 'oak-wide');

try {
  console.log('rendering valleyEcology contact sheet (7 populations, seed 3)...');
  await renderSheet(VALLEY_ECOLOGY_POPULATIONS, 5, 2, path.join(outDir, 'trees-contact.png'));

  console.log('rendering species-preset sheet (10 species, default controls)...');
  await renderSheet(SPECIES_PRESETS, 5, 2, path.join(outDir, 'trees-species.png'));

  console.log('rendering walking-height three-quarter sheet (accent, oak-wide)...');
  await renderSheet(WALK_POPULATIONS, 2, 1, path.join(outDir, 'trees-walk.png'), 'walk', 1280, 720);

  console.log('CONTACT SHEET PASS');
} finally {
  await browser.close();
}
