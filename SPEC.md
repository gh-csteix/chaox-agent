# CHAOX Agent Protocol v1 (`chaox-agent/v1`)

## 1. Design Principles

1. **Zero CHAOX Server**: SX, BX, and CSTEIX apps exchange JSON exclusively with a user-owned BYOS HTTPS endpoint (such as self-hosted [`server/`](server/) with SQLite, or the optional [`cloudflare-worker/`](cloudflare-worker/) adapter with D1). No CHAOX-hosted server sees user data.
2. **App Is Authoritative**: Permission tiers and granular policies are stored locally on each device inside app `UserDefaults`. External databases reflect those permissions for AI clients; an external writer cannot escalate permissions.
3. **Keychain-Backed & Idempotent**: Apps store Bearer tokens in iOS Keychain (`AfterFirstUnlockThisDeviceOnly`) and enforce HTTPS (plus localhost HTTP for local development). Every write carries a `requestId` plus deterministic database deduplication.
4. **Sanitized Surface**: SX credential vault secrets, recovery codes, BX HealthKit raw metrics / skin lesion photos, and CSTEIX place/location names (unless explicitly opted into the `places` scope) never leak through MCP.

## 2. Remote BYOS Sync API (`server/` & `cloudflare-worker/`)

All endpoints except `GET /health` require `Authorization: Bearer <token>`:
- `GET /health`: Liveness probe returning `{ status: "ok", schemaVersion: "chaox-agent/v1", mode }`.
- `POST /mcp`: Web-standard Streamable HTTP JSON-RPC 2.0 MCP endpoint (`initialize` with protocol negotiation across `2025-11-25` / `2025-06-18` / `2025-03-26` / `2024-11-05`, `tools/*`, `resources/list`, `resources/templates/list`, `resources/read` including `chaox://wuxu/{slug}`, `prompts/*`). Supports optional query scoping: `?apps=sx,bx` to restrict exposed app tools and `?readonly=1` to restrict to read-only tools.
- `GET /sync/:app/status?limit=N`: Returns `app`, `configured`, `permission`, `lastSyncAt`, `pendingInboxCount`, and `recentReceipts`.
- `GET /sync/:app/inbox`: Returns pending `envelopes[]` ordered chronologically.
- `POST /sync/:app/ack`: Atomically records `receipts[]` and deletes acknowledged `inbox` rows.
- `PUT /sync/:app/snapshot`: Uploads `bundleId`, `appVersion`, `permission`, `policy`, `capabilities`, `lastSyncAt`, and optional `catalog` / `summary` / `datasets` (preserving existing snapshots when updating permission only; pruning disabled `app_dataset` domains while preserving `csteix_wuxu`).
- `DELETE /sync/:app/data`: Wipes all cloud state, datasets, inbox, receipts, and (for `csteix`) `csteix_wuxu` rows for `:app`.
- `GET /sync/csteix/wuxu?since=<ISO8601>&includeDeleted=1`: Returns `{ schemaVersion, app: "csteix", syncedAt, totalCount, articles: [...] }` ordered by `updated_at ASC` (all rows when `since` is omitted, or `updated_at > since`; `totalCount` is total active non-deleted articles).
- `POST /sync/csteix/wuxu/import`: Authenticated idempotent upsert by `slug` for one-shot local `chaoxwuxu` Markdown repository seeding into the server database without altering `app_state` policy.
- `GET /preferences`, `PUT /preferences`: Optional user-authored Markdown routing instructions exposed to MCP clients via `chaox://guide/preferences`.

## 3. Permission Tiers

- `disabled`: App does not read from or write to the exchange endpoint.
- `readOnly`: App exports `catalog` and `summary`; inbox writes are rejected with `errorCode: "permission_denied"`.
- `appendOnly`: App exports snapshots and accepts create/idempotent-append operations (`record_expense`, `record_income`, `record_food`, `record_skin`, `record_toilet`).
- `readWrite`: Full granular read/create/update/delete capabilities governed per-app by the user's `PermissionPolicy` (`allowRead`, `allowCreate`, `allowUpdate`, `allowDelete`, `allowedDomains`).

## 4. App Snapshots

### 4.1 SX Catalog (`sx` `catalog`)
- `generatedAt`: ISO-8601 timestamp
- `summaryCurrency`: Default ISO-4217 code (e.g. `"CNY"`)
- `projects`: Active projects (`id`, `name`, `currency`, `type`, `cycle`, `supportsExpense`, `supportsIncome`, `recentExpenseTags`, `recentIncomeTags`)
- `tags`: Array of live tag name strings (`[String]`)
- `rules`: Usage guardrails exported by SX

