# Roadmap

Pending work for Kratos MDPA Preview, prioritizing full meshio++ integration, a clearer UI shared with CAD-Preview, and practical mesh preparation and results-analysis workflows. Existing foundations include MMG remeshing, meshio++ WASM, replayable edit histories, Python problemtypes, field visualization, time-series playback, tracked Kratos runs, and a headless MCP server.

**meshio++ has resolved its WASM-module issues and is adopted at its full, latest version.** Historical binding failures, missing side channels, format defects, and build omissions are no longer exclusions from this roadmap — `@meshioplusplus/wasm` is pinned at `^12.0.0`, the version upstream's own changelog records as closing WASM parity in full, and the extension's packaged runtime already declares and uses it. What remains is connecting its capabilities to the extension end to end, preserving Kratos semantics, and verifying the resulting workflows — the items below, not the dependency adoption itself. Keeping that pin current as upstream releases is its own standing item, Tier 0.

This page is aspirational, not a release commitment. All numbered items are **pending**. Effort is approximate: **S** = a day or two, **M** = roughly a week, **L** = multi-week. Completed features belong in `CHANGELOG.md` and implementation details in `CLAUDE.md`; remove completed items here. No tracker issues have been assigned to the items below yet.

## Research baseline

Reviewed `/home/vicente/src/meshioplusplus` on **2026-09-17**, including its 12.0.0 changelog, `bindings/wasm/js_bindings.cpp`, and capability documentation. The extension declares `@meshioplusplus/wasm: ^12.0.0` since the 12.0.0 adoption (integer-dtype boundary, Tier B1 in-file timelines for MED/CGNS/Tecplot, OpenFOAM zones/time fields, Gmsh group export, `.vts`/`.vtr`/`.vtm` keys known-but-unrouted, `mesh_capabilities` headless inventory).

