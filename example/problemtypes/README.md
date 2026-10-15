# Example problemtypes (Python)

Faithful Python ports of seven built-in problemtypes (Structural, Fluid, Convection-Diffusion, Potential Flow, Shallow Water, and the coupled Fluid-Structure Interaction and generic CoSimulation; the Compressible, Embedded, Free Surface, Buoyancy, Conjugate Heat Transfer, Optimization and ROM built-ins are TypeScript-only for now), kept as worked examples of the [Python authoring API](https://loumalouomega.github.io/VSCode-MDPA-Preview/guide/problemtype-python):

| File | Port of | Demonstrates |
|---|---|---|
| `structural.py` | Structural Mechanics | the `build_process` hook (per-component `constrained` broadcast), `process()` sugar, shared field lists |
| `fluid.py` | Fluid Dynamics (monolithic) | deriving `volume_model_part_name` / `skin_parts` from the assignments in `solver_settings`, raw process templates |
| `convection_diffusion.py` | Convection-Diffusion | law-less materials (empty constitutive-law name), scalar conditions |
| `potential_flow.py` | Potential Flow | a problemtype with **no material laws** (free-stream state on the far-field process) |
| `shallow_water.py` | Shallow Water | **custom process lists** (topography / initial_conditions / boundary_conditions), 2D-only `domain_sizes`, `mesh_naming` |
| `coupled.py` | Fluid-Structure Interaction and generic CoSimulation (two problemtypes in one file) | coupled **`domains`** (one mesh slice and materials file per physics), **`coupling_interfaces`**, hooks that call one physics' hooks with the unprefixed values of its fields, `no_process` interface conditions, `extra_files` returning documents as JSON values (the CoSimulation participant documents), `primary_document_name` / `driver_script_name`, and **`driver_template`** (the shipped FSI or CoSimulation driver, which records coupling iterations) |

The declaration half of each port is generated from the TypeScript original with `node scripts/problemtype-to-python.mjs <id>` (after `npm run build:tests`), so the two cannot drift; the hooks are hand-ported. A parity test (`src/test/problemtypeExamples.test.ts`) asserts each port generates **byte-identical** case files to its TypeScript original, extra files included. Each file is executed on its own, so `coupled.py` carries copies of the Fluid and Structural hooks rather than importing `fluid.py` and `structural.py`; the parity test is what keeps those copies honest.

## Using them

Either copy the files into your workspace:

```bash
mkdir -p .kratos/problemtypes
cp example/problemtypes/*.py .kratos/problemtypes/
```

or point the extension at this directory via the setting:

```json
"kratos.problemtypes.extraPaths": [".kratos/problemtypes", "example/problemtypes"]
```

They then appear in the mdpa preview's **Problemtype** dropdown as "… (Python example)" entries. The ids carry a `_py` suffix so they can coexist with the built-ins.
