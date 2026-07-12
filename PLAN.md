# Problemtype Interface — implementation plan & status

> Working file for the Kratos problemtype feature (generate ProjectParameters.json,
> configure the Kratos location, run cases, view vtk_output results).
> Full design: `/home/vicente/.claude/plans/let-s-write-the-problemtype-stateless-kahan.md`.
> Update the checklist as tasks finish; delete this file when everything ships.

## Context

The extension previews/edits `.mdpa` meshes but users had to hand-write
`ProjectParameters.json`, a materials JSON and `MainKratos.py` to run Kratos.
This feature adds a GiDInterface-inspired **problemtype** system:

- Pure core in `src/problemtype/` (Node-testable): `defineProblemtype(decl, hooks)`
  API, case generator (GiD-shaped output, always with `vtk_output_process`),
  case-file (de)serialization, Kratos env computation.
- Built-ins: Structural, Fluid (monolithic), Convection-Diffusion.
- User problemtypes: `.kratos/problemtypes/*.js` (node:vm sandbox) and `*.py`
  (pyodide, lazy, bundled in `dist/pyodide/`).
- UI: the "Problemtype" sidebar section in the mdpa preview (`webview/problemtype.ts`),
  auto-saving to `<stem>.kratoscase.json`.
- Host glue: `src/ptController.ts` + first `contributes.configuration`
  (`kratos.pythonPath` / `installPath` / `extraEnv` / `problemtypes.extraPaths`),
  run in an integrated terminal, open results in the VTK preview.
- Docs: `doc/guide/{simulation,problemtype-authoring,problemtype-python}.md`.

## Tasks

- [x] Phase 1 — pure core (`types/api/generate/mainKratosTemplate/caseFile/kratosEnv` + 3 built-ins) + unit tests
- [x] Phase 2 — host glue (`ptController.ts`, settings, `kratos.case.*` commands, terminal launch)
- [x] Phase 3 — sidebar UI (`webviewChrome.ts` skeleton, `webview/problemtype.ts`, `main.ts` routing, `.pt-*` CSS)
- [x] Phase 4 — workspace JS problemtypes (`jsLoader.ts` vm sandbox + discovery + tests)
- [x] Phase 5 — Python problemtypes (`assets/kratos_problemtype.py`, `pyRuntime.ts`, esbuild pyodide copy, JS≡Python parity test)
- [x] Phase 6 — docs (3 guide pages, VitePress nav/sidebar "Simulation" group, README section, CLAUDE.md architecture + message table)
- [x] Phase 7 — verification: typecheck ✓, 292/292 tests ✓, prod build ✓, docs build ✓, ~7.8 MB compressed payload estimate ✓, version bumped to 1.7.0
- [x] E2E smoke test (Node-level): real `example/MDPA/double_arch.mdpa` → case-file round-trip → generateCase → 3 files written, 0 warnings

## Follow-up round 2 (approved 2026-07-11): Python-first + visual docs — DONE

- [x] A — Polished Python API (`assets/kratos_problemtype.py`): full docstrings,
      `process()` + `INTERVAL_TOTAL` helpers, eager ValueError validation naming the
      offending id; covered in `src/test/pyRuntime.test.ts`.
- [x] B — Python ports of the three built-ins in `example/problemtypes/` (`_py` ids,
      hooks included) + READMEs; `src/test/problemtypeExamples.test.ts` keeps them
      **byte-identical** to the TS built-ins.
- [x] C — Six icons (`problemtype`, `generateCase`, `runCase`, `results`, `condition`,
      `material`): .tex sources + hand-authored svg-ui SVGs (no pdflatex in this env;
      LaTeX regen replaces them with the same glyph), codegen re-run, EXPECTED_IDS
      updated, wired into the pt action buttons + section/Conditions/Materials/Output
      block titles.
- [x] D — `scripts/screenshots/{build-harness,capture}.mjs` (standalone webview harness
      + playwright chromium/swiftshader) → `images/problemtype.png` (3360×2000 dark,
      house style), visually verified.