| Evidence in the local checkout | Roadmap opportunity |
|---|---|
| [WASM bindings](https://github.com/loumalouomega/meshioplusplus/blob/master/bindings/wasm/js_bindings.cpp) and [JavaScript API](https://github.com/loumalouomega/meshioplusplus/blob/master/doc/wasm.md) expose `repair`, `computeCurvature`, `shrinkwrap`, `sobolevDeform`, `remesh`, `remeshVolume`, `optimizeVolume`, `grid`, `voxelize`, and `computeSdf` | Add preparation, analysis, and mesh-generation workflows beyond the operations already integrated. |
| The same binding exposes `diff`, `meshesEqual`, `interpolate`, `slice`, `isosurface`, `split`, `partition`, field-management operations, and provenance functions | Mesh comparison, sampled results, reusable derived meshes, partition exports, and traceable conversions. |
| [WASM pipeline documentation](https://github.com/loumalouomega/meshioplusplus/blob/master/doc/wasm.md) describes `runPipeline` and `convertSurfaceOps`, which keep intermediate meshes inside C++ | Reduce repeated whole-mesh transfers and enable bounded batch processing. |
| [Partition documentation](https://github.com/loumalouomega/meshioplusplus/blob/master/doc/partition.md) covers weights, recorded source indices, and ghost layers; bindings expose `ghostLayers` | Extend the existing partition-label operation into actual domain exports. |
| [Changelog](https://github.com/loumalouomega/meshioplusplus/blob/master/CHANGELOG.md) records FLAC3D group fixes in 10.36.0, curvature in 10.37.0, and repair/shrinkwrap/Sobolev deformation in 10.38.0 | Refresh format fidelity and integrate concrete new operations rather than treating every unused export as a feature request. |
| The changelog explicitly identifies curved tessellation (10.39.0), point budgets, proximity graphs, PhysicsNeMo workflows, and PMSH/Zarr/CAE/USD format additions as Python-only work | Track these separately as optional companion or future-binding work; resolving WASM defects does not automatically port Python code. |

The historical audits in `src/test/fixtures/transient/README.md` and `CLAUDE.md` remain evidence about the versions tested. During integration, replace obsolete expectations with positive capability tests and retain relevant regression fixtures. Source inspection supports this roadmap; no new live-WASM audit was performed for this documentation change. A VTK-wasm rendering-runtime evaluation (standalone-session boot, bulk data transfer, a minimal end-to-end render, all under the shipped webview CSP) was run and closed on **2026-09-18** with a drop verdict — see [`doc/vtk-wasm-spike.md`](./vtk-wasm-spike.md) for the full findings, measurements, and reproduction steps; vtk.js remains the renderer.

## Magnusim review — 2026-09-21

Implementation review at `af8d059`: read the result exporters, transient-control calculation, function-object writer, pressure conversions and material library, plus `test_transient.py`, `test_result_filter_registry.py` and the relevant local integration paths. This is source/test inspection, not a run of Magnusim or OpenFOAM.

| Source evidence | Concrete local gap / decision |
| --- | --- |
| [`estimate_delta_t` / `resolve_transient_control`](https://github.com/Lilmill2000/Magnusim/blob/af8d05945d3b65cd9daf220554cb08ab0392da2d/magnusim-web/python/cfddesk/project/transient.py) and [transient tests](https://github.com/Lilmill2000/Magnusim/blob/af8d05945d3b65cd9daf220554cb08ab0392da2d/magnusim-web/python/tests/unit/test_transient.py) | Our fluid problemtype writes a fixed time step; add transparent time-step and output-budget guidance. |
| [surface averages and summed `phi` monitors](https://github.com/Lilmill2000/Magnusim/blob/af8d05945d3b65cd9daf220554cb08ab0392da2d/magnusim-web/python/cfddesk/case/function_objects.py) | Existing field integrals are measure-weighted totals, not signed boundary flux or a conservation report. |
| [pressure conversion](https://github.com/Lilmill2000/Magnusim/blob/af8d05945d3b65cd9daf220554cb08ab0392da2d/magnusim-web/python/cfddesk/units/pressure.py) | The native OpenFOAM parsed-field interface does not retain `dimensions`; raw `p` cannot safely be labelled Pa. |
| [material library](https://github.com/Lilmill2000/Magnusim/blob/af8d05945d3b65cd9daf220554cb08ab0392da2d/magnusim-web/python/cfddesk/materials/library.py) | Problemtypes define constitutive laws and numeric defaults but lack a reusable physical-material catalog with provenance and unit conversion. |
| [volume threshold exporter](https://github.com/Lilmill2000/Magnusim/blob/af8d05945d3b65cd9daf220554cb08ab0392da2d/magnusim-web/python/tools/export_iso_volume.py) | `thresholdCells.ts` already provides a view-only threshold. Extend it to quantitative extraction/export; do not add a duplicate filter. |
| [streamline exporter](https://github.com/Lilmill2000/Magnusim/blob/af8d05945d3b65cd9daf220554cb08ab0392da2d/magnusim-web/python/tools/export_particle_trace.py) | Add seeded trajectories from actual volume velocity; its PyVista implementation is not available automatically in vtk.js. |

## Delivery rules

- **Keep the kernel current first.** Tier 0 precedes everything else: each tier's scope is measured against a specific meshio++ release, so a stale pin makes later estimates and acceptance checks describe the wrong artifact.
- **Prioritize integration and usability before breadth.** Tier 1 establishes a reliable shared foundation; later tiers add workflows on top. Independent UI work can proceed alongside kernel integration.
- **Full integration means access to the useful kernel surface through a consistent adapter.** It does not require deleting working native implementations or exposing duplicate buttons for equivalent algorithms. Choose a backend per operation on fidelity, performance, and maintenance cost.
- **Preserve the extension's data contract.** Original node and entity IDs, independent Elements/Conditions/Geometries ID spaces, Properties, constraints, SubModelParts, field components, and source-cell correspondence must survive wherever the operation permits. For topology-changing operations, define generated IDs, field transfer, and metadata handling explicitly.
- **MCP parity ships with every headless capability.** Update `src/mcp/tools.ts`, `src/mcp/register.ts`, `src/test/mcpTools.test.ts`, and the tool documentation in the same implementation change. UI-only work is exempt; a UI wrapper around a new analysis or edit is not.
- **Acceptance checks are part of each estimate.** Use real format fixtures, numerical invariants, cancellation and undo/redo tests, and packaged-extension checks where appropriate. Retest the target package as normal integration work rather than leaving features indefinitely labelled “needs live-WASM verification.”

## Tier 0 — Keep meshio++ up to date

Admission criterion: upkeep that every other tier depends on, because each tier below is scoped against a specific meshio++ release. Unlike the numbered items further down, this tier is **standing work**: it is never removed when a bump lands, only its status line is refreshed.

### 0. Track upstream meshio++ releases — S per release, recurring

**Pending — currently one major behind.** As of **2026-09-20** the extension declares `@meshioplusplus/wasm: ^12.0.0` and has 12.0.0 installed, while npm publishes **13.0.0** (upstream changelog, 2026-09-19) and the upstream checkout is at **14.0.0** (2026-09-20, not yet on npm when this was written). A caret range never crosses a major version, so neither Dependabot's minor/patch group nor `npm update` will ever propose the jump; it has to be a deliberate change.

For each release, read the upstream changelog entry and classify what it touches for the WASM build before bumping:

- **Formats:** a new or changed reader/writer key (14.0.0 adds `vtkhdf`, with partition selection and transient `Steps`). Decide explicitly whether to route it, and extend `MESHIO_READER_KEYS`/`MESHIO_WRITER_KEYS`, `MESHIO_READ_CANDIDATES`, `EXPORT_MENU_GROUPS`, `SUPPORTED_MESH_EXTENSIONS` and the timeline lists. A key that the live artifact reports but nothing routes is listed as deliberately absent with a reason, never left unexamined.
- **Boundary and ABI:** option structs or dtypes crossing the wasm boundary (14.0.0 grows `ReadOptions` with `piece`, 13 → 14). Re-check `readMeshSelective`/`readMetadata` options handling, integer array types (`BigInt64Array`), and the `*_components` maps.
- **Behavior changes that alter what the extension already relies on:** 13.0.0 changes fallback semantics in the Python shims and pins C++ streams to the classic locale; whether any of that reaches the WASM build is to be measured, not assumed.
- **Fixes that retire a workaround:** upstream fixes (for example 12.1.0's MED and Gmsh higher-order node-ordering permutations, VTU polyhedron mixed-node-count `cell_data`) may make a local compensation redundant or wrong. Remove the workaround and its stale note in the same change.

Then, per bump: update `package.json`/`package-lock.json`, confirm both `dist/meshio/` variants (sequential and `_mt`) still load and that `locateFile` stays name-aware, re-run the transient audit and the per-format options-awareness pins so a changed capability fails a test rather than a user, refresh `mesh_capabilities` expectations, and record the `.vsix` size change. Update the "Research baseline" date and the pinned version in the introduction, and add a `CHANGELOG.md` entry naming the version and the notable capability changes.

Automate the detection so it does not depend on remembering: a scheduled CI job that compares the declared range with `npm view @meshioplusplus/wasm version` and reports when the latest release is outside it, since that is the one case Dependabot's grouping misses.

**Acceptance:** the pinned version equals the latest published release (or a documented reason for staying behind is recorded here), the full test suite passes against it, every reader/writer key the live artifact reports is either routed or listed as deliberately absent, and no roadmap item cites a superseded version as its baseline. **MCP:** no new tool by itself; any newly routed format or operation must appear through `mesh_capabilities` and the existing info/convert tools in the same change.

## Tier 1 — Full integration and a unified user experience

Admission criterion: work that enables multiple subsequent features or improves the everyday workflow across the extension.

### 1. Improve the UI and unify it with CAD-Preview — L

**Pending — explicit cross-extension priority.** Audit both extensions against the existing [shared UI design system](./ui-design-system.md) and converge on a common interaction vocabulary and component set. Align File/View/Advanced menus, toolbar hierarchy, navigation controls, orientation cube, layer-tree actions, selection feedback, form layouts, icons, spacing, typography, progress/cancel states, and empty/error states. Update the design-system document's stale “pending” descriptions against what actually ships before using it as the implementation checklist.

Reduce the density of mesh-operation forms with searchable actions, clear categories, progressive disclosure of advanced settings, and consistent inline validation. Establish predictable panel docking and overflow at narrow widths. Include keyboard navigation, visible focus, accessible names, high-contrast themes, and reduced-motion behavior. Share tokens and reusable components through a versioned source or synchronized copies with a drift check; keep Kratos-specific problem setup distinct within the common shell.

**Acceptance:** compare the same open → inspect → clip → edit → export workflow in both extensions, with visual and interaction checks in dark, light, and high-contrast themes and at small viewport sizes. **MCP:** UI-only exemption; any new underlying operation discovered during this work still needs parity.

### 2. Run expensive meshio++ work in cancellable workers — L

**Pending.** Extend the existing MMG worker pattern to costly meshio++ reads, analyses, and operations. Report stages, support cancellation, release WASM heaps after work, and prevent stale results from replacing a newer frame or document state. Use transferable buffers where ownership permits and benchmark end-to-end memory, including filesystem staging and webview delivery.

Evaluate `runPipeline` for compatible batches to avoid repeated JS/WASM copies. Preserve the operation queue's per-step history and partial-completion semantics; a faster backend must still return enough results or checkpoints to honor undo and cancellation.

**Acceptance:** large reads and edits leave the extension host responsive, cancellation releases resources, and batching agrees with sequential execution. **MCP:** use the shared execution layer where applicable and expose progress/cancellation through the MCP request lifecycle without writing logs to the stdio transport.

### 3. Complete format, metadata, and transient integration — L

**Pending.** Reopen the formerly blocked format work against the corrected runtime: additional in-file timelines, richer selective reads and metadata, Gmsh physical-group export, MED diagnostics, and OpenFOAM zones, patch types, fields, multi-region and decomposed cases. Add DOLFIN, TetGen, and EnSight exports through the existing companion-aware writer contract, with format-specific eligibility checks. Refresh FLAC3D group handling from the newer implementation.

Drive menus and timelines from supported capabilities while retaining explicit format routing. A static file remains static even when its reader accepts a time-step option. Extend sequence export only where the target container can represent the series, including topology changes; do not reinterpret static-grid XDMF as a changing-topology container. Reconsider in-place OpenFOAM saving only after the extension can preserve the complete affected case, not merely its mesh.

**Acceptance:** named groups, units/diagnostics where available, companion files, distinct time values and samples, and source metadata survive real fixtures. The preview, series scan, cache invalidation, summary gate, and export agree on the same source files. **MCP:** extend existing info/convert/series tools and their schemas as needed.

## Tier 2 — Mesh preparation and analysis

Admission criterion: a concrete user workflow supported by the researched kernel surface, with a clear output and a bounded UI.

### 4. Diagnose and repair surface meshes — M

**Pending.** Add a repair workflow around `repair`: fix inconsistent orientation, orient closed components outward, fill bounded holes, weld when requested, and split non-manifold vertices. Link the existing watertight/normal diagnostics to selectable defects and before/after counts. Preserve upstream distinctions: splitting bowtie vertices is not a promise to repair every non-manifold edge, and orienting outward does not infer nested cavities.

**Acceptance:** known defective fixtures improve the requested counts, untouched entities retain their data, and generated faces have explicit membership and field policies. **MCP:** repair through `mesh_transform`; read-only defect reports through mesh analysis tools.

### 5. Surface simplification and display level of detail — M–L

**Pending.** Integrate `decimate` as an explicit surface-copy export and, separately, a preview-only level-of-detail option for large meshes. Expose target reduction, feature/boundary preservation where supported, and geometric error. Use provenance to associate simplified geometry with source entities; categorical fields and region boundaries need explicit preservation rules rather than numerical averaging.

**Acceptance:** export reports achieved reduction and error; preview LOD leaves the document unchanged and either resolves picks to source entities or clearly disables ambiguous picks. **MCP:** simplified-copy export; automatic display LOD is UI-only.

### 6. Curvature analysis and geometry-aware sizing — M

**Pending.** Integrate `computeCurvature` to display mean, Gaussian, and principal curvature and optionally persist them as nodal fields. Surface boundary policy, dual-area choice, and orientation diagnostics in the panel. Feed curvature-derived sizes into the existing remesh workflow, with named, reproducible sizing parameters.

**Acceptance:** analytic shapes and Gauss–Bonnet checks validate the analysis, and sign-dependent results expose inconsistent winding. **MCP:** read-only curvature analysis plus field creation through `mesh_transform`.

### 7. Surface fitting and controlled deformation — M–L

**Pending.** Add `shrinkwrap` against a chosen target mesh and `sobolevDeform` from a displacement field, with region selection, pinned nodes, distance/offset controls, and convergence feedback. Reuse second-mesh picking and field selectors. Present shrinkwrap as projection, not an iterative collision-free fit; inspect volume-cell quality when points move.

**Acceptance:** fixed nodes remain fixed, constant displacements behave correctly, projection limits are respected, and non-convergence or inverted cells are visible. **MCP:** both operations through `mesh_transform` with the same parameters and reports.

### 8. Expand surface and volume meshing choices — L

**Pending.** Add meshio++ surface `remesh`, volume `remeshVolume`, and `optimizeVolume` alongside MMG, with method names that distinguish surface redistribution, retetrahedralization, and fixed-connectivity optimization. Offer closed-surface-to-volume generation with resolution and quality controls. Include subdivision/agglomeration where they support a concrete topology-conversion workflow.

**Acceptance:** report quality, boundary deviation, manifoldness, element counts, and field/region transfer. Lattice-based volume generation must expose boundary defects rather than imply an unconditional mesh-quality guarantee. **MCP:** explicit backend/method selection in transform or generation tools, including generated-copy outputs.

### 9. Grids, voxelization, and sampled distance volumes — M–L

**Pending.** Expose `grid`, `voxelize`, and `computeSdf` for regular sampling, occupancy volumes, and volumetric signed-distance fields. This complements the existing distance-to-surface operation, which samples only the current mesh's nodes. Provide bounds, resolution/cell size, padding, and a memory estimate before allocation; export structured data when its topology is retained.

**Acceptance:** spacing, bounds, inside/outside conventions, field layout, and memory limits are tested against simple solids. **MCP:** mesh-generation/sampling tools with explicit output paths.

### 10. Compare meshes and simulation results — M–L

**Pending.** Use `diff`/`meshesEqual` for structural comparison and `interpolate` for comparing fields on different meshes. Show changed geometry, connectivity, groups, and fields; produce absolute/relative error fields and summary norms. Let users choose ID-based correspondence or spatial sampling, with tolerance and uncovered samples reported. Point sampling and the existing conservative transfer must remain separately named methods.

**Acceptance:** identical meshes give zero differences, known perturbations produce expected errors, and missing coverage is never treated as zero. **MCP:** comparison report plus optional difference-mesh export.

### 11. Export slices and isosurfaces; probe along paths — M

**Pending.** Turn `slice` and `isosurface` into reusable mesh exports carrying interpolated fields, rather than only visual overlays. Add line/polyline probes with distance-versus-value plots and CSV export, optionally repeated across a time series. These outputs serve downstream processing and quantitative inspection beyond the existing Clip and Field panels.

**Additional increment — threshold-region export:** build on the shipped `thresholdCells.ts` overlay to extract a derived volume mesh with original IDs, groups and fields, plus its boundary surface and selected-volume fraction. Expose the existing all/any nodal rule and cell-field semantics. Allow absolute ranges or normalized ranges with an explicit fixed reference range across time; per-frame rescaling must be opt-in because it changes the physical threshold. Define constraint handling for extracted meshes and preserve holes/missing samples. Magnusim's `threshold_iso_volume` demonstrates the volume-selection-to-surface-export workflow; its normalized scalar range is not an isosurface.

**Acceptance:** analytic fields interpolate correctly, source-cell correspondence is retained where available, and gaps in the sampling domain remain gaps. **MCP:** slice/isosurface exports and path-probe tables using the same compute core.

### 12. Export partitions, ghost layers, and connected components — M–L

**Pending.** Extend the existing `PARTITION_INDEX` operation with weighted partitioning, actual per-part meshes, ghost layers, original-ID maps, and an export manifest. Expose available partition backends, including KaHIP under the corrected-build assumption. Add `split` workflows for connected components and region-based extraction, with counts and isolated-fragment detection.

**Acceptance:** owned cells cover the source exactly once, ghosts are distinguishable from owned cells, and each exported part has consistent connectivity and fields. This produces partitioned data; solver-specific distributed Kratos setup is a separate integration. **MCP:** partition/split export tools returning the manifest and output paths.

### 13. Field management and conditioning — M

**Pending.** Add rename, keep/drop, and conditioning operations using `dataRename`, `dataKeep`, `dataDrop`, and `dataCondition`. Support scoped field selection, NaN handling, and documented conditioning modes without duplicating the existing calculator and averaging UI. Improve tensor-component selection beyond X/Y/Z for Hessians and other multi-component fields.

**Acceptance:** tuple widths, locations, sparse coverage, name collisions, and categorical values remain explicit and survive exports. **MCP:** field edits through `mesh_transform`; tensor-component presentation alone is UI-only.

## Tier 3 — Extension workflows and maintainability

Admission criterion: useful extension-level capabilities that build on the integrated kernel and existing document/run infrastructure.

### 14. Selection-driven editing and Properties authoring — L

**Pending.** Add multi-selection, box/lasso selection, isolate/hide/restore, selection sets, and filters by part, property, field, and quality. Use selected entities to create SubModelParts or scope operations. Add a Properties editor with explicit shared-property editing versus clone-and-reassign, including beam `CROSS_AREA`; this replaces the old “beam sections must stay read-only” exclusion with a canonical, undoable authoring workflow.

**Acceptance:** selection keeps independent entity-kind ID spaces, survives applicable edits through correspondence, and property edits update the model-emitted MDPA writer without creating a competing field value. **MCP:** selection predicates and property mutations are headless capabilities; pointer gestures and visibility controls are UI-only.

### 15. Saved view state and independent result comparison — M–L

**Pending.** Persist camera bookmarks, field/range settings, clipping, layout, and selected layers in a versioned view sidecar. Extend comparison views to two independent meshes or runs, with linked cameras and optional linked physical times. Offer per-pane visibility with an explicit pane scope in the outline rather than silently changing the meaning of the existing global checkboxes.

**Magnusim-inspired increment:** allow optional synchronized field choice, clipping and color ranges across independent runs, with a visible link toggle for each setting. Match physical time explicitly (exact/nearest with tolerance); disclose unmatched frames rather than synchronizing by frame index. Save the compared run identities with the view.

**Acceptance:** missing fields/layers degrade predictably on reload, views never mark mesh geometry dirty, and nonmatching time grids are labelled. **MCP:** view presentation is UI-only; numeric comparison reuses item 10.

### 16. Reusable recipes and batch processing — M–L

**Pending.** Add named recipe presets, editable/reorderable queued steps, parameter summaries, and batch application to selected files or a discovered series. Show an output plan, per-file progress, completed/failed/skipped results, and resumable manifests. Keep batch execution explicit rather than running expensive operations during ordinary timeline scrubbing.

**Acceptance:** deterministic output naming, documented partial-failure behavior, cancellation, and reproducible parameters; a batch cannot accidentally overwrite its own later inputs. **MCP:** batch-transform interface using the same validated recipes and execution reports.

### 17. Case preflight and isolated run workspaces — M–L

**Pending.** Expand case validation to report missing assignments, invalid property references, unused or empty parts, field requirements, and mesh-quality concerns before generation. Add opt-in per-run directories containing the generated inputs and a reproducibility manifest, preserving the existing `vtk_output` layout inside each run. Enable comparison of saved run outputs and parameters without collisions between cases sharing a source folder.

**Magnusim-inspired increment:** persist explicit source geometry/mesh revision, study ID and run ID in the manifest; clone case settings into a new run without mutating earlier inputs. Results, logs, cancellation and any later monitor/capture artifacts resolve through their owning run, even after switching the active case. Reload must never adopt a different study's output just because its filename matches. Consume a CAD handoff manifest when available and flag stale or unresolved group assignments after remeshing.

**Acceptance:** validation points to actionable entities or assignments; concurrent runs use distinct output locations and remain discoverable after reload. **MCP:** extend case validation/generation/run tools and status discovery with the same run-directory contract.

### 18. Export provenance and fidelity reports — M

**Pending.** Connect meshio++ provenance functions to conversion, derived-mesh export, recipes, and problem archives. Record source, kernel version, operation parameters, output format, and reported losses. Add an export summary describing retained/dropped groups, IDs, constraints, fields, and companions. Embedded provenance is used where supported; otherwise provide a clearly associated sidecar.

**Acceptance:** reports agree with a re-read of the output, and exported recipes remain distinct from machine-local solver status. **MCP:** return the same structured fidelity report and provenance location from write tools.

### 19. Large-mesh rendering and end-to-end regression coverage — L

**Pending.** Build on header summaries with progressive surface preview, selective field loading, bounded frame caching, and reduced data transfer. Keep a full-resolution source for editing/export while rendering a smaller representation when selected. Add a maintained packaged-extension integration harness covering both preview providers, save/revert/hot-exit, timelines, cancellation, and sidebar/palette parity; complement the existing standalone webview screenshot tooling.

**Acceptance:** establish representative large-file memory/latency budgets and exercise local and Remote-SSH-style sessions. A display approximation must not silently become exported geometry. **MCP:** selective-read and summary options share the host implementation; rendering and UI automation are exempt.

### 20. Solver convergence and saved monitors — M–L

**Implementation route:** use `runCore.ts`/`runFile.ts` for run ownership and `fieldSeries.ts` for saved-time sampling. Magnusim's `w27-solve.js` parses iteration/residual progress while `case/function_objects.py` generates monitor output independently of full result frames. For Kratos, select a supported output-process/log adapter per problemtype and record its version. Add named monitor rows with last value, time/iteration, history plot and CSV; store the sampling interval independently of VTK output frequency.

**Pending.** Extend tracked runs with bounded residual/iteration histories and saved monitor definitions. Start with one built-in Kratos problemtype and its documented solver output; prefer structured output where available and make log parsers versioned adapters. Separate iteration count, simulation time, process completion and convergence. Reuse current point/time plots and field-integral analysis for persisted point samples and area-weighted surface averages; live values require solver output configuration, while post-run evaluation samples saved frames only. Store units, selected field/component, region or coordinates, and source run with CSV export.

**Acceptance:** fixtures cover converged, divergent, cancelled and truncated/restarted logs; unsupported residual output stays unavailable. An analytic field validates surface weighting and point sampling; missing frames or samples remain gaps. Switching cases cannot redirect a monitor or cancel another run. **MCP:** read convergence and monitor tables, configure supported monitors and export their data through the same adapters. Extend the existing run store rather than adding a second job manager.

### 21. Streamlines from solved vector fields — M–L

**Source-driven increment:** Magnusim's `export_particle_trace.py` resolves selected boundary faces, builds seed lattices and integrates the volume field. Offer seed selection from a SubModelPart as well as explicit points/planes, forward/backward/both directions, maximum steps and terminal-speed tolerance. Preserve seed IDs and termination reasons in exported polylines; report seeds outside the domain and streams that stop immediately. Add line/tube styling only after the numerical export is usable.

**Pending.** Add steady streamlines seeded from explicit points or a line/plane in a selected vector field and time frame. First establish an interpolation/integration path for the supported volume cell types using the existing vtk.js/data adapters; do not assume meshio++ supplies a streamline binding. Bound step size, length and seed count, report termination at missing data/domain boundaries, and support cancellation. Keep streamlines distinct from transient particle pathlines, which require time interpolation and are a later scope decision.

**Acceptance:** uniform and rotational analytic fields produce expected trajectories, zero vectors terminate safely, and native solved velocity takes precedence over geometry-only cached previews. Missing velocity disables the operation with a reason. Export polylines with sampled values and source frame identity. **MCP:** expose seed/integration parameters and derived geometry export through a shared numerical core; viewport styling is UI-only.

### 22. Transient time-step and output-budget assistant — M

**Pending.** Extend `src/problemtype/builtins/fluid.ts`, which currently writes `automatic_time_step: false`, with an explicit fixed/adaptive choice where the installed Kratos solver supports it. Before generation, estimate a convective time scale from a documented cell length and user-selected reference velocity, target Courant number and safety factor. Show estimated step count, output-frame count and storage range; keep solver step and output cadence separate. Magnusim's `estimate_delta_t` uses minimum-cell volume, sizing and bounding-box fallbacks, and `flow_through_time` estimates domain transit time. Preserve that explanation of inputs and fallback basis, but do not silently impose its speed floor or suggest cube-root volume is sufficient for highly anisotropic cells.

**Acceptance:** analytic uniform meshes give the expected size/velocity scaling; thin/sliver cells receive a conservative metric or an explicit limitation; zero velocity and missing units produce unavailable estimates. User values remain authoritative. Validate emitted adaptive parameters against the selected Kratos runtime and show a convective estimate as guidance, not a universal stability guarantee for implicit, diffusive or structural solvers. **MCP:** read the estimate and explicitly apply chosen case controls through the existing case tools.

### 23. Boundary flow balance and pressure-drop reports — M–L

**Pending.** Add a CFD analysis over selected inlet/outlet SubModelParts: signed volumetric flux `integral(u dot n dA)`, optional mass flux with explicit density, area-weighted pressure, pressure difference between named sections and normalized imbalance with a documented denominator. Repeat over saved times and export CSV. Reuse the integral panel for presentation but introduce oriented surface quadrature; averaging vector components and multiplying by area is not generally a flux integral. Magnusim's function-object writer generates area averages of `U`/`p` and sums face flux `phi`, demonstrating why flow monitoring needs its own semantics.

**Acceptance:** a straight duct balances opposing inlet/outlet fluxes; reversing face orientation flips the sign; overlapping selections, internal faces, missing velocity/density and uncovered samples are reported. A zero-flow denominator yields unavailable relative imbalance, not infinity. Distinguish volumetric from mass flow and only compare compatible pressure quantities. **MCP:** read-only balance/pressure-drop report with optional time-series CSV output; live solver monitors can follow through the existing monitor item.

### 24. Field dimensions and explicit pressure conversion — M–L

**Pending.** Carry dimensions/units from readers through `FieldData`, field selectors, legends, probes, comparison and CSV. Start by retaining the OpenFOAM seven-exponent `dimensions` vector in `openfoamFields.ts`; preserve original values and add an explicit derived-field conversion from kinematic pressure to Pa using documented positive density. Do not infer pressure semantics solely from a field named `p`, and do not rescale Kratos `PRESSURE`, which the fluid case already expresses in Pa. Label gauge/absolute reference separately from units; converting dimensions cannot infer a reference pressure.

**Acceptance:** fixtures for dimensional pressure, kinematic pressure, unknown units and conflicting density give distinct outcomes; repeated display-unit changes leave original samples unchanged. Difference plots reject incompatible dimensions or require an explicit conversion. Conversion/export provenance records density, source units and pressure reference, with variable-density cases requiring a field-aware policy. **MCP:** field metadata and explicit conversion tools share the same rules. Coordinate metadata retention with **Complete format, metadata, and transient integration** rather than another reader.

### 25. Reusable material presets with provenance — M

**Pending.** Add a small, searchable user-extensible material catalog to the existing problemtype material-law forms. Keep the constitutive law distinct from a preset of parameter values. Each preset carries compatible laws/dimensions, canonical units, reference temperature/conditions, source/version and editable copied values; existing cases retain a snapshot when a library entry changes. Start with independently sourced fluid density/viscosity examples and user-defined entries. Magnusim's `materials/library.py` illustrates searchable records and reference conditions, but a catalog row (including Water) does not prove its full solver workflow is validated.

**Acceptance:** converting kinematic viscosity to dynamic viscosity uses `mu = rho * nu` once; invalid density or incompatible laws cannot generate a case. Imported user presets round-trip, editing a case does not mutate the library, and updating a preset does not alter past runs. **MCP:** list/inspect presets and explicitly apply a snapshot through case material assignment; generated material files remain the existing writer's responsibility.

## Tier 4 — Optional companion and advanced geometry work

Admission criterion: valuable opportunities needing a new runtime boundary or a larger model change. These remain pending, but are not prerequisites for the direct WASM features above.

### 26. Curved high-order and native polyhedral fidelity — L

**Pending.** Preserve original high-order/polyhedral topology separately from display tessellation, including provenance for picking and field transfer. Investigate meshio++'s curved `tessellate` implementation and gather/scatter maps for visually correct quadratic cells and source-preserving exports. The researched tessellation implementation is Python-only; choose a future WASM binding or optional companion rather than assuming it is already available in JS.

**Acceptance:** curved shared faces remain watertight, high-order node ordering is checked per format, and display subdivision never silently replaces original cells on save. **MCP:** faithful read/write and explicit tessellation/export capabilities; viewport tessellation alone is UI-only.

### 27. Optional Python companion for datasets and surrogate results — L

**Pending.** Explore an explicitly configured external Python companion for meshio++ capabilities outside the WASM package: point budgets, proximity graphs, PMSH (`.pmsh`), Zarr/CAE dataset export, USD time-series export, and PhysicsNeMo inference. Start with exporting existing runs and loading predicted fields with model metadata and comparison metrics; training orchestration is a later scope decision. Do not assume the problemtype Pyodide runtime can host native Python, Torch, or CUDA dependencies.

**Acceptance:** discover companion capabilities and versions, report missing dependencies clearly, stream large datasets, and label predictions separately from solver output. **MCP:** mirror every enabled dataset/export/inference capability through the same optional backend.

## Boundaries that still apply

These are product or runtime constraints rather than historical meshio++ WASM blockers:

- **No general ParaView-style visualization graph.** Prefer focused analysis panels and explicit operation recipes; richer batch processing does not require a second visual programming environment.
- **No automatic expensive remeshing on timeline navigation.** Keep deliberate re-apply and explicit series processing.
- **No silent destructive case rewrites.** Directory-based formats need complete companion ownership and fidelity before in-place save is enabled; generated copies remain useful even with a fully working kernel.
- **Keep solver ownership and transport honest.** The MCP server starts detached runs and uses log files; it must not claim an exit code after losing observation of the process. Windows graceful stopping needs a separate process/console design, independent of meshio++ integration.
- **Rendering remains a separate runtime concern.** Software-WebGL translucency, recording with a non-preserved drawing buffer, browser codec availability, and webview CSP restrictions are not fixed by a WASM upgrade. A VTK-wasm replacement was evaluated and dropped — see [`doc/vtk-wasm-spike.md`](./vtk-wasm-spike.md) — so the existing synchronous render/copy capture and WebM/PNG outputs stand until a materially different runtime is proposed and re-evaluated.
- **Keep file ownership explicit.** The empty preview remains a launcher until an independently justified session abstraction supports late file binding. Shared runs views continue to project one run store.
- **Do not advertise Python-only or optional-backend features as bundled WASM capabilities.** Track the binding/runtime needed to deliver them while keeping them eligible for future integration.
