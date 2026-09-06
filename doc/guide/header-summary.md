# Header Summary

Opening a very large mesh means parsing it, holding it in memory several times
over, sending it to the viewer and building a scene from it — and the window is
unresponsive until all of that finishes. Often you only wanted to know **what is
in the file**.

Above a size threshold the preview answers that question instead, and lets you
load the mesh for real when you have seen it.

## What you get

The viewport shows a **Header summary** card, and the sidebar's **Information**
section carries the same counts, so they stay after you dismiss the card:

- **Node and cell counts**
- **Entity blocks** — name, kind, count, and nodes-per-cell where the format says
- **Data arrays** — nodal, cell and field variable names
- **Regions** — SubModelParts, physical groups, element blocks, depending on format
- **Time steps**, when the file carries a series

Plus one button: **Open full mesh anyway**, which loads it normally. That choice
sticks for as long as the tab is open, so a file you asked for is never
summarized again behind your back.

While a summary is showing, the mesh is genuinely not loaded — editing, export
and the analysis panels are unavailable, and Save/Export say so rather than
acting on nothing.

## What it cost

A summary is **cheaper than parsing, but not free**, and how much cheaper
depends entirely on the format. The card always says which of these it did:

| Cost | What happened | Formats |
|---|---|---|
| **header** | Read a small prefix and stopped | VTK XML (`.vtu`, `.vtp`, `.vti`, `.vts`, `.vtr`), legacy `.vtk`, `.ply`, **binary** `.stl`, `.vtm` |
| **scan** | Streamed the whole file once, building nothing | `.mdpa`, `.obj`, **ascii** `.stl` |
| **buffered** | Read the whole file into memory, but built no mesh | `.msh`, `.xdmf`/`.xmf`, the GiD `.post.*` set |
| **read** | The reader parsed the mesh to answer, then discarded it | Exodus, MED, CGNS, Abaqus, Nastran, and the other meshio++ formats |

Two of these deserve a word:

- **`.mdpa` is always a scan.** The format declares no counts anywhere — a
  block's size is implied by how many lines precede its `End` — so there is no
  header to read. The scan still skips everything that makes parsing expensive
  (no arrays, no model, nothing sent to the viewer), which is why a 2 GB `.mdpa`
  summarizes in seconds rather than exhausting memory.
- **Binary STL is the cheapest of all**: the facet count is four bytes at offset
  80, so the summary reads 84 bytes regardless of file size.

## What a format cannot say

The card lists these explicitly under *"Not reported by this format"*, because a
missing number is not a zero:

- **Bounds** are never computed. Every scanner would have to read the
  coordinates, which is the read the feature exists to avoid.
- **Cell types** are not available from a VTK XML header — the types are a data
  array in the payload, not an attribute.
- A **`.vtm`** is an index, so its child counts would mean opening every child.

One caveat worth knowing: VTK XML counts are **as declared in the file**.
Poly-lines, polygons and triangle strips expand into more cells when the mesh is
actually opened, so a `.vtp` summary can report fewer cells than the loaded mesh.
The card says so.

## Turning it off, or changing when it happens

The setting is **`kratos.preview.summaryThresholdMb`**, default **250**.

- Set it to `0` to always load the full mesh, whatever its size.
- Raise or lower it to taste — it is a rough heuristic, since a megabyte of
  compressed binary VTU and a megabyte of ASCII STL cost very different amounts.

The threshold is checked when a file is **opened**. A file that grows past it
while you are watching a solve will not flip into a summary, and a summarized
file will not silently become a full parse on the next write.

## Headless

The same summary is available from the MCP server:

```
mesh_info { "path": "…", "summary": true }
```

It works for every supported format and reports `cost`, `bytesRead` and
`unknown` exactly as the panel does. This is distinct from `metadataOnly`, which
is the strict meshio++ header-only contract and refuses anything it cannot serve
at header price.
