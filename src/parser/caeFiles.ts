/** Companion discovery for structural mesh directories and MFEM ranks. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { MeshioInputFile } from './meshio';

export const ELMER_MESH_FILE = /^mesh\.(header|nodes|elements|boundary|names)(\.(bin|sbin))?$/;
export const ELMER_PART_FILE = /^part\.\d+\.(header|nodes|elements|boundary|shared)(\.(bin|sbin))?$/;
export const ELMER_PART_DIRECTORY = /^partitioning\.\d+$/;

export async function caeSourcePaths(source: string, elmer: boolean): Promise<{ root: string; names: string[] }> {
  const st = await fs.stat(source).catch(() => undefined);
  const root = st?.isDirectory() ? source : path.dirname(source);
  const names: string[] = [];
  if (elmer) {
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (entry.isFile() && ELMER_MESH_FILE.test(entry.name)) names.push(entry.name);
      if (entry.isDirectory() && ELMER_PART_DIRECTORY.test(entry.name)) {
        for (const part of await fs.readdir(path.join(root, entry.name), { withFileTypes: true })) {
          if (part.isFile() && ELMER_PART_FILE.test(part.name)) names.push(`${entry.name}/${part.name}`);
        }
      }
      if (entry.isFile() && ELMER_PART_FILE.test(entry.name)) names.push(entry.name);
    }
    if (!names.length) throw new Error(`No Elmer mesh files found in ${root}`);
  } else {
    const prefix = path.basename(source).replace(/\d{6}$/, '');
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.startsWith(prefix) && /^\d{6}$/.test(entry.name.slice(prefix.length))) names.push(entry.name);
    }
  }
  return { root, names: names.sort() };
}

export async function collectCaeFiles(source: string, elmer: boolean): Promise<MeshioInputFile[]> {
  const { root, names } = await caeSourcePaths(source, elmer);
  return Promise.all(names.map(async name => ({ name: elmer ? `case/${name}` : name, data: await fs.readFile(path.join(root, name)) })));
}

export async function assertFreshElmerDestination(destination: string): Promise<void> {
  try {
    await fs.stat(destination);
    throw new Error(`Elmer export requires a new destination directory: ${destination}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Elmer export")) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
