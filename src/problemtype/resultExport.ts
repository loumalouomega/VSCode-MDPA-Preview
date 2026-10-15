/**
 * Converting a finished case's `vtk_output` frames to other meshio++ formats.
 *
 * The solver always writes VTK (`vtk_output_process`); this is the post-run step
 * that turns those frames into whatever else the user asked for. A series goes
 * into ONE file where the format has a container for it (XDMF, PVD) and into one
 * file per step otherwise. The module is vscode-free and takes the two writers as
 * dependencies (`meshConvert` / `meshPackSeries` from `mcp/tools.ts`), so it is
 * testable in Node and `tools.ts` can call it without an import cycle.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { discoverOutputs } from "./outputDiscovery";
import { discoverSeriesFiles } from "../parser/fieldSeriesScan";
import { meshStem } from "../parser/meshFormats";
import { isExportableExtension } from "../parser/writers/exportFormats";

export const DEFAULT_EXPORT_FOLDER = "converted";

export interface ResultExportDeps {
  convert(args: { path: string; outputPath: string }): Promise<{ warnings?: string[] }>;
  pack(args: { path: string; outputPath: string; target: "xdmf" | "pvd" }): Promise<{ files?: string[]; companions?: string[]; steps?: number; warnings?: string[] }>;
}

export interface ResultExportSpec {
  formats: string[];
  /** Absolute, or relative to the case folder. */
  folder?: string;
}

export interface ResultExportOutcome {
  folder: string;
  /** Source frames considered. */
  frames: number;
  written: { format: string; files: string[]; packed: boolean }[];
  skipped: { format: string; reason: string }[];
  warnings: string[];
}

/** `"xdmf"`, `" .EXO"` → `".xdmf"`, `".exo"`; empty entries and duplicates drop out. */
export function normalizeExportFormats(formats: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of formats ?? []) {
    const f = String(raw).trim().toLowerCase();
    if (!f) continue;
    const ext = f.startsWith(".") ? f : `.${f}`;
    if (!out.includes(ext)) out.push(ext);
  }
  return out;
}

/** The pure decision: does a run that just ended call for a conversion? */
export function shouldAutoExport(status: string, formats: readonly string[] | undefined): boolean {
  return status === "finished" && normalizeExportFormats(formats).length > 0;
}

const CONTAINERS: Record<string, "xdmf" | "pvd"> = { ".xdmf": "xdmf", ".xmf": "xdmf", ".pvd": "pvd" };

export async function exportCaseResults(
  meshPath: string,
  spec: ResultExportSpec,
  deps: ResultExportDeps
): Promise<ResultExportOutcome> {
  const caseDir = path.dirname(path.resolve(meshPath));
  const folder = path.resolve(caseDir, spec.folder?.trim() || DEFAULT_EXPORT_FOLDER);
  const outcome: ResultExportOutcome = { folder, frames: 0, written: [], skipped: [], warnings: [] };
  const formats = normalizeExportFormats(spec.formats);
  if (formats.length === 0) throw new Error("No export formats were given.");

  const discovered = discoverOutputs(caseDir);
  if (discovered.results.length === 0) {
    throw new Error(`No solver output found in ${caseDir} (looked where the case's output processes write).`);
  }
  // The folder must not be somewhere the solver (or discovery) owns.
  for (const result of discovered.results) {
    const out = path.resolve(path.dirname(result));
    const rel = path.relative(out, folder);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
      throw new Error(`The export folder ${folder} is inside the solver output folder ${out}; choose another.`);
    }
  }

  const first = discovered.results[0];
  const series = await discoverSeriesFiles(first);
  const frames = series.length > 0 ? series.map((f) => f.fsPath) : [first];
  outcome.frames = frames.length;
  fs.mkdirSync(folder, { recursive: true });
  const stem = meshStem(path.basename(first)).replace(/_\d+_\d+$/, "") || meshStem(path.basename(first));

  const perStep = async (ext: string, note?: string): Promise<void> => {
    const files: string[] = [];
    for (const frame of frames) {
      if (path.extname(frame).toLowerCase() === ext) {
        outcome.skipped.push({ format: ext, reason: `Frames are already ${ext}.` });
        return;
      }
      const out = path.join(folder, `${meshStem(path.basename(frame))}${ext}`);
      const r = await deps.convert({ path: frame, outputPath: out });
      files.push(out);
      for (const w of r.warnings ?? []) outcome.warnings.push(`${path.basename(frame)} → ${ext}: ${w}`);
    }
    if (note) outcome.warnings.push(note);
    outcome.written.push({ format: ext, files, packed: false });
  };

  for (const ext of formats) {
    if (!(ext in CONTAINERS) && !isExportableExtension(ext)) {
      outcome.skipped.push({ format: ext, reason: `${ext} is not an exportable format.` });
      continue;
    }
    try {
      const target = CONTAINERS[ext];
      if (target && frames.length > 1) {
        const out = path.join(folder, `${stem}${ext}`);
        try {
          const r = await deps.pack({ path: first, outputPath: out, target });
          outcome.written.push({ format: ext, files: [out, ...(r.files ?? []), ...(r.companions ?? [])], packed: true });
          for (const w of r.warnings ?? []) outcome.warnings.push(`${ext}: ${w}`);
          continue;
        } catch (error) {
          if (target === "pvd") throw error;
          // XDMF holds one static mesh: a series whose topology changes goes per step.
          await perStep(ext, `${ext}: could not be packed into one file (${(error as Error).message}); wrote one file per step.`);
          continue;
        }
      }
      if ((ext as string) === ".pvd") {
        outcome.skipped.push({ format: ext, reason: "A .pvd index needs a series of at least two steps." });
        continue;
      }
      await perStep(ext);
    } catch (error) {
      outcome.skipped.push({ format: ext, reason: (error as Error).message });
    }
  }
  return outcome;
}

/** One line for the Output channel / a notification. */
export function describeResultExport(o: ResultExportOutcome): string {
  const done = o.written.map((w) => `${w.format}${w.packed ? " (one file)" : ` (${w.files.length})`}`).join(", ");
  const skipped = o.skipped.map((s) => `${s.format}: ${s.reason}`).join("; ");
  return (
    `Converted ${o.frames} frame${o.frames === 1 ? "" : "s"} to ${done || "nothing"} in ${o.folder}.` +
    (skipped ? ` Skipped — ${skipped}` : "")
  );
}
