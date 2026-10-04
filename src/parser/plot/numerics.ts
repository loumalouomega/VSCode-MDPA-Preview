import { dimensionsEqual, exponentsForUnitName } from "../fieldDimensions";
import type { PlotColumn, PlotDataset, PlotPoint, PlotRecipe, PlotSeriesData, PlotSeriesSpec, PlotTable, PlotTransform } from "./types";

const numeric = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const at = (sorted.length - 1) * q, lo = Math.floor(at), hi = Math.ceil(at);
  const weight = at - lo;
  return sorted[lo] * (1 - weight) + sorted[hi] * weight;
}
export function plotStatistics(points: PlotPoint[]): PlotSeriesData["statistics"] {
  const values = points.map(p => p.y).filter(numeric).sort((a, b) => a - b);
  // Welford avoids catastrophic cancellation and argument spreading on large tables.
  let mean = 0, m2 = 0, n = 0;
  const scale = Math.max(Math.abs(values[0] ?? 0), Math.abs(values[values.length - 1] ?? 0)) || 1;
  for (const raw of values) { const v=raw/scale; n++; const d = v - mean; mean += d / n; m2 += d * (v - mean); }
  const avg=mean*scale,std=Math.sqrt(Math.max(0,m2/n))*scale;
  return { count: n, missing: points.length - n, min: values[0] ?? null, max: values[values.length - 1] ?? null, mean: n && numeric(avg) ? avg : null, std: n && numeric(std) ? std : null, q1: quantile(values, .25), median: quantile(values, .5), q3: quantile(values, .75) };
}
function index(table: PlotTable, id: string): number {
  const i = table.columns.findIndex(c => c.id === id);
  if (i < 0) throw new Error(`Missing column "${id}".`);
  return i;
}
function segments(points: PlotPoint[], callback: (start: number, end: number) => void): void {
  let start = 0;
  while (start < points.length) {
    if (!numeric(points[start].x) || !numeric(points[start].y)) { start++; continue; }
    let end = start + 1;
    while (end < points.length && numeric(points[end].x) && numeric(points[end].y)) end++;
    callback(start, end); start = end;
  }
}
function changingUnits(y: PlotColumn, x: PlotColumn, power: number): PlotColumn {
  const d = y.dimensions && x.dimensions ? y.dimensions.map((e, i) => e + power * x.dimensions![i]) : undefined;
  // Dimension exponents do not encode scale: kPa/ms must never be relabelled Pa/s.
  return { ...y, dimensions: d, unit: y.unit && x.unit ? power < 0 ? `(${y.unit})/(${x.unit})` : `(${y.unit})·(${x.unit})` : undefined };
}
function transform(data: PlotSeriesData, t: PlotTransform): void {
  const old = data.points;
  const points = old.map(p => ({ ...p }));
  if (t.op === "convert" || t.op === "normalize") {
    const inputUnit = data.yColumn.unit;
    const factor = t.op === "convert" ? t.factor : 1 / t.divisor;
    const targetDimensions = t.op === "convert" ? t.dimensions ?? exponentsForUnitName(t.unit) : undefined;
    if (t.op === "convert" && targetDimensions && data.yColumn.dimensions && !dimensionsEqual(targetDimensions, data.yColumn.dimensions)) throw new Error("Unit conversion cannot change physical dimensions.");
    for (const p of points) { if (numeric(p.y)) p.y *= factor; if (numeric(p.error)) p.error *= Math.abs(factor); }
    data.yColumn = t.op === "convert" ? { ...data.yColumn, unit: t.unit, dimensions: targetDimensions ?? data.yColumn.dimensions } : { ...data.yColumn, unit: "1", dimensions: [0, 0, 0, 0, 0, 0, 0] };
    if (t.op === "normalize") data.diagnostics.push(`Normalized by ${t.divisor} in the input Y unit (${inputUnit ?? "unknown"}); result is an explicitly chosen ratio.`);
  } else if (t.op === "regression") {
    const good = points.filter(p => numeric(p.x) && numeric(p.y));
    if (good.length < 2) throw new Error("Regression needs at least two finite paired samples.");
    let mx = 0, my = 0;
    for (const p of good) { mx += (p.x as number) / good.length; my += p.y! / good.length; }
    let xx = 0, xy = 0, yy = 0;
    for (const p of good) { const x = (p.x as number) - mx, y = p.y! - my; xx += x*x; xy += x*y; yy += y*y; }
    if (!(xx > 0)) throw new Error("Regression X values are constant.");
    const slope = xy / xx, intercept = my - slope * mx;
    data.regression = { slope, intercept, rSquared: yy ? xy*xy/(xx*yy) : null };
    for (const p of points) if (numeric(p.x) && numeric(p.y)) { p.y = slope * p.x + intercept; p.error = undefined; }
    data.diagnostics.push("Linear least-squares fit over finite original pairs; coefficients and R² recorded. Gaps retained.");
  } else {
    if (data.xColumn.type !== "number") throw new Error(`${t.op} requires numeric X; supply physical times or select a numeric column.`);
    segments(old, (start, end) => {
      if (t.op === "smooth") {
        // Prefix sum within each covered segment: O(N), regardless of the window.
        const sums = [0]; for (let i = start; i < end; i++) sums.push(sums[sums.length - 1] + old[i].y!);
        const half = Math.floor(t.window / 2);
        for (let i = start; i < end; i++) {
          const lo = Math.max(start, i - half), hi = Math.min(end, i + half + 1);
          points[i].y = (sums[hi - start] - sums[lo - start]) / (hi - lo); points[i].error = undefined;
        }
      } else {
        for (let i = start + 1; i < end; i++) if ((old[i].x as number) <= (old[i-1].x as number)) throw new Error(`${t.op} requires strictly increasing X within each covered segment; sort or resolve duplicates explicitly.`);
        if (t.op === "integral") {
          let sum = 0; points[start].y = 0;
          for (let i = start + 1; i < end; i++) { sum += ((old[i].x as number) - (old[i-1].x as number)) * (old[i].y! + old[i-1].y!) / 2; points[i].y = sum; }
        } else {
          for (let i = start; i < end; i++) {
            const lo = Math.max(start, i - 1), hi = Math.min(end - 1, i + 1);
            points[i].y = hi === lo ? null : (old[hi].y! - old[lo].y!) / ((old[hi].x as number) - (old[lo].x as number));
          }
        }
        for (let i = start; i < end; i++) points[i].error = undefined;
      }
    });
    if (t.op !== "smooth") { data.yColumn = changingUnits(data.yColumn, data.xColumn, t.op === "derivative" ? -1 : 1); data.diagnostics.push(`${t.op}: one-sided endpoint differences / trapezoids; each gap starts a new segment.`); }
  }
  if (!["convert", "normalize"].includes(t.op) && old.some(p => p.error !== undefined)) data.diagnostics.push("Error bars are not propagated through this transformation; original supplied errors retained in raw samples.");
  const overflow = points.filter(p=>p.y!==null&&!numeric(p.y)||p.error!==null&&p.error!==undefined&&!numeric(p.error)).length;
  if (overflow) data.diagnostics.push(`${t.op}: ${overflow} nonfinite results retained as diagnosed gaps.`);
  data.points = points.map(p => ({ ...p, y: numeric(p.y) ? p.y : null, ...(p.error!==undefined?{error:numeric(p.error)?p.error:null}:{}) }));
}

