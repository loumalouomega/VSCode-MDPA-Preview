# Reduced-Order Models

The **ROM** problemtypes write a case for Kratos' [RomApplication](https://github.com/KratosMultiphysics/Kratos/tree/master/applications/RomApplication) `RomManager`: it runs the full-order model (FOM) at a set of sampled parameter values, builds a POD basis from the snapshots, optionally selects a hyper-reduced integration domain (HROM), and tests the reduced models against the FOM at further samples.

There is one ROM problemtype per physics, in the *Reduced-order models* group of the Problemtype dropdown:

| Problemtype | Full-order model | Default nodal unknowns |
|---|---|---|
| ROM · Structural Mechanics | Structural Mechanics | `DISPLACEMENT_X`, `_Y` (and `_Z` in 3D) |
| ROM · Convection-diffusion | Convection-Diffusion | `TEMPERATURE` |
| ROM · Fluid Dynamics | Fluid Dynamics | `VELOCITY_X`, `_Y` (and `_Z`), `PRESSURE` |
| ROM · Potential Flow | Potential Flow | `VELOCITY_POTENTIAL`, `AUXILIARY_VELOCITY_POTENTIAL` |

Each is the physics problemtype unchanged — its forms, conditions and materials produce the full-order `ProjectParameters.json` — plus a **Reduced-order model** section, a **Sampling** section and a **Parameters** list.

::: warning Not solver-verified
The manager parameters follow `rom_manager.py` at Kratos master (read 2026-10-14) and the driver follows Kratos' own `RomManager` tests, but no case was trained against a solver here. Treat the first run as a check of the generated files. The ANN-enhanced decoder (which needs TensorFlow) is not offered.
:::

## Set up a case

1. Set up the full-order case as for its physics: parts, conditions, materials, time stepping. Keep the case's VTK output on if you want the per-run results written.
2. Under **Parameters**, add one entry per value that varies. **Varies** lists every number of the case — section settings, condition values (a pressure, an imposed displacement component…) and material variables (a Young modulus, a conductivity…) — grouped as in the sidebar. Give each a minimum and a maximum.
3. Under **Sampling**, pick how the training and test points are drawn — Latin hypercube, Halton sequence, uniform random or a full grid — and how many. The same seed always gives the same points. A full grid takes a number of points per parameter.
4. Under **Reduced-order model**, choose what to train (ROM, or ROM and HROM) and test, the projection (Galerkin, LSPG or Petrov–Galerkin), the SVD truncation tolerance, the snapshot interval and the HROM settings (selection tolerance, parts whose elements or conditions are always kept).

Generate refuses a case whose parameter names no value of the case, whose minimum is not below its maximum, whose value the solver never reads, or which shares a value with another parameter. It also refuses testing an HROM that is not trained.

### How a parameter reaches the solver

Generate finds where each parameter lands by generating the case twice with two probe values and comparing the documents. A Young modulus, for instance, is found in the materials file, and a pressure in the matching load process of `ProjectParameters.json`. The driver then writes exactly those values for each sample, so a parameter means what the form means, and a value that only changes a label is refused.

## What Generate writes

| File | Contents |
|---|---|
| `ProjectParameters.json`, the materials file, the case mesh | the full-order case, as its physics problemtype writes it |
| `RomManagerParameters.json` | the manager's general parameters, every key written explicitly from the form |
| `RomSamples.json` | the parameter names and ranges, where each lands in the documents, and the training and test points |
| `MainKratosROM.py` | the driver: builds `RomManager` with the case's documents, updates them per sample, then fits and tests |

The driver writes `kkss-rom-progress.jsonl` (one line per analysis: the sample, the stage and the elapsed time) and, at the end, `kkss-rom-summary-v1.json` (the number of modes, the HROM counts and which stages ran). The materials file is restored after the run. **Stop** ends the current analysis cleanly; the summary then says the database is partial. RomManager writes its own results to `rom_data/` (the basis, the singular values and the HROM element and condition ids and weights) and, with VTK output on, one `Results/vtk_output_<stage><sample>` folder per analysis.

## Look at the results

**Kratos Runs.** A run of a ROM case shows a row such as *ROM 12 modes · HROM 340 el / 18 cond · 9/9 runs*. Its context menu has:

- **Plot ROM Singular Values**: the normalized singular values against the mode index, on a logarithmic axis, in the [Plots workspace](./scientific-plots); how fast they fall tells how many modes the basis needs.
- **Show HROM Elements**: opens the case mesh and adds a [selection set](./selection) holding the HROM elements and conditions, so the reduced integration domain is visible on the full mesh.

**MCP.** `case_rom` returns the modes, the singular values, the HROM ids, the samples and the progress, and `case_status` carries a compact copy. See [MCP Server](./mcp).
