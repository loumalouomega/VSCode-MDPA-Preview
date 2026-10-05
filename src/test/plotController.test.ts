/** Controller lifecycle checks with an isolated VS Code/dialog/worker boundary.
 * Numerical ownership and real provider/dialog behavior have separate tests. */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { emptyPlotRecipe } from "../parser/plot/recipe";
import { evaluatePlot } from "../parser/plot/numerics";
import type { PlotSource } from "../parser/plot/types";
import type { PlotWork, PlotWorkResult } from "../plotWorker";
import type { createPlotController } from "../plotController";

function deferred<T>() {
  let resolve!:(value:T)=>void,reject!:(error:Error)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};
}
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
const source=():Extract<PlotSource,{type:"history"}>=>({id:"owned",type:"history",path:"/saved/result.vtk",kind:"Nodal",entityId:1,variable:"PRESSURE",times:[0,.2],timeUnit:"s",run:{recordPath:"/saved/.kkss-execution.json",runId:"run-a",ownerId:"study-a",requestId:"request-a",receiptRevision:`sha256:${"a".repeat(64)}`,sourceRevision:`sha256:${"b".repeat(64)}`}});
function harness() {
  const messages:any[]=[],commands:any[]=[],writes:any[]=[],protectedFiles:any[]=[];
  const boundary={
    input:async()=>"0.2" as string|undefined,
    save:async()=>({fsPath:"/exports/recipe.json"}) as {fsPath:string}|undefined,
    work:async(work:PlotWork):Promise<PlotWorkResult>=>{
      if("recipe" in work)return evaluatePlot(work.recipe,{});
      if("bindRun" in work)return source().run!;
      if("timeCursor" in work)return {path:work.timeCursor.path,runId:"run-a",sourceRevision:source().run!.sourceRevision,timeUnit:"s",matched:true,frameIndex:1,time:.2,diagnostics:[]};
      throw new Error("Unexpected test worker request.");
    },
  };
  const vscode={
    window:{showInputBox:()=>boundary.input(),showSaveDialog:()=>boundary.save(),showQuickPick:async()=>"exact",withProgress:async(_options:unknown,task:Function)=>task({}, {onCancellationRequested:()=>({dispose(){}})})},
    commands:{executeCommand:async(...args:unknown[])=>{commands.push(args);}},
    Uri:{file:(file:string)=>({fsPath:file})},ViewColumn:{Beside:2},ProgressLocation:{Notification:15},
  };
  const filename=path.join(__dirname,"../plotController.js"),realRequire=createRequire(filename),exports:any={};
  const mocks:Record<string,unknown>={
    vscode,
    "node:fs/promises":{writeFile:async(...args:unknown[])=>{writes.push(args);}},
    "./webviewChrome":{},
    "./plotWorkerClient":{runPlotWorker:(work:PlotWork)=>boundary.work(work),PlotWorkerSession:class {run(work:PlotWork){return boundary.work(work);}dispose(){}}},
    "./parser/plot/files":{assertPlotDestination:async(file:string,data:unknown)=>{protectedFiles.push({file,data});}},
  };
  runInNewContext(fs.readFileSync(filename,"utf8"),{exports,require:(name:string)=>name in mocks?mocks[name]:realRequire(name),AbortController,Buffer},{filename});
  const create=exports.createPlotController as typeof createPlotController;
  const controller=create({workspaceState:{get:()=>[]}} as any,{postMessage:(msg:unknown)=>{messages.push(msg);}} as any,{path:"/saved/result.vtk",source:source()});
  return {controller,messages,commands,writes,protectedFiles,boundary};
}

