/**
 * The `node:fs` half of the optimization progress reader: finds the case's
 * optimization_parameters.json, reads the summary file it names (byte-capped,
 * tail-only past the cap, like convergenceFile.ts) and summarizes it.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  OptimizationCaseInfo,
  OptimizationSummary,
  ParsedOptimizationSummary,
  optimizationCaseInfo,
  parseOptimizationSummary,
  summarizeOptimization,
} from "./summaryLog";

export const OPTIMIZATION_PARAMETERS_FILE = "optimization_parameters.json";
export const SUMMARY_MAX_BYTES = 8 * 1024 * 1024;

export interface OptimizationRead {
  /** False when the folder holds no optimization case, or its summary is absent. */
  available: boolean;
  caseDir: string;
  info?: OptimizationCaseInfo;
  summaryFile?: string;
  parsed?: ParsedOptimizationSummary;
  reason?: string;
}

/** The case facts from optimization_parameters.json, or undefined when the folder holds no optimization case. */
export function readOptimizationCaseInfo(caseDir: string): OptimizationCaseInfo | undefined {
  try {
    return optimizationCaseInfo(JSON.parse(fs.readFileSync(path.join(caseDir, OPTIMIZATION_PARAMETERS_FILE), "utf8")));
  } catch {
    return undefined;
  }
}

export function readOptimization(caseDir: string, opts: { maxBytes?: number } = {}): OptimizationRead {
  const info = readOptimizationCaseInfo(caseDir);
  if (!info) return { available: false, caseDir, reason: `No ${OPTIMIZATION_PARAMETERS_FILE} in this folder — generate an optimization case first.` };
  const summaryFile = path.resolve(caseDir, info.summaryFile);
  const rel = path.relative(caseDir, summaryFile);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { available: false, caseDir, info, reason: `The summary file "${info.summaryFile}" is outside the case folder.` };
  }
  const maxBytes = opts.maxBytes ?? SUMMARY_MAX_BYTES;
  let fd: number | undefined;
  try {
    fd = fs.openSync(summaryFile, "r");
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    let text = buf.toString("utf8");
    if (size > maxBytes) text = text.slice(text.indexOf("\n") + 1);
    const parsed = parseOptimizationSummary(text);
    if (size > maxBytes) parsed.warnings.push(`Only the last ${length} bytes of ${size} were read; the header and earlier steps may be missing.`);
    return { available: true, caseDir, info, summaryFile, parsed };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      available: false,
      caseDir,
      info,
      summaryFile,
      reason: code === "ENOENT" ? `No optimization progress yet (${info.summaryFile} has not been written).` : `The summary could not be read: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function readOptimizationSummary(caseDir: string, runStatus?: string): OptimizationSummary | undefined {
  const read = readOptimization(caseDir);
  return read.parsed && read.info ? summarizeOptimization(read.parsed, read.info, runStatus) : undefined;
}

/**
 * The optimization case a file belongs to: its own folder or one of up to
 * `levels` parents holding optimization_parameters.json. A design-field file
 * lives in Optimization_Results/ (or a subfolder of it), the mesh beside the
 * case; both find the same case.
 */
export function findOptimizationCase(fileOrDir: string, levels = 3): string | undefined {
  let dir = fs.existsSync(fileOrDir) && fs.statSync(fileOrDir).isDirectory() ? fileOrDir : path.dirname(fileOrDir);
  for (let i = 0; i <= levels; i++) {
    if (fs.existsSync(path.join(dir, OPTIMIZATION_PARAMETERS_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
