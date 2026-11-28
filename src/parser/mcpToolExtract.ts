/**
 * Extracts MCP tool names and descriptions from `src/mcp/register.ts` using
 * TypeScript's parser so `referenceDocs.ts` stays free of `@modelcontextprotocol/sdk`
 * and `zod` (which `tsconfig.test.json`'s Node resolution cannot load).
 */

import * as ts from "typescript";
import { EXPORTABLE_EXTENSIONS } from "./writers/exportFormats";

export interface McpToolDoc {
  name: string;
  description: string;
}

const OPS_HELP_SUMMARY = "See the Operation reference for the full op vocabulary.";

function collectStringConsts(sf: ts.SourceFile): Map<string, string> {
  const consts = new Map<string, string>();
  consts.set("OPS_HELP", OPS_HELP_SUMMARY);

  const evalStatic = (node: ts.Expression): string | undefined => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isParenthesizedExpression(node)) return evalStatic(node.expression);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = evalStatic(node.left);
      const r = evalStatic(node.right);
      return l !== undefined && r !== undefined ? l + r : undefined;
    }
    if (ts.isIdentifier(node)) return consts.get(node.text);
    return undefined;
  };

  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      if (decl.name.text === "OPS_HELP") continue;
      const val = evalStatic(decl.initializer);
      if (val !== undefined) consts.set(decl.name.text, val);
    }
  }
  return consts;
}

/** Extract every `server.registerTool(name, { description, ... })` from `register.ts` source. */
export function extractMcpTools(registerSource: string): McpToolDoc[] {
  const sf = ts.createSourceFile("register.ts", registerSource, ts.ScriptTarget.Latest, true);
  const consts = collectStringConsts(sf);
  const exportExts = EXPORTABLE_EXTENSIONS.join(", ");

  const evalExpr = (node: ts.Expression): string => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isParenthesizedExpression(node)) return evalExpr(node.expression);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return evalExpr(node.left) + evalExpr(node.right);
    }
    if (ts.isIdentifier(node)) {
      const val = consts.get(node.text);
      if (val !== undefined) return val;
      throw new Error(`Unsupported identifier in MCP tool description: ${node.text}`);
    }
    if (ts.isTemplateExpression(node)) {
      let out = node.head.text;
      for (const span of node.templateSpans) {
        const exprText = span.expression.getText(sf).trim();
        if (exprText === 'EXPORTABLE_EXTENSIONS.join(", ")') {
          out += exportExts;
        } else {
          out += evalExpr(span.expression);
        }
        out += span.literal.text;
      }
      return out;
    }
    throw new Error(`Unsupported expression in MCP tool description: ${node.getText(sf)}`);
  };

  const tools: McpToolDoc[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "registerTool" &&
      node.arguments.length >= 2
    ) {
      const [nameNode, optsNode] = node.arguments;
      if (!ts.isStringLiteral(nameNode)) {
        throw new Error(`Expected string literal tool name: ${nameNode.getText(sf)}`);
      }
      let description = "";
      if (ts.isObjectLiteralExpression(optsNode)) {
        for (const prop of optsNode.properties) {
          if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "description") {
            description = evalExpr(prop.initializer);
            break;
          }
        }
      }
      tools.push({ name: nameNode.text, description });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return tools;
}