test("superseded cursor dialogs cannot publish a late result or error",async()=>{
  const h=harness(),first=deferred<string|undefined>();let count=0;
  h.boundary.input=()=>++count===1?first.promise:Promise.resolve("0.2");
  try {
    h.controller.receive({type:"plotTimeCursor",source:source()});await settle();
    h.controller.receive({type:"plotTimeCursor",source:source()});await settle();
    assert.equal(h.messages.filter(m=>m.type==="plotNotice").length,1);
    first.reject(new Error("late dialog failure"));await settle();
    assert.equal(h.messages.filter(m=>m.type==="plotNotice").length,1);assert.equal(h.messages.filter(m=>m.type==="plotError").length,0);
  }finally{h.controller.dispose();}
});
test("closing a plot during run verification never opens a preview",async()=>{
  const h=harness(),work=deferred<PlotWorkResult>();h.boundary.work=()=>work.promise;
  h.controller.receive({type:"plotRunOpen",source:source()});await settle();h.controller.dispose();work.resolve(source().run!);await settle();
  assert.equal(h.commands.length,0);assert.equal(h.messages.length,0);
  assert.equal(h.controller.receive({type:"plotRunOpen",source:source()}),false);
});
test("a changed source cannot redirect a preview or publish a cursor resolved for old settings",async()=>{
  for(const type of ["plotRunOpen","plotTimeCursor"])for(const beforeCollection of [false,true]) {
    const h=harness(),work=deferred<PlotWorkResult>(),normal=h.boundary.work;
    h.boundary.work=request=>"recipe" in request?normal(request):work.promise;
    try {
      h.controller.receive({type,source:source()});await settle();
      h.controller.receive(beforeCollection?{type:"plotInvalidate"}:{type:"plotEvaluate",requestId:2,recipe:emptyPlotRecipe({...source(),entityId:2})});await settle();
      work.resolve(type==="plotRunOpen"?source().run!:await normal({timeCursor:{path:source().path,run:source().run!,time:.2,timeUnit:"s",method:"exact",tolerance:0}}));await settle();
      assert.equal(h.commands.length,0);assert.equal(h.messages.filter(m=>m.type==="plotNotice").length,0);
      assert.match(h.messages.find(m=>m.type==="plotError")?.message,/Source settings changed/);
    }finally{h.controller.dispose();}
  }
});
test("key order and explicit undefined survive the stale-dialog source comparison",async()=>{
  const h=harness(),work=deferred<PlotWorkResult>();h.boundary.work=()=>work.promise;
  try {
    // The webview posts a source whose keys were reordered by a postMessage
    // round trip and which carries an explicit undefined `runId`.
    const round=Object.fromEntries(Object.entries(source()).reverse()) as Extract<PlotSource,{type:"history"}>;
    (round as Record<string,unknown>).runId=undefined;
    h.controller.receive({type:"plotRunOpen",source:round});await settle();
    work.resolve(source().run!);await settle();
    assert.equal(h.commands.length,1,"A reordered but identical source must not be refused");
    assert.equal(h.messages.filter(m=>m.type==="plotError").length,0);
  }finally{h.controller.dispose();}
});
test("a recipe changed during its save dialog is refused without writing",async()=>{
  const h=harness(),dialog=deferred<{fsPath:string}|undefined>();h.boundary.save=()=>dialog.promise;
  try {
    h.controller.receive({type:"plotSaveRecipe",recipe:emptyPlotRecipe(source())});await settle();
    h.controller.receive({type:"plotEvaluate",requestId:2,recipe:emptyPlotRecipe({...source(),entityId:2})});await settle();
    dialog.resolve({fsPath:"/exports/recipe.json"});await settle();
    assert.equal(h.writes.length,0);assert.match(h.messages.find(m=>m.type==="plotError")?.message,/plot changed/);
  }finally{h.controller.dispose();}
});
test("an image export protects its captured run even after a new recipe replaces the view",async()=>{
  const h=harness(),dialog=deferred<{fsPath:string}|undefined>();h.boundary.save=()=>dialog.promise;
  try {
    h.controller.receive({type:"plotEvaluate",requestId:1,recipe:emptyPlotRecipe(source())});await settle();
    h.controller.receive({type:"plotExportImage",requestId:1,format:"png",data:"data:image/png;base64,aW1hZ2U=",view:{}});await settle();
    h.controller.receive({type:"plotEvaluate",requestId:2,recipe:emptyPlotRecipe()});await settle();
    dialog.resolve({fsPath:"/exports/captured.png"});await settle();
    assert.ok(h.protectedFiles.some(check=>check.file==="/exports/captured.png"&&check.data.recipe.sources[0]?.run?.runId==="run-a"));
    const manifest=JSON.parse(h.writes.find(write=>write[0].endsWith(".kratosplot.json"))[1]);assert.equal(manifest.recipe.sources[0].run.runId,"run-a");
  }finally{h.controller.dispose();}
});
