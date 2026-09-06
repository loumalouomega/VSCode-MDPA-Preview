# Roadmap

Candidate features for future Kratos MDPA Preview releases, prioritized by value versus effort given what the extension already ships: a meshio++ WASM kernel and an MMG WASM remesher live in the extension host, a pyodide runtime backs Python problemtypes, a replay-from-base operation history owns every mesh edit, the webview runs a full VTK.js scene with picking and field overlays, and an MCP server mirrors the mesh/problemtype pipeline headless. Many high-value features are cheap precisely because that infrastructure exists.

This page is aspirational, not a commitment — items may be re-ordered, re-scoped, or dropped. Effort is a rough order of magnitude: **S** (a day or two), **M** (roughly a week), **L** (multi-week).

Everything previously shipped is tracked in `CHANGELOG.md`, and `CLAUDE.md` has a per-feature section with the verified implementation details for anything currently in the codebase — this page is for what's **not** built yet, only.

## How this file works

- **Tiers are ordered, and the order is the recommendation.** Each tier states an *admission criterion*; an item that doesn't meet it belongs in a different tier or in Non-goals, not at the top because it sounds exciting. **An empty tier is removed from the file entirely, not kept as a placeholder** — if a new item shows up later that needs a tier no longer listed here (e.g. a defect-shaped correctness/robustness finding, which is always top priority regardless of effort size), recreate that tier at the top rather than burying it under whatever tier happens to be listed first at the time.
- **A closed item is removed from this list entirely**, not struck through — its write-up moves to `CLAUDE.md` (a per-feature section with the verified implementation details) and its history stays in git. Numbering is renumbered to stay consecutive whenever an item closes, so a reference like "item 5" always means the file's current 5th item, not a fossil of one that shipped.
- **Every item states its MCP-parity obligation.** `CLAUDE.md`'s sync rule requires a new mesh or problemtype capability to land in `src/mcp/tools.ts` (plus `src/mcp/register.ts`, `src/test/mcpTools.test.ts` and the tool tables) *in the same change*. The documented exemptions are UI-only surfaces with no headless equivalent — the Flowgraph embedding, What's New, Inspect/Measure. Each item below says which side of that line it falls on, so its estimate includes the tool rather than discovering it late.
- **Items marked *needs live-WASM verification* are listed on the strength of an upstream changelog or a `.d.ts` alone.** meshio++'s TypeScript surface has repeatedly been *necessary but not sufficient*: `.med` export was green in the type definitions and silently unreadable for a year; the wasm `locateFile` variant bug produced a `LinkError` naming neither the file nor the variant. No such item may be *estimated* until it has been probed against the live build; each one names its probe.
- Most items close a **known, documented limitation** of something that already ships, or are a natural next step identified while building it. A rare one is **defect-shaped** — describing behavior that loses data, corrupts state, or strands a session rather than merely lacking a feature. Those belong in the top tier regardless of effort size, queued here rather than filed separately because the fix and the feature are usually the same work.

Queued items name their tracker issue in the heading where one is filed; an
item that has not been filed yet says so rather than implying a link.

## Queued

### Tier 1 — Correctness and data integrity

*Admission: behavior that loses data, writes a file the downstream tool cannot
read, or strands a session. Top tier regardless of effort size, and nothing else
is scheduled ahead of it.*

1. **A re-parse at cursor 0 destroys the redo tail** (**S**, tracker issue not
   yet filed). Apply three operations, undo all three, then let anything
   re-read the file — the watcher firing because a solver appended a step, an
   explicit Reload, or a single VTK timeline arrow-key press. `keepEdits` is
   `reason === "reload" && history.appliedCount() > 0`
   (`mdpaEditorProvider.ts`), and `adoptFrame` branches on
   `appliedCount() === 0` (`vtkEditorProvider.ts`), so both take the `setBase`
   path — which resets `ops` as well as the cursor. The three redoable
   operations are gone, while `editHistory.ts` still renders them as rows
   labelled "Redo up to this step" (`applied = i < state.cursor`), so the UI
   offers a redo that silently does nothing.

   The fix is not merely "test `ops.length` instead of `appliedCount()`": it
   forces a decision this codebase has not taken yet — whether a redo tail is
   *meaningful* against a base that has changed underneath it. `rebase` already
   keeps ops and cursor and drops only the snapshots, so keeping the tail is
   cheap and consistent; what it is not is obviously correct, since those ops
   were recorded against the old base. Found while migrating the providers to
   `CustomEditorProvider` and deliberately left out of that change, because it
   is a behaviour decision rather than a plumbing one. *MCP parity:* none —
   `mesh_transform` replays a recipe and has no cursor.

