import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { parseVtk } from "../parser/vtkLegacyParser";
import { appendFemCurve, emptyPlotRecipe } from "../parser/plot/fem";
import { validatePlotRecipe } from "../parser/plot/recipe";
import { planPlotFollow, plotSnapshotOnTimeline } from "../parser/plot/follow";
import { PlotTableCache } from "../parser/plot/cache";
import { collectPlot, loadPlotSource } from "../parser/plot/sources";
import { PlotWorkerSession } from "../plotWorkerClient";
import { plotDataset } from "../mcp/tools";
import type { PlotDataset, PlotRecipe, PlotSource } from "../parser/plot/types";

const vtk = (p: number) => `# vtk DataFile Version 3.0\nFixture\nASCII\nDATASET UNSTRUCTURED_GRID\nPOINTS 3 float\n0 0 0\n1 0 0\n0 1 0\nCELLS 1 4\n3 0 1 2\nCELL_TYPES 1\n5\nPOINT_DATA 3\nSCALARS PRESSURE float 1\nLOOKUP_TABLE default\n${p} ${p+1} ${p+2}\n`;
const probe = (extra: Partial<Extract<PlotSource,{type:"probe"}>> = {}): Extract<PlotSource,{type:"probe"}> => ({
  id:"profile",type:"probe",path:"/owned/Main_0_0.vtk",variable:"PRESSURE",points:[[.1,.1,0],[.6,.1,0]],samples:3,timeStep:0,followTimeline:true,...extra,
});
const recipe = () => appendFemCurve(emptyPlotRecipe(),probe(),0,1,"Profile");
const owner = {path:probe().path,frameIndex:1,hasTimeline:true,timelineId:"original:rank0"};
const nextFrame = (previous: PlotRecipe, frame = 1): PlotRecipe => ({...previous,sources:previous.sources.map(s=>s.type==="probe"&&s.followTimeline?{...s,timeStep:frame}:s)});
const close = (values: (number|null)[], expected: number[]) => values.forEach((v,i)=>assert.ok(v!==null&&Math.abs(v-expected[i])<1e-8,`${v} != ${expected[i]}`));

test("follow intent needs an explicit probe frame and survives recipe validation",()=>{
  const r=recipe();assert.deepEqual(validatePlotRecipe(JSON.parse(JSON.stringify(r))),r);
  for(const source of [probe({timeStep:undefined}),probe({followTimeline:"yes" as any}),{id:"h",type:"history",path:"x",variable:"PRESSURE",kind:"Nodal",entityId:1,timeStep:0,followTimeline:true}]) {
    assert.throws(()=>validatePlotRecipe(emptyPlotRecipe(source as PlotSource)),/Timeline-following profiles/);
  }
});

test("automatic follow may change only owning probe frames, retaining unrelated source snapshots",()=>{
  const r=recipe();r.sources.push(probe({id:"fixed",followTimeline:false}));
  const next=nextFrame(r);assert.deepEqual(planPlotFollow(r,next,owner.timelineId,owner),["fixed"]);
  for(const changed of [
    {...next,presentation:{...next.presentation,title:"different"}},
    {...next,sources:next.sources.map(s=>s.id==="fixed"?{...s,timeStep:2}:s)},
    {...next,sources:next.sources.map(s=>s.type==="probe"&&s.followTimeline?{...s,samples:4}:s)},
  ])assert.throws(()=>planPlotFollow(r,changed,owner.timelineId,owner),/Plot settings changed/);
  assert.throws(()=>planPlotFollow(r,nextFrame(r,2),owner.timelineId,owner),/owning preview/);
});

test("follow refuses missing observation, other paths, ranks and replacement/resampled timelines",()=>{
  const r=recipe(),next=nextFrame(r);
  assert.throws(()=>planPlotFollow(undefined,next,owner.timelineId,owner),/paused/);
  for(const change of [{timelineId:"rank1"},{timelineId:"resampled"},{hasTimeline:false}])assert.throws(()=>planPlotFollow(r,next,owner.timelineId,{...owner,...change}),/paused/);
  assert.throws(()=>planPlotFollow(r,next,owner.timelineId,{...owner,path:"/other/Main_0_0.vtk"}),/owning preview/);
  const fixed=recipe();fixed.sources=[probe({followTimeline:false})];assert.throws(()=>planPlotFollow(fixed,fixed,owner.timelineId,owner),/No timeline-following/);
  assert.equal(plotSnapshotOnTimeline("original","resampled"),false);assert.equal(plotSnapshotOnTimeline("rank0","rank1"),false);
  assert.equal(plotSnapshotOnTimeline(undefined,"original"),false);assert.equal(plotSnapshotOnTimeline("original","original"),true);assert.equal(plotSnapshotOnTimeline(undefined,undefined),true);
});

