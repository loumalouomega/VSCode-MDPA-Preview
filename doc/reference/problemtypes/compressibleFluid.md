# Problemtype: Compressible Fluid

Generated from the built-in `ProblemtypeDeclaration`; run `npm run docs:reference` after changing it.

<!-- BEGIN GENERATED: problemtype-compressibleFluid -->
**Compressible Fluid** (`compressibleFluid`) — Explicit compressible Navier-Stokes with shock capturing, 2D (FluidDynamicsApplication)

- Analysis stage: `KratosMultiphysics.FluidDynamicsApplication.fluid_dynamics_analysis`
- Root model part: `FluidModelPart`
- Materials file: `FluidMaterials.json`
- Domain sizes: 2

## Sections

### Problem data

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `timeScheme` | Time scheme | enum | `"RK4"` |  | RK4, RK3-TVD, bfecc, forward_euler |
| `startTime` | Start time | number | `0` | s |  |
| `endTime` | End time | number | `1` | s |  |
| `timeStepMode` | Time stepping | enum | `"adaptive"` |  | fixed, adaptive |
| `timeStep` | Time step | number | `0.0001` | s |  |
| `courantTarget` | Target Courant number | number | `0.5` |  |  |
| `minDeltaTime` | Min. time step | number | `1e-8` |  |  |
| `maxDeltaTime` | Max. time step | number | `0.001` |  |  |
| `shockCapturing` | Shock capturing | enum | `"physics_based"` |  | none, physics_based, entropy_based |
| `useOss` | Orthogonal subscales | bool | `false` |  |  |
| `echoLevel` | Echo level | int | `0` |  |  |
| `computeReactions` | Compute reactions | bool | `false` |  |  |

## Conditions

### Fluid body (`parts`)

List: `list_other_processes`

### Initial momentum (`initialMomentum`)

List: `initial_conditions_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [kg/(m²·s)] | vector3 | `[0,0,0]` |  |  |
| `constrained` | Fixed | bool | `false` |  |  |

### Initial density (`initialDensity`)

List: `initial_conditions_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [kg/m³] | number | `1.225` |  |  |
| `constrained` | Fixed | bool | `false` |  |  |

### Initial total energy (`initialEnergy`)

List: `initial_conditions_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [J/m³] | number | `0` |  |  |
| `constrained` | Fixed | bool | `false` |  |  |

### Slip wall (`slip`)

List: `constraints_process_list`

### No-slip wall (`noSlip`)

List: `constraints_process_list`

### Prescribed density (`densityBC`)

List: `constraints_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [kg/m³] | number | `1.225` |  |  |
| `constrained` | Fixed | bool | `true` |  |  |

### Prescribed energy (`energyBC`)

List: `constraints_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [J/m³] | number | `0` |  |  |
| `constrained` | Fixed | bool | `true` |  |  |

### Prescribed momentum (`momentumConstraints`)

List: `constraints_process_list`

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `value` | Value [kg/(m²·s)] | vector3 | `[0,0,0]` |  |  |
| `constrained` | Fixed | bool | `true` |  |  |

## Material laws

### newtonian_2d

Constitutive law: `Newtonian2DLaw`, 2D only

| Field | Label | Type | Default | Unit | Choices |
| --- | --- | --- | --- | --- | --- |
| `DENSITY` | Density [kg/m³] | number | `1.225` | kg/m³ |  |
| `DYNAMIC_VISCOSITY` | Dynamic viscosity [Pa·s] | number | `0.00002` | Pa·s |  |
| `CONDUCTIVITY` | Conductivity [W/(m·K)] | number | `0.024` | W/(m·K) |  |
| `SPECIFIC_HEAT` | Specific heat [J/(kg·K)] | number | `722.14` | J/(kg·K) |  |
| `HEAT_CAPACITY_RATIO` | Heat capacity ratio | number | `1.4` |  |  |
<!-- END GENERATED: problemtype-compressibleFluid -->