/** No sorting, dropped samples or point/cell conversion hidden inside a chart. */
function seriesFromTable(table: PlotTable, spec: PlotSeriesSpec): PlotSeriesData[] {
  const xi = index(table, spec.x), yi = index(table, spec.y);
  const zi = spec.z ? index(table, spec.z) : -1, gi = spec.group ? index(table, spec.group) : -1;
  const fi = spec.filter ? index(table, spec.filter.column) : -1;
  const ei = spec.uncertainty ? index(table, spec.uncertainty.column) : -1;
  if (ei >= 0 && (table.columns[ei].type !== "number" || table.columns[ei].unit !== table.columns[yi].unit)) throw new Error("Supplied errors must be numeric and use the same supplied Y units (unknown is not a known unit); correct or convert the source column explicitly.");
  const components = spec.component ? spec.components!.map(c => index(table, c)) : [];
  for (const ci of components) {
    const a = table.columns[components[0]], b = table.columns[ci];
    if (b.type !== "number" || a.unit !== b.unit || a.dimensions && b.dimensions && !dimensionsEqual(a.dimensions, b.dimensions)) throw new Error("Magnitude requires numeric components in the same supplied units/dimensions.");
  }
  if (table.columns[yi].type !== "number") throw new Error(`Y column ${spec.y} is not numeric; correct the import mapping.`);
  const groups = new Map<string, PlotPoint[]>();
  for (let i = 0; i < table.rows.length; i++) {
    const row = table.rows[i];
    if (fi >= 0) {
      const f = spec.filter!, v = row[fi];
      if (f.equals !== undefined && String(v) !== f.equals) continue;
      if ((f.min !== undefined || f.max !== undefined) && (!numeric(v) || (f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max))) continue;
    }
    const key = gi < 0 ? "" : String(row[gi] ?? "(missing group)");
    if (!groups.has(key)) { if (groups.size >= 1000) throw new Error("Grouping is limited to 1000 groups."); groups.set(key, []); }
    const tuple = components.map(k => row[k]);
    const y = components.length ? tuple.every(numeric) ? Math.hypot(...tuple as number[]) : null : numeric(row[yi]) ? row[yi] as number : null;
    const x = numeric(row[xi]) || typeof row[xi] === "string" ? row[xi] : null;
    const error = ei >= 0 && numeric(row[ei]) && (row[ei] as number) >= 0 ? row[ei] as number : null;
    groups.get(key)!.push({ x, y, ...(tuple.length ? {components:tuple.map(v=>numeric(v)?v:null)} : {}), ...(zi >= 0 ? { z: numeric(row[zi]) ? row[zi] as number : null } : {}), ...(ei >= 0 ? { error } : {}), origin: table.origins?.[i] });
  }
  return [...groups].map(([group, points]) => {
    const diagnostics = [...table.diagnostics];
    if (!table.columns[yi].unit) diagnostics.push("Y units are unknown.");
    if (!table.columns[xi].unit) diagnostics.push("X units are unknown (not assumed seconds).");
    if (ei >= 0) diagnostics.push(`Supplied error bars: ${spec.uncertainty!.meaning}; negative/missing errors are not drawn.`);
    const baseY = table.columns[components[0] ?? yi];
    const yc = components.length ? {...baseY,label:`Magnitude (${spec.components!.join(", ")})`} : baseY;
    const data: PlotSeriesData = { id: group ? `${spec.id}:${group}` : spec.id, name: group ? `${spec.name} — ${group}` : spec.name, xColumn: { ...table.columns[xi] }, yColumn: { ...yc }, originalXColumn: { ...table.columns[xi] }, originalYColumn: { ...yc }, ...(zi >= 0 ? { zColumn: { ...table.columns[zi] } } : {}), original: points.map(p => ({ ...p })), points, diagnostics, statistics: plotStatistics(points) };
    for (const t of spec.transforms ?? []) transform(data, t);
    return data;
  });
}

