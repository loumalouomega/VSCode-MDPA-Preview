/** Run result discovery/verification over the existing run store. No process
 * management, active-case lookup or implicit adoption of legacy output paths. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { EXECUTION_FILE, parseExecutionReceipt, terminalExecution, type ExecutionReceipt } from "../../problemtype/runReceipt";
import { parseRunJson } from "../../problemtype/runFile";
import { runFilePath } from "../../problemtype/caseFile";
import { plotFileRevision, plotHash, plotSourceIdentity, type PlotSourceIdentity } from "./revision";
import type { PlotRunBinding } from "./types";

export interface PlotRunSummary {
  recordPath: string;
  runId: string;
  ownerId?: string;
  requestId?: string;
  state: string;
  meshPath: string;
  results: string[];
  verifiable: boolean;
  diagnostics: string[];
}
export interface PlotRunDiscovery { runs: PlotRunSummary[]; diagnostics: string[] }
const inside = (root: string, file: string): boolean => {
  const rel = path.relative(root,file);return rel!==".."&&!rel.startsWith(`..${path.sep}`)&&!path.isAbsolute(rel);
};

/** Ignore polling timestamps, but pin every recorded artifact and identity. */
export function plotReceiptRevision(receipt: ExecutionReceipt): string {
  return plotHash(JSON.stringify([
    receipt.version,receipt.requestId,receipt.ownerId,receipt.jobId,receipt.state,receipt.createdAt,
    path.relative(receipt.runDirectory,receipt.meshPath),
    receipt.artifacts.map(a=>[a.role,path.relative(receipt.runDirectory,a.path),a.revision??null,...(a.inventoryRevision?[a.inventoryRevision]:[])]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),
  ]));
}
async function readReceipt(recordPath: string): Promise<ExecutionReceipt> {
  if (path.basename(recordPath)!==EXECUTION_FILE) throw new Error("Run ownership needs an existing isolated-run execution receipt, not a latest-run sidecar.");
  const stat=await fs.stat(recordPath);if(stat.size>8*1024*1024)throw new Error("Run receipt exceeds the 8 MiB import budget.");
  const receipt=parseExecutionReceipt(await fs.readFile(recordPath,"utf8"),path.dirname(recordPath));
  if (!receipt||typeof receipt.jobId!=="string"||!receipt.jobId.trim()||!terminalExecution(receipt)) throw new Error("Run results are unresolved: an observed terminal run and a recorded job ID are required.");
  return receipt;
}
async function assertReceiptSidecar(receipt: ExecutionReceipt):Promise<void> {
  // Archived receipts can stand alone, but an available newer latest-run
  // record is evidence of output-directory reuse, even with identical bytes.
  const file=runFilePath(receipt.meshPath);
  let stat;
  try{stat=await fs.stat(file);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}
  if(stat.size>8*1024*1024)throw new Error("Latest-run record exceeds the import budget.");
  const {sidecar,warnings}=parseRunJson(await fs.readFile(file,"utf8"));
  const expected=receipt.state==="succeeded"?"finished":receipt.state;
  if(!sidecar||warnings.length||sidecar.runId!==receipt.jobId||sidecar.status!==expected||
      sidecar.requestId!==receipt.requestId||sidecar.ownerId!==receipt.ownerId)throw new Error("The latest-run record no longer agrees with the selected isolated receipt; output ownership is unresolved.");
}

/** Export protection is separate from re-evaluation: captured datasets remain
 * exportable after a source changes, but may never replace their run records. */
export async function plotRunInputPaths(binding: PlotRunBinding): Promise<string[]> {
  const recordPath=path.resolve(binding.recordPath);
  try {
    const stat=await fs.stat(recordPath);if(stat.size>8*1024*1024)throw new Error("Run receipt exceeds the import budget.");
    const receipt=parseExecutionReceipt(await fs.readFile(recordPath,"utf8"),path.dirname(recordPath));
    return receipt?[recordPath,runFilePath(receipt.meshPath),receipt.meshPath,...receipt.artifacts.map(a=>a.path)]:[recordPath];
  }catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return [recordPath];throw error;}
}

/** A directory means this directory and its immediate child run directories,
 * not an unbounded workspace scan. Explicit record paths survive reload. */
