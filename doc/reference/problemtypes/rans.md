# Problemtype: Turbulent Flow (RANS)

Generated from the built-in `ProblemtypeDeclaration`; run `npm run docs:reference` after changing it.

<!-- BEGIN GENERATED: problemtype-rans -->
**Turbulent Flow (RANS)** (`rans`) — Incompressible Navier-Stokes with a two-equation turbulence model (k-epsilon, k-omega, k-omega SST) and a wall function (RANSApplication)

- Analysis stage: `KratosMultiphysics.RANSApplication.rans_analysis`
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
| `gravityValue` | Gravity | number | `0` | m/s² |  |
| `gravityDirection` | Direction | vector3 | `[0,-1,0]` |  |  |
| `linearSolver` | Solver | enum | `"automatic"` |  | automatic, LinearSolversApplication.sparse_lu, cg, bicgstab |
| `linearMaxIteration` | Max iterations | int | `200` |  |  |
| `linearTolerance` | Tolerance | number | `1e-7` |  |  |
| `preconditioner` | Preconditioner | enum | `"none"` |  | none, diagonal, ilu, ilu0 |
| `echoLevel` | Echo level | int | `0` |  |  |
| `computeReactions` | Compute reactions | bool | `false` |  |  |
| `flowSolver` | Flow solver | enum | `"monolithic"` |  | monolithic, fractional_step |
| `turbulenceModel` | Turbulence model | enum | `"k_epsilon"` |  | k_epsilon, k_omega, k_omega_sst |
| `elementType` | Flow element | enum | `"vms"` |  | vms, qsvms |
| `oss` | Orthogonal subscales | bool | `false` |  |  |
| `dynamicTau` | Dynamic tau | number | `0.01` |  |  |
| `scheme` | Time scheme | enum | `"steady"` |  | steady, bdf2, bossak |
| `bossakAlpha` | Bossak alpha | number | `-0.3` |  |  |
| `stabilization` | Turbulence stabilization | enum | `"algebraic_flux_corrected"` |  | algebraic_flux_corrected, residual_based_flux_corrected, non_linear_cross_wind_dissipation |
| `wallFrictionMethod` | Wall friction velocity | enum | `"velocity_based"` |  | velocity_based, turbulent_kinetic_energy_based |
| `freestreamSpeed` | Free-stream speed [m/s] | number | `1` |  |  |
| `turbulenceIntensity` | Turbulence intensity | number | `0.01` |  |  |
| `turbulenceLength` | Turbulence length scale [m] | number | `0.01` |  |  |
| `maxIterations` | Maximum flow iterations | int | `20` |  |  |
| `velocityTolerance` | Velocity tolerance | number | `0.001` |  |  |
| `pressureTolerance` | Pressure tolerance | number | `0.001` |  |  |
| `maxVelocityIterations` | Maximum velocity iterations | int | `20` |  |  |
| `maxPressureIterations` | Maximum pressure iterations | int | `1` |  |  |
| `turbulenceTolerance` | Turbulence tolerance | number | `0.001` |  |  |
| `turbulenceIterations` | Turbulence iterations per step | int | `3` |  |  |
| `couplingIterations` | Coupling iterations | int | `1` |  |  |

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

### Wall (wall function) (`ransWall`)

List: `constraints_process_list`

## Material laws

### rans_newtonian_3d

Constitutive law: `RansNewtonian3DLaw`, 3D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `1.204` | kg/m³ |  |
| `DYNAMIC_VISCOSITY` | Dynamic viscosity [Pa·s] | number | `0.00001825` | Pa·s |  |

### rans_newtonian_2d

Constitutive law: `RansNewtonian2DLaw`, 2D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `1.204` | kg/m³ |  |
| `DYNAMIC_VISCOSITY` | Dynamic viscosity [Pa·s] | number | `0.00001825` | Pa·s |  |

### rans_wall

Constitutive law: —

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `WALL_SMOOTHNESS_BETA` | Wall smoothness constant B | number | `5.2` |  |  |
<!-- END GENERATED: problemtype-rans -->
