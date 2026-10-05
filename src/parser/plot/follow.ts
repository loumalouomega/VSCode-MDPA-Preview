/** Validate an automatic frame update without trusting a webview's reuse claims. */
import type { PlotRecipe } from "./types";

export interface PlotFollowOwner { path: string; frameIndex?: number; timelineId?: string; hasTimeline?: boolean }

/** A retained snapshot must not navigate a replacement timeline with reused IDs. */
export const plotSnapshotOnTimeline = (captured: string | undefined, current: string | undefined): boolean => captured === current;

export function planPlotFollow(previous: PlotRecipe | undefined, next: PlotRecipe, previousTimelineId: string | undefined, owner: PlotFollowOwner | undefined): string[] {
  if (!previous || !owner?.hasTimeline || !owner.timelineId || previousTimelineId !== owner.timelineId) {
    throw new Error("Profile following is paused: collect the plot explicitly on this timeline first.");
  }
  // The provider owns this exact path. Do not resolve it through an active case,
  // infer a run from a directory, or reuse changed source settings.
  const normalized = { ...next, sources: next.sources.map(source => {
    const old = previous.sources.find(s => s.id === source.id);
    if (source.type !== "probe" || !source.followTimeline) return source;
    if (source.run || source.path !== owner.path || source.timeStep !== owner.frameIndex || old?.type !== "probe" || !old.followTimeline) {
      throw new Error(`Source ${source.id}: following requires the owning preview's current frame.`);
    }
    return { ...source, timeStep: old.timeStep };
  }) };
  if (JSON.stringify(normalized) !== JSON.stringify(previous)) {
    throw new Error("Plot settings changed: refresh explicitly before following the timeline.");
  }
  if (!next.sources.some(s => s.type === "probe" && s.followTimeline)) throw new Error("No timeline-following profile is enabled.");
  return next.sources.filter(s => s.type !== "probe" || !s.followTimeline).map(s => s.id);
}
