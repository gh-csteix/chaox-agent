import {
  AgentAppID,
  InboxEnvelope,
  PermissionPolicy,
  PermissionTier,
  Receipt
} from "./types.js";

export const VALID_APPS = new Set<AgentAppID>(["sx", "bx", "gx", "csteix"]);
export const VALID_PERMISSIONS = new Set<PermissionTier>(["disabled", "readOnly", "appendOnly", "readWrite"]);
export const DEFAULT_BX_DOMAINS = ["sleep", "workouts", "food", "skin", "toilet"] as const;
export const DEFAULT_SX_DOMAINS = ["projects", "expenses", "incomes", "tags", "slogans"] as const;
export const DEFAULT_CSTEIX_DOMAINS = ["wuxu", "dwell", "meditation", "marks"] as const;

export interface AppStateRow {
  app: string;
  bundle_id: string;
  app_version: string;
  permission: string;
  policy_json: string | null;
  capabilities_json: string;
  catalog_json: string | null;
  summary_json: string | null;
  last_sync_at: string | null;
  updated_at: string;
}

export interface AppDatasetRow {
  app: string;
  domain: string;
  payload_json: string;
  record_count: number;
  updated_at: string;
}

export interface InboxRow {
  request_id: string;
  app: string;
  op: string;
  schema_version: string;
  created_at: string;
  source_json: string | null;
  payload_json: string;
}

export interface ReceiptRow {
  request_id: string;
  app: string;
  op: string;
  schema_version: string;
  status: string;
  processed_at: string;
  record_id: string | null;
  stable_id: string | null;
  summary: string | null;
  details_json: string | null;
  error_code: string | null;
  error_message: string | null;
}

export function defaultDomainsForApp(app: AgentAppID): string[] {
  if (app === "bx") return [...DEFAULT_BX_DOMAINS];
  if (app === "sx") return [...DEFAULT_SX_DOMAINS];
  if (app === "csteix") return [...DEFAULT_CSTEIX_DOMAINS];
  return [];
}

export function derivePolicyFromTier(
  tier: string,
  app: AgentAppID,
  consentAcknowledged = true
): PermissionPolicy {
  const allowedDomains = defaultDomainsForApp(app);
  switch (tier) {
    case "readOnly":
      return {
        allowRead: true,
        allowCreate: false,
        allowUpdate: false,
        allowDelete: false,
        allowedDomains,
        consentAcknowledged
      };
    case "appendOnly":
      return {
        allowRead: true,
        allowCreate: true,
        allowUpdate: false,
        allowDelete: false,
        allowedDomains,
        consentAcknowledged
      };
    case "readWrite":
      return {
        allowRead: true,
        allowCreate: true,
        allowUpdate: true,
        allowDelete: false,
        allowedDomains,
        consentAcknowledged
      };
    default:
      return {
        allowRead: false,
        allowCreate: false,
        allowUpdate: false,
        allowDelete: false,
        allowedDomains,
        consentAcknowledged
      };
  }
}

export function parsePolicyFromRow(row: AppStateRow): PermissionPolicy {
  const parsed = safeJsonParse<Partial<PermissionPolicy>>(row.policy_json);
  const app = row.app as AgentAppID;
  if (!parsed) {
    return derivePolicyFromTier(row.permission, app, true);
  }
  return {
    allowRead: Boolean(parsed.allowRead),
    allowCreate: Boolean(parsed.allowCreate),
    allowUpdate: Boolean(parsed.allowUpdate),
    allowDelete: Boolean(parsed.allowDelete),
    allowedDomains: Array.isArray(parsed.allowedDomains)
      ? parsed.allowedDomains.map(String)
      : defaultDomainsForApp(app),
    consentAcknowledged: parsed.consentAcknowledged ?? true,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined
  };
}

export function safeJsonParse<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function effectiveTimeZone(timeZoneIdentifier?: string): string {
  const tz = timeZoneIdentifier?.trim();
  if (tz) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return tz;
    } catch {
      // Fall back to UTC if the supplied timezone identifier is invalid.
    }
  }
  return "UTC";
}

