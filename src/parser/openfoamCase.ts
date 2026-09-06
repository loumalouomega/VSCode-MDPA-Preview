/**
 * Reading an OpenFOAM case.
 *
 * A case is a DIRECTORY — `<case>/constant/polyMesh/{points,faces,owner,…}` —
 * addressed by convention through a 0-byte `<case>/x.foam` marker, which is
 * what ParaView uses and what this extension's own exporter writes. That marker
 * is the only handle a VS Code custom editor can bind to (a custom editor
 * cannot open a folder), and it is also all upstream needs: measured against
 * the live 10.20.2 wasm, `readMesh(p, "openfoam")` matches a `.foam` suffix **by
 * name**, so the marker need not even exist inside the staging filesystem.
 *
 * Three things upstream does not give us, each handled here rather than
 * discovered by a user:
 *
 *  - **Patch names.** A case with `inlet`/`outlet` reads back with `regions: []`
 *    and the patches encoded only as `cell_tags = -(patchIndex + 1)` on the
 *    boundary block. The names live in `constant/polyMesh/boundary`, which is
 *    plain ASCII, so `parseOpenFoamBoundary` recovers them and
 *    `applyOpenFoamPatches` joins them on. Without this a CFD mesh arrives with
 *    anonymous boundaries and cannot be used to assign a boundary condition,
 *    which is most of the reason to open one.
 *  - **Compression.** `writeCompression on` stores `points.gz`; the reader opens
 *    bare names only, so the gunzip happens during staging.
 *  - **What is NOT read.** Zones, time-directory fields, multi-region and
 *    decomposed cases are all silently absent upstream. Each gets a diagnostic
 *    instead, because a mesh that quietly lacks half a case is worse than one
 *    that says so.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

import type { MdpaDiagnostic, MdpaModel, EntityBlock, SubModelPart } from "./types";
import type { MeshioInputFile } from "./meshio";
import { sortedUnique } from "./meshioRegions";

/** The polyMesh files upstream opens, in the order it opens them. */
export const OPENFOAM_POLYMESH_FILES = [
  "points",
  "faces",
  "owner",
  "neighbour",
  "boundary",
] as const;

/**
 * Measured: without these the read fails naming the missing file. `neighbour`
 * and `boundary` are optional — dropping `boundary` costs the boundary-face
 * block entirely, which is why its absence is a diagnostic rather than silence.
 */
export const OPENFOAM_REQUIRED_FILES = ["points", "faces", "owner"] as const;

/** Where the mesh lives, relative to the case directory. */
export const OPENFOAM_POLYMESH_DIR = "constant/polyMesh";

/** One `constant/polyMesh/boundary` entry. Its INDEX is load-bearing. */
export interface OpenFoamPatch {
  name: string;
  /** `patch` | `wall` | `empty` | `symmetry` | …; "" when the entry omits it. */
  type: string;
  nFaces?: number;
  startFace?: number;
  /** The name was invented because the entry could not be read. */
  synthesized?: boolean;
}

/** `<case>` for `<case>/x.foam`; the argument itself for a directory. */
export function openFoamCaseDir(fsPath: string): string {
  return path.extname(fsPath).toLowerCase() === ".foam" ? path.dirname(fsPath) : fsPath;
}

// ---- boundary ----------------------------------------------------------------

/** Drops `/* … *​/` and `// …` so brace matching cannot trip over them. */
function stripFoamComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** Index just past the `{` … `}` starting at `open`, or -1 if unbalanced. */
function matchBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * The `boundary` dictionary's patch list, in FILE ORDER.
 *
 * **Never skips an entry, and never throws.** The join downstream is positional
 * — a face tagged `-3` is the third patch — so dropping one malformed entry
 * would silently rename every patch after it, which looks exactly like success.
 * An unreadable entry therefore becomes a `synthesized` placeholder that holds
 * its index. Everything else degrades to a diagnostic and an empty list, the
 * recipe-style tolerance this codebase already uses for untrusted disk input.
 */
