import type { PlotFamily } from "../../src/parser/plot/types";
import type { UiGlyphId } from "../../src/uiGlyphs";

export const CHART_CHOICES: { family: PlotFamily; label: string; icon: UiGlyphId; hint: string }[] = [
  { family: "line", label: "Line", icon: "chartLine", hint: "Histories and profiles, with optional markers" },
  { family: "step", label: "Step", icon: "chartStep", hint: "Hold each sample until the next; no interpolation" },
  { family: "area", label: "Area", icon: "chartArea", hint: "Fill covered intervals to zero; not an integral" },
  { family: "scatter", label: "Pure scatter", icon: "chartScatter", hint: "XY samples only, without connecting lines" },
  { family: "bubble", label: "Bubble", icon: "chartBubble", hint: "XY samples with an explicit marker-area column" },
  { family: "bar", label: "Bars", icon: "chartBar", hint: "Category statistics; grouped, stacked or horizontal" },
  { family: "pie", label: "Pie", icon: "chartPie", hint: "Nonnegative category shares; choose a statistic explicitly" },
  { family: "doughnut", label: "Doughnut", icon: "chartDoughnut", hint: "Category shares with an open center" },
  { family: "histogram", label: "Histogram", icon: "chartBar", hint: "Equal-width host-computed distribution bins" },
  { family: "box", label: "Box plot", icon: "chartBox", hint: "Quartiles and Tukey whiskers; not uncertainty" },
  { family: "heatmap", label: "Heatmap", icon: "grid3", hint: "XYZ surface with an explicit grid" },
  { family: "contour", label: "Contour", icon: "chartContour", hint: "XYZ isolines with an explicit grid" },
];
