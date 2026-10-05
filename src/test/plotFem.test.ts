import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { parseMdpa } from "../parser/mdpaParser";
import { sampleRegion } from "../parser/plot/region";
import { collectPlot, collectPlotHistorySteps, loadPlotSource } from "../parser/plot/sources";
import { emptyPlotRecipe, validatePlotRecipe, PLOT_CAPABILITIES } from "../parser/plot/recipe";
import { appendFemCurve, femPlotContext } from "../parser/plot/fem";
import { plotCsvRows } from "../parser/plot/export";
import { evaluatePlot, displayPlot } from "../parser/plot/numerics";
import { plotDataset } from "../mcp/tools";
import { PlotWorkerSession } from "../plotWorkerClient";
import type { PlotRegionSource } from "../parser/plot/types";

const spec=(extra:Partial<PlotRegionSource>={}):PlotRegionSource=>({id:"r",type:"region",path:"fixture.mdpa",kind:"Nodal",variable:"PRESSURE",submodelpart:"Wall",scope:"current",operation:"pressureForce",...extra});
const close=(actual:number|null,expected:number)=>assert.ok(actual!==null&&Math.abs(actual-expected)<1e-9,`expected ${expected}, got ${actual}`);
function tetra(linear=false) {
  const model=parseMdpa(`Begin Nodes
1 0 0 0
2 1 0 0
3 0 1 0
4 0 0 1
End Nodes
Begin Elements Element3D4N
1 0 1 2 3 4
End Elements
Begin Conditions SurfaceCondition3D3N
1 0 1 2 3
2 0 1 2 4
3 0 1 3 4
4 0 2 3 4
End Conditions
Begin NodalData PRESSURE
1 0 ${linear?0:12}
2 0 ${linear?1:12}
3 0 ${linear?0:12}
4 0 ${linear?0:12}
End NodalData
Begin NodalData REACTION
1 0 [3] (1,0,0)
2 0 [3] (-1,0,0)
3 0 [3] (0,2,0)
4 0 [3] (0,0,0)
End NodalData
Begin SubModelPart Wall
Begin SubModelPartNodes
1
2
3
End SubModelPartNodes
Begin SubModelPartConditions
1
End SubModelPartConditions
End SubModelPart
Begin SubModelPart Closed
Begin SubModelPartConditions
1
2
3
4
End SubModelPartConditions
End SubModelPart
`);
  model.source={format:"mdpa",units:{coords:"m",fields:{PRESSURE:"Pa",REACTION:"N"}}};return model;
}

