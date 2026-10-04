// Packaged-extension check: isolated code-server profile, real host and webviews.
// First package/install the VSIX into UI_ROOT/extensions. No user settings/files are changed.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
const require=createRequire(import.meta.url),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const {chromium}=require(process.env.PLAYWRIGHT_MODULE??"playwright-core");
const base=process.env.UI_ROOT??"/tmp/opencode/plot-ui",workspace=path.join(base,"workspace");
await fs.mkdir(workspace,{recursive:true});await fs.mkdir(path.join(base,"user/User"),{recursive:true});
await fs.writeFile(path.join(base,"user/User/settings.json"),JSON.stringify({"workbench.startupEditor":"none","files.autoSave":"off","kratos.showWhatsNew":false,"workbench.colorTheme":"Default Dark Modern","workbench.editor.enablePreview":false,"workbench.secondarySideBar.defaultVisibility":"hidden"}));
const mdpa="Begin Nodes\n1 0 0 0\n2 1 0 0\n3 0 1 0\nEnd Nodes\nBegin Elements Element2D3N\n1 0 1 2 3\nEnd Elements\nBegin NodalData RESPONSE\n1 0 1\n2 0 3\n3 0 5\nEnd NodalData\n";
await fs.writeFile(path.join(workspace,"sample.mdpa"),mdpa);
await fs.writeFile(path.join(workspace,"sample.vtk"),"# vtk DataFile Version 3.0\nPlot fixture\nASCII\nDATASET UNSTRUCTURED_GRID\nPOINTS 3 float\n0 0 0\n1 0 0\n0 1 0\nCELLS 1 4\n3 0 1 2\nCELL_TYPES 1\n5\nPOINT_DATA 3\nSCALARS RESPONSE float 1\nLOOKUP_TABLE default\n1 3 5\n");
await fs.writeFile(path.join(workspace,"response.csv"),"Time [s],Measured [N],Predicted [N]\n0,1,1.2\n1,3,2.8\n2,NA,5\n3,7,7.2\n4,9,8.8\n");
await fs.writeFile(path.join(workspace,"surface.csv"),"x [m],y [m],pressure [Pa]\n0,0,0\n1,0,1\n2,0,2\n0,1,1\n1,1,NA\n2,1,3\n0,2,2\n1,2,3\n2,2,4\n");
const password=randomBytes(24).toString("hex"),env={...process.env,PASSWORD:password};delete env.VSCODE_IPC_HOOK_CLI;
const server=spawn(process.env.CODE_SERVER??"/tmp/opencode/code-server-4.140.0-linux-amd64/bin/code-server",["--bind-addr","127.0.0.1:8199","--disable-workspace-trust","--disable-telemetry","--user-data-dir",path.join(base,"user"),"--extensions-dir",path.join(base,"extensions"),workspace],{env,stdio:["ignore","pipe","pipe"]});
const log=await fs.open(path.join(base,"server.log"),"w");server.stdout.on("data",b=>void log.write(b));server.stderr.on("data",b=>void log.write(b));
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??"/home/vicente/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",args:["--no-sandbox","--use-angle=swiftshader","--enable-unsafe-swiftshader"]});
let page;
try {
  page=await browser.newPage({viewport:{width:1600,height:1050}});page.setDefaultTimeout(30000);
  let listening=false;for(let i=0;i<100&&!listening;i++){try{listening=(await fetch("http://127.0.0.1:8199/healthz")).ok;}catch{}if(!listening)await new Promise(resolve=>setTimeout(resolve,200));}assert.ok(listening,"code-server did not start");
  await page.goto(`http://127.0.0.1:8199/?folder=${encodeURIComponent(workspace)}`);
  if(await page.locator('input[type="password"]').count()){await page.locator('input[type="password"]').fill(password);await page.keyboard.press("Enter");}
  await page.locator(".monaco-workbench").waitFor();
  const command=async text=>{await page.locator(".part.titlebar").click({position:{x:20,y:10}});await page.keyboard.press("F1");const input=page.locator(".quick-input-widget input").first();await input.waitFor({state:"visible"});await page.waitForFunction(()=>document.querySelector(".quick-input-widget input")?.value.startsWith(">"));await input.fill(`>${text}`);await page.locator(".quick-input-widget .monaco-list-row").filter({hasText:text}).first().click();};
  const frame=async selector=>{for(let i=0;i<100;i++){for(const f of page.frames())if(await f.locator(selector).count()&&await f.locator(selector).isVisible())return f;await page.waitForTimeout(100);}throw new Error(`Missing webview ${selector}`);};
  const ready=async plot=>{await plot.waitForFunction(()=>document.querySelector("#plot-status")?.textContent.includes("full-resolution points")&&!document.querySelector("#plot-status").textContent.startsWith("Partial"));await plot.waitForFunction(()=>document.querySelector("#plot-chart")?.data?.length>0&&document.querySelector("#plot-chart").getAttribute("aria-busy")!=="true");};
  const screenshots=path.join(root,"doc/public/screenshots");await fs.mkdir(screenshots,{recursive:true});
  await command("Kratos Mesh: Scientific Plot Builder");let plot=await frame("#plot-app");
  await plot.getByRole("button",{name:"Add source",exact:true}).click();await plot.getByLabel("File",{exact:true}).fill(path.join(workspace,"response.csv"));await plot.getByLabel("File",{exact:true}).press("Tab");await plot.getByRole("button",{name:"Inspect source",exact:true}).click();await ready(plot);
  await plot.getByLabel("Title",{exact:true}).fill("Measured force and prediction");await plot.getByLabel("Title",{exact:true}).press("Tab");await ready(plot);
  await plot.getByRole("button",{name:"Add series",exact:true}).click();await ready(plot);
  await plot.getByLabel("Y column",{exact:true}).nth(1).selectOption("c2");await ready(plot);
  await plot.getByLabel("Name",{exact:true}).nth(0).fill("Measured force");await plot.getByLabel("Name",{exact:true}).nth(0).press("Tab");await ready(plot);
  await plot.getByLabel("Name",{exact:true}).nth(1).fill("Prediction");await plot.getByLabel("Name",{exact:true}).nth(1).press("Tab");await ready(plot);
  assert.equal(await plot.evaluate(()=>document.querySelector("#plot-chart").data.length),2);
  await plot.locator("#plot-config").evaluate(e=>e.scrollTop=0);await page.screenshot({path:path.join(screenshots,"plot-builder.png")});
  await command("Preferences: Color Theme");const themeInput=page.locator(".quick-input-widget input").first();await themeInput.fill("Light Modern");await page.waitForTimeout(350);await page.keyboard.press("Enter");await plot.waitForFunction(()=>document.body.classList.contains("vscode-light"));await page.waitForTimeout(500);await page.screenshot({path:path.join(screenshots,"plot-builder-light.png")});
  await command("Preferences: Color Theme");await page.locator(".quick-input-widget input").first().fill("Dark High Contrast");await page.waitForTimeout(350);await page.keyboard.press("Enter");await plot.waitForFunction(()=>document.body.classList.contains("vscode-high-contrast"));await page.waitForTimeout(500);await page.screenshot({path:path.join(screenshots,"plot-builder-contrast.png")});
  await command("Preferences: Color Theme");await page.locator(".quick-input-widget input").first().fill("Dark Modern");await page.waitForTimeout(350);await page.keyboard.press("Enter");await plot.waitForFunction(()=>document.body.classList.contains("vscode-dark"));
  // Use real file-opening and real provider entry points. No injected host messages.
  for(const [file,preview]of[["sample.mdpa","Open MDPA Preview"],["sample.vtk","Open VTK Preview"]]){
    await command("View: Close All Editors");await page.keyboard.press("Control+p");await page.locator(".quick-input-widget input").first().fill(file);await page.waitForTimeout(350);await page.keyboard.press("Enter");await command(preview);const mesh=await frame("#app");await mesh.waitForFunction(()=>document.querySelector("#stats")?.textContent.includes("3"));
    await mesh.locator('[data-action="advanced"]').click();await mesh.locator('[data-action="plots"]').click();plot=await frame("#plot-app");await ready(plot);
    const cols=await plot.getByLabel("Y column",{exact:true}).locator("option").allTextContents();assert.ok(cols.some(v=>v.includes("RESPONSE")),cols.join(" · "));
    assert.equal(await page.locator(".tab.dirty").count(),0,"read-only plotting dirtied a mesh");
  }
  console.log(JSON.stringify({packaged:true,standalone:true,providers:["MDPA","VTK"],themes:["dark","light","high-contrast"],meshDirty:false,screenshots:3},null,2));
} catch(e){if(page){await page.screenshot({path:path.join(base,"failure.png")});await fs.writeFile(path.join(base,"failure.txt"),(await page.locator("body").innerText())+"\nFrames: "+page.frames().map(f=>f.url()).join("\n"));}throw e;}
finally {await browser.close();server.kill("SIGTERM");await log.close();}
