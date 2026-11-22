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

async function verifyLiveDeployment(workerUrl, token) {
  const healthRes = await fetch(`${workerUrl}/health`);
  if (!healthRes.ok) {
    throw new Error(`Health check failed with HTTP ${healthRes.status}`);
  }
  const health = await healthRes.json();
  if (health.status !== "ok") {
    throw new Error(`Unexpected /health payload: ${JSON.stringify(health)}`);
  }

  let lastStatus = 0;
  let lastBody = "";
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const mcpRes = await fetch(`${workerUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });
    lastStatus = mcpRes.status;
    lastBody = await mcpRes.text();
    if (mcpRes.ok) {
      const parsed = JSON.parse(lastBody);
      const count = parsed?.result?.tools?.length ?? 0;
      if (count !== 9) {
        throw new Error(`Expected 9 MCP tools from live worker, got ${count}`);
      }
      return count;
    }
    if (mcpRes.status === 401 && attempt < 6) {
      await sleep(1500);
      continue;
    }
    break;
  }
  throw new Error(`Live MCP verification failed (HTTP ${lastStatus}): ${lastBody}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const templateToml = readFileSync(templateTomlPath, "utf8");
  if (!templateToml.includes(PLACEHOLDER_ID)) {
    throw new Error(`Expected placeholder '${PLACEHOLDER_ID}' in ${templateTomlPath}`);
  }

  if (args.dryRun) {
    console.log("[dry-run] Verified wrangler.toml template and setup workflow:");
    console.log("  1. Verify Wrangler auth (`npx wrangler whoami`)");
    console.log(`  2. Find or create D1 database '${DB_NAME}'`);
    console.log(`  3. Write gitignored '${path.basename(localTomlPath)}' with resolved database_id`);
    console.log("  4. Apply D1 migrations remotely");
    console.log("  5. Deploy Worker (fails closed while secret is unset)");
    console.log("  6. Generate & upload CHAOX_AUTH_TOKEN secret");
    console.log("  7. Verify live GET /health and POST /mcp tools/list");
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

  console.log("6/7 Setting CHAOX_AUTH_TOKEN secret...");
  const token = process.env.CHAOX_AUTH_TOKEN?.trim() || crypto.randomBytes(32).toString("hex");
  requireSuccess(
    runCommand(
      "npx",
      ["wrangler", "secret", "put", "CHAOX_AUTH_TOKEN", "--config", "wrangler.local.toml"],
      { input: `${token}\n` }
    ),
    "wrangler secret put CHAOX_AUTH_TOKEN"
  );

  console.log("7/7 Verifying live endpoints...");
  const toolCount = await verifyLiveDeployment(workerUrl, token);

  console.log("\n============================================================");
  console.log("CHAOX Agent Cloudflare Worker deployed and verified!");
  console.log("============================================================");
  console.log(`SX / BX Cloud Endpoint URL : ${workerUrl}`);
  console.log(`MCP Streamable HTTP URL    : ${workerUrl}/mcp`);
  console.log(`Bearer Token               : ${token}`);
  console.log(`Verified MCP Tools         : ${toolCount}`);
  console.log("\nRemote MCP JSON config:");
  console.log(
    JSON.stringify(
      {
        mcpServers: {
          "chaox-agent": {
            url: `${workerUrl}/mcp`,
            headers: {
              Authorization: `Bearer ${token}`
            }
          }
        }
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
