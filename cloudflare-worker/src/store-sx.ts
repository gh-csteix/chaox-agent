import {
  generateRequestId,
  localDateHourParts,
  localDateKey,
  matchesDateRange,
  matchesQuery,
  normalizePagination,
  paginate,
  requireNonEmptyString,
  resolveSxTimestamp,
  safeJsonParse,
  validateLocalHour
} from "./store-helpers.js";
import { BxStoreContext } from "./store-bx.js";
import {
  SxCatalog,
  SxCredentialRecord,
  SxExpenseRecord,
  SxIncomeRecord,
  SxProjectRecord,
  SxSloganRecord,
  SxTagRecord
} from "./types.js";

const VALID_CYCLES = new Set(["daily", "weekly", "monthly", "quarterly", "yearly", "irregular"]);
const VALID_PRICE_TYPES = new Set(["fixed", "floating"]);
const VALID_PROJECT_TYPES = new Set(["nonRenewal", "autoRenew", "pausedRenew", "expired"]);
const VALID_CASH_FLOW_PRESETS = new Set(["expenseOnly", "incomeOnly", "both"]);

function catalogTimeZone(catalog: SxCatalog | null, fallbackTz?: string): string | undefined {
  return catalog?.timeZoneIdentifier?.trim() || fallbackTz?.trim() || undefined;
}

function resolvedLocalTimeMeta(isoDate: string | undefined, timeZone?: string) {
  if (!isoDate) return undefined;
  const parts = localDateHourParts(isoDate, timeZone);
  if (!parts) return undefined;
  return {
    paidAt: isoDate,
    localDate: parts.localDate,
    localHour: parts.localHour,
    displayDate: parts.displayDate,
    timeZoneIdentifier: timeZone ?? "UTC"
  };
}

function enrichExpenseLocalFields(item: SxExpenseRecord, timeZone?: string): SxExpenseRecord {
  const parts = localDateHourParts(item.paidAt, timeZone);
  if (!parts) return item;
  const isQueuedMutation = item.pendingStatus === "queued_create" || item.pendingStatus === "queued_update";
  if (isQueuedMutation || !item.localDate) {
    item.localDate = parts.localDate;
  }
  if (isQueuedMutation || item.localHour === undefined || item.localHour === null) {
    item.localHour = parts.localHour;
  }
  if (isQueuedMutation || !item.displayDate) {
    item.displayDate = parts.displayDate;
  }
  return item;
}

function normalizeCurrencyCode(raw: string | undefined, catalog: SxCatalog | null): string | undefined {
  const trimmed = raw?.trim().toUpperCase();
  if (!trimmed) return undefined;
  if (!/^[A-Z]{3}$/.test(trimmed)) {
    throw new Error(`Invalid ISO currency code '${raw}'. Expected 3 uppercase ASCII letters.`);
  }
  if (catalog?.supportedCurrencies?.length) {
    const allowed = new Set(catalog.supportedCurrencies.map((c) => c.toUpperCase()));
    if (!allowed.has(trimmed)) {
      throw new Error(`Unsupported currency '${trimmed}'. Supported: ${catalog.supportedCurrencies.join(", ")}`);
    }
  }
  return trimmed;
}

function validateId(raw: unknown, fieldName: string): number {
  const num = Number(raw);
  if (!Number.isInteger(num) || num <= 0) {
    throw new Error(`'${fieldName}' must be a positive integer.`);
  }
  return num;
}

function normalizeTagsArray(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error("'tags' must be an array of strings.");
  }
  return raw.map((t) => String(t).trim()).filter((t) => t.length > 0);
}

export class SxOperations {
  constructor(private readonly ctx: BxStoreContext) {}

  // MARK: - Reads

