# chaox-agent-worker (BYOS Cloudflare Workers + D1)

Self-hosted, **100% free and card-free** personal cloud relay + Streamable HTTP MCP Server for **SX (Spending X)** and **BX (Body X)**.

Runs inside **your own Cloudflare account** using Workers + D1 (5 GB storage, 5M row reads/day, 100k Worker requests/day free tier with hard caps and **no credit card required**). CHAOX never hosts your data or operates a backend.

---

## Choose Your Setup Style

### Option 1 — Let Your AI Coding Agent Deploy It for You (Easiest)

If you use Claude Code, Cursor, Codex, OpenClaw, or Antigravity, clone this repo and paste this prompt directly to your AI assistant:

> Help me deploy `chaox-agent/cloudflare-worker` to my own Cloudflare account:
> 1. Run `npm install` in `cloudflare-worker/`.
> 2. Run `npx wrangler whoami`; if I am not logged in, run `npx wrangler login` and wait while I approve access in my browser.
> 3. Run `npm run setup` to create the free D1 database, write a gitignored `wrangler.local.toml`, apply migrations, deploy the Worker, generate & set `CHAOX_AUTH_TOKEN`, and verify `/health` and `/mcp`.
> 4. Give me the final Worker URL, MCP URL, and Bearer Token so I can paste them into SX, BX, and my AI client.

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
4. Applies `migrations/0001_init.sql` to your remote D1 database.
5. Deploys the Worker (routes stay closed with HTTP `401` while `CHAOX_AUTH_TOKEN` is unset).
6. Generates a 32-byte random Bearer token and uploads it via `wrangler secret put CHAOX_AUTH_TOKEN`.
7. Verifies live `GET <worker-url>/health` (`200 ok`) and authenticated `POST <worker-url>/mcp` (`tools/list` returns 9 tools), then prints copy-ready credentials for SX, BX, and your AI clients.

> Need to bring your own token instead of auto-generating one?
> `CHAOX_AUTH_TOKEN="your-custom-secret" npm run setup`

---

### Option 3 — Manual Step-by-Step Commands

If you prefer executing each step manually:

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
3. Cloudflare issues a TLS certificate automatically in seconds. Use `https://agent.yourdomain.com` in SX, BX, and your AI clients.

---

## Connect SX & BX on iPhone

1. Open **SX -> Settings -> Agent Exchange**.
2. Switch the top segmented picker to **Cloud Endpoint**.
3. Enter your **Worker URL** (e.g. `https://chaox-agent-worker.<subdomain>.workers.dev` or custom domain — **without** `/mcp`, though trailing `/mcp` is also stripped automatically) and your **Bearer Token**.
4. Tap **Connect & Sync** (keep permission at **Append Only** unless you only want reads).
5. Open **BX -> Settings -> Agent Exchange**, switch to **Cloud Endpoint**, enter the exact same URL and Token, and tap **Connect & Sync**.

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

### Built-in Skills, Preferences & Prompts

Once connected, any MCP-capable client automatically discovers:
- **9 Tools**: `chaox_get_status`, `sx_get_catalog`, `sx_get_summary`, `sx_record_expense`, `sx_record_income`, `bx_get_summary`, `bx_record_food`, `bx_record_skin`, `bx_record_toilet`
- **`instructions` + Resource `chaox://guide/skill`**: Teaches the AI to look up real projects/tags, estimate nutrition transparently from photos, and keep credentials/HealthKit/photos out of scope.
- **Prompts**: `log_meal_photo` and `daily_review`.
- **Resource `chaox://guide/preferences`**: Personal Markdown rules stored in your D1 database. Update it anytime with `curl`:

```bash
curl -X PUT "https://<your-worker-url>/preferences" \
  -H "Authorization: Bearer <your-token>" \
  -H "Content-Type: application/json" \
  -d '{"content":"# My Preferences\n- Default meal project: Daily Meals\n- Default currency: CNY\n- Daily calorie target: 1800 kcal\n"}'
```

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
  Then update the new token in SX Settings, BX Settings, and your AI client.
- **Verify locally without Cloudflare**:
  ```bash
  npm test
  ```
- **Common errors**:
  - `HTTP 401 Unauthorized`: Token mismatch, or you updated `CHAOX_AUTH_TOKEN` seconds ago (wait 2-3s and retry), or forgot to run `wrangler secret put`.
  - `"App 'sx' has not synced to this Cloudflare Worker yet"`: Tap **Connect & Sync** inside SX Settings on iPhone first so `catalog` and `summary` are uploaded.
  - `No *.workers.dev subdomain registered`: Open **Cloudflare Dashboard -> Workers & Pages** once in your browser to claim your free `*.workers.dev` subdomain, then re-run `npm run setup`.
