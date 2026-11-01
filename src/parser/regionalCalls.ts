/**
 * The syntax of regional scalar calls (`avg(PART, F)`, `int`, `max`, `min`) with no
 * imports, so the webview can validate a formula without bundling the region
 * numerics (roadmap item 34). `regionalScalars.ts` does the evaluation.
 */
export const REGIONAL_CALL = /\b(avg|int|max|min)\s*\(\s*([A-Za-z_][A-Za-z0-9_./]*)\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/gi;

/** True when the text contains something that looks like a regional call. */
export function hasRegionalCall(expr: string): boolean {
  REGIONAL_CALL.lastIndex = 0;
  return REGIONAL_CALL.test(expr);
}

/**
 * Replaces every regional call by `(0)` so the rest of the formula can be
 * syntax-checked where the model's parts and fields are not available. The host
 * is the authority on whether the part and field exist.
 */
export function maskRegionalCalls(expr: string): string {
  return expr.replace(REGIONAL_CALL, "(0)");
}
