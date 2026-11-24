import { handleMcpRequest } from "./mcp.js";
import { ExchangeStore } from "./store.js";
import { Receipt, SCHEMA_VERSION, ServerEnv, SnapshotUploadBody } from "./types.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export type AuthRole = "full" | "sync" | "mcp" | "mcp_readonly";

export const MAX_MCP_BODY_BYTES = 2 * 1024 * 1024; // 2 MiB for /mcp and /preferences
export const MAX_SYNC_BODY_BYTES = 20 * 1024 * 1024; // 20 MiB default for /sync/* payloads

function resolveMaxSyncBodyBytes(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed) return MAX_SYNC_BODY_BYTES;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return MAX_SYNC_BODY_BYTES;
  }
  return parsed;
}

const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer"
};

const BASE_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Accept, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, Mcp-Protocol-Version"
};

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const TOKEN_DIGEST_CACHE = new Map<string, Uint8Array>();

export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const contentLengthRaw = request.headers.get("Content-Length")?.trim();
  if (contentLengthRaw) {
    const declared = Number(contentLengthRaw);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new HttpError(413, `Request body exceeds maximum size of ${maxBytes} bytes.`);
    }
  }

  let rawText: string;
  if (request.body) {
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new HttpError(413, `Request body exceeds maximum size of ${maxBytes} bytes.`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    rawText = TEXT_DECODER.decode(combined);
  } else {
    rawText = await request.text();
    if (TEXT_ENCODER.encode(rawText).byteLength > maxBytes) {
      throw new HttpError(413, `Request body exceeds maximum size of ${maxBytes} bytes.`);
    }
  }

  return JSON.parse(rawText);
}

async function readJsonObject(
  request: Request,
  maxBytes: number,
  errorMessage = "Expected a JSON object request body."
): Promise<Record<string, unknown>> {
  const parsed = await readJsonBody(request, maxBytes);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, errorMessage);
  }
  return parsed as Record<string, unknown>;
}

async function digestSha256(value: string): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(value));
  return new Uint8Array(buf);
}

async function getExpectedTokenDigest(expectedToken: string): Promise<Uint8Array> {
  const cached = TOKEN_DIGEST_CACHE.get(expectedToken);
  if (cached) return cached;
  const digest = await digestSha256(expectedToken);
  if (TOKEN_DIGEST_CACHE.size >= 32) {
    TOKEN_DIGEST_CACHE.clear();
  }
  TOKEN_DIGEST_CACHE.set(expectedToken, digest);
  return digest;
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const len = Math.min(a.length, b.length);
  for (let idx = 0; idx < len; idx += 1) {
    diff |= a[idx] ^ b[idx];
  }
  return diff === 0;
}

export function isInternalError(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  if (error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError) {
    return true;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && (code.startsWith("ERR_SQLITE") || code.startsWith("SQLITE"))) {
    return true;
  }
  if (/SQLITE_|D1_[A-Z_]+|database is locked|no such (?:table|column)/i.test(error.message)) {
    return true;
  }
  return false;
}

function buildCorsHeaders(
  requestOrigin: string | null,
  allowedOriginsRaw: string | undefined
): { headers: Record<string, string>; originDenied: boolean } {
  const trimmed = allowedOriginsRaw?.trim() ?? "";
  if (!trimmed || trimmed === "*") {
    return {
      headers: {
        ...BASE_CORS_HEADERS,
        "Access-Control-Allow-Origin": "*"
      },
      originDenied: false
    };
  }

  const allowlist = new Set(
    trimmed
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
  if (!requestOrigin) {
    return {
      headers: { ...BASE_CORS_HEADERS },
      originDenied: false
    };
  }
  if (allowlist.has(requestOrigin)) {
    return {
      headers: {
        ...BASE_CORS_HEADERS,
        "Access-Control-Allow-Origin": requestOrigin,
        Vary: "Origin"
      },
      originDenied: false
    };
  }
  return {
    headers: { ...BASE_CORS_HEADERS },
    originDenied: true
  };
}

function withResponseHeaders(response: Response, corsHeaders: Record<string, string>): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(key)) headers.set(key, value);
  }
  for (const [key, value] of Object.entries(corsHeaders)) {
    if (key.toLowerCase() === "vary") {
      const existingVary = headers.get("Vary");
      if (!existingVary) {
        headers.set("Vary", value);
      } else if (!new RegExp(`\\b${value}\\b`, "i").test(existingVary)) {
        headers.set("Vary", `${existingVary}, ${value}`);
      }
      continue;
    }
    if (!headers.has(key)) headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function jsonResponse(
  body: unknown,
  status = 200,
  corsHeaders: Record<string, string> = {}
): Response {
  return withResponseHeaders(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" }
    }),
    corsHeaders
  );
}