2. **Re-measure whether OpenFOAM zones cross the reader** (**S**, tracker issue
   not yet filed). The Non-goal below states that `cellZones`/`faceZones`/
   `pointZones` are not read, but **the measurement behind it was confounded**:
   `collectOpenFoamCase` stages exactly five files, so a zone file placed in the
   case never reached the virtual filesystem and the reader could not have seen
   it either way. The wasm carries all three literals. Probe by adding them to
   the staging list and re-reading; cell zones are how a CFD case names its
   material regions, so if they do cross, this is a real capability sitting one
   line away. *MCP parity:* reader-side, so `mesh_info` gains it for free.

3. **The `windows-latest` CI leg proves almost nothing about the stop path**
   (**S**, tracker issue not yet filed). Four tests in `runProcess.test.ts` carry
   `t.skip("posix signal semantics")` / `t.skip("process-group semantics differ
   on win32")`, and the only win32 stop assertion that actually runs there is
   fully mocked. So the leg that exists to catch win32-only regressions in
   process handling exercises none of it. Either write win32-native equivalents
   (`taskkill`-observable behaviour) or say plainly in `ci.yml` what the leg does
   and does not cover. *MCP parity:* none — test infrastructure.

### Tier 2 — Reach

*Admission: makes a pipeline that already works reachable for an input or a user
it currently refuses by name. Nothing here needs new machinery, only the removal
of a boundary.*

4. **Adaptive refinement driven by the error indicator we already compute**
   (**M**, tracker issue not yet filed). `estimateError` attaches an
   `ERROR_MARKED` 0/1 Elemental field with three marking policies — and
   **nothing in the repo consumes it**. The indicator dead-ends in the Field
   panel. Meanwhile the `refine` op is uniform-only (`{levels?}`), so "refine
   where the error is" cannot be expressed. meshio++'s own `refine` takes
   `RefineOptions` (`cells` / `region` / `array`+`compare`+`value`) with
   hanging-node `closure` policies and an `undoGreen` companion, and its
   docblock names this exact composition. Needs the Group A/B decision restated:
   the native refiner keeps entity kinds and ids that the round trip drops, so
   the likely shape is a native selective refine reusing the existing child
   templates, not adopting upstream's mesh. *MCP parity:* a new `refine` param
   on `mesh_transform`.

5. **Reading an OpenFOAM case's time-directory fields** (**M**, tracker issue not
   yet filed). A case currently opens as geometry only — `0/U`, `0/p` and every
   later time directory are not read, because upstream reads none of them. This
   is the request the OpenFOAM reader will generate most: a CFD user opens a case
   to look at a result, not a mesh. Needs a field reader (the files are plain
   OpenFOAM dictionaries, so a native one is tractable) plus a decision about
   whether the time directories drive the timeline. *MCP parity:* reader-side,
   free for `mesh_info`/`mesh_field_series`.

6. **MMG level-set completion** (**S–M**, tracker issue not yet filed). The
   level-set split sets four parameters and leaves the ones that matter for a
   real split unused. **`DPARAM_rmc`** first: it removes the small parasitic
   components a level-set split leaves behind, which is exactly what an
   `sdfDistance` → `levelset` chain produces, and the extension now generates
   those level sets itself. Then `setMultiMat` (keep each material's identity
   across the split instead of collapsing to inside/outside) and
   `setLsBaseReference` ("split only inside these SubModelParts" — the dense ref
   table `remesh.ts` already builds is the input it wants). *MCP parity:* new
   `levelset` params on `mesh_transform`.

