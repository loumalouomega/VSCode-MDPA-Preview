/** Packaged, cancellable host execution boundary for graphical plots and MCP. */
import { parentPort } from "node:worker_threads";
import { collectPlot, loadPlotSource } from "./parser/plot/sources";
import { validatePlotRecipe } from "./parser/plot/recipe";
import type { PlotRecipe, PlotTable, PlotDataset, PlotExecution, PlotSource } from "./parser/plot/types";
import { chunkResult } from "./plotChunks";
import { PlotTableCache } from "./parser/plot/cache";
import { PersistentPlotCache } from "./parser/plot/persistentCache";
import { bindPlotRun, resolvePlotRun, discoverPlotRuns, resolvePlotTimeCursor, type PlotRunDiscovery, type PlotRunResolution, type PlotTimeCursorRequest, type PlotTimeCursorResult } from "./parser/plot/runs";
import type { PlotRunBinding } from "./parser/plot/types";
import { resolvePlotRunTarget, type PlotRunTargetRequest, type PlotRunTarget } from "./parser/plot/navigation";

/** `cacheDir` opts disk-backed extractions into the bounded persistent cache; absent = off. */
export type PlotWork = {recipe:PlotRecipe;models?:PlotExecution["models"];reuseSources?:string[];cacheDir?:string} | {source:PlotSource;models?:PlotExecution["models"];cacheDir?:string}
  | {runs:string[]} | {bindRun:{recordPath:string;path:string}} | {resolveRun:{path:string;recordPath?:string}} | {timeCursor:PlotTimeCursorRequest} | {runTarget:PlotRunTargetRequest};
export type PlotWorkResult = PlotDataset | PlotTable | PlotRunDiscovery | PlotRunBinding | PlotTimeCursorResult | PlotRunTarget | PlotRunResolution;
export type PlotWorkReply = {type:"chunk";path:(string|number)[];items:unknown[]} | {type:"done";result:PlotWorkResult;arrays:{path:(string|number)[];aliasOf?:(string|number)[]}[]} | {type:"progress";done:number;total:number;label:string} | {type:"partial";result:PlotDataset} | {type:"error";message:string};
if(parentPort) {
  const port=parentPort;
  // Flow control: Node drains every queued message of a port in one task, so unpaced chunks would
  // still deserialize back to back on the host. The host acks each chunk from a later turn.
  let waiting:(()=>void)|undefined;
  const done=async(result:PlotWorkResult)=>{
    const c=chunkResult(result);
    for(const k of c.chunks){
      const acked=new Promise<void>(r=>{waiting=r;});
      port.postMessage({type:"chunk",path:k.path,items:k.items});
      await acked;
    }
    port.postMessage({type:"done",result:c.head,arrays:c.arrays});
  };
  const cache = new PlotTableCache();
  const retained = new PlotTableCache(64 * 1024 * 1024,"Fixed extraction reused from the last explicit collection; Refresh rereads sources.");
  port.on("message",async(work:PlotWork|{type:"ack"})=>{
    if("type" in work&&work.type==="ack"){const w=waiting;waiting=undefined;w?.();return;}
    work=work as PlotWork;
    try {
      if("runs" in work||"bindRun" in work||"resolveRun" in work||"timeCursor" in work||"runTarget" in work) {
        const result="runs" in work?await discoverPlotRuns(work.runs):"bindRun" in work?await bindPlotRun(work.bindRun.recordPath,work.bindRun.path):"resolveRun" in work?await resolvePlotRun(work.resolveRun):"runTarget" in work?await resolvePlotRunTarget(work.runTarget):await resolvePlotTimeCursor(work.timeCursor);
        await done(result);return;
      }
      if (!("recipe" in work) || !work.reuseSources) retained.clear();
      const persistent=work.cacheDir?new PersistentPlotCache(work.cacheDir):undefined;
      const result="recipe" in work?await collectPlot(validatePlotRecipe(work.recipe),{models:work.models,persistent,progress:(done,total,label)=>port.postMessage({type:"progress",done,total,label}),partial:result=>port.postMessage({type:"partial",result})},cache,{cache:retained,reuseSources:work.reuseSources}):await loadPlotSource(work.source,{models:work.models,persistent},cache);
      await done(result);
    }catch(e){port.postMessage({type:"error",message:e instanceof Error?e.message:String(e)});}
  });
}
