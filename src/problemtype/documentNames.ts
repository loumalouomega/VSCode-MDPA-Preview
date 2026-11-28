/**
 * The default solver-document names and the list of documents a problemtype
 * writes. Shared by the generator, the declaration validator, preflight, the
 * sidebar and MCP so one declaration cannot disagree with itself.
 *
 * Pure module: no vscode / DOM / fs imports.
 */

import type { ProblemtypeDeclaration } from "./types";

export const DEFAULT_PRIMARY_DOCUMENT = "ProjectParameters.json";
export const DEFAULT_DRIVER_SCRIPT = "MainKratos.py";

/** The primary document a declaration writes (its own, else the default). */
export function primaryDocumentName(
  decl: Pick<ProblemtypeDeclaration, "primaryDocumentName">
): string {
  return decl.primaryDocumentName ?? DEFAULT_PRIMARY_DOCUMENT;
}

/**
 * Every solver JSON document a declaration writes, primary first. A declaration
 * that names none gets just the primary; the materials files and the driver are
 * never part of this list.
 */
export function solverDocumentNames(
  decl: Pick<ProblemtypeDeclaration, "primaryDocumentName" | "solverDocuments">
): string[] {
  const primary = primaryDocumentName(decl);
  const docs = decl.solverDocuments;
  return docs && docs.length > 0 ? [...docs] : [primary];
}
