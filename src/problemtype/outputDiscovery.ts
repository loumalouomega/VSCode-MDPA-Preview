/** Output-process adapters shared by app and MCP. Never scan arbitrary folders. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { meshCompanionNames } from '../parser/meshFileParser';
import { meshExtname } from '../parser/meshFormats';
export interface OutputDiscovery {
  results: string[]; companions: string[]; missing: string[]; findings: string[]; unsafe: string[];
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const inside = (root: string, file: string) => { const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
export function resultCompanions(file: string): string[] {
  const ext = meshExtname(file);
  const text = /\.(xdmf|xmf|pvd|pvtu|pvtp)$/i.test(file) ? fs.readFileSync(file, 'utf8') : undefined;
  return meshCompanionNames(path.basename(file), ext, text).map(name => path.resolve(path.dirname(file), name));
}
export function discoverOutputs(directory: string): OutputDiscovery {
  const root = path.resolve(directory);
  const out: OutputDiscovery = { results: [], companions: [], missing: [], findings: [], unsafe: [] };
  const safe = (file: string): boolean => {
    if (!inside(root, file)) { out.unsafe.push(file); return false; }
    let existing = file;
    while (!fs.existsSync(existing) && existing !== path.dirname(existing)) existing = path.dirname(existing);
    try { if (!inside(fs.realpathSync(root), fs.realpathSync(existing))) { out.unsafe.push(file); return false; } } catch { /* nonexistent destination */ }
    return true;
  };
  let parameters: Record<string, unknown>;
  try { parameters = JSON.parse(fs.readFileSync(path.join(root, 'ProjectParameters.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') parameters = {}; else { out.findings.push(`Output settings unavailable: ${String(error)}`); return out; } }
  if (!object(parameters)) { out.findings.push('Invalid output-process document.'); return out; }
  const specs: { folder: string; pattern: RegExp }[] = [];
  const destination = (value: unknown, fallback: string, extensions: string, isPrefix: boolean) => {
    const name = typeof value === 'string' ? value : fallback;
    if (!name || !path.isAbsolute(name) && name.split(/[\\/]/).includes('..')) { out.unsafe.push(name); return; }
    const prefix = isPrefix ? path.basename(name) : '';
    const folder = path.resolve(root, isPrefix ? path.dirname(name) : name);
    if (!safe(folder)) return;
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/<[^>]+>/g, '.*');
    specs.push({ folder, pattern: new RegExp(`^${escaped}.*\\.(?:${extensions})$`, 'i') });
  };
  if (parameters.output_processes === undefined) {
    destination('vtk_output', '', 'vtk|vtu|vtp|pvtu|pvtp|pvd', false);
    out.findings.push('Legacy case without output_processes: using vtk_output.');
  } else if (object(parameters.output_processes)) {
    for (const group of Object.values(parameters.output_processes)) for (const entry of Array.isArray(group) ? group : []) {
      if (!object(entry)) continue;
      const module = String(entry.python_module ?? 'unknown');
      const p = object(entry.Parameters) ? entry.Parameters : {};
      if (module === 'vtk_output_process') destination(p.save_output_files_in_folder === false ? '.' : p.output_path, 'vtk_output', 'vtk|vtu|vtp|pvtu|pvtp|pvd', false);
      else if (module === 'gid_output_process' || module === 'distributed_gid_output_process') destination(p.output_name, 'kratos', 'post\\.res|post\\.bin|post\\.msh', true);
      else if (['single_mesh_temporal_output_process', 'multiple_mesh_temporal_output_process', 'single_mesh_xdmf_output_process', 'single_mesh_primal_output_process'].includes(module) && /HDF5Application/.test(String(entry.kratos_module))) {
        const io = object(p.file_settings) ? p.file_settings : p;
        const name = io.file_name ?? p.output_name ?? p.model_part_name;
        if (typeof name !== 'string') { out.findings.push(`Unsupported output settings for ${module}: no file_name.`); continue; }
        destination(name.replace(/\.(h5|hdf5|xdmf|xmf)$/i, '').replace(/[-_]?<time>.*$/, ''), '', 'xdmf|xmf|h5|hdf5', true);
      } else out.findings.push(`Unsupported output process: ${module}.`);
    }
  } else out.findings.push('Invalid output_processes settings.');
  const candidates = new Set<string>();
  for (const spec of specs) {
    const walk = (dir: string) => {
      if (!safe(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (!safe(file)) continue;
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile() && spec.pattern.test(entry.name)) candidates.add(file);
      }
    };
    try { walk(spec.folder); } catch { out.missing.push(spec.folder); }
  }
  for (const file of [...candidates].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
    // Raw Kratos HDF5 is a companion, not a mesh-mode entrypoint. XDMF indexes it.
    if (/\.(h5|hdf5)$/i.test(file) || /\.post\.msh$/i.test(file)) { out.companions.push(file); continue; }
    out.results.push(file);
    const ext = meshExtname(file);
    try {
      const text = /\.(xdmf|xmf|pvd|pvtu|pvtp)$/i.test(file) ? fs.readFileSync(file, 'utf8') : undefined;
      for (const name of meshCompanionNames(path.basename(file), ext, text)) {
        const companion = path.resolve(path.dirname(file), name);
        if (!safe(companion)) continue;
        if (fs.existsSync(companion)) out.companions.push(companion);
        else out.missing.push(companion);
      }
    } catch (error) { out.findings.push(`Could not inspect result companions: ${String(error)}`); }
  }
  // Prefer complete timeline indexes; otherwise select the latest filename step.
  out.results.sort((a, b) => Number(/\.(xdmf|xmf|pvd)$/i.test(b)) - Number(/\.(xdmf|xmf|pvd)$/i.test(a)) || b.localeCompare(a, 'en', { numeric: true }));
  out.companions = [...new Set(out.companions)];
  out.missing = [...new Set(out.missing)];
  if (!out.results.length) out.findings.push('No readable configured result entrypoint is available.');
  if (out.missing.length) out.findings.push('Configured output or result companions are missing.');
  if (out.unsafe.length) out.findings.push('Output paths outside the isolated run workspace are unsupported.');
  return out;
}
