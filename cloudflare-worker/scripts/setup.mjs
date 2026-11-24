#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(__dirname, "..");
const templateTomlPath = path.join(workerRoot, "wrangler.toml");
const localTomlPath = path.join(workerRoot, "wrangler.local.toml");
const localWranglerBin = path.join(workerRoot, "node_modules", "wrangler", "bin", "wrangler.js");
const DB_NAME = "chaox-agent";
const PLACEHOLDER_ID = "REPLACE_WITH_YOUR_D1_DATABASE_ID";

function parseArgs(argv) {
  return {
    dryRun: argv.includes("--dry-run"),
    login: argv.includes("--login"),
    overwriteConfig: argv.includes("--overwrite-config"),
    rotateTokens: argv.includes("--rotate-tokens"),
    legacyToken: argv.includes("--legacy-token"),
    help: argv.includes("--help") || argv.includes("-h")
  };
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
    stdio: options.inherit ? "inherit" : ["pipe", "pipe", "pipe"],
    shell: !useLocalBin && process.platform === "win32",
    env,
    input: options.input
  });
}

function isMultiAccountError(output) {
  return /more than one account|multiple accounts|select an account|CLOUDFLARE_ACCOUNT_ID/i.test(
    output
  );
}

function isWorkersDevSubdomainError(output) {
  return /workers\.dev\s+subdomain|register a (?:workers\.dev )?subdomain|need to register a.*subdomain|subdomain.*workers\.dev/i.test(
    output
  );
}

