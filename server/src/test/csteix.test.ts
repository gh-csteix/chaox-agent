import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../app.js";
import { createMemoryDatabase, SqliteDatabase } from "../sqlite.js";
import { SCHEMA_VERSION, ServerEnv } from "../types.js";

function makeEnv(token = "secret-csteix-token"): { env: ServerEnv; db: SqliteDatabase } {
  const db = createMemoryDatabase();
  return {
    db,
    env: {
      DB: db,
      CHAOX_AUTH_TOKEN: token
    }
  };
}

async function callJson(
  env: ServerEnv,
  pathname: string,
  options: {
    method?: string;
    token?: string | null;
    body?: unknown;
  } = {}
): Promise<{ status: number; data: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (options.token !== null) {
    headers.Authorization = `Bearer ${options.token ?? env.CHAOX_AUTH_TOKEN}`;
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
    data: text ? (JSON.parse(text) as Record<string, unknown>) : {}
  };
}

async function callMcpTool(
  env: ServerEnv,
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ isError: boolean; text: string; parsed: Record<string, unknown> | null }> {
  const res = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args }
    }
  });
  assert.equal(res.status, 200);
  const result = res.data.result as { isError?: boolean; content: Array<{ text: string }> };
  const text = result.content[0]?.text ?? "";
  let parsed: Record<string, unknown> | null = null;
  if (!result.isError) {
    parsed = JSON.parse(text) as Record<string, unknown>;
  }
  return { isError: Boolean(result.isError), text, parsed };
}

async function connectCsteix(
  env: ServerEnv,
  overrides: {
    permission?: string;
    policy?: Record<string, unknown>;
    summary?: unknown;
    datasets?: Record<string, unknown>;
  } = {}
) {
  const res = await callJson(env, "/sync/csteix/snapshot", {
    method: "PUT",
    body: {
      bundleId: "ai.chaox.csteix",
      appVersion: "1.4",
      permission: overrides.permission ?? "readWrite",
      policy: overrides.policy ?? {
        allowRead: true,
        allowCreate: true,
        allowUpdate: true,
        allowDelete: true,
        allowedDomains: ["wuxu", "dwell", "meditation", "marks"],
        consentAcknowledged: true
      },
      capabilities: ["wuxu", "dwell", "meditation", "marks"],
      summary: overrides.summary ?? {
        generatedAt: "2026-11-22T06:00:00.000Z",
        totalDwellSeconds: 1800,
        topPlace: "Haidian, Beijing"
      },
      datasets: overrides.datasets ?? {
        dwell: [
          {
            id: "dw-1",
            dayKey: "2026-11-22",
            startedAt: "2026-11-22T01:00:00.000Z",
            pillar: "existence",
            durationSeconds: 900,
            placeName: "Haidian, Beijing",
            spot: { en: "PKU", "zh-Hans": "北大" },
            latitude: 39.99,
            longitude: 116.31
          },
          {
            id: "dw-2",
            dayKey: "2026-11-21",
            startedAt: "2026-11-21T03:00:00.000Z",
            pillar: "chaos",
            durationSeconds: 300,
            placeName: "Chaoyang, Beijing"
          }
        ],
        meditation: [
          {
            id: "med-1",
            dayKey: "2026-11-22",
            startedAt: "2026-11-22T02:00:00.000Z",
            pillar: "ix",
            durationSeconds: 600,
            place: "Library",
            locationName: "Second Teaching Building"
          }
        ],
        marks: [
          {
            id: "mk-1",
            dayKey: "2026-11-22",
            occurredAt: "2026-11-22T02:15:00.000Z",
            kind: "ripple",
            pillar: "existence",
            count: 3,
            placeName: "Haidian"
          },
          {
            id: "mk-2",
            dayKey: "2026-11-21",
            occurredAt: "2026-11-21T14:00:00.000Z",
            kind: "meteor",
            pillar: "spacetime",
            count: 2,
            placeName: "Haidian"
          }
        ]
      }
    }
  });
  assert.equal(res.status, 200);
}

