/**
 * Boundary flow balance and pressure drop — signed flux through named
 * SubModelPart boundaries, area-weighted pressure on them, and the imbalance
 * and pressure difference that follow.
 *
 * Pure module: no vscode / DOM / wasm imports. READ-ONLY (nothing is edited, so
 * no OpRecord and no undo entry) and bundled by the host only; the webview gets
 * the result over the `meshAnalysis` round trip.
 *
 * ## Why this is not `fieldIntegrate.ts`
 *
 * `integrateFields` weights a per-CELL scalar by cell measure. A flux is
 * `integral(u . n dA)`: it needs an ORIENTED surface and the vector's normal
 * component. Averaging the vector's components and multiplying by area is not
 * that integral (a rotating field through a closed section averages to
 * something unrelated to what crosses it), so this module integrates facet by
 * facet with the facet's own area vector.
 *
 * ## Conventions (each stated in the result rather than left to surprise)
 *
 *  - **Positive flux is OUT of the domain**: an inlet reads negative, an outlet
 *    positive, and a balanced duct sums to zero.
 *  - **Orientation** is `outward` by default: a Condition's own winding is
 *    whatever the mesher wrote and Kratos does not require it to face out, so
 *    the normal is flipped away from the single Element the facet belongs to.
 *    `winding` trusts the file's node order instead. A facet with no adjacent
 *    Element, or shared by two (an internal facet), is COUNTED and EXCLUDED
 *    under `outward` — an orientation is never guessed.
 *  - **Quadrature**: each facet is fan-triangulated from its first corner and
 *    every triangle contributes `mean(corner values) . areaVector`. That is
 *    exact for a linear field on a triangle, and the fan makes a non-planar
 *    quad sum its two pieces' own area vectors instead of one made-up normal.
 *    Only corner nodes are read, so a quadratic facet integrates as its linear
 *    skeleton.
 *  - **A gap stays a gap.** A facet with a corner that carries no value is
 *    excluded from that quantity's numerator AND from its covered area, and
 *    the uncovered area is reported — never read as zero.
 *  - **2D meshes** integrate `u . n dl` over line Conditions bounding surface
 *    Elements, i.e. per unit depth. The result says so; it is not a volume
 *    flow rate.
 *  - **Mass flux** is `density x volumetric flux` and only exists when the
 *    caller passes a density. Nothing is inferred from a field's name.
 *  - **Pressure difference** is the area-weighted mean of ONE nodal scalar on
 *    two named sections, in that field's own units and reference (gauge or
  *    absolute). An explicit `pressureDensity` additionally reports the means
  *    and the drop scaled to Pa, but only when the field's dimensions are
  *    exactly kinematic pressure — anything else reports the conversion as
  *    unavailable with the reason, never a rescaled number.
 */

import type { SeriesStep } from "./fieldSeries";
import { findSubModelPart } from "./subModelPartExtract";
import { FieldData, MdpaModel, SubModelPart } from "./types";
import { cellCategory, cornerCount, nodeIndexMap, volumeFaces } from "./writers/writerCommon";
import { KINEMATIC_PRESSURE, PRESSURE, describeExponents, dimensionsEqual, fieldUnitLabel } from "./fieldDimensions";

export type FlowOrientation = "outward" | "winding";

export const FLOW_DEFAULT_VELOCITY = "VELOCITY";
export const FLOW_DEFAULT_PRESSURE = "PRESSURE";

export interface FlowSectionSpec {
  /** A label for the section; defaults to the part's path. */
  name?: string;
  /** The SubModelPart path (`/`-separated) whose subtree's Conditions form the section. */
  part: string;
}

export interface FlowBalanceSpec {
  sections: FlowSectionSpec[];
  /** Nodal vector field (default `VELOCITY`). Pass `null` to skip flux and only report pressure. */
  velocity?: string | null;
  /** Nodal scalar field (default `PRESSURE`). Pass `null` to skip pressure. */
  pressure?: string | null;
  /** Explicit density for mass flux. Absent = no mass flux; never inferred. */
  density?: number;
  orientation?: FlowOrientation;
  /** Section NAMES: reports `mean(from) - mean(to)`. */
  pressureDrop?: { from: string; to: string };
  /**
   * Explicit density (kg/m³) for converting a KINEMATIC pressure field to Pa.
   * Deliberately separate from mass-flux `density`: one is a unit conversion,
   * the other a physical mass flow, and neither falls back to the other.
   * Only a field whose dimensions are exactly kinematic pressure converts
   * (item 12's rule); anything else reports the conversion as unavailable
   * with the reason instead of rescaling.
   */
  pressureDensity?: number;
  /** Gauge/absolute label for a converted pressure. Label only, never inferred. */
  pressureReference?: "gauge" | "absolute";
}

