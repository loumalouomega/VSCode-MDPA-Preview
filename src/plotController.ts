/** Standalone read-only workspace. It may be owned by a mesh preview, never its history. */
import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getNonce } from "./webviewChrome";
import { emptyPlotRecipe, samePlotSource, validatePlotRecipe } from "./parser/plot/recipe";
import { resolvePlotPaths } from "./parser/plot/sources";
import { displayPlot } from "./parser/plot/numerics";
import { plotManifest } from "./parser/plot/export";
import { writePlotCsv, assertPlotDestination } from "./parser/plot/files";
import { PlotWorkerSession, runPlotWorker } from "./plotWorkerClient";
import type { MdpaModel } from "./parser/types";
import type { PlotDataset, PlotOrigin, PlotRecipe, PlotSource, PlotTable, PlotRunBinding } from "./parser/plot/types";
import type { PlotRunDiscovery, PlotTimeCursorRequest, PlotTimeCursorResult } from "./parser/plot/runs";
import { RUN_SIDECAR_INDEX_KEY } from "./problemtype/runReceipt";
import { runFilePath } from "./problemtype/caseFile";
import { plotHtml } from "./parser/plot/html";
import { femPlotContext } from "./parser/plot/fem";
import { planPlotFollow, plotSnapshotOnTimeline } from "./parser/plot/follow";
import type { PlotRunTarget, PlotRunTargetRequest } from "./parser/plot/navigation";
import { openPlotRunTarget } from "./plotPreviewNavigation";

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
  let runAbort:AbortController|undefined,runAction=0;
  const session = new PlotWorkerSession();
  const models:Record<string,MdpaModel>=Object.create(null);
  if(owner?.model && recipe.sources[0] && ["mesh","probe"].includes(recipe.sources[0].type))models[recipe.sources[0].id]=owner.model;
  const snapshotSource = recipe.sources[0];
  const pinned=new Map<string,{signature:string;model:MdpaModel;frameIndex?:number;timelineId?:string}>();
  const applicableModels = (sources: PlotSource[], reuseFixed = false) => {
    if(!getOwner)return Object.fromEntries(sources.filter(s => !s.run && s.type !== "inline" && snapshotSource?.type !== "inline" && s.id === snapshotSource?.id && s.type === snapshotSource.type && s.path === snapshotSource.path && s.type !== "history" && s.type !== "table" && s.timeStep === (snapshotSource as typeof s).timeStep && models[s.id]).map(s => [s.id,models[s.id]]));
    const snapshots:Record<string,MdpaModel>=Object.create(null);
    for(const s of sources)if(!s.run&&s.type!=="inline"&&s.type!=="table"&&s.type!=="history"&&!(s.type==="region"&&s.scope==="history")&&owner?.model&&path.resolve(s.path)===path.resolve(owner.path)){
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
  const runCurrent=(action:number)=>!disposed&&action===runAction;
  const sameRunSource=(source:PlotSource)=>samePlotSource(recipe.sources.find(s=>s.id===source.id),source);
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
    await assertPlotDestination(file,{recipe});
  };
  const runOperation=async<T>(task:(signal:AbortSignal)=>Promise<T>):Promise<T>=>{
    runAbort?.abort();const controller=new AbortController();runAbort=controller;
    try{return await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:"Verify saved run results",cancellable:true},async(_progress,token)=>{
      const cancel=token.onCancellationRequested(()=>controller.abort());
      try{return await task(controller.signal);}finally{cancel.dispose();}
    });}finally{if(runAbort===controller)runAbort=undefined;}
  };
  const selectRun=async(msg:any,action:number)=>{
    const settingsGeneration=generation;
    const known=context.workspaceState.get<string[]>(RUN_SIDECAR_INDEX_KEY,[]);
    const choice=await vscode.window.showQuickPick([...(known.length?[{label:"Tracked runs",action:"tracked"}]:[]),{label:"Choose saved run directory…",action:"browse"}],{title:"Choose plotting run",placeHolder:"Runs keep their own identity; the active case is not used."});
    if(!choice||!runCurrent(action))return;
    let paths:string[];
    if(choice.action==="tracked")paths=[...new Set(known.flatMap(file=>[runFilePath(file),path.dirname(file)]))].slice(0,64);
    else {
      const picked=await vscode.window.showOpenDialog({title:"Choose a directory containing saved run receipts",canSelectFiles:false,canSelectFolders:true,canSelectMany:false});
      if(!picked||!runCurrent(action))return;paths=[picked[0].fsPath];
    }
    const discovery=await runOperation(signal=>runPlotWorker({runs:paths},{signal})) as PlotRunDiscovery;
    if(!runCurrent(action))return;
    const selected=await vscode.window.showQuickPick(discovery.runs.map(run=>({label:run.runId,description:`${run.ownerId??"unresolved owner"} · ${run.state} · ${run.verifiable?"recorded isolated run":"unresolved output ownership"}`,detail:run.recordPath,run})),{title:"Saved/tracked runs",placeHolder:discovery.diagnostics.join(" ")||"Select a run; legacy/shared output ownership stays unresolved."});
    if(!selected||!runCurrent(action))return;
    if(!selected.run.verifiable){post({type:"plotNotice",message:selected.run.diagnostics.join(" ")});return;}
    const result=await vscode.window.showQuickPick(selected.run.results.map(file=>({label:path.basename(file),description:path.dirname(file),file})),{title:`Result of ${selected.run.runId}`,placeHolder:"Select the source/rank explicitly; IDs do not establish correspondence across meshes."});
    if(!result||!runCurrent(action))return;
    const run=await runOperation(signal=>runPlotWorker({bindRun:{recordPath:selected.run.recordPath,path:result.file}},{signal})) as PlotRunBinding;
    if(runCurrent(action)&&generation!==settingsGeneration){post({type:"plotNotice",message:"Plot settings changed while choosing a run; select again explicitly."});return;}
    if(runCurrent(action))post({type:"plotRunSelected",target:msg.target,signature:msg.signature,path:result.file,run});
  };
  const openRunSource=async(source:PlotSource,action:number)=>{
    const settingsGeneration=generation;
    validatePlotRecipe(emptyPlotRecipe(source));
    if(source.type==="inline"||!source.run)throw new Error("Select a verified owning run first.");
    const run=await runOperation(signal=>runPlotWorker({bindRun:{recordPath:source.run!.recordPath,path:source.path}},{signal})) as PlotRunBinding;
    if((Object.keys(run) as (keyof PlotRunBinding)[]).some(key=>run[key]!==source.run![key]))throw new Error("Run/source changed; rebind explicitly before opening its result.");
    if(!runCurrent(action))return;
    if(generation!==settingsGeneration||!sameRunSource(source))throw new Error("Source settings changed while verifying the run; open again explicitly.");
    await vscode.commands.executeCommand("vscode.openWith",vscode.Uri.file(source.path),source.path.toLowerCase().endsWith(".mdpa")?"kratos.mdpaPreview":"kratos.vtkPreview",vscode.ViewColumn.Beside);
  };
  const navigateRun=async(source:PlotSource,request:PlotRunTargetRequest,action:number,settingsGeneration:number)=>{
    const current=()=>runCurrent(action)&&generation===settingsGeneration&&sameRunSource(source);
    await runOperation(async signal=>{
      const target=await runPlotWorker({runTarget:request},{signal}) as PlotRunTarget;
      if(!runCurrent(action))return;
      if(!current())throw new Error("Source settings changed while locating the sample; select again explicitly.");
      await openPlotRunTarget(target,current,signal);
      if(current())post({type:"plotNotice",message:`${source.run!.runId}: opened owning frame index ${target.frameIndex}${request.entityKind?` · ${request.entityKind} ID ${request.entityId}`:""}. Other previews were not redirected.`});
    });
  };
  const timeCursor=async(source:PlotSource,action:number,navigate=false)=>{
    const settingsGeneration=generation;
    validatePlotRecipe(emptyPlotRecipe(source));
    if((source.type!=="history"&&source.type!=="region")||!source.run)throw new Error("Physical-time cursors require a bound history/region source.");
    const timeUnit=source.timeUnit??await vscode.window.showInputBox({title:"Physical-time unit",prompt:"Supply the unit of your times; filename steps are not seconds.",validateInput:v=>v.trim()?undefined:"Choose a supplied time unit."});
    if(!timeUnit||!runCurrent(action))return;
    const input=await vscode.window.showInputBox({title:`Physical-time cursor [${timeUnit}]`,validateInput:v=>v.trim()&&Number.isFinite(Number(v))?undefined:"Supply a finite physical time."});
    if(input===undefined||!runCurrent(action))return;
    const method=await vscode.window.showQuickPick(["exact","nearest"] as const,{title:"Physical-time matching rule"});if(!method||!runCurrent(action))return;
    const tolerance=method==="exact"?"0":await vscode.window.showInputBox({title:`Nearest tolerance [${timeUnit}]`,validateInput:v=>v.trim()&&Number.isFinite(Number(v))&&Number(v)>=0?undefined:"Supply a nonnegative finite tolerance."});
    if(tolerance===undefined||!runCurrent(action))return;
    const request:PlotTimeCursorRequest={path:source.path,run:source.run,time:Number(input),timeUnit,times:source.times,method:method==="exact"?"exact":"nearest",tolerance:Number(tolerance)};
    const result=await runOperation(signal=>runPlotWorker({timeCursor:request},{signal})) as PlotTimeCursorResult;
    if(!runCurrent(action))return;
    if(generation!==settingsGeneration||!sameRunSource(source))throw new Error("Source settings changed while resolving the cursor; resolve again explicitly.");
    if(navigate&&result.matched){await navigateRun(source,{path:source.path,run:source.run,frameIndex:result.frameIndex!},action,settingsGeneration);return;}
    post({type:"plotNotice",message:result.matched?`${result.runId}: physical time ${result.time} [${timeUnit}] → frame index ${result.frameIndex}. Open the owning result explicitly; other previews are not redirected.`:result.diagnostics.join(" ")});
  };
  const receive=(msg:any)=>{
    if(disposed||typeof msg?.type!=="string"||!msg.type.startsWith("plot")||msg.type==="plotOpen")return false;
    void (async()=>{
      if(msg.type==="plotReady") {sendContext();post({type:"plotRecipe",recipe:getOwner?emptyPlotRecipe():recipe});}
      else if(msg.type==="plotContextRequest")sendContext();
      else if(msg.type==="plotEvaluate")await evaluate(msg);
      else if(msg.type==="plotCancel")abort?.abort();
      else if(msg.type==="plotInvalidate") { ++generation; abort?.abort(); result=undefined; resultRequestId=undefined; }
      else if(msg.type==="plotPreview")await preview(msg.source,Number(msg.requestId));
      else if(["plotRunBrowse","plotRunOpen","plotTimeCursor","plotTimeCursorOpen"].includes(msg.type)) {
        runAbort?.abort();const action=++runAction;
        try {
          if(msg.type==="plotRunBrowse")await selectRun(msg,action);
          else if(msg.type==="plotRunOpen")await openRunSource(msg.source,action);
           else await timeCursor(msg.source,action,msg.type==="plotTimeCursorOpen");
        }catch(e){if(runCurrent(action))error(e);}
      }
      else if(msg.type==="plotBrowse") {
        const picked=await vscode.window.showOpenDialog({canSelectMany:false,title:"Choose a table or simulation source"});
        if(picked)post({type:"plotPicked",path:picked[0].fsPath,target:msg.target});
      } else if(msg.type==="plotSaveRecipe") {
        if (abort) throw new Error("Wait for collection to finish (or cancel it) before saving a live-snapshot recipe.");
        const next=validatePlotRecipe(msg.recipe),saveGeneration=generation;const target=await destination(".json");if(!target||disposed)return;await assertDestination(target.fsPath);
        await assertPlotDestination(target.fsPath,{recipe:next});
        if (abort || generation!==saveGeneration || disposed) throw new Error("The plot changed while choosing the recipe destination. Wait for collection to finish and save again.");
        // Current-frame snapshots cannot pretend to be reproducible disk values.
        const snapshots = applicableModels(next.sources);
        for (let i=0;i<next.sources.length;i++) { const s=next.sources[i]; if (snapshots[s.id]) {
          const table = await session.run({source:s,models:snapshots}) as PlotTable;
          table.diagnostics.push(`Saved live snapshot of ${s.type === "inline" ? s.id : s.path}; mesh edits and captured frame preserved, no live mesh links after reload.`);
          next.sources[i] = {id:s.id,type:"inline",table};
        } }
        if(disposed||generation!==saveGeneration)throw new Error("The plot changed while capturing its recipe. Save again explicitly.");
        const saved={...next,sources:next.sources.map(s=>s.type==="inline"?s:{...s,path:path.relative(path.dirname(target.fsPath),s.path),...(s.run?{run:{...s.run,recordPath:path.relative(path.dirname(target.fsPath),s.run.recordPath)}}:{})})};
        await fs.writeFile(target.fsPath,JSON.stringify(saved,null,2)+"\n");post({type:"plotNotice",message:`Recipe saved: ${target.fsPath}`});
      } else if(msg.type==="plotLoadRecipe") {
        const picked=await vscode.window.showOpenDialog({filters:{"Plot recipe":["json"]}});if(!picked||disposed)return;
        if((await fs.stat(picked[0].fsPath)).size>128*1024*1024)throw new Error("Recipe exceeds the import budget.");
        const text=await fs.readFile(picked[0].fsPath,"utf8");if(Buffer.byteLength(text)>128*1024*1024)throw new Error("Recipe exceeds the import budget.");
        const next=resolvePlotPaths(validatePlotRecipe(JSON.parse(text)),path.dirname(picked[0].fsPath));
        ++generation;abort?.abort();result=undefined;completedRecipe=undefined;completedTimelineId=undefined;pinned.clear();for(const key of Object.keys(models))delete models[key];recipe=next;post({type:"plotRecipe",recipe});
      } else if(msg.type==="plotExportCsv") {
        const data=result;if(!data || msg.requestId !== resultRequestId)throw new Error("Compute the current plot dataset first.");
        const target=await destination(".csv");if(!target||disposed)return;await assertDestination(target.fsPath);
        await writePlotCsv(target.fsPath,data);post({type:"plotNotice",message:`Full-resolution data saved: ${target.fsPath}`});
      } else if(msg.type==="plotExportImage") {
        const exported = result;
        if(!exported||msg.requestId!==resultRequestId)throw new Error("The plot changed before image export.");
        const ext=msg.format==="svg"?".svg":".png";const target=await destination(ext);if(!target||disposed)return;await assertDestination(target.fsPath);await assertPlotDestination(target.fsPath,exported);
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
        if(exists&&source?.run&&source.type!=="inline"&&source.type!=="table"&&origin.runId===source.run.runId&&origin.sourceRevision===source.run.sourceRevision&&origin.frameIndex!==undefined) {
          runAbort?.abort();const action=++runAction,settingsGeneration=generation;
          try{await navigateRun(source,{path:source.path,run:source.run,frameIndex:origin.frameIndex,entityKind:origin.entityKind,entityId:origin.entityId,submodelpart:origin.submodelpart},action,settingsGeneration);}
          catch(e){if(runCurrent(action))error(e);}
          return;
        }
        if(exists&&sameTimeline&&owner&&source&&!source.run&&source.type!=="inline"&&(origin.entityKind&&origin.entityId!==undefined||origin.submodelpart)&&!origin.runId&&path.resolve(source.path)===path.resolve(owner.path))owner.pick?.(origin);
        else post({type:"plotNotice",message:"This sample does not belong to the owning mesh preview (or is interpolated)."});
      }
    })().catch(e=>error(e,msg.requestId));
    return true;
  };
  return {receive,sendContext,dispose:()=>{disposed=true;++generation;++runAction;abort?.abort();runAbort?.abort();session.dispose();}};
}
