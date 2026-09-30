/** Dedicated, offline encoder worker. Exactly one decoded frame and one write await acknowledgement. */
import { GIFEncoder, quantize, applyPalette } from "gifenc";
import { Output, WebMOutputFormat, StreamTarget, CanvasSource, canEncodeVideo } from "mediabunny";
import { gifDelayMs } from "../src/parser/recordSession";

interface Job { width: number; height: number; indices: number[]; fps: number; loop: boolean; matte: string; format: "gif" | "webm" }
const worker = globalThis as unknown as { postMessage(message: unknown, transfer?: Transferable[]): void; onmessage: ((event: MessageEvent) => void) | null };
let serial = 0;
const pending = new Map<number, { resolve(value: string): void; reject(error: Error): void }>();
function request(op: "frame" | "chunk", args: object, transfer?: Transferable[]): Promise<string> {
  const requestId = ++serial;
  return new Promise((resolve, reject) => { pending.set(requestId, { resolve, reject }); worker.postMessage({ op, requestId, ...args }, transfer); });
}
async function write(bytes: Uint8Array, position: number): Promise<void> {
  // Keep message size bounded even when a single GIF frame compresses poorly.
  for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
    const data = bytes.slice(offset, offset + 1024 * 1024);
    await request("chunk", { data, position: position + offset }, [data.buffer]);
  }
}
async function encode(job: Job): Promise<void> {
  const canvas = new OffscreenCanvas(job.width, job.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: job.format === "gif", alpha: false });
  if (!ctx) throw new Error("Cannot create encoding canvas.");
  async function frame(index: number): Promise<void> {
    const data = await request("frame", { index });
    const binary = atob(data.slice(data.indexOf(",") + 1));
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    try {
      if (bitmap.width !== job.width || bitmap.height !== job.height) throw new Error("Stored frame dimensions changed.");
      ctx!.fillStyle = job.matte; ctx!.fillRect(0, 0, job.width, job.height);
      ctx!.drawImage(bitmap, 0, 0);
    } finally { bitmap.close(); }
  }
  let output: Output | undefined;
  try {
    if (job.format === "gif") {
      // At most 32 x 128 x 128 pixels, distributed across the selected sequence.
      const sampleCount = Math.min(32, job.indices.length);
      const small = new OffscreenCanvas(128, 128), sampleCtx = small.getContext("2d", { willReadFrequently: true })!;
      const samples = new Uint8Array(sampleCount * 128 * 128 * 4);
      for (let i = 0; i < sampleCount; i++) {
        await frame(job.indices[Math.round(i * (job.indices.length - 1) / Math.max(1, sampleCount - 1))]);
        sampleCtx.drawImage(canvas, 0, 0, 128, 128);
        samples.set(sampleCtx.getImageData(0, 0, 128, 128).data, i * 128 * 128 * 4);
        worker.postMessage({ op: "progress", done: i + 1, total: sampleCount, phase: "Sampling GIF colors" });
      }
      const palette = quantize(samples, 256), gif = GIFEncoder({ auto: false });
      let position = 0;
      for (let i = 0; i < job.indices.length; i++) {
        await frame(job.indices[i]);
        if (i === 0) gif.writeHeader();
        gif.writeFrame(applyPalette(ctx.getImageData(0, 0, job.width, job.height).data, palette), job.width, job.height, { first: i === 0, palette: i === 0 ? palette : undefined, delay: gifDelayMs(i, job.fps), repeat: job.loop ? 0 : -1, dispose: 1 });
        const bytes = gif.bytesView(); await write(bytes, position); position += bytes.length; gif.reset();
        worker.postMessage({ op: "progress", done: i + 1, total: job.indices.length, phase: "Encoding GIF" });
      }
      gif.finish(); await write(gif.bytesView(), position);
    } else {
      let codec: "vp9" | "vp8" | undefined;
      for (const candidate of ["vp9", "vp8"] as const) {
        if (await canEncodeVideo(candidate, { width: job.width, height: job.height, frameRate: job.fps })) { codec = candidate; break; }
      }
      if (!codec) throw new Error("WebM encoding is unavailable at this resolution. Export GIF or PNG frames instead.");
      output = new Output({ format: new WebMOutputFormat(), target: new StreamTarget(new WritableStream({ write: chunk => write(chunk.data, chunk.position) }), { chunked: true, chunkSize: 1024 * 1024 }) });
      const source = new CanvasSource(canvas, { codec, bitrate: Math.max(1_000_000, Math.min(20_000_000, job.width * job.height * job.fps * 0.2)) });
      output.addVideoTrack(source, { frameRate: job.fps });
      await output.start();
      for (let i = 0; i < job.indices.length; i++) {
        await frame(job.indices[i]);
        await source.add(i / job.fps, 1 / job.fps);
        worker.postMessage({ op: "progress", done: i + 1, total: job.indices.length, phase: "Encoding WebM" });
      }
      source.close(); await output.finalize();
    }
    worker.postMessage({ op: "done" });
  } catch (error) {
    await output?.cancel().catch(() => {});
    throw error;
  } finally { canvas.width = 0; canvas.height = 0; }
}
worker.onmessage = event => {
  const m = event.data;
  if (m.op === "start") void encode(m.job).catch(error => worker.postMessage({ op: "error", error: String(error) }));
  else {
    const p = pending.get(m.requestId); if (!p) return; pending.delete(m.requestId);
    if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
  }
};
