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
  assert.equal(tools.length, 67);

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
  assert.equal(tools.length, 67);

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
