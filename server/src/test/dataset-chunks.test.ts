import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../app.js";
import { createMemoryDatabase } from "../sqlite.js";
import { ExchangeStore } from "../store.js";
import {
  ChunkedDatasetManifest,
  DEFAULT_DATASET_CHUNK_MAX_BYTES,
  parseChunkedDatasetManifest,
  splitUtf8Chunks
} from "../store-helpers.js";
import { BxFoodRecord, ServerEnv, SqlDatabase, SxExpenseRecord, SxIncomeRecord } from "../types.js";

const TEXT_ENCODER = new TextEncoder();

function utf8Bytes(text: string): number {
  return TEXT_ENCODER.encode(text).byteLength;
}

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
        continue;
      }
      return true;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function assertValidChunkSplit(input: string, maxChunkBytes: number): ReturnType<typeof splitUtf8Chunks> {
  const result = splitUtf8Chunks(input, maxChunkBytes);
  assert.equal(result.chunks.join(""), input);

  let sumBytes = 0;
  for (const chunk of result.chunks) {
    if (input.length > 0) {
      assert.ok(chunk.length > 0, "non-empty input must never produce an empty chunk");
    }
    const bytes = utf8Bytes(chunk);
    assert.ok(bytes <= maxChunkBytes, `chunk byte length ${bytes} exceeded maxChunkBytes ${maxChunkBytes}`);
    assert.equal(hasLoneSurrogate(chunk), false, "chunk must not contain lone UTF-16 surrogates");

    if (chunk.length > 0) {
      const firstCode = chunk.charCodeAt(0);
      const lastCode = chunk.charCodeAt(chunk.length - 1);
      assert.equal(
        firstCode >= 0xdc00 && firstCode <= 0xdfff,
        false,
        "chunk must not start with a trailing low surrogate"
      );
      assert.equal(
        lastCode >= 0xd800 && lastCode <= 0xdbff,
        false,
        "chunk must not end with a leading high surrogate"
      );
    }
    sumBytes += bytes;
  }

  const expectedBytes = utf8Bytes(input);
  assert.equal(sumBytes, expectedBytes);
  if (result.chunked) {
    assert.ok(result.chunks.length > 1);
    assert.equal(result.totalBytes, expectedBytes);
  } else {
    assert.equal(result.chunks.length, 1);
  }
  return result;
}

function makeExpense(id: number, overrides: Partial<SxExpenseRecord> = {}): SxExpenseRecord {
  const day = String(((id - 1) % 28) + 1).padStart(2, "0");
  const hour = String(id % 24).padStart(2, "0");
  return {
    id,
    projectId: 1,
    projectName: "Daily Meals",
    amount: 38.5,
    netAmount: 38.5,
    refundTotal: 0,
    currency: "CNY",
    tags: ["Dining", "🍜面食"],
    notes: `Record #${id} 午餐牛肉拉面 🍜🔥`,
    paidAt: `2026-11-${day}T${hour}:00:00.000Z`,
    localDate: `2026-11-${day}`,
    localHour: Number(hour),
    displayDate: `2026-11-${day}-${hour}`,
    ...overrides
  };
}

function makeIncome(id: number, overrides: Partial<SxIncomeRecord> = {}): SxIncomeRecord {
  return {
    id,
    projectId: 2,
    projectName: "Salary",
    amount: 1000 + id,
    netAmount: 1000 + id,
    reversalTotal: 0,
    currency: "CNY",
    tags: ["工资", "💰"],
    notes: `Income #${id} 月度结算 💼🎉`,
    receivedAt: "2026-11-15T04:00:00.000Z",
    localDate: "2026-11-15",
    ...overrides
  };
}

function makeFood(id: number, suffix = ""): BxFoodRecord {
  return {
    id: `food-${id}`,
    eatenAt: "2026-11-22T04:30:00.000Z",
    meal: "lunch",
    name: `鸡胸肉沙拉配荞麦面 #${id} 🥗🍜${suffix}`,
    calories: 480 + id
  };
}

async function getDatasetRow(
  db: SqlDatabase,
  app: string,
  domain: string
): Promise<{ payload_json: string; record_count: number } | null> {
  return db
    .prepare("SELECT payload_json, record_count FROM app_dataset WHERE app = ? AND domain = ?")
    .bind(app, domain)
    .first<{ payload_json: string; record_count: number }>();
}