export interface FlowSection {
  name: string;
  part: string;
  /** Conditions in the section's subtree that are surface (3D) or line (2D) facets. */
  facets: number;
  /** Sum of every measurable facet's area (length in 2D), oriented or not. */
  area: number;
  /** Facets skipped because their area is zero. */
  degenerate: number;
  /** Under `outward`: facets with no adjacent Element (cannot be oriented). */
  unoriented: number;
  /** Under `outward`: facets shared by two Elements — internal, not boundary. */
  internal: number;
  /** Area over which the flux was actually integrated. */
  fluxArea: number;
  /** Area with no usable velocity at a corner (a gap). */
  fluxUncoveredArea: number;
  /** Signed volumetric flux, positive OUT of the domain; null = not computable. */
  flux: number | null;
  /** density x flux, only when a density was given. */
  massFlux: number | null;
  /** Area-weighted mean of the pressure field; null = not computable. */
  meanPressure: number | null;
  pressureArea: number;
  pressureUncoveredArea: number;
}

export interface FlowPressureConversion {
  density: number;
  reference?: "gauge" | "absolute";
  /** Unit of the converted values, always Pa. */
  unit: "Pa";
  /** Converted area-weighted mean per section (null = no pressure there). */
  means: { section: string; value: number | null }[];
  /** Converted pressure drop (null with `note` when not computable). */
  drop: number | null;
  note: string;
}

export interface FlowBalance {
  dimension: 2 | 3;
  velocity: string | null;
  pressure: string | null;
  density?: number;
  orientation: FlowOrientation;
  /** What the flux number means, since a 2D value is per unit depth. */
  fluxUnit: string;
  /** Unit label of the pressure field (`Pa`, `m²/s²`, …); undefined when unknown or absent. */
  pressureUnit?: string;
  sections: FlowSection[];
  /** Sum of the magnitudes of the negative section fluxes. */
  inflow: number;
  /** Sum of the positive section fluxes. */
  outflow: number;
  /** Signed sum of the section fluxes; ~0 for a balanced set of boundaries. */
  netFlux: number | null;
  /** `netFlux / max(inflow, outflow)`; null with `imbalanceNote` when that denominator is 0. */
  imbalance: number | null;
  imbalanceNote: string;
  pressureDrop?: { from: string; to: string; value: number | null; note?: string };
  /** Converted (Pa) pressure means and drop; present only when `pressureDensity` was given. */
  pressureConversion?: FlowPressureConversion;
  warnings: string[];
}

interface Facet {
  /** Corner node indices into `model.coords`. */
  corners: number[];
  conditionId: number;
}

interface Adjacency {
  count: number;
  centroid: [number, number, number];
}

const IMBALANCE_NOTE = "net flux / max(total inflow, total outflow) over the sections given";

/** The facet-sized pieces a part's subtree defines: its Conditions of surface (3D) or line (2D) category. */
function collectConditionIds(part: SubModelPart): Set<number> {
  const ids = new Set<number>();
  const walk = (p: SubModelPart): void => {
    for (const id of p.conditionIds) ids.add(id);
    for (const c of p.children) walk(c);
  };
  walk(part);
  return ids;
}

function facetsOf(model: MdpaModel, ids: Set<number>, idToIndex: Map<number, number>): { facets: Facet[]; category: "surface" | "line" | undefined; higherOrder: string[] } {
  const facets: Facet[] = [];
  let category: "surface" | "line" | undefined;
  const higherOrder = new Set<string>();
  for (const block of model.blocks) {
    if (block.kind !== "Conditions") continue;
    const cat = cellCategory(block.vtkCellType);
    if (cat !== "surface" && cat !== "line") continue;
    const cornerTotal = cornerCount(block.vtkCellType) || block.stride;
    const n = Math.min(cornerTotal, block.stride);
    for (let c = 0; c < block.count; c++) {
      const id = block.entityIds[c];
      if (!ids.has(id)) continue;
      if (block.stride > cornerTotal) higherOrder.add(block.name);
      const corners: number[] = [];
      let ok = true;
      for (let k = 0; k < n; k++) {
        const idx = idToIndex.get(block.connectivity[c * block.stride + k]);
        if (idx === undefined) {
          ok = false;
          break;
        }
        corners.push(idx);
      }
      if (!ok) continue;
      facets.push({ corners, conditionId: id });
      category = category ?? cat;
    }
  }
  return { facets, category, higherOrder: [...higherOrder] };
}

const facetKey = (corners: number[]): string => [...corners].sort((a, b) => a - b).join(",");

