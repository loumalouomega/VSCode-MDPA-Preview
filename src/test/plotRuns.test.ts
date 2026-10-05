import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { bindPlotRun, discoverPlotRuns, resolvePlotTimeCursor, verifyPlotRun, type PlotTimeCursorRequest } from "../parser/plot/runs";
import { plotFileRevision, plotHash, plotSourceIdentity } from "../parser/plot/revision";
import { emptyPlotRecipe, validatePlotRecipe } from "../parser/plot/recipe";
import { collectPlot, loadPlotSource, resolvePlotPaths } from "../parser/plot/sources";
import { plotDataset, plotRunBind, plotRuns, plotTimeCursor } from "../mcp/tools";
import { parseExecutionReceipt, EXECUTION_FILE, type ExecutionReceipt } from "../problemtype/runReceipt";
import { parseVtk } from "../parser/vtkLegacyParser";
import type { PlotDataset, PlotSource } from "../parser/plot/types";
import { PlotWorkerSession } from "../plotWorkerClient";
import { assertPlotDestination } from "../parser/plot/files";
import { runFilePath } from "../problemtype/caseFile";

const vtk=(value:number)=>`# vtk DataFile Version 3.0\nOwned fixture\nASCII\nDATASET UNSTRUCTURED_GRID\nPOINTS 3 float\n0 0 0\n1 0 0\n0 1 0\nCELLS 1 4\n3 0 1 2\nCELL_TYPES 1\n5\nPOINT_DATA 3\nSCALARS PRESSURE float 1\nLOOKUP_TABLE default\n${value} ${value+1} ${value+2}\n`;
async function fixture() {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"plot-run-")),mesh=path.join(directory,"input.mdpa"),recordPath=path.join(directory,EXECUTION_FILE);
  const files=[path.join(directory,"Main_0_0.vtk"),path.join(directory,"Main_0_1.vtk")];
  await fs.writeFile(mesh,"Begin Nodes\n1 0 0 0\nEnd Nodes\n");
  for(const [i,file] of files.entries())await fs.writeFile(file,vtk(i*3+1));
  const receipt:ExecutionReceipt={version:1,ownerId:"study-a",requestId:"request-a",jobId:"run-a",state:"succeeded",runDirectory:directory,meshPath:mesh,createdAt:1,updatedAt:2,artifacts:[
    {role:"mesh",path:mesh,revision:plotHash(await fs.readFile(mesh))},...await Promise.all(files.map(async file=>({role:"result",path:file,revision:plotHash(await fs.readFile(file))}))),
  ]};
  const save=()=>fs.writeFile(recordPath,JSON.stringify(receipt));await save();
  const run=await bindPlotRun(recordPath,files[0]);
  const source:Extract<PlotSource,{type:"history"}>={id:"history",type:"history",path:files[0],kind:"Nodal",entityId:1,variable:"PRESSURE",run,times:[0,.2],timeUnit:"s"};
  return {directory,mesh,recordPath,files,receipt,save,run,source,dispose:()=>fs.rm(directory,{recursive:true,force:true})};
}

