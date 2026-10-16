/**
 * Host half of the Optimization progress panel (webview/optimizationPanel.ts):
 * finds the optimization case a preview belongs to, reads its summary through
 * the same reader the Kratos Runs row and MCP `case_optimization` use, and
 * posts what it found. vscode-free — the session injects the few things that
 * need VS Code (opening the plot builder, opening the design fields).
 *
 * Messages (webview → host): `optimizationProgressRequest` (start following and
 * post now), `optimizationProgressStop`, `optimizationPlot`,
 * `optimizationDesignFields`. Host → webview: `optimizationProgress`.
 */

import * as path from "node:path";

import {
  boundRows,
  optimizationFormulation,
  optimizationPlotRecipe,
  summarizeOptimization,
} from "./problemtype/optimization/summaryLog";
import { findOptimizationCase, readOptimization } from "./problemtype/optimization/summaryLogFile";
import type { PlotRecipe } from "./parser/plot/types";

/** Rows the panel receives at most (the newest); the plot and CSV use the whole file. */
export const PANEL_ROW_LIMIT = 200;

export interface OptimizationHostDeps {
  /** The previewed file, or undefined before one is bound. */
  fsPath(): string | undefined;
  post(message: Record<string, unknown>): void;
  /** The latest run's status for a case folder, when one is known. */
  runStatus(caseDir: string): string | undefined;
  openPlot(recipe: PlotRecipe, title: string): void;
  openDesignFields(caseDir: string, folder: string, excludeNewest: boolean): void;
  exportCad(caseDir: string, excludeNewest: boolean): void;
  /** Shown when a request cannot be honoured (no case, no rows). */
  info(message: string): void;
}

export interface OptimizationHost {
  /** Routes one `optimization*` message; false for any other. */
  handle(msg: Record<string, unknown>): boolean;
  /** Re-posts while the panel follows the case (a run changed, a file was written). */
  refreshIfWatched(): void;
}

export function createOptimizationProgressHost(deps: OptimizationHostDeps): OptimizationHost {
  let watched = false;
  const caseDir = (): string | undefined => {
    const file = deps.fsPath();
    return file ? findOptimizationCase(file) : undefined;
  };
  const postProgress = (): void => {
    const dir = caseDir();
    if (!dir) {
      deps.post({ type: "optimizationProgress", available: false, reason: "This preview is not part of an optimization case: generate one with the Structural Optimization problemtype." });
      return;
    }
    const read = readOptimization(dir);
    const status = deps.runStatus(dir);
    const summary = read.parsed && read.info ? summarizeOptimization(read.parsed, read.info, status) : undefined;
    deps.post({
      type: "optimizationProgress",
      available: read.available,
      caseName: path.basename(dir),
      reason: read.reason,
      formulation: read.info ? optimizationFormulation(read.info) : undefined,
      designFields: read.info?.designFieldsFolder !== undefined,
      summary,
      columns: read.parsed?.columns ?? [],
      rows: read.parsed ? boundRows(read.parsed, PANEL_ROW_LIMIT) : [],
      totalRows: read.parsed?.rows.length ?? 0,
      warnings: read.parsed?.warnings ?? [],
    });
  };
  return {
    handle(msg) {
      if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("optimization")) return false;
      switch (msg.type) {
        case "optimizationProgressRequest":
          watched = true;
          postProgress();
          return true;
        case "optimizationProgressStop":
          watched = false;
          return true;
        case "optimizationPlot": {
          const dir = caseDir();
          const read = dir ? readOptimization(dir) : undefined;
          if (!dir || !read?.parsed || !read.info || read.parsed.rows.length === 0) {
            deps.info(read?.reason ?? "No optimization iterations have been written yet.");
            return true;
          }
          const title = `Optimization — ${path.basename(dir)}`;
          deps.openPlot(optimizationPlotRecipe(read.parsed, read.info, title).recipe, title);
          return true;
        }
        case "optimizationDesignFields": {
          const dir = caseDir();
          const folder = dir ? readOptimization(dir).info?.designFieldsFolder : undefined;
          if (!dir || !folder) {
            deps.info("This optimization case writes no design fields (VTU output is off), or the preview is not part of one.");
            return true;
          }
          deps.openDesignFields(dir, folder, deps.runStatus(dir) !== "finished");
          return true;
        }
        case "optimizationExportCad": {
          const dir = caseDir();
          if (!dir) {
            deps.info("The preview is not part of an optimization case.");
            return true;
          }
          deps.exportCad(dir, deps.runStatus(dir) !== "finished");
          return true;
        }
        default:
          return false;
      }
    },
    refreshIfWatched() {
      if (watched) postProgress();
    },
  };
}
