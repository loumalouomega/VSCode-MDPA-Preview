/** Packaged, cancellable host execution boundary for graphical plots and MCP. */
import { parentPort } from "node:worker_threads";
import { collectPlot, loadPlotSource } from "./parser/plot/sources";
import { validatePlotRecipe } from "./parser/plot/recipe";
import type { PlotRecipe, PlotTable, PlotDataset, PlotExecution, PlotSource } from "./parser/plot/types";
import { PlotTableCache } from "./parser/plot/cache";

export type PlotWork = {recipe:PlotRecipe;models?:PlotExecution["models"]} | {source:PlotSource;models?:PlotExecution["models"]};
export type PlotWorkReply = {type:"progress";done:number;total:number;label:string} | {type:"done";result:PlotDataset|PlotTable} | {type:"error";message:string};
if(parentPort) {
  const port=parentPort;
  const cache = new PlotTableCache();
  port.on("message",async(work:PlotWork)=>{
    try {
      const result="recipe" in work?await collectPlot(validatePlotRecipe(work.recipe),{models:work.models,progress:(done,total,label)=>port.postMessage({type:"progress",done,total,label})},cache):await loadPlotSource(work.source,{models:work.models},cache);
      port.postMessage({type:"done",result});
    }catch(e){port.postMessage({type:"error",message:e instanceof Error?e.message:String(e)});}
  });
}
