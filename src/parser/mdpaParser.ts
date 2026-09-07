import * as fs from "node:fs";
import * as readline from "node:readline";
import {
  EntityBlock,
  EntityKind,
  FieldBlockKind,
  FieldData,
  MdpaDiagnostic,
  MdpaModel,
  MetaBlock,
  SubModelPart,
} from "./types";
import { decodeTypeName } from "./geometryMap";
import {
  PropertySet,
  PropertyTable,
  addPropertyLine,
  emptyPropertySet,
  propertiesIdFromArgs,
} from "./propertiesParser";
import {
  ConstraintBlock,
  emptyConstraintBlock,
  parseConstraintRow,
} from "./constraintsParser";

type SubListKey =
  | "nodeIds"
  | "elementIds"
  | "conditionIds"
  | "geometryIds"
  | "constraintIds";

interface StagingBlock {
  kind: EntityKind;
  name: string;
  vtkCellType?: number;
  stride: number;           // 0 until first entity is parsed
  entityIds: number[];
  propertyIds: number[] | null; // null for Geometries
  connectivity: number[];
}

interface StagingField {
  kind: FieldBlockKind;
  variable: string;
  ids: number[];
  rows: number[][]; // one value array per record; width finalized in finish()
  fixed: number[]; // nodal is_fixed flag per record
  isNodal: boolean;
}

interface StagingSubModelPart {
  name: string;
  nodeIds: number[];
  elementIds: number[];
  conditionIds: number[];
  geometryIds: number[];
  constraintIds: number[];
  path: string;
  children: StagingSubModelPart[];
}

interface Frame {
  type: string;
  block?: StagingBlock;
  subModelPart?: StagingSubModelPart;
  listTarget?: { part: StagingSubModelPart; key: SubListKey };
  meta?: MetaBlock;
  field?: StagingField;
  /** Marks the frame as a `Begin Properties` block, whether or not it kept a set. */
  isProperties?: boolean;
  /** The set this Properties frame accumulates into (absent for a bad/duplicate id). */
  properties?: PropertySet;
  /**
   * Set on every frame opened *inside* a Properties block. Nothing nested there
   * may escape into the model: before this existed a `Begin Table` became a
   * stray top-level `MetaBlock` and — worse — a `Begin SubModelPart` was parsed
   * as a genuine SubModelPart, because `handleBegin` never consulted the
   * enclosing frame. `propTable` routes a nested Table's rows onto the owning
   * set; every other nested block is inert and its lines are swallowed.
   */
  propNested?: boolean;
  propTable?: PropertyTable;
  /** The block a `Begin Constraints` frame accumulates its rows into. */
  constraints?: ConstraintBlock;
}

const ENTITY_KINDS: Record<string, EntityKind> = {
  Elements: "Elements",
  Conditions: "Conditions",
  Geometries: "Geometries",
};

const SUBLIST_KEYS: Record<string, SubListKey> = {
  SubModelPartNodes: "nodeIds",
  SubModelPartElements: "elementIds",
  SubModelPartConditions: "conditionIds",
  SubModelPartGeometries: "geometryIds",
  SubModelPartConstraints: "constraintIds",
};

const FIELD_KINDS: Record<string, FieldBlockKind> = {
  NodalData: "Nodal",
  ElementalData: "Elemental",
  ConditionalData: "Conditional",
};

const META_TYPES = new Set([
  "ModelPartData",
  "Properties",
  "Table",
  "NodalData",
  "ElementalData",
  "ConditionalData",
  "Constraints",
  "Mesh",
  "MeshData",
  "MeshNodes",
  "MeshElements",
  "MeshConditions",
  "SubModelPartData",
  "SubModelPartTables",
  "SubModelPartProperties",
]);

function stripComment(line: string): string {
  const idx = line.indexOf("//");
  return idx === -1 ? line : line.slice(0, idx);
}

