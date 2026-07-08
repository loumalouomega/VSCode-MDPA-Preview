/**
 * Worker-thread entry point for the MMG operations. The remesher is a
 * synchronous C call — run on the extension-host thread it would freeze the
 * whole host for the duration — so the providers execute it here instead
 * (spawned per run by src/mmgWorkerClient.ts, which also implements
 * cancellation by terminating the worker). One request per worker instance;
 * MMG's WASM heap is released with the thread.
 *
 * Bundled by esbuild as its own entry (dist/mmgWorker.js) next to
 * dist/mmg-core.wasm. No vscode imports.
 */

import { parentPort } from "node:worker_threads";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  configureMmg,
  remeshModel,
  levelsetModel,
  RemeshParams,
  LevelsetParams,
} from "./parser/remesh";
import type { MmgWorkRequest, MmgWorkResponse } from "./mmgWorkerClient";

// Same wasm injection as extension.ts — the Emscripten loader cannot locate
// the binary once mmg.cjs is bundled. Plain Node (tests) self-resolves.
try {
  configureMmg({ wasmBinary: fs.readFileSync(path.join(__dirname, "mmg-core.wasm")) });
} catch {
  /* unbundled layout — the package finds its own wasm */
}

if (parentPort) {
  const port = parentPort;
  const post = (msg: MmgWorkResponse) => port.postMessage(msg);
  port.on("message", (req: MmgWorkRequest) => {
    void (async () => {
      try {
        const onProgress = (message: string) => post({ type: "progress", message });
        const result =
          req.op === "remesh"
            ? await remeshModel(req.model, req.params as RemeshParams, onProgress)
            : await levelsetModel(req.model, req.params as LevelsetParams, onProgress);
        post({ type: "done", result });
      } catch (err) {
        post({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
    })();
  });
}
