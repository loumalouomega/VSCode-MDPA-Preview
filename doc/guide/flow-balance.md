# Flow Balance

**Advanced ▸ Flow balance…** answers the quantitative CFD questions the Field panel can only show: how much fluid crosses an inlet or an outlet, whether the boundaries balance, and what the pressure drop between two of them is.

## Sections

A **section** is a SubModelPart whose Conditions — and those of its children — are the boundary you want to measure: surface Conditions in a 3D mesh, line Conditions in a 2D one. Add as many as you like and give each a name (it defaults to the part's path).

## What is computed

For every section:

- **Flux** `∫ u·n dA`, using the nodal vector field you choose (default `VELOCITY`).
- **Area** and the **area-weighted mean** of a nodal scalar (default `PRESSURE`), in that field's own units.
- **Mass flux** `ρ × flux`, only when you type an explicit density. A density is never inferred from a field's name.
- **Mean in Pa**, only when you type an explicit **P density** and the field is a kinematic pressure (`m²/s²`, as read from an OpenFOAM case): the means are reported scaled by that density. Any other dimension — unknown, already Pa, or anything else — reports the conversion as unavailable with the reason instead of rescaling. The P density never falls back to the mass-flux density, and the gauge/absolute reference only labels the result.

Across the sections:

- **Net flux**, the signed sum. It is close to zero when the sections are the whole boundary of an incompressible flow.
- **Imbalance** `net / max(total inflow, total outflow)`. With no flow through any section the denominator is zero and the imbalance is shown as *n/a* with the reason, never as infinity.
- **Pressure drop** `mean p(From) − mean p(To)` between two sections you pick, as a difference of one field in its own units and its own gauge or absolute reference. With a P density and a kinematic-pressure field the drop is additionally reported in Pa.

## Sign and orientation

**Flux is positive out of the domain**, so an inlet reads negative and an outlet positive.

**Normal** chooses how each facet's normal is found:

- **Outward from the domain** (default): the normal is flipped away from the single Element the facet belongs to. The winding of a Condition is whatever the mesher wrote and Kratos does not require it to face out, so trusting it would silently flip a sign. A facet with no adjacent Element cannot be oriented and is **excluded and counted**; a facet shared by two Elements is internal, not a boundary, and is excluded and counted the same way.
- **As wound in the file**: the Conditions' node order decides. Use it when the Conditions have no Elements beside them, or to check a mesh's own orientation.

## Numerical method

Each facet is split into triangles from its first corner, and every triangle contributes the mean of its corner values dotted with its area vector. That is exact for a field that varies linearly over a triangle, and a warped quad sums its pieces' own area vectors rather than one invented normal. Only corner nodes are read, so a quadratic facet is integrated as its linear skeleton — and the panel says which blocks that was. Averaging the velocity components and multiplying by the area is *not* a flux, which is why this is separate from **Field integrals**. An Elemental or Conditional velocity is refused by name: move it to the nodes first with Average field.

## Gaps

A facet with a corner that carries no value is a gap: it is left out of that quantity and its area is reported as uncovered, never read as zero. A section with no covered facets shows *n/a*.

## 2D meshes

Line Conditions bounding surface Elements give `∫ u·n dl` **per unit depth**. The panel and the reply say so; it is not a volume flow rate.

## Following the timeline

The balance is for the frame on screen and is recomputed when the timeline steps. **Export CSV** saves the table. **All steps** walks every step of the series one model at a time (a failing step is recorded and skipped, and a scan can be cancelled with a partial table kept); picking a row jumps the 3D view to that step, and **Export series CSV** saves the per-step table. For every step at once without the panel, use the MCP tool below.

## From an agent or a script

The same core runs headlessly as the `mesh_flow_balance` MCP tool: `sections`, `velocity`, `pressure`, `density`, `orientation`, `pressureDrop`, `timeStep` for one step or `allSteps` to walk the whole series (a step that fails to parse is recorded and skipped), and `outputPath` for a `.csv`. See [MCP Server](./mcp).

## Not included

Live solver monitors (saving a monitored value while a run is in progress) are a separate roadmap item. A variable-density conversion also stays out: the Pa report takes one density, like `convertFieldUnits`.