export async function discoverPlotRuns(paths: string[], signal?: AbortSignal): Promise<PlotRunDiscovery> {
  if (!Array.isArray(paths)||paths.length>64||paths.some(p=>typeof p!=="string"||!p.trim()))throw new Error("Supply at most 64 run-record paths or directories.");
  const records=new Set<string>(),diagnostics:string[]=[],runs:PlotRunSummary[]=[];
  const addRecord=(file:string)=>{
    if(records.size>=256&&!records.has(file))throw new Error("Run discovery exceeds 256 records; choose a narrower directory.");
    records.add(file);
  };
  for (const input of paths) {
    signal?.throwIfAborted();const abs=path.resolve(input);
    try {
      if (!(await fs.stat(abs)).isDirectory()) {addRecord(abs);continue;}
      const entries=await fs.readdir(abs,{withFileTypes:true});
      if(entries.length>2048)throw new Error("Run-directory listing exceeds 2048 entries; choose a specific receipt.");
      for(const e of entries) {
        signal?.throwIfAborted();
        if(e.isFile()&&(e.name===EXECUTION_FILE||e.name.endsWith(".kratosrun.json")))addRecord(path.join(abs,e.name));
        else if(e.isDirectory()) {
          const candidate=path.join(abs,e.name,EXECUTION_FILE);
          if(await fs.stat(candidate).then(s=>s.isFile(),()=>false))addRecord(candidate);
        }
      }
    }catch(e){diagnostics.push(`${abs}: ${e instanceof Error?e.message:String(e)}`);}
  }
  for(const recordPath of records) {
    signal?.throwIfAborted();
    try {
      const stat=await fs.stat(recordPath);if(stat.size>8*1024*1024)throw new Error("Run record exceeds the import budget.");
      const text=await fs.readFile(recordPath,"utf8");
      if(path.basename(recordPath)===EXECUTION_FILE) {
        const receipt=parseExecutionReceipt(text,path.dirname(recordPath));if(!receipt)throw new Error("Invalid or unsupported run receipt.");
        const verifiable=terminalExecution(receipt)&&typeof receipt.jobId==="string"&&!!receipt.jobId.trim();
        runs.push({recordPath,runId:receipt.jobId??receipt.requestId,ownerId:receipt.ownerId,requestId:receipt.requestId,state:receipt.state,meshPath:receipt.meshPath,
          results:[...new Set(receipt.artifacts.filter(a=>a.role==="result").map(a=>a.path))],verifiable,
          diagnostics:[...(receipt.outputFindings??[]),verifiable?"Recorded results must still pass source/companion content verification before binding.":"Live/uncertain execution: no immutable result ownership is claimed."]});
      }else if(recordPath.endsWith(".kratosrun.json")) {
        const {sidecar,warnings}=parseRunJson(text);if(!sidecar)throw new Error(warnings.join(" "));
        runs.push({recordPath,runId:sidecar.runId,ownerId:sidecar.ownerId,requestId:sidecar.requestId,state:sidecar.status,meshPath:sidecar.meshFile,results:[],verifiable:false,
          diagnostics:[...warnings,"Latest-run sidecars do not identify result bytes. Shared/reused output directories require an isolated receipt or explicit ownership resolution; no outputs adopted."]});
      }else throw new Error("Choose .kkss-execution.json, a .kratosrun.json sidecar, or a run directory.");
    }catch(e){diagnostics.push(`${recordPath}: ${e instanceof Error?e.message:String(e)}`);}
  }
  signal?.throwIfAborted();return {runs,diagnostics};
}

async function verifiedSource(receipt: ExecutionReceipt, sourcePath: string, signal?: AbortSignal): Promise<PlotSourceIdentity> {
  const abs=path.resolve(sourcePath),root=await fs.realpath(receipt.runDirectory);
  if(!inside(receipt.runDirectory,abs)||!receipt.artifacts.some(a=>a.role==="result"&&path.resolve(a.path)===abs))throw new Error("This source is not a recorded result of the selected run.");
  const identity=await plotSourceIdentity(abs,signal);
  if (identity.inventoryRevision && receipt.artifacts.filter(a=>a.role==="result"&&path.resolve(a.path)===abs).some(a=>a.inventoryRevision!==identity.inventoryRevision)) {
    throw new Error("Directory-case ownership is stale or unresolved: a matching frozen complete inventoryRevision is required; marker/file hashes alone cannot detect removed dependencies.");
  }
  for(const file of identity.files) {
    const artifacts=receipt.artifacts.filter(a=>["result","result-companion"].includes(a.role)&&path.resolve(a.path)===file.path);
    if(!file.realPath||!inside(root,file.realPath)||!file.revision||!artifacts.length||artifacts.some(a=>a.revision!==file.revision)) {
      throw new Error(`Run result ownership is stale or unresolved: ${file.path} (source/companion revision missing or changed).`);
    }
  }
  const mesh=receipt.artifacts.filter(a=>a.role==="mesh"&&path.resolve(a.path)===path.resolve(receipt.meshPath));
  if(!mesh.length)throw new Error("The run receipt has no source-mesh revision.");
  const source=await plotFileRevision(receipt.meshPath,signal);
  if(!source.realPath||!inside(root,source.realPath)||!source.revision||mesh.some(a=>a.revision!==source.revision))throw new Error("The run's source mesh is missing, changed or outside its isolated workspace.");
  return identity;
}

