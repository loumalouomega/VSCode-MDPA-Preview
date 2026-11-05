/**
 * The mirror view's choosable planes (roadmap item 24): an axis (x, y or z) and a side of the
 * bounding box (its minimum, its maximum or its centre). Pure and import-free so the View menu
 * markup (both runtimes) and the webview share one list; "centre" resolves to a plain number when
 * it is applied, so the saved `view.mirror` needs no new spelling.
 */

export type MirrorSide = "min" | "max" | "center";
export type MirrorAxis = 0 | 1 | 2;

export interface MirrorPlaneChoice {
  /** The `data-action` of its View-menu row. */
  action: string;
  axis: MirrorAxis;
  side: MirrorSide;
  label: string;
}

const AXES = ["x", "y", "z"];
const SIDES: MirrorSide[] = ["min", "max", "center"];

/** Every plane except x-min, which is the original "Mirror view" row. */
export const MIRROR_PLANES: MirrorPlaneChoice[] = AXES.flatMap((a, axis) =>
  SIDES.map((side) => ({
    action: `mirror:${a}:${side}`,
    axis: axis as MirrorAxis,
    side,
    label: `Mirror plane: ${a}-${side === "center" ? "centre" : side}`,
  }))
).filter((p) => !(p.axis === 0 && p.side === "min"));

/** Parses a `mirror:<axis>:<side>` action; undefined for anything else. */
export function parseMirrorAction(action: string | undefined): { axis: MirrorAxis; side: MirrorSide } | undefined {
  const m = /^mirror:([xyz]):(min|max|center)$/.exec(action ?? "");
  if (!m) return undefined;
  return { axis: AXES.indexOf(m[1]) as MirrorAxis, side: m[2] as MirrorSide };
}

/** The `at` value for a side: "min"/"max" stay symbolic (they follow the bounds), the centre is the midpoint now. */
export function mirrorPlaneAt(side: MirrorSide, axis: MirrorAxis, bounds: { min: ArrayLike<number>; max: ArrayLike<number> }): number | "min" | "max" {
  return side === "center" ? (bounds.min[axis] + bounds.max[axis]) / 2 : side;
}