async function listChunkRows(
  db: SqlDatabase,
  app: string,
  domain: string
): Promise<Array<{ chunk_index: number; chunk_data: string }>> {
  const { results } = await db
    .prepare("SELECT chunk_index, chunk_data FROM app_dataset_chunks WHERE app = ? AND domain = ? ORDER BY chunk_index ASC")
    .bind(app, domain)
    .all<{ chunk_index: number; chunk_data: string }>();
  return results;
}

async function countAppRows(db: SqlDatabase, table: "app_dataset" | "app_dataset_chunks", app: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS cnt FROM ${table} WHERE app = ?`)
    .bind(app)
    .first<{ cnt: number }>();
  return Number(row?.cnt ?? 0);
}

async function callJson(
  env: ServerEnv,
  pathname: string,
  options: { method?: string; body?: unknown } = {}
): Promise<{ status: number; data: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.CHAOX_AUTH_TOKEN}`
  };
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
  id: number,
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ isError?: boolean; payload: Record<string, unknown> }> {
  const res = await callJson(env, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args }
    }
  });
  assert.equal(res.status, 200);
  const result = res.data.result as { isError?: boolean; content: Array<{ text: string }> };
  return {
    isError: result.isError,
    payload: JSON.parse(result.content[0].text) as Record<string, unknown>
  };
}

// MARK: - Unit tests: splitUtf8Chunks

test("splitUtf8Chunks handles fast-path inline, exact boundary, boundary + 1, and invalid maxChunkBytes", () => {
  assert.equal(DEFAULT_DATASET_CHUNK_MAX_BYTES, 1_000_000);

  // Empty string stays inline via fast path.
  const empty = assertValidChunkSplit("", 16);
  assert.deepEqual(empty, { chunked: false, chunks: [""] });

  // Fast-path inline (text.length * 3 <= maxChunkBytes).
  const shortAscii = assertValidChunkSplit("hello", 16);
  assert.deepEqual(shortAscii, { chunked: false, chunks: ["hello"] });

  // Bypasses fast-path (10 * 3 = 30 > 10) yet actual UTF-8 byte length is <= maxChunkBytes.
  const exactAscii = assertValidChunkSplit("0123456789", 10);
  assert.deepEqual(exactAscii, { chunked: false, chunks: ["0123456789"] });

  // Boundary + 1 byte splits into two chunks.
  const asciiPlusOne = assertValidChunkSplit("0123456789a", 10);
  assert.equal(asciiPlusOne.chunked, true);
  assert.deepEqual(asciiPlusOne.chunks, ["0123456789", "a"]);
  if (asciiPlusOne.chunked) {
    assert.equal(asciiPlusOne.totalBytes, 11);
  }

  // Exact multi-byte CJK boundary (4 chars * 3 bytes = 12 bytes) stays inline.
  const exactCjk = assertValidChunkSplit("中文测试", 12);
  assert.deepEqual(exactCjk, { chunked: false, chunks: ["中文测试"] });

  // CJK boundary + 1 byte splits cleanly.
  const cjkPlusOne = assertValidChunkSplit("中文测试a", 12);
  assert.equal(cjkPlusOne.chunked, true);
  assert.deepEqual(cjkPlusOne.chunks, ["中文测试", "a"]);

  // Exact 4-byte emoji boundary (3 emoji * 4 bytes = 12 bytes) stays inline.
  const exactEmoji = assertValidChunkSplit("🍜🍜🍜", 12);
  assert.deepEqual(exactEmoji, { chunked: false, chunks: ["🍜🍜🍜"] });

  // Emoji boundary + 1 byte splits cleanly.
  const emojiPlusOne = assertValidChunkSplit("🍜🍜🍜x", 12);
  assert.equal(emojiPlusOne.chunked, true);
  assert.deepEqual(emojiPlusOne.chunks, ["🍜🍜🍜", "x"]);

  // Minimum valid threshold of 4 bytes supports 4-byte emoji without splitting surrogate pairs.
  const minThreshold = assertValidChunkSplit("🍜🔥", 4);
  assert.equal(minThreshold.chunked, true);
  assert.deepEqual(minThreshold.chunks, ["🍜", "🔥"]);

  // Invalid maxChunkBytes (< 4 or non-integer) must throw.
  for (const invalid of [3, 2, 1, 0, -1, -100, 3.5, 4.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => splitUtf8Chunks("hello", invalid), Error);
  }
});

