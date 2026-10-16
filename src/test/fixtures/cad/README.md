# CAD fixtures

Two single-solid CAD files, both a unit box (8 corners, 12 triangles once
triangulated), used by `meshio.test.ts` to pin the FULL-artifact CAD reads
(meshio++ >= 16.42.0 `step`/`iges`, routed 17.2.0 through
`loadMeshioFull()`).

- **`box.step`** — generated HERE with the installed lean artifact's faceted
  `step` writer (`writeMesh(..., "step")` over a 12-triangle cube skin), the
  same writer the export menu's faceted `.step` target uses. Regenerate with
  any node process that loads the wasm and repeats those two calls; the bytes
  are AP214 text.
- **`box.igs`** — copied verbatim from meshio++'s own
  `tests/wasm/fixtures/box.igs` ("a unit box written by OpenCASCADE 7.6"),
  same author, same MIT licence, the same provenance pattern as
  `../transient/two-step.frd`. It is committed rather than generated because
  NEITHER artifact has an `iges` writer.

Both are read-only CAD: no writer exists for `iges` anywhere, and the `step`
writer emits faceted solids, not B-rep — the B-rep side is upstream's
`fitCad`, which the export side (stage 3 of the 17.2.0 integration) routes.
