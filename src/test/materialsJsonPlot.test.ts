/** Materials-file tables as plot recipes: read from the file the generator really writes, tolerant per table, recipes the plot library accepts and draws. */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { generateCase } from "../problemtype/generate";
import { defaultCaseState } from "../problemtype/api";
import { fluid } from "../problemtype/builtins/fluid";
import { MATERIALS_MAX_TABLES_PER_PLOT, materialTablesFromCase, materialsPlotRecipes, materialsTables } from "../problemtype/materialsJsonPlot";
import { collectPlot } from "../parser/plot/sources";
import { validatePlotRecipe } from "../parser/plot/recipe";

const MDPA = `Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
4 0.0 0.0 1.0
End Nodes

Begin Elements Element3D4N
1 0 1 2 3 4
End Elements

Begin SubModelPart Parts
  Begin SubModelPart Fluid
    Begin SubModelPartNodes
    1
    2
    3
    4
    End SubModelPartNodes
    Begin SubModelPartElements
    1
    End SubModelPartElements
  End SubModelPart
End SubModelPart
`;

async function generatedMaterials(table: string): Promise<unknown> {
  const s = defaultCaseState(fluid.decl);
  s.assignments = [{ conditionId: "parts", smpPath: "Parts/Fluid", values: {} }];
  s.materials = [{ smpPath: "Parts/Fluid", lawId: "temperature_dependent_3d", values: { DENSITY: 997, TEMPERATURE_TABLE: table } }];
  const out = await generateCase(fluid, parseMdpa(MDPA), s, "case");
  return JSON.parse(out.materials);
}

test("the file the generator writes reads back as one table with its variables and part", async () => {
  const read = materialsTables(await generatedMaterials("293.15,1e-3; 323.15,5.5e-4; 373.15,2.8e-4"));
  assert.deepEqual(read.notes, []);
  assert.equal(read.tables.length, 1);
  const t = read.tables[0];
  assert.deepEqual([t.inputVariable, t.outputVariable, t.tableId], ["TEMPERATURE", "DYNAMIC_VISCOSITY", "Table1"]);
  assert.match(t.label, /FluidModelPart\.Parts\.Fluid · Table1/);
  assert.deepEqual(t.rows, [[293.15, 1e-3], [323.15, 5.5e-4], [373.15, 2.8e-4]]);
});

test("the recipe validates and the plot library draws every table point, with no unit claimed", async () => {
  const plots = materialsPlotRecipes(materialsTables(await generatedMaterials("293.15,1e-3; 373.15,2.8e-4")), "materials.json");
  assert.equal(plots.length, 1);
  const { recipe, title } = plots[0];
  assert.match(title, /DYNAMIC_VISCOSITY vs TEMPERATURE — materials\.json/);
  assert.equal(recipe.presentation.xLabel, "TEMPERATURE");
  const dataset = await collectPlot(validatePlotRecipe(recipe));
  assert.equal(dataset.series.length, 1);
  assert.deepEqual(dataset.series[0].points.map((p) => [p.x, p.y]), [[293.15, 1e-3], [373.15, 2.8e-4]]);
  const columns = recipe.sources.flatMap((s) => (s.type === "inline" ? s.table.columns : []));
  assert.ok(columns.every((c) => c.unit === undefined), "a materials file declares no unit, so none is claimed");
});

const doc = (properties: unknown) => ({ properties });
const material = (tables: unknown, extra: Record<string, unknown> = {}) => ({ model_part_name: "M.A", properties_id: 1, Material: { Tables: tables }, ...extra });

test("tables group by their variable pair, one chart each, one line per table", () => {
  const e = (a: string, b: string, data: unknown) => ({ input_variable: a, output_variable: b, data });
  const read = materialsTables(
    doc([
      material({ T1: e("TEMPERATURE", "YOUNG_MODULUS", [[0, 1], [1, 2]]), T2: e("TEMPERATURE", "POISSON_RATIO", [[0, 0.3], [1, 0.31]]) }),
      material({ T1: e("TEMPERATURE", "YOUNG_MODULUS", [[0, 2], [1, 3]]) }, { model_part_name: "M.B", properties_id: 2 }),
    ])
  );
  const plots = materialsPlotRecipes(read, "f.json");
  assert.equal(plots.length, 2);
  const young = plots.find((p) => /YOUNG_MODULUS/.test(p.title))!;
  assert.equal(young.recipe.series.length, 2, "both materials' YOUNG_MODULUS tables share one chart");
  assert.deepEqual(young.recipe.series.map((s) => s.name), ["M.A · T1", "M.B · T1"]);
  assert.equal(plots.find((p) => /POISSON_RATIO/.test(p.title))!.recipe.series.length, 1);
});

