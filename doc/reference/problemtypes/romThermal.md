# Problemtype: ROM · Convection-diffusion

Generated from the built-in `ProblemtypeDeclaration`; run `npm run docs:reference` after changing it.

<!-- BEGIN GENERATED: problemtype-romThermal -->
**ROM · Convection-diffusion** (`romThermal`) — Reduced-order model (POD-Galerkin ROM and HROM) of Convection-Diffusion (thermal), trained over sampled case values (RomApplication)

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

### Reduced-order model

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `romTrainStages` | Train | enum | `"ROM_HROM"` |  | ROM, ROM_HROM |
| `romTestStages` | Test | enum | `"none"` |  | none, ROM, ROM_HROM |
| `romProjection` | Projection | enum | `"galerkin"` |  | galerkin, lspg, petrov_galerkin |
| `romAssembling` | Assembling | enum | `"global"` |  | global, elemental |
| `romSvdTolerance` | SVD truncation tolerance | number | `0.00001` |  |  |
| `romNodalUnknowns` | Nodal unknowns | stringList | `[]` |  |  |
| `romSnapshotsControl` | Snapshots every | enum | `"step"` |  | step, time |
| `romSnapshotsInterval` | Snapshot interval | number | `1` |  |  |
| `romPrintSingularValues` | Write singular values | bool | `true` |  |  |
| `romMonotonicity` | Monotonicity preserving | bool | `false` |  |  |
| `lspgTrainPetrovGalerkin` | Train Petrov–Galerkin basis | bool | `false` |  |  |
| `lspgBasisStrategy` | Basis strategy | enum | `"residuals"` |  | residuals, jacobian, reactions |
| `lspgIncludePhi` | Include Φ | bool | `false` |  |  |
| `lspgSvdTolerance` | SVD truncation tolerance | number | `1e-12` |  |  |
| `lspgSolvingTechnique` | Solving technique | enum | `"normal_equations"` |  | normal_equations, qr_decomposition |
| `hromSelectionTolerance` | Element selection tolerance | number | `0.000001` |  |  |
| `hromConstraintSumWeights` | Constrain sum of weights | bool | `true` |  |  |
| `hromVisualization` | Write HROM visualization model part | bool | `true` |  |  |
| `hromIncludeElements` | Always include elements of | smpList |  |  |  |
| `hromIncludeConditions` | Always include conditions of | smpList |  |  |  |
| `hromMinimumCondition` | Keep one condition per part | bool | `false` |  |  |
| `hromConditionParents` | Include condition parents | bool | `false` |  |  |
| `romSaveVtk` | Write VTK output per run | bool | `true` |  |  |

### Sampling

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `sampleMethod` | Method | enum | `"lhs"` |  | lhs, halton, random, grid |
| `sampleTrain` | Training samples | int | `6` |  |  |
| `sampleTest` | Test samples | int | `3` |  |  |
| `sampleSeed` | Seed | int | `1` |  |  |

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
<!-- END GENERATED: problemtype-romThermal -->
