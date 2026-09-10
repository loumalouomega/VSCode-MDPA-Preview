/**
 * Format dispatcher: routes a mesh file to the right parser by extension and
 * returns the universal MdpaModel.  Pure Node module (fs only).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { MdpaDiagnostic, MdpaModel } from "./types";
import { parseVtkFile, parseVtkLegacyBinary } from "./vtkLegacyParser";
import { parseStl } from "./stlParser";
import { parseObj } from "./objParser";
import { parsePly } from "./plyParser";
import { parseVtkXml } from "./vtkXmlParser";
import { parseVtm } from "./vtkMultiblock";
import {
  meshExtname,
  SUPPORTED_MESH_EXTENSIONS,
  VTK_XML_EXTENSIONS,
} from "./meshFormats";
import { isMeshioReadExtension, meshioSiblingNames } from "./meshioFormats";
import { isSafeEntryName } from "./problemZip";
import {
  applyOpenFoamPatches,
  augmentMeshioWithFoamFields,
  collectOpenFoamCase,
  foamBoundaryFields,
  listOpenFoamTimeFieldNames,
  listOpenFoamTimes,
  openFoamCaseDir,
  openFoamCaseSize,
  openFoamCaseStamp,
  OpenFoamPatch,
  readFoamFile,
} from "./openfoamCase";
import { parseFoamField, OpenFoamParsedField } from "./openfoamFields";
import { MeshioInputFile, MeshioMetadata, readMeshioMetadata, readMeshioModel, readMeshioTimeValues } from "./meshio";

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

/**
 * The external data files an XDMF's `<DataItem>`s reference.
 *
 * XDMF keeps its heavy arrays outside the XML whenever `Format` is `HDF`
 * (`beam.h5:/data0`) or `Binary` (`beam0.bin`) — the HDF variant being what
 * ParaView writes by default, and what meshio++ has written since 8.0.0.  The
 * reader opens those by the name in the XML, so they must be placed in the
 * virtual filesystem alongside it or the read fails on a missing file.
 *
 * Returns de-duplicated relative paths.  A reference into a subdirectory
 * (`data/beam.h5`, which ParaView writes) used to be SKIPPED here because the
 * virtual filesystem this feeds was flat — so such an XDMF silently lost its
 * heavy data and failed to open.  Staging is directory-capable now, so the
 * reference is kept and only `isSafeEntryName` guards it, which is what stops a
 * crafted `../../etc/passwd` being read off the user's disk.
 */
export function xdmfDataFiles(xml: string): string[] {
  const out = new Set<string>();
  for (const m of xml.matchAll(/<DataItem\b([^>]*)>([\s\S]*?)<\/DataItem>/gi)) {
    const format = /\bFormat\s*=\s*"([^"]*)"/i.exec(m[1])?.[1]?.toLowerCase();
    if (format !== "hdf" && format !== "binary") continue;
    // "file.h5:/group/data" for HDF, a bare "file.bin" for Binary.
    const body = m[2].trim();
    if (!body) continue;
    const ref = format === "hdf" ? body.slice(0, body.lastIndexOf(":")) : body;
    const name = ref.trim();
    if (!name || !isSafeEntryName(name)) continue;
    out.add(name);
  }
  return [...out];
}

/**
 * The time values of a transient XDMF, read from the light XML alone.
 *
 * meshio++ CAN select a step of an XDMF (`readMeshSelective`'s `timeStep`
 * works, contrary to its own `.d.ts`, which still says "currently exodus"),
 * but its `readMetadata(...).timeValues` comes back EMPTY for a temporal
 * collection and reports `fellBackToFullRead` — so upstream cannot say how
 * many steps there are without reading the whole file, which is exactly what
 * `IN_FILE_TIMELINE_EXTENSIONS` exists to avoid.
 *
 * It does not have to: XDMF splits light from heavy, so the `.xdmf` is a few
 * kilobytes of XML naming one `<Time Value="…"/>` per step while the arrays sit
 * in the sibling `.h5`.  Reading it here is the same regex-on-the-XML this file
 * already does for `xdmfDataFiles`, and it makes the step count knowable before
 * a step is read — the list's stated gate, met on our terms rather than
 * upstream's.
 *
 * Returns `[]` for a single-grid XDMF (no `<Time>` at all), which is the honest
 * answer: that file is one static frame.
 */
