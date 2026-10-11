/**
 * convergenceFile.ts — the `node:fs` half of the convergence reader, kept apart
 * from `convergence.ts` so the pure rules stay importable from anywhere (the
 * `runFile.ts` / `runCore.ts` arrangement).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  CONVERGENCE_FILE,
  ConvergenceSummary,
  ParsedConvergence,
  parseConvergenceJsonl,
  summarizeConvergence,
} from "./convergence";

/** A run that logs every step for days must not be slurped whole into memory. */
export const CONVERGENCE_MAX_BYTES = 8 * 1024 * 1024;

export interface ConvergenceRead {
  /** False when there is no file (or it cannot be read); `reason` says which. */
  available: boolean;
  file: string;
  reason?: string;
  parsed?: ParsedConvergence;
  /** True when only the tail of an over-large file was read. */
  tailOnly?: boolean;
}

export function convergenceFilePath(caseDir: string): string {
  return path.join(caseDir, CONVERGENCE_FILE);
}

export function readConvergence(caseDir: string, opts: { maxBytes?: number } = {}): ConvergenceRead {
  const file = convergenceFilePath(caseDir);
  const maxBytes = opts.maxBytes ?? CONVERGENCE_MAX_BYTES;
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    let text = buf.toString("utf8");
    const tailOnly = size > maxBytes;
    // The tail starts mid-record: drop the partial first line.
    if (tailOnly) text = text.slice(text.indexOf("\n") + 1);
    const parsed = parseConvergenceJsonl(text);
    if (tailOnly) parsed.warnings.push(`Only the last ${length} bytes of ${size} were read; earlier steps are not shown.`);
    return { available: true, file, parsed, ...(tailOnly ? { tailOnly } : {}) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      available: false,
      file,
      reason: code === "ENOENT"
        ? "No convergence file has been written (the case may predate the monitor, use a problemtype without an adapter, or not have started)."
        : `The convergence file could not be read: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Convenience for callers that only want the summary. */
export function readConvergenceSummary(caseDir: string, runStatus?: string): ConvergenceSummary | undefined {
  const read = readConvergence(caseDir);
  return read.parsed ? summarizeConvergence(read.parsed, runStatus) : undefined;
}
