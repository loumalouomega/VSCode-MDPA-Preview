/**
 * The two views that make up the Kratos activity-bar container.
 *
 * `kratos.start` is deliberately an always-empty tree: `viewsWelcome` renders
 * only while its view has no children, so the action buttons and the recent-mesh
 * rows cannot share one view — the buttons would disappear the moment a first
 * mesh was remembered. Splitting them is what keeps both permanently visible.
 *
 * `kratos.recentMeshes` is a dumb projection over `recentMeshesCore.ts`, the
 * same rule `runTreeView.ts` follows: this repo has no VS Code integration
 * harness, so every decision worth testing stays below the vscode line.
 */

import * as vscode from "vscode";

import { viewTypeForMesh } from "./meshExport";
import { RecentMeshStore } from "./recentMeshes";
import { RecentMesh, recentDescription, recentLabel } from "./recentMeshesCore";

/** Hosts the welcome buttons; it never has children, by design (see above). */
class StartViewProvider implements vscode.TreeDataProvider<never> {
  getTreeItem(node: never): vscode.TreeItem {
    return node;
  }
  getChildren(): never[] {
    return [];
  }
}

class RecentMeshesProvider implements vscode.TreeDataProvider<RecentMesh> {
  private readonly emitter = new vscode.EventEmitter<RecentMesh | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly store: RecentMeshStore) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(entry: RecentMesh): vscode.TreeItem {
    const item = new vscode.TreeItem(
      recentLabel(entry.path),
      vscode.TreeItemCollapsibleState.None
    );
    // resourceUri gives the row the active file-icon theme's icon for the
    // mesh's extension; the explicit label above still wins for the text.
    item.resourceUri = vscode.Uri.file(entry.path);
    item.description = recentDescription(entry.path, process.env.HOME);
    item.tooltip = entry.path;
    item.contextValue = "kratosRecentMesh";
    item.command = {
      command: "kratos.recent.open",
      title: "Open",
      arguments: [entry],
    };
    return item;
  }

  getChildren(node?: RecentMesh): RecentMesh[] {
    return node ? [] : this.store.list();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** Registers both container views and their commands as one disposable. */
export function registerSidebarViews(store: RecentMeshStore): vscode.Disposable {
  const recents = new RecentMeshesProvider(store);
  const subs: vscode.Disposable[] = [
    vscode.window.createTreeView("kratos.start", {
      treeDataProvider: new StartViewProvider(),
    }),
    vscode.window.createTreeView("kratos.recentMeshes", {
      treeDataProvider: recents,
    }),
    recents,
    store.onDidChange(() => recents.refresh()),
    vscode.commands.registerCommand("kratos.recent.open", (entry?: RecentMesh) => {
      if (!entry) return;
      const uri = vscode.Uri.file(entry.path);
      void vscode.commands.executeCommand(
        "vscode.openWith",
        uri,
        viewTypeForMesh(entry.path)
      );
    }),
    vscode.commands.registerCommand("kratos.recent.remove", (entry?: RecentMesh) => {
      if (entry) store.remove(entry.path);
    }),
    vscode.commands.registerCommand("kratos.recent.clear", () => store.clear()),
  ];
  return vscode.Disposable.from(...subs);
}
