/** Host extraction shared by the plot worker and MCP. Never drives a viewport. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { prepareTable, componentColumnNames } from "../dataTable";
import { exponentsForUnitName } from "../fieldDimensions";
import { PlotTableCache } from "./cache";
import { collectFieldSeries, discoverSeriesSteps } from "../fieldSeriesScan";
import { parseMeshFile } from "../meshFileParser";
import { probeAlongPath } from "../pathProbe";
import type { MdpaModel } from "../types";
import { parsePlotTable, PLOT_MAX_BYTES, PLOT_MAX_ROWS } from "./importTable";
import { evaluatePlot } from "./numerics";
import type { PlotColumn, PlotDataset, PlotExecution, PlotRecipe, PlotSource, PlotTable } from "./types";

const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
function column(label: string, i: number): PlotColumn {
  const m=label.match(/^(.*?)\s*\[([^\]]+)\]$/);
  return {id:`c${i}`,label:m?.[1]??label,type:"number",...(m?{unit:m[2]}:{})};
}
export function meshPlotTable(model: MdpaModel, source: Extract<PlotSource,{type:"mesh"}>): PlotTable {
  // Unlike the generic table, a scientific plot must not use overlapping IDs as
  // evidence of a Geometrical field association that the model does not store.
  const associated = source.kind === "Geometries" ? { ...model, fields: [] } : model;
  const view=prepareTable(associated,source.kind,{submodelpart:source.submodelpart});
  if(view.rowCount>PLOT_MAX_ROWS&&!source.ids)throw new Error(`Mesh table exceeds ${PLOT_MAX_ROWS} rows; select entity IDs or a SubModelPart first.`);
  const columns=view.columns.map(column);
  for(let i=0;i<columns.length;i++){columns[i].type=view.columnTypes[i]==="text"?"text":"number";columns[i].id=`${source.kind}:${columns[i].label}`;}
  if (columns[0]) columns[0].domain = "entityId";
  for (const c of columns) if (["X", "Y", "Z", "x", "y", "z"].includes(c.label) && model.source?.units?.coords) {
    c.unit = model.source.units.coords; c.dimensions = exponentsForUnitName(c.unit);
  }
  const fieldKind=source.kind==="Nodes"?"Nodal":source.kind==="Conditions"?"Conditional":"Elemental";
  for(const f of model.fields.filter(f=>f.kind===fieldKind)) {
    for(const [component,name] of componentColumnNames(f.variable,f.components).entries()) {
      const c=columns.find(c=>c.label===name);if(c){
        c.id=`field:${fieldKind}:${encodeURIComponent(f.variable)}:${component}`;
        c.unit = model.source?.units?.fields?.[f.variable] ?? c.unit;
        c.dimensions = f.dimensions?.exponents.slice() ?? (c.unit ? exponentsForUnitName(c.unit) : undefined);
      }
    }
  }
  const selected=source.ids?new Set(source.ids):undefined;
  const rows: PlotTable["rows"] = [], origins: NonNullable<PlotTable["origins"]> = [];
  for(let i=0;i<view.rowCount;i++) {
    const row=view.row(i),id=Number(row[0]);if(selected&&!selected.has(id))continue;
    rows.push(row.map(v=>v===undefined||typeof v==="number"&&!Number.isFinite(v)?null:v));
    origins.push({source:source.id,entityKind:source.kind,entityId:id});
  }
  const diagnostics = [`Association: ${source.kind}; no point/cell conversion.`,"Current-frame snapshots include applied edits; file/history sources use disk values."];
  if(source.submodelpart&&rows.length===0)diagnostics.push(`SubModelPart ${source.submodelpart} is empty or missing.`);
  if(source.kind==="Geometries")diagnostics.push("Geometries have no dedicated field association; Elemental fields are deliberately excluded, even when IDs overlap.");
  return {columns,rows,origins,diagnostics};
}

export async function loadPlotSource(source: PlotSource, opts: PlotExecution = {}, cache?: PlotTableCache): Promise<PlotTable> {
  opts.signal?.throwIfAborted();
  if(source.type==="inline")return {...source.table,origins:source.table.rows.map((_,rowIndex)=>({...source.table.origins?.[rowIndex],source:source.id,rowIndex})),diagnostics:source.table.diagnostics??[]};
  const snapshot = opts.models?.[source.id];
  const stat=snapshot ? { size: 0 } : await fs.stat(source.path);
  if(stat.size>PLOT_MAX_BYTES&&!opts.models?.[source.id])throw new Error("Plot source exceeds the 128 MiB file budget; use a smaller table or selected live-mesh snapshot.");
  if(source.type==="table") {
    const bytes=await fs.readFile(source.path);opts.signal?.throwIfAborted();
    if (bytes.length > PLOT_MAX_BYTES) throw new Error("Table exceeds the 128 MiB import budget.");
    const revision = hash(bytes), key = hash(JSON.stringify([revision,source.options ?? {}]));
    const hit = cache?.get(key);
    const table = hit ?? parsePlotTable(bytes.toString("utf8"),source.options);
    table.revision=revision;
    if (!hit) cache?.set(key, table);
    return {...table, origins: table.rows.map((_, rowIndex) => ({source:source.id,rowIndex}))};
  }
  if(source.type==="history") {
    const {steps,source:kind}=await discoverSeriesSteps(source.path);
    if(steps.length>5000)throw new Error("Histories are limited to 5000 frames; choose a bounded source series.");
    if(source.times&&source.times.length!==steps.length)throw new Error("Explicit physical times must have one value per frame.");
    const series=await collectFieldSeries(steps,source,{signal:opts.signal,onProgress:(done,total,label)=>opts.progress?.(done,total,label)});
    const physical=!!source.times||kind==="inFile";
    const times=source.times??(physical?steps.map(s=>Number(s.label)):undefined);
    const timeUnit = source.timeUnit ?? series.timeUnit;
    const columns:PlotColumn[]=[{id:"time",label:physical?"Physical time":"Step label",type:physical?"number":"text",domain:physical?"physicalTime":"stepLabel",...(physical && timeUnit?{unit:timeUnit}:{})},{id:"frame",label:"Frame index",type:"number",domain:"frameIndex"},...series.componentNames.map((name,i)=>({id:`v${i}`,label:name,type:"number" as const,...(series.unit?{unit:series.unit,dimensions:series.dimensions ?? exponentsForUnitName(series.unit)}:{})}))];
    if(physical && timeUnit) columns[0].dimensions=exponentsForUnitName(timeUnit);
    const diagnostics=["History reads disk values without replaying edit history.",...series.errors.map(e=>`${e.label}: ${e.message}`)];
    if(!physical)diagnostics.push("Filename steps are not assumed physical time; supply explicit times before cross-run time alignment.");
    if(series.topologyChangedAt!==undefined)diagnostics.push(`Topology size changes at sample ${series.topologyChangedAt}; entity identity may not survive remeshing.`);
    if(series.missingId)diagnostics.push(`${series.missingId} missing entity samples.`);
    if(series.missingField)diagnostics.push(`${series.missingField} missing field samples.`);
    if (!series.components) throw new Error(`Field ${source.variable} / ${source.kind} entity ${source.entityId} has no samples. ${diagnostics.join(" ")}`);
    const table:PlotTable={columns,rows:series.values.map((v,i)=>[times?.[i]??series.labels[i],series.frameIndices[i],...Array.from({length:series.components},(_,c)=>v&&Number.isFinite(v[c])?v[c]:null)]),origins:series.frameIndices.map((frameIndex,i)=>({source:source.id,entityKind:source.kind==="Nodal"?"Nodes":source.kind==="Conditional"?"Conditions":"Elements",entityId:source.entityId,frameIndex,...(times?{time:times[i]}:{}),...(source.runId?{runId:source.runId}:{})})),diagnostics,partial:series.cancelled||series.errors.length>0};
    table.revision=hash(JSON.stringify(table.rows));return table;
  }
  const model=opts.models?.[source.id]??await parseMeshFile(source.path,undefined,{timeStep:source.timeStep});
  opts.signal?.throwIfAborted();
  if(source.type==="mesh") {
    const table=meshPlotTable(model,source);table.revision=hash(JSON.stringify(table.rows));return table;
  }
  const probe=await probeAlongPath(model,source);
  const field = model.fields.find(f => f.kind === "Nodal" && f.variable === source.variable);
  const unit = model.source?.units?.fields?.[source.variable] ?? probe.unit;
  return {columns:[{id:"distance",label:"Distance",type:"number",...(model.source?.units?.coords?{unit:model.source.units.coords,dimensions:exponentsForUnitName(model.source.units.coords)}:{})},...probe.columns.map((name,i)=>({id:`v${i}`,label:name,type:"number" as const,...(unit?{unit,dimensions:field?.dimensions?.exponents.slice() ?? exponentsForUnitName(unit)}:{})}))],rows:probe.rows.map(r=>[r.distance,...r.values.map(v=>v!==null&&Number.isFinite(v)?v:null)]),origins:probe.rows.map((_,rowIndex)=>({source:source.id,rowIndex})),diagnostics:[`${probe.uncovered} of ${probe.rows.length} probe samples are uncovered; gaps retained.`,"Nodal field sampled at fixed spatial coordinates; no implicit cell averaging."],revision:hash(JSON.stringify(probe.rows))};
}

export async function collectPlot(recipe: PlotRecipe, opts: PlotExecution = {}, cache?: PlotTableCache): Promise<PlotDataset> {
  const tables:Record<string,PlotTable>=Object.create(null), errors:string[]=[];
  for(let i=0;i<recipe.sources.length;i++) {
    if(opts.signal?.aborted)break;
    const s=recipe.sources[i];opts.progress?.(i,recipe.sources.length,`Reading ${s.id}`);
    try { tables[s.id]=await loadPlotSource(s,opts,cache); }
    catch(e){ errors.push(`Source ${s.id}: ${e instanceof Error?e.message:String(e)}`); }
  }
  const result=evaluatePlot(recipe,tables);result.diagnostics.unshift(...errors);result.partial||=!!opts.signal?.aborted;
  opts.progress?.(recipe.sources.length,recipe.sources.length,"Plot dataset ready");return result;
}

/** Recipe paths are relative to the recipe, not to whichever mesh is active. */
export function resolvePlotPaths(recipe: PlotRecipe, directory: string): PlotRecipe {
  return {...recipe,sources:recipe.sources.map(s=>s.type==="inline"?s:{...s,path:path.resolve(directory,s.path)})};
}
