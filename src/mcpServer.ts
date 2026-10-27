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
import { configureMmgRunner, configureOracleRunner } from "./parser/operations";
import { configureDerivedRunner } from "./parser/derivedRunner";
import { createDerivedWorkerRunner } from "./derivedWorkerClient";
import { createMmgWorkerRunner } from "./mmgWorkerClient";
import { createOracleWorkerRunner } from "./oracleOpWorkerClient";
import { configureMeshioWriteRunner } from "./parser/writers/meshWriter";
import { configureMeshioReadRunner } from "./parser/meshio";
import { createMeshioWriteWorkerRunner } from "./meshioWriteWorkerClient";
import { createMeshioReadWorkerRunner } from "./meshioReadWorkerClient";
import { recordMmgWasm, recordWorker } from "./parser/runtimeWiring";
import { registerAllTools } from "./mcp/register";
import { setProgressSink } from "./mcp/tools";

// stdout carries JSON-RPC: reroute anything a dependency might console.log.
console.log = console.info = console.warn = (...args: unknown[]) => console.error(...args);

// Same fix as extension.ts: the bundled mmg.cjs cannot locate its own wasm
// (import.meta.url is lost in the CJS bundle), so feed it the copied binary.
try {
  configureMmg({ wasmBinary: fs.readFileSync(path.join(__dirname, "mmg-core.wasm")) });
  recordMmgWasm("bundled");
} catch {
  /* dev layout without the copied wasm — the package self-resolves it */
}

// The meshio++ oracle/adopting ops run in a worker thread so a client's
// request cancellation terminates a running wasm call (the in-process default
// cannot be interrupted). A worker's stdout is piped to ours — the JSON-RPC
// channel — so its stdio is captured and drained to stderr instead. Skipped
// when the worker bundle is absent (running from an unbuilt tree).
// MMG remeshes run in dist/mmgWorker.js for the same reason: the synchronous
// C call never blocks the server's event loop, and each worker carries its own
// module-level progress listener (see remesh.ts), so the in-process
// serialization lock in tools.ts orders runs without sharing listener state.
if (fs.existsSync(path.join(__dirname, "mmgWorker.js"))) {
  configureMmgRunner(createMmgWorkerRunner({ captureStdio: true }));
  recordWorker("mmg", "worker");
}
if (fs.existsSync(path.join(__dirname, "oracleOpWorker.js"))) {
  configureOracleRunner(createOracleWorkerRunner({ captureStdio: true }));
  recordWorker("oracle", "worker");
}
// Derived meshes and partition export (mesh_derive, mesh_split) likewise.
if (fs.existsSync(path.join(__dirname, "derivedWorker.js"))) {
  configureDerivedRunner(createDerivedWorkerRunner({ captureStdio: true }));
  recordWorker("derived", "worker");
}
// Same for meshio++ writes (mesh_convert, mesh_transform output, …).
if (fs.existsSync(path.join(__dirname, "meshioWriteWorker.js"))) {
  configureMeshioWriteRunner(createMeshioWriteWorkerRunner({ captureStdio: true }));
  recordWorker("meshioWrite", "worker");
}
// And meshio++ reads (loadMesh behind every tool): a cancelled request
// terminates the read instead of letting it finish unobserved.
if (fs.existsSync(path.join(__dirname, "meshioReadWorker.js"))) {
  configureMeshioReadRunner(createMeshioReadWorkerRunner({ captureStdio: true }));
  recordWorker("meshioRead", "worker");
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
