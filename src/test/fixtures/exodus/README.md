# Exodus II fixtures

## `seacas.exo`

Hand-authored, SEACAS/Cubit-shaped (see the docblock of `src/test/exodus.test.ts`
for its geometry and why it could not be produced by meshio++'s own writer). Two
HEX8 element blocks, two node sets, one side set, three time steps. Classic
netCDF-3. Covers issue #56.

## `DCBmodel_PD_solid.e`

The file from
[issue #63](https://github.com/loumalouomega/VSCode-MDPA-Preview/issues/63) —
a real PeriLab peridynamics run, not a synthetic fixture. A 2-D
double-cantilever-beam model discretized as **504 one-node `SPHERE` particles**
in four element blocks, with two node sets, nine nodal fields and ten time steps.

It failed to open with `Exodus: unknown element type SPHERE` on a type meshio++
had mapped to `vertex` all along. The cause was the *encoding*, not the type
table: [NetCDF.jl](https://github.com/JuliaGeo/NetCDF.jl), which PeriLab writes
Exodus with, counts the C string's terminating NUL in the `elem_type`
attribute's length, so the value arrives as the 7 characters `"SPHERE\0"` — and
`std::runtime_error::what()` is a `const char*`, so the NUL was invisible in the
error message too. Fixed upstream in meshio++ 9.3.0; nothing meshio++ can
generate itself reproduces the property, which is why the real file is here.

Note it carries **no radius**: no `attrib` variables, and none of its nine nodal
fields is a radius or a volume. That is what makes the constant-radius fallback
and the `setElementRadius` operation load-bearing rather than decorative — see
`src/parser/sphereElements.ts`.

| | |
|---|---|
| **Source** | [`PeriHub/PeriLab.jl`](https://github.com/PeriHub/PeriLab.jl), `test/fullscale_tests/test_DCB/Reference/DCBmodel_PD_solid.e` |
| **Retrieved** | 2026-07-27, from `main` (via the meshio++ repo, which vendored it first) |
| **SHA-256** | `c0be64f9949a918126b16934837e2ca0e0de2f62fc9ef7d920e5b2c8ae9703d3` |
| **Copyright** | 2023 Christian Willberg, Jan-Timo Hesse (DLR) |
| **Licence** | BSD-3-Clause — see `LICENSE.BSD-3-Clause` and the `.license` sidecar |
| **Modified** | No; committed byte-for-byte as retrieved |

BSD-3-Clause is permissive and imposes no licence change on this AGPL-3.0-or-later
repository, but its first condition requires the copyright notice, the conditions
and the disclaimer to travel with the file — hence `LICENSE.BSD-3-Clause` here
and the upstream [REUSE](https://reuse.software/) `.license` sidecar kept
verbatim beside the data. Do not move the file without them.

Fixtures live under `src/`, which `.vscodeignore` excludes, so none of this
ships in the `.vsix`.
