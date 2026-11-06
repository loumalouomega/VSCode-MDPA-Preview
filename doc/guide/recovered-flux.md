# Recovered Flux

Kratos reports reactions (`REACTION`, `REACTION_FLUX`) as nodal loads: they can be summed, but not seen as a per-area field. **Advanced ▸ Recovered flux…** recovers a nodal traction or heat flux on the faces of a SubModelPart and shows it in the Field panel.

## Using it

1. Open **Advanced ▸ Recovered flux…**.
2. Pick the **Faces** (a SubModelPart of surface Conditions) and the **Reactions** field (`REACTION` is preselected when present).
3. Optionally name the **Output**; the default is `<VARIABLE>_RECOVERED`. A name that already belongs to a Nodal field is refused.
4. Press **Compute**. The Field panel opens on the new field, labelled *recovered*.

The report lists the faces, nodes and area, the reaction sum, the integral of the recovered field over the part and their relative difference, and any part nodes with no load value (counted as zero load).

## How it is computed

The field solves the consistent boundary-mass projection `M t = F` on the part's faces (three- and six-node triangles consistently, four-node quadrilaterals lumped, eight- and nine-node quadrilaterals consistently). Dividing a nodal load by a lumped area would show spots on a quadratic face, where the corner loads of a uniform traction are zero. The integral over the whole part equals the reaction sum; over a subset of the faces it equals that subset's reactions only where the cut does not split a node's load.

## What it is not

It is a derived field. It is held only in the viewer, so it is never saved, exported, edited or listed in Variables, and it is dropped when the frame changes unless the panel is open (then it is recomputed). To keep the numbers, use MCP `mesh_recover_flux` with an `outputPath`.

The command line accepts `recoverFlux` to open the panel.
