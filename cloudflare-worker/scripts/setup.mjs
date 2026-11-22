#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(__dirname, "..");
const templateTomlPath = path.join(workerRoot, "wrangler.toml");
const localTomlPath = path.join(workerRoot, "wrangler.local.toml");
const DB_NAME = "chaox-agent";
const PLACEHOLDER_ID = "REPLACE_WITH_YOUR_D1_DATABASE_ID";

function parseArgs(argv) {
  return {
    dryRun: argv.includes("--dry-run"),
    login: argv.includes("--login")
  };
}

function runCommand(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: workerRoot,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["pipe", "pipe", "pipe"],
    env: { ...process.env, CI: "true", ...options.env },
    input: options.input
  });
  return result;
}

function requireSuccess(result, description) {
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${description} failed (exit ${result.status ?? "unknown"}):\n${details}`);
  }
  return result;
}

function extractWorkerUrl(output) {
  const matches = output.match(/https:\/\/[A-Za-z0-9.-]+\.workers\.dev\b/g);
  if (matches && matches.length > 0) {
    return matches[matches.length - 1];
  }
  const anyHttps = output.match(/https:\/\/[^\s"'`]+/g);
  if (anyHttps && anyHttps.length > 0) {
    return anyHttps[anyHttps.length - 1].replace(/\/+$/, "");
  }
  return null;
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

