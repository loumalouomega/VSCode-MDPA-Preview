/** Disk-backed recording drafts. Paths are derived from host-generated identifiers. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { CaptureSettings, validateCaptureSize } from "./parser/capturePlan";
import { RecordSettings, frameFileName } from "./parser/recordPlan";
import { RecordManifest, RecordedFrame, RecordReview, includedFrames, validateReview } from "./parser/recordSession";

async function writeSynced(file: string, data: string | Buffer): Promise<void> {
  const handle = await fs.open(file, "w");
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
}

export class RecordingStore {
  constructor(readonly root: string, readonly source: string) {}
  private directory(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid recording identifier.");
    return path.join(this.root, id);
  }
  async load(id: string): Promise<RecordManifest> {
    const m = JSON.parse(await fs.readFile(path.join(this.directory(id), "manifest.json"), "utf8")) as RecordManifest;
    if (m.version !== 1 || m.id !== id || m.source !== this.source) throw new Error("Recording does not belong to this document.");
    return m;
  }
  private async save(m: RecordManifest): Promise<void> {
    const dir = this.directory(m.id);
    await writeSynced(path.join(dir, "manifest.tmp"), JSON.stringify(m, null, 2));
    await fs.rename(path.join(dir, "manifest.tmp"), path.join(dir, "manifest.json"));
  }
  async list(): Promise<RecordManifest[]> {
    await fs.mkdir(this.root, { recursive: true });
    const result: RecordManifest[] = [];
    for (const id of await fs.readdir(this.root)) {
      try { const m = await this.load(id); result.push(m.status === "capturing" ? { ...m, status: "partial", error: "Capture interrupted; completed frames are recoverable." } : m); } catch { /* Other documents or incomplete creation. */ }
    }
    return result.sort((a, b) => b.created.localeCompare(a.created));
  }
  async create(settings: RecordSettings, capture: CaptureSettings, width: number, height: number): Promise<RecordManifest> {
    validateCaptureSize(width, height);
    const m: RecordManifest = { version: 1, id: randomUUID(), source: this.source, created: new Date().toISOString(), status: "capturing", settings, capture, width, height, frames: [], review: { first: 0, last: -1, excluded: [], fps: settings.fps, loop: true, matte: "#ffffff" } };
    await fs.mkdir(this.directory(m.id), { recursive: true });
    await this.save(m);
    return m;
  }
  async append(id: string, frame: Omit<RecordedFrame, "file">, data: string): Promise<number> {
    const m = await this.load(id);
    if (m.status !== "capturing" || frame.index !== m.frames.length) throw new Error("Frame acknowledgement order mismatch.");
    if (!data.startsWith("data:image/png;base64,")) throw new Error("Expected a PNG frame.");
    const bytes = Buffer.from(data.slice(22), "base64");
    if (bytes.length < 24 || bytes.toString("hex", 0, 8) !== "89504e470d0a1a0a" || bytes.readUInt32BE(16) !== m.width || bytes.readUInt32BE(20) !== m.height) throw new Error("PNG dimensions do not match this recording.");
    const file = frameFileName("frame", frame.index, 1_000_000);
    const dest = path.join(this.directory(id), file);
    await writeSynced(`${dest}.tmp`, bytes);
    await fs.rename(`${dest}.tmp`, dest);
    m.frames.push({ ...frame, file });
    m.review.last = frame.index;
    await this.save(m);
    return m.frames.length;
  }
  async finish(id: string, error?: string): Promise<RecordManifest> {
    const m = await this.load(id);
    m.status = error ? "partial" : "complete"; m.error = error;
    await this.save(m); return m;
  }
  async review(id: string, review: RecordReview): Promise<RecordManifest> {
    const m = await this.load(id); m.review = validateReview(review, m.frames.length);
    await this.save(m); return m;
  }
  async read(id: string, index: number): Promise<Buffer> {
    const m = await this.load(id), frame = m.frames[index];
    if (!Number.isInteger(index) || !frame || frame.index !== index || frame.file !== frameFileName("frame", index, 1_000_000)) throw new Error("Unknown frame.");
    return fs.readFile(path.join(this.directory(id), frame.file));
  }
  async discard(id: string): Promise<void> {
    await this.load(id); await fs.rm(this.directory(id), { recursive: true });
  }
  async exportPng(id: string, parent: string, cancelled: () => boolean = () => false, progress: (done: number, total: number) => void = () => {}): Promise<{ destination: string; frames: number; total: number }> {
    const m = await this.load(id), frames = includedFrames(m);
    if (!frames.length) throw new Error("No frames selected.");
    const dir = await fs.mkdtemp(path.join(parent, "recording-"));
    const mapping: Record<string, unknown>[] = [];
    const saveManifest = async (): Promise<void> => fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({
      version: 1, source: m.source, captured: m.created, width: m.width, height: m.height,
      playback: { fps: m.review.fps, loop: m.review.loop, matte: m.review.matte },
      sourceCapture: m.capture, frames: mapping,
      status: mapping.length === frames.length ? "complete" : "partial",
    }, null, 2));
    await saveManifest();
    for (const frame of frames) {
      if (cancelled()) break;
      const file = frameFileName("frame", mapping.length, frames.length);
      await fs.writeFile(path.join(dir, file), await this.read(id, frame.index));
      mapping.push({ ...frame, sourceFile: frame.file, file, timestamp: mapping.length / m.review.fps, duration: 1 / m.review.fps });
      // Update after each frame so cancelled/failed exports remain recoverable.
      await saveManifest();
      progress(mapping.length, frames.length);
    }
    const width = Math.max(4, String(frames.length - 1).length);
    const status = mapping.length === frames.length ? "complete" : "partial";
    await fs.writeFile(path.join(dir, "README.txt"), `${status === "complete" ? "Complete" : "PARTIAL — export stopped early"}: ${mapping.length} of ${frames.length} selected frames.\nPlayback: ${m.review.fps} FPS. Source labels are independent of playback time.\nRun inside this directory (requires an external FFmpeg installation):\nffmpeg -framerate ${m.review.fps} -start_number 0 -i "frame_%0${width}d.png" -c:v libvpx-vp9 "output.webm"\nffmpeg -framerate ${m.review.fps} -start_number 0 -i "frame_%0${width}d.png" -vf "pad=ceil(iw/2)*2:ceil(ih/2)*2" -pix_fmt yuv420p "output.mp4"\n`);
    return { destination: dir, frames: mapping.length, total: frames.length };
  }
}

