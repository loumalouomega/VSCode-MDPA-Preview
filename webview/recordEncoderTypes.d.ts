declare module "*.worker-source" { const source: string; export default source; }
declare module "gifenc" {
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number): number[][];
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: number[][]): Uint8Array;
  export function GIFEncoder(options?: { auto?: boolean }): {
    reset(): void; writeHeader(): void; finish(): void; bytesView(): Uint8Array;
    writeFrame(indices: Uint8Array, width: number, height: number, options: { first?: boolean; palette?: number[][]; delay: number; repeat: number; dispose: number }): void;
  };
}