function detectWranglerHint(output) {
  const hints = [];
  if (isMultiAccountError(output)) {
    hints.push(
      "Hint: Your Cloudflare login has access to multiple accounts.\n" +
        "  1. Run 'npx wrangler whoami' to find the Account ID you want to use.\n" +
        "  2. Re-run: CLOUDFLARE_ACCOUNT_ID=<account-id> npm run setup"
    );
  }
  if (isWorkersDevSubdomainError(output)) {
    hints.push(
      "Hint: Brand-new Cloudflare accounts must register a free *.workers.dev subdomain before the first deploy.\n" +
        "  1. Visit https://dash.cloudflare.com -> Workers & Pages -> Overview to claim a *.workers.dev subdomain,\n" +
        "     or run 'npx wrangler deploy --config wrangler.local.toml' directly in an interactive terminal.\n" +
        "  2. Re-run 'npm run setup' to finish configuring secrets and live verification."
    );
  }
  return hints.join("\n\n");
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

function parseJsonArrayOutput(stdout) {
  const trimmed = (stdout || "").trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    const start = trimmed.indexOf("[");
    const end = trimmed.lastIndexOf("]");
    if (start !== -1 && end > start) {
      const sliced = JSON.parse(trimmed.slice(start, end + 1));
      if (Array.isArray(sliced)) return sliced;
    }
    throw new Error(`Unable to parse JSON array output from Wrangler:\n${trimmed}`);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function configHasDatabaseId(tomlContent, databaseId) {
  return new RegExp(`database_id\\s*=\\s*["']${escapeRegExp(databaseId)}["']`).test(tomlContent);
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

function extractWorkerUrl(output) {
  const matches = output.match(/https:\/\/[A-Za-z0-9.-]+\.workers\.dev\b/g);
  if (matches && matches.length > 0) {
    return matches[matches.length - 1];
  }
  const anyHttps = output.match(/https:\/\/[^\s"'`<>)]+/g) ?? [];
  const filtered = anyHttps.filter(
    (url) =>
      !/^https:\/\/(?:developers\.cloudflare\.com|dash\.cloudflare\.com|community\.cloudflare\.com|github\.com|www\.npmjs\.com)\b/i.test(
        url
      )
  );
  if (filtered.length > 0) {
    return filtered[filtered.length - 1].replace(/[.,;]+$/, "").replace(/\/+$/, "");
  }
  return inferUrlFromWranglerConfig();
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

function listExistingSecretNames() {
  const listRes = requireSuccess(
    runWrangler(["secret", "list", "--format", "json", "--config", "wrangler.local.toml"]),
    "wrangler secret list"
  );
  const entries = parseJsonArrayOutput(listRes.stdout);
  return new Set(entries.map((entry) => entry?.name).filter((name) => typeof name === "string"));
}

async function verifyLiveDeployment(workerUrl, tokens) {
  const healthRes = await fetch(`${workerUrl}/health`);
  if (!healthRes.ok) {
    throw new Error(`Health check failed with HTTP ${healthRes.status}`);
  }
  const health = await healthRes.json();
  if (health.status !== "ok") {
    throw new Error(`Unexpected /health payload: ${JSON.stringify(health)}`);
  }

  if (tokens.mode === "preserved") {
    return null;
  }

  if (tokens.mode === "split") {
    const syncStatusRes = await fetchWithSecretRetry(`${workerUrl}/sync/sx/status?limit=1`, {
      method: "GET",
      headers: { Authorization: `Bearer ${tokens.syncToken}` }
    });
    const syncStatusText = await syncStatusRes.text();
    if (!syncStatusRes.ok) {
      throw new Error(`Live sync status verification failed (HTTP ${syncStatusRes.status}): ${syncStatusText}`);
    }
    const syncStatus = JSON.parse(syncStatusText);
    if (syncStatus.tokenMode !== "split") {
      throw new Error(`Expected tokenMode 'split' from /sync/sx/status, got ${JSON.stringify(syncStatus)}`);
    }
  }

  const mcpToken = tokens.mode === "split" ? tokens.mcpToken : tokens.authToken;
  const mcpRes = await fetchWithSecretRetry(`${workerUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${mcpToken}`
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
  });
  const mcpBody = await mcpRes.text();
  if (!mcpRes.ok) {
    throw new Error(`Live MCP verification failed (HTTP ${mcpRes.status}): ${mcpBody}`);
  }
  const parsed = JSON.parse(mcpBody);
  const tools = parsed?.result?.tools;
  if (!Array.isArray(tools) || tools.length < 70 || !tools.some((tool) => tool?.name === "chaox_get_status")) {
    throw new Error(`Expected >= 70 MCP tools (including chaox_get_status) from live worker, got ${tools?.length ?? 0}`);
  }

  if (tokens.mode === "split") {
    const mcpOnSyncRes = await fetch(`${workerUrl}/sync/sx/status?limit=1`, {
      method: "GET",
      headers: { Authorization: `Bearer ${tokens.mcpToken}` }
    });
    if (mcpOnSyncRes.status !== 403) {
      throw new Error(`Expected HTTP 403 when calling /sync/* with CHAOX_MCP_TOKEN, got ${mcpOnSyncRes.status}`);
    }

    const syncOnMcpRes = await fetch(`${workerUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokens.syncToken}`
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
    });
    if (syncOnMcpRes.status !== 403) {
      throw new Error(`Expected HTTP 403 when calling /mcp with CHAOX_SYNC_TOKEN, got ${syncOnMcpRes.status}`);
    }
  }

  return tools.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: npm run setup -- [--dry-run] [--login] [--overwrite-config] [--rotate-tokens] [--legacy-token]\n" +
        "Environment (optional): CLOUDFLARE_ACCOUNT_ID, CHAOX_SYNC_TOKEN, CHAOX_MCP_TOKEN, CHAOX_AUTH_TOKEN"
    );
    return;
  }

  const templateToml = readFileSync(templateTomlPath, "utf8");
  if (!templateToml.includes(PLACEHOLDER_ID)) {
    throw new Error(`Expected placeholder '${PLACEHOLDER_ID}' in ${templateTomlPath}`);
  }

  const explicitAuthToken = process.env.CHAOX_AUTH_TOKEN?.trim() || "";
  const explicitSyncToken = process.env.CHAOX_SYNC_TOKEN?.trim() || "";
  const explicitMcpToken = process.env.CHAOX_MCP_TOKEN?.trim() || "";
  const hasExplicitTokens = Boolean(explicitAuthToken || explicitSyncToken || explicitMcpToken);
  const useLegacySingleToken = Boolean(
    args.legacyToken || (explicitAuthToken && !explicitSyncToken && !explicitMcpToken)
  );

  if (args.dryRun) {
    console.log("[dry-run] Verified wrangler.toml template and setup workflow:");
    console.log("  1. Verify Wrangler auth (`wrangler whoami`)");
    console.log(`  2. Find or create D1 database '${DB_NAME}'`);
    console.log(
      `  3. Write gitignored '${path.basename(localTomlPath)}' with resolved database_id (preserved if already configured unless --overwrite-config)`
    );
    console.log("  4. Apply D1 migrations remotely (`wrangler d1 migrations apply -y`)");
    console.log("  5. Deploy Worker (interactive fallback for brand-new accounts without a *.workers.dev subdomain)");
    console.log(
      "  6. Check existing Worker secrets (`wrangler secret list --format json`); preserve existing tokens on re-run unless --rotate-tokens or explicit env tokens are provided"
    );
    console.log(
      "  7. Verify live GET /health (and full GET /sync/sx/status, POST /mcp tools/list, plus bidirectional 403 isolation when tokens are set/rotated)"
    );
    return;
  }

  console.log("1/7 Checking Cloudflare authentication...");
  let whoami = runWrangler(["whoami"]);
  if (whoami.error) {
    requireSuccess(whoami, "wrangler whoami");
  }
  const combinedWhoami = `${whoami.stdout || ""}\n${whoami.stderr || ""}`;
  if (whoami.status !== 0 || /not authenticated/i.test(combinedWhoami)) {
    if (!args.login) {
      console.error("Not logged in to Cloudflare. Run `npx wrangler login` (or `npm run setup -- --login`) and retry.");
      process.exit(1);
    }
    console.log("Launching browser login via `wrangler login`...");
    const loginRes = runWrangler(["login"], { inherit: true, ci: false });
    requireSuccess(loginRes, "wrangler login");
    whoami = runWrangler(["whoami"]);
    requireSuccess(whoami, "wrangler whoami");
  }

  console.log(`2/7 Looking up D1 database '${DB_NAME}'...`);
  const listRes = requireSuccess(runWrangler(["d1", "list", "--json"]), "wrangler d1 list");
  let databases = parseJsonArrayOutput(listRes.stdout);
  let targetDb = databases.find((db) => db.name === DB_NAME);

  if (!targetDb) {
    console.log(`Creating D1 database '${DB_NAME}'...`);
    requireSuccess(runWrangler(["d1", "create", DB_NAME]), "wrangler d1 create");
    const refreshed = requireSuccess(runWrangler(["d1", "list", "--json"]), "wrangler d1 list");
    databases = parseJsonArrayOutput(refreshed.stdout);
    targetDb = databases.find((db) => db.name === DB_NAME);
  }

  if (!targetDb?.uuid) {
    throw new Error(`Could not resolve UUID for D1 database '${DB_NAME}'.`);
  }
  console.log(`   Using D1 database UUID: ${targetDb.uuid}`);

  const existingLocalToml = existsSync(localTomlPath) ? readFileSync(localTomlPath, "utf8") : null;
  if (existingLocalToml && !args.overwriteConfig && configHasDatabaseId(existingLocalToml, targetDb.uuid)) {
    console.log(
      `3/7 Preserving existing ${path.basename(localTomlPath)} (already targets database_id ${targetDb.uuid}; pass --overwrite-config to regenerate)...`
    );
  } else {
    console.log(`3/7 Writing gitignored ${path.basename(localTomlPath)}...`);
    const localToml = templateToml.replace(PLACEHOLDER_ID, targetDb.uuid);
    writeFileSync(localTomlPath, localToml, "utf8");
  }

  console.log("4/7 Applying D1 schema migrations remotely...");
  requireSuccess(
    runWrangler(
      ["d1", "migrations", "apply", DB_NAME, "--remote", "--config", "wrangler.local.toml", "-y"],
      { input: "y\n" }
    ),
    "wrangler d1 migrations apply"
  );

  console.log("5/7 Deploying Worker...");
  let deployRes = runWrangler(["deploy", "--config", "wrangler.local.toml"]);
  let deployOutput = `${deployRes.stdout || ""}\n${deployRes.stderr || ""}`;
  if (
    !deployRes.error &&
    deployRes.status !== 0 &&
    isWorkersDevSubdomainError(deployOutput) &&
    process.stdin.isTTY &&
    process.stdout.isTTY
  ) {
    console.log(
      "   No *.workers.dev subdomain registered yet. Launching interactive `wrangler deploy` to claim one..."
    );
    const interactiveDeploy = runWrangler(["deploy", "--config", "wrangler.local.toml"], {
      inherit: true,
      ci: false
    });
    requireSuccess(interactiveDeploy, "wrangler deploy");
    deployRes = runWrangler(["deploy", "--config", "wrangler.local.toml"]);
    deployOutput = `${deployRes.stdout || ""}\n${deployRes.stderr || ""}`;
  }
  requireSuccess(deployRes, "wrangler deploy");
  const workerUrl = extractWorkerUrl(deployOutput);
  if (!workerUrl) {
    throw new Error(`Deployed Worker, but could not parse Worker URL from output:\n${deployOutput}`);
  }

  const existingSecrets = listExistingSecretNames();
  const hasExistingSplitSecrets =
    existingSecrets.has("CHAOX_SYNC_TOKEN") && existingSecrets.has("CHAOX_MCP_TOKEN");
  const hasExistingLegacySecret = existingSecrets.has("CHAOX_AUTH_TOKEN");

  let verifyTokens;
  if (
    !hasExplicitTokens &&
    !args.rotateTokens &&
    ((!useLegacySingleToken && hasExistingSplitSecrets) ||
      (useLegacySingleToken && hasExistingLegacySecret) ||
      (!useLegacySingleToken && !hasExistingSplitSecrets && hasExistingLegacySecret))
  ) {
    const configuredMode = hasExistingSplitSecrets ? "split" : "legacy";
    console.log(
      configuredMode === "split"
        ? "6/7 Existing CHAOX_SYNC_TOKEN and CHAOX_MCP_TOKEN detected; preserving tokens..."
        : "6/7 Existing legacy CHAOX_AUTH_TOKEN detected; preserving token..."
    );
    verifyTokens = { mode: "preserved", configuredMode };
  } else if (useLegacySingleToken) {
    const authToken = explicitAuthToken || crypto.randomBytes(32).toString("hex");
    console.log(
      explicitAuthToken
        ? "6/7 Setting legacy CHAOX_AUTH_TOKEN secret (explicitly provided)..."
        : "6/7 Generating & setting legacy CHAOX_AUTH_TOKEN secret..."
    );
    requireSuccess(
      runWrangler(["secret", "put", "CHAOX_AUTH_TOKEN", "--config", "wrangler.local.toml"], {
        input: `${authToken}\n`
      }),
      "wrangler secret put CHAOX_AUTH_TOKEN"
    );
    verifyTokens = { mode: "legacy", authToken };
  } else {
    console.log("6/7 Setting two separated secrets: CHAOX_SYNC_TOKEN (iOS) + CHAOX_MCP_TOKEN (AI)...");
    const syncToken = explicitSyncToken || crypto.randomBytes(32).toString("hex");
    const mcpToken = explicitMcpToken || crypto.randomBytes(32).toString("hex");
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
    verifyTokens = { mode: "split", syncToken, mcpToken, hadLegacySecret: hasExistingLegacySecret };
  }

  console.log("7/7 Verifying live endpoints...");
  const toolCount = await verifyLiveDeployment(workerUrl, verifyTokens);

  console.log("\n============================================================");
  console.log("CHAOX Agent Cloudflare Worker deployed and verified!");
  console.log("============================================================");
  console.log(`Server Base URL            : ${workerUrl}`);
  console.log(`MCP Streamable HTTP URL    : ${workerUrl}/mcp`);

  if (verifyTokens.mode === "preserved") {
    console.log(
      `Bearer Secrets             : Preserved existing Worker secrets (${
        verifyTokens.configuredMode === "split" ? "CHAOX_SYNC_TOKEN + CHAOX_MCP_TOKEN" : "CHAOX_AUTH_TOKEN"
      })`
    );
    console.log("\nExisting iOS apps and AI clients remain connected without reconfiguration.");
    console.log("To rotate and print fresh tokens, re-run: npm run setup -- --rotate-tokens");
    if (verifyTokens.configuredMode === "legacy") {
      console.log("To upgrade from legacy CHAOX_AUTH_TOKEN to split tokens with zero downtime, run: npm run split-tokens");
    }
    return;
  }

  console.log(`Verified MCP Tools         : ${toolCount}`);

  if (verifyTokens.mode === "split") {
    console.log("\n1) iOS App Client Config (SX / BX / CSTEIX -> Settings -> AI Assistant -> Paste Config):");
    console.log(`URL: ${workerUrl}`);
    console.log(`Sync Token: ${verifyTokens.syncToken}`);
    console.log(`MCP Token: ${verifyTokens.mcpToken}`);

    console.log("\n2) AI MCP Client Config (Claude / Cursor / Antigravity):");
    console.log(
      JSON.stringify(
        {
          mcpServers: {
            "chaox-agent": {
              url: `${workerUrl}/mcp`,
              headers: {
                Authorization: `Bearer ${verifyTokens.mcpToken}`
              }
            }
          }
        },
        null,
        2
      )
    );

    if (verifyTokens.hadLegacySecret) {
      console.log(
        "\nNote: Legacy CHAOX_AUTH_TOKEN is still configured on this Worker. Remove it once all clients are updated:\n" +
          "  npx wrangler secret delete CHAOX_AUTH_TOKEN --config wrangler.local.toml"
      );
    }
  } else {
    console.log(`Legacy Shared Bearer Token : ${verifyTokens.authToken}`);
    console.log("\nRemote MCP JSON config:");
    console.log(
      JSON.stringify(
        {
          mcpServers: {
            "chaox-agent": {
              url: `${workerUrl}/mcp`,
              headers: {
                Authorization: `Bearer ${verifyTokens.authToken}`
              }
            }
          }
        },
        null,
        2
      )
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