- [x] E — Docs: screenshot into `doc/guide/simulation.md` + README feature table; new
      helpers + example links in `problemtype-python.md`/`problemtype-authoring.md`;
      CLAUDE.md sync (icons note, pyRuntime API, screenshots tooling).
- [x] F — Verification: typecheck ✓, **297/297 tests** ✓, compile ✓, docs build ✓.

## Follow-up round 3 (2026-07-11): custom-compiled Kratos — DONE

- [x] `resolveKratosInstall()` in `src/problemtype/kratosEnv.ts` (pure, tested): a
      picked folder resolves to the dir carrying `KratosMultiphysics/` — the folder
      itself or a source checkout's `bin/{Release,RelWithDebInfo,Debug,FullDebug}` —
      with a `hasLibs` check for the shared-library dir.
- [x] New `kratos.case.selectKratosPath` palette command ("Select Kratos Installation
      Folder…"): folder dialog → validation (modal "Use anyway" escape hatch,
      missing-`libs/` warning) → writes `kratos.installPath` (workspace settings when
      a workspace is open, else user).
- [x] Run flow re-resolves the configured path on every run, so pointing at a Kratos
      source checkout just works; unrecognizable layouts warn but still run.
- [x] Docs: simulation.md "Configure the Kratos location", README bullet, setting
      description in package.json, CLAUDE.md. Verification: typecheck ✓, **302/302
      tests** ✓, compile ✓, docs build ✓.

## Follow-up round 4 (2026-07-12): solver-correct mesh names + more problemtypes — DONE

- [x] `MeshNamingSpec` (`meshNaming` on the declaration; `$field:` + per-dimension
      bases) + pure `resolveMeshNaming` (api.ts) and `adaptMeshNames`
      (`src/problemtype/meshAdapt.ts`); `ptController.generate` writes a renamed
      `<stem>_case.mdpa` copy (Properties preserved) and points `input_filename` at it
      when the mesh's block names differ. Point-condition blocks skipped.
- [x] meshNaming on all built-ins; structural gained the **Element formulation** field
      (SmallDisplacement vs TotalLagrangian — concrete names, no solver replacement;
      fluid/conv-diff/potential/shallow use generic names).
- [x] New built-ins ported from GiDInterface: **Potential Flow**
      (CompressiblePotentialFlowApplication; far-field + 2D wake; no materials) and
      **Shallow Water** (ShallowWaterApplication; custom process lists; MANNING
      materials; 2D-only). ConjugateHeatTransfer/Buoyancy/PFEM/GeoMechanics/FSI
      excluded as multi-solver/multi-stage.
- [x] Custom process lists supported end-to-end (`ConditionSpec.list` = any string;
      generator emits standard three + custom).
- [x] Python API: `mesh_naming=` + `icon=` params; all five example ports updated /
      added (`potential_flow.py`, `shallow_water.py`) with byte-identical parity tests.
- [x] **Per-problemtype TikZ logos**: `ptStructural` (cantilever+load), `ptFluid`
      (streamlines), `ptThermal` (heat waves), `ptPotentialFlow` (airfoil),
      `ptShallowWater` (waves over bed) — .tex + hand-authored SVGs, `decl.icon`
      rendered on the section forms (unknown ids fall back to the generic glyph).
- [x] Docs: simulation.md "Element types and the case mesh" + built-ins list;
      authoring/python meshNaming+icon reference; README; CLAUDE.md; example README.

## Pending / follow-ups

- [ ] **Manual UI check in real VS Code** — headless verification (code-server +
      Playwright per `.claude/skills/verify`) is unavailable in this env
      (no code-server / browser cache installed). Open an `.mdpa`, exercise the
      Problemtype section: dropdown, forms, assignments, Generate, Run, Open results.
- [ ] **Run against a real Kratos install** — `pip install KratosMultiphysics-all`,
      set `kratos.pythonPath`, Run case, confirm `vtk_output/` appears and the
      timeline extends live.
- [ ] **Commit** (not yet committed — working tree holds the whole feature).
- [ ] Optional later: filter material laws by domain size in the UI; pyodide
      download-on-demand instead of bundling (~7 MB of the .vsix) if size becomes
      an issue; MPI/`parallel_type` option.