test("enforces CSTEIX read-only domains, strips places unless opted in, and summarizes wuxu + snapshots", async () => {
  const { env } = makeEnv();
  await connectCsteix(env);

  // Create one article so summary and chaox_get_status reflect live active wuxu count.
  const created = await callMcpTool(env, "csteix_create_wuxu", {
    slug: "bare-treetops",
    title: "Bare Treetops",
    dimensions: ["existence"],
    writtenAt: "2026-11-21 19:42",
    timezone: "Asia/Shanghai",
    bodyZh: "Intro paragraph.\n\n## Section One\n\nBody.\n\n## 留下来的几句\n\nLine one.\n\nLine two.\n\nLine three.",
    rawNotes: "Winter treetops look like neural networks."
  });
  assert.equal(created.isError, false);

  // Status includes csteix with live datasetCounts.wuxu alongside read-only domains.
  const statusRes = await callMcpTool(env, "chaox_get_status", { app: "csteix" });
  assert.equal(statusRes.isError, false);
  const apps = statusRes.parsed?.apps as Record<string, { datasetCounts: Record<string, number> }>;
  assert.equal(apps.csteix.datasetCounts.wuxu, 1);
  assert.equal(apps.csteix.datasetCounts.dwell, 2);
  assert.equal(apps.csteix.datasetCounts.meditation, 1);
  assert.equal(apps.csteix.datasetCounts.marks, 2);

  // Default policy excludes 'places' -> place/location/coordinate keys stripped from dwell, meditation, marks.
  const dwellRes = await callMcpTool(env, "csteix_list_dwell", { pillar: "existence" });
  assert.equal(dwellRes.isError, false);
  assert.equal(dwellRes.parsed?.readOnly, true);
  assert.equal(dwellRes.parsed?.placesIncluded, false);
  const dwellItems = dwellRes.parsed?.items as Array<Record<string, unknown>>;
  assert.equal(dwellItems.length, 1);
  assert.equal(dwellItems[0].id, "dw-1");
  assert.equal(dwellItems[0].placeName, undefined);
  assert.equal(dwellItems[0].spot, undefined);
  assert.equal(dwellItems[0].latitude, undefined);
  assert.equal(dwellItems[0].longitude, undefined);

  const medRes = await callMcpTool(env, "csteix_list_meditation", { from: "2026-11-22", to: "2026-11-22" });
  assert.equal(medRes.isError, false);
  assert.equal(medRes.parsed?.readOnly, true);
  assert.equal(medRes.parsed?.placesIncluded, false);
  const medItems = medRes.parsed?.items as Array<Record<string, unknown>>;
  assert.equal(medItems.length, 1);
  assert.equal(medItems[0].place, undefined);
  assert.equal(medItems[0].locationName, undefined);

  const marksRes = await callMcpTool(env, "csteix_list_marks", { kind: "meteor" });
  assert.equal(marksRes.isError, false);
  assert.equal(marksRes.parsed?.readOnly, true);
  const markItems = marksRes.parsed?.items as Array<Record<string, unknown>>;
  assert.equal(markItems.length, 1);
  assert.equal(markItems[0].id, "mk-2");
  assert.equal(markItems[0].placeName, undefined);

  // Summary aggregates wuxu + dwell + meditation + marks cleanly.
  const summaryRes = await callMcpTool(env, "csteix_get_summary", {});
  assert.equal(summaryRes.isError, false);
  assert.equal(summaryRes.parsed?.placesIncluded, false);
  const wuxuSum = summaryRes.parsed?.wuxu as { totalCount: number; byDimension: Record<string, number> };
  assert.equal(wuxuSum.totalCount, 1);
  assert.equal(wuxuSum.byDimension.existence, 1);
  const dwellSum = summaryRes.parsed?.dwell as { totalSeconds: number; readOnly: boolean };
  assert.equal(dwellSum.readOnly, true);
  assert.equal(dwellSum.totalSeconds, 1200);
  const marksSum = summaryRes.parsed?.marks as { totalCount: number; byKind: Record<string, number> };
  assert.equal(marksSum.totalCount, 5);
  assert.equal(marksSum.byKind.ripple, 3);
  assert.equal(marksSum.byKind.meteor, 2);

  // Opt-in 'places' reveals place fields on dwell and meditation.
  await connectCsteix(env, {
    policy: {
      allowRead: true,
      allowCreate: true,
      allowUpdate: true,
      allowDelete: true,
      allowedDomains: ["wuxu", "dwell", "meditation", "marks", "places"],
      consentAcknowledged: true
    }
  });
  const dwellWithPlaces = await callMcpTool(env, "csteix_list_dwell", { pillar: "existence" });
  assert.equal(dwellWithPlaces.parsed?.placesIncluded, true);
  const dwellPlaceItems = dwellWithPlaces.parsed?.items as Array<Record<string, unknown>>;
  assert.equal(dwellPlaceItems[0].placeName, "Haidian, Beijing");

  // Toggling allowRead off clears app_dataset while preserving csteix_wuxu articles!
  await connectCsteix(env, {
    permission: "disabled",
    policy: {
      allowRead: false,
      allowCreate: false,
      allowUpdate: false,
      allowDelete: false,
      allowedDomains: ["wuxu", "dwell", "meditation", "marks"],
      consentAcknowledged: true
    }
  });
  const blockedRead = await callMcpTool(env, "csteix_list_wuxu", {});
  assert.equal(blockedRead.isError, true);

  // Disabled read also hides datasetCounts.wuxu and Wuxu receipts in chaox_get_status.
  const disabledStatus = await callMcpTool(env, "chaox_get_status", { app: "csteix" });
  assert.equal(disabledStatus.isError, false);
  const disabledApps = disabledStatus.parsed?.apps as Record<string, { datasetCounts: Record<string, number> }>;
  assert.equal("wuxu" in disabledApps.csteix.datasetCounts, false);
  assert.equal((disabledStatus.parsed?.recentReceipts as unknown[]).length, 0);

  // Re-enabling read confirms the wuxu article survived intact while read-only dwell dataset was pruned.
  await connectCsteix(env, {
    datasets: {}
  });
  const afterReenableWuxu = await callMcpTool(env, "csteix_list_wuxu", {});
  assert.equal(afterReenableWuxu.isError, false);
  assert.equal((afterReenableWuxu.parsed?.items as unknown[]).length, 1);
  const afterReenableDwell = await callMcpTool(env, "csteix_list_dwell", {});
  assert.equal(afterReenableDwell.parsed?.datasetUploaded, false);
});

