/**
 * The virtual tunnel around a body: its extent from multiples of the body's own
 * size, the blockage it implies, and the boundary roles of its six faces.
 *
 * The frame is fixed — flow along +X, up along +Z, the body centred on x = y = 0
 * by `placeBody` — so the tunnel never needs to know about any other
 * orientation. Pure: no vscode, no wasm.
 */

import type { BodyMetrics, Vec3 } from "./body";

/** What the floor is. "free" has no floor effect (a far slip wall); the others put the body near it. */
export type GroundMode = "free" | "slip" | "noslip" | "moving";

export interface TunnelSpec {
  /** Distance in front of the body, in body lengths (default 3). */
  upstream?: number;
  /** Distance behind the body, in body lengths (default 6). */
  downstream?: number;
  /** Distance to each side wall, in body widths (default 4). */
  side?: number;
  /** Distance above the body, in body heights (default 5). */
  top?: number;
  /** Below the body for a "free" tunnel, in body heights (default 5). */
  bottom?: number;
  ground?: GroundMode;
  /** Gap between the lowest point of the body and the floor, in metres (ground modes other than "free"). */
  clearance?: number;
  /** Mesh only y >= 0 and close the cut with a symmetry plane. */
  halfModel?: boolean;
}

export interface TunnelDomain {
  min: Vec3;
  max: Vec3;
  /** The body's centred bounding box, for reference. */
  bodyMin: Vec3;
  bodyMax: Vec3;
  /** Frontal area over the full cross-section (a half model uses the full width too). */
  blockage: number;
  crossSection: number;
  volume: number;
  halfModel: boolean;
  ground: GroundMode;
  warnings: string[];
}

export const DEFAULT_TUNNEL: Required<Omit<TunnelSpec, "clearance">> & { clearance: number } = {
  upstream: 3,
  downstream: 6,
  side: 4,
  top: 5,
  bottom: 5,
  ground: "free",
  clearance: 0,
  halfModel: false,
};

/** Blockage above which a free-stream result stops being a free-stream result. */
export const BLOCKAGE_WARNING = 0.05;

export function tunnelDomain(body: BodyMetrics, spec: TunnelSpec = {}): TunnelDomain {
  const s = { ...DEFAULT_TUNNEL, ...spec };
  for (const k of ["upstream", "downstream", "side", "top", "bottom"] as const) {
    if (!(s[k] > 0)) throw new Error(`The tunnel "${k}" distance must be above zero.`);
  }
  if (!(s.clearance >= 0)) throw new Error("The ground clearance cannot be negative.");
  const [L, W, H] = body.size;
  if (!(L > 0 && W > 0 && H > 0)) throw new Error("The body has no extent along one axis.");
  const bodyMin = body.min;
  const bodyMax = body.max;
  const warnings: string[] = [];
  const x0 = bodyMin[0] - s.upstream * L;
  const x1 = bodyMax[0] + s.downstream * L;
  const half = s.halfModel;
  const y0 = half ? 0 : bodyMin[1] - s.side * W;
  const y1 = bodyMax[1] + s.side * W;
  const grounded = s.ground !== "free";
  const z0 = grounded ? bodyMin[2] - s.clearance : bodyMin[2] - s.bottom * H;
  const z1 = bodyMax[2] + s.top * H;
  const crossSection = (y1 - (half ? -y1 : y0)) * (z1 - z0);
  const blockage = body.frontalArea / crossSection;
  if (blockage > BLOCKAGE_WARNING) {
    warnings.push(
      `Blockage is ${(blockage * 100).toFixed(1)}% (above ${BLOCKAGE_WARNING * 100}%): the walls will accelerate the flow past the body, so the forces are those of a confined body. Increase the side and top distances.`
    );
  }
  if (grounded && s.clearance === 0) {
    warnings.push("The body touches the floor: the gap between them will be one cell wide at best. Give it a small clearance if it rolls on the ground.");
  }
  if (half && Math.abs((bodyMin[1] + bodyMax[1]) / 2) > 1e-6 * W) {
    warnings.push("A half model assumes the body is symmetric about y = 0; its centre is off that plane.");
  }
  const volume = (x1 - x0) * (y1 - y0) * (z1 - z0) - Math.max(0, body.signedVolume) * (half ? 0.5 : 1);
  return {
    min: [x0, y0, z0],
    max: [x1, y1, z1],
    bodyMin,
    bodyMax,
    blockage,
    crossSection,
    volume,
    halfModel: half,
    ground: s.ground,
    warnings,
  };
}
