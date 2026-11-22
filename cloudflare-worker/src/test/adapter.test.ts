import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryDatabase } from "../../../server/src/sqlite.js";
import { SCHEMA_VERSION } from "../../../server/src/types.js";
import worker, { WorkerEnv } from "../index.js";

function makeEnv(token = "secret-worker-token"): WorkerEnv {
  return {
    DB: createMemoryDatabase(),
    CHAOX_AUTH_TOKEN: token
  };
}

test("Cloudflare Worker thin adapter preserves cloudflare-d1 mode, serverInfo, auth, and 67 MCP tools", async () => {
  const env = makeEnv();

  const healthRes = await worker.fetch(new Request("https://chaox-test.workers.dev/health"), env);
  assert.equal(healthRes.status, 200);
  const health = (await healthRes.json()) as Record<string, unknown>;
  assert.equal(health.status, "ok");
  assert.equal(health.schemaVersion, SCHEMA_VERSION);
  assert.equal(health.mode, "cloudflare-d1");

  const unauthRes = await worker.fetch(
    new Request("https://chaox-test.workers.dev/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    }),
    env
  );
  assert.equal(unauthRes.status, 401);

  const authHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${env.CHAOX_AUTH_TOKEN}`
  };

  const initRes = await worker.fetch(
    new Request("https://chaox-test.workers.dev/mcp", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    }),
    env
  );
  const initJson = (await initRes.json()) as { result: { serverInfo: { name: string } } };
  assert.equal(initJson.result.serverInfo.name, "chaox-agent-worker");

  const toolsRes = await worker.fetch(
    new Request("https://chaox-test.workers.dev/mcp", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
    }),
    env
  );
  const toolsJson = (await toolsRes.json()) as { result: { tools: unknown[] } };
  assert.equal(toolsJson.result.tools.length, 67);

  const statusRes = await worker.fetch(
    new Request("https://chaox-test.workers.dev/mcp", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "chaox_get_status", arguments: {} }
      })
    }),
    env
  );
  const statusJson = (await statusRes.json()) as { result: { content: Array<{ text: string }> } };
  const statusData = JSON.parse(statusJson.result.content[0].text) as { backend: string };
  assert.equal(statusData.backend, "cloudflare-d1");
});
