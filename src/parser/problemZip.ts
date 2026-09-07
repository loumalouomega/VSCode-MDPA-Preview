/**
 * Pure (no vscode/DOM) core of the File-menu "Save problem" / "Load problem"
 * feature: a problem archive is a plain zip bundling the mesh file, the edit
 * recipe (ops JSON), the saved case state and the generated problemtype files,
 * indexed by a `kratosproblem.json` manifest. The vscode-facing dialogs and
 * file I/O live in src/problemArchive.ts.
 */

import { createZip, readZip, ZipEntry } from "./zip";
import { SUPPORTED_MESH_EXTENSIONS } from "./meshFormats";

export const PROBLEM_MANIFEST_NAME = "kratosproblem.json";

/** The archive index written as kratosproblem.json (all names are zip entries). */
export interface ProblemManifest {
  format: "kratos-problem";
  version: 1;
  /** The mesh file the preview opens (.mdpa or any supported mesh format). */
  mesh: string;
  /** Operation recipe replayed on the mesh after loading. */
  ops?: string;
  /** The `<stem>.kratoscase.json` problemtype case state. */
  case?: string;
  /** Generated case files (ProjectParameters.json, materials, MainKratos.py, …). */
  generated: string[];
}

export interface ParsedProblemZip {
  manifest?: ProblemManifest;
  /** Resolved mesh entry name (manifest first, else detected by extension). */
  mesh?: string;
  /** Resolved ops-recipe entry name (manifest first, else `<stem>.ops.json`). */
  ops?: string;
  entries: ZipEntry[];
  warnings: string[];
}

/** Builds the archive: the manifest entry followed by the given files. */
export function buildProblemZip(
  manifest: Omit<ProblemManifest, "format" | "version">,
  files: ZipEntry[]
): Buffer {
  const full: ProblemManifest = { format: "kratos-problem", version: 1, ...manifest };
  const manifestEntry: ZipEntry = {
    name: PROBLEM_MANIFEST_NAME,
    data: Buffer.from(JSON.stringify(full, null, 2) + "\n", "utf8"),
  };
  return createZip([manifestEntry, ...files]);
}

/**
 * Extensions too generic to guess a mesh from. They are readable formats
 * (DOLFIN XML, Tecplot), but an archive's stray config.xml or data.dat is far
 * likelier than a mesh in one of them — and this is only the fallback for a
 * missing/broken manifest, which names the mesh explicitly.
 *
 * `.foam` is here for a different reason: it is a 0-BYTE MARKER whose mesh is
 * really `constant/polyMesh/`, so picking it would name an empty file as the
 * archive's mesh. See `collectProblemFiles`, which refuses to pack one.
 */
const AMBIGUOUS_MESH_EXTENSIONS: readonly string[] = [".xml", ".dat", ".foam"];

/** Picks the mesh entry when the manifest is absent/broken: .mdpa first. */
export function detectMeshEntry(names: string[]): string | undefined {
  const ext = (n: string) => {
    const i = n.lastIndexOf(".");
    return i < 0 ? "" : n.slice(i).toLowerCase();
  };
  return (
    names.find((n) => ext(n) === ".mdpa") ??
    names.find(
      (n) =>
        SUPPORTED_MESH_EXTENSIONS.includes(ext(n)) &&
        !AMBIGUOUS_MESH_EXTENSIONS.includes(ext(n))
    )
  );
}

/**
 * True for entry names that are safe to extract: relative, forward-slash
 * separated, no `..`/`.` segments (zip-slip guard, same policy as the .vtm
 * child-path check).
 */
export function isSafeEntryName(name: string): boolean {
  if (!name || name.startsWith("/") || name.includes("\\")) return false;
  if (/^[a-zA-Z]:/.test(name)) return false;
  const segments = name.split("/");
  return segments.every(
    (s, i) => (s !== "" || i === segments.length - 1) && s !== ".." && s !== "."
  );
}

/**
 * Every `materials_filename` string found anywhere in a ProjectParameters.json
 * document (deep search — custom problemtypes may shape solver_settings
 * differently). Returns [] for unparsable input.
 */
export function materialsFileNamesFrom(projectParametersText: string): string[] {
  let doc: unknown;
  try {
    doc = JSON.parse(projectParametersText);
  } catch {
    return [];
  }
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const v of value) walk(v);
    } else if (value && typeof value === "object") {
      for (const [key, v] of Object.entries(value)) {
        if (key === "materials_filename" && typeof v === "string" && v.length > 0) {
          if (!found.includes(v)) found.push(v);
        } else {
          walk(v);
        }
      }
    }
  };
  walk(doc);
  return found;
}

/**
 * Reads a problem archive, tolerating a missing/malformed manifest (degrades
 * to extension-based mesh detection with a warning, recipe-parser style).
 * Zip-level corruption still throws.
 */
export function parseProblemZip(buf: Buffer): ParsedProblemZip {
  const entries = readZip(buf);
  const warnings: string[] = [];
  const names = entries.filter((e) => !e.name.endsWith("/")).map((e) => e.name);

  let manifest: ProblemManifest | undefined;
  const manifestEntry = entries.find((e) => e.name === PROBLEM_MANIFEST_NAME);
  if (manifestEntry) {
    try {
      const parsed = JSON.parse(Buffer.from(manifestEntry.data).toString("utf8"));
      if (
        parsed &&
        typeof parsed === "object" &&
        parsed.format === "kratos-problem" &&
        typeof parsed.mesh === "string"
      ) {
        manifest = {
          format: "kratos-problem",
          version: 1,
          mesh: parsed.mesh,
          ops: typeof parsed.ops === "string" ? parsed.ops : undefined,
          case: typeof parsed.case === "string" ? parsed.case : undefined,
          generated: Array.isArray(parsed.generated)
            ? parsed.generated.filter((g: unknown) => typeof g === "string")
            : [],
        };
      } else {
        warnings.push(`${PROBLEM_MANIFEST_NAME} is not a kratos-problem manifest; ignoring it.`);
      }
    } catch {
      warnings.push(`${PROBLEM_MANIFEST_NAME} is malformed JSON; ignoring it.`);
    }
  }

  let mesh = manifest?.mesh;
  if (mesh && !names.includes(mesh)) {
    warnings.push(`Manifest mesh "${mesh}" is missing from the archive.`);
    mesh = undefined;
  }
  if (!mesh) {
    mesh = detectMeshEntry(names);
    if (manifest && mesh) warnings.push(`Using "${mesh}" as the mesh instead.`);
  }

  let ops = manifest?.ops;
  if (ops && !names.includes(ops)) {
    warnings.push(`Manifest ops recipe "${ops}" is missing from the archive.`);
    ops = undefined;
  }
  if (!ops && mesh) {
    const dot = mesh.lastIndexOf(".");
    const conventional = `${dot < 0 ? mesh : mesh.slice(0, dot)}.ops.json`;
    if (names.includes(conventional)) ops = conventional;
  }

  return { manifest, mesh, ops, entries, warnings };
}
