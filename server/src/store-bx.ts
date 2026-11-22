import {
  dateKeyInUtcCalendar,
  generateRequestId,
  localDateKey,
  localDateTimeParts,
  matchesDateRange,
  matchesQuery,
  normalizePagination,
  paginate,
  rankFuzzyMatches,
  requireNonEmptyString,
  resolveBxTimestamp,
  safeJsonParse
} from "./store-helpers.js";
import { AppStateRow, parsePolicyFromRow } from "./store-helpers.js";
import {
  AgentAppID,
  BxCatalog,
  BxExerciseInfo,
  BxFoodRecord,
  BxSetGroup,
  BxSetRecord,
  BxSkinProduct,
  BxSkinRecord,
  BxSleepNight,
  BxToiletKind,
  BxToiletRecord,
  BxWorkoutRecord,
  InboxEnvelope,
  PermissionAction,
  PermissionPolicy,
  Receipt
} from "./types.js";

export const VALID_MEAL_TYPES = new Set(["breakfast", "lunch", "dinner", "snack"]);
export const VALID_SKIN_PRODUCTS = new Set(["sunscreen", "moisturizer", "bodyLotion", "medicine", "other"]);
export const VALID_TOILET_KINDS = new Set(["bowel", "urination"]);

export interface BxStoreContext {
  assertReadAccess?(app: AgentAppID): Promise<{ row: AppStateRow | null; policy: PermissionPolicy | null }>;
  assertDomainReadAllowed(app: AgentAppID, domain: string): Promise<void>;
  assertActionAllowed(app: AgentAppID, action: PermissionAction, domain: string): Promise<{ catalog_json: string | null }>;
  assertActionDomainAllowed?(app: AgentAppID, domain: string): Promise<void>;
  readDataset<T>(app: AgentAppID, domain: string): Promise<T[] | null>;
  readAppTimeZone?(app: AgentAppID): Promise<string | undefined>;
  readAppCatalog?<T>(app: AgentAppID): Promise<T | null>;
  listPendingEnvelopes(app: AgentAppID): Promise<InboxEnvelope[]>;
  lookupReceiptByRequestId?(app: AgentAppID, requestId: string): Promise<Receipt | null>;
  findPendingEnvelope?(app: AgentAppID, requestId: string): Promise<InboxEnvelope | null>;
  updatePendingEnvelopePayload?(app: AgentAppID, requestId: string, payload: Record<string, unknown>): Promise<void>;
  deletePendingEnvelope?(app: AgentAppID, requestId: string): Promise<boolean>;
  enqueueInbox(
    app: AgentAppID,
    op: string,
    requestId: string,
    client: string | undefined,
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
}

function validateSetGroups(raw: unknown): BxSetGroup[] {
  if (!Array.isArray(raw)) {
    throw new Error("'setGroups' must be an array of { reps, sets, weightKg? }.");
  }
  return raw.map((item, idx) => {
    if (!item || typeof item !== "object") {
      throw new Error(`setGroups[${idx}] must be an object.`);
    }
    const obj = item as Record<string, unknown>;
    const reps = Number(obj.reps);
    const sets = Number(obj.sets);
    if (!Number.isInteger(reps) || reps < 1 || reps > 100) {
      throw new Error(`setGroups[${idx}].reps must be an integer between 1 and 100.`);
    }
    if (!Number.isInteger(sets) || sets < 1 || sets > 20) {
      throw new Error(`setGroups[${idx}].sets must be an integer between 1 and 20.`);
    }
    const out: BxSetGroup = { reps, sets };
    const weightRaw = obj.weightKg ?? obj.weight;
    if (weightRaw !== undefined && weightRaw !== null) {
      const weightKg = Number(weightRaw);
      if (!Number.isFinite(weightKg) || weightKg < 0.01 || weightKg > 999) {
        throw new Error(`setGroups[${idx}].weightKg must be between 0.01 and 999.`);
      }
      out.weightKg = Math.round(weightKg * 100) / 100;
    }
    return out;
  });
}

function validateRawSets(raw: unknown): BxSetRecord[] {
  if (!Array.isArray(raw)) {
    throw new Error("'sets' must be an array of set records.");
  }
  return raw.map((item, idx) => {
    if (!item || typeof item !== "object") {
      throw new Error(`sets[${idx}] must be an object.`);
    }
    const obj = item as Record<string, unknown>;
    const out: BxSetRecord = {};
    if (obj.reps !== undefined && obj.reps !== null) {
      const reps = Number(obj.reps);
      if (!Number.isInteger(reps) || reps < 1 || reps > 100) {
        throw new Error(`sets[${idx}].reps must be an integer 1..100.`);
      }
      out.reps = reps;
    }
    const weightRaw = obj.weightKg ?? obj.weight;
    if (weightRaw !== undefined && weightRaw !== null) {
      const weightKg = Number(weightRaw);
      if (!Number.isFinite(weightKg) || weightKg < 0.01 || weightKg > 999) {
        throw new Error(`sets[${idx}].weightKg must be 0.01..999.`);
      }
      out.weightKg = Math.round(weightKg * 100) / 100;
    }
    if (obj.rpe !== undefined && obj.rpe !== null) {
      const rpe = Number(obj.rpe);
      if (!Number.isFinite(rpe) || rpe < 1 || rpe > 10) {
        throw new Error(`sets[${idx}].rpe must be between 1 and 10.`);
      }
      out.rpe = Math.round(rpe * 10) / 10;
    }
    if (obj.durationSeconds !== undefined && obj.durationSeconds !== null) {
      const duration = Number(obj.durationSeconds);
      if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error(`sets[${idx}].durationSeconds must be > 0.`);
      }
      out.durationSeconds = Math.round(duration * 10) / 10;
    }
    return out;
  });
}

function resolveExerciseHint(
  query: string,
  exercises: BxExerciseInfo[] | null
): BxExerciseInfo | undefined {
  const norm = query.trim().toLowerCase();
  if (!norm || !exercises?.length) return undefined;
  return (
    exercises.find((ex) => ex.id.toLowerCase() === norm || ex.key.toLowerCase() === norm) ??
    exercises.find(
      (ex) =>
        ex.nameZh.toLowerCase() === norm ||
        ex.nameEn.toLowerCase() === norm ||
        (ex.aliases ?? []).some((a) => a.toLowerCase() === norm)
    )
  );
}

function suggestExercises(
  query: string,
  exercises: BxExerciseInfo[] | null,
  maxResults = 5
): Array<{ key: string; nameZh: string; nameEn: string; equipment: string[] }> {
  if (!exercises?.length) return [];
  const labelToEx = new Map<string, BxExerciseInfo>();
  const labels: string[] = [];
  for (const ex of exercises) {
    const label = [ex.key, ex.nameZh, ex.nameEn, ...(ex.aliases ?? [])].join(" | ");
    labelToEx.set(label, ex);
    labels.push(label);
  }
  return rankFuzzyMatches(query, labels, maxResults)
    .map((label) => labelToEx.get(label))
    .filter((ex): ex is BxExerciseInfo => ex !== undefined)
    .map((ex) => ({
      key: ex.key,
      nameZh: ex.nameZh,
      nameEn: ex.nameEn,
      equipment: ex.equipment
    }));
}