test("splitUtf8Chunks never splits multi-byte CJK or emoji surrogate pairs across chunk boundaries", () => {
  // Explicit alignments where a 4-byte emoji starts with 1, 2, or 3 bytes left in the chunk.
  for (const sample of ["a🍜b", "ab🍜c", "abc🍜d", "a中b", "ab中c", "aéb", "abéc", "中🍜文🔥测🎉试"]) {
    for (const limit of [4, 5, 6, 7, 8]) {
      assertValidChunkSplit(sample, limit);
    }
  }

  // Mixed ASCII, 2-byte accented Latin, 3-byte CJK, 4-byte emoji, and ZWJ sequences across many thresholds.
  const mixed = "早餐豆浆油条🍜🔥🎉 café naïve résumé 中文备注2026 👨‍👩‍👧‍👦🚀 ".repeat(6);
  for (const limit of [4, 5, 6, 7, 8, 9, 10, 11, 13, 17, 32, 64]) {
    const res = assertValidChunkSplit(mixed, limit);
    assert.equal(res.chunked, true);
  }
});

// MARK: - Unit tests: parseChunkedDatasetManifest

test("parseChunkedDatasetManifest parses valid chunked_v1 manifests and rejects non-manifest payloads", () => {
  const valid: ChunkedDatasetManifest = {
    __chaoxDatasetStorage: "chunked_v1",
    chunkCount: 3,
    byteLength: 2_500_000
  };
  assert.deepEqual(parseChunkedDatasetManifest(JSON.stringify(valid)), valid);

  const zeroByteValid: ChunkedDatasetManifest = {
    __chaoxDatasetStorage: "chunked_v1",
    chunkCount: 1,
    byteLength: 0
  };
  assert.deepEqual(parseChunkedDatasetManifest(JSON.stringify(zeroByteValid)), zeroByteValid);

  const rejectedPayloads = [
    "",
    "[]",
    '[{"id":1,"notes":"__chaoxDatasetStorage"}]',
    '{"id":1,"name":"normal object"}',
    '{"__chaoxDatasetStorage":"chunked_v2","chunkCount":2,"byteLength":100}',
    '{"__chaoxDatasetStorage":"","chunkCount":2,"byteLength":100}',
    '{"__chaoxDatasetStorage":"chunked_v1","chunkCount":0,"byteLength":100}',
    '{"__chaoxDatasetStorage":"chunked_v1","chunkCount":-1,"byteLength":100}',
    '{"__chaoxDatasetStorage":"chunked_v1","chunkCount":1.5,"byteLength":100}',
    '{"__chaoxDatasetStorage":"chunked_v1","chunkCount":"2","byteLength":100}',
    '{"__chaoxDatasetStorage":"chunked_v1","chunkCount":2,"byteLength":-1}',
    '{"__chaoxDatasetStorage":"chunked_v1","chunkCount":2,"byteLength":12.5}',
    '{"__chaoxDatasetStorage":"chunked_v1","chunkCount":2,"byteLength":"100"}',
    '{"__chaoxDatasetStorage":"chunked_v1","chunkCount":2}',
    '{"__chaoxDatasetStorage":"chunked_v1", broken json'
  ];

  for (const raw of rejectedPayloads) {
    assert.equal(parseChunkedDatasetManifest(raw), null, `expected null for payload: ${raw}`);
  }
});

// MARK: - ExchangeStore tests with custom small datasetChunkMaxBytes

test("ExchangeStore validates datasetChunkMaxBytes option", () => {
  const db = createMemoryDatabase();
  assert.throws(() => new ExchangeStore(db, { datasetChunkMaxBytes: 3 }), Error);
  assert.throws(() => new ExchangeStore(db, { datasetChunkMaxBytes: 0 }), Error);
  assert.throws(() => new ExchangeStore(db, { datasetChunkMaxBytes: 12.5 }), Error);
  assert.doesNotThrow(() => new ExchangeStore(db, { datasetChunkMaxBytes: 256 }));
});

