// Burns a color-legend into a captured screenshot (Phase 1.7). The in-scene
// vtkScalarBarActor (scalarBar.ts) is the primary way to get a legend into a
// screenshot; this is the fallback/complement for when it's off — the DOM
// legend in the field panel never appears in captureNextImage()'s output
// since it isn't part of the WebGL canvas.

import { ColorStop, canLogScale, legendTicks } from "../src/parser/fieldScalars";

export interface LegendSpec {
  stops: ColorStop[];
  min: number;
  max: number;
  log?: boolean;
  title: string;
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return "–";
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1000 || a < 0.01) return v.toExponential(2);
  return v.toFixed(3);
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to decode captured image"));
    img.src = dataUrl;
  });
}

/** Draws `legend` onto a copy of the PNG at `dataUrl`, returning a new data URL. */
export async function compositeLegend(dataUrl: string, legend: LegendSpec): Promise<string> {
  const img = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0);

  const barW = Math.max(16, Math.round(canvas.width * 0.014));
  const barH = Math.min(canvas.height * 0.4, 260);
  const margin = Math.round(canvas.width * 0.02) + 8;
  const x = canvas.width - margin - barW;
  const yBottom = canvas.height - margin;
  const yTop = yBottom - barH;

  // Bottom-to-top gradient (min at the bottom, matching the panel's left→right
  // low→high convention rotated 90°).
  const grad = ctx.createLinearGradient(0, yBottom, 0, yTop);
  for (const [t, r, g, b] of legend.stops) {
    grad.addColorStop(t, `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`);
  }
  ctx.fillStyle = grad;
  ctx.fillRect(x, yTop, barW, barH);
  ctx.strokeStyle = "rgba(0,0,0,0.6)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, yTop + 0.5, barW - 1, barH - 1);

  // White text with a dark stroke reads over any colormap/background.
  ctx.font = `${Math.max(12, Math.round(canvas.width * 0.011))}px sans-serif`;
  ctx.textBaseline = "middle";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.fillStyle = "#fff";
  const drawText = (text: string, tx: number, ty: number, align: CanvasTextAlign): void => {
    ctx.textAlign = align;
    ctx.strokeText(text, tx, ty);
    ctx.fillText(text, tx, ty);
  };

  const useLog = !!legend.log && canLogScale(legend.min, legend.max);
  const ticks = legendTicks(legend.min, legend.max, useLog, 5);
  ticks.forEach((v, i) => {
    const t = ticks.length > 1 ? i / (ticks.length - 1) : 0.5;
    const ty = yBottom - t * barH;
    drawText(fmt(v), x - 6, ty, "right");
  });

  drawText(legend.title, x + barW / 2, yTop - 14, "center");

  return canvas.toDataURL("image/png");
}
