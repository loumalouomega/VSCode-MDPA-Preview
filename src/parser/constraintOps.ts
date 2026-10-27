/**
 * Creating and deleting single multi-point constraints (former roadmap item 23).
 * Pure. Both keep the two id spaces a constraint lives in consistent: the node
 * ids it names must exist, and a deleted id is pruned from every SubModelPart
 * (the defect `constraintsParser.ts` exists to prevent).
 */
import {
  ConstraintBlock,
  definedConstraintIds,
  filterConstraintsById,
  maxDefinedConstraintId,
  pruneSubModelPartConstraints,
} from "./constraintsParser";
import type { MdpaModel, SubModelPart } from "./types";

export interface CreateConstraintParams {
  slave: number;
  masters: number[];
  weights: number[];
  variable: string;
  constant?: number;
  /** A SubModelPart path that should list the new constraint. */
  part?: string;
}

const listed = (p: SubModelPart): number[] => [...Array.from(p.constraintIds), ...p.children.flatMap(listed)];

export function createConstraintModel(model: MdpaModel, p: CreateConstraintParams): { model: MdpaModel; id: number } {
  const have = new Set<number>(Array.from(model.nodeIds));
  if (!have.has(p.slave)) throw new Error(`Slave node ${p.slave} is not in the mesh.`);
  if (p.masters.length === 0) throw new Error("A constraint needs at least one master node.");
  if (p.masters.length !== p.weights.length) throw new Error("Give one weight per master node.");
  for (const m of p.masters) if (!have.has(m)) throw new Error(`Master node ${m} is not in the mesh.`);
  if (p.masters.includes(p.slave)) throw new Error("A node cannot be its own master.");
  if (new Set(p.masters).size !== p.masters.length) throw new Error("Master nodes must be distinct (merge their weights).");
  if (p.weights.some((w) => !Number.isFinite(w))) throw new Error("Weights must be finite numbers.");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.variable)) throw new Error(`"${p.variable}" is not a legal variable name.`);

  const blocks = model.constraints ?? [];
  let id = maxDefinedConstraintId(blocks);
  for (const sp of model.subModelParts) for (const v of listed(sp)) if (v > id) id = v;
  id += 1;
  const row = { kind: "linear" as const, id, constant: p.constant ?? 0, weights: p.weights.slice(), slaveIds: [p.slave], masterIds: p.masters.slice() };
  const name = "LinearMasterSlaveConstraint";
  const at = blocks.findIndex((b) => b.name === name && b.variables.length === 1 && b.variables[0] === p.variable);
  const next: ConstraintBlock[] =
    at >= 0
      ? blocks.map((b, i) => (i === at ? { ...b, rows: [...b.rows, row] } : b))
      : [...blocks, { name, variables: [p.variable], rows: [row] }];

  let parts = model.subModelParts;
  if (p.part) {
    let found = false;
    const walk = (sp: SubModelPart): SubModelPart => {
      if (sp.path === p.part) {
        found = true;
        return { ...sp, constraintIds: Int32Array.from([...Array.from(sp.constraintIds), id]) };
      }
      return { ...sp, children: sp.children.map(walk) };
    };
    parts = model.subModelParts.map(walk);
    if (!found) throw new Error(`SubModelPart "${p.part}" does not exist.`);
  }
  return { model: { ...model, constraints: next, subModelParts: parts }, id };
}

export function deleteConstraintsModel(model: MdpaModel, ids: number[]): { model: MdpaModel; deleted: number } {
  const drop = new Set(ids);
  const before = definedConstraintIds(model.constraints);
  const deleted = before.filter((id) => drop.has(id)).length;
  if (deleted === 0) return { model, deleted: 0 };
  const constraints = filterConstraintsById(model.constraints, (id) => !drop.has(id));
  const keep = new Set(definedConstraintIds(constraints));
  const parts = pruneSubModelPartConstraints(model.subModelParts, keep).parts;
  return { model: { ...model, constraints, subModelParts: parts }, deleted };
}
