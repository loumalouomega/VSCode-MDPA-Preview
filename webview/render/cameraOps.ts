// Backend-neutral camera operations shared by the orientation cube, the
// Standard Views shortcuts (1–6, i) and anything else that snaps a pane's view.

import type { RView, Vec3 } from "./backend";

/**
 * Snaps the camera to look along `normal` (one of the 6 axis directions, or any
 * unit vector for an isometric-style view), keeping the current focal point
 * and distance. Clicking a cube face and pressing a shortcut land on identical
 * views because both come here.
 */
export function snapCamera(view: RView, normal: ArrayLike<number>, render: () => void): void {
  const camera = view.getActiveCamera();
  const focal: Vec3 = camera.getFocalPoint();
  const dist = camera.getDistance();

  camera.setPosition(focal[0] + normal[0] * dist, focal[1] + normal[1] * dist, focal[2] + normal[2] * dist);

  // When looking along ±Y the default [0,1,0] viewUp is parallel to the view
  // direction, so switch to ±Z instead.
  if (Math.abs(normal[1]) > 0.9) {
    camera.setViewUp(0, 0, normal[1] > 0 ? -1 : 1);
  } else {
    camera.setViewUp(0, 1, 0);
  }

  view.resetCameraClippingRange();
  render();
}
