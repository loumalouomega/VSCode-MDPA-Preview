/**
 * Buffer-aware reader for VTK XML files (.vtu/.vtp/.vti/.vts/.vtr/.vtm).
 *
 * A VTK XML file with `<AppendedData encoding="raw">` is NOT well-formed XML
 * (raw binary follows the `_` marker), so the file is split at the byte level
 * first: the XML head is tokenized by a small hand-rolled parser, and the
 * appended payload is kept as a Buffer indexed by DataArray `offset`
 * attributes.  DataArray decoding covers the full VTK encoding matrix:
 * ascii, inline base64 (uncompressed and zlib-compressed), and appended
 * raw/base64 — with header_type UInt32/UInt64 and both byte orders.
 *
 * Pure module: no vscode/DOM/vtk imports (node:zlib only).
 */

import * as zlib from "node:zlib";
import { MdpaDiagnostic } from "./types";
import { binaryType, BinaryType } from "./binaryTypes";

// ---- Types ---------------------------------------------------------------------

export interface XmlEl {
  tag: string;
  attrs: Record<string, string>;
  children: XmlEl[];
  /** Byte range of this element's character data within the head buffer. */
  textStart: number;
  textEnd: number;
}

export interface VtkXmlFile {
  root: XmlEl; // <VTKFile>
  head: Buffer; // bytes up to (excluding) the appended payload
  datasetType: string; // VTKFile type attr, e.g. "UnstructuredGrid"
  littleEndian: boolean;
  headerType: "UInt32" | "UInt64";
  compressed: boolean;
  appended?: { buf: Buffer; encoding: "raw" | "base64" };
}

// ---- XML tokenizer ----------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m] ?? m);
}

/**
 * Tokenizes the XML head (latin1 → indices equal byte offsets) into an
 * element tree.  Tolerant: unclosed elements are auto-closed at end of input
 * (the head is cut before `<AppendedData>`, so `</VTKFile>` may be missing).
 */
function tokenize(text: string): XmlEl | null {
  let pos = 0;
  const n = text.length;
  let root: XmlEl | null = null;
  const stack: XmlEl[] = [];

  while (pos < n) {
    const lt = text.indexOf("<", pos);
    if (lt < 0) break;

    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      pos = end < 0 ? n : end + 3;
      continue;
    }
    if (text.startsWith("<?", lt)) {
      const end = text.indexOf("?>", lt + 2);
      pos = end < 0 ? n : end + 2;
      continue;
    }
    if (text.startsWith("<!", lt)) {
      const end = text.indexOf(">", lt + 2);
      pos = end < 0 ? n : end + 1;
      continue;
    }
    if (text.startsWith("</", lt)) {
      const end = text.indexOf(">", lt + 2);
      if (end < 0) break;
      const closed = stack.pop();
      if (closed) closed.textEnd = lt;
      pos = end + 1;
      continue;
    }

    // Opening tag
    const end = text.indexOf(">", lt + 1);
    if (end < 0) break;
    const selfClosing = text[end - 1] === "/";
    const inner = text.slice(lt + 1, selfClosing ? end - 1 : end).trim();
    const spaceIdx = inner.search(/[\s]/);
    const tag = spaceIdx < 0 ? inner : inner.slice(0, spaceIdx);
    const attrText = spaceIdx < 0 ? "" : inner.slice(spaceIdx + 1);

    const attrs: Record<string, string> = {};
    const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(attrText)) !== null) {
      attrs[m[1]] = decodeEntities(m[3] ?? m[4] ?? "");
    }

    const el: XmlEl = {
      tag,
      attrs,
      children: [],
      textStart: selfClosing ? end + 1 : end + 1,
      textEnd: selfClosing ? end + 1 : n,
    };
    if (stack.length > 0) {
      stack[stack.length - 1].children.push(el);
    } else if (!root) {
      root = el;
    }
    if (!selfClosing) stack.push(el);
    pos = end + 1;
  }

  return root;
}

// ---- File-level parsing --------------------------------------------------------------

/**
 * Splits off any AppendedData payload at the byte level, tokenizes the XML
 * head, and reads the VTKFile-level attributes.  Throws on non-VTK XML.
 */
