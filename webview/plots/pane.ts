/** Mesh-native split pane. Plotly is loaded only on first use, under the preview nonce. */
import { loadPlotLibrary } from "./chart";
import { mountPlotWorkspace, type PlotBridge } from "./workspace";
import { appendFemCurve, emptyPlotRecipe, type FemPlotContext } from "../../src/parser/plot/fem";
import type { PlotSource } from "../../src/parser/plot/types";

export function initPlotPane(bridge:PlotBridge,getContext:()=>FemPlotContext,handlers:{onPickPoints(active:boolean):void;onRegion(path:string):void}) {
  const pane=document.getElementById("plot-pane")!,viewport=document.getElementById("viewport")!,sash=document.getElementById("plot-resizer")!,restore=document.getElementById("plot-restore")!;
  let workspace:ReturnType<typeof mountPlotWorkspace>|undefined,boot:Promise<void>|undefined,vertical=true,fraction=.48,pending:(()=>void)|undefined,ready=false;
  const size=()=>{pane.style.width=vertical?`${fraction*100}%`:"100%";pane.style.height=vertical?"100%":`${fraction*100}%`;viewport.classList.toggle("plot-vertical",vertical);sash.setAttribute("aria-orientation",vertical?"vertical":"horizontal");sash.setAttribute("aria-valuenow",String(Math.round(fraction*100)));};
  function collapse(){pane.classList.add("hidden");sash.classList.add("hidden");viewport.classList.remove("plot-open","plot-vertical");restore.classList.remove("hidden");workspace?.stopPicking();}
  function show(){window.dispatchEvent(new Event("plot-pane-show"));pane.classList.remove("hidden");sash.classList.remove("hidden");restore.classList.add("hidden");viewport.classList.add("plot-open");size();}
  async function open(notify=true){
    show();if(notify)bridge.postMessage({type:"plotOpen"});
    if(workspace){bridge.postMessage({type:"plotContextRequest"});return;}
    try {const script=document.getElementById("preview-main") as HTMLScriptElement;await (boot??=loadPlotLibrary(script.dataset.plotLibrary??"",script.nonce??"").then(()=>{workspace=mountPlotWorkspace(document.getElementById("plot-app")!,bridge,{embedded:true,...handlers});workspace.setContext(getContext());}));}
    catch(e){boot=undefined;document.getElementById("plot-status")!.textContent=String(e);}
  }
  const afterReady=(action:()=>void)=>{if(workspace&&ready)action();else pending=action;};
  const applyPreset=(preset:any)=>{
    const context=getContext();
    if(preset?.type==="history")workspace?.plotPoint(preset.kind,preset.entityId,preset.variable);
    else if(preset?.type==="probe"){const field=context.fields.find(f=>f.kind==="Nodal"&&f.variable===preset.variable);const source:PlotSource={...preset,id:`probe:${Date.now()}`,path:context.path,timeStep:context.frameIndex};workspace?.setRecipe(appendFemCurve(emptyPlotRecipe(),source,field&&field.components>1?"magnitude":0,field?.components??1,`${preset.variable} · line profile`));}
    else if(preset?.type==="mesh")workspace?.setRecipe(emptyPlotRecipe({...preset,id:"mesh",path:context.path,timeStep:context.frameIndex}));
  };
  document.getElementById("plot-hide")!.addEventListener("click",collapse);restore.addEventListener("click",()=>void open());
  document.getElementById("plot-orient")!.addEventListener("click",()=>{vertical=!vertical;document.getElementById("plot-orient")!.textContent=vertical?"Dock below":"Dock beside";size();});
  window.addEventListener("flowgraph-pane-show",()=>{if(!pane.classList.contains("hidden"))collapse();});
  window.addEventListener("keydown",e=>{if(e.key==="Escape")workspace?.stopPicking();});
  let dragging=false;
  sash.addEventListener("pointerdown",e=>{dragging=true;sash.setPointerCapture(e.pointerId);e.preventDefault();});
  sash.addEventListener("pointermove",e=>{if(!dragging)return;const rect=viewport.getBoundingClientRect();fraction=Math.max(.2,Math.min(.75,vertical?(rect.right-e.clientX)/rect.width:(rect.bottom-e.clientY)/rect.height));size();});
  sash.addEventListener("pointerup",()=>{dragging=false;});sash.addEventListener("pointercancel",()=>{dragging=false;});
  sash.addEventListener("keydown",e=>{if(["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End"].includes(e.key)){e.preventDefault();fraction=e.key==="Home"?.2:e.key==="End"?.75:Math.max(.2,Math.min(.75,fraction+(["ArrowLeft","ArrowUp"].includes(e.key)?.03:-.03)));size();}});
  return {open,receive:(msg:any)=>{
    if(msg.type==="plotReveal"){void open(false);if(msg.preset)afterReady(()=>applyPreset(msg.preset));return;}
    if(!workspace)return;
    workspace.receive(msg);
    if(msg.type==="plotRecipe"&&!ready){ready=true;const action=pending;pending=undefined;action?.();}
  },plotPoint:(kind:"Nodal"|"Elemental"|"Conditional",id:number,variable?:string)=>{void open();afterReady(()=>workspace?.plotPoint(kind,id,variable));},selectRegion:(path:string)=>{void open();afterReady(()=>workspace?.selectRegion(path));handlers.onRegion(path);},pick:(kind:"Nodal"|"Elemental"|"Conditional",id:number)=>workspace?.pick(kind,id),update:()=>{if(workspace)bridge.postMessage({type:"plotContextRequest"});}};
}
