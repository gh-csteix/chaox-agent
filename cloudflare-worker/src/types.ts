export const SCHEMA_VERSION = "chaox-agent/v1";

export type AgentAppID = "sx" | "bx" | "gx" | "csteix";
export type PermissionTier = "disabled" | "readOnly" | "appendOnly" | "readWrite";
export type PermissionAction = "create" | "update" | "delete";

export type BxDomain = "sleep" | "workouts" | "food" | "skin" | "toilet";
export type SxDomain = "projects" | "expenses" | "incomes" | "tags" | "slogans" | "credentials";
export type CsteixDomain = "wuxu" | "dwell" | "meditation" | "marks" | "places";
export type CsteixDimension = "chaos" | "spacetime" | "existence" | "ix";

export type BxMealType = "breakfast" | "lunch" | "dinner" | "snack";
export type BxSkinProduct = "sunscreen" | "moisturizer" | "bodyLotion" | "medicine" | "other";
export type BxToiletKind = "bowel" | "urination";

export interface PermissionPolicy {
  allowRead: boolean;
  allowCreate: boolean;
  allowUpdate: boolean;
  allowDelete: boolean;
  allowedDomains: string[];
  consentAcknowledged: boolean;
  updatedAt?: string;
}

export interface D1LikePreparedStatement {
  bind(...values: unknown[]): D1LikePreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface D1LikeDatabase {
  prepare(query: string): D1LikePreparedStatement;
  batch(statements: D1LikePreparedStatement[]): Promise<unknown[]>;
}

export interface WorkerEnv {
  DB: D1LikeDatabase;
  CHAOX_AUTH_TOKEN: string;
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
  timeZoneIdentifier?: string;
  summaryCurrency?: string;
  expense?: Record<string, SxPeriodBucket>;
  income?: Record<string, SxPeriodBucket>;
  periods?: Record<string, SxPeriodBucket>;
  [key: string]: unknown;
}

export interface SxProjectRecord {
  id: number;
  name: string;
  price: number;
  currency: string;
  cycle: string;
  priceType: string;
  projectType: string;
  cashFlowSides: string;
  supportsExpense: boolean;
  supportsIncome: boolean;
  startDate: string;
  endDate?: string | null;
  isAutoRenew: boolean;
  autoRecordEnabled?: boolean;
  notes: string;
  expenseCount: number;
  incomeCount: number;
  credentialLinkCount: number;
  deletable: boolean;
  createdAt?: string;
  updatedAt?: string;
  pendingStatus?: string;
}

export interface SxRefundRecord {
  id: number;
  paymentId: number;
  amount: number;
  currency: string;
  notes: string;
  refundedAt: string;
  createdAt?: string;
  pendingStatus?: string;
}

export interface SxExpenseRecord {
  id: number;
  projectId: number;
  projectName: string;
  credentialId?: number | null;
  credentialName?: string | null;
  amount: number;
  netAmount: number;
  refundTotal: number;
  currency: string;
  tags: string[];
  notes: string;
  paidAt: string;
  localDate?: string;
  createdAt?: string;
  isAutoRecorded?: boolean;
  refunds?: SxRefundRecord[];
  pendingStatus?: string;
  pendingRequestId?: string;
}

export interface SxReversalRecord {
  id: number;
  incomeId: number;
  amount: number;
  currency: string;
  notes: string;
  reversedAt: string;
  createdAt?: string;
  pendingStatus?: string;
}

export interface SxIncomeRecord {
  id: number;
  projectId: number;
  projectName: string;
  credentialId?: number | null;
  credentialName?: string | null;
  amount: number;
  netAmount: number;
  reversalTotal: number;
  currency: string;
  tags: string[];
  notes: string;
  receivedAt: string;
  localDate?: string;
  createdAt?: string;
  reversals?: SxReversalRecord[];
  pendingStatus?: string;
  pendingRequestId?: string;
}

export interface SxCredentialLinkRecord {
  projectId: number;
  projectName: string;
  startDate: string;
  hasStartDate: boolean;
  endDate?: string | null;
  isAutoRenew: boolean;
  nextRenewalDate?: string | null;
  renewalHour: number;
  renewalWeekdays: number;
}

export interface SxCredentialRecord {
  id: number;
  username: string;
  type: string;
  website: string;
  issuer: string;
  createdAt?: string;
  linkCount: number;
  links: SxCredentialLinkRecord[];
  pendingStatus?: string;
  pendingRequestId?: string;
}

export interface SxTagRecord {
  id: number;
  name: string;
  expenseCount: number;
  incomeCount: number;
  createdAt?: string;
  pendingStatus?: string;
}

export interface SxSloganRecord {
  id: number;
  language: string;
  text: string;
  emoji?: string | null;
  ruleType: string;
  ruleValue: string;
  priority: number;
  isEnabled: boolean;
  pairId?: string | null;
  createdAt?: string;
  pendingStatus?: string;
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

export interface BxSleepNight {
  day: string;
  start: string;
  end: string;
  asleepMinutes: number;
  inBedMinutes?: number | null;
  stagesMinutes: Record<string, number>;
  source: string;
  readOnly: boolean;
}

export interface BxFoodRecord {
  id: string;
  eatenAt: string;
  meal: BxMealType;
  name: string;
  calories?: number | null;
  updatedAt?: string;
  pendingStatus?: string;
  pendingRequestId?: string;
}

export interface BxSkinRecord {
  id: string;
  appliedAt: string;
  product: BxSkinProduct;
  name: string;
  updatedAt?: string;
  pendingStatus?: string;
  pendingRequestId?: string;
}

export interface BxToiletRecord {
  id: string;
  occurredAt: string;
  kind: BxToiletKind;
  stoolType?: number | null;
  note: string;
  updatedAt?: string;
  pendingStatus?: string;
  pendingRequestId?: string;
}

export interface BxSetGroup {
  reps: number;
  sets: number;
  weightKg?: number | null;
}

export interface BxSetRecord {
  reps?: number | null;
  weightKg?: number | null;
  rpe?: number | null;
  durationSeconds?: number | null;
}

export interface BxWorkoutExerciseRecord {
  entryId: string;
  workoutId: string;
  exerciseId: string;
  exerciseKey?: string;
  nameZh?: string;
  nameEn?: string;
  muscleGroup?: string;
  equipment?: string[];
  position: number;
  setGroups: BxSetGroup[];
  sets?: BxSetRecord[];
  setsSummary?: string;
  totalSets?: number;
  totalReps?: number;
  totalVolumeKg?: number;
  pendingStatus?: string;
}

export interface BxWorkoutRecord {
  id: string;
  source: string;
  start: string;
  end: string;
  durationMinutes: number;
  activeEnergyKcal?: number | null;
  averageHeartRate?: number | null;
  healthActivityType?: number | null;
  healthActivityName?: string | null;
  chosenActivityType?: number | null;
  chosenActivityName?: string | null;
  effectiveActivityName?: string;
  canChooseType: boolean;
  frameReadOnly: boolean;
  exercises: BxWorkoutExerciseRecord[];
  pendingStatus?: string;
}

export interface BxExerciseInfo {
  id: string;
  key: string;
  nameZh: string;
  nameEn: string;
  aliases?: string[];
  group: string;
  equipment: string[];
  primaryMuscles?: string[];
  secondaryMuscles?: string[];
}

export interface CsteixWuxuArticle {
  id: string;
  slug: string;
  title: string;
  titleEn?: string | null;
  dimensions: CsteixDimension[];
  writtenAt: string;
  timezone: string;
  bodyZh: string;
  bodyEn?: string | null;
  rawNotes?: string | null;
  revision: number;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CsteixWuxuSummaryItem {
  id: string;
  slug: string;
  title: string;
  titleEn?: string | null;
  dimensions: CsteixDimension[];
  writtenAt: string;
  localDate: string;
  timezone: string;
  hasEnglish: boolean;
  hasRawNotes: boolean;
  headings: string[];
  headingsEn?: string[];
  leavingLines: string[];
  revision: number;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  bodyZh?: string;
  bodyEn?: string | null;
  rawNotes?: string | null;
}

export interface CsteixWuxuImportItem {
  slug: string;
  title: string;
  titleEn?: string | null;
  dimensions: string[];
  writtenAt: string;
  timezone?: string;
  bodyZh: string;
  bodyEn?: string | null;
  rawNotes?: string | null;
}

export interface CsteixDwellRecord {
  id?: string;
  day?: string;
  dayKey?: string;
  date?: string;
  startedAt?: string;
  endedAt?: string;
  recordedAt?: string;
  pillar?: string;
  dimension?: string;
  page?: string;
  durationSeconds?: number;
  seconds?: number;
  durationMinutes?: number;
  totals?: Record<string, number>;
  byPillar?: Record<string, number>;
  [key: string]: unknown;
}

export interface CsteixMeditationRecord {
  id?: string;
  day?: string;
  dayKey?: string;
  date?: string;
  startedAt?: string;
  endedAt?: string;
  recordedAt?: string;
  pillar?: string;
  dimension?: string;
  page?: string;
  durationSeconds?: number;
  seconds?: number;
  durationMinutes?: number;
  totals?: Record<string, number>;
  byPillar?: Record<string, number>;
  [key: string]: unknown;
}

export interface CsteixMarkRecord {
  id?: string;
  day?: string;
  dayKey?: string;
  date?: string;
  occurredAt?: string;
  recordedAt?: string;
  createdAt?: string;
  kind?: string;
  mark?: string;
  pillar?: string;
  dimension?: string;
  page?: string;
  count?: number;
  [key: string]: unknown;
}

export interface SnapshotUploadBody {
  schemaVersion?: string;
  app?: AgentAppID;
  bundleId: string;
  appVersion: string;
  permission: PermissionTier;
  policy?: PermissionPolicy;
  capabilities: string[];
  lastSyncAt?: string;
  catalog?: unknown;
  summary?: unknown;
  datasets?: Record<string, unknown | null>;
}
