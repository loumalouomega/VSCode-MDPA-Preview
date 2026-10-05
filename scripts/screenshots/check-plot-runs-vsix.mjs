// Installed-VSIX run/recipe/dialog regression. A real child fixture process is
// dispatched through the packaged MCP server; it is not a Kratos solver run.
// Install the VSIX into UI_ROOT/extensions first. No injected webview replies.
import {createRequire} from "node:module";
import {spawn} from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {randomBytes} from "node:crypto";
import assert from "node:assert/strict";
const require=createRequire(import.meta.url),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const {chromium}=require(process.env.PLAYWRIGHT_MODULE??"playwright-core");
const base=process.env.UI_ROOT??"/tmp/opencode/plot-runs-ui",workspace=path.join(base,"workspace"),port=8203;
await fs.mkdir(workspace,{recursive:true});await fs.mkdir(path.join(base,"user/User"),{recursive:true});
await fs.writeFile(path.join(base,"user/User/settings.json"),JSON.stringify({"workbench.startupEditor":"none","files.autoSave":"off","kratos.showWhatsNew":false,"workbench.colorTheme":"Default Dark Modern","workbench.editor.enablePreview":false,"workbench.secondarySideBar.defaultVisibility":"hidden"}));
const vtk=value=>`# vtk DataFile Version 3.0\nRun fixture\nASCII\nDATASET UNSTRUCTURED_GRID\nPOINTS 3 float\n0 0 0\n1 0 0\n0 1 0\nCELLS 1 4\n3 0 1 2\nCELL_TYPES 1\n5\nPOINT_DATA 3\nSCALARS PRESSURE float 1\nLOOKUP_TABLE default\n${value} ${value+1} ${value+2}\n`;
await fs.writeFile(path.join(workspace,"input.mdpa"),"Begin Nodes\n1 0 0 0\n2 1 0 0\n3 0 1 0\nEnd Nodes\nBegin Elements Element2D3N\n1 0 1 2 3\nEnd Elements\n");
await fs.writeFile(path.join(workspace,"fixture.cjs"),`const fs=require("node:fs");fs.mkdirSync("vtk_output");${[1,4,9].map((v,i)=>`fs.writeFileSync("vtk_output/Main_0_${i}.vtk",${JSON.stringify(vtk(v))});`).join("\n")}`);
const installed=(await fs.readdir(path.join(base,"extensions"))).find(n=>n.startsWith("kratos-multiphysics.vscode-mdpa-"));assert.ok(installed,"Install the target VSIX into UI_ROOT/extensions first.");
const env={...process.env};delete env.VSCODE_IPC_HOOK_CLI;
const mcp=spawn(process.execPath,[path.join(base,"extensions",installed,"dist/mcpServer.js")],{cwd:base,env,stdio:["pipe","pipe","pipe"]});
const pending=new Map();let buffer="",messageId=0,stderr="";mcp.stderr.on("data",b=>stderr+=b);
mcp.stdout.on("data",b=>{buffer+=b;let end;while((end=buffer.indexOf("\n"))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;const msg=JSON.parse(line);if(pending.has(msg.id)){pending.get(msg.id)(msg);pending.delete(msg.id);}}});
mcp.on("exit",code=>{for(const resolve of pending.values())resolve({error:{message:`MCP exited (${code}): ${stderr}`}});pending.clear();});
const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++messageId,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Packaged MCP ${method} exceeded 60 s: ${stderr}`));},60000);pending.set(id,msg=>{clearTimeout(timer);msg.error?reject(new Error(msg.error.message)):resolve(msg.result);});mcp.stdin.write(JSON.stringify({jsonrpc:"2.0",id,method,params})+"\n");});
let runId;
const runDirectory=path.join(workspace,`saved-run-${randomBytes(4).toString("hex")}`);
try {
  await rpc("initialize",{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"plot-runs-acceptance",version:"1"}});
  mcp.stdin.write(JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized"})+"\n");
  const result=await rpc("tools/call",{name:"case_run",arguments:{meshPath:path.join(workspace,"input.mdpa"),python:process.execPath,scriptName:"fixture.cjs",generate:false,waitSeconds:10,requestId:"plot-fixture-request",ownerId:"plot-fixture-study",runDirectory}});
  assert.equal(result.isError,undefined,JSON.stringify(result));const value=JSON.parse(result.content[0].text);assert.equal(value.status,"finished");runId=value.runId;
  const tools=await rpc("tools/list",{});for(const name of ["plot_runs","plot_run_bind","plot_time_cursor"])assert.ok(tools.tools.some(t=>t.name===name),name);
}finally{mcp.kill("SIGTERM");}
const suffix=path.basename(runDirectory).replace("saved-run-","");
const source=path.join(runDirectory,"vtk_output/Main_0_0.vtk"),recipeFile=path.join(workspace,`owned-recipe-${suffix}.json`),csvFile=path.join(workspace,`owned-data-${suffix}.csv`);
const password=randomBytes(24).toString("hex");env.PASSWORD=password;
const server=spawn(process.env.CODE_SERVER??"/tmp/opencode/code-server-4.140.0-linux-amd64/bin/code-server",["--bind-addr",`127.0.0.1:${port}`,"--disable-workspace-trust","--disable-telemetry","--user-data-dir",path.join(base,"user"),"--extensions-dir",path.join(base,"extensions"),workspace],{env,stdio:["ignore","pipe","pipe"]});
const log=await fs.open(path.join(base,"server.log"),"w");server.stdout.on("data",b=>void log.write(b));server.stderr.on("data",b=>void log.write(b));
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??"/home/vicente/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",args:["--no-sandbox","--use-angle=swiftshader","--enable-unsafe-swiftshader"]});
let page;
try {
  page=await browser.newPage({viewport:{width:1700,height:1120}});page.setDefaultTimeout(30000);
  const errors=[],violations=[];page.on("pageerror",e=>errors.push(e.message));await page.exposeFunction("__plotCsp",v=>violations.push(v));await page.addInitScript(()=>document.addEventListener("securitypolicyviolation",e=>void window.__plotCsp({directive:e.violatedDirective,blocked:e.blockedURI})));
  let listening=false;for(let i=0;i<100&&!listening;i++){try{listening=(await fetch(`http://127.0.0.1:${port}/healthz`)).ok;}catch{}if(!listening)await new Promise(resolve=>setTimeout(resolve,200));}assert.ok(listening,"code-server did not start");
  await page.goto(`http://127.0.0.1:${port}/?folder=${encodeURIComponent(workspace)}`);
  if(await page.locator('input[type="password"]').count()){await page.locator('input[type="password"]').fill(password);await page.keyboard.press("Enter");}
  await page.locator(".monaco-workbench").waitFor();
  const command=async text=>{await page.locator(".part.titlebar").click({position:{x:20,y:10}});await page.keyboard.press("F1");const input=page.locator(".quick-input-widget input").first();await input.waitFor({state:"visible"});await page.waitForFunction(()=>document.querySelector(".quick-input-widget input")?.value.startsWith(">"));await input.fill(`>${text}`);await page.locator(".quick-input-widget .monaco-list-row").filter({hasText:text}).first().waitFor({state:"visible"});await input.press("Enter");await input.waitFor({state:"hidden"});};
  const frame=async()=>{for(let i=0;i<100;i++){for(const f of page.frames())if(await f.locator("#plot-app").count()&&await f.locator("#plot-app").isVisible())return f;await page.waitForTimeout(100);}throw new Error("Missing plot webview");};
  const ready=async plot=>{await plot.waitForFunction(()=>document.querySelector("#plot-status")?.textContent.includes("full-resolution points")&&!document.querySelector("#plot-status").textContent.startsWith("Partial"));await plot.waitForFunction(()=>document.querySelector("#plot-chart")?.data?.length>0&&document.querySelector("#plot-chart").getAttribute("aria-busy")!=="true");};
  const choose=async text=>{
    await page.locator(".quick-input-widget .monaco-list-row").filter({hasText:text}).first().waitFor({state:"visible"});
    const input=page.locator(".quick-input-widget input").first();await input.waitFor({state:"visible"});await input.fill(text);
    await page.waitForFunction(text=>{const rows=[...document.querySelectorAll(".quick-input-widget .monaco-list-row")].filter(r=>r.offsetParent!==null);return rows.length>0&&rows.every(r=>r.textContent.includes(text));},text);
    await input.press("Enter");
  };
  const dialogPath=async(file,save=false)=>{
    const input=page.locator(".quick-input-widget input").first();await input.waitFor({state:"visible"});
    // Visibility precedes the remote folder listing and its final caret reset.
    // Do not type while that initialization can restore/append the default path.
    if(save)await page.locator(".quick-input-widget .monaco-list-row").first().waitFor({state:"visible"});
    await page.waitForTimeout(700);await input.fill(file===runDirectory?file+path.sep:file);await page.waitForTimeout(700);await input.press("Enter");
  };
  const change=async(control,value)=>{await control.fill(String(value));await control.press("Tab");};
  await command("Kratos Mesh: Scientific Plot Builder");let plot=await frame();
  await plot.getByRole("button",{name:"Saved run…",exact:true}).click();await choose("Choose saved run directory…");await dialogPath(runDirectory);
  await page.locator(".quick-input-widget .monaco-list-row").filter({hasText:runId}).first().waitFor();await page.mouse.move(20,20);await page.locator(".notification-toast").filter({hasText:"Verify saved run results"}).waitFor({state:"hidden"});await page.screenshot({path:path.join(root,"doc/public/screenshots/plot-run-discovery.png")});await choose(runId);await choose("Main_0_0.vtk");
  await plot.locator("#plot-config p").filter({hasText:`Pinned run ${runId}`}).waitFor();await ready(plot);
  await plot.getByLabel("Source type",{exact:true}).selectOption("history");await change(plot.getByLabel("Field",{exact:true}),"PRESSURE");await change(plot.getByLabel("Physical times",{exact:true}),"0,0.2,0.4");await change(plot.getByLabel("Time unit",{exact:true}),"s");
  await plot.getByRole("button",{name:"Inspect source",exact:true}).click();
  await plot.getByLabel("X column",{exact:true}).selectOption("time");await plot.getByLabel("Y column",{exact:true}).selectOption("v0");await ready(plot);
  await change(plot.getByLabel("Title",{exact:true}),"Owned result history · supplied time mapping");await change(plot.getByLabel("Name",{exact:true}),"Node 1 · PRESSURE (unknown unit)");await ready(plot);
  assert.deepEqual(await plot.evaluate(()=>document.querySelector("#plot-chart").data[0].y),[1,4,9]);assert.equal(await plot.getByRole("button",{name:"Show in mesh",exact:true}).count(),0,"A run receipt is not an owning preview binding");
  await plot.getByRole("button",{name:"Resolve time cursor",exact:true}).click();await dialogPath("0.2");await choose("exact");await plot.waitForFunction(()=>document.querySelector("#plot-status")?.textContent.includes("frame index 1"));
  const screenshots=path.join(root,"doc/public/screenshots");await fs.mkdir(screenshots,{recursive:true});await plot.locator("#plot-config").evaluate(e=>e.scrollTop=0);await page.locator(".notification-toast").filter({hasText:"Verify saved run results"}).waitFor({state:"hidden"});await page.screenshot({path:path.join(screenshots,"plot-owned-run.png")});
  await plot.getByRole("button",{name:"Save recipe",exact:true}).click();await dialogPath(recipeFile,true);await plot.waitForFunction(()=>document.querySelector("#plot-status")?.textContent.startsWith("Recipe saved:"));
  const saved=JSON.parse(await fs.readFile(recipeFile,"utf8"));assert.equal(saved.sources[0].type,"history");assert.equal(saved.sources[0].run.runId,runId);assert.ok(!path.isAbsolute(saved.sources[0].run.recordPath));
  await plot.getByRole("button",{name:"CSV + metadata",exact:true}).click();await dialogPath(csvFile,true);await plot.waitForFunction(()=>document.querySelector("#plot-status")?.textContent.startsWith("Full-resolution data saved:"));
  const csv=await fs.readFile(csvFile,"utf8");assert.equal(csv.trim().split("\n").length,7);assert.ok(csv.includes(runId));const manifest=JSON.parse(await fs.readFile(csvFile+".kratosplot.json","utf8"));assert.equal(manifest.fullCount,3);assert.equal(manifest.recipe.sources[0].run.ownerId,"plot-fixture-study");
  for(const format of ["PNG","SVG"]){const file=path.join(workspace,`owned-view-${suffix}.${format.toLowerCase()}`);await plot.getByRole("button",{name:format,exact:true}).click();await dialogPath(file,true);await plot.waitForFunction(file=>document.querySelector("#plot-status")?.textContent===`Plot image saved: ${file}`,file);assert.ok((await fs.stat(file)).size>100);const metadata=JSON.parse(await fs.readFile(file+".kratosplot.json","utf8"));assert.equal(metadata.graphics.format,format.toLowerCase());}
  await plot.getByRole("button",{name:"Open owning result",exact:true}).click();await page.locator(".tab").filter({hasText:"Main_0_0.vtk"}).waitFor();
  let preview;for(let i=0;i<100&&!preview;i++){for(const f of page.frames())if(await f.locator("#render-root").count()&&await f.locator("#render-root").isVisible()&&(await f.locator("#stats").textContent()).includes("3"))preview=f;if(!preview)await page.waitForTimeout(100);}assert.ok(preview,"Owning result must finish opening in the real provider");assert.equal(await page.locator(".tab.dirty").count(),0);
  await command("View: Close All Editors");await command("Kratos Mesh: Scientific Plot Builder");plot=await frame();await plot.getByRole("button",{name:"Load recipe",exact:true}).click();await dialogPath(recipeFile);await ready(plot);assert.deepEqual(await plot.evaluate(()=>document.querySelector("#plot-chart").data[0].y),[1,4,9]);
  const refresh=async()=>{await plot.getByRole("button",{name:"Refresh",exact:true}).click();await ready(plot);};
  const refused=async message=>{await plot.getByRole("button",{name:"Refresh",exact:true}).click();await plot.waitForFunction(message=>document.querySelector("#plot-status")?.textContent.startsWith("Partial")&&document.querySelector("#plot-diagnostics")?.textContent.includes(message),message);assert.deepEqual(await plot.evaluate(()=>document.querySelector("#plot-chart").data??[]),[]);};
  // A different saved frame participates in the selected rank's ownership.
  const companion=path.join(runDirectory,"vtk_output/Main_0_1.vtk");await fs.writeFile(companion,vtk(7));await refused("revision missing or changed");await fs.writeFile(companion,vtk(4));await refresh();
  const latest=path.join(runDirectory,"input.kratosrun.json"),latestBytes=await fs.readFile(latest,"utf8");await fs.writeFile(latest,JSON.stringify({...JSON.parse(latestBytes),runId:"replacement-run"}));await refused("latest-run record");
  await plot.getByRole("button",{name:"Open owning result",exact:true}).click();await plot.waitForFunction(()=>document.querySelector("#plot-status")?.textContent.includes("latest-run record"));assert.equal(await page.locator(".tab").count(),1,"A replaced run must not open or redirect a preview");
  await fs.writeFile(latest,latestBytes);await refresh();
  await fs.rename(source,source+".missing");await refused("revision missing or changed");await fs.rename(source+".missing",source);await refresh();
  // Explicit rebinding goes through the same real discovery and result dialogs.
  await plot.getByRole("button",{name:"Rebind saved run…",exact:true}).click();await choose("Choose saved run directory…");await dialogPath(runDirectory);await choose(runId);await choose("Main_0_0.vtk");await ready(plot);
  assert.deepEqual(await plot.evaluate(()=>document.querySelector("#plot-chart").data[0].y),[1,4,9]);
  await plot.getByRole("button",{name:"Saved run…",exact:true}).click();await choose("Choose saved run directory…");await dialogPath(runDirectory);
  await page.locator(".quick-input-widget .monaco-list-row").filter({hasText:"unresolved output ownership"}).click();await plot.waitForFunction(()=>document.querySelector("#plot-status")?.textContent.includes("no outputs adopted"));assert.equal(await plot.getByLabel("Source type",{exact:true}).count(),1);
  await plot.getByRole("button",{name:"Saved run…",exact:true}).click();await page.locator(".quick-input-widget input").first().waitFor({state:"visible"});await page.keyboard.press("Escape");assert.deepEqual(await plot.evaluate(()=>document.querySelector("#plot-chart").data[0].y),[1,4,9]);
  await fs.writeFile(source,vtk(7));await refused("revision missing or changed");await plot.getByText("Sources, transformations and diagnostics",{exact:true}).click();await page.screenshot({path:path.join(screenshots,"plot-run-stale.png")});
  assert.equal(await page.locator(".tab.dirty").count(),0);assert.deepEqual(errors,[]);assert.deepEqual(violations,[]);
  console.log(JSON.stringify({packaged:true,packagedMcpFixtureDispatch:true,runDiscovery:true,pinnedOwnership:true,physicalTimeCursor:true,recipeDialogs:true,reopen:true,fullCsv:true,imageDialogs:["png","svg"],explicitRebind:true,cancelledRunDialog:true,legacyOutputsUnresolved:true,changedSourceRefused:true,missingSourceRefused:true,changedCompanionRefused:true,reusedRunRefused:true,automaticPreviewRedirection:false,meshDirty:false,screenshots:["plot-owned-run.png","plot-run-discovery.png","plot-run-stale.png"],pageErrors:errors,cspViolations:violations},null,2));
}catch(e){if(page){await page.screenshot({path:path.join(base,"failure.png")});await fs.writeFile(path.join(base,"failure.txt"),(await page.locator("body").innerText())+"\nInputs: "+JSON.stringify(await page.locator("input").evaluateAll(inputs=>inputs.map(i=>({label:i.getAttribute("aria-label"),value:i.value,visible:i.offsetParent!==null}))))+"\nPicker: "+(await page.locator(".quick-input-widget").first().innerHTML())+"\nFrames: "+page.frames().map(f=>f.url()).join("\n"));}throw e;}
finally{await browser.close();server.kill("SIGTERM");await log.close();}
