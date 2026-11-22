import {
  DEFAULT_PREFERENCES_MARKDOWN,
  MCP_SERVER_INSTRUCTIONS
} from "./guide.js";
import { applyBxSummaryDateKey, BxOperations } from "./store-bx.js";
import { CsteixOperations } from "./store-csteix.js";
import {
  AppDatasetRow,
  AppStateRow,
  InboxRow,
  mapInboxRow,
  mapReceiptRow,
  parsePolicyFromRow,
  ReceiptRow,
  safeJsonParse,
  VALID_APPS,
  VALID_PERMISSIONS
} from "./store-helpers.js";
import { SxOperations } from "./store-sx.js";
import {
  AgentAppID,
  BxCatalog,
  BxDaySummary,
  BxSummaryBundle,
  InboxEnvelope,
  PermissionAction,
  PermissionPolicy,
  Receipt,
  SCHEMA_VERSION,
  SnapshotUploadBody,
  SqlDatabase,
  SqlPreparedStatement,
  SxCatalog,
  SxSummaryBundle
} from "./types.js";

export class ExchangeStore {
  readonly bx: BxOperations;
  readonly sx: SxOperations;
  readonly csteix: CsteixOperations;
  private readonly backendMode: string;
  private readonly defaultClient: string;

  constructor(
    private readonly db: SqlDatabase,
    options: { backendMode?: string; defaultClient?: string } = {}
  ) {
    this.backendMode = options.backendMode?.trim() || "sqlite";
    this.defaultClient = options.defaultClient?.trim() || "chaox-agent-server";
    this.bx = new BxOperations(this);
    this.sx = new SxOperations(this);
    this.csteix = new CsteixOperations(this);
  }

  getDatabase(): SqlDatabase {
    return this.db;
  }

  getBackendMode(): string {
    return this.backendMode;
  }

  getServerName(): string {
    return this.defaultClient;
  }

  private async getAppState(app: AgentAppID): Promise<AppStateRow | null> {
    return this.db.prepare("SELECT * FROM app_state WHERE app = ?").bind(app).first<AppStateRow>();
  }

  async assertReadAccess(app: AgentAppID): Promise<{ row: AppStateRow | null; policy: PermissionPolicy | null }> {
    const state = await this.getAppState(app);
    if (!state) return { row: null, policy: null };
    const policy = parsePolicyFromRow(state);
    if (state.permission === "disabled" || !policy.allowRead) {
      throw new Error(
        `App '${app}' read access is disabled. Enable Read permission in ${app.toUpperCase()} Settings -> AI Assistant.`
      );
    }
    return { row: state, policy };
  }

  async assertDomainReadAllowed(app: AgentAppID, domain: string): Promise<void> {
    const { row, policy } = await this.assertReadAccess(app);
    if (!row) {
      throw new Error(
        `App '${app}' has not synced to this CHAOX Agent server yet. Open ${app.toUpperCase()} Settings -> AI Assistant and connect first.`
      );
    }
    if (policy && !policy.allowedDomains.includes(domain)) {
      throw new Error(
        `Domain '${domain}' is disabled by user policy in ${app.toUpperCase()}. Enable it in ${app.toUpperCase()} Settings -> AI Assistant.`
      );
    }
  }

  async assertActionDomainAllowed(app: AgentAppID, domain: string): Promise<void> {
    const state = await this.getAppState(app);
    if (!state) return;
    const policy = parsePolicyFromRow(state);
    if (!policy.allowedDomains.includes(domain)) {
      throw new Error(
        `Domain '${domain}' is disabled by user policy in ${app.toUpperCase()}. Enable it in ${app.toUpperCase()} Settings -> AI Assistant.`
      );
    }
  }

