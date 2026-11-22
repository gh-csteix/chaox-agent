# AGENTS.md

Guidance for AI agents and contributors working in `chaox-agent`.

## Overview

`chaox-agent` implements **CHAOX Agent Protocol v1 (`chaox-agent/v1`)** connecting **SX** (`../sx`), **BX** (`../bx`), **CSTEIX** (`../csteix.com`), **GX** (`../gx`), and future CHAOX apps via user-owned BYOS storage and MCP endpoints:

- `server/`: Platform-agnostic protocol core (Web-standard `Request`/`Response` + `SqlDatabase`), canonical SQLite migrations (`server/migrations/`), zero-dependency Node 22.13+ SQLite HTTP runtime (`src/node-server.ts`, `src/sqlite.ts`), and Docker / Compose + Caddy deployment templates.
- `cloudflare-worker/`: Optional, recommended free card-free Cloudflare Workers + D1 adapter that wraps `../server/src/app.ts` and `../server/migrations/` with zero logic duplication.
- `CHAOXAgentKit/`: Shared Swift 6 package (iOS 26+) handling vendor-neutral HTTPS sync, Keychain token persistence, permission policy enforcement, inbox processing, and Settings UI.
- `mcp/`: Portable `SKILL.md` guide and legacy local iCloud Drive MCP package (`chaox-agent-mcp`).
- `shortcuts/`: Apple Shortcuts & on-device `App Intents` recipes.

## Hard Invariants

1. **Zero CHAOX Server**: Never design or introduce a CHAOX-hosted backend, account system, telemetry endpoint, or data-collection relay. All integrations run either on-device (`App Intents`) or against the user's own BYOS server (`server/` or `cloudflare-worker/`).
2. **Cloudflare-Decoupled Core (`server/` First)**:
   - Keep all MCP tools, protocol routing, store operations, permission enforcement, guides, and SQLite migrations inside `server/`.
   - Keep Web-standard modules (`server/src/app.ts`, `mcp.ts`, `mcp-tools.ts`, `guide.ts`, `store*.ts`, `types.ts`, `index.ts`) **100% free of `node:*` imports** so edge/serverless adapters (`cloudflare-worker/`, Deno, Bun) can bundle them cleanly without Node polyfills.
   - Keep `cloudflare-worker/` strictly as a thin recommended adapter (`src/index.ts`, setup scripts, Wrangler config/docs) — never duplicate store or tool logic there.
   - `CHAOXAgentKit` and `GET /health` `mode` must stay vendor-neutral; never require `cloudflare-d1`.
3. **Privacy Boundaries**:
   - **SX**: Never touch credential vault secrets (passwords, TOTP secrets, recovery codes, or credential private notes). Non-secret metadata and project links are opt-in under `credentials`.
   - **BX**: Never export Apple HealthKit metrics for mutation or `skinSpot` / `skinPhoto` data (App Review 5.1.3(ii)).
   - **CSTEIX**: Never expose `places`/location data unless the user explicitly enables the `places` opt-in scope; keep `dwell`, `meditation`, and `marks` strictly read-only.
4. **Language Constraints**:
   - All documentation, code comments, identifiers, and git commit messages must be in **English**.
   - Any user-facing strings inside Swift apps stay localized (`zh-Hans` + `en`) in the respective app's String Catalogs.
5. **Schema & Protocol Stability**: Keep `chaox-agent/v1` endpoints, permission policies, and SQLite/D1 migrations synchronized between `server/`, `CHAOXAgentKit/`, `../sx`, `../bx`, and `../csteix.com`. Never commit `wrangler.local.toml`, `.env`, `.sqlite` data files, or Bearer tokens.