export async function authenticateRequest(headerValue: string | null, env: ServerEnv): Promise<AuthRole | null> {
  const rawCandidates: Array<{ role: AuthRole; token: string }> = [
    { role: "full", token: env.CHAOX_AUTH_TOKEN?.trim() ?? "" },
    { role: "sync", token: env.CHAOX_SYNC_TOKEN?.trim() ?? "" },
    { role: "mcp", token: env.CHAOX_MCP_TOKEN?.trim() ?? "" },
    { role: "mcp_readonly", token: env.CHAOX_MCP_READONLY_TOKEN?.trim() ?? "" }
  ];
  const candidates = rawCandidates.filter((entry) => entry.token.length > 0);

  if (candidates.length === 0) {
    return null;
  }
  if (!headerValue || !headerValue.startsWith("Bearer ")) {
    return null;
  }
  const actualRaw = headerValue.slice("Bearer ".length);
  if (!actualRaw) {
    return null;
  }

  const [actualDigest, expectedDigests] = await Promise.all([
    digestSha256(actualRaw),
    Promise.all(candidates.map((c) => getExpectedTokenDigest(c.token)))
  ]);

  let matchedRole: AuthRole | null = null;
  for (let idx = 0; idx < candidates.length; idx += 1) {
    if (timingSafeEqualBytes(actualDigest, expectedDigests[idx]) && matchedRole === null) {
      matchedRole = candidates[idx].role;
    }
  }
  return matchedRole;
}

