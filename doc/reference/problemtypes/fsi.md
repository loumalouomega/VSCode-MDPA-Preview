# Problemtype: Fluid-Structure Interaction

Generated from the built-in `ProblemtypeDeclaration`; run `npm run docs:reference` after changing it.

<!-- BEGIN GENERATED: problemtype-fsi -->
**Fluid-Structure Interaction** (`fsi`) — Partitioned Dirichlet-Neumann coupling of the fluid and structural solvers over an ALE mesh (FSIApplication)

- Analysis stage: `KratosMultiphysics.FSIApplication.fsi_analysis`
- Root model part: `FluidModelPart`
- Materials file: `FluidMaterials.json`
- Domain sizes: 2, 3

## Sections

### Coupling

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `startTime` | Start time | number | `0` | s |  |
| `endTime` | End time | number | `1` | s |  |
| `couplingScheme` | Coupling scheme | enum | `"DirichletNeumann"` |  | DirichletNeumann |
| `nlTol` | Coupling tolerance | number | `1e-7` |  |  |
| `nlMaxIt` | Max. coupling iterations | int | `25` |  |  |
| `solveMeshAtEachIteration` | Solve the mesh at each iteration | bool | `true` |  |  |
| `couplingStrategy` | Convergence acceleration | enum | `"Relaxation"` |  | Relaxation, MVQN, MVQN_recursive |
| `accelerationType` | Relaxation type | enum | `"Aitken"` |  | Aitken, constant |
| `w0` | Initial relaxation w₀ | number | `0.825` |  |  |
| `bufferSize` | Buffer size | int | `7` |  |  |
| `meshSolver` | ALE mesh solver | enum | `"structural_similarity"` |  | structural_similarity, laplacian |

### Fluid

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `f_strategy` | Strategy | enum | `"monolithic"` |  | monolithic, fractional_step, stokes |
| `f_elementType` | Element | enum | `"qsvms"` |  | qsvms, dvms, fic, vms, weakly_compressible, axisymmetric, p2p1 |
| `f_timeIntegrated` | Element integrates in time | bool | `false` |  |  |
| `f_ficBeta` | FIC beta | number | `0.8` |  |  |
| `f_soundVelocity` | Speed of sound | number | `1000000000000` | m/s |  |
| `f_nonNewtonian` | Non-Newtonian (Herschel-Bulkley) | bool | `false` |  |  |
| `f_powerLawK` | Consistency index K | number | `0.000001` |  |  |
| `f_powerLawN` | Power-law index n | number | `1` |  |  |
| `f_yieldStress` | Yield stress | number | `0` | Pa |  |
| `f_regularization` | Regularization coefficient | number | `100` |  |  |
| `f_forceSteadyState` | Force steady state | bool | `false` |  |  |
| `f_timeOrder` | Time order | int | `2` |  |  |
| `f_useSlipConditions` | Slip conditions on the skin | bool | `true` |  |  |
| `f_considerPeriodic` | Periodic boundaries | bool | `false` |  |  |
| `f_timeScheme` | Time scheme | enum | `"bossak"` |  | bdf2, bossak |
| `f_bossakAlpha` | Bossak alpha | number | `-0.3` |  |  |
| `f_oss` | Orthogonal subscales | bool | `false` |  |  |
| `f_dynamicTau` | Dynamic tau | number | `1` |  |  |
| `f_timeStepMode` | Time stepping | enum | `"fixed"` |  | fixed, adaptive |
| `f_timeStep` | Time step | number | `0.01` | s |  |
| `f_courantTarget` | Target Courant number | number | `1` |  |  |
| `f_minDeltaTime` | Min. time step | number | `0.0001` |  |  |
| `f_maxDeltaTime` | Max. time step | number | `0.1` |  |  |
| `f_refVelocity` | Reference velocity (estimate only) | number | `1` |  |  |
| `f_maxIterations` | Max iterations | int | `10` |  |  |
| `f_relVelTol` | Rel. velocity tol. | number | `0.001` |  |  |
| `f_absVelTol` | Abs. velocity tol. | number | `0.00001` |  |  |
| `f_relPresTol` | Rel. pressure tol. | number | `0.001` |  |  |
| `f_absPresTol` | Abs. pressure tol. | number | `0.00001` |  |  |
| `f_velocityTolerance` | Velocity tolerance | number | `0.001` |  |  |
| `f_maxVelocityIterations` | Max velocity iterations | int | `4` |  |  |
| `f_predictorCorrector` | Predictor-corrector | bool | `false` |  |  |
| `f_pressureTolerance` | Pressure tolerance | number | `0.001` |  |  |
| `f_maxPressureIterations` | Max pressure iterations | int | `4` |  |  |
| `f_gravityValue` | Gravity | number | `0` | m/s² |  |
| `f_gravityDirection` | Direction | vector3 | `[0,-1,0]` |  |  |
| `f_linearSolver` | Solver | enum | `"automatic"` |  | automatic, LinearSolversApplication.sparse_lu, cg, bicgstab |
| `f_linearMaxIteration` | Max iterations | int | `200` |  |  |
| `f_linearTolerance` | Tolerance | number | `1e-7` |  |  |
| `f_preconditioner` | Preconditioner | enum | `"none"` |  | none, diagonal, ilu, ilu0 |
| `f_echoLevel` | Echo level | int | `0` |  |  |
| `f_computeReactions` | Compute reactions | bool | `false` |  |  |

