import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest, isInternalError, MAX_MCP_BODY_BYTES, MAX_SYNC_BODY_BYTES } from "../app.js";
import { handleMcpRequest } from "../mcp.js";
import { isPlaceholderToken, startNodeServer } from "../node-server.js";
import { createMemoryDatabase } from "../sqlite.js";
import { ExchangeStore, MAX_PREFERENCES_CHARS } from "../store.js";
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

test("hides CSTEIX Wuxu receipts and datasetCounts.wuxu when wuxu domain or read access is disabled", async () => {
  const env = makeSegmentedEnv();
  const syncToken = env.CHAOX_SYNC_TOKEN!;
  const mcpToken = env.CHAOX_MCP_TOKEN!;

  const syncCsteix = (permission: string, allowRead: boolean, allowedDomains: string[]) =>
    sendReq(env, "/sync/csteix/snapshot", {
      method: "PUT",
      token: syncToken,
      body: {
        bundleId: "ai.chaox.csteix",
        appVersion: "1.4.0",
        permission,
        policy: {
          allowRead,
          allowCreate: allowRead,
          allowUpdate: allowRead,
          allowDelete: allowRead,
          allowedDomains,
          consentAcknowledged: true
        },
        capabilities: allowedDomains
      }
    });

  assert.equal((await syncCsteix("readWrite", true, ["wuxu", "dwell"])).status, 200);

  // Run all four Wuxu receipt-producing operations.
  assert.equal(
    (
      await callMcp(env, mcpToken, "csteix_create_wuxu", {
        slug: "secret-wuxu-entry",
        title: "Secret Wuxu Title",
        dimensions: ["ix"],
        bodyZh: "Private reflection body.",
        requestId: "wuxu-sec-create"
      })
    ).isError,
    undefined
  );
  assert.equal(
    (
      await callMcp(env, mcpToken, "csteix_update_wuxu", {
        slug: "secret-wuxu-entry",
        appendBodyZh: "More private text.",
        requestId: "wuxu-sec-update"
      })
    ).isError,
    undefined
  );
  assert.equal(
    (
      await callMcp(env, mcpToken, "csteix_delete_wuxu", {
        slug: "secret-wuxu-entry",
        requestId: "wuxu-sec-delete"
      })
    ).isError,
    undefined
  );
  assert.equal(
    (
      await callMcp(env, mcpToken, "csteix_restore_wuxu", {
        slug: "secret-wuxu-entry",
        requestId: "wuxu-sec-restore"
      })
    ).isError,
    undefined
  );

  // Initially visible when wuxu is enabled.
  const statusEnabled = await callMcp(env, mcpToken, "chaox_get_status", { app: "csteix" });
  const appsEnabled = statusEnabled.payload.apps as Record<string, { datasetCounts: Record<string, number> }>;
  assert.equal(appsEnabled.csteix.datasetCounts.wuxu, 1);
  const enabledReceipts = statusEnabled.payload.recentReceipts as Array<{ op: string }>;
  assert.equal(enabledReceipts.length, 4);

  // Exclude 'wuxu' from allowedDomains while keeping CSTEIX read enabled -> hides datasetCounts.wuxu and all Wuxu receipts.
  assert.equal((await syncCsteix("readWrite", true, ["dwell"])).status, 200);
  const statusNoWuxu = await callMcp(env, mcpToken, "chaox_get_status", { app: "csteix" });
  const appsNoWuxu = statusNoWuxu.payload.apps as Record<string, { datasetCounts: Record<string, number> }>;
  assert.equal("wuxu" in appsNoWuxu.csteix.datasetCounts, false);
  const noWuxuReceipts = statusNoWuxu.payload.recentReceipts as Array<{ op: string }>;
  assert.equal(noWuxuReceipts.length, 0);

  const directLookup = await callMcp(env, mcpToken, "chaox_get_status", {
    app: "csteix",
    requestId: "wuxu-sec-create"
  });
  assert.equal((directLookup.payload.recentReceipts as unknown[]).length, 0);

  // Disable CSTEIX read access even with 'wuxu' listed in allowedDomains -> still hidden.
  assert.equal((await syncCsteix("disabled", false, ["wuxu", "dwell"])).status, 200);
  const statusDisabled = await callMcp(env, mcpToken, "chaox_get_status", { app: "csteix" });
  const appsDisabled = statusDisabled.payload.apps as Record<string, { datasetCounts: Record<string, number> }>;
  assert.equal("wuxu" in appsDisabled.csteix.datasetCounts, false);
  assert.equal((statusDisabled.payload.recentReceipts as unknown[]).length, 0);

  // Re-enabling 'wuxu' reveals count and receipts again.
  assert.equal((await syncCsteix("readWrite", true, ["wuxu", "dwell"])).status, 200);
  const statusRestored = await callMcp(env, mcpToken, "chaox_get_status", { app: "csteix" });
  const appsRestored = statusRestored.payload.apps as Record<string, { datasetCounts: Record<string, number> }>;
  assert.equal(appsRestored.csteix.datasetCounts.wuxu, 1);
  assert.equal((statusRestored.payload.recentReceipts as unknown[]).length, 4);
});

