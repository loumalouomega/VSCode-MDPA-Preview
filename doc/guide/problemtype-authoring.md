# Authoring Problemtypes (JavaScript)

A **problemtype** teaches the extension how to build `ProjectParameters.json`
for one kind of Kratos analysis: which solver settings to expose, which
boundary conditions exist and how each maps to a Kratos process, which
constitutive laws apply, and what to write to `vtk_output`.

Drop a `.js` file in `.kratos/problemtypes/` inside your workspace (or any
directory listed in the `kratos.problemtypes.extraPaths` setting) and it
appears in the Problemtype dropdown next to the built-ins. Files are reloaded
every time an MDPA preview opens; a file that fails to load shows up as a
disabled entry with the error, never breaking the preview.

## The model

`defineProblemtype(declaration, hooks)` takes two arguments:

- a **declaration** — plain JSON describing metadata, form fields, conditions
  and materials. The sidebar renders the forms directly from it.
- **hooks** — functions for the parts that need logic. Only
  `solverSettings` is required; everything else has sensible defaults.

The file runs in a sandbox: `defineProblemtype` is the only API available
(no `require`, no filesystem). Declaration evaluation is capped at 2 seconds.

## A complete example

```js
// .kratos/problemtypes/my_thermal.js
defineProblemtype({
  id: "myThermal",                       // unique; stored in the case file
  name: "My Thermal",                    // shown in the dropdown
  description: "Custom transient heat transfer",
  analysisStage:
    "KratosMultiphysics.ConvectionDiffusionApplication.convection_diffusion_analysis",
  modelPartName: "ThermalModelPart",     // root model part
  materialsFileName: "ThermalMaterials.json",
  domainSizes: [2, 3],

  // Rendered as collapsible forms; field ids must be unique across sections.
  sections: [
    { id: "problem", label: "Problem data", fields: [
      { id: "timeStep", label: "Time step", type: "number", default: 0.1 },
      { id: "endTime",  label: "End time",  type: "number", default: 1.0 },
      { id: "echoLevel", label: "Echo level", type: "int", default: 1 },
    ]},
  ],

  // The Parts pseudo-condition marks the computing domain (no process emitted).
  partsCondition: "parts",
  conditions: [
    { id: "parts", label: "Thermal body", list: "list_other_processes",
      target: "volume", fields: [], processTemplate: {} },

    { id: "temperature", label: "Fixed temperature",
      list: "constraints_process_list",   // constraints | loads | other
      target: "any",                      // hint for the SubModelPart picker
      fields: [{ id: "value", label: "T [K]", type: "number", default: 293.15 }],
      // Declarative process mapping. Placeholders resolved per assignment:
      //   "$path"       → "ThermalModelPart.Boundary.Left" (the assigned part)
      //   "$root"       → "ThermalModelPart"
      //   "$field:<id>" → the assignment's value for that field
      processTemplate: {
        python_module: "assign_scalar_variable_process",
        kratos_module: "KratosMultiphysics",
        process_name: "AssignScalarVariableProcess",
        Parameters: {
          model_part_name: "$path",
          variable_name: "TEMPERATURE",
          constrained: true,
          value: "$field:value",
          interval: [0.0, "End"],
        },
      }},
  ],

  materialLaws: [
    { id: "thermal", name: "",            // empty name = no constitutive_law block
      variables: [
        { id: "DENSITY", label: "ρ", type: "number", default: 1000 },
        { id: "CONDUCTIVITY", label: "k", type: "number", default: 0.6 },
        { id: "SPECIFIC_HEAT", label: "c", type: "number", default: 4184 },
      ]},
  ],

  output: { nodalDefaults: ["TEMPERATURE"] },
}, {
  // Required: builds solver_settings from the (flattened) form values.
  solverSettings: (values, ctx) => ({
    solver_type: "transient",
    analysis_type: "linear",
    model_part_name: ctx.modelPartName,
    domain_size: ctx.domainSize,
    model_import_settings: { input_type: "mdpa", input_filename: ctx.mdpaStem },
    material_import_settings: { materials_filename: ctx.materialsFileName },
    echo_level: values.echoLevel,
    problem_domain_sub_model_part_list: ctx.partsModelParts,
    processes_sub_model_part_list: ctx.skinModelParts,
    time_stepping: { time_step: values.timeStep },
  }),
});
```

## Field types

| `type` | Rendered as | Value |
|---|---|---|
| `number` | numeric input | `number` |
| `int` | numeric input (step 1) | `number` |
| `string` | text input | `string` |
| `bool` | checkbox | `boolean` |
| `enum` | dropdown (needs `options: [{value, label?}]`) | `string` |
| `vector3` | three numeric inputs | `[number, number, number]` |

Fields also accept `help` (tooltip) and
`visibleWhen: { field, equals }` (show only when another field of the same
form has a value).

## The hook context

Every hook receives a plain-JSON `ctx`:

| Key | Contents |
|---|---|
| `mdpaStem` | mdpa file name without extension (`model_import_settings.input_filename`) |
| `domainSize` | `2` or `3`, derived from the mesh and clamped to `domainSizes` |
| `modelPartName`, `materialsFileName` | from the declaration |
| `values` | all section field values flattened (defaults merged in) |
| `assignments`, `materials` | the raw user assignments |
| `partsModelParts` | dotted names of the Parts assignments (e.g. `["FluidModelPart.Parts.Fluid"]`) |
| `skinModelParts` | dotted names of every non-Parts assignment |
| `subModelParts` | all SubModelPart paths available in the mesh |

## Optional hooks

```ts
buildProcess(cond, assignment, ctx)   // → process object, or undefined to
                                      //   fall back to the processTemplate
postProcess(projectParameters, ctx)   // → last-chance mutation of the document
mainScript(ctx)                       // → replaces the default MainKratos.py
```

`buildProcess` is the escape hatch for processes a static template cannot
express — the built-in Structural problemtype uses it to broadcast a single
"Fixed" checkbox into Kratos' per-component `constrained: [true, true, true]`,
and the built-in Fluid problemtype derives `volume_model_part_name` /
`skin_parts` from the assignments inside `solverSettings`.

## Generated document shape

```json
{
  "analysis_stage": "...",
  "problem_data":   { "problem_name", "parallel_type", "echo_level", "start_time", "end_time" },
  "solver_settings": { ...your solverSettings hook... },
  "processes": {
    "constraints_process_list": [ ...assignments... ],
    "loads_process_list":       [ ...assignments... ],
    "list_other_processes":     [ ...assignments... ]
  },
  "output_processes": { "gid_output": [], "vtk_output": [ ...always present... ] }
}
```

`problem_data.start_time` / `end_time` / `echo_level` are read from the
flattened values under the conventional ids `startTime`, `endTime`,
`echoLevel` (defaults `0`, `1`, `1`).

Prefer Python? The same API is available as a
[Python module](./problemtype-python), and faithful Python ports of the three
built-in problemtypes ship as copyable examples in
[`example/problemtypes/`](https://github.com/loumalouomega/VSCode-MDPA-Preview/tree/master/example/problemtypes).
