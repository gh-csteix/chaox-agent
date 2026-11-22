import {
  AppStateRow,
  extractChangedRows,
  generateRequestId,
  localDateKey,
  mapReceiptRow,
  matchesDateRange,
  matchesQuery,
  normalizePagination,
  paginate,
  ReceiptRow,
  requireNonEmptyString,
  safeJsonParse,
  zonedLocalToUtcIso
} from "./store-helpers.js";
import {
  AgentAppID,
  CsteixDimension,
  CsteixDwellRecord,
  CsteixMarkRecord,
  CsteixMeditationRecord,
  CsteixWuxuArticle,
  CsteixWuxuImportItem,
  CsteixWuxuSummaryItem,
  PermissionAction,
  PermissionPolicy,
  Receipt,
  SCHEMA_VERSION,
  SqlDatabase,
  SqlPreparedStatement
} from "./types.js";

export const VALID_CSTEIX_DIMENSIONS: readonly CsteixDimension[] = [
  "chaos",
  "spacetime",
  "existence",
  "ix"
];

const DIMENSION_ALIASES: Record<string, CsteixDimension> = {
  chaos: "chaos",
  "混沌": "chaos",
  spacetime: "spacetime",
  "空时": "spacetime",
  existence: "existence",
  "存在": "existence",
  ix: "ix",
  "i-seek": "ix",
  "我求": "ix"
};

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TRASH_RETENTION_DAYS = 30;
const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;

const PLACE_KEYS = new Set([
  "place",
  "places",
  "placeName",
  "placeNames",
  "placeKey",
  "placeKeys",
  "spot",
  "spots",
  "spotName",
  "spotNames",
  "hourPlaces",
  "location",
  "locationName",
  "district",
  "city",
  "locality",
  "coordinates",
  "latitude",
  "longitude"
]);

export interface CsteixWuxuRow {
  id: string;
  slug: string;
  title: string;
  title_en: string | null;
  dimensions_json: string;
  written_at: string;
  timezone: string;
  body_zh: string;
  body_en: string | null;
  raw_notes: string | null;
  revision: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CsteixStoreContext {
  getDatabase(): SqlDatabase;
  assertReadAccess(app: AgentAppID): Promise<{ row: AppStateRow | null; policy: PermissionPolicy | null }>;
  assertDomainReadAllowed(app: AgentAppID, domain: string): Promise<void>;
  assertActionAllowed(app: AgentAppID, action: PermissionAction, domain: string): Promise<AppStateRow>;
  readDataset<T>(app: AgentAppID, domain: string): Promise<T[] | null>;
}

function normalizeSlug(raw: unknown): string {
  const value = requireNonEmptyString(raw, "slug");
  if (value.length > 120 || !SLUG_PATTERN.test(value)) {
    throw new Error(
      `Invalid slug '${value}'. Slugs must be lowercase kebab-case ASCII (e.g. 'bare-treetops').`
    );
  }
  return value;
}

function normalizeSingleDimension(raw: string): CsteixDimension | null {
  const key = raw.trim().toLowerCase();
  if (!key) return null;
  return DIMENSION_ALIASES[key] ?? DIMENSION_ALIASES[raw.trim()] ?? null;
}

function normalizeDimensions(raw: unknown): CsteixDimension[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      "'dimensions' must be a non-empty array chosen from ['chaos', 'spacetime', 'existence', 'ix']."
    );
  }
  const matched = new Set<CsteixDimension>();
  for (const item of raw) {
    if (typeof item !== "string") {
      throw new Error("Each entry in 'dimensions' must be a string.");
    }
    const normalized = normalizeSingleDimension(item);
    if (!normalized) {
      throw new Error(
        `Invalid dimension '${item}'. Allowed: chaos, spacetime, existence, ix.`
      );
    }
    matched.add(normalized);
  }
  if (matched.size === 0) {
    throw new Error("'dimensions' must include at least one valid dimension.");
  }
  return VALID_CSTEIX_DIMENSIONS.filter((dim) => matched.has(dim));
}

function normalizeTimezone(raw: unknown): string {
  if (raw === undefined || raw === null) return "Asia/Shanghai";
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("'timezone' must be a valid IANA timezone identifier (e.g. 'Asia/Shanghai').");
  }
  const tz = raw.trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new Error(`Invalid IANA timezone '${tz}'.`);
  }
  return tz;
}

