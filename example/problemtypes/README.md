# Example problemtypes (Python)

Faithful Python ports of the extension's five original built-in problemtypes (Structural, Fluid, Convection-Diffusion, Potential Flow, Shallow Water; the Compressible, Embedded, Free Surface and coupled built-ins are TypeScript-only for now), kept as worked examples of the [Python authoring API](https://loumalouomega.github.io/VSCode-MDPA-Preview/guide/problemtype-python):

| File | Port of | Demonstrates |
|---|---|---|
| `structural.py` | Structural Mechanics | the `build_process` hook (per-component `constrained` broadcast), `process()` sugar, shared field lists |
| `fluid.py` | Fluid Dynamics (monolithic) | deriving `volume_model_part_name` / `skin_parts` from the assignments in `solver_settings`, raw process templates |
| `convection_diffusion.py` | Convection-Diffusion | law-less materials (empty constitutive-law name), scalar conditions |
| `potential_flow.py` | Potential Flow | a problemtype with **no material laws** (free-stream state on the far-field process) |
| `shallow_water.py` | Shallow Water | **custom process lists** (topography / initial_conditions / boundary_conditions), 2D-only `domain_sizes`, `mesh_naming` |

The declaration half of each port is generated from the TypeScript original with `node scripts/problemtype-to-python.mjs <id>` (after `npm run build:tests`), so the two cannot drift; the hooks are hand-ported. A parity test (`src/test/problemtypeExamples.test.ts`) asserts each port generates **byte-identical** case files to its TypeScript original.

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