  async listProjects(options: {
    query?: string;
    projectType?: string;
    cashFlow?: string;
    currency?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<Record<string, unknown>> {
    await this.ctx.assertDomainReadAllowed("sx", "projects");
    const dataset = await this.ctx.readDataset<SxProjectRecord>("sx", "projects");
    const items: SxProjectRecord[] = dataset ? dataset.map((p) => ({ ...p })) : [];
    const byId = new Map(items.map((p) => [p.id, p]));

    const pending = await this.ctx.listPendingEnvelopes("sx");
    for (const env of pending) {
      if (env.op === "create_project") {
        const cashFlow = String(env.payload.cashFlowSides ?? "expenseOnly");
        items.unshift({
          id: -1,
          name: String(env.payload.name ?? ""),
          price: Number(env.payload.price ?? 0),
          currency: String(env.payload.currency ?? "CNY"),
          cycle: String(env.payload.cycle ?? "irregular"),
          priceType: String(env.payload.priceType ?? "floating"),
          projectType: String(env.payload.projectType ?? "nonRenewal"),
          cashFlowSides: cashFlow,
          supportsExpense: cashFlow === "expenseOnly" || cashFlow === "both",
          supportsIncome: cashFlow === "incomeOnly" || cashFlow === "both",
          startDate: String(env.payload.startDate ?? env.createdAt),
          endDate: typeof env.payload.endDate === "string" ? env.payload.endDate : null,
          isAutoRenew: env.payload.projectType === "autoRenew",
          notes: String(env.payload.notes ?? ""),
          expenseCount: 0,
          incomeCount: 0,
          credentialLinkCount: 0,
          deletable: true,
          pendingStatus: "queued_create"
        });
      } else if (env.op === "update_project") {
        const target = byId.get(Number(env.payload.id));
        if (target) {
          if (typeof env.payload.name === "string") target.name = env.payload.name;
          if (typeof env.payload.price === "number") target.price = env.payload.price;
          if (typeof env.payload.currency === "string") target.currency = env.payload.currency;
          if (typeof env.payload.projectType === "string") target.projectType = env.payload.projectType;
          target.pendingStatus = "queued_update";
        }
      } else if (env.op === "delete_project") {
        const target = byId.get(Number(env.payload.id));
        if (target) target.pendingStatus = "queued_delete";
      }
    }

    let filtered = items;
    if (options.projectType?.trim()) {
      const pt = options.projectType.trim().toLowerCase();
      filtered = filtered.filter((p) => p.projectType.toLowerCase() === pt);
    }
    if (options.cashFlow?.trim()) {
      const cf = options.cashFlow.trim().toLowerCase();
      if (cf === "expense") filtered = filtered.filter((p) => p.supportsExpense);
      else if (cf === "income") filtered = filtered.filter((p) => p.supportsIncome);
    }
    if (options.currency?.trim()) {
      const cur = options.currency.trim().toUpperCase();
      filtered = filtered.filter((p) => p.currency.toUpperCase() === cur);
    }
    if (options.query?.trim()) {
      filtered = filtered.filter((p) => matchesQuery(options.query, [p.name, p.notes, p.currency]));
    }

    const { limit, offset } = normalizePagination(options);
    return {
      datasetUploaded: dataset !== null,
      ...paginate(filtered, limit, offset)
    };
  }

  async listExpenses(options: {
    from?: string;
    to?: string;
    projectId?: number;
    projectName?: string;
    tag?: string;
    currency?: string;
    query?: string;
    includeRefunds?: boolean;
    limit?: number;
    offset?: number;
  } = {}): Promise<Record<string, unknown>> {
    await this.ctx.assertDomainReadAllowed("sx", "expenses");
    const dataset = await this.ctx.readDataset<SxExpenseRecord>("sx", "expenses");
    const items: SxExpenseRecord[] = dataset
      ? dataset.map((item) => ({ ...item, refunds: item.refunds?.map((r) => ({ ...r })) }))
      : [];
    const byId = new Map(items.map((item) => [item.id, item]));

    const pending = await this.ctx.listPendingEnvelopes("sx");
    for (const env of pending) {
      if (env.op === "record_expense") {
        const amount = Number(env.payload.amount ?? 0);
        const created: SxExpenseRecord = {
          id: -1,
          projectId: -1,
          projectName: String(env.payload.projectName ?? ""),
          credentialId: typeof env.payload.credentialId === "number" ? env.payload.credentialId : undefined,
          amount,
          netAmount: amount,
          refundTotal: 0,
          currency: String(env.payload.currency ?? ""),
          tags: Array.isArray(env.payload.tags) ? env.payload.tags.map(String) : [],
          notes: String(env.payload.note ?? env.payload.notes ?? ""),
          paidAt: String(env.payload.date ?? env.createdAt),
          pendingStatus: "queued_create",
          pendingRequestId: env.requestId
        };
        items.unshift(created);
      } else if (env.op === "update_expense") {
        const target = byId.get(Number(env.payload.id));
        if (target) {
          if (typeof env.payload.amount === "number") {
            target.amount = env.payload.amount;
            target.netAmount = Math.round((target.amount - target.refundTotal) * 100) / 100;
          }
          if (typeof env.payload.projectName === "string") target.projectName = env.payload.projectName;
          if (typeof env.payload.credentialId === "number") target.credentialId = env.payload.credentialId;
          if (env.payload.clearCredential === true) {
            target.credentialId = null;
            target.credentialName = null;
          }
          if (typeof env.payload.currency === "string") target.currency = env.payload.currency;
          if (Array.isArray(env.payload.tags)) target.tags = env.payload.tags.map(String);
          if (typeof env.payload.note === "string") target.notes = env.payload.note;
          else if (typeof env.payload.notes === "string") target.notes = env.payload.notes;
          if (typeof env.payload.date === "string") {
            target.paidAt = env.payload.date;
            target.localDate = undefined;
            target.localHour = undefined;
            target.displayDate = undefined;
          }
          target.pendingStatus = "queued_update";
          target.pendingRequestId = env.requestId;
        }
      } else if (env.op === "delete_expense") {
        const target = byId.get(Number(env.payload.id));
        if (target) {
          target.pendingStatus = "queued_delete";
          target.pendingRequestId = env.requestId;
        }
      }
    }

    const timeZone = await this.ctx.readAppTimeZone?.("sx");
    for (const item of items) {
      enrichExpenseLocalFields(item, timeZone);
    }
    let filtered = items.filter((item) => matchesDateRange(item.paidAt, options.from, options.to, item.localDate, timeZone));
    if (typeof options.projectId === "number") {
      filtered = filtered.filter((item) => item.projectId === options.projectId);
    }
    if (options.projectName?.trim()) {
      const pn = options.projectName.trim().toLowerCase();
      filtered = filtered.filter((item) => item.projectName.toLowerCase().includes(pn));
    }
    if (options.tag?.trim()) {
      const tag = options.tag.trim().toLowerCase();
      filtered = filtered.filter((item) => item.tags.some((t) => t.toLowerCase() === tag));
    }
    if (options.currency?.trim()) {
      const cur = options.currency.trim().toUpperCase();
      filtered = filtered.filter((item) => item.currency.toUpperCase() === cur);
    }
    if (options.query?.trim()) {
      filtered = filtered.filter((item) => matchesQuery(options.query, [item.projectName, item.notes, ...item.tags]));
    }
    filtered.sort((a, b) => b.paidAt.localeCompare(a.paidAt));

    const includeRefunds = options.includeRefunds !== false;
    if (!includeRefunds) {
      filtered = filtered.map(({ refunds: _r, ...rest }) => rest);
    }

    const { limit, offset } = normalizePagination(options);
    return {
      datasetUploaded: dataset !== null,
      timeZoneIdentifier: timeZone ?? null,
      ...paginate(filtered, limit, offset)
    };
  }

  async listIncomes(options: {
    from?: string;
    to?: string;
    projectId?: number;
    projectName?: string;
    tag?: string;
    currency?: string;
    query?: string;
    includeReversals?: boolean;
    limit?: number;
    offset?: number;
  } = {}): Promise<Record<string, unknown>> {
    await this.ctx.assertDomainReadAllowed("sx", "incomes");
    const dataset = await this.ctx.readDataset<SxIncomeRecord>("sx", "incomes");
    const items: SxIncomeRecord[] = dataset
      ? dataset.map((item) => ({ ...item, reversals: item.reversals?.map((r) => ({ ...r })) }))
      : [];
    const byId = new Map(items.map((item) => [item.id, item]));

    const pending = await this.ctx.listPendingEnvelopes("sx");
    for (const env of pending) {
      if (env.op === "record_income") {
        const amount = Number(env.payload.amount ?? 0);
        items.unshift({
          id: -1,
          projectId: -1,
          projectName: String(env.payload.projectName ?? ""),
          credentialId: typeof env.payload.credentialId === "number" ? env.payload.credentialId : undefined,
          amount,
          netAmount: amount,
          reversalTotal: 0,
          currency: String(env.payload.currency ?? ""),
          tags: Array.isArray(env.payload.tags) ? env.payload.tags.map(String) : [],
          notes: String(env.payload.note ?? env.payload.notes ?? ""),
          receivedAt: String(env.payload.date ?? env.createdAt),
          pendingStatus: "queued_create",
          pendingRequestId: env.requestId
        });
      } else if (env.op === "update_income") {
        const target = byId.get(Number(env.payload.id));
        if (target) {
          if (typeof env.payload.amount === "number") {
            target.amount = env.payload.amount;
            target.netAmount = Math.round((target.amount - target.reversalTotal) * 100) / 100;
          }
          if (typeof env.payload.projectName === "string") target.projectName = env.payload.projectName;
          if (typeof env.payload.credentialId === "number") target.credentialId = env.payload.credentialId;
          if (env.payload.clearCredential === true) {
            target.credentialId = null;
            target.credentialName = null;
          }
          if (typeof env.payload.currency === "string") target.currency = env.payload.currency;
          if (Array.isArray(env.payload.tags)) target.tags = env.payload.tags.map(String);
          if (typeof env.payload.note === "string") target.notes = env.payload.note;
          else if (typeof env.payload.notes === "string") target.notes = env.payload.notes;
          if (typeof env.payload.date === "string") {
            target.receivedAt = env.payload.date;
            target.localDate = undefined;
          }
          target.pendingStatus = "queued_update";
          target.pendingRequestId = env.requestId;
        }
      } else if (env.op === "delete_income") {
        const target = byId.get(Number(env.payload.id));
        if (target) {
          target.pendingStatus = "queued_delete";
          target.pendingRequestId = env.requestId;
        }
      }
    }

    const timeZone = await this.ctx.readAppTimeZone?.("sx");
    for (const item of items) {
      if (!item.localDate || item.pendingStatus === "queued_create" || item.pendingStatus === "queued_update") {
        const key = localDateKey(item.receivedAt, timeZone);
        if (key) item.localDate = key;
      }
    }
    let filtered = items.filter((item) =>
      matchesDateRange(item.receivedAt, options.from, options.to, item.localDate, timeZone)
    );
    if (typeof options.projectId === "number") {
      filtered = filtered.filter((item) => item.projectId === options.projectId);
    }
    if (options.projectName?.trim()) {
      const pn = options.projectName.trim().toLowerCase();
      filtered = filtered.filter((item) => item.projectName.toLowerCase().includes(pn));
    }
    if (options.tag?.trim()) {
      const tag = options.tag.trim().toLowerCase();
      filtered = filtered.filter((item) => item.tags.some((t) => t.toLowerCase() === tag));
    }
    if (options.currency?.trim()) {
      const cur = options.currency.trim().toUpperCase();
      filtered = filtered.filter((item) => item.currency.toUpperCase() === cur);
    }
    if (options.query?.trim()) {
      filtered = filtered.filter((item) => matchesQuery(options.query, [item.projectName, item.notes, ...item.tags]));
    }
    filtered.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));

    if (options.includeReversals === false) {
      filtered = filtered.map(({ reversals: _r, ...rest }) => rest);
    }

    const { limit, offset } = normalizePagination(options);
    return {
      datasetUploaded: dataset !== null,
      timeZoneIdentifier: timeZone ?? null,
      ...paginate(filtered, limit, offset)
    };
  }

