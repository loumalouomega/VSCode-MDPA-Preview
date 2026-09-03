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

1. **A graceful rung for stopping a run on Windows** (**M**, tracker issue not
   yet filed). On POSIX a stop escalates SIGINT → SIGTERM → SIGKILL, and the
   first rung is the whole point: python turns SIGINT into `KeyboardInterrupt`,
   so finalizers run and the last VTK result file is closed rather than
   truncated. On Windows both `RunHandle.stop` and `stopPid` (`runProcess.ts`)
   go **straight to SIGKILL**, so exactly the truncation the ladder exists to
   prevent is what a Windows user gets — and `register.ts`'s `case_stop`
   description already says so rather than pretending otherwise.

   The honest blocker is that Node maps every signal to `TerminateProcess` on
   Windows, so `child.kill` cannot express this at all: the shape is
   `CREATE_NEW_PROCESS_GROUP` at spawn plus `GenerateConsoleCtrlEvent(
   CTRL_BREAK_EVENT)` against the group, which python does handle. That needs
   something outside `child_process` — a small helper, or `taskkill` accepted as
   a non-graceful fallback with the message saying which one ran.

   It is also the one item here with **no test coverage to build on**: the four
   `t.skip("process-group semantics differ on win32")` guards in
   `runProcess.test.ts` are the test-side shadow of the same gap, and CI is
   `ubuntu-latest` only. Budget a Windows leg before budgeting the fix.
   *MCP parity:* `case_stop` calls the same `stopPid`, so one change fixes both
   surfaces.

### Tier 2 — Remeshing depth

*Admission: uses capability already compiled into the bundled MMG WASM. Adds no
dependency and no bytes to the `.vsix` — the ceiling is what MMG already
exposes and this extension does not call.*

Every item in this tier is ***needs live-WASM verification***: they were found
by reading `@loumalouomega/mmg-wasm`'s `dist/mmg.d.ts`, which has been necessary
but not sufficient before. Each names its probe.

2. **Freeze entities across a remesh** (**M**, tracker issue not yet filed).
   `setRequiredVertex`, `setRequiredTriangle(s)`, `setRequiredEdge`,
   `setCorner` and `setRidge` are all in the WASM surface and **none are
   called**, so "remesh the bulk but leave this interface exactly as it is" is
   not expressible today — a routine ask for a coupled or contact surface that
   another code owns. The addressing this needs already exists: `remesh.ts`
   encodes each cell's (block, SubModelPart-path) signature into a dense MMG
   ref precisely so the harvest can regroup, and a per-part "required" flag
   rides the same table.

   *Probe:* mark one SubModelPart's triangles required in
   `src/test/remesh.test.ts` and assert their node coordinates are bit-identical
   after `remeshModel`, while the rest of the mesh changes.
   *MCP parity:* a new `remesh` parameter, so `OPS_HELP` in `register.ts` and
   nothing else.

3. **Per-SubModelPart `hmin` / `hmax` / `hausd`** (**S–M**, tracker issue not
   yet filed) via `setLocalParameter(mesh, sol, typ, ref, hmin, hmax, hausd)`.
   The `expr` mode's `sizeParts` already swaps the size *expression* per part,
   but an expression sets a per-node metric and cannot express a per-part
   **bound** — so "nothing smaller than 2 mm in the boundary layer, whatever the
   formula says" has no spelling. The refs are the same ones item 2 uses, so the
   two share their plumbing and are worth sequencing together.

   *Probe:* a two-part fixture with a distinct `hmin` per ref; assert the two
   parts' edge-length distributions separate, rather than that the call returns
   success. *MCP parity:* `OPS_HELP` only.

4. **Anisotropic remeshing driven by the Hessian field that already exists**
   (**L**, tracker issue not yet filed). This is the largest piece of
   already-paid-for capability found: `hessianField.ts` computes exactly the
   tensor that metric-based anisotropic adaptation consumes, and today it has
   **no consumer at all** — it produces a nine-component nodal field a user can
   look at. Meanwhile `remesh.ts` only ever calls `setScalarSols`, while
   `setTensorSol`, `setTensorSols`, `getTensorSol(s)`, `IPARAM_anisosize` and
   `computeEigenv` sit unused, so every remesh this extension can run is
   isotropic.

   The pairing is the point: `fieldHessian` then `remesh{mode:"aniso"}` is
   "adapt the mesh to the curvature of this solution", the standard error-driven
   workflow, with both ends already built and only the metric assembly missing.
   Two things it must state rather than discover: the Hessian is a composition
   of two gradients and is exact only for an at-most-linear field, so the metric
   is an estimate whose quality depends on the mesh it was computed on; and MMG
   wants a *positive-definite* metric, so the eigenvalue clamping
   (|λ| bounded by `hmin`/`hmax`) is part of the operation, not a detail.

   *Probe:* a boundary-layer field whose Hessian is strongly directional; assert
   the output carries cells whose aspect ratios sit well outside
   `meshQuality.ts`'s isotropic band, since a call that silently ignores the
   tensor would otherwise look like a success.
   *MCP parity:* a new `remesh` mode — `OPS_HELP` plus `opRecordFromMessage`.

### Tier 3 — Reach

*Admission: makes a pipeline that already works reachable for an input or a user
it currently refuses by name. Nothing here needs new machinery, only the removal
of a boundary.*

