# Virtual Wind Tunnel

**Advanced ▸ Virtual wind tunnel…** takes a surface (an STL, OBJ or PLY of the body you want to test) to a meshed tunnel and a prepared Fluid case in five steps. Everything it does is also available headlessly as the `wind_tunnel_plan` and `wind_tunnel_generate` MCP tools, which call the same planner and builder, and every step of the build is an ordinary mesh operation (`sdfDistance`, `remesh`, `levelset`), so nothing here is a black box.

## The five steps

1. **Body** — the surface, its unit and how to turn it. The flow runs along **+X** and up is **+Z**; rotate the body until its nose points at −X and its roof at +Z. The panel shows the size it *measured* (a model in millimetres read as metres is the usual mistake), the frontal area (the union of the shadow on the plane facing the flow, not the sum of the faces) and whether the surface is closed. An open or inward-wound body is reported, not repaired: the sign of the distance comes from the winding number, which tolerates small gaps.
2. **Tunnel** — how far the walls are, in body lengths (upstream 3, downstream 6), widths (sides 4) and heights (top 5), and what the floor is: free air, a slip floor, a no-slip floor or a **moving ground** at the stream speed. A **half model** meshes only y ≥ 0 and closes the cut with a symmetry plane. The **blockage** (frontal area over the tunnel cross-section) is shown and warned above 5%, where the walls speed the flow up past the body.
3. **Flow** — speed and fluid (air or water at 20 °C, or your own density and viscosity). The Reynolds number and the regime follow.
4. **Mesh** — body-fitted or embedded, the surface and far-field cell sizes, the target y+, the layer growth and aspect limit, and the wake refinement.
5. **Generate** — the folder and name, then the plan (cell count, memory and time estimates, every warning and error) and the build, with progress and **Cancel**.

## What it builds

**Body-fitted** (the default):

1. a graded tetrahedral lattice of the tunnel, with its six faces named (`Inlet`, `Outlet`, `Floor`, `Ceiling`, `SideLow`/`SideHigh`, or `Symmetry`);
2. a few passes of refinement towards the body: the signed distance to the surface is sampled at the nodes (meshio++) and MMG refines to a size that grows with the distance, plus a refinement box behind the body for the wake;
3. the **carve**: MMG's level-set split along the zero of the distance, then the body interior is dropped (the fluid side is the one touching the inlet, found from geometry, never from MMG's labels);
4. the **wall layer**: `remesh` in `wall` mode grades the cells by the distance to the wall — the size across it starts at the first height for the target y+ and grows geometrically, the size along it starts at the surface size and is limited by the maximum aspect ratio;
5. hard checks (no inverted or zero-volume tetrahedra, every boundary face on a named part) and a measured **wall fit**.

The fluid becomes the `Fluid` SubModelPart and the wall the `Body` part. The mesh is written as `<name>.mdpa`, with `<name>_body.stl` (the body as placed), `<name>.kratosvwt.json` (the parameters and the report) and `<name>.kratoscase.json` — the **prepared case** for the Fluid problemtype: the inlet at the stream speed along +X, a zero-pressure outlet, slip walls on the ceiling and sides, the floor you chose, the linear-logarithmic wall law on the body with the first node row as the wall distance (or no-slip when y+ is below 5), time stepping from the flow-through time of the body, and four monitors on the body: forces and moments, aerodynamic coefficients (reference area = the frontal area, reference length = the body length, dynamic pressure from the flow), the pressure coefficient and the wall y+. **Open the mesh** shows it in the preview with that case already in the Problemtype section; with *Solver files* ticked it also writes `ProjectParameters.json`, the materials and `MainKratos.py`.

**Embedded** skips the carve and the wall layer: the surface stays unfitted, the lattice is refined towards it and the signed `DISTANCE` is written for the **Embedded Fluid** problemtype, whose prepared case uses the embedded force-and-moment process.

## What to expect

- **A stretched-tetrahedron layer, not prisms.** MMG makes tetrahedra, so the boundary layer is a field of cells that are thin across the wall and long along it. That suits a wall function (y+ 30–100) well; a wall-resolved mesh (y+ ≈ 1) needs a low-Reynolds turbulence model and far more cells, and the plan says so.
- **The wall follows the surface to a stated tolerance.** The carve cuts the zero of a sampled distance, so a sharp edge is followed to about 1% of the body length. The report states the measured largest and mean gap (as fractions of the body length), and warns when the largest exceeds half the surface size. A finer **carve factor**, surface size or fit lowers it at a cost; a smooth body is followed to a few tenths of a percent.
- **No turbulence model.** At wind-tunnel Reynolds numbers the flow is turbulent and the Fluid problemtype applies only a wall law and the dynamic subscales of QSVMS. The forces are a first estimate, and the plan says so. A RANS formulation is a separate Kratos application and is not part of this.
- **Size.** Measured on a sharp-edged box in a tunnel: about 400 000 tetrahedra took 80 s and one million 6.5 minutes (about 3 GB peak in one process), and the time grows faster than the cell count. The plan refuses above 3 million tetrahedra (adjustable) before any meshing starts. The estimate is an integral of the sizing law scaled by a factor fitted on test cases: expect it within about a factor of two.
- **Solver run.** Nothing here has been run through Kratos in this repository: the case follows the solver's own parameter definitions (the test suite pins every formulation to the keys the solver validates), but treat the first run as a check of the generated files.

## Headless

```jsonc
// wind_tunnel_plan: read-only; nothing is meshed
{ "bodyPath": "car.stl", "unit": "mm", "rotation": [0, 0, 90],
  "tunnel": { "ground": "moving", "clearance": 0.1, "halfModel": true },
  "flow": { "speed": 40 },
  "mesh": { "surfaceSize": 0.05, "yPlus": 60 } }
```

`wind_tunnel_generate` takes the same object plus `outputFolder`, `stem`, `overwrite` and `generateCase`, reports progress through `notifications/progress`, stops between steps on cancellation and refuses to overwrite existing files unless asked.
