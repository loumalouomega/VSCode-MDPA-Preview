/**
 * The plan for a recording: which frames to visit, and what to call them.
 *
 * Pure (no vscode/DOM/vtk), because it is the only part of the video recorder
 * that can be unit-tested — `webview/` is not in `tsconfig.test.json`, and
 * MediaRecorder needs a browser. Everything decidable therefore lives here and
 * `webview/videoRecord.ts` stays a loop over what this returns.
 */

/** Where the frames come from. */
export type RecordSource = "timeline" | "turntable";

/** What the recording is saved as. */
export type RecordFormat = "webm" | "png";

export interface RecordSettings {
  source: RecordSource;
  format: RecordFormat;
  /** Playback rate of the produced video, and the pacing of the capture loop. */
  fps: number;
  /** Turntable only: how many frames make up one full revolution. */
  turntableFrames: number;
}

export const DEFAULT_RECORD_SETTINGS: RecordSettings = {
  source: "turntable",
  format: "webm",
  fps: 12,
  turntableFrames: 48,
};

const MIN_FPS = 1;
const MAX_FPS = 60;
const MIN_FRAMES = 2;
const MAX_FRAMES = 720;

export interface TimelineStep {
  kind: "timeline";
  /** The frame index to request from the host. */
  frameIndex: number;
}

export interface TurntableStep {
  kind: "turntable";
  /** Degrees to rotate the camera BEFORE capturing this frame. */
  azimuthDelta: number;
}

export type RecordStep = TimelineStep | TurntableStep;

export interface RecordPlan {
  source: RecordSource;
  format: RecordFormat;
  fps: number;
  steps: RecordStep[];
  /** Milliseconds of video one captured frame represents. */
  frameIntervalMs: number;
  /** Playback duration of the result, in seconds. */
  durationSec: number;
}

export function clampFps(fps: number): number {
  if (!Number.isFinite(fps)) return DEFAULT_RECORD_SETTINGS.fps;
  return Math.min(MAX_FPS, Math.max(MIN_FPS, Math.round(fps)));
}

export function clampFrames(frames: number): number {
  if (!Number.isFinite(frames)) return DEFAULT_RECORD_SETTINGS.turntableFrames;
  return Math.min(MAX_FRAMES, Math.max(MIN_FRAMES, Math.round(frames)));
}

/**
 * Builds the step list.
 *
 * A turntable emits exactly `n` equal rotations of `360/n` degrees, so the last
 * frame lands one step BEFORE the start and the loop closes seamlessly — a
 * frame at both 0° and 360° would show the same image twice and stutter on
 * repeat.
 *
 * A timeline visits every step once, in order. `availableFrames` is the
 * timeline's own length; a series of one (or none) yields an empty plan rather
 * than a one-frame video, and the caller reports that instead of recording.
 */
export function buildRecordPlan(settings: RecordSettings, availableFrames: number): RecordPlan {
  const fps = clampFps(settings.fps);
  const steps: RecordStep[] = [];
  if (settings.source === "timeline") {
    for (let i = 0; i < Math.max(0, Math.floor(availableFrames)); i++) {
      steps.push({ kind: "timeline", frameIndex: i });
    }
    if (steps.length < 2) steps.length = 0;
  } else {
    const n = clampFrames(settings.turntableFrames);
    const delta = 360 / n;
    for (let i = 0; i < n; i++) steps.push({ kind: "turntable", azimuthDelta: delta });
  }
  return {
    source: settings.source,
    format: settings.format,
    fps,
    steps,
    frameIntervalMs: 1000 / fps,
    durationSec: steps.length / fps,
  };
}

/**
 * The file name for one frame of a PNG sequence.
 *
 * Zero-padded to a fixed width so a shell glob and ffmpeg's `%04d` both order
 * them correctly — `_10.png` sorting before `_2.png` is the same lexicographic
 * trap `latestResultFile` exists to avoid.
 */
export function frameFileName(stem: string, index: number, total: number): string {
  const width = Math.max(4, String(Math.max(total - 1, 0)).length);
  return `${stem}_${String(index).padStart(width, "0")}.png`;
}

/** A human summary for the panel, so the cost is visible before starting. */
export function describePlan(plan: RecordPlan): string {
  if (plan.steps.length === 0) return "Nothing to record.";
  const secs = plan.durationSec;
  const pretty = secs < 10 ? secs.toFixed(1) : String(Math.round(secs));
  return `${plan.steps.length} frames · ${pretty}s at ${plan.fps} fps`;
}
