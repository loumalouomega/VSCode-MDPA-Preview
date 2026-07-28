/**
 * Field calculator + nodal <-> elemental averaging: derive a new field from an
 * expression over the mesh's existing ones, or move a field between the nodal
 * and elemental/conditional locations by averaging.
 *
 * Pure module: no vscode / DOM / vtk.js imports so it stays Node-testable. The
 * input is never mutated; a fresh MdpaModel is returned.
 *
 * Native rather than meshio++'s `dataCalc`/`dataPointToCell`/`dataCellToPoint`
 * for a reason that has nothing to do with the round-trip-fidelity problem the
 * other modules in this file work around: those operations don't touch
 * geometry at all, so there is nothing to repair on the way back. They are
 * native because our own tools are simply better suited —
 * `parseSizeExpr` (`sizeExpr.ts`) is a real recursive-descent parser that
 * already exists for the MMG remesh-sizing formulas, never `eval`, which
 * matters because a saved recipe or problem archive is untrusted disk input.
 * Reusing it here means the same whitelist of functions/constants, the same
 * error messages, and the same webview validation path.
 */

import { FieldData, FieldBlockKind, MdpaModel } from "./types";
import { parseSizeExpr } from "./sizeExpr";
import { nodeIndexMap } from "./writers/writerCommon";

/** Only Elements/Conditions carry cell data worth targeting here (Geometries have none in practice). */
export type CellBlockKind = "Elements" | "Conditions";

function fieldKindFor(target: CellBlockKind): FieldBlockKind {
  return target === "Elements" ? "Elemental" : "Conditional";
}

// --- field calculator -------------------------------------------------------

export interface FieldCalcParams {
  expr: string;
  /** Where the new field lives, and which existing fields it can reference. */
  location: FieldBlockKind;
  /** Variable name for the result. */
  output: string;
}

export interface FieldCalcResult {
  model: MdpaModel;
  /** Entities the expression produced a finite value for. */
  computed: number;
}

/** name -> component count, for every field already at `location`. */
function fieldsAt(model: MdpaModel, location: FieldBlockKind): FieldData[] {
  return model.fields.filter((f) => f.kind === location);
}

/**
 * The variable names available to an expression at `location`: `x`/`y`/`z`
 * (node coordinate for Nodal, cell centroid otherwise) plus every existing
 * field there — a scalar field by its own name, a vector field split into
 * `name_X`/`name_Y`/`name_Z` (there is no shape information to carry a whole
 * vector through the evaluator, and a per-component name is what the MMG
 * sizing expressions already establish as the convention for this evaluator).
 */
function scopeVariables(fields: FieldData[]): string[] {
  // Lowercased: parseSizeExpr's tokenizer lowercases every identifier before
  // matching it against the allowed set (by design, for its own h/mean/std
  // variables), so a Kratos-style UPPERCASE field name must be exposed to it
  // in lowercase too, or "Unknown name" fires despite the name being allowed.
  const vars = ["x", "y", "z"];
  const axis = ["x", "y", "z"];
  for (const f of fields) {
    if (f.components === 1) vars.push(f.variable.toLowerCase());
    else {
      for (let c = 0; c < Math.min(f.components, 3); c++) {
        vars.push(`${f.variable}_${axis[c]}`.toLowerCase());
      }
    }
  }
  return vars;
}

/** Per-entity id -> component-expanded scope values, NaN where a field is silent. */
function valueMaps(fields: FieldData[]): Map<string, Map<number, number>> {
  // Keyed by the same lowercased names scopeVariables() exposes, so a lookup
  // by a compiled expression's (already-lowercased) variable name just works.
  const axis = ["x", "y", "z"];
  const out = new Map<string, Map<number, number>>();
  for (const f of fields) {
    if (f.components === 1) {
      const m = new Map<number, number>();
      for (let i = 0; i < f.ids.length; i++) m.set(f.ids[i], f.values[i]);
      out.set(f.variable.toLowerCase(), m);
    } else {
      for (let c = 0; c < Math.min(f.components, 3); c++) {
        const m = new Map<number, number>();
        for (let i = 0; i < f.ids.length; i++) m.set(f.ids[i], f.values[i * f.components + c]);
        out.set(`${f.variable}_${axis[c]}`.toLowerCase(), m);
      }
    }
  }
  return out;
}

/** entity id -> its node ids, for every Elements/Conditions/Geometries cell. */
function cellNodesById(model: MdpaModel, location: FieldBlockKind): Map<number, number[]> {
  const kind = location === "Conditional" ? "Conditions" : "Elements";
  const out = new Map<number, number[]>();
  for (const b of model.blocks) {
    if (b.kind !== kind) continue;
    for (let c = 0; c < b.count; c++) {
      out.set(b.entityIds[c], Array.from(b.connectivity.subarray(c * b.stride, (c + 1) * b.stride)));
    }
  }
  return out;
}

