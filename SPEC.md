# CHAOX Agent Protocol v1 (`chaox-agent/v1`)

## 1. Design Principles

1. **Zero CHAOX Server**: SX, BX, and CSTEIX apps exchange JSON exclusively with a user-owned BYOS HTTPS endpoint (such as self-hosted [`server/`](server/) with SQLite, or the optional [`cloudflare-worker/`](cloudflare-worker/) adapter with D1). No CHAOX-hosted server sees user data.
2. **App Is Authoritative**: Permission tiers and granular policies are stored locally on each device inside app `UserDefaults`. External databases reflect those permissions for AI clients; an external writer cannot escalate permissions.
3. **Keychain-Backed & Idempotent**: Apps store Bearer tokens in iOS Keychain (`AfterFirstUnlockThisDeviceOnly`) and enforce HTTPS (plus localhost HTTP for local development). Every write carries a `requestId` plus deterministic database deduplication.
4. **Sanitized Surface**: SX credential vault secrets, recovery codes, BX HealthKit raw metrics / skin lesion photos, and CSTEIX place/location names (unless explicitly opted into the `places` scope) never leak through MCP.

## 2. Remote BYOS Sync API (`server/` & `cloudflare-worker/`)

### 2.1 Authentication & Role Separation

All endpoints except `GET`/`HEAD /health` require `Authorization: Bearer <token>`. When no tokens are configured (all unset/empty), authenticated endpoints **fail closed** with HTTP `401 Unauthorized` (and the self-hosted Node runtime also rejects placeholder token strings on startup).

Recommended **split-token mode** separates iOS device sync privileges from AI MCP client privileges:
- `CHAOX_SYNC_TOKEN`: iOS sync role — permits `/sync/*` and `GET`/`PUT /preferences`; returns HTTP `403 Forbidden` on `/mcp`.
- `CHAOX_MCP_TOKEN`: AI MCP role — permits `/mcp` and `GET /preferences`; returns HTTP `403 Forbidden` on `/sync/*` and `PUT /preferences`.
- `CHAOX_MCP_READONLY_TOKEN`: Optional read-only AI MCP role — forces server-side `readonly` mode on `/mcp`, permits `GET /preferences`, and returns HTTP `403 Forbidden` on `/sync/*` and `PUT /preferences`.
- `CHAOX_AUTH_TOKEN`: Optional backwards-compatible legacy shared token granting full access to both `/sync/*` and `/mcp`.

Request bodies are capped at `2 MiB` on `/mcp` and `/preferences`, and `20 MiB` (configurable via `CHAOX_MAX_BODY_BYTES`) on `/sync/*` (returning HTTP `413` above limit).

### 2.2 Endpoints & Storage Migrations

- `GET /health`, `HEAD /health`: Unauthenticated liveness probe returning `{ status: "ok", schemaVersion: "chaox-agent/v1", mode }` (empty body for `HEAD`).
- `POST /mcp`: Web-standard Streamable HTTP JSON-RPC 2.0 MCP endpoint (`initialize` with protocol negotiation across `2025-11-25` / `2025-06-18` / `2025-03-26` / `2024-11-05`, `tools/*`, `resources/list`, `resources/templates/list`, `resources/read` including `chaox://wuxu/{slug}` and `chaox://guide/wuxu-couplets`, `prompts/*`). Supports optional query scoping: `?apps=sx,bx` to restrict exposed app tools and `?readonly=1` to restrict to read-only tools.
- `GET /sync/:app/status?limit=N`: Returns `app`, `configured`, `permission`, `lastSyncAt`, `pendingInboxCount`, `recentReceipts`, and `tokenMode` (`"split"` when authenticated with `CHAOX_SYNC_TOKEN` or when `CHAOX_MCP_TOKEN` / `CHAOX_MCP_READONLY_TOKEN` is configured; otherwise `"legacy"`).
- `GET /sync/:app/inbox`: Returns pending `envelopes[]` ordered chronologically.
- `POST /sync/:app/ack`: Atomically records `receipts[]` and deletes acknowledged `inbox` rows.
- `PUT /sync/:app/snapshot`: Uploads `bundleId`, `appVersion`, `permission`, `policy`, `capabilities`, `lastSyncAt`, and optional `catalog` / `summary` / `datasets` (preserving existing snapshots when updating permission only; pruning disabled `app_dataset` domains and any associated chunks while preserving `csteix_wuxu`).
- `PUT /sync/:app/dataset/:domain`: Upserts `{ data: <array|object> }` (or deletes when `data` is `null`) for a single dataset domain of `:app`, enforcing the app's stored permission policy and rejecting `csteix/wuxu` (which lives in `csteix_wuxu`). Non-`PUT` methods return HTTP `405`.
- `DELETE /sync/:app/data`: Wipes all cloud state, datasets (including chunk rows), inbox, receipts, and (for `csteix`) `csteix_wuxu` rows for `:app`.
- `GET /sync/csteix/wuxu?since=<ISO8601>&includeDeleted=1`: Returns `{ schemaVersion, app: "csteix", syncedAt, totalCount, articles: [...] }` ordered by `updated_at ASC` (all rows when `since` is omitted, or `updated_at > since`; `totalCount` is total active non-deleted articles).
- `POST /sync/csteix/wuxu/import`: Authenticated idempotent upsert by `slug` for one-shot local Wuxu Markdown archive seeding into the server database without altering `app_state` policy.
- `GET /preferences`, `PUT /preferences`: Optional user-authored Markdown routing instructions exposed to MCP clients via `chaox://guide/preferences` (`PUT` requires `CHAOX_SYNC_TOKEN` or legacy `CHAOX_AUTH_TOKEN`).

