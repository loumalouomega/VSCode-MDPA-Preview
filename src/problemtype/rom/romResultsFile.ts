/** The `node:fs` half of the ROM results reader (see romResults.ts). */

import * as fs from "node:fs";
import * as path from "node:path";

import { parseNpy } from "../../parser/npyReader";
import { ROM_PROGRESS, ROM_SAMPLES, ROM_SUMMARY } from "../mainKratosTemplate";
import { parseRomProgress, RomResults } from "./romResults";

export const ROM_DATA_FOLDER = "rom_data";

const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, "utf8"));
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** True when the folder holds a generated ROM case (its samples file). */
export function isRomCase(caseDir: string): boolean {
  return fs.existsSync(path.join(caseDir, ROM_SAMPLES));
}

export function readRomResults(caseDir: string): RomResults {
  const out: RomResults = { progress: [], malformedProgress: 0, warnings: [] };
  const data = path.join(caseDir, ROM_DATA_FOLDER);
  try {
    const params = readJson(path.join(data, "RomParameters.json"));
    if (isObject(params)) {
      const settings = isObject(params.rom_settings) ? params.rom_settings : {};
      if (typeof settings.number_of_rom_dofs === "number") out.modes = settings.number_of_rom_dofs;
      if (typeof params.projection_strategy === "string") out.projectionStrategy = params.projection_strategy;
    }
  } catch {
    /* not written yet */
  }
  const npy = (name: string): number[] | undefined => {
    const file = path.join(data, name);
    if (!fs.existsSync(file)) return undefined;
    try {
      return parseNpy(fs.readFileSync(file)).data;
    } catch (err) {
      out.warnings.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  };
  out.singularValues = npy("SingularValuesVector.npy");
  out.hromElements = npy("HROM_ElementIds.npy");
  out.hromConditions = npy("HROM_ConditionIds.npy");
  out.hromElementWeights = npy("HROM_ElementWeights.npy");
  try {
    const parsed = parseRomProgress(fs.readFileSync(path.join(caseDir, ROM_PROGRESS), "utf8"));
    out.progress = parsed.records;
    out.malformedProgress = parsed.malformed;
  } catch {
    /* no runs yet */
  }
  try {
    const s = readJson(path.join(caseDir, ROM_SUMMARY));
    if (isObject(s)) out.summary = s as RomResults["summary"];
  } catch {
    /* not finished */
  }
  try {
    const s = readJson(path.join(caseDir, ROM_SAMPLES));
    if (isObject(s)) {
      out.samples = {
        names: Array.isArray(s.mu_names) ? s.mu_names.filter((n): n is string => typeof n === "string") : [],
        train: Array.isArray(s.mu_train) ? s.mu_train.length : 0,
        test: Array.isArray(s.mu_test) ? s.mu_test.length : 0,
      };
    }
  } catch {
    /* not a ROM case */
  }
  return out;
}