export function parseVtkXmlFile(buf: Buffer): VtkXmlFile {
  // Strip a UTF-8 BOM if present
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    buf = buf.subarray(3);
  }

  let head = buf;
  let appended: VtkXmlFile["appended"];

  const apIdx = buf.indexOf("<AppendedData");
  if (apIdx >= 0) {
    const tagEnd = buf.indexOf(0x3e /* > */, apIdx);
    if (tagEnd >= 0) {
      const tagText = buf.subarray(apIdx, tagEnd + 1).toString("latin1");
      const encoding = /encoding\s*=\s*["']raw["']/.test(tagText) ? "raw" : "base64";
      const marker = buf.indexOf(0x5f /* _ */, tagEnd + 1);
      const close = buf.lastIndexOf("</AppendedData");
      if (marker >= 0 && close > marker) {
        appended = { buf: buf.subarray(marker + 1, close), encoding };
        head = buf.subarray(0, apIdx);
      }
    }
  }

  const root = tokenize(head.toString("latin1"));
  if (!root || root.tag !== "VTKFile") {
    throw new Error("Not a VTK XML file (missing <VTKFile> root element).");
  }

  return {
    root,
    head,
    datasetType: root.attrs.type ?? "",
    littleEndian: root.attrs.byte_order !== "BigEndian",
    headerType: root.attrs.header_type === "UInt64" ? "UInt64" : "UInt32",
    compressed: !!root.attrs.compressor,
    appended,
  };
}

// ---- find helpers ---------------------------------------------------------------------

/** All descendants (depth-first, document order) with the given tag. */
export function findAll(el: XmlEl, tag: string): XmlEl[] {
  const out: XmlEl[] = [];
  const walk = (e: XmlEl): void => {
    if (e.tag === tag) out.push(e);
    for (const c of e.children) walk(c);
  };
  for (const c of el.children) walk(c);
  if (el.tag === tag) out.unshift(el);
  return out;
}

export function findFirst(el: XmlEl, tag: string): XmlEl | undefined {
  return findAll(el, tag)[0];
}

// ---- Binary decoding helpers -------------------------------------------------------------

function headerSize(file: VtkXmlFile): number {
  return file.headerType === "UInt64" ? 8 : 4;
}

function readHeaderValues(
  buf: Buffer,
  offset: number,
  count: number,
  file: VtkXmlFile
): number[] | null {
  const size = headerSize(file);
  if (offset + count * size > buf.length) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.length);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const o = offset + i * size;
    out.push(
      size === 8
        ? Number(view.getBigUint64(o, file.littleEndian))
        : view.getUint32(o, file.littleEndian)
    );
  }
  return out;
}

