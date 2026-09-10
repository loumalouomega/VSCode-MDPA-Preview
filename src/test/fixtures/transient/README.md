# Transient reader audit

Measured on 2026-09-10 against the installed `@meshioplusplus/wasm` **10.20.2**,
not inferred from its declarations. `src/test/transientAudit.test.ts` runs the
probes in CI. The local upstream source used to classify readers was commit
`571d61426cdb7eeb98cb7d410fc1158456681626` of
[meshio++](https://github.com/loumalouomega/meshioplusplus).
Source inspection identifies candidates; the installed WASM determines results.

Admission requires multiple correct `timeValues`, `fellBackToFullRead: false`,
and different expected data from step selection. **No additional format
qualifies.** Existing Exodus/GiD/XDMF/OpenFOAM timelines retain their current
counting mechanisms and regression tests.

## Temporal probes

Every input below contains two samples, at times/indices 0 and 1. Scalar
samples are `[10,20,30]` and `[40,50,60]`; EnSight changes the triangle's x extent
from 1 to 2. All fixtures are synthetic, authored for this repository and
covered by its license. None were downloaded from solver datasets.

| Reader / fixture | `timeValues` | `fellBackToFullRead` | Selecting 0 versus 1 |
| --- | --- | --- | --- |
| MED / `two-step.med` | No result: metadata throws on the two-step field | No result; failure occurs in the full-reader fallback | Correct distinct samples with the application's lenient retry |
| CGNS / `two-step.cgns` | `[]` | `true` | Both return `[40,50,60]`; solution pointers are not used for selection |
| Tecplot / `two-step.tec` | `[]` | `true` | Both return `[10,20,30]`, the first zone |
| Gmsh 2.2 / `two-step.msh` | `[]` | `true` | Both return `[10,20,30]`, the first NodeData sample |
| EnSight / `two-step.case` and both `.geo` companions | No result: transient wildcard geometry is explicitly rejected | No result | Both fail; each companion geometry reads successfully on its own |
| H5M / `two-step.h5m` | `[]` | `true` | Both return both time-indexed tags as separate fields |

The Gmsh result applies to this 2.2 temporal fixture, not to all `.msh`
metadata reads: the existing ordinary Gmsh header probe remains cheap.
A static MED file reports `[]`, whereas this genuine temporal file throws;
the static negative test alone did not establish the temporal behavior.

## Fixture structure and reproduction

Run `npm run build:tests`, then run `generate.py` with Python, h5py and NumPy.
These packages are needed only to regenerate the committed binary fixtures,
not to run the Node/WASM tests. The script writes base geometry with the
installed WASM and adds temporal structure through HDF5; independent h5py
assertions check both samples and their references.

- **MED:** two `CHA/TEMP` computation-step groups, with `NDT=1/2`, `NOR=-1`,
  `PDT=0/1` and distinct nodal `CO` arrays. This follows the upstream MED
  writer's field layout and its multi-timestep tests. Both selected reads
  are asserted through WASM and the application reader.
- **CGNS:** two `FlowSolution_t` nodes referenced by `ZoneIterativeData_t` /
  `FlowSolutionPointers`, with `BaseIterativeData_t` / `TimeValues` and
  `SimulationType=TimeAccurate`. Pointer dimensions use the HDF5 mapping's
  reversed order. This follows [CGNS SIDS time-dependent flow](https://cgns.org/standard/SIDS/time.html).
- **Tecplot:** two complete finite-element zones with the same `STRANDID=1`
  and different `SOLUTIONTIME` values, following [Tecplot's transient-data
  model](https://tecplot.com/2018/03/26/unsteady-data-tecplot-files/).
- **Gmsh:** two complete `$NodeData` sections with the same field name and
  distinct real time / integer step tags; geometry is a three-node triangle.
- **EnSight:** a complete `TIME` section selects two numbered ASCII Gold
  geometry files through `two-step.****.geo`. The test stages both companions
  directly in WASM, bypassing the application's static companion-name helper,
  so the negative result cannot be caused by incomplete staging.
- **H5M:** two dense tags `TEMP_T0` and `TEMP_T1`, each with its own committed
  type and three values. This represents [MOAB's time-indexed tag convention](https://ftp.mcs.anl.gov/pub/fathom/moab-docs/VisTags_8cpp-example.html)
  using the [H5M tag storage layout](https://sigma.mcs.anl.gov/moab/h5m-file-format/).
  It is not a portable time axis: guessing one from arbitrary tag names would
  be a new interpretation policy, not enabling a step-capable reader.

## Full reader-key inventory

The test pins the complete set of `MESHIO_READ_CANDIDATES` keys and probes
`readerSupportsOptions` for each distinct reader. New keys or newly options-aware
readers fail the audit test and require review. Options awareness alone does
not mean time selection works (Gmsh is the counterexample).

| Classification | Reader keys | Decision |
| --- | --- | --- |
| Existing timelines | `exodus`, `gid`, `xdmf`, `openfoam` | Retain existing tests and native counting mechanisms |
| Temporal probes above | `med`, `cgns`, `gmsh`, `tecplot`, `ensight`, `h5m` | No new in-file eligibility; filename series supported |
| Single-grid HMF schema | `hmf` | `domain/grid` contains geometry, topology and attributes, with no temporal index; not a multi-step candidate |
| Mesh readers without an options-aware step-selection entry point | `abaqus`, `ansys`, `ansysinp`, `avsucd`, `dex`, `dolfin`, `flac3d`, `flux`, `freefem`, `ip`, `medit`, `mff`, `mfm`, `mphtxt`, `nastran`, `netgen`, `off`, `permas`, `su2`, `tetgen`, `triangle`, `ugrid`, `unv`, `wkt` | Filename series supported; their registered mesh readers cannot select an internal step |

The last row describes the installed readers, not every possible result-file
variant of each standard. HMF's static metadata control reports `[]` and
`fellBackToFullRead: true`; it is explicitly not presented as a negative
multi-step probe. Inventing extra HDF5 grids would not produce a valid HMF
series. Dependency upgrades and native temporal readers are outside this audit.
