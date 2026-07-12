# Authoring Problemtypes (Python)

Problemtypes can be written in Python instead of
[JavaScript](./problemtype-authoring) — the API is the same, spelled
snake_case. Drop a `.py` file in `.kratos/problemtypes/` and it appears in the
Problemtype dropdown.

**Complete worked examples**: faithful Python ports of the three built-in
problemtypes live in
[`example/problemtypes/`](https://github.com/loumalouomega/VSCode-MDPA-Preview/tree/master/example/problemtypes)
(`structural.py`, `fluid.py`, `convection_diffusion.py`). A parity test keeps
them byte-identical to the TypeScript originals, so they are always a current,
runnable reference — copy one and start editing.

Python problemtypes run inside [Pyodide](https://pyodide.org/) (Python
compiled to WebAssembly, bundled with the extension) — they do **not** use
your system Python and cannot import Kratos or touch the filesystem. They only
*describe* the case; the generated `ProjectParameters.json` runs with your
real Kratos install like any other case. The interpreter (~14 MB of WASM)
loads lazily the first time a `.py` problemtype is discovered, so there is no
cost when you don't use the feature.

## A complete example

```python
# .kratos/problemtypes/my_thermal.py
from kratos_problemtype import define_problemtype, section, field, condition, material_law

def solver_settings(values, ctx):
    # ctx is a dict with snake_case keys — see the table below.
    return {
        "solver_type": "transient",
        "analysis_type": "linear",
        "model_part_name": ctx["model_part_name"],
        "domain_size": ctx["domain_size"],
        "model_import_settings": {"input_type": "mdpa", "input_filename": ctx["mdpa_stem"]},
        "material_import_settings": {"materials_filename": ctx["materials_file_name"]},
        "echo_level": values["echoLevel"],
        "problem_domain_sub_model_part_list": ctx["parts_model_parts"],
        "processes_sub_model_part_list": ctx["skin_model_parts"],
        "time_stepping": {"time_step": values["timeStep"]},
    }

define_problemtype(
    id="myThermal",
    name="My Thermal (py)",
    description="Custom transient heat transfer",
    analysis_stage="KratosMultiphysics.ConvectionDiffusionApplication.convection_diffusion_analysis",
    model_part_name="ThermalModelPart",
    materials_file_name="ThermalMaterials.json",
    domain_sizes=[2, 3],
    sections=[
        section("problem", "Problem data",
                field("timeStep", "Time step", "number", default=0.1),
                field("endTime", "End time", "number", default=1.0),
                field("echoLevel", "Echo level", "int", default=1)),
    ],
    parts_condition="parts",
    conditions=[
        condition("parts", "Thermal body", list="list_other_processes",
                  target="volume", process_template={}),
        condition("temperature", "Fixed temperature",
                  list="constraints_process_list", target="any",
                  fields=[field("value", "T [K]", "number", default=293.15)],
                  process_template={
                      "python_module": "assign_scalar_variable_process",
                      "kratos_module": "KratosMultiphysics",
                      "process_name": "AssignScalarVariableProcess",
                      "Parameters": {
                          "model_part_name": "$path",
                          "variable_name": "TEMPERATURE",
                          "constrained": True,
                          "value": "$field:value",
                          "interval": [0.0, "End"],
                      },
                  }),
    ],
    material_laws=[
        material_law("thermal", "", variables=[
            field("DENSITY", "ρ", "number", default=1000),
            field("CONDUCTIVITY", "k", "number", default=0.6),
            field("SPECIFIC_HEAT", "c", "number", default=4184),
        ]),
    ],
    output={"nodal_defaults": ["TEMPERATURE"]},
    solver_settings=solver_settings,        # required hook
    # build_process=..., post_process=..., main_script=...   (optional hooks)
)
```

## API surface

```python
field(id, label, type, default=None, options=None, visible_when=None, help=None)
section(id, label, *fields)
condition(id, label, list="constraints_process_list", target="any",
          fields=(), process_template=None, help=None)
process(python_module, process_name=None, kratos_module="KratosMultiphysics",
        parameters=None)                  # process_template sugar
material_law(id, name, variables=(), domain_size=None)
INTERVAL_TOTAL                            # the [0.0, "End"] interval constant
define_problemtype(id, name, analysis_stage, model_part_name,
                   materials_file_name, domain_sizes,
                   sections=(), conditions=(), material_laws=(),
                   parts_condition=None, mesh_naming=None, output=None,
                   description=None, icon=None,
                   solver_settings=None,   # required
                   build_process=None, post_process=None, main_script=None)
```

`mesh_naming` declares the element/condition block names the solver expects —
when the mesh differs, Generate writes a renamed `<stem>_case.mdpa` copy
(final name = `<base><dim>D<nnodes>N`):

```python
mesh_naming={"elements": "$field:elementBase",           # or "Element"
             "conditions": {2: "LineLoadCondition", 3: "SurfaceLoadCondition"}}
```

`icon` names a toolbar icon for the problemtype's forms (the built-ins use
`ptStructural` / `ptFluid` / `ptThermal` / `ptPotentialFlow` /
`ptShallowWater`). A condition's `list` may also be a custom process-list name
(e.g. `boundary_conditions_process_list`).

Field types, `$path` / `$root` / `$field:<id>` template placeholders, process
lists and the generated document shape are identical to the
[JavaScript API](./problemtype-authoring). `options` accepts plain strings
(`options=["a", "b"]`) or dicts (`{"value": "a", "label": "A"}`).

`process()` builds a `process_template` dict and derives `process_name` from
the CamelCased `python_module` when omitted (the Kratos convention —
`assign_scalar_variable_process` → `AssignScalarVariableProcess`):

```python
process_template=process(
    "assign_scalar_variable_process",
    parameters={"model_part_name": "$path", "variable_name": "TEMPERATURE",
                "value": "$field:value", "interval": INTERVAL_TOTAL})
```

**Validation is eager**: a wrong field type, an unknown process list/target, a
duplicate id, or a `parts_condition` that names no condition raises
`ValueError` naming the offending id while the file loads — the broken
problemtype shows up as a disabled dropdown entry carrying that message
instead of failing later at generate time.

**Note:** field ids and the keys of `values` stay exactly as you declare them
(the built-ins use camelCase like `timeStep`) — only the *API argument names*
and the *ctx keys* are snake_case.

## Hooks

| Hook | Signature | Default when omitted / returning `None` |
|---|---|---|
| `solver_settings` | `(values, ctx) → dict` | — required |
| `build_process` | `(cond, assignment, ctx) → dict \| None` | resolve the condition's `process_template` |
| `post_process` | `(project_parameters, ctx) → dict` | unchanged document |
| `main_script` | `(ctx) → str` | the standard `MainKratos.py` |

All hook arguments and return values are plain JSON data (dicts, lists,
numbers, strings) — no Kratos objects.

### The `ctx` dict

| Key | Contents |
|---|---|
| `mdpa_stem` | mdpa file name without extension |
| `domain_size` | `2` or `3` |
| `model_part_name`, `materials_file_name` | from the declaration |
| `values` | all section field values flattened |
| `assignments`, `materials` | the raw user assignments |
| `parts_model_parts` | dotted names of the Parts assignments |
| `skin_model_parts` | dotted names of every non-Parts assignment |
| `sub_model_parts` | all SubModelPart paths in the mesh |
