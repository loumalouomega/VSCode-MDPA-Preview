# Problemtype: ROM · Structural Mechanics

Generated from the built-in `ProblemtypeDeclaration`; run `npm run docs:reference` after changing it.

<!-- BEGIN GENERATED: problemtype-romStructural -->
**ROM · Structural Mechanics** (`romStructural`) — Reduced-order model (POD-Galerkin ROM and HROM) of Structural Mechanics, trained over sampled case values (RomApplication)

- Analysis stage: `KratosMultiphysics.StructuralMechanicsApplication.structural_mechanics_analysis`
- Root model part: `Structure`
- Materials file: `StructuralMaterials.json`
- Domain sizes: 2, 3

## Sections

### Problem data

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `solverType` | Analysis | enum | `"static"` |  | static, dynamic, eigen_value, harmonic_analysis |
| `analysisType` | Linearity | enum | `"linear"` |  | linear, non_linear |
| `elementBase` | Element formulation | enum | `"SmallDisplacementElement"` |  | SmallDisplacementElement, SmallDisplacementBbarElement, SmallDisplacementMixedVolumetricStrainElement, SmallDisplacementMixedVolumetricStrainOssElement, SmallDisplacementMixedVolumetricStrainOssNonLinearElement, SmallDisplacementMixedStrainElement, TotalLagrangianElement, UpdatedLagrangianElement, TotalLagrangianMixedVolumetricStrainElement, TotalLagrangianQ1P0MixedElement, AxisymSmallDisplacementElement, AxisymTotalLagrangianElement, AxisymUpdatedLagrangianElement, SolidShellElementSprism, LinearTimoshenkoBeamElement, LinearTimoshenkoCurvedBeamElement, CrBeamElement, CrLinearBeamElement, LinearTrussElement, TotalLagrangianTrussElement, TrussElement, TrussLinearElement, CableElement, ShellThinElementCorotational, ShellThickElementCorotational, ShellThinElement, MITCThickShellElement, MITCThickShellCorotationalElement, CSDSG3ThickShellLinearElement, CSDSG3ThickShellCorotationalElement, MembraneElement, NodalConcentratedElement, NodalConcentratedDampedElement, LineMassElement, SurfaceMassElement, BushingElement, SpringDamperElement |
| `schemeType` | Scheme | enum | `"bossak"` |  | newmark, bossak |
| `timeIntegration` | Time integration | enum | `"implicit"` |  | implicit, explicit |
| `explicitScheme` | Explicit scheme | enum | `"central_differences"` |  | central_differences, multi_stage |
| `harmonicType` | Harmonic analysis | enum | `"modal"` |  | modal, direct |
| `harmonicDamping` | Use effective material damping | bool | `false` |  |  |
| `harmonicAssembleDamping` | Assemble damping matrix | bool | `false` |  |  |
| `startTime` | Start time | number | `0` | s |  |
| `timeStep` | Time step | number | `0.1` | s |  |
| `endTime` | End time | number | `1` | s |  |
| `convergenceCriterion` | Convergence criterion | enum | `"residual_criterion"` |  | residual_criterion, displacement_criterion, and_criterion, or_criterion |
| `residualRelTol` | Residual rel. tol. | number | `0.0001` |  |  |
| `residualAbsTol` | Residual abs. tol. | number | `1e-9` |  |  |
| `displacementRelTol` | Displacement rel. tol. | number | `0.0001` |  |  |
| `displacementAbsTol` | Displacement abs. tol. | number | `1e-9` |  |  |
| `maxIteration` | Max iterations | int | `10` |  |  |
| `lineSearch` | Line search | bool | `false` |  |  |
| `useOldStiffness` | Use old stiffness in first iteration | bool | `false` |  |  |
| `rayleighAlpha` | Rayleigh α (mass) | number | `0` |  |  |
| `rayleighBeta` | Rayleigh β (stiffness) | number | `0` |  |  |
| `eigenCount` | Number of eigenvalues | int | `5` |  |  |
| `eigenMaxIteration` | Max iterations | int | `1000` |  |  |
| `eigenTolerance` | Tolerance | number | `0.000001` |  |  |
| `eigenSolver` | Eigensolver | enum | `"eigen_eigensystem"` |  | eigen_eigensystem, spectra_sym_g_eigs_shift, dense_eigensolver, power_iteration_eigenvalue_solver, power_iteration_highest_eigenvalue_solver |
| `eigenModalDecomposition` | Compute modal decomposition | bool | `false` |  |  |
| `eigenNormalizeEigenvectors` | Normalize eigenvectors with mass matrix | bool | `false` |  |  |
| `linearSolver` | Solver | enum | `"automatic"` |  | automatic, LinearSolversApplication.sparse_lu, cg, bicgstab |
| `linearMaxIteration` | Max iterations | int | `200` |  |  |
| `linearTolerance` | Tolerance | number | `1e-7` |  |  |
| `preconditioner` | Preconditioner | enum | `"none"` |  | none, diagonal, ilu, ilu0 |
| `echoLevel` | Echo level | int | `1` |  |  |

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