Canonical SQLite/D1 schema migrations live in `server/migrations/`:
- `0001_init.sql` – `0004_performance_indexes.sql`: Core `app_state`, `app_dataset`, `inbox`, `receipts`, `preferences`, `csteix_wuxu`, and performance indexes.
- `0005_csteix_wuxu_couplets.sql`: Adds `couplets_json TEXT NOT NULL DEFAULT '[]'` to `csteix_wuxu` for validated bilingual Stage Couplets.
- `0006_dataset_chunks.sql`: Adds `app_dataset_chunks (app, domain, chunk_index, chunk_data, updated_at)`. Serialized `app_dataset` payloads exceeding `1,000,000` UTF-8 bytes are automatically split on valid UTF-8 / surrogate-pair boundaries across chunk rows with a `{ "__chaoxDatasetStorage": "chunked_v1", "chunkCount", "byteLength" }` manifest stored in `app_dataset` (staying well under Cloudflare D1's 2 MB single-row limit), transparently reassembled on reads and atomically replaced/cleaned on updates, policy pruning, or data wipes.

## 3. Permission Tiers

- `disabled`: App does not read from or write to the exchange endpoint.
- `readOnly`: App exports `catalog` and `summary`; inbox writes are rejected with `errorCode: "permission_denied"`.
- `appendOnly`: App exports snapshots and accepts create/idempotent-append operations (14 ops matching `CHAOXAgentKit` `AgentPermissionTier.appendOperations`):
  - **SX**: `record_expense`, `record_income`, `record_refund`, `record_income_reversal`, `create_project`, `create_tag`, `create_slogan`, `create_credential`, `link_credential`
  - **BX**: `record_food`, `record_skin`, `record_toilet`, `add_workout_exercise`
  - **CSTEIX**: `create_wuxu`
- `readWrite`: Full granular read/create/update/delete capabilities governed per-app by the user's `PermissionPolicy` (`allowRead`, `allowCreate`, `allowUpdate`, `allowDelete`, `allowedDomains`).

## 4. App Snapshots

### 4.1 SX Catalog (`sx` `catalog`)
- `generatedAt`: ISO-8601 timestamp
- `timeZoneIdentifier`: Device IANA timezone identifier (e.g. `"Asia/Shanghai"`)
- `summaryCurrency`: Default ISO-4217 code (e.g. `"CNY"`)
- `supportedCurrencies`: Allowed 3-letter ISO-4217 currency codes (`[String]`)
- `projects`: Active projects (`id`, `name`, `currency`, `type`, `cycle`, `supportsExpense`, `supportsIncome`, `recentExpenseTags`, `recentIncomeTags`)
- `tags`: Array of live tag name strings (`[String]`)
- `rules`: Usage guardrails exported by SX
- `fieldGuide`: Machine-readable field semantics hints exported by SX

### 4.2 SX Summary (`sx` `summary`, Multi-Period Bundle)
- `generatedAt`, `timeZoneIdentifier`, `summaryCurrency`
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

- **SX**: `record_expense` (`amount`, `projectName`, optional `credentialId` / `skipCredential`, optional `currency`, `tags`, `note`, `date`, `hour`, `stableID`), `record_income` (`amount`, `projectName`, optional `credentialId` / `skipCredential`, optional `currency`, `tags`, `note`, `date`, `stableID`). The MCP tool's optional `hour` input is a known 24-hour local payment hour (`0..23`) in SX's `timeZoneIdentifier`. Use `0` for the midnight hour. Omitting `tags` inherits latest project tags; passing `[]` clears tags. When the opt-in `credentials` scope is enabled and `credentialId` is omitted (and `skipCredential` is not `true`), the server auto-binds if the project has 1 linked credential, returns `queued: false` with `credentialSelectionRequired: true` and `credentialCandidates` if multiple exist, or leaves unbound if 0 exist (never auto-creating credentials), and includes the bound `credentialId` (or `null`) in responses.
- **BX**: `record_food` (`name`, optional `mealType`, optional `calories`, `recordedAt`, `stableID`), `record_skin` (`product`: `"sunscreen"|"moisturizer"|"bodyLotion"|"medicine"|"other"`, optional `name`, `recordedAt`, `stableID`), `record_toilet` (`kind`: `"bowel"|"urination"`, `stoolType` `1..7` required for `"bowel"`, optional `note`, `recordedAt`, `stableID`).
- **Event times in v1**. SX expense `date` represents payment time. BX food `recordedAt` represents eating time. The MCP server normalizes bare calendar dates to local midnight for SX expenses and local noon for BX logs. Omitting the time on create lets the device use its current time. Omitting time fields in a partial update preserves the stored time. Ask for the relevant event time or defer the write if it is unknown. On-device receipts report processing status and `processedAt`. Query by `app` and `requestId` and read the synced record to verify its event time.
- **Optimistic Overlay & Aggregates**: The server (`server/` / `cloudflare-worker/`) merges committed snapshots with pending `inbox` writes across `sx_get_summary` / `bx_get_summary` (scoped strictly to each target period/date in app timezone), `sx_list_*`, and `bx_list_*`, computes pre-pagination `aggregates` on expense/income/food/workout list responses, and supports editing/cancelling queued writes before iOS sync via `pendingRequestId`, `pending:<requestId>`, and `chaox_list_pending` / `chaox_cancel_pending`.
- **Cross-App Ergonomics**: `chaox_get_briefing` returns a single-call cross-app daily snapshot + preferences + active catalogs; `chaox_get_preferences` / `chaox_update_preferences` manage persistent personal assistant routing rules.

## 6. CSTEIX (`ai.chaox.csteix`) & Private Wuxu Articles

- **Default Domains**: `["wuxu", "dwell", "meditation", "marks"]`. `"places"` is strictly opt-in (off by default, matching SX `"credentials"`).
- **Read-Only CSTEIX Domains**: `dwell`, `meditation`, `marks`, and opt-in `places` are uploaded via `PUT /sync/csteix/snapshot` into `app_dataset` and exposed strictly read-only (`csteix_get_summary`, `csteix_list_dwell`, `csteix_list_meditation`, `csteix_list_marks`). Place fields are stripped automatically unless `"places"` is present in `allowedDomains`.
- **Wuxu Immediate CRUD**: `csteix_wuxu` in the user's BYOS SQLite/D1 database is the source of truth for private daily Wuxu articles (`id`, `slug`, `title`, `titleEn`, `dimensions` subset of `["chaos","spacetime","existence","ix"]`, `writtenAt`, `timezone`, `bodyZh`, `bodyEn`, `rawNotes`, `couplets`, `revision`, `deletedAt`, `createdAt`, `updatedAt`).
  - `csteix_create_wuxu`, `csteix_update_wuxu` (with optional `expectedRevision` optimistic lock, `appendBodyZh`/`appendBodyEn`/`appendRawNotes`, and `couplets` replacement or `appendCouplets` merge), `csteix_delete_wuxu` (30-day soft-delete Trash), and `csteix_restore_wuxu` enforce CSTEIX's device policy, apply immediately to the server database, and emit immediate `applied` receipts in `receipts` with `requestId` idempotency.
  - Each article holds 0–4 (default 0; 1–2 recommended only for timeless aphorisms) bilingual symmetric Stage Couplets (`{ id, dimension, zh, en, sourceLine }`), strictly validated on server for `zh` half symmetry (2–6 chars each), `en` PivotText symmetry (`6..17` rendered chars, diff `<= 3`), and CSTEIX terminology (`我求` -> `IX`; documented in `chaox://guide/wuxu-couplets`).
  - The CSTEIX iOS app pulls updates offline-first via `GET /sync/csteix/wuxu?since=<ISO8601>&includeDeleted=1` (`CHAOXAgentKit` `AgentExchangeStore.fetchWuxuDelta`).
