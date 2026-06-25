import * as fs from "node:fs";
import * as readline from "node:readline";
import {
  EntityBlock,
  EntityKind,
  FieldBlockKind,
  FieldData,
  MdpaModel,
  MetaBlock,
  SubModelPart,
} from "./types";
import { decodeTypeName } from "./geometryMap";

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
  private stagingFields: StagingField[] = [];
  private diagnostics: { line: number; message: string }[] = [];
  private stack: Frame[] = [];

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
    this.handleData(tokens);
  }

  private handleBegin(tokens: string[]): void {
    const blockType = tokens[1];
    const args = tokens.slice(2);
    if (!blockType) {
      this.diagnostics.push({ line: this.lineNo, message: "`Begin` without a block type." });
      this.stack.push({ type: "<unknown>" });
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

  private handleData(tokens: string[]): void {
    const frame = this.stack[this.stack.length - 1];
    if (!frame) {
      this.diagnostics.push({ line: this.lineNo, message: "Data line outside any block." });
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