/**
 * For each requested facet key: how many Elements own a face with that corner
 * set, and the centroid of the (first) owner. Only the keys asked for are kept,
 * so a large volume mesh costs one pass and a small map.
 */
function adjacency(model: MdpaModel, wanted: Set<string>, category: "surface" | "line", idToIndex: Map<number, number>): Map<string, Adjacency> {
  const out = new Map<string, Adjacency>();
  const want = category === "surface" ? "volume" : "surface";
  for (const block of model.blocks) {
    if (block.kind !== "Elements" || cellCategory(block.vtkCellType) !== want) continue;
    const corners = Math.min(cornerCount(block.vtkCellType) || block.stride, block.stride);
    // A volume element's faces come from the shared table; a 2D element's
    // "faces" are its edges, corner i to corner i+1.
    const table =
      category === "surface"
        ? volumeFaces(block.vtkCellType)
        : Array.from({ length: corners }, (_, i) => [i, (i + 1) % corners]);
    if (!table) continue;
    for (let c = 0; c < block.count; c++) {
      const ci: number[] = [];
      let ok = true;
      for (let k = 0; k < corners; k++) {
        const idx = idToIndex.get(block.connectivity[c * block.stride + k]);
        if (idx === undefined) {
          ok = false;
          break;
        }
        ci.push(idx);
      }
      if (!ok) continue;
      let centroid: [number, number, number] | undefined;
      for (const face of table) {
        const key = facetKey(face.map((li) => ci[li]));
        if (!wanted.has(key)) continue;
        if (!centroid) {
          centroid = [0, 0, 0];
          for (const p of ci) {
            centroid[0] += model.coords[p * 3];
            centroid[1] += model.coords[p * 3 + 1];
            centroid[2] += model.coords[p * 3 + 2];
          }
          centroid = [centroid[0] / ci.length, centroid[1] / ci.length, centroid[2] / ci.length];
        }
        const hit = out.get(key);
        if (hit) hit.count++;
        else out.set(key, { count: 1, centroid });
      }
    }
  }
  return out;
}

/** A nodal field's values at the given node indices, or undefined when any is missing. */
function makeLookup(model: MdpaModel, field: FieldData | undefined): ((nodeIndex: number, out: number[]) => boolean) | undefined {
  if (!field) return undefined;
  const rowOf = new Map<number, number>();
  for (let r = 0; r < field.ids.length; r++) rowOf.set(field.ids[r], r);
  const w = field.components;
  return (nodeIndex, out) => {
    const row = rowOf.get(model.nodeIds[nodeIndex]);
    if (row === undefined) return false;
    for (let k = 0; k < w; k++) {
      const v = field.values[row * w + k];
      if (!Number.isFinite(v)) return false;
      out[k] = v;
    }
    return true;
  };
}

function nodalField(model: MdpaModel, variable: string, want: "vector" | "scalar"): FieldData {
  const field = model.fields.find((f) => f.kind === "Nodal" && f.variable === variable);
  if (!field) {
    const other = model.fields.find((f) => f.variable === variable);
    const names = model.fields
      .filter((f) => f.kind === "Nodal" && (want === "scalar" ? f.components === 1 : f.components === 2 || f.components === 3))
      .map((f) => f.variable);
    throw new Error(
      other
        ? `"${variable}" is an ${other.kind} field; flow balance reads a Nodal ${want}. Run Average field (elementalToNodal) first.`
        : `No Nodal field "${variable}".` + (names.length ? ` Nodal ${want} fields: ${names.join(", ")}.` : ` The mesh has no Nodal ${want} field.`)
    );
  }
  if (want === "scalar" && field.components !== 1) throw new Error(`"${variable}" has ${field.components} components; pressure must be a scalar.`);
  if (want === "vector" && field.components !== 2 && field.components !== 3) {
    throw new Error(`"${variable}" has ${field.components} component${field.components === 1 ? "" : "s"}; velocity must be a 2- or 3-component vector.`);
  }
  return field;
}

function listPaths(model: MdpaModel): string[] {
  const out: string[] = [];
  const walk = (ps: SubModelPart[]): void => {
    for (const p of ps) {
      out.push(p.path);
      walk(p.children);
    }
  };
  walk(model.subModelParts);
  return out;
}

/** True when the model has any volume Element; decides 3D facets versus 2D lines. */
const hasVolume = (model: MdpaModel): boolean => model.blocks.some((b) => b.kind === "Elements" && cellCategory(b.vtkCellType) === "volume");

/** Shared read-only boundary quadrature for pressure loads, moments and flux.
 * Linear triangles use a degree-two rule (moments multiply position by pressure).
 * Lines use two-point Gauss quadrature. Higher-order corners are disclosed.
 * Scalar means/integrals need no normal, so orientation can be omitted. */
