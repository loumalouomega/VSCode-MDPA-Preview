import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { parsePlotTable } from "../parser/plot/importTable";
import { emptyPlotRecipe, validatePlotRecipe } from "../parser/plot/recipe";
import { evaluatePlot, displayPlot, plotStatistics } from "../parser/plot/numerics";
import { plotCsvRows, plotManifest } from "../parser/plot/export";
import { loadPlotSource, meshPlotTable, resolvePlotPaths } from "../parser/plot/sources";
import { parseMdpa } from "../parser/mdpaParser";
import { PlotWorkerSession, runPlotWorker } from "../plotWorkerClient";
import { removeScratchDir } from "./scratchCleanup";
import { plotDataset, plotTableRead, meshCapabilities } from "../mcp/tools";
import type { PlotRecipe, PlotTable, PlotDataset, PlotSeriesSpec } from "../parser/plot/types";

function recipe(table: PlotTable, spec: Partial<PlotSeriesSpec> = {}): PlotRecipe {
  return { ...emptyPlotRecipe({id:"a",type:"inline",table}), series:[{id:"s",source:"a",name:"Signal",x:"c0",y:"c1",...spec}] };
}
const values = (dataset: PlotDataset) => dataset.series[0]?.points.map(p=>p.y);
const linear = () => parsePlotTable("time [s],pressure [kPa],error [kPa]\n0,1,0.1\n1,3,0.2\n2,5,0.3\n");

