# Ribbon

An optional ribbon sits under the menu bar with the most common actions, grouped into five tabs:

- **View**: camera, display toggles, split layouts, symmetry views, lighting and capture.
- **Results**: Field, Clip, Plots, Data table, streamlines, integrals and flow balance.
- **Inspect**: Inspect, Find, Selection, Quality, Mesh size, Normals and the Properties editor.
- **Mesh**: simplified / tessellated copies, grid sampling, skin, partition and split exports, spheres, beams and volume view.
- **Tools**: command line, compare and link previews, wind tunnel and the export report.

Each button runs the same action as the toolbar or menu entry of the same name, so toggles show a pressed state and nothing else changes. The toolbar and menus stay available.

The ribbon is **off by default**. Enable it with the `kratos.preview.ribbon` setting (applies to previews opened afterwards). The chevron at the right of the tab strip collapses the ribbon to its tabs; the grid button shows icons only. The selected tab and both choices are saved per mesh in the `.kratosview.json` sidecar. Inside KKSS the ribbon is on by default.
