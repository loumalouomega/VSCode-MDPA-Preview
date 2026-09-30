# Export Report & Provenance

Every export answers one question the write itself cannot: **what actually made it into the file?** A `.med` keeps named groups but renumbers them, a `.vtu` keeps fields but not Properties, an `.stl` keeps only triangles. After **File ▸ Save / Save As / Export** (and the SubModelPart, skin and derived-mesh exports), the notification ends with a one-line summary and a **Show report** button.

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

They are **measured, not asserted**. A reference mesh — one hexahedron with a boundary quad, ids that are neither 1-based nor equal across kinds, Properties, a constraint, a nested SubModelPart and Nodal/Elemental fields — is written through every writer and re-read; the table of results is checked in (`src/parser/exportFidelityTable.ts`) and a test fails if a kernel upgrade changes what a writer keeps.

A measurement speaks only for what it covered. A claim about cell connectivity, ids or blocks is made only when every block of your mesh has a cell type the reference had (hexahedron, quad); a field claim only for a Nodal or Elemental field with 1 or 3 components. A writer the reference mesh could not be round-tripped through (DOLFIN and TetGen need simplices, Triangle is 2D, EnSight's variable files, write-only SVG/TikZ) reports **unverified**, with the reason.

## Checking a report against the file

Through MCP, `verify: true` re-reads the written file and grades every claim: each category gets `verified: true` or `false`, and any claim the re-read contradicts is listed under `report.unexpected`. That is the regression signal — as opposed to an ordinary format limit, which the table already states. An `unverified` claim is settled by the re-read instead.

## Provenance

`kratos.export.provenance` (and the `provenance` argument of the MCP write tools) decides what is recorded on disk:

- **auto** (default) — meshio++ embeds a block naming the source, the applied operations, the tool and a timestamp, in the formats that have a header slot for one. As measured at meshio++ 16.27.0 those are Abaqus (`.inp`), Exodus and OFF; Gmsh, MED, XDMF and others have none. The report says whether it landed (`provenance.embedded`) rather than assuming.
- **sidecar** — additionally writes `<output>.kratosexport.json` beside the file, holding the whole report. Use it for `.mdpa`, `.vtu`, `.stl` and every other format with no slot: the extension's own writers add no comment to their files, so a sidecar is the only way to record provenance for them.
- **none** — record nothing. The report is still shown.

Saved recipes (`<stem>.ops.json`) and problem archives (`kratosproblem.json`) now also note the kernel version and tool that wrote them. Older readers ignore those keys.

## Headless

`mesh_convert`, `mesh_transform`, `mesh_extract_submodelpart`, `mesh_extract_skin` and `mesh_derive` return the same `report`, and accept `provenance` and `verify`. `mesh_capabilities` publishes the measured table as `exportFidelity`, so an agent can ask what a format keeps *before* writing.

## Not covered yet

- Partition and split exports, `mesh_pack_series`, `mesh_split` and structured `.vti` lattices write many files or bypass the mesh writers; they do not return a report yet.
- There is no report panel — the report is JSON plus the one-line summary.
- Formats the reference mesh cannot round-trip stay `unverified`; extending the reference (or adding a second one for simplices) is how they would be measured.
