/**
 * The "Kratos" entry view in the Explorer.
 *
 * Deliberately an empty tree: the view exists only so the `viewsWelcome` page
 * in package.json (Open Mesh File… / Load Problem…) has somewhere to render,
 * giving the extension a lateral-bar entry point that works with nothing open.
 * Both buttons reuse the existing `kratos.mesh.open` / `kratos.problem.load`
 * commands verbatim — there is no logic here to test (same arrangement as the
 * vscode-API-only half of `runTreeView.ts`).
 */

import * as vscode from "vscode";

class HomeTreeProvider implements vscode.TreeDataProvider<never> {
  getTreeItem(_element: never): vscode.TreeItem {
    throw new Error("unreachable: the Kratos home view has no items");
  }

  getChildren(_element?: never): Thenable<never[]> {
    return Promise.resolve([]);
  }
}

/** Registers the backing provider; the content comes from `viewsWelcome`. */
export function registerHomeView(): vscode.Disposable {
  return vscode.window.registerTreeDataProvider("kratos.home", new HomeTreeProvider());
}
