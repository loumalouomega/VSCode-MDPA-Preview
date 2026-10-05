/** Renderer options only: all aggregation/statistics remain in the shared host core. */
import type { PlotDataset, PlotSeriesData, PlotSeriesSpec } from "./types";

const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const label = (c: { label: string; unit?: string }) => escape(`${c.label} [${c.unit ?? "unknown"}]`);
/** Choose between the actual theme inks; do not trust Plotly's pie contrast guess. */
function sliceInk(fill: string, fg: string, bg: string): string {
  const luminance = (color: string) => {
    const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(color)?.[1];
    const rgb = /^rgb\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)\s*\)$/i.exec(color);
    const channels = hex ? (hex.length === 3 ? hex.split("").map(c => parseInt(c + c, 16)) : [0,2,4].map(i => parseInt(hex.slice(i, i + 2), 16))) : rgb ? rgb.slice(1).map(Number) : undefined;
    return channels?.map(v => { const c = Math.max(0, Math.min(255, v)) / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((n, v, i) => n + v * [.2126, .7152, .0722][i], 0);
  };
  const fillL = luminance(fill), fgL = luminance(fg), bgL = luminance(bg);
  if (fillL === undefined || fgL === undefined || bgL === undefined) return fg;
  const contrast = (ink: number) => (Math.max(fillL, ink) + .05) / (Math.min(fillL, ink) + .05);
  return contrast(bgL) > contrast(fgL) ? bg : fg;
}
export function plotFigure(dataset: PlotDataset, theme: { fg: string; bg: string; font: string; palette: string[] }) {
  const p = dataset.recipe.presentation, family = p.family, circular = family === "pie" || family === "doughnut";
  const specFor = (s: PlotSeriesData) => dataset.recipe.series.find(r => r.id === s.id || s.id.startsWith(`${r.id}:`)) as PlotSeriesSpec | undefined;
  const panelFor = (s: PlotSeriesData) => specFor(s)?.panel ?? 0;
  const categoryColors = new Map<string, string>();
  if (circular) for (const s of dataset.series) for (const point of s.points) if (point.x !== null && !categoryColors.has(String(point.x))) categoryColors.set(String(point.x), theme.palette[categoryColors.size % theme.palette.length]);
  const traces: any[] = [];
  for (const [i, s] of dataset.series.entries()) {
    const spec = specFor(s), panel = panelFor(s), axis = panel ? String(panel + 1) : "", color = spec?.color ?? theme.palette[i % theme.palette.length];
    const points = s.points.map(v => ({ ...v, x: !circular && p.xScale === "log" && typeof v.x === "number" && v.x <= 0 ? null : v.x, y: !circular && p.yScale === "log" && v.y !== null && v.y <= 0 ? null : v.y }));
    const common = { name: escape(s.name), xaxis: `x${axis}`, yaxis: `y${axis}`, visible: spec?.visible === false ? "legendonly" : true, marker: { color, symbol: spec?.marker ?? "circle", size: 6 }, line: { color, width: 2 }, customdata: points, connectgaps: false };
    if (circular) {
      const members = dataset.series.filter(d => panelFor(d) === panel), at = members.indexOf(s);
      const panelCols = p.panels === 4 ? 2 : 1, panelRows = (p.panels ?? 1) > 1 ? 2 : 1;
      const cols = Math.ceil(Math.sqrt(members.length)), rows = Math.ceil(members.length / cols);
      const x0 = (panel % panelCols + at % cols / cols) / panelCols, x1 = x0 + 1 / cols / panelCols;
      const y1 = 1 - (Math.floor(panel / panelCols) + Math.floor(at / cols) / rows) / panelRows, y0 = y1 - 1 / rows / panelRows;
      const slices = points.filter(v => v.x !== null && v.y !== null && v.y > 0);
      traces.push({ name: common.name, visible: common.visible, type: "pie", hole: family === "doughnut" ? .55 : 0, sort: false, direction: "clockwise", labels: slices.map(v => escape(String(v.x))), values: slices.map(v => v.y), customdata: slices, text: slices.map(v => v.share === null || v.share === undefined ? "unknown share" : `${(v.share * 100).toPrecision(3)}%`), insidetextfont: { color: slices.map(v => sliceInk(categoryColors.get(String(v.x))!, theme.fg, theme.bg)) }, outsidetextfont: { color: theme.fg }, marker: { colors: slices.map(v => categoryColors.get(String(v.x))), line: { color: theme.bg, width: 1 } }, domain: { x: [x0 + .025, x1 - .025], y: [y0 + .04, y1 - .04] }, title: { text: `${common.name}<br>${label(s.yColumn)}`, font: { size: 11, color } }, textinfo: "label+text", hovertemplate: "%{label}<br>%{value} (%{text})<extra>%{fullData.name}</extra>" });
      continue;
    }
    if (family === "heatmap" || family === "contour") { traces.push({ ...common, type: family, x: s.grid?.x, y: s.grid?.y, z: s.grid?.z, hoverongaps: false, colorscale: "Viridis", colorbar: { title: { text: s.zColumn ? label(s.zColumn) : "Value" } } }); continue; }
    if (family === "box") { traces.push({ ...common, type: "box", x: [escape(s.name)], q1: [s.box?.[1]], median: [s.box?.[2]], q3: [s.box?.[3]], lowerfence: [s.box?.[0]], upperfence: [s.box?.[4]], boxpoints: false }); continue; }
    const horizontal = family === "bar" && p.barOrientation === "h", bubble = family === "bubble";
    const trace = { ...common, type: family === "bar" || family === "histogram" ? "bar" : "scatter", mode: family === "scatter" || bubble ? "markers" : p.lineMode ?? "lines+markers", x: points.map(v => horizontal ? v.y : v.x), y: points.map(v => horizontal ? v.x : v.y), ...(family === "bar" ? { orientation: p.barOrientation ?? "v" } : {}), ...(points.some(v => v.error !== undefined) ? { [horizontal ? "error_x" : "error_y"]: { type: "data", array: points.map(v => v.error), visible: true } } : {}), hovertemplate: `%{x}<br>%{y}${bubble ? `<br>Size: %{text} [${escape(s.sizeColumn?.unit ?? "unknown")}]` : ""}<extra>%{fullData.name}</extra>` };
    if (bubble) {
      const diameter = spec?.sizeMax ?? 36;
      Object.assign(trace, { marker: { ...common.marker, size: points.map(v => v.size !== null && v.size !== undefined && v.size > 0 ? v.size : 0), sizemode: "area", sizeref: s.sizeMaximum ? 2 * s.sizeMaximum / diameter ** 2 : 1, sizemin: 0 }, text: points.map(v => v.size ?? "missing") });
    }
    if (family === "step") trace.line = { ...common.line, ...{ shape: "hv" } };
    if (family === "area") {
      // Plotly can join fill polygons across nulls. Separate covered segments explicitly.
      let segment: typeof points = [], first = true;
      const publish = () => { if (!segment.length) return; traces.push({ ...trace, x: segment.map(v => v.x), y: segment.map(v => v.y), customdata: segment, error_y: segment.some(v => v.error !== undefined) ? { type: "data", array: segment.map(v => v.error), visible: true } : undefined, fill: "tozeroy", legendgroup: s.id, showlegend: first }); first = false; segment = []; };
      for (const point of points) { if (point.x === null || point.y === null) publish(); else segment.push(point); } publish();
      if (first) traces.push(trace);
    } else traces.push(trace);
  }
  const layout: any = { title: { text: escape(p.title) }, paper_bgcolor: theme.bg, plot_bgcolor: theme.bg, font: { color: theme.fg, family: theme.font, size: 12 }, colorway: theme.palette, margin: { l: circular ? 25 : 65, r: 30, t: 55, b: circular ? 60 : 100 }, showlegend: true, legend: { orientation: "h", y: circular ? -.08 : -.3, yanchor: "top", x: 0, ...(circular ? { itemclick: false, itemdoubleclick: false } : {}) }, barmode: p.barMode === "stack" ? "relative" : "group", hovermode: "closest", annotations: circular ? [] : (p.annotations ?? []).map(a => ({ ...a, text: escape(a.text), showarrow: true })), ...(circular ? {} : { grid: { rows: (p.panels ?? 1) > 1 ? 2 : 1, columns: p.panels === 4 ? 2 : 1, pattern: "independent" } }), uirevision: JSON.stringify([family, p.xScale, p.yScale, p.panels, p.barOrientation, p.barMode]) };
  if (!circular) for (let i = 0; i < (p.panels ?? 1); i++) {
    const suffix = i ? String(i + 1) : "", s = dataset.series.find(d => panelFor(d) === i), horizontal = family === "bar" && p.barOrientation === "h";
    const category = { title: { text: p.xLabel ? escape(p.xLabel) : s ? label(s.xColumn) : "X" }, type: family === "bar" || family === "box" || s?.xColumn.type === "text" ? "category" : p.xScale ?? "linear", ...(p.xRange ? { range: p.xRange.map(v => p.xScale === "log" ? Math.log10(v) : v) } : {}) };
    const value = { title: { text: p.yLabel ? escape(p.yLabel) : s ? label(s.yColumn) : "Y" }, type: p.yScale ?? "linear", ...(p.yRange ? { range: p.yRange.map(v => p.yScale === "log" ? Math.log10(v) : v) } : {}) };
    layout[`xaxis${suffix}`] = horizontal ? value : category;
    layout[`yaxis${suffix}`] = horizontal ? category : value;
  }
  return { traces, layout };
}
