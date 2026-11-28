export const MCP_SERVER_INSTRUCTIONS =
  "You are connected to a personal CHAOX Agent Protocol v1 gateway backed by the user's own self-hosted server and SQLite/D1 database. " +
  "Start sessions with chaox_get_briefing (for a one-shot daily overview, active catalogs, and user preferences) or chaox_get_status (to inspect permissions, receipts, and pending inbox counts). " +
  "Use chaox_get_preferences / chaox_update_preferences to remember user-stated routing habits, and chaox_list_pending / chaox_cancel_pending (or pendingRequestId / 'pending:<requestId>' directly on update/delete tools) to inspect, fix, or cancel un-synced queued writes. " +
  "Before recording SX spending when projects aren't already known, call sx_get_catalog to read timeZoneIdentifier, active projects (with recentExpenseTags/recentIncomeTags), tags, supportedCurrencies, and fieldGuide. " +
  "SX displays expenses at hour precision as YYYY-MM-DD-HH in the app timezone. Use hour=0 only for a known payment in the midnight hour. For SX expenses and BX food, ask for the event time or defer the write when only the date is known. A bare date currently produces local midnight in SX or local noon in BX, and omitting time on create lets the device use its current time. Keep order, payment, eating, and message times distinct. " +
  "In SX, projectName must match an existing reusable project/category bucket (put merchant/dish/item details in 'note'); omit 'tags' on create to inherit the project's latest tags or pass [] to clear tags. " +
  "sx_update_expense and sx_update_income apply partial patches in strict FIFO order on device, and also support editing/cancelling queued creates via pendingRequestId. " +
  "Credential Vault secrets (passwords, TOTP secrets, recovery codes, notes) NEVER leave the device; non-secret credential metadata and links are opt-in under 'credentials'. When 'credentials' scope is enabled for SX expenses/incomes, omitting 'credentialId' auto-binds if the project has 1 linked credential, pauses (queued=false, credentialSelectionRequired=true, credentialCandidates) if multiple exist so you MUST ask the user to choose (or pass skipCredential=true to leave unbound), and leaves unbound if 0 exist — never auto-create credentials; responses always include the bound credentialId (or null). All SX deletions move items to 30-day Trash. " +
  "In BX, Apple Health sleep nights and workout frames/duration/HR/energy are strictly read-only, while food, topical medicine/skincare, toilet logs, and workout exercise/set annotations support full CRUD when enabled. Pass a known BX event time as ISO-8601 with offset or local 'YYYY-MM-DD HH:mm' in the BX timezone. " +
  "In CSTEIX, dwell, meditation, marks, and opt-in places (off by default) are strictly read-only snapshots from the iOS app. Private daily Wuxu articles ('wuxu') execute CRUD immediately against the server database with optimistic expectedRevision locking, 30-day soft-delete Trash + restore, and immediate 'applied' receipts (also readable via chaox://wuxu/{slug}). Wuxu articles optionally carry 0-2 (max 4, default []) bilingual symmetric Stage Couplets ('couplets'/'appendCouplets'); read chaox://guide/wuxu-couplets before authoring couplets. " +
  "Report queued SX and BX writes as pending. Check chaox_get_status with app and requestId for the device receipt, then read the synced record to confirm its stored event time. When reporting Beijing time, convert known instants to Asia/Shanghai and keep the original precision.";

