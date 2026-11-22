# chaox-agent-server (Self-Hosted BYOS Node 22+ & SQLite)

Vendor-neutral, zero-runtime-dependency **CHAOX Agent Protocol v1 (`chaox-agent/v1`)** MCP + sync server backed by standard **SQLite** (Node.js 22.13+ built-in `node:sqlite` with WAL mode).

Runs anywhere you control — a VPS with Docker + Caddy, a Mac mini / NAS over Tailscale, or a container PaaS (Fly.io, Zeabur, Railway) — with **zero Cloudflare dependency**.

> Want a free, card-free serverless option with no server maintenance? See the recommended adapter in [../cloudflare-worker/README.md](../cloudflare-worker/README.md).

---

## Requirements

- **Docker Engine / Docker Compose**, or
- **Node.js `>= 22.13.0`** (uses built-in `node:sqlite`; zero native C++ addons or runtime `npm` dependencies).
- An **HTTPS** endpoint for iOS apps (`SX`, `BX`, `CSTEIX`) — provided automatically by Caddy, Tailscale Serve/Funnel, or your PaaS reverse proxy. (`http://localhost` / `http://127.0.0.1` is also allowed for local development.)

---

## Option 1 — Docker Compose + Automatic HTTPS on a VPS (Recommended for Self-Hosting)

1. Point a DNS `A`/`AAAA` record (for example `agent.yourdomain.com`) to your VPS and open TCP ports `80` and `443`.
2. Configure environment and Caddy:
   ```bash
   cd server
   cp .env.example .env
   openssl rand -hex 32   # paste this into CHAOX_AUTH_TOKEN inside .env
   cp Caddyfile.example Caddyfile
   # Edit Caddyfile and replace agent.example.com with your domain
   ```
3. Start the server + Caddy:
   ```bash
   docker compose --profile caddy up -d --build
   ```
4. Verify:
   ```bash
   curl -sS https://agent.yourdomain.com/health
   # {"status":"ok","schemaVersion":"chaox-agent/v1","mode":"sqlite"}
   ```

Your SQLite database lives at `server/data/chaox-agent.sqlite` on the host.

---

## Option 2 — Home Server / Mac mini / NAS with Tailscale

Keep the container bound only to loopback (`127.0.0.1:8787`, no public ports opened):

```bash
cd server
cp .env.example .env
# Put a strong random CHAOX_AUTH_TOKEN in .env
docker compose up -d --build
```

Then expose HTTPS privately or over Tailscale:
- **Private to your own tailnet devices (iPhone + Mac):**
  ```bash
  tailscale serve --bg http://127.0.0.1:8787
  ```
- **Public HTTPS URL for cloud AI clients (Claude / ChatGPT web/mobile):**
  ```bash
  tailscale funnel --bg http://127.0.0.1:8787
  ```

---

## Option 3 — Container PaaS (Fly.io / Zeabur / Railway)

Deploy `server/Dockerfile` directly with:
- Persistent volume mounted at `/data`
- Environment variable `CHAOX_AUTH_TOKEN=<64-char-hex-secret>`
- Port `8787` and health check path `/health`

---

## Option 4 — Bare Node.js (`>= 22.13.0`)

```bash
cd server
npm install
npm run build
export CHAOX_AUTH_TOKEN="$(npm run --silent token)"
export PORT=8787
export CHAOX_DB_PATH="./data/chaox-agent.sqlite"
npm start
```

Put Nginx, Caddy, or Tailscale TLS termination in front of `127.0.0.1:8787`.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `CHAOX_AUTH_TOKEN` | *(empty — routes fail closed with `401`)* | Shared Bearer secret for SX, BX, CSTEIX, and AI MCP clients. |
| `HOST` | `0.0.0.0` | Listen address inside Node / container. |
| `PORT` | `8787` | HTTP listen port (`0..65535`). |
| `CHAOX_DB_PATH` | `./data/chaox-agent.sqlite` | SQLite database file path (WAL mode, auto-migrated on startup). |
| `CHAOX_BACKEND_MODE` | `sqlite` | Reported in `GET /health` `mode` and `chaox_get_status.backend`. |
| `CHAOX_SERVER_NAME` | `chaox-agent-server` | Reported in MCP `initialize.serverInfo.name` and inbox `source.client`. |
| `CHAOX_MAX_BODY_BYTES` | `20971520` (20 MiB) | Maximum accepted HTTP request body size (`413` above limit). |

---

## Backup, Restore & Migrating from Cloudflare D1

Because all state lives in a single SQLite file (using schemas identical to `server/migrations/`), moving between hosts or migrating off Cloudflare D1 is lossless:

- **Consistent live backup (SQLite WAL safe):**
  ```bash
  sqlite3 ./data/chaox-agent.sqlite ".backup './chaox-agent-backup.sqlite'"
  ```
- **Restore or import an exported Cloudflare D1 SQLite database:**
  Stop the server, copy the exported `.sqlite` file to `$CHAOX_DB_PATH` (remove any stale `-wal`/`-shm` sidecars from the old file), and start the server. Startup migrations are idempotent and automatically reconcile D1-exported tables.
  In **SX**, **BX**, **CSTEIX**, and your AI clients, replace the old URL with your new `https://...` URL (you can reuse the exact same `CHAOX_AUTH_TOKEN` so existing tokens keep working).

---

## Connect Apps & AI Clients

- **iOS apps (`SX`, `BX`, `CSTEIX`)**: Open **Settings -> AI Assistant**, paste your server base URL (`https://agent.yourdomain.com`, without `/mcp`) and `CHAOX_AUTH_TOKEN`, then tap **Connect & Sync**.
- **AI MCP clients**: Configure Streamable HTTP URL `https://agent.yourdomain.com/mcp` with header `Authorization: Bearer <your-token>`.
- **Import existing local Wuxu Markdown archive**:
  ```bash
  CHAOX_AUTH_TOKEN="<your-token>" CHAOX_SERVER_URL="https://agent.yourdomain.com" \
    node scripts/import-wuxu.mjs --dir /path/to/chaoxwuxu
  ```
