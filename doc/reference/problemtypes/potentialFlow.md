# Problemtype: Potential Flow

Generated from the built-in `ProblemtypeDeclaration`; run `npm run docs:reference` after changing it.

<!-- BEGIN GENERATED: problemtype-potentialFlow -->
**Potential Flow** (`potentialFlow`) — Incompressible / compressible potential flow around bodies (CompressiblePotentialFlowApplication)

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
<!-- END GENERATED: problemtype-potentialFlow -->