test("supports full Wuxu CRUD, idempotency, revision conflict, append, 30-day Trash/restore, and search", async () => {
  const { env, db } = makeEnv();
  await connectCsteix(env);

  // Create article with local timestamp + Chinese leaving lines.
  const created = await callMcpTool(env, "csteix_create_wuxu", {
    slug: "quiet-morning",
    title: "Quiet Morning",
    titleEn: "A Quiet Morning",
    dimensions: ["chaos", "ix"],
    writtenAt: "2026-11-22 00:30",
    timezone: "Asia/Shanghai",
    bodyZh: "Opening paragraph.\n\n## Morning Light\n\nDetails here.\n\n## 留下来的几句\n\nFirst line stayed.\n\nSecond line stayed.\n\nThird line stayed.",
    bodyEn: "Opening in English.\n\n## Morning Light\n\nDetails.",
    rawNotes: "Spoken note about coffee steam at midnight.",
    requestId: "wuxu-req-create-1",
    client: "unit-test"
  });
  assert.equal(created.isError, false);
  assert.equal(created.parsed?.applied, true);
  const article = created.parsed?.article as Record<string, unknown>;
  assert.equal(article.revision, 1);
  assert.equal(article.writtenAt, "2026-11-21T16:30:00.000Z");

  // Replaying same requestId is idempotent and returns alreadyProcessed receipt.
  const duplicate = await callMcpTool(env, "csteix_create_wuxu", {
    slug: "quiet-morning",
    title: "Quiet Morning",
    dimensions: ["ix"],
    bodyZh: "Should not overwrite",
    requestId: "wuxu-req-create-1"
  });
  assert.equal(duplicate.isError, false);
  assert.equal(duplicate.parsed?.applied, false);
  assert.equal(duplicate.parsed?.alreadyProcessed, true);

  // Search matches rawNotes & local timezone date ('2026-11-22' in Asia/Shanghai even though UTC is Nov 21 16:30!).
  const listed = await callMcpTool(env, "csteix_list_wuxu", {
    from: "2026-11-22",
    to: "2026-11-22",
    dimension: "ix",
    query: "coffee steam",
    hasRaw: true,
    hasEn: true
  });
  assert.equal(listed.isError, false);
  const listItems = listed.parsed?.items as Array<Record<string, unknown>>;
  assert.equal(listItems.length, 1);
  assert.equal(listItems[0].slug, "quiet-morning");
  assert.equal(listItems[0].localDate, "2026-11-22");
  assert.equal(listItems[0].bodyZh, undefined); // bodies omitted by default
  assert.deepEqual(listItems[0].headings, ["Morning Light", "留下来的几句"]);
  assert.deepEqual(listItems[0].leavingLines, [
    "First line stayed.",
    "Second line stayed.",
    "Third line stayed."
  ]);

  // Same-day multi-pass append increments revision and preserves existing body + rawNotes.
  const appended = await callMcpTool(env, "csteix_update_wuxu", {
    slug: "quiet-morning",
    expectedRevision: 1,
    appendBodyZh: "## Evening Walk\n\nAdded in the evening.",
    appendRawNotes: "Evening walk note.",
    requestId: "wuxu-req-upd-1"
  });
  assert.equal(appended.isError, false);
  const updatedArticle = appended.parsed?.article as Record<string, unknown>;
  assert.equal(updatedArticle.revision, 2);
  assert.match(String(updatedArticle.bodyZh), /Opening paragraph\./);
  assert.match(String(updatedArticle.bodyZh), /## Evening Walk/);
  assert.match(String(updatedArticle.rawNotes), /coffee steam/);
  assert.match(String(updatedArticle.rawNotes), /Evening walk note\./);

  // Stale expectedRevision fails cleanly with conflict error.
  const conflict = await callMcpTool(env, "csteix_update_wuxu", {
    slug: "quiet-morning",
    expectedRevision: 1,
    title: "Stale Title"
  });
  assert.equal(conflict.isError, true);
  assert.match(conflict.text, /Revision conflict/);

  // Combining bodyZh and appendBodyZh fails cleanly.
  const badAppend = await callMcpTool(env, "csteix_update_wuxu", {
    slug: "quiet-morning",
    bodyZh: "Replace",
    appendBodyZh: "Append"
  });
  assert.equal(badAppend.isError, true);

  // Soft-delete hides article from default list, keeps visible with includeDeleted, increments revision.
  const deleted = await callMcpTool(env, "csteix_delete_wuxu", {
    slug: "quiet-morning",
    requestId: "wuxu-req-del-1"
  });
  assert.equal(deleted.isError, false);
  assert.equal(deleted.parsed?.softDeleted, true);
  assert.equal((deleted.parsed?.article as Record<string, unknown>).revision, 3);

  const listActive = await callMcpTool(env, "csteix_list_wuxu", {});
  assert.equal((listActive.parsed?.items as unknown[]).length, 0);

  const listWithDeleted = await callMcpTool(env, "csteix_list_wuxu", { includeDeleted: true });
  assert.equal((listWithDeleted.parsed?.items as unknown[]).length, 1);

  // Editing a soft-deleted article is rejected until restored.
  const editDeleted = await callMcpTool(env, "csteix_update_wuxu", {
    slug: "quiet-morning",
    title: "Blocked"
  });
  assert.equal(editDeleted.isError, true);

  // Restoring within 30 days clears deletedAt and bumps revision to 4.
  const restored = await callMcpTool(env, "csteix_restore_wuxu", {
    slug: "quiet-morning",
    requestId: "wuxu-req-res-1"
  });
  assert.equal(restored.isError, false);
  assert.equal(restored.parsed?.restored, true);
  assert.equal((restored.parsed?.article as Record<string, unknown>).revision, 4);
  assert.equal((restored.parsed?.article as Record<string, unknown>).deletedAt, null);

  // All 4 immediate mutations emitted applied receipts visible on /sync/csteix/status.
  const syncStatus = await callJson(env, "/sync/csteix/status?limit=10");
  assert.equal(syncStatus.status, 200);
  const receipts = syncStatus.data.recentReceipts as Array<{ op: string; status: string }>;
  assert.equal(receipts.length, 4);
  assert.ok(receipts.every((r) => r.status === "applied"));

  // Expired Trash (> 30 days) blocks restore.
  await callMcpTool(env, "csteix_delete_wuxu", { slug: "quiet-morning" });
  const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  await db
    .prepare("UPDATE csteix_wuxu SET deleted_at = ? WHERE slug = ?")
    .bind(thirtyOneDaysAgo, "quiet-morning")
    .run();
  const expiredRestore = await callMcpTool(env, "csteix_restore_wuxu", { slug: "quiet-morning" });
  assert.equal(expiredRestore.isError, true);
  assert.match(expiredRestore.text, /30-day Trash/);
});

test("enforces CSTEIX granular permission policy on Wuxu mutations", async () => {
  const { env } = makeEnv();
  await connectCsteix(env, {
    permission: "appendOnly",
    policy: {
      allowRead: true,
      allowCreate: true,
      allowUpdate: false,
      allowDelete: false,
      allowedDomains: ["wuxu", "dwell", "meditation", "marks"],
      consentAcknowledged: true
    }
  });

  const created = await callMcpTool(env, "csteix_create_wuxu", {
    slug: "policy-check",
    title: "Policy Check",
    dimensions: ["spacetime"],
    bodyZh: "Allowed under appendOnly."
  });
  assert.equal(created.isError, false);

  const blockedUpdate = await callMcpTool(env, "csteix_update_wuxu", {
    slug: "policy-check",
    title: "Blocked"
  });
  assert.equal(blockedUpdate.isError, true);

  const blockedDelete = await callMcpTool(env, "csteix_delete_wuxu", {
    slug: "policy-check"
  });
  assert.equal(blockedDelete.isError, true);
});

test("supports idempotent /sync/csteix/wuxu/import before phone connects, delta sync, and full cloud wipe", async () => {
  const { env, db } = makeEnv();

  // Seed via POST /sync/csteix/wuxu/import before app_state('csteix') exists.
  const firstImport = await callJson(env, "/sync/csteix/wuxu/import", {
    method: "POST",
    body: {
      articles: [
        {
          slug: "first-note",
          title: "First Note",
          dimensions: ["chaos"],
          writtenAt: "2026-11-13T10:49:00.000Z",
          timezone: "Asia/Shanghai",
          bodyZh: "First body."
        },
        {
          slug: "second-note",
          title: "Second Note",
          titleEn: "Second Note EN",
          dimensions: ["existence", "ix"],
          writtenAt: "2026-11-21T11:42:00.000Z",
          timezone: "Asia/Shanghai",
          bodyZh: "Second body.",
          bodyEn: "Second body EN.",
          rawNotes: "Raw note."
        }
      ]
    }
  });
  assert.equal(firstImport.status, 200);
  assert.equal(firstImport.data.inserted, 2);
  assert.equal(firstImport.data.updated, 0);
  assert.equal(firstImport.data.unchanged, 0);

  // Importing did NOT create or alter app_state('csteix').
  const statusBeforeConnect = await callJson(env, "/sync/csteix/status");
  assert.equal(statusBeforeConnect.data.configured, false);

  // Re-importing identical payload is 100% idempotent (0 inserted, 0 updated, 2 unchanged).
  const secondImport = await callJson(env, "/sync/csteix/wuxu/import", {
    method: "POST",
    body: {
      articles: [
        {
          slug: "first-note",
          title: "First Note",
          dimensions: ["chaos"],
          writtenAt: "2026-11-13T10:49:00.000Z",
          timezone: "Asia/Shanghai",
          bodyZh: "First body."
        },
        {
          slug: "second-note",
          title: "Second Note",
          titleEn: "Second Note EN",
          dimensions: ["existence", "ix"],
          writtenAt: "2026-11-21T11:42:00.000Z",
          timezone: "Asia/Shanghai",
          bodyZh: "Second body.",
          bodyEn: "Second body EN.",
          rawNotes: "Raw note."
        }
      ]
    }
  });
  assert.equal(secondImport.status, 200);
  assert.equal(secondImport.data.inserted, 0);
  assert.equal(secondImport.data.updated, 0);
  assert.equal(secondImport.data.unchanged, 2);

  // Full delta pull returns both articles ordered by updated_at ASC.
  const fullDelta = await callJson(env, "/sync/csteix/wuxu?includeDeleted=1");
  assert.equal(fullDelta.status, 200);
  assert.equal(fullDelta.data.schemaVersion, SCHEMA_VERSION);
  assert.equal(fullDelta.data.app, "csteix");
  assert.equal(fullDelta.data.totalCount, 2);
  assert.equal((fullDelta.data.articles as unknown[]).length, 2);

  // Simulate distinct timestamps so incremental 'since' returns only the newer update (including soft-deletes).
  await db
    .prepare("UPDATE csteix_wuxu SET updated_at = '2026-11-20T00:00:00.000Z' WHERE slug = 'first-note'")
    .run();
  await db
    .prepare("UPDATE csteix_wuxu SET updated_at = '2026-11-22T01:00:00.000Z', deleted_at = '2026-11-22T01:00:00.000Z' WHERE slug = 'second-note'")
    .run();

  const incWithDeleted = await callJson(
    env,
    "/sync/csteix/wuxu?since=2026-11-21T00:00:00.000Z&includeDeleted=1"
  );
  assert.equal(incWithDeleted.status, 200);
  assert.equal(incWithDeleted.data.totalCount, 1); // active non-deleted count
  const incArticles = incWithDeleted.data.articles as Array<{ slug: string; deletedAt: string | null }>;
  assert.equal(incArticles.length, 1);
  assert.equal(incArticles[0].slug, "second-note");
  assert.equal(incArticles[0].deletedAt, "2026-11-22T01:00:00.000Z");

  const incActiveOnly = await callJson(
    env,
    "/sync/csteix/wuxu?since=2026-11-21T00:00:00.000Z&includeDeleted=0"
  );
  assert.equal((incActiveOnly.data.articles as unknown[]).length, 0);

  // Connect CSTEIX and wipe all cloud data -> deletes csteix_wuxu as well!
  await connectCsteix(env);
  const wipe = await callJson(env, "/sync/csteix/data", { method: "DELETE" });
  assert.equal(wipe.status, 200);
  assert.equal(wipe.data.wiped, true);

  const afterWipe = await callJson(env, "/sync/csteix/wuxu?includeDeleted=1");
  assert.equal(afterWipe.data.totalCount, 0);
  assert.equal((afterWipe.data.articles as unknown[]).length, 0);
});

test("exposes chaox://wuxu/{slug} MCP resource template, enforces read policy, and batches >80 slug imports", async () => {
  const { env } = makeEnv();
  await connectCsteix(env);

  const tplRes = await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 500, method: "resources/templates/list" }
  });
  const templates = (tplRes.data.result as { resourceTemplates: Array<{ uriTemplate: string }> }).resourceTemplates;
  assert.equal(templates.length, 1);
  assert.equal(templates[0].uriTemplate, "chaox://wuxu/{slug}");

  await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 501,
      method: "tools/call",
      params: {
        name: "csteix_create_wuxu",
        arguments: {
          slug: "resource-test-entry",
          title: "Resource Read Entry",
          dimensions: ["chaos", "ix"],
          writtenAt: "2026-11-22 09:00",
          bodyZh: "## Passage\n\nWhen the wind settles.\n\n## Lines that stayed\n\n- Only this line.",
          rawNotes: "Verbatim raw note line."
        }
      }
    }
  });

  const readRes = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 502,
      method: "resources/read",
      params: { uri: "chaox://wuxu/resource-test-entry" }
    }
  });
  const contents = (readRes.data.result as { contents: Array<{ mimeType: string; text: string }> }).contents;
  assert.equal(contents[0].mimeType, "text/markdown");
  assert.match(contents[0].text, /# Resource Read Entry/);
  assert.match(contents[0].text, /When the wind settles/);
  assert.match(contents[0].text, /## Raw Notes/);

  // Batch import > 85 articles exercises chunked slug IN lookup (> 80 per chunk).
  const batchArticles = Array.from({ length: 85 }, (_, idx) => ({
    slug: `batch-note-${String(idx + 1).padStart(3, "0")}`,
    title: `Batch ${idx + 1}`,
    dimensions: ["existence"],
    writtenAt: "2026-11-22T12:00:00.000Z",
    timezone: "Asia/Shanghai",
    bodyZh: `Body ${idx + 1}`
  }));
  const batchImport = await callJson(env, "/sync/csteix/wuxu/import", {
    method: "POST",
    body: { articles: batchArticles }
  });
  assert.equal(batchImport.status, 200);
  assert.equal(batchImport.data.inserted, 85);

  const reImport = await callJson(env, "/sync/csteix/wuxu/import", {
    method: "POST",
    body: { articles: batchArticles }
  });
  assert.equal(reImport.status, 200);
  assert.equal(reImport.data.unchanged, 85);

  // Turning off read access must block chaox://wuxu/{slug}.
  await connectCsteix(env, {
    permission: "disabled",
    policy: {
      allowRead: false,
      allowCreate: false,
      allowUpdate: false,
      allowDelete: false,
      allowedDomains: ["wuxu"],
      consentAcknowledged: true
    }
  });
  const deniedRead = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 503,
      method: "resources/read",
      params: { uri: "chaox://wuxu/resource-test-entry" }
    }
  });
  assert.equal((deniedRead.data.error as { code: number }).code, -32602);
});

