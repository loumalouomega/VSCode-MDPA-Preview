// Production Record command, controller, disk drafts and worker encoders under the real CSP.
// NODE_PATH=/tmp/mdpa-capture-test/node_modules node scripts/screenshots/check-recording-export.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../vtk-wasm/serve.mjs';
import { attachRecordingHost } from './recording-host.mjs';
import { Input, BufferSource, ALL_FORMATS, EncodedPacketSink } from 'mediabunny';
const require = createRequire(import.meta.url);
const { chromium } = require(`${process.env.NODE_PATH}/playwright-core`);
const server = await startServer(0);
const browser = await chromium.launch({ args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-browser-'));
try {
 for (const renderer of ['vtkjs', 'vtkwasm']) {
  const directory = path.join(root, renderer); await fs.mkdir(directory);
  const out = `out/record-test-${renderer}`;
  const built = spawnSync(process.execPath, ['scripts/screenshots/build-harness.mjs'], { env: { ...process.env, HARNESS_SCENE: 'panefields', HARNESS_CSP: '1', HARNESS_RENDERER: renderer, HARNESS_OUT: out }, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('console', e => { if (e.type() === 'error') console.log(renderer, e.text().slice(0, 300)); });
  const host = await attachRecordingHost(page, directory);
  await page.addInitScript(() => {
    const prior = window.HARNESS_POST;
    window.HARNESS_POST = m => {
      prior(m);
      if (m.type === 'vtkCancelFrame') window.cancelledRequest = window.latestFrameRequest;
      if (m.type !== 'vtkRequestFrame') return;
      window.latestFrameRequest = m.requestId;
      const request = m.requestId;
      setTimeout(() => {
        if (window.cancelledRequest === request) return;
        if (window.FAIL_STEP === m.frameIndex) { window.postMessage({ type: 'vtkFrameError', requestId: request, message: 'Injected missing field/source' }, '*'); return; }
        const revive = v => !v || typeof v !== 'object' ? v : v.__ta ? new self[v.__ta](v.data) : Array.isArray(v) ? v.map(revive) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)]));
        const model = revive(window.HARNESS_MESSAGES.find(x => x.type === 'model').model);
        window.postMessage({ type: 'vtkFrame', requestId: request, frameIndex: m.frameIndex, stepLabel: String(m.frameIndex), totalFrames: 5, model }, '*');
      }, window.FRAME_DELAY ?? (m.frameIndex % 2 ? 700 : 200));
    };
  });
  await page.goto(`${server.origin}/${out}/index.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('#app', { state: 'visible' });
  if (renderer === 'vtkwasm') await page.waitForSelector('#vtk-wasm-canvas');
  await page.waitForTimeout(1000);
  const action = async action => page.evaluate(action => window.postMessage({ type: 'uiAction', action }, '*'), action);
  const control = name => page.locator(`#record-panel [data-record-control="${name}"]`);
  const button = name => page.locator('#record-panel').getByRole('button', { name, exact: true });
  const setNumber = async (name, value) => { await control(name).fill(String(value)); await control(name).dispatchEvent('change'); };
  const setCapture = async (name, value) => page.locator(`#record-panel [data-setting="${name}"]`).evaluate((el, value) => { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); }, String(value));
  await action('record'); await page.waitForSelector('#record-panel', { state: 'visible' });
  await setNumber('Turntable frames', 3);
  await setCapture('resolution', 'custom'); await setCapture('width', 320); await setCapture('height', 240); await setCapture('background', 'transparent'); await setCapture('title', 'Capture test');
  await button('Capture frames').click();
  await page.waitForFunction(() => document.querySelector('#record-panel [role=status]').textContent.includes('Captured 3 frames'));
  await page.waitForSelector('#record-panel img');
  assert.equal(await page.locator('#record-panel img').count(), 1);
  const alpha = await page.locator('#record-panel img').evaluate(async img => { await img.decode(); const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; const x = c.getContext('2d'); x.drawImage(img, 0, 0); const pixels = x.getImageData(0, 0, c.width, c.height).data; return { width: c.width, height: c.height, clear: pixels.filter((v, i) => i % 4 === 3 && v === 0).length, opaque: pixels.filter((v, i) => i % 4 === 3 && v === 255).length }; });
  assert.deepEqual([alpha.width, alpha.height], [320, 240]); assert.ok(alpha.clear > 100); assert.ok(alpha.opaque > 100);
  await control('Export format').selectOption('gif'); await button('Export…').click();
  await page.waitForFunction(() => document.querySelector('#record-panel [role=status]').textContent.includes('Saved '), { timeout: 120000 });
  const gif = await fs.readFile(path.join(directory, 'animation.gif'));
  const decoded = await page.evaluate(async data => {
    const decoder = new ImageDecoder({ data: Uint8Array.from(data), type: 'image/gif' }); await decoder.tracks.ready;
    const result = { count: decoder.tracks.selectedTrack.frameCount, durations: [], dimensions: [] };
    for (let i = 0; i < result.count; i++) { const { image } = await decoder.decode({ frameIndex: i }); result.durations.push(image.duration); result.dimensions.push([image.displayWidth, image.displayHeight]); image.close(); }
    decoder.close(); return result;
  }, Array.from(gif));
  assert.equal(decoded.count, 3); assert.deepEqual(decoded.dimensions[0], [320, 240]); assert.equal(decoded.durations.reduce((a, b) => a + b, 0), 250000);
  await control('Export format').selectOption('webm'); await button('Export…').click();
  await page.waitForFunction(() => /Saved .*webm|unavailable|failed/i.test(document.querySelector('#record-panel [role=status]').textContent), { timeout: 120000 });
  assert.match(await page.locator('#record-panel [role=status]').textContent(), /Saved .*webm/);
  const input = new Input({ source: new BufferSource(await fs.readFile(path.join(directory, 'animation.webm'))), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack(); const packets = new EncodedPacketSink(track); const stamps = [];
  for await (const packet of packets.packets()) stamps.push(packet.timestamp);
  assert.equal(stamps.length, 3); stamps.forEach((t, i) => assert.ok(Math.abs(t - i / 12) < 0.002)); input.dispose();
  await control('Export format').selectOption('gif'); await button('Export…').click();
  await page.waitForFunction(() => document.querySelector('#record-panel [role=status]').textContent.includes('Sampling GIF colors'));
  await button('Cancel').click();
  await page.waitForFunction(() => document.querySelector('#record-panel [role=status]').textContent.includes('cancelled'));
  assert.equal(await fs.readdir(directory).then(files => files.some(f => f.endsWith('.partial'))), false);
  host.dialogs.cancel = true; await button('Export…').click(); await page.waitForFunction(() => document.querySelector('#record-panel [role=status]').textContent.includes('Export cancelled')); host.dialogs.cancel = false;
  host.dialogs.badPath = true; await button('Export…').click(); await page.waitForFunction(() => document.querySelector('#record-panel [role=status]').textContent.includes('ENOENT')); host.dialogs.badPath = false;
  await page.evaluate(() => window.postMessage({ type: 'vtkGroup', group: { steps: ['0', '1', '2', '3', '4'] } }, '*'));
  await button('Close').click(); await action('record');
  await control('Source').selectOption('timeline'); await setNumber('First step', 1); await setNumber('Last step', 4); await setNumber('Stride', 1);
  await button('Capture frames').click(); await page.waitForFunction(() => document.querySelector('#record-panel [role=status]').textContent.includes('Captured 4 frames'));
  const drafts = await fs.readdir(path.join(directory, 'recordings'));
  const manifests = await Promise.all(drafts.map(id => fs.readFile(path.join(directory, 'recordings', id, 'manifest.json'), 'utf8').then(JSON.parse)));
  const timeline = manifests.find(m => m.settings.source === 'timeline'); assert.deepEqual(timeline.frames.map(f => f.sourceIndex), [0, 1, 2, 3]); assert.equal(timeline.review.fps, 12); assert.deepEqual(timeline.frames.map(f => f.label), ["0", "1", "2", "3"]);
  await control('Export format').selectOption('png'); await button('Export…').click(); await page.waitForFunction(() => /Saved PNG sequence/.test(document.querySelector('#record-panel [role=status]').textContent));
  const sequence = await fs.readdir(directory).then(files => files.find(f => f.startsWith('recording-')));
  const sequenceFiles = await fs.readdir(path.join(directory, sequence)); assert.equal(sequenceFiles.filter(f => f.endsWith('.png')).length, 4);
  const sequenceManifest = JSON.parse(await fs.readFile(path.join(directory, sequence, 'manifest.json'), 'utf8')); assert.deepEqual(sequenceManifest.frames.map(f => f.sourceIndex), [0, 1, 2, 3]);
  await control('Export format').selectOption('webm'); await button('Export…').click(); await page.waitForFunction(() => /Saved .*webm/.test(document.querySelector('#record-panel [role=status]').textContent), { timeout: 120000 });
  const timelineVideo = new Input({ source: new BufferSource(await fs.readFile(path.join(directory, 'animation.webm'))), formats: ALL_FORMATS });
  const timelineTrack = await timelineVideo.getPrimaryVideoTrack(), timelinePackets = new EncodedPacketSink(timelineTrack), timelineStamps = [];
  for await (const packet of timelinePackets.packets()) timelineStamps.push(packet.timestamp);
  assert.equal(timelineStamps.length, 4); timelineStamps.forEach((t, i) => assert.ok(Math.abs(t - i / 12) < 0.002)); timelineVideo.dispose();
  // A failed requested source frame must retain already acknowledged frames.
  await page.evaluate(() => { window.FAIL_STEP = 2; });
  await button('Capture frames').click();
  await page.waitForFunction(() => document.querySelector('#record-panel [role=status]').textContent.includes('Injected missing field/source'));
  const failedDrafts = await fs.readdir(path.join(directory, 'recordings'));
  const failedManifests = await Promise.all(failedDrafts.map(id => fs.readFile(path.join(directory, 'recordings', id, 'manifest.json'), 'utf8').then(JSON.parse)));
  const partial = failedManifests.find(m => m.status === 'partial'); assert.equal(partial.frames.length, 2); assert.match(partial.error, /Injected missing field/);
  await page.evaluate(() => { window.FAIL_STEP = undefined; });
  // Cancellation while waiting on a slow frame, then a fresh restoration request.
  await page.evaluate(() => { window.FRAME_DELAY = 1200; });
  await button('Capture frames').click(); await page.waitForTimeout(200); await button('Cancel').click();
  await page.waitForFunction(() => document.querySelector('#record-panel .meshsize-header').textContent.includes('Review'));
  assert.match(await page.locator('#record-panel [role=status]').textContent(), /cancelled/i);
  assert.deepEqual(errors, []);
  host.controller.dispose(); await page.close(); console.log(`${renderer}: capture, GIF/WebM, delayed timeline, save errors and cancellation passed`);
 }
 console.log(`Artifacts: ${root}`);
} finally { await browser.close(); await server.close(); }
