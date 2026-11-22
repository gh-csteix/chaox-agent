export const MCP_SERVER_INSTRUCTIONS =
  "You are connected to a personal CHAOX Agent Protocol v1 gateway backed by the user's own Cloudflare Worker and D1 database. " +
  "Always call chaox_get_status first to check each app's granular permission policy (allowRead/allowCreate/allowUpdate/allowDelete and allowedDomains). " +
  "In BX, Apple Health sleep nights and workout frames/duration/HR/energy are strictly read-only, while food, topical medicine/skincare, toilet logs, and workout exercise/set annotations support full CRUD when enabled. " +
  "In SX, Credential Vault secrets (passwords, TOTP secrets, recovery codes, notes) NEVER leave the device. Non-secret credential metadata (username, website, type, issuer), project links/renewal dates, and record credentialId attribution are opt-in (off by default under 'credentials'). All SX deletions move items to 30-day Trash. " +
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
