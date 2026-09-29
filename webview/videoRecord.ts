/** Fixed-timing encoding of previously captured, disk-backed frames. */
import workerSource from "./recordEncoder.worker-source";
import { RecordManifest, includedFrames } from "../src/parser/recordSession";
import { RecordingClient } from "./recordingClient";

export function canRecordVideo(): boolean { return typeof VideoEncoder !== "undefined"; }
export async function encodeRecording(client: RecordingClient, manifest: RecordManifest, format: "gif" | "webm", signal: AbortSignal, progress: (done: number, total: number, phase: string) => void): Promise<void> {
  const frames = includedFrames(manifest);
  if (!frames.length) throw new Error("No frames selected.");
  if (format === "gif" && manifest.review.fps > 50) throw new Error("GIF supports at most 50 FPS; lower the playback rate.");
  const url = URL.createObjectURL(new Blob([workerSource], { type: "application/javascript" }));
  const worker = new Worker(url);
  URL.revokeObjectURL(url);
  try {
    await new Promise<void>((resolve, reject) => {
      const cancel = (): void => { worker.terminate(); reject(new Error("Export cancelled; captured frames are retained.")); };
      if (signal.aborted) { cancel(); return; }
      signal.addEventListener("abort", cancel, { once: true });
      const finish = (error?: Error): void => { signal.removeEventListener("abort", cancel); error ? reject(error) : resolve(); };
      worker.onerror = e => finish(new Error(e.message || "Encoder worker failed."));
      worker.onmessage = async event => {
        const m = event.data;
        if (signal.aborted) return;
        try {
          if (m.op === "frame") worker.postMessage({ requestId: m.requestId, result: await client.request<string>({ op: "read", id: manifest.id, index: m.index }) });
          else if (m.op === "chunk") { await client.request({ op: "encodeChunk", data: Array.from(m.data as Uint8Array), position: m.position }); if (!signal.aborted) worker.postMessage({ requestId: m.requestId }); }
          else if (m.op === "progress") progress(m.done, m.total, m.phase);
          else if (m.op === "done") finish();
          else if (m.op === "error") finish(new Error(m.error));
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      };
      worker.postMessage({ op: "start", job: { width: manifest.width, height: manifest.height, indices: frames.map(f => f.index), fps: manifest.review.fps, loop: manifest.review.loop, matte: manifest.review.matte, format } });
    });
  } finally { worker.terminate(); }
}
