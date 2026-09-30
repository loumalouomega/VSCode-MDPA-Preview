import { validateCaptureSize } from "../../src/parser/capturePlan";

export function validateRenderCapture(canvas: HTMLCanvasElement, width: number, height: number): void {
  const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  if (!gl || gl.isContextLost()) throw new Error("The rendering context is unavailable. Reopen the preview and try again.");
  const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
  validateCaptureSize(width, height, Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), gl.getParameter(gl.MAX_TEXTURE_SIZE), viewport[0], viewport[1]));
}