  async listTags(options: { query?: string } = {}): Promise<Record<string, unknown>> {
    await this.ctx.assertDomainReadAllowed("sx", "tags");
    const dataset = await this.ctx.readDataset<SxTagRecord>("sx", "tags");
    const items: SxTagRecord[] = dataset ? dataset.map((t) => ({ ...t })) : [];
    const byId = new Map(items.map((t) => [t.id, t]));

    const pending = await this.ctx.listPendingEnvelopes("sx");
    for (const env of pending) {
      if (env.op === "create_tag") {
        items.push({
          id: -1,
          name: String(env.payload.name ?? ""),
          expenseCount: 0,
          incomeCount: 0,
          pendingStatus: "queued_create"
        });
      } else if (env.op === "rename_tag") {
        const target = byId.get(Number(env.payload.id));
        if (target && typeof env.payload.name === "string") {
          target.name = env.payload.name;
          target.pendingStatus = "queued_update";
        }
      } else if (env.op === "delete_tag") {
        const target = byId.get(Number(env.payload.id));
        if (target) target.pendingStatus = "queued_delete";
      }
    }

    const filtered = options.query?.trim()
      ? items.filter((t) => matchesQuery(options.query, [t.name]))
      : items;

    return {
      datasetUploaded: dataset !== null,
      totalCount: filtered.length,
      items: filtered
    };
  }

  async listSlogans(options: {
    language?: string;
    enabledOnly?: boolean;
    query?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<Record<string, unknown>> {
    await this.ctx.assertDomainReadAllowed("sx", "slogans");
    const dataset = await this.ctx.readDataset<SxSloganRecord>("sx", "slogans");
    const items: SxSloganRecord[] = dataset ? dataset.map((s) => ({ ...s })) : [];
    const byId = new Map(items.map((s) => [s.id, s]));

    const pending = await this.ctx.listPendingEnvelopes("sx");
    for (const env of pending) {
      if (env.op === "create_slogan") {
        items.unshift({
          id: -1,
          language: String(env.payload.language ?? "zh-Hans"),
          text: String(env.payload.text ?? ""),
          emoji: typeof env.payload.emoji === "string" ? env.payload.emoji : null,
          ruleType: String(env.payload.ruleType ?? "always"),
          ruleValue: String(env.payload.ruleValue ?? ""),
          priority: Number(env.payload.priority ?? 0),
          isEnabled: env.payload.isEnabled !== false,
          pendingStatus: "queued_create"
        });
      } else if (env.op === "update_slogan") {
        const target = byId.get(Number(env.payload.id));
        if (target) {
          if (typeof env.payload.text === "string") target.text = env.payload.text;
          if (typeof env.payload.isEnabled === "boolean") target.isEnabled = env.payload.isEnabled;
          target.pendingStatus = "queued_update";
        }
      } else if (env.op === "delete_slogan") {
        const target = byId.get(Number(env.payload.id));
        if (target) target.pendingStatus = "queued_delete";
      }
    }

    let filtered = items;
    if (options.language?.trim()) {
      const lang = options.language.trim().toLowerCase();
      filtered = filtered.filter((s) => s.language.toLowerCase() === lang);
    }
    if (options.enabledOnly) {
      filtered = filtered.filter((s) => s.isEnabled);
    }
    if (options.query?.trim()) {
      filtered = filtered.filter((s) => matchesQuery(options.query, [s.text, s.ruleType, s.ruleValue]));
    }
    const { limit, offset } = normalizePagination(options);
    return {
      datasetUploaded: dataset !== null,
      ...paginate(filtered, limit, offset)
    };
  }

  // MARK: - Expenses & Refunds CRUD

  private async listPendingCreatedProjects(): Promise<Array<{ name: string; cashFlowSides: string }>> {
    const pending = await this.ctx.listPendingEnvelopes("sx");
    const created: Array<{ name: string; cashFlowSides: string }> = [];
    for (const env of pending) {
      if (env.op !== "create_project") continue;
      const name = typeof env.payload.name === "string" ? env.payload.name.trim() : "";
      if (!name) continue;
      const cashFlowSides =
        typeof env.payload.cashFlowSides === "string" && env.payload.cashFlowSides.trim()
          ? env.payload.cashFlowSides.trim()
          : "expenseOnly";
      created.push({ name, cashFlowSides });
    }
    return created;
  }

  private async findExpenseForUpdate(id: number): Promise<SxExpenseRecord | null> {
    const dataset = await this.ctx.readDataset<SxExpenseRecord>("sx", "expenses");
    const match = dataset?.find((item) => item.id === id);
    if (!match) return null;
    const copy: SxExpenseRecord = { ...match };
    const pending = await this.ctx.listPendingEnvelopes("sx");
    for (const env of pending) {
      if (env.op === "update_expense" && Number(env.payload.id) === id && typeof env.payload.date === "string") {
        copy.paidAt = env.payload.date;
        copy.localDate = undefined;
      } else if (env.op === "delete_expense" && Number(env.payload.id) === id) {
        return null;
      }
    }
    return copy;
  }

  private validateRecordPayload(
    input: {
      amount: number;
      projectName: string;
      currency?: string;
      tags?: string[];
      note?: string;
      notes?: string;
      date?: string;
      hour?: unknown;
    },
    mode: "expense" | "income",
    catalogJson: string | null,
    pendingProjects: Array<{ name: string; cashFlowSides: string }> = [],
    fallbackTimeZone?: string
  ): { payload: Record<string, unknown>; timeZone?: string } {
    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      throw new Error("SX amount must be a finite number greater than 0.");
    }
    const rawProject = requireNonEmptyString(input.projectName, "projectName");
    const catalog = safeJsonParse<SxCatalog>(catalogJson);
    const timeZone = catalogTimeZone(catalog, fallbackTimeZone);
    const normalizedCurrency = normalizeCurrencyCode(input.currency, catalog);

    let normalizedProject = rawProject;
    const match = catalog?.projects?.find((proj) => proj.name.trim().toLowerCase() === rawProject.toLowerCase());
    if (match) {
      if (mode === "expense" && match.supportsExpense === false) {
        throw new Error(`Project '${match.name}' does not support expense records.`);
      }
      if (mode === "income" && match.supportsIncome === false) {
        throw new Error(`Project '${match.name}' does not support income records.`);
      }
      normalizedProject = match.name;
    } else {
      const pendingMatch = pendingProjects.find((proj) => proj.name.toLowerCase() === rawProject.toLowerCase());
      if (pendingMatch) {
        const supportsExpense = pendingMatch.cashFlowSides === "expenseOnly" || pendingMatch.cashFlowSides === "both";
        const supportsIncome = pendingMatch.cashFlowSides === "incomeOnly" || pendingMatch.cashFlowSides === "both";
        if (mode === "expense" && !supportsExpense) {
          throw new Error(`Project '${pendingMatch.name}' does not support expense records.`);
        }
        if (mode === "income" && !supportsIncome) {
          throw new Error(`Project '${pendingMatch.name}' does not support income records.`);
        }
        normalizedProject = pendingMatch.name;
      } else if (catalog?.projects?.length) {
        const names = [
          ...catalog.projects.map((proj) => proj.name),
          ...pendingProjects.map((proj) => proj.name)
        ].join(", ");
        throw new Error(`Unknown projectName '${rawProject}'. Known projects: ${names}`);
      }
    }

    const isoDate = resolveSxTimestamp(input.date, "date", {
      timeZone,
      hour: mode === "expense" ? input.hour : undefined,
      defaultLocalHour: 0,
      allowHourOnly: mode === "expense"
    });
    const payload: Record<string, unknown> = {
      amount: Math.round(input.amount * 100) / 100,
      projectName: normalizedProject
    };
    if (normalizedCurrency) payload.currency = normalizedCurrency;
    if (input.tags !== undefined) {
      payload.tags = input.tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0);
    }
    const mergedNote = input.note ?? input.notes;
    if (mergedNote?.trim()) payload.note = mergedNote.trim();
    if (isoDate) payload.date = isoDate;
    return { payload, timeZone };
  }

