# Running Kratos Simulations

The **Problemtype** sidebar section turns an `.mdpa` preview into a case
builder: pick a physics problemtype, fill in the solver settings, assign
boundary conditions and materials to SubModelParts, and the extension
generates everything a [Kratos Multiphysics](https://github.com/KratosMultiphysics/Kratos)
run needs — then launches it in an integrated terminal.

![The Problemtype section: the Structural problemtype selected, the Problem data form, condition assignments (Body/Parts, a fixed Displacement, Self weight, a Surface pressure) and a LinearElastic3DLaw material bound to SubModelParts of the previewed mesh, with the Generate / Run / Open results actions below](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/problemtype.png)

## What gets generated

Clicking **Generate case files** writes three files next to the `.mdpa`:

| File | Contents |
|---|---|
| `ProjectParameters.json` | The full Kratos parameters document: `analysis_stage`, `problem_data`, `solver_settings` (pointing at your mdpa), `processes` (your condition assignments) and `output_processes` |
| `<Problemtype>Materials.json` | One `properties` entry per material assignment (`model_part_name`, constitutive law, variables) |
| `MainKratos.py` | The generic launcher: reads the JSON, imports the `analysis_stage` module and runs the simulation |

Output is always configured through Kratos'
[`vtk_output_process`](https://github.com/KratosMultiphysics/Kratos/blob/master/kratos/python_scripts/vtk_output_process.py),
so results land in a `vtk_output/` folder that this extension can preview
directly — including [time-series playback](./timeline) that extends live
while the solver is still writing steps.

Your form choices are auto-saved to `<name>.kratoscase.json` next to the mdpa
and restored the next time you open the preview. The file is plain JSON —
commit it to version control to share the case setup.

## Configure the Kratos location

Open **Settings → Extensions → Kratos MDPA Preview** (or search `kratos.` in
settings):

| Setting | Meaning |
|---|---|
| `kratos.pythonPath` | Python executable used to run cases. Empty = `python3` (`python` on Windows) |
| `kratos.installPath` | Root of a **compiled** Kratos build (the folder containing `KratosMultiphysics/` and `libs/`, or a source checkout — see below). Leave empty for a pip-installed Kratos |
| `kratos.extraEnv` | Extra environment variables for the run terminal, e.g. `{"OMP_NUM_THREADS": "4"}` |
| `kratos.problemtypes.extraPaths` | Directories scanned for [user problemtypes](./problemtype-authoring) (default `.kratos/problemtypes`) |

Two common setups:

- **pip-installed Kratos** (recommended): `pip install KratosMultiphysics-all`
  into any Python, point `kratos.pythonPath` at that interpreter, leave
  `kratos.installPath` empty.
- **Custom-compiled Kratos**: run **Kratos Case: Select Kratos Installation
  Folder…** from the Command Palette and pick either the install root (the
  directory holding `KratosMultiphysics/` and `libs/`) or your Kratos **source
  checkout** — an in-tree build under `bin/Release` (or
  `RelWithDebInfo`/`Debug`/`FullDebug`) is detected automatically. The command
  validates the layout and writes `kratos.installPath` (workspace settings
  when a workspace is open). The run terminal then gets `PYTHONPATH` plus the
  platform's shared-library path (`LD_LIBRARY_PATH` on Linux,
  `DYLD_LIBRARY_PATH` on macOS, `PATH` on Windows). Note macOS System
  Integrity Protection strips `DYLD_*` variables for protected binaries — a
  pip install avoids the issue entirely.

## Build a case

1. Open the `.mdpa` in the MDPA preview and expand the **Problemtype** section.
2. Pick a problemtype. Built-ins: **Structural Mechanics**, **Fluid Dynamics**
   (monolithic Navier-Stokes) and **Convection-Diffusion** (thermal).
3. Fill the **Problem data** form (analysis type, time step, end time…).
4. Under **Conditions**, pick a condition and a SubModelPart and press **+**:
   - Assign the **Body / Parts** pseudo-condition to your domain
     SubModelPart(s) — it marks the computing domain and emits no process.
   - Assign boundary conditions (displacement, inlet, temperature…) and loads
     to boundary SubModelParts. Each assignment shows its parameter fields
     inline; **×** removes it.
5. Under **Materials**, assign a constitutive law to each Parts SubModelPart
   and adjust its variables.
6. Under **Output (VTK)**, choose the file format, output cadence and the
   nodal variables to write.
7. **Generate case files** — the generated `ProjectParameters.json` opens for
   inspection. Warnings (e.g. an assignment referencing a SubModelPart that no
   longer exists) surface as notifications.

## Run and watch results

**Run case** re-generates the files and opens a terminal named
`Kratos: <case>` with the configured environment, running
`python MainKratos.py` in the case directory. The solver's output streams in
the terminal; `Ctrl+C` interrupts it.

**Open results** opens the first file in `vtk_output/` with the VTK preview.
Because the preview watches its folder, the timeline grows automatically as
the solver writes more steps — you can watch the solution evolve while it
runs.

All three actions are also available from the Command Palette: **Kratos Case:
Generate Case Files**, **Kratos Case: Run Case**, **Kratos Case: Open
Results**.

## Notes

- Process `model_part_name`s are derived as
  `<RootModelPart>.<SubModelPart.Path.With.Dots>` — e.g. assigning to
  `Parts/Solid` in the Structural problemtype produces
  `Structure.Parts.Solid`.
- Materials use Kratos' `ReadMaterialsUtility`, which assigns properties per
  SubModelPart — the `properties_id`s in the materials file do **not** need to
  match the property ids inside the mdpa.
- Solver settings mirror what the [GiD interface](https://github.com/KratosMultiphysics/GiDInterface)
  writes for the same problems, so cases behave the same either way.
- Need physics the built-ins don't cover? [Author your own problemtype](./problemtype-authoring)
  in JavaScript or [Python](./problemtype-python). Faithful Python ports of all
  three built-ins ship as copyable examples in
  [`example/problemtypes/`](https://github.com/loumalouomega/VSCode-MDPA-Preview/tree/master/example/problemtypes).
