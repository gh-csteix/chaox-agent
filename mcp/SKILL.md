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
6. **CSTEIX Wuxu immediate D1 CRUD**: `csteix_create_wuxu`, `csteix_update_wuxu`, `csteix_delete_wuxu`, and `csteix_restore_wuxu` apply immediately to the user's BYOS D1 database and record immediate `applied` receipts (synced to CSTEIX iOS via `GET /sync/csteix/wuxu`). Soft-deleted articles remain restorable for 30 days.
7. **Async D1 inbox for SX & BX**: SX and BX mutations enqueue into D1 `inbox` and apply on-device when SX or BX opens or syncs. Report clearly whether a change is queued vs confirmed by receipt.

## Cross-App & CRUD Workflows

- **Meal Photo + Expense**: Inspect `chaox_get_status`, `sx_get_catalog`, and `bx_get_summary`; estimate calories transparently if omitted; call `sx_record_expense` + `bx_record_food` with a matching `requestId` prefix.
- **Edit or Delete Records**: Call `sx_list_*`, `bx_list_*`, or `csteix_list_wuxu` first to obtain exact IDs (`number` for SX, `UUID` string for BX, `id`/`slug` + `revision` for CSTEIX Wuxu), confirm destructive deletes if requested or ambiguous, then invoke `update_*` or `delete_*`.
- **Workout Annotations**: Inspect workouts with `bx_list_workouts` and look up exercise keys/equipment with `bx_list_exercises`, then use `bx_add_workout_exercise`, `bx_update_workout_exercise`, `bx_reorder_workout_exercises`, `bx_delete_workout_exercise`, or `bx_update_workout_type`.
- **Wuxu Articles**: Use lowercase kebab-case `slug`s, at least one dimension from `["chaos", "spacetime", "existence", "ix"]`, pure body Markdown in `bodyZh` (without the `# Title` header skeleton), verbatim user lines in `rawNotes`, `expectedRevision` on edits, and `appendBodyZh`/`appendRawNotes` for same-day continuations.

## SX Expense & Income Field Reference

SX displays expense timestamps as **`YYYY-MM-DD-HH`** (e.g. `2026-11-22-09`, `2026-11-22-12`, `2026-11-21-00`). The trailing two digits **`HH`** are the **24-hour local hour (`00`–`23`)** in `sx_get_catalog.timeZoneIdentifier` — **never** minutes or a sequence number (`00` = midnight or hour unknown). Incomes show calendar-day precision (`YYYY-MM-DD`).

- **`amount`** / **`netAmount`** / **`refundTotal`**: `amount` is gross payment (> 0); `netAmount = amount - refundTotal` is displayed on cards; refunds are logged separately with `sx_record_refund`.
- **`projectName`**: Reusable project/category bucket from `sx_get_catalog` (`supportsExpense: true` or `supportsIncome: true`). Put specific merchants, dishes, or order details in **`note`** (write uses singular `note`; read returns plural `notes`).
- **`date`** & **`hour`**: Pass ISO-8601 with timezone offset (`2026-11-22T12:00:00+08:00`), SX format (`2026-11-22-12` or `2026-11-22 12`), local (`2026-11-22 12:00`), or `YYYY-MM-DD` + `hour` (`0..23`). Bare `YYYY-MM-DD` without `hour` defaults to local `00:00` (`YYYY-MM-DD-00`). `sx_update_expense` applies partial patches in strict FIFO order on device, so sequential time fixes (`{ id, date: "2026-11-22", hour: 9 }` or `{ id, hour: 9 }`) can be queued without waiting for sync. Read items expose `paidAt`, `localDate`, `localHour`, and `displayDate`.
- **`tags`**: Omit on create to inherit `recentExpenseTags` / `recentIncomeTags`; pass `[]` to clear all tags; pass tag names to set exact tags.
- **`currency`**: Optional 3-letter ISO-4217 code (`CNY`, `USD`, ...); omit to inherit project currency.
- **`isAutoRecorded`**, **`credentialId`**, **`requestId`**: `isAutoRecorded` marks scheduled subscription auto-records; `credentialId` is opt-in under `credentials`; `requestId` provides idempotency.