  async recordExpense(input: {
    amount: number;
    projectName: string;
    credentialId?: number;
    currency?: string;
    tags?: string[];
    note?: string;
    notes?: string;
    date?: string;
    hour?: unknown;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    const state = await this.ctx.assertActionAllowed("sx", "create", "expenses");
    const pendingProjects = await this.listPendingCreatedProjects();
    const fallbackTz = await this.ctx.readAppTimeZone?.("sx");
    const { payload, timeZone } = this.validateRecordPayload(
      input,
      "expense",
      state.catalog_json,
      pendingProjects,
      fallbackTz
    );
    if (input.credentialId !== undefined) {
      await this.ctx.assertActionDomainAllowed?.("sx", "credentials");
      payload.credentialId = validateId(input.credentialId, "credentialId");
    }
    const requestId = input.requestId?.trim() || generateRequestId("sx-exp");
    payload.stableID = `sx:d1:${requestId}`;
    const result = await this.ctx.enqueueInbox("sx", "record_expense", requestId, input.client, payload);
    const localTime = resolvedLocalTimeMeta(
      typeof payload.date === "string" ? payload.date : undefined,
      timeZone
    );
    return localTime && result.queued === true ? { ...result, resolvedLocalTime: localTime } : result;
  }

  async updateExpense(input: {
    id: number;
    amount?: number;
    projectName?: string;
    credentialId?: number;
    clearCredential?: boolean;
    currency?: string;
    tags?: string[];
    note?: string;
    notes?: string;
    date?: string;
    hour?: unknown;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    const state = await this.ctx.assertActionAllowed("sx", "update", "expenses");
    const id = validateId(input.id, "id");
    const payload: Record<string, unknown> = { id };
    const catalog = safeJsonParse<SxCatalog>(state.catalog_json);
    const timeZone = catalogTimeZone(catalog, await this.ctx.readAppTimeZone?.("sx"));

    if (input.credentialId !== undefined || input.clearCredential === true) {
      await this.ctx.assertActionDomainAllowed?.("sx", "credentials");
      if (input.credentialId !== undefined) {
        payload.credentialId = validateId(input.credentialId, "credentialId");
      }
      if (input.clearCredential === true) {
        payload.clearCredential = true;
      }
    }
    if (input.amount !== undefined) {
      if (!Number.isFinite(input.amount) || input.amount <= 0) {
        throw new Error("SX 'amount' must be > 0.");
      }
      payload.amount = Math.round(input.amount * 100) / 100;
    }
    if (input.projectName !== undefined) {
      payload.projectName = requireNonEmptyString(input.projectName, "projectName");
    }
    if (input.currency !== undefined) {
      const normalized = normalizeCurrencyCode(input.currency, catalog);
      if (normalized) payload.currency = normalized;
    }
    const tags = normalizeTagsArray(input.tags);
    if (tags !== undefined) payload.tags = tags;
    const resolvedNote = input.note !== undefined ? input.note : input.notes;
    if (resolvedNote !== undefined) payload.note = resolvedNote.trim();

    let isoDate: string | undefined;
    const hasHourInput = input.hour !== undefined && input.hour !== null;
    if (hasHourInput && !input.date?.trim()) {
      const hour = validateLocalHour(input.hour);
      const existing = await this.findExpenseForUpdate(id);
      const existingLocalDate =
        existing?.localDate?.trim() || localDateHourParts(existing?.paidAt, timeZone)?.localDate;
      if (!existingLocalDate) {
        throw new Error(
          `Cannot update 'hour' alone because expense #${id} is not in the synced snapshot yet. Please provide 'date' (e.g. 'YYYY-MM-DD') together with 'hour'.`
        );
      }
      isoDate = resolveSxTimestamp(existingLocalDate, "date", {
        timeZone,
        hour,
        defaultLocalHour: 0,
        allowHourOnly: false
      });
    } else if (input.date !== undefined || hasHourInput) {
      isoDate = resolveSxTimestamp(input.date, "date", {
        timeZone,
        hour: input.hour,
        defaultLocalHour: 0,
        allowHourOnly: false
      });
    }
    if (isoDate) payload.date = isoDate;

    if (Object.keys(payload).length === 1) {
      throw new Error("update_expense requires at least one field to update.");
    }
    const requestId = input.requestId?.trim() || generateRequestId("sx-exp-upd");
    const result = await this.ctx.enqueueInbox("sx", "update_expense", requestId, input.client, payload);
    const localTime = resolvedLocalTimeMeta(
      typeof payload.date === "string" ? payload.date : undefined,
      timeZone
    );
    return localTime && result.queued === true ? { ...result, resolvedLocalTime: localTime } : result;
  }

  async deleteExpense(input: { id: number; requestId?: string; client?: string }): Promise<Record<string, unknown>> {
    await this.ctx.assertActionAllowed("sx", "delete", "expenses");
    const id = validateId(input.id, "id");
    const requestId = input.requestId?.trim() || generateRequestId("sx-exp-del");
    return this.ctx.enqueueInbox("sx", "delete_expense", requestId, input.client, { id });
  }

  async recordRefund(input: {
    paymentId: number;
    amount: number;
    note?: string;
    notes?: string;
    date?: string;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    const state = await this.ctx.assertActionAllowed("sx", "create", "expenses");
    const catalog = safeJsonParse<SxCatalog>(state.catalog_json);
    const timeZone = catalogTimeZone(catalog, await this.ctx.readAppTimeZone?.("sx"));
    const paymentId = validateId(input.paymentId, "paymentId");
    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      throw new Error("Refund 'amount' must be > 0.");
    }
    const payload: Record<string, unknown> = {
      paymentId,
      amount: Math.round(input.amount * 100) / 100
    };
    const mergedNote = input.note ?? input.notes;
    if (mergedNote?.trim()) payload.note = mergedNote.trim();
    const isoDate = resolveSxTimestamp(input.date, "date", { timeZone, defaultLocalHour: 0 });
    if (isoDate) payload.date = isoDate;

    const requestId = input.requestId?.trim() || generateRequestId("sx-ref");
    return this.ctx.enqueueInbox("sx", "record_refund", requestId, input.client, payload);
  }

  async updateRefund(input: {
    id: number;
    amount?: number;
    note?: string;
    notes?: string;
    date?: string;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    const state = await this.ctx.assertActionAllowed("sx", "update", "expenses");
    const catalog = safeJsonParse<SxCatalog>(state.catalog_json);
    const timeZone = catalogTimeZone(catalog, await this.ctx.readAppTimeZone?.("sx"));
    const id = validateId(input.id, "id");
    const payload: Record<string, unknown> = { id };
    if (input.amount !== undefined) {
      if (!Number.isFinite(input.amount) || input.amount <= 0) throw new Error("Refund 'amount' must be > 0.");
      payload.amount = Math.round(input.amount * 100) / 100;
    }
    const resolvedNote = input.note !== undefined ? input.note : input.notes;
    if (resolvedNote !== undefined) payload.note = resolvedNote.trim();
    const isoDate = resolveSxTimestamp(input.date, "date", { timeZone, defaultLocalHour: 0 });
    if (isoDate) payload.date = isoDate;
    if (Object.keys(payload).length === 1) throw new Error("update_refund requires at least one field to update.");
    const requestId = input.requestId?.trim() || generateRequestId("sx-ref-upd");
    return this.ctx.enqueueInbox("sx", "update_refund", requestId, input.client, payload);
  }

  async deleteRefund(input: { id: number; requestId?: string; client?: string }): Promise<Record<string, unknown>> {
    await this.ctx.assertActionAllowed("sx", "delete", "expenses");
    const id = validateId(input.id, "id");
    const requestId = input.requestId?.trim() || generateRequestId("sx-ref-del");
    return this.ctx.enqueueInbox("sx", "delete_refund", requestId, input.client, { id });
  }

  // MARK: - Incomes & Reversals CRUD

  async recordIncome(input: {
    amount: number;
    projectName: string;
    credentialId?: number;
    currency?: string;
    tags?: string[];
    note?: string;
    notes?: string;
    date?: string;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    const state = await this.ctx.assertActionAllowed("sx", "create", "incomes");
    const pendingProjects = await this.listPendingCreatedProjects();
    const fallbackTz = await this.ctx.readAppTimeZone?.("sx");
    const { payload } = this.validateRecordPayload(
      input,
      "income",
      state.catalog_json,
      pendingProjects,
      fallbackTz
    );
    if (input.credentialId !== undefined) {
      await this.ctx.assertActionDomainAllowed?.("sx", "credentials");
      payload.credentialId = validateId(input.credentialId, "credentialId");
    }
    const requestId = input.requestId?.trim() || generateRequestId("sx-inc");
    payload.stableID = `sx:d1:${requestId}`;
    return this.ctx.enqueueInbox("sx", "record_income", requestId, input.client, payload);
  }

  async updateIncome(input: {
    id: number;
    amount?: number;
    projectName?: string;
    credentialId?: number;
    clearCredential?: boolean;
    currency?: string;
    tags?: string[];
    note?: string;
    notes?: string;
    date?: string;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    const state = await this.ctx.assertActionAllowed("sx", "update", "incomes");
    const id = validateId(input.id, "id");
    const payload: Record<string, unknown> = { id };
    const catalog = safeJsonParse<SxCatalog>(state.catalog_json);
    const timeZone = catalogTimeZone(catalog, await this.ctx.readAppTimeZone?.("sx"));

    if (input.credentialId !== undefined || input.clearCredential === true) {
      await this.ctx.assertActionDomainAllowed?.("sx", "credentials");
      if (input.credentialId !== undefined) {
        payload.credentialId = validateId(input.credentialId, "credentialId");
      }
      if (input.clearCredential === true) {
        payload.clearCredential = true;
      }
    }
    if (input.amount !== undefined) {
      if (!Number.isFinite(input.amount) || input.amount <= 0) throw new Error("SX 'amount' must be > 0.");
      payload.amount = Math.round(input.amount * 100) / 100;
    }
    if (input.projectName !== undefined) payload.projectName = requireNonEmptyString(input.projectName, "projectName");
    if (input.currency !== undefined) {
      const normalized = normalizeCurrencyCode(input.currency, catalog);
      if (normalized) payload.currency = normalized;
    }
    const tags = normalizeTagsArray(input.tags);
    if (tags !== undefined) payload.tags = tags;
    const resolvedNote = input.note !== undefined ? input.note : input.notes;
    if (resolvedNote !== undefined) payload.note = resolvedNote.trim();
    const isoDate = resolveSxTimestamp(input.date, "date", { timeZone, defaultLocalHour: 0 });
    if (isoDate) payload.date = isoDate;
    if (Object.keys(payload).length === 1) throw new Error("update_income requires at least one field to update.");

    const requestId = input.requestId?.trim() || generateRequestId("sx-inc-upd");
    return this.ctx.enqueueInbox("sx", "update_income", requestId, input.client, payload);
  }

  async deleteIncome(input: { id: number; requestId?: string; client?: string }): Promise<Record<string, unknown>> {
    await this.ctx.assertActionAllowed("sx", "delete", "incomes");
    const id = validateId(input.id, "id");
    const requestId = input.requestId?.trim() || generateRequestId("sx-inc-del");
    return this.ctx.enqueueInbox("sx", "delete_income", requestId, input.client, { id });
  }

  async recordIncomeReversal(input: {
    incomeId: number;
    amount: number;
    note?: string;
    notes?: string;
    date?: string;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    const state = await this.ctx.assertActionAllowed("sx", "create", "incomes");
    const catalog = safeJsonParse<SxCatalog>(state.catalog_json);
    const timeZone = catalogTimeZone(catalog, await this.ctx.readAppTimeZone?.("sx"));
    const incomeId = validateId(input.incomeId, "incomeId");
    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      throw new Error("Income reversal 'amount' must be > 0.");
    }
    const payload: Record<string, unknown> = {
      incomeId,
      amount: Math.round(input.amount * 100) / 100
    };
    const mergedNote = input.note ?? input.notes;
    if (mergedNote?.trim()) payload.note = mergedNote.trim();
    const isoDate = resolveSxTimestamp(input.date, "date", { timeZone, defaultLocalHour: 0 });
    if (isoDate) payload.date = isoDate;

    const requestId = input.requestId?.trim() || generateRequestId("sx-rev");
    return this.ctx.enqueueInbox("sx", "record_income_reversal", requestId, input.client, payload);
  }

  async updateIncomeReversal(input: {
    id: number;
    amount?: number;
    note?: string;
    notes?: string;
    date?: string;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    const state = await this.ctx.assertActionAllowed("sx", "update", "incomes");
    const catalog = safeJsonParse<SxCatalog>(state.catalog_json);
    const timeZone = catalogTimeZone(catalog, await this.ctx.readAppTimeZone?.("sx"));
    const id = validateId(input.id, "id");
    const payload: Record<string, unknown> = { id };
    if (input.amount !== undefined) {
      if (!Number.isFinite(input.amount) || input.amount <= 0) throw new Error("Income reversal 'amount' must be > 0.");
      payload.amount = Math.round(input.amount * 100) / 100;
    }
    const resolvedNote = input.note !== undefined ? input.note : input.notes;
    if (resolvedNote !== undefined) payload.note = resolvedNote.trim();
    const isoDate = resolveSxTimestamp(input.date, "date", { timeZone, defaultLocalHour: 0 });
    if (isoDate) payload.date = isoDate;
    if (Object.keys(payload).length === 1) throw new Error("update_income_reversal requires at least one field to update.");
    const requestId = input.requestId?.trim() || generateRequestId("sx-rev-upd");
    return this.ctx.enqueueInbox("sx", "update_income_reversal", requestId, input.client, payload);
  }

  async deleteIncomeReversal(input: { id: number; requestId?: string; client?: string }): Promise<Record<string, unknown>> {
    await this.ctx.assertActionAllowed("sx", "delete", "incomes");
    const id = validateId(input.id, "id");
    const requestId = input.requestId?.trim() || generateRequestId("sx-rev-del");
    return this.ctx.enqueueInbox("sx", "delete_income_reversal", requestId, input.client, { id });
  }

  // MARK: - Projects CRUD

  async createProject(input: {
    name: string;
    price?: number;
    currency?: string;
    cycle?: string;
    priceType?: string;
    projectType?: string;
    cashFlowSides?: string;
    startDate?: string;
    endDate?: string;
    isAutoRenew?: boolean;
    notes?: string;
    note?: string;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    const state = await this.ctx.assertActionAllowed("sx", "create", "projects");
    const name = requireNonEmptyString(input.name, "name");
    const catalog = safeJsonParse<SxCatalog>(state.catalog_json);
    const timeZone = catalogTimeZone(catalog, await this.ctx.readAppTimeZone?.("sx"));
    const currency = normalizeCurrencyCode(input.currency, catalog);

    if (input.cycle && !VALID_CYCLES.has(input.cycle)) throw new Error(`Invalid cycle '${input.cycle}'.`);
    if (input.priceType && !VALID_PRICE_TYPES.has(input.priceType)) throw new Error(`Invalid priceType '${input.priceType}'.`);
    if (input.projectType && !VALID_PROJECT_TYPES.has(input.projectType)) {
      throw new Error(`Invalid projectType '${input.projectType}'.`);
    }
    if (input.cashFlowSides && !VALID_CASH_FLOW_PRESETS.has(input.cashFlowSides)) {
      throw new Error(`Invalid cashFlowSides '${input.cashFlowSides}'.`);
    }
    if (input.price !== undefined && (!Number.isFinite(input.price) || input.price < 0)) {
      throw new Error("Project 'price' must be >= 0.");
    }

    const payload: Record<string, unknown> = { name };
    if (input.price !== undefined) payload.price = Math.round(input.price * 100) / 100;
    if (currency) payload.currency = currency;
    if (input.cycle) payload.cycle = input.cycle;
    if (input.priceType) payload.priceType = input.priceType;
    if (input.projectType) payload.projectType = input.projectType;
    if (input.cashFlowSides) payload.cashFlowSides = input.cashFlowSides;
    const start = resolveSxTimestamp(input.startDate, "startDate", { timeZone, defaultLocalHour: 0 });
    if (start) payload.startDate = start;
    const end = resolveSxTimestamp(input.endDate, "endDate", { timeZone, defaultLocalHour: 0 });
    if (end) payload.endDate = end;
    if (input.isAutoRenew !== undefined) payload.isAutoRenew = input.isAutoRenew;
    const mergedNotes = input.notes ?? input.note;
    if (mergedNotes?.trim()) payload.notes = mergedNotes.trim();

    const requestId = input.requestId?.trim() || generateRequestId("sx-proj");
    return this.ctx.enqueueInbox("sx", "create_project", requestId, input.client, payload);
  }

  async updateProject(input: {
    id: number;
    name?: string;
    price?: number;
    currency?: string;
    cycle?: string;
    priceType?: string;
    projectType?: string;
    cashFlowSides?: string;
    notes?: string;
    note?: string;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    const state = await this.ctx.assertActionAllowed("sx", "update", "projects");
    const id = validateId(input.id, "id");
    const payload: Record<string, unknown> = { id };
    const catalog = safeJsonParse<SxCatalog>(state.catalog_json);

    if (input.name !== undefined) payload.name = requireNonEmptyString(input.name, "name");
    if (input.price !== undefined) {
      if (!Number.isFinite(input.price) || input.price < 0) throw new Error("Project 'price' must be >= 0.");
      payload.price = Math.round(input.price * 100) / 100;
    }
    if (input.currency !== undefined) {
      const currency = normalizeCurrencyCode(input.currency, catalog);
      if (currency) payload.currency = currency;
    }
    if (input.cycle !== undefined) {
      if (!VALID_CYCLES.has(input.cycle)) throw new Error(`Invalid cycle '${input.cycle}'.`);
      payload.cycle = input.cycle;
    }
    if (input.priceType !== undefined) {
      if (!VALID_PRICE_TYPES.has(input.priceType)) throw new Error(`Invalid priceType '${input.priceType}'.`);
      payload.priceType = input.priceType;
    }
    if (input.projectType !== undefined) {
      if (!VALID_PROJECT_TYPES.has(input.projectType)) throw new Error(`Invalid projectType '${input.projectType}'.`);
      payload.projectType = input.projectType;
    }
    if (input.cashFlowSides !== undefined) {
      if (!VALID_CASH_FLOW_PRESETS.has(input.cashFlowSides)) {
        throw new Error(`Invalid cashFlowSides '${input.cashFlowSides}'.`);
      }
      payload.cashFlowSides = input.cashFlowSides;
    }
    const resolvedNotes = input.notes !== undefined ? input.notes : input.note;
    if (resolvedNotes !== undefined) payload.notes = resolvedNotes.trim();
    if (Object.keys(payload).length === 1) throw new Error("update_project requires at least one field to update.");

    const requestId = input.requestId?.trim() || generateRequestId("sx-proj-upd");
    return this.ctx.enqueueInbox("sx", "update_project", requestId, input.client, payload);
  }

  async deleteProject(input: { id: number; requestId?: string; client?: string }): Promise<Record<string, unknown>> {
    await this.ctx.assertActionAllowed("sx", "delete", "projects");
    const id = validateId(input.id, "id");
    const projects = await this.ctx.readDataset<SxProjectRecord>("sx", "projects");
    const existing = projects?.find((p) => p.id === id);
    if (existing && !existing.deletable) {
      throw new Error(
        `Project '${existing.name}' cannot be deleted because it has ${existing.expenseCount} expense(s), ${existing.incomeCount} income record(s), and ${existing.credentialLinkCount} credential link(s).`
      );
    }
    const requestId = input.requestId?.trim() || generateRequestId("sx-proj-del");
    return this.ctx.enqueueInbox("sx", "delete_project", requestId, input.client, { id });
  }

  // MARK: - Tags CRUD

  async createTag(input: { name: string; requestId?: string; client?: string }): Promise<Record<string, unknown>> {
    await this.ctx.assertActionAllowed("sx", "create", "tags");
    const name = requireNonEmptyString(input.name, "name");
    const requestId = input.requestId?.trim() || generateRequestId("sx-tag");
    return this.ctx.enqueueInbox("sx", "create_tag", requestId, input.client, { name });
  }

  async renameTag(input: { id: number; name: string; requestId?: string; client?: string }): Promise<Record<string, unknown>> {
    await this.ctx.assertActionAllowed("sx", "update", "tags");
    const id = validateId(input.id, "id");
    const name = requireNonEmptyString(input.name, "name");
    const requestId = input.requestId?.trim() || generateRequestId("sx-tag-ren");
    return this.ctx.enqueueInbox("sx", "rename_tag", requestId, input.client, { id, name });
  }

  async deleteTag(input: { id: number; requestId?: string; client?: string }): Promise<Record<string, unknown>> {
    await this.ctx.assertActionAllowed("sx", "delete", "tags");
    const id = validateId(input.id, "id");
    const requestId = input.requestId?.trim() || generateRequestId("sx-tag-del");
    return this.ctx.enqueueInbox("sx", "delete_tag", requestId, input.client, { id });
  }

  // MARK: - Slogans CRUD

  async createSlogan(input: {
    text: string;
    language?: string;
    emoji?: string;
    ruleType?: string;
    ruleValue?: string;
    priority?: number;
    isEnabled?: boolean;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    await this.ctx.assertActionAllowed("sx", "create", "slogans");
    const text = requireNonEmptyString(input.text, "text");
    const payload: Record<string, unknown> = {
      text,
      language: input.language?.trim() || "zh-Hans",
      ruleType: input.ruleType?.trim() || "always",
      ruleValue: input.ruleValue?.trim() ?? "",
      priority: Number.isInteger(input.priority) ? input.priority : 0,
      isEnabled: input.isEnabled ?? true
    };
    if (input.emoji?.trim()) payload.emoji = input.emoji.trim();
    const requestId = input.requestId?.trim() || generateRequestId("sx-slo");
    return this.ctx.enqueueInbox("sx", "create_slogan", requestId, input.client, payload);
  }

  async updateSlogan(input: {
    id: number;
    text?: string;
    language?: string;
    emoji?: string | null;
    ruleType?: string;
    ruleValue?: string;
    priority?: number;
    isEnabled?: boolean;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    await this.ctx.assertActionAllowed("sx", "update", "slogans");
    const id = validateId(input.id, "id");
    const payload: Record<string, unknown> = { id };
    if (input.text !== undefined) payload.text = requireNonEmptyString(input.text, "text");
    if (input.language !== undefined) payload.language = requireNonEmptyString(input.language, "language");
    if (input.emoji !== undefined) payload.emoji = input.emoji === null ? "" : input.emoji.trim();
    if (input.ruleType !== undefined) payload.ruleType = requireNonEmptyString(input.ruleType, "ruleType");
    if (input.ruleValue !== undefined) payload.ruleValue = input.ruleValue.trim();
    if (input.priority !== undefined) {
      if (!Number.isInteger(input.priority)) throw new Error("Slogan 'priority' must be an integer.");
      payload.priority = input.priority;
    }
    if (input.isEnabled !== undefined) payload.isEnabled = Boolean(input.isEnabled);
    if (Object.keys(payload).length === 1) throw new Error("update_slogan requires at least one field to update.");

    const requestId = input.requestId?.trim() || generateRequestId("sx-slo-upd");
    return this.ctx.enqueueInbox("sx", "update_slogan", requestId, input.client, payload);
  }

  async deleteSlogan(input: { id: number; requestId?: string; client?: string }): Promise<Record<string, unknown>> {
    await this.ctx.assertActionAllowed("sx", "delete", "slogans");
    const id = validateId(input.id, "id");
    const requestId = input.requestId?.trim() || generateRequestId("sx-slo-del");
    return this.ctx.enqueueInbox("sx", "delete_slogan", requestId, input.client, { id });
  }

  // MARK: - Credentials & Project Links (Non-Secret Metadata Only)

  async listCredentials(options: {
    query?: string;
    type?: string;
    projectId?: number;
    limit?: number;
    offset?: number;
  } = {}): Promise<Record<string, unknown>> {
    await this.ctx.assertDomainReadAllowed("sx", "credentials");
    const dataset = await this.ctx.readDataset<SxCredentialRecord>("sx", "credentials");
    const items: SxCredentialRecord[] = dataset
      ? dataset.map((cred) => ({ ...cred, links: cred.links?.map((link) => ({ ...link })) ?? [] }))
      : [];
    const byId = new Map(items.map((cred) => [cred.id, cred]));

    const pending = await this.ctx.listPendingEnvelopes("sx");
    for (const env of pending) {
      if (env.op === "create_credential") {
        const linkedProjId = typeof env.payload.projectId === "number" ? env.payload.projectId : null;
        const linkedProjName =
          typeof env.payload.projectName === "string" && env.payload.projectName.trim()
            ? env.payload.projectName.trim()
            : null;
        const hasLink = linkedProjId !== null || linkedProjName !== null;
        const links = hasLink
          ? [
              {
                projectId: linkedProjId ?? -1,
                projectName: linkedProjName ?? "",
                startDate: typeof env.payload.startDate === "string" ? env.payload.startDate : env.createdAt,
                hasStartDate: Boolean(
                  env.payload.hasStartDate ??
                    (env.payload.startDate !== undefined || env.payload.isAutoRenew === true)
                ),
                endDate: typeof env.payload.endDate === "string" ? env.payload.endDate : null,
                isAutoRenew: Boolean(env.payload.isAutoRenew),
                nextRenewalDate:
                  typeof env.payload.nextRenewalDate === "string" ? env.payload.nextRenewalDate : null,
                renewalHour: typeof env.payload.renewalHour === "number" ? env.payload.renewalHour : 0,
                renewalWeekdays: typeof env.payload.renewalWeekdays === "number" ? env.payload.renewalWeekdays : 127
              }
            ]
          : [];
        items.unshift({
          id: -1,
          username: String(env.payload.username ?? ""),
          type: String(env.payload.type ?? ""),
          website: String(env.payload.website ?? ""),
          issuer: String(env.payload.issuer ?? ""),
          linkCount: hasLink ? 1 : 0,
          links,
          pendingStatus: "queued_create",
          pendingRequestId: env.requestId
        });
      } else if (env.op === "update_credential") {
        const target = byId.get(Number(env.payload.id));
        if (target) {
          if (typeof env.payload.username === "string") target.username = env.payload.username;
          if (typeof env.payload.type === "string") target.type = env.payload.type;
          if (typeof env.payload.website === "string") target.website = env.payload.website;
          if (typeof env.payload.issuer === "string") target.issuer = env.payload.issuer;
          target.pendingStatus = "queued_update";
          target.pendingRequestId = env.requestId;
        }
      } else if (env.op === "delete_credential") {
        const target = byId.get(Number(env.payload.id));
        if (target) {
          target.pendingStatus = "queued_delete";
          target.pendingRequestId = env.requestId;
        }
      }
    }

    let filtered = items;
    if (options.type?.trim()) {
      const targetType = options.type.trim().toLowerCase();
      filtered = filtered.filter((c) => c.type.toLowerCase() === targetType);
    }
    if (typeof options.projectId === "number") {
      filtered = filtered.filter((c) => c.links.some((link) => link.projectId === options.projectId));
    }
    if (options.query?.trim()) {
      filtered = filtered.filter((c) => matchesQuery(options.query, [c.username, c.website, c.type, c.issuer]));
    }
    const { limit, offset } = normalizePagination(options);
    return {
      datasetUploaded: dataset !== null,
      secretsRedacted: true,
      ...paginate(filtered, limit, offset)
    };
  }

  private buildCredentialLinkSchedulePayload(
    input: {
      startDate?: string;
      hasStartDate?: boolean;
      endDate?: string;
      clearEndDate?: boolean;
      isAutoRenew?: boolean;
      nextRenewalDate?: string;
      clearNextRenewalDate?: boolean;
      renewalHour?: number;
      renewalWeekdays?: number;
    },
    timeZone?: string
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const start = resolveSxTimestamp(input.startDate, "startDate", { timeZone, defaultLocalHour: 0 });
    if (start) out.startDate = start;
    if (input.hasStartDate !== undefined) out.hasStartDate = Boolean(input.hasStartDate);
    if (input.clearEndDate) {
      out.clearEndDate = true;
    } else {
      const end = resolveSxTimestamp(input.endDate, "endDate", { timeZone, defaultLocalHour: 0 });
      if (end) out.endDate = end;
    }
    if (input.isAutoRenew !== undefined) out.isAutoRenew = Boolean(input.isAutoRenew);
    if (input.clearNextRenewalDate) {
      out.clearNextRenewalDate = true;
    } else {
      const next = resolveSxTimestamp(input.nextRenewalDate, "nextRenewalDate", { timeZone, defaultLocalHour: 0 });
      if (next) out.nextRenewalDate = next;
    }
    if (input.renewalHour !== undefined) {
      if (!Number.isInteger(input.renewalHour) || input.renewalHour < 0 || input.renewalHour > 23) {
        throw new Error("'renewalHour' must be an integer between 0 and 23.");
      }
      out.renewalHour = input.renewalHour;
    }
    if (input.renewalWeekdays !== undefined) {
      if (!Number.isInteger(input.renewalWeekdays) || input.renewalWeekdays < 1 || input.renewalWeekdays > 127) {
        throw new Error("'renewalWeekdays' must be a bitmask integer between 1 and 127.");
      }
      out.renewalWeekdays = input.renewalWeekdays;
    }
    return out;
  }

  async createCredential(input: {
    username: string;
    website?: string;
    type?: string;
    issuer?: string;
    projectId?: number;
    projectName?: string;
    isAutoRenew?: boolean;
    startDate?: string;
    hasStartDate?: boolean;
    endDate?: string;
    nextRenewalDate?: string;
    renewalHour?: number;
    renewalWeekdays?: number;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    const state = await this.ctx.assertActionAllowed("sx", "create", "credentials");
    const username = requireNonEmptyString(input.username, "username");
    const rawProjectName = input.projectName?.trim();
    if (input.projectId !== undefined && rawProjectName) {
      throw new Error("Provide either 'projectId' or 'projectName', not both.");
    }
    const catalog = safeJsonParse<SxCatalog>(state.catalog_json);
    const timeZone = catalogTimeZone(catalog, await this.ctx.readAppTimeZone?.("sx"));
    const payload: Record<string, unknown> = { username };
    if (input.website !== undefined) payload.website = input.website.trim();
    if (input.type !== undefined) payload.type = input.type.trim();
    if (input.issuer !== undefined) payload.issuer = input.issuer.trim();
    if (input.projectId !== undefined) {
      payload.projectId = validateId(input.projectId, "projectId");
    } else if (rawProjectName) {
      const pendingProjects = await this.listPendingCreatedProjects();
      const catalogMatch = catalog?.projects?.find(
        (proj) => proj.name.trim().toLowerCase() === rawProjectName.toLowerCase()
      );
      const pendingMatch = pendingProjects.find((proj) => proj.name.toLowerCase() === rawProjectName.toLowerCase());
      if (catalogMatch) {
        payload.projectName = catalogMatch.name;
      } else if (pendingMatch) {
        payload.projectName = pendingMatch.name;
      } else if (catalog?.projects?.length) {
        const names = [
          ...catalog.projects.map((proj) => proj.name),
          ...pendingProjects.map((proj) => proj.name)
        ].join(", ");
        throw new Error(`Unknown projectName '${rawProjectName}'. Known projects: ${names}`);
      } else {
        payload.projectName = rawProjectName;
      }
    }
    Object.assign(payload, this.buildCredentialLinkSchedulePayload(input, timeZone));
    const requestId = input.requestId?.trim() || generateRequestId("sx-cred");
    return this.ctx.enqueueInbox("sx", "create_credential", requestId, input.client, payload);
  }

  async updateCredential(input: {
    id: number;
    username?: string;
    website?: string;
    type?: string;
    issuer?: string;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    await this.ctx.assertActionAllowed("sx", "update", "credentials");
    const id = validateId(input.id, "id");
    const payload: Record<string, unknown> = { id };
    if (input.username !== undefined) payload.username = requireNonEmptyString(input.username, "username");
    if (input.website !== undefined) payload.website = input.website.trim();
    if (input.type !== undefined) payload.type = input.type.trim();
    if (input.issuer !== undefined) payload.issuer = input.issuer.trim();
    if (Object.keys(payload).length === 1) {
      throw new Error("update_credential requires at least one of username, website, type, or issuer.");
    }
    const requestId = input.requestId?.trim() || generateRequestId("sx-cred-upd");
    return this.ctx.enqueueInbox("sx", "update_credential", requestId, input.client, payload);
  }

  async deleteCredential(input: { id: number; requestId?: string; client?: string }): Promise<Record<string, unknown>> {
    await this.ctx.assertActionAllowed("sx", "delete", "credentials");
    const id = validateId(input.id, "id");
    const requestId = input.requestId?.trim() || generateRequestId("sx-cred-del");
    return this.ctx.enqueueInbox("sx", "delete_credential", requestId, input.client, { id });
  }

  async linkCredential(input: {
    credentialId: number;
    projectId: number;
    isAutoRenew?: boolean;
    startDate?: string;
    hasStartDate?: boolean;
    endDate?: string;
    nextRenewalDate?: string;
    renewalHour?: number;
    renewalWeekdays?: number;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    const state = await this.ctx.assertActionAllowed("sx", "create", "credentials");
    const catalog = safeJsonParse<SxCatalog>(state.catalog_json);
    const timeZone = catalogTimeZone(catalog, await this.ctx.readAppTimeZone?.("sx"));
    const credentialId = validateId(input.credentialId, "credentialId");
    const projectId = validateId(input.projectId, "projectId");
    const payload: Record<string, unknown> = {
      credentialId,
      projectId,
      ...this.buildCredentialLinkSchedulePayload(input, timeZone)
    };
    const requestId = input.requestId?.trim() || generateRequestId("sx-cred-lnk");
    return this.ctx.enqueueInbox("sx", "link_credential", requestId, input.client, payload);
  }

  async updateCredentialLink(input: {
    credentialId: number;
    projectId: number;
    isAutoRenew?: boolean;
    startDate?: string;
    hasStartDate?: boolean;
    endDate?: string;
    clearEndDate?: boolean;
    nextRenewalDate?: string;
    clearNextRenewalDate?: boolean;
    renewalHour?: number;
    renewalWeekdays?: number;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    const state = await this.ctx.assertActionAllowed("sx", "update", "credentials");
    const catalog = safeJsonParse<SxCatalog>(state.catalog_json);
    const timeZone = catalogTimeZone(catalog, await this.ctx.readAppTimeZone?.("sx"));
    const credentialId = validateId(input.credentialId, "credentialId");
    const projectId = validateId(input.projectId, "projectId");
    const scheduleFields = this.buildCredentialLinkSchedulePayload(input, timeZone);
    if (Object.keys(scheduleFields).length === 0) {
      throw new Error("update_credential_link requires at least one date or renewal setting to update.");
    }
    const payload: Record<string, unknown> = { credentialId, projectId, ...scheduleFields };
    const requestId = input.requestId?.trim() || generateRequestId("sx-cred-lnk-upd");
    return this.ctx.enqueueInbox("sx", "update_credential_link", requestId, input.client, payload);
  }

  async unlinkCredential(input: {
    credentialId: number;
    projectId: number;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    await this.ctx.assertActionAllowed("sx", "delete", "credentials");
    const credentialId = validateId(input.credentialId, "credentialId");
    const projectId = validateId(input.projectId, "projectId");
    const requestId = input.requestId?.trim() || generateRequestId("sx-cred-unlnk");
    return this.ctx.enqueueInbox("sx", "unlink_credential", requestId, input.client, { credentialId, projectId });
  }
}
