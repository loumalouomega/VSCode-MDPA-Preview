/**
 * The sidebar forms of the meshio++ 18.1.0 in-place operations, as DATA.
 *
 * Zero imports, so both the chrome (`webviewChrome.ts`, which writes the markup)
 * and the webview (`webview/meshMod.ts`, which reads the inputs back into an
 * `applyOp` message) share one description and cannot drift. The keys are the
 * ones `meshio181.ts`'s `SPECS` validates; a drift guard in `meshio181.test.ts`
 * checks every key here is one the spec reads.
 *
 * Field kinds: `num` / `int` (a number, blank = omitted), `bool` (a checkbox,
 * sent only when ticked unless `defaultOn`), `text` (a string, blank = omitted;
 * comma-separated lists and vectors are text), `enum` (a select).
 */

export type Form181Kind = "num" | "int" | "bool" | "text" | "enum";

export interface Form181Field {
  key: string;
  label: string;
  kind: Form181Kind;
  title: string;
  placeholder?: string;
  options?: readonly string[];
  /** Bool only: a checkbox that starts ticked and posts `false` when cleared. */
  defaultOn?: boolean;
  /** The form refuses to post while this is blank. */
  required?: boolean;
}

export interface Form181 {
  op: string;
  title: string;
  icon: string;
  hint: string;
  fields: Form181Field[];
}

export const FORMS_181: Form181[] = [
  {
    op: "untangle", title: "Untangle", icon: "smooth",
    hint: "Moves nodes until every tetrahedron / hexahedron corner has a positive volume. Connectivity, ids and fields are kept.",
    fields: [
      { key: "fixBoundary", label: "fix boundary", kind: "bool", title: "Keep the boundary nodes where they are.", defaultOn: true },
      { key: "frozenPart", label: "frozen part", kind: "text", title: "SubModelPart whose nodes are held fixed.", placeholder: "none" },
      { key: "rings", label: "rings", kind: "int", title: "Rings of neighbouring cells optimised around each inverted one.", placeholder: "default" },
      { key: "maxSweeps", label: "sweeps", kind: "int", title: "Most sweeps over the nodes.", placeholder: "default" },
      { key: "smooth", label: "smooth", kind: "bool", title: "Smooth the quality once the mesh is untangled.", defaultOn: true },
    ],
  },
  {
    op: "morph", title: "Morph", icon: "scale",
    hint: "The boundary follows a nodal displacement field; the interior follows harmonically with Jacobian-based stiffening.",
    fields: [
      { key: "variable", label: "field", kind: "text", title: "Nodal vector field (2 or 3 components) holding the displacement.", placeholder: "DISPLACEMENT", required: true },
      { key: "fixBoundary", label: "boundary follows", kind: "bool", title: "The boundary nodes are the constrained ones. Clear it and name a part to drive only that.", defaultOn: true },
      { key: "constrainedPart", label: "constrained part", kind: "text", title: "Extra SubModelPart whose nodes follow the displacement.", placeholder: "none" },
      { key: "steps", label: "steps", kind: "int", title: "Apply the displacement in this many increments.", placeholder: "1" },
      { key: "stiffening", label: "stiffening", kind: "num", title: "Jacobian-based stiffening exponent.", placeholder: "default" },
      { key: "allowInverted", label: "allow inverted", kind: "bool", title: "Return the result even when cells invert (it is reported either way)." },
    ],
  },
  {
    op: "registerRigid", title: "Register (rigid ICP)", icon: "translate",
    hint: "Lays this mesh onto another file by iterative closest points and applies the rotation and translation. Vector and tensor fields turn with the mesh.",
    fields: [
      { key: "path", label: "target file", kind: "text", title: "The mesh to register onto (a surface, or a point cloud).", placeholder: "scan.stl", required: true },
      { key: "method", label: "method", kind: "enum", title: "point_to_plane needs the target to carry normals.", options: ["point_to_point", "point_to_plane"] },
      { key: "maxIterations", label: "iterations", kind: "int", title: "Most ICP iterations.", placeholder: "default" },
      { key: "maxDistance", label: "max pair distance", kind: "num", title: "Pairs farther apart than this are ignored.", placeholder: "none" },
      { key: "part", label: "move only part", kind: "text", title: "Register and move only the nodes of this SubModelPart (fields are then left alone).", placeholder: "whole mesh" },
    ],
  },
  {
    op: "geodesicDistance", title: "Geodesic distance", icon: "measure",
    hint: "Heat-method distance along a triangle surface to the source nodes. A node no source reaches is a gap, not a zero.",
    fields: [
      { key: "sourceNodes", label: "source node ids", kind: "text", title: "Comma-separated node ids.", placeholder: "1, 2" },
      { key: "sourcePart", label: "source part", kind: "text", title: "A SubModelPart whose nodes are all sources.", placeholder: "none" },
      { key: "output", label: "field", kind: "text", title: "Nodal field name.", placeholder: "GEODESIC_DISTANCE" },
    ],
  },
  {
    op: "laplacianEigenmodes", title: "Surface eigenmodes", icon: "fieldHessian",
    hint: "The lowest Laplace-Beltrami eigenmodes of a triangle surface, one nodal field per mode (mode 0 is the constant).",
    fields: [
      { key: "numModes", label: "modes", kind: "int", title: "Number of modes.", placeholder: "6" },
      { key: "output", label: "field prefix", kind: "text", title: "Fields are named <prefix>_0, <prefix>_1, …", placeholder: "LAPLACE_MODE" },
    ],
  },
  {
    op: "convertCoordinates", title: "Cylindrical / spherical components", icon: "rotate",
    hint: "Writes the coordinates and the vector (3) or tensor (9) fields in the local basis of each point, as new fields; the originals are kept.",
    fields: [
      { key: "arrays", label: "fields", kind: "text", title: "Comma-separated nodal vector or tensor fields.", placeholder: "VELOCITY", required: true },
      { key: "system", label: "system", kind: "enum", title: "Coordinate system.", options: ["cylindrical", "spherical"] },
      { key: "axis", label: "axis", kind: "text", title: "Axis direction, three numbers.", placeholder: "0, 0, 1" },
      { key: "origin", label: "origin", kind: "text", title: "A point on the axis, three numbers.", placeholder: "0, 0, 0" },
      { key: "inverse", label: "back to Cartesian", kind: "bool", title: "Treat the fields as local components and convert them to Cartesian." },
    ],
  },
  {
    op: "prepareMetric", title: "Prepare MMG metric", icon: "remesh",
    hint: "Intersects metric fields (6 components in 3-D, 3 in 2-D), normalises them to a vertex budget, clamps the sizes and grades them. Feed the result to Sweep, mirror and layers ▸ adapt.",
    fields: [
      { key: "arrays", label: "metric fields", kind: "text", title: "Comma-separated nodal metric fields.", placeholder: "METRIC_A, METRIC_B", required: true },
      { key: "targetVertices", label: "target vertices", kind: "num", title: "Normalise the metric to about this many vertices.", placeholder: "none" },
      { key: "hmin", label: "hmin", kind: "num", title: "Smallest edge length.", placeholder: "none" },
      { key: "hmax", label: "hmax", kind: "num", title: "Largest edge length.", placeholder: "none" },
      { key: "gradation", label: "gradation", kind: "num", title: "Largest size ratio between neighbours.", placeholder: "none" },
      { key: "output", label: "field", kind: "text", title: "Output field name.", placeholder: "METRIC" },
    ],
  },
];

