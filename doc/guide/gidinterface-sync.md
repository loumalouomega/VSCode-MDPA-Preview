# Syncing with GiDInterface

The built-in problemtypes mirror [KratosMultiphysics/GiDInterface](https://github.com/KratosMultiphysics/GiDInterface), the interface Kratos itself ships for GiD. This page records what was compared, so a later sync is a diff rather than a rediscovery.

**Baseline:** GiDInterface `master` at commit `36c552f` (2026-09-04).

## What is aligned

| GiD app | Built-in | Notes |
|---|---|---|
| Structural | `structural` | formulations (small/large displacement, mixed, shells, beams, trusses, cables), static / dynamic / eigenvalue strategies, Newmark and Bossak schemes, Rayleigh damping, non-linear convergence criteria, linear solver, rotation and strain DOFs, initial conditions and loads |
| Fluid | `fluid` | monolithic QSVMS / DVMS / FIC / VMS with BDF2 or Bossak, fractional step, wall law, custom constraints, gravity, skin / no-skin split |
| CompressibleFluid | `compressibleFluid` | explicit compressible Navier-Stokes (2D) with shock capturing |
| EmbeddedFluid | `embeddedFluid` | embedded formulation, distance reading, drag, MMG adaptivity; the bounding-box wizard is not reproduced |
| FreeSurface | `freeSurface` | edge-based level set |
| ConvectionDiffusion | `convectionDiffusion` | stationary / transient, convergence criteria, heat flux and thermal face |
| PotentialFluid | `potentialFlow` | far field, wake, body |
| ShallowWater | `shallowWater` | the three solvers and their schemes, adaptive time step, initial perturbation, imposed flow |
| Buoyancy | `buoyancy` | `ThermallyCoupled` with the Boussinesq force |
| ConjugateHeatTransfer | `conjugateHeatTransfer` | fluid and solid domains, interface lists, modelers |
| FSI | `fsi` | partitioned Dirichlet-Neumann, ALE mesh solver, interface mapper |

Saved cases from earlier versions keep working: field ids are unchanged and regrouping is purely visual.

## Where the extension deliberately differs

- Process lists follow GiD (`initial_conditions_process_list`, `constraints_process_list`, `loads_process_list`, `list_other_processes`), with the per-physics lists of the coupled apps. Thermal heat flux and thermal face live in the constraints list, as GiD writes them.
- Coupled problemtypes slice the mesh you have open instead of expecting one per physics, and refuse a case with a missing domain or interface before writing anything.
- Potential flow writes the far field with `apply_far_field_and_wake_process` (the process current Kratos ships; GiD still names the older `apply_far_field_process`), and offers no 3D wake, wing-tip or 3D body entries because GiD itself only writes a `placeholder_process` for them.
- The new problemtypes are written from GiDInterface's writers and have not been solver-run in this repository.

## Not provided

Dam, GeoMechanics, PFEM and its variants, Stent, CDEM, DEMPFEM, FluidDEM, StenosisWizard, structural Contact, MPM and DEM. MPM needs particle generation from a background grid and DEM writes a different output and materials schema; neither fits the shared case-generation pipeline without a dedicated design.

## Updating

Compare `apps/<App>/xml/{Elements,Conditions,Strategies,NodalConditions,ConstitutiveLaws,Materials,Processes}.xml`, the `*.spd` trees and `write/writeProjectParameters.tcl` with the matching built-in in `src/problemtype/builtins/`. Keep field ids stable, add new options as fields in a group, regenerate the Python ports with `node scripts/problemtype-to-python.mjs <id>`, and update the baseline commit above.
