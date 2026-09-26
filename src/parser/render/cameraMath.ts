// Camera interaction math for the VTK-wasm backend (roadmap item 18).
//
// The VTK C++ build has no vtkInteractorStyleManipulator, so the webview's
// mouse camera control is re-implemented here as pure functions and applied
// through the session's vtkCamera setters. They are TRANSCRIPTIONS of the
// vtk.js 37.3.0 manipulators the vtk.js backend installs (the formulas, the
// constants and the defaults, including the rotation centre at the world
// origin that vtkInteractorStyleManipulator hands its manipulators), so both
// backends move the camera identically for the same pointer motion:
//
// - MouseCameraTrackballRotateManipulator.onMouseMove
// - MouseCameraTrackballPanManipulator.onMouseMove
// - MouseCameraTrackballZoomManipulator.onButtonDown/onMouseMove/onScroll
//
// Positions are display coordinates with a BOTTOM-LEFT origin, as vtk.js
// passes them; only differences and ratios to the viewport size are used, so
// CSS and canvas pixels give the same result as long as one unit is used for
// both. Pure: no DOM, no vtk.

import type { Vec3 } from "./types";

export interface CameraPose {
  position: Vec3;
  focalPoint: Vec3;
  viewUp: Vec3;
}

export interface CameraLens {
  parallelProjection: boolean;
  parallelScale: number;
  /** Vertical view angle in degrees. */
  viewAngle: number;
  clippingRange: [number, number];
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export function normalize(a: Vec3): Vec3 {
  const n = Math.hypot(a[0], a[1], a[2]);
  return n > 0 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 0];
}

export function directionOfProjection(pose: CameraPose): Vec3 {
  return normalize(sub(pose.focalPoint, pose.position));
}

/** Rodrigues rotation of `v` about the unit-normalized `axis` by `rad`. */
export function rotateAbout(v: Vec3, axis: Vec3, rad: number): Vec3 {
  const k = normalize(axis);
  if (k[0] === 0 && k[1] === 0 && k[2] === 0) return [...v] as Vec3;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const kxv = cross(k, v);
  const kdv = dot(k, v);
  return [
    v[0] * c + kxv[0] * s + k[0] * kdv * (1 - c),
    v[1] * c + kxv[1] * s + k[1] * kdv * (1 - c),
    v[2] * c + kxv[2] * s + k[2] * kdv * (1 - c),
  ];
}

/**
 * vtkCamera::OrthogonalizeViewUp: the view-up re-derived perpendicular to the
 * direction of projection (Gram-Schmidt through the right vector), unit length.
 */
export function orthogonalizeViewUp(pose: CameraPose): Vec3 {
  const dop = directionOfProjection(pose);
  const right = normalize(cross(dop, pose.viewUp));
  return normalize(cross(right, dop));
}

const deg = (d: number): number => (d * Math.PI) / 180;

/**
 * Trackball rotate: azimuth about the view-up and elevation about
 * dop x view-up, both through `center`, by 360 degrees per viewport width
 * (height) of motion. `dx`/`dy` are PREVIOUS minus CURRENT, as in vtk.js.
 */
export function trackballRotate(
  pose: CameraPose,
  dx: number,
  dy: number,
  viewportSize: [number, number],
  center: Vec3 = [0, 0, 0],
  rotationFactor = 1
): CameraPose {
  const up = pose.viewUp;
  const azimuth = deg(((360 * dx) / viewportSize[0]) * rotationFactor);
  const elevAxis = cross(directionOfProjection(pose), up);
  const elevation = deg(((-360 * dy) / viewportSize[1]) * rotationFactor);
  // vtk.js composes T(c) * R(up, az) * R(elevAxis, el) * T(-c): the elevation
  // (rightmost) applies first, both about world-space axes.
  const xf = (p: Vec3): Vec3 => add(rotateAbout(rotateAbout(sub(p, center), elevAxis, elevation), up, azimuth), center);
  const position = xf(pose.position);
  const focalPoint = xf(pose.focalPoint);
  const upPoint = xf(add(pose.position, up));
  const next: CameraPose = { position, focalPoint, viewUp: sub(upPoint, position) };
  return { ...next, viewUp: orthogonalizeViewUp(next) };
}

/**
 * Trackball pan. `from`/`to` are display positions (bottom-left origin) and
 * `viewportHeight` is in the same unit. Parallel projection moves by the
 * parallel scale; perspective moves the world point under the cursor at the
 * depth of `center`, which is what vtk.js's display<->world round trip at
 * `center`'s display depth amounts to.
 */
