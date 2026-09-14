// node scripts/run-env-light-test.mjs [base] — renders a sun-lit sphere with and without the scene HDRI
// and prints the sRGB luma at the lit side, the shadow side and the cast shadow.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.argv[2] ?? 'http://localhost:5351';
const out = 'artifacts/env-test';
fs.mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'engine-env-test-')), headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--no-sandbox'],
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warn') errors.push(`${m.type()}: ${m.text()}`); });
  await page.setViewport({ width: 960, height: 540, deviceScaleFactor: 1 });
  await page.goto(`${base}/scripts/env-light-test.html`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => globalThis.__ENV_READY__ || globalThis.__ENV_ERROR__, { timeout: 120000 });
  const failure = await page.evaluate(() => globalThis.__ENV_ERROR__);
  if (failure) throw new Error(failure);
  for (const arm of [{ env: false }, { env: true }, { env: false, ambientIntensity: 1 }]) {
    const result = await page.evaluate(a => globalThis.__ENV_TEST__.run(a), arm);
    const name = `${arm.env ? 'hdri' : 'nohdri'}${arm.ambientIntensity ? '-ambient' : ''}`;
    const png = await page.screenshot({ type: 'png' });
    fs.writeFileSync(`${out}/${name}.png`, png);
    const luma = await page.evaluate(async (b64, points) => {
      const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
      const out = {};
      for (const [k, [x, y]] of Object.entries(points)) {
        const d = ctx.getImageData(x - 2, y - 2, 5, 5).data; let s = 0;
        for (let i = 0; i < d.length; i += 4) s += .2126 * d[i] + .7152 * d[i + 1] + .0722 * d[i + 2];
        out[k] = Math.round(s / 25);
      }
      return out;
    }, Buffer.from(png).toString('base64'), result.points);
    console.log('ENV', name, JSON.stringify({ luma, environment: result.environment, environmentIntensity: result.environmentIntensity, environmentNode: result.environmentNode, background: result.background }));
  }
  if (errors.length) console.log('PAGE', JSON.stringify(errors.slice(0, 8)));
} finally { await browser.close(); }
