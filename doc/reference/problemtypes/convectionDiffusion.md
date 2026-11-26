# Problemtype: Convection-Diffusion (thermal)

Generated from the built-in `ProblemtypeDeclaration`; run `npm run docs:reference` after changing it.

<!-- BEGIN GENERATED: problemtype-convectionDiffusion -->
**Convection-Diffusion (thermal)** (`convectionDiffusion`) — Transient / stationary heat transfer (ConvectionDiffusionApplication)

- Analysis stage: `KratosMultiphysics.ConvectionDiffusionApplication.convection_diffusion_analysis`
- Root model part: `ThermalModelPart`
- Materials file: `ConvectionDiffusionMaterials.json`
- Domain sizes: 2, 3

## Sections

### Problem data

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `solverType` | Analysis | enum | `"transient"` |  | transient, stationary |
| `analysisType` | Linearity | enum | `"linear"` |  | linear, non_linear |
| `startTime` | Start time | number | `0` | s |  |
| `timeStep` | Time step | number | `0.1` | s |  |
| `endTime` | End time | number | `1` | s |  |
| `convergenceCriterion` | Convergence criterion | enum | `"residual_criterion"` |  | residual_criterion, displacement_criterion, and_criterion, or_criterion |
| `residualRelTol` | Residual rel. tol. | number | `0.00001` |  |  |
| `residualAbsTol` | Residual abs. tol. | number | `1e-7` |  |  |
| `temperatureRelTol` | Temperature rel. tol. | number | `0.00001` |  |  |
| `temperatureAbsTol` | Temperature abs. tol. | number | `1e-7` |  |  |
| `maxIteration` | Max iterations | int | `10` |  |  |
| `lineSearch` | Line search | bool | `false` |  |  |
| `linearSolver` | Solver | enum | `"automatic"` |  | automatic, LinearSolversApplication.sparse_lu, cg, bicgstab |
| `linearMaxIteration` | Max iterations | int | `200` |  |  |
| `linearTolerance` | Tolerance | number | `1e-7` |  |  |
| `preconditioner` | Preconditioner | enum | `"none"` |  | none, diagonal, ilu, ilu0 |
| `echoLevel` | Echo level | int | `1` |  |  |
| `computeReactions` | Compute reactions | bool | `false` |  |  |

## Conditions

### Thermal body (`parts`)

List: `list_other_processes`

### Initial temperature (`initialTemperature`)

List: `initial_conditions_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [K] | number | `293.15` |  |  |
| `constrained` | Fixed | bool | `false` |  |  |

### Fixed temperature (`temperature`)

List: `constraints_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Temperature [K] | number | `293.15` |  |  |

### Heat flux (volume) (`heatFlux`)

List: `constraints_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Heat flux [W/m³] | number | `0` |  |  |

### Face heat flux (`faceHeatFlux`)

List: `constraints_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [W/m²] | number | `0` |  |  |

### Thermal face (radiation / convection) (`thermalFace`)

List: `constraints_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `ambientTemperature` | Ambient temperature [K] | number | `273.15` |  |  |
| `addRadiation` | Add ambient radiation | bool | `false` |  |  |
| `emissivity` | Emissivity | number | `0` |  |  |
| `addConvection` | Add ambient convection | bool | `false` |  |  |
| `convectionCoefficient` | Convection coefficient [W/(m²·K)] | number | `0` |  |  |

## Material laws

### thermal

Constitutive law: —

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `1000` | kg/m³ |  |
| `CONDUCTIVITY` | Conductivity [W/(m·K)] | number | `0.6` | W/(m·K) |  |
| `SPECIFIC_HEAT` | Specific heat [J/(kg·K)] | number | `4184` | J/(kg·K) |  |
<!-- END GENERATED: problemtype-convectionDiffusion -->