export async function handleRequest(request: Request, env: ServerEnv): Promise<Response> {
  const cors = buildCorsHeaders(request.headers.get("Origin"), env.CHAOX_ALLOWED_ORIGINS);
  if (cors.originDenied) {
    return jsonResponse({ error: "Origin not allowed" }, 403, cors.headers);
  }

  if (request.method === "OPTIONS") {
    return withResponseHeaders(new Response(null, { status: 204 }), cors.headers);
  }

  const backendMode = env.BACKEND_MODE?.trim() || "sqlite";
  const serverName = env.SERVER_NAME?.trim() || "chaox-agent-server";

  const url = new URL(request.url);
  if (url.pathname === "/health" && (request.method === "GET" || request.method === "HEAD")) {
    if (request.method === "HEAD") {
      return withResponseHeaders(
        new Response(null, {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" }
        }),
        cors.headers
      );
    }
    return jsonResponse(
      {
        status: "ok",
        schemaVersion: SCHEMA_VERSION,
        mode: backendMode
      },
      200,
      cors.headers
    );
  }

  const authRole = await authenticateRequest(request.headers.get("Authorization"), env);
  if (!authRole) {
    return withResponseHeaders(
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "WWW-Authenticate": "Bearer"
        }
      }),
      cors.headers
    );
  }

  const rawAllowPrefsWrite = env.CHAOX_ALLOW_MCP_PREFERENCES_WRITE?.trim().toLowerCase() ?? "";
  const allowMcpPreferencesWrite = rawAllowPrefsWrite !== "0" && rawAllowPrefsWrite !== "false";
  const syncMaxBodyBytes = resolveMaxSyncBodyBytes(env.CHAOX_MAX_BODY_BYTES);
  const mcpMaxBodyBytes = Math.min(syncMaxBodyBytes, MAX_MCP_BODY_BYTES);

  const store = new ExchangeStore(env.DB, {
    backendMode,
    defaultClient: serverName
  });

  try {
    if (url.pathname === "/mcp") {
      if (authRole !== "full" && authRole !== "mcp" && authRole !== "mcp_readonly") {
        return jsonResponse({ error: "Forbidden: token scope does not permit /mcp." }, 403, cors.headers);
      }
      return withResponseHeaders(
        await handleMcpRequest(request, store, {
          forceReadOnly: authRole === "mcp_readonly",
          allowPreferencesWrite: allowMcpPreferencesWrite,
          maxBodyBytes: mcpMaxBodyBytes
        }),
        cors.headers
      );
    }

    if (url.pathname === "/preferences") {
      if (request.method === "GET") {
        return jsonResponse(await store.getPreferences(), 200, cors.headers);
      }
      if (request.method === "PUT") {
        if (authRole !== "full" && authRole !== "sync") {
          return jsonResponse(
            { error: "Forbidden: token scope does not permit modifying preferences directly." },
            403,
            cors.headers
          );
        }
        const body = await readJsonObject(
          request,
          mcpMaxBodyBytes,
          "Expected JSON object with 'content' string."
        );
        if (typeof body.content !== "string") {
          return jsonResponse({ error: "Expected JSON object with 'content' string." }, 400, cors.headers);
        }
        return jsonResponse(await store.setPreferences(body.content), 200, cors.headers);
      }
      return jsonResponse({ error: "Method not allowed" }, 405, cors.headers);
    }

    if (url.pathname.startsWith("/sync/") && authRole !== "full" && authRole !== "sync") {
      return jsonResponse({ error: "Forbidden: token scope does not permit /sync/* routes." }, 403, cors.headers);
    }

    if (url.pathname === "/sync/csteix/wuxu") {
      if (request.method === "GET") {
        const since = url.searchParams.get("since");
        const rawIncludeDeleted = url.searchParams.get("includeDeleted");
        const includeDeleted =
          rawIncludeDeleted === null
            ? true
            : rawIncludeDeleted !== "0" && rawIncludeDeleted.toLowerCase() !== "false";
        return jsonResponse(await store.csteix.getWuxuDelta({ since, includeDeleted }), 200, cors.headers);
      }
      return jsonResponse({ error: "Method not allowed" }, 405, cors.headers);
    }

    if (url.pathname === "/sync/csteix/wuxu/import") {
      if (request.method === "POST") {
        const body = await readJsonObject(
          request,
          syncMaxBodyBytes,
          "Expected JSON object with 'articles' array."
        );
        return jsonResponse(await store.csteix.importWuxuArticles(body.articles), 200, cors.headers);
      }
      return jsonResponse({ error: "Method not allowed" }, 405, cors.headers);
    }

    const syncMatch = /^\/sync\/([a-z]+)\/(status|inbox|ack|snapshot|data)$/.exec(url.pathname);
    if (syncMatch) {
      const app = ExchangeStore.parseAppId(syncMatch[1]);
      const action = syncMatch[2];

      if (action === "status" && request.method === "GET") {
        const rawLimit = Number(url.searchParams.get("limit") || "10");
        const limit = Number.isFinite(rawLimit) ? rawLimit : 10;
        const tokenMode: "split" | "legacy" =
          authRole === "sync" ||
          Boolean(env.CHAOX_MCP_TOKEN?.trim() || env.CHAOX_MCP_READONLY_TOKEN?.trim())
            ? "split"
            : "legacy";
        return jsonResponse(
          { ...(await store.getAppSyncStatus(app, limit)), tokenMode },
          200,
          cors.headers
        );
      }

      if (action === "inbox" && request.method === "GET") {
        return jsonResponse(await store.listAppInbox(app), 200, cors.headers);
      }

      if (action === "ack" && request.method === "POST") {
        const body = await readJsonObject(
          request,
          syncMaxBodyBytes,
          "Expected JSON object with 'receipts' array."
        );
        if (!Array.isArray(body.receipts)) {
          return jsonResponse({ error: "Expected JSON object with 'receipts' array." }, 400, cors.headers);
        }
        return jsonResponse(await store.ackAppReceipts(app, body.receipts as Receipt[]), 200, cors.headers);
      }

      if (action === "snapshot" && request.method === "PUT") {
        const body = (await readJsonObject(request, syncMaxBodyBytes)) as unknown as SnapshotUploadBody;
        return jsonResponse(await store.putAppSnapshot(app, body), 200, cors.headers);
      }

      if (action === "data" && request.method === "DELETE") {
        return jsonResponse(await store.wipeAppData(app), 200, cors.headers);
      }

      return jsonResponse({ error: "Method not allowed" }, 405, cors.headers);
    }

    const datasetMatch = /^\/sync\/([a-z]+)\/dataset\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
    if (datasetMatch) {
      const app = ExchangeStore.parseAppId(datasetMatch[1]);
      if (request.method !== "PUT") {
        return jsonResponse({ error: "Method not allowed" }, 405, cors.headers);
      }
      const domain = datasetMatch[2];
      const body = await readJsonObject(request, syncMaxBodyBytes);
      return jsonResponse(await store.putAppDatasetDomain(app, domain, body.data ?? null), 200, cors.headers);
    }

    return jsonResponse({ error: "Not found" }, 404, cors.headers);
  } catch (error) {
    const status =
      error instanceof HttpError
        ? error.status
        : error instanceof SyntaxError
          ? 400
          : isInternalError(error)
            ? 500
            : 400;
    if (status >= 500) {
      console.error("[chaox-agent] Internal error:", error);
      return jsonResponse({ error: "Internal server error" }, status, cors.headers);
    }
    return jsonResponse(
      { error: error instanceof Error ? error.message : String(error) },
      status,
      cors.headers
    );
  }
}

export const handleWorkerRequest = handleRequest;