test("shared receipt parser rebases only owned paths, refuses corrupt/newer records",()=>{
  const receipt={version:1,requestId:"request",ownerId:"owner",jobId:"job",state:"succeeded",runDirectory:"/old",meshPath:"/old/input.mdpa",artifacts:[{role:"result",path:"/old/vtk/a.vtk",revision:"hash"},{role:"external",path:"/outside/input"}]};
  const parsed=parseExecutionReceipt(JSON.stringify(receipt),"/new")!;
  assert.equal(parsed.meshPath,"/new/input.mdpa");assert.equal(parsed.artifacts[0].path,"/new/vtk/a.vtk");assert.equal(parsed.artifacts[1].path,"/outside/input");
  for(const bad of ["{","[]",JSON.stringify({...receipt,version:2}),JSON.stringify({...receipt,ownerId:""})])assert.equal(parseExecutionReceipt(bad,"/new"),undefined);
});
test("run discovery reads existing store without adopting latest/shared output files",async()=>{
  const f=await fixture();try {
    await fs.writeFile(path.join(f.directory,"input.kratosrun.json"),JSON.stringify({version:1,runId:"legacy",status:"finished",meshFile:f.mesh}));
    const discovered=await discoverPlotRuns([f.directory]);assert.equal(discovered.runs.length,2);
    assert.deepEqual(discovered.runs.find(r=>r.runId==="run-a")?.results,f.files);
    const legacy=discovered.runs.find(r=>r.runId==="legacy")!;assert.equal(legacy.verifiable,false);assert.deepEqual(legacy.results,[]);assert.match(legacy.diagnostics.join(" "),/no outputs adopted/);
    assert.deepEqual(await plotRuns({paths:[f.directory]}),discovered);
  }finally{await f.dispose();}
});
test("bounded discovery finds immediate isolated children, not arbitrary nested outputs",async()=>{
  const f=await fixture();try {
    const child=path.join(f.directory,"saved");await fs.mkdir(child);const childRecord=path.join(child,EXECUTION_FILE);await fs.writeFile(childRecord,JSON.stringify(f.receipt));
    const result=await discoverPlotRuns([f.directory]);assert.ok(result.runs.some(r=>r.recordPath===childRecord));
    await assert.rejects(()=>discoverPlotRuns(new Array(65).fill(f.directory)),/64/);
    const absent=await discoverPlotRuns([path.join(f.directory,"absent")]);assert.equal(absent.runs.length,0);assert.equal(absent.diagnostics.length,1);
  }finally{await f.dispose();}
});
test("binding uses content, not mtime/size, and catches reused paths even with equal bytes",async()=>{
  const f=await fixture();try {
    assert.deepEqual(await verifyPlotRun({...f.run,ownerId:"study-a"},f.files[0]).then(v=>v.revision),f.run.sourceRevision);
    const stat=await fs.stat(f.files[1]);await fs.writeFile(f.files[1],vtk(7));await fs.utimes(f.files[1],stat.atime,stat.mtime);
    await assert.rejects(()=>verifyPlotRun(f.run,f.files[0]),/revision missing or changed/);
    await fs.writeFile(f.files[1],vtk(4));f.receipt.jobId="run-b";await f.save();
    await assert.rejects(()=>verifyPlotRun(f.run,f.files[0]),/identity changed/);
  }finally{await f.dispose();}
});
test("active-case labels, polling timestamps and property order cannot redirect a binding",async()=>{
  const f=await fixture();try {
    f.receipt.updatedAt=300;await f.save();
    const reordered=Object.fromEntries(Object.entries(f.run).reverse()) as typeof f.run;
    assert.equal((await verifyPlotRun(reordered,f.files[0])).revision,f.run.sourceRevision);
    for(const key of ["ownerId","requestId"] as const) {
      const previous=f.receipt[key];f.receipt[key]="other";await f.save();await assert.rejects(()=>verifyPlotRun(f.run,f.files[0]),/identity changed/);f.receipt[key]=previous;
    }
  }finally{await f.dispose();}
});
test("an available replacement latest-run record refuses ownership even with identical result bytes",async()=>{
  const f=await fixture();try {
    const file=runFilePath(f.mesh),sidecar={version:1,runId:f.run.runId,requestId:f.run.requestId,ownerId:f.run.ownerId,status:"finished",meshFile:f.mesh};
    await fs.writeFile(file,JSON.stringify(sidecar));assert.equal((await verifyPlotRun(f.run,f.files[0])).revision,f.run.sourceRevision);
    await fs.writeFile(file,JSON.stringify({...sidecar,runId:"replacement-run"}));
    await assert.rejects(()=>verifyPlotRun(f.run,f.files[0]),/latest-run record/);
    await fs.writeFile(file,JSON.stringify({...sidecar,status:"running"}));
    await assert.rejects(()=>verifyPlotRun(f.run,f.files[0]),/latest-run record/);
    await fs.writeFile(file,JSON.stringify({...sidecar,version:2}));
    await assert.rejects(()=>verifyPlotRun(f.run,f.files[0]),/latest-run record/);
    await fs.writeFile(file,"{");await assert.rejects(()=>verifyPlotRun(f.run,f.files[0]),/latest-run record/);
  }finally{await f.dispose();}
});
test("numeric or blank recorded job IDs cannot establish terminal result ownership",async()=>{
  const f=await fixture();try {
    for(const jobId of [42,"", " "]) {
      await fs.writeFile(f.recordPath,JSON.stringify({...f.receipt,jobId}));
      await assert.rejects(()=>bindPlotRun(f.recordPath,f.files[0]),/recorded job ID/);
      assert.equal((await discoverPlotRuns([f.recordPath])).runs[0].verifiable,false);
    }
  }finally{await f.dispose();}
});
test("changed source mesh, missing revisions, running and uncertain runs remain unresolved",async()=>{
  const f=await fixture();try {
    await fs.appendFile(f.mesh,"\n");await assert.rejects(()=>bindPlotRun(f.recordPath,f.files[0]),/source mesh/);
    await fs.writeFile(f.mesh,"Begin Nodes\n1 0 0 0\nEnd Nodes\n");
    f.receipt.artifacts[1].revision=undefined;await f.save();await assert.rejects(()=>bindPlotRun(f.recordPath,f.files[0]),/revision missing/);
    for(const state of ["running","uncertain","dispatching"] as const) {f.receipt.state=state;await f.save();await assert.rejects(()=>bindPlotRun(f.recordPath,f.files[0]),/terminal run/);}
  }finally{await f.dispose();}
});
test("filename timeline additions and selected rank changes invalidate captured ownership",async()=>{
  const f=await fixture();try {
    const later=path.join(f.directory,"Main_0_2.vtk");await fs.writeFile(later,vtk(7));
    await assert.rejects(()=>verifyPlotRun(f.run,f.files[0]),/revision missing/);
    f.receipt.artifacts.push({role:"result",path:later,revision:plotHash(await fs.readFile(later))});await f.save();
    await assert.rejects(()=>verifyPlotRun(f.run,f.files[0]),/identity changed/);
    const rank1=path.join(f.directory,"Main_1_0.vtk");await fs.writeFile(rank1,vtk(1));f.receipt.artifacts.push({role:"result",path:rank1,revision:plotHash(await fs.readFile(rank1))});await f.save();
    await assert.rejects(()=>verifyPlotRun(f.run,rank1),/identity changed/);
  }finally{await f.dispose();}
});
test("recursive PVD→PVTU companion changes and missing pieces are not marker cache hits",async()=>{
  const f=await fixture();try {
    const pvd=path.join(f.directory,"series.pvd"),pvtu=path.join(f.directory,"step.pvtu"),piece=path.join(f.directory,"piece.vtu");
    await fs.writeFile(pvd,'<VTKFile type="Collection"><Collection><DataSet timestep="0" file="step.pvtu"/></Collection></VTKFile>');
    await fs.writeFile(pvtu,'<VTKFile type="PUnstructuredGrid"><PUnstructuredGrid><Piece Source="piece.vtu"/></PUnstructuredGrid></VTKFile>');
    await fs.writeFile(piece,"piece bytes");
    for(const [file,role] of [[pvd,"result"],[pvtu,"result-companion"],[piece,"result-companion"]])f.receipt.artifacts.push({role,path:file,revision:plotHash(await fs.readFile(file))});await f.save();
    const run=await bindPlotRun(f.recordPath,pvd),before=await plotSourceIdentity(pvd);assert.equal(before.files.length,3);
    await fs.writeFile(piece,"new content");await assert.rejects(()=>verifyPlotRun(run,pvd),/piece.vtu/);
    await fs.unlink(piece);await assert.rejects(()=>bindPlotRun(f.recordPath,pvd),/piece.vtu/);
  }finally{await f.dispose();}
});
test("filename SubModelPart companions participate in identity",async()=>{
  const f=await fixture();try {
    const part=path.join(f.directory,"Main_Wall_0_0.vtk");await fs.writeFile(part,vtk(1));
    f.receipt.artifacts.push({role:"result",path:part,revision:plotHash(await fs.readFile(part))});await f.save();
    const bound=await bindPlotRun(f.recordPath,f.files[0]);assert.notEqual(bound.sourceRevision,f.run.sourceRevision);
    await fs.writeFile(part,vtk(4));await assert.rejects(()=>verifyPlotRun(bound,f.files[0]),/Wall/);
  }finally{await f.dispose();}
});
test("symlink-escaped or unrecorded results cannot bind to an isolated run",async()=>{
  const f=await fixture(),outside=await fs.mkdtemp(path.join(os.tmpdir(),"plot-run-outside-"));try {
    const external=path.join(outside,"remote.vtk");await fs.writeFile(external,vtk(1));
    const linked=path.join(f.directory,"linked.vtk");await fs.symlink(external,linked);f.receipt.artifacts.push({role:"result",path:linked,revision:plotHash(await fs.readFile(external))});await f.save();
    await assert.rejects(()=>bindPlotRun(f.recordPath,linked),/ownership is stale/);
    await assert.rejects(()=>bindPlotRun(f.recordPath,external),/not a recorded result/);
  }finally{await f.dispose();await fs.rm(outside,{recursive:true,force:true});}
});
test("history UI/MCP share verified units, values, gaps and full-resolution provenance",async()=>{
  const f=await fixture();try {
    const recipe=emptyPlotRecipe(f.source);recipe.series=[{id:"p",source:"history",name:"Pressure",x:"time",y:"v0"}];
    const dataset=await collectPlot(recipe);assert.equal(dataset.partial,false);assert.deepEqual(dataset.series[0].points.map(p=>p.y),[1,4]);
    assert.ok(dataset.series[0].points.every(p=>p.origin?.runId==="run-a"&&p.origin.sourceRevision===f.run.sourceRevision));
    assert.equal(dataset.series[0].xColumn.unit,"s");assert.match(dataset.series[0].diagnostics.join(" "),/verified before and after/);
    const mcp=await plotDataset({recipe}) as PlotDataset;assert.deepEqual(mcp.series[0].points,dataset.series[0].points);
    assert.deepEqual(await plotRunBind({recordPath:f.recordPath,path:f.files[0]}),f.run);
    const missing={...f.source,id:"missing",entityId:100};const table=await loadPlotSource(missing);assert.ok(table.partial);assert.deepEqual(table.rows.map(r=>r.slice(2)),[[],[]]);
  }finally{await f.dispose();}
});
test("a changed run during progressive collection discards unverified samples",async()=>{
  const f=await fixture();try {
    const recipe=emptyPlotRecipe(f.source);recipe.series=[{id:"p",source:"history",name:"Pressure",x:"time",y:"v0"}];
    let changed=false;
    const dataset=await collectPlot(recipe,{partial:partial=>{
      assert.ok(partial.series.every(s=>s.points.every(p=>p.origin?.sourceRevision===undefined)));
      if(!changed){changed=true;f.receipt.jobId="replacement";require("node:fs").writeFileSync(f.recordPath,JSON.stringify(f.receipt));}
    }});
    assert.equal(dataset.partial,true);assert.equal(dataset.series.length,0);assert.match(dataset.diagnostics.join(" "),/identity changed/);
  }finally{await f.dispose();}
});
test("verified disk-run sources refuse live snapshots and run labels conflicting with bindings",async()=>{
  const f=await fixture();try {
    const source:PlotSource={id:"mesh",type:"mesh",path:f.files[0],kind:"Nodes",run:f.run};
    await assert.rejects(()=>loadPlotSource(source,{models:{mesh:parseVtk(vtk(20))}}),/snapshot/);
    assert.throws(()=>validatePlotRecipe(emptyPlotRecipe({...f.source,runId:"other"})),/conflicts/);
    assert.throws(()=>validatePlotRecipe(emptyPlotRecipe({...source,run:{...f.run,sourceRevision:"mtime:42"}})),/invalid run sourceRevision/);
    const relative=emptyPlotRecipe({...source,path:"Main_0_0.vtk",run:{...f.run,recordPath:EXECUTION_FILE}});
    assert.deepEqual(resolvePlotPaths(relative,f.directory).sources[0],source);
  }finally{await f.dispose();}
});
test("physical-time cursor exact/nearest is tolerance-bound, tie-safe and does not infer seconds",async()=>{
  const f=await fixture();try {
    const request:PlotTimeCursorRequest={path:f.files[0],run:f.run,time:.2,timeUnit:"s",times:[0,.2],method:"exact",tolerance:0};
    const exact=await resolvePlotTimeCursor(request);assert.equal(exact.frameIndex,1);assert.equal(exact.time,.2);assert.equal(exact.runId,"run-a");
    assert.deepEqual(await plotTimeCursor(request),exact);
    const nearest=await resolvePlotTimeCursor({...request,time:.18,method:"nearest",tolerance:.03});assert.equal(nearest.frameIndex,1);
    for(const time of [.1,.31])assert.equal((await resolvePlotTimeCursor({...request,time,method:"nearest",tolerance:.1})).matched,false);
    const decimalTie=await resolvePlotTimeCursor({...request,times:[.2,.4],time:.3,method:"nearest",tolerance:.11});assert.equal(decimalTie.matched,false);assert.match(decimalTie.diagnostics.join(" "),/roundoff/);
    const tiny=await resolvePlotTimeCursor({...request,times:[0,1e-20],time:4e-21,method:"nearest",tolerance:1e-20});assert.equal(tiny.frameIndex,0,"Tiny physical times must not inherit a one-second tie epsilon");
    assert.equal((await resolvePlotTimeCursor({...request,time:.18})).matched,false);
    await assert.rejects(()=>resolvePlotTimeCursor({...request,times:undefined}),/not physical time/);
    await assert.rejects(()=>resolvePlotTimeCursor({...request,timeUnit:""}),/time unit/);
    for(const times of [[0],[.2,0],[0,0],[0,Infinity]])await assert.rejects(()=>resolvePlotTimeCursor({...request,times}),/strictly increasing/);
  }finally{await f.dispose();}
});
test("worker cancellation ends owned verification without producing a usable cursor",async()=>{
  const f=await fixture(),session=new PlotWorkerSession();try {
    const controller=new AbortController();controller.abort();
    await assert.rejects(()=>session.run({bindRun:{recordPath:f.recordPath,path:f.files[0]}},{signal:controller.signal}),/cancelled/);
    await assert.rejects(()=>plotFileRevision(f.files[0],controller.signal),/abort/i);
    const work=session.run({runs:[f.directory]},{signal:new AbortController().signal});session.dispose();await assert.rejects(()=>work,/cancelled/);
  }finally{session.dispose();await f.dispose();}
});
test("run records, input meshes and companions are protected from export, even via a symlink",async()=>{
  const f=await fixture();try {
    const recipe=emptyPlotRecipe(f.source),alias=path.join(f.directory,"export-alias.json");await fs.symlink(f.recordPath,alias);
    for(const file of [f.recordPath,runFilePath(f.mesh),f.mesh,f.files[1],alias])await assert.rejects(()=>assertPlotDestination(file,{recipe}),/cannot overwrite/);
    await assertPlotDestination(path.join(f.directory,"safe.csv"),{recipe});
  }finally{await f.dispose();}
});
