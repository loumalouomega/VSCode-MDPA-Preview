// Pure (no vscode/DOM/vtk) camera-state JSON: the shape behind the Camera
// Bookmarks panel's "Copy/Apply camera JSON" textarea. Validates untrusted
// pasted text before anything touches a real vtk.js camera.

export interface CameraState {
  position: [number, number, number];
  focalPoint: [number, number, number];
  viewUp: [number, number, number];
  parallelScale: number;
}

function isVec3(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x));
}

export function isCameraState(v: unknown): v is CameraState {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return (
    isVec3(c.position) &&
    isVec3(c.focalPoint) &&
    isVec3(c.viewUp) &&
    typeof c.parallelScale === "number" &&
    Number.isFinite(c.parallelScale)
  );
}

/** Parses + validates a camera-state JSON string; undefined on any failure. */
export function parseCameraJson(text: string): CameraState | undefined {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isCameraState(obj) ? obj : undefined;
}

export function cameraStateToJson(state: CameraState): string {
  return JSON.stringify(state, null, 2);
}
