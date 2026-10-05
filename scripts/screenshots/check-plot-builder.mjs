// Actual plotting bundle + actual CSP; host delivery only is simulated.
// Run after compile + build:tests. PLAYWRIGHT_MODULE points to an external playwright-core install.
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const require=createRequire(import.meta.url),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const {chromium}=require(process.env.PLAYWRIGHT_MODULE??"playwright-core");
const {plotHtml}=require(path.join(root,"out/parser/plot/html.js"));
const {evaluatePlot,displayPlot}=require(path.join(root,"out/parser/plot/numerics.js"));
const {parsePlotTable}=require(path.join(root,"out/parser/plot/importTable.js"));
const {emptyPlotRecipe}=require(path.join(root,"out/parser/plot/recipe.js"));
const dir="/tmp/opencode/plot-check";await fs.mkdir(dir,{recursive:true});
const html=plotHtml(`file://${root}/media/plots.js`,`file://${root}/media/plotly/plotly.min.js`,`file://${root}/media/design-system.css`,`file://${root}/media/plots.css`,"plot-test-nonce","file:");
await fs.writeFile(path.join(dir,"index.html"),html);
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??"/home/vicente/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",args:["--no-sandbox"]});
try {
  const page=await browser.newPage({viewport:{width:1400,height:950}}),errors=[],violations=[],images=[],network=[];
  page.on("pageerror",e=>errors.push(e.message));
  page.on("request",r=>{if(/^https?:/.test(r.url()))network.push(r.url());});
  await page.exposeFunction("__csp",v=>violations.push(v));
  const table=parsePlotTable("Time [s],Response [N],Other [N]\n0,1,2\n1,3,3\n2,NA,4\n3,7,5\n4,9,6\n");
  let r={...emptyPlotRecipe({id:"a",type:"inline",table}),series:[{id:"s",source:"a",name:"Measured response",x:"c0",y:"c1",color:"#4e9af1"}],presentation:{family:"line",title:"Scientific plotting — offline",panels:1}};
  await page.exposeFunction("__plotHost",async msg=>{
    if(msg.type==="plotReady")return {type:"plotRecipe",recipe:r};
    if(msg.type==="plotPreview")return {type:"plotSourcePreview",requestId:msg.requestId,source:msg.source,columns:msg.source.table.columns,rows:msg.source.table.rows.slice(0,12),rowCount:msg.source.table.rows.length,diagnostics:[]};
    if(msg.type==="plotEvaluate")return {type:"plotResult",requestId:msg.requestId,dataset:displayPlot(evaluatePlot(msg.recipe,Object.fromEntries(msg.recipe.sources.map(s=>[s.id,s.table]))))};
    if(msg.type==="plotExportImage"){images.push(msg);return {type:"plotNotice",message:"Image captured"};}
    return null;
  });
  await page.addInitScript(()=>{
    window.acquireVsCodeApi=()=>({postMessage:msg=>window.__plotHost(msg).then(reply=>{if(reply)window.dispatchEvent(new MessageEvent("message",{data:reply}));}),getState:()=>undefined,setState:()=>{}});
    document.addEventListener("securitypolicyviolation",e=>window.__csp(`${e.violatedDirective}: ${e.blockedURI}`));
  });
  await page.goto(`file://${dir}/index.html`);
  await page.waitForFunction(()=>document.querySelector("#plot-chart")?.data?.length===1);
  const families=["line","step","area","scatter","bubble","bar","pie","doughnut","histogram","box","heatmap","contour"];
  const ready=async()=>{await page.waitForFunction(()=>document.querySelector("#plot-status").textContent.includes("full-resolution points")&&document.querySelector("#plot-chart")?.data?.length>0&&document.querySelector("#plot-chart").getAttribute("aria-busy")!=="true");};
  for(const family of families){
    const data=["pie","doughnut","bar"].includes(family)?parsePlotTable("Category,Load [N]\nA,1\nA,2\nB,3\nEmpty,NA\nZero,0\n"):table;
    r={...r,sources:[{id:"a",type:"inline",table:data}],series:[{id:"s",source:"a",name:"Measured response",x:"c0",y:"c1",...(family==="bubble"?{size:"c2"}:{}),...(["pie","doughnut","bar"].includes(family)?{statistic:"sum"}:{})}],presentation:{family,title:"Scientific plotting — offline",panels:1}};
    if(family==="heatmap"||family==="contour"){
      const grid=parsePlotTable("x [m],y [m],z [Pa]\n0,0,0\n1,0,1\n2,0,2\n0,1,1\n1,1,NA\n2,1,3\n0,2,2\n1,2,3\n2,2,4\n");
      r={...r,sources:[{id:"a",type:"inline",table:grid}],series:[{id:"s",source:"a",name:"Pressure surface",x:"c0",y:"c1",z:"c2",grid:{method:"regular"}}],presentation:{...r.presentation,family}};
    }
    await page.evaluate(recipe=>window.dispatchEvent(new MessageEvent("message",{data:{type:"plotRecipe",recipe}})),r);
    const type=["line","step","area","scatter","bubble"].includes(family)?"scatter":family==="histogram"?"bar":family==="doughnut"?"pie":family;
    await page.waitForFunction(type=>document.querySelector("#plot-chart")?.data?.[0]?.type===type,type);
    await page.waitForFunction(()=>document.querySelector("#plot-chart").getAttribute("aria-busy")!=="true");
    for(const format of ["svg","png"]){const count=images.length;await page.getByRole("button",{name:format.toUpperCase(),exact:true}).click();await page.waitForFunction(()=>document.querySelector("#plot-status").textContent==="Image captured");assert.equal(images.length,count+1);const data=images.at(-1).data,comma=data.indexOf(","),bytes=data.slice(0,comma).includes(";base64")?Buffer.from(data.slice(comma+1),"base64"):Buffer.from(decodeURIComponent(data.slice(comma+1)));await fs.writeFile(`${dir}/${family}.${format}`,bytes);if(format==="svg")assert.match(bytes.toString(),/Scientific plotting/);else assert.equal(bytes.subarray(1,4).toString(),"PNG");await page.evaluate(()=>document.querySelector("#plot-status").textContent="Ready");}
    if(family==="area"){assert.equal(await page.evaluate(()=>document.querySelector("#plot-chart").data.length),2);assert.deepEqual(await page.evaluate(()=>document.querySelector("#plot-chart").data.map(t=>t.x)),[[0,1],[3,4]]);}
    if(family==="scatter"||family==="bubble")assert.equal(await page.evaluate(()=>document.querySelector("#plot-chart").data[0].mode),"markers");
    if(family==="pie"||family==="doughnut"){assert.equal(await page.locator("#plot-chart .slice").count(),2);assert.equal(await page.evaluate(()=>Array.isArray(document.querySelector("#plot-chart")._fullData[0].insidetextfont.color)),true,"Per-slice theme contrast colors must reach the renderer");}
  }
  // Visible picker + keyboard, styles, responsive layout and per-series mappings.
  r={...r,sources:[{id:"a",type:"inline",table}],series:[{id:"s",source:"a",name:"Measured response",x:"c0",y:"c1"}],presentation:{family:"line",title:"Scientific plotting — offline"}};
  await page.evaluate(recipe=>window.dispatchEvent(new MessageEvent("message",{data:{type:"plotRecipe",recipe}})),r);await ready();
  await page.getByLabel("Drawing",{exact:true}).selectOption("lines");await ready();assert.equal(await page.evaluate(()=>document.querySelector("#plot-chart").data[0].mode),"lines");
  await page.getByRole("button",{name:"Chart type",exact:true}).click();await page.keyboard.press("ArrowRight");await page.keyboard.press("ArrowRight");await page.keyboard.press("ArrowRight");await page.keyboard.press("Enter");await ready();assert.equal(await page.evaluate(()=>document.querySelector("#plot-chart").data[0].mode),"markers");
  await page.getByRole("button",{name:"Chart type",exact:true}).click();await page.keyboard.press("Escape");assert.equal(await page.getByRole("button",{name:"Chart type",exact:true}).getAttribute("aria-expanded"),"false");
  await page.getByRole("button",{name:"Chart type",exact:true}).click();await page.getByRole("button",{name:"Bubble",exact:true}).click();await page.waitForFunction(()=>document.querySelector("#plot-status").textContent.startsWith("Partial"));
  await page.getByLabel("Size · Measured response",{exact:true}).selectOption("c2");await ready();assert.equal(await page.evaluate(()=>document.querySelector("#plot-chart").data[0].marker.sizemode),"area");
  await page.getByText("Plotted samples — keyboard-accessible table",{exact:true}).click();await page.getByRole("columnheader",{name:"Size (supplied)",exact:true}).waitFor();await page.getByText("Plotted samples — keyboard-accessible table",{exact:true}).click();
  await page.getByRole("button",{name:"Chart type",exact:true}).click();await page.getByRole("button",{name:"Bars",exact:true}).click();await ready();
  await page.getByLabel("Arrangement",{exact:true}).selectOption("stack");await page.getByLabel("Orientation",{exact:true}).selectOption("h");await ready();assert.equal(await page.evaluate(()=>document.querySelector("#plot-chart").data[0].orientation),"h");assert.equal(await page.evaluate(()=>document.querySelector("#plot-chart").layout.barmode),"relative");
  await page.getByRole("button",{name:"Chart type",exact:true}).click();await page.getByRole("button",{name:"Pie",exact:true}).click();await page.waitForFunction(()=>document.querySelector("#plot-status").textContent.startsWith("Partial"));
  await page.getByLabel("Statistic · Measured response",{exact:true}).selectOption("sum");await ready();assert.deepEqual(await page.evaluate(()=>document.querySelector("#plot-chart").data[0].values),[1,3,7,9]);
  await page.getByText("Plotted samples — keyboard-accessible table",{exact:true}).click();await page.getByRole("columnheader",{name:"Covered share (%)",exact:true}).waitFor();await page.getByText("Plotted samples — keyboard-accessible table",{exact:true}).click();
  await page.setViewportSize({width:420,height:850});await page.getByRole("button",{name:"Chart type",exact:true}).click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,"Narrow plotting workspace overflows horizontally");await page.screenshot({path:`${dir}/picker-narrow.png`});await page.keyboard.press("Escape");await page.setViewportSize({width:1400,height:950});
  const large={columns:table.columns.slice(0,2),rows:Array.from({length:100000},(_,i)=>[i,Math.sin(i/100)]),diagnostics:[]};
  const start=performance.now(),full=evaluatePlot({...r,sources:[{id:"a",type:"inline",table:large}],series:[{id:"s",source:"a",name:"100k samples",x:"c0",y:"c1"}],presentation:{family:"line",title:"Large dataset"}},{a:large}),sampled=displayPlot(full);
  const numericMs=performance.now()-start;const renderStart=performance.now();
  await page.evaluate(recipe=>window.dispatchEvent(new MessageEvent("message",{data:{type:"plotRecipe",recipe}})),full.recipe);
  await page.waitForFunction(()=>document.querySelector("#plot-status").textContent.startsWith("100000 full-resolution points"));
  await page.waitForFunction(()=>document.querySelector("#plot-chart")?.data?.[0]?.name==="100k samples"&&document.querySelector("#plot-chart").getAttribute("aria-busy")!=="true");
  const renderMs=performance.now()-renderStart;
  await page.evaluate(dataset=>window.dispatchEvent(new MessageEvent("message",{data:{type:"plotResult",requestId:999,dataset}})),sampled); // must be ignored as stale
  assert.equal(await page.evaluate(()=>document.querySelector("#plot-chart").data[0].name),"100k samples");
  await page.evaluate(()=>{const b=document.querySelector("#plot-chart");b.style.setProperty("--vscode-editor-background","#fff");});
  assert.equal(errors.length,0,errors.join("\n"));assert.equal(violations.length,0,violations.join("\n"));
  assert.deepEqual(network,[]);
  console.log(JSON.stringify({families:families.length,exports:images.length,visualPicker:true,keyboardPicker:true,narrowPane:true,explicitMappings:true,lineOnly:true,horizontalStacks:true,pageErrors:errors,cspViolations:violations,networkRequests:network,large:{inputRows:100000,numericMs,renderMs,displayPoints:sampled.displayCount},bundleBytes:(await fs.stat(path.join(root,"media/plotly/plotly.min.js"))).size},null,2));
} finally {await browser.close();}