export function trackballPan(
  pose: CameraPose,
  lens: CameraLens,
  from: [number, number],
  to: [number, number],
  viewportHeight: number,
  center: Vec3 = [0, 0, 0]
): CameraPose {
  if (lens.parallelProjection) {
    const up = orthogonalizeViewUp(pose);
    const vpn = scale(directionOfProjection(pose), -1);
    const right = cross(vpn, up);
    const k = (lens.parallelScale * 2) / viewportHeight;
    const dx = (to[0] - from[0]) * k;
    const dy = (from[1] - to[1]) * k;
    const t = add(scale(right, dx), scale(up, dy));
    return { position: add(pose.position, t), focalPoint: add(pose.focalPoint, t), viewUp: up };
  }
  const dop = directionOfProjection(pose);
  const up = orthogonalizeViewUp(pose);
  const right = normalize(cross(dop, up));
  const depth = dot(sub(center, pose.position), dop);
  const perPixel = (2 * depth * Math.tan(deg(lens.viewAngle) / 2)) / viewportHeight;
  // worldPoint(to) - worldPoint(from), moved against: the grabbed point follows the cursor.
  const moved = add(scale(right, (to[0] - from[0]) * perPixel), scale(up, (to[1] - from[1]) * perPixel));
  const t = scale(moved, -1);
  return { position: add(pose.position, t), focalPoint: add(pose.focalPoint, t), viewUp: pose.viewUp };
}

/** The zoom-drag scale fixed at button-down (vtk.js onButtonDown). */
export function zoomDragScale(lens: CameraLens, viewportHeight: number): number {
  return lens.parallelProjection ? 1.5 / viewportHeight : 1.5 * (lens.clippingRange[1] / viewportHeight);
}

export type ZoomResult = { pose: CameraPose } | { parallelScale: number };

/** Zoom by dragging: `dy` is PREVIOUS minus CURRENT display y. */
export function zoomDrag(pose: CameraPose, lens: CameraLens, dy: number, zoomScale: number): ZoomResult {
  const k = dy * zoomScale;
  if (lens.parallelProjection) return { parallelScale: (1 - k) * lens.parallelScale };
  const t = scale(directionOfProjection(pose), k);
  return { pose: { position: add(pose.position, t), focalPoint: add(pose.focalPoint, t), viewUp: pose.viewUp } };
}

/**
 * Wheel zoom. `spinY` is the normalized wheel delta (vtk.js normalizes a first
 * notch to +-1). Returns the dolly factor for perspective, or the new parallel
 * scale.
 */
export function scrollZoom(lens: CameraLens, spinY: number): { dolly: number } | { parallelScale: number } {
  const dyf = 1 - spinY / 10;
  return lens.parallelProjection ? { parallelScale: lens.parallelScale / dyf } : { dolly: dyf };
}

/**
 * vtk.js's wheel normalization, reduced to what the scroll zoom reads: the
 * first event of a gesture fixes a coefficient (its |spinY| when >= 0.3) and
 * later events are divided by it, so a notch is about +-1 on every device.
 */
export class WheelNormalizer {
  private coefficient = 1;
  private lastTime = -Infinity;
  normalize(deltaY: number, deltaMode: number, now: number): number {
    // DOM_DELTA_LINE / PAGE to pixels, then pixels to "spins" (vtk.js: /100 px).
    const px = deltaMode === 1 ? deltaY * 40 : deltaMode === 2 ? deltaY * 800 : deltaY;
    const spin = px / 100;
    if (now - this.lastTime > 200) this.coefficient = Math.abs(spin) >= 0.3 ? Math.abs(spin) : 1;
    this.lastTime = now;
    return spin / this.coefficient;
  }
}

/**
 * The eye ray through a viewport point given in normalized device coordinates
 * ([-1, 1] on both axes, y up). `aspect` is viewport width / height.
 */
export function viewRay(pose: CameraPose, lens: CameraLens, aspect: number, ndc: [number, number]): { origin: Vec3; dir: Vec3 } {
  const dop = directionOfProjection(pose);
  const up = orthogonalizeViewUp(pose);
  const right = normalize(cross(dop, up));
  if (lens.parallelProjection) {
    const s = lens.parallelScale;
    const onPlane = add(pose.focalPoint, add(scale(right, ndc[0] * s * aspect), scale(up, ndc[1] * s)));
    return { origin: sub(onPlane, scale(dop, 1e3 * Math.max(1, s))), dir: dop };
  }
  const dist = Math.hypot(...sub(pose.focalPoint, pose.position));
  const h = dist * Math.tan(deg(lens.viewAngle) / 2);
  const target = add(pose.focalPoint, add(scale(right, ndc[0] * h * aspect), scale(up, ndc[1] * h)));
  return { origin: pose.position, dir: normalize(sub(target, pose.position)) };
}

