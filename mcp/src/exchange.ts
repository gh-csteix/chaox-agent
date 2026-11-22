import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const SCHEMA_VERSION = "chaox-agent/v1";

export type AgentAppID = "sx" | "bx" | "gx";
export type PermissionTier = "disabled" | "readOnly" | "appendOnly" | "readWrite";
export type BxMealType = "breakfast" | "lunch" | "dinner" | "snack";
export type BxSkinProduct = "sunscreen" | "moisturizer" | "bodyLotion" | "medicine" | "other";
export type BxToiletKind = "bowel" | "urination";

export interface AppEndpoint {
  app: AgentAppID;
  bundleId: string;
  appVersion: string;
  permission: PermissionTier;
  capabilities: string[];
  lastSyncAt: string;
  catalogPath: string;
  summaryPath: string;
  inboxPath: string;
  receiptsPath: string;
  pendingInboxCount?: number;
}

export interface ProtocolManifest {
  schemaVersion: string;
  updatedAt: string;
  apps: Record<string, AppEndpoint>;
}

export interface RequestSource {
  client?: string;
  agent?: string;
  note?: string;
}

export interface InboxEnvelope {
  schemaVersion: string;
  requestId: string;
  app: AgentAppID;
  op: string;
  createdAt: string;
  source?: RequestSource;
  payload: Record<string, unknown>;
}

export interface Receipt {
  schemaVersion: string;
  requestId: string;
  app: AgentAppID;
  op: string;
  status: "applied" | "duplicate" | "rejected" | "failed";
  processedAt: string;
  recordId?: string;
  stableId?: string;
  summary?: string;
  details?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
}

export interface SxCatalogProject {
  id?: string;
  name: string;
  currency?: string;
  type?: string;
  cycle?: string;
  supportsExpense?: boolean;
  supportsIncome?: boolean;
  recentExpenseTags?: string[];
  recentIncomeTags?: string[];
}

export interface SxCatalog {
  generatedAt?: string;
  timeZoneIdentifier?: string;
  summaryCurrency?: string;
  supportedCurrencies?: string[];
  projects?: SxCatalogProject[];
  tags?: string[];
  rules?: string[];
  [key: string]: unknown;
}

export interface SxPeriodBucket {
  period: string;
  mode?: string;
  currency?: string;
  netTotal?: number;
  grossTotal?: number;
  recordCount?: number;
  [key: string]: unknown;
}

export interface SxSummaryBundle {
  generatedAt?: string;
  summaryCurrency?: string;
  expense?: Record<string, SxPeriodBucket>;
  income?: Record<string, SxPeriodBucket>;
  periods?: Record<string, SxPeriodBucket>;
  [key: string]: unknown;
}

export interface BxCatalog {
  generatedAt?: string;
  mealTypes?: string[];
  skinProducts?: string[];
  bristolRange?: { min: number; max: number };
  recentSkinNames?: Record<string, string[]>;
  timeZoneIdentifier?: string;
  [key: string]: unknown;
}

export interface BxDaySummary {
  date: string;
  totalCalories?: number;
  unknownCaloriesCount?: number;
  mealCount?: number;
  meals?: Array<Record<string, unknown>>;
  skinCount?: number;
  bowelCount?: number;
  urinationCount?: number;
  toiletCount?: number;
  [key: string]: unknown;
}

export interface BxSummaryBundle {
  generatedAt?: string;
  timeZoneIdentifier?: string;
  days?: BxDaySummary[];
  today?: BxDaySummary;
  [key: string]: unknown;
}

export interface RecordSxExpenseInput {
  amount: number;
  projectName: string;
  currency?: string;
  tags?: string[];
  note?: string;
  notes?: string;
  date?: string;
  hour?: number | string;
  requestId?: string;
  client?: string;
}

export interface RecordSxIncomeInput {
  amount: number;
  projectName: string;
  currency?: string;
  tags?: string[];
  note?: string;
  notes?: string;
  date?: string;
  requestId?: string;
  client?: string;
}

export interface RecordBxFoodInput {
  name: string;
  mealType?: BxMealType;
  calories?: number;
  recordedAt?: string;
  requestId?: string;
  client?: string;
}

export interface RecordBxSkinInput {
  product: BxSkinProduct;
  name?: string;
  brand?: string;
  recordedAt?: string;
  requestId?: string;
  client?: string;
}

