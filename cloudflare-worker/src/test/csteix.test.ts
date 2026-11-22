import assert from "node:assert/strict";
import test from "node:test";
import { handleWorkerRequest } from "../index.js";
import { SCHEMA_VERSION, WorkerEnv } from "../types.js";
import { createTestDatabase, SqliteD1Database } from "./d1-mock.js";

function makeEnv(token = "secret-csteix-token"): { env: WorkerEnv; db: SqliteD1Database } {
  const db = createTestDatabase();
  return {
    db,
    env: {
      DB: db,
      CHAOX_AUTH_TOKEN: token
    }
  };
}

async function callJson(
  env: WorkerEnv,
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

  const req = new Request(`https://chaox-test.workers.dev${pathname}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  });
  const res = await handleWorkerRequest(req, env);
  const text = await res.text();
  return {
    status: res.status,
    data: text ? (JSON.parse(text) as Record<string, unknown>) : {}
  };
}

async function callMcpTool(
  env: WorkerEnv,
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
  env: WorkerEnv,
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
