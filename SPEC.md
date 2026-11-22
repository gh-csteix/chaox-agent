# CHAOX Agent Protocol v1 (`chaox-agent/v1`)

## 1. Design Principles

1. **Zero CHAOX Server**: SX and BX apps exchange JSON exclusively with a user-owned BYOS HTTPS endpoint (such as `cloudflare-worker/`). No CHAOX-hosted server sees user data.
2. **App Is Authoritative**: Permission tiers are stored locally on each device inside app `UserDefaults`. External databases reflect those permissions for AI clients; an external writer cannot escalate permissions.
3. **Keychain-Backed & Idempotent**: Apps store Bearer tokens in iOS Keychain (`AfterFirstUnlockThisDeviceOnly`) and enforce HTTPS (plus localhost HTTP for local development). Every write carries a `requestId` plus deterministic database deduplication.
4. **Sanitized Surface**: Credentials, vault secrets, recovery codes, HealthKit raw metrics, and skin images never leave the app. No delete operation exists.

## 2. Remote BYOS Sync API (`cloudflare-worker/`)

All endpoints except `GET /health` require `Authorization: Bearer <token>`:
- `GET /health`: Liveness probe returning `{ status: "ok", schemaVersion: "chaox-agent/v1", mode }`.
- `POST /mcp`: Web-standard Streamable HTTP JSON-RPC 2.0 MCP endpoint (`tools/*`, `resources/*`, `prompts/*`).
- `GET /sync/:app/status?limit=N`: Returns `app`, `configured`, `permission`, `lastSyncAt`, `pendingInboxCount`, and `recentReceipts`.
- `GET /sync/:app/inbox`: Returns pending `envelopes[]` ordered chronologically.
- `POST /sync/:app/ack`: Atomically records `receipts[]` and deletes acknowledged `inbox` rows.
- `PUT /sync/:app/snapshot`: Uploads `bundleId`, `appVersion`, `permission`, `capabilities`, `lastSyncAt`, and optional `catalog` / `summary` (preserving existing snapshots when updating permission only).
- `GET /preferences`, `PUT /preferences`: Optional user-authored Markdown routing instructions exposed to MCP clients via `chaox://guide/preferences`.

## 3. Permission Tiers

- `disabled`: App does not read from or write to the exchange endpoint.
- `readOnly`: App exports `catalog` and `summary`; inbox writes are rejected with `errorCode: "permission_denied"`.
- `appendOnly`: App exports snapshots and accepts create/idempotent-append operations (`record_expense`, `record_income`, `record_food`, `record_skin`, `record_toilet`).
- `readWrite`: Full protocol access (currently identical capability set to `appendOnly`; reserved for non-destructive edits in future protocol revisions).

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
- **Optimistic Overlay**: `cloudflare-worker` combines committed snapshots with pending `inbox` writes on `sx_get_summary` / `bx_get_summary`.
