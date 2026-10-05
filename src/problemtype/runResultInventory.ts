/** Shared receipt-writer contract for imported directory-backed results.
 * No run registry, inferred output folders, or retrospective ownership claims. */
import * as path from "node:path";
import { plotSourceIdentity } from "../parser/plot/revision";
import type { ExecutionArtifact } from "./runReceipt";

/** Called by the owning execution/explicit importer while freezing its receipt.
 * Readers must never upgrade an old receipt by hashing today's output bytes. */
export async function freezeExecutionResult(source: string, signal?: AbortSignal): Promise<ExecutionArtifact[]> {
  const abs = path.resolve(source), before = await plotSourceIdentity(abs, signal);
  const after = await plotSourceIdentity(abs, signal);
  if (before.revision !== after.revision) throw new Error("Result inventory changed while the owning receipt was being frozen.");
  return after.files.map(file => {
    if (!file.revision) throw new Error(`Cannot freeze a missing result dependency: ${file.path}`);
    return {
      role: file.path === abs ? "result" : "result-companion", path: file.path, revision: file.revision,
      ...(file.path === abs && after.inventoryRevision ? { inventoryRevision: after.inventoryRevision } : {}),
    };
  });
}
