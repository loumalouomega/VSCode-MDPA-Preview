/** Small UI inventory and recipe presets; no DOM or host I/O. */
import { fieldUnitLabel } from "../fieldDimensions";
import { emptyPlotRecipe } from "./recipe";
import type { MdpaModel, FieldBlockKind } from "../types";
import type { PlotRecipe, PlotRegionSource, PlotSource } from "./types";

export interface FemPlotContext {
  path: string; frameIndex: number; hasTimeline: boolean;
  /** Provider-local timeline/rank/resampling identity, not a claim of run ownership. */
  timelineId?: string;
  /** `${kind}:${variable}` of the field currently displayed in the focused pane, if any. View-only hint so a plot defaults to what the mesh is showing. */
  displayedKey?: string;
  fields: { variable:string; kind:FieldBlockKind; components:number; unit?:string }[];
  parts: { path:string; nodes:number; elements:number; conditions:number }[];
}
export function plotFieldKey(kind: FieldBlockKind, variable: string): string {
  return `${kind}:${variable}`;
}
export function defaultPlotFieldKey(fields: FemPlotContext["fields"], displayedKey?: string): string {
  if (displayedKey && fields.some(f => plotFieldKey(f.kind, f.variable) === displayedKey)) return displayedKey;
  const first = fields.find(f => f.variable === "DISPLACEMENT") ?? fields.find(f => f.variable === "PRESSURE") ?? fields[0];
  return first ? plotFieldKey(first.kind, first.variable) : "";
}
export function femPlotContext(path:string, model:MdpaModel|undefined, frameIndex=0, hasTimeline=false, displayedKey?: string):FemPlotContext {
  const parts:FemPlotContext["parts"]=[];
  const walk=(p:NonNullable<MdpaModel>["subModelParts"][number])=>{parts.push({path:p.path,nodes:p.nodeIds.length,elements:p.elementIds.length,conditions:p.conditionIds.length});p.children.forEach(walk);};model?.subModelParts.forEach(walk);
  return {path,frameIndex,hasTimeline,parts,fields:model?.fields.map(f=>({variable:f.variable,kind:f.kind,components:f.components,unit:model.source?.units?.fields?.[f.variable]??fieldUnitLabel(f)}))??[],...(displayedKey?{displayedKey}:{})};
}
export function appendFemCurve(recipe:PlotRecipe, source:PlotSource, component:number|"magnitude", components:number, name:string):PlotRecipe {
  const next=JSON.parse(JSON.stringify(recipe)) as PlotRecipe;
  const current=source.type==="region"&&source.scope==="current";
  const family=current?"bar":"line";
  if(next.series.length&&next.sources.some(s=>(s.type==="region"&&s.scope==="current")!==current&&s.type!=="inline"&&s.type!=="table"))throw new Error("Current-frame regional bars and history/profile curves use different domains. Remove the existing curves before changing scope; Advanced supports explicit table mappings.");
  next.sources.push(source);
  const magnitude=component==="magnitude"&&components>1;
  next.series.push({id:`curve:${source.id}`,source:source.id,name,x:current?"region":source.type==="probe"?"distance":"time",y:`v${typeof component==="number"?component:0}`,...(magnitude?{component:"magnitude",components:Array.from({length:components},(_,i)=>`v${i}`)}:{}),color:["#4e9af1","#f29d49","#57bf8a","#bb86fc","#e56b8a"][next.series.length%5]});
  if(next.series.length===1){next.presentation.family=family;next.presentation.title=name;}
  return next;
}
export function regionResultWidth(source:PlotRegionSource, fieldWidth:number):number {
  return ["pressureForce","pressureMoment","reactionMoment"].includes(source.operation)?3:source.operation==="sum"?fieldWidth:1;
}
export { emptyPlotRecipe };
