# Transient reader audit

Measured on 2026-09-17 against the installed `@meshioplusplus/wasm` **12.0.0**, not inferred from its declarations. `src/test/transientAudit.test.ts` runs the probes in CI. The local upstream source used to classify readers was the 12.0.0 checkout at `/home/vicente/src/meshioplusplus`. Source inspection identifies candidates; the installed WASM determines results.

**Re-measured on 2026-09-22 against 15.4.0** (roadmap item 3's Tier 0 bump). Five new reader keys joined the routing tables in this bump (`frd`, `lsdyna`, `pcd`, `vtkhdf`, `xyz`); their audit results are below. `frd` is options-aware but not admitted: it fails the `fellBackToFullRead: false` bar despite genuine step selection (see its own row). **`vtkhdf` IS admitted**, closing what was first reported as "unmeasured — no JS-reachable stepped writer exists": that claim was wrong. `sequenceToTimeseries(sources, out, "vtkhdf", {times})` (the wasm's own fan-in operation, not the C++-only `VtkhdfTimeSeriesWriter`) writes a genuine multi-step file directly, streaming, with no h5py surgery — see `generate-vtkhdf.mjs`. `lsdyna`/`pcd`/`xyz` report no options awareness at all and are not candidates.

Admission requires multiple correct `timeValues`, `fellBackToFullRead: false`, and different expected data from step selection. **MED, CGNS and Tecplot qualify since the 11.3.0 Tier B1 native metadata readers** and drive in-file timelines. Existing Exodus/GiD/XDMF/OpenFOAM timelines retain their current counting mechanisms and regression tests.

## Temporal probes

Every input below contains two samples, at times/indices 0 and 1 (`two-step.frd` is the one exception — see its own row). Scalar samples are `[10,20,30]` and `[40,50,60]`; EnSight changes the triangle's x extent from 1 to 2. All fixtures are synthetic and covered by this repository's license, except `two-step.frd`, copied verbatim from meshio++'s own `tests/python/meshes/frd/freq.frd` (same author, same MIT license, generated for meshio++'s `.frd` reader work). None were downloaded from third-party solver datasets.

| Reader / fixture | `timeValues` | `fellBackToFullRead` | Selecting 0 versus 1 |
| --- | --- | --- | --- |
| MED / `two-step.med` | `[0, 1]` (CHA/PDT union, native scan) | `false` | Distinct samples; step 0 needs the application's lenient retry (strict step-0 select throws upstream) |
| CGNS / `two-step.cgns` | `[0, 1]` (Base/ZoneIterativeData TimeValues) | `false` | Distinct samples via solution pointers |
| Tecplot / `two-step.tec` | `[0, 1]` (ZONE SOLUTIONTIME/STRANDID scan) | `false` | Distinct samples, one zone per step |
| Gmsh 2.2 / `two-step.msh` | `[]` (sections carry no time tags) | `true` | Distinct samples via a header pre-scan on non-default steps |
| EnSight / `two-step.case` and both `.geo` companions | No result: transient wildcard geometry is explicitly rejected | No result | Both fail; each companion geometry reads successfully on its own |
| H5M / `two-step.h5m` | `[]` | `true` | Both return both time-indexed tags as separate fields |
| CalculiX FRD / `two-step.frd` (three steps, not two — a real eigenmode result) | `[223657.77, 223657.77, 412641.97]` (two coincide — degenerate modes) | `true` | Distinct `DISP` samples at every step despite the coinciding declared times |
| VTKHDF / `two-step.vtkhdf` | `[0, 1]` (Steps group, native scan) | `false` | Distinct samples |

The Gmsh result applies to this 2.2 temporal fixture, not to all `.msh` metadata reads: the existing ordinary Gmsh header probe remains cheap. A static MED file reports its single step `[0]`. Options awareness alone does not mean time selection works (Gmsh metadata stays empty while its selection works — the counterexample in the other direction; FRD is now a second one, selection working while metadata still falls back to a full read).

## Fixture structure and reproduction

Run `npm run build:tests`, then run `generate.py` with Python, h5py and NumPy. These packages are needed only to regenerate the committed binary fixtures, not to run the Node/WASM tests. The script writes base geometry with the installed WASM and adds temporal structure through HDF5; independent h5py assertions check both samples and their references.

