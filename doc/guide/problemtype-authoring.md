# Authoring Problemtypes (JavaScript)

A **problemtype** teaches the extension how to build `ProjectParameters.json` for one kind of Kratos analysis: which solver settings to expose, which boundary conditions exist and how each maps to a Kratos process, which constitutive laws apply, and what to write to `vtk_output`.

Drop a `.js` file in `.kratos/problemtypes/` inside your workspace (or any directory listed in the `kratos.problemtypes.extraPaths` setting) and it appears in the Problemtype dropdown next to the built-ins. Files are reloaded every time a mesh preview opens; a file that fails to load shows up as a disabled entry with the error, never breaking the preview.

## The model

`defineProblemtype(declaration, hooks)` takes two arguments:

- a **declaration** — plain JSON describing metadata, form fields, conditions and materials. The sidebar renders the forms directly from it.
- **hooks** — functions for the parts that need logic. Only `solverSettings` is required; everything else has sensible defaults.

The file runs in a sandbox: `defineProblemtype` is the only API available (no `require`, no filesystem). Declaration evaluation is capped at 2 seconds.

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
        { id: "DENSITY", label: "ρ", type: "number", default: 1000, unit: "kg/m³" },
        { id: "CONDUCTIVITY", label: "k", type: "number", default: 0.6, unit: "W/(m·K)" },
        { id: "SPECIFIC_HEAT", label: "c", type: "number", default: 4184, unit: "J/(kg·K)" },
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
| `numberList` / `stringList` | comma-separated text input | `number[]` / `string[]` |
| `smp` | SubModelPart picker | a slash-separated SubModelPart path |
| `smpList` | SubModelPart chips with an add picker | `string[]` of paths |
| `ref` | dropdown of the entry names of the collection named by `refCollection` | an entry name |
| `caseValue` | grouped dropdown of every numeric value of the case (only inside a [collection](#collections-named-repeatable-entries)) | a case-value address, see below |

Fields also accept `help` (tooltip) and `visibleWhen: { field, equals }` (show only when another field of the same form has a value).

## Units and material presets

A field may declare the unit its value is entered in:

```js
{ id: "DENSITY", label: "ρ", type: "number", default: 1000, unit: "kg/m³" }
```

It is optional, and it matters for [material presets](./simulation#material-presets): a catalog row's values are **converted into your field's unit** before they reach the case, which is what lets a row published in `g/cm³` fill a variable declared in `kg/m³`. Without it the unit is inferred from the brackets in `label` (`"Density [kg/m³]"`), then from a well-known Kratos variable name (`DENSITY`, `YOUNG_MODULUS`, `DYNAMIC_VISCOSITY`, …). When no unit can be established on either side, a preset value is only accepted as an exact match — it is never passed through unconverted, because a number in unknown units is not a number anyone can defend.

The recognised quantities are density, length, time, mass, force, pressure and stiffness modulus (`Pa`, `kPa`, `MPa`, `GPa`, `bar`, `psi`, `ksi`), dynamic viscosity (`Pa·s`, `mPa·s`, `cP`, `P`), kinematic viscosity (`m²/s`, `mm²/s`, `cSt`, `St`), thermal conductivity, specific heat and dimensionless ratios — the latter two are useful for dimensionless material inputs. Conversions are **factors, never offsets**, so an affine unit (°C, °F) is deliberately absent; declare such a field with no `unit` rather than pretending to convert it.

A preset is applied against a law by variable **id**, and a law may also state a variable set a catalog row can fill by adding its id to the preset's `laws` array. A law that no shipped or user row names simply offers no presets in the form — the numeric fields still work.

## Material laws

A law carries more than its variables when its name (or the factory it configures) comes from a Kratos application and its `constitutive_law` block needs settings:

```js
materialLaws: [
  { id: "linear_elastic_3d", name: "LinearElastic3DLaw", group: "Elastic", variables: [ /* … */ ] },
  { id: "vm_plasticity", name: "SmallStrainIsotropicPlasticityFactory", group: "Plasticity",
    application: "ConstitutiveLawsApplication",          // required by the driver when a material uses the law
    parameters: { law_type: "SmallStrainIsotropicPlasticityFactory", yield_surface: "VonMises" },
    when: { field: "solverType", equals: "static" },      // offered only for the setup it is written for
    variables: [ /* … */ ] },
]
```

- **`application`** names the Kratos application the law (or its factory) comes from. A materials file carries no module path, so the document scan cannot find it: the generated driver requires the application whenever a material actually uses the law.
- **`group`** is the heading the law is listed under in the Materials form.
- **`parameters`** are extra keys of the generated `constitutive_law` block, written as they are — the ConstitutiveLawsApplication factories' `law_type`, `yield_surface`, `plastic_potential`. The block's `name` stays the law's own name (a `parameters.name` is refused).
- **`when`** is a visibility rule (or list) over the case's values — the element formulation or solver whose constitutive-law set the law belongs to. The form hides a law whose rules do not hold, and Generate refuses a material still assigned to it, so switching the setup can never silently change what a law means.

## Mesh naming, icons and custom process lists

- **`meshNaming`** declares the element/condition block names the solver expects in the mdpa. When the previewed mesh differs, Generate writes a renamed `<stem>_case.mdpa` copy and points `input_filename` at it:

  ```js
  meshNaming: {
    elements: "$field:elementBase",      // string, "$field:<id>", or per-dim
    conditions: { 2: "LineLoadCondition", 3: "SurfaceLoadCondition" },
  }
  ```

  The final block name is `<base><dim>D<nodesPerCell>N` (the GiD convention). Use generic bases (`"Element"`, `"WallCondition"`) when the solver replaces elements itself; concrete ones (structural) when it doesn't. Point (single-node) condition blocks are never renamed.

  When no single base can describe a formulation's names (shells, membranes, cables, springs), the kind takes a **`{ field, names }` table**: an enum field's value picks that formulation's entry, which is a template (`"SpringDamperElement{dim}D"`, with `{dim}`/`{nodes}` placeholders), one exact name (`"CableElement3D2N"`), or a `{dim: {nodes: name}}` table of exact names. A value with no entry keeps the base meaning, so a table only lists the exceptions:

  ```js
  meshNaming: {
    elements: {
      field: "elementBase",
      names: {
        ShellThinElementCorotational: { 3: { 3: "ShellThinElementCorotational3D3N", 4: "ShellThinElementCorotational3D4N" } },
        SpringDamperElement: "SpringDamperElement{dim}D",
        CableElement: "CableElement3D2N",
      },
    },
  }
  ```

  A shape table also says which shapes the formulation *has*: a mesh block of any other shape is refused (preflight reports it as an error) instead of being renamed to a Kratos type that does not exist. A shape table that names a one-node shape (`{3: {1: "NodalConcentratedElement3D1N"}}`) lifts the point-block guard for it.
- **`icon`** names a toolbar icon shown on the problemtype's forms — the built-ins use their own logos (`ptStructural`, `ptFluid`, `ptThermal`, `ptPotentialFlow`, `ptShallowWater`, `ptCompressible`, `ptEmbedded`, `ptFreeSurface`, `ptBuoyancy`, `ptConjugateHeat`, `ptFsi`); concept icons for groups and conditions are `ptTime`, `ptSolver`, `ptConstraint`, `ptLoad`, `ptInitial`, `ptGravity`, `ptParallel`, `ptCoupling` and `ptParts`; unknown ids fall back to the generic problemtype glyph.
- **`list`** on a condition may also be a custom process-list name (e.g. Shallow Water's `boundary_conditions_process_list`) — the three GiD-standard lists are always emitted alongside any custom ones.

## Layout: groups, categories and families

All of these are optional and purely presentational — they change how the sidebar draws the forms, never what is saved in `<stem>.kratoscase.json` or generated.

- A section may declare `groups: [{ id, label, icon?, collapsed? }]`; a field joins one with `group: "<id>"`. Fields with no group are drawn first, `advanced: true` fields without a group fold under one collapsed *Advanced* group, and a group whose fields are all hidden by `visibleWhen` is not drawn. Keep existing field ids when regrouping — saved cases are keyed by `values[sectionId][fieldId]`.
- A field may carry `min`, `max` and `step` (numeric inputs) and a `visibleWhen` that is one rule `{ field, equals }` / `{ field, oneOf }` or an array of rules that must all hold.
- A condition has a `category` — `"initial"`, `"constraints"`, `"loads"` or `"other"` — that decides the branch it is listed under; when omitted it is derived from its process `list`. `icon` names its toolbar icon, and `noProcess: true` marks a condition that only labels a SubModelPart for the hooks (an interface) and emits no process.
- A condition may declare `emit: { sibling, source, family }` to synthesize the Kratos conditions its load needs: assigning it re-emits the part's own entities into a sibling SubModelPart (`<part name><sibling>` under the same parent) — its nodes as one-node conditions (`source: "nodes"`, families `"point"`/`"moment"`, with `pointName` replacing the `PointLoadCondition` base when given), or its line entities as moving-load conditions (`source: "lines"`, family `"moving"`) — and the process targets the sibling. `family: "point"` picks `PointLoadCondition<dim>D1N`, or `axisymmetricPoint` for 2D axisymmetric formulations (named by `formulationField`). The mesh rarely carries these conditions, but targeting the sibling is unconditional, so the documents never depend on what the mesh happened to contain. The Python authoring API takes the same dict as `emit=`.
- `family` (`"solid"`, `"fluid"`, `"thermal"`, `"coupled"`, `"reduced"`, `"optimization"`, `"particles"`, `"workflow"`) puts the problemtype in a dropdown group.

## Collections: named, repeatable entries

Sections hold one value per field and conditions hold one assignment per SubModelPart. Some setups need neither: an optimization has a list of *responses*, *controls* and *constraints*, and a constraint names one of the responses; a reduced-order model has a list of *parameters*, each naming a value elsewhere in the case. A collection is that shape:

```js
collections: [
  {
    id: "responses", label: "Responses", min: 1,
    entryTypes: [
      { id: "mass", label: "Mass", parts: { label: "Evaluated on", target: "any" },
        fields: [{ id: "perturbationSize", label: "Perturbation size", type: "number", default: 1e-6 }] },
    ],
    defaults: [{ name: "mass", type: "mass" }],
  },
  {
    id: "constraints", label: "Constraints",
    entryTypes: [
      { id: "limit", label: "Response limit",
        fields: [{ id: "response", label: "Response", type: "ref", refCollection: "responses" }] },
    ],
  },
],
```

- A collection has `id`, `label`, one or more `entryTypes`, optional `min` / `max` entry counts, `icon`, `help` and `defaults` (`{ name, type, values? }` seeded into a fresh case).
- An entry type has its own `fields`, and `parts: { label, target, min?, max? }` when entries apply to SubModelParts (a design region).
- Entry names are identifiers (`[A-Za-z_][A-Za-z0-9_]*`) and unique within the collection. Renaming an entry in the sidebar rewrites every `ref` field that named it, in sections and in other entries.
- A `ref` field may live in a section or in an entry. A `ref` whose entry no longer exists is drawn red, and Generate refuses the case.
- The case stores entries under `CaseState.collections[collectionId]` as `{ name, type, parts, values }` in `<stem>.kratoscase.json`.
- Generate refuses a case with too few or too many entries, a duplicate or invalid name, an unknown entry type, a part count outside the entry type's bounds, a SubModelPart missing from the mesh, or a dangling `ref`. Preflight reports the same problems, with the SubModelPart framed where there is one.
- Hooks receive `ctx.collections[collectionId]`: the entries with defaults merged into `values` and `modelParts`, the parts as Kratos dotted names under the root model part.
- An entry field's `visibleWhen` may name another field of the same entry or a field of any section (`algorithmType`, for example).

A `caseValue` field holds the address of one numeric value of the case:

| Address | Names |
|---|---|
| `section:<sectionId>/<fieldId>` | a section field |
| `assignment:<conditionId>@<smpPath>/<fieldId>` | a field of the first assignment of that condition on that SubModelPart |
| `material:<smpPath>/<variable>` | a material variable of the assignment on that SubModelPart |

A trailing `[0]`, `[1]` or `[2]` selects one component of a `vector3`. The sidebar offers every number and vector component the case currently holds, grouped by section, conditions and materials.

The built-in [Structural Optimization](./optimization) and [reduced-order model](./reduced-order-models) problemtypes are written this way.

## Coupled problemtypes: domains

`domains: [{ id, label, modelPartName, mdpaSuffix, materialsFileName?, partsCondition, conditionIds, required?, meshNaming? }]` declares one physics each; a material law joins a domain with `domain: "<id>"`. `GenContext.domains[id]` carries that domain's own `modelPartName`, `mdpaStem`, assignments, materials and parts, so `$path` resolves against the right model part. Optional hooks complete the picture: `validate(ctx)` returns messages that make Generate refuse the case, and `extraFiles(ctx, materials)` returns additional files to write beside the case. The built-in Buoyancy, Conjugate Heat Transfer and FSI problemtypes are compositions of the single-physics ones and are good starting points. A problemtype whose primary document is not a `ProjectParameters` document names its own with `primaryDocumentName`, and its driver with `driverScriptName` (both default to `ProjectParameters.json` and `MainKratos.py`). The generation, run, preparation record and problem archive all read those names. The built-in generic CoSimulation problemtype (`cosim`) writes a coupling config as its primary document, and its `extraFiles` hook writes each participant's own solver document by calling the physics problemtype's `buildProcesses` and `buildSolverDocument` over that participant's domain context.

`couplingInterfaces: [{ label, sides: [fluidConditionId, structureConditionId] }]` names pairs of interface conditions (usually `noProcess` ones, one per domain). Generate then refuses a case whose two sides are assigned a different number of times (the n-th of one side pairs with the n-th of the other), whose side carries no line cells in 2D or face cells in 3D, or whose paired parts do not overlap in space, naming the SubModelPart. `driverTemplate` picks a shipped driver when there is no `mainScript` hook: `"standard"` (the default `MainKratos.py`), `"fsi"` (FsiAnalysis) or `"cosim"` (CoSimulationAnalysis reading `primaryDocumentName`); the last two record the coupling iterations of every step in the convergence history. See [Coupled Simulations](./coupled-simulations) for how the built-ins use them.

## Required Kratos applications

Generation works out which Kratos applications a case needs: the analysis stage's application and every application the written documents name (a `kratos_module`, a linear-solver factory key such as `"LinearSolversApplication.sparse_lu"`). Declare the rest with `applications`, a list of names or `{ application, when }` entries whose `when` rule (the `visibleWhen` spelling) is read against the section values — for example `{ application: "MeshMovingApplication", when: { field: "aleMesh", equals: true } }`. The union is recorded in `kkss-preparation-v1.json`, every driver starts by checking it can import them (exit code 3 naming what is missing), and Run asks the configured Python before launching.

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
| `collections` | collection id → resolved entries (`name`, `type`, `parts`, `values` with defaults merged, dotted `modelParts`); present when the problemtype declares collections |

## Optional hooks

```ts
buildProcess(cond, assignment, ctx)   // → process object, or undefined to
                                      //   fall back to the processTemplate
postProcess(projectParameters, ctx)   // → last-chance mutation of the document
mainScript(ctx)                       // → replaces the default MainKratos.py
```

`buildProcess` is the escape hatch for processes a static template cannot express — the built-in Structural problemtype uses it to broadcast a single "Fixed" checkbox into Kratos' per-component `constrained: [true, true, true]`, and the built-in Fluid problemtype derives `volume_model_part_name` / `skin_parts` from the assignments inside `solverSettings`.

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

`problem_data.start_time` / `end_time` / `echo_level` are read from the flattened values under the conventional ids `startTime`, `endTime`, `echoLevel` (defaults `0`, `1`, `1`).

Prefer Python? The same API is available as a [Python module](./problemtype-python), and faithful Python ports of the five built-in problemtypes ship as copyable examples in [`example/problemtypes/`](https://github.com/loumalouomega/VSCode-MDPA-Preview/tree/master/example/problemtypes).

### Kratos numeric and process compatibility

Material fields declared as `number` (and vector components) are serialized with
real JSON tokens even for whole values, such as `1000.0`; Kratos' thermal importer
distinguishes these from integers. Use `int` for genuinely integer material data.
The built-in stationary thermal analysis selects Laplacian elements, while its
transient analysis retains the transient formulation. Fluid axis directions are
converted to vectors; automatic normal directions stay symbolic. The potential
flow far-field process and shallow-water topography parameters follow the Kratos
10.4.3 APIs. The Python examples are tested for identical generated output.
