# Compare in Split

Compare two meshes **inside one preview**: switch to a split layout, focus the pane that should hold the second mesh, and choose **Advanced ▸ Compare in split…** (or the **Kratos MDPA: Compare in Split…** command). Pick any mesh file the preview can open; it appears in that pane next to the primary mesh, each with its own camera, field choice and clip plane. Toggling the same entry while the compare pane is focused removes the peer again.

## What follows, and what does not

- **Camera, field, clip and colour range are per pane already**, so the two meshes are driven independently — frame the peer in its pane, colour it by another variable, clip it elsewhere.
- **The compare pane follows the shared field by name**: it keeps the focused pane's variable when the peer has a field of the same name, and otherwise falls back to the peer's first field rather than colouring peer geometry with primary data (or nothing). A linked field from [another preview](./linked-previews) follows into the compare pane the same way, and a peer that lacks the field keeps its own with the usual note.
- **The peer is read-only.** Its outline rows toggle, frame and tune opacity, and nothing else: no SubModelPart export, no rename, no delete, no promotion. Edits, selection, Inspect, analyses, plots and exports all keep acting on the **primary** mesh, and picks in the compare pane resolve to nothing. A streamline, flow or series request issued while the compare pane is focused is refused with a reason instead of running primary-model analysis over peer coordinates.
- **The peer is a static snapshot** — the file's default frame. Stepping the primary timeline replays edits and rebuilds the peer layers alongside, but the peer itself does not step. For time-synchronised run comparison across tabs, use [linked previews](./linked-previews) instead.
- **A layout change closes the compare** rather than showing the peer in the wrong pane; reopen it in the new layout.

## What is remembered

The peer is saved with the view (the `<stem>.kratosview.json` sidecar, as a path relative to the mesh, one per pane) together with everything else the viewer restores. Reopening asks the host to reload the peer into its pane; a peer that no longer resolves is reported and the pane stays single-model, and the mesh remains fully usable while it waits. The sidecar records only identity — the peer file itself is never copied.

::: tip View only
Comparing changes what you see, never either mesh: nothing is added to the edit history, no document is marked unsaved, the peer file is never written, and no file is written other than the view sidecar. Numeric comparison stays headless via `mesh_compare` / the `compareField` operation.
:::