- **MED:** two `CHA/TEMP` computation-step groups, with `NDT=1/2`, `NOR=-1`, `PDT=0/1` and distinct nodal `CO` arrays. This follows the upstream MED writer's field layout and its multi-timestep tests. Both selected reads are asserted through WASM and the application reader.
- **CGNS:** two `FlowSolution_t` nodes referenced by `ZoneIterativeData_t` / `FlowSolutionPointers`, with `BaseIterativeData_t` / `TimeValues` and `SimulationType=TimeAccurate`. Pointer dimensions use the HDF5 mapping's reversed order. This follows [CGNS SIDS time-dependent flow](https://cgns.org/standard/SIDS/time.html).
- **Tecplot:** two complete finite-element zones with the same `STRANDID=1` and different `SOLUTIONTIME` values, following [Tecplot's transient-data model](https://tecplot.com/2018/03/26/unsteady-data-tecplot-files/).
- **Gmsh:** two complete `$NodeData` sections with the same field name and distinct real time / integer step tags; geometry is a three-node triangle.
- **EnSight:** a complete `TIME` section selects two numbered ASCII Gold geometry files through `two-step.****.geo`. The test stages both companions directly in WASM, bypassing the application's static companion-name helper, so the negative result cannot be caused by incomplete staging.
- **H5M:** two dense tags `TEMP_T0` and `TEMP_T1`, each with its own committed type and three values. This represents [MOAB's time-indexed tag convention](https://ftp.mcs.anl.gov/pub/fathom/moab-docs/VisTags_8cpp-example.html) using the [H5M tag storage layout](https://sigma.mcs.anl.gov/moab/h5m-file-format/). It is not a portable time axis: guessing one from arbitrary tag names would be a new interpretation policy, not enabling a step-capable reader.
- **FRD:** a real CalculiX eigenvalue-analysis result (`freq.frd`, copied from meshio++'s own reader test suite rather than authored here), three `PSTEP` result blocks with a nodal `DISP` vector each. Not regenerated by `generate.py` — it is a real solver output, not synthetic HDF5.
- **VTKHDF:** the one fixture NOT built through `generate.py`'s h5py-surgery approach — `generate-vtkhdf.mjs` (run directly with `node`, no Python) writes two ordinary `.vtu` steps with the installed WASM, then calls `sequenceToTimeseries` to fan them into one genuine multi-step `.vtkhdf`, verifying the shape it commits before writing the file.

## Full reader-key inventory

The test pins the complete set of `MESHIO_READ_CANDIDATES` keys and probes `readerSupportsOptions` for each distinct reader. New keys or newly options-aware readers fail the audit test and require review. Options awareness alone does not mean time selection works (Gmsh is the counterexample; FRD is a second one).

| Classification | Reader keys | Decision |
| --- | --- | --- |
| Existing timelines | `exodus`, `gid`, `xdmf`, `openfoam` | Retain existing tests and native counting mechanisms |
| New in-file timelines (11.3.0) | `med`, `cgns`, `tecplot` | Native metadata enumeration + distinct selection; filename series still supported |
| Temporal probes without eligibility | `gmsh`, `ensight`, `h5m`, `frd` | Gmsh selects but cannot enumerate untagged sections; EnSight rejects transient geometry; H5M tags are not a time axis; FRD selects distinctly but its metadata falls back to a full read; filename series supported |
| New in-file timeline (14.0.0) | `vtkhdf` | Native Steps-group metadata enumeration + distinct selection, same admission bar as MED/CGNS/Tecplot; `.hdf` shares the key |
| Single-grid HMF schema | `hmf` | `domain/grid` contains geometry, topology and attributes, with no temporal index; not a multi-step candidate |
| Mesh readers without an options-aware step-selection entry point | `abaqus`, `ansys`, `ansysinp`, `avsucd`, `dex`, `dolfin`, `flac3d`, `flux`, `freefem`, `ip`, `lsdyna`, `medit`, `mff`, `mfm`, `mphtxt`, `nastran`, `netgen`, `off`, `pcd`, `permas`, `su2`, `tetgen`, `triangle`, `ugrid`, `unv`, `wkt`, `xyz` | Filename series supported (`pcd`/`xyz` have no cells, so nothing groups as a series either); their registered mesh readers cannot select an internal step |

The last row describes the installed readers, not every possible result-file variant of each standard. HMF's static metadata control reports `[]` and `fellBackToFullRead: true`; it is explicitly not presented as a negative multi-step probe. Inventing extra HDF5 grids would not produce a valid HMF series. Dependency upgrades and native temporal readers are outside this audit.