test("strips SX credentialId and credentialName from expenses and incomes immediately when credentials scope is revoked", async () => {
  const env = makeSegmentedEnv();
  const syncToken = env.CHAOX_SYNC_TOKEN!;
  const mcpToken = env.CHAOX_MCP_TOKEN!;

  // Sync SX with 'credentials' enabled and upload expenses + incomes containing credential metadata.
  assert.equal(
    (
      await sendReq(env, "/sync/sx/snapshot", {
        method: "PUT",
        token: syncToken,
        body: {
          bundleId: "ai.chaox.sx",
          appVersion: "1.3.0",
          permission: "readWrite",
          policy: {
            allowRead: true,
            allowCreate: true,
            allowUpdate: true,
            allowDelete: true,
            allowedDomains: ["projects", "expenses", "incomes", "credentials"],
            consentAcknowledged: true
          },
          capabilities: ["projects", "expenses", "incomes", "credentials"],
          catalog: {
            timeZoneIdentifier: "Asia/Shanghai",
            summaryCurrency: "CNY",
            projects: [
              { id: "1", name: "Cloud", currency: "CNY", supportsExpense: true, supportsIncome: true }
            ]
          },
          summary: {
            timeZoneIdentifier: "Asia/Shanghai",
            summaryCurrency: "CNY",
            expense: {
              allTime: { period: "allTime", mode: "expense", currency: "CNY", netTotal: 99, recordCount: 1 }
            },
            income: {
              allTime: { period: "allTime", mode: "income", currency: "CNY", netTotal: 500, recordCount: 1 }
            }
          },
          datasets: {
            credentials: [
              {
                id: 7,
                username: "alice@example.com",
                type: "account",
                website: "https://cloud.example",
                issuer: "Cloud",
                linkCount: 1,
                links: [
                  {
                    projectId: 1,
                    projectName: "Cloud",
                    startDate: "2026-01-01T00:00:00.000Z",
                    hasStartDate: true,
                    isAutoRenew: false,
                    renewalHour: 9,
                    renewalWeekdays: 127
                  }
                ]
              }
            ],
            expenses: [
              {
                id: 101,
                projectId: 1,
                projectName: "Cloud",
                credentialId: 7,
                credentialName: "alice@example.com",
                amount: 99,
                netAmount: 99,
                refundTotal: 0,
                currency: "CNY",
                tags: [],
                notes: "Server hosting",
                paidAt: "2026-11-22T04:00:00.000Z"
              }
            ],
            incomes: [
              {
                id: 201,
                projectId: 1,
                projectName: "Cloud",
                credentialId: 7,
                credentialName: "alice@example.com",
                amount: 500,
                netAmount: 500,
                reversalTotal: 0,
                currency: "CNY",
                tags: [],
                notes: "Cloud rebate",
                receivedAt: "2026-11-22T05:00:00.000Z"
              }
            ]
          }
        }
      })
    ).status,
    200
  );

  // Queue pending expense and income bound to credential #7 while credentials scope is enabled.
  const expQueued = await callMcp(env, mcpToken, "sx_record_expense", {
    amount: 42,
    projectName: "Cloud",
    credentialId: 7,
    requestId: "cred-strip-exp-1"
  });
  assert.equal(expQueued.isError, undefined);
  assert.equal(expQueued.payload.credentialId, 7);

  const incQueued = await callMcp(env, mcpToken, "sx_record_income", {
    amount: 120,
    projectName: "Cloud",
    credentialId: 7,
    requestId: "cred-strip-inc-1"
  });
  assert.equal(incQueued.isError, undefined);
  assert.equal(incQueued.payload.credentialId, 7);

  // Before revocation, both snapshot and pending items expose credential metadata.
  const expBefore = await callMcp(env, mcpToken, "sx_list_expenses", {});
  const expBeforeItems = expBefore.payload.items as Array<Record<string, unknown>>;
  assert.equal(expBeforeItems.length, 2);
  assert.ok(expBeforeItems.every((item) => item.credentialId === 7));

  const incBefore = await callMcp(env, mcpToken, "sx_list_incomes", {});
  const incBeforeItems = incBefore.payload.items as Array<Record<string, unknown>>;
  assert.equal(incBeforeItems.length, 2);
  assert.ok(incBeforeItems.every((item) => item.credentialId === 7));

  // Revoke 'credentials' scope WITHOUT re-uploading expenses/incomes datasets.
  assert.equal(
    (
      await sendReq(env, "/sync/sx/snapshot", {
        method: "PUT",
        token: syncToken,
        body: {
          bundleId: "ai.chaox.sx",
          appVersion: "1.3.0",
          permission: "readWrite",
          policy: {
            allowRead: true,
            allowCreate: true,
            allowUpdate: true,
            allowDelete: true,
            allowedDomains: ["projects", "expenses", "incomes"],
            consentAcknowledged: true
          },
          capabilities: ["projects", "expenses", "incomes"]
        }
      })
    ).status,
    200
  );

  // After revocation, credentialId and credentialName are immediately stripped from snapshot AND pending overlays.
  const expAfter = await callMcp(env, mcpToken, "sx_list_expenses", {});
  const expAfterItems = expAfter.payload.items as Array<Record<string, unknown>>;
  assert.equal(expAfterItems.length, 2);
  for (const item of expAfterItems) {
    assert.equal("credentialId" in item, false);
    assert.equal("credentialName" in item, false);
  }

  const incAfter = await callMcp(env, mcpToken, "sx_list_incomes", {});
  const incAfterItems = incAfter.payload.items as Array<Record<string, unknown>>;
  assert.equal(incAfterItems.length, 2);
  for (const item of incAfterItems) {
    assert.equal("credentialId" in item, false);
    assert.equal("credentialName" in item, false);
  }

  // Pending inbox listings, SX summary optimistic overlays, and status requestId lookup also strip credentialId.
  const pendingAfter = await callMcp(env, mcpToken, "chaox_list_pending", { app: "sx" });
  const pendingItems = pendingAfter.payload.items as Array<{ payload: Record<string, unknown> }>;
  assert.equal(pendingItems.length, 2);
  for (const entry of pendingItems) {
    assert.equal("credentialId" in entry.payload, false);
    assert.equal("credentialName" in entry.payload, false);
  }

  const expSummaryAfter = await callMcp(env, mcpToken, "sx_get_summary", { period: "allTime", mode: "expense" });
  const expSummaryReqs = (
    expSummaryAfter.payload.optimisticOverlay as { pendingRequests: Array<{ payload: Record<string, unknown> }> }
  ).pendingRequests;
  assert.equal(expSummaryReqs.length, 1);
  assert.equal("credentialId" in expSummaryReqs[0].payload, false);

  const incSummaryAfter = await callMcp(env, mcpToken, "sx_get_summary", { period: "allTime", mode: "income" });
  const incSummaryReqs = (
    incSummaryAfter.payload.optimisticOverlay as { pendingRequests: Array<{ payload: Record<string, unknown> }> }
  ).pendingRequests;
  assert.equal(incSummaryReqs.length, 1);
  assert.equal("credentialId" in incSummaryReqs[0].payload, false);

  const statusPendingAfter = await callMcp(env, mcpToken, "chaox_get_status", {
    app: "sx",
    requestId: "cred-strip-exp-1"
  });
  const matchedPending = statusPendingAfter.payload.matchedPending as Array<{ payload: Record<string, unknown> }>;
  assert.equal(matchedPending.length, 1);
  assert.equal("credentialId" in matchedPending[0].payload, false);
});

