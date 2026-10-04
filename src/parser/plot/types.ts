/** Scientific plotting contracts (roadmap item 14). No renderer, DOM or VS Code. */
import type { TableKind } from "../dataTable";
import type { FieldBlockKind, MdpaModel } from "../types";

export type PlotValue = number | string | null;
export interface PlotColumn {
  id: string;
  label: string;
  type: "number" | "text";
  unit?: string;
  dimensions?: number[];
  domain?: "physicalTime" | "frameIndex" | "stepLabel" | "entityId";
}
export interface PlotOrigin {
  source: string;
  rowIndex?: number;
  entityKind?: TableKind;
  entityId?: number;
  frameIndex?: number;
  time?: number;
  runId?: string;
}
export interface PlotTable {
  columns: PlotColumn[];
  rows: PlotValue[][];
  origins?: PlotOrigin[];
  diagnostics: string[];
  partial?: boolean;
  revision?: string;
}
export interface ImportOptions {
  delimiter?: "," | "\t" | ";" | "|";
  header?: boolean;
  missing?: string[];
  numericColumns?: string[];
  units?: Record<string, string>;
}
export type PlotSource =
  | { id: string; type: "table"; path: string; options?: ImportOptions }
  | { id: string; type: "inline"; table: PlotTable }
  | { id: string; type: "mesh"; path: string; kind: TableKind; submodelpart?: string; ids?: number[]; timeStep?: number }
  | { id: string; type: "history"; path: string; kind: FieldBlockKind; entityId: number; variable: string; times?: number[]; timeUnit?: string; runId?: string }
  | { id: string; type: "probe"; path: string; points: [number, number, number][]; variable: string; samples?: number; timeStep?: number };
export type PlotTransform =
  | { op: "smooth"; window: number }
  | { op: "regression" }
  | { op: "derivative" }
  | { op: "integral" }
  | { op: "normalize"; divisor: number }
  | { op: "convert"; factor: number; unit: string; dimensions?: number[] };
export type PlotFamily = "line" | "scatter" | "histogram" | "box" | "bar" | "heatmap" | "contour";
export const PLOT_FAMILIES: PlotFamily[] = ["line", "scatter", "histogram", "box", "bar", "heatmap", "contour"];
export interface PlotSeriesSpec {
  id: string;
  source: string;
  name: string;
  x: string;
  y: string;
  z?: string;
  group?: string;
  component?: "magnitude";
  components?: string[];
  filter?: { column: string; min?: number; max?: number; equals?: string };
  transforms?: PlotTransform[];
  bins?: number;
  statistic?: "mean" | "sum" | "min" | "max" | "count";
  grid?: { method: "regular" | "nearest"; nx?: number; ny?: number; radius?: number };
  alignment?: { reference: string; method: "exact" | "nearest" | "linear"; tolerance: number };
  uncertainty?: { column: string; meaning: string };
  color?: string;
  marker?: "circle" | "square" | "diamond";
  visible?: boolean;
  panel?: number;
}
export interface PlotRecipe {
  version: 1;
  sources: PlotSource[];
  series: PlotSeriesSpec[];
  presentation: {
    family: PlotFamily;
    title: string;
    xLabel?: string;
    yLabel?: string;
    xScale?: "linear" | "log";
    yScale?: "linear" | "log";
    xRange?: [number, number];
    yRange?: [number, number];
    panels?: 1 | 2 | 4;
    annotations?: { x: number; y: number; text: string }[];
  };
}
export interface PlotPoint { x: number | string | null; y: number | null; z?: number | null; error?: number | null; components?: (number | null)[]; origin?: PlotOrigin }
export interface PlotSeriesData {
  id: string;
  name: string;
  xColumn: PlotColumn;
  yColumn: PlotColumn;
  zColumn?: PlotColumn;
  originalXColumn: PlotColumn;
  originalYColumn: PlotColumn;
  points: PlotPoint[];
  original: PlotPoint[];
  diagnostics: string[];
  statistics: { count: number; missing: number; min: number | null; max: number | null; mean: number | null; std: number | null; q1: number | null; median: number | null; q3: number | null };
  regression?: { slope: number; intercept: number; rSquared: number | null };
  grid?: { x: number[]; y: number[]; z: (number | null)[][] };
  box?: [number, number, number, number, number];
}
export interface PlotDataset {
  version: 1;
  series: PlotSeriesData[];
  diagnostics: string[];
  sources: { id: string; revision?: string; rows: number; columns: PlotColumn[]; partial: boolean }[];
  recipe: PlotRecipe;
  partial: boolean;
  /** Actual full-resolution point count, not the webview's sample count. */
  fullCount: number;
  displayCount?: number;
}
export interface PlotExecution {
  signal?: AbortSignal;
  progress?(done: number, total: number, label: string): void;
  /** Snapshot-owned models: never transfer/detach buffers owned by a document. */
  models?: Record<string, MdpaModel>;
}