test("ExchangeStore chunks large snapshots, removes stale trailing chunks, and moves back inline when shrunk", async () => {
  const db = createMemoryDatabase();
  const maxChunkBytes = 256;
  const store = new ExchangeStore(db, { datasetChunkMaxBytes: maxChunkBytes });

  const largeExpenses = Array.from({ length: 12 }, (_, idx) =>
    makeExpense(idx + 1, {
      notes: `大型消费记录 #${idx + 1} 牛肉拉面加蛋 🍜🔥 — 详尽备注信息填充内容`
    })
  );
  const smallTags = [{ id: 1, name: "Dining", expenseCount: 12, incomeCount: 0 }];

  const baseSnapshot = {
    bundleId: "ai.chaox.sx",
    appVersion: "1.3.0",
    permission: "readWrite" as const,
    policy: {
      allowRead: true,
      allowCreate: true,
      allowUpdate: true,
      allowDelete: true,
      allowedDomains: ["projects", "expenses", "incomes", "tags", "slogans"],
      consentAcknowledged: true
    },
    capabilities: ["catalog", "summary", "datasets"]
  };

  // 1) Initial upload exceeds 256B for expenses while tags stays inline.
  await store.putAppSnapshot("sx", {
    ...baseSnapshot,
    datasets: { expenses: largeExpenses, tags: smallTags }
  });

  const expDatasetRow = await getDatasetRow(db, "sx", "expenses");
  assert.ok(expDatasetRow);
  assert.equal(expDatasetRow.record_count, largeExpenses.length);
  const manifest = parseChunkedDatasetManifest(expDatasetRow.payload_json);
  assert.ok(manifest, "large expenses dataset should be stored as a chunked_v1 manifest");
  assert.equal(manifest.byteLength, utf8Bytes(JSON.stringify(largeExpenses)));
  assert.ok(manifest.chunkCount >= 4, `expected >= 4 chunks, got ${manifest.chunkCount}`);

  const initialChunks = await listChunkRows(db, "sx", "expenses");
  assert.equal(initialChunks.length, manifest.chunkCount);
  initialChunks.forEach((row, idx) => {
    assert.equal(row.chunk_index, idx);
    assert.ok(utf8Bytes(row.chunk_data) <= maxChunkBytes);
  });

  // Small tags dataset stayed inline with zero rows in app_dataset_chunks.
  const tagDatasetRow = await getDatasetRow(db, "sx", "tags");
  assert.ok(tagDatasetRow);
  assert.equal(parseChunkedDatasetManifest(tagDatasetRow.payload_json), null);
  assert.equal((await listChunkRows(db, "sx", "tags")).length, 0);

  // readDataset and getStatus return exact data and counts.
  const readBack1 = await store.readDataset<SxExpenseRecord>("sx", "expenses");
  assert.deepEqual(readBack1, largeExpenses);
  const status1 = (await store.getStatus()) as {
    apps: { sx: { datasetCounts: Record<string, number> } };
  };
  assert.equal(status1.apps.sx.datasetCounts.expenses, largeExpenses.length);
  assert.equal(status1.apps.sx.datasetCounts.tags, smallTags.length);

  // 2) Re-uploading fewer records (still chunked) removes stale trailing chunks.
  const mediumExpenses = largeExpenses.slice(0, 3);
  assert.ok(utf8Bytes(JSON.stringify(mediumExpenses)) > maxChunkBytes);
  await store.putAppSnapshot("sx", {
    ...baseSnapshot,
    datasets: { expenses: mediumExpenses }
  });

  const expDatasetRow2 = await getDatasetRow(db, "sx", "expenses");
  assert.ok(expDatasetRow2);
  const manifest2 = parseChunkedDatasetManifest(expDatasetRow2.payload_json);
  assert.ok(manifest2);
  assert.ok(manifest2.chunkCount < manifest.chunkCount, "re-upload should require fewer chunks");

  const mediumChunks = await listChunkRows(db, "sx", "expenses");
  assert.equal(mediumChunks.length, manifest2.chunkCount);
  mediumChunks.forEach((row, idx) => assert.equal(row.chunk_index, idx));
  assert.deepEqual(await store.readDataset<SxExpenseRecord>("sx", "expenses"), mediumExpenses);

  // 3) Shrinking below threshold moves payload back inline and deletes all chunk rows.
  const tinyExpenses = [makeExpense(99, { notes: "tea", tags: [] })];
  assert.ok(utf8Bytes(JSON.stringify(tinyExpenses)) <= maxChunkBytes);
  await store.putAppSnapshot("sx", {
    ...baseSnapshot,
    datasets: { expenses: tinyExpenses }
  });

  const expDatasetRow3 = await getDatasetRow(db, "sx", "expenses");
  assert.ok(expDatasetRow3);
  assert.equal(parseChunkedDatasetManifest(expDatasetRow3.payload_json), null);
  assert.equal((await listChunkRows(db, "sx", "expenses")).length, 0);
  assert.deepEqual(await store.readDataset<SxExpenseRecord>("sx", "expenses"), tinyExpenses);

  const status3 = (await store.getStatus()) as {
    apps: { sx: { datasetCounts: Record<string, number> } };
  };
  assert.equal(status3.apps.sx.datasetCounts.expenses, 1);
});