### Structure

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `s_solverType` | Analysis | enum | `"static"` |  | static, dynamic, eigen_value, harmonic_analysis |
| `s_analysisType` | Linearity | enum | `"linear"` |  | linear, non_linear |
| `s_elementBase` | Element formulation | enum | `"SmallDisplacementElement"` |  | SmallDisplacementElement, SmallDisplacementBbarElement, SmallDisplacementMixedVolumetricStrainElement, SmallDisplacementMixedVolumetricStrainOssElement, SmallDisplacementMixedVolumetricStrainOssNonLinearElement, SmallDisplacementMixedStrainElement, TotalLagrangianElement, UpdatedLagrangianElement, TotalLagrangianMixedVolumetricStrainElement, TotalLagrangianQ1P0MixedElement, AxisymSmallDisplacementElement, AxisymTotalLagrangianElement, AxisymUpdatedLagrangianElement, SolidShellElementSprism, LinearTimoshenkoBeamElement, LinearTimoshenkoCurvedBeamElement, CrBeamElement, CrLinearBeamElement, LinearTrussElement, TotalLagrangianTrussElement, TrussElement, TrussLinearElement, CableElement, ShellThinElementCorotational, ShellThickElementCorotational, ShellThinElement, MITCThickShellElement, MITCThickShellCorotationalElement, CSDSG3ThickShellLinearElement, CSDSG3ThickShellCorotationalElement, MembraneElement, NodalConcentratedElement, NodalConcentratedDampedElement, LineMassElement, SurfaceMassElement, BushingElement, SpringDamperElement |
| `s_schemeType` | Scheme | enum | `"bossak"` |  | newmark, bossak |
| `s_timeIntegration` | Time integration | enum | `"implicit"` |  | implicit, explicit |
| `s_explicitScheme` | Explicit scheme | enum | `"central_differences"` |  | central_differences, multi_stage |
| `s_harmonicType` | Harmonic analysis | enum | `"modal"` |  | modal, direct |
| `s_harmonicDamping` | Use effective material damping | bool | `false` |  |  |
| `s_harmonicAssembleDamping` | Assemble damping matrix | bool | `false` |  |  |
| `s_convergenceCriterion` | Convergence criterion | enum | `"residual_criterion"` |  | residual_criterion, displacement_criterion, and_criterion, or_criterion |
| `s_residualRelTol` | Residual rel. tol. | number | `0.0001` |  |  |
| `s_residualAbsTol` | Residual abs. tol. | number | `1e-9` |  |  |
| `s_displacementRelTol` | Displacement rel. tol. | number | `0.0001` |  |  |
| `s_displacementAbsTol` | Displacement abs. tol. | number | `1e-9` |  |  |
| `s_maxIteration` | Max iterations | int | `10` |  |  |
| `s_lineSearch` | Line search | bool | `false` |  |  |
| `s_useOldStiffness` | Use old stiffness in first iteration | bool | `false` |  |  |
| `s_rayleighAlpha` | Rayleigh α (mass) | number | `0` |  |  |
| `s_rayleighBeta` | Rayleigh β (stiffness) | number | `0` |  |  |
| `s_eigenCount` | Number of eigenvalues | int | `5` |  |  |
| `s_eigenMaxIteration` | Max iterations | int | `1000` |  |  |
| `s_eigenTolerance` | Tolerance | number | `0.000001` |  |  |
| `s_eigenSolver` | Eigensolver | enum | `"eigen_eigensystem"` |  | eigen_eigensystem, spectra_sym_g_eigs_shift, dense_eigensolver, power_iteration_eigenvalue_solver, power_iteration_highest_eigenvalue_solver |
| `s_eigenModalDecomposition` | Compute modal decomposition | bool | `false` |  |  |
| `s_eigenNormalizeEigenvectors` | Normalize eigenvectors with mass matrix | bool | `false` |  |  |
| `s_linearSolver` | Solver | enum | `"automatic"` |  | automatic, LinearSolversApplication.sparse_lu, cg, bicgstab |
| `s_linearMaxIteration` | Max iterations | int | `200` |  |  |
| `s_linearTolerance` | Tolerance | number | `1e-7` |  |  |
| `s_preconditioner` | Preconditioner | enum | `"none"` |  | none, diagonal, ilu, ilu0 |
| `s_echoLevel` | Echo level | int | `1` |  |  |

## Conditions

### Fluid body (`f_parts`)

List: `list_other_processes`

### Initial velocity (`f_initialVelocity`)

List: `fluid_initial_conditions_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [m/s] | vector3 | `[0,0,0]` |  |  |
| `constrained` | Fixed | bool | `false` |  |  |

### Initial pressure (`f_initialPressure`)

List: `fluid_initial_conditions_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [Pa] | number | `0` |  |  |
| `constrained` | Fixed | bool | `false` |  |  |

### Initial temperature (`f_initialTemperature`)

