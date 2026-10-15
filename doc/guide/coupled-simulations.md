# Coupled Simulations (FSI and CoSimulation)

Two built-in problemtypes couple the fluid and structural solvers: **Fluid-Structure Interaction** (`fsi`, over the FSIApplication) and **Generic Coupling (CoSimulation)** (`cosim`, over the CoSimulationApplication). Both are built from the Fluid and Structural Mechanics problemtypes, so their fluid and structure fields, conditions and materials are the same ones those problemtypes use, prefixed per physics.

::: warning Not solver-verified here
The case shapes follow Kratos master (read 2026-10-15): the FSIApplication's partitioned solver, and the CoSimulationApplication's Mok FSI benchmark (`tests/fsi_mok`). This repository has no Kratos with those applications, so no coupled case has been run here. Treat the first run as a check of the generated files.
:::

## Which one to choose

| | Fluid-Structure Interaction | Generic Coupling (CoSimulation) |
|---|---|---|
| Analysis | one `FsiAnalysis` nesting both solvers | one `CoSimulationAnalysis` driving two separate solvers |
| Files | `ProjectParameters.json`, `MainKratos.py` | `ProjectParametersCoSim.json`, `ProjectParametersCFD.json`, `ProjectParametersCSM.json`, `MainKratosCoSim.py` |
| Coupling | always iterated (Dirichlet-Neumann with relaxation or quasi-Newton acceleration) | weak (one exchange per step) or strong (iterated to a criterion) |
| Fluid mesh | always moves (ALE mesh solver) | moves only when *Move the fluid mesh (ALE)* is on |
| Applications | FluidDynamics, StructuralMechanics, MeshMoving, Mapping, FSI | CoSimulation, FluidDynamics, StructuralMechanics, Mapping (+ MeshMoving with ALE) |

## Setting up a case

1. Open one mesh that contains both bodies. Each physics is a **domain**: assign its body with *Fluid body* / *Structure body*, and its conditions as you would in the single-physics problemtype.
2. Mark the interface on **both** sides: a fluid-side SubModelPart (*FSI fluid interface* or *Coupling interface (fluid side)*) and a structure-side one. Several interface pairs are allowed; the n-th fluid side is coupled with the n-th structure side, in the order you assigned them.
3. Assign materials to both bodies and generate. Generate writes one mesh per physics (`<name>_Fluid.mdpa`, `<name>_Structural.mdpa`), sliced from the open mesh, and one materials file per physics.

## What Generate checks

Generate refuses the case, writes nothing, and names what to fix when:

- a domain has no body, or an interface side is not assigned;
- the two sides of an interface are assigned a different number of times (they pair one-to-one);
- an interface side has no boundary cells of the right dimension: line conditions or elements in 2D, surface (face) conditions or elements in 3D. A mapper needs geometry, so a part holding only nodes is refused;
- the two parts of a pair do not overlap in space (their bounding boxes are compared with a tolerance of a millionth of the mesh diagonal), which usually means the pairing order is wrong;
- the fluid's time-stepping values are unusable;
- CoSimulation only: strong coupling is chosen without ALE mesh motion (the fluid would never see the structure's displacement), or *ALE mesh displacement* is assigned while ALE is off.

The same checks run in the sidebar's Preflight card and in MCP `case_validate`.

## CoSimulation options

The **Coupling** section of the CoSimulation problemtype:

- **Coupling** — *Weak* writes `coupled_solvers.gauss_seidel_weak`. *Strong* writes `coupled_solvers.gauss_seidel_strong` with **Max coupling iterations** (`num_coupling_iterations`, default 10) and one `relative_norm_previous_residual` criterion per interface pair on the fluid interface displacement, with **Absolute** and **Relative tolerance** (default 1e-5 each).
- **Convergence accelerator** (strong coupling) — *MVQN* (default), *IQN-ILS*, *Aitken relaxation* (with its four relaxation bounds under Advanced) or *None*, one per interface pair on the fluid interface displacement.
- **Predictor** — *Average value* (with the weight β), *Linear* (from the interface velocity, which adds a `VELOCITY` data entry per pair) or *None*.
- **Mapper** — the MappingApplication mapper between every pair: nearest element (default), nearest neighbor, or barycentric (which interpolates on lines in 2D and triangles in 3D).
- **Move the fluid mesh (ALE)** — the fluid participant becomes an `ale_fluid` solver with **Mesh motion solver** structural similarity or Laplacian. Its interfaces follow the structure, the fluid receives the displacement as `MESH_DISPLACEMENT`, and `processes.ale_boundary_conditions` holds the mesh fixed on the interfaces and on every boundary you mark with *ALE mesh displacement*.

The structure reads the fluid `REACTION` as its `POINT_LOAD` with the sign swapped (a reaction is the force on the fluid) and sends its `DISPLACEMENT` back. Pair *i* exchanges data named `fluid_interface_load`, `fluid_interface_load_2`, … so a single-pair case keeps the plain names.

## Required Kratos applications

Every generated driver starts by checking that `KratosMultiphysics` and each application the case needs can be imported, before it reads or writes anything. A missing one stops the run with exit code 3 and a line naming it. The applications are those the analysis stage and the generated documents name (`kratos_module`, a linear-solver factory key), plus those a problemtype declares (MeshMoving only when ALE is on). They are recorded in `kkss-preparation-v1.json`.

Before launching, **Run** asks the configured Python the same question and refuses with the list of missing applications instead of starting a run that would fail. When that probe cannot answer (no Python found, a timeout), the run starts and the driver's own check stands behind it. MCP `case_run` does the same, and `case_validate` with `checkInstall: true` reports the missing applications without running anything.

## Coupling iterations in the convergence history

Both drivers write one record per coupled step to `kkss-convergence-v2.jsonl`, which the Kratos Runs view, the convergence plot and MCP `case_convergence` read like any other run:

- **FSI** records the number of coupling checks of the step, whether the FSIApplication's own criterion converged, and the interface residual of each check, normalised as the solver logs it (`|res|/sqrt(nDOFS)`).
- **CoSimulation, strong** records the coupling iterations, whether the coupled solver converged, and per iteration the largest `|r|/sqrt(n)` over its criteria.
- **CoSimulation, weak** evaluates no criterion, so a completed weak run is reported as *unavailable*, never as converged.

The tree row reads, for example, *Convergence — step 12 · res 2.1e-6 · 4 coupling iterations · converged*. Residual units are undeclared.

## Python ports

`example/problemtypes/coupled.py` defines both problemtypes in Python (`fsi_py`, `cosim_py`) and is parity-tested against the built-ins, including the CoSimulation participant documents. It shows `domains`, `coupling_interfaces`, `driver_template` and an `extra_files` hook returning JSON documents; see [Authoring Problemtypes (Python)](./problemtype-python).

## Not provided

CoSimIO and external (non-Kratos) solvers, MPI/Trilinos variants, the FSIApplication's IBQN and randomized-SVD accelerators, and embedded FSI are not offered. Per-solver output attribution in isolated run folders belongs to the run-workspace work (roadmap item 6).
