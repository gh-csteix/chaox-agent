# chaox-agent-server (Self-Hosted BYOS Node 22+ & SQLite)

Vendor-neutral, zero-runtime-dependency **CHAOX Agent Protocol v1 (`chaox-agent/v1`)** MCP + sync server backed by standard **SQLite** (Node.js 22.13+ built-in `node:sqlite` with WAL mode and automatic chunked `app_dataset_chunks` (`0006`) storage for large snapshots).

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
   # Generate two separate 64-char hex tokens (or run `npm run token` twice):
   openssl rand -hex 32   # paste into CHAOX_SYNC_TOKEN in .env (iOS apps)
   openssl rand -hex 32   # paste into CHAOX_MCP_TOKEN in .env  (AI MCP clients)
   cp Caddyfile.example Caddyfile
   # Edit Caddyfile and replace agent.example.com with your domain
   ```
   `.env.example` leaves `CHAOX_SYNC_TOKEN=` and `CHAOX_MCP_TOKEN=` empty so unedited deployments fail closed with HTTP `401`, and `node-server.ts` rejects placeholder strings on startup. (Legacy single-token `CHAOX_AUTH_TOKEN` remains available as an optional backwards-compatible fallback.)
3. Start the server + Caddy:
   ```bash
   docker compose --profile caddy up -d --build
   ```
4. Verify:
   ```bash
   curl -sS https://agent.yourdomain.com/health
   # {"status":"ok","schemaVersion":"chaox-agent/v1","mode":"sqlite"}
   ```

`docker-compose.yml` persists your SQLite database in the named Docker volume `chaox_data:/data` (avoiding Linux host bind-mount UID `1000` ownership issues under `USER node` + `read_only: true`), defaults `CHAOX_TRUST_PROXY=true` for the bundled Caddy reverse proxy so client IPs are rate-limited accurately, and forwards `CHAOX_MAX_BODY_BYTES`.

---

## Option 2 — Home Server / Mac mini / NAS with Tailscale

Keep the container bound only to loopback (`127.0.0.1:8787`, no public ports opened):

```bash
cd server
cp .env.example .env
# Set random 64-char hex CHAOX_SYNC_TOKEN and CHAOX_MCP_TOKEN in .env
# (generate with `openssl rand -hex 32` or `npm run token`)
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
- Environment variables `CHAOX_SYNC_TOKEN=<64-char-hex-secret>` and `CHAOX_MCP_TOKEN=<64-char-hex-secret>` (plus `CHAOX_TRUST_PROXY=true` behind the platform reverse proxy)
- Port `8787` and health check path `/health`

---

## Option 4 — Bare Node.js (`>= 22.13.0`)

```bash
cd server
npm install
npm run build
export CHAOX_SYNC_TOKEN="$(npm run --silent token)"
export CHAOX_MCP_TOKEN="$(npm run --silent token)"
export PORT=8787
export CHAOX_DB_PATH="./data/chaox-agent.sqlite"
npm start
```

Put Nginx, Caddy, or Tailscale TLS termination in front of `127.0.0.1:8787` (and set `CHAOX_TRUST_PROXY=true` when behind a trusted reverse proxy).

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `CHAOX_SYNC_TOKEN` | *(empty in `.env.example` — routes fail closed with `401`)* | **Recommended.** iOS-only sync Bearer token (`/sync/*`, `GET`/`PUT /preferences`; returns `403` on `/mcp`). Generate with `npm run token` or `openssl rand -hex 32`. |
| `CHAOX_MCP_TOKEN` | *(empty in `.env.example` — routes fail closed with `401`)* | **Recommended.** AI-only MCP Bearer token (`/mcp`, `GET /preferences`; returns `403` on `/sync/*` and `PUT /preferences`). Generate with `npm run token` or `openssl rand -hex 32`. |
| `CHAOX_MCP_READONLY_TOKEN` | *(unset)* | Optional read-only AI token (forces server-side `readonly` on `/mcp` and returns `403` on `/sync/*` and `PUT /preferences`). |
| `CHAOX_AUTH_TOKEN` | *(unset)* | Optional backwards-compatible legacy shared Bearer token granting both sync and MCP access. Prefer split tokens (`CHAOX_SYNC_TOKEN` + `CHAOX_MCP_TOKEN`) for new deployments. |
| `CHAOX_ALLOWED_ORIGINS` | `*` | Comma-separated browser `Origin` allowlist (`403` on mismatch; non-browser clients without `Origin` stay allowed). |
| `CHAOX_ALLOW_MCP_PREFERENCES_WRITE` | `true` | Set `false` to block `chaox_update_preferences` over MCP while keeping `PUT /preferences` via `CHAOX_SYNC_TOKEN`. |
| `CHAOX_TRUST_PROXY` | `false` *(bare Node)* / `true` *(`docker-compose.yml`)* | Set `true` behind a trusted reverse proxy (such as the bundled Caddy service) to honor `X-Forwarded-For/Proto/Host` for rate limiting & URL reconstruction. |
| `HOST` | `0.0.0.0` | Listen address inside Node / container. |
| `PORT` | `8787` | HTTP listen port (`0..65535`). |
| `CHAOX_DB_PATH` | `./data/chaox-agent.sqlite` | SQLite database file path (WAL mode, auto-migrated on startup, including `0006` `app_dataset_chunks` automatic chunking for >1 MB dataset domains). |
| `CHAOX_BACKEND_MODE` | `sqlite` | Reported in `GET /health` `mode` and `chaox_get_status.backend`. |
| `CHAOX_SERVER_NAME` | `chaox-agent-server` | Reported in MCP `initialize.serverInfo.name` and inbox `source.client`. |
| `CHAOX_MAX_BODY_BYTES` | `20971520` (20 MiB) | Maximum accepted `/sync/*` HTTP request body size (forwarded by `docker-compose.yml`; `/mcp` and `/preferences` are capped at `2 MiB`, `413` above limit). |

