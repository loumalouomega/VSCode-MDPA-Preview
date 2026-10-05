/** Host extraction shared by the plot worker and MCP. Never drives a viewport. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { prepareTable, componentColumnNames } from "../dataTable";
import { exponentsForUnitName } from "../fieldDimensions";
import { PlotTableCache } from "./cache";
import { discoverSeriesSteps } from "../fieldSeriesScan";
import { sampleFieldAt, type SeriesStep } from "../fieldSeries";
import { timelineKindFor } from "../meshFormats";
import { sampleRegion } from "./region";
import { parseMeshFile } from "../meshFileParser";
import { probeAlongPath } from "../pathProbe";
import type { MdpaModel } from "../types";
import { parsePlotTable, PLOT_MAX_BYTES, PLOT_MAX_ROWS } from "./importTable";
import { evaluatePlot } from "./numerics";
import type { PlotColumn, PlotDataset, PlotExecution, PlotRecipe, PlotSource, PlotTable, PlotRegionSource } from "./types";

const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
type HistorySource = Extract<PlotSource,{type:"history"}> | PlotRegionSource;

/** One model resident and one parse per frame for every point/region in a case. */
export async function loadPlotHistories(sources: HistorySource[], opts: PlotExecution = {}, publish?: (tables:Record<string,PlotTable>)=>void): Promise<Record<string,PlotTable>> {
  const {steps,source:kind}=await discoverSeriesSteps(sources[0].path);
  return collectPlotHistorySteps(sources,steps,kind==="inFile",opts,publish);
}