test("enforces Web-standard body limits (413), plain JSON object validation (400), snapshot field checks, HEAD /health, dataset hardening, D1 masking, and URIError handling", async () => {
  const env = makeSegmentedEnv({
    CHAOX_ALLOWED_ORIGINS: "https://claude.ai"
  });
  const syncToken = env.CHAOX_SYNC_TOKEN!;
  const mcpToken = env.CHAOX_MCP_TOKEN!;

  // 1) HEAD /health returns 200 with empty body and identical security/CORS headers.
  const headAllowed = await handleRequest(
    new Request("https://chaox.example.com/health", {
      method: "HEAD",
      headers: { Origin: "https://claude.ai" }
    }),
    env
  );
  assert.equal(headAllowed.status, 200);
  assert.equal(await headAllowed.text(), "");
  assert.equal(headAllowed.headers.get("Cache-Control"), "no-store");
  assert.equal(headAllowed.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(headAllowed.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(headAllowed.headers.get("Access-Control-Allow-Origin"), "https://claude.ai");

  const headDenied = await handleRequest(
    new Request("https://chaox.example.com/health", {
      method: "HEAD",
      headers: { Origin: "https://evil.example" }
    }),
    env
  );
  assert.equal(headDenied.status, 403);

  // 2) Web-standard 413 body cap on /mcp (both via handleRequest and direct handleMcpRequest), /preferences, and /sync/*.
  const oversizedMcpBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "ping",
    params: { pad: "x".repeat(MAX_MCP_BODY_BYTES + 1024) }
  });
  const mcpTooLarge = await handleRequest(
    new Request("https://chaox.example.com/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mcpToken}`,
        "Content-Type": "application/json"
      },
      body: oversizedMcpBody
    }),
    env
  );
  assert.equal(mcpTooLarge.status, 413);

  const directStore = new ExchangeStore(env.DB);
  const directMcpTooLarge = await handleMcpRequest(
    new Request("https://chaox.example.com/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: oversizedMcpBody
    }),
    directStore
  );
  assert.equal(directMcpTooLarge.status, 413);

  const prefsTooLarge = await handleRequest(
    new Request("https://chaox.example.com/preferences", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${syncToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ content: "p".repeat(MAX_MCP_BODY_BYTES + 1024) })
    }),
    env
  );
  assert.equal(prefsTooLarge.status, 413);

  // Streaming > 20 MiB body on /sync/* fails with 413 without allocating the full payload.
  const oneMiBChunk = new Uint8Array(1024 * 1024).fill(97);
  let chunksEmitted = 0;
  const oversizedSyncStream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunksEmitted < 21) {
        chunksEmitted += 1;
        controller.enqueue(oneMiBChunk);
      } else {
        controller.close();
      }
    }
  });
  const syncStreamTooLarge = await handleRequest(
    new Request("https://chaox.example.com/sync/sx/snapshot", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${syncToken}`,
        "Content-Type": "application/json"
      },
      body: oversizedSyncStream,
      duplex: "half"
    } as RequestInit),
    env
  );
  assert.equal(syncStreamTooLarge.status, 413);

  const syncHeaderTooLarge = await handleRequest(
    new Request("https://chaox.example.com/sync/sx/snapshot", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${syncToken}`,
        "Content-Type": "application/json",
        "Content-Length": String(MAX_SYNC_BODY_BYTES + 1)
      },
      body: "{}"
    }),
    env
  );
  assert.equal(syncHeaderTooLarge.status, 413);

  // Raising CHAOX_MAX_BODY_BYTES above 20 MiB allows larger /sync/* snapshots while keeping /mcp and /preferences capped at 2 MiB.
  const raisedEnv: ServerEnv = {
    ...env,
    CHAOX_MAX_BODY_BYTES: String(25 * 1024 * 1024)
  };
  const largeValidSyncBody = JSON.stringify({
    bundleId: "ai.chaox.sx",
    appVersion: "1.3.0",
    permission: "readOnly",
    capabilities: ["catalog"],
    catalog: { pad: "z".repeat(MAX_SYNC_BODY_BYTES + 4096) }
  });
  const raisedSyncRes = await handleRequest(
    new Request("https://chaox.example.com/sync/sx/snapshot", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${syncToken}`,
        "Content-Type": "application/json"
      },
      body: largeValidSyncBody
    }),
    raisedEnv
  );
  assert.equal(raisedSyncRes.status, 200);

  const raisedMcpStillCapped = await handleRequest(
    new Request("https://chaox.example.com/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mcpToken}`,
        "Content-Type": "application/json"
      },
      body: oversizedMcpBody
    }),
    raisedEnv
  );
  assert.equal(raisedMcpStillCapped.status, 413);

  // Lowering CHAOX_MAX_BODY_BYTES below 2 MiB caps both /sync/* and /mcp to the lower limit.
  const loweredEnv: ServerEnv = {
    ...env,
    CHAOX_MAX_BODY_BYTES: "512"
  };
  const loweredSyncRes = await handleRequest(
    new Request("https://chaox.example.com/sync/sx/snapshot", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${syncToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ bundleId: "ai.chaox.sx", appVersion: "1.0", permission: "readOnly", capabilities: [], catalog: { pad: "a".repeat(600) } })
    }),
    loweredEnv
  );
  assert.equal(loweredSyncRes.status, 413);

  const loweredMcpRes = await handleRequest(
    new Request("https://chaox.example.com/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mcpToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "a".repeat(600) } })
    }),
    loweredEnv
  );
  assert.equal(loweredMcpRes.status, 413);

  // 3) Plain JSON object validation returns 400 (never 500) for null / array bodies on all mutating JSON endpoints.
  for (const [method, pathname] of [
    ["PUT", "/preferences"],
    ["POST", "/sync/csteix/wuxu/import"],
    ["POST", "/sync/sx/ack"],
    ["PUT", "/sync/sx/snapshot"],
    ["PUT", "/sync/sx/dataset/expenses"]
  ] as const) {
    for (const invalidBody of [null, []]) {
      const res = await sendReq(env, pathname, {
        method,
        token: syncToken,
        body: invalidBody
      });
      assert.equal(
        res.status,
        400,
        `Expected HTTP 400 for ${method} ${pathname} with body ${JSON.stringify(invalidBody)}`
      );
    }
  }

  // 4) Missing or blank bundleId / appVersion on PUT /sync/:app/snapshot returns 400 (not SQLITE_CONSTRAINT 500).
  for (const badSnapshot of [
    { appVersion: "1.0.0", permission: "readWrite", capabilities: [] },
    { bundleId: "   ", appVersion: "1.0.0", permission: "readWrite", capabilities: [] },
    { bundleId: "ai.chaox.sx", permission: "readWrite", capabilities: [] },
    { bundleId: "ai.chaox.sx", appVersion: "", permission: "readWrite", capabilities: [] }
  ]) {
    const res = await sendReq(env, "/sync/sx/snapshot", {
      method: "PUT",
      token: syncToken,
      body: badSnapshot
    });
    assert.equal(res.status, 400);
  }

  // 5) /sync/:app/dataset/:domain hardening: 405 on non-PUT, reject csteix/wuxu, enforce stored policy.
  assert.equal((await sendReq(env, "/sync/sx/dataset/expenses", { method: "GET", token: syncToken })).status, 405);
  assert.equal((await sendReq(env, "/sync/sx/dataset/expenses", { method: "DELETE", token: syncToken })).status, 405);

  const csteixWuxuDataset = await sendReq(env, "/sync/csteix/dataset/wuxu", {
    method: "PUT",
    token: syncToken,
    body: { data: [{ slug: "bad" }] }
  });
  assert.equal(csteixWuxuDataset.status, 400);
  assert.match(String(csteixWuxuDataset.data.error), /csteix_wuxu/);

  assert.equal(
    (
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
            allowedDomains: ["workouts"],
            consentAcknowledged: true
          },
          capabilities: ["workouts"]
        }
      })
    ).status,
    200
  );
  // 'exercises' is permitted whenever 'workouts' is allowed.
  assert.equal(
    (
      await sendReq(env, "/sync/bx/dataset/exercises", {
        method: "PUT",
        token: syncToken,
        body: { data: [{ id: "ex-1", key: "bench", nameZh: "卧推", nameEn: "Bench Press", group: "chest", equipment: [] }] }
      })
    ).status,
    200
  );
  // Disallowed domain 'food' is refused with 400.
  assert.equal(
    (
      await sendReq(env, "/sync/bx/dataset/food", {
        method: "PUT",
        token: syncToken,
        body: { data: [{ id: "f-1", name: "Oats" }] }
      })
    ).status,
    400
  );
  // Deleting a disallowed domain with { data: null } succeeds cleanly.
  assert.equal(
    (
      await sendReq(env, "/sync/bx/dataset/food", {
        method: "PUT",
        token: syncToken,
        body: { data: null }
      })
    ).status,
    200
  );

  // Revoking BX read access refuses subsequent dataset writes with 400.
  assert.equal(
    (
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
            allowedDomains: ["workouts"],
            consentAcknowledged: true
          },
          capabilities: []
        }
      })
    ).status,
    200
  );
  assert.equal(
    (
      await sendReq(env, "/sync/bx/dataset/workouts", {
        method: "PUT",
        token: syncToken,
        body: { data: [{ id: "w-1" }] }
      })
    ).status,
    400
  );

  // 6) Malformed percent-encoding in chaox://wuxu/... returns JSON-RPC -32602 (HTTP 200), not raw HTTP 400.
  const badPercentUri = await sendReq(env, "/mcp", {
    method: "POST",
    token: mcpToken,
    body: {
      jsonrpc: "2.0",
      id: 901,
      method: "resources/read",
      params: { uri: "chaox://wuxu/%E0%A4%A" }
    }
  });
  assert.equal(badPercentUri.status, 200);
  assert.equal((badPercentUri.data.error as { code: number }).code, -32602);

  // 7) Expanded isInternalError masks D1_EXEC_ERROR and 'no such column' on HTTP 500 and MCP calls.
  assert.equal(isInternalError(new Error("D1_EXEC_ERROR: syntax near table")), true);
  assert.equal(isInternalError(new Error("no such column: secret_col")), true);

  const d1ErrDb: SqlDatabase = {
    prepare(): SqlPreparedStatement {
      return {
        bind() {
          return this;
        },
        async first() {
          throw new Error("D1_EXEC_ERROR: no such column: internal_secret");
        },
        async all() {
          throw new Error("no such column: leaked_column_name");
        },
        async run() {
          throw new Error("D1_TYPE_ERROR: internal type error");
        }
      };
    },
    async batch() {
      throw new Error("D1_EXEC_ERROR: batch error");
    }
  };
  const d1ErrEnv: ServerEnv = {
    DB: d1ErrDb,
    CHAOX_AUTH_TOKEN: "full-token-01234567890123456789"
  };

  const origConsoleError = console.error;
  console.error = () => {};
  try {
    const httpMasked = await sendReq(d1ErrEnv, "/preferences", { token: d1ErrEnv.CHAOX_AUTH_TOKEN! });
    assert.equal(httpMasked.status, 500);
    assert.equal(httpMasked.data.error, "Internal server error");
    assert.doesNotMatch(JSON.stringify(httpMasked.data), /D1_EXEC_ERROR|no such column/i);

    const mcpMasked = await callMcp(d1ErrEnv, d1ErrEnv.CHAOX_AUTH_TOKEN!, "chaox_get_preferences", {});
    assert.equal(mcpMasked.isError, true);
    assert.equal(mcpMasked.rawText, "Internal server error");
  } finally {
    console.error = origConsoleError;
  }
});