  async assertActionAllowed(
    app: AgentAppID,
    action: PermissionAction,
    domain: string
  ): Promise<AppStateRow> {
    const state = await this.getAppState(app);
    if (!state) {
      throw new Error(
        `App '${app}' has not synced to this CHAOX Agent server yet. Open ${app.toUpperCase()} Settings -> AI Assistant and connect first.`
      );
    }
    const policy = parsePolicyFromRow(state);
    if (state.permission === "disabled") {
      throw new Error(
        `App '${app}' is paused ('disabled'). Enable permissions in ${app.toUpperCase()} Settings -> AI Assistant.`
      );
    }
    if (!policy.allowedDomains.includes(domain)) {
      throw new Error(
        `Category '${domain}' is turned off by user policy in ${app.toUpperCase()}. Enable it in ${app.toUpperCase()} Settings -> AI Assistant.`
      );
    }
    if (action === "create" && !policy.allowCreate) {
      throw new Error(
        `App '${app}' does not allow adding records ('allowCreate' is off). Enable Add/Create in ${app.toUpperCase()} Settings.`
      );
    }
    if (action === "update" && !policy.allowUpdate) {
      throw new Error(
        `App '${app}' does not allow editing records ('allowUpdate' is off). Enable Edit/Update in ${app.toUpperCase()} Settings.`
      );
    }
    if (action === "delete" && !policy.allowDelete) {
      throw new Error(
        `App '${app}' does not allow deleting records ('allowDelete' is off). Enable Delete in ${app.toUpperCase()} Settings.`
      );
    }
    return state;
  }

  async readDataset<T>(app: AgentAppID, domain: string): Promise<T[] | null> {
    const row = await this.db
      .prepare("SELECT payload_json FROM app_dataset WHERE app = ? AND domain = ?")
      .bind(app, domain)
      .first<{ payload_json: string }>();
    if (!row) return null;
    return safeJsonParse<T[]>(row.payload_json) ?? [];
  }

  async readAppTimeZone(app: AgentAppID): Promise<string | undefined> {
    const state = await this.getAppState(app);
    if (!state) return undefined;
    const catalog = safeJsonParse<{ timeZoneIdentifier?: unknown }>(state.catalog_json);
    if (typeof catalog?.timeZoneIdentifier === "string" && catalog.timeZoneIdentifier.trim()) {
      return catalog.timeZoneIdentifier.trim();
    }
    const summary = safeJsonParse<{ timeZoneIdentifier?: unknown }>(state.summary_json);
    if (typeof summary?.timeZoneIdentifier === "string" && summary.timeZoneIdentifier.trim()) {
      return summary.timeZoneIdentifier.trim();
    }
    return undefined;
  }

  async listPendingEnvelopes(app: AgentAppID): Promise<InboxEnvelope[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM inbox WHERE app = ? ORDER BY created_at ASC, rowid ASC")
      .bind(app)
      .all<InboxRow>();
    return results.map(mapInboxRow);
  }

  async checkReceipts(options: {
    app?: AgentAppID;
    requestId?: string;
    limit?: number;
  } = {}): Promise<{ receipts: Receipt[]; pending: InboxEnvelope[] }> {
    const limit = Math.max(1, Math.min(options.limit ?? 10, 50));

    let pendingRows: InboxRow[];
    if (options.requestId) {
      const q = options.app
        ? this.db
            .prepare("SELECT * FROM inbox WHERE app = ? AND request_id = ?")
            .bind(options.app, options.requestId)
        : this.db.prepare("SELECT * FROM inbox WHERE request_id = ?").bind(options.requestId);
      pendingRows = (await q.all<InboxRow>()).results;
    } else if (options.app) {
      pendingRows = (
        await this.db
          .prepare("SELECT * FROM inbox WHERE app = ? ORDER BY created_at ASC")
          .bind(options.app)
          .all<InboxRow>()
      ).results;
    } else {
      pendingRows = (
        await this.db.prepare("SELECT * FROM inbox ORDER BY created_at ASC").all<InboxRow>()
      ).results;
    }

    let receiptRows: ReceiptRow[];
    if (options.requestId) {
      const q = options.app
        ? this.db
            .prepare("SELECT * FROM receipts WHERE app = ? AND request_id = ?")
            .bind(options.app, options.requestId)
        : this.db.prepare("SELECT * FROM receipts WHERE request_id = ?").bind(options.requestId);
      receiptRows = (await q.all<ReceiptRow>()).results;
    } else if (options.app) {
      receiptRows = (
        await this.db
          .prepare("SELECT * FROM receipts WHERE app = ? ORDER BY processed_at DESC LIMIT ?")
          .bind(options.app, limit)
          .all<ReceiptRow>()
      ).results;
    } else {
      receiptRows = (
        await this.db
          .prepare("SELECT * FROM receipts ORDER BY processed_at DESC LIMIT ?")
          .bind(limit)
          .all<ReceiptRow>()
      ).results;
    }

    return {
      receipts: receiptRows.map(mapReceiptRow),
      pending: pendingRows.map(mapInboxRow)
    };
  }