/** Discovery-free scan also makes the one-load-per-frame and metadata contracts testable. */
export async function collectPlotHistorySteps(sources: HistorySource[],steps:SeriesStep[],inFile:boolean,opts:PlotExecution={},publish?:(tables:Record<string,PlotTable>)=>void):Promise<Record<string,PlotTable>> {
  if(steps.length>5000)throw new Error("Histories are limited to 5000 frames.");
  const tables:Record<string,PlotTable>=Object.create(null), widths=new Map<string,number>(),incomplete=new Set<string>(),seen=new Map<string,Set<string>>();
  const timeUnits=new Map<string,string|undefined>();
  for(const source of sources) {
    seen.set(source.id,new Set());
    if(source.times&&source.times.length!==steps.length)throw new Error(`Source ${source.id}: physical times must have one value per frame.`);
    const physical=!!source.times||inFile;
    tables[source.id]={columns:[{id:"time",label:physical?"Physical time":"Step label",type:physical?"number":"text",domain:physical?"physicalTime":"stepLabel",...(source.timeUnit?{unit:source.timeUnit,dimensions:exponentsForUnitName(source.timeUnit)}:{})},{id:"frame",label:"Frame index",type:"number",domain:"frameIndex"}],rows:[],origins:[],diagnostics:["History reads disk values without replaying mesh edits.",...(!physical?["Filename steps are not physical time; supply a physical-time mapping for alignment."]:[])],partial:true};
  }
  let previousPublish=0, fingerprint:string|undefined;
  for(let i=0;i<steps.length;i++) {
    opts.signal?.throwIfAborted();const step=steps[i];opts.progress?.(i,steps.length,step.label);
    let model:MdpaModel|undefined, error:string|undefined;
    try {model=await step.load();}catch(e){error=e instanceof Error?e.message:String(e);}
    const identity=model?`${model.nodeCount}:${model.blocks.reduce((n,b)=>n+b.count,0)}`:undefined;
    const changed=identity!==undefined&&fingerprint!==undefined&&identity!==fingerprint;if(identity!==undefined)fingerprint??=identity;
    for(const source of sources) {
      const table=tables[source.id], physical=!!source.times||inFile;
      let time:number|string|null=source.times?.[i]??(physical?Number(step.label):step.label);
      let values:(number|null)[]|undefined, columns:PlotColumn[]|undefined, origin:NonNullable<PlotTable["origins"]>[number]={source:source.id,frameIndex:step.frameIndex,...(physical?{time:Number(time)}:{}),...(source.runId?{runId:source.runId}:{})};
      try {
        if(!model)throw new Error(error);
        const timeUnit=source.timeUnit??(physical?model.source?.units?.time:undefined);
        if(timeUnits.has(source.id)&&timeUnits.get(source.id)!==timeUnit){time=null;throw new Error("Time units changed; supply a consistent explicit physical-time mapping.");}
        if(changed)table.diagnostics.push(`${step.label}: topology size changed; point identity is not a remeshing correspondence.`);
        if(source.type==="region") {
          const sample=sampleRegion(model,source);values=sample.values;columns=[...sample.columns,{id:"covered",label:"Covered measure/entities",type:"number"},{id:"measure",label:"Total measure/entities",type:"number"}];values.push(sample.covered,sample.measure);origin={...sample.origin,...origin};
          if(sample.partial)incomplete.add(source.id);
          for(const d of sample.diagnostics)if(!seen.get(source.id)!.has(d)&&table.diagnostics.length<1024){seen.get(source.id)!.add(d);table.diagnostics.push(`${step.label}: ${d}`);}
        } else {
          const sample=sampleFieldAt(model,source);if(typeof sample==="string")throw new Error(sample==="no-id"?`Entity ${source.entityId} is missing.`:`Field ${source.variable} is missing.`);
          values=sample.values.map(v=>Number.isFinite(v)?v:null);columns=componentColumnNames(source.variable,sample.components).map((label,k)=>({id:`v${k}`,label,type:"number",...(sample.unit?{unit:sample.unit}:{}),...(sample.dimensions||sample.unit?{dimensions:sample.dimensions??exponentsForUnitName(sample.unit!)}:{})}));
          origin.entityKind=source.kind==="Nodal"?"Nodes":source.kind==="Elemental"?"Elements":"Conditions";origin.entityId=source.entityId;
        }
        if(!widths.has(source.id)) {widths.set(source.id,values.length);timeUnits.set(source.id,timeUnit);if(physical&&timeUnit){table.columns[0].unit=timeUnit;table.columns[0].dimensions=exponentsForUnitName(timeUnit);}table.columns.push(...columns);for(const r of table.rows)r.push(...new Array(values.length).fill(null));}
        else if(JSON.stringify(table.columns.slice(2))!==JSON.stringify(columns))throw new Error("Field width, units or dimensions changed; sample retained as a gap.");
      }catch(e){values=undefined;table.diagnostics.push(`${step.label}: ${e instanceof Error?e.message:String(e)}`);}
      table.rows.push([time,step.frameIndex,...(values??new Array(widths.get(source.id)??0).fill(null))]);table.origins!.push(origin);
    }
    if(publish&&(Date.now()-previousPublish>200||i===steps.length-1)){publish(tables);previousPublish=Date.now();}
  }
  for(const source of sources) {const table=tables[source.id];table.partial=incomplete.has(source.id)||table.rows.some(r=>r.slice(2).some(v=>v===null))||!widths.has(source.id);table.revision=hash(JSON.stringify(table.rows));}
  return tables;
}

async function currentPlotModel(source:Extract<PlotSource,{type:"mesh"|"probe"|"region"}>,snapshot?:MdpaModel):Promise<MdpaModel> {
  if(snapshot)return snapshot;
  if(source.timeStep!==undefined&&timelineKindFor(source.path)==="filename") {
    const {steps}=await discoverSeriesSteps(source.path);
    const step=steps.find(s=>s.frameIndex===source.timeStep);
    if(!step)throw new Error(`Frame ${source.timeStep} is unavailable in this source timeline.`);
    return step.load();
  }
  return parseMeshFile(source.path,undefined,{timeStep:source.timeStep});
}
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
  if(source.type==="history" || source.type==="region"&&source.scope==="history") return (await loadPlotHistories([source],opts))[source.id];
  if(source.type==="region") {
    const model=await currentPlotModel(source,snapshot);
    const sample=sampleRegion(model,source);
    return {columns:[{id:"region",label:"Region",type:"text"},...sample.columns,{id:"covered",label:"Covered measure/entities",type:"number"},{id:"measure",label:"Total measure/entities",type:"number"}],rows:[[source.submodelpart??"Whole mesh",...sample.values,sample.covered,sample.measure]],origins:[{...sample.origin,frameIndex:source.timeStep}],diagnostics:sample.diagnostics,partial:sample.partial,revision:hash(JSON.stringify([sample.values,sample.covered,sample.measure]))};
  }
  const model=await currentPlotModel(source,snapshot);
  opts.signal?.throwIfAborted();
  if(source.type==="mesh") {
    const table=meshPlotTable(model,source);table.revision=hash(JSON.stringify(table.rows));return table;
  }
  const probe=await probeAlongPath(model,source);
  const field = model.fields.find(f => f.kind === "Nodal" && f.variable === source.variable);
  const unit = model.source?.units?.fields?.[source.variable] ?? probe.unit;
  return {columns:[{id:"distance",label:"Distance",type:"number",...(model.source?.units?.coords?{unit:model.source.units.coords,dimensions:exponentsForUnitName(model.source.units.coords)}:{})},...probe.columns.map((name,i)=>({id:`v${i}`,label:name,type:"number" as const,...(unit?{unit,dimensions:field?.dimensions?.exponents.slice() ?? exponentsForUnitName(unit)}:{})}))],rows:probe.rows.map(r=>[r.distance,...r.values.map(v=>v!==null&&Number.isFinite(v)?v:null)]),origins:probe.rows.map((_,rowIndex)=>({source:source.id,rowIndex,frameIndex:source.timeStep})),diagnostics:[`${probe.uncovered} of ${probe.rows.length} probe samples are uncovered; gaps retained.`,"Nodal field sampled at fixed spatial coordinates; no implicit cell averaging.",`Probe extraction parameters: ${JSON.stringify(source)}`],revision:hash(JSON.stringify(probe.rows))};
}

