import { emptyPlotRecipe, validatePlotRecipe } from "../../src/parser/plot/recipe";
import { type PlotFamily, type PlotColumn, type PlotDataset, type PlotOrigin, type PlotRecipe, type PlotSeriesSpec, type PlotSource, type PlotTable, type PlotTransform } from "../../src/parser/plot/types";
import { Plotly, renderPlotChart, type PlotElement } from "./chart";
import { appendFemCurve, defaultPlotFieldKey, regionResultWidth, type FemPlotContext } from "../../src/parser/plot/fem";
import { REGION_OPERATIONS, type PlotRegionSource } from "../../src/parser/plot/types";
import { glyph, type UiGlyphId } from "../../src/uiGlyphs";
import { CHART_CHOICES } from "./catalog";
export interface PlotBridge { postMessage(v:unknown):void; setState(v:unknown):void }
export function mountPlotWorkspace(root:HTMLElement,vscode:PlotBridge,options:{embedded?:boolean;onPickPoints?(active:boolean):void;onRegion?(path:string):void}={}) {
const element=(id:string)=>root.querySelector<HTMLElement>(`#${id}`)!;
const config=element("plot-config"),actions=element("plot-actions"),chart=element("plot-chart") as PlotElement,status=element("plot-status");
let recipe=emptyPlotRecipe(),requestId=0,dataset:PlotDataset|undefined,timer:ReturnType<typeof setTimeout>|undefined;
let collectionActive=false,followRequest=false;
let chartChosen=false,pickerOpen=false;
const followBindings=new Map<string,string>();
let rendering = Promise.resolve();
const canLocate=(origin:PlotOrigin|undefined)=>{
  if(!origin||!(origin.submodelpart||origin.entityKind&&origin.entityId!==undefined))return false;
  const source=recipe.sources.find(s=>s.id===origin.source);
  return source?.run?origin.runId===source.run.runId&&origin.sourceRevision===source.run.sourceRevision&&origin.frameIndex!==undefined:!origin.runId;
};
function draw(data: PlotDataset) {
  const id = requestId;
  rendering = rendering.catch(() => undefined).then(async () => {
    if (id !== requestId || dataset !== data) return;
    await renderPlotChart(chart, data, p => { if (id === requestId && canLocate(p.origin)) post({type:"plotPick",origin:p.origin}); });
    if (id === requestId) { chart.removeAttribute("aria-busy"); chart.style.opacity = "1"; }
  }).catch(e => { if (id === requestId) status.textContent = String(e); });
}
const inventories=new Map<string,PlotColumn[]>();
const post=(message:unknown)=>vscode.postMessage(message);
let context:FemPlotContext|undefined,pickMode=false,picked:{kind:"Nodal"|"Elemental"|"Conditional";id:number}|undefined;
let target="point",fieldKey="",region="",operation:PlotRegionSource["operation"]="max",component:number|"magnitude"="magnitude",scope:"current"|"history"="history",referencePoint:[number,number,number]|undefined,thickness:number|undefined,pressureDensity:number|undefined;
let orientation:"outward"|"winding"="outward",pressureOffset=0;
const operationLabels:Record<string,string>={min:"Minimum",max:"Maximum",mean:"Entity mean",sum:"Sum / support reactions",boundaryMean:"Boundary mean pressure",boundaryIntegral:"Boundary scalar integral",pressureForce:"Pressure force",pressureMoment:"Pressure moment",flux:"Flow / heat flux",reactionMoment:"Reaction moment"};
const selectedField=()=>context?.fields.find(f=>`${f.kind}:${f.variable}`===fieldKey);
function applyRecipe(next:PlotRecipe){try{recipe=validatePlotRecipe(next);renderConfig();renderQuick();schedule();}catch(e){status.textContent=e instanceof Error?e.message:String(e);}}
function appendCurve(source:PlotSource,chosen:number|"magnitude",width:number,name:string){try{const next=appendFemCurve(recipe,source,chosen,width,name);if(chartChosen&&!recipe.series.length)next.presentation.family=recipe.presentation.family;applyRecipe(next);}catch(e){status.textContent=e instanceof Error?e.message:String(e);}}
function addPoint(kind:"Nodal"|"Elemental"|"Conditional",id:number,variable?:string){
  const field=context?.fields.find(f=>f.kind===kind&&f.variable===(variable??selectedField()?.variable))??context?.fields.find(f=>f.kind===kind);
  if(!field||!context?.hasTimeline){status.textContent="Point histories require a result timeline and a supplied field.";return;}
  fieldKey=`${field.kind}:${field.variable}`;
  const chosen=typeof component==="number"&&component<field.components?component:field.components>1?"magnitude":0;
  if(recipe.sources.some(s=>s.type==="history"&&s.kind===kind&&s.entityId===id&&s.variable===field.variable&&recipe.series.some(curve=>curve.source===s.id&&curve.y===`v${chosen=== "magnitude"?0:chosen}`&&!!curve.component===(chosen==="magnitude")))) {status.textContent="That point/quantity/component is already plotted.";return;}
  const source:PlotSource={id:`point:${Date.now()}:${recipe.sources.length}`,type:"history",path:context.path,kind,entityId:id,variable:field.variable};
  appendCurve(source,chosen,field.components,`${kind==="Nodal"?"Node":kind==="Elemental"?"Element":"Condition"} ${id} · ${field.variable} · ${chosen==="magnitude"?"magnitude":field.components>1?"XYZ"[chosen]??chosen:"scalar"}`);
}
function following(source:Extract<PlotSource,{type:"probe"}>){return !!source.followTimeline&&!!context?.timelineId&&followBindings.get(source.id)===context.timelineId;}
function followControl(parent:HTMLElement,source:Extract<PlotSource,{type:"probe"}>){
  if(source.run)return; // No disk-run binding is an owning preview timeline.
  const active=following(source);
  const control=button(parent,active?"Fix frame":source.followTimeline?"Resume following":"Follow timeline",()=>{
    if(active){source.followTimeline=false;followBindings.delete(source.id);}
    else {
      if(!options.embedded||!context?.hasTimeline||!context.timelineId||source.path!==context.path){status.textContent="Following requires a profile from this mesh preview and its result timeline.";return;}
      source.followTimeline=true;source.timeStep=context.frameIndex;followBindings.set(source.id,context.timelineId);
    }
    renderConfig();renderQuick();schedule();
  });
  control.setAttribute("aria-pressed",String(active));
}
function syncFollowing(){
  if(!context)return;
  let paused=false;
  for(const source of recipe.sources)if(source.type==="probe"&&followBindings.has(source.id)&&(!context.hasTimeline||source.path!==context.path||followBindings.get(source.id)!==context.timelineId)){followBindings.delete(source.id);paused=true;}
  if(paused){renderConfig();renderQuick();status.textContent="Timeline/rank changed — profile following paused. Resume explicitly to bind to the new timeline; fixed curves are retained.";}
  if(collectionActive)return;
  let changed=false;
  for(const source of recipe.sources)if(source.type==="probe"&&following(source)&&source.timeStep!==context.frameIndex){source.timeStep=context.frameIndex;changed=true;}
  if(changed){renderConfig();renderQuick();schedule(true);}
}
function renderQuick(){
  renderCurves();
  const quick=root.querySelector<HTMLElement>("#plot-quick");if(!quick)return;quick.textContent="";
  if(!context){quick.textContent="Pick entities in Inspect, or select a SubModelPart to analyze.";return;}
  select(quick,"Target",target,[{value:"point",label:"Picked points"},{value:"region",label:"SubModelPart / whole mesh"}],v=>{target=v;renderQuick();});
  const fields=context.fields;
  if(!fields.some(f=>`${f.kind}:${f.variable}`===fieldKey)){fieldKey=defaultPlotFieldKey(fields,context.displayedKey);}
  select(quick,"Quantity",fieldKey,fields.map(f=>({value:`${f.kind}:${f.variable}`,label:`${f.variable} · ${f.kind} [${f.unit??"unknown"}]`})),v=>{fieldKey=v;if(picked&&selectedField()?.kind!==picked.kind)picked=undefined;renderQuick();});
  const field=selectedField();if(!field){status.textContent="This mesh has no supplied field to plot.";return;}
  const vectorOperation=target==="region"&&["pressureForce","pressureMoment","reactionMoment"].includes(operation);
  const width=vectorOperation?3:target==="region"&&!["min","max","mean","sum"].includes(operation)?1:field.components;
  if(typeof component==="number"&&component>=width)component="magnitude";
  select(quick,"Component",String(width===1?0:component),[...(width>1?[{value:"magnitude",label:"Magnitude"}]:[]),...Array.from({length:width},(_,i)=>({value:String(i),label:width===1?"Scalar":"XYZ"[i]??`Component ${i+1}`}))],v=>{component=v==="magnitude"?v:Number(v);});
  if(target==="point") {
    const entityInput=input(quick,"Entity ID",picked?String(picked.id):"",v=>{const id=Number(v);if(v.trim()&&Number.isSafeInteger(id)){picked={kind:field.kind,id};renderQuick();}},"number");
    entityInput.addEventListener("input",()=>{const id=Number(entityInput.value);if(entityInput.value.trim()&&Number.isSafeInteger(id))picked={kind:field.kind,id};});
    const row=document.createElement("div");row.className="plot-quick-actions";quick.appendChild(row);
    button(row,picked?`Plot ${picked.kind==="Nodal"?"node":"entity"} ${picked.id}`:"Plot picked point",()=>{if(picked)addPoint(picked.kind,picked.id);else status.textContent="Use Inspect to pick a node or entity first.";});
    const pick=button(row,pickMode?"Done picking":"Add points from mesh",()=>{pickMode=!pickMode;options.onPickPoints?.(pickMode);renderQuick();});pick.setAttribute("aria-pressed",String(pickMode));
    const note=document.createElement("p");note.className="plot-muted";note.textContent=pickMode?"Click mesh points to append histories. Esc finishes picking; existing curves are kept.":"Pick in Inspect, choose a quantity, then add it. Additional points share this chart.";quick.appendChild(note);
  } else {
    select(quick,"Region",region,[{value:"",label:"Whole mesh (entity reductions)"},...context.parts.map(p=>({value:p.path,label:p.path}))],v=>{region=v;options.onRegion?.(v);});
    select(quick,"Operation",operation,REGION_OPERATIONS.map(v=>({value:v,label:operationLabels[v]})),v=>{operation=v as typeof operation;renderQuick();});
    select(quick,"Scope",context.hasTimeline?scope:"current",[{value:"current",label:"Current frame"},...(context.hasTimeline?[{value:"history",label:"Over time"}]:[])],v=>{scope=v as typeof scope;});
    if(["pressureMoment","reactionMoment"].includes(operation))input(quick,"Moment origin XYZ",referencePoint?.join(", ")??"",v=>{const parts=v.split(",");const p=parts.map(Number);referencePoint=parts.length===3&&parts.every(v=>v.trim())&&p.every(Number.isFinite)?p as [number,number,number]:undefined;if(!referencePoint)status.textContent="Supply three finite reference coordinates explicitly.";});
    if(["pressureForce","pressureMoment","flux"].includes(operation))select(quick,"Normals",orientation,choices(["outward","winding"]),v=>{orientation=v as typeof orientation;});
    if(["pressureForce","pressureMoment"].includes(operation))input(quick,"Pressure offset",String(pressureOffset),v=>{pressureOffset=Number(v);},"number");
    if(["boundaryIntegral","pressureForce","pressureMoment","flux"].includes(operation))input(quick,"2D thickness",thickness===undefined?"":String(thickness),v=>{thickness=v.trim()?Number(v):undefined;},"number");
    if(["pressureForce","pressureMoment"].includes(operation)&&field.unit==="m²/s²")input(quick,"Density kg/m³",pressureDensity===undefined?"":String(pressureDensity),v=>{pressureDensity=v.trim()?Number(v):undefined;},"number");
    button(quick,"Add region curve",()=>{
      const source:PlotRegionSource={id:`region:${Date.now()}:${recipe.sources.length}`,type:"region",path:context!.path,kind:field.kind,variable:field.variable,scope:context!.hasTimeline?scope:"current",operation,component:width===1?0:component,...(region?{submodelpart:region}:{}),...(scope==="current"||!context!.hasTimeline?{timeStep:context!.frameIndex}:{}),...(["pressureMoment","reactionMoment"].includes(operation)?{referencePoint}:{}),...(["pressureForce","pressureMoment","flux"].includes(operation)?{orientation}:{}),...(["pressureForce","pressureMoment"].includes(operation)?{pressureOffset,...(pressureDensity!==undefined?{pressureDensity}:{})}:{}),...(thickness!==undefined&&["boundaryIntegral","pressureForce","pressureMoment","flux"].includes(operation)?{thickness}:{})};
      const resultWidth=regionResultWidth(source,field.components);appendCurve(source,resultWidth>1?component:0,resultWidth,`${region||"Whole mesh"} · ${operationLabels[operation]} · ${field.variable}`);
    });
    const note=document.createElement("p");note.className="plot-muted";note.textContent="Integrals require boundary Conditions. Pressure force is −p n; 2D loads are per unit depth unless thickness is supplied. Entity mean is unweighted.";quick.appendChild(note);
  }
}
function renderCurves(){
  const curves=root.querySelector<HTMLElement>("#plot-curves");if(!curves)return;curves.textContent="";curves.hidden=!recipe.series.length;
  for(const [i,curve] of recipe.series.entries()){
    const row=document.createElement("div");row.className="plot-curve-row";row.classList.toggle("plot-curve-hidden",curve.visible===false);curves.appendChild(row);
    const swatch=document.createElement("i");swatch.className="plot-curve-swatch";swatch.style.background=curve.color??`var(--vscode-charts-${["blue","orange","green","purple","red","yellow"][i%6]}, var(--ds-focus))`;row.appendChild(swatch);
    const source=recipe.sources.find(s=>s.id===curve.source),label=document.createElement("span");label.className="plot-curve-name";label.textContent=curve.name+(source?.type==="probe"?` · frame ${(source.timeStep??0)+1}${following(source)?" (following)":source.followTimeline?" (paused)":" (fixed)"}`:"");label.title=label.textContent;row.appendChild(label);
    if(source?.type==="probe"&&options.embedded)followControl(row,source);
    button(row,curve.visible===false?"Show":"Hide",()=>{curve.visible=curve.visible===false;renderQuick();schedule();},curve.visible===false?"eyeOff":"eye",true);
    button(row,"Remove",()=>{recipe.series=recipe.series.filter(s=>s!==curve);if(!recipe.series.some(s=>s.source===curve.source)){recipe.sources=recipe.sources.filter(s=>s.id!==curve.source);followBindings.delete(curve.source);}renderQuick();renderConfig();schedule();},"trash",true);
  }
}
function button(parent:HTMLElement,text:string,action:()=>void,icon?:UiGlyphId,iconOnly=false){
  const b=document.createElement("button");b.type="button";
  const id=icon??(/^(Add|Plot)/.test(text)?"plus":/^Remove/.test(text)?"trash":/following|timeline|Fix frame/.test(text)?"clock":text==="Browse…"?"folderOpen":text==="Inspect source"?"search":text==="Locate peak"||text==="Show in mesh"?"crosshair":undefined);
  if(id)b.innerHTML=glyph(id);
  if(!iconOnly){const label=document.createElement("span");label.textContent=text;b.appendChild(label);}else {b.classList.add("plot-icon-button");b.setAttribute("aria-label",text);}
  b.title=text;b.addEventListener("click",action);parent.appendChild(b);return b;
}
function input(parent:HTMLElement,label:string,value:string,change:(v:string)=>void,type="text") {
  const row=document.createElement("label");row.className="plot-row";const title=document.createElement("span");title.textContent=label;row.appendChild(title);
  const control=document.createElement("input");control.type=type;control.value=value;control.setAttribute("aria-label",label);control.addEventListener("change",()=>{change(control.value);if(!parent.closest("#plot-quick"))schedule();});row.appendChild(control);parent.appendChild(row);return control;
}
function select(parent:HTMLElement,label:string,value:string,items:{value:string;label:string}[],change:(v:string)=>void){
  const row=document.createElement("label");row.className="plot-row";const title=document.createElement("span");title.textContent=label;row.appendChild(title);const control=document.createElement("select");control.setAttribute("aria-label",label);
  for(const i of items){const o=document.createElement("option");o.value=i.value;o.textContent=i.label;control.appendChild(o);}control.value=value;control.addEventListener("change",()=>{change(control.value);if(!parent.closest("#plot-quick"))schedule();});row.appendChild(control);parent.appendChild(row);return control;
}
const choices=(v:string[])=>v.map(value=>({value,label:value}));
function section(title:string,parent=config){const s=document.createElement("section"),h=document.createElement("h2");h.textContent=title;s.appendChild(h);parent.appendChild(s);return s;}
function schedule(follow=false){clearTimeout(timer);++requestId;dataset=undefined;collectionActive=true;renderQuick();chart.setAttribute("aria-busy","true");chart.style.opacity=".45";post({type:"plotInvalidate"});status.textContent=follow?"Updating profile for the mesh frame; other extractions stay fixed…":"Settings changed — updating preview…";vscode.setState(recipe);timer=setTimeout(()=>evaluate(follow),350);}
function evaluate(follow=false){
  let next: PlotRecipe;
  try{next=validatePlotRecipe(recipe);}catch(e){collectionActive=false;status.textContent=String(e instanceof Error?e.message:e);return;}
  clearTimeout(timer);const id=++requestId;dataset=undefined;collectionActive=true;followRequest=follow;status.textContent="Collecting full-resolution data…";post({type:"plotEvaluate",requestId:id,recipe:next,followTimeline:follow});
}
function preview(source:PlotSource){clearTimeout(timer);dataset=undefined;followRequest=false;const id=++requestId;status.textContent=`Inspecting ${source.id}…`;post({type:"plotPreview",source,requestId:id});}
function addSource(){const id=`source${Date.now()}`;recipe.sources.push({id,type:"table",path:""});renderConfig();schedule();}
function addSeries(source=recipe.sources[0]){
  if(!source)return;const cols=inventories.get(source.id)??[],numbers=cols.filter(c=>c.type==="number");
  const x=cols[0]?.id??"c0",y=(numbers.find(c=>c.id!==x&&c.domain!=="frameIndex")??numbers[0])?.id??"c1";
  recipe.series.push({id:`series${Date.now()}`,source:source.id,name:`Series ${recipe.series.length+1}`,x,y,color:["#4e9af1","#f29d49","#57bf8a","#bb86fc"][recipe.series.length%4]});renderConfig();schedule();
}
function renderActions(){
  actions.textContent="";
  const group=(label:string)=>{const g=document.createElement("div");g.className="plot-action-group";g.setAttribute("role","group");g.setAttribute("aria-label",label);actions.appendChild(g);return g;};
  const setup=group("Plot setup");
  if(options.embedded){const advanced=button(setup,"Advanced",()=>{advanced.setAttribute("aria-expanded",String(root.classList.toggle("plot-advanced-open")));},"sliders");advanced.setAttribute("aria-expanded",String(root.classList.contains("plot-advanced-open")));advanced.setAttribute("aria-controls","plot-config");}else {button(setup,"Add source",addSource);button(setup,"Add series",()=>addSeries());}
  button(setup,"Saved run…",()=>post({type:"plotRunBrowse"}),"folderOpen");
  button(setup,"Refresh",()=>{post({type:"plotContextRequest"});evaluate();},"refresh");button(setup,"Cancel",()=>{clearTimeout(timer);collectionActive=false;followBindings.clear();renderQuick();renderConfig();post({type:"plotCancel"});},"stop",true);
  const files=group("Recipes and data export");button(files,"Save recipe",()=>post({type:"plotSaveRecipe",recipe}),"save",true);button(files,"Load recipe",()=>post({type:"plotLoadRecipe"}),"folderOpen",true);button(files,"CSV + metadata",()=>post({type:"plotExportCsv",requestId}),"table");
  const view=group("Chart view");
  for (const [label,factor,icon] of [["Zoom in",.8,"zoomIn"],["Zoom out",1.25,"zoomOut"],["Reset axes",0,"maximize"]] as const) button(view,label,()=>{
    if (!dataset) return;
    if(["pie","doughnut"].includes(recipe.presentation.family)){status.textContent="Category shares have no axes to zoom. Use the pane resize control to enlarge the chart.";return;}
    const update: Record<string,unknown> = {},layout=(chart as any)._fullLayout;
    for(let i=0;i<(recipe.presentation.panels??1);i++)for(const axis of ["x","y"]){const key=`${axis}axis${i?i+1:""}`,range=layout?.[key]?.range;if(!factor)update[`${key}.autorange`]=true;else if(range?.every((v:unknown)=>typeof v==="number")){const center=(range[0]+range[1])/2,half=(range[1]-range[0])*factor/2;update[`${key}.range`]=[center-half,center+half];}}
    void rendering.then(()=>Plotly.relayout(chart,update)).catch(e=>{status.textContent=String(e);});
  },icon,true);
  const images=group("Image export");for(const format of ["png","svg"])button(images,format.toUpperCase(),()=>{if(!dataset){status.textContent="Compute the current plot first.";return;}const id=requestId;void rendering.then(()=>Plotly.toImage(chart,{format,width:Math.max(800,chart.clientWidth),height:Math.max(500,chart.clientHeight)})).then(data=>{if(id===requestId)post({type:"plotExportImage",format,data,requestId:id,view:(chart as any).layout});}).catch(e=>{status.textContent=String(e);});},"download");
}
function chooseChart(family:PlotFamily){recipe.presentation.family=family;chartChosen=true;pickerOpen=false;renderConfig();schedule();root.querySelector<HTMLElement>("#plot-type-toggle")?.focus();}
function renderChartTools(){
  const tools=root.querySelector<HTMLElement>("#plot-chart-tools");if(!tools)return;tools.textContent="";
  const p=recipe.presentation,choice=CHART_CHOICES.find(c=>c.family===p.family)!;
  const bar=document.createElement("div");bar.className="plot-chart-heading";tools.appendChild(bar);
  const trigger=button(bar,choice.label,()=>{pickerOpen=!pickerOpen;renderChartTools();root.querySelector<HTMLElement>(pickerOpen?`#plot-type-picker [data-family="${p.family}"]`:"#plot-type-toggle")?.focus();},choice.icon);trigger.id="plot-type-toggle";trigger.setAttribute("aria-label","Chart type");trigger.title=`Chart type: ${choice.label}. ${choice.hint}`;trigger.setAttribute("aria-expanded",String(pickerOpen));trigger.setAttribute("aria-controls","plot-type-picker");trigger.insertAdjacentHTML("beforeend",glyph("chevronDown"));
  const title=document.createElement("span");title.className="plot-heading-title";title.textContent=p.title;title.title=p.title;bar.appendChild(title);
  const picker=document.createElement("div");picker.id="plot-type-picker";picker.hidden=!pickerOpen;picker.setAttribute("role","group");picker.setAttribute("aria-label","Chart types");tools.appendChild(picker);
  for(const [i,c] of CHART_CHOICES.entries()){
    const b=button(picker,c.label,()=>chooseChart(c.family),c.icon);b.dataset.family=c.family;b.title=c.hint;b.setAttribute("aria-pressed",String(c.family===p.family));b.tabIndex=c.family===p.family?0:-1;
    b.addEventListener("keydown",e=>{if(e.key==="Escape"){pickerOpen=false;renderChartTools();root.querySelector<HTMLElement>("#plot-type-toggle")?.focus();e.stopPropagation();}else if(["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End"].includes(e.key)){e.preventDefault();const columns=getComputedStyle(picker).gridTemplateColumns.split(" ").length;const next=e.key==="Home"?0:e.key==="End"?CHART_CHOICES.length-1:(i+(e.key==="ArrowLeft"?-1:e.key==="ArrowRight"?1:e.key==="ArrowUp"?-columns:columns)+CHART_CHOICES.length)%CHART_CHOICES.length;picker.querySelectorAll<HTMLButtonElement>("button").forEach(item=>item.tabIndex=-1);const target=picker.querySelectorAll<HTMLButtonElement>("button")[next];target.tabIndex=0;target.focus();}});
  }
  const controls=document.createElement("div");controls.id="plot-style-controls";tools.appendChild(controls);
  if(["line","step","area"].includes(p.family))select(controls,"Drawing",p.lineMode??"lines+markers",[{value:"lines",label:"Lines only"},{value:"lines+markers",label:"Lines + markers"}],v=>{p.lineMode=v as typeof p.lineMode;});
  if(p.family==="bar"){
    select(controls,"Arrangement",p.barMode??"group",[{value:"group",label:"Grouped"},{value:"stack",label:"Stacked (signed)"}],v=>{p.barMode=v as typeof p.barMode;});
    select(controls,"Orientation",p.barOrientation??"v",[{value:"v",label:"Vertical"},{value:"h",label:"Horizontal"}],v=>{p.barOrientation=v as typeof p.barOrientation;});
  }
  if(["pie","doughnut","bubble","bar"].includes(p.family))for(const s of recipe.series){
    if(p.family==="bubble"){
      const cols=(inventories.get(s.source)??[]).filter(c=>c.type==="number");
      select(controls,`Size · ${s.name}`,s.size??"",[{value:"",label:"Choose supplied area weights…"},...cols.map(c=>({value:c.id,label:`${c.label} [${c.unit??"unknown"}]`}))],v=>{s.size=v||undefined;renderConfig();});
    }else select(controls,`Statistic · ${s.name}`,s.statistic??(p.family==="bar"?"mean":""),[{value:"",label:"Choose aggregation explicitly…"},...choices(["sum","count","mean","min","max"])],v=>{s.statistic=v?v as typeof s.statistic:undefined;renderConfig();});
  }
  if(["pie","doughnut","bubble","heatmap","contour"].includes(p.family)){const note=document.createElement("p");note.className="plot-muted";note.textContent=p.family==="bubble"?"Marker area uses the supplied size column. Negative, missing and zero sizes are not drawn.":["pie","doughnut"].includes(p.family)?"Each curve is a separate pie. Choose category aggregation; weights must be nonnegative with a positive total. Overlapping regions are not a physical partition.":"Choose X, Y, Z columns and an explicit grid in Advanced; uncovered cells stay masked.";tools.appendChild(note);}
}
function renderConfig(){
  renderChartTools();
  config.textContent="";
  if(options.embedded){button(config,"Add source",addSource);button(config,"Add series",()=>addSeries());}
  const p=recipe.presentation,panel=section("Presentation");
  select(panel,"Plot type",p.family,CHART_CHOICES.map(c=>({value:c.family,label:c.label})),v=>chooseChart(v as PlotFamily));
   input(panel,"Title",p.title,v=>{p.title=v;renderChartTools();schedule();});input(panel,"X label",p.xLabel??"",v=>{p.xLabel=v;schedule();});input(panel,"Y label",p.yLabel??"",v=>{p.yLabel=v;schedule();});
  for(const axis of ["x","y"] as const){select(panel,`${axis.toUpperCase()} scale`,p[`${axis}Scale`]??"linear",choices(["linear","log"]),v=>{p[`${axis}Scale`]=v as "linear"|"log";schedule();});input(panel,`${axis.toUpperCase()} limits`,p[`${axis}Range`]?.join(", ")??"",v=>{p[`${axis}Range`]=v.trim()?v.split(",").map(Number) as [number,number]:undefined;schedule();});}
  select(panel,"Panels",String(p.panels??1),choices(["1","2","4"]),v=>{p.panels=Number(v) as 1|2|4;for(const s of recipe.series)if((s.panel??0)>=p.panels)s.panel=0;schedule();});
  input(panel,"Annotation (x,y,text)","",v=>{const [x,y,...text]=v.split(",");p.annotations=[...(p.annotations??[]),{x:Number(x),y:Number(y),text:text.join(",")}];schedule();});
  for(const s of recipe.sources){
    const box=section(`Source · ${s.id}`);
    select(box,"Source type",s.type,choices(["table","mesh","history","probe","region","inline"]),v=>{
      const path=s.type==="inline"?"":s.path;
      const next:PlotSource=v==="mesh"?{id:s.id,type:"mesh",path,kind:"Nodes"}:v==="history"?{id:s.id,type:"history",path,kind:"Nodal",entityId:1,variable:""}:v==="probe"?{id:s.id,type:"probe",path,points:[[0,0,0],[1,0,0]],variable:"",samples:101}:v==="region"?{id:s.id,type:"region",path,kind:"Nodal",variable:"",scope:"current",operation:"max"}:v==="inline"?{id:s.id,type:"inline",table:{columns:[],rows:[],diagnostics:[]}}:{id:s.id,type:"table",path};
      if(s.run&&["mesh","history","probe","region"].includes(next.type))next.run=s.run;
      recipe.sources[recipe.sources.indexOf(s)]=next;inventories.delete(s.id);renderConfig();
    });
    if(s.type!=="inline"){input(box,"File",s.path,v=>{s.path=v;inventories.delete(s.id);});button(box,"Browse…",()=>post({type:"plotBrowse",target:s.id}));}
    else { const info = document.createElement("p");info.textContent = `Saved/inline snapshot: ${s.table.rows.length} rows. Source data is included in this recipe.`;box.appendChild(info); }
    if(["mesh","history","probe","region"].includes(s.type)) {
      button(box,s.run?"Rebind saved run…":"Bind saved run…",()=>post({type:"plotRunBrowse",target:s.id,signature:JSON.stringify(s)}),"folderOpen");
      if(s.run) {
        const info=document.createElement("p");info.className="plot-muted";info.textContent=`Pinned run ${s.run.runId} · study ${s.run.ownerId}. Disk source/companion revisions are checked on collection; live snapshots are not substituted.`;box.appendChild(info);
        button(box,"Open owning result",()=>post({type:"plotRunOpen",source:s}),"folderOpen");
        if(s.type==="history"||s.type==="region"){
          button(box,"Resolve time cursor",()=>post({type:"plotTimeCursor",source:s}),"clock");
          button(box,"Open time cursor…",()=>post({type:"plotTimeCursorOpen",source:s}),"clock");
        }
      }
    }
    if(s.type==="table") {
      const o=s.options??(s.options={});select(box,"Delimiter",o.delimiter??"auto",[{value:"auto",label:"Detect"},{value:",",label:"Comma"},{value:"\t",label:"Tab"},{value:";",label:"Semicolon"},{value:"|",label:"Pipe"}],v=>{o.delimiter=v==="auto"?undefined:v as ",";});
      select(box,"Headers",o.header===undefined?"auto":String(o.header),[{value:"auto",label:"Detect"},{value:"true",label:"First record"},{value:"false",label:"No header"}],v=>{o.header=v==="auto"?undefined:v==="true";});
      input(box,"Missing tokens",(o.missing??["","NA","N/A","null"]).join(","),v=>{o.missing=v.split(",");});input(box,"Numeric columns",o.numericColumns?.join(",")??"",v=>{o.numericColumns=v.trim()?v.split(",").map(v=>v.trim()):undefined;});
      input(box,"Units (c1=Pa,…)",Object.entries(o.units??{}).map(([k,v])=>`${k}=${v}`).join(","),v=>{o.units=Object.fromEntries(v.split(",").filter(Boolean).map(v=>v.split("=").map(s=>s.trim())));});
    } else if(s.type==="mesh") {
      select(box,"Association",s.kind,choices(["Nodes","Elements","Conditions","Geometries"]),v=>{s.kind=v as typeof s.kind;inventories.delete(s.id);});input(box,"SubModelPart",s.submodelpart??"",v=>{s.submodelpart=v||undefined;});input(box,"Selected IDs",s.ids?.join(",")??"",v=>{s.ids=v.trim()?v.split(",").map(Number):undefined;});input(box,"Frame index",s.timeStep===undefined?"":String(s.timeStep),v=>{s.timeStep=v.trim()?Number(v):undefined;});
    } else if(s.type==="history") {
      select(box,"Association",s.kind,choices(["Nodal","Elemental","Conditional"]),v=>{s.kind=v as typeof s.kind;});input(box,"Entity ID",String(s.entityId),v=>{s.entityId=Number(v);},"number");input(box,"Field",s.variable,v=>{s.variable=v;});input(box,"Physical times",s.times?.join(",")??"",v=>{s.times=v.trim()?v.split(",").map(Number):undefined;});input(box,"Time unit",s.timeUnit??"",v=>{s.timeUnit=v||undefined;});if(!s.run)input(box,"Run label (unverified)",s.runId??"",v=>{s.runId=v||undefined;});
    } else if(s.type==="region") {
      input(box,"Reduced component",String(s.component??"magnitude"),v=>{s.component=v==="magnitude"?v:Number(v);});
      input(box,"Frame index",s.timeStep===undefined?"":String(s.timeStep),v=>{s.timeStep=v.trim()?Number(v):undefined;});input(box,"Physical times",s.times?.join(",")??"",v=>{s.times=v.trim()?v.split(",").map(Number):undefined;});input(box,"Time unit",s.timeUnit??"",v=>{s.timeUnit=v||undefined;});if(!s.run)input(box,"Run label (unverified)",s.runId??"",v=>{s.runId=v||undefined;});
      select(box,"Association",s.kind,choices(["Nodal","Elemental","Conditional"]),v=>{s.kind=v as typeof s.kind;});input(box,"Field",s.variable,v=>{s.variable=v;});input(box,"SubModelPart",s.submodelpart??"",v=>{s.submodelpart=v||undefined;});select(box,"Operation",s.operation,REGION_OPERATIONS.map(v=>({value:v,label:operationLabels[v]})),v=>{s.operation=v as typeof s.operation;});select(box,"Scope",s.scope,choices(["current","history"]),v=>{s.scope=v as typeof s.scope;});select(box,"Normals",s.orientation??"outward",choices(["outward","winding"]),v=>{s.orientation=v as "outward"|"winding";orientation=s.orientation;});input(box,"Pressure offset",String(s.pressureOffset??0),v=>{s.pressureOffset=Number(v);pressureOffset=s.pressureOffset;},"number");input(box,"Moment origin XYZ",s.referencePoint?.join(",")??"",v=>{s.referencePoint=v.trim()?v.split(",").map(Number) as [number,number,number]:undefined;});input(box,"2D thickness",s.thickness===undefined?"":String(s.thickness),v=>{s.thickness=v.trim()?Number(v):undefined;},"number");input(box,"Density kg/m³",s.pressureDensity===undefined?"":String(s.pressureDensity),v=>{s.pressureDensity=v.trim()?Number(v):undefined;},"number");
    } else if(s.type==="probe") {
      input(box,"Nodal field",s.variable,v=>{s.variable=v;});input(box,"Endpoints (x y z;…)",s.points.map(p=>p.join(" ")).join("; "),v=>{s.points=v.split(";").map(p=>p.trim().split(/\s+/).map(Number) as [number,number,number]);});input(box,"Samples",String(s.samples??101),v=>{s.samples=Number(v);},"number");
      input(box,"Frame index",s.timeStep===undefined?"":String(s.timeStep),v=>{s.timeStep=v.trim()?Number(v):undefined;s.followTimeline=false;followBindings.delete(s.id);renderQuick();});
      if(options.embedded)followControl(box,s);
    }
    button(box,"Inspect source",()=>preview(s));button(box,"Remove source",()=>{recipe.sources=recipe.sources.filter(x=>x!==s);recipe.series=recipe.series.filter(r=>r.source!==s.id);renderConfig();schedule();});
    const cols=inventories.get(s.id);if(cols){const list=document.createElement("p");list.className="plot-muted";list.textContent=cols.map(c=>`${c.id}: ${c.label} [${c.unit??"unknown"}] (${c.type})`).join(" · ");box.appendChild(list);}
  }
  for(const s of recipe.series)renderSeries(s);
}
function renderSeries(s:PlotSeriesSpec){
  const box=section(`Series · ${s.name}`),cols=inventories.get(s.source)??[],items=cols.map(c=>({value:c.id,label:`${c.label} [${c.unit??"unknown"}] · ${c.id}`}));
   input(box,"Name",s.name,v=>{s.name=v;renderChartTools();schedule();});select(box,"Source",s.source,choices(recipe.sources.map(s=>s.id)),v=>{s.source=v;renderConfig();schedule();});
   const column=(label:string,key:"x"|"y"|"z"|"group"|"size")=>select(box,label,s[key]??"",[{value:"",label:"None"},...items],v=>{s[key]=v||undefined as any;renderChartTools();schedule();});column(["pie","doughnut","bar"].includes(recipe.presentation.family)?"Category column":"X column","x");column("Y column","y");if(["heatmap","contour"].includes(recipe.presentation.family))column("Z column","z");column("Group by","group");
   if(recipe.presentation.family==="bubble"){column("Bubble size column","size");input(box,"Maximum diameter px",String(s.sizeMax??36),v=>{s.sizeMax=Number(v);},"number");}
  input(box,"Magnitude columns",s.components?.join(",")??"",v=>{s.components=v.trim()?v.split(",").map(v=>v.trim()):undefined;s.component=s.components?"magnitude":undefined;schedule();});
  select(box,"Panel",String(s.panel??0),Array.from({length:recipe.presentation.panels??1},(_,v)=>({value:String(v),label:String(v+1)})),v=>{s.panel=Number(v);schedule();});input(box,"Color",s.color??"#4e9af1",v=>{s.color=v;schedule();},"color");select(box,"Markers",s.marker??"circle",choices(["circle","square","diamond"]),v=>{s.marker=v as typeof s.marker;schedule();});select(box,"Visibility",s.visible===false?"hidden":"visible",choices(["visible","hidden"]),v=>{s.visible=v==="visible";schedule();});
  if(recipe.presentation.family==="histogram")input(box,"Bins",String(s.bins??20),v=>{s.bins=Number(v);schedule();},"number");
   if(["bar","pie","doughnut"].includes(recipe.presentation.family))select(box,"Statistic",s.statistic??(recipe.presentation.family==="bar"?"mean":""),[{value:"",label:"Choose explicitly"},...choices(["mean","sum","min","max","count"])],v=>{s.statistic=v?v as typeof s.statistic:undefined;renderChartTools();schedule();});
  input(box,"Filter (column,min,max)",s.filter?[s.filter.column,s.filter.min??"",s.filter.max??""].join(","):"",v=>{const[c,min,max]=v.split(",");s.filter=c?{column:c.trim(),min:min?.trim()?Number(min):undefined,max:max?.trim()?Number(max):undefined}:undefined;schedule();});
  const transformBox=document.createElement("div");transformBox.className="plot-transforms";box.appendChild(transformBox);
  for(const [i,t]of(s.transforms??[]).entries()) {
    const row=document.createElement("div");row.className="plot-transform";transformBox.appendChild(row);const label=document.createElement("span");label.textContent=`${i+1}. ${t.op}`;row.appendChild(label);
    if(t.op==="smooth")input(row,"Window",String(t.window),v=>{t.window=Number(v);schedule();},"number");if(t.op==="normalize")input(row,"Divisor",String(t.divisor),v=>{t.divisor=Number(v);schedule();},"number");if(t.op==="convert"){input(row,"Factor",String(t.factor),v=>{t.factor=Number(v);schedule();},"number");input(row,"Target unit",t.unit,v=>{t.unit=v;schedule();});}
    button(row,"↑",()=>{if(i>0){[s.transforms![i-1],s.transforms![i]]=[t,s.transforms![i-1]];renderConfig();schedule();}}).setAttribute("aria-label","Move transformation earlier");button(row,"Remove",()=>{s.transforms!.splice(i,1);renderConfig();schedule();});
  }
  select(box,"Add analysis","",[{value:"",label:"Choose transformation…"},...choices(["smooth","regression","derivative","integral","normalize","convert"])],v=>{if(!v)return;const t:PlotTransform=v==="smooth"?{op:"smooth",window:5}:v==="normalize"?{op:"normalize",divisor:1}:v==="convert"?{op:"convert",factor:1,unit:"supplied"}:{op:v as "regression"|"derivative"|"integral"};(s.transforms??=[]).push(t);renderConfig();schedule();});
  select(box,"Reference",s.alignment?.reference??"",[{value:"",label:"No alignment"},...recipe.series.filter(r=>r!==s).map(r=>({value:r.id,label:r.name}))],v=>{s.alignment=v?{reference:v,method:"exact",tolerance:0}:undefined;renderConfig();schedule();});
  if(s.alignment){select(box,"Match",s.alignment.method,choices(["exact","nearest","linear"]),v=>{s.alignment!.method=v as typeof s.alignment.method;schedule();});input(box,"Tolerance",String(s.alignment.tolerance),v=>{s.alignment!.tolerance=Number(v);schedule();},"number");}
  input(box,"Errors (column,meaning)",s.uncertainty?`${s.uncertainty.column},${s.uncertainty.meaning}`:"",v=>{const[col,...meaning]=v.split(",");s.uncertainty=col?{column:col,meaning:meaning.join(",")}:undefined;schedule();});
  if(["heatmap","contour"].includes(recipe.presentation.family)){
    select(box,"Grid method",s.grid?.method??"",[{value:"",label:"Choose explicitly"},...choices(["regular","nearest"])],v=>{s.grid=v==="regular"?{method:"regular"}:v==="nearest"?{method:"nearest",nx:32,ny:32,radius:1}:undefined;renderConfig();schedule();});
    if(s.grid?.method==="nearest")for(const k of ["nx","ny","radius"]as const)input(box,k,String(s.grid[k]),v=>{s.grid![k]=Number(v);schedule();},"number");
  }
  button(box,"Remove series",()=>{recipe.series=recipe.series.filter(r=>r!==s);renderConfig();schedule();});
}
function describe(data:PlotDataset){
  const diagnostics=element("plot-diagnostics");diagnostics.textContent="";
  const lines = [...data.diagnostics, ...data.series.flatMap(s => [
    `${s.name}: n=${s.statistics.count}, missing=${s.statistics.missing}, mean=${s.statistics.mean}, population std=${s.statistics.std}`,
    `Transformations: ${JSON.stringify(data.recipe.series.find(r => r.id === s.id || s.id.startsWith(r.id + ":"))?.transforms ?? [])}`,
    ...(s.regression ? [`Fit: ${JSON.stringify(s.regression)}`] : []),
    ...s.diagnostics.map(v => `${s.name}: ${v}`),
  ])];
  for (const line of lines) { const p = document.createElement("p"); p.textContent = line; diagnostics.appendChild(p); }
   const bubble=data.recipe.presentation.family==="bubble",circular=["pie","doughnut"].includes(data.recipe.presentation.family);
   const table=document.createElement("table"),head=document.createElement("tr");for(const v of ["Series","X","Y",...(bubble?["Size (supplied)"]:[]),...(circular?["Covered share (%)"]:[]),"Find sample"]){const c=document.createElement("th");c.scope="col";c.textContent=v;head.appendChild(c);}table.appendChild(head);
   for(const s of data.series)for(const p of s.points.slice(0,100)){const row=document.createElement("tr");for(const v of [s.name,p.x??"—",p.y??"—",...(bubble?[`${p.size??"—"} [${s.sizeColumn?.unit??"unknown"}]`]:[]),...(circular?[p.share===null||p.share===undefined?"—":(p.share*100).toPrecision(4)]:[])]){const c=document.createElement("td");c.textContent=String(v);row.appendChild(c);}const c=document.createElement("td");if(canLocate(p.origin))button(c,"Show in mesh",()=>post({type:"plotPick",origin:p.origin}));row.appendChild(c);table.appendChild(row);}
   const samples=element("plot-samples");samples.textContent="";const note=document.createElement("p");note.textContent="First 100 delivered samples per series, including gaps and weights not drawn. CSV includes every full-resolution derived and original sample.";samples.append(note,table);
  const coverage=root.querySelector<HTMLElement>("#plot-coverage");if(coverage){coverage.textContent="";for(const s of data.series){const p=document.createElement("p");p.className="plot-muted";const reports=s.diagnostics.filter(v=>/covered|unknown|per unit depth|linear corner|piecewise.linear|excluded/.test(v));p.textContent=`${s.name}: ${s.statistics.count} values, ${s.statistics.missing} gaps · [${s.yColumn.unit??"unknown unit"}]${reports.length?` · ${reports.slice(0,4).join(" · ")}`:""}`;coverage.appendChild(p);}for(const d of data.diagnostics){const p=document.createElement("p");p.className="plot-muted";p.textContent=d;coverage.appendChild(p);}}
  const peaks=root.querySelector<HTMLElement>("#plot-peaks");if(peaks){peaks.textContent="";for(const s of data.series)if(s.peak){const row=document.createElement("div");row.className="plot-muted";row.textContent=`${s.name}: peak ${s.peak.y} [${s.yColumn.unit??"unknown"}] at ${s.peak.x}`;if(canLocate(s.peak.origin))button(row,"Locate peak",()=>post({type:"plotPick",origin:s.peak!.origin}));peaks.appendChild(row);}}
}
function receive(msg:any){
  if(!msg||typeof msg.type!=="string")return;
  if(msg.type==="plotContext"){if(JSON.stringify(context)!==JSON.stringify(msg.context)){context=msg.context;renderQuick();syncFollowing();}return;}
  if(msg.type==="plotRecipe"){
    ++requestId;clearTimeout(timer);collectionActive=false;followBindings.clear();recipe=validatePlotRecipe(msg.recipe);chartChosen=recipe.presentation.family!=="line";inventories.clear();dataset=undefined;Plotly.purge(chart);renderConfig();renderQuick();root.dataset.plotReady="true";if(recipe.sources.length)preview(recipe.sources[0]);
  }else if(msg.type==="plotPicked"){const s=recipe.sources.find(s=>s.id===msg.target);if(s&&s.type!=="inline"){s.path=msg.path;renderConfig();preview(s);}}
  else if(msg.type==="plotRunSelected") {
    let source=recipe.sources.find(s=>s.id===msg.target);
    if(msg.target&&(!source||JSON.stringify(source)!==msg.signature)){status.textContent="Source settings changed while choosing a run; selection was not applied. Bind again explicitly.";return;}
    if(!source){source={id:`run:${Date.now()}`,type:"mesh",path:msg.path,kind:"Nodes",run:msg.run};recipe.sources.push(source);}
    else if(source.type!=="inline"&&source.type!=="table"){source.path=msg.path;source.run=msg.run;if(source.type==="history"||source.type==="region")source.runId=undefined;}
    inventories.delete(source.id);followBindings.delete(source.id);if(source.type==="probe")source.followTimeline=false;
    if(options.embedded)root.classList.add("plot-advanced-open");renderActions();renderConfig();renderQuick();preview(source);
  }
  else if(msg.type==="plotSourcePreview"&&msg.requestId===requestId){inventories.set(msg.source.id,msg.columns);status.textContent=`${msg.rowCount} rows · ${msg.diagnostics.join(" ")}`;renderConfig();const area=section("Import preview");const pre=document.createElement("pre");pre.textContent=msg.rows.map((r:unknown[])=>r.map(v=>v??"—").join("\t")).join("\n");area.appendChild(pre);if(!recipe.series.length)addSeries(recipe.sources.find(s=>s.id===msg.source.id));else schedule();}
  else if(msg.type==="plotResult"&&msg.requestId===requestId){dataset=msg.dataset;if(msg.complete!==false)collectionActive=false;let refreshControls=false;for(const s of dataset!.sources){refreshControls ||= !inventories.has(s.id);inventories.set(s.id,s.columns);}if(refreshControls)renderConfig();status.textContent=`${dataset!.partial?"Partial result · ":""}${dataset!.fullCount} full-resolution points · ${dataset!.displayCount} displayed`;describe(dataset!);draw(dataset!);if(msg.complete!==false)syncFollowing();}
  else if(msg.type==="plotProgress"&&msg.requestId===requestId)status.textContent=`${msg.label} (${msg.done}/${msg.total})`;
  else if(msg.type==="plotError"&&(msg.requestId===undefined||msg.requestId===requestId)){collectionActive=false;if(followRequest&&msg.requestId===requestId){followBindings.clear();renderQuick();renderConfig();}status.textContent=msg.message;}
  else if(msg.type==="plotNotice")status.textContent=msg.message;
}
const observer=new MutationObserver(()=>{if(dataset)draw(dataset);});observer.observe(document.body,{attributes:true,attributeFilter:["class","style"]});
const resize=new ResizeObserver(()=>{if(dataset)void rendering.then(()=>Plotly.relayout(chart,{autosize:true})).catch(()=>{});});resize.observe(chart);
renderActions();renderConfig();renderQuick();post({type:"plotReady"});
return {receive,setContext:(next:FemPlotContext)=>{context=next;renderQuick();},pick:(kind:"Nodal"|"Elemental"|"Conditional",id:number)=>{picked={kind,id};if(pickMode)addPoint(kind,id);else renderQuick();},plotPoint:(kind:"Nodal"|"Elemental"|"Conditional",id:number,variable?:string)=>addPoint(kind,id,variable),selectRegion:(path:string)=>{target="region";region=path;operation="pressureForce";const pressure=context?.fields.find(f=>f.variable==="PRESSURE"&&["Nodal","Conditional"].includes(f.kind))??context?.fields.find(f=>f.components===1);if(pressure)fieldKey=`${pressure.kind}:${pressure.variable}`;renderQuick();},setRecipe:applyRecipe,stopPicking:()=>{pickMode=false;options.onPickPoints?.(false);renderQuick();},dispose:()=>{clearTimeout(timer);observer.disconnect();resize.disconnect();Plotly.purge(chart);}};
}
