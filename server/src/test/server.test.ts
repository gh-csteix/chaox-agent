import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../app.js";
import { createMemoryDatabase } from "../sqlite.js";
import { SCHEMA_VERSION, ServerEnv } from "../types.js";

function makeEnv(token = "secret-server-token"): ServerEnv {
  return {
    DB: createMemoryDatabase(),
    CHAOX_AUTH_TOKEN: token
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

test("serves /health without auth and enforces Bearer token on protected routes", async () => {
  const env = makeEnv();
  const health = await callJson(env, "/health", { token: null });
  assert.equal(health.status, 200);
  assert.equal(health.data.status, "ok");
  assert.equal(health.data.schemaVersion, SCHEMA_VERSION);

  const unauth = await callJson(env, "/mcp", {
    method: "POST",
    token: "wrong-token",
    body: { jsonrpc: "2.0", id: 1, method: "tools/list" }
  });
  assert.equal(unauth.status, 401);
});

test("supports full SX + BX snapshot upload, MCP tools/resources/prompts, optimistic overlay, and ack drain", async () => {
  const env = makeEnv();
  const today = new Date().toISOString().slice(0, 10);

  const sxSnap = await callJson(env, "/sync/sx/snapshot", {
    method: "PUT",
    body: {
      bundleId: "ai.chaox.sx",
      appVersion: "1.0",
      permission: "appendOnly",
      capabilities: ["catalog", "summary", "record_expense", "record_income"],
      catalog: {
        summaryCurrency: "CNY",
        projects: [{ name: "Daily Meals", supportsExpense: true, supportsIncome: false }],
        tags: ["Dining"]
      },
      summary: {
        generatedAt: "2026-11-21T10:00:00.000Z",
        summaryCurrency: "CNY",
        expense: {
          today: { period: "today", mode: "expense", currency: "CNY", netTotal: 60.1, recordCount: 2 }
        }
      }
    }
  });
  assert.equal(sxSnap.status, 200);

  const bxSnap = await callJson(env, "/sync/bx/snapshot", {
    method: "PUT",
    body: {
      bundleId: "com.lizhichao.bx",
      appVersion: "1.0",
      permission: "appendOnly",
      capabilities: ["catalog", "summary", "record_food", "record_skin", "record_toilet"],
      catalog: {
        mealTypes: ["breakfast", "lunch", "dinner", "snack"],
        skinProducts: ["sunscreen", "moisturizer", "bodyLotion", "medicine", "other"]
      },
      summary: {
        today: {
          date: today,
          totalCalories: 400,
          unknownCaloriesCount: 0,
          mealCount: 1,
          skinCount: 0,
          bowelCount: 0,
          urinationCount: 0,
          toiletCount: 0
        },
        days: []
      }
    }
  });
  assert.equal(bxSnap.status, 200);

  const initRes = await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }
  });
  const initResult = initRes.data.result as { instructions: string };
  assert.match(initResult.instructions, /CHAOX Agent Protocol/);

  const toolsRes = await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 2, method: "tools/list" }
  });
  const tools = (toolsRes.data.result as { tools: Array<{ name: string }> }).tools;
  assert.equal(tools.length, 72);

  const skillRes = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 3,
      method: "resources/read",
      params: { uri: "chaox://guide/skill" }
    }
  });
  const contents = (skillRes.data.result as { contents: Array<{ text: string }> }).contents;
  assert.match(contents[0].text, /sx_record_expense/);

  const promptRes = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 4,
      method: "prompts/get",
      params: { name: "log_meal_photo", arguments: { amount: 39.9 } }
    }
  });
  const messages = (promptRes.data.result as { messages: Array<{ content: { text: string } }> }).messages;
  assert.match(messages[0].content.text, /39.9/);

  const sxWrite = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "sx_record_expense",
        arguments: {
          amount: 39.9,
          projectName: "daily meals",
          tags: [],
          note: "Meituan salad",
          requestId: "meal-worker-1"
        }
      }
    }
  });
  const sxWriteParsed = JSON.parse(
    ((sxWrite.data.result as { content: Array<{ text: string }> }).content[0]).text
  ) as { queued: boolean; normalizedPayload: { projectName: string; tags: string[] } };
  assert.equal(sxWriteParsed.queued, true);
  assert.equal(sxWriteParsed.normalizedPayload.projectName, "Daily Meals");
  assert.deepEqual(sxWriteParsed.normalizedPayload.tags, []);

  const bxWrite = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "bx_record_food",
        arguments: {
          name: "Chicken salad",
          calories: 420,
          requestId: "meal-worker-1-food"
        }
      }
    }
  });
  assert.equal((bxWrite.data.result as { isError?: boolean }).isError, undefined);

  const sxSummary = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "sx_get_summary", arguments: { period: "today" } }
    }
  });
  const sxSummaryParsed = JSON.parse(
    ((sxSummary.data.result as { content: Array<{ text: string }> }).content[0]).text
  ) as { optimisticOverlay: { pendingInboxCount: number; optimisticSameCurrencyTotal: number } };
  assert.equal(sxSummaryParsed.optimisticOverlay.pendingInboxCount, 1);
  assert.equal(sxSummaryParsed.optimisticOverlay.optimisticSameCurrencyTotal, 100);

  const inboxPull = await callJson(env, "/sync/sx/inbox");
  const envelopes = inboxPull.data.envelopes as Array<{ requestId: string; op: string }>;
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0].requestId, "meal-worker-1");

  const ackRes = await callJson(env, "/sync/sx/ack", {
    method: "POST",
    body: {
      receipts: [
        {
          schemaVersion: SCHEMA_VERSION,
          requestId: "meal-worker-1",
          app: "sx",
          op: "record_expense",
          status: "applied",
          processedAt: "2026-11-21T12:10:00.000Z",
          recordId: "101",
          summary: "Daily Meals 39.9 CNY"
        }
      ]
    }
  });
  assert.equal(ackRes.status, 200);
  assert.equal(ackRes.data.ackedCount, 1);

  const inboxAfterAck = await callJson(env, "/sync/sx/inbox");
  assert.equal((inboxAfterAck.data.envelopes as unknown[]).length, 0);

  const syncStatus = await callJson(env, "/sync/sx/status");
  assert.equal(syncStatus.data.pendingInboxCount, 0);
  assert.equal((syncStatus.data.recentReceipts as Array<{ status: string }>)[0].status, "applied");
});

test("preserves snapshot when updating permission to readOnly and blocks writes", async () => {
  const env = makeEnv();
  await callJson(env, "/sync/bx/snapshot", {
    method: "PUT",
    body: {
      bundleId: "com.lizhichao.bx",
      appVersion: "1.0",
      permission: "appendOnly",
      capabilities: ["summary", "record_food"],
      catalog: { skinProducts: ["sunscreen", "moisturizer", "bodyLotion", "medicine", "other"] },
      summary: { today: { date: "2026-11-21", totalCalories: 500 }, days: [] }
    }
  });

  // Update permission without re-sending catalog/summary.
  await callJson(env, "/sync/bx/snapshot", {
    method: "PUT",
    body: {
      bundleId: "com.lizhichao.bx",
      appVersion: "1.0",
      permission: "readOnly",
      capabilities: ["summary"]
    }
  });

  const summary = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "bx_get_summary", arguments: { date: "2026-11-21" } }
    }
  });
  const parsedSummary = JSON.parse(
    ((summary.data.result as { content: Array<{ text: string }> }).content[0]).text
  ) as { committedDay: { totalCalories: number } };
  assert.equal(parsedSummary.committedDay.totalCalories, 500);

  const writeBlocked = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "bx_record_food", arguments: { name: "Apple" } }
    }
  });
  assert.equal((writeBlocked.data.result as { isError?: boolean }).isError, true);
});

