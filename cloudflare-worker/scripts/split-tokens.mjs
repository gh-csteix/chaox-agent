#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(__dirname, "..");
const localTomlPath = path.join(workerRoot, "wrangler.local.toml");
const localWranglerBin = path.join(workerRoot, "node_modules", "wrangler", "bin", "wrangler.js");

function parseArgs(argv) {
  let urlArg = null;
  let dryRun = false;
  let help = false;
  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--url" && idx + 1 < argv.length) {
      urlArg = argv[idx + 1];
      idx += 1;
    } else if (!arg.startsWith("-") && !urlArg) {
      urlArg = arg;
    }
  }
  return { dryRun, help, url: urlArg };
}

function normalizeBaseUrl(raw) {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/\/+$/, "").replace(/\/mcp$/, "").replace(/\/\*$/, "");
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function inferUrlFromWranglerConfig() {
  if (!existsSync(localTomlPath)) return null;
  const raw = readFileSync(localTomlPath, "utf8");
  const patternMatch = /pattern\s*=\s*["']([^"']+)["']/.exec(raw);
  if (!patternMatch) return null;
  return normalizeBaseUrl(patternMatch[1]);
}

function runWrangler(wranglerArgs, options = {}) {
  const useLocalBin = existsSync(localWranglerBin);
  const cmd = useLocalBin
    ? process.execPath
    : process.platform === "win32"
      ? "npx.cmd"
      : "npx";
  const args = useLocalBin ? [localWranglerBin, ...wranglerArgs] : ["wrangler", ...wranglerArgs];
  const env = { ...process.env, ...options.env };
  if (options.ci === false) {
    delete env.CI;
  } else {
    env.CI = "true";
  }

  return spawnSync(cmd, args, {
    cwd: workerRoot,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    shell: !useLocalBin && process.platform === "win32",
    env,
    input: options.input
  });
}

function detectWranglerHint(output) {
  if (/more than one account|multiple accounts|select an account|CLOUDFLARE_ACCOUNT_ID/i.test(output)) {
    return (
      "Hint: Your Cloudflare login has access to multiple accounts.\n" +
      "  1. Run 'npx wrangler whoami' to find the Account ID you want to use.\n" +
      "  2. Re-run: CLOUDFLARE_ACCOUNT_ID=<account-id> npm run split-tokens"
    );
  }
  return "";
}

