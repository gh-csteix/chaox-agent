---
name: chaox-agent
description: Log, query, update, and manage personal expenses, income, meals, skincare/medicine, sleep, workouts, toilet logs, CSTEIX read-only dwell/meditation/marks, and private daily Wuxu articles across SX, BX, and CSTEIX via CHAOX Agent Protocol v1.
---

# CHAOX Agent Skill

Use the `chaox-agent` MCP server tools to read and manage permitted records for **SX (Spending X)**, **BX (Body X)**, and **CSTEIX (with private Wuxu articles)**.

## Privacy, Consent & Permission Rules

1. **Check status & permissions first**: Call `chaox_get_status` to inspect each app's active `policy` (`allowRead`, `allowCreate`, `allowUpdate`, `allowDelete`, and `allowedDomains`) before assuming an operation is allowed.
2. **SX Credential Vault Secrets stay strictly on device**: Passwords, TOTP secrets, recovery codes, and private credential notes NEVER leave SX. Non-secret credential metadata (`username`, `website`, `type`, `issuer`), project links/renewal dates, and record `credentialId` attribution are opt-in (disabled by default) and require enabling the `credentials` scope in SX Settings.
3. **SX deletes move to Trash**: `sx_delete_*` and `sx_unlink_credential` move items to 30-day recoverable Trash; deleting a project is blocked while it still has expenses, income records, or credential links.
4. **BX Apple Health data is strictly read-only**: `bx_list_sleep` and workout timing/duration/energy/heart-rate frames in `bx_list_workouts` cannot be created, modified, or deleted via MCP. Full CRUD applies to food, skincare/medication, toilet logs, and workout annotations (exercise selection, equipment, sets, reps, weight kg, and `chosenType` when `canChooseType` is true). Skin lesion photos never leave the device.
5. **CSTEIX read-only domains & opt-in places**: `dwell`, `meditation`, and `marks` (`csteix_get_summary`, `csteix_list_dwell`, `csteix_list_meditation`, `csteix_list_marks`) are strictly read-only snapshots from CSTEIX iOS. Place/location names are disabled by default and stripped unless the user explicitly enables the `places` scope.
6. **CSTEIX Wuxu immediate server CRUD**: `csteix_create_wuxu`, `csteix_update_wuxu`, `csteix_delete_wuxu`, and `csteix_restore_wuxu` apply immediately to the user's BYOS server database and record immediate `applied` receipts (synced to CSTEIX iOS via `GET /sync/csteix/wuxu`). Soft-deleted articles remain restorable for 30 days.
7. **Async server inbox for SX & BX**: SX and BX mutations enqueue into the server `inbox` and apply on-device when SX or BX opens or syncs. Report clearly whether a change is queued vs confirmed by receipt.

## Cross-App & CRUD Workflows

- **One-Shot Daily Context**: Call `chaox_get_briefing` first for a combined view of connected apps, today & month SX totals, active projects/tags, BX nutrition/sleep/workouts, CSTEIX summary, and custom rules.
- **Remember User Rules**: Call `chaox_get_preferences` and `chaox_update_preferences` (`content` or `append`) whenever the user states lasting routing/accounting/workout preferences.
- **Inspect or Fix Un-Synced Queue**: Use `chaox_list_pending`, pass `pendingRequestId` to `sx_update_expense`/`sx_delete_expense`/`sx_update_income`/`sx_delete_income` or `pending:<requestId>` to BX update/delete tools to edit/cancel before sync, or call `chaox_cancel_pending`.
- **List Aggregates**: `sx_list_expenses`, `sx_list_incomes`, `bx_list_food`, and `bx_list_workouts` return pre-pagination `aggregates` over all matching records.
- **Meal Photo + Expense**: Use payment time for `sx_record_expense` and eating time for `bx_record_food`. Verify each independently and ask for missing times before submitting the affected write. Use a shared `requestId` prefix for related writes and label estimated calories.
- **Edit or Delete Records**: Call `sx_list_*`, `bx_list_*`, or `csteix_list_wuxu` first to obtain exact IDs (`number` or `pendingRequestId` for SX, `UUID` or `pending:<requestId>` for BX, `id`/`slug` + `revision` for CSTEIX Wuxu), confirm destructive deletes if requested or ambiguous, then invoke `update_*` or `delete_*`.
- **Workout Annotations**: Inspect workouts with `bx_list_workouts` and look up exercise keys/equipment with `bx_list_exercises`, then use `bx_add_workout_exercise`, `bx_update_workout_exercise`, `bx_reorder_workout_exercises`, `bx_delete_workout_exercise`, or `bx_update_workout_type`.
- **Wuxu Articles**: Use lowercase kebab-case `slug`s, at least one dimension from `["chaos", "spacetime", "existence", "ix"]`, pure body Markdown in `bodyZh` (without the `# Title` header skeleton), verbatim user lines in `rawNotes`, `expectedRevision` on edits, and `appendBodyZh`/`appendRawNotes` for same-day continuations (also readable via `chaox://wuxu/{slug}`). Optionally distill `0–2` (default `[]`, max `4`) bilingual symmetric Stage Couplets (`couplets` / `appendCouplets`) only for timeless aphorisms worthy of the meditation stage — read `chaox://guide/wuxu-couplets` for PivotText symmetry math and CSTEIX terminology (`我求` = `IX`).

