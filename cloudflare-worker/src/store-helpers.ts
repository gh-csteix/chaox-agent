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
