/** Standalone read-only workspace. It may be owned by a mesh preview, never its history. */
import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getNonce } from "./webviewChrome";
import { emptyPlotRecipe, validatePlotRecipe } from "./parser/plot/recipe";
import { resolvePlotPaths } from "./parser/plot/sources";
import { displayPlot } from "./parser/plot/numerics";
import { plotManifest } from "./parser/plot/export";
import { writePlotCsv } from "./parser/plot/files";
import { PlotWorkerSession } from "./plotWorkerClient";
import type { MdpaModel } from "./parser/types";
import type { PlotDataset, PlotOrigin, PlotRecipe, PlotSource, PlotTable } from "./parser/plot/types";
import { plotHtml } from "./parser/plot/html";
import { femPlotContext } from "./parser/plot/fem";
import { planPlotFollow, plotSnapshotOnTimeline } from "./parser/plot/follow";

export interface PlotOwner {
  path: string;
  model?: MdpaModel;
  source?: PlotSource;
  frameIndex?: number;
  hasTimeline?: boolean;
  timelineId?: string;
  pick?(origin:PlotOrigin):void;
}
export function openPlotBuilder(context:vscode.ExtensionContext,owner?:PlotOwner):vscode.WebviewPanel {
  const panel=vscode.window.createWebviewPanel("kratos.plotBuilder","Scientific plots",vscode.ViewColumn.Beside,{enableScripts:true,localResourceRoots:[vscode.Uri.joinPath(context.extensionUri,"media")],retainContextWhenHidden:true});
  const media=(name:string)=>panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri,"media",name)).toString();
  panel.webview.html=plotHtml(media("plots.js"),media("plotly/plotly.min.js"),media("design-system.css"),media("plots.css"),getNonce(),panel.webview.cspSource);
  const controller=createPlotController(context,panel.webview,owner);
  const receive=panel.webview.onDidReceiveMessage(controller.receive);
  panel.onDidDispose(()=>{controller.dispose();receive.dispose();});
  context.subscriptions.push(panel);return panel;
}