test("ExchangeStore putAppDatasetDomain chunks large data and deletes both tables when called with null", async () => {
  const db = createMemoryDatabase();
  const store = new ExchangeStore(db, { datasetChunkMaxBytes: 256 });

  const largeIncomes = Array.from({ length: 8 }, (_, idx) => makeIncome(idx + 1));
  assert.ok(utf8Bytes(JSON.stringify(largeIncomes)) > 256);

  const putRes = await store.putAppDatasetDomain("sx", "incomes", largeIncomes);
  assert.equal(putRes.recordCount, largeIncomes.length);

  const datasetRow = await getDatasetRow(db, "sx", "incomes");
  assert.ok(datasetRow);
  const manifest = parseChunkedDatasetManifest(datasetRow.payload_json);
  assert.ok(manifest);
  assert.ok(manifest.chunkCount >= 2);
  assert.equal((await listChunkRows(db, "sx", "incomes")).length, manifest.chunkCount);
  assert.deepEqual(await store.readDataset<SxIncomeRecord>("sx", "incomes"), largeIncomes);

  // Deleting domain via null removes rows from both app_dataset and app_dataset_chunks.
  const delRes = await store.putAppDatasetDomain("sx", "incomes", null);
  assert.equal(delRes.deleted, true);
  assert.equal(await getDatasetRow(db, "sx", "incomes"), null);
  assert.equal((await listChunkRows(db, "sx", "incomes")).length, 0);
  assert.equal(await store.readDataset<SxIncomeRecord>("sx", "incomes"), null);
});

test("ExchangeStore prunes both app_dataset and app_dataset_chunks when removing a chunked domain from allowedDomains", async () => {
  const db = createMemoryDatabase();
  const store = new ExchangeStore(db, { datasetChunkMaxBytes: 256 });

  const largeExpenses = Array.from({ length: 6 }, (_, idx) => makeExpense(idx + 1));
  const largeIncomes = Array.from({ length: 6 }, (_, idx) => makeIncome(idx + 1));

  await store.putAppSnapshot("sx", {
    bundleId: "ai.chaox.sx",
    appVersion: "1.3.0",
    permission: "readWrite",
    policy: {
      allowRead: true,
      allowCreate: true,
      allowUpdate: true,
      allowDelete: true,
      allowedDomains: ["projects", "expenses", "incomes", "tags", "slogans"],
      consentAcknowledged: true
    },
    capabilities: ["datasets"],
    datasets: { expenses: largeExpenses, incomes: largeIncomes }
  });

  assert.ok((await listChunkRows(db, "sx", "expenses")).length >= 2);
  assert.ok((await listChunkRows(db, "sx", "incomes")).length >= 2);

  // Remove 'incomes' from allowedDomains without sending it in datasets -> pruned automatically.
  await store.putAppSnapshot("sx", {
    bundleId: "ai.chaox.sx",
    appVersion: "1.3.0",
    permission: "readWrite",
    policy: {
      allowRead: true,
      allowCreate: true,
      allowUpdate: true,
      allowDelete: true,
      allowedDomains: ["projects", "expenses", "tags", "slogans"],
      consentAcknowledged: true
    },
    capabilities: ["datasets"]
  });

  assert.equal(await getDatasetRow(db, "sx", "incomes"), null);
  assert.equal((await listChunkRows(db, "sx", "incomes")).length, 0);
  assert.equal(await store.readDataset("sx", "incomes"), null);

  // Allowed 'expenses' domain and its chunks remain intact.
  assert.ok((await listChunkRows(db, "sx", "expenses")).length >= 2);
  assert.deepEqual(await store.readDataset<SxExpenseRecord>("sx", "expenses"), largeExpenses);
});