async function verifyLiveDeployment(workerUrl, tokens) {
  const healthRes = await fetch(`${workerUrl}/health`);
  if (!healthRes.ok) {
    throw new Error(`Health check failed with HTTP ${healthRes.status}`);
  }
  const health = await healthRes.json();
  if (health.status !== "ok") {
    throw new Error(`Unexpected /health payload: ${JSON.stringify(health)}`);
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

    const crossRes = await fetch(`${workerUrl}/sync/sx/status?limit=1`, {
      method: "GET",
      headers: { Authorization: `Bearer ${tokens.mcpToken}` }
    });
    if (crossRes.status !== 403) {
      throw new Error(`Expected HTTP 403 when calling /sync/* with CHAOX_MCP_TOKEN, got ${crossRes.status}`);
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
  return tools.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const templateToml = readFileSync(templateTomlPath, "utf8");
  if (!templateToml.includes(PLACEHOLDER_ID)) {
    throw new Error(`Expected placeholder '${PLACEHOLDER_ID}' in ${templateTomlPath}`);
  }

  const explicitAuthToken = process.env.CHAOX_AUTH_TOKEN?.trim() || "";
  const explicitSyncToken = process.env.CHAOX_SYNC_TOKEN?.trim() || "";
  const explicitMcpToken = process.env.CHAOX_MCP_TOKEN?.trim() || "";
  const useLegacySingleToken = Boolean(explicitAuthToken && !explicitSyncToken && !explicitMcpToken);

  if (args.dryRun) {
    console.log("[dry-run] Verified wrangler.toml template and setup workflow:");
    console.log("  1. Verify Wrangler auth (`npx wrangler whoami`)");
    console.log(`  2. Find or create D1 database '${DB_NAME}'`);
    console.log(`  3. Write gitignored '${path.basename(localTomlPath)}' with resolved database_id`);
    console.log("  4. Apply D1 migrations remotely");
    console.log("  5. Deploy Worker (fails closed while secrets are unset)");
    console.log("  6. Generate & upload two separate tokens: CHAOX_SYNC_TOKEN (iOS) + CHAOX_MCP_TOKEN (AI)");
    console.log("  7. Verify live GET /health, GET /sync/sx/status, POST /mcp tools/list, and 403 isolation");
    return;
  }

  console.log("1/7 Checking Cloudflare authentication...");
  let whoami = runCommand("npx", ["wrangler", "whoami"]);
  const combinedWhoami = `${whoami.stdout || ""}\n${whoami.stderr || ""}`;
  if (whoami.status !== 0 || /not authenticated/i.test(combinedWhoami)) {
    if (!args.login) {
      console.error("Not logged in to Cloudflare. Run `npx wrangler login` (or `npm run setup -- --login`) and retry.");
      process.exit(1);
    }
    console.log("Launching browser login via `npx wrangler login`...");
    const loginRes = runCommand("npx", ["wrangler", "login"], { inherit: true });
    requireSuccess(loginRes, "wrangler login");
    whoami = runCommand("npx", ["wrangler", "whoami"]);
    requireSuccess(whoami, "wrangler whoami");
  }

  console.log(`2/7 Looking up D1 database '${DB_NAME}'...`);
  const listRes = requireSuccess(runCommand("npx", ["wrangler", "d1", "list", "--json"]), "wrangler d1 list");
  let databases = JSON.parse(listRes.stdout || "[]");
  let targetDb = databases.find((db) => db.name === DB_NAME);

  if (!targetDb) {
    console.log(`Creating D1 database '${DB_NAME}'...`);
    requireSuccess(runCommand("npx", ["wrangler", "d1", "create", DB_NAME]), "wrangler d1 create");
    const refreshed = requireSuccess(runCommand("npx", ["wrangler", "d1", "list", "--json"]), "wrangler d1 list");
    databases = JSON.parse(refreshed.stdout || "[]");
    targetDb = databases.find((db) => db.name === DB_NAME);
  }

  if (!targetDb?.uuid) {
    throw new Error(`Could not resolve UUID for D1 database '${DB_NAME}'.`);
  }
  console.log(`   Using D1 database UUID: ${targetDb.uuid}`);

  console.log(`3/7 Writing gitignored ${path.basename(localTomlPath)}...`);
  const localToml = templateToml.replace(PLACEHOLDER_ID, targetDb.uuid);
  writeFileSync(localTomlPath, localToml, "utf8");

  console.log("4/7 Applying D1 schema migrations remotely...");
  requireSuccess(
    runCommand(
      "npx",
      ["wrangler", "d1", "migrations", "apply", DB_NAME, "--remote", "--config", "wrangler.local.toml"],
      { input: "y\n" }
    ),
    "wrangler d1 migrations apply"
  );

  console.log("5/7 Deploying Worker...");
  const deployRes = requireSuccess(
    runCommand("npx", ["wrangler", "deploy", "--config", "wrangler.local.toml"]),
    "wrangler deploy"
  );
  const deployOutput = `${deployRes.stdout || ""}\n${deployRes.stderr || ""}`;
  const workerUrl = extractWorkerUrl(deployOutput);
  if (!workerUrl) {
    throw new Error(`Deployed Worker, but could not parse Worker URL from output:\n${deployOutput}`);
  }

  let verifyTokens;
  if (useLegacySingleToken) {
    console.log("6/7 Setting legacy CHAOX_AUTH_TOKEN secret (explicitly provided)...");
    requireSuccess(
      runCommand(
        "npx",
        ["wrangler", "secret", "put", "CHAOX_AUTH_TOKEN", "--config", "wrangler.local.toml"],
        { input: `${explicitAuthToken}\n` }
      ),
      "wrangler secret put CHAOX_AUTH_TOKEN"
    );
    verifyTokens = { mode: "legacy", authToken: explicitAuthToken };
  } else {
    console.log("6/7 Setting two separated secrets: CHAOX_SYNC_TOKEN (iOS) + CHAOX_MCP_TOKEN (AI)...");
    const syncToken = explicitSyncToken || crypto.randomBytes(32).toString("hex");
    const mcpToken = explicitMcpToken || crypto.randomBytes(32).toString("hex");
    requireSuccess(
      runCommand(
        "npx",
        ["wrangler", "secret", "put", "CHAOX_SYNC_TOKEN", "--config", "wrangler.local.toml"],
        { input: `${syncToken}\n` }
      ),
      "wrangler secret put CHAOX_SYNC_TOKEN"
    );
    requireSuccess(
      runCommand(
        "npx",
        ["wrangler", "secret", "put", "CHAOX_MCP_TOKEN", "--config", "wrangler.local.toml"],
        { input: `${mcpToken}\n` }
      ),
      "wrangler secret put CHAOX_MCP_TOKEN"
    );
    verifyTokens = { mode: "split", syncToken, mcpToken };
  }

  console.log("7/7 Verifying live endpoints...");
  const toolCount = await verifyLiveDeployment(workerUrl, verifyTokens);

  console.log("\n============================================================");
  console.log("CHAOX Agent Cloudflare Worker deployed and verified!");
  console.log("============================================================");
  console.log(`Server Base URL            : ${workerUrl}`);
  console.log(`MCP Streamable HTTP URL    : ${workerUrl}/mcp`);
  console.log(`Verified MCP Tools         : ${toolCount}`);

  if (verifyTokens.mode === "split") {
    console.log("\n1) iOS App Client Config (SX / BX / CSTEIX -> Settings -> AI Assistant):");
    console.log(`URL: ${workerUrl}`);
    console.log(`Token: ${verifyTokens.syncToken}`);

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
