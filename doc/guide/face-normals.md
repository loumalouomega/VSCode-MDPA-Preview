# Face Normals

**Advanced ▸ Face normals** draws an arrow on every surface face, and on every
boundary face of a volume mesh.

![Face normals drawn on a tetrahedral mesh's skin, confirming a consistent outward orientation](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/face-normals.png)

## What it is for

Finding **inverted elements**.

The order a cell lists its nodes in — its *winding* — decides two things at
once: which way the face normal points, and the sign of the element's Jacobian.
A cell wound the wrong way therefore has a negative volume, which a Kratos
solver will either refuse outright or quietly integrate with the wrong sign.

Nothing in the mesh statistics shows this. The node count is right, the element
count is right, the quality metrics are computed from unsigned lengths and
angles and look fine. But with normals drawn, a flipped element is unmistakable:
its arrow points into the mesh while every arrow around it points out.

## What you get

- **Green arrows** at each face centroid, along its unit normal, scaled to about
  4% of the model's bounding diagonal so they read at any model scale.
- **Red cells** for any element wound against a neighbour.
- A **status line** — either `N face normals — orientation is consistent.` or
  `N face normals — K element(s) wound against a neighbour (shown in red).`

Interior faces of a volume mesh are dropped, so what you see is the skin. A
solid block of arrows through the interior would tell you nothing and hide the
surface.

## How the consistency check works

Two faces that share an edge are wound consistently exactly when they traverse
that shared edge in **opposite** directions — walk the boundary of two adjacent
triangles and you will see it. So if the same directed edge (`a→b`) turns up in
two different faces, one of them is flipped relative to the other, and both ends
are reported.

Two consequences worth knowing:

- It is a **relative** test. A mesh whose faces are *uniformly* inside-out is
  perfectly self-consistent and reports zero problems. The arrows themselves are
  the check for global orientation — if they all point inwards, the whole surface
  is reversed.
- For **volume** meshes the boundary-face winding is generated from the cell type
  rather than read from the file, so it is consistent by construction and the
  count is normally zero. The test earns its keep on **surface** meshes — shells,
  extracted skins, imported STL/OBJ — which is where flipped elements actually
  come from.

Degenerate (zero-area) faces have no normal and are skipped rather than drawn as
a NaN arrow.

## Is the surface actually closed?

The consistency check above cannot answer that, and the two failures are
genuinely different: a flipped face is a *winding* problem, a hole is a
*topology* one. So the status line also reports what the boundary itself looks
like:

- **boundary edges** — edges used by exactly one face. These are holes.
- **non-manifold edges** — edges where three or more faces meet.
- **inconsistently wound face pairs** — the same defect the arrows show, counted.
- **zero-area faces** — degenerate triangles.

When all four are zero the surface is reported as *closed, manifold and
consistently wound*, which is the precondition for anything that needs an inside
and an outside: a signed distance field, a level-set split, a volume mesher, most
CFD.

The counts are given individually rather than collapsed into a pass/fail,
because "not watertight" is not something you can act on. **Three** boundary
edges is a single missing triangle you can patch; **three thousand** is a
surface that was never closed in the first place, and the two call for entirely
different responses.
