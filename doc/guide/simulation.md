# Running Kratos Simulations

The **Problemtype** sidebar section turns any mesh preview into a case builder: pick a physics problemtype, fill in the solver settings, assign boundary conditions and materials to SubModelParts, and the extension generates everything a [Kratos Multiphysics](https://github.com/KratosMultiphysics/Kratos) run needs — then launches it in an integrated terminal. The mesh need not be an `.mdpa`: a mesh in any other format is converted to a `<name>_case.mdpa` case mesh on Generate, since the solver reads `.mdpa`.

![The Problemtype section: the Structural problemtype selected, the Problem data form, condition assignments (Body/Parts, a fixed Displacement, Self weight, a Surface pressure) and a LinearElastic3DLaw material bound to SubModelParts of the previewed mesh, with the Generate / Run / Open results actions below](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/problemtype.png)

## What gets generated

Clicking **Generate case files** writes three files next to the mesh:

| File | Contents |
|---|---|
| `ProjectParameters.json` | The full Kratos parameters document: `analysis_stage`, `problem_data`, `solver_settings` (pointing at your mdpa), `processes` (your condition assignments) and `output_processes` |
| `<Problemtype>Materials.json` | One `properties` entry per material assignment (`model_part_name`, constitutive law, variables) |
| `MainKratos.py` | The generic launcher: reads the JSON, imports the `analysis_stage` module and runs the simulation |

Output is always configured through Kratos' [`vtk_output_process`](https://github.com/KratosMultiphysics/Kratos/blob/master/kratos/python_scripts/vtk_output_process.py), so results land in a `vtk_output/` folder that this extension can preview directly — including [time-series playback](./timeline) that extends live while the solver is still writing steps.

Your form choices are auto-saved to `<name>.kratoscase.json` next to the mdpa and restored the next time you open the preview. The file is plain JSON — commit it to version control to share the case setup.

## Configure the Kratos location

Open **Settings → Extensions → Kratos MDPA Preview** (or search `kratos.` in settings):

| Setting | Meaning |
|---|---|
| `kratos.pythonPath` | Python executable used to run cases. Empty = `python3` (`python` on Windows) |
| `kratos.installPath` | Root of a **compiled** Kratos build (the folder containing `KratosMultiphysics/` and `libs/`, or a source checkout — see below). Leave empty for a pip-installed Kratos |
| `kratos.extraEnv` | Extra environment variables for the run terminal, e.g. `{"OMP_NUM_THREADS": "4"}` |
| `kratos.problemtypes.extraPaths` | Directories scanned for [user problemtypes](./problemtype-authoring) (default `.kratos/problemtypes`) |

Two common setups:

- **pip-installed Kratos** (recommended): `pip install KratosMultiphysics-all` into any Python, point `kratos.pythonPath` at that interpreter, leave `kratos.installPath` empty.
- **Custom-compiled Kratos**: run **Kratos Case: Select Kratos Installation Folder…** from the Command Palette and pick either the install root (the directory holding `KratosMultiphysics/` and `libs/`) or your Kratos **source checkout** — an in-tree build under `bin/Release` (or `RelWithDebInfo`/`Debug`/`FullDebug`) is detected automatically. The command validates the layout and writes `kratos.installPath` (workspace settings when a workspace is open). The run terminal then gets `PYTHONPATH` plus the platform's shared-library path (`LD_LIBRARY_PATH` on Linux, `DYLD_LIBRARY_PATH` on macOS, `PATH` on Windows). Note macOS System Integrity Protection strips `DYLD_*` variables for protected binaries — a pip install avoids the issue entirely.

## Build a case

1. Open the mesh in its preview (`.mdpa` or any other mesh format) and expand the **Problemtype** section.
2. Pick a problemtype from the dropdown, which is grouped by family (see [Built-in problemtypes](#built-in-problemtypes)).
3. Fill the solver cards: the **Problem data** section is split into collapsible groups (Time, Formulation, Solver, Convergence, Parallelism…), advanced options are folded under *Advanced*, and a card keeps its open/closed state while you edit.
4. Under **Conditions**, pick a condition and a SubModelPart and press **+**:
   - Assign the **Body / Parts** pseudo-condition to your domain SubModelPart(s) — it marks the computing domain and emits no process.
   - Assign boundary conditions (displacement, inlet, temperature…) and loads to boundary SubModelParts. Each assignment shows its parameter fields inline; **×** removes it.
5. Under **Materials**, assign a constitutive law to each Parts SubModelPart and adjust its variables — or pick a **material preset** and let it fill the row (see below).

The panel follows the order of GiD's data tree, with a separator and an icon for each stage: header (problemtype, description, summary chips), **Parts**, **Materials**, **Initial conditions**, **Boundary conditions**, **Loads**, the solution cards, **Output (VTK)** and the **Generate / Run / Results** actions. Conditions are listed under their branch with a count, and the condition picker offers them grouped the same way.

## Built-in problemtypes

The built-ins track [GiDInterface](https://github.com/KratosMultiphysics/GiDInterface) (baseline `36c552f`, see [Syncing with GiDInterface](./gidinterface-sync)).

| Family | Problemtypes |
|---|---|
| Solids & structures | **Structural Mechanics** — small/large displacement, mixed, shell, beam, truss and cable formulations; static, dynamic (Newmark/Bossak) and eigenvalue analysis |
| Fluids | **Fluid Dynamics** (monolithic QSVMS/DVMS/FIC and fractional step, wall law), **Compressible Fluid**, **Embedded Fluid**, **Free Surface** (edge-based level set), **Potential Flow**, **Shallow Water** (three solvers) |
| Thermal | **Convection-Diffusion** |
| Coupled physics | **Buoyancy** (Boussinesq natural convection), **Conjugate Heat Transfer** (fluid + solid), **Fluid-Structure Interaction** (partitioned Dirichlet-Neumann over an ALE mesh) |
| Workflow | **Flowgraph** node editor |

### Coupled problemtypes

A coupled problemtype has several **domains** (for example *Fluid* and *Structure*). Each domain has its own Parts condition, conditions, materials and mesh: Generate writes one `ProjectParameters.json` plus `<name>_Fluid.mdpa`, `<name>_Structural.mdpa`… sliced from the mesh you have open by the SubModelParts you assigned to each domain, and one materials file per domain. The interface between the physics is marked with an *interface* condition on each side (FSI: *FSI fluid interface* / *FSI structure interface*; Conjugate Heat Transfer: *Fluid thermal interface* / *Solid thermal interface*); Generate refuses a case missing a domain's parts or either interface half, naming what to fix, and writes nothing.

::: warning Not solver-verified
The new problemtypes follow GiDInterface's writers, but this repository has no Kratos to run them against. Treat the first run of Compressible Fluid, Embedded Fluid, Free Surface, Buoyancy, Conjugate Heat Transfer and FSI as a check of the generated files. MPM and DEM are not provided, nor are GiD's Dam, GeoMechanics, PFEM and Stent apps.
:::

## Material presets

A material preset is a **set of parameter values with a source**, not a constitutive law. The law still decides which variables exist and in which units; the preset supplies the numbers and says where they came from, at what reference conditions.

The Materials form carries a **searchable catalog**, filtered to the constitutive law of the row you are adding. About sixty-five rows ship with the extension, each with its units, reference conditions and a citation:

| Family | Fits | Rows |
|---|---|---|
| Fluids | `Newtonian3DLaw` / `2DLaw` | water at 20/40/60/80 °C, seawater, glycerol, ethanol, mercury, dry air at 0/20/40 °C |
| Structural solids | `LinearElastic3DLaw`, plane strain, plane stress | structural steel, reinforcing steel and stainless steel (Eurocodes), ductile iron, aluminium (EN 1999, 6061-T6, 7075-T6, 2024-T3), Ti-6Al-4V, Inconel 718, copper, magnesium AZ31B, concrete C25/30 · C30/37 · C40/50, softwood C24 and glulam GL24h, soda-lime glass, PMMA |
| Thermal | convection-diffusion material | water, air, aluminium, copper, iron, carbon and stainless steel, titanium, nickel, brass, concrete, glass |
| Roughness | shallow-water Manning | concrete finishes, excavated earth, natural streams, floodplain grass and crops (Chow, *Open-Channel Hydraulics*) |
| Kratos GiD defaults | all of the above | the materials the [Kratos GiD interface](https://github.com/KratosMultiphysics/GiDInterface) offers (steel, aluminium, dam concrete and soil, sand, water, air, gold, grass…), for cases moving over from GiD |

Structural rows are quoted the way their source prints them (`E = 210 GPa`) and converted to the law's Pa on apply. A structural row carries **density, Young's modulus and Poisson's ratio only**: the thickness of a plane law belongs to the model and is left alone, and yield stress, hardening or thermal expansion are not part of a linear-elastic law, so they are not carried. Two caveats are written into the rows themselves: timber is orthotropic and is offered only as an *isotropic* approximation, and the GiD defaults are the Kratos team's tutorial numbers, not handbook values (steel there is 206.9 GPa, against 210 GPa in EN 1993-1-1). Two GiD rows are left out on purpose — rubber, whose Poisson ratio of 0.5 is singular for a linear-elastic law, and the GeoMechanics "Dirt"/"Sand" entries, which are copies of steel and aluminium.

Choose a preset, choose a law and a SubModelPart, and press **+**. The water and air rows at 20 °C quote *kinematic* viscosity rather than dynamic, so the extension derives **μ = ρ·ν** — the status line shows the multiplication, and the material row then reads with the preset's name, source and reference conditions. This happens **exactly once per application**: applying the same preset again replaces the value rather than compounding it, and a preset that quotes μ directly is used as given.

- **A preset names the laws it fits.** It is refused — not partly applied — on a law it does not declare, so a fluid density can never half-fill a structural material.
- **Units convert, or the preset does not apply.** `g/cm³`, `kg/L`, `cP`, `mPa·s`, `cSt`, `mm²/s`, `GPa`, `MPa`, `psi`, `mm` and more are recognised in both directions. A pair that is not the same physical quantity (a density into a viscosity field) is refused with a reason rather than passed through, and a value whose unit cannot be established on either side is only accepted as an exact match.
- **Your own rows** live as JSON in the workspace — `.kratos/materials/*.json` by default, or wherever `kratos.materials.extraPaths` points. A file holds one preset or `{"version": 1, "presets": [ … ]}`. **import presets…** copies a file in; **save as preset** on a material row writes one out from the values on screen; and a row can be exported to share. A file that cannot be read is reported in the form rather than silently ignored, and a row with no `source` is rejected — a catalog entry that cannot cite anything is not an entry.

```json
{
  "version": 1,
  "presets": [
    {
      "id": "engine-oil-40c",
      "name": "Engine oil (40 °C)",
      "laws": ["newtonian_3d"],
      "values": { "DENSITY": 876, "KINEMATIC_VISCOSITY": 1e-4 },
      "units": { "DENSITY": "kg/m³", "KINEMATIC_VISCOSITY": "m²/s" },
      "reference": { "temperature": 40, "temperatureUnit": "C" },
      "source": { "name": "ISO 3448 VG 100", "version": "1992" }
    }
  ]
}
```

- **Each case keeps a snapshot.** Applying a preset copies the resolved values plus the source, version and reference conditions into `<mesh>.kratoscase.json`. Editing the material afterwards changes the case, never the snapshot; editing or deleting the library file never rewrites a case that already used it. When the library row has since changed, the material says which variables differ and offers an explicit **re-apply** — it never happens on its own. `Save problem…` and the MCP `problem_pack` carry the snapshot with the case, so a shared problem arrives with its provenance intact.
- **A material that cannot mean anything will not generate.** An undeclared law, a preset paired with a law it does not fit, and a non-positive density, viscosity or Young's modulus are reported in the row and refused by **Generate** (and by `case_validate` headlessly), instead of being written out for Kratos to fail on. A physically impossible Poisson ratio stays a warning.

6. Under **Output (VTK)**, choose the file format, output cadence and the nodal variables to write.
7. **Generate case files** — the generated `ProjectParameters.json` opens for inspection. Warnings (e.g. an assignment referencing a SubModelPart that no longer exists) surface as notifications.

## Element types and the case mesh

Kratos solvers expect specific element/condition block names in the mdpa, and your mesh may be named for different physics (or come from a generic mesher). Each problemtype declares what its solver needs, and **Generate checks the mesh**: when any block name differs, a renamed copy **`<name>_case.mdpa`** is written next to the original (which stays untouched) and `model_import_settings.input_filename` points at it. A notification lists the renames; `Properties` blocks are preserved verbatim.

- **Structural** has no solver-side element replacement, so concrete names are required: the **Element formulation** field picks `SmallDisplacementElement<d>D<n>N` or `TotalLagrangianElement<d>D<n>N`, and surface/line condition blocks become `SurfaceLoadCondition3D3N` / `LineLoadCondition2D2N`.
- **Fluid** (and its variants), **Convection-Diffusion**, **Potential Flow** and **Shallow Water** solvers replace elements internally, so their meshes get *generic* names (`Element3D4N`, `WallCondition3D3N`, `SurfaceCondition3D3N`, `LineCondition2D2N`).
- Point (single-node) condition blocks are never renamed — their names are load-specific (e.g. `PointLoadCondition3D1N`).

If the mesh already matches, no copy is made and the case points at the original mdpa. (That conditional applies to `.mdpa` sources only: any other format is always converted, so a `.vtu` or `.msh` source gets a `<name>_case.mdpa` even when no block needed renaming. A converted mesh carries no verbatim `Properties` — like every other foreign-format export — and a source with no SubModelParts produces a case with nothing to attach conditions or materials to, which Generate reports as a warning.)

## Run and watch results

**Run case** re-generates the files and opens a terminal named `Kratos: <case>` with the configured environment, running `python MainKratos.py` in the case directory. The solver's output streams in the terminal; `Ctrl+C` interrupts it.

**Open results** opens the first file in `vtk_output/` with the VTK preview. Because the preview watches its folder, the timeline grows automatically as the solver writes more steps — you can watch the solution evolve while it runs.

All three actions are also available from the Command Palette: **Kratos Case: Generate Case Files**, **Kratos Case: Run Case**, **Kratos Case: Open Results**.

## Notes

- Process `model_part_name`s are derived as `<RootModelPart>.<SubModelPart.Path.With.Dots>` — e.g. assigning to `Parts/Solid` in the Structural problemtype produces `Structure.Parts.Solid`.
- Materials use Kratos' `ReadMaterialsUtility`, which assigns properties per SubModelPart — the `properties_id`s in the materials file do **not** need to match the property ids inside the mdpa.
- Solver settings mirror what the [GiD interface](https://github.com/KratosMultiphysics/GiDInterface) writes for the same problems, so cases behave the same either way.
- Need physics the built-ins don't cover? [Author your own problemtype](./problemtype-authoring) in JavaScript or [Python](./problemtype-python). Faithful Python ports of all five built-ins ship as copyable examples in [`example/problemtypes/`](https://github.com/loumalouomega/VSCode-MDPA-Preview/tree/master/example/problemtypes).

## Time stepping guidance (fluid)

The Fluid problemtype's **Time stepping** choice is **Fixed step** (the default) or **Adaptive (CFL)**, which writes `automatic_time_step: true` with the target Courant number and the minimum and maximum step. The emitted keys match Kratos `FluidDynamicsApplication`'s `NavierStokesMonolithicSolver` defaults (`CFL_number`, `minimum_delta_time`, `maximum_delta_time`, `time_step`); a non-positive step, Courant number or bound, or a minimum above the maximum is refused by **Generate** and reported by `case_validate`, and a step outside the adaptive interval warns that Kratos starts at the minimum and clamps the CFL estimate into it. Under the form, a guidance line shows a convective estimate `dt ≈ safety × Courant × h / |U|` from the mesh and the **Reference velocity** field, with the length basis used, the flow-through time and, when an end time and time-based output interval are set, the step count, output-frame count and a rough storage range. When the smallest element is thin, its shortest edge is used and the line says so; a mesh with no measurable elements falls back to bounding-box volume (or diagonal) per node and says so, rather than inventing a cell size. The estimate is guidance only: your entered step is compared with it, never replaced, and it is not a stability guarantee for implicit or diffusive solvers. The reference velocity is used only for the estimate and is not written to ProjectParameters.json. Headlessly, use `case_estimate_timestep`.