function align(data: PlotSeriesData, ref: PlotSeriesData, spec: NonNullable<PlotSeriesSpec["alignment"]>): void {
  for (const c of [data.xColumn, ref.xColumn]) if (c.domain === "frameIndex" || c.domain === "stepLabel") throw new Error("Step labels/frame indices are not physical time; supply explicit physical times before reference alignment.");
  if (data.xColumn.dimensions && ref.xColumn.dimensions && !dimensionsEqual(data.xColumn.dimensions, ref.xColumn.dimensions)) throw new Error("Reference X dimensions differ; convert explicitly first.");
  if (data.xColumn.unit !== ref.xColumn.unit) throw new Error("Reference X units differ; supply a common physical-time mapping first.");
  let last = -Infinity;
  for (const p of data.points) { if (!numeric(p.x) || p.x <= last) throw new Error("Alignment requires finite, strictly increasing X; categorical/step labels need explicit physical times."); last = p.x; }
  const source = data.points;
  const xs = source.map(p => p.x as number);
  data.points = ref.points.map(r => {
    if (!numeric(r.x)) return { x: r.x, y: null };
    let lo = 0, hi = xs.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (xs[mid] < r.x) lo = mid + 1; else hi = mid; }
    const next = lo, prev = next - 1;
    if (xs[next] === r.x) return { ...source[next] };
    if (spec.method === "exact") return { x: r.x, y: null };
    const chosen = prev < 0 ? next : next >= xs.length ? prev : r.x - xs[prev] <= xs[next] - r.x ? prev : next;
    // Never extrapolate, and never interpolate across a recorded gap.
    if (prev < 0 || next >= xs.length) return { x: r.x, y: null };
    if (spec.method === "nearest") return Math.abs(xs[chosen] - r.x) <= spec.tolerance ? { ...source[chosen], x: r.x } : { x: r.x, y: null };
    const a = source[prev], b = source[next];
    if (r.x - xs[prev] > spec.tolerance || xs[next] - r.x > spec.tolerance || a.y === null || b.y === null) return { x: r.x, y: null };
    const w = (r.x - xs[prev]) / (xs[next] - xs[prev]);
    return { x: r.x, y: a.y * (1-w) + b.y * w }; // interpolated rows have no invented entity/frame identity
  });
  data.diagnostics.push(`Aligned to ${ref.name}: ${spec.method}, tolerance ${spec.tolerance}; no extrapolation. Interpolated samples are not linked to an invented mesh frame.`);
}