export const SKILL_GUIDE_MARKDOWN = `# CHAOX Agent Skill

Use these MCP tools to read, create, update, and delete permitted records for **SX (Spending X)**, **BX (Body X)**, and **CSTEIX (with private Wuxu articles)** through the user's personal CHAOX Agent server (Docker/Node + SQLite, Cloudflare Workers + D1, or any compatible BYOS endpoint).

## Privacy, Consent & Permission Boundaries

1. **Always inspect \`chaox_get_status\` first**: each app enforces its own double-layer permission policy (\`allowRead\`, \`allowCreate\`, \`allowUpdate\`, \`allowDelete\`, and \`allowedDomains\`).
2. **SX Credential Vault Secrets Never Leave Device**: Passwords, TOTP secrets, recovery codes, and credential private notes NEVER leave the iPhone and cannot be accessed or edited via MCP. Non-secret credential metadata (\`username\`, \`website\`, \`type\`, \`issuer\`), project links/renewal schedules, and record \`credentialId\` attribution are disabled by default and require the user to opt in to the \`credentials\` scope in SX Settings.
3. **SX Trash Recoverability**: All SX delete tools (\`sx_delete_*\`, \`sx_unlink_credential\`) move items to 30-day recoverable Trash. Deleting an SX project is only permitted when it has 0 expenses, 0 income records, and 0 credential links.
4. **BX Apple Health Read-Only Boundary**: Sleep nights (\`bx_list_sleep\`) and workout timing/duration/energy/heart-rate frames in \`bx_list_workouts\` come from Apple Health and are strictly read-only. Only BX-managed annotations (\`chosenType\` when \`canChooseType: true\`, exercises, equipment, setGroups/weights) and logs (food, skincare/medication, toilet) support CRUD. Body mole skin photos never sync.
5. **CSTEIX Read-Only Domains & Opt-In Places**: \`dwell\`, \`meditation\`, and \`marks\` (\`csteix_list_dwell\`, \`csteix_list_meditation\`, \`csteix_list_marks\`) are strictly read-only snapshots uploaded by CSTEIX iOS. Location/place names are off by default (\`places\` opt-in scope) and automatically stripped unless explicitly enabled by the user.
6. **CSTEIX Wuxu Immediate Server CRUD**: Unlike SX/BX inbox-queued writes, \`csteix_create_wuxu\`, \`csteix_update_wuxu\`, \`csteix_delete_wuxu\`, and \`csteix_restore_wuxu\` apply immediately to the user's server database \`csteix_wuxu\` table and record an immediate \`applied\` receipt. Use lowercase kebab-case slugs, one or more CSTEIX dimensions (\`chaos\`, \`spacetime\`, \`existence\`, \`ix\`), \`expectedRevision\` for safe concurrent updates, and \`appendBodyZh\`/\`appendRawNotes\` for same-day multi-pass additions. Soft deletes stay recoverable for 30 days via \`csteix_restore_wuxu\`.
7. **Queued Execution for SX & BX**: SX and BX writes/edits/deletes enqueue in the server \`inbox\` and apply on-device when SX or BX opens (or via AI Assistant -> Sync). Read tools overlay pending inbox changes where supported.

## Common Workflows

- **One-Shot Context (\`chaox_get_briefing\`)**: Call \`chaox_get_briefing\` at the start of a session to retrieve custom preferences, SX today/month optimistic totals + active projects/tags, BX daily totals + latest sleep + workouts, and CSTEIX summary in one round-trip.
- **Remember Habits**: Use \`chaox_get_preferences\` / \`chaox_update_preferences\` (with \`append\` or \`content\`) so routing rules stay consistent across AI clients.
- **Inspect / Fix / Cancel Un-Synced Inbox Writes**: Call \`chaox_list_pending\` to view queued SX/BX writes, pass \`pendingRequestId\` to \`sx_update_expense\` / \`sx_delete_expense\` / \`sx_update_income\` / \`sx_delete_income\` or \`pending:<requestId>\` to BX \`update_*\` / \`delete_*\` to edit/cancel before sync, or call \`chaox_cancel_pending\`.
- **Aggregates Without Large Pagination**: \`sx_list_expenses\`, \`sx_list_incomes\`, \`bx_list_food\`, and \`bx_list_workouts\` always compute pre-pagination \`aggregates\` across the entire filtered set (currency totals, top projects/tags, meal calories, set volume kg).
- **List before updating/deleting**: Call \`sx_list_expenses\` / \`sx_list_projects\` / \`sx_list_credentials\` / \`bx_list_food\` / \`bx_list_workouts\` / \`bx_list_skin\` / \`bx_list_toilet\` / \`csteix_list_wuxu\` to obtain exact record IDs, slugs, or revisions.
- **Workouts & Equipment**: Call \`bx_list_exercises\` to match exercises by key, Chinese/English title, or equipment before calling \`bx_add_workout_exercise\` or \`bx_update_workout_exercise\`.
- **Meal Photo + Cost**: Use payment time for \`sx_record_expense\` and eating time for \`bx_record_food\`. Verify each independently and ask for missing times before submitting the affected write. Use a shared \`requestId\` prefix for related writes and label estimated calories.
- **Daily Wuxu Writing**: Search existing articles with \`csteix_list_wuxu\` (searches titles, bodies, \`rawNotes\`, and \`couplets\`). Read full Markdown via \`csteix_get_wuxu\` or MCP resource \`chaox://wuxu/{slug}\`. For a new piece call \`csteix_create_wuxu\` with pure body Markdown (without the \`# Title\` header block) and verbatim user quotes in \`rawNotes\`; for same-day continuations call \`csteix_update_wuxu\` with \`expectedRevision\` and \`appendBodyZh\` / \`appendRawNotes\`. Optionally distill \`0–2\` (default \`[]\`, hard cap \`4\`) bilingual symmetric Stage Couplets (\`couplets\` / \`appendCouplets\`) only when the piece carries timeless aphorisms worthy of the meditation stage — read \`chaox://guide/wuxu-couplets\` first for PivotText symmetry math and CSTEIX terminology (\`我求\` = \`IX\`).

## Recording and Confirming Event Times

- Use the timestamp for the event being recorded. Keep order, payment, eating, and message times distinct.
- For a known time, prefer ISO-8601 with an explicit offset. Local inputs use the app timezone. Existing v1 tools turn a bare date into local midnight for SX expenses and local noon for BX logs. Omitting time on create lets the device use its current time. Ask for the event time or defer an SX expense or BX log with an unknown time. On an update that changes other fields, omit the time fields to preserve the existing event time.
- On submission, report the requested time and its known precision as pending. Query \`chaox_get_status\` with \`app\` and \`requestId\` for the device receipt. Read the synced record to confirm the stored time. List entries with \`pendingStatus\` can include proposed values. When reporting Beijing time, convert known instants to \`Asia/Shanghai\` and keep the original precision.

## SX Expense & Income Field Reference

SX displays expense timestamps as **\`YYYY-MM-DD-HH\`** at hour precision in \`sx_get_catalog.timeZoneIdentifier\`. The trailing \`HH\` is the 24-hour clock hour (\`00\`–\`23\`). Use \`hour: 0\` only for a known payment in the midnight hour. A stored \`-00\` can also come from a legacy date-only write. Income records display at calendar-day precision (\`YYYY-MM-DD\`).

### Write Fields (\`sx_record_expense\` / \`sx_update_expense\`)
Both tools validate immediately, and \`sx_update_expense\` applies **partial patches in strict FIFO order** on device (omitted fields stay unchanged), so you can queue a follow-up fix to \`date\` or \`hour\` (e.g. \`{ id, date: "2026-11-22", hour: 9 }\` or \`{ id, hour: 9 }\`) right away without waiting for SX to sync first.
| Field | Meaning & Rules |
|---|---|
| \`amount\` | Positive gross payment amount before any refunds (rounded to 2 decimals, never negative; record refunds separately via \`sx_record_refund\`). |
| \`projectName\` | Existing reusable SX project/category bucket from \`sx_get_catalog\` with \`supportsExpense: true\` (e.g. \`EatingDrinkingOut\`, \`AMAP\`, \`Spaceship\`). Put merchant/dish/item details in \`note\`. |
| \`currency\` | Optional 3-letter ISO-4217 code from \`supportedCurrencies\` (e.g. \`CNY\`, \`USD\`). Omit to inherit the project's default currency. |
| \`date\` | Payment time as ISO-8601 with offset (\`2026-11-22T12:00:00+08:00\`), SX hour format (\`2026-11-22-12\`), local date and time (\`2026-11-22 12:00\`), or calendar date plus a known \`hour\`. A bare date becomes local midnight. Omitting both fields on create uses the device's current time. |
| \`hour\` | Optional integer \`0\`–\`23\`: local 24-hour clock hour in \`timeZoneIdentifier\`. Sets/overrides the trailing \`-HH\`. On create without \`date\`, applies to today; on update without \`date\`, preserves the expense's existing \`localDate\`. |
| \`tags\` | **Critical**: omit on create to inherit the project's latest record tags (\`recentExpenseTags\`); pass \`[]\` to clear all tags; pass \`["Lunch"]\` to set exact tags (on update, omitting keeps existing tags). |
| \`note\` | Free-text memo shown as one line on SX cards (put merchant, items, or route first). Write tools use singular \`note\` (server also tolerates \`notes\`); read tools return plural \`notes\`. |
| \`credentialId\` | Optional integer ID of a linked credential (\`credentials\` scope must be enabled in SX). When omitted with \`credentials\` enabled, \`sx_record_expense\` / \`sx_record_income\` auto-bind if the project has 1 linked credential, return \`queued: false\` + \`credentialSelectionRequired: true\` + \`credentialCandidates\` when multiple exist (ask the user to choose, or pass \`skipCredential: true\`), and leave unbound if 0 exist. Never auto-create credentials. Responses return the bound \`credentialId\` (or \`null\`). On \`sx_update_expense\`, use \`clearCredential: true\` to detach. |
| \`skipCredential\` | Optional boolean for \`sx_record_expense\` / \`sx_record_income\`: set \`true\` to explicitly leave unbound (skips 1-credential auto-bind and multi-credential selection prompt). Cannot combine with \`credentialId\`. |
| \`requestId\` | Optional idempotency key so retries never create duplicate records. |
| \`client\` | Optional short calling AI assistant identifier for audit metadata. |

### Read Fields Returned by \`sx_list_expenses\`
- \`id\`: Positive integer expense ID (\`-1\` when still queued in server \`inbox\`).
- \`projectId\`, \`projectName\`: Owning SX project.
- \`amount\`, \`refundTotal\`, \`netAmount\`: Gross paid amount, sum of non-deleted refunds, and \`amount - refundTotal\` (displayed headline amount).
- \`currency\`, \`tags\`, \`notes\`: 3-letter ISO currency, applied tag names, and memo string (plural \`notes\`).
- \`paidAt\`, \`localDate\`, \`localHour\`, \`displayDate\`: Stored UTC ISO-8601 instant, local \`YYYY-MM-DD\`, 24-hour local hour \`0..23\`, and exact SX UI timestamp string \`YYYY-MM-DD-HH\`.
- \`isAutoRecorded\`: \`true\` when auto-generated by a recurring credential link schedule.
- \`credentialId\`, \`credentialName\`, \`refunds\`, \`pendingStatus\`, \`pendingRequestId\`.
`;