## Recording and Confirming Event Times

- Use the timestamp for the event being recorded. Keep order, payment, eating, and message times distinct.
- For a known time, prefer ISO-8601 with an explicit offset. Local inputs use the app timezone. The v1 BYOS server turns a bare date into local midnight for SX expenses and local noon for BX logs. Omitting time on create lets the device use its current time. Ask for the event time or defer an SX expense or BX log with an unknown time. On an update that changes other fields, omit the time fields to preserve the existing event time.
- On submission, report the requested time and its known precision as pending. Query `chaox_get_status` with `app` and `requestId` for the device receipt. Read the synced record to confirm the stored time. List entries with `pendingStatus` can include proposed values. When reporting Beijing time, convert known instants to `Asia/Shanghai` and keep the original precision.

## SX Expense & Income Field Reference

SX displays expense timestamps as **`YYYY-MM-DD-HH`** at hour precision in `sx_get_catalog.timeZoneIdentifier`. The trailing `HH` is the 24-hour clock hour (`00`–`23`). Use `hour: 0` only for a known payment in the midnight hour. A stored `-00` can also come from a legacy date-only write. Income records display at calendar-day precision (`YYYY-MM-DD`).

- **`amount`** / **`netAmount`** / **`refundTotal`**: `amount` is gross payment (> 0); `netAmount = amount - refundTotal` is displayed on cards; refunds are logged separately with `sx_record_refund`.
- **`projectName`**: Reusable project/category bucket from `sx_get_catalog` (`supportsExpense: true` or `supportsIncome: true`). Put specific merchants, dishes, or order details in **`note`** (write uses singular `note`; read returns plural `notes`).
- **`date`** & **`hour`** describe the payment time. Pass ISO-8601 with timezone offset (`2026-11-22T12:00:00+08:00`), SX hour format (`2026-11-22-12`), local date and time (`2026-11-22 12:00`), or `YYYY-MM-DD` plus a known `hour` (`0..23`). `sx_update_expense` applies partial patches in FIFO order on device. Read items expose `paidAt`, `localDate`, `localHour`, and `displayDate`.
- **`tags`**: Omit on create to inherit `recentExpenseTags` / `recentIncomeTags`; pass `[]` to clear all tags; pass tag names to set exact tags.
- **`currency`**: Optional 3-letter ISO-4217 code (`CNY`, `USD`, ...); omit to inherit project currency.
- **`isAutoRecorded`**, **`credentialId`**, **`skipCredential`**, **`requestId`**: `isAutoRecorded` marks scheduled subscription auto-records; `credentialId` is opt-in under `credentials` — when omitted with `credentials` enabled, `sx_record_expense` / `sx_record_income` auto-bind when the project has 1 linked credential, return `queued: false` + `credentialSelectionRequired: true` + `credentialCandidates` when multiple exist (ask the user to choose, or pass `skipCredential: true` to leave unbound), and leave blank when 0 exist (never auto-create credentials), while always returning the bound `credentialId` (or `null`); `requestId` provides idempotency.
