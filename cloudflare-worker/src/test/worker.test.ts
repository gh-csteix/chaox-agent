import assert from "node:assert/strict";
import test from "node:test";
import { handleWorkerRequest } from "../index.js";
import { SCHEMA_VERSION, WorkerEnv } from "../types.js";
import { createTestDatabase } from "./d1-mock.js";

function makeEnv(token = "secret-worker-token"): WorkerEnv {
  return {
    DB: createTestDatabase(),
    CHAOX_AUTH_TOKEN: token
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

  // Disable sleep domain on next snapshot -> D1 deletes sleep dataset row and rejects bx_list_sleep.
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

test("enforces SX project child lock on delete, full CRUD, and wipes D1 completely on DELETE /sync/:app/data", async () => {
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