export function zonedLocalToUtcIso(
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
    const represented = partsMs(guess);
    const diff = represented - targetUtcMs;
    if (diff === 0) break;
    guess -= diff;
  }

  // Validate that the requested calendar date/time actually existed (e.g. reject Feb 30 or hour 25).
  const checkDate = new Date(Date.UTC(year, month - 1, day, hour, minute, second, 0));
  if (
    checkDate.getUTCFullYear() !== year ||
    checkDate.getUTCMonth() !== month - 1 ||
    checkDate.getUTCDate() !== day ||
    checkDate.getUTCHours() !== hour ||
    checkDate.getUTCMinutes() !== minute ||
    checkDate.getUTCSeconds() !== second
  ) {
    throw new Error(
      `Invalid calendar timestamp: ${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
    );
  }

  return new Date(guess).toISOString();
}

export function localDateHourParts(
  timestampIso: string | undefined,
  timeZoneIdentifier?: string
): { localDate: string; localHour: number; displayDate: string } | null {
  const trimmed = timestampIso?.trim() ?? "";
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) return null;

  const tz = effectiveTimeZone(timeZoneIdentifier);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(ms));
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  if (!map.year || !map.month || !map.day || map.hour === undefined) return null;
  const localHour = Number(map.hour) === 24 ? 0 : Number(map.hour);
  const localDate = `${map.year}-${map.month}-${map.day}`;
  return {
    localDate,
    localHour,
    displayDate: `${localDate}-${String(localHour).padStart(2, "0")}`
  };
}

export function validateLocalHour(raw: unknown, fieldName = "hour"): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw < 0 || raw > 23) {
      throw new Error(
        `'${fieldName}' must be an integer between 0 and 23 (24-hour local clock in SX time zone).`
      );
    }
    return raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (/^\d{1,2}$/.test(trimmed)) {
      const parsed = Number(trimmed);
      if (parsed >= 0 && parsed <= 23) {
        return parsed;
      }
    }
  }
  throw new Error(
    `'${fieldName}' must be an integer between 0 and 23 (24-hour local clock in SX time zone).`
  );
}

export function resolveSxTimestamp(
  rawDate: unknown,
  fieldName: string,
  options: {
    timeZone?: string;
    hour?: unknown;
    defaultLocalHour?: number;
    allowHourOnly?: boolean;
    now?: Date;
  } = {}
): string | undefined {
  const explicitHour = validateLocalHour(options.hour);
  const tz = effectiveTimeZone(options.timeZone);

  if (rawDate === undefined || rawDate === null || (typeof rawDate === "string" && !rawDate.trim())) {
    if (explicitHour !== undefined && options.allowHourOnly) {
      const todayParts = localDateHourParts((options.now ?? new Date()).toISOString(), tz);
      if (!todayParts) return undefined;
      const [y, m, d] = todayParts.localDate.split("-").map(Number);
      return zonedLocalToUtcIso(y, m, d, explicitHour, 0, 0, tz);
    }
    return undefined;
  }

  if (typeof rawDate !== "string") {
    throw new Error(
      `Invalid '${fieldName}'. Expected ISO-8601 ('2026-11-22T12:00:00+08:00'), SX display format ('2026-11-22-12'), or 'YYYY-MM-DD'.`
    );
  }

  const trimmed = rawDate.trim();

  // Case A: SX display date+hour formats: YYYY-MM-DD-HH, YYYY-MM-DD HH, or YYYY-MM-DDTHH.
  const displayMatch = /^(\d{4})-(\d{2})-(\d{2})[-T ](\d{2})$/.exec(trimmed);
  if (displayMatch) {
    const year = Number(displayMatch[1]);
    const month = Number(displayMatch[2]);
    const day = Number(displayMatch[3]);
    const parsedHour = Number(displayMatch[4]);
    if (parsedHour < 0 || parsedHour > 23) {
      throw new Error(
        `Invalid local hour '${displayMatch[4]}' in '${fieldName}': ${rawDate}. Expected 00-23.`
      );
    }
    return zonedLocalToUtcIso(year, month, day, explicitHour ?? parsedHour, 0, 0, tz);
  }

  // Case B: Bare calendar date YYYY-MM-DD -> local midnight (or explicit hour) in SX time zone.
  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnlyMatch) {
    const year = Number(dateOnlyMatch[1]);
    const month = Number(dateOnlyMatch[2]);
    const day = Number(dateOnlyMatch[3]);
    return zonedLocalToUtcIso(year, month, day, explicitHour ?? options.defaultLocalHour ?? 0, 0, 0, tz);
  }

  // Case C: Local date-time without timezone suffix (YYYY-MM-DD HH:mm[:ss]) -> interpret in SX time zone.
  const localDateTimeMatch = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/.exec(
    trimmed
  );
  if (localDateTimeMatch) {
    const year = Number(localDateTimeMatch[1]);
    const month = Number(localDateTimeMatch[2]);
    const day = Number(localDateTimeMatch[3]);
    const parsedHour = Number(localDateTimeMatch[4]);
    const minute = Number(localDateTimeMatch[5]);
    const second = localDateTimeMatch[6] !== undefined ? Number(localDateTimeMatch[6]) : 0;
    const validatedIso = zonedLocalToUtcIso(year, month, day, parsedHour, minute, second, tz);
    if (explicitHour !== undefined) {
      return zonedLocalToUtcIso(year, month, day, explicitHour, 0, 0, tz);
    }
    return validatedIso;
  }

  // Case D: Full ISO-8601 with explicit offset or Z.
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `Invalid '${fieldName}': ${rawDate}. Accepted formats: '2026-11-22T12:00:00+08:00', '2026-11-22-12', or '2026-11-22' (optionally with 'hour' 0..23).`
    );
  }
  const iso = new Date(parsed).toISOString();
  if (explicitHour !== undefined) {
    const parts = localDateHourParts(iso, tz);
    if (parts) {
      const [y, m, d] = parts.localDate.split("-").map(Number);
      return zonedLocalToUtcIso(y, m, d, explicitHour, 0, 0, tz);
    }
  }
  return iso;
}

export function validateIsoTimestamp(raw: unknown, fieldName: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new Error(`Invalid ISO-8601 date/time for '${fieldName}'.`);
  }
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return `${trimmed}T12:00:00.000Z`;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid ISO-8601 date/time for '${fieldName}': ${raw}`);
  }
  return new Date(parsed).toISOString();
}