test("supports full BX sleep/workouts/food/skin/toilet reads, CRUD, workout Health guard, and domain gating", async () => {
  const env = makeEnv();
  const workoutId = "11111111-1111-1111-1111-111111111111";
  const fixedWorkoutId = "22222222-2222-2222-2222-222222222222";
  const entryId = "33333333-3333-3333-3333-333333333333";
  const foodId = "44444444-4444-4444-4444-444444444444";

  await callJson(env, "/sync/bx/snapshot", {
    method: "PUT",
    body: {
      bundleId: "com.lizhichao.bx",
      appVersion: "1.1",
      permission: "readWrite",
      policy: {
        allowRead: true,
        allowCreate: true,
        allowUpdate: true,
        allowDelete: false,
        allowedDomains: ["sleep", "workouts", "food", "skin", "toilet"],
        consentAcknowledged: true
      },
      capabilities: ["sleep", "workouts", "food", "skin", "toilet"],
      catalog: {
        mealTypes: ["breakfast", "lunch", "dinner", "snack"],
        skinProducts: ["sunscreen", "moisturizer", "bodyLotion", "medicine", "other"]
      },
      summary: { today: { date: "2026-11-22", mealCount: 1 }, days: [] },
      datasets: {
        sleep: [
          {
            day: "2026-11-22",
            start: "2026-11-21T23:30:00Z",
            end: "2026-11-22T07:10:00Z",
            asleepMinutes: 430,
            inBedMinutes: 460,
            stagesMinutes: { core: 260, deep: 90, rem: 80 },
            source: "appleHealth",
            readOnly: true
          }
        ],
        exercises: [
          {
            id: "55555555-5555-5555-5555-555555555555",
            key: "latPulldown",
            nameZh: "高位下拉",
            nameEn: "Lat Pulldown",
            aliases: ["pulldown"],
            group: "back",
            equipment: ["cableMachine"]
          }
        ],
        workouts: [
          {
            id: workoutId,
            source: "healthKit",
            start: "2026-11-22T09:00:00Z",
            end: "2026-11-22T10:00:00Z",
            durationMinutes: 60,
            activeEnergyKcal: 340,
            averageHeartRate: 132,
            healthActivityName: "other",
            effectiveActivityName: "other",
            canChooseType: true,
            frameReadOnly: true,
            exercises: [
              {
                entryId,
                workoutId,
                exerciseId: "55555555-5555-5555-5555-555555555555",
                exerciseKey: "latPulldown",
                nameZh: "高位下拉",
                nameEn: "Lat Pulldown",
                muscleGroup: "back",
                equipment: ["cableMachine"],
                position: 0,
                setGroups: [{ reps: 12, sets: 3, weightKg: 45 }]
              }
            ]
          },
          {
            id: fixedWorkoutId,
            source: "healthKit",
            start: "2026-11-21T08:00:00Z",
            end: "2026-11-21T08:40:00Z",
            durationMinutes: 40,
            healthActivityName: "running",
            effectiveActivityName: "running",
            canChooseType: false,
            frameReadOnly: true,
            exercises: []
          }
        ],
        food: [
          { id: foodId, eatenAt: "2026-11-22T08:00:00Z", meal: "breakfast", name: "Oats", calories: 320 }
        ],
        skin: [],
        toilet: []
      }
    }
  });

  const sleepRes = await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "bx_list_sleep", arguments: {} } }
  });
  const sleepData = JSON.parse(((sleepRes.data.result as { content: Array<{ text: string }> }).content[0]).text);
  assert.equal(sleepData.readOnly, true);
  assert.equal(sleepData.items.length, 1);
  assert.equal(sleepData.items[0].asleepMinutes, 430);

  // Adding workout exercise works; deleting food fails because allowDelete is false.
  const addEx = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: {
        name: "bx_add_workout_exercise",
        arguments: {
          workoutId,
          exercise: "latPulldown",
          setGroups: [{ reps: 10, sets: 4, weightKg: 50 }]
        }
      }
    }
  });
  assert.equal((addEx.data.result as { isError?: boolean }).isError, undefined);

  // Updating fixed Apple Health workout type must be rejected early.
  const badType = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 22,
      method: "tools/call",
      params: {
        name: "bx_update_workout_type",
        arguments: { workoutId: fixedWorkoutId, activityType: "traditionalStrengthTraining" }
      }
    }
  });
  assert.equal((badType.data.result as { isError?: boolean }).isError, true);

  // Deleting food when allowDelete === false is blocked.
  const blockedDelete = await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 23, method: "tools/call", params: { name: "bx_delete_food", arguments: { id: foodId } } }
  });
  assert.equal((blockedDelete.data.result as { isError?: boolean }).isError, true);

  // Disable sleep domain on next snapshot -> server deletes sleep dataset row and rejects bx_list_sleep.
  await callJson(env, "/sync/bx/snapshot", {
    method: "PUT",
    body: {
      bundleId: "com.lizhichao.bx",
      appVersion: "1.1",
      permission: "readWrite",
      policy: {
        allowRead: true,
        allowCreate: true,
        allowUpdate: true,
        allowDelete: true,
        allowedDomains: ["workouts", "food", "skin", "toilet"],
        consentAcknowledged: true
      },
      capabilities: ["workouts", "food", "skin", "toilet"]
    }
  });

  const sleepBlocked = await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 24, method: "tools/call", params: { name: "bx_list_sleep", arguments: {} } }
  });
  assert.equal((sleepBlocked.data.result as { isError?: boolean }).isError, true);

  const allowedDelete = await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 25, method: "tools/call", params: { name: "bx_delete_food", arguments: { id: foodId } } }
  });
  assert.equal((allowedDelete.data.result as { isError?: boolean }).isError, undefined);
});

test("enforces SX project child lock on delete, full CRUD, and wipes app data completely on DELETE /sync/:app/data", async () => {
  const env = makeEnv();
  await callJson(env, "/sync/sx/snapshot", {
    method: "PUT",
    body: {
      bundleId: "ai.chaox.sx",
      appVersion: "1.1",
      permission: "readWrite",
      policy: {
        allowRead: true,
        allowCreate: true,
        allowUpdate: true,
        allowDelete: true,
        allowedDomains: ["projects", "expenses", "incomes", "tags", "slogans"],
        consentAcknowledged: true
      },
      capabilities: ["projects", "expenses", "incomes", "tags", "slogans"],
      catalog: {
        summaryCurrency: "CNY",
        supportedCurrencies: ["CNY", "USD"],
        projects: [{ id: "1", name: "Food", supportsExpense: true, supportsIncome: false }]
      },
      summary: { summaryCurrency: "CNY", expense: {}, income: {} },
      datasets: {
        projects: [
          {
            id: 1,
            name: "Food",
            price: 0,
            currency: "CNY",
            cycle: "irregular",
            priceType: "floating",
            projectType: "nonRenewal",
            cashFlowSides: "expenseOnly",
            supportsExpense: true,
            supportsIncome: false,
            startDate: "2026-01-01T00:00:00Z",
            isAutoRenew: false,
            notes: "",
            expenseCount: 2,
            incomeCount: 0,
            credentialLinkCount: 0,
            deletable: false
          }
        ],
        expenses: [
          {
            id: 10,
            projectId: 1,
            projectName: "Food",
            amount: 42,
            netAmount: 42,
            refundTotal: 0,
            currency: "CNY",
            tags: ["Dining"],
            notes: "Lunch",
            paidAt: "2026-11-22T04:00:00Z"
          }
        ],
        incomes: [],
        tags: [{ id: 5, name: "Dining", expenseCount: 1, incomeCount: 0 }],
        slogans: []
      }
    }
  });

  // Project with expenses cannot be deleted.
  const delProj = await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "sx_delete_project", arguments: { id: 1 } } }
  });
  assert.equal((delProj.data.result as { isError?: boolean }).isError, true);

  // Updating expense queues cleanly and overlays list.
  const updExp = await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "sx_update_expense", arguments: { id: 10, amount: 48 } } }
  });
  assert.equal((updExp.data.result as { isError?: boolean }).isError, undefined);

  const listExp = await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 32, method: "tools/call", params: { name: "sx_list_expenses", arguments: {} } }
  });
  const listExpData = JSON.parse(((listExp.data.result as { content: Array<{ text: string }> }).content[0]).text);
  assert.equal(listExpData.items[0].amount, 48);
  assert.equal(listExpData.items[0].pendingStatus, "queued_update");

  // Complete cloud data wipe removes app_state, app_dataset, inbox, receipts for sx.
  const wipe = await callJson(env, "/sync/sx/data", { method: "DELETE" });
  assert.equal(wipe.status, 200);
  assert.equal(wipe.data.wiped, true);

  const statusAfter = await callJson(env, "/sync/sx/status");
  assert.equal(statusAfter.data.configured, false);
  assert.equal(statusAfter.data.pendingInboxCount, 0);

  const readAfterWipe = await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 33, method: "tools/call", params: { name: "sx_list_expenses", arguments: {} } }
  });
  assert.equal((readAfterWipe.data.result as { isError?: boolean }).isError, true);
});

test("enforces SX opt-in credentials scope and supports non-secret credential/link CRUD", async () => {
  const env = makeEnv();
  await callJson(env, "/sync/sx/snapshot", {
    method: "PUT",
    body: {
      bundleId: "ai.chaox.sx",
      appVersion: "1.2",
      permission: "readWrite",
      policy: {
        allowRead: true,
        allowCreate: true,
        allowUpdate: true,
        allowDelete: true,
        allowedDomains: ["projects", "expenses", "incomes", "tags", "slogans"],
        consentAcknowledged: true
      },
      capabilities: ["projects", "expenses", "incomes", "tags", "slogans", "credentials"],
      catalog: {
        summaryCurrency: "CNY",
        supportedCurrencies: ["CNY"],
        projects: [{ id: "1", name: "Cloud", supportsExpense: true, supportsIncome: false }]
      },
      summary: { summaryCurrency: "CNY", expense: {}, income: {} },
      datasets: { projects: [], expenses: [], incomes: [], tags: [], slogans: [] }
    }
  });

  // Disabled by default: reading or creating credentials, or attaching credentialId, must fail.
  const listBlocked = await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 40, method: "tools/call", params: { name: "sx_list_credentials", arguments: {} } }
  });
  assert.equal((listBlocked.data.result as { isError?: boolean }).isError, true);

  const createBlocked = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 41,
      method: "tools/call",
      params: { name: "sx_create_credential", arguments: { username: "alice@example.com" } }
    }
  });
  assert.equal((createBlocked.data.result as { isError?: boolean }).isError, true);

  const attachBlocked = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: { name: "sx_record_expense", arguments: { amount: 25, projectName: "Cloud", credentialId: 7 } }
    }
  });
  assert.equal((attachBlocked.data.result as { isError?: boolean }).isError, true);

  // Enable 'credentials' domain -> reads, CRUD, links, and expense credentialId work.
  await callJson(env, "/sync/sx/snapshot", {
    method: "PUT",
    body: {
      bundleId: "ai.chaox.sx",
      appVersion: "1.2",
      permission: "readWrite",
      policy: {
        allowRead: true,
        allowCreate: true,
        allowUpdate: true,
        allowDelete: true,
        allowedDomains: ["projects", "expenses", "incomes", "tags", "slogans", "credentials"],
        consentAcknowledged: true
      },
      capabilities: ["projects", "expenses", "incomes", "tags", "slogans", "credentials"],
      datasets: {
        credentials: [
          {
            id: 7,
            username: "alice@example.com",
            type: "Login",
            website: "cloud.example",
            issuer: "",
            linkCount: 1,
            links: [
              {
                projectId: 1,
                projectName: "Cloud",
                startDate: "2026-11-01T00:00:00Z",
                hasStartDate: true,
                isAutoRenew: true,
                renewalHour: 9,
                renewalWeekdays: 127
              }
            ]
          }
        ]
      }
    }
  });

  const listAllowed = await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 43, method: "tools/call", params: { name: "sx_list_credentials", arguments: {} } }
  });
  const parsedCreds = JSON.parse(((listAllowed.data.result as { content: Array<{ text: string }> }).content[0]).text);
  assert.equal(parsedCreds.secretsRedacted, true);
  assert.equal(parsedCreds.items[0].username, "alice@example.com");

  const updLink = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 44,
      method: "tools/call",
      params: { name: "sx_update_credential_link", arguments: { credentialId: 7, projectId: 1, renewalHour: 10 } }
    }
  });
  assert.equal((updLink.data.result as { isError?: boolean }).isError, undefined);

  const recWithCred = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 45,
      method: "tools/call",
      params: { name: "sx_record_expense", arguments: { amount: 25, projectName: "Cloud", credentialId: 7 } }
    }
  });
  assert.equal((recWithCred.data.result as { isError?: boolean }).isError, undefined);
});