---

## Security Hardening

1. **Two-key split-token isolation (default)**: Use distinct random 64-char hex values for `CHAOX_SYNC_TOKEN` (SX/BX/CSTEIX iOS settings) and `CHAOX_MCP_TOKEN` (AI MCP clients), plus optional `CHAOX_MCP_READONLY_TOKEN` for read-only assistants. An MCP token cannot alter app policies on `/sync/*`, hard-wipe `/sync/csteix/data`, or forge `/sync/*/ack`. `node-server.ts` fails closed on startup if placeholder token strings are configured.
   - *Migrating from legacy `CHAOX_AUTH_TOKEN` with zero downtime*: Keep `CHAOX_AUTH_TOKEN` set alongside `CHAOX_SYNC_TOKEN` and `CHAOX_MCP_TOKEN` while updating your iOS apps and AI clients, then remove `CHAOX_AUTH_TOKEN`.
2. **Prevent persistent prompt injection via preferences**: Set `CHAOX_ALLOW_MCP_PREFERENCES_WRITE=false` once your routing preferences are settled, so untrusted external inputs cannot append hidden rules via `chaox_update_preferences`.
3. **Container & SQLite file hardening**: `docker-compose.yml` uses the named `chaox_data:/data` volume alongside a read-only root filesystem, `cap_drop: [ALL]`, and `no-new-privileges:true`. For bare Node.js hosts, tighten directory permissions on the SQLite folder (`chmod 700 ./data`).

---

## Backup, Restore & Migrating from Cloudflare D1

Because all state lives in a single SQLite file using the exact same migrations (`server/migrations/`, including `0006_dataset_chunks.sql` automatic chunked storage for large snapshots), moving between hosts or migrating off Cloudflare D1 is lossless:

- **Consistent live backup (SQLite WAL safe):**
  - Bare Node.js:
    ```bash
    sqlite3 ./data/chaox-agent.sqlite ".backup './chaox-agent-backup.sqlite'"
    ```
  - Docker Compose (`chaox_data` named volume):
    ```bash
    docker compose stop chaox-agent
    docker compose cp chaox-agent:/data/chaox-agent.sqlite ./chaox-agent-backup.sqlite
    docker compose start chaox-agent
    ```
- **Restore or import an exported Cloudflare D1 SQLite database:**
  Stop the server, copy the exported `.sqlite` file into `$CHAOX_DB_PATH` (inside `./data` for bare Node or into the `chaox_data` volume for Docker Compose; remove any stale `-wal`/`-shm` sidecars from the old file), and start the server. Startup migrations are idempotent and automatically reconcile D1-exported tables.
  In **SX**, **BX**, **CSTEIX**, and your AI clients, replace the old URL with your new `https://...` URL (you can reuse your existing `CHAOX_SYNC_TOKEN` and `CHAOX_MCP_TOKEN`, or legacy `CHAOX_AUTH_TOKEN`, so connected clients keep working).

---

## Connect Apps & AI Clients

- **iOS apps (`SX`, `BX`, `CSTEIX`)**: Open **Settings -> AI Assistant**, paste your server base URL (`https://agent.yourdomain.com`, without `/mcp`) and **`CHAOX_SYNC_TOKEN`** (optionally also saving `CHAOX_MCP_TOKEN` via the App Client Config snippet to enable one-tap MCP config export), then tap **Connect & Sync**.
- **AI MCP clients**: Configure Streamable HTTP URL `https://agent.yourdomain.com/mcp` with header `Authorization: Bearer <CHAOX_MCP_TOKEN>`.
  - Optional per-client scoping query params are supported on `/mcp`: `?apps=sx,bx` (restrict to specific apps) and `?readonly=1` (read-only tools only).
  - HTTP responses >= 1 KiB are automatically gzip-compressed when clients send `Accept-Encoding: gzip`, and MCP tool outputs emit compact JSON.
- **Import existing local Wuxu Markdown archive**:
  ```bash
  CHAOX_SYNC_TOKEN="<your-sync-token>" CHAOX_SERVER_URL="https://agent.yourdomain.com" \
    node scripts/import-wuxu.mjs --dir ~/path/to/wuxu-archive
  ```
  *(Legacy `CHAOX_AUTH_TOKEN` is also accepted by `import-wuxu.mjs` as a fallback.)*