export function requireNonEmptyString(raw: unknown, fieldName: string): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error(`'${fieldName}' is required and must be a non-empty string.`);
  }
  return raw.trim();
}

export function dateKeyInUtcCalendar(dateInput: Date): string {
  const year = dateInput.getUTCFullYear();
  const month = String(dateInput.getUTCMonth() + 1).padStart(2, "0");
  const day = String(dateInput.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function generateRequestId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function mapInboxRow(row: InboxRow): InboxEnvelope {
  return {
    schemaVersion: row.schema_version,
    requestId: row.request_id,
    app: row.app as AgentAppID,
    op: row.op,
    createdAt: row.created_at,
    source: safeJsonParse(row.source_json) ?? undefined,
    payload: safeJsonParse<Record<string, unknown>>(row.payload_json) ?? {}
  };
}

export function mapReceiptRow(row: ReceiptRow): Receipt {
  return {
    schemaVersion: row.schema_version,
    requestId: row.request_id,
    app: row.app as AgentAppID,
    op: row.op,
    status: row.status as Receipt["status"],
    processedAt: row.processed_at,
    ...(row.record_id ? { recordId: row.record_id } : {}),
    ...(row.stable_id ? { stableId: row.stable_id } : {}),
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.details_json ? { details: safeJsonParse<Record<string, unknown>>(row.details_json) ?? undefined } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {})
  };
}

/**
 * Resolve a YYYY-MM-DD calendar date key for an ISO timestamp in the device's IANA time zone.
 * Falls back to the UTC calendar date when `timeZoneIdentifier` is absent or invalid.
 */
export function localDateKey(timestampIso: string | undefined, timeZoneIdentifier?: string): string {
  const trimmed = timestampIso?.trim() ?? "";
  if (!trimmed) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) return trimmed.slice(0, 10);

  const date = new Date(ms);
  const tz = timeZoneIdentifier?.trim();
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).formatToParts(date);
      const year = parts.find((part) => part.type === "year")?.value;
      const month = parts.find((part) => part.type === "month")?.value;
      const day = parts.find((part) => part.type === "day")?.value;
      if (year && month && day) {
        return `${year}-${month}-${day}`;
      }
    } catch {
      // Invalid time zone identifier falls back to UTC calendar day.
    }
  }
  return date.toISOString().slice(0, 10);
}

export function matchesDateRange(
  timestampIso: string | undefined,
  from?: string,
  to?: string,
  localDate?: string,
  timeZoneIdentifier?: string
): boolean {
  if (!from && !to) return true;
  if (!timestampIso && !localDate) return false;

  const dayKey = localDate?.trim() || localDateKey(timestampIso, timeZoneIdentifier);
  if (from) {
    const trimmed = from.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      if (dayKey < trimmed) return false;
    } else if (timestampIso) {
      const fromMs = Date.parse(trimmed);
      const tsMs = Date.parse(timestampIso);
      if (!Number.isNaN(fromMs) && !Number.isNaN(tsMs) && tsMs < fromMs) return false;
    }
  }
  if (to) {
    const trimmed = to.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      if (dayKey > trimmed) return false;
    } else if (timestampIso) {
      const toMs = Date.parse(trimmed);
      const tsMs = Date.parse(timestampIso);
      if (!Number.isNaN(toMs) && !Number.isNaN(tsMs) && tsMs > toMs) return false;
    }
  }
  return true;
}

export function normalizePagination(options: { limit?: number; offset?: number }): {
  limit: number;
  offset: number;
} {
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 50), 200));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  return { limit, offset };
}

export function paginate<T>(items: T[], limit: number, offset: number): {
  items: T[];
  totalCount: number;
  returnedCount: number;
  hasMore: boolean;
  offset: number;
  limit: number;
} {
  const totalCount = items.length;
  const sliced = items.slice(offset, offset + limit);
  return {
    items: sliced,
    totalCount,
    returnedCount: sliced.length,
    hasMore: offset + sliced.length < totalCount,
    offset,
    limit
  };
}

export function matchesQuery(query: string | undefined, fields: Array<string | undefined | null>): boolean {
  const q = query?.trim().toLowerCase();
  if (!q) return true;
  return fields.some((field) => typeof field === "string" && field.toLowerCase().includes(q));
}
