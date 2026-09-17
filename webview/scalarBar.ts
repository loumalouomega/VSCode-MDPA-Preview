// In-scene legend for the active field/mesh-size coloring (Phase 1.6): a
// vtkScalarBarActor fed the same color transfer function as the mapper it
// annotates, theme-aware like gridAxes.ts. Optional — the DOM legend in the
// field panel remains the default; this is for a legend that survives into a
// screenshot.

import "@kitware/vtk.js/Rendering/OpenGL/Profiles/Geometry";
import vtkScalarBarActor from "@kitware/vtk.js/Rendering/Core/ScalarBarActor";
import { ScalarBarOrientation } from "../src/parser/paneView";

export interface ScalarBar {
  setVisible(visible: boolean): void;
  /** Feeds the same CTF the mapper uses, and the axis title (variable name). */
  configure(ctf: any, title: string): void;
  /** Vertical (default, right side) or horizontal ("Cornejo's mode", bottom). */
  setOrientation(orientation: ScalarBarOrientation): void;
  updateTheme(theme: string): void;
  /** Tears the actor out of its renderer — a pane removed by a layout change
   *  takes its scalar bar with it (the GridAxes.dispose() arrangement). */
  dispose(): void;
}

const LIGHT_THEMES = new Set(["light", "scientific"]);

// Vertical: right side, tall and narrow. Horizontal ("Cornejo's mode"):
// bottom-center, wide and short — clear of the nav controls (bottom-left)
// and the VTK timeline bar (full-width strip at the very bottom).
const VERTICAL_POSITION = [0.78, 0.08];
const VERTICAL_SIZE = [0.16, 0.62];
const HORIZONTAL_POSITION = [0.3, 0.1];
const HORIZONTAL_SIZE = [0.44, 0.12];

function isDarkTheme(theme: string): boolean {
  return !LIGHT_THEMES.has(theme);
}

export function setupScalarBar(renderer: any, initialTheme: string): ScalarBar {
  const actor: any = vtkScalarBarActor.newInstance();
  actor.setVisibility(false);
  actor.setDrawNanAnnotation(false);
  actor.setAxisTitlePixelOffset(18);
  actor.setTickLabelPixelOffset(8);
  // Bottom-right, small enough to stay out of the way of the outline/panels
  // which live on the left, and the nav controls/timeline at the bottom-left.
  actor.setOrientationToVertical();
  actor.setBarPosition(VERTICAL_POSITION);
  actor.setBarSize(VERTICAL_SIZE);
  renderer.addActor(actor);

  function applyThemeColors(theme: string): void {
    const dark = isDarkTheme(theme);
    const labelColor = dark ? "white" : "#222222";
    actor.setAxisTextStyle({ fontColor: labelColor, fontFamily: "Arial", fontSize: 13 });
    actor.setTickTextStyle({ fontColor: labelColor, fontFamily: "Arial", fontSize: 11 });
  }

  applyThemeColors(initialTheme);

  return {
    setVisible(visible: boolean): void {
      actor.setVisibility(visible);
    },
    configure(ctf: any, title: string): void {
      actor.setAxisLabel(title);
      actor.setScalarsToColors(ctf);
    },
    setOrientation(orientation: ScalarBarOrientation): void {
      if (orientation === "horizontal") {
        actor.setOrientationToHorizontal();
        actor.setBarPosition(HORIZONTAL_POSITION);
        actor.setBarSize(HORIZONTAL_SIZE);
      } else {
        actor.setOrientationToVertical();
        actor.setBarPosition(VERTICAL_POSITION);
        actor.setBarSize(VERTICAL_SIZE);
      }
    },
    updateTheme(theme: string): void {
      applyThemeColors(theme);
    },
    dispose(): void {
      renderer.removeActor(actor);
      actor.delete();
    },
  };
}
