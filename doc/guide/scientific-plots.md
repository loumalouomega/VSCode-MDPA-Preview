# Scientific plot builder

The **Scientific Plot Builder** is a read-only analysis workspace for mesh fields, time histories, line profiles and CSV/TSV data. It uses the same host-side extraction and numerical calculations as MCP, rather than sampling the rendered viewport. You do not need a plotting script. This is the first delivered increment of [roadmap item 14](../roadmap.md#_14-advanced-graphical-plotting-utilities-for-simulation-results-and-general-data-l); the remaining acceptance work is listed below.

![Two series from an imported table in the packaged extension, with a missing measurement shown as a gap](/screenshots/plot-builder.png)

*Captured from the packaged extension in code-server, not a mockup. The measured series has no sample at time 2; the prediction still does. Source settings and full-resolution statistics remain visible alongside the chart.*

## Open the workspace

- With a mesh preview open, choose **Advanced ▸ Plot builder…**. The workspace opens beside the mesh with a snapshot of its current model; it does not add an operation, change coordinates or mark the mesh dirty.
- The **Data table**, **Plot over time** and **Probe line** panels also offer **Plot builder…** shortcuts. They preselect the table association, entity/field history or probe endpoints respectively.
- Without a mesh, run **Kratos Mesh: Scientific Plot Builder** in the Command Palette. Choose **Add source**, then a CSV/TSV file. The existing empty-mesh preview remains a mesh launcher; it is not required for table plotting.

The configuration column can be resized. Presets select a starting family for a history/profile, XY relationship, distribution or 2D grid. Settings update the preview after a short debounce; **Refresh** explicitly rereads the source, while **Cancel** stops the current worker.

## Import a table

1. Choose **Add source**, keep **Source type: table**, and enter a file path or use **Browse…**.
2. Choose **Inspect source** to see the first twelve records, row count, stable column IDs and diagnostics.
3. Correct **Delimiter** and **Headers** if automatic detection is not appropriate. Comma, tab, semicolon and pipe are supported. Quotes, escaped quotes and multiline cells are recognized.
4. **Missing tokens** are comma-separated; the defaults are an empty cell, `NA`, `N/A` and `null`. A missing or nonfinite numeric value becomes a gap, never zero. Ragged records are rejected rather than truncated.
5. **Numeric columns** optionally specifies numeric column IDs such as `c0,c1`. Invalid cells then become diagnosed gaps. Without an override, a column containing ordinary text is classified as text.
6. Supply units in headers, for example `Force [N]`, or through **Units**, for example `c1=N,c2=mm`. Unit text is retained exactly; dimensions are recognized only for the curated names supported by the field-dimensions core. Unknown units are not assumed dimensionless or SI.
7. Choose **Add series**, then its X/Y columns. Add another series to overlay a second quantity or another file. Column IDs remain distinct even when headers are duplicated.

For the screenshot, the table is:

```csv
Time [s],Measured [N],Predicted [N]
0,1,1.2
1,3,2.8
2,NA,5
3,7,7.2
4,9,8.8
```

## Simulation sources

| Source | Configuration and semantics |
| --- | --- |
| **mesh** | Choose Nodes, Elements, Conditions or Geometries, an optional SubModelPart, selected IDs and an optional frame index. Point and cell ID spaces remain independent. Geometries have no dedicated field association, so overlapping Elemental fields are deliberately excluded. Field mappings are keyed by association, variable and component, not an accidental table position. |
| **history** | Choose an association, entity ID and variable. The shared field-series collector discovers steps from the supplied path and reads disk values, without replaying mesh edits. Components appear as separate columns. Filename step labels and frame indices are not physical time; supply one **Physical times** value per collected frame and a **Time unit** when known. In-file time values are used only when the source exposes them. |
| **probe** | Choose a Nodal field, polyline XYZ points separated by semicolons, and a sample count. The shared line-probe extractor returns distance and component columns. Uncovered samples remain gaps; there is no implicit cell averaging. |
| **inline** | A saved snapshot or a table supplied through a recipe/MCP. Its rows and metadata are stored in the recipe itself. It does not claim a live mesh link on reload. |

Mesh and probe shortcuts capture the current model at workspace creation. Changing the path or requested frame switches to disk extraction rather than continuing to use an unrelated snapshot. Use a fresh workspace to capture newer live edits. History sources always read disk results. A topology-size change warns that an ID may no longer describe the same physical entity; it is not an automatic remeshing correspondence.

## Families and analysis

Available families are **line**, **scatter**, **histogram**, **box**, **bar**, **heatmap** and **contour**. X and Y can represent any appropriate relationship, including force–displacement. A series can be split by a grouping column. Multiple sources/series support multiple histories or file comparisons.

- **Magnitude columns** lists explicit numeric component IDs in the same units. Individual components use the normal Y picker.
- **Filter** accepts `column,min,max`. Recipes/MCP additionally support an exact text-value filter. Removed rows are outside the selected analysis; missing rows inside the selection remain gaps.
- Histograms have explicitly configurable equal-width **Bins**. Grouped bars select mean, sum, minimum, maximum or count. Box plots use linearly interpolated quartiles and whiskers at samples within 1.5 IQR; a distribution is not an uncertainty estimate.
- **Add analysis** builds an ordered list. Smoothing uses a centered, odd-sized moving window, clipped at segment ends. Regression reports slope, intercept and R². Derivatives use neighboring secants with one-sided endpoints; integration uses cumulative trapezoids, restarting after each gap. Calculus requires strictly increasing numeric X within each covered segment; sorting and duplicate removal are never hidden operations.
- **Normalize** divides by an explicitly supplied value in the input Y unit. **Convert** multiplies by an explicit positive factor and supplies a target unit; changing physical dimensions is refused. Equal dimensions alone do not make Pa and kPa numerically interchangeable. Compound derivative/integral labels preserve source scale, such as `(kPa)/(ms)`, rather than silently relabelling values as SI.
- **Errors** accepts `column,meaning`, for example `c3,instrument standard uncertainty`. The error column must use the same supplied Y unit. Negative/missing errors are not drawn. Smoothing, fitting and calculus do not invent uncertainty propagation; raw supplied errors remain available in the original samples.

**Sources, transformations and diagnostics** shows parameters, counts, missing values, means, population standard deviations and regression coefficients. Statistics and numeric exports use the full dataset, not display samples.

### Heatmaps and contours

Choose numeric X, Y and Z columns and an explicit **Grid method**. **regular** maps coordinate pairs to a rectangular array and masks missing cells; duplicates are rejected. **nearest** requires grid dimensions and a positive coverage radius. It masks cells outside the samples' convex hull or farther than that radius from a supplied sample. It is not a triangulated finite-element interpolation or a guarantee that an arbitrary geometric hole is detected. Duplicate coordinates must be resolved in the input; very expensive grids are refused with a budget diagnostic. No scattered sample set is silently interpreted as a regular surface.

### Reference comparison

Choose a **Reference** series, **Match** method and **Tolerance**. Exact matching keeps only shared X values. Nearest and linear matching are tolerance-bound, do not extrapolate and do not linearly interpolate across a recorded gap. The reference must resolve to one ungrouped series. Alignment uses snapshots of the reference before alignment, so list order does not change the results. Step labels and frame indices are refused as a physical-time alignment axis. Unit/type mismatches require explicit correction or a separate panel, including a known unit mixed with an unknown one.

Interpolated points do not acquire invented entity/frame identities. An original entity/history sample can be selected through the chart or **Show in mesh** in the accessible sample table when it belongs to the owning preview. Links are refused for another file, reloaded inline snapshots, an explicitly supplied run ID or a changed timeline. Automatic cross-run navigation is not yet delivered.

## Presentation, keyboard and themes

Set a title, axis labels and limits, linear/log scales, series colors, marker shapes, visibility and 1/2/4 panels. Add an annotation as `x,y,text`. Nonpositive values on log axes are diagnosed, retained in CSV and drawn as gaps. Categorical X does not support a log axis.

Use pointer drag/hover and the chart toolbar for exploration, or the keyboard-focusable **Zoom in**, **Zoom out** and **Reset axes** buttons. Standard controls support Tab, Shift+Tab, arrow keys and Enter/Space with visible focus. The expandable **Plotted samples** table gives keyboard-accessible values and entity-selection buttons for the first 100 displayed samples per series. CSV contains all values. This is an accessible alternative to the chart, not a claim that every Plotly gesture is keyboard-accessible.

![Plot builder in the supported light theme](/screenshots/plot-builder-light.png)

![Plot builder in the supported high-contrast theme](/screenshots/plot-builder-contrast.png)

## Save recipes and export

**Save recipe** writes version-1 JSON with sources, mappings, ordered transformations, comparison parameters and presentation. Disk paths are relative to the recipe's directory. Live mesh/probe snapshots are embedded as inline tables so reloading does not substitute unedited disk values. **Load recipe** validates the version before replacing the current configuration. Missing files/fields identify the source and affected series in diagnostics; other available series can still produce a labelled partial result.

- **CSV + metadata** writes all derived and original selected samples, including units, source ID/row, entity association/ID, frame, supplied time and run ID where available. Grid exports also include every derived grid cell, including masked cells. `<output>.kratosplot.json` records the recipe, source revisions, statistics, transformations and diagnostics.
- **PNG / SVG** export the currently displayed chart, including its visible series and zoom, with a provenance companion. The graphic may use disclosed display sampling; CSV does not. The image manifest records the displayed view separately from the numerical recipe.
- Exports cannot overwrite a source file. Plotting, styling and saving a recipe do not dirty mesh geometry.

## Execution limits and current boundaries

Collection runs in a host worker. Cancellation hard-terminates that worker, including a synchronous parser call. If no complete dataset has been published, cancellation returns an explicitly partial, empty result rather than presenting unfinished calculations as complete. Source/settings changes invalidate the old result immediately; late replies do not replace a newer chart or authorize an old export.

Tables are bounded to 1,000,000 rows, 256 columns and a 128 MiB file budget; histories to 5,000 frames; nearest grids to 256×256 cells and an operation budget. The workspace caches parsed table extraction under a conservative 64 MiB budget, checking source bytes and import settings on every refresh. Mesh/probe/history readers are not persistently cached because companion files and changing timelines need a broader invalidation contract. File changes are picked up on refresh, not by an automatic plot watcher.

Long line/scatter displays use ordered bucket sampling with first/last samples and extrema; a bucket containing a gap is masked conservatively rather than bridging it. Statistics and CSV are computed first at full resolution. Boxes use host-computed quartiles; heatmaps/contours retain their bounded grids. The status line and diagnostics disclose sampling.

**Still open for roadmap acceptance:** graphical run discovery and owned cross-run/time-cursor navigation, shortcuts for additional analysis tables, progressive history partials, persistent companion-aware mesh/history caches, million-row/Remote-SSH memory and latency budgets, and broader packaged recipe/export/cancellation/timeline regression coverage. The workspace is a separate read-only editor, not yet an in-flow mesh analysis region. The [library decision and verification record](../plotting-library.md) distinguishes measured behavior from these remaining claims.

## MCP parity

`plot_table_read` inspects a CSV/TSV path with the same import options and revision metadata. `plot_dataset` evaluates a version-1 recipe using the same worker/extractors/numerical core and optionally writes the full CSV plus provenance companion. JSON replies default to 100 rows/points and are bounded to 10,000 per series; `totalPoints` and `fullCount` disclose truncation. Inline source rows are not echoed a second time: those replies provide `recipeMetadata` and `inlineDataInRequest: true`, rather than a misleading executable recipe with truncated rows. Keep the original request recipe, or use the complete export manifest, for reproduction. MCP cancellation/progress is passed to the worker. `mesh_capabilities.plotting` publishes supported sources, families, transformations and budgets. Styling and interactive layouts do not add numerical operations.