test("a malformed table or row is skipped with a note and never stops the others", () => {
  const read = materialsTables(
    doc([
      "nonsense",
      { model_part_name: "NoTables", Material: { Variables: {} } },
      material({
        Good: { input_variable: "X", output_variable: "Y", data: [[0, 1], [1, 2], [2, "bad"], [3]] },
        NoData: { input_variable: "X", output_variable: "Y" },
        NoNames: { data: [[0, 1]] },
        Empty: { input_variable: "X", output_variable: "Y", data: [] },
        NotObject: 5,
      }),
    ])
  );
  assert.equal(read.tables.length, 1);
  assert.deepEqual(read.tables[0].rows, [[0, 1], [1, 2]]);
  const text = read.notes.join("\n");
  assert.match(text, /properties\[0\] is not an object/);
  assert.match(text, /Good: 2 row\(s\) are not a pair of finite numbers/);
  assert.match(text, /NoData: "data" is not a list/);
  assert.match(text, /NoNames: needs input_variable and output_variable/);
  assert.match(text, /Empty: no drawable rows/);
  assert.match(text, /NotObject: not a table object/);
  assert.ok(!/NoTables/.test(text), "a material without tables is ordinary, not a finding");
});

test("a table whose inputs do not increase is drawn as written and flagged", () => {
  const read = materialsTables(doc([material({ T: { input_variable: "X", output_variable: "Y", data: [[0, 1], [2, 2], [1, 3]] } })]));
  assert.deepEqual(read.tables[0].rows, [[0, 1], [2, 2], [1, 3]]);
  assert.match(read.notes.join(" "), /does not strictly increase/);
});

test("a file with no tables, or no properties, says so instead of an empty chart", () => {
  assert.match(materialsTables(doc([{ model_part_name: "M", Material: { Variables: {} } }])).notes[0], /no material Tables/);
  assert.match(materialsTables({ foo: 1 }).notes[0], /Not a Kratos materials file/);
  assert.match(materialsTables(null).notes[0], /Not a Kratos materials file/);
  assert.deepEqual(materialsPlotRecipes(materialsTables({}), "f"), []);
});

test("more tables than the recipe takes sources for fold into a note", () => {
  const tables: Record<string, unknown> = {};
  for (let i = 0; i < MATERIALS_MAX_TABLES_PER_PLOT + 3; i++) tables[`T${i}`] = { input_variable: "X", output_variable: "Y", data: [[0, i], [1, i + 1]] };
  const [plot] = materialsPlotRecipes(materialsTables(doc([material(tables)])), "f");
  assert.equal(plot.recipe.sources.length, MATERIALS_MAX_TABLES_PER_PLOT);
  assert.match(plot.notes.join(" "), /first 32 are drawn/);
  assert.doesNotThrow(() => validatePlotRecipe(plot.recipe));
});

test("the case on screen previews before generating, drawing the rows that parse and naming the rest", () => {
  const mat = (table: string) => ({ smpPath: "Parts/Fluid", lawId: "temperature_dependent_3d", values: { TEMPERATURE_TABLE: table } });
  const read = materialTablesFromCase(fluid.decl.materialLaws, [mat("293.15,1e-3; hot; 373.15,2.8e-4"), { smpPath: "Parts/Other", lawId: "newtonian_3d", values: {} }]);
  assert.equal(read.tables.length, 1);
  assert.deepEqual(read.tables[0].rows, [[293.15, 1e-3], [373.15, 2.8e-4]]);
  assert.equal(read.tables[0].label, "Parts/Fluid · Table1");
  assert.match(read.notes.join(" "), /"hot" is not an "input,output" pair/);
  assert.match(materialTablesFromCase(fluid.decl.materialLaws, [{ smpPath: "P", lawId: "newtonian_3d", values: {} }]).notes[0], /No material in this case has a table/);
  assert.equal(materialTablesFromCase(fluid.decl.materialLaws, [mat("")]).tables.length, 0);
});