/** Chars needed to base64-decode at least `bytes` bytes. */
function b64CharsFor(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/**
 * Decodes one array's payload starting at `startChar` of a base64 stream.
 * Handles both the uncompressed layout (header ‖ payload encoded together)
 * and the compressed layout (header block and compressed blocks encoded
 * SEPARATELY, per the VTK writers).
 */
function payloadFromBase64(
  str: string,
  startChar: number,
  file: VtkXmlFile,
  diagnostics: MdpaDiagnostic[]
): Buffer | null {
  const hsize = headerSize(file);

  if (!file.compressed) {
    const headBytes = Buffer.from(
      str.slice(startChar, startChar + b64CharsFor(hsize)),
      "base64"
    );
    const len = readHeaderValues(headBytes, 0, 1, file);
    if (!len) {
      diagnostics.push({ line: 0, message: "Truncated base64 data header." });
      return null;
    }
    const total = Buffer.from(
      str.slice(startChar, startChar + b64CharsFor(hsize + len[0])),
      "base64"
    );
    return total.subarray(hsize, hsize + len[0]);
  }

  // Compressed: [nBlocks, blockSize, lastPartial, size1..N] base64-encoded
  // separately from the concatenated compressed blocks.
  const probe = Buffer.from(
    str.slice(startChar, startChar + b64CharsFor(3 * hsize)),
    "base64"
  );
  const meta = readHeaderValues(probe, 0, 3, file);
  if (!meta) {
    diagnostics.push({ line: 0, message: "Truncated compressed data header." });
    return null;
  }
  const [nBlocks, blockSize, lastPartial] = meta;
  const headerChars = b64CharsFor((3 + nBlocks) * hsize);
  const header = Buffer.from(str.slice(startChar, startChar + headerChars), "base64");
  const sizes = readHeaderValues(header, 3 * hsize, nBlocks, file);
  if (!sizes) {
    diagnostics.push({ line: 0, message: "Truncated compressed block-size table." });
    return null;
  }
  const compTotal = sizes.reduce((a, b) => a + b, 0);
  const compData = Buffer.from(
    str.slice(startChar + headerChars, startChar + headerChars + b64CharsFor(compTotal)),
    "base64"
  );
  return inflateBlocks(compData, 0, sizes, blockSize, lastPartial, diagnostics);
}

/** Decodes one array's payload at a byte offset of the raw appended blob. */
function payloadFromRaw(
  blob: Buffer,
  offset: number,
  file: VtkXmlFile,
  diagnostics: MdpaDiagnostic[]
): Buffer | null {
  const hsize = headerSize(file);

  if (!file.compressed) {
    const len = readHeaderValues(blob, offset, 1, file);
    if (!len || offset + hsize + len[0] > blob.length) {
      diagnostics.push({ line: 0, message: "Truncated appended data payload." });
      return null;
    }
    return blob.subarray(offset + hsize, offset + hsize + len[0]);
  }

  const meta = readHeaderValues(blob, offset, 3, file);
  if (!meta) {
    diagnostics.push({ line: 0, message: "Truncated compressed appended header." });
    return null;
  }
  const [nBlocks, blockSize, lastPartial] = meta;
  const sizes = readHeaderValues(blob, offset + 3 * hsize, nBlocks, file);
  if (!sizes) {
    diagnostics.push({ line: 0, message: "Truncated compressed block-size table." });
    return null;
  }
  return inflateBlocks(
    blob,
    offset + (3 + nBlocks) * hsize,
    sizes,
    blockSize,
    lastPartial,
    diagnostics
  );
}

function inflateBlocks(
  data: Buffer,
  start: number,
  sizes: number[],
  blockSize: number,
  lastPartial: number,
  diagnostics: MdpaDiagnostic[]
): Buffer | null {
  const out: Buffer[] = [];
  let pos = start;
  for (let i = 0; i < sizes.length; i++) {
    if (pos + sizes[i] > data.length) {
      diagnostics.push({ line: 0, message: "Truncated compressed data block." });
      return null;
    }
    try {
      out.push(zlib.inflateSync(data.subarray(pos, pos + sizes[i])));
    } catch (err) {
      diagnostics.push({
        line: 0,
        message: `Failed to inflate compressed block ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
      });
      return null;
    }
    pos += sizes[i];
  }
  const result = Buffer.concat(out);
  const expected = (sizes.length - 1) * blockSize + (lastPartial || blockSize);
  if (result.length !== expected) {
    diagnostics.push({
      line: 0,
      message: `Decompressed size ${result.length} differs from expected ${expected}.`,
    });
  }
  return result;
}

/** Converts a raw payload buffer into Float64 values of the declared dtype. */
function valuesFromPayload(
  payload: Buffer,
  dtype: BinaryType,
  littleEndian: boolean,
  diagnostics: MdpaDiagnostic[]
): Float64Array {
  const count = Math.floor(payload.length / dtype.size);
  const view = new DataView(payload.buffer, payload.byteOffset, payload.length);
  const out = new Float64Array(count);
  let overflow = false;
  for (let i = 0; i < count; i++) {
    const v = dtype.read(view, i * dtype.size, littleEndian);
    if (dtype.is64 && !Number.isSafeInteger(v)) overflow = true;
    out[i] = v;
  }
  if (overflow) {
    diagnostics.push({
      line: 0,
      message: "64-bit integer values exceed 2^53; some values lost precision.",
    });
  }
  return out;
}

// ---- Public DataArray decoding --------------------------------------------------------------

/**
 * Decodes any `<DataArray>` element (ascii / binary / appended, compressed or
 * not) into a Float64Array.  Failures produce diagnostics and an empty array.
 */
export function decodeDataArray(
  el: XmlEl,
  file: VtkXmlFile,
  diagnostics: MdpaDiagnostic[]
): Float64Array {
  const typeName = el.attrs.type ?? "";
  const dtype = binaryType(typeName);
  if (!dtype) {
    diagnostics.push({
      line: 0,
      message: `Unknown DataArray type "${typeName}" (array "${el.attrs.Name ?? ""}").`,
    });
    return new Float64Array(0);
  }

  const format = (el.attrs.format ?? "ascii").toLowerCase();
  const name = el.attrs.Name ?? "";

  if (format === "ascii") {
    const text = file.head.subarray(el.textStart, el.textEnd).toString("latin1");
    const parts = text.split(/\s+/);
    const vals: number[] = [];
    for (const p of parts) {
      if (!p) continue;
      const v = Number(p);
      if (!isNaN(v)) vals.push(v);
    }
    return Float64Array.from(vals);
  }

  if (format === "binary") {
    const text = file.head
      .subarray(el.textStart, el.textEnd)
      .toString("latin1")
      .replace(/\s+/g, "");
    const payload = payloadFromBase64(text, 0, file, diagnostics);
    if (!payload) return new Float64Array(0);
    return valuesFromPayload(payload, dtype, file.littleEndian, diagnostics);
  }

  if (format === "appended") {
    if (!file.appended) {
      diagnostics.push({
        line: 0,
        message: `DataArray "${name}" references appended data, but the file has none.`,
      });
      return new Float64Array(0);
    }
    const offset = parseInt(el.attrs.offset ?? "0", 10) || 0;
    const payload =
      file.appended.encoding === "raw"
        ? payloadFromRaw(file.appended.buf, offset, file, diagnostics)
        : payloadFromBase64(
            file.appended.buf.toString("latin1").replace(/\s+$/g, ""),
            offset,
            file,
            diagnostics
          );
    if (!payload) return new Float64Array(0);
    return valuesFromPayload(payload, dtype, file.littleEndian, diagnostics);
  }

  diagnostics.push({
    line: 0,
    message: `Unknown DataArray format "${format}" (array "${name}").`,
  });
  return new Float64Array(0);
}
