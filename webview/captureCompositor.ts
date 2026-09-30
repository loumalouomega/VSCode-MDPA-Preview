import { CaptureCorner, CaptureRect } from "../src/parser/capturePlan";
import { drawLegendInRect, LegendSpec } from "./screenshotLegend";

export interface CaptureOverlay {
  rect: CaptureRect;
  legend?: LegendSpec;
  label?: string;
}
/** One decoration path for screenshots and recording frames. No image round trip. */
export function composeCaptureOverlays(ctx: CanvasRenderingContext2D, overlays: CaptureOverlay[], options: {
  fontSize?: number; corner?: CaptureCorner; separators?: boolean;
  title?: string; caption?: string; captionPosition?: "top" | "bottom";
} = {}): void {
  ctx.save();
  try {
    const font = options.fontSize ?? 16;
    if (!Number.isFinite(font) || font < 8 || font > 96) throw new Error("Text size must be between 8 and 96 pixels.");
    const text = (value: string, x: number, y: number, maxWidth: number, align: CanvasTextAlign = "left"): void => {
      ctx.font = `${font}px sans-serif`;
      ctx.textAlign = align;
      ctx.textBaseline = "top";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.fillStyle = "white";
      ctx.strokeText(value, x, y, Math.max(1, maxWidth));
      ctx.fillText(value, x, y, Math.max(1, maxWidth));
    };
    for (const o of overlays) {
      ctx.save();
      ctx.beginPath(); ctx.rect(o.rect.x, o.rect.y, o.rect.width, o.rect.height); ctx.clip();
      if (options.separators) {
        ctx.strokeStyle = "rgba(160,160,160,0.9)";
        ctx.lineWidth = 1;
        ctx.strokeRect(o.rect.x, o.rect.y, o.rect.width, o.rect.height);
      }
      if (o.legend) drawLegendInRect(ctx, o.legend, o.rect, { corner: options.corner, fontSize: options.fontSize });
      if (o.label) text(o.label, o.rect.x + 12, o.rect.y + 12, o.rect.width - 24);
      ctx.restore();
    }
    if (options.title) text(options.title, ctx.canvas.width / 2, 12, ctx.canvas.width - 24, "center");
    const lines = options.caption?.split("\n") ?? [];
    const y = options.captionPosition === "top" ? 16 + (options.title ? font * 1.5 : 0) : ctx.canvas.height - 12 - lines.length * font * 1.3;
    lines.forEach((line, i) => text(line, ctx.canvas.width / 2, y + i * font * 1.3, ctx.canvas.width - 24, "center"));
  } finally { ctx.restore(); }
}
