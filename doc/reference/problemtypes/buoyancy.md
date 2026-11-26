# Problemtype: Buoyancy (natural convection)

Generated from the built-in `ProblemtypeDeclaration`; run `npm run docs:reference` after changing it.

<!-- BEGIN GENERATED: problemtype-buoyancy -->
**Buoyancy (natural convection)** (`buoyancy`) — Fluid flow coupled with heat transfer through the Boussinesq approximation (FluidDynamics + ConvectionDiffusion)

- Analysis stage: `KratosMultiphysics.ConvectionDiffusionApplication.convection_diffusion_analysis`
- Root model part: `ThermalModelPart`
- Materials file: `FluidMaterials.json`
- Domain sizes: 2, 3

## Sections

### Fluid and coupling

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `strategy` | Strategy | enum | `"monolithic"` |  | monolithic, fractional_step, stokes |
| `elementType` | Element | enum | `"qsvms"` |  | qsvms, dvms, fic, vms, weakly_compressible, axisymmetric, p2p1 |
| `timeIntegrated` | Element integrates in time | bool | `false` |  |  |
| `ficBeta` | FIC beta | number | `0.8` |  |  |
| `soundVelocity` | Speed of sound | number | `1000000000000` | m/s |  |
| `nonNewtonian` | Non-Newtonian (Herschel-Bulkley) | bool | `false` |  |  |
| `powerLawK` | Consistency index K | number | `0.000001` |  |  |
| `powerLawN` | Power-law index n | number | `1` |  |  |
| `yieldStress` | Yield stress | number | `0` | Pa |  |
| `regularization` | Regularization coefficient | number | `100` |  |  |
| `forceSteadyState` | Force steady state | bool | `false` |  |  |
| `timeOrder` | Time order | int | `2` |  |  |
| `useSlipConditions` | Slip conditions on the skin | bool | `true` |  |  |
| `considerPeriodic` | Periodic boundaries | bool | `false` |  |  |
| `timeScheme` | Time scheme | enum | `"bossak"` |  | bdf2, bossak |
| `bossakAlpha` | Bossak alpha | number | `-0.3` |  |  |
| `oss` | Orthogonal subscales | bool | `false` |  |  |
| `dynamicTau` | Dynamic tau | number | `1` |  |  |
| `timeStepMode` | Time stepping | enum | `"fixed"` |  | fixed, adaptive |
| `startTime` | Start time | number | `0` | s |  |
| `timeStep` | Time step | number | `0.01` | s |  |
| `courantTarget` | Target Courant number | number | `1` |  |  |
| `minDeltaTime` | Min. time step | number | `0.0001` |  |  |
| `maxDeltaTime` | Max. time step | number | `0.1` |  |  |
| `endTime` | End time | number | `1` | s |  |
| `maxIterations` | Max iterations | int | `10` |  |  |
| `relVelTol` | Rel. velocity tol. | number | `0.001` |  |  |
| `absVelTol` | Abs. velocity tol. | number | `0.00001` |  |  |
| `relPresTol` | Rel. pressure tol. | number | `0.001` |  |  |
| `absPresTol` | Abs. pressure tol. | number | `0.00001` |  |  |
| `velocityTolerance` | Velocity tolerance | number | `0.001` |  |  |
| `maxVelocityIterations` | Max velocity iterations | int | `4` |  |  |
| `predictorCorrector` | Predictor-corrector | bool | `false` |  |  |
| `pressureTolerance` | Pressure tolerance | number | `0.001` |  |  |
| `maxPressureIterations` | Max pressure iterations | int | `4` |  |  |
| `linearSolver` | Solver | enum | `"automatic"` |  | automatic, LinearSolversApplication.sparse_lu, cg, bicgstab |
| `linearMaxIteration` | Max iterations | int | `200` |  |  |
| `linearTolerance` | Tolerance | number | `1e-7` |  |  |
| `preconditioner` | Preconditioner | enum | `"none"` |  | none, diagonal, ilu, ilu0 |
| `echoLevel` | Echo level | int | `0` |  |  |
| `computeReactions` | Compute reactions | bool | `false` |  |  |
| `gravityVector` | Gravity | vector3 | `[0,-9.81,0]` | m/s² |  |
| `ambientTemperature` | Ambient temperature | number | `293.15` | K |  |