export function normalizeWrittenAt(raw: unknown, timezone: string): string {
  if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) {
    const now = new Date();
    now.setUTCSeconds(0, 0);
    return now.toISOString();
  }
  if (typeof raw !== "string") {
    throw new Error("'writtenAt' must be an ISO-8601 timestamp string.");
  }
  const trimmed = raw.trim();

  // Local date-time without explicit offset: interpret in article's timezone.
  const localMatch = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(trimmed);
  if (localMatch) {
    const year = Number(localMatch[1]);
    const month = Number(localMatch[2]);
    const day = Number(localMatch[3]);
    const hour = localMatch[4] !== undefined ? Number(localMatch[4]) : 12;
    const minute = localMatch[5] !== undefined ? Number(localMatch[5]) : 0;
    const second = localMatch[6] !== undefined ? Number(localMatch[6]) : 0;
    return zonedLocalToUtcIso(year, month, day, hour, minute, second, timezone);
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid ISO-8601 date/time for 'writtenAt': ${raw}`);
  }
  return new Date(parsed).toISOString();
}

export function localDateKeyInTimezone(isoTimestamp: string, timezone: string): string {
  return localDateKey(isoTimestamp, timezone || "Asia/Shanghai");
}

function cleanMarkdownLine(text: string): string {
  return text
    .replace(/^[-*+]\s+/, "")
    .replace(/^>\s*/, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

export function extractHeadings(markdown: string): string[] {
  return markdown
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3).trim())
    .filter((heading) => heading.length > 0);
}

export function extractLeavingLines(markdown: string): string[] {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const zhMatch = /(?:^|\n)##\s*留下来的几句[^\n]*\n([\s\S]*?)(?=\n##\s|$)/.exec(normalized);
  const enMatch = zhMatch
    ? null
    : /(?:^|\n)##\s*(?:Lines that stayed|Leaving lines|Lines left behind)[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i.exec(
        normalized
      );
  const section = zhMatch?.[1] ?? enMatch?.[1];
  if (!section) return [];
  return section
    .split("\n")
    .map(cleanMarkdownLine)
    .filter((line) => line.length > 0);
}

export function stripPlaceFields<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripPlaceFields(item)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (PLACE_KEYS.has(key)) continue;
      out[key] = stripPlaceFields(val);
    }
    return out as T;
  }
  return value;
}

type CsteixWuxuMetaRow = Pick<
  CsteixWuxuRow,
  | "id"
  | "slug"
  | "title"
  | "title_en"
  | "dimensions_json"
  | "written_at"
  | "timezone"
  | "revision"
  | "deleted_at"
  | "created_at"
  | "updated_at"
> & {
  has_english?: number;
  has_raw_notes?: number;
};

function parseDimensionsJson(dimensionsJson: string): CsteixDimension[] {
  const parsedDims = safeJsonParse<string[]>(dimensionsJson) ?? [];
  const dimensions = parsedDims
    .map((dim) => normalizeSingleDimension(dim))
    .filter((dim): dim is CsteixDimension => dim !== null);
  return dimensions.length > 0 ? dimensions : ["existence"];
}

function escapeSqlLike(term: string): string {
  return term.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function mapWuxuRow(row: CsteixWuxuRow): CsteixWuxuArticle {
  const parsedDims = safeJsonParse<string[]>(row.dimensions_json) ?? [];
  const dimensions = parsedDims
    .map((dim) => normalizeSingleDimension(dim))
    .filter((dim): dim is CsteixDimension => dim !== null);
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    titleEn: row.title_en ?? null,
    dimensions: dimensions.length > 0 ? dimensions : ["existence"],
    writtenAt: row.written_at,
    timezone: row.timezone,
    bodyZh: row.body_zh,
    bodyEn: row.body_en ?? null,
    rawNotes: row.raw_notes ?? null,
    revision: row.revision,
    deletedAt: row.deleted_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toSummaryItem(article: CsteixWuxuArticle, includeBody: boolean): CsteixWuxuSummaryItem {
  const headings = extractHeadings(article.bodyZh);
  const headingsEn = article.bodyEn ? extractHeadings(article.bodyEn) : undefined;
  const leavingLines = extractLeavingLines(article.bodyZh);
  const summary: CsteixWuxuSummaryItem = {
    id: article.id,
    slug: article.slug,
    title: article.title,
    titleEn: article.titleEn ?? null,
    dimensions: article.dimensions,
    writtenAt: article.writtenAt,
    localDate: localDateKeyInTimezone(article.writtenAt, article.timezone),
    timezone: article.timezone,
    hasEnglish: Boolean(article.bodyEn && article.bodyEn.trim().length > 0),
    hasRawNotes: Boolean(article.rawNotes && article.rawNotes.trim().length > 0),
    headings,
    ...(headingsEn && headingsEn.length > 0 ? { headingsEn } : {}),
    leavingLines,
    revision: article.revision,
    deletedAt: article.deletedAt ?? null,
    createdAt: article.createdAt,
    updatedAt: article.updatedAt
  };
  if (includeBody) {
    summary.bodyZh = article.bodyZh;
    summary.bodyEn = article.bodyEn ?? null;
    summary.rawNotes = article.rawNotes ?? null;
  }
  return summary;
}

function normalizeOptionalNullableString(raw: string | null | undefined): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function recordDateInfo(rec: Record<string, unknown>): { iso?: string; localDate?: string } {
  const iso = [rec.startedAt, rec.occurredAt, rec.recordedAt, rec.createdAt, rec.endedAt].find(
    (v): v is string => typeof v === "string" && v.trim().length > 0
  );
  const localDate = [rec.dayKey, rec.day, rec.date].find(
    (v): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())
  );
  return { iso, localDate };
}

function recordSortKey(rec: Record<string, unknown>): string {
  const { iso, localDate } = recordDateInfo(rec);
  return iso ?? localDate ?? "";
}

function normalizePillarFilter(raw: string): string {
  const dim = normalizeSingleDimension(raw);
  return dim ?? raw.trim().toLowerCase();
}

function recordMatchesPillar(rec: Record<string, unknown>, targetPillar: string): boolean {
  const direct = [rec.pillar, rec.dimension, rec.page]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => normalizePillarFilter(v));
  if (direct.includes(targetPillar)) return true;

  for (const mapKey of ["totals", "byPillar"] as const) {
    const mapVal = rec[mapKey];
    if (mapVal && typeof mapVal === "object" && !Array.isArray(mapVal)) {
      for (const [k, v] of Object.entries(mapVal as Record<string, unknown>)) {
        if (normalizePillarFilter(k) === targetPillar && typeof v === "number" && v > 0) {
          return true;
        }
      }
    }
  }
  return false;
}

function extractDurationSeconds(rec: Record<string, unknown>): number {
  if (typeof rec.durationSeconds === "number" && Number.isFinite(rec.durationSeconds)) {
    return rec.durationSeconds;
  }
  if (typeof rec.seconds === "number" && Number.isFinite(rec.seconds)) {
    return rec.seconds;
  }
  if (typeof rec.durationMinutes === "number" && Number.isFinite(rec.durationMinutes)) {
    return rec.durationMinutes * 60;
  }
  for (const mapKey of ["totals", "byPillar"] as const) {
    const mapVal = rec[mapKey];
    if (mapVal && typeof mapVal === "object" && !Array.isArray(mapVal)) {
      let sum = 0;
      for (const v of Object.values(mapVal as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v)) sum += v;
      }
      if (sum > 0) return sum;
    }
  }
  return 0;
}

function accumulateDurationByPillar(
  records: Array<Record<string, unknown>>
): { totalSeconds: number; byPillar: Record<string, number> } {
  let totalSeconds = 0;
  const byPillar: Record<string, number> = {};

  for (const rec of records) {
    const directPillar = [rec.pillar, rec.dimension, rec.page].find(
      (v): v is string => typeof v === "string" && v.trim().length > 0
    );
    const directSeconds =
      typeof rec.durationSeconds === "number" && Number.isFinite(rec.durationSeconds)
        ? rec.durationSeconds
        : typeof rec.seconds === "number" && Number.isFinite(rec.seconds)
          ? rec.seconds
          : typeof rec.durationMinutes === "number" && Number.isFinite(rec.durationMinutes)
            ? rec.durationMinutes * 60
            : null;

    if (directPillar && directSeconds !== null) {
      const key = normalizePillarFilter(directPillar);
      byPillar[key] = Math.round(((byPillar[key] ?? 0) + directSeconds) * 10) / 10;
      totalSeconds += directSeconds;
      continue;
    }

    let addedFromMap = false;
    for (const mapKey of ["totals", "byPillar"] as const) {
      const mapVal = rec[mapKey];
      if (mapVal && typeof mapVal === "object" && !Array.isArray(mapVal)) {
        for (const [k, v] of Object.entries(mapVal as Record<string, unknown>)) {
          if (typeof v === "number" && Number.isFinite(v) && v > 0) {
            const key = normalizePillarFilter(k);
            byPillar[key] = Math.round(((byPillar[key] ?? 0) + v) * 10) / 10;
            totalSeconds += v;
            addedFromMap = true;
          }
        }
        if (addedFromMap) break;
      }
    }

    if (!addedFromMap) {
      totalSeconds += extractDurationSeconds(rec);
    }
  }

  return {
    totalSeconds: Math.round(totalSeconds * 10) / 10,
    byPillar
  };
}

export class CsteixOperations {
  constructor(private readonly ctx: CsteixStoreContext) {}

  private get db(): SqlDatabase {
    return this.ctx.getDatabase();
  }

  private async getAllowedDomainsSet(): Promise<{
    row: AppStateRow;
    policy: PermissionPolicy;
    allowedSet: Set<string>;
  }> {
    const { row, policy } = await this.ctx.assertReadAccess("csteix");
    if (!row || !policy) {
      throw new Error(
        "App 'csteix' has not synced to this CHAOX Agent server yet. Open CSTEIX Settings -> AI Assistant and connect first."
      );
    }
    return {
      row,
      policy,
      allowedSet: new Set(policy.allowedDomains)
    };
  }

  private async findArticleByIdOrSlug(id?: string, slug?: string): Promise<CsteixWuxuRow | null> {
    const cleanId = id?.trim();
    const cleanSlug = slug?.trim();
    if (!cleanId && !cleanSlug) {
      throw new Error("Either 'id' or 'slug' is required.");
    }
    if (cleanId) {
      return this.db.prepare("SELECT * FROM csteix_wuxu WHERE id = ?").bind(cleanId).first<CsteixWuxuRow>();
    }
    return this.db.prepare("SELECT * FROM csteix_wuxu WHERE slug = ?").bind(cleanSlug!).first<CsteixWuxuRow>();
  }

  private async lookupExistingReceipt(requestId: string): Promise<Receipt | null> {
    const row = await this.db
      .prepare("SELECT * FROM receipts WHERE request_id = ?")
      .bind(requestId)
      .first<ReceiptRow>();
    return row ? mapReceiptRow(row) : null;
  }

  private makeAppliedReceiptStatement(receipt: Receipt): SqlPreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO receipts (
          request_id, app, op, schema_version, status, processed_at,
          record_id, stable_id, summary, details_json, error_code, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        receipt.requestId,
        receipt.app,
        receipt.op,
        receipt.schemaVersion,
        receipt.status,
        receipt.processedAt,
        receipt.recordId ?? null,
        receipt.stableId ?? null,
        receipt.summary ?? null,
        receipt.details ? JSON.stringify(receipt.details) : null,
        receipt.errorCode ?? null,
        receipt.errorMessage ?? null
      );
  }

  async countActiveWuxu(): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS cnt FROM csteix_wuxu WHERE deleted_at IS NULL")
      .first<{ cnt: number }>();
    return row?.cnt ?? 0;
  }

  // MARK: - Read-Only CSTEIX Domains

  async getSummary(options: { from?: string; to?: string } = {}): Promise<Record<string, unknown>> {
    const { row, policy, allowedSet } = await this.getAllowedDomainsSet();
    const allowPlaces = allowedSet.has("places");

    const result: Record<string, unknown> = {
      generatedAt: new Date().toISOString(),
      from: options.from ?? null,
      to: options.to ?? null,
      allowedDomains: policy.allowedDomains,
      placesIncluded: allowPlaces,
      readOnlyDomains: ["dwell", "meditation", "marks", "places"]
    };

    const [wuxuMetaRes, dwellDataset, meditationDataset, marksDataset] = await Promise.all([
      allowedSet.has("wuxu")
        ? this.db
            .prepare(
              `SELECT id, slug, title, title_en, dimensions_json, written_at, timezone,
                      revision, deleted_at, created_at, updated_at,
                      CASE WHEN body_en IS NOT NULL AND TRIM(body_en) != '' THEN 1 ELSE 0 END AS has_english,
                      CASE WHEN raw_notes IS NOT NULL AND TRIM(raw_notes) != '' THEN 1 ELSE 0 END AS has_raw_notes
               FROM csteix_wuxu
               WHERE deleted_at IS NULL
               ORDER BY written_at DESC, slug ASC`
            )
            .all<CsteixWuxuMetaRow>()
        : Promise.resolve(null),
      allowedSet.has("dwell")
        ? this.ctx.readDataset<CsteixDwellRecord>("csteix", "dwell")
        : Promise.resolve(null),
      allowedSet.has("meditation")
        ? this.ctx.readDataset<CsteixMeditationRecord>("csteix", "meditation")
        : Promise.resolve(null),
      allowedSet.has("marks")
        ? this.ctx.readDataset<CsteixMarkRecord>("csteix", "marks")
        : Promise.resolve(null)
    ]);

    if (allowedSet.has("wuxu") && wuxuMetaRes) {
      const allActive = wuxuMetaRes.results;
      const filtered = allActive.filter((meta) =>
        matchesDateRange(
          meta.written_at,
          options.from,
          options.to,
          localDateKeyInTimezone(meta.written_at, meta.timezone)
        )
      );
      const byDimension: Record<CsteixDimension, number> = {
        chaos: 0,
        spacetime: 0,
        existence: 0,
        ix: 0
      };
      let withEnglishCount = 0;
      let withRawNotesCount = 0;
      for (const meta of filtered) {
        for (const dim of parseDimensionsJson(meta.dimensions_json)) {
          byDimension[dim] += 1;
        }
        if (Number(meta.has_english) === 1) withEnglishCount += 1;
        if (Number(meta.has_raw_notes) === 1) withRawNotesCount += 1;
      }
      const latestRow =
        filtered.length > 0
          ? await this.db
              .prepare("SELECT * FROM csteix_wuxu WHERE id = ?")
              .bind(filtered[0].id)
              .first<CsteixWuxuRow>()
          : null;
      result.wuxu = {
        enabled: true,
        totalCount: filtered.length,
        allTimeCount: allActive.length,
        byDimension,
        withEnglishCount,
        withRawNotesCount,
        latestArticle: latestRow ? toSummaryItem(mapWuxuRow(latestRow), false) : null
      };
    } else {
      result.wuxu = { enabled: false };
    }

    if (allowedSet.has("dwell")) {
      const filtered = (dwellDataset ?? []).filter((rec) => {
        const { iso, localDate } = recordDateInfo(rec);
        return matchesDateRange(iso, options.from, options.to, localDate);
      });
      const stats = accumulateDurationByPillar(filtered);
      result.dwell = {
        enabled: true,
        readOnly: true,
        datasetUploaded: dwellDataset !== null,
        recordCount: filtered.length,
        totalSeconds: stats.totalSeconds,
        byPillar: stats.byPillar
      };
    } else {
      result.dwell = { enabled: false, readOnly: true };
    }

    if (allowedSet.has("meditation")) {
      const filtered = (meditationDataset ?? []).filter((rec) => {
        const { iso, localDate } = recordDateInfo(rec);
        return matchesDateRange(iso, options.from, options.to, localDate);
      });
      const stats = accumulateDurationByPillar(filtered);
      result.meditation = {
        enabled: true,
        readOnly: true,
        datasetUploaded: meditationDataset !== null,
        recordCount: filtered.length,
        totalSeconds: stats.totalSeconds,
        byPillar: stats.byPillar
      };
    } else {
      result.meditation = { enabled: false, readOnly: true };
    }

    if (allowedSet.has("marks")) {
      const filtered = (marksDataset ?? []).filter((rec) => {
        const { iso, localDate } = recordDateInfo(rec);
        return matchesDateRange(iso, options.from, options.to, localDate);
      });
      const byKind: Record<string, number> = {};
      const byPillar: Record<string, number> = {};
      let totalCount = 0;
      for (const rec of filtered) {
        const count = typeof rec.count === "number" && Number.isFinite(rec.count) ? rec.count : 1;
        totalCount += count;
        const kind = String(rec.kind ?? rec.mark ?? "unknown").toLowerCase();
        byKind[kind] = (byKind[kind] ?? 0) + count;
        const pillarRaw = [rec.pillar, rec.dimension, rec.page].find(
          (v): v is string => typeof v === "string" && v.trim().length > 0
        );
        if (pillarRaw) {
          const pillar = normalizePillarFilter(pillarRaw);
          byPillar[pillar] = (byPillar[pillar] ?? 0) + count;
        }
      }
      result.marks = {
        enabled: true,
        readOnly: true,
        datasetUploaded: marksDataset !== null,
        recordCount: filtered.length,
        totalCount,
        byKind,
        byPillar
      };
    } else {
      result.marks = { enabled: false, readOnly: true };
    }

    const rawSnapshotSummary = safeJsonParse<Record<string, unknown>>(row.summary_json);
    if (rawSnapshotSummary) {
      result.snapshotSummary = allowPlaces ? rawSnapshotSummary : stripPlaceFields(rawSnapshotSummary);
    }

    return result;
  }

  async listDwell(options: {
    from?: string;
    to?: string;
    pillar?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<Record<string, unknown>> {
    const { allowedSet } = await this.getAllowedDomainsSet();
    if (!allowedSet.has("dwell")) {
      throw new Error("Domain 'dwell' is disabled by user policy in CSTEIX. Enable it in CSTEIX Settings -> AI Assistant.");
    }
    const allowPlaces = allowedSet.has("places");

    const dataset = await this.ctx.readDataset<CsteixDwellRecord>("csteix", "dwell");
    let items = (dataset ?? []).filter((rec) => {
      const { iso, localDate } = recordDateInfo(rec);
      return matchesDateRange(iso, options.from, options.to, localDate);
    });
    if (options.pillar?.trim()) {
      const target = normalizePillarFilter(options.pillar);
      items = items.filter((rec) => recordMatchesPillar(rec, target));
    }
    items.sort((a, b) => recordSortKey(b).localeCompare(recordSortKey(a)));

    const { limit, offset } = normalizePagination(options);
    const page = paginate(items, limit, offset);
    const sanitizedItems = allowPlaces ? page.items : page.items.map((item) => stripPlaceFields(item));
    return {
      readOnly: true,
      placesIncluded: allowPlaces,
      datasetUploaded: dataset !== null,
      ...page,
      items: sanitizedItems
    };
  }

  async listMeditation(options: {
    from?: string;
    to?: string;
    pillar?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<Record<string, unknown>> {
    const { allowedSet } = await this.getAllowedDomainsSet();
    if (!allowedSet.has("meditation")) {
      throw new Error("Domain 'meditation' is disabled by user policy in CSTEIX. Enable it in CSTEIX Settings -> AI Assistant.");
    }
    const allowPlaces = allowedSet.has("places");

    const dataset = await this.ctx.readDataset<CsteixMeditationRecord>("csteix", "meditation");
    let items = (dataset ?? []).filter((rec) => {
      const { iso, localDate } = recordDateInfo(rec);
      return matchesDateRange(iso, options.from, options.to, localDate);
    });
    if (options.pillar?.trim()) {
      const target = normalizePillarFilter(options.pillar);
      items = items.filter((rec) => recordMatchesPillar(rec, target));
    }
    items.sort((a, b) => recordSortKey(b).localeCompare(recordSortKey(a)));

    const { limit, offset } = normalizePagination(options);
    const page = paginate(items, limit, offset);
    const sanitizedItems = allowPlaces ? page.items : page.items.map((item) => stripPlaceFields(item));
    return {
      readOnly: true,
      placesIncluded: allowPlaces,
      datasetUploaded: dataset !== null,
      ...page,
      items: sanitizedItems
    };
  }

  async listMarks(options: {
    from?: string;
    to?: string;
    kind?: string;
    pillar?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<Record<string, unknown>> {
    const { allowedSet } = await this.getAllowedDomainsSet();
    if (!allowedSet.has("marks")) {
      throw new Error("Domain 'marks' is disabled by user policy in CSTEIX. Enable it in CSTEIX Settings -> AI Assistant.");
    }
    const allowPlaces = allowedSet.has("places");

    const dataset = await this.ctx.readDataset<CsteixMarkRecord>("csteix", "marks");
    let items = (dataset ?? []).filter((rec) => {
      const { iso, localDate } = recordDateInfo(rec);
      return matchesDateRange(iso, options.from, options.to, localDate);
    });
    if (options.kind?.trim()) {
      const targetKind = options.kind.trim().toLowerCase();
      items = items.filter((rec) => String(rec.kind ?? rec.mark ?? "").toLowerCase() === targetKind);
    }
    if (options.pillar?.trim()) {
      const targetPillar = normalizePillarFilter(options.pillar);
      items = items.filter((rec) => recordMatchesPillar(rec, targetPillar));
    }
    items.sort((a, b) => recordSortKey(b).localeCompare(recordSortKey(a)));

    const { limit, offset } = normalizePagination(options);
    const page = paginate(items, limit, offset);
    const sanitizedItems = allowPlaces ? page.items : page.items.map((item) => stripPlaceFields(item));
    return {
      readOnly: true,
      placesIncluded: allowPlaces,
      datasetUploaded: dataset !== null,
      ...page,
      items: sanitizedItems
    };
  }

  // MARK: - Wuxu Reads

  async listWuxu(options: {
    from?: string;
    to?: string;
    dimension?: string;
    query?: string;
    hasRaw?: boolean;
    hasEn?: boolean;
    includeDeleted?: boolean;
    includeBody?: boolean;
    limit?: number;
    offset?: number;
  } = {}): Promise<Record<string, unknown>> {
    await this.ctx.assertDomainReadAllowed("csteix", "wuxu");

    const clauses: string[] = [];
    const bindings: unknown[] = [];

    if (!options.includeDeleted) {
      clauses.push("deleted_at IS NULL");
    }
    if (options.hasRaw === true) {
      clauses.push("raw_notes IS NOT NULL AND TRIM(raw_notes) != ''");
    } else if (options.hasRaw === false) {
      clauses.push("(raw_notes IS NULL OR TRIM(raw_notes) = '')");
    }
    if (options.hasEn === true) {
      clauses.push("body_en IS NOT NULL AND TRIM(body_en) != ''");
    } else if (options.hasEn === false) {
      clauses.push("(body_en IS NULL OR TRIM(body_en) = '')");
    }

    const trimmedQuery = options.query?.trim();
    if (trimmedQuery) {
      const likePattern = `%${escapeSqlLike(trimmedQuery)}%`;
      clauses.push(
        `(slug LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR COALESCE(title_en, '') LIKE ? ESCAPE '\\' OR body_zh LIKE ? ESCAPE '\\' OR COALESCE(body_en, '') LIKE ? ESCAPE '\\' OR COALESCE(raw_notes, '') LIKE ? ESCAPE '\\')`
      );
      bindings.push(likePattern, likePattern, likePattern, likePattern, likePattern, likePattern);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const targetDim = options.dimension?.trim() ? normalizeSingleDimension(options.dimension) : undefined;
    if (options.dimension?.trim() && !targetDim) {
      throw new Error(
        `Invalid dimension filter '${options.dimension}'. Allowed: chaos, spacetime, existence, ix.`
      );
    }

    const includeBody = options.includeBody === true;

    // Select lightweight columns first when full bodies aren't immediately requested in SQL, then
    // hydrate only the paginated slice so headings/leavingLines never scan off-page articles.
    const metaSql = `SELECT id, slug, title, title_en, dimensions_json, written_at, timezone,
                            revision, deleted_at, created_at, updated_at,
                            CASE WHEN body_en IS NOT NULL AND TRIM(body_en) != '' THEN 1 ELSE 0 END AS has_english,
                            CASE WHEN raw_notes IS NOT NULL AND TRIM(raw_notes) != '' THEN 1 ELSE 0 END AS has_raw_notes
                     FROM csteix_wuxu ${whereSql} ORDER BY written_at DESC, slug ASC`;
    const metaStmt = this.db.prepare(metaSql);
    const metaRows = (
      bindings.length > 0 ? await metaStmt.bind(...bindings).all<CsteixWuxuMetaRow>() : await metaStmt.all<CsteixWuxuMetaRow>()
    ).results;

    let filteredMeta = metaRows;
    if (options.from || options.to) {
      filteredMeta = filteredMeta.filter((row) =>
        matchesDateRange(
          row.written_at,
          options.from,
          options.to,
          localDateKeyInTimezone(row.written_at, row.timezone)
        )
      );
    }
    if (targetDim) {
      filteredMeta = filteredMeta.filter((row) => parseDimensionsJson(row.dimensions_json).includes(targetDim));
    }

    const { limit, offset } = normalizePagination(options);
    const metaPage = paginate(filteredMeta, limit, offset);
    if (metaPage.items.length === 0) {
      return {
        ...metaPage,
        items: []
      };
    }

    const ids = metaPage.items.map((item) => item.id);
    const placeholders = ids.map(() => "?").join(", ");
    const fullRowsRes = await this.db
      .prepare(`SELECT * FROM csteix_wuxu WHERE id IN (${placeholders})`)
      .bind(...ids)
      .all<CsteixWuxuRow>();
    const fullById = new Map(fullRowsRes.results.map((r) => [r.id, r]));

    const hydratedItems = ids
      .map((id) => fullById.get(id))
      .filter((r): r is CsteixWuxuRow => r !== undefined)
      .map((r) => toSummaryItem(mapWuxuRow(r), includeBody));

    return {
      ...metaPage,
      items: hydratedItems
    };
  }

  async getWuxu(options: { id?: string; slug?: string }): Promise<Record<string, unknown>> {
    await this.ctx.assertDomainReadAllowed("csteix", "wuxu");
    const row = await this.findArticleByIdOrSlug(options.id, options.slug);
    if (!row) {
      const ref = options.id?.trim() || options.slug?.trim() || "";
      throw new Error(`Wuxu article '${ref}' was not found.`);
    }
    const article = mapWuxuRow(row);
    return {
      ...article,
      localDate: localDateKeyInTimezone(article.writtenAt, article.timezone),
      headings: extractHeadings(article.bodyZh),
      ...(article.bodyEn ? { headingsEn: extractHeadings(article.bodyEn) } : {}),
      leavingLines: extractLeavingLines(article.bodyZh)
    };
  }

  // MARK: - Wuxu Immediate CRUD (Server Source of Truth + Applied Receipts)

  async createWuxu(input: {
    slug: string;
    title: string;
    titleEn?: string | null;
    dimensions: string[];
    writtenAt?: string;
    timezone?: string;
    bodyZh: string;
    bodyEn?: string | null;
    rawNotes?: string | null;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    await this.ctx.assertActionAllowed("csteix", "create", "wuxu");

    const requestId = input.requestId?.trim() || generateRequestId("csteix-wuxu");
    const existingReceipt = await this.lookupExistingReceipt(requestId);
    if (existingReceipt) {
      const existingRow = existingReceipt.recordId
        ? await this.db
            .prepare("SELECT * FROM csteix_wuxu WHERE id = ?")
            .bind(existingReceipt.recordId)
            .first<CsteixWuxuRow>()
        : null;
      return {
        applied: false,
        alreadyProcessed: true,
        receipt: existingReceipt,
        article: existingRow ? mapWuxuRow(existingRow) : null
      };
    }

    const slug = normalizeSlug(input.slug);
    const title = requireNonEmptyString(input.title, "title");
    const titleEn = normalizeOptionalNullableString(input.titleEn) ?? null;
    const dimensions = normalizeDimensions(input.dimensions);
    const timezone = normalizeTimezone(input.timezone);
    const writtenAt = normalizeWrittenAt(input.writtenAt, timezone);
    const bodyZh = requireNonEmptyString(input.bodyZh, "bodyZh");
    const bodyEn = normalizeOptionalNullableString(input.bodyEn) ?? null;
    const rawNotes = normalizeOptionalNullableString(input.rawNotes) ?? null;

    const existingSlug = await this.db
      .prepare("SELECT id, slug, revision, deleted_at FROM csteix_wuxu WHERE slug = ?")
      .bind(slug)
      .first<{ id: string; slug: string; revision: number; deleted_at: string | null }>();
    if (existingSlug) {
      if (existingSlug.deleted_at) {
        throw new Error(
          `Wuxu article '${slug}' is in 30-day Trash (deletedAt: ${existingSlug.deleted_at}). Call csteix_restore_wuxu to restore it.`
        );
      }
      throw new Error(
        `Wuxu article '${slug}' already exists (id: ${existingSlug.id}, revision: ${existingSlug.revision}). Use csteix_update_wuxu to edit it.`
      );
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const revision = 1;

    const receipt: Receipt = {
      schemaVersion: SCHEMA_VERSION,
      requestId,
      app: "csteix",
      op: "create_wuxu",
      status: "applied",
      processedAt: now,
      recordId: id,
      stableId: slug,
      summary: `Created Wuxu '${title}' (${slug})`,
      details: {
        slug,
        revision,
        dimensions,
        ...(input.client ? { client: input.client } : {})
      }
    };

    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO csteix_wuxu (
            id, slug, title, title_en, dimensions_json, written_at, timezone,
            body_zh, body_en, raw_notes, revision, deleted_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
        )
        .bind(
          id,
          slug,
          title,
          titleEn,
          JSON.stringify(dimensions),
          writtenAt,
          timezone,
          bodyZh,
          bodyEn,
          rawNotes,
          revision,
          now,
          now
        ),
      this.makeAppliedReceiptStatement(receipt)
    ]);

    const article: CsteixWuxuArticle = {
      id,
      slug,
      title,
      titleEn,
      dimensions,
      writtenAt,
      timezone,
      bodyZh,
      bodyEn,
      rawNotes,
      revision,
      deletedAt: null,
      createdAt: now,
      updatedAt: now
    };

    return {
      applied: true,
      requestId,
      receipt,
      article
    };
  }

  async updateWuxu(input: {
    id?: string;
    slug?: string;
    expectedRevision?: number;
    title?: string;
    titleEn?: string | null;
    dimensions?: string[];
    writtenAt?: string;
    timezone?: string;
    bodyZh?: string;
    bodyEn?: string | null;
    rawNotes?: string | null;
    appendBodyZh?: string;
    appendBodyEn?: string;
    appendRawNotes?: string;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    await this.ctx.assertActionAllowed("csteix", "update", "wuxu");

    const requestId = input.requestId?.trim() || generateRequestId("csteix-wuxu-upd");
    const existingReceipt = await this.lookupExistingReceipt(requestId);
    if (existingReceipt) {
      const existingRow = existingReceipt.recordId
        ? await this.db
            .prepare("SELECT * FROM csteix_wuxu WHERE id = ?")
            .bind(existingReceipt.recordId)
            .first<CsteixWuxuRow>()
        : null;
      return {
        applied: false,
        alreadyProcessed: true,
        receipt: existingReceipt,
        article: existingRow ? mapWuxuRow(existingRow) : null
      };
    }

    const existing = await this.findArticleByIdOrSlug(input.id, input.slug);
    if (!existing) {
      const ref = input.id?.trim() || input.slug?.trim() || "";
      throw new Error(`Wuxu article '${ref}' was not found.`);
    }
    if (existing.deleted_at) {
      throw new Error(
        `Wuxu article '${existing.slug}' is in 30-day Trash (deletedAt: ${existing.deleted_at}). Call csteix_restore_wuxu before editing.`
      );
    }

    if (input.expectedRevision !== undefined) {
      if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
        throw new Error("'expectedRevision' must be a positive integer.");
      }
      if (input.expectedRevision !== existing.revision) {
        throw new Error(
          `Revision conflict for '${existing.slug}': expected revision ${input.expectedRevision}, but current revision is ${existing.revision}. Fetch the latest article with csteix_get_wuxu first.`
        );
      }
    }

    if (input.bodyZh !== undefined && input.appendBodyZh !== undefined) {
      throw new Error("Cannot provide both 'bodyZh' and 'appendBodyZh' in the same update.");
    }
    if (input.bodyEn !== undefined && input.appendBodyEn !== undefined) {
      throw new Error("Cannot provide both 'bodyEn' and 'appendBodyEn' in the same update.");
    }
    if (input.rawNotes !== undefined && input.appendRawNotes !== undefined) {
      throw new Error("Cannot provide both 'rawNotes' and 'appendRawNotes' in the same update.");
    }

    let nextTitle = existing.title;
    let nextTitleEn = existing.title_en;
    let nextDimensions = mapWuxuRow(existing).dimensions;
    let nextTimezone = existing.timezone;
    let nextWrittenAt = existing.written_at;
    let nextBodyZh = existing.body_zh;
    let nextBodyEn = existing.body_en;
    let nextRawNotes = existing.raw_notes;
    const changedFields: string[] = [];

    if (input.title !== undefined) {
      nextTitle = requireNonEmptyString(input.title, "title");
      changedFields.push("title");
    }
    if (input.titleEn !== undefined) {
      nextTitleEn = normalizeOptionalNullableString(input.titleEn) ?? null;
      changedFields.push("titleEn");
    }
    if (input.dimensions !== undefined) {
      nextDimensions = normalizeDimensions(input.dimensions);
      changedFields.push("dimensions");
    }
    if (input.timezone !== undefined) {
      nextTimezone = normalizeTimezone(input.timezone);
      changedFields.push("timezone");
    }
    if (input.writtenAt !== undefined) {
      nextWrittenAt = normalizeWrittenAt(input.writtenAt, nextTimezone);
      changedFields.push("writtenAt");
    }
    if (input.bodyZh !== undefined) {
      nextBodyZh = requireNonEmptyString(input.bodyZh, "bodyZh");
      changedFields.push("bodyZh");
    } else if (input.appendBodyZh !== undefined) {
      const addition = requireNonEmptyString(input.appendBodyZh, "appendBodyZh");
      nextBodyZh = `${existing.body_zh.trimEnd()}\n\n${addition}`;
      changedFields.push("appendBodyZh");
    }
    if (input.bodyEn !== undefined) {
      nextBodyEn = normalizeOptionalNullableString(input.bodyEn) ?? null;
      changedFields.push("bodyEn");
    } else if (input.appendBodyEn !== undefined) {
      const addition = requireNonEmptyString(input.appendBodyEn, "appendBodyEn");
      nextBodyEn = existing.body_en?.trim()
        ? `${existing.body_en.trimEnd()}\n\n${addition}`
        : addition;
      changedFields.push("appendBodyEn");
    }
    if (input.rawNotes !== undefined) {
      nextRawNotes = normalizeOptionalNullableString(input.rawNotes) ?? null;
      changedFields.push("rawNotes");
    } else if (input.appendRawNotes !== undefined) {
      const addition = requireNonEmptyString(input.appendRawNotes, "appendRawNotes");
      nextRawNotes = existing.raw_notes?.trim()
        ? `${existing.raw_notes.trimEnd()}\n\n${addition}`
        : addition;
      changedFields.push("appendRawNotes");
    }

    if (changedFields.length === 0) {
      throw new Error("csteix_update_wuxu requires at least one field to update or append.");
    }

    const nextRevision = existing.revision + 1;
    const now = new Date().toISOString();

    const receipt: Receipt = {
      schemaVersion: SCHEMA_VERSION,
      requestId,
      app: "csteix",
      op: "update_wuxu",
      status: "applied",
      processedAt: now,
      recordId: existing.id,
      stableId: existing.slug,
      summary: `Updated Wuxu '${nextTitle}' (${existing.slug}) to rev ${nextRevision}`,
      details: {
        slug: existing.slug,
        revision: nextRevision,
        changedFields,
        ...(input.client ? { client: input.client } : {})
      }
    };

    const updateResult = await this.db
      .prepare(
        `UPDATE csteix_wuxu
         SET title = ?, title_en = ?, dimensions_json = ?, written_at = ?, timezone = ?,
             body_zh = ?, body_en = ?, raw_notes = ?, revision = ?, updated_at = ?
         WHERE id = ? AND revision = ? AND deleted_at IS NULL`
      )
      .bind(
        nextTitle,
        nextTitleEn,
        JSON.stringify(nextDimensions),
        nextWrittenAt,
        nextTimezone,
        nextBodyZh,
        nextBodyEn,
        nextRawNotes,
        nextRevision,
        now,
        existing.id,
        existing.revision
      )
      .run();

    const changed = extractChangedRows(updateResult);
    if (changed === 0) {
      throw new Error(
        `Revision conflict for '${existing.slug}': expected revision ${existing.revision}, but the article changed concurrently. Fetch the latest article with csteix_get_wuxu and retry.`
      );
    }

    await this.makeAppliedReceiptStatement(receipt).run();

    const article: CsteixWuxuArticle = {
      id: existing.id,
      slug: existing.slug,
      title: nextTitle,
      titleEn: nextTitleEn,
      dimensions: nextDimensions,
      writtenAt: nextWrittenAt,
      timezone: nextTimezone,
      bodyZh: nextBodyZh,
      bodyEn: nextBodyEn,
      rawNotes: nextRawNotes,
      revision: nextRevision,
      deletedAt: null,
      createdAt: existing.created_at,
      updatedAt: now
    };

    return {
      applied: true,
      requestId,
      receipt,
      article
    };
  }

  async deleteWuxu(input: {
    id?: string;
    slug?: string;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    await this.ctx.assertActionAllowed("csteix", "delete", "wuxu");

    const requestId = input.requestId?.trim() || generateRequestId("csteix-wuxu-del");
    const existingReceipt = await this.lookupExistingReceipt(requestId);
    if (existingReceipt) {
      const existingRow = existingReceipt.recordId
        ? await this.db
            .prepare("SELECT * FROM csteix_wuxu WHERE id = ?")
            .bind(existingReceipt.recordId)
            .first<CsteixWuxuRow>()
        : null;
      return {
        applied: false,
        alreadyProcessed: true,
        receipt: existingReceipt,
        article: existingRow ? mapWuxuRow(existingRow) : null
      };
    }

    const existing = await this.findArticleByIdOrSlug(input.id, input.slug);
    if (!existing) {
      const ref = input.id?.trim() || input.slug?.trim() || "";
      throw new Error(`Wuxu article '${ref}' was not found.`);
    }
    if (existing.deleted_at) {
      throw new Error(
        `Wuxu article '${existing.slug}' is already in 30-day Trash (deletedAt: ${existing.deleted_at}).`
      );
    }

    const nowDate = new Date();
    const now = nowDate.toISOString();
    const restorableUntil = new Date(nowDate.getTime() + TRASH_RETENTION_MS).toISOString();
    const nextRevision = existing.revision + 1;

    const receipt: Receipt = {
      schemaVersion: SCHEMA_VERSION,
      requestId,
      app: "csteix",
      op: "delete_wuxu",
      status: "applied",
      processedAt: now,
      recordId: existing.id,
      stableId: existing.slug,
      summary: `Moved Wuxu '${existing.title}' (${existing.slug}) to 30-day Trash`,
      details: {
        slug: existing.slug,
        revision: nextRevision,
        deletedAt: now,
        restorableUntil,
        ...(input.client ? { client: input.client } : {})
      }
    };

    const deleteResult = await this.db
      .prepare(
        `UPDATE csteix_wuxu
         SET deleted_at = ?, revision = ?, updated_at = ?
         WHERE id = ? AND deleted_at IS NULL`
      )
      .bind(now, nextRevision, now, existing.id)
      .run();

    const changed = extractChangedRows(deleteResult);
    if (changed === 0) {
      throw new Error(`Wuxu article '${existing.slug}' was already moved to Trash concurrently.`);
    }

    await this.makeAppliedReceiptStatement(receipt).run();

    const updated = mapWuxuRow({
      ...existing,
      deleted_at: now,
      revision: nextRevision,
      updated_at: now
    });

    return {
      applied: true,
      softDeleted: true,
      trashRetentionDays: TRASH_RETENTION_DAYS,
      restorableUntil,
      requestId,
      receipt,
      article: updated
    };
  }

  async restoreWuxu(input: {
    id?: string;
    slug?: string;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    await this.ctx.assertActionAllowed("csteix", "update", "wuxu");

    const requestId = input.requestId?.trim() || generateRequestId("csteix-wuxu-res");
    const existingReceipt = await this.lookupExistingReceipt(requestId);
    if (existingReceipt) {
      const existingRow = existingReceipt.recordId
        ? await this.db
            .prepare("SELECT * FROM csteix_wuxu WHERE id = ?")
            .bind(existingReceipt.recordId)
            .first<CsteixWuxuRow>()
        : null;
      return {
        applied: false,
        alreadyProcessed: true,
        receipt: existingReceipt,
        article: existingRow ? mapWuxuRow(existingRow) : null
      };
    }

    const existing = await this.findArticleByIdOrSlug(input.id, input.slug);
    if (!existing) {
      const ref = input.id?.trim() || input.slug?.trim() || "";
      throw new Error(`Wuxu article '${ref}' was not found.`);
    }
    if (!existing.deleted_at) {
      throw new Error(`Wuxu article '${existing.slug}' is not in Trash.`);
    }

    const deletedMs = Date.parse(existing.deleted_at);
    if (!Number.isNaN(deletedMs) && Date.now() - deletedMs > TRASH_RETENTION_MS) {
      throw new Error(
        `Wuxu article '${existing.slug}' exceeded the 30-day Trash retention window (deletedAt: ${existing.deleted_at}) and cannot be restored.`
      );
    }

    const now = new Date().toISOString();
    const nextRevision = existing.revision + 1;

    const receipt: Receipt = {
      schemaVersion: SCHEMA_VERSION,
      requestId,
      app: "csteix",
      op: "restore_wuxu",
      status: "applied",
      processedAt: now,
      recordId: existing.id,
      stableId: existing.slug,
      summary: `Restored Wuxu '${existing.title}' (${existing.slug}) from Trash`,
      details: {
        slug: existing.slug,
        revision: nextRevision,
        ...(input.client ? { client: input.client } : {})
      }
    };

    const restoreResult = await this.db
      .prepare(
        `UPDATE csteix_wuxu
         SET deleted_at = NULL, revision = ?, updated_at = ?
         WHERE id = ? AND deleted_at IS NOT NULL`
      )
      .bind(nextRevision, now, existing.id)
      .run();

    const changed = extractChangedRows(restoreResult);
    if (changed === 0) {
      throw new Error(`Wuxu article '${existing.slug}' was already restored or removed concurrently.`);
    }

    await this.makeAppliedReceiptStatement(receipt).run();

    const updated = mapWuxuRow({
      ...existing,
      deleted_at: null,
      revision: nextRevision,
      updated_at: now
    });

    return {
      applied: true,
      restored: true,
      requestId,
      receipt,
      article: updated
    };
  }

  // MARK: - Device Delta Sync & Local Markdown Repository Seeding

  async getWuxuDelta(options: {
    since?: string | null;
    includeDeleted?: boolean;
  } = {}): Promise<Record<string, unknown>> {
    const syncedAt = new Date().toISOString();
    const includeDeleted = options.includeDeleted !== false;
    const rawSince = options.since?.trim();

    let rows: CsteixWuxuRow[];
    if (rawSince) {
      const parsedMs = Date.parse(rawSince);
      if (Number.isNaN(parsedMs)) {
        throw new Error(`Invalid ISO-8601 'since' query parameter: ${rawSince}`);
      }
      const normalizedSince = new Date(parsedMs).toISOString();
      const sql = includeDeleted
        ? "SELECT * FROM csteix_wuxu WHERE updated_at > ? ORDER BY updated_at ASC, id ASC"
        : "SELECT * FROM csteix_wuxu WHERE updated_at > ? AND deleted_at IS NULL ORDER BY updated_at ASC, id ASC";
      rows = (await this.db.prepare(sql).bind(normalizedSince).all<CsteixWuxuRow>()).results;
    } else {
      const sql = includeDeleted
        ? "SELECT * FROM csteix_wuxu ORDER BY updated_at ASC, id ASC"
        : "SELECT * FROM csteix_wuxu WHERE deleted_at IS NULL ORDER BY updated_at ASC, id ASC";
      rows = (await this.db.prepare(sql).all<CsteixWuxuRow>()).results;
    }

    const totalCount = await this.countActiveWuxu();

    return {
      schemaVersion: SCHEMA_VERSION,
      app: "csteix",
      syncedAt,
      totalCount,
      articles: rows.map(mapWuxuRow)
    };
  }

  async importWuxuArticles(rawArticles: unknown): Promise<Record<string, unknown>> {
    if (!Array.isArray(rawArticles)) {
      throw new Error("Expected JSON object with 'articles' array.");
    }

    const normalizedItems: Array<{
      slug: string;
      title: string;
      titleEn: string | null;
      dimensions: CsteixDimension[];
      dimensionsJson: string;
      writtenAt: string;
      timezone: string;
      bodyZh: string;
      bodyEn: string | null;
      rawNotes: string | null;
    }> = [];

    const seenSlugs = new Set<string>();
    for (let idx = 0; idx < rawArticles.length; idx += 1) {
      const entry = rawArticles[idx] as CsteixWuxuImportItem;
      if (!entry || typeof entry !== "object") {
        throw new Error(`articles[${idx}] must be an object.`);
      }
      const slug = normalizeSlug(entry.slug);
      if (seenSlugs.has(slug)) {
        throw new Error(`Duplicate slug '${slug}' in import payload.`);
      }
      seenSlugs.add(slug);
      const title = requireNonEmptyString(entry.title, `articles[${idx}].title`);
      const titleEn = normalizeOptionalNullableString(entry.titleEn) ?? null;
      const dimensions = normalizeDimensions(entry.dimensions);
      const timezone = normalizeTimezone(entry.timezone);
      const writtenAt = normalizeWrittenAt(entry.writtenAt, timezone);
      const bodyZh = requireNonEmptyString(entry.bodyZh, `articles[${idx}].bodyZh`);
      const bodyEn = normalizeOptionalNullableString(entry.bodyEn) ?? null;
      const rawNotes = normalizeOptionalNullableString(entry.rawNotes) ?? null;

      normalizedItems.push({
        slug,
        title,
        titleEn,
        dimensions,
        dimensionsJson: JSON.stringify(dimensions),
        writtenAt,
        timezone,
        bodyZh,
        bodyEn,
        rawNotes
      });
    }

    const existingBySlug = new Map<string, CsteixWuxuRow>();
    const allSlugs = normalizedItems.map((item) => item.slug);
    for (let i = 0; i < allSlugs.length; i += 80) {
      const chunk = allSlugs.slice(i, i + 80);
      const placeholders = chunk.map(() => "?").join(", ");
      const { results } = await this.db
        .prepare(`SELECT * FROM csteix_wuxu WHERE slug IN (${placeholders})`)
        .bind(...chunk)
        .all<CsteixWuxuRow>();
      for (const row of results) {
        existingBySlug.set(row.slug, row);
      }
    }

    const now = new Date().toISOString();
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    const statements: SqlPreparedStatement[] = [];

    for (const item of normalizedItems) {
      const existing = existingBySlug.get(item.slug) ?? null;

      if (!existing) {
        const id = crypto.randomUUID();
        statements.push(
          this.db
            .prepare(
              `INSERT INTO csteix_wuxu (
                id, slug, title, title_en, dimensions_json, written_at, timezone,
                body_zh, body_en, raw_notes, revision, deleted_at, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`
            )
            .bind(
              id,
              item.slug,
              item.title,
              item.titleEn,
              item.dimensionsJson,
              item.writtenAt,
              item.timezone,
              item.bodyZh,
              item.bodyEn,
              item.rawNotes,
              now,
              now
            )
        );
        inserted += 1;
        continue;
      }

      const identical =
        existing.deleted_at === null &&
        existing.title === item.title &&
        (existing.title_en ?? null) === item.titleEn &&
        existing.dimensions_json === item.dimensionsJson &&
        existing.written_at === item.writtenAt &&
        existing.timezone === item.timezone &&
        existing.body_zh === item.bodyZh &&
        (existing.body_en ?? null) === item.bodyEn &&
        (existing.raw_notes ?? null) === item.rawNotes;

      if (identical) {
        unchanged += 1;
        continue;
      }

      statements.push(
        this.db
          .prepare(
            `UPDATE csteix_wuxu
             SET title = ?, title_en = ?, dimensions_json = ?, written_at = ?, timezone = ?,
                 body_zh = ?, body_en = ?, raw_notes = ?, revision = ?, deleted_at = NULL, updated_at = ?
             WHERE id = ?`
          )
          .bind(
            item.title,
            item.titleEn,
            item.dimensionsJson,
            item.writtenAt,
            item.timezone,
            item.bodyZh,
            item.bodyEn,
            item.rawNotes,
            existing.revision + 1,
            now,
            existing.id
          )
      );
      updated += 1;
    }

    if (statements.length > 0) {
      await this.db.batch(statements);
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      app: "csteix",
      importedAt: now,
      inserted,
      updated,
      unchanged,
      totalProcessed: normalizedItems.length
    };
  }
}
