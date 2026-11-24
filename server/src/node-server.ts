import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { AuthRole, authenticateRequest, handleRequest } from "./app.js";
import { SqliteDatabase } from "./sqlite.js";
import { ServerEnv } from "./types.js";

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_MAX_BODY_BYTES = 20 * 1024 * 1024; // 20 MiB for /sync/* payloads
const DEFAULT_MCP_MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MiB for /mcp and /preferences
const MIN_RECOMMENDED_TOKEN_LENGTH = 24;
const DEFAULT_AUTH_RATE_LIMIT_MAX = 20;
const DEFAULT_AUTH_RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_RATE_LIMIT_BUCKETS = 2048;
const GZIP_MIN_BYTES = 1024;

const PLACEHOLDER_TOKEN_PREFIX_PATTERN =
  /^(?:replace[-_]?with|change[-_]?me|your[-_]?[a-z0-9_-]*token|example[-_]?[a-z0-9_-]*token|placeholder)/i;
const PLACEHOLDER_TOKEN_LITERALS = new Set([
  "changeme",
  "change-me",
  "change_me",
  "secret",
  "token",
  "password",
  "default",
  "example",
  "replace-me",
  "replace_me",
  "replaceme",
  "todo",
  "xxx"
]);

export function isPlaceholderToken(token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed) return false;
  if (PLACEHOLDER_TOKEN_LITERALS.has(trimmed.toLowerCase())) {
    return true;
  }
  return PLACEHOLDER_TOKEN_PREFIX_PATTERN.test(trimmed);
}

function roleMaySendBody(pathname: string, method: string, role: AuthRole): boolean {
  if (pathname === "/mcp") {
    return method === "POST" && (role === "full" || role === "mcp" || role === "mcp_readonly");
  }
  if (pathname === "/preferences") {
    return method === "PUT" && (role === "full" || role === "sync");
  }
  if (pathname.startsWith("/sync/")) {
    return (method === "POST" || method === "PUT") && (role === "full" || role === "sync");
  }
  return false;
}

function requestMayHaveBody(req: http.IncomingMessage): boolean {
  const contentLengthRaw = firstHeaderValue(req.headers["content-length"]);
  if (contentLengthRaw !== undefined) {
    const parsed = Number(contentLengthRaw);
    if (!Number.isFinite(parsed) || parsed > 0) {
      return true;
    }
  }
  return req.headers["transfer-encoding"] !== undefined;
}

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
  syncToken?: string;
  mcpToken?: string;
  mcpReadOnlyToken?: string;
  allowedOrigins?: string;
  allowMcpPreferencesWrite?: boolean;
  trustProxy?: boolean;
  authRateLimit?: { maxAttempts: number; windowMs: number } | false;
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
  requestMethod: string,
  acceptEncoding?: string
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

  const rawBytes = Buffer.from(await webResponse.arrayBuffer());
  const acceptsGzip = Boolean(acceptEncoding && /\bgzip\b/i.test(acceptEncoding));
  const alreadyEncoded = webResponse.headers.has("content-encoding");
  if (acceptsGzip && !alreadyEncoded && rawBytes.length >= GZIP_MIN_BYTES) {
    const compressed = gzipSync(rawBytes);
    const existingVary = webResponse.headers.get("vary");
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader(
      "Vary",
      existingVary && !/\baccept-encoding\b/i.test(existingVary)
        ? `${existingVary}, Accept-Encoding`
        : existingVary || "Accept-Encoding"
    );
    res.setHeader("Content-Length", compressed.length);
    res.end(compressed);
    return;
  }

  res.end(rawBytes);
}

function resolveClientIp(req: http.IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = firstHeaderValue(req.headers["x-forwarded-for"]);
    if (forwarded) return forwarded;
  }
  return req.socket?.remoteAddress || "unknown";
}

