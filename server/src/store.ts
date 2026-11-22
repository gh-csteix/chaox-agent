import {
  DEFAULT_PREFERENCES_MARKDOWN
} from "./guide.js";
import { BxOperations } from "./store-bx.js";
import { CsteixOperations } from "./store-csteix.js";
import {
  AppDatasetRow,
  AppStateRow,
  InboxRow,
  localDateKey,
  localDateTimeParts,
  mapInboxRow,
  mapReceiptRow,
  matchesSxPeriod,
  parsePolicyFromRow,
  ReceiptRow,
  requireNonEmptyString,
  safeJsonParse,
  VALID_APPS,
  VALID_PERMISSIONS
} from "./store-helpers.js";
import { SxOperations } from "./store-sx.js";
import {
  AgentAppID,
  BxCatalog,
  BxDaySummary,
  BxFoodRecord,
  BxSkinRecord,
  BxSummaryBundle,
  BxToiletRecord,
  InboxEnvelope,
  PermissionAction,
  PermissionPolicy,
  Receipt,
  SCHEMA_VERSION,
  SnapshotUploadBody,
  SqlDatabase,
  SqlPreparedStatement,
  SxCatalog,
  SxExpenseRecord,
  SxIncomeRecord,
  SxSummaryBundle
} from "./types.js";

const OP_DOMAIN_MAP: Record<string, string> = {
  record_expense: "expenses",
  update_expense: "expenses",
  delete_expense: "expenses",
  record_refund: "expenses",
  update_refund: "expenses",
  delete_refund: "expenses",
  record_income: "incomes",
  update_income: "incomes",
  delete_income: "incomes",
  record_income_reversal: "incomes",
  update_income_reversal: "incomes",
  delete_income_reversal: "incomes",
  create_project: "projects",
  update_project: "projects",
  delete_project: "projects",
  create_tag: "tags",
  rename_tag: "tags",
  delete_tag: "tags",
  create_slogan: "slogans",
  update_slogan: "slogans",
  delete_slogan: "slogans",
  create_credential: "credentials",
  update_credential: "credentials",
  delete_credential: "credentials",
  link_credential: "credentials",
  update_credential_link: "credentials",
  unlink_credential: "credentials",
  record_food: "food",
  update_food: "food",
  delete_food: "food",
  record_skin: "skin",
  update_skin: "skin",
  delete_skin: "skin",
  record_toilet: "toilet",
  update_toilet: "toilet",
  delete_toilet: "toilet",
  add_workout_exercise: "workouts",
  update_workout_exercise: "workouts",
  delete_workout_exercise: "workouts",
  reorder_workout_exercises: "workouts",
  update_workout_type: "workouts"
};

function opKindForPermission(op: string): "create" | "update" | "delete" {
  if (op.startsWith("delete_") || op.startsWith("unlink_")) return "delete";
  if (op.startsWith("update_") || op.startsWith("rename_") || op.startsWith("reorder_")) return "update";
  return "create";
}

