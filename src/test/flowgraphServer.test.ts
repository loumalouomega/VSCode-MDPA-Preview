import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as path from "node:path";
import type { AddressInfo } from "node:net";

import { createFlowgraphApp } from "../flowgraphServer";

// The flowgraph assets ship inside the installed package; the server serves
// them verbatim. Point the app straight at node_modules so this test needs no
// build step.
const ASSET_ROOT = path.join(
  __dirname,
  "..",
  "..",
  "node_modules",
  "@kratos-flowgraph",
  "flowgraph"
);
const BRIDGE_PATH = path.join(
  __dirname,
  "..",
  "..",
  "flowgraph-bridge",
  "vscode-bridge.js"
);

function withServer(
  run: (base: string) => Promise<void>
): () => Promise<void> {
  return async () => {
    const app = createFlowgraphApp({
      assetRoot: ASSET_ROOT,
      bridgePath: BRIDGE_PATH,
    });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await run(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

async function get(
  url: string
): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            contentType: String(res.headers["content-type"] ?? ""),
          })
        );
      })
      .on("error", reject);
  });
}

test(
  "GET / renders the litegraph editor shell",
  withServer(async (base) => {
    const res = await get(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.contentType, /html/);
    // The EJS view engine resolved (app.engine('ejs', ejs.__express) fix works).
    assert.match(res.body, /id="main"/);
    assert.match(res.body, /class="graphcanvas"/);
    // Node/widget module tags were injected from the walked module lists.
    assert.match(res.body, /<script type="module" src="js\/nodes\//);
  })
);

test(
  "GET / injects the vscode bridge script",
  withServer(async (base) => {
    const res = await get(`${base}/`);
    assert.match(res.body, /js\/vscode-bridge\.js/);
    // ...and it comes before </body>.
    assert.ok(
      res.body.indexOf("vscode-bridge.js") < res.body.lastIndexOf("</body>")
    );
  })
);

test(
  "serves the bridge client as javascript",
  withServer(async (base) => {
    const res = await get(`${base}/js/vscode-bridge.js`);
    assert.equal(res.status, 200);
    assert.match(res.contentType, /javascript/);
    assert.match(res.body, /kratos-flowgraph-bridge/);
  })
);

test(
  "serves a flowgraph node module as static javascript",
  withServer(async (base) => {
    const res = await get(`${base}/js/litegraph/litegraph.core.js`);
    assert.equal(res.status, 200);
    assert.match(res.contentType, /javascript/);
    assert.match(res.body, /LiteGraph/);
  })
);

test(
  "dropped routes /upload_json and /run_simulation are gone (404)",
  withServer(async (base) => {
    assert.equal((await get(`${base}/run_simulation`)).status, 404);
    // /upload_json is POST-only in flowgraph; a GET must not be handled either.
    assert.equal((await get(`${base}/upload_json`)).status, 404);
  })
);
