/**
 * Recording the viewport to a video (or a PNG sequence).
 *
 * **The capture surface is an offscreen 2D canvas, not the WebGL canvas.** The
 * renderer cannot preserve its drawing buffer between tasks, so each frame is
 * rendered and copied synchronously by the shared screenshot compositor before
 * the video stream or PNG writer receives it. The copy also carries pane
 * legends and separators, avoiding a PNG encode/decode round trip.
 *
 * Timeline frames may require an asynchronous host-side reload. `captureStream(0)`
 * with `requestFrame()` gives each completed render exactly one encoded frame,
 * instead of racing a timer against file parsing and the browser compositor.
 *
 * One CSP note, since it bites the obvious code: the webview runs under
 * `default-src 'none'` with no `connect-src`, so `fetch(blobUrl)` is BLOCKED.
 * Use `blob.arrayBuffer()`.
 */

import { RecordPlan, RecordStep } from "../src/parser/recordPlan";

export interface RecordHooks {
  /** The live WebGL canvas to copy from. */
  canvas(): HTMLCanvasElement;
  /** Render, copy and decorate a complete frame synchronously. */
  capture(ctx: CanvasRenderingContext2D): void;
  /** Move to a timeline frame and resolve once it is actually on screen. */
  goToFrame(frameIndex: number): Promise<void>;
  /** Rotate the camera for a turntable tick (does not render). */
  rotate(degrees: number): void;
  onProgress(done: number, total: number): void;
  /** True while the user has not cancelled. */
  shouldContinue(): boolean;
}

export interface RecordResult {
  format: "webm" | "png";
  /** webm only: the encoded file. */
  video?: Uint8Array;
  mimeType?: string;
  /** Frames actually captured. */
  frames: number;
  cancelled: boolean;
  message?: string;
}

/** Preference order. H.264/mp4 is deliberately absent — MediaRecorder cannot
 *  reliably produce it in Electron, so the PNG sequence is the mp4 answer. */
const MIME_CANDIDATES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

export function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
}

/** Whether this environment can produce a video at all. */
export function canRecordVideo(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function" &&
    pickMimeType() !== undefined
  );
}

function makeSurface(source: HTMLCanvasElement): {
  surface: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} {
  const surface = document.createElement("canvas");
  surface.width = source.width;
  surface.height = source.height;
  const ctx = surface.getContext("2d");
  if (!ctx) throw new Error("Could not create a 2D canvas to record into.");
  return { surface, ctx };
}

/**
 * Puts the scene in the state one step describes, then copies it.
 *
 * The two statements at the end must stay adjacent and synchronous — see the
 * module header. Anything inserted between them (an await, a timer, a
 * postMessage) captures a blank frame.
 */
async function captureStep(
  step: RecordStep,
  hooks: RecordHooks,
  ctx: CanvasRenderingContext2D,
): Promise<void> {
  if (step.kind === "timeline") {
    await hooks.goToFrame(step.frameIndex);
  } else {
    hooks.rotate(step.azimuthDelta);
  }
  hooks.capture(ctx);
}

/**
 * Runs a recording to completion (or cancellation).
 *
 * `onFrame` is called per captured frame for the PNG path, so frames leave the
 * webview as they are made rather than accumulating there. They are identified
 * by index; naming is the host's job, since only it knows the file path.
 */
export async function runRecording(
  plan: RecordPlan,
  hooks: RecordHooks,
  onFrame?: (index: number, total: number, dataUrl: string) => void
): Promise<RecordResult> {
  if (plan.steps.length === 0) {
    return { format: plan.format, frames: 0, cancelled: false, message: "Nothing to record." };
  }
  const { surface, ctx } = makeSurface(hooks.canvas());

  if (plan.format === "png") {
    let done = 0;
    for (const step of plan.steps) {
      if (!hooks.shouldContinue()) break;
      await captureStep(step, hooks, ctx);
      // Handed over as it is captured rather than accumulated: the webview
      // never holds the whole sequence, and the host writes them at the end.
      onFrame?.(done, plan.steps.length, surface.toDataURL("image/png"));
      hooks.onProgress(++done, plan.steps.length);
      // Yield so the cancel button can be clicked and the UI can repaint.
      await new Promise((r) => setTimeout(r, 0));
    }
    return { format: "png", frames: done, cancelled: done < plan.steps.length };
  }

  const mimeType = pickMimeType();
  if (!mimeType) {
    return {
      format: "webm",
      frames: 0,
      cancelled: false,
      message: "This environment cannot encode video. Record a PNG sequence instead.",
    };
  }
  // A zero frame rate makes the stream driven ENTIRELY by requestFrame(), which
  // is what a per-frame disk re-parse needs: real-time capture would record
  // whatever happened to be on screen when the clock ticked.
  const stream = surface.captureStream(0);
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });
  recorder.start();

  let done = 0;
  for (const step of plan.steps) {
    if (!hooks.shouldContinue()) break;
    await captureStep(step, hooks, ctx);
    track.requestFrame();
    hooks.onProgress(++done, plan.steps.length);
    // One interval per frame: the stream has no clock of its own, so this is
    // what gives the encoder the pacing the playback rate implies.
    await new Promise((r) => setTimeout(r, plan.frameIntervalMs));
  }
  recorder.stop();
  await stopped;
  stream.getTracks().forEach((t) => t.stop());

  const blob = new Blob(chunks, { type: mimeType });
  // NOT fetch(URL.createObjectURL(blob)) — the webview CSP has no connect-src,
  // so that is blocked outright.
  const video = new Uint8Array(await blob.arrayBuffer());
  return {
    format: "webm",
    video,
    mimeType,
    frames: done,
    cancelled: done < plan.steps.length,
  };
}
