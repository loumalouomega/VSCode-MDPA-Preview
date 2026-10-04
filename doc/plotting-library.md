# Scientific plotting library decision

## Decision

Use the exact `plotly.js-cartesian-dist-min@4.1.1` distribution as the workspace renderer. Numerical extraction, statistics, transforms, alignment, gridding and exports remain under `src/parser/plot/`, shared with MCP. Plotly receives finished datasets, including histogram counts and box quartiles. It does not define the numerical backend.

| Candidate | Required families | CSP/offline considerations | Decision |
| --- | --- | --- | --- |
| Plotly Cartesian | Direct support for Cartesian line/scatter, bars, boxes, heatmaps and contours; host supplies histogram bins/box statistics | Local prebuilt distribution, no CDN; tested with nonce scripts and no `unsafe-eval`. MIT license copied beside the asset. | Selected for this increment. |
| Apache ECharts | Strong line/scatter/bar/box/heatmap coverage; contour plots need a separate adapter/custom series | Offline bundling and accessibility features are available; SVG/Canvas renderers offer export choices. The custom contour and its masking/export/accessibility rules would be extension-owned. | Not selected; greater contour-adapter scope. |
| Vega / Vega-Lite | Declarative scientific plotting, but contours/interpolation need additional dataflow decisions | Strict-CSP deployments require the expression interpreter rather than the default expression code-generation path; would introduce another transformation grammar beside the shared host core. | Not selected for this graphical builder. |

References: [Plotly partial-bundle trace coverage](https://github.com/plotly/plotly.js/blob/master/dist/README.md), [Plotly static image export](https://plotly.com/javascript/static-image-export/), [ECharts accessibility](https://echarts.apache.org/handbook/en/best-practices/aria/), [Vega expression interpreter](https://github.com/vega/vega/tree/main/packages/vega-interpreter). The comparison is architectural; it is not a head-to-head benchmark of all three libraries.

## Packaging and CSP

`esbuild.js` copies the Cartesian bundle and its MIT license into `media/plotly/`, and builds `media/plots.js` plus `dist/plotWorker.js`. The plotting library is not imported by the host, the mesh webview or the numerical core. The application script and library are nonce-authorized. There is no `unsafe-eval`, external script source or network dependency. Plotly inserts styles dynamically, so the workspace retains `style-src 'unsafe-inline'`; PNG generation uses `img-src blob:` as well as `data:`. That is an image-export allowance, not a script-CSP relaxation.

The shipped minified plotting asset is **1,500,041 bytes**. The packaged extension measured **29.86 MB** in this environment; that figure includes all existing renderer/WASM assets, not just plotting. Attribution is shipped as `media/plotly/LICENSE`. The graph's theme colors use VS Code tokens. A native-control configuration, visible focus, keyboard zoom buttons and an accessible sample table provide alternatives to pointer-only chart gestures; Plotly itself is not presented as fully keyboard-accessible.

## Measured verification

- `src/test/plot.test.ts` exercises parsing/correction, missing/nonfinite cells, duplicate headers, associations/independent IDs, supplied units/scales, statistics, magnitude/filter/groups, histogram/box/bar calculations, calculus/smoothing/regression, reference alignment, masked gridding, log-domain diagnostics, recipes, display sampling, worker cancellation/recovery, cache invalidation and MCP/full-resolution exports.
- `scripts/screenshots/check-plot-builder.mjs` drives the actual plotting bundle under the production HTML CSP, with only host delivery simulated. All seven families rendered; **14 graphics** (PNG and SVG per family) exported with no page errors or CSP violations. Artifacts are under `/tmp/opencode/plot-check` when run locally. This checks format validity and rendered families, not pixel-perfect equivalence against every chart option.
- The same browser regression processed **100,000 rows**: numerical evaluation plus display selection took about **144–199 ms** across two recorded runs, and a complete UI recipe reload/preview/render round trip about **7.0–8.2 s**, delivering **2,310 display points**. These are Linux/Chromium 1243 smoke measurements under different concurrent test loads, not statistically controlled benchmarks or million-row/Remote-SSH budgets. The round-trip includes transferring the inline recipe and import preview; it is not an isolated Plotly render benchmark.
- `scripts/screenshots/check-plots-vsix.mjs` uses an isolated authenticated code-server 4.140.0 profile, the installed VSIX and real provider/worker messages. Standalone CSV overlays, MDPA/VTK Advanced-menu entry points, dark/light/high-contrast themes and the absence of dirty mesh tabs passed. Guide screenshots were captured there. It does not substitute for the still-open cross-run/timeline ownership and packaged save-dialog/export matrix.
- The repository's **2,036-test suite passed serially**. Two earlier parallel runs were interrupted by server restarts; the serial run completed. Subsequent focused plotting/field-series/manifest tests passed after boundary refinements.

Reproduce with `npm run typecheck`, `npm run build:tests`, `node --test --test-concurrency=1 out/test/`, and the two browser scripts (see their headers for `PLAYWRIGHT_MODULE`, `CHROMIUM_PATH`, `UI_ROOT` and `CODE_SERVER`). Package with `node node_modules/@vscode/vsce/vsce package --no-dependencies -o /tmp/opencode/plots.vsix`, then install into the isolated profile used by the packaged check. Playwright and code-server remain external test tooling, not extension dependencies.

## Kernel baseline hold

This task intentionally retains the audited **meshio++ 16.27.0** lockfile baseline. A newer published kernel (16.30.0 during initial planning) does not justify bypassing the roadmap's Tier 0 registry/options/reader/writer/transient audit. Upgrade and audit that kernel separately; none of the plotting delivery claims depends on its untested new behavior.

## Remaining acceptance scope

Roadmap item 14 remains open. Run discovery/ownership-aware navigation, additional analysis-table entry points, progressive history publication, companion-aware caches, larger-scale/remote budgets and a broader packaged save/export/recipe/stale/cancellation matrix are not closed by the current measurements. The guide states these boundaries rather than implying that chart-library adoption completes the whole task.
