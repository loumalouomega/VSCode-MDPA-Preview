/** Comment/header provenance for native text formats. Never modifies mesh data. */
import type { ProvenanceRequest } from "../meshio";

export function nativeProvenance(text: string, ext: string, request?: ProvenanceRequest): {
  data: string; provenance?: { embedded: boolean; lines: string[]; truncated?: boolean };
} {
  if (!request) return { data: text };
  const payload = `Kratos provenance: ${JSON.stringify(request)}`;
  let line: string;
  let data: string;
  let truncated = false;
  switch (ext.toLowerCase()) {
    case ".mdpa":
    case ".obj":
      line = `${ext.toLowerCase() === ".mdpa" ? "//" : "#"} ${payload}`;
      data = line + "\n" + text;
      break;
    case ".vtu":
    case ".vtp":
    case ".vtm":
    case ".pvd":
      // XML comments forbid '--', even inside JSON string values.
      line = `<!-- ${payload.replace(/-/g, "\\u002d")} -->`;
      data = text.replace(/^(<\?xml[^\n]*\n)/, (_match, header: string) => header + line + "\n");
      if (data === text) data = line + "\n" + text;
      break;
    case ".vtk": {
      // Legacy VTK's title has a 256-character limit. The sidecar carries the
      // complete request when a long source/operation chain exceeds this slot.
      const ascii = payload.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
      line = ascii.slice(0, 255);
      truncated = ascii.length > 255;
      data = text.replace(/^(#[^\n]*\n)[^\n]*/, (_match, header: string) => header + line);
      break;
    }
    case ".ply":
      line = `comment ${payload}`;
      data = text.replace(/^(ply\r?\nformat[^\n]*\n)/, (_match, header: string) => header + line + "\n");
      break;
    default:
      return { data: text, provenance: { embedded: false, lines: [] } };
  }
  return { data, provenance: { embedded: true, lines: [line], ...(truncated ? { truncated } : {}) } };
}