test("prevents ghost applied receipt when csteix_wuxu loses a concurrent conditional UPDATE", async () => {
  const { env, db } = makeEnv();
  await connectCsteix(env);

  const created = await callMcpTool(env, "csteix_create_wuxu", {
    slug: "race-check-note",
    title: "Concurrency Check",
    dimensions: ["ix"],
    bodyZh: "Initial content",
    requestId: "wuxu-race-create"
  });
  assert.equal(created.isError, false);

  // Wrap db.prepare so any conditional UPDATE on csteix_wuxu simulates another writer
  // advancing the revision between the pre-read and UPDATE (returns changes: 0).
  const proxiedEnv: ServerEnv = {
    ...env,
    DB: {
      prepare(query: string) {
        const inner = db.prepare(query);
        if (/UPDATE\s+csteix_wuxu\b/i.test(query)) {
          return {
            bind(...values: unknown[]) {
              inner.bind(...values);
              return this;
            },
            first: (...args: unknown[]) => inner.first(...(args as [])),
            all: () => inner.all(),
            async run() {
              return { meta: { changes: 0 } };
            }
          };
        }
        return inner;
      },
      batch: (stmts) => db.batch(stmts)
    }
  };

  const raceUpd = await callMcpTool(proxiedEnv, "csteix_update_wuxu", {
    slug: "race-check-note",
    appendBodyZh: "Conflicting write",
    requestId: "wuxu-race-update"
  });
  assert.equal(raceUpd.isError, true);
  assert.match(raceUpd.text, /changed concurrently/);

  const ghostReceipt = await db
    .prepare("SELECT * FROM receipts WHERE request_id = 'wuxu-race-update'")
    .first();
  assert.equal(ghostReceipt, null);
});

