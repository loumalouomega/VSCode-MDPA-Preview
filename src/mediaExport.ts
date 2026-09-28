/** Shared host-side screenshot writer. Recording exports use RecordingController. */
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

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
  try {
    await fs.promises.writeFile(dest.fsPath, decodeDataUrl(dataUrl));
  } catch (err) {
    vscode.window.showErrorMessage(`Could not save screenshot: ${err instanceof Error ? err.message : String(err)}`);
  }
}
