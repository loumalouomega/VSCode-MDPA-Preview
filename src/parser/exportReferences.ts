/** Scope of the write/re-read fixtures; shared by generator and report lookup. */
export const EXPORT_REFERENCES: Readonly<Record<string, { cellTypes: readonly number[]; note: string }>> = {
  hex: { cellTypes: [9, 12], note: "Hexahedron with boundary quad, non-1-based ids, properties, constraint, nested groups and fields." },
  simplicial: { cellTypes: [5, 10], note: "Tetrahedron with boundary triangle and scalar/vector Nodal, Elemental and Conditional fields." },
  tetra: { cellTypes: [10], note: "Tetrahedron-only variant for single-cell-type volume writers." },
  triangle: { cellTypes: [5], note: "Triangle-only variant for surface and 2D simplicial writers; Conditional scalar/vector fields." },
};