### Body / Parts (`parts`)

List: `list_other_processes`

### Displacement (`displacement`)

List: `constraints_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [m] | vector3 | `[0,0,0]` |  |  |
| `constrained` | Fixed | bool | `true` |  |  |

### Rotation (`rotation`)

List: `constraints_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [rad] | vector3 | `[0,0,0]` |  |  |
| `constrained` | Fixed | bool | `true` |  |  |

### Pressure (`pressure`)

List: `constraints_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [Pa] | number | `0` |  |  |
| `constrained` | Fixed | bool | `true` |  |  |

### Volumetric strain (`volumetricStrain`)

List: `constraints_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value | number | `0` |  |  |
| `constrained` | Fixed | bool | `true` |  |  |

### Initial velocity (`initialVelocity`)

List: `constraints_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [m/s] | vector3 | `[0,0,0]` |  |  |
| `constrained` | Fixed | bool | `false` |  |  |

### Initial acceleration (`initialAcceleration`)

List: `constraints_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [m/s²] | vector3 | `[0,0,0]` |  |  |
| `constrained` | Fixed | bool | `false` |  |  |

### Angular velocity (`angularVelocity`)

List: `constraints_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [rad/s] | vector3 | `[0,0,0]` |  |  |
| `constrained` | Fixed | bool | `false` |  |  |

### Angular acceleration (`angularAcceleration`)

List: `constraints_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [rad/s²] | vector3 | `[0,0,0]` |  |  |
| `constrained` | Fixed | bool | `false` |  |  |

### Self weight (`selfWeight`)

List: `loads_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `modulus` | Modulus [m/s²] | number | `9.81` |  |  |
| `direction` | Direction | vector3 | `[0,0,-1]` |  |  |

### Point load (`pointLoad`)

List: `loads_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `modulus` | Modulus [N] | number | `0` |  |  |
| `direction` | Direction | vector3 | `[0,0,-1]` |  |  |

### Point moment (`pointMoment`)

List: `loads_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `modulus` | Modulus [N·m] | number | `0` |  |  |
| `direction` | Direction | vector3 | `[0,0,-1]` |  |  |

### Imaginary point load (`imaginaryPointLoad`)

List: `loads_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `modulus` | Modulus [N] | number | `0` |  |  |
| `direction` | Direction | vector3 | `[0,0,-1]` |  |  |

### Moving load (`movingLoad`)

List: `loads_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `modulus` | Modulus [N] | number | `0` |  |  |
| `direction` | Direction | vector3 | `[0,0,-1]` |  |  |
| `velocity` | Velocity [m/s] | number | `1` |  |  |
| `motionDirection` | Motion direction | vector3 | `[1,0,0]` |  |  |
| `origin` | Origin [m] | vector3 | `[0,0,0]` |  |  |
| `motionType` | Motion type | enum | `"base"` |  | base, total |

### Line load (`lineLoad`)

List: `loads_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `modulus` | Modulus [N/m] | number | `0` |  |  |
| `direction` | Direction | vector3 | `[0,0,-1]` |  |  |
| `loadMode` | Modulus is | enum | `"distributed"` |  | distributed, total |

### Surface load (`surfaceLoad`)

List: `loads_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `modulus` | Modulus [N/m²] | number | `0` |  |  |
| `direction` | Direction | vector3 | `[0,0,-1]` |  |  |
| `loadMode` | Modulus is | enum | `"distributed"` |  | distributed, total |

### Surface pressure (`surfacePressure`)

List: `loads_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [Pa] | number | `0` |  |  |

## Material laws

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
<!-- END GENERATED: problemtype-romStructural -->
