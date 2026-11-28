import {
  AppStateRow,
  generateRequestId,
  localDateHourParts,
  localDateKey,
  matchesDateRange,
  matchesQuery,
  normalizePagination,
  paginate,
  parsePolicyFromRow,
  rankFuzzyMatches,
  requireNonEmptyString,
  resolveSxTimestamp,
  safeJsonParse,
  validateLocalHour
} from "./store-helpers.js";
import { BxStoreContext } from "./store-bx.js";
import {
  InboxEnvelope,
  SxCatalog,
  SxCredentialRecord,
  SxExpenseRecord,
  SxIncomeRecord,
  SxProjectRecord,
  SxSloganRecord,
  SxTagRecord
} from "./types.js";

export interface SxCredentialCandidate {
  id: number;
  username: string;
  type: string;
  website: string;
  issuer: string;
}

type SxCredentialResolution =
  | {
      status: "explicit" | "auto_bound";
      credentialId: number;
      boundCredential?: SxCredentialCandidate;
    }
  | {
      status: "explicit_none" | "none" | "credentials_scope_disabled";
      credentialId: null;
    }
  | {
      status: "selection_required";
      credentialId: null;
      candidates: SxCredentialCandidate[];
    };

const VALID_CYCLES = new Set(["daily", "weekly", "monthly", "quarterly", "yearly", "irregular"]);
const VALID_PRICE_TYPES = new Set(["fixed", "floating"]);
const VALID_PROJECT_TYPES = new Set(["nonRenewal", "autoRenew", "pausedRenew", "expired"]);
const VALID_CASH_FLOW_PRESETS = new Set(["expenseOnly", "incomeOnly", "both"]);

type SloganLanguage = "zh" | "en";
type SloganRuleType = "default" | "time_of_day" | "solar_term" | "date_specific" | "holiday";

const VALID_SLOGAN_RULE_TYPES = new Set<SloganRuleType>([
  "default",
  "time_of_day",
  "solar_term",
  "date_specific",
  "holiday"
]);

function tryNormalizeSloganLanguage(raw: string): SloganLanguage | null {
  const trimmed = raw.trim().toLowerCase().replace(/_/g, "-");
  if (!trimmed) return null;
  if (
    trimmed === "zh" ||
    trimmed === "zh-hans" ||
    trimmed === "zh-cn" ||
    /^zh-hans-[a-z0-9]+$/.test(trimmed)
  ) {
    return "zh";
  }
  if (trimmed === "en" || /^en-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmed)) {
    return "en";
  }
  return null;
}

function normalizeSloganLanguage(raw: string): SloganLanguage {
  const normalized = tryNormalizeSloganLanguage(raw);
  if (normalized) return normalized;
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Slogan 'language' cannot be empty. Supported values: 'zh' or 'en'.");
  }
  throw new Error(
    `Unsupported slogan language '${trimmed}'. Supported values: 'zh' (or 'zh-Hans'/'zh-CN') and 'en'.`
  );
}

function canonicalSloganLanguageForDisplay(raw: string): string {
  return tryNormalizeSloganLanguage(raw) ?? raw.trim().toLowerCase();
}

function defaultSloganPriority(ruleType: SloganRuleType): number {
  switch (ruleType) {
    case "holiday":
    case "date_specific":
      return 1;
    case "solar_term":
      return 3;
    case "time_of_day":
      return 5;
    case "default":
      return 10;
  }
}

function daysInCalendarMonth(month: number, year: number | null): number {
  const effectiveYear = year ?? 2024;
  return new Date(Date.UTC(effectiveYear, month, 0)).getUTCDate();
}

function normalizeSloganRuleType(rawRuleType?: string): SloganRuleType {
  if (rawRuleType === undefined) return "default";
  const trimmed = rawRuleType.trim().toLowerCase();
  if (!trimmed) {
    throw new Error(
      "Slogan 'ruleType' cannot be empty. Valid values: default, time_of_day, solar_term, date_specific, holiday."
    );
  }
  const mapped = trimmed === "always" ? "default" : trimmed;
  if (!VALID_SLOGAN_RULE_TYPES.has(mapped as SloganRuleType)) {
    throw new Error(
      `Invalid slogan ruleType '${rawRuleType.trim()}'. Valid values: default, time_of_day, solar_term, date_specific, holiday.`
    );
  }
  return mapped as SloganRuleType;
}

function normalizeSloganRuleTypeLenient(rawRuleType: string): string {
  const trimmed = rawRuleType.trim().toLowerCase();
  if (!trimmed || trimmed === "always") return "default";
  return trimmed;
}

function parsePlainJsonObject(raw: string, errorMessage: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(errorMessage);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(errorMessage);
  }
  return parsed as Record<string, unknown>;
}

function requireIntInRange(value: unknown, fieldName: string, min: number, max: number, context: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${context} Field '${fieldName}' must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function normalizeSloganRule(
  rawRuleType?: string,
  rawRuleValue?: string
): { ruleType: SloganRuleType; ruleValue: string } {
  const ruleType = normalizeSloganRuleType(rawRuleType);
  const trimmedValue = rawRuleValue?.trim() ?? "";

  if (ruleType === "default") {
    if (!trimmedValue) {
      return { ruleType, ruleValue: "{}" };
    }
    const obj = parsePlainJsonObject(
      trimmedValue,
      "Slogan ruleType 'default' expects ruleValue '{}' (or omitted)."
    );
    if (Object.keys(obj).length > 0) {
      throw new Error("Slogan ruleType 'default' expects empty JSON object '{}' (or omitted).");
    }
    return { ruleType, ruleValue: "{}" };
  }

  if (ruleType === "time_of_day") {
    const example =
      "Slogan ruleType 'time_of_day' requires JSON ruleValue like '{\"start\":6,\"end\":11}' with integer 'start' and 'end' in 0..23 and start != end.";
    if (!trimmedValue) throw new Error(example);
    const obj = parsePlainJsonObject(trimmedValue, example);
    const start = requireIntInRange(obj.start, "start", 0, 23, example);
    const end = requireIntInRange(obj.end, "end", 0, 23, example);
    if (start === end) {
      throw new Error(`${example} Received start=${start} and end=${end}.`);
    }
    return { ruleType, ruleValue: JSON.stringify({ start, end }) };
  }

  if (ruleType === "solar_term") {
    const example =
      "Slogan ruleType 'solar_term' requires JSON ruleValue like '{\"term\":\"立春\"}' with a non-empty string 'term'.";
    if (!trimmedValue) throw new Error(example);
    const obj = parsePlainJsonObject(trimmedValue, example);
    if (typeof obj.term !== "string" || !obj.term.trim()) {
      throw new Error(example);
    }
    return { ruleType, ruleValue: JSON.stringify({ term: obj.term.trim() }) };
  }

  if (ruleType === "date_specific") {
    const example =
      "Slogan ruleType 'date_specific' requires JSON ruleValue like '{\"month\":1,\"day\":1}' (optional 'endMonth'/'endDay') or 'MM-DD' shorthand.";
    if (!trimmedValue) throw new Error(example);
    const shorthand = /^(\d{1,2})-(\d{1,2})$/.exec(trimmedValue);
    if (shorthand) {
      const month = requireIntInRange(Number(shorthand[1]), "month", 1, 12, example);
      const maxDay = daysInCalendarMonth(month, null);
      const day = requireIntInRange(Number(shorthand[2]), "day", 1, maxDay, example);
      return { ruleType, ruleValue: JSON.stringify({ month, day }) };
    }
    const obj = parsePlainJsonObject(trimmedValue, example);
    const month = requireIntInRange(obj.month, "month", 1, 12, example);
    const maxDay = daysInCalendarMonth(month, null);
    const day = requireIntInRange(obj.day, "day", 1, maxDay, example);
    const hasEndMonth = obj.endMonth !== undefined && obj.endMonth !== null;
    const hasEndDay = obj.endDay !== undefined && obj.endDay !== null;
    if (hasEndMonth || hasEndDay) {
      if (!hasEndMonth || !hasEndDay) {
        throw new Error(`${example} Provide both 'endMonth' and 'endDay' together when specifying a date range.`);
      }
      const endMonth = requireIntInRange(obj.endMonth, "endMonth", 1, 12, example);
      const maxEndDay = daysInCalendarMonth(endMonth, null);
      const endDay = requireIntInRange(obj.endDay, "endDay", 1, maxEndDay, example);
      return { ruleType, ruleValue: JSON.stringify({ month, day, endMonth, endDay }) };
    }
    return { ruleType, ruleValue: JSON.stringify({ month, day }) };
  }

  const example =
    "Slogan ruleType 'holiday' requires JSON ruleValue like '{\"year\":2026,\"month\":2,\"day\":17}' (optional 'endMonth'/'endDay') or 'YYYY-MM-DD' shorthand.";
  if (!trimmedValue) throw new Error(example);
  const shorthand = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmedValue);
  if (shorthand) {
    const year = requireIntInRange(Number(shorthand[1]), "year", 1900, 9999, example);
    const month = requireIntInRange(Number(shorthand[2]), "month", 1, 12, example);
    const maxDay = daysInCalendarMonth(month, year);
    const day = requireIntInRange(Number(shorthand[3]), "day", 1, maxDay, example);
    return { ruleType, ruleValue: JSON.stringify({ year, month, day }) };
  }
  const obj = parsePlainJsonObject(trimmedValue, example);
  const year = requireIntInRange(obj.year, "year", 1900, 9999, example);
  const month = requireIntInRange(obj.month, "month", 1, 12, example);
  const maxDay = daysInCalendarMonth(month, year);
  const day = requireIntInRange(obj.day, "day", 1, maxDay, example);
  const hasEndMonth = obj.endMonth !== undefined && obj.endMonth !== null;
  const hasEndDay = obj.endDay !== undefined && obj.endDay !== null;
  if (hasEndMonth || hasEndDay) {
    if (!hasEndMonth || !hasEndDay) {
      throw new Error(`${example} Provide both 'endMonth' and 'endDay' together when specifying a date range.`);
    }
    const endMonth = requireIntInRange(obj.endMonth, "endMonth", 1, 12, example);
    const wrapsYear = endMonth < month || (endMonth === month && Number(obj.endDay) < day);
    const maxEndDay = daysInCalendarMonth(endMonth, wrapsYear ? year + 1 : year);
    const endDay = requireIntInRange(obj.endDay, "endDay", 1, maxEndDay, example);
    return { ruleType, ruleValue: JSON.stringify({ year, month, day, endMonth, endDay }) };
  }
  return { ruleType, ruleValue: JSON.stringify({ year, month, day }) };
}

