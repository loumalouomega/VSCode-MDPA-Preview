/**
 * Groups Kratos VTK output files (one per model-part per time step) into a
 * VtkFileGroup that describes the timeline and submodelpart tree.
 *
 * Kratos naming convention (from GetOutputFileName):
 *   <model_part_path>_<mpi_rank>_<step_label>.vtk
 *
 * The model_part_path uses underscores as path separators
 * (e.g. "Main_FixedEdgeNodes" for subpart "FixedEdgeNodes" of "Main").
 * This is ambiguous with underscores in part names, so we resolve the tree by
 * detecting which prefixes are themselves prefixes of other prefixes.
 */

// ---- Types -------------------------------------------------------------------

export interface VtkFileGroup {
  /** File extension of every file in the group (lowercase, e.g. ".vtu"). */
  ext: string;
  /** Root model-part prefix, e.g. "Main". */
  rootPrefix: string;
  /** Human-readable name (same as rootPrefix). */
  modelPartName: string;
  /** Sorted step labels (numeric order), e.g. ["2","4","6"]. */
  steps: string[];
  /** MPI ranks present (usually [0] for serial). */
  ranks: number[];
  /**
   * Subpart suffixes relative to root, e.g. ["FixedEdgeNodes","MovingNodes"].
   * Only direct children; grandchildren appear with their full relative path
   * (e.g. "Child_Grandchild").
   */
  subParts: string[];
  /**
   * Map from "${prefix}|${rank}|${step}" → filename in the directory.
   * Use `fileFor()` for safe access.
   */
  fileMap: Map<string, string>;
}

interface ParsedFilename {
  filename: string;
  prefix: string;
  rank: number;
  step: string;
  stepNum: number;
}

// ---- Regex -------------------------------------------------------------------

// Matches the trailing _<rank>_<step> suffix (rank is non-negative int,
// step is an integer or decimal, optionally with an exponent).
// Anchored to end of string (before .vtk is stripped).
const SUFFIX_RE = /_(\d+)_([\d]+(?:[.]\d+)?(?:[eE][+-]?\d+)?)$/;

// ---- Core grouping -----------------------------------------------------------

/** Matches `filename` against `extensions` (case-insensitive); lowercase ext or undefined. */
function matchExtension(
  filename: string,
  extensions: readonly string[]
): string | undefined {
  const lower = filename.toLowerCase();
  for (const ext of extensions) {
    if (lower.endsWith(ext)) return ext;
  }
  return undefined;
}

/** Parses `<prefix>_<rank>_<step><ext>` → record, or undefined if no match. */
function parseFilename(
  filename: string,
  ext: string
): ParsedFilename | undefined {
  const base = filename.slice(0, -ext.length);
  const m = base.match(SUFFIX_RE);
  if (!m) return undefined;
  const rank = parseInt(m[1], 10);
  const step = m[2];
  const prefix = base.slice(0, base.length - m[0].length);
  if (!prefix) return undefined;
  return { filename, prefix, rank, step, stepNum: parseFloat(step) };
}

/**
 * Given a list of filenames (basenames), returns all discovered VtkFileGroups.
 * Filenames are bucketed by extension first (so e.g. a `.vtk` and a `.vtu`
 * series with the same prefix never cross-group), then the Kratos naming
 * pattern is resolved per bucket.  Non-matching filenames are ignored.
 */
export function groupVtkFiles(
  filenames: string[],
  extensions: readonly string[] = [".vtk"]
): VtkFileGroup[] {
  // Bucket filenames by matched extension
  const buckets = new Map<string, ParsedFilename[]>();
  for (const filename of filenames) {
    const ext = matchExtension(filename, extensions);
    if (!ext) continue;
    const rec = parseFilename(filename, ext);
    if (!rec) continue;
    let bucket = buckets.get(ext);
    if (!bucket) {
      bucket = [];
      buckets.set(ext, bucket);
    }
    bucket.push(rec);
  }

  const groups: VtkFileGroup[] = [];
  for (const [ext, records] of buckets) {
    groups.push(...groupBucket(records, ext));
  }
  return groups;
}

