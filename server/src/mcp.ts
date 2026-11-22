import {
  MCP_PROMPTS,
  MCP_SERVER_INSTRUCTIONS,
  SKILL_GUIDE_MARKDOWN
} from "./guide.js";
import { HttpError } from "./app.js";
import { McpToolDefinition, TOOL_DEFINITIONS } from "./mcp-tools.js";
import { ExchangeStore } from "./store.js";
import { AgentAppID } from "./types.js";

const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05"
];
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";

export interface McpScope {
  apps?: Set<AgentAppID>;
  readOnly: boolean;
}

const TOOL_BY_NAME = new Map<string, McpToolDefinition>(
  TOOL_DEFINITIONS.map((tool) => [tool.name, tool])
);

function parseMcpScope(url: URL): McpScope {
  const rawApps = url.searchParams.get("apps")?.trim();
  let apps: Set<AgentAppID> | undefined;
  if (rawApps) {
    apps = new Set<AgentAppID>();
    for (const part of rawApps.split(",")) {
      const cleaned = part.trim().toLowerCase();
      if (!cleaned) continue;
      if (cleaned !== "sx" && cleaned !== "bx" && cleaned !== "csteix") {
        throw new HttpError(
          400,
          `Invalid MCP 'apps' filter '${part}'. Allowed values: sx, bx, csteix.`
        );
      }
      apps.add(cleaned);
    }
    if (apps.size === 0) apps = undefined;
  }

  const rawReadOnly = url.searchParams.get("readonly")?.trim().toLowerCase() ?? "";
  const readOnly = rawReadOnly === "1" || rawReadOnly === "true" || rawReadOnly === "yes";
  return { apps, readOnly };
}

function isToolAllowedInScope(tool: McpToolDefinition, scope: McpScope): boolean {
  if (scope.readOnly && tool.annotations?.readOnlyHint !== true) {
    return false;
  }
  if (scope.apps) {
    if (tool.name.startsWith("sx_")) return scope.apps.has("sx");
    if (tool.name.startsWith("bx_")) return scope.apps.has("bx");
    if (tool.name.startsWith("csteix_")) return scope.apps.has("csteix");
  }
  return true;
}

function toolsForScope(scope: McpScope): McpToolDefinition[] {
  if (!scope.apps && !scope.readOnly) {
    return TOOL_DEFINITIONS;
  }
  return TOOL_DEFINITIONS.filter((tool) => isToolAllowedInScope(tool, scope));
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function rpcResult(id: string | number | null, result: unknown): Response {
  return jsonResponse({ jsonrpc: "2.0", id, result });
}

function rpcError(id: string | number | null, code: number, message: string): Response {
  return jsonResponse({ jsonrpc: "2.0", id, error: { code, message } });
}

function toolJson(value: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }]
  };
}

function toolError(error: unknown) {
  return {
    isError: true,
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }]
  };
}

function optStr(args: Record<string, unknown>, key: string): string | undefined {
  return typeof args[key] === "string" ? (args[key] as string) : undefined;
}

function optNum(args: Record<string, unknown>, key: string): number | undefined {
  return typeof args[key] === "number" ? (args[key] as number) : undefined;
}

function optRawValue(args: Record<string, unknown>, key: string): unknown {
  return args[key] === undefined ? undefined : args[key];
}

function optBool(args: Record<string, unknown>, key: string): boolean | undefined {
  return typeof args[key] === "boolean" ? (args[key] as boolean) : undefined;
}

function optStrArr(args: Record<string, unknown>, key: string): string[] | undefined {
  return Array.isArray(args[key]) ? (args[key] as unknown[]).map(String) : undefined;
}

