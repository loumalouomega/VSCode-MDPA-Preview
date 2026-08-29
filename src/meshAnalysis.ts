/**
 * Host side of the webview's read-only mesh analyses.
 *
 * These two questions — "is this boundary closed?" and "what does this field
 * integrate to?" — are answered by meshio++, and the wasm is host-only (the
 * package is `external` and lives in `dist/meshio/`, unreachable from the
 * webview bundle). Every other analysis panel in this extension computes in the
 * webview from pure modules; these cannot, so they take one message round trip.
 *
 * One request/response pair covers both rather than two, because the shape is
 * identical — a kind, an optional argument, and a result or an error — and a
 * third analysis should be a new `kind`, not a third pair of message types.
 *
 * Neither analysis modifies the model, so neither goes through the operation
 * history and neither leaves an undo entry.
 */

import { watertightReport, watertightSummary } from "./parser/watertight";
import { integrateFields } from "./parser/fieldIntegrate";
import { MdpaModel } from "./parser/types";

export interface MeshAnalysisMessage {
  type: "meshAnalysis";
  kind?: string;
  variables?: string[];
}

/**
 * Runs one analysis and returns the reply to post. Errors become a `message`
 * on the reply rather than a rejection: a failed analysis should show a line in
 * the panel, never tear down the message handler.
 */
export async function runMeshAnalysis(
  msg: MeshAnalysisMessage,
  model: MdpaModel | undefined
): Promise<Record<string, unknown>> {
  const kind = msg.kind ?? "";
  if (!model) return { type: "meshAnalysisResult", kind, message: "No mesh is loaded." };
  try {
    if (kind === "watertight") {
      const report = await watertightReport(model);
      return report
        ? { type: "meshAnalysisResult", kind, report, summary: watertightSummary(report) }
        : { type: "meshAnalysisResult", kind, message: "The mesh has no cells to check." };
    }
    if (kind === "integrate") {
      const integrals = await integrateFields(model, msg.variables ?? []);
      return { type: "meshAnalysisResult", kind, integrals };
    }
    return { type: "meshAnalysisResult", kind, message: `Unknown analysis "${kind}".` };
  } catch (err) {
    return {
      type: "meshAnalysisResult",
      kind,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
