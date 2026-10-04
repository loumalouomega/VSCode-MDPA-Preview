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

export interface PlotOwner {
  path: string;
  model?: MdpaModel;
  source?: PlotSource;
  frameIndex?: number;
  pick?(origin:PlotOrigin):void;
}
export function openPlotBuilder(context:vscode.ExtensionContext,owner?:PlotOwner):vscode.WebviewPanel {
  const panel=vscode.window.createWebviewPanel("kratos.plotBuilder","Scientific plots",vscode.ViewColumn.Beside,{enableScripts:true,localResourceRoots:[vscode.Uri.joinPath(context.extensionUri,"media")],retainContextWhenHidden:true});
  const media=(name:string)=>panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri,"media",name)).toString();
  panel.webview.html=plotHtml(media("plots.js"),media("plotly/plotly.min.js"),media("design-system.css"),media("plots.css"),getNonce(),panel.webview.cspSource);
  let recipe=emptyPlotRecipe(owner?.source??(owner?{id:"mesh",type:"mesh",path:owner.path,kind:"Nodes"}:undefined));
  let result:PlotDataset|undefined,abort:AbortController|undefined,disposed=false,generation=0;
  let resultRequestId: number | undefined;
  const session = new PlotWorkerSession();
  const models:Record<string,MdpaModel>=Object.create(null);
  if(owner?.model && recipe.sources[0] && ["mesh","probe"].includes(recipe.sources[0].type))models[recipe.sources[0].id]=owner.model;
  const snapshotSource = recipe.sources[0];
  const applicableModels = (sources: PlotSource[]) => Object.fromEntries(sources.filter(s => s.type !== "inline" && snapshotSource?.type !== "inline" && s.id === snapshotSource?.id && s.type === snapshotSource.type && s.path === snapshotSource.path && s.type !== "history" && s.type !== "table" && s.timeStep === (snapshotSource as typeof s).timeStep && models[s.id]).map(s => [s.id,models[s.id]]));
  const post=(message:unknown)=>{if(!disposed)void panel.webview.postMessage(message);};
  const error=(e:unknown,requestId?:number)=>post({type:"plotError",requestId,message:e instanceof Error?e.message:String(e)});
  const evaluate=async(msg:any)=>{
    const current=++generation;abort?.abort();const controller=new AbortController();abort=controller;
    const requestId=Number(msg.requestId);
    try {
      const next=validatePlotRecipe(msg.recipe);recipe=next;
      result=undefined; resultRequestId=undefined;
      const snapshots = applicableModels(next.sources);
      const dataset=await session.run({recipe:next,models:snapshots}, {signal:controller.signal,progress:(done,total,label)=>{if(current===generation)post({type:"plotProgress",requestId,done,total,label});}}) as PlotDataset;
      if(current!==generation||disposed)return;
      for (const s of dataset.series) for (const points of [s.points,s.original]) for (const p of points) if (p.origin && snapshots[p.origin.source]) p.origin.frameIndex = owner?.frameIndex;
      result=dataset; resultRequestId=requestId;
      const display = displayPlot(dataset); dataset.displayCount = display.displayCount;
      post({type:"plotResult",requestId,dataset:display});
    }catch(e){if(current===generation)error(e,requestId);}finally{if(abort===controller)abort=undefined;}
  };
  const preview=async(source:PlotSource,requestId:number)=>{
    const current=++generation;abort?.abort();const controller=new AbortController();abort=controller;
    try {
      validatePlotRecipe(emptyPlotRecipe(source));
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
  const receive=panel.webview.onDidReceiveMessage((msg:any)=>{
    void (async()=>{
      if(msg.type==="plotReady")post({type:"plotRecipe",recipe});
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
        ++generation;abort?.abort();result=undefined;for(const key of Object.keys(models))delete models[key];recipe=next;post({type:"plotRecipe",recipe});
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
        if(exists&&owner&&source&&source.type!=="inline"&&origin.entityKind&&origin.entityId!==undefined&&!origin.runId&&path.resolve(source.path)===path.resolve(owner.path))owner.pick?.(origin);
        else post({type:"plotNotice",message:"This sample does not belong to the owning mesh preview (or is interpolated)."});
      }
    })().catch(e=>error(e,msg.requestId));
  });
  panel.onDidDispose(()=>{disposed=true;++generation;abort?.abort();session.dispose();receive.dispose();});
  context.subscriptions.push(panel);return panel;
}