test("filters SX YYYY-MM-DD queries by device timeZoneIdentifier and localDate across UTC midnight boundaries", async () => {
  const env = makeEnv();
  await callJson(env, "/sync/sx/snapshot", {
    method: "PUT",
    body: {
      bundleId: "ai.chaox.sx",
      appVersion: "0.1.1",
      permission: "readWrite",
      policy: {
        allowRead: true,
        allowCreate: true,
        allowUpdate: true,
        allowDelete: false,
        allowedDomains: ["projects", "expenses", "incomes", "tags", "slogans"],
        consentAcknowledged: true
      },
      capabilities: ["projects", "expenses", "incomes", "tags", "slogans"],
      catalog: {
        timeZoneIdentifier: "Asia/Shanghai",
        summaryCurrency: "CNY",
        supportedCurrencies: ["CNY", "USD"],
        projects: [
          { name: "Spaceship", currency: "USD", type: "nonRenewal", cycle: "irregular", supportsExpense: true, supportsIncome: false },
          { name: "EatingDrinkingOut", currency: "CNY", type: "nonRenewal", cycle: "irregular", supportsExpense: true, supportsIncome: false }
        ],
        tags: ["Domains", "Lunch"]
      },
      summary: { timeZoneIdentifier: "Asia/Shanghai", summaryCurrency: "CNY", expense: {}, income: {} },
      datasets: {
        projects: [
          {
            id: 81,
            name: "Spaceship",
            price: 0,
            currency: "USD",
            cycle: "irregular",
            priceType: "floating",
            projectType: "nonRenewal",
            cashFlowSides: "expenseOnly",
            supportsExpense: true,
            supportsIncome: false,
            startDate: "2026-11-22T04:08:10Z",
            isAutoRenew: false,
            notes: "",
            expenseCount: 1,
            incomeCount: 0,
            credentialLinkCount: 0,
            deletable: false
          },
          {
            id: 47,
            name: "EatingDrinkingOut",
            price: 0,
            currency: "CNY",
            cycle: "irregular",
            priceType: "floating",
            projectType: "nonRenewal",
            cashFlowSides: "expenseOnly",
            supportsExpense: true,
            supportsIncome: false,
            startDate: "2026-08-25T00:23:12Z",
            isAutoRenew: false,
            notes: "",
            expenseCount: 2,
            incomeCount: 0,
            credentialLinkCount: 0,
            deletable: false
          }
        ],
        expenses: [
          {
            id: 698,
            projectId: 81,
            projectName: "Spaceship",
            amount: 10.98,
            netAmount: 10.98,
            refundTotal: 0,
            currency: "USD",
            tags: ["Domains"],
            notes: "New domain",
            paidAt: "2026-11-20T16:00:00Z",
            localDate: "2026-11-21"
          },
          {
            id: 6980,
            projectId: 81,
            projectName: "Spaceship",
            amount: 10.98,
            netAmount: 10.98,
            refundTotal: 0,
            currency: "USD",
            tags: ["Domains"],
            notes: "Fallback without localDate",
            paidAt: "2026-11-20T16:00:00Z"
          },
          {
            id: 695,
            projectId: 4,
            projectName: "iCloud+ 200GB",
            amount: 21,
            netAmount: 21,
            refundTotal: 0,
            currency: "CNY",
            tags: ["iCloud"],
            notes: "05:00 BJT is Nov 22",
            paidAt: "2026-11-21T21:00:00Z"
          },
          {
            id: 699,
            projectId: 47,
            projectName: "EatingDrinkingOut",
            amount: 14,
            netAmount: 14,
            refundTotal: 0,
            currency: "CNY",
            tags: ["Lunch"],
            notes: "Noodles",
            paidAt: "2026-11-22T04:25:00Z",
            localDate: "2026-11-22"
          },
          {
            id: 700,
            projectId: 47,
            projectName: "EatingDrinkingOut",
            amount: 18.5,
            netAmount: 18.5,
            refundTotal: 0,
            currency: "CNY",
            tags: ["Lunch"],
            notes: "Salad",
            paidAt: "2026-11-22T04:25:00Z",
            localDate: "2026-11-22"
          }
        ],
        incomes: [],
        tags: [],
        slogans: []
      }
    }
  });

  // Pending inbox item created with +08:00 offset at BJT midnight must also match 2026-11-21.
  await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 49,
      method: "tools/call",
      params: {
        name: "sx_record_expense",
        arguments: {
          amount: 1.99,
          currency: "USD",
          projectName: "Spaceship",
          date: "2026-11-21T00:00:00+08:00",
          requestId: "bjt-midnight-pending"
        }
      }
    }
  });

  const nov21Res = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 50,
      method: "tools/call",
      params: { name: "sx_list_expenses", arguments: { from: "2026-11-21", to: "2026-11-21" } }
    }
  });
  const nov21Data = JSON.parse(((nov21Res.data.result as { content: Array<{ text: string }> }).content[0]).text) as {
    items: Array<{ id: number; pendingStatus?: string; notes: string }>
  };
  assert.deepEqual(
    nov21Data.items.map((item) => item.id).sort((a, b) => a - b),
    [-1, 698, 6980]
  );

  const nov20Res = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 51,
      method: "tools/call",
      params: { name: "sx_list_expenses", arguments: { from: "2026-11-20", to: "2026-11-20" } }
    }
  });
  const nov20Data = JSON.parse(((nov20Res.data.result as { content: Array<{ text: string }> }).content[0]).text) as {
    items: Array<{ id: number }>
  };
  assert.equal(nov20Data.items.length, 0);

  const nov22Res = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 52,
      method: "tools/call",
      params: { name: "sx_list_expenses", arguments: { from: "2026-11-22", to: "2026-11-22" } }
    }
  });
  const nov22Data = JSON.parse(((nov22Res.data.result as { content: Array<{ text: string }> }).content[0]).text) as {
    items: Array<{ id: number }>
  };
  assert.deepEqual(
    nov22Data.items.map((item) => item.id).sort((a, b) => a - b),
    [695, 699, 700]
  );
});

test("queues same-batch SX create_project, create_tag, create_credential(projectName), and record_expense in insertion order", async () => {
  const env = makeEnv();
  const snapRes = await callJson(env, "/sync/sx/snapshot", {
    method: "PUT",
    body: {
      bundleId: "ai.chaox.sx",
      appVersion: "0.1.1",
      permission: "readWrite",
      policy: {
        allowRead: true,
        allowCreate: true,
        allowUpdate: true,
        allowDelete: true,
        allowedDomains: ["projects", "expenses", "incomes", "tags", "slogans", "credentials"],
        consentAcknowledged: true
      },
      capabilities: ["catalog", "summary", "projects", "expenses", "tags", "credentials", "crud"],
      catalog: {
        timeZoneIdentifier: "Asia/Shanghai",
        summaryCurrency: "CNY",
        supportedCurrencies: ["CNY", "USD"],
        projects: [{ id: "1", name: "Existing", currency: "CNY", supportsExpense: true, supportsIncome: true }],
        tags: ["ExistingTag"]
      },
      datasets: {
        projects: [],
        expenses: [],
        incomes: [],
        tags: [],
        slogans: [],
        credentials: []
      }
    }
  });
  assert.equal(snapRes.status, 200);

  const createProj = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 60,
      method: "tools/call",
      params: {
        name: "sx_create_project",
        arguments: {
          name: "NewDomain",
          currency: "USD",
          projectType: "nonRenewal",
          cycle: "irregular",
          cashFlowSides: "expenseOnly",
          requestId: "zzz-step-1-project"
        }
      }
    }
  });
  assert.notEqual((createProj.data.result as { isError?: boolean }).isError, true);

  const createTag = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 61,
      method: "tools/call",
      params: {
        name: "sx_create_tag",
        arguments: {
          name: "Registrar",
          requestId: "mmm-step-2-tag"
        }
      }
    }
  });
  assert.notEqual((createTag.data.result as { isError?: boolean }).isError, true);

  const createCred = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 62,
      method: "tools/call",
      params: {
        name: "sx_create_credential",
        arguments: {
          username: "dns@newdomain.test",
          website: "newdomain.example",
          type: "Login",
          issuer: "NewDomain",
          projectName: "newdomain",
          startDate: "2026-11-21T00:00:00Z",
          requestId: "kkk-step-3-cred"
        }
      }
    }
  });
  assert.notEqual((createCred.data.result as { isError?: boolean }).isError, true);

  const recordExp = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 63,
      method: "tools/call",
      params: {
        name: "sx_record_expense",
        arguments: {
          projectName: "newdomain",
          amount: 10.98,
          currency: "USD",
          tags: ["Registrar"],
          date: "2026-11-20T16:00:00Z",
          requestId: "aaa-step-4-expense"
        }
      }
    }
  });
  assert.notEqual((recordExp.data.result as { isError?: boolean }).isError, true);

  // Enforcing queued project's cashFlowSides must reject income against an expenseOnly queued project.
  const badIncome = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 64,
      method: "tools/call",
      params: {
        name: "sx_record_income",
        arguments: {
          projectName: "NewDomain",
          amount: 5,
          currency: "USD",
          requestId: "bbb-invalid-income"
        }
      }
    }
  });
  assert.equal((badIncome.data.result as { isError?: boolean }).isError, true);

  // Pin identical created_at across all 4 rows so ORDER BY created_at ASC, rowid ASC proves insertion order.
  env.DB.prepare("UPDATE inbox SET created_at = '2026-11-22T06:00:00.000Z' WHERE app = 'sx'").run();

  const inboxRes = await callJson(env, "/sync/sx/inbox");
  assert.equal(inboxRes.status, 200);
  const envelopes = inboxRes.data.envelopes as Array<{ op: string; requestId: string; payload: Record<string, unknown> }>;
  assert.deepEqual(
    envelopes.map((e) => e.op),
    ["create_project", "create_tag", "create_credential", "record_expense"]
  );
  assert.equal(envelopes[2].payload.projectName, "NewDomain");
  assert.equal(envelopes[3].payload.projectName, "NewDomain");

  const credsRes = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 65,
      method: "tools/call",
      params: { name: "sx_list_credentials", arguments: {} }
    }
  });
  const credsData = JSON.parse(((credsRes.data.result as { content: Array<{ text: string }> }).content[0]).text) as {
    items: Array<{
      username: string;
      linkCount: number;
      links: Array<{ projectName: string; hasStartDate: boolean }>;
    }>
  };
  assert.equal(credsData.items.length, 1);
  assert.equal(credsData.items[0].username, "dns@newdomain.test");
  assert.equal(credsData.items[0].linkCount, 1);
  assert.equal(credsData.items[0].links.length, 1);
  assert.equal(credsData.items[0].links[0].projectName, "NewDomain");
  assert.equal(credsData.items[0].links[0].hasStartDate, true);
});

