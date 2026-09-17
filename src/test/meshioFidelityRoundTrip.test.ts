/**
 * The acceptance fixture for roadmap item 1 ("Consolidate the meshio++
 * adapter"): a mixed-kind mesh with colliding per-kind ids, a vector AND a
 * tensor nodal field, Properties (a number, a verbatim constitutive-law
 * string, and a nested Table), constraints, and a nested SubModelPart —
 * i.e. every piece of state a plain meshio round trip would lose — driven
 * through carry -> real wasm op -> adopt for both a shape-preserving op
 * (transform, identity matrix) and a RESTRUCTURING op (convertCells
 * simplexify, which fans the one hex element into six tets and — measured
 * against the live wasm — drops mesh-level propertySets).
 *
 * Runs the real WASM, like oracleOps.test.ts / meshio.test.ts.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { parseMdpa } from "../parser/mdpaParser";
import { modelToMeshio } from "../parser/meshioConvert";
import { adoptMeshioMesh, FidelityReport } from "../parser/meshioFidelity";
import { loadMeshio } from "../parser/meshio";
import { MdpaDiagnostic, MdpaModel } from "../parser/types";

// A hex Element, a triangle Condition and a triangle Geometry — all with id
// 1, in their own independent id spaces (the acceptance criterion's
// "colliding per-kind ids"). A vector (DISPLACEMENT) and a tensor
// (STRESS_TENSOR, 9 components) nodal field. Properties 1 carries a number
// and a verbatim constitutive-law string (see propertiesParser.test.ts for
// the nested-Table round trip, which is that module's own, already-covered
// concern). One linear constraint. A nested SubModelPart: Outer (no
// entities of its own) / Inner (owns nodes, the element, the condition and
// the geometry).
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

Begin Conditions Condition3D3N
1 0 1 2 3
End Conditions

Begin Geometries Triangle3D3
1 5 6 7
End Geometries

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

Begin NodalData STRESS_TENSOR
1 (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)
2 (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)
3 (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)
4 (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)
5 (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)
6 (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)
7 (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)
8 (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)
End NodalData

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

function fixture(): MdpaModel {
  return parseMdpa(FIXTURE);
}

// Not asserted by mdpaParser.ts today (Geometries membership rides
// SubModelPartElements' sibling list only via the writer, not the reader) —
// so this test adds the geometry id onto Inner directly, matching what a
// real writer/reader round trip would carry.
function withGeometryMembership(model: MdpaModel): MdpaModel {
  const walk = (p: MdpaModel["subModelParts"][number]): typeof p =>
    p.name === "Inner" ? { ...p, geometryIds: Int32Array.from([1]) } : { ...p, children: p.children.map(walk) };
  return { ...model, subModelParts: model.subModelParts.map(walk) };
}

function assertBaseFixtureShape(model: MdpaModel): void {
  assert.equal(model.nodeCount, 8);
  assert.equal(model.blocks.find((b) => b.kind === "Elements")?.entityIds[0], 1);
  assert.equal(model.blocks.find((b) => b.kind === "Conditions")?.entityIds[0], 1);
  assert.equal(model.blocks.find((b) => b.kind === "Geometries")?.entityIds[0], 1);
  assert.ok(model.properties?.some((p) => p.id === 1));
  assert.ok(model.constraints?.some((b) => b.rows.length > 0));
}

test("fixture sanity: colliding per-kind ids, both fields, properties, constraints, nesting", () => {
  const model = withGeometryMembership(fixture());
  assertBaseFixtureShape(model);
  const disp = model.fields.find((f) => f.variable === "DISPLACEMENT");
  const stress = model.fields.find((f) => f.variable === "STRESS_TENSOR");
  assert.equal(disp?.components, 3);
  assert.equal(stress?.components, 9);
  const outer = model.subModelParts.find((p) => p.name === "Outer");
  const inner = outer?.children.find((p) => p.name === "Inner");
  assert.equal(outer?.path, "Outer");
  assert.equal(inner?.path, "Outer/Inner");
  assert.deepEqual(Array.from(inner?.geometryIds ?? []), [1]);
});

async function adopt(
  model: MdpaModel,
  op: string,
  run: (m: Awaited<ReturnType<typeof loadMeshio>>, mesh: ReturnType<typeof modelToMeshio>) => ReturnType<typeof modelToMeshio>
): Promise<{ model: MdpaModel; report: FidelityReport }> {
  const diagnostics: MdpaDiagnostic[] = [];
  const carried = modelToMeshio(model, diagnostics, { dim: 3, carriers: true });
  const m = await loadMeshio();
  const result = run(m, carried);
  return adoptMeshioMesh(model, result, diagnostics, { op });
}

test("carry -> transform (identity, shape-preserving) -> adopt preserves every slot", async () => {
  const base = withGeometryMembership(fixture());
  const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const { model, report } = await adopt(base, "transform", (m, mesh) => m.transform(mesh, IDENTITY, false));

  // Ids, per-kind, including the deliberate collision.
  assert.deepEqual(report.generated, { nodes: 0, elements: 0, conditions: 0, geometries: 0 });
  const elBlock = model.blocks.find((b) => b.kind === "Elements");
  const condBlock = model.blocks.find((b) => b.kind === "Conditions");
  const geomBlock = model.blocks.find((b) => b.kind === "Geometries");
  assert.deepEqual(Array.from(elBlock!.entityIds), [1]);
  assert.deepEqual(Array.from(condBlock!.entityIds), [1]);
  assert.deepEqual(Array.from(geomBlock!.entityIds), [1]);
  assert.deepEqual(Array.from(elBlock!.propertyIds ?? []), [1]);

  // Properties: carried through propertySets (transform passes them through).
  assert.ok(report.retained.includes("properties"));
  const props = model.properties?.find((p) => p.id === 1);
  assert.equal(props?.variables.DENSITY?.kind, "number");
  assert.equal((props?.variables.DENSITY as { kind: "number"; value: number }).value, 2700);
  assert.equal(props?.variables.CONSTITUTIVE_LAW?.kind, "string");
  assert.equal((props?.variables.CONSTITUTIVE_LAW as { kind: "string"; value: string }).value, "LinearElastic3DLaw");

  // Constraints: node 1 and 2 both survive identically, so the constraint is untouched.
  assert.ok(report.retained.includes("constraints") || report.lost.every((l) => l.slot !== "constraints"));
  assert.ok(model.constraints && model.constraints.length > 0);

  // Nested SubModelParts, including the entity-less parent.
  const outer = model.subModelParts.find((p) => p.name === "Outer");
  assert.ok(outer, "Outer parent was not recovered");
  const inner = outer?.children.find((p) => p.name === "Inner");
  assert.ok(inner, "Inner child was not recovered");
  assert.equal(inner?.path, "Outer/Inner");
  assert.deepEqual(Array.from(inner?.nodeIds ?? []).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(Array.from(inner?.elementIds ?? []), [1]);
  assert.deepEqual(Array.from(inner?.conditionIds ?? []), [1]);

  // Fields: both component counts survive.
  const disp = model.fields.find((f) => f.kind === "Nodal" && f.variable === "DISPLACEMENT");
  const stress = model.fields.find((f) => f.kind === "Nodal" && f.variable === "STRESS_TENSOR");
  assert.equal(disp?.components, 3);
  assert.equal(stress?.components, 9);

  // Only the documented, unconditional losses remain: block display names
  // (never recovered — see the module doc) and the Nodal is_fixed flag
  // (mdpaParser.ts attaches a `fixed` Uint8Array to EVERY Nodal field it
  // parses, all-zero or not, so this fixture always carries one).
  const lostSlots = report.lost.map((l) => l.slot).sort();
  assert.deepEqual(lostSlots, ["blockNames", "fieldFixedFlags"]);
});

test("carry -> convertCells simplexify (restructuring) -> adopt reports what it could not retain", async () => {
  const base = withGeometryMembership(fixture());
  const { model, report } = await adopt(base, "convertCells:simplexify", (m, mesh) =>
    m.convertCells(mesh, "simplexify", true)
  );

  // The hex fanned into six tets; all six carry the SAME source entity id
  // (measured against the live wasm), so five of them cannot keep it and are
  // reported as generated rather than silently claimed as "1".
  const elBlock = model.blocks.find((b) => b.kind === "Elements");
  assert.equal(elBlock?.count, 6);
  assert.equal(elBlock?.vtkCellType, 10); // VTK_TETRA
  assert.equal(report.generated.elements, 5);
  assert.ok(report.lost.some((l) => l.slot === "entityIds"));

  // The boundary triangle Condition and Geometry are untouched by simplexify
  // (already simplices) and keep their original id exactly.
  const condBlock = model.blocks.find((b) => b.kind === "Conditions");
  const geomBlock = model.blocks.find((b) => b.kind === "Geometries");
  assert.deepEqual(Array.from(condBlock!.entityIds), [1]);
  assert.deepEqual(Array.from(geomBlock!.entityIds), [1]);

  // propertySets are dropped by this restructuring op (measured) — the base's
  // Properties are carried forward verbatim instead of being lost outright.
  assert.ok(report.lost.some((l) => l.slot === "properties"));
  const props = model.properties?.find((p) => p.id === 1);
  assert.equal(props?.variables.DENSITY?.kind, "number");

  // SubModelPart membership still resolves: the region entries were remapped
  // by the op onto all six child tets (upstream's own documented behaviour
  // for convert_cells), and the Condition/Geometry ids are unchanged.
  const outer = model.subModelParts.find((p) => p.name === "Outer");
  const inner = outer?.children.find((p) => p.name === "Inner");
  assert.ok(inner, "Inner child was not recovered after a restructuring op");
  assert.equal(inner?.elementIds.length, 6);
  assert.deepEqual(Array.from(inner?.conditionIds ?? []), [1]);

  // Constraints are unaffected (only elements were restructured; the
  // constraint's nodes 1 and 2 both survive unchanged).
  assert.ok(model.constraints && model.constraints.length > 0);
});

test("a result with a ragged cell block falls back to the plain read path and reports every slot lost", async () => {
  const base = withGeometryMembership(fixture());
  const diagnostics: MdpaDiagnostic[] = [];
  const carried = modelToMeshio(base, diagnostics, { dim: 3, carriers: true });
  // Synthesize a ragged (polygon) block the way meshio++ itself could hand
  // one back, without needing a real op that produces one.
  const ragged = {
    ...carried,
    cells: [...carried.cells, { type: "polygon", data: new Int32Array([0, 1, 2, 3]), rowOffsets: new Int32Array([0, 4]) }],
  };
  const { report } = adoptMeshioMesh(base, ragged, diagnostics, { op: "syntheticRagged" });
  assert.deepEqual(report.retained, []);
  assert.ok(report.lost.length > 0);
  assert.ok(report.lost.every((l) => l.reason.includes("ragged")));
});
