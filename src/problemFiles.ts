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
import { meshExtname, meshStem } from "./parser/meshFormats";
import { caseFilePath } from "./problemtype/caseFile";
import { collectOpenFoamCase } from "./parser/openfoamCase";
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
  const stem = meshStem(meshFsPath);

  if (meshExtname(meshFsPath) === ".foam") {
    // An OpenFOAM case lives in a directory whose root is the .foam marker's
    // parent. We collect marker + polyMesh + time dirs + case sidecars instead
    // of refusing.
    const caseDir = path.dirname(meshFsPath);
    const diags: any[] = [];

    const { files: foamFiles, patches } = await collectOpenFoamCase(caseDir, diags);

    // Start with the 0-byte .foam marker itself
    const markerName = path.basename(meshFsPath);
    const files: ZipEntry[] = [{ name: markerName, data: new Uint8Array(0) }];

    // Add polyMesh entries (relative to case root, as they are under
    // constant/polyMesh/ within the case directory)
    for (const f of foamFiles) {
      // f.name is like "constant/polyMesh/points" — keep the relative path
      files.push({ name: f.name, data: f.data });
    }

    // Patch names are recovered from boundary; no extra patch file entries needed
    // (they are encoded via cell_tags on the boundary block on read).

    // Now collect generated case files (case state, ProjectParameters, etc.)
    // alongside the mesh — all under the same case directory.
    const addFromDisk = async (name: string): Promise<boolean> => {
      try {
        const data = await fs.promises.readFile(path.join(caseDir, name));
        files.push({ name, data });
        return true;
      } catch {
        return false; // not generated yet — skip silently
      }
    };

    // Case state and generated files live in the case root
    const caseSidecars = ["ProjectParameters.json", "MainKratos.py", `${stem}_case.mdpa`];
    for (const name of caseSidecars) {
      if (await addFromDisk(name)) {
        // manifest.mesh will be the marker basename below
      }
    }
    // materialsFileNamesFrom will add any further references from ProjectParameters
    try {
      const pp = await fs.promises.readFile(path.join(caseDir, "ProjectParameters.json"), "utf8");
      for (const m of materialsFileNamesFrom(pp)) {
        if (!caseSidecars.includes(m) && isSafeEntryName(m)) {
          await addFromDisk(m);
        }
      }
    } catch {
      /* no ProjectParameters yet */
    }

    // Also add the ops recipe if supplied (same stem logic as non-foam path)
    if (opsJson) {
      const opsName = `${stem}.ops.json`;
      files.push({ name: opsName, data: Buffer.from(opsJson, "utf8") });
    }

    // Manifest: marker is the mesh, patches are informational only (not stored
    // as separate zip entries — they live inside the boundary block on read).
    const manifest: CollectedProblem["manifest"] = {
      mesh: markerName,
      generated: files
        .filter((e) => e.name !== markerName)
        .map((e) => e.name)
        .filter((name, i, arr) => arr.indexOf(name) === i), // dedupe
    };

    return { files, manifest };
  }

  // Non-foam path (original logic, unchanged conceptually)
  const dir = path.dirname(meshFsPath);
  const meshName = path.basename(meshFsPath);

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