function grid(data: PlotSeriesData, spec: PlotSeriesSpec): void {
  if (!spec.grid) throw new Error("Heatmaps/contours require an explicit regular grid or nearest interpolation choice.");
  const locations = data.points.filter(p => numeric(p.x) && numeric(p.y));
  const samples = locations.filter(p => numeric(p.z));
  if (!samples.length) throw new Error("Grid needs finite numeric X, Y and Z samples.");
  const seen = new Set<string>();
  for (const p of locations) { const key = `${p.x},${p.y}`; if (seen.has(key)) throw new Error(`Duplicate grid sample at ${key}; aggregate explicitly first.`); seen.add(key); }
  const xs = [...new Set(samples.map(p => p.x as number))].sort((a,b) => a-b), ys = [...new Set(samples.map(p => p.y!))].sort((a,b) => a-b);
  if (spec.grid.method === "regular") {
    if (xs.length * ys.length > 65536) throw new Error("Grid exceeds the 65536-cell display budget.");
    const x = [...new Set(locations.map(p => p.x as number))].sort((a,b) => a-b), y = [...new Set(locations.map(p => p.y!))].sort((a,b) => a-b);
    if (x.length * y.length > 65536) throw new Error("Grid exceeds the 65536-cell display budget.");
    const values = new Map(locations.map(p => [`${p.x},${p.y}`, p.z ?? null]));
    data.grid = { x, y, z: y.map(v => x.map(u => values.get(`${u},${v}`) ?? null)) };
  } else {
    // Convex hull + explicit radius masks unsupported areas; not a domain-hole oracle.
    const sorted = samples.map(p => [p.x as number, p.y!] as [number,number]).sort((a,b) => a[0]-b[0] || a[1]-b[1]);
    const cross = (a: number[], b: number[], c: number[]) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
    const half = (v: [number,number][]) => { const h: [number,number][] = []; for (const p of v) { while(h.length > 1 && cross(h[h.length-2],h[h.length-1],p) <= 0) h.pop(); h.push(p); } h.pop(); return h; };
    const hull = [...half(sorted), ...half([...sorted].reverse())];
    if (hull.length < 3) throw new Error("Scattered contour samples must span a two-dimensional region.");
    if (samples.length * spec.grid.nx! * spec.grid.ny! > 50_000_000) throw new Error("Nearest gridding exceeds the operation budget; reduce grid resolution or samples.");
    const x = Array.from({length:spec.grid.nx!},(_,i)=>xs[0]+(xs[xs.length-1]-xs[0])*i/(spec.grid!.nx!-1));
    const y = Array.from({length:spec.grid.ny!},(_,i)=>ys[0]+(ys[ys.length-1]-ys[0])*i/(spec.grid!.ny!-1));
    const z = y.map(v => x.map(u => {
      if (hull.some((p,i) => cross(p,hull[(i+1)%hull.length],[u,v]) < -1e-12)) return null;
      let d = spec.grid!.radius! ** 2, value: number | null = null;
      for (const p of samples) { const dd = ((p.x as number)-u)**2+(p.y!-v)**2; if (dd <= d) { d=dd; value=p.z!; } }
      return value;
    }));
    data.grid = { x, y, z }; data.diagnostics.push(`Nearest gridding: ${x.length}×${y.length}, radius ${spec.grid.radius}; convex-hull and coverage masks, no extrapolation.`);
  }
  const missing = data.grid.z.reduce((n,row)=>n+row.filter(v=>v===null).length,0);
  if (missing) data.diagnostics.push(`${missing} uncovered grid cells are masked.`);
}

