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

Every item below is backed by an open issue in the tracker, linked from its heading.

## Queued

### Tier 1 — The editing model: mesh and model-part tree

*Admission: extends the `OpRecord` surface users already have, reusing the replay-from-base history rather than adding a second write path.*

1. **Combine meshes, with renumbering** (**M**, [#25](https://github.com/loumalouomega/VSCode-MDPA-Preview/issues/25)). `mergeModels(base, other, params)` (`src/parser/mergeMesh.ts`) already merges two meshes and is reachable as the async `mergeMesh` op with a file picker. The issue's "with reordering" is precisely the part that does not exist, and four fidelity gaps sit alongside it:

   - **Binary only.** The record is `{op: "mergeMesh", path: string}` — one path. N files means N sequential ops, each re-offsetting from scratch and each creating its own wrapper SubModelPart, so combining five meshes produces five nested-looking groups and five passes of welding.
   - **No renumbering.** Offsets are max-id based (`nodeOffset = maxId(base.nodeIds)`), so a sparse or gappy base leaves permanent holes in the id space and every merge widens them. `reorderMesh.ts` already exists for *spatial* reordering (RCM, Morton, Hilbert) and already knows how to apply a node permutation natively across `nodeIds`, coordinates, connectivity, SubModelPart id lists and field ids — a plain **compact/renumber** transform is a small pure module reusing that same application path, and it is useful on its own, independently of merging.
   - **Silent field collisions.** Fields merge only when `kind`, `variable` **and** `components` all match; otherwise a second, identically-named `FieldData` is pushed with no diagnostic. `parseVtm` at least warns in the same situation.
   - **Dropped context.** `meta: base.meta`, so the other mesh's Properties and ModelPartData blocks are lost; `constraintIds` on the wrapper part is hard-coded empty; both meshes' diagnostics are discarded; and a wrapper name that already exists in the base is appended a second time rather than de-duplicated (unlike `renameSubModelPart`, which refuses).

   Explicitly **not** built on meshio++'s N-ary `merge()`, despite it being available and tempting: the round-trip loses entity kinds, property ids and every original id, which is the whole reason merging is hard. Noted as evaluated so it is not re-proposed.

   *MCP parity: required* — an N-ary `mergeMesh` and a `renumber` op, both through `mesh_transform`.

2. **Combine operations into one apply** (**M**, [#13](https://github.com/loumalouomega/VSCode-MDPA-Preview/issues/13)). Half of this already works and is documented here so it is not rebuilt: **field visualization modes already combine freely** — `fieldState.modes` is a `Set<FieldMode>` and contour, quiver, iso, deformed and threshold are independently toggleable, with only the deliberate cross-constraints (threshold *replaces* the full-mesh surface rather than z-fighting with it; deformed warps the geometry all the other layers render on).

   The *operations* half is the real gap. Every operation posts exactly one flat `applyOp` message, and the host guards with a single boolean per panel that **rejects rather than queues** — a webview firing N messages gets one applied and N−1 warning toasts. Five things block a macro:

   - No composite variant in the `OpRecord` union, and `OP_LABELS`/`KNOWN_OPS`/`validateParams` are all exhaustive over `OpName`.
   - No transaction API on `OperationHistory`: `applyNew` applies one record and advances the cursor by one, so without a composite record the undo granularity stays per-op — which may be the *desired* answer for a macro, and should be decided rather than defaulted.
   - No rollback if a batch fails at step k. The correct shape — fold into a temp model, commit once — already exists headless in the MCP `mesh_transform` handler and can be lifted.
   - The non-queueing in-flight guard, duplicated verbatim in both providers.
   - Progress and cancellation are single-op shaped: the progress callback closes over one `rec.op`, and there is one `AbortController`. A macro spanning several MMG runs needs a step counter in the message, not just a log line.

   The recommended design is a named composite record, because `serializeOps`/`parseOpsJson` recipes are *already* an ordered op list with versioned validation — a macro is a recipe with a name, and the save/load recipe UI is the natural place to create one.

   *MCP parity: this closes an **inverted** parity gap.* `mesh_transform` already accepts an op array, so headless can batch today and the UI cannot. No new tool needed; the sync rule is satisfied by making the interactive side catch up.

### Tier 2 — Simulation lifecycle

*Admission: turns a fire-and-forget action into tracked state, and needs a host-owned surface that outlives a preview panel.*

3. **Run manager** (**L**, [#37](https://github.com/loumalouomega/VSCode-MDPA-Preview/issues/37)). Greenfield in an unusually literal sense: **the extension contributes no VS Code view at all today** — no `contributes.views`, no `viewsContainers`, no `createTreeView`, no `registerWebviewViewProvider`. A run manager would be its first, the same way the `kratos.*` block was its first `contributes.configuration`.

   What running a case does today (`PtController.run()`): regenerate the case files, resolve the Python and Kratos install paths, compute the environment, dispose any existing terminal named `Kratos: <stem>`, create a fresh one with that env and `cwd`, `sendText("<python> MainKratos.py")`, and post `ptStatus { kind: "running" }`. That status is never updated again. There is **no exit code, no stdout capture, no PID, no registry**; the terminal reference is a local `const` that is never stored, so it outlives the panel that made it; the terminal is keyed by *stem name globally*, so two panels on the same mesh fight over one terminal; and `openResults()` simply `readdirSync`s `vtk_output/`, sorts, and opens the first file — no wait-for-completion, no "jump to the latest step".

   The design decision the item must force, before any UI: **a run outlives its panel, but `PtController` is per-panel and disposed with it.** The registry therefore belongs in a new module owned by `extension.ts` (the same ownership pattern as the shared, ref-counted `FlowgraphController`), with `PtController` as a client rather than the owner. Two launch strategies to weigh honestly:

   - Keep `createTerminal` and add `window.onDidCloseTerminal` + `terminal.exitStatus`. Cheap, preserves the familiar terminal, gives a coarse finished/failed signal and nothing else.
   - `child_process.spawn` into an `OutputChannel`. Real exit codes, a streamable and parseable log (Kratos prints step/time lines, so a genuine progress bar becomes possible), cancellation by killing the child — at the cost of losing the interactive terminal and owning the process lifecycle across window reloads.

   Note that `engines.vscode` is `^1.84.0`, so any terminal shell-integration API used for exit codes needs the floor raised deliberately, not incidentally.

   *MCP parity:* a `case_run` / `case_status` pair is the honest mirror of a run registry. In scope, but separable — an agent that can start a solver and cannot tell whether it finished is worse than one that cannot start it.

### Tier 3 — Viewer and presentation

*Admission: closes a display or presentation gap for a capability the pipeline already has. Explicitly ranked below every tier above; nothing in this tier is a prerequisite for anything.*

4. **Split view** (**L**, or **M** for the mirrored-camera variant). There is exactly one `vtkGenericRenderWindow` in the webview, and `renderer`, `renderWindow`, `apiRW` and `vtkCanvas` are **module-level `const`s** in a 3 100-line `main.ts` with close to forty `renderWindow.render()` call sites, alongside all layer/actor state. Two routes, and the item must commit to one:

   - **(a) A `Viewport` factory.** Refactor `main.ts` so scene building, layers and panels are parameterised on their renderer and container. Correct, and the only route to genuinely independent views — but it touches nearly the whole file and every panel module that closes over the scene.
   - **(b) A second render window that mirrors the camera.** A sibling `#vtk-sub-2` with its own `vtkGenericRenderWindow`, actors duplicated from the same `vtkPolyData`, and the camera copied on `onModified`. Cheap and self-contained, at the cost of two scenes to keep in sync on every rebuild.

   Recommend **(b)** first, scoped to *comparison* — the same mesh with two cameras, or two field settings side by side — since that is the use case a split earns its complexity for. Two things make it less scary than it looks: `NavControls` already takes `(container, renderer, renderWindow)` as explicit parameters, so the DOM overlays are already viewport-parameterised; and the Flowgraph pane is a working precedent for splitting `#viewport`, done entirely with CSS classes and an inline percentage, with `#vtk-sub` as a `flex: 1` child that absorbs the remainder.

   **Do this first regardless of route:** there are two hand-rolled, near-identical pointer-drag splitters — `wireResizer()` in `webview/flowgraphPane.ts` (clamps a fraction) and `initSidebarResize()` in `webview/sidebarResize.ts` (clamps pixels) — with the same `setPointerCapture` / `.dragging` / `userSelect: none` body. Extract one `makeSplitter({ handle, container, orientation, onFraction })` before adding a third copy.

   *MCP parity:* exempt — UI-only, like the Flowgraph embedding.

5. **Video generation** (**M**, [#66](https://github.com/loumalouomega/VSCode-MDPA-Preview/issues/66)). The single-image half already works end to end: `takeScreenshot()` renders, calls `apiRW.captureNextImage("image/png")` (falling back to `canvas.toDataURL`), optionally burns the DOM legend into the PNG via `compositeLegend`, and posts `{ type: "screenshot", data }`; the host writes it through a save dialog. Note that `saveScreenshot` is **duplicated verbatim in both providers**, so a video counterpart should be hoisted into a shared host module the way `meshExport.ts` was, rather than tripling the copy.

   Two frame sources are worth having, and only one of them needs the timeline: the **VTK time series**, and a **camera turntable** for a static mesh (reuse `snapCamera` and the `NavControls` orbit step — a mesh with no time series is the common case and deserves an animation too).

   Recommended encoding: **`canvas.captureStream(0)` plus `track.requestFrame()` after each render, fed to a `MediaRecorder` producing webm.** A zero-frame-rate capture stream is *deterministic* rather than real-time, which is exactly right for a pipeline where each frame costs a disk re-parse; it needs no dependency, and the webview CSP already permits `worker-src blob:` and `child-src blob:` (`media-src` is absent, but is only needed to *play* the result inside the webview, which is unnecessary — the bytes go to the host and become a file). Offer a PNG-sequence output as a fallback for anyone who wants ffmpeg and mp4.

   Three synchronization hazards, all verified, that a naive implementation will hit:

   - The timeline's play loop is a **fire-and-forget `setInterval`** that never awaits frame arrival. It re-requests the same index if a parse overruns the tick, so frames repeat or drop rather than queue.
   - There is **no "frame rendered" acknowledgement** message back to the host, and no promise to await — between `vtkRequestFrame` and the canvas actually showing the frame sit a disk re-parse, a `postMessage`, and a full `buildScene`.
   - `showLoading` sets `#app`'s `display` to `none`, so **the whole app including the canvas is hidden while a frame loads**. Capturing on a timer would record blanks.

   So capture has to be an explicit request → render → capture → advance loop, which also means `TimelineControl` needs a `goToFrame(i)` / `getState()` it does not currently expose (its index is private and only reachable through the `onFrameRequest` callback).

   *MCP parity:* exempt — UI-only, same reasoning as the screenshot feature it extends.

6. **Loading logo / animation** (**S**, [#11](https://github.com/loumalouomega/VSCode-MDPA-Preview/issues/11)). The overlay is a full-bleed `#loading` div containing a 260 px flex column with a 12 px gap, a 4 px determinate bar driven by the host's `progress` messages, and a text label — the column is a ready-made empty slot above the bar. Three facts shape the work:

   - **The loading markup is inlined in both providers**, and is one of the last pieces of webview chrome *not* hoisted into `src/webviewChrome.ts`. Hoist it to a `LOADING_HTML` constant first; the screenshot harness consumes those shared constants too, so this also makes the overlay capturable.
   - **`images/icon.png` is unreachable from the webview.** `localResourceRoots` is `[<extensionUri>/media]` only. Three ways out: copy it into `media/` with an esbuild plugin (the `copyStylePlugin` pattern), inline it as a `data:` URI (the CSP already allows `img-src … data:`), or — best matching this repo's deliberately asset-free convention — author it as an inline SVG through the existing `icons/` → `npm run build:icons` → `toolbarIcons.ts` pipeline, where it inherits the theme foreground for free.
   - **The design system currently forbids this.** `doc/ui-design-system.md` principle 3 reads *"No decorative motion. Hover/active states switch instantly. The only animation is the indeterminate progress sweep."* A rotating logo needs that principle **explicitly amended**, not quietly violated. The recommended amendment: carve out the full-screen loading overlay as the second permitted animation, on the grounds that it is a blocking state rather than chrome — and keep the motion slow and single-axis so it reads as "working", not as decoration.

   *MCP parity:* exempt.

7. **Beam / line-cell rendering** (**M**, [#69](https://github.com/loumalouomega/VSCode-MDPA-Preview/issues/69)). Line cells draw as `setLineWidth(1.5)` polylines — screen-space pixels that do not scale with the camera and carry no cross-section. That is exactly the defect the sphere work fixed for one-node cells, and the fix has the same shape: a `vtkGlyph3DMapper` with a unit source, a per-cell scale array, and auto-enablement only when the data is genuinely present (`sphereGlyph.ts` is the model; `quiver.ts` is the other precedent for orienting a glyph along a direction). A beam is the 1D analogue — a tube or extruded profile oriented along the line and sized by a cross-section.

    The blocker is upstream of the renderer: **the mdpa `Properties` block, where Kratos keeps `CROSS_AREA`, `I22`, `I33` and the rest, is not parsed into values.** `MetaBlock` is `{ label, lineCount }` — the parser counts the block's lines and nothing more — and `mdpaWriter.ts` copies Properties verbatim out of the original source text, which is precisely what makes the round-trip lossless today. So this item's real content is a **Properties key/value parser** (kept additive, so verbatim copy-out remains the writer's behaviour) plus the glyph module. The parser is worth more than the glyph: it also unlocks a Properties inspector, per-property layer colouring, and a materials cross-check against the generated materials JSON.

    A radius-less fallback matters as much as it did for spheres: a mesh whose lines are just polylines (a `.obj` wireframe, an extracted edge set) must keep drawing as plain lines rather than silently becoming a bundle of tubes.

    *MCP parity:* exempt for the glyph itself; a parsed-Properties section in `mesh_info` is the mirror worth adding alongside the parser, in the same shape as the existing `spheres` section.

### Tier 4 — New surfaces

*Admission: adds a viewer for something that is not a mesh. Ranked last because it is the only tier that widens what the extension **is**, rather than doing better what it already does.*

8. **JSON preview** (**L**, [#57](https://github.com/loumalouomega/VSCode-MDPA-Preview/issues/57)). Listed as *scope it first, build it second*, because the extension already ships **two** ProjectParameters editors and a third needs to justify itself against both: the declarative problemtype sidebar, whose forms are generated from a `ProblemtypeDeclaration` and which owns the case state, and the embedded Flowgraph node editor with its two-way ProjectParameters bridge.

    The gap neither of them fills is an **arbitrary** Kratos JSON — a case someone else generated, a materials file, a solver-settings fragment pasted from a tutorial — none of which has a problemtype declaration behind it. So the plausible scope is a *read-only, schema-aware inspector*: fold/unfold, validate against what the generator knows, and **cross-link into the mesh** — clicking a `model_part_name` frames that SubModelPart, using the reverse membership index (`src/parser/smpMembership.ts`) and the highlight-layer pattern Find and Inspect already share. That framing keeps it a *preview* extension feature rather than a second, competing editor.

    It would also be the extension's first non-mesh custom editor (a third `viewType`), and the first time the webview bundle is loaded for a document that has no `MdpaModel` at all — worth pricing in.

    *MCP parity:* exempt while read-only. If it ever gains editing, it becomes a `case_write_state` sibling and is no longer exempt.

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
- **A general, user-composable visualization pipeline** (ParaView-style filter graph) — considered and rejected as a shape, not merely deferred. The fixed Field-panel modes plus the Mesh Modification operations cover the cases this extension exists for, and item 2 is the bounded version of the same want: chain the *operations*, not the *visualization*.
- **MCP tools for UI-only surfaces** — the Flowgraph embedding (an interactive iframe editor with no headless equivalent), What's New, and Inspect/Measure are exempt from the parity rule by design. Recorded here so the exemption is not mistaken for an oversight and re-filed as a gap.