export function boundaryQuadrature(model: MdpaModel, partPath: string, orientation?: FlowOrientation): {
  dimension: 2 | 3; measure: number; excludedMeasure: number; warnings: string[];
  incomplete: boolean;
  samples: { conditionId: number; nodeIds: number[]; shape: number[]; position: [number, number, number]; normal: [number, number, number]; weight: number }[];
} {
  const part = findSubModelPart(model, partPath);
  if (!part) throw new Error(`No SubModelPart "${partPath}".`);
  const requested=collectConditionIds(part);
  const index = nodeIndexMap(model), found = facetsOf(model, requested, index);
  const dimension:2|3 = found.category === "surface" ? 3 : 2;
  if (!found.facets.length || found.category !== (dimension === 3 ? "surface" : "line")) throw new Error(`Choose a SubModelPart containing ${dimension === 3 ? "surface" : "line"} Conditions; nodes alone do not define an integration boundary.`);
  const adj = orientation === "outward" ? adjacency(model, new Set(found.facets.map(f => facetKey(f.corners))), found.category, index) : undefined;
  const present=new Set(found.facets.map(f=>f.conditionId));
  const missing=[...requested].filter(id=>!present.has(id));
  const result: ReturnType<typeof boundaryQuadrature> = { dimension, measure: 0, excludedMeasure: 0, warnings: [], samples: [], incomplete:missing.length>0 };
  if(missing.length)result.warnings.push(`${missing.length} requested Conditions are missing, unsupported or reference absent nodes; their measure cannot be computed.`);
  for (const facet of found.facets) {
    if((dimension===2)!==(facet.corners.length===2))throw new Error("A boundary region mixes line and surface Conditions; choose a single-dimensional boundary.");
    const coords = facet.corners.map(i => [model.coords[3*i],model.coords[3*i+1],model.coords[3*i+2]]);
    const pieces = coords.length === 2 ? [[0,1]] : Array.from({length:coords.length-2},(_,i)=>[0,i+1,i+2]);
    for (const piece of pieces) {
      const p = piece.map(i=>coords[i]), a = p[0], b = p[1];
      const dx=b[0]-a[0],dy=b[1]-a[1],dz=b[2]-a[2];
      // The existing 2D flow contract is the XY plane; do not silently project tilted lines.
      if (piece.length === 2 && (Math.abs(dz)>1e-10 || Math.abs(a[2])>1e-10 || Math.abs(b[2])>1e-10)) throw new Error("2D boundary integration requires an XY-plane mesh; tilted/axisymmetric boundaries are unsupported.");
      const c = p[2];
      const vector = c ? [.5*(dy*(c[2]-a[2])-dz*(c[1]-a[1])),.5*(dz*(c[0]-a[0])-dx*(c[2]-a[2])),.5*(dx*(c[1]-a[1])-dy*(c[0]-a[0]))] : [dy,-dx,0];
      const measure = Math.hypot(...vector); if (!(measure>0) || !Number.isFinite(measure)) { result.incomplete=true;result.warnings.push(`Condition ${facet.conditionId}: degenerate/nonfinite boundary piece excluded.`); continue; }
      result.measure += measure;
      let sign = 1;
      if (orientation === "outward") {
        const owner = adj?.get(facetKey(facet.corners));
        if (!owner || owner.count !== 1) { result.excludedMeasure += measure; result.warnings.push(`Condition ${facet.conditionId}: ${owner ? "internal interface" : "no adjacent volume/surface element"}; outward normal unavailable, excluded.`); continue; }
        const centre = [0,1,2].map(d=>p.reduce((sum,v)=>sum+v[d]/p.length,0));
        if (centre.reduce((sum,v,d)=>sum+(v-owner.centroid[d])*vector[d],0)<0) sign=-1;
      }
      const normal = vector.map(v=>sign*v/measure) as [number,number,number];
      const g = 1/Math.sqrt(3);
      const rules = c ? [[2/3,1/6,1/6],[1/6,2/3,1/6],[1/6,1/6,2/3]] : [[(1-g)/2,(1+g)/2],[(1+g)/2,(1-g)/2]];
      for (const shape of rules) result.samples.push({ conditionId:facet.conditionId,nodeIds:piece.map(i=>model.nodeIds[facet.corners[i]]),shape,position:[0,1,2].map(d=>p.reduce((sum,v,i)=>sum+v[d]*shape[i],0)) as [number,number,number],normal,weight:measure/rules.length });
    }
  }
  if (found.higherOrder.length) result.warnings.push(`Higher-order boundaries ${found.higherOrder.join(", ")} integrated as linear corner skeletons, not full high-order FEM quadrature.`);
  if(found.facets.some(f=>f.corners.length>3))result.warnings.push("Polygon/quad boundaries use a piecewise-linear triangle fan, not bilinear/isoparametric quadrature; nonplanar faces are approximated.");
  return result;
}