test("exposes complete SX MCP tool & property descriptions and fieldGuide in sx_get_catalog", async () => {
  const env = makeEnv();
  await callJson(env, "/sync/sx/snapshot", {
    method: "PUT",
    body: {
      bundleId: "ai.chaox.sx",
      appVersion: "0.1.1",
      permission: "readWrite",
      policy: {
        allowRead: true,
        allowCreate: true,
        allowUpdate: true,
        allowDelete: true,
        allowedDomains: ["projects", "expenses", "incomes", "tags", "slogans", "credentials"],
        consentAcknowledged: true
      },
      capabilities: ["catalog", "summary", "projects", "expenses", "incomes", "tags", "slogans", "credentials"],
      catalog: {
        timeZoneIdentifier: "Asia/Shanghai",
        summaryCurrency: "CNY",
        supportedCurrencies: ["CNY", "USD"],
        projects: [{ name: "EatingDrinkingOut", currency: "CNY", supportsExpense: true, supportsIncome: false }],
        tags: ["Lunch"]
      },
      summary: { timeZoneIdentifier: "Asia/Shanghai", summaryCurrency: "CNY", expense: {}, income: {} }
    }
  });

  const toolsRes = await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 70, method: "tools/list" }
  });
  const tools = (
    toolsRes.data.result as {
      tools: Array<{
        name: string;
        description?: string;
        inputSchema?: { properties?: Record<string, { description?: string }> };
      }>;
    }
  ).tools;
  assert.equal(tools.length, 72);

  const sxTools = tools.filter((t) => t.name.startsWith("sx_"));
  assert.ok(sxTools.length >= 25);
  for (const tool of sxTools) {
    assert.ok(tool.description && tool.description.trim().length > 15, `Missing description on ${tool.name}`);
  }

  const toolsRequiringFullPropertyDocs = [
    "sx_list_expenses",
    "sx_record_expense",
    "sx_update_expense",
    "sx_record_refund",
    "sx_list_incomes",
    "sx_record_income",
    "sx_update_income",
    "sx_create_project",
    "sx_update_project",
    "sx_create_slogan",
    "sx_create_credential",
    "sx_link_credential",
    "sx_update_credential_link"
  ];
  for (const toolName of toolsRequiringFullPropertyDocs) {
    const tool = tools.find((t) => t.name === toolName);
    assert.ok(tool, `Missing tool ${toolName}`);
    const props = tool.inputSchema?.properties ?? {};
    for (const [propName, propSchema] of Object.entries(props)) {
      assert.ok(
        typeof propSchema.description === "string" && propSchema.description.trim().length > 0,
        `Missing property description on ${toolName}.${propName}`
      );
    }
  }

  const recordExpense = tools.find((t) => t.name === "sx_record_expense");
  assert.ok(recordExpense?.inputSchema?.properties?.hour);
  assert.match(recordExpense.description ?? "", /YYYY-MM-DD-HH/);

  const catalogRes = await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 71, method: "tools/call", params: { name: "sx_get_catalog", arguments: {} } }
  });
  const catalogData = JSON.parse(((catalogRes.data.result as { content: Array<{ text: string }> }).content[0]).text) as {
    fieldGuide?: { expenseDisplayDateFormat?: string; commonPitfalls?: string[] };
  };
  assert.match(catalogData.fieldGuide?.expenseDisplayDateFormat ?? "", /YYYY-MM-DD-HH/);
  assert.ok((catalogData.fieldGuide?.commonPitfalls?.length ?? 0) >= 4);
});

