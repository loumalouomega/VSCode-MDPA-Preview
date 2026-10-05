// Real packaged extension, real provider messages and controls. No injected host replies.
import {createRequire} from "node:module";
import {spawn} from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {randomBytes} from "node:crypto";
import assert from "node:assert/strict";
const require=createRequire(import.meta.url),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const {chromium}=require(process.env.PLAYWRIGHT_MODULE??"playwright-core");
const base=process.env.UI_ROOT??"/tmp/opencode/fem-ui",workspace=path.join(base,"workspace"),port=8201;
await fs.mkdir(workspace,{recursive:true});await fs.mkdir(path.join(base,"user/User"),{recursive:true});
await fs.writeFile(path.join(base,"user/User/settings.json"),JSON.stringify({"workbench.startupEditor":"none","files.autoSave":"off","kratos.showWhatsNew":false,"workbench.colorTheme":"Default Dark Modern","workbench.editor.enablePreview":false,"workbench.secondarySideBar.defaultVisibility":"hidden"}));
function mdpa(step){return `Begin Nodes
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
1 0 ${12*(step+1)}
2 0 ${12*(step+1)+step*2}
3 0 ${12*(step+1)}
4 0 ${12*(step+1)}
End NodalData
Begin NodalData DISPLACEMENT
1 0 [3] (${step},0,0)
2 0 [3] (0,${step*2},0)
3 0 [3] (0,0,${step})
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
`;}
for(let i=0;i<3;i++)await fs.writeFile(path.join(workspace,`FEM_0_${i}.mdpa`),mdpa(i));
await fs.writeFile(path.join(workspace,"vtk_0_0.vtk"),"# vtk DataFile Version 3.0\nFixture\nASCII\nDATASET UNSTRUCTURED_GRID\nPOINTS 3 float\n0 0 0\n1 0 0\n0 1 0\nCELLS 1 4\n3 0 1 2\nCELL_TYPES 1\n5\nPOINT_DATA 3\nSCALARS PRESSURE float 1\nLOOKUP_TABLE default\n1 2 3\n");
await fs.writeFile(path.join(workspace,"vtk_0_1.vtk"),(await fs.readFile(path.join(workspace,"vtk_0_0.vtk"),"utf8")).replace("1 2 3\n","4 5 6\n"));
const password=randomBytes(24).toString("hex"),env={...process.env,PASSWORD:password};delete env.VSCODE_IPC_HOOK_CLI;
const server=spawn(process.env.CODE_SERVER??"/tmp/opencode/code-server-4.140.0-linux-amd64/bin/code-server",["--bind-addr",`127.0.0.1:${port}`,"--disable-workspace-trust","--disable-telemetry","--user-data-dir",path.join(base,"user"),"--extensions-dir",path.join(base,"extensions"),workspace],{env,stdio:["ignore","pipe","pipe"]});
const log=await fs.open(path.join(base,"server.log"),"w");server.stdout.on("data",b=>void log.write(b));server.stderr.on("data",b=>void log.write(b));
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??"/home/vicente/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",args:["--no-sandbox","--use-angle=swiftshader","--enable-unsafe-swiftshader"]});
let page;
try {
  page=await browser.newPage({viewport:{width:1700,height:1120}});page.setDefaultTimeout(30000);
  const violations=[];await page.exposeFunction("__plotCsp",v=>violations.push(v));await page.addInitScript(()=>document.addEventListener("securitypolicyviolation",e=>void window.__plotCsp({directive:e.violatedDirective,blocked:e.blockedURI})));
  let listening=false;for(let i=0;i<100&&!listening;i++){try{listening=(await fetch(`http://127.0.0.1:${port}/healthz`)).ok;}catch{}if(!listening)await new Promise(resolve=>setTimeout(resolve,200));}assert.ok(listening,"code-server did not start");
  await page.goto(`http://127.0.0.1:${port}/?folder=${encodeURIComponent(workspace)}`);
  if(await page.locator('input[type="password"]').count()){await page.locator('input[type="password"]').fill(password);await page.keyboard.press("Enter");}
  await page.locator(".monaco-workbench").waitFor();
  const command=async text=>{await page.locator(".part.titlebar").click({position:{x:20,y:10}});await page.keyboard.press("F1");const input=page.locator(".quick-input-widget input").first();await input.waitFor({state:"visible"});await page.waitForFunction(()=>document.querySelector(".quick-input-widget input")?.value.startsWith(">"));await input.fill(`>${text}`);await page.locator(".quick-input-widget .monaco-list-row").filter({hasText:text}).first().click();};
  const frame=async()=>{for(let i=0;i<100;i++){for(const f of page.frames())if(await f.locator("#render-root").count()&&await f.locator("#render-root").isVisible())return f;await page.waitForTimeout(100);}throw new Error("Missing mesh webview");};
  const open=async(file,preview)=>{await command("View: Close All Editors");await page.getByText(file,{exact:true}).first().dblclick();await page.locator(".tab").filter({hasText:file}).first().waitFor();await command(preview);const f=await frame();await f.locator("#toolbar").waitFor({state:"visible"});await f.waitForFunction(()=>document.querySelector("#stats")?.textContent.length>0);return f;};
  const ready=async f=>{await f.waitForFunction(()=>document.querySelector("#plot-status")?.textContent.includes("full-resolution points")&&!document.querySelector("#plot-status").textContent.startsWith("Partial"));await f.waitForFunction(()=>document.querySelector("#plot-chart")?.data?.length>0&&document.querySelector("#plot-chart").getAttribute("aria-busy")!=="true");};
  const profiles=async(f,file,frameIndex,z)=>{
    while(await f.locator("#plot-curves").getByRole("button",{name:"Remove",exact:true}).count())await f.locator("#plot-curves").getByRole("button",{name:"Remove",exact:true}).first().click();
    await f.locator("#plot-actions").getByRole("button",{name:"Advanced ▾",exact:true}).click();
    const change=async(control,value)=>{await control.fill(String(value));await control.press("Tab");};
    for(const name of ["Fixed profile","Live profile"]){
      const config=f.locator("#plot-config");await config.getByRole("button",{name:"Add source",exact:true}).click();
      let source=config.locator("section").filter({has:f.locator("h2").filter({hasText:"Source ·"})}).last();
      await source.getByLabel("Source type",{exact:true}).selectOption("probe");
      await change(source.getByLabel("File",{exact:true}),path.join(workspace,file));await change(source.getByLabel("Nodal field",{exact:true}),"PRESSURE");
      await change(source.getByLabel("Endpoints (x y z;…)",{exact:true}),`0.1 0.1 ${z};0.6 0.1 ${z}`);await change(source.getByLabel("Samples",{exact:true}),3);await change(source.getByLabel("Frame index",{exact:true}),frameIndex);
      const id=(await source.locator("h2").textContent()).split(" · ")[1];await source.getByRole("button",{name:"Inspect source",exact:true}).click();
      await source.locator("p").filter({hasText:"distance: Distance"}).waitFor();
      if(name==="Live profile"){await config.getByRole("button",{name:"Add series",exact:true}).click();const series=config.locator("section").filter({has:f.locator("h2").filter({hasText:"Series ·"})}).last();await series.getByLabel("Source",{exact:true}).selectOption(id);}
      const series=config.locator("section").filter({has:f.locator("h2").filter({hasText:"Series ·"})}).last();await change(series.getByLabel("Name",{exact:true}),name);await ready(f);
    }
    await change(f.locator("#plot-config").getByLabel("Title",{exact:true}),"Pressure profiles · fixed and following");await ready(f);
    await f.locator("#plot-actions").getByRole("button",{name:"Advanced ▾",exact:true}).click();
    await f.locator("#plot-curves .plot-curve-row").last().getByRole("button",{name:"Follow timeline",exact:true}).click();await ready(f);
    assert.equal(await f.getByRole("button",{name:"Locate peak",exact:true}).count(),0,"Spatial samples cannot claim an invented entity link");
  };
  const assertProfiles=async(f,expected)=>{await f.waitForFunction(expected=>{const chart=document.querySelector("#plot-chart"),data=chart?.data;return chart?.getAttribute("aria-busy")!=="true"&&data?.length===2&&data.every((t,i)=>t.y.length===expected[i].length&&t.y.every((v,j)=>v!==null&&Math.abs(v-expected[i][j])<1e-8));},expected);};
  const errors=[];page.on("pageerror",e=>errors.push(e.message));
  const mesh=await open("FEM_0_0.mdpa","Open MDPA Preview");
  const tabCount=await page.locator(".tab").count();
  assert.equal(await mesh.evaluate(()=>!!window.Plotly),false,"Plotly must not load before Plots is opened");
  await mesh.locator('#toolbar [data-action="plots"]').click();await mesh.getByLabel("Quantity",{exact:true}).waitFor();
  assert.equal(await mesh.locator("#plot-config").isVisible(),false,"Advanced must start hidden");
  const addPoint=async id=>{const quick=mesh.locator("#plot-quick");await quick.getByLabel("Quantity",{exact:true}).selectOption("Nodal:PRESSURE");await quick.getByLabel("Entity ID",{exact:true}).fill(String(id));await quick.getByLabel("Entity ID",{exact:true}).press("Tab");await quick.getByRole("button",{name:`Plot node ${id}`,exact:true}).click();await ready(mesh);};
  await addPoint(1);await addPoint(2);
  assert.deepEqual(await mesh.evaluate(()=>document.querySelector("#plot-chart").data.map(t=>t.y)),[[12,24,36],[12,26,40]]);
  assert.equal(await page.locator(".tab").count(),tabCount,"Plots must not create another editor tab");
  await mesh.locator("#plot-quick").getByLabel("Quantity",{exact:true}).selectOption("Nodal:DISPLACEMENT");await mesh.locator("#plot-quick").getByLabel("Component",{exact:true}).selectOption("magnitude");await mesh.getByRole("button",{name:"Add points from mesh",exact:true}).click();await mesh.locator("#nav-fit").click();const scene=await mesh.locator("#render-root").boundingBox();await mesh.locator("#render-root").click({position:{x:scene.width*.5,y:scene.height*.55}});await mesh.waitForFunction(()=>document.querySelectorAll("#plot-curves .plot-curve-row").length===3);await page.keyboard.press("Escape");await mesh.locator("#plot-curves .plot-curve-row").last().getByRole("button",{name:"Remove",exact:true}).click();await ready(mesh);
  await mesh.getByRole("button",{name:"Locate peak",exact:true}).first().click();await mesh.waitForFunction(()=>document.querySelector("#sb-count-frame")?.textContent.includes("frame 3"));
  await mesh.getByRole("button",{name:"Dock below",exact:true}).click();assert.equal(await mesh.evaluate(()=>document.querySelector("#viewport").classList.contains("plot-vertical")),false);
  await mesh.getByRole("button",{name:"Dock beside",exact:true}).click();await mesh.locator("#plot-resizer").focus();await page.keyboard.press("ArrowLeft");
  await mesh.getByRole("button",{name:"Collapse plots",exact:true}).click();await mesh.locator("#plot-restore").click();assert.equal(await mesh.locator("#plot-curves .plot-curve-row").count(),2);
  await mesh.getByRole("button",{name:"Advanced ▾",exact:true}).click();assert.equal(await mesh.locator("#plot-config").isVisible(),true);await mesh.getByRole("button",{name:"Advanced ▾",exact:true}).click();
  await mesh.locator("#plot-curves").getByRole("button",{name:"Remove",exact:true}).first().click();await mesh.locator("#plot-curves").getByRole("button",{name:"Remove",exact:true}).first().click();
  const analyze=mesh.getByRole("button",{name:"Analyze Wall",exact:true});await analyze.locator("xpath=ancestor::*[contains(@class,'outline-row')]").hover();await analyze.click();
  await mesh.locator("#plot-quick").getByLabel("Scope",{exact:true}).selectOption("history");await mesh.locator("#plot-quick").getByLabel("Component",{exact:true}).selectOption("2");await mesh.getByRole("button",{name:"Add region curve",exact:true}).click();await ready(mesh);
  const loads=await mesh.evaluate(()=>document.querySelector("#plot-chart").data[0].y);[6,37/3,56/3].forEach((v,i)=>assert.ok(Math.abs(loads[i]-v)<1e-8));
  await mesh.locator("#nav-fit").click();await mesh.locator("#render-root").click({position:{x:20,y:200}});await page.keyboard.press("i");
  const screenshots=path.join(root,"doc/public/screenshots");await fs.mkdir(screenshots,{recursive:true});await page.screenshot({path:path.join(screenshots,"fem-pressure-resultant.png")});
  await mesh.locator("#plot-curves").getByRole("button",{name:"Remove",exact:true}).click();await mesh.getByLabel("Target",{exact:true}).selectOption("point");await addPoint(1);await addPoint(2);await page.screenshot({path:path.join(screenshots,"fem-point-histories.png")});
  for(const [name,cls,file]of[["Light Modern","vscode-light","fem-plots-light.png"],["Dark High Contrast","vscode-high-contrast","fem-plots-contrast.png"]]){await command("Preferences: Color Theme");await page.locator(".quick-input-widget input").first().fill(name);await page.waitForTimeout(300);await page.keyboard.press("Enter");await mesh.waitForFunction(c=>document.body.classList.contains(c),cls);await page.waitForTimeout(300);await page.screenshot({path:path.join(screenshots,file)});}
  await profiles(mesh,"FEM_0_0.mdpa",2,.1);await mesh.getByRole("button",{name:"Previous frame",exact:true}).click();await assertProfiles(mesh,[[36.4,37.4,38.4],[24.2,24.7,25.2]]);
  await mesh.locator("#plot-curves").getByRole("button",{name:"Fix frame",exact:true}).click();await ready(mesh);await mesh.getByRole("button",{name:"Previous frame",exact:true}).click();await mesh.waitForFunction(()=>document.querySelector("#sb-count-frame")?.textContent.includes("frame 1"));await assertProfiles(mesh,[[36.4,37.4,38.4],[24.2,24.7,25.2]]);
  await mesh.locator("#plot-curves .plot-curve-row").last().getByRole("button",{name:"Follow timeline",exact:true}).click();await ready(mesh);await mesh.locator("#plot-actions").getByRole("button",{name:"Cancel",exact:true}).click();await mesh.getByRole("button",{name:"Next frame",exact:true}).click();await mesh.waitForFunction(()=>document.querySelector("#sb-count-frame")?.textContent.includes("frame 2"));await assertProfiles(mesh,[[36.4,37.4,38.4],[12,12,12]]);
  await mesh.locator("#plot-curves").getByRole("button",{name:"Resume following",exact:true}).click();await assertProfiles(mesh,[[36.4,37.4,38.4],[24.2,24.7,25.2]]);await page.screenshot({path:path.join(screenshots,"fem-timeline-profile.png")});
  assert.equal(await page.locator(".tab.dirty").count(),0,"Plotting dirtied the mesh");
  const vtk=await open("vtk_0_0.vtk","Open VTK Preview");await vtk.locator('#toolbar [data-action="plots"]').click();await vtk.waitForFunction(()=>document.querySelector("#plot-app")?.dataset.plotReady==="true");await vtk.locator("#plot-quick").getByLabel("Entity ID",{exact:true}).fill("1");await vtk.locator("#plot-quick").getByLabel("Entity ID",{exact:true}).press("Tab");await vtk.getByRole("button",{name:"Plot node 1",exact:true}).click();await ready(vtk);assert.deepEqual(await vtk.evaluate(()=>document.querySelector("#plot-chart").data[0].y),[1,4]);
  await profiles(vtk,"vtk_0_0.vtk",0,0);await vtk.getByRole("button",{name:"Next frame",exact:true}).click();await assertProfiles(vtk,[[1.3,1.55,1.8],[4.3,4.55,4.8]]);
  await vtk.locator("#timeline-bar").getByText("Resample",{exact:true}).click();await vtk.getByLabel("Target times or start:stop:step",{exact:true}).fill("0.5,1");await vtk.getByLabel("Source times (optional comma-separated)",{exact:true}).fill("0,1");await vtk.getByLabel("Continuous unknown fields (kind:variable)",{exact:true}).fill("Nodal:PRESSURE");await vtk.locator("#timeline-bar").getByRole("button",{name:"Apply",exact:true}).click();
  await vtk.locator("#plot-curves").getByRole("button",{name:"Resume following",exact:true}).waitFor();assert.ok((await vtk.locator("#plot-status").innerText()).includes("following paused"));await assertProfiles(vtk,[[1.3,1.55,1.8],[4.3,4.55,4.8]]);
  await vtk.locator("#plot-curves").getByRole("button",{name:"Resume following",exact:true}).click();await assertProfiles(vtk,[[1.3,1.55,1.8],[2.8,3.05,3.3]]);await vtk.getByRole("button",{name:"Next frame",exact:true}).click();await assertProfiles(vtk,[[1.3,1.55,1.8],[4.3,4.55,4.8]]);
  assert.equal(await page.locator(".tab.dirty").count(),0);assert.deepEqual(errors,[]);assert.deepEqual(violations,[]);
  console.log(JSON.stringify({packaged:true,embedded:true,lazyPlotly:true,multiPoint:true,meshClickAppend:true,regionResultant:loads,linkedPeak:true,docking:true,advancedHidden:true,timelineProfiles:true,fixedProfilesRetained:true,followingCancelResume:true,resampledProfile:true,timelineRebindingExplicit:true,providers:["MDPA","VTK"],themes:3,meshDirty:false,cspViolations:violations,screenshots:5},null,2));
} catch(e){if(page){await page.screenshot({path:path.join(base,"failure.png")});await fs.writeFile(path.join(base,"failure.txt"),(await page.locator("body").innerText())+"\nFrames: "+page.frames().map(f=>f.url()).join("\n"));}throw e;}
finally {await browser.close();server.kill("SIGTERM");await log.close();}
