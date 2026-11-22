import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ChaoxExchangeClient } from "./exchange.js";

function jsonContent(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function errorContent(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: message
      }
    ]
  };
}

export function createChaoxMcpServer(client: ChaoxExchangeClient): McpServer {
  const server = new McpServer({
    name: "chaox-agent-mcp",
    version: "1.0.0"
  });

  server.registerTool(
    "chaox_get_status",
    {
      title: "CHAOX Exchange Status",
      description:
        "Inspect CHAOX Agent Protocol manifest, app permission tiers (sx/bx), pending inbox counts, and recent or specific request receipts.",
      inputSchema: {
        app: z.enum(["sx", "bx"]).optional().describe("Filter receipts by app"),
        requestId: z
          .string()
          .optional()
          .describe("Look up a specific queued or processed requestId"),
        receiptLimit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max number of recent receipts to include (default 10)")
      },
      annotations: { readOnlyHint: true }
    },
    async (args) => {
      try {
        return jsonContent(await client.getStatus(args));
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "sx_get_catalog",
    {
      title: "SX Ledger Catalog",
      description:
        "Read Spending X (SX) timeZoneIdentifier, summaryCurrency, supportedCurrencies, active projects (with recentExpenseTags/recentIncomeTags), tags, and rules from sx/catalog.json. Call before recording expenses or incomes. Never returns credentials or private vault data.",
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () => {
      try {
        return jsonContent(await client.readSxCatalog());
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "sx_get_summary",
    {
      title: "SX Financial Summary",
      description:
        "Read Spending X (SX) net cash-flow totals converted to summaryCurrency for today, week, month, year, or allTime in expense or income mode, including committedBucket and optimisticOverlay (pending sx/inbox writes).",
      inputSchema: {
        period: z
          .enum(["today", "week", "month", "year", "allTime"])
          .optional()
          .describe("Aggregation window in SX's device timezone (default: 'month')"),
        mode: z
          .enum(["expense", "income"])
          .optional()
          .describe("Cash-flow side: 'expense' (default) or 'income'")
      },
      annotations: { readOnlyHint: true }
    },
    async (args) => {
      try {
        return jsonContent(await client.readSxSummary(args));
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "sx_record_expense",
    {
      title: "Record SX Expense",
      description:
        "Queue an expense write in sx/inbox for Spending X. Call sx_get_catalog first. SX stores expenses with date + 24-hour local hour (00-23) precision, displayed as 'YYYY-MM-DD-HH' (the last 2 digits are the 24-hour local hour, NEVER minutes or a sequence number; '00' = midnight/hour unknown).",
      inputSchema: {
        amount: z
          .number()
          .positive()
          .describe("Gross original payment amount strictly > 0 before any refunds (e.g. 18.5)"),
        projectName: z
          .string()
          .min(1)
          .describe(
            "Existing reusable SX project name from sx_get_catalog with supportsExpense=true (e.g. 'EatingDrinkingOut'). Put merchant/dish/item details in 'note', not as a new project."
          ),
        currency: z
          .string()
          .optional()
          .describe("Optional 3-letter ISO-4217 currency code (e.g. 'CNY', 'USD'); omit to inherit the project's currency"),
        tags: z
          .array(z.string())
          .optional()
          .describe("Optional tag names (OMIT to inherit the project's recentExpenseTags; pass [] to clear all tags)"),
        note: z
          .string()
          .optional()
          .describe("Optional single-line merchant/item/order memo shown below the date on SX cards"),
        date: z
          .string()
          .optional()
          .describe(
            "Optional expense date/time: ISO-8601 with offset ('2026-11-22T12:00:00+08:00'), SX display format ('2026-11-22-12'), local ('2026-11-22 12:00'), or 'YYYY-MM-DD' (defaults to local 00:00 unless 'hour' is passed). Omit both date and hour for now."
          ),
        hour: z
          .number()
          .int()
          .min(0)
          .max(23)
          .optional()
          .describe(
            "Optional 24-hour local clock hour (0..23) in SX's timezone — sets the trailing '-HH' in 'YYYY-MM-DD-HH' (0=midnight/unknown, 9=09:00, 12=12:00 noon, 19=19:00)"
          ),
        requestId: z
          .string()
          .optional()
          .describe("Optional idempotency key for safe retries"),
        client: z.string().optional().describe("Optional calling AI client identifier")
      }
    },
    async (args) => {
      try {
        return jsonContent(await client.recordSxExpense(args));
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "sx_record_income",
    {
      title: "Record SX Income",
      description:
        "Queue an income write in sx/inbox for Spending X. Requires an existing projectName with supportsIncome=true. Incomes display at calendar-day precision ('YYYY-MM-DD').",
      inputSchema: {
        amount: z.number().positive().describe("Gross income amount strictly > 0"),
        projectName: z
          .string()
          .min(1)
          .describe("Existing SX project name from sx_get_catalog with supportsIncome=true"),
        currency: z
          .string()
          .optional()
          .describe("Optional 3-letter ISO-4217 currency code (e.g. 'CNY', 'USD'); omit to inherit project currency"),
        tags: z
          .array(z.string())
          .optional()
          .describe("Optional tag names (omit to inherit recentIncomeTags; pass [] to clear)"),
        note: z.string().optional().describe("Optional income memo"),
        date: z
          .string()
          .optional()
          .describe("Optional income date/time: ISO-8601 with offset or calendar date 'YYYY-MM-DD' (defaults to now)"),
        requestId: z.string().optional().describe("Optional idempotency key"),
        client: z.string().optional().describe("Optional calling AI client identifier")
      }
    },
    async (args) => {
      try {
        return jsonContent(await client.recordSxIncome(args));
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "bx_get_summary",
    {
      title: "BX Body Summary",
      description:
        "Read Body X (BX) 7-day rolling summary and catalog hints (meals, calories, skincare counts, bowel/urination counts) with an optimistic overlay of pending bx/inbox entries. Never includes HealthKit raw data or skin photos.",
      inputSchema: {
        date: z
          .string()
          .optional()
          .describe("Calendar date YYYY-MM-DD (defaults to today in summary bundle)")
      },
      annotations: { readOnlyHint: true }
    },
    async (args) => {
      try {
        return jsonContent(await client.readBxSummary(args));
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "bx_record_food",
    {
      title: "Record BX Food",
      description:
        "Queue a meal/food intake log in bx/inbox for Body X. Omit mealType to infer from recordedAt; omit calories if unknown.",
      inputSchema: {
        name: z.string().min(1).describe("Food or meal description"),
        mealType: z
          .enum(["breakfast", "lunch", "dinner", "snack"])
          .optional()
          .describe("Meal slot (inferred from recordedAt on device if omitted)"),
        calories: z
          .number()
          .min(0)
          .optional()
          .describe("Estimated or exact kilocalories (>= 0, optional)"),
        recordedAt: z.string().optional().describe("ISO-8601 timestamp (defaults to now)"),
        requestId: z.string().optional().describe("Optional idempotency key"),
        client: z.string().optional().describe("Calling AI client identifier")
      }
    },
    async (args) => {
      try {
        return jsonContent(await client.recordBxFood(args));
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "bx_record_skin",
    {
      title: "Record BX Skincare",
      description:
        "Queue a skincare or topical medicine application log in bx/inbox for Body X.",
      inputSchema: {
        product: z
          .enum(["sunscreen", "moisturizer", "bodyLotion", "medicine", "other"])
          .describe("Skincare product category matching BX SkinApplication.Product"),
        name: z.string().optional().describe("Optional product name or label (e.g. Benzac 5%)"),
        recordedAt: z.string().optional().describe("ISO-8601 timestamp (defaults to now)"),
        requestId: z.string().optional().describe("Optional idempotency key"),
        client: z.string().optional().describe("Calling AI client identifier")
      }
    },
    async (args) => {
      try {
        return jsonContent(await client.recordBxSkin(args));
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "bx_record_toilet",
    {
      title: "Record BX Toilet Event",
      description:
        "Queue a bowel or urination event in bx/inbox for Body X. Bowel events require Bristol stoolType 1..7.",
      inputSchema: {
        kind: z
          .enum(["bowel", "urination"])
          .optional()
          .describe("Event kind (default: bowel)"),
        stoolType: z
          .number()
          .int()
          .min(1)
          .max(7)
          .optional()
          .describe("Bristol stool scale 1..7 (required for bowel, omit for urination)"),
        note: z.string().optional().describe("Optional note"),
        recordedAt: z.string().optional().describe("ISO-8601 timestamp (defaults to now)"),
        requestId: z.string().optional().describe("Optional idempotency key"),
        client: z.string().optional().describe("Calling AI client identifier")
      }
    },
    async (args) => {
      try {
        return jsonContent(await client.recordBxToilet(args));
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  return server;
}
