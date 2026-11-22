export const MCP_SERVER_INSTRUCTIONS =
  "You are connected to a personal CHAOX Agent Protocol v1 gateway backed by the user's own Cloudflare Worker and D1 database. " +
  "Always call chaox_get_status first to check each app's granular permission policy (allowRead/allowCreate/allowUpdate/allowDelete and allowedDomains). " +
  "Before recording or querying SX spending, call sx_get_catalog first to read timeZoneIdentifier, active projects (with recentExpenseTags/recentIncomeTags), tags, supportedCurrencies, and fieldGuide. " +
  "SX expenses have calendar-date + 24-hour local hour (00-23) precision, displayed in the SX app as YYYY-MM-DD-HH where the trailing two digits are the 24-hour local hour in timeZoneIdentifier (e.g. 2026-11-22-12 = 12:00 noon, 2026-11-21-00 = midnight/hour unknown — NEVER minutes or a sequence number). Pass ISO-8601 with offset ('2026-11-22T12:00:00+08:00'), 'YYYY-MM-DD-HH', or 'YYYY-MM-DD' + hour (0..23); bare YYYY-MM-DD without hour defaults to local 00:00. " +
  "In SX, projectName must match an existing reusable project/category bucket (put merchant/dish/item details in 'note'); omit 'tags' on create to inherit the project's latest tags or pass [] to clear tags. " +
  "sx_update_expense and sx_update_income apply partial patches in strict FIFO order on device, so follow-up corrections on the same record id can be queued immediately without waiting for the user to sync first. " +
  "Credential Vault secrets (passwords, TOTP secrets, recovery codes, notes) NEVER leave the device; non-secret credential metadata and links are opt-in under 'credentials'. All SX deletions move items to 30-day Trash. " +
  "In BX, Apple Health sleep nights and workout frames/duration/HR/energy are strictly read-only, while food, topical medicine/skincare, toilet logs, and workout exercise/set annotations support full CRUD when enabled. " +
  "In CSTEIX, dwell, meditation, marks, and opt-in places (off by default) are strictly read-only snapshots from the iOS app. Private daily Wuxu articles ('wuxu') execute CRUD immediately against D1 with optimistic expectedRevision locking, 30-day soft-delete Trash + restore, and immediate 'applied' receipts (synced back to iOS via GET /sync/csteix/wuxu). " +
  "SX and BX writes enqueue into D1 inbox until the user's iPhone syncs.";