function requireSuccess(result, description) {
  if (result.error || result.status !== 0) {
    const details = [
      result.error?.message ? `Spawn error: ${result.error.message}` : "",
      result.stdout,
      result.stderr
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
    const hint = detectWranglerHint(details);
    const suffix = hint ? `\n\n${hint}` : "";
    throw new Error(
      `${description} failed (exit ${result.status ?? "unknown"}):\n${details || "(no output)"}${suffix}`
    );
  }
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithSecretRetry(url, init) {
  let res;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    res = await fetch(url, init);
    if (res.status !== 401 || attempt === 6) {
      return res;
    }
    await sleep(1500);
  }
  return res;
}

async function verifySplitTokens(baseUrl, syncToken, mcpToken) {
  const syncStatusRes = await fetchWithSecretRetry(`${baseUrl}/sync/sx/status?limit=1`, {
    method: "GET",
    headers: { Authorization: `Bearer ${syncToken}` }
  });
  const syncStatusBody = await syncStatusRes.text();
  if (!syncStatusRes.ok) {
    throw new Error(`Sync token verification failed (HTTP ${syncStatusRes.status}): ${syncStatusBody}`);
  }
  const syncStatus = JSON.parse(syncStatusBody);
  if (syncStatus.tokenMode !== "split") {
    throw new Error(`Expected tokenMode 'split' from /sync/sx/status, got: ${syncStatusBody}`);
  }

  const mcpRes = await fetchWithSecretRetry(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${mcpToken}`
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
  });
  const mcpBody = await mcpRes.text();
  if (!mcpRes.ok) {
    throw new Error(`MCP token verification failed (HTTP ${mcpRes.status}): ${mcpBody}`);
  }

  const mcpOnSyncRes = await fetch(`${baseUrl}/sync/sx/status?limit=1`, {
    method: "GET",
    headers: { Authorization: `Bearer ${mcpToken}` }
  });
  if (mcpOnSyncRes.status !== 403) {
    throw new Error(`Expected HTTP 403 for MCP token on /sync/*, got ${mcpOnSyncRes.status}`);
  }

  const syncOnMcpRes = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${syncToken}`
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
  });
  if (syncOnMcpRes.status !== 403) {
    throw new Error(`Expected HTTP 403 for sync token on /mcp, got ${syncOnMcpRes.status}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: npm run split-tokens -- [--url https://<your-worker-url>] [--dry-run]\n" +
        "Environment (optional): CLOUDFLARE_ACCOUNT_ID, CHAOX_SYNC_TOKEN, CHAOX_MCP_TOKEN"
    );
    return;
  }

  const baseUrl = normalizeBaseUrl(args.url) ?? inferUrlFromWranglerConfig();

  if (args.dryRun) {
    console.log("[dry-run] Zero-downtime CHAOX two-key migration plan:");
    console.log("  1. Verify wrangler.local.toml exists and Wrangler auth is active");
    console.log("  2. Generate two random 64-char hex keys: CHAOX_SYNC_TOKEN and CHAOX_MCP_TOKEN");
    console.log("  3. Upload both via `wrangler secret put` WITHOUT deleting CHAOX_AUTH_TOKEN");
    console.log(
      baseUrl
        ? `  4. Verify live isolation on ${baseUrl} (sync=200, mcp=200, cross-access=403)`
        : "  4. Pass --url https://your-worker-url to also verify live 200/403 isolation"
    );
    console.log("  5. Print copy-ready iOS App Config and AI MCP Client JSON");
    console.log("  6. Print cleanup command to remove legacy CHAOX_AUTH_TOKEN once apps & clients are updated");
    return;
  }

  if (!existsSync(localTomlPath)) {
    throw new Error(
      `Missing ${path.basename(localTomlPath)} in ${workerRoot}. Run 'npm run setup' first.`
    );
  }

  console.log("1/4 Checking Cloudflare authentication...");
  const whoami = runWrangler(["whoami"]);
  if (whoami.error) {
    requireSuccess(whoami, "wrangler whoami");
  }
  const combinedWhoami = `${whoami.stdout || ""}\n${whoami.stderr || ""}`;
  if (whoami.status !== 0 || /not authenticated/i.test(combinedWhoami)) {
    throw new Error("Not logged in to Cloudflare. Run `npx wrangler login` first.");
  }

  console.log("2/4 Generating and uploading CHAOX_SYNC_TOKEN + CHAOX_MCP_TOKEN...");
  console.log("    (Keeping existing CHAOX_AUTH_TOKEN intact for zero-downtime migration.)");
  const syncToken = process.env.CHAOX_SYNC_TOKEN?.trim() || crypto.randomBytes(32).toString("hex");
  const mcpToken = process.env.CHAOX_MCP_TOKEN?.trim() || crypto.randomBytes(32).toString("hex");
  if (syncToken === mcpToken) {
    throw new Error("CHAOX_SYNC_TOKEN and CHAOX_MCP_TOKEN must be distinct values.");
  }

  requireSuccess(
    runWrangler(["secret", "put", "CHAOX_SYNC_TOKEN", "--config", "wrangler.local.toml"], {
      input: `${syncToken}\n`
    }),
    "wrangler secret put CHAOX_SYNC_TOKEN"
  );
  requireSuccess(
    runWrangler(["secret", "put", "CHAOX_MCP_TOKEN", "--config", "wrangler.local.toml"], {
      input: `${mcpToken}\n`
    }),
    "wrangler secret put CHAOX_MCP_TOKEN"
  );

  if (baseUrl) {
    console.log(`3/4 Verifying live split-token isolation on ${baseUrl}...`);
    await verifySplitTokens(baseUrl, syncToken, mcpToken);
  } else {
    console.log("3/4 Skipped live HTTP check (pass '-- --url https://your-domain' to verify automatically).");
  }

  const displayUrl = baseUrl ?? "https://<your-worker-url>";
  console.log("4/4 Migration step 1 complete! Update your iOS apps and AI clients using:");
  console.log("\n============================================================");
  console.log("1) iOS App Config (SX / BX / CSTEIX -> Settings -> AI Assistant -> Paste Config):");
  console.log(`URL: ${displayUrl}`);
  console.log(`Sync Token: ${syncToken}`);
  console.log(`MCP Token: ${mcpToken}`);

  console.log("\n2) AI MCP Client Config (Claude / Cursor / Antigravity):");
  console.log(
    JSON.stringify(
      {
        mcpServers: {
          "chaox-agent": {
            url: `${displayUrl}/mcp`,
            headers: {
              Authorization: `Bearer ${mcpToken}`
            }
          }
        }
      },
      null,
      2
    )
  );

  console.log("\n============================================================");
  console.log("After all iPhone apps and AI clients are updated and synced, remove the legacy key:");
  console.log("  npx wrangler secret delete CHAOX_AUTH_TOKEN --config wrangler.local.toml");
  console.log("============================================================");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