5. **A header-only mesh preview** (**S–M**, tracker issue not yet filed).
   `readMetadata` is already called on every in-file-timeline format, and
   roughly ninety percent of its result is thrown away: `meshio.ts` narrows it
   to `{ timeValues }`, while upstream's `MeshMetadata` also carries
   `numPoints`, `numCells`, `cellBlocks[]`, `pointDataNames` /
   `cellDataNames` / `fieldDataNames`, the resolved `format`, `regions[]` and
   `bboxMin` / `bboxMax`. That is the entire Information panel and most of the
   outline, available without reading the mesh — which is the difference between
   a thirty-second open and an instant one on a file too large to preview.

   ***Needs live-WASM verification***, and its probe is the item's actual risk
   rather than a formality: `MeshMetadata` carries `fellBackToFullRead`, and
   Exodus's metadata reader is already known to set it. *Probe:* assert every
   field is populated **and** `fellBackToFullRead` is false for the committed
   Exodus, MED and CGNS fixtures — a format that falls back makes the whole
   feature no cheaper than parsing, so the answer decides which formats can
   offer it at all. *MCP parity:* a `mesh_info` fast path (a `metadataOnly`
   argument, or a documented degradation when the reader falls back).

6. **Kratos case generation for a mesh that is not `.mdpa`** (**M**, tracker
   issue not yet filed). `case_generate` and `case_run` refuse by name
   (`"needs a .mdpa mesh (Kratos input format)"`), and the editor half is
   stricter still: `PtController` is constructed only by `mdpaEditorProvider`,
   so opening a `.msh`, `.vtu` or `.med` shows no Problemtype section at all —
   not a disabled one, none. Yet the extension already reads 49 formats and
   already writes an adapted `<stem>_case.mdpa` on Generate whenever
   `meshAdapt.ts` renames a block, so the conversion this needs is the step the
   flow performs anyway.

   The shape is therefore "always write the case mesh, converting when the
   source is not already `.mdpa`", and `caseFile.ts` anticipates it in a comment
   already. What it must decide out loud is what happens to a source whose
   SubModelParts did not survive its own format — the conditions and materials
   are assigned *by* SubModelPart, so a mesh that arrives with none produces a
   case with nothing to attach to, and saying that at Generate time is better
   than a solver error. *MCP parity:* relaxes an existing refusal in two tools;
   no new tool.

7. **Reading an OpenFOAM case** (**M**, tracker issue not yet filed). Export
   shipped with the meshio++ 9.20.0 upgrade, once `MeshWriteResult.companions`
   became directory-aware. Reading did not, and the blocker is named and
   contained: `readMeshioModel` stages a single file — or a known *pair*, which
   is all `meshioSiblingNames` can express — into a flat MEMFS, whereas a case
   is a `constant/polyMesh/` **tree**. The write path already harvests a
   directory recursively for exactly this format, so the asymmetry is one
   direction of one helper, not a missing capability.

   Worth noting why it is not merely symmetric: the writer knows the tree it
   just produced, while the reader must decide what to stage from a directory
   the user picked, and an OpenFOAM case directory also contains time-step
   directories that are not mesh at all. *MCP parity:* reader-side, so
   `mesh_info` / `mesh_convert` / `mesh_transform` gain it for free — but
   `SUPPORTED_MESH_EXTENSIONS` gates the Open dialog and every tool, and a
   directory is not an extension, so the entry point needs a decision of its own.

## Non-goals / known constraints

Decisions already taken and recorded, listed here so they are not re-proposed:

- **Decimate** (quadric-error surface simplification) — the one meshio++ operation that was selected and then deliberately excluded: it rewrites topology with no JS-reachable back-map, drops `side` regions, forces all-triangle output, refuses volume meshes, and blends every field including integer tags as float64. Revisitable only as a "generate a decimated surface **copy**" export, where lossiness is the stated intent.
- **Adopting meshio++'s returned mesh** as the model for any operation — the Group A/B split. The round-trip loses entity kinds (Elements vs Conditions vs Geometries), property ids and every original entity id, so meshio++ is used as an *oracle* (coordinates, a permutation, a per-cell label) or the operation is written natively. Two of the losses that originally motivated the split have since closed; the remaining three are sufficient on their own.
- **Slice and isosurface as real meshes**, and meshio++'s `interpolate` / `diff` / `convertSurfaceOps` — researched and left out: no viewer use case that Clip, the Field panel's iso overlay, or `extractSubModelPart` does not already cover.
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
- **MCP tools for UI-only surfaces** — the Flowgraph embedding (an interactive iframe editor with no headless equivalent), What's New, Inspect/Measure and the **split view** (per-pane field settings and clip included) are exempt from the parity rule by design. Recorded here so the exemption is not mistaken for an oversight and re-filed as a gap.
- **Per-pane layer visibility** in the split view — the camera, the field settings and the clip plane are per-pane; which layers exist and their visibility, colour, opacity and display mode are not, and that is a decision rather than a stopping point. The outline is one DOM tree with one checkbox per layer, so a per-pane version needs a second addressing dimension through every row and every handler, and the want the split view exists for was different *fields*, not different *layer sets*. The same reasoning keeps the analysis overlays (mesh size, spheres, beams, face normals) global: one panel each, one answer each.
- **Burning the Field panel's legend into a split-view screenshot** — `compositeLegend` draws one legend at a fixed corner of the whole capture, and panes can now colour by different fields, so that legend would be describing panes it does not belong to. The burn-in is therefore a single-pane affordance and the in-scene scalar bar (`Show scalar bar in scene`) is the split-view route: it is per-pane and already inside the WebGL capture. Revisitable as one legend drawn inside each pane's own rect, which is a different function rather than a parameter.
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
  interesting remainder is small and is queued: the metadata reader (item 5),
  and `partition`'s ghost layers, which the current `partitionLabels` oracle
  cannot express.
