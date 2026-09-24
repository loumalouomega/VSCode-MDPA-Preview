import { JsonValue, ProblemtypeRuntime } from './types';

/** Kratos Parameters distinguishes 1000 from 1000.0. Preserve declared real
 * material variables, including vector components, without changing integer IDs. */
export function materialJson(value: JsonValue, runtime: ProblemtypeRuntime): string {
  const realVariables = new Set(runtime.decl.materialLaws.flatMap(law =>
    law.variables.filter(field => field.type === 'number' || field.type === 'vector3').map(field => field.id)));
  function encode(item: JsonValue, depth: number, real = false, variables = false): string {
    if (typeof item === 'number') {
      return real && Number.isFinite(item) && Number.isInteger(item) && !String(item).includes('e')
        ? `${item}.0` : JSON.stringify(item);
    }
    if (item === null || typeof item !== 'object') return JSON.stringify(item);
    const indent = '    '.repeat(depth + 1), end = '    '.repeat(depth);
    if (Array.isArray(item)) return item.length
      ? `[\n${item.map(v => indent + encode(v, depth + 1, real)).join(',\n')}\n${end}]` : '[]';
    const entries = Object.entries(item);
    return entries.length ? `{\n${entries.map(([key, val]) =>
      `${indent}${JSON.stringify(key)}: ${encode(val, depth + 1, variables && realVariables.has(key), key === 'Variables')}`
    ).join(',\n')}\n${end}}` : '{}';
  }
  return encode(value, 0) + '\n';
}