test("validates and normalizes Wuxu stage couplets, PivotText math, and IX terminology guard", async () => {
  const { env } = makeEnv();
  await connectCsteix(env);

  // Valid creation: normalizes full-width pipe ｜, trims spaces, uppercases & collapses EN spaces, normalizes dimension aliases.
  const validCreate = await callMcpTool(env, "csteix_create_wuxu", {
    slug: "couplet-valid",
    title: "Valid Couplets",
    dimensions: ["chaos", "ix"],
    bodyZh: "Passage body.",
    couplets: [
      {
        dimension: "混沌",
        zh: "  一切 ｜ 基底  ",
        en: "  all   things ｜ one   ground  ",
        sourceLine: "  First spark from chaos  "
      },
      {
        dimension: "我求",
        zh: "万物之先｜是为故事",
        en: "before all things | there was story"
      },
      {
        dimension: "existence",
        zh: "以身载道|无身则无",
        en: "BODY CARRIES DAO|NO BODY NO DAO"
      },
      {
        dimension: "ix",
        zh: "此身有尽|我求无涯",
        en: "THIS BODY ENDS|IX KNOWS NO END"
      }
    ]
  });
  assert.equal(validCreate.isError, false);
  const article = validCreate.parsed?.article as {
    couplets: Array<{ id: string; dimension: string; zh: string; en: string; sourceLine: string | null }>;
  };
  assert.equal(article.couplets.length, 4);
  assert.deepEqual(
    article.couplets.map((c) => ({ dimension: c.dimension, zh: c.zh, en: c.en, sourceLine: c.sourceLine })),
    [
      {
        dimension: "chaos",
        zh: "一切|基底",
        en: "ALL THINGS|ONE GROUND",
        sourceLine: "First spark from chaos"
      },
      {
        dimension: "ix",
        zh: "万物之先|是为故事",
        en: "BEFORE ALL THINGS|THERE WAS STORY",
        sourceLine: null
      },
      {
        dimension: "existence",
        zh: "以身载道|无身则无",
        en: "BODY CARRIES DAO|NO BODY NO DAO",
        sourceLine: null
      },
      {
        dimension: "ix",
        zh: "此身有尽|我求无涯",
        en: "THIS BODY ENDS|IX KNOWS NO END",
        sourceLine: null
      }
    ]
  );
  assert.ok(article.couplets.every((c) => c.id.length > 0));
  const receipt = validCreate.parsed?.receipt as { details?: { coupletCount?: number } };
  assert.equal(receipt.details?.coupletCount, 4);

  // Also test PivotText max boundary (17 chars, diff 3) and non-我求 探求 exemption.
  const boundaryCreate = await callMcpTool(env, "csteix_create_wuxu", {
    slug: "couplet-boundary",
    title: "Boundary Couplets",
    dimensions: ["ix"],
    bodyZh: "Boundary body.",
    couplets: [
      {
        dimension: "existence",
        zh: "风过千重|我自悠然",
        en: "A THOUSAND WINDS PASS|I REMAIN UNTROUBLED"
      },
      {
        dimension: "ix",
        zh: "深度共鸣|耐心复利",
        en: "DEPTH RESONATES|PATIENCE COMPOUNDS"
      },
      {
        dimension: "ix",
        zh: "未定义处|亦可探求",
        en: "WHERE UNDEFINED|INQUIRY GOES ON"
      }
    ]
  });
  assert.equal(boundaryCreate.isError, false);

  const dedupeEdgeCreate = await callMcpTool(env, "csteix_create_wuxu", {
    slug: "couplet-dedupe-edge",
    title: "Dedupe Edge Couplets",
    dimensions: ["chaos", "spacetime"],
    bodyZh: "Dedupe edge body.",
    couplets: [
      {
        // Proves equal-length halves (6 vs 6) and shorter half with double letters (6 vs 9->7) are NOT deduped:
        dimension: "chaos",
        zh: "万物|皆流",
        en: "ALL OUT|SEE YOU"
      },
      {
        dimension: "spacetime",
        zh: "晨昏|四季",
        en: "ALL DAY|ALL LIGHTS"
      }
    ]
  });
  assert.equal(dedupeEdgeCreate.isError, false);

  // Error cases with measured counts/diffs:
  const expectCoupletError = async (slug: string, couplets: unknown[], pattern: RegExp) => {
    const res = await callMcpTool(env, "csteix_create_wuxu", {
      slug,
      title: "Bad Couplet",
      dimensions: ["chaos"],
      bodyZh: "Body.",
      couplets
    });
    assert.equal(res.isError, true, `Expected error for ${slug}`);
    assert.match(res.text, pattern, `Unexpected error text for ${slug}: ${res.text}`);
  };

  // ZH missing or extra pipe
  await expectCoupletError("err-zh-no-pipe", [{ dimension: "chaos", zh: "一切基底", en: "ALL THINGS|ONE GROUND" }], /found 0/);
  await expectCoupletError("err-zh-two-pipes", [{ dimension: "chaos", zh: "一|切|基", en: "ALL THINGS|ONE GROUND" }], /found 2/);
  // ZH whitespace, emoji, markdown, ——, punctuation
  await expectCoupletError("err-zh-space", [{ dimension: "chaos", zh: "一 切|基 地", en: "ALL THINGS|ONE GROUND" }], /whitespace/);
  await expectCoupletError("err-zh-emoji", [{ dimension: "chaos", zh: "一切✨|基底✨", en: "ALL THINGS|ONE GROUND" }], /emoji/);
  await expectCoupletError("err-zh-md", [{ dimension: "chaos", zh: "*一切*|基底", en: "ALL THINGS|ONE GROUND" }], /Markdown/);
  await expectCoupletError("err-zh-dash", [{ dimension: "chaos", zh: "一——|基底", en: "ALL THINGS|ONE GROUND" }], /punctuation or dashes/);
  await expectCoupletError("err-zh-punct", [{ dimension: "chaos", zh: "一切，|基底。", en: "ALL THINGS|ONE GROUND" }], /punctuation/);
  // ZH length asymmetry & bounds
  await expectCoupletError("err-zh-asym", [{ dimension: "chaos", zh: "一切|基础之地", en: "ALL THINGS|ONE GROUND" }], /leftLen=2.*rightLen=4.*diff=2/);
  await expectCoupletError("err-zh-short", [{ dimension: "chaos", zh: "一|基", en: "ALL THINGS|ONE GROUND" }], /leftLen=1.*rightLen=1/);
  await expectCoupletError("err-zh-long", [{ dimension: "chaos", zh: "一二三四五六七|七六五四三二一", en: "ALL THINGS|ONE GROUND" }], /leftLen=7.*rightLen=7/);
  // EN bad chars (apostrophe, hyphen, digits, punctuation)
  await expectCoupletError("err-en-chars", [{ dimension: "chaos", zh: "一切|基底", en: "DON'T MOVE|STAND STILL" }], /ASCII letters A-Z/);
  await expectCoupletError("err-en-hyphen", [{ dimension: "chaos", zh: "一切|基底", en: "SELF-MADE|ALL GROUND" }], /ASCII letters A-Z/);
  // EN PivotText bounds (< 6, > 17, diff > 3)
  await expectCoupletError("err-en-short", [{ dimension: "chaos", zh: "一切|基底", en: "NO WAY|ONE HI" }], /\(5\).*\(5\)/);
  await expectCoupletError("err-en-long", [{ dimension: "chaos", zh: "一切|基底", en: "SOMETHING FAR TOO LONG|ANOTHER LONG PHRASE" }], /6\.\.17/);
  await expectCoupletError("err-en-diff", [{ dimension: "chaos", zh: "一切|基底", en: "ALL FORM|NOTHING REMAINS" }], /differ by 7 chars.*leftOut='ALLFORM' \(7\).*rightOut='NOTHINGREMAINS' \(14\)/);
  // Terminology guard: 我求 without IX using SEEKING / EXPLORE
  await expectCoupletError("err-ix-seeking", [{ dimension: "ix", zh: "此身有尽|我求无涯", en: "THIS BODY ENDS|SEEKING NO END" }], /'我求'.*must be rendered as 'IX'.*'SEEKING'/);
  await expectCoupletError("err-ix-explore", [{ dimension: "ix", zh: "此身有尽|我求无涯", en: "THIS BODY ENDS|EXPLORE NO END" }], /'我求'.*must be rendered as 'IX'.*'EXPLORE'/);
  // Max 4 couplets and duplicate zh
  await expectCoupletError(
    "err-max-5",
    [
      { dimension: "chaos", zh: "一二|三四", en: "ONE TWO|THREE FOUR" },
      { dimension: "chaos", zh: "二三|四五", en: "TWO THREE|FOUR FIVE" },
      { dimension: "chaos", zh: "三四|五六", en: "THREE FOUR|FIVE SIX" },
      { dimension: "chaos", zh: "四五|六七", en: "FOUR FIVE|SIX SEVEN" },
      { dimension: "chaos", zh: "五六|七八", en: "FIVE SIX|SEVEN EIGHT" }
    ],
    /got 5.*maximum allowed is 4/
  );
  await expectCoupletError(
    "err-dup-zh",
    [
      { dimension: "chaos", zh: "一切|基底", en: "ALL THINGS|ONE GROUND" },
      { dimension: "ix", zh: " 一切 ｜ 基底 ", en: "ALL CHAOS|ONE LIFE" }
    ],
    /Duplicate normalized zh/
  );
});

