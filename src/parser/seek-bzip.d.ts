declare module "seek-bzip" {
  export function decode(input: Uint8Array, output?: Uint8Array, multistream?: boolean): Uint8Array;
}