export interface RecordBxToiletInput {
  kind?: BxToiletKind;
  stoolType?: number;
  bristol?: number;
  note?: string;
  recordedAt?: string;
  requestId?: string;
  client?: string;
}

export interface EnqueueResult {
  queued: true;
  app: AgentAppID;
  op: string;
  requestId: string;
  inboxFile: string;
  createdAt: string;
  normalizedPayload: Record<string, unknown>;
  note: string;
}

const VALID_MEAL_TYPES = new Set<string>(["breakfast", "lunch", "dinner", "snack"]);
const VALID_SKIN_PRODUCTS = new Set<string>([
  "sunscreen",
  "moisturizer",
  "bodyLotion",
  "medicine",
  "other"
]);
const VALID_TOILET_KINDS = new Set<string>(["bowel", "urination"]);

export function defaultExchangeDir(): string {
  if (process.env.CHAOX_AGENT_DIR?.trim()) {
    return path.resolve(process.env.CHAOX_AGENT_DIR.trim());
  }
  return path.join(
    os.homedir(),
    "Library",
    "Mobile Documents",
    "com~apple~CloudDocs",
    "CHAOX-Agent"
  );
}

export function sanitizedFilenameComponent(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 96) : crypto.randomUUID();
}

export function generateRequestId(prefix: string): string {
  const short = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return `${prefix}-${short}`;
}

function effectiveTimeZone(timeZoneIdentifier?: string): string {
  const tz = timeZoneIdentifier?.trim();
  if (tz) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return tz;
    } catch {
      // Ignore invalid timezone identifier and fall back to local/UTC.
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function zonedLocalToUtcIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string
): string {
  const targetUtcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: effectiveTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const partsMs = (ms: number): number => {
    const parts = formatter.formatToParts(new Date(ms));
    const map: Record<string, number> = {};
    for (const part of parts) {
      if (part.type !== "literal") map[part.type] = Number(part.value);
    }
    const h = map.hour === 24 ? 0 : map.hour;
    return Date.UTC(map.year, map.month - 1, map.day, h, map.minute, map.second, 0);
  };
  let guess = targetUtcMs;
  for (let i = 0; i < 3; i += 1) {
    const diff = partsMs(guess) - targetUtcMs;
    if (diff === 0) break;
    guess -= diff;
  }
  const checkDate = new Date(Date.UTC(year, month - 1, day, hour, minute, second, 0));
  if (
    checkDate.getUTCFullYear() !== year ||
    checkDate.getUTCMonth() !== month - 1 ||
    checkDate.getUTCDate() !== day ||
    checkDate.getUTCHours() !== hour ||
    checkDate.getUTCMinutes() !== minute ||
    checkDate.getUTCSeconds() !== second
  ) {
    throw new Error(`Invalid calendar timestamp: ${year}-${month}-${day} ${hour}:${minute}`);
  }
  return new Date(guess).toISOString();
}