export function evaluatePlot(recipe: PlotRecipe, tables: Record<string, PlotTable>): PlotDataset {
  const result: PlotDataset = { version: 1, series: [], diagnostics: [], sources: [], recipe, partial: false, fullCount: 0 };
  const bySpec = new Map<string, PlotSeriesData[]>();
  for (const s of recipe.sources) {
    const t = tables[s.id];
    if (!t) { result.diagnostics.push(`Source ${s.id} is unavailable.`); result.partial = true; continue; }
    result.sources.push({ id:s.id,revision:t.revision,rows:t.rows.length,columns:t.columns,partial:!!t.partial }); result.partial ||= !!t.partial;
  }
  for (const spec of recipe.series) {
    try {
      if (!tables[spec.source]) throw new Error(`Missing source ${spec.source}.`);
      const data = seriesFromTable(tables[spec.source], spec); bySpec.set(spec.id,data); result.series.push(...data);
    } catch (e) { result.diagnostics.push(`Series ${spec.name} (${spec.id}): ${String(e instanceof Error ? e.message : e)}`); result.partial = true; }
  }
  // Snapshot each reference BEFORE alignment; list order must not change results.
  const references = new Map([...bySpec].map(([k,v]) => [k,v.map(d => ({...d,points:d.points.map(p=>({...p}))}))]));
  for (const spec of recipe.series) for (const data of bySpec.get(spec.id) ?? []) {
    try {
      if (spec.alignment) {
        const ref = references.get(spec.alignment.reference);
        if (ref?.length !== 1) throw new Error("Alignment reference must resolve to one ungrouped series.");
        align(data,ref[0],spec.alignment);
      }
      const family = recipe.presentation.family;
      if (recipe.presentation.xScale === "log" && (data.xColumn.type === "text" || family === "bar" || family === "box")) throw new Error("Categorical X cannot use a log scale; choose numeric X and a line/scatter plot, or use a linear category axis.");
      if (family === "heatmap" || family === "contour") grid(data,spec);
      if (family === "histogram") {
        const values = data.points.map(p=>p.y).filter(numeric), stats = plotStatistics(data.points);
        const bins = spec.bins ?? 20, lo = stats.min ?? 0, hi = stats.max ?? 1, width = hi > lo ? (hi-lo)/bins : 1;
        const counts = new Array<number>(bins).fill(0);
        for (const v of values) counts[Math.min(bins-1,Math.floor((v-lo)/width))]++;
        data.xColumn = {...data.yColumn}; data.yColumn = {id:"count",label:"Count",type:"number",unit:"1",dimensions:[0,0,0,0,0,0,0]};
        data.points = counts.map((n,i)=>({x:lo+(i+.5)*width,y:n})); data.diagnostics.push(`Histogram: ${bins} equal-width bins; last bin includes the upper endpoint. ${stats.missing} missing samples excluded explicitly.`);
      }
      if (family === "bar") {
        const groups = new Map<string, number[]>();
        for (const p of data.points) if (p.x !== null && numeric(p.y)) { const key=String(p.x); if (!groups.has(key)) groups.set(key,[]); groups.get(key)!.push(p.y); }
        const statistic=spec.statistic??"mean";
        data.points = [...groups].map(([x,values])=> { let sum=0,min=Infinity,max=-Infinity;for(const v of values){sum+=v;min=Math.min(min,v);max=Math.max(max,v);}return {x,y:statistic==="count"?values.length:statistic==="sum"?sum:statistic==="min"?min:statistic==="max"?max:sum/values.length}; });
        if (statistic === "count") data.yColumn = {id:"count",label:"Count",type:"number",unit:"1",dimensions:[0,0,0,0,0,0,0]};
        data.diagnostics.push(`Grouped bars: ${statistic}; only finite samples contribute, empty categories are not zero.`);
      }
      data.statistics = plotStatistics(data.grid ? data.points.map(p=>({...p,y:p.z??null})) : data.points);
      if (data.grid) data.diagnostics.push("Grid statistics describe source Z samples, not repeated interpolated cells.");
      if (family === "box" && data.statistics.count) {
        const st=data.statistics, lo=st.q1!-1.5*(st.q3!-st.q1!),hi=st.q3!+1.5*(st.q3!-st.q1!);
        const v=data.points.map(p=>p.y).filter(numeric).filter(n=>n>=lo&&n<=hi).sort((a,b)=>a-b);
        data.box=[v[0],st.q1!,st.median!,st.q3!,v[v.length-1]];
        data.diagnostics.push("Box: linear-interpolated quartiles, whiskers at samples within 1.5 IQR; distribution is not uncertainty.");
      }
      let invalid=0;
      for (const p of data.points) if ((recipe.presentation.xScale==="log" && numeric(p.x) && p.x<=0)||(recipe.presentation.yScale==="log"&&numeric(p.y)&&p.y<=0)) { invalid++; }
      if (invalid) data.diagnostics.push(`${invalid} nonpositive samples cannot be displayed on log axes; retained in numeric export, drawn as gaps.`);
    } catch (e) { result.diagnostics.push(`Series ${spec.name} (${spec.id}): ${e instanceof Error?e.message:String(e)}`); result.series=result.series.filter(d=>d!==data); result.partial=true; }
  }
  // Comparable overlays must state common units; a relabel is never a conversion.
  for (let i=0;i<recipe.series.length;i++) for (let j=0;j<i;j++) {
    const a=recipe.series[i],b=recipe.series[j]; if ((a.panel??0)!==(b.panel??0)) continue;
    const da=bySpec.get(a.id)?.[0], db=bySpec.get(b.id)?.[0]; if(!da||!db)continue;
    for (const axis of ["xColumn", "yColumn"] as const) if (da[axis].dimensions && db[axis].dimensions && !dimensionsEqual(da[axis].dimensions!,db[axis].dimensions!) || da[axis].unit !== db[axis].unit || da[axis].type !== db[axis].type) {
      result.diagnostics.push(`Series ${a.name}: ${axis === "xColumn" ? "X" : "Y"} units/dimensions differ from ${b.name}; convert explicitly or place in a separate panel.`); result.series=result.series.filter(d=>!bySpec.get(a.id)?.includes(d)); result.partial=true;
    }
  }
  result.fullCount=result.series.reduce((n,s)=>n+(s.grid?s.grid.x.length*s.grid.y.length:s.points.length),0);
  return result;
}