/**
 * Computes the flow balance over the given sections. Throws (with the reason
 * and the alternatives) for a spec that cannot mean anything: no sections, an
 * unknown SubModelPart, a missing or wrongly shaped field, a non-positive
 * density. Everything the mesh merely cannot answer becomes a `null` with a
 * warning instead.
 */
export function flowBalance(model: MdpaModel, spec: FlowBalanceSpec): FlowBalance {
  if (!spec.sections?.length) throw new Error("Give at least one section (a SubModelPart of Conditions).");
  if (spec.density !== undefined && !(Number.isFinite(spec.density) && spec.density > 0)) {
    throw new Error("density must be a finite positive number; it is never inferred.");
  }
  if (spec.pressureDensity !== undefined && !(Number.isFinite(spec.pressureDensity) && spec.pressureDensity > 0)) {
    throw new Error("pressureDensity must be a finite positive number (kg/m³); it is never inferred.");
  }
  if (spec.pressureReference !== undefined && spec.pressureReference !== "gauge" && spec.pressureReference !== "absolute") {
    throw new Error(`pressureReference must be "gauge" or "absolute", not "${spec.pressureReference}".`);
  }
  const velocityName = spec.velocity === null ? null : spec.velocity ?? FLOW_DEFAULT_VELOCITY;
  const pressureName = spec.pressure === null ? null : spec.pressure ?? FLOW_DEFAULT_PRESSURE;
  const orientation = spec.orientation ?? "outward";
  const warnings: string[] = [];

  // A default name the mesh simply lacks is "not requested", not an error; an
  // explicit name that is missing is the caller's mistake and throws.
  const explicitV = spec.velocity !== undefined && spec.velocity !== null;
  const explicitP = spec.pressure !== undefined && spec.pressure !== null;
  let vField: FieldData | undefined;
  let pField: FieldData | undefined;
  if (velocityName) {
    try {
      vField = nodalField(model, velocityName, "vector");
    } catch (e) {
      if (explicitV) throw e;
      warnings.push(`No flux: ${(e as Error).message}`);
    }
  }
  if (pressureName) {
    try {
      pField = nodalField(model, pressureName, "scalar");
    } catch (e) {
      if (explicitP) throw e;
      warnings.push(`No pressure: ${(e as Error).message}`);
    }
  }
  if (spec.density !== undefined && !vField) warnings.push("A density was given but there is no velocity field, so no mass flux is reported.");
  if (spec.pressureDensity !== undefined && !pField) warnings.push("A pressureDensity was given but there is no pressure field, so no Pa conversion is reported.");

  const idToIndex = nodeIndexMap(model);
  const dimension: 2 | 3 = hasVolume(model) ? 3 : 2;
  const vLookup = makeLookup(model, vField);
  const pLookup = makeLookup(model, pField);
  const vBuf: number[] = [0, 0, 0];
  const pBuf: number[] = [0];

  // Resolve every section's facets up front so ONE adjacency pass serves all.
  const resolved = spec.sections.map((s) => {
    const part = findSubModelPart(model, s.part);
    if (!part) {
      const paths = listPaths(model);
      throw new Error(`No SubModelPart "${s.part}".` + (paths.length ? ` Available: ${paths.slice(0, 20).join(", ")}${paths.length > 20 ? ", …" : ""}.` : " The mesh has no SubModelParts."));
    }
    const ids = collectConditionIds(part);
    return { spec: s, ids, ...facetsOf(model, ids, idToIndex) };
  });

  const names = new Set<string>();
  for (const r of resolved) {
    const name = r.spec.name?.trim() || r.spec.part;
    if (names.has(name)) throw new Error(`Section name "${name}" is used twice; give each section its own name.`);
    names.add(name);
  }
  // Overlap: a condition counted in two sections would be counted twice in the net.
  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      const shared = [...resolved[i].ids].filter((id) => resolved[j].ids.has(id)).length;
      if (shared > 0) {
        warnings.push(`Sections "${resolved[i].spec.name ?? resolved[i].spec.part}" and "${resolved[j].spec.name ?? resolved[j].spec.part}" share ${shared} Condition id${shared === 1 ? "" : "s"}; the net flux counts them twice.`);
      }
    }
  }

  let adj: Map<string, Adjacency> | undefined;
  if (orientation === "outward") {
    const wanted = new Set<string>();
    let category: "surface" | "line" | undefined;
    for (const r of resolved) {
      category = category ?? r.category;
      for (const f of r.facets) wanted.add(facetKey(f.corners));
    }
    if (category && wanted.size > 0) adj = adjacency(model, wanted, category, idToIndex);
  }

  const sections: FlowSection[] = resolved.map((r) => {
    const name = r.spec.name?.trim() || r.spec.part;
    const sec: FlowSection = {
      name,
      part: r.spec.part,
      facets: r.facets.length,
      area: 0,
      degenerate: 0,
      unoriented: 0,
      internal: 0,
      fluxArea: 0,
      fluxUncoveredArea: 0,
      flux: null,
      massFlux: null,
      meanPressure: null,
      pressureArea: 0,
      pressureUncoveredArea: 0,
    };
    if (r.facets.length === 0) warnings.push(`Section "${name}" holds no ${dimension === 3 ? "surface" : "line"} Conditions.`);
    let fluxSum = 0;
    let pressureNum = 0;

    for (const f of r.facets) {
      const c = f.corners;
      const p0 = c[0] * 3;
      // Fan triangles (0, i, i+1); a 2-corner facet is one segment.
      const pieces: { corners: number[]; area: [number, number, number] }[] = [];
      if (c.length === 2) {
        const dx = model.coords[c[1] * 3] - model.coords[p0];
        const dy = model.coords[c[1] * 3 + 1] - model.coords[p0 + 1];
        // Right-hand normal of a→b; outward for a counter-clockwise boundary.
        pieces.push({ corners: c, area: [dy, -dx, 0] });
      } else {
        for (let i = 1; i + 1 < c.length; i++) {
          const a = c[i] * 3;
          const b = c[i + 1] * 3;
          const ux = model.coords[a] - model.coords[p0];
          const uy = model.coords[a + 1] - model.coords[p0 + 1];
          const uz = model.coords[a + 2] - model.coords[p0 + 2];
          const vx = model.coords[b] - model.coords[p0];
          const vy = model.coords[b + 1] - model.coords[p0 + 1];
          const vz = model.coords[b + 2] - model.coords[p0 + 2];
          pieces.push({
            corners: [c[0], c[i], c[i + 1]],
            area: [0.5 * (uy * vz - uz * vy), 0.5 * (uz * vx - ux * vz), 0.5 * (ux * vy - uy * vx)],
          });
        }
      }
      let ax = 0;
      let ay = 0;
      let az = 0;
      for (const pc of pieces) {
        ax += pc.area[0];
        ay += pc.area[1];
        az += pc.area[2];
      }
      const total = Math.hypot(ax, ay, az);
      // Sum of piece MAGNITUDES is the true facet area for a non-planar quad.
      let facetArea = 0;
      for (const pc of pieces) facetArea += Math.hypot(pc.area[0], pc.area[1], pc.area[2]);
      if (!(facetArea > 0)) {
        sec.degenerate++;
        continue;
      }
      sec.area += facetArea;

      let sign = 1;
      if (orientation === "outward") {
        const a = adj?.get(facetKey(c));
        if (!a) {
          sec.unoriented++;
          continue;
        }
        if (a.count > 1) {
          sec.internal++;
          continue;
        }
        let cx = 0;
        let cy = 0;
        let cz = 0;
        for (const k of c) {
          cx += model.coords[k * 3];
          cy += model.coords[k * 3 + 1];
          cz += model.coords[k * 3 + 2];
        }
        const away = (cx / c.length - a.centroid[0]) * ax + (cy / c.length - a.centroid[1]) * ay + (cz / c.length - a.centroid[2]) * az;
        if (total > 0 && away < 0) sign = -1;
      }

      if (vLookup) {
        let ok = true;
        let flux = 0;
        for (const pc of pieces) {
          const mean = [0, 0, 0];
          for (const k of pc.corners) {
            if (!vLookup(k, vBuf)) {
              ok = false;
              break;
            }
            for (let d = 0; d < vField!.components; d++) mean[d] += vBuf[d] / pc.corners.length;
          }
          if (!ok) break;
          flux += mean[0] * pc.area[0] + mean[1] * pc.area[1] + mean[2] * pc.area[2];
        }
        if (ok) {
          fluxSum += sign * flux;
          sec.fluxArea += facetArea;
        } else sec.fluxUncoveredArea += facetArea;
      }
      if (pLookup) {
        let ok = true;
        let num = 0;
        for (const pc of pieces) {
          let mean = 0;
          for (const k of pc.corners) {
            if (!pLookup(k, pBuf)) {
              ok = false;
              break;
            }
            mean += pBuf[0] / pc.corners.length;
          }
          if (!ok) break;
          num += mean * Math.hypot(pc.area[0], pc.area[1], pc.area[2]);
        }
        if (ok) {
          pressureNum += num;
          sec.pressureArea += facetArea;
        } else sec.pressureUncoveredArea += facetArea;
      }
    }

    if (vLookup && sec.fluxArea > 0) {
      sec.flux = fluxSum;
      if (spec.density !== undefined) sec.massFlux = spec.density * fluxSum;
    }
    if (pLookup && sec.pressureArea > 0) sec.meanPressure = pressureNum / sec.pressureArea;

    if (sec.unoriented > 0) warnings.push(`Section "${name}": ${sec.unoriented} facet${sec.unoriented === 1 ? " has" : "s have"} no adjacent Element and could not be oriented outward; excluded (use orientation "winding" to trust the file's node order).`);
    if (sec.internal > 0) warnings.push(`Section "${name}": ${sec.internal} facet${sec.internal === 1 ? " is" : "s are"} shared by two Elements (internal, not boundary) and excluded.`);
    if (sec.fluxUncoveredArea > 0) warnings.push(`Section "${name}": ${((100 * sec.fluxUncoveredArea) / (sec.fluxArea + sec.fluxUncoveredArea)).toPrecision(3)}% of the area has no velocity at a corner and is not in the flux.`);
    if (sec.pressureUncoveredArea > 0) warnings.push(`Section "${name}": ${((100 * sec.pressureUncoveredArea) / (sec.pressureArea + sec.pressureUncoveredArea)).toPrecision(3)}% of the area has no pressure at a corner and is not in the mean.`);
    if (sec.degenerate > 0) warnings.push(`Section "${name}": ${sec.degenerate} zero-area facet${sec.degenerate === 1 ? "" : "s"} skipped.`);
    return sec;
  });

  let inflow = 0;
  let outflow = 0;
  let net = 0;
  let counted = 0;
  for (const s of sections) {
    if (s.flux === null) continue;
    counted++;
    net += s.flux;
    if (s.flux < 0) inflow -= s.flux;
    else outflow += s.flux;
  }
  const denom = Math.max(inflow, outflow);
  const result: FlowBalance = {
    dimension,
    velocity: vField ? vField.variable : null,
    pressure: pField ? pField.variable : null,
    ...(spec.density !== undefined ? { density: spec.density } : {}),
    orientation,
    fluxUnit: dimension === 3 ? "velocity unit x mesh length^2" : "velocity unit x mesh length, per unit depth (2D)",
    ...(pField ? { pressureUnit: fieldUnitLabel(pField) } : {}),
    sections,
    inflow,
    outflow,
    netFlux: counted > 0 ? net : null,
    imbalance: counted > 0 && denom > 0 ? net / denom : null,
    imbalanceNote: IMBALANCE_NOTE,
    warnings,
  };
  if (counted === 0 && vField) result.imbalanceNote = "no section produced a flux";
  else if (counted > 0 && !(denom > 0)) result.imbalanceNote = "unavailable: there is no flow through any section (zero denominator)";
  else if (counted < sections.length) result.imbalanceNote += `; ${sections.length - counted} section${sections.length - counted === 1 ? " has" : "s have"} no flux and ${sections.length - counted === 1 ? "is" : "are"} not in the sum`;

  if (spec.pressureDrop) {
    const a = sections.find((s) => s.name === spec.pressureDrop!.from);
    const b = sections.find((s) => s.name === spec.pressureDrop!.to);
    const drop: NonNullable<FlowBalance["pressureDrop"]> = { from: spec.pressureDrop.from, to: spec.pressureDrop.to, value: null };
    if (!a || !b) drop.note = `pressureDrop names a section that is not in the list (${!a ? spec.pressureDrop.from : spec.pressureDrop.to}).`;
    else if (!pField) drop.note = "no pressure field on this mesh.";
    else if (a.meanPressure === null || b.meanPressure === null) drop.note = `no pressure on ${a.meanPressure === null ? a.name : b.name}.`;
    else {
      drop.value = a.meanPressure - b.meanPressure;
      drop.note = `${pField.variable}(${a.name}) - ${pField.variable}(${b.name}); the field's own units and gauge/absolute reference, no conversion.`;
    }
    result.pressureDrop = drop;
  }

  // Higher-order facets integrated as their linear skeleton: the mid-side
  // nodes were skipped in `facetsOf`, so say which blocks that was.
  for (const r of resolved) {
    if (r.higherOrder.length === 0) continue;
    const name = r.spec.name?.trim() || r.spec.part;
    warnings.push(
      `Section "${name}": blocks ${r.higherOrder.join(", ")} are higher-order; integrated as their linear skeleton (corner nodes only).`
    );
  }

  if (spec.pressureDensity !== undefined) {
    const density = spec.pressureDensity;
    const conv: FlowPressureConversion = {
      density,
      ...(spec.pressureReference ? { reference: spec.pressureReference } : {}),
      unit: "Pa",
      means: sections.map((s) => ({ section: s.name, value: null })),
      drop: null,
      note: "",
    };
    const ref = spec.pressureReference ? ` (${spec.pressureReference}, as labelled — never inferred)` : " (reference unstated)";
    if (!pField) {
      conv.note = "no pressure field on this mesh, so nothing was converted.";
    } else if (!pField.dimensions) {
      conv.note =
        `"${pField.variable}" has no recorded dimensions, so it is not converted (a name such as p or PRESSURE is not evidence of its units). ` +
        `Only fields read from an OpenFOAM case carry them; convert the field first with convertFieldUnits.`;
    } else if (dimensionsEqual(pField.dimensions.exponents, PRESSURE)) {
      conv.means = sections.map((s) => ({ section: s.name, value: s.meanPressure }));
      conv.drop = result.pressureDrop?.value ?? null;
      conv.note = `"${pField.variable}" is already [Pa]; reported as-is${spec.pressureReference ? ref : ""}.`;
    } else if (dimensionsEqual(pField.dimensions.exponents, KINEMATIC_PRESSURE)) {
      conv.means = sections.map((s) => ({ section: s.name, value: s.meanPressure === null ? null : s.meanPressure * density }));
      let note =
        `"${pField.variable}" [m²/s²] × ${density} kg/m³${ref}; the source field is kept, only these numbers are scaled.`;
      if (result.pressureDrop) {
        if (result.pressureDrop.value !== null) conv.drop = result.pressureDrop.value * density;
        else note += ` No converted drop: ${result.pressureDrop.note ?? "not computable"}.`;
      }
      conv.note = note;
    } else {
      conv.note =
        `"${pField.variable}" is [${describeExponents(pField.dimensions.exponents)}], not a kinematic pressure [m²/s²]; ` +
        `only that converts to Pa, so nothing was converted.`;
    }
    result.pressureConversion = conv;
  }
  return result;
}

