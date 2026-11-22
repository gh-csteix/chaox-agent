#!/usr/bin/env node
import http, { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ChaoxExchangeClient, SCHEMA_VERSION, defaultExchangeDir } from "./exchange.js";
import { createChaoxMcpServer } from "./server.js";

export interface CliOptions {
  dir: string;
  http: boolean;
  host: string;
  port: number;
  token?: string;
}

export function parseCliArgs(argv: string[]): CliOptions {
  let dir = defaultExchangeDir();
  let useHttp = false;
  let host = process.env.CHAOX_MCP_HOST || "127.0.0.1";
  let port = Number(process.env.CHAOX_MCP_PORT || process.env.PORT || "3847");
  let token = process.env.CHAOX_MCP_TOKEN?.trim() || undefined;

  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    if (arg === "--dir" && idx + 1 < argv.length) {
      dir = argv[++idx];
    } else if (arg === "--http") {
      useHttp = true;
    } else if (arg === "--host" && idx + 1 < argv.length) {
      host = argv[++idx];
    } else if (arg === "--port" && idx + 1 < argv.length) {
      port = Number(argv[++idx]);
    } else if (arg === "--token" && idx + 1 < argv.length) {
      token = argv[++idx].trim() || undefined;
    }
  }

  return { dir, http: useHttp, host, port, token };
}

function timingSafeBearerMatch(headerValue: string | undefined, expectedToken: string): boolean {
  if (!headerValue || !headerValue.startsWith("Bearer ")) {
    return false;
  }
  const actual = Buffer.from(headerValue.slice("Bearer ".length));
  const expected = Buffer.from(expectedToken);
  if (actual.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(actual, expected);
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function startHttpServer(options: CliOptions): Promise<{
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}> {
  if (!isLoopbackHost(options.host) && !options.token) {
    throw new Error(
      `Refusing to bind non-loopback host '${options.host}' without --token / CHAOX_MCP_TOKEN.`
    );
  }

  const client = new ChaoxExchangeClient(options.dir);

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const urlPath = (req.url || "/").split("?")[0];

    if (urlPath === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          schemaVersion: SCHEMA_VERSION,
          exchangeDir: client.rootDir
        })
      );
      return;
    }

    if (urlPath !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    if (options.token && !timingSafeBearerMatch(req.headers.authorization, options.token)) {
      res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": "Bearer"
      });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    const mcpServer = createChaoxMcpServer(client);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });

    res.on("close", () => {
      void transport.close();
      void mcpServer.close();
    });

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error)
          })
        );
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      const address = server.address();
      const boundPort = typeof address === "object" && address ? address.port : options.port;
      resolve({
        server,
        port: boundPort,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((err) => (err ? closeReject(err) : closeResolve()));
          })
      });
    });
  });
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.http) {
    const started = await startHttpServer(options);
    console.error(
      `chaox-agent-mcp HTTP listening on http://${options.host}:${started.port}/mcp (dir=${options.dir})`
    );
    return;
  }

  const client = new ChaoxExchangeClient(options.dir);
  const mcpServer = createChaoxMcpServer(client);
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}

const isMain = process.argv[1]?.endsWith("cli.js") || process.argv[1]?.endsWith("cli.ts");
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
