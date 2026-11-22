import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ChaoxExchangeClient, SCHEMA_VERSION } from "../exchange.js";
import { parseCliArgs, startHttpServer } from "../cli.js";

async function makeTempExchangeDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chaox-mcp-test-"));
  await fs.mkdir(path.join(dir, "sx", "inbox"), { recursive: true });
  await fs.mkdir(path.join(dir, "sx", "receipts"), { recursive: true });
  await fs.mkdir(path.join(dir, "bx", "inbox"), { recursive: true });
  await fs.mkdir(path.join(dir, "bx", "receipts"), { recursive: true });

  await fs.writeFile(
    path.join(dir, "protocol.json"),
    JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      updatedAt: "2026-11-21T10:00:00.000Z",
      apps: {
        sx: {
          app: "sx",
          bundleId: "ai.chaox.sx",
          appVersion: "1.0",
          permission: "appendOnly",
          capabilities: ["catalog", "summary", "record_expense", "record_income"],
          lastSyncAt: "2026-11-21T10:00:00.000Z",
          catalogPath: "sx/catalog.json",
          summaryPath: "sx/summary.json",
          inboxPath: "sx/inbox",
          receiptsPath: "sx/receipts"
        },
        bx: {
          app: "bx",
          bundleId: "com.lizhichao.bx",
          appVersion: "1.0",
          permission: "appendOnly",
          capabilities: ["catalog", "summary", "record_food", "record_skin", "record_toilet"],
          lastSyncAt: "2026-11-21T10:00:00.000Z",
          catalogPath: "bx/catalog.json",
          summaryPath: "bx/summary.json",
          inboxPath: "bx/inbox",
          receiptsPath: "bx/receipts"
        }
      }
    })
  );

  await fs.writeFile(
    path.join(dir, "sx", "catalog.json"),
    JSON.stringify({
      generatedAt: "2026-11-21T10:00:00.000Z",
      timeZoneIdentifier: "Asia/Shanghai",
      summaryCurrency: "CNY",
      supportedCurrencies: ["CNY", "USD"],
      projects: [
        { name: "Daily Meals", supportsExpense: true, supportsIncome: false },
        { name: "Consulting", supportsExpense: false, supportsIncome: true }
      ],
      tags: ["Dining"]
    })
  );

  await fs.writeFile(
    path.join(dir, "sx", "summary.json"),
    JSON.stringify({
      generatedAt: "2026-11-21T10:00:00.000Z",
      summaryCurrency: "CNY",
      expense: {
        today: { period: "today", mode: "expense", currency: "CNY", netTotal: 60.1, recordCount: 2 },
        month: { period: "month", mode: "expense", currency: "CNY", netTotal: 500, recordCount: 10 }
      }
    })
  );

  await fs.writeFile(
    path.join(dir, "bx", "catalog.json"),
    JSON.stringify({
      mealTypes: ["breakfast", "lunch", "dinner", "snack"],
      skinProducts: ["sunscreen", "moisturizer", "bodyLotion", "medicine", "other"]
    })
  );

  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  await fs.writeFile(
    path.join(dir, "bx", "summary.json"),
    JSON.stringify({
      generatedAt: "2026-11-21T10:00:00.000Z",
      today: {
        date: todayKey,
        totalCalories: 400,
        unknownCaloriesCount: 0,
        mealCount: 1,
        skinCount: 1,
        bowelCount: 1,
        urinationCount: 0,
        toiletCount: 1
      },
      days: [
        {
          date: todayKey,
          totalCalories: 400,
          unknownCaloriesCount: 0,
          mealCount: 1,
          skinCount: 1,
          bowelCount: 1,
          urinationCount: 0,
          toiletCount: 1
        }
      ]
    })
  );

  return dir;
}

