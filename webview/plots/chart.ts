import type { PlotDataset, PlotPoint, PlotSeriesData, PlotSeriesSpec } from "../../src/parser/plot/types";
export let Plotly = (window as unknown as { Plotly: { react(element:HTMLElement,data:unknown[],layout:unknown,config:unknown):Promise<void>; relayout(element:HTMLElement,update:unknown):Promise<void>; toImage(element:HTMLElement,options:unknown):Promise<string>; purge(element:HTMLElement):void } }).Plotly;
let loading:Promise<void>|undefined;
export function loadPlotLibrary(url:string,nonce:string):Promise<void> {
  if(Plotly)return Promise.resolve();
  return loading??=new Promise((resolve,reject)=>{const script=document.createElement("script");script.src=url;script.nonce=nonce;script.onload=()=>{Plotly=(window as any).Plotly;if(Plotly)resolve();else {loading=undefined;reject(new Error("Local plotting library did not initialize."));}};script.onerror=()=>{loading=undefined;script.remove();reject(new Error("Could not load the packaged plotting library."));};document.head.appendChild(script);});
}
export type PlotElement=HTMLElement&{on?:(event:string,callback:(e:any)=>void)=>void;removeAllListeners?:(event:string)=>void};
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
const label=(c:{label:string;unit?:string})=>escape(`${c.label} [${c.unit??"unknown"}]`);
export async function renderPlotChart(el:PlotElement,dataset:PlotDataset,onPick:(p:PlotPoint)=>void):Promise<void> {
  const style=getComputedStyle(document.body),fg=style.getPropertyValue("--vscode-editor-foreground").trim()||"#cccccc",bg=style.getPropertyValue("--vscode-editor-background").trim()||"#1e1e1e";
  const p=dataset.recipe.presentation,family=p.family;
  const traces=dataset.series.map((s:PlotSeriesData)=>{
    const spec=dataset.recipe.series.find(r=>r.id===s.id||s.id.startsWith(r.id+":")) as PlotSeriesSpec;
    const panel=spec?.panel??0, axis=panel?String(panel+1):"";
    const points=s.points.map(v=>({...v,x:p.xScale==="log"&&typeof v.x==="number"&&v.x<=0?null:v.x,y:p.yScale==="log"&&v.y!==null&&v.y<=0?null:v.y}));
    const common={name:escape(s.name),xaxis:`x${axis}`,yaxis:`y${axis}`,visible:spec?.visible===false?"legendonly":true,marker:{color:spec?.color,symbol:spec?.marker??"circle",size:6},line:{color:spec?.color,width:2},customdata:points,connectgaps:false};
    if(family==="heatmap"||family==="contour")return {...common,type:family,x:s.grid?.x,y:s.grid?.y,z:s.grid?.z,connectgaps:false,hoverongaps:false,colorscale:"Viridis",colorbar:{title:{text:s.zColumn?label(s.zColumn):"Value"}}};
    if(family==="box")return {...common,type:"box",x:[s.name],q1:[s.box?.[1]],median:[s.box?.[2]],q3:[s.box?.[3]],lowerfence:[s.box?.[0]],upperfence:[s.box?.[4]],boxpoints:false};
    return {...common,type:family==="bar"||family==="histogram"?"bar":"scatter",mode:family==="scatter"?"markers":"lines+markers",x:points.map(v=>v.x),y:points.map(v=>v.y),...(points.some(v=>v.error!==undefined)?{error_y:{type:"data",array:points.map(v=>v.error),visible:true}}:{}),hovertemplate:"%{x}<br>%{y}<extra>%{fullData.name}</extra>"};
  });
  const layout:any={title:{text:escape(p.title)},paper_bgcolor:bg,plot_bgcolor:bg,font:{color:fg,family:style.fontFamily,size:12},margin:{l:70,r:45,t:55,b:65},showlegend:true,barmode:"group",hovermode:"closest",annotations:(p.annotations??[]).map(a=>({...a,text:escape(a.text),showarrow:true})),grid:{rows:p.panels===4?2:p.panels===2?2:1,columns:p.panels===4?2:1,pattern:"independent"},uirevision:JSON.stringify([family,p.xScale,p.yScale,p.panels])};
  for(let i=0;i<(p.panels??1);i++) {
    const suffix=i?String(i+1):"",s=dataset.series.find(d=>{const spec=dataset.recipe.series.find(r=>r.id===d.id||d.id.startsWith(r.id+":"));return(spec?.panel??0)===i;});
    layout[`xaxis${suffix}`]={title:{text:p.xLabel?escape(p.xLabel):s?label(s.xColumn):"X"},type:family==="bar"||family==="box"||s?.xColumn.type==="text"?"category":p.xScale??"linear",...(p.xRange?{range:p.xRange.map(v=>p.xScale==="log"?Math.log10(v):v)}:{})};
    layout[`yaxis${suffix}`]={title:{text:p.yLabel?escape(p.yLabel):s?label(s.yColumn):"Y"},type:p.yScale??"linear",...(p.yRange?{range:p.yRange.map(v=>p.yScale==="log"?Math.log10(v):v)}:{})};
  }
  await Plotly.react(el,traces,layout,{responsive:true,displaylogo:false,scrollZoom:true,modeBarButtonsToRemove:["toImage"],editable:false});
  el.removeAllListeners?.("plotly_click");
  el.on?.("plotly_click",e=>{const point=e.points?.[0]?.customdata as PlotPoint|undefined;if(point?.origin)onPick(point);});
}