7. **Sequence I/O: pack a `vtk_output/` run into one file** (**M**, tracker issue
   not yet filed). meshio++ exposes `sequenceEntries`, `sequenceToTimeseries`,
   `timeseriesToSequence` and a stateful `XdmfTimeSeriesWriter`; the extension
   reads two kinds of timeline and can export neither. "Turn this solve's 200
   `.vtu` files into one `.xdmf`" is a natural companion to the run manager and
   needs no new mesh machinery. *MCP parity:* a new tool — this one is the
   headless case as much as the UI one.

8. **Recover `OpenFoamInfo` so patch names round-trip** (**M**, *needs
   live-WASM verification*). Reading a case recovers patch names by parsing
   `constant/polyMesh/boundary` ourselves, because the generic registry binding
   discards the `OpenFoamInfo` out-parameter. The **write** half takes the same
   struct as an *input*, and the wasm carries per-patch writer diagnostics — so
   the single synthesized `defaultFaces` is a binding limitation, not an upstream
   one. If the binding can be reached, patch names round-trip and the
   "saving in place is refused" Non-goal below becomes arguable. Probe: whether
   any exposed entry point accepts patch metadata on write. *MCP parity:*
   writer-side, free for `mesh_convert`.

### Tier 3 — Polish

*Admission: a shipped feature that works but is visibly rough, or a doc that
misleads. Small, and each is independently shippable.*

9. **The left dock stacks panels invisibly on top of each other** (**S**).
   Quality (320 px), Mesh Size / Spheres / Beams (300 px) and Field integrals
   (420 px) all dock at `top:8 left:8 bottom:8` with the same z-index, and none
   hides the others. Opening Field integrals over Quality covers it completely
   while the Quality button still reads `.active`. Make the dock mutually
   exclusive, or tab it.

10. **`#field-panel` is the one floating panel with no `max-height`** (**S**).
    Every sibling has one. With Contour + Isosurface (one slider per value) +
    Threshold + Deformed active, the panel runs off the bottom of the viewport
    with no scrollbar and the lower controls are unreachable. One CSS rule.

11. **Nine palette commands silently do nothing with no preview open** (**S**).
    `postToActive` discards its result, so Reset Camera, Toggle Node IDs,
    Compute Mesh Quality, Field Visualization, Spheres, Beams, Mesh Size,
    Screenshot and Find Entity are offered from a cold window and produce no
    panel, no error and no clue. The sibling `dispatchMenu` path already shows
    *"Open a mesh preview first…"*. Either add an `enablement` clause or return a
    boolean and reuse that message. Six Advanced/View features also have no
    palette entry at all, against the codebase's own stated policy.

12. **The docs describe a toolbar that no longer exists** (**S**). The window
    tour still lists Node IDs, Grid and the camera button as toolbar buttons and
    names neither the **View ▾** nor the **Advanced ▾** menu, so nine features
    are invisible to a reader and **Inspect** is absent entirely. Same staleness
    in the navigation page. Rewrite as three tables.

13. **Eight guide pages link to an MCP page that does not exist** (**S**). Six
    point at `/guide/development#mcp-server` and two at `getting-started`;
    neither page mentions the MCP server, and the 21-tool table lives only in
    `README.md`. Port it to a `doc/guide/mcp.md`, add it to the nav, repoint the
    links.

14. **Three analysis panels can compute but not export** (**S**). Data table
    (CSV + XLSX) and Plot over time (CSV) can; Mesh Quality, Mesh Size and Field
    integrals cannot — yet `mesh_quality` and `mesh_field_integrate` already
    return the same numbers over MCP, so the computation is serialisable and only
    the in-editor route is missing. Field integrals is the sharp case: a real
    per-SubModelPart table that a user will want in a spreadsheet. Reuse
    `csvChunks` / `writeXlsx`.

