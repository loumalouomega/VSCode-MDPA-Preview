/**
 * Analytic shapes shared by the geometry tests (curvature, comparison, slicing,
 * signed distance, …): a shape whose exact answer is known makes a numerical
 * kernel checkable without a reference implementation.
 */

import { parseMdpa } from "../../parser/mdpaParser";
import { MdpaModel } from "../../parser/types";

/** An icosphere of radius R (642 nodes at subdivision 3), outward wound, as a model. */
export function icosphere(R: number, subdivisions: number, flip = false, keep?: (p: number[]) => boolean): MdpaModel {
  const t = (1 + Math.sqrt(5)) / 2;
  const v: number[][] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t],
    [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map((p) => {
    const l = Math.hypot(p[0], p[1], p[2]);
    return p.map((x) => x / l);
  });
  let f: number[][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (let s = 0; s < subdivisions; s++) {
    const cache = new Map<string, number>();
    const mid = (a: number, b: number): number => {
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      const hit = cache.get(k);
      if (hit !== undefined) return hit;
      const m = v[a].map((x, i) => (x + v[b][i]) / 2);
      const l = Math.hypot(m[0], m[1], m[2]);
      v.push(m.map((x) => x / l));
      cache.set(k, v.length - 1);
      return v.length - 1;
    };
    const nf: number[][] = [];
    for (const [a, b, c] of f) {
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    f = nf;
  }
  if (keep) f = f.filter((tri) => tri.every((i) => keep(v[i])));
  if (flip) f = f.map(([a, b, c]) => [a, c, b]);
  const used = [...new Set(f.flat())].sort((a, b) => a - b);
  const renum = new Map(used.map((old, i) => [old, i + 1]));
  let s = "Begin Nodes\n" + used.map((old) => `${renum.get(old)} ${v[old].map((x) => x * R).join(" ")}`).join("\n") + "\nEnd Nodes\n";
  s += "Begin Conditions SurfaceCondition3D3N\n" + f.map((tri, i) => `${i + 1} 0 ${tri.map((x) => renum.get(x)).join(" ")}`).join("\n") + "\nEnd Conditions\n";
  const r = parseMdpa(s) as unknown as { model?: MdpaModel };
  return (r.model ?? (r as unknown as MdpaModel)) as MdpaModel;
}
