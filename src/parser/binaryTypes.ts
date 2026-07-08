/**
 * Binary scalar-type table shared by the PLY parser, the VTK XML DataArray
 * decoder, and the binary legacy VTK reader.  Pure module.
 *
 * Names are matched case-insensitively, covering both the PLY spellings
 * (char/uchar/short/.../double) and the VTK spellings (Int8/UInt8/.../Float64).
 */

export interface BinaryType {
  /** Byte size of one value. */
  size: number;
  /** True for 64-bit integer types (values beyond 2^53 lose precision). */
  is64: boolean;
  read(view: DataView, offset: number, littleEndian: boolean): number;
}

const TYPES: Record<string, BinaryType> = {
  int8: { size: 1, is64: false, read: (v, o) => v.getInt8(o) },
  uint8: { size: 1, is64: false, read: (v, o) => v.getUint8(o) },
  int16: { size: 2, is64: false, read: (v, o, le) => v.getInt16(o, le) },
  uint16: { size: 2, is64: false, read: (v, o, le) => v.getUint16(o, le) },
  int32: { size: 4, is64: false, read: (v, o, le) => v.getInt32(o, le) },
  uint32: { size: 4, is64: false, read: (v, o, le) => v.getUint32(o, le) },
  int64: { size: 8, is64: true, read: (v, o, le) => Number(v.getBigInt64(o, le)) },
  uint64: { size: 8, is64: true, read: (v, o, le) => Number(v.getBigUint64(o, le)) },
  float32: { size: 4, is64: false, read: (v, o, le) => v.getFloat32(o, le) },
  float64: { size: 8, is64: false, read: (v, o, le) => v.getFloat64(o, le) },
};

// PLY aliases
TYPES.char = TYPES.int8;
TYPES.uchar = TYPES.uint8;
TYPES.short = TYPES.int16;
TYPES.ushort = TYPES.uint16;
TYPES.int = TYPES.int32;
TYPES.uint = TYPES.uint32;
TYPES.float = TYPES.float32;
TYPES.double = TYPES.float64;

// Legacy VTK aliases ("long" is written as 32-bit by common VTK builds)
TYPES.unsigned_char = TYPES.uint8;
TYPES.unsigned_short = TYPES.uint16;
TYPES.unsigned_int = TYPES.uint32;
TYPES.long = TYPES.int32;
TYPES.unsigned_long = TYPES.uint32;
TYPES.vtkidtype = TYPES.int64;

/** Look up a binary scalar type by PLY or VTK name; undefined when unknown. */
export function binaryType(name: string): BinaryType | undefined {
  return TYPES[name.toLowerCase()];
}