export function fieldCalcModel(model: MdpaModel, params: FieldCalcParams): FieldCalcResult {
  const location = params.location;
  const existing = fieldsAt(model, location);
  const vars = scopeVariables(existing);
  // Compiling before touching anything means a bad formula is rejected
  // outright — important since a saved recipe replays with no user around to
  // catch a typo.
  const compiled = parseSizeExpr(params.expr, vars);
  const values = valueMaps(existing);

  const idx = nodeIndexMap(model);
  const centroidOf = (nodeIds: number[]): [number, number, number] => {
    let x = 0, y = 0, z = 0;
    for (const n of nodeIds) {
      const i = idx.get(n);
      if (i === undefined) continue;
      x += model.coords[i * 3];
      y += model.coords[i * 3 + 1];
      z += model.coords[i * 3 + 2];
    }
    const k = nodeIds.length || 1;
    return [x / k, y / k, z / k];
  };

  const ids: number[] = [];
  const out: number[] = [];

  const evalAt = (id: number, x: number, y: number, z: number): void => {
    const scope: Record<string, number> = { x, y, z };
    for (const v of compiled.variablesUsed) {
      if (v === "x" || v === "y" || v === "z") continue;
      scope[v] = values.get(v)?.get(id) ?? NaN;
    }
    const v = compiled.evaluate(scope);
    // NaN means "could not be computed" (a referenced field is silent here)
    // and the row is dropped; Infinity is a real result (e.g. 1/0) and kept —
    // the same split meshio++'s dataCalc makes deliberately.
    if (Number.isNaN(v)) return;
    ids.push(id);
    out.push(v);
  };

  if (location === "Nodal") {
    for (let i = 0; i < model.nodeCount; i++) {
      const o = i * 3;
      evalAt(model.nodeIds[i], model.coords[o], model.coords[o + 1], model.coords[o + 2]);
    }
  } else {
    for (const [id, nodeIds] of cellNodesById(model, location)) {
      const [x, y, z] = centroidOf(nodeIds);
      evalAt(id, x, y, z);
    }
  }

  if (ids.length === 0) return { model, computed: 0 };

  const field: FieldData = {
    kind: location,
    variable: params.output,
    components: 1,
    ids: Int32Array.from(ids),
    values: Float64Array.from(out),
  };
  return {
    model: {
      ...model,
      fields: [
        ...model.fields.filter((f) => !(f.kind === location && f.variable === params.output)),
        field,
      ],
    },
    computed: ids.length,
  };
}

// --- nodal <-> elemental averaging ------------------------------------------

export type AverageDirection = "nodalToElemental" | "elementalToNodal";

export interface AverageFieldParams {
  variable: string;
  direction: AverageDirection;
  /** Which cell kind to target (nodalToElemental) or read from (elementalToNodal). */
  target?: CellBlockKind;
  output?: string;
}

export interface AverageFieldResult {
  model: MdpaModel;
  computed: number;
}

export function averageField(model: MdpaModel, params: AverageFieldParams): AverageFieldResult {
  const target = params.target ?? "Elements";
  const cellKind = fieldKindFor(target);
  const outputName = params.output ?? params.variable;

  if (params.direction === "nodalToElemental") {
    const nodal = model.fields.find((f) => f.kind === "Nodal" && f.variable === params.variable);
    if (!nodal) return { model, computed: 0 };
    const valueOf = new Map<number, number[]>();
    for (let i = 0; i < nodal.ids.length; i++) {
      valueOf.set(
        nodal.ids[i],
        Array.from(nodal.values.subarray(i * nodal.components, (i + 1) * nodal.components))
      );
    }
    const ids: number[] = [];
    const out: number[][] = [];
    for (const [id, nodeIds] of cellNodesById(model, cellKind)) {
      const vs = nodeIds.map((n) => valueOf.get(n));
      if (vs.some((v) => !v)) continue; // not every node of this cell carries the field
      const comps = nodal.components;
      const mean = new Array(comps).fill(0);
      for (const v of vs) for (let k = 0; k < comps; k++) mean[k] += v![k] / vs.length;
      ids.push(id);
      out.push(mean);
    }
    if (ids.length === 0) return { model, computed: 0 };
    const field: FieldData = {
      kind: cellKind,
      variable: outputName,
      components: nodal.components,
      ids: Int32Array.from(ids),
      values: Float64Array.from(out.flat()),
    };
    return {
      model: {
        ...model,
        fields: [
          ...model.fields.filter((f) => !(f.kind === cellKind && f.variable === outputName)),
          field,
        ],
      },
      computed: ids.length,
    };
  }

  // elementalToNodal
  const cellField = model.fields.find((f) => f.kind === cellKind && f.variable === params.variable);
  if (!cellField) return { model, computed: 0 };
  const valueOf = new Map<number, number[]>();
  for (let i = 0; i < cellField.ids.length; i++) {
    valueOf.set(
      cellField.ids[i],
      Array.from(cellField.values.subarray(i * cellField.components, (i + 1) * cellField.components))
    );
  }
  const perNode = new Map<number, number[][]>();
  for (const [id, nodeIds] of cellNodesById(model, cellKind)) {
    const v = valueOf.get(id);
    if (!v) continue;
    for (const n of nodeIds) {
      const list = perNode.get(n);
      if (list) list.push(v);
      else perNode.set(n, [v]);
    }
  }
  const ids: number[] = [];
  const out: number[][] = [];
  const comps = cellField.components;
  for (const [n, list] of perNode) {
    const mean = new Array(comps).fill(0);
    for (const v of list) for (let k = 0; k < comps; k++) mean[k] += v[k] / list.length;
    ids.push(n);
    out.push(mean);
  }
  if (ids.length === 0) return { model, computed: 0 };
  const field: FieldData = {
    kind: "Nodal",
    variable: outputName,
    components: comps,
    ids: Int32Array.from(ids),
    values: Float64Array.from(out.flat()),
  };
  return {
    model: {
      ...model,
      fields: [
        ...model.fields.filter((f) => !(f.kind === "Nodal" && f.variable === outputName)),
        field,
      ],
    },
    computed: ids.length,
  };
}
