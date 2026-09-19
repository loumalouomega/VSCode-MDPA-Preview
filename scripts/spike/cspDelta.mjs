// The candidate additions to the shipped CSP (see realCsp.mjs) needed for
// @kitware/vtk-wasm to boot. These are DATA, named and justified individually,
// so the findings doc can report exactly which ones were actually required
// (some may turn out unnecessary) rather than a hand-waved "loosen the CSP".
export const CSP_ADDITIONS = [
  {
    directive: "connect-src",
    value: "${cspSource}",
    why: "loadAsync() fetch()es the glue .mjs and the .wasm binary; default-src 'none' with no connect-src blocks both.",
    shippedToday: false,
  },
  {
    // MEASURED (G1, out/spike/results/g1-boot-test.json): 'wasm-unsafe-eval'
    // alone is NOT enough. WebAssembly.instantiate succeeds with it (the
    // .mjs glue loads, the module compiles), but session.vtk method calls
    // fail with "vtkStandaloneSession is not a constructor" and a genuine
    // CSP violation naming plain "eval" — because Emscripten's Embind layer
    // (bindings/wasm/js_bindings.cpp's generated glue) calls
    // craftInvokerFunction(), which does `new Function(...)` to JIT a fast
    // trampoline for EVERY bound C++ method, on every vtk.vtkXxx() call, not
    // once at startup. This is fundamental to how this build's Embind glue
    // works (Emscripten's -sDYNAMIC_EXECUTION=0 flag disables it, but the
    // published bundle was not built with that flag) — it is a real,
    // structural CSP cost, not a misconfiguration. 'unsafe-eval' subsumes
    // 'wasm-unsafe-eval' per the CSP3 spec, so only one is needed; both are
    // named here so the finding stays legible.
    directive: "script-src",
    value: "'unsafe-eval'",
    why: "Embind's craftInvokerFunction() uses new Function(...) to build a per-method JS trampoline for every bound C++ class method call — measured directly in vtkWebAssembly.mjs, not merely inferred from a CSP error. This is markedly broader than 'wasm-unsafe-eval' and is the actual blocker.",
    shippedToday: false,
  },
];

/**
 * Splices the additions into a directive-joined CSP string ("a; b; c"),
 * either appending a value to an existing directive or adding a new one.
 */
export function applyCspDelta(csp, cspSource) {
  const parts = csp.split(";").map((s) => s.trim()).filter(Boolean);
  const byDirective = new Map(parts.map((p) => {
    const [name, ...rest] = p.split(/\s+/);
    return [name, rest];
  }));
  for (const add of CSP_ADDITIONS) {
    const value = add.value.replace("${cspSource}", cspSource);
    const existing = byDirective.get(add.directive);
    if (existing) {
      if (!existing.includes(value)) existing.push(value);
    } else {
      byDirective.set(add.directive, [value]);
    }
  }
  return [...byDirective.entries()].map(([name, vals]) => [name, ...vals].join(" ")).join("; ");
}
