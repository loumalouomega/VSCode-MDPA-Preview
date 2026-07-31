import vtkAnnotatedCubeActor from "@kitware/vtk.js/Rendering/Core/AnnotatedCubeActor";
import vtkAxesActor from "@kitware/vtk.js/Rendering/Core/AxesActor";
import vtkOrientationMarkerWidget from "@kitware/vtk.js/Interaction/Widgets/OrientationMarkerWidget";
import vtkCellPicker from "@kitware/vtk.js/Rendering/Core/CellPicker";

/* Face/edge colours and axis-arrow colours are shared with the sibling
   CAD-Preview's orientation cube (uniform light-blue faces, white bold
   labels, matching RGB arrows) so the two extensions read as one family.
   These match the RENDERED appearance of the reference cube — Three.js
   draws its #2b6cb0 texture noticeably brighter than the raw hex. */
const FACE_COLOR = "#85b5da";
const EDGE_COLOR = "#5a87ae";
const LIGHT_THEMES = new Set(["light", "scientific"]);

export interface OrientationCubeHandle {
  updateTheme(theme: string): void;
}

/** Set up the orientation cube in the top-left corner. Always visible. */
export function setupOrientationCube(
  renderWindow: any,
  renderer: any,
  interactor: any,
  canvas: HTMLCanvasElement
): OrientationCubeHandle {
  const cube = vtkAnnotatedCubeActor.newInstance();

  cube.setDefaultStyle({
    text: "",
    fontStyle: "bold",
    fontFamily: "Arial",
    fontColor: "white",
    // The reference draws its labels at ~20% of the face texture height so
    // even "BOTTOM" fits with margins; vtk.js's default scale overflows the
    // face and crops the word.
    fontSizeScale: (resolution: number) => resolution / 5,
    faceColor: FACE_COLOR,
    // Darker-blue edge creates a visible "cut" groove between adjacent faces.
    edgeThickness: 0.08,
    edgeColor: EDGE_COLOR,
    resolution: 400,
  } as any);

  // The reference cube is unlit — its face texture shows the true blue.
  // Without this the scene light shades the faces darker and unevenly.
  cube.getProperty().setAmbient(1);
  cube.getProperty().setDiffuse(0);

  // Kratos convention: Y-up, X-right, Z-front
  cube.setXPlusFaceProperty({ text: "RIGHT" });
  cube.setXMinusFaceProperty({ text: "LEFT" });
  cube.setYPlusFaceProperty({ text: "TOP" });
  cube.setYMinusFaceProperty({ text: "BOTTOM" });
  cube.setZPlusFaceProperty({ text: "FRONT" });
  cube.setZMinusFaceProperty({ text: "BACK" });

  const widget = vtkOrientationMarkerWidget.newInstance();
  widget.setActor(cube as any);
  widget.setInteractor(interactor);
  // Top-left corner (like the reference), 15% of the smaller window dimension
  widget.setViewportCorner(vtkOrientationMarkerWidget.Corners.TOP_LEFT);
  widget.setViewportSize(0.15);
  widget.setMinPixelSize(80);
  widget.setMaxPixelSize(160);
  widget.setEnabled(true);

  // Colored X/Y/Z axis arrows inside the widget renderer so they rotate with
  // the cube. Like the reference triad: anchored at the cube's center so each
  // arrow emerges through the middle of its face, chunky conical tips, and no
  // letter labels — the labeled faces already name the directions.
  const axes = vtkAxesActor.newInstance();
  (axes as any).setConfig({
    recenter: false,
    xLabel: "",
    yLabel: "",
    zLabel: "",
    tipLength: 0.3,
    tipRadius: 0.12,
    shaftRadius: 0.035,
  });
  (axes as any).setXAxisColor([255, 54,  83 ]); // #ff3653
  (axes as any).setYAxisColor([138, 219, 0  ]); // #8adb00
  (axes as any).setZAxisColor([44,  143, 255]); // #2c8fff
  (axes as any).setScale(1.15, 1.15, 1.15);
  widget.getRenderer().addActor(axes);

  const picker = vtkCellPicker.newInstance();

  canvas.addEventListener(
    "pointerdown",
    (ev: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const displayX = ev.clientX - rect.left;
      // VTK y-up: flip from browser y-down
      const displayY = rect.height - (ev.clientY - rect.top);

      const xNorm = displayX / rect.width;
      const yNorm = displayY / rect.height;

      const vp = widget.computeViewport(); // [left, bottom, right, top] in [0,1]
      if (xNorm >= vp[0] && xNorm <= vp[2] && yNorm >= vp[1] && yNorm <= vp[3]) {
        // Prevent VTK from starting a rotate/pan in the widget area.
        ev.stopImmediatePropagation();

        picker.pick([displayX, displayY, 0], widget.getRenderer());

        const actors: any[] = picker.getActors();
        if (actors.length > 0) {
          const normal: number[] = picker.getMapperNormal();
          const len = Math.sqrt(normal[0] ** 2 + normal[1] ** 2 + normal[2] ** 2);
          if (len > 0.5) {
            snapCamera(renderer, renderWindow, normal);
          }
        }
      }
    },
    true // capture phase — fires before VTK's bubble-phase listeners
  );

  function applyLabelColor(theme: string): void {
    const dark = !LIGHT_THEMES.has(theme);
    const rgb: [number, number, number] = dark ? [1, 1, 1] : [0.2, 0.2, 0.2];
    // Try the vtk.js caption-actor path for label color.
    try {
      for (const getter of [
        "getXAxisCaptionActor2D",
        "getYAxisCaptionActor2D",
        "getZAxisCaptionActor2D",
      ] as const) {
        const cap = (axes as any)[getter]?.();
        cap?.getCaptionTextProperty?.()?.setColor(...rgb);
      }
    } catch {
      // Label color is cosmetic; white is acceptable as fallback on all themes.
    }
    renderWindow.render();
  }

  applyLabelColor(document.body.dataset.theme ?? "auto");

  return {
    updateTheme(theme: string): void {
      applyLabelColor(theme);
    },
  };
}

/**
 * Snaps the camera to look along `normal` (one of the 6 axis directions, or
 * any unit vector for an isometric-style view), keeping the current focal
 * point and distance. Exported for the Standard Views keyboard shortcuts
 * (1–6, i) in main.ts, which reuse this rather than duplicating the viewUp
 * flip logic for a near-vertical look direction.
 */
export function snapCamera(renderer: any, renderWindow: any, normal: number[]): void {
  const camera = renderer.getActiveCamera();
  const focal: number[] = camera.getFocalPoint();
  const dist: number = camera.getDistance();

  camera.setPosition(
    focal[0] + normal[0] * dist,
    focal[1] + normal[1] * dist,
    focal[2] + normal[2] * dist
  );

  // When looking along ±Y the default [0,1,0] viewUp is parallel to the view
  // direction, so switch to ±Z instead.
  if (Math.abs(normal[1]) > 0.9) {
    camera.setViewUp(0, 0, normal[1] > 0 ? -1 : 1);
  } else {
    camera.setViewUp(0, 1, 0);
  }

  renderer.resetCameraClippingRange();
  renderWindow.render();
}
