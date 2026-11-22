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

export const TOOL_DEFINITIONS = [
  {
    name: "chaox_get_status",
    title: "CHAOX Exchange Status",
    description:
      "Inspect connected CHAOX apps (sx/bx/csteix), user permission policies, uploaded dataset counts, pending D1 inbox counts, and recent or specific request receipts.",
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

  // MARK: - SX Reads
  {
    name: "sx_get_catalog",
    title: "SX Ledger Catalog",
    description:
      "Read Spending X (SX) projects, tags, rules, supported currencies, and default currency. Never returns credentials or private vault data.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "sx_get_summary",
    title: "SX Financial Summary",
    description:
      "Read Spending X (SX) totals for today, week, month, year, or allTime in expense or income mode, including an optimistic overlay of pending inbox writes.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        period: { type: "string", enum: ["today", "week", "month", "year", "allTime"] },
        mode: { type: "string", enum: ["expense", "income"] }
      }
    }
  },
  {
    name: "sx_list_projects",
    title: "List SX Projects",
    description:
      "List Spending X projects with pricing, cycle, cashFlowSides, record counts, and whether each project is deletable.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        projectType: { type: "string", enum: ["nonRenewal", "autoRenew", "pausedRenew", "expired"] },
        cashFlow: { type: "string", enum: ["expense", "income"] },
        currency: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 }
      }
    }
  },
  {
    name: "sx_list_expenses",
    title: "List SX Expenses",
    description:
      "Read Spending X expense records and their refunds (excluding all credentials/vault secrets). Use IDs returned here for update or delete.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Start date YYYY-MM-DD or ISO-8601" },
        to: { type: "string", description: "End date YYYY-MM-DD or ISO-8601" },
        projectId: { type: "integer" },
        projectName: { type: "string" },
        tag: { type: "string" },
        currency: { type: "string" },
        query: { type: "string" },
        includeRefunds: { type: "boolean", description: "Include nested refund rows (default true)" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 }
      }
    }
  },
  {
    name: "sx_list_incomes",
    title: "List SX Incomes",
    description:
      "Read Spending X income records and their reversals (excluding all credentials/vault secrets). Use IDs returned here for update or delete.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        projectId: { type: "integer" },
        projectName: { type: "string" },
        tag: { type: "string" },
        currency: { type: "string" },
        query: { type: "string" },
        includeReversals: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 }
      }
    }
  },
  {
    name: "sx_list_tags",
    title: "List SX Tags",
    description: "List Spending X tags with expense and income record counts.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } }
    }
  },
  {
    name: "sx_list_slogans",
    title: "List SX Slogans",
    description: "List Spending X dashboard/context slogans.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        language: { type: "string" },
        enabledOnly: { type: "boolean" },
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 }
      }
    }
  },

  // MARK: - SX CRUD
  {
    name: "sx_record_expense",
    title: "Record SX Expense",
    description:
      "Queue an expense creation in Spending X. Call sx_get_catalog first so projectName matches an active project supporting expenses.",
    inputSchema: {
      type: "object",
      required: ["amount", "projectName"],
      properties: {
        amount: { type: "number", exclusiveMinimum: 0 },
        projectName: { type: "string", minLength: 1 },
        credentialId: {
          type: "integer",
          minimum: 1,
          description: "Optional linked credential ID (requires SX 'credentials' scope opt-in)"
        },
        currency: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        note: { type: "string" },
        date: { type: "string" },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "sx_update_expense",
    title: "Update SX Expense",
    description: "Queue an update to an existing SX expense record by ID (requires Update permission).",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "integer", minimum: 1 },
        amount: { type: "number", exclusiveMinimum: 0 },
        projectName: { type: "string" },
        credentialId: { type: "integer", minimum: 1, description: "Attach/change credential (requires 'credentials' scope)" },
        clearCredential: { type: "boolean", description: "Detach existing credential from this expense" },
        currency: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        note: { type: "string" },
        date: { type: "string" },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "sx_delete_expense",
    title: "Delete SX Expense (Trash)",
    description: "Move an SX expense (and its refunds) to 30-day Trash (requires Delete permission).",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "integer", minimum: 1 },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "sx_record_refund",
    title: "Record SX Refund",
    description: "Add a refund against an existing SX expense paymentId.",
    inputSchema: {
      type: "object",
      required: ["paymentId", "amount"],
      properties: {
        paymentId: { type: "integer", minimum: 1 },
        amount: { type: "number", exclusiveMinimum: 0 },
        note: { type: "string" },
        date: { type: "string" },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "sx_update_refund",
    title: "Update SX Refund",
    description: "Update an existing SX payment refund by refund ID.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "integer", minimum: 1 },
        amount: { type: "number", exclusiveMinimum: 0 },
        note: { type: "string" },
        date: { type: "string" },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "sx_delete_refund",
    title: "Delete SX Refund (Trash)",
    description: "Move an SX refund to Trash by refund ID.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "integer", minimum: 1 },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "sx_record_income",
    title: "Record SX Income",
    description: "Queue an income creation in Spending X. Requires an active projectName supporting income.",
    inputSchema: {
      type: "object",
      required: ["amount", "projectName"],
      properties: {
        amount: { type: "number", exclusiveMinimum: 0 },
        projectName: { type: "string", minLength: 1 },
        credentialId: {
          type: "integer",
          minimum: 1,
          description: "Optional linked credential ID (requires SX 'credentials' scope opt-in)"
        },
        currency: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        note: { type: "string" },
        date: { type: "string" },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "sx_update_income",
    title: "Update SX Income",
    description: "Update an existing SX income record by ID.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "integer", minimum: 1 },
        amount: { type: "number", exclusiveMinimum: 0 },
        projectName: { type: "string" },
        credentialId: { type: "integer", minimum: 1, description: "Attach/change credential (requires 'credentials' scope)" },
        clearCredential: { type: "boolean", description: "Detach existing credential from this income" },
        currency: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        note: { type: "string" },
        date: { type: "string" },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "sx_delete_income",
    title: "Delete SX Income (Trash)",
    description: "Move an SX income record (and its reversals) to Trash by ID.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "integer", minimum: 1 },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "sx_record_income_reversal",
    title: "Record SX Income Reversal",
    description: "Add a reversal against an existing SX income record.",
    inputSchema: {
      type: "object",
      required: ["incomeId", "amount"],
      properties: {
        incomeId: { type: "integer", minimum: 1 },
        amount: { type: "number", exclusiveMinimum: 0 },
        note: { type: "string" },
        date: { type: "string" },
        requestId: { type: "string" },
        client: { type: "string" }
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
        id: { type: "integer", minimum: 1 },
        amount: { type: "number", exclusiveMinimum: 0 },
        note: { type: "string" },
        date: { type: "string" },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "sx_delete_income_reversal",
    title: "Delete SX Income Reversal (Trash)",
    description: "Move an SX income reversal to Trash by ID.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "integer", minimum: 1 },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "sx_create_project",
    title: "Create SX Project",
    description: "Create a new Spending X project.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 1 },
        price: { type: "number", minimum: 0 },
        currency: { type: "string" },
        cycle: { type: "string", enum: ["daily", "weekly", "monthly", "quarterly", "yearly", "irregular"] },
        priceType: { type: "string", enum: ["fixed", "floating"] },
        projectType: { type: "string", enum: ["nonRenewal", "autoRenew", "pausedRenew", "expired"] },
        cashFlowSides: { type: "string", enum: ["expenseOnly", "incomeOnly", "both"] },
        startDate: { type: "string" },
        endDate: { type: "string" },
        isAutoRenew: { type: "boolean" },
        notes: { type: "string" },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "sx_update_project",
    title: "Update SX Project",
    description: "Update an existing Spending X project by ID.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "integer", minimum: 1 },
        name: { type: "string" },
        price: { type: "number", minimum: 0 },
        currency: { type: "string" },
        cycle: { type: "string", enum: ["daily", "weekly", "monthly", "quarterly", "yearly", "irregular"] },
        priceType: { type: "string", enum: ["fixed", "floating"] },
        projectType: { type: "string", enum: ["nonRenewal", "autoRenew", "pausedRenew", "expired"] },
        cashFlowSides: { type: "string", enum: ["expenseOnly", "incomeOnly", "both"] },
        notes: { type: "string" },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "sx_delete_project",
    title: "Delete SX Project (Trash)",
    description:
      "Move an empty Spending X project (0 expenses, 0 income records, 0 credential links) to Trash.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "integer", minimum: 1 },
        requestId: { type: "string" },
        client: { type: "string" }
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
        name: { type: "string", minLength: 1 },
        requestId: { type: "string" },
        client: { type: "string" }
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
        id: { type: "integer", minimum: 1 },
        name: { type: "string", minLength: 1 },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "sx_delete_tag",
    title: "Delete SX Tag (Trash)",
    description: "Move an SX tag to Trash by ID.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "integer", minimum: 1 },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "sx_create_slogan",
    title: "Create SX Slogan",
    description: "Create a slogan in Spending X.",
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", minLength: 1 },
        language: { type: "string", description: "zh-Hans or en" },
        emoji: { type: "string" },
        ruleType: { type: "string" },
        ruleValue: { type: "string" },
        priority: { type: "integer" },
        isEnabled: { type: "boolean" },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "sx_update_slogan",
    title: "Update SX Slogan",
    description: "Update an existing SX slogan by ID.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "integer", minimum: 1 },
        text: { type: "string" },
        language: { type: "string" },
        emoji: { type: ["string", "null"] },
        ruleType: { type: "string" },
        ruleValue: { type: "string" },
        priority: { type: "integer" },
        isEnabled: { type: "boolean" },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "sx_delete_slogan",
    title: "Delete SX Slogan (Trash)",
    description: "Move an SX slogan to Trash by ID.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "integer", minimum: 1 },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "sx_list_credentials",
    title: "List SX Credentials (Non-Secret Metadata & Links)",
    description:
      "List Spending X credential metadata (username, website, type, issuer) and project link/renewal schedules when 'credentials' scope is enabled. Never returns passwords, TOTP secrets, recovery codes, or private notes.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        type: { type: "string" },
        projectId: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 }
      }
    }
  },
  {
    name: "sx_create_credential",
    title: "Create SX Credential Metadata",
    description:
      "Create a non-secret Spending X credential entry (and optionally link it to a project). Does not set passwords, TOTP, recovery codes, or notes.",
    inputSchema: {
      type: "object",
      required: ["username"],
      properties: {
        username: { type: "string", minLength: 1 },
        website: { type: "string" },
        type: { type: "string" },
        issuer: { type: "string" },
        projectId: { type: "integer", minimum: 1 },
        projectName: {
          type: "string",
          description: "Optional project name to link (works even when the project was just queued in the same sync batch)"
        },
        isAutoRenew: { type: "boolean" },
        startDate: { type: "string" },
        hasStartDate: { type: "boolean" },
        endDate: { type: "string" },
        nextRenewalDate: { type: "string" },
        renewalHour: { type: "integer", minimum: 0, maximum: 23 },
        renewalWeekdays: { type: "integer", minimum: 1, maximum: 127 },
        requestId: { type: "string" },
        client: { type: "string" }
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
        id: { type: "integer", minimum: 1 },
        username: { type: "string" },
        website: { type: "string" },
        type: { type: "string" },
        issuer: { type: "string" },
        requestId: { type: "string" },
        client: { type: "string" }
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
        id: { type: "integer", minimum: 1 },
        requestId: { type: "string" },
        client: { type: "string" }
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
        credentialId: { type: "integer", minimum: 1 },
        projectId: { type: "integer", minimum: 1 },
        isAutoRenew: { type: "boolean" },
        startDate: { type: "string" },
        hasStartDate: { type: "boolean" },
        endDate: { type: "string" },
        nextRenewalDate: { type: "string" },
        renewalHour: { type: "integer", minimum: 0, maximum: 23 },
        renewalWeekdays: { type: "integer", minimum: 1, maximum: 127 },
        requestId: { type: "string" },
        client: { type: "string" }
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
        credentialId: { type: "integer", minimum: 1 },
        projectId: { type: "integer", minimum: 1 },
        isAutoRenew: { type: "boolean" },
        startDate: { type: "string" },
        hasStartDate: { type: "boolean" },
        endDate: { type: "string" },
        clearEndDate: { type: "boolean" },
        nextRenewalDate: { type: "string" },
        clearNextRenewalDate: { type: "boolean" },
        renewalHour: { type: "integer", minimum: 0, maximum: 23 },
        renewalWeekdays: { type: "integer", minimum: 1, maximum: 127 },
        requestId: { type: "string" },
        client: { type: "string" }
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
        credentialId: { type: "integer", minimum: 1 },
        projectId: { type: "integer", minimum: 1 },
        requestId: { type: "string" },
        client: { type: "string" }
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
      "Read workouts (Apple Health timing/duration/kcal/HR are read-only) along with mutable exercises, equipment, set groups, reps, and weights in kg.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        activityType: { type: "string" },
        exerciseQuery: { type: "string" },
        equipment: { type: "string" },
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
    description: "Read Body X food/meal entries with optimistic inbox overlay.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        mealType: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"] },
        query: { type: "string" },
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
        from: { type: "string" },
        to: { type: "string" },
        product: { type: "string", enum: ["sunscreen", "moisturizer", "bodyLotion", "medicine", "other"] },
        query: { type: "string" },
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
        from: { type: "string" },
        to: { type: "string" },
        kind: { type: "string", enum: ["bowel", "urination"] },
        stoolType: { type: "integer", minimum: 1, maximum: 7 },
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 }
      }
    }
  },

  // MARK: - BX CRUD
  {
    name: "bx_record_food",
    title: "Record BX Food",
    description: "Queue a meal/food intake log for Body X.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 1 },
        mealType: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"] },
        calories: { type: "number", minimum: 0 },
        recordedAt: { type: "string" },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "bx_update_food",
    title: "Update BX Food",
    description: "Update an existing BX food entry by UUID.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", minLength: 1 },
        name: { type: "string" },
        mealType: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"] },
        calories: { type: "number", exclusiveMinimum: 0 },
        clearCalories: { type: "boolean" },
        recordedAt: { type: "string" },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "bx_delete_food",
    title: "Delete BX Food",
    description: "Delete a BX food entry by UUID.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", minLength: 1 },
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
        name: { type: "string" },
        brand: { type: "string" },
        recordedAt: { type: "string" },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "bx_update_skin",
    title: "Update BX Medication / Skincare",
    description: "Update an existing BX skincare or medication log by UUID.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", minLength: 1 },
        product: { type: "string", enum: ["sunscreen", "moisturizer", "bodyLotion", "medicine", "other"] },
        name: { type: "string" },
        recordedAt: { type: "string" },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "bx_delete_skin",
    title: "Delete BX Medication / Skincare",
    description: "Delete a BX skincare or medication log by UUID.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", minLength: 1 },
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
        kind: { type: "string", enum: ["bowel", "urination"] },
        stoolType: { type: "integer", minimum: 1, maximum: 7 },
        bristol: { type: "integer", minimum: 1, maximum: 7 },
        note: { type: "string" },
        recordedAt: { type: "string" },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "bx_update_toilet",
    title: "Update BX Toilet Event",
    description: "Update an existing BX toilet event by UUID.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", minLength: 1 },
        kind: { type: "string", enum: ["bowel", "urination"] },
        stoolType: { type: "integer", minimum: 1, maximum: 7 },
        bristol: { type: "integer", minimum: 1, maximum: 7 },
        note: { type: "string" },
        recordedAt: { type: "string" },
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "bx_delete_toilet",
    title: "Delete BX Toilet Event",
    description: "Delete a BX toilet event by UUID.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", minLength: 1 },
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

  // MARK: - CSTEIX Wuxu Articles (Immediate D1 Source of Truth)
  {
    name: "csteix_list_wuxu",
    title: "List CSTEIX Wuxu Articles",
    description:
      "Search and list private daily Wuxu articles across title, English title, Chinese/English bodies, and raw notes. Returns metadata, section headings, and leaving lines without full bodies unless includeBody is true.",
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
        query: { type: "string", description: "Substring search across title, titleEn, bodyZh, bodyEn, and rawNotes" },
        hasRaw: { type: "boolean", description: "Filter by whether rawNotes is present" },
        hasEn: { type: "boolean", description: "Filter by whether bodyEn is present" },
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
      "Read a single Wuxu article in full (bodyZh, bodyEn, rawNotes, headings, leavingLines, revision) by UUID id or slug.",
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
      "Create a new private Wuxu article immediately in D1 and emit an applied receipt. Requires a unique lowercase kebab-case slug, at least one dimension (chaos/spacetime/existence/ix), and bodyZh.",
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
        requestId: { type: "string" },
        client: { type: "string" }
      }
    }
  },
  {
    name: "csteix_update_wuxu",
    title: "Update CSTEIX Wuxu Article",
    description:
      "Update an existing Wuxu article immediately in D1, incrementing revision and recording an applied receipt. Supports expectedRevision optimistic locking and appendBodyZh/appendBodyEn/appendRawNotes for same-day multi-pass writing.",
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