function buildRequestUrl(
  rawUrl: string,
  req: http.IncomingMessage,
  trustProxy: boolean,
  fallbackPort: number
): URL {
  const protoRaw = trustProxy
    ? firstHeaderValue(req.headers["x-forwarded-proto"])?.toLowerCase()
    : undefined;
  const proto = protoRaw === "https" || protoRaw === "http" ? protoRaw : "http";
  const candidateHost =
    (trustProxy ? firstHeaderValue(req.headers["x-forwarded-host"]) : undefined) ||
    firstHeaderValue(req.headers.host) ||
    `127.0.0.1:${fallbackPort}`;
  try {
    return new URL(rawUrl, `${proto}://${candidateHost}`);
  } catch {
    try {
      return new URL(rawUrl, `http://127.0.0.1:${fallbackPort}`);
    } catch {
      return new URL("/", `http://127.0.0.1:${fallbackPort}`);
    }
  }
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
  const syncToken = options.syncToken ?? process.env.CHAOX_SYNC_TOKEN?.trim() ?? "";
  const mcpToken = options.mcpToken ?? process.env.CHAOX_MCP_TOKEN?.trim() ?? "";
  const mcpReadOnlyToken =
    options.mcpReadOnlyToken ?? process.env.CHAOX_MCP_READONLY_TOKEN?.trim() ?? "";
  const allowedOrigins =
    options.allowedOrigins ?? process.env.CHAOX_ALLOWED_ORIGINS?.trim() ?? undefined;
  const allowMcpPreferencesWriteEnv =
    options.allowMcpPreferencesWrite !== undefined
      ? options.allowMcpPreferencesWrite
        ? "true"
        : "false"
      : process.env.CHAOX_ALLOW_MCP_PREFERENCES_WRITE?.trim();
  const rawTrustProxy = process.env.CHAOX_TRUST_PROXY?.trim().toLowerCase() ?? "";
  const trustProxy =
    options.trustProxy ?? (rawTrustProxy === "1" || rawTrustProxy === "true");
  const backendMode = options.backendMode ?? process.env.CHAOX_BACKEND_MODE?.trim() ?? "sqlite";
  const serverName =
    options.serverName ?? process.env.CHAOX_SERVER_NAME?.trim() ?? "chaox-agent-server";
  const maxBodyBytes = options.maxBodyBytes ?? parseMaxBodyBytes(process.env.CHAOX_MAX_BODY_BYTES);
  const rateLimitConfig =
    options.authRateLimit === false
      ? null
      : (options.authRateLimit ?? {
          maxAttempts: DEFAULT_AUTH_RATE_LIMIT_MAX,
          windowMs: DEFAULT_AUTH_RATE_LIMIT_WINDOW_MS
        });

  const configuredTokens: Array<[string, string]> = (
    [
      ["CHAOX_AUTH_TOKEN", authToken],
      ["CHAOX_SYNC_TOKEN", syncToken],
      ["CHAOX_MCP_TOKEN", mcpToken],
      ["CHAOX_MCP_READONLY_TOKEN", mcpReadOnlyToken]
    ] as Array<[string, string]>
  ).filter(([, val]) => val.length > 0);

  for (const [envName, val] of configuredTokens) {
    if (isPlaceholderToken(val)) {
      throw new Error(
        `Refusing to start: ${envName} appears to be a weak or placeholder token. Generate a strong random token with 'npm run token' or 'openssl rand -hex 32'.`
      );
    }
  }

  const db = new SqliteDatabase(dbPath, { migrationsDir: options.migrationsDir });

  if (!options.quiet) {
    if (configuredTokens.length === 0) {
      console.warn(
        "[chaox-agent-server] WARNING: No auth token is configured (CHAOX_AUTH_TOKEN or CHAOX_SYNC_TOKEN/CHAOX_MCP_TOKEN). Protected routes (/mcp, /sync/*, /preferences) will return 401 until configured."
      );
    } else {
      for (const [envName, val] of configuredTokens) {
        if (val.length < MIN_RECOMMENDED_TOKEN_LENGTH) {
          console.warn(
            `[chaox-agent-server] WARNING: ${envName} is shorter than ${MIN_RECOMMENDED_TOKEN_LENGTH} characters. Generate a stronger random token with 'npm run token' or 'openssl rand -hex 32'.`
          );
        }
      }
    }
  }

  let boundPort = port;
  const failedAuthByIp = new Map<string, number[]>();

  const pruneWindow = (ip: string, now: number, windowMs: number): number[] => {
    const cutoff = now - windowMs;
    const recent = (failedAuthByIp.get(ip) ?? []).filter((ts) => ts >= cutoff);
    if (recent.length === 0) {
      failedAuthByIp.delete(ip);
    } else {
      failedAuthByIp.set(ip, recent);
    }
    return recent;
  };

  const server = http.createServer(async (req, res) => {
    const method = (req.method || "GET").toUpperCase();

    try {
      const rawUrl = req.url || "/";
      const requestUrl = buildRequestUrl(rawUrl, req, trustProxy, boundPort);
      const clientIp = resolveClientIp(req, trustProxy);
      const bypassRateLimit = method === "OPTIONS" || requestUrl.pathname === "/health";

      if (rateLimitConfig && !bypassRateLimit) {
        const now = Date.now();
        const recentFailures = pruneWindow(clientIp, now, rateLimitConfig.windowMs);
        if (recentFailures.length >= rateLimitConfig.maxAttempts) {
          const oldest = recentFailures[0] ?? now;
          const retryAfterSeconds = Math.max(
            1,
            Math.ceil((oldest + rateLimitConfig.windowMs - now) / 1000)
          );
          res.statusCode = 429;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("X-Content-Type-Options", "nosniff");
          res.setHeader("Retry-After", String(retryAfterSeconds));
          res.end(
            JSON.stringify({
              error: "Too many failed authentication attempts. Please retry later."
            })
          );
          return;
        }
      }

      const env: ServerEnv = {
        DB: db,
        CHAOX_AUTH_TOKEN: authToken || undefined,
        CHAOX_SYNC_TOKEN: syncToken || undefined,
        CHAOX_MCP_TOKEN: mcpToken || undefined,
        CHAOX_MCP_READONLY_TOKEN: mcpReadOnlyToken || undefined,
        CHAOX_ALLOWED_ORIGINS: allowedOrigins,
        CHAOX_ALLOW_MCP_PREFERENCES_WRITE: allowMcpPreferencesWriteEnv,
        CHAOX_MAX_BODY_BYTES: String(maxBodyBytes),
        BACKEND_MODE: backendMode,
        SERVER_NAME: serverName
      };

      const headers = buildRequestHeaders(req.headers);

      const routeMaxBodyBytes =
        requestUrl.pathname === "/mcp" || requestUrl.pathname === "/preferences"
          ? Math.min(maxBodyBytes, DEFAULT_MCP_MAX_BODY_BYTES)
          : maxBodyBytes;

      let body: ArrayBuffer | undefined;
      let skippedUnreadBody = false;
      if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
        const authRole =
          requestUrl.pathname === "/health"
            ? null
            : await authenticateRequest(headers.get("Authorization"), env);
        if (authRole !== null && roleMaySendBody(requestUrl.pathname, method, authRole)) {
          const buffer = await readRequestBody(req, routeMaxBodyBytes);
          if (buffer.length > 0) {
            body = buffer.buffer.slice(
              buffer.byteOffset,
              buffer.byteOffset + buffer.byteLength
            ) as ArrayBuffer;
          }
        } else if (requestMayHaveBody(req)) {
          skippedUnreadBody = true;
        }
      }

      const webReq = new Request(requestUrl, {
        method,
        headers,
        body
      });

      const webRes = await handleRequest(webReq, env);

      if (rateLimitConfig && !bypassRateLimit) {
        const now = Date.now();
        if (webRes.status === 401) {
          if (!failedAuthByIp.has(clientIp) && failedAuthByIp.size >= MAX_RATE_LIMIT_BUCKETS) {
            for (const [trackedIp] of failedAuthByIp) {
              pruneWindow(trackedIp, now, rateLimitConfig.windowMs);
            }
            if (failedAuthByIp.size >= MAX_RATE_LIMIT_BUCKETS) {
              failedAuthByIp.clear();
            }
          }
          const recent = pruneWindow(clientIp, now, rateLimitConfig.windowMs);
          recent.push(now);
          failedAuthByIp.set(clientIp, recent);
        } else if (webRes.status < 400) {
          failedAuthByIp.delete(clientIp);
        }
      }

      if (skippedUnreadBody) {
        res.setHeader("Connection", "close");
      }
      const acceptEncoding = firstHeaderValue(req.headers["accept-encoding"]);
      await writeWebResponse(res, webRes, method, acceptEncoding);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        if (!res.headersSent) {
          res.statusCode = 413;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("X-Content-Type-Options", "nosniff");
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
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.end(JSON.stringify({ error: "Internal server error" }));
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 30_000;

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