function computeExerciseSetStats(ex: {
  setGroups?: BxSetGroup[];
  totalSets?: number;
  totalVolumeKg?: number;
}): { sets: number; volumeKg: number } {
  if (Array.isArray(ex.setGroups) && ex.setGroups.length > 0) {
    let sets = 0;
    let volumeKg = 0;
    for (const g of ex.setGroups) {
      const s = Number(g.sets ?? 0);
      const r = Number(g.reps ?? 0);
      const w = Number(g.weightKg ?? 0);
      sets += s;
      if (w > 0 && r > 0 && s > 0) {
        volumeKg += s * r * w;
      }
    }
    return { sets, volumeKg };
  }
  return {
    sets: Number(ex.totalSets ?? 0),
    volumeKg: Number(ex.totalVolumeKg ?? 0)
  };
}

function attachBxLocalTime(
  result: Record<string, unknown>,
  recordedAt: string | undefined,
  timeZone: string | undefined
): Record<string, unknown> {
  if (!recordedAt) return result;
  const meta = localDateTimeParts(recordedAt, timeZone);
  if (!meta) return result;
  return {
    ...result,
    resolvedLocalTime: {
      recordedAt,
      localDate: meta.localDate,
      localTime: meta.localTime,
      timeZoneIdentifier: timeZone ?? "UTC"
    }
  };
}

export class BxOperations {
  constructor(private readonly ctx: BxStoreContext) {}

  // MARK: - Reads

