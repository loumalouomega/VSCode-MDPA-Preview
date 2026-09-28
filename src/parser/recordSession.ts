/** Wire-safe recording metadata. Frame bytes are never retained in manifests. */
import { CaptureSettings } from "./capturePlan";
import { RecordSettings, clampFps } from "./recordPlan";

export interface RecordedFrame {
  index: number;
  file: string;
  sourceIndex?: number;
  label: string;
  labelKind: "time" | "step";
  timeUnit?: string;
}
export interface RecordReview {
  first: number;
  last: number;
  excluded: number[];
  fps: number;
  loop: boolean;
  matte: string;
}
export interface RecordManifest {
  version: 1;
  id: string;
  source: string;
  created: string;
  status: "capturing" | "complete" | "partial";
  settings: RecordSettings;
  capture: CaptureSettings;
  width: number;
  height: number;
  frames: RecordedFrame[];
  review: RecordReview;
  error?: string;
}
export function includedFrames(manifest: Pick<RecordManifest, "frames" | "review">): RecordedFrame[] {
  const { first, last, excluded } = manifest.review;
  const skip = new Set(excluded);
  return manifest.frames.filter(f => f.index >= first && f.index <= last && !skip.has(f.index));
}
export function validateReview(review: RecordReview, count: number): RecordReview {
  if (!Number.isInteger(review.first) || !Number.isInteger(review.last) || review.first < 0 || review.last >= count || review.last < review.first) throw new Error("Invalid trim range.");
  if (!/^#[0-9a-f]{6}$/i.test(review.matte)) throw new Error("Invalid matte color.");
  return { ...review, fps: clampFps(review.fps), excluded: [...new Set(review.excluded)].filter(i => Number.isInteger(i) && i >= 0 && i < count) };
}
/** Rounded boundaries avoid accumulating centisecond drift in GIF playback. */
export function gifDelayMs(index: number, fps: number): number {
  const rate = Math.min(50, clampFps(fps));
  return (Math.round((index + 1) * 100 / rate) - Math.round(index * 100 / rate)) * 10;
}
export type RecordingCommand =
  | { op: "list" }
  | { op: "create"; settings: RecordSettings; capture: CaptureSettings; width: number; height: number }
  | { op: "append"; id: string; data: string; frame: Omit<RecordedFrame, "file"> }
  | { op: "finish"; id: string; error?: string }
  | { op: "review"; id: string; review: RecordReview }
  | { op: "read"; id: string; index: number }
  | { op: "discard"; id: string }
  | { op: "png"; id: string }
  | { op: "encodeBegin"; id: string; format: "gif" | "webm" }
  | { op: "encodeChunk"; data: number[]; position: number }
  | { op: "encodeEnd" }
  | { op: "encodeCancel" };
export interface RecordingRequest { type: "recording"; requestId: number; command: RecordingCommand }
export interface RecordingReply { type: "recordingReply"; requestId: number; result?: unknown; error?: string }
