/**
 * Minimal ZIP archive writer/reader (pure — no vscode/DOM imports) built on
 * node:zlib, used by the problem-archive feature (src/parser/problemZip.ts).
 * Supports the plain ZIP subset every mainstream tool writes: stored (0) and
 * deflated (8) entries, UTF-8 names, CRC-32 verification. Encrypted archives,
 * unsupported compression methods and ZIP64 (files ≥ 4 GiB / ≥ 65535 entries)
 * are rejected with a descriptive error.
 */

import { deflateRawSync, inflateRawSync } from "node:zlib";

export interface ZipEntry {
  /** Forward-slash separated path inside the archive. */
  name: string;
  data: Uint8Array;
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
/** General-purpose flag bit 11: the name is UTF-8. */
const FLAG_UTF8 = 0x0800;
const FLAG_ENCRYPTED = 0x0001;
const ZIP64_MARKER_32 = 0xffffffff;
const ZIP64_MARKER_16 = 0xffff;

// ---- CRC-32 -----------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ---- Writer -------------------------------------------------------------------

/** MS-DOS date/time pair (2-second resolution; pre-1980 clamps to 1980). */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(d.getFullYear(), 1980);
  const time =
    (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * Builds a ZIP archive from the given entries (each deflated unless storing is
 * smaller). Throws when the archive would need ZIP64.
 */
export function createZip(entries: ZipEntry[], now: Date = new Date()): Buffer {
  if (entries.length >= ZIP64_MARKER_16) {
    throw new Error(`Too many zip entries (${entries.length}); ZIP64 is not supported.`);
  }
  const { time, date } = dosDateTime(now);
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    if (nameBytes.length >= ZIP64_MARKER_16) {
      throw new Error(`Zip entry name too long: ${entry.name.slice(0, 80)}…`);
    }
    const raw = Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.length);
    const deflated = deflateRawSync(raw);
    const method = deflated.length < raw.length ? 8 : 0;
    const payload = method === 8 ? deflated : raw;
    if (raw.length >= ZIP64_MARKER_32 || payload.length >= ZIP64_MARKER_32) {
      throw new Error(`Zip entry "${entry.name}" is too large; ZIP64 is not supported.`);
    }
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    // extra/comment/disk/attrs stay zero
    central.writeUInt32LE(offset, 42);

    localParts.push(local, nameBytes, payload);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + payload.length;
    if (offset >= ZIP64_MARKER_32) {
      throw new Error("Zip archive too large; ZIP64 is not supported.");
    }
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

// ---- Reader -------------------------------------------------------------------

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 22 - ZIP64_MARKER_16);
  for (let p = buf.length - 22; p >= min; p--) {
    if (buf.readUInt32LE(p) === EOCD_SIG) return p;
  }
  throw new Error("Not a zip archive (end-of-central-directory record not found).");
}

/**
 * Parses a ZIP archive into its entries (directory entries — names ending in
 * "/" — are returned with empty data). Throws on corruption, encryption,
 * unsupported compression or ZIP64.
 */
export function readZip(buf: Buffer): ZipEntry[] {
  if (buf.length < 22) throw new Error("Not a zip archive (file too small).");
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === ZIP64_MARKER_16 || cdOffset === ZIP64_MARKER_32) {
    throw new Error("ZIP64 archives are not supported.");
  }

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) {
      throw new Error("Corrupt zip: bad central-directory entry.");
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > buf.length) throw new Error("Corrupt zip: truncated entry name.");
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & FLAG_ENCRYPTED) {
      throw new Error(`Encrypted zip entries are not supported ("${name}").`);
    }
    if (
      compSize === ZIP64_MARKER_32 ||
      uncompSize === ZIP64_MARKER_32 ||
      localOffset === ZIP64_MARKER_32
    ) {
      throw new Error("ZIP64 archives are not supported.");
    }
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new Error(`Corrupt zip: bad local header for "${name}".`);
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compSize > buf.length) {
      throw new Error(`Corrupt zip: truncated data for "${name}".`);
    }
    const payload = buf.subarray(dataStart, dataStart + compSize);

    let data: Buffer;
    if (method === 0) data = Buffer.from(payload);
    else if (method === 8) data = inflateRawSync(payload);
    else throw new Error(`Unsupported zip compression method ${method} ("${name}").`);

    if (data.length !== uncompSize) {
      throw new Error(`Corrupt zip: size mismatch for "${name}".`);
    }
    if (crc32(data) !== crc) {
      throw new Error(`Corrupt zip: CRC mismatch for "${name}".`);
    }
    entries.push({ name, data });
  }
  return entries;
}
