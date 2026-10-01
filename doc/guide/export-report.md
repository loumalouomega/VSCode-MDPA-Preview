# Export Report & Provenance

Every export answers one question the write itself cannot: **what actually made it into the file?** A `.med` keeps named groups but renumbers them, a `.vtu` keeps fields but not Properties, an `.stl` keeps only triangles. After **File ▸ Save / Save As / Export** (and the SubModelPart, skin and derived-mesh exports), the notification ends with a one-line summary and a **Show report** button.

**Show report** opens a graphical panel in the mesh preview. **Advanced ▸ Export report…** and **Kratos MDPA: Export Report…** reopen the latest report without another export. Reports group categories by status, list companions and provenance, and highlight verification contradictions. A file selector switches between partition/split outputs; **Copy JSON** and the expandable JSON view expose the same data. A pack launched outside a preview opens a standalone, script-free report view. Reports describe the last export, not the mesh's current dirty state.

## What the report says

The report lists, for what the exported mesh carries, one entry each for node coordinates, node ids, cell connectivity, Element/Condition/Geometry ids, block names and kinds, Properties, constraints, SubModelParts, every field (with its kind and component count), field dimensions, global variables and source metadata. Each entry is one of:

| Status | Meaning |
| --- | --- |
| **retained** | present in the file as it was |
| **transformed** | present but changed — renumbered, renamed, flattened, split or reordered |
| **omitted** | not in the file |
| **unverified** | nothing has established which of the above applies |

It also records the source file, the applied edit operations, the writer, any companion files, the meshio++ version, and everything the writers warned about.

## Where the statuses come from

They are **measured, not asserted**. Four reference meshes — hexahedron/quad, tetrahedron/triangle, tetrahedron-only and triangle-only — carry non-1-based ids, Properties, a constraint, nested SubModelParts and scalar/vector fields. The simplicial fixtures additionally carry Elemental vectors and Conditional scalar/vector fields. Every writer writes and re-reads each reference; the table is checked in (`src/parser/exportFidelityTable.ts`) and a test fails if a kernel upgrade changes what a writer keeps. The same fresh round trips grade every report's claims.

A measurement speaks only for what it covered. The narrowest reference covering the mesh's cell types supplies its claims; a mixture of separately measured types is not proof of their combination. Uncovered topology, field widths, and failed round trips remain **unverified**, with a reason. DOLFIN, TetGen, FreeFem, MFM and Triangle now have measured simplicial cases. Triangle writes only XY coordinates with z exactly zero; a 3D surface is refused rather than silently projected. Write-only figures and other fixtures without a readable result remain unverified.

## Checking a report against the file

Through MCP, `verify: true` re-reads the written file and grades every claim: each category gets `verified: true` or `false`, and any claim the re-read contradicts is listed under `report.unexpected`. That is the regression signal — as opposed to an ordinary format limit, which the table already states. An `unverified` claim is settled by the re-read instead.

## Provenance

`kratos.export.provenance` (and the `provenance` argument of the MCP write tools) decides what is recorded on disk:

- **auto** (default) — embeds source, operation chain/parameters, tool and kernel version where a safe slot exists. Native MDPA uses `//`, OBJ `#`, PLY a header comment, VTU/VTP/VTM/PVD an XML comment (VTM children also carry it). Legacy VTK uses its title: at most 255 bytes, with a warning when truncated. Meshio++ supports embedding in Abaqus, Exodus and OFF; other formats disclose whether embedding landed. STL has no safe slot.
- **sidecar** — also writes `<output>.kratosexport.json` beside the file, holding the full report. This preserves complete provenance when embedding is unsupported or the legacy VTK title is too short. Series use one collection sidecar containing their per-step roll-ups, not one sidecar per frame.
- **none** — adds no new provenance or sidecar. Reports still appear in the UI/MCP replies and split/batch manifests. Copy-through series files keep their existing bytes, including any provenance they already contain.

Saved recipes (`<stem>.ops.json`) note the kernel version and tool. **Save problem…** / `problem_pack` additionally embed `kratosprovenance.json` inside the ZIP: source format/name, kernel/tool, the separate recipe (including parameters), and byte sizes/SHA-256 hashes of the archived entries. An existing source export sidecar is included. The pristine mesh bytes are never rewritten and the recipe is not baked into them. The manifest links the record; older readers ignore the additive key. `none` omits the new archive record and manifest provenance.

## Headless

`mesh_convert`, `mesh_transform`, `mesh_extract_submodelpart`, `mesh_extract_skin`, `mesh_derive` and `mesh_compare`'s written difference mesh return the same `report`, and accept `provenance` and `verify`. `mesh_split` returns full per-file `reports` in its manifest/reply, and each completed `mesh_batch_transform` entry persists its report (retained on resume). `mesh_capabilities.exportFidelity` version 2 exposes per-reference writer rows and the reference coverage, so an agent can ask what a format keeps *before* writing.

## Series and structured grids

`mesh_pack_series` and `mesh_resample` return compact per-step `reports`, naming the source/output, writer, companions, kernel, warnings, provenance and the category ids in each status. Rewritten/resampled VTU pieces use native writer measurements. Copy-through VTK XML records byte retention only, not an unperformed semantic verification. Temporal XDMF uses a different writer from a single-mesh XDMF export, so its payload remains explicitly **unverified**. Its embedding scope is unavailable; choose `sidecar` to persist the per-step reports.

Structured `.vti` lattices also bypass the unstructured writers. They return a report with applicable categories explicitly **unverified**, not borrowed VTU claims. `mesh_derive` with `verify: true` can settle these by re-reading the actual lattice. Sidecars contain the final, checked report when verification was requested. Companions remain part of the output, not optional extras.
