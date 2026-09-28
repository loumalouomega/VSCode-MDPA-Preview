import * as path from "node:path";
import * as vscode from "vscode";
import { RecordingRequest, RecordingReply } from "./parser/recordSession";
import { RecordingStore, RecordingOutput } from "./recordingStore";

/** One controller per panel; both providers use exactly the same durable protocol. */
export class RecordingController {
  private readonly store: RecordingStore;
  private readonly output = new RecordingOutput();
  private queue: Promise<void> = Promise.resolve();
  private cancelled = false;
  private disposed = false;
  constructor(root: string, private readonly source: string, private readonly post: (message: unknown) => unknown) {
    this.store = new RecordingStore(path.join(root, "recordings"), source);
  }
  receive(message: RecordingRequest): void {
    if (message.command.op === "encodeCancel") this.cancelled = true;
    this.queue = this.queue.then(async () => {
      const reply: RecordingReply = { type: "recordingReply", requestId: message.requestId };
      try {
        if (this.disposed) throw new Error("Recording panel was closed.");
        const c = message.command;
        switch (c.op) {
          case "list": reply.result = await this.store.list(); break;
          case "create": reply.result = await this.store.create(c.settings, c.capture, c.width, c.height); break;
          case "append": reply.result = await this.store.append(c.id, c.frame, c.data); break;
          case "finish": reply.result = await this.store.finish(c.id, c.error); break;
          case "review": reply.result = await this.store.review(c.id, c.review); break;
          case "read": reply.result = `data:image/png;base64,${(await this.store.read(c.id, c.index)).toString("base64")}`; break;
          case "discard": await this.store.discard(c.id); break;
          case "png": {
            this.cancelled = false;
            const folders = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: "Export PNG sequence into a new folder" });
            if (folders?.[0]) {
              const destination = await this.store.exportPng(c.id, folders[0].fsPath, () => this.cancelled || this.disposed, (done, total) => this.post({ type: "recordingProgress", done, total }));
              reply.result = { ...destination, cancelled: this.cancelled };
            } else reply.result = { cancelled: true };
            break;
          }
          case "encodeBegin": {
            await this.store.load(c.id);
            this.cancelled = false;
            const destination = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(this.source.replace(/\.[^.\/\\]+$/, "") + `.${c.format}`), filters: c.format === "gif" ? { GIF: ["gif"] } : { WebM: ["webm"] }, title: "Export animation" });
            if (destination && !this.cancelled) { await this.output.begin(destination.fsPath); reply.result = true; } else reply.result = false;
            break;
          }
          case "encodeChunk": if (this.cancelled) throw new Error("Export cancelled."); await this.output.write(Uint8Array.from(c.data), c.position); break;
          case "encodeEnd": if (this.cancelled) throw new Error("Export cancelled."); reply.result = await this.output.finish(); break;
          case "encodeCancel": await this.output.cancel(); break;
        }
      } catch (error) {
        reply.error = error instanceof Error ? error.message : String(error);
        if (message.command.op.startsWith("encode")) await this.output.cancel().catch(() => {});
      }
      if (!this.disposed) this.post(reply);
    });
  }
  dispose(): void {
    this.disposed = true; this.cancelled = true;
    void this.queue.then(() => this.output.cancel());
  }
}