test("ExchangeStore revoking allowRead clears app_dataset and app_dataset_chunks only for that app", async () => {
  const db = createMemoryDatabase();
  const store = new ExchangeStore(db, { datasetChunkMaxBytes: 256 });

  const sxExpenses = Array.from({ length: 6 }, (_, idx) => makeExpense(idx + 1));
  const bxFoods = Array.from({ length: 8 }, (_, idx) => makeFood(idx + 1));

  await store.putAppSnapshot("sx", {
    bundleId: "ai.chaox.sx",
    appVersion: "1.3.0",
    permission: "readWrite",
    policy: {
      allowRead: true,
      allowCreate: true,
      allowUpdate: true,
      allowDelete: true,
      allowedDomains: ["expenses"],
      consentAcknowledged: true
    },
    capabilities: ["datasets"],
    datasets: { expenses: sxExpenses }
  });

  await store.putAppSnapshot("bx", {
    bundleId: "ai.chaox.bx",
    appVersion: "1.3.0",
    permission: "readWrite",
    policy: {
      allowRead: true,
      allowCreate: true,
      allowUpdate: true,
      allowDelete: true,
      allowedDomains: ["food"],
      consentAcknowledged: true
    },
    capabilities: ["datasets"],
    datasets: { food: bxFoods }
  });

  assert.ok((await countAppRows(db, "app_dataset_chunks", "sx")) >= 2);
  const bxChunkCountBefore = await countAppRows(db, "app_dataset_chunks", "bx");
  assert.ok(bxChunkCountBefore >= 2);

  // Revoke allowRead on SX.
  await store.putAppSnapshot("sx", {
    bundleId: "ai.chaox.sx",
    appVersion: "1.3.0",
    permission: "disabled",
    policy: {
      allowRead: false,
      allowCreate: false,
      allowUpdate: false,
      allowDelete: false,
      allowedDomains: ["expenses"],
      consentAcknowledged: true
    },
    capabilities: []
  });

  assert.equal(await countAppRows(db, "app_dataset", "sx"), 0);
  assert.equal(await countAppRows(db, "app_dataset_chunks", "sx"), 0);

  // BX datasets and chunks remain completely intact.
  assert.equal(await countAppRows(db, "app_dataset", "bx"), 1);
  assert.equal(await countAppRows(db, "app_dataset_chunks", "bx"), bxChunkCountBefore);
  assert.deepEqual(await store.readDataset<BxFoodRecord>("bx", "food"), bxFoods);
});

test("ExchangeStore wipeAppData clears app_dataset_chunks only for the wiped app", async () => {
  const db = createMemoryDatabase();
  const store = new ExchangeStore(db, { datasetChunkMaxBytes: 256 });

  const sxExpenses = Array.from({ length: 6 }, (_, idx) => makeExpense(idx + 1));
  const bxFoods = Array.from({ length: 8 }, (_, idx) => makeFood(idx + 1));

  await store.putAppSnapshot("sx", {
    bundleId: "ai.chaox.sx",
    appVersion: "1.3.0",
    permission: "readWrite",
    capabilities: ["datasets"],
    datasets: { expenses: sxExpenses }
  });
  await store.putAppSnapshot("bx", {
    bundleId: "ai.chaox.bx",
    appVersion: "1.3.0",
    permission: "readWrite",
    capabilities: ["datasets"],
    datasets: { food: bxFoods }
  });

  assert.ok((await countAppRows(db, "app_dataset_chunks", "sx")) >= 2);
  const bxChunkCountBefore = await countAppRows(db, "app_dataset_chunks", "bx");
  assert.ok(bxChunkCountBefore >= 2);

  await store.wipeAppData("sx");

  assert.equal(await countAppRows(db, "app_dataset", "sx"), 0);
  assert.equal(await countAppRows(db, "app_dataset_chunks", "sx"), 0);
  assert.equal(await countAppRows(db, "app_dataset", "bx"), 1);
  assert.equal(await countAppRows(db, "app_dataset_chunks", "bx"), bxChunkCountBefore);
  assert.deepEqual(await store.readDataset<BxFoodRecord>("bx", "food"), bxFoods);
});

