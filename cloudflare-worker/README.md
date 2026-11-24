# chaox-agent-worker (Recommended Cloudflare Workers + D1 Adapter)

**Recommended (optional, free, card-free)** serverless deployment adapter for the core server in [`../server/`](../server/).

Runs inside **your own Cloudflare account** using Workers + D1 (500 MB per database / 5 GB account storage, 5M row reads/day, 100k Worker requests/day free tier with hard caps and **no credit card required**). CHAOX never hosts your data or operates a backend.

> **Prefer not to use Cloudflare?** You do not need Cloudflare at all — all core protocol logic, all 72 MCP tools, and SQLite migrations live in vendor-neutral [`../server/`](../server/). Run it directly on any VPS (Docker + Caddy), Mac mini / NAS (Tailscale), container PaaS, or Node 22.13+. See [`../server/README.md`](../server/README.md).

---

## Choose Your Setup Style

### Option 1 — Let Your AI Coding Agent Deploy It for You (Easiest)

If you use Claude Code, Cursor, Codex, OpenClaw, or Antigravity, clone this repo and paste this prompt directly to your AI assistant:

> Help me deploy `chaox-agent/cloudflare-worker` to my own Cloudflare account:
> 1. Run `npm install` in `cloudflare-worker/`.
> 2. Run `npx wrangler whoami`; if I am not logged in, run `npx wrangler login` and wait while I approve access in my browser.
> 3. Run `npm run setup` to create the free D1 database, write a gitignored `wrangler.local.toml`, apply migrations (`../server/migrations`), deploy the Worker, generate & set `CHAOX_SYNC_TOKEN` (for iPhone apps) + `CHAOX_MCP_TOKEN` (for AI clients), and verify `/health`, `/sync/sx/status`, and `/mcp`.
> 4. Give me the final iOS client config (`CHAOX_SYNC_TOKEN`) and AI MCP client config (`CHAOX_MCP_TOKEN`).

---

### Option 2 — One-Command Automated Setup (Terminal)

```bash
cd cloudflare-worker
npm install
npx wrangler login        # opens browser once to authorize your Cloudflare account
npm run setup             # automates D1 create, migrations, deploy, two-key secrets, and live verify
```

What `npm run setup` does safely and idempotently:
1. Confirms Cloudflare login (`npx wrangler whoami`). If your Cloudflare login has multiple accounts, run with `CLOUDFLARE_ACCOUNT_ID=<account-id> npm run setup`.
2. Finds or creates D1 database `chaox-agent` (`wrangler d1 create chaox-agent`).
3. Writes `wrangler.local.toml` with your personal `database_id` (`wrangler.local.toml` is gitignored so personal IDs are never committed). On re-runs, an existing `wrangler.local.toml` matching your `database_id` is preserved so custom edits are kept intact.
4. Applies all `../server/migrations/*.sql` schema migrations to your remote D1 database.
5. Deploys the thin Worker adapter (routes stay closed with HTTP `401` while secrets are unset).
6. Generates two 32-byte random Bearer tokens and uploads `CHAOX_SYNC_TOKEN` (iOS sync only) + `CHAOX_MCP_TOKEN` (AI MCP only). On re-runs where those secrets already exist, `npm run setup` preserves them instead of breaking connected iOS apps and AI clients — pass `npm run setup -- --rotate-tokens` when you intentionally want to rotate tokens.
7. Verifies live `GET <worker-url>/health` (`200 ok`), `GET /sync/sx/status` (`tokenMode: "split"`), `POST /mcp` (`tools/list` returns all 72 tools), and bidirectional `403` isolation (`CHAOX_MCP_TOKEN` rejected on `/sync/*` and `CHAOX_SYNC_TOKEN` rejected on `/mcp`), then prints copy-ready credentials for SX/BX/CSTEIX and your AI clients.

> Need to bring your own tokens, rotate existing ones, or keep legacy single-token mode?
> - Provide explicit tokens: `CHAOX_SYNC_TOKEN="..." CHAOX_MCP_TOKEN="..." npm run setup`
> - Rotate existing split tokens: `npm run setup -- --rotate-tokens`
> - Legacy single-token fallback: `CHAOX_AUTH_TOKEN="..." npm run setup`

---

### Option 3 — Manual Step-by-Step Commands