test("resolves SX expense hour formats in device timezone, accepts note/notes alias, and enriches sx_list_expenses", async () => {
  const env = makeEnv();
  await callJson(env, "/sync/sx/snapshot", {
    method: "PUT",
    body: {
      bundleId: "ai.chaox.sx",
      appVersion: "0.1.2",
      permission: "readWrite",
      policy: {
        allowRead: true,
        allowCreate: true,
        allowUpdate: true,
        allowDelete: false,
        allowedDomains: ["projects", "expenses", "incomes", "tags", "slogans"],
        consentAcknowledged: true
      },
      capabilities: ["catalog", "summary", "projects", "expenses", "tags"],
      catalog: {
        timeZoneIdentifier: "Asia/Shanghai",
        summaryCurrency: "CNY",
        supportedCurrencies: ["CNY", "USD"],
        projects: [{ name: "EatingDrinkingOut", currency: "CNY", supportsExpense: true, supportsIncome: false }],
        tags: ["Lunch"]
      },
      summary: { timeZoneIdentifier: "Asia/Shanghai", summaryCurrency: "CNY", expense: {}, income: {} },
      datasets: {
        expenses: [
          {
            id: 10,
            projectId: 1,
            projectName: "EatingDrinkingOut",
            amount: 21,
            netAmount: 21,
            refundTotal: 0,
            currency: "CNY",
            tags: ["Breakfast"],
            notes: "Panini",
            paidAt: "2026-11-21T01:00:00Z"
          }
        ]
      }
    }
  });

  // 1) Bare YYYY-MM-DD resolves to local 00:00 in Asia/Shanghai, NOT T12:00:00Z (20:00 BJT).
  const bareRes = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 80,
      method: "tools/call",
      params: {
        name: "sx_record_expense",
        arguments: {
          amount: 10.98,
          currency: "USD",
          projectName: "EatingDrinkingOut",
          date: "2026-11-21",
          requestId: "tz-bare-day"
        }
      }
    }
  });
  const bareData = JSON.parse(((bareRes.data.result as { content: Array<{ text: string }> }).content[0]).text) as {
    normalizedPayload: Record<string, unknown>;
    resolvedLocalTime: { localDate: string; localHour: number; displayDate: string };
  };
  assert.equal(bareData.normalizedPayload.date, "2026-11-20T16:00:00.000Z");
  assert.equal(bareData.resolvedLocalTime.localDate, "2026-11-21");
  assert.equal(bareData.resolvedLocalTime.localHour, 0);
  assert.equal(bareData.resolvedLocalTime.displayDate, "2026-11-21-00");

  // 2) YYYY-MM-DD + explicit hour + notes alias produces canonical ISO & note without leaking extra payload keys.
  const hourRes = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 81,
      method: "tools/call",
      params: {
        name: "sx_record_expense",
        arguments: {
          amount: 18.5,
          projectName: "EatingDrinkingOut",
          date: "2026-11-22",
          hour: 12,
          notes: "Salad via notes alias",
          requestId: "tz-date-hour"
        }
      }
    }
  });
  const hourData = JSON.parse(((hourRes.data.result as { content: Array<{ text: string }> }).content[0]).text) as {
    normalizedPayload: Record<string, unknown>;
    resolvedLocalTime: { localDate: string; localHour: number; displayDate: string };
  };
  assert.equal(hourData.normalizedPayload.date, "2026-11-22T04:00:00.000Z");
  assert.equal(hourData.normalizedPayload.note, "Salad via notes alias");
  assert.equal(hourData.normalizedPayload.hour, undefined);
  assert.equal(hourData.normalizedPayload.notes, undefined);
  assert.equal(hourData.resolvedLocalTime.displayDate, "2026-11-22-12");

  // 3) SX display format YYYY-MM-DD-HH parses cleanly.
  const displayRes = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 82,
      method: "tools/call",
      params: {
        name: "sx_record_expense",
        arguments: {
          amount: 21,
          projectName: "EatingDrinkingOut",
          date: "2026-11-22-09",
          requestId: "tz-display-fmt"
        }
      }
    }
  });
  const displayData = JSON.parse(((displayRes.data.result as { content: Array<{ text: string }> }).content[0]).text) as {
    normalizedPayload: Record<string, unknown>;
    resolvedLocalTime: { localHour: number; displayDate: string };
  };
  assert.equal(displayData.normalizedPayload.date, "2026-11-22T01:00:00.000Z");
  assert.equal(displayData.resolvedLocalTime.localHour, 9);
  assert.equal(displayData.resolvedLocalTime.displayDate, "2026-11-22-09");

  // 4) Naive local YYYY-MM-DD HH:mm interprets in Asia/Shanghai.
  const localRes = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 83,
      method: "tools/call",
      params: {
        name: "sx_record_expense",
        arguments: {
          amount: 14,
          projectName: "EatingDrinkingOut",
          date: "2026-11-22 14:30",
          requestId: "tz-naive-local"
        }
      }
    }
  });
  const localData = JSON.parse(((localRes.data.result as { content: Array<{ text: string }> }).content[0]).text) as {
    normalizedPayload: Record<string, unknown>;
    resolvedLocalTime: { localHour: number; displayDate: string };
  };
  assert.equal(localData.normalizedPayload.date, "2026-11-22T06:30:00.000Z");
  assert.equal(localData.resolvedLocalTime.localHour, 14);
  assert.equal(localData.resolvedLocalTime.displayDate, "2026-11-22-14");

  // 5) Out-of-range hour is rejected.
  const badHour = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 84,
      method: "tools/call",
      params: {
        name: "sx_record_expense",
        arguments: { amount: 10, projectName: "EatingDrinkingOut", date: "2026-11-22", hour: 24 }
      }
    }
  });
  assert.equal((badHour.data.result as { isError?: boolean }).isError, true);

  // 6) Updating hour alone preserves existing snapshot expense's localDate; unknown ID rejects clearly.
  const updHour = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 85,
      method: "tools/call",
      params: {
        name: "sx_update_expense",
        arguments: { id: 10, hour: 15, requestId: "tz-upd-hour" }
      }
    }
  });
  const updHourData = JSON.parse(((updHour.data.result as { content: Array<{ text: string }> }).content[0]).text) as {
    normalizedPayload: Record<string, unknown>;
    resolvedLocalTime: { localDate: string; localHour: number; displayDate: string };
  };
  assert.equal(updHourData.normalizedPayload.date, "2026-11-21T07:00:00.000Z");
  assert.equal(updHourData.resolvedLocalTime.displayDate, "2026-11-21-15");

  const updUnknownHour = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 86,
      method: "tools/call",
      params: { name: "sx_update_expense", arguments: { id: 9999, hour: 15 } }
    }
  });
  assert.equal((updUnknownHour.data.result as { isError?: boolean }).isError, true);

  // 7) sx_list_expenses returns timeZoneIdentifier, localDate, localHour, and displayDate on overlaid & committed items.
  const listRes = await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 87, method: "tools/call", params: { name: "sx_list_expenses", arguments: {} } }
  });
  const listData = JSON.parse(((listRes.data.result as { content: Array<{ text: string }> }).content[0]).text) as {
    timeZoneIdentifier: string | null;
    items: Array<{ id: number; localDate?: string; localHour?: number; displayDate?: string; notes: string }>;
  };
  assert.equal(listData.timeZoneIdentifier, "Asia/Shanghai");
  const existingUpdated = listData.items.find((item) => item.id === 10);
  assert.equal(existingUpdated?.localDate, "2026-11-21");
  assert.equal(existingUpdated?.localHour, 15);
  assert.equal(existingUpdated?.displayDate, "2026-11-21-15");
  const displayDates = new Set(listData.items.map((item) => item.displayDate));
  assert.ok(displayDates.has("2026-11-21-00"));
  assert.ok(displayDates.has("2026-11-22-12"));
  assert.ok(displayDates.has("2026-11-22-09"));
  assert.ok(displayDates.has("2026-11-22-14"));

  // 8) 'YYYY-MM-DD HH' and 'YYYY-MM-DDTHH' formats, sequential FIFO updates on same id, stringified '09' hour, and loud invalid-hour error.
  const spaceHourRes = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 88,
      method: "tools/call",
      params: {
        name: "sx_record_expense",
        arguments: {
          amount: 9.5,
          projectName: "EatingDrinkingOut",
          date: "2026-11-22 09",
          requestId: "tz-space-hour"
        }
      }
    }
  });
  const spaceHourData = JSON.parse(((spaceHourRes.data.result as { content: Array<{ text: string }> }).content[0]).text) as {
    normalizedPayload: Record<string, unknown>;
  };
  assert.equal(spaceHourData.normalizedPayload.date, "2026-11-22T01:00:00.000Z");

  const tHourRes = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 89,
      method: "tools/call",
      params: {
        name: "sx_record_expense",
        arguments: {
          amount: 9.5,
          projectName: "EatingDrinkingOut",
          date: "2026-11-22T09",
          requestId: "tz-t-hour"
        }
      }
    }
  });
  const tHourData = JSON.parse(((tHourRes.data.result as { content: Array<{ text: string }> }).content[0]).text) as {
    normalizedPayload: Record<string, unknown>;
  };
  assert.equal(tHourData.normalizedPayload.date, "2026-11-22T01:00:00.000Z");

  const invalidHourStr = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 90,
      method: "tools/call",
      params: {
        name: "sx_record_expense",
        arguments: { amount: 10, projectName: "EatingDrinkingOut", date: "2026-11-22", hour: "morning" }
      }
    }
  });
  assert.equal((invalidHourStr.data.result as { isError?: boolean }).isError, true);

  // Follow-up queued updates on existing id #10 before sync: date-only then hour:'09' execute FIFO and keep amount/currency/notes intact.
  const followUp1 = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 91,
      method: "tools/call",
      params: {
        name: "sx_update_expense",
        arguments: { id: 10, date: "2026-11-22", requestId: "tz-fifo-upd-1" }
      }
    }
  });
  assert.notEqual((followUp1.data.result as { isError?: boolean }).isError, true);

  const followUp2 = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 92,
      method: "tools/call",
      params: {
        name: "sx_update_expense",
        arguments: { id: 10, hour: "09", requestId: "tz-fifo-upd-2" }
      }
    }
  });
  assert.notEqual((followUp2.data.result as { isError?: boolean }).isError, true);
  const followUp2Data = JSON.parse(((followUp2.data.result as { content: Array<{ text: string }> }).content[0]).text) as {
    normalizedPayload: Record<string, unknown>;
    resolvedLocalTime: { displayDate: string };
  };
  assert.equal(followUp2Data.normalizedPayload.date, "2026-11-22T01:00:00.000Z");
  assert.equal(followUp2Data.resolvedLocalTime.displayDate, "2026-11-22-09");

  const listAfterFifo = await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 93, method: "tools/call", params: { name: "sx_list_expenses", arguments: {} } }
  });
  const afterFifoData = JSON.parse(((listAfterFifo.data.result as { content: Array<{ text: string }> }).content[0]).text) as {
    items: Array<{ id: number; amount: number; currency: string; notes: string; displayDate?: string }>;
  };
  const item10AfterFifo = afterFifoData.items.find((item) => item.id === 10);
  assert.equal(item10AfterFifo?.displayDate, "2026-11-22-09");
  assert.equal(item10AfterFifo?.amount, 21);
  assert.equal(item10AfterFifo?.currency, "CNY");
  assert.equal(item10AfterFifo?.notes, "Panini");

  // 9) Single-digit hour/month/day formats stay in SX's timezone (no UTC fallback), and duplicate retries return canonical resolvedLocalTime.
  for (const [dateInput, expectedIso] of [
    ["2026-11-22 9:30", "2026-11-22T01:30:00.000Z"],
    ["2026-11-22-9", "2026-11-22T01:00:00.000Z"],
    ["2026-11-5", "2026-11-04T16:00:00.000Z"]
  ] as const) {
    const singleDigitRes = await callJson(env, "/mcp", {
      method: "POST",
      body: {
        jsonrpc: "2.0",
        id: 94,
        method: "tools/call",
        params: {
          name: "sx_record_expense",
          arguments: {
            amount: 8,
            projectName: "EatingDrinkingOut",
            date: dateInput,
            requestId: `single-${dateInput.replace(/[^a-z0-9]/gi, "-")}`
          }
        }
      }
    });
    const singleData = JSON.parse(((singleDigitRes.data.result as { content: Array<{ text: string }> }).content[0]).text) as {
      normalizedPayload: { date: string };
    };
    assert.equal(singleData.normalizedPayload.date, expectedIso);
  }

  // Idempotent retry on 'tz-date-hour' (2026-11-22 12:00 BJT) must preserve the original resolvedLocalTime even if retry omits date.
  const retryRes = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 95,
      method: "tools/call",
      params: {
        name: "sx_record_expense",
        arguments: {
          amount: 18.5,
          projectName: "EatingDrinkingOut",
          requestId: "tz-date-hour"
        }
      }
    }
  });
  const retryData = JSON.parse(((retryRes.data.result as { content: Array<{ text: string }> }).content[0]).text) as {
    duplicateInInbox: boolean;
    resolvedLocalTime?: { displayDate: string };
  };
  assert.equal(retryData.duplicateInInbox, true);
  assert.equal(retryData.resolvedLocalTime?.displayDate, "2026-11-22-12");

  // Non-date update on legacy snapshot without timeZoneIdentifier preserves existing localDate.
  await callJson(env, "/sync/sx/snapshot", {
    method: "PUT",
    body: {
      bundleId: "ai.chaox.sx",
      appVersion: "0.1.0",
      permission: "readWrite",
      policy: {
        allowRead: true,
        allowCreate: true,
        allowUpdate: true,
        allowDelete: false,
        allowedDomains: ["projects", "expenses", "incomes", "tags", "slogans"],
        consentAcknowledged: true
      },
      capabilities: ["catalog", "expenses"],
      catalog: {
        summaryCurrency: "CNY",
        supportedCurrencies: ["CNY"],
        projects: [{ name: "EatingDrinkingOut", currency: "CNY", supportsExpense: true, supportsIncome: false }]
      },
      datasets: {
        expenses: [
          {
            id: 501,
            projectId: 1,
            projectName: "EatingDrinkingOut",
            amount: 10,
            netAmount: 10,
            refundTotal: 0,
            currency: "CNY",
            tags: [],
            notes: "",
            paidAt: "2026-11-20T16:00:00Z",
            localDate: "2026-11-21"
          }
        ]
      }
    }
  });
  await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 96,
      method: "tools/call",
      params: { name: "sx_update_expense", arguments: { id: 501, amount: 12, requestId: "legacy-amt-only" } }
    }
  });
  const legacyList = await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 97, method: "tools/call", params: { name: "sx_list_expenses", arguments: {} } }
  });
  const legacyData = JSON.parse(((legacyList.data.result as { content: Array<{ text: string }> }).content[0]).text) as {
    items: Array<{ id: number; amount: number; localDate?: string }>;
  };
  const legacyItem = legacyData.items.find((i) => i.id === 501);
  assert.equal(legacyItem?.amount, 12);
  assert.equal(legacyItem?.localDate, "2026-11-21");
});

