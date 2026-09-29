/** Pure screenshot geometry and presentation policy, shared with the webview. */
import { paneCssRect, paneViewports, PaneLayoutId } from "./paneLayout";

export type CaptureCorner = "bottom-right" | "bottom-left" | "top-right" | "top-left";
export interface CaptureSettings {
  scope: "layout" | "focused";
  resolution: "1" | "2" | "4" | "custom";
  width: number;
  height: number;
  background: "scene" | "white" | "black" | "custom" | "transparent";
  color: string;
  legends: boolean;
  corner: CaptureCorner;
  fontSize: number;
  labels: boolean;
  title: string;
  caption: string;
  captionPosition: "top" | "bottom";
}
export const DEFAULT_CAPTURE_SETTINGS: CaptureSettings = {
  scope: "layout", resolution: "1", width: 1920, height: 1080,
  background: "scene", color: "#ffffff", legends: true, corner: "bottom-right",
  fontSize: 16, labels: true, title: "", caption: "", captionPosition: "bottom",
};
export interface CaptureRect { x: number; y: number; width: number; height: number }
export interface CapturePlan {
  width: number; height: number; renderWidth: number; renderHeight: number;
  crop: CaptureRect; destination: CaptureRect;
  panes: { index: number; rect: CaptureRect }[];
}
export function validateCaptureSize(width: number, height: number, maxAxis = 8192): void {
  if (![width, height].every(n => Number.isInteger(n) && n > 0)) throw new Error("Capture dimensions must be positive whole pixels.");
  if (width > Math.min(8192, maxAxis) || height > Math.min(8192, maxAxis) || width * height > 16_000_000) {
    throw new Error("Capture exceeds the renderer limit (at most 8192 pixels per side and 16 megapixels, including the full-layout render buffer). Reduce dimensions or scale.");
  }
}
export function buildCapturePlan(s: CaptureSettings, w: number, h: number, layout: PaneLayoutId, focus: number): CapturePlan {
  const rects = paneViewports(layout).map(v => {
    const r = paneCssRect(v);
    return { x: r.left / 100, y: r.top / 100, width: r.width / 100, height: r.height / 100 };
  });
  const source = s.scope === "focused" ? rects[focus] : { x: 0, y: 0, width: 1, height: 1 };
  if (!source) throw new Error("The selected pane no longer exists.");
  const sw = w * source.width, sh = h * source.height;
  const width = s.resolution === "custom" ? s.width : Math.round(sw * Number(s.resolution));
  const height = s.resolution === "custom" ? s.height : Math.round(sh * Number(s.resolution));
  validateCaptureSize(width, height);
  const scale = Math.min(width / sw, height / sh);
  const renderWidth = Math.max(1, Math.round(w * scale));
  const renderHeight = Math.max(1, Math.round(h * scale));
  validateCaptureSize(renderWidth, renderHeight);
  const crop = { x: source.x * renderWidth, y: source.y * renderHeight, width: source.width * renderWidth, height: source.height * renderHeight };
  const fit = Math.min(width / crop.width, height / crop.height);
  const destination = { x: (width - crop.width * fit) / 2, y: (height - crop.height * fit) / 2, width: crop.width * fit, height: crop.height * fit };
  const panes = rects.flatMap((r, index) => s.scope === "focused" && index !== focus ? [] : [{ index, rect: {
    x: destination.x + (r.x * renderWidth - crop.x) * fit,
    y: destination.y + (r.y * renderHeight - crop.y) * fit,
    width: r.width * renderWidth * fit, height: r.height * renderHeight * fit,
  } }]);
  return { width, height, renderWidth, renderHeight, crop, destination, panes };
}
export function captureBackground(s: CaptureSettings): [number, number, number, number] | undefined {
  if (s.background === "scene") return undefined;
  if (s.background === "transparent") return [0, 0, 0, 0];
  const color = s.background === "white" ? "#ffffff" : s.background === "black" ? "#000000" : s.color;
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error("Choose a valid background color.");
  return [parseInt(color.slice(1, 3), 16) / 255, parseInt(color.slice(3, 5), 16) / 255, parseInt(color.slice(5, 7), 16) / 255, 1];
}
export function captureFieldLabel(variable: string, components: number, component: string | number, units?: Record<string, string>): string {
  const suffix = components > 1 ? ` · ${component === "mag" ? "Magnitude" : (typeof component === "number" ? ["X", "Y", "Z"][component] ?? `Component ${component}` : component.toUpperCase())}` : "";
  return `${variable}${suffix}${units?.[variable] ? ` [${units[variable]}]` : ""}`;
}
export function captureStepLabel(label?: string, kind?: "time" | "step", unit?: string): string {
  return label === undefined || label === "" ? "" : `${kind === "time" ? "Time" : "Step"}: ${label}${kind === "time" && unit ? ` ${unit}` : ""}`;
}
