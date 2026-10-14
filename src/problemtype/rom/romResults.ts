/**
 * The read side of a ROM case's results: what RomApplication left in
 * `rom_data/` (the basis size in RomParameters.json, the singular values, the
 * HROM element/condition ids and weights) and what the generated driver
 * recorded (kkss-rom-progress.jsonl, kkss-rom-summary-v1.json). Pure; the
 * `node:fs` half is `romResultsFile.ts`.
 *
 * Claims, stated: the number of modes is the one RomParameters.json says, never
 * inferred from the singular values; the HROM counts are the id arrays' sizes;
 * a progress line that is not JSON is counted and skipped.
 */

import type { PlotRecipe } from "../../parser/plot/types";

export interface RomProgressRecord {
  event: "start" | "end";
  index: number;
  label?: string;
  mu?: number[] | null;
  elapsed?: number;
  time?: number;
}

export interface RomResults {
  /** RomParameters.json's rom_settings.number_of_rom_dofs, when written. */
  modes?: number;
  projectionStrategy?: string;
  singularValues?: number[];
  hromElements?: number[];
  hromConditions?: number[];
  hromElementWeights?: number[];
  progress: RomProgressRecord[];
  malformedProgress: number;
  summary?: { stopped?: boolean; runs?: number; train?: number; test?: number; error?: string };
  /** From RomSamples.json. */
  samples?: { names: string[]; train: number; test: number };
  warnings: string[];
}

export function parseRomProgress(text: string): { records: RomProgressRecord[]; malformed: number } {
  const records: RomProgressRecord[] = [];
  let malformed = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const r = JSON.parse(line) as RomProgressRecord;
      if ((r.event === "start" || r.event === "end") && typeof r.index === "number") records.push(r);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  return { records, malformed };
}

export interface RomStatus {
  modes?: number;
  hromElements?: number;
  hromConditions?: number;
  runsFinished: number;
  runsStarted: number;
  /** The label of an analysis that started and has not ended (the one running now). */
  current?: string;
  stopped: boolean;
  done: boolean;
}

export function romStatus(r: RomResults): RomStatus {
  const ended = new Set(r.progress.filter((p) => p.event === "end").map((p) => p.index));
  const started = r.progress.filter((p) => p.event === "start");
  const open = started.filter((p) => !ended.has(p.index));
  return {
    modes: r.modes,
    hromElements: r.hromElements?.length,
    hromConditions: r.hromConditions?.length,
    runsFinished: ended.size,
    runsStarted: started.length,
    current: open.length > 0 ? open[open.length - 1].label : undefined,
    stopped: r.summary?.stopped === true,
    done: r.summary !== undefined,
  };
}

/** One line for the Kratos Runs tree. */
export function romRowText(s: RomStatus): string {
  const parts: string[] = [];
  parts.push(s.modes !== undefined ? `ROM ${s.modes} mode${s.modes === 1 ? "" : "s"}` : "ROM basis not written yet");
  if (s.hromElements !== undefined || s.hromConditions !== undefined) {
    parts.push(`HROM ${s.hromElements ?? 0} el / ${s.hromConditions ?? 0} cond`);
  }
  parts.push(`${s.runsFinished} run${s.runsFinished === 1 ? "" : "s"} done`);
  if (s.current) parts.push(`running ${s.current}`);
  if (s.stopped) parts.push("stopped (database partial)");
  else if (s.done) parts.push("finished");
  return `Reduced model — ${parts.join(" · ")}`;
}

export function romIconId(s: RomStatus): string {
  if (s.stopped) return "debug-stop";
  if (s.done) return s.modes !== undefined ? "pass" : "warning";
  return "pulse";
}

/**
 * The singular-value decay, normalized by the first value, on a log axis — what
 * the SVD truncation tolerance cuts. Modes kept are marked when known.
 */
export function romSingularValuesRecipe(values: number[], modes: number | undefined, title: string): { recipe: PlotRecipe; notes: string[] } {
  const first = values.find((v) => Number.isFinite(v) && v !== 0);
  const notes: string[] = [];
  if (first === undefined) notes.push("The singular values are all zero or missing; nothing can be normalized.");
  const rows = values.map((v, i) => [i + 1, Number.isFinite(v) && first ? v / first : null, modes !== undefined && i < modes ? 1 : 0]);
  return {
    notes,
    recipe: {
      version: 1,
      sources: [
        {
          id: "sv",
          type: "inline",
          table: {
            columns: [
              { id: "mode", label: "Mode", type: "number" },
              { id: "sigma", label: "σ / σ₁", type: "number" },
              { id: "kept", label: "Kept in the basis", type: "number" },
            ],
            rows,
            diagnostics: [],
          },
        },
      ],
      series: [
        { id: "all", source: "sv", name: "Singular values", x: "mode", y: "sigma" },
        ...(modes !== undefined ? [{ id: "kept", source: "sv", name: `Kept (${modes} modes)`, x: "mode", y: "sigma", filter: { column: "kept", min: 1, max: 1 } }] : []),
      ],
      presentation: { family: "line", title, xLabel: "Mode", yLabel: "σ / σ₁", yScale: "log", lineMode: "lines+markers", panels: 1 },
    },
  };
}