test("node-server fails closed on startup when weak or placeholder tokens are configured", async () => {
  const placeholderValues = [
    "replace-with-random-64-char-hex-sync-token",
    "replace_with_token",
    "change-me-please",
    "changeme",
    "your-token-here",
    "your-sync-token",
    "example-token-123",
    "placeholder-value",
    "secret",
    "token"
  ];

  for (const weak of placeholderValues) {
    assert.equal(isPlaceholderToken(weak), true, `Expected '${weak}' to be detected as placeholder`);
  }

  for (const valid of [
    "node-server-test-token",
    "node-test-token-0123456789abcdef",
    "sync-token-0123456789abcdef01234567",
    "mcp-token-0123456789abcdef012345678",
    "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"
  ]) {
    assert.equal(isPlaceholderToken(valid), false, `Expected '${valid}' to be allowed`);
  }

  await assert.rejects(
    () =>
      startNodeServer({
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        authToken: "replace-with-random-64-char-hex-token",
        quiet: true
      }),
    /placeholder/i
  );
  await assert.rejects(
    () =>
      startNodeServer({
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        syncToken: "replace-with-random-64-char-hex-sync-token",
        mcpToken: "mcp-token-0123456789abcdef012345678",
        quiet: true
      }),
    /CHAOX_SYNC_TOKEN/
  );
  await assert.rejects(
    () =>
      startNodeServer({
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        syncToken: "sync-token-0123456789abcdef01234567",
        mcpToken: "changeme",
        quiet: true
      }),
    /CHAOX_MCP_TOKEN/
  );
  await assert.rejects(
    () =>
      startNodeServer({
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        mcpReadOnlyToken: "secret",
        quiet: true
      }),
    /CHAOX_MCP_READONLY_TOKEN/
  );
});
