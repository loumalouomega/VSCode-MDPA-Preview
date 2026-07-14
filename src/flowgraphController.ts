import * as vscode from "vscode";
import * as path from "node:path";
import { fork, type ChildProcess } from "node:child_process";

/**
 * Owns the single, shared Flowgraph static server (dist/flowgraphServer.js).
 *
 * The server is forked lazily on the first `acquire()` and torn down once the
 * last consumer `release()`s it (ref-counted across all preview panels). The
 * webview embeds the editor in an <iframe>; the URL is produced through
 * `vscode.env.asExternalUri` so it also works under Remote-SSH / Codespaces
 * (where the localhost port is tunneled to an https host). One instance is
 * created in `extension.ts` and injected into the MDPA provider.
 */
export interface FlowgraphEndpoint {
  /** Embeddable iframe URL (may be http://localhost:<port> or an https tunnel). */
  url: string;
  /** Its origin, used to validate cross-origin postMessage on both ends. */
  origin: string;
}

export class FlowgraphController {
  private child?: ChildProcess;
  private ready?: Promise<FlowgraphEndpoint>;
  private refs = 0;

  /** Start (if needed) the shared server and return its embeddable endpoint. */
  async acquire(): Promise<FlowgraphEndpoint> {
    this.refs++;
    if (!this.ready) this.ready = this.start();
    try {
      return await this.ready;
    } catch (err) {
      // A failed start shouldn't wedge the refcount or cache the rejection.
      this.release();
      this.ready = undefined;
      throw err;
    }
  }

  /** Drop one consumer; when none remain, stop the server. */
  release(): void {
    if (this.refs > 0) this.refs--;
    if (this.refs === 0) this.stop();
  }

  /** Force teardown (extension deactivate). */
  dispose(): void {
    this.refs = 0;
    this.stop();
  }

  private start(): Promise<FlowgraphEndpoint> {
    // __dirname is dist/ in the bundled extension; the server + assets sit next to it.
    const override = vscode.workspace
      .getConfiguration("kratos.flowgraph")
      .get<string>("assetPathOverride");
    const assetRoot =
      override && override.trim().length > 0
        ? override.trim()
        : path.join(__dirname, "flowgraph");
    const bridgePath = path.join(__dirname, "flowgraph", "vscode-bridge.js");
    const serverPath = path.join(__dirname, "flowgraphServer.js");

    return new Promise<FlowgraphEndpoint>((resolve, reject) => {
      const child = fork(serverPath, [], {
        env: {
          ...process.env,
          FLOWGRAPH_ASSET_ROOT: assetRoot,
          FLOWGRAPH_BRIDGE_PATH: bridgePath,
        },
        // The webview host has no meaningful stdio; silence the child's.
        silent: true,
      });
      this.child = child;

      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      child.on("message", (msg: { type?: string; port?: number; message?: string }) => {
        if (msg?.type === "listening" && typeof msg.port === "number") {
          const local = vscode.Uri.parse(`http://127.0.0.1:${msg.port}`);
          vscode.env.asExternalUri(local).then(
            (external) =>
              done(() =>
                resolve({
                  url: external.toString(),
                  origin: `${external.scheme}://${external.authority}`,
                })
              ),
            (err) => done(() => reject(err))
          );
        } else if (msg?.type === "error") {
          done(() => reject(new Error(msg.message ?? "flowgraph server error")));
        }
      });
      child.on("error", (err) => done(() => reject(err)));
      child.on("exit", (code) =>
        done(() =>
          reject(new Error(`flowgraph server exited before listening (code ${code})`))
        )
      );
    });
  }

  private stop(): void {
    if (this.child) {
      this.child.removeAllListeners();
      this.child.kill();
      this.child = undefined;
    }
    this.ready = undefined;
  }
}
