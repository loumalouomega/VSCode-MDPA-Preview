// Which renderer backend a preview gets (roadmap item 18). Pure, so the host
// decision and every fallback message are Node-testable; src/previewHtml.ts
// is the vscode glue and webview/main.ts applies the webview-side fallbacks.

import type { RendererKind } from "./types";

/** The `kratos.preview.renderer` setting's values and their meaning. */
export const RENDERER_SETTING_VALUES: readonly RendererKind[] = ["vtkjs", "vtkwasm"];

/** vtk.js is the default and stays so; VTK-wasm is an experimental opt-in (decision 2026-09-26). */
export const DEFAULT_RENDERER: RendererKind = "vtkjs";

export function parseRendererSetting(raw: unknown): RendererKind {
  return raw === "vtkwasm" || raw === "vtkjs" ? raw : DEFAULT_RENDERER;
}

export type RendererFallbackReason = "assets-missing" | "no-jspi" | "no-webgl2" | "boot-failed" | "boot-timeout";

export interface RendererChoice {
  renderer: RendererKind;
  /** Set when VTK-wasm was requested but the host already knows it cannot run. */
  fallbackReason?: RendererFallbackReason;
}

/**
 * The host-side decision: VTK-wasm only when requested AND its runtime ships
 * in this installation (a dev build without `npm run vtkwasm:prepare`, or a
 * package built with KRATOS_VTK_WASM=skip, has none). Everything that can
 * only be known inside the webview — JSPI, WebGL2, a failed boot — falls back
 * there, with a reason from the same vocabulary.
 */
export function selectRendererAtHost(requested: RendererKind, assetsPresent: boolean): RendererChoice {
  if (requested !== "vtkwasm") return { renderer: "vtkjs" };
  if (!assetsPresent) return { renderer: "vtkjs", fallbackReason: "assets-missing" };
  return { renderer: "vtkwasm" };
}

/** One line for the status area, naming what happened and what still works. */
export function fallbackMessage(reason: RendererFallbackReason, detail?: string): string {
  const why: Record<RendererFallbackReason, string> = {
    "assets-missing": "its runtime is not included in this installation",
    "no-jspi": "this host lacks WebAssembly JSPI (WebAssembly.Suspending), which the VTK-wasm build requires",
    "no-webgl2": "WebGL2 is unavailable",
    "boot-failed": "it failed to start",
    "boot-timeout": "it did not start within the time limit",
  };
  return `VTK-wasm renderer unavailable — ${why[reason]}${detail ? ` (${detail})` : ""}; using vtk.js.`;
}
