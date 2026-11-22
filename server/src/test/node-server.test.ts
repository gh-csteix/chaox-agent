import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { startNodeServer } from "../node-server.js";
import { SqliteDatabase } from "../sqlite.js";
import { SCHEMA_VERSION } from "../types.js";

function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "chaox-node-server-"));
  return fn(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

test("boots standalone Node HTTP server with persistent SQLite, enforces auth, handles concurrency & restarts cleanly", async () => {
  await withTempDir(async (tmpDir) => {
    const dbPath = path.join(tmpDir, "nested", "chaox-agent.sqlite");
    const token = "node-server-test-token";

    const server1 = await startNodeServer({
      host: "127.0.0.1",
      port: 0,
      dbPath,
      authToken: token,
      maxBodyBytes: 64 * 1024,
      quiet: true
    });

    try {
      // 1) /health works without Bearer token and reports sqlite mode.
      const healthRes = await fetch(`${server1.baseUrl}/health`);
      assert.equal(healthRes.status, 200);
      const health = (await healthRes.json()) as Record<string, unknown>;
      assert.equal(health.status, "ok");
      assert.equal(health.schemaVersion, SCHEMA_VERSION);
      assert.equal(health.mode, "sqlite");

      // 2) Auth check rejects missing or wrong token.
      const unauth = await fetch(`${server1.baseUrl}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      });
      assert.equal(unauth.status, 401);

      const authHeaders = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      };

      // 3) MCP initialize + tools/list exposes all 67 tools under chaox-agent-server.
      const initRes = await fetch(`${server1.baseUrl}/mcp`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
      });
      assert.equal(initRes.status, 200);
      const initJson = (await initRes.json()) as {
        result: { serverInfo: { name: string }; instructions: string };
      };
      assert.equal(initJson.result.serverInfo.name, "chaox-agent-server");
      assert.match(initJson.result.instructions, /CHAOX Agent Protocol v1/);

      const listRes = await fetch(`${server1.baseUrl}/mcp`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
      });
      const listJson = (await listRes.json()) as { result: { tools: Array<{ name: string }> } };
      assert.equal(listJson.result.tools.length, 67);

      // 4) Upload SX snapshot, queue expense, check status backend=sqlite, and drain inbox.
      const snapRes = await fetch(`${server1.baseUrl}/sync/sx/snapshot`, {
        method: "PUT",
        headers: authHeaders,
        body: JSON.stringify({
          bundleId: "ai.chaox.sx",
          appVersion: "1.2.0",
          permission: "readWrite",
          policy: {
            allowRead: true,
            allowCreate: true,
            allowUpdate: true,
            allowDelete: true,
            allowedDomains: ["projects", "expenses", "incomes", "tags", "slogans"],
            consentAcknowledged: true
          },
          capabilities: ["catalog", "summary", "record_expense"],
          catalog: {
            timeZoneIdentifier: "Asia/Shanghai",
            summaryCurrency: "CNY",
            supportedCurrencies: ["CNY", "USD"],
            projects: [{ name: "EatingDrinkingOut", currency: "CNY", supportsExpense: true, supportsIncome: false }]
          },
          summary: {
            summaryCurrency: "CNY",
            expense: { today: { period: "today", mode: "expense", currency: "CNY", netTotal: 0, recordCount: 0 } }
          }
        })
      });
      assert.equal(snapRes.status, 200);

      const statusRes = await fetch(`${server1.baseUrl}/mcp`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "chaox_get_status", arguments: {} }
        })
      });
      const statusJson = (await statusRes.json()) as { result: { content: Array<{ text: string }> } };
      const statusData = JSON.parse(statusJson.result.content[0].text) as { backend: string };
      assert.equal(statusData.backend, "sqlite");

      const expRes = await fetch(`${server1.baseUrl}/mcp`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "sx_record_expense",
            arguments: {
              amount: 28,
              projectName: "EatingDrinkingOut",
              date: "2026-11-22-12",
              note: "Lunch noodle",
              requestId: "node-srv-exp-1"
            }
          }
        })
      });
      assert.equal(expRes.status, 200);
      const expJson = (await expRes.json()) as { result: { content: Array<{ text: string }> } };
      const expPayload = JSON.parse(expJson.result.content[0].text) as {
        queued: boolean;
        resolvedLocalTime?: { displayDate: string };
      };
      assert.equal(expPayload.queued, true);
      assert.equal(expPayload.resolvedLocalTime?.displayDate, "2026-11-22-12");

      // 5) Parallel batch writes (ack + multiple CSTEIX snapshot updates) never collide in SQLite transactions.
      const parallelWrites = await Promise.all([
        fetch(`${server1.baseUrl}/sync/csteix/snapshot`, {
          method: "PUT",
          headers: authHeaders,
          body: JSON.stringify({
            bundleId: "ai.chaox.csteix",
            appVersion: "1.4",
            permission: "readWrite",
            capabilities: ["wuxu"],
            datasets: { dwell: [{ id: "d1", durationSeconds: 100 }] }
          })
        }),
        fetch(`${server1.baseUrl}/sync/sx/ack`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({
            receipts: [
              {
                schemaVersion: SCHEMA_VERSION,
                requestId: "node-srv-exp-1",
                app: "sx",
                op: "record_expense",
                status: "applied",
                processedAt: "2026-11-22T04:05:00.000Z",
                recordId: "1001"
              }
            ]
          })
        }),
        fetch(`${server1.baseUrl}/preferences`, {
          method: "PUT",
          headers: authHeaders,
          body: JSON.stringify({ content: "# Persisted Preferences\n- Default currency: CNY" })
        })
      ]);
      for (const r of parallelWrites) {
        assert.equal(r.status, 200);
      }

      // 6) Oversized body is rejected with HTTP 413.
      const hugeBody = JSON.stringify({ content: "x".repeat(70 * 1024) });
      const tooLargeRes = await fetch(`${server1.baseUrl}/preferences`, {
        method: "PUT",
        headers: authHeaders,
        body: hugeBody
      });
      assert.equal(tooLargeRes.status, 413);
    } finally {
      await server1.close();
    }

    // 7) Reboot a brand-new Node server against the exact same on-disk SQLite file:
    // migrations must stay idempotent and all committed state must survive restart.
    const server2 = await startNodeServer({
      host: "127.0.0.1",
      port: 0,
      dbPath,
      authToken: token,
      quiet: true
    });
    try {
      const authHeaders = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      };

      const prefsRes = await fetch(`${server2.baseUrl}/preferences`, { headers: authHeaders });
      assert.equal(prefsRes.status, 200);
      const prefs = (await prefsRes.json()) as { content: string };
      assert.match(prefs.content, /Persisted Preferences/);

      const statusRes = await fetch(`${server2.baseUrl}/sync/sx/status`, { headers: authHeaders });
      assert.equal(statusRes.status, 200);
      const status = (await statusRes.json()) as {
        configured: boolean;
        pendingInboxCount: number;
        recentReceipts: Array<{ requestId: string; recordId?: string }>;
      };
      assert.equal(status.configured, true);
      assert.equal(status.pendingInboxCount, 0);
      assert.equal(status.recentReceipts[0]?.requestId, "node-srv-exp-1");
      assert.equal(status.recentReceipts[0]?.recordId, "1001");
    } finally {
      await server2.close();
    }
  });
});

test("SqliteDatabase cleanly opens and migrates a D1-exported SQLite file without _chaox_migrations", async () => {
  await withTempDir(async (tmpDir) => {
    const importedPath = path.join(tmpDir, "imported-d1.sqlite");

    // Simulate a database exported from Cloudflare D1 that already has app_state.policy_json
    // and app_dataset/csteix_wuxu tables, plus existing data, without _chaox_migrations.
    const seed = new DatabaseSync(importedPath);
    seed.exec(`
      CREATE TABLE app_state (
        app TEXT PRIMARY KEY,
        bundle_id TEXT NOT NULL,
        app_version TEXT NOT NULL,
        permission TEXT NOT NULL DEFAULT 'disabled',
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        catalog_json TEXT,
        summary_json TEXT,
        last_sync_at TEXT,
        updated_at TEXT NOT NULL,
        policy_json TEXT
      );
      CREATE TABLE inbox (
        request_id TEXT PRIMARY KEY,
        app TEXT NOT NULL,
        op TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        source_json TEXT,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE receipts (
        request_id TEXT PRIMARY KEY,
        app TEXT NOT NULL,
        op TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        status TEXT NOT NULL,
        processed_at TEXT NOT NULL,
        record_id TEXT,
        stable_id TEXT,
        summary TEXT,
        details_json TEXT,
        error_code TEXT,
        error_message TEXT
      );
      CREATE TABLE preferences (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO preferences (key, value, updated_at) VALUES ('user_preferences', 'Imported Prefs', '2026-11-22T00:00:00.000Z');
    `);
    seed.close();

    const db = new SqliteDatabase(importedPath);
    try {
      const pref = await db
        .prepare("SELECT value FROM preferences WHERE key = 'user_preferences'")
        .first<{ value: string }>();
      assert.equal(pref?.value, "Imported Prefs");

      // Re-opening must remain idempotent and zero-error.
    } finally {
      db.close();
    }

    const db2 = new SqliteDatabase(importedPath);
    db2.close();
  });
});