15. **`.vtm` reads but never writes** (**S–M**). Open a multiblock file, get one
    layer per block, reorganize them — and there is no way to save it as `.vtm`;
    the only round trip flattens to `.vtu`, losing the block structure the
    feature exists for. `.vti`/`.vts`/`.vtr` are one-way doors too. A `.vtm`
    writer is one index file plus one `.vtu` per layer, and the companion
    machinery already exists. *MCP parity:* free via `mesh_convert`.

## Non-goals / known constraints

Decisions already taken and recorded, listed here so they are not re-proposed:

- **Decimate** (quadric-error surface simplification) — the one meshio++ operation that was selected and then deliberately excluded: it rewrites topology with no JS-reachable back-map, drops `side` regions, forces all-triangle output, refuses volume meshes, and blends every field including integer tags as float64. Revisitable only as a "generate a decimated surface **copy**" export, where lossiness is the stated intent.
- **Adopting meshio++'s returned mesh** as the model for any operation — the Group A/B split. The round-trip loses entity kinds (Elements vs Conditions vs Geometries), property ids and every original entity id, so meshio++ is used as an *oracle* (coordinates, a permutation, a per-cell label) or the operation is written natively. Two of the losses that originally motivated the split have since closed; the remaining three are sufficient on their own.
- **Slice and isosurface as real meshes**, and meshio++'s `interpolate` / `diff` / `convertSurfaceOps` — researched and left out: no viewer use case that Clip, the Field panel's iso overlay, or `extractSubModelPart` does not already cover.
- **A graceful rung for stopping a run on Windows** — on POSIX a stop escalates SIGINT → SIGTERM → SIGKILL, and the first rung is the point: python turns SIGINT into `KeyboardInterrupt`, so finalizers run and the last VTK result file is closed rather than truncated. On Windows both `RunHandle.stop` and `stopPid` go straight to TerminateProcess. After a shipped-then-reverted attempt this is recorded as a platform constraint rather than a deprioritized feature, because **both halves of the mechanism turn out to be unavailable, not merely unreliable**. (1) *Node cannot request the scoping.* `child_process.spawn` exposes only `detached` and `windowsHide` — there is no creation-flag passthrough — and in Win32 `CREATE_NEW_CONSOLE` and `DETACHED_PROCESS` are mutually exclusive, so no combination of those two booleans yields "own console, own group". `detached: true` (libuv's `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`) makes the child a group leader but leaves it with **no console at all**, and a process without a console cannot receive a console control event. A `cmd.exe /c start` wrapper does create a new console, but `spawn` then returns **cmd's pid, not the solver's** — which breaks the load-bearing invariant of the run design (`RunSidecar` is deliberately process-identifying, and `case_stop`, `reconcileStatus`, `isPidAlive` and `foreignLiveRun` all key on that pid) besides reintroducing the very `cmd.exe` layer the revert blamed. (2) *The signal would be the wrong one anyway.* `CTRL_BREAK_EVENT` reaches CPython as `SIGBREAK`, whose default disposition is **not** `KeyboardInterrupt` (that is `CTRL_C_EVENT` → `SIGINT`); the reverted attempt's fixture asserted `except KeyboardInterrupt` and **never actually ran**, because CI hung in `mcpTools.test.ts` first. `CTRL_C_EVENT` cannot be scoped to a process group at all — it broadcasts, which is what froze that CI job on a `Terminate batch job (Y/N)?` prompt, and is a correctness risk for a real user's console session too, not just for CI. The only remaining route is cooperation from the Python side (a `SIGBREAK` handler in the generated `MainKratos.py`), which collides with the non-goal above about keeping that file standard. The consequence is already contained rather than open: a killed run's final step may be truncated, so "open results" for a non-`finished` run targets the last *complete* step (`latestResultFile(names, {excludeNewest: true})`), and both the Stop dialog and the `case_stop` tool description say Windows terminates immediately rather than implying a clean shutdown. History: added in `3e29a37`, reverted in `6947c5c`; the `windows-latest` CI leg stays.
- **Everything in an OpenFOAM case except `constant/polyMesh/`** — the reader takes the mesh and nothing else, and each omission was measured rather than assumed. **Time-directory fields** (`0/U`, `0/p`) are not read by upstream at all, so a case opens as geometry; this is the request the feature will generate most, and it needs a field reader upstream, not staging work here. **Zones** (`cellZones`/`faceZones`/`pointZones`) are not read — but see the queued item: the measurement that produced this claim was **confounded**, so the claim is currently unproven rather than established. **Moving meshes** (`<time>/polyMesh`), **multi-region** cases (`constant/<region>/polyMesh`) and **decomposed** cases (`processor*/`) all read only the top-level `constant/polyMesh`. Each of the four is detected with one `existsSync` and reported as a diagnostic, because a mesh that quietly lacks half a case is worse than one that says what it left behind.
- **Splitting an OpenFOAM boundary block per patch** — the faces arrive as one `quad`/`triangle` block and stay that way; the patch names live in the SubModelPart tree, which is where every other format's grouping lives too. Splitting would fragment the rendering into one actor per patch for no gain.
- **Packing an OpenFOAM case into a problem archive** — `collectProblemFiles` globs one flat directory by stem, so it would archive the 0-byte `.foam` marker as "the mesh" and leave `constant/polyMesh/` behind, producing a zip that unpacks to nothing. `problem_pack` refuses by name and points at exporting to `.mdpa`/`.vtu` first. Teaching the collector the tree is possible — `isSafeEntryName` already permits `constant/polyMesh/points` as a zip entry — but needs matching unpack-side work.
- **Saving an OpenFOAM case in place** — `.foam` is both readable and writable, but the file the user opened is a 0-byte marker while the data is in siblings, so "overwrite the file you opened" would silently replace the real `constant/polyMesh/`. Our writer also synthesizes a single `defaultFaces` patch, so a rewrite collapses every real patch name and drops the zones. Save refuses and points at Export / Save As; `serializeToPath` backstops every other write path by comparing **directories**, since exporting to `<case>/other.foam` rewrites the same polyMesh.
- **meshio++'s unexposed side channels and masks** — several capabilities exist in the C++ core and are not bound to JS, so they cannot be reached from here at all and are not a backlog item. `smooth`'s frozen-node mask is documented upstream as "not exposed here, as on the other flat bindings". `MdpaInfo` (which constructs a lenient `.mdpa` read skipped) is moot, since `.mdpa` is parsed natively and deliberately absent from the reader keys. `MedInfo` carries the field units and the list of constructs a lenient MED read dropped — worth recovering if the binding ever appears, which is why the lenient-read diagnostic says only that a lenient read was needed. `OpenFoamInfo` is the exception that IS queued, because its write half takes the struct as an input.
- **Writing `.msh` as ansys/freefem, or `.inp` as ansysinp, from the UI** — the extension→format map picks one writer per extension (gmsh, abaqus), and the alternatives are reachable only through the MCP `mesh_convert` tool's explicit `outputFormat`. So an agent can write an ANSYS `.msh` and a user cannot. Recorded rather than queued: the fix is a second dimension in the Export menu (format, then flavour) for three entries nobody has asked for, and `outputFormat` already covers the scripted case.
- **KaHIP partitioning** — not in the WASM build. `"kahip"` throws by name and `"auto"` resolves to the Hilbert space-filling curve, so partitions balance by cell count, not edge cut. This is an upstream build constraint, not a deprioritized feature.
- **DOLFIN `.xml` export** — the writer raises on anything but triangles and tetrahedra (correct for the format, which is simplicial) and scatters a sibling file per data array. **tetgen and EnSight export** — each writes a *pair* of files rather than one. All three re-measured at meshio++ 9.22.0 and unchanged. (**OpenFOAM export** was in this list for the same class of reason; it shipped with the 9.22.0 upgrade once `MeshWriteResult.companions` became directory-aware.)
- **SubModelParts surviving a gmsh export** — gmsh 4.1 writes no `$PhysicalNames` at all for a mesh with no `gmsh:dim_tags`, so `.msh` export carries no groups. An upstream gap, **re-measured at meshio++ 9.22.0 and still open**; MED and Abaqus do carry groups out, so use one of those when the grouping has to survive.
- **Correct translucency under a software WebGL2 rasterizer** — this vtk.js version routes any actor with opacity < 1 through `vtkOrderIndependentTranslucentPass` unconditionally, and under a software rasterizer (headless CI, or a remote/WSL session with no GPU passthrough) the composite can render fully opaque instead of blending. `setUseDepthPeeling` / `setMaximumNumberOfPeels` / `setOcclusionRatio` are vestigial on this version and are deliberately **not** called, so as not to imply they do something.
- **Polyhedral cells as a drawable block type** — a general polyhedron has no VTK cell type and no Kratos element, so it is decomposed into tetrahedra on READ instead (`polyhedronDecompose.ts`), fanning each face about its corner average so the volume is exact even for non-planar faces. The original cell identity does not survive, which is why nothing writes one back: an `MdpaModel` has no polyhedron type, so `modelToMeshio` cannot emit one and meshio++'s polyhedral writers are unreachable from here by construction.
- **A "failed" state for an operation in the history** — there is nothing to render it from. `applyOpAsync` never throws for a data problem: a genuine failure and a legitimate nothing-to-do both return `{noop: true, message}`, so the history shows `no effect` with the operation's own message rather than inventing a distinction the layer below cannot make. Revisitable only if the op layer ever grows a real error channel.
- **Re-running the remeshing operations on every timeline step** — a frame change rebases the history and replays it with `skipAsyncOps`, so MMG remesh, level-set split and the meshio++ oracles are marked `skipped` instead of run. Replaying them per frame was measured against the obvious alternative and rejected: a 30-second remesh firing on every arrow-key press makes the timeline unusable. The **Re-apply** button runs them deliberately.
- **Enforcing (refusing) the SubModelPart parent/child subset rule** — considered and rejected in favour of *maintaining* it. Kratos requires a child's entities to be a subset of its parent's and keeps that true itself rather than validating it: `ModelPart::AddNode` on a sub model part calls the parent's `AddNode` first, and `RemoveNode` cascades into every sub model part. `subModelPartTree.ts` mirrors both, so the invariant holds by construction and the obvious action never fails with a "repair the ancestors first" error. The propagated counts are reported per operation so it is not silent.
- **meshio++'s N-ary `merge()`** as the engine behind Merge mesh — available and tempting, and rejected for the same reason as the Group A/B split above: the round-trip loses entity kinds, property ids and every original id, which is precisely what makes merging hard. `mergeMesh.ts` offsets and appends natively instead, per id space.
- **Carrying a merged-in file's `Properties` into the combined mesh** — still blocked, but the blocker MOVED when the beam work landed and it is worth being precise about where it now sits. The Properties *value* parser now exists (`propertiesParser.ts`), so the values are on the model; what remains is the **writer**, which emits `Properties` by copying the base file's source text verbatim (`mdpaWriter.ts`'s `VERBATIM_BLOCKS`). An incoming file's Properties therefore cannot reach the output regardless of what the model holds. Unblocking it means teaching the writer to emit Properties from parsed values — which is precisely what today's lossless round-trip is built on not doing, so it is a deliberate piece of work rather than a small follow-up. `Constraints` has since made that move (parsed on read, emitted from the model on write), so the shape is no longer hypothetical; what makes Properties harder is that a merged-in file's ids must be *rebased* against the base's table, not merely carried. The merge continues to report the loss and to name the property ids it leaves resolving against the base's Properties.
- **An operation that edits a beam's `CROSS_AREA`** — considered while shipping the beam rendering and deliberately not built, unlike the spheres' `setElementRadius`. The two cases look alike and are not: an Exodus `SPHERE` file has no radius *anywhere*, so writing one as an Elemental field is the only home it has, whereas a beam's section already has a canonical home in the `Properties` block. An op could only write an Elemental `CROSS_AREA`, creating a second source of truth that Kratos itself would not read — and writing into `Properties` needs the non-verbatim writer above. The panel's constant stays a viewing aid, and the section is read-only.
- **A general, user-composable visualization pipeline** (ParaView-style filter graph) — considered and rejected as a shape, not merely deferred. The fixed Field-panel modes plus the Mesh Modification operations cover the cases this extension exists for, and the operation queue (`webview/opQueue.ts`, `OperationHistory.applyMany`) is the bounded version of the same want: chain the *operations*, not the *visualization*.
- **mp4 / H.264 recordings** — `MediaRecorder` cannot reliably produce H.264 in Electron (measured: `isTypeSupported("video/mp4;codecs=h264")` is **false** in the Chromium the harness runs, and the same engine backs VS Code), so it is not offered rather than offered and broken. The PNG-frame output is the route to mp4: the recorder prints the exact `ffmpeg -i <stem>_%04d.png` line when it saves.
- **Sampling the WebGL canvas on a timer to record** — vtk.js requests its context with `preserveDrawingBuffer: false`, so the drawing buffer is valid only until the task that rendered it yields. Measured, not reasoned: a `drawImage(vtkCanvas)` in the same task as `render()` copies ~40k lit pixels and the identical call one task later copies **zero**. Recording therefore renders and copies back-to-back into an offscreen 2D canvas, which is also what keeps the loading overlay (`#app { display: none }` on every frame parse) from blanking a capture. Anything that reintroduces an `await` between `render()` and the copy will silently record black frames.
- **`fetch()` on a blob URL in the webview** — the CSP is `default-src 'none'` with no `connect-src`, so the idiomatic `fetch(URL.createObjectURL(blob))` is blocked outright. Use `blob.arrayBuffer()`. (There is no `media-src` either, so a `<video>` preview of a recording inside the webview is impossible; the bytes go to the host and become a file.)
- **Parsing solver stdout for progress** — the generated `MainKratos.py` contains no `print()` of its own, so every line is upstream Kratos `Logger` output in a format this extension does not control, and its flush hook is time-based (10 s, OpenMP only) so a parsed progress bar visibly stalls and then jumps. Adding our own machine-readable sentinel lines was considered and rejected for a second reason: that file is regenerated on every Generate with no prompt, and people copy it into their own workflows and paste it into Kratos issue reports, so a silently non-standard `MainKratos.py` is a support tax. Progress is derived from `vtk_output/` instead, which works identically for a tracked run, a terminal run and an adopted orphan. Revisitable if upstream ever grows a first-class machine-readable log mode.
- **A run status inside `problem_pack`** — `problemFiles.ts` builds a fixed allowlist, so `<stem>.kratosrun.json` is excluded by construction, and that is the right answer rather than an oversight: a run status is not part of a problem definition, and a stale `"running"` unpacked on another machine would be actively misleading.
- **Per-run output directories** — `output_path` is hardcoded `"vtk_output"` in the generated ProjectParameters for GiD parity, so two cases in one folder genuinely share it. The run manager *reports* that collision (a modal when the same case is already running, a warning naming the other mesh when a different one is) rather than changing the generated output layout for everyone.
- **The MCP server owning a solver process** — `case_run` starts one, it never owns it. stdout is the JSON-RPC transport and the process exits with its stdio client, so the child is always spawned detached with its output appended to `<stem>.kratosrun.log`. The consequence is deliberate and not a hole: once the server exits, nothing is left to record how the run ended, and `case_status` reports `orphaned` rather than inventing an exit code. Recording it anyway would need a node supervisor process between the two — a new esbuild entry — which is the shape to revisit if the exit code of a long detached run ever has to be recoverable.
- **Blocking `case_run` until a real solve finishes** — there is no server-side timeout anywhere, so the only limit is the *client's* request timeout, a number the server cannot observe. `waitSeconds` therefore defaults to 10 s and expiry is a **handoff, not an error**: it returns `running` with the pid and log path. A budget tuned just under the typical 60 s default was considered and rejected — it would still blow a client configured at 30 s, and would do it while believing itself safe.
- **Streaming solver output back through MCP** — the `run()` wrapper in `register.ts` is strictly one-await-one-JSON-blob with no progress token, and stdout is the transport. The log file is the answer, and `RunManager.showLog` already opens it.
- **MCP tools for UI-only surfaces** — the Flowgraph embedding (an interactive iframe editor with no headless equivalent), What's New, Inspect/Measure, the **split view** (per-pane field settings and clip included) and the **Kratos sidebar** (its activity-bar container, welcome buttons, Recent Meshes list and empty-preview launcher) are exempt from the parity rule by design. Recorded here so the exemption is not mistaken for an oversight and re-filed as a gap.
- **Per-pane layer visibility** in the split view — the camera, the field settings and the clip plane are per-pane; which layers exist and their visibility, colour, opacity and display mode are not, and that is a decision rather than a stopping point. The outline is one DOM tree with one checkbox per layer, so a per-pane version needs a second addressing dimension through every row and every handler, and the want the split view exists for was different *fields*, not different *layer sets*. The same reasoning keeps the analysis overlays (mesh size, spheres, beams, face normals) global: one panel each, one answer each.
- **Burning the Field panel's legend into a split-view screenshot** — `compositeLegend` draws one legend at a fixed corner of the whole capture, and panes can now colour by different fields, so that legend would be describing panes it does not belong to. The burn-in is therefore a single-pane affordance and the in-scene scalar bar (`Show scalar bar in scene`) is the split-view route: it is per-pane and already inside the WebGL capture. Revisitable as one legend drawn inside each pane's own rect, which is a different function rather than a parameter.
- **A document-less editing session** behind the empty preview — the standalone panel opened from the sidebar is a *launcher shell*, not a second `PreviewSession`. Each provider's `resolveCustomEditor` is a ~600-line closure over `document.uri.fsPath` (the file watcher, `OperationHistory`, `opRunner`, `PtController`, flowgraph and timeline state all bind to it) with no "load a file into this existing panel" entry point to reuse, so making the panel a real session means rewriting both providers around an optional path — in a repo with no VS Code integration harness to catch what that breaks. The shell therefore hands off to the ordinary custom editor and closes. Revisitable only if something else independently wants late `fsPath` binding.
- **Adopting a picked file into the empty panel** rather than disposing it — the same decision from the other side, and the reason the panel closes instead of staying. `openMesh()` opens a *new* custom-editor tab, so a shell that stayed would sit behind the real preview as a second, permanently empty tab that looks like a bug. Closing it is what makes "Open Empty Preview" read as a launcher rather than a broken window.
- **Per-pane / per-container layer sets for "Kratos Runs"** — it is contributed twice, as `kratos.runs` (Explorer) and `kratos.runsSidebar` (Kratos container), because VS Code view ids are globally unique and one view cannot sit in two containers. Both are driven by ONE `RunTreeProvider`, so there is no second source of truth; the only cost is that every `menus` entry must name both ids, which `src/test/packageContributes.test.ts` asserts.
- **Most of meshio++'s operation surface** — an audit of the installed build's
  `index.d.ts` found 54 exported functions this extension never calls, and the
  large majority are unused **on purpose** rather than pending: `clean`,
  `transform`, `interpolate`, `slice`, `isosurface`, `convertCells`, `stats`,
  `attachQuality`, `extractSurface`, `extractSkin`, `merge`, `refine`,
  `cropBbox` / `cropPlane` and `dataCalc` all duplicate something this
  extension does natively and better, because the native version keeps entity
  kinds, property ids and original ids that the round trip drops — the Group A/B
  split above, applied per function. `decimate` has its own entry. The list is
   recorded here so a future audit does not read it as a backlog. The genuinely
   interesting remainder is small: `partition`'s ghost layers, which the
   current `partitionLabels` oracle cannot express.
