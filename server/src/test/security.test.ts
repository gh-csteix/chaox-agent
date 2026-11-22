import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../app.js";
import { createMemoryDatabase } from "../sqlite.js";
import { MAX_PREFERENCES_CHARS } from "../store.js";
import { SCHEMA_VERSION, ServerEnv, SqlDatabase, SqlPreparedStatement } from "../types.js";

function makeSegmentedEnv(overrides: Partial<ServerEnv> = {}): ServerEnv {
  return {
    DB: createMemoryDatabase(),
    CHAOX_SYNC_TOKEN: "sync-secret-token-abcdefghijklmnopqrstuvwxyz",
    CHAOX_MCP_TOKEN: "mcp-secret-token-abcdefghijklmnopqrstuvwxyz1",
    CHAOX_MCP_READONLY_TOKEN: "mcp-ro-secret-token-abcdefghijklmnopqrstuv",
    ...overrides
  };
}

async function sendReq(
  env: ServerEnv,
  pathname: string,
  options: {
    method?: string;
    token?: string | null;
    origin?: string;
    body?: unknown;
  } = {}
): Promise<{ status: number; headers: Headers; data: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (options.token !== null) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  if (options.origin !== undefined) {
    headers.Origin = options.origin;
  }
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const req = new Request(`https://chaox.example.com${pathname}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  });
  const res = await handleRequest(req, env);
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    data: text ? (JSON.parse(text) as Record<string, unknown>) : {}
  };
}

async function callMcp(
  env: ServerEnv,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
  mcpPath = "/mcp"
): Promise<{ isError?: boolean; payload: Record<string, unknown>; rawText: string }> {
  const res = await sendReq(env, mcpPath, {
    method: "POST",
    token,
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args }
    }
  });
  assert.equal(res.status, 200);
  const result = res.data.result as { isError?: boolean; content: Array<{ text: string }> };
  const rawText = result.content[0]?.text ?? "";
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    payload = { text: rawText };
  }
  return { isError: result.isError, payload, rawText };
}

test("enforces privilege separation across CHAOX_SYNC_TOKEN, CHAOX_MCP_TOKEN, CHAOX_MCP_READONLY_TOKEN, and legacy CHAOX_AUTH_TOKEN", async () => {
  const env = makeSegmentedEnv();
  const syncToken = env.CHAOX_SYNC_TOKEN!;
  const mcpToken = env.CHAOX_MCP_TOKEN!;
  const mcpReadOnlyToken = env.CHAOX_MCP_READONLY_TOKEN!;

  // Sync token can upload snapshots & update preferences, but gets 403 on /mcp.
  const snapRes = await sendReq(env, "/sync/sx/snapshot", {
    method: "PUT",
    token: syncToken,
    body: {
      bundleId: "ai.chaox.sx",
      appVersion: "1.2.0",
      permission: "readWrite",
      policy: {
        allowRead: true,
        allowCreate: true,
        allowUpdate: true,
        allowDelete: true,
        allowedDomains: ["projects", "expenses"],
        consentAcknowledged: true
      },
      capabilities: ["catalog", "expenses"],
      catalog: {
        timeZoneIdentifier: "Asia/Shanghai",
        summaryCurrency: "CNY",
        projects: [{ name: "Dining", currency: "CNY", supportsExpense: true }]
      }
    }
  });
  assert.equal(snapRes.status, 200);

  const syncPutPrefs = await sendReq(env, "/preferences", {
    method: "PUT",
    token: syncToken,
    body: { content: "# Prefs from iOS Sync" }
  });
  assert.equal(syncPutPrefs.status, 200);

  const syncOnMcp = await sendReq(env, "/mcp", {
    method: "POST",
    token: syncToken,
    body: { jsonrpc: "2.0", id: 1, method: "tools/list" }
  });
  assert.equal(syncOnMcp.status, 403);

  // MCP token can read GET /preferences and call /mcp, but gets 403 on all /sync/* and PUT /preferences.
  const mcpGetPrefs = await sendReq(env, "/preferences", { token: mcpToken });
  assert.equal(mcpGetPrefs.status, 200);
  assert.equal(mcpGetPrefs.data.content, "# Prefs from iOS Sync");

  for (const [method, path] of [
    ["PUT", "/sync/csteix/snapshot"],
    ["DELETE", "/sync/csteix/data"],
    ["POST", "/sync/sx/ack"],
    ["GET", "/sync/csteix/wuxu"],
    ["PUT", "/preferences"]
  ] as const) {
    const blocked = await sendReq(env, path, {
      method,
      token: mcpToken,
      body: method === "GET" ? undefined : {}
    });
    assert.equal(blocked.status, 403, `Expected 403 for MCP token on ${method} ${path}`);
  }

  const mcpCreate = await callMcp(env, mcpToken, "sx_record_expense", {
    amount: 25,
    projectName: "Dining",
    requestId: "sec-mcp-1"
  });
  assert.equal(mcpCreate.isError, undefined);
  assert.equal(mcpCreate.payload.queued, true);

  // Read-only MCP token forces readonly even if client passes ?readonly=0.
  const roList = await sendReq(env, "/mcp?readonly=0", {
    method: "POST",
    token: mcpReadOnlyToken,
    body: { jsonrpc: "2.0", id: 2, method: "tools/list" }
  });
  assert.equal(roList.status, 200);
  const roTools = (roList.data.result as { tools: Array<{ name: string }> }).tools;
  assert.ok(roTools.some((t) => t.name === "sx_list_expenses"));
  assert.ok(!roTools.some((t) => t.name === "sx_record_expense"));
  assert.ok(!roTools.some((t) => t.name === "chaox_update_preferences"));

  const roWriteCall = await callMcp(
    env,
    mcpReadOnlyToken,
    "sx_record_expense",
    { amount: 10, projectName: "Dining", requestId: "sec-ro-blocked" },
    "/mcp?readonly=0"
  );
  assert.equal(roWriteCall.isError, true);
  assert.match(roWriteCall.rawText, /not available on this scoped MCP endpoint/i);

  const roSyncBlocked = await sendReq(env, "/sync/sx/status", { token: mcpReadOnlyToken });
  assert.equal(roSyncBlocked.status, 403);

  const syncStatusSplit = await sendReq(env, "/sync/sx/status", { token: syncToken });
  assert.equal(syncStatusSplit.status, 200);
  assert.equal(syncStatusSplit.data.tokenMode, "split");

  // Legacy CHAOX_AUTH_TOKEN continues to work across both /sync/* and /mcp for zero-friction upgrades.
  const legacyToken = "legacy-full-access-token-0123456789abcdef";
  const legacyEnv: ServerEnv = {
    DB: env.DB,
    CHAOX_AUTH_TOKEN: legacyToken
  };
  const legacyStatus = await sendReq(legacyEnv, "/sync/sx/status", { token: legacyToken });
  assert.equal(legacyStatus.status, 200);
  assert.equal(legacyStatus.data.tokenMode, "legacy");
  assert.equal(
    (
      await sendReq(legacyEnv, "/mcp", {
        method: "POST",
        token: legacyToken,
        body: { jsonrpc: "2.0", id: 3, method: "tools/list" }
      })
    ).status,
    200
  );
});

test("enforces ?apps scope and per-app read policies across resources, status, pending, and cancelPending", async () => {
  const env = makeSegmentedEnv();
  const syncToken = env.CHAOX_SYNC_TOKEN!;
  const mcpToken = env.CHAOX_MCP_TOKEN!;

  // Sync SX (readable), BX (initially readable so we can queue an item, then disable BX), and CSTEIX with private Wuxu.
  await sendReq(env, "/sync/sx/snapshot", {
    method: "PUT",
    token: syncToken,
    body: {
      bundleId: "ai.chaox.sx",
      appVersion: "1.2.0",
      permission: "readWrite",
      policy: {
        allowRead: true,
        allowCreate: true,
        allowUpdate: true,
        allowDelete: true,
        allowedDomains: ["projects", "expenses"],
        consentAcknowledged: true
      },
      capabilities: ["expenses"],
      catalog: { timeZoneIdentifier: "Asia/Shanghai", summaryCurrency: "CNY", projects: [{ name: "Dining", currency: "CNY" }] }
    }
  });
  await sendReq(env, "/sync/bx/snapshot", {
    method: "PUT",
    token: syncToken,
    body: {
      bundleId: "ai.chaox.bx",
      appVersion: "1.2.0",
      permission: "readWrite",
      policy: {
        allowRead: true,
        allowCreate: true,
        allowUpdate: true,
        allowDelete: true,
        allowedDomains: ["food"],
        consentAcknowledged: true
      },
      capabilities: ["food"],
      catalog: { timeZoneIdentifier: "Asia/Shanghai", mealTypes: ["lunch"] }
    }
  });
  await sendReq(env, "/sync/csteix/snapshot", {
    method: "PUT",
    token: syncToken,
    body: {
      bundleId: "ai.chaox.csteix",
      appVersion: "1.4.0",
      permission: "readWrite",
      policy: {
        allowRead: true,
        allowCreate: true,
        allowUpdate: true,
        allowDelete: true,
        allowedDomains: ["wuxu"],
        consentAcknowledged: true
      },
      capabilities: ["wuxu"]
    }
  });

  // Create a Wuxu article, an SX pending expense, a BX pending food item, and a BX receipt.
  await callMcp(env, mcpToken, "csteix_create_wuxu", {
    slug: "private-journal",
    title: "Private Entry",
    dimensions: ["chaos"],
    bodyZh: "Secret reflection text"
  });
  await callMcp(env, mcpToken, "sx_record_expense", {
    amount: 20,
    projectName: "Dining",
    note: "Visible SX note",
    requestId: "scope-sx-pending"
  });
  await callMcp(env, mcpToken, "bx_record_food", {
    name: "Secret Meal",
    calories: 500,
    requestId: "scope-bx-pending"
  });
  await callMcp(env, mcpToken, "bx_record_food", {
    name: "Sensitive Food",
    calories: 300,
    requestId: "bx-acked-receipt"
  });
  await sendReq(env, "/sync/bx/ack", {
    method: "POST",
    token: syncToken,
    body: {
      receipts: [
        {
          schemaVersion: SCHEMA_VERSION,
          requestId: "bx-acked-receipt",
          app: "bx",
          op: "record_food",
          status: "applied",
          processedAt: "2026-11-22T10:00:00.000Z",
          summary: "Sensitive Food 300 kcal"
        }
      ]
    }
  });

  // 1) Scoped ?apps=sx hides Wuxu templates, blocks chaox://wuxu/{slug}, isolates status/pending/cancelPending.
  const templatesRes = await sendReq(env, "/mcp?apps=sx", {
    method: "POST",
    token: mcpToken,
    body: { jsonrpc: "2.0", id: 10, method: "resources/templates/list" }
  });
  assert.deepEqual(
    (templatesRes.data.result as { resourceTemplates: unknown[] }).resourceTemplates,
    []
  );

  const wuxuReadBlocked = await sendReq(env, "/mcp?apps=sx", {
    method: "POST",
    token: mcpToken,
    body: {
      jsonrpc: "2.0",
      id: 11,
      method: "resources/read",
      params: { uri: "chaox://wuxu/private-journal" }
    }
  });
  assert.match((wuxuReadBlocked.data.error as { message: string }).message, /excluded by this endpoint's 'apps' scope/i);

  const scopedPending = await callMcp(env, mcpToken, "chaox_list_pending", {}, "/mcp?apps=sx");
  assert.equal(scopedPending.payload.totalCount, 1);
  assert.equal((scopedPending.payload.items as Array<{ requestId: string }>)[0].requestId, "scope-sx-pending");

  const crossCancel = await callMcp(
    env,
    mcpToken,
    "chaox_cancel_pending",
    { requestId: "scope-bx-pending" },
    "/mcp?apps=sx"
  );
  assert.equal(crossCancel.isError, true);
  assert.match(crossCancel.rawText, /excluded by this endpoint's 'apps' scope/i);

  const crossCancelSynced = await callMcp(
    env,
    mcpToken,
    "chaox_cancel_pending",
    { requestId: "bx-acked-receipt" },
    "/mcp?apps=sx"
  );
  assert.equal(crossCancelSynced.isError, true);
  assert.doesNotMatch(crossCancelSynced.rawText, /Sensitive|applied/i);

  const scopedStatus = await callMcp(env, mcpToken, "chaox_get_status", {}, "/mcp?apps=sx");
  const scopedApps = scopedStatus.payload.apps as Record<string, unknown>;
  assert.ok("sx" in scopedApps);
  assert.ok(!("bx" in scopedApps));
  assert.ok(!("csteix" in scopedApps));
  assert.ok(!("bx" in (scopedStatus.payload.pendingInbox as Record<string, unknown>)));

  // 2) Now revoke BX read access -> even on unscoped /mcp, BX pending payloads & receipts are hidden.
  await sendReq(env, "/sync/bx/snapshot", {
    method: "PUT",
    token: syncToken,
    body: {
      bundleId: "ai.chaox.bx",
      appVersion: "1.2.0",
      permission: "disabled",
      policy: {
        allowRead: false,
        allowCreate: false,
        allowUpdate: false,
        allowDelete: false,
        allowedDomains: ["food"],
        consentAcknowledged: true
      },
      capabilities: []
    }
  });

  const unscopedPending = await callMcp(env, mcpToken, "chaox_list_pending", {});
  assert.equal(unscopedPending.payload.totalCount, 1);
  assert.equal((unscopedPending.payload.items as Array<{ requestId: string }>)[0].requestId, "scope-sx-pending");

  const bxPendingErr = await callMcp(env, mcpToken, "chaox_list_pending", { app: "bx" });
  assert.equal(bxPendingErr.isError, true);
  assert.match(bxPendingErr.rawText, /read access is disabled/i);

  const unscopedStatus = await callMcp(env, mcpToken, "chaox_get_status", {});
  const receipts = unscopedStatus.payload.recentReceipts as Array<{ app: string }>;
  assert.ok(!receipts.some((r) => r.app === "bx"));
});

test("enforces preferences caps/MCP lock, security headers, CORS allowlist, batch limit, and 500 error masking", async () => {
  const env = makeSegmentedEnv({
    CHAOX_ALLOWED_ORIGINS: "https://claude.ai",
    CHAOX_ALLOW_MCP_PREFERENCES_WRITE: "false"
  });
  const syncToken = env.CHAOX_SYNC_TOKEN!;
  const mcpToken = env.CHAOX_MCP_TOKEN!;

  // 1) Security headers & CORS allowlist.
  const healthAllowed = await sendReq(env, "/health", { origin: "https://claude.ai", token: null });
  assert.equal(healthAllowed.status, 200);
  assert.equal(healthAllowed.headers.get("Cache-Control"), "no-store");
  assert.equal(healthAllowed.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(healthAllowed.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(healthAllowed.headers.get("Access-Control-Allow-Origin"), "https://claude.ai");

  const evilOrigin = await sendReq(env, "/health", { origin: "https://evil.example", token: null });
  assert.equal(evilOrigin.status, 403);

  const nonBrowser = await sendReq(env, "/health", { token: null });
  assert.equal(nonBrowser.status, 200);
  assert.equal(nonBrowser.headers.get("Access-Control-Allow-Origin"), null);

  // 2) MCP preferences write disabled while sync token PUT /preferences stays enabled + length cap enforced.
  const listRes = await sendReq(env, "/mcp", {
    method: "POST",
    token: mcpToken,
    body: { jsonrpc: "2.0", id: 20, method: "tools/list" }
  });
  const tools = (listRes.data.result as { tools: Array<{ name: string }> }).tools;
  assert.ok(!tools.some((t) => t.name === "chaox_update_preferences"));

  const mcpPrefBlocked = await callMcp(env, mcpToken, "chaox_update_preferences", {
    append: "- Malicious injected rule"
  });
  assert.equal(mcpPrefBlocked.isError, true);
  assert.match(mcpPrefBlocked.rawText, /not available on this scoped MCP endpoint/i);

  const oversizedPref = await sendReq(env, "/preferences", {
    method: "PUT",
    token: syncToken,
    body: { content: "a".repeat(MAX_PREFERENCES_CHARS + 1) }
  });
  assert.equal(oversizedPref.status, 400);
  assert.match(String(oversizedPref.data.error), /maximum length/i);

  // 3) JSON-RPC batch size cap & empty batch guard.
  const emptyBatch = await sendReq(env, "/mcp", {
    method: "POST",
    token: mcpToken,
    body: []
  });
  assert.equal((emptyBatch.data.error as { code: number }).code, -32600);

  const oversizedBatch = await sendReq(env, "/mcp", {
    method: "POST",
    token: mcpToken,
    body: Array.from({ length: 26 }, (_, i) => ({ jsonrpc: "2.0", id: i + 1, method: "ping" }))
  });
  assert.equal((oversizedBatch.data.error as { code: number }).code, -32600);

  // 4) Mask internal SQLite/D1 errors on HTTP 500 and MCP tool calls.
  const brokenDb: SqlDatabase = {
    prepare(): SqlPreparedStatement {
      return {
        bind() {
          return this;
        },
        async first() {
          throw new Error("SQLITE_CORRUPT: internal secret table detail");
        },
        async all() {
          throw new Error("D1_ERROR: internal d1 host info");
        },
        async run() {
          throw new Error("SQLITE_BUSY: database is locked");
        }
      };
    },
    async batch() {
      throw new Error("D1_ERROR: batch failure");
    }
  };

  const brokenEnv: ServerEnv = {
    DB: brokenDb,
    CHAOX_AUTH_TOKEN: "full-token-01234567890123456789"
  };

  const origConsoleError = console.error;
  console.error = () => {};
  try {
    const brokenHttp = await sendReq(brokenEnv, "/preferences", { token: brokenEnv.CHAOX_AUTH_TOKEN! });
    assert.equal(brokenHttp.status, 500);
    assert.equal(brokenHttp.data.error, "Internal server error");
    assert.doesNotMatch(JSON.stringify(brokenHttp.data), /SQLITE_|D1_ERROR/);

    const brokenMcp = await callMcp(brokenEnv, brokenEnv.CHAOX_AUTH_TOKEN!, "chaox_get_preferences", {});
    assert.equal(brokenMcp.isError, true);
    assert.equal(brokenMcp.rawText, "Internal server error");
  } finally {
    console.error = origConsoleError;
  }
});
