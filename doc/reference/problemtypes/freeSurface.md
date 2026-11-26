# Problemtype: Free Surface

Generated from the built-in `ProblemtypeDeclaration`; run `npm run docs:reference` after changing it.

<!-- BEGIN GENERATED: problemtype-freeSurface -->
**Free Surface** (`freeSurface`) — Edge-based level-set flow with a free surface (FreeSurfaceApplication)

- Analysis stage: `KratosMultiphysics.FreeSurfaceApplication.free_surface_analysis`
- Root model part: `FluidModelPart`
- Materials file: `FluidMaterials.json`
- Domain sizes: 2, 3

## Sections

### Problem data

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `density` | Density | number | `1000` | kg/m³ |  |
| `viscosity` | Viscosity | number | `0.000001` | m²/s |  |
| `startTime` | Start time | number | `0` | s |  |
| `endTime` | End time | number | `1` | s |  |
| `maxSafetyFactor` | Max. safety factor | number | `0.1` |  |  |
| `maxTimeStepSize` | Max. time step size | number | `0.01` | s |  |
| `initialSteps` | Initial time steps | int | `10` |  |  |
| `initialTimeStepSize` | Initial time step size | number | `0.00001` | s |  |
| `reductionOnFailure` | Reduction on failure | number | `0.3` |  |  |
| `redistanceFrequency` | Redistance frequency | number | `5` |  |  |
| `extrapolationLayers` | Extrapolation layers | number | `5` |  |  |
| `useMassCorrection` | Mass correction | bool | `false` |  |  |
| `wallLawY` | Wall law y | number | `0` |  |  |
| `stabdtPressureFactor` | Pressure stabilization factor | number | `1` |  |  |
| `stabdtConvectionFactor` | Convection stabilization factor | number | `0.01` |  |  |
| `tau2Factor` | Tau2 factor | number | `1` |  |  |
| `assumeConstantPressure` | Assume constant pressure | bool | `false` |  |  |
| `echoLevel` | Echo level | int | `0` |  |  |

## Conditions

### Fluid body (`parts`)

List: `list_other_processes`

### Initial velocity (`initialVelocity`)

List: `initial_conditions_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [m/s] | vector3 | `[0,0,0]` |  |  |
| `constrained` | Fixed | bool | `false` |  |  |

### Initial pressure (`initialPressure`)

List: `initial_conditions_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [Pa] | number | `0` |  |  |
| `constrained` | Fixed | bool | `false` |  |  |

### Inlet velocity (`inlet`)

List: `constraints_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `modulus` | \|v\| [m/s] | number | `1` |  |  |
| `modulusExpression` | \|v\| expression | string | `""` |  |  |
| `intervalStart` | Active from [s] | number | `0` |  |  |
| `intervalEnd` | Active until [s] | string | `"End"` |  |  |
| `direction` | Direction | enum | `"automatic_inwards_normal"` |  | automatic_inwards_normal, automatic_outwards_normal, x, y, z |

### Outlet pressure (`outlet`)

List: `constraints_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Pressure [Pa] | number | `0` |  |  |
| `hydrostatic` | Add hydrostatic contribution | bool | `false` |  |  |
| `hTop` | Top height [m] | number | `0` |  |  |

### Slip wall (`slip`)

List: `constraints_process_list`

### No-slip wall (`noSlip`)

List: `constraints_process_list`

### Initial distance (free surface) (`initialDistance`)

List: `initial_conditions_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [m] | number | `0` |  |  |
| `constrained` | Fixed | bool | `false` |  |  |

## Material laws

None.
<!-- END GENERATED: problemtype-freeSurface -->
