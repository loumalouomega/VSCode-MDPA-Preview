/**
 * Format dispatcher: routes a mesh file to the right parser by extension and
 * returns the universal MdpaModel.  Pure Node module (fs only).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { MdpaModel } from "./types";
import { parseVtkFile, parseVtkLegacyBinary } from "./vtkLegacyParser";
import { parseStl } from "./stlParser";
import { parseObj } from "./objParser";
import { parsePly } from "./plyParser";
import { parseVtkXml } from "./vtkXmlParser";
import { parseVtm } from "./vtkMultiblock";
import {
  SUPPORTED_MESH_EXTENSIONS,
  VTK_XML_EXTENSIONS,
} from "./meshFormats";
import { isMeshioReadExtension, meshioSiblingNames } from "./meshioFormats";
import { MeshioInputFile, readMeshioModel } from "./meshio";

export type ProgressCallback = (
  phase: "read",
  bytesRead: number,
  totalBytes: number
) => void;

/** Reads a whole file into a Buffer, reporting progress per chunk. */
export async function readFileWithProgress(
  fsPath: string,
  onProgress?: ProgressCallback
): Promise<Buffer> {
  const stat = await fs.promises.stat(fsPath);
  const totalBytes = stat.size;
  const chunks: Buffer[] = [];
  let bytesRead = 0;

  return new Promise<Buffer>((resolve, reject) => {
    const stream = fs.createReadStream(fsPath);
    stream.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buf);
      bytesRead += buf.length;
      onProgress?.("read", bytesRead, totalBytes);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/** Sniffs the legacy-VTK format line (3rd non-empty line) for "BINARY". */
async function isBinaryLegacyVtk(fsPath: string): Promise<boolean> {
  const fd = await fs.promises.open(fsPath, "r");
  try {
    const head = Buffer.alloc(256);
    const { bytesRead } = await fd.read(head, 0, 256, 0);
    const lines = head
      .subarray(0, bytesRead)
      .toString("latin1")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l);
    return lines[2]?.toUpperCase() === "BINARY";
  } finally {
    await fd.close();
  }
}

export interface ParseMeshOptions {
  /**
   * Force a meshio++ format key (e.g. "ansys", "freefem", "ansysinp") instead
   * of inferring it from the extension.  Ignored by the native parsers.
   */
  meshioFormat?: string;
}

/**
 * Parses any supported mesh file into an MdpaModel: the native parsers for
 * .vtk / VTK XML / .vtm / .stl / .obj / .ply, and meshio++ for the extended
 * formats (.msh, .inp, .unv, …).  Throws a descriptive Error for unsupported
 * extensions or malformed files.
 */
export async function parseMeshFile(
  fsPath: string,
  onProgress?: ProgressCallback,
  opts?: ParseMeshOptions
): Promise<MdpaModel> {
  const ext = path.extname(fsPath).toLowerCase();

  if ((VTK_XML_EXTENSIONS as readonly string[]).includes(ext)) {
    return parseVtkXml(await readFileWithProgress(fsPath, onProgress));
  }

  switch (ext) {
    case ".vtk":
      if (await isBinaryLegacyVtk(fsPath)) {
        return parseVtkLegacyBinary(await readFileWithProgress(fsPath, onProgress));
      }
      return parseVtkFile(fsPath, onProgress);
    case ".vtm":
      return parseVtm(fsPath, (childPath) => parseMeshFile(childPath));
    case ".stl":
      return parseStl(await readFileWithProgress(fsPath, onProgress));
    case ".obj":
      return parseObj((await readFileWithProgress(fsPath, onProgress)).toString("utf8"));
    case ".ply":
      return parsePly(await readFileWithProgress(fsPath, onProgress));
    default: {
      // Everything above is ours and stays authoritative; meshio++ only
      // handles extensions we have no parser for.
      if (isMeshioReadExtension(ext)) {
        const name = path.basename(fsPath);
        const files: MeshioInputFile[] = [
          { name, data: await readFileWithProgress(fsPath, onProgress) },
        ];
        // tetgen always reads the .node/.ele pair, whichever half was opened.
        for (const sibling of meshioSiblingNames(name, ext)) {
          if (sibling === name) continue;
          try {
            files.push({
              name: sibling,
              data: await fs.promises.readFile(path.join(path.dirname(fsPath), sibling)),
            });
          } catch {
            // Missing sibling: let meshio++ report it with a real message.
          }
        }
        return readMeshioModel(name, files, ext, opts?.meshioFormat);
      }
      throw new Error(
        `Unsupported mesh file extension "${ext}" (supported: ${SUPPORTED_MESH_EXTENSIONS.join(", ")}).`
      );
    }
  }
}
