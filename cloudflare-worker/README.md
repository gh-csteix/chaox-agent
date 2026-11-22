# chaox-agent-worker (Recommended Cloudflare Workers + D1 Adapter)

**Recommended (optional, free, card-free)** serverless deployment adapter for the core server in [`../server/`](../server/).

Runs inside **your own Cloudflare account** using Workers + D1 (5 GB storage, 5M row reads/day, 100k Worker requests/day free tier with hard caps and **no credit card required**). CHAOX never hosts your data or operates a backend.

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
1. Confirms Cloudflare login (`npx wrangler whoami`).
2. Finds or creates D1 database `chaox-agent` (`wrangler d1 create chaox-agent`).
3. Writes `wrangler.local.toml` with your personal `database_id` (`wrangler.local.toml` is gitignored so personal IDs are never committed).
4. Applies `../server/migrations/*.sql` (`0001_init.sql` through `0004_performance_indexes.sql`) to your remote D1 database.
5. Deploys the thin Worker adapter (routes stay closed with HTTP `401` while secrets are unset).
6. Generates two 32-byte random Bearer tokens and uploads `CHAOX_SYNC_TOKEN` (iOS sync only) + `CHAOX_MCP_TOKEN` (AI MCP only).
7. Verifies live `GET <worker-url>/health` (`200 ok`), `GET /sync/sx/status` (`tokenMode: "split"`), `POST /mcp` (`tools/list` returns all 72 tools), and `403` isolation, then prints copy-ready credentials for SX/BX/CSTEIX and your AI clients.

> Need to bring your own tokens or keep legacy single-token mode?
> `CHAOX_SYNC_TOKEN="..." CHAOX_MCP_TOKEN="..." npm run setup` (or `CHAOX_AUTH_TOKEN="..." npm run setup`)

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
2. Enter your **Server URL** (e.g. `https://chaox-agent-worker.<subdomain>.workers.dev` or custom domain — **without** `/mcp`, though trailing `/mcp` is also stripped automatically) and your **`CHAOX_SYNC_TOKEN`** (or paste the App Client Config snippet).
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
- **72 Tools** across **SX** (projects, expenses, refunds, incomes, reversals, tags, slogans, opt-in credential metadata/links), **BX** (daily summary, read-only Apple Health sleep & workout frames, workout exercises/sets, food, skin/medication, toilet), **CSTEIX** (read-only dwell/meditation/marks, opt-in places, immediate CRUD + Trash restore for private Wuxu articles), and cross-app `chaox_get_status` / `chaox_get_briefing` / `chaox_list_pending` / `chaox_cancel_pending` / `chaox_get_preferences` / `chaox_update_preferences`.
- **`instructions` + Resource `chaox://guide/skill`**: Explains field semantics (`YYYY-MM-DD-HH` local clock hour, FIFO patches, tag inheritance) and privacy boundaries.
- **Prompts**: `log_meal_photo`, `daily_review`, `weekly_review`, `log_workout_session`, and `write_wuxu`.
- **Resource `chaox://guide/preferences`**: Personal Markdown rules stored in your database (`GET` / `PUT /preferences`).

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
- **Rotate your tokens**:
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
  - `No *.workers.dev subdomain registered`: Open **Cloudflare Dashboard -> Workers & Pages** once in your browser to claim your free `*.workers.dev` subdomain, then re-run `npm run setup`.