test("enforces SX summary period scoping, BX timezone-aware boundaries & recordedAt, and calories=0 updates", async () => {
  const env = makeEnv();
  const shanghaiParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const todayBjt = `${shanghaiParts.find((p) => p.type === "year")!.value}-${shanghaiParts.find((p) => p.type === "month")!.value}-${shanghaiParts.find((p) => p.type === "day")!.value}`;
  const currentYear = Number(todayBjt.slice(0, 4));
  const pastYearDate = `${currentYear - 1}-05-01-10`;

  await callJson(env, "/sync/sx/snapshot", {
    method: "PUT",
    body: {
      bundleId: "ai.chaox.sx",
      appVersion: "1.2.0",
      permission: "readWrite",
      policy: {
        allowRead: true,
        allowCreate: true,
        allowUpdate: true,
        allowDelete: true,
        allowedDomains: ["projects", "expenses", "incomes", "tags"],
        consentAcknowledged: true
      },
      capabilities: ["catalog", "summary", "expenses"],
      catalog: {
        timeZoneIdentifier: "Asia/Shanghai",
        summaryCurrency: "CNY",
        supportedCurrencies: ["CNY", "USD"],
        projects: [
          { name: "EatingDrinkingOut", currency: "CNY", supportsExpense: true, supportsIncome: false },
          { name: "CloudSub", currency: "USD", supportsExpense: true, supportsIncome: false }
        ]
      },
      summary: {
        timeZoneIdentifier: "Asia/Shanghai",
        summaryCurrency: "CNY",
        expense: {
          today: { period: "today", mode: "expense", currency: "CNY", netTotal: 100, recordCount: 1 },
          month: { period: "month", mode: "expense", currency: "CNY", netTotal: 500, recordCount: 5 },
          allTime: { period: "allTime", mode: "expense", currency: "CNY", netTotal: 2000, recordCount: 20 }
        }
      },
      datasets: {
        expenses: [
          {
            id: 201,
            projectId: 1,
            projectName: "EatingDrinkingOut",
            amount: 40,
            netAmount: 40,
            refundTotal: 0,
            currency: "CNY",
            tags: [],
            notes: "Breakfast",
            paidAt: `${todayBjt}T01:00:00.000Z`,
            localDate: todayBjt
          }
        ]
      }
    }
  });

  // 1) Queue backdated USD expense (inherits CloudSub currency USD) and today's CNY expense + a refund against today #201.
  await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 1001,
      method: "tools/call",
      params: {
        name: "sx_record_expense",
        arguments: { amount: 80, projectName: "CloudSub", date: pastYearDate, requestId: "sx-backdated" }
      }
    }
  });
  await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 1002,
      method: "tools/call",
      params: {
        name: "sx_record_expense",
        arguments: { amount: 25, projectName: "EatingDrinkingOut", date: `${todayBjt}-12`, requestId: "sx-today" }
      }
    }
  });
  await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 1003,
      method: "tools/call",
      params: {
        name: "sx_record_refund",
        arguments: { paymentId: 201, amount: 10, requestId: "sx-today-ref" }
      }
    }
  });

  const sxTodaySum = await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1004, method: "tools/call", params: { name: "sx_get_summary", arguments: { period: "today" } } }
  });
  const sxTodayData = JSON.parse(((sxTodaySum.data.result as { content: Array<{ text: string }> }).content[0]).text) as {
    optimisticOverlay: {
      excludedOutOfPeriodCount: number;
      pendingTotalsByCurrency: Record<string, number>;
      optimisticSameCurrencyTotal: number;
    };
  };
  assert.equal(sxTodayData.optimisticOverlay.excludedOutOfPeriodCount, 1);
  assert.equal(sxTodayData.optimisticOverlay.pendingTotalsByCurrency.USD, undefined);
  assert.equal(sxTodayData.optimisticOverlay.pendingTotalsByCurrency.CNY, 15);
  assert.equal(sxTodayData.optimisticOverlay.optimisticSameCurrencyTotal, 115);

  const sxAllTimeSum = await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1005, method: "tools/call", params: { name: "sx_get_summary", arguments: { period: "allTime" } } }
  });
  const sxAllData = JSON.parse(((sxAllTimeSum.data.result as { content: Array<{ text: string }> }).content[0]).text) as {
    optimisticOverlay: { pendingTotalsByCurrency: Record<string, number>; optimisticSameCurrencyTotal: number };
  };
  assert.equal(sxAllData.optimisticOverlay.pendingTotalsByCurrency.USD, 80);
  assert.equal(sxAllData.optimisticOverlay.pendingTotalsByCurrency.CNY, 15);
  assert.equal(sxAllData.optimisticOverlay.optimisticSameCurrencyTotal, 2015);

  // 2) BX timezone-aware summary & recordedAt (2026-11-22T07:30+08:00 = 2026-11-21T23:30Z must count on 2026-11-22).
  await callJson(env, "/sync/bx/snapshot", {
    method: "PUT",
    body: {
      bundleId: "com.lizhichao.bx",
      appVersion: "1.2.0",
      permission: "readWrite",
      policy: {
        allowRead: true,
        allowCreate: true,
        allowUpdate: true,
        allowDelete: true,
        allowedDomains: ["food", "skin", "toilet"],
        consentAcknowledged: true
      },
      capabilities: ["summary", "food", "skin", "toilet"],
      catalog: {
        timeZoneIdentifier: "Asia/Shanghai",
        mealTypes: ["breakfast", "lunch", "dinner", "snack"],
        skinProducts: ["sunscreen", "moisturizer", "bodyLotion", "medicine", "other"]
      },
      summary: {
        timeZoneIdentifier: "Asia/Shanghai",
        today: { date: "2026-11-22", totalCalories: 300, unknownCaloriesCount: 0, mealCount: 1, skinCount: 0, bowelCount: 0, urinationCount: 0, toiletCount: 0 },
        days: [
          { date: "2026-11-22", totalCalories: 300, unknownCaloriesCount: 0, mealCount: 1, skinCount: 0, bowelCount: 0, urinationCount: 0, toiletCount: 0 },
          { date: "2026-11-21", totalCalories: 1500, unknownCaloriesCount: 0, mealCount: 3, skinCount: 0, bowelCount: 0, urinationCount: 0, toiletCount: 0 }
        ]
      }
    }
  });

  const bxFoodRes = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 1006,
      method: "tools/call",
      params: {
        name: "bx_record_food",
        arguments: {
          name: "Morning oats",
          mealType: "breakfast",
          calories: 250,
          recordedAt: "2026-11-22T07:30:00+08:00",
          requestId: "bx-early-bjt"
        }
      }
    }
  });
  const bxFoodParsed = JSON.parse(((bxFoodRes.data.result as { content: Array<{ text: string }> }).content[0]).text) as {
    resolvedLocalTime?: { localDate: string; localTime: string };
  };
  assert.equal(bxFoodParsed.resolvedLocalTime?.localDate, "2026-11-22");
  assert.equal(bxFoodParsed.resolvedLocalTime?.localTime, "07:30");

  // Bare YYYY-MM-DD in BX must resolve to 12:00 local in Asia/Shanghai (not UTC noon = 20:00).
  const bxSkinRes = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 1007,
      method: "tools/call",
      params: {
        name: "bx_record_skin",
        arguments: { product: "sunscreen", name: "Daily SPF", recordedAt: "2026-11-22", requestId: "bx-skin-noon" }
      }
    }
  });
  const bxSkinParsed = JSON.parse(((bxSkinRes.data.result as { content: Array<{ text: string }> }).content[0]).text) as {
    normalizedPayload: { recordedAt: string };
    resolvedLocalTime?: { localDate: string; localTime: string };
  };
  assert.equal(bxSkinParsed.resolvedLocalTime?.localDate, "2026-11-22");
  assert.equal(bxSkinParsed.resolvedLocalTime?.localTime, "12:00");
  assert.equal(bxSkinParsed.normalizedPayload.recordedAt, "2026-11-22T04:00:00.000Z");

  // Both must appear in 2026-11-22 BX summary, NOT 2026-11-21.
  const bxSum22 = await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1008, method: "tools/call", params: { name: "bx_get_summary", arguments: { date: "2026-11-22" } } }
  });
  const sum22Data = JSON.parse(((bxSum22.data.result as { content: Array<{ text: string }> }).content[0]).text) as {
    optimisticOverlay: { optimisticTotals: { mealCount: number; totalCalories: number; skinCount: number } };
  };
  assert.equal(sum22Data.optimisticOverlay.optimisticTotals.mealCount, 2);
  assert.equal(sum22Data.optimisticOverlay.optimisticTotals.totalCalories, 550);
  assert.equal(sum22Data.optimisticOverlay.optimisticTotals.skinCount, 1);

  const bxSum21 = await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1009, method: "tools/call", params: { name: "bx_get_summary", arguments: { date: "2026-11-21" } } }
  });
  const sum21Data = JSON.parse(((bxSum21.data.result as { content: Array<{ text: string }> }).content[0]).text) as {
    optimisticOverlay: { optimisticTotals: { mealCount: number; skinCount: number } };
  };
  assert.equal(sum21Data.optimisticOverlay.optimisticTotals.mealCount, 3);
  assert.equal(sum21Data.optimisticOverlay.optimisticTotals.skinCount, 0);

  // Zero-calorie update must be accepted on bx_update_food.
  const zeroCalRes = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 1010,
      method: "tools/call",
      params: { name: "bx_update_food", arguments: { id: "pending:bx-early-bjt", calories: 0 } }
    }
  });
  assert.equal((zeroCalRes.data.result as { isError?: boolean }).isError, undefined);
});

