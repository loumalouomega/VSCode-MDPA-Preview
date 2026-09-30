/**
 * Packing a series into a **`.pvd`** — a ParaView collection index over
 * per-step files, each of which may carry its OWN mesh.
 *
 * This is the container for a series whose topology changes (roadmap item 20).
 * `packXdmfSeries` writes a temporal XDMF, whose collection holds ONE static
 * grid for every step, so a remeshed run genuinely cannot be represented in it
 * and is refused there by name rather than written against step 1's mesh. A
 * `.pvd` has no such constraint: it is a light index of ordinary VTK files, and
 * every step is one of them.
 *
 * Two measured facts shaped this:
 *
 *  - **meshio++'s VTKHDF writer cannot do this either.** Given a changing series
 *    it writes step 1's grid once and then refuses the next step's data
 *    ("point_data 'TEMP' has 7 rows; the series has 4 points"), and the WASM
 *    write options are `{encoding, codec, floatFormat}` — there is no `Steps`
 *    write offset to change. The `Steps` offsets are a READ concept. A
 *    single-file changing-topology container is therefore not reachable through
 *    the current boundary at all.
 *  - **meshio++ does have a `pvd` writer, and it works here.** It is not used:
 *    it re-encodes every step through the kernel (so it needs the 24 MB module
 *    loaded and a MEMFS harvest) when our own writer already produces the piece
 *    and can often skip the transcode entirely. Upstream's route is recorded,
 *    not silently forgotten.
 *
 * **No wasm, no fs.** Both are the point: this target stays available when the
 * kernel cannot load, and the module returns its bytes so the caller owns the
 * disk — a `.pvd` whose index is published before its step directory exists is
 * worse than no output at all.
 *
 * It takes the SAME `PackStep[]` input as `packXdmfSeries`, so one discovery
 * path (`packStepsFromFiles` / `packStepsFromInFile`) feeds both containers and
 * no new step type is invented. The one input difference: a step handed over as
 * raw bytes must be VTK XML (see the refusal in the loop), because a container
 * that writes its own piece cannot re-read a legacy file it was given bytes of.
 *
 * The OUTPUT half is the host's: this module returns the index and the pieces,
 * and `pvdOutputClash` is the single destination rule both hosts ask, so the
 * policy is stated once (see its comment for why it refuses rather than
 * overwrites).
 */

import * as path from "node:path";

import { VTK_XML_EXTENSIONS } from "./meshFormats";
import type { PackStep } from "./meshio";
import { writeMeshFileAsync } from "./writers/meshWriter";

/** The formats a step's bytes can be reused as-is, with the extension kept. */
const COPY_THROUGH = new Set<string>(VTK_XML_EXTENSIONS);

export interface PvdPiece {
  /** `frame_000000.vtu` — the name the index points at, inside the output directory. */
  name: string;
  data: Uint8Array;
  /** `true` when the bytes were the step's own file, not a re-write. */
  copied: boolean;
  /** The step's source extension, so a mixed index stays inspectable. */
  sourceExtension: string;
}

export interface PackPvdResult {
  /** The `.pvd` index text, as UTF-8. */
  data: Uint8Array;
  pieces: PvdPiece[];
  steps: number;
  /** How many pieces are byte copies rather than re-writes. */
  copied: number;
  /** The distinct time values, ascending — what a re-read reports. */
  times: number[];
  warnings: string[];
}

export interface PackPvdOptions {
  /** Names the output: pieces go in `<stem>/`, the index in `<stem>.pvd`. */
  stem: string;
  onProgress?(done: number, total: number): void;
  signal?: AbortSignal;
}

const encoder = new TextEncoder();

/** The index, with the pieces' paths relative to the `.pvd`'s own directory. */
export function pvdIndexText(entries: readonly { timestep: number; file: string }[]): string {
  const rows = entries.map(
    (e) => `    <DataSet timestep="${e.timestep}" group="" part="0" file="${xmlAttribute(e.file)}"/>`
  );
  return (
    '<?xml version="1.0"?>\n' +
    '<VTKFile type="Collection" version="0.1" byte_order="LittleEndian">\n' +
    "<Collection>\n" +
    rows.join("\n") +
    "\n</Collection>\n</VTKFile>\n"
  );
}