  async listSleep(options: {
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<Record<string, unknown>> {
    await this.ctx.assertDomainReadAllowed("bx", "sleep");
    const dataset = await this.ctx.readDataset<BxSleepNight>("bx", "sleep");
    const all = dataset ?? [];
    const filtered = all.filter((night) => matchesDateRange(night.end ?? night.day, options.from, options.to, night.day));
    const { limit, offset } = normalizePagination(options);
    const page = paginate(filtered, limit, offset);
    const avgAsleep =
      filtered.length > 0
        ? Math.round((filtered.reduce((sum, n) => sum + n.asleepMinutes, 0) / filtered.length) * 10) / 10
        : null;

    return {
      source: "apple_health",
      readOnly: true,
      datasetUploaded: dataset !== null,
      averageAsleepMinutes: avgAsleep,
      ...page
    };
  }

  async listExercises(options: {
    query?: string;
    group?: string;
    equipment?: string;
    limit?: number;
  } = {}): Promise<Record<string, unknown>> {
    await this.ctx.assertDomainReadAllowed("bx", "workouts");
    const dataset = await this.ctx.readDataset<BxExerciseInfo>("bx", "exercises");
    let items = dataset ?? [];
    if (options.group?.trim()) {
      const grp = options.group.trim().toLowerCase();
      items = items.filter((ex) => ex.group.toLowerCase() === grp);
    }
    if (options.equipment?.trim()) {
      const eq = options.equipment.trim().toLowerCase();
      items = items.filter((ex) => ex.equipment.some((e) => e.toLowerCase().includes(eq)));
    }
    if (options.query?.trim()) {
      items = items.filter((ex) =>
        matchesQuery(options.query, [ex.key, ex.nameZh, ex.nameEn, ...(ex.aliases ?? []), ...ex.equipment])
      );
    }
    const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 50), 250));
    const page = paginate(items, limit, 0);
    return {
      datasetUploaded: dataset !== null,
      ...page
    };
  }

  async listFood(options: {
    from?: string;
    to?: string;
    mealType?: string;
    query?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<Record<string, unknown>> {
    await this.ctx.assertDomainReadAllowed("bx", "food");
    const [dataset, pending, timeZone] = await Promise.all([
      this.ctx.readDataset<BxFoodRecord>("bx", "food"),
      this.ctx.listPendingEnvelopes("bx"),
      this.ctx.readAppTimeZone?.("bx") ?? Promise.resolve(undefined)
    ]);
    const items: BxFoodRecord[] = dataset ? dataset.map((item) => ({ ...item })) : [];
    const byId = new Map(items.map((item) => [item.id, item]));

    for (const env of pending) {
      if (env.op === "record_food") {
        const eatenAt = typeof env.payload.recordedAt === "string" ? env.payload.recordedAt : env.createdAt;
        const created: BxFoodRecord = {
          id: `pending:${env.requestId}`,
          eatenAt,
          meal: (env.payload.mealType as BxFoodRecord["meal"]) ?? "snack",
          name: String(env.payload.name ?? ""),
          calories: typeof env.payload.calories === "number" ? env.payload.calories : null,
          pendingStatus: "queued_create",
          pendingRequestId: env.requestId
        };
        items.unshift(created);
        byId.set(created.id, created);
      } else if (env.op === "update_food") {
        const target = byId.get(String(env.payload.id ?? ""));
        if (target) {
          if (typeof env.payload.name === "string") target.name = env.payload.name;
          if (typeof env.payload.mealType === "string") target.meal = env.payload.mealType as BxFoodRecord["meal"];
          if (env.payload.clearCalories === true) target.calories = null;
          else if (typeof env.payload.calories === "number") target.calories = env.payload.calories;
          if (typeof env.payload.recordedAt === "string") target.eatenAt = env.payload.recordedAt;
          target.pendingStatus = "queued_update";
          target.pendingRequestId = env.requestId;
        }
      } else if (env.op === "delete_food") {
        const target = byId.get(String(env.payload.id ?? ""));
        if (target) {
          target.pendingStatus = "queued_delete";
          target.pendingRequestId = env.requestId;
        }
      }
    }

    let filtered = items.filter((item) => matchesDateRange(item.eatenAt, options.from, options.to, undefined, timeZone));
    if (options.mealType?.trim()) {
      const m = options.mealType.trim().toLowerCase();
      filtered = filtered.filter((item) => item.meal.toLowerCase() === m);
    }
    if (options.query?.trim()) {
      filtered = filtered.filter((item) => matchesQuery(options.query, [item.name]));
    }
    filtered.sort((a, b) => b.eatenAt.localeCompare(a.eatenAt));

    let pendingDeleteCount = 0;
    let recordCount = 0;
    let totalCalories = 0;
    let unknownCaloriesCount = 0;
    const byMealType: Record<string, { count: number; totalCalories: number; unknownCaloriesCount: number }> = {};
    const byDate: Record<string, { count: number; totalCalories: number; unknownCaloriesCount: number }> = {};

    for (const item of filtered) {
      if (item.pendingStatus === "queued_delete") {
        pendingDeleteCount += 1;
        continue;
      }
      recordCount += 1;
      const hasCal = typeof item.calories === "number" && Number.isFinite(item.calories);
      const cal = hasCal ? Number(item.calories) : 0;
      if (hasCal) totalCalories += cal;
      else unknownCaloriesCount += 1;

      const mealKey = item.meal || "snack";
      const mealBucket = byMealType[mealKey] ?? { count: 0, totalCalories: 0, unknownCaloriesCount: 0 };
      mealBucket.count += 1;
      if (hasCal) mealBucket.totalCalories = Math.round((mealBucket.totalCalories + cal) * 10) / 10;
      else mealBucket.unknownCaloriesCount += 1;
      byMealType[mealKey] = mealBucket;

      const dateKey = localDateKey(item.eatenAt, timeZone) || item.eatenAt.slice(0, 10);
      if (dateKey) {
        const dateBucket = byDate[dateKey] ?? { count: 0, totalCalories: 0, unknownCaloriesCount: 0 };
        dateBucket.count += 1;
        if (hasCal) dateBucket.totalCalories = Math.round((dateBucket.totalCalories + cal) * 10) / 10;
        else dateBucket.unknownCaloriesCount += 1;
        byDate[dateKey] = dateBucket;
      }
    }

    const { limit, offset } = normalizePagination(options);
    return {
      datasetUploaded: dataset !== null,
      timeZoneIdentifier: timeZone ?? null,
      aggregates: {
        recordCount,
        pendingDeleteCount,
        totalCalories: Math.round(totalCalories * 10) / 10,
        unknownCaloriesCount,
        byMealType,
        byDate
      },
      ...paginate(filtered, limit, offset)
    };
  }

  async listSkin(options: {
    from?: string;
    to?: string;
    product?: string;
    query?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<Record<string, unknown>> {
    await this.ctx.assertDomainReadAllowed("bx", "skin");
    const [dataset, pending, timeZone] = await Promise.all([
      this.ctx.readDataset<BxSkinRecord>("bx", "skin"),
      this.ctx.listPendingEnvelopes("bx"),
      this.ctx.readAppTimeZone?.("bx") ?? Promise.resolve(undefined)
    ]);
    const items: BxSkinRecord[] = dataset ? dataset.map((item) => ({ ...item })) : [];
    const byId = new Map(items.map((item) => [item.id, item]));

    for (const env of pending) {
      if (env.op === "record_skin") {
        const appliedAt = typeof env.payload.recordedAt === "string" ? env.payload.recordedAt : env.createdAt;
        const created: BxSkinRecord = {
          id: `pending:${env.requestId}`,
          appliedAt,
          product: (env.payload.product as BxSkinProduct) ?? "other",
          name: String(env.payload.name ?? ""),
          pendingStatus: "queued_create",
          pendingRequestId: env.requestId
        };
        items.unshift(created);
        byId.set(created.id, created);
      } else if (env.op === "update_skin") {
        const target = byId.get(String(env.payload.id ?? ""));
        if (target) {
          if (typeof env.payload.product === "string") target.product = env.payload.product as BxSkinProduct;
          if (typeof env.payload.name === "string") target.name = env.payload.name;
          if (typeof env.payload.recordedAt === "string") target.appliedAt = env.payload.recordedAt;
          target.pendingStatus = "queued_update";
          target.pendingRequestId = env.requestId;
        }
      } else if (env.op === "delete_skin") {
        const target = byId.get(String(env.payload.id ?? ""));
        if (target) {
          target.pendingStatus = "queued_delete";
          target.pendingRequestId = env.requestId;
        }
      }
    }

    let filtered = items.filter((item) => matchesDateRange(item.appliedAt, options.from, options.to, undefined, timeZone));
    if (options.product?.trim()) {
      const prod = options.product.trim().toLowerCase();
      filtered = filtered.filter((item) => item.product.toLowerCase() === prod);
    }
    if (options.query?.trim()) {
      filtered = filtered.filter((item) => matchesQuery(options.query, [item.name, item.product]));
    }
    filtered.sort((a, b) => b.appliedAt.localeCompare(a.appliedAt));

    const { limit, offset } = normalizePagination(options);
    return {
      datasetUploaded: dataset !== null,
      timeZoneIdentifier: timeZone ?? null,
      ...paginate(filtered, limit, offset)
    };
  }

  async listToilet(options: {
    from?: string;
    to?: string;
    kind?: string;
    stoolType?: number;
    query?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<Record<string, unknown>> {
    await this.ctx.assertDomainReadAllowed("bx", "toilet");
    const [dataset, pending, timeZone] = await Promise.all([
      this.ctx.readDataset<BxToiletRecord>("bx", "toilet"),
      this.ctx.listPendingEnvelopes("bx"),
      this.ctx.readAppTimeZone?.("bx") ?? Promise.resolve(undefined)
    ]);
    const items: BxToiletRecord[] = dataset ? dataset.map((item) => ({ ...item })) : [];
    const byId = new Map(items.map((item) => [item.id, item]));

    for (const env of pending) {
      if (env.op === "record_toilet") {
        const occurredAt = typeof env.payload.recordedAt === "string" ? env.payload.recordedAt : env.createdAt;
        const created: BxToiletRecord = {
          id: `pending:${env.requestId}`,
          occurredAt,
          kind: (env.payload.kind as BxToiletKind) ?? "bowel",
          stoolType: typeof env.payload.stoolType === "number" ? env.payload.stoolType : null,
          note: String(env.payload.note ?? ""),
          pendingStatus: "queued_create",
          pendingRequestId: env.requestId
        };
        items.unshift(created);
        byId.set(created.id, created);
      } else if (env.op === "update_toilet") {
        const target = byId.get(String(env.payload.id ?? ""));
        if (target) {
          if (typeof env.payload.kind === "string") target.kind = env.payload.kind as BxToiletKind;
          if (typeof env.payload.stoolType === "number") target.stoolType = env.payload.stoolType;
          if (target.kind === "urination") target.stoolType = null;
          if (typeof env.payload.note === "string") target.note = env.payload.note;
          if (typeof env.payload.recordedAt === "string") target.occurredAt = env.payload.recordedAt;
          target.pendingStatus = "queued_update";
          target.pendingRequestId = env.requestId;
        }
      } else if (env.op === "delete_toilet") {
        const target = byId.get(String(env.payload.id ?? ""));
        if (target) {
          target.pendingStatus = "queued_delete";
          target.pendingRequestId = env.requestId;
        }
      }
    }

    let filtered = items.filter((item) => matchesDateRange(item.occurredAt, options.from, options.to, undefined, timeZone));
    if (options.kind?.trim()) {
      const k = options.kind.trim().toLowerCase();
      filtered = filtered.filter((item) => item.kind.toLowerCase() === k);
    }
    if (typeof options.stoolType === "number") {
      filtered = filtered.filter((item) => item.stoolType === options.stoolType);
    }
    if (options.query?.trim()) {
      filtered = filtered.filter((item) => matchesQuery(options.query, [item.note]));
    }
    filtered.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

    const { limit, offset } = normalizePagination(options);
    return {
      datasetUploaded: dataset !== null,
      timeZoneIdentifier: timeZone ?? null,
      ...paginate(filtered, limit, offset)
    };
  }

  async listWorkouts(options: {
    from?: string;
    to?: string;
    activityType?: string;
    exerciseQuery?: string;
    equipment?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<Record<string, unknown>> {
    await this.ctx.assertDomainReadAllowed("bx", "workouts");
    const [dataset, exerciseCatalog, pending, timeZone] = await Promise.all([
      this.ctx.readDataset<BxWorkoutRecord>("bx", "workouts"),
      this.ctx.readDataset<BxExerciseInfo>("bx", "exercises"),
      this.ctx.listPendingEnvelopes("bx"),
      this.ctx.readAppTimeZone?.("bx") ?? Promise.resolve(undefined)
    ]);
    const workouts: BxWorkoutRecord[] = dataset
      ? dataset.map((w) => ({ ...w, exercises: w.exercises.map((e) => ({ ...e })) }))
      : [];
    const byWorkoutId = new Map(workouts.map((w) => [w.id, w]));

    for (const env of pending) {
      if (env.op === "update_workout_type") {
        const target = byWorkoutId.get(String(env.payload.workoutId ?? ""));
        if (target) {
          if (env.payload.clearType === true) {
            target.chosenActivityName = null;
            target.effectiveActivityName = target.healthActivityName ?? "Other";
            target.pendingStatus = "queued_update";
          } else if (typeof env.payload.activityType === "string") {
            target.chosenActivityName = env.payload.activityType;
            target.effectiveActivityName = env.payload.activityType;
            target.pendingStatus = "queued_update";
          }
        }
      } else if (env.op === "add_workout_exercise") {
        const target = byWorkoutId.get(String(env.payload.workoutId ?? ""));
        if (target) {
          const exQuery = String(env.payload.exercise ?? "");
          const resolved = resolveExerciseHint(exQuery, exerciseCatalog);
          const groups = Array.isArray(env.payload.setGroups) ? (env.payload.setGroups as BxSetGroup[]) : [];
          target.exercises.push({
            entryId: `pending:${env.requestId}`,
            workoutId: target.id,
            exerciseId: resolved?.id ?? "",
            exerciseKey: resolved?.key ?? exQuery,
            nameZh: resolved?.nameZh ?? exQuery,
            nameEn: resolved?.nameEn ?? exQuery,
            muscleGroup: resolved?.group,
            equipment: resolved?.equipment ?? [],
            position: target.exercises.length,
            setGroups: groups,
            ...(Array.isArray(env.payload.sets) ? { sets: env.payload.sets as BxSetRecord[] } : {}),
            pendingStatus: "queued_create"
          });
        }
      } else if (env.op === "update_workout_exercise" || env.op === "delete_workout_exercise") {
        const entryId = String(env.payload.entryId ?? "");
        for (const workout of workouts) {
          const entry = workout.exercises.find((e) => e.entryId === entryId);
          if (entry) {
            if (env.op === "delete_workout_exercise") {
              entry.pendingStatus = "queued_delete";
            } else {
              if (typeof env.payload.exercise === "string") {
                const resolved = resolveExerciseHint(env.payload.exercise, exerciseCatalog);
                entry.exerciseId = resolved?.id ?? entry.exerciseId;
                entry.exerciseKey = resolved?.key ?? env.payload.exercise;
                entry.nameZh = resolved?.nameZh ?? env.payload.exercise;
                entry.nameEn = resolved?.nameEn ?? env.payload.exercise;
                entry.muscleGroup = resolved?.group ?? entry.muscleGroup;
                entry.equipment = resolved?.equipment ?? entry.equipment;
              }
              if (Array.isArray(env.payload.setGroups)) entry.setGroups = env.payload.setGroups as BxSetGroup[];
              if (Array.isArray(env.payload.sets)) entry.sets = env.payload.sets as BxSetRecord[];
              if (env.payload.clearSets === true) {
                entry.setGroups = [];
                entry.sets = [];
              }
              if (typeof env.payload.position === "number") {
                entry.position = env.payload.position;
              }
              entry.pendingStatus = "queued_update";
            }
          }
        }
      } else if (env.op === "reorder_workout_exercises") {
        const target = byWorkoutId.get(String(env.payload.workoutId ?? ""));
        const orderedIds = Array.isArray(env.payload.entryIds) ? env.payload.entryIds.map(String) : [];
        if (target && orderedIds.length > 0) {
          const rankMap = new Map(orderedIds.map((id, idx) => [id, idx]));
          target.exercises.sort((a, b) => {
            const ra = rankMap.get(a.entryId) ?? Number.MAX_SAFE_INTEGER;
            const rb = rankMap.get(b.entryId) ?? Number.MAX_SAFE_INTEGER;
            return ra - rb || a.position - b.position;
          });
          target.exercises.forEach((ex, idx) => {
            ex.position = idx;
          });
          target.pendingStatus = "queued_update";
        }
      }
    }

    for (const workout of workouts) {
      workout.exercises.sort((a, b) => a.position - b.position);
    }

    let filtered = workouts.filter((w) => matchesDateRange(w.start, options.from, options.to, undefined, timeZone));
    if (options.activityType?.trim()) {
      const act = options.activityType.trim().toLowerCase();
      filtered = filtered.filter((w) =>
        matchesQuery(act, [w.effectiveActivityName, w.chosenActivityName, w.healthActivityName])
      );
    }
    if (options.exerciseQuery?.trim()) {
      filtered = filtered.filter((w) =>
        w.exercises.some((ex) => matchesQuery(options.exerciseQuery, [ex.exerciseKey, ex.nameZh, ex.nameEn]))
      );
    }
    if (options.equipment?.trim()) {
      const eq = options.equipment.trim().toLowerCase();
      filtered = filtered.filter((w) =>
        w.exercises.some((ex) => (ex.equipment ?? []).some((item) => item.toLowerCase().includes(eq)))
      );
    }
    filtered.sort((a, b) => b.start.localeCompare(a.start));

    let totalDurationMinutes = 0;
    let totalActiveEnergyKcal = 0;
    let totalSets = 0;
    let totalVolumeKg = 0;
    const byActivityType: Record<string, { count: number; durationMinutes: number }> = {};

    for (const w of filtered) {
      totalDurationMinutes += Number(w.durationMinutes ?? 0);
      if (typeof w.activeEnergyKcal === "number" && Number.isFinite(w.activeEnergyKcal)) {
        totalActiveEnergyKcal += w.activeEnergyKcal;
      }
      for (const ex of w.exercises) {
        if (ex.pendingStatus === "queued_delete") continue;
        const stats = computeExerciseSetStats(ex);
        totalSets += stats.sets;
        totalVolumeKg += stats.volumeKg;
      }
      const actKey = w.effectiveActivityName || w.healthActivityName || "Other";
      const actBucket = byActivityType[actKey] ?? { count: 0, durationMinutes: 0 };
      actBucket.count += 1;
      actBucket.durationMinutes = Math.round((actBucket.durationMinutes + Number(w.durationMinutes ?? 0)) * 10) / 10;
      byActivityType[actKey] = actBucket;
    }

    const { limit, offset } = normalizePagination(options);
    return {
      frameReadOnlyNote: "Apple Health workout timing, energy, and heart rate are read-only. Only chosenType (for 'other') and exercise/set annotations are mutable.",
      datasetUploaded: dataset !== null,
      timeZoneIdentifier: timeZone ?? null,
      aggregates: {
        workoutCount: filtered.length,
        totalDurationMinutes: Math.round(totalDurationMinutes * 10) / 10,
        totalActiveEnergyKcal: Math.round(totalActiveEnergyKcal * 10) / 10,
        totalSets,
        totalVolumeKg: Math.round(totalVolumeKg * 10) / 10,
        byActivityType
      },
      ...paginate(filtered, limit, offset)
    };
  }

  private async resolvePendingBxTarget(
    rawId: string,
    domain: string,
    mode: "update" | "delete",
    expectedCreateOp: string
  ): Promise<
    | { kind: "committed"; id: string; resolvedFromSyncedReceipt?: boolean }
    | { kind: "pending"; requestId: string; envelope: InboxEnvelope }
  > {
    if (!rawId.startsWith("pending:")) {
      return { kind: "committed", id: rawId };
    }
    const reqId = rawId.slice("pending:".length).trim();
    if (!reqId) {
      throw new Error("Invalid pending id. Expected 'pending:<requestId>'.");
    }
    const pending = await this.ctx.findPendingEnvelope?.("bx", reqId);
    if (pending) {
      if (pending.op !== expectedCreateOp) {
        throw new Error(
          `Pending request '${reqId}' is '${pending.op}', expected '${expectedCreateOp}'.`
        );
      }
      if (this.ctx.assertReadAccess) {
        const { row, policy } = await this.ctx.assertReadAccess("bx");
        if (row && policy) {
          if (row.permission === "disabled") {
            throw new Error("App 'bx' is paused ('disabled'). Enable permissions in BX Settings -> AI Assistant.");
          }
          if (!policy.allowedDomains.includes(domain)) {
            throw new Error(`Category '${domain}' is turned off by user policy in BX.`);
          }
          if (mode === "update" && !policy.allowUpdate && !policy.allowCreate) {
            throw new Error("BX permission policy does not allow updating this queued entry.");
          }
          if (mode === "delete" && !policy.allowDelete && !policy.allowCreate) {
            throw new Error("BX permission policy does not allow cancelling this queued entry.");
          }
        }
      }
      return { kind: "pending", requestId: reqId, envelope: pending };
    }
    const receipt = await this.ctx.lookupReceiptByRequestId?.("bx", reqId);
    if (receipt?.status === "applied" && receipt.recordId) {
      await this.ctx.assertActionAllowed("bx", mode, domain);
      return { kind: "committed", id: receipt.recordId, resolvedFromSyncedReceipt: true };
    }
    if (receipt) {
      throw new Error(
        `Request '${reqId}' already processed with status '${receipt.status}'${receipt.errorMessage ? `: ${receipt.errorMessage}` : ""}.`
      );
    }
    throw new Error(`Pending BX request '${reqId}' was not found in inbox or synced receipts.`);
  }

  // MARK: - Food CRUD

  async recordFood(input: {
    name: string;
    mealType?: string;
    calories?: number;
    recordedAt?: string;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    const [state, timeZone] = await Promise.all([
      this.ctx.assertActionAllowed("bx", "create", "food"),
      this.ctx.readAppTimeZone?.("bx") ?? Promise.resolve(undefined)
    ]);
    const name = requireNonEmptyString(input.name, "name");
    if (input.calories !== undefined && (!Number.isFinite(input.calories) || input.calories < 0)) {
      throw new Error("BX food 'calories' must be >= 0 when provided.");
    }
    if (input.mealType !== undefined && !VALID_MEAL_TYPES.has(input.mealType)) {
      throw new Error(`Invalid mealType '${input.mealType}'. Allowed: breakfast, lunch, dinner, snack.`);
    }
    const catalog = safeJsonParse<BxCatalog>(state.catalog_json);
    const effectiveTz = timeZone || catalog?.timeZoneIdentifier?.trim() || undefined;
    if (input.mealType !== undefined && catalog?.mealTypes?.length && !catalog.mealTypes.includes(input.mealType)) {
      throw new Error(`mealType '${input.mealType}' is not listed in BX catalog.`);
    }

    const payload: Record<string, unknown> = { name };
    if (input.mealType !== undefined) payload.mealType = input.mealType;
    if (input.calories !== undefined) payload.calories = Math.round(input.calories * 10) / 10;
    const recordedAt = resolveBxTimestamp(input.recordedAt, "recordedAt", effectiveTz);
    if (recordedAt) payload.recordedAt = recordedAt;

    const requestId = input.requestId?.trim() || generateRequestId("bx-food");
    payload.stableID = `bx:remote:${requestId}`;
    const res = await this.ctx.enqueueInbox("bx", "record_food", requestId, input.client, payload);
    const normPayload = res.normalizedPayload as Record<string, unknown> | undefined;
    const effTs = typeof normPayload?.recordedAt === "string" ? normPayload.recordedAt : undefined;
    return res.queued === true ? attachBxLocalTime(res, effTs, effectiveTz) : res;
  }

  async updateFood(input: {
    id: string;
    name?: string;
    mealType?: string;
    calories?: number;
    clearCalories?: boolean;
    recordedAt?: string;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    const rawId = requireNonEmptyString(input.id, "id");
    const target = await this.resolvePendingBxTarget(rawId, "food", "update", "record_food");
    const timeZone = await this.ctx.readAppTimeZone?.("bx");

    if (target.kind === "committed") {
      await this.ctx.assertActionAllowed("bx", "update", "food");
    }

    const updates: Record<string, unknown> = {};
    if (input.name !== undefined) {
      updates.name = requireNonEmptyString(input.name, "name");
    }
    if (input.mealType !== undefined) {
      if (!VALID_MEAL_TYPES.has(input.mealType)) {
        throw new Error(`Invalid mealType '${input.mealType}'. Allowed: breakfast, lunch, dinner, snack.`);
      }
      updates.mealType = input.mealType;
    }
    if (input.clearCalories === true) {
      updates.clearCalories = true;
    } else if (input.calories !== undefined) {
      if (!Number.isFinite(input.calories) || input.calories < 0) {
        throw new Error("BX food 'calories' must be >= 0 (or pass clearCalories: true to clear).");
      }
      updates.calories = Math.round(input.calories * 10) / 10;
    }
    const recordedAt = resolveBxTimestamp(input.recordedAt, "recordedAt", timeZone);
    if (recordedAt) updates.recordedAt = recordedAt;

    if (Object.keys(updates).length === 0) {
      throw new Error("update_food requires at least one field to update (name, mealType, calories, clearCalories, recordedAt).");
    }

    if (target.kind === "pending" && this.ctx.updatePendingEnvelopePayload) {
      const nextPayload: Record<string, unknown> = { ...target.envelope.payload, ...updates };
      if (updates.clearCalories === true) {
        delete nextPayload.calories;
        delete nextPayload.clearCalories;
      }
      await this.ctx.updatePendingEnvelopePayload("bx", target.requestId, nextPayload);
      const effTs = typeof nextPayload.recordedAt === "string" ? nextPayload.recordedAt : undefined;
      return attachBxLocalTime(
        {
          queued: true,
          updatedPending: true,
          app: "bx",
          op: "update_food",
          requestId: target.requestId,
          normalizedPayload: nextPayload
        },
        effTs,
        timeZone
      );
    }

    const resolvedId = target.kind === "committed" ? target.id : rawId;
    const payload: Record<string, unknown> = { id: resolvedId, ...updates };
    const requestId = input.requestId?.trim() || generateRequestId("bx-food-upd");
    const res = await this.ctx.enqueueInbox("bx", "update_food", requestId, input.client, payload);
    const enriched = res.queued === true ? attachBxLocalTime(res, recordedAt, timeZone) : res;
    return target.kind === "committed" && target.resolvedFromSyncedReceipt
      ? { ...enriched, resolvedFromSyncedReceipt: true }
      : enriched;
  }

  async deleteFood(input: { id: string; requestId?: string; client?: string }): Promise<Record<string, unknown>> {
    const rawId = requireNonEmptyString(input.id, "id");
    const target = await this.resolvePendingBxTarget(rawId, "food", "delete", "record_food");
    if (target.kind === "pending" && this.ctx.deletePendingEnvelope) {
      await this.ctx.deletePendingEnvelope("bx", target.requestId);
      return { queued: false, cancelledPending: true, app: "bx", op: "record_food", requestId: target.requestId };
    }
    await this.ctx.assertActionAllowed("bx", "delete", "food");
    const resolvedId = target.kind === "committed" ? target.id : rawId;
    const requestId = input.requestId?.trim() || generateRequestId("bx-food-del");
    const res = await this.ctx.enqueueInbox("bx", "delete_food", requestId, input.client, { id: resolvedId });
    return target.kind === "committed" && target.resolvedFromSyncedReceipt
      ? { ...res, resolvedFromSyncedReceipt: true }
      : res;
  }

  // MARK: - Skin / Medication CRUD

  async recordSkin(input: {
    product: string;
    name?: string;
    brand?: string;
    recordedAt?: string;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    const [state, timeZone] = await Promise.all([
      this.ctx.assertActionAllowed("bx", "create", "skin"),
      this.ctx.readAppTimeZone?.("bx") ?? Promise.resolve(undefined)
    ]);
    if (!VALID_SKIN_PRODUCTS.has(input.product)) {
      throw new Error(
        `Invalid product '${input.product}'. Allowed: sunscreen, moisturizer, bodyLotion, medicine, other.`
      );
    }
    const catalog = safeJsonParse<BxCatalog>(state.catalog_json);
    const effectiveTz = timeZone || catalog?.timeZoneIdentifier?.trim() || undefined;
    if (catalog?.skinProducts?.length && !catalog.skinProducts.includes(input.product)) {
      throw new Error(`product '${input.product}' is not listed in BX catalog.`);
    }

    const payload: Record<string, unknown> = { product: input.product };
    const resolvedName = input.name?.trim() || input.brand?.trim();
    if (resolvedName) payload.name = resolvedName;
    const recordedAt = resolveBxTimestamp(input.recordedAt, "recordedAt", effectiveTz);
    if (recordedAt) payload.recordedAt = recordedAt;

    const requestId = input.requestId?.trim() || generateRequestId("bx-skin");
    payload.stableID = `bx:remote:${requestId}`;
    const res = await this.ctx.enqueueInbox("bx", "record_skin", requestId, input.client, payload);
    const normPayload = res.normalizedPayload as Record<string, unknown> | undefined;
    const effTs = typeof normPayload?.recordedAt === "string" ? normPayload.recordedAt : undefined;
    return res.queued === true ? attachBxLocalTime(res, effTs, effectiveTz) : res;
  }

  async updateSkin(input: {
    id: string;
    product?: string;
    name?: string;
    recordedAt?: string;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    const rawId = requireNonEmptyString(input.id, "id");
    const target = await this.resolvePendingBxTarget(rawId, "skin", "update", "record_skin");
    const timeZone = await this.ctx.readAppTimeZone?.("bx");
    if (target.kind === "committed") {
      await this.ctx.assertActionAllowed("bx", "update", "skin");
    }

    const updates: Record<string, unknown> = {};
    if (input.product !== undefined) {
      if (!VALID_SKIN_PRODUCTS.has(input.product)) {
        throw new Error(
          `Invalid product '${input.product}'. Allowed: sunscreen, moisturizer, bodyLotion, medicine, other.`
        );
      }
      updates.product = input.product;
    }
    if (input.name !== undefined) updates.name = input.name.trim();
    const recordedAt = resolveBxTimestamp(input.recordedAt, "recordedAt", timeZone);
    if (recordedAt) updates.recordedAt = recordedAt;

    if (Object.keys(updates).length === 0) {
      throw new Error("update_skin requires at least one field to update (product, name, recordedAt).");
    }

    if (target.kind === "pending" && this.ctx.updatePendingEnvelopePayload) {
      const nextPayload: Record<string, unknown> = { ...target.envelope.payload, ...updates };
      if (nextPayload.name === "") delete nextPayload.name;
      await this.ctx.updatePendingEnvelopePayload("bx", target.requestId, nextPayload);
      const effTs = typeof nextPayload.recordedAt === "string" ? nextPayload.recordedAt : undefined;
      return attachBxLocalTime(
        {
          queued: true,
          updatedPending: true,
          app: "bx",
          op: "update_skin",
          requestId: target.requestId,
          normalizedPayload: nextPayload
        },
        effTs,
        timeZone
      );
    }

    const resolvedId = target.kind === "committed" ? target.id : rawId;
    const payload: Record<string, unknown> = { id: resolvedId, ...updates };
    const requestId = input.requestId?.trim() || generateRequestId("bx-skin-upd");
    const res = await this.ctx.enqueueInbox("bx", "update_skin", requestId, input.client, payload);
    const enriched = res.queued === true ? attachBxLocalTime(res, recordedAt, timeZone) : res;
    return target.kind === "committed" && target.resolvedFromSyncedReceipt
      ? { ...enriched, resolvedFromSyncedReceipt: true }
      : enriched;
  }

  async deleteSkin(input: { id: string; requestId?: string; client?: string }): Promise<Record<string, unknown>> {
    const rawId = requireNonEmptyString(input.id, "id");
    const target = await this.resolvePendingBxTarget(rawId, "skin", "delete", "record_skin");
    if (target.kind === "pending" && this.ctx.deletePendingEnvelope) {
      await this.ctx.deletePendingEnvelope("bx", target.requestId);
      return { queued: false, cancelledPending: true, app: "bx", op: "record_skin", requestId: target.requestId };
    }
    await this.ctx.assertActionAllowed("bx", "delete", "skin");
    const resolvedId = target.kind === "committed" ? target.id : rawId;
    const requestId = input.requestId?.trim() || generateRequestId("bx-skin-del");
    const res = await this.ctx.enqueueInbox("bx", "delete_skin", requestId, input.client, { id: resolvedId });
    return target.kind === "committed" && target.resolvedFromSyncedReceipt
      ? { ...res, resolvedFromSyncedReceipt: true }
      : res;
  }

  // MARK: - Toilet CRUD

  async recordToilet(input: {
    kind?: string;
    stoolType?: number;
    bristol?: number;
    note?: string;
    recordedAt?: string;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    const [state, timeZone] = await Promise.all([
      this.ctx.assertActionAllowed("bx", "create", "toilet"),
      this.ctx.readAppTimeZone?.("bx") ?? Promise.resolve(undefined)
    ]);
    const catalog = safeJsonParse<BxCatalog>(state.catalog_json);
    const effectiveTz = timeZone || catalog?.timeZoneIdentifier?.trim() || undefined;
    const kind = input.kind ?? "bowel";
    if (!VALID_TOILET_KINDS.has(kind)) {
      throw new Error(`Invalid BX toilet 'kind': ${kind}. Allowed: bowel, urination.`);
    }

    const rawStoolType = input.stoolType ?? input.bristol;
    if (kind === "bowel") {
      if (rawStoolType === undefined || !Number.isInteger(rawStoolType) || rawStoolType < 1 || rawStoolType > 7) {
        throw new Error("BX bowel events require 'stoolType' (integer Bristol scale 1..7).");
      }
    } else if (rawStoolType !== undefined) {
      throw new Error("BX urination events must not specify 'stoolType'.");
    }

    const payload: Record<string, unknown> = { kind };
    if (rawStoolType !== undefined) payload.stoolType = rawStoolType;
    if (input.note?.trim()) payload.note = input.note.trim();
    const recordedAt = resolveBxTimestamp(input.recordedAt, "recordedAt", effectiveTz);
    if (recordedAt) payload.recordedAt = recordedAt;

    const requestId = input.requestId?.trim() || generateRequestId("bx-toilet");
    payload.stableID = `bx:remote:${requestId}`;
    const res = await this.ctx.enqueueInbox("bx", "record_toilet", requestId, input.client, payload);
    const normPayload = res.normalizedPayload as Record<string, unknown> | undefined;
    const effTs = typeof normPayload?.recordedAt === "string" ? normPayload.recordedAt : undefined;
    return res.queued === true ? attachBxLocalTime(res, effTs, effectiveTz) : res;
  }

  async updateToilet(input: {
    id: string;
    kind?: string;
    stoolType?: number;
    bristol?: number;
    note?: string;
    recordedAt?: string;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    const rawId = requireNonEmptyString(input.id, "id");
    const target = await this.resolvePendingBxTarget(rawId, "toilet", "update", "record_toilet");
    const timeZone = await this.ctx.readAppTimeZone?.("bx");
    if (target.kind === "committed") {
      await this.ctx.assertActionAllowed("bx", "update", "toilet");
    }

    const updates: Record<string, unknown> = {};
    if (input.kind !== undefined) {
      if (!VALID_TOILET_KINDS.has(input.kind)) {
        throw new Error(`Invalid BX toilet 'kind': ${input.kind}. Allowed: bowel, urination.`);
      }
      updates.kind = input.kind;
    }
    const rawStool = input.stoolType ?? input.bristol;
    if (rawStool !== undefined) {
      if (!Number.isInteger(rawStool) || rawStool < 1 || rawStool > 7) {
        throw new Error("Bristol 'stoolType' must be an integer 1..7.");
      }
      if (input.kind === "urination") {
        throw new Error("BX urination events must not specify 'stoolType'.");
      }
      updates.stoolType = rawStool;
    }
    if (input.note !== undefined) updates.note = input.note.trim();
    const recordedAt = resolveBxTimestamp(input.recordedAt, "recordedAt", timeZone);
    if (recordedAt) updates.recordedAt = recordedAt;

    if (Object.keys(updates).length === 0) {
      throw new Error("update_toilet requires at least one field to update.");
    }

    if (target.kind === "pending" && this.ctx.updatePendingEnvelopePayload) {
      const nextPayload: Record<string, unknown> = { ...target.envelope.payload, ...updates };
      if (nextPayload.kind === "urination") {
        delete nextPayload.stoolType;
      }
      await this.ctx.updatePendingEnvelopePayload("bx", target.requestId, nextPayload);
      const effTs = typeof nextPayload.recordedAt === "string" ? nextPayload.recordedAt : undefined;
      return attachBxLocalTime(
        {
          queued: true,
          updatedPending: true,
          app: "bx",
          op: "update_toilet",
          requestId: target.requestId,
          normalizedPayload: nextPayload
        },
        effTs,
        timeZone
      );
    }

    const resolvedId = target.kind === "committed" ? target.id : rawId;
    const payload: Record<string, unknown> = { id: resolvedId, ...updates };
    const requestId = input.requestId?.trim() || generateRequestId("bx-toilet-upd");
    const res = await this.ctx.enqueueInbox("bx", "update_toilet", requestId, input.client, payload);
    const enriched = res.queued === true ? attachBxLocalTime(res, recordedAt, timeZone) : res;
    return target.kind === "committed" && target.resolvedFromSyncedReceipt
      ? { ...enriched, resolvedFromSyncedReceipt: true }
      : enriched;
  }

  async deleteToilet(input: { id: string; requestId?: string; client?: string }): Promise<Record<string, unknown>> {
    const rawId = requireNonEmptyString(input.id, "id");
    const target = await this.resolvePendingBxTarget(rawId, "toilet", "delete", "record_toilet");
    if (target.kind === "pending" && this.ctx.deletePendingEnvelope) {
      await this.ctx.deletePendingEnvelope("bx", target.requestId);
      return { queued: false, cancelledPending: true, app: "bx", op: "record_toilet", requestId: target.requestId };
    }
    await this.ctx.assertActionAllowed("bx", "delete", "toilet");
    const resolvedId = target.kind === "committed" ? target.id : rawId;
    const requestId = input.requestId?.trim() || generateRequestId("bx-toilet-del");
    const res = await this.ctx.enqueueInbox("bx", "delete_toilet", requestId, input.client, { id: resolvedId });
    return target.kind === "committed" && target.resolvedFromSyncedReceipt
      ? { ...res, resolvedFromSyncedReceipt: true }
      : res;
  }

  // MARK: - Workout Annotations CRUD (Health Frames Remain Read-Only)

  async addWorkoutExercise(input: {
    workoutId: string;
    exercise: string;
    setGroups?: unknown;
    sets?: unknown;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    await this.ctx.assertActionAllowed("bx", "create", "workouts");
    const workoutId = requireNonEmptyString(input.workoutId, "workoutId");
    const exercise = requireNonEmptyString(input.exercise, "exercise");

    const catalog = await this.ctx.readDataset<BxExerciseInfo>("bx", "exercises");
    const resolved = resolveExerciseHint(exercise, catalog);

    const payload: Record<string, unknown> = {
      workoutId,
      exercise: resolved?.key ?? exercise
    };
    if (input.setGroups !== undefined) {
      payload.setGroups = validateSetGroups(input.setGroups);
    } else if (input.sets !== undefined) {
      payload.sets = validateRawSets(input.sets);
    }
    const requestId = input.requestId?.trim() || generateRequestId("bx-ex-add");
    payload.stableID = `bx:remote:${requestId}`;
    const res = await this.ctx.enqueueInbox("bx", "add_workout_exercise", requestId, input.client, payload);
    if (!resolved && catalog && catalog.length > 0 && res.queued === true) {
      const suggestions = suggestExercises(exercise, catalog, 5);
      return {
        ...res,
        exerciseWarning: `Exercise '${exercise}' did not match an exact entry in BX's ${catalog.length}-exercise library; verify spelling with bx_list_exercises before syncing.`,
        suggestedExercises: suggestions
      };
    }
    return res;
  }

  async updateWorkoutExercise(input: {
    entryId: string;
    exercise?: string;
    setGroups?: unknown;
    sets?: unknown;
    clearSets?: boolean;
    position?: number;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    const rawEntryId = requireNonEmptyString(input.entryId, "entryId");
    const target = await this.resolvePendingBxTarget(rawEntryId, "workouts", "update", "add_workout_exercise");
    if (target.kind === "committed") {
      await this.ctx.assertActionAllowed("bx", "update", "workouts");
    }

    const updates: Record<string, unknown> = {};
    let unmatchedWarning:
      | { exerciseWarning: string; suggestedExercises: Array<{ key: string; nameZh: string; nameEn: string; equipment: string[] }> }
      | undefined;

    if (input.exercise !== undefined) {
      const exercise = requireNonEmptyString(input.exercise, "exercise");
      const catalog = await this.ctx.readDataset<BxExerciseInfo>("bx", "exercises");
      const resolved = resolveExerciseHint(exercise, catalog);
      updates.exercise = resolved?.key ?? exercise;
      if (!resolved && catalog && catalog.length > 0) {
        unmatchedWarning = {
          exerciseWarning: `Exercise '${exercise}' did not match an exact entry in BX's ${catalog.length}-exercise library; verify spelling with bx_list_exercises before syncing.`,
          suggestedExercises: suggestExercises(exercise, catalog, 5)
        };
      }
    }
    if (input.clearSets === true) {
      updates.clearSets = true;
    } else if (input.setGroups !== undefined) {
      updates.setGroups = validateSetGroups(input.setGroups);
    } else if (input.sets !== undefined) {
      updates.sets = validateRawSets(input.sets);
    }
    if (input.position !== undefined) {
      if (!Number.isInteger(input.position) || input.position < 0) {
        throw new Error("'position' must be a non-negative integer.");
      }
      updates.position = input.position;
    }

    if (Object.keys(updates).length === 0) {
      throw new Error("update_workout_exercise requires at least one field to update.");
    }

    if (target.kind === "pending" && this.ctx.updatePendingEnvelopePayload) {
      const nextPayload: Record<string, unknown> = { ...target.envelope.payload, ...updates };
      if (updates.clearSets === true) {
        delete nextPayload.setGroups;
        delete nextPayload.sets;
        delete nextPayload.clearSets;
      } else if (updates.setGroups !== undefined) {
        delete nextPayload.sets;
      } else if (updates.sets !== undefined) {
        delete nextPayload.setGroups;
      }
      await this.ctx.updatePendingEnvelopePayload("bx", target.requestId, nextPayload);
      return {
        queued: true,
        updatedPending: true,
        app: "bx",
        op: "update_workout_exercise",
        requestId: target.requestId,
        normalizedPayload: nextPayload,
        ...unmatchedWarning
      };
    }

    const resolvedEntryId = target.kind === "committed" ? target.id : rawEntryId;
    const payload: Record<string, unknown> = { entryId: resolvedEntryId, ...updates };
    const requestId = input.requestId?.trim() || generateRequestId("bx-ex-upd");
    const res = await this.ctx.enqueueInbox("bx", "update_workout_exercise", requestId, input.client, payload);
    return {
      ...res,
      ...(target.kind === "committed" && target.resolvedFromSyncedReceipt ? { resolvedFromSyncedReceipt: true } : {}),
      ...(res.queued === true ? unmatchedWarning : {})
    };
  }

  async deleteWorkoutExercise(input: {
    entryId: string;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    const rawEntryId = requireNonEmptyString(input.entryId, "entryId");
    const target = await this.resolvePendingBxTarget(rawEntryId, "workouts", "delete", "add_workout_exercise");
    if (target.kind === "pending" && this.ctx.deletePendingEnvelope) {
      await this.ctx.deletePendingEnvelope("bx", target.requestId);
      return {
        queued: false,
        cancelledPending: true,
        app: "bx",
        op: "add_workout_exercise",
        requestId: target.requestId
      };
    }
    await this.ctx.assertActionAllowed("bx", "delete", "workouts");
    const resolvedEntryId = target.kind === "committed" ? target.id : rawEntryId;
    const requestId = input.requestId?.trim() || generateRequestId("bx-ex-del");
    const res = await this.ctx.enqueueInbox("bx", "delete_workout_exercise", requestId, input.client, {
      entryId: resolvedEntryId
    });
    return target.kind === "committed" && target.resolvedFromSyncedReceipt
      ? { ...res, resolvedFromSyncedReceipt: true }
      : res;
  }

  async reorderWorkoutExercises(input: {
    workoutId: string;
    entryIds: string[];
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    await this.ctx.assertActionAllowed("bx", "update", "workouts");
    const workoutId = requireNonEmptyString(input.workoutId, "workoutId");
    if (!Array.isArray(input.entryIds) || input.entryIds.length === 0) {
      throw new Error("'entryIds' must be a non-empty array of workout exercise UUID strings.");
    }
    const cleaned = input.entryIds.map((id) => requireNonEmptyString(id, "entryIds[]"));
    const requestId = input.requestId?.trim() || generateRequestId("bx-ex-ord");
    return this.ctx.enqueueInbox("bx", "reorder_workout_exercises", requestId, input.client, {
      workoutId,
      entryIds: cleaned
    });
  }

  async updateWorkoutType(input: {
    workoutId: string;
    activityType?: string | null;
    requestId?: string;
    client?: string;
  }): Promise<Record<string, unknown>> {
    await this.ctx.assertActionAllowed("bx", "update", "workouts");
    const workoutId = requireNonEmptyString(input.workoutId, "workoutId");

    const workouts = await this.ctx.readDataset<BxWorkoutRecord>("bx", "workouts");
    const match = workouts?.find((w) => w.id.toLowerCase() === workoutId.toLowerCase());
    if (match && !match.canChooseType) {
      throw new Error(
        `Workout '${workoutId}' has Health activity '${match.healthActivityName ?? "unknown"}', which is read-only. Only 'other' workouts allow choosing a type.`
      );
    }

    const payload: Record<string, unknown> = { workoutId };
    if (input.activityType === null || input.activityType === "") {
      payload.clearType = true;
    } else if (typeof input.activityType === "string") {
      payload.activityType = input.activityType.trim();
    } else {
      throw new Error("'activityType' (WorkoutActivity raw name, or null to clear) is required.");
    }

    const requestId = input.requestId?.trim() || generateRequestId("bx-wk-type");
    return this.ctx.enqueueInbox("bx", "update_workout_type", requestId, input.client, payload);
  }
}

export function applyBxSummaryDateKey(dateInput: Date): string {
  return dateKeyInUtcCalendar(dateInput);
}