/** Element id of one input: `f181-<op>-<key>`. */
export const form181Id = (op: string, key: string): string => `f181-${op}-${key}`;

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The markup of one form (the caller supplies the icon markup, since `ic` lives in the chrome). */
export function form181Html(f: Form181, iconHtml: string, playHtml: string, stopHtml: string): string {
  const rows = f.fields.map((d) => {
    const id = form181Id(f.op, d.key);
    const title = ` title="${esc(d.title)}"`;
    let control: string;
    switch (d.kind) {
      case "bool": control = `<input type="checkbox" id="${id}"${d.defaultOn ? " checked" : ""}>`; break;
      case "enum": control = `<select id="${id}" class="edit-sel edit-sel-grow">${(d.options ?? []).map((o, i) => `<option value="${o}"${i === 0 ? " selected" : ""}>${o}</option>`).join("")}</select>`; break;
      case "text": control = `<input type="text" id="${id}" class="edit-text"${d.placeholder ? ` placeholder="${esc(d.placeholder)}"` : ""}>`; break;
      default: control = `<input type="number" id="${id}" class="edit-num" step="${d.kind === "int" ? "1" : "any"}"${d.kind === "int" ? ' min="0"' : ""}${d.placeholder ? ` placeholder="${esc(d.placeholder)}"` : ""}>`;
    }
    return `                <div class="edit-form-row"><label class="edit-field edit-field-grow"${title}><span>${esc(d.label)}</span>${control}</label></div>`;
  }).join("\n");
  return `              <div class="edit-form collapsed" id="${f.op}-form">
                <button type="button" class="edit-form-title"><span class="sb-chevron"></span>${iconHtml}<span>${esc(f.title)}</span></button>
                <div class="edit-form-row"><span class="edit-hint">${esc(f.hint)}</span></div>
${rows}
                <div class="edit-form-row">
                  <button type="button" class="edit-apply edit-apply-mmg" data-op="${f.op}" title="${esc(f.title)}" data-run-title="${esc(f.title)}"><span class="apply-play">${playHtml}</span><span class="apply-stop">${stopHtml}</span></button>
                </div>
                <div class="edit-progress hidden" id="${f.op}-progress">
                  <div class="edit-progress-track"><div class="edit-progress-bar"></div></div>
                  <div class="edit-progress-msg"></div>
                </div>
              </div>`;
}
