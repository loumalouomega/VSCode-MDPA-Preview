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

/**
 * Given a list of filenames (basenames, with .vtk extension), returns all
 * discovered VtkFileGroups.  Filenames that do not match the Kratos naming
 * pattern are silently ignored.
 */
export function groupVtkFiles(filenames: string[]): VtkFileGroup[] {
  // Step 1: parse filenames
  const records: ParsedFilename[] = [];
  for (const filename of filenames) {
    if (!filename.endsWith(".vtk")) continue;
    const base = filename.slice(0, -4); // strip .vtk
    const m = base.match(SUFFIX_RE);
    if (!m) continue;
    const rank = parseInt(m[1], 10);
    const step = m[2];
    const prefix = base.slice(0, base.length - m[0].length);
    if (!prefix) continue;
    records.push({ filename, prefix, rank, step, stepNum: parseFloat(step) });
  }

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
  if (!filename.endsWith(".vtk")) return undefined;
  const base = filename.slice(0, -4);
  const m = base.match(SUFFIX_RE);
  if (!m) return undefined;
  const rank = parseInt(m[1], 10);
  const step = m[2];
  const prefix = base.slice(0, base.length - m[0].length);
  for (const group of groups) {
    if (group.rootPrefix === prefix || group.subParts.some((s) => `${group.rootPrefix}_${s}` === prefix)) {
      return { group, rank, step };
    }
  }
  return undefined;
}
