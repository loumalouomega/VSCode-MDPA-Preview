/**
 * Shared helpers for the export-report tests: the reference fixture (every kind
 * of state a lossy export could drop, with non-trivial ids so "retained" cannot
 * pass by coincidence) and a write-to-disk-and-re-read round trip.
 *
 * Not a test file itself (no `.test.` in the name), so `node --test` skips it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseMdpa } from "../parser/mdpaParser";
import { renumberModel } from "../parser/renumberMesh";
import { parseMeshFile } from "../parser/meshFileParser";
import { writeMeshFileAsync } from "../parser/writers/meshWriter";
import { meshStem } from "../parser/meshFormats";
import { MdpaModel } from "../parser/types";
import { fidelityKey, observeExport, BaseCategory } from "../parser/exportReport";
import { EXPORTABLE_EXTENSIONS, EXPORT_FORMAT_FLAVOURS } from "../parser/writers/exportFormats";
import type { MeasuredEntry } from "../parser/exportFidelityTable";
import { EXPORT_REFERENCES } from "../parser/exportReferences";

const FIXTURE = `Begin Properties 0
End Properties

Begin Properties 1
DENSITY 2700.0
CONSTITUTIVE_LAW LinearElastic3DLaw
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 1.0 1.0 0.0
4 0.0 1.0 0.0
5 0.0 0.0 1.0
6 1.0 0.0 1.0
7 1.0 1.0 1.0
8 0.0 1.0 1.0
End Nodes

Begin Elements Element3D8N
1 1 1 2 3 4 5 6 7 8
End Elements

Begin Conditions SurfaceCondition3D4N
1 0 1 2 3 4
End Conditions

Begin NodalData TEMPERATURE
1 0 10.0
2 0 20.0
3 0 30.0
4 0 40.0
5 0 50.0
6 0 60.0
7 0 70.0
8 0 80.0
End NodalData

Begin NodalData DISPLACEMENT
1 (0.0, 0.0, 0.0)
2 (0.1, 0.0, 0.0)
3 (0.1, 0.1, 0.0)
4 (0.0, 0.1, 0.0)
5 (0.0, 0.0, 0.1)
6 (0.1, 0.0, 0.1)
7 (0.1, 0.1, 0.1)
8 (0.0, 0.1, 0.1)
End NodalData

Begin ElementalData DENSITY_FACTOR
1 1.5
End ElementalData

Begin Constraints LinearMasterSlaveConstraint DISPLACEMENT_X
1 0.0 [0.5] 1 2
End Constraints

Begin SubModelPart Outer
  Begin SubModelPart Inner
    Begin SubModelPartNodes
    1
    2
    3
    4
    5
    6
    7
    8
    End SubModelPartNodes
    Begin SubModelPartElements
    1
    End SubModelPartElements
    Begin SubModelPartConditions
    1
    End SubModelPartConditions
  End SubModelPart
End SubModelPart
`;

/**
 * The reference model, renumbered so ids are neither 1-based nor equal across
 * kinds, plus the three slots a text fixture cannot express: a global spec, a
 * field with recorded dimensions and source metadata.
 */
export function referenceModel(): MdpaModel {
  const base = parseMdpa(FIXTURE);
  const model = renumberModel(base, { target: "all", start: 101 }).model;
  return {
    ...model,
    fields: model.fields.map((f) =>
      f.variable === "TEMPERATURE" ? { ...f, dimensions: { exponents: [0, 0, 0, 1, 0, 0, 0] } } : f
    ),
    globals: { max_temp: { variable: "TEMPERATURE", kind: "Nodal", reduction: "max" } },
    source: { format: ".mdpa", meshName: "reference" },
  };
}

/** Nondegenerate simplex variants measure writers the hex fixture cannot use. */
export function referenceModels(): Record<string, MdpaModel> {
  const fixture = FIXTURE
    .replace(/Begin Nodes[\s\S]*?End Nodes/, "Begin Nodes\n1 0 0 0\n2 1 0 0\n3 0 1 0\n4 0 0 1\nEnd Nodes")
    .replace(/Begin Elements[\s\S]*?End Elements/, "Begin Elements Element3D4N\n1 1 1 2 3 4\nEnd Elements")
    .replace(/Begin Conditions[\s\S]*?End Conditions/, "Begin Conditions SurfaceCondition3D3N\n1 0 1 2 3\nEnd Conditions")
    .replace(/^([5-8]) .*\n/gm, "")
    .replace(/^     [5-8]\n/gm, "");
  const model = renumberModel(parseMdpa(fixture + `
Begin ElementalData CELL_VECTOR
1 (1.0, 2.0, 3.0)
End ElementalData
Begin ConditionalData FLUX
1 2.5
End ConditionalData
Begin ConditionalData TRACTION
1 (3.0, 4.0, 5.0)
End ConditionalData
`), { target: "all", start: 101 }).model;
  model.fields = model.fields.map((f) => f.variable === "TEMPERATURE" ? { ...f, dimensions: { exponents: [0, 0, 0, 1, 0, 0, 0] } } : f);
  model.globals = { max_temp: { variable: "TEMPERATURE", kind: "Nodal", reduction: "max" } };
  model.source = { format: ".mdpa", meshName: "simplicial-reference" };
  const without = (kind: "Elements" | "Conditions", fieldKind: "Elemental" | "Conditional"): MdpaModel => ({
    ...model,
    blocks: model.blocks.filter((b) => b.kind !== kind),
    fields: model.fields.filter((f) => f.kind !== fieldKind),
    subModelParts: model.subModelParts.map((p) => ({ ...p, elementIds: new Int32Array(), conditionIds: new Int32Array(), children: p.children.map((c) => ({ ...c, elementIds: kind === "Elements" ? new Int32Array() : c.elementIds, conditionIds: kind === "Conditions" ? new Int32Array() : c.conditionIds })) })),
  });
  const triangle = without("Elements", "Elemental");
  // A genuinely 2D triangle (no unused point above its plane).
  triangle.nodeCount = 3;
  triangle.nodeIds = triangle.nodeIds.slice(0, 3);
  triangle.coords = triangle.coords.slice(0, 9);
  triangle.bounds = { min: [0, 0, 0], max: [1, 1, 0] };
  triangle.fields = triangle.fields.map((f) => f.kind === "Nodal" ? { ...f, ids: f.ids.slice(0, 3), values: f.values.slice(0, 3 * f.components) } : f);
  triangle.subModelParts = triangle.subModelParts.map((p) => ({ ...p, children: p.children.map((c) => ({ ...c, nodeIds: c.nodeIds.slice(0, 3) })) }));
  return { hex: referenceModel(), simplicial: model, tetra: without("Conditions", "Conditional"), triangle };
}

