# Roadmap

Pending work for Kratos MDPA Preview, prioritizing full meshio++ integration, a clearer UI shared with CAD-Preview, and practical mesh preparation and results-analysis workflows. Existing foundations include MMG remeshing, meshio++ WASM, replayable edit histories, Python problemtypes, field visualization, time-series playback, tracked Kratos runs, and a headless MCP server.

**meshio++ is adopted at the locked 15.4.0 baseline.** Historical binding failures, missing side channels, format defects, and build omissions are no longer exclusions from this roadmap — `@meshioplusplus/wasm` is pinned at `^15.4.0`, the locked baseline for this integration, and the extension's packaged runtime already declares and uses it. What remains is connecting its capabilities to the extension end to end, preserving Kratos semantics, and verifying the resulting workflows — the items below, not the dependency adoption itself. Keeping that pin current as upstream releases is its own standing item, Tier 0.

This page is aspirational, not a release commitment. All numbered items are **pending**. Effort is approximate: **S** = a day or two, **M** = roughly a week, **L** = multi-week. Completed features belong in `CHANGELOG.md` and implementation details in `CLAUDE.md`; remove completed items here. No tracker issues have been assigned to the items below yet.

## Research baseline

Reviewed `/home/vicente/src/meshioplusplus` on **2026-09-22**, including its changelog through 15.4.0, `bindings/wasm/js_bindings.cpp`, and capability documentation. The extension declares `@meshioplusplus/wasm: ^15.4.0`. The JS API has no breaking changes between 12.0.0 and 15.4.0 — `readMeshSelective` gained `piece`/`dropGhosts` (composite-dataset selection) and `computeNormals` was added — so this bump is a routing exercise, not a compatibility one. New format keys since 12.0.0: `vtkhdf` (14.0.0, read/write), `pvd`/`pvtu`/`pvtp` (15.0.0; `.pvd` is read natively through its own light index, `pvtu`/`pvtp` are routed for reading), `pcd`/`xyz` (15.1.0, read/write, no cells), `lsdyna` (15.2.0, read/write, geometry only), `frd` (15.3.0, read-only, CalculiX results), `gltf`/`glb` (15.4.0, write-only, unrouted — no web-viewer consumer). `vtkhdf`, `pcd`, `xyz`, `lsdyna`, `frd`, `pvtu` and `pvtp` are now routed (`meshioFormats.ts`); the full accounting of every live reader/writer key is `mesh_capabilities`' `unroutedReaders`, asserted in `mcpTools.test.ts`. The full transient audit was re-run against 15.4.0 (`src/test/fixtures/transient/README.md`): no existing classification changed. `vtkhdf` and `.pvd` are admitted to the in-file timelines; `frd` is options-aware but is deliberately not admitted, because its metadata read falls back to a full read (see that README).