### 4.2 SX Summary (`sx` `summary`, Multi-Period Bundle)
- `generatedAt`, `summaryCurrency`
- `expense`: keyed by `today`, `week`, `month`, `year`, `allTime`
- `income`: keyed by `today`, `week`, `month`, `year`, `allTime`

### 4.3 BX Catalog (`bx` `catalog`)
- `generatedAt`, `timeZoneIdentifier`
- `mealTypes`: `["breakfast", "lunch", "dinner", "snack"]`
- `skinProducts`: `["sunscreen", "moisturizer", "bodyLotion", "medicine", "other"]`
- `bristolRange`: `{ "min": 1, "max": 7 }`
- `recentSkinNames`: Recently used product names grouped by `product`

### 4.4 BX Summary (`bx` `summary`, 7-Day Rolling Bundle)
- `generatedAt`, `timeZoneIdentifier`
- `today`: Current day summary (`date` `YYYY-MM-DD`, `totalCalories`, `unknownCaloriesCount`, `mealCount`, `meals`, `skinCount`, `bowelCount`, `urinationCount`, `toiletCount`)
- `days`: Array of up to 7 daily summaries ordered newest-first.

## 5. Inbox Operations & Optimistic Overlay

- **SX**: `record_expense` (`amount`, `projectName`, optional `currency`, `tags`, `note`, `date`, `stableID`), `record_income` (`amount`, `projectName`, optional `currency`, `tags`, `note`, `date`, `stableID`). Omitting `tags` inherits latest project tags; passing `[]` clears tags.
- **BX**: `record_food` (`name`, optional `mealType`, optional `calories`, `recordedAt`, `stableID`), `record_skin` (`product`: `"sunscreen"|"moisturizer"|"bodyLotion"|"medicine"|"other"`, optional `name`, `recordedAt`, `stableID`), `record_toilet` (`kind`: `"bowel"|"urination"`, `stoolType` `1..7` required for `"bowel"`, optional `note`, `recordedAt`, `stableID`).
- **Optimistic Overlay & Aggregates**: The server (`server/` / `cloudflare-worker/`) merges committed snapshots with pending `inbox` writes across `sx_get_summary` / `bx_get_summary` (scoped strictly to each target period/date in app timezone), `sx_list_*`, and `bx_list_*`, computes pre-pagination `aggregates` on expense/income/food/workout list responses, and supports editing/cancelling queued writes before iOS sync via `pendingRequestId`, `pending:<requestId>`, and `chaox_list_pending` / `chaox_cancel_pending`.
- **Cross-App Ergonomics**: `chaox_get_briefing` returns a single-call cross-app daily snapshot + preferences + active catalogs; `chaox_get_preferences` / `chaox_update_preferences` manage persistent personal assistant routing rules.

## 6. CSTEIX (`ai.chaox.csteix`) & Private Wuxu Articles

- **Default Domains**: `["wuxu", "dwell", "meditation", "marks"]`. `"places"` is strictly opt-in (off by default, matching SX `"credentials"`).
- **Read-Only CSTEIX Domains**: `dwell`, `meditation`, `marks`, and opt-in `places` are uploaded via `PUT /sync/csteix/snapshot` into `app_dataset` and exposed strictly read-only (`csteix_get_summary`, `csteix_list_dwell`, `csteix_list_meditation`, `csteix_list_marks`). Place fields are stripped automatically unless `"places"` is present in `allowedDomains`.
- **Wuxu Immediate CRUD**: `csteix_wuxu` in the user's BYOS SQLite/D1 database is the source of truth for private daily Wuxu articles (`id`, `slug`, `title`, `titleEn`, `dimensions` subset of `["chaos","spacetime","existence","ix"]`, `writtenAt`, `timezone`, `bodyZh`, `bodyEn`, `rawNotes`, `revision`, `deletedAt`, `createdAt`, `updatedAt`).
  - `csteix_create_wuxu`, `csteix_update_wuxu` (with optional `expectedRevision` optimistic lock and `appendBodyZh`/`appendBodyEn`/`appendRawNotes`), `csteix_delete_wuxu` (30-day soft-delete Trash), and `csteix_restore_wuxu` enforce CSTEIX's device policy, apply immediately to the server database, and emit immediate `applied` receipts in `receipts` with `requestId` idempotency.
  - The CSTEIX iOS app pulls updates offline-first via `GET /sync/csteix/wuxu?since=<ISO8601>&includeDeleted=1` (`CHAOXAgentKit` `AgentExchangeStore.fetchWuxuDelta`).