export interface RoundTrip {
  ext: string;
  format?: string;
  /** The model that was written. */
  written: MdpaModel;
  /** The model read back, or undefined when the round trip failed. */
  reread?: MdpaModel;
  warnings: string[];
  companions: string[];
  file: string;
  error?: string;
}

/** Writes `model` as `ext` into a fresh temp dir (companions included) and re-reads it. */
export async function roundTrip(model: MdpaModel, ext: string, format?: string): Promise<RoundTrip> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kratos-report-"));
  const file = path.join(dir, `out${ext}`);
  const warnings: string[] = [];
  const result: RoundTrip = { ext, format, written: model, warnings, companions: [], file };
  try {
    const { data, companions } = await writeMeshFileAsync(model, ext, {
      name: meshStem(file),
      format,
      onWarning: (m) => warnings.push(m),
    });
    fs.writeFileSync(file, data);
    for (const c of companions) {
      const dest = path.join(dir, c.name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, c.data);
      result.companions.push(c.name);
    }
    result.reread = await parseMeshFile(file, undefined, format ? { meshioFormat: format } : undefined);
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  }
  return result;
}

const CODE = { retained: "r", transformed: "t", omitted: "o" } as const;

/** The same fresh round trips also grade reports, without loading wasm twice. */
export const measuredRoundTrips = new Map<string, RoundTrip>();

/**
 * Measures every writer against `referenceModel()`: writes, re-reads, and
 * records what `observeExport` found. One entry per fidelity key (the first
 * extension routed to it) plus each ambiguous extension's flavours, forced by
 * key. A writer whose output this extension cannot re-read from the reference
 * mesh (a single-cell-type container, 2D-only, write-only figures) is recorded
 * as `unmeasured` with the reason — never guessed at.
 *
 * The output is what `scripts/gen-export-fidelity.js` writes into
 * `src/parser/exportFidelityTable.ts`, and what `exportReport.test.ts` pins.
 */
export async function measureAll(): Promise<Record<string, MeasuredEntry>> {
  const models = referenceModels();
  const jobs = writerJobs();
  const out: Record<string, MeasuredEntry> = {};
  for (const j of jobs) {
    const references: MeasuredEntry["references"] = {};
    for (const id of Object.keys(EXPORT_REFERENCES)) {
      const model = models[id];
      const rt = await roundTrip(model, j.ext, j.format);
      measuredRoundTrips.set(`${id}:${j.key}`, rt);
      if (rt.error?.startsWith("Unsupported mesh file extension")) {
        references[id] = { unmeasured: "write-only format: this extension has no reader to check the output against" };
        continue;
      }
      if (rt.error || !rt.reread) {
        references[id] = { unmeasured: (rt.error ?? "the output could not be re-read").replace(/\s+/g, " ").trim().slice(0, 160) };
        continue;
      }
      const base: Partial<Record<BaseCategory, "r" | "t" | "o">> = {};
      const fields: Record<string, "r" | "t" | "o"> = {};
      for (const o of observeExport(model, rt.reread)) {
        if (o.id.startsWith("field:")) {
          const [, kind, variable] = o.id.split(":");
          const f = model.fields.find((x) => x.kind === kind && x.variable === variable)!;
          fields[`${kind}:${f.components}`] = CODE[o.status];
        } else base[o.id as BaseCategory] = CODE[o.status];
      }
      references[id] = { base, fields };
    }
    out[j.key] = { references };
  }
  return out;
}

export function writerJobs(): { key: string; ext: string; format?: string }[] {
  const jobs: { key: string; ext: string; format?: string }[] = [];
  const seen = new Set<string>();
  for (const ext of EXPORTABLE_EXTENSIONS) {
    const key = fidelityKey(ext);
    if (seen.has(key)) continue;
    seen.add(key);
    jobs.push({ key, ext });
  }
  for (const [ext, keys] of Object.entries(EXPORT_FORMAT_FLAVOURS)) {
    for (const key of keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push({ key, ext, format: key });
    }
  }
  return jobs.sort((a, b) => a.key.localeCompare(b.key));
}
