/**
 * Worker-thread entry point for the interactive line probe (roadmap item 2).
 *
 * `probeAlongPath` awaits meshio++'s barycentric `interpolate`, which is a
 * synchronous wasm call: `await` does not free the thread it runs on, so on the
 * extension host a large probe froze every panel. The providers run it here
 * instead (one worker per request, spawned by src/probeWorkerClient.ts).
 * There is no cooperative cancel — the wasm call cannot be interrupted — so a
 * superseded or abandoned request is cancelled by terminating the thread,
 * which also releases the grown WASM heap.
 *
 * Bundled by esbuild as its own entry (dist/probeWorker.js, beside the wasm
 * loader's `dist/meshio/`). No vscode imports.
 */

import { parentPort } from "node:worker_threads";
import { probeAlongPath, ProbeParams, ProbeResult } from "./parser/pathProbe";
import type { MdpaModel } from "./parser/types";

export type ProbeWorkRequest = { type: "probe"; model: MdpaModel; params: ProbeParams };

export type ProbeWorkResponse =
  | { type: "done"; result: ProbeResult }
  | { type: "error"; message: string };

if (parentPort) {
  const port = parentPort;
  port.on("message", (req: ProbeWorkRequest) => {
    void (async () => {
      try {
        const result = await probeAlongPath(req.model, req.params);
        port.postMessage({ type: "done", result } satisfies ProbeWorkResponse);
      } catch (err) {
        port.postMessage({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        } satisfies ProbeWorkResponse);
      }
    })();
  });
}
