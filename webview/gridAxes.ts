import "@kitware/vtk.js/Rendering/OpenGL/CubeAxesActor";
import vtkCubeAxesActor from "@kitware/vtk.js/Rendering/Core/CubeAxesActor";

export interface GridAxes {
  setVisible(visible: boolean): void;
  updateBounds(bounds: [number, number, number, number, number, number]): void;
  updateTheme(theme: string): void;
}

const LIGHT_THEMES = new Set(["light", "scientific"]);

function isDarkTheme(theme: string): boolean {
  return !LIGHT_THEMES.has(theme);
}

export function setupGridAxes(renderer: any, initialTheme: string): GridAxes {
  const actor: any = vtkCubeAxesActor.newInstance();

  actor.setCamera(renderer.getActiveCamera());
  actor.setAxisLabels(["X", "Y", "Z"]);
  actor.setGridLines(true);
  actor.setVisibility(false);
  renderer.addActor(actor);

  function applyThemeColors(theme: string): void {
    const dark = isDarkTheme(theme);
    const labelColor = dark ? "white" : "#222222";
    const gridRgb: [number, number, number] = dark ? [0.45, 0.45, 0.45] : [0.35, 0.35, 0.35];

    actor.setAxisTextStyle({ fontColor: labelColor, fontFamily: "Arial" });
    actor.setTickTextStyle({ fontColor: labelColor, fontFamily: "Arial" });
    actor.getProperty().setColor(...gridRgb);
  }

  applyThemeColors(initialTheme);

  return {
    setVisible(visible: boolean): void {
      actor.setVisibility(visible);
    },

    updateBounds(bounds: [number, number, number, number, number, number]): void {
      actor.setDataBounds(bounds);
    },

    updateTheme(theme: string): void {
      applyThemeColors(theme);
    },
  };
}