/** Session-only fixed extractions; not a persistent or file-change-aware mesh cache. */
export interface PlotRetention { cache: PlotTableCache; reuseSources?: string[] }
const extractionKey = (source: PlotSource) => hash(JSON.stringify(source));
export async function collectPlot(recipe: PlotRecipe, opts: PlotExecution = {}, cache?: PlotTableCache, retention?: PlotRetention): Promise<PlotDataset> {
  const tables:Record<string,PlotTable>=Object.create(null), errors:string[]=[];
  for (const id of retention?.reuseSources ?? []) {
    const source = recipe.sources.find(s => s.id === id);
    const table = source && retention!.cache.get(extractionKey(source));
    // Never secretly re-scan a large history during ordinary frame scrubbing.
    if (!table) throw new Error(`Source ${id}: fixed extraction is unavailable within the retention budget (or was cancelled). Refresh explicitly or reduce fixed source size/count before following the timeline.`);
    tables[id] = table;
  }
  const scanned=new Set<string>();
  for(let i=0;i<recipe.sources.length;i++) {
    if(opts.signal?.aborted)break;
    const s=recipe.sources[i];opts.progress?.(i,recipe.sources.length,`Reading ${s.id}`);
    if(scanned.has(s.id)||tables[s.id])continue;
    try {
      if(s.type==="history"||s.type==="region"&&s.scope==="history") {
        const batch=recipe.sources.filter((v):v is HistorySource=>!tables[v.id]&&(v.type==="history"||v.type==="region"&&v.scope==="history")&&path.resolve(v.path)===path.resolve(s.path));
        for(const item of batch)scanned.add(item.id);
        Object.assign(tables,await loadPlotHistories(batch,opts,partial=>{
          Object.assign(tables,partial);
          const data=evaluatePlot(recipe,{...tables,...partial});data.partial=true;data.diagnostics.unshift("Collection in progress; statistics cover only published samples.");opts.partial?.(data);
        }));
      } else tables[s.id]=await loadPlotSource(s,opts,cache);
    }
    catch(e){ errors.push(`Source ${s.id}: ${e instanceof Error?e.message:String(e)}`); }
  }
  if (retention) for (const source of recipe.sources) if (tables[source.id] && !(source.type==="probe"&&source.followTimeline) && !retention.reuseSources?.includes(source.id)) retention.cache.set(extractionKey(source),tables[source.id]);
  const result=evaluatePlot(recipe,tables);result.diagnostics.unshift(...errors);result.partial||=!!opts.signal?.aborted;
  opts.progress?.(recipe.sources.length,recipe.sources.length,"Plot dataset ready");return result;
}

/** Recipe paths are relative to the recipe, not to whichever mesh is active. */
export function resolvePlotPaths(recipe: PlotRecipe, directory: string): PlotRecipe {
  return {...recipe,sources:recipe.sources.map(s=>s.type==="inline"?s:{...s,path:path.resolve(directory,s.path)})};
}
