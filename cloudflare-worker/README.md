# chaox-agent-worker (Recommended Cloudflare Workers + D1 Adapter)

**Recommended (optional, free, card-free)** serverless deployment adapter for the core server in [`../server/`](../server/).

Runs inside **your own Cloudflare account** using Workers + D1 (5 GB storage, 5M row reads/day, 100k Worker requests/day free tier with hard caps and **no credit card required**). CHAOX never hosts your data or operates a backend.

> **Prefer not to use Cloudflare?** You do not need Cloudflare at all — all core protocol logic, all 67 MCP tools, and SQLite migrations live in vendor-neutral [`../server/`](../server/). Run it directly on any VPS (Docker + Caddy), Mac mini / NAS (Tailscale), container PaaS, or Node 22.13+. See [`../server/README.md`](../server/README.md).

---

## Choose Your Setup Style

### Option 1 — Let Your AI Coding Agent Deploy It for You (Easiest)

If you use Claude Code, Cursor, Codex, OpenClaw, or Antigravity, clone this repo and paste this prompt directly to your AI assistant:

> Help me deploy `chaox-agent/cloudflare-worker` to my own Cloudflare account:
> 1. Run `npm install` in `cloudflare-worker/`.
> 2. Run `npx wrangler whoami`; if I am not logged in, run `npx wrangler login` and wait while I approve access in my browser.
> 3. Run `npm run setup` to create the free D1 database, write a gitignored `wrangler.local.toml`, apply migrations (`../server/migrations`), deploy the Worker, generate & set `CHAOX_AUTH_TOKEN`, and verify `/health` and `/mcp`.
> 4. Give me the final Worker URL, MCP URL, and Bearer Token so I can paste them into SX, BX, CSTEIX, and my AI client.

---

### Option 2 — One-Command Automated Setup (Terminal)

```bash
cd cloudflare-worker
npm install
npx wrangler login        # opens browser once to authorize your Cloudflare account
npm run setup             # automates D1 create, migrations, deploy, secret, and live verify
```

What `npm run setup` does safely and idempotently:
1. Confirms Cloudflare login (`npx wrangler whoami`).
2. Finds or creates D1 database `chaox-agent` (`wrangler d1 create chaox-agent`).
3. Writes `wrangler.local.toml` with your personal `database_id` (`wrangler.local.toml` is gitignored so personal IDs are never committed).
4. Applies `../server/migrations/*.sql` (`0001_init.sql`, `0002_policy_and_dataset.sql`, `0003_csteix_wuxu.sql`) to your remote D1 database.
5. Deploys the thin Worker adapter (routes stay closed with HTTP `401` while `CHAOX_AUTH_TOKEN` is unset).
6. Generates a 32-byte random Bearer token and uploads it via `wrangler secret put CHAOX_AUTH_TOKEN`.
7. Verifies live `GET <worker-url>/health` (`200 ok`) and authenticated `POST <worker-url>/mcp` (`tools/list` returns all 67 tools), then prints copy-ready credentials for SX, BX, CSTEIX, and your AI clients.

> Need to bring your own token instead of auto-generating one?
> `CHAOX_AUTH_TOKEN="your-custom-secret" npm run setup`

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
openssl rand -hex 32 | npx wrangler secret put CHAOX_AUTH_TOKEN --config wrangler.local.toml
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
2. Enter your **Server URL** (e.g. `https://chaox-agent-worker.<subdomain>.workers.dev` or custom domain — **without** `/mcp`, though trailing `/mcp` is also stripped automatically) and your **Bearer Token** (or paste the client config JSON).
3. Configure granular permissions (`Read` / `Add` / `Edit` / `Delete` + domain scopes) and tap **Connect & Sync**.

Your token is stored in the iOS Keychain (`AfterFirstUnlockThisDeviceOnly`) and never written to UserDefaults.

---

## Connect Any Mobile or Desktop AI Client

Point any Streamable HTTP MCP client at:
- **URL**: `https://<your-worker-url>/mcp`
- **Authorization Header**: `Authorization: Bearer <your-token>`

Example config snippet (for MCP clients supporting remote HTTP JSON config):

```json
{
  "mcpServers": {
    "chaox-agent": {
      "url": "https://<your-worker-url>/mcp",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}
```

### Built-in Tools, Skills & Preferences

Once connected, any MCP-capable client automatically discovers:
- **67 Tools** across **SX** (projects, expenses, refunds, incomes, reversals, tags, slogans, opt-in credential metadata/links), **BX** (daily summary, read-only Apple Health sleep & workout frames, workout exercises/sets, food, skin/medication, toilet), **CSTEIX** (read-only dwell/meditation/marks, opt-in places, immediate CRUD + Trash restore for private Wuxu articles), and `chaox_get_status`.
- **`instructions` + Resource `chaox://guide/skill`**: Explains field semantics (`YYYY-MM-DD-HH` local clock hour, FIFO patches, tag inheritance) and privacy boundaries.
- **Prompts**: `log_meal_photo` and `daily_review`.
- **Resource `chaox://guide/preferences`**: Personal Markdown rules stored in your database (`GET` / `PUT /preferences`).

---

## Operations, Token Rotation & Troubleshooting

- **Update Worker code after pulling updates**:
  ```bash
  cd cloudflare-worker
  npm run db:migrate:remote
  npm run deploy:local-config
  ```
- **Rotate your Bearer token**:
  ```bash
  openssl rand -hex 32 | npx wrangler secret put CHAOX_AUTH_TOKEN --config wrangler.local.toml
  ```
  Then update the new token in SX/BX/CSTEIX Settings and your AI client.
- **Verify the thin adapter locally**:
  ```bash
  npm test
  ```
- **Leave Cloudflare at any time**: Export your D1 SQLite database and move it to [`../server/`](../server/) without changing app behavior or tokens. See [`../server/README.md`](../server/README.md).
- **Common errors**:
  - `HTTP 401 Unauthorized`: Token mismatch, updated `CHAOX_AUTH_TOKEN` seconds ago (wait 2-3s and retry), or forgot to run `wrangler secret put`.
  - `"App 'sx' has not synced to this CHAOX Agent server yet"`: Tap **Connect & Sync** inside SX Settings on iPhone first.
  - `No *.workers.dev subdomain registered`: Open **Cloudflare Dashboard -> Workers & Pages** once in your browser to claim your free `*.workers.dev` subdomain, then re-run `npm run setup`.
