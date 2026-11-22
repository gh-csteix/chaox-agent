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
        "Read Spending X (SX) projects, tags, rules, and default currency from sx/catalog.json. Never returns credentials or private vault data.",
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
        "Read Spending X (SX) totals for today, week, month, year, or allTime in expense or income mode, including an optimistic overlay of pending sx/inbox entries.",
      inputSchema: {
        period: z
          .enum(["today", "week", "month", "year", "allTime"])
          .optional()
          .describe("Time window (default: month)"),
        mode: z
          .enum(["expense", "income"])
          .optional()
          .describe("Cash-flow side (default: expense)")
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
        "Queue an expense write in sx/inbox for Spending X. Call sx_get_catalog first so projectName matches an active project supporting expenses. Omit tags to inherit recent project tags; pass [] to clear tags.",
      inputSchema: {
        amount: z.number().positive().describe("Expense amount (> 0)"),
        projectName: z
          .string()
          .min(1)
          .describe("Existing SX project name from sx_get_catalog"),
        currency: z
          .string()
          .optional()
          .describe("3-letter ISO currency code, e.g. CNY or USD (defaults to project/summary currency)"),
        tags: z
          .array(z.string())
          .optional()
          .describe("Tag names to attach (omit to inherit recent project tags; pass [] to clear)"),
        note: z.string().optional().describe("Expense description or merchant note"),
        date: z.string().optional().describe("ISO-8601 date/time (defaults to now)"),
        requestId: z
          .string()
          .optional()
          .describe("Optional idempotency key for safe retries"),
        client: z.string().optional().describe("Calling AI client identifier")
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
        "Queue an income write in sx/inbox for Spending X. Requires an existing projectName that supports income.",
      inputSchema: {
        amount: z.number().positive().describe("Income amount (> 0)"),
        projectName: z
          .string()
          .min(1)
          .describe("Existing SX project name from sx_get_catalog"),
        currency: z.string().optional().describe("3-letter ISO currency code, e.g. CNY or USD"),
        tags: z
          .array(z.string())
          .optional()
          .describe("Tag names to attach (omit to inherit recent project tags; pass [] to clear)"),
        note: z.string().optional().describe("Income note"),
        date: z.string().optional().describe("ISO-8601 date/time (defaults to now)"),
        requestId: z.string().optional().describe("Optional idempotency key"),
        client: z.string().optional().describe("Calling AI client identifier")
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