test("supports chaox_list_pending, chaox_cancel_pending, in-place pending edits, and transparent synced receipt fallback", async () => {
  const env = makeEnv();
  await callJson(env, "/sync/sx/snapshot", {
    method: "PUT",
    body: {
      bundleId: "ai.chaox.sx",
      appVersion: "1.2.0",
      permission: "appendOnly",
      policy: {
        allowRead: true,
        allowCreate: true,
        allowUpdate: false,
        allowDelete: false,
        allowedDomains: ["projects", "expenses", "incomes", "tags"],
        consentAcknowledged: true
      },
      capabilities: ["catalog", "expenses"],
      catalog: {
        timeZoneIdentifier: "Asia/Shanghai",
        summaryCurrency: "CNY",
        supportedCurrencies: ["CNY"],
        projects: [{ name: "Dining", currency: "CNY", supportsExpense: true }]
      }
    }
  });
  await callJson(env, "/sync/bx/snapshot", {
    method: "PUT",
    body: {
      bundleId: "com.lizhichao.bx",
      appVersion: "1.2.0",
      permission: "appendOnly",
      policy: {
        allowRead: true,
        allowCreate: true,
        allowUpdate: false,
        allowDelete: false,
        allowedDomains: ["food"],
        consentAcknowledged: true
      },
      capabilities: ["food"],
      catalog: { timeZoneIdentifier: "Asia/Shanghai", mealTypes: ["lunch"] }
    }
  });

  await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 1101,
      method: "tools/call",
      params: { name: "sx_record_expense", arguments: { amount: 30, projectName: "Dining", date: "2026-11-22-11", requestId: "edit-me-sx" } }
    }
  });
  await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 1102,
      method: "tools/call",
      params: { name: "bx_record_food", arguments: { name: "Noodles", calories: 400, requestId: "edit-me-bx" } }
    }
  });

  const pendingList = await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1103, method: "tools/call", params: { name: "chaox_list_pending", arguments: {} } }
  });
  const pendingData = JSON.parse(((pendingList.data.result as { content: Array<{ text: string }> }).content[0]).text) as {
    totalCount: number;
    items: Array<{ requestId: string; resolvedLocalTime?: { displayDate?: string } }>;
  };
  assert.equal(pendingData.totalCount, 2);
  assert.equal(pendingData.items[0].resolvedLocalTime?.displayDate, "2026-11-22-11");

  // Patch queued SX create in-place under appendOnly (no duplicate inbox row!).
  const patchSx = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 1104,
      method: "tools/call",
      params: { name: "sx_update_expense", arguments: { pendingRequestId: "edit-me-sx", amount: 42.5, hour: 13 } }
    }
  });
  const patchSxData = JSON.parse(((patchSx.data.result as { content: Array<{ text: string }> }).content[0]).text) as {
    updatedPending: boolean;
    resolvedLocalTime?: { displayDate: string };
  };
  assert.equal(patchSxData.updatedPending, true);
  assert.equal(patchSxData.resolvedLocalTime?.displayDate, "2026-11-22-13");

  // Patch and then cancel queued BX create via pending:<requestId>.
  const patchBx = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 1105,
      method: "tools/call",
      params: { name: "bx_update_food", arguments: { id: "pending:edit-me-bx", calories: 550 } }
    }
  });
  assert.equal(JSON.parse(((patchBx.data.result as { content: Array<{ text: string }> }).content[0]).text).updatedPending, true);

  const cancelBx = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 1106,
      method: "tools/call",
      params: { name: "bx_delete_food", arguments: { id: "pending:edit-me-bx" } }
    }
  });
  assert.equal(JSON.parse(((cancelBx.data.result as { content: Array<{ text: string }> }).content[0]).text).cancelledPending, true);

  // Sync edit-me-sx -> receipt with recordId 888, then test chaox_cancel_pending error + transparent fallback.
  await callJson(env, "/sync/sx/ack", {
    method: "POST",
    body: {
      receipts: [
        {
          schemaVersion: SCHEMA_VERSION,
          requestId: "edit-me-sx",
          app: "sx",
          op: "record_expense",
          status: "applied",
          processedAt: "2026-11-22T06:00:00.000Z",
          recordId: "888"
        }
      ]
    }
  });

  const cancelSynced = await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1107, method: "tools/call", params: { name: "chaox_cancel_pending", arguments: { requestId: "edit-me-sx" } } }
  });
  assert.equal((cancelSynced.data.result as { isError?: boolean }).isError, true);
  assert.match(((cancelSynced.data.result as { content: Array<{ text: string }> }).content[0]).text, /recordId: 888/);

  // Enable readWrite and confirm pendingRequestId falls back transparently to id 888.
  await callJson(env, "/sync/sx/snapshot", {
    method: "PUT",
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
      capabilities: ["expenses"]
    }
  });
  const fallbackUpd = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 1108,
      method: "tools/call",
      params: { name: "sx_update_expense", arguments: { pendingRequestId: "edit-me-sx", note: "Resolved via receipt" } }
    }
  });
  const fallbackData = JSON.parse(((fallbackUpd.data.result as { content: Array<{ text: string }> }).content[0]).text) as {
    resolvedFromSyncedReceipt?: boolean;
    normalizedPayload: { id: number };
  };
  assert.equal(fallbackData.resolvedFromSyncedReceipt, true);
  assert.equal(fallbackData.normalizedPayload.id, 888);

  // Queue another item and test chaox_cancel_pending directly.
  await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 1109,
      method: "tools/call",
      params: { name: "sx_record_expense", arguments: { amount: 15, projectName: "Dining", requestId: "cancel-direct" } }
    }
  });
  const cancelledDirect = await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1110, method: "tools/call", params: { name: "chaox_cancel_pending", arguments: { requestId: "cancel-direct" } } }
  });
  assert.equal(JSON.parse(((cancelledDirect.data.result as { content: Array<{ text: string }> }).content[0]).text).cancelled, true);
});

