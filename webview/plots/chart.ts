import type { PlotDataset, PlotPoint } from "../../src/parser/plot/types";
import { plotFigure } from "../../src/parser/plot/figure";
export let Plotly = (window as unknown as { Plotly: { react(element:HTMLElement,data:unknown[],layout:unknown,config:unknown):Promise<void>; relayout(element:HTMLElement,update:unknown):Promise<void>; toImage(element:HTMLElement,options:unknown):Promise<string>; purge(element:HTMLElement):void } }).Plotly;
let loading:Promise<void>|undefined;
export function loadPlotLibrary(url:string,nonce:string):Promise<void> {
  if(Plotly)return Promise.resolve();
  return loading??=new Promise((resolve,reject)=>{const script=document.createElement("script");script.src=url;script.nonce=nonce;script.onload=()=>{Plotly=(window as any).Plotly;if(Plotly)resolve();else {loading=undefined;reject(new Error("Local plotting library did not initialize."));}};script.onerror=()=>{loading=undefined;script.remove();reject(new Error("Could not load the packaged plotting library."));};document.head.appendChild(script);});
}
export type PlotElement=HTMLElement&{on?:(event:string,callback:(e:any)=>void)=>void;removeAllListeners?:(event:string)=>void};
export async function renderPlotChart(el:PlotElement,dataset:PlotDataset,onPick:(p:PlotPoint)=>void):Promise<void> {
  const style=getComputedStyle(document.body),fg=style.getPropertyValue("--vscode-editor-foreground").trim()||"#cccccc",bg=style.getPropertyValue("--vscode-editor-background").trim()||"#1e1e1e";
  const palette=["blue","orange","green","purple","red","yellow"].map((name,i)=>style.getPropertyValue(`--vscode-charts-${name}`).trim()||["#4e9af1","#f29d49","#57bf8a","#bb86fc","#e56b8a","#d8be55"][i]);
  const {traces,layout}=plotFigure(dataset,{fg,bg,font:style.fontFamily,palette});
  await Plotly.react(el,traces,layout,{responsive:true,displaylogo:false,scrollZoom:true,modeBarButtonsToRemove:["toImage"],editable:false});
  el.removeAllListeners?.("plotly_click");
  el.on?.("plotly_click",e=>{const point=e.points?.[0]?.customdata as PlotPoint|undefined;if(point?.origin)onPick(point);});
}
