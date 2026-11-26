# Problemtype: ROM · Potential Flow

Generated from the built-in `ProblemtypeDeclaration`; run `npm run docs:reference` after changing it.

<!-- BEGIN GENERATED: problemtype-romPotentialFlow -->
**ROM · Potential Flow** (`romPotentialFlow`) — Reduced-order model (POD-Galerkin ROM and HROM) of Potential Flow, trained over sampled case values (RomApplication)

- Analysis stage: `KratosMultiphysics.CompressiblePotentialFlowApplication.potential_flow_analysis`
- Root model part: `FluidModelPart`
- Materials file: `FluidMaterials.json`
- Domain sizes: 2, 3

## Sections

### Problem data

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `formulation` | Formulation | enum | `"incompressible"` |  | incompressible, compressible |
| `maxIterations` | Max iterations | int | `10` |  |  |
| `linearSolver` | Solver | enum | `"automatic"` |  | automatic, LinearSolversApplication.sparse_lu, cg, bicgstab |
| `linearMaxIteration` | Max iterations | int | `200` |  |  |
| `linearTolerance` | Tolerance | number | `1e-7` |  |  |
| `preconditioner` | Preconditioner | enum | `"none"` |  | none, diagonal, ilu, ilu0 |
| `echoLevel` | Echo level | int | `0` |  |  |

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

### Fluid domain (`parts`)

List: `list_other_processes`

### Far field (`farField`)

List: `constraints_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `angleOfAttack` | Angle of attack [rad] | number | `0` |  |  |
| `machInfinity` | Mach ∞ | number | `0.03` |  |  |
| `speedOfSound` | Speed of sound [m/s] | number | `340` |  |  |

### Body / wake (2D) (`body2d`)

List: `list_other_processes`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `epsilon` | Wake ε | number | `1e-9` |  |  |

## Material laws

None.
<!-- END GENERATED: problemtype-romPotentialFlow -->
