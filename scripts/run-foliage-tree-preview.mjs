import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const positional = process.argv.slice(2).filter(value => !value.startsWith('--'));
const base = positional[0] ?? 'http://127.0.0.1:5335';
const out = positional[1] ?? 'artifacts/foliage/trees';
const baseline = process.env.FOLIAGE_TREE_BASELINE === '1';
const oldMipTail = process.argv.includes('--old-mip-tail');
const baselineFiles = ['treeGrowth.js', 'foliageGeometry.js', 'foliageSurfaceTexture.js', 'foliageMaterial.js'];
let baselineRevision = null;
if (baseline) {
  baselineRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  fs.mkdirSync('artifacts/foliage/trees-baseline-source', { recursive: true });
  for (const file of baselineFiles) {
    const source = execFileSync('git', ['show', `${baselineRevision}:src/modules/foliage/${file}`], { encoding: 'utf8' })
      .replaceAll('"./foliageWind.js"', '"/src/modules/foliage/foliageWind.js"')
      .replaceAll('"../../engine/vfx/clothWind.js"', '"/src/engine/vfx/clothWind.js"');
    fs.writeFileSync(`artifacts/foliage/trees-baseline-source/${file}`, source);
  }
}
fs.mkdirSync(out,{recursive:true});
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  userDataDir:fs.mkdtempSync(path.join(os.tmpdir(),'engine-tree-preview-')),headless:'new',
  args:['--enable-unsafe-webgpu','--enable-features=WebGPU','--no-sandbox','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding'],
});
const errors=[];
const report = { pass: false, baseline, baselineRevision, oldMipTail, results: [], canopy: [], errors };
fs.writeFileSync(`${out}/result.json`, JSON.stringify(report, null, 2));
try {
  const page=await browser.newPage();
  if (baseline) {
    await page.setRequestInterception(true);
    page.on('request', async request => {
      const pathname = new URL(request.url()).pathname;
      const file = baselineFiles.find(name => pathname === `/src/modules/foliage/${name}`);
      if (!file) return request.continue();
      // Let Vite resolve bare Three imports in the retained source snapshot.
      const response = await fetch(`${base}/artifacts/foliage/trees-baseline-source/${file}`);
      await request.respond({ status: response.status, contentType: 'text/javascript', body: await response.text() });
    });
  }
  await page.setViewport({width:1300,height:724,deviceScaleFactor:1});
  page.on('pageerror',e=>errors.push(e.stack??e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(`${base}/scripts/foliage-tree-preview.html${oldMipTail ? '?oldMipTail=1' : ''}`,{waitUntil:'load',timeout:60000});
  await page.waitForFunction(()=>globalThis.__TREE_PREVIEW_READY__||globalThis.__TREE_PREVIEW_ERROR__,{timeout:120000});
  const failure=await page.evaluate(()=>globalThis.__TREE_PREVIEW_ERROR__);
  if(failure)throw new Error(failure);
  const results=report.results;
  for(const species of ['oak','birch','pine']) {
    for(const [view,lod,turn] of [['full',0,0],['leaves',0,0],['bark',0,0],['full',1,1.2],['full',2,0]]) {
      results.push(await page.evaluate((s,v,l,t)=>globalThis.__TREE_PREVIEW__.show(s,v,l,t),species,view,lod,turn));
      await page.screenshot({path:`${out}/${species}-${view}-${lod}.png`});
    }
  }
  for (const species of ['oak', 'birch', 'pine']) {
    const measurement = await page.evaluate(species => globalThis.__TREE_PREVIEW__.measureCanopy(species), species);
    for (let angle = 0; angle < measurement.angles.length; angle++) {
      const entry = measurement.angles[angle];
      fs.writeFileSync(`${out}/${species}-canopy-angle-${angle}.png`, Buffer.from(entry.strip.split(',')[1], 'base64'));
      delete entry.strip;
      for (const view of entry.views) {
        fs.writeFileSync(`${out}/${species}-canopy-angle-${angle}-lod-${view.lod}.png`, Buffer.from(view.png.split(',')[1], 'base64'));
        delete view.png;
      }
    }
    report.canopy.push(measurement);
    console.log('FOLIAGE CANOPY', JSON.stringify({ species, pass: measurement.pass, views: measurement.angles.map(({ turn, views }) => ({ turn, levels: views.map(({ lod, greenPixels, canopyFraction, relativeToNear }) => ({ lod, greenPixels, canopyFraction, relativeToNear })) })) }));
  }
  await page.evaluate(() => globalThis.__TREE_PREVIEW__.show('oak', 'full', 0, 0));
  await page.screenshot({ path: `${out}/tree-controls.png` });
  const failures = report.canopy.flatMap(measurement => measurement.failures);
  if (failures.length) throw new Error(`Tree canopy detail regression: ${failures.join('\n')}`);
  if(errors.length)throw new Error(JSON.stringify(errors));
  report.pass = true;
  console.log('FOLIAGE TREE PREVIEW PASS',JSON.stringify(results.map(({species,view,lod,geometry})=>({species,view,lod,triangles:geometry?.map(g=>g.triangles)}))));
} catch (error) {
  report.failure = error.stack ?? String(error);
  throw error;
} finally {
  fs.writeFileSync(`${out}/result.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