test("supports couplet update, appendCouplets dedupe/ID-preservation, clear, list filters, summary, delta, import, and MCP guide", async () => {
  const { env } = makeEnv();
  await connectCsteix(env);

  // Create article with default empty couplets.
  const created = await callMcpTool(env, "csteix_create_wuxu", {
    slug: "stage-note",
    title: "Stage Note",
    dimensions: ["chaos", "spacetime"],
    writtenAt: "2026-11-22 10:00",
    bodyZh: "Quiet reflection."
  });
  assert.equal(created.isError, false);
  assert.deepEqual((created.parsed?.article as { couplets: unknown[] }).couplets, []);

  // Mutual exclusion between couplets and appendCouplets.
  const bothErr = await callMcpTool(env, "csteix_update_wuxu", {
    slug: "stage-note",
    couplets: [],
    appendCouplets: [{ dimension: "chaos", zh: "一切|基底", en: "ALL THINGS|ONE GROUND" }]
  });
  assert.equal(bothErr.isError, true);
  assert.match(bothErr.text, /Cannot provide both 'couplets' and 'appendCouplets'/);

  // Replace couplets with 1 caller-ID couplet and 1 generated-ID couplet.
  const replaced = await callMcpTool(env, "csteix_update_wuxu", {
    slug: "stage-note",
    expectedRevision: 1,
    couplets: [
      {
        id: "custom-couplet-1",
        dimension: "chaos",
        zh: "一切|基底",
        en: "ALL THINGS|ONE GROUND",
        sourceLine: "Ground note"
      },
      {
        dimension: "spacetime",
        zh: "涌现|容器",
        en: "ALL RISING|ONE VESSEL"
      }
    ]
  });
  assert.equal(replaced.isError, false);
  const rev2Couplets = (replaced.parsed?.article as { couplets: Array<{ id: string; zh: string }> }).couplets;
  assert.equal(rev2Couplets.length, 2);
  assert.equal(rev2Couplets[0].id, "custom-couplet-1");
  const generatedId2 = rev2Couplets[1].id;
  assert.ok(generatedId2.length > 0);
  const updReceipt = replaced.parsed?.receipt as { details?: { coupletCount?: number; changedFields?: string[] } };
  assert.equal(updReceipt.details?.coupletCount, 2);
  assert.deepEqual(updReceipt.details?.changedFields, ["couplets"]);

  // Replacing with same (dimension, zh) and omitted id reuses existing id!
  const reusedOnReplace = await callMcpTool(env, "csteix_update_wuxu", {
    slug: "stage-note",
    expectedRevision: 2,
    couplets: [
      {
        dimension: "chaos",
        zh: "一切|基底",
        en: "ALL THINGS|ONE GROUND"
      },
      {
        dimension: "spacetime",
        zh: "涌现|容器",
        en: "ALL RISING|ONE VESSEL",
        sourceLine: "Updated source"
      }
    ]
  });
  assert.equal(reusedOnReplace.isError, false);
  const rev3Couplets = (reusedOnReplace.parsed?.article as { couplets: Array<{ id: string }> }).couplets;
  assert.equal(rev3Couplets[0].id, "custom-couplet-1");
  assert.equal(rev3Couplets[1].id, generatedId2);

  // appendCouplets: updates existing normalized zh (even changing dimension) while preserving ID + adds 2 new = 4 total.
  const appended = await callMcpTool(env, "csteix_update_wuxu", {
    slug: "stage-note",
    expectedRevision: 3,
    appendCouplets: [
      {
        dimension: "ix",
        zh: " 一切 ｜ 基底 ",
        en: "ALL CHAOS|ONE GROUND",
        sourceLine: "Reclassified to IX"
      },
      {
        dimension: "existence",
        zh: "以身载道|无身则无",
        en: "BODY CARRIES DAO|NO BODY NO DAO"
      },
      {
        dimension: "ix",
        zh: "此身有尽|我求无涯",
        en: "THIS BODY ENDS|IX KNOWS NO END"
      }
    ]
  });
  assert.equal(appended.isError, false);
  const rev4Couplets = (appended.parsed?.article as {
    couplets: Array<{ id: string; dimension: string; zh: string; en: string; sourceLine: string | null }>;
  }).couplets;
  assert.equal(rev4Couplets.length, 4);
  assert.equal(rev4Couplets[0].id, "custom-couplet-1");
  assert.equal(rev4Couplets[0].dimension, "ix");
  assert.equal(rev4Couplets[0].en, "ALL CHAOS|ONE GROUND");
  assert.equal(rev4Couplets[0].sourceLine, "Reclassified to IX");

  // Appending 1 more new zh exceeds 4 and includes measured count.
  const overflowAppend = await callMcpTool(env, "csteix_update_wuxu", {
    slug: "stage-note",
    appendCouplets: [{ dimension: "chaos", zh: "无人编排|自虚无来", en: "WITH NO CONDUCTOR|ALL COMES FROM VOID" }]
  });
  assert.equal(overflowAppend.isError, true);
  assert.match(overflowAppend.text, /combined total would be 5.*maximum of 4/);

  // Second article without couplets to test filters, summary, resources.
  await callMcpTool(env, "csteix_create_wuxu", {
    slug: "plain-note",
    title: "Plain Note",
    dimensions: ["chaos"],
    writtenAt: "2026-11-22 11:00",
    bodyZh: "No couplets here."
  });

  // listWuxu hasCouplets true / false and query matching couplets_json.
  const listWithCouplets = await callMcpTool(env, "csteix_list_wuxu", { hasCouplets: true });
  assert.equal((listWithCouplets.parsed?.items as unknown[]).length, 1);
  assert.equal((listWithCouplets.parsed?.items as Array<{ slug: string }>)[0].slug, "stage-note");

  const listWithoutCouplets = await callMcpTool(env, "csteix_list_wuxu", { hasCouplets: false });
  assert.equal((listWithoutCouplets.parsed?.items as unknown[]).length, 1);
  assert.equal((listWithoutCouplets.parsed?.items as Array<{ slug: string }>)[0].slug, "plain-note");

  const queryByCoupletEn = await callMcpTool(env, "csteix_list_wuxu", { query: "IX KNOWS NO END" });
  assert.equal((queryByCoupletEn.parsed?.items as unknown[]).length, 1);
  assert.equal((queryByCoupletEn.parsed?.items as Array<{ slug: string }>)[0].slug, "stage-note");

  const queryByCoupletZh = await callMcpTool(env, "csteix_list_wuxu", { query: "以身载道|无身则无" });
  assert.equal((queryByCoupletZh.parsed?.items as unknown[]).length, 1);

  // csteix_get_summary includes coupletCount and coupletsByDimension.
  const sumRes = await callMcpTool(env, "csteix_get_summary", {});
  const wuxuSum = sumRes.parsed?.wuxu as {
    coupletCount: number;
    coupletsByDimension: Record<string, number>;
  };
  assert.equal(wuxuSum.coupletCount, 4);
  assert.deepEqual(wuxuSum.coupletsByDimension, {
    chaos: 0,
    spacetime: 1,
    existence: 1,
    ix: 2
  });

  // Delta sync includes couplets.
  const deltaRes = await callJson(env, "/sync/csteix/wuxu");
  assert.equal(deltaRes.status, 200);
  const deltaArticles = deltaRes.data.articles as Array<{ slug: string; couplets: unknown[] }>;
  const stageDelta = deltaArticles.find((a) => a.slug === "stage-note");
  const plainDelta = deltaArticles.find((a) => a.slug === "plain-note");
  assert.equal(stageDelta?.couplets.length, 4);
  assert.deepEqual(plainDelta?.couplets, []);

  // MCP resource chaox://wuxu/{slug} appends ## Stage Couplets only when non-empty.
  const resWithCouplets = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 601,
      method: "resources/read",
      params: { uri: "chaox://wuxu/stage-note" }
    }
  });
  const textWith = (resWithCouplets.data.result as { contents: Array<{ text: string }> }).contents[0].text;
  assert.match(textWith, /## Stage Couplets/);
  assert.match(textWith, /IX KNOWS NO END/);

  const resWithoutCouplets = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 602,
      method: "resources/read",
      params: { uri: "chaox://wuxu/plain-note" }
    }
  });
  const textWithout = (resWithoutCouplets.data.result as { contents: Array<{ text: string }> }).contents[0].text;
  assert.doesNotMatch(textWithout, /## Stage Couplets/);

  // Clear couplets with couplets: [].
  const cleared = await callMcpTool(env, "csteix_update_wuxu", {
    slug: "stage-note",
    couplets: []
  });
  assert.equal(cleared.isError, false);
  assert.deepEqual((cleared.parsed?.article as { couplets: unknown[] }).couplets, []);
  assert.equal(
    (cleared.parsed?.receipt as { details?: { coupletCount?: number } }).details?.coupletCount,
    0
  );

  // Import with couplets, idempotent re-import omitting id, and re-import omitting couplets preserves DB couplets.
  const importRes1 = await callJson(env, "/sync/csteix/wuxu/import", {
    method: "POST",
    body: {
      articles: [
        {
          slug: "imported-couplet-note",
          title: "Imported Couplet",
          dimensions: ["chaos"],
          writtenAt: "2026-11-22T12:00:00.000Z",
          timezone: "Asia/Shanghai",
          bodyZh: "Imported body.",
          couplets: [{ dimension: "chaos", zh: "一切|基底", en: "ALL THINGS|ONE GROUND" }]
        }
      ]
    }
  });
  assert.equal(importRes1.status, 200);
  assert.equal(importRes1.data.inserted, 1);

  const importedGet1 = await callMcpTool(env, "csteix_get_wuxu", { slug: "imported-couplet-note" });
  const importedCoupletId = ((importedGet1.parsed?.couplets as Array<{ id: string }>)[0]).id;

  // Idempotent re-import with same couplet (without id) keeps generated ID and reports unchanged.
  const importRes2 = await callJson(env, "/sync/csteix/wuxu/import", {
    method: "POST",
    body: {
      articles: [
        {
          slug: "imported-couplet-note",
          title: "Imported Couplet",
          dimensions: ["chaos"],
          writtenAt: "2026-11-22T12:00:00.000Z",
          timezone: "Asia/Shanghai",
          bodyZh: "Imported body.",
          couplets: [{ dimension: "chaos", zh: "一切|基底", en: "ALL THINGS|ONE GROUND" }]
        }
      ]
    }
  });
  assert.equal(importRes2.status, 200);
  assert.equal(importRes2.data.unchanged, 1);

  // Re-import omitting couplets field preserves existing couplets_json and reports unchanged.
  const importRes3 = await callJson(env, "/sync/csteix/wuxu/import", {
    method: "POST",
    body: {
      articles: [
        {
          slug: "imported-couplet-note",
          title: "Imported Couplet",
          dimensions: ["chaos"],
          writtenAt: "2026-11-22T12:00:00.000Z",
          timezone: "Asia/Shanghai",
          bodyZh: "Imported body."
        }
      ]
    }
  });
  assert.equal(importRes3.status, 200);
  assert.equal(importRes3.data.unchanged, 1);
  const importedGet2 = await callMcpTool(env, "csteix_get_wuxu", { slug: "imported-couplet-note" });
  assert.equal(((importedGet2.parsed?.couplets as Array<{ id: string }>)[0]).id, importedCoupletId);

  // MCP resources/list, resources/read for chaox://guide/wuxu-couplets, scoping (?apps=sx), and write_wuxu prompt.
  const resList = await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 700, method: "resources/list" }
  });
  const resources = (resList.data.result as { resources: Array<{ uri: string }> }).resources;
  assert.ok(resources.some((r) => r.uri === "chaox://guide/wuxu-couplets"));

  const scopedResList = await callJson(env, "/mcp?apps=sx", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 701, method: "resources/list" }
  });
  const scopedResources = (scopedResList.data.result as { resources: Array<{ uri: string }> }).resources;
  assert.ok(!scopedResources.some((r) => r.uri === "chaox://guide/wuxu-couplets"));

  const scopedGuideRead = await callJson(env, "/mcp?apps=sx", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 702,
      method: "resources/read",
      params: { uri: "chaox://guide/wuxu-couplets" }
    }
  });
  assert.equal((scopedGuideRead.data.error as { code: number }).code, -32602);

  const guideRead = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 703,
      method: "resources/read",
      params: { uri: "chaox://guide/wuxu-couplets" }
    }
  });
  const guideText = (guideRead.data.result as { contents: Array<{ mimeType: string; text: string }> }).contents[0].text;
  assert.match(guideText, /PivotText/);
  assert.match(guideText, /VESSEL/);
  assert.match(guideText, /WEIGHT/);
  assert.match(guideText, /STANDING/);
  assert.match(guideText, /THIS BODY ENDS\|IX KNOWS NO END/);

  const promptRes = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 704,
      method: "prompts/get",
      params: { name: "write_wuxu", arguments: { topic: "evening stillness" } }
    }
  });
  const promptText = (promptRes.data.result as { messages: Array<{ content: { text: string } }> }).messages[0].content.text;
  assert.match(promptText, /chaox:\/\/guide\/wuxu-couplets/);
  assert.match(promptText, /0-2 timeless bilingual Stage Couplets/);
});
