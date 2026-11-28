const SET_GROUP_SCHEMA = {
  type: "array",
  description: "Grouped sets (preferred): e.g. [{reps: 12, sets: 3, weightKg: 40}]",
  items: {
    type: "object",
    required: ["reps", "sets"],
    properties: {
      reps: { type: "integer", minimum: 1, maximum: 100 },
      sets: { type: "integer", minimum: 1, maximum: 20 },
      weightKg: { type: "number", minimum: 0.01, maximum: 999 }
    }
  }
};

const RAW_SET_SCHEMA = {
  type: "array",
  description: "Individual per-set records when each set differs",
  items: {
    type: "object",
    properties: {
      reps: { type: "integer", minimum: 1, maximum: 100 },
      weightKg: { type: "number", minimum: 0.01, maximum: 999 },
      rpe: { type: "number", minimum: 1, maximum: 10 },
      durationSeconds: { type: "number", exclusiveMinimum: 0 }
    }
  }
};

const WUXU_COUPLETS_SCHEMA = {
  type: "array",
  maxItems: 4,
  description:
    "Optional bilingual symmetric Stage Couplets (default [] / 0; distill at most 1-2 ONLY when the article holds timeless aphorisms worthy of the meditation stage — never force onto routine logs; max 4). Read chaox://guide/wuxu-couplets first. Each couplet carries its own 'dimension' ('chaos'|'spacetime'|'existence'|'ix'), 'zh' ('LEFT|RIGHT', 2-6 chars per half, exact equal length, zero spaces/punctuation/markdown/emoji), and 'en' ('LEFT|RIGHT', uppercase ASCII + single spaces only, 6-17 chars per rendered half after PivotText space removal and longer-half adjacent-letter dedupe, length diff <= 3, aim <= 2). CRITICAL: When zh includes '我求', en MUST use 'IX' (never SEEKING/EXPLORE).",
  items: {
    type: "object",
    required: ["dimension", "zh", "en"],
    properties: {
      id: {
        type: "string",
        description: "Optional stable couplet ID (preserved when non-empty; otherwise reused on matching (dimension, zh) or generated)."
      },
      dimension: {
        type: "string",
        enum: ["chaos", "spacetime", "existence", "ix"],
        description: "Dimension this couplet belongs to ('chaos', 'spacetime', 'existence', or 'ix')."
      },
      zh: {
        type: "string",
        description: "Symmetric Chinese couplet 'LEFT|RIGHT' (2-6 chars per side, equal char count, zero whitespace/punctuation/markdown/emoji)."
      },
      en: {
        type: "string",
        description: "Symmetric English couplet 'LEFT|RIGHT' (uppercase ASCII + single spaces, 6-17 rendered chars per half, diff <= 3, aim <= 2; 我求 -> IX)."
      },
      sourceLine: {
        type: ["string", "null"],
        description: "Optional verbatim line from rawNotes or body that inspired this couplet."
      }
    }
  }
};

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  annotations?: McpToolAnnotations;
  inputSchema: Record<string, unknown>;
}

const BX_EVENT_TIME_FORMATS = "Use ISO-8601 with offset or local 'YYYY-MM-DD HH:mm' in the BX timezone. A bare 'YYYY-MM-DD' becomes local noon.";

