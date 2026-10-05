/** UI-only exact-provider routing. Numerical target resolution also serves MCP. */
import * as vscode from "vscode";
import { PlotPreviewRegistry, type PlotRunTarget } from "./parser/plot/navigation";

export const plotPreviews = new PlotPreviewRegistry();

export async function openPlotRunTarget(target: PlotRunTarget, current: () => boolean, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (!current()) return;
  // Install the subscription before opening: resolving the editor can register
  // synchronously. There is no fallback to the currently active case/panel.
  const lifetime = new AbortController(), abort = () => lifetime.abort();
  signal.addEventListener("abort",abort,{once:true});
  try {
    const pending = plotPreviews.wait(target.previewPath, lifetime.signal);
    void pending.catch(() => {});
    await vscode.commands.executeCommand("vscode.openWith",vscode.Uri.file(target.previewPath),target.previewPath.toLowerCase().endsWith(".mdpa")?"kratos.mdpaPreview":"kratos.vtkPreview",vscode.ViewColumn.Beside);
    const preview = await pending;
    await new Promise<void>((resolve,reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer); lifetime.signal.removeEventListener("abort",cancel);
        if(error)reject(error);else resolve();
      };
      const cancel = () => finish(new Error("Plot navigation cancelled."));
      const timer = setTimeout(()=>finish(new Error("The owning preview did not finish loading in time.")),30000);
      lifetime.signal.addEventListener("abort",cancel,{once:true});
      if(lifetime.signal.aborted)cancel();
      void preview.ready.then(()=>finish(),finish);
    });
    signal.throwIfAborted();
    if (current()) await preview.navigate(target,current,lifetime.signal);
  } finally { signal.removeEventListener("abort",abort); lifetime.abort(); }
}
