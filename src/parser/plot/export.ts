import { csvField } from "../dataTable";
import type { PlotDataset } from "./types";

/** Full-resolution derived samples, with explicit raw rows for reproducibility. */
export function* plotCsvRows(dataset: PlotDataset): Generator<string> {
  yield ["series","stage","x","y","z","error","x_unit","y_unit","z_unit","source","entity_kind","entity_id","frame","time","run","source_row","original_components"].map(csvField).join(",")+"\r\n";
  for(const s of dataset.series)for(const stage of ["derived","original"] as const)for(const p of stage==="derived"?s.points:s.original) {
    const o=p.origin;
    yield [s.name,stage,p.x,p.y,p.z,p.error,(stage==="original"?s.originalXColumn:s.xColumn).unit??"unknown",(stage==="original"?s.originalYColumn:s.yColumn).unit??"unknown",s.zColumn?.unit??"unknown",o?.source,o?.entityKind,o?.entityId,o?.frameIndex,o?.time,o?.runId,o?.rowIndex,p.components?JSON.stringify(p.components):undefined].map(v=>v===null||v===undefined?"":csvField(String(v))).join(",")+"\r\n";
  }
  for (const s of dataset.series) if (s.grid) for (let j=0;j<s.grid.y.length;j++) for (let i=0;i<s.grid.x.length;i++) {
    yield [s.name,"grid",s.grid.x[i],s.grid.y[j],s.grid.z[j][i],"",s.xColumn.unit??"unknown",s.yColumn.unit??"unknown",s.zColumn?.unit??"unknown"].map(v=>v===null?"":csvField(String(v))).join(",")+",,,,,,,,\r\n";
  }
}
export function plotManifest(dataset: PlotDataset): object {
  return {version:1,tool:"Kratos MDPA Preview",recipe:dataset.recipe,sources:dataset.sources,partial:dataset.partial,diagnostics:dataset.diagnostics,fullCount:dataset.fullCount,displayCount:dataset.displayCount??dataset.fullCount,series:dataset.series.map(s=>({id:s.id,name:s.name,x:s.xColumn,y:s.yColumn,z:s.zColumn,originalX:s.originalXColumn,originalY:s.originalYColumn,statistics:s.statistics,regression:s.regression,diagnostics:s.diagnostics,grid:s.grid?{columns:s.grid.x.length,rows:s.grid.y.length}:undefined}))};
}