  async getStatus(options: {
    app?: AgentAppID;
    requestId?: string;
    receiptLimit?: number;
  } = {}): Promise<Record<string, unknown>> {
    const { results: appRows } = await this.db.prepare("SELECT * FROM app_state").all<AppStateRow>();
    const { results: datasetRows } = await this.db
      .prepare("SELECT app, domain, record_count, updated_at FROM app_dataset")
      .all<Omit<AppDatasetRow, "payload_json">>();
    const pendingSx = (
      await this.db.prepare("SELECT COUNT(*) AS cnt FROM inbox WHERE app = 'sx'").first<{ cnt: number }>()
    )?.cnt ?? 0;
    const pendingBx = (
      await this.db.prepare("SELECT COUNT(*) AS cnt FROM inbox WHERE app = 'bx'").first<{ cnt: number }>()
    )?.cnt ?? 0;
    const pendingCsteix = (
      await this.db.prepare("SELECT COUNT(*) AS cnt FROM inbox WHERE app = 'csteix'").first<{ cnt: number }>()
    )?.cnt ?? 0;
    const activeWuxuCount = await this.csteix.countActiveWuxu();

    const countsByApp: Record<string, Record<string, number>> = {};
    for (const ds of datasetRows) {
      if (!countsByApp[ds.app]) countsByApp[ds.app] = {};
      countsByApp[ds.app][ds.domain] = ds.record_count;
    }

    const apps: Record<string, unknown> = {};
    let latestUpdate: string | null = null;
    for (const row of appRows) {
      if (!latestUpdate || row.updated_at > latestUpdate) {
        latestUpdate = row.updated_at;
      }
      const datasetCounts: Record<string, number> = { ...(countsByApp[row.app] ?? {}) };
      if (row.app === "csteix") {
        datasetCounts.wuxu = activeWuxuCount;
      }
      apps[row.app] = {
        app: row.app,
        bundleId: row.bundle_id,
        appVersion: row.app_version,
        permission: row.permission,
        policy: parsePolicyFromRow(row),
        datasetCounts,
        capabilities: safeJsonParse<string[]>(row.capabilities_json) ?? [],
        lastSyncAt: row.last_sync_at ?? row.updated_at,
        pendingInboxCount:
          row.app === "sx" ? pendingSx : row.app === "bx" ? pendingBx : row.app === "csteix" ? pendingCsteix : 0
      };
    }

    const receiptInfo = await this.checkReceipts({
      app: options.app,
      requestId: options.requestId,
      limit: options.receiptLimit ?? 10
    });

    return {
      backend: this.backendMode,
      schemaVersion: SCHEMA_VERSION,
      instructions: MCP_SERVER_INSTRUCTIONS,
      updatedAt: latestUpdate,
      apps,
      pendingInbox: {
        sx: pendingSx,
        bx: pendingBx,
        csteix: pendingCsteix
      },
      matchedPending: options.requestId ? receiptInfo.pending : undefined,
      recentReceipts: receiptInfo.receipts
    };
  }

