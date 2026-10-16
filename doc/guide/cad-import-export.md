# CAD, glTF and IGA

![A STEP solid opened as a triangle-skin preview beside the File ▸ Export ▸ CAD submenu, and the fit ask for the STEP export](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/cad-import-export.png)

Since meshio++ 17.2.0 the extension ships the kernel **twice**: the lean MIT build that serves every ordinary format, and a FULL build — OpenCASCADE, zstd, lz4 and bzip2 linked in, under the mixed licence `MIT AND (LGPL-2.1-only WITH OCCT-exception-1.0)`; the kernel's own `THIRD_PARTY_NOTICES.md` ships beside it in `dist/meshio/`. The full artifact is loaded lazily, only where the lean build cannot serve, and this page is what that unlocks: opening CAD files, exporting a **fitted** STEP solid, glTF scenes, and IGA refinement of NURBS.

`mesh_capabilities` reports both builds live — the lean one's flavour and libraries, and the full artifact's own backend, flags and reader/writer lists — so an agent (or you, in a pinch) can ask what is linked instead of trusting this page.

## Opening STEP, IGES and glTF

`.step`/`.stp`, `.igs`/`.iges` and `.glb`/`.gltf` open in the mesh preview like any other format. The CAD readers need OpenCASCADE, which only the full artifact links, so those extensions dispatch to it directly; glTF is served by the lean build. What you get is the solid's **triangulation** — the same surface preview every other format gives, with fields where the file carries any.

These are **static** previews by design: a STEP file holds one solid, and a folder of `.step` files is a set of parts, not a `<prefix>_<rank>_<step>` series — so there is no timeline bar and no directory watcher, and nothing is invented.

A `.glb` is one self-contained file. A `.gltf` (the JSON spelling) carries its heavy arrays in external files the JSON's `buffers[].uri` names — meshio++'s own writer emits `<stem>.bin` beside it — and those are staged with the scene, so both flavours open; a self-contained (data-URI) `.gltf` reads alone.

## Exporting STEP: Skin to CAD

**File ▸ Export ▸ CAD ▸ STEP (CAD, auto-fitted)** is one target with auto-fit behaviour, and the export asks once how far to take it:

| Choice | What runs |
| --- | --- |
| **Fit CAD surfaces — kernel defaults** (recommended) | `fitCad` segments the closed skin itself and fits every patch: an analytic face where a primitive fits (plane/sphere/cylinder/cone/torus, fillets, blends, threads), a freeform B-spline patch where none does, a faceted patch as the last demotion |
| **Fit — analytic primitives only** | No freeform B-spline or thread faces; everything they would have covered stays faceted. Faster, and portable where a receiver accepts only analytic surfaces |
| **Skip fitting — faceted solid (fast)** | The skin's triangles as planar faces, exactly like the faceted writer always wrote |

The fit runs on the model's **boundary skin**: a volume model exports its boundary as the solid (the export says so — `STEP: volume interiors are not representable — wrote the boundary skin (N faces)`), because the underlying writer treats every cell it is handed as surface.

What you get back, and how you know which path ran:

- A fitted export writes the AP214 STEP and states the census in its diagnostics and the export report — for a unit box: `STEP: fitted CAD B-rep via fitCad — 6 planes; the B-rep also rides beside it as box.cad.json.` The **`<stem>.cad.json` companion** is the fitted solid's B-rep in Kratos CAD JSON shape, written automatically beside the `.step`.
- A skipped or failed fit falls back to the **faceted** STEP writer (planar faces, no B-rep, no companion) and says so, naming why. The faceted writer refuses an open or inconsistently wound surface by name (`… is not a closed, consistently wound solid: N open … run repair first`), and the eligibility check refuses the same thing up front with the remedy: **Extract Skin** gives a volume mesh its boundary, **Repair** closes a leaky surface.

The export report (and `verify`) treat the `.step` like any other target — the file is re-read through the CAD reader when verification is on.

### Command line

```
export step to=solid.step          # the fit ask appears, then the save dialog
export step to=solid.step overwrite=true
```

## IGA: refining and sampling NURBS

A read of a format whose side channel is a NURBS payload — a `.cad.json`, a `.step`/`.igs` file, or an MFEM NURBS `.mesh` — **keeps the patches on the model**. `mesh_info` reports them: `nurbs: {format, patches, faces}`. Two `mesh_derive` kinds run the IGA kernel (the lean build — no OpenCASCADE needed) on that channel:

| Kind | What it does | Options |
| --- | --- | --- |
| `igaRefine` | h/p-refines the patches | `subdivisions` per knot span and direction (one number or one per direction), `elevate` degree elevation, B-rep `edges`/`trim` |
| `igaSample` | tessellates the patches into Lagrange cells | `sampleSubdivisions` (cells per knot span; 0 = automatic), `trimSamples` (points per knot span a trimming curve gets), `edges`, `trim` |

Both are **derived** meshes — the source is untouched — and neither carries the side channel on its result, because the chain runs through files: write `.cad.json` (or an MFEM NURBS `.mesh`) and reopen it to refine again.

The side channel has one sharp rule: **any applied edit drops it.** A mesh you translated, remeshed or merged is no longer the patches' sampling — upstream refuses exactly that ("a mesh moved or edited since") — so the channel survives only while the model is unedited (undo back to the pristine read brings it back). `mesh_info`'s `nurbs` section is the tell: if it is there, IGA will run.

### MCP

```jsonc
// Read a CAD solid (the full artifact's reader) — mesh_info reports its B-rep:
{ "tool": "mesh_info",     "args": { "path": "bracket.step" } }
// → { "format": ".step", "nodeCount": 1758, …, "nurbs": { "format": "cad_json", "patches": 6, "faces": 6 } }

// Export a fitted STEP from a closed triangle skin, with fit controls:
{ "tool": "mesh_convert",  "args": { "path": "skin.vtu", "outputPath": "solid.step",
                                     "fitCad": { "tolerance": 0.05, "freeform": false } } }
// → solid.step + solid.cad.json; report.warnings name the fitted face types.

// Refine the B-rep you just wrote, then sample it:
{ "tool": "mesh_derive",   "args": { "path": "solid.cad.json", "kind": "igaRefine",
                                     "subdivisions": 2, "outputPath": "refined.vtu" } }
{ "tool": "mesh_derive",   "args": { "path": "solid.cad.json", "kind": "igaSample",
                                     "sampleSubdivisions": 24, "outputPath": "sampled.vtu" } }
```

`mesh_convert`'s `fitCad` object takes upstream's options minus `stepPath` (the write owns that path); unknown keys are refused by the kernel itself, and `fitCad: false` writes the faceted solid only.

## What is deliberately not here

- **No interactive segmentation**: `fitCad` segments the skin itself; upstream's `segment`/`fitPrimitives` ops stay unexposed, and the fit controls are the export's.
- **No `igaEvaluate`**: patch-wise parametric evaluation is reachable later if a workflow asks for it; refine and sample cover the mesh workflows.
- **No glTF writer routing**: the kernel has one, and an explicit `outputFormat: "gltf"` reaches it through `mesh_convert`, but no extension maps to it — nothing in this extension emits glTF yet.

![A NURBS box refined with igaRefine and re-sampled, shown beside mesh_info's nurbs section](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/iga-refine.png)
