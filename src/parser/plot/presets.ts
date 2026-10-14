/** Named plot presets: pure recipe builders over existing sources, plus a read-only threshold check. No numerics of their own, no DOM or I/O. */
import { emptyPlotRecipe, validatePlotRecipe } from "./recipe";
import type { PlotRecipe, PlotRegionSource, PlotSeriesData, PlotSeriesSpec } from "./types";
import type { FieldBlockKind } from "../types";

const COLORS = ["#4e9af1", "#f29d49", "#57bf8a", "#bb86fc", "#e56b8a"];

export interface SectionComparisonParams {
  path: string; variable: string; kind?: FieldBlockKind;
  /** SubModelPart paths compared on one chart; at least two. */
  sections: string[];
  /** Scalar mean over the section's boundary (default) or its entities. */
  operation?: "boundaryMean" | "mean";
  component?: number | "magnitude";
  /** Explicit physical times (one per frame); without them the axis is a step label, not time. */
  times?: number[]; timeUnit?: string;
}
export interface TableRelationshipParams {
  /** `x`/`y` are the importer's column ids (`c0`, `c1`, … in file order; see plot_table_read). */
  path: string; x: string; y: string; xLabel?: string; yLabel?: string;
  /** Supplied units per column id (`c0`, …); unknown stays unknown. */
  units?: Record<string, string>;
  family?: "line" | "scatter";
}

/** Several sections of one field over time (for example inlet and outlet pressure). Differences are not derived: read them from the curves or the exported table. */
export function sectionComparisonPreset(p: SectionComparisonParams): PlotRecipe {
  if (!Array.isArray(p.sections) || p.sections.length < 2 || new Set(p.sections).size !== p.sections.length) throw new Error("Section comparison needs at least two distinct SubModelParts.");
  const recipe = emptyPlotRecipe();
  const operation = p.operation ?? "boundaryMean";
  p.sections.forEach((section, i) => {
    const source: PlotRegionSource = { id: `section:${i}`, type: "region", path: p.path, kind: p.kind ?? "Nodal", variable: p.variable, submodelpart: section, scope: "history", operation, ...(p.component !== undefined ? { component: p.component } : {}), ...(p.times ? { times: p.times } : {}), ...(p.timeUnit ? { timeUnit: p.timeUnit } : {}) };
    recipe.sources.push(source);
    const spec: PlotSeriesSpec = { id: `curve:${source.id}`, source: source.id, name: `${p.variable} · ${section}`, x: "time", y: "v0", color: COLORS[i % COLORS.length] };
    recipe.series.push(spec);
  });
  recipe.presentation.title = `${p.variable}: ${p.sections.join(" vs ")}`;
  return validatePlotRecipe(recipe);
}

/** One supplied analysis-table column against another (load–displacement, pressure–flow, …). Units are only those the table supplies. */
export function tableRelationshipPreset(p: TableRelationshipParams): PlotRecipe {
  if (!p.x || !p.y || p.x === p.y) throw new Error("Choose two different table columns.");
  const recipe = emptyPlotRecipe({ id: "table", type: "table", path: p.path, ...(p.units ? { options: { units: p.units } } : {}) });
  recipe.series.push({ id: "relation", source: "table", name: `${p.y} vs ${p.x}`, x: p.x, y: p.y, color: COLORS[0] });
  recipe.presentation.family = p.family ?? "line";
  recipe.presentation.title = `${p.y} vs ${p.x}`;
  if (p.xLabel) recipe.presentation.xLabel = p.xLabel;
  if (p.yLabel) recipe.presentation.yLabel = p.yLabel;
  return validatePlotRecipe(recipe);
}

export interface VolumeTotalParams {
  path: string; variable: string;
  /** SubModelParts to total; none = the whole mesh. */
  regions?: string[];
  scope?: "current" | "history";
  times?: number[]; timeUnit?: string;
}
/** Measure-weighted total (sum of value x length/area/volume) of a scalar Elemental field per region. */
export function volumeTotalPreset(p: VolumeTotalParams): PlotRecipe {
  const scope = p.scope ?? "current";
  const regions = p.regions?.length ? p.regions : [""];
  if (new Set(regions).size !== regions.length) throw new Error("Volume total regions must be distinct.");
  const recipe = emptyPlotRecipe();
  regions.forEach((region, i) => {
    const source: PlotRegionSource = { id: `total:${i}`, type: "region", path: p.path, kind: "Elemental", variable: p.variable, ...(region ? { submodelpart: region } : {}), scope, operation: "measureIntegral", ...(scope === "history" && p.times ? { times: p.times } : {}), ...(scope === "history" && p.timeUnit ? { timeUnit: p.timeUnit } : {}) };
    recipe.sources.push(source);
    recipe.series.push({ id: `curve:${source.id}`, source: source.id, name: `${p.variable} total · ${region || "whole mesh"}`, x: scope === "history" ? "time" : "region", y: "v0", color: COLORS[i % COLORS.length] });
  });
  recipe.presentation.family = scope === "history" ? "line" : "bar";
  recipe.presentation.title = `${p.variable} measure-weighted total`;
  return validatePlotRecipe(recipe);
}

