/**
 * The standalone stdio MCP server entry (own esbuild entry → dist/mcpServer.js;
 * runnable with plain `node`, no VS Code). Exposes the extension's pure
 * mesh/problemtype capabilities as MCP tools — see src/mcp/tools.ts (handlers)
 * and src/mcp/register.ts (schemas). Register with an MCP client, e.g.:
 *
 *   claude mcp add kratos-mdpa -- node <repo>/dist/mcpServer.js
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { configureMmg } from "./parser/remesh";
import { registerAllTools } from "./mcp/register";
import { setProgressSink } from "./mcp/tools";

// stdout carries JSON-RPC: reroute anything a dependency might console.log.
console.log = console.info = console.warn = (...args: unknown[]) => console.error(...args);

// Same fix as extension.ts: the bundled mmg.cjs cannot locate its own wasm
// (import.meta.url is lost in the CJS bundle), so feed it the copied binary.
try {
  configureMmg({ wasmBinary: fs.readFileSync(path.join(__dirname, "mmg-core.wasm")) });
} catch {
  /* dev layout without the copied wasm — the package self-resolves it */
}

function version(): string {
  try {
    // dist/../package.json in both the repo and the installed extension.
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    if (typeof pkg.version === "string") return pkg.version;
  } catch {
    /* fall through */
  }
  return "0.0.0";
}

async function main(): Promise<void> {
  const server = new McpServer(
    { name: "kratos-mdpa", version: version() },
    { capabilities: { logging: {} } }
  );
  registerAllTools(server);
  await server.connect(new StdioServerTransport());
  // MMG progress lines → MCP log notifications (best-effort).
  setProgressSink((line) => {
    void server.server.sendLoggingMessage({ level: "info", data: line }).catch(() => undefined);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