  async readSxCatalog(): Promise<SxCatalog> {
    const { row, policy } = await this.assertReadAccess("sx");
    const catalog = safeJsonParse<SxCatalog>(row?.catalog_json);
    if (!catalog) {
      throw new Error("SX catalog is not uploaded yet. Sync SX with this server first.");
    }
    const filtered: SxCatalog = { ...catalog };
    if (policy && !policy.allowedDomains.includes("projects")) {
      filtered.projects = [];
    }
    if (policy && !policy.allowedDomains.includes("tags")) {
      filtered.tags = [];
    }
    filtered.fieldGuide = {
      timeZone: filtered.timeZoneIdentifier ?? "UTC",
      expenseDisplayDateFormat:
        "YYYY-MM-DD-HH — the trailing 2 digits (HH) are the 24-hour local hour (00-23) in timeZoneIdentifier, NOT minutes and NOT a sequence number. Examples: 2026-11-22-09 = 09:00 local, 2026-11-22-12 = 12:00 noon, 2026-11-21-00 = midnight or hour unknown.",
      incomeDisplayDateFormat:
        "YYYY-MM-DD (local calendar date; SX UI shows day precision without -HH).",
      expenseWriteFields: {
        amount: "Required number > 0: gross original payment before any refunds (never negative; use sx_record_refund for refunds).",
        projectName:
          "Required string: existing SX project/category name from catalog.projects with supportsExpense: true (never invent one-off merchants/items as projects; put those in note).",
        currency: "Optional 3-letter ISO-4217 code (e.g. CNY, USD); omit to inherit the project's default currency.",
        date:
          "Optional timestamp: accepts ISO-8601 with offset ('2026-11-22T12:00:00+08:00' or '...Z'), SX format ('2026-11-22-12'), local ('2026-11-22 12:00'), or 'YYYY-MM-DD' (defaults to 00:00 local = YYYY-MM-DD-00 unless hour is passed). Omit both date and hour for current time.",
        hour: "Optional integer 0..23: 24-hour local hour in timeZoneIdentifier; sets/overrides HH in YYYY-MM-DD-HH (uses today if date omitted).",
        tags: "Optional string[]: OMIT to inherit the project's recentExpenseTags; pass [] to clear all tags; pass array to set exact tags (missing tags auto-create on device).",
        note: "Optional string (singular 'note' on write): merchant, dish, item, or order memo shown as one line on cards; put key details first.",
        credentialId: "Optional integer >= 1 (requires 'credentials' scope opt-in): linked credential ID from sx_list_credentials.",
        requestId: "Optional idempotency key so retries never duplicate records.",
        client: "Optional short calling AI client label (e.g. 'claude', 'cursor')."
      },
      expenseReadFields: {
        id: "Positive integer record ID (-1 for items still queued in server inbox).",
        projectId: "Owning project ID.",
        projectName: "Owning project/category name.",
        amount: "Gross payment amount before refunds.",
        refundTotal: "Sum of non-deleted refunds linked to this expense.",
        netAmount: "amount - refundTotal (primary figure shown in SX UI).",
        currency: "3-letter ISO-4217 currency code.",
        tags: "Applied tag names in pick order.",
        notes: "Expense memo (plural 'notes' on read; write tools use singular 'note').",
        paidAt: "UTC ISO-8601 timestamp stored by SX.",
        localDate: "YYYY-MM-DD calendar date in timeZoneIdentifier.",
        localHour: "Integer 0..23 24-hour clock hour in timeZoneIdentifier (the HH in YYYY-MM-DD-HH).",
        displayDate: "YYYY-MM-DD-HH exact timestamp string displayed in SX UI.",
        isAutoRecorded: "True if auto-generated by a scheduled recurring credential link.",
        credentialId: "Optional linked credential ID (present only when 'credentials' scope is enabled).",
        credentialName: "Optional linked credential username snapshot.",
        refunds: "Optional nested array of refunds on this expense."
      },
      commonPitfalls: [
        "The trailing -HH in SX dates like 2026-11-22-12 is the 24-hour local hour (00-23), NEVER minutes and NEVER a counter.",
        "projectName is an existing category/service bucket; put specific restaurant, dish, vendor, or item details in note.",
        "Omitting tags on create inherits the project's latest tags; passing [] explicitly clears tags.",
        "Write tools use 'note' (singular) for expense/income/refund memos, while list responses return 'notes' (plural).",
        "Passing bare YYYY-MM-DD without 'hour' records local 00:00 (displayed as YYYY-MM-DD-00).",
        "sx_update_expense applies partial patches in FIFO order on device: omitted fields (like amount, currency, tags) stay unchanged, and sequential updates on the same id can be queued immediately without waiting for device sync."
      ]
    };
    return filtered;
  }