export function parseOpenFoamBoundary(
  text: string,
  diagnostics: MdpaDiagnostic[]
): OpenFoamPatch[] {
  const src = stripFoamComments(text);

  // Skip the FoamFile header dictionary if present; a raw list is fine too.
  let from = 0;
  const header = src.indexOf("FoamFile");
  if (header >= 0) {
    const brace = src.indexOf("{", header);
    if (brace >= 0) {
      const end = matchBrace(src, brace);
      if (end > 0) from = end;
    }
  }

  // An entry count may precede the list; keep it only to cross-check.
  const countMatch = /(\d+)\s*\(/.exec(src.slice(from));
  const declared = countMatch ? parseInt(countMatch[1], 10) : undefined;

  const listOpen = src.indexOf("(", from);
  if (listOpen < 0) {
    diagnostics.push({
      line: 0,
      message: "constant/polyMesh/boundary has no patch list; boundary faces stay unnamed.",
    });
    return [];
  }
  // The list's own closing paren: the last one in the file, since patch bodies
  // use braces rather than parens (an `inGroups (wall);` sits inside a body).
  const listClose = src.lastIndexOf(")");
  if (listClose <= listOpen) {
    diagnostics.push({
      line: 0,
      message: "constant/polyMesh/boundary's patch list is not closed; boundary faces stay unnamed.",
    });
    return [];
  }

  const body = src.slice(listOpen + 1, listClose);
  const patches: OpenFoamPatch[] = [];
  const name = /([A-Za-z_][\w.\-]*)\s*\{/g;
  let cursor = 0;
  for (;;) {
    name.lastIndex = cursor;
    const m = name.exec(body);
    if (!m) break;
    const braceAt = body.indexOf("{", m.index);
    const end = matchBrace(body, braceAt);
    if (end < 0) {
      // The index must survive even though the entry cannot be read.
      patches.push({ name: `patch_${patches.length}`, type: "", synthesized: true });
      diagnostics.push({
        line: 0,
        message:
          `constant/polyMesh/boundary: patch "${m[1]}" has an unterminated body; ` +
          `it keeps its position as "patch_${patches.length - 1}" so later patch names stay correct.`,
      });
      break;
    }
    const entry = body.slice(braceAt, end);
    const num = (key: string): number | undefined => {
      const v = new RegExp(`\\b${key}\\s+(\\d+)\\s*;`).exec(entry);
      return v ? parseInt(v[1], 10) : undefined;
    };
    patches.push({
      name: m[1],
      type: /\btype\s+([A-Za-z_]\w*)\s*;/.exec(entry)?.[1] ?? "",
      nFaces: num("nFaces"),
      startFace: num("startFace"),
    });
    cursor = end;
  }

  if (patches.length === 0) {
    diagnostics.push({
      line: 0,
      message: "constant/polyMesh/boundary declares no patches; boundary faces stay unnamed.",
    });
  } else if (declared !== undefined && declared !== patches.length) {
    diagnostics.push({
      line: 0,
      message:
        `constant/polyMesh/boundary declares ${declared} patch(es) but ${patches.length} could be read` +
        (/#include/.test(src) ? " (it uses #include, which is not resolved here)." : "."),
    });
  }
  return patches;
}

// ---- staging -----------------------------------------------------------------

function polyMeshDir(caseDir: string): string {
  return path.join(caseDir, "constant", "polyMesh");
}

/** Reads `<n>`, or inflates `<n>.gz`; undefined when neither exists. */
function readPolyMeshFile(dir: string, name: string): Buffer | undefined {
  const plain = path.join(dir, name);
  try {
    return fs.readFileSync(plain);
  } catch {
    /* try the compressed form */
  }
  try {
    return zlib.gunzipSync(fs.readFileSync(`${plain}.gz`));
  } catch {
    return undefined;
  }
}

/** Names what the case contains that upstream will not read. */
function diagnoseIgnored(caseDir: string, diagnostics: MdpaDiagnostic[]): void {
  const pm = polyMeshDir(caseDir);
  const zones = ["cellZones", "faceZones", "pointZones"].filter(
    (z) => fs.existsSync(path.join(pm, z)) || fs.existsSync(path.join(pm, `${z}.gz`))
  );
  if (zones.length > 0) {
    diagnostics.push({
      line: 0,
      message: `OpenFOAM: ${zones.join(", ")} are present but not read; they do not cross the reader.`,
    });
  }
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(caseDir);
  } catch {
    return;
  }
  if (entries.some((e) => /^processor\d+$/.test(e))) {
    diagnostics.push({
      line: 0,
      message:
        "OpenFOAM: this looks like a decomposed case (processor*/); only constant/polyMesh is read. " +
        "Reconstruct it first to see the whole mesh.",
    });
  }
  // A time directory holding its own polyMesh is a moving mesh; one holding
  // only fields is the ordinary case. Neither is read, and they differ in what
  // the user loses, so they are reported apart.
  const timeDirs = entries.filter((e) => /^\d+(\.\d+)?$/.test(e) && e !== "0");
  const moving = [...timeDirs, "0"].filter((t) =>
    fs.existsSync(path.join(caseDir, t, "polyMesh"))
  );
  if (moving.length > 0) {
    diagnostics.push({
      line: 0,
      message:
        `OpenFOAM: ${moving.length} time director(ies) carry their own polyMesh (a moving mesh); ` +
        "only constant/polyMesh is read.",
    });
  }
  if (fs.existsSync(path.join(caseDir, "0"))) {
    diagnostics.push({
      line: 0,
      message: "OpenFOAM: time-directory fields (0/U, 0/p, …) are not read; this is geometry only.",
    });
  }
}

/**
 * Reads a case's polyMesh into staging entries, plus its patch names.
 *
 * Throws naming the file when a REQUIRED one is missing, rather than letting
 * the wasm fail: that failure is an `FS.ErrnoError` whose `message` is
 * `undefined`, so the user would see nothing useful.
 */
export async function collectOpenFoamCase(
  caseDir: string,
  diagnostics: MdpaDiagnostic[]
): Promise<{ files: MeshioInputFile[]; patches: OpenFoamPatch[] }> {
  const dir = polyMeshDir(caseDir);
  if (!fs.existsSync(dir)) {
    throw new Error(
      `Not an OpenFOAM case: ${path.join(caseDir, OPENFOAM_POLYMESH_DIR)} does not exist.`
    );
  }
  const files: MeshioInputFile[] = [];
  let patches: OpenFoamPatch[] = [];
  for (const name of OPENFOAM_POLYMESH_FILES) {
    const data = readPolyMeshFile(dir, name);
    if (!data) {
      if ((OPENFOAM_REQUIRED_FILES as readonly string[]).includes(name)) {
        throw new Error(`OpenFOAM case is missing ${OPENFOAM_POLYMESH_DIR}/${name}.`);
      }
      diagnostics.push({
        line: 0,
        message:
          `OpenFOAM: ${OPENFOAM_POLYMESH_DIR}/${name} is missing` +
          (name === "boundary"
            ? " — the mesh has no boundary faces and its patches cannot be named."
            : "."),
      });
      continue;
    }
    files.push({ name: `${OPENFOAM_POLYMESH_DIR}/${name}`, data: new Uint8Array(data) });
    if (name === "boundary") patches = parseOpenFoamBoundary(data.toString("utf8"), diagnostics);
  }
  diagnoseIgnored(caseDir, diagnostics);
  return { files, patches };
}

/** Bytes the polyMesh actually occupies — the marker's own size is 0. */
export async function openFoamCaseSize(caseDir: string): Promise<number> {
  const dir = polyMeshDir(caseDir);
  let total = 0;
  for (const name of OPENFOAM_POLYMESH_FILES) {
    for (const p of [path.join(dir, name), path.join(dir, `${name}.gz`)]) {
      try {
        total += (await fs.promises.stat(p)).size;
        break;
      } catch {
        /* not this one */
      }
    }
  }
  return total;
}

/**
 * A change stamp over the polyMesh files.
 *
 * The marker is 0 bytes and its mtime never moves when `blockMesh` rewrites the
 * mesh, so anything keyed on the OPENED file (the MCP model cache) would serve a
 * stale model forever.
 */
export async function openFoamCaseStamp(caseDir: string): Promise<string> {
  const dir = polyMeshDir(caseDir);
  const parts: string[] = [];
  for (const name of OPENFOAM_POLYMESH_FILES) {
    for (const p of [path.join(dir, name), path.join(dir, `${name}.gz`)]) {
      try {
        const st = await fs.promises.stat(p);
        parts.push(`${name}:${st.mtimeMs}:${st.size}`);
        break;
      } catch {
        /* not this one */
      }
    }
  }
  return parts.join("|");
}

/** True when writing `destPath` would rewrite the polyMesh `sourcePath` came from. */
export function wouldOverwriteOpenFoamCase(sourcePath: string, destPath: string): boolean {
  if (path.extname(sourcePath).toLowerCase() !== ".foam") return false;
  if (path.extname(destPath).toLowerCase() !== ".foam") return false;
  // Directories, not paths: exporting to `<case>/other.foam` rewrites the very
  // same constant/polyMesh, which a path comparison would wave through.
  return path.resolve(openFoamCaseDir(sourcePath)) === path.resolve(openFoamCaseDir(destPath));
}

// ---- the join ----------------------------------------------------------------

/** meshio++'s own name for the patch-index array on the boundary block. */
const CELL_TAGS = "cell_tags";

/**
 * Turns the boundary block's `cell_tags` into named `Conditions` SubModelParts.
 *
 * Upstream gives patch membership as `-(patchIndex + 1)` on boundary faces and
 * `0` on interior cells, with the names nowhere — this is where the two halves
 * meet. Runs on the finished model rather than inside `meshioToModel` because
 * the meshio-side region machinery (`regionsToParts`) needs `kept`/`expansion`
 * that only exist in there, produces `elementIds` where these are semantically
 * Conditions, and offers no hook to drop the now-wrong tag field.
 *
 * Blocks are classified by TAG, not by cell type: a boundary that mixes
 * triangles and quads is two blocks, and nothing measured guarantees which
 * order upstream emits them in.
 */
export function applyOpenFoamPatches(
  model: MdpaModel,
  patches: readonly OpenFoamPatch[],
  diagnostics: MdpaDiagnostic[]
): MdpaModel {
  const tagField = model.fields.find(
    (f) => f.kind === "Elemental" && f.variable === CELL_TAGS && f.components === 1
  );
  if (!tagField) {
    if (patches.length > 0) {
      diagnostics.push({
        line: 0,
        message:
          "OpenFOAM: the reader returned no cell_tags array, so the boundary patches " +
          "could not be matched to their names.",
      });
    }
    return model;
  }

  const tagOf = new Map<number, number>();
  for (let i = 0; i < tagField.ids.length; i++) {
    tagOf.set(tagField.ids[i], Math.round(tagField.values[i]));
  }

  // Which blocks are entirely boundary faces?
  const isBoundary = model.blocks.map((b) => {
    if (b.kind !== "Elements" || b.count === 0) return false;
    let neg = 0;
    for (let i = 0; i < b.entityIds.length; i++) {
      if ((tagOf.get(b.entityIds[i]) ?? 0) < 0) neg++;
    }
    if (neg === 0) return false;
    if (neg === b.entityIds.length) return true;
    diagnostics.push({
      line: 0,
      message:
        `OpenFOAM: block "${b.name}" mixes interior and boundary faces, so it was left as ` +
        "Elements and its patches are unnamed.",
    });
    return false;
  });
  if (!isBoundary.some(Boolean)) return model;

  // Boundary faces become Conditions in their own id space. Surviving Elements
  // keep their ids: sparse ids are legal everywhere here, and assuming the
  // volume blocks come first would be an unearned guess about block order.
  const blocks: EntityBlock[] = [];
  const facesOfPatch = new Map<number, number[]>();
  let undeclared = 0;
  let conditionId = 1;
  for (let bi = 0; bi < model.blocks.length; bi++) {
    const b = model.blocks[bi];
    if (!isBoundary[bi]) {
      blocks.push(b);
      continue;
    }
    const entityIds = new Int32Array(b.entityIds.length);
    for (let i = 0; i < b.entityIds.length; i++) {
      const id = conditionId++;
      entityIds[i] = id;
      const tag = tagOf.get(b.entityIds[i]) ?? 0;
      const idx = -tag - 1;
      if (idx < 0 || idx >= patches.length) {
        undeclared++;
        continue;
      }
      const list = facesOfPatch.get(idx);
      if (list) list.push(id);
      else facesOfPatch.set(idx, [id]);
    }
    blocks.push({ ...b, kind: "Conditions", entityIds });
  }

  if (undeclared > 0) {
    diagnostics.push({
      line: 0,
      message:
        `OpenFOAM: ${undeclared} boundary face(s) carry a patch index that ` +
        "constant/polyMesh/boundary does not declare; they are left unnamed.",
    });
  }

  // Cross-check against the file's own nFaces. This is the only thing standing
  // between a mis-ordered tag convention and every patch being silently
  // misnamed, which would look exactly like success.
  for (let i = 0; i < patches.length; i++) {
    const declared = patches[i].nFaces;
    const got = facesOfPatch.get(i)?.length ?? 0;
    if (declared !== undefined && declared !== got) {
      diagnostics.push({
        line: 0,
        message:
          `OpenFOAM: patch "${patches[i].name}" declares ${declared} face(s) but ${got} ` +
          "were tagged with its index; the patch names may not line up with the mesh.",
      });
      break;
    }
  }

  const used = new Set(model.subModelParts.map((p) => p.path));
  const parts: SubModelPart[] = [];
  for (let i = 0; i < patches.length; i++) {
    const ids = facesOfPatch.get(i);
    // A zero-face patch is legal and common; it is not a part worth showing.
    if (!ids || ids.length === 0) continue;
    let name = patches[i].name;
    for (let n = 2; used.has(name); n++) name = `${patches[i].name}_${n}`;
    used.add(name);
    parts.push({
      name,
      path: name,
      // Node membership is left empty, matching what a meshio `cell` region
      // produces; the faces carry their own connectivity.
      nodeIds: new Int32Array(0),
      elementIds: new Int32Array(0),
      conditionIds: sortedUnique(ids),
      geometryIds: new Int32Array(0),
      constraintIds: new Int32Array(0),
      children: [],
    });
  }

  return {
    ...model,
    blocks,
    // Dropped, not re-keyed: after the flip above it is an Elemental field whose
    // ids partly moved into the condition space, i.e. actively wrong — and
    // `-(index+1)` is not a quantity anyone wants to colour by. The names it
    // encoded are now the SubModelParts.
    fields: model.fields.filter((f) => f !== tagField),
    subModelParts: [...model.subModelParts, ...parts],
    diagnostics: model.diagnostics,
  };
}