List: `fluid_initial_conditions_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [K] | number | `293.15` |  |  |
| `constrained` | Fixed | bool | `false` |  |  |

### Inlet velocity (`f_inlet`)

List: `fluid_boundary_conditions_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `modulus` | \|v\| [m/s] | number | `1` |  |  |
| `modulusExpression` | \|v\| expression | string | `""` |  |  |
| `intervalStart` | Active from [s] | number | `0` |  |  |
| `intervalEnd` | Active until [s] | string | `"End"` |  |  |
| `direction` | Direction | enum | `"automatic_inwards_normal"` |  | automatic_inwards_normal, automatic_outwards_normal, x, y, z |

### Outlet pressure (`f_outlet`)

List: `fluid_boundary_conditions_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Pressure [Pa] | number | `0` |  |  |
| `hydrostatic` | Add hydrostatic contribution | bool | `false` |  |  |
| `hTop` | Top height [m] | number | `0` |  |  |

### Slip wall (`f_slip`)

List: `fluid_boundary_conditions_process_list`

### No-slip wall (`f_noSlip`)

List: `fluid_boundary_conditions_process_list`

### Wall law (`f_wallLaw`)

List: `fluid_boundary_conditions_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `wallModel` | Wall model | enum | `"navier_slip"` |  | navier_slip, linear_log |
| `slipLength` | Slip length [m] | number | `0.001` |  |  |
| `yWall` | Wall distance [m] | number | `0.001` |  |  |

### Custom velocity constraints (`f_velocityConstraints`)

List: `fluid_boundary_conditions_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [m/s] | vector3 | `[0,0,0]` |  |  |
| `constrained` | Fixed | bool | `true` |  |  |

### Custom pressure constraints (`f_pressureConstraints`)

List: `fluid_boundary_conditions_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [Pa] | number | `0` |  |  |
| `constrained` | Fixed | bool | `true` |  |  |

### Periodic boundary (`f_periodic`)

List: `fluid_boundary_conditions_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `master` | Master boundary | smp | `""` |  |  |
| `translation` | Translation direction | vector3 | `[1,0,0]` |  |  |
| `magnitude` | Translation distance [m] | number | `1` |  |  |

### Forces and moments on a body (`f_flowForces`)

List: `fluid_auxiliar_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `referencePoint` | Moment reference point | vector3 | `[0,0,0]` |  |  |
| `writeMoments` | Write moments | bool | `true` |  |  |
| `printToScreen` | Print to screen | bool | `false` |  |  |

### Aerodynamic coefficients (`f_aerodynamicCoefficients`)

List: `fluid_auxiliar_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `referenceArea` | Reference area [m²] | number | `1` |  |  |
| `referenceChord` | Reference chord [m] | number | `1` |  |  |
| `dynamicPressure` | Dynamic pressure [Pa] | number | `1` |  |  |
| `referencePoint` | Moment reference point | vector3 | `[0,0,0]` |  |  |
| `printToScreen` | Print to screen | bool | `false` |  |  |

### Pressure coefficient (`f_pressureCoefficient`)

List: `fluid_auxiliar_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `freestreamDensity` | Free-stream density [kg/m³] | number | `1.204` |  |  |
| `freestreamVelocity` | Free-stream speed [m/s] | number | `1` |  |  |
| `freestreamPressure` | Free-stream pressure [Pa] | number | `0` |  |  |

### Wall y+ (`f_yPlus`)

List: `fluid_auxiliar_process_list`

### ALE mesh displacement (`aleMeshBC`)

List: `fluid_boundary_conditions_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [m] | vector3 | `[0,0,0]` |  |  |
| `constrained` | Fixed | bool | `true` |  |  |

### FSI fluid interface (`fluidInterface`)

List: `list_other_processes` — marks a SubModelPart, emits no process

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `mapperFace` | Mapper face | enum | `"unique"` |  | unique, positive, negative |

### Structure body (`s_parts`)

List: `list_other_processes`

### Displacement (`s_displacement`)

List: `structure_constraints_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [m] | vector3 | `[0,0,0]` |  |  |
| `constrained` | Fixed | bool | `true` |  |  |

### Rotation (`s_rotation`)

List: `structure_constraints_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [rad] | vector3 | `[0,0,0]` |  |  |
| `constrained` | Fixed | bool | `true` |  |  |

### Pressure (`s_pressure`)

List: `structure_constraints_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [Pa] | number | `0` |  |  |
| `constrained` | Fixed | bool | `true` |  |  |

### Volumetric strain (`s_volumetricStrain`)

List: `structure_constraints_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value | number | `0` |  |  |
| `constrained` | Fixed | bool | `true` |  |  |

### Initial velocity (`s_initialVelocity`)

List: `structure_constraints_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [m/s] | vector3 | `[0,0,0]` |  |  |
| `constrained` | Fixed | bool | `false` |  |  |

### Initial acceleration (`s_initialAcceleration`)

List: `structure_constraints_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [m/s²] | vector3 | `[0,0,0]` |  |  |
| `constrained` | Fixed | bool | `false` |  |  |

### Angular velocity (`s_angularVelocity`)

List: `structure_constraints_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [rad/s] | vector3 | `[0,0,0]` |  |  |
| `constrained` | Fixed | bool | `false` |  |  |

