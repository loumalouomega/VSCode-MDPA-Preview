# Field Integrals

**Advanced ▸ Field integrals…** reports the total and the mean of every per-cell
field on the mesh — a density field's total mass, a heat-flux field's total
power, an occupied volume — for the whole mesh **and** for each named region.

Every sum is weighted by the cell's own length, area or volume. That is the
whole point: a plain average over cells would weight a sliver the same as the
element beside it a hundred times its size, which is not what "the mean density"
means.

## The per-region breakdown

The panel shows a bold **whole mesh** row, then one row per named region, which
here means one per entity block and one per SubModelPart. So "what is the total
mass of the `Rotor` part?" is answered without slicing anything out first.

One rule to keep in mind while reading it:

> **Regions overlap; they do not partition.** A cell that belongs to two
> SubModelParts contributes fully to both, so the region rows need not sum to
> the whole-mesh row.

That is correct behaviour for overlapping groups — a cell really is in both
parts — but it looks like an arithmetic error if you were expecting a partition.

## Columns

| Column | Meaning |
|---|---|
| **total** | Σ (value × cell measure) |
| **mean** | total ÷ measure — the measure-weighted average |
| **measure** | the summed length/area/volume actually integrated over |
| **cells** | how many cells contributed; `12 (−1)` means one was excluded |

A vector field is integrated component by component, and its cells show a tuple.
Values are shown to six significant figures, switching to exponential notation at
the extremes; the full value is in each cell's tooltip.

## Skipped cells

A cell whose measure cannot be computed, or a component whose value is not
finite, is excluded from that component's numerator **and** its denominator — it
is never given a fallback weight of 1. This is why:

- the **measure** column can be smaller than the mesh's own total measure, and
- two components of the same field can legitimately show different measures.

Excluding rather than zero-filling is what keeps the **mean** meaningful on a
partly-`NaN` field, instead of dragging it toward zero with cells that carry no
information at all.

## Nodal fields

Integration is cell-measure weighted, so it needs a value per cell. A nodal
field is refused by name; run **Average field** in the `nodal → elemental`
direction first, then integrate the result.

## From an agent

The same numbers are available through the MCP server as
[`mesh_field_integrate`](/guide/development#mcp-server), with an optional list of
field names — omit it to integrate everything the mesh carries.
