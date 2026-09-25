# Selection sets and Properties authoring

Select what you care about, act on it once.

Open the panel with the toolbar's **Selection** button and choose the gesture mode — **Single**, **Box** or **Lasso** — from the segmented track. **Ctrl+click** toggles the picked element, condition or geometry in the ACTIVE set in any mode (each kind keeps its own id space — an Element 2 and a Condition 2 are different things and stay distinct). **Box** turns a left-drag into a rubber-band batch add. **Lasso** places vertices one click at a time (an SVG polygon follows the cursor); clicking the first vertex or pressing **Enter** closes the region and picks everything inside, and **Escape** cancels the open lasso. **Escape** on a resting panel clears the active set.

## Selection sets

A set is a named group of entities. It carries a **seed**:

| Seed | How the ids are derived |
|---|---|
| explicit picks | the ids you clicked / boxed |
| SubModelPart | the part's subtree |
| field range | the same cells the viewer's Threshold mode colors (with the same "all/any node in range" rule) |
| quality metric | `meshQuality`'s bad / unacceptable elements |
| property id | every block row pointing at a `Begin Properties` id |

The seed is the survival mechanism: everything in this extension is a
rebuild, and a set **re-resolves its seed against every new model** — a
timeline step, an edit, a watcher tick. A set seeded by a field range follows
the timeline step by step; an explicitly-picked set keeps exactly the ids that
still exist in the mesh and prunes the rest. A selection that never silently
survives onto unrelated ids is the whole contract: predicates keep working
across edits because the predicate still matches, and frozen picks shrink to
their survivors honestly.

## Acting on a selection

- **New SubModelPart** — creates a SubModelPart holding the selection, with
  the selected cells' nodes riding with them (Kratos' parent/child subset
  rule). It is an ordinary, undoable operation: it shows in the Edit history
  like any other edit.
- **Export** — writes the selection as its own mesh file, preserving original
  ids (fields sliced to survivors, SubModelParts narrowed).
- **Delete entities** — deletes the selected entities as one undoable edit.
  There is no second rule: the delete is the complement of the selection
  export, so conditions on the surviving region stay, constraints vanish with
  their nodes, fields slice to survivors, SubModelParts narrow and orphan
  nodes are cleaned up. Undo brings them back.
- **Isolate / Hide / Restore** — suppress block layers by selection share
  (block granularity is stated in each button's tooltip, not hidden). Nothing
  here touches your outline checkboxes; Restore puts everything back.
- **Frame** — fit the view to the set's highlight.
- **Clear** — empty the active set (its seed stays, so you can re-resolve by
  re-picking or a model change).

## Properties editor (Advanced ▸)

Lists every `Begin Properties <id>` block. **Edit a value in place** (Enter
commits — a number, `True`/`False`, `[1,2,3]` vector, or raw text kept
verbatim), **New** / **Clone** / **Delete** a set, and **Assign** a set to a
SubModelPart's entities by rewriting their `propertyIds` rows. Geometries
carry no properties and are refused by name; a delete is refused while any
block still references the set.

Both authoring shapes are deliberately exposed — possible with a frame's
girders sharing one `CROSS_AREA`:

- **Shared-property editing** changes the set in place; every block pointing
  at that id sees it.
- **Clone-and-reassign** copies the set to a fresh id without touching blocks,
  then `assign` points selected blocks at it selectively.

A beam's `CROSS_AREA` resolves through these sets (Properties first, then an
Elemental field), so editing it re-renders the beam tubes immediately — no
second source of truth.

## Headless (MCP)

Selection predicates and property mutations work headless too:

- **`mesh_select`** evaluates a seed (`part` / `field` / `quality` /
  `property`) and returns the per-kind id lists — the same cells the panel
  shows.
- **`mesh_transform`** accepts `setProperty`, `createProperty`,
  `cloneProperty`, `deleteProperty`, `assignProperty`,
  `createSubModelPartFromSelection` and `deleteEntities` — a seed given to
  that op resolves against the rolling model at apply time, which makes
  "select by field, tag properties, group into a part" a single chained op
  array, and "delete the selection" one more named record.

Selection counts and action availability update while the panel stays open after edits, undo/redo, reloads, and timeline changes. Draft input and keyboard focus are preserved during these updates.