/**
 * Escapes a path for a double-quoted XML attribute.
 *
 * `>` is escaped even though XML allows it bare, and that is not pedantry: the
 * extension's own `tokenize` (vtkXmlCore.ts) finds the end of a tag with a
 * plain `indexOf(">")`, so a literal `>` inside an attribute truncates the tag
 * and the element is dropped — a stem containing one would produce an index
 * that reads as an empty series. Escaping it is what makes the round trip hold.
 */
function xmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const extensionOf = (name: string): string => {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i).toLowerCase() : "";
};

/** Where a `.pvd` at `indexPath` keeps its step files: a directory of the same
 *  stem, which is the shape the reader and every ParaView tool expect. */
export function pvdPieceDir(indexPath: string): string {
  return path.join(path.dirname(indexPath), path.basename(indexPath, ".pvd"));
}

/**
 * The one rule about a pack's destination, shared by both hosts so they cannot
 * disagree: a `.pvd` pack OWNS its piece directory, so neither the index nor a
 * non-empty one may already be there. Deleting a directory because a name
 * collided is the only way this could destroy something the user made — which is
 * why it refuses rather than overwrites, while the one-file XDMF pack (no
 * directory to own) still overwrites. Returns the refusal, or undefined.
 */
export function pvdOutputClash(
  indexPath: string,
  indexExists: boolean,
  pieceDirOccupied: boolean
): string | undefined {
  if (!indexExists && !pieceDirOccupied) return undefined;
  const stem = path.basename(indexPath, ".pvd");
  return (
    `${stem}.pvd or its ${stem}/ directory already exists. A .pvd pack owns that ` +
    `directory and will not overwrite it — choose another name, or remove it first.`
  );
}

/**
 * Packs an ordered series into a `.pvd` index plus its per-step files.
 *
 * A step whose `read()` yields the bytes of a VTK-XML file is reused AS IS and
 * keeps its own extension, so a `.vtp` step stays a `.vtp` and nothing is
 * transcoded. Anything else — a legacy `.vtk`, any meshio++ format, an in-file
 * series' parsed model — is written as `.vtu` by our own writer. The index may
 * therefore hold both kinds, which is legal (the reader dispatches on each
 * piece's own extension) and reported through `pieces[].copied` so nothing
 * about the output is a surprise.
 */
export async function packPvdSeries(
  steps: PackStep[],
  opts: PackPvdOptions
): Promise<PackPvdResult> {
  if (steps.length === 0) throw new Error("No steps to pack.");
  const stem = opts.stem || "series";
  const pieces: PvdPiece[] = [];
  const entries: { timestep: number; file: string }[] = [];
  const warnings: string[] = [];
  const times = new Set<number>();

  for (let i = 0; i < steps.length; i++) {
    opts.signal?.throwIfAborted();
    const step = steps[i];
    const input = await step.read();
    const sourceExtension = extensionOf(step.name);
    let data: Uint8Array;
    let ext: string;
    let copied = false;
    if (input instanceof Uint8Array) {
      if (!COPY_THROUGH.has(sourceExtension)) {
        // Rather than a silent re-parse: this module has no filesystem, so a
        // legacy `.vtk` handed over as bytes has no path left to be read from.
        // The fix is one argument at the producer, not a hidden fallback here.
        throw new Error(
          `Step ${i + 1} ("${step.name}") was handed over as raw bytes, which only a ` +
            `VTK-XML step can be — a "${sourceExtension}" file has to arrive as a parsed ` +
            `model (pass { byteFormats: VTK_XML_EXTENSIONS } to packStepsFromFiles).`
        );
      }
      data = input;
      ext = sourceExtension;
      copied = true;
    } else {
      // Not a copy: our own writer produces the piece, so this container's
      // fidelity is the preview's, not a round trip through meshio++.
      // A native writer hands back text; `.vtu` is one, and the caller writes
      // either form, so the piece keeps whatever its writer produced.
      const written = await writeMeshFileAsync(input, ".vtu", {
        onWarning: (m) => warnings.push(m),
      });
      data = typeof written.data === "string" ? encoder.encode(written.data) : written.data;
      ext = ".vtu";
    }
    const name = `frame_${String(i).padStart(6, "0")}${ext}`;
    pieces.push({ name, data, copied, sourceExtension });
    entries.push({ timestep: step.time, file: `${stem}/${name}` });
    times.add(step.time);
    opts.onProgress?.(i + 1, steps.length);
  }

  return {
    data: encoder.encode(pvdIndexText(entries)),
    pieces,
    steps: pieces.length,
    copied: pieces.filter((p) => p.copied).length,
    times: [...times].sort((a, b) => a - b),
    warnings,
  };
}