function stagingToSubModelPart(s: StagingSubModelPart): SubModelPart {
  return {
    name: s.name,
    nodeIds: new Int32Array(s.nodeIds),
    elementIds: new Int32Array(s.elementIds),
    conditionIds: new Int32Array(s.conditionIds),
    geometryIds: new Int32Array(s.geometryIds),
    constraintIds: new Int32Array(s.constraintIds),
    path: s.path,
    children: s.children.map(stagingToSubModelPart),
  };
}

export class MdpaParserCore {
  private lineNo = 0;
  private stagingNodeIds: number[] = [];
  private stagingCoords: number[] = []; // interleaved x,y,z
  private blockIndex = new Map<string, StagingBlock>();
  private blocks: StagingBlock[] = [];
  private stagingSubModelParts: StagingSubModelPart[] = [];
  private meta: MetaBlock[] = [];
  private properties: PropertySet[] = [];
  private constraintBlocks: ConstraintBlock[] = [];
  private stagingFields: StagingField[] = [];
  private diagnostics: { line: number; message: string }[] = [];
  private stack: Frame[] = [];

  /** The nearest enclosing Properties set, or undefined when its id was unusable. */
  private propertySetInScope(): PropertySet | undefined {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const f = this.stack[i];
      if (f.properties) return f.properties;
      if (f.isProperties) return undefined; // a Properties block that kept no set
    }
    return undefined;
  }

  private topSubModelPart(): StagingSubModelPart | undefined {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i].subModelPart) {
        return this.stack[i].subModelPart;
      }
    }
    return undefined;
  }

  feedLine(rawLine: string): void {
    this.lineNo++;
    const stripped = stripComment(rawLine).trim();
    if (stripped.length === 0) {
      return;
    }
    const tokens = stripped.split(/\s+/);
    const head = tokens[0];

    if (head === "Begin") {
      this.handleBegin(tokens);
      return;
    }
    if (head === "End") {
      this.handleEnd(tokens);
      return;
    }
    this.handleData(tokens, stripped);
  }

  private handleBegin(tokens: string[]): void {
    const blockType = tokens[1];
    const args = tokens.slice(2);
    if (!blockType) {
      this.diagnostics.push({ line: this.lineNo, message: "`Begin` without a block type." });
      this.stack.push({ type: "<unknown>" });
      return;
    }

    // Trap door: anything opened inside a Properties block stays inside it.
    // Deliberately generic rather than a `Table` special case — every branch
    // below (SubModelPart most dangerously) dispatches on the block type alone
    // and would otherwise leak a nested block into the model.
    const enclosing = this.stack[this.stack.length - 1];
    if (enclosing && (enclosing.isProperties || enclosing.propNested)) {
      const owner = this.propertySetInScope();
      if (blockType === "Table" && owner) {
        const table: PropertyTable = { args, rows: [] };
        owner.tables.push(table);
        this.stack.push({ type: blockType, propNested: true, propTable: table });
      } else {
        this.stack.push({ type: blockType, propNested: true });
      }
      return;
    }

    if (blockType === "Properties") {
      const id = propertiesIdFromArgs(args);
      if (id === undefined) {
        this.diagnostics.push({
          line: this.lineNo,
          message: `"Begin Properties ${args.join(" ")}" has no readable id; its values are ignored.`,
        });
      }
      // The MetaBlock is still recorded exactly as before, values or not: the
      // writer's verbatim path and mergeMesh's reporting both read `meta`.
      const label = args.length ? `${blockType} ${args.join(" ")}` : blockType;
      const metaBlock: MetaBlock = { label, lineCount: 0 };
      this.meta.push(metaBlock);
      let set: PropertySet | undefined;
      if (id !== undefined) {
        const existing = this.properties.find((p) => p.id === id);
        if (existing) {
          // Kratos itself errors on a duplicate. First wins, because last-wins
          // would let a trailing empty `Begin Properties 1 / End Properties`
          // silently blank a real section.
          this.diagnostics.push({
            line: this.lineNo,
            message: `Duplicate "Begin Properties ${id}"; the first block's values are kept.`,
          });
        } else {
          set = emptyPropertySet(id);
          this.properties.push(set);
        }
      }
      this.stack.push({ type: blockType, meta: metaBlock, properties: set, isProperties: true });
      return;
    }

    if (blockType === "Nodes") {
      this.stack.push({ type: "Nodes" });
    } else if (ENTITY_KINDS[blockType]) {
      const kind = ENTITY_KINDS[blockType];
      const name = args[0] ?? "<unnamed>";
      const key = `${kind}::${name}`;
      let block = this.blockIndex.get(key);
      if (!block) {
        const decoded = decodeTypeName(name);
        block = {
          kind,
          name,
          vtkCellType: decoded.vtkCellType,
          stride: 0,
          entityIds: [],
          propertyIds: kind === "Geometries" ? null : [],
          connectivity: [],
        };
        this.blockIndex.set(key, block);
        this.blocks.push(block);
      }
      this.stack.push({ type: blockType, block });
    } else if (blockType === "SubModelPart") {
      const name = args[0] ?? "<unnamed>";
      const parent = this.topSubModelPart();
      const part: StagingSubModelPart = {
        name,
        nodeIds: [],
        elementIds: [],
        conditionIds: [],
        geometryIds: [],
        constraintIds: [],
        path: parent ? `${parent.path}/${name}` : name,
        children: [],
      };
      if (parent) {
        parent.children.push(part);
      } else {
        this.stagingSubModelParts.push(part);
      }
      this.stack.push({ type: "SubModelPart", subModelPart: part });
    } else if (SUBLIST_KEYS[blockType]) {
      const part = this.topSubModelPart();
      if (!part) {
        this.diagnostics.push({
          line: this.lineNo,
          message: `${blockType} outside any SubModelPart.`,
        });
        this.stack.push({ type: blockType });
      } else {
        this.stack.push({
          type: blockType,
          listTarget: { part, key: SUBLIST_KEYS[blockType] },
        });
      }
    } else if (FIELD_KINDS[blockType]) {
      // NodalData / ElementalData / ConditionalData: keep the meta block (line count)
      // and additionally accumulate the actual field values.
      const kind = FIELD_KINDS[blockType];
      const variable = args[0] ?? "<unnamed>";
      const label = args.length ? `${blockType} ${args.join(" ")}` : blockType;
      const metaBlock: MetaBlock = { label, lineCount: 0 };
      this.meta.push(metaBlock);
      const field: StagingField = {
        kind,
        variable,
        ids: [],
        rows: [],
        fixed: [],
        isNodal: kind === "Nodal",
      };
      this.stagingFields.push(field);
      this.stack.push({ type: blockType, meta: metaBlock, field });
    } else if (blockType === "Constraints") {
      // Same "keep the meta block AND additionally accumulate the values" shape
      // as the FIELD_KINDS branch above: `MetaBlock.lineCount` keeps its
      // historical meaning exactly, so nothing that counts lines is disturbed,
      // while the rows also become real entities. `Constraints` deliberately
      // stays in META_TYPES — this branch shadows it, as FIELD_KINDS already
      // shadows it for NodalData — so handleEnd's block-type match is unchanged.
      const label = args.length ? `${blockType} ${args.join(" ")}` : blockType;
      const metaBlock: MetaBlock = { label, lineCount: 0 };
      this.meta.push(metaBlock);
      const block = emptyConstraintBlock(args);
      this.constraintBlocks.push(block);
      this.stack.push({ type: blockType, meta: metaBlock, constraints: block });
    } else if (META_TYPES.has(blockType)) {
      const label = args.length ? `${blockType} ${args.join(" ")}` : blockType;
      const metaBlock: MetaBlock = { label, lineCount: 0 };
      this.meta.push(metaBlock);
      this.stack.push({ type: blockType, meta: metaBlock });
    } else {
      this.diagnostics.push({
        line: this.lineNo,
        message: `Unknown block type "${blockType}"; contents ignored.`,
      });
      this.stack.push({ type: blockType });
    }
  }

  private handleEnd(tokens: string[]): void {
    const endType = tokens[1];
    const frame = this.stack.pop();
    if (!frame) {
      this.diagnostics.push({ line: this.lineNo, message: `Stray "End ${endType ?? ""}".` });
    } else if (endType && frame.type !== endType && frame.type !== "<unknown>") {
      this.diagnostics.push({
        line: this.lineNo,
        message: `"End ${endType}" does not match open block "${frame.type}".`,
      });
    }
  }

  private handleData(tokens: string[], line: string): void {
    const frame = this.stack[this.stack.length - 1];
    if (!frame) {
      this.diagnostics.push({ line: this.lineNo, message: "Data line outside any block." });
      return;
    }

    // Inside a Properties block, before the ordinary dispatch: a nested Table's
    // rows go onto the owning set, and every other nested block's lines are
    // swallowed. `lineCount` keeps its historical meaning — a nested block's
    // lines were never counted against the enclosing Properties and still are
    // not, so the writer's verbatim path and mergeMesh's reporting are unchanged.
    if (frame.propNested) {
      if (frame.propTable) {
        const nums = tokens.map(Number);
        if (nums.every((n) => Number.isFinite(n))) frame.propTable.rows.push(nums);
      }
      return;
    }
    if (frame.isProperties) {
      frame.meta!.lineCount++;
      if (frame.properties) {
        addPropertyLine(frame.properties, tokens, line, (message) =>
          this.diagnostics.push({ line: this.lineNo, message })
        );
      }
      return;
    }

    if (frame.type === "Nodes") {
      if (tokens.length < 4) {
        this.diagnostics.push({ line: this.lineNo, message: "Node line needs id X Y Z." });
        return;
      }
      this.stagingNodeIds.push(parseInt(tokens[0], 10));
      this.stagingCoords.push(Number(tokens[1]), Number(tokens[2]), Number(tokens[3]));
    } else if (frame.block) {
      const b = frame.block;
      const id = parseInt(tokens[0], 10);
      if (b.kind === "Geometries") {
        const nodeIds = tokens.slice(1).map((t) => parseInt(t, 10));
        if (b.stride === 0) {
          b.stride = nodeIds.length;
        }
        b.entityIds.push(id);
        for (const nid of nodeIds) {
          b.connectivity.push(nid);
        }
      } else {
        const propId = tokens.length > 1 ? parseInt(tokens[1], 10) : 0;
        const nodeIds = tokens.slice(2).map((t) => parseInt(t, 10));
        if (b.stride === 0) {
          b.stride = nodeIds.length;
        }
        b.entityIds.push(id);
        b.propertyIds!.push(propId);
        for (const nid of nodeIds) {
          b.connectivity.push(nid);
        }
      }
    } else if (frame.listTarget) {
      const id = parseInt(tokens[0], 10);
      if (!Number.isNaN(id)) {
        frame.listTarget.part[frame.listTarget.key].push(id);
      }
    } else if (frame.field) {
      if (frame.meta) frame.meta.lineCount++;
      this.parseFieldRecord(frame.field, tokens);
    } else if (frame.constraints) {
      if (frame.meta) frame.meta.lineCount++;
      frame.constraints.rows.push(
        parseConstraintRow(line, (m) =>
          this.diagnostics.push({ line: this.lineNo, message: `Constraints: ${m}` })
        )
      );
    } else if (frame.meta) {
      frame.meta.lineCount++;
    }
  }

  // Parses one NodalData/ElementalData/ConditionalData record. Tolerant: a malformed
  // line emits a diagnostic and is skipped rather than aborting the block.
  // Forms handled:
  //   scalar nodal:        id is_fixed value
  //   scalar elem/cond:    id value
  //   flag-only nodal:     id                (e.g. `Begin NodalData BOUNDARY`)
  //   vector (any kind):   id [is_fixed] [N] (v1, v2, ...)
  private parseFieldRecord(field: StagingField, tokens: string[]): void {
    const id = parseInt(tokens[0], 10);
    if (Number.isNaN(id)) {
      this.diagnostics.push({
        line: this.lineNo,
        message: `Invalid ${field.kind}Data entity id "${tokens[0]}".`,
      });
      return;
    }
    const rest = tokens.slice(1);
    const restStr = rest.join(" ");
    let fixed = 0;
    let vals: number[];

    const parenStart = restStr.indexOf("(");
    if (parenStart !== -1) {
      // vector form: optional fixed flag, optional [N], then (v1, v2, ...)
      const parenEnd = restStr.indexOf(")", parenStart);
      const inner =
        parenEnd === -1 ? restStr.slice(parenStart + 1) : restStr.slice(parenStart + 1, parenEnd);
      vals = inner
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => Number(s));
      const bracket = restStr.indexOf("[");
      const lead = restStr.slice(0, bracket === -1 ? parenStart : bracket).trim();
      if (field.isNodal && /^\d+$/.test(lead)) fixed = parseInt(lead, 10);
    } else if (rest.length === 0) {
      // flag-only nodal data: just the entity id is listed → treat as a set flag (value 1)
      fixed = 1;
      vals = [1];
    } else if (field.isNodal) {
      if (rest.length >= 2) {
        fixed = parseInt(rest[0], 10) || 0;
        vals = [Number(rest[1])];
      } else {
        vals = [Number(rest[0])];
      }
    } else {
      vals = [Number(rest[0])];
    }

    if (vals.length === 0 || vals.some((n) => Number.isNaN(n))) {
      this.diagnostics.push({
        line: this.lineNo,
        message: `Invalid ${field.kind}Data value for entity ${id}.`,
      });
      return;
    }

    field.ids.push(id);
    field.rows.push(vals);
    field.fixed.push(fixed);
  }

  finish(): MdpaModel {
    if (this.stack.length > 0) {
      this.diagnostics.push({
        line: this.lineNo,
        message: `${this.stack.length} block(s) not closed by end of file.`,
      });
    }

    const nodeCount = this.stagingNodeIds.length;
    const nodeIds = new Int32Array(this.stagingNodeIds);
    const coords = new Float32Array(this.stagingCoords);

    const blocks: EntityBlock[] = this.blocks.map((b) => {
      const block: EntityBlock = {
        kind: b.kind,
        name: b.name,
        vtkCellType: b.vtkCellType,
        count: b.entityIds.length,
        stride: b.stride,
        entityIds: new Int32Array(b.entityIds),
        connectivity: new Int32Array(b.connectivity),
      };
      if (b.propertyIds !== null) {
        block.propertyIds = new Int32Array(b.propertyIds);
      }
      return block;
    });

    const subModelParts = this.stagingSubModelParts.map(stagingToSubModelPart);

    const fields: FieldData[] = this.stagingFields.map((f) => {
      let components = 1;
      for (const row of f.rows) {
        if (row.length > components) components = row.length;
      }
      const count = f.ids.length;
      const values = new Float64Array(count * components);
      for (let i = 0; i < count; i++) {
        const row = f.rows[i];
        for (let k = 0; k < components; k++) {
          values[i * components + k] = k < row.length ? row[k] : 0;
        }
      }
      const field: FieldData = {
        kind: f.kind,
        variable: f.variable,
        components,
        ids: new Int32Array(f.ids),
        values,
      };
      if (f.isNodal) {
        field.fixed = Uint8Array.from(f.fixed, (x) => (x ? 1 : 0));
      }
      return field;
    });

    // Bounds + dimensionality
    let is3D = false;
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < nodeCount; i++) {
      const x = coords[i * 3];
      const y = coords[i * 3 + 1];
      const z = coords[i * 3 + 2];
      if (x < min[0]) min[0] = x;
      if (y < min[1]) min[1] = y;
      if (z < min[2]) min[2] = z;
      if (x > max[0]) max[0] = x;
      if (y > max[1]) max[1] = y;
      if (z > max[2]) max[2] = z;
      if (Math.abs(z) > 1e-12) {
        is3D = true;
      }
    }
    if (nodeCount === 0) {
      min[0] = min[1] = min[2] = 0;
      max[0] = max[1] = max[2] = 0;
    }

    return {
      nodeCount,
      nodeIds,
      coords,
      blocks,
      subModelParts,
      meta: this.meta,
      fields,
      diagnostics: this.diagnostics,
      is3D,
      bounds: { min, max },
      // Omitted entirely when the file declared none, so a mesh without
      // Properties is byte-identical to what it was before this existed.
      ...(this.properties.length > 0 ? { properties: this.properties } : {}),
      // Same conditional spread, same reason: a mesh with no Constraints block
      // is byte-identical to what it was before this existed.
      ...(this.constraintBlocks.length > 0 ? { constraints: this.constraintBlocks } : {}),
    };
  }
}