test("validates SX catalog, preserves explicit empty tags, and computes optimistic overlays", async () => {
  const dir = await makeTempExchangeDir();
  try {
    const client = new ChaoxExchangeClient(dir);

    await assert.rejects(
      () => client.recordSxExpense({ amount: 39.9, currency: "EUR", projectName: "Daily Meals" }),
      /Unsupported currency/
    );
    await assert.rejects(
      () => client.recordSxExpense({ amount: 39.9, projectName: "NonExistent" }),
      /Unknown projectName/
    );
    await assert.rejects(
      () => client.recordSxExpense({ amount: 39.9, projectName: "Consulting" }),
      /does not support expense/
    );

    const sxQueued = await client.recordSxExpense({
      amount: 39.9,
      currency: "cny",
      projectName: "daily meals",
      tags: [],
      note: "Meituan salad",
      requestId: "meal-1"
    });
    assert.equal(sxQueued.normalizedPayload.projectName, "Daily Meals");
    assert.equal(sxQueued.normalizedPayload.currency, "CNY");
    assert.deepEqual(sxQueued.normalizedPayload.tags, []);

    const bxFood = await client.recordBxFood({
      name: "Meituan light salad",
      mealType: "lunch",
      calories: 420,
      requestId: "meal-1-food"
    });
    assert.equal(bxFood.op, "record_food");

    const bxUnknownCalFood = await client.recordBxFood({
      name: "Green tea",
      requestId: "meal-2-food"
    });
    assert.equal(bxUnknownCalFood.normalizedPayload.mealType, undefined);

    const sxSummary = await client.readSxSummary({ period: "today", mode: "expense" });
    const sxOverlay = sxSummary.optimisticOverlay as {
      pendingInboxCount: number;
      optimisticSameCurrencyTotal: number;
    };
    assert.equal(sxOverlay.pendingInboxCount, 1);
    assert.equal(sxOverlay.optimisticSameCurrencyTotal, 100);

    const bxSummary = await client.readBxSummary();
    const bxOverlay = bxSummary.optimisticOverlay as {
      pendingInboxCount: number;
      optimisticTotals: {
        totalCalories: number;
        unknownCaloriesCount: number;
        mealCount: number;
        bowelCount: number;
      };
    };
    assert.equal(bxOverlay.pendingInboxCount, 2);
    assert.equal(bxOverlay.optimisticTotals.totalCalories, 820);
    assert.equal(bxOverlay.optimisticTotals.unknownCaloriesCount, 1);
    assert.equal(bxOverlay.optimisticTotals.mealCount, 3);
    assert.equal(bxOverlay.optimisticTotals.bowelCount, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("validates BX SkinApplication.Product and ToiletEvent schemas accurately", async () => {
  const dir = await makeTempExchangeDir();
  try {
    const client = new ChaoxExchangeClient(dir);

    await assert.rejects(
      () => client.recordBxSkin({ product: "cleanser" as never }),
      /Invalid product/
    );
    const skinQueued = await client.recordBxSkin({
      product: "bodyLotion",
      name: "Cerave",
      requestId: "skin-1"
    });
    assert.equal(skinQueued.normalizedPayload.product, "bodyLotion");
    assert.equal(skinQueued.normalizedPayload.name, "Cerave");

    await assert.rejects(
      () => client.recordBxToilet({ kind: "bowel" }),
      /require 'stoolType'/
    );
    await assert.rejects(
      () => client.recordBxToilet({ kind: "urination", stoolType: 4 }),
      /must not specify 'stoolType'/
    );
    const urinationQueued = await client.recordBxToilet({
      kind: "urination",
      requestId: "toilet-u-1"
    });
    assert.equal(urinationQueued.normalizedPayload.kind, "urination");
    const bowelQueued = await client.recordBxToilet({
      kind: "bowel",
      stoolType: 4,
      note: "Normal",
      requestId: "toilet-b-1"
    });
    assert.equal(bowelQueued.normalizedPayload.stoolType, 4);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("enforces readOnly and disabled permission tiers from protocol.json", async () => {
  const dir = await makeTempExchangeDir();
  try {
    const manifestPath = path.join(dir, "protocol.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      apps: Record<string, { permission: string }>;
    };
    manifest.apps.sx.permission = "readOnly";
    manifest.apps.bx.permission = "disabled";
    await fs.writeFile(manifestPath, JSON.stringify(manifest));

    const client = new ChaoxExchangeClient(dir);
    await assert.rejects(
      () => client.recordSxExpense({ amount: 12, projectName: "Daily Meals" }),
      /permission is 'readOnly'/
    );
    await assert.rejects(() => client.readBxSummary(), /set to 'disabled'/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("HTTP transport serves /health, enforces Bearer token, and responds to MCP tools/list", async () => {
  const dir = await makeTempExchangeDir();
  const options = parseCliArgs([
    "--dir",
    dir,
    "--http",
    "--host",
    "127.0.0.1",
    "--port",
    "0",
    "--token",
    "secret-token"
  ]);
  const started = await startHttpServer(options);
  try {
    const healthRes = await fetch(`http://127.0.0.1:${started.port}/health`);
    assert.equal(healthRes.status, 200);
    const healthBody = (await healthRes.json()) as { status: string; schemaVersion: string };
    assert.equal(healthBody.status, "ok");
    assert.equal(healthBody.schemaVersion, SCHEMA_VERSION);

    const unauthRes = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    });
    assert.equal(unauthRes.status, 401);

    const listRes = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer secret-token"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {}
      })
    });
    assert.equal(listRes.status, 200);
    const bodyText = await listRes.text();
    assert.match(bodyText, /sx_record_expense/);
    assert.match(bodyText, /bx_record_food/);
    assert.match(bodyText, /chaox_get_status/);
  } finally {
    await started.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("resolves SX date, local hour, YYYY-MM-DD-HH format, and notes alias in catalog timezone", async () => {
  const dir = await makeTempExchangeDir();
  try {
    const client = new ChaoxExchangeClient(dir);

    const bareDay = await client.recordSxExpense({
      amount: 12,
      projectName: "Daily Meals",
      date: "2026-11-21",
      requestId: "mcp-tz-bare"
    });
    assert.equal(bareDay.normalizedPayload.date, "2026-11-20T16:00:00.000Z");

    const withHourAndAlias = await client.recordSxExpense({
      amount: 18.5,
      projectName: "Daily Meals",
      date: "2026-11-22",
      hour: 12,
      notes: "Light salad",
      requestId: "mcp-tz-hour"
    });
    assert.equal(withHourAndAlias.normalizedPayload.date, "2026-11-22T04:00:00.000Z");
    assert.equal(withHourAndAlias.normalizedPayload.note, "Light salad");

    const withDisplayFormat = await client.recordSxExpense({
      amount: 21,
      projectName: "Daily Meals",
      date: "2026-11-22-09",
      requestId: "mcp-tz-display"
    });
    assert.equal(withDisplayFormat.normalizedPayload.date, "2026-11-22T01:00:00.000Z");

    const singleDigitTime = await client.recordSxExpense({
      amount: 15,
      projectName: "Daily Meals",
      date: "2026-11-22 9:30",
      requestId: "mcp-tz-single-digit"
    });
    assert.equal(singleDigitTime.normalizedPayload.date, "2026-11-22T01:30:00.000Z");

    await assert.rejects(
      () => client.recordSxExpense({ amount: 10, projectName: "Daily Meals", date: "2026-11-22", hour: 25 }),
      /'hour' must be an integer between 0 and 23/
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
