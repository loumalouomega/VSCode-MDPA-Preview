// Interactive smoke check using the real webview bundle and real PLY readers.
// This supplies a small host bridge; it is not a VS Code integration harness.
// Requires `npm run compile`, `npm run build:tests`, and playwright-core via
// NODE_PATH. Optionally set CHROMIUM_PATH to an existing Chromium executable.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { discoverSeriesSteps } = require(path.join(root, 'out/parser/fieldSeriesScan'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timeline-ui-'));
const meshPath = path.join(dir, 'Heat_0_2.ply');
function write(step) {
  fs.writeFileSync(path.join(dir, `Heat_0_${step}.ply`), `ply
format ascii 1.0
element vertex 3
property float x
property float y
property float z
property float TEMP
element face 1
property list uchar int vertex_indices
end_header
0 0 0 ${step}
1 0 0 ${step}
0 1 0 ${step}
3 0 1 2
`);
}
let browser;
let watcher;
try {
  write(2); write(10);
  execFileSync(process.execPath, ['scripts/screenshots/build-harness.mjs'], {
    cwd: root, env: { ...process.env, HARNESS_MESH: meshPath }, stdio: 'inherit',
  });
  const harness = path.join(root, 'out/screenshot-harness/index.html');
  fs.writeFileSync(harness, fs.readFileSync(harness, 'utf8').replace('postMessage() {}', 'postMessage(msg) { window.__host?.(msg); }'));
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  const requests = [];
  page.on('pageerror', e => errors.push(e.message));
  let steps = (await discoverSeriesSteps(meshPath)).steps;
  const send = async message => {
    const json = JSON.stringify(message, (_k, v) => ArrayBuffer.isView(v) ? { __ta: v.constructor.name, data: [...v] } : v);
    await page.evaluate(json => {
      const msg = JSON.parse(json, (_k, v) => v?.__ta ? new window[v.__ta](v.data) : v);
      window.postMessage(msg, '*');
    }, json);
  };
  const frame = async index => {
    const step = steps[index];
    const model = await step.load();
    assert.equal(model.fields.find(f => f.variable === 'TEMP').values[0], Number(step.label));
    await send({ type: 'vtkFrame', model, fileName: `Heat_0_${step.label}.ply`, frameIndex: index, stepLabel: step.label, totalFrames: steps.length });
  };
  await page.exposeFunction('__host', async msg => {
    if (msg.type === 'vtkRequestFrame') {
      requests.push(msg.frameIndex);
      try { await frame(msg.frameIndex); } catch (e) { errors.push(e.message); }
    }
  });
  await page.goto(`file://${harness}`);
  await page.waitForSelector('#app', { state: 'visible' });
  const announce = () => send({ type: 'vtkGroup', fileName: path.basename(meshPath), group: {
    modelPartName: 'Heat', steps: steps.map(s => s.label), subParts: [], ranks: [0],
  } });
  await announce(); await frame(0);
  await page.waitForFunction(() => document.querySelector('#tl-label')?.textContent.includes('Step 2'));
  await page.click('#tl-next');
  await page.waitForFunction(() => document.querySelector('#tl-label')?.textContent.includes('Step 10'));
  await page.locator('#tl-scrub').evaluate(el => { el.value = '0'; el.dispatchEvent(new Event('input')); });
  await page.waitForFunction(() => document.querySelector('#tl-label')?.textContent.includes('Step 2'));
  await page.click('#tl-play');
  await page.waitForFunction(() => document.querySelector('#tl-label')?.textContent.includes('Step 10'));
  assert.deepEqual(requests.slice(0, 3), [1, 0, 1]);
  // Simulate the provider's directory notification using a real filesystem
  // watcher, then rediscover through the same pure helper as the MCP/provider.
  const changed = new Promise(resolve => { watcher = fs.watch(dir, (_event, name) => {
    if (name === 'Heat_0_20.ply') resolve();
  }); });
  write(20);
  await Promise.race([changed, new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No file notification')), 5000);
    timer.unref();
  })]);
  watcher.close(); watcher = undefined;
  steps = (await discoverSeriesSteps(meshPath)).steps;
  assert.deepEqual(steps.map(s => s.label), ['2', '10', '20']);
  await announce(); await frame(1);
  await page.waitForFunction(() => document.querySelector('#tl-scrub')?.max === '2');
  await page.click('#tl-next');
  await page.waitForFunction(() => document.querySelector('#tl-label')?.textContent.includes('Step 20'));
  assert.deepEqual(errors, []);
  console.log('PASS: PLY frame selection, scrub, playback and newly arriving step; no page errors.');
} finally {
  watcher?.close();
  await browser?.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
