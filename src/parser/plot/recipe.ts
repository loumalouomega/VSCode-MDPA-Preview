import { PLOT_FAMILIES, REGION_OPERATIONS, PlotRecipe, PlotSource, PlotTransform } from "./types";
import { PLOT_MAX_ROWS } from "./importTable";

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 4096;
const number = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const dimensions = (v: unknown) => Array.isArray(v) && v.length === 7 && v.every(number);
function requireValue(ok: boolean, message: string): asserts ok { if (!ok) throw new Error(message); }

/** One validator at the UI/MCP/recipe trust boundaries. No executable options. */
export function validatePlotRecipe(value: unknown): PlotRecipe {
  requireValue(object(value) && value.version === 1, "Unsupported plot recipe version (expected 1); the file was not changed.");
  requireValue(Array.isArray(value.sources) && value.sources.length <= 32, "A plot needs at most 32 sources.");
  const ids = new Set<string>();
  for (const s of value.sources) {
    requireValue(object(s) && text(s.id) && !ids.has(s.id), "Sources need unique nonempty IDs."); ids.add(s.id);
    requireValue(["table", "inline", "mesh", "history", "probe", "region"].includes(s.type), `Unsupported source ${s.id}.`);
    if (s.type !== "inline") requireValue(text(s.path), `Source ${s.id}: choose a file.`);
    for (const k of ["submodelpart","timeUnit","runId"]) requireValue(s[k] === undefined || text(s[k]), `Source ${s.id}: invalid ${k}.`);
    if (s.type === "table" && s.options !== undefined) {
      const o = s.options;
      requireValue(object(o), `Source ${s.id}: invalid import options.`);
      requireValue(o.delimiter === undefined || [",", "\t", ";", "|"].includes(o.delimiter), "Invalid delimiter.");
      requireValue(o.header === undefined || typeof o.header === "boolean", "Header must be a boolean.");
      for (const k of ["missing", "numericColumns"]) requireValue(o[k] === undefined || (Array.isArray(o[k]) && o[k].length <= 256 && o[k].every((v: unknown) => typeof v === "string")), `Invalid ${k}.`);
      requireValue(o.units === undefined || (object(o.units) && Object.values(o.units).every(v => typeof v === "string")), "Invalid supplied units.");
    }
    if (s.type === "inline") {
      requireValue(object(s.table) && Array.isArray(s.table.columns) && s.table.columns.length <= 256 && Array.isArray(s.table.rows) && s.table.rows.length <= PLOT_MAX_ROWS, `Source ${s.id}: invalid inline table.`);
      requireValue(s.table.columns.every((c: any) => object(c) && text(c.id) && typeof c.label === "string" && ["number", "text"].includes(c.type) && (c.unit === undefined || text(c.unit)) && (c.dimensions === undefined || dimensions(c.dimensions)) && (c.domain === undefined || ["physicalTime","frameIndex","stepLabel","entityId"].includes(c.domain))), "Invalid table columns.");
      requireValue(new Set(s.table.columns.map((c: any) => c.id)).size === s.table.columns.length, "Duplicate column IDs.");
      requireValue(s.table.rows.every((r: any) => Array.isArray(r) && r.length === s.table.columns.length && r.every((v: unknown) => v === null || typeof v === "string" || number(v))), "Invalid table cells; nonfinite values must be null.");
    }
    if (s.type === "mesh") {
      requireValue(["Nodes", "Elements", "Conditions", "Geometries"].includes(s.kind), "Choose the mesh association.");
      requireValue(s.ids === undefined || (Array.isArray(s.ids) && s.ids.length <= PLOT_MAX_ROWS && s.ids.every(Number.isInteger)), "Invalid entity selection.");
    }
    if (s.timeStep !== undefined) requireValue(Number.isInteger(s.timeStep) && s.timeStep >= 0, "Invalid frame index.");
    if (s.followTimeline !== undefined) requireValue(s.type === "probe" && typeof s.followTimeline === "boolean" && (!s.followTimeline || s.timeStep !== undefined), "Timeline-following profiles require a probe and an explicit captured frame index.");
    if (s.type === "history" || s.type === "region") {
      requireValue(["Nodal", "Elemental", "Conditional"].includes(s.kind) && text(s.variable), "Choose a field association and variable.");
      if (s.type === "history") requireValue(Number.isInteger(s.entityId), "History needs an entity ID.");
      requireValue(s.times === undefined || (Array.isArray(s.times) && s.times.length <= PLOT_MAX_ROWS && s.times.every(number)), "Invalid explicit physical times.");
    }
    if (s.type === "region") {
      requireValue(REGION_OPERATIONS.includes(s.operation) && ["current", "history"].includes(s.scope), "Choose a region operation and scope.");
      requireValue(s.component === undefined || s.component === "magnitude" || (Number.isInteger(s.component) && s.component >= 0 && s.component < 32), "Invalid region component.");
      requireValue(s.orientation === undefined || ["outward", "winding"].includes(s.orientation), "Invalid boundary orientation.");
      requireValue(s.referencePoint === undefined || (Array.isArray(s.referencePoint) && s.referencePoint.length === 3 && s.referencePoint.every(number)), "Moment reference point needs finite XYZ coordinates.");
      for (const key of ["thickness", "pressureDensity"]) requireValue(s[key] === undefined || (number(s[key]) && s[key] > 0), `${key} must be finite and positive.`);
      requireValue(s.pressureOffset === undefined || number(s.pressureOffset), "Pressure offset must be finite.");
      if (["pressureMoment", "reactionMoment"].includes(s.operation)) requireValue(s.referencePoint !== undefined, "Choose a moment reference point explicitly.");
    }
    if (s.type === "probe") {
      requireValue(Array.isArray(s.points) && s.points.length >= 2 && s.points.length <= 1000 && s.points.every((p: any) => Array.isArray(p) && p.length === 3 && p.every(number)) && text(s.variable), "Probe needs finite XYZ endpoints and a Nodal field.");
      requireValue(s.samples === undefined || (Number.isInteger(s.samples) && s.samples >= 2 && s.samples <= 100000), "Probe samples must be 2–100000.");
    }
  }
  requireValue(Array.isArray(value.series) && value.series.length <= 64, "At most 64 plot series are supported.");
  const seriesIds = new Set<string>();
  for (const s of value.series) {
    requireValue(object(s) && text(s.id) && !seriesIds.has(s.id) && ids.has(s.source) && text(s.x) && text(s.y) && typeof s.name === "string", "Series needs a unique ID, source and X/Y columns."); seriesIds.add(s.id);
    requireValue(s.panel === undefined || (Number.isInteger(s.panel) && s.panel >= 0 && s.panel < 4), "Invalid plot panel.");
    requireValue(s.bins === undefined || (Number.isInteger(s.bins) && s.bins >= 1 && s.bins <= 1000), "Histogram bins must be 1–1000.");
    requireValue(s.statistic === undefined || ["mean", "sum", "min", "max", "count"].includes(s.statistic), "Invalid grouped statistic.");
    for (const k of ["z","size","group","color"]) requireValue(s[k] === undefined || text(s[k]), `Invalid series ${k}.`);
    requireValue(s.sizeMax === undefined || (number(s.sizeMax) && s.sizeMax >= 4 && s.sizeMax <= 100), "Maximum bubble diameter must be 4–100 pixels.");
    requireValue(s.marker === undefined || ["circle","square","diamond"].includes(s.marker), "Invalid marker.");
    requireValue(s.visible === undefined || typeof s.visible === "boolean", "Visibility must be a boolean.");
    if (s.filter) requireValue(object(s.filter) && text(s.filter.column) && (s.filter.min === undefined || number(s.filter.min)) && (s.filter.max === undefined || number(s.filter.max)) && (s.filter.equals === undefined || typeof s.filter.equals === "string") && (s.filter.min === undefined || s.filter.max === undefined || s.filter.min <= s.filter.max), "Invalid row filter; minimum must not exceed maximum.");
    if (s.component) requireValue(s.component === "magnitude" && Array.isArray(s.components) && s.components.length > 0 && s.components.length <= 32 && s.components.every(text), "Magnitude needs explicit component columns.");
    if (s.uncertainty) requireValue(object(s.uncertainty) && text(s.uncertainty.column) && text(s.uncertainty.meaning), "Error bars need a supplied column and its meaning.");
    requireValue(s.transforms === undefined || (Array.isArray(s.transforms) && s.transforms.length <= 32), "Invalid transformation list.");
    for (const t of s.transforms ?? []) {
      requireValue(object(t) && ["smooth", "regression", "derivative", "integral", "normalize", "convert"].includes(t.op), "Unknown plot transformation.");
      if (t.op === "smooth") requireValue(Number.isInteger(t.window) && t.window >= 1 && t.window <= 10001 && t.window % 2 === 1, "Smoothing window must be an odd integer from 1 to 10001.");
      if (t.op === "normalize") requireValue(number(t.divisor) && t.divisor !== 0, "Normalization divisor must be finite and nonzero.");
      if (t.op === "convert") requireValue(number(t.factor) && t.factor > 0 && text(t.unit) && (t.dimensions === undefined || dimensions(t.dimensions)), "Conversion needs a positive factor and target unit.");
    }
    if (s.alignment) requireValue(object(s.alignment) && text(s.alignment.reference) && ["exact", "nearest", "linear"].includes(s.alignment.method) && number(s.alignment.tolerance) && s.alignment.tolerance >= 0 && s.alignment.reference !== s.id, "Invalid reference alignment.");
    if (s.grid) {
      requireValue(object(s.grid) && ["regular", "nearest"].includes(s.grid.method), "Choose a grid/interpolation method.");
      if (s.grid.method === "nearest") requireValue([s.grid.nx, s.grid.ny].every(n => Number.isInteger(n) && n >= 2 && n <= 256) && number(s.grid.radius) && s.grid.radius > 0, "Nearest gridding needs 2–256 rows/columns and a positive coverage radius.");
    }
  }
  for (const s of value.series) if (s.alignment) requireValue(seriesIds.has(s.alignment.reference), `Missing reference series ${s.alignment.reference}.`);
  requireValue(object(value.presentation) && PLOT_FAMILIES.includes(value.presentation.family) && typeof value.presentation.title === "string", "Choose a supported plot family and title.");
  const p = value.presentation;
  requireValue(p.lineMode === undefined || ["lines", "lines+markers"].includes(p.lineMode), "Choose lines or lines with markers.");
  requireValue(p.barMode === undefined || ["group", "stack"].includes(p.barMode), "Choose grouped or stacked bars.");
  requireValue(p.barOrientation === undefined || ["v", "h"].includes(p.barOrientation), "Choose vertical or horizontal bars.");
  for (const k of ["xLabel","yLabel"]) requireValue(p[k] === undefined || typeof p[k] === "string", "Invalid axis label.");
  for (const k of ["xScale", "yScale"]) requireValue(p[k] === undefined || ["linear", "log"].includes(p[k]), "Invalid axis scale.");
  for (const k of ["xRange", "yRange"]) requireValue(p[k] === undefined || (Array.isArray(p[k]) && p[k].length === 2 && p[k].every(number) && p[k][0] < p[k][1] && (p[k.replace("Range", "Scale")] !== "log" || p[k][0] > 0)), "Axis limits must increase and be positive on log axes.");
  requireValue(p.panels === undefined || [1, 2, 4].includes(p.panels), "Choose 1, 2 or 4 panels.");
  for (const s of value.series) requireValue((s.panel ?? 0) < (p.panels ?? 1), `Series ${s.name}: choose an existing panel or increase the panel count.`);
  requireValue(p.annotations === undefined || (Array.isArray(p.annotations) && p.annotations.length <= 100 && p.annotations.every((a: any) => object(a) && number(a.x) && number(a.y) && typeof a.text === "string")), "Invalid annotations.");
  // Clone at the boundary so callers cannot mutate an in-flight request.
  return JSON.parse(JSON.stringify(value)) as PlotRecipe;
}

export function emptyPlotRecipe(source?: PlotSource): PlotRecipe {
  return { version: 1, sources: source ? [source] : [], series: [], presentation: { family: "line", title: "Scientific plot", panels: 1 } };
}

export const PLOT_CAPABILITIES = {
  version: 1, families: PLOT_FAMILIES, sources: ["table", "inline", "mesh", "history", "probe", "region"],
  regionOperations: REGION_OPERATIONS,
  transforms: ["smooth", "regression", "derivative", "integral", "normalize", "convert"] as PlotTransform["op"][],
  alignment: ["exact", "nearest", "linear"], gridding: ["regular", "nearest (explicit radius; convex-hull mask)"],
  lineModes: ["lines", "lines+markers"], barModes: ["group", "stack"], barOrientations: ["v", "h"],
  circular: "explicit per-category statistic; nonnegative weights, positive total; separate series are separate pies, not an exclusive physical partition",
  bubble: "explicit numeric size column; area proportional to supplied nonnegative values; missing/negative/zero sizes not drawn",
  maxRows: PLOT_MAX_ROWS, numericBackend: "TypeScript host worker", units: "supplied; unknown is not dimensionless",
};