/** Gap-aware display sampling only; statistics/exports use the unsampled dataset. */
export function displayPlot(dataset: PlotDataset, budget=5000): PlotDataset {
  const per=Math.max(8,Math.floor(budget/Math.max(1,dataset.series.length)));
  const series=dataset.series.map(s=> {
    const family = dataset.recipe.presentation.family;
    if (family === "box" || family === "heatmap" || family === "contour") return {...s,points:s.points.slice(0,Math.min(100,per)),original:[]};
    if(s.points.length<=per || family === "histogram" || family === "bar")return s;
    const step=Math.ceil(s.points.length/Math.max(1,Math.floor(per/5))),points:PlotPoint[]=[];
    for(let i=0;i<s.points.length;i+=step){
      const end=Math.min(s.points.length,i+step);let min=i,max=i,gap=-1;
      for(let j=i;j<end;j++){const p=s.points[j];if(p.x===null||p.y===null){gap=j;continue;}if(s.points[min].y===null||p.y<s.points[min].y!)min=j;if(s.points[max].y===null||p.y>s.points[max].y!)max=j;}
      // Preserve source order. Buckets with any gap are entirely masked: never bridge a missing interval.
      if(gap>=0)points.push({x:null,y:null});
      else for(const j of [...new Set([i,min,max,end-1])].sort((a,b)=>a-b))points.push(s.points[j]);
    }
    return {...s,points,original:[],diagnostics:[...s.diagnostics,`Display sampling: ${points.length} of ${s.points.length}; gap and bucket extrema retained. Numeric export/statistics remain full resolution.`]};
  });
  // The renderer needs mappings/style, not a second copy of an inline source's raw rows.
  const recipe = {...dataset.recipe,sources:dataset.recipe.sources.map(s=>s.type==="inline"?{...s,table:{...s.table,rows:[],origins:undefined,diagnostics:[...(s.table.diagnostics??[]),"Inline rows omitted from display delivery; the host/recipe retains full data."]}}:s)};
  return {...dataset,recipe,series:series.map(s=>({...s,original:[]})),displayCount:series.reduce((n,s)=>n+(s.grid?s.grid.x.length*s.grid.y.length:s.points.length),0)};
}