  async readSxSummary(options: {
    period?: "today" | "week" | "month" | "year" | "allTime";
    mode?: "expense" | "income";
  } = {}): Promise<Record<string, unknown>> {
    const mode = options.mode ?? "expense";
    const domain = mode === "income" ? "incomes" : "expenses";
    await this.assertDomainReadAllowed("sx", domain);
    const row = await this.getAppState("sx");
    const summary = safeJsonParse<SxSummaryBundle>(row?.summary_json);
    if (!summary) {
      throw new Error("SX summary is not uploaded yet. Sync SX with this server first.");
    }

    const period = options.period ?? "month";
    const committedBucket =
      summary[mode]?.[period] ??
      summary.periods?.[`${mode}.${period}`] ??
      summary.periods?.[period] ??
      null;

    const pending = await this.listPendingEnvelopes("sx");
    const targetOp = mode === "income" ? "record_income" : "record_expense";
    const matchingPending = pending.filter((env) => env.op === targetOp);
    const pendingTotalsByCurrency: Record<string, number> = {};
    for (const env of matchingPending) {
      const amount = Number(env.payload.amount);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const currency =
        typeof env.payload.currency === "string" && env.payload.currency.trim()
          ? env.payload.currency.trim().toUpperCase()
          : summary.summaryCurrency ?? "CNY";
      pendingTotalsByCurrency[currency] =
        Math.round(((pendingTotalsByCurrency[currency] ?? 0) + amount) * 100) / 100;
    }

    const summaryCurrency = summary.summaryCurrency ?? committedBucket?.currency ?? "CNY";
    const committedTotal = typeof committedBucket?.netTotal === "number" ? committedBucket.netTotal : null;
    const sameCurrencyPending = pendingTotalsByCurrency[summaryCurrency] ?? 0;
    const optimisticSameCurrencyTotal =
      committedTotal !== null ? Math.round((committedTotal + sameCurrencyPending) * 100) / 100 : null;

    return {
      generatedAt: summary.generatedAt ?? null,
      mode,
      period,
      summaryCurrency,
      committedBucket,
      allBuckets: summary,
      optimisticOverlay: {
        pendingInboxCount: matchingPending.length,
        pendingTotalsByCurrency,
        optimisticSameCurrencyTotal,
        pendingRequests: matchingPending.map((env) => ({
          requestId: env.requestId,
          op: env.op,
          createdAt: env.createdAt,
          payload: env.payload
        }))
      }
    };
  }