function normalizeStandaloneSloganRuleValue(rawRuleValue: string): string {
  const trimmed = rawRuleValue.trim();
  if (!trimmed) return "{}";
  if (/^(\d{1,2})-(\d{1,2})$/.test(trimmed)) {
    return normalizeSloganRule("date_specific", trimmed).ruleValue;
  }
  if (/^(\d{4})-(\d{1,2})-(\d{1,2})$/.test(trimmed)) {
    return normalizeSloganRule("holiday", trimmed).ruleValue;
  }
  const obj = parsePlainJsonObject(
    trimmed,
    "Invalid slogan 'ruleValue'. Expected a JSON object matching the slogan's ruleType (or 'MM-DD' / 'YYYY-MM-DD' shorthand). Pass 'ruleType' together with 'ruleValue' for full validation."
  );
  return JSON.stringify(obj);
}

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
  if (!item.localDate) {
    item.localDate = parts.localDate;
  }
  if (item.localHour === undefined || item.localHour === null) {
    item.localHour = parts.localHour;
  }
  if (!item.displayDate) {
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

function resolveKnownProjectName(
  rawProject: string,
  mode: "expense" | "income",
  catalog: SxCatalog | null,
  pendingProjects: Array<{ name: string; cashFlowSides: string }> = []
): string {
  const match = catalog?.projects?.find((proj) => proj.name.trim().toLowerCase() === rawProject.toLowerCase());
  if (match) {
    if (mode === "expense" && match.supportsExpense === false) {
      throw new Error(`Project '${match.name}' does not support expense records.`);
    }
    if (mode === "income" && match.supportsIncome === false) {
      throw new Error(`Project '${match.name}' does not support income records.`);
    }
    return match.name;
  }

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
    return pendingMatch.name;
  }

  if (catalog?.projects?.length) {
    const eligibleNames = [
      ...catalog.projects
        .filter((proj) => (mode === "expense" ? proj.supportsExpense !== false : proj.supportsIncome === true))
        .map((proj) => proj.name),
      ...pendingProjects
        .filter((proj) =>
          mode === "expense"
            ? proj.cashFlowSides === "expenseOnly" || proj.cashFlowSides === "both"
            : proj.cashFlowSides === "incomeOnly" || proj.cashFlowSides === "both"
        )
        .map((proj) => proj.name)
    ];
    const suggestions = rankFuzzyMatches(rawProject, eligibleNames, 6);
    const listText = suggestions.length > 0 ? suggestions.join(", ") : catalog.projects.map((p) => p.name).join(", ");
    throw new Error(`Unknown projectName '${rawProject}'. Known projects (closest matches): ${listText}`);
  }

  return rawProject;
}

