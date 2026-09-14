import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.argv[2] ?? 'http://127.0.0.1:5401';
const output = path.resolve(process.argv[3] ?? 'artifacts/atmosphere-surface-parity');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-atmosphere-surface-'));
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ pass: false, status: 'Running', base }, null, 2));
let browser;
const errors = [];
try {
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new', userDataDir: profile,
    args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--no-sandbox', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
  });
  const page = await browser.newPage(); await page.setViewport({ width: 900, height: 700 });
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  page.on('console', message => { console.log(message.text()); if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`${base.replace(/\/$/, '')}/scripts/atmosphere-surface-parity.html`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => globalThis.__ATMOSPHERE_SURFACE_RESULT__ !== undefined, { timeout: 150000 });
  const result = await page.evaluate(() => globalThis.__ATMOSPHERE_SURFACE_RESULT__);
  const images = await page.evaluate(() => globalThis.__ATMOSPHERE_SURFACE_IMAGES__);
  const shaders = await page.evaluate(() => globalThis.__ATMOSPHERE_SURFACE_SHADERS__);
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ ...result, browserErrors: errors }, null, 2));
  for (const [name, image] of Object.entries(images ?? {})) fs.writeFileSync(path.join(output, `${name}.png`), Buffer.from(image.split(',')[1], 'base64'));
  for (const [arm, entries] of Object.entries(shaders ?? {})) entries.forEach((code, i) => fs.writeFileSync(path.join(output, `${arm}-${i}.wgsl`), code));
  if (!result.pass || errors.length) throw new Error(JSON.stringify({ result, errors }, null, 2));
} finally {
  await browser?.close();
  // Only remove the exact directory returned by mkdtemp, outside the repo.
  const resolved = path.resolve(profile), temporaryRoot = path.resolve(os.tmpdir());
  if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith('engine-atmosphere-surface-')) throw new Error('Unexpected scratch profile path');
  fs.rmSync(resolved, { recursive: true, force: true });
}
