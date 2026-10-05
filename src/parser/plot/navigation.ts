/** Verified disk targets and atomic preview handoff. No active-case lookup. */
import * as path from "node:path";
import { findSubModelPart } from "../subModelPartExtract";
import type { MdpaModel } from "../types";
import { emptyPlotRecipe, samePlotSource, validatePlotRecipe } from "./recipe";
import { verifyPlotRun } from "./runs";
import type { PlotOrigin, PlotRunBinding } from "./types";

export interface PlotRunTargetRequest {
  path: string;
  run: PlotRunBinding;
  frameIndex: number;
  entityKind?: PlotOrigin["entityKind"];
  entityId?: number;
  submodelpart?: string;
}
export interface PlotRunTarget {
  request: PlotRunTargetRequest;
  previewPath: string;
  framePath: string;
  frameIndex: number;
  label: string;
  timeline: "files" | "inFile" | "single";
  diagnostics: string[];
}

/** Check an ID only in its original association and frame. This establishes
 * presence, not correspondence between different meshes or remeshed frames. */
export function assertPlotTargetEntity(model: MdpaModel, request: PlotRunTargetRequest): void {
  if (request.entityKind !== undefined || request.entityId !== undefined) {
    const kind = request.entityKind, id = request.entityId;
    if (!["Nodes", "Elements", "Conditions", "Geometries"].includes(kind ?? "") || !Number.isSafeInteger(id)) throw new Error("Navigation needs an explicit entity association and integer ID.");
    const present = kind === "Nodes" ? model.nodeIds.includes(id!) : model.blocks.some(b => b.kind === kind && b.entityIds.includes(id!));
    if (!present) throw new Error(`${kind} ID ${id} is absent from the owning frame; no cross-mesh correspondence is inferred.`);
  }
  if (request.submodelpart !== undefined && (!request.submodelpart.trim() || !findSubModelPart(model, request.submodelpart))) throw new Error("The requested SubModelPart is absent from the owning frame.");
}

/** Shared worker/MCP target resolution; never sends a viewport command. */
export async function resolvePlotRunTarget(request: PlotRunTargetRequest, signal?: AbortSignal): Promise<PlotRunTarget> {
  if(!request?.run || !request.path?.trim())throw new Error("Select a bound disk-run source explicitly.");
  validatePlotRecipe(emptyPlotRecipe({id:"target",type:"mesh",path:request.path,kind:"Nodes",run:request.run}));
  if (!Number.isSafeInteger(request.frameIndex) || request.frameIndex < 0) throw new Error("Select an available integer frame index explicitly.");
  const identity = await verifyPlotRun(request.run, request.path, signal);
  const step = identity.steps.find(s => s.frameIndex === request.frameIndex);
  if (!step?.path) throw new Error("The requested frame is unavailable in the verified source/rank timeline.");
  if (request.entityKind !== undefined || request.entityId !== undefined || request.submodelpart !== undefined) {
    signal?.throwIfAborted();
    assertPlotTargetEntity(await step.load(), request);
  }
  await verifyPlotRun(request.run, request.path, signal);
  signal?.throwIfAborted();
  return {request:{...request,path:path.resolve(request.path)},previewPath:path.resolve(request.path),framePath:path.resolve(step.path),frameIndex:step.frameIndex,label:step.label,timeline:identity.timeline,
    diagnostics:["Verified exact owning source/rank/frame. Entity presence is checked within its original association; no remeshing or cross-run correspondence is inferred."]};
}

/** Providers load off-screen; a failed final check must never adopt a model or
 * publish a selection. The commit itself is synchronous, with no await gap. */
export async function navigatePlotPreview(target: PlotRunTarget, deps: {
  current(): boolean;
  verify(request: PlotRunTargetRequest): Promise<PlotRunTarget>;
  load(target: PlotRunTarget): Promise<MdpaModel>;
  commit(model: MdpaModel, target: PlotRunTarget): void;
}): Promise<void> {
  const guard = () => { if (!deps.current()) throw new Error("Preview changed, is edited/resampled/busy, or navigation was superseded; no sample was selected."); };
  guard();
  if (!samePlotSource(target, await deps.verify(target.request))) throw new Error("Owning navigation target changed; rebind explicitly.");
  guard();
  const model = await deps.load(target);
  guard();
  assertPlotTargetEntity(model, target.request);
  if (!samePlotSource(target, await deps.verify(target.request))) throw new Error("Owning navigation target changed during frame loading; no sample was selected.");
  guard();
  deps.commit(model, target);
}

export interface PlotPreviewNavigator {
  ready: Promise<void>;
  navigate(target: PlotRunTarget, current: () => boolean, signal: AbortSignal): Promise<void>;
}
/** Exact-path routing only. A stale disposal cannot unregister a newer panel. */
export class PlotPreviewRegistry {
  private previews = new Map<string, PlotPreviewNavigator>();
  private listeners = new Set<() => void>();
  register(file: string, preview: PlotPreviewNavigator): () => void {
    const key = path.resolve(file);
    this.previews.set(key, preview);
    for (const notify of [...this.listeners]) notify();
    return () => { if (this.previews.get(key) === preview) this.previews.delete(key); };
  }
  async wait(file: string, signal: AbortSignal, timeoutMs = 30000): Promise<PlotPreviewNavigator> {
    signal.throwIfAborted();
    const key = path.resolve(file);
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, preview?: PlotPreviewNavigator) => {
        clearTimeout(timer); this.listeners.delete(notify); signal.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(preview!);
      };
      const abort = () => finish(new Error("Plot navigation cancelled."));
      const notify = () => { const preview = this.previews.get(key); if (preview) finish(undefined, preview); };
      const timer = setTimeout(() => finish(new Error("The owning preview did not open in time; no active preview was used.")), timeoutMs);
      this.listeners.add(notify); signal.addEventListener("abort", abort, {once:true}); notify();
    });
  }
}
