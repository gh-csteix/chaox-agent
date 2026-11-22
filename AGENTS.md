# AGENTS.md

Guidance for AI agents and contributors working in `chaox-agent`.

## Overview

`chaox-agent` is the cross-app protocol, shared Swift SDK (`CHAOXAgentKit`, Phase 1B), open-source MCP server (`chaox-agent-mcp` in TypeScript/Node.js, Phase 1B), and Shortcuts documentation repository connecting **SX** (`../sx`), **BX** (`../bx`), **GX** (`../gx`), and future CHAOX apps.

## Hard Invariants

1. **Zero CHAOX Server**: Never design or introduce a CHAOX-hosted backend, account system, telemetry endpoint, or data-collection relay. All integrations run either natively on iOS (`App Intents`) or against the user's own storage (`iCloud Drive/CHAOX-Agent/`).
2. **Privacy Boundaries**:
   - **SX**: Never touch `credentialInfo` secrets or `CredentialVaultService`.
   - **BX**: Never export Apple HealthKit metrics or `skinSpot` / `skinPhoto` data (App Review 5.1.3(ii)).
3. **Language Constraints**:
   - All documentation, code comments, identifiers, and git commit messages must be in **English**.
   - Any user-facing strings inside Swift apps stay localized (`zh-Hans` + `en`) in the respective app's String Catalogs.
4. **Schema Stability**: Keep `chaox.agent.op.v1`, `chaox.agent.receipt.v1`, and idempotency hashing rules in `SPEC.md` synchronized with implementations in `../sx` and `../bx`.

## Roadmap

- **Phase 1A (Current)**: `SPEC.md`, Shortcut recipes (`shortcuts/`), and native `App Intents` + domain services inside `../sx` and `../bx`.
- **Phase 1B (Next)**:
  - `swift/CHAOXAgentKit`: Swift Package (iOS 26+) handling Security-Scoped Bookmark persistence, `NSFileCoordinator` reads/writes, `inbox/` processing, receipt emission, and shared Settings UI.
  - `mcp/`: Open-source TypeScript/Node.js MCP Server (`chaox-agent-mcp`) and CLI supporting `stdio` and user-hosted `Streamable HTTP`, plus an agent `SKILL.md`.