export class ExchangeStore {
  readonly bx: BxOperations;
  readonly sx: SxOperations;
  readonly csteix: CsteixOperations;
  private readonly backendMode: string;
  private readonly defaultClient: string;
  private readonly appStateCache = new Map<AgentAppID, AppStateRow | null>();

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
    if (this.appStateCache.has(app)) {
      return this.appStateCache.get(app) ?? null;
    }
    const row = await this.db.prepare("SELECT * FROM app_state WHERE app = ?").bind(app).first<AppStateRow>();
    this.appStateCache.set(app, row);
    return row;
  }

  async lookupReceiptByRequestId(app: AgentAppID, requestId: string): Promise<Receipt | null> {
    const row = await this.db
      .prepare("SELECT * FROM receipts WHERE app = ? AND request_id = ?")
      .bind(app, requestId)
      .first<ReceiptRow>();
    return row ? mapReceiptRow(row) : null;
  }

  async findPendingEnvelope(app: AgentAppID, requestId: string): Promise<InboxEnvelope | null> {
    const row = await this.db
      .prepare("SELECT * FROM inbox WHERE app = ? AND request_id = ?")
      .bind(app, requestId)
      .first<InboxRow>();
    return row ? mapInboxRow(row) : null;
  }

  async updatePendingEnvelopePayload(
    app: AgentAppID,
    requestId: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    await this.db
      .prepare("UPDATE inbox SET payload_json = ? WHERE app = ? AND request_id = ?")
      .bind(JSON.stringify(payload), app, requestId)
      .run();
  }

  async deletePendingEnvelope(app: AgentAppID, requestId: string): Promise<boolean> {
    const existing = await this.findPendingEnvelope(app, requestId);
    if (!existing) return false;
    await this.db
      .prepare("DELETE FROM inbox WHERE app = ? AND request_id = ?")
      .bind(app, requestId)
      .run();
    return true;
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

  async readAppCatalog<T>(app: AgentAppID): Promise<T | null> {
    const state = await this.getAppState(app);
    if (!state?.catalog_json) return null;
    return safeJsonParse<T>(state.catalog_json);
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
    const [appStateRes, datasetRes, inboxCountsRes, activeWuxuCount, prefs, receiptInfo] = await Promise.all([
      this.db
        .prepare(
          "SELECT app, bundle_id, app_version, permission, policy_json, capabilities_json, last_sync_at, updated_at FROM app_state"
        )
        .all<Omit<AppStateRow, "catalog_json" | "summary_json">>(),
      this.db
        .prepare("SELECT app, domain, record_count, updated_at FROM app_dataset")
        .all<Omit<AppDatasetRow, "payload_json">>(),
      this.db
        .prepare("SELECT app, COUNT(*) AS cnt FROM inbox GROUP BY app")
        .all<{ app: string; cnt: number }>(),
      this.csteix.countActiveWuxu(),
      this.getPreferences(),
      this.checkReceipts({
        app: options.app,
        requestId: options.requestId,
        limit: options.receiptLimit ?? 10
      })
    ]);

    const pendingCounts: Record<string, number> = { sx: 0, bx: 0, csteix: 0 };
    for (const row of inboxCountsRes.results) {
      pendingCounts[row.app] = Number(row.cnt ?? 0);
    }

    const countsByApp: Record<string, Record<string, number>> = {};
    for (const ds of datasetRes.results) {
      if (!countsByApp[ds.app]) countsByApp[ds.app] = {};
      countsByApp[ds.app][ds.domain] = ds.record_count;
    }

    const apps: Record<string, unknown> = {};
    let latestUpdate: string | null = null;
    for (const row of appStateRes.results) {
      if (!latestUpdate || row.updated_at > latestUpdate) {
        latestUpdate = row.updated_at;
      }
      const datasetCounts: Record<string, number> = { ...(countsByApp[row.app] ?? {}) };
      if (row.app === "csteix") {
        datasetCounts.wuxu = activeWuxuCount;
      }
      const fullRow: AppStateRow = { ...row, catalog_json: null, summary_json: null };
      apps[row.app] = {
        app: row.app,
        bundleId: row.bundle_id,
        appVersion: row.app_version,
        permission: row.permission,
        policy: parsePolicyFromRow(fullRow),
        datasetCounts,
        capabilities: safeJsonParse<string[]>(row.capabilities_json) ?? [],
        lastSyncAt: row.last_sync_at ?? row.updated_at,
        pendingInboxCount: pendingCounts[row.app] ?? 0
      };
    }

    const hasCustomPreferences = prefs.updatedAt !== null;
    const truncatedPrefs =
      hasCustomPreferences && prefs.content.length > 2000
        ? `${prefs.content.slice(0, 2000)}...`
        : prefs.content;

    return {
      backend: this.backendMode,
      schemaVersion: SCHEMA_VERSION,
      instructions:
        "See initialize instructions or chaox://guide/skill for full workflow rules. Call chaox_get_briefing for a one-shot daily overview.",
      updatedAt: latestUpdate,
      hasCustomPreferences,
      ...(hasCustomPreferences ? { preferences: truncatedPrefs } : {}),
      apps,
      pendingInbox: {
        sx: pendingCounts.sx,
        bx: pendingCounts.bx,
        csteix: pendingCounts.csteix
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
        id: "Positive integer record ID (-1 for items still queued in server inbox; use pendingRequestId to edit/cancel before sync).",
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
        "sx_update_expense applies partial patches in FIFO order on device: omitted fields stay unchanged, and queued creates (id: -1) can be edited/cancelled directly via pendingRequestId."
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
    const catalog = safeJsonParse<SxCatalog>(row?.catalog_json);
    const timeZone = catalog?.timeZoneIdentifier?.trim() || summary.timeZoneIdentifier?.trim() || "UTC";
    const todayLocalDate = localDateKey(new Date().toISOString(), timeZone);
    const summaryCurrency =
      summary.summaryCurrency ??
      catalog?.summaryCurrency ??
      "CNY";

    const period = options.period ?? "month";
    const committedBucket =
      summary[mode]?.[period] ??
      summary.periods?.[`${mode}.${period}`] ??
      summary.periods?.[period] ??
      null;

    const [dataset, pending] = await Promise.all([
      mode === "income"
        ? this.readDataset<SxIncomeRecord>("sx", "incomes")
        : this.readDataset<SxExpenseRecord>("sx", "expenses"),
      this.listPendingEnvelopes("sx")
    ]);

    const projectCurrencyMap = new Map<string, string>();
    for (const proj of catalog?.projects ?? []) {
      if (proj.name && proj.currency) {
        projectCurrencyMap.set(proj.name.trim().toLowerCase(), proj.currency.trim().toUpperCase());
      }
    }

    const resolveEnvelopeCurrency = (rawCurrency: unknown, rawProjectName: unknown): string => {
      if (typeof rawCurrency === "string" && rawCurrency.trim()) {
        return rawCurrency.trim().toUpperCase();
      }
      if (typeof rawProjectName === "string" && rawProjectName.trim()) {
        const projCur = projectCurrencyMap.get(rawProjectName.trim().toLowerCase());
        if (projCur) return projCur;
      }
      return summaryCurrency;
    };

    // Track committed records and overlay FIFO updates/deletes/refunds to compute exact period deltas.
    interface TrackedRecord {
      committedNet: number;
      committedCurrency: string;
      committedInPeriod: boolean;
      currentAmount: number;
      currentRefundOrReversal: number;
      currentCurrency: string;
      currentInPeriod: boolean;
      deleted: boolean;
    }
    const trackedById = new Map<number, TrackedRecord>();
    const parentInfoByChildId = new Map<number, { parentId: number; amount: number }>();

    for (const rec of dataset ?? []) {
      const iso = mode === "income" ? (rec as SxIncomeRecord).receivedAt : (rec as SxExpenseRecord).paidAt;
      const recLocalDate = rec.localDate?.trim() || localDateKey(iso, timeZone);
      const inPeriod = matchesSxPeriod(recLocalDate, period, todayLocalDate);
      const cur = (rec.currency || summaryCurrency).toUpperCase();
      const refundOrRev =
        mode === "income"
          ? Number((rec as SxIncomeRecord).reversalTotal ?? 0)
          : Number((rec as SxExpenseRecord).refundTotal ?? 0);
      trackedById.set(rec.id, {
        committedNet: Number(rec.netAmount ?? rec.amount - refundOrRev),
        committedCurrency: cur,
        committedInPeriod: inPeriod,
        currentAmount: Number(rec.amount),
        currentRefundOrReversal: refundOrRev,
        currentCurrency: cur,
        currentInPeriod: inPeriod,
        deleted: false
      });
      if (mode === "expense" && Array.isArray((rec as SxExpenseRecord).refunds)) {
        for (const r of (rec as SxExpenseRecord).refunds ?? []) {
          parentInfoByChildId.set(r.id, { parentId: rec.id, amount: Number(r.amount) });
        }
      } else if (mode === "income" && Array.isArray((rec as SxIncomeRecord).reversals)) {
        for (const rev of (rec as SxIncomeRecord).reversals ?? []) {
          parentInfoByChildId.set(rev.id, { parentId: rec.id, amount: Number(rev.amount) });
        }
      }
    }

    const createOp = mode === "income" ? "record_income" : "record_expense";
    const updateOp = mode === "income" ? "update_income" : "update_expense";
    const deleteOp = mode === "income" ? "delete_income" : "delete_expense";
    const childCreateOp = mode === "income" ? "record_income_reversal" : "record_refund";
    const childUpdateOp = mode === "income" ? "update_income_reversal" : "update_refund";
    const childDeleteOp = mode === "income" ? "delete_income_reversal" : "delete_refund";

    const pendingTotalsByCurrency: Record<string, number> = {};
    const addCurrencyDelta = (currency: string, delta: number) => {
      if (!Number.isFinite(delta) || delta === 0) return;
      pendingTotalsByCurrency[currency] =
        Math.round(((pendingTotalsByCurrency[currency] ?? 0) + delta) * 100) / 100;
    };

    const matchedPending: InboxEnvelope[] = [];
    let excludedOutOfPeriodCount = 0;

    for (const env of pending) {
      if (env.op === createOp) {
        const amount = Number(env.payload.amount);
        if (!Number.isFinite(amount) || amount <= 0) continue;
        const itemDateIso = typeof env.payload.date === "string" ? env.payload.date : env.createdAt;
        const itemLocalDate = localDateKey(itemDateIso, timeZone);
        if (!matchesSxPeriod(itemLocalDate, period, todayLocalDate)) {
          excludedOutOfPeriodCount += 1;
          continue;
        }
        const currency = resolveEnvelopeCurrency(env.payload.currency, env.payload.projectName);
        addCurrencyDelta(currency, amount);
        matchedPending.push(env);
      } else if (env.op === updateOp) {
        const target = trackedById.get(Number(env.payload.id));
        if (target && !target.deleted) {
          if (typeof env.payload.amount === "number" && Number.isFinite(env.payload.amount)) {
            target.currentAmount = env.payload.amount;
          }
          if (typeof env.payload.currency === "string" && env.payload.currency.trim()) {
            target.currentCurrency = env.payload.currency.trim().toUpperCase();
          }
          if (typeof env.payload.date === "string") {
            const newLocalDate = localDateKey(env.payload.date, timeZone);
            target.currentInPeriod = matchesSxPeriod(newLocalDate, period, todayLocalDate);
          }
          if (target.committedInPeriod || target.currentInPeriod) {
            matchedPending.push(env);
          } else {
            excludedOutOfPeriodCount += 1;
          }
        } else {
          matchedPending.push(env);
        }
      } else if (env.op === deleteOp) {
        const target = trackedById.get(Number(env.payload.id));
        if (target) {
          target.deleted = true;
          if (target.committedInPeriod) {
            matchedPending.push(env);
          } else {
            excludedOutOfPeriodCount += 1;
          }
        } else {
          matchedPending.push(env);
        }
      } else if (env.op === childCreateOp) {
        const parentId = Number(mode === "income" ? env.payload.incomeId : env.payload.paymentId);
        const target = trackedById.get(parentId);
        const amount = Number(env.payload.amount);
        if (target && Number.isFinite(amount) && amount > 0) {
          target.currentRefundOrReversal += amount;
          if (target.currentInPeriod || target.committedInPeriod) {
            matchedPending.push(env);
          } else {
            excludedOutOfPeriodCount += 1;
          }
        } else if (!target && Number.isFinite(amount) && amount > 0) {
          const itemLocalDate = localDateKey(
            typeof env.payload.date === "string" ? env.payload.date : env.createdAt,
            timeZone
          );
          if (matchesSxPeriod(itemLocalDate, period, todayLocalDate)) {
            addCurrencyDelta(summaryCurrency, -amount);
            matchedPending.push(env);
          } else {
            excludedOutOfPeriodCount += 1;
          }
        }
      } else if (env.op === childUpdateOp || env.op === childDeleteOp) {
        const childId = Number(env.payload.id);
        const parentInfo = parentInfoByChildId.get(childId);
        const target = parentInfo ? trackedById.get(parentInfo.parentId) : undefined;
        if (parentInfo && target) {
          if (env.op === childDeleteOp) {
            target.currentRefundOrReversal = Math.max(0, target.currentRefundOrReversal - parentInfo.amount);
            parentInfo.amount = 0;
          } else if (typeof env.payload.amount === "number" && Number.isFinite(env.payload.amount)) {
            const diff = env.payload.amount - parentInfo.amount;
            target.currentRefundOrReversal = Math.max(0, target.currentRefundOrReversal + diff);
            parentInfo.amount = env.payload.amount;
          }
          if (target.currentInPeriod || target.committedInPeriod) {
            matchedPending.push(env);
          } else {
            excludedOutOfPeriodCount += 1;
          }
        }
      } else if (env.op === "create_project") {
        if (typeof env.payload.name === "string" && typeof env.payload.currency === "string") {
          projectCurrencyMap.set(env.payload.name.trim().toLowerCase(), env.payload.currency.trim().toUpperCase());
        }
      }
    }

    for (const tracked of trackedById.values()) {
      const oldContribution = tracked.committedInPeriod ? tracked.committedNet : 0;
      const newNet = tracked.deleted ? 0 : Math.round((tracked.currentAmount - tracked.currentRefundOrReversal) * 100) / 100;
      const newContribution = tracked.currentInPeriod && !tracked.deleted ? newNet : 0;
      if (tracked.committedCurrency === tracked.currentCurrency) {
        addCurrencyDelta(tracked.currentCurrency, newContribution - oldContribution);
      } else {
        addCurrencyDelta(tracked.committedCurrency, -oldContribution);
        addCurrencyDelta(tracked.currentCurrency, newContribution);
      }
    }

    // Remove zero-delta entries so pendingTotalsByCurrency stays clean.
    for (const [cur, val] of Object.entries(pendingTotalsByCurrency)) {
      if (val === 0) delete pendingTotalsByCurrency[cur];
    }

    const effectiveSummaryCurrency = committedBucket?.currency ?? summaryCurrency;
    const committedTotal = typeof committedBucket?.netTotal === "number" ? committedBucket.netTotal : null;
    const sameCurrencyPending = pendingTotalsByCurrency[effectiveSummaryCurrency] ?? 0;
    const optimisticSameCurrencyTotal =
      committedTotal !== null ? Math.round((committedTotal + sameCurrencyPending) * 100) / 100 : null;

    return {
      generatedAt: summary.generatedAt ?? null,
      timeZoneIdentifier: timeZone,
      mode,
      period,
      summaryCurrency: effectiveSummaryCurrency,
      committedBucket,
      allBuckets: summary,
      optimisticOverlay: {
        pendingInboxCount: matchedPending.length,
        excludedOutOfPeriodCount,
        pendingTotalsByCurrency,
        optimisticSameCurrencyTotal,
        pendingRequests: matchedPending.map((env) => ({
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

    const bxTimeZone = summary.timeZoneIdentifier?.trim() || catalog?.timeZoneIdentifier?.trim() || undefined;
    const allowFood = !policy || policy.allowedDomains.includes("food");
    const allowSkin = !policy || policy.allowedDomains.includes("skin");
    const allowToilet = !policy || policy.allowedDomains.includes("toilet");

    const targetDate = options.date?.trim() || summary.today?.date || localDateKey(new Date().toISOString(), bxTimeZone);
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
    const needsFoodDataset = allowFood && pending.some((e) => e.op === "update_food" || e.op === "delete_food");
    const needsSkinDataset = allowSkin && pending.some((e) => e.op === "update_skin" || e.op === "delete_skin");
    const needsToiletDataset = allowToilet && pending.some((e) => e.op === "update_toilet" || e.op === "delete_toilet");

    const [foodDataset, skinDataset, toiletDataset] = await Promise.all([
      needsFoodDataset ? this.readDataset<BxFoodRecord>("bx", "food") : Promise.resolve(null),
      needsSkinDataset ? this.readDataset<BxSkinRecord>("bx", "skin") : Promise.resolve(null),
      needsToiletDataset ? this.readDataset<BxToiletRecord>("bx", "toilet") : Promise.resolve(null)
    ]);

    const foodById = new Map((foodDataset ?? []).map((item) => [item.id, { ...item }]));
    const skinById = new Map((skinDataset ?? []).map((item) => [item.id, { ...item }]));
    const toiletById = new Map((toiletDataset ?? []).map((item) => [item.id, { ...item }]));

    const pendingMatched: InboxEnvelope[] = [];
    let pendingCaloriesDelta = 0;
    let pendingUnknownCaloriesDelta = 0;
    let pendingMealCountDelta = 0;
    let pendingSkinCountDelta = 0;
    let pendingBowelCountDelta = 0;
    let pendingUrinationCountDelta = 0;

    for (const env of pending) {
      if (allowFood && env.op === "record_food") {
        const recordedAt = typeof env.payload.recordedAt === "string" ? env.payload.recordedAt : env.createdAt;
        if (localDateKey(recordedAt, bxTimeZone) !== targetDate) continue;
        pendingMatched.push(env);
        pendingMealCountDelta += 1;
        const cal = env.payload.calories ?? env.payload.kilocalories;
        if (typeof cal === "number" && Number.isFinite(cal)) {
          pendingCaloriesDelta += cal;
        } else {
          pendingUnknownCaloriesDelta += 1;
        }
      } else if (allowFood && (env.op === "update_food" || env.op === "delete_food")) {
        const id = String(env.payload.id ?? "");
        const rec = foodById.get(id);
        if (!rec) continue;
        const oldInDay = localDateKey(rec.eatenAt, bxTimeZone) === targetDate;
        const oldCal = typeof rec.calories === "number" && Number.isFinite(rec.calories) ? rec.calories : null;
        if (env.op === "delete_food") {
          if (oldInDay) {
            pendingMatched.push(env);
            pendingMealCountDelta -= 1;
            if (oldCal !== null) pendingCaloriesDelta -= oldCal;
            else pendingUnknownCaloriesDelta -= 1;
          }
          foodById.delete(id);
        } else {
          const nextIso = typeof env.payload.recordedAt === "string" ? env.payload.recordedAt : rec.eatenAt;
          const nextCal =
            env.payload.clearCalories === true
              ? null
              : typeof env.payload.calories === "number"
                ? env.payload.calories
                : oldCal;
          const newInDay = localDateKey(nextIso, bxTimeZone) === targetDate;
          if (oldInDay || newInDay) {
            pendingMatched.push(env);
            if (oldInDay && !newInDay) {
              pendingMealCountDelta -= 1;
              if (oldCal !== null) pendingCaloriesDelta -= oldCal;
              else pendingUnknownCaloriesDelta -= 1;
            } else if (!oldInDay && newInDay) {
              pendingMealCountDelta += 1;
              if (nextCal !== null) pendingCaloriesDelta += nextCal;
              else pendingUnknownCaloriesDelta += 1;
            } else if (oldInDay && newInDay) {
              pendingCaloriesDelta += (nextCal ?? 0) - (oldCal ?? 0);
              pendingUnknownCaloriesDelta += (nextCal === null ? 1 : 0) - (oldCal === null ? 1 : 0);
            }
          }
          rec.eatenAt = nextIso;
          rec.calories = nextCal;
        }
      } else if (allowSkin && env.op === "record_skin") {
        const recordedAt = typeof env.payload.recordedAt === "string" ? env.payload.recordedAt : env.createdAt;
        if (localDateKey(recordedAt, bxTimeZone) !== targetDate) continue;
        pendingMatched.push(env);
        pendingSkinCountDelta += 1;
      } else if (allowSkin && (env.op === "update_skin" || env.op === "delete_skin")) {
        const id = String(env.payload.id ?? "");
        const rec = skinById.get(id);
        if (!rec) continue;
        const oldInDay = localDateKey(rec.appliedAt, bxTimeZone) === targetDate;
        if (env.op === "delete_skin") {
          if (oldInDay) {
            pendingMatched.push(env);
            pendingSkinCountDelta -= 1;
          }
          skinById.delete(id);
        } else {
          const nextIso = typeof env.payload.recordedAt === "string" ? env.payload.recordedAt : rec.appliedAt;
          const newInDay = localDateKey(nextIso, bxTimeZone) === targetDate;
          if (oldInDay !== newInDay) {
            pendingMatched.push(env);
            pendingSkinCountDelta += newInDay ? 1 : -1;
          } else if (oldInDay) {
            pendingMatched.push(env);
          }
          rec.appliedAt = nextIso;
        }
      } else if (allowToilet && env.op === "record_toilet") {
        const recordedAt = typeof env.payload.recordedAt === "string" ? env.payload.recordedAt : env.createdAt;
        if (localDateKey(recordedAt, bxTimeZone) !== targetDate) continue;
        pendingMatched.push(env);
        if (env.payload.kind === "urination") {
          pendingUrinationCountDelta += 1;
        } else {
          pendingBowelCountDelta += 1;
        }
      } else if (allowToilet && (env.op === "update_toilet" || env.op === "delete_toilet")) {
        const id = String(env.payload.id ?? "");
        const rec = toiletById.get(id);
        if (!rec) continue;
        const oldInDay = localDateKey(rec.occurredAt, bxTimeZone) === targetDate;
        const oldKind = rec.kind;
        if (env.op === "delete_toilet") {
          if (oldInDay) {
            pendingMatched.push(env);
            if (oldKind === "urination") pendingUrinationCountDelta -= 1;
            else pendingBowelCountDelta -= 1;
          }
          toiletById.delete(id);
        } else {
          const nextIso = typeof env.payload.recordedAt === "string" ? env.payload.recordedAt : rec.occurredAt;
          const nextKind = (typeof env.payload.kind === "string" ? env.payload.kind : oldKind) as BxToiletRecord["kind"];
          const newInDay = localDateKey(nextIso, bxTimeZone) === targetDate;
          if (oldInDay || newInDay) {
            pendingMatched.push(env);
            if (oldInDay) {
              if (oldKind === "urination") pendingUrinationCountDelta -= 1;
              else pendingBowelCountDelta -= 1;
            }
            if (newInDay) {
              if (nextKind === "urination") pendingUrinationCountDelta += 1;
              else pendingBowelCountDelta += 1;
            }
          }
          rec.occurredAt = nextIso;
          rec.kind = nextKind;
        }
      }
    }

    const committedBowel = committedDay?.bowelCount ?? 0;
    const committedUrination = committedDay?.urinationCount ?? 0;
    const committedToilet = committedDay?.toiletCount ?? committedBowel + committedUrination;

    return {
      generatedAt: summary.generatedAt ?? null,
      timeZoneIdentifier: bxTimeZone ?? null,
      targetDate,
      committedDay,
      availableDays: summary.days?.map((day) => day.date) ?? [],
      catalog,
      optimisticOverlay: {
        pendingInboxCount: pendingMatched.length,
        optimisticTotals: {
          totalCalories: Math.max(0, Math.round(((committedDay?.totalCalories ?? 0) + pendingCaloriesDelta) * 10) / 10),
          unknownCaloriesCount: Math.max(0, (committedDay?.unknownCaloriesCount ?? 0) + pendingUnknownCaloriesDelta),
          mealCount: Math.max(0, (committedDay?.mealCount ?? 0) + pendingMealCountDelta),
          skinCount: Math.max(0, (committedDay?.skinCount ?? 0) + pendingSkinCountDelta),
          bowelCount: Math.max(0, committedBowel + pendingBowelCountDelta),
          urinationCount: Math.max(0, committedUrination + pendingUrinationCountDelta),
          toiletCount: Math.max(0, committedToilet + pendingBowelCountDelta + pendingUrinationCountDelta)
        },
        pendingRequests: pendingMatched.map((env) => ({
          requestId: env.requestId,
          op: env.op,
          createdAt: env.createdAt,
          payload: env.payload
        }))
      }
    };
  }

  async listPending(options: { app?: AgentAppID } = {}): Promise<Record<string, unknown>> {
    const rows = options.app
      ? (
          await this.db
            .prepare("SELECT * FROM inbox WHERE app = ? ORDER BY created_at ASC, rowid ASC")
            .bind(ExchangeStore.parseAppId(options.app))
            .all<InboxRow>()
        ).results
      : (
          await this.db
            .prepare("SELECT * FROM inbox ORDER BY created_at ASC, rowid ASC")
            .all<InboxRow>()
        ).results;

    const [sxTz, bxTz] = await Promise.all([
      rows.some((r) => r.app === "sx") ? this.readAppTimeZone("sx") : Promise.resolve(undefined),
      rows.some((r) => r.app === "bx") ? this.readAppTimeZone("bx") : Promise.resolve(undefined)
    ]);

    const items = rows.map((row) => {
      const env = mapInboxRow(row);
      let resolvedLocalTime: Record<string, unknown> | undefined;
      if (env.app === "sx" && typeof env.payload.date === "string") {
        const meta = localDateTimeParts(env.payload.date, sxTz);
        if (meta) {
          resolvedLocalTime = {
            ...meta,
            timeZoneIdentifier: sxTz ?? "UTC"
          };
        }
      } else if (env.app === "bx" && typeof env.payload.recordedAt === "string") {
        const meta = localDateTimeParts(env.payload.recordedAt, bxTz);
        if (meta) {
          resolvedLocalTime = {
            localDate: meta.localDate,
            localTime: meta.localTime,
            timeZoneIdentifier: bxTz ?? "UTC"
          };
        }
      }
      return {
        requestId: env.requestId,
        app: env.app,
        op: env.op,
        createdAt: env.createdAt,
        source: env.source,
        payload: env.payload,
        ...(resolvedLocalTime ? { resolvedLocalTime } : {})
      };
    });

    return {
      totalCount: items.length,
      items
    };
  }

  async cancelPending(requestIdInput: string): Promise<Record<string, unknown>> {
    const cleanId = requireNonEmptyString(requestIdInput, "requestId");
    const row = await this.db
      .prepare("SELECT * FROM inbox WHERE request_id = ?")
      .bind(cleanId)
      .first<InboxRow>();

    if (!row) {
      const receiptRow = await this.db
        .prepare("SELECT * FROM receipts WHERE request_id = ?")
        .bind(cleanId)
        .first<ReceiptRow>();
      if (receiptRow) {
        const receipt = mapReceiptRow(receiptRow);
        const recordHint = receipt.recordId ? ` (recordId: ${receipt.recordId})` : "";
        throw new Error(
          `Request '${cleanId}' already left the pending inbox and has receipt status '${receipt.status}'${recordHint}. Use the app's update or delete tool on that record instead.`
        );
      }
      throw new Error(`Pending request '${cleanId}' was not found in inbox.`);
    }

    const app = ExchangeStore.parseAppId(row.app);
    const state = await this.getAppState(app);
    if (state) {
      const policy = parsePolicyFromRow(state);
      if (state.permission === "disabled") {
        throw new Error(`App '${app}' is disabled. Enable permissions in ${app.toUpperCase()} Settings -> AI Assistant.`);
      }
      const domain = OP_DOMAIN_MAP[row.op];
      if (domain && !policy.allowedDomains.includes(domain)) {
        throw new Error(`Category '${domain}' is disabled by user policy in ${app.toUpperCase()}.`);
      }
      const opKind = opKindForPermission(row.op);
      if (opKind === "create" && !policy.allowCreate && !policy.allowDelete) {
        throw new Error(`App '${app}' permission policy does not allow cancelling queued create '${row.op}'.`);
      }
      if (opKind === "update" && !policy.allowUpdate && !policy.allowDelete) {
        throw new Error(`App '${app}' permission policy does not allow cancelling queued update '${row.op}'.`);
      }
      if (opKind === "delete" && !policy.allowDelete) {
        throw new Error(`App '${app}' permission policy does not allow cancelling queued delete '${row.op}'.`);
      }
    }

    await this.db.prepare("DELETE FROM inbox WHERE request_id = ?").bind(cleanId).run();
    return {
      cancelled: true,
      app,
      op: row.op,
      requestId: cleanId,
      cancelledPayload: safeJsonParse<Record<string, unknown>>(row.payload_json) ?? {}
    };
  }

  async updatePreferences(options: { content?: string; append?: string }): Promise<{ content: string; updatedAt: string }> {
    const hasContent = options.content !== undefined;
    const hasAppend = options.append !== undefined;
    if (!hasContent && !hasAppend) {
      throw new Error("Provide either 'content' (full Markdown replacement) or 'append' (note line/section to append).");
    }
    if (hasContent && hasAppend) {
      throw new Error("Provide either 'content' or 'append', not both.");
    }

    if (hasContent) {
      const { updatedAt } = await this.setPreferences(options.content ?? "");
      return { content: options.content ?? "", updatedAt };
    }

    const addition = requireNonEmptyString(options.append, "append");
    const existing = await this.getPreferences();
    const base =
      existing.updatedAt === null
        ? "# Personal CHAOX Assistant Preferences"
        : existing.content.trimEnd();
    const nextContent = base ? `${base}\n\n${addition}` : addition;
    const { updatedAt } = await this.setPreferences(nextContent);
    return { content: nextContent, updatedAt };
  }

  async getBriefing(options: { date?: string; apps?: string[] } = {}): Promise<Record<string, unknown>> {
    const requestedApps: AgentAppID[] = options.apps?.length
      ? Array.from(new Set(options.apps.map((a) => ExchangeStore.parseAppId(a))))
      : ["sx", "bx", "csteix"];

    const [stateRowsRes, inboxCountsRes, prefs] = await Promise.all([
      this.db.prepare("SELECT * FROM app_state").all<AppStateRow>(),
      this.db
        .prepare("SELECT app, COUNT(*) AS cnt FROM inbox GROUP BY app")
        .all<{ app: string; cnt: number }>(),
      this.getPreferences()
    ]);

    for (const row of stateRowsRes.results) {
      this.appStateCache.set(row.app as AgentAppID, row);
    }
    const pendingCounts: Record<string, number> = { sx: 0, bx: 0, csteix: 0 };
    for (const row of inboxCountsRes.results) {
      pendingCounts[row.app] = Number(row.cnt ?? 0);
    }

    const stateByApp = new Map(stateRowsRes.results.map((r) => [r.app as AgentAppID, r]));
    const appsStatus: Record<string, unknown> = {};
    for (const app of requestedApps) {
      const row = stateByApp.get(app);
      if (!row) {
        appsStatus[app] = { connected: false, permission: "disabled", pendingInboxCount: pendingCounts[app] ?? 0 };
      } else {
        const policy = parsePolicyFromRow(row);
        appsStatus[app] = {
          connected: true,
          permission: row.permission,
          allowRead: policy.allowRead,
          allowedDomains: policy.allowedDomains,
          lastSyncAt: row.last_sync_at ?? row.updated_at,
          pendingInboxCount: pendingCounts[app] ?? 0
        };
      }
    }

    const compactBucket = (res: Record<string, unknown> | null) => {
      if (!res) return null;
      const committed = res.committedBucket as Record<string, unknown> | null;
      const overlay = res.optimisticOverlay as Record<string, unknown>;
      return {
        summaryCurrency: res.summaryCurrency,
        committedNetTotal: committed?.netTotal ?? null,
        committedRecordCount: committed?.recordCount ?? null,
        pendingInboxCount: overlay?.pendingInboxCount ?? 0,
        pendingTotalsByCurrency: overlay?.pendingTotalsByCurrency ?? {},
        optimisticSameCurrencyTotal: overlay?.optimisticSameCurrencyTotal ?? null
      };
    };

    const buildSxBriefing = async () => {
      const row = stateByApp.get("sx");
      if (!row) return null;
      const policy = parsePolicyFromRow(row);
      if (row.permission === "disabled" || !policy.allowRead) {
        return { enabled: false, reason: "read_disabled" };
      }
      const allowed = new Set(policy.allowedDomains);
      const catalog = safeJsonParse<SxCatalog>(row.catalog_json);
      const [todayExp, monthExp, todayInc, monthInc] = await Promise.all([
        allowed.has("expenses") && row.summary_json
          ? this.readSxSummary({ period: "today", mode: "expense" }).catch(() => null)
          : Promise.resolve(null),
        allowed.has("expenses") && row.summary_json
          ? this.readSxSummary({ period: "month", mode: "expense" }).catch(() => null)
          : Promise.resolve(null),
        allowed.has("incomes") && row.summary_json
          ? this.readSxSummary({ period: "today", mode: "income" }).catch(() => null)
          : Promise.resolve(null),
        allowed.has("incomes") && row.summary_json
          ? this.readSxSummary({ period: "month", mode: "income" }).catch(() => null)
          : Promise.resolve(null)
      ]);
      const allProjects = allowed.has("projects") ? catalog?.projects ?? [] : [];
      return {
        enabled: true,
        timeZoneIdentifier: catalog?.timeZoneIdentifier ?? null,
        summaryCurrency: catalog?.summaryCurrency ?? null,
        supportedCurrencies: catalog?.supportedCurrencies ?? [],
        expense: { today: compactBucket(todayExp), month: compactBucket(monthExp) },
        income: { today: compactBucket(todayInc), month: compactBucket(monthInc) },
        ...(allowed.has("projects")
          ? {
              expenseProjects: allProjects
                .filter((p) => p.supportsExpense !== false)
                .map((p) => ({ name: p.name, currency: p.currency, recentTags: p.recentExpenseTags ?? [] })),
              incomeProjects: allProjects
                .filter((p) => p.supportsIncome)
                .map((p) => ({ name: p.name, currency: p.currency, recentTags: p.recentIncomeTags ?? [] }))
            }
          : {}),
        ...(allowed.has("tags") && catalog?.tags ? { tags: catalog.tags } : {})
      };
    };

    const buildBxBriefing = async () => {
      const row = stateByApp.get("bx");
      if (!row) return null;
      const policy = parsePolicyFromRow(row);
      if (row.permission === "disabled" || !policy.allowRead) {
        return { enabled: false, reason: "read_disabled" };
      }
      const allowed = new Set(policy.allowedDomains);
      const summaryBundle = safeJsonParse<BxSummaryBundle>(row.summary_json);
      const catalog = safeJsonParse<BxCatalog>(row.catalog_json);
      const bxTz = summaryBundle?.timeZoneIdentifier?.trim() || catalog?.timeZoneIdentifier?.trim() || undefined;
      const targetDate = options.date?.trim() || summaryBundle?.today?.date || localDateKey(new Date().toISOString(), bxTz);

      const [bxSummary, sleepPage, workoutsPage] = await Promise.all([
        summaryBundle ? this.readBxSummary({ date: targetDate }).catch(() => null) : Promise.resolve(null),
        allowed.has("sleep") ? this.bx.listSleep({ limit: 1 }).catch(() => null) : Promise.resolve(null),
        allowed.has("workouts")
          ? this.bx.listWorkouts({ from: targetDate, to: targetDate, limit: 10 }).catch(() => null)
          : Promise.resolve(null)
      ]);

      const sleepItems = (sleepPage?.items as Array<Record<string, unknown>> | undefined) ?? [];
      const workoutItems = (workoutsPage?.items as Array<Record<string, unknown>> | undefined) ?? [];
      return {
        enabled: true,
        targetDate,
        timeZoneIdentifier: bxTz ?? null,
        summary: bxSummary
          ? {
              committedDay: bxSummary.committedDay,
              optimisticOverlay: bxSummary.optimisticOverlay,
              recentSkinNames: (bxSummary.catalog as BxCatalog | null)?.recentSkinNames ?? {}
            }
          : null,
        ...(allowed.has("sleep")
          ? {
              latestSleep: sleepItems[0]
                ? {
                    day: sleepItems[0].day,
                    asleepMinutes: sleepItems[0].asleepMinutes,
                    inBedMinutes: sleepItems[0].inBedMinutes,
                    stagesMinutes: sleepItems[0].stagesMinutes
                  }
                : null
            }
          : {}),
        ...(allowed.has("workouts")
          ? {
              workoutsOnDate: workoutItems.map((w) => ({
                id: w.id,
                effectiveActivityName: w.effectiveActivityName,
                durationMinutes: w.durationMinutes,
                activeEnergyKcal: w.activeEnergyKcal ?? null,
                exerciseCount: Array.isArray(w.exercises) ? w.exercises.length : 0
              }))
            }
          : {})
      };
    };

    const buildCsteixBriefing = async () => {
      const row = stateByApp.get("csteix");
      if (!row) return null;
      const policy = parsePolicyFromRow(row);
      if (row.permission === "disabled" || !policy.allowRead) {
        return { enabled: false, reason: "read_disabled" };
      }
      const dateFilter = options.date?.trim();
      return {
        enabled: true,
        ...(await this.csteix.getSummary(
          dateFilter ? { from: dateFilter, to: dateFilter } : {}
        ))
      };
    };

    const [sxData, bxData, csteixData] = await Promise.all([
      requestedApps.includes("sx") ? buildSxBriefing() : Promise.resolve(null),
      requestedApps.includes("bx") ? buildBxBriefing() : Promise.resolve(null),
      requestedApps.includes("csteix") ? buildCsteixBriefing() : Promise.resolve(null)
    ]);

    return {
      generatedAt: new Date().toISOString(),
      requestedDate: options.date?.trim() || null,
      hasCustomPreferences: prefs.updatedAt !== null,
      ...(prefs.updatedAt !== null ? { preferences: prefs.content } : {}),
      apps: appsStatus,
      ...(requestedApps.includes("sx") ? { sx: sxData } : {}),
      ...(requestedApps.includes("bx") ? { bx: bxData } : {}),
      ...(requestedApps.includes("csteix") ? { csteix: csteixData } : {})
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
    this.appStateCache.delete(app);

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
    this.appStateCache.delete(app);
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
