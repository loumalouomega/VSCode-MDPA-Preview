/**
 * Shared (vscode-free) disk collector for problem archives: given a mesh file,
 * gathers everything a "Save problem" bundle contains — the mesh's pristine
 * bytes, the ops recipe handed in by the caller, `<stem>.kratoscase.json` and
 * whichever generated case files exist next to the mesh (ProjectParameters.json,
 * MainKratos.py, `<stem>_case.mdpa`, plus the materials file(s)
 * ProjectParameters references). Used by the File-menu handler
 * (src/problemArchive.ts) and the MCP `problem_pack` tool (src/mcp/tools.ts).
 */

import * as fs from "node:fs";
import { caseFilePath } from "./problemtype/caseFile";
import * as path from "node:path";
import { ZipEntry } from "./parser/zip";
import {
  ProblemManifest,
  isSafeEntryName,
  materialsFileNamesFrom,
} from "./parser/problemZip";

export interface CollectedProblem {
  files: ZipEntry[];
  manifest: Omit<ProblemManifest, "format" | "version">;
}

/**
 * Collects the problem files from disk. `opsJson` is the serialized recipe text
 * (the caller decides its source: the live edit history in the extension, a
 * recipe file for MCP); it is stored as `<stem>.ops.json`. Throws when the mesh
 * itself cannot be read — everything else is optional and skipped silently.
 */
export async function collectProblemFiles(
  meshFsPath: string,
  opsJson?: string
): Promise<CollectedProblem> {
  const dir = path.dirname(meshFsPath);
  const meshName = path.basename(meshFsPath);
  const stem = path.basename(meshFsPath, path.extname(meshFsPath));

  const files: ZipEntry[] = [{ name: meshName, data: await fs.promises.readFile(meshFsPath) }];
  const manifest: CollectedProblem["manifest"] = { mesh: meshName, generated: [] };

  if (opsJson) {
    const opsName = `${stem}.ops.json`;
    files.push({ name: opsName, data: Buffer.from(opsJson, "utf8") });
    manifest.ops = opsName;
  }

  const addFromDisk = async (name: string): Promise<boolean> => {
    try {
      const data = await fs.promises.readFile(path.join(dir, name));
      files.push({ name, data });
      return true;
    } catch {
      return false; // not generated yet — skip silently
    }
  };

  const caseName = path.basename(caseFilePath(meshFsPath));
  if (await addFromDisk(caseName)) manifest.case = caseName;

  // Generated case files: the fixed names plus whatever materials file(s)
  // ProjectParameters.json references (problemtype-specific names).
  const generated = ["ProjectParameters.json", "MainKratos.py", `${stem}_case.mdpa`];
  try {
    const pp = await fs.promises.readFile(path.join(dir, "ProjectParameters.json"), "utf8");
    for (const m of materialsFileNamesFrom(pp)) {
      if (!generated.includes(m) && isSafeEntryName(m)) generated.push(m);
    }
  } catch {
    /* no generated case yet */
  }
  for (const name of generated) {
    if (await addFromDisk(name)) manifest.generated.push(name);
  }

  return { files, manifest };
}