  async readBxSummary(options: { date?: string } = {}): Promise<Record<string, unknown>> {
    const { row, policy } = await this.assertReadAccess("bx");
    const summary = safeJsonParse<BxSummaryBundle>(row?.summary_json);
    const catalog = safeJsonParse<BxCatalog>(row?.catalog_json);
    if (!summary) {
      throw new Error("BX summary is not uploaded yet. Sync BX with this server first.");
    }

    const allowFood = !policy || policy.allowedDomains.includes("food");
    const allowSkin = !policy || policy.allowedDomains.includes("skin");
    const allowToilet = !policy || policy.allowedDomains.includes("toilet");

    const targetDate = options.date?.trim() || summary.today?.date || applyBxSummaryDateKey(new Date());
    const rawDay: BxDaySummary | null =
      summary.days?.find((day) => day.date === targetDate) ??
      (summary.today?.date === targetDate ? summary.today : null);

    const committedDay: BxDaySummary | null = rawDay
      ? {
          ...rawDay,
          ...(allowFood ? {} : { totalCalories: 0, unknownCaloriesCount: 0, mealCount: 0, meals: [] }),
          ...(allowSkin ? {} : { skinCount: 0 }),
          ...(allowToilet ? {} : { bowelCount: 0, urinationCount: 0, toiletCount: 0 })
        }
      : null;

    const pending = await this.listPendingEnvelopes("bx");
    const pendingForDate = pending.filter((env) => {
      const recordedAt = typeof env.payload.recordedAt === "string" ? env.payload.recordedAt : env.createdAt;
      return recordedAt.startsWith(targetDate) || applyBxSummaryDateKey(new Date(recordedAt)) === targetDate;
    });

    let pendingCalories = 0;
    let pendingUnknownCalories = 0;
    let pendingMealCount = 0;
    let pendingSkinCount = 0;
    let pendingBowelCount = 0;
    let pendingUrinationCount = 0;

    for (const env of pendingForDate) {
      if (allowFood && env.op === "record_food") {
        pendingMealCount += 1;
        const cal = env.payload.calories ?? env.payload.kilocalories;
        if (typeof cal === "number" && Number.isFinite(cal)) {
          pendingCalories += cal;
        } else {
          pendingUnknownCalories += 1;
        }
      } else if (allowSkin && env.op === "record_skin") {
        pendingSkinCount += 1;
      } else if (allowToilet && env.op === "record_toilet") {
        if (env.payload.kind === "urination") {
          pendingUrinationCount += 1;
        } else {
          pendingBowelCount += 1;
        }
      }
    }

    const committedBowel = committedDay?.bowelCount ?? 0;
    const committedUrination = committedDay?.urinationCount ?? 0;
    const committedToilet = committedDay?.toiletCount ?? committedBowel + committedUrination;

    return {
      generatedAt: summary.generatedAt ?? null,
      targetDate,
      committedDay,
      availableDays: summary.days?.map((day) => day.date) ?? [],
      catalog,
      optimisticOverlay: {
        pendingInboxCount: pendingForDate.length,
        optimisticTotals: {
          totalCalories: Math.round(((committedDay?.totalCalories ?? 0) + pendingCalories) * 10) / 10,
          unknownCaloriesCount: (committedDay?.unknownCaloriesCount ?? 0) + pendingUnknownCalories,
          mealCount: (committedDay?.mealCount ?? 0) + pendingMealCount,
          skinCount: (committedDay?.skinCount ?? 0) + pendingSkinCount,
          bowelCount: committedBowel + pendingBowelCount,
          urinationCount: committedUrination + pendingUrinationCount,
          toiletCount: committedToilet + pendingBowelCount + pendingUrinationCount
        },
        pendingRequests: pendingForDate.map((env) => ({
          requestId: env.requestId,
          op: env.op,
          createdAt: env.createdAt,
          payload: env.payload
        }))
      }
    };
  }