/**
 * The outward normal of the face of the axis-aligned cube [-halfSize,
 * halfSize]^3 that a ray enters first, or undefined on a miss. This is how an
 * orientation-cube click becomes a snap direction without a picker round trip.
 */
export function cubeFaceHit(origin: Vec3, dir: Vec3, halfSize = 0.5): Vec3 | undefined {
  let tEnter = -Infinity;
  let tExit = Infinity;
  let enterAxis = -1;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(dir[a]) < 1e-12) {
      if (origin[a] < -halfSize || origin[a] > halfSize) return undefined;
      continue;
    }
    let t0 = (-halfSize - origin[a]) / dir[a];
    let t1 = (halfSize - origin[a]) / dir[a];
    if (t0 > t1) [t0, t1] = [t1, t0];
    if (t0 > tEnter) {
      tEnter = t0;
      enterAxis = a;
    }
    tExit = Math.min(tExit, t1);
  }
  if (enterAxis < 0 || tEnter > tExit || tExit < 0) return undefined;
  const normal: Vec3 = [0, 0, 0];
  normal[enterAxis] = dir[enterAxis] > 0 ? -1 : 1;
  return normal;
}

/**
 * vtkRenderer::ResetCamera(bounds) — identical in VTK C++ and vtk.js: focus
 * the bounds' centre, back off along the view-plane normal until the bounding
 * sphere fits the view angle, and set the parallel scale to its radius. The
 * view-up is swapped when it is (nearly) parallel to the view-plane normal.
 */
export function resetCameraToBounds(pose: CameraPose, viewAngle: number, b: [number, number, number, number, number, number]): {
  pose: CameraPose;
  parallelScale: number;
} {
  const center: Vec3 = [(b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2];
  let radius = Math.hypot(b[1] - b[0], b[3] - b[2], b[5] - b[4]) / 2;
  if (radius === 0) radius = 1;
  const distance = radius / Math.sin(deg(viewAngle) / 2);
  const vn = scale(directionOfProjection(pose), -1);
  let up = pose.viewUp;
  if (Math.abs(dot(normalize(up), vn)) > 0.999) up = [-up[2], up[0], up[1]];
  return {
    pose: { focalPoint: center, position: add(center, scale(vn, distance)), viewUp: up },
    parallelScale: radius,
  };
}

/**
 * vtk.js Renderer.resetCameraClippingRange(bounds) with its defaults
 * (clippingRangeExpansion 0.05, near-plane tolerance 0.01): the near/far
 * distances of the bounds' corners along the view direction, widened to a
 * minimum gap and expanded. Used where vtk.js resets against EXPLICIT bounds
 * (resetCamera(bounds) — e.g. Find framing one element), which the C++
 * renderer's no-argument reset cannot express.
 */
export function clippingRangeForBounds(pose: CameraPose, lens: CameraLens, b: [number, number, number, number, number, number]): [number, number] {
  const dop = directionOfProjection(pose);
  const d = -dot(dop, pose.position);
  const range: [number, number] = [Infinity, -Infinity];
  for (let k = 0; k < 2; k++)
    for (let j = 0; j < 2; j++)
      for (let i = 0; i < 2; i++) {
        const dist = dop[0] * b[i] + dop[1] * b[2 + j] + dop[2] * b[4 + k] + d;
        range[0] = Math.min(range[0], dist);
        range[1] = Math.max(range[1], dist);
      }
  let minGap = lens.parallelProjection ? 0.2 * lens.parallelScale : 0.2 * Math.tan(deg(lens.viewAngle) / 2) * range[1];
  if (range[1] - range[0] < minGap) {
    minGap = minGap - range[1] + range[0];
    range[1] += minGap / 2;
    range[0] -= minGap / 2;
  }
  if (range[0] < 0) range[0] = 0;
  const expansion = 0.05;
  const span = range[1] - range[0];
  range[0] = 0.99 * range[0] - span * expansion;
  range[1] = 1.01 * range[1] + (range[1] - range[0]) * expansion;
  if (range[0] >= range[1]) range[0] = 0.01 * range[1];
  if (range[0] < 0.01 * range[1]) range[0] = 0.01 * range[1];
  return range;
}
