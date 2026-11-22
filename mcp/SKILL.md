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
