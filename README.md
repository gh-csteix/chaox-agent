# chaox-agent

**CHAOX Agent Protocol (`chaox-agent/v1`)** — Local-first, zero-CHAOX-server AI interoperability for personal CHAOX apps:

- **SX (Spending X)** — Personal ledger & project expense/income archive
- **BX (Body X)** — Meal calories, skincare, and toilet log tracker
- **GX** — Reserved (`v1.1+`)

Talk directly to any AI assistant (Claude, ChatGPT, Cursor, OpenClaw, Codex, Apple Shortcuts, or self-hosted agents) without CHAOX running a backend, collecting your data (`Data Not Collected`), or requiring a CHAOX account.

---

## Integration Modes

| Feature | **Cloudflare BYOS Worker** *(Primary)* | **On-Device Shortcuts** |
|---|---|---|
| Works 24/7 with Mac turned off | **Yes** | Yes |
| Mobile & desktop AI direct chat | **Yes** (single HTTPS MCP URL) | Shortcut trigger only |
| Mobile VPN / Tailscale conflicts | **None** | None |
| Hosting cost | **Free** (Cloudflare Workers + D1, no card required) | Free |
| Setup guide | [cloudflare-worker/README.md](cloudflare-worker/README.md) | [shortcuts/MEAL_TO_SX_AND_BX.md](shortcuts/MEAL_TO_SX_AND_BX.md) |

---

## Quick Start (Cloudflare BYOS)

### Option A: Ask Your AI Assistant to Deploy It

Open this repo in Claude Code, Cursor, Codex, or Antigravity and paste:

> Follow `cloudflare-worker/README.md`: run `npm install`, help me finish `npx wrangler login` in the browser, run `npm run setup` to deploy the Worker + D1 + secret automatically, and give me the Worker URL, MCP URL, and Bearer Token to paste into SX, BX, and my AI client.

### Option B: Run One Command Yourself

```bash
cd cloudflare-worker
npm install
npx wrangler login
npm run setup
```

Then in 60 seconds on your iPhone:
1. Open **SX -> Settings -> Agent Exchange**, paste your Worker URL + Token, tap **Connect & Sync**.
2. Open **BX -> Settings -> Agent Exchange**, paste the same Worker URL + Token, tap **Connect & Sync**.
3. Add `<worker-url>/mcp` + `Authorization: Bearer <token>` to your mobile or desktop AI client, and load [mcp/SKILL.md](mcp/SKILL.md) into your client's skills folder or system prompt.

See [cloudflare-worker/README.md](cloudflare-worker/README.md) for custom domains, token rotation, personal preferences, and troubleshooting.

---

## Repository Layout

- [cloudflare-worker/](cloudflare-worker/) — Free card-free Cloudflare Workers + D1 Streamable HTTP MCP & sync server (`npm run setup`)
- [CHAOXAgentKit/](CHAOXAgentKit/) — Swift 6 package shared by SX and BX (Cloud Endpoint HTTPS client, Keychain token storage, permission enforcement)
- [mcp/SKILL.md](mcp/SKILL.md) — Portable AI assistant skill prompt (alongside the legacy `mcp/` Node package)
- [shortcuts/](shortcuts/) — Apple Shortcuts & on-device `App Intents` recipe
- [SPEC.md](SPEC.md) — `chaox-agent/v1` protocol wire specification
- [AGENTS.md](AGENTS.md) — Contributor & AI rules (English docs/code, privacy invariants)

## Privacy & Safety Guarantees

- **Zero CHAOX server** and **`Data Not Collected`**.
- **SX isolation**: Never exports credential vault entries, passwords, TOTP secrets, recovery codes, or project private credential notes.
- **BX isolation**: Never exports HealthKit raw metrics or skin lesion photos.
- **No delete endpoint**: Agents can only query snapshots and enqueue sanitized records; editing and moving records to Trash happen strictly inside SX and BX.
