/**
 * A reader for NumPy `.npy` files — the format RomApplication writes its basis,
 * singular values and HROM element ids/weights in. Pure (bytes in, numbers
 * out), so the extension, MCP and tests share it without numpy.
 *
 * Supported: format versions 1.0–3.0, C order, little-endian or byte-order-free
 * float64/float32 and (u)int8/16/32/64 dtypes (`<f8`, `<f4`, `<i8`, `|u1`, …).
 * Anything else (Fortran order, big-endian, object or structured dtypes) is
 * refused by name rather than misread. 64-bit integers are returned as plain
 * numbers; values beyond 2^53 lose precision, which is stated rather than hidden.
 */

export interface NpyArray {
  shape: number[];
  dtype: string;
  data: number[];
}

const MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]; // \x93NUMPY

function headerField(header: string, key: string): string | undefined {
  const m = new RegExp(`['"]${key}['"]\\s*:\\s*`).exec(header);
  if (!m) return undefined;
  const rest = header.slice(m.index + m[0].length);
  if (rest.startsWith("(")) return rest.slice(0, rest.indexOf(")") + 1);
  const end = rest.search(/[,}]/);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

export function parseNpy(bytes: Uint8Array): NpyArray {
  if (bytes.length < 10 || !MAGIC.every((b, i) => bytes[i] === b)) throw new Error("Not a .npy file (missing the \\x93NUMPY magic).");
  const major = bytes[6];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let headerLength: number;
  let offset: number;
  if (major === 1) {
    headerLength = view.getUint16(8, true);
    offset = 10;
  } else if (major === 2 || major === 3) {
    headerLength = view.getUint32(8, true);
    offset = 12;
  } else {
    throw new Error(`Unsupported .npy format version ${major}.`);
  }
  const header = new TextDecoder(major === 3 ? "utf-8" : "latin1").decode(bytes.subarray(offset, offset + headerLength));
  const descr = (headerField(header, "descr") ?? "").replace(/['"]/g, "");
  const fortran = headerField(header, "fortran_order");
  const shapeText = headerField(header, "shape") ?? "()";
  if (fortran === "True") throw new Error("Fortran-ordered .npy arrays are not supported.");
  const shape = shapeText.replace(/[()\s]/g, "").split(",").filter((s) => s.length > 0).map(Number);
  if (shape.some((n) => !Number.isInteger(n) || n < 0)) throw new Error(`Malformed .npy shape "${shapeText}".`);
  const count = shape.reduce((a, b) => a * b, 1);
  const m = /^([<|=])([fiu])(\d)$/.exec(descr);
  if (!m) throw new Error(`Unsupported .npy dtype "${descr}" (little-endian numeric only).`);
  const [, , kind, sizeText] = m;
  const size = Number(sizeText);
  const start = offset + headerLength;
  if (start + count * size > bytes.length) throw new Error("The .npy file is shorter than its header says.");
  const data = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    const at = start + i * size;
    if (kind === "f") data[i] = size === 8 ? view.getFloat64(at, true) : size === 4 ? view.getFloat32(at, true) : NaN;
    else if (size === 8) data[i] = Number(kind === "i" ? view.getBigInt64(at, true) : view.getBigUint64(at, true));
    else if (size === 4) data[i] = kind === "i" ? view.getInt32(at, true) : view.getUint32(at, true);
    else if (size === 2) data[i] = kind === "i" ? view.getInt16(at, true) : view.getUint16(at, true);
    else if (size === 1) data[i] = kind === "i" ? view.getInt8(at) : view.getUint8(at);
    else throw new Error(`Unsupported .npy item size ${size}.`);
  }
  if (kind === "f" && size !== 8 && size !== 4) throw new Error(`Unsupported .npy float size ${size}.`);
  return { shape, dtype: descr, data };
}

/** Writes a 1-D or 2-D little-endian float64/int64 .npy (tests and fixtures). */
export function encodeNpy(data: number[], dtype: "<f8" | "<i8" = "<f8", shape: number[] = [data.length]): Uint8Array {
  const shapeText = shape.length === 1 ? `(${shape[0]},)` : `(${shape.join(", ")})`;
  let header = `{'descr': '${dtype}', 'fortran_order': False, 'shape': ${shapeText}, }`;
  const pad = 64 - ((10 + header.length + 1) % 64);
  header += " ".repeat(pad % 64) + "\n";
  const out = new Uint8Array(10 + header.length + data.length * 8);
  out.set(MAGIC, 0);
  out[6] = 1;
  out[7] = 0;
  const view = new DataView(out.buffer);
  view.setUint16(8, header.length, true);
  for (let i = 0; i < header.length; i++) out[10 + i] = header.charCodeAt(i);
  const start = 10 + header.length;
  data.forEach((v, i) => {
    if (dtype === "<f8") view.setFloat64(start + i * 8, v, true);
    else view.setBigInt64(start + i * 8, BigInt(Math.trunc(v)), true);
  });
  return out;
}