```bash
cd cloudflare-worker
npm install
npx wrangler login
npx wrangler d1 create chaox-agent
```

Copy the printed `database_id` into a gitignored `wrangler.local.toml` (copied from `wrangler.toml`):

```bash
cp wrangler.toml wrangler.local.toml
# Replace REPLACE_WITH_YOUR_D1_DATABASE_ID in wrangler.local.toml with your UUID
npx wrangler d1 migrations apply chaox-agent --remote --config wrangler.local.toml
npx wrangler deploy --config wrangler.local.toml
openssl rand -hex 32 | npx wrangler secret put CHAOX_SYNC_TOKEN --config wrangler.local.toml
openssl rand -hex 32 | npx wrangler secret put CHAOX_MCP_TOKEN --config wrangler.local.toml
```

---

## Optional: Bind a Custom Subdomain (Recommended in Mainland China)

Default `*.workers.dev` hostnames can be throttled on mobile cellular networks in mainland China. If you own a domain whose DNS is managed on Cloudflare:

1. Open **Cloudflare Dashboard -> Workers & Pages -> `chaox-agent-worker` -> Settings -> Domains & Routes**.
2. Click **Add -> Custom Domain** and enter e.g. `agent.yourdomain.com`.
3. Cloudflare issues a TLS certificate automatically in seconds. Use `https://agent.yourdomain.com` in SX, BX, CSTEIX, and your AI clients.

---

## Connect SX, BX & CSTEIX on iPhone

1. Open **SX -> Settings -> AI Assistant** (similarly **BX** and **CSTEIX**).
2. Enter your **Server URL** (e.g. `https://chaox-agent-worker.<subdomain>.workers.dev` or custom domain — **without** `/mcp`, though trailing `/mcp` is also stripped automatically) and your **`CHAOX_SYNC_TOKEN`**, or paste the **App Client Config** snippet containing both `Sync Token` and `MCP Token` (saving both enables one-tap AI MCP client config export directly inside the iOS apps, while iOS sync requests continue using only `CHAOX_SYNC_TOKEN`).
3. Configure granular permissions (`Read` / `Add` / `Edit` / `Delete` + domain scopes) and tap **Connect & Sync**.

Your token is stored in the iOS Keychain (`AfterFirstUnlockThisDeviceOnly`) and never written to UserDefaults.

---

## Connect Any Mobile or Desktop AI Client

Point any Streamable HTTP MCP client at:
- **URL**: `https://<your-worker-url>/mcp`
- **Authorization Header**: `Authorization: Bearer <your-CHAOX_MCP_TOKEN>`

Example config snippet (for MCP clients supporting remote HTTP JSON config):

```json
{
  "mcpServers": {
    "chaox-agent": {
      "url": "https://<your-worker-url>/mcp",
      "headers": {
        "Authorization": "Bearer <your-CHAOX_MCP_TOKEN>"
      }
    }
  }
}
```

### Built-in Tools, Skills & Preferences

Once connected, any MCP-capable client automatically discovers:
- **72 Tools** across **SX** (projects, expenses, refunds, incomes, reversals, tags, slogans, opt-in credential metadata/links), **BX** (daily summary, read-only Apple Health sleep & workout frames, workout exercises/sets, food, skin/medication, toilet), **CSTEIX** (read-only dwell/meditation/marks, opt-in places, immediate CRUD + Trash restore + **Stage Couplets (`0005`)** for private Wuxu articles), and cross-app `chaox_get_status` / `chaox_get_briefing` / `chaox_list_pending` / `chaox_cancel_pending` / `chaox_get_preferences` / `chaox_update_preferences`.
- **`instructions` + Resource `chaox://guide/skill`**: Explains field semantics (`YYYY-MM-DD-HH` local clock hour, FIFO patches, tag inheritance) and privacy boundaries.
- **Resource `chaox://guide/wuxu-couplets`**: Selectivity rules, PivotText symmetry math, CSTEIX terminology (`我求` -> `IX`), and worked examples for Wuxu Stage Couplets (`0005`, `couplets_json`).
- **Resource Template `chaox://wuxu/{slug}`**: Reads any private CSTEIX Wuxu article (including optional Stage Couplets) as Markdown by lowercase kebab-case slug.
- **Prompts**: `log_meal_photo`, `daily_review`, `weekly_review`, `log_workout_session`, and `write_wuxu`.
- **Resource `chaox://guide/preferences`**: Personal Markdown rules stored in your database (`GET` / `PUT /preferences`).
- **Automatic Chunked Datasets (`0006`)**: Large synced dataset domains exceeding `1 MB` (1,000,000 UTF-8 bytes) are automatically split across rows in `app_dataset_chunks` so snapshots stay well under D1's `2 MB` single-row limit and reassemble transparently on reads.

