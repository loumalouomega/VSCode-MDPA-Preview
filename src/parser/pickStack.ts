/**
 * Pure helpers for stepping through the entities under the cursor (roadmap
 * item 39). The webview collects the stack; these decide the index, whether a
 * click still belongs to it and what the status line says.
 */
export const PICK_STACK_RADIUS = 4;
export const PICK_STACK_MAX = 8;

/** Moves through `n` hits (dir +1 = deeper, -1 = nearer), wrapping. */
export function cycleIndex(index: number, n: number, dir: 1 | -1): number {
  if (n <= 0) return 0;
  return (((index + dir) % n) + n) % n;
}

/** True when (x, y) is still within `radius` px of the stack's origin. */
export function withinPickRadius(ox: number, oy: number, x: number, y: number, radius = PICK_STACK_RADIUS): boolean {
  return Math.hypot(x - ox, y - oy) <= radius;
}

export function pickStackLabel(index: number, n: number): string {
  return `${index + 1} of ${n} under the cursor`;
}

/** Arrow keys and +/- step the stack; returns the direction or undefined. */
export function stepDirection(key: string): 1 | -1 | undefined {
  if (key === "ArrowDown" || key === "-" || key === "_") return 1;
  if (key === "ArrowUp" || key === "+" || key === "=") return -1;
  return undefined;
}