function computeCashFlowAggregates(
  items: Array<{
    projectName: string;
    amount: number;
    netAmount: number;
    refundTotal?: number;
    reversalTotal?: number;
    currency: string;
    tags: string[];
    pendingStatus?: string;
  }>,
  offsetKind: "refund" | "reversal"
): Record<string, unknown> {
  let pendingDeleteCount = 0;
  let recordCount = 0;
  const totalsByCurrency: Record<string, Record<string, number>> = {};
  const projectMap = new Map<string, { projectName: string; currency: string; net: number; count: number }>();
  const tagMap = new Map<string, { tag: string; currency: string; net: number; count: number }>();

  for (const item of items) {
    if (item.pendingStatus === "queued_delete") {
      pendingDeleteCount += 1;
      continue;
    }
    recordCount += 1;
    const currency = (item.currency || "UNKNOWN").toUpperCase();
    const gross = Number(item.amount ?? 0);
    const offsetAmt = Number((offsetKind === "refund" ? item.refundTotal : item.reversalTotal) ?? 0);
    const net = Number(item.netAmount ?? gross - offsetAmt);

    const curBucket = totalsByCurrency[currency] ?? { gross: 0, [offsetKind]: 0, net: 0, count: 0 };
    curBucket.gross = Math.round((curBucket.gross + gross) * 100) / 100;
    curBucket[offsetKind] = Math.round((curBucket[offsetKind] + offsetAmt) * 100) / 100;
    curBucket.net = Math.round((curBucket.net + net) * 100) / 100;
    curBucket.count += 1;
    totalsByCurrency[currency] = curBucket;

    const projKey = `${item.projectName}\0${currency}`;
    const projEntry = projectMap.get(projKey) ?? {
      projectName: item.projectName,
      currency,
      net: 0,
      count: 0
    };
    projEntry.net = Math.round((projEntry.net + net) * 100) / 100;
    projEntry.count += 1;
    projectMap.set(projKey, projEntry);

    for (const tag of item.tags ?? []) {
      const tagKey = `${tag}\0${currency}`;
      const tagEntry = tagMap.get(tagKey) ?? { tag, currency, net: 0, count: 0 };
      tagEntry.net = Math.round((tagEntry.net + net) * 100) / 100;
      tagEntry.count += 1;
      tagMap.set(tagKey, tagEntry);
    }
  }

  const byProject = Array.from(projectMap.values())
    .sort((a, b) => b.net - a.net || b.count - a.count)
    .slice(0, 10);
  const byTag = Array.from(tagMap.values())
    .sort((a, b) => b.net - a.net || b.count - a.count)
    .slice(0, 10);

  return {
    recordCount,
    pendingDeleteCount,
    totalsByCurrency,
    byProject,
    byTag
  };
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
    const [dataset, pending] = await Promise.all([
      this.ctx.readDataset<SxProjectRecord>("sx", "projects"),
      this.ctx.listPendingEnvelopes("sx")
    ]);
    const items: SxProjectRecord[] = dataset ? dataset.map((p) => ({ ...p })) : [];
    const byId = new Map(items.map((p) => [p.id, p]));

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
          isAutoRenew: typeof env.payload.isAutoRenew === "boolean" ? env.payload.isAutoRenew : env.payload.projectType === "autoRenew",
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
          if (typeof env.payload.cycle === "string") target.cycle = env.payload.cycle;
          if (typeof env.payload.priceType === "string") target.priceType = env.payload.priceType;
          if (typeof env.payload.projectType === "string") {
            target.projectType = env.payload.projectType;
            target.isAutoRenew = env.payload.projectType === "autoRenew";
          }
          if (typeof env.payload.cashFlowSides === "string") {
            target.cashFlowSides = env.payload.cashFlowSides;
            target.supportsExpense =
              env.payload.cashFlowSides === "expenseOnly" || env.payload.cashFlowSides === "both";
            target.supportsIncome =
              env.payload.cashFlowSides === "incomeOnly" || env.payload.cashFlowSides === "both";
          }
          if (typeof env.payload.notes === "string") target.notes = env.payload.notes;
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
    const access = this.ctx.assertReadAccess ? await this.ctx.assertReadAccess("sx") : null;
    const allowCredentials = Boolean(access?.policy?.allowedDomains.includes("credentials"));
    const [dataset, pending, timeZone, catalog] = await Promise.all([
      this.ctx.readDataset<SxExpenseRecord>("sx", "expenses"),
      this.ctx.listPendingEnvelopes("sx"),
      this.ctx.readAppTimeZone?.("sx") ?? Promise.resolve(undefined),
      this.ctx.readAppCatalog?.<SxCatalog>("sx") ?? Promise.resolve(null)
    ]);

    const projectCurrencyMap = new Map<string, string>();
    for (const proj of catalog?.projects ?? []) {
      if (proj.name && proj.currency) {
        projectCurrencyMap.set(proj.name.trim().toLowerCase(), proj.currency.trim().toUpperCase());
      }
    }

    const items: SxExpenseRecord[] = dataset
      ? dataset.map((item) => ({ ...item, refunds: item.refunds?.map((r) => ({ ...r })) }))
      : [];
    const byId = new Map(items.map((item) => [item.id, item]));
    const refundOwnerById = new Map<number, SxExpenseRecord>();
    for (const item of items) {
      for (const refund of item.refunds ?? []) {
        refundOwnerById.set(refund.id, item);
      }
    }

    const recomputeExpenseRefunds = (expense: SxExpenseRecord) => {
      const total = (expense.refunds ?? [])
        .filter((r) => r.pendingStatus !== "queued_delete")
        .reduce((sum, r) => sum + Number(r.amount ?? 0), 0);
      expense.refundTotal = Math.round(total * 100) / 100;
      expense.netAmount = Math.round((expense.amount - expense.refundTotal) * 100) / 100;
    };

    for (const env of pending) {
      if (env.op === "create_project") {
        if (typeof env.payload.name === "string" && typeof env.payload.currency === "string") {
          projectCurrencyMap.set(env.payload.name.trim().toLowerCase(), env.payload.currency.trim().toUpperCase());
        }
      } else if (env.op === "record_expense") {
        const amount = Number(env.payload.amount ?? 0);
        const projName = String(env.payload.projectName ?? "");
        const resolvedCurrency =
          (typeof env.payload.currency === "string" && env.payload.currency.trim()
            ? env.payload.currency.trim().toUpperCase()
            : projectCurrencyMap.get(projName.trim().toLowerCase()) ?? catalog?.summaryCurrency ?? "") || "";
        const created: SxExpenseRecord = {
          id: -1,
          projectId: -1,
          projectName: projName,
          credentialId: typeof env.payload.credentialId === "number" ? env.payload.credentialId : undefined,
          amount,
          netAmount: amount,
          refundTotal: 0,
          currency: resolvedCurrency,
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
          target.netAmount = Math.round((target.amount - target.refundTotal) * 100) / 100;
          target.pendingStatus = "queued_update";
          target.pendingRequestId = env.requestId;
        }
      } else if (env.op === "delete_expense") {
        const target = byId.get(Number(env.payload.id));
        if (target) {
          target.pendingStatus = "queued_delete";
          target.pendingRequestId = env.requestId;
        }
      } else if (env.op === "record_refund") {
        const parent = byId.get(Number(env.payload.paymentId));
        if (parent) {
          if (!parent.refunds) parent.refunds = [];
          parent.refunds.push({
            id: -1,
            paymentId: parent.id,
            amount: Number(env.payload.amount ?? 0),
            currency: parent.currency,
            notes: String(env.payload.note ?? env.payload.notes ?? ""),
            refundedAt: String(env.payload.date ?? env.createdAt),
            pendingStatus: "queued_create"
          });
          recomputeExpenseRefunds(parent);
        }
      } else if (env.op === "update_refund") {
        const refundId = Number(env.payload.id);
        const parent = refundOwnerById.get(refundId);
        const refund = parent?.refunds?.find((r) => r.id === refundId);
        if (parent && refund) {
          if (typeof env.payload.amount === "number") refund.amount = env.payload.amount;
          if (typeof env.payload.note === "string") refund.notes = env.payload.note;
          else if (typeof env.payload.notes === "string") refund.notes = env.payload.notes;
          if (typeof env.payload.date === "string") refund.refundedAt = env.payload.date;
          refund.pendingStatus = "queued_update";
          recomputeExpenseRefunds(parent);
        }
      } else if (env.op === "delete_refund") {
        const refundId = Number(env.payload.id);
        const parent = refundOwnerById.get(refundId);
        const refund = parent?.refunds?.find((r) => r.id === refundId);
        if (parent && refund) {
          refund.pendingStatus = "queued_delete";
          recomputeExpenseRefunds(parent);
        }
      }
    }

    for (const item of items) {
      if (!allowCredentials) {
        delete item.credentialId;
        delete item.credentialName;
      }
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

    const aggregates = computeCashFlowAggregates(filtered, "refund");

    const includeRefunds = options.includeRefunds !== false;
    if (!includeRefunds) {
      filtered = filtered.map(({ refunds: _r, ...rest }) => rest);
    }

    const { limit, offset } = normalizePagination(options);
    return {
      datasetUploaded: dataset !== null,
      timeZoneIdentifier: timeZone ?? null,
      aggregates,
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
    const access = this.ctx.assertReadAccess ? await this.ctx.assertReadAccess("sx") : null;
    const allowCredentials = Boolean(access?.policy?.allowedDomains.includes("credentials"));
    const [dataset, pending, timeZone, catalog] = await Promise.all([
      this.ctx.readDataset<SxIncomeRecord>("sx", "incomes"),
      this.ctx.listPendingEnvelopes("sx"),
      this.ctx.readAppTimeZone?.("sx") ?? Promise.resolve(undefined),
      this.ctx.readAppCatalog?.<SxCatalog>("sx") ?? Promise.resolve(null)
    ]);

    const projectCurrencyMap = new Map<string, string>();
    for (const proj of catalog?.projects ?? []) {
      if (proj.name && proj.currency) {
        projectCurrencyMap.set(proj.name.trim().toLowerCase(), proj.currency.trim().toUpperCase());
      }
    }

    const items: SxIncomeRecord[] = dataset
      ? dataset.map((item) => ({ ...item, reversals: item.reversals?.map((r) => ({ ...r })) }))
      : [];
    const byId = new Map(items.map((item) => [item.id, item]));
    const reversalOwnerById = new Map<number, SxIncomeRecord>();
    for (const item of items) {
      for (const rev of item.reversals ?? []) {
        reversalOwnerById.set(rev.id, item);
      }
    }

    const recomputeIncomeReversals = (income: SxIncomeRecord) => {
      const total = (income.reversals ?? [])
        .filter((r) => r.pendingStatus !== "queued_delete")
        .reduce((sum, r) => sum + Number(r.amount ?? 0), 0);
      income.reversalTotal = Math.round(total * 100) / 100;
      income.netAmount = Math.round((income.amount - income.reversalTotal) * 100) / 100;
    };

    for (const env of pending) {
      if (env.op === "create_project") {
        if (typeof env.payload.name === "string" && typeof env.payload.currency === "string") {
          projectCurrencyMap.set(env.payload.name.trim().toLowerCase(), env.payload.currency.trim().toUpperCase());
        }
      } else if (env.op === "record_income") {
        const amount = Number(env.payload.amount ?? 0);
        const projName = String(env.payload.projectName ?? "");
        const resolvedCurrency =
          (typeof env.payload.currency === "string" && env.payload.currency.trim()
            ? env.payload.currency.trim().toUpperCase()
            : projectCurrencyMap.get(projName.trim().toLowerCase()) ?? catalog?.summaryCurrency ?? "") || "";
        items.unshift({
          id: -1,
          projectId: -1,
          projectName: projName,
          credentialId: typeof env.payload.credentialId === "number" ? env.payload.credentialId : undefined,
          amount,
          netAmount: amount,
          reversalTotal: 0,
          currency: resolvedCurrency,
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
          target.netAmount = Math.round((target.amount - target.reversalTotal) * 100) / 100;
          target.pendingStatus = "queued_update";
          target.pendingRequestId = env.requestId;
        }
      } else if (env.op === "delete_income") {
        const target = byId.get(Number(env.payload.id));
        if (target) {
          target.pendingStatus = "queued_delete";
          target.pendingRequestId = env.requestId;
        }
      } else if (env.op === "record_income_reversal") {
        const parent = byId.get(Number(env.payload.incomeId));
        if (parent) {
          if (!parent.reversals) parent.reversals = [];
          parent.reversals.push({
            id: -1,
            incomeId: parent.id,
            amount: Number(env.payload.amount ?? 0),
            currency: parent.currency,
            notes: String(env.payload.note ?? env.payload.notes ?? ""),
            reversedAt: String(env.payload.date ?? env.createdAt),
            pendingStatus: "queued_create"
          });
          recomputeIncomeReversals(parent);
        }
      } else if (env.op === "update_income_reversal") {
        const revId = Number(env.payload.id);
        const parent = reversalOwnerById.get(revId);
        const rev = parent?.reversals?.find((r) => r.id === revId);
        if (parent && rev) {
          if (typeof env.payload.amount === "number") rev.amount = env.payload.amount;
          if (typeof env.payload.note === "string") rev.notes = env.payload.note;
          else if (typeof env.payload.notes === "string") rev.notes = env.payload.notes;
          if (typeof env.payload.date === "string") rev.reversedAt = env.payload.date;
          rev.pendingStatus = "queued_update";
          recomputeIncomeReversals(parent);
        }
      } else if (env.op === "delete_income_reversal") {
        const revId = Number(env.payload.id);
        const parent = reversalOwnerById.get(revId);
        const rev = parent?.reversals?.find((r) => r.id === revId);
        if (parent && rev) {
          rev.pendingStatus = "queued_delete";
          recomputeIncomeReversals(parent);
        }
      }
    }

    for (const item of items) {
      if (!allowCredentials) {
        delete item.credentialId;
        delete item.credentialName;
      }
      if (!item.localDate) {
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

    const aggregates = computeCashFlowAggregates(filtered, "reversal");

    if (options.includeReversals === false) {
      filtered = filtered.map(({ reversals: _r, ...rest }) => rest);
    }

    const { limit, offset } = normalizePagination(options);
    return {
      datasetUploaded: dataset !== null,
      timeZoneIdentifier: timeZone ?? null,
      aggregates,
      ...paginate(filtered, limit, offset)
    };
  }

  async listTags(options: { query?: string } = {}): Promise<Record<string, unknown>> {
    await this.ctx.assertDomainReadAllowed("sx", "tags");
    const [dataset, pending] = await Promise.all([
      this.ctx.readDataset<SxTagRecord>("sx", "tags"),
      this.ctx.listPendingEnvelopes("sx")
    ]);
    const items: SxTagRecord[] = dataset ? dataset.map((t) => ({ ...t })) : [];
    const byId = new Map(items.map((t) => [t.id, t]));

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
    const [dataset, pending] = await Promise.all([
      this.ctx.readDataset<SxSloganRecord>("sx", "slogans"),
      this.ctx.listPendingEnvelopes("sx")
    ]);
    const items: SxSloganRecord[] = dataset ? dataset.map((s) => ({ ...s })) : [];
    const byId = new Map(items.map((s) => [s.id, s]));

    const siblingsForPair = (pairId: string | null | undefined): SxSloganRecord[] => {
      const key = pairId?.trim();
      if (!key) return [];
      return items.filter((row) => row.pairId?.trim() === key);
    };

    for (const env of pending) {
      if (env.op === "create_slogan") {
        const language =
          typeof env.payload.language === "string"
            ? canonicalSloganLanguageForDisplay(env.payload.language)
            : "zh";
        const ruleType =
          typeof env.payload.ruleType === "string"
            ? normalizeSloganRuleTypeLenient(env.payload.ruleType)
            : "default";
        const ruleValue =
          typeof env.payload.ruleValue === "string" && env.payload.ruleValue.trim()
            ? env.payload.ruleValue.trim()
            : ruleType === "default"
              ? "{}"
              : "";
        const priority =
          typeof env.payload.priority === "number"
            ? env.payload.priority
            : VALID_SLOGAN_RULE_TYPES.has(ruleType as SloganRuleType)
              ? defaultSloganPriority(ruleType as SloganRuleType)
              : 10;
        const emoji =
          typeof env.payload.emoji === "string" && env.payload.emoji.trim() ? env.payload.emoji.trim() : null;
        const isEnabled = env.payload.isEnabled !== false;
        const textEn =
          typeof env.payload.textEn === "string" && env.payload.textEn.trim() ? env.payload.textEn.trim() : null;
        const rawPairId =
          typeof env.payload.pairId === "string" && env.payload.pairId.trim()
            ? env.payload.pairId.trim()
            : typeof env.payload.pairID === "string" && env.payload.pairID.trim()
              ? env.payload.pairID.trim()
              : null;
        const pairId = rawPairId ?? (textEn && language === "zh" ? `pending:${env.requestId}` : null);

        const primaryRow: SxSloganRecord = {
          id: -1,
          language,
          text: String(env.payload.text ?? ""),
          emoji,
          ruleType,
          ruleValue,
          priority,
          isEnabled,
          pairId,
          pendingStatus: "queued_create"
        };
        if (textEn && language === "zh") {
          const enRow: SxSloganRecord = {
            id: -1,
            language: "en",
            text: textEn,
            emoji,
            ruleType,
            ruleValue,
            priority,
            isEnabled,
            pairId,
            pendingStatus: "queued_create"
          };
          items.unshift(primaryRow, enRow);
        } else {
          items.unshift(primaryRow);
        }
      } else if (env.op === "update_slogan") {
        const target = byId.get(Number(env.payload.id));
        if (target) {
          const existingPairId = target.pairId?.trim() || null;
          const pairRows = existingPairId ? siblingsForPair(existingPairId) : [target];

          if (typeof env.payload.text === "string") target.text = env.payload.text;
          if (typeof env.payload.language === "string") {
            target.language = canonicalSloganLanguageForDisplay(env.payload.language);
          }

          const hasEmoji = env.payload.emoji === null || typeof env.payload.emoji === "string";
          const nextEmoji =
            env.payload.emoji === null
              ? null
              : typeof env.payload.emoji === "string"
                ? env.payload.emoji.trim() || null
                : undefined;
          const nextRuleType =
            typeof env.payload.ruleType === "string"
              ? normalizeSloganRuleTypeLenient(env.payload.ruleType)
              : undefined;
          const nextRuleValue =
            typeof env.payload.ruleValue === "string" ? env.payload.ruleValue : undefined;
          const nextPriority =
            typeof env.payload.priority === "number" ? env.payload.priority : undefined;
          const nextIsEnabled =
            typeof env.payload.isEnabled === "boolean" ? env.payload.isEnabled : undefined;

          const hasSharedUpdate =
            hasEmoji ||
            nextRuleType !== undefined ||
            nextRuleValue !== undefined ||
            nextPriority !== undefined ||
            nextIsEnabled !== undefined;

          for (const row of pairRows) {
            if (hasEmoji) row.emoji = nextEmoji ?? null;
            if (nextRuleType !== undefined) row.ruleType = nextRuleType;
            if (nextRuleValue !== undefined) row.ruleValue = nextRuleValue;
            if (nextPriority !== undefined) row.priority = nextPriority;
            if (nextIsEnabled !== undefined) row.isEnabled = nextIsEnabled;
            if (row === target || hasSharedUpdate) {
              row.pendingStatus = "queued_update";
            }
          }

          const applyLanguageCopy = (lang: SloganLanguage, copy: string) => {
            const matching = pairRows.find((row) => canonicalSloganLanguageForDisplay(row.language) === lang);
            if (matching) {
              matching.text = copy;
              matching.pendingStatus = "queued_update";
              return;
            }
            const effectivePairId = target.pairId?.trim() || `pending-pair:${env.requestId}`;
            if (!target.pairId?.trim()) {
              target.pairId = effectivePairId;
            }
            const counterpart: SxSloganRecord = {
              id: -1,
              language: lang,
              text: copy,
              emoji: target.emoji ?? null,
              ruleType: target.ruleType,
              ruleValue: target.ruleValue,
              priority: target.priority,
              isEnabled: target.isEnabled,
              pairId: effectivePairId,
              pendingStatus: "queued_create"
            };
            items.push(counterpart);
            pairRows.push(counterpart);
          };

          if (typeof env.payload.textZh === "string" && env.payload.textZh.trim()) {
            applyLanguageCopy("zh", env.payload.textZh.trim());
          }
          if (typeof env.payload.textEn === "string" && env.payload.textEn.trim()) {
            applyLanguageCopy("en", env.payload.textEn.trim());
          }
        }
      } else if (env.op === "delete_slogan") {
        const targetId = Number(env.payload.id);
        const target = byId.get(targetId);
        if (target) {
          const targetPairId = target.pairId?.trim() || null;
          for (let i = items.length - 1; i >= 0; i -= 1) {
            const row = items[i];
            if (row.id === targetId || (targetPairId && row.pairId?.trim() === targetPairId)) {
              if (row.id > 0) byId.delete(row.id);
              items.splice(i, 1);
            }
          }
        }
      }
    }

    let filtered = items;
    if (options.language?.trim()) {
      const lang = normalizeSloganLanguage(options.language);
      filtered = filtered.filter((s) => canonicalSloganLanguageForDisplay(s.language) === lang);
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

  private extractPendingCreatedProjects(
    pending: InboxEnvelope[]
  ): Array<{ name: string; cashFlowSides: string }> {
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

  private async listPendingCreatedProjects(): Promise<Array<{ name: string; cashFlowSides: string }>> {
    const pending = await this.ctx.listPendingEnvelopes("sx");
    return this.extractPendingCreatedProjects(pending);
  }

  private async loadProjectCredentialCandidates(
    normalizedProject: string,
    catalog: SxCatalog | null,
    pending: InboxEnvelope[]
  ): Promise<{
    datasetAvailable: boolean;
    isPendingCreatedProject: boolean;
    candidates: SxCredentialCandidate[];
  }> {
    const normalizedKey = normalizedProject.trim().toLowerCase();
    let targetProjectId: number | null = null;
    const projectNameById = new Map<number, string>();
    for (const proj of catalog?.projects ?? []) {
      const parsedId = Number(proj.id);
      if (Number.isInteger(parsedId) && parsedId > 0) {
        projectNameById.set(parsedId, proj.name);
        if (targetProjectId === null && proj.name.trim().toLowerCase() === normalizedKey) {
          targetProjectId = parsedId;
        }
      }
    }

    const [credentialsDataset, projectsDataset] = await Promise.all([
      this.ctx.readDataset<SxCredentialRecord>("sx", "credentials"),
      targetProjectId === null
        ? this.ctx.readDataset<SxProjectRecord>("sx", "projects")
        : Promise.resolve(null)
    ]);

    for (const proj of projectsDataset ?? []) {
      if (Number.isInteger(proj.id) && proj.id > 0) {
        if (!projectNameById.has(proj.id)) {
          projectNameById.set(proj.id, proj.name);
        }
        if (targetProjectId === null && proj.name.trim().toLowerCase() === normalizedKey) {
          targetProjectId = proj.id;
        }
      }
    }

    const isPendingCreatedProject =
      targetProjectId === null &&
      pending.some(
        (env) =>
          env.op === "create_project" &&
          typeof env.payload.name === "string" &&
          env.payload.name.trim().toLowerCase() === normalizedKey
      );

    if (credentialsDataset === null) {
      return { datasetAvailable: false, isPendingCreatedProject, candidates: [] };
    }

    interface TrackedCredential {
      id: number;
      username: string;
      type: string;
      website: string;
      issuer: string;
      deleted: boolean;
      links: Array<{ projectId: number; projectName: string }>;
    }

    const byId = new Map<number, TrackedCredential>();
    for (const cred of credentialsDataset) {
      if (!Number.isInteger(cred.id) || cred.id <= 0) continue;
      byId.set(cred.id, {
        id: cred.id,
        username: cred.username ?? "",
        type: cred.type ?? "",
        website: cred.website ?? "",
        issuer: cred.issuer ?? "",
        deleted: false,
        links: (cred.links ?? []).map((link) => ({
          projectId: Number(link.projectId),
          projectName: link.projectName ?? ""
        }))
      });
    }

    for (const env of pending) {
      if (env.op === "update_credential") {
        const target = byId.get(Number(env.payload.id));
        if (target) {
          if (typeof env.payload.username === "string") target.username = env.payload.username;
          if (typeof env.payload.type === "string") target.type = env.payload.type;
          if (typeof env.payload.website === "string") target.website = env.payload.website;
          if (typeof env.payload.issuer === "string") target.issuer = env.payload.issuer;
        }
      } else if (env.op === "delete_credential") {
        const target = byId.get(Number(env.payload.id));
        if (target) {
          target.deleted = true;
        }
      } else if (env.op === "link_credential") {
        const target = byId.get(Number(env.payload.credentialId));
        const projId = Number(env.payload.projectId);
        if (target && Number.isInteger(projId) && projId > 0) {
          const projName = projectNameById.get(projId) ?? "";
          const existingIdx = target.links.findIndex((link) => link.projectId === projId);
          if (existingIdx >= 0) {
            target.links[existingIdx] = { projectId: projId, projectName: projName };
          } else {
            target.links.push({ projectId: projId, projectName: projName });
          }
        }
      } else if (env.op === "unlink_credential") {
        const target = byId.get(Number(env.payload.credentialId));
        const projId = Number(env.payload.projectId);
        if (target && Number.isInteger(projId)) {
          target.links = target.links.filter((link) => link.projectId !== projId);
        }
      }
      // Pending create_credential entries have id = -1 until iOS sync assigns a row ID,
      // so they cannot be referenced by credentialId yet.
    }

    const candidates: SxCredentialCandidate[] = [];
    for (const cred of byId.values()) {
      if (cred.deleted) continue;
      const isLinked = cred.links.some((link) => {
        if (targetProjectId !== null) {
          return (
            link.projectId === targetProjectId ||
            (link.projectId <= 0 && link.projectName.trim().toLowerCase() === normalizedKey)
          );
        }
        return link.projectName.trim().toLowerCase() === normalizedKey;
      });
      if (!isLinked) continue;
      candidates.push({
        id: cred.id,
        username: cred.username,
        type: cred.type,
        website: cred.website,
        issuer: cred.issuer
      });
    }

    candidates.sort(
      (a, b) => a.username.toLowerCase().localeCompare(b.username.toLowerCase()) || a.id - b.id
    );
    return { datasetAvailable: true, isPendingCreatedProject, candidates };
  }

  private async resolveRecordCredential(
    state: AppStateRow,
    normalizedProject: string,
    catalog: SxCatalog | null,
    pending: InboxEnvelope[],
    input: { credentialId?: number | null; skipCredential?: boolean }
  ): Promise<SxCredentialResolution> {
    if (input.credentialId !== undefined && input.credentialId !== null && input.skipCredential === true) {
      throw new Error("Cannot provide both 'credentialId' and 'skipCredential: true'.");
    }
    if (input.skipCredential === true || input.credentialId === null) {
      return { status: "explicit_none", credentialId: null };
    }
    const policy = parsePolicyFromRow(state);
    const credentialsAllowed = policy.allowedDomains.includes("credentials");

    if (input.credentialId !== undefined) {
      await this.ctx.assertActionDomainAllowed?.("sx", "credentials");
      const credId = validateId(input.credentialId, "credentialId");
      if (credentialsAllowed && policy.allowRead) {
        const { datasetAvailable, isPendingCreatedProject, candidates } =
          await this.loadProjectCredentialCandidates(normalizedProject, catalog, pending);
        if (datasetAvailable && !isPendingCreatedProject) {
          const matched = candidates.find((c) => c.id === credId);
          if (!matched) {
            if (candidates.length > 0) {
              const listText = candidates
                .map((c) => `#${c.id} ${c.username || c.type || "unnamed"}`)
                .join(", ");
              throw new Error(
                `Credential #${credId} is not actively linked to project '${normalizedProject}'. Linked credentials: ${listText}. Choose one of these IDs or pass 'skipCredential: true' to leave unbound.`
              );
            }
            throw new Error(
              `Credential #${credId} is not actively linked to project '${normalizedProject}', and this project has no linked credentials. Omit 'credentialId' to record without a credential (do not create a new credential unless the user asks).`
            );
          }
          return { status: "explicit", credentialId: credId, boundCredential: matched };
        }
      }
      return { status: "explicit", credentialId: credId };
    }

    if (!credentialsAllowed) {
      return { status: "credentials_scope_disabled", credentialId: null };
    }
    if (!policy.allowRead) {
      return { status: "none", credentialId: null };
    }

    const { datasetAvailable, candidates } = await this.loadProjectCredentialCandidates(
      normalizedProject,
      catalog,
      pending
    );
    if (!datasetAvailable || candidates.length === 0) {
      return { status: "none", credentialId: null };
    }
    if (candidates.length === 1) {
      return { status: "auto_bound", credentialId: candidates[0].id, boundCredential: candidates[0] };
    }
    return { status: "selection_required", credentialId: null, candidates };
  }

  private formatCredentialCandidateLabel(candidate: SxCredentialCandidate): string {
    const details = [candidate.type, candidate.issuer, candidate.website]
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    const baseName = candidate.username.trim() || candidate.type.trim() || "unnamed";
    return details.length > 0
      ? `#${candidate.id} (${baseName} — ${details.join(" / ")})`
      : `#${candidate.id} (${baseName})`;
  }

  private buildCredentialSelectionResponse(
    mode: "expense" | "income",
    projectName: string,
    candidates: SxCredentialCandidate[]
  ): Record<string, unknown> {
    const isExpense = mode === "expense";
    const recordKind = isExpense ? "Expense" : "Income";
    const toolName = isExpense ? "sx_record_expense" : "sx_record_income";
    const candidateSummary = candidates.map((c) => this.formatCredentialCandidateLabel(c)).join("; ");
    return {
      queued: false,
      credentialSelectionRequired: true,
      credentialResolution: "selection_required",
      credentialId: null,
      app: "sx",
      op: isExpense ? "record_expense" : "record_income",
      projectName,
      credentialCandidates: candidates,
      selectionPrompt:
        `${recordKind} was NOT queued yet because project '${projectName}' has ${candidates.length} linked credentials: ${candidateSummary}. ` +
        `Ask the user which credential to bind, then re-call ${toolName} with credentialId=<chosen id> (or skipCredential=true to explicitly leave unbound). ` +
        `Do NOT create a new credential unless the user asks.`
    };
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
  ): { payload: Record<string, unknown>; timeZone?: string; catalog: SxCatalog | null } {
    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      throw new Error("SX amount must be a finite number greater than 0.");
    }
    const rawProject = requireNonEmptyString(input.projectName, "projectName");
    const catalog = safeJsonParse<SxCatalog>(catalogJson);
    const timeZone = catalogTimeZone(catalog, fallbackTimeZone);
    const normalizedCurrency = normalizeCurrencyCode(input.currency, catalog);

    const normalizedProject = resolveKnownProjectName(rawProject, mode, catalog, pendingProjects);

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
    return { payload, timeZone, catalog };
  }

  private async recordCashFlow(
    mode: "expense" | "income",
    input: {
      amount: number;
      projectName: string;
      credentialId?: number | null;
      skipCredential?: boolean;
      currency?: string;
      tags?: string[];
      note?: string;
      notes?: string;
      date?: string;
      hour?: unknown;
      requestId?: string;
      client?: string;
    }
  ): Promise<Record<string, unknown>> {
    const domain = mode === "expense" ? "expenses" : "incomes";
    const opName = mode === "expense" ? "record_expense" : "record_income";
    const prefix = mode === "expense" ? "sx-exp" : "sx-inc";

    const state = await this.ctx.assertActionAllowed("sx", "create", domain);
    const pendingEnvelopes = await this.ctx.listPendingEnvelopes("sx");
    const pendingProjects = this.extractPendingCreatedProjects(pendingEnvelopes);
    const fallbackTz = await this.ctx.readAppTimeZone?.("sx");
    const { payload, timeZone, catalog } = this.validateRecordPayload(
      input,
      mode,
      state.catalog_json,
      pendingProjects,
      fallbackTz
    );

    if (input.credentialId !== undefined && input.credentialId !== null && input.skipCredential === true) {
      throw new Error("Cannot provide both 'credentialId' and 'skipCredential: true'.");
    }
    if (input.credentialId !== undefined && input.credentialId !== null) {
      await this.ctx.assertActionDomainAllowed?.("sx", "credentials");
      validateId(input.credentialId, "credentialId");
    }

    const normalizedProject = String(payload.projectName);
    const explicitRequestId = input.requestId?.trim();
    if (explicitRequestId) {
      const existingReceipt = await this.ctx.lookupReceiptByRequestId?.("sx", explicitRequestId);
      if (existingReceipt) {
        return {
          queued: false,
          alreadyProcessed: true,
          receipt: existingReceipt
        };
      }
      const existingInbox = pendingEnvelopes.find((env) => env.requestId === explicitRequestId);
      if (existingInbox) {
        const storedCredId =
          typeof existingInbox.payload.credentialId === "number" ? existingInbox.payload.credentialId : null;
        const policy = parsePolicyFromRow(state);
        let boundCredential: SxCredentialCandidate | undefined;
        if (storedCredId !== null && policy.allowedDomains.includes("credentials") && policy.allowRead) {
          const { candidates } = await this.loadProjectCredentialCandidates(
            normalizedProject,
            catalog,
            pendingEnvelopes
          );
          boundCredential = candidates.find((c) => c.id === storedCredId);
        }
        const existingDate =
          mode === "expense" && typeof existingInbox.payload.date === "string"
            ? existingInbox.payload.date
            : undefined;
        const existingLocalTime = resolvedLocalTimeMeta(existingDate, timeZone);
        return {
          queued: true,
          duplicateInInbox: true,
          app: "sx",
          op: existingInbox.op,
          requestId: explicitRequestId,
          createdAt: existingInbox.createdAt,
          normalizedPayload: existingInbox.payload,
          credentialId: storedCredId,
          ...(boundCredential ? { boundCredential } : {}),
          ...(existingLocalTime ? { resolvedLocalTime: existingLocalTime } : {})
        };
      }
    }

    const resolution = await this.resolveRecordCredential(
      state,
      normalizedProject,
      catalog,
      pendingEnvelopes,
      input
    );
    if (resolution.status === "selection_required") {
      return this.buildCredentialSelectionResponse(mode, normalizedProject, resolution.candidates);
    }
    if (resolution.credentialId !== null) {
      payload.credentialId = resolution.credentialId;
    }

    const requestId = explicitRequestId || generateRequestId(prefix);
    payload.stableID = `sx:remote:${requestId}`;
    const result = await this.ctx.enqueueInbox("sx", opName, requestId, input.client, payload);
    if (result.queued !== true) {
      return result;
    }

    const normalizedPayload = result.normalizedPayload as Record<string, unknown> | undefined;
    const effectiveCredentialId =
      typeof normalizedPayload?.credentialId === "number" ? normalizedPayload.credentialId : null;
    const boundCredential =
      resolution.status === "explicit" || resolution.status === "auto_bound"
        ? resolution.boundCredential && resolution.boundCredential.id === effectiveCredentialId
          ? resolution.boundCredential
          : undefined
        : undefined;
    const effectiveDate =
      mode === "expense" && typeof normalizedPayload?.date === "string" ? normalizedPayload.date : undefined;
    const localTime = resolvedLocalTimeMeta(effectiveDate, timeZone);
    return {
      ...result,
      credentialId: effectiveCredentialId,
      ...(boundCredential ? { boundCredential } : {}),
      credentialResolution: resolution.status,
      ...(localTime ? { resolvedLocalTime: localTime } : {})
    };
  }

  async recordExpense(input: {
    amount: number;
    projectName: string;
    credentialId?: number | null;
    skipCredential?: boolean;
    currency?: string;
    tags?: string[];
    note?: string;
    notes?: string;
    date?: string;
    hour?: unknown;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    return this.recordCashFlow("expense", input);
  }

  private async resolvePendingSxTarget(
    domain: "expenses" | "incomes",
    mode: "update" | "delete",
    input: { id?: number; pendingRequestId?: string },
    expectedCreateOp: "record_expense" | "record_income"
  ): Promise<
    | { kind: "committed"; id: number; resolvedFromSyncedReceipt?: boolean }
    | { kind: "pending"; requestId: string; envelope: InboxEnvelope }
  > {
    const reqId = input.pendingRequestId?.trim();
    if (reqId) {
      const pending = await this.ctx.findPendingEnvelope?.("sx", reqId);
      if (pending) {
        if (pending.op !== expectedCreateOp) {
          throw new Error(
            `Pending request '${reqId}' is '${pending.op}', expected '${expectedCreateOp}'.`
          );
        }
        if (this.ctx.assertReadAccess) {
          const { row, policy } = await this.ctx.assertReadAccess("sx");
          if (row && policy) {
            if (row.permission === "disabled") {
              throw new Error("App 'sx' is paused ('disabled'). Enable permissions in SX Settings -> AI Assistant.");
            }
            if (!policy.allowedDomains.includes(domain)) {
              throw new Error(`Category '${domain}' is turned off by user policy in SX.`);
            }
            if (mode === "update" && !policy.allowUpdate && !policy.allowCreate) {
              throw new Error("SX permission policy does not allow updating this queued entry.");
            }
            if (mode === "delete" && !policy.allowDelete && !policy.allowCreate) {
              throw new Error("SX permission policy does not allow cancelling this queued entry.");
            }
          }
        }
        return { kind: "pending", requestId: reqId, envelope: pending };
      }

      const receipt = await this.ctx.lookupReceiptByRequestId?.("sx", reqId);
      if (receipt?.status === "applied" && receipt.recordId) {
        const numericId = Number(receipt.recordId);
        if (Number.isInteger(numericId) && numericId > 0) {
          await this.ctx.assertActionAllowed("sx", mode, domain);
          return { kind: "committed", id: numericId, resolvedFromSyncedReceipt: true };
        }
      }
      if (receipt) {
        throw new Error(
          `Request '${reqId}' already processed with status '${receipt.status}'${receipt.errorMessage ? `: ${receipt.errorMessage}` : ""}.`
        );
      }
      throw new Error(`Pending SX request '${reqId}' was not found in inbox or synced receipts.`);
    }

    if (input.id === -1) {
      throw new Error(
        `'id' cannot be -1 directly; pass 'pendingRequestId' from ${domain === "expenses" ? "sx_list_expenses" : "sx_list_incomes"} to ${mode} a queued un-synced entry.`
      );
    }

    const id = validateId(input.id, "id");
    await this.ctx.assertActionAllowed("sx", mode, domain);
    return { kind: "committed", id };
  }

  async updateExpense(input: {
    id?: number;
    pendingRequestId?: string;
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
    const target = await this.resolvePendingSxTarget("expenses", "update", input, "record_expense");
    const [catalog, pendingProjects, fallbackTz] = await Promise.all([
      this.ctx.readAppCatalog?.<SxCatalog>("sx") ?? Promise.resolve(null),
      input.projectName !== undefined ? this.listPendingCreatedProjects() : Promise.resolve([]),
      this.ctx.readAppTimeZone?.("sx") ?? Promise.resolve(undefined)
    ]);
    const timeZone = catalogTimeZone(catalog, fallbackTz);

    const updates: Record<string, unknown> = {};
    let clearCredentialFlag = false;
    if (input.credentialId !== undefined || input.clearCredential === true) {
      await this.ctx.assertActionDomainAllowed?.("sx", "credentials");
      if (input.credentialId !== undefined) {
        updates.credentialId = validateId(input.credentialId, "credentialId");
      }
      if (input.clearCredential === true) {
        updates.clearCredential = true;
        clearCredentialFlag = true;
      }
    }
    if (input.amount !== undefined) {
      if (!Number.isFinite(input.amount) || input.amount <= 0) {
        throw new Error("SX 'amount' must be > 0.");
      }
      updates.amount = Math.round(input.amount * 100) / 100;
    }
    if (input.projectName !== undefined) {
      const rawProject = requireNonEmptyString(input.projectName, "projectName");
      updates.projectName = resolveKnownProjectName(rawProject, "expense", catalog, pendingProjects);
    }
    if (input.currency !== undefined) {
      const normalized = normalizeCurrencyCode(input.currency, catalog);
      if (normalized) updates.currency = normalized;
    }
    const tags = normalizeTagsArray(input.tags);
    if (tags !== undefined) updates.tags = tags;
    const resolvedNote = input.note !== undefined ? input.note : input.notes;
    if (resolvedNote !== undefined) updates.note = resolvedNote.trim();

    let isoDate: string | undefined;
    const hasHourInput = input.hour !== undefined && input.hour !== null;
    if (hasHourInput && !input.date?.trim()) {
      const hour = validateLocalHour(input.hour);
      let existingLocalDate: string | undefined;
      if (target.kind === "pending") {
        const refIso =
          typeof target.envelope.payload.date === "string"
            ? target.envelope.payload.date
            : target.envelope.createdAt;
        existingLocalDate = localDateHourParts(refIso, timeZone)?.localDate;
      } else {
        const existing = await this.findExpenseForUpdate(target.id);
        existingLocalDate =
          existing?.localDate?.trim() || localDateHourParts(existing?.paidAt, timeZone)?.localDate;
      }
      if (!existingLocalDate) {
        throw new Error(
          `Cannot update 'hour' alone because expense #${target.kind === "committed" ? target.id : target.requestId} is not in the synced snapshot yet. Please provide 'date' (e.g. 'YYYY-MM-DD') together with 'hour'.`
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
    if (isoDate) updates.date = isoDate;

    if (Object.keys(updates).length === 0) {
      throw new Error("update_expense requires at least one field to update.");
    }

    if (target.kind === "pending" && this.ctx.updatePendingEnvelopePayload) {
      const nextPayload: Record<string, unknown> = { ...target.envelope.payload, ...updates };
      const previousProject = String(target.envelope.payload.projectName ?? "").trim().toLowerCase();
      const movedProject =
        typeof updates.projectName === "string" &&
        updates.projectName.trim().toLowerCase() !== previousProject;
      if (clearCredentialFlag || (movedProject && updates.credentialId === undefined)) {
        delete nextPayload.credentialId;
        delete nextPayload.clearCredential;
      }
      await this.ctx.updatePendingEnvelopePayload("sx", target.requestId, nextPayload);
      const effectiveDate = typeof nextPayload.date === "string" ? nextPayload.date : undefined;
      const localTime = resolvedLocalTimeMeta(effectiveDate, timeZone);
      return {
        queued: true,
        updatedPending: true,
        app: "sx",
        op: "update_expense",
        requestId: target.requestId,
        normalizedPayload: nextPayload,
        ...(localTime ? { resolvedLocalTime: localTime } : {})
      };
    }

    const resolvedId = target.kind === "committed" ? target.id : -1;
    const payload: Record<string, unknown> = { id: resolvedId, ...updates };
    const requestId = input.requestId?.trim() || generateRequestId("sx-exp-upd");
    const result = await this.ctx.enqueueInbox("sx", "update_expense", requestId, input.client, payload);
    const normalizedPayload = result.normalizedPayload as Record<string, unknown> | undefined;
    const effectiveDate = typeof normalizedPayload?.date === "string" ? normalizedPayload.date : undefined;
    const localTime = resolvedLocalTimeMeta(effectiveDate, timeZone);
    return {
      ...result,
      ...(localTime && result.queued === true ? { resolvedLocalTime: localTime } : {}),
      ...(target.kind === "committed" && target.resolvedFromSyncedReceipt ? { resolvedFromSyncedReceipt: true } : {})
    };
  }

  async deleteExpense(input: {
    id?: number;
    pendingRequestId?: string;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    const target = await this.resolvePendingSxTarget("expenses", "delete", input, "record_expense");
    if (target.kind === "pending" && this.ctx.deletePendingEnvelope) {
      await this.ctx.deletePendingEnvelope("sx", target.requestId);
      return {
        queued: false,
        cancelledPending: true,
        app: "sx",
        op: "record_expense",
        requestId: target.requestId
      };
    }
    const id = target.kind === "committed" ? target.id : validateId(input.id, "id");
    const requestId = input.requestId?.trim() || generateRequestId("sx-exp-del");
    const res = await this.ctx.enqueueInbox("sx", "delete_expense", requestId, input.client, { id });
    return target.kind === "committed" && target.resolvedFromSyncedReceipt
      ? { ...res, resolvedFromSyncedReceipt: true }
      : res;
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
    credentialId?: number | null;
    skipCredential?: boolean;
    currency?: string;
    tags?: string[];
    note?: string;
    notes?: string;
    date?: string;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    return this.recordCashFlow("income", input);
  }

  async updateIncome(input: {
    id?: number;
    pendingRequestId?: string;
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
    const target = await this.resolvePendingSxTarget("incomes", "update", input, "record_income");
    const [catalog, pendingProjects, fallbackTz] = await Promise.all([
      this.ctx.readAppCatalog?.<SxCatalog>("sx") ?? Promise.resolve(null),
      input.projectName !== undefined ? this.listPendingCreatedProjects() : Promise.resolve([]),
      this.ctx.readAppTimeZone?.("sx") ?? Promise.resolve(undefined)
    ]);
    const timeZone = catalogTimeZone(catalog, fallbackTz);

    const updates: Record<string, unknown> = {};
    let clearCredentialFlag = false;
    if (input.credentialId !== undefined || input.clearCredential === true) {
      await this.ctx.assertActionDomainAllowed?.("sx", "credentials");
      if (input.credentialId !== undefined) {
        updates.credentialId = validateId(input.credentialId, "credentialId");
      }
      if (input.clearCredential === true) {
        updates.clearCredential = true;
        clearCredentialFlag = true;
      }
    }
    if (input.amount !== undefined) {
      if (!Number.isFinite(input.amount) || input.amount <= 0) throw new Error("SX 'amount' must be > 0.");
      updates.amount = Math.round(input.amount * 100) / 100;
    }
    if (input.projectName !== undefined) {
      const rawProject = requireNonEmptyString(input.projectName, "projectName");
      updates.projectName = resolveKnownProjectName(rawProject, "income", catalog, pendingProjects);
    }
    if (input.currency !== undefined) {
      const normalized = normalizeCurrencyCode(input.currency, catalog);
      if (normalized) updates.currency = normalized;
    }
    const tags = normalizeTagsArray(input.tags);
    if (tags !== undefined) updates.tags = tags;
    const resolvedNote = input.note !== undefined ? input.note : input.notes;
    if (resolvedNote !== undefined) updates.note = resolvedNote.trim();
    const isoDate = resolveSxTimestamp(input.date, "date", { timeZone, defaultLocalHour: 0 });
    if (isoDate) updates.date = isoDate;
    if (Object.keys(updates).length === 0) throw new Error("update_income requires at least one field to update.");

    if (target.kind === "pending" && this.ctx.updatePendingEnvelopePayload) {
      const nextPayload: Record<string, unknown> = { ...target.envelope.payload, ...updates };
      const previousProject = String(target.envelope.payload.projectName ?? "").trim().toLowerCase();
      const movedProject =
        typeof updates.projectName === "string" &&
        updates.projectName.trim().toLowerCase() !== previousProject;
      if (clearCredentialFlag || (movedProject && updates.credentialId === undefined)) {
        delete nextPayload.credentialId;
        delete nextPayload.clearCredential;
      }
      await this.ctx.updatePendingEnvelopePayload("sx", target.requestId, nextPayload);
      return {
        queued: true,
        updatedPending: true,
        app: "sx",
        op: "update_income",
        requestId: target.requestId,
        normalizedPayload: nextPayload
      };
    }

    const resolvedId = target.kind === "committed" ? target.id : -1;
    const payload: Record<string, unknown> = { id: resolvedId, ...updates };
    const requestId = input.requestId?.trim() || generateRequestId("sx-inc-upd");
    const res = await this.ctx.enqueueInbox("sx", "update_income", requestId, input.client, payload);
    return target.kind === "committed" && target.resolvedFromSyncedReceipt
      ? { ...res, resolvedFromSyncedReceipt: true }
      : res;
  }

  async deleteIncome(input: {
    id?: number;
    pendingRequestId?: string;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    const target = await this.resolvePendingSxTarget("incomes", "delete", input, "record_income");
    if (target.kind === "pending" && this.ctx.deletePendingEnvelope) {
      await this.ctx.deletePendingEnvelope("sx", target.requestId);
      return {
        queued: false,
        cancelledPending: true,
        app: "sx",
        op: "record_income",
        requestId: target.requestId
      };
    }
    const id = target.kind === "committed" ? target.id : validateId(input.id, "id");
    const requestId = input.requestId?.trim() || generateRequestId("sx-inc-del");
    const res = await this.ctx.enqueueInbox("sx", "delete_income", requestId, input.client, { id });
    return target.kind === "committed" && target.resolvedFromSyncedReceipt
      ? { ...res, resolvedFromSyncedReceipt: true }
      : res;
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

  private async findSloganForUpdate(id: number): Promise<SxSloganRecord | null> {
    const [dataset, pending] = await Promise.all([
      this.ctx.readDataset<SxSloganRecord>("sx", "slogans"),
      this.ctx.listPendingEnvelopes("sx")
    ]);
    const items: SxSloganRecord[] = dataset ? dataset.map((s) => ({ ...s })) : [];
    const byId = new Map(items.map((s) => [s.id, s]));
    for (const env of pending) {
      if (env.op === "update_slogan") {
        const target = byId.get(Number(env.payload.id));
        if (target) {
          const targetPairId = target.pairId?.trim() || null;
          const group = targetPairId
            ? items.filter((row) => row.pairId?.trim() === targetPairId)
            : [target];
          for (const row of group) {
            if (typeof env.payload.ruleType === "string") row.ruleType = env.payload.ruleType;
            if (typeof env.payload.ruleValue === "string") row.ruleValue = env.payload.ruleValue;
          }
        }
      } else if (env.op === "delete_slogan") {
        const deletedId = Number(env.payload.id);
        const deleted = byId.get(deletedId);
        if (deleted) {
          const deletedPairId = deleted.pairId?.trim() || null;
          for (let i = items.length - 1; i >= 0; i -= 1) {
            const row = items[i];
            if (row.id === deletedId || (deletedPairId && row.pairId?.trim() === deletedPairId)) {
              if (row.id > 0) byId.delete(row.id);
              items.splice(i, 1);
            }
          }
        }
      }
    }
    return byId.get(id) ?? null;
  }

  async createSlogan(input: {
    text: string;
    textEn?: string;
    language?: string;
    emoji?: string;
    ruleType?: string;
    ruleValue?: string;
    priority?: number;
    isEnabled?: boolean;
    pairId?: string;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    await this.ctx.assertActionAllowed("sx", "create", "slogans");
    const text = requireNonEmptyString(input.text, "text");
    const language = input.language !== undefined ? normalizeSloganLanguage(input.language) : "zh";
    const { ruleType, ruleValue } = normalizeSloganRule(input.ruleType, input.ruleValue);

    let priority: number;
    if (input.priority !== undefined) {
      if (!Number.isInteger(input.priority)) {
        throw new Error("Slogan 'priority' must be an integer.");
      }
      priority = input.priority;
    } else {
      priority = defaultSloganPriority(ruleType);
    }

    let textEn: string | undefined;
    if (input.textEn !== undefined) {
      textEn = requireNonEmptyString(input.textEn, "textEn");
      if (language !== "zh") {
        throw new Error(
          "'textEn' is only supported when 'language' is 'zh' (for creating a linked zh+en pair). When creating an English-only slogan, pass the text in 'text' with language='en'."
        );
      }
    }

    let pairId: string | undefined;
    if (input.pairId !== undefined) {
      pairId = requireNonEmptyString(input.pairId, "pairId");
    } else if (textEn !== undefined) {
      pairId = crypto.randomUUID();
    }

    const payload: Record<string, unknown> = {
      text,
      language,
      ruleType,
      ruleValue,
      priority,
      isEnabled: input.isEnabled ?? true
    };
    if (textEn !== undefined) payload.textEn = textEn;
    if (pairId !== undefined) payload.pairId = pairId;
    if (input.emoji?.trim()) payload.emoji = input.emoji.trim();
    const requestId = input.requestId?.trim() || generateRequestId("sx-slo");
    return this.ctx.enqueueInbox("sx", "create_slogan", requestId, input.client, payload);
  }

  async updateSlogan(input: {
    id: number;
    text?: string;
    textZh?: string;
    textEn?: string;
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
    if (input.textZh !== undefined) payload.textZh = requireNonEmptyString(input.textZh, "textZh");
    if (input.textEn !== undefined) payload.textEn = requireNonEmptyString(input.textEn, "textEn");
    if (input.language !== undefined) payload.language = normalizeSloganLanguage(input.language);
    if (input.emoji !== undefined) payload.emoji = input.emoji === null ? "" : input.emoji.trim();

    if (input.ruleType !== undefined && input.ruleValue !== undefined) {
      const normalized = normalizeSloganRule(input.ruleType, input.ruleValue);
      payload.ruleType = normalized.ruleType;
      payload.ruleValue = normalized.ruleValue;
    } else if (input.ruleType !== undefined) {
      const normalizedType = normalizeSloganRuleType(input.ruleType);
      if (normalizedType === "default") {
        payload.ruleType = "default";
        payload.ruleValue = "{}";
      } else {
        const existing = await this.findSloganForUpdate(id);
        if (existing && normalizeSloganRuleTypeLenient(existing.ruleType) === normalizedType) {
          const normalized = normalizeSloganRule(normalizedType, existing.ruleValue);
          payload.ruleType = normalized.ruleType;
          payload.ruleValue = normalized.ruleValue;
        } else {
          // Throws an actionable error describing the required ruleValue format for normalizedType.
          normalizeSloganRule(normalizedType, undefined);
        }
      }
    } else if (input.ruleValue !== undefined) {
      const existing = await this.findSloganForUpdate(id);
      if (existing) {
        const existingType = normalizeSloganRuleType(existing.ruleType);
        const normalized = normalizeSloganRule(existingType, input.ruleValue);
        payload.ruleValue = normalized.ruleValue;
      } else {
        payload.ruleValue = normalizeStandaloneSloganRuleValue(input.ruleValue);
      }
    }

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
    const [dataset, pending, projectsDataset] = await Promise.all([
      this.ctx.readDataset<SxCredentialRecord>("sx", "credentials"),
      this.ctx.listPendingEnvelopes("sx"),
      this.ctx.readDataset<SxProjectRecord>("sx", "projects")
    ]);
    const projectNameById = new Map((projectsDataset ?? []).map((p) => [p.id, p.name]));
    const items: SxCredentialRecord[] = dataset
      ? dataset.map((cred) => ({ ...cred, links: cred.links?.map((link) => ({ ...link })) ?? [] }))
      : [];
    const byId = new Map(items.map((cred) => [cred.id, cred]));

    for (const env of pending) {
      if (env.op === "create_credential") {
        const linkedProjId = typeof env.payload.projectId === "number" ? env.payload.projectId : null;
        const linkedProjName =
          typeof env.payload.projectName === "string" && env.payload.projectName.trim()
            ? env.payload.projectName.trim()
            : linkedProjId !== null
              ? projectNameById.get(linkedProjId) ?? null
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
      } else if (env.op === "link_credential") {
        const target = byId.get(Number(env.payload.credentialId));
        const projId = Number(env.payload.projectId);
        if (target && Number.isInteger(projId)) {
          const existingIdx = target.links.findIndex((l) => l.projectId === projId);
          const nextLink = {
            projectId: projId,
            projectName: projectNameById.get(projId) ?? "",
            startDate: typeof env.payload.startDate === "string" ? env.payload.startDate : env.createdAt,
            hasStartDate: Boolean(
              env.payload.hasStartDate ??
                (env.payload.startDate !== undefined || env.payload.isAutoRenew === true)
            ),
            endDate: typeof env.payload.endDate === "string" ? env.payload.endDate : null,
            isAutoRenew: Boolean(env.payload.isAutoRenew),
            nextRenewalDate: typeof env.payload.nextRenewalDate === "string" ? env.payload.nextRenewalDate : null,
            renewalHour: typeof env.payload.renewalHour === "number" ? env.payload.renewalHour : 0,
            renewalWeekdays: typeof env.payload.renewalWeekdays === "number" ? env.payload.renewalWeekdays : 127
          };
          if (existingIdx >= 0) target.links[existingIdx] = nextLink;
          else target.links.push(nextLink);
          target.linkCount = target.links.length;
          target.pendingStatus = "queued_update";
          target.pendingRequestId = env.requestId;
        }
      } else if (env.op === "update_credential_link") {
        const target = byId.get(Number(env.payload.credentialId));
        const projId = Number(env.payload.projectId);
        const link = target?.links.find((l) => l.projectId === projId);
        if (target && link) {
          if (typeof env.payload.startDate === "string") link.startDate = env.payload.startDate;
          if (typeof env.payload.hasStartDate === "boolean") link.hasStartDate = env.payload.hasStartDate;
          if (env.payload.clearEndDate === true) link.endDate = null;
          else if (typeof env.payload.endDate === "string") link.endDate = env.payload.endDate;
          if (typeof env.payload.isAutoRenew === "boolean") link.isAutoRenew = env.payload.isAutoRenew;
          if (env.payload.clearNextRenewalDate === true) link.nextRenewalDate = null;
          else if (typeof env.payload.nextRenewalDate === "string") {
            link.nextRenewalDate = env.payload.nextRenewalDate;
          }
          if (typeof env.payload.renewalHour === "number") link.renewalHour = env.payload.renewalHour;
          if (typeof env.payload.renewalWeekdays === "number") link.renewalWeekdays = env.payload.renewalWeekdays;
          target.pendingStatus = "queued_update";
          target.pendingRequestId = env.requestId;
        }
      } else if (env.op === "unlink_credential") {
        const target = byId.get(Number(env.payload.credentialId));
        const projId = Number(env.payload.projectId);
        if (target) {
          target.links = target.links.filter((l) => l.projectId !== projId);
          target.linkCount = target.links.length;
          target.pendingStatus = "queued_update";
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
