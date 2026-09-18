# Roadmap

Pending work for Kratos MDPA Preview, prioritizing full meshio++ integration, a clearer UI shared with CAD-Preview, and practical mesh preparation and results-analysis workflows. Existing foundations include MMG remeshing, meshio++ WASM, replayable edit histories, Python problemtypes, field visualization, time-series playback, tracked Kratos runs, and a headless MCP server.

**meshio++ has resolved its WASM-module issues and is adopted at its full, latest version.** Historical binding failures, missing side channels, format defects, and build omissions are no longer exclusions from this roadmap — `@meshioplusplus/wasm` is pinned at `^12.0.0`, the version upstream's own changelog records as closing WASM parity in full, and the extension's packaged runtime already declares and uses it. What remains is connecting its capabilities to the extension end to end, preserving Kratos semantics, and verifying the resulting workflows — the items below, not the dependency adoption itself.

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

## Delivery rules

- **Prioritize integration and usability before breadth.** Tier 1 establishes a reliable shared foundation; later tiers add workflows on top. Independent UI work can proceed alongside kernel integration.
- **Full integration means access to the useful kernel surface through a consistent adapter.** It does not require deleting working native implementations or exposing duplicate buttons for equivalent algorithms. Choose a backend per operation on fidelity, performance, and maintenance cost.
- **Preserve the extension's data contract.** Original node and entity IDs, independent Elements/Conditions/Geometries ID spaces, Properties, constraints, SubModelParts, field components, and source-cell correspondence must survive wherever the operation permits. For topology-changing operations, define generated IDs, field transfer, and metadata handling explicitly.
- **MCP parity ships with every headless capability.** Update `src/mcp/tools.ts`, `src/mcp/register.ts`, `src/test/mcpTools.test.ts`, and the tool documentation in the same implementation change. UI-only work is exempt; a UI wrapper around a new analysis or edit is not.
- **Acceptance checks are part of each estimate.** Use real format fixtures, numerical invariants, cancellation and undo/redo tests, and packaged-extension checks where appropriate. Retest the target package as normal integration work rather than leaving features indefinitely labelled “needs live-WASM verification.”

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

**Acceptance:** missing fields/layers degrade predictably on reload, views never mark mesh geometry dirty, and nonmatching time grids are labelled. **MCP:** view presentation is UI-only; numeric comparison reuses item 10.

### 16. Reusable recipes and batch processing — M–L

**Pending.** Add named recipe presets, editable/reorderable queued steps, parameter summaries, and batch application to selected files or a discovered series. Show an output plan, per-file progress, completed/failed/skipped results, and resumable manifests. Keep batch execution explicit rather than running expensive operations during ordinary timeline scrubbing.

**Acceptance:** deterministic output naming, documented partial-failure behavior, cancellation, and reproducible parameters; a batch cannot accidentally overwrite its own later inputs. **MCP:** batch-transform interface using the same validated recipes and execution reports.

### 17. Case preflight and isolated run workspaces — M–L

**Pending.** Expand case validation to report missing assignments, invalid property references, unused or empty parts, field requirements, and mesh-quality concerns before generation. Add opt-in per-run directories containing the generated inputs and a reproducibility manifest, preserving the existing `vtk_output` layout inside each run. Enable comparison of saved run outputs and parameters without collisions between cases sharing a source folder.

**Acceptance:** validation points to actionable entities or assignments; concurrent runs use distinct output locations and remain discoverable after reload. **MCP:** extend case validation/generation/run tools and status discovery with the same run-directory contract.

### 18. Export provenance and fidelity reports — M

**Pending.** Connect meshio++ provenance functions to conversion, derived-mesh export, recipes, and problem archives. Record source, kernel version, operation parameters, output format, and reported losses. Add an export summary describing retained/dropped groups, IDs, constraints, fields, and companions. Embedded provenance is used where supported; otherwise provide a clearly associated sidecar.

**Acceptance:** reports agree with a re-read of the output, and exported recipes remain distinct from machine-local solver status. **MCP:** return the same structured fidelity report and provenance location from write tools.

### 19. Large-mesh rendering and end-to-end regression coverage — L

**Pending.** Build on header summaries with progressive surface preview, selective field loading, bounded frame caching, and reduced data transfer. Keep a full-resolution source for editing/export while rendering a smaller representation when selected. Add a maintained packaged-extension integration harness covering both preview providers, save/revert/hot-exit, timelines, cancellation, and sidebar/palette parity; complement the existing standalone webview screenshot tooling.

**Acceptance:** establish representative large-file memory/latency budgets and exercise local and Remote-SSH-style sessions. A display approximation must not silently become exported geometry. **MCP:** selective-read and summary options share the host implementation; rendering and UI automation are exempt.

## Tier 4 — Optional companion and advanced geometry work

Admission criterion: valuable opportunities needing a new runtime boundary or a larger model change. These remain pending, but are not prerequisites for the direct WASM features above.

### 20. Curved high-order and native polyhedral fidelity — L

**Pending.** Preserve original high-order/polyhedral topology separately from display tessellation, including provenance for picking and field transfer. Investigate meshio++'s curved `tessellate` implementation and gather/scatter maps for visually correct quadratic cells and source-preserving exports. The researched tessellation implementation is Python-only; choose a future WASM binding or optional companion rather than assuming it is already available in JS.

**Acceptance:** curved shared faces remain watertight, high-order node ordering is checked per format, and display subdivision never silently replaces original cells on save. **MCP:** faithful read/write and explicit tessellation/export capabilities; viewport tessellation alone is UI-only.

### 21. Optional Python companion for datasets and surrogate results — L

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