function resolveSxTimestamp(
  rawDate: string | undefined,
  fieldName: string,
  options: { timeZone?: string; hour?: unknown; allowHourOnly?: boolean } = {}
): string | undefined {
  let parsedExplicitHour: number | undefined;
  if (options.hour !== undefined && options.hour !== null) {
    if (typeof options.hour === "number") {
      if (!Number.isInteger(options.hour) || options.hour < 0 || options.hour > 23) {
        throw new Error("'hour' must be an integer between 0 and 23 (24-hour local clock in SX time zone).");
      }
      parsedExplicitHour = options.hour;
    } else if (typeof options.hour === "string" && /^\d{1,2}$/.test(options.hour.trim())) {
      const n = Number(options.hour.trim());
      if (n < 0 || n > 23) {
        throw new Error("'hour' must be an integer between 0 and 23 (24-hour local clock in SX time zone).");
      }
      parsedExplicitHour = n;
    } else {
      throw new Error("'hour' must be an integer between 0 and 23 (24-hour local clock in SX time zone).");
    }
  }
  const tz = effectiveTimeZone(options.timeZone);
  const trimmed = rawDate?.trim();
  if (!trimmed) {
    if (parsedExplicitHour !== undefined && options.allowHourOnly) {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).formatToParts(new Date());
      const map: Record<string, string> = {};
      for (const p of parts) {
        if (p.type !== "literal") map[p.type] = p.value;
      }
      return zonedLocalToUtcIso(Number(map.year), Number(map.month), Number(map.day), parsedExplicitHour, 0, 0, tz);
    }
    return undefined;
  }

  const displayMatch = /^(\d{4})-(\d{2})-(\d{2})[-T ](\d{2})$/.exec(trimmed);
  if (displayMatch) {
    const parsedHour = Number(displayMatch[4]);
    if (parsedHour < 0 || parsedHour > 23) {
      throw new Error(`Invalid local hour '${displayMatch[4]}' in '${fieldName}': ${rawDate}. Expected 00-23.`);
    }
    return zonedLocalToUtcIso(
      Number(displayMatch[1]),
      Number(displayMatch[2]),
      Number(displayMatch[3]),
      parsedExplicitHour ?? parsedHour,
      0,
      0,
      tz
    );
  }

  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnlyMatch) {
    return zonedLocalToUtcIso(
      Number(dateOnlyMatch[1]),
      Number(dateOnlyMatch[2]),
      Number(dateOnlyMatch[3]),
      parsedExplicitHour ?? 0,
      0,
      0,
      tz
    );
  }

  const localDateTimeMatch = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/.exec(
    trimmed
  );
  if (localDateTimeMatch) {
    const y = Number(localDateTimeMatch[1]);
    const m = Number(localDateTimeMatch[2]);
    const d = Number(localDateTimeMatch[3]);
    const h = Number(localDateTimeMatch[4]);
    const min = Number(localDateTimeMatch[5]);
    const sec = localDateTimeMatch[6] !== undefined ? Number(localDateTimeMatch[6]) : 0;
    const iso = zonedLocalToUtcIso(y, m, d, h, min, sec, tz);
    return parsedExplicitHour !== undefined ? zonedLocalToUtcIso(y, m, d, parsedExplicitHour, 0, 0, tz) : iso;
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `Invalid '${fieldName}': ${rawDate}. Accepted formats: '2026-11-22T12:00:00+08:00', '2026-11-22-12', or '2026-11-22' (optionally with 'hour' 0..23).`
    );
  }
  const iso = new Date(parsed).toISOString();
  if (parsedExplicitHour !== undefined) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date(parsed));
    const map: Record<string, string> = {};
    for (const p of parts) {
      if (p.type !== "literal") map[p.type] = p.value;
    }
    return zonedLocalToUtcIso(Number(map.year), Number(map.month), Number(map.day), parsedExplicitHour, 0, 0, tz);
  }
  return iso;
}