export function parseMdpa(text: string): MdpaModel {
  const core = new MdpaParserCore();
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    core.feedLine(line);
  }
  return core.finish();
}

export async function parseMdpaFile(
  fsPath: string,
  onProgress?: (phase: "read", bytesRead: number, totalBytes: number) => void
): Promise<MdpaModel> {
  const stat = await fs.promises.stat(fsPath);
  const totalBytes = stat.size;

  return new Promise<MdpaModel>((resolve, reject) => {
    const core = new MdpaParserCore();
    let bytesRead = 0;
    let lineCount = 0;

    const stream = fs.createReadStream(fsPath, { encoding: "utf8" });
    stream.on("data", (chunk: string | Buffer) => {
      bytesRead += typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.length;
    });

    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on("line", (line) => {
      core.feedLine(line);
      lineCount++;
      if (onProgress && lineCount % 50_000 === 0) {
        onProgress("read", bytesRead, totalBytes);
      }
    });

    rl.on("close", () => {
      if (onProgress) {
        onProgress("read", totalBytes, totalBytes);
      }
      try {
        resolve(core.finish());
      } catch (err) {
        reject(err);
      }
    });

    rl.on("error", reject);
    stream.on("error", reject);
  });
}

// ---- Summary scanner ------------------------------------------------------------