---

## Optional Security & Deployment Variables

Set optional secrets via `npx wrangler secret put <NAME> --config wrangler.local.toml` (or add non-secret vars under `[vars]` in your gitignored `wrangler.local.toml`):

| Variable | Scope | Description |
|---|---|---|
| `CHAOX_MCP_READONLY_TOKEN` | Worker secret | Optional read-only AI Bearer token (forces server-side `readonly` on `/mcp` and returns `403` on `/sync/*` and `PUT /preferences`). |
| `CHAOX_ALLOWED_ORIGINS` | Worker var | Comma-separated browser `Origin` allowlist (defaults to `*`; returns `403` on mismatch while non-browser clients without `Origin` stay allowed). |
| `CHAOX_ALLOW_MCP_PREFERENCES_WRITE` | Worker var | Defaults to `true`. Set to `false` to block `chaox_update_preferences` over MCP while still permitting `PUT /preferences` via `CHAOX_SYNC_TOKEN`. |
| `CLOUDFLARE_ACCOUNT_ID` | Local CLI env | For multi-account Cloudflare users: pass `CLOUDFLARE_ACCOUNT_ID=<id> npm run setup` (or export before running Wrangler commands). |

---

## Operations, Token Migration, Rotation & Troubleshooting

- **Migrate an existing single-token Worker to two-key isolation (`CHAOX_SYNC_TOKEN` + `CHAOX_MCP_TOKEN`) with zero downtime**:
  ```bash
  cd cloudflare-worker
  npm run split-tokens -- --url https://<your-worker-url>
  ```
  Update the keys in SX/BX/CSTEIX and your AI clients while `CHAOX_AUTH_TOKEN` remains active, then delete the legacy secret:
  ```bash
  npx wrangler secret delete CHAOX_AUTH_TOKEN --config wrangler.local.toml
  ```
- **Update Worker code after pulling updates**:
  ```bash
  cd cloudflare-worker
  npm run db:migrate:remote
  npm run deploy:local-config
  ```
  *(Re-running `npm run setup` is also safe and idempotent: it keeps your existing `wrangler.local.toml` and Worker secrets untouched unless you pass `--rotate-tokens`.)*
- **Rotate your tokens**:
  ```bash
  npm run setup -- --rotate-tokens
  ```
  Or rotate manually:
  ```bash
  openssl rand -hex 32 | npx wrangler secret put CHAOX_SYNC_TOKEN --config wrangler.local.toml
  openssl rand -hex 32 | npx wrangler secret put CHAOX_MCP_TOKEN --config wrangler.local.toml
  ```
- **Verify the thin adapter locally**:
  ```bash
  npm test
  ```
- **Leave Cloudflare at any time**: Export your D1 SQLite database and move it to [`../server/`](../server/) without changing app behavior or tokens. See [`../server/README.md`](../server/README.md).
- **Common errors**:
  - `HTTP 401 Unauthorized`: Token mismatch, secret updated seconds ago (wait 2-3s and retry), or forgot to run `wrangler secret put`.
  - `HTTP 403 Forbidden`: Using `CHAOX_MCP_TOKEN` on `/sync/*` (use `CHAOX_SYNC_TOKEN` on iOS) or `CHAOX_SYNC_TOKEN` on `/mcp` (use `CHAOX_MCP_TOKEN` on AI clients).
  - `"App 'sx' has not synced to this CHAOX Agent server yet"`: Tap **Connect & Sync** inside SX Settings on iPhone first.
  - `You need to register a workers.dev subdomain`: Open **Cloudflare Dashboard -> Workers & Pages** once in your browser to claim your free `*.workers.dev` subdomain, then re-run `npm run setup`.
  - Multiple Cloudflare accounts error: Export `CLOUDFLARE_ACCOUNT_ID=<your-account-id>` and re-run `npm run setup`.