function validateIsoTimestamp(raw: string | undefined, fieldName: string): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid ISO-8601 date/time for '${fieldName}': ${raw}`);
  }
  return new Date(parsed).toISOString();
}

function dateKeyInLocalCalendar(dateInput: Date): string {
  const year = dateInput.getFullYear();
  const month = String(dateInput.getMonth() + 1).padStart(2, "0");
  const day = String(dateInput.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeFileAtomic(targetPath: string, content: string): Promise<void> {
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `.tmp-${process.pid}-${crypto.randomUUID()}.json`);
  await fs.writeFile(tempPath, content, "utf8");
  await fs.rename(tempPath, targetPath);
}

export class ChaoxExchangeClient {
  readonly rootDir: string;

  constructor(rootDir: string = defaultExchangeDir()) {
    this.rootDir = path.resolve(rootDir);
  }

  private appDir(app: AgentAppID): string {
    return path.join(this.rootDir, app);
  }

  private async readManifest(): Promise<ProtocolManifest | null> {
    return readJsonIfExists<ProtocolManifest>(path.join(this.rootDir, "protocol.json"));
  }

  private async assertReadAllowed(app: AgentAppID): Promise<ProtocolManifest | null> {
    const manifest = await this.readManifest();
    const endpoint = manifest?.apps?.[app];
    if (endpoint && endpoint.permission === "disabled") {
      throw new Error(
        `App '${app}' is set to 'disabled' in protocol.json. Enable readOnly or appendOnly in ${app.toUpperCase()} Settings.`
      );
    }
    return manifest;
  }

  private async assertWriteAllowed(app: AgentAppID): Promise<ProtocolManifest> {
    const manifest = await this.readManifest();
    if (!manifest) {
      throw new Error(
        `No protocol.json found at ${this.rootDir}. Open ${app.toUpperCase()} Settings -> Agent Exchange and select this folder first.`
      );
    }
    const endpoint = manifest.apps?.[app];
    if (!endpoint) {
      throw new Error(
        `App '${app}' is not registered in ${this.rootDir}/protocol.json yet. Enable Agent Exchange inside ${app.toUpperCase()} Settings first.`
      );
    }
    if (endpoint.permission === "disabled" || endpoint.permission === "readOnly") {
      throw new Error(
        `App '${app}' permission is '${endpoint.permission}', which does not allow writes. Switch to 'appendOnly' or 'readWrite' in ${app.toUpperCase()} Settings.`
      );
    }
    return manifest;
  }

  private async listPendingEnvelopes(app: AgentAppID): Promise<InboxEnvelope[]> {
    const inboxDir = path.join(this.appDir(app), "inbox");
    let entries: string[];
    try {
      entries = await fs.readdir(inboxDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const jsonFiles = entries
      .filter((name) => !name.startsWith(".") && name.endsWith(".json"))
      .sort();

    const envelopes: InboxEnvelope[] = [];
    for (const fileName of jsonFiles) {
      try {
        const parsed = await readJsonIfExists<InboxEnvelope>(path.join(inboxDir, fileName));
        if (parsed && parsed.app === app) {
          envelopes.push(parsed);
        }
      } catch {
        // Ignore malformed transient files while scanning overlay.
      }
    }
    return envelopes;
  }

  async checkReceipts(options: {
    app?: AgentAppID;
    requestId?: string;
    limit?: number;
  } = {}): Promise<{ receipts: Receipt[]; pending: InboxEnvelope[] }> {
    const apps: AgentAppID[] = options.app ? [options.app] : ["sx", "bx"];
    const receipts: Receipt[] = [];
    const pending: InboxEnvelope[] = [];
    const limit = Math.max(1, Math.min(options.limit ?? 10, 50));

    for (const app of apps) {
      const pendingList = await this.listPendingEnvelopes(app);
      if (options.requestId) {
        pending.push(...pendingList.filter((item) => item.requestId === options.requestId));
      } else {
        pending.push(...pendingList);
      }

      const receiptsDir = path.join(this.appDir(app), "receipts");
      if (options.requestId) {
        const target = path.join(
          receiptsDir,
          `${sanitizedFilenameComponent(options.requestId)}.json`
        );
        const match = await readJsonIfExists<Receipt>(target);
        if (match) receipts.push(match);
        continue;
      }

      try {
        const entries = await fs.readdir(receiptsDir);
        const jsonFiles = entries.filter((name) => !name.startsWith(".") && name.endsWith(".json"));
        for (const fileName of jsonFiles) {
          const item = await readJsonIfExists<Receipt>(path.join(receiptsDir, fileName));
          if (item) receipts.push(item);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }

    receipts.sort((lhs, rhs) => rhs.processedAt.localeCompare(lhs.processedAt));
    return {
      receipts: receipts.slice(0, limit),
      pending
    };
  }

  async getStatus(options: {
    app?: AgentAppID;
    requestId?: string;
    receiptLimit?: number;
  } = {}): Promise<Record<string, unknown>> {
    const manifest = await this.readManifest();
    const pendingSx = await this.listPendingEnvelopes("sx");
    const pendingBx = await this.listPendingEnvelopes("bx");
    const receiptInfo = await this.checkReceipts({
      app: options.app,
      requestId: options.requestId,
      limit: options.receiptLimit ?? 10
    });

    return {
      exchangeDir: this.rootDir,
      protocolFound: manifest !== null,
      schemaVersion: manifest?.schemaVersion ?? SCHEMA_VERSION,
      updatedAt: manifest?.updatedAt ?? null,
      apps: manifest?.apps ?? {},
      pendingInbox: {
        sx: pendingSx.length,
        bx: pendingBx.length
      },
      matchedPending: options.requestId ? receiptInfo.pending : undefined,
      recentReceipts: receiptInfo.receipts
    };
  }

  async readSxCatalog(): Promise<SxCatalog> {
    await this.assertReadAllowed("sx");
    const catalog = await readJsonIfExists<SxCatalog>(path.join(this.appDir("sx"), "catalog.json"));
    if (!catalog) {
      throw new Error(
        `Missing ${this.appDir("sx")}/catalog.json. Open SX to publish an initial snapshot.`
      );
    }
    return catalog;
  }

  async readBxCatalog(): Promise<BxCatalog | null> {
    await this.assertReadAllowed("bx");
    return readJsonIfExists<BxCatalog>(path.join(this.appDir("bx"), "catalog.json"));
  }

  async readSxSummary(options: {
    period?: "today" | "week" | "month" | "year" | "allTime";
    mode?: "expense" | "income";
  } = {}): Promise<Record<string, unknown>> {
    await this.assertReadAllowed("sx");
    const summary = await readJsonIfExists<SxSummaryBundle>(
      path.join(this.appDir("sx"), "summary.json")
    );
    if (!summary) {
      throw new Error(
        `Missing ${this.appDir("sx")}/summary.json. Open SX to publish an initial summary.`
      );
    }

    const mode = options.mode ?? "expense";
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
    const committedTotal =
      typeof committedBucket?.netTotal === "number" ? committedBucket.netTotal : null;
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
    await this.assertReadAllowed("bx");
    const summary = await readJsonIfExists<BxSummaryBundle>(
      path.join(this.appDir("bx"), "summary.json")
    );
    const catalog = await readJsonIfExists<BxCatalog>(path.join(this.appDir("bx"), "catalog.json"));
    if (!summary) {
      throw new Error(
        `Missing ${this.appDir("bx")}/summary.json. Open BX to publish an initial summary.`
      );
    }

    const targetDate = options.date?.trim() || summary.today?.date || dateKeyInLocalCalendar(new Date());
    const committedDay =
      summary.days?.find((day) => day.date === targetDate) ??
      (summary.today?.date === targetDate ? summary.today : null);

    const pending = await this.listPendingEnvelopes("bx");
    const pendingForDate = pending.filter((env) => {
      const recordedAt = typeof env.payload.recordedAt === "string" ? env.payload.recordedAt : env.createdAt;
      const parsed = Date.parse(recordedAt);
      if (Number.isNaN(parsed)) return true;
      return dateKeyInLocalCalendar(new Date(parsed)) === targetDate || recordedAt.startsWith(targetDate);
    });

    let pendingCalories = 0;
    let pendingUnknownCalories = 0;
    let pendingMealCount = 0;
    let pendingSkinCount = 0;
    let pendingBowelCount = 0;
    let pendingUrinationCount = 0;

    for (const env of pendingForDate) {
      if (env.op === "record_food") {
        pendingMealCount += 1;
        const cal = env.payload.calories ?? env.payload.kilocalories;
        if (typeof cal === "number" && Number.isFinite(cal)) {
          pendingCalories += cal;
        } else {
          pendingUnknownCalories += 1;
        }
      } else if (env.op === "record_skin") {
        pendingSkinCount += 1;
      } else if (env.op === "record_toilet") {
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
    const totalBowel = committedBowel + pendingBowelCount;
    const totalUrination = committedUrination + pendingUrinationCount;

    const optimisticTotals = {
      totalCalories: Math.round(((committedDay?.totalCalories ?? 0) + pendingCalories) * 10) / 10,
      unknownCaloriesCount: (committedDay?.unknownCaloriesCount ?? 0) + pendingUnknownCalories,
      mealCount: (committedDay?.mealCount ?? 0) + pendingMealCount,
      skinCount: (committedDay?.skinCount ?? 0) + pendingSkinCount,
      bowelCount: totalBowel,
      urinationCount: totalUrination,
      toiletCount: committedToilet + pendingBowelCount + pendingUrinationCount
    };

    return {
      generatedAt: summary.generatedAt ?? null,
      targetDate,
      committedDay,
      availableDays: summary.days?.map((day) => day.date) ?? [],
      catalog,
      optimisticOverlay: {
        pendingInboxCount: pendingForDate.length,
        optimisticTotals,
        pendingRequests: pendingForDate.map((env) => ({
          requestId: env.requestId,
          op: env.op,
          createdAt: env.createdAt,
          payload: env.payload
        }))
      }
    };
  }

  private async enqueueEnvelope(
    app: AgentAppID,
    op: string,
    requestId: string,
    client: string | undefined,
    payload: Record<string, unknown>
  ): Promise<EnqueueResult> {
    const createdAt = new Date().toISOString();
    const envelope: InboxEnvelope = {
      schemaVersion: SCHEMA_VERSION,
      requestId,
      app,
      op,
      createdAt,
      source: {
        client: client ?? "chaox-agent-mcp"
      },
      payload
    };

    const millis = String(Date.now()).padStart(13, "0");
    const safeId = sanitizedFilenameComponent(requestId);
    const fileName = `${millis}_${safeId}.json`;
    const inboxFile = path.join(this.appDir(app), "inbox", fileName);
    await writeFileAtomic(inboxFile, `${JSON.stringify(envelope, null, 2)}\n`);

    return {
      queued: true,
      app,
      op,
      requestId,
      inboxFile,
      createdAt,
      normalizedPayload: payload,
      note: `Queued in ${app}/inbox/${fileName}. ${app.toUpperCase()} will apply it automatically when active on device (or via Sync Now in Settings).`
    };
  }

  private async validateSxPayload(
    input: {
      amount: number;
      projectName: string;
      currency?: string;
      tags?: string[];
      note?: string;
      notes?: string;
      date?: string;
      hour?: number | string;
      requestId?: string;
    },
    mode: "expense" | "income"
  ): Promise<Record<string, unknown>> {
    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      throw new Error("SX amount must be a finite number greater than 0.");
    }

    const rawProject = input.projectName?.trim();
    if (!rawProject) {
      throw new Error("SX projectName is required and must not be empty.");
    }

    const catalog = await readJsonIfExists<SxCatalog>(path.join(this.appDir("sx"), "catalog.json"));
    const normalizedCurrency = input.currency?.trim().toUpperCase();
    if (normalizedCurrency !== undefined && normalizedCurrency.length > 0) {
      if (!/^[A-Z]{3}$/.test(normalizedCurrency)) {
        throw new Error(
          `Invalid ISO currency code '${input.currency}'. Expected 3 uppercase ASCII letters such as CNY or USD.`
        );
      }
      if (catalog?.supportedCurrencies?.length) {
        const allowed = new Set(catalog.supportedCurrencies.map((c) => c.toUpperCase()));
        if (!allowed.has(normalizedCurrency)) {
          throw new Error(
            `Unsupported currency '${normalizedCurrency}'. Supported currencies in sx/catalog.json: ${catalog.supportedCurrencies.join(", ")}`
          );
        }
      }
    }

    let normalizedProject = rawProject;
    if (catalog?.projects?.length) {
      const match = catalog.projects.find(
        (proj) => proj.name.trim().toLowerCase() === rawProject.toLowerCase()
      );
      if (!match) {
        const names = catalog.projects.map((proj) => proj.name).join(", ");
        throw new Error(
          `Unknown projectName '${rawProject}'. Known projects in sx/catalog.json: ${names}`
        );
      }
      if (mode === "expense" && match.supportsExpense === false) {
        throw new Error(`Project '${match.name}' does not support expense records.`);
      }
      if (mode === "income" && match.supportsIncome === false) {
        throw new Error(`Project '${match.name}' does not support income records.`);
      }
      normalizedProject = match.name;
    }

    const isoDate = resolveSxTimestamp(input.date, "date", {
      timeZone: catalog?.timeZoneIdentifier,
      hour: mode === "expense" ? input.hour : undefined,
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
    return payload;
  }

  async recordSxExpense(input: RecordSxExpenseInput): Promise<EnqueueResult> {
    await this.assertWriteAllowed("sx");
    const payload = await this.validateSxPayload(input, "expense");
    const requestId = input.requestId?.trim() || generateRequestId("sx-exp");
    payload.stableID = `sx:mcp:${requestId}`;
    return this.enqueueEnvelope("sx", "record_expense", requestId, input.client, payload);
  }

  async recordSxIncome(input: RecordSxIncomeInput): Promise<EnqueueResult> {
    await this.assertWriteAllowed("sx");
    const payload = await this.validateSxPayload(input, "income");
    const requestId = input.requestId?.trim() || generateRequestId("sx-inc");
    payload.stableID = `sx:mcp:${requestId}`;
    return this.enqueueEnvelope("sx", "record_income", requestId, input.client, payload);
  }

  async recordBxFood(input: RecordBxFoodInput): Promise<EnqueueResult> {
    await this.assertWriteAllowed("bx");
    const name = input.name.trim();
    if (!name) {
      throw new Error("BX food 'name' must not be empty.");
    }

    if (input.calories !== undefined) {
      if (!Number.isFinite(input.calories) || input.calories < 0) {
        throw new Error("BX food 'calories' must be >= 0 when provided.");
      }
    }

    if (input.mealType !== undefined && !VALID_MEAL_TYPES.has(input.mealType)) {
      throw new Error(
        `Invalid mealType '${input.mealType}'. Allowed: breakfast, lunch, dinner, snack.`
      );
    }

    const catalog = await readJsonIfExists<BxCatalog>(path.join(this.appDir("bx"), "catalog.json"));
    if (
      input.mealType !== undefined &&
      catalog?.mealTypes?.length &&
      !catalog.mealTypes.includes(input.mealType)
    ) {
      throw new Error(`mealType '${input.mealType}' is not listed in bx/catalog.json.`);
    }

    const payload: Record<string, unknown> = { name };
    if (input.mealType !== undefined) payload.mealType = input.mealType;
    if (input.calories !== undefined) payload.calories = Math.round(input.calories * 10) / 10;
    const recordedAt = validateIsoTimestamp(input.recordedAt, "recordedAt");
    if (recordedAt) payload.recordedAt = recordedAt;

    const requestId = input.requestId?.trim() || generateRequestId("bx-food");
    payload.stableID = `bx:mcp:${requestId}`;
    return this.enqueueEnvelope("bx", "record_food", requestId, input.client, payload);
  }

  async recordBxSkin(input: RecordBxSkinInput): Promise<EnqueueResult> {
    await this.assertWriteAllowed("bx");
    if (!VALID_SKIN_PRODUCTS.has(input.product)) {
      throw new Error(
        `Invalid product '${input.product}'. Allowed: sunscreen, moisturizer, bodyLotion, medicine, other.`
      );
    }

    const catalog = await readJsonIfExists<BxCatalog>(path.join(this.appDir("bx"), "catalog.json"));
    if (catalog?.skinProducts?.length && !catalog.skinProducts.includes(input.product)) {
      throw new Error(`product '${input.product}' is not listed in bx/catalog.json.`);
    }

    const payload: Record<string, unknown> = {
      product: input.product
    };
    const resolvedName = input.name?.trim() || input.brand?.trim();
    if (resolvedName) payload.name = resolvedName;
    const recordedAt = validateIsoTimestamp(input.recordedAt, "recordedAt");
    if (recordedAt) payload.recordedAt = recordedAt;

    const requestId = input.requestId?.trim() || generateRequestId("bx-skin");
    payload.stableID = `bx:mcp:${requestId}`;
    return this.enqueueEnvelope("bx", "record_skin", requestId, input.client, payload);
  }

  async recordBxToilet(input: RecordBxToiletInput): Promise<EnqueueResult> {
    await this.assertWriteAllowed("bx");
    const kind = input.kind ?? "bowel";
    if (!VALID_TOILET_KINDS.has(kind)) {
      throw new Error(`Invalid BX toilet 'kind': ${kind}. Allowed: bowel, urination.`);
    }

    const rawStoolType = input.stoolType ?? input.bristol;
    if (kind === "bowel") {
      if (
        rawStoolType === undefined ||
        !Number.isInteger(rawStoolType) ||
        rawStoolType < 1 ||
        rawStoolType > 7
      ) {
        throw new Error(
          "BX bowel events require 'stoolType' (integer Bristol scale 1..7)."
        );
      }
    } else if (rawStoolType !== undefined) {
      throw new Error("BX urination events must not specify 'stoolType'.");
    }

    const payload: Record<string, unknown> = { kind };
    if (rawStoolType !== undefined) payload.stoolType = rawStoolType;
    if (input.note?.trim()) payload.note = input.note.trim();
    const recordedAt = validateIsoTimestamp(input.recordedAt, "recordedAt");
    if (recordedAt) payload.recordedAt = recordedAt;

    const requestId = input.requestId?.trim() || generateRequestId("bx-toilet");
    payload.stableID = `bx:mcp:${requestId}`;
    return this.enqueueEnvelope("bx", "record_toilet", requestId, input.client, payload);
  }
}
