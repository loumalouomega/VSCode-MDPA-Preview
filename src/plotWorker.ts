/** Packaged, cancellable host execution boundary for graphical plots and MCP. */
import { parentPort } from "node:worker_threads";
import { collectPlot, loadPlotSource } from "./parser/plot/sources";
import { validatePlotRecipe } from "./parser/plot/recipe";
import type { PlotRecipe, PlotTable, PlotDataset, PlotExecution, PlotSource } from "./parser/plot/types";
import { PlotTableCache } from "./parser/plot/cache";
import { bindPlotRun, discoverPlotRuns, resolvePlotTimeCursor, type PlotRunDiscovery, type PlotTimeCursorRequest, type PlotTimeCursorResult } from "./parser/plot/runs";
import type { PlotRunBinding } from "./parser/plot/types";
import { resolvePlotRunTarget, type PlotRunTargetRequest, type PlotRunTarget } from "./parser/plot/navigation";

export type PlotWork = {recipe:PlotRecipe;models?:PlotExecution["models"];reuseSources?:string[]} | {source:PlotSource;models?:PlotExecution["models"]}
  | {runs:string[]} | {bindRun:{recordPath:string;path:string}} | {timeCursor:PlotTimeCursorRequest} | {runTarget:PlotRunTargetRequest};
export type PlotWorkResult = PlotDataset | PlotTable | PlotRunDiscovery | PlotRunBinding | PlotTimeCursorResult | PlotRunTarget;
export type PlotWorkReply = {type:"progress";done:number;total:number;label:string} | {type:"partial";result:PlotDataset} | {type:"done";result:PlotWorkResult} | {type:"error";message:string};
if(parentPort) {
  const port=parentPort;
  const cache = new PlotTableCache();
  const retained = new PlotTableCache(64 * 1024 * 1024,"Fixed extraction reused from the last explicit collection; Refresh rereads sources.");
  port.on("message",async(work:PlotWork)=>{
    try {
      if("runs" in work||"bindRun" in work||"timeCursor" in work||"runTarget" in work) {
        const result="runs" in work?await discoverPlotRuns(work.runs):"bindRun" in work?await bindPlotRun(work.bindRun.recordPath,work.bindRun.path):"runTarget" in work?await resolvePlotRunTarget(work.runTarget):await resolvePlotTimeCursor(work.timeCursor);
        port.postMessage({type:"done",result});return;
      }
      if (!("recipe" in work) || !work.reuseSources) retained.clear();
      const result="recipe" in work?await collectPlot(validatePlotRecipe(work.recipe),{models:work.models,progress:(done,total,label)=>port.postMessage({type:"progress",done,total,label}),partial:result=>port.postMessage({type:"partial",result})},cache,{cache:retained,reuseSources:work.reuseSources}):await loadPlotSource(work.source,{models:work.models},cache);
      port.postMessage({type:"done",result});
    }catch(e){port.postMessage({type:"error",message:e instanceof Error?e.message:String(e)});}
  });
}