/**
 * Counting-only companion to `MdpaParserCore`, for `meshSummary.ts`.
 *
 * MDPA declares no counts anywhere — a block's size is implied by how many
 * lines precede its `End` — so a summary of one CANNOT be a bounded header
 * read; it has to stream the whole file. What it can avoid is everything that
 * makes parsing expensive: no `parseInt`/`Number` per token, no multi-million
 * element arrays, no typed arrays, and no giant model to structured-clone
 * across `postMessage`. A data line here is `n++` and nothing else.
 *
 * It lives beside the parser rather than in `meshSummary.ts` so it can reuse
 * `stripComment`, `ENTITY_KINDS`, `SUBLIST_KEYS` and `FIELD_KINDS` directly —
 * and, critically, so it can replicate `handleBegin`'s **Properties trap door**:
 * a `Begin Table` nested inside `Begin Properties` must not be counted as a
 * block, exactly as it must not become one when parsing.
 */
export interface MdpaScanBlock {
  kind: EntityKind;
  name: string;
  count: number;
}

export interface MdpaScanPart {
  path: string;
  counts: Partial<Record<SubListKey, number>>;
}

export interface MdpaScanResult {
  nodeCount: number;
  blocks: MdpaScanBlock[];
  parts: MdpaScanPart[];
  fields: { kind: FieldBlockKind; variable: string }[];
  propertyIds: number[];
  constraintBlocks: string[];
  diagnostics: MdpaDiagnostic[];
}