async function dispatchTool(
  store: ExchangeStore,
  name: string,
  args: Record<string, unknown>,
  scope: McpScope
): Promise<unknown> {
  switch (name) {
    case "chaox_get_status":
      return store.getStatus({
        app: args.app as AgentAppID | undefined,
        requestId: optStr(args, "requestId"),
        receiptLimit: optNum(args, "receiptLimit")
      });
    case "chaox_get_briefing": {
      const requestedApps = optStrArr(args, "apps");
      const scopedApps = scope.apps ? Array.from(scope.apps) : undefined;
      if (requestedApps && scope.apps) {
        const disallowed = requestedApps.filter((a) => !scope.apps!.has(a as AgentAppID));
        if (disallowed.length > 0) {
          throw new Error(`App(s) '${disallowed.join(", ")}' are excluded by this endpoint's 'apps' scope.`);
        }
      }
      return store.getBriefing({
        date: optStr(args, "date"),
        apps: requestedApps ?? scopedApps
      });
    }
    case "chaox_list_pending":
      return store.listPending({
        app: optStr(args, "app") as AgentAppID | undefined
      });
    case "chaox_cancel_pending":
      return store.cancelPending(String(args.requestId ?? ""));
    case "chaox_get_preferences":
      return store.getPreferences();
    case "chaox_update_preferences":
      return store.updatePreferences({
        content: optStr(args, "content"),
        append: optStr(args, "append")
      });

    // SX Reads
    case "sx_get_catalog":
      return store.readSxCatalog();
    case "sx_get_summary":
      return store.readSxSummary({
        period: args.period as "today" | "week" | "month" | "year" | "allTime" | undefined,
        mode: args.mode as "expense" | "income" | undefined
      });
    case "sx_list_projects":
      return store.sx.listProjects({
        query: optStr(args, "query"),
        projectType: optStr(args, "projectType"),
        cashFlow: optStr(args, "cashFlow"),
        currency: optStr(args, "currency"),
        limit: optNum(args, "limit"),
        offset: optNum(args, "offset")
      });
    case "sx_list_expenses":
      return store.sx.listExpenses({
        from: optStr(args, "from"),
        to: optStr(args, "to"),
        projectId: optNum(args, "projectId"),
        projectName: optStr(args, "projectName"),
        tag: optStr(args, "tag"),
        currency: optStr(args, "currency"),
        query: optStr(args, "query"),
        includeRefunds: optBool(args, "includeRefunds"),
        limit: optNum(args, "limit"),
        offset: optNum(args, "offset")
      });
    case "sx_list_incomes":
      return store.sx.listIncomes({
        from: optStr(args, "from"),
        to: optStr(args, "to"),
        projectId: optNum(args, "projectId"),
        projectName: optStr(args, "projectName"),
        tag: optStr(args, "tag"),
        currency: optStr(args, "currency"),
        query: optStr(args, "query"),
        includeReversals: optBool(args, "includeReversals"),
        limit: optNum(args, "limit"),
        offset: optNum(args, "offset")
      });
    case "sx_list_tags":
      return store.sx.listTags({ query: optStr(args, "query") });
    case "sx_list_slogans":
      return store.sx.listSlogans({
        language: optStr(args, "language"),
        enabledOnly: optBool(args, "enabledOnly"),
        query: optStr(args, "query"),
        limit: optNum(args, "limit"),
        offset: optNum(args, "offset")
      });

    // SX CRUD
    case "sx_record_expense":
      return store.sx.recordExpense({
        amount: Number(args.amount),
        projectName: String(args.projectName ?? ""),
        credentialId: optNum(args, "credentialId"),
        currency: optStr(args, "currency"),
        tags: optStrArr(args, "tags"),
        note: optStr(args, "note") ?? optStr(args, "notes"),
        date: optStr(args, "date"),
        hour: optRawValue(args, "hour"),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "sx_update_expense":
      return store.sx.updateExpense({
        id: optNum(args, "id"),
        pendingRequestId: optStr(args, "pendingRequestId"),
        amount: optNum(args, "amount"),
        projectName: optStr(args, "projectName"),
        credentialId: optNum(args, "credentialId"),
        clearCredential: optBool(args, "clearCredential"),
        currency: optStr(args, "currency"),
        tags: optStrArr(args, "tags"),
        note: optStr(args, "note") ?? optStr(args, "notes"),
        date: optStr(args, "date"),
        hour: optRawValue(args, "hour"),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "sx_delete_expense":
      return store.sx.deleteExpense({
        id: optNum(args, "id"),
        pendingRequestId: optStr(args, "pendingRequestId"),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "sx_record_refund":
      return store.sx.recordRefund({
        paymentId: Number(args.paymentId),
        amount: Number(args.amount),
        note: optStr(args, "note") ?? optStr(args, "notes"),
        date: optStr(args, "date"),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "sx_update_refund":
      return store.sx.updateRefund({
        id: Number(args.id),
        amount: optNum(args, "amount"),
        note: optStr(args, "note") ?? optStr(args, "notes"),
        date: optStr(args, "date"),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "sx_delete_refund":
      return store.sx.deleteRefund({
        id: Number(args.id),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "sx_record_income":
      return store.sx.recordIncome({
        amount: Number(args.amount),
        projectName: String(args.projectName ?? ""),
        credentialId: optNum(args, "credentialId"),
        currency: optStr(args, "currency"),
        tags: optStrArr(args, "tags"),
        note: optStr(args, "note") ?? optStr(args, "notes"),
        date: optStr(args, "date"),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "sx_update_income":
      return store.sx.updateIncome({
        id: optNum(args, "id"),
        pendingRequestId: optStr(args, "pendingRequestId"),
        amount: optNum(args, "amount"),
        projectName: optStr(args, "projectName"),
        credentialId: optNum(args, "credentialId"),
        clearCredential: optBool(args, "clearCredential"),
        currency: optStr(args, "currency"),
        tags: optStrArr(args, "tags"),
        note: optStr(args, "note") ?? optStr(args, "notes"),
        date: optStr(args, "date"),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "sx_delete_income":
      return store.sx.deleteIncome({
        id: optNum(args, "id"),
        pendingRequestId: optStr(args, "pendingRequestId"),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "sx_record_income_reversal":
      return store.sx.recordIncomeReversal({
        incomeId: Number(args.incomeId),
        amount: Number(args.amount),
        note: optStr(args, "note") ?? optStr(args, "notes"),
        date: optStr(args, "date"),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "sx_update_income_reversal":
      return store.sx.updateIncomeReversal({
        id: Number(args.id),
        amount: optNum(args, "amount"),
        note: optStr(args, "note") ?? optStr(args, "notes"),
        date: optStr(args, "date"),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "sx_delete_income_reversal":
      return store.sx.deleteIncomeReversal({
        id: Number(args.id),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "sx_create_project":
      return store.sx.createProject({
        name: String(args.name ?? ""),
        price: optNum(args, "price"),
        currency: optStr(args, "currency"),
        cycle: optStr(args, "cycle"),
        priceType: optStr(args, "priceType"),
        projectType: optStr(args, "projectType"),
        cashFlowSides: optStr(args, "cashFlowSides"),
        startDate: optStr(args, "startDate"),
        endDate: optStr(args, "endDate"),
        isAutoRenew: optBool(args, "isAutoRenew"),
        notes: optStr(args, "notes") ?? optStr(args, "note"),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "sx_update_project":
      return store.sx.updateProject({
        id: Number(args.id),
        name: optStr(args, "name"),
        price: optNum(args, "price"),
        currency: optStr(args, "currency"),
        cycle: optStr(args, "cycle"),
        priceType: optStr(args, "priceType"),
        projectType: optStr(args, "projectType"),
        cashFlowSides: optStr(args, "cashFlowSides"),
        notes: optStr(args, "notes") ?? optStr(args, "note"),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "sx_delete_project":
      return store.sx.deleteProject({
        id: Number(args.id),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "sx_create_tag":
      return store.sx.createTag({
        name: String(args.name ?? ""),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "sx_rename_tag":
      return store.sx.renameTag({
        id: Number(args.id),
        name: String(args.name ?? ""),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "sx_delete_tag":
      return store.sx.deleteTag({
        id: Number(args.id),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "sx_create_slogan":
      return store.sx.createSlogan({
        text: String(args.text ?? ""),
        language: optStr(args, "language"),
        emoji: optStr(args, "emoji"),
        ruleType: optStr(args, "ruleType"),
        ruleValue: optStr(args, "ruleValue"),
        priority: optNum(args, "priority"),
        isEnabled: optBool(args, "isEnabled"),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "sx_update_slogan":
      return store.sx.updateSlogan({
        id: Number(args.id),
        text: optStr(args, "text"),
        language: optStr(args, "language"),
        emoji: args.emoji === null ? null : optStr(args, "emoji"),
        ruleType: optStr(args, "ruleType"),
        ruleValue: optStr(args, "ruleValue"),
        priority: optNum(args, "priority"),
        isEnabled: optBool(args, "isEnabled"),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "sx_delete_slogan":
      return store.sx.deleteSlogan({
        id: Number(args.id),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "sx_list_credentials":
      return store.sx.listCredentials({
        query: optStr(args, "query"),
        type: optStr(args, "type"),
        projectId: optNum(args, "projectId"),
        limit: optNum(args, "limit"),
        offset: optNum(args, "offset")
      });
    case "sx_create_credential":
      return store.sx.createCredential({
        username: String(args.username ?? ""),
        website: optStr(args, "website"),
        type: optStr(args, "type"),
        issuer: optStr(args, "issuer"),
        projectId: optNum(args, "projectId"),
        projectName: optStr(args, "projectName"),
        isAutoRenew: optBool(args, "isAutoRenew"),
        startDate: optStr(args, "startDate"),
        hasStartDate: optBool(args, "hasStartDate"),
        endDate: optStr(args, "endDate"),
        nextRenewalDate: optStr(args, "nextRenewalDate"),
        renewalHour: optNum(args, "renewalHour"),
        renewalWeekdays: optNum(args, "renewalWeekdays"),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "sx_update_credential":
      return store.sx.updateCredential({
        id: Number(args.id),
        username: optStr(args, "username"),
        website: optStr(args, "website"),
        type: optStr(args, "type"),
        issuer: optStr(args, "issuer"),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "sx_delete_credential":
      return store.sx.deleteCredential({
        id: Number(args.id),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "sx_link_credential":
      return store.sx.linkCredential({
        credentialId: Number(args.credentialId),
        projectId: Number(args.projectId),
        isAutoRenew: optBool(args, "isAutoRenew"),
        startDate: optStr(args, "startDate"),
        hasStartDate: optBool(args, "hasStartDate"),
        endDate: optStr(args, "endDate"),
        nextRenewalDate: optStr(args, "nextRenewalDate"),
        renewalHour: optNum(args, "renewalHour"),
        renewalWeekdays: optNum(args, "renewalWeekdays"),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "sx_update_credential_link":
      return store.sx.updateCredentialLink({
        credentialId: Number(args.credentialId),
        projectId: Number(args.projectId),
        isAutoRenew: optBool(args, "isAutoRenew"),
        startDate: optStr(args, "startDate"),
        hasStartDate: optBool(args, "hasStartDate"),
        endDate: optStr(args, "endDate"),
        clearEndDate: optBool(args, "clearEndDate"),
        nextRenewalDate: optStr(args, "nextRenewalDate"),
        clearNextRenewalDate: optBool(args, "clearNextRenewalDate"),
        renewalHour: optNum(args, "renewalHour"),
        renewalWeekdays: optNum(args, "renewalWeekdays"),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "sx_unlink_credential":
      return store.sx.unlinkCredential({
        credentialId: Number(args.credentialId),
        projectId: Number(args.projectId),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });

    // BX Reads
    case "bx_get_summary":
      return store.readBxSummary({ date: optStr(args, "date") });
    case "bx_list_sleep":
      return store.bx.listSleep({
        from: optStr(args, "from"),
        to: optStr(args, "to"),
        limit: optNum(args, "limit"),
        offset: optNum(args, "offset")
      });
    case "bx_list_workouts":
      return store.bx.listWorkouts({
        from: optStr(args, "from"),
        to: optStr(args, "to"),
        activityType: optStr(args, "activityType"),
        exerciseQuery: optStr(args, "exerciseQuery"),
        equipment: optStr(args, "equipment"),
        limit: optNum(args, "limit"),
        offset: optNum(args, "offset")
      });
    case "bx_list_exercises":
      return store.bx.listExercises({
        query: optStr(args, "query"),
        group: optStr(args, "group"),
        equipment: optStr(args, "equipment"),
        limit: optNum(args, "limit")
      });
    case "bx_list_food":
      return store.bx.listFood({
        from: optStr(args, "from"),
        to: optStr(args, "to"),
        mealType: optStr(args, "mealType"),
        query: optStr(args, "query"),
        limit: optNum(args, "limit"),
        offset: optNum(args, "offset")
      });
    case "bx_list_skin":
      return store.bx.listSkin({
        from: optStr(args, "from"),
        to: optStr(args, "to"),
        product: optStr(args, "product"),
        query: optStr(args, "query"),
        limit: optNum(args, "limit"),
        offset: optNum(args, "offset")
      });
    case "bx_list_toilet":
      return store.bx.listToilet({
        from: optStr(args, "from"),
        to: optStr(args, "to"),
        kind: optStr(args, "kind"),
        stoolType: optNum(args, "stoolType"),
        query: optStr(args, "query"),
        limit: optNum(args, "limit"),
        offset: optNum(args, "offset")
      });

    // BX CRUD
    case "bx_record_food":
      return store.bx.recordFood({
        name: String(args.name ?? ""),
        mealType: optStr(args, "mealType"),
        calories: optNum(args, "calories"),
        recordedAt: optStr(args, "recordedAt"),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "bx_update_food":
      return store.bx.updateFood({
        id: String(args.id ?? ""),
        name: optStr(args, "name"),
        mealType: optStr(args, "mealType"),
        calories: optNum(args, "calories"),
        clearCalories: optBool(args, "clearCalories"),
        recordedAt: optStr(args, "recordedAt"),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "bx_delete_food":
      return store.bx.deleteFood({
        id: String(args.id ?? ""),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "bx_record_skin":
      return store.bx.recordSkin({
        product: String(args.product ?? ""),
        name: optStr(args, "name"),
        brand: optStr(args, "brand"),
        recordedAt: optStr(args, "recordedAt"),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "bx_update_skin":
      return store.bx.updateSkin({
        id: String(args.id ?? ""),
        product: optStr(args, "product"),
        name: optStr(args, "name"),
        recordedAt: optStr(args, "recordedAt"),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "bx_delete_skin":
      return store.bx.deleteSkin({
        id: String(args.id ?? ""),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "bx_record_toilet":
      return store.bx.recordToilet({
        kind: optStr(args, "kind"),
        stoolType: optNum(args, "stoolType"),
        bristol: optNum(args, "bristol"),
        note: optStr(args, "note"),
        recordedAt: optStr(args, "recordedAt"),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "bx_update_toilet":
      return store.bx.updateToilet({
        id: String(args.id ?? ""),
        kind: optStr(args, "kind"),
        stoolType: optNum(args, "stoolType"),
        bristol: optNum(args, "bristol"),
        note: optStr(args, "note"),
        recordedAt: optStr(args, "recordedAt"),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "bx_delete_toilet":
      return store.bx.deleteToilet({
        id: String(args.id ?? ""),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "bx_add_workout_exercise":
      return store.bx.addWorkoutExercise({
        workoutId: String(args.workoutId ?? ""),
        exercise: String(args.exercise ?? ""),
        setGroups: args.setGroups,
        sets: args.sets,
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "bx_update_workout_exercise":
      return store.bx.updateWorkoutExercise({
        entryId: String(args.entryId ?? ""),
        exercise: optStr(args, "exercise"),
        setGroups: args.setGroups,
        sets: args.sets,
        clearSets: optBool(args, "clearSets"),
        position: optNum(args, "position"),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "bx_delete_workout_exercise":
      return store.bx.deleteWorkoutExercise({
        entryId: String(args.entryId ?? ""),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "bx_reorder_workout_exercises":
      return store.bx.reorderWorkoutExercises({
        workoutId: String(args.workoutId ?? ""),
        entryIds: optStrArr(args, "entryIds") ?? [],
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "bx_update_workout_type":
      return store.bx.updateWorkoutType({
        workoutId: String(args.workoutId ?? ""),
        activityType: args.activityType === null ? null : optStr(args, "activityType"),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });

    // CSTEIX Read-Only Domains
    case "csteix_get_summary":
      return store.csteix.getSummary({
        from: optStr(args, "from"),
        to: optStr(args, "to")
      });
    case "csteix_list_dwell":
      return store.csteix.listDwell({
        from: optStr(args, "from"),
        to: optStr(args, "to"),
        pillar: optStr(args, "pillar"),
        limit: optNum(args, "limit"),
        offset: optNum(args, "offset")
      });
    case "csteix_list_meditation":
      return store.csteix.listMeditation({
        from: optStr(args, "from"),
        to: optStr(args, "to"),
        pillar: optStr(args, "pillar"),
        limit: optNum(args, "limit"),
        offset: optNum(args, "offset")
      });
    case "csteix_list_marks":
      return store.csteix.listMarks({
        from: optStr(args, "from"),
        to: optStr(args, "to"),
        kind: optStr(args, "kind"),
        pillar: optStr(args, "pillar"),
        limit: optNum(args, "limit"),
        offset: optNum(args, "offset")
      });

    // CSTEIX Wuxu Articles (Immediate Server Database CRUD)
    case "csteix_list_wuxu":
      return store.csteix.listWuxu({
        from: optStr(args, "from"),
        to: optStr(args, "to"),
        dimension: optStr(args, "dimension"),
        query: optStr(args, "query"),
        hasRaw: optBool(args, "hasRaw"),
        hasEn: optBool(args, "hasEn"),
        includeDeleted: optBool(args, "includeDeleted"),
        includeBody: optBool(args, "includeBody"),
        limit: optNum(args, "limit"),
        offset: optNum(args, "offset")
      });
    case "csteix_get_wuxu":
      return store.csteix.getWuxu({
        id: optStr(args, "id"),
        slug: optStr(args, "slug")
      });
    case "csteix_create_wuxu":
      return store.csteix.createWuxu({
        slug: String(args.slug ?? ""),
        title: String(args.title ?? ""),
        titleEn: args.titleEn === null ? null : optStr(args, "titleEn"),
        dimensions: optStrArr(args, "dimensions") ?? [],
        writtenAt: optStr(args, "writtenAt"),
        timezone: optStr(args, "timezone"),
        bodyZh: String(args.bodyZh ?? ""),
        bodyEn: args.bodyEn === null ? null : optStr(args, "bodyEn"),
        rawNotes: args.rawNotes === null ? null : optStr(args, "rawNotes"),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "csteix_update_wuxu":
      return store.csteix.updateWuxu({
        id: optStr(args, "id"),
        slug: optStr(args, "slug"),
        expectedRevision: optNum(args, "expectedRevision"),
        title: optStr(args, "title"),
        titleEn: args.titleEn === null ? null : optStr(args, "titleEn"),
        dimensions: optStrArr(args, "dimensions"),
        writtenAt: optStr(args, "writtenAt"),
        timezone: optStr(args, "timezone"),
        bodyZh: optStr(args, "bodyZh"),
        bodyEn: args.bodyEn === null ? null : optStr(args, "bodyEn"),
        rawNotes: args.rawNotes === null ? null : optStr(args, "rawNotes"),
        appendBodyZh: optStr(args, "appendBodyZh"),
        appendBodyEn: optStr(args, "appendBodyEn"),
        appendRawNotes: optStr(args, "appendRawNotes"),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "csteix_delete_wuxu":
      return store.csteix.deleteWuxu({
        id: optStr(args, "id"),
        slug: optStr(args, "slug"),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });
    case "csteix_restore_wuxu":
      return store.csteix.restoreWuxu({
        id: optStr(args, "id"),
        slug: optStr(args, "slug"),
        requestId: optStr(args, "requestId"),
        client: optStr(args, "client")
      });

    default:
      throw new Error(`Unknown MCP tool: ${name}`);
  }
}

async function handleSingleRpc(
  msg: JsonRpcRequest,
  store: ExchangeStore,
  scope: McpScope
): Promise<Response> {
  const id = msg.id ?? null;

  if (msg.method.startsWith("notifications/")) {
    return new Response(null, { status: 202 });
  }

  switch (msg.method) {
    case "initialize": {
      const requested = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "";
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : DEFAULT_PROTOCOL_VERSION;
      return rpcResult(id, {
        protocolVersion,
        capabilities: {
          tools: {},
          resources: {},
          prompts: {}
        },
        serverInfo: {
          name: store.getServerName(),
          version: "1.2.0"
        },
        instructions: MCP_SERVER_INSTRUCTIONS
      });
    }

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, { tools: toolsForScope(scope) });

    case "tools/call": {
      const params = msg.params ?? {};
      const toolName = typeof params.name === "string" ? params.name : "";
      const toolDef = TOOL_BY_NAME.get(toolName);
      if (toolDef && !isToolAllowedInScope(toolDef, scope)) {
        return rpcResult(
          id,
          toolError(`Tool '${toolName}' is not available on this scoped MCP endpoint.`)
        );
      }
      const args =
        params.arguments && typeof params.arguments === "object"
          ? (params.arguments as Record<string, unknown>)
          : {};
      try {
        const result = await dispatchTool(store, toolName, args, scope);
        return rpcResult(id, toolJson(result));
      } catch (error) {
        return rpcResult(id, toolError(error));
      }
    }

    case "resources/list":
      return rpcResult(id, {
        resources: [
          {
            uri: "chaox://guide/skill",
            name: "CHAOX Agent Skill Guide",
            description: "Usage workflow, privacy rules, and cross-app conventions for SX, BX, and CSTEIX",
            mimeType: "text/markdown"
          },
          {
            uri: "chaox://guide/preferences",
            name: "Personal Assistant Preferences",
            description: "User-defined routing rules and personal accounting/nutrition notes",
            mimeType: "text/markdown"
          }
        ]
      });

    case "resources/templates/list":
      return rpcResult(id, {
        resourceTemplates: [
          {
            uriTemplate: "chaox://wuxu/{slug}",
            name: "CSTEIX Wuxu Article",
            description: "Read a private CSTEIX Wuxu article as Markdown by lowercase kebab-case slug",
            mimeType: "text/markdown"
          }
        ]
      });

    case "resources/read": {
      const uri = typeof msg.params?.uri === "string" ? msg.params.uri : "";
      if (uri === "chaox://guide/skill") {
        return rpcResult(id, {
          contents: [{ uri, mimeType: "text/markdown", text: SKILL_GUIDE_MARKDOWN }]
        });
      }
      if (uri === "chaox://guide/preferences") {
        const prefs = await store.getPreferences();
        return rpcResult(id, {
          contents: [{ uri, mimeType: "text/markdown", text: prefs.content }]
        });
      }
      if (uri.startsWith("chaox://wuxu/")) {
        const slug = decodeURIComponent(uri.slice("chaox://wuxu/".length).trim());
        if (!slug) {
          return rpcError(id, -32602, "Missing Wuxu slug in resource URI.");
        }
        try {
          const article = (await store.csteix.getWuxu({ slug })) as {
            slug: string;
            title: string;
            titleEn?: string | null;
            dimensions: string[];
            localDate: string;
            timezone: string;
            revision: number;
            bodyZh: string;
            bodyEn?: string | null;
            rawNotes?: string | null;
          };
          const lines = [
            `# ${article.title}`,
            ...(article.titleEn ? [`_${article.titleEn}_`] : []),
            "",
            `- **Slug**: \`${article.slug}\``,
            `- **Dimensions**: ${article.dimensions.join(", ")}`,
            `- **Date**: ${article.localDate} (${article.timezone})`,
            `- **Revision**: ${article.revision}`,
            "",
            article.bodyZh,
            ...(article.bodyEn ? ["", "---", "", article.bodyEn] : []),
            ...(article.rawNotes ? ["", "## Raw Notes", "", article.rawNotes] : [])
          ];
          return rpcResult(id, {
            contents: [{ uri, mimeType: "text/markdown", text: lines.join("\n") }]
          });
        } catch (error) {
          return rpcError(id, -32602, error instanceof Error ? error.message : String(error));
        }
      }
      return rpcError(id, -32602, `Unknown resource URI: ${uri}`);
    }

    case "prompts/list":
      return rpcResult(id, { prompts: MCP_PROMPTS });

    case "prompts/get": {
      const promptName = typeof msg.params?.name === "string" ? msg.params.name : "";
      const promptArgs =
        msg.params?.arguments && typeof msg.params.arguments === "object"
          ? (msg.params.arguments as Record<string, unknown>)
          : {};
      if (promptName === "log_meal_photo") {
        const text =
          `Log this meal across SX and BX using chaox-agent:\n` +
          `1. Call chaox_get_briefing (or chaox_get_status + sx_get_catalog + bx_get_summary) to inspect permitted apps, timezones, and active meal project names.\n` +
          `2. Expense hint: amount=${promptArgs.amount ?? "infer"}, currency=${promptArgs.currency ?? "default"}. Pass the meal's local hour via 'date' + 'hour' (0..23) or ISO-8601 with offset, and put dish/merchant details in 'note'.\n` +
          `3. Meal hint: ${promptArgs.meal_description ?? "analyze photo ingredients and state estimated kcal transparently"}.\n` +
          `4. Call sx_record_expense and bx_record_food with matching requestId prefix and report updated optimistic totals.`;
        return rpcResult(id, {
          description: "Cross-app meal photo logging workflow",
          messages: [{ role: "user", content: { type: "text", text } }]
        });
      }
      if (promptName === "daily_review") {
        const dateHint = typeof promptArgs.date === "string" ? promptArgs.date : "today";
        const dateArg = typeof promptArgs.date === "string" ? `date='${promptArgs.date}'` : "";
        const text =
          `Review my ${dateHint} across SX, BX, and CSTEIX:\n` +
          `1. Start with chaox_get_briefing(${dateArg}) for a unified snapshot.\n` +
          `2. Drill into details as needed using sx_list_expenses / sx_list_incomes (check 'aggregates'), bx_list_sleep / bx_list_workouts / bx_list_food / bx_list_skin / bx_list_toilet, and csteix_get_wuxu.\n` +
          `3. Highlight committed vs queued inbox items concisely.`;
        return rpcResult(id, {
          description: "Daily SX + BX + CSTEIX check-in",
          messages: [{ role: "user", content: { type: "text", text } }]
        });
      }
      if (promptName === "weekly_review") {
        const weekRangeHint =
          typeof promptArgs.from === "string" && typeof promptArgs.to === "string"
            ? `from ${promptArgs.from} to ${promptArgs.to}`
            : "for the past 7 days";
        const text =
          `Perform a weekly review ${weekRangeHint} across SX, BX, and CSTEIX:\n` +
          `1. Call chaox_get_briefing and sx_get_summary(period='week', mode='expense') + sx_get_summary(period='week', mode='income').\n` +
          `2. Use sx_list_expenses and sx_list_incomes with the date range and inspect 'aggregates.totalsByCurrency', 'byProject', and 'byTag'.\n` +
          `3. Call bx_list_sleep, bx_list_workouts ('aggregates' for duration & volume kg), bx_list_food ('aggregates'), and csteix_get_summary + csteix_list_wuxu for the date window.\n` +
          `4. Synthesize trends in spending, training volume, nutrition, sleep, stillness, and writing.`;
        return rpcResult(id, {
          description: "7-day cross-app trend & aggregate review",
          messages: [{ role: "user", content: { type: "text", text } }]
        });
      }
      if (promptName === "log_workout_session") {
        const dateArg = typeof promptArgs.date === "string" ? `from='${promptArgs.date}', to='${promptArgs.date}'` : "";
        const notesHint = typeof promptArgs.notes === "string" ? promptArgs.notes : "ask or inspect user workout notes";
        const text =
          `Log exercise/set annotations onto a BX workout:\n` +
          `1. Call bx_list_workouts(${dateArg}) to find the target Apple Health workoutId.\n` +
          `2. For each movement mentioned (${notesHint}), call bx_list_exercises(query=...) to resolve exact exercise key & equipment.\n` +
          `3. Use bx_add_workout_exercise with grouped sets [{reps, sets, weightKg}] (or bx_update_workout_type if canChooseType=true).\n` +
          `4. Never try to modify HealthKit start/end/duration/HR frames.`;
        return rpcResult(id, {
          description: "Annotate BX Apple Health workout with exercises & sets",
          messages: [{ role: "user", content: { type: "text", text } }]
        });
      }
      if (promptName === "write_wuxu") {
        const topicHint = typeof promptArgs.topic === "string" ? promptArgs.topic : "today's entry";
        const text =
          `Draft or continue a private CSTEIX Wuxu article (${topicHint}):\n` +
          `1. Call csteix_list_wuxu to inspect existing pieces on today's date or matching topic.\n` +
          `2. If continuing a same-day article, call csteix_get_wuxu to read full text and current revision, then call csteix_update_wuxu with expectedRevision and appendBodyZh/appendRawNotes.\n` +
          `3. If creating a new piece, use a lowercase kebab-case slug, dimensions from ['chaos','spacetime','existence','ix'], pure body Markdown in bodyZh (no leading # Title header block), and verbatim user utterances in rawNotes.`;
        return rpcResult(id, {
          description: "Draft or continue a private CSTEIX Wuxu article",
          messages: [{ role: "user", content: { type: "text", text } }]
        });
      }
      return rpcError(id, -32602, `Unknown prompt: ${promptName}`);
    }

    default:
      return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function handleMcpRequest(request: Request, store: ExchangeStore): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse(
      { error: "Method not allowed. Send JSON-RPC requests with POST /mcp." },
      405
    );
  }

  const scope = parseMcpScope(new URL(request.url));

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return rpcError(null, -32700, "Invalid JSON payload");
  }

  if (Array.isArray(parsed)) {
    const responses: unknown[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object" || typeof (item as JsonRpcRequest).method !== "string") {
        responses.push({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
        continue;
      }
      const res = await handleSingleRpc(item as JsonRpcRequest, store, scope);
      if (res.status !== 202) {
        responses.push(await res.json());
      }
    }
    if (responses.length === 0) {
      return new Response(null, { status: 202 });
    }
    return jsonResponse(responses);
  }

  if (!parsed || typeof parsed !== "object" || typeof (parsed as JsonRpcRequest).method !== "string") {
    return rpcError(null, -32600, "Invalid JSON-RPC Request");
  }

  return handleSingleRpc(parsed as JsonRpcRequest, store, scope);
}
