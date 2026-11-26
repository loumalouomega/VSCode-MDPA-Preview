# Problemtype: Embedded Fluid

Generated from the built-in `ProblemtypeDeclaration`; run `npm run docs:reference` after changing it.

<!-- BEGIN GENERATED: problemtype-embeddedFluid -->
**Embedded Fluid** (`embeddedFluid`) — Monolithic Navier-Stokes on a non-conforming mesh with an embedded body given by a distance field (FluidDynamicsApplication)

- Analysis stage: `KratosMultiphysics.FluidDynamicsApplication.fluid_dynamics_analysis`
- Root model part: `FluidModelPart`
- Materials file: `FluidMaterials.json`
- Domain sizes: 3

## Sections

### Problem data

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `considerPeriodic` | Periodic boundaries | bool | `false` |  |  |
| `dynamicTau` | Dynamic tau | number | `0.01` |  |  |
| `timeStepMode` | Time stepping | enum | `"fixed"` |  | fixed, adaptive |
| `startTime` | Start time | number | `0` | s |  |
| `timeStep` | Time step | number | `0.01` | s |  |
| `courantTarget` | Target Courant number | number | `1` |  |  |
| `minDeltaTime` | Min. time step | number | `0.0001` |  |  |
| `maxDeltaTime` | Max. time step | number | `0.1` |  |  |
| `refVelocity` | Reference velocity (estimate only) | number | `1` |  |  |
| `endTime` | End time | number | `1` | s |  |
| `maxIterations` | Max iterations | int | `10` |  |  |
| `relVelTol` | Rel. velocity tol. | number | `0.001` |  |  |
| `absVelTol` | Abs. velocity tol. | number | `0.00001` |  |  |
| `relPresTol` | Rel. pressure tol. | number | `0.001` |  |  |
| `absPresTol` | Abs. pressure tol. | number | `0.00001` |  |  |
| `linearSolver` | Solver | enum | `"automatic"` |  | automatic, LinearSolversApplication.sparse_lu, cg, bicgstab |
| `linearMaxIteration` | Max iterations | int | `200` |  |  |
| `linearTolerance` | Tolerance | number | `1e-7` |  |  |
| `preconditioner` | Preconditioner | enum | `"none"` |  | none, diagonal, ilu, ilu0 |
| `echoLevel` | Echo level | int | `0` |  |  |
| `computeReactions` | Compute reactions | bool | `false` |  |  |
| `timeOrder` | Time order | int | `2` |  |  |
| `embeddedFormulation` | Embedded element | enum | `"embedded_navier_stokes"` |  | embedded_navier_stokes, embedded_weakly_compressible_navier_stokes, embedded_ausas_navier_stokes, embedded_weakly_compressible_navier_stokes_discontinuous |
| `isSlip` | Slip embedded boundary | bool | `false` |  |  |
| `penaltyCoefficient` | Penalty coefficient | number | `10` |  |  |
| `slipLength` | Slip length [m] | number | `0.001` |  |  |
| `distanceMode` | Distance field | enum | `"from_mdpa"` |  | from_mdpa, from_GiD_file |
| `distanceFile` | Distance file | string | `""` |  |  |
| `correctDistance` | Correct distance at each step | bool | `false` |  |  |
| `computeDrag` | Compute embedded drag | bool | `false` |  |  |
| `writeDragFile` | Write drag file | bool | `true` |  |  |
| `printDrag` | Print drag to screen | bool | `false` |  |  |
| `meshAdaptivity` | Mesh adaptivity | bool | `false` |  |  |
| `adaptInitialStep` | First remeshing step | int | `1` |  |  |
| `adaptStepFrequency` | Remeshing step frequency | int | `0` |  |  |
| `adaptInitialRemeshing` | Initial remeshing | bool | `false` |  |  |
| `anisotropicRatio` | Anisotropic ratio | number | `0.01` |  |  |
| `boundaryLayerRatio` | BL minimum size ratio | number | `2` |  |  |

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

### Initial temperature (`initialTemperature`)

List: `initial_conditions_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [K] | number | `293.15` |  |  |
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

### Wall law (`wallLaw`)

List: `constraints_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `wallModel` | Wall model | enum | `"navier_slip"` |  | navier_slip, linear_log |
| `slipLength` | Slip length [m] | number | `0.001` |  |  |
| `yWall` | Wall distance [m] | number | `0.001` |  |  |

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

### Aerodynamic coefficients (`aerodynamicCoefficients`)

List: `auxiliar_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `referenceArea` | Reference area [m²] | number | `1` |  |  |
| `referenceChord` | Reference chord [m] | number | `1` |  |  |
| `dynamicPressure` | Dynamic pressure [Pa] | number | `1` |  |  |
| `referencePoint` | Moment reference point | vector3 | `[0,0,0]` |  |  |
| `printToScreen` | Print to screen | bool | `false` |  |  |

### Pressure coefficient (`pressureCoefficient`)

List: `auxiliar_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `freestreamDensity` | Free-stream density [kg/m³] | number | `1.204` |  |  |
| `freestreamVelocity` | Free-stream speed [m/s] | number | `1` |  |  |
| `freestreamPressure` | Free-stream pressure [Pa] | number | `0` |  |  |

### Wall y+ (`yPlus`)

List: `auxiliar_process_list`

### Integration-point statistics (`integrationStats`)

List: `auxiliar_process_list` — marks a SubModelPart, emits no process

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `statisticType` | Statistic | enum | `"average"` |  | average, variance, third_order_moment |
| `variable` | Variable(s) | string | `"VELOCITY"` |  |  |
| `tags` | Tags | string | `""` |  |  |
| `outputFile` | Output file | string | `"statistics"` |  |  |
| `startTime` | Start time [s] | number | `0` |  |  |

## Material laws

### newtonian_3d

Constitutive law: `Newtonian3DLaw`, 3D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `1000` | kg/m³ |  |
| `DYNAMIC_VISCOSITY` | Dynamic viscosity [Pa·s] | number | `0.001` | Pa·s |  |

### newtonian_2d

Constitutive law: `Newtonian2DLaw`, 2D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `1000` | kg/m³ |  |
| `DYNAMIC_VISCOSITY` | Dynamic viscosity [Pa·s] | number | `0.001` | Pa·s |  |

### temperature_dependent_3d

Constitutive law: `NewtonianTemperatureDependent3DLaw`, 3D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `1000` | kg/m³ |  |
| `TEMPERATURE_TABLE` | Viscosity table [K, Pa·s] | string | `"293.15,1e-3; 373.15,2.8e-4"` |  |  |

### temperature_dependent_2d

Constitutive law: `NewtonianTemperatureDependent2DLaw`, 2D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `1000` | kg/m³ |  |
| `TEMPERATURE_TABLE` | Viscosity table [K, Pa·s] | string | `"293.15,1e-3; 373.15,2.8e-4"` |  |  |

### newtonian_3d_weakly_compressible

Constitutive law: `Newtonian3DLaw`, 3D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `1000` | kg/m³ |  |
| `DYNAMIC_VISCOSITY` | Dynamic viscosity [Pa·s] | number | `0.001` | Pa·s |  |
| `SOUND_VELOCITY` | Speed of sound [m/s] | number | `1500` | m/s |  |
<!-- END GENERATED: problemtype-embeddedFluid -->