### Angular acceleration (`s_angularAcceleration`)

List: `structure_constraints_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [rad/s²] | vector3 | `[0,0,0]` |  |  |
| `constrained` | Fixed | bool | `false` |  |  |

### Self weight (`s_selfWeight`)

List: `structure_loads_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `modulus` | Modulus [m/s²] | number | `9.81` |  |  |
| `direction` | Direction | vector3 | `[0,0,-1]` |  |  |

### Point load (`s_pointLoad`)

List: `structure_loads_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `modulus` | Modulus [N] | number | `0` |  |  |
| `direction` | Direction | vector3 | `[0,0,-1]` |  |  |

### Point moment (`s_pointMoment`)

List: `structure_loads_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `modulus` | Modulus [N·m] | number | `0` |  |  |
| `direction` | Direction | vector3 | `[0,0,-1]` |  |  |

### Imaginary point load (`s_imaginaryPointLoad`)

List: `structure_loads_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `modulus` | Modulus [N] | number | `0` |  |  |
| `direction` | Direction | vector3 | `[0,0,-1]` |  |  |

### Moving load (`s_movingLoad`)

List: `structure_loads_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `modulus` | Modulus [N] | number | `0` |  |  |
| `direction` | Direction | vector3 | `[0,0,-1]` |  |  |
| `velocity` | Velocity [m/s] | number | `1` |  |  |
| `motionDirection` | Motion direction | vector3 | `[1,0,0]` |  |  |
| `origin` | Origin [m] | vector3 | `[0,0,0]` |  |  |
| `motionType` | Motion type | enum | `"base"` |  | base, total |

### Line load (`s_lineLoad`)

List: `structure_loads_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `modulus` | Modulus [N/m] | number | `0` |  |  |
| `direction` | Direction | vector3 | `[0,0,-1]` |  |  |
| `loadMode` | Modulus is | enum | `"distributed"` |  | distributed, total |

### Surface load (`s_surfaceLoad`)

List: `structure_loads_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `modulus` | Modulus [N/m²] | number | `0` |  |  |
| `direction` | Direction | vector3 | `[0,0,-1]` |  |  |
| `loadMode` | Modulus is | enum | `"distributed"` |  | distributed, total |

### Surface pressure (`s_surfacePressure`)