/** Streaming muxers may rewrite earlier offsets. Never concatenate their chunks. */
export class RecordingOutput {
  private file?: fs.FileHandle;
  private temporary?: string;
  private destination?: string;
  async begin(destination: string): Promise<void> {
    await this.cancel();
    this.destination = destination;
    this.temporary = `${destination}.${randomUUID()}.partial`;
    this.file = await fs.open(this.temporary, "wx");
  }
  async write(data: Uint8Array, position: number): Promise<void> {
    if (!this.file || !Number.isSafeInteger(position) || position < 0 || data.length > 8 * 1024 * 1024) throw new Error("Invalid encoding write.");
    let done = 0;
    while (done < data.length) {
      const { bytesWritten } = await this.file.write(data, done, data.length - done, position + done);
      if (!bytesWritten) throw new Error("Encoding write made no progress.");
      done += bytesWritten;
    }
  }
  async finish(): Promise<string> {
    if (!this.file || !this.temporary || !this.destination) throw new Error("No active export.");
    await this.file.sync(); await this.file.close(); this.file = undefined;
    await fs.rename(this.temporary, this.destination);
    const dest = this.destination; this.temporary = undefined; this.destination = undefined; return dest;
  }
  async cancel(): Promise<void> {
    await this.file?.close(); this.file = undefined;
    if (this.temporary) await fs.rm(this.temporary, { force: true });
    this.temporary = undefined; this.destination = undefined;
  }
}
