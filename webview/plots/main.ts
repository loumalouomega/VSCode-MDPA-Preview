import { emptyPlotRecipe, validatePlotRecipe } from "../../src/parser/plot/recipe";
import { PLOT_FAMILIES, type PlotColumn, type PlotDataset, type PlotRecipe, type PlotSeriesSpec, type PlotSource, type PlotTable, type PlotTransform } from "../../src/parser/plot/types";
import { Plotly, renderPlotChart, type PlotElement } from "./chart";
declare function acquireVsCodeApi():{postMessage(v:unknown):void;setState(v:unknown):void;getState():unknown};
const vscode=acquireVsCodeApi(),config=document.getElementById("plot-config")!,actions=document.getElementById("plot-actions")!,chart=document.getElementById("plot-chart")! as PlotElement,status=document.getElementById("plot-status")!;
let recipe=emptyPlotRecipe(),requestId=0,dataset:PlotDataset|undefined,timer:ReturnType<typeof setTimeout>|undefined;
let rendering = Promise.resolve();
function draw(data: PlotDataset) {
  const id = requestId;
  rendering = rendering.catch(() => undefined).then(async () => {
    if (id !== requestId || dataset !== data) return;
    await renderPlotChart(chart, data, p => { if (id === requestId && p.origin) post({type:"plotPick",origin:p.origin}); });
    if (id === requestId) { chart.removeAttribute("aria-busy"); chart.style.opacity = "1"; }
  }).catch(e => { if (id === requestId) status.textContent = String(e); });
}
const inventories=new Map<string,PlotColumn[]>();
const post=(message:unknown)=>vscode.postMessage(message);
function button(parent:HTMLElement,text:string,action:()=>void){const b=document.createElement("button");b.type="button";b.textContent=text;b.addEventListener("click",action);parent.appendChild(b);return b;}
function input(parent:HTMLElement,label:string,value:string,change:(v:string)=>void,type="text") {
  const row=document.createElement("label");row.className="plot-row";const title=document.createElement("span");title.textContent=label;row.appendChild(title);
  const control=document.createElement("input");control.type=type;control.value=value;control.setAttribute("aria-label",label);control.addEventListener("change",()=>{change(control.value);schedule();});row.appendChild(control);parent.appendChild(row);return control;
}
function select(parent:HTMLElement,label:string,value:string,items:{value:string;label:string}[],change:(v:string)=>void){
  const row=document.createElement("label");row.className="plot-row";const title=document.createElement("span");title.textContent=label;row.appendChild(title);const control=document.createElement("select");control.setAttribute("aria-label",label);
  for(const i of items){const o=document.createElement("option");o.value=i.value;o.textContent=i.label;control.appendChild(o);}control.value=value;control.addEventListener("change",()=>{change(control.value);schedule();});row.appendChild(control);parent.appendChild(row);return control;
}
const choices=(v:string[])=>v.map(value=>({value,label:value}));
function section(title:string,parent=config){const s=document.createElement("section"),h=document.createElement("h2");h.textContent=title;s.appendChild(h);parent.appendChild(s);return s;}
function schedule(){clearTimeout(timer);++requestId;dataset=undefined;chart.setAttribute("aria-busy","true");chart.style.opacity=".45";post({type:"plotInvalidate"});status.textContent="Settings changed — updating preview…";vscode.setState(recipe);timer=setTimeout(evaluate,350);}
function evaluate(){
  let next: PlotRecipe;
  try{next=validatePlotRecipe(recipe);}catch(e){status.textContent=String(e instanceof Error?e.message:e);return;}
  clearTimeout(timer);const id=++requestId;dataset=undefined;status.textContent="Collecting full-resolution data…";post({type:"plotEvaluate",requestId:id,recipe:next});
}
function preview(source:PlotSource){clearTimeout(timer);dataset=undefined;const id=++requestId;status.textContent=`Inspecting ${source.id}…`;post({type:"plotPreview",source,requestId:id});}
function addSource(){const id=`source${Date.now()}`;recipe.sources.push({id,type:"table",path:""});renderConfig();schedule();}
function addSeries(source=recipe.sources[0]){
  if(!source)return;const cols=inventories.get(source.id)??[],numbers=cols.filter(c=>c.type==="number");
  const x=cols[0]?.id??"c0",y=(numbers.find(c=>c.id!==x&&c.domain!=="frameIndex")??numbers[0])?.id??"c1";
  recipe.series.push({id:`series${Date.now()}`,source:source.id,name:`Series ${recipe.series.length+1}`,x,y,color:["#4e9af1","#f29d49","#57bf8a","#bb86fc"][recipe.series.length%4]});renderConfig();schedule();
}
function renderActions(){actions.textContent="";button(actions,"Add source",addSource);button(actions,"Add series",()=>addSeries());button(actions,"Refresh",evaluate);button(actions,"Cancel",()=>{clearTimeout(timer);post({type:"plotCancel"});});button(actions,"Save recipe",()=>post({type:"plotSaveRecipe",recipe}));button(actions,"Load recipe",()=>post({type:"plotLoadRecipe"}));button(actions,"CSV + metadata",()=>post({type:"plotExportCsv",requestId}));
  for (const [label,factor] of [["Zoom in",.8],["Zoom out",1.25],["Reset axes",0]] as const) button(actions,label,()=>{
    if (!dataset) return;
    const update: Record<string,unknown> = {},layout=(chart as any)._fullLayout;
    for(let i=0;i<(recipe.presentation.panels??1);i++)for(const axis of ["x","y"]){const key=`${axis}axis${i?i+1:""}`,range=layout?.[key]?.range;if(!factor)update[`${key}.autorange`]=true;else if(range?.every((v:unknown)=>typeof v==="number")){const center=(range[0]+range[1])/2,half=(range[1]-range[0])*factor/2;update[`${key}.range`]=[center-half,center+half];}}
    void rendering.then(()=>Plotly.relayout(chart,update)).catch(e=>{status.textContent=String(e);});
  });
  for(const format of ["png","svg"])button(actions,format.toUpperCase(),()=>{if(!dataset){status.textContent="Compute the current plot first.";return;}const id=requestId;void rendering.then(()=>Plotly.toImage(chart,{format,width:Math.max(800,chart.clientWidth),height:Math.max(500,chart.clientHeight)})).then(data=>{if(id===requestId)post({type:"plotExportImage",format,data,requestId:id,view:(chart as any).layout});}).catch(e=>{status.textContent=String(e);});});
}
function renderConfig(){
  config.textContent="";
  const p=recipe.presentation,panel=section("Presentation");
  select(panel,"Preset","",[{value:"",label:"Choose a starting view…"},{value:"line",label:"History / spatial profile"},{value:"scatter",label:"XY relationship"},{value:"histogram",label:"Distribution"},{value:"heatmap",label:"2D grid"}],v=>{if(v){p.family=v as typeof p.family;renderConfig();schedule();}});
  select(panel,"Plot type",p.family,choices(PLOT_FAMILIES),v=>{p.family=v as typeof p.family;renderConfig();schedule();});
  input(panel,"Title",p.title,v=>{p.title=v;schedule();});input(panel,"X label",p.xLabel??"",v=>{p.xLabel=v;schedule();});input(panel,"Y label",p.yLabel??"",v=>{p.yLabel=v;schedule();});
  for(const axis of ["x","y"] as const){select(panel,`${axis.toUpperCase()} scale`,p[`${axis}Scale`]??"linear",choices(["linear","log"]),v=>{p[`${axis}Scale`]=v as "linear"|"log";schedule();});input(panel,`${axis.toUpperCase()} limits`,p[`${axis}Range`]?.join(", ")??"",v=>{p[`${axis}Range`]=v.trim()?v.split(",").map(Number) as [number,number]:undefined;schedule();});}
  select(panel,"Panels",String(p.panels??1),choices(["1","2","4"]),v=>{p.panels=Number(v) as 1|2|4;for(const s of recipe.series)if((s.panel??0)>=p.panels)s.panel=0;schedule();});
  input(panel,"Annotation (x,y,text)","",v=>{const [x,y,...text]=v.split(",");p.annotations=[...(p.annotations??[]),{x:Number(x),y:Number(y),text:text.join(",")}];schedule();});
  for(const s of recipe.sources){
    const box=section(`Source · ${s.id}`);
    select(box,"Source type",s.type,choices(["table","mesh","history","probe","inline"]),v=>{
      const path=s.type==="inline"?"":s.path;
      const next:PlotSource=v==="mesh"?{id:s.id,type:"mesh",path,kind:"Nodes"}:v==="history"?{id:s.id,type:"history",path,kind:"Nodal",entityId:1,variable:""}:v==="probe"?{id:s.id,type:"probe",path,points:[[0,0,0],[1,0,0]],variable:"",samples:101}:v==="inline"?{id:s.id,type:"inline",table:{columns:[],rows:[],diagnostics:[]}}:{id:s.id,type:"table",path};
      recipe.sources[recipe.sources.indexOf(s)]=next;inventories.delete(s.id);renderConfig();
    });
    if(s.type!=="inline"){input(box,"File",s.path,v=>{s.path=v;inventories.delete(s.id);});button(box,"Browse…",()=>post({type:"plotBrowse",target:s.id}));}
    else { const info = document.createElement("p");info.textContent = `Saved/inline snapshot: ${s.table.rows.length} rows. Source data is included in this recipe.`;box.appendChild(info); }
    if(s.type==="table") {
      const o=s.options??(s.options={});select(box,"Delimiter",o.delimiter??"auto",[{value:"auto",label:"Detect"},{value:",",label:"Comma"},{value:"\t",label:"Tab"},{value:";",label:"Semicolon"},{value:"|",label:"Pipe"}],v=>{o.delimiter=v==="auto"?undefined:v as ",";});
      select(box,"Headers",o.header===undefined?"auto":String(o.header),[{value:"auto",label:"Detect"},{value:"true",label:"First record"},{value:"false",label:"No header"}],v=>{o.header=v==="auto"?undefined:v==="true";});
      input(box,"Missing tokens",(o.missing??["","NA","N/A","null"]).join(","),v=>{o.missing=v.split(",");});input(box,"Numeric columns",o.numericColumns?.join(",")??"",v=>{o.numericColumns=v.trim()?v.split(",").map(v=>v.trim()):undefined;});
      input(box,"Units (c1=Pa,…)",Object.entries(o.units??{}).map(([k,v])=>`${k}=${v}`).join(","),v=>{o.units=Object.fromEntries(v.split(",").filter(Boolean).map(v=>v.split("=").map(s=>s.trim())));});
    } else if(s.type==="mesh") {
      select(box,"Association",s.kind,choices(["Nodes","Elements","Conditions","Geometries"]),v=>{s.kind=v as typeof s.kind;inventories.delete(s.id);});input(box,"SubModelPart",s.submodelpart??"",v=>{s.submodelpart=v||undefined;});input(box,"Selected IDs",s.ids?.join(",")??"",v=>{s.ids=v.trim()?v.split(",").map(Number):undefined;});input(box,"Frame index",s.timeStep===undefined?"":String(s.timeStep),v=>{s.timeStep=v.trim()?Number(v):undefined;});
    } else if(s.type==="history") {
      select(box,"Association",s.kind,choices(["Nodal","Elemental","Conditional"]),v=>{s.kind=v as typeof s.kind;});input(box,"Entity ID",String(s.entityId),v=>{s.entityId=Number(v);},"number");input(box,"Field",s.variable,v=>{s.variable=v;});input(box,"Physical times",s.times?.join(",")??"",v=>{s.times=v.trim()?v.split(",").map(Number):undefined;});input(box,"Time unit",s.timeUnit??"",v=>{s.timeUnit=v||undefined;});input(box,"Owning run ID",s.runId??"",v=>{s.runId=v||undefined;});
    } else if(s.type==="probe") {
      input(box,"Nodal field",s.variable,v=>{s.variable=v;});input(box,"Endpoints (x y z;…)",s.points.map(p=>p.join(" ")).join("; "),v=>{s.points=v.split(";").map(p=>p.trim().split(/\s+/).map(Number) as [number,number,number]);});input(box,"Samples",String(s.samples??101),v=>{s.samples=Number(v);},"number");
    }
    button(box,"Inspect source",()=>preview(s));button(box,"Remove source",()=>{recipe.sources=recipe.sources.filter(x=>x!==s);recipe.series=recipe.series.filter(r=>r.source!==s.id);renderConfig();schedule();});
    const cols=inventories.get(s.id);if(cols){const list=document.createElement("p");list.className="plot-muted";list.textContent=cols.map(c=>`${c.id}: ${c.label} [${c.unit??"unknown"}] (${c.type})`).join(" · ");box.appendChild(list);}
  }
  for(const s of recipe.series)renderSeries(s);
}
function renderSeries(s:PlotSeriesSpec){
  const box=section(`Series · ${s.name}`),cols=inventories.get(s.source)??[],items=cols.map(c=>({value:c.id,label:`${c.label} [${c.unit??"unknown"}] · ${c.id}`}));
  input(box,"Name",s.name,v=>{s.name=v;schedule();});select(box,"Source",s.source,choices(recipe.sources.map(s=>s.id)),v=>{s.source=v;renderConfig();schedule();});
  const column=(label:string,key:"x"|"y"|"z"|"group")=>select(box,label,s[key]??"",[{value:"",label:"None"},...items],v=>{s[key]=v||undefined as any;schedule();});column("X column","x");column("Y column","y");column("Z column","z");column("Group by","group");
  input(box,"Magnitude columns",s.components?.join(",")??"",v=>{s.components=v.trim()?v.split(",").map(v=>v.trim()):undefined;s.component=s.components?"magnitude":undefined;schedule();});
  select(box,"Panel",String(s.panel??0),Array.from({length:recipe.presentation.panels??1},(_,v)=>({value:String(v),label:String(v+1)})),v=>{s.panel=Number(v);schedule();});input(box,"Color",s.color??"#4e9af1",v=>{s.color=v;schedule();},"color");select(box,"Markers",s.marker??"circle",choices(["circle","square","diamond"]),v=>{s.marker=v as typeof s.marker;schedule();});select(box,"Visibility",s.visible===false?"hidden":"visible",choices(["visible","hidden"]),v=>{s.visible=v==="visible";schedule();});
  if(recipe.presentation.family==="histogram")input(box,"Bins",String(s.bins??20),v=>{s.bins=Number(v);schedule();},"number");
  if(recipe.presentation.family==="bar")select(box,"Statistic",s.statistic??"mean",choices(["mean","sum","min","max","count"]),v=>{s.statistic=v as typeof s.statistic;schedule();});
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
  const diagnostics=document.getElementById("plot-diagnostics")!;diagnostics.textContent="";
  const lines = [...data.diagnostics, ...data.series.flatMap(s => [
    `${s.name}: n=${s.statistics.count}, missing=${s.statistics.missing}, mean=${s.statistics.mean}, population std=${s.statistics.std}`,
    `Transformations: ${JSON.stringify(data.recipe.series.find(r => r.id === s.id || s.id.startsWith(r.id + ":"))?.transforms ?? [])}`,
    ...(s.regression ? [`Fit: ${JSON.stringify(s.regression)}`] : []),
    ...s.diagnostics.map(v => `${s.name}: ${v}`),
  ])];
  for (const line of lines) { const p = document.createElement("p"); p.textContent = line; diagnostics.appendChild(p); }
  const table=document.createElement("table"),head=document.createElement("tr");for(const v of ["Series","X","Y","Find sample"]){const c=document.createElement("th");c.textContent=v;head.appendChild(c);}table.appendChild(head);
  for(const s of data.series)for(const p of s.points.slice(0,100)){const row=document.createElement("tr");for(const v of [s.name,p.x??"—",p.y??"—"]){const c=document.createElement("td");c.textContent=String(v);row.appendChild(c);}const c=document.createElement("td");if(p.origin)button(c,"Show in mesh",()=>post({type:"plotPick",origin:p.origin}));row.appendChild(c);table.appendChild(row);}
  const samples=document.getElementById("plot-samples")!;samples.textContent="";const note=document.createElement("p");note.textContent="First 100 displayed samples per series. CSV includes every full-resolution derived and original sample.";samples.append(note,table);
}
window.addEventListener("message",e=>{
  const msg=e.data;if(!msg||typeof msg.type!=="string")return;
  if(msg.type==="plotRecipe"){
    ++requestId;clearTimeout(timer);recipe=validatePlotRecipe(msg.recipe);inventories.clear();dataset=undefined;Plotly.purge(chart);renderConfig();if(recipe.sources.length)preview(recipe.sources[0]);
  }else if(msg.type==="plotPicked"){const s=recipe.sources.find(s=>s.id===msg.target);if(s&&s.type!=="inline"){s.path=msg.path;renderConfig();preview(s);}}
  else if(msg.type==="plotSourcePreview"&&msg.requestId===requestId){inventories.set(msg.source.id,msg.columns);status.textContent=`${msg.rowCount} rows · ${msg.diagnostics.join(" ")}`;renderConfig();const area=section("Import preview");const pre=document.createElement("pre");pre.textContent=msg.rows.map((r:unknown[])=>r.map(v=>v??"—").join("\t")).join("\n");area.appendChild(pre);if(!recipe.series.length)addSeries(recipe.sources.find(s=>s.id===msg.source.id));else schedule();}
  else if(msg.type==="plotResult"&&msg.requestId===requestId){dataset=msg.dataset;let refreshControls=false;for(const s of dataset!.sources){refreshControls ||= !inventories.has(s.id);inventories.set(s.id,s.columns);}if(refreshControls)renderConfig();status.textContent=`${dataset!.partial?"Partial result · ":""}${dataset!.fullCount} full-resolution points · ${dataset!.displayCount} displayed`;describe(dataset!);draw(dataset!);}
  else if(msg.type==="plotProgress"&&msg.requestId===requestId)status.textContent=`${msg.label} (${msg.done}/${msg.total})`;
  else if(msg.type==="plotError"&&(msg.requestId===undefined||msg.requestId===requestId))status.textContent=msg.message;
  else if(msg.type==="plotNotice")status.textContent=msg.message;
});
new MutationObserver(()=>{if(dataset)draw(dataset);}).observe(document.body,{attributes:true,attributeFilter:["class","style"]});
renderActions();renderConfig();post({type:"plotReady"});
