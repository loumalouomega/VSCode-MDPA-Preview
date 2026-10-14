/**
 * Parameter-space sampling for the ROM problemtypes. Done HERE, at generate
 * time, rather than in the driver: the training and test points are written
 * explicitly into RomSamples.json, so a case is reproducible, reviewable and
 * needs no scipy, and the same seed always gives the same points.
 *
 * Pure module: no vscode / DOM / node imports.
 */

export type SamplingMethod = "lhs" | "halton" | "random" | "grid";

export interface ParameterRange {
  min: number;
  max: number;
  /** Points along this parameter for the full-grid method (>= 1). */
  gridPoints?: number;
}

/** mulberry32: a small, well-mixed 32-bit PRNG; deterministic for a seed. */
export function seededRandom(seed: number): () => number {
  let a = (Math.trunc(seed) >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71];

/** The radical inverse of `index` in `base` (the Halton / van der Corput digit reversal). */
export function radicalInverse(index: number, base: number): number {
  let result = 0;
  let f = 1 / base;
  let i = index;
  while (i > 0) {
    result += f * (i % base);
    i = Math.floor(i / base);
    f /= base;
  }
  return result;
}

const scale = (u: number, r: ParameterRange): number => r.min + u * (r.max - r.min);

/** Unit-cube samples, `count` rows of `dims` values in [0, 1). */
function unitSamples(method: Exclude<SamplingMethod, "grid">, count: number, dims: number, seed: number, offset: number): number[][] {
  if (method === "halton") {
    if (dims > PRIMES.length) throw new Error(`Halton sampling supports at most ${PRIMES.length} parameters.`);
    // Index 0 is the origin for every base; start at 1, and continue after the
    // training points for the test set, so the two never coincide.
    return Array.from({ length: count }, (_, i) => Array.from({ length: dims }, (_, d) => radicalInverse(i + 1 + offset, PRIMES[d])));
  }
  const rand = seededRandom(seed);
  if (method === "random") return Array.from({ length: count }, () => Array.from({ length: dims }, () => rand()));
  // Latin hypercube: each parameter's range cut into `count` strata, one point
  // per stratum, strata shuffled independently per parameter.
  const columns = Array.from({ length: dims }, () => {
    const strata = Array.from({ length: count }, (_, i) => i);
    for (let i = count - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [strata[i], strata[j]] = [strata[j], strata[i]];
    }
    return strata.map((s) => (s + rand()) / count);
  });
  return Array.from({ length: count }, (_, i) => columns.map((c) => c[i]));
}

/** Evenly spaced points including both ends; one point is the midpoint. */
export function linspace(r: ParameterRange, n: number): number[] {
  if (n <= 1) return [(r.min + r.max) / 2];
  return Array.from({ length: n }, (_, i) => r.min + ((r.max - r.min) * i) / (n - 1));
}

/** The full tensor-product grid of every parameter's points. */
export function gridSamples(ranges: readonly ParameterRange[]): number[][] {
  let rows: number[][] = [[]];
  for (const r of ranges) {
    const points = linspace(r, Math.max(1, Math.trunc(r.gridPoints ?? 2)));
    rows = rows.flatMap((row) => points.map((p) => [...row, p]));
  }
  return ranges.length === 0 ? [] : rows;
}

export interface SampleSets {
  train: number[][];
  test: number[][];
}

/**
 * Training and test points. The grid method uses the grid for training and
 * `testCount` Latin-hypercube points for testing (a grid point would only
 * re-test a training sample).
 */
export function sampleParameters(
  ranges: readonly ParameterRange[],
  method: SamplingMethod,
  trainCount: number,
  testCount: number,
  seed: number
): SampleSets {
  const dims = ranges.length;
  if (dims === 0) return { train: [], test: [] };
  const toRanges = (rows: number[][]): number[][] => rows.map((row) => row.map((u, d) => scale(u, ranges[d])));
  const train = method === "grid"
    ? gridSamples(ranges)
    : toRanges(unitSamples(method, Math.max(0, Math.trunc(trainCount)), dims, seed, 0));
  const testMethod = method === "grid" ? "lhs" : method;
  const test = toRanges(unitSamples(testMethod, Math.max(0, Math.trunc(testCount)), dims, seed + 7919, method === "halton" ? Math.trunc(trainCount) : 0));
  return { train, test };
}
