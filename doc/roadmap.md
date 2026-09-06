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
   yet filed; **attempted and reverted once, see below**). On POSIX a stop
   escalates SIGINT → SIGTERM → SIGKILL, and the first rung is the whole
   point: python turns SIGINT into `KeyboardInterrupt`, so finalizers run and
   the last VTK result file is closed rather than truncated. On Windows both
   `RunHandle.stop` and `stopPid` (`runProcess.ts`) go straight to
   TerminateProcess — no graceful rung — so exactly the truncation the ladder
   exists to prevent is what a Windows user gets today.

   **Attempt 1 (shipped, then reverted on first real Windows CI run):**
   `sendCtrlBreak` P/Invoked `GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT)`
   through inbox `powershell.exe` — no compiled helper, no binary to ship —
   and both ladders tried it before terminating. The experiment's own admission
   criterion was a win32-only real-process test (`runProcess.test.ts`, a
   python `try/finally` marker): green meant the rung existed in practice, red
   meant falling back to the documented terminate. What actually happened on
   `windows-latest` CI was neither: the earlier, non-python `case_run`/
   `case_stop` MCP tests (plain Node.js child fixtures, exercising the same
   `stopPid` ladder) never reached that test at all — the CTRL_BREAK_EVENT
   broadcast escaped its intended process group under the nested
   pwsh→cmd.exe(npm.cmd)→node console chain a `run:` step spawns, and froze
   the whole job on a `Terminate batch job (Y/N)?` prompt instead of failing
   soft to the kill rung. That is worse than the anticipated failure mode
   (silently ineffective) — a stray Ctrl+Break can disrupt unrelated
   console-attached processes, which is a correctness risk for a real user's
   terminal session too, not just for CI. Reverted to plain terminate; the
   `windows-latest` CI leg stays (`ubuntu-latest` plus `windows-latest`, with
   `setup-python` still available for a future attempt).

   A viable next attempt would need to prove delivery is reliably *scoped*
   before trying it in CI again — e.g. giving the target its own console
   (`CREATE_NEW_CONSOLE`/`windowsHide`) so a sender that does not share it can
   only ever fail closed, never broadcast. Until then this stays open.
   *MCP parity:* `case_stop` calls the same `stopPid`, so one change fixes both
   surfaces.

### Tier 2 — Reach

*Admission: makes a pipeline that already works reachable for an input or a user
it currently refuses by name. Nothing here needs new machinery, only the removal
of a boundary.*

2. **A header summary in the editor preview** (**S**, tracker issue not yet
   filed). The `mesh_info metadataOnly` fast path proved the core and measured
   the table: `.xdmf`/`.xmf`, `.msh` and the GiD `.post.*` set stay header-only
   (`HEADER_METADATA_EXTENSIONS`), everything else falls back to a full read.
   The editor half is still missing: above a size threshold, show the header —
   counts, block shapes, data-array names — with an explicit open-full-mesh
   action instead of parsing a file too large to preview. Needs a `modelSummary`
   webview message and summary UI (the Information panel is built from a full
   model today), so it is new surface, not new machinery. *MCP parity:*
   already shipped (`metadataOnly`); no new tool.

3. **Reading an OpenFOAM case** (**M**, tracker issue not yet filed). Export
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
   interesting remainder is small and is queued: the header summary (item 2),
   and `partition`'s ghost layers, which the current `partitionLabels` oracle
   cannot express.