export function xdmfTimeValues(xml: string): number[] {
  const out: number[] = [];
  for (const m of xml.matchAll(/<Time\b[^>]*\bValue\s*=\s*"([^"]*)"/gi)) {
    const v = Number(m[1].trim());
    // A non-numeric or absent Value is not a step we could ever request.
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

/**
 * Sniffs the legacy-VTK format line (3rd non-empty line) for "BINARY".
 * Exported for `meshSummary.ts`, which picks its scanner the same way.
 */
export async function isBinaryLegacyVtk(fsPath: string): Promise<boolean> {
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
  /**
   * Selects a step of a multi-step mesh (Exodus via meshio++ >= 8.6.0, GiD
   * postprocess, XDMF, OpenFOAM time directories). 0 is the first step,
   * negative counts back from the last. Ignored by every parser without a
   * time concept.
   */
  timeStep?: number;
}

/**
 * Reads one OpenFOAM time directory's field files (plain or `.gz`),
 * de-duplicated by base name so `U` + `U.gz` do not parse twice. A bad file
 * is a diagnostic, never a throw — the geometry still opens.
 */
export function readOpenFoamTimeFields(
  caseDir: string,
  timeName: string,
  diagnostics: MdpaDiagnostic[]
): OpenFoamParsedField[] {
  const out: OpenFoamParsedField[] = [];
  const names = listOpenFoamTimeFieldNames(caseDir, timeName);
  const seen = new Set<string>();
  const bases: string[] = [];
  for (const n of names) {
    const base = n.endsWith(".gz") ? n.slice(0, -3) : n;
    if (seen.has(base)) continue;
    seen.add(base);
    bases.push(base);
  }
  bases.sort();
  for (const base of bases) {
    // polyMesh is geometry, not a field; uniform/ is a subdirectory listing.
    if (base === "polyMesh" || base === "uniform") continue;
    const data = readFoamFile(path.join(caseDir, timeName), base);
    if (!data) continue;
    // A non-dictionary file (e.g. a stray log) has no FoamFile header and no
    // internalField; parseFoamField degrades it to a diagnostic, but a cheap
    // pre-check keeps the diagnostics focused on real fields.
    const text = data.toString("utf8");
    if (!/FoamFile/.test(text) && !/internalField/.test(text) && !/boundaryField/.test(text)) continue;
    const field = parseFoamField(text, base, diagnostics);
    if (field) {
      if (field.object !== base) {
        diagnostics.push({
          line: 0,
          message: `OpenFOAM field "${base}": FoamFile.object is "${field.object}"; using the object name.`,
        });
      }
      out.push(field);
    }
  }
  return out;
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
  const ext = meshExtname(fsPath);

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
      if (ext === ".foam") {
        // The marker is never read and never staged: measured, the reader
        // matches a `.foam` suffix BY NAME, so the case's own polyMesh under a
        // staging root is all it needs. `timeStep` selects a numeric time
        // directory's fields (re-parsed per frame; no geometry cache), with a
        // per-step polyMesh overlay for moving meshes.
        const diagnostics: MdpaDiagnostic[] = [];
        const name = path.basename(fsPath);
        const caseDir = openFoamCaseDir(fsPath);
        const times = await listOpenFoamTimes(caseDir);
        let timeName: string | undefined;
        if (opts?.timeStep !== undefined && times.length > 0) {
          const n = times.length;
          const idx = opts.timeStep < 0 ? n + opts.timeStep : opts.timeStep;
          if (!Number.isInteger(idx) || idx < 0 || idx >= n) {
            throw new Error(
              `Time step ${opts.timeStep} out of range for "${name}" (${n} time ${n === 1 ? "directory" : "directories"}).`
            );
          }
          timeName = times[idx].name;
        } else if (times.length > 0) {
          timeName = times[0].name;
        }
        const { files, patches } = await collectOpenFoamCase(caseDir, diagnostics, { timeName });
        let parsed: OpenFoamParsedField[] = [];
        if (timeName !== undefined) {
          parsed = readOpenFoamTimeFields(caseDir, timeName, diagnostics);
        }
        const model = await readMeshioModel(
          name,
          files,
          ext,
          opts?.meshioFormat,
          undefined,
          (mesh, d) => augmentMeshioWithFoamFields(mesh, parsed, d)
        );
        model.diagnostics.push(...diagnostics);
        const patched = applyOpenFoamPatches(model, patches, model.diagnostics);
        const boundary = foamBoundaryFields(patched, parsed, patched.diagnostics);
        if (boundary.length > 0) patched.fields.push(...boundary);
        return patched;
      }
      if (isMeshioReadExtension(ext)) {
        const name = path.basename(fsPath);
        const main = await readFileWithProgress(fsPath, onProgress);
        const files: MeshioInputFile[] = [{ name, data: main }];
        // tetgen always reads the .node/.ele pair, whichever half was opened;
        // an XDMF names its heavy-data companions inside the XML itself.
        for (const sibling of meshCompanionNames(name, ext, main.toString("utf8"))) {
          try {
            files.push({
              name: sibling,
              data: await fs.promises.readFile(path.join(path.dirname(fsPath), sibling)),
            });
          } catch {
            // Missing sibling: let meshio++ report it with a real message.
          }
        }
        return readMeshioModel(name, files, ext, opts?.meshioFormat, opts?.timeStep);
      }
      throw new Error(
        `Unsupported mesh file extension "${ext}" (supported: ${SUPPORTED_MESH_EXTENSIONS.join(", ")}).`
      );
    }
  }
}

