/**
 * The vscode glue over `recentMeshesCore.ts`: persists the recently-opened mesh
 * list in globalState and drives the `kratos.hasRecentMeshes` context key that
 * shows or hides the sidebar's "Recent Meshes" view.
 *
 * Mirrors how `RunManager` drives `kratos.hasRuns`; every decision worth testing
 * lives in the pure core beside it.
 */

import * as fs from "node:fs";
import * as vscode from "vscode";

import {
  RecentMesh,
  parseRecentList,
  pruneMissing,
  recordRecent,
  removeRecent,
} from "./recentMeshesCore";

const STATE_KEY = "recentMeshes";

export class RecentMeshStore {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * The current list, with vanished files dropped. Pruning on READ rather than
   * on a watcher keeps this free of filesystem monitoring for a list that is
   * only looked at when the view renders — at most `RECENT_CAP` stats.
   */
  list(): RecentMesh[] {
    const stored = parseRecentList(this.context.globalState.get(STATE_KEY));
    const live = pruneMissing(stored, (p) => fs.existsSync(p));
    if (live.length !== stored.length) void this.write(live);
    return live;
  }

  /** Records an open; called by both providers as they resolve an editor. */
  record(fsPath: string): void {
    void this.write(recordRecent(this.list(), fsPath, Date.now()));
  }

  remove(fsPath: string): void {
    void this.write(removeRecent(this.list(), fsPath));
  }

  clear(): void {
    void this.write([]);
  }

  /** Sets the context key so the view can hide itself while the list is empty. */
  syncContext(): void {
    void vscode.commands.executeCommand(
      "setContext",
      "kratos.hasRecentMeshes",
      this.list().length > 0
    );
  }

  private async write(list: RecentMesh[]): Promise<void> {
    await this.context.globalState.update(STATE_KEY, list);
    void vscode.commands.executeCommand(
      "setContext",
      "kratos.hasRecentMeshes",
      list.length > 0
    );
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