// ---- time series ----------------------------------------------------------

export interface FlowSeriesRow {
  label: string;
  frameIndex: number;
  result?: FlowBalance;
  error?: string;
}

export interface FlowSeries {
  rows: FlowSeriesRow[];
  cancelled: boolean;
}

/**
 * The balance at every step, one model at a time (peak memory is one step, like
 * `collectFieldSeries`). A step that fails — a half-written file from a running
 * solver is the normal case — is recorded and skipped, never fatal, and a
 * cancelled scan returns what it has.
 */
export async function flowBalanceSeries(
  steps: SeriesStep[],
  spec: FlowBalanceSpec,
  opts: { signal?: AbortSignal; onProgress?(done: number, total: number, label: string): void } = {}
): Promise<FlowSeries> {
  const rows: FlowSeriesRow[] = [];
  let cancelled = false;
  for (let i = 0; i < steps.length; i++) {
    if (opts.signal?.aborted) {
      cancelled = true;
      break;
    }
    const step = steps[i];
    opts.onProgress?.(i, steps.length, step.label);
    try {
      rows.push({ label: step.label, frameIndex: step.frameIndex, result: flowBalance(await step.load(), spec) });
    } catch (err) {
      rows.push({ label: step.label, frameIndex: step.frameIndex, error: err instanceof Error ? err.message : String(err) });
    }
  }
  opts.onProgress?.(rows.length, steps.length, "");
  return { rows, cancelled };
}

/** One line for the panel and the MCP summary. */
export function describeFlowBalance(r: FlowBalance): string {
  const f = (v: number | null): string => (v === null ? "n/a" : v.toPrecision(5));
  const parts = r.sections.map((s) => `${s.name}: ${f(s.flux)}`);
  let text = `Flux (positive = out) — ${parts.join(", ")}; net ${f(r.netFlux)}`;
  text += r.imbalance === null ? ` (imbalance unavailable — ${r.imbalanceNote})` : `, imbalance ${(100 * r.imbalance).toPrecision(3)}%`;
  if (r.pressureDrop) text += `; pressure drop ${r.pressureDrop.value === null ? "unavailable" : r.pressureDrop.value.toPrecision(5)}`;
  if (r.pressureConversion && r.pressureConversion.drop !== null) text += ` (${r.pressureConversion.drop.toPrecision(5)} Pa)`;
  if (r.dimension === 2) text += ". 2D: per unit depth.";
  return text;
}