/** Runs the prefix/step grouping algorithm on records sharing one extension. */
function groupBucket(records: ParsedFilename[], ext: string): VtkFileGroup[] {
  if (records.length === 0) return [];

  // Step 2: collect distinct prefixes
  const prefixSet = new Set(records.map((r) => r.prefix));
  const sortedPrefixes = [...prefixSet].sort((a, b) => a.length - b.length);

  // Step 3: build parent map — B is a child of A if B starts with A + "_"
  //   and A is the longest such prefix (nearest ancestor).
  const parentOf = new Map<string, string | null>();
  for (const p of sortedPrefixes) {
    let parent: string | null = null;
    // Check candidates from longest to shortest to find nearest ancestor
    for (let i = sortedPrefixes.length - 1; i >= 0; i--) {
      const c = sortedPrefixes[i];
      if (c !== p && p.startsWith(c + "_")) {
        parent = c;
        break;
      }
    }
    parentOf.set(p, parent);
  }

  // Step 4: collect roots (no parent)
  const roots = sortedPrefixes.filter((p) => parentOf.get(p) === null);

  // Step 5: build a VtkFileGroup per root
  const groups: VtkFileGroup[] = [];

  for (const root of roots) {
    // Collect all descendants of this root
    const descendants = sortedPrefixes.filter((p) => {
      if (p === root) return false;
      let cur: string | null = p;
      while (cur !== null) {
        cur = parentOf.get(cur) ?? null;
        if (cur === root) return true;
      }
      return false;
    });

    // Steps and ranks are taken from root prefix records
    const rootRecords = records.filter((r) => r.prefix === root);
    const stepSet = new Set(rootRecords.map((r) => r.step));
    const steps = [...stepSet].sort((a, b) => parseFloat(a) - parseFloat(b));
    const rankSet = new Set(rootRecords.map((r) => r.rank));
    const ranks = [...rankSet].sort((a, b) => a - b);

    // subParts are the suffix after "root_"
    const subParts = descendants.map((p) => p.slice(root.length + 1));

    // Build the file map
    const fileMap = new Map<string, string>();
    for (const r of records) {
      // Only include records whose prefix is root or a descendant of root
      const isRelated =
        r.prefix === root ||
        descendants.includes(r.prefix);
      if (isRelated) {
        fileMap.set(`${r.prefix}|${r.rank}|${r.step}`, r.filename);
      }
    }

    groups.push({
      ext,
      rootPrefix: root,
      modelPartName: root,
      steps,
      ranks,
      subParts,
      fileMap,
    });
  }

  return groups;
}

/**
 * Look up the filename for a given prefix, rank, and step label within a group.
 * Returns undefined if the combination is not in the group.
 */
export function fileFor(
  group: VtkFileGroup,
  prefix: string,
  rank: number,
  step: string
): string | undefined {
  return group.fileMap.get(`${prefix}|${rank}|${step}`);
}

/**
 * Find the VtkFileGroup that contains the given filename (basename).
 * Returns the matching group and the step/rank of that file, or undefined.
 */
export function findGroupForFile(
  groups: VtkFileGroup[],
  filename: string
): { group: VtkFileGroup; rank: number; step: string } | undefined {
  const ext = matchExtension(filename, [...new Set(groups.map((g) => g.ext))]);
  if (!ext) return undefined;
  const rec = parseFilename(filename, ext);
  if (!rec) return undefined;
  for (const group of groups) {
    if (group.ext !== ext) continue;
    if (
      group.rootPrefix === rec.prefix ||
      group.subParts.some((s) => `${group.rootPrefix}_${s}` === rec.prefix)
    ) {
      return { group, rank: rec.rank, step: rec.step };
    }
  }
  return undefined;
}
