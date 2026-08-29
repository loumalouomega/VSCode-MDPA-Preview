/**
 * Host-side writers for what the viewport produces: screenshots, recorded
 * video, and PNG frame sequences.
 *
 * `saveScreenshot` lived in BOTH providers before this — near-identical, but
 * not byte-identical: the MDPA copy reached `fs` through an inline
 * `require("node:fs")` because that file has no top-level import. The roadmap
 * asked for the hoist once a third copy was forced, and the video counterpart
 * is that third copy.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import { frameFileName } from "./parser/recordPlan";

/** A frame handed over as it was captured, before a destination is chosen. */
export interface PendingFrame {
  index: number;
  total: number;
  dataUrl: string;
}

function decodeDataUrl(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(",");
  return Buffer.from(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl, "base64");
}

function stemOf(sourceFsPath: string): string {
  return path.basename(sourceFsPath, path.extname(sourceFsPath));
}

export async function saveScreenshot(dataUrl: string, sourceFsPath: string): Promise<void> {
  const stem = stemOf(sourceFsPath);
  const dest = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(path.dirname(sourceFsPath), `${stem}.png`)),
    filters: { "PNG Image": ["png"] },
    title: "Save Screenshot",
  });
  if (!dest) return;
  await fs.promises.writeFile(dest.fsPath, decodeDataUrl(dataUrl));
}

/**
 * Saves a recorded video.
 *
 * The bytes arrive as a typed array rather than a base64 data URL — structured
 * clone carries one natively, which skips the 33% inflation the screenshot path
 * pays. Only WebM is offered because MediaRecorder cannot reliably produce
 * H.264 in Electron; the PNG sequence is the route to mp4.
 */
export async function saveVideo(
  data: Uint8Array,
  sourceFsPath: string,
  frames: number
): Promise<void> {
  if (data.byteLength === 0) {
    vscode.window.showWarningMessage("The recording produced no data.");
    return;
  }
  const stem = stemOf(sourceFsPath);
  const dest = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(path.dirname(sourceFsPath), `${stem}.webm`)),
    filters: { "WebM Video": ["webm"] },
    title: "Save Recording",
  });
  if (!dest) return;
  await fs.promises.writeFile(dest.fsPath, data);
  vscode.window.showInformationMessage(
    `Saved ${path.basename(dest.fsPath)} (${frames} frames).`
  );
}

/**
 * Writes a captured PNG sequence into a folder the user picks.
 *
 * One dialog at the end rather than one per frame, and the frames are buffered
 * on this side rather than in the webview — the same total bytes, but held
 * where a few tens of megabytes is unremarkable.
 */
export async function saveFrameSequence(
  frames: PendingFrame[],
  sourceFsPath: string
): Promise<void> {
  if (frames.length === 0) {
    vscode.window.showWarningMessage("The recording produced no frames.");
    return;
  }
  const stem = stemOf(sourceFsPath);
  const picked = await vscode.window.showOpenDialog({
    defaultUri: vscode.Uri.file(path.dirname(sourceFsPath)),
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Save frames here",
    title: `Save ${frames.length} PNG frames`,
  });
  const dir = picked?.[0]?.fsPath;
  if (!dir) return;
  const total = frames.length;
  let written = 0;
  try {
    for (const frame of frames) {
      const name = frameFileName(stem, frame.index, total);
      await fs.promises.writeFile(path.join(dir, name), decodeDataUrl(frame.dataUrl));
      written++;
    }
  } catch (err) {
    vscode.window.showErrorMessage(
      `Wrote ${written} of ${total} frames: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
  // The name pattern is what ffmpeg needs, so say it rather than make them look.
  const width = frameFileName(stem, 0, total).match(/_(\d+)\.png$/)?.[1].length ?? 4;
  vscode.window.showInformationMessage(
    `Saved ${total} frames to ${path.basename(dir)} — ffmpeg -i ${stem}_%0${width}d.png out.mp4`
  );
}