interface ScanFrame {
  type: string;
  isProperties?: boolean;
  propNested?: boolean;
  /** Set when data lines in this frame should be counted. */
  counting?: boolean;
  count: number;
  entity?: { kind: EntityKind; name: string };
  field?: { kind: FieldBlockKind; variable: string };
  list?: SubListKey;
  partPath?: string;
}

export class MdpaSummaryScanner {
  private readonly stack: ScanFrame[] = [];
  private readonly partStack: string[] = [];
  private lineNo = 0;

  readonly result: MdpaScanResult = {
    nodeCount: 0,
    blocks: [],
    parts: [],
    fields: [],
    propertyIds: [],
    constraintBlocks: [],
    diagnostics: [],
  };

  feedLine(rawLine: string): void {
    this.lineNo++;
    const stripped = stripComment(rawLine).trim();
    if (stripped.length === 0) return;
    const head = stripped.slice(0, stripped.search(/\s|$/));
    if (head === "Begin") {
      this.begin(stripped.split(/\s+/));
      return;
    }
    if (head === "End") {
      this.end();
      return;
    }
    const top = this.stack[this.stack.length - 1];
    if (top?.counting) top.count++;
  }

  private begin(tokens: string[]): void {
    const blockType = tokens[1];
    const args = tokens.slice(2);
    if (!blockType) {
      this.stack.push({ type: "<unknown>", count: 0 });
      return;
    }

    // The trap door, mirroring handleBegin: anything opened inside a Properties
    // block stays inside it and is counted as nothing.
    const enclosing = this.stack[this.stack.length - 1];
    if (enclosing && (enclosing.isProperties || enclosing.propNested)) {
      this.stack.push({ type: blockType, propNested: true, count: 0 });
      return;
    }

    if (blockType === "Properties") {
      const id = parseInt(args[0], 10);
      if (!isNaN(id)) this.result.propertyIds.push(id);
      this.stack.push({ type: blockType, isProperties: true, count: 0 });
      return;
    }
    if (blockType === "Nodes") {
      this.stack.push({ type: blockType, counting: true, count: 0 });
      return;
    }
    if (ENTITY_KINDS[blockType]) {
      this.stack.push({
        type: blockType,
        counting: true,
        count: 0,
        entity: { kind: ENTITY_KINDS[blockType], name: args[0] ?? blockType },
      });
      return;
    }
    if (FIELD_KINDS[blockType]) {
      this.stack.push({
        type: blockType,
        counting: true,
        count: 0,
        field: { kind: FIELD_KINDS[blockType], variable: args[0] ?? "" },
      });
      return;
    }
    if (SUBLIST_KEYS[blockType]) {
      this.stack.push({ type: blockType, counting: true, count: 0, list: SUBLIST_KEYS[blockType] });
      return;
    }
    if (blockType === "SubModelPart") {
      const name = args[0] ?? "";
      this.partStack.push(name);
      const path = this.partStack.join("/");
      this.result.parts.push({ path, counts: {} });
      this.stack.push({ type: blockType, count: 0, partPath: path });
      return;
    }
    if (blockType === "Constraints") {
      this.result.constraintBlocks.push(args[0] ?? "");
      this.stack.push({ type: blockType, counting: true, count: 0 });
      return;
    }
    this.stack.push({ type: blockType, count: 0 });
  }