/**
 * The time-series values a multi-step mesh carries — used to size and label
 * the in-file timeline (see `IN_FILE_TIMELINE_EXTENSIONS` in meshFormats.ts).
 * `[]` for a single-step file, so callers can treat that the same as no timeline.
 *
 * Exodus/GiD/XDMF answer via meshio++; OpenFOAM answers from its numeric time
 * directories (the values are the directory numbers, the index is the sorted
 * position — see the `.foam` branch of `parseMeshFile`).
 */
export async function readMeshTimeSteps(fsPath: string): Promise<number[]> {
  const ext = meshExtname(fsPath);
  if (ext === ".foam") {
    return (await listOpenFoamTimes(openFoamCaseDir(fsPath))).map((t) => t.value);
  }
  if (!isMeshioReadExtension(ext)) return [];
  const name = path.basename(fsPath);
  const main = await fs.promises.readFile(fsPath);
  // XDMF answers from its own light XML: upstream's readMetadata returns no
  // timeValues for a temporal collection AND falls back to a full read, so
  // going through meshio++ here would be both wrong and expensive.  The `.h5`
  // is never needed for this question, which is also why the generic staging
  // below never has to grow an `xdmfDataFiles` argument.
  if (ext === ".xdmf" || ext === ".xmf") return xdmfTimeValues(main.toString("utf8"));
  const files: MeshioInputFile[] = [{ name, data: main }];
  for (const sibling of meshCompanionNames(name, ext)) {
    try {
      files.push({
        name: sibling,
        data: await fs.promises.readFile(path.join(path.dirname(fsPath), sibling)),
      });
    } catch {
      // Missing sibling: let meshio++ report it with a real message on the
      // actual read; a timeline probe silently treats it as no timeline.
    }
  }
  return readMeshioTimeValues(name, files, ext);
}

/**
 * The header-only counterpart of `parseMeshFile` for meshio++ formats: the
 * file's shape (counts, block shapes, data-array names, regions, bbox)
 * without parsing it. Same staging as a read — tetgen pairs plus the XDMF
 * companions the XML names — since the metadata call opens the same files.
 * The caller applies HEADER_METADATA_EXTENSIONS (and the result's own
 * `fellBackToFullRead`) before treating this as cheap.
 */
