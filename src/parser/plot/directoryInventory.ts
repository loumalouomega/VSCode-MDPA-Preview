/** Bounded, conservative inventories for case-directory plotting sources. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isOpenFoamTimeName, OPENFOAM_REQUIRED_FILES } from "../openfoamCase";
import { ELMER_MESH_FILE, ELMER_PART_FILE, ELMER_PART_DIRECTORY } from "../caeFiles";
import { meshExtname } from "../meshFormats";

export interface PlotDirectoryInventory { files: string[]; directories: string[] }
export const PLOT_INVENTORY_ENTRIES = 50000;
export const PLOT_INVENTORY_DEPTH = 20;

export function plotDirectorySource(source: string): boolean {
  return [".foam", ".elmer", ".mfem-rank"].includes(meshExtname(source));
}

/** Enumerate only inputs the Elmer/MFEM collectors stage, but never silently
 * drop a linked dependency. Partition directories are included conservatively. */
export async function plotCaeInventory(source: string, signal?: AbortSignal): Promise<PlotDirectoryInventory> {
  const abs = path.resolve(source), root = path.dirname(abs), elmer = meshExtname(abs) === ".elmer";
  const prefix = path.basename(abs).replace(/\d{6}$/, "");
  const files: string[] = [], directories: string[] = [];
  let entries = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    signal?.throwIfAborted();
    if (depth > PLOT_INVENTORY_DEPTH) throw new Error("Case inventory exceeds 20 directory levels.");
    if (depth) directories.push(dir);
    const listing = await fs.opendir(dir);
    for await (const entry of listing) {
      signal?.throwIfAborted();
      if (++entries > PLOT_INVENTORY_ENTRIES) throw new Error("Case inventory exceeds 50000 entries; ownership is unresolved.");
      const selected = depth || (elmer
        ? ELMER_MESH_FILE.test(entry.name) || ELMER_PART_FILE.test(entry.name) || ELMER_PART_DIRECTORY.test(entry.name)
        : entry.name.startsWith(prefix) && /^\d{6}$/.test(entry.name.slice(prefix.length)));
      if (!selected) continue;
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Case inventory refuses symlinked dependencies: ${file}`);
      if (entry.isDirectory() && (depth || elmer && ELMER_PART_DIRECTORY.test(entry.name))) await walk(file, depth + 1);
      else if (entry.isFile()) files.push(file);
      else throw new Error(`Case inventory refuses a non-regular dependency: ${file}`);
    }
  };
  await walk(root, 0);
  if (!files.length) throw new Error("Marker-only or incomplete case inventory: no Elmer/MFEM mesh files found.");
  return { files: files.sort(), directories: directories.sort() };
}

export function plotDirectoryInventory(source: string, signal?: AbortSignal): Promise<PlotDirectoryInventory> {
  return meshExtname(source) === ".foam" ? plotOpenFoamInventory(source, signal) : plotCaeInventory(source, signal);
}

/** Includes entire constant/system/time/processor trees, not just whichever
 * region happens to be selected. Unread fields still participate in identity;
 * inventory coverage is not a claim that the reader reconstructs them. */
export async function plotOpenFoamInventory(marker: string, signal?: AbortSignal): Promise<PlotDirectoryInventory> {
  const root = path.dirname(path.resolve(marker)), files: string[] = [], directories: string[] = [];
  let entries = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    signal?.throwIfAborted();
    if(depth > PLOT_INVENTORY_DEPTH)throw new Error("OpenFOAM case inventory exceeds 20 directory levels.");
    if(depth)directories.push(dir);
    const listing = await fs.opendir(dir);
    for await(const entry of listing){
      signal?.throwIfAborted();
      if(++entries > PLOT_INVENTORY_ENTRIES)throw new Error("OpenFOAM case inventory exceeds 50000 entries; ownership is unresolved.");
      if(!depth && !["constant","system"].includes(entry.name) && !/^processor\d+$/.test(entry.name) && !isOpenFoamTimeName(entry.name))continue;
      const file = path.join(dir,entry.name);
      // The staging collectors do not reliably follow symlinks. Neither hiding
      // a linked dependency nor following one outside the receipt is ownership.
      if(entry.isSymbolicLink())throw new Error(`OpenFOAM case inventory refuses symlinked dependencies: ${file}`);
      if(entry.isDirectory())await walk(file,depth+1);
      else if(entry.isFile())files.push(file);
      else throw new Error(`OpenFOAM case inventory refuses a non-regular dependency: ${file}`);
    }
  };
  await walk(root,0);
  // Moving-mesh overlays can be partial. Baseline meshes in constant cannot;
  // validate each region/processor, not a union assembled from unrelated trees.
  const meshes = directories.filter(dir => /(?:^|[\\/])constant(?:[\\/][^\\/]+)?[\\/]polyMesh$/.test(dir));
  if (!meshes.length) throw new Error("OpenFOAM marker-only or incomplete case inventory: no constant/polyMesh baseline.");
  const supplied = new Set(files);
  for (const dir of meshes) for (const name of OPENFOAM_REQUIRED_FILES) {
    if (!supplied.has(path.join(dir, name)) && !supplied.has(path.join(dir, name + ".gz"))) throw new Error(`OpenFOAM incomplete case inventory: missing ${path.join(dir, name)}.`);
  }
  return {files:files.sort(),directories:directories.sort()};
}
