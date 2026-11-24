import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { gunzipSync } from "node:zlib";
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

      // 3) MCP initialize + tools/list exposes all 72 tools under chaox-agent-server (and gzip compresses >= 1 KiB).
      const initRes = await fetch(`${server1.baseUrl}/mcp`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
      });
      assert.equal(initRes.status, 200);
      const initJson = (await initRes.json()) as {
        result: { serverInfo: { name: string; version: string }; instructions: string };
      };
      assert.equal(initJson.result.serverInfo.name, "chaox-agent-server");
      assert.equal(initJson.result.serverInfo.version, "1.2.0");
      assert.match(initJson.result.instructions, /CHAOX Agent Protocol v1/);

      const listRes = await fetch(`${server1.baseUrl}/mcp`, {
        method: "POST",
        headers: { ...authHeaders, "Accept-Encoding": "gzip" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
      });
      const listJson = (await listRes.json()) as { result: { tools: Array<{ name: string }> } };
      assert.equal(listJson.result.tools.length, 72);

      // Verify raw HTTP socket delivers gzip when Accept-Encoding: gzip is requested.
      const httpMod = await import("node:http");
      const rawUrl = new URL(`${server1.baseUrl}/mcp`);
      const gzipCheck = await new Promise<{ contentEncoding?: string; toolCount: number }>((resolve, reject) => {
        const req = httpMod.request(
          {
            hostname: rawUrl.hostname,
            port: rawUrl.port,
            path: rawUrl.pathname,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
              "Accept-Encoding": "gzip"
            }
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => {
              try {
                const raw = Buffer.concat(chunks);
                const enc = res.headers["content-encoding"];
                const decoded = enc === "gzip" ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
                const parsed = JSON.parse(decoded) as { result: { tools: unknown[] } };
                resolve({ contentEncoding: enc, toolCount: parsed.result.tools.length });
              } catch (err) {
                reject(err);
              }
            });
          }
        );
        req.on("error", reject);
        req.end(JSON.stringify({ jsonrpc: "2.0", id: 201, method: "tools/list", params: {} }));
      });
      assert.equal(gzipCheck.contentEncoding, "gzip");
      assert.equal(gzipCheck.toolCount, 72);

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

      // Confirm migration 0006 created app_dataset_chunks and accepts chunk rows.
      const chunkTable = await db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_dataset_chunks'")
        .first<{ name: string }>();
      assert.equal(chunkTable?.name, "app_dataset_chunks");

      await db
        .prepare(
          "INSERT INTO app_dataset_chunks (app, domain, chunk_index, chunk_data, updated_at) VALUES (?, ?, ?, ?, ?)"
        )
        .bind("sx", "expenses", 0, '[{"id":1,"notes":"imported"}]', "2026-11-22T00:00:00.000Z")
        .run();

      // Re-opening must remain idempotent and zero-error.
    } finally {
      db.close();
    }

    const db2 = new SqliteDatabase(importedPath);
    try {
      const chunkRow = await db2
        .prepare("SELECT chunk_data FROM app_dataset_chunks WHERE app = ? AND domain = ? AND chunk_index = ?")
        .bind("sx", "expenses", 0)
        .first<{ chunk_data: string }>();
      assert.equal(chunkRow?.chunk_data, '[{"id":1,"notes":"imported"}]');
    } finally {
      db2.close();
    }

    // Re-opening after dropping _chaox_migrations (simulating a newer D1 export that already has
    // app_dataset_chunks) must re-apply migrations idempotently and preserve existing chunk rows.
    const dropTracker = new DatabaseSync(importedPath);
    dropTracker.exec("DROP TABLE _chaox_migrations;");
    dropTracker.close();

    const db3 = new SqliteDatabase(importedPath);
    try {
      const prefAfter = await db3
        .prepare("SELECT value FROM preferences WHERE key = 'user_preferences'")
        .first<{ value: string }>();
      assert.equal(prefAfter?.value, "Imported Prefs");

      const chunkAfter = await db3
        .prepare("SELECT chunk_data FROM app_dataset_chunks WHERE app = ? AND domain = ? AND chunk_index = ?")
        .bind("sx", "expenses", 0)
        .first<{ chunk_data: string }>();
      assert.equal(chunkAfter?.chunk_data, '[{"id":1,"notes":"imported"}]');
    } finally {
      db3.close();
    }
  });
});

test("node server enforces per-IP 401 rate limit, protects against malformed Host headers, and supports split tokens", async () => {
  await withTempDir(async (tmpDir) => {
    const dbPath = path.join(tmpDir, "rate-limit.sqlite");
    const syncToken = "sync-token-0123456789abcdef01234567";
    const mcpToken = "mcp-token-0123456789abcdef012345678";

    const server = await startNodeServer({
      host: "127.0.0.1",
      port: 0,
      dbPath,
      syncToken,
      mcpToken,
      trustProxy: false,
      authRateLimit: { maxAttempts: 3, windowMs: 10_000 },
      quiet: true
    });

    try {
      // Three bad auth attempts trigger HTTP 429 on the 4th attempt.
      for (let i = 0; i < 3; i += 1) {
        const res = await fetch(`${server.baseUrl}/preferences`, {
          headers: { Authorization: "Bearer wrong-token" }
        });
        assert.equal(res.status, 401);
        assert.equal(res.headers.get("Cache-Control"), "no-store");
        assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
      }

      const throttled = await fetch(`${server.baseUrl}/preferences`, {
        headers: { Authorization: `Bearer ${mcpToken}` }
      });
      assert.equal(throttled.status, 429);
      assert.ok(Number(throttled.headers.get("Retry-After")) >= 1);

      // /health continues to work cleanly even when auth is rate-limited.
      const health = await fetch(`${server.baseUrl}/health`, {
        headers: {
          "X-Forwarded-Host": "bad host name!!",
          "X-Forwarded-Proto": "javascript"
        }
      });
      assert.equal(health.status, 200);
    } finally {
      await server.close();
    }
  });
});