test("computes pre-pagination aggregates, validates projectName with fuzzy suggestions, and overlays refunds & workouts completely", async () => {
  const env = makeEnv();
  await callJson(env, "/sync/sx/snapshot", {
    method: "PUT",
    body: {
      bundleId: "ai.chaox.sx",
      appVersion: "1.2.0",
      permission: "readWrite",
      policy: {
        allowRead: true,
        allowCreate: true,
        allowUpdate: true,
        allowDelete: true,
        allowedDomains: ["projects", "expenses", "incomes", "tags"],
        consentAcknowledged: true
      },
      capabilities: ["catalog", "expenses", "incomes"],
      catalog: {
        timeZoneIdentifier: "Asia/Shanghai",
        summaryCurrency: "CNY",
        supportedCurrencies: ["CNY", "USD"],
        projects: [
          { name: "EatingDrinkingOut", currency: "CNY", supportsExpense: true, supportsIncome: false },
          { name: "SaaSTools", currency: "USD", supportsExpense: true, supportsIncome: false },
          { name: "Consulting", currency: "CNY", supportsExpense: false, supportsIncome: true }
        ]
      },
      datasets: {
        expenses: [
          { id: 1, projectId: 1, projectName: "EatingDrinkingOut", amount: 100, netAmount: 100, refundTotal: 0, currency: "CNY", tags: ["Dinner"], notes: "", paidAt: "2026-11-22T10:00:00Z", refunds: [] },
          { id: 2, projectId: 1, projectName: "EatingDrinkingOut", amount: 50, netAmount: 50, refundTotal: 0, currency: "CNY", tags: ["Dinner"], notes: "", paidAt: "2026-11-21T10:00:00Z", refunds: [] },
          { id: 3, projectId: 2, projectName: "SaaSTools", amount: 20, netAmount: 20, refundTotal: 0, currency: "USD", tags: ["Tool"], notes: "", paidAt: "2026-11-20T10:00:00Z", refunds: [] }
        ],
        incomes: [
          { id: 10, projectId: 3, projectName: "Consulting", amount: 5000, netAmount: 5000, reversalTotal: 0, currency: "CNY", tags: ["Client"], notes: "", receivedAt: "2026-11-22T04:00:00Z", reversals: [] }
        ]
      }
    }
  });

  // Queue refund against expense #1 + reversal against income #10.
  await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1201, method: "tools/call", params: { name: "sx_record_refund", arguments: { paymentId: 1, amount: 25, requestId: "agg-ref-1" } } }
  });
  await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1202, method: "tools/call", params: { name: "sx_record_income_reversal", arguments: { incomeId: 10, amount: 500, requestId: "agg-rev-1" } } }
  });

  // Paginate with limit: 1 and verify aggregates reflect all 3 expenses + pending refund!
  const expList = await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1203, method: "tools/call", params: { name: "sx_list_expenses", arguments: { limit: 1 } } }
  });
  const expData = JSON.parse(((expList.data.result as { content: Array<{ text: string }> }).content[0]).text) as {
    items: Array<{ id: number; refundTotal: number; netAmount: number }>;
    aggregates: { recordCount: number; totalsByCurrency: Record<string, { gross: number; refund: number; net: number; count: number }> };
  };
  assert.equal(expData.items.length, 1);
  assert.equal(expData.items[0].refundTotal, 25);
  assert.equal(expData.items[0].netAmount, 75);
  assert.equal(expData.aggregates.recordCount, 3);
  assert.equal(expData.aggregates.totalsByCurrency.CNY.net, 125);
  assert.equal(expData.aggregates.totalsByCurrency.USD.net, 20);

  const incList = await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1204, method: "tools/call", params: { name: "sx_list_incomes", arguments: { limit: 1 } } }
  });
  const incData = JSON.parse(((incList.data.result as { content: Array<{ text: string }> }).content[0]).text) as {
    items: Array<{ netAmount: number; reversalTotal: number }>;
    aggregates: { totalsByCurrency: Record<string, { net: number; reversal: number }> };
  };
  assert.equal(incData.items[0].reversalTotal, 500);
  assert.equal(incData.items[0].netAmount, 4500);
  assert.equal(incData.aggregates.totalsByCurrency.CNY.net, 4500);

  // Updating expense projectName to invalid name suggests close matches and blocks invalid move.
  const badProjMove = await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1205, method: "tools/call", params: { name: "sx_update_expense", arguments: { id: 1, projectName: "SaaS" } } }
  });
  assert.equal((badProjMove.data.result as { isError?: boolean }).isError, true);
  assert.match(((badProjMove.data.result as { content: Array<{ text: string }> }).content[0]).text, /SaaSTools/);

  // Test BX food/workout aggregates, reorder overlay, clearType, and unknown exercise warning.
  await callJson(env, "/sync/bx/snapshot", {
    method: "PUT",
    body: {
      bundleId: "com.lizhichao.bx",
      appVersion: "1.2.0",
      permission: "readWrite",
      policy: {
        allowRead: true,
        allowCreate: true,
        allowUpdate: true,
        allowDelete: true,
        allowedDomains: ["food", "workouts"],
        consentAcknowledged: true
      },
      capabilities: ["food", "workouts"],
      datasets: {
        food: [
          { id: "f1", eatenAt: "2026-11-22T04:00:00Z", meal: "lunch", name: "Rice", calories: 500 },
          { id: "f2", eatenAt: "2026-11-22T10:00:00Z", meal: "dinner", name: "Soup", calories: 300 }
        ],
        exercises: [
          { id: "ex-bench", key: "barbellBenchPress", nameZh: "杠铃卧推", nameEn: "Barbell Bench Press", group: "chest", equipment: ["barbell"] }
        ],
        workouts: [
          {
            id: "w1",
            source: "apple_health",
            start: "2026-11-22T08:00:00Z",
            end: "2026-11-22T08:45:00Z",
            durationMinutes: 45,
            activeEnergyKcal: 320,
            healthActivityType: 3000,
            healthActivityName: "Other",
            chosenActivityName: "Strength",
            effectiveActivityName: "Strength",
            canChooseType: true,
            frameReadOnly: true,
            exercises: [
              { entryId: "e1", workoutId: "w1", exerciseId: "ex-bench", exerciseKey: "barbellBenchPress", position: 0, setGroups: [{ reps: 10, sets: 3, weightKg: 60 }] },
              { entryId: "e2", workoutId: "w1", exerciseId: "ex-bench", exerciseKey: "barbellBenchPress", position: 1, setGroups: [{ reps: 8, sets: 2, weightKg: 70 }] }
            ]
          }
        ]
      }
    }
  });

  await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1206, method: "tools/call", params: { name: "bx_reorder_workout_exercises", arguments: { workoutId: "w1", entryIds: ["e2", "e1"] } } }
  });
  await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1207, method: "tools/call", params: { name: "bx_update_workout_type", arguments: { workoutId: "w1", activityType: null } } }
  });

  const wkList = await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1208, method: "tools/call", params: { name: "bx_list_workouts", arguments: {} } }
  });
  const wkData = JSON.parse(((wkList.data.result as { content: Array<{ text: string }> }).content[0]).text) as {
    items: Array<{ effectiveActivityName: string; exercises: Array<{ entryId: string }> }>;
    aggregates: { totalSets: number; totalVolumeKg: number };
  };
  assert.equal(wkData.items[0].effectiveActivityName, "Other");
  assert.deepEqual(wkData.items[0].exercises.map((e) => e.entryId), ["e2", "e1"]);
  assert.equal(wkData.aggregates.totalSets, 5);
  assert.equal(wkData.aggregates.totalVolumeKg, 2920); // 3*10*60 + 2*8*70 = 1800 + 1120 = 2920

  const foodList = await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1209, method: "tools/call", params: { name: "bx_list_food", arguments: { limit: 1 } } }
  });
  const foodData = JSON.parse(((foodList.data.result as { content: Array<{ text: string }> }).content[0]).text) as {
    items: unknown[];
    aggregates: { recordCount: number; totalCalories: number };
  };
  assert.equal(foodData.items.length, 1);
  assert.equal(foodData.aggregates.recordCount, 2);
  assert.equal(foodData.aggregates.totalCalories, 800);

  // Unknown exercise gives warning + suggestedExercises without breaking enqueue.
  const warnEx = await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1210, method: "tools/call", params: { name: "bx_add_workout_exercise", arguments: { workoutId: "w1", exercise: "Bench Pres Typo" } } }
  });
  const warnData = JSON.parse(((warnEx.data.result as { content: Array<{ text: string }> }).content[0]).text) as {
    exerciseWarning?: string;
    suggestedExercises?: Array<{ key: string }>;
  };
  assert.match(warnData.exerciseWarning ?? "", /library/);
  assert.equal(warnData.suggestedExercises?.[0]?.key, "barbellBenchPress");
});

test("exposes chaox_get_briefing, chaox_get_preferences/chaox_update_preferences, protocol negotiation, and scoped /mcp endpoints", async () => {
  const env = makeEnv();

  // Save preferences via append, then verify in chaox_get_preferences and chaox_get_status.
  const prefUpd = await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1301, method: "tools/call", params: { name: "chaox_update_preferences", arguments: { append: "- Log coffee under EatingDrinkingOut" } } }
  });
  const prefData = JSON.parse(((prefUpd.data.result as { content: Array<{ text: string }> }).content[0]).text) as { content: string };
  assert.match(prefData.content, /Log coffee under EatingDrinkingOut/);

  // Connect SX readOnly and BX disabled -> chaox_get_briefing reports SX and skips disabled BX cleanly.
  await callJson(env, "/sync/sx/snapshot", {
    method: "PUT",
    body: {
      bundleId: "ai.chaox.sx",
      appVersion: "1.2.0",
      permission: "readOnly",
      policy: { allowRead: true, allowCreate: false, allowUpdate: false, allowDelete: false, allowedDomains: ["projects", "expenses", "tags"], consentAcknowledged: true },
      capabilities: ["catalog", "summary"],
      catalog: { timeZoneIdentifier: "Asia/Shanghai", summaryCurrency: "CNY", projects: [{ name: "EatingDrinkingOut", currency: "CNY", supportsExpense: true }], tags: ["Coffee"] },
      summary: { summaryCurrency: "CNY", expense: { today: { period: "today", mode: "expense", currency: "CNY", netTotal: 28, recordCount: 1 } } }
    }
  });
  await callJson(env, "/sync/bx/snapshot", {
    method: "PUT",
    body: {
      bundleId: "com.lizhichao.bx",
      appVersion: "1.2.0",
      permission: "disabled",
      policy: { allowRead: false, allowCreate: false, allowUpdate: false, allowDelete: false, allowedDomains: ["food"], consentAcknowledged: true },
      capabilities: []
    }
  });

  const briefing = await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1302, method: "tools/call", params: { name: "chaox_get_briefing", arguments: {} } }
  });
  const briefData = JSON.parse(((briefing.data.result as { content: Array<{ text: string }> }).content[0]).text) as {
    hasCustomPreferences: boolean;
    sx: { enabled: boolean; expense: { today: { optimisticSameCurrencyTotal: number } }; expenseProjects: Array<{ name: string }> };
    bx: { enabled: boolean; reason: string };
  };
  assert.equal(briefData.hasCustomPreferences, true);
  assert.equal(briefData.sx.enabled, true);
  assert.equal(briefData.sx.expense.today.optimisticSameCurrencyTotal, 28);
  assert.equal(briefData.sx.expenseProjects[0].name, "EatingDrinkingOut");
  assert.equal(briefData.bx.enabled, false);

  // Protocol negotiation echoes supported newer version 2025-06-18.
  const initNew = await callJson(env, "/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1303, method: "initialize", params: { protocolVersion: "2025-06-18" } }
  });
  assert.equal((initNew.data.result as { protocolVersion: string }).protocolVersion, "2025-06-18");

  // Scoped /mcp?apps=sx&readonly=1 filters tools/list and blocks write calls.
  const scopedList = await callJson(env, "/mcp?apps=sx&readonly=1", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1304, method: "tools/list" }
  });
  const scopedTools = (scopedList.data.result as { tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }> }).tools;
  assert.ok(scopedTools.every((t) => t.annotations?.readOnlyHint === true));
  assert.ok(scopedTools.some((t) => t.name === "sx_list_expenses"));
  assert.ok(!scopedTools.some((t) => t.name === "bx_list_sleep"));

  const blockedCall = await callJson(env, "/mcp?apps=sx&readonly=1", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1305, method: "tools/call", params: { name: "sx_record_expense", arguments: { amount: 10, projectName: "EatingDrinkingOut" } } }
  });
  assert.equal((blockedCall.data.result as { isError?: boolean }).isError, true);
});
