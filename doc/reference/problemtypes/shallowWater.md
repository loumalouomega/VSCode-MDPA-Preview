# Problemtype: Shallow Water

Generated from the built-in `ProblemtypeDeclaration`; run `npm run docs:reference` after changing it.

<!-- BEGIN GENERATED: problemtype-shallowWater -->
**Shallow Water** (`shallowWater`) — 2D free-surface shallow-water flows: stabilized, Boussinesq and linear waves (ShallowWaterApplication)

- Analysis stage: `KratosMultiphysics.ShallowWaterApplication.shallow_water_analysis`
- Root model part: `main_model_part`
- Materials file: `TopographyMaterials.json`
- Domain sizes: 2

## Sections

### Problem data

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `solver` | Solution type | enum | `"stabilized_shallow_water_solver"` |  | stabilized_shallow_water_solver, boussinesq_solver, wave_solver |
| `scheme` | Scheme | enum | `"bdf"` |  | bdf, Adams-Moulton, cn |
| `timeIntegrationOrder` | Integration order | int | `2` |  |  |
| `startTime` | Start time | number | `0` | s |  |
| `endTime` | End time | number | `1` | s |  |
| `adaptiveStep` | Automatic time step (CFL) | bool | `false` |  |  |
| `timeStep` | Time step | number | `0.01` | s |  |
| `cflNumber` | CFL number | number | `1` |  |  |
| `minDeltaTime` | Min. time step | number | `0.0001` |  |  |
| `maxDeltaTime` | Max. time step | number | `1` |  |  |
| `maxIterations` | Max iterations | int | `10` |  |  |
| `stabilizationFactor` | Stabilization factor | number | `0.01` |  |  |
| `shockCapturing` | Shock capturing | enum | `"residual_viscosity"` |  | residual_viscosity, gradient_jump, flux_correction |
| `shockCapturingFactor` | Shock capturing factor | number | `0.5` |  |  |
| `gravity` | Gravity | number | `9.81` | m/s² |  |
| `linearSolver` | Solver | enum | `"automatic"` |  | automatic, LinearSolversApplication.sparse_lu, cg, bicgstab |
| `linearMaxIteration` | Max iterations | int | `200` |  |  |
| `linearTolerance` | Tolerance | number | `1e-7` |  |  |
| `preconditioner` | Preconditioner | enum | `"none"` |  | none, diagonal, ilu, ilu0 |
| `echoLevel` | Echo level | int | `1` |  |  |

## Conditions

### Water domain (`parts`)

List: `list_other_processes`

### Initial water level (`initialWaterLevel`)

List: `initial_conditions_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `variable` | Variable | enum | `"HEIGHT"` |  | HEIGHT, FREE_SURFACE_ELEVATION |
| `value` | Value [m] | number | `1` |  |  |
| `setMinimumHeight` | Set a minimum height | bool | `false` |  |  |
| `minimumHeight` | Minimum height [m] | number | `0.001` |  |  |

### Initial perturbation (`initialPerturbation`)

List: `initial_conditions_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `variable` | Variable | enum | `"HEIGHT"` |  | HEIGHT, FREE_SURFACE_ELEVATION |
| `maximumPerturbation` | Maximum value [m] | number | `1` |  |  |
| `distanceOfInfluence` | Distance of influence [m] | number | `1` |  |  |
| `defaultValue` | Default value [m] | number | `0` |  |  |
| `sourceCoordinates` | Source point | vector3 | `[0,0,0]` |  |  |

### Imposed flow rate (`imposedFlowRate`)

List: `boundary_conditions_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | q [m²/s] | vector3 | `[0,0,0]` |  |  |

### Imposed velocity (`imposedVelocity`)

List: `boundary_conditions_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | v [m/s] | vector3 | `[0,0,0]` |  |  |

### Imposed free surface (`imposedFreeSurface`)

List: `boundary_conditions_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Elevation [m] | number | `0` |  |  |

### Slip wall (`slip`)

List: `boundary_conditions_process_list`

### Topography (`topography`)

List: `topography_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | z(x,y) expression | string | `"0.0"` |  |  |

## Material laws

### manning

Constitutive law: —

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `MANNING` | Manning coefficient | number | `0.01` |  |  |
<!-- END GENERATED: problemtype-shallowWater -->
