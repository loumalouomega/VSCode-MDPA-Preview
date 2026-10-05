/** Content identities for disk extractions. Never infer a run from a pathname. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { discoverSeriesSteps } from "../fieldSeriesScan";
import { meshCompanionNames } from "../meshFileParser";
import { meshExtname, TIMELINE_EXTENSIONS } from "../meshFormats";
import { fileFor, findGroupForFile, groupVtkFiles } from "../vtkFileGroup";
import { parseVtmIndex } from "../vtkMultiblock";
import type { SeriesStep } from "../fieldSeries";
import { plotDirectoryInventory, plotDirectorySource } from "./directoryInventory";

export const plotHash = (value: string | Uint8Array): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
export interface PlotFileRevision { path: string; realPath?: string; revision?: string; bytes: number }
export interface PlotSourceIdentity {
  revision: string;
  files: PlotFileRevision[];
  steps: SeriesStep[];
  timeline: "files" | "inFile" | "single";
  /** Portable complete directory-case closure, frozen by the existing receipt. */
  inventoryRevision?: string;
}

/** Streaming hash, with a change-during-read check and cooperative cancellation. */
export async function plotFileRevision(file: string, signal?: AbortSignal): Promise<PlotFileRevision> {
  signal?.throwIfAborted();
  let handle;
  try { handle = await fs.open(file, "r"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {path:file,bytes:0};
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`Cannot fingerprint a non-file: ${file}`);
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
    let count: number;
    while ((count = (await handle.read(buffer, 0, buffer.length, null)).bytesRead) > 0) {
      signal?.throwIfAborted(); hash.update(buffer.subarray(0,count));
    }
    const after = await handle.stat(), named = await fs.stat(file);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        before.ino !== named.ino || after.size !== named.size || after.ctimeMs !== named.ctimeMs) {
      throw new Error(`Source changed while its revision was being checked: ${file}`);
    }
    return {path:file,realPath:await fs.realpath(file),bytes:after.size,revision:`sha256:${hash.digest("hex")}`};
  } finally { await handle.close(); }
}

/** Enumerate exactly the selected rank's root/subpart files and recursive index
 * companions and conservative OpenFOAM case trees. No marker-only identity. */
export async function plotSourceIdentity(sourcePath: string, signal?: AbortSignal): Promise<PlotSourceIdentity> {
  const abs = path.resolve(sourcePath);
  signal?.throwIfAborted();
  const caseInventory = plotDirectorySource(abs) ? await plotDirectoryInventory(abs,signal) : undefined;
  const discovered = await discoverSeriesSteps(abs);
  if (discovered.steps.length > 5000) throw new Error("Histories are limited to 5000 frames.");
  const roots = new Set([abs,...(caseInventory?.files??[])]);
  if (discovered.source === "files") {
    const dir = path.dirname(abs), names = await fs.readdir(dir);
    const found = findGroupForFile(groupVtkFiles(names,TIMELINE_EXTENSIONS),path.basename(abs));
    if (!found) throw new Error("Source timeline changed during discovery.");
    // Include all frames even for a fixed extraction: timeline replacement and
    // additions cannot silently reuse a formerly valid navigation identity.
    for (const label of found.group.steps) for (const prefix of [found.group.rootPrefix,...found.group.subParts.map(p=>`${found.group.rootPrefix}_${p}`)]) {
      const file = fileFor(found.group,prefix,found.rank,label);
      if (file) roots.add(path.join(dir,file));
    }
  }
  const files = new Map<string,PlotFileRevision>();
  const visit = async (file: string, depth = 0): Promise<void> => {
    file = path.resolve(file);
    if (files.has(file)) return;
    if (depth > 20 || files.size >= 50000) throw new Error("Result companion inventory exceeds the ownership budget.");
    const ext = meshExtname(file), stat = await fs.stat(file).catch(error=>{
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    });
    if (stat?.isDirectory()) throw new Error("This directory source has no supported plotting inventory contract; choose its mesh entrypoint.");
    if (!caseInventory && plotDirectorySource(file)) throw new Error("Directory-case companions require their own complete inventory receipt.");
    const fingerprint = await plotFileRevision(file,signal);files.set(file,fingerprint);
    if (!fingerprint.revision) return;
    let text: string | undefined;
    if ([".xdmf",".xmf",".pvd",".pvtu",".pvtp",".vtm"].includes(ext)) {
      if (fingerprint.bytes > 4*1024*1024) throw new Error("Result index exceeds the 4 MiB companion-inventory budget; ownership is unresolved.");
      text = await fs.readFile(file,"utf8");
      if (plotHash(text) !== fingerprint.revision) throw new Error("Result index changed during companion discovery.");
    }
    const companions = caseInventory ? [] : ext === ".vtm" ? parseVtmIndex(Buffer.from(text!)).map(e=>e.file) : meshCompanionNames(path.basename(file),ext,text);
    for (const name of companions) await visit(path.resolve(path.dirname(file),name),depth+1);
  };
  for (const file of roots) await visit(file);
  if(caseInventory && JSON.stringify(await plotDirectoryInventory(abs,signal))!==JSON.stringify(caseInventory))throw new Error("Case inventory changed during content verification.");
  signal?.throwIfAborted();
  const inventory = [...files.values()].sort((a,b)=>a.path.localeCompare(b.path));
  const base = path.dirname(abs);
  const relative = (file: string): string => path.relative(base,file).split(path.sep).join("/");
  const closureFiles = inventory.map(f=>[relative(f.path),f.bytes,f.revision??null]);
  closureFiles.sort((a,b)=>JSON.stringify(a)<JSON.stringify(b)?-1:JSON.stringify(a)>JSON.stringify(b)?1:0);
  const inventoryRevision = caseInventory ? plotHash(JSON.stringify([
    1, meshExtname(abs), path.basename(abs), discovered.source, discovered.steps.map(s=>[s.label,s.frameIndex]),
    closureFiles,caseInventory.directories.map(relative).sort(),
  ])) : undefined;
  return {files:inventory,steps:discovered.steps,timeline:discovered.source,...(inventoryRevision?{inventoryRevision}:{}),revision:plotHash(JSON.stringify([
    abs,discovered.source,discovered.steps.map(s=>[s.label,s.frameIndex]),inventory,...(caseInventory?[caseInventory.directories]:[]),
  ]))};
}