  private end(): void {
    const frame = this.stack.pop();
    if (!frame) {
      this.result.diagnostics.push({ line: this.lineNo, message: "`End` without a matching `Begin`." });
      return;
    }
    if (frame.type === "Nodes") {
      this.result.nodeCount += frame.count;
      return;
    }
    if (frame.entity) {
      // Repeated `Begin Elements <Name>` blocks merge into one, as the parser
      // merges them into one EntityBlock.
      const found = this.result.blocks.find(
        (b) => b.kind === frame.entity!.kind && b.name === frame.entity!.name
      );
      if (found) found.count += frame.count;
      else this.result.blocks.push({ ...frame.entity, count: frame.count });
      return;
    }
    if (frame.field) {
      const has = this.result.fields.some(
        (f) => f.kind === frame.field!.kind && f.variable === frame.field!.variable
      );
      if (!has) this.result.fields.push({ ...frame.field });
      return;
    }
    if (frame.list) {
      const part = this.result.parts.find((p) => p.path === this.partStack.join("/"));
      if (part) part.counts[frame.list] = (part.counts[frame.list] ?? 0) + frame.count;
      return;
    }
    if (frame.partPath !== undefined) this.partStack.pop();
  }

  finish(): MdpaScanResult {
    if (this.stack.length > 0) {
      this.result.diagnostics.push({
        line: this.lineNo,
        message: `${this.stack.length} block(s) left unclosed at end of file.`,
      });
    }
    return this.result;
  }
}
