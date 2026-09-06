/**
 * The "Kratos Runs" view.
 *
 * Deliberately a dumb projection: every label, description, icon and context
 * value comes from a pure function in `problemtype/runCore.ts`. That is not
 * style — this repo has no VS Code integration harness, so nothing in this file
 * can be tested, and the mitigation is to keep the decisions in the layer that
 * can be.
 *
 * It is registered TWICE, under two ids: `kratos.runs` in the Explorer (where it
 * has always lived) and `kratos.runsSidebar` in the Kratos activity-bar
 * container. VS Code view ids are globally unique and one view cannot sit in two
 * containers, so two ids over one provider is the only way to show it in both —
 * the provider is not view-bound, so a single `onDidChangeTreeData` drives both.
 *
 * The cost of that is a manifest one: every `menus` entry for a run command must
 * name BOTH ids (`(view == kratos.runs || view == kratos.runsSidebar) && …`, the
 * parentheses required because `&&` binds tighter than `||`), or the sidebar
 * copy silently loses its title buttons and context menu.
 */

import * as path from "node:path";
import * as vscode from "vscode";

import {
  RunRecord,
  isLive,
  displayCommand,
  runContextValue,
  runRowDescription,
  runRowIconId,
  runRowLabel,
} from "./problemtype/runCore";
import { RunManager } from "./runManager";

type Node = { kind: "run"; record: RunRecord } | { kind: "detail"; label: string; icon: string };

class RunTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private ticker: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly runs: RunManager) {}

  refresh(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.emitter.fire(undefined), 250);
    this.syncTicker();
  }

  /** The elapsed column only needs to tick while something is actually live. */
  private syncTicker(): void {
    const live = this.runs.list().some(isLive);
    if (live && !this.ticker) {
      this.ticker = setInterval(() => this.emitter.fire(undefined), 1000);
    } else if (!live && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "detail") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon(node.icon);
      return item;
    }
    const r = node.record;
    const item = new vscode.TreeItem(runRowLabel(r), vscode.TreeItemCollapsibleState.Collapsed);
    item.description = runRowDescription(r, Date.now());
    item.iconPath = new vscode.ThemeIcon(runRowIconId(r));
    item.contextValue = runContextValue(r);
    item.id = r.id;
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${r.stem}** — ${r.status}\n\n`);
    md.appendMarkdown(`\`${displayCommand(r.argv, process.platform)}\`\n\n`);
    md.appendMarkdown(`- folder: \`${r.caseDir}\`\n`);
    if (r.pid !== undefined) md.appendMarkdown(`- pid: ${r.pid}\n`);
    if (r.exitCode !== undefined && r.exitCode !== null) {
      md.appendMarkdown(`- exit code: ${r.exitCode}\n`);
    }
    if (r.message) md.appendMarkdown(`\n${r.message}\n`);
    // Verbatim, and labelled as output rather than as progress — the format is
    // upstream Kratos logging, which we do not parse.
    if (r.progress?.lastLine) md.appendMarkdown(`\nlast output: \`${r.progress.lastLine}\`\n`);
    item.tooltip = md;
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) return this.runs.list().map((record) => ({ kind: "run" as const, record }));
    if (node.kind !== "run") return [];
    const r = node.record;
    const out: Node[] = [
      { kind: "detail", label: `Case folder — ${path.basename(r.caseDir)}`, icon: "folder" },
    ];
    if (r.progress?.fileCount) {
      const step = r.progress.stepLabel ? ` · latest step ${r.progress.stepLabel}` : "";
      out.push({
        kind: "detail",
        label: `Output — ${r.progress.fileCount} files${step}`,
        icon: "graph",
      });
    }
    out.push({ kind: "detail", label: "Log", icon: "output" });
    if (r.status === "failed" && typeof r.exitCode === "number") {
      out.push({ kind: "detail", label: `Exit code ${r.exitCode}`, icon: "error" });
    }
    return out;
  }

  dispose(): void {
    if (this.debounce) clearTimeout(this.debounce);
    if (this.ticker) clearInterval(this.ticker);
    this.emitter.dispose();
  }
}

/** Registers the view and its commands; returns one disposable for them all. */
export function registerRunTreeView(runs: RunManager): vscode.Disposable {
  const provider = new RunTreeProvider(runs);
  const subs: vscode.Disposable[] = [
    vscode.window.createTreeView("kratos.runs", { treeDataProvider: provider }),
    vscode.window.createTreeView("kratos.runsSidebar", { treeDataProvider: provider }),
    provider,
    runs.onDidChange(() => provider.refresh()),
    vscode.commands.registerCommand("kratos.runs.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("kratos.runs.stop", (node?: Node) => {
      const id = node?.kind === "run" ? node.record.id : undefined;
      if (id) void runs.stop(id);
    }),
    vscode.commands.registerCommand("kratos.runs.stopAll", async () => {
      const live = runs.list().filter(isLive);
      if (live.length === 0) return;
      const choice = await vscode.window.showWarningMessage(
        `Stop ${live.length} running solve(s)? Results already written are kept.`,
        { modal: true },
        "Stop all"
      );
      if (choice !== "Stop all") return;
      for (const r of live) await runs.stop(r.id);
    }),
    vscode.commands.registerCommand("kratos.runs.clearFinished", () => runs.clearFinished()),
    vscode.commands.registerCommand("kratos.runs.remove", (node?: Node) => {
      if (node?.kind === "run") runs.remove(node.record.id);
    }),
    vscode.commands.registerCommand("kratos.runs.showLog", (node?: Node) => {
      if (node?.kind === "run") runs.showLog(node.record.id);
    }),
    vscode.commands.registerCommand("kratos.runs.openResults", (node?: Node) => {
      if (node?.kind !== "run") return;
      // A run that did not finish cleanly may have a truncated final step.
      void vscode.commands.executeCommand("kratos.vtk.openLatestResults", node.record.caseDir, {
        excludeNewest: node.record.status !== "finished",
      });
    }),
    vscode.commands.registerCommand("kratos.runs.revealCase", (node?: Node) => {
      if (node?.kind !== "run") return;
      void vscode.commands.executeCommand(
        "revealInExplorer",
        vscode.Uri.file(path.join(node.record.caseDir, "ProjectParameters.json"))
      );
    }),
  ];
  return vscode.Disposable.from(...subs);
}
