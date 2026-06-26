import vtkAnnotatedCubeActor from "@kitware/vtk.js/Rendering/Core/AnnotatedCubeActor";
import vtkAxesActor from "@kitware/vtk.js/Rendering/Core/AxesActor";
import vtkOrientationMarkerWidget from "@kitware/vtk.js/Interaction/Widgets/OrientationMarkerWidget";
import vtkCellPicker from "@kitware/vtk.js/Rendering/Core/CellPicker";

const FACE_COLOR_DARK = "#1e1e2e";

/** Set up the orientation cube in the bottom-left corner. Always visible. */
export function setupOrientationCube(
  renderWindow: any,
  renderer: any,
  interactor: any,
  canvas: HTMLCanvasElement
): void {
  const cube = vtkAnnotatedCubeActor.newInstance();

  cube.setDefaultStyle({
    text: "",
    fontStyle: "bold",
    fontFamily: "Arial",
    fontColor: "white",
    faceColor: FACE_COLOR_DARK,
    // Dark edge creates a visible "cut" groove between adjacent faces.
    edgeThickness: 0.08,
    edgeColor: "#080808",
    resolution: 400,
  });

  // Kratos convention: Y-up, X-right, Z-front
  cube.setXPlusFaceProperty({ text: "RIGHT", faceColor: "#7a1e1e" });
  cube.setXMinusFaceProperty({ text: "LEFT",  faceColor: "#4a1010" });
  cube.setYPlusFaceProperty({ text: "TOP",    faceColor: "#1e6b1e" });
  cube.setYMinusFaceProperty({ text: "BOTTOM",faceColor: "#104010" });
  cube.setZPlusFaceProperty({ text: "FRONT",  faceColor: "#1e3d7a" });
  cube.setZMinusFaceProperty({ text: "REAR",  faceColor: "#102050" });

  const widget = vtkOrientationMarkerWidget.newInstance();
  widget.setActor(cube as any);
  widget.setInteractor(interactor);
  // Bottom-left corner, 15% of the smaller window dimension
  widget.setViewportCorner(vtkOrientationMarkerWidget.Corners.BOTTOM_LEFT);
  widget.setViewportSize(0.15);
  widget.setMinPixelSize(80);
  widget.setMaxPixelSize(160);
  widget.setEnabled(true);

  // Add XYZ axis arrows to the same widget renderer so they rotate with the
  // cube.  Arrows are anchored at the back-bottom-left corner of the cube
  // (-0.5,-0.5,-0.5) so their shafts travel along the cube edges rather
  // than through the interior.  Scale 1.4 puts the tips 0.4 units past each
  // opposing cube face so the letter labels are clearly outside the cube.
  // setX/Y/ZAxisColor each take a [r,g,b] array (0-255 range) despite the .d.ts.
  const axes = vtkAxesActor.newInstance();
  (axes as any).setConfig({ recenter: false });
  (axes as any).setXAxisColor([220, 50,  50 ]);
  (axes as any).setYAxisColor([50,  200, 50 ]);
  (axes as any).setZAxisColor([50,  100, 255]);
  (axes as any).setPosition(-0.5, -0.5, -0.5);
  (axes as any).setScale(1.4, 1.4, 1.4);
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
}

function snapCamera(renderer: any, renderWindow: any, normal: number[]): void {
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
