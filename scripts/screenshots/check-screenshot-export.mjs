// Actual Screenshot command -> preview -> exported PNG, on both backends.
// npm run compile && npm run build:tests
// NODE_PATH=/tmp/mdpa-capture-test/node_modules node scripts/screenshots/check-screenshot-export.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { startServer } from '../vtk-wasm/serve.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(`${process.env.NODE_PATH}/playwright-core`);
const server = await startServer(0);

const browser = await chromium.launch({ args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
 for (const renderer of ['vtkjs', 'vtkwasm']) {
  const out = `out/capture-test-${renderer}`;
  const built = spawnSync(process.execPath, ['scripts/screenshots/build-harness.mjs'], { env: { ...process.env, HARNESS_SCENE: 'panefields', HARNESS_CSP: '1', HARNESS_RENDERER: renderer, HARNESS_OUT: out }, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', e => { if (e.type() === 'warning') console.log(renderer, e.text().slice(0, 300)); });
  await page.goto(`${server.origin}/${out}/index.html`);
  await page.waitForSelector('#app', { state: 'visible' });
  if (renderer === 'vtkwasm') await page.waitForSelector('#vtk-wasm-canvas');
  await page.waitForTimeout(1500);
  const action = async action => { await page.evaluate(action => window.postMessage({ type: 'uiAction', action }, '*'), action); await page.waitForTimeout(150); };
  await page.evaluate(() => window.postMessage({ type: 'takeScreenshot' }, '*'));
  await page.waitForSelector('#screenshot-panel img');
  const set = async (key, value) => {
   await page.locator(`#screenshot-panel [data-setting="${key}"]`).evaluate((el, value) => {
    if (el.type === 'checkbox') el.checked = value; else el.value = String(value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
   }, value);
  };
  const refresh = async () => { await page.locator('#screenshot-panel').evaluate(panel => [...panel.querySelectorAll('button')].find(b => b.textContent === 'Refresh Preview').click()); await page.waitForSelector('#screenshot-panel img'); };
  const pixels = async () => page.$eval('#screenshot-panel img', async img => {
    await img.decode(); const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0); const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let clear = 0, opaque = 0, partial = 0; for (let i = 3; i < data.length; i += 4) { if (!data[i]) clear++; else if (data[i] === 255) opaque++; else partial++; }
    return { width: c.width, height: c.height, clear, opaque, partial, src: img.src };
  });
  const originalSize = await page.$eval('#render-root canvas', c => [c.width, c.height]);
  await set('resolution', 'custom'); await set('width', 800); await set('height', 600);
  await set('background', 'transparent'); await refresh();
  const alpha = await pixels();
  console.log(renderer, { ...alpha, src: undefined });
  assert.deepEqual([alpha.width, alpha.height], [800, 600]);
  assert.ok(alpha.clear > 1000, 'transparent background'); assert.ok(alpha.opaque > 100, 'nonblank geometry'); assert.ok(alpha.partial > 0, 'antialias alpha');
  assert.deepEqual(await page.$eval('#render-root canvas', c => [c.width, c.height]), originalSize);
  await page.locator('#screenshot-panel').evaluate(panel => [...panel.querySelectorAll('button')].find(b => b.textContent === 'Save PNG…').click());
  assert.equal(await page.evaluate(() => window.SENT_MESSAGES.filter(m => m.type === 'screenshot').at(-1).data), alpha.src);
  await set('title', 'Field export'); assert.equal(await page.locator('#screenshot-panel img').count(), 0);
  await set('caption', 'Run A\nSecond line'); await refresh(); assert.notEqual((await pixels()).src, alpha.src);
  await action('layout:1x2');
  assert.equal(await page.locator('#screenshot-panel img').count(), 0, 'view change invalidates preview');
  await set('scope', 'focused'); await refresh(); assert.equal((await pixels()).width, 800);
  await set('width', 8192); await set('height', 8192);
  await page.locator('#screenshot-panel').evaluate(panel => [...panel.querySelectorAll('button')].find(b => b.textContent === 'Refresh Preview').click());
  assert.match(await page.locator('#screenshot-panel [role=status]').textContent(), /limit/);
  await set('width', 800); await set('height', 600); await refresh();
  assert.deepEqual(errors, []);
  await page.close();
  console.log(`${renderer}: screenshot checks passed`);
 }
} finally { await browser.close(); await server.close(); }