List: `structure_loads_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [Pa] | number | `0` |  |  |

### FSI structure interface (`structureInterface`)

List: `list_other_processes` — marks a SubModelPart, emits no process

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

### bingham_3d

Constitutive law: `Bingham3DLaw`, 3D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `1000` | kg/m³ |  |
| `DYNAMIC_VISCOSITY` | Plastic viscosity [Pa·s] | number | `0.001` | Pa·s |  |
| `YIELD_STRESS` | Yield stress [Pa] | number | `1` | Pa |  |
| `REGULARIZATION_COEFFICIENT` | Regularization coefficient | number | `100` |  |  |

### bingham_2d

Constitutive law: `Bingham2DLaw`, 2D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `1000` | kg/m³ |  |
| `DYNAMIC_VISCOSITY` | Plastic viscosity [Pa·s] | number | `0.001` | Pa·s |  |
| `YIELD_STRESS` | Yield stress [Pa] | number | `1` | Pa |  |
| `REGULARIZATION_COEFFICIENT` | Regularization coefficient | number | `100` |  |  |

### herschel_bulkley_3d

Constitutive law: `HerschelBulkley3DLaw`, 3D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `1000` | kg/m³ |  |
| `YIELD_STRESS` | Yield stress [Pa] | number | `1` | Pa |  |
| `POWER_LAW_K` | Consistency index K | number | `0.001` |  |  |
| `POWER_LAW_N` | Power-law index n | number | `1` |  |  |
| `REGULARIZATION_COEFFICIENT` | Regularization coefficient | number | `100` |  |  |

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

### linear_elastic_3d

Constitutive law: `LinearElastic3DLaw`, 3D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `7850` | kg/m³ |  |
| `YOUNG_MODULUS` | Young modulus [Pa] | number | `210000000000` | Pa |  |
| `POISSON_RATIO` | Poisson ratio | number | `0.29` |  |  |

### linear_elastic_plane_strain

Constitutive law: `LinearElasticPlaneStrain2DLaw`, 2D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `7850` | kg/m³ |  |
| `YOUNG_MODULUS` | Young modulus [Pa] | number | `210000000000` | Pa |  |
| `POISSON_RATIO` | Poisson ratio | number | `0.29` |  |  |
| `THICKNESS` | Thickness [m] | number | `1` | m |  |

### linear_elastic_plane_stress

Constitutive law: `LinearElasticPlaneStress2DLaw`, 2D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `7850` | kg/m³ |  |
| `YOUNG_MODULUS` | Young modulus [Pa] | number | `210000000000` | Pa |  |
| `POISSON_RATIO` | Poisson ratio | number | `0.29` |  |  |
| `THICKNESS` | Thickness [m] | number | `1` | m |  |

### linear_elastic_axisym

Constitutive law: `LinearElasticAxisym2DLaw`, 2D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `7850` | kg/m³ |  |
| `YOUNG_MODULUS` | Young modulus [Pa] | number | `210000000000` | Pa |  |
| `POISSON_RATIO` | Poisson ratio | number | `0.29` |  |  |

### beam_2d

Constitutive law: `BeamConstitutiveLaw`, 2D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `7850` | kg/m³ |  |
| `YOUNG_MODULUS` | Young modulus [Pa] | number | `210000000000` | Pa |  |
| `POISSON_RATIO` | Poisson ratio | number | `0.29` |  |  |
| `CROSS_AREA` | Cross area [m²] | number | `1` | m² |  |
| `I33` | Bending inertia I33 [m⁴] | number | `1` | m⁴ |  |

### beam_3d

Constitutive law: `BeamConstitutiveLaw`, 3D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `7850` | kg/m³ |  |
| `YOUNG_MODULUS` | Young modulus [Pa] | number | `210000000000` | Pa |  |
| `POISSON_RATIO` | Poisson ratio | number | `0.29` |  |  |
| `CROSS_AREA` | Cross area [m²] | number | `1` | m² |  |
| `TORSIONAL_INERTIA` | Torsional inertia [m⁴] | number | `1` | m⁴ |  |
| `I22` | Bending inertia I22 [m⁴] | number | `1` | m⁴ |  |
| `I33` | Bending inertia I33 [m⁴] | number | `1` | m⁴ |  |

### truss

Constitutive law: `TrussConstitutiveLaw`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `7850` | kg/m³ |  |
| `YOUNG_MODULUS` | Young modulus [Pa] | number | `210000000000` | Pa |  |
| `CROSS_AREA` | Cross area [m²] | number | `1` | m² |  |
| `TRUSS_PRESTRESS_PK2` | Prestress [Pa] | number | `0` | Pa |  |

### shell

Constitutive law: `ReissnerMindlinShellElasticConstitutiveLaw`, 3D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `7850` | kg/m³ |  |
| `YOUNG_MODULUS` | Young modulus [Pa] | number | `210000000000` | Pa |  |
| `POISSON_RATIO` | Poisson ratio | number | `0.29` |  |  |
| `THICKNESS` | Thickness [m] | number | `1` | m |  |

### membrane

Constitutive law: `LinearElasticPlaneStress2DLaw`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `7850` | kg/m³ |  |
| `YOUNG_MODULUS` | Young modulus [Pa] | number | `210000000000` | Pa |  |
| `POISSON_RATIO` | Poisson ratio | number | `0.29` |  |  |
| `THICKNESS` | Thickness [m] | number | `1` | m |  |

### hyperelastic_3d

Constitutive law: `HyperElastic3DLaw`, 3D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `7850` | kg/m³ |  |
| `YOUNG_MODULUS` | Young modulus [Pa] | number | `210000000000` | Pa |  |
| `POISSON_RATIO` | Poisson ratio | number | `0.29` |  |  |

### hyperelastic_plane_strain

Constitutive law: `HyperElasticPlaneStrain2DLaw`, 2D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `7850` | kg/m³ |  |
| `YOUNG_MODULUS` | Young modulus [Pa] | number | `210000000000` | Pa |  |
| `POISSON_RATIO` | Poisson ratio | number | `0.29` |  |  |

### kirchhoff_3d

Constitutive law: `KirchhoffSaintVenant3DLaw`, 3D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `7850` | kg/m³ |  |
| `YOUNG_MODULUS` | Young modulus [Pa] | number | `210000000000` | Pa |  |
| `POISSON_RATIO` | Poisson ratio | number | `0.29` |  |  |

### kirchhoff_plane_strain

Constitutive law: `KirchhoffSaintVenantPlaneStrain2DLaw`, 2D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `7850` | kg/m³ |  |
| `YOUNG_MODULUS` | Young modulus [Pa] | number | `210000000000` | Pa |  |
| `POISSON_RATIO` | Poisson ratio | number | `0.29` |  |  |

### kirchhoff_plane_stress

Constitutive law: `KirchhoffSaintVenantPlaneStress2DLaw`, 2D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `7850` | kg/m³ |  |
| `YOUNG_MODULUS` | Young modulus [Pa] | number | `210000000000` | Pa |  |
| `POISSON_RATIO` | Poisson ratio | number | `0.29` |  |  |
| `THICKNESS` | Thickness [m] | number | `1` | m |  |

### plasticity_iso_3d

Constitutive law: `SmallStrainIsotropicPlasticityFactory`, 3D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `7850` | kg/m³ |  |
| `YOUNG_MODULUS` | Young modulus [Pa] | number | `210000000000` | Pa |  |
| `POISSON_RATIO` | Poisson ratio | number | `0.29` |  |  |
| `YIELD_STRESS` | Yield stress [Pa] | number | `1000000` | Pa |  |
| `FRACTURE_ENERGY` | Fracture energy [J/m²] | number | `100` | J/m² |  |
| `HARDENING_CURVE` | Hardening curve | int | `0` |  |  |
| `MAXIMUM_STRESS_POSITION` | Peak stress position | number | `0.3` |  |  |
| `MAXIMUM_STRESS` | Peak stress [Pa] | number | `2000000` | Pa |  |

### plasticity_iso_plane_strain

Constitutive law: `SmallStrainIsotropicPlasticityFactory`, 2D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `7850` | kg/m³ |  |
| `YOUNG_MODULUS` | Young modulus [Pa] | number | `210000000000` | Pa |  |
| `POISSON_RATIO` | Poisson ratio | number | `0.29` |  |  |
| `YIELD_STRESS` | Yield stress [Pa] | number | `1000000` | Pa |  |
| `FRACTURE_ENERGY` | Fracture energy [J/m²] | number | `100` | J/m² |  |
| `HARDENING_CURVE` | Hardening curve | int | `0` |  |  |
| `MAXIMUM_STRESS_POSITION` | Peak stress position | number | `0.3` |  |  |
| `MAXIMUM_STRESS` | Peak stress [Pa] | number | `2000000` | Pa |  |

### plasticity_iso_plane_stress

Constitutive law: `SmallStrainIsotropicPlasticityFactory`, 2D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `7850` | kg/m³ |  |
| `YOUNG_MODULUS` | Young modulus [Pa] | number | `210000000000` | Pa |  |
| `POISSON_RATIO` | Poisson ratio | number | `0.29` |  |  |
| `YIELD_STRESS` | Yield stress [Pa] | number | `1000000` | Pa |  |
| `FRACTURE_ENERGY` | Fracture energy [J/m²] | number | `100` | J/m² |  |
| `HARDENING_CURVE` | Hardening curve | int | `0` |  |  |
| `MAXIMUM_STRESS_POSITION` | Peak stress position | number | `0.3` |  |  |
| `MAXIMUM_STRESS` | Peak stress [Pa] | number | `2000000` | Pa |  |
| `THICKNESS` | Thickness [m] | number | `1` | m |  |

### plasticity_kin_3d

Constitutive law: `SmallStrainKinematicPlasticityFactory`, 3D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `7850` | kg/m³ |  |
| `YOUNG_MODULUS` | Young modulus [Pa] | number | `210000000000` | Pa |  |
| `POISSON_RATIO` | Poisson ratio | number | `0.29` |  |  |
| `YIELD_STRESS` | Yield stress [Pa] | number | `1000000` | Pa |  |
| `FRACTURE_ENERGY` | Fracture energy [J/m²] | number | `100` | J/m² |  |
| `HARDENING_CURVE` | Hardening curve | int | `0` |  |  |
| `MAXIMUM_STRESS_POSITION` | Peak stress position | number | `0.3` |  |  |
| `MAXIMUM_STRESS` | Peak stress [Pa] | number | `2000000` | Pa |  |
| `KINEMATIC_HARDENING_TYPE` | Kinematic hardening type | int | `0` |  |  |
| `KINEMATIC_PLASTICITY_PARAMETERS` | Kinematic hardening parameters | vector3 | `[1000000000,0,0]` |  |  |

### plasticity_kin_plane_stress

Constitutive law: `SmallStrainKinematicPlasticityFactory`, 2D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `7850` | kg/m³ |  |
| `YOUNG_MODULUS` | Young modulus [Pa] | number | `210000000000` | Pa |  |
| `POISSON_RATIO` | Poisson ratio | number | `0.29` |  |  |
| `YIELD_STRESS` | Yield stress [Pa] | number | `1000000` | Pa |  |
| `FRACTURE_ENERGY` | Fracture energy [J/m²] | number | `100` | J/m² |  |
| `HARDENING_CURVE` | Hardening curve | int | `0` |  |  |
| `MAXIMUM_STRESS_POSITION` | Peak stress position | number | `0.3` |  |  |
| `MAXIMUM_STRESS` | Peak stress [Pa] | number | `2000000` | Pa |  |
| `KINEMATIC_HARDENING_TYPE` | Kinematic hardening type | int | `0` |  |  |
| `KINEMATIC_PLASTICITY_PARAMETERS` | Kinematic hardening parameters | vector3 | `[1000000000,0,0]` |  |  |
| `THICKNESS` | Thickness [m] | number | `1` | m |  |

### plasticity_finite_iso_3d

Constitutive law: `FiniteStrainIsotropicPlasticity3DVonMisesVonMises`, 3D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `7850` | kg/m³ |  |
| `YOUNG_MODULUS` | Young modulus [Pa] | number | `210000000000` | Pa |  |
| `POISSON_RATIO` | Poisson ratio | number | `0.29` |  |  |
| `YIELD_STRESS` | Yield stress [Pa] | number | `1000000` | Pa |  |
| `FRACTURE_ENERGY` | Fracture energy [J/m²] | number | `100` | J/m² |  |
| `HARDENING_CURVE` | Hardening curve | int | `0` |  |  |
| `MAXIMUM_STRESS_POSITION` | Peak stress position | number | `0.3` |  |  |
| `MAXIMUM_STRESS` | Peak stress [Pa] | number | `2000000` | Pa |  |

### plasticity_finite_iso_plane_stress

Constitutive law: `FiniteStrainIsotropicPlasticityPlaneStressVonMisesVonMises`, 2D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `7850` | kg/m³ |  |
| `YOUNG_MODULUS` | Young modulus [Pa] | number | `210000000000` | Pa |  |
| `POISSON_RATIO` | Poisson ratio | number | `0.29` |  |  |
| `YIELD_STRESS` | Yield stress [Pa] | number | `1000000` | Pa |  |
| `FRACTURE_ENERGY` | Fracture energy [J/m²] | number | `100` | J/m² |  |
| `HARDENING_CURVE` | Hardening curve | int | `0` |  |  |
| `MAXIMUM_STRESS_POSITION` | Peak stress position | number | `0.3` |  |  |
| `MAXIMUM_STRESS` | Peak stress [Pa] | number | `2000000` | Pa |  |
| `THICKNESS` | Thickness [m] | number | `1` | m |  |

### plasticity_finite_kin_3d

Constitutive law: `FiniteStrainKinematicPlasticity3DVonMisesVonMises`, 3D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `7850` | kg/m³ |  |
| `YOUNG_MODULUS` | Young modulus [Pa] | number | `210000000000` | Pa |  |
| `POISSON_RATIO` | Poisson ratio | number | `0.29` |  |  |
| `YIELD_STRESS` | Yield stress [Pa] | number | `1000000` | Pa |  |
| `FRACTURE_ENERGY` | Fracture energy [J/m²] | number | `100` | J/m² |  |
| `HARDENING_CURVE` | Hardening curve | int | `0` |  |  |
| `MAXIMUM_STRESS_POSITION` | Peak stress position | number | `0.3` |  |  |
| `MAXIMUM_STRESS` | Peak stress [Pa] | number | `2000000` | Pa |  |
| `KINEMATIC_HARDENING_TYPE` | Kinematic hardening type | int | `0` |  |  |
| `KINEMATIC_PLASTICITY_PARAMETERS` | Kinematic hardening parameters | vector3 | `[1000000000,0,0]` |  |  |

### plasticity_finite_kin_plane_stress

Constitutive law: `FiniteStrainKinematicPlasticityPlaneStressVonMisesVonMises`, 2D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `7850` | kg/m³ |  |
| `YOUNG_MODULUS` | Young modulus [Pa] | number | `210000000000` | Pa |  |
| `POISSON_RATIO` | Poisson ratio | number | `0.29` |  |  |
| `YIELD_STRESS` | Yield stress [Pa] | number | `1000000` | Pa |  |
| `FRACTURE_ENERGY` | Fracture energy [J/m²] | number | `100` | J/m² |  |
| `HARDENING_CURVE` | Hardening curve | int | `0` |  |  |
| `MAXIMUM_STRESS_POSITION` | Peak stress position | number | `0.3` |  |  |
| `MAXIMUM_STRESS` | Peak stress [Pa] | number | `2000000` | Pa |  |
| `KINEMATIC_HARDENING_TYPE` | Kinematic hardening type | int | `0` |  |  |
| `KINEMATIC_PLASTICITY_PARAMETERS` | Kinematic hardening parameters | vector3 | `[1000000000,0,0]` |  |  |
| `THICKNESS` | Thickness [m] | number | `1` | m |  |

### plasticity_j2_3d

Constitutive law: `SmallStrainJ2Plasticity3DLaw`, 3D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `7850` | kg/m³ |  |
| `YOUNG_MODULUS` | Young modulus [Pa] | number | `210000000000` | Pa |  |
| `POISSON_RATIO` | Poisson ratio | number | `0.29` |  |  |
| `YIELD_STRESS` | Yield stress [Pa] | number | `5500000` | Pa |  |
| `REFERENCE_HARDENING_MODULUS` | Reference hardening modulus | number | `1` |  |  |
| `ISOTROPIC_HARDENING_MODULUS` | Isotropic hardening modulus | number | `0.12924` |  |  |
| `INFINITY_HARDENING_MODULUS` | Saturation hardening modulus | number | `0` |  |  |
| `HARDENING_EXPONENT` | Hardening exponent | number | `1` |  |  |

### plasticity_j2_plane_strain

Constitutive law: `SmallStrainJ2PlasticityPlaneStrain2DLaw`, 2D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `7850` | kg/m³ |  |
| `YOUNG_MODULUS` | Young modulus [Pa] | number | `210000000000` | Pa |  |
| `POISSON_RATIO` | Poisson ratio | number | `0.29` |  |  |
| `YIELD_STRESS` | Yield stress [Pa] | number | `5500000` | Pa |  |
| `REFERENCE_HARDENING_MODULUS` | Reference hardening modulus | number | `1` |  |  |
| `ISOTROPIC_HARDENING_MODULUS` | Isotropic hardening modulus | number | `0.12924` |  |  |
| `INFINITY_HARDENING_MODULUS` | Saturation hardening modulus | number | `0` |  |  |
| `HARDENING_EXPONENT` | Hardening exponent | number | `1` |  |  |

### damage_iso_3d

Constitutive law: `SmallStrainIsotropicDamageFactory`, 3D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `7850` | kg/m³ |  |
| `YOUNG_MODULUS` | Young modulus [Pa] | number | `210000000000` | Pa |  |
| `POISSON_RATIO` | Poisson ratio | number | `0.29` |  |  |
| `YIELD_STRESS` | Yield stress [Pa] | number | `1000000` | Pa |  |
| `FRACTURE_ENERGY` | Fracture energy [J/m²] | number | `100` | J/m² |  |
| `SOFTENING_TYPE` | Softening type | int | `0` |  |  |

### damage_iso_plane_strain

Constitutive law: `SmallStrainIsotropicDamageFactory`, 2D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `7850` | kg/m³ |  |
| `YOUNG_MODULUS` | Young modulus [Pa] | number | `210000000000` | Pa |  |
| `POISSON_RATIO` | Poisson ratio | number | `0.29` |  |  |
| `YIELD_STRESS` | Yield stress [Pa] | number | `1000000` | Pa |  |
| `FRACTURE_ENERGY` | Fracture energy [J/m²] | number | `100` | J/m² |  |
| `SOFTENING_TYPE` | Softening type | int | `0` |  |  |

### damage_iso_plane_stress

Constitutive law: `SmallStrainIsotropicDamageFactory`, 2D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `7850` | kg/m³ |  |
| `YOUNG_MODULUS` | Young modulus [Pa] | number | `210000000000` | Pa |  |
| `POISSON_RATIO` | Poisson ratio | number | `0.29` |  |  |
| `YIELD_STRESS` | Yield stress [Pa] | number | `1000000` | Pa |  |
| `FRACTURE_ENERGY` | Fracture energy [J/m²] | number | `100` | J/m² |  |
| `SOFTENING_TYPE` | Softening type | int | `0` |  |  |
| `THICKNESS` | Thickness [m] | number | `1` | m |  |

### damage_plastic_3d

Constitutive law: `AssociativePlasticDamageModel3DVonMises`, 3D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `7850` | kg/m³ |  |
| `YOUNG_MODULUS` | Young modulus [Pa] | number | `210000000000` | Pa |  |
| `POISSON_RATIO` | Poisson ratio | number | `0.29` |  |  |
| `YIELD_STRESS` | Yield stress [Pa] | number | `1000000` | Pa |  |
| `FRACTURE_ENERGY` | Fracture energy [J/m²] | number | `100` | J/m² |  |
| `HARDENING_CURVE` | Hardening curve | int | `0` |  |  |

### viscous_maxwell_3d

Constitutive law: `ViscousGeneralizedMaxwell3D`, 3D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `7850` | kg/m³ |  |
| `YOUNG_MODULUS` | Young modulus [Pa] | number | `210000000000` | Pa |  |
| `POISSON_RATIO` | Poisson ratio | number | `0.29` |  |  |
| `VISCOUS_PARAMETER` | Viscous parameter | number | `0.15` |  |  |
| `DELAY_TIME` | Delay time [s] | number | `100` | s |  |

### viscous_kelvin_3d

Constitutive law: `ViscousGeneralizedKelvin3D`, 3D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `7850` | kg/m³ |  |
| `YOUNG_MODULUS` | Young modulus [Pa] | number | `210000000000` | Pa |  |
| `POISSON_RATIO` | Poisson ratio | number | `0.29` |  |  |
| `DELAY_TIME` | Delay time [s] | number | `1` | s |  |

### point_mass

Constitutive law: —

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `NODAL_MASS` | Point mass [kg] | number | `1` | kg |  |
| `NODAL_INERTIA` | Rotational inertia [kg·m²] | vector3 |  | kg·m² |  |
| `NODAL_DISPLACEMENT_STIFFNESS` | Spring stiffness [N/m] | vector3 |  | N/m |  |
| `NODAL_DAMPING_RATIO` | Damper coefficient [N·s/m] | vector3 |  | N·s/m |  |

### spring

Constitutive law: —

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `NODAL_DISPLACEMENT_STIFFNESS` | Translational stiffness [N/m] | vector3 |  | N/m |  |
| `NODAL_ROTATIONAL_STIFFNESS` | Rotational stiffness [N·m/rad] | vector3 |  | N·m/rad |  |
| `NODAL_DAMPING_RATIO` | Translational damper [N·s/m] | vector3 |  | N·s/m |  |
| `NODAL_ROTATIONAL_DAMPING_RATIO` | Rotational damper [N·m·s/rad] | vector3 |  | N·m·s/rad |  |

### bushing

Constitutive law: —, 3D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `NODAL_DISPLACEMENT_STIFFNESS` | Translational stiffness [N/m] | vector3 |  | N/m |  |
| `NODAL_ROTATIONAL_STIFFNESS` | Rotational stiffness [N·m/rad] | vector3 |  | N·m/rad |  |

### line_mass

Constitutive law: —, 3D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `7850` | kg/m³ |  |
| `CROSS_AREA` | Cross area [m²] | number | `1` | m² |  |

### surface_mass

Constitutive law: —, 3D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `7850` | kg/m³ |  |
| `THICKNESS` | Thickness [m] | number | `1` | m |  |
<!-- END GENERATED: problemtype-fsi -->