const RAW_TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: "chaox_get_status",
    title: "CHAOX Exchange Status",
    description:
      "Inspect connected CHAOX apps (sx/bx/csteix), user permission policies, uploaded dataset counts, pending server inbox counts, custom preferences flag, and recent or specific request receipts.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", enum: ["sx", "bx", "csteix"], description: "Filter receipts by app" },
        requestId: { type: "string", description: "Look up a specific queued or processed requestId" },
        receiptLimit: { type: "integer", minimum: 1, maximum: 50, description: "Max recent receipts (default 10)" }
      }
    }
  },
  {
    name: "chaox_get_briefing",
    title: "CHAOX Cross-App Daily Briefing",
    description:
      "One-shot read across connected SX, BX, and CSTEIX apps respecting all permission policies and domain allowlists. Returns custom user preferences, today & month SX financial optimistic totals + compact project/tag catalog, BX daily nutrition/skin/toilet totals + latest sleep + workouts on date, and CSTEIX summary + latest Wuxu article.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Optional local calendar date YYYY-MM-DD (defaults to today in each app's timezone)" },
        apps: {
          type: "array",
          items: { type: "string", enum: ["sx", "bx", "csteix"] },
          description: "Optional subset of apps to include (defaults to all connected permitted apps)"
        }
      }
    }
  },
  {
    name: "chaox_list_pending",
    title: "List Pending Server Inbox",
    description:
      "List all queued un-synced write/update/delete requests waiting in the server inbox across SX, BX, and CSTEIX, including requestId, op, payload, and resolvedLocalTime.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", enum: ["sx", "bx", "csteix"], description: "Optional app filter" }
      }
    }
  },
  {
    name: "chaox_cancel_pending",
    title: "Cancel Pending Inbox Request",
    description:
      "Remove/cancel a queued un-synced request from the server inbox by requestId before iOS syncs it (checks app permission policy). Never alters already-synced records; if already synced, returns its receipt status and recordId.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      required: ["requestId"],
      properties: {
        requestId: { type: "string", minLength: 1, description: "Queued requestId from tool output or chaox_list_pending" }
      }
    }
  },
  {
    name: "chaox_get_preferences",
    title: "Get Personal Assistant Preferences",
    description:
      "Read the user's saved personal Markdown routing rules and habits (exposed via chaox://guide/preferences).",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "chaox_update_preferences",
    title: "Update Personal Assistant Preferences",
    description:
      "Save or append user-requested personal assistant preferences (e.g. default meal project, currency, workout conventions) in the BYOS database.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Full Markdown replacement (pass either 'content' or 'append', not both)" },
        append: { type: "string", description: "Single rule line or Markdown section to append cleanly" }
      }
    }
  },

  // MARK: - SX Reads
  {
    name: "sx_get_catalog",
    title: "SX Ledger Catalog",
    description:
      "Read Spending X (SX) device timezone (timeZoneIdentifier), default summaryCurrency, supportedCurrencies, active projects (with currency, type, cycle, cash-flow support, and recentExpenseTags/recentIncomeTags), existing tags, rules, and fieldGuide. Call before recording expenses or incomes. Never returns credentials or private vault data.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "sx_get_summary",
    title: "SX Financial Summary",
    description:
      "Read Spending X (SX) net cash-flow totals converted to summaryCurrency for today, week, month, year, or allTime in expense or income mode. Returns committedBucket (last device sync), allBuckets, and optimisticOverlay (pending inbox writes queued since last sync).",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        period: {
          type: "string",
          enum: ["today", "week", "month", "year", "allTime"],
          description: "Aggregation window in SX's device timezone (default: 'month')"
        },
        mode: {
          type: "string",
          enum: ["expense", "income"],
          description: "Cash-flow side to summarize: 'expense' (default) or 'income'"
        }
      }
    }
  },
  {
    name: "sx_list_projects",
    title: "List SX Projects",
    description:
      "List Spending X projects (reusable spending/income buckets) with pricing, billing cycle, priceType, projectType, cashFlowSides, record counts, and whether each project is deletable (deletable is true only when expenseCount=0, incomeCount=0, and credentialLinkCount=0). Overlays pending inbox mutations.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Case-insensitive substring search across project name, notes, and currency" },
        projectType: {
          type: "string",
          enum: ["nonRenewal", "autoRenew", "pausedRenew", "expired"],
          description: "Filter by project lifecycle type"
        },
        cashFlow: {
          type: "string",
          enum: ["expense", "income"],
          description: "Filter to projects supporting 'expense' or 'income'"
        },
        currency: { type: "string", description: "Filter by 3-letter ISO currency code (e.g. 'CNY', 'USD')" },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Max items to return (default 50, max 200)" },
        offset: { type: "integer", minimum: 0, description: "Zero-based pagination offset (default 0)" }
      }
    }
  },
  {
    name: "sx_list_expenses",
    title: "List SX Expenses",
    description:
      "Read Spending X expense records (sorted newest first, with full pending inbox overlay including pending refunds, excluding vault secrets). Also returns pre-pagination 'aggregates' over all matching records (recordCount, totalsByCurrency gross/refund/net/count, top 10 byProject & byTag). For queued un-synced creates (id: -1), pass 'pendingRequestId' to sx_update_expense/sx_delete_expense.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description: "Inclusive start filter: 'YYYY-MM-DD' in SX's timeZoneIdentifier (e.g. '2026-11-21'), or ISO-8601 timestamp"
        },
        to: {
          type: "string",
          description: "Inclusive end filter: 'YYYY-MM-DD' in SX's timeZoneIdentifier (e.g. '2026-11-22'), or ISO-8601 timestamp"
        },
        projectId: { type: "integer", description: "Exact owning project ID from sx_list_projects" },
        projectName: { type: "string", description: "Case-insensitive substring match against projectName" },
        tag: { type: "string", description: "Exact case-insensitive tag name filter (e.g. 'Lunch')" },
        currency: { type: "string", description: "Exact 3-letter ISO-4217 currency filter (e.g. 'CNY', 'USD')" },
        query: { type: "string", description: "Case-insensitive substring search across projectName, notes, and tags" },
        includeRefunds: { type: "boolean", description: "Include nested refunds array per expense (default true)" },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Max items to return (default 50, max 200)" },
        offset: { type: "integer", minimum: 0, description: "Zero-based pagination offset (default 0)" }
      }
    }
  },
  {
    name: "sx_list_incomes",
    title: "List SX Incomes",
    description:
      "Read Spending X income records (sorted newest first, with full pending inbox overlay including pending reversals, excluding vault secrets). Also returns pre-pagination 'aggregates' (recordCount, totalsByCurrency gross/reversal/net/count, top 10 byProject & byTag).",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description: "Inclusive start filter: 'YYYY-MM-DD' in SX's timeZoneIdentifier, or ISO-8601 timestamp"
        },
        to: {
          type: "string",
          description: "Inclusive end filter: 'YYYY-MM-DD' in SX's timeZoneIdentifier, or ISO-8601 timestamp"
        },
        projectId: { type: "integer", description: "Exact owning project ID from sx_list_projects" },
        projectName: { type: "string", description: "Case-insensitive substring match against projectName" },
        tag: { type: "string", description: "Exact case-insensitive tag name filter" },
        currency: { type: "string", description: "Exact 3-letter ISO-4217 currency filter (e.g. 'CNY', 'USD')" },
        query: { type: "string", description: "Case-insensitive substring search across projectName, notes, and tags" },
        includeReversals: { type: "boolean", description: "Include nested reversals array per income (default true)" },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Max items to return (default 50, max 200)" },
        offset: { type: "integer", minimum: 0, description: "Zero-based pagination offset (default 0)" }
      }
    }
  },
  {
    name: "sx_list_tags",
    title: "List SX Tags",
    description: "List Spending X tags with expense and income record usage counts (including pending inbox changes).",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Case-insensitive substring filter on tag name" }
      }
    }
  },
  {
    name: "sx_list_slogans",
    title: "List SX Slogans",
    description:
      "List Spending X dashboard/context slogans with language ('zh' or 'en'), pairId (shared by linked zh/en bilingual pairs), ruleType ('default', 'time_of_day', 'solar_term', 'date_specific', or 'holiday'), JSON ruleValue, ascending priority (lower integer takes precedence), and enabled state. Overlays pending inbox creates, updates, and pair deletes.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        language: {
          type: "string",
          description: "Filter by language code: 'zh' or 'en' ('zh-Hans'/'zh-CN' normalized to 'zh', 'en-*' normalized to 'en')"
        },
        enabledOnly: { type: "boolean", description: "If true, return only enabled slogans" },
        query: { type: "string", description: "Case-insensitive substring filter across text, ruleType, and ruleValue" },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Max items to return (default 50, max 200)" },
        offset: { type: "integer", minimum: 0, description: "Zero-based pagination offset (default 0)" }
      }
    }
  },

  // MARK: - SX CRUD
  {
    name: "sx_record_expense",
    title: "Record SX Expense",
    description:
      "Queue a new expense creation in Spending X. Call sx_get_catalog first. SX displays the payment date and hour as 'YYYY-MM-DD-HH' in the app timezone. Ask for the actual payment time or defer the write if the hour is unknown. CREDENTIAL BINDING RULE: When SX 'credentials' scope is enabled and 'credentialId' is omitted, the server auto-binds if the project has exactly 1 linked credential; returns queued=false, credentialSelectionRequired=true, and credentialCandidates if multiple credentials are linked so you MUST ask the user to choose and retry with credentialId (or skipCredential=true to leave unbound); and leaves unbound if 0 credentials are linked. NEVER create a new credential without explicit user request. The response always includes the actually bound credentialId (or null).",
    inputSchema: {
      type: "object",
      required: ["amount", "projectName"],
      properties: {
        amount: {
          type: "number",
          exclusiveMinimum: 0,
          description:
            "Gross original payment amount strictly > 0 before any refunds (rounded to 2 decimals, e.g. 18.5; never negative — log refunds via sx_record_refund)"
        },
        projectName: {
          type: "string",
          minLength: 1,
          description:
            "Exact name (case-insensitive) of an active SX project from sx_get_catalog with supportsExpense=true (e.g. 'EatingDrinkingOut', 'AMAP', 'Spaceship'). A project is a reusable category/service bucket — put specific merchant, dish, or item details in 'note', not as a new project."
        },
        credentialId: {
          type: "integer",
          minimum: 1,
          description:
            "Optional linked non-secret credential ID from sx_list_credentials (requires user opt-in to SX 'credentials' scope and must be actively linked to projectName). Omit to use server default resolution: auto-binds when the project has 1 linked credential, prompts for user selection when multiple exist, or leaves unbound when 0 exist. Never create a credential automatically."
        },
        skipCredential: {
          type: "boolean",
          description:
            "Set true to explicitly leave this expense without a bound credential (bypasses auto-bind when 1 linked credential exists and bypasses the selection prompt when multiple exist). Cannot be combined with credentialId."
        },
        currency: {
          type: "string",
          description:
            "Optional 3-letter uppercase ISO-4217 currency code from sx_get_catalog.supportedCurrencies (e.g. 'CNY', 'USD'). Omit to inherit the project's default currency."
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional array of tag names in pick order (prefer existing names from sx_get_catalog.tags, e.g. ['Lunch']). IMPORTANT: OMIT this field to inherit the project's recentExpenseTags; pass [] to explicitly clear all tags; pass non-empty array to set exact tags (unknown tags auto-create on device)."
        },
        note: {
          type: "string",
          description:
            "Optional free-text memo displayed as one single truncated line under the date on SX cards (put merchant, dishes, items, route, or receipt notes here; lead with key info). Write input uses singular 'note' while read output uses plural 'notes'."
        },
        date: {
          type: "string",
          description:
            "Payment time as ISO-8601 with offset, SX display format 'YYYY-MM-DD-HH', local 'YYYY-MM-DD HH:mm', or 'YYYY-MM-DD' plus a known hour. A bare date becomes local midnight. Omitting both date and hour uses the device's current time."
        },
        hour: {
          type: "integer",
          minimum: 0,
          maximum: 23,
          description:
            "Known 24-hour payment hour (0..23) in sx_get_catalog.timeZoneIdentifier. Use 0 for the midnight hour. Overrides the hour when combined with 'date' and applies to today when 'date' is omitted."
        },
        requestId: {
          type: "string",
          description:
            "Optional idempotency key so retries never create duplicates (e.g. 'meal-20261122-lunch-1'). Omit to auto-generate."
        },
        client: {
          type: "string",
          description: "Optional short calling AI assistant identifier for audit logs (e.g. 'claude', 'cursor')"
        }
      }
    }
  },
  {
    name: "sx_update_expense",
    title: "Update SX Expense",
    description:
      "Update an existing SX expense by 'id' OR patch a queued un-synced expense create (id: -1) in-place by 'pendingRequestId' (transparently targets the synced id if it synced concurrently). Omitted fields stay unchanged; sequential updates execute in strict FIFO order on device.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", minimum: 1, description: "Committed expense record ID from sx_list_expenses (provide id or pendingRequestId)" },
        pendingRequestId: {
          type: "string",
          description: "For un-synced queued creates (id: -1), pass pendingRequestId from sx_list_expenses/chaox_list_pending to edit in-place"
        },
        amount: { type: "number", exclusiveMinimum: 0, description: "New gross payment amount strictly > 0" },
        projectName: {
          type: "string",
          description:
            "Move expense to another existing project supporting expenses (validated against catalog; moving projects clears existing credentialId unless a new credentialId is also provided)"
        },
        credentialId: {
          type: "integer",
          minimum: 1,
          description: "Attach or change linked credential ID (requires 'credentials' scope)"
        },
        clearCredential: { type: "boolean", description: "Set true to detach existing credential from this expense" },
        currency: {
          type: "string",
          description: "New 3-letter ISO-4217 currency code from sx_get_catalog.supportedCurrencies (e.g. 'CNY', 'USD')"
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Replacement list of tag names (omit to keep current tags; pass [] to remove all tags)"
        },
        note: { type: "string", description: "Replacement memo text (pass '' to clear note)" },
        date: {
          type: "string",
          description:
            "New payment time as ISO-8601 with offset, SX format 'YYYY-MM-DD-HH', local 'YYYY-MM-DD HH:mm', or 'YYYY-MM-DD' plus a known hour. A bare date becomes local midnight. Omit both date and hour to keep the existing payment time."
        },
        hour: {
          type: "integer",
          minimum: 0,
          maximum: 23,
          description:
            "New known 24-hour payment hour (0..23) in SX's timezone. Use 0 for the midnight hour. If 'date' is omitted, keeps the expense's existing (or queued) localDate."
        },
        requestId: { type: "string", description: "Optional idempotency key for safe retries" },
        client: { type: "string", description: "Optional calling AI assistant identifier" }
      }
    }
  },
  {
    name: "sx_delete_expense",
    title: "Delete SX Expense (Trash)",
    description:
      "Move a committed SX expense (and its refunds) to 30-day recoverable Trash by 'id', or cancel an un-synced queued create directly by 'pendingRequestId'.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", minimum: 1, description: "Committed expense ID from sx_list_expenses (provide id or pendingRequestId)" },
        pendingRequestId: { type: "string", description: "Cancel a queued un-synced create by pendingRequestId (or delete synced target)" },
        requestId: { type: "string", description: "Optional idempotency key" },
        client: { type: "string", description: "Optional calling AI assistant identifier" }
      }
    }
  },
  {
    name: "sx_record_refund",
    title: "Record SX Refund",
    description:
      "Add a refund against an existing SX expense paymentId. Refunds inherit the parent expense's currency and reduce netAmount.",
    inputSchema: {
      type: "object",
      required: ["paymentId", "amount"],
      properties: {
        paymentId: { type: "integer", minimum: 1, description: "Parent expense ID from sx_list_expenses" },
        amount: { type: "number", exclusiveMinimum: 0, description: "Refund amount strictly > 0 in the parent expense's currency" },
        note: { type: "string", description: "Optional refund memo/reason" },
        date: { type: "string", description: "Optional refund date/time (ISO-8601, 'YYYY-MM-DD-HH', or 'YYYY-MM-DD' local)" },
        requestId: { type: "string", description: "Optional idempotency key" },
        client: { type: "string", description: "Optional calling AI assistant identifier" }
      }
    }
  },
  {
    name: "sx_update_refund",
    title: "Update SX Refund",
    description: "Update an existing SX payment refund by refund ID (omitted fields remain unchanged).",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "integer", minimum: 1, description: "Refund ID from expense.refunds[].id in sx_list_expenses" },
        amount: { type: "number", exclusiveMinimum: 0, description: "New positive refund amount" },
        note: { type: "string", description: "Replacement refund memo (pass '' to clear)" },
        date: { type: "string", description: "New refund date/time (ISO-8601 or 'YYYY-MM-DD' local)" },
        requestId: { type: "string", description: "Optional idempotency key" },
        client: { type: "string", description: "Optional calling AI assistant identifier" }
      }
    }
  },
  {
    name: "sx_delete_refund",
    title: "Delete SX Refund (Trash)",
    description: "Move an SX refund to 30-day Trash by refund ID.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "integer", minimum: 1, description: "Refund ID from expense.refunds[].id" },
        requestId: { type: "string", description: "Optional idempotency key" },
        client: { type: "string", description: "Optional calling AI assistant identifier" }
      }
    }
  },
  {
    name: "sx_record_income",
    title: "Record SX Income",
    description:
      "Queue an income creation in Spending X. Call sx_get_catalog first so projectName matches an active project with supportsIncome=true. Incomes display at calendar-day precision ('YYYY-MM-DD'). CREDENTIAL BINDING RULE: When SX 'credentials' scope is enabled and 'credentialId' is omitted, the server auto-binds if the project has exactly 1 linked credential; returns queued=false, credentialSelectionRequired=true, and credentialCandidates if multiple credentials are linked so you MUST ask the user to choose and retry with credentialId (or skipCredential=true to leave unbound); and leaves unbound if 0 credentials are linked. NEVER create a new credential without explicit user request. The response always includes the actually bound credentialId (or null).",
    inputSchema: {
      type: "object",
      required: ["amount", "projectName"],
      properties: {
        amount: { type: "number", exclusiveMinimum: 0, description: "Gross income amount strictly > 0 (before any reversals)" },
        projectName: {
          type: "string",
          minLength: 1,
          description: "Exact name (case-insensitive) of an SX project from sx_get_catalog with supportsIncome=true"
        },
        credentialId: {
          type: "integer",
          minimum: 1,
          description:
            "Optional linked credential ID from sx_list_credentials (requires SX 'credentials' scope opt-in and must be actively linked to projectName). Omit to use server default resolution: auto-binds when 1 linked credential exists, prompts for user selection when multiple exist, or leaves unbound when 0 exist. Never create a credential automatically."
        },
        skipCredential: {
          type: "boolean",
          description:
            "Set true to explicitly leave this income without a bound credential (bypasses auto-bind when 1 linked credential exists and bypasses the selection prompt when multiple exist). Cannot be combined with credentialId."
        },
        currency: {
          type: "string",
          description: "Optional 3-letter ISO-4217 currency code (e.g. 'CNY', 'USD'); omit to inherit the project's default currency"
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tag names (omit to inherit recentIncomeTags; pass [] to clear all tags)"
        },
        note: { type: "string", description: "Optional income memo (source, payer, invoice/period note)" },
        date: {
          type: "string",
          description: "Optional income date/time: ISO-8601 with offset, or calendar date 'YYYY-MM-DD' in SX's timeZoneIdentifier (defaults to now)"
        },
        requestId: { type: "string", description: "Optional idempotency key for safe retries" },
        client: { type: "string", description: "Optional calling AI assistant identifier" }
      }
    }
  },
  {
    name: "sx_update_income",
    title: "Update SX Income",
    description:
      "Update an existing SX income record by 'id' OR patch a queued un-synced income create (id: -1) in-place by 'pendingRequestId'.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", minimum: 1, description: "Income record ID from sx_list_incomes (provide id or pendingRequestId)" },
        pendingRequestId: { type: "string", description: "Pending requestId for an un-synced queued income create (id: -1)" },
        amount: { type: "number", exclusiveMinimum: 0, description: "New positive gross income amount" },
        projectName: { type: "string", description: "Move income to another existing project supporting income" },
        credentialId: { type: "integer", minimum: 1, description: "Attach/change credential ID (requires 'credentials' scope)" },
        clearCredential: { type: "boolean", description: "Set true to detach existing credential from this income" },
        currency: { type: "string", description: "New 3-letter ISO-4217 currency code" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Replacement tag names (omit to keep current tags; pass [] to clear)"
        },
        note: { type: "string", description: "Replacement income memo" },
        date: { type: "string", description: "New income date/time (ISO-8601 with offset or 'YYYY-MM-DD' local)" },
        requestId: { type: "string", description: "Optional idempotency key" },
        client: { type: "string", description: "Optional calling AI assistant identifier" }
      }
    }
  },
  {
    name: "sx_delete_income",
    title: "Delete SX Income (Trash)",
    description:
      "Move an SX income record (and its reversals) to 30-day Trash by 'id', or cancel a queued un-synced create by 'pendingRequestId'.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", minimum: 1, description: "Income record ID from sx_list_incomes (provide id or pendingRequestId)" },
        pendingRequestId: { type: "string", description: "Pending requestId to cancel an un-synced queued income create" },
        requestId: { type: "string", description: "Optional idempotency key" },
        client: { type: "string", description: "Optional calling AI assistant identifier" }
      }
    }
  },
  {
    name: "sx_record_income_reversal",
    title: "Record SX Income Reversal",
    description: "Add a reversal/clawback against an existing SX income record (reduces netAmount).",
    inputSchema: {
      type: "object",
      required: ["incomeId", "amount"],
      properties: {
        incomeId: { type: "integer", minimum: 1, description: "Parent income ID from sx_list_incomes" },
        amount: { type: "number", exclusiveMinimum: 0, description: "Positive reversal amount in parent income's currency" },
        note: { type: "string", description: "Optional reversal memo" },
        date: { type: "string", description: "Optional reversal date (ISO-8601 or 'YYYY-MM-DD' local)" },
        requestId: { type: "string", description: "Optional idempotency key" },
        client: { type: "string", description: "Optional calling AI assistant identifier" }
      }
    }
  },
  {
    name: "sx_update_income_reversal",
    title: "Update SX Income Reversal",
    description: "Update an existing SX income reversal by ID.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "integer", minimum: 1, description: "Reversal ID from income.reversals[].id" },
        amount: { type: "number", exclusiveMinimum: 0, description: "New positive reversal amount" },
        note: { type: "string", description: "Replacement reversal memo" },
        date: { type: "string", description: "New reversal date (ISO-8601 or 'YYYY-MM-DD' local)" },
        requestId: { type: "string", description: "Optional idempotency key" },
        client: { type: "string", description: "Optional calling AI assistant identifier" }
      }
    }
  },
  {
    name: "sx_delete_income_reversal",
    title: "Delete SX Income Reversal (Trash)",
    description: "Move an SX income reversal to 30-day Trash by ID.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "integer", minimum: 1, description: "Reversal ID from income.reversals[].id" },
        requestId: { type: "string", description: "Optional idempotency key" },
        client: { type: "string", description: "Optional calling AI assistant identifier" }
      }
    }
  },
  {
    name: "sx_create_project",
    title: "Create SX Project",
    description:
      "Create a new Spending X project (reusable spending/income category or subscription). Check sx_get_catalog first — never create duplicate projects or one-off projects for individual purchases.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 1, description: "Unique project name (case-insensitive across live projects)" },
        price: { type: "number", minimum: 0, description: "Listed/recurring price >= 0 (default 0 for floating/irregular categories)" },
        currency: { type: "string", description: "3-letter ISO-4217 currency code (defaults to SX summaryCurrency)" },
        cycle: {
          type: "string",
          enum: ["daily", "weekly", "monthly", "quarterly", "yearly", "irregular"],
          description: "Billing/occurrence cadence (default: 'irregular')"
        },
        priceType: {
          type: "string",
          enum: ["fixed", "floating"],
          description: "'fixed' for fixed-price subscriptions or 'floating' for variable spending (default: 'floating')"
        },
        projectType: {
          type: "string",
          enum: ["nonRenewal", "autoRenew", "pausedRenew", "expired"],
          description:
            "Lifecycle mode: 'nonRenewal' one-off/ad-hoc (default), 'autoRenew' active subscription, 'pausedRenew' paused subscription, 'expired' ended"
        },
        cashFlowSides: {
          type: "string",
          enum: ["expenseOnly", "incomeOnly", "both"],
          description: "Allowed record sides: 'expenseOnly' (default), 'incomeOnly', or 'both'"
        },
        startDate: { type: "string", description: "Optional project start date (ISO-8601 or 'YYYY-MM-DD' local; defaults to now)" },
        endDate: { type: "string", description: "Optional project end/expiry date (ISO-8601 or 'YYYY-MM-DD' local)" },
        isAutoRenew: { type: "boolean", description: "Whether auto-renewal is enabled (defaults to true only when projectType='autoRenew')" },
        notes: { type: "string", description: "Optional project description/notes (note: project uses 'notes' plural)" },
        requestId: { type: "string", description: "Optional idempotency key" },
        client: { type: "string", description: "Optional calling AI assistant identifier" }
      }
    }
  },
  {
    name: "sx_update_project",
    title: "Update SX Project",
    description: "Update an existing Spending X project by ID (omitted fields remain unchanged).",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "integer", minimum: 1, description: "Project ID from sx_list_projects" },
        name: { type: "string", description: "New unique project name" },
        price: { type: "number", minimum: 0, description: "New listed price >= 0" },
        currency: { type: "string", description: "New default 3-letter ISO-4217 currency code" },
        cycle: {
          type: "string",
          enum: ["daily", "weekly", "monthly", "quarterly", "yearly", "irregular"],
          description: "New billing cadence"
        },
        priceType: { type: "string", enum: ["fixed", "floating"], description: "'fixed' or 'floating'" },
        projectType: {
          type: "string",
          enum: ["nonRenewal", "autoRenew", "pausedRenew", "expired"],
          description: "New lifecycle mode"
        },
        cashFlowSides: {
          type: "string",
          enum: ["expenseOnly", "incomeOnly", "both"],
          description: "Allowed cash-flow sides"
        },
        notes: { type: "string", description: "Replacement project notes" },
        requestId: { type: "string", description: "Optional idempotency key" },
        client: { type: "string", description: "Optional calling AI assistant identifier" }
      }
    }
  },
  {
    name: "sx_delete_project",
    title: "Delete SX Project (Trash)",
    description:
      "Move an empty Spending X project (0 expenses, 0 income records, 0 credential links) to 30-day Trash.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "integer", minimum: 1, description: "Project ID from sx_list_projects" },
        requestId: { type: "string", description: "Optional idempotency key" },
        client: { type: "string", description: "Optional calling AI assistant identifier" }
      }
    }
  },
  {
    name: "sx_create_tag",
    title: "Create SX Tag",
    description: "Create a tag in Spending X (or restore if identically named in Trash).",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 1, description: "Unique tag name (case-insensitive)" },
        requestId: { type: "string", description: "Optional idempotency key" },
        client: { type: "string", description: "Optional calling AI assistant identifier" }
      }
    }
  },
  {
    name: "sx_rename_tag",
    title: "Rename SX Tag",
    description: "Rename an existing Spending X tag by ID.",
    inputSchema: {
      type: "object",
      required: ["id", "name"],
      properties: {
        id: { type: "integer", minimum: 1, description: "Tag ID from sx_list_tags" },
        name: { type: "string", minLength: 1, description: "New tag name" },
        requestId: { type: "string", description: "Optional idempotency key" },
        client: { type: "string", description: "Optional calling AI assistant identifier" }
      }
    }
  },
  {
    name: "sx_delete_tag",
    title: "Delete SX Tag (Trash)",
    description: "Move an SX tag to 30-day Trash by ID.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "integer", minimum: 1, description: "Tag ID from sx_list_tags" },
        requestId: { type: "string", description: "Optional idempotency key" },
        client: { type: "string", description: "Optional calling AI assistant identifier" }
      }
    }
  },
  {
    name: "sx_create_slogan",
    title: "Create SX Slogan",
    description:
      "Create a contextual slogan shown on the Spending X Dashboard. Pass 'textEn' together with a Chinese 'text' (language='zh') to create a linked zh+en bilingual pair sharing one pairId in a single call, or pass 'pairId' to attach to an existing pair. Priority sorts ascending (lower integer takes precedence).",
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: {
          type: "string",
          minLength: 1,
          description: "Primary slogan display copy (Chinese when language is 'zh', or English when language is 'en')"
        },
        textEn: {
          type: "string",
          minLength: 1,
          description:
            "Optional English counterpart copy to create a linked zh+en bilingual pair sharing one pairId in one call (requires language='zh')"
        },
        language: {
          type: "string",
          description: "Slogan language code: 'zh' (default) or 'en' ('zh-Hans'/'zh-CN' normalized to 'zh', 'en-*' normalized to 'en')"
        },
        emoji: { type: "string", description: "Optional leading emoji glyph" },
        ruleType: {
          type: "string",
          enum: ["default", "time_of_day", "solar_term", "date_specific", "holiday"],
          description:
            "Display rule: 'default' (default fallback), 'time_of_day', 'solar_term', 'date_specific', or 'holiday'"
        },
        ruleValue: {
          type: "string",
          description:
            "JSON rule parameter matching ruleType: '{}' for 'default', '{\"start\":6,\"end\":11}' for 'time_of_day' (0..23 ints, start != end), '{\"term\":\"立春\"}' for 'solar_term', '{\"month\":1,\"day\":1}' (optional endMonth/endDay; 'MM-DD' shorthand accepted) for 'date_specific', or '{\"year\":2026,\"month\":2,\"day\":17}' (optional endMonth/endDay; 'YYYY-MM-DD' shorthand accepted) for 'holiday'"
        },
        priority: {
          type: "integer",
          description:
            "Sort/selection priority where lower integer takes precedence (defaults by ruleType: holiday=1, date_specific=1, solar_term=3, time_of_day=5, default=10)"
        },
        isEnabled: { type: "boolean", description: "Whether slogan is active (default true)" },
        pairId: {
          type: "string",
          description:
            "Optional pair identifier linking zh/en bilingual counterparts (auto-generated when creating a pair with textEn)"
        },
        requestId: { type: "string", description: "Optional idempotency key" },
        client: { type: "string", description: "Optional calling AI assistant identifier" }
      }
    }
  },
  {
    name: "sx_update_slogan",
    title: "Update SX Slogan",
    description:
      "Update an existing SX slogan by ID (omitted fields remain unchanged). Updating shared fields (emoji, ruleType, ruleValue, priority, isEnabled) propagates to any linked sibling sharing the same pairId. Pass 'textZh' and/or 'textEn' to update or add the Chinese/English copy of a paired slogan alongside or instead of 'text'.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "integer", minimum: 1, description: "Slogan ID from sx_list_slogans" },
        text: { type: "string", description: "Replacement display copy for the target slogan row" },
        textZh: {
          type: "string",
          description: "Optional Chinese ('zh') copy to update or add on this slogan's bilingual pair"
        },
        textEn: {
          type: "string",
          description: "Optional English ('en') copy to update or add on this slogan's bilingual pair"
        },
        language: {
          type: "string",
          description: "Language code: 'zh' or 'en' ('zh-Hans'/'zh-CN' normalized to 'zh', 'en-*' normalized to 'en')"
        },
        emoji: {
          type: ["string", "null"],
          description: "Emoji glyph, or null/'' to clear (propagates to linked pair sibling)"
        },
        ruleType: {
          type: "string",
          enum: ["default", "time_of_day", "solar_term", "date_specific", "holiday"],
          description:
            "Display rule: 'default', 'time_of_day', 'solar_term', 'date_specific', or 'holiday' (propagates to linked pair sibling)"
        },
        ruleValue: {
          type: "string",
          description:
            "JSON rule parameter matching ruleType: '{}' for 'default', '{\"start\":6,\"end\":11}' for 'time_of_day', '{\"term\":\"立春\"}' for 'solar_term', '{\"month\":1,\"day\":1}' ('MM-DD' shorthand accepted) for 'date_specific', or '{\"year\":2026,\"month\":2,\"day\":17}' ('YYYY-MM-DD' shorthand accepted) for 'holiday' (propagates to linked pair sibling)"
        },
        priority: {
          type: "integer",
          description:
            "Sort/selection priority integer where lower integer takes precedence (holiday=1, date_specific=1, solar_term=3, time_of_day=5, default=10; propagates to linked pair sibling)"
        },
        isEnabled: {
          type: "boolean",
          description: "Enable or disable this slogan (propagates to linked pair sibling)"
        },
        requestId: { type: "string", description: "Optional idempotency key" },
        client: { type: "string", description: "Optional calling AI assistant identifier" }
      }
    }
  },
  {
    name: "sx_delete_slogan",
    title: "Delete SX Slogan (Trash)",
    description: "Move an SX slogan (and any linked bilingual pair sibling sharing its pairId) to 30-day Trash by ID.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "integer", minimum: 1, description: "Slogan ID from sx_list_slogans" },
        requestId: { type: "string", description: "Optional idempotency key" },
        client: { type: "string", description: "Optional calling AI assistant identifier" }
      }
    }
  },
  {
    name: "sx_list_credentials",
    title: "List SX Credentials (Non-Secret Metadata & Links)",
    description:
      "List Spending X non-secret credential metadata (id, username, website, type, issuer) and project link/renewal schedules when 'credentials' scope is enabled. Never returns passwords, TOTP secrets, recovery codes, or private notes.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Case-insensitive substring search across username, website, type, and issuer" },
        type: { type: "string", description: "Exact case-insensitive credential type filter (e.g. 'Login')" },
        projectId: { type: "integer", minimum: 1, description: "Filter to credentials linked to this projectId" },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Max items to return (default 50, max 200)" },
        offset: { type: "integer", minimum: 0, description: "Zero-based pagination offset (default 0)" }
      }
    }
  },
  {
    name: "sx_create_credential",
    title: "Create SX Credential Metadata",
    description:
      "Create a non-secret Spending X credential entry (and optionally link it to a project). Does not set passwords, TOTP, recovery codes, or private notes. Only create a credential when the user explicitly asks to add one — never auto-create credentials while recording expenses or incomes.",
    inputSchema: {
      type: "object",
      required: ["username"],
      properties: {
        username: { type: "string", minLength: 1, description: "Account login/email/identifier displayed on credential chips" },
        website: { type: "string", description: "Optional service domain or URL (e.g. 'spaceship.com')" },
        type: { type: "string", description: "Optional credential category label (e.g. 'Login', 'Card', 'API Key')" },
        issuer: { type: "string", description: "Optional provider or issuer name" },
        projectId: { type: "integer", minimum: 1, description: "Optional existing project ID to link (provide projectId or projectName, not both)" },
        projectName: {
          type: "string",
          description: "Optional project name to link (works even when the project was just queued in the same sync batch)"
        },
        isAutoRenew: { type: "boolean", description: "Enable auto-renewal tracking on the project-credential link" },
        startDate: { type: "string", description: "Link start/subscription start date (ISO-8601 or 'YYYY-MM-DD' local)" },
        hasStartDate: { type: "boolean", description: "Explicitly show start date (auto-enabled when startDate or isAutoRenew is true)" },
        endDate: { type: "string", description: "Optional expiration/end date (ISO-8601 or 'YYYY-MM-DD' local)" },
        nextRenewalDate: { type: "string", description: "Optional next renewal date (ISO-8601 or 'YYYY-MM-DD' local)" },
        renewalHour: {
          type: "integer",
          minimum: 0,
          maximum: 23,
          description: "24-hour local hour (0..23) when auto-recorded renewal expenses are timestamped (default 0)"
        },
        renewalWeekdays: {
          type: "integer",
          minimum: 1,
          maximum: 127,
          description:
            "7-bit weekday bitmask for daily schedules: Sun=1, Mon=2, Tue=4, Wed=8, Thu=16, Fri=32, Sat=64 (127=every day, 62=Mon-Fri, 65=weekend)"
        },
        requestId: { type: "string", description: "Optional idempotency key" },
        client: { type: "string", description: "Optional calling AI assistant identifier" }
      }
    }
  },
  {
    name: "sx_update_credential",
    title: "Update SX Credential Metadata",
    description:
      "Update non-secret credential fields (username, website, type, issuer) without touching Vault-encrypted secrets.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "integer", minimum: 1, description: "Credential ID from sx_list_credentials" },
        username: { type: "string", description: "Replacement account/login identifier" },
        website: { type: "string", description: "Replacement website/URL" },
        type: { type: "string", description: "Replacement credential category label" },
        issuer: { type: "string", description: "Replacement provider/issuer name" },
        requestId: { type: "string", description: "Optional idempotency key" },
        client: { type: "string", description: "Optional calling AI assistant identifier" }
      }
    }
  },
  {
    name: "sx_delete_credential",
    title: "Delete SX Credential (Trash)",
    description: "Move an SX credential to 30-day Trash by ID.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "integer", minimum: 1, description: "Credential ID from sx_list_credentials" },
        requestId: { type: "string", description: "Optional idempotency key" },
        client: { type: "string", description: "Optional calling AI assistant identifier" }
      }
    }
  },
  {
    name: "sx_link_credential",
    title: "Link SX Credential to Project",
    description: "Link an existing credential to an SX project with optional start/end/renewal dates.",
    inputSchema: {
      type: "object",
      required: ["credentialId", "projectId"],
      properties: {
        credentialId: { type: "integer", minimum: 1, description: "Credential ID from sx_list_credentials" },
        projectId: { type: "integer", minimum: 1, description: "Project ID from sx_list_projects" },
        isAutoRenew: { type: "boolean", description: "Enable auto-renewal tracking on this link" },
        startDate: { type: "string", description: "Link start date (ISO-8601 or 'YYYY-MM-DD' local)" },
        hasStartDate: { type: "boolean", description: "Whether startDate is active" },
        endDate: { type: "string", description: "Optional expiration date (ISO-8601 or 'YYYY-MM-DD' local)" },
        nextRenewalDate: { type: "string", description: "Optional next renewal date (ISO-8601 or 'YYYY-MM-DD' local)" },
        renewalHour: {
          type: "integer",
          minimum: 0,
          maximum: 23,
          description: "24-hour local hour (0..23) for auto-recorded renewal expenses (default 0)"
        },
        renewalWeekdays: {
          type: "integer",
          minimum: 1,
          maximum: 127,
          description:
            "7-bit weekday bitmask for daily schedules: Sun=1, Mon=2, Tue=4, Wed=8, Thu=16, Fri=32, Sat=64 (127=every day)"
        },
        requestId: { type: "string", description: "Optional idempotency key" },
        client: { type: "string", description: "Optional calling AI assistant identifier" }
      }
    }
  },
  {
    name: "sx_update_credential_link",
    title: "Update SX Credential-Project Link Dates",
    description: "Update dates or auto-renewal schedule for a linked project-credential pair.",
    inputSchema: {
      type: "object",
      required: ["credentialId", "projectId"],
      properties: {
        credentialId: { type: "integer", minimum: 1, description: "Linked credential ID" },
        projectId: { type: "integer", minimum: 1, description: "Linked project ID" },
        isAutoRenew: { type: "boolean", description: "Enable or pause auto-renewal on this link" },
        startDate: { type: "string", description: "New start date (ISO-8601 or 'YYYY-MM-DD' local)" },
        hasStartDate: { type: "boolean", description: "Whether startDate is shown" },
        endDate: { type: "string", description: "New expiration date (ISO-8601 or 'YYYY-MM-DD' local)" },
        clearEndDate: { type: "boolean", description: "Set true to remove endDate" },
        nextRenewalDate: { type: "string", description: "New next renewal date (ISO-8601 or 'YYYY-MM-DD' local)" },
        clearNextRenewalDate: { type: "boolean", description: "Set true to clear nextRenewalDate" },
        renewalHour: {
          type: "integer",
          minimum: 0,
          maximum: 23,
          description: "24-hour local hour (0..23) for auto-recorded renewal expenses"
        },
        renewalWeekdays: {
          type: "integer",
          minimum: 1,
          maximum: 127,
          description:
            "7-bit weekday bitmask for daily schedules: Sun=1, Mon=2, Tue=4, Wed=8, Thu=16, Fri=32, Sat=64 (127=every day)"
        },
        requestId: { type: "string", description: "Optional idempotency key" },
        client: { type: "string", description: "Optional calling AI assistant identifier" }
      }
    }
  },
  {
    name: "sx_unlink_credential",
    title: "Unlink SX Credential from Project (Trash)",
    description: "Soft-unlink a credential from an SX project (30-day Trash restorable).",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      required: ["credentialId", "projectId"],
      properties: {
        credentialId: { type: "integer", minimum: 1, description: "Linked credential ID" },
        projectId: { type: "integer", minimum: 1, description: "Linked project ID" },
        requestId: { type: "string", description: "Optional idempotency key" },
        client: { type: "string", description: "Optional calling AI assistant identifier" }
      }
    }
  },

  // MARK: - BX Reads
  {
    name: "bx_get_summary",
    title: "BX Body Summary",
    description:
      "Read Body X (BX) 7-day rolling summary and catalog hints with optimistic overlay. Never includes skin lesion photos.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Calendar date YYYY-MM-DD (defaults to today)" }
      }
    }
  },
  {
    name: "bx_list_sleep",
    title: "List BX Sleep (Apple Health Read-Only)",
    description:
      "Read sleep nights synced from Apple Health (asleep/in-bed minutes, stage breakdown, bedtime/wake timestamps). Strictly read-only.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "YYYY-MM-DD" },
        to: { type: "string", description: "YYYY-MM-DD" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 }
      }
    }
  },
  {
    name: "bx_list_workouts",
    title: "List BX Workouts",
    description:
      "Read workouts (Apple Health timing/duration/kcal/HR are read-only) along with mutable exercises, equipment, set groups, reps, and weights in kg, including full pending overlay and pre-pagination 'aggregates' (workoutCount, totalDurationMinutes, totalActiveEnergyKcal, totalSets, totalVolumeKg, byActivityType).",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Inclusive local start date YYYY-MM-DD or ISO-8601" },
        to: { type: "string", description: "Inclusive local end date YYYY-MM-DD or ISO-8601" },
        activityType: { type: "string", description: "Filter by effective activity type name" },
        exerciseQuery: { type: "string", description: "Filter workouts containing a matching exercise name or key" },
        equipment: { type: "string", description: "Filter workouts containing a matching equipment key" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 }
      }
    }
  },
  {
    name: "bx_list_exercises",
    title: "List BX Exercise Library",
    description:
      "Search BX's built-in 212-exercise library with Chinese/English names, muscle groups, and equipment.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        group: { type: "string" },
        equipment: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 250 }
      }
    }
  },
  {
    name: "bx_list_food",
    title: "List BX Food Entries",
    description:
      "Read Body X food/meal entries with optimistic inbox overlay and pre-pagination 'aggregates' (recordCount, totalCalories, unknownCaloriesCount, byMealType, byDate).",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Inclusive local start date YYYY-MM-DD or ISO-8601" },
        to: { type: "string", description: "Inclusive local end date YYYY-MM-DD or ISO-8601" },
        mealType: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"] },
        query: { type: "string", description: "Substring search on meal name" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 }
      }
    }
  },
  {
    name: "bx_list_skin",
    title: "List BX Medication & Skincare",
    description:
      "Read Body X skincare and topical medication logs (sunscreen, moisturizer, bodyLotion, medicine, other).",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Inclusive local start date YYYY-MM-DD or ISO-8601" },
        to: { type: "string", description: "Inclusive local end date YYYY-MM-DD or ISO-8601" },
        product: { type: "string", enum: ["sunscreen", "moisturizer", "bodyLotion", "medicine", "other"] },
        query: { type: "string", description: "Substring search on product/name" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 }
      }
    }
  },
  {
    name: "bx_list_toilet",
    title: "List BX Toilet Logs",
    description: "Read Body X bowel & urination logs (with Bristol stool scale 1..7 and notes).",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Inclusive local start date YYYY-MM-DD or ISO-8601" },
        to: { type: "string", description: "Inclusive local end date YYYY-MM-DD or ISO-8601" },
        kind: { type: "string", enum: ["bowel", "urination"] },
        stoolType: { type: "integer", minimum: 1, maximum: 7 },
        query: { type: "string", description: "Substring search on note" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 }
      }
    }
  },

  // MARK: - BX CRUD
  {
    name: "bx_record_food",
    title: "Record BX Food",
    description: "Queue a meal/food intake log for Body X. Ask for the eating time or defer the write when it is unknown.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 1, description: "Food or meal description" },
        mealType: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"], description: "Meal slot (inferred from recordedAt on device if omitted)" },
        calories: { type: "number", minimum: 0, description: "Estimated or exact kilocalories (>= 0, optional)" },
        recordedAt: {
          type: "string",
          description:
            "Actual eating time. " + BX_EVENT_TIME_FORMATS + " Omitting it uses the device's current time."
        },
        requestId: { type: "string", description: "Optional idempotency key" },
        client: { type: "string", description: "Optional calling AI assistant identifier" }
      }
    }
  },
  {
    name: "bx_update_food",
    title: "Update BX Food",
    description: "Update a BX food entry by UUID or edit an un-synced queued entry in-place by 'pending:<requestId>'.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", minLength: 1, description: "Food UUID or 'pending:<requestId>'" },
        name: { type: "string" },
        mealType: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"] },
        calories: { type: "number", minimum: 0 },
        clearCalories: { type: "boolean" },
        recordedAt: { type: "string", description: "New eating time. " + BX_EVENT_TIME_FORMATS + " Omit to keep the existing time." },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "bx_delete_food",
    title: "Delete BX Food",
    description: "Delete a BX food entry by UUID or cancel an un-synced queued entry via 'pending:<requestId>'.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", minLength: 1, description: "Food UUID or 'pending:<requestId>'" },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "bx_record_skin",
    title: "Record BX Medication / Skincare",
    description: "Queue a skincare or topical medicine application log for Body X.",
    inputSchema: {
      type: "object",
      required: ["product"],
      properties: {
        product: { type: "string", enum: ["sunscreen", "moisturizer", "bodyLotion", "medicine", "other"] },
        name: { type: "string", description: "Optional product or medication name" },
        brand: { type: "string", description: "Alias for name if no separate product label" },
        recordedAt: {
          type: "string",
          description: "Application time. " + BX_EVENT_TIME_FORMATS + " Omitting it uses the device's current time."
        },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "bx_update_skin",
    title: "Update BX Medication / Skincare",
    description: "Update a BX skincare or medication log by UUID or 'pending:<requestId>'.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", minLength: 1, description: "Skin entry UUID or 'pending:<requestId>'" },
        product: { type: "string", enum: ["sunscreen", "moisturizer", "bodyLotion", "medicine", "other"] },
        name: { type: "string" },
        recordedAt: { type: "string", description: "New application time. " + BX_EVENT_TIME_FORMATS + " Omit to keep the existing time." },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "bx_delete_skin",
    title: "Delete BX Medication / Skincare",
    description: "Delete a BX skincare or medication log by UUID or cancel via 'pending:<requestId>'.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", minLength: 1, description: "Skin entry UUID or 'pending:<requestId>'" },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "bx_record_toilet",
    title: "Record BX Toilet Event",
    description: "Queue a bowel or urination event for Body X. Bowel events require Bristol stoolType 1..7.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["bowel", "urination"], description: "Event kind (default: 'bowel')" },
        stoolType: { type: "integer", minimum: 1, maximum: 7, description: "Bristol stool scale 1..7 (required for bowel)" },
        bristol: { type: "integer", minimum: 1, maximum: 7, description: "Alias for stoolType" },
        note: { type: "string" },
        recordedAt: {
          type: "string",
          description: "Event time. " + BX_EVENT_TIME_FORMATS + " Omitting it uses the device's current time."
        },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "bx_update_toilet",
    title: "Update BX Toilet Event",
    description: "Update a BX toilet event by UUID or 'pending:<requestId>'.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", minLength: 1, description: "Toilet UUID or 'pending:<requestId>'" },
        kind: { type: "string", enum: ["bowel", "urination"] },
        stoolType: { type: "integer", minimum: 1, maximum: 7 },
        bristol: { type: "integer", minimum: 1, maximum: 7 },
        note: { type: "string" },
        recordedAt: { type: "string", description: "New event time. " + BX_EVENT_TIME_FORMATS + " Omit to keep the existing time." },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "bx_delete_toilet",
    title: "Delete BX Toilet Event",
    description: "Delete a BX toilet event by UUID or cancel via 'pending:<requestId>'.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", minLength: 1, description: "Toilet UUID or 'pending:<requestId>'" },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "bx_add_workout_exercise",
    title: "Add Exercise to BX Workout",
    description:
      "Add an exercise (from BX's 212-exercise library with equipment) and its sets/reps/weights in kg to an existing Apple Health workout.",
    inputSchema: {
      type: "object",
      required: ["workoutId", "exercise"],
      properties: {
        workoutId: { type: "string", minLength: 1 },
        exercise: { type: "string", description: "Exercise key, zh/en title, alias, or UUID from bx_list_exercises" },
        setGroups: SET_GROUP_SCHEMA,
        sets: RAW_SET_SCHEMA,
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "bx_update_workout_exercise",
    title: "Update BX Workout Exercise",
    description: "Update the exercise, sets, reps, weightKg, or position of an annotated workout entry by entryId.",
    inputSchema: {
      type: "object",
      required: ["entryId"],
      properties: {
        entryId: { type: "string", minLength: 1 },
        exercise: { type: "string" },
        setGroups: SET_GROUP_SCHEMA,
        sets: RAW_SET_SCHEMA,
        clearSets: { type: "boolean" },
        position: { type: "integer", minimum: 0 },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "bx_delete_workout_exercise",
    title: "Delete BX Workout Exercise",
    description: "Remove an annotated exercise entry from a workout by entryId (does not delete the Apple Health workout).",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      required: ["entryId"],
      properties: {
        entryId: { type: "string", minLength: 1 },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "bx_reorder_workout_exercises",
    title: "Reorder BX Workout Exercises",
    description: "Reorder exercises within a workout by supplying the full ordered list of entryIds.",
    inputSchema: {
      type: "object",
      required: ["workoutId", "entryIds"],
      properties: {
        workoutId: { type: "string", minLength: 1 },
        entryIds: { type: "array", items: { type: "string" }, minItems: 1 },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "bx_update_workout_type",
    title: "Set BX Workout Type",
    description:
      "Set chosen activity type for an Apple Health workout whose healthActivityType is 'other' (fails on workouts whose type is fixed by Health).",
    inputSchema: {
      type: "object",
      required: ["workoutId", "activityType"],
      properties: {
        workoutId: { type: "string", minLength: 1 },
        activityType: { type: ["string", "null"], description: "WorkoutActivity name e.g. traditionalStrengthTraining, or null to clear" },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },

  // MARK: - CSTEIX Reads (Strictly Read-Only: dwell, meditation, marks, opt-in places)
  {
    name: "csteix_get_summary",
    title: "CSTEIX Summary",
    description:
      "Read a combined CSTEIX overview across Wuxu articles (count, dimension breakdown, latest article) and strictly read-only dwell, meditation, and marks summaries according to allowedDomains.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Start date YYYY-MM-DD or ISO-8601" },
        to: { type: "string", description: "End date YYYY-MM-DD or ISO-8601" }
      }
    }
  },
  {
    name: "csteix_list_dwell",
    title: "List CSTEIX Dwell Records (Read-Only)",
    description:
      "Read CSTEIX dwell records synced from the iOS app. Strictly read-only. Place names and coordinates are stripped unless the user explicitly opted into the 'places' scope.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Start date YYYY-MM-DD or ISO-8601" },
        to: { type: "string", description: "End date YYYY-MM-DD or ISO-8601" },
        pillar: { type: "string", description: "Filter by movement/pillar (chaos, spacetime, existence, ix)" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 }
      }
    }
  },
  {
    name: "csteix_list_meditation",
    title: "List CSTEIX Meditation Records (Read-Only)",
    description:
      "Read CSTEIX meditation sessions synced from the iOS app. Strictly read-only. Place names and coordinates are stripped unless the user explicitly opted into the 'places' scope.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Start date YYYY-MM-DD or ISO-8601" },
        to: { type: "string", description: "End date YYYY-MM-DD or ISO-8601" },
        pillar: { type: "string", description: "Filter by movement/pillar (chaos, spacetime, existence, ix)" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 }
      }
    }
  },
  {
    name: "csteix_list_marks",
    title: "List CSTEIX Hand Marks (Read-Only)",
    description:
      "Read CSTEIX hand marks (ripples on paper and meteors on night sky) synced from the iOS app. Strictly read-only. Place data is stripped unless 'places' is opted in.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Start date YYYY-MM-DD or ISO-8601" },
        to: { type: "string", description: "End date YYYY-MM-DD or ISO-8601" },
        kind: { type: "string", enum: ["ripple", "meteor"], description: "Filter by mark kind" },
        pillar: { type: "string", description: "Filter by movement/pillar (chaos, spacetime, existence, ix)" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 }
      }
    }
  },

  // MARK: - CSTEIX Wuxu Articles (Immediate Server Database Source of Truth)
  {
    name: "csteix_list_wuxu",
    title: "List CSTEIX Wuxu Articles",
    description:
      "Search and list private daily Wuxu articles across title, English title, Chinese/English bodies, raw notes, and stage couplets. Returns metadata, section headings, leaving lines, and couplets without full bodies unless includeBody is true.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Start date YYYY-MM-DD (local to article timezone) or ISO-8601" },
        to: { type: "string", description: "End date YYYY-MM-DD (local to article timezone) or ISO-8601" },
        dimension: {
          type: "string",
          enum: ["chaos", "spacetime", "existence", "ix"],
          description: "Filter by CSTEIX dimension"
        },
        query: {
          type: "string",
          description: "Substring search across title, titleEn, bodyZh, bodyEn, rawNotes, and couplets"
        },
        hasRaw: { type: "boolean", description: "Filter by whether rawNotes is present" },
        hasEn: { type: "boolean", description: "Filter by whether bodyEn is present" },
        hasCouplets: { type: "boolean", description: "Filter by whether stage couplets are present" },
        includeDeleted: { type: "boolean", description: "Include soft-deleted articles in 30-day Trash (default false)" },
        includeBody: { type: "boolean", description: "Include full bodyZh/bodyEn/rawNotes in list response (default false)" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 }
      }
    }
  },
  {
    name: "csteix_get_wuxu",
    title: "Get CSTEIX Wuxu Article",
    description:
      "Read a single Wuxu article in full (bodyZh, bodyEn, rawNotes, couplets, headings, leavingLines, revision) by UUID id or slug.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Article UUID" },
        slug: { type: "string", description: "Article lowercase kebab-case slug" }
      }
    }
  },
  {
    name: "csteix_create_wuxu",
    title: "Create CSTEIX Wuxu Article",
    description:
      "Create a new private Wuxu article immediately in the server database and emit an applied receipt. Requires a unique lowercase kebab-case slug, at least one dimension (chaos/spacetime/existence/ix), and bodyZh. Optionally include 0-2 symmetric Stage Couplets (max 4, default []; read chaox://guide/wuxu-couplets).",
    inputSchema: {
      type: "object",
      required: ["slug", "title", "dimensions", "bodyZh"],
      properties: {
        slug: { type: "string", minLength: 1, description: "Lowercase kebab-case slug (e.g. 'bare-treetops')" },
        title: { type: "string", minLength: 1, description: "Primary Chinese title" },
        titleEn: { type: "string", description: "Optional English title" },
        dimensions: {
          type: "array",
          minItems: 1,
          items: { type: "string", enum: ["chaos", "spacetime", "existence", "ix"] },
          description: "One or more CSTEIX dimensions"
        },
        writtenAt: {
          type: "string",
          description: "ISO-8601 timestamp or local 'YYYY-MM-DD HH:mm' in article timezone (defaults to current minute)"
        },
        timezone: { type: "string", description: "IANA timezone identifier (default 'Asia/Shanghai')" },
        bodyZh: { type: "string", minLength: 1, description: "Primary Chinese Markdown body without the # Title/header skeleton" },
        bodyEn: { type: "string", description: "Optional English Markdown body" },
        rawNotes: { type: "string", description: "Optional verbatim user raw notes/utterances" },
        couplets: WUXU_COUPLETS_SCHEMA,
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "csteix_update_wuxu",
    title: "Update CSTEIX Wuxu Article",
    description:
      "Update an existing Wuxu article immediately in the server database, incrementing revision and recording an applied receipt. Supports expectedRevision optimistic locking, appendBodyZh/appendBodyEn/appendRawNotes for same-day multi-pass writing, and couplets (replace; [] clears) or appendCouplets (dedupe by normalized zh; max 4).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Article UUID (provide id or slug)" },
        slug: { type: "string", description: "Article slug (provide id or slug)" },
        expectedRevision: {
          type: "integer",
          minimum: 1,
          description: "Optional optimistic lock; fails if current revision differs"
        },
        title: { type: "string" },
        titleEn: { type: ["string", "null"] },
        dimensions: {
          type: "array",
          minItems: 1,
          items: { type: "string", enum: ["chaos", "spacetime", "existence", "ix"] }
        },
        writtenAt: { type: "string" },
        timezone: { type: "string" },
        bodyZh: { type: "string", description: "Replace entire Chinese body (cannot combine with appendBodyZh)" },
        bodyEn: { type: ["string", "null"], description: "Replace or clear English body (cannot combine with appendBodyEn)" },
        rawNotes: { type: ["string", "null"], description: "Replace or clear raw notes (cannot combine with appendRawNotes)" },
        appendBodyZh: { type: "string", description: "Append Markdown paragraph/section to bodyZh" },
        appendBodyEn: { type: "string", description: "Append Markdown paragraph/section to bodyEn" },
        appendRawNotes: { type: "string", description: "Append verbatim utterances to rawNotes" },
        couplets: {
          ...WUXU_COUPLETS_SCHEMA,
          description:
            `Replace the entire stage couplets array (pass [] to clear all couplets; cannot combine with appendCouplets). ${WUXU_COUPLETS_SCHEMA.description}`
        },
        appendCouplets: {
          ...WUXU_COUPLETS_SCHEMA,
          minItems: 1,
          description:
            `Append stage couplets onto the article, deduplicating by normalized zh (updates fields while preserving id when same zh exists; combined total <= 4; cannot combine with couplets). ${WUXU_COUPLETS_SCHEMA.description}`
        },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "csteix_delete_wuxu",
    title: "Delete CSTEIX Wuxu Article (30-Day Trash)",
    description:
      "Soft-delete a Wuxu article by setting deleted_at (recoverable for 30 days via csteix_restore_wuxu) and emit an applied receipt.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Article UUID (provide id or slug)" },
        slug: { type: "string", description: "Article slug (provide id or slug)" },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "csteix_restore_wuxu",
    title: "Restore CSTEIX Wuxu Article from Trash",
    description:
      "Restore a soft-deleted Wuxu article within its 30-day Trash window, incrementing revision and recording an applied receipt.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Article UUID (provide id or slug)" },
        slug: { type: "string", description: "Article slug (provide id or slug)" },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  }
];

function normalizeToolAnnotations(tool: McpToolDefinition): McpToolAnnotations {
  const raw = tool.annotations ?? {};
  const isReadOnly = raw.readOnlyHint === true;
  const isDestructive = raw.destructiveHint === true;
  return {
    readOnlyHint: isReadOnly,
    destructiveHint: isDestructive,
    openWorldHint: raw.openWorldHint ?? false,
    ...(isReadOnly ? { idempotentHint: true } : isDestructive ? { idempotentHint: false } : {}),
    ...(raw.idempotentHint !== undefined ? { idempotentHint: raw.idempotentHint } : {})
  };
}

export const TOOL_DEFINITIONS: McpToolDefinition[] = RAW_TOOL_DEFINITIONS.map((tool) => ({
  ...tool,
  annotations: normalizeToolAnnotations(tool)
}));
