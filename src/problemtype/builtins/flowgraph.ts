/**
 * Built-in "Flowgraph" problemtype.
 *
 * Unlike the other built-ins, this one renders no sidebar forms: selecting it
 * embeds the Kratos Flowgraph node editor (@kratos-flowgraph/flowgraph) in a
 * split pane (view: "flowgraph" — see webview/flowgraphPane.ts and
 * src/flowgraphController.ts). Case generation happens inside flowgraph, which
 * exports a ProjectParameters.json back through the bridge; the declarative
 * generate pipeline is therefore unused, so the hooks are trivial no-ops and
 * the metadata is minimal-but-valid (validateDeclaration still requires the
 * core string fields + a non-empty domainSizes).
 */

import { defineProblemtype } from "../api";

export const flowgraph = defineProblemtype(
  {
    id: "flowgraph",
    name: "Flowgraph (node editor)",
    description:
      "Configure the Kratos case visually with the embedded Flowgraph node editor.",
    icon: "ptFlowgraph",
    view: "flowgraph",
    // Placeholder metadata — the actual analysis stage / model part / materials
    // are chosen inside flowgraph and exported as ProjectParameters.json.
    analysisStage: "KratosMultiphysics.analysis_stage",
    modelPartName: "MainModelPart",
    materialsFileName: "Materials.json",
    domainSizes: [2, 3],
    sections: [],
    conditions: [],
    materialLaws: [],
    output: { nodalDefaults: [] },
  },
  {
    // Case files come from flowgraph's own export, not this pipeline.
    solverSettings: () => ({}),
  }
);