test("pressure scalar integral, weighted mean, vector resultant and moment are distinct read-only quantities",()=>{
  const m=tetra(),before=JSON.stringify(m);
  const force=sampleRegion(m,spec());force.values.forEach((v,i)=>close(v,[0,0,6][i]));close(force.covered,.5);assert.equal(force.partial,false);
  const scalar=sampleRegion(m,spec({operation:"boundaryIntegral"}));close(scalar.values[0],6);
  const mean=sampleRegion(m,spec({operation:"boundaryMean"}));close(mean.values[0],12);assert.equal(mean.columns[0].unit,"Pa");
  const moment=sampleRegion(m,spec({operation:"pressureMoment",referencePoint:[0,0,0]}));moment.values.forEach((v,i)=>close(v,[2,-2,0][i]));
  assert.match(moment.diagnostics.join(" "),/"referencePoint":\[0,0,0\]/);
  assert.equal(JSON.stringify(m),before);assert.deepEqual(force.columns[0].dimensions,[1,1,-2,0,0,0,0]);assert.match(force.columns[0].unit!,/Pa.*m/);
});
test("moment quadrature integrates linear pressure times position, not mean pressure times centroid",()=>{
  const m=tetra(true),r=sampleRegion(m,spec({operation:"pressureMoment",referencePoint:[0,0,0]}));close(r.values[0],1/24);close(r.values[1],-1/12);
  close(sampleRegion(m,spec()).values[2],1/6);
});
test("constant pressure on a closed boundary has zero force and moment; pressure offset is explicit",()=>{
  for(const operation of ["pressureForce","pressureMoment"] as const)sampleRegion(tetra(),spec({submodelpart:"Closed",operation,referencePoint:[0,0,0]})).values.forEach(v=>close(v,0));
  sampleRegion(tetra(),spec({pressureOffset:12})).values.forEach(v=>close(v,0));
  close(sampleRegion(tetra(),spec({orientation:"winding"})).values[2],-6);
});
test("boundary mean needs no normal; missing field coverage and unorientable loads are never zero",()=>{
  const m=tetra();m.blocks=m.blocks.filter(b=>b.kind!=="Elements");
  close(sampleRegion(m,spec({operation:"boundaryMean"})).values[0],12);
  const r=sampleRegion(m,spec());assert.deepEqual(r.values,[null,null,null]);assert.equal(r.partial,true);assert.match(r.diagnostics.join(" "),/normal unavailable/);
  const missing=tetra();missing.fields[0].values[0]=NaN;const gap=sampleRegion(missing,spec());assert.deepEqual(gap.values,[null,null,null]);close(gap.covered,0);
});
test("independent point/cell associations and node-only boundaries cannot invent integration geometry",()=>{
  const m=tetra();assert.throws(()=>sampleRegion(m,spec({kind:"Elemental"})),/No Elemental/);
  m.subModelParts[0].conditionIds=new Int32Array();assert.throws(()=>sampleRegion(m,spec()),/nodes alone/);
  assert.throws(()=>sampleRegion(m,spec({submodelpart:"missing"})),/No SubModelPart/);
});
test("2D pressure loads are per depth unless explicit positive thickness is supplied",()=>{
  const m=parseMdpa("Begin Nodes\n1 0 0 0\n2 2 0 0\n3 0 1 0\nEnd Nodes\nBegin Elements Element2D3N\n1 0 1 2 3\nEnd Elements\nBegin Conditions LineCondition2D2N\n1 0 1 2\nEnd Conditions\nBegin NodalData PRESSURE\n1 0 3\n2 0 3\n3 0 3\nEnd NodalData\nBegin SubModelPart Wall\nBegin SubModelPartConditions\n1\nEnd SubModelPartConditions\nEnd SubModelPart\n");
  m.source={format:"mdpa",units:{coords:"m",fields:{PRESSURE:"Pa"}}};
  close(sampleRegion(m,spec()).values[1],6);close(sampleRegion(m,spec({thickness:.25})).values[1],1.5);
  assert.deepEqual(sampleRegion(m,spec()).columns[0].dimensions,[1,0,-2,0,0,0,0]);
  assert.deepEqual(sampleRegion(m,spec({thickness:.25})).columns[0].dimensions,[1,1,-2,0,0,0,0]);
});
test("supplied unit scales survive integration; kinematic pressure requires explicit density",()=>{
  const m=tetra();m.source!.units!.coords="mm";m.source!.units!.fields!.PRESSURE="kPa";
  const r=sampleRegion(m,spec());close(r.values[2],6);assert.equal(r.columns[0].unit,"(kPa)·(mm)²");
  m.source!.units!.fields!.PRESSURE="m²/s²";m.fields[0].dimensions={exponents:[0,2,-2,0,0,0,0]};
  assert.throws(()=>sampleRegion(m,spec()),/density/);close(sampleRegion(m,spec({pressureDensity:1000})).values[2],6000);
  m.fields[0].dimensions={exponents:[0,0,0,1,0,0,0]};assert.throws(()=>sampleRegion(m,spec()),/pressure dimensions/);
});
test("reaction vectors are summed before magnitude; subtree nodes are deduplicated and extrema retain entity identity",()=>{
  const m=tetra();m.subModelParts[0].children=[{...m.subModelParts[0],name:"child",path:"Wall.child",children:[]}];
  const sum=sampleRegion(m,spec({variable:"REACTION",operation:"sum"}));assert.deepEqual(sum.values,[0,2,0]);assert.equal(sum.covered,3);
  const moment=sampleRegion(m,spec({variable:"REACTION",operation:"reactionMoment",referencePoint:[0,0,0]}));assert.deepEqual(moment.values,[0,0,0]);
  const max=sampleRegion(m,spec({variable:"REACTION",operation:"max",component:"magnitude"}));close(max.values[0],2);assert.equal(max.origin.entityId,3);assert.equal(max.origin.entityKind,"Nodes");
});
test("region recipes validate required physical parameters and retain all choices on round trip",()=>{
  const r=appendFemCurve(emptyPlotRecipe(),spec({operation:"pressureMoment",referencePoint:[1,2,3],thickness:2}),"magnitude",3,"Wall moment");
  assert.deepEqual(validatePlotRecipe(JSON.parse(JSON.stringify(r))),r);
  for(const extra of [{thickness:0},{referencePoint:undefined},{pressureOffset:NaN}])assert.throws(()=>validatePlotRecipe({...r,sources:[spec({operation:"pressureMoment",referencePoint:[1,2,3],...extra})]}));
  assert.ok(PLOT_CAPABILITIES.regionOperations.includes("pressureForce"));assert.equal(femPlotContext("x",tetra()).parts[0].path,"Wall");
  assert.throws(()=>appendFemCurve(r,{id:"history",type:"history",path:"x",kind:"Nodal",entityId:1,variable:"REACTION"},0,3,"Node"),/different domains/);
});
test("batch loads each frame once and diagnoses missing IDs, fields, widths and supplied metadata independently",async()=>{
  let loads=0;const first=tetra(),second=tetra();second.fields[0].ids=Int32Array.from([2,3,4]);second.source!.units!.fields!.REACTION="kN";
  const steps=[first,second].map((model,i)=>({label:String(i),frameIndex:i,load:async()=>{loads++;return model;}}));
  const sources=[{id:"p",type:"history" as const,path:"fixture",kind:"Nodal" as const,variable:"PRESSURE",entityId:1},{id:"q",type:"history" as const,path:"fixture",kind:"Nodal" as const,variable:"REACTION",entityId:2},spec({scope:"history",operation:"max"})];
  const tables=await collectPlotHistorySteps(sources,steps,false);assert.equal(loads,2);assert.equal(tables.p.rows[1][2],null);assert.match(tables.p.diagnostics.join(" "),/Entity 1 is missing/);assert.equal(tables.q.rows[1][2],null);assert.match(tables.q.diagnostics.join(" "),/units or dimensions changed/);assert.equal(tables.r.partial,true);
  const noField=tetra();noField.fields=[];const missing=await collectPlotHistorySteps([sources[0]],[{label:"0",frameIndex:0,load:async()=>noField}],false);assert.match(missing.p.diagnostics.join(" "),/Field PRESSURE is missing/);
  const missingRecipe=appendFemCurve(emptyPlotRecipe(),sources[0],0,1,"Pressure history");assert.match(evaluatePlot(missingRecipe,missing).diagnostics.join(" "),/Field PRESSURE is missing/);
});
test("in-file physical time units are retained once and incompatible time samples become gaps",async()=>{
  const a=tetra(),b=tetra();a.source!.units!.time="s";b.source!.units!.time="ms";
  const source={id:"p",type:"history" as const,path:"fixture",kind:"Nodal" as const,variable:"PRESSURE",entityId:1};
  const tables=await collectPlotHistorySteps([source],[a,b].map((m,i)=>({label:String(i),frameIndex:i,load:async()=>m})),true);
  assert.equal(tables.p.columns[0].unit,"s");assert.deepEqual(tables.p.columns[0].dimensions,[0,0,1,0,0,0,0]);assert.equal(tables.p.rows[1][0],null);assert.equal(tables.p.rows[1][2],null);assert.equal(tables.p.partial,true);assert.match(tables.p.diagnostics.join(" "),/Time units changed/);
});
test("missing/degenerate boundary conditions disclose unknown measure and leave an incomplete result",()=>{
  const m=tetra();m.subModelParts[0].conditionIds=Int32Array.from([1,999]);const result=sampleRegion(m,spec());close(result.values[2],6);assert.equal(result.partial,true);assert.match(result.diagnostics.join(" "),/measure cannot be computed/);
  const degenerate=tetra();degenerate.coords.fill(0);const gap=sampleRegion(degenerate,spec());assert.deepEqual(gap.values,[null,null,null]);assert.equal(gap.partial,true);
});
test("Conditional pressure is not mistaken for a same-ID nodal value; prescribed vector flux uses its normal component",()=>{
  const m=tetra();m.fields.push({variable:"PRESSURE",kind:"Conditional",components:1,ids:Int32Array.of(1),values:Float64Array.of(8)});
  close(sampleRegion(m,spec({kind:"Conditional"})).values[2],4);
  const flux=sampleRegion(m,spec({variable:"REACTION",operation:"flux"}));close(flux.values[0],0);
  const nodalForce=m.fields.find(f=>f.variable==="REACTION")!;nodalForce.dimensions={exponents:[0,1,0,0,0,0,0]};assert.throws(()=>sampleRegion(m,spec({variable:"REACTION",operation:"reactionMoment",referencePoint:[0,0,0]})),/force dimensions/);
});
test("current region extraction exports original association, region and full-resolution peak",async()=>{
  const source=spec({operation:"max"});const table=await loadPlotSource(source,{models:{r:tetra()}});
  const recipe=appendFemCurve(emptyPlotRecipe(),source,0,1,"Wall max");const data=evaluatePlot(recipe,{r:table});assert.equal(data.fullCount,1);assert.match([...plotCsvRows(data)].join(""),/Wall/);
  const points={columns:[{id:"time",label:"Time",type:"number" as const},{id:"v0",label:"Value",type:"number" as const}],rows:Array.from({length:1000},(_,i)=>[i,i===501?999:0]),origins:Array.from({length:1000},(_,i)=>({source:"r",frameIndex:i})),diagnostics:[]};
  const history=appendFemCurve(emptyPlotRecipe(),{id:"r",type:"inline",table:points},0,1,"Peak");const result=displayPlot(evaluatePlot(history,{r:points}),20);assert.equal(result.series[0].peak!.y,999);assert.equal(result.series[0].peak!.origin!.frameIndex,501);
});
test("multi-point histories publish cancellable partials and share region/MCP extraction",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"plot-fem-"));
  try {
    const vtk=(a:number,b:number)=>`# vtk DataFile Version 3.0\nFixture\nASCII\nDATASET UNSTRUCTURED_GRID\nPOINTS 3 float\n0 0 0\n1 0 0\n0 1 0\nCELLS 1 4\n3 0 1 2\nCELL_TYPES 1\n5\nPOINT_DATA 3\nSCALARS PRESSURE float 1\nLOOKUP_TABLE default\n${a} ${b} 3\n`;
    const file=path.join(dir,"Main_0_0.vtk");await fs.writeFile(file,vtk(1,2));await fs.writeFile(path.join(dir,"Main_0_1.vtk"),vtk(4,5));
    let recipe=appendFemCurve(emptyPlotRecipe(),{id:"p1",type:"history",path:file,kind:"Nodal",entityId:1,variable:"PRESSURE"},0,1,"Node 1");recipe=appendFemCurve(recipe,{id:"p2",type:"history",path:file,kind:"Nodal",entityId:2,variable:"PRESSURE"},0,1,"Node 2");
    let published=0;const result=await collectPlot(recipe,{partial:d=>{published++;assert.equal(d.partial,true);}});assert.ok(published>0);assert.deepEqual(result.series.map(s=>s.points.map(p=>p.y)),[[1,4],[2,5]]);
    const region=spec({path:file,submodelpart:undefined,operation:"max",scope:"history"});const regionRecipe=appendFemCurve(emptyPlotRecipe(),region,0,1,"Peak pressure");
    const mcp=await plotDataset({recipe:regionRecipe,limit:10}) as any;assert.deepEqual(mcp.series[0].points.map((p:any)=>p.y),[3,5]);assert.equal(mcp.series[0].points[1].origin.entityId,2);
    const current=await loadPlotSource({...region,scope:"current",timeStep:1});assert.equal(current.rows[0][1],5);assert.equal(current.origins![0].entityId,2);
    const abort=new AbortController();const cancelled=await collectPlot(recipe,{signal:abort.signal,partial:()=>abort.abort()});assert.equal(cancelled.partial,true);assert.deepEqual(cancelled.series[0].points.map(p=>p.y),[1]);
    const session=new PlotWorkerSession();try{const signal=new AbortController();const retained=await session.run({recipe},{signal:signal.signal,partial:()=>signal.abort()}) as typeof result;assert.equal(retained.partial,true);assert.deepEqual(retained.series[0].points.map(p=>p.y),[1]);assert.match(retained.diagnostics.join(" "),/retained published/);const recovered=await session.run({recipe:emptyPlotRecipe()}) as typeof result;assert.equal(recovered.partial,false);}finally{session.dispose();}
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