async function checkedRun(recordPath: string, sourcePath: string, signal?: AbortSignal): Promise<{binding:PlotRunBinding;identity:PlotSourceIdentity}> {
  recordPath=path.resolve(recordPath);
  const receipt=await readReceipt(recordPath),revision=plotReceiptRevision(receipt);
  await assertReceiptSidecar(receipt);
  const identity=await verifiedSource(receipt,sourcePath,signal);
  if(plotReceiptRevision(await readReceipt(recordPath))!==revision)throw new Error("Run receipt changed during verification.");
  await assertReceiptSidecar(receipt);
  return {binding:{recordPath,runId:receipt.jobId!,ownerId:receipt.ownerId,requestId:receipt.requestId,receiptRevision:revision,sourceRevision:identity.revision},identity};
}
export async function bindPlotRun(recordPath: string, sourcePath: string, signal?: AbortSignal): Promise<PlotRunBinding> {
  return (await checkedRun(recordPath,sourcePath,signal)).binding;
}

export async function verifyPlotRun(binding: PlotRunBinding, sourcePath: string, signal?: AbortSignal): Promise<PlotSourceIdentity> {
  const {binding:current,identity}=await checkedRun(binding.recordPath,sourcePath,signal);
  if((Object.keys(current) as (keyof PlotRunBinding)[]).some(key=>current[key]!== (key==="recordPath"?path.resolve(binding[key]):binding[key])))throw new Error("The selected run/source identity changed. Rebind explicitly; matching filenames or entity IDs are not ownership.");
  return identity;
}

export interface PlotTimeCursorRequest {
  path: string;
  run: PlotRunBinding;
  time: number;
  /** Both the requested and supplied times use this explicit unit; no conversion. */
  timeUnit: string;
  times?: number[];
  method: "exact" | "nearest";
  tolerance: number;
}
export interface PlotTimeCursorResult {
  path: string; runId: string; sourceRevision: string; timeUnit: string;
  matched: boolean; frameIndex?: number; time?: number; diagnostics: string[];
}
/** Read-only cursor resolution. It never looks up an active preview or maps an
 * entity between different meshes. Equal-distance nearest matches are refused. */
export async function resolvePlotTimeCursor(request: PlotTimeCursorRequest, signal?: AbortSignal): Promise<PlotTimeCursorResult> {
  if(!Number.isFinite(request.time)||!Number.isFinite(request.tolerance)||request.tolerance<0||!["exact","nearest"].includes(request.method)||!request.timeUnit?.trim())throw new Error("Time cursor needs finite time, a supplied time unit, exact/nearest matching and a nonnegative tolerance.");
  const identity=await verifyPlotRun(request.run,request.path,signal);
  if(!request.times&&identity.timeline!=="inFile")throw new Error("Filename steps/frame indices are not physical time. Supply an explicit physical-time mapping.");
  const times=request.times??identity.steps.map(s=>Number(s.label));
  if(times.length!==identity.steps.length||times.some(v=>!Number.isFinite(v))||times.some((v,i)=>i>0&&v<=times[i-1]))throw new Error("Physical times must be finite, strictly increasing and have one value per available frame.");
  if(!request.times) {
    const model=await identity.steps[0].load(),unit=model.source?.units?.time;
    if(!unit||unit!==request.timeUnit)throw new Error("In-file time unit is unknown or differs from the cursor unit; supply an explicit time mapping in the chosen unit.");
  }
  const candidates=times.map((time,i)=>({time,index:i,distance:Math.abs(time-request.time)})).filter(c=>request.method==="exact"?c.distance===0:c.distance<=request.tolerance).sort((a,b)=>a.distance-b.distance);
  const base={path:path.resolve(request.path),runId:request.run.runId,sourceRevision:identity.revision,timeUnit:request.timeUnit};
  if(!candidates.length)return {...base,matched:false,diagnostics:["No physical time matched within the chosen rule/tolerance; no frame was selected."]};
  if(candidates.length>1) {
    const [a,b]=candidates,roundoff=4*Number.EPSILON*Math.max(Math.abs(request.time),Math.abs(a.time),Math.abs(b.time),a.distance,b.distance);
    if(Math.abs(a.distance-b.distance)<=roundoff)return {...base,matched:false,diagnostics:["Nearest physical-time match is ambiguous (equal distance within floating-point roundoff); no frame was selected."]};
  }
  const selected=candidates[0];
  // A metadata/parser read must not reopen an ownership window.
  await verifyPlotRun(request.run,request.path,signal);
  return {...base,matched:true,frameIndex:identity.steps[selected.index].frameIndex,time:selected.time,diagnostics:["Verified owning run; cursor selects a frame only, not cross-mesh entity correspondence."]};
}
