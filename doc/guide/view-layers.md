# View layers

Organize what the viewer shows without touching solver data.

The sidebar's **Layers** section lists the mesh itself — entity blocks and SubModelParts, with checkboxes that control those rows only. **View Layers**, the section right below it, lists something else on purpose: named view-only groups such as walls, a probe region, or the results being compared. A SubModelPart is solver data (Kratos reads it, every writer emits it, operations change it through the undoable history). A view layer is a view annotation: it never changes membership, Properties, constraints, fields, the file on disk or the dirty marker, and it never reaches a solver input unless you promote it explicitly.

![Two view layers over the outline: one visible group tinting its members, one hidden group suppressing its own](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/view-layers.png)

## Creating a layer

Give it a name (no `/` — that separator belongs to SubModelPart paths), then pick its members: checked **blocks**, checked **SubModelParts**, and optionally a snapshot of a **selection set**. The snapshot is frozen at creation — a copy of the set's ids, not a live link — and all three sources union. **Add view layer** creates it with the next palette colour, visible and unlocked.

## Showing, hiding, locking, recolouring

- **Show / hide** — the checkbox. Hiding a layer suppresses its block and part members (a base layer hides only when every view layer containing it is hidden, so shared members stay visible until all their groups are off) and hides its explicit-pick overlay. Your outline checkboxes keep their meaning: hiding here never rewrites them, it only suppresses underneath.
- **Recolour** — the colour swatch. The topmost visible layer containing a base layer lends its colour; explicit picks draw as one overlay per layer in that colour.
- **Lock** — the lock button. A locked layer cannot be renamed, reordered, deleted or promoted; show/hide and recolour still work. Membership is set at creation and never edited afterwards (vanished members prune automatically, see below).
- **Reorder** — the up/down chevrons. Order is persisted and decides the colour winner for shared members.
- **Delete** — the ✕ button. Deleting a layer never deletes entities, parts or fields.

Double-click a name to rename it inline (Enter commits, Escape cancels).

## Surviving edits

Everything in this extension is a rebuild, and a layer **prunes by definition**, the way selection sets do: explicit ids intersect each new model's id universes, block and part references drop when the block or part vanishes, and the change is reported rather than silently kept. A field seed is not a layer source — if you need a live predicate, keep it as a selection set and snapshot it again.

## Reopening

Layers live in `<stem>.kratosview.json` beside the mesh, under a versioned `layers` key. Reopening restores them in order. A missing, malformed or newer-version sidecar leaves the mesh with its ordinary sections and a warning — never an empty scene, never a failed open.

## Promotion is explicit

**Promote** resolves the layer against the current mesh (blocks contribute their entities, parts their subtrees, picks their survivors) and posts an ordinary `createSubModelPartFromSelection` with those explicit id arrays. It shows in the Edit history like any other edit, it can be undone, and a name collision is refused by name. Parts never become layers automatically, and editing a layer never changes a part's membership.

Saving or exporting the mesh writes no layer data, and problemtype assignments keep addressing SubModelParts only. There is no headless tool for layers themselves — they are presentation. Promotion reuses the existing operation, so `mesh_transform` with `createSubModelPartFromSelection` is already the headless parity.
