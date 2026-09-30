// Browser tests use the production host controller and disk store, with dialog choices supplied by the test.
import { createRequire } from 'node:module';
import Module from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
export async function attachRecordingHost(page, directory) {
  const original = Module._load;
  const dialogs = { cancel: false, badPath: false };
  Module._load = function(name, ...args) {
    if (name === 'vscode') return {
      Uri: { file: fsPath => ({ fsPath }) },
      window: {
        showSaveDialog: async opts => dialogs.cancel ? undefined : { fsPath: path.join(directory, ...(dialogs.badPath ? ['missing'] : []), `animation.${Object.values(opts.filters)[0][0]}`) },
        showOpenDialog: async () => dialogs.cancel ? undefined : [{ fsPath: directory }],
      },
    };
    return original.call(this, name, ...args);
  };
  delete require.cache[require.resolve('../../out/recordingController.js')];
  const { RecordingController } = require('../../out/recordingController.js');
  Module._load = original;
  const controller = new RecordingController(directory, '/test/result.vtu', message => page.evaluate(m => window.postMessage(m, '*'), message).catch(() => {}));
  await page.exposeFunction('recordingHost', message => { if (message.type === 'recording') controller.receive(message); });
  await page.addInitScript(() => { window.HARNESS_POST = message => { if (message.type === 'recording') window.recordingHost(message); }; });
  return { controller, dialogs };
}
