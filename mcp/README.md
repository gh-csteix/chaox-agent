# chaox-agent-mcp (Legacy Local iCloud Drive MCP Bridge)

`mcp/` (`chaox-agent-mcp`) is the **legacy local iCloud Drive MCP bridge** (9 SX/BX tools) retained for local-only, file-based workflows on macOS.

> **New deployments:** Use the full **72-tool** Streamable HTTP MCP server across **SX**, **BX**, and **CSTEIX** instead:
> - **Recommended (free, card-free serverless):** [`../cloudflare-worker/`](../cloudflare-worker/) — see [`../cloudflare-worker/README.md`](../cloudflare-worker/README.md)
> - **Self-hosted (Node 22.13+ / Docker + SQLite):** [`../server/`](../server/) — see [`../server/README.md`](../server/README.md)

This directory also holds the portable AI assistant skill prompt in [`SKILL.md`](SKILL.md), which applies to the full 72-tool protocol (and is served automatically by `server/` and `cloudflare-worker/` as `chaox://guide/skill`).

## Included Legacy Tools (9 SX/BX Tools)

- **Status:** `chaox_get_status`
- **SX:** `sx_get_catalog`, `sx_get_summary`, `sx_record_expense`, `sx_record_income`
- **BX:** `bx_get_summary`, `bx_record_food`, `bx_record_skin`, `bx_record_toilet`

*(Does not include CSTEIX, full CRUD/update/delete, workouts/sleep lists, optimistic list overlays, or Stage Couplets.)*

## Local Usage

```bash
cd mcp
npm install
npm run build

# Stdio transport (default, reads/writes local CHAOX exchange directory)
npm start

# Optional local Streamable HTTP transport (loopback default: 127.0.0.1:3847)
node dist/cli.js --http --dir /path/to/exchange --host 127.0.0.1 --port 3847
```

Binding a non-loopback `--host` requires passing `--token <secret>` or setting `CHAOX_MCP_TOKEN`.