test("ExchangeStore readDataset throws an incomplete-dataset error when chunks are missing or non-contiguous", async () => {
  const db = createMemoryDatabase();
  const store = new ExchangeStore(db, { datasetChunkMaxBytes: 256 });

  const expenses = Array.from({ length: 10 }, (_, idx) => makeExpense(idx + 1));
  await store.putAppSnapshot("sx", {
    bundleId: "ai.chaox.sx",
    appVersion: "1.3.0",
    permission: "readWrite",
    capabilities: ["datasets"],
    datasets: { expenses }
  });

  const chunksBefore = await listChunkRows(db, "sx", "expenses");
  assert.ok(chunksBefore.length >= 4);

  // Case 1: Deleting a middle chunk row causes readDataset to reject with an incomplete-dataset error.
  await db
    .prepare("DELETE FROM app_dataset_chunks WHERE app = ? AND domain = ? AND chunk_index = ?")
    .bind("sx", "expenses", 1)
    .run();

  await assert.rejects(
    () => store.readDataset<SxExpenseRecord>("sx", "expenses"),
    /incomplete/i
  );

  // Case 2: Non-contiguous chunk_index with the same total row count also throws an incomplete-dataset error.
  await db
    .prepare(
      "INSERT INTO app_dataset_chunks (app, domain, chunk_index, chunk_data, updated_at) VALUES (?, ?, ?, ?, ?)"
    )
    .bind("sx", "expenses", 99, chunksBefore[1].chunk_data, new Date().toISOString())
    .run();

  await assert.rejects(
    () => store.readDataset<SxExpenseRecord>("sx", "expenses"),
    /incomplete/i
  );
});

// MARK: - End-to-end HTTP test with default 1,000,000-byte threshold