export async function readMeshMetadata(
  fsPath: string,
  format?: string
): Promise<{ ext: string; metadata: MeshioMetadata }> {
  const ext = meshExtname(fsPath);
  if (!isMeshioReadExtension(ext)) {
    throw new Error(`Header metadata is only available for meshio++ formats, not "${ext}".`);
  }
  const name = path.basename(fsPath);
  if (ext === ".foam") {
    // Same staging as the read path: the marker is never staged, the case's
    // polyMesh is. Without this the metadata call would see a lone 0-byte file.
    const { files } = await collectOpenFoamCase(openFoamCaseDir(fsPath), []);
    return { ext, metadata: await readMeshioMetadata(name, files, ext, format) };
  }
  const main = await fs.promises.readFile(fsPath);
  const files: MeshioInputFile[] = [{ name, data: main }];
  for (const sibling of meshCompanionNames(name, ext, main.toString("utf8"))) {
    try {
      files.push({
        name: sibling,
        data: await fs.promises.readFile(path.join(path.dirname(fsPath), sibling)),
      });
    } catch {
      // Missing sibling: let meshio++ report it with a real message.
    }
  }
  return { ext, metadata: await readMeshioMetadata(name, files, ext, format) };
}

/**
 * The companion files a read of `fileName` stages beside it.
 *
 * The single answer to "which files does this mesh actually consist of?", and
 * the reason it is one function rather than three inlined copies: the size gate
 * and the MCP cache stamp both have to agree with what a READ opens, and they
 * silently did not — a 20 KB GiD `case.post.msh` beside a 6 GB `case.post.res`
 * measured as 20 KB, so it never tripped the summary threshold, and an `.xmf`
 * whose `.h5` was rewritten kept serving a stale cached model because the `.xmf`
 * itself had not changed. A family added to `meshioSiblingNames` now reaches
 * both for free.
 *
 * `mainText` is only needed for XDMF, whose companions are named inside the XML
 * and are therefore not derivable from the path; omit it and those are skipped.
 * Names are relative paths (`data/beam.h5`), never `fileName` itself.
 */
export function meshCompanionNames(
  fileName: string,
  ext: string,
  mainText?: string
): string[] {
  const names = [
    ...meshioSiblingNames(fileName, ext),
    ...(mainText !== undefined && (ext === ".xdmf" || ext === ".xmf")
      ? xdmfDataFiles(mainText)
      : []),
  ];
  return [...new Set(names)].filter((n) => n !== fileName);
}

/** An XDMF above this is inline-ascii; its own size already dominates. */
const XDMF_SCAN_CAP = 4 * 1024 * 1024;

export interface MeshSourceStat {
  /** Total bytes of every file the mesh is read from. */
  bytes: number;
  /** Changes whenever any of them does — a cache key that cannot go stale. */
  stamp: string;
}

/**
 * One stat pass over the files a mesh is actually read from.
 *
 * Cheap by construction: a single-file format costs exactly what it costs
 * today (`meshioSiblingNames` returns `[]`), a paired format costs one extra
 * `stat`, and only XDMF pays a read — bounded by `XDMF_SCAN_CAP`, above which
 * the file is inline-ascii and has no external data to find anyway.
 *
 * A missing companion is normal (the reader reports it with a real message), so
 * it is skipped; a missing MAIN file propagates, because both preview providers
 * rely on that to surface a deleted file.
 */
export async function statMeshSource(fsPath: string): Promise<MeshSourceStat> {
  const ext = meshExtname(fsPath);
  if (ext === ".foam") {
    const dir = openFoamCaseDir(fsPath);
    return { bytes: await openFoamCaseSize(dir), stamp: await openFoamCaseStamp(dir) };
  }

  const name = path.basename(fsPath);
  const main = await fs.promises.stat(fsPath);
  let bytes = main.size;
  const parts = [`${name}:${main.mtimeMs}:${main.size}`];

  let mainText: string | undefined;
  if ((ext === ".xdmf" || ext === ".xmf") && main.size <= XDMF_SCAN_CAP) {
    try {
      mainText = await fs.promises.readFile(fsPath, "utf8");
    } catch {
      /* unreadable: fall back to the file's own size */
    }
  }

  const dir = path.dirname(fsPath);
  for (const companion of meshCompanionNames(name, ext, mainText)) {
    try {
      const st = await fs.promises.stat(path.join(dir, companion));
      bytes += st.size;
      parts.push(`${companion}:${st.mtimeMs}:${st.size}`);
    } catch {
      // Missing companion: the read will report it; it contributes nothing here.
    }
  }
  return { bytes, stamp: parts.join("|") };
}
