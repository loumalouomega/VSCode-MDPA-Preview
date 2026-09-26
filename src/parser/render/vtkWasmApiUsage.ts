// The VTK C++ API surface the VTK-wasm renderer backend is allowed to call
// (roadmap item 18). Every entry is checked against the pinned build's
// method table (vtkWasmMethodTable.ts `classifyUsage`) by the evaluation gate
// G0.3 and again by scripts/vtk-wasm/prepare-assets.mjs, so a re-pin that
// drops or starts suspending a method the backend relies on fails the BUILD,
// not a user's session: the session answers an unknown method with a logged
// `null`, never an exception.
//
// Spelling is C++ (`SetVisibility`). `expectSuspend` marks the calls the
// backend deliberately routes through `invokeAsync` (they trap if invoked
// synchronously while a JSPI suspension is possible). Classes are the ones
// the backend creates or holds; a factory may hand back a subclass
// (vtkActor -> vtkOpenGLActor), which inherits every entry here.

import type { UsageEntry } from "./vtkWasmMethodTable";

function group(cls: string, methods: string[], expectSuspend = false): UsageEntry[] {
  return methods.map((method) => (expectSuspend ? { cls, method, expectSuspend } : { cls, method }));
}

export const VTK_WASM_API_USAGE: readonly UsageEntry[] = [
  // Render window + layers (one canvas, N renderers as viewports).
  ...group("vtkWebAssemblyOpenGLRenderWindow", ["SetCanvasSelector", "AddRenderer", "RemoveRenderer", "SetSize", "SetNumberOfLayers", "SetMultiSamples", "SetAlphaBitPlanes", "GetNumberOfLayers"]),
  ...group("vtkWebAssemblyOpenGLRenderWindow", ["Render"], true),
  // Viewports.
  ...group("vtkRenderer", [
    "AddActor", "RemoveActor", "AddViewProp", "RemoveViewProp", "RemoveAllViewProps",
    "SetViewport", "GetViewport", "SetBackground", "SetLayer", "SetInteractive",
    "ResetCamera", "ResetCameraClippingRange", "GetActiveCamera", "SetActiveCamera", "ComputeVisiblePropBounds",
    "SetUseDepthPeeling", "SetMaximumNumberOfPeels", "SetOcclusionRatio", "SetUseFXAA", "SetUseOIT",
    "SetWorldPoint", "WorldToDisplay", "GetDisplayPoint",
  ]),
  // Camera.
  ...group("vtkCamera", [
    "SetPosition", "GetPosition", "SetFocalPoint", "GetFocalPoint", "SetViewUp", "GetViewUp",
    "SetViewAngle", "GetViewAngle", "SetParallelProjection", "GetParallelProjection",
    "SetParallelScale", "GetParallelScale", "SetClippingRange", "GetClippingRange",
    "Azimuth", "Elevation", "Dolly", "Zoom", "OrthogonalizeViewUp", "GetDistance", "GetDirectionOfProjection",
  ]),
  // Props.
  ...group("vtkActor", ["SetMapper", "GetMapper", "GetProperty", "SetProperty", "GetBounds"]),
  ...group("vtkProp", ["SetVisibility", "GetVisibility", "SetPickable", "GetPickable"]),
  ...group("vtkProperty", [
    "SetColor", "GetColor", "SetEdgeVisibility", "SetEdgeColor", "SetRepresentation", "SetOpacity",
    "SetPointSize", "SetLineWidth", "SetAmbient", "SetDiffuse", "SetSpecular", "SetSpecularPower",
    "SetBackfaceCulling", "SetLighting", "SetInterpolation",
  ]),
  // Mappers, scalar colouring and clipping.
  ...group("vtkPolyDataMapper", ["SetInputData", "GetInput"]),
  ...group("vtkMapper", [
    "SetLookupTable", "SetUseLookupTableScalarRange", "SetScalarRange", "SetScalarVisibility",
    "SetScalarModeToUsePointData", "SetScalarModeToUseCellData", "SetScalarModeToUsePointFieldData",
    "SetScalarModeToDefault", "SetInterpolateScalarsBeforeMapping", "SelectColorArray", "SetColorModeToMapScalars",
    "SetRelativeCoincidentTopologyPolygonOffsetParameters", "SetRelativeCoincidentTopologyLineOffsetParameters", "SetRelativeCoincidentTopologyPointOffsetParameter",
  ]),
  ...group("vtkAbstractMapper", ["AddClippingPlane", "RemoveAllClippingPlanes", "RemoveClippingPlane"]),
  ...group("vtkColorTransferFunction", ["AddRGBPoint", "RemoveAllPoints", "SetNanColor", "SetColorSpaceToRGB"]),
  ...group("vtkPlane", ["SetOrigin", "GetOrigin", "SetNormal", "GetNormal"]),
  // Geometry upload.
  ...group("vtkPolyData", ["SetPoints", "SetVerts", "SetLines", "SetPolys", "GetPointData", "GetCellData", "GetNumberOfPoints", "GetNumberOfCells", "GetBounds"]),
  ...group("vtkPoints", ["SetData", "GetNumberOfPoints"]),
  ...group("vtkCellArray", ["SetData", "GetNumberOfCells", "GetOffsetsArray", "GetConnectivityArray", "ImportLegacyFormat"]),
  ...group("vtkDataSetAttributes", ["SetScalars", "SetVectors", "AddArray", "SetActiveScalars", "SetActiveVectors"]),
  ...group("vtkAbstractArray", ["SetNumberOfComponents", "SetName", "GetNumberOfValues", "GetDataType", "GetDataTypeSize"]),
  ...group("vtkFloatArray", ["SetArray", "GetPointer"]),
  ...group("vtkTypeInt32Array", ["SetArray", "GetPointer"]),
  // Glyphs (quiver, spheres, beams, normals).
  ...group("vtkGlyph3DMapper", [
    "SetInputData", "SetSourceData", "SetOrientationArray", "SetOrientationModeToDirection", "SetScaleArray",
    "SetScaleModeToScaleByMagnitude", "SetScaleModeToScaleByVectorComponents", "SetScaleModeToNoDataScaling",
    "SetScaleFactor", "SetScaling", "SetOrient",
  ]),
  ...group("vtkArrowSource", ["SetTipResolution", "SetShaftResolution", "Update", "GetOutput"]),
  ...group("vtkSphereSource", ["SetRadius", "SetThetaResolution", "SetPhiResolution", "Update", "GetOutput"]),
  // Picking.
  ...group("vtkCellPicker", ["GetCellId", "GetMapperNormal", "SetPickClippingPlanes", "SetTolerance"]),
  ...group("vtkAbstractPicker", ["Pick", "GetPickPosition"]),
  ...group("vtkAbstractPropPicker", ["GetActor"]),
  // Annotations.
  ...group("vtkScalarBarActor", ["SetLookupTable", "SetTitle", "SetNumberOfLabels", "SetOrientationToVertical", "SetOrientationToHorizontal", "GetTitleTextProperty", "GetLabelTextProperty", "SetDrawNanAnnotation", "SetMaximumWidthInPixels", "SetMaximumHeightInPixels", "SetUnconstrainedFontSize"]),
  ...group("vtkActor2D", ["SetPosition", "SetPosition2"]),
  ...group("vtkTextProperty", ["SetColor", "SetFontSize", "SetBold", "SetItalic", "SetShadow"]),
  ...group("vtkCubeAxesActor", ["SetCamera", "SetBounds", "SetXTitle", "SetYTitle", "SetZTitle", "GetTitleTextProperty", "GetLabelTextProperty", "SetDrawXGridlines", "SetDrawYGridlines", "SetDrawZGridlines", "GetXAxesLinesProperty", "GetYAxesLinesProperty", "GetZAxesLinesProperty", "GetXAxesGridlinesProperty", "GetYAxesGridlinesProperty", "GetZAxesGridlinesProperty", "SetFlyModeToStaticEdges", "SetFlyModeToOuterEdges", "SetScreenSize"]),
  ...group("vtkAnnotatedCubeActor", ["SetXPlusFaceText", "SetXMinusFaceText", "SetYPlusFaceText", "SetYMinusFaceText", "SetZPlusFaceText", "SetZMinusFaceText", "GetCubeProperty", "GetTextEdgesProperty", "SetFaceTextScale", "SetTextEdgesVisibility", "SetXFaceTextRotation", "SetYFaceTextRotation", "SetZFaceTextRotation", "GetXPlusFaceProperty", "GetXMinusFaceProperty", "GetYPlusFaceProperty", "GetYMinusFaceProperty", "GetZPlusFaceProperty", "GetZMinusFaceProperty"]),
  ...group("vtkAxesActor", ["SetTotalLength", "SetShaftTypeToCylinder", "SetXAxisLabelText", "SetYAxisLabelText", "SetZAxisLabelText", "GetXAxisShaftProperty", "GetYAxisShaftProperty", "GetZAxisShaftProperty", "GetXAxisTipProperty", "GetYAxisTipProperty", "GetZAxisTipProperty"]),
  ...group("vtkTextActor", ["SetInput", "GetTextProperty"]),
];

/**
 * The methods above whose parameters are C++ `bool`: the invoker accepts only
 * a JS boolean for these and only an integer for every other flag
 * (vtkWasmMethodTable.ts `boolParamProblems` keeps this honest at build time).
 */
export const VTK_WASM_BOOL_PARAM_METHODS: ReadonlySet<string> = new Set([
  "SetDrawXGridlines",
  "SetDrawYGridlines",
  "SetDrawZGridlines",
  "SetLighting",
  "SetOrient",
  "SetScaling",
  "SetUnconstrainedFontSize",
  "SetUseFXAA",
  "SetUseOIT",
]);
