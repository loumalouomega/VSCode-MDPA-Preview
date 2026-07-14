# Flowgraph Node Editor

The **Flowgraph (node editor)** problemtype embeds the
[Kratos Flowgraph](https://www.npmjs.com/package/@kratos-flowgraph/flowgraph)
visual editor directly in the preview. Instead of filling sidebar forms, you
wire up your Kratos case on a node canvas — analysis stages, solvers, materials,
processes, model parts and outputs — and Flowgraph produces the
`ProjectParameters.json`.

## Opening it

In the **Problemtype** sidebar section, pick **Flowgraph (node editor)** from the
dropdown. The preview **splits in half**: the 3D mesh view stays on one side and
the Flowgraph editor opens in a resizable pane on the other.

- **Split direction** — **horizontal** by default (Flowgraph below the mesh).
  Toggle to **vertical** (beside the mesh) with the button in the pane header, or
  set the default with the `kratos.flowgraph.splitOrientation` setting
  (`horizontal` | `vertical`).
- **Resize** — drag the divider between the two panes; the 3D view refits
  automatically.
- **Close** — select any other problemtype (or clear the selection) to hide the
  pane and return to the full mesh view.

## Two-way ProjectParameters bridge

The editor is connected to your case in both directions:

- **On open** — the current case's `ProjectParameters.json` (computed from your
  mesh and settings) is loaded into the graph, so Flowgraph reflects your
  current setup.
- **On Generate** — Flowgraph's **Generate** button writes the resulting
  `ProjectParameters.json` next to the `.mdpa`. You can then use **Run case**
  (from the standard problemtype flow) to launch it, or open the JSON directly.

## How it runs

Flowgraph ships as a small local web app. The extension serves its assets from a
bundled server on a local port and embeds the editor in an iframe — so the full
node editor works exactly as it does standalone, offline-capable except for a
few web fonts. Nothing is sent to any external service.

## License

Flowgraph is licensed under the **AGPL-3.0-or-later**. Because this extension
bundles and distributes it, the extension as a whole is also licensed under the
**AGPL-3.0-or-later** — see the project
[LICENSE](https://github.com/loumalouomega/VSCode-MDPA-Preview/blob/master/LICENSE).
