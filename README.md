# chaox-agent

**CHAOX Agent Protocol (`chaox-agent/v1`)** — Local-first, zero-CHAOX-server AI interoperability for personal CHAOX apps:

- **SX (Spending X)** — Personal ledger, project budgets, refunds, tags, and opt-in credential metadata
- **BX (Body X)** — Meal calories, skincare/medication, toilet logs, sleep, and workout annotations
- **CSTEIX** — Dwell/meditation/marks insights and private daily Wuxu articles
- **GX** — Reserved (`v1.1+`)

Talk directly to any AI assistant (Claude, ChatGPT, Cursor, OpenClaw, Codex, Apple Shortcuts, or self-hosted agents) using **your own database and endpoint** — without CHAOX running a backend, collecting your data (`Data Not Collected`), or requiring a CHAOX account or any specific cloud vendor.

---

## Integration Modes

| Feature | **Cloudflare Workers + D1** *(Recommended — Free, No Card)* | **Self-Hosted Docker / Node + SQLite** *(Vendor-Neutral BYOS)* | **On-Device Shortcuts** *(Zero Server)* |
|---|---|---|---|
| Works 24/7 with Mac turned off | **Yes** | **Yes** | **Yes** |
| Vendor lock-in | Cloudflare account | **None** (any VPS, NAS, Mac mini, Tailscale, Fly.io, Zeabur, Railway) | **None** |
| Mobile & desktop AI direct chat | **Yes** (single HTTPS MCP URL) | **Yes** (single HTTPS MCP URL) | Shortcut trigger only |
| Mobile VPN / Tailscale setup | **None** | Optional (Caddy public HTTPS, or Tailscale Serve/Funnel) | **None** |
| Hosting cost | **Free** (Cloudflare Workers + D1 free tier, no card) | Cost of your own VPS/PaaS (or free at home) | **Free** |
| Setup guide | [cloudflare-worker/README.md](cloudflare-worker/README.md) | [server/README.md](server/README.md) | [shortcuts/MEAL_TO_SX_AND_BX.md](shortcuts/MEAL_TO_SX_AND_BX.md) |

---

## Quick Start

### Option A — Recommended: Free Card-Free Serverless (`cloudflare-worker/`)

Best if you do not already maintain a VPS or domain/TLS proxy and want zero server upkeep:

```bash
cd cloudflare-worker
npm install
npx wrangler login
npm run setup
```

`cloudflare-worker/` is a thin adapter around [`server/`](server/) with identical schemas, endpoints, and MCP tools. See [cloudflare-worker/README.md](cloudflare-worker/README.md).

### Option B — Self-Hosted Without Cloudflare (`server/`)

Best if you prefer your own VPS, home server / NAS / Mac mini (with Caddy or Tailscale), or container PaaS:

```bash
cd server
cp .env.example .env
# Set CHAOX_AUTH_TOKEN in .env (generate with: openssl rand -hex 32)
docker compose up -d --build
```

Put Caddy (`docker compose --profile caddy up -d` + `Caddyfile`), Tailscale Serve/Funnel, or Nginx in front for HTTPS. See [server/README.md](server/README.md) for full VPS, Tailscale, PaaS, and Cloudflare D1 migration instructions.

### Connect iOS Apps & AI Clients (60 Seconds)

1. Open **SX -> Settings -> AI Assistant** (and **BX**, **CSTEIX**), paste your server base URL + Bearer Token (or paste the client config JSON), choose your granular permissions, and tap **Connect & Sync**.
2. Add `<your-server-url>/mcp` + `Authorization: Bearer <token>` to your mobile or desktop AI client.
3. Optional: load [mcp/SKILL.md](mcp/SKILL.md) into your client's skills folder (every MCP client also receives `instructions` and `chaox://guide/skill` automatically).

---

## Repository Layout

- [server/](server/) — **Platform-agnostic CHAOX Agent Protocol v1 server** (Web-standard core + Node 22.13+ SQLite HTTP runtime, Dockerfile, Docker Compose + Caddy templates, and canonical `server/migrations/`)
- [cloudflare-worker/](cloudflare-worker/) — **Recommended (optional) thin Cloudflare Workers + D1 adapter** wrapping `server/src/app.ts` and `server/migrations/`
- [CHAOXAgentKit/](CHAOXAgentKit/) — Swift 6 package shared by SX, BX, and CSTEIX (vendor-neutral HTTPS sync client, Keychain token storage, permission enforcement)
- [mcp/SKILL.md](mcp/SKILL.md) — Portable AI assistant skill prompt (alongside the legacy `mcp/` local iCloud Drive package)
- [shortcuts/](shortcuts/) — Apple Shortcuts & on-device `App Intents` recipe
- [SPEC.md](SPEC.md) — `chaox-agent/v1` protocol wire specification
- [AGENTS.md](AGENTS.md) — Contributor & AI rules (English docs/code, vendor-neutrality, privacy invariants)

## Privacy & Safety Guarantees

- **Zero CHAOX server** and **`Data Not Collected`**: your endpoint can live on Cloudflare, your own VPS, your home NAS, or anywhere else you trust.
- **Double-layer permissions on device**: each app enforces its own `allowRead` / `allowCreate` / `allowUpdate` / `allowDelete` flags and per-domain allowlists locally and in server snapshots.
- **SX isolation**: Never exports credential vault secrets (passwords, TOTP secrets, recovery codes, or credential private notes). Non-secret credential metadata and links are opt-in (`credentials` scope). Deletions move records to 30-day recoverable Trash.
- **BX isolation**: Never exports HealthKit workout frame mutations or skin lesion photos; sleep nights and Apple Health workout metrics stay strictly read-only.
- **CSTEIX isolation**: `dwell`, `meditation`, and `marks` snapshots stay strictly read-only; location/place names are stripped unless explicitly enabled via the opt-in `places` scope; private daily Wuxu articles support immediate CRUD with 30-day soft-delete Trash recovery.
