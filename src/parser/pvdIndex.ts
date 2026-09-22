/**
 * ParaView Data (`.pvd`) support — roadmap item 3's native `.pvd` reader. A
 * `.pvd` is a light `<Collection>` of `<DataSet timestep="…" part="…"
 * file="…"/>` entries, each referencing an ordinary `.vtu`/`.vtp` piece —
 * never a heavy format of its own. Reading one is therefore: parse this
 * index (a few kilobytes), pick the entries for one step, and merge them
 * with `vtkMultiblock.ts`'s shared `mergeChildDatasets` (the same
 * node/entity-offsetting and path-escape guard `.vtm` already uses — not
 * duplicated here).
 *
 * `parsePvdIndex`/`pvdTimeValues`/`pvdStepFiles` are pure (no vscode/DOM/
 * wasm/fs); `parsePvd` is the fs-touching whole-file read, the same
 * pure-index/fs-read split `vtkMultiblock.ts` already has for `.vtm`.
 * Upstream's own `.pvd` reader (measured against the live 15.4.0 build) is
 * read natively instead for the same reason XDMF's light XML is read
 * natively: each step's actual mesh bytes are already owned by our own
 * `.vtu`/`.vtp` readers, and upstream's `pvd`/`pvtu`/`pvtp` keys have no
 * WASM smoke coverage as of 15.3.0.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { MdpaDiagnostic, MdpaModel } from "./types";
import { finalizeModel } from "./modelBuilder";
import { mergeChildDatasets } from "./vtkMultiblock";
import { findAll, findFirst, parseVtkXmlFile } from "./vtkXmlCore";

export interface PvdEntry {
  /**
   * The declared `timestep`, when the entry has one. A `.pvd` written by
   * something other than this extension's own writer (see the sequence-
   * packing bullet) COULD omit it — upstream's own fallback then reads
   * each piece's own field data for a time key, which this native reader
   * does not replicate (that would mean reading every piece just to size
   * the timeline, defeating the point of a light index). An entry with no
   * timestep is excluded from `pvdTimeValues` and only reachable through
   * `pvdStepFiles` when NO entry in the file declares one at all.
   */
  timestep?: number;
  /** `0` when the entry omits it — upstream's own default. */
  part: number;
  /** As written in the file, relative to the .pvd's own directory. */
  file: string;
}

/** Parses the `.pvd` index: every `<DataSet>` in file order. */
export function parsePvdIndex(buf: Buffer): PvdEntry[] {
  const { root } = parseVtkXmlFile(buf);
  const collection = findFirst(root, "Collection") ?? root;
  const out: PvdEntry[] = [];
  for (const el of findAll(collection, "DataSet")) {
    if (!el.attrs.file) continue;
    const rawStep = el.attrs.timestep;
    const timestep = rawStep !== undefined ? Number(rawStep) : undefined;
    const rawPart = el.attrs.part;
    const part = rawPart !== undefined ? Number(rawPart) : 0;
    out.push({
      timestep: timestep !== undefined && Number.isFinite(timestep) ? timestep : undefined,
      part: Number.isFinite(part) ? part : 0,
      file: el.attrs.file,
    });
  }
  return out;
}

/** The distinct declared time values, ascending — `[]` if none declare one. */
export function pvdTimeValues(entries: readonly PvdEntry[]): number[] {
  const times = new Set<number>();
  for (const e of entries) if (e.timestep !== undefined) times.add(e.timestep);
  return [...times].sort((a, b) => a - b);
}

/**
 * The entries (pieces) making up step `stepIdx`, sorted by `part` — a step
 * is every entry sharing the `stepIdx`-th distinct declared time, or, for a
 * file where NO entry declares one, that entry alone (so a single-piece,
 * no-timestep `.pvd` still opens as one static frame rather than failing).
 *
 * @throws {Error} on an out-of-range `stepIdx`, naming the count available
 * — the same convention `meshFileParser.ts`'s own time-step selection uses.
 */
export function pvdStepFiles(entries: readonly PvdEntry[], stepIdx: number): PvdEntry[] {
  const times = pvdTimeValues(entries);
  if (times.length === 0) {
    if (stepIdx < 0 || stepIdx >= entries.length) {
      throw new Error(`Step ${stepIdx} out of range (${entries.length} available).`);
    }
    return [entries[stepIdx]];
  }
  if (stepIdx < 0 || stepIdx >= times.length) {
    throw new Error(`Step ${stepIdx} out of range (${times.length} available).`);
  }
  const t = times[stepIdx];
  return entries.filter((e) => e.timestep === t).sort((a, b) => a.part - b.part);
}

/**
 * Parses a `.pvd` and merges the pieces of one step into one MdpaModel —
 * the `.pvd` analogue of `vtkMultiblock.ts`'s `parseVtm`, differing only in
 * WHICH entries get merged (one step's worth, not every DataSet) and in
 * naming each piece by its `part` index rather than a Block/DataSet path,
 * since a `.pvd` has no block hierarchy.
 */
export async function parsePvd(
  fsPath: string,
  parseChild: (childFsPath: string) => Promise<MdpaModel>,
  timeStep?: number
): Promise<MdpaModel> {
  const diagnostics: MdpaDiagnostic[] = [];
  const pvdDir = path.dirname(fsPath);
  const buf = await fs.promises.readFile(fsPath);
  const entries = parsePvdIndex(buf);
  const step = pvdStepFiles(entries, timeStep ?? 0);
  const merged = await mergeChildDatasets(
    step.map((e) => ({ path: `Part_${e.part}`, file: e.file })),
    pvdDir,
    parseChild,
    diagnostics
  );

  return finalizeModel({
    nodeCount: merged.coords.length / 3,
    coords: new Float32Array(merged.coords),
    blocks: merged.blocks,
    fields: merged.fields,
    diagnostics,
    subModelParts: merged.subModelParts,
  });
}
