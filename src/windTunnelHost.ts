/**
 * Host half of the virtual wind tunnel wizard (webview/windTunnelPanel.ts): it
 * plans and builds a tunnel through the same functions the MCP tools use, so the
 * panel and `wind_tunnel_plan`/`wind_tunnel_generate` cannot disagree. vscode-free
 * — the session injects the dialogs and the way to open the result.
 *
 * Messages (webview → host): `windTunnelHello`, `windTunnelPlan {seq, request}`,
 * `windTunnelRun {seq, request}`, `windTunnelCancel`, `windTunnelPickBody`,
 * `windTunnelPickFolder`, `windTunnelOpen {path}`. Host → webview:
 * `windTunnelState`, `windTunnelPlanResult`, `windTunnelProgress`,
 * `windTunnelResult`, `windTunnelBody`, `windTunnelFolder`.
 *
 * A newer plan supersedes an older one (its reply is never posted); one build
 * runs at a time, and cancelling it stops between steps.
 */

import * as path from "node:path";

import { windTunnelGenerate, windTunnelPlanTool } from "./mcp/tools";
import type { WindTunnelRequest } from "./mcp/tools";
import type { PlotExecution } from "./parser/plot/types";

export interface WindTunnelHostDeps {
  /** The previewed file, offered as the body when it is a surface. */
  fsPath(): string | undefined;
  post(message: Record<string, unknown>): void;
  pickBody(): Promise<string | undefined>;
  pickFolder(defaultFolder?: string): Promise<string | undefined>;
  /** Opens the built mesh in a preview. */
  open(meshPath: string): void;
  /** Overridable for tests; the real functions by default. */
  plan?: (request: WindTunnelRequest, execution: PlotExecution) => Promise<object>;
  generate?: (request: WindTunnelRequest & GenerateExtras, execution: PlotExecution) => Promise<object>;
}

interface GenerateExtras {
  outputFolder: string;
  stem?: string;
  overwrite?: boolean;
  generateCase?: boolean;
}

export interface WindTunnelHost {
  handle(msg: Record<string, unknown>): boolean;
  dispose(): void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const SURFACE_EXTENSIONS = new Set([".stl", ".obj", ".ply", ".off", ".vtp", ".vtk", ".vtu"]);

export function createWindTunnelHost(deps: WindTunnelHostDeps): WindTunnelHost {
  const plan = deps.plan ?? windTunnelPlanTool;
  const generate = deps.generate ?? windTunnelGenerate;
  let planAbort: AbortController | undefined;
  let runAbort: AbortController | undefined;
  let disposed = false;
  const post = (m: Record<string, unknown>): void => {
    if (!disposed) deps.post(m);
  };
  const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
  const seqOf = (msg: Record<string, unknown>): number => (typeof msg.seq === "number" ? msg.seq : 0);

  async function runPlan(msg: Record<string, unknown>): Promise<void> {
    const seq = seqOf(msg);
    if (!isRecord(msg.request)) {
      post({ type: "windTunnelPlanResult", seq, message: "No request." });
      return;
    }
    planAbort?.abort();
    const ctl = new AbortController();
    planAbort = ctl;
    try {
      const result = await plan(msg.request as unknown as WindTunnelRequest, { signal: ctl.signal });
      if (!ctl.signal.aborted) post({ type: "windTunnelPlanResult", seq, plan: result });
    } catch (e) {
      // A superseded plan is never reported, success or failure.
      if (!ctl.signal.aborted) post({ type: "windTunnelPlanResult", seq, message: messageOf(e) });
    }
  }

  async function runBuild(msg: Record<string, unknown>): Promise<void> {
    const seq = seqOf(msg);
    if (runAbort) {
      post({ type: "windTunnelResult", seq, message: "A tunnel is already being built." });
      return;
    }
    if (!isRecord(msg.request)) {
      post({ type: "windTunnelResult", seq, message: "No request." });
      return;
    }
    const ctl = new AbortController();
    runAbort = ctl;
    try {
      const result = (await generate(msg.request as unknown as WindTunnelRequest & GenerateExtras, {
        signal: ctl.signal,
        progress: (done, total, label) => post({ type: "windTunnelProgress", seq, done, total, label }),
      })) as { files?: { mesh?: string } };
      post({ type: "windTunnelResult", seq, result });
      void result;
    } catch (e) {
      const text = messageOf(e);
      post({ type: "windTunnelResult", seq, cancelled: ctl.signal.aborted || text === "cancelled", message: ctl.signal.aborted ? "Cancelled." : text });
    } finally {
      runAbort = undefined;
    }
  }

  return {
    handle(msg) {
      if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("windTunnel")) return false;
      switch (msg.type) {
        case "windTunnelHello": {
          const file = deps.fsPath();
          const surface = file && SURFACE_EXTENSIONS.has(path.extname(file).toLowerCase()) ? file : undefined;
          post({
            type: "windTunnelState",
            bodyPath: surface,
            folder: surface ? path.join(path.dirname(surface), `${path.basename(surface, path.extname(surface))}_tunnel`) : file ? path.dirname(file) : undefined,
            stem: surface ? path.basename(surface, path.extname(surface)).replace(/[^A-Za-z0-9_.-]/g, "_") : undefined,
            building: runAbort !== undefined,
          });
          return true;
        }
        case "windTunnelPlan":
          void runPlan(msg);
          return true;
        case "windTunnelRun":
          void runBuild(msg);
          return true;
        case "windTunnelCancel":
          runAbort?.abort();
          return true;
        case "windTunnelPickBody":
          void deps.pickBody().then((p) => {
            if (p) post({ type: "windTunnelBody", path: p, ...(typeof msg.index === "number" ? { index: msg.index } : {}) });
          });
          return true;
        case "windTunnelPickFolder":
          void deps.pickFolder(typeof msg.folder === "string" ? msg.folder : undefined).then((p) => {
            if (p) post({ type: "windTunnelFolder", path: p });
          });
          return true;
        case "windTunnelOpen":
          if (typeof msg.path === "string" && msg.path) deps.open(msg.path);
          return true;
        default:
          return false;
      }
    },
    dispose() {
      disposed = true;
      planAbort?.abort();
      runAbort?.abort();
    },
  };
}