test("handleRequest transparently chunks a >2.2 MB UTF-8 SX expenses snapshot and serves chaox_get_status & sx_list_expenses", async () => {
  const db = createMemoryDatabase();
  const env: ServerEnv = {
    DB: db,
    CHAOX_AUTH_TOKEN: "chunk-e2e-secret-token"
  };

  // Build >2.2 MB UTF-8 SX expenses payload with rich Chinese text and 4-byte emoji.
  const paddingText = "北京市朝阳区三里屯太古里商圈晚餐聚会订单详情备注🍜🔥🎉🍱🍣☕️".repeat(4);
  const recordCount = 4600;
  const middleIndex = Math.floor(recordCount / 2);
  const headNote = `首条哨兵记录 早餐豆浆油条🍜🔥 — ${paddingText}`;
  const midNote = `跨分块中段哨兵 🍱🍣中文边界校验🎉 — ${paddingText}`;
  const tailNote = `末尾哨兵记录 深夜拉面尾标🍜🔥🎉 — ${paddingText}`;

  const expenses: SxExpenseRecord[] = [];
  for (let i = 0; i < recordCount; i += 1) {
    const id = i + 1;
    const notes =
      i === 0
        ? headNote
        : i === middleIndex
          ? midNote
          : i === recordCount - 1
            ? tailNote
            : `消费记录 #${id} ${paddingText}`;
    expenses.push(
      makeExpense(id, {
        amount: 42.5,
        netAmount: 42.5,
        notes,
        tags: ["餐饮", "🍜美食", "日常"]
      })
    );
  }

  const rawPayloadBytes = utf8Bytes(JSON.stringify(expenses));
  assert.ok(
    rawPayloadBytes > 2_200_000,
    `expected > 2.2 MB UTF-8 payload, got ${rawPayloadBytes} bytes`
  );

  // 1) Upload snapshot via HTTP PUT /sync/sx/snapshot.
  const uploadRes = await callJson(env, "/sync/sx/snapshot", {
    method: "PUT",
    body: {
      bundleId: "ai.chaox.sx",
      appVersion: "1.4.0",
      permission: "readWrite",
      policy: {
        allowRead: true,
        allowCreate: true,
        allowUpdate: true,
        allowDelete: true,
        allowedDomains: ["projects", "expenses", "incomes", "tags", "slogans"],
        consentAcknowledged: true
      },
      capabilities: ["catalog", "summary", "datasets", "record_expense"],
      catalog: {
        timeZoneIdentifier: "Asia/Shanghai",
        summaryCurrency: "CNY",
        supportedCurrencies: ["CNY", "USD"],
        projects: [{ name: "Daily Meals", currency: "CNY", supportsExpense: true, supportsIncome: false }],
        tags: ["餐饮", "🍜美食", "日常"]
      },
      datasets: {
        expenses
      }
    }
  });
  assert.equal(uploadRes.status, 200);

  // 2) Inspect SQLite tables directly to verify manifest and chunk bounds.
  const datasetRow = await getDatasetRow(db, "sx", "expenses");
  assert.ok(datasetRow);
  assert.equal(datasetRow.record_count, recordCount);
  assert.ok(
    utf8Bytes(datasetRow.payload_json) < 200,
    `expected small manifest (< 200 bytes), got ${utf8Bytes(datasetRow.payload_json)} bytes`
  );

  const manifest = parseChunkedDatasetManifest(datasetRow.payload_json);
  assert.ok(manifest, "app_dataset.payload_json must be a valid chunked_v1 manifest");
  assert.ok(manifest.chunkCount >= 3, `expected >= 3 chunks, got ${manifest.chunkCount}`);
  assert.equal(manifest.byteLength, rawPayloadBytes);

  const chunks = await listChunkRows(db, "sx", "expenses");
  assert.equal(chunks.length, manifest.chunkCount);
  assert.ok(chunks.length >= 3);
  let totalChunkBytes = 0;
  chunks.forEach((row, idx) => {
    assert.equal(row.chunk_index, idx);
    const bytes = utf8Bytes(row.chunk_data);
    assert.ok(
      bytes <= DEFAULT_DATASET_CHUNK_MAX_BYTES,
      `chunk ${idx} byte length ${bytes} exceeded ${DEFAULT_DATASET_CHUNK_MAX_BYTES}`
    );
    assert.equal(hasLoneSurrogate(row.chunk_data), false);
    totalChunkBytes += bytes;
  });
  assert.equal(totalChunkBytes, rawPayloadBytes);

  // 3) Verify MCP chaox_get_status reports exact datasetCounts.expenses.
  const statusCall = await callMcpTool(env, 1, "chaox_get_status");
  assert.equal(statusCall.isError, undefined);
  const apps = statusCall.payload.apps as Record<string, { datasetCounts: Record<string, number> }>;
  assert.equal(apps.sx.datasetCounts.expenses, recordCount);

  // 4) Verify MCP sx_list_expenses reassembles chunks with intact Chinese & emoji across head, middle, and tail.
  const tailQuery = await callMcpTool(env, 2, "sx_list_expenses", {
    query: "深夜拉面尾标🍜🔥🎉",
    limit: 5
  });
  assert.equal(tailQuery.isError, undefined);
  assert.equal(tailQuery.payload.datasetUploaded, true);
  assert.equal(tailQuery.payload.totalCount, 1);
  const tailItems = tailQuery.payload.items as SxExpenseRecord[];
  assert.equal(tailItems.length, 1);
  assert.equal(tailItems[0].id, recordCount);
  assert.equal(tailItems[0].notes, tailNote);
  assert.deepEqual(tailItems[0].tags, ["餐饮", "🍜美食", "日常"]);

  const midQuery = await callMcpTool(env, 3, "sx_list_expenses", {
    query: "跨分块中段哨兵 🍱🍣中文边界校验🎉",
    limit: 5
  });
  assert.equal(midQuery.isError, undefined);
  const midItems = midQuery.payload.items as SxExpenseRecord[];
  assert.equal(midItems.length, 1);
  assert.equal(midItems[0].id, middleIndex + 1);
  assert.equal(midItems[0].notes, midNote);

  const pageQuery = await callMcpTool(env, 4, "sx_list_expenses", { limit: 5 });
  assert.equal(pageQuery.isError, undefined);
  assert.equal(pageQuery.payload.datasetUploaded, true);
  assert.equal(pageQuery.payload.totalCount, recordCount);
  assert.equal(pageQuery.payload.returnedCount, 5);
  assert.equal(pageQuery.payload.hasMore, true);
});