/** Same execution/dialog boundary in the embedded mesh pane and standalone editor. */
export function createPlotController(context:vscode.ExtensionContext,webview:vscode.Webview,initialOwner?:PlotOwner,getOwner?:()=>PlotOwner) {
  let owner=initialOwner;
  let recipe=emptyPlotRecipe(owner?.source??(owner?{id:"mesh",type:"mesh",path:owner.path,kind:"Nodes"}:undefined));
  let result:PlotDataset|undefined,abort:AbortController|undefined,disposed=false,generation=0;
  let resultRequestId: number | undefined;
  let completedRecipe: PlotRecipe | undefined, completedTimelineId: string | undefined;
  const session = new PlotWorkerSession();
  const models:Record<string,MdpaModel>=Object.create(null);
  if(owner?.model && recipe.sources[0] && ["mesh","probe"].includes(recipe.sources[0].type))models[recipe.sources[0].id]=owner.model;
  const snapshotSource = recipe.sources[0];
  const pinned=new Map<string,{signature:string;model:MdpaModel;frameIndex?:number;timelineId?:string}>();
  const applicableModels = (sources: PlotSource[], reuseFixed = false) => {
    if(!getOwner)return Object.fromEntries(sources.filter(s => s.type !== "inline" && snapshotSource?.type !== "inline" && s.id === snapshotSource?.id && s.type === snapshotSource.type && s.path === snapshotSource.path && s.type !== "history" && s.type !== "table" && s.timeStep === (snapshotSource as typeof s).timeStep && models[s.id]).map(s => [s.id,models[s.id]]));
    const snapshots:Record<string,MdpaModel>=Object.create(null);
    for(const s of sources)if(s.type!=="inline"&&s.type!=="table"&&s.type!=="history"&&!(s.type==="region"&&s.scope==="history")&&owner?.model&&path.resolve(s.path)===path.resolve(owner.path)){
      const signature=JSON.stringify([s.type,s.path,s.timeStep]);
      const existing=pinned.get(s.id),follows=s.type==="probe"&&s.followTimeline;
      const sameTimeline=existing?.signature!==signature||existing.timelineId===owner.timelineId;
      if((!reuseFixed||follows)&&(follows||sameTimeline)&&(s.timeStep===undefined||s.timeStep===owner.frameIndex))pinned.set(s.id,{signature,model:owner.model,frameIndex:owner.frameIndex,timelineId:owner.timelineId});
      const hit=pinned.get(s.id);if(hit?.signature===signature)snapshots[s.id]=hit.model;
    }
    // Keep only models used by the active recipe; old mesh snapshots can be large.
    const active=new Set(sources.map(s=>s.id));for(const id of pinned.keys())if(!active.has(id))pinned.delete(id);
    return snapshots;
  };
  const post=(message:unknown)=>{if(!disposed)void webview.postMessage(message);};
  const sendContext=()=>{const current=getOwner?.()??owner;if(current)post({type:"plotContext",context:{...femPlotContext(current.path,current.model,current.frameIndex,current.hasTimeline),timelineId:current.timelineId}});};
  const error=(e:unknown,requestId?:number)=>post({type:"plotError",requestId,message:e instanceof Error?e.message:String(e)});
  const evaluate=async(msg:any)=>{
    const current=++generation;abort?.abort();const controller=new AbortController();abort=controller;
    const requestId=Number(msg.requestId);
    try {
      const next=validatePlotRecipe(msg.recipe);
      if(getOwner)owner=getOwner();
      const follow = msg.followTimeline === true;
      const reuseSources = follow ? planPlotFollow(completedRecipe,next,completedTimelineId,owner) : undefined;
      const timelineId = owner?.timelineId;
      recipe=next;completedRecipe=undefined;completedTimelineId=undefined;
      result=undefined; resultRequestId=undefined;
      const snapshots = applicableModels(next.sources,follow);
      const publish=(dataset:PlotDataset)=>{if(current!==generation||disposed)return;result=dataset;resultRequestId=requestId;post({type:"plotResult",requestId,dataset:displayPlot(dataset),complete:false});};
      const dataset=await session.run({recipe:next,models:snapshots,reuseSources}, {signal:controller.signal,partial:publish,progress:(done,total,label)=>{if(current===generation)post({type:"plotProgress",requestId,done,total,label});}}) as PlotDataset;
      if(current!==generation||disposed)return;
      for (const s of dataset.series) for (const points of [s.points,s.original,...(s.peak?[[s.peak]]:[])]) for (const p of points) if (p.origin && snapshots[p.origin.source]) p.origin.frameIndex = pinned.get(p.origin.source)?.frameIndex??owner?.frameIndex;
      result=dataset; resultRequestId=requestId;
      if (!controller.signal.aborted) { completedRecipe=next;completedTimelineId=timelineId; }
      const display = displayPlot(dataset); dataset.displayCount = display.displayCount;
      post({type:"plotResult",requestId,dataset:display,complete:true});
    }catch(e){if(current===generation)error(e,requestId);}finally{if(abort===controller)abort=undefined;}
  };
  const preview=async(source:PlotSource,requestId:number)=>{
    const current=++generation;abort?.abort();const controller=new AbortController();abort=controller;
    try {
      validatePlotRecipe(emptyPlotRecipe(source));
      if(getOwner)owner=getOwner();
      result = undefined; resultRequestId = undefined;
      const table=await session.run({source,models:applicableModels([source])}, {signal:controller.signal}) as PlotTable;
      if(current===generation)post({type:"plotSourcePreview",requestId,source,columns:table.columns,rows:table.rows.slice(0,12),rowCount:table.rows.length,diagnostics:table.diagnostics});
    }catch(e){if(current===generation)error(e,requestId);}finally{if(abort===controller)abort=undefined;}
  };
  const destination=async(ext:string)=>vscode.window.showSaveDialog({title:`Save plot ${ext}`,filters:{[ext.slice(1).toUpperCase()]:[ext.slice(1)]}});
  const assertDestination=async(file:string)=>{
    const resolved=await fs.realpath(file).catch(()=>path.resolve(file));
    for(const s of recipe.sources)if(s.type!=="inline") {
      const input=await fs.realpath(s.path).catch(()=>path.resolve(s.path));
      if(resolved===input)throw new Error("A plot export cannot overwrite its source file.");
    }
  };
  const receive=(msg:any)=>{
    if(typeof msg?.type!=="string"||!msg.type.startsWith("plot")||msg.type==="plotOpen")return false;
    void (async()=>{
      if(msg.type==="plotReady") {sendContext();post({type:"plotRecipe",recipe:getOwner?emptyPlotRecipe():recipe});}
      else if(msg.type==="plotContextRequest")sendContext();
      else if(msg.type==="plotEvaluate")await evaluate(msg);
      else if(msg.type==="plotCancel")abort?.abort();
      else if(msg.type==="plotInvalidate") { ++generation; abort?.abort(); result=undefined; resultRequestId=undefined; }
      else if(msg.type==="plotPreview")await preview(msg.source,Number(msg.requestId));
      else if(msg.type==="plotBrowse") {
        const picked=await vscode.window.showOpenDialog({canSelectMany:false,title:"Choose a table or simulation source"});
        if(picked)post({type:"plotPicked",path:picked[0].fsPath,target:msg.target});
      } else if(msg.type==="plotSaveRecipe") {
        if (abort) throw new Error("Wait for collection to finish (or cancel it) before saving a live-snapshot recipe.");
        const next=validatePlotRecipe(msg.recipe);const target=await destination(".json");if(!target)return;await assertDestination(target.fsPath);
        if (abort || disposed) throw new Error("The plot changed while choosing the recipe destination. Wait for collection to finish and save again.");
        // Current-frame snapshots cannot pretend to be reproducible disk values.
        const snapshots = applicableModels(next.sources);
        for (let i=0;i<next.sources.length;i++) { const s=next.sources[i]; if (snapshots[s.id]) {
          const table = await session.run({source:s,models:snapshots}) as PlotTable;
          table.diagnostics.push(`Saved live snapshot of ${s.type === "inline" ? s.id : s.path}; mesh edits and captured frame preserved, no live mesh links after reload.`);
          next.sources[i] = {id:s.id,type:"inline",table};
        } }
        const saved={...next,sources:next.sources.map(s=>s.type==="inline"?s:{...s,path:path.relative(path.dirname(target.fsPath),s.path)})};
        await fs.writeFile(target.fsPath,JSON.stringify(saved,null,2)+"\n");post({type:"plotNotice",message:`Recipe saved: ${target.fsPath}`});
      } else if(msg.type==="plotLoadRecipe") {
        const picked=await vscode.window.showOpenDialog({filters:{"Plot recipe":["json"]}});if(!picked)return;
        const text=await fs.readFile(picked[0].fsPath,"utf8");if(text.length>128*1024*1024)throw new Error("Recipe exceeds the import budget.");
        const next=resolvePlotPaths(validatePlotRecipe(JSON.parse(text)),path.dirname(picked[0].fsPath));
        ++generation;abort?.abort();result=undefined;completedRecipe=undefined;completedTimelineId=undefined;pinned.clear();for(const key of Object.keys(models))delete models[key];recipe=next;post({type:"plotRecipe",recipe});
      } else if(msg.type==="plotExportCsv") {
        const data=result;if(!data || msg.requestId !== resultRequestId)throw new Error("Compute the current plot dataset first.");
        const target=await destination(".csv");if(!target)return;await assertDestination(target.fsPath);
        await writePlotCsv(target.fsPath,data);post({type:"plotNotice",message:`Full-resolution data saved: ${target.fsPath}`});
      } else if(msg.type==="plotExportImage") {
        const exported = result;
        if(!exported||msg.requestId!==resultRequestId)throw new Error("The plot changed before image export.");
        const ext=msg.format==="svg"?".svg":".png";const target=await destination(ext);if(!target)return;await assertDestination(target.fsPath);
        const data=String(msg.data);if(data.length>64*1024*1024||!data.startsWith(`data:image/${ext===".svg"?"svg+xml":"png"}`))throw new Error("Invalid plot image.");
        const comma=data.indexOf(",");const bytes=data.slice(0,comma).includes(";base64")?Buffer.from(data.slice(comma+1),"base64"):Buffer.from(decodeURIComponent(data.slice(comma+1)));
        await assertDestination(target.fsPath+".kratosplot.json");
        await fs.writeFile(target.fsPath,bytes);await fs.writeFile(target.fsPath+".kratosplot.json",JSON.stringify({...plotManifest(exported),graphics:{format:msg.format,displayCount:exported.displayCount,view:msg.view}},null,2)+"\n");post({type:"plotNotice",message:`Plot image saved: ${target.fsPath}`});
      } else if(msg.type==="plotPick") {
        // Only a point actually present in our dataset may claim mesh ownership.
        const origin=msg.origin as PlotOrigin;
        const exists=result?.series.some(s=>s.points.some(p=>p.origin&&JSON.stringify(p.origin)===JSON.stringify(origin)));
        const source=recipe.sources.find(s=>s.id===origin?.source);
        const snapshot=source&&["mesh","probe","region"].includes(source.type)?pinned.get(source.id):undefined;
        const sameTimeline=!snapshot||plotSnapshotOnTimeline(snapshot.timelineId,owner?.timelineId);
        if(exists&&sameTimeline&&owner&&source&&source.type!=="inline"&&(origin.entityKind&&origin.entityId!==undefined||origin.submodelpart)&&!origin.runId&&path.resolve(source.path)===path.resolve(owner.path))owner.pick?.(origin);
        else post({type:"plotNotice",message:"This sample does not belong to the owning mesh preview (or is interpolated)."});
      }
    })().catch(e=>error(e,msg.requestId));
    return true;
  };
  return {receive,sendContext,dispose:()=>{disposed=true;++generation;abort?.abort();session.dispose();}};
}