### Thermal

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `t_analysisType` | Linearity | enum | `"linear"` |  | linear, non_linear |
| `t_convergenceCriterion` | Convergence criterion | enum | `"residual_criterion"` |  | residual_criterion, displacement_criterion, and_criterion, or_criterion |
| `t_residualRelTol` | Residual rel. tol. | number | `0.00001` |  |  |
| `t_residualAbsTol` | Residual abs. tol. | number | `1e-7` |  |  |
| `t_temperatureRelTol` | Temperature rel. tol. | number | `0.00001` |  |  |
| `t_temperatureAbsTol` | Temperature abs. tol. | number | `1e-7` |  |  |
| `t_maxIteration` | Max iterations | int | `10` |  |  |
| `t_lineSearch` | Line search | bool | `false` |  |  |
| `t_linearSolver` | Solver | enum | `"automatic"` |  | automatic, LinearSolversApplication.sparse_lu, cg, bicgstab |
| `t_linearMaxIteration` | Max iterations | int | `200` |  |  |
| `t_linearTolerance` | Tolerance | number | `1e-7` |  |  |
| `t_preconditioner` | Preconditioner | enum | `"none"` |  | none, diagonal, ilu, ilu0 |
| `t_computeReactions` | Compute reactions | bool | `false` |  |  |
| `t_bodyHeat` | Volume heat source [W/m³] | number | `0` |  |  |

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

### Thermal · Initial temperature (`t_initialTemperature`)

List: `initial_conditions_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [K] | number | `293.15` |  |  |
| `constrained` | Fixed | bool | `false` |  |  |

### Thermal · Fixed temperature (`t_temperature`)

List: `constraints_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Temperature [K] | number | `293.15` |  |  |

### Thermal · Heat flux (volume) (`t_heatFlux`)

List: `constraints_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Heat flux [W/m³] | number | `0` |  |  |

### Thermal · Face heat flux (`t_faceHeatFlux`)

List: `constraints_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [W/m²] | number | `0` |  |  |

### Thermal · Thermal face (radiation / convection) (`t_thermalFace`)

List: `constraints_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `ambientTemperature` | Ambient temperature [K] | number | `273.15` |  |  |
| `addRadiation` | Add ambient radiation | bool | `false` |  |  |
| `emissivity` | Emissivity | number | `0` |  |  |
| `addConvection` | Add ambient convection | bool | `false` |  |  |
| `convectionCoefficient` | Convection coefficient [W/(m²·K)] | number | `0` |  |  |

## Material laws

### newtonian_3d

Constitutive law: `Newtonian3DLaw`, 3D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `1000` | kg/m³ |  |
| `DYNAMIC_VISCOSITY` | Dynamic viscosity [Pa·s] | number | `0.001` | Pa·s |  |
| `CONDUCTIVITY` | Thermal conductivity [W/(m·K)] | number | `0.024` | W/(m·K) |  |
| `SPECIFIC_HEAT` | Specific heat [J/(kg·K)] | number | `1012` | J/(kg·K) |  |

### newtonian_2d

Constitutive law: `Newtonian2DLaw`, 2D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `1000` | kg/m³ |  |
| `DYNAMIC_VISCOSITY` | Dynamic viscosity [Pa·s] | number | `0.001` | Pa·s |  |
| `CONDUCTIVITY` | Thermal conductivity [W/(m·K)] | number | `0.024` | W/(m·K) |  |
| `SPECIFIC_HEAT` | Specific heat [J/(kg·K)] | number | `1012` | J/(kg·K) |  |

### temperature_dependent_3d

Constitutive law: `NewtonianTemperatureDependent3DLaw`, 3D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `1000` | kg/m³ |  |
| `TEMPERATURE_TABLE` | Viscosity table [K, Pa·s] | string | `"293.15,1e-3; 373.15,2.8e-4"` |  |  |
| `CONDUCTIVITY` | Thermal conductivity [W/(m·K)] | number | `0.024` | W/(m·K) |  |
| `SPECIFIC_HEAT` | Specific heat [J/(kg·K)] | number | `1012` | J/(kg·K) |  |

### temperature_dependent_2d

Constitutive law: `NewtonianTemperatureDependent2DLaw`, 2D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `1000` | kg/m³ |  |
| `TEMPERATURE_TABLE` | Viscosity table [K, Pa·s] | string | `"293.15,1e-3; 373.15,2.8e-4"` |  |  |
| `CONDUCTIVITY` | Thermal conductivity [W/(m·K)] | number | `0.024` | W/(m·K) |  |
| `SPECIFIC_HEAT` | Specific heat [J/(kg·K)] | number | `1012` | J/(kg·K) |  |
<!-- END GENERATED: problemtype-buoyancy -->