export interface SectionDifference {
  from: string; to: string;
  /** x values present in both series with a value on both sides. */
  matched: number;
  /** x values in either series that could not produce a difference (unmatched or a gap on one side). */
  gaps: number;
  unit?: string;
  points: { x: number | string | null; y: number | null }[];
}
/** `from - to` at exactly matching x. Unmatched x or a gap on either side is a gap, never 0; differing units are refused. */
export function sectionDifference(from: Pick<PlotSeriesData, "id" | "points" | "yColumn">, to: Pick<PlotSeriesData, "id" | "points" | "yColumn">): SectionDifference {
  if ((from.yColumn.unit ?? "") !== (to.yColumn.unit ?? "")) throw new Error(`Cannot subtract ${to.id} from ${from.id}: units differ (${from.yColumn.unit ?? "unknown"} vs ${to.yColumn.unit ?? "unknown"}).`);
  const right = new Map<string, number | null>(); for (const pt of to.points) right.set(String(pt.x), pt.y);
  const seen = new Set<string>(), points: SectionDifference["points"] = []; let matched = 0, gaps = 0;
  for (const pt of from.points) {
    const k = String(pt.x); seen.add(k);
    const r = right.get(k);
    const ok = r !== undefined && r !== null && pt.y !== null && Number.isFinite(r) && Number.isFinite(pt.y);
    if (ok) { matched++; points.push({ x: pt.x, y: pt.y! - r! }); } else { gaps++; points.push({ x: pt.x, y: null }); }
  }
  for (const k of right.keys()) if (!seen.has(k)) gaps++;
  return { from: from.id, to: to.id, matched, gaps, ...(from.yColumn.unit ? { unit: from.yColumn.unit } : {}), points };
}

export interface ThresholdCheck {
  series: string; limit: number; direction: "above" | "below";
  /** Points that passed through the check (finite y). */
  checked: number;
  /** Points with no value: neither passes nor fails. */
  gaps: number;
  exceedances: number;
  first?: { x: number | string | null; y: number };
  /** Largest violation size (y − limit above, limit − y below); 0 when nothing violates. */
  worstMargin: number;
  worst?: { x: number | string | null; y: number };
  ok: boolean;
}
/** User-supplied limit applied to an evaluated curve. Equality is not a violation; a gap is counted, never treated as pass or fail. */
export function checkThreshold(series: Pick<PlotSeriesData, "id" | "points">, limit: number, direction: "above" | "below"): ThresholdCheck {
  if (!Number.isFinite(limit)) throw new Error("The threshold limit must be a finite number.");
  const out: ThresholdCheck = { series: series.id, limit, direction, checked: 0, gaps: 0, exceedances: 0, worstMargin: 0, ok: true };
  for (const pt of series.points) {
    if (pt.y === null || !Number.isFinite(pt.y)) { out.gaps++; continue; }
    out.checked++;
    const margin = direction === "above" ? pt.y - limit : limit - pt.y;
    if (margin > 0) {
      out.exceedances++;
      out.first ??= { x: pt.x, y: pt.y };
      if (margin > out.worstMargin) { out.worstMargin = margin; out.worst = { x: pt.x, y: pt.y }; }
    }
  }
  out.ok = out.exceedances === 0;
  return out;
}

export const PLOT_PRESETS = [
  { id: "sectionComparison", label: "Section comparison over time", params: ["path", "variable", "sections", "kind?", "operation?", "component?", "times?", "timeUnit?"] },
  { id: "volumeTotal", label: "Measure-weighted total of an Elemental field", params: ["path", "variable", "regions?", "scope?", "times?", "timeUnit?"] },
  { id: "tableRelationship", label: "Table column relationship", params: ["path", "x", "y", "units?", "family?", "xLabel?", "yLabel?"] },
] as const;
export type PlotPresetId = typeof PLOT_PRESETS[number]["id"];
export function buildPlotPreset(id: string, params: any): PlotRecipe {
  if (id === "sectionComparison") return sectionComparisonPreset(params);
  if (id === "volumeTotal") return volumeTotalPreset(params);
  if (id === "tableRelationship") return tableRelationshipPreset(params);
  throw new Error(`Unknown plot preset ${id}; available: ${PLOT_PRESETS.map(p => p.id).join(", ")}.`);
}
