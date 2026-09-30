import { RecordingCommand, RecordingReply } from "../src/parser/recordSession";

export class RecordingClient {
  private serial = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  constructor(private readonly post: (message: unknown) => void) {}
  request<T = void>(command: RecordingCommand): Promise<T> {
    const requestId = ++this.serial;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, { resolve: value => resolve(value as T), reject });
      this.post({ type: "recording", requestId, command });
    });
  }
  receive(reply: RecordingReply): void {
    const p = this.pending.get(reply.requestId);
    if (!p) return;
    this.pending.delete(reply.requestId);
    if (reply.error) p.reject(new Error(reply.error)); else p.resolve(reply.result);
  }
}
