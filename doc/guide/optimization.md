# Structural Optimization

The **Structural Optimization** problemtype writes a case for Kratos' [OptimizationApplication](https://github.com/KratosMultiphysics/Kratos/tree/master/applications/OptimizationApplication): the algorithm-based optimizer driven by `optimization_parameters.json` and `OptimizationAnalysis`. The primal analysis is set up exactly as in the [Structural Mechanics](./simulation#built-in-problemtypes) problemtype, and three lists on top of it describe the optimization problem: the **responses** it can measure, the **controls** it may change, and the **constraints** that must hold. Progress is followed in the **Optimization progress** panel, in Kratos Runs and through MCP; the per-iteration design fields open in the timeline viewer.

The older ShapeOptimizationApplication is not targeted.

::: warning Not solver-verified
The documents follow the OptimizationApplication's defaults and test cases at Kratos master (read 2026-10-14), but this repository has no Kratos to run them against. Treat the first run as a check of the generated files. See the [roadmap](../roadmap) for what is still to be checked against a real run.
:::

## Set up a case

Pick **Structural Optimization** in the Problemtype dropdown (the *Optimization* group). The sidebar shows the Structural forms, conditions and materials (the primal), followed by the **Setup** stage and the **Optimization** section.

### Primal analysis

The primal is the structural analysis evaluated once per iteration. It must be **static**, and a **linear strain energy** response needs a **linear** primal with at least one load; Generate refuses the case otherwise. Assign the Parts, supports, loads and materials as for a Structural case.

### Responses

A response is a quantity of the design that can be the objective or a constraint. A new case has two: `mass` and `strain_energy`.

| Type | Kratos response | Settings |
|---|---|---|
| Mass | `mass_response_function` | evaluated parts, perturbation size |
| Linear strain energy | `linear_strain_energy_response_function` | evaluated parts, perturbation size; evaluated on the primal |
| Geometric centroid deviation | `geometric_centroid_deviation_response_function` | evaluated parts |
| Discrete value residual | `discrete_value_residual_response_function` | container (nodal, element, condition, …), variable, residual type, discrete values |

A response with no parts is evaluated on the whole model part.

### Controls

A control is a design quantity the optimizer changes over a design region. Add at least one, and give it at least one SubModelPart.

| Type | Kratos control | What changes |
|---|---|---|
| Material property | `material.material_properties_control` | a property of the region's Properties (Young modulus, density, Poisson ratio or thickness) |
| Shell thickness | `thickness.shell_thickness_control` | the thickness of shell elements, between two physical thicknesses, through a filter and a projection |
| Shape (vertex morphing) | `shape.vertex_morphing_shape_control` | node positions of the design surface, filtered (implicit Helmholtz or explicit vertex morphing), with optional damped parts and filter-based mesh motion |
| Topology (SIMP) | `material.simp_control` | element densities of a volume region, interpolated between a list of materials (densities with increasing Young moduli) through a projection |

Filter radii are in mesh length units. A shell thickness control needs exactly two physical thicknesses; filter-based mesh motion needs the implicit filter; a SIMP control needs at least two materials with as many Young moduli as densities, increasing with density. Two controls that change the same quantity on the same SubModelPart are refused. Mesh motion with a separate `mesh_moving_analysis` is not offered.

### Constraints

A constraint names a response, a relation (`<=`, `<`, `=`, `>=`, `>`) and a reference: the response's **initial value**, or a **fixed value** in the scaled units the optimizer works in. The extra settings depend on the algorithm: gradient projection takes a scaling and a violation scaling, and the relaxed gradient projection algorithms take a buffer factor, a maximum constraint weight and a tolerance.

The objective's response may not also be a constraint.

### Optimization section

| Group | Settings |
|---|---|
| Objective | the response (a dropdown of the responses above), minimize or maximize, scaling |
| Algorithm | steepest descent, Nesterov accelerated gradient, Adam, gradient projection, relaxed gradient projection or momentum relaxed gradient projection; max iterations; the algorithm's own settings (momentum, Adam β₁/β₂/ε, correction size, history size…) appear only for the algorithm that reads them |
| Line search | constant, Barzilai–Borwein or quasi-Newton Barzilai–Borwein step; initial and max step; gradient scaling |
| Convergence | stop on max iterations only, or also on the search-direction norm, average improvement, a target value, a magnitude reduction or no improvement (patience) |
| Output | summary file name, whether to write the design fields as VTU, and their format |

Steepest descent, Nesterov and Adam take no constraints; pick a projection algorithm to use them. The initial step is in the units of the control, so a Young modulus control needs a step comparable to the modulus.

Renaming a response in the Setup stage updates the objective and every constraint that names it. A name that no longer exists is shown in red, and Generate refuses the case naming it.

## What Generate writes

| File | Contents |
|---|---|
| `optimization_parameters.json` | `problem_data`, the model part read from the case mesh, the primal analysis (`kratos_analysis_execution_policy` named `primal`), `responses`, `controls`, `algorithm_settings` and the output processes (the ascii summary and, optionally, the design-field VTU output) |
| `primal_parameters.json` | the structural solver document of the primal, reading the model part the optimizer already holds (`input_type: use_input_model_part`) and writing no output of its own |
| `StructuralMaterials.json` | the primal's materials, as for a Structural case |
| `MainKratosOpt.py` | the driver: imports the structural application, builds `OptimizationAnalysis` and runs it |
| `kkss_optimization_stop.py` | a small process the optimizer runs every iteration, so a **Stop** finishes the run cleanly |

Run the case with **Run case** as for any other problemtype. **Stop** asks the optimizer to stop at the next iteration; the driver then finalizes the analysis, so the summary file is closed and reads *stopped* rather than *incomplete*.

## Follow the run

**Optimization progress panel.** Advanced ▸ **Optimization progress…** (or the *Kratos MDPA: Optimization Progress…* command) opens a panel on the left of the preview showing:

- the formulation, e.g. *minimize strain_energy s.t. mass ≤ initial; controls: stiffness*;
- the verdict: running, finished, stopped, incomplete (no end-of-file marker: the run was killed or crashed) or no data yet;
- the objective against the iteration, with its change since the first iteration;
- each constraint's standardized value against the iteration, with a dashed zero line (at or below zero is satisfied);
- the last iterations as a table.

Its buttons open the full history in the [Plots workspace](./scientific-plots), open the design fields, and export the summary as CSV. The panel refreshes as the optimizer writes new iterations.

**Kratos Runs.** A run of an optimization case shows a row such as *iter 7/10 · objective −10.7% · 1/1 constraints satisfied*. Its context menu has **Plot Optimization History** and **Open Design Fields**.

**Design fields.** With *Write design fields* on, the optimizer writes the controls, their updates and the response gradients per iteration under `Optimization_Results/`. **Open design fields** opens them in the mesh preview with a timeline, one step per iteration; colour by a field such as `YOUNG_MODULUS`, `PHYSICAL_THICKNESS` or a gradient in the Field panel.

**MCP.** `case_optimization` returns the same summary, verdict and rows, and `case_status` carries a compact copy. See [MCP Server](./mcp).

The summary is classified by the response names in the case's own `optimization_parameters.json`, never guessed from column names. A cell that is not a number is a gap, never 0.