test("plot CSV/TSV lexer: BOM, quoted delimiters, escaped quotes, multiline, CRLF, missing and nonfinite", () => {
  const t=parsePlotTable('\ufefftime [ms]\tvalue [Pa]\tnote\r\n0\t1\t"first\tline"\r\n1\tNA\t"a\r\n""quoted"""\r\n2\tInf\tx\r\n');
  assert.equal(t.rows.length,3);assert.deepEqual(t.rows[1],[1,null,'a\r\n"quoted"']);
  assert.equal(t.rows[2][1],null);assert.equal(t.columns[0].unit,"ms");assert.deepEqual(t.columns[0].dimensions,[0,0,1,0,0,0,0]);
  assert.match(t.diagnostics.join(" "),/invalid\/nonfinite/);
  assert.throws(()=>parsePlotTable('x,y\n1,"broken'),/Unterminated/);
  assert.throws(()=>parsePlotTable('x,y\n1,2,3\n'),/column count/);
});
test("import correction, stable duplicate column IDs and explicit numeric validation", () => {
  const t=parsePlotTable("0;2\n1;bad\n2;4\n",{header:false,delimiter:";",numericColumns:["c0","c1"],units:{c1:"N"}});
  assert.deepEqual(t.rows,[[0,2],[1,null],[2,4]]);assert.equal(t.columns[1].unit,"N");
  const dup=parsePlotTable("x,x\n1,2\n");assert.deepEqual(dup.columns.map(c=>c.id),["c0","c1"]);assert.match(dup.diagnostics.join(" "),/Duplicate/);
  const quoted=parsePlotTable(`x,y,note\n0,1,"${"long\n".repeat(16000)}"\n1,2,short\n`);
  assert.equal(quoted.rows.length,2);assert.equal(quoted.columns.length,3);
});
test("known statistics use population std and linear-interpolated quartiles, retain gaps", () => {
  const s=plotStatistics([1,2,3,4,null].map(y=>({x:0,y})));
  assert.deepEqual(s,{count:4,missing:1,min:1,max:4,mean:2.5,std:Math.sqrt(1.25),q1:1.75,median:2.5,q3:3.25});
  const extreme=plotStatistics([{x:0,y:-1e308},{x:1,y:1e308}]);assert.equal(extreme.median,0);assert.equal(extreme.std,1e308);assert.equal(extreme.mean,0);
});
test("ordered transformations preserve originals and supplied uncertainty, reject physical dimension changes", () => {
  const r=recipe(linear(),{uncertainty:{column:"c2",meaning:"instrument error"},transforms:[{op:"convert",factor:1000,unit:"Pa"}]});
  const d=evaluatePlot(r,{a:linear()});assert.deepEqual(values(d),[1000,3000,5000]);assert.equal(d.series[0].original[0].y,1);assert.equal(d.series[0].points[0].error,100);
  r.series[0].transforms=[{op:"convert",factor:1,unit:"m"}];assert.equal(evaluatePlot(r,{a:linear()}).partial,true);
  r.series[0].transforms=[{op:"normalize",divisor:5}];values(evaluatePlot(r,{a:linear()}))!.forEach((v,i)=>assert.ok(Math.abs(v!-[.2,.6,1][i])<1e-12));
});
test("smoothing and calculus never bridge missing samples; compound unit scales are not erased", () => {
  const t=parsePlotTable("x [ms],y [kPa]\n0,1\n1,3\n2,5\n3,NA\n4,10\n5,12\n");
  assert.deepEqual(values(evaluatePlot(recipe(t,{transforms:[{op:"smooth",window:3}]}),{a:t})),[2,3,4,null,11,11]);
  const d=evaluatePlot(recipe(t,{transforms:[{op:"derivative"}]}),{a:t});assert.deepEqual(values(d),[2,2,2,null,2,2]);assert.equal(d.series[0].yColumn.unit,"(kPa)/(ms)");
  assert.deepEqual(values(evaluatePlot(recipe(t,{transforms:[{op:"integral"}]}),{a:t})),[0,2,6,null,0,11]);
  const duplicates=parsePlotTable("x,y\n0,1\n0,2\n");assert.equal(evaluatePlot(recipe(duplicates,{transforms:[{op:"derivative"}]}),{a:duplicates}).partial,true);
});
test("regression coefficients and R² are host computed; gaps and raw values stay available", () => {
  const t=linear(),d=evaluatePlot(recipe(t,{transforms:[{op:"regression"}]}),{a:t});
  assert.deepEqual(d.series[0].regression,{slope:2,intercept:1,rSquared:1});assert.deepEqual(values(d),[1,3,5]);
});
test("magnitude, row filters and independent groups", () => {
  const t=parsePlotTable("x,a [m],b [m],group\n0,3,4,A\n1,5,12,B\n2,NA,1,A\n");
  const d=evaluatePlot(recipe(t,{component:"magnitude",components:["c1","c2"],group:"c3"}),{a:t});assert.deepEqual(d.series.map(s=>s.points.map(p=>p.y)),[[5,null],[13]]);
  assert.deepEqual(d.series[0].original[0].components,[3,4]);
  const filtered=evaluatePlot(recipe(t,{filter:{column:"c0",min:1,max:1}}),{a:t});assert.deepEqual(values(filtered),[5]);
  t.columns[2].unit="mm";assert.equal(evaluatePlot(recipe(t,{component:"magnitude",components:["c1","c2"]}),{a:t}).partial,true);
});
test("histograms, Tukey boxes and grouped bars use finished numerical datasets", () => {
  const t=parsePlotTable("category,y\nA,1\nA,2\nB,3\nB,4\nB,NA\n");
  const r=recipe(t,{bins:2});r.presentation.family="histogram";assert.deepEqual(values(evaluatePlot(r,{a:t})),[2,2]);
  r.presentation.family="box";assert.deepEqual(evaluatePlot(r,{a:t}).series[0].box,[1,1.75,2.5,3.25,4]);
  r.presentation.family="bar";assert.deepEqual(values(evaluatePlot(r,{a:t})),[1.5,3.5]);
});
test("multi-run alignment is order-independent, tolerance-bound, gap-aware and never extrapolates", () => {
  const a=parsePlotTable("time [s],value [Pa]\n0,0\n1,NA\n2,4\n3,6\n"),b=parsePlotTable("time [s],value [Pa]\n-1,0\n0.5,0\n2.5,0\n4,0\n");
  const r=recipe(a,{alignment:{reference:"ref",method:"linear",tolerance:1}});r.sources.push({id:"b",type:"inline",table:b});r.series.push({id:"ref",source:"b",name:"Ref",x:"c0",y:"c1"});
  const d=evaluatePlot(r,{a,b});assert.deepEqual(values(d),[null,null,5,null]);assert.equal(d.series[0].points[2].origin,undefined);
  r.series.reverse();assert.deepEqual(evaluatePlot(r,{a,b}).series.find(s=>s.id==="s")?.points,d.series[0].points);
  r.series.find(s=>s.id==="s")!.alignment!.tolerance=.1;assert.deepEqual(evaluatePlot(r,{a,b}).series.find(s=>s.id==="s")?.points.map(p=>p.y),[null,null,null,null]);
});
test("frame indices cannot masquerade as physical time, and equal dimensions do not equate unit scales", () => {
  const a=linear(),b=linear();b.columns[1].unit="Pa";
  const r=recipe(a);r.sources.push({id:"b",type:"inline",table:b});r.series.push({id:"ref",source:"b",name:"Ref",x:"c0",y:"c1"});
  assert.match(evaluatePlot(r,{a,b}).diagnostics.join(" "),/convert explicitly/);
  a.columns[0].domain="frameIndex";r.series[0].alignment={reference:"ref",method:"exact",tolerance:0};assert.match(evaluatePlot(r,{a,b}).diagnostics.join(" "),/not physical time/);
});
test("regular and scattered grids are explicit, reject duplicates and mask uncovered regions", () => {
  const t=parsePlotTable("x,y,z\n0,0,0\n1,0,1\n0,1,2\n1,1,NA\n");const r=recipe(t,{z:"c2"});r.presentation.family="heatmap";
  assert.equal(evaluatePlot(r,{a:t}).partial,true);r.series[0].grid={method:"regular"};assert.deepEqual(evaluatePlot(r,{a:t}).series[0].grid?.z,[[0,1],[2,null]]);
  r.series[0].grid={method:"nearest",nx:3,ny:3,radius:.1};const d=evaluatePlot(r,{a:t});assert.equal(d.series[0].grid?.z[1][1],null);assert.equal(d.series[0].grid?.z[2][2],null);
  t.rows.push([0,0,8]);assert.match(evaluatePlot(r,{a:t}).diagnostics.join(" "),/Duplicate/);
});
test("log-domain diagnostics preserve numerical exports", () => {
  const t=parsePlotTable("x,y\n0,-1\n1,2\n2,0\n"),r=recipe(t);r.presentation.yScale="log";
  const d=evaluatePlot(r,{a:t});assert.deepEqual(values(d),[-1,2,0]);assert.match(d.series[0].diagnostics.join(" "),/nonpositive/);
});
test("recipe round-trip preserves presentation; bad versions and missing sources identify the affected series", () => {
  const r=recipe(linear());r.presentation.annotations=[{x:1,y:3,text:"Peak"}];r.series[0].marker="diamond";
  assert.deepEqual(validatePlotRecipe(JSON.parse(JSON.stringify(r))),r);assert.throws(()=>validatePlotRecipe({...r,version:2}),/Unsupported/);
  assert.match(evaluatePlot(r,{}).diagnostics.join(" "),/Signal \(s\).*Missing source a/);
  assert.equal((resolvePlotPaths(emptyPlotRecipe({id:"a",type:"table",path:"a.csv"}),"/case").sources[0] as any).path,path.resolve("/case/a.csv"));
});
test("display sampling is bounded, preserves order/gaps and never changes full statistics or CSV", () => {
  const t:PlotTable={columns:[{id:"c0",label:"X",type:"number"},{id:"c1",label:"Y",type:"number"}],rows:Array.from({length:10000},(_,i)=>[i,i===5000?null:Math.sin(i)]),diagnostics:[]};
  const d=evaluatePlot(recipe(t),{a:t}),display=displayPlot(d,200);assert.ok(display.series[0].points.length<=200);assert.ok(display.series[0].points.some(p=>p.y===null));
  assert.equal((display.recipe.sources[0] as {table:PlotTable}).table.rows.length,0);
  const xs=display.series[0].points.map(p=>p.x).filter((v):v is number=>typeof v==="number");assert.ok(xs.every((v,i)=>!i||v>xs[i-1]));assert.deepEqual(display.series[0].statistics,d.series[0].statistics);
  assert.equal([...plotCsvRows(d)].length,20001);assert.match(JSON.stringify(plotManifest(d)),/originalY/);
});
test("mesh association keeps point/cell ID spaces independent and excludes ambiguous Geometry fields", () => {
  const m=parseMdpa("Begin Nodes\n1 0 0 0\n2 1 0 0\n3 0 1 0\nEnd Nodes\nBegin Elements Element2D3N\n1 0 1 2 3\nEnd Elements\nBegin Conditions Condition2D2N\n1 0 1 2\nEnd Conditions\nBegin NodalData P\n1 0 10\nEnd NodalData\nBegin ElementalData P\n1 20\nEnd ElementalData\nBegin ConditionalData P\n1 30\nEnd ConditionalData\n");
  m.source={format:"mdpa",units:{coords:"mm",fields:{P:"kPa"}}};
  for (const [kind,value] of [["Nodes",10],["Elements",20],["Conditions",30]] as const) {
    const t=meshPlotTable(m,{id:"a",type:"mesh",path:"fixture.mdpa",kind});const i=t.columns.findIndex(c=>c.label==="P");assert.equal(t.rows[0][i],value);assert.equal(t.origins?.[0].entityKind,kind);assert.equal(t.columns[i].unit,"kPa");
  }
  m.blocks.push({...m.blocks[0],kind:"Geometries"});const g=meshPlotTable(m,{id:"a",type:"mesh",path:"fixture.mdpa",kind:"Geometries"});assert.ok(!g.columns.some(c=>c.label==="P"));
});
test("worker/MCP extraction, cache invalidation, full export and cancellation share the host path", async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"kratos-plot-test-")),file=path.join(dir,"data.csv"),session=new PlotWorkerSession();
  try {
    await fs.writeFile(file,"x,y\n0,1\n1,3\n2,5\n");const source={id:"a",type:"table" as const,path:file};
    const a=await session.run({source}) as PlotTable,b=await session.run({source}) as PlotTable;assert.match(b.diagnostics.join(" "),/cache hit/);assert.equal(a.revision,b.revision);
    await fs.writeFile(file,"x,y\n0,2\n1,4\n2,6\n");const changed=await session.run({source}) as PlotTable;assert.notEqual(changed.revision,a.revision);
    const table=await plotTableRead({path:file,limit:1}) as any;assert.equal(table.rowCount,3);assert.equal(table.rows.length,1);
    const r={...recipe(linear()),sources:[source]},out=path.join(dir,"plot.csv");const result=await plotDataset({recipe:r,outputPath:out,limit:1}) as any;assert.equal(result.series[0].points.length,1);assert.equal((await fs.readFile(out,"utf8")).split("\r\n").length,8);assert.equal((JSON.parse(await fs.readFile(out+".kratosplot.json","utf8"))).fullCount,3);
    assert.ok((await meshCapabilities() as any).plotting.families.includes("contour"));
    const controller=new AbortController();const job=session.run({recipe:r},{signal:controller.signal});controller.abort();const cancelled=await job as PlotDataset;assert.equal(cancelled.partial,true);assert.match(cancelled.diagnostics[0],/Cancelled/);
    const recovered=await session.run({source}) as PlotTable;assert.equal(recovered.rows.length,3);
    const missing=await runPlotWorker({recipe:{...r,sources:[{...source,path:path.join(dir,"missing.csv")}]}}) as PlotDataset;assert.equal(missing.partial,true);assert.match(missing.diagnostics.join(" "),/Source a.*ENOENT/);
    assert.equal((await loadPlotSource({id:"a",type:"inline",table:linear()})).origins?.[0].source,"a");
  } finally { await session.dispose(); await removeScratchDir(dir); }
});