| Evidence in the local checkout | Roadmap opportunity |
|---|---|
| [WASM bindings](https://github.com/loumalouomega/meshioplusplus/blob/master/bindings/wasm/js_bindings.cpp) and [JavaScript API](https://github.com/loumalouomega/meshioplusplus/blob/master/doc/wasm.md) expose `repair`, `computeCurvature`, `shrinkwrap`, `sobolevDeform`, `remesh`, `remeshVolume`, `optimizeVolume`, `grid`, `voxelize`, and `computeSdf` | Add preparation, analysis, and mesh-generation workflows beyond the operations already integrated. |
| The same binding exposes `diff`, `meshesEqual`, `interpolate`, `slice`, `isosurface`, `split`, `partition`, field-management operations, and provenance functions | Mesh comparison, sampled results, reusable derived meshes, partition exports, and traceable conversions. |
| [WASM pipeline documentation](https://github.com/loumalouomega/meshioplusplus/blob/master/doc/wasm.md) describes `runPipeline` and `convertSurfaceOps`, which keep intermediate meshes inside C++ | Reduce repeated whole-mesh transfers and enable bounded batch processing. |
| [Partition documentation](https://github.com/loumalouomega/meshioplusplus/blob/master/doc/partition.md) covers weights, recorded source indices, and ghost layers; bindings expose `ghostLayers` | Extend the existing partition-label operation into actual domain exports. |
| [Changelog](https://github.com/loumalouomega/meshioplusplus/blob/master/CHANGELOG.md) records FLAC3D group fixes in 10.36.0, curvature in 10.37.0, and repair/shrinkwrap/Sobolev deformation in 10.38.0 | Refresh format fidelity and integrate concrete new operations rather than treating every unused export as a feature request. |
| The changelog explicitly identifies curved tessellation (10.39.0), point budgets, proximity graphs, PhysicsNeMo workflows, and PMSH/Zarr/CAE/USD format additions as Python-only work | Track these separately as optional companion or future-binding work; resolving WASM defects does not automatically port Python code. |

The historical audits in `src/test/fixtures/transient/README.md` and `CLAUDE.md` remain evidence about the versions tested. During integration, replace obsolete expectations with positive capability tests and retain relevant regression fixtures. Source inspection supports this roadmap; no new live-WASM audit was performed for this documentation change. A VTK-wasm rendering-runtime evaluation (standalone-session boot, bulk data transfer, and a minimal end-to-end render, testing the shipped webview CSP and required changes) was run and closed on **2026-09-18** with a drop verdict — see [`doc/vtk-wasm-spike.md`](./vtk-wasm-spike.md) for the full findings, measurements, and reproduction steps. That verdict remains evidence about the tested artifact; replacement is reopened as **pending in item 17**, with its blockers explicitly carried forward. vtk.js remains the shipped renderer until the migration passes its acceptance gates.

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

**Standing work — verified integration baseline, 2026-09-25.** The extension declares `@meshioplusplus/wasm: ^15.4.0` and its lockfile resolves 15.4.0. This is the checked baseline, not a claim about the latest published release. A caret range never crosses a major version; review major upgrades deliberately and record their compatibility evidence.

For each release, read the upstream changelog entry and classify what it touches for the WASM build before bumping:

- **Formats:** a new or changed reader/writer key (14.0.0 adds `vtkhdf`, with partition selection and transient `Steps`). Decide explicitly whether to route it, and extend `MESHIO_READER_KEYS`/`MESHIO_WRITER_KEYS`, `MESHIO_READ_CANDIDATES`, `EXPORT_MENU_GROUPS`, `SUPPORTED_MESH_EXTENSIONS` and the timeline lists. A key that the live artifact reports but nothing routes is listed as deliberately absent with a reason, never left unexamined.
- **Boundary and ABI:** option structs or dtypes crossing the wasm boundary (14.0.0 grows `ReadOptions` with `piece`, 13 → 14). Re-check `readMeshSelective`/`readMetadata` options handling, integer array types (`BigInt64Array`), and the `*_components` maps.
- **Behavior changes that alter what the extension already relies on:** 13.0.0 changes fallback semantics in the Python shims and pins C++ streams to the classic locale; whether any of that reaches the WASM build is to be measured, not assumed.
- **Fixes that retire a workaround:** upstream fixes (for example 12.1.0's MED and Gmsh higher-order node-ordering permutations, VTU polyhedron mixed-node-count `cell_data`) may make a local compensation redundant or wrong. Remove the workaround and its stale note in the same change.

Then, per bump: update `package.json`/`package-lock.json`, confirm both `dist/meshio/` variants (sequential and `_mt`) still load and that `locateFile` stays name-aware, re-run the transient audit and the per-format options-awareness pins so a changed capability fails a test rather than a user, refresh `mesh_capabilities` expectations, and record the `.vsix` size change. Update the "Research baseline" date and the pinned version in the introduction, and add a `CHANGELOG.md` entry naming the version and the notable capability changes.


**KKSS embedding follow-up (S per upgrade):**

- **Evidence:** KKSS copies this extension's `dist/meshio` tree beside its application and MCP bundles. In the 2026-09-25 audit, mesh locked 15.4.0 and CAD independently locked 16.7.0; KKSS's bundled mesh/CAD MCP and MMG worker checks passed with the shared 15.4.0 tree. Those exercised paths establish a tested baseline, not compatibility with every API or future version.
- **First useful increment:** mesh owns a documented staged-runtime contract and repeatable artifact checks for MCP, meshio++ loaders/WASM variants, and the MMG worker/WASM pair. KKSS owns copying those artifacts into its layout and testing its shared CAD/mesh runtime on every dependency update. Keep runtime separation an explicit response to a demonstrated conflict.
- **Verification:** load and execute from staged artifacts with development package resolution unavailable; check companion lookup, binary/version identity, and actionable missing-artifact errors. Repeat both engines' real operations in KKSS after either lockfile changes; see item 7 for the workflow matrix.
- **Done when:** an upgrade cannot pass packaging checks with a missing worker/kernel or an incompatible shared runtime, and the checked versions and layout are recorded with the result.

Automate the detection so it does not depend on remembering: a scheduled CI job that compares the declared range with `npm view @meshioplusplus/wasm version` and reports when the latest release is outside it, since that is the one case Dependabot's grouping misses.

**Acceptance:** the pinned version equals the latest published release (or a documented reason for staying behind is recorded here), the full test suite passes against it, every reader/writer key the live artifact reports is either routed or listed as deliberately absent, and no roadmap item cites a superseded version as its baseline. **MCP:** no new tool by itself; any newly routed format or operation must appear through `mesh_capabilities` and the existing info/convert tools in the same change.

## Tier 1 — Full integration and a unified user experience

Admission criterion: work that enables multiple subsequent features or improves the everyday workflow across the extension.

### 1. Improve the UI and unify it with CAD-Preview — L

**Pending — explicit cross-extension priority.** Audit both extensions against the existing [shared UI design system](./ui-design-system.md) and converge on a common interaction vocabulary and component set. Align File/View/Advanced menus, toolbar hierarchy, navigation controls, orientation cube, layer-tree actions, selection feedback, form layouts, icons, spacing, typography, progress/cancel states, and empty/error states. Update the design-system document's stale “pending” descriptions against what actually ships before using it as the implementation checklist.

Reduce the density of mesh-operation forms with searchable actions, clear categories, progressive disclosure of advanced settings, and consistent inline validation. Establish predictable panel docking and overflow at narrow widths. Include keyboard navigation, visible focus, accessible names, high-contrast themes, and reduced-motion behavior. Share tokens and reusable components through a versioned source or synchronized copies with a drift check; keep Kratos-specific problem setup distinct within the common shell.

**KKSS integration increment — panel docking and overflow (M):**

- **Evidence:** the Mesh 4.6.0 Electron acceptance run reproduced a VTK probe chart overlapping Selection's Box control and intercepting clicks. The affected layout belongs to the extension webview; KKSS supplies the surrounding viewport.
- **First useful increment:** mesh owns predictable placement and scrolling for simultaneous Inspect, Probe and Selection panels. Preserve active form values and focus when panels resize or move; coordinate available viewport bounds with the embedding host rather than relying on a VS Code editor's dimensions.
- **Verification:** in the extension and KKSS, open a probe chart and Selection together at the default and narrow viewport sizes, resize, traverse controls by keyboard, and perform selection and probe export without forced clicks or closing another panel. Include high-contrast themes and visible focus.
- **Done when:** all visible panel actions remain reachable by pointer and keyboard, no chart intercepts another panel's controls, and resizing preserves the user's draft input. KKSS retains the embedded interaction regression; mesh owns the layout fix and extension coverage.

**Acceptance:** compare the same open → inspect → clip → edit → export workflow in both extensions, with visual and interaction checks in dark, light, and high-contrast themes and at small viewport sizes. **MCP:** UI-only exemption; any new underlying operation discovered during this work still needs parity.

### 2. Run expensive meshio++ work in cancellable workers — L

**Pending.** Extend the existing MMG worker pattern to costly meshio++ reads, analyses, and operations. Report stages, support cancellation, release WASM heaps after work, and prevent stale results from replacing a newer frame or document state. Use transferable buffers where ownership permits and benchmark end-to-end memory, including filesystem staging and webview delivery.

Evaluate `runPipeline` for compatible batches to avoid repeated JS/WASM copies. Preserve the operation queue's per-step history and partial-completion semantics; a faster backend must still return enough results or checkpoints to honor undo and cancellation.

**KKSS integration increment — execution and reply lifecycle (L):**

- **Evidence:** KKSS embeds the MDPA/VTK providers in Electron's main process. Their `meshAnalysis` handlers await `probeAlongPath`, but its WASM interpolation is synchronous; `await` does not move that computation off the host thread. In `src/meshAnalysis.ts`, successful probe replies echo `seq`, while validation/error replies omit it; `applyProbeResult` in `webview/main.ts` only rejects a mismatching sequence when one is present. Successful stale-reply rejection was exercised in KKSS; delayed failures and cancellation still need coverage.
- **First useful increment:** mesh owns a worker execution boundary for expensive analyses, starting with line probing and reusing the MMG worker pattern. Carry request, document and frame identity through progress, success and failure responses. Cancel superseded requests and work owned by a closed document, release worker/WASM resources, and make late replies harmless. Preserve sequential edit-history and partial-completion semantics as additional operations migrate.
- **Verification:** use a large probe fixture while measuring host heartbeat latency and exercising navigation/cancel in VS Code and KKSS. Inject delayed successes and failures after a newer frame/request, panel close/reopen and document disposal. Check worker termination, resource release, unchanged geometry/history after cancellation, and numerical agreement with the existing synchronous core.
- **Done when:** the host continues servicing UI events during computation, cancellation stops owned work, and no stale success or error can replace current state. Mesh provides the execution/cancellation contract to both providers and MCP; KKSS validates it in its main-process embedding.

**Acceptance:** large reads and edits leave the extension host responsive, cancellation releases resources, and batching agrees with sequential execution. **MCP:** use the shared execution layer where applicable and expose progress/cancellation through the MCP request lifecycle without writing logs to the stdio transport.

## Tier 2 — Extension workflows and maintainability

Admission criterion: useful extension-level capabilities that build on the integrated kernel and existing document/run infrastructure.

### 3. Saved view state and independent result comparison — M–L

**Pending.** Persist camera bookmarks, field/range settings, clipping, layout, and selected layers in a versioned view sidecar. Extend comparison views to two independent meshes or runs, with linked cameras and optional linked physical times. Offer per-pane visibility with an explicit pane scope in the outline rather than silently changing the meaning of the existing global checkboxes.

**KKSS integration increment — reopenable view state (M):**

- **Evidence:** `webview/main.ts` explicitly keeps camera bookmarks session-only; `webview/bookmarksPanel.ts` offers manual JSON transfer. This is a persistence gap, not a claim that camera bookmarks are absent. KKSS restoring a document tab does not restore these webview-local settings.
- **First useful increment:** mesh owns a versioned, document-associated view sidecar for camera/bookmarks, field and range choice, clipping, pane layout and layer visibility. Restore it independently of mesh edit history and retain manual bookmark import/export. Define tolerant reads for missing entries and unsupported versions; KKSS restores the document and supplies normal sidecar access without maintaining a competing view-state schema.
- **Verification:** change each supported setting, close/reopen in both hosts, and compare restored values. Open two documents with different settings and verify isolation. Reopen after fields/layers disappear or the sidecar is missing/malformed; report unsupported state and retain usable defaults. Check geometry bytes and dirty state before and after view-only changes.
- **Done when:** supported view settings survive reopening, each document retains its own state, and unavailable fields/layers degrade predictably without editing geometry. Independent-run comparison remains the subsequent increment in this existing item.

**Magnusim-inspired increment:** allow optional synchronized field choice, clipping and color ranges across independent runs, with a visible link toggle for each setting. Match physical time explicitly (exact/nearest with tolerance); disclose unmatched frames rather than synchronizing by frame index. Save the compared run identities with the view.

**Acceptance:** missing fields/layers degrade predictably on reload, views never mark mesh geometry dirty, and nonmatching time grids are labelled. **MCP:** view presentation is UI-only; numeric comparison reuses the existing `mesh_compare` MCP tool and `compareField` operation.

### 4. Reusable recipes and batch processing — M–L

**Pending.** Add named recipe presets, editable/reorderable queued steps, parameter summaries, and batch application to selected files or a discovered series. Show an output plan, per-file progress, completed/failed/skipped results, and resumable manifests. Keep batch execution explicit rather than running expensive operations during ordinary timeline scrubbing.

**Acceptance:** deterministic output naming, documented partial-failure behavior, cancellation, and reproducible parameters; a batch cannot accidentally overwrite its own later inputs. **MCP:** batch-transform interface using the same validated recipes and execution reports.

### 5. Case preflight and isolated run workspaces — M–L

**Pending.** Expand case validation to report missing assignments, invalid property references, unused or empty parts, field requirements, and mesh-quality concerns before generation. Add opt-in per-run directories containing the generated inputs and a reproducibility manifest, preserving the existing `vtk_output` layout inside each run. Enable comparison of saved run outputs and parameters without collisions between cases sharing a source folder.

**Magnusim-inspired increment:** persist explicit source geometry/mesh revision, study ID and run ID in the manifest; clone case settings into a new run without mutating earlier inputs. Results, logs, cancellation and any later monitor/capture artifacts resolve through their owning run, even after switching the active case. Reload must never adopt a different study's output just because its filename matches. Consume a CAD handoff manifest when available and flag stale or unresolved group assignments after remeshing.

**Acceptance:** validation points to actionable entities or assignments; concurrent runs use distinct output locations and remain discoverable after reload. **MCP:** extend case validation/generation/run tools and status discovery with the same run-directory contract.

### 6. Export provenance and fidelity reports — M

**Pending.** Connect meshio++ provenance functions to conversion, derived-mesh export, recipes, and problem archives. Record source, kernel version, operation parameters, output format, and reported losses. Add an export summary describing retained/dropped groups, IDs, constraints, fields, and companions. Embedded provenance is used where supported; otherwise provide a clearly associated sidecar.

**KKSS integration increment — one fidelity report for UI and MCP (M):**

- **Evidence:** `src/meshExport.ts` already checks geometric eligibility and collects writer warning strings; the writers and MCP conversion paths already expose diagnostics. The remaining gap is a consistent, structured account of what survived a particular export, rather than a lack of warnings or a newly demonstrated conversion failure. KKSS's small MDPA/VTU fixtures verified selected IDs, groups, property edits and sampled fields, not a complete format-fidelity matrix.
- **First useful increment:** mesh owns a common export report describing source/output formats, kernel version, applied operations, written companions, and retained, transformed, omitted or unverified data categories. Reuse eligibility checks and existing writer diagnostics. Expose the same report to viewer exports and MCP write results; embed provenance where supported or associate a sidecar. KKSS displays/consumes the report without inferring fidelity from an extension or a successful write alone.
- **Verification:** export and reopen fixtures covering connectivity, original node/entity IDs, Properties, SubModelParts/groups, constraints, nodal/cell fields and component counts, and companion files. Compare numerical values and associations. Classify expected format limitations separately from unexpected discrepancies; intentionally remove a companion and verify an actionable diagnostic. Do not mark untested categories as preserved.
- **Done when:** UI and MCP describe the same losses and output files, every claimed preservation agrees with the reopened fixture, and unexpected losses fail a regression rather than being relabelled as normal format limitations.

**Acceptance:** reports agree with a re-read of the output, and exported recipes remain distinct from machine-local solver status. **MCP:** return the same structured fidelity report and provenance location from write tools.

### 7. Large-mesh rendering and end-to-end regression coverage — L

**Pending.** Build on header summaries with progressive surface preview, selective field loading, bounded frame caching, and reduced data transfer. Keep a full-resolution source for editing/export while rendering a smaller representation when selected. Add a maintained packaged-extension integration harness covering both preview providers, save/revert/hot-exit, timelines, cancellation, and sidebar/palette parity; complement the existing standalone webview screenshot tooling.

**KKSS integration increment — maintain the embedded artifact matrix (M):**

- **Evidence:** KKSS's 2026-09-25 integration run passed bundled mesh MCP operations and MMG remeshing, plus Electron MDPA/VTK editing, save/reopen, selection refresh, probe CSV values, timeline resampling and stale successful replies. These are existing downstream checks; the pending work is making their contracts repeatable upstream and extending coverage, not rebuilding those features.
- **First useful increment:** mesh owns reusable small fixtures, expected numerical invariants, and a packaged-artifact harness for both providers and MCP. Stage the MCP server, MMG worker/WASM and meshio++ tree into a temporary distribution without access to development dependencies. KKSS owns its embedding adapter and Electron assertions against the same fixtures; keep this workflow matrix linked to the runtime checks in item 0.
- **Verification:** assert capabilities, selection predicates, property changes, deletion/undo/redo, save/reopen, real probe CSV values, frame resampling and stale success/error handling. Inspect reopened connectivity, IDs, groups and fields; for MMG require changed mesh resolution with preserved fixture bounds. Exercise missing artifacts and companions, and close/reload during pending work. A skipped runtime or unavailable display is reported as unverified, never passing.
- **Done when:** staged-artifact tests run without falling back to checkout packages, both providers and MCP agree on the fixture results, and a downstream embedding can consume the documented artifacts and reproduce those checks. Rendering budgets and large-file scenarios remain the broader scope of this item.

**Acceptance:** establish representative large-file memory/latency budgets and exercise local and Remote-SSH-style sessions. A display approximation must not silently become exported geometry. **MCP:** selective-read and summary options share the host implementation; rendering and UI automation are exempt.

### 8. Solver convergence and saved monitors — M–L

**Implementation route:** use `runCore.ts`/`runFile.ts` for run ownership and `fieldSeries.ts` for saved-time sampling. Magnusim's `w27-solve.js` parses iteration/residual progress while `case/function_objects.py` generates monitor output independently of full result frames. For Kratos, select a supported output-process/log adapter per problemtype and record its version. Add named monitor rows with last value, time/iteration, history plot and CSV; store the sampling interval independently of VTK output frequency.

**Pending.** Extend tracked runs with bounded residual/iteration histories and saved monitor definitions. Start with one built-in Kratos problemtype and its documented solver output; prefer structured output where available and make log parsers versioned adapters. Separate iteration count, simulation time, process completion and convergence. Reuse current point/time plots and field-integral analysis for persisted point samples and area-weighted surface averages; live values require solver output configuration, while post-run evaluation samples saved frames only. Store units, selected field/component, region or coordinates, and source run with CSV export.

**Acceptance:** fixtures cover converged, divergent, cancelled and truncated/restarted logs; unsupported residual output stays unavailable. An analytic field validates surface weighting and point sampling; missing frames or samples remain gaps. Switching cases cannot redirect a monitor or cancel another run. **MCP:** read convergence and monitor tables, configure supported monitors and export their data through the same adapters. Extend the existing run store rather than adding a second job manager.

### 9. Streamlines from solved vector fields — M–L

**Source-driven increment:** Magnusim's `export_particle_trace.py` resolves selected boundary faces, builds seed lattices and integrates the volume field. Offer seed selection from a SubModelPart as well as explicit points/planes, forward/backward/both directions, maximum steps and terminal-speed tolerance. Preserve seed IDs and termination reasons in exported polylines; report seeds outside the domain and streams that stop immediately. Add line/tube styling only after the numerical export is usable.

**Pending.** Add steady streamlines seeded from explicit points or a line/plane in a selected vector field and time frame. First establish an interpolation/integration path for the supported volume cell types using the existing vtk.js/data adapters; do not assume meshio++ supplies a streamline binding. Bound step size, length and seed count, report termination at missing data/domain boundaries, and support cancellation. Keep streamlines distinct from transient particle pathlines, which require time interpolation and are a later scope decision.

**Acceptance:** uniform and rotational analytic fields produce expected trajectories, zero vectors terminate safely, and native solved velocity takes precedence over geometry-only cached previews. Missing velocity disables the operation with a reason. Export polylines with sampled values and source frame identity. **MCP:** expose seed/integration parameters and derived geometry export through a shared numerical core; viewport styling is UI-only.

### 10. Transient time-step and output-budget assistant — M

**Pending.** Extend `src/problemtype/builtins/fluid.ts`, which currently writes `automatic_time_step: false`, with an explicit fixed/adaptive choice where the installed Kratos solver supports it. Before generation, estimate a convective time scale from a documented cell length and user-selected reference velocity, target Courant number and safety factor. Show estimated step count, output-frame count and storage range; keep solver step and output cadence separate. Magnusim's `estimate_delta_t` uses minimum-cell volume, sizing and bounding-box fallbacks, and `flow_through_time` estimates domain transit time. Preserve that explanation of inputs and fallback basis, but do not silently impose its speed floor or suggest cube-root volume is sufficient for highly anisotropic cells.

**Acceptance:** analytic uniform meshes give the expected size/velocity scaling; thin/sliver cells receive a conservative metric or an explicit limitation; zero velocity and missing units produce unavailable estimates. User values remain authoritative. Validate emitted adaptive parameters against the selected Kratos runtime and show a convective estimate as guidance, not a universal stability guarantee for implicit, diffusive or structural solvers. **MCP:** read the estimate and explicitly apply chosen case controls through the existing case tools.

### 11. Boundary flow balance and pressure-drop reports — M–L

**Pending.** Add a CFD analysis over selected inlet/outlet SubModelParts: signed volumetric flux `integral(u dot n dA)`, optional mass flux with explicit density, area-weighted pressure, pressure difference between named sections and normalized imbalance with a documented denominator. Repeat over saved times and export CSV. Reuse the integral panel for presentation but introduce oriented surface quadrature; averaging vector components and multiplying by area is not generally a flux integral. Magnusim's function-object writer generates area averages of `U`/`p` and sums face flux `phi`, demonstrating why flow monitoring needs its own semantics.

**Acceptance:** a straight duct balances opposing inlet/outlet fluxes; reversing face orientation flips the sign; overlapping selections, internal faces, missing velocity/density and uncovered samples are reported. A zero-flow denominator yields unavailable relative imbalance, not infinity. Distinguish volumetric from mass flow and only compare compatible pressure quantities. **MCP:** read-only balance/pressure-drop report with optional time-series CSV output; live solver monitors can follow through the existing monitor item.

### 12. Field dimensions and explicit pressure conversion — M–L

**Pending.** Carry dimensions/units from readers through `FieldData`, field selectors, legends, probes, comparison and CSV. Start by retaining the OpenFOAM seven-exponent `dimensions` vector in `openfoamFields.ts`; preserve original values and add an explicit derived-field conversion from kinematic pressure to Pa using documented positive density. Do not infer pressure semantics solely from a field named `p`, and do not rescale Kratos `PRESSURE`, which the fluid case already expresses in Pa. Label gauge/absolute reference separately from units; converting dimensions cannot infer a reference pressure.

**Acceptance:** fixtures for dimensional pressure, kinematic pressure, unknown units and conflicting density give distinct outcomes; repeated display-unit changes leave original samples unchanged. Difference plots reject incompatible dimensions or require an explicit conversion. Conversion/export provenance records density, source units and pressure reference, with variable-density cases requiring a field-aware policy. **MCP:** field metadata and explicit conversion tools share the same rules. Coordinate metadata retention with the format/metadata work already shipped (`MdpaModel.source`, OpenFOAM field `dimensions`) rather than another reader.

### 13. Reusable material presets with provenance — M

**Pending.** Add a small, searchable user-extensible material catalog to the existing problemtype material-law forms. Keep the constitutive law distinct from a preset of parameter values. Each preset carries compatible laws/dimensions, canonical units, reference temperature/conditions, source/version and editable copied values; existing cases retain a snapshot when a library entry changes. Start with independently sourced fluid density/viscosity examples and user-defined entries. Magnusim's `materials/library.py` illustrates searchable records and reference conditions, but a catalog row (including Water) does not prove its full solver workflow is validated.

**Acceptance:** converting kinematic viscosity to dynamic viscosity uses `mu = rho * nu` once; invalid density or incompatible laws cannot generate a case. Imported user presets round-trip, editing a case does not mutate the library, and updating a preset does not alter past runs. **MCP:** list/inspect presets and explicitly apply a snapshot through case material assignment; generated material files remain the existing writer's responsibility.

### 14. Advanced graphical plotting utilities for simulation results and general data — L

**Pending.** Build an interactive scientific plot builder for simulation results and user-supplied tabular data. Extend the existing Plot over Time and Probe Line workflows into reusable analysis panels, without requiring users to write plotting scripts or introducing a general visualization graph. Deliver the following capabilities:

- **Graphical configuration:** select sources, plot types, X/Y columns, series, vector components and grouping through a panel with immediate previews, presets, inline validation and editable configurations. Make source selection and numerical transformations inspectable alongside the plot.
- **Data sources and import:** reuse existing host-side time-history and probe-line extraction; support mesh point/cell fields, selected entities and SubModelParts, analysis tables, multiple runs, and imported CSV/TSV files. Detect delimiters and headers with user correction controls, validate numeric columns, expose missing-value handling, and retain supplied units. Keep point and cell associations explicit; do not combine them through an implicit conversion.
- **Plot families:** provide line and scatter plots, multiple time histories, spatial profiles, XY relationships such as force–displacement, histograms, box plots, grouped bars, heatmaps and contours for suitable two-dimensional data. For scattered samples, require explicit gridding/interpolation choices and disclose unsupported or uncovered regions rather than treating arbitrary samples as a regular surface.
- **Analysis controls:** filter rows and mesh selections, choose vector components or magnitude, configure histogram bins, and calculate grouped statistics. Offer explicitly configured smoothing, regression, derivatives and integration, showing parameters and preserving original samples. Record the origin and meaning of uncertainty/error bars when supplied; do not invent uncertainty from unrelated sample variation.
- **Comparison across files and runs:** overlay compatible quantities and expose reference-series selection, normalization, physical-time matching, tolerances and interpolation. Missing samples break lines; unknown units stay labelled as unknown; incompatible dimensions require explicit resolution using the field-dimensions work in item 12. Record alignment and conversion choices with derived series.
- **Presentation and interaction:** support titles, axis labels, legends, annotations, linear/log scales, axis limits, colors, markers, multi-panel layouts, zoom, hover and series visibility. Link selections and time cursors back to the mesh when source identity exists, preserving the owning run and entity association. Include keyboard access, visible focus and light, dark and high-contrast themes.
- **Persistence and export:** save versioned plot recipes containing source references, column/field mappings, transformations and styling. Reload with actionable diagnostics for missing files, fields or runs. Export PNG, SVG and plotted numeric data as CSV, with source and transformation metadata in the export or an accompanying manifest. Saving or styling plots must not mark mesh geometry dirty.
- **Execution and scale:** collect samples through the shared host-side extraction path rather than replaying the viewport. Provide progress, cancellation, caching and stale-result protection when sources or settings change. Label partial results and display downsampling; preserve full-resolution numerical data for export and statistics. Invalidate cached results when source data or extraction parameters change.
- **Library evaluation:** compare candidate plotting libraries against the required chart types, offline packaging, webview CSP, accessibility, licensing, SVG/PNG fidelity and large-data performance. Select and document the library during this task; no plotting dependency is adopted by this roadmap entry.

**Acceptance:** known-value fixtures validate CSV/TSV parsing, field associations, statistics, transformations and multi-run alignment. Missing/nonfinite samples and invalid log-domain values receive explicit handling rather than misleading lines or silently dropped data. Recipes round-trip with equivalent series and styling; missing-source diagnostics identify the affected series. Exported graphics reproduce the plotted series, numeric exports retain full-resolution values, and any display downsampling is disclosed. Large inputs remain cancellable without freezing the UI or applying stale results. Linked charts preserve entity, time and run ownership across timeline navigation and active-case changes. Check keyboard operation and all supported themes.

**MCP:** share extraction and numerical transformations with headless tools, reusing `mesh_field_series` and `mesh_probe` where applicable. Extend capabilities for general table ingestion and reproducible numerical plot datasets, including source metadata, transformation parameters and partial-result diagnostics. Styling and panel layout remain UI-only; new numerical operations require MCP parity under the delivery rules.

## Tier 3 — Optional companion, advanced geometry and rendering-runtime work

Admission criterion: valuable opportunities needing a new runtime boundary or a larger model change. These remain pending, but are not prerequisites for the direct WASM features above.

### 15. Curved high-order and native polyhedral fidelity — L

**Pending.** Preserve original high-order/polyhedral topology separately from display tessellation, including provenance for picking and field transfer. Investigate meshio++'s curved `tessellate` implementation and gather/scatter maps for visually correct quadratic cells and source-preserving exports. The researched tessellation implementation is Python-only; choose a future WASM binding or optional companion rather than assuming it is already available in JS.

**Acceptance:** curved shared faces remain watertight, high-order node ordering is checked per format, and display subdivision never silently replaces original cells on save. **MCP:** faithful read/write and explicit tessellation/export capabilities; viewport tessellation alone is UI-only.

### 16. Optional Python companion for datasets and surrogate results — L

**Pending.** Explore an explicitly configured external Python companion for meshio++ capabilities outside the WASM package: point budgets, proximity graphs, PMSH (`.pmsh`), Zarr/CAE dataset export, USD time-series export, and PhysicsNeMo inference. Start with exporting existing runs and loading predicted fields with model metadata and comparison metrics; training orchestration is a later scope decision. Do not assume the problemtype Pyodide runtime can host native Python, Torch, or CUDA dependencies.

**Acceptance:** discover companion capabilities and versions, report missing dependencies clearly, stream large datasets, and label predictions separately from solver output. **MCP:** mirror every enabled dataset/export/inference capability through the same optional backend.

### 17. Replace vtk.js with VTK-wasm — L

**Pending — reopened replacement objective.** Replace the vtk.js rendering backend with VTK-wasm through a measured, staged migration. Preserve the **2026-09-18** [spike report](./vtk-wasm-spike.md) and its drop verdict for the tested `@kitware/vtk-wasm@3.0.5` artifact as the historical baseline. Reopening the task does not establish that a newer release fixes its blockers: asynchronous instance-method overhead, broken documented typed-array read-back, and Embind's requirement for broad JavaScript dynamic execution must each be resolved or explicitly accommodated before adoption.

- **Candidate runtime and blocker resolution:** pin and checksum the candidate loader and binary, then reproduce boot, bulk transfer and minimal rendering under the actual packaged webview policy. Measure instance-method scheduling and overhead, verify typed-array read-back, inspect Embind dynamic execution and establish the minimum required CSP. Evaluate upstream fixes, a reproducible custom build or a bounded asynchronous adapter as needed. Treat asynchronous invocation and dynamic-code generation as separate concerns: fixing one does not prove the other is resolved. Document any remaining CSP relaxation and its justification before the default switch.
- **Renderer boundary:** inventory vtk.js imports and runtime assumptions, then introduce an extension-owned interface for scene creation, geometry/field upload, camera operations, layers, picking, rendering, capture and disposal. Keep parsing, model ownership, meshio++ operations and headless numerical analysis independent of the renderer. Define asynchronous completion at this boundary so migration does not rely on synchronous vtk.js behavior leaking into callers.
- **Data conversion and identity:** validate connectivity layout, offsets, cell types, component counts, scalar precision, ID widths and buffer ownership against the selected build. Recheck VTK method signatures rather than mechanically translating vtk.js calls. Cover the spike's cell-array import and point-data setup pitfalls. Preserve original node/entity IDs, source-cell correspondence and independent Elements/Conditions/Geometries namespaces through picking, filtering and derived display geometry. Coordinate high-order/polyhedral display fidelity with item 15 rather than assuming a backend swap supplies it automatically.
- **Scheduling and resource ownership:** batch related scene changes, coalesce render requests, and reject stale frame or document updates. Define when camera updates, picking and capture are complete, including behavior during timeline scrubbing and cancellation. Release VTK objects, canvases, sessions and temporary buffers on document replacement and disposal; test repeated opening/closing and interrupted initialization for leaks.
- **Feature parity:** audit all shipped renderer-dependent features and verify field coloring and ranges, scalar bars, transparency, clipping, thresholds, glyphs, edges, selection/highlighting, probes, annotations, axes, orientation controls, multiple panes, linked cameras and timeline playback. Record unsupported behavior and its resolution explicitly; a minimal successful render is not a parity result.
- **Capture and previously untested gates:** await completed rendering before screenshot or recording reads, including legends and overlays. Verify PNG sequences and WebM output, frame ordering and cancellation. Complete the spike's previously unrun capture, picking-identity and multi-pane gates. Evaluate optional architectures, WebGPU and WebXR separately where relevant; the historical spike did not validate them or translucency/OIT.
- **Offline packaging and reproducibility:** bundle required assets without runtime network fetches, preserve licenses, and document artifact checksums and build inputs. Measure loader size, unpacked binary size, installed-extension size and compressed VSIX cost separately. Verify the selected build's architecture and threading requirements; do not infer a `SharedArrayBuffer` or cross-origin-isolation requirement from unrelated WASM packages. The historical tested artifacts were single-threaded.
- **Staged migration and removal:** retain vtk.js as a temporary fallback while VTK-wasm is available through an explicit experimental selection. Establish representative fixtures and performance budgets against vtk.js before switching the default. Once parity, packaged-runtime and performance gates pass, make VTK-wasm the default, then remove vtk.js dependencies and compatibility code after validating the replacement package. If a blocker remains, keep this task pending and record the evidence and next remediation step.

**Acceptance:** packaged-webview tests demonstrate offline startup under the intended CSP, correct geometry and fields, stable picking identities, ordered frame updates, independent panes, linked cameras, reliable capture timing, cancellation and complete resource disposal. Exercise representative large meshes and repeated document/frame replacement, including missing or failed runtime initialization. Record startup latency, interaction latency, frame time, peak/retained memory and package-size comparisons against vtk.js; define and meet acceptance budgets before the default switch. Validate numerical read-back with known arrays and identity maps, and compare rendered results with appropriate visual tolerances. All shipped features in the parity inventory must have a passing check or an explicitly resolved replacement before vtk.js removal; unresolved blockers keep replacement pending.

**MCP:** preserve renderer-independent numerical tools and their contracts. Any exposed rendering or capture capabilities must use the shared backend interface, completion semantics and accurate capability reporting; adopting VTK-wasm does not automatically expand the headless numerical API.

## Boundaries that still apply

These are product or runtime constraints rather than historical meshio++ WASM blockers:

- **No general ParaView-style visualization graph.** Prefer focused analysis panels and explicit operation recipes; richer batch processing does not require a second visual programming environment.
- **No automatic expensive remeshing on timeline navigation.** Keep deliberate re-apply and explicit series processing.
- **No silent destructive case rewrites.** Directory-based formats (OpenFOAM multi-region and decomposed cases included) need complete companion ownership and fidelity before in-place save is enabled; generated copies remain useful even with a fully working kernel.
- **Timelines follow capability, not reader options.** A static file stays static even when its reader accepts a time-step option; an in-file timeline needs distinct time values that can be enumerated without a full read.
- **Sequence export only targets containers that can represent the series.** Static-grid XDMF is not reinterpreted as a changing-topology container; a topology-changing series is refused rather than written against the first grid.
- **Keep solver ownership and transport honest.** The MCP server starts detached runs and uses log files; it must not claim an exit code after losing observation of the process. Windows graceful stopping needs a separate process/console design, independent of meshio++ integration.
- **Rendering remains a separate runtime concern.** Software-WebGL translucency, recording with a non-preserved drawing buffer, browser codec availability, and webview CSP restrictions are not fixed by a WASM upgrade. The historical VTK-wasm evaluation was dropped — see [`doc/vtk-wasm-spike.md`](./vtk-wasm-spike.md) — and replacement is now reopened as pending in item 17. The existing vtk.js renderer, synchronous render/copy capture and WebM/PNG outputs remain the baseline until the candidate runtime resolves the recorded blockers and passes feature-parity, capture and performance gates.
- **Keep file ownership explicit.** The empty preview remains a launcher until an independently justified session abstraction supports late file binding. Shared runs views continue to project one run store.
- **Quality partitioning needs a different build.** The WebAssembly artifact has no KaHIP (`mesh_capabilities.partitioning` reports it live): `kahip` is refused by name and `auto` resolves to a space-filling-curve cut with no edge-cut minimization. Partition export is shipped on that method; a KaHIP-enabled artifact would only widen `method`.
- **No polyhedral subdivision or agglomeration.** meshio++'s `subdivide` and `agglomerate` produce polyhedral cells that this extension can only decompose back into tetrahedra on read, so there is no topology-conversion workflow they would complete; revisit only with native polyhedral rendering and export (see item 15).
- **Do not advertise Python-only or optional-backend features as bundled WASM capabilities.** Track the binding/runtime needed to deliver them while keeping them eligible for future integration.
