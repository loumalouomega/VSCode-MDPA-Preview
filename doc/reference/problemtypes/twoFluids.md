# Problemtype: Two Fluids

Generated from the built-in `ProblemtypeDeclaration`; run `npm run docs:reference` after changing it.

<!-- BEGIN GENERATED: problemtype-twoFluids -->
**Two Fluids** (`twoFluids`) — Two immiscible incompressible fluids separated by a level-set interface (FluidDynamicsApplication)

- Analysis stage: `KratosMultiphysics.FluidDynamicsApplication.fluid_dynamics_analysis`
- Root model part: `FluidModelPart`
- Materials file: `FluidMaterials.json`
- Domain sizes: 2, 3

## Sections

### Problem data

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `considerPeriodic` | Periodic boundaries | bool | `false` |  |  |
| `timeStepMode` | Time stepping | enum | `"fixed"` |  | fixed, adaptive |
| `startTime` | Start time | number | `0` | s |  |
| `timeStep` | Time step | number | `0.01` | s |  |
| `courantTarget` | Target Courant number | number | `1` |  |  |
| `minDeltaTime` | Min. time step | number | `0.0001` |  |  |
| `maxDeltaTime` | Max. time step | number | `0.1` |  |  |
| `refVelocity` | Reference velocity (estimate only) | number | `1` |  |  |
| `endTime` | End time | number | `1` | s |  |
| `relVelTol` | Rel. velocity tol. | number | `0.001` |  |  |
| `absVelTol` | Abs. velocity tol. | number | `0.00001` |  |  |
| `relPresTol` | Rel. pressure tol. | number | `0.001` |  |  |
| `absPresTol` | Abs. pressure tol. | number | `0.00001` |  |  |
| `gravityValue` | Gravity | number | `0` | m/s² |  |
| `gravityDirection` | Direction | vector3 | `[0,-1,0]` |  |  |
| `linearSolver` | Solver | enum | `"automatic"` |  | automatic, LinearSolversApplication.sparse_lu, cg, bicgstab |
| `linearMaxIteration` | Max iterations | int | `200` |  |  |
| `linearTolerance` | Tolerance | number | `1e-7` |  |  |
| `preconditioner` | Preconditioner | enum | `"none"` |  | none, diagonal, ilu, ilu0 |
| `echoLevel` | Echo level | int | `0` |  |  |
| `computeReactions` | Compute reactions | bool | `false` |  |  |
| `maxIterations` | Maximum iterations | int | `7` |  |  |
| `timeOrder` | Time order | int | `2` |  |  |
| `dynamicTau` | Dynamic tau | number | `1` |  |  |
| `surfaceTension` | Surface tension | bool | `false` |  |  |
| `massSource` | Mass source | bool | `false` |  |  |
| `momentumCorrection` | Momentum correction | bool | `false` |  |  |
| `accelerationLimitation` | Acceleration limitation | bool | `true` |  |  |
| `distanceMode` | Distance field | enum | `"from_mdpa"` |  | from_mdpa, from_GiD_file |
| `distanceFile` | Distance file | string | `""` |  |  |
| `levelsetMaxCfl` | Interface CFL | number | `1` |  |  |
| `levelsetSubsteps` | Interface sub-steps | int | `0` |  |  |
| `eulerianErrorCompensation` | Eulerian error compensation | bool | `false` |  |  |
| `distanceReinitialization` | Re-initialization | enum | `"variational"` |  | none, variational, parallel |
| `redistanceLayers` | Parallel re-distance layers | int | `25` |  |  |
| `distanceSmoothing` | Distance smoothing | bool | `false` |  |  |
| `distanceSmoothingCoefficient` | Smoothing coefficient | number | `1` |  |  |
| `distanceThreshold` | Distance threshold | number | `0.00001` |  |  |
| `avoidAlmostEmpty` | Avoid almost empty elements | bool | `false` |  |  |
| `deactivateFullNegative` | Deactivate full negative elements | bool | `false` |  |  |

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

### Custom velocity constraints (`velocityConstraints`)

List: `constraints_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [m/s] | vector3 | `[0,0,0]` |  |  |
| `constrained` | Fixed | bool | `true` |  |  |

### Custom pressure constraints (`pressureConstraints`)

List: `constraints_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [Pa] | number | `0` |  |  |
| `constrained` | Fixed | bool | `true` |  |  |

### Periodic boundary (`periodic`)

List: `constraints_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `master` | Master boundary | smp | `""` |  |  |
| `translation` | Translation direction | vector3 | `[1,0,0]` |  |  |
| `magnitude` | Translation distance [m] | number | `1` |  |  |

### Forces and moments on a body (`flowForces`)

List: `auxiliar_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `referencePoint` | Moment reference point | vector3 | `[0,0,0]` |  |  |
| `writeMoments` | Write moments | bool | `true` |  |  |
| `printToScreen` | Print to screen | bool | `false` |  |  |

### Wall y+ (`yPlus`)

List: `auxiliar_process_list`

### Two-fluids inlet (`twoFluidsInlet`)

List: `constraints_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `interfaceNormal` | Interface normal | vector3 | `[0,0,1]` |  |  |
| `pointOnInterface` | Point on the interface | vector3 | `[0,0,0]` |  |  |
| `transitionRadius` | Transition radius [m] | number | `0.05` |  |  |
| `modulus1` | Fluid 1 speed | string | `"1.0"` |  |  |
| `modulus2` | Fluid 2 speed | string | `"0.0"` |  |  |
| `direction` | Direction | vector3 | `[1,0,0]` |  |  |

### Mass conservation check (`massConservationCheck`)

List: `auxiliar_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `perform` | Correct the interface | bool | `true` |  |  |
| `frequency` | Correction every [steps] | int | `20` |  |  |
| `log` | Write a log file | bool | `true` |  |  |

## Material laws

### phase_1_3d

Constitutive law: `Newtonian3DLaw`, 3D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `1000` | kg/m³ |  |
| `DYNAMIC_VISCOSITY` | Dynamic viscosity [Pa·s] | number | `0.001` | Pa·s |  |
| `SURFACE_TENSION_COEFFICIENT` | Surface tension coefficient [N/m] | number | `0` | N/m |  |

### phase_1_2d

Constitutive law: `Newtonian2DLaw`, 2D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `1000` | kg/m³ |  |
| `DYNAMIC_VISCOSITY` | Dynamic viscosity [Pa·s] | number | `0.001` | Pa·s |  |
| `SURFACE_TENSION_COEFFICIENT` | Surface tension coefficient [N/m] | number | `0` | N/m |  |

### phase_2_3d

Constitutive law: `Newtonian3DLaw`, 3D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `1` | kg/m³ |  |
| `DYNAMIC_VISCOSITY` | Dynamic viscosity [Pa·s] | number | `0.000018` | Pa·s |  |
| `SURFACE_TENSION_COEFFICIENT` | Surface tension coefficient [N/m] | number | `0` | N/m |  |

### phase_2_2d

Constitutive law: `Newtonian2DLaw`, 2D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `1` | kg/m³ |  |
| `DYNAMIC_VISCOSITY` | Dynamic viscosity [Pa·s] | number | `0.000018` | Pa·s |  |
| `SURFACE_TENSION_COEFFICIENT` | Surface tension coefficient [N/m] | number | `0` | N/m |  |
<!-- END GENERATED: problemtype-twoFluids -->