export const SKILL_GUIDE_MARKDOWN = `# CHAOX Agent Skill

Use these MCP tools to read, create, update, and delete permitted records for **SX (Spending X)**, **BX (Body X)**, and **CSTEIX (with private Wuxu articles)** through the user's personal Cloudflare Worker + D1 gateway.

## Privacy, Consent & Permission Boundaries

1. **Always inspect \`chaox_get_status\` first**: each app enforces its own double-layer permission policy (\`allowRead\`, \`allowCreate\`, \`allowUpdate\`, \`allowDelete\`, and \`allowedDomains\`).
2. **SX Credential Vault Secrets Never Leave Device**: Passwords, TOTP secrets, recovery codes, and credential private notes NEVER leave the iPhone and cannot be accessed or edited via MCP. Non-secret credential metadata (\`username\`, \`website\`, \`type\`, \`issuer\`), project links/renewal schedules, and record \`credentialId\` attribution are disabled by default and require the user to opt in to the \`credentials\` scope in SX Settings.
3. **SX Trash Recoverability**: All SX delete tools (\`sx_delete_*\`, \`sx_unlink_credential\`) move items to 30-day recoverable Trash. Deleting an SX project is only permitted when it has 0 expenses, 0 income records, and 0 credential links.
4. **BX Apple Health Read-Only Boundary**: Sleep nights (\`bx_list_sleep\`) and workout timing/duration/energy/heart-rate frames in \`bx_list_workouts\` come from Apple Health and are strictly read-only. Only BX-managed annotations (\`chosenType\` when \`canChooseType: true\`, exercises, equipment, setGroups/weights) and logs (food, skincare/medication, toilet) support CRUD. Body mole skin photos never sync.
5. **CSTEIX Read-Only Domains & Opt-In Places**: \`dwell\`, \`meditation\`, and \`marks\` (\`csteix_list_dwell\`, \`csteix_list_meditation\`, \`csteix_list_marks\`) are strictly read-only snapshots uploaded by CSTEIX iOS. Location/place names are off by default (\`places\` opt-in scope) and automatically stripped unless explicitly enabled by the user.
6. **CSTEIX Wuxu Immediate D1 CRUD**: Unlike SX/BX inbox-queued writes, \`csteix_create_wuxu\`, \`csteix_update_wuxu\`, \`csteix_delete_wuxu\`, and \`csteix_restore_wuxu\` apply immediately to the user's D1 \`csteix_wuxu\` table and record an immediate \`applied\` receipt. Use lowercase kebab-case slugs, one or more CSTEIX dimensions (\`chaos\`, \`spacetime\`, \`existence\`, \`ix\`), \`expectedRevision\` for safe concurrent updates, and \`appendBodyZh\`/\`appendRawNotes\` for same-day multi-pass additions. Soft deletes stay recoverable for 30 days via \`csteix_restore_wuxu\`.
7. **Queued Execution for SX & BX**: SX and BX writes/edits/deletes enqueue in D1 \`inbox\` and apply on-device when SX or BX opens (or via AI Assistant -> Sync). Read tools overlay pending inbox changes where supported.

## Common Workflows

- **List before updating/deleting**: Call \`sx_list_expenses\` / \`sx_list_projects\` / \`sx_list_credentials\` / \`bx_list_food\` / \`bx_list_workouts\` / \`bx_list_skin\` / \`bx_list_toilet\` / \`csteix_list_wuxu\` to obtain exact record IDs, slugs, or revisions.
- **Workouts & Equipment**: Call \`bx_list_exercises\` to match exercises by key, Chinese/English title, or equipment before calling \`bx_add_workout_exercise\` or \`bx_update_workout_exercise\`.
- **Meal Photo + Cost**: Call \`sx_record_expense\` and \`bx_record_food\` with a shared \`requestId\` prefix, estimating kcal transparently when not stated.
- **Daily Wuxu Writing**: Search existing articles with \`csteix_list_wuxu\` (searches titles, bodies, and \`rawNotes\`). Call \`csteix_get_wuxu\` to inspect full text and current \`revision\`. For a new piece call \`csteix_create_wuxu\` with pure body Markdown (without the \`# Title\` header block) and verbatim user quotes in \`rawNotes\`; for same-day continuations call \`csteix_update_wuxu\` with \`expectedRevision\` and \`appendBodyZh\` / \`appendRawNotes\`.

## SX Expense & Income Field Reference

SX displays expense timestamps as **\`YYYY-MM-DD-HH\`** (for example \`2026-11-22-09\`, \`2026-11-22-12\`, \`2026-11-21-00\`). The trailing two digits **\`HH\`** are the **24-hour local clock hour (\`00\`–\`23\`)** in SX's device timezone (\`sx_get_catalog.timeZoneIdentifier\`) — **NEVER** minutes and **NEVER** a sequence number (\`00\` means midnight or exact hour unknown). Income records display at calendar-day precision (\`YYYY-MM-DD\`, without \`-HH\`).

### Write Fields (\`sx_record_expense\` / \`sx_update_expense\`)
Both tools validate immediately, and \`sx_update_expense\` applies **partial patches in strict FIFO order** on device (omitted fields stay unchanged), so you can queue a follow-up fix to \`date\` or \`hour\` (e.g. \`{ id, date: "2026-11-22", hour: 9 }\` or \`{ id, hour: 9 }\`) right away without waiting for SX to sync first.
| Field | Meaning & Rules |
|---|---|
| \`amount\` | Positive gross payment amount before any refunds (rounded to 2 decimals, never negative; record refunds separately via \`sx_record_refund\`). |
| \`projectName\` | Existing reusable SX project/category bucket from \`sx_get_catalog\` with \`supportsExpense: true\` (e.g. \`EatingDrinkingOut\`, \`AMAP\`, \`Spaceship\`). Put merchant/dish/item details in \`note\`. |
| \`currency\` | Optional 3-letter ISO-4217 code from \`supportedCurrencies\` (e.g. \`CNY\`, \`USD\`). Omit to inherit the project's default currency. |
| \`date\` | Optional timestamp: ISO-8601 with offset (\`2026-11-22T12:00:00+08:00\` or \`Z\`), SX format (\`2026-11-22-12\` or \`2026-11-22 12\`), local (\`2026-11-22 12:00\`), or calendar date (\`2026-11-22\`, defaults to \`00:00\` local = \`YYYY-MM-DD-00\` unless \`hour\` is passed). Omit \`date\` & \`hour\` on create to use current time. |
| \`hour\` | Optional integer \`0\`–\`23\`: local 24-hour clock hour in \`timeZoneIdentifier\`. Sets/overrides the trailing \`-HH\`. On create without \`date\`, applies to today; on update without \`date\`, preserves the expense's existing \`localDate\`. |
| \`tags\` | **Critical**: omit on create to inherit the project's latest record tags (\`recentExpenseTags\`); pass \`[]\` to clear all tags; pass \`["Lunch"]\` to set exact tags (on update, omitting keeps existing tags). |
| \`note\` | Free-text memo shown as one line on SX cards (put merchant, items, or route first). Write tools use singular \`note\` (server also tolerates \`notes\`); read tools return plural \`notes\`. |
| \`credentialId\` | Optional integer ID of a linked credential (\`credentials\` scope must be enabled in SX). On \`sx_update_expense\`, use \`clearCredential: true\` to detach. |
| \`requestId\` | Optional idempotency key so retries never create duplicate records. |
| \`client\` | Optional short calling AI assistant identifier for audit metadata. |

### Read Fields Returned by \`sx_list_expenses\`
- \`id\`: Positive integer expense ID (\`-1\` when still queued in D1 \`inbox\`).
- \`projectId\`, \`projectName\`: Owning SX project.
- \`amount\`, \`refundTotal\`, \`netAmount\`: Gross paid amount, sum of non-deleted refunds, and \`amount - refundTotal\` (displayed headline amount).
- \`currency\`, \`tags\`, \`notes\`: 3-letter ISO currency, applied tag names, and memo string (plural \`notes\`).
- \`paidAt\`, \`localDate\`, \`localHour\`, \`displayDate\`: Stored UTC ISO-8601 instant, local \`YYYY-MM-DD\`, 24-hour local hour \`0..23\`, and exact SX UI timestamp string \`YYYY-MM-DD-HH\`.
- \`isAutoRecorded\`: \`true\` when auto-generated by a recurring credential link schedule.
- \`credentialId\`, \`credentialName\`, \`refunds\`, \`pendingStatus\`, \`pendingRequestId\`.
`;

export const DEFAULT_PREFERENCES_MARKDOWN = `# Personal CHAOX Assistant Preferences

No custom preferences saved yet. PUT /preferences with your routing rules (for example, default meal project name, currency, or workout set conventions) so every AI client follows them automatically.
`;

export const MCP_PROMPTS = [
  {
    name: "log_meal_photo",
    description:
      "Log a meal photo and cost across SX (expense) and BX (food intake) using sanitized catalogs.",
    arguments: [
      {
        name: "amount",
        description: "Amount spent on the meal (optional if not stated yet)",
        required: false
      },
      {
        name: "currency",
        description: "3-letter currency code such as CNY or USD",
        required: false
      },
      {
        name: "meal_description",
        description: "Food description or ingredients visible in the photo",
        required: false
      }
    ]
  },
  {
    name: "daily_review",
    description:
      "Summarize today's expenses/income in SX, sleep/workouts/meals/skincare/toilet logs in BX, and dwell/meditation/Wuxu activity in CSTEIX.",
    arguments: [
      {
        name: "date",
        description: "Calendar date YYYY-MM-DD (defaults to today)",
        required: false
      }
    ]
  }
];