  async enqueueInbox(
    app: AgentAppID,
    op: string,
    requestId: string,
    client: string | undefined,
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const existingReceipt = await this.db
      .prepare("SELECT * FROM receipts WHERE request_id = ?")
      .bind(requestId)
      .first<ReceiptRow>();
    if (existingReceipt) {
      return {
        queued: false,
        alreadyProcessed: true,
        receipt: mapReceiptRow(existingReceipt)
      };
    }

    const existingInbox = await this.db
      .prepare("SELECT * FROM inbox WHERE request_id = ?")
      .bind(requestId)
      .first<InboxRow>();
    if (existingInbox) {
      return {
        queued: true,
        duplicateInInbox: true,
        app,
        op,
        requestId,
        createdAt: existingInbox.created_at,
        normalizedPayload: safeJsonParse(existingInbox.payload_json) ?? payload
      };
    }

    const createdAt = new Date().toISOString();
    const source = { client: client ?? this.defaultClient };

    await this.db
      .prepare(
        "INSERT INTO inbox (request_id, app, op, schema_version, created_at, source_json, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(requestId, app, op, SCHEMA_VERSION, createdAt, JSON.stringify(source), JSON.stringify(payload))
      .run();

    return {
      queued: true,
      app,
      op,
      requestId,
      createdAt,
      normalizedPayload: payload,
      note: `Queued in server inbox for ${app.toUpperCase()}. It will apply automatically when the app opens or syncs.`
    };
  }

  // MARK: - Device Sync API

  static parseAppId(raw: string): AgentAppID {
    if (!VALID_APPS.has(raw as AgentAppID)) {
      throw new Error(`Unsupported app '${raw}'.`);
    }
    return raw as AgentAppID;
  }

  async getAppSyncStatus(app: AgentAppID, receiptLimit = 10): Promise<Record<string, unknown>> {
    const state = await this.getAppState(app);
    const pendingCount =
      (
        await this.db
          .prepare("SELECT COUNT(*) AS cnt FROM inbox WHERE app = ?")
          .bind(app)
          .first<{ cnt: number }>()
      )?.cnt ?? 0;

    const { receipts } = await this.checkReceipts({ app, limit: receiptLimit });

    return {
      schemaVersion: SCHEMA_VERSION,
      app,
      configured: state !== null,
      permission: state?.permission ?? "disabled",
      lastSyncAt: state?.last_sync_at ?? null,
      pendingInboxCount: pendingCount,
      recentReceipts: receipts
    };
  }

  async listAppInbox(app: AgentAppID): Promise<Record<string, unknown>> {
    const state = await this.getAppState(app);
    const envelopes = await this.listPendingEnvelopes(app);
    return {
      schemaVersion: SCHEMA_VERSION,
      app,
      permission: state?.permission ?? "disabled",
      envelopes
    };
  }

  async ackAppReceipts(app: AgentAppID, receipts: Receipt[]): Promise<{ ackedCount: number }> {
    if (!receipts.length) {
      return { ackedCount: 0 };
    }

    const statements: SqlPreparedStatement[] = [];
    for (const receipt of receipts) {
      statements.push(
        this.db
          .prepare(
            `INSERT OR REPLACE INTO receipts (
              request_id, app, op, schema_version, status, processed_at,
              record_id, stable_id, summary, details_json, error_code, error_message
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            receipt.requestId,
            app,
            receipt.op,
            receipt.schemaVersion || SCHEMA_VERSION,
            receipt.status,
            receipt.processedAt || new Date().toISOString(),
            receipt.recordId ?? null,
            receipt.stableId ?? null,
            receipt.summary ?? null,
            receipt.details ? JSON.stringify(receipt.details) : null,
            receipt.errorCode ?? null,
            receipt.errorMessage ?? null
          )
      );
      statements.push(
        this.db.prepare("DELETE FROM inbox WHERE request_id = ? AND app = ?").bind(receipt.requestId, app)
      );
    }

    await this.db.batch(statements);
    return { ackedCount: receipts.length };
  }

  async putAppSnapshot(app: AgentAppID, body: SnapshotUploadBody): Promise<Record<string, unknown>> {
    if (!VALID_PERMISSIONS.has(body.permission)) {
      throw new Error(`Invalid permission tier '${body.permission}'.`);
    }

    const existing = await this.getAppState(app);
    const now = new Date().toISOString();
    const lastSyncAt = body.lastSyncAt ?? now;
    const resolvedPolicy = body.policy ?? (existing?.policy_json ? safeJsonParse<PermissionPolicy>(existing.policy_json) : null);
    const readRevoked = resolvedPolicy ? !resolvedPolicy.allowRead : body.permission === "disabled";

    const catalogJson = readRevoked
      ? null
      : body.catalog !== undefined
        ? JSON.stringify(body.catalog)
        : existing?.catalog_json ?? null;
    const summaryJson = readRevoked
      ? null
      : body.summary !== undefined
        ? JSON.stringify(body.summary)
        : existing?.summary_json ?? null;
    const policyJson = body.policy !== undefined ? JSON.stringify(body.policy) : existing?.policy_json ?? null;

    const statements: SqlPreparedStatement[] = [
      this.db
        .prepare(
          `INSERT OR REPLACE INTO app_state (
            app, bundle_id, app_version, permission, policy_json, capabilities_json,
            catalog_json, summary_json, last_sync_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          app,
          body.bundleId,
          body.appVersion,
          body.permission,
          policyJson,
          JSON.stringify(body.capabilities ?? []),
          catalogJson,
          summaryJson,
          lastSyncAt,
          now
        )
    ];

    if (readRevoked) {
      // Clears read-only snapshot datasets in app_dataset while preserving csteix_wuxu rows.
      statements.push(this.db.prepare("DELETE FROM app_dataset WHERE app = ?").bind(app));
    } else if (body.datasets && typeof body.datasets === "object") {
      for (const [domain, value] of Object.entries(body.datasets)) {
        // Wuxu articles live in dedicated csteix_wuxu table, never in app_dataset.
        if (app === "csteix" && domain === "wuxu") continue;
        const domainAllowed =
          !resolvedPolicy ||
          resolvedPolicy.allowedDomains.includes(domain) ||
          (domain === "exercises" && resolvedPolicy.allowedDomains.includes("workouts"));
        if (value === null || !domainAllowed) {
          statements.push(
            this.db.prepare("DELETE FROM app_dataset WHERE app = ? AND domain = ?").bind(app, domain)
          );
        } else {
          const count = Array.isArray(value) ? value.length : 1;
          statements.push(
            this.db
              .prepare(
                `INSERT OR REPLACE INTO app_dataset (app, domain, payload_json, record_count, updated_at)
                 VALUES (?, ?, ?, ?, ?)`
              )
              .bind(app, domain, JSON.stringify(value), count, now)
          );
        }
      }
    }

    // Prune any previously uploaded dataset domains removed from allowedDomains.
    if (!readRevoked && resolvedPolicy) {
      const allowedSet = new Set(resolvedPolicy.allowedDomains);
      if (allowedSet.has("workouts")) allowedSet.add("exercises");
      const existingDomains = (
        await this.db.prepare("SELECT domain FROM app_dataset WHERE app = ?").bind(app).all<{ domain: string }>()
      ).results;
      for (const row of existingDomains) {
        if (!allowedSet.has(row.domain)) {
          statements.push(
            this.db.prepare("DELETE FROM app_dataset WHERE app = ? AND domain = ?").bind(app, row.domain)
          );
        }
      }
    }

    await this.db.batch(statements);

    return {
      schemaVersion: SCHEMA_VERSION,
      app,
      permission: body.permission,
      policy: resolvedPolicy,
      lastSyncAt,
      updatedAt: now
    };
  }

  async putAppDatasetDomain(app: AgentAppID, domain: string, data: unknown | null): Promise<Record<string, unknown>> {
    const now = new Date().toISOString();
    if (data === null) {
      await this.db.prepare("DELETE FROM app_dataset WHERE app = ? AND domain = ?").bind(app, domain).run();
      return { schemaVersion: SCHEMA_VERSION, app, domain, deleted: true, updatedAt: now };
    }
    const count = Array.isArray(data) ? data.length : 1;
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO app_dataset (app, domain, payload_json, record_count, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(app, domain, JSON.stringify(data), count, now)
      .run();
    return { schemaVersion: SCHEMA_VERSION, app, domain, recordCount: count, updatedAt: now };
  }

  async wipeAppData(app: AgentAppID): Promise<Record<string, unknown>> {
    const wipedAt = new Date().toISOString();
    const statements: SqlPreparedStatement[] = [
      this.db.prepare("DELETE FROM app_dataset WHERE app = ?").bind(app),
      this.db.prepare("DELETE FROM inbox WHERE app = ?").bind(app),
      this.db.prepare("DELETE FROM receipts WHERE app = ?").bind(app),
      this.db.prepare("DELETE FROM app_state WHERE app = ?").bind(app)
    ];
    if (app === "csteix") {
      statements.push(this.db.prepare("DELETE FROM csteix_wuxu"));
    }
    await this.db.batch(statements);
    return {
      schemaVersion: SCHEMA_VERSION,
      app,
      wiped: true,
      wipedAt
    };
  }

  async getPreferences(): Promise<{ content: string; updatedAt: string | null }> {
    const row = await this.db
      .prepare("SELECT value, updated_at FROM preferences WHERE key = 'user_preferences'")
      .first<{ value: string; updated_at: string }>();
    return {
      content: row?.value ?? DEFAULT_PREFERENCES_MARKDOWN,
      updatedAt: row?.updated_at ?? null
    };
  }

  async setPreferences(content: string): Promise<{ updatedAt: string }> {
    const updatedAt = new Date().toISOString();
    await this.db
      .prepare("INSERT OR REPLACE INTO preferences (key, value, updated_at) VALUES ('user_preferences', ?, ?)")
      .bind(content, updatedAt)
      .run();
    return { updatedAt };
  }
}

export { ExchangeStore as D1ExchangeStore };