export const DEFAULT_PREFERENCES_MARKDOWN = `# Personal CHAOX Assistant Preferences

No custom preferences saved yet. Call chaox_update_preferences (or PUT /preferences) with your routing rules (for example, default meal project name, currency, or workout set conventions) so every AI client follows them automatically.
`;

export const WUXU_COUPLETS_GUIDE_MARKDOWN = `# CSTEIX Wuxu Stage Couplets Guide

Stage Couplets (\`couplets\`) are optional bilingual aphorism pairs distilled from a private Wuxu article and shown centered around the ink origin on the CSTEIX meditation stage.

## 1. Selectivity: 0 by Default, 1-2 Maximum When Earned

- **Default to \`[]\` (0 couplets).** Most daily journals, passing observations, factual logs, and raw emotional notes need zero couplets.
- **Distill 1-2 couplets ONLY** when the article holds a timeless, condensed insight worthy of standing alone on the CSTEIX meditation stage. Never force a couplet onto routine entries.
- **Server hard limit**: at most **4** couplets per article.

## 2. Per-Couplet Dimension

Each couplet carries its own \`dimension\` (\`"chaos"\`, \`"spacetime"\`, \`"existence"\`, or \`"ix"\`), chosen for that aphorism's own scale:

- \`chaos\`: ground everything rises from, emergence, entropy, perpetual becoming
- \`spacetime\`: vessel things unfold in, wild cosmos, void holding, time flowing
- \`existence\`: standing point, fit body carrying Dao, steady mind, weight of presence
- \`ix\`: narrative agency, negative space, distilling joy, braiding fortune

## 3. Chinese (\`zh\`) Symmetry Rules

- Format: \`LEFT|RIGHT\` (full-width \`｜\` is normalized to \`|\`; outer whitespace and spaces around \`|\` are trimmed).
- Exactly **one \`|\`** separating non-empty left and right halves.
- **Strict equal length**: each half must be **2 to 6 Unicode characters**, and **\`leftLen === rightLen\`**.
- **Zero noise**: no whitespace or newlines inside either half, no emoji, no Markdown (\`* _ \\\` # >\`), no \`——\`, and no punctuation (\`, . ! ? ; : ， 。 ！ ？ ； ： 、 " ' “ ” ‘ ’ ( ) （ ） 《 》 【 】 — –\`).

## 4. English (\`en\`) Symmetry & PivotText Math

- Format: \`LEFT|RIGHT\` (internal whitespace runs collapse to single spaces; normalized to **uppercase ASCII**).
- Exactly **one \`|\`** separating non-empty left and right halves.
- Each half must match \`/^[A-Z]+(?: [A-Z]+)*$/\` (uppercase ASCII letters \`A-Z\` and single spaces only — no punctuation, apostrophes, hyphens, digits, or emoji).
- **PivotText rendering algorithm** (matching CSTEIX web & iOS \`PivotText.halves\`):
  1. Strip all spaces from each half -> \`leftRaw\`, \`rightRaw\`.
  2. Merge adjacent identical letters (\`dedupe\`, collapsing runs like \`LL -> L\` or \`SS -> S\`, including across word boundaries) **ONLY on the strictly longer raw half**:
     - \`leftOut = leftRaw.length > rightRaw.length ? dedupe(leftRaw) : leftRaw\`
     - \`rightOut = rightRaw.length > leftRaw.length ? dedupe(rightRaw) : rightRaw\`
     - If \`leftRaw.length === rightRaw.length\`, neither half is deduped.
  3. **Strict server bounds**: both \`leftOut\` and \`rightOut\` must be **6 to 17 characters**, and \`|leftOut.length - rightOut.length| <= 3\` (**aim for \`<= 2\`** for visual balance).

## 5. Mandatory CSTEIX Terminology Glossary

One term, one canonical English word:

| Chinese | Canonical English | Forbidden Substitutes |
|---|---|---|
| \`我求\` | \`IX\` (always uppercase noun) | NEVER \`SEEK\`, \`SEEKING\`, \`EXPLORE\`, \`EXPLORING\`, \`QUEST\`, \`PURSUIT\` (rejected by server guard when \`我求\` appears in \`zh\`) |
| \`道\` | \`DAO\` | never \`WAY\` or \`PATH\` when naming Dao |
| \`容器\` | \`VESSEL\` | never \`CONTAINER\` |
| \`分量\` | \`WEIGHT\` | never \`HEFT\` or \`IMPORTANCE\` |
| \`资格\` | \`STANDING\` | never \`CREDENTIAL\` or \`RIGHT TO EXIST\` |

*(Note: ordinary verbs stay natural English, and \`探求\` in \`未定义处|亦可探求\` renders as \`INQUIRY\`, not \`IX\`.)*

## 6. Five Worked Examples

1. **\`chaos\`**
   - \`zh\`: \`"一切|基底"\` (left=2, right=2)
   - \`en\`: \`"ALL THINGS|ONE GROUND"\`
   - PivotText math: \`leftRaw="ALLTHINGS"\` (9), \`rightRaw="ONEGROUND"\` (9) -> equal length, no dedupe -> \`leftOut="ALLTHINGS"\` (9), \`rightOut="ONEGROUND"\` (9), diff=0.
2. **\`spacetime\`** (uses \`容器 = VESSEL\`)
   - \`zh\`: \`"涌现|容器"\` (left=2, right=2)
   - \`en\`: \`"ALL RISING|ONE VESSEL"\`
   - PivotText math: \`leftRaw="ALLRISING"\` (9), \`rightRaw="ONEVESSEL"\` (9) -> equal length -> \`leftOut="ALLRISING"\` (9), \`rightOut="ONEVESSEL"\` (9), diff=0.
3. **\`existence\`** (uses \`道 = DAO\` and longer-half \`dedupe\`)
   - \`zh\`: \`"以身载道|无身则无"\` (left=4, right=4)
   - \`en\`: \`"BODY CARRIES DAO|NO BODY NO DAO"\`
   - PivotText math: \`leftRaw="BODYCARRIESDAO"\` (14) > \`rightRaw="NOBODYNODAO"\` (11) -> dedupe left (\`RR->R\`) -> \`leftOut="BODYCARIESDAO"\` (13), \`rightOut="NOBODYNODAO"\` (11), diff=2.
4. **\`ix\`** (demonstrates strictly-longer-half-only \`dedupe\`)
   - \`zh\`: \`"万物之先|是为故事"\` (left=4, right=4)
   - \`en\`: \`"BEFORE ALL THINGS|THERE WAS STORY"\`
   - PivotText math: \`leftRaw="BEFOREALLTHINGS"\` (15) > \`rightRaw="THEREWASSTORY"\` (13) -> dedupe left only (\`LL->L\`) -> \`leftOut="BEFOREALTHINGS"\` (14), \`rightOut="THEREWASSTORY"\` (13), diff=1.
5. **\`ix\`** (uses \`我求 = IX\`)
   - \`zh\`: \`"此身有尽|我求无涯"\` (left=4, right=4)
   - \`en\`: \`"THIS BODY ENDS|IX KNOWS NO END"\`
   - PivotText math: \`leftRaw="THISBODYENDS"\` (12), \`rightRaw="IXKNOWSNOEND"\` (12) -> equal length -> \`leftOut="THISBODYENDS"\` (12), \`rightOut="IXKNOWSNOEND"\` (12), diff=0.
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
      "One-shot daily check-in across SX, BX, and CSTEIX starting from chaox_get_briefing.",
    arguments: [
      {
        name: "date",
        description: "Calendar date YYYY-MM-DD (defaults to today)",
        required: false
      }
    ]
  },
  {
    name: "weekly_review",
    description:
      "7-day trend & aggregate analysis across SX spending/income, BX training/sleep/nutrition, and CSTEIX stillness/Wuxu.",
    arguments: [
      {
        name: "from",
        description: "Optional start date YYYY-MM-DD",
        required: false
      },
      {
        name: "to",
        description: "Optional end date YYYY-MM-DD",
        required: false
      }
    ]
  },
  {
    name: "log_workout_session",
    description:
      "Resolve exercise library keys/equipment and attach sets/weights onto a BX Apple Health workout.",
    arguments: [
      {
        name: "date",
        description: "Workout date YYYY-MM-DD (defaults to recent workouts)",
        required: false
      },
      {
        name: "notes",
        description: "Movements, sets, reps, and weights in kg to log",
        required: false
      }
    ]
  },
  {
    name: "write_wuxu",
    description:
      "Draft a new private CSTEIX Wuxu article or continue an existing same-day article with expectedRevision.",
    arguments: [
      {
        name: "topic",
        description: "Title, slug, or reflections to write",
        required: false
      }
    ]
  }
];