test("profile extraction uses the captured frame, preserves uncovered gaps and has no fabricated entity link",async()=>{
  const source=probe({points:[[.1,.1,0],[2,.1,0]],timeStep:4});
  const table=await loadPlotSource(source,{models:{profile:parseVtk(vtk(4))}});
  assert.equal(table.rows[1][1],null);assert.equal(table.rows[2][1],null);
  assert.ok(table.origins!.every(o=>o.frameIndex===4&&o.entityId===undefined));
  assert.match(table.diagnostics.join(" "),/"timeStep":4/);assert.match(table.diagnostics.join(" "),/uncovered/);
});

test("frame-only updates retain fixed probes and fail safely instead of secretly rereading evicted extractions",async()=>{
  const r=recipe();r.sources.push(probe({id:"fixed",followTimeline:false}));r.series.push({...r.series[0],id:"fixed",source:"fixed",name:"Fixed"});
  const retained=new PlotTableCache(100000,"Fixed extraction reused");
  const models={profile:parseVtk(vtk(1)),fixed:parseVtk(vtk(1))};
  await collectPlot(r,{models},undefined,{cache:retained});
  const next=nextFrame(r),reuseSources=planPlotFollow(r,next,owner.timelineId,owner);
  const result=await collectPlot(next,{models:{profile:parseVtk(vtk(4))}},undefined,{cache:retained,reuseSources});
  close(result.series[0].points.map(p=>p.y),[4.3,4.55,4.8]);close(result.series[1].points.map(p=>p.y),[1.3,1.55,1.8]);
  assert.ok(result.series[0].points.every(p=>p.origin?.frameIndex===1));assert.ok(result.series[1].points.every(p=>p.origin?.frameIndex===0));
  assert.match(result.series[1].diagnostics.join(" "),/Fixed extraction reused/);
  retained.clear();await assert.rejects(()=>collectPlot(next,{models:{profile:parseVtk(vtk(4))}},undefined,{cache:retained,reuseSources}),/retention budget/);
  await collectPlot(r,{models},undefined,{cache:retained});
  const changed={...next,sources:next.sources.map(s=>s.id==="fixed"?{...s,variable:"MISSING"}:s)};
  await assert.rejects(()=>collectPlot(changed,{},undefined,{cache:retained,reuseSources}),/fixed extraction is unavailable/);
});

test("real worker following retains histories without disk scans; explicit refresh and MCP use current disk data",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"plot-follow-")),session=new PlotWorkerSession();
  try {
    const file=path.join(dir,"Main_0_0.vtk"),later=path.join(dir,"Main_0_1.vtk");
    await fs.writeFile(file,vtk(1));await fs.writeFile(later,vtk(4));
    const r=appendFemCurve(emptyPlotRecipe(),probe({path:file}),0,1,"Profile");
    r.sources.push({id:"history",type:"history",path:file,kind:"Nodal",entityId:1,variable:"PRESSURE"});
    r.series.push({id:"history",source:"history",name:"History",x:"time",y:"v0",panel:1});r.presentation.panels=2;
    const first=await session.run({recipe:r,models:{profile:parseVtk(vtk(1))}}) as PlotDataset;
    assert.deepEqual(first.series[1].points.map(p=>p.y),[1,4]);
    await fs.rename(file,file+".held");await fs.rename(later,later+".held");
    const next=nextFrame(r),reuseSources=planPlotFollow(r,next,owner.timelineId,{...owner,path:file});
    const followed=await session.run({recipe:next,models:{profile:parseVtk(vtk(4))},reuseSources}) as PlotDataset;
    close(followed.series[0].points.map(p=>p.y),[4.3,4.55,4.8]);assert.deepEqual(followed.series[1].points.map(p=>p.y),[1,4]);
    assert.match(followed.series[1].diagnostics.join(" "),/last explicit collection/);
    await fs.writeFile(file,vtk(7));await fs.writeFile(later,vtk(10));
    const refreshed=await session.run({recipe:next}) as PlotDataset;
    assert.deepEqual(refreshed.series[1].points.map(p=>p.y),[7,10]);close(refreshed.series[0].points.map(p=>p.y),[10.3,10.55,10.8]);
    const mcp=await plotDataset({recipe:next,limit:10}) as PlotDataset;
    assert.deepEqual(mcp.series.map(s=>s.points),refreshed.series.map(s=>s.points));
    const abort=new AbortController();const cancelled=await session.run({recipe:next},{signal:abort.signal,partial:()=>abort.abort()}) as PlotDataset;
    assert.equal(cancelled.partial,true);
    await assert.rejects(()=>session.run({recipe:next,models:{profile:parseVtk(vtk(10))},reuseSources}),/retention budget/);
    const recovered=await session.run({recipe:next}) as PlotDataset;assert.equal(recovered.partial,false);
  } finally {session.dispose();await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
