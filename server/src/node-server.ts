import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { handleRequest } from "./app.js";
import { SqliteDatabase } from "./sqlite.js";

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_MAX_BODY_BYTES = 20 * 1024 * 1024; // 20 MiB

class PayloadTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Request body exceeds CHAOX_MAX_BODY_BYTES limit (${maxBytes} bytes).`);
    this.name = "PayloadTooLargeError";
  }
}

export interface NodeServerOptions {
  host?: string;
  port?: number;
  dbPath?: string;
  migrationsDir?: string | null;
  authToken?: string;
  backendMode?: string;
  serverName?: string;
  maxBodyBytes?: number;
  quiet?: boolean;
}

export interface RunningNodeServer {
  server: http.Server;
  db: SqliteDatabase;
  host: string;
  port: number;
  baseUrl: string;
  close: () => Promise<void>;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid PORT '${raw}'. Expected integer 0..65535.`);
  }
  return parsed;
}

function parseMaxBodyBytes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_BODY_BYTES;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid CHAOX_MAX_BODY_BYTES '${raw}'. Expected positive integer.`);
  }
  return parsed;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") {
    const first = value.split(",")[0]?.trim();
    return first || undefined;
  }
  if (Array.isArray(value) && value.length > 0) {
    return firstHeaderValue(value[0]);
  }
  return undefined;
}

function buildRequestHeaders(rawHeaders: http.IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}

function readRequestBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const contentLengthRaw = firstHeaderValue(req.headers["content-length"]);
    if (contentLengthRaw !== undefined) {
      const declared = Number(contentLengthRaw);
      if (Number.isFinite(declared) && declared > maxBytes) {
        req.resume();
        reject(new PayloadTooLargeError(maxBytes));
        return;
      }
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        settled = true;
        req.destroy();
        reject(new PayloadTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks));
    });

    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

async function writeWebResponse(
  res: http.ServerResponse,
  webResponse: Response,
  requestMethod: string
): Promise<void> {
  res.statusCode = webResponse.status;
  if (webResponse.statusText) {
    res.statusMessage = webResponse.statusText;
  }

  const headersWithCookies = webResponse.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = headersWithCookies.getSetCookie?.() ?? [];
  webResponse.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    res.setHeader(key, value);
  });
  if (setCookies.length > 0) {
    res.setHeader("set-cookie", setCookies);
  }

  if (requestMethod === "HEAD" || webResponse.status === 204 || webResponse.status === 304) {
    res.end();
    return;
  }

  const bodyBytes = Buffer.from(await webResponse.arrayBuffer());
  res.end(bodyBytes);
}

export async function startNodeServer(
  options: NodeServerOptions = {}
): Promise<RunningNodeServer> {
  const host = options.host ?? process.env.HOST?.trim() ?? DEFAULT_HOST;
  const port = options.port ?? parsePort(process.env.PORT);
  const dbPath =
    options.dbPath ??
    process.env.CHAOX_DB_PATH?.trim() ??
    path.resolve(process.cwd(), "data/chaox-agent.sqlite");
  const authToken = options.authToken ?? process.env.CHAOX_AUTH_TOKEN?.trim() ?? "";
  const backendMode = options.backendMode ?? process.env.CHAOX_BACKEND_MODE?.trim() ?? "sqlite";
  const serverName =
    options.serverName ?? process.env.CHAOX_SERVER_NAME?.trim() ?? "chaox-agent-server";
  const maxBodyBytes = options.maxBodyBytes ?? parseMaxBodyBytes(process.env.CHAOX_MAX_BODY_BYTES);

  const db = new SqliteDatabase(dbPath, { migrationsDir: options.migrationsDir });

  if (!authToken && !options.quiet) {
    console.warn(
      "[chaox-agent-server] WARNING: CHAOX_AUTH_TOKEN is not set. Protected routes (/mcp, /sync/*, /preferences) will return 401 until configured."
    );
  }

  let boundPort = port;

  const server = http.createServer(async (req, res) => {
    const method = (req.method || "GET").toUpperCase();
    try {
      const proto = firstHeaderValue(req.headers["x-forwarded-proto"]) || "http";
      const headerHost =
        firstHeaderValue(req.headers["x-forwarded-host"]) ||
        firstHeaderValue(req.headers.host) ||
        `127.0.0.1:${boundPort}`;
      const rawUrl = req.url || "/";
      const requestUrl = new URL(rawUrl, `${proto}://${headerHost}`);

      let body: ArrayBuffer | undefined;
      if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
        const buffer = await readRequestBody(req, maxBodyBytes);
        if (buffer.length > 0) {
          body = buffer.buffer.slice(
            buffer.byteOffset,
            buffer.byteOffset + buffer.byteLength
          ) as ArrayBuffer;
        }
      }

      const webReq = new Request(requestUrl, {
        method,
        headers: buildRequestHeaders(req.headers),
        body
      });

      const webRes = await handleRequest(webReq, {
        DB: db,
        CHAOX_AUTH_TOKEN: authToken,
        BACKEND_MODE: backendMode,
        SERVER_NAME: serverName
      });

      await writeWebResponse(res, webRes, method);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        if (!res.headersSent) {
          res.statusCode = 413;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: error.message }));
        }
        return;
      }

      if (!options.quiet) {
        console.error("[chaox-agent-server] Unhandled request error:", error);
      }
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : "Internal server error"
          })
        );
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    db.close();
    throw error;
  }

  const address = server.address();
  if (address && typeof address === "object") {
    boundPort = address.port;
  }
  const printableHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const baseUrl = `http://${printableHost}:${boundPort}`;

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    db.close();
  };

  return { server, db, host, port: boundPort, baseUrl, close };
}

async function runCli(): Promise<void> {
  const running = await startNodeServer();
  console.log(
    `[chaox-agent-server] Listening on http://${running.host}:${running.port} (SQLite: ${running.db.dbPath})`
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[chaox-agent-server] Received ${signal}, shutting down cleanly...`);
    await running.close();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

const isEntrypoint =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntrypoint) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
